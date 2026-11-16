// Library management for /admin: find files, spot clutter (samples, short clips, duplicate copies),
// move files to a trash folder on the storage host (storage/manage.php), restore them, empty the trash.
//
// A delete covers every path of a file (the media/ and downloads/complete/ copies are often hard links of
// the same data), plus its subtitles; folders left holding only small leftovers go to the trash with it.
// Nothing is deleted while it is still on the download box (in qBittorrent, in ~/media, or being copied),
// so the pipeline's verify-then-clean-up step never sees a file vanish underneath it.
// After a delete the library is updated straight away (no listing scan); the next sync confirms it.
import { sidecars } from './youtube.mjs';
import { cfg } from './config.mjs';
import { getJson, mediaEntries, kvGet, kvSet } from './pipeline.mjs';
import { originHeaders, fetchListing } from './origin.mjs';
import { applyListing, log } from './library/sync.mjs';
import { rebuildItems } from './library/catalog.mjs';

export const TRASH_DAYS = 14;
const TICKS_PER_MIN = 600_000_000;
const SHORT_MIN = { movie: 20, episode: 3 };    // shorter than this is usually a sample, trailer or broken file
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const chunks = (a, n = 50) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------- the storage host ----------

async function originPost(env, body) {
  if (!env.MANAGE_SECRET) return { error: 'MANAGE_SECRET is not set' };
  const text = JSON.stringify({ ...body, ts: now() });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.MANAGE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    const r = await fetch(env.ORIGIN_BASE_URL.replace(/\/?$/, '/') + 'manage.php', {
      method: 'POST', body: text, signal: AbortSignal.timeout(60000),
      headers: originHeaders(env, { 'Content-Type': 'application/json', 'X-Watch-Signature': 'sha256=' + sig })
    });
    const d = await r.json().catch(() => ({ error: `${cfg().storageName}: HTTP ${r.status}` }));
    return r.ok && !d.error ? { data: d } : { error: d.error || `${cfg().storageName}: HTTP ${r.status}`, detail: d };
  } catch (e) { return { error: cfg().storageName + ': ' + e.message }; }
}

// ---------- reading the library ----------

const FILE_SQL = `SELECT f.id, f.root, f.path, f.library, f.kind, f.size, f.duration_ticks, f.probe, f.parsed, f.movie_id, f.series_key,
    f.season, f.episode, f.episode_end, f.match_status, f.added_at, m.title AS movie_title, m.year AS movie_year, s.title AS series_title,
    (SELECT count(*) FROM file_paths p WHERE p.file_id = f.id) AS npaths
  FROM files f LEFT JOIN movies m ON m.tmdb_id = f.movie_id LEFT JOIN series s ON f.series_key = 'tmdb:' || s.tmdb_id
  WHERE f.missing_since IS NULL`;

const pad = n => String(n).padStart(2, '0');

function shape(r) {
  const p = parse(r.parsed) || {};
  const probe = parse(r.probe);
  const video = (probe?.streams || []).find(s => s.type === 'Video');
  const top = r.path.split('/')[0];
  let title, group;
  if (r.library === 'youtube') {
    title = p.title ? `${p.title}${p.channel ? ` · ${p.channel}` : ''}` : top;
    group = 'yt:' + (p.ytid || r.id);
  } else if (r.library === 'movies') {
    title = r.movie_title ? `${r.movie_title}${r.movie_year ? ` (${r.movie_year})` : ''}` : p.title ? `${p.title}${p.year ? ` (${p.year})` : ''}` : top;
    group = r.movie_id ? 'movie:' + r.movie_id : 'path:' + r.root + '/' + top;
  } else {
    title = r.series_title || p.series || top;
    group = r.series_key || 'path:' + r.root + '/' + top;
  }
  return {
    id: r.id, root: r.root, path: r.path, library: r.library, kind: r.kind, size: r.size, title, group,
    minutes: r.duration_ticks ? Math.round(r.duration_ticks / TICKS_PER_MIN * 10) / 10 : null,
    height: video?.height || null, width: video?.width || null, codec: video?.codec || null, copies: r.npaths,
    label: r.library === 'tv' && r.season != null && r.episode != null ? `S${pad(r.season)}E${pad(r.episode)}${r.episode_end ? '-E' + pad(r.episode_end) : ''}` : null,
    part: p.part || null, movie_id: r.movie_id, series_key: r.series_key, season: r.season, episode: r.episode, added_at: r.added_at
  };
}

