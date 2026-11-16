#!/usr/bin/env node
// Local library build using the same pipeline the Worker cron runs.
// Usage: node tools/build-library.mjs <scan|match|probe|report|all> [--db path]
import { configure } from '../src/config.mjs';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalDb } from './local-db.mjs';
import { applyListing, applyOverrides, matchPending, probePending } from '../src/library/sync.mjs';
import { fetchListing, makeOrigin } from '../src/origin.mjs';
import { originText } from '../src/youtube.mjs';
import { Tmdb } from '../src/library/tmdb.mjs';
import { rebuildItems } from '../src/library/catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const api = join(homedir(), '.local/share/.api');
const args = process.argv.slice(2);
const step = args[0] || 'all';
// Settings come from your wrangler config (WATCHBOX_CONFIG, default worker/wrangler.jsonc: ORIGIN_BASE_URL, LIBRARY_ROOTS)
// and these environment variables:
//   WATCHBOX_DATA (default ~/.local/share/watchbox): where library.db is built; ORIGIN_AUTHORIZATION (default: the
//   "authorization" in ~/.local/share/.api/origin-auth.json); WATCHBOX_REGISTRY: optional id registry from an older
//   install (keeps file ids stable on a rebuild).
const configFile = process.env.WATCHBOX_CONFIG || join(here, '../wrangler.jsonc');   // your install's wrangler config
const vars = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\s*\/\/.*$/mg, '')).vars || {};
configure(vars);
const data = process.env.WATCHBOX_DATA || join(homedir(), '.local/share/watchbox');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(data, 'library.db');
mkdirSync(dirname(dbPath), { recursive: true });
const fresh = !existsSync(dbPath);
const db = openLocalDb(dbPath, { migrations: fresh ? [join(here, '../migrations/0001_init.sql')] : [] });

const env = {
  ORIGIN_BASE_URL: process.env.ORIGIN_BASE_URL || vars.ORIGIN_BASE_URL,
  ORIGIN_AUTHORIZATION: process.env.ORIGIN_AUTHORIZATION || JSON.parse(readFileSync(join(api, 'origin-auth.json'))).authorization,
};
const tmdb = new Tmdb(readFileSync(join(api, 'tmdb_read_access_token'), 'utf8').trim());

function registry() {
  const p = process.env.WATCHBOX_REGISTRY;
  if (!p || !existsSync(p)) return null;
  const m = new Map();
  for (const r of JSON.parse(readFileSync(p)).records) for (const a of r.known_source_aliases || []) m.set(a.root_id + '\0' + a.relative_path, r.media_id);
  return m;
}

async function scan() {
  const listing = await fetchListing(env);
  console.log('scan', await applyListing(db, listing, { registry: registry() }));
}
async function match() {
  // Optional manual match fixes: WATCHBOX_OVERRIDES=file.json ({"movie:title:year": tmdbId, ...}).
  if (process.env.WATCHBOX_OVERRIDES) console.log('overrides applied', await applyOverrides(db, JSON.parse(readFileSync(process.env.WATCHBOX_OVERRIDES))));
  for (;;) {
    const s = await matchPending(db, tmdb, { limit: 400, concurrency: 8, fetchText: originText(env) });
    console.log('match', s, 'tmdb calls', tmdb.calls);
    if (!s.movies && !s.episodes && !s.unmatched) break;
  }
}
async function probe() {
  const origin = makeOrigin(env);
  for (;;) {
    const s = await probePending(db, origin, { limit: 120, concurrency: 8 });
    console.log('probe', s, new Date().toISOString());
    if (!s.ok && !s.failed) break;
  }
}
async function report() {
  const q = async sql => (await db.prepare(sql).all()).results;
  console.table(await q("SELECT library, kind, match_status, count(*) n FROM files WHERE missing_since IS NULL GROUP BY 1,2,3"));
  console.table(await q("SELECT count(*) files, sum(duration_ticks IS NOT NULL) with_duration, sum(probe_error IS NOT NULL) probe_errors FROM files WHERE kind IN ('movie','episode') AND missing_since IS NULL"));
  console.table(await q("SELECT (SELECT count(*) FROM movies) movies, (SELECT count(*) FROM movies WHERE poster IS NOT NULL) with_poster, (SELECT count(*) FROM movies WHERE backdrop IS NOT NULL) with_backdrop, (SELECT count(*) FROM series) series, (SELECT count(*) FROM episodes) tmdb_episodes, (SELECT count(*) FROM subtitles) subtitles"));
}

async function items() {
  if (!(await db.prepare("SELECT value FROM kv WHERE key='initial_build'").first()))
    await db.prepare("INSERT INTO kv(key,value) VALUES ('initial_build', ?)").bind(String(Math.floor(Date.now() / 1000))).run();
  console.log('items', await rebuildItems(db));
}
const steps = { scan, match, probe, report, items };
if (step === 'all') { await scan(); await match(); await probe(); await items(); await report(); }
else await steps[step]();
