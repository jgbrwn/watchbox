import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { planDelete, executeDelete, duplicateGroups, suggestions, search } from '../src/manage.mjs';
import { scanOnly } from '../src/cron.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const SECRET = 'unit-test-manage-secret-0123456789abcdef';
const T = 1_790_000_000;

function setup() {
  const db = openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
  const ins = (sql, ...a) => db.raw.prepare(sql).run(...a);
  ins("INSERT INTO movies(tmdb_id,title,year) VALUES (1,'Hours',2013),(2,'Notorious',1946)");
  const file = (id, root, path, size, mins, movie, kind = 'movie') => {
    ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,inode,parsed,match_key,match_status,movie_id,duration_ticks,added_at)
         VALUES (?,?,?,'movies',?,?,?,?,'{}','k','matched',?,?,?)`, id, root, path, kind, size, T, null, movie, mins * 600_000_000, T);
    ins('INSERT INTO file_paths(root,path,file_id,last_seen) VALUES (?,?,?,?)', root, path, id, T);
  };
  const H = 'a'.repeat(32), S = 'b'.repeat(32), N1 = 'c'.repeat(32), N2 = 'd'.repeat(32);
  file(H, 'media-movies', 'Hours (2013)/Hours.mkv', 8e9, 97, 1);
  ins('INSERT INTO file_paths(root,path,file_id,last_seen) VALUES (?,?,?,?)', 'completed-movies', 'Hours SiMPLE/Hours.mkv', H, T);   // hard link
  ins("INSERT INTO subtitles(root,path,file_id,format) VALUES ('media-movies','Hours (2013)/Hours.en.srt',?, 'srt')", H);
  file(S, 'completed-movies', 'Hours SiMPLE/Hours-013.mkv', 1e8, 1.1, 1);
  file(N1, 'media-movies', 'Notorious (1946)/Notorious.mp4', 2e9, 102, 2);
  file(N2, 'completed-movies', 'Notorious YTS/Notorious.mp4', 1.7e9, 102, 2);
  ins("INSERT INTO users(id,username,password_hash,created_at) VALUES ('u1','tv','x',0)");
  ins("INSERT INTO progress(user_id,item_id,position_ticks,played,last_played) VALUES ('u1',?,1000,0,?)", N2, T);
  ins("INSERT INTO kv(key,value) VALUES ('root_counts', ?)", JSON.stringify({ 'media-movies': 3, 'completed-movies': 3, 'media-tv': 0, 'completed-tv': 0 }));
  ins("INSERT INTO kv(key,value) VALUES ('push:7', ?), ('pushed:abc', '7')", JSON.stringify({ job: 7, name: 'Hours (2013)', hash: 'abc', finished: T }));
  return { db, H, S, N1, N2 };
}

function mockFetch({ torrents = [], media = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.host === 'dl.example.net') return Response.json(torrents);
    if (u.host === 'rs.example.net') return Response.json({ entries: media.map(name => ({ name, is_dir: true })) });
    if (u.pathname.endsWith('/manage.php')) {
      const body = init.body;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
      assert.equal(new Headers(init.headers).get('X-Watch-Signature'), 'sha256=' + sig);
      const req = JSON.parse(body);
      calls.push(req);
      return Response.json({ batch: '20261116-120000-abcdef', files: req.paths.map(([root, rel]) => ({ root, rel, size: 1 })), folders: [{ root: 'completed-movies', rel: 'Hours SiMPLE', files: 2 }], frees: 8e9, linked_elsewhere: [], gone: [] });
    }
    if (u.pathname.endsWith('/list.php')) return Response.json({ generated: T, roots: { 'media-movies': 2, 'completed-movies': 1, 'media-tv': 0, 'completed-tv': 0 }, files: [] });
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}

const envFor = db => ({
  DB: db, MANAGE_SECRET: SECRET, ORIGIN_BASE_URL: 'https://origin.example.net/', ORIGIN_AUTHORIZATION: 'Basic eDp5', TOOLS_AUTHORIZATION: 'Basic eDp5',
  TOOLS: { dl: { name: 'qBittorrent', host: 'watch-dl.example.com', upstream: 'https://dl.example.net' }, rs: { name: 'rsync-web', host: 'watch-rs.example.com', upstream: 'https://rs.example.net' } }
});

test('a delete is refused while the download is still on the box', async () => {
  const { db, H } = setup();
  mockFetch({ torrents: [{ name: 'Hours SiMPLE', hash: 'abc', content_path: '/home/freebsd/media/Hours SiMPLE' }] });
  const plan = await planDelete(envFor(db), [H]);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /still in qBittorrent/);
  const r = await executeDelete(envFor(db), [H]);
  assert.equal(r.status, 409);
  assert.equal((await db.prepare('SELECT deleted_at FROM files WHERE id=?').bind(H).first()).deleted_at, null);
});

test('a delete is refused when the download box can not be checked', async () => {
  const { db, S } = setup();
  mockFetch();
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const r = await executeDelete(envFor(db), [S]);
  assert.equal(r.status, 503);
});

test('deleting removes every path and subtitle, updates the library at once, and keeps ids for restore', async () => {
  const { db, H, S, N2 } = setup();
  const env = envFor(db);
  const calls = mockFetch();
  const plan = await planDelete(env, [H, N2]);
  assert.deepEqual(plan.blocked, []);
  assert.ok(plan.warnings.some(w => /^tv has started Notorious/.test(w)), plan.warnings.join('|'));
  assert.ok(!plan.warnings.some(w => /Hours.*disappear/.test(w)), 'the sample keeps Hours in the library');

  const r = await executeDelete(env, [H], 'Hours');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = calls.find(c => c.op === 'trash');
  assert.deepEqual(sent.paths.map(p => p.join('/')).sort(),
    ['completed-movies/Hours SiMPLE/Hours.mkv', 'media-movies/Hours (2013)/Hours.en.srt', 'media-movies/Hours (2013)/Hours.mkv']);
  const row = await db.prepare('SELECT missing_since, deleted_at FROM files WHERE id=?').bind(H).first();
  assert.ok(row.missing_since && row.deleted_at);
  assert.equal((await db.prepare('SELECT count(*) n FROM file_paths WHERE file_id=?').bind(H).first()).n, 0);
  // Items rebuilt: Hours is now just the remaining file (no "(Version n)" suffix).
  const items = (await db.prepare("SELECT id, name FROM items WHERE type='Movie' AND name LIKE 'Hours%'").all()).results;
  assert.deepEqual(items.map(r => ({ ...r })), [{ id: S, name: "Hours" }]);
  // Shrink guard counts lowered; the old pipeline record no longer blocks a re-download from being sent.
  const counts = JSON.parse((await db.prepare("SELECT value FROM kv WHERE key='root_counts'").first()).value);
  assert.equal(counts['completed-movies'], 0);
  assert.equal(await db.prepare("SELECT 1 FROM kv WHERE key='pushed:abc'").first(), null);

  // A listing generated before the delete finished is ignored (it would bring the file back).
  await db.prepare("UPDATE kv SET value=? WHERE key='last_delete_at'").bind(String(T + 10)).run();
  assert.deepEqual(await scanOnly(env), { skipped: 'listing older than a delete' });
});

test('clutter suggestions and duplicate grouping', async () => {
  const { db, S } = setup();
  const s = await suggestions(db);
  assert.deepEqual(s.short.map(f => f.id), [S]);
  const notorious = s.duplicates.find(g => g.title.startsWith('Notorious'));
  assert.equal(notorious.copies, true);
  assert.equal(notorious.files[0].size, 2e9, 'best copy first');
  assert.equal(s.duplicates.find(g => g.title.startsWith('Hours')).copies, false, '97 min vs 1 min is not a copy');
  assert.equal(duplicateGroups([{ library: 'movies', movie_id: 5, minutes: 50, part: 1, size: 1 }, { library: 'movies', movie_id: 5, minutes: 50, part: 2, size: 1 }])[0].copies, false);
  assert.equal((await search(db, 'notor')).length, 2);
  assert.equal((await search(db, '100%')).length, 0);
});
