// Scheduled library sync: new files on the storage host appear in clients automatically.
import { fetchListing, makeOrigin } from './origin.mjs';
import { originText } from './youtube.mjs';
import { applyListing, applyOverrides, matchPending, probePending, log } from './library/sync.mjs';
import { rebuildItems } from './library/catalog.mjs';
import { backfillCertificates } from './ages.mjs';
import { Tmdb } from './library/tmdb.mjs';

// Syncs asked for by a webhook or the admin page run from the cron, which checks every minute and has minutes of
// run time. (A request's waitUntil is cut off about 30 s after the reply, often before a full sync is done.)
export async function requestSync(env) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('sync_requested', ?)").bind(String(Math.floor(Date.now() / 1000))).run();
}
export async function takeSyncRequest(env) {
  return !!(await env.DB.prepare("DELETE FROM kv WHERE key='sync_requested' RETURNING value").first());
}
// One sync at a time; a lock older than 10 minutes is stale (a killed run).
export async function lockSync(env) {
  const t = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(`INSERT INTO kv(key,value) VALUES ('sync_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(kv.value AS INTEGER) < ?`).bind(String(t), t - 600).run();
  return r.meta.changes > 0;
}
export async function unlockSync(env) {
  await env.DB.prepare("DELETE FROM kv WHERE key='sync_lock'").run();
}

export async function runSync(env, { force = false } = {}) {
  const started = Date.now();
  const result = {};
  try {
    const listing = await freshListing(env);
    result.scan = listing ? await applyListing(env.DB, listing) : { skipped: 'listing older than a delete' };
    // Manual match fixes (lookup key -> TMDB id), saved from the Library tab's fix form into kv 'overrides'.
    const extra = JSON.parse((await env.DB.prepare("SELECT value FROM kv WHERE key='overrides'").first())?.value || '{}');
    result.overrides = await applyOverrides(env.DB, extra);
    // Retry unmatched files once a day (TMDB gains new episodes/movies over time).
    const lastRetry = Number((await env.DB.prepare("SELECT value FROM kv WHERE key='last_retry'").first())?.value || 0);
    if (Date.now() / 1000 - lastRetry > 86400) {
      await env.DB.prepare("UPDATE files SET match_status='retry' WHERE match_status='unmatched'").run();
      await env.DB.prepare("DELETE FROM lookups WHERE manual=0 AND tmdb_id IS NULL").run();
      await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('last_retry', ?)").bind(String(Math.floor(Date.now() / 1000))).run();
    }
    const tmdb = new Tmdb(env.TMDB_TOKEN, { budget: 400 });
    result.match = await matchPending(env.DB, tmdb, { limit: 300, concurrency: 4, fetchText: originText(env) });
    result.probe = await probePending(env.DB, makeOrigin(env), { limit: 40, concurrency: 4 });
    try { result.certs = await backfillCertificates(env.DB, tmdb, { limit: 40 }); } catch (e) { result.certs = { error: e.message }; }
    if (result.certs?.found) force = true;
    const flag = await env.DB.prepare("SELECT value FROM kv WHERE key='force_rebuild'").first();
    if (flag) { force = true; await env.DB.prepare("DELETE FROM kv WHERE key='force_rebuild'").run(); }
    const changed = force || result.scan.added || result.scan.changed || result.scan.missing || result.scan.restored || result.overrides ||
      result.match.movies || result.match.episodes || result.match.youtube || result.match.unmatched || result.probe.ok;
    if (changed) result.items = await rebuildItems(env.DB);
    result.ms = Date.now() - started;
    const quiet = !changed;
    if (!quiet) await log(env.DB, 'sync', result);
    await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('last_sync', ?)").bind(JSON.stringify({ at: Math.floor(Date.now() / 1000), ...result })).run();
  } catch (e) {
    result.error = e.message;
    await log(env.DB, 'sync-error', e.message);
  }
  return result;
}

// Fast listing-only scan (a few seconds): new/missing files are recorded but not matched or probed.
// Used by the download pipeline to confirm a copy landed before it cleans up the download box.
export async function scanOnly(env) {
  const listing = await freshListing(env);
  return listing ? applyListing(env.DB, listing) : { skipped: 'listing older than a delete' };
}

// A listing that started before a delete from /admin finished would bring the deleted files back
// until the next sync; skip it (the next one will be fresh).
async function freshListing(env) {
  const listing = await fetchListing(env);
  const deleted = Number((await env.DB.prepare("SELECT value FROM kv WHERE key='last_delete_at'").first())?.value || 0);
  return listing.generated && listing.generated <= deleted ? null : listing;
}
