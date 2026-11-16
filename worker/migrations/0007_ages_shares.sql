-- Age limits: every Movie/Series (and its seasons/episodes) gets a minimum age computed from its certification
-- (or the owner's override). Users can have a maximum age; unrated titles are hidden from them unless allowed.
ALTER TABLE items ADD COLUMN age INTEGER;
ALTER TABLE users ADD COLUMN max_age INTEGER;              -- NULL = no limit
ALTER TABLE users ADD COLUMN allow_unrated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movies ADD COLUMN ratings_checked INTEGER;     -- other countries' certificates looked up (for unrated films)
ALTER TABLE series ADD COLUMN ratings_checked INTEGER;
CREATE TABLE age_overrides (
  key TEXT PRIMARY KEY,                -- movie:<tmdb> | series:<tmdb> | item:<id> (unmatched titles)
  age INTEGER,                         -- NULL = treat as unrated
  at INTEGER NOT NULL
);

-- Public links that play one title in a browser, for anyone with the link.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,                 -- the unguessable token in /s/<token>
  item_id TEXT NOT NULL,
  user_id TEXT,                        -- who made it; NULL = the owner from /admin
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
  views INTEGER NOT NULL DEFAULT 0, last_view_at INTEGER
);
CREATE INDEX shares_user ON shares(user_id);
