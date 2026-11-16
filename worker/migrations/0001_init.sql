-- Watch v2 schema: plain catalog tables + user state.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT, device_name TEXT, client TEXT, client_version TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

-- One row per distinct video file (hardlinked duplicates share a row).
CREATE TABLE files (
  id TEXT PRIMARY KEY,                  -- 32 hex, Jellyfin item id for movies/episodes
  root TEXT NOT NULL, path TEXT NOT NULL,   -- canonical location (origin URL is src/<root>/<path>)
  library TEXT NOT NULL,                -- 'movies' | 'tv'
  kind TEXT NOT NULL,                   -- 'movie' | 'episode' | 'extra' | 'sample'
  size INTEGER NOT NULL, mtime INTEGER NOT NULL, inode INTEGER,
  parsed TEXT,                          -- JSON from parse.mjs
  match_key TEXT,                       -- lookups key (movie title/year or series name)
  match_status TEXT NOT NULL DEFAULT 'pending', -- pending|matched|unmatched|manual
  match_note TEXT,
  movie_id INTEGER,                     -- tmdb movie id
  series_key TEXT,                      -- series grouping key (tmdb:<id> or name:<norm>)
  season INTEGER, episode INTEGER, episode_end INTEGER,
  duration_ticks INTEGER, probe TEXT, probed_at INTEGER, probe_error TEXT,
  added_at INTEGER NOT NULL, missing_since INTEGER,
  UNIQUE(root, path)
);
CREATE INDEX files_library ON files(library, kind, missing_since);
CREATE INDEX files_movie ON files(movie_id);
CREATE INDEX files_series ON files(series_key, season, episode);
CREATE INDEX files_status ON files(match_status);
CREATE INDEX files_added ON files(added_at);

-- Every (root,path) the listing reports, mapped to its file row.
CREATE TABLE file_paths (
  root TEXT NOT NULL, path TEXT NOT NULL, file_id TEXT NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY(root, path)
);
CREATE INDEX file_paths_file ON file_paths(file_id);

CREATE TABLE subtitles (
  root TEXT NOT NULL, path TEXT NOT NULL, file_id TEXT NOT NULL,
  language TEXT, forced INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL,
  PRIMARY KEY(root, path)
);
CREATE INDEX subtitles_file ON subtitles(file_id);

-- Search results cache and manual overrides: key -> tmdb id.
-- key is 'movie:<normtitle>:<year>' or 'tv:<normtitle>:<year>'.
CREATE TABLE lookups (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, tmdb_id INTEGER, note TEXT,
  manual INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);

CREATE TABLE movies (
  tmdb_id INTEGER PRIMARY KEY, imdb_id TEXT, title TEXT NOT NULL, original_title TEXT,
  year INTEGER, release_date TEXT, overview TEXT, tagline TEXT, genres TEXT, studios TEXT,
  rating REAL, official_rating TEXT, runtime INTEGER, poster TEXT, backdrop TEXT, logo TEXT,
  people TEXT, collection TEXT, countries TEXT, updated_at INTEGER
);

CREATE TABLE series (
  tmdb_id INTEGER PRIMARY KEY, imdb_id TEXT, tvdb_id INTEGER, title TEXT NOT NULL, original_title TEXT,
  year INTEGER, first_air TEXT, last_air TEXT, status TEXT, overview TEXT, genres TEXT, studios TEXT,
  rating REAL, official_rating TEXT, poster TEXT, backdrop TEXT, logo TEXT, people TEXT,
  runtime INTEGER, seasons TEXT, updated_at INTEGER
);

CREATE TABLE episodes (
  series_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, overview TEXT, still TEXT, air_date TEXT, runtime INTEGER, rating REAL,
  PRIMARY KEY(series_id, season, episode)
);

CREATE TABLE progress (
  user_id TEXT NOT NULL, item_id TEXT NOT NULL,
  position_ticks INTEGER NOT NULL DEFAULT 0, played INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0, last_played INTEGER,
  PRIMARY KEY(user_id, item_id)
);
CREATE INDEX progress_recent ON progress(user_id, last_played);

CREATE TABLE favorites (
  user_id TEXT NOT NULL, item_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_id)
);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, step TEXT NOT NULL, detail TEXT
);
