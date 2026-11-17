// Webhooks and "Sync now" only ask for a sync; the per-minute cron runs it, one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { requestSync, takeSyncRequest, lockSync, unlockSync } from '../src/cron.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = () => openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });

test('sync requests are taken once; the lock admits one sync and expires when stale', async () => {
  const env = { DB: db() };
  assert.equal(await takeSyncRequest(env), false);
  await requestSync(env); await requestSync(env);
  assert.equal(await takeSyncRequest(env), true);
  assert.equal(await takeSyncRequest(env), false);

  assert.equal(await lockSync(env), true);
  assert.equal(await lockSync(env), false);          // a second cron tick while the first sync runs
  await unlockSync(env);
  assert.equal(await lockSync(env), true);
  await env.DB.prepare("UPDATE kv SET value = ? WHERE key='sync_lock'").bind(String(Math.floor(Date.now() / 1000) - 700)).run();
  assert.equal(await lockSync(env), true);           // a killed run's lock doesn't block forever
});
