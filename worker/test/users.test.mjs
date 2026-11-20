import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { handleUsers, passphrase, userStatus } from '../src/users.mjs';
import { createRequest, decide, refreshRequests, requestsFor, pickTorrent, searchTitles, dismissNotice, requestsForOwner, ageHint } from '../src/requests.mjs';
import { handleJellyfin } from '../src/jellyfin.mjs';
import { hashPassword } from '../src/passwords.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = () => openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
const post = (path, body) => new Request('https://watch.example.com' + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const call = async (env, path, body) => { const r = await handleUsers(body ? post(path, body) : new Request('https://watch.example.com' + path), env, path); return { status: r.status, body: await r.json() }; };

test('passphrases are long enough and random', () => {
  const a = new Set(Array.from({ length: 200 }, passphrase));
  assert.equal(a.size, 200);
  for (const p of a) { assert.ok(p.length >= 20, p); assert.match(p, /^[a-z]+(-[a-z]+){3}-\d\d$/); }
});

test('invites: no password until accepted; plain logins get a one-time password; emails are optional', async () => {
  const sent = [];
  const env = { DB: db(), ADMIN_ORIGIN: 'https://watch.example.com', EMAIL_FROM: 'Watch <watch@example.com>', EMAIL: { send: async m => { sent.push(m); return { messageId: 'm1' }; } } };
  let r = await call(env, '/admin/api/users/create', { username: 'sam', display_name: 'Sam', email: 'Sam@Example.com', send_email: true });
  assert.equal(r.status, 200); assert.equal(r.body.password, null); assert.equal(r.body.email.ok, true);
  assert.equal(sent[0].to, 'sam@example.com'); assert.match(sent[0].text, /https:\/\/watch\.example\.com\/me/); assert.match(sent[0].text, /"sam"/);
  const u = await env.DB.prepare("SELECT * FROM users WHERE username='sam'").first();
  assert.equal(userStatus(u), 'invited');
  assert.equal((await call(env, '/admin/api/users/create', { username: 'sam2', email: 'sam@example.com' })).status, 409, 'email is unique');
  assert.equal((await call(env, '/admin/api/users/create', { username: 'bad name!' })).status, 400);

  r = await call(env, '/admin/api/users/create', { username: 'grandma' });
  assert.ok(r.body.password.length >= 20);
  const list = (await call(env, '/admin/api/users')).body;
  assert.deepEqual(list.users.map(x => [x.username, x.status]), [['sam', 'invited'], ['grandma', 'active']]);
  assert.ok(!('password_hash' in list.users[0]));

  // Without the email service the invite still works; the error is recorded for the owner.
  const env2 = { ...env, EMAIL: { send: async () => { const e = new Error('nope'); e.code = 'E_SENDER_DOMAIN_NOT_AVAILABLE'; throw e; } } };
  r = await call(env2, '/admin/api/users/create', { username: 'kim', email: 'kim@example.com' });
  assert.equal(r.status, 200); assert.equal(r.body.email.ok, false); assert.match(r.body.email.error, /not set up/);

  // Delete needs the username typed.
  const k = await env.DB.prepare("SELECT id FROM users WHERE username='kim'").first();
  assert.equal((await call(env, '/admin/api/users/delete', { id: k.id, confirm: 'nope' })).status, 400);
  assert.equal((await call(env, '/admin/api/users/delete', { id: k.id, confirm: 'kim' })).status, 200);
});

test('each Jellyfin user only sees their own progress', async () => {
  const d = db();
  const env = { DB: d, SERVER_ID: 'x' };
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  const UA = 'a1'.repeat(16), UB = 'b2'.repeat(16);
  for (const [id, name] of [[UA, 'alice'], [UB, 'bob']]) {
    ins('INSERT INTO users(id,username,password_hash,created_at) VALUES (?,?,?,0)', id, name, await hashPassword('correct horse battery staple'));
    ins("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,last_seen) VALUES (?,?,?,0,9999999999,?)", 's' + id, id, await (await import('../src/auth.mjs')).sha256Hex('tok-' + name), Math.floor(Date.now() / 1000));
  }
  ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,runtime_ticks,file_id) VALUES ('${'e'.repeat(32)}','Movie','movies','Heat','heat',0,'h',72000000000,'${'e'.repeat(32)}')`);
  ins(`INSERT INTO progress(user_id,item_id,position_ticks,played,last_played) VALUES ('${UA}','${'e'.repeat(32)}',30000000000,0,1)`);
  const resume = async who => (await (await handleJellyfin(new Request('https://w.example.com/UserItems/Resume', { headers: { Authorization: `MediaBrowser Client="t", Device="t", DeviceId="t", Version="1", Token="tok-${who}"` } }), env, {})).json()).Items.map(i => i.Name);
  assert.deepEqual(await resume('alice'), ['Heat']);
  assert.deepEqual(await resume('bob'), []);
  // Asking for another user's id in the path still answers for the signed-in user.
  const r = await handleJellyfin(new Request(`https://w.example.com/Users/${UA}/Items/Resume`, { headers: { Authorization: 'MediaBrowser Token="tok-bob"' } }), env, {});
  assert.deepEqual((await r.json()).Items, []);
});

