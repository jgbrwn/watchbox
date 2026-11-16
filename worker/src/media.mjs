// Video streaming (origin passthrough), subtitles and images.
import { lookupSession } from './auth.mjs';
import { originUrl, originHeaders } from './origin.mjs';
import { fileAllowed, allowedAge } from './ages.mjs';

const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', divx: 'video/x-msvideo' };
const PASS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export async function streamVideo(request, env, id) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const s = await lookupSession(request, env);
  if (!s) return new Response('Unauthorized', { status: 401 });
  const f = await env.DB.prepare('SELECT root, path, size FROM files WHERE id = ? AND missing_since IS NULL').bind(id).first();
  if (!f || !(await fileAllowed(env, s, id))) return new Response('Not found', { status: 404 });
  return proxyFile(request, env, f);
}

// Byte-range passthrough of a library file from the origin (apps, browser player, watch-stream source).
export async function proxyFile(request, env, f) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const headers = originHeaders(env);
  for (const h of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) { const v = request.headers.get(h); if (v) headers[h] = v; }
  const upstream = await fetch(originUrl(env, f.root, f.path), { method: request.method, headers, signal: request.signal });
  if (![200, 206, 304, 416].includes(upstream.status)) {
    upstream.body?.cancel();
    return new Response('Origin unavailable', { status: 502 });
  }
  const out = new Headers({ 'Content-Type': MIME[f.path.split('.').pop().toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
  for (const h of PASS) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

export function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; } // latin-1 fallback
}

export function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/^\d+\n(?=\d{2}:)/gm, '');
}

export async function streamSubtitle(request, env, itemId, index, format) {
  const s = await lookupSession(request, env);
  if (!s) return new Response('Unauthorized', { status: 401 });
  const item = await env.DB.prepare('SELECT streams, subtitles, age FROM items WHERE id = ?').bind(itemId).first();
  if (!item || !allowedAge(s, item.age)) return new Response('Not found', { status: 404 });
  const embedded = JSON.parse(item.streams || '[]').length;
  const sub = JSON.parse(item.subtitles || '[]')[index - embedded];
  if (!sub) return new Response('Not found', { status: 404 });
  const res = await fetch(originUrl(env, sub.root, sub.path), { headers: originHeaders(env) });
  if (!res.ok) return new Response('Origin unavailable', { status: 502 });
  let text = decodeText(new Uint8Array(await res.arrayBuffer()));
  const want = (format || sub.format).toLowerCase();
  let type = 'text/plain; charset=utf-8';
  if (want === 'vtt' && sub.format === 'srt') { text = srtToVtt(text); type = 'text/vtt; charset=utf-8'; }
  else if (want === 'vtt') type = 'text/vtt; charset=utf-8';
  else if (want === 'ass' || want === 'ssa') type = 'text/x-ssa; charset=utf-8';
  else if (want === 'srt') type = 'application/x-subrip; charset=utf-8';
  return new Response(text, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } });
}

// ---- Images: proxy TMDB's CDN through Cloudflare's cache ----
// (YouTube videos' thumbnails and posters are files next to the video on the storage host: "origin:<root>/<path>".)

async function originImage(env, rel) {
  const i = rel.indexOf('/');
  if (i < 1 || !/\.jpe?g$/i.test(rel)) return new Response(null, { status: 404 });
  const key = new Request('https://watch-image-cache.invalid/' + encodeURIComponent(rel));
  const cache = globalThis.caches?.default;
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const { originUrl, originHeaders } = await import('./origin.mjs');
  const r = await fetch(originUrl(env, rel.slice(0, i), rel.slice(i + 1)), { headers: originHeaders(env) });
  if (!r.ok) return new Response(null, { status: 502 });
  const res = new Response(r.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=2592000' } });
  if (cache) await cache.put(key, res.clone());
  return res;
}

const SIZES = {
  Primary: [92, 154, 185, 342, 500, 780], Backdrop: [300, 780, 1280], Thumb: [300, 780, 1280], Logo: [92, 154, 185, 300, 500], Still: [92, 185, 300], Profile: [45, 185]
};

function tmdbSize(kind, want) {
  const list = SIZES[kind] || SIZES.Primary;
  if (!want) return kind === 'Profile' ? 'w185' : kind === 'Primary' ? 'w500' : 'w1280';
  const hit = list.find(w => w >= want);
  return hit ? `w${hit}` : 'original';
}

export async function serveImage(request, env, id, type, index) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const url = new URL(request.url);
  const q = k => { for (const [a, v] of url.searchParams) if (a.toLowerCase() === k) return v; return null; };
  const want = Number(q('fillwidth') || q('maxwidth') || q('width')) || (Number(q('fillheight') || q('maxheight') || q('height')) * (type === 'Primary' ? 0.67 : 1.78)) || 0;
  type = type[0].toUpperCase() + type.slice(1).toLowerCase();
  let path = null, kind = type;
  const row = await env.DB.prepare('SELECT type, images FROM items WHERE id = ?').bind(id).first();
  if (row) {
    const img = JSON.parse(row.images || '{}');
    path = type === 'Backdrop' ? img.Backdrop : type === 'Thumb' ? (img.Thumb || img.Backdrop) : img[type];
    if (row.type === 'Episode' && (type === 'Primary' || type === 'Thumb')) kind = 'Still';
  } else {
    const person = await env.DB.prepare('SELECT image FROM persons WHERE id = ?').bind(id).first();
    if (person && type === 'Primary') { path = person.image; kind = 'Profile'; }
    else {
      // Library view tile: use the best-rated backdrop in that library.
      const { libraryOfView } = await import('./library/catalog.mjs');
      const lib = await libraryOfView(id);
      if (lib) {
        const top = await env.DB.prepare("SELECT images FROM items WHERE library = ? AND type IN ('Movie','Series') AND images LIKE '%\"Backdrop\":\"%' ORDER BY rating DESC NULLS LAST, date_created DESC LIMIT 1").bind(lib).first();
        path = JSON.parse(top?.images || '{}').Backdrop; kind = 'Backdrop';
      }
    }
  }
  if (!path) return new Response('Not found', { status: 404 });
  const res = path.startsWith('origin:') ? await originImage(env, path.slice(7))
    : await fetch(`https://image.tmdb.org/t/p/${tmdbSize(kind, want)}${path}`, { cf: { cacheEverything: true, cacheTtl: 30 * 86400 } });
  if (!res.ok) return new Response('Image unavailable', { status: 502 });
  return new Response(request.method === 'HEAD' ? null : res.body, {
    headers: { 'Content-Type': res.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ...(res.headers.get('content-length') ? { 'Content-Length': res.headers.get('content-length') } : {}) }
  });
}
