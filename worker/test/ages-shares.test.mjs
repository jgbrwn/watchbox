import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { ageOf, applyAges, pickMovieCert } from '../src/ages.mjs';
import { handleJellyfin } from '../src/jellyfin.mjs';
import { sha256Hex } from '../src/auth.mjs';
import { createShare, handleShare, revokeShare } from '../src/shares.mjs';
import { streamVideo } from '../src/media.mjs';
import { handlePlayer, watchData, watchHtml, libraryVersion } from '../src/player.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const H = c => c.repeat(32);
const [R, PG, NR, SER, EP, UK] = ['a', 'b', 'c', 'd', 'e', 'f'].map(H);

test('certificates map to ages across countries', () => {
  for (const [c, a] of [['G', 0], ['PG', 8], ['PG-13', 13], ['R', 17], ['NC-17', 18], ['TV-Y7', 7], ['TV-PG', 10], ['TV-14', 14], ['TV-MA', 17],
    ['12A', 12], ['15', 15], ['16+', 16], ['Från 15 år', 15], ['MA15+', 15], ['M', 15], ['FSK 16', 16], ['U', 0], ['NR', null], ['', null], [null, null], ['Unrated', null]])
    assert.equal(ageOf(c), a, String(c));
  assert.equal(pickMovieCert({ results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }] }, { iso_3166_1: 'DE', release_dates: [{ certification: '12' }] }, { iso_3166_1: 'GB', release_dates: [{ certification: '15' }] }] }), '15', 'GB before DE when US is blank');
});