test('requests: auto-approve downloads movies, others join, owner decides, ready when in the library', async () => {
  const d = db(), sent = [], calls = [];
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  ins("INSERT INTO users(id,username,password_hash,created_at,email,auto_approve,notify) VALUES ('ua','alice','x',0,'a@example.com',1,1),('ub','bob','x',0,'b@example.com',0,1)");
  ins("INSERT INTO kv(key,value) VALUES ('storage_usage', ?)", JSON.stringify({ used_mb: 1000, at: Math.floor(Date.now() / 1000) }));
  globalThis.fetch = async (url) => {
    const u = new URL(String(url)); calls.push(u.pathname + u.search);
    if (u.host === 'api.themoviedb.org') {
      if (u.pathname === '/3/movie/949') return Response.json({ id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/p.jpg', imdb_id: 'tt0113277' });
      if (u.pathname === '/3/tv/1396') return Response.json({ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' });
    }
    if (u.host === 'cc.example.net' && u.pathname === '/api/search') return Response.json({ results: [{ title: 'Heat', year: 1995, imdb_code: 'tt0113277', torrents: [
      { url: 'https://yts.example/t/1', hash: 'AAA', quality: '2160p', type: 'bluray', seeds: 90, size: '5 GB' },
      { url: 'https://yts.example/t/2', hash: 'BBB', quality: '1080p', type: 'web', seeds: 50, size: '2 GB' },
      { url: 'https://yts.example/t/3', hash: 'CCC', quality: '1080p', type: 'bluray', seeds: 10, size: '2.2 GB' }] }] });
    if (u.host === 'cc.example.net' && u.pathname === '/api/download') return Response.json({ filename: 'x.torrent' });
    if (u.host === 'rs.example.net') return Response.json({ disk_total: 400e9, disk_free: 300e9 });
    if (u.host === 'dl.example.net') return Response.json([{ hash: 'ccc', progress: 0.5, eta: 600, state: 'downloading' }]);
    if (u.pathname.endsWith('list.php')) return Response.json({ used_mb: 1000 });
    throw new Error('unexpected ' + url);
  };
  const env = { DB: d, TMDB_TOKEN: 't', TOOLS_AUTHORIZATION: 'Basic eDp5', ORIGIN_BASE_URL: 'https://o.example.net/', HOSTBRR_QUOTA_MB: '8388608', ADMIN_ORIGIN: 'https://watch.example.com',
    ADMIN_EMAIL_ALLOWLIST: 'owner@example.com', EMAIL_FROM: 'w@example.com', EMAIL: { send: async m => { sent.push(m); return { messageId: 'x' }; } },
    TOOLS: { cc: { name: 'c-cli', upstream: 'https://cc.example.net' }, dl: { name: 'qBittorrent', upstream: 'https://dl.example.net' }, rs: { name: 'rsync-web', upstream: 'https://rs.example.net' } } };
  const alice = await d.prepare("SELECT * FROM users WHERE id='ua'").first(), bob = await d.prepare("SELECT * FROM users WHERE id='ub'").first();

  let r = await createRequest(env, alice, { kind: 'movie', tmdb_id: 949 });
  assert.equal(r.body.status, 'sent', JSON.stringify(r.body));
  assert.ok(calls.some(c => c.startsWith('/api/download?url=https%3A%2F%2Fyts.example%2Ft%2F3')), 'best 1080p bluray with seeders');
  r = await createRequest(env, bob, { kind: 'movie', tmdb_id: 949, note: 'please' });
  assert.equal(r.body.status, 'sent', 'joins the existing download');
  assert.equal((await createRequest(env, bob, { kind: 'movie', tmdb_id: 949 })).status, 409);
  assert.equal((await requestsFor(env, 'ub'))[0].label, 'Downloading 50% · 10 min left');

  r = await createRequest(env, bob, { kind: 'tv', tmdb_id: 1396 });
  assert.equal(r.body.status, 'pending');
  assert.equal(sent.at(-1).to, 'owner@example.com', 'owner is told about requests that need a decision');
  assert.equal((await decide(env, { kind: 'tv', tmdb_id: 1396, action: 'auto' })).status, 400, 'shows are never picked automatically');
  await decide(env, { kind: 'tv', tmdb_id: 1396, action: 'decline', reply: 'Not available' });
  assert.equal((await requestsFor(env, 'ub')).find(x => x.kind === 'tv').label, 'Declined');

  // The movie arrives in the library -> both people get "ready" emails.
  ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,movie_id,added_at) VALUES ('f1','media-movies','Heat/Heat.mkv','movies','movie',1,0,'k','matched',949,0)`);
  sent.length = 0;
  assert.equal(await refreshRequests(env), 1);
  assert.deepEqual(sent.map(m => m.to).sort(), ['a@example.com', 'b@example.com']);
  assert.equal((await requestsFor(env, 'ua'))[0].label, 'Ready to watch');
  assert.equal((await createRequest(env, alice, { kind: 'movie', tmdb_id: 949 })).status, 409, 'already in the library');
});

test('age limits on requests: above the limit refused; unrated goes to the owner with a note; hidden arrivals; declines', async () => {
  const d = db(), sent = [];
  const ins = (sql, ...a) => d.raw.prepare(sql).run(...a);
  ins("INSERT INTO users(id,username,password_hash,created_at,email,notify,max_age,allow_unrated,auto_approve) VALUES ('k','kid','x',0,'k@example.com',1,12,0,1),('t','teen','x',0,'t@example.com',1,14,1,1)");
  const rel = c => ({ results: [{ iso_3166_1: 'US', release_dates: [{ certification: c }] }] });
  const tm = { 1: { title: 'Rated R', release_dates: rel('R') }, 2: { title: 'Rated PG', release_dates: rel('PG') }, 3: { title: 'Unrated', release_dates: rel('') },
    4: { title: 'Overridden', release_dates: rel('R') }, 5: { title: 'In library, R', release_dates: rel('R') }, 6: { title: 'In library, unrated', release_dates: rel('') } };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'api.themoviedb.org') {
      const m = /^\/3\/movie\/(\d+)$/.exec(u.pathname);
      if (m) return Response.json({ id: Number(m[1]), release_date: '2000-01-01', ...tm[m[1]] });
      if (u.pathname === '/3/tv/9') return Response.json({ id: 9, name: 'Show', content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } });
      if (u.pathname === '/3/search/multi') return Response.json({ results: [5, 6, 2].map(id => ({ media_type: 'movie', id, title: tm[id].title })) });
    }
    if (u.host === 'dl.example.net') return Response.json([]);
    throw new Error('unexpected ' + url);
  };
  const env = { DB: d, TMDB_TOKEN: 't', TOOLS_AUTHORIZATION: 'Basic eDp5', ADMIN_EMAIL_ALLOWLIST: 'owner@example.com', EMAIL_FROM: 'w@example.com',
    EMAIL: { send: async m => { sent.push(m); return {}; } }, TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.example.net' } } };
  const kid = await d.prepare("SELECT * FROM users WHERE id='k'").first(), teen = await d.prepare("SELECT * FROM users WHERE id='t'").first();
  ins("INSERT INTO age_overrides(key, age, at) VALUES ('movie:4', 0, 0)");
  const libMovie = (n, age) => {
    ins(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,movie_id,added_at) VALUES (?,'media-movies',?,'movies','movie',1,0,'k','matched',?,0)`, 'f' + n, `M${n}/M${n}.mkv`, n);
    ins(`INSERT INTO items(id,type,library,name,sort_name,date_created,hash,provider_ids,age,file_id) VALUES (?,'Movie','movies',?,?,0,'h',?,?,?)`, 'i' + n, tm[n].title, tm[n].title, JSON.stringify({ Tmdb: String(n) }), age, 'f' + n);
  };
  libMovie(5, 17); libMovie(6, null);

  // Rated above the limit: refused, nothing stored, nobody emailed; library titles above it aren't revealed.
  let r = await createRequest(env, kid, { kind: 'movie', tmdb_id: 1 });
  assert.equal(r.status, 403); assert.match(r.body.error, /rated 17\+, above your age limit/);
  assert.equal((await createRequest(env, kid, { kind: 'tv', tmdb_id: 9 })).status, 403, 'TV-MA');
  assert.equal((await createRequest(env, kid, { kind: 'movie', tmdb_id: 5 })).status, 403, 'in the library but above: refused, not "already in the library"');
  assert.equal(sent.length, 0);
  assert.equal(await d.prepare('SELECT count(*) n FROM requests').first().then(x => x.n), 0);
  const s = await searchTitles(env, 'something', kid);
  assert.deepEqual(s.map(x => [x.tmdb_id, x.in_library, x.age_limit]), [[5, false, 'above'], [6, false, null], [2, false, null]]);

  // Unrated: goes to the owner, and the kid is told why.
  r = await createRequest(env, kid, { kind: 'movie', tmdb_id: 3 });
  assert.equal(r.body.status, 'pending'); assert.match(r.body.note, /no age rating/);
  assert.equal(sent.at(-1).to, 'owner@example.com');
  assert.match(sent.at(-1).text, /Age: No age rating, and kid’s limit is 12: .* age of 12 or under .* If you wouldn’t be comfortable rating it 12 or under, decline it\./);
  r = await createRequest(env, kid, { kind: 'movie', tmdb_id: 6 });
  assert.equal(r.body.status, 'pending', 'hidden unrated title already in the library: still a request');
  assert.equal((await createRequest(env, kid, { kind: 'movie', tmdb_id: 4 })).body.note, null, 'override to all ages: rated');
  assert.equal((await createRequest(env, kid, { kind: 'movie', tmdb_id: 2 })).body.note, null);
  assert.equal((await createRequest(env, teen, { kind: 'movie', tmdb_id: 3 })).body.note, null, 'unrated allowed for the teen');
  assert.equal((await createRequest(env, teen, { kind: 'movie', tmdb_id: 6 })).status, 409, 'the teen can see it: already in the library');

  // The owner's Pipeline card says which age it needs; people allowed unrated (the teen) don't count.
  const card = async id => (await requestsForOwner(env)).find(x => x.tmdb_id === id);
  assert.match((await card(3)).age_hint, /kid’s limit is 12/);
  assert.equal((await card(2)).age_hint, undefined, 'rated titles need no hint');
  assert.equal((await card(4)).age_hint, undefined, 'already given an age the kid can see');
  ins("INSERT INTO age_overrides(key, age, at) VALUES ('movie:3', 16, 0)");
  assert.match((await card(3)).age_hint, /12 or under/, 'rated above the kid: hint stays');
  d.raw.prepare("UPDATE age_overrides SET age = 10 WHERE key = 'movie:3'").run();
  assert.equal((await card(3)).age_hint, undefined, 'rated 10: the kid can watch it');
  d.raw.prepare("DELETE FROM age_overrides WHERE key = 'movie:3'").run();
  assert.match(ageHint([{ name: 'A', max_age: 12 }, { name: 'B', max_age: 7 }]), /B 7, A 12\. If you wouldn’t be comfortable rating it 7 or under/);

  // The hidden one "arrives": the kid hears it's waiting for an age rating, the owner hears who can't see it.
  sent.length = 0;
  await refreshRequests(env);
  assert.deepEqual(sent.map(m => m.to).sort(), ['k@example.com', 'owner@example.com']);
  assert.match(sent.find(m => m.to === 'k@example.com').subject, /waiting for an age rating/);
  assert.match(sent.find(m => m.to === 'owner@example.com').subject, /hidden from kid/);
  assert.match(sent.find(m => m.to === 'owner@example.com').text, /give it an age of 12 or under/);
  assert.match((await card(6)).age_hint, /kid can’t see it yet: .* 12 or under/);
  const six = (await requestsFor(env, kid)).find(x => x.tmdb_id === 6);
  assert.equal(six.label, 'In the library, waiting for an age rating'); assert.equal(six.hidden, true);
  ins("INSERT INTO age_overrides(key, age, at) VALUES ('movie:6', 0, 0)"); d.raw.prepare("UPDATE items SET age = 0 WHERE id = 'i6'").run();
  assert.equal((await requestsFor(env, kid)).find(x => x.tmdb_id === 6).label, 'Ready to watch', 'once rated it shows');
  assert.equal((await card(6)).age_hint, undefined);

  // Declined: email, and a notice on /me until dismissed.
  sent.length = 0;
  await decide(env, { kind: 'movie', tmdb_id: 3, action: 'decline', reply: 'Not for now' });
  assert.deepEqual(sent.map(m => m.to).sort(), ['k@example.com', 't@example.com']);
  assert.match(sent[0].text, /Not for now/);
  const three = (await requestsFor(env, 'k')).find(x => x.tmdb_id === 3);
  assert.equal(three.notice, true);
  await dismissNotice(d, 'k', three.id);
  assert.equal((await requestsFor(env, 'k')).find(x => x.tmdb_id === 3).notice, undefined);
  await dismissNotice(d, 't', three.id);   // someone else's request: no effect
});

test('torrent choice: 1080p, then 720p, then 4K; bluray first; needs seeders', () => {
  const m = t => [{ imdb_code: 'tt1', torrents: t }];
  assert.equal(pickTorrent(m([{ hash: 'a', quality: '2160p', seeds: 9 }, { hash: 'b', quality: '720p', seeds: 1 }]), 'tt1').torrent.hash, 'b');
  assert.equal(pickTorrent(m([{ hash: 'a', quality: '1080p', seeds: 0 }]), 'tt1'), null);
  assert.equal(pickTorrent(m([{ hash: 'a', quality: '1080p', seeds: 3 }]), 'tt2'), null, 'must be the same IMDb title');
});

test('quick connect: code → approve → session, once; signed source urls', async () => {
  const { initiate, connect, authorize, authenticate } = await import('../src/quickconnect.mjs');
  const { signedSrc, handlePlaySrc } = await import('../src/player.mjs');
  const d = db();
  d.raw.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES ('u1','sam','x',0)").run();
  const env = { DB: d, TOOLS_SECRET: 's3cret', ORIGIN_BASE_URL: 'https://o.example/', ORIGIN_AUTHORIZATION: 'Basic eA==' };
  const tv = new Request('https://w.example/QuickConnect/Initiate', { method: 'POST', headers: { Authorization: 'MediaBrowser Client="Jellyfin Android TV", Device="Living room", DeviceId="dev1", Version="0.18"' } });
  const r = await initiate(tv, env);
  assert.match(r.Code, /^\d{6}$/); assert.equal(r.Authenticated, false);
  assert.equal((await connect(env, r.Secret)).Authenticated, false);
  assert.equal(await authenticate(tv, env, r.Secret), null, 'not approved yet');
  assert.match((await authorize(env, '000000' === r.Code ? '111111' : '000000', 'u1')).error, /isn’t valid/);
  assert.deepEqual(await authorize(env, r.Code.slice(0, 3) + ' ' + r.Code.slice(3), 'u1'), { device: 'Living room · Jellyfin Android TV' });
  assert.equal((await connect(env, r.Secret)).Authenticated, true);
  const s = await authenticate(tv, env, r.Secret);
  assert.equal(s.user.username, 'sam'); assert.ok(s.token);
  assert.equal(await authenticate(tv, env, r.Secret), null, 'secret works once');
  assert.match((await authorize(env, r.Code, 'u1')).error, /isn’t valid/);

  d.raw.prepare("INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,added_at) VALUES ('" + 'f'.repeat(32) + "','media-movies','A/a.mkv','movies','movie',10,0,'k',0)").run();
  const url = await signedSrc(env, 'https://w.example', 'f'.repeat(32));
  globalThis.fetch = async () => new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 0-2/10' } });
  assert.equal((await handlePlaySrc(new Request(url, { headers: { Range: 'bytes=0-2' } }), env, 'f'.repeat(32))).status, 206);
  assert.equal((await handlePlaySrc(new Request(url.replace(/sig=../, 'sig=00')), env, 'f'.repeat(32))).status, 403);
  assert.equal((await handlePlaySrc(new Request(url), { ...env, TOOLS_SECRET: 'other' }, 'f'.repeat(32))).status, 403);
});
