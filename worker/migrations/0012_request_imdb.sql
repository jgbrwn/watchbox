-- The title's IMDb id (from TMDB), for links and Find searches from the owner's request cards.
ALTER TABLE requests ADD COLUMN imdb_id TEXT;
