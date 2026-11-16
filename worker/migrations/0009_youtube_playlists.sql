-- YouTube playlists: added all at once, either into the YouTube library or as episodes of a TV show
-- (saved under media/tvshows/<Show>/Season NN/ and matched on TMDB like any episode).
ALTER TABLE yt_jobs ADD COLUMN dest TEXT NOT NULL DEFAULT 'youtube';   -- youtube | tv
ALTER TABLE yt_jobs ADD COLUMN name TEXT;                              -- tv: "<Show>/Season NN/<file name without extension>"
ALTER TABLE yt_jobs ADD COLUMN list_id TEXT;                           -- the playlist it was added from
CREATE TABLE yt_lists (
  list_id TEXT PRIMARY KEY,
  title TEXT, channel TEXT,
  video_ids TEXT NOT NULL,             -- JSON array of the videos that were added
  dest TEXT NOT NULL, show TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
