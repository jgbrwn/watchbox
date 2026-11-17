// Duplicate checks: is a title already in the library, or already on the download box?
// Used in three places:
//   - Find (c-cli, proxied by tools.mjs): search results get a "library_note" before you download,
//   - auto-send (pipeline.mjs): a finished download of something you already have isn't sent automatically,
//   - requests (requests.mjs): asking for something that is already downloading joins that download.
// Never blocks anything by hand: a duplicate can be an upgrade.
import { parseMovie, parseEpisode, VIDEO_EXT } from './library/parse.mjs';
import { matchKeyFor, lookup, saveLookup } from './library/sync.mjs';
import { findMovie, findSeries } from './library/match.mjs';
import { Tmdb } from './library/tmdb.mjs';
import { guessKind, getJson, kvGet, kvSet } from './pipeline.mjs';

/** "1080p" etc. from a probed file's video stream (by width, so 1920x800 scope films still count as 1080p). */
export function quality(probe) {
  let v;
  try { v = (JSON.parse(probe || 'null')?.streams || []).find(s => s.type === 'Video'); } catch { return null; }
  const w = v?.width || 0, h = v?.height || 0;
  if (!w && !h) return null;
  if (w >= 3200 || h >= 1800) return '2160p';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  return 'SD';
}
const RANK = { SD: 0, '720p': 1, '1080p': 2, '2160p': 3 };
const best = qs => qs.filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] || null;

/** What the library has of a movie or show (by TMDB id). */
export async function haveTitle(db, kind, tmdbId) {
  if (kind === 'movie') {
    const rows = (await db.prepare("SELECT path, probe FROM files WHERE movie_id = ? AND kind = 'movie' AND missing_since IS NULL").bind(tmdbId).all()).results;
    return { files: rows.length, quality: best(rows.map(r => quality(r.probe))), paths: rows.map(r => r.path) };
  }
  const rows = (await db.prepare("SELECT season, episode, episode_end, probe FROM files WHERE series_key = ? AND kind = 'episode' AND missing_since IS NULL").bind('tmdb:' + tmdbId).all()).results;
  const eps = new Set();
  for (const r of rows) for (let e = r.episode; e != null && e <= (r.episode_end || r.episode); e++) eps.add(r.season + ':' + e);
  const seasons = [...new Set(rows.map(r => r.season).filter(s => s != null))].sort((a, b) => a - b);
  return { files: rows.length, episodes: eps, seasons, quality: best(rows.map(r => quality(r.probe))) };
}

const ranges = ns => {   // [1,2,3,5] -> "1–3, 5"
  const out = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(i === j ? String(ns[i]) : `${ns[i]}–${ns[j]}`);
    i = j;
  }
  return out.join(', ');
};
export function haveNote(kind, have) {
  if (!have?.files) return null;
  if (kind === 'movie') return 'In library' + (have.quality ? ' · ' + have.quality : '') + (have.files > 1 ? ` · ${have.files} versions` : '');
  return 'In library · ' + (have.seasons.length ? (have.seasons.length > 1 ? 'seasons ' : 'season ') + ranges(have.seasons) : `${have.files} episodes`) + (have.quality ? ' · ' + have.quality : '');
}

/** Which movie or show a release name is (the library sync's own parser and matcher; results are shared via `lookups`). */
export async function identifyRelease(env, name, kind = guessKind(name)) {
  const db = env.DB, tmdb = new Tmdb(env.TMDB_TOKEN, { budget: 25 });
  const rel = `${name}/${name}.mkv`;
  if (kind === 'movie') {
    const parsed = parseMovie(rel, 1e9);
    if (!parsed?.title) return null;
    const key = matchKeyFor('movies', parsed);
    let hit = await lookup(db, key);
    if (!hit) { const r = await findMovie(tmdb, parsed); await saveLookup(db, key, 'movie', r.id, r.note); hit = { tmdb_id: r.id }; }
    return hit.tmdb_id ? { kind: 'movie', tmdb_id: hit.tmdb_id } : null;
  }
  const parsed = parseEpisode(rel, 1e9);
  if (!parsed?.series) return null;
  const key = matchKeyFor('tv', parsed);
  let hit = await lookup(db, key);
  if (!hit) { const r = await findSeries(tmdb, parsed.series, parsed.seriesYear, []); await saveLookup(db, key, 'tv', r.id, r.note); hit = { tmdb_id: r.id }; }
  return hit.tmdb_id ? { kind: 'tv', tmdb_id: hit.tmdb_id } : null;
}

/** identifyRelease for a qBittorrent torrent, plus its IMDb id; cached per torrent in kv `ident:<hash>`. */
export async function identifyTorrent(env, t, budget = null) {
  const key = 'ident:' + t.hash;
  const cached = await kvGet(env.DB, key);
  if (cached) return cached.tmdb_id ? cached : null;
  if (budget) { if (budget.left <= 0) return null; budget.left--; }   // limit TMDB work per page load
  let id = null;
  try {
    id = await identifyRelease(env, t.name);
    if (id) {
      const tmdb = new Tmdb(env.TMDB_TOKEN, { budget: 2 });
      const d = id.kind === 'movie' ? await tmdb.get(`/movie/${id.tmdb_id}`) : await tmdb.get(`/tv/${id.tmdb_id}/external_ids`);
      id.imdb_id = d?.imdb_id || null;
    }
  } catch { return null; }   // TMDB trouble: try again next time
  await kvSet(env.DB, key, id || { tmdb_id: null });
  return id;
}

