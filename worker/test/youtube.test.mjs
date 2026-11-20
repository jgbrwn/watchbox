import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { parseYouTubeUrl, parseYoutubePath, refreshJobs, sidecars } from '../src/youtube.mjs';
import { applyListing, matchPending } from '../src/library/sync.mjs';
import { rebuildItems, viewId } from '../src/library/catalog.mjs';
import { handleJellyfin } from '../src/jellyfin.mjs';
import { sha256Hex } from '../src/auth.mjs';
import { createRequest, requestsFor, refreshRequests, decide, searchTitles } from '../src/requests.mjs';
import { libraryItems } from '../src/player.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const VID = 'dQw4w9WgXcQ';
const PATH = `Rick Astley/Never Gonna Give You Up [${VID}].mp4`;
const ROOTS = { 'media-movies': 0, 'completed-movies': 0, 'media-tv': 0, 'completed-tv': 0, 'media-youtube': 1 };
const SIDECAR = { id: VID, title: 'Never Gonna Give You Up', channel: 'Rick Astley', channel_id: 'UC1', upload_date: '20091025', duration: 213,
  description: 'The official video.', categories: ['Music'], tags: ['rick'], age_limit: 0 };

test('YouTube links: every common form, nothing else', () => {
  for (const u of [VID, `https://www.youtube.com/watch?v=${VID}&t=42s`, `youtube.com/watch?v=${VID}`, `https://youtu.be/${VID}?si=abc`, `https://m.youtube.com/watch?v=${VID}`,
    `https://music.youtube.com/watch?v=${VID}&list=RD`, `https://www.youtube.com/shorts/${VID}`, `https://www.youtube.com/live/${VID}`, `https://www.youtube-nocookie.com/embed/${VID}`])
    assert.equal(parseYouTubeUrl(u), VID, u);
  for (const u of ['', 'hello', 'https://vimeo.com/123', `https://evil.example/watch?v=${VID}`, 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@channel'])
    assert.equal(parseYouTubeUrl(u), null, u);
  assert.deepEqual(parseYoutubePath(PATH), { kind: 'movie', title: 'Never Gonna Give You Up', ytid: VID, channel: 'Rick Astley' });
  assert.deepEqual(sidecars(PATH), { info: PATH.replace('.mp4', '.info.json'), thumb: PATH.replace('.mp4', '.jpg'), poster: PATH.replace('.mp4', '.poster.jpg') });
});

async function library() {
  const d = openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
  await applyListing(d, { roots: ROOTS, files: [['media-youtube', PATH, 1000, 1, 7], ['media-youtube', PATH.replace('.mp4', '.en.srt'), 10, 1, 8]] });
  const fetched = [];
  const r = await matchPending(d, null, { fetchText: async (root, path) => { fetched.push(root + '/' + path); return JSON.stringify(SIDECAR); } });
  assert.equal(r.youtube, 1);
  assert.deepEqual(fetched, ['media-youtube/' + sidecars(PATH).info]);
  await rebuildItems(d);
  return d;
}

test('a downloaded video becomes a YouTube library item from its sidecar; age limits apply', async () => {
  const d = await library();
  const it = await d.prepare("SELECT * FROM items WHERE library = 'youtube'").first();
  assert.equal(it.type, 'Movie'); assert.equal(it.name, 'Never Gonna Give You Up'); assert.equal(it.year, 2009); assert.equal(it.premiere_date, '2009-10-25');
  assert.equal(it.parent_id, await viewId('youtube'));
  assert.deepEqual(JSON.parse(it.studios), ['Rick Astley']);
  assert.equal(JSON.parse(it.images).Primary, 'origin:media-youtube/' + sidecars(PATH).poster);
  assert.equal(JSON.parse(it.subtitles).length, 1, 'English subtitles attached');
  assert.equal(it.age, null, 'YouTube videos are unrated');

  for (const [id, name, max] of [[H('1'), 'kid', 12], [H('2'), 'adult', null]]) {
    d.raw.prepare('INSERT INTO users(id,username,password_hash,created_at,max_age) VALUES (?,?,?,0,?)').run(id, name, 'x', max);
    d.raw.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,last_seen) VALUES (?,?,?,0,9999999999,0)').run('s' + name, id, await sha256Hex('tok-' + name));
  }
  const env = { DB: d, SERVER_ID: 'x' };
  const get = async (who, path) => (await handleJellyfin(new Request('https://w.example' + path, { headers: { Authorization: `MediaBrowser Client="t", Device="t", DeviceId="t", Version="1", Token="tok-${who}"` } }), env, {})).json();
  const views = (await get('adult', '/UserViews')).Items.map(v => [v.Name, v.CollectionType]);
  assert.deepEqual(views.at(-1), ['YouTube', 'movies']);
  assert.deepEqual((await get('adult', `/Items?ParentId=${await viewId('youtube')}`)).Items.map(i => i.Name), ['Never Gonna Give You Up']);
  assert.deepEqual((await get('adult', `/Items?ParentId=${await viewId('movies')}`)).Items, [], 'not mixed into Movies');
  assert.deepEqual((await get('kid', `/Items?ParentId=${await viewId('youtube')}`)).Items, [], 'unrated: hidden from age-limited users');
  d.raw.prepare(`INSERT INTO age_overrides(key, age, at) VALUES ('youtube:${VID}', 0, 0)`).run();
  await rebuildItems(d);
  assert.equal((await get('kid', `/Items?ParentId=${await viewId('youtube')}`)).Items.length, 1, 'owner rated it: kids see it');
  assert.deepEqual((await libraryItems(d, '', 'YouTube')).counts, { YouTube: 1 });
  assert.deepEqual((await libraryItems(d, '', 'Movie')).items, [], '/me Movies shelf excludes YouTube');
});
const H = c => c.repeat(32);

test('YouTube requests: link search, auto-approve sends to the box, job mirrored, ready when in the library', async () => {
  const d = await library();
  d.raw.prepare("DELETE FROM items").run(); d.raw.prepare("DELETE FROM files").run(); d.raw.prepare("DELETE FROM file_paths").run();
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  ins("INSERT INTO users(id,username,password_hash,created_at,email,auto_approve,notify) VALUES ('ua','alice','x',0,'a@example.com',1,1),('ub','bob','x',0,'b@example.com',0,1)");
  ins("INSERT INTO users(id,username,password_hash,created_at,email,auto_approve,max_age,allow_unrated) VALUES ('uk','kid','x',0,'k@example.com',1,12,1),('un','young','x',0,'y@example.com',1,12,0)");
  const box = new Map(), sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.host === 'www.youtube.com' && u.pathname === '/oembed') return new URL(u.searchParams.get('url')).searchParams.get('v') === VID ? Response.json({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley' }) : new Response('Not Found', { status: 404 });
    if (u.host === 'dl.example.net' && u.pathname === '/__watchstream/yt/add') { const b = JSON.parse(init.body); box.set(b.id, { id: b.id, status: 'queued', quality: b.quality }); return Response.json(box.get(b.id)); }
    if (u.host === 'dl.example.net' && u.pathname === '/__watchstream/yt/jobs') return Response.json({ jobs: [...box.values()], free_gb: 50 });
    throw new Error('unexpected ' + url);
  };
  const env = { DB: d, TOOLS_AUTHORIZATION: 'Basic eDp5', ADMIN_EMAIL_ALLOWLIST: 'owner@example.com', EMAIL_FROM: 'w@example.com', EMAIL: { send: async m => { sent.push(m); return {}; } },
    TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.example.net' } } };
  const user = async id => d.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();

  const s = await searchTitles(env, `https://youtu.be/${VID}`, 'ub');
  assert.equal(s.length, 1); assert.equal(s[0].kind, 'youtube'); assert.equal(s[0].title, 'Never Gonna Give You Up'); assert.equal(s[0].in_library, false);
  assert.equal((await createRequest(env, await user('ub'), { kind: 'youtube', yt_id: 'zzzzzzzzzzz' })).status, 404, 'unknown video');

  // Age-limited without unrated titles: still goes to the owner, with a note saying why (videos have no rating).
  const yn = await createRequest(env, await user('un'), { kind: 'youtube', yt_id: VID });
  assert.equal(yn.body.status, 'pending'); assert.match(yn.body.note, /no age rating/);
  assert.equal(sent.at(-1).to, 'owner@example.com'); sent.length = 0;
  // Kid (age-limited, unrated allowed, auto-approve) → owner decides; nothing sent to the box.
  assert.equal((await searchTitles(env, `https://youtu.be/${VID}`, await user('un')))[0].age_limit, null, 'search doesn’t block YouTube');
  assert.equal((await createRequest(env, await user('uk'), { kind: 'youtube', url: `https://www.youtube.com/watch?v=${VID}` })).body.status, 'pending');
  assert.equal(box.size, 0);
  assert.equal(sent.at(-1).to, 'owner@example.com');
  assert.match(sent.at(-1).text, /youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  // Alice (auto-approve) → straight to the box; the kid's open request joins it.
  assert.equal((await createRequest(env, await user('ua'), { kind: 'youtube', yt_id: VID })).body.status, 'sent');
  assert.equal(box.get(VID).quality, '1080');
  assert.equal((await createRequest(env, await user('ua'), { kind: 'youtube', yt_id: VID })).status, 409);
  assert.equal((await requestsFor(env, 'ua'))[0].label, 'Queued');
  box.get(VID).status = 'downloading'; box.get(VID).progress = 0.4;
  assert.equal((await requestsFor(env, 'ua'))[0].label, 'Downloading 40%');
  await decide(env, { kind: 'youtube', yt_id: VID, action: 'auto' });   // owner approves the kid's: same job
  assert.equal((await d.prepare("SELECT count(*) n FROM requests WHERE status = 'sent'").first()).n, 3, 'alice, the kid and the young one');

  // The box finishes → copied; the sync brings it into the library → added; both are told.
  Object.assign(box.get(VID), { status: 'done', progress: 1, path: PATH, size: 1000, title: 'Never Gonna Give You Up', channel: 'Rick Astley' });
  assert.deepEqual(await refreshJobs(env), { copied: 1 });
  assert.equal((await d.prepare('SELECT status FROM yt_jobs').first()).status, 'copied');
  await applyListing(d, { roots: ROOTS, files: [['media-youtube', PATH, 1000, 1, 7]] });
  await matchPending(d, null, { fetchText: async () => JSON.stringify(SIDECAR) });
  await rebuildItems(d);
  await refreshJobs(env);
  assert.equal((await d.prepare('SELECT status FROM yt_jobs').first()).status, 'added');
  sent.length = 0;
  assert.equal(await refreshRequests(env), 1);
  // The young one can't see unrated videos: told it's waiting for an age rating, and the owner is told who can't see it.
  assert.deepEqual(sent.map(m => m.to).sort(), ['a@example.com', 'k@example.com', 'owner@example.com', 'y@example.com']);
  assert.match(sent.find(m => m.to === 'a@example.com').text, /under YouTube/);
  assert.match(sent.find(m => m.to === 'y@example.com').subject, /waiting for an age rating/);
  assert.match(sent.find(m => m.to === 'owner@example.com').subject, /hidden from young/);
  assert.equal((await requestsFor(env, 'un'))[0].label, 'In the library, waiting for an age rating');
  assert.equal((await requestsFor(env, 'uk'))[0].label, 'Ready to watch');
  assert.equal((await searchTitles(env, `https://youtu.be/${VID}`, 'ub'))[0].in_library, true);
});

test('playlists: preview with detected episodes, add as a TV show (joins the existing show), guest playlist requests', async () => {
  const { detectEpisode, guessShow, episodeName, parsePlaylistUrl, previewPlaylist, addPlaylist } = await import('../src/youtube.mjs');
  assert.equal(parsePlaylistUrl('https://youtube.com/playlist?list=PLjCa07oQMK6YRfQGitgQjAHXGpL33oLum&si=x'), 'PLjCa07oQMK6YRfQGitgQjAHXGpL33oLum');
  assert.equal(parsePlaylistUrl(`https://www.youtube.com/watch?v=${VID}&list=PLjCa07oQMK6YRfQGitgQjAHXGpL33oLum`), null, 'a video in a playlist is the video');
  assert.equal(parsePlaylistUrl('https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ'), null, 'no endless mixes');
  assert.deepEqual(detectEpisode('Outrageous Fortune Season 1 Episode 9 | When The Blood Burns', 0), { season: 1, episode: 9, title: 'When The Blood Burns', how: 'title' });
  assert.equal(guessShow('Outrageous Fortune Season 1 Episodes'), 'Outrageous Fortune');
  assert.equal(episodeName('Show: The Return', 1, 2, 'A/B?', 'uvGmZSwpzW8'), 'Show- The Return/Season 01/Show- The Return - S01E02 - A B- [uvGmZSwpzW8]');

  const d = openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  // The show is already in the library from a DVD rip.
  ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,child_count) VALUES ('${H('a')}','Series','tv','Outrageous Fortune','outrageous fortune',0,'h',6)`);
  ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,series_id,parent_index,index_number,container,streams) VALUES ('${H('b')}','Episode','tv','Slings','slings',0,'h','${H('a')}',1,1,'avi','[{"type":"Video","height":336}]')`);
  ins("INSERT INTO users(id,username,password_hash,created_at,email,auto_approve,notify) VALUES ('ua','alice','x',0,'a@example.com',1,1)");
  const E = [['DN0wQTj3TBE', 'Outrageous Fortune Season 1 Episode 1 | Slings and Arrows'], ['iD1-CrKZnB0', 'Outrageous Fortune Season 1 Episode 2 | Think Yourself A Baby']];
  const LID = 'PLjCa07oQMK6YRfQGitgQjAHXGpL33oLum', adds = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/__watchstream/yt/playlist') return Response.json({ id: LID, title: 'Outrageous Fortune Season 1 Episodes', channel: 'Outrageous Fortune', entries: [...E].reverse().map(([id, title]) => ({ id, title, duration: 2500 })) });
    if (u.pathname === '/__watchstream/yt/add') { adds.push(JSON.parse(init.body)); return Response.json({ status: 'queued' }); }
    if (u.pathname === '/__watchstream/yt/jobs') return Response.json({ jobs: [] });
    throw new Error('unexpected ' + url);
  };
  const env = { DB: d, TOOLS_AUTHORIZATION: 'Basic eDp5', TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.example.net' } } };
  const pv = (await previewPlaylist(env, LID)).data;
  assert.equal(pv.show, 'Outrageous Fortune'); assert.equal(pv.series.name, 'Outrageous Fortune');
  assert.deepEqual(pv.entries.map(e => [e.season, e.episode, e.existing]), [[1, 1, '336p avi'], [1, 2, null]], 'sorted by episode; shows what it would replace');
  assert.equal((await addPlaylist(env, LID, { dest: 'tv', show: 'Outrageous Fortune', items: [{ id: 'DN0wQTj3TBE', season: 1, episode: 1 }, { id: 'iD1-CrKZnB0', season: 1, episode: 1 }] })).error, 'Two videos are set to S01E01.');
  const r = await addPlaylist(env, LID, { dest: 'tv', show: 'Outrageous Fortune', items: [{ id: 'DN0wQTj3TBE', season: 1, episode: 1 }, { id: 'iD1-CrKZnB0', season: 1, episode: 2 }] });
  assert.deepEqual(r, { added: 2, total: 2 });
  assert.deepEqual(adds[0], { id: 'DN0wQTj3TBE', quality: '1080', dest: 'tv', name: 'Outrageous Fortune/Season 01/Outrageous Fortune - S01E01 - Slings and Arrows [DN0wQTj3TBE]' });
  // That name parses as the same show the DVD rip matched.
  const { parseFile } = await import('../src/library/parse.mjs');
  const { matchKeyFor } = await import('../src/library/sync.mjs');
  const ep = parseFile('tv', adds[1].name + '.mp4', 8e8);
  assert.equal(matchKeyFor('tv', ep), 'tv:outrageousfortune:'); assert.equal(ep.season, 1); assert.equal(ep.episode, 2);

  // A guest asks for the playlist; an auto-approve user's playlist is queued whole (into the YouTube library).
  d.raw.prepare('DELETE FROM yt_jobs').run(); d.raw.prepare('DELETE FROM yt_lists').run(); adds.length = 0;
  const alice = await d.prepare("SELECT * FROM users WHERE id='ua'").first();
  const s = await searchTitles(env, 'https://youtube.com/playlist?list=' + LID, 'ua');
  assert.equal(s[0].yt_id, 'list:' + LID); assert.match(s[0].overview, /2 videos/);
  assert.equal((await createRequest(env, alice, { kind: 'youtube', yt_id: s[0].yt_id })).body.status, 'sent');
  assert.deepEqual(adds.map(a => [a.id, a.dest]), [['iD1-CrKZnB0', undefined], ['DN0wQTj3TBE', undefined]]);
  assert.equal((await requestsFor(env, 'ua'))[0].label, '0 of 2 in the library');
  // Both arrive -> the request is ready.
  for (const [id, title] of E) {
    const path = `Outrageous Fortune/${title} [${id}].mp4`;
    ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,added_at) VALUES (?, 'media-youtube', ?, 'youtube','movie',1,0,?, 'matched',0)`, H(id[0].toLowerCase() === 'd' ? 'c' : 'e'), path, 'yt:' + id);
    ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,file_id) VALUES (?,'Movie','youtube',?,?,0,'h',?)`, H(id[0].toLowerCase() === 'd' ? '7' : '8'), title, title, H(id[0].toLowerCase() === 'd' ? 'c' : 'e'));
  }
  assert.equal(await refreshRequests(env), 1);
  assert.equal((await requestsFor(env, 'ua'))[0].status, 'available');
});
