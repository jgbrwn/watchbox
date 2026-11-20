// Title requests. Users search TMDB on /me and ask for a movie or show; the owner approves in /admin → Pipeline,
// or a user marked "auto-approve" gets movies downloaded straight away. A download is a YTS torrent picked by
// c-cli on the download box (best 1080p with seeders), after which the normal pipeline copies it to the storage host.
// A request becomes "available" by itself as soon as the title is in the library, however it got there.
// TV requests always wait for the owner: TV releases are too varied to pick automatically.
// YouTube requests (a pasted link): approved ones are downloaded by the box (src/youtube.mjs); auto-approve users'
// start at once. Rows for YouTube have kind 'youtube', yt_id set and tmdb_id 0.
import { Tmdb } from './library/tmdb.mjs';
import * as yt from './youtube.mjs';
import { cfg } from './config.mjs';
import { getJson, storage } from './pipeline.mjs';
import { onTheBox } from './dupes.mjs';
import { randomHex } from './passwords.mjs';
import { ageOf, pickMovieCert, pickTvCert, allowedAge } from './ages.mjs';
import { parseTitleId, findByImdb } from './library/ids.mjs';
import { sendEmail, portalUrl } from './users.mjs';

const OPEN = ['pending', 'approved', 'sent'];
export const MAX_OPEN = 10;          // per user, so one person can't fill the disk
const now = () => Math.floor(Date.now() / 1000);
const img = p => p ? 'https://image.tmdb.org/t/p/w185' + p : null;

export async function inLibrary(db, kind, tmdbId) {
  const row = kind === 'movie'
    ? await db.prepare("SELECT 1 FROM files WHERE movie_id = ? AND kind = 'movie' AND missing_since IS NULL LIMIT 1").bind(tmdbId).first()
    : await db.prepare("SELECT 1 FROM files WHERE series_key = ? AND kind = 'episode' AND missing_since IS NULL LIMIT 1").bind('tmdb:' + tmdbId).first();
  return !!row;
}

// One key for "the same title" across requests: (kind, tmdb_id, yt_id).
const keyOf = r => r.kind === 'youtube' ? { kind: 'youtube', tmdb_id: 0, yt_id: r.yt_id } : { kind: r.kind, tmdb_id: Number(r.tmdb_id), yt_id: '' };
const inLib = (db, k) => k.kind === 'youtube' ? yt.inLibrary(db, k.yt_id) : inLibrary(db, k.kind, k.tmdb_id);
const kindWord = k => k === 'tv' ? 'the show' : k === 'youtube' ? 'the YouTube video' : 'the movie';

// Age-limited users can't ask for titles rated above their limit (the owner's age overrides count). Unrated titles
// (and YouTube videos, which have no rating) still go to the owner, who decides and can give them an age.
export async function ageRefusal(db, user, key, age) {
  if (user?.max_age == null) return null;
  const o = key ? await db.prepare('SELECT age FROM age_overrides WHERE key = ?').bind(key).first() : null;
  if (o) age = o.age;
  if (age == null || age <= user.max_age) return null;
  return { status: 403, body: { error: `That one is rated ${age}+, above your age limit.`, age_limit: 'above' } };
}
/** For the owner: what age an unrated title needs for limited people (who can't see unrated titles) to watch it.
 *  `people`: [{ name, max_age }]. `arrived`: it's in the library already. */
export function ageHint(people, arrived = false) {
  if (!people.length) return null;
  const ps = [...people].sort((a, b) => a.max_age - b.max_age), low = ps[0].max_age;
  const where = 'Users → Age ratings';
  if (ps.length === 1) {
    const n = ps[0].name;
    return arrived
      ? `${n} can’t see it yet: it has no age rating and ${n}’s limit is ${low}. To let ${n} watch it, give it an age of ${low} or under (${where}).`
      : `No age rating, and ${n}’s limit is ${low}: once it’s in the library, ${n} can only watch it if you give it an age of ${low} or under (${where}). If you wouldn’t be comfortable rating it ${low} or under, decline it.`;
  }
  const list = ps.map(p => `${p.name} ${p.max_age}`).join(', ');
  return arrived
    ? `Hidden from some of the people who asked: it has no age rating. Each can watch it once you give it an age at or under their limit (${where}): ${list}.`
    : `No age rating. Once it’s in the library, each person can only watch it if you give it an age at or under their limit (${where}): ${list}. If you wouldn’t be comfortable rating it ${low} or under, decline it, or accept that only some of them will see it.`;
}
const limitedOf = us => us.filter(u => u.max_age != null && !u.allow_unrated).map(u => ({ name: u.display_name || u.username, max_age: u.max_age }));
const UNRATED_NOTE = 'This one has no age rating, so your account won’t show it on its own. Your request went to the owner, who decides whether to add it and whether you can watch it.';
/** A library title's age for a limited user: "above" | "unrated" when it's hidden from them, else null (fine, or not there). */
async function libraryBlock(db, user, kind, tmdbId) {
  if (user?.max_age == null) return null;
  const r = await db.prepare("SELECT age FROM items WHERE type = ? AND json_extract(provider_ids, '$.Tmdb') = ? LIMIT 1").bind(kind === 'movie' ? 'Movie' : 'Series', String(tmdbId)).first();
  return r && !allowedAge(user, r.age) ? (r.age == null ? 'unrated' : 'above') : null;
}
/** Can this person see the title in the library? null: no library item for it yet. (Playlists count as visible.) */
async function visibleTo(db, user, k) {
  if (user?.max_age == null) return true;
  let r;
  if (k.kind === 'youtube') { if (k.yt_id.startsWith('list:')) return true; const id = await yt.itemFor(db, k.yt_id); r = id && await db.prepare('SELECT age FROM items WHERE id = ?').bind(id).first(); }
  else r = await db.prepare("SELECT age FROM items WHERE type = ? AND json_extract(provider_ids, '$.Tmdb') = ? LIMIT 1").bind(k.kind === 'movie' ? 'Movie' : 'Series', String(k.tmdb_id)).first();
  return r ? allowedAge(user, r.age) : null;
}
const shelf = k => k === 'tv' ? 'Shows' : k === 'youtube' ? 'YouTube' : 'Movies';

