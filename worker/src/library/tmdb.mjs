import { pickMovieCert, pickTvCert } from '../ages.mjs';
// Minimal TMDB v3 client (Bearer read-access token) with retry on 429/5xx.

const API = 'https://api.themoviedb.org/3';

export class Tmdb {
  constructor(token, { fetchImpl = fetch, budget = Infinity } = {}) {
    // Call fetch unbound: Workers throw "Illegal invocation" when fetch runs as a method of another object.
    this.token = token; this.fetch = (...a) => fetchImpl(...a); this.budget = budget; this.calls = 0;
  }

  async get(path, params = {}) {
    if (this.calls >= this.budget) throw new BudgetExhausted();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      let res;
      try {
        res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } });
      } catch (e) {
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw e;
      }
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Number(res.headers.get('Retry-After')) * 1000 || 500 * 2 ** attempt;
        await sleep(Math.min(wait, 10_000)); continue;
      }
      if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch {
        if (attempt < 4) { await sleep(500 * 2 ** attempt); continue; }   // cut-off response: retry
        throw new Error(`TMDB incomplete JSON ${path} (${text.length} bytes)`);
      }
    }
  }

  searchMovie(query, year) { return this.get('/search/movie', { query, year, include_adult: 'true' }); }
  searchTv(query, year) { return this.get('/search/tv', { query, first_air_date_year: year, include_adult: 'true' }); }
  movie(id) {
    return this.get(`/movie/${id}`, { append_to_response: 'release_dates,credits,images,external_ids', include_image_language: 'en,null' });
  }
  tv(id) {
    return this.get(`/tv/${id}`, { append_to_response: 'content_ratings,credits,images,external_ids', include_image_language: 'en,null' });
  }
  season(id, n) { return this.get(`/tv/${id}/season/${n}`); }
  findImdb(imdbId) { return this.get(`/find/${imdbId}`, { external_source: 'imdb_id' }); }
}

export class BudgetExhausted extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Normalizers from TMDB payloads into our row shapes ----

function bestLogo(images) {
  const logos = (images?.logos || []).filter(l => l.iso_639_1 === 'en' || l.iso_639_1 == null);
  logos.sort((a, b) => (b.iso_639_1 === 'en') - (a.iso_639_1 === 'en') || b.vote_average - a.vote_average);
  return logos[0]?.file_path || null;
}

function bestBackdrop(d) {
  // Prefer textless backdrops (iso null) for full-screen backgrounds.
  const list = (d.images?.backdrops || []).filter(b => b.iso_639_1 == null);
  list.sort((a, b) => b.vote_average - a.vote_average || b.width - a.width);
  return d.backdrop_path || list[0]?.file_path || null;
}

function people(credits) {
  const out = [];
  for (const c of (credits?.cast || []).slice(0, 20))
    out.push({ id: c.id, name: c.name, role: c.character || '', type: 'Actor', image: c.profile_path || null });
  for (const c of credits?.crew || []) {
    const type = c.job === 'Director' ? 'Director' : ['Screenplay', 'Writer', 'Story', 'Novel'].includes(c.job) ? 'Writer'
      : c.job === 'Producer' || c.job === 'Executive Producer' && out.filter(p => p.type === 'Producer').length < 3 ? 'Producer' : null;
    if (type && !out.some(p => p.id === c.id && p.type === type)) out.push({ id: c.id, name: c.name, role: c.job, type, image: c.profile_path || null });
  }
  return out.slice(0, 40);
}

// US certificate first; otherwise another country's (src/ages.mjs), so age limits work for foreign titles too.
function usCertMovie(d) {
  const us = d.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
  return us?.release_dates?.map(r => r.certification).find(c => c && c !== 'NR') || pickMovieCert(d.release_dates) || null;
}

export function movieRow(d) {
  return {
    tmdb_id: d.id, imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
    title: d.title, original_title: d.original_title || null,
    year: d.release_date ? +d.release_date.slice(0, 4) : null, release_date: d.release_date || null,
    overview: d.overview || null, tagline: d.tagline || null,
    genres: JSON.stringify((d.genres || []).map(g => g.name)),
    studios: JSON.stringify((d.production_companies || []).slice(0, 5).map(c => c.name)),
    rating: d.vote_average || null, official_rating: usCertMovie(d), runtime: d.runtime || null,
    poster: d.poster_path || null, backdrop: bestBackdrop(d), logo: bestLogo(d.images),
    people: JSON.stringify(people(d.credits)), collection: d.belongs_to_collection?.name || null,
    countries: JSON.stringify((d.production_countries || []).map(c => c.iso_3166_1)),
    updated_at: Math.floor(Date.now() / 1000)
  };
}

export function seriesRow(d) {
  const us = d.content_ratings?.results?.find(r => r.iso_3166_1 === 'US')?.rating;
  return {
    tmdb_id: d.id, imdb_id: d.external_ids?.imdb_id || null, tvdb_id: d.external_ids?.tvdb_id || null,
    title: d.name, original_title: d.original_name || null,
    year: d.first_air_date ? +d.first_air_date.slice(0, 4) : null,
    first_air: d.first_air_date || null, last_air: d.last_air_date || null, status: d.status || null,
    overview: d.overview || null, genres: JSON.stringify((d.genres || []).map(g => g.name)),
    studios: JSON.stringify([...(d.networks || []), ...(d.production_companies || [])].slice(0, 5).map(c => c.name)),
    rating: d.vote_average || null, official_rating: (us && us !== 'NR' ? us : pickTvCert(d.content_ratings)) || us || d.content_ratings?.results?.[0]?.rating || null,
    poster: d.poster_path || null, backdrop: bestBackdrop(d), logo: bestLogo(d.images),
    people: JSON.stringify(people(d.credits)),
    runtime: d.episode_run_time?.[0] || null,
    seasons: JSON.stringify((d.seasons || []).map(s => ({ n: s.season_number, count: s.episode_count, name: s.name, poster: s.poster_path, air: s.air_date, overview: s.overview }))),
    updated_at: Math.floor(Date.now() / 1000)
  };
}
