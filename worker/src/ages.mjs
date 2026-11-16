// Age limits ("parental controls").
//
// Every Movie and Series gets items.age, the minimum age for its certification (US first; otherwise another
// country's, looked up from TMDB), or the owner's override. Seasons and episodes inherit their series' age.
// A user with users.max_age only ever sees items with age <= max_age; titles with no usable rating are hidden
// unless the user has allow_unrated. The rule is applied in SQL (ageClause) everywhere the library is read, and
// by id (itemAllowed / fileAllowed) for direct item, stream and player requests, so it can't be bypassed by
// guessing ids. It fails closed: a title whose age isn't known yet is hidden from limited users.

const FIXED = {
  // US film / TV
  'G': 0, 'PG': 8, 'PG-13': 13, 'R': 17, 'NC-17': 18,
  'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17,
  // UK, Ireland, Canada, Australia, NZ, Brazil, France and other common letters
  'U': 0, 'UC': 0, 'E': 0, 'L': 0, 'AL': 0, 'TP': 0, 'ALL': 0,
  '12A': 12, '14A': 14, '18A': 18, 'M': 15, 'MA': 15, 'MA15+': 15, 'R16': 16, 'R18': 18, 'R18+': 18, 'X18+': 18, 'X': 18, 'RP16': 16, 'RP18': 18
};
const UNRATED = new Set(['NR', 'N/A', 'NA', 'UNRATED', 'NOT RATED', 'UR', '-']);

/** Minimum age for a certification string, or null when unknown/unrated. */
export function ageOf(cert) {
  if (cert == null) return null;
  const s = String(cert).trim().toUpperCase();
  if (!s || UNRATED.has(s)) return null;
  if (s in FIXED) return FIXED[s];
  const m = /(\d{1,2})/.exec(s);           // "12", "15", "16+", "Från 15 år", "FSK 16", "K-12"
  return m ? Math.min(18, Number(m[1])) : null;
}

// Preferred countries when a film or show has no US certificate.
export const CERT_COUNTRIES = ['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'DE', 'NL', 'FR', 'SE', 'NO', 'DK', 'ES', 'IT', 'BR'];

export function pickMovieCert(releaseDates) {
  const by = new Map((releaseDates?.results || []).map(r => [r.iso_3166_1, (r.release_dates || []).map(x => x.certification).filter(c => ageOf(c) != null)]));
  for (const c of CERT_COUNTRIES) if (by.get(c)?.length) return by.get(c)[0];
  for (const list of by.values()) if (list.length) return list[0];
  return null;
}

export function pickTvCert(contentRatings) {
  const by = new Map((contentRatings?.results || []).filter(r => ageOf(r.rating) != null).map(r => [r.iso_3166_1, r.rating]));
  for (const c of CERT_COUNTRIES) if (by.has(c)) return by.get(c);
  return by.values().next().value || null;
}

/** SQL condition (on the items alias) for a session/user with an age limit; '' when unlimited. */
export function ageClause(u, alias = 'i') {
  if (u?.max_age == null) return { sql: '', args: [] };
  return u.allow_unrated
    ? { sql: ` AND (${alias}.age IS NULL OR ${alias}.age <= ?)`, args: [u.max_age] }
    : { sql: ` AND ${alias}.age IS NOT NULL AND ${alias}.age <= ?`, args: [u.max_age] };
}

export const allowedAge = (u, age) => u?.max_age == null || (age == null ? !!u.allow_unrated : age <= u.max_age);

export async function itemAllowed(env, u, itemId) {
  if (u?.max_age == null) return true;
  const r = await env.DB.prepare('SELECT age FROM items WHERE id = ?').bind(itemId).first();
  return !!r && allowedAge(u, r.age);
}

// A file is allowed if the item it belongs to (as main file or another version) is.
export async function fileAllowed(env, u, fileId) {
  if (u?.max_age == null) return true;
  const r = await env.DB.prepare(`SELECT age FROM items WHERE type IN ('Movie','Episode') AND (file_id = ? OR versions LIKE ?) LIMIT 1`).bind(fileId, `%"id":"${fileId}"%`).first();
  return !!r && allowedAge(u, r.age);
}

/** The age_overrides key for a Movie/Series row: by TMDB id (survives re-adds), YouTube id, or item id. */
export function ageKey(it) {
  const ids = JSON.parse(it.provider_ids || '{}');
  if (ids.Tmdb) return `${it.type === 'Movie' ? 'movie' : 'series'}:${ids.Tmdb}`;
  if (ids.YouTube) return `youtube:${ids.YouTube}`;
  return `item:${it.id}`;
}
/** The same key as SQL, on the items alias. */
export const AGE_KEY_SQL = a => `CASE WHEN json_extract(${a}.provider_ids,'$.Tmdb') IS NOT NULL THEN (CASE ${a}.type WHEN 'Movie' THEN 'movie:' ELSE 'series:' END) || json_extract(${a}.provider_ids,'$.Tmdb')
  WHEN json_extract(${a}.provider_ids,'$.YouTube') IS NOT NULL THEN 'youtube:' || json_extract(${a}.provider_ids,'$.YouTube') ELSE 'item:' || ${a}.id END`;

/** Recompute items.age from certificates and overrides. Run after every items rebuild and override change. */
export async function applyAges(db) {
  const over = new Map((await db.prepare('SELECT key, age FROM age_overrides').all()).results.map(r => [r.key, r.age]));
  const tops = (await db.prepare("SELECT id, type, official_rating, provider_ids, age FROM items WHERE type IN ('Movie','Series')").all()).results;
  const stmts = [];
  for (const it of tops) {
    const key = ageKey(it);
    const age = over.has(key) ? over.get(key) : ageOf(it.official_rating);
    if (it.type === 'Movie') { if (age !== it.age) stmts.push(db.prepare('UPDATE items SET age = ? WHERE id = ?').bind(age, it.id)); }
    else stmts.push(db.prepare('UPDATE items SET age = ? WHERE (id = ? OR series_id = ?) AND age IS NOT ?').bind(age, it.id, it.id, age));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// Unrated films/shows: look up other countries' certificates on TMDB (a few per sync until all are checked).
export async function backfillCertificates(db, tmdb, { limit = 40 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const movies = (await db.prepare("SELECT tmdb_id FROM movies WHERE (official_rating IS NULL OR official_rating IN ('NR','')) AND ratings_checked IS NULL LIMIT ?").bind(limit).all()).results;
  for (const m of movies) {
    const d = await tmdb.get(`/movie/${m.tmdb_id}/release_dates`);
    const cert = pickMovieCert(d);
    await db.prepare('UPDATE movies SET official_rating = COALESCE(?, official_rating), ratings_checked = ? WHERE tmdb_id = ?').bind(cert, now, m.tmdb_id).run();
    if (cert) n++;
  }
  const shows = (await db.prepare("SELECT tmdb_id FROM series WHERE (official_rating IS NULL OR official_rating IN ('NR','')) AND ratings_checked IS NULL LIMIT ?").bind(limit).all()).results;
  for (const s of shows) {
    const d = await tmdb.get(`/tv/${s.tmdb_id}/content_ratings`);
    const cert = pickTvCert(d);
    await db.prepare('UPDATE series SET official_rating = COALESCE(?, official_rating), ratings_checked = ? WHERE tmdb_id = ?').bind(cert, now, s.tmdb_id).run();
    if (cert) n++;
  }
  return { checked: movies.length + shows.length, found: n };
}