/** `user`: the signed-in user (or just their id). Results a limited user can't ask for carry `age_limit` ("above" | "unrated"). */
export async function searchTitles(env, q, user) {
  const userId = typeof user === 'string' ? user : user?.id;
  q = String(q || '').trim().slice(0, 300);
  const listId = yt.parsePlaylistUrl(q);
  if (listId) {   // a pasted playlist link
    const p = await yt.playlist(env, listId);
    if (p.error || !p.data.entries.length) return [];
    const mine = userId ? await env.DB.prepare("SELECT status FROM requests WHERE user_id = ? AND kind = 'youtube' AND yt_id = ?").bind(userId, 'list:' + listId).first() : null;
    return [{ kind: 'youtube', yt_id: 'list:' + listId, tmdb_id: 0, title: p.data.title || 'YouTube playlist', year: null, poster: yt.thumbUrl(p.data.entries[0].id),
      overview: `YouTube playlist · ${p.data.entries.length} videos${p.data.channel ? ' · ' + p.data.channel : ''}`, in_library: await yt.inLibrary(env.DB, 'list:' + listId), requested: mine?.status || null }];
  }
  const ytId = yt.parseYouTubeUrl(q);
  if (ytId && /youtu\.?be/i.test(q)) {   // a pasted YouTube link
    const info = await yt.lookup(ytId);
    if (!info) return [];
    const mine = userId ? await env.DB.prepare("SELECT status FROM requests WHERE user_id = ? AND kind = 'youtube' AND yt_id = ?").bind(userId, ytId).first() : null;
    return [{ kind: 'youtube', yt_id: ytId, tmdb_id: 0, title: info.title || 'YouTube video ' + ytId, year: null, poster: yt.thumbUrl(ytId),
      overview: info.channel ? 'YouTube · ' + info.channel : 'YouTube', in_library: await yt.inLibrary(env.DB, ytId), requested: mine?.status || null,
      age_limit: (await ageRefusal(env.DB, user, 'youtube:' + ytId, null)) ? 'above' : null }];
  }
  q = q.slice(0, 100);
  if (q.length < 2) return [];
  const tmdb = new Tmdb(env.TMDB_TOKEN);
  let items;
  const id = parseTitleId(q);
  if (id) {   // an IMDb id or link, or a TMDB id or link: exactly that title
    const keys = id.imdb ? await findByImdb(tmdb, id.imdb) : id.kind ? [{ kind: id.kind, tmdb_id: id.tmdb }] : [{ kind: 'movie', tmdb_id: id.tmdb }, { kind: 'tv', tmdb_id: id.tmdb }];
    items = [];
    for (const k of keys.slice(0, 4)) {
      const r = await tmdb.get(`/${k.kind}/${k.tmdb_id}`).catch(() => null);
      if (r?.id && !r.adult) items.push({ ...r, media_type: k.kind });
    }
  } else {
    const d = await tmdb.get('/search/multi', { query: q, include_adult: 'false' });
    items = (d?.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 20);
  }
  const out = [];
  for (const r of items) {
    const kind = r.media_type, date = r.release_date || r.first_air_date || '';
    const mine = userId ? await env.DB.prepare("SELECT status FROM requests WHERE user_id = ? AND kind = ? AND tmdb_id = ? AND yt_id = ''").bind(userId, kind, r.id).first() : null;
    const block = await libraryBlock(env.DB, user, kind, r.id);   // in the library but hidden from this user: don't say it's there
    out.push({ kind, tmdb_id: r.id, title: r.title || r.name, year: date ? Number(date.slice(0, 4)) : null, poster: img(r.poster_path),
      overview: (r.overview || '').slice(0, 300), in_library: !block && await inLibrary(env.DB, kind, r.id), requested: mine?.status || null, age_limit: block === 'above' ? 'above' : null });
  }
  return out;
}

// ---------- automatic download (movies, via YTS) ----------

const sizeBytes = s => { const m = /([\d.]+)\s*(GB|MB)/i.exec(s || ''); return m ? Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1e9 : 1e6) : 0; };

