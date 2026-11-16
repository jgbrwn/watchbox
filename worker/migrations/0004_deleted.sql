-- Files deleted from /admin (moved to the storage host trash). Still rows, so a restore keeps ids and watch history.
ALTER TABLE files ADD COLUMN deleted_at INTEGER;
