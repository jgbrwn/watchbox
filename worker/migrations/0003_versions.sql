-- Alternate files of the same episode/movie, shown as Jellyfin "versions" (extra MediaSources).
ALTER TABLE items ADD COLUMN versions TEXT;
