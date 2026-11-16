// Browser playback, shared by /admin (owner) and /me (guests). Both paths are behind Cloudflare Access, so the
// browser's Access cookie authenticates every request, including the <video> element's range requests: no Jellyfin
// token is ever put in a page.
//
// Two ways to play a file:
// - Direct: the browser fetches the file itself (byte ranges, straight from the storage host through the Worker). Used when the
//   browser can decode the container and codecs (MP4/H.264/AAC everywhere; MKV in Chromium; HEVC where supported).
// - Converted: the download box (watch-stream, app/freebsd/watch-stream) runs ffmpeg into an HLS stream, copying what
//   the browser can play and converting the rest (audio to AAC, old video to H.264). It reads the file through a
//   short-lived signed URL on this Worker (/play-src), so the box holds no the storage host credentials.
// Progress is saved to the viewer's own Jellyfin user (the same rules as the apps), so resume works across devices.
import { proxyFile, decodeText, srtToVtt } from './media.mjs';
import { originUrl, originHeaders } from './origin.mjs';
import { saveProgress } from './jellyfin.mjs';
import { upstreamFetch, tools } from './tools.mjs';
import { ageClause, allowedAge, fileAllowed } from './ages.mjs';

const TICKS = 10_000_000;
const SRC_TTL = 12 * 3600;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const enc = new TextEncoder();

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode('play-src|' + (env.TOOLS_SECRET || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function signedSrc(env, origin, fileId) {
  const exp = Math.floor(Date.now() / 1000) + SRC_TTL;
  return `${origin}/play-src/${fileId}?exp=${exp}&sig=${await hmac(env, fileId + '|' + exp)}`;
}

// Public route for watch-stream's ffmpeg: a signed, expiring read of one file.
export async function handlePlaySrc(request, env, fileId) {
  const url = new URL(request.url), exp = Number(url.searchParams.get('exp'));
  if (!env.TOOLS_SECRET || !(exp > Date.now() / 1000) || url.searchParams.get('sig') !== await hmac(env, fileId + '|' + exp)) return new Response('Forbidden', { status: 403 });
  const f = await env.DB.prepare('SELECT root, path, size FROM files WHERE id = ? AND missing_since IS NULL').bind(fileId).first();
  return f ? proxyFile(request, env, f) : new Response('Not found', { status: 404 });
}

async function box(env, path, init = {}) {
  const t = tools(env).find(x => x.id === 'dl');
  if (!t || !env.TOOLS_AUTHORIZATION) return { error: 'The download box isn’t connected.' };
  try {
    const r = await upstreamFetch(env, t, '/__watchstream' + path, init);
    const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    return r.ok ? { data: d, res: r } : { error: d?.error || `download box: HTTP ${r.status}`, status: r.status };
  } catch (e) { return { error: 'download box: ' + e.message }; }
}

// ---------- what to play ----------

function fileInfo(row) {
  const probe = parse(row.probe) || {};
  const v = (probe.streams || []).find(s => s.type === 'Video'), a = (probe.streams || []).find(s => s.type === 'Audio');
  return { id: row.id, container: probe.container || row.path.split('.').pop().toLowerCase(), video: v?.codec || null, audio: a?.codec || null,
    channels: a?.channels || null, height: v?.height || null, size: row.size, duration: row.duration_ticks ? row.duration_ticks / TICKS : null };
}

async function itemFor(env, id) {
  return env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
}

export async function watchData(env, id, userId, viewer = null) {
  const db = env.DB, item = await itemFor(env, id);
  if (!item || !allowedAge(viewer, item.age)) return null;
  const prog = userId ? await db.prepare('SELECT position_ticks, played FROM progress WHERE user_id = ? AND item_id = ?').bind(userId, id).first() : null;
  const base = { id: item.id, type: item.type, name: item.name, year: item.year, overview: item.overview, series: item.series_name, season: item.parent_index,
    episode: item.index_number, images: parse(item.images) || {}, runtime: item.runtime_ticks ? item.runtime_ticks / TICKS : null,
    resume: prog && !prog.played ? prog.position_ticks / TICKS : 0, played: !!prog?.played, series_id: item.series_id };
  if (item.type === 'Series') {
    const eps = (await db.prepare(`SELECT i.id, i.name, i.parent_index AS season, i.index_number AS episode, i.runtime_ticks, i.overview, p.position_ticks, p.played
      FROM items i LEFT JOIN progress p ON p.user_id = ? AND p.item_id = i.id WHERE i.series_id = ? AND i.type = 'Episode'
      ORDER BY i.parent_index, i.index_number`).bind(userId || '', id).all()).results;
    return { ...base, episodes: eps.map(e => ({ id: e.id, name: e.name, season: e.season, episode: e.episode, runtime: e.runtime_ticks ? e.runtime_ticks / TICKS : null,
      overview: (e.overview || '').slice(0, 240), played: !!e.played, pct: e.position_ticks && e.runtime_ticks && !e.played ? Math.round(e.position_ticks / e.runtime_ticks * 100) : 0 })) };
  }
  if (item.type !== 'Movie' && item.type !== 'Episode') return null;
  const files = [await db.prepare('SELECT id, path, size, probe, duration_ticks FROM files WHERE id = ? AND missing_since IS NULL').bind(item.file_id).first()];
  for (const v of parse(item.versions) || []) files.push(await db.prepare('SELECT id, path, size, probe, duration_ticks FROM files WHERE id = ? AND missing_since IS NULL').bind(v.id).first());
  const versions = files.filter(Boolean).map(f => ({ ...fileInfo(f), label: f.path.split('/').pop() }));
  const subs = (parse(item.subtitles) || []).map((s, n) => ({ n, label: (s.language || 'Subtitles') + (s.forced ? ' (forced)' : ''), lang: s.language || '' }));
  let next = null;
  if (item.type === 'Episode') {
    next = await db.prepare(`SELECT id, name, parent_index AS season, index_number AS episode FROM items WHERE series_id = ? AND type = 'Episode'
      AND (parent_index > ? OR (parent_index = ? AND index_number > ?)) ORDER BY parent_index, index_number LIMIT 1`)
      .bind(item.series_id, item.parent_index ?? 0, item.parent_index ?? 0, item.index_number ?? 0).first();
  }
  return { ...base, versions, subs, next };
}

// Library browsing for the player pages (movies and shows, newest first or by name).
export async function libraryItems(db, q, type, viewer = null) {
  q = String(q || '').trim().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  // Searching covers everything; browsing shows one shelf (movies, shows or YouTube), newest first.
  const shelf = type === 'Series' ? "type = 'Series'" : type === 'YouTube' ? "type = 'Movie' AND library = 'youtube'" : "type = 'Movie' AND library != 'youtube'";
  const ac = ageClause(viewer);
  const items = (await db.prepare(q
    ? `SELECT id, name, year, type, library FROM items i WHERE type IN ('Movie','Series') AND name LIKE ? ESCAPE '\\'${ac.sql} ORDER BY sort_name LIMIT 60`
    : `SELECT id, name, year, type, library FROM items i WHERE ${shelf}${ac.sql} ORDER BY date_created DESC LIMIT 60`).bind(...(q ? [like] : []), ...ac.args).all()).results;
  const counts = (await db.prepare(`SELECT CASE WHEN library = 'youtube' THEN 'YouTube' ELSE type END AS type, count(*) n FROM items i WHERE type IN ('Movie','Series')${ac.sql} GROUP BY 1`).bind(...ac.args).all()).results;
  return { items, counts: Object.fromEntries(counts.map(c => [c.type, c.n])) };
}

// ---------- routes under /me and /admin ----------

// viewer: the Jellyfin user row whose age limit applies (null for the owner); allow(itemOrFileId): extra restriction
// (share links only allow their one title).
export async function handlePlayer(request, env, ctx, { base, userId, page, viewer = null, allow = null }) {
  const url = new URL(request.url), path = url.pathname;
  let m;
  if (path === base + '/assets/hls.js') { const { asset } = await import('./assets.mjs'); return asset('hls.js'); }
  if (path === base + '/api/library') return json(await libraryItems(env.DB, url.searchParams.get('q'), url.searchParams.get('type'), viewer));
  if ((m = /\/watch\/([0-9a-f]{32})$/.exec(path)) && request.method === 'GET') {
    if (allow && !(await allow(m[1]))) return new Response('Not found', { status: 404 });
    const d = await watchData(env, m[1], userId, viewer);
    if (!d) return new Response('Not found', { status: 404 });
    return page(d);
  }
  // Files, subtitles and conversions are addressed by file id (a title's id is its main file's id).
  if ((m = /\/play\/([0-9a-f]{32})\/(?:file|sub\/\d+\.vtt|convert)$/.exec(path)) &&
      (!(await fileAllowed(env, viewer, m[1])) || (allow && !(await allow(m[1]))))) return new Response('Not found', { status: 404 });
  if ((m = /\/play\/([0-9a-f]{32})\/file$/.exec(path))) {
    const f = await env.DB.prepare('SELECT root, path, size FROM files WHERE id = ? AND missing_since IS NULL').bind(m[1]).first();
    return f ? proxyFile(request, env, f) : new Response('Not found', { status: 404 });
  }
  if ((m = /\/play\/([0-9a-f]{32})\/sub\/(\d+)\.vtt$/.exec(path))) {
    const item = await itemFor(env, m[1]);
    const sub = (parse(item?.subtitles) || [])[Number(m[2])];
    if (!sub) return new Response('Not found', { status: 404 });
    const res = await fetch(originUrl(env, sub.root, sub.path), { headers: originHeaders(env) });
    if (!res.ok) return new Response('Origin unavailable', { status: 502 });
    let text = decodeText(new Uint8Array(await res.arrayBuffer()));
    if (sub.format === 'srt') text = srtToVtt(text);
    else if (sub.format !== 'vtt') return new Response('Only SRT and VTT subtitles play in the browser', { status: 415 });
    return new Response(text, { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' } });
  }
  if ((m = /\/play\/([0-9a-f]{32})\/convert$/.exec(path)) && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const f = await env.DB.prepare('SELECT id, path, size, probe, duration_ticks FROM files WHERE id = ? AND missing_since IS NULL').bind(m[1]).first();
    if (!f) return json({ error: 'Not found' }, 404);
    const info = fileInfo(f);
    const r = await box(env, '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      src: await signedSrc(env, url.origin, f.id), file: f.path.split('/').pop(), video: b.video === 'copy' ? 'copy' : 'h264', audio: b.audio === 'copy' ? 'copy' : 'aac',
      hevc: info.video === 'hevc', duration: info.duration || 0, size: f.size }) });
    if (r.error) return json({ error: r.error }, r.status === 507 || r.status === 503 ? r.status : 502);
    return json({ sid: r.data.id, playlist: `${base}/play/hls/${r.data.id}/index.m3u8`, video: r.data.Video || r.data.video });
  }
  if ((m = /\/play\/hls\/([0-9a-f]{32})(?:\/(stop|index\.m3u8|init\.mp4|seg\d{5}\.m4s))?$/.exec(path))) {
    if (!m[2]) { const r = await box(env, '/s/' + m[1]); return r.error ? json({ error: r.error }, 404) : json(r.data); }
    if (m[2] === 'stop') { await box(env, `/s/${m[1]}/stop`); return json({ ok: true }); }
    const t = tools(env).find(x => x.id === 'dl');
    const r = await upstreamFetch(env, t, `/__watchstream/s/${m[1]}/${m[2]}`, { headers: request.headers.get('Range') ? { Range: request.headers.get('Range') } : {} }).catch(() => null);
    if (!r || !r.ok) return new Response('Not ready', { status: r?.status === 404 ? 404 : 502 });
    const h = new Headers({ 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': m[2].endsWith('.m3u8') ? 'no-store' : 'private, max-age=3600' });
    for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h.set(k, r.headers.get(k));
    return new Response(r.body, { status: r.status, headers: h });
  }
  if (path.endsWith('/play/progress') && request.method === 'POST') {
    if (!userId) return json({ saved: false });
    const b = await request.json().catch(() => ({}));
    if (!/^[0-9a-f]{32}$/.test(b.item || '')) return json({ error: 'bad item' }, 400);
    await saveProgress(env, { user_id: userId }, b.item, Math.round(Number(b.position || 0) * TICKS), { stopped: !!b.stopped });
    return json({ saved: true });
  }
  return null;
}

// ---------- page ----------

const fmt = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

export function watchHtml(d, { base, back, linked, share = null, canShare = false, shareDays = [], linkUsers = null }) {
  const img = (t, w) => d.images[t] ? `/Items/${d.id}/Images/${t}?maxWidth=${w}` : '';
  const title = d.type === 'Episode' ? `${d.series} · S${d.season}E${d.episode}` : d.name;
  if (d.type === 'Series') {
    const seasons = [...new Set(d.episodes.map(e => e.season))];
    return { title: d.name, body: `<a class=back href="${esc(back)}">← Library</a>
<div class=hero style="${d.images.Backdrop ? `background-image:linear-gradient(to top,var(--bg),rgb(0 0 0 / .35)),url('/Items/${d.id}/Images/Backdrop?maxWidth=1280')` : ''}"><h1>${esc(d.name)}</h1><p class=muted>${d.year || ''} · ${d.episodes.length} episodes</p></div>
${d.overview ? `<p class=ov>${esc(d.overview)}</p>` : ''}
${seasons.map(s => `<h2>${s === 0 ? 'Specials' : 'Season ' + s}</h2><div class=eps>${d.episodes.filter(e => e.season === s).map(e => `<a class=ep href="${base}/watch/${e.id}"><b>${e.episode ?? ''}</b><span><span class=en>${esc(e.name)}</span><small>${e.runtime ? Math.round(e.runtime / 60) + ' min' : ''}${e.played ? ' · <span class=good>watched</span>' : ''}</small>${e.pct ? `<i class=bar><i style="width:${e.pct}%"></i></i>` : ''}</span></a>`).join('')}</div>`).join('')}` };
  }
  const data = { id: d.id, type: d.type, base, resume: d.resume, runtime: d.runtime, versions: d.versions, subs: d.subs, linked, share: !!share, shareDays: canShare ? shareDays : [],
    next: d.next && !share ? { id: d.next.id, label: `S${d.next.season}E${d.next.episode} · ${d.next.name}` } : null };
  const backTo = share ? '' : `<a class=back href="${esc(d.type === 'Episode' ? `${base}/watch/${d.series_id}` : back)}">← ${d.type === 'Episode' ? esc(d.series) : 'Library'}</a>`;
  const link = !linked && linkUsers && linkUsers.length ? `<form id=linkme class="row hint"><span>Your progress isn’t saved yet. Save it as</span><select name=user>${linkUsers.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select><button>Save my progress there</button></form>`
    : !linked && !share ? '<p class=hint>Progress is remembered in this browser only.</p>' : '';
  return { title, body: `${backTo}
<div class=stage><video id=v controls playsinline preload=none ${img('Backdrop', 1280) ? `poster="${img('Backdrop', 1280)}"` : ''}>${d.subs.map(s => `<track kind=subtitles label="${esc(s.label)}" srclang="${esc(s.lang)}" src="${base}/play/${d.id}/sub/${s.n}.vtt">`).join('')}</video>
<div id=cover class=cover><div id=coverbtns><button id=start>▶ Play</button></div></div>
<div id=status class=status hidden></div></div>
<div class=info><div><h1>${esc(d.name)}</h1><p class=muted>${d.type === 'Episode' ? esc(title) + ' · ' : ''}${d.year || ''}${d.runtime ? ' · ' + Math.round(d.runtime / 60) + ' min' : ''}${d.played && !share ? ' · watched' : ''}</p></div>
<div class=row>${d.versions.length > 1 ? `<select id=ver aria-label=Version>${d.versions.map((v, i) => `<option value=${i}>${esc(v.label)}</option>`).join('')}</select>` : ''}${data.shareDays.length ? '<button type=button class=quiet id=sharebtn>Share link</button>' : ''}${data.next ? `<a class=btn href="${base}/watch/${d.next.id}">Next: ${esc(data.next.label)}</a>` : ''}</div></div>
<div id=sharebox></div>
${d.overview ? `<p class=ov>${esc(d.overview)}</p>` : ''}
${link}
${share ? `<p class=hint>Shared from a private library${share.expires_at ? ` · this link works until <span id=exp data-t="${share.expires_at}"></span>` : ''}. Please don’t pass it on.</p>` : ''}
<details class=tech><summary>Playback details</summary><p id=tech class=muted></p></details>
<script id=watch-data type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>` };
}

export const WATCH_CSS = `.back{display:inline-block;margin:0 0 12px;color:var(--muted);text-decoration:none}.back:hover{color:var(--text)}
.stage{position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:16/9;max-height:78vh;width:100%}
.stage video{width:100%;height:100%;display:block;background:#000}
.cover{position:absolute;inset:0;display:grid;place-items:center;background:rgb(0 0 0 / .45)}.cover div{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.cover button{font-size:16px;padding:12px 22px}
.status{position:absolute;left:12px;top:12px;right:12px;background:rgb(0 0 0 / .72);color:#eee;border-radius:10px;padding:10px 14px;font-size:14px;pointer-events:none}
.info{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:14px}.info h1{font-size:22px;margin:0}.info p{margin:4px 0 0}
.btn{display:inline-block;background:var(--surface-2);border:1px solid var(--line);color:var(--text);padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600}
.ov{max-width:75ch;line-height:1.6}.tech{margin-top:14px;font-size:13px}
.hero{border-radius:12px;padding:120px 22px 18px;background:var(--surface) center/cover;margin-bottom:12px}.hero h1{margin:0;font-size:26px}
.eps{display:grid;gap:8px}.ep{display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px;color:var(--text);text-decoration:none}
.ep:hover{border-color:var(--muted)}.ep b{color:var(--muted);text-align:right}.ep small{display:block;color:var(--muted)}.ep .en{font-weight:550}
.bar{display:block;height:3px;background:var(--line);border-radius:2px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
@media (max-width:640px){.stage{border-radius:0;margin:0 -16px;width:calc(100% + 32px)}}`;

// Client: decide direct vs converted, resume, save progress. No template-literal interpolation inside.
export const WATCH_JS = String.raw`
(() => {
if (!document.getElementById('watch-data')) return;   // show pages have no player
const D = JSON.parse(document.getElementById('watch-data').textContent), v = document.getElementById('v');
const V = { h264: 'avc1.640029', hevc: 'hvc1.1.6.L120.90', av1: 'av01.0.08M.08', vp9: 'vp09.00.40.08' };
const A = { aac: 'mp4a.40.2', mp3: 'mp4a.69', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac' };
const can = t => { try { return v.canPlayType(t) !== '' || (window.MediaSource && MediaSource.isTypeSupported(t)); } catch { return false; } };
const chromium = !!window.chrome || /Edg\//.test(navigator.userAgent);
let ver = D.versions[0], mode = null, hls = null, sid = null, statusTimer = null, saved = 0;
const st = document.getElementById('status'), tech = document.getElementById('tech');
const say = t => { st.hidden = !t; st.textContent = t || ''; };
function plan(f) {
  const vc = V[f.video], ac = f.audio ? A[f.audio] : null;
  const videoOk = vc && can('video/mp4; codecs="' + vc + '"');
  const audioOk = !f.audio || (ac && can('audio/mp4; codecs="' + ac + '"') && ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'].includes(f.audio));
  const container = ['mp4', 'm4v', 'mov', 'webm'].includes(f.container) || (f.container === 'mkv' && chromium);
  return { direct: !!(videoOk && audioOk && container), video: videoOk ? 'copy' : 'h264', audio: audioOk && ['aac', 'mp3'].includes(f.audio) ? 'copy' : 'aac' };
}
function describe(f, p, how) {
  tech.textContent = (f.container || '?').toUpperCase() + ' · ' + (f.video || '?') + (f.height ? ' ' + f.height + 'p' : '') + ' · ' + (f.audio || 'no audio') + (f.channels ? ' ' + f.channels + 'ch' : '') +
    ' — ' + (how === 'direct' ? 'playing the original file directly.' : 'converted on the download box (' + (p.video === 'copy' ? 'video copied' : 'video converted to H.264') + ', ' + (p.audio === 'copy' ? 'audio copied' : 'audio converted to AAC') + ').');
}
async function post(path, body) { const r = await fetch(D.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json().catch(() => ({ error: 'Your sign-in expired. Reload the page.' })); if (!r.ok || d.error) throw new Error(d.error || r.status); return d; }
function stopConvert() { if (sid) { navigator.sendBeacon(D.base + '/play/hls/' + sid + '/stop'); sid = null; } if (hls) { hls.destroy(); hls = null; } clearInterval(statusTimer); }
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function convert(at) {
  const p = plan(ver);
  say('Preparing the video on the download box…');
  mode = 'convert'; describe(ver, p, 'convert');
  const r = await post('/play/' + ver.id + '/convert', { video: p.video, audio: p.audio });
  sid = r.sid;
  const native = v.canPlayType('application/vnd.apple.mpegurl') !== '';
  if (native) { v.src = r.playlist; v.addEventListener('loadedmetadata', () => { if (!at && v.currentTime > 5) v.currentTime = 0; }, { once: true }); }
  else {
    if (!window.Hls) await loadScript(D.base + '/assets/hls.js');
    if (!Hls.isSupported()) throw new Error('This browser can’t play converted video. Try Chrome, Edge, Firefox or Safari.');
    hls = new Hls({ startPosition: 0, liveDurationInfinity: false, manifestLoadingMaxRetry: 20, levelLoadingMaxRetry: 20, fragLoadingMaxRetry: 20, lowLatencyMode: false });
    hls.loadSource(r.playlist); hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) say('Playback error (' + d.details + '). Reload to try again.'); });
  }
  let pending = at || 0;
  statusTimer = setInterval(async () => {
    try {
      const s = await (await fetch(D.base + '/play/hls/' + sid)).json();
      if (s.error && !s.id) { clearInterval(statusTimer); return; }
      const total = s.duration || ver.duration || 0, done = s.done || 0;
      if (s.error || s.Error) { say('The download box stopped converting: ' + (s.error || s.Error)); clearInterval(statusTimer); return; }
      if (pending && done > pending + 10) { v.currentTime = pending; pending = 0; }
      if (s.finished || s.Finished) { say(''); clearInterval(statusTimer); return; }
      const pct = total ? Math.min(99, Math.floor(done / total * 100)) : 0;
      say(pending ? 'Getting to ' + fmt(pending) + '… ' + pct + '% prepared' : (v.currentTime > 2 ? '' : 'Starting…') + (pct ? ' ' + pct + '% prepared; you can watch while it finishes' : ''));
      if (!pending && v.currentTime > 2 && pct > 3) setTimeout(() => say(''), 3000);
    } catch {}
  }, 2500);
  v.play().catch(() => {});
}
function fmt(s) { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
async function start(at) {
  document.getElementById('cover').remove();
  stopConvert();
  const p = plan(ver);
  try {
    if (p.direct) {
      mode = 'direct'; describe(ver, p, 'direct');
      v.src = D.base + '/play/' + ver.id + '/file';
      v.addEventListener('loadedmetadata', () => { if (at) v.currentTime = at; }, { once: true });
      v.addEventListener('error', () => { if (mode === 'direct') { say('This browser couldn’t play the original file; converting it instead…'); v.removeAttribute('src'); convert(at).catch(e => say(e.message)); } }, { once: true });
      await v.play().catch(() => {});
    } else await convert(at);
  } catch (e) { say(e.message); }
}
const LKEY = 'watch-pos:' + D.id;
function local(pos) { try { if (pos == null) return JSON.parse(localStorage.getItem(LKEY) || 'null'); if (pos === 0) localStorage.removeItem(LKEY); else localStorage.setItem(LKEY, JSON.stringify({ t: Math.floor(pos), at: Date.now() })); } catch { return null; } }
function save(stopped) {
  if (!v.currentTime || mode === null) return;
  const total = v.duration && isFinite(v.duration) ? v.duration : (D.runtime || 0);
  local(total && v.currentTime / total > 0.9 ? 0 : v.currentTime);
  if (!D.linked) return;
  const body = JSON.stringify({ item: D.id, position: v.currentTime, stopped });
  if (stopped) navigator.sendBeacon(D.base + '/play/progress', new Blob([body], { type: 'application/json' }));
  else fetch(D.base + '/play/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}
v.addEventListener('timeupdate', () => { if (Date.now() - saved > 10000 && !v.paused) { saved = Date.now(); save(false); } });
v.addEventListener('pause', () => save(false));
v.addEventListener('ended', () => { save(true); if (D.next) location.href = D.base + '/watch/' + D.next.id; });
addEventListener('pagehide', () => { save(true); stopConvert(); });
// Resume: the server's position for this user, else the one this browser remembered (share links, unlinked owner).
const lp = local(), at = D.resume > 60 ? D.resume : (lp && lp.t > 60 && (!D.runtime || lp.t < D.runtime - 120) ? lp.t : 0);
if (at) document.getElementById('coverbtns').innerHTML = '<button id=resume>Resume from ' + fmt(at) + '</button><button id=start class=quiet>Start over</button>';
const r = document.getElementById('resume'); if (r) r.onclick = () => start(at);
document.getElementById('start').onclick = () => { local(0); start(0); };
const ex = document.getElementById('exp'); if (ex) ex.textContent = new Date(Number(ex.dataset.t) * 1000).toLocaleString();
const lm = document.getElementById('linkme');
if (lm) lm.onsubmit = async e => { e.preventDefault(); try { await post('/api/link-me', { user: lm.user.value }); location.reload(); } catch (err) { alert(err.message); } };
const sb = document.getElementById('sharebtn');
if (sb) sb.onclick = () => {
  const label = d => d === 0 ? 'Never expires' : d === 1 ? '1 day' : d + ' days';
  document.getElementById('sharebox').innerHTML = '<form id=sharef class="card row" style="margin-top:12px"><span>Anyone with the link can watch this ' + (D.type === 'Episode' ? 'episode' : 'movie') + ' in a browser, without signing in. Link works for</span><select name=days>' +
    D.shareDays.map(d => '<option value=' + d + (d === 7 ? ' selected' : '') + '>' + label(d) + '</option>').join('') + '</select><button>Create link</button><span id=shareout></span></form>';
  document.getElementById('sharef').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await post('/api/shares', { item: D.id, days: Number(e.target.days.value) });
      document.getElementById('shareout').innerHTML = '<input readonly value="' + r.url + '" style="min-width:22em" onclick="this.select()"> <button type=button class=quiet id=sharecopy>Copy</button>';
      document.getElementById('sharecopy').onclick = async () => { try { if (navigator.share && /Mobi/.test(navigator.userAgent)) await navigator.share({ url: r.url }); else await navigator.clipboard.writeText(r.url); document.getElementById('sharecopy').textContent = 'Copied'; } catch {} };
    } catch (err) { document.getElementById('shareout').textContent = err.message; }
  };
};
const sel = document.getElementById('ver');
if (sel) sel.onchange = () => { const t = v.currentTime; ver = D.versions[Number(sel.value)]; if (mode) { v.pause(); stopConvert(); mode = null; const c = document.createElement('div'); c.id = 'cover'; document.querySelector('.stage').appendChild(c); start(t); } };
describe(ver, plan(ver), plan(ver).direct ? 'direct' : 'convert');
})();`;