async function setup() {
  const d = openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  const item = (id, type, name, rating, tmdb, extra = '') => ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,official_rating,provider_ids,file_id,series_id${extra ? ',parent_index,index_number' : ''})
    VALUES (?,?,?,?,?,0,'h',?,?,?,?${extra ? ',1,1' : ''})`, id, type, type === 'Movie' ? 'movies' : 'tv', name, name.toLowerCase(), rating, JSON.stringify(tmdb ? { Tmdb: String(tmdb) } : {}), type === 'Movie' || type === 'Episode' ? id : null, type === 'Episode' ? SER : null);
  item(R, 'Movie', 'Heat', 'R', 949); item(PG, 'Movie', 'Paddington', 'PG', 116149); item(NR, 'Movie', 'Old Classic', 'NR', 777);
  item(SER, 'Series', 'Bluey', 'TV-Y', 82728); item(EP, 'Episode', 'Magic Xylophone', null, null, true); item(UK, 'Movie', 'Brit Film', '15', 555);
  for (const id of [R, PG, NR, EP, UK]) ins("INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,added_at) VALUES (?, 'media-movies', ?, 'movies','movie',10,0,'k',0)", id, id + '.mp4');
  for (const [id, name, max, unrated] of [[H('1'), 'kid', 12, 0], [H('2'), 'teen', 14, 1], [H('3'), 'adult', null, 0]]) {
    ins('INSERT INTO users(id,username,password_hash,created_at,max_age,allow_unrated) VALUES (?,?,?,0,?,?)', id, name, 'x', max, unrated);
    ins('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,last_seen) VALUES (?,?,?,0,9999999999,?)', 's' + name, id, await sha256Hex('tok-' + name), Math.floor(Date.now() / 1000));
  }
  await applyAges(d);
  return d;
}
const auth = who => ({ Authorization: `MediaBrowser Client="t", Device="t", DeviceId="t", Version="1", Token="tok-${who}"` });
const jf = async (env, who, path) => handleJellyfin(new Request('https://w.example' + path, { headers: auth(who) }), env, {});

test('age limits apply to listings, search, direct ids and streams; unrated hidden unless allowed', async () => {
  const d = await setup(), env = { DB: d, SERVER_ID: 'x' };
  assert.deepEqual((await d.prepare('SELECT age FROM items WHERE id = ?').bind(EP).first()).age, 0, 'episodes inherit the series age');
  const names = async who => (await (await jf(env, who, '/Items?Recursive=true&IncludeItemTypes=Movie,Series')).json()).Items.map(i => i.Name).sort();
  assert.deepEqual(await names('adult'), ['Bluey', 'Brit Film', 'Heat', 'Old Classic', 'Paddington']);
  assert.deepEqual(await names('kid'), ['Bluey', 'Paddington']);
  assert.deepEqual(await names('teen'), ['Bluey', 'Old Classic', 'Paddington'], 'teen allows unrated, 15 is above 14');
  assert.deepEqual((await (await jf(env, 'kid', '/Items?Recursive=true&SearchTerm=heat')).json()).Items, []);
  assert.equal((await jf(env, 'kid', '/Items/' + R)).status, 404);
  assert.equal((await jf(env, 'kid', '/Items/' + R + '/PlaybackInfo')).status, 404);
  assert.equal((await jf(env, 'adult', '/Items/' + R)).status, 200);
  globalThis.fetch = async () => new Response('x', { status: 200 });
  env.ORIGIN_BASE_URL = 'https://o.example/'; env.ORIGIN_AUTHORIZATION = 'Basic eA==';
  assert.equal((await streamVideo(new Request('https://w.example/Videos/' + R + '/stream', { headers: auth('kid') }), env, R)).status, 404);
  assert.equal((await streamVideo(new Request('https://w.example/Videos/' + PG + '/stream', { headers: auth('kid') }), env, PG)).status, 200);
  // Owner override: the unrated classic becomes "all ages".
  d.raw.prepare("INSERT INTO age_overrides(key, age, at) VALUES ('movie:777', 0, 0)").run();
  await applyAges(d);
  assert.deepEqual(await names('kid'), ['Bluey', 'Old Classic', 'Paddington']);
});

test('share links play only their title; revoke, expiry and age-limited creators', async () => {
  const d = await setup(), env = { DB: d, ADMIN_ORIGIN: 'https://w.example', ORIGIN_BASE_URL: 'https://o.example/', ORIGIN_AUTHORIZATION: 'Basic eA==' };
  const ctx = { waitUntil() {} };
  const kid = await d.prepare("SELECT * FROM users WHERE username='kid'").first(), adult = await d.prepare("SELECT * FROM users WHERE username='adult'").first();
  assert.equal((await createShare(env, 'https://w.example', kid, { item: PG, days: 7 })).status, 403, 'age-limited users cannot share');
  assert.equal((await createShare(env, 'https://w.example', adult, { item: R, days: 0 })).status, 400, 'guests cannot make never-expiring links');
  assert.equal((await createShare(env, 'https://w.example', adult, { item: SER, days: 7 })).status, 404, 'only movies and episodes');
  const s = (await createShare(env, 'https://w.example', adult, { item: R, days: 7 })).body;
  const tok = s.url.split('/').pop();
  globalThis.fetch = async () => new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 0-4/10' } });
  const get = p => handleShare(new Request('https://w.example/s/' + tok + p), env, ctx, tok, p);
  const page = await get('');
  assert.equal(page.status, 200); assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(await page.text(), /Heat/);
  assert.equal((await get('/play/' + R + '/file')).status, 206);
  assert.equal((await get('/play/' + PG + '/file')).status, 404, 'other titles are not reachable');
  assert.equal((await get('/api/library')).status, 404, 'no library browsing');
  assert.equal((await get('/watch/' + PG)).status, 404);
  assert.equal((await d.prepare('SELECT views FROM shares WHERE id = ?').bind(tok).first()).views, 1);
  await revokeShare(env, tok, kid.id);   // someone else's: no effect
  assert.equal((await get('/play/' + R + '/file')).status, 206);
  await revokeShare(env, tok, adult.id);
  assert.equal((await get('/play/' + R + '/file')).status, 404);
  const dead = await get('');
  assert.equal(dead.status, 410); assert.match(await dead.text(), /turned off/);
  const s2 = (await createShare(env, 'https://w.example', null, { item: PG, days: 1 })).body, t2 = s2.url.split('/').pop();
  d.raw.prepare('UPDATE shares SET expires_at = 1 WHERE id = ?').run(t2);
  assert.equal((await handleShare(new Request(s2.url + '/play/' + PG + '/file'), env, ctx, t2, '/play/' + PG + '/file')).status, 404, 'expired');
  const exp = await handleShare(new Request(s2.url), env, ctx, t2, '');
  assert.equal(exp.status, 410);
  const html = await exp.text();
  assert.match(html, /This link has expired/); assert.match(html, /1970/); assert.doesNotMatch(html, /Paddington/, 'no title on a dead link');
  assert.equal((await handleShare(new Request('https://w.example/s/zz'), env, ctx, 'zz', '')).status, 404);
});

test('favorites from the web player show up in apps; age limits and share links hold', async () => {
  const d = await setup(), env = { DB: d, SERVER_ID: 'x' };
  const user = n => d.prepare('SELECT * FROM users WHERE username = ?').bind(n).first();
  const kid = await user('kid'), adult = await user('adult');
  const fav = (u, item, on, opts = {}) => handlePlayer(new Request('https://w.example/me/play/favorite', { method: 'POST', body: JSON.stringify({ item, on }) }),
    env, {}, { base: '/me', userId: u?.id ?? null, viewer: u, page: () => null, ...opts }).then(async r => ({ status: r.status, body: await r.json() }));
  const appFavs = async who => (await (await jf(env, who, '/Items?Recursive=true&Filters=IsFavorite&IncludeItemTypes=Movie,Series,Episode')).json()).Items.map(i => i.Name).sort();

  assert.deepEqual((await fav(adult, R, true)).body, { favorite: true });
  assert.deepEqual((await fav(adult, SER, true)).body, { favorite: true });
  assert.deepEqual(await appFavs('adult'), ['Bluey', 'Heat'], 'the same favorites in Jellyfin apps');
  assert.equal((await watchData(env, R, adult.id, adult)).favorite, true);
  assert.match(watchHtml(await watchData(env, R, adult.id, adult), { base: '/me', back: '/me', linked: true }).body, /id=favbtn[^>]*aria-pressed="true">★ Favorite</);
  assert.deepEqual((await fav(adult, R, false)).body, { favorite: false });
  assert.deepEqual(await appFavs('adult'), ['Bluey']);
  assert.deepEqual(await appFavs('kid'), [], 'per user');

  assert.equal((await fav(kid, R, true)).status, 404, 'above the age limit');
  assert.equal((await fav(kid, PG, true)).status, 200);
  assert.equal((await fav(null, PG, true)).status, 403, 'not signed in as a library user (unlinked owner, share links)');
  assert.equal((await fav(adult, PG, true, { allow: async () => false })).status, 404);
  assert.doesNotMatch(watchHtml(await watchData(env, R, null, null), { base: '/s/x', back: null, linked: false, share: {} }).body, /favbtn/, 'no button on share links');
});

test('libraryVersion changes when a title arrives or gets artwork (open pages refresh on it)', async () => {
  const d = await setup();
  const v1 = (await libraryVersion(d)).v;
  assert.equal((await libraryVersion(d)).v, v1, 'stable while nothing changes');
  d.raw.prepare("INSERT INTO items(id,type,library,name,sort_name,date_created,hash) VALUES (?, 'Movie', 'movies', 'New One', 'new one', 5, 'h')").run('9'.repeat(32));
  const v2 = (await libraryVersion(d)).v;
  assert.notEqual(v2, v1);
  d.raw.prepare("UPDATE items SET images = '{\"Primary\":\"/p.jpg\"}' WHERE id = ?").run('9'.repeat(32));
  assert.notEqual((await libraryVersion(d)).v, v2);
});
