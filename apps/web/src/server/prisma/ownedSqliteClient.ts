import { createRequire } from "node:module";
import { LibsqlError } from "@libsql/client";
import type { Client, Config, InArgs, InStatement, InValue, IntMode, ResultSet, Row, Transaction, TransactionMode, Value } from "@libsql/client";

// The application still uses Node 20 type declarations. These are the public
// node:sqlite APIs available in the required Node 24 runtime, not driver internals.
type NativeValue = null | number | bigint | string | Uint8Array;
interface NativeStatement {
  columns(): { name: string; type: string | null }[];
  setReturnArrays(enabled: boolean): void;
  setReadBigInts(enabled: boolean): void;
  all(...args: (NativeValue | Record<string, NativeValue>)[]): NativeValue[][];
  run(...args: (NativeValue | Record<string, NativeValue>)[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface NativeDatabase {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options: { timeout: number }) => NativeDatabase;
};

const codes = ["SQLITE_OK", "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_NOTFOUND", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA", "SQLITE_TOOBIG", "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH", "SQLITE_FORMAT", "SQLITE_RANGE", "SQLITE_NOTADB", "SQLITE_NOTICE", "SQLITE_WARNING"];

function sqliteError(error: unknown): unknown {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (value?.code !== "ERR_SQLITE_ERROR" || typeof value.errcode !== "number" || !Number.isSafeInteger(value.errcode)) return error;
  const raw = value.errcode;
  const code = codes[raw & 255] ?? "SQLITE_UNKNOWN";
  // Keep SQLite's message for Prisma's constraint/table conversion, but never
  // log it here. Diagnostics above this client expose only fixed codes.
  return Object.assign(new LibsqlError(typeof value.message === "string" ? value.message : "SQLite operation failed", code, raw), { extendedCode: code });
}

function io<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw sqliteError(error); }
}

function input(value: InValue, intMode: IntMode): NativeValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Only finite numbers can be passed to SQLite");
    return value;
  }
  if (typeof value === "bigint") {
    if (value < -9223372036854775808n || value > 9223372036854775807n) throw new RangeError("SQLite integer exceeds 64 bits");
    return value;
  }
  if (typeof value === "boolean") return intMode === "string" ? (value ? "1" : "0") : intMode === "bigint" ? (value ? 1n : 0n) : (value ? 1 : 0);
  if (value instanceof Date) return input(value.valueOf(), intMode);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array || value === null || typeof value === "string") return value;
  throw new TypeError("Unsupported SQLite argument");
}

function output(value: NativeValue, intMode: IntMode): Value {
  if (typeof value === "bigint") {
    if (intMode === "bigint") return value;
    if (intMode === "string") return value.toString();
    if (value < -9007199254740991n || value > 9007199254740991n) throw new RangeError("SQLite integer cannot be represented safely as a number");
    return Number(value);
  }
  if (value instanceof Uint8Array) return Uint8Array.from(value).buffer;
  return value;
}

function row(values: NativeValue[], columns: string[], intMode: IntMode): Row {
  const result = {} as Row;
  Object.defineProperty(result, "length", { value: values.length });
  values.forEach((value, index) => {
    const converted = output(value, intMode);
    Object.defineProperty(result, index, { value: converted });
    if (!Object.hasOwn(result, columns[index])) Object.defineProperty(result, columns[index], { value: converted, enumerable: true, configurable: true, writable: true });
  });
  return result;
}

function results(columns: string[], columnTypes: string[], rows: Row[], rowsAffected: number, lastInsertRowid?: bigint): ResultSet {
  return { columns, columnTypes, rows, rowsAffected, lastInsertRowid,
    toJSON: () => ({ columns, columnTypes, rows: rows.map(item => Array.from({ length: item.length }, (_, index) => {
      const value = item[index];
      return typeof value === "bigint" ? value.toString() : value instanceof ArrayBuffer ? Buffer.from(value).toString("base64") : value;
    })), rowsAffected, lastInsertRowid: lastInsertRowid?.toString() ?? null }),
  };
}

