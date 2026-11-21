// Downloads bigger than the download box's free space, in parts.
//
// A torrent with many files (a season pack, a complete series) that doesn't fit is downloaded a batch of files at a time:
//   pick the files that fit (qBittorrent file priorities) -> they finish -> stop the torrent -> rsync-web copies them to the
//   library and removes them from the box (push with remove_source) -> check they're in the library -> skip them, pick
//   the next batch, recheck (so the torrent no longer offers the removed files) and start again -> ... -> remove the torrent.
// A file that alone is bigger than the free space can't be done this way: the torrent is stopped and shown as too big.
// Torrents that need space wait in a queue, in the order they started waiting (`queued_at`). Each minute the queue is
// looked at oldest first, and each torrent that starts a part reserves that space for the ones after it, so two never
// count on the same free space. A smaller part may go ahead of an older one that doesn't fit yet, but once the oldest
// has waited HOLD and would fit when other downloads leave the box, nothing else in the queue starts until it does, and
// finished downloads that are still seeding (and are safely in the library) stop seeding early to make the room.
// Only this minute check starts parts (also the next part of a pack once a copy is done), so the order holds.
// Batched torrents don't seed once their files have left the box.
//
// State per torrent in kv `batch:<hash>`: { hash, name, kind, step, current: [file index], sent: [file index], ... }
//   step: downloading | sending | next (part sent, queued for the next) | waiting | too_big | error | done
//   waiting: will fit once other downloads leave the box; too_big: wouldn't fit even then.
import { getJson, kvGet, kvSet, guessKind, readyName, endSeedingEarly } from './pipeline.mjs';
import { VIDEO_EXT } from './library/parse.mjs';
import { cfg } from './config.mjs';

export const MARGIN = 5e9;          // always leave this much free on the box
export const HOLD = 12 * 3600;      // after this long at the head of the queue, the oldest waiting torrent goes first
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
  return { chosen, bytes: used, remaining: todo.length, largest: Math.max(0, ...todo.map(left)), smallest: Math.min(...todo.map(left)), oversize };
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

  // Forget torrents removed by hand; keep finished records a day for the Pipeline tab.
  for (const [h, b] of recs) {
    if (!byHash.has(h) && (b.step !== 'done' || now() - b.at > 86400)) { await db.prepare('DELETE FROM kv WHERE key = ?').bind('batch:' + h).run(); recs.delete(h); }
  }
  const fresh = info.data.filter(t => activeDl(t) && t.total_size > 0 && !recs.has(t.hash) && !/meta/i.test(t.state || ''));
  // The queue: waiting for space (or too big for it, looked at again whenever the free space grows), or ready for the next part.
  const QUEUED = ['waiting', 'too_big', 'next'];
  const waiting = [...recs.values()].filter(b => QUEUED.includes(b.step));
  const ready = [...recs.values()].filter(b => b.step === 'downloading' && readyName(byHash.get(b.hash)));
  const out = [];
  // A part started right after a recheck: qBittorrent ignores that start while checking and leaves the torrent stopped.
  for (const b of recs.values()) {
    if (b.step !== 'downloading' || !b.start_pending) continue;
    const st = byHash.get(b.hash)?.state || '';
    if (/checking|meta|moving/i.test(st)) continue;                   // still checking: next minute
    if (/stopped|paused/i.test(st)) { await qbStart(env, b.hash); out.push({ name: b.name, started: true }); continue; }   // cleared once it's running
    delete b.start_pending; await kvSet(db, 'batch:' + b.hash, b);
  }
  if (!fresh.length && !waiting.length && !ready.length) return out.length ? { out } : { idle: true };

  // A batch finished downloading: stop the torrent and send its files.
  for (const b of ready) {
    const t = byHash.get(b.hash);
    await qbStop(env, b.hash);
    const r = await sendBatch(env, b, readyName(t));
    out.push({ name: b.name, sending: r.error ? null : r.job, error: r.error || undefined });
  }

  const free = await boxFree(env);
  if (free == null) return { out, error: 'box free space unknown' };
  const leftOf = new Map(info.data.filter(activeDl).map(t => [t.hash, t.amount_left || 0]));   // space still to be written
  const othersLeft = hash => [...leftOf].reduce((s, [h, n]) => h === hash ? s : s + n, 0);
  // What other downloads hold on the box now (freed when they're sent, or removed after seeding).
  const reclaim = hash => info.data.reduce((s, t) => t.hash === hash ? s : s + (t.completed || 0), 0);

  // The queue, oldest first, then new downloads that don't fit, biggest first.
  waiting.sort((a, b) => (a.queued_at || a.at) - (b.queued_at || b.at));
  fresh.sort((a, b) => (b.amount_left || 0) - (a.amount_left || 0));
  const head = waiting.find(b => b.step !== 'too_big' && byHash.has(b.hash));
  let hold = head && now() - (head.queued_at || head.at) > HOLD ? head : null;
  for (const t of [...waiting.map(b => byHash.get(b.hash)).filter(Boolean), ...fresh]) {
    const b = recs.get(t.hash);
    const budget = free - MARGIN - othersLeft(t.hash);
    if (!b && (t.amount_left || 0) <= budget) continue;            // fits: nothing to do
    if ((b?.step === 'too_big' || b?.step === 'waiting') && budget <= (b.budget || 0) + 1e9 && !hold) continue;   // no more room than last time
    const files = await getJson(env, 'dl', `/api/v2/torrents/files?hash=${t.hash}`);
    if (!Array.isArray(files.data) || !files.data.length) continue;
    const rec = b || { hash: t.hash, name: t.name, kind: guessKind(t.name), sent: [], sent_bytes: 0, files: files.data.length,
      total: files.data.reduce((s, f) => s + f.size, 0), batches: 0, started: now() };
    const r = await startBatch(env, rec, files.data, budget, { free, reclaim: reclaim(t.hash), held: hold && hold.hash !== t.hash ? hold : null });
    if (r.bytes > 0) leftOf.set(t.hash, r.bytes); else leftOf.delete(t.hash);
    if (hold && hold.hash === t.hash && r.bytes > 0) hold = null;  // the oldest got its space: the rest may follow
    out.push({ name: t.name, step: rec.step, files: r.chosen?.length });
  }
  // The oldest has waited HOLD and still has no room: end seeding early for downloads already in the library
  // (most-seeded first) to free what it needs. It starts at the next check, once qBittorrent has deleted them.
  if (hold) {
    const short = (hold.need || 0) - (free - MARGIN - othersLeft(hold.hash));
    if (short > 0) {
      const r = await endSeedingEarly(env, short);
      if (r.removed.length) out.push({ seeding_ended: r.removed, freed: r.freed, for: hold.name });
    }
  }
  return { out };
}

