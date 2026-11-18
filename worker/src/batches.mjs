// Downloads bigger than the download box's free space, in parts.
//
// A torrent with many files (a season pack, a complete series) that doesn't fit is downloaded a batch of files at a time:
//   pick the files that fit (qBittorrent file priorities) -> they finish -> stop the torrent -> rsync-web copies them to the
//   library and removes them from the box (push with remove_source) -> check they're in the library -> skip them, pick
//   the next batch, recheck (so the torrent no longer offers the removed files) and start again -> ... -> remove the torrent.
// A file that alone is bigger than the free space can't be done this way: the torrent is stopped and shown as too big.
// While other downloads still need the space, a torrent waits (stopped) for its next batch.
// Batched torrents don't seed once their files have left the box.
//
// State per torrent in kv `batch:<hash>`: { hash, name, kind, step, current: [file index], sent: [file index], ... }
//   step: downloading | sending | waiting | too_big | error | done
import { getJson, kvGet, kvSet, guessKind, readyName } from './pipeline.mjs';
import { VIDEO_EXT } from './library/parse.mjs';
import { cfg } from './config.mjs';

export const MARGIN = 5e9;          // always leave this much free on the box
const now = () => Math.floor(Date.now() / 1000);
const qbPost = (env, path, body) => getJson(env, 'dl', path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
const gb = n => (n / 1e9).toFixed(n < 10e9 ? 1 : 0) + ' GB';
const libraryRoot = kind => cfg().primary[kind === 'tv' ? 'tv' : 'movies'];

// qBittorrent 5 renamed pause/resume to stop/start.
async function qbStop(env, hash) { const r = await qbPost(env, '/api/v2/torrents/stop', 'hashes=' + hash); return r.status === 404 ? qbPost(env, '/api/v2/torrents/pause', 'hashes=' + hash) : r; }
async function qbStart(env, hash) { const r = await qbPost(env, '/api/v2/torrents/start', 'hashes=' + hash); return r.status === 404 ? qbPost(env, '/api/v2/torrents/resume', 'hashes=' + hash) : r; }
const setPrio = (env, hash, ids, p) => ids.length ? qbPost(env, '/api/v2/torrents/filePrio', `hash=${hash}&id=${ids.join('|')}&priority=${p}`) : { data: '' };

export async function boxFree(env) {
  const st = await getJson(env, 'rs', '/api/status');
  return Number.isFinite(st.data?.disk_free) ? st.data.disk_free : null;
}

const fileIndex = (f, i) => Number.isInteger(f.index) ? f.index : i;
const left = f => Math.max(0, Math.round(f.size * (1 - (f.progress || 0))));

/** The next files to download within `budget` bytes: partly downloaded ones first, then in name order. A file that
 *  doesn't fit is skipped for now (the rest carry on); `oversize` lists files bigger than the whole budget. */
export function planBatch(files, sent, budget) {
  const done = new Set(sent);
  const todo = files.map((f, i) => ({ ...f, i: fileIndex(f, i) })).filter(f => !done.has(f.i))
    .sort((a, b) => (b.progress > 0) - (a.progress > 0) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const chosen = [];
  let used = 0;
  for (const f of todo) {
    const n = left(f);
    if (used + n <= budget) { chosen.push(f.i); used += n; }
  }
  const oversize = todo.filter(f => left(f) > budget).map(f => ({ name: String(f.name).split('/').pop(), size: left(f) }));
  return { chosen, bytes: used, remaining: todo.length, largest: Math.max(0, ...todo.map(left)), oversize };
}

const activeDl = t => t.progress < 1 && !/^(stopped|paused)/i.test(t.state || '') && !/error|missing/i.test(t.state || '');

/** Every minute (and on qBittorrent's "finished" hook): start, advance and finish batched downloads. */
export async function batchTick(env) {
  const db = env.DB;
  const recs = new Map((await db.prepare("SELECT value FROM kv WHERE key LIKE 'batch:%'").all()).results.map(r => JSON.parse(r.value)).map(b => [b.hash, b]));
  const info = await getJson(env, 'dl', '/api/v2/torrents/info');
  if (info.error === 'not configured') return { idle: true };   // no download box
  if (!Array.isArray(info.data)) return { error: info.error };
  const byHash = new Map(info.data.map(t => [t.hash, t]));
  const out = [];

  // Forget torrents removed by hand; keep finished records a day for the Pipeline tab.
  for (const [h, b] of recs) {
    if (!byHash.has(h) && (b.step !== 'done' || now() - b.at > 86400)) { await db.prepare('DELETE FROM kv WHERE key = ?').bind('batch:' + h).run(); recs.delete(h); }
  }
  const fresh = info.data.filter(t => activeDl(t) && t.total_size > 0 && !recs.has(t.hash) && !/meta/i.test(t.state || ''));
  // Waiting for space, or left with a file too big for the space: looked at again whenever the free space has grown.
  const waiting = [...recs.values()].filter(b => b.step === 'waiting' || b.step === 'too_big');
  const ready = [...recs.values()].filter(b => b.step === 'downloading' && readyName(byHash.get(b.hash)));
  if (!fresh.length && !waiting.length && !ready.length) return { idle: true };

  // A batch finished downloading: stop the torrent and send its files.
  for (const b of ready) {
    const t = byHash.get(b.hash);
    await qbStop(env, b.hash);
    const r = await sendBatch(env, b, readyName(t));
    out.push({ name: b.name, sending: r.error ? null : r.job, error: r.error || undefined });
  }

  const free = await boxFree(env);
  if (free == null) return { out, error: 'box free space unknown' };
  const leftOf = new Map(info.data.filter(activeDl).map(t => [t.hash, t.amount_left || 0]));
  const othersLeft = hash => [...leftOf].reduce((s, [h, n]) => h === hash ? s : s + n, 0);

  // Waiting torrents first (oldest first), then new ones, biggest first.
  waiting.sort((a, b) => a.at - b.at);
  fresh.sort((a, b) => (b.amount_left || 0) - (a.amount_left || 0));
  for (const t of [...waiting.map(b => byHash.get(b.hash)).filter(Boolean), ...fresh]) {
    const b = recs.get(t.hash);
    const budget = free - MARGIN - othersLeft(t.hash);
    if (!b && (t.amount_left || 0) <= budget) continue;            // fits: nothing to do
    if (b?.step === 'too_big' && budget <= (b.budget || 0) + 1e9) continue;   // no more room than last time
    const files = await getJson(env, 'dl', `/api/v2/torrents/files?hash=${t.hash}`);
    if (!Array.isArray(files.data) || !files.data.length) continue;
    const rec = b || { hash: t.hash, name: t.name, kind: guessKind(t.name), sent: [], sent_bytes: 0, files: files.data.length,
      total: files.data.reduce((s, f) => s + f.size, 0), batches: 0, started: now() };
    const r = await startBatch(env, rec, files.data, budget, othersLeft(t.hash) > 0, free);
    leftOf.set(t.hash, r.bytes || 0);
    if (!(r.bytes > 0)) leftOf.delete(t.hash);
    out.push({ name: t.name, step: rec.step, files: r.chosen?.length });
  }
  return { out };
}

/** Selects the next batch (or stops the torrent to wait, or marks it too big) and saves the record. */
async function startBatch(env, rec, files, budget, othersBusy, free) {
  const plan = planBatch(files, rec.sent, budget);
  rec.at = now();
  if (!plan.remaining) return { bytes: 0 };
  const usable = gb(Math.max(0, budget));
  const big = plan.oversize.length === 1 ? `${plan.oversize[0].name} (${gb(plan.oversize[0].size)})` : `${plan.oversize.length} files (up to ${gb(plan.largest)})`;
  if (!plan.chosen.length) {
    await qbStop(env, rec.hash);
    rec.budget = budget;
    if (othersBusy) { rec.step = 'waiting'; rec.note = `Waiting for other downloads to free space (next file ${gb(plan.largest)}, ${usable} usable now)`; }
    else if (rec.sent.length) { rec.step = 'too_big'; rec.note = `Everything else is sent. ${big} doesn’t fit (${usable} usable): it continues if space frees up, or Remove from box.`; }
    else { rec.step = 'too_big'; rec.note = `Too big for the box: ${big}, ${usable} usable. It continues if space frees up; or Remove from box and pick a smaller release.`; }
    await kvSet(env.DB, 'batch:' + rec.hash, rec);
    return { bytes: 0 };
  }
  const chosen = new Set(plan.chosen);
  const all = files.map(fileIndex);
  await setPrio(env, rec.hash, all.filter(i => !chosen.has(i)), 0);
  await setPrio(env, rec.hash, plan.chosen, 1);
  if (rec.batches > 0 || rec.step === 'waiting' || rec.step === 'too_big') {
    // The removed files' pieces are still marked as had; a recheck clears that before peers ask for them.
    await qbPost(env, '/api/v2/torrents/recheck', 'hashes=' + rec.hash);
  }
  await qbStart(env, rec.hash);
  rec.batches++;
  rec.current = plan.chosen;
  rec.step = 'downloading';
  rec.note = `Downloading in parts: part ${rec.batches}, ${plan.chosen.length} of ${plan.remaining} remaining files (${gb(plan.bytes)})` +
    (plan.oversize.length ? ` · ${big} ${plan.oversize.length === 1 ? 'is' : 'are'} bigger than the free space: left for last` : '');
  delete rec.error;
  await kvSet(env.DB, 'batch:' + rec.hash, rec);
  return { chosen: plan.chosen, bytes: plan.bytes };
}

async function sendBatch(env, rec, name) {
  const r = await getJson(env, 'rs', '/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, preset: rec.kind === 'tv' ? 'TV' : 'Movies', remove_source: true }) });
  if (r.error) { rec.error = r.error; await kvSet(env.DB, 'batch:' + rec.hash, rec); return r; }
  await kvSet(env.DB, `push:${r.data.id}`, { job: r.data.id, name, kind: rec.kind, hash: null, batch: rec.hash, auto: true, at: now() });
  rec.step = 'sending'; rec.job = r.data.id; rec.at = now();
  rec.note = `Sending part ${rec.batches} to ${cfg().storageName}`;
  await kvSet(env.DB, 'batch:' + rec.hash, rec);
  return { job: r.data.id };
}

/** finishPush for a batch's copy job (after the library listing was scanned). Picks the next batch, or removes the torrent. */
export async function batchSent(env, pushRec, status) {
  const rec = await kvGet(env.DB, 'batch:' + pushRec.batch);
  if (!rec || rec.step !== 'sending') return { skipped: true };
  if (status !== 'completed') {
    rec.tries = (rec.tries || 0) + 1;
    rec.step = rec.tries >= 3 ? 'error' : 'downloading';    // 'downloading' + finished = send again next minute
    rec.note = rec.step === 'error' ? `Sending part ${rec.batches} failed ${rec.tries} times (rsync-web job ${pushRec.job})` : rec.note;
    await kvSet(env.DB, 'batch:' + rec.hash, rec);
    return { retry: rec.step !== 'error' };
  }
  // An older rsync-web ignores remove_source: the files would stay and the next part would never fit.
  const job = await getJson(env, 'rs', `/api/job/${pushRec.job}`);
  if (job.data?.history?.options && !String(job.data.history.options).includes('--remove-source-files')) {
    rec.step = 'error'; rec.note = 'rsync-web on the box is too old to remove sent files; update it (watchbox box release) and remove this torrent.';
    await kvSet(env.DB, 'batch:' + rec.hash, rec);
    return { error: rec.note };
  }
  const files = await getJson(env, 'dl', `/api/v2/torrents/files?hash=${rec.hash}`);
  if (!Array.isArray(files.data)) return { error: files.error };
  const cur = new Set(rec.current || []);
  const batch = files.data.filter((f, i) => cur.has(fileIndex(f, i)));
  for (const f of batch.filter(f => VIDEO_EXT.has(String(f.name).split('.').pop().toLowerCase()))) {
    const row = await env.DB.prepare('SELECT size FROM files WHERE root=? AND path=? AND missing_since IS NULL').bind(libraryRoot(rec.kind), f.name).first();
    if (!row || row.size !== f.size) {
      rec.step = 'error'; rec.note = `Part ${rec.batches} was copied but ${f.name} ${row ? 'has a different size' : 'isn’t'} in the library listing. The torrent is stopped; check ${cfg().storageName}.`;
      await kvSet(env.DB, 'batch:' + rec.hash, rec);
      return { error: rec.note };
    }
  }
  rec.sent = [...new Set([...rec.sent, ...cur])];
  rec.sent_bytes = files.data.filter((f, i) => rec.sent.includes(fileIndex(f, i))).reduce((s, f) => s + f.size, 0);
  rec.current = []; rec.tries = 0;
  if (rec.sent.length >= files.data.length) {
    await qbPost(env, '/api/v2/torrents/delete', `hashes=${rec.hash}&deleteFiles=true`);   // only empty folders and the part file are left
    rec.step = 'done'; rec.at = now(); rec.note = `Done: ${rec.batches} parts, ${gb(rec.sent_bytes)} sent`;
    await kvSet(env.DB, 'batch:' + rec.hash, rec);
    return { done: true };
  }
  const free = await boxFree(env);
  const info = await getJson(env, 'dl', '/api/v2/torrents/info');
  const othersLeft = (info.data || []).filter(t => t.hash !== rec.hash && activeDl(t)).reduce((s, t) => s + (t.amount_left || 0), 0);
  if (free == null) { rec.step = 'waiting'; await kvSet(env.DB, 'batch:' + rec.hash, rec); return { waiting: true }; }
  rec.step = 'sending-next';
  const r = await startBatch(env, rec, files.data, free - MARGIN - othersLeft, othersLeft > 0, free);
  return { next: r.chosen?.length || 0 };
}

/** For the Pipeline tab. */
export async function batchStates(db) {
  return new Map((await db.prepare("SELECT value FROM kv WHERE key LIKE 'batch:%'").all()).results.map(r => JSON.parse(r.value))
    .map(b => [b.hash, { step: b.step, note: b.note, sent: b.sent.length, files: b.files, sent_bytes: b.sent_bytes, total: b.total }]));
}

/** Note for Find / requests: a download of `size` bytes compared with the box's free space. */
export function sizeNote(size, free) {
  if (!(size > 0) || free == null || size <= free - MARGIN) return null;
  return `Bigger than the free space on the download box (${gb(Math.max(0, free - MARGIN))} usable). A pack of many files is downloaded in parts; a single file this big won’t fit.`;
}