async function withWatch(db, files) {
  const by = new Map(files.map(f => [f.id, f]));
  for (const ids of chunks([...by.keys()])) {
    const rows = (await db.prepare(`SELECT p.item_id, u.username, p.position_ticks, p.played, p.last_played, f.duration_ticks AS runtime_ticks
      FROM progress p JOIN users u ON u.id = p.user_id LEFT JOIN files f ON f.id = p.item_id
      WHERE p.item_id IN (${ids.map(() => '?')}) AND (p.played = 1 OR p.position_ticks > 0)`).bind(...ids).all()).results;
    for (const r of rows) {
      const f = by.get(r.item_id);
      (f.watch ||= []).push({ user: r.username, played: !!r.played, pct: r.runtime_ticks ? Math.min(99, Math.round(r.position_ticks / r.runtime_ticks * 100)) : null,
        recent: !!r.last_played && now() - r.last_played < 900 });
    }
  }
  return files;
}

async function filesWhere(db, where, binds = [], limit = 500) {
  const rows = (await db.prepare(`${FILE_SQL} AND ${where} ORDER BY f.root, f.path LIMIT ${limit}`).bind(...binds).all()).results;
  return withWatch(db, rows.map(shape));
}

async function filesByIds(db, ids) {
  const out = [];
  for (const c of chunks(ids)) out.push(...(await db.prepare(`${FILE_SQL} AND f.id IN (${c.map(() => '?')})`).bind(...c).all()).results.map(shape));
  return withWatch(db, out);
}

export async function search(db, q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  return filesWhere(db, `(f.path LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')`, [like, like, like], 400);
}

