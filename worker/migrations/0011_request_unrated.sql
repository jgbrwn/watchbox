-- The title had no age rating when it was asked for (YouTube videos never do): the owner is shown which age it would
-- need for limited people who asked to be able to watch it.
ALTER TABLE requests ADD COLUMN unrated INTEGER NOT NULL DEFAULT 0;
