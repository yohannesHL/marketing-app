import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Client, Config, TransactionMode } from "@libsql/client";

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
    const client = super.createClient(config);
    if (client.protocol !== "file") return client;
    // WHATWG URL adds a leading slash to file::memory:, unlike libSQL's URI
    // parser. Preserve its path semantics and decode supported memory URLs.
    const uriPath = config.url === ":memory:" ? ":memory:" : config.url.slice(config.url.indexOf(":") + 1).split(/[?#]/, 1)[0];
    const path = uriPath.startsWith("//") ? uriPath.replace(/^\/\/[^/]*/, "") : uriPath;
    const decodedPath = decodeURIComponent(path);
    if (decodedPath === ":memory:" || decodedPath.startsWith(":memory:?")) return client;

    let failed = false, initializationError: unknown;
    const ready = client.execute("PRAGMA busy_timeout=100")
      .then(() => undefined).catch(error => {
        failed = true; initializationError = error; client.close();
      });
    const prepare = async () => {
      await ready;
      if (failed) throw initializationError;
      // libSQL transfers this physical connection to a transaction and opens
      // another on next use. The timeout must be configured on each one.
      await client.execute("PRAGMA busy_timeout=100");
    };
    const operations = new Set(["execute", "batch", "migrate", "executeMultiple", "sync"]);
    return new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "transaction") return async (mode?: TransactionMode) => {
          for (let attempt = 0; ; attempt++) {
            await prepare();
            try {
              // Acquire write intent before Prisma can run any callback or
              // fence SELECT. Never retry a callback, statement or commit.
              return await target.transaction(mode === "deferred" ? "write" : mode);
            } catch (error) {
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
          await prepare(); return Reflect.apply(value, target, args);
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