function execute(db: NativeDatabase, statement: InStatement, intMode: IntMode): ResultSet {
  const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement;
  const args: (NativeValue | Record<string, NativeValue>)[] = Array.isArray(normalized.args)
    ? normalized.args.map(value => input(value, intMode))
    : normalized.args ? [Object.fromEntries(Object.entries(normalized.args).map(([key, value]) => [key, input(value, intMode)]))] : [];
  return io(() => {
    const stmt = db.prepare(normalized.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns();
    if (columns.length) {
      const names = columns.map(column => column.name);
      return results(names, columns.map(column => column.type ?? ""), stmt.all(...args).map(values => row(values, names, intMode)), 0);
    }
    // sqlite3_changes() alone retains the preceding DML count for DDL. Match
    // libSQL's total-change check so a schema/PRAGMA statement reports zero.
    const counter = db.prepare("SELECT total_changes()");
    counter.setReturnArrays(true);
    counter.setReadBigInts(true);
    const before = counter.all()[0][0];
    const info = stmt.run(...args);
    const changes = before === counter.all()[0][0] ? 0 : Number(info.changes);
    if (!Number.isSafeInteger(changes)) throw new RangeError("SQLite affected-row count exceeds safe integers");
    return results([], [], [], changes, BigInt(info.lastInsertRowid));
  });
}

function batchError(error: unknown, index: number): unknown {
  return error instanceof LibsqlError ? Object.assign(new LibsqlError(error.message, error.code, error.rawCode), { statementIndex: index }) : error;
}

class OwnedTransaction implements Transaction {
  private db: NativeDatabase | undefined;
  constructor(db: NativeDatabase, private readonly intMode: IntMode, private readonly released: () => void) { this.db = db; }
  get closed() { return !this.db?.isOpen || !this.db.isTransaction; }
  private current() {
    if (this.closed) throw new LibsqlError("Transaction is closed", "TRANSACTION_CLOSED");
    return this.db!;
  }
  async execute(statement: InStatement) { return execute(this.current(), statement, this.intMode); }
  async batch(statements: InStatement[]) {
    const results: ResultSet[] = [];
    for (let index = 0; index < statements.length; index++) {
      try { results.push(await this.execute(statements[index])); } catch (error) { throw batchError(error, index); }
    }
    return results;
  }
  async executeMultiple(sql: string) { io(() => this.current().exec(sql)); }
  async commit() {
    const db = this.current();
    // BUSY leaves this same transaction active. The adapter may retry COMMIT
    // alone; neither this client nor SQLite reruns the transaction body.
    io(() => db.exec("COMMIT"));
    this.dispose();
  }
  async rollback() {
    if (this.db?.isOpen && this.db.isTransaction) io(() => this.db!.exec("ROLLBACK"));
    this.dispose();
  }
  private dispose() {
    if (this.db?.isOpen) io(() => this.db!.close());
    this.db = undefined;
    this.released();
  }
  close() {
    // DatabaseSync.close finalizes every associated statement and rolls back
    // the uncommitted connection, even if Prisma retains this JS transaction.
    this.dispose();
  }
}

class OwnedSqliteClient implements Client {
  readonly protocol = "file";
  closed = false;
  private db: NativeDatabase | undefined;
  private readonly transactions = new Set<OwnedTransaction>();
  constructor(private readonly path: string, private readonly intMode: IntMode) { this.db = this.open(); }
  private open() { return io(() => new DatabaseSync(this.path, { timeout: 100 })); }
  private current() {
    if (this.closed) throw new LibsqlError("Client is closed", "CLIENT_CLOSED");
    return this.db ??= this.open();
  }
  async execute(statement: InStatement): Promise<ResultSet>;
  async execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async execute(statement: InStatement, args?: InArgs) { return execute(this.current(), typeof statement === "string" ? { sql: statement, args } : statement, this.intMode); }
  async transaction(mode: TransactionMode = "write") {
    if (!["write", "read", "deferred"].includes(mode)) throw new LibsqlError("Unsupported SQLite transaction mode", "TRANSACTION_MODE_UNSUPPORTED");
    const db = this.current();
    // BEGIN failure occurs before detach. The adapter can reconnect and retry
    // acquisition without replaying a callback, query, or provider request.
    io(() => db.exec(mode === "read" ? "PRAGMA query_only=ON; BEGIN DEFERRED" : mode === "deferred" ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE"));
    this.db = undefined;
    const tx = new OwnedTransaction(db, this.intMode, () => this.transactions.delete(tx));
    this.transactions.add(tx);
    return tx;
  }
  async batch(statements: (InStatement | [string, InArgs?])[], mode: TransactionMode = "deferred") {
    const tx = await this.transaction(mode);
    try {
      const result = await tx.batch(statements.map(statement => Array.isArray(statement) ? { sql: statement[0], args: statement[1] } : statement));
      await tx.commit();
      return result;
    } finally { tx.close(); }
  }
  async migrate(statements: InStatement[]) {
    const db = this.current();
    io(() => db.exec("PRAGMA foreign_keys=OFF"));
    try { return await this.batch(statements, "deferred"); }
    finally {
      // The migration's physical connection was closed with its transaction.
      // New connections use SQLite's enabled foreign-key constraint default.
      if (this.db?.isOpen) io(() => this.db!.exec("PRAGMA foreign_keys=ON"));
    }
  }
  async executeMultiple(sql: string) {
    const db = this.current();
    try { io(() => db.exec(sql)); }
    finally { if (db.isTransaction) io(() => db.exec("ROLLBACK")); }
  }
  async sync(): Promise<undefined> { throw new LibsqlError("SQLite replication is unsupported", "SYNC_NOT_SUPPORTED"); }
  close() {
    this.closed = true;
    let failure: unknown;
    for (const tx of this.transactions) { try { tx.close(); } catch (error) { failure ??= error; } }
    if (this.db?.isOpen) { try { io(() => this.db!.close()); } catch (error) { failure ??= error; } }
    if (!this.db?.isOpen) this.db = undefined;
    if (failure) throw failure;
  }
  reconnect() {
    // A rejected BEGIN belongs to the main connection only. Previously
    // returned transactions have detached connections and must remain alive.
    if (this.db?.isOpen) io(() => this.db!.close());
    this.db = undefined;
    this.closed = true;
    this.db = this.open();
    this.closed = false;
  }
}

/** A local persistent-file client with explicitly owned physical connections. */
export function createOwnedSqliteClient(config: Config, path: string): Client {
  if (config.encryptionKey !== undefined || (config as Config & { remoteEncryptionKey?: string }).remoteEncryptionKey !== undefined || config.syncUrl !== undefined || config.syncInterval !== undefined || config.offline !== undefined || config.readYourWrites !== undefined) {
    throw new LibsqlError("Encrypted or replicated SQLite configurations are unsupported", "CONFIG_UNSUPPORTED");
  }
  if (!["number", "bigint", "string"].includes(config.intMode ?? "number")) throw new TypeError("Invalid SQLite integer mode");
  return new OwnedSqliteClient(path, config.intMode ?? "number");
}
