// Matching parsed files to TMDB entities.
import { normTitle } from './parse.mjs';

// Character-bigram Dice similarity on normalized titles (0..1).
export function similarity(a, b) {
  a = normTitle(a); b = normTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b); let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

const yearOf = s => (s ? +String(s).slice(0, 4) : null);

function scoreCandidate(c, title, year, kind) {
  const names = kind === 'movie' ? [c.title, c.original_title] : [c.name, c.original_name];
  const sim = Math.max(...names.filter(Boolean).map(n => similarity(n, title)));
  const cy = yearOf(kind === 'movie' ? c.release_date : c.first_air_date);
  const yd = year && cy ? Math.abs(cy - year) : null;
  // "The King of Kong" vs "The King of Kong: A Fistful of Quarters", or "Rolling Stones Gimme Shelter" vs "Gimme Shelter".
  const nt = normTitle(title);
  const prefix = names.filter(Boolean).some(n => { const nn = normTitle(n); return (nt.length >= 6 && nn.startsWith(nt)) || (nn.length >= 8 && nt.endsWith(nn)); });
  let score = sim * 100 + (prefix ? 10 : 0);
  if (yd !== null) score -= Math.min(yd, 10) * 8;
  else if (year) score -= 5;
  score += Math.min(Math.log10((c.popularity || 0) + 1) * 4, 8);
  score += Math.min((c.vote_count || 0) / 200, 4);
  return { c, sim, yd, score, prefix };
}

function accept(best, year) {
  if (!best) return false;
  if (best.sim === 1 && best.yd !== null && best.yd <= 3) return true;
  if (best.prefix && best.yd === 0) return true;
  if (best.sim >= 0.9 && (best.yd === null ? !year : best.yd <= 1)) return true;
  if (best.sim >= 0.75 && best.yd !== null && best.yd === 0) return true;
  if (best.sim === 1 && !year) return true;
  return false;
}

// Search TMDB for a movie given parsed {title, year, alts}. Returns {id, note} or null.
export async function findMovie(tmdb, parsed) {
  const tried = new Set();
  const queries = [];
  for (const a of [{ title: parsed.title, year: parsed.year }, ...(parsed.alts || [])]) {
    if (!a.title) continue;
    const year = a.year || parsed.year || null;
    queries.push({ title: a.title, year });
    // "Director - Title" / "Title - English Title" pieces
    if (year) for (const piece of a.title.split(/\s+[-–]\s+/)) if (piece !== a.title && piece.length > 2) queries.push({ title: piece, year });
  }
  let best = null;
  for (const q of queries) {
    for (const yr of q.year ? [q.year, null] : [null]) {
      const key = normTitle(q.title) + ':' + yr;
      if (tried.has(key)) continue;
      tried.add(key);
      const res = await tmdb.searchMovie(q.title, yr);
      for (const c of res?.results || []) {
        const s = scoreCandidate(c, q.title, q.year, 'movie');
        if (!best || s.score > best.score) best = s;
      }
      if (accept(best, q.year)) return { id: best.c.id, note: `sim=${best.sim.toFixed(2)} yd=${best.yd}` };
    }
  }
  // Retry once with a shortened title (subtitle after ':' or ' - ' dropped).
  const short = parsed.title.split(/\s+[-–:]\s+|:\s*/)[0];
  if (parsed.year && short && short !== parsed.title && short.length > 2) {
    const res = await tmdb.searchMovie(short, parsed.year);
    for (const c of res?.results || []) {
      const s = scoreCandidate(c, short, parsed.year, 'movie');
      if (!best || s.score > best.score) best = s;
    }
    if (accept(best, parsed.year)) return { id: best.c.id, note: `short sim=${best.sim.toFixed(2)} yd=${best.yd}` };
  }
  return best ? { id: null, note: `best "${best.c.title}" (${yearOf(best.c.release_date)}) sim=${best.sim.toFixed(2)} yd=${best.yd}` } : { id: null, note: 'no results' };
}

const COUNTRY = { au: 'AU', us: 'US', uk: 'GB', nz: 'NZ', ca: 'CA' };

// Among several same-name candidates, prefer the one whose seasons contain the files' coordinates.
export async function pickByCoverage(tmdb, candidates, coords, year) {
  let best = null;
  for (const c of candidates.slice(0, 4)) {
    const d = await tmdb.tv(c.id);
    const counts = new Map((d?.seasons || []).map(s => [s.season_number, s.episode_count]));
    let covered = 0;
    for (const { season, episode, absolute } of coords) {
      if (season != null && episode != null && (counts.get(season) || 0) >= episode) covered++;
      else if (absolute != null && [...counts].filter(([n]) => n > 0).reduce((a, [, n]) => a + n, 0) >= absolute) covered++;
    }
    const fy = d?.first_air_date ? +d.first_air_date.slice(0, 4) : null;
    const score = covered * 10 - (year && fy ? Math.min(Math.abs(fy - year), 20) : 0) + (c.popularity || 0) / 100;
    if (!best || score > best.score) best = { id: c.id, score, covered };
  }
  return best;
}