/** Torrents on the box that are this title (newest first), with their progress. */
export async function onTheBox(env, kind, tmdbId) {
  const q = await getJson(env, 'dl', '/api/v2/torrents/info?sort=added_on&reverse=true');
  if (q.error || !Array.isArray(q.data)) return [];
  const out = [];
  const budget = { left: 8 };
  for (const t of q.data.slice(0, 60)) {
    const id = await identifyTorrent(env, t, budget);
    if (id && id.kind === kind && id.tmdb_id === tmdbId) out.push(t);
  }
  return out;
}

/** Auto-send check for a finished torrent. `all`: everything in it is already in the library. */
export async function duplicateCheck(env, t, name) {
  const id = await identifyTorrent(env, { hash: t.hash, name });
  if (!id) return null;
  const have = await haveTitle(env.DB, id.kind, id.tmdb_id);
  if (!have.files) return null;
  const title = (await env.DB.prepare(`SELECT title, year FROM ${id.kind === 'movie' ? 'movies' : 'series'} WHERE tmdb_id = ?`).bind(id.tmdb_id).first()) || {};
  const label = title.title ? `${title.title}${title.year ? ` (${title.year})` : ''}` : null;
  if (id.kind === 'movie') return { kind: 'movie', tmdb_id: id.tmdb_id, title: label, all: true, note: haveNote('movie', have) };
  const files = await getJson(env, 'dl', `/api/v2/torrents/files?hash=${t.hash}`);
  const eps = [];
  for (const f of files.data || []) {
    if (!VIDEO_EXT.has(String(f.name).split('.').pop().toLowerCase())) continue;
    const p = parseEpisode(f.name, f.size);
    if (p?.season != null && p?.episode != null) for (let e = p.episode; e <= (p.episodeEnd || p.episode); e++) eps.push(p.season + ':' + e);
  }
  if (!eps.length) return { kind: 'tv', tmdb_id: id.tmdb_id, title: label, all: false, note: haveNote('tv', have) + ' · couldn’t tell which episodes this has' };
  const already = eps.filter(e => have.episodes.has(e)).length;
  return { kind: 'tv', tmdb_id: id.tmdb_id, title: label, all: already === eps.length, have: already, of: eps.length,
    note: already === eps.length ? `All ${eps.length} episodes already in library` + (have.quality ? ' · ' + have.quality : '') : already ? `${already} of ${eps.length} episodes already in library` : null };
}

// ---------- Find (c-cli) ----------

/** Adds `library_note` / `library_state` ("have" | "downloading") to c-cli's JSON for /api/search, /api/movie/<id>, /api/omdb. */
export async function annotateFind(env, path, data) {
  const db = env.DB;
  const targets = [];   // [object, imdb id]
  const add = (o, imdb) => { if (o && /^tt\d+$/.test(imdb || '')) targets.push([o, imdb]); };
  if (path.startsWith('/api/search') && Array.isArray(data?.results)) for (const r of data.results) add(r, r.imdb_code || r.omdb?.imdbID);
  else if (path.startsWith('/api/movie/')) add(data, data?.imdb_code);
  else if (path.startsWith('/api/omdb')) add(data, data?.imdbID);
  if (!targets.length) return data;
  const ids = [...new Set(targets.map(t => t[1]))];
  const marks = (ids.map(() => '?')).join(',');
  const known = new Map();
  for (const r of (await db.prepare(`SELECT tmdb_id, imdb_id FROM movies WHERE imdb_id IN (${marks})`).bind(...ids).all()).results) known.set(r.imdb_id, { kind: 'movie', tmdb_id: r.tmdb_id });
  for (const r of (await db.prepare(`SELECT tmdb_id, imdb_id FROM series WHERE imdb_id IN (${marks})`).bind(...ids).all()).results) if (!known.has(r.imdb_id)) known.set(r.imdb_id, { kind: 'tv', tmdb_id: r.tmdb_id });
  const notes = new Map();
  for (const [imdb, k] of known) {
    const note = haveNote(k.kind, await haveTitle(db, k.kind, k.tmdb_id));
    if (note) notes.set(imdb, { library_note: note, library_state: 'have' });
  }
  // On the box already (downloading, or finished and not sent yet)?
  const q = await getJson(env, 'dl', '/api/v2/torrents/info?sort=added_on&reverse=true');
  if (Array.isArray(q.data)) {
    const budget = { left: 4 };   // new torrents are identified a few at a time; later searches see the rest
    for (const t of q.data.slice(0, 60)) {
      const id = await identifyTorrent(env, t, budget);
      if (!id?.imdb_id || !ids.includes(id.imdb_id)) continue;
      const busy = t.progress < 1 ? `Downloading now (${Math.floor(t.progress * 100)}%)` : 'Already on the download box';
      const cur = notes.get(id.imdb_id);
      notes.set(id.imdb_id, cur ? { ...cur, library_note: cur.library_note + ' · ' + busy.toLowerCase() } : { library_note: busy, library_state: 'downloading' });
    }
  }
  for (const [o, imdb] of targets) { const n = notes.get(imdb); if (n) Object.assign(o, n); }
  return data;
}
