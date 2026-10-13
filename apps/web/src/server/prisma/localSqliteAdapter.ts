import { PrismaLibSql } from "@prisma/adapter-libsql";
import { LibsqlError, type Client, type Config, type TransactionMode } from "@libsql/client";
import { createOwnedSqliteClient } from "./ownedSqliteClient";

function busyBeforeBegin(error: unknown) {
  const value = error as { code?: unknown; rawCode?: unknown } | null;
  const raw = typeof value?.rawCode === "number" ? value.rawCode :
    typeof value?.rawCode === "string" && /^\d{1,10}$/.test(value.rawCode) ? Number(value.rawCode) : NaN;
  return ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(String(value?.code)) &&
    Number.isSafeInteger(raw) && raw >= 0 && raw % 256 === 5;
}

/** Coordinate the web app and worker on a durable local SQLite file. */
export class LocalSqliteAdapter extends PrismaLibSql {
  override createClient(config: Config): Client {
    if (config.url !== ":memory:" && !config.url.startsWith("file:")) return super.createClient(config);
    // WHATWG URL adds a leading slash to file::memory:, unlike libSQL's URI
    // parser. Preserve its path semantics and decode supported memory URLs.
    const uriPath = config.url === ":memory:" ? ":memory:" : config.url.slice(config.url.indexOf(":") + 1).split(/[?#]/, 1)[0];
    const path = uriPath.startsWith("//") ? uriPath.replace(/^\/\/[^/]*/, "") : uriPath;
    const decodedPath = decodeURIComponent(path);
    if (decodedPath === ":memory:" || decodedPath.startsWith(":memory:?")) return super.createClient(config);
    if (!decodedPath || /[?#]/.test(config.url))
      throw new LibsqlError("A persistent SQLite file requires a path without URL parameters or fragments.", "URL_INVALID");
    if (uriPath.startsWith("//")) {
      const url = new URL(config.url);
      if ((url.hostname && url.hostname !== "localhost") || url.port || url.username || url.password)
        throw new LibsqlError("A local SQLite file requires an empty or localhost authority.", "URL_INVALID");
    }
    const client = createOwnedSqliteClient(config, decodedPath);

    let observations = 0;
    const observe = (stage: string, operation: string, error: unknown, attempt?: number) => {
      if (process.env.LOCAL_SQLITE_DIAGNOSTICS !== "true" || observations++ >= 100) return;
      const value = error as { code?: unknown; rawCode?: unknown } | null;
      const known = ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", "SQLITE_ERROR", "SQLITE_IOERR", "SQLITE_MISUSE", "SQLITE_READONLY", "CLIENT_CLOSED", "TRANSACTION_CLOSED"];
      const code = typeof value?.code === "string" && known.includes(value.code) ? value.code : "UNCLASSIFIED";
      const raw = typeof value?.rawCode === "number" ? value.rawCode :
        typeof value?.rawCode === "string" && /^\d{1,5}$/.test(value.rawCode) ? Number(value.rawCode) : undefined;
      const role = ["web", "worker", "fixture"].includes(process.env.LOCAL_SQLITE_ROLE ?? "") ? process.env.LOCAL_SQLITE_ROLE : "unknown";
      console.error(JSON.stringify({ event: "LOCAL_SQLITE_ERROR", role, stage, operation, code,
        sqliteCode: Number.isSafeInteger(raw) && raw! >= 0 && raw! <= 65535 ? raw : undefined, attempt }));
    };
    let failed = false, initializationError: unknown;
    const ready = client.execute("PRAGMA busy_timeout=100")
      .then(() => undefined).catch(error => {
        observe("initialize", "execute", error); failed = true; initializationError = error; client.close();
      });
    const prepare = async (operation: string) => {
      await ready;
      if (failed) throw initializationError;
      // libSQL transfers this physical connection to a transaction and opens
      // another on next use. The timeout must be configured on each one.
      try { await client.execute("PRAGMA busy_timeout=100"); }
      catch (error) { observe("prepare", operation, error); throw error; }
    };
    const operations = new Set(["execute", "batch", "migrate", "executeMultiple", "sync"]);
    return new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "transaction") return async (mode?: TransactionMode) => {
          for (let attempt = 0; ; attempt++) {
            await prepare("transaction");
            try {
              // Acquire write intent before Prisma can run any callback or
              // fence SELECT. Never retry a callback or statement.
              const transaction = await target.transaction(mode === "deferred" ? "write" : mode);
              return new Proxy(transaction, { get(tx, method) {
                const fn = Reflect.get(tx, method, tx);
                if (typeof fn !== "function") return fn;
                if (["execute", "batch", "executeMultiple", "commit", "rollback"].includes(String(method))) return async (...args: unknown[]) => {
                  for (let attempt = 0; ; attempt++) {
                    try { return await Reflect.apply(fn, tx, args); }
                    catch (error) {
                      const busy = error as { code?: unknown; rawCode?: unknown } | null;
                      // SQLite explicitly leaves a COMMIT rejected with BUSY
                      // active and uncommitted. Yield to the blocking reader,
                      // then retry only that COMMIT on the same transaction.
                      // Never replay its statements, callback or provider RPCs.
                      if (method === "commit" && busy?.code === "SQLITE_BUSY" &&
                        (busy.rawCode === 5 || busy.rawCode === "5") && tx.closed === false && attempt < 3) {
                        observe("transaction", "commit", error, attempt + 1);
                        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
                        continue;
                      }
                      // Prisma releases its parent mutex even if COMMIT fails.
                      // Native SQLite can retain that rejected transaction and
                      // its locks: close rolls it back, never replays the commit.
                      // Preserve the original failure, including uncertain ones.
                      if (method === "commit" || method === "rollback") {
                        try { tx.close(); }
                        catch (cleanupError) { observe("cleanup", String(method), cleanupError); }
                      }
                      observe("transaction", String(method), error); throw error;
                    }
                  }
                };
                return fn.bind(tx);
              } });
            } catch (error) {
              observe("begin", "transaction", error, attempt + 1);
              if (!busyBeforeBegin(error)) throw error;
              // A rejected native BEGIN can leave a prepared statement on
              // its connection. No transaction was returned: discard that
              // connection before another BEGIN, including after exhaustion.
              await target.reconnect();
              if (attempt >= 3) throw error;
              await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
            }
          }
        };
        if (operations.has(String(key))) return async (...args: unknown[]) => {
          await prepare(String(key));
          try { return await Reflect.apply(value, target, args); }
          catch (error) { observe("operation", String(key), error); throw error; }
        };
        if (key === "reconnect") return async (...args: unknown[]) => {
          await ready;
          if (failed) throw initializationError;
          await Reflect.apply(value, target, args);
          await client.execute("PRAGMA busy_timeout=100");
        };
        return value.bind(target);
      },
    });
  }
}
