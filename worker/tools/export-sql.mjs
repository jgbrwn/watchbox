#!/usr/bin/env node
// Export the locally built library (and, optionally, users/sessions/progress from an
// old-schema SQLite copy) as SQL INSERTs for `wrangler d1 execute --file`.
// Usage: node tools/export-sql.mjs <library.db> <out.sql> [old.db]
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [libPath, out, oldPath] = process.argv.slice(2);
const lib = new DatabaseSync(libPath, { readOnly: true });
const lit = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const lines = [];
function dump(db, table, rows, cols) {
  cols ||= Object.keys(rows[0] || {});
  // D1 caps a statement at 100 KB: group rows into ~80 KB statements.
  const head = `INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES\n`;
  let buf = [], size = 0;
  const flush = () => { if (buf.length) lines.push(head + buf.join(',\n') + ';'); buf = []; size = 0; };
  for (const r of rows) {
    const v = '(' + cols.map(c => lit(r[c])).join(',') + ')';
    if (size + v.length > 80_000) flush();
    buf.push(v); size += v.length;
  }
  flush();
}
for (const t of ['files', 'file_paths', 'subtitles', 'lookups', 'movies', 'series', 'episodes', 'items', 'persons', 'kv']) {
  const rows = lib.prepare(`SELECT * FROM ${t}`).all();
  if (rows.length) dump(lib, t, rows);
  console.log(t, rows.length);
}
if (oldPath) {
  const old = new DatabaseSync(oldPath, { readOnly: true });
  const now = Math.floor(Date.now() / 1000);
  const users = old.prepare("SELECT u.* FROM app_users u WHERE u.disabled = 0 AND NOT EXISTS (SELECT 1 FROM delivery_test_accounts t WHERE t.user_id = u.id)").all();
  dump(old, 'users', users.map(u => ({ id: u.id, username: u.username, password_hash: u.password_hash, is_admin: u.is_admin, disabled: 0, created_at: u.created_at })));
  const ids = new Set(users.map(u => u.id));
  const sessions = old.prepare('SELECT * FROM app_sessions WHERE revoked_at IS NULL AND expires_at > ?').all(now).filter(s => ids.has(s.user_id));
  dump(old, 'sessions', sessions.map(s => ({ id: s.id, user_id: s.user_id, token_hash: s.token_hash, device_id: s.device_id, created_at: s.created_at, last_seen: now, expires_at: now + 365 * 86400 })));
  const progress = old.prepare('SELECT * FROM watch_progress').all().filter(p => ids.has(p.user_id));
  dump(old, 'progress', progress.map(p => ({ user_id: p.user_id, item_id: p.media_id, position_ticks: p.position_ticks, played: p.played, play_count: p.played ? 1 : 0, last_played: p.updated_at })));
  const favs = old.prepare('SELECT * FROM user_favorites').all().filter(f => ids.has(f.user_id));
  if (favs.length) dump(old, 'favorites', favs.map(f => ({ user_id: f.user_id, item_id: f.media_id, created_at: f.created_at })));
  console.log('users', users.length, 'sessions', sessions.length, 'progress', progress.length, 'favorites', favs.length);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log('wrote', out);
