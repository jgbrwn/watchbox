// Searching and fixing matches by IMDb or TMDB id (src/library/ids.mjs, the fix form, requests, Find notes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { parseTitleId, findByImdb } from '../src/library/ids.mjs';
import { Tmdb } from '../src/library/tmdb.mjs';
import { overrideId } from '../src/admin.mjs';
import { searchTitles } from '../src/requests.mjs';
import { annotateFind } from '../src/dupes.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = () => openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });

// TMDB stand-in: The Searchers (movie 3114, tt0049730), Breaking Bad (tv 1396, tt0903747; tt0959621 is an episode).
function tmdbFake() {
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    if (u.host !== 'api.themoviedb.org') return Response.json([]);   // the box: nothing downloading
    const p = u.pathname;
    if (p === '/3/find/tt0049730') return Response.json({ movie_results: [{ id: 3114 }], tv_results: [], tv_episode_results: [] });
    if (p === '/3/find/tt0903747') return Response.json({ movie_results: [], tv_results: [{ id: 1396 }], tv_episode_results: [] });
    if (p === '/3/find/tt0959621') return Response.json({ movie_results: [], tv_results: [], tv_episode_results: [{ id: 62085, show_id: 1396 }] });
    if (p.startsWith('/3/find/')) return Response.json({ movie_results: [], tv_results: [], tv_episode_results: [] });
    if (p === '/3/movie/3114') return Response.json({ id: 3114, title: 'The Searchers', release_date: '1956-03-13', overview: 'Western.' });
    if (p === '/3/tv/1396') return Response.json({ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' });
    if (p === '/3/search/multi') return Response.json({ results: [] });
    return new Response('{}', { status: 404 });
  };
}

test('ids: IMDb ids and links, TMDB links and "tmdb:" ids', () => {
  assert.deepEqual(parseTitleId('tt0049730'), { imdb: 'tt0049730' });
  assert.deepEqual(parseTitleId('https://www.imdb.com/title/tt0049730/?ref_=x'), { imdb: 'tt0049730' });
  assert.deepEqual(parseTitleId('m.imdb.com/title/TT0903747'), { imdb: 'tt0903747' });
  assert.deepEqual(parseTitleId('https://www.themoviedb.org/movie/3114-the-searchers'), { tmdb: 3114, kind: 'movie' });
  assert.deepEqual(parseTitleId('tmdb:tv/1396'), { tmdb: 1396, kind: 'tv' });
  assert.deepEqual(parseTitleId('tmdb:3114'), { tmdb: 3114, kind: null });
  assert.equal(parseTitleId('3114'), null, 'a bare number is a title search in Requests…');
  assert.deepEqual(parseTitleId('3114', { bare: true }), { tmdb: 3114, kind: null }, '…and a TMDB id in the fix form');
  assert.equal(parseTitleId('the searchers'), null);
});

test('fix form: an IMDb id becomes the TMDB id of the right kind', async () => {
  tmdbFake();
  const env = { TMDB_TOKEN: 't' };
  assert.deepEqual(await findByImdb(new Tmdb('t'), 'tt0959621'), [{ kind: 'tv', tmdb_id: 1396 }], 'an episode id gives its show');
  assert.deepEqual(await overrideId(env, 'movie:searchers:1956', 'tt0049730'), { id: 3114 });
  assert.deepEqual(await overrideId(env, 'movie:searchers:1956', 'https://www.imdb.com/title/tt0049730/'), { id: 3114 });
  assert.deepEqual(await overrideId(env, 'tv:breakingbad:', 'tt0903747'), { id: 1396 });
  assert.deepEqual(await overrideId(env, 'movie:breakingbad:', 'tt0903747'), { error: 'fix-kind' });
  assert.deepEqual(await overrideId(env, 'movie:x:', 'tt0000001'), { error: 'fix-missing' });
  assert.deepEqual(await overrideId(env, 'movie:x:', 'https://www.themoviedb.org/movie/3114-the-searchers'), { id: 3114 });
  assert.deepEqual(await overrideId(env, 'movie:x:', '3114'), { id: 3114 });
  assert.deepEqual(await overrideId(env, 'movie:x:', 'none'), { id: null });
});

test('requests: searching by IMDb or TMDB id finds exactly that title', async () => {
  tmdbFake();
  const env = { DB: db(), TMDB_TOKEN: 't' };
  const names = async q => (await searchTitles(env, q, null)).map(r => `${r.kind}:${r.tmdb_id}:${r.title}`);
  assert.deepEqual(await names('tt0049730'), ['movie:3114:The Searchers']);
  assert.deepEqual(await names('https://www.imdb.com/title/tt0903747/'), ['tv:1396:Breaking Bad']);
  assert.deepEqual(await names('https://www.themoviedb.org/tv/1396'), ['tv:1396:Breaking Bad']);
  assert.deepEqual(await names('tmdb:3114'), ['movie:3114:The Searchers'], 'no kind: tried as both, only the movie exists');
  assert.deepEqual(await names('tt0000001'), []);
});

test('Find: a search by id gets the library note on its lookup too', async () => {
  tmdbFake();
  const d = db();
  d.raw.prepare("INSERT INTO movies(tmdb_id, imdb_id, title, year) VALUES (3114, 'tt0049730', 'The Searchers', 1956)").run();
  d.raw.prepare(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,movie_id,added_at) VALUES ('m','media-movies','S/S.mkv','movies','movie',1,0,'k','matched',3114,0)`).run();
  const env = { DB: d, TMDB_TOKEN: 't', TOOLS_AUTHORIZATION: 'Basic eDp5', TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.box.example' } } };
  const data = await annotateFind(env, '/api/search', { lookup: { imdb_id: 'tt0049730', title: 'The Searchers' }, results: [{ title: 'The Searchers', imdb_code: 'tt0049730' }] });
  assert.equal(data.lookup.library_state, 'have');
  assert.equal(data.results[0].library_state, 'have');
});
