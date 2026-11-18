// The download pipeline: finished downloads on the download box -> the storage host library -> cleanup.
//
// c-cli saves a .torrent into ~ -> qBittorrent (watches ~) downloads via ~/media/temp into ~/media
// -> qBittorrent's "on finished" hook pokes /hooks/qbit (the 15-minute cron is the fallback)
// -> autoPipeline: rsync-web /api/push copies ~/media/<name> to the storage host (Movies or TV preset)
// -> rsync-web's webhook /hooks/rsync (or the admin page / cron noticing) -> finishPush:
//    library sync, then check every video file of the torrent is on the storage host with the same size,
//    then qBittorrent removes the torrent and its files from the box.
// Nothing on the storage host is ever deleted (no --delete); cleanup only touches the box.
import { tools, upstreamFetch } from './tools.mjs';
import { requestSync, scanOnly } from './cron.mjs';
import { VIDEO_EXT } from './library/parse.mjs';
import { originHeaders } from './origin.mjs';
import { cfg } from './config.mjs';
import { duplicateCheck } from './dupes.mjs';
import { batchSent, batchStates, batchTick } from './batches.mjs';

// rsync-web presets configured on the box (-preset, see app/freebsd/rsync_web) and where they land in the library.
const PRESET = { movie: 'Movies', tv: 'TV' };
const libraryRoot = kind => cfg().primary[kind === 'tv' ? 'tv' : 'movies'];   // where Send to library copies land
const savePath = () => cfg().boxMediaPath;      // qBittorrent's finished-download folder (= rsync-web push root "media")
// seed_ratio / seed_hours: keep seeding after a verified copy until either is reached (no hit and run).
const DEFAULTS = { auto: true, cleanup: true, seed_ratio: 1, seed_hours: 72 };
const LIMITS = { seed_ratio: [0, 20], seed_hours: [0, 24 * 60] };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);

export const guessKind = name =>
  /\bS\d{1,2}(?:E\d{1,3}|\b|-S?\d)|\bSeason[\s._-]*\d|\bSeries[\s._-]*\d|Complete[\s._-]*Series|\bBox[\s._-]*set|\b\d{1,2}x\d{2}\b|\bE\d{2,3}\b/i.test(name) ? 'tv' : 'movie';

const tool = (env, id) => tools(env).find(t => t.id === id);

export async function getJson(env, id, path, init) {
  const t = tool(env, id);
  if (!t || !env.TOOLS_AUTHORIZATION) return { error: 'not configured' };
  try {
    const r = await upstreamFetch(env, t, path, init);
    if (!r.ok) return { error: `${t.name}: HTTP ${r.status}`, status: r.status };
    const type = r.headers.get('content-type') || '';
    return { data: type.includes('json') ? await r.json() : await r.text() };
  } catch (e) { return { error: `${t.name}: ${e.message}` }; }
}
const qbPost = (env, path, body) => getJson(env, 'dl', path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });

export const kvGet = async (db, key) => { const v = (await db.prepare('SELECT value FROM kv WHERE key=?').bind(key).first())?.value; try { return v == null ? null : JSON.parse(v); } catch { return v; } };
export const kvSet = (db, key, value) => db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();

export async function getSettings(db) { return { ...DEFAULTS, ...((await kvGet(db, 'pipeline_settings')) || {}) }; }

export async function mediaEntries(env) {
  const r = await getJson(env, 'rs', '/api/browse?path=media');
  if (r.error) return r;
  return { data: (r.data.entries || []).filter(e => e.name !== '..' && e.name !== 'temp' && !e.name.startsWith('.')) };
}

