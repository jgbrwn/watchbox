import test from 'node:test';
import assert from 'node:assert/strict';
import { handleToolHost, launchUrl, toolForHost } from '../src/tools.mjs';
import { guessKind } from '../src/pipeline.mjs';

const env = {
  TOOLS: { cc: { label: 'Find', name: 'c-cli', host: 'watch-cc.example.com', upstream: 'https://cc.example.net' },
           rs: { label: 'Transfer', name: 'rsync-web', host: 'watch-rs.example.com', upstream: 'https://rs.example.net' } },
  TOOLS_SECRET: 'unit-test-secret', TOOLS_AUTHORIZATION: 'Basic Zml4dHVyZTpub3QtYS1yZWFsLXNlY3JldA==', ADMIN_ORIGIN: 'https://admin.example.com'
};
const req = (host, path, headers = {}) => new Request(`https://${host}${path}`, { headers: { Accept: 'text/html', ...headers } });

test('tool hosts require a signed login and keep cookies per host', async () => {
  const cc = toolForHost(env, 'watch-cc.example.com'), rs = toolForHost(env, 'watch-rs.example.com');
  let r = await handleToolHost(req(cc.host, '/x?y=1'), env, cc);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://admin.example.com/admin/tools/launch?tool=cc&next=%2Fx%3Fy%3D1');
  assert.equal((await handleToolHost(req(cc.host, '/api/search', { Accept: '*/*' }), env, cc)).status, 401);
  assert.equal((await handleToolHost(req(cc.host, '/__watch/auth?exp=9999999999&next=/&sig=forged'), env, cc)).status, 403);

  const link = new URL(await launchUrl(env, cc, '/'));
  assert.equal(link.host, cc.host);
  r = await handleToolHost(req(cc.host, link.pathname + link.search), env, cc);
  assert.equal(r.status, 302);
  const cookie = r.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-watch_tool=\d+\.[\w-]+; Path=\/; .*Secure; HttpOnly/);
  const c = cookie.split(';')[0];
  assert.equal((await handleToolHost(req(cc.host, r.headers.get('Location'), { Cookie: c }), env, cc)).headers.get('Location'), '/');
  // A cc cookie is not valid on rs, and a link for cc can't be replayed on rs.
  assert.equal((await handleToolHost(req(rs.host, '/', { Cookie: c }), env, rs)).status, 302);
  assert.equal((await handleToolHost(req(rs.host, link.pathname + link.search), env, rs)).status, 403);
  // Open redirects are refused.
  const evil = new URL(await launchUrl(env, cc, '//evil.example'));
  r = await handleToolHost(req(cc.host, evil.pathname + evil.search), env, cc);
  assert.equal(r.headers.get('Location'), '/__watch/check?next=%2F');
});

test('download names are classified as movie or TV', () => {
  for (const n of ['NYPD Blue S01-S12 (1993-)', 'Show.Name.S03E04.720p.mkv', 'Outrageous Fortune DVD Boxset Season 1, 2, 3', 'Some Show Complete Series'])
    assert.equal(guessKind(n), 'tv', n);
  for (const n of ['Notorious (1946) [BluRay] [1080p] [YTS.AM]', '2001 A Space Odyssey (1968)', 'Se7en (1995)', 'Ocean\'s Eleven (2001)'])
    assert.equal(guessKind(n), 'movie', n);
});

import { guessTitle, explainNote } from '../src/admin.mjs';
import { handleRsyncHook } from '../src/pipeline.mjs';

test('admin turns paths and matcher notes into plain language', () => {
  assert.equal(guessTitle('completed-tv/Australian Survivor S13E02 Kings 1080p/Australian Survivor S13E02.mkv'), 'Australian Survivor');
  assert.equal(guessTitle('media-movies/Some.Movie.2001.1080p.BluRay.mkv'), 'Some Movie');
  assert.equal(explainNote('sim=1.00 number-unknown').episode, true);
  assert.equal(explainNote('no results').episode, false);
});

