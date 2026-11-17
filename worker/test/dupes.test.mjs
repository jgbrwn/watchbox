// Duplicate checks (src/dupes.mjs): Find annotations, the auto-send safety net, and requests joining box downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { quality, haveNote, haveTitle, duplicateCheck, annotateFind, onTheBox } from '../src/dupes.mjs';
import { parseMovie, parseEpisode } from '../src/library/parse.mjs';
import { matchKeyFor } from '../src/library/sync.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = () => openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
const probe = (w, h) => JSON.stringify({ streams: [{ type: 'Video', width: w, height: h }] });

function setup() {
  const d = db();
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  ins("INSERT INTO movies(tmdb_id, imdb_id, title, year) VALUES (100, 'tt0049730', 'The Searchers', 1956)");
  ins("INSERT INTO series(tmdb_id, imdb_id, title, year) VALUES (200, 'tt0461097', 'Outrageous Fortune', 2005)");
  ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,movie_id,probe,added_at)
       VALUES ('m1','media-movies','The Searchers (1956)/The Searchers.mkv','movies','movie',1,0,'k','matched',100,?,0)`, probe(1920, 800));
  for (const e of [1, 2, 3]) ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,series_key,season,episode,probe,added_at)
       VALUES (?, 'media-tv', ?, 'tv','episode',1,0,'k','matched','tmdb:200',1,?,?,0)`, 'e' + e, `OF/Season 01/OF - S01E0${e}.mkv`, e, probe(720, 576));
  // What the library sync already learned (so no TMDB searches are needed here).
  const key = (lib, name) => matchKeyFor(lib, lib === 'movies' ? parseMovie(`${name}/${name}.mkv`, 1e9) : parseEpisode(`${name}/${name}.mkv`, 1e9));
  const look = (k, kind, id) => ins('INSERT INTO lookups(key,kind,tmdb_id,manual,at) VALUES (?,?,?,0,0)', k, kind, id);
  look(key('movies', 'The Searchers (1956) [1080p] [BluRay] [YTS.MX]'), 'movie', 100);
  look(key('tv', 'Outrageous.Fortune.S01.1080p.WEB-DL'), 'tv', 200);
  look(key('movies', 'Heat (1995) [2160p]'), 'movie', 300);
  return d;
}

function box(torrents, files = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const j = v => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
    if (u.hostname === 'api.themoviedb.org') {
      if (u.pathname === '/3/movie/100') return j({ id: 100, imdb_id: 'tt0049730' });
      if (u.pathname === '/3/movie/300') return j({ id: 300, imdb_id: 'tt0113277' });
      if (u.pathname === '/3/tv/200/external_ids') return j({ imdb_id: 'tt0461097' });
      return new Response('{}', { status: 404 });
    }
    if (u.pathname === '/api/v2/torrents/info') return j(torrents);
    if (u.pathname === '/api/v2/torrents/files') return j(files[u.searchParams.get('hash')] || []);
    return new Response('nope', { status: 404 });
  };
  return calls;
}
const envFor = d => ({ DB: d, TMDB_TOKEN: 't', TOOLS_AUTHORIZATION: 'Basic eDp5', TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.box.example' } } });

test('quality labels and "in library" notes', async () => {
  assert.equal(quality(probe(1920, 800)), '1080p');
  assert.equal(quality(probe(3840, 1600)), '2160p');
  assert.equal(quality(probe(720, 576)), 'SD');
  assert.equal(quality(null), null);
  const d = setup();
  assert.equal(haveNote('movie', await haveTitle(d, 'movie', 100)), 'In library · 1080p');
  assert.equal(haveNote('tv', await haveTitle(d, 'tv', 200)), 'In library · season 1 · SD');
  assert.equal(haveNote('movie', await haveTitle(d, 'movie', 999)), null);
});

test('auto-send: a movie you have, or a pack whose episodes you all have, is a duplicate; partial packs are not', async () => {
  const d = setup(), env = envFor(d);
  const ep = n => ({ name: `Outrageous.Fortune.S01.1080p.WEB-DL/Outrageous.Fortune.S01E0${n}.1080p.mkv`, size: 1e9 });
  box([], { aaa: [ep(1), ep(2), ep(3), { name: 'x/sample.txt', size: 1 }], bbb: [ep(1), ep(2), ep(3), ep(4)] });
  const m = await duplicateCheck(env, { hash: 'm'.repeat(40) }, 'The Searchers (1956) [1080p] [BluRay] [YTS.MX]');
  assert.equal(m.all, true); assert.equal(m.title, 'The Searchers (1956)'); assert.equal(m.note, 'In library · 1080p');
  const full = await duplicateCheck(env, { hash: 'aaa' }, 'Outrageous.Fortune.S01.1080p.WEB-DL');
  assert.equal(full.all, true); assert.equal(full.note, 'All 3 episodes already in library · SD');
  const part = await duplicateCheck(env, { hash: 'bbb' }, 'Outrageous.Fortune.S01.1080p.WEB-DL');
  assert.equal(part.all, false); assert.equal(part.note, '3 of 4 episodes already in library');
  assert.equal(await duplicateCheck(env, { hash: 'ccc' }, 'Heat (1995) [2160p]'), null);   // not in the library
});

test('Find results get library and download notes by IMDb id', async () => {
  const d = setup(), env = envFor(d);
  box([{ hash: 'h'.repeat(40), name: 'Heat (1995) [2160p]', progress: 0.42 }]);
  const data = await annotateFind(env, '/api/search', { results: [
    { title: 'The Searchers', imdb_code: 'tt0049730' },
    { title: 'Outrageous Fortune', omdb: { imdbID: 'tt0461097' } },
    { title: 'Heat', imdb_code: 'tt0113277' },
    { title: 'Unknown', imdb_code: 'tt0000001' }] });
  assert.deepEqual(data.results.map(r => r.library_note || null), ['In library · 1080p', 'In library · season 1 · SD', 'Downloading now (42%)', null]);
  assert.deepEqual(data.results.map(r => r.library_state || null), ['have', 'have', 'downloading', null]);
  const one = await annotateFind(env, '/api/omdb', { imdbID: 'tt0049730' });
  assert.equal(one.library_state, 'have');
});

test('requests can find a title already on the box; identifications are cached per torrent', async () => {
  const d = setup(), env = envFor(d);
  const calls = box([{ hash: 'h'.repeat(40), name: 'Heat (1995) [2160p]', progress: 1 }]);
  assert.equal((await onTheBox(env, 'movie', 300))[0]?.hash, 'h'.repeat(40));
  assert.equal((await onTheBox(env, 'movie', 100)).length, 0);
  assert.equal(calls.filter(c => c.startsWith('/3/')).length, 1);   // one TMDB call (IMDb id), then cached
});