/** Selects the next batch, or stops the torrent and queues it (waiting / too big), and saves the record.
 *  ctx: { free, reclaim: bytes other downloads hold on the box, held: the queue's oldest torrent when it goes first } */
async function startBatch(env, rec, files, budget, { free, reclaim = 0, held = null }) {
  const plan = planBatch(files, rec.sent, budget);
  rec.at = now();
  if (!plan.remaining) return { bytes: 0 };
  const usable = gb(Math.max(0, budget));
  const big = plan.oversize.length === 1 ? `${plan.oversize[0].name} (${gb(plan.oversize[0].size)})` : `${plan.oversize.length} files (up to ${gb(plan.largest)})`;
  if (!plan.chosen.length || held) {
    await qbStop(env, rec.hash);
    if (held) delete rec.budget; else rec.budget = budget;          // held ones are looked at again as soon as the hold ends
    rec.queued_at = rec.queued_at || now();
    rec.need = plan.smallest;                                        // the least space that lets it go on
    const reachable = free - MARGIN + reclaim;                       // once other downloads leave the box
    if (held) { rec.step = 'waiting'; rec.note = `Queued behind ${held.name}, which has waited longest for space`; }
    else if (rec.need <= reachable) { rec.step = 'waiting'; rec.note = `Waiting for other downloads to leave the box: next file ${gb(rec.need)}, ${usable} usable now`; }
    else if (rec.sent.length) { rec.step = 'too_big'; rec.note = `Everything else is sent. ${big} doesn’t fit, even once other downloads leave the box (${gb(Math.max(0, reachable))}). It continues if space frees up, or Remove from box.`; }
    else { rec.step = 'too_big'; rec.note = `Too big for the box: ${big}, ${gb(Math.max(0, reachable))} at most once other downloads leave. It continues if space frees up; or Remove from box and pick a smaller release.`; }
    await kvSet(env.DB, 'batch:' + rec.hash, rec);
    return { bytes: 0 };
  }
  delete rec.queued_at; delete rec.budget; delete rec.need;
  const chosen = new Set(plan.chosen);
  const all = files.map(fileIndex);
  await setPrio(env, rec.hash, all.filter(i => !chosen.has(i)), 0);
  await setPrio(env, rec.hash, plan.chosen, 1);
  if (rec.batches > 0 || rec.step === 'waiting' || rec.step === 'too_big' || rec.step === 'next') {
    // The removed files' pieces are still marked as had; a recheck clears that before peers ask for them.
    await qbPost(env, '/api/v2/torrents/recheck', 'hashes=' + rec.hash);
    rec.start_pending = now();   // qBittorrent drops a start sent while it's checking: batchTick starts it once the check is done
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
  // The next part is started by the minute check, in queue order with any other torrent waiting for space.
  rec.step = 'next'; rec.queued_at = now(); rec.at = now();
  rec.note = `Part ${rec.batches} sent (${gb(rec.sent_bytes)} of ${gb(rec.total)}); next part within a minute`;
  await kvSet(env.DB, 'batch:' + rec.hash, rec);
  return { next: true };
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
