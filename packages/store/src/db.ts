import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, any>;
type Param = SQLInputValue | boolean | undefined;

const norm = (p: Param[]): SQLInputValue[] => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/**
 * SQLite store shared by API, indexer and worker processes (WAL mode). Every write path uses
 * BEGIN IMMEDIATE so that "check then write" sequences (leases, cursor + events) are atomic
 * across processes. Scale boundary: one host, one database file (docs/architecture.md).
 */
export class Db {
  readonly sql: DatabaseSync;
  private depth = 0;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  }

  migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.sql.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, new Date().toISOString());
      });
    }
    return this;
  }

  get<T = Row>(q: string, ...p: Param[]): T | undefined { return this.sql.prepare(q).get(...norm(p)) as T | undefined; }
  all<T = Row>(q: string, ...p: Param[]): T[] { return this.sql.prepare(q).all(...norm(p)) as T[]; }
  run(q: string, ...p: Param[]) { const r = this.sql.prepare(q).run(...norm(p)); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; }

  /** Atomic write transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    for (let attempt = 0; ; attempt++) {
      try { this.sql.exec('BEGIN IMMEDIATE'); break; } catch (e) {
        if (attempt < 20 && /busy|locked/i.test((e as Error).message)) { sleepSync(25 * (attempt + 1)); continue; }
        throw e;
      }
    }
    this.depth = 1;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('Db.tx callback must be synchronous');
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.sql.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally { this.depth = 0; }
  }

  close() { this.sql.close(); }
}

const sab = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(sab, 0, 0, ms);

export const now = () => new Date().toISOString();
export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
export const parse = <T = any>(s: string | null | undefined): T | null => (s == null ? null : (JSON.parse(s) as T));