// Several files of the same movie (or episode). "copies" when they're all about the same length and
// not numbered parts; otherwise probably parts or different cuts.
export function duplicateGroups(files) {
  const groups = new Map();
  for (const f of files) {
    const k = f.library === 'movies' ? (f.movie_id ? 'm:' + f.movie_id : null) : (f.series_key && f.episode != null ? `e:${f.series_key}:${f.season}:${f.episode}` : null);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const out = [];
  for (const files of groups.values()) {
    if (files.length < 2) continue;
    const mins = files.map(f => f.minutes || 0), max = Math.max(...mins);
    const copies = !files.some(f => f.part) && max > 0 && mins.every(m => m >= max * 0.97);
    files.sort((a, b) => Math.max(b.height || 0, (b.width || 0) * 9 / 16) - Math.max(a.height || 0, (a.width || 0) * 9 / 16) || b.size - a.size);
    out.push({ title: files[0].title + (files[0].label ? ' ' + files[0].label : ''), copies, files });
  }
  return out.sort((a, b) => b.copies - a.copies || a.title.localeCompare(b.title));
}

export async function suggestions(db) {
  const samples = await filesWhere(db, "f.kind = 'sample'");
  const extras = await filesWhere(db, "f.kind = 'extra'");
  const short = await filesWhere(db, `f.kind IN ('movie','episode') AND f.library != 'youtube' AND f.duration_ticks > 0 AND f.duration_ticks <
    (CASE f.kind WHEN 'movie' THEN ${SHORT_MIN.movie} ELSE ${SHORT_MIN.episode} END) * ${TICKS_PER_MIN}`);
  const multi = await filesWhere(db, `f.kind IN ('movie','episode') AND (
      (f.library = 'movies' AND f.movie_id IN (SELECT movie_id FROM files WHERE kind = 'movie' AND missing_since IS NULL AND movie_id IS NOT NULL GROUP BY movie_id HAVING count(*) > 1))
   OR (f.library = 'tv' AND f.match_status = 'matched' AND EXISTS (SELECT 1 FROM files g WHERE g.id != f.id AND g.missing_since IS NULL AND g.kind = 'episode'
        AND g.series_key = f.series_key AND g.season = f.season AND g.episode = f.episode)))`, [], 800);
  return { samples, extras, short, duplicates: duplicateGroups(multi), short_minutes: SHORT_MIN };
}

// ---------- deleting ----------

async function pathsFor(db, files) {
  const ids = files.map(f => f.id);
  const out = new Map(files.map(f => [f.id, { videos: [[f.root, f.path]], subs: [], extra: [] }]));
  for (const c of chunks(ids)) {
    for (const r of (await db.prepare(`SELECT file_id, root, path FROM file_paths WHERE file_id IN (${c.map(() => '?')})`).bind(...c).all()).results) {
      const e = out.get(r.file_id);
      if (!e.videos.some(([a, b]) => a === r.root && b === r.path)) e.videos.push([r.root, r.path]);
    }
    for (const r of (await db.prepare(`SELECT file_id, root, path FROM subtitles WHERE file_id IN (${c.map(() => '?')})`).bind(...c).all()).results)
      out.get(r.file_id).subs.push([r.root, r.path]);
  }
  // YouTube videos' metadata, thumbnail and poster go with them (missing ones are just skipped by manage.php).
  for (const f of files) if (f.library === 'youtube') for (const p of Object.values(sidecars(f.path))) out.get(f.id).extra.push([f.root, p]);
  return out;
}

// Names still on the download box: in qBittorrent, in ~/media, or in a copy that hasn't finished.
async function boxNames(env) {
  const [qb, media] = await Promise.all([getJson(env, 'dl', '/api/v2/torrents/info'), mediaEntries(env)]);
  if (qb.error || media.error) return { error: qb.error || media.error };
  const names = new Map();
  for (const t of qb.data || []) {
    names.set(t.name, 'is still in qBittorrent');
    const p = String(t.content_path || '');
    const save = cfg().boxMediaPath;
    if (p.startsWith(save)) names.set(p.slice(save.length).split('/')[0], 'is still in qBittorrent');
  }
  for (const e of media.data || []) if (!names.has(e.name)) names.set(e.name, 'is still in the download box’s media folder');
  for (const r of (await env.DB.prepare("SELECT value FROM kv WHERE key LIKE 'push:%'").all()).results) {
    const rec = parse(r.value);
    if (rec && !rec.finished && now() - rec.at < 7 * 86400) names.set(rec.name, `is being copied to ${cfg().storageName} right now`);
  }
  return { names };
}

export async function planDelete(env, ids) {
  const db = env.DB;
  ids = [...new Set((ids || []).filter(id => /^[0-9a-f]{32}$/.test(id)))].slice(0, 500);
  const files = await filesByIds(db, ids);
  if (!files.length) return { error: 'Those files are no longer in the library.' };
  const paths = await pathsFor(db, files);
  const box = await boxNames(env);
  const blocked = [], warnings = [];
  const chosen = new Set(files.map(f => f.id));
  for (const f of files) {
    f.paths = paths.get(f.id).videos.map(p => p.join('/'));
    f.subtitles = paths.get(f.id).subs.length;
    if (!box.error) for (const [root, rel] of paths.get(f.id).videos) {
      const why = box.names.get(rel.split('/')[0]);
      if (why) { blocked.push({ id: f.id, name: f.path.split('/').at(-1), reason: `“${rel.split('/')[0]}” ${why}. Delete it there first, or wait until the pipeline has finished with it.` }); break; }
    }
    for (const w of f.watch || []) {
      if (w.recent && !w.played) warnings.push(`${w.user} is watching ${f.title}${f.label ? ' ' + f.label : ''} right now.`);
      else if (!w.played) warnings.push(`${w.user} ${w.pct ? `is ${w.pct}% into` : 'has started'} ${f.title}${f.label ? ' ' + f.label : ''}; that progress goes with it.`);
    }
  }
  // Titles that disappear completely.
  const groups = new Map();
  for (const f of files) if (f.kind === 'movie' || f.kind === 'episode') groups.set(f.library === 'movies' ? f.group : f.series_key || f.group, f);
  for (const [key, f] of groups) {
    const col = f.library === 'movies' ? 'movie_id' : 'series_key';
    const val = f.library === 'movies' ? f.movie_id : f.series_key;
    if (val == null) continue;
    const rest = (await db.prepare(`SELECT id FROM files WHERE ${col} = ? AND missing_since IS NULL AND kind IN ('movie','episode')`).bind(val).all()).results.filter(r => !chosen.has(r.id));
    if (!rest.length) warnings.push(`${f.title} will disappear from the library (no other files left).`);
  }
  return { files, blocked, warnings, box_error: box.error ? `Can’t check the download box (${box.error}), so nothing can be deleted right now.` : null,
    bytes: files.reduce((n, f) => n + f.size, 0) };
}

export async function executeDelete(env, ids, label) {
  const db = env.DB;
  const plan = await planDelete(env, ids);
  if (plan.error) return { status: 404, body: plan };
  if (plan.box_error) return { status: 503, body: { error: plan.box_error } };
  if (plan.blocked.length) return { status: 409, body: { error: 'Some files are still on the download box.', blocked: plan.blocked } };
  const paths = await pathsFor(db, plan.files);
  const list = [...paths.values()].flatMap(e => [...e.videos, ...e.subs, ...e.extra]);
  const r = await originPost(env, { op: 'trash', paths: list, label: String(label || '').slice(0, 300) });
  if (r.error) return { status: 502, body: { error: r.error, refused: r.detail?.refused } };
  const res = r.data;

  // Targeted library update: these files are gone; rebuild the client-facing items from what's left.
  const fileIds = plan.files.map(f => f.id), t = now();
  const stmts = [];
  for (const c of chunks(fileIds)) {
    const q = c.map(() => '?');
    stmts.push(db.prepare(`UPDATE files SET missing_since = ?, deleted_at = ? WHERE id IN (${q})`).bind(t, t, ...c));
    stmts.push(db.prepare(`DELETE FROM file_paths WHERE file_id IN (${q})`).bind(...c));
    stmts.push(db.prepare(`DELETE FROM subtitles WHERE file_id IN (${q})`).bind(...c));
  }
  await db.batch(stmts);
  // The sync refuses listings where a root shrank a lot (a broken mount looks like mass deletion);
  // lower the remembered counts by what was removed on purpose.
  const counts = (await kvGet(db, 'root_counts')) || {};
  for (const f of res.files || []) if (counts[f.root] && !/\.(jpe?g|json)$/i.test(f.rel)) counts[f.root]--;   // sidecars aren't listed
  for (const f of res.folders || []) if (counts[f.root]) counts[f.root] = Math.max(0, counts[f.root] - f.files);
  await kvSet(db, 'root_counts', counts);
  await kvSet(db, 'last_delete_at', t);
  // A deleted download can be downloaded and auto-sent again later.
  const tops = new Set(list.filter(([root]) => root === cfg().primary[cfg().libraryOf[root]]).map(([, rel]) => rel.split('/')[0]));
  for (const row of (await db.prepare("SELECT key, value FROM kv WHERE key LIKE 'push:%'").all()).results) {
    const rec = parse(row.value);
    if (rec?.hash && tops.has(rec.name)) await db.prepare('DELETE FROM kv WHERE key = ?').bind('pushed:' + rec.hash).run();
  }
  await log(db, 'delete', { batch: res.batch, label, files: (res.files || []).map(f => `${f.root}/${f.rel}`), folders: (res.folders || []).map(f => `${f.root}/${f.rel}`) });
  const items = await rebuildItems(db);
  return { status: 200, body: { batch: res.batch, moved: (res.files || []).length, folders: (res.folders || []).length, frees: res.frees,
    linked_elsewhere: res.linked_elsewhere || [], gone: res.gone || [], items } };
}

export async function restore(env, batch) {
  const r = await originPost(env, { op: 'restore', batch });
  if (r.error) return { status: 502, body: { error: r.error } };
  const scan = await applyListing(env.DB, await fetchListing(env));   // files keep their ids, so watch history comes back too
  await rebuildItems(env.DB);
  await log(env.DB, 'restore', { batch, restored: r.data.restored, conflicts: r.data.conflicts });
  return { status: 200, body: { ...r.data, scan } };
}

export async function purge(env, { batch, olderThanDays } = {}) {
  const r = await originPost(env, batch ? { op: 'purge', batch } : { op: 'purge', older_than: olderThanDays * 86400 });
  if (r.error) return { status: batch ? 502 : 200, body: { error: r.error } };
  if (r.data.purged?.length) {
    await env.DB.prepare("DELETE FROM kv WHERE key = 'storage_usage'").run();
    await log(env.DB, 'trash-emptied', r.data);
  }
  return { status: 200, body: r.data };
}

// Once a day from the cron: empty trash entries older than TRASH_DAYS.
export async function purgeOldTrash(env) {
  if (!env.MANAGE_SECRET) return null;
  const last = Number(await kvGet(env.DB, 'last_trash_purge') || 0);
  if (now() - last < 86400) return null;
  await kvSet(env.DB, 'last_trash_purge', now());
  return (await purge(env, { olderThanDays: TRASH_DAYS })).body;
}

export async function handleManage(request, env, ctx, path) {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const reply = r => json(r.body, r.status);
  if (path === '/admin/api/manage/search' && request.method === 'GET') return json({ files: await search(env.DB, url.searchParams.get('q')) });
  if (path === '/admin/api/manage/suggestions' && request.method === 'GET') return json(await suggestions(env.DB));
  if (path === '/admin/api/manage/plan' && request.method === 'POST') { const p = await planDelete(env, body.ids); return json(p, p.error ? 404 : 200); }
  if (path === '/admin/api/manage/delete' && request.method === 'POST') return reply(await executeDelete(env, body.ids, body.label));
  if (path === '/admin/api/manage/trash' && request.method === 'GET') {
    const r = await originPost(env, { op: 'list' });
    return r.error ? json({ error: r.error }, 502) : json({ ...r.data, days: TRASH_DAYS });
  }
  if (path === '/admin/api/manage/restore' && request.method === 'POST') return reply(await restore(env, String(body.batch || '')));
  if (path === '/admin/api/manage/purge' && request.method === 'POST') {
    if (body.all) return reply(await purge(env, { olderThanDays: 1 / 86400 }));
    return reply(await purge(env, { batch: String(body.batch || '') }));
  }
  return json({ error: 'not found' }, 404);
}
