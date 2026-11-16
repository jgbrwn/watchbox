-- Denormalized Jellyfin items (Movie / Series / Season / Episode), rebuilt by sync.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- Movie | Series | Season | Episode
  library TEXT NOT NULL,         -- movies | tv
  parent_id TEXT, series_id TEXT, season_id TEXT,
  series_name TEXT, season_name TEXT,
  name TEXT NOT NULL, sort_name TEXT NOT NULL, original_title TEXT,
  year INTEGER, premiere_date TEXT, end_date TEXT, status TEXT,
  overview TEXT, tagline TEXT, genres TEXT, studios TEXT, people TEXT,
  rating REAL, official_rating TEXT, runtime_ticks INTEGER,
  index_number INTEGER, index_end INTEGER, parent_index INTEGER,
  file_id TEXT, container TEXT, size INTEGER, streams TEXT, subtitles TEXT,
  images TEXT, provider_ids TEXT,
  date_created INTEGER NOT NULL, child_count INTEGER, recursive_count INTEGER,
  hash TEXT NOT NULL
);
CREATE INDEX items_type ON items(library, type, sort_name);
CREATE INDEX items_parent ON items(parent_id, parent_index, index_number);
CREATE INDEX items_series ON items(series_id, parent_index, index_number);
CREATE INDEX items_created ON items(type, date_created);

CREATE TABLE persons (
  id TEXT PRIMARY KEY, tmdb_id INTEGER NOT NULL, name TEXT NOT NULL, image TEXT
);