// Disk space on the storage host (quota) and on the download box. the storage host usage comes from DirectAdmin through
// list.php?space=1 (a usage-only login key on the storage host; Workers can't reach DirectAdmin's port 2222),
// cached 15 minutes. If that fails it's estimated: library file sizes plus STORAGE_OTHER_MB.
// Warnings below 10% free or near the floors.
const MB = 1048576;
async function storageUsedMb(env) {
  const cached = await kvGet(env.DB, 'storage_usage');
  if (cached && now() - cached.checked < 900) return cached;
  try {
    const r = await fetch(env.ORIGIN_BASE_URL.replace(/\/?$/, '/') + 'list.php?space=1', { headers: originHeaders(env), signal: AbortSignal.timeout(25000) });
    const d = r.ok ? await r.json() : null;
    if (d && Number.isFinite(d.used_mb)) { const v = { used_mb: d.used_mb, total_mb: Number.isFinite(d.total_mb) ? d.total_mb : null, at: d.at, checked: now() }; await kvSet(env.DB, 'storage_usage', v); return v; }
  } catch {}
  return cached && now() - cached.checked < 86400 ? cached : null;
}
export async function storage(env) {
  // Size: STORAGE_QUOTA_MB (a hosting plan's quota), else what the storage host reports (a VPS disk, a cPanel limit).
  let quota = cfg().storageQuotaMb * MB, store = null;
  const exact = await storageUsedMb(env);
  if (!quota && exact?.total_mb) quota = exact.total_mb * MB;
  if (quota) {
    if (exact) store = { total: quota, used: exact.used_mb * MB, estimated: false, at: exact.at };
    else {
      const lib = (await env.DB.prepare('SELECT sum(size) b FROM files WHERE missing_since IS NULL').first())?.b || 0;
      store = { total: quota, used: lib + cfg().storageOtherMb * MB, estimated: true };
    }
  }
  let box = null;
  const st = await getJson(env, 'rs', '/api/status');
  if (st.data?.disk_total) box = { total: st.data.disk_total, used: st.data.disk_total - st.data.disk_free };
  const level = (d, floor) => !d ? null : (d.total - d.used < floor || (d.total - d.used) / d.total < 0.05) ? 'bad' : (d.total - d.used) / d.total < 0.1 || d.total - d.used < floor * 2 ? 'warn' : 'ok';
  if (store) store.level = level(store, 100e9);
  if (box) box.level = level(box, 10e9);
  return { store, box };
}

// A finished torrent that is safe to copy: complete, not moving/checking, sitting directly in ~/media.
export function readyName(t) {
  if (!t || t.progress < 1 || /moving|checking|missing|error|meta/i.test(t.state || '')) return null;
  // content_path is the folder, or the file itself when the torrent has a single file (even inside a folder).
  const p = String(t.content_path || '');
  if (!p.startsWith(savePath())) return null;
  const name = p.slice(savePath().length).split('/')[0];
  return name && name !== 'temp' && !name.startsWith('.') ? name : null;
}

