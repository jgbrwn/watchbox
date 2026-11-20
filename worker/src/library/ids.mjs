// Title ids typed or pasted by people: IMDb ids (tt0049730) and links, TMDB ids and links.
// TMDB turns an IMDb id into its own id with /find (external_source=imdb_id).

/** { imdb: 'tt…' } | { tmdb: 123, kind: 'movie' | 'tv' | null } | null.
 *  `bare`: a plain number counts as a TMDB id (the fix form); elsewhere it needs "tmdb:" or a link. */
export function parseTitleId(s, { bare = false } = {}) {
  s = String(s || '').trim();
  let m = /^(?:https?:\/\/)?(?:[a-z]+\.)?imdb\.com\/(?:[a-z-]+\/)?title\/(tt\d{5,10})/i.exec(s) || /^(tt\d{5,10})$/i.exec(s);
  if (m) return { imdb: m[1].toLowerCase() };
  m = /^(?:https?:\/\/)?(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(s);
  if (m) return { tmdb: Number(m[2]), kind: m[1].toLowerCase() };
  m = /^tmdb[:\s]\s*(?:(movie|tv)[:/])?(\d+)$/i.exec(s);
  if (m) return { tmdb: Number(m[2]), kind: m[1]?.toLowerCase() || null };
  if (bare && /^\d+$/.test(s)) return { tmdb: Number(s), kind: null };
  return null;
}

/** TMDB ids an IMDb id stands for: [{ kind: 'movie' | 'tv', tmdb_id }] (an episode's id gives its show). */
export async function findByImdb(tmdb, imdb) {
  const d = await tmdb.get('/find/' + imdb, { external_source: 'imdb_id' });
  const out = [];
  for (const r of d?.movie_results || []) out.push({ kind: 'movie', tmdb_id: r.id });
  for (const r of d?.tv_results || []) out.push({ kind: 'tv', tmdb_id: r.id });
  for (const r of d?.tv_episode_results || []) if (!out.some(o => o.kind === 'tv' && o.tmdb_id === r.show_id)) out.push({ kind: 'tv', tmdb_id: r.show_id });
  return out;
}
