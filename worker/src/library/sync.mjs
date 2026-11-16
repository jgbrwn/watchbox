// Library sync: listing diff -> parse -> TMDB match -> probe.
// Works against any D1-compatible db (Cloudflare D1 or tools/local-db.mjs).
import { parseFile, splitExt, VIDEO_EXT, SUB_EXT, normTitle } from './parse.mjs';
import { findMovie, findSeries, mapEpisode, similarity } from './match.mjs';
import { movieRow, seriesRow, BudgetExhausted } from './tmdb.mjs';
import { probeFile } from './probe.mjs';
import { parseYoutubePath, matchYoutube } from '../youtube.mjs';
import { cfg } from '../config.mjs';

// Library roots (folders on the storage host) come from config: root id -> library (movies | tv | youtube).

export async function hashId(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

const now = () => Math.floor(Date.now() / 1000);

async function runBatches(db, stmts, size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

export async function log(db, step, detail) {
  await db.prepare('INSERT INTO sync_log(at, step, detail) VALUES (?,?,?)').bind(now(), step, typeof detail === 'string' ? detail : JSON.stringify(detail)).run();
}

export function matchKeyFor(library, parsed) {
  if (library === 'youtube') return parsed.ytid ? `yt:${parsed.ytid}` : `ytfile:${normTitle(parsed.title)}`;
  if (library === 'movies') return `movie:${normTitle(parsed.title)}:${parsed.year || ''}`;
  return `tv:${normTitle(parsed.series)}:${parsed.seriesYear || ''}`;
}

// Subtitle language/forced flags from "Movie.en.forced.srt" style names.
function subtitleInfo(videoBase, subBase) {
  const tail = subBase.slice(videoBase.length).toLowerCase().split(/[._ -]+/).filter(Boolean);
  const forced = tail.includes('forced') ? 1 : 0;
  const lang = tail.find(t => /^[a-z]{2,3}$/.test(t) && !['sdh', 'cc', 'hi'].includes(t)) || null;
  return { language: lang, forced };
}

/**
 * Apply an origin listing ({roots:{id:count}, files:[[root, path, size, mtime, inode]]}).
 * Returns counts. Refuses to mark files missing when a root shrank suspiciously.
 */
export async function applyListing(db, listing, { registry = null, maxShrink = 0.2 } = {}) {
  const t = now();
  const ROOTS = cfg().libraryOf, ROOT_PRIORITY = cfg().priority;
  const prevCounts = JSON.parse((await db.prepare("SELECT value FROM kv WHERE key='root_counts'").first())?.value || '{}');
  for (const [root, count] of Object.entries(listing.roots || {})) {
    if (!ROOTS[root]) continue;
    const prev = prevCounts[root];
    if (prev && count < prev * (1 - maxShrink)) throw new Error(`root ${root} shrank ${prev} -> ${count}; refusing to apply`);
  }
  for (const root of Object.keys(ROOTS)) if (!(root in (listing.roots || {}))) throw new Error(`listing missing root ${root}`);

  const known = new Map(); // root\0path -> file_id
  for (const r of (await db.prepare('SELECT root, path, file_id FROM file_paths').all()).results) known.set(r.root + '\0' + r.path, r.file_id);
  const byInode = new Map();
  const fileRows = new Map();
  for (const r of (await db.prepare('SELECT id, root, path, size, mtime, inode, missing_since FROM files').all()).results) {
    fileRows.set(r.id, r);
    if (r.inode) byInode.set(r.inode + ':' + r.size, r.id);
  }

  const videos = [], subs = [];
  for (const f of listing.files) {
    const [root, path] = f;
    if (!ROOTS[root]) continue;
    const ext = splitExt(path.split('/').at(-1))[1];
    if (VIDEO_EXT.has(ext)) videos.push(f); else if (SUB_EXT.has(ext)) subs.push(f);
  }
  videos.sort((a, b) => ROOT_PRIORITY[a[0]] - ROOT_PRIORITY[b[0]]);

  const stmts = [], seen = new Set(), counts = { added: 0, changed: 0, aliases: 0, missing: 0, restored: 0 };
  const pathToFile = new Map();
  for (const [root, path, size, mtime, inode] of videos) {
    const k = root + '\0' + path;
    let id = known.get(k);
    if (!id && inode) id = byInode.get(inode + ':' + size);
    if (id && fileRows.has(id)) {
      const row = fileRows.get(id);
      if (!known.has(k)) { counts.aliases++; stmts.push(db.prepare('INSERT OR REPLACE INTO file_paths(root,path,file_id,last_seen) VALUES (?,?,?,?)').bind(root, path, id, t)); }
      if (row.root === root && row.path === path && (row.size !== size || row.mtime !== mtime)) {
        counts.changed++;
        stmts.push(db.prepare('UPDATE files SET size=?, mtime=?, inode=?, duration_ticks=NULL, probe=NULL, probed_at=NULL, probe_error=NULL WHERE id=?').bind(size, mtime, inode, id));
        row.size = size; row.mtime = mtime;
      }
    } else {
      const library = ROOTS[root];
      id = registry?.get(k) || await hashId(`${root}/${path}`);
      if (fileRows.has(id)) { // registry id already taken by a sibling alias
        stmts.push(db.prepare('INSERT OR REPLACE INTO file_paths(root,path,file_id,last_seen) VALUES (?,?,?,?)').bind(root, path, id, t));
        counts.aliases++;
      } else {
        const parsed = library === 'youtube' ? parseYoutubePath(path) : parseFile(library === 'tv' ? 'tv' : 'movie', path, size);
        const kind = parsed.kind;
        stmts.push(db.prepare(`INSERT INTO files(id, root, path, library, kind, size, mtime, inode, parsed, match_key, match_status, added_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, root, path, library, kind, size, mtime, inode, JSON.stringify(parsed),
          matchKeyFor(library, parsed), kind === 'movie' || kind === 'episode' ? 'pending' : 'skipped', t));
        stmts.push(db.prepare('INSERT OR REPLACE INTO file_paths(root,path,file_id,last_seen) VALUES (?,?,?,?)').bind(root, path, id, t));
        fileRows.set(id, { id, root, path, size, mtime, inode, missing_since: null });
        if (inode) byInode.set(inode + ':' + size, id);
        counts.added++;
      }
    }
    seen.add(id);
    pathToFile.set(k, id);
  }
  // Seen-bookkeeping for unchanged paths in one statement per batch is cheap enough at this scale.
  for (const [root, path] of videos) stmts.push(db.prepare('UPDATE file_paths SET last_seen=? WHERE root=? AND path=?').bind(t, root, path));
  // If a file was moved (e.g. downloads/complete -> media, same inode), stream from where it is now.
  const seenPaths = new Map();
  for (const [root, path] of videos) { const id = pathToFile.get(root + '\0' + path); if (id && !seenPaths.has(id)) seenPaths.set(id, [root, path]); }
  for (const [id, row] of fileRows) {
    const now = seenPaths.get(id);
    if (now && !pathToFile.has(row.root + '\0' + row.path) ) {
      stmts.push(db.prepare('UPDATE files SET root=?, path=? WHERE id=?').bind(now[0], now[1], id));
      counts.moved = (counts.moved || 0) + 1;
    }
  }
  stmts.push(db.prepare('DELETE FROM file_paths WHERE last_seen < ?').bind(t));
  for (const [id, row] of fileRows) {
    if (!seen.has(id) && row.missing_since == null) { counts.missing++; stmts.push(db.prepare('UPDATE files SET missing_since=? WHERE id=?').bind(t, id)); }
    if (seen.has(id) && row.missing_since != null) { counts.restored++; stmts.push(db.prepare('UPDATE files SET missing_since=NULL, deleted_at=NULL WHERE id=?').bind(id)); }
  }
  // Subtitles: attach to the video in the same folder whose name prefixes the subtitle name,
  // or the only video in that folder (or its parent, for "Subs/" folders).
  const dirVideos = new Map();
  for (const [root, path] of videos) {
    const dir = root + '/' + path.split('/').slice(0, -1).join('/');
    if (!dirVideos.has(dir)) dirVideos.set(dir, []);
    dirVideos.get(dir).push({ base: splitExt(path.split('/').at(-1))[0], id: pathToFile.get(root + '\0' + path) });
  }
  stmts.push(db.prepare('DELETE FROM subtitles'));
  let subCount = 0;
  for (const [root, path] of subs) {
    const parts = path.split('/');
    const [subBase, format] = splitExt(parts.at(-1));
    let dir = root + '/' + parts.slice(0, -1).join('/');
    let list = dirVideos.get(dir);
    if (!list && /^subs?$/i.test(parts.at(-2) || '')) list = dirVideos.get(root + '/' + parts.slice(0, -2).join('/'));
    if (!list) continue;
    const hit = list.find(v => subBase.toLowerCase().startsWith(v.base.toLowerCase())) || (list.length === 1 ? list[0] : null);
    if (!hit) continue;
    const info = subtitleInfo(hit.base, subBase.toLowerCase().startsWith(hit.base.toLowerCase()) ? subBase : hit.base + '.' + subBase);
    stmts.push(db.prepare('INSERT OR REPLACE INTO subtitles(root,path,file_id,language,forced,format) VALUES (?,?,?,?,?,?)').bind(root, path, hit.id, info.language, info.forced, format));
    subCount++;
  }
  await runBatches(db, stmts);
  const rootCounts = {};
  for (const r of Object.keys(ROOTS)) rootCounts[r] = listing.roots[r];
  await db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('root_counts',?)").bind(JSON.stringify(rootCounts)).run();
  await db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('last_scan',?)").bind(String(t)).run();
  counts.subtitles = subCount;
  return counts;
}

// ---------------- Matching ----------------

/** Upsert manual overrides ({key: tmdbId|null}) and re-queue files whose match changed. */
export async function applyOverrides(db, overrides) {
  const stmts = [];
  for (const [key, id] of Object.entries(overrides)) {
    if (key.startsWith('_')) continue;
    const cur = await db.prepare('SELECT tmdb_id, manual FROM lookups WHERE key=?').bind(key).first();
    if (cur && cur.manual && cur.tmdb_id === id) continue;
    stmts.push(db.prepare("INSERT OR REPLACE INTO lookups(key,kind,tmdb_id,note,manual,at) VALUES (?,?,?,'manual override',1,?)").bind(key, key.startsWith('tv:') ? 'tv' : 'movie', id, now()));
    stmts.push(db.prepare("UPDATE files SET match_status='pending' WHERE match_key=? AND kind IN ('movie','episode')").bind(key));
  }
  if (stmts.length) await runBatches(db, stmts);
  return stmts.length / 2;
}

async function ensureMovie(db, tmdb, id) {
  if (await db.prepare('SELECT 1 FROM movies WHERE tmdb_id=?').bind(id).first()) return;
  const d = await tmdb.movie(id);
  if (!d) return;
  const r = movieRow(d);
  const cols = Object.keys(r);
  await db.prepare(`INSERT OR REPLACE INTO movies(${cols}) VALUES (${cols.map(() => '?')})`).bind(...cols.map(c => r[c])).run();
}

async function ensureSeries(db, tmdb, id) {
  const have = await db.prepare('SELECT seasons, updated_at FROM series WHERE tmdb_id=?').bind(id).first();
  if (have && now() - have.updated_at < 7 * 86400) return JSON.parse(have.seasons || '[]');
  const d = await tmdb.tv(id);
  if (!d) return [];
  const r = seriesRow(d);
  const cols = Object.keys(r);
  const stmts = [db.prepare(`INSERT OR REPLACE INTO series(${cols}) VALUES (${cols.map(() => '?')})`).bind(...cols.map(c => r[c]))];
  for (const s of d.seasons || []) {
    const sd = await tmdb.season(id, s.season_number);
    for (const e of sd?.episodes || [])
      stmts.push(db.prepare(`INSERT OR REPLACE INTO episodes(series_id,season,episode,name,overview,still,air_date,runtime,rating) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id, e.season_number, e.episode_number, e.name || null, e.overview || null, e.still_path || null, e.air_date || null, e.runtime || null, e.vote_average || null));
  }
  await runBatches(db, stmts);
  return JSON.parse(r.seasons);
}

async function lookup(db, key) {
  return db.prepare('SELECT tmdb_id, note, manual FROM lookups WHERE key=?').bind(key).first();
}
async function saveLookup(db, key, kind, id, note) {
  await db.prepare('INSERT INTO lookups(key,kind,tmdb_id,note,manual,at) VALUES (?,?,?,?,0,?) ON CONFLICT(key) DO UPDATE SET tmdb_id=excluded.tmdb_id, note=excluded.note, at=excluded.at WHERE lookups.manual=0')
    .bind(key, kind, id, note, now()).run();
}

/** Match pending files. Bounded by `limit` files and the tmdb client's call budget.
 *  YouTube files are "matched" from their .info.json sidecar, read with fetchText(root, path) (null = no sidecar). */
export async function matchPending(db, tmdb, { limit = 200, concurrency = 4, fetchText = null } = {}) {
  const rows = (await db.prepare("SELECT id, library, parsed, match_key FROM files WHERE match_status IN ('pending','retry') AND missing_since IS NULL ORDER BY added_at DESC LIMIT ?").bind(limit).all()).results;
  const stats = { movies: 0, episodes: 0, unmatched: 0, youtube: 0 };
  const yt = rows.filter(r => r.library === 'youtube');
  if (yt.length && fetchText) {
    const full = (await db.prepare(`SELECT id, root, path, parsed FROM files WHERE id IN (${yt.map(() => '?')})`).bind(...yt.map(r => r.id)).all()).results;
    const r = await matchYoutube(db, full, fetchText);
    stats.youtube = r.matched; stats.unmatched += r.unmatched;
  }
  const groups = new Map();
  for (const r of rows.filter(r => r.library !== 'youtube')) { if (!groups.has(r.match_key)) groups.set(r.match_key, []); groups.get(r.match_key).push(r); }
  const queue = [...groups.entries()];
  async function worker() {
    while (queue.length) {
      const [key, files] = queue.shift();
      try {
        if (files[0].library === 'movies') await matchMovieGroup(db, tmdb, key, files, stats);
        else await matchSeriesGroup(db, tmdb, key, files, stats);
      } catch (e) {
        if (e instanceof BudgetExhausted) { queue.length = 0; return; }
        await log(db, 'match-error', `${key}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}

async function matchMovieGroup(db, tmdb, key, files, stats) {
  const parsed = JSON.parse(files[0].parsed);
  let hit = await lookup(db, key);
  if (!hit) {
    const r = await findMovie(tmdb, parsed);
    await saveLookup(db, key, 'movie', r.id, r.note);
    hit = { tmdb_id: r.id, note: r.note };
  }
  if (hit.tmdb_id) await ensureMovie(db, tmdb, hit.tmdb_id);
  const status = hit.tmdb_id ? 'matched' : 'unmatched';
  await runBatches(db, files.map(f => db.prepare("UPDATE files SET match_status=?, movie_id=?, match_note=? WHERE id=? AND match_status IN ('pending','retry')").bind(status, hit.tmdb_id, hit.note, f.id)));
  stats[hit.tmdb_id ? 'movies' : 'unmatched'] += files.length;
}

async function matchSeriesGroup(db, tmdb, key, files, stats) {
  const parsed0 = JSON.parse(files[0].parsed);
  let hit = await lookup(db, key);
  if (!hit) {
    const coords = files.map(f => JSON.parse(f.parsed));
    const r = await findSeries(tmdb, parsed0.series, parsed0.seriesYear, coords);
    await saveLookup(db, key, 'tv', r.id, r.note);
    hit = { tmdb_id: r.id, note: r.note };
  }
  let episodes = [];
  if (hit.tmdb_id) {
    await ensureSeries(db, tmdb, hit.tmdb_id);
    episodes = (await db.prepare('SELECT season, episode, name FROM episodes WHERE series_id=?').bind(hit.tmdb_id).all()).results;
  }
  const seriesKey = hit.tmdb_id ? `tmdb:${hit.tmdb_id}` : `name:${normTitle(parsed0.series)}`;
  // Map every file of the series (including already-matched ones) so slot collisions can be resolved.
  const all = (await db.prepare("SELECT id, parsed, match_status FROM files WHERE match_key=? AND kind='episode' AND missing_since IS NULL").bind(key).all()).results;
  const mapped = all.map(f => {
    const p = JSON.parse(f.parsed);
    const m = episodes.length ? mapEpisode(p, episodes) : null;
    return { f, p, m, season: m?.season ?? p.season ?? (p.absolute != null ? 1 : null), episode: m?.episode ?? p.episode ?? p.absolute ?? null,
      status: hit.tmdb_id && m && !m.how.endsWith('unknown') ? 'matched' : 'unmatched', how: m?.how || 'no-episode-map' };
  });
  // Two files claiming one TMDB episode: if their own titles disagree, the weaker (number-only) claim
  // keeps its numbers but loses the TMDB identity. Same-title duplicates stay (merged as versions later).
  const slots = new Map();
  for (const x of mapped) if (x.status === 'matched') { const k = x.season + ':' + x.episode; if (!slots.has(k)) slots.set(k, []); slots.get(k).push(x); }
  const rank = h => h.startsWith('title') ? 0 : h === 'absolute' ? 1 : h === 'number' ? 2 : 3;
  for (const group of slots.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => rank(a.how) - rank(b.how));
    const winner = group[0];
    for (const x of group.slice(1)) {
      const same = (!x.p.epTitle && !winner.p.epTitle) || similarity(x.p.epTitle || '', winner.p.epTitle || '') >= 0.6;
      if (!same) { x.status = 'unmatched'; x.how += ' collision'; x.season = x.p.season ?? x.season; x.episode = x.p.episode ?? x.p.absolute ?? x.episode; }
    }
  }
  const stmts = [];
  const pendingIds = new Set(files.map(f => f.id));
  for (const x of mapped) {
    stmts.push(db.prepare("UPDATE files SET match_status=?, series_key=?, season=?, episode=?, episode_end=?, match_note=? WHERE id=? AND match_status != 'manual'")
      .bind(x.status, seriesKey, x.season, x.episode, x.p.episodeEnd, `${hit.note || ''} ${x.how}`.trim(), x.f.id));
    if (pendingIds.has(x.f.id)) stats[x.status === 'matched' ? 'episodes' : 'unmatched']++;
  }
  await runBatches(db, stmts);
}

// ---------------- Probing ----------------

export async function probePending(db, origin, { limit = 25, concurrency = 4 } = {}) {
  const rows = (await db.prepare("SELECT id, root, path, size FROM files WHERE probed_at IS NULL AND kind IN ('movie','episode') AND missing_since IS NULL ORDER BY added_at DESC LIMIT ?").bind(limit).all()).results;
  let ok = 0, failed = 0;
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        const info = await probeFile(origin.reader(r.root, r.path, r.size), splitExt(r.path)[1]);
        await db.prepare('UPDATE files SET duration_ticks=?, probe=?, probed_at=?, probe_error=NULL WHERE id=?')
          .bind(info.durationTicks || null, JSON.stringify(info), now(), r.id).run();
        ok++;
      } catch (e) {
        await db.prepare('UPDATE files SET probed_at=?, probe_error=? WHERE id=?').bind(now(), String(e.message).slice(0, 200), r.id).run();
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok, failed };
}
