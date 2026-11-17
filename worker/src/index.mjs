// watchbox: a Jellyfin-compatible media server on Cloudflare Workers.
import { handleJellyfin, json } from './jellyfin.mjs';
import { imageTag } from './dto.mjs';
import { streamVideo, streamSubtitle, serveImage } from './media.mjs';
import { runSync, requestSync, takeSyncRequest, lockSync, unlockSync } from './cron.mjs';
import { handleAdmin } from './admin.mjs';
import { lookupSession } from './auth.mjs';
import { toolForHost, handleToolHost } from './tools.mjs';
import { handleRsyncHook, handleQbitHook, autoPipeline, finishPending } from './pipeline.mjs';
import { purgeOldTrash } from './manage.mjs';
import { handlePortal } from './portal.mjs';
import { handlePlaySrc } from './player.mjs';
import { handleShare } from './shares.mjs';
import { refreshRequests } from './requests.mjs';
import { handleYoutubeHook, refreshJobs } from './youtube.mjs';
import { configure } from './config.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Content-Type, Range, Accept',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};

function withCors(res) {
  if (!res) return res;
  if (res.status === 101) return res;
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

async function socket(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
  const s = await lookupSession(request, env);
  if (!s) return new Response('Unauthorized', { status: 401 });
  const pair = new WebSocketPair();
  const ws = pair[1];
  ws.accept();
  ws.send(JSON.stringify({ MessageType: 'ForceKeepAlive', Data: 60 }));
  ws.addEventListener('message', ev => {
    try { const m = JSON.parse(ev.data); if (m.MessageType === 'KeepAlive') ws.send(JSON.stringify({ MessageType: 'KeepAlive' })); } catch {}
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = url.pathname.replace(/^\/(emby|jellyfin)(?=\/)/i, '');
  const lower = path.toLowerCase();
  let m0;
  if (lower === '/admin' || lower.startsWith('/admin/')) return handleAdmin(request, env, ctx);
  if (lower === '/me' || lower.startsWith('/me/')) return handlePortal(request, env, ctx);
  if ((m0 = /^\/play-src\/([0-9a-f]{32})$/.exec(path))) return handlePlaySrc(request, env, m0[1]);   // signed; for watch-stream on the box
  if ((m0 = /^\/s\/([0-9a-f]{32})(\/.*)?$/.exec(path))) return handleShare(request, env, ctx, m0[1], m0[2] || '');   // public share links
  if (lower === '/hooks/rsync') return handleRsyncHook(request, env, ctx);
  if (lower === '/hooks/qbit') return handleQbitHook(request, env, ctx);
  if (lower === '/hooks/youtube') return handleYoutubeHook(request, env, ctx);
  if (lower === '/socket' || lower === '/embywebsocket') return socket(request, env);
  // A browser opening the site goes to the Access-protected admin page (as v1 did) instead of
  // seeing what the server is. Jellyfin clients use /System/Info/Public and the API, not "/".
  if (lower === '/' || lower === '/web' || lower === '/web/' || lower === '/web/index.html')
    return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'no-store' } });

  let m;
  // Video streams: /Videos/{id}/stream[.ext], /Videos/{id}/{msid}/stream..., /Items/{id}/Download, legacy /play/{mode}/{id}/...
  if ((m = /^\/videos\/([0-9a-f]{32})\/(?:[0-9a-f]{32}\/)?(?:stream|original)(?:\.\w+)?$/i.exec(path)) ||
      (m = /^\/items\/([0-9a-f]{32})\/(?:download|file)$/i.exec(path)) ||
      (m = /^\/play\/\w+\/([0-9a-f]{32})(?:\/.*)?$/i.exec(path)))
    return streamVideo(request, env, m[1].toLowerCase());
  if ((m = /^\/videos\/([0-9a-f]{32})\/[0-9a-f]{32}\/subtitles\/(\d+)(?:\/\d+)?\/stream\.(\w+)$/i.exec(path)))
    return streamSubtitle(request, env, m[1].toLowerCase(), Number(m[2]), m[3]);
  if ((m = /^\/items\/([0-9a-f]{32})\/images\/(primary|backdrop|thumb|logo|banner|art)(?:\/(\d+))?(?:\/.*)?$/i.exec(path)))
    return serveImage(request, env, m[1].toLowerCase(), m[2].toLowerCase() === 'banner' || m[2].toLowerCase() === 'art' ? 'Thumb' : m[2], Number(m[3] || 0));
  if ((m = /^\/items\/([0-9a-f]{32})\/images$/i.exec(path))) {
    const row = await env.DB.prepare('SELECT images FROM items WHERE id = ?').bind(m[1].toLowerCase()).first();
    const img = JSON.parse(row?.images || '{}');
    return json(Object.entries(img).filter(([, v]) => v).map(([t, v]) => ({ ImageType: t, ImageIndex: t === 'Backdrop' ? 0 : undefined, ImageTag: imageTag(v), Path: v.startsWith('origin:') ? undefined : v })));
  }
  if ((m = /^\/(?:persons|genres|studios)\/[^/]+\/images\/primary/i.exec(path))) return new Response('Not found', { status: 404 });

  const res = await handleJellyfin(request, env, {});
  if (res) return res;
  return json({ error: 'Not found' }, 404);
}