// maxBytes: what fits on the download box; the best release that fits wins (a 720p rather than nothing).
export function pickTorrent(movies, imdb, maxBytes = Infinity) {
  const m = (movies || []).find(x => x.imdb_code === imdb);
  if (!m) return null;
  const quality = { '1080p': 0, '720p': 1, '2160p': 2 };
  const ts = (m.torrents || []).filter(t => t.hash && t.seeds > 0 && t.quality in quality);
  ts.sort((a, b) => quality[a.quality] - quality[b.quality] || (a.type === 'bluray' ? 0 : 1) - (b.type === 'bluray' ? 0 : 1) || b.seeds - a.seeds);
  const fits = ts.find(t => sizeBytes(t.size) <= maxBytes);
  return ts[0] ? { movie: m, torrent: fits || ts[0], fits: !!fits } : null;
}

export async function autoDownload(env, tmdbId) {
  const d = await new Tmdb(env.TMDB_TOKEN).get(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
  const imdb = d?.imdb_id || d?.external_ids?.imdb_id;
  if (!imdb) return { error: 'TMDB has no IMDb id for it, so no automatic download.' };
  const s = await getJson(env, 'cc', `/api/search?q=${encodeURIComponent(imdb)}&source=yts`);
  if (s.error) return { error: 'Couldn’t search for a download (' + s.error + ').' };
  const space = await storage(env);
  const pick = pickTorrent(s.data?.results, imdb, space.box ? (space.box.total - space.box.used - 5e9) / 1.1 : Infinity);
  if (!pick) return { error: 'No download with seeders was found automatically.' };
  const size = sizeBytes(pick.torrent.size);
  if (space.store && space.store.total - space.store.used < size + 50e9) return { error: `${cfg().storageName} is nearly full.` };
  if (!pick.fits) return { error: `The download box doesn’t have room for it right now (${(size / 1e9).toFixed(1)} GB).` };
  const title = `${pick.movie.title} (${pick.movie.year})`;
  const r = await getJson(env, 'cc', `/api/download?url=${encodeURIComponent(pick.torrent.url)}&title=${encodeURIComponent(title)}&quality=${encodeURIComponent(pick.torrent.quality)}`);
  if (r.error) return { error: 'Couldn’t start the download (' + r.error + ').' };
  return { hash: pick.torrent.hash.toLowerCase(), name: `${title} ${pick.torrent.quality} ${pick.torrent.type || ''}`.trim(), size };
}

// ---------- creating and deciding ----------

async function setTitle(db, k, fields, statuses = OPEN) {
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE requests SET ${keys.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE kind = ? AND tmdb_id = ? AND yt_id = ? AND status IN (${statuses.map(() => '?')})`)
    .bind(...keys.map(c => fields[c]), now(), k.kind, k.tmdb_id, k.yt_id, ...statuses).run();
}

export const AUTO_LIST_MAX = 25;   // auto-approve users' playlists up to this many videos; bigger ones go to the owner

async function createPlaylistRequest(env, user, b, listId) {
  const db = env.DB, ytId = 'list:' + listId, k = { kind: 'youtube', tmdb_id: 0, yt_id: ytId };
  if (await yt.inLibrary(db, ytId)) return { status: 409, body: { error: 'That’s already in the library.' } };
  if (await db.prepare("SELECT 1 FROM requests WHERE user_id = ? AND kind = 'youtube' AND yt_id = ?").bind(user.id, ytId).first())
    return { status: 409, body: { error: 'You’ve already asked for that one.' } };
  const open = (await db.prepare(`SELECT count(*) n FROM requests WHERE user_id = ? AND status IN ('pending','approved','sent')`).bind(user.id).first()).n;
  if (open >= MAX_OPEN) return { status: 429, body: { error: `You have ${open} requests waiting. Once some are ready you can ask for more.` } };
  const p = await yt.playlist(env, listId);
  if (p.error) return { status: 502, body: { error: p.error } };
  if (!p.data.entries.length) return { status: 404, body: { error: 'That playlist has no videos that can be downloaded.' } };
  const n = p.data.entries.length;
  const row = { id: randomHex(12), title: `${p.data.title || 'YouTube playlist'} (${n} videos)`.slice(0, 300), year: null, poster: yt.thumbUrl(p.data.entries[0].id) };
  const other = await db.prepare(`SELECT status, reply FROM requests WHERE kind = 'youtube' AND yt_id = ? AND status IN ('approved','sent')`).bind(ytId).first();
  const t = now();
  await db.prepare(`INSERT INTO requests(id, user_id, kind, tmdb_id, yt_id, title, year, poster, note, status, reply, created_at, updated_at) VALUES (?,?,'youtube',0,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, user.id, ytId, row.title, null, row.poster, String(b.note || '').trim().slice(0, 500) || null, other?.status || 'pending', other?.reply || null, t, t).run();
  let auto = null;
  if (!other && user.auto_approve && user.max_age == null) {
    auto = n > AUTO_LIST_MAX ? { error: `It has ${n} videos (automatic downloads stop at ${AUTO_LIST_MAX}).` } : await yt.addPlaylist(env, listId, { by: user.id });
    if (auto.error) await db.prepare('UPDATE requests SET reply = ? WHERE id = ?').bind('Not downloaded automatically: ' + auto.error + ' The owner will look at it.', row.id).run();
    else await setTitle(db, k, { status: 'sent', reply: null });
  }
  await db.prepare('UPDATE requests SET unrated = 1 WHERE id = ?').bind(row.id).run();
  if (!other && (!auto || auto.error)) await notifyOwner(env, user, { ...row, kind: 'youtube', yt_id: ytId, note: b.note, auto_error: auto?.error, channel: p.data.channel, unrated: true });
  return { status: 200, body: { id: row.id, status: auto && !auto.error ? 'sent' : other?.status || 'pending', note: user.max_age != null && !user.allow_unrated ? UNRATED_NOTE : null } };
}

async function createYoutubeRequest(env, user, b) {
  const listId = String(b.yt_id || '').startsWith('list:') ? (/^list:([A-Za-z0-9_-]{10,64})$/.exec(b.yt_id)?.[1] || null) : yt.parsePlaylistUrl(b.url);
  if (listId) return createPlaylistRequest(env, user, b, listId);
  const db = env.DB, id = yt.parseYouTubeUrl(b.yt_id || b.url);
  if (!id) return { status: 400, body: { error: 'Paste a YouTube video link.' } };
  const refused = await ageRefusal(db, user, 'youtube:' + id, null);
  if (refused) return refused;
  const k = { kind: 'youtube', tmdb_id: 0, yt_id: id };
  if (await yt.inLibrary(db, id)) return { status: 409, body: { error: 'That’s already in the library.' } };
  if (await db.prepare("SELECT 1 FROM requests WHERE user_id = ? AND kind = 'youtube' AND yt_id = ?").bind(user.id, id).first())
    return { status: 409, body: { error: 'You’ve already asked for that one.' } };
  const open = (await db.prepare(`SELECT count(*) n FROM requests WHERE user_id = ? AND status IN ('pending','approved','sent')`).bind(user.id).first()).n;
  if (open >= MAX_OPEN) return { status: 429, body: { error: `You have ${open} requests waiting. Once some are ready you can ask for more.` } };
  const info = await yt.lookup(id);
  if (!info) return { status: 404, body: { error: 'YouTube says that video doesn’t exist (or it’s private).' } };
  const row = { id: randomHex(12), title: (info.title || 'YouTube video ' + id).slice(0, 300), year: null, poster: yt.thumbUrl(id) };
  const other = await db.prepare(`SELECT status, reply FROM requests WHERE kind = 'youtube' AND yt_id = ? AND status IN ('approved','sent')`).bind(id).first();
  const t = now();
  await db.prepare(`INSERT INTO requests(id, user_id, kind, tmdb_id, yt_id, title, year, poster, note, status, reply, created_at, updated_at) VALUES (?,?,'youtube',0,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, user.id, id, row.title, null, row.poster, String(b.note || '').trim().slice(0, 500) || null, other?.status || 'pending', other?.reply || null, t, t).run();
  let auto = null;
  // Age-limited users' requests always go to the owner (YouTube videos have no rating).
  if (!other && user.auto_approve && user.max_age == null) {
    auto = await yt.addJob(env, id, { by: user.id, title: info.title, channel: info.channel });
    if (auto.error) await db.prepare('UPDATE requests SET reply = ? WHERE id = ?').bind('Not downloaded automatically: ' + auto.error + ' The owner will look at it.', row.id).run();
    else await setTitle(db, k, { status: 'sent', reply: null });
  }
  const ytAge = (await db.prepare('SELECT age FROM age_overrides WHERE key = ?').bind('youtube:' + id).first())?.age ?? null;
  if (ytAge == null) await db.prepare('UPDATE requests SET unrated = 1 WHERE id = ?').bind(row.id).run();
  if (!other && (!auto || auto.error)) await notifyOwner(env, user, { ...row, kind: 'youtube', yt_id: id, note: b.note, auto_error: auto?.error, channel: info.channel, unrated: ytAge == null });
  const unrated = user.max_age != null && !user.allow_unrated && ytAge == null;
  return { status: 200, body: { id: row.id, status: auto && !auto.error ? 'sent' : other?.status || 'pending', note: unrated ? UNRATED_NOTE : null } };
}

export async function createRequest(env, user, b) {
  if (b.kind === 'youtube') return createYoutubeRequest(env, user, b);
  const db = env.DB, kind = b.kind === 'tv' ? 'tv' : b.kind === 'movie' ? 'movie' : null, tmdbId = Number(b.tmdb_id);
  if (!kind || !Number.isInteger(tmdbId) || tmdbId <= 0) return { status: 400, body: { error: 'Pick a movie or show from the search.' } };
  if (await db.prepare("SELECT 1 FROM requests WHERE user_id = ? AND kind = ? AND tmdb_id = ? AND yt_id = ''").bind(user.id, kind, tmdbId).first())
    return { status: 409, body: { error: 'You’ve already asked for that one.' } };
  const open = (await db.prepare(`SELECT count(*) n FROM requests WHERE user_id = ? AND status IN ('pending','approved','sent')`).bind(user.id).first()).n;
  if (open >= MAX_OPEN) return { status: 429, body: { error: `You have ${open} requests waiting. Once some are ready you can ask for more.` } };
  const d = await new Tmdb(env.TMDB_TOKEN).get(`/${kind}/${tmdbId}`, { append_to_response: kind === 'movie' ? 'release_dates' : 'content_ratings,external_ids' });
  if (!d) return { status: 404, body: { error: 'TMDB doesn’t know that title.' } };
  // Before the library check, so a limited user isn't told that a title hidden from them is there.
  const key = (kind === 'movie' ? 'movie:' : 'series:') + tmdbId, o = await db.prepare('SELECT age FROM age_overrides WHERE key = ?').bind(key).first();
  const age = o ? o.age : ageOf(kind === 'movie' ? pickMovieCert(d.release_dates) : pickTvCert(d.content_ratings));
  let unrated = false;
  if (user.max_age != null) {
    const lib = await libraryBlock(db, user, kind, tmdbId);
    const refused = await ageRefusal(db, user, key, age) || (lib === 'above' ? { status: 403, body: { error: 'That one is above your age limit.', age_limit: 'above' } } : null);
    if (refused) return refused;
    unrated = !user.allow_unrated && (age == null || lib === 'unrated');
  }
  // A hidden unrated title that's already in the library is still a request: the owner can give it an age.
  if (!unrated && await inLibrary(db, kind, tmdbId)) return { status: 409, body: { error: 'That’s already in the library.' } };
  const date = d.release_date || d.first_air_date || '';
  const row = { id: randomHex(12), title: d.title || d.name, year: date ? Number(date.slice(0, 4)) : null, poster: img(d.poster_path) };
  // Someone else already asked: join their request's progress.
  let other = await db.prepare(`SELECT status, reply, torrent_hash, torrent_name FROM requests WHERE kind = ? AND tmdb_id = ? AND yt_id = '' AND status IN ('approved','sent')`).bind(kind, tmdbId).first();
  // Already on the download box (from Find or another route): follow that download instead of starting another.
  let box = null;
  if (!other) {
    box = (await onTheBox(env, kind, tmdbId).catch(() => []))[0] || null;
    if (box) other = { status: 'sent', reply: null, torrent_hash: box.hash, torrent_name: box.name };
  }
  const t = now();
  await db.prepare(`INSERT INTO requests(id, user_id, kind, tmdb_id, title, year, poster, note, status, reply, torrent_hash, torrent_name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id, user.id, kind, tmdbId, row.title, row.year, row.poster, String(b.note || '').trim().slice(0, 500) || null,
      other?.status || 'pending', other?.reply || null, other?.torrent_hash || null, other?.torrent_name || null, t, t).run();
  let auto = null;
  if (!other && user.auto_approve && user.max_age == null && kind === 'movie') {
    auto = await autoDownload(env, tmdbId);
    if (auto.error) await db.prepare('UPDATE requests SET reply = ? WHERE id = ?').bind('Not downloaded automatically: ' + auto.error + ' The owner will look at it.', row.id).run();
    else await setTitle(db, keyOf({ kind, tmdb_id: tmdbId }), { status: 'sent', torrent_hash: auto.hash, torrent_name: auto.name, reply: null });
  }
  const imdb = d.imdb_id || d.external_ids?.imdb_id || null;
  await db.prepare('UPDATE requests SET unrated = ?, imdb_id = ? WHERE id = ?').bind(age == null ? 1 : 0, /^tt\d+$/.test(imdb || '') ? imdb : null, row.id).run();
  if (!other && (!auto || auto.error)) await notifyOwner(env, user, { ...row, kind, note: b.note, auto_error: auto?.error, unrated: age == null });
  return { status: 200, body: { id: row.id, status: auto && !auto.error ? 'sent' : other?.status || 'pending', note: unrated ? UNRATED_NOTE : null } };
}

// A requested title arrived but some of the people who asked can't see it (no age rating, or rated above them).
async function notifyOwnerHidden(env, r, title, users) {
  const owner = String(env.ADMIN_EMAIL_ALLOWLIST || '').split(',')[0].trim();
  if (!owner || !env.EMAIL) return;
  const names = users.map(u => u.display_name || u.username).join(', ');
  const link = cfg().publicUrl + '/admin#users';
  const limited = limitedOf(users);
  const why = limited.length === users.length ? ageHint(limited, true)
    : `${names} can’t see it: it has an age rating above their limit (${users.map(u => `${u.display_name || u.username} ${u.max_age}`).join(', ')}). You can change its age under Users → Age ratings.`;
  await sendEmail(env, { to: owner, subject: `${title} is hidden from ${names}`,
    text: `${title} is in the library. ${why}\n\n${link}\n`,
    html: `<p><b>${esc(title)}</b> is in the library. ${esc(why)}</p><p><a href="${link}">Users → Age ratings</a></p>` });
}

async function notifyOwner(env, user, r) {
  const owner = String(env.ADMIN_EMAIL_ALLOWLIST || '').split(',')[0].trim();
  if (!owner || !env.EMAIL) return;
  const who = user.display_name || user.username;
  const link = cfg().publicUrl + '/admin#requests';
  const hint = r.unrated ? ageHint(limitedOf([user])) : null;
  const ytLink = r.kind !== 'youtube' ? '' : String(r.yt_id).startsWith('list:') ? `\nhttps://www.youtube.com/playlist?list=${r.yt_id.slice(5)}` : `\nhttps://www.youtube.com/watch?v=${r.yt_id || ''}`;
  await sendEmail(env, { to: owner, subject: `Request: ${r.title}${r.year ? ` (${r.year})` : ''}`,
    text: `${who} asked for ${kindWord(r.kind)} ${r.title}${r.year ? ` (${r.year})` : ''}${r.channel ? ` from ${r.channel}` : ''}.${ytLink}${r.note ? `\n\nNote: ${r.note}` : ''}${r.auto_error ? `\n\nAutomatic download didn't happen: ${r.auto_error}` : ''}${hint ? `\n\nAge: ${hint}` : ''}\n\nApprove or decline: ${link}\n`,
    html: `<p>${esc(who)} asked for ${kindWord(r.kind)} <b>${esc(r.title)}${r.year ? ` (${r.year})` : ''}</b>${r.channel ? ` from ${esc(r.channel)}` : ''}.${ytLink ? ` <a href="${esc(ytLink.trim())}">Open on YouTube</a>` : ''}</p>${r.note ? `<p>Note: ${esc(r.note)}</p>` : ''}${r.auto_error ? `<p>Automatic download didn't happen: ${esc(r.auto_error)}</p>` : ''}${hint ? `<p><b>Age:</b> ${esc(hint)}</p>` : ''}<p><a href="${link}">Approve or decline</a></p>` });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function decide(env, b) {
  const db = env.DB, reply = String(b.reply || '').trim().slice(0, 500) || null;
  const k = b.kind === 'youtube' ? keyOf({ kind: 'youtube', yt_id: String(b.yt_id || '') }) : keyOf({ kind: b.kind === 'tv' ? 'tv' : 'movie', tmdb_id: b.tmdb_id });
  const { kind, tmdb_id: tmdbId } = k;
  if (!(await db.prepare(`SELECT 1 FROM requests WHERE kind = ? AND tmdb_id = ? AND yt_id = ? AND status IN ('pending','approved','sent')`).bind(k.kind, k.tmdb_id, k.yt_id).first()))
    return { status: 404, body: { error: 'No open request for that title.' } };
  if (b.action === 'decline') {
    const who = (await db.prepare(`SELECT q.title, q.year, u.email, u.display_name, u.username, u.notify FROM requests q JOIN users u ON u.id = q.user_id
      WHERE q.kind = ? AND q.tmdb_id = ? AND q.yt_id = ? AND q.status IN ('pending','approved','sent') AND u.disabled = 0`).bind(k.kind, k.tmdb_id, k.yt_id).all()).results;
    await setTitle(db, k, { status: 'declined', reply, seen_at: null });   // /me shows a notice until they dismiss it
    for (const u of who) if (u.email && u.notify) {
      const title = u.title + (u.year ? ` (${u.year})` : '');
      await sendEmail(env, { to: u.email, subject: `Your request for ${title} was declined`,
        text: `Hi ${u.display_name || u.username},\n\nYour request for ${title} was declined.${reply ? `\n\nThe owner says: ${reply}` : ''}\n\nYour requests: ${portalUrl(env)}\n`,
        html: `<p>Hi ${esc(u.display_name || u.username)},</p><p>Your request for <b>${esc(title)}</b> was declined.</p>${reply ? `<p>The owner says: ${esc(reply)}</p>` : ''}<p><a href="${portalUrl(env)}">Your requests</a></p>` });
    }
    return { status: 200, body: { ok: true } };
  }
  if (b.action === 'manual') { await setTitle(db, k, { status: 'approved', reply }); return { status: 200, body: { ok: true } }; }
  if (b.action === 'auto' && kind === 'youtube' && k.yt_id.startsWith('list:')) {   // whole playlist into the YouTube library
    const r = await yt.addPlaylist(env, k.yt_id.slice(5), { quality: b.quality });
    if (r.error) return { status: 502, body: { error: r.error } };
    await setTitle(db, k, { status: 'sent', reply });
    return { status: 200, body: { ok: true, name: `${r.added} videos` } };
  }
  if (b.action === 'auto' && kind === 'youtube') {
    const r = await yt.addJob(env, k.yt_id, { quality: b.quality });
    if (r.error) return { status: 502, body: { error: r.error } };
    await setTitle(db, k, { status: 'sent', reply });
    return { status: 200, body: { ok: true } };
  }
  if (b.action === 'auto') {
    if (kind !== 'movie') return { status: 400, body: { error: 'Shows are found by hand (Find tab).' } };
    const box = (await onTheBox(env, kind, tmdbId).catch(() => []))[0];
    if (box) {   // already downloading (or downloaded) on the box: follow it
      await setTitle(db, k, { status: 'sent', torrent_hash: box.hash, torrent_name: box.name, reply });
      return { status: 200, body: { ok: true, name: box.name + ' (already on the download box)' } };
    }
    const r = await autoDownload(env, tmdbId);
    if (r.error) return { status: 502, body: { error: r.error } };
    await setTitle(db, k, { status: 'sent', torrent_hash: r.hash, torrent_name: r.name, reply });
    return { status: 200, body: { ok: true, name: r.name } };
  }
  return { status: 400, body: { error: 'Unknown action' } };
}

// ---------- status ----------

// Live download progress for requests that have a torrent.
async function torrentState(env, rows) {
  const hashes = [...new Set(rows.filter(r => r.status === 'sent' && r.torrent_hash).map(r => r.torrent_hash))];
  if (!hashes.length) return new Map();
  const q = await getJson(env, 'dl', '/api/v2/torrents/info?hashes=' + hashes.join('|'));
  const pushed = new Set((await env.DB.prepare(`SELECT key FROM kv WHERE key IN (${hashes.map(() => '?')})`).bind(...hashes.map(h => 'pushed:' + h)).all()).results.map(r => r.key.slice(7)));
  return new Map((q.data || []).map(t => [t.hash, { progress: t.progress, eta: t.eta, state: t.state, copied: pushed.has(t.hash) }]));
}
async function liveState(env, rows) {
  const live = await torrentState(env, rows);
  const sent = rows.filter(r => r.kind === 'youtube' && r.status === 'sent');
  if (sent.length) await yt.refreshJobs(env).catch(() => {});
  for (const r of sent) if (r.yt_id.startsWith('list:') && !live.has('yt:' + r.yt_id)) {
    const c = await yt.listProgress(env.DB, r.yt_id.slice(5));
    live.set('yt:' + r.yt_id, { status: 'list', label: !c ? 'Downloading' : c.added === c.total ? 'Adding to the library' :
      `${c.added} of ${c.total} in the library` + (c.active ? ` · ${yt.jobLabel(c.active).toLowerCase()}` : '') + (c.failed ? ` · ${c.failed} failed` : '') });
  }
  const ids = [...new Set(sent.filter(r => !r.yt_id.startsWith('list:')).map(r => r.yt_id))];
  if (ids.length) {
    for (const j of (await env.DB.prepare(`SELECT * FROM yt_jobs WHERE video_id IN (${ids.map(() => '?')})`).bind(...ids).all()).results) live.set('yt:' + j.video_id, j);
  }
  return live;
}

export function describe(r, live) {
  if (r.status === 'available') return 'Ready to watch';
  if (r.status === 'declined') return 'Declined';
  if (r.status === 'pending') return 'Waiting for approval';
  if (r.status === 'approved') return 'Approved, being found';
  if (r.kind === 'youtube') { const j = live?.get('yt:' + r.yt_id); return j?.status === 'added' ? 'Adding to the library' : yt.jobLabel(j); }
  const t = live?.get(r.torrent_hash);
  if (!t) return 'Downloading';
  if (t.progress < 1) return `Downloading ${Math.floor(t.progress * 100)}%` + (t.eta > 0 && t.eta < 8640000 ? ` · ${t.eta > 5400 ? Math.round(t.eta / 3600) + ' h' : Math.max(1, Math.round(t.eta / 60)) + ' min'} left` : '');
  return t.copied ? 'Adding to the library' : 'Downloaded, adding to the library soon';
}

const HIDDEN_LABEL = 'In the library, waiting for an age rating';
const HIDDEN_NOTE = 'It has no age rating, so your account doesn’t show it yet. The owner has been told and can give it one.';
/** `user`: the person (or their id). Declined requests they haven't dismissed carry `notice: true`. */
export async function requestsFor(env, user) {
  const db = env.DB, u = typeof user === 'string' ? await db.prepare('SELECT * FROM users WHERE id = ?').bind(user).first() : user;
  const rows = (await db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(u?.id ?? user).all()).results;
  const live = await liveState(env, rows);
  const out = [];
  for (const r of rows) {
    const hidden = r.status === 'available' && (await visibleTo(db, u, keyOf(r))) === false;
    out.push({ id: r.id, kind: r.kind, tmdb_id: r.tmdb_id, yt_id: r.yt_id || null, title: r.title, year: r.year, poster: r.poster, note: r.note, status: r.status,
      label: hidden ? HIDDEN_LABEL : describe(r, live), reply: hidden ? HIDDEN_NOTE : r.reply, hidden: hidden || undefined,
      notice: r.status === 'declined' && !r.seen_at ? true : undefined, created_at: r.created_at, available_at: r.available_at });
  }
  return out;
}
export async function dismissNotice(db, userId, id) {
  await db.prepare("UPDATE requests SET seen_at = ? WHERE id = ? AND user_id = ? AND status = 'declined'").bind(now(), String(id || ''), userId).run();
}

// Owner view: one entry per title, with who asked.
export async function requestsForOwner(env) {
  const db = env.DB;
  const rows = (await db.prepare(`SELECT r.*, u.username, u.display_name, u.max_age, u.allow_unrated FROM requests r JOIN users u ON u.id = r.user_id
    WHERE r.status IN ('pending','approved','sent') OR r.updated_at > ? ORDER BY r.created_at`).bind(now() - 14 * 86400).all()).results;
  const live = await liveState(env, rows);
  const by = new Map();
  for (const r of rows) {
    const k = r.kind + ':' + r.tmdb_id + ':' + r.yt_id;
    if (!by.has(k)) by.set(k, { kind: r.kind, tmdb_id: r.tmdb_id, yt_id: r.yt_id || null, title: r.title, year: r.year, poster: r.poster, status: r.status, label: describe(r, live),
      reply: r.reply, torrent_name: r.torrent_name, imdb_id: r.imdb_id || null, created_at: r.created_at, people: [] });
    const g = by.get(k);
    g.people.push({ name: r.display_name || r.username, note: r.note });
    if (r.unrated) g.unrated = true;
    if (r.imdb_id) g.imdb_id ||= r.imdb_id;
    if (r.status !== 'declined') (g.limited ||= []).push(r);
    if (OPEN.includes(r.status)) { g.status = r.status; g.label = describe(r, live); }
  }
  // Unrated titles asked for by limited people: which age they'd need, until it's rated so they can see it.
  for (const g of by.values()) {
    const ppl = g.unrated && g.status !== 'declined' ? (g.limited || []) : [];
    delete g.limited; delete g.unrated;
    const k = keyOf(g), need = [];
    for (const u of limitedOf(ppl)) {
      const vis = await visibleTo(db, { max_age: u.max_age, allow_unrated: 0 }, k);
      if (vis === true) continue;   // rated now, and they can see it
      if (vis === null) {   // not in the library yet: an age you've already set counts
        const o = await db.prepare('SELECT age FROM age_overrides WHERE key = ?').bind(k.kind === 'youtube' ? 'youtube:' + k.yt_id : (k.kind === 'movie' ? 'movie:' : 'series:') + k.tmdb_id).first();
        if (o?.age != null && o.age <= u.max_age) continue;
      }
      need.push(u);
    }
    if (need.length) g.age_hint = ageHint(need, g.status === 'available');
  }
  const order = { pending: 0, approved: 1, sent: 2, available: 3, declined: 4 };
  return [...by.values()].sort((a, b) => order[a.status] - order[b.status] || b.created_at - a.created_at);
}

// Cron + page loads: anything that has arrived in the library is now available; tell the people who asked.
export async function refreshRequests(env) {
  const db = env.DB;
  const open = (await db.prepare(`SELECT kind, tmdb_id, yt_id, max(title) AS title, max(year) AS year FROM requests WHERE status IN ('pending','approved','sent') GROUP BY kind, tmdb_id, yt_id`).all()).results;
  let n = 0;
  for (const r of open) {
    const k = keyOf(r);
    if (!(await inLib(db, k))) continue;
    if (k.kind === 'youtube' && !k.yt_id.startsWith('list:') && !(await yt.itemFor(db, k.yt_id))) continue;   // on the storage host, not in the catalog yet
    const who = (await db.prepare(`SELECT u.id, u.email, u.display_name, u.username, u.notify, u.max_age, u.allow_unrated FROM requests q JOIN users u ON u.id = q.user_id
      WHERE q.kind = ? AND q.tmdb_id = ? AND q.yt_id = ? AND q.status IN ('pending','approved','sent') AND u.disabled = 0`).bind(k.kind, k.tmdb_id, k.yt_id).all()).results;
    const hidden = [];
    let built = true;
    for (const u of who) { const v = await visibleTo(db, u, k); if (v === null) built = false; else if (!v) hidden.push(u); }
    if (!built) continue;   // files are there but the catalog hasn't caught up: decide (and email) next time
    await setTitle(db, k, { status: 'available', available_at: now() });
    n++;
    const title = r.title + (r.year ? ` (${r.year})` : '');
    if (hidden.length) await notifyOwnerHidden(env, r, title, hidden);
    for (const u of who) if (u.email && u.notify) {
      if (hidden.includes(u)) {
        await sendEmail(env, { to: u.email, subject: `${title} is in the library, waiting for an age rating`,
          text: `Hi ${u.display_name || u.username},\n\n${title}, which you asked for, is now in the library. ${HIDDEN_NOTE}\n\nYour requests: ${portalUrl(env)}\n`,
          html: `<p>Hi ${esc(u.display_name || u.username)},</p><p><b>${esc(title)}</b>, which you asked for, is now in the library. ${esc(HIDDEN_NOTE)}</p><p><a href="${portalUrl(env)}">Your requests</a></p>` });
        continue;
      }
      await sendEmail(env, { to: u.email, subject: `${title} is ready to watch`,
        text: `Hi ${u.display_name || u.username},\n\n${title}, which you asked for, is now in the library. It shows up in your app under ${shelf(r.kind)} (pull to refresh if it isn't there yet).\n\nYour requests: ${portalUrl(env)}\n`,
        html: `<p>Hi ${esc(u.display_name || u.username)},</p><p><b>${esc(title)}</b>, which you asked for, is now in the library. It shows up in your app under ${shelf(r.kind)} (pull to refresh if it isn’t there yet).</p><p><a href="${portalUrl(env)}">Your requests</a></p>` });
    }
  }
  return n;
}
