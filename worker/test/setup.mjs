// Tests use a split layout like a long-running install (media/ and downloads/complete/ for movies and TV) so the
// multi-root paths stay covered; test/config.test.mjs checks the default single-folder layout.
import { configure } from '../src/config.mjs';
export const SPLIT_ROOTS = [
  { id: 'media-movies', library: 'movies' }, { id: 'completed-movies', library: 'movies', priority: 1 },
  { id: 'media-tv', library: 'tv' }, { id: 'completed-tv', library: 'tv', priority: 1 },
  { id: 'media-youtube', library: 'youtube' }
];
configure({ LIBRARY_ROOTS: SPLIT_ROOTS });