async function startPush(env, { name, kind, hash = null, auto = false }) {
  const r = await getJson(env, 'rs', '/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, preset: PRESET[kind] }) });
  if (r.error) return r;
  const rec = { job: r.data.id, name, kind, hash, auto, at: now() };
  await kvSet(env.DB, `push:${r.data.id}`, rec);
  if (hash) await kvSet(env.DB, `pushed:${hash}`, r.data.id);
  return { data: rec };
}

// Sends every finished, not-yet-sent download (when auto-send is on). Safe to call often.
export async function autoPipeline(env) {
  const settings = await getSettings(env.DB);
  if (!settings.auto) return { auto: false };
  const qb = await getJson(env, 'dl', '/api/v2/torrents/info?filter=completed');
  if (qb.error) return { error: qb.error };
  const started = [];
  const space = (await storage(env)).store;
  for (const t of qb.data || []) {
    const name = readyName(t);
    if (!name || await kvGet(env.DB, `pushed:${t.hash}`) || await kvGet(env.DB, `batch:${t.hash}`)) continue;   // batches: src/batches.mjs
    if (space && space.total - space.used < t.size + 50e9) { started.push({ name, skipped: `${cfg().storageName} is nearly full` }); continue; }
    // Already in the library (another copy of the movie, or every episode of the pack)? Leave it for the owner:
    // the Pipeline tab shows it with "Send anyway" (it may be an upgrade) and "Remove from box".
    let dup = await kvGet(env.DB, `dup:${t.hash}`);
    if (!dup) {
      try { dup = (await duplicateCheck(env, t, name)) || { none: true }; } catch (e) { dup = null; }
      if (dup) await kvSet(env.DB, `dup:${t.hash}`, dup);
    }
    if (dup?.all) { started.push({ name, skipped: 'already in the library: ' + (dup.title || '') }); continue; }
    const r = await startPush(env, { name, kind: guessKind(name), hash: t.hash, auto: true });
    started.push(r.error ? { name, error: r.error } : { name, job: r.data.job });
    if (started.length >= 3) break;
  }
  // Forget duplicate checks of torrents that are gone from the box.
  const all = await getJson(env, 'dl', '/api/v2/torrents/info');
  if (Array.isArray(all.data)) {
    const live = new Set(all.data.map(t => t.hash));
    const stale = (await env.DB.prepare("SELECT key FROM kv WHERE key LIKE 'dup:%' OR key LIKE 'ident:%'").all()).results.map(r => r.key).filter(k => !live.has(k.split(':')[1]));
    for (const k of stale) await env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(k).run();
  }
  return { started };
}

// Checks that each video file of the torrent is in the library listing with the same size.
async function verifyOnHostbrr(env, rec) {
  const files = await getJson(env, 'dl', `/api/v2/torrents/files?hash=${rec.hash}`);
  if (files.error) return files.error;
  const videos = (files.data || []).filter(f => VIDEO_EXT.has(String(f.name).split('.').pop().toLowerCase()));
  if (!videos.length) return 'no video files in the torrent';
  for (const f of videos) {
    const row = await env.DB.prepare('SELECT size FROM files WHERE root=? AND path=? AND missing_since IS NULL').bind(libraryRoot(rec.kind), f.name).first();
    if (!row) return `not on ${cfg().storageName} yet: ${f.name}`;
    if (row.size !== f.size) return `size differs on ${cfg().storageName}: ${f.name}`;
  }
  return null;
}

export const seedState = (t, s) => ({ ratio: t.ratio, seeding_time: t.seeding_time, done: t.ratio >= s.seed_ratio || t.seeding_time >= s.seed_hours * 3600 });

// After a verified copy: remove from the box now, or once the seeding goal is met.
async function cleanupIfDone(env, rec, settings) {
  const info = await getJson(env, 'dl', `/api/v2/torrents/info?hashes=${rec.hash}`);
  if (info.error) return { error: info.error };
  const t = (info.data || [])[0];
  if (!t) return { gone: now() };                                    // removed by hand
  const seed = seedState(t, settings);
  if (!seed.done) return { waiting: true, ratio: seed.ratio, seeding_time: seed.seeding_time, checked: now() };
  const problem = await verifyOnHostbrr(env, rec);                   // re-check right before deleting
  if (problem) return { error: problem };
  const del = await qbPost(env, '/api/v2/torrents/delete', `hashes=${rec.hash}&deleteFiles=true`);
  return del.error ? { error: del.error } : { removed: now(), ratio: seed.ratio, seeding_time: seed.seeding_time };
}

/** Ends seeding early for finished downloads already verified in the library, most-seeded first, until about
 *  `bytes` are freed on the box. Used when a download has waited long for space (src/batches.mjs). */
export async function endSeedingEarly(env, bytes) {
  const recs = (await env.DB.prepare("SELECT value FROM kv WHERE key LIKE 'push:%'").all()).results.map(r => JSON.parse(r.value))
    .filter(r => r.hash && r.cleanup?.waiting && !r.batch);
  if (!recs.length) return { freed: 0, removed: [] };
  const info = await getJson(env, 'dl', `/api/v2/torrents/info?hashes=${recs.map(r => r.hash).join('|')}`);
  const byHash = new Map((info.data || []).map(t => [t.hash, t]));
  const order = recs.filter(r => byHash.has(r.hash)).sort((a, b) => (byHash.get(b.hash).ratio || 0) - (byHash.get(a.hash).ratio || 0));
  let freed = 0;
  const removed = [];
  for (const rec of order) {
    if (freed >= bytes) break;
    const t = byHash.get(rec.hash);
    if (await verifyOnHostbrr(env, rec)) continue;                   // only what's safely in the library
    const del = await qbPost(env, '/api/v2/torrents/delete', `hashes=${rec.hash}&deleteFiles=true`);
    if (del.error) continue;
    rec.cleanup = { removed: now(), early: true, ratio: t.ratio, seeding_time: t.seeding_time };
    await kvSet(env.DB, `push:${rec.job}`, rec);
    freed += t.size || 0; removed.push(rec.name);
  }
  return { freed, removed };
}

// Called once a push job has finished (webhook, admin page poll or cron). Idempotent.
// Fast part (listing scan, verify, cleanup), then it asks for a full sync, which the cron runs within a minute
// (a full sync can outlive a webhook's time budget).
export async function finishPush(env, jobId, status, { sync = true } = {}) {
  const key = `push:${jobId}`;
  const rec = await kvGet(env.DB, key);
  if (!rec || rec.finished || (rec.claimed && now() - rec.claimed < 300)) return rec;
  rec.claimed = now();
  await kvSet(env.DB, key, rec);
  if (rec.batch) {                                                   // one part of a download in parts (src/batches.mjs)
    if (status === 'completed') await scanOnly(env);
    rec.cleanup = await batchSent(env, rec, status);
  } else if (status === 'completed') {
    const settings = await getSettings(env.DB);
    if (settings.cleanup && rec.hash) {
      await scanOnly(env);
      const problem = await verifyOnHostbrr(env, rec);
      rec.cleanup = problem ? { error: problem } : await cleanupIfDone(env, rec, settings);
    }
  } else if (rec.hash && !rec.batch) {
    await env.DB.prepare('DELETE FROM kv WHERE key=?').bind(`pushed:${rec.hash}`).run();   // allow a retry
  }
  rec.finished = now(); rec.status = status;
  await kvSet(env.DB, key, rec);
  if (status === 'completed' && sync) await requestSync(env);
  return rec;
}

// Cron fallback: finish pushes whose webhook was missed.
export async function finishPending(env) {
  const rows = (await env.DB.prepare("SELECT value FROM kv WHERE key LIKE 'push:%'").all()).results;
  let n = 0;
  const settings = await getSettings(env.DB);
  for (const r of rows) {
    const rec = JSON.parse(r.value);
    if (rec.cleanup?.waiting && settings.cleanup && now() - rec.at < 60 * 86400) {   // seeding before removal
      rec.cleanup = await cleanupIfDone(env, rec, settings);
      await kvSet(env.DB, `push:${rec.job}`, rec); n++;
      continue;
    }
    if (rec.finished || now() - rec.at > 7 * 86400) continue;
    const j = await getJson(env, 'rs', `/api/job/${rec.job}`);
    const status = j.data?.history?.status;
    if (status && status !== 'running' && status !== 'pending') { await finishPush(env, rec.job, status, { sync: false }); n++; }
  }
  return n;
}

export async function handlePipeline(request, env, ctx, path) {
  const db = env.DB;
  if (path === '/admin/api/pipeline' && request.method === 'GET') {
    const [media, qb, hist, state] = await Promise.all([
      mediaEntries(env),
      getJson(env, 'dl', '/api/v2/torrents/info?sort=added_on&reverse=true'),
      getJson(env, 'rs', '/api/history'),
      getJson(env, 'dl', '/api/v2/transfer/info')
    ]);
    const torrents = Array.isArray(qb.data) ? qb.data.map(t => ({
      hash: t.hash, name: t.name, progress: t.progress, state: t.state, size: t.size, dlspeed: t.dlspeed, upspeed: t.upspeed,
      eta: t.eta, num_seeds: t.num_seeds, added_on: t.added_on, completion_on: t.completion_on, content_path: t.content_path,
      ratio: t.ratio, seeding_time: t.seeding_time
    })) : [];
    const batches = await batchStates(db);
    for (const t of torrents) if (batches.has(t.hash)) t.batch = batches.get(t.hash);
    const items = [];
    const dups = new Map((await db.prepare("SELECT key, value FROM kv WHERE key LIKE 'dup:%'").all()).results.map(r => [r.key.slice(4), JSON.parse(r.value)]));
    for (const e of media.data || []) {
      const lib = await db.prepare("WITH n(v) AS (SELECT ?) SELECT count(*) n, sum(missing_since IS NULL) live FROM files, n WHERE (path = n.v OR substr(path, 1, length(n.v) + 1) = n.v || '/') AND kind IN ('movie','episode')").bind(e.name).first();
      const torrent = torrents.find(t => readyName(t) === e.name || t.name === e.name);
      items.push({ name: e.name, is_dir: e.is_dir, size: e.is_dir ? torrent?.size ?? null : e.size, kind: guessKind(e.name), in_library: lib?.live || 0, hash: torrent?.hash || null,
        ratio: torrent?.ratio ?? null, seeding_time: torrent?.seeding_time ?? null, upspeed: torrent?.upspeed || 0,
        dup: torrent && dups.get(torrent.hash)?.note ? dups.get(torrent.hash) : null, batch: torrent?.batch || null });
    }
    const recs = Object.fromEntries((await db.prepare("SELECT key, value FROM kv WHERE key LIKE 'push:%'").all()).results.map(r => [r.key.slice(5), JSON.parse(r.value)]));
    const jobs = Array.isArray(hist.data) ? hist.data.slice(0, 15).map(h => ({
      id: h.id, status: h.status, source: h.source, destination: h.destination.replace(/^[^:]*:.*?\/(media|downloads)\//, '$1/'), created_at: h.created_at, completed_at: h.completed_at, exit_code: h.exit_code,
      auto: recs[h.id]?.auto || false, cleanup: recs[h.id]?.cleanup || null
    })) : [];
    const last = JSON.parse((await db.prepare("SELECT value FROM kv WHERE key='last_sync'").first())?.value || '{}');
    return json({
      settings: await getSettings(db), storage: await storage(env),
      items, torrents: torrents.filter(t => t.progress < 1 || !items.some(i => i.hash === t.hash)), jobs,
      transfer: state.data ? { dl: state.data.dl_info_speed, up: state.data.up_info_speed } : null,
      errors: { rs: media.error || hist.error || null, dl: qb.error || null },
      last_sync: last.at || null
    });
  }

  if (path === '/admin/api/settings' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const s = await getSettings(db);
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === 'boolean' && typeof b[k] === 'boolean') s[k] = b[k];
      if (typeof DEFAULTS[k] === 'number' && b[k] !== undefined) {
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < LIMITS[k][0] || v > LIMITS[k][1]) return json({ error: `${k} must be between ${LIMITS[k][0]} and ${LIMITS[k][1]}` }, 400);
        s[k] = v;
      }
    }
    await kvSet(db, 'pipeline_settings', s);
    if (s.auto) ctx.waitUntil(autoPipeline(env));
    return json(s);
  }

  if (path === '/admin/api/push' && request.method === 'POST') {
    const { name, kind } = await request.json().catch(() => ({}));
    if (!PRESET[kind]) return json({ error: 'kind must be movie or tv' }, 400);
    const media = await mediaEntries(env);
    if (media.error) return json({ error: media.error }, 502);
    if (!(media.data || []).some(e => e.name === name) || String(name).includes('/')) return json({ error: 'No such download in ~/media' }, 404);
    const qb = await getJson(env, 'dl', '/api/v2/torrents/info');
    const t = (qb.data || []).find(x => readyName(x) === name);
    const r = await startPush(env, { name, kind, hash: t?.hash || null });
    return r.error ? json({ error: r.error }, 502) : json({ job: r.data.job });
  }

  let m;
  if ((m = /^\/admin\/api\/job\/(\d+)$/.exec(path)) && request.method === 'GET') {
    const r = await getJson(env, 'rs', `/api/job/${m[1]}`);
    if (r.error) return json({ error: r.error }, 502);
    const h = r.data.history || {};
    const lines = (r.data.live_output?.length ? r.data.live_output : String(h.output || '').split('\n')).filter(Boolean);
    const rec = await kvGet(db, `push:${m[1]}`);
    if (rec && !rec.finished && h.status && h.status !== 'running' && h.status !== 'pending') ctx.waitUntil(finishPush(env, Number(m[1]), h.status));
    return json({ id: Number(m[1]), status: h.status, exit_code: h.exit_code, tail: lines.slice(-6), synced: !!rec?.finished || h.status === 'completed', cleanup: rec?.cleanup || null });
  }

  if (path === '/admin/api/remove' && request.method === 'POST') {
    const { hash } = await request.json().catch(() => ({}));
    if (!/^[0-9a-f]{40}$/.test(hash || '')) return json({ error: 'bad hash' }, 400);
    const r = await qbPost(env, '/api/v2/torrents/delete', `hashes=${hash}&deleteFiles=true`);
    if (!r.error) await db.prepare("DELETE FROM kv WHERE key IN (?, ?, ?)").bind('dup:' + hash, 'ident:' + hash, 'batch:' + hash).run();
    return r.error ? json({ error: r.error }, 502) : json({ ok: true });
  }

  if (path === '/admin/api/sync' && request.method === 'POST') {
    await requestSync(env);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export async function verifySigned(request, env, header) {
  if (request.method !== 'POST' || !env.RSYNC_WEBHOOK_SECRET) return { res: new Response('Not found', { status: 404 }) };
  const body = await request.text();
  if (body.length > 10000) return { res: new Response('Too large', { status: 413 }) };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RSYNC_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get(header) || '');
  const ok = sig && await crypto.subtle.verify('HMAC', key, Uint8Array.from(sig[1].match(/../g), h => parseInt(h, 16)), new TextEncoder().encode(body));
  if (!ok) return { res: new Response('Bad signature', { status: 401 }) };
  try { return { body: JSON.parse(body) }; } catch { return { res: new Response('Bad JSON', { status: 400 }) }; }
}

