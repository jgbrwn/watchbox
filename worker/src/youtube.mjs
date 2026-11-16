// YouTube videos in the library.
//
// Adding: the owner pastes a link in /admin → Pipeline (or approves a guest's YouTube request; auto-approve users'
// requests start straight away). The Worker asks watch-stream on the download box (/__watchstream/yt/*) to fetch it.
// The box downloads with yt-dlp, writes "<channel>/<title> [<id>].mp4" plus sidecars (.info.json metadata, .jpg
// thumbnail, .poster.jpg, .en.srt) and rsyncs them to the storage host media/youtube/, then pokes /hooks/youtube. The Worker
// mirrors the box's job list in yt_jobs (the cron and the admin page poll it too), runs the library sync, which reads
// each new video's sidecar into the `youtube` table, and the catalog puts it in a "YouTube" library.
// Nothing is deleted on the storage host here; videos are removed from the Manage tab like any other file.
import { getJson } from './pipeline.mjs';
import { originUrl, originHeaders } from './origin.mjs';

const now = () => Math.floor(Date.now() / 1000);
import { cfg } from './config.mjs';
export const ytRoot = () => cfg().primary.youtube;      // where YouTube-library videos are saved
const tvRoot = () => cfg().primary.tv;                  // where playlist episodes are saved
export const QUALITIES = ['720', '1080', '2160'];
const ACTIVE = ['waiting', 'queued', 'downloading', 'processing', 'uploading', 'copied'];
const ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id from any common YouTube link (watch, youtu.be, shorts, live, embed, music, m.), or a bare id. */
export function parseYouTubeUrl(s) {
  s = String(s || '').trim();
  if (ID.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(?:shorts|live|embed|v|e)\/([^/?#]+)/.exec(u.pathname); id = m?.[1]; }
  }
  return id && ID.test(id) ? id : null;
}

const LIST = /^[A-Za-z0-9_-]{10,64}$/;
/** The playlist id from a youtube.com/playlist?list=… link (watch?v=…&list=… is treated as the single video). */
export function parsePlaylistUrl(s) {
  s = String(s || '').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' || u.pathname !== '/playlist') return null;
  const id = u.searchParams.get('list');
  return id && LIST.test(id) && !/^RD/.test(id) ? id : null;   // RD…: endless auto-generated mixes
}

// ---------- playlists as TV episodes ----------

/** Season/episode from a video title ("S01E09", "Season 1 Episode 9", "1x09", "Episode 9"), else the playlist position. */
export function detectEpisode(title, index, listTitle = '') {
  const t = String(title || '');
  const listSeason = Number(/\b(?:season|series)\s*(\d{1,2})\b/i.exec(listTitle)?.[1]) || null;
  const pats = [/\bS(\d{1,2})\s?[ ._-]?\s?E(\d{1,3})\b/i, /\b(?:Season|Series)\s*(\d{1,2})\W{0,4}(?:Episode|Ep\.?)\s*(\d{1,3})\b/i, /\b(\d{1,2})x(\d{2,3})\b/];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) return { season: +m[1], episode: +m[2], title: epTitle(t.slice(m.index + m[0].length)), how: 'title' };
  }
  const m = /\b(?:Episode|Ep\.?)\s*(\d{1,3})\b/i.exec(t);
  if (m) return { season: listSeason || 1, episode: +m[1], title: epTitle(t.slice(m.index + m[0].length)), how: 'title' };
  return { season: listSeason || 1, episode: index + 1, title: t.trim() || null, how: 'position' };
}
const epTitle = rest => rest.replace(/^[\s|:\-–—.,]+/, '').replace(/\s*[|(\[].*$/, '').trim() || null;

/** "Outrageous Fortune Season 1 Episodes" → "Outrageous Fortune". */
export function guessShow(listTitle, entries = []) {
  let t = String(listTitle || '').replace(/\b(?:season|series)\s*\d+.*$/i, '').replace(/\b(?:full\s+)?episodes?\b|\bplaylist\b/gi, '').replace(/[\s|:\-–—]+$/, '').trim();
  if (!t && entries[0]) t = String(entries[0].title).replace(/\b(?:season|series|S\d{1,2}E\d|episode)\b.*$/i, '').replace(/[\s|:\-–—]+$/, '').trim();
  return t || null;
}

// Same rules as clean() in yt.go (the box re-checks the name with them).
function cleanName(s, maxBytes) {
  s = String(s || '').replace(/[\/\\\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[:*?"<>|]/g, '-').split(/\s+/).filter(Boolean).join(' ');
  const enc = new TextEncoder();
  while (enc.encode(s).length > maxBytes) s = s.slice(0, -1);
  s = s.replace(/^[ .]+|[ .]+$/g, '');
  return s || 'untitled';
}
const pad2 = n => String(n).padStart(2, '0');
/** "<Show>/Season 01/<Show> - S01E09 - <title> [<id>]" (no extension): where an episode is saved under media/tvshows. */
export function episodeName(show, season, episode, title, id) {
  const sh = cleanName(show, 100);
  const file = cleanName(`${sh} - S${pad2(season)}E${pad2(episode)}${title ? ' - ' + title : ''}`, 150) + ` [${id}]`;
  return `${sh}/Season ${pad2(season)}/${file}`;
}

/** "Channel/Title [id].mp4" → { title, ytid } (library parse for files under media/youtube). */
export function parseYoutubePath(path) {
  const name = path.split('/').at(-1).replace(/\.[^.]+$/, '');
  const m = /^(.*?)\s*\[([A-Za-z0-9_-]{11})\]$/.exec(name);
  return { kind: 'movie', title: (m ? m[1] : name).trim() || name, ytid: m ? m[2] : null, channel: path.includes('/') ? path.split('/')[0] : null };
}

export const thumbUrl = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const base = path => path.replace(/\.[^./]+$/, '');
export const sidecars = path => ({ info: base(path) + '.info.json', thumb: base(path) + '.jpg', poster: base(path) + '.poster.jpg' });

/** Title and channel from YouTube's oEmbed (no API key). null if YouTube doesn't know the id. */
export async function lookup(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) return { title: null, channel: null, embeddable: r.status !== 401 && r.status !== 403 };   // 401/403: embedding off; it may still download
    const d = await r.json();
    return { title: d.title || null, channel: d.author_name || null, embeddable: true };
  } catch { return { title: null, channel: null }; }
}

// A video is "in the library" in the YouTube library (by id) or as a TV episode (file name ends in "[<id>].ext").
// A playlist ('list:<id>') is in once every video that was added from it is.
export async function inLibrary(db, id) {
  if (String(id).startsWith('list:')) return listDone(db, id.slice(5));
  return !!(await db.prepare(`SELECT 1 FROM files WHERE missing_since IS NULL AND ((library = 'youtube' AND match_key = ?) OR (library = 'tv' AND instr(path, ?) > 0)) LIMIT 1`)
    .bind('yt:' + id, `[${id}].`).first());
}
export async function itemFor(db, id) {
  const f = await db.prepare(`SELECT id FROM files WHERE missing_since IS NULL AND match_status != 'pending' AND ((library = 'youtube' AND match_key = ?) OR (library = 'tv' AND instr(path, ?) > 0)) LIMIT 1`)
    .bind('yt:' + id, `[${id}].`).first();
  if (!f) return null;
  return (await db.prepare(`SELECT id FROM items WHERE file_id = ? OR versions LIKE ? LIMIT 1`).bind(f.id, `%"id":"${f.id}"%`).first())?.id || null;
}
async function listDone(db, listId) {
  const l = await db.prepare('SELECT video_ids FROM yt_lists WHERE list_id = ?').bind(listId).first();
  if (!l) return false;
  for (const v of JSON.parse(l.video_ids)) if (!(await itemFor(db, v))) return false;
  return true;
}
export async function listProgress(db, listId) {
  const l = await db.prepare('SELECT video_ids FROM yt_lists WHERE list_id = ?').bind(listId).first();
  if (!l) return null;
  const ids = JSON.parse(l.video_ids);
  const jobs = new Map((await db.prepare(`SELECT video_id, status, progress, error FROM yt_jobs WHERE list_id = ?`).bind(listId).all()).results.map(j => [j.video_id, j]));
  const c = { total: ids.length, added: 0, failed: 0, active: null };
  for (const v of ids) { const j = jobs.get(v); if (j?.status === 'added') c.added++; else if (j?.status === 'failed') c.failed++; else if (j && !c.active && j.status !== 'waiting' && j.status !== 'queued') c.active = j; }
  return c;
}

// ---------- library: sidecar metadata (called by the sync's matching step) ----------

/** Reads "<name>.info.json" for each pending YouTube file into `youtube`. fetchText(root, path) → text | null (404). */
export async function matchYoutube(db, files, fetchText) {
  let matched = 0, unmatched = 0;
  for (const f of files) {
    const p = JSON.parse(f.parsed || '{}');
    let info = null;
    try { const t = await fetchText(f.root, sidecars(f.path).info); info = t ? JSON.parse(t) : null; } catch {}
    const id = info?.id && ID.test(info.id) ? info.id : p.ytid;
    if (info && id) {
      const d = String(info.upload_date || '');
      await db.prepare(`INSERT OR REPLACE INTO youtube(video_id, title, channel, channel_id, upload_date, description, duration, age_limit, categories, tags, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, String(info.title || p.title).slice(0, 500), info.channel || info.uploader || p.channel || null, info.channel_id || null,
        /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null, String(info.description || '').slice(0, 5000) || null,
        Number.isFinite(info.duration) ? Math.round(info.duration) : null, Number.isFinite(info.age_limit) ? info.age_limit : null,
        JSON.stringify(Array.isArray(info.categories) ? info.categories.slice(0, 5) : []), JSON.stringify(Array.isArray(info.tags) ? info.tags.slice(0, 30) : []), now()).run();
    }
    // Without a sidecar the video still shows up, titled from its file name; the daily retry looks again.
    await db.prepare("UPDATE files SET match_status = ?, match_note = ? WHERE id = ? AND match_status IN ('pending','retry')")
      .bind(info ? 'matched' : 'unmatched', info ? 'youtube sidecar' : 'no .info.json sidecar', f.id).run();
    info ? matched++ : unmatched++;
  }
  return { matched, unmatched };
}

export const originText = (env, fetchImpl = fetch) => async (root, path) => {
  const r = await fetchImpl(originUrl(env, root, path), { headers: originHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`origin HTTP ${r.status}`);
  return r.text();
};

/** items rows for the YouTube library (one Movie per video file). */
export function youtubeRows(files, meta, subs, ctx) {
  const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const rows = [];
  for (const f of files) {
    const p = parse(f.parsed) || {};
    const m = p.ytid ? meta.get(p.ytid) : null;
    const probe = parse(f.probe);
    const name = m?.title || p.title || f.path.split('/').at(-1);
    const sc = sidecars(f.path);
    const img = m ? { Primary: `origin:${f.root}/${sc.poster}`, Backdrop: `origin:${f.root}/${sc.thumb}`, Thumb: `origin:${f.root}/${sc.thumb}` } : {};
    rows.push({
      id: f.id, type: 'Movie', library: 'youtube', parent_id: ctx.view, series_id: null, season_id: null, series_name: null, season_name: null,
      name, sort_name: ctx.sortName(name), original_title: null,
      year: m?.upload_date ? +m.upload_date.slice(0, 4) : null, premiere_date: m?.upload_date || null, end_date: null, status: null,
      overview: m?.description || null, tagline: m?.channel ? `${m.channel} on YouTube` : null, genres: m?.categories || '[]',
      studios: JSON.stringify(m?.channel || p.channel ? [m?.channel || p.channel] : []),
      people: '[]', rating: null, official_rating: m?.age_limit >= 18 ? '18' : null,
      runtime_ticks: f.duration_ticks || (m?.duration ? m.duration * 10_000_000 : null),
      index_number: null, index_end: null, parent_index: null,
      file_id: f.id, container: probe?.container || f.path.split('.').at(-1).toLowerCase(), size: f.size,
      streams: JSON.stringify(probe?.streams || []), subtitles: JSON.stringify((subs.get(f.id) || []).map(s => ({ root: s.root, path: s.path, language: s.language, forced: s.forced, format: s.format }))),
      images: JSON.stringify(img),
      provider_ids: JSON.stringify(p.ytid ? { YouTube: p.ytid } : {}),
      date_created: ctx.created(f), child_count: null, recursive_count: null, versions: null
    });
  }
  return rows;
}

// ---------- download jobs ----------

const boxJob = j => ({ id: j.video_id, quality: String(j.quality || '1080'), ...(j.dest === 'tv' ? { dest: 'tv', name: j.name } : {}) });
const box = (env, path, body) => getJson(env, 'dl', '/__watchstream/yt' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);

/** Queues a download (idempotent while one is active). by: user id, or null for the owner. */
export async function addJob(env, id, { quality = '1080', by = null, title = null, channel = null, dest = 'youtube', name = null, list = null } = {}) {
  if (!ID.test(id)) return { error: 'Not a YouTube video id.' };
  if (!QUALITIES.includes(String(quality))) quality = '1080';
  const db = env.DB, t = now();
  const cur = await db.prepare('SELECT * FROM yt_jobs WHERE video_id = ?').bind(id).first();
  if (cur && ACTIVE.includes(cur.status)) return { job: cur };
  if (dest !== 'tv') { dest = 'youtube'; name = null; }
  await db.prepare(`INSERT INTO yt_jobs(video_id, quality, status, progress, error, title, channel, added_by, created_at, updated_at, dest, name, list_id)
    VALUES (?,?,'waiting',0,NULL,?,?,?,?,?,?,?,?) ON CONFLICT(video_id) DO UPDATE SET quality = excluded.quality, status = 'waiting', progress = 0, error = NULL,
    title = COALESCE(excluded.title, yt_jobs.title), channel = COALESCE(excluded.channel, yt_jobs.channel), updated_at = excluded.updated_at, finished_at = NULL,
    dest = excluded.dest, name = excluded.name, list_id = COALESCE(excluded.list_id, yt_jobs.list_id), path = NULL, size = NULL`)
    .bind(id, String(quality), title, channel, by, t, t, dest, name, list).run();
  const r = await box(env, '/add', boxJob({ video_id: id, quality, dest, name }));
  if (r.error) await db.prepare('UPDATE yt_jobs SET error = ? WHERE video_id = ?').bind(`The download box didn’t answer (${r.error}); it will be retried.`, id).run();
  else await db.prepare("UPDATE yt_jobs SET status = 'queued', error = NULL WHERE video_id = ?").bind(id).run();
  return { job: await db.prepare('SELECT * FROM yt_jobs WHERE video_id = ?').bind(id).first() };
}

/** Mirrors the box's job list into yt_jobs; hands over waiting jobs; marks copied videos that reached the library.
 *  Returns { copied } (how many newly landed on the storage host, i.e. a sync is due). */
export async function refreshJobs(env) {
  const db = env.DB;
  const open = (await db.prepare(`SELECT * FROM yt_jobs WHERE status IN (${ACTIVE.map(() => '?')})`).bind(...ACTIVE).all()).results;
  if (!open.length) return { copied: 0 };
  const r = await box(env, '/jobs');
  const byId = new Map((r.data?.jobs || []).map(j => [j.id, j]));
  let copied = 0;
  const t = now();
  for (const row of open) {
    if (row.status === 'copied') {
      if (await itemFor(db, row.video_id)) await db.prepare("UPDATE yt_jobs SET status = 'added', finished_at = ?, updated_at = ? WHERE video_id = ?").bind(t, t, row.video_id).run();
      continue;
    }
    if (r.error) continue;
    const j = byId.get(row.video_id);
    if (!j) {   // never reached the box, or the box lost it: (re)send
      const a = await box(env, '/add', boxJob(row));
      if (!a.error) await db.prepare("UPDATE yt_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE video_id = ?").bind(t, row.video_id).run();
      continue;
    }
    const status = j.status === 'done' ? 'copied' : j.status;
    if (status === 'copied' && row.status !== 'copied') copied++;
    await db.prepare(`UPDATE yt_jobs SET status = ?, progress = ?, error = ?, title = COALESCE(?, title), channel = COALESCE(?, channel), path = COALESCE(?, path),
      size = COALESCE(?, size), updated_at = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END WHERE video_id = ?`)
      .bind(status, j.progress || 0, j.error || null, j.title || null, j.channel || null, j.path || null, j.size || null, t, status, t, row.video_id).run();
  }
  return { copied };
}

/** After the box finished something: sync the library if a video landed, then mark it added. */
export async function afterBox(env) {
  const r = await refreshJobs(env);
  if (r.copied) {
    const { runSync } = await import('./cron.mjs');
    await runSync(env, { force: true });
    await refreshJobs(env);
    const { refreshRequests } = await import('./requests.mjs');
    await refreshRequests(env);
  }
  return r;
}

export function jobLabel(j) {
  if (!j) return 'Downloading';
  switch (j.status) {
    case 'waiting': return 'Waiting for the download box';
    case 'queued': return 'Queued';
    case 'downloading': return `Downloading ${Math.floor((j.progress || 0) * 100)}%`;
    case 'processing': return 'Preparing';
    case 'uploading': return 'Copying to the library';
    case 'copied': return 'Adding to the library';
    case 'added': return 'In the library';
    case 'failed': return 'Failed: ' + (j.error || 'unknown error');
    case 'list': return j.label;
  }
  return j.status;
}

export async function listJobs(env) {
  const rows = (await env.DB.prepare(`SELECT j.*, COALESCE(u.display_name, u.username) AS by_name FROM yt_jobs j LEFT JOIN users u ON u.id = j.added_by
    ORDER BY CASE WHEN j.status IN ('added','failed') THEN 1 ELSE 0 END, j.updated_at DESC LIMIT 200`).all()).results;
  const out = [];
  for (const j of rows) out.push({ id: j.video_id, title: j.title, channel: j.channel, quality: j.quality, status: j.status, label: jobLabel(j), progress: j.progress,
    error: j.error, size: j.size, dest: j.dest, episode: j.dest === 'tv' ? (/ - (S\d+E\d+)/.exec(j.name || '')?.[1] || null) : null, show: j.dest === 'tv' ? (j.name || '').split('/')[0] : null, by: j.added_by ? j.by_name || 'deleted user' : null, created_at: j.created_at, updated_at: j.updated_at,
    item: j.status === 'added' ? await itemFor(env.DB, j.video_id) : null, thumb: thumbUrl(j.video_id) });
  return out;
}

// ---------- playlists ----------

/** The playlist's videos (from the box, cached 1 hour), with what's already in the library. */
export async function playlist(env, listId, { fresh = false } = {}) {
  const db = env.DB, key = 'ytlist:' + listId;
  let d = null;
  const c = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  if (c && !fresh) { const v = JSON.parse(c.value); if (now() - v.at < 3600) d = v.data; }
  if (!d) {
    const r = await box(env, '/playlist?list=' + encodeURIComponent(listId));
    if (r.error) return { error: r.status === 502 ? 'YouTube didn’t return that playlist (private, or not found).' : 'The download box didn’t answer (' + r.error + ').' };
    d = r.data;
    await db.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').bind(key, JSON.stringify({ at: now(), data: d })).run();
  }
  return { data: d };
}

/** Preview for the admin page: each video with a detected season/episode, and the matching show in the library. */
export async function previewPlaylist(env, listId) {
  const p = await playlist(env, listId, { fresh: true });
  if (p.error) return p;
  const db = env.DB, d = p.data;
  const show = guessShow(d.title, d.entries);
  const series = show ? await db.prepare("SELECT id, name, child_count FROM items WHERE type = 'Series' AND lower(name) = lower(?) LIMIT 1").bind(show).first() : null;
  const have = new Map();
  if (series) for (const e of (await db.prepare("SELECT parent_index s, index_number e, container, streams, versions FROM items WHERE type = 'Episode' AND series_id = ?").bind(series.id).all()).results) {
    const v = JSON.parse(e.streams || '[]').find(x => x.type === 'Video');
    have.set(`${e.s}:${e.e}`, `${v?.height ? v.height + 'p ' : ''}${e.container || ''}`.trim() + (e.versions ? ' (+ more)' : ''));
  }
  const jobs = new Map((await db.prepare('SELECT video_id, status FROM yt_jobs').all()).results.map(j => [j.video_id, j.status]));
  const entries = [];
  for (const [i, e] of d.entries.entries()) {
    const ep = detectEpisode(e.title, i, d.title);
    entries.push({ id: e.id, title: e.title, duration: e.duration, ...ep, in_library: await inLibrary(db, e.id), job: jobs.get(e.id) || null,
      existing: have.get(`${ep.season}:${ep.episode}`) || null });
  }
  entries.sort((a, b) => a.how === 'title' && b.how === 'title' ? a.season - b.season || a.episode - b.episode : 0);
  return { data: { id: listId, title: d.title, channel: d.channel, show, series: series ? { id: series.id, name: series.name, seasons: series.child_count } : null, entries } };
}

/** Adds the chosen videos of a playlist. dest 'youtube' or 'tv' (items need season/episode, show needs a name). */
export async function addPlaylist(env, listId, { dest = 'youtube', show = null, quality = '1080', items = null, by = null } = {}) {
  const p = await playlist(env, listId);
  if (p.error) return p;
  const d = p.data, known = new Map(d.entries.map((e, i) => [e.id, { ...e, i }]));
  const want = items ? items.filter(x => known.has(x?.id)) : d.entries.map(e => ({ id: e.id }));
  if (!want.length) return { error: 'Pick at least one video.' };
  if (dest === 'tv') {
    show = String(show || '').trim();
    if (!show) return { error: 'Give the show a name (as it’s called on TMDB).' };
    for (const x of want) {
      const auto = detectEpisode(known.get(x.id).title, known.get(x.id).i, d.title);
      x.season = Number.isInteger(+x.season) && +x.season >= 0 && +x.season <= 99 ? +x.season : auto.season;
      x.episode = Number.isInteger(+x.episode) && +x.episode >= 1 && +x.episode <= 999 ? +x.episode : auto.episode;
      x.name = episodeName(show, x.season, x.episode, x.title === undefined ? auto.title : String(x.title || '').slice(0, 120) || null, x.id);
    }
    const slots = new Set();
    for (const x of want) { const k = x.season + ':' + x.episode; if (slots.has(k)) return { error: `Two videos are set to S${pad2(x.season)}E${pad2(x.episode)}.` }; slots.add(k); }
  }
  let added = 0;
  for (const x of want) {
    const e = known.get(x.id);
    const r = await addJob(env, x.id, { quality, by, title: e.title, channel: e.channel || d.channel, dest, name: x.name || null, list: listId });
    if (!r.error) added++;
  }
  const t = now(), db = env.DB;
  const prev = await db.prepare('SELECT video_ids FROM yt_lists WHERE list_id = ?').bind(listId).first();
  const ids = [...new Set([...(prev ? JSON.parse(prev.video_ids) : []), ...want.map(x => x.id)])];
  await db.prepare(`INSERT INTO yt_lists(list_id, title, channel, video_ids, dest, show, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(list_id) DO UPDATE SET video_ids = excluded.video_ids, dest = excluded.dest, show = excluded.show, updated_at = excluded.updated_at`)
    .bind(listId, d.title || null, d.channel || null, JSON.stringify(ids), dest, dest === 'tv' ? show : null, t, t).run();
  // Anyone who asked for this playlist: it's on its way.
  await db.prepare("UPDATE requests SET status = 'sent', updated_at = ? WHERE kind = 'youtube' AND yt_id = ? AND status IN ('pending','approved')").bind(t, 'list:' + listId).run();
  return { added, total: want.length };
}

// ---------- /admin/api/youtube* ----------

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleYoutubeAdmin(request, env, ctx, path) {
  const db = env.DB;
  if (path === '/admin/api/youtube/playlist' && request.method === 'GET') {
    const id = parsePlaylistUrl(new URL(request.url).searchParams.get('url'));
    if (!id) return json({ error: 'That isn’t a YouTube playlist link.' }, 400);
    const r = await previewPlaylist(env, id);
    return r.error ? json({ error: r.error }, 502) : json(r.data);
  }
  if (path === '/admin/api/youtube' && request.method === 'GET') {
    await refreshJobs(env).catch(() => {});
    const b = await box(env, '/jobs');
    return json({ jobs: await listJobs(env), box: b.error ? { error: b.error } : { free_gb: b.data.free_gb, min_free_gb: b.data.min_free_gb, ytdlp: b.data.ytdlp_updated } });
  }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/admin/api/youtube/add-list') {
    const id = parsePlaylistUrl(body.url) || (LIST.test(String(body.list || '')) ? String(body.list) : null);
    if (!id) return json({ error: 'That isn’t a YouTube playlist link.' }, 400);
    const r = await addPlaylist(env, id, { dest: body.dest === 'tv' ? 'tv' : 'youtube', show: body.show, quality: QUALITIES.includes(String(body.quality)) ? String(body.quality) : '1080', items: Array.isArray(body.items) ? body.items.slice(0, 300) : null });
    return r.error ? json({ error: r.error }, 400) : json({ ok: true, ...r });
  }
  if (path === '/admin/api/youtube/add') {
    if (parsePlaylistUrl(body.url)) return json({ error: 'That’s a playlist: preview it first.', playlist: true }, 400);
    const id = parseYouTubeUrl(body.url);
    if (!id) return json({ error: 'That isn’t a YouTube video link.' }, 400);
    const item = await itemFor(db, id);
    if (item && !body.again) return json({ error: 'That video is already in the library.', item }, 409);
    const info = await lookup(id);
    if (!info) return json({ error: 'YouTube says that video doesn’t exist (or it’s private).' }, 404);
    const r = await addJob(env, id, { quality: body.quality, title: info.title, channel: info.channel });
    return r.error ? json({ error: r.error }, 400) : json({ ok: true, id, title: info.title });
  }
  const id = String(body.id || '');
  if (!ID.test(id)) return json({ error: 'bad id' }, 400);
  if (path === '/admin/api/youtube/retry') {
    const j = await db.prepare('SELECT quality FROM yt_jobs WHERE video_id = ?').bind(id).first();
    const r = await addJob(env, id, { quality: body.quality || j?.quality || '1080' });
    return r.error ? json({ error: r.error }, 400) : json({ ok: true });
  }
  if (path === '/admin/api/youtube/cancel') {
    const r = await box(env, '/cancel', { id });
    await db.prepare("UPDATE yt_jobs SET status = 'failed', error = 'cancelled', updated_at = ? WHERE video_id = ? AND status IN ('waiting','queued','downloading','processing')").bind(now(), id).run();
    return r.error && r.status !== 404 ? json({ error: r.error }, 502) : json({ ok: true });
  }
  if (path === '/admin/api/youtube/forget') {
    await box(env, '/forget', { id });
    await db.prepare("DELETE FROM yt_jobs WHERE video_id = ? AND status IN ('added','failed')").bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

// The box's "job finished" poke (signed like the qBittorrent hook).
export async function handleYoutubeHook(request, env, ctx) {
  const { verifySigned } = await import('./pipeline.mjs');
  const v = await verifySigned(request, env, 'X-Watch-Signature');
  if (v.res) return v.res;
  ctx.waitUntil(afterBox(env).catch(e => console.error('youtube hook', e.message)));
  return json({ ok: true });
}
