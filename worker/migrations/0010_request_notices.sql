-- Declined requests: the person sees a notice on /me until they dismiss it.
ALTER TABLE requests ADD COLUMN seen_at INTEGER;
