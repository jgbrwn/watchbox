// A tiny D1-compatible wrapper over node:sqlite, for local builds and tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map(a => a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)); }
  _s() { return this.db.prepare(this.sql); }
  async all() { return { results: this._s().all(...this.args) }; }
  async first(col) { const r = this._s().get(...this.args); return r == null ? null : col ? r[col] : r; }
  async run() { const r = this._s().run(...this.args); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; }
  _runSync() { return this._s().run(...this.args); }
}

export function openLocalDb(file, { migrations = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  for (const m of migrations) db.exec(readFileSync(m, 'utf8'));
  return {
    raw: db,
    prepare: sql => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._runSync()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); }
  };
}
