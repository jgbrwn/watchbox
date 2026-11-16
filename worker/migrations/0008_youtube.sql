-- YouTube videos in the library. The download box fetches a video with yt-dlp, writes a small metadata sidecar
-- (<name> [<id>].info.json) plus thumbnail/poster next to it, and copies everything to the storage host media/youtube/<channel>/.
-- The sync reads the sidecar into this table; the catalog builds a "YouTube" library from it.
CREATE TABLE youtube (
  video_id TEXT PRIMARY KEY,           -- 11-character YouTube id
  title TEXT NOT NULL, channel TEXT, channel_id TEXT,
  upload_date TEXT,                    -- YYYY-MM-DD
  description TEXT, duration INTEGER,  -- seconds
  age_limit INTEGER,                   -- 18 for age-restricted videos, else 0
  categories TEXT, tags TEXT,          -- JSON arrays
  fetched_at INTEGER NOT NULL
);

-- Downloads on the box. Mirrors the box's own job list (the box is the source of truth while a job runs).
CREATE TABLE yt_jobs (
  video_id TEXT PRIMARY KEY,
  quality TEXT NOT NULL DEFAULT '1080',     -- 720 | 1080 | 2160
  status TEXT NOT NULL,                     -- waiting (not handed to the box yet) | queued | downloading | uploading | copied | added | failed
  progress REAL, error TEXT,
  title TEXT, channel TEXT,
  path TEXT, size INTEGER,                  -- where it landed under media/youtube/
  added_by TEXT,                            -- user id, NULL = the owner
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);

-- Requests can now be for a YouTube video: kind 'youtube', yt_id set, tmdb_id 0. (No rows existed yet.)
CREATE TABLE requests_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- movie | tv | youtube
  tmdb_id INTEGER NOT NULL DEFAULT 0,
  yt_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, year INTEGER, poster TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | sent | declined | available
  reply TEXT,
  torrent_hash TEXT, torrent_name TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, available_at INTEGER,
  UNIQUE(user_id, kind, tmdb_id, yt_id)
);
INSERT INTO requests_new(id, user_id, kind, tmdb_id, title, year, poster, note, status, reply, torrent_hash, torrent_name, created_at, updated_at, available_at)
  SELECT id, user_id, kind, tmdb_id, title, year, poster, note, status, reply, torrent_hash, torrent_name, created_at, updated_at, available_at FROM requests;
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
CREATE INDEX requests_status ON requests(status, kind, tmdb_id);
CREATE INDEX requests_yt ON requests(yt_id) WHERE yt_id != '';
