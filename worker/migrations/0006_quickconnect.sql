-- Jellyfin Quick Connect: a TV shows a 6-digit code; a signed-in person approves it (guest page, /admin or another app).
CREATE TABLE quickconnect (
  secret_hash TEXT PRIMARY KEY,        -- sha256 of the secret the TV polls with
  code TEXT NOT NULL,
  device_id TEXT, device_name TEXT, client TEXT, client_version TEXT,
  created_at INTEGER NOT NULL,
  user_id TEXT, authorized_at INTEGER
);
CREATE INDEX quickconnect_code ON quickconnect(code);
