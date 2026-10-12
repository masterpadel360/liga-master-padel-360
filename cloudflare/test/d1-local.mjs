// Simulador mínimo de Cloudflare D1 sobre node:sqlite, solo para pruebas locales.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const conv = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const esLectura = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map(conv)); }
  _all() { return this.db.prepare(this.sql).all(...this.params); }
  _run() { const r = this.db.prepare(this.sql).run(...this.params); return { results: [], meta: { changes: Number(r.changes) } }; }
  _exec() { return esLectura(this.sql) ? { results: this._all(), meta: { changes: 0 } } : this._run(); }
  async all() { return { results: this._all(), meta: {} }; }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async run() { return this._exec(); }
}

export function crearD1(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return {
    _raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