test('rsync webhook requires a valid signature and syncs once per job', async () => {
  const kv = new Map();
  const DB = { prepare: sql => ({ bind: (...a) => ({
    first: async () => (sql.startsWith('SELECT') && kv.has(a[0]) ? { value: kv.get(a[0]) } : null),
    run: async () => { if (sql.includes("'sync_requested'")) syncs++; else kv.set(a[0], a[1] ?? '1'); }
  }) }) };
  const env = { RSYNC_WEBHOOK_SECRET: 'fixture-secret', DB };
  let syncs = 0; const ctx = { waitUntil: () => {} };   // the hook only asks for a sync; the cron runs it
  const body = JSON.stringify({ id: 7, status: 'completed', exit_code: 0, destination: 'storage:media/movies/' });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('fixture-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const call = s => handleRsyncHook(new Request('https://w/hooks/rsync', { method: 'POST', body, headers: { 'X-Rsync-Web-Signature': 'sha256=' + s } }), env, ctx);
  assert.equal((await call('0'.repeat(64))).status, 401);
  assert.equal((await (await call(sig)).json()).sync, 'started');
  assert.equal((await (await call(sig)).json()).sync, 'skipped');
  assert.equal(syncs, 1);
});

import { readyName } from '../src/pipeline.mjs';
test('only finished downloads directly under the save path are sent', () => {
  const t = (content_path, extra = {}) => ({ progress: 1, state: 'stalledUP', content_path, ...extra });
  assert.equal(readyName(t('/home/freebsd/media/Movie (2020)')), 'Movie (2020)');
  assert.equal(readyName(t('/home/freebsd/media/Movie (2020)/movie.mkv')), 'Movie (2020)');
  assert.equal(readyName(t('/home/freebsd/media/movie.mkv')), 'movie.mkv');
  assert.equal(readyName(t('/home/freebsd/media/temp/Movie')), null);
  assert.equal(readyName(t('/home/freebsd/other/Movie')), null);
  assert.equal(readyName(t('/home/freebsd/media/Movie', { progress: 0.5 })), null);
  assert.equal(readyName(t('/home/freebsd/media/Movie', { state: 'moving' })), null);
});

import { seedState } from '../src/pipeline.mjs';
test('seeding goal: ratio or hours, whichever comes first', () => {
  const s = { seed_ratio: 1, seed_hours: 72 };
  assert.equal(seedState({ ratio: 0.3, seeding_time: 3600 }, s).done, false);
  assert.equal(seedState({ ratio: 1.0, seeding_time: 60 }, s).done, true);
  assert.equal(seedState({ ratio: 0.1, seeding_time: 72 * 3600 }, s).done, true);
  assert.equal(seedState({ ratio: 0, seeding_time: 0 }, { seed_ratio: 0, seed_hours: 0 }).done, true);
});

// A cut-off response from the storage host or TMDB is retried, and named if it keeps happening.
import { fetchListing as _fetchListing } from '../src/origin.mjs';
import { Tmdb as _Tmdb } from '../src/library/tmdb.mjs';
test('incomplete JSON from the listing or TMDB is retried', async () => {
  const env = { ORIGIN_BASE_URL: 'https://o.example/', ORIGIN_AUTHORIZATION: 'Basic x' };
  let n = 0;
  const flaky = async () => new Response(n++ === 0 ? '{"files":[' : '{"files":[],"roots":{}}');
  const data = await _fetchListing(env, flaky);
  assert.deepEqual(data.files, []);
  await assert.rejects(_fetchListing(env, async () => new Response('{"fi')), /listing: incomplete JSON \(4 bytes\)/);
  let m = 0;
  const t = new _Tmdb('tok', { fetchImpl: async () => new Response(m++ === 0 ? '' : '{"id":1}') });
  assert.deepEqual(await t.get('/movie/1'), { id: 1 });
});