// rsync-web calls this when any job finishes (-webhook, signed with RSYNC_WEB_WEBHOOK_SECRET).
// Pipeline pushes get finished (sync, verify, cleanup); other copies into the library just start a sync.
export async function handleRsyncHook(request, env, ctx) {
  const v = await verifySigned(request, env, 'X-Rsync-Web-Signature');
  if (v.res) return v.res;
  const job = v.body;
  if (!Number.isInteger(job.id)) return new Response('Bad job', { status: 400 });
  const reply = s => new Response(JSON.stringify({ sync: s }), { headers: { 'Content-Type': 'application/json' } });
  const rec = await kvGet(env.DB, `push:${job.id}`);
  if (rec && !rec.finished) { ctx.waitUntil(finishPush(env, job.id, job.status)); return reply('started'); }
  // Any other finished copy may have been into the library: sync (cheap when nothing changed).
  if (!rec && job.status === 'completed' && !(await kvGet(env.DB, `pushsync:${job.id}`))) {
    await kvSet(env.DB, `pushsync:${job.id}`, 1);
    await requestSync(env);
    return reply('started');
  }
  return reply('skipped');
}

// qBittorrent's "run on torrent finished" and "run on torrent added" script pokes this (signed with the same secret).
// Added: check at once that everything downloading still fits (src/batches.mjs) instead of at the next minute.
export async function handleQbitHook(request, env, ctx) {
  const v = await verifySigned(request, env, 'X-Watch-Signature');
  if (v.res) return v.res;
  if (v.body.event === 'added') ctx.waitUntil(batchTick(env).then(b => console.log('batches (added)', JSON.stringify(b)), e => console.error('batches', e.message)));
  else ctx.waitUntil(batchTick(env).catch(e => ({ error: e.message })).then(b => autoPipeline(env).then(r => console.log('auto pipeline', JSON.stringify([b, r])))));
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
