// Build the denormalized `items` table from files + TMDB metadata.
import { hashId } from './sync.mjs';
import { normTitle } from './parse.mjs';
import { applyAges } from '../ages.mjs';
import { youtubeRows } from '../youtube.mjs';
import { cfg } from '../config.mjs';

const TICKS_PER_MIN = 600_000_000;

export const LIBRARIES = ['movies', 'tv', 'youtube'];
export const VIEW_IDS = {}; // filled lazily: movies/tv/youtube -> 32-hex view id
export async function viewId(library) {
  return VIEW_IDS[library] ||= await hashId('view:' + library);
}
/** The library a view (CollectionFolder) id stands for, or null. */
export async function libraryOfView(id) {
  for (const lib of LIBRARIES) if (await viewId(lib) === id) return lib;
  return null;
}

function sortName(name) {
  return String(name || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^\p{L}\p{N} ]+/gu, '').trim();
}

async function digest(obj) {
  return (await hashId(JSON.stringify(obj))).slice(0, 16);
}

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function personList(json, personIds) {
  return (parse(json) || []).map(p => ({ id: personIds.get(p.id), tmdb: p.id, name: p.name, role: p.role, type: p.type, image: p.image })).filter(p => p.id);
}

// Label that distinguishes several files of the same movie ("Part 2", "Extended", "2160p").
function versionLabel(file, parsed, siblings) {
  if (parsed.part) return `Part ${parsed.part}`;
  const p = file.path.toLowerCase();
  for (const [re, label] of [[/extended/, 'Extended'], [/director'?s.?cut|\bdc\b/, "Director's Cut"], [/unrated/, 'Unrated'], [/theatrical/, 'Theatrical'], [/remaster/, 'Remastered'], [/2160p|\b4k\b|uhd/, '4K'], [/1080p/, '1080p'], [/720p/, '720p']])
    if (re.test(p)) return label;
  return `Version ${siblings.indexOf(file) + 1}`;
}

export async function rebuildItems(db, { initialBuild } = {}) {
  const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
  const files = await q("SELECT * FROM files WHERE kind IN ('movie','episode') AND missing_since IS NULL AND match_status != 'pending'");
  const movies = new Map((await q('SELECT * FROM movies')).map(m => [m.tmdb_id, m]));
  const series = new Map((await q('SELECT * FROM series')).map(s => [s.tmdb_id, s]));
  const eps = new Map((await q('SELECT * FROM episodes')).map(e => [`${e.series_id}:${e.season}:${e.episode}`, e]));
  const subs = new Map();
  for (const s of await q('SELECT * FROM subtitles')) { if (!subs.has(s.file_id)) subs.set(s.file_id, []); subs.get(s.file_id).push(s); }
  const initial = initialBuild ?? Number((await db.prepare("SELECT value FROM kv WHERE key='initial_build'").first())?.value || 0);
  const created = f => (initial && f.added_at > initial + 3600 ? f.added_at : f.mtime || f.added_at);

  // Persons
  const personIds = new Map();
  const personRows = new Map();
  for (const src of [...movies.values(), ...series.values()]) for (const p of parse(src.people) || []) {
    if (!personIds.has(p.id)) { const id = await hashId('person:' + p.id); personIds.set(p.id, id); personRows.set(id, { id, tmdb_id: p.id, name: p.name, image: p.image }); }
  }

  const rows = [];
  const movieView = await viewId('movies'), tvView = await viewId('tv');

  // ---- Movies ----
  const byMovie = new Map();
  for (const f of files.filter(f => f.library === 'movies')) {
    const k = f.movie_id ?? 'file:' + f.id;
    if (!byMovie.has(k)) byMovie.set(k, []);
    byMovie.get(k).push(f);
  }
  for (const group of byMovie.values()) {
    group.sort((a, b) => a.path.localeCompare(b.path));
    for (const f of group) {
      const p = parse(f.parsed) || {};
      const m = f.movie_id ? movies.get(f.movie_id) : null;
      const probe = parse(f.probe);
      let name = m?.title || p.title || f.path.split('/').at(-1);
      if (group.length > 1) name += ` (${versionLabel(f, p, group)})`;
      rows.push({
        id: f.id, type: 'Movie', library: 'movies', parent_id: movieView, series_id: null, season_id: null, series_name: null, season_name: null,
        name, sort_name: sortName(name), original_title: m?.original_title || null,
        year: m?.year || p.year || null, premiere_date: m?.release_date || null, end_date: null, status: null,
        overview: m?.overview || null, tagline: m?.tagline || null, genres: m?.genres || '[]', studios: m?.studios || '[]',
        people: JSON.stringify(personList(m?.people, personIds)), rating: m?.rating || null, official_rating: m?.official_rating || null,
        runtime_ticks: f.duration_ticks || (m?.runtime ? m.runtime * TICKS_PER_MIN : null),
        index_number: null, index_end: null, parent_index: null,
        file_id: f.id, container: probe?.container || f.path.split('.').at(-1).toLowerCase(), size: f.size,
        streams: JSON.stringify(probe?.streams || []), subtitles: JSON.stringify((subs.get(f.id) || []).map(s => ({ root: s.root, path: s.path, language: s.language, forced: s.forced, format: s.format }))),
        images: JSON.stringify({ Primary: m?.poster, Backdrop: m?.backdrop, Logo: m?.logo, Thumb: m?.backdrop }),
        provider_ids: JSON.stringify({ ...(m ? { Tmdb: String(m.tmdb_id) } : {}), ...(m?.imdb_id ? { Imdb: m.imdb_id } : {}) }),
        date_created: created(f), child_count: null, recursive_count: null, versions: null
      });
    }
  }

  // ---- YouTube ----
  const ytMeta = new Map((await q('SELECT * FROM youtube')).map(y => [y.video_id, y]));
  rows.push(...youtubeRows(files.filter(f => f.library === 'youtube'), ytMeta, subs, { view: await viewId('youtube'), sortName, created }));

  // ---- TV ----
  const bySeries = new Map();
  for (const f of files.filter(f => f.library === 'tv')) {
    const k = f.series_key || 'name:' + normTitle(parse(f.parsed)?.series);
    if (!bySeries.has(k)) bySeries.set(k, []);
    bySeries.get(k).push(f);
  }
  for (const [key, group] of bySeries) {
    const tmdbId = key.startsWith('tmdb:') ? +key.slice(5) : null;
    const s = tmdbId ? series.get(tmdbId) : null;
    const p0 = parse(group[0].parsed) || {};
    const seriesId = await hashId('series:' + key);
    const seriesName = s?.title || p0.series || 'Unknown series';
    const seasonsMeta = new Map((parse(s?.seasons) || []).map(x => [x.n, x]));
    const seriesImages = { Primary: s?.poster, Backdrop: s?.backdrop, Logo: s?.logo, Thumb: s?.backdrop };
    const seriesPeople = JSON.stringify(personList(s?.people, personIds));
    const bySeason = new Map();
    for (const f of group) { const n = f.season ?? 1; if (!bySeason.has(n)) bySeason.set(n, []); bySeason.get(n).push(f); }
    let latest = 0;
    for (const [n, sfiles] of bySeason) {
      const seasonId = await hashId(`season:${key}:${n}`);
      const sm = seasonsMeta.get(n);
      const seasonName = n === 0 ? 'Specials' : (sm?.name && !/^season \d+$/i.test(sm.name) ? sm.name : `Season ${n}`);
      sfiles.sort((a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.path.localeCompare(b.path));
      // Same matched episode in several files (e.g. two encodes in two folders): one item, several versions.
      const slot = new Map(), primaries = [];
      const pri = cfg().priority;
      const better = (a, b) => (pri[a.root] ?? 9) - (pri[b.root] ?? 9) || b.size - a.size;
      for (const f of sfiles) {
        if (f.match_status !== 'matched' || f.episode == null) { primaries.push(f); continue; }
        const k = `${f.episode}:${f.episode_end ?? ''}`;
        if (!slot.has(k)) { slot.set(k, [f]); primaries.push(f); } else slot.get(k).push(f);
      }
      const versionsOf = new Map();
      for (const group of slot.values()) {
        if (group.length < 2) continue;
        group.sort(better);
        const i = primaries.indexOf(primaries.find(x => group.includes(x)));
        primaries[i] = group[0];
        versionsOf.set(group[0].id, group.slice(1));
      }
      let seasonLatest = 0;
      for (const f of primaries) {
        const p = parse(f.parsed) || {};
        const e = tmdbId && f.episode != null && f.match_status === 'matched' ? eps.get(`${tmdbId}:${n}:${f.episode}`) : null;
        const alts = (versionsOf.get(f.id) || []).map(v => { const vp = parse(v.probe); return { id: v.id, container: vp?.container || v.path.split('.').at(-1).toLowerCase(), size: v.size, runtime_ticks: v.duration_ticks, streams: vp?.streams || [], label: v.path.split('/').at(-1) }; });
        const probe = parse(f.probe);
        const dc = created(f);
        seasonLatest = Math.max(seasonLatest, dc);
        const name = e?.name || p.epTitle || (f.episode != null ? `Episode ${f.episode}` : f.path.split('/').at(-1));
        rows.push({
          id: f.id, type: 'Episode', library: 'tv', parent_id: seasonId, series_id: seriesId, season_id: seasonId,
          series_name: seriesName, season_name: seasonName,
          name, sort_name: sortName(name), original_title: null,
          year: e?.air_date ? +e.air_date.slice(0, 4) : null, premiere_date: e?.air_date || null, end_date: null, status: null,
          overview: e?.overview || null, tagline: null, genres: s?.genres || '[]', studios: s?.studios || '[]',
          people: '[]', rating: e?.rating || null, official_rating: s?.official_rating || null,
          runtime_ticks: f.duration_ticks || ((e?.runtime || s?.runtime) ? (e?.runtime || s.runtime) * TICKS_PER_MIN : null),
          index_number: f.episode, index_end: f.episode_end, parent_index: n,
          file_id: f.id, container: probe?.container || f.path.split('.').at(-1).toLowerCase(), size: f.size,
          streams: JSON.stringify(probe?.streams || []), subtitles: JSON.stringify((subs.get(f.id) || []).map(s2 => ({ root: s2.root, path: s2.path, language: s2.language, forced: s2.forced, format: s2.format }))),
          images: JSON.stringify({ Primary: e?.still || null, Thumb: e?.still || null }),
          provider_ids: JSON.stringify(tmdbId && e ? { Tmdb: String(tmdbId) } : {}),
          date_created: dc, child_count: null, recursive_count: null, versions: alts.length ? JSON.stringify(alts) : null
        });
      }
      latest = Math.max(latest, seasonLatest);
      rows.push({
        id: seasonId, type: 'Season', library: 'tv', parent_id: seriesId, series_id: seriesId, season_id: null,
        series_name: seriesName, season_name: null, name: seasonName, sort_name: String(n).padStart(4, '0'), original_title: null,
        year: sm?.air ? +sm.air.slice(0, 4) : null, premiere_date: sm?.air || null, end_date: null, status: null,
        overview: sm?.overview || null, tagline: null, genres: s?.genres || '[]', studios: '[]', people: '[]',
        rating: null, official_rating: s?.official_rating || null, runtime_ticks: null,
        index_number: n, index_end: null, parent_index: null, file_id: null, container: null, size: null, streams: null, subtitles: null,
        images: JSON.stringify({ Primary: sm?.poster || null }), provider_ids: '{}',
        date_created: seasonLatest, child_count: primaries.length, recursive_count: primaries.length, versions: null
      });
    }
    rows.push({
      id: seriesId, type: 'Series', library: 'tv', parent_id: tvView, series_id: null, season_id: null, series_name: null, season_name: null,
      name: seriesName, sort_name: sortName(seriesName), original_title: s?.original_title || null,
      year: s?.year || p0.seriesYear || null, premiere_date: s?.first_air || null, end_date: s?.last_air || null, status: s?.status === 'Ended' || s?.status === 'Canceled' ? 'Ended' : s ? 'Continuing' : null,
      overview: s?.overview || null, tagline: null, genres: s?.genres || '[]', studios: s?.studios || '[]', people: seriesPeople,
      rating: s?.rating || null, official_rating: s?.official_rating || null, runtime_ticks: s?.runtime ? s.runtime * TICKS_PER_MIN : null,
      index_number: null, index_end: null, parent_index: null, file_id: null, container: null, size: null, streams: null, subtitles: null,
      images: JSON.stringify(seriesImages),
      provider_ids: JSON.stringify({ ...(s ? { Tmdb: String(s.tmdb_id) } : {}), ...(s?.imdb_id ? { Imdb: s.imdb_id } : {}), ...(s?.tvdb_id ? { Tvdb: String(s.tvdb_id) } : {}) }),
      date_created: latest, child_count: bySeason.size, recursive_count: rows.filter(r => r.series_id === seriesId && r.type === 'Episode').length, versions: null
    });
  }

  // ---- Diff-upsert ----
  for (const r of rows) r.hash = await digest(r);
  const existing = new Map((await q('SELECT id, hash FROM items')).map(r => [r.id, r.hash]));
  const cols = Object.keys(rows[0] || {});
  const stmts = [];
  const want = new Set();
  for (const r of rows) {
    want.add(r.id);
    if (existing.get(r.id) === r.hash) continue;
    stmts.push(db.prepare(`INSERT OR REPLACE INTO items(${cols}) VALUES (${cols.map(() => '?')})`).bind(...cols.map(c => r[c] ?? null)));
  }
  let removed = 0;
  for (const id of existing.keys()) if (!want.has(id)) { stmts.push(db.prepare('DELETE FROM items WHERE id=?').bind(id)); removed++; }
  const existingPersons = new Set((await q('SELECT id FROM persons')).map(r => r.id));
  for (const p of personRows.values()) if (!existingPersons.has(p.id))
    stmts.push(db.prepare('INSERT OR REPLACE INTO persons(id,tmdb_id,name,image) VALUES (?,?,?,?)').bind(p.id, p.tmdb_id, p.name, p.image));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  const ages = await applyAges(db);   // rewritten rows lose their age; until this runs they're hidden from age-limited users
  return { items: rows.length, written: stmts.length - removed, removed, ages };
}
