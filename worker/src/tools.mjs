// The download tools on the download box (behind Caddy basic auth there), served through this Worker on their own
// hostnames (TOOLS in wrangler.jsonc: host = the public name, upstream = the box) so they can be
// embedded in /admin behind the same Cloudflare Access login.
//
// Auth on a tool host: /admin (Access-protected) mints a short-lived signed link; the tool host
// turns it into an HttpOnly cookie for that host only. Each tool keeps its own origin, so a bug in
// one tool's page can't script /admin. The Worker adds the Caddy credential server-side; the
// browser never sees it.

const COOKIE = '__Host-watch_tool';
const COOKIE_TTL = 12 * 3600;
const LINK_TTL = 300;

export function tools(env) {
  const t = typeof env.TOOLS === 'string' ? JSON.parse(env.TOOLS) : env.TOOLS || {};
  return Object.entries(t).map(([id, v]) => ({ id, ...v }));
}

export const adminOrigin = env => String(env.ADMIN_ORIGIN || '').replace(/\/$/, '');

export function toolForHost(env, host) {
  return tools(env).find(t => t.host === host);
}

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env, msg) {
  if (!env.TOOLS_SECRET) throw new Error('TOOLS_SECRET not set');
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TOOLS_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function same(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Called from /admin (already Access-verified): a link that logs the browser into a tool host.
export async function launchUrl(env, tool, next = '/') {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL;
  const n = String(next).startsWith('/') && !String(next).startsWith('//') ? next : '/';
  const sig = await sign(env, `link|${tool.id}|${exp}|${n}`);
  return `https://${tool.host}/__watch/auth?exp=${exp}&next=${encodeURIComponent(n)}&sig=${sig}`;
}

async function hasSession(request, env, tool) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`).exec(request.headers.get('Cookie') || '');
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return same(m[2], await sign(env, `cookie|${tool.id}|${m[1]}`));
}

function page(status, title, body) {
  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:15px system-ui,sans-serif;padding:24px;color:#ddd;background:#16181d"><h3>${title}</h3><p>${body}</p>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Server-side call to a tool's upstream (used by the admin pipeline API).
export function upstreamFetch(env, tool, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', env.TOOLS_AUTHORIZATION || '');
  headers.set('User-Agent', 'watchbox/2.0');
  return fetch(tool.upstream.replace(/\/$/, '') + path, { ...init, headers, redirect: 'manual', signal: init.signal || AbortSignal.timeout(20000) });
}

export async function handleToolHost(request, env, tool) {
  const url = new URL(request.url);

  if (url.pathname === '/__watch/auth') {
    const exp = Number(url.searchParams.get('exp'));
    const next = url.searchParams.get('next') || '/';
    const ok = exp > Date.now() / 1000 && exp < Date.now() / 1000 + LINK_TTL + 60 &&
      same(url.searchParams.get('sig') || '', await sign(env, `link|${tool.id}|${exp}|${next}`));
    if (!ok) return page(403, 'Link expired', `Open this tool from <a style=color:#8af href="${adminOrigin(env)}/admin#${tool.id}">the admin page</a>.`);
    const cexp = Math.floor(Date.now() / 1000) + COOKIE_TTL;
    const csig = await sign(env, `cookie|${tool.id}|${cexp}`);
    return new Response(null, { status: 302, headers: {
      Location: `/__watch/check?next=${encodeURIComponent(next.startsWith('/') && !next.startsWith('//') ? next : '/')}`,
      'Set-Cookie': `${COOKIE}=${cexp}.${csig}; Path=/; Max-Age=${COOKIE_TTL}; Secure; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store'
    } });
  }

  if (url.pathname === '/__watch/check') {
    // Stops a redirect loop when the browser refuses the cookie (e.g. strict privacy settings in a frame).
    const next = url.searchParams.get('next') || '/';
    if (await hasSession(request, env, tool))
      return new Response(null, { status: 302, headers: { Location: next.startsWith('/') && !next.startsWith('//') ? next : '/', 'Cache-Control': 'no-store' } });
    return page(403, `${tool.name}: sign-in cookie was blocked`, `This browser did not keep the sign-in cookie for ${tool.host}. <a style=color:#8af target=_blank rel=noopener href="${adminOrigin(env)}/admin/tools/launch?tool=${tool.id}">Open ${tool.name} in a new tab</a> instead.`);
  }

  if (!(await hasSession(request, env, tool))) {
    if (request.method === 'GET' && request.headers.get('Upgrade') !== 'websocket' && (request.headers.get('Accept') || '').includes('text/html'))
      return Response.redirect(`${adminOrigin(env)}/admin/tools/launch?tool=${tool.id}&next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    return new Response('Unauthorized', { status: 401 });
  }
  // Browser-playback service on the dl host: only the Worker talks to it (src/player.mjs), never a tool page.
  if (url.pathname.startsWith('/__watchstream')) return new Response('Not found', { status: 404 });
  if (!env.TOOLS_AUTHORIZATION) return page(503, `${tool.name} is not connected`, 'The Worker secret TOOLS_AUTHORIZATION (Caddy basic auth for the download box) is not set yet.');

  const up = new URL(tool.upstream);
  const target = new URL(url.pathname + url.search, up);
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const l = k.toLowerCase();
    if (l === 'host' || l === 'authorization' || l.startsWith('cf-') || l.startsWith('x-forwarded') || l === 'x-real-ip' || l === 'cdn-loop') continue;
    headers.set(k, v);
  }
  // Drop our session cookie; pass the tool's own cookies (e.g. qBittorrent SID).
  const cookies = (request.headers.get('Cookie') || '').split(/;\s*/).filter(c => c && !c.startsWith(COOKIE + '='));
  if (cookies.length) headers.set('Cookie', cookies.join('; ')); else headers.delete('Cookie');
  // Tools check Origin/Referer against their own host (qBittorrent CSRF protection).
  if (headers.has('Origin')) headers.set('Origin', up.origin);
  if (headers.has('Referer')) headers.set('Referer', headers.get('Referer').replace(/^https?:\/\/[^/]+/, up.origin));
  headers.set('Authorization', env.TOOLS_AUTHORIZATION);

  if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket')
    return fetch(target, { headers });

  let res;
  try {
    res = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half', redirect: 'manual' });
  } catch (e) {
    return page(502, `${tool.name} is unreachable`, `The download box did not answer (${String(e.message || e).slice(0, 200)}). Check <code>service ${tool.service || tool.id} status</code> on it.`);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504)
    return page(502, `${tool.name} is not running`, `Caddy is up but the app behind it is not answering. On the download box: <code>su - root -c "service ${tool.service || tool.id} restart"</code>.`);
  if (res.status === 401 && res.headers.get('WWW-Authenticate'))
    return page(502, `${tool.name}: credential rejected`, 'Caddy rejected the Worker credential (TOOLS_AUTHORIZATION).');

  let out = new Response(res.body, res);
  // First-visit defaults for the tool's own settings (e.g. VueTorrent's theme). Never overwrites a choice.
  if (tool.storage_defaults && typeof HTMLRewriter !== 'undefined' && request.method === 'GET' && (out.headers.get('Content-Type') || '').includes('text/html')) {
    const js = `try{for(const[k,v]of Object.entries(${JSON.stringify(tool.storage_defaults).replace(/</g, '\\u003c')}))if(localStorage.getItem(k)===null)localStorage.setItem(k,v)}catch(e){}`;
    out = new HTMLRewriter().on('head', { element(e) { e.prepend(`<script>${js}</script>`, { html: true }); } }).transform(out);
  }
  const h = out.headers;
  const loc = h.get('Location');
  if (loc && loc.startsWith(up.origin)) h.set('Location', loc.slice(up.origin.length) || '/');
  // Allow framing by /admin only.
  h.delete('X-Frame-Options');
  const fa = `frame-ancestors 'self' ${adminOrigin(env)}`;
  const csp = h.get('Content-Security-Policy');
  h.set('Content-Security-Policy', csp ? (/frame-ancestors[^;]*/.test(csp) ? csp.replace(/frame-ancestors[^;]*/, fa) : `${csp}; ${fa}`) : fa);
  h.delete('WWW-Authenticate');
  h.set('X-Robots-Tag', 'noindex');
  return out;
}