export async function findSeries(tmdb, name, year, coords = []) {
  const variants = [name];
  const m = /^(.*?)\s+(au|us|uk|nz|ca)$/i.exec(name);
  if (m) variants.push(m[1]);
  const noParen = name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (noParen !== name) variants.push(noParen);
  if (/\s+-\s+/.test(name)) variants.push(name.replace(/\s+-\s+/g, ' '), name.split(/\s+-\s+/)[0]);
  let best = null;
  for (const v of [...new Set(variants)]) {
    for (const yr of year ? [year, null] : [null]) {
      const res = await tmdb.searchTv(v, yr);
      for (const c of res?.results || []) {
        const s = scoreCandidate(c, v, year, 'tv');
        if (m && COUNTRY[m[2].toLowerCase()] && (c.origin_country || []).includes(COUNTRY[m[2].toLowerCase()])) s.score += 15, s.sim = Math.max(s.sim, 0.9);
        if (!best || s.score > best.score) best = s;
      }
      if (best && best.sim >= 0.85 && (best.yd === null || best.yd <= 1)) {
        // Same-name ambiguity (e.g. "Crash", "Millennium") without a year: decide by season/episode coverage.
        const same = (res?.results || []).filter(c => similarity(c.name, v) >= 0.95 || similarity(c.original_name, v) >= 0.95);
        if (!year && same.length > 1 && coords.length) {
          const pick = await pickByCoverage(tmdb, same, coords, year);
          if (pick) return { id: pick.id, note: `coverage ${pick.covered}/${coords.length} of ${same.length} same-name` };
        }
        return { id: best.c.id, note: `sim=${best.sim.toFixed(2)}` };
      }
    }
  }
  if (best && best.sim >= 0.7) return { id: best.c.id, note: `weak sim=${best.sim.toFixed(2)}` };
  return { id: null, note: best ? `best "${best.c.name}" sim=${best.sim.toFixed(2)}` : 'no results' };
}

// Map an episode file onto TMDB coordinates using the series' episode list.
// episodes: [{season, episode, name}] across all seasons (season 0 = specials).
export function mapEpisode(parsed, episodes) {
  const regular = episodes.filter(e => e.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
  // Titles that are really the series name or generic ("Episode 1") are useless for matching.
  const usable = t => t && t.length > 3 && !/^(episode|part|chapter)\s*\d+$/i.test(t) && (!parsed.series || similarity(t, parsed.series) < 0.6);
  const byTitle = (t, min = 0.8) => {
    if (!usable(t)) return null;
    let best = null;
    for (const e of episodes) {
      const s = similarity(e.name, t);
      if (!best || s > best.s) best = { e, s };
    }
    return best && best.s >= min ? best.e : null;
  };
  if (parsed.season != null && parsed.episode != null) {
    const hit = episodes.find(e => e.season === parsed.season && e.episode === parsed.episode);
    if (hit) {
      // If the file carries a title that clearly belongs to a different episode, trust the title.
      if (usable(parsed.epTitle) && parsed.epTitle.length > 6 && similarity(hit.name, parsed.epTitle) < 0.4) {
        const t = byTitle(parsed.epTitle, 0.85);
        if (t) return { season: t.season, episode: t.episode, how: 'title-over-number' };
      }
      return { season: hit.season, episode: hit.episode, how: 'number' };
    }
    const t = byTitle(parsed.epTitle);
    if (t) return { season: t.season, episode: t.episode, how: 'title' };
    return { season: parsed.season, episode: parsed.episode, how: 'number-unknown' };
  }
  if (parsed.absolute != null) {
    const e = regular[parsed.absolute - 1];
    if (e && (!parsed.epTitle || similarity(e.name, parsed.epTitle) >= 0.5)) return { season: e.season, episode: e.episode, how: 'absolute' };
    const t = byTitle(parsed.epTitle);
    if (t) return { season: t.season, episode: t.episode, how: 'absolute-title' };
    if (e) return { season: e.season, episode: e.episode, how: 'absolute-unverified' };
  }
  const t = byTitle(parsed.epTitle);
  if (t) return { season: t.season, episode: t.episode, how: 'title' };
  return null;
}