// Jellyfin accepts item ids with or without dashes (Kotlin SDK clients send dashed UUIDs).
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function normalizeIds(request) {
  if (!UUID.test(request.url)) return request;
  UUID.lastIndex = 0;
  const url = request.url.replace(UUID, m => m.replace(/-/g, '').toLowerCase());
  return new Request(url, request);
}

export default {
  async fetch(request, env, ctx) {
    configure(env);
    const tool = toolForHost(env, new URL(request.url).hostname);
    if (tool) {
      try { return await handleToolHost(request, env, tool); }
      catch (e) { console.error('tool proxy failed', tool.id, e.stack || e.message); return new Response('Tool proxy error', { status: 502 }); }
    }
    try { return withCors(await route(normalizeIds(request), env, ctx)); }
    catch (e) {
      console.error('request failed', request.method, new URL(request.url).pathname, e.stack || e.message);
      return withCors(json({ error: 'Internal error' }, 500));
    }
  },
  async scheduled(event, env, ctx) {
    configure(env);
    // Every minute: run a sync someone asked for (finished copy, YouTube video, "Sync now").
    // Every 15 minutes: the pipeline fallback and a full sync even if nobody asked.
    const full = new Date(event.scheduledTime || Date.now()).getUTCMinutes() % 15 === 0;
    ctx.waitUntil(tick(env, full));
  }
};

async function tick(env, full) {
  if (full) {
    // Finish copies whose webhook was missed, send finished downloads.
    try { console.log('pipeline', JSON.stringify([await finishPending(env), await autoPipeline(env)])); }
    catch (e) { console.error('pipeline', e.message); }
    // YouTube: missed hooks, hand over waiting jobs (asks for a sync when a video landed).
    try { const y = await refreshJobs(env); if (y.copied) { console.log('youtube', JSON.stringify(y)); await requestSync(env); } }
    catch (e) { console.error('youtube', e.message); }
  }
  const requested = await takeSyncRequest(env);
  if (!full && !requested) return;
  if (!(await lockSync(env))) {             // a sync is still running: try again next minute
    if (requested) await requestSync(env);
    return;
  }
  try {
    console.log('sync', JSON.stringify(await runSync(env, { force: requested })));
    try { await refreshJobs(env); } catch (e) { console.error('youtube', e.message); }   // marks landed videos as added
    try { const n = await refreshRequests(env); if (n) console.log('requests available', n); }
    catch (e) { console.error('requests', e.message); }
    if (full) {
      try { const p = await purgeOldTrash(env); if (p) console.log('trash', JSON.stringify(p)); }
      catch (e) { console.error('trash', e.message); }
    }
  } finally {
    await unlockSync(env);
  }
}
