-- People: Jellyfin users can have a name and an email (their sign-in for the /me guest page), an invite,
-- and per-user auto-approval of requests. Sessions remember where a device last connected from.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invited_at INTEGER;
ALTER TABLE users ADD COLUMN invite_expires INTEGER;
ALTER TABLE users ADD COLUMN accepted_at INTEGER;
ALTER TABLE users ADD COLUMN invite_email TEXT;       -- JSON: last invite email attempt {at, ok, error}
ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;  -- email when a request is ready
CREATE UNIQUE INDEX users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN place TEXT;

-- Title requests from users. One row per user and title; approving a title approves every open row for it.
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- movie | tv
  tmdb_id INTEGER NOT NULL,
  title TEXT NOT NULL, year INTEGER, poster TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | sent | declined | available
  reply TEXT,                          -- message from the owner, or why an automatic download didn't happen
  torrent_hash TEXT, torrent_name TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, available_at INTEGER,
  UNIQUE(user_id, kind, tmdb_id)
);
CREATE INDEX requests_status ON requests(status, kind, tmdb_id);
