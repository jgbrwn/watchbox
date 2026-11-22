// /me: the page for the people the owner invites. Behind its own Cloudflare Access app (email one-time code;
// GUEST_ACCESS_AUD), so Access proves the email address and this file decides what that email may do: only
// emails of existing, enabled users get in, and each person only ever sees their own account, devices and requests,
// plus the library. Nothing here touches /admin, the download box or anyone else's data.
import { verifyAccessJwt } from './access.mjs';
import { userStatus, listDevices, signOut, setPassword, passphrase, serverUrl, INVITE_DAYS } from './users.mjs';
import { searchTitles, createRequest, requestsFor, refreshRequests, dismissNotice, MAX_OPEN } from './requests.mjs';
import { MIN_PASSWORD_LENGTH } from './passwords.mjs';
import { handlePlayer, watchHtml, libraryItems, libraryVersion, WATCH_CSS, WATCH_JS } from './player.mjs';
import { authorize as qcAuthorize } from './quickconnect.mjs';
import { canShare, createShare, listShares, revokeShare, GUEST_DAYS } from './shares.mjs';

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'same-origin' };

export async function handlePortal(request, env, ctx) {
  let who;
  try { who = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env, { app: 'guest' }); }
  catch { return new Response('Forbidden', { status: 403 }); }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/me';
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').bind(who.email).first();
  const status = user ? userStatus(user) : null;

  if (path.startsWith('/me/api/')) {
    if (!user || status === 'disabled') return json({ error: 'No access' }, 403);
    if (path === '/me/api/accept' && request.method === 'POST') {
      if (status !== 'invited') return json({ error: status === 'active' ? 'You’ve already set a password.' : 'This invite has expired. Ask for a new one.' }, 400);
      const b = await request.json().catch(() => ({}));
      const r = await setPassword(env.DB, user.id, String(b.password || ''));
      return r.error ? json(r, 400) : json({ ok: true });
    }
    if (path === '/me/api/passphrase') return json({ passphrase: passphrase() });
    if (status !== 'active') return json({ error: 'Choose a password first.' }, 403);
    return api(request, env, ctx, path, url, user);
  }

  if (user && status === 'active' && /^\/me\/(watch|play|assets|api\/library)(\/|$)/.test(path)) {
    const sharing = await canShare(env, user);
    const r = await handlePlayer(request, env, ctx, { base: '/me', userId: user.id, viewer: user, page: d => {
      const w = watchHtml(d, { base: '/me', back: '/me#library', linked: true, canShare: sharing, shareDays: GUEST_DAYS });
      return page(env, w.title, w.body, WATCH_JS, false, WATCH_CSS);
    } });
    if (r) return r;
  }
  if (!user) return page(env, 'Not invited', `<div class=card><h2>This email isn’t on the list</h2><p>You’re signed in as <b>${esc(who.email)}</b>, but nobody has invited that address. If you were invited with a different email, <a href="/cdn-cgi/access/logout">sign out</a> and use that one.</p></div>`);
  if (status === 'disabled') return page(env, 'Account disabled', `<div class=card><h2>Your account is turned off</h2><p>Ask the person who invited you if you think this is a mistake.</p></div>`);
  if (status === 'invite expired') return page(env, 'Invite expired', `<div class=card><h2>Your invite has expired</h2><p>Invites last ${INVITE_DAYS} days. Ask for a new one and then come back here.</p></div>`);
  if (status === 'invited') return page(env, 'Welcome', acceptHtml(user), ACCEPT_JS);
  ctx.waitUntil(refreshRequests(env).catch(() => {}));
  return page(env, 'Watch', mainHtml(env, user), MAIN_JS, true);
}

async function api(request, env, ctx, path, url, user) {
  const db = env.DB;
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const r = (x) => json(x.body, x.status);
  if (path === '/me/api/state') return json({
    user: { username: user.username, name: user.display_name, email: user.email, notify: !!user.notify },
    devices: (await listDevices(db, user.id)).map(({ user_id, username, display_name, ...d }) => d),
    requests: await requestsFor(env, user), max_open: MAX_OPEN
  });
  if (path === '/me/api/search') return json({ results: await searchTitles(env, url.searchParams.get('q'), user) });
  if (path === '/me/api/request' && request.method === 'POST') return r(await createRequest(env, user, body));
  if (path === '/me/api/dismiss' && request.method === 'POST') { await dismissNotice(db, user.id, body.id); return json({ ok: true }); }
  if (path === '/me/api/cancel' && request.method === 'POST') {
    await db.prepare("DELETE FROM requests WHERE id = ? AND user_id = ? AND status IN ('pending','declined','available')").bind(String(body.id || ''), user.id).run();
    return json({ ok: true });
  }
  if (path === '/me/api/password' && request.method === 'POST') {
    const x = await setPassword(db, user.id, String(body.password || ''));
    if (x.error) return json(x, 400);
    if (body.sign_out) await signOut(db, { userId: user.id });
    return json({ ok: true });
  }
  if (path === '/me/api/signout' && request.method === 'POST') { await signOut(db, { sessionId: String(body.id || ''), userId: user.id }); return json({ ok: true }); }
  if (path === '/me/api/notify' && request.method === 'POST') { await db.prepare('UPDATE users SET notify = ? WHERE id = ?').bind(body.on ? 1 : 0, user.id).run(); return json({ ok: true }); }
  if (path === '/me/api/library-version') return json({ v: (await libraryVersion(db)).v });
  if (path === '/me/api/library') return json(await libraryItems(db, url.searchParams.get('q'), url.searchParams.get('type'), user));
  if (path === '/me/api/shares' && request.method === 'GET') return json({ shares: await listShares(env, user.id), can_share: await canShare(env, user) });
  if (path === '/me/api/shares' && request.method === 'POST') { const x = await createShare(env, url.origin, user, body); return json(x.body, x.status); }
  if (path === '/me/api/shares/revoke' && request.method === 'POST') return json(await revokeShare(env, body.id, user.id));
  if (path === '/me/api/quickconnect' && request.method === 'POST') {
    const r = await qcAuthorize(env, body.code, user.id);
    return r.error ? json(r, 400) : json(r);
  }
  return json({ error: 'not found' }, 404);
}

// ---------- pages ----------

const CSS = `
:root{--bg:#0e0f12;--surface:#16181d;--surface-2:#1d2027;--line:#2a2e37;--text:#ece9e4;--muted:#9a968e;--accent:#f2b43c;--accent-ink:#1a1408;--good:#6fcf8e;--bad:#f2767a;color-scheme:dark}
@media (prefers-color-scheme:light){:root:not([data-theme]){--bg:#f5f3ef;--surface:#fff;--surface-2:#efece6;--line:#e2ded6;--text:#1c1b19;--muted:#6d6a63;--accent:#b7790f;--accent-ink:#fff;--good:#1f8a4c;--bad:#c2383e;color-scheme:light}}
:root[data-theme=light]{--bg:#f5f3ef;--surface:#fff;--surface-2:#efece6;--line:#e2ded6;--text:#1c1b19;--muted:#6d6a63;--accent:#b7790f;--accent-ink:#fff;--good:#1f8a4c;--bad:#c2383e;color-scheme:light}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}header{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:8px;font-weight:650}nav{display:flex;gap:2px;flex:1;overflow-x:auto;scrollbar-width:none}
.tab{border:0;background:none;color:var(--muted);padding:7px 12px;border-radius:8px;cursor:pointer;font:inherit;font-weight:550;white-space:nowrap}.tab[aria-selected=true]{color:var(--text);background:var(--surface-2);box-shadow:inset 0 -2px 0 var(--accent)}
main{max-width:900px;margin:0 auto;padding:22px 16px 60px}main.wide{max-width:1180px}.pane{display:none}.pane.on{display:block}
h2{font-size:17px;margin:28px 0 10px}h2:first-child{margin-top:0}h3{font-size:15px;margin:0 0 6px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px}
.hint,.muted{color:var(--muted)}.hint{margin:0 0 12px}.good{color:var(--good)}.bad{color:var(--bad)}
input,select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 12px;min-width:0}input[type=search],input.wide{width:100%}
button{font:inherit;font-weight:600;border-radius:8px;padding:8px 14px;cursor:pointer;border:1px solid transparent;background:var(--accent);color:var(--accent-ink);white-space:nowrap}
button.quiet{background:transparent;color:var(--text);border-color:var(--line)}button:disabled{opacity:.5;cursor:default}
code,.code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:2px 6px;border-radius:6px;word-break:break-all}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;align-items:center}.kv b{font-weight:550;color:var(--muted)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:14px}
.poster{margin:0}a.pl{color:var(--text);text-decoration:none}a.pl:hover .art{outline:2px solid var(--accent)}.poster .art{aspect-ratio:2/3;border-radius:10px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line)}.poster img{width:100%;height:100%;object-fit:cover;display:block}
.poster figcaption{font-size:13px;font-weight:550;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.poster small{display:block;color:var(--muted);font-weight:400}
.res{display:grid;grid-template-columns:62px 1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.res:first-child{border-top:0}.res img{width:62px;height:93px;object-fit:cover;border-radius:6px;background:var(--surface-2)}.res img.yt{height:35px}
.res p{margin:2px 0 0;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:99px;padding:2px 9px;background:var(--surface-2)}.pill.ok{color:var(--good)}.pill.no{color:var(--bad)}.pill.on{color:var(--accent)}
details{border-top:1px solid var(--line);padding:10px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:600}
.notice{position:relative;padding-right:40px}.notice .x{position:absolute;top:6px;right:6px;background:none;border:0;color:inherit;font-size:20px;line-height:1;padding:4px 8px;cursor:pointer}.msg{border-radius:10px;padding:10px 14px;margin:10px 0;background:color-mix(in srgb,var(--good) 14%,var(--surface));border:1px solid color-mix(in srgb,var(--good) 40%,var(--line))}.msg.err{background:color-mix(in srgb,var(--bad) 12%,var(--surface));border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}
.theme{margin-left:auto;width:34px;height:34px;padding:0;display:grid;place-items:center;background:transparent;border-color:var(--line);color:var(--muted)}
@media (max-width:600px){header{flex-wrap:wrap}nav{order:3;flex-basis:100%}.tab{padding:7px 9px}.res{grid-template-columns:52px 1fr}.res img{width:52px;height:78px}.res img.yt{height:29px}.res>:last-child{grid-column:2}.kv{grid-template-columns:1fr}.kv b{margin-top:6px}}`;

const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="4" fill="var(--accent)"/><path d="M10 8.5v7l6-3.5z" fill="var(--accent-ink)"/></svg>`;

export function page(env, title, body, js = '', tabs = false, css = '') {
  return new Response(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="dark light"><meta name=robots content=noindex>
<title>${esc(title)} · Watch</title>
<script>try{const t=localStorage.getItem('watch-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch{}</script>
<style>${CSS}${css}</style>
<header><div class=brand>${ICON}Watch</div>${tabs ? `<nav role=tablist><button class=tab data-tab=start>Start</button><button class=tab data-tab=library>Library</button><button class=tab data-tab=requests>Requests</button><button class=tab data-tab=account>Account</button></nav>` : '<span style="flex:1"></span>'}
<button type=button class="quiet theme" id=theme aria-label="Switch theme" title="Switch theme">◐</button></header>
<main${css ? ' class=wide' : ''}>${body}</main>
<script>
const $ = s => document.querySelector(s), esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = async (p, body) => { const r = await fetch('/me/api/' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const d = await r.json().catch(() => ({ error: 'Your sign-in expired. Reload the page.' })); if (!r.ok || d.error) throw new Error(d.error || r.status); return d; };
$('#theme').onclick = () => { const o = ['auto', 'dark', 'light'], c = document.documentElement.dataset.theme || 'auto', n = o[(o.indexOf(c) + 1) % 3]; if (n === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = n; try { n === 'auto' ? localStorage.removeItem('watch-theme') : localStorage.setItem('watch-theme', n); } catch {} };
const MIN = ${MIN_PASSWORD_LENGTH}, SERVER = ${JSON.stringify(serverUrl(env))};
${js}
</script>`, { headers: HEADERS });
}

function acceptHtml(u) {
  return `<div class=card><h2>Welcome${u.display_name ? ', ' + esc(u.display_name) : ''}</h2>
<p>You’ve been invited to Watch. Choose a password for your username <code>${esc(u.username)}</code>. You’ll type it into the app on your TV or phone, so a few simple words work well.</p>
<form id=acc class=row style="margin-top:12px"><input id=pw class=wide autocomplete=new-password minlength=${MIN_PASSWORD_LENGTH} required placeholder="At least ${MIN_PASSWORD_LENGTH} characters" aria-label=Password>
<button type=button class=quiet id=suggest>Suggest one</button><button>Save password</button></form><div id=out></div></div>`;
}

const ACCEPT_JS = String.raw`
$('#suggest').onclick = async () => { $('#pw').value = (await api('passphrase')).passphrase; $('#pw').type = 'text'; };
$('#acc').onsubmit = async e => { e.preventDefault();
  if ($('#pw').value.length < MIN) { $('#out').innerHTML = '<div class="msg err">Passwords need at least ' + MIN + ' characters.</div>'; return; }
  try { await api('accept', { password: $('#pw').value }); location.reload(); } catch (err) { $('#out').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; } };`;

function mainHtml(env, u) {
  const server = esc(serverUrl(env));
  return `
<div id=notices></div>
<section class=pane id=start>
<h2>Connect your TV or phone</h2>
<div class=card><div class=kv><b>Server</b><span><code>${server}</code></span><b>Username</b><span><code>${esc(u.username)}</code></span><b>Password</b><span>the one you chose (change it under Account)</span></div></div>
<p class=hint>Watch works with apps that support <b>Jellyfin</b> servers. Add a Jellyfin server in the app, paste the server address above, then sign in. VidHub is the app this library is tested with; the others speak the same language and should work too.</p>
<div class=card>
<details open><summary>Android TV, Google TV, onn, Chromecast with Google TV</summary><p><b>VidHub</b> (Play Store) → Add → Jellyfin → enter the server, username and password. Also: <b>Jellyfin for Android TV</b>, <b>Wholphin</b>.</p></details>
<details><summary>Apple TV, iPhone, iPad, Mac</summary><p><b>VidHub</b> (App Store) → Add media library → Jellyfin. Also: <b>Infuse</b> (Add Files → Jellyfin), <b>Swiftfin</b>.</p></details>
<details><summary>Android phone or tablet</summary><p><b>VidHub</b>, <b>Findroid</b> or the <b>Jellyfin</b> app. Choose “Add server” and use the address above.</p></details>
<details><summary>Fire TV</summary><p><b>Jellyfin for Fire TV</b> (Amazon Appstore). Choose “Add server”.</p></details>
<details><summary>Roku, Samsung, LG and others</summary><p>Their Jellyfin apps should connect the same way but haven’t been tried with this library. If one doesn’t work, say so in a request note.</p></details>
<details><summary>Trouble?</summary><p>Type the address exactly, starting with <code>https://</code> and with no port number. Usernames are case-insensitive, passwords aren’t. New titles appear within a few minutes of being added; pull down to refresh or reopen the app.</p></details>
</div>
<h2>Sign in a TV with a code</h2>
<div class=card><p style="margin:0 0 10px">Many apps (the official Jellyfin apps, Swiftfin, Findroid, Streamyfin) offer <b>Quick Connect</b> on their sign-in screen: they show a 6-digit code. Type it here and the TV signs in as you, no password needed. (VidHub and Infuse don’t have it; use your password there.)</p>
<form id=qcf class=row><input id=qc inputmode=numeric autocomplete=off maxlength=7 placeholder="123456" aria-label="Quick Connect code" style="width:10em;font-size:20px;letter-spacing:.15em"><button>Sign in the TV</button></form><div id=qcmsg></div></div>
<h2>Watch in this browser</h2>
<p class=hint>Open the <a href="#library">Library</a> tab and pick something. Most things play right away; some older or unusual files are converted as you watch (give it a few seconds). Progress is shared with your TV apps.</p>
<h2>Asking for something new</h2>
<p class=hint>Can’t find a movie or show? Search for it on the <a href="#requests">Requests</a> tab and ask for it (you can also paste a YouTube link there). You’ll see its progress there${u.email ? ' and get an email when it’s ready' : ''}.</p>
</section>

<section class=pane id=library>
<div class=row style="margin-bottom:14px"><select id=ltype aria-label="Movies, shows or YouTube"><option value=Movie>Movies</option><option value=Series>Shows</option><option value=YouTube>YouTube</option></select><input type=search id=lq placeholder="Search the library" style="flex:1"></div>
<p class=hint id=lcount></p><div class=grid id=lgrid></div>
</section>

<section class=pane id=requests>
<h2>Ask for a movie, show or YouTube video</h2>
<input type=search id=sq placeholder="Search for a title, paste an IMDb/TMDB link or id (tt…), or a YouTube link…" autocomplete=off><div id=smsg></div><div id=sres class=card style="display:none"></div>
<h2>Your requests</h2><div id=reqs class=card><p class=hint>Loading…</p></div>
</section>

<section class=pane id=account>
<h2>Your devices</h2><p class=hint>Apps signed in as you. Sign out any you don’t recognise or no longer use.</p><div id=devs class=card></div>
<h2>Shared links</h2><p class=hint>Links you made with <b>Share link</b> on a movie or episode. Anyone who has one can watch that title in a browser until it expires; turn it off any time.</p><div id=shares class=card><p class=hint style="margin:0">Loading…</p></div>
<h2>Password</h2><div class=card><form id=pwf class=row><input id=npw class=wide autocomplete=new-password minlength=${MIN_PASSWORD_LENGTH} placeholder="New password (at least ${MIN_PASSWORD_LENGTH} characters)" aria-label="New password" style="flex:1">
<button type=button class=quiet id=suggest>Suggest one</button><button>Change</button></form>
<label class=row style="margin-top:10px;font-size:14px"><input type=checkbox id=pwout> Also sign out all my devices</label><div id=pwmsg></div></div>
<h2>Email</h2><div class=card><p style="margin:0 0 8px">Signed in as <b>${esc(u.email || '')}</b>.</p><label class=row style="font-size:14px"><input type=checkbox id=notify${u.notify ? ' checked' : ''}> Email me when something I asked for is ready</label>
<p class=hint style="margin:12px 0 0"><a href="/cdn-cgi/access/logout">Sign out of this page</a> (your TV apps stay signed in).</p></div>
</section>`;
}

const MAIN_JS = String.raw`
const ago = s => { if (!s) return 'never'; const d = Date.now() / 1000 - s; return d < 90 ? 'just now' : d < 5400 ? Math.round(d / 60) + ' min ago' : d < 172800 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' days ago'; };
const tabs = [...document.querySelectorAll('.tab')];
const kindName = k => k === 'tv' ? 'show' : k === 'youtube' ? 'YouTube' : 'movie';
function show(id) {
  if (!document.getElementById(id)) id = 'start';
  tabs.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === id));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === id));
  if (id === 'library' && !$('#lgrid').children.length) lib();
  if (id === 'requests' || id === 'account') state();
}
tabs.forEach(b => b.onclick = () => { history.replaceState(null, '', '#' + b.dataset.tab); show(b.dataset.tab); });
addEventListener('hashchange', () => show(location.hash.slice(1)));

let lt; $('#lq').oninput = () => { clearTimeout(lt); lt = setTimeout(lib, 250); }; $('#ltype').onchange = lib;
// New titles appear without a reload: a version check every 30 s (and on coming back to the page or app) re-reads the
// library grid (unless a search is typed) and the requests (their status changes when a title arrives).
let libV = null;
async function libCheck() {
  if (document.hidden) return;
  try {
    const { v } = await api('library-version');
    if (libV === null || v === libV) { libV = v; return; }
    libV = v;
    if ($('#lgrid').children.length && !$('#lq').value.trim()) lib();
    if ($('#requests').classList.contains('on') || $('#account').classList.contains('on')) state();
  } catch {}
}
libCheck(); setInterval(libCheck, 30000); document.addEventListener('visibilitychange', libCheck);
async function lib() {
  const d = await api('library?type=' + $('#ltype').value + '&q=' + encodeURIComponent($('#lq').value.trim()));
  $('#lcount').textContent = (d.counts.Movie || 0) + ' movies · ' + (d.counts.Series || 0) + ' shows' + (d.counts.YouTube ? ' · ' + d.counts.YouTube + ' YouTube videos' : '') + ($('#lq').value.trim() ? '' : ' · newest first');
  $('#lgrid').innerHTML = d.items.map(i => '<a class=pl href="/me/watch/' + i.id + '"><figure class=poster><div class=art><img loading=lazy alt="" src="/Items/' + i.id + '/Images/Primary?maxHeight=300" onerror="this.remove()"></div><figcaption>' + esc(i.name) + '<small>' + (i.year || '') + '</small></figcaption></figure></a>').join('') || '<p class=hint style="grid-column:1/-1">Nothing matches.</p>';
}

async function shares() {
  try {
    const d = await api('shares');
    $('#shares').innerHTML = d.shares.map(x => '<div class=res style="grid-template-columns:1fr auto"><div><b>' + esc(x.title) + '</b><p>' + x.views + ' view' + (x.views === 1 ? '' : 's') + (x.last_view_at ? ' · last ' + ago(x.last_view_at) : '') + ' · ' + (x.expires_at ? 'until ' + new Date(x.expires_at * 1000).toLocaleDateString() : 'no expiry') + '</p><input readonly value="' + location.origin + '/s/' + x.id + '" onclick="this.select()" style="width:100%;margin-top:6px;font-size:13px"></div><button class=quiet data-unshare="' + x.id + '">Turn off</button></div>').join('') ||
      '<p class=hint style="margin:0">' + (d.can_share ? 'No links yet.' : 'Sharing links isn’t available on your account.') + '</p>';
  } catch (e) { $('#shares').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}
async function state() {
  if ($('#account').classList.contains('on')) shares();
  try {
    const d = await api('state');
    $('#devs').innerHTML = d.devices.map(x => '<div class=res style="grid-template-columns:1fr auto"><div><b>' + esc(x.device_name || 'Unknown device') + '</b> <span class=muted>' + esc((x.client || '') + (x.client_version ? ' ' + x.client_version : '')) + '</span><p>Last used ' + ago(x.last_seen) + (x.place ? ' · ' + esc(x.place) : '') + ' · signed in ' + new Date(x.created_at * 1000).toLocaleDateString() + '</p></div><button class=quiet data-out="' + x.id + '">Sign out</button></div>').join('') || '<p class=hint style="margin:0">No apps are signed in yet. Follow <a href="#start">Get started</a>.</p>';
    $('#notices').innerHTML = d.requests.filter(r => r.notice).map(r => '<div class="msg err notice"><button class=x data-dismiss="' + r.id + '" aria-label="Dismiss" title="Dismiss">×</button>Your request for <b>' + esc(r.title) + (r.year ? ' (' + r.year + ')' : '') + '</b> was declined.' + (r.reply ? ' The owner says: ' + esc(r.reply) : '') + ' <a href="#requests">Your requests</a></div>').join('');
    $('#reqs').innerHTML = d.requests.map(r => {
      const cls = r.hidden ? 'on' : r.status === 'available' ? 'ok' : r.status === 'declined' ? 'no' : 'on';
      return '<div class=res>' + (r.poster ? '<img alt=""' + (r.kind === 'youtube' ? ' class=yt referrerpolicy=no-referrer' : '') + ' src="' + esc(r.poster) + '">' : '<span></span>') + '<div><b>' + esc(r.title) + '</b> <span class=muted>' + (r.year ? r.year + ' · ' : '') + kindName(r.kind) + '</span><br><span class="pill ' + cls + '">' + esc(r.label) + '</span>' +
        (r.reply ? '<p>' + esc(r.reply) + '</p>' : '') + (r.note ? '<p>Your note: ' + esc(r.note) + '</p>' : '') + '</div>' +
        (['pending', 'declined', 'available'].includes(r.status) ? '<button class=quiet data-cancel="' + r.id + '">' + (r.status === 'pending' ? 'Withdraw' : 'Remove') + '</button>' : '<span></span>') + '</div>';
    }).join('') || '<p class=hint style="margin:0">Nothing yet. Search above to ask for a title.</p>';
  } catch (e) { $('#reqs').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.out) { b.disabled = true; await api('signout', { id: b.dataset.out }); state(); }
    if (b.dataset.dismiss) { b.disabled = true; await api('dismiss', { id: b.dataset.dismiss }); state(); }
    if (b.dataset.cancel) { b.disabled = true; await api('cancel', { id: b.dataset.cancel }); state(); }
    if (b.dataset.unshare) { if (!confirm('Turn this link off? Anyone who has it won’t be able to watch any more.')) return; b.disabled = true; await api('shares/revoke', { id: b.dataset.unshare }); shares(); }
    if (b.dataset.req) {
      const note = prompt(b.dataset.yt ? 'Anything to add? (optional)' : 'Anything to add? (optional, e.g. which seasons)') ;
      if (note === null) return;
      b.disabled = true; b.textContent = 'Asking…';
      const r = await api('request', b.dataset.yt ? { kind: 'youtube', yt_id: b.dataset.yt, note } : { kind: b.dataset.kind, tmdb_id: Number(b.dataset.req), note });
      b.textContent = r.status === 'sent' ? 'Downloading' : 'Requested';
      if (r.note) $('#smsg').innerHTML = '<div class=msg>' + esc(r.note) + '</div>';
      state();
    }
  } catch (err) { b.disabled = false; $('#smsg').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; if (b.dataset.req) b.textContent = 'Ask for it'; }
});
let st; $('#sq').oninput = () => { clearTimeout(st); st = setTimeout(search, 350); };
async function search() {
  const q = $('#sq').value.trim(); $('#smsg').innerHTML = '';
  if (q.length < 2) { $('#sres').style.display = 'none'; return; }
  try {
    const d = await api('search?q=' + encodeURIComponent(q));
    $('#sres').style.display = '';
    $('#sres').innerHTML = d.results.map(r => '<div class=res>' + (r.poster ? '<img alt=""' + (r.kind === 'youtube' ? ' class=yt referrerpolicy=no-referrer' : '') + ' src="' + esc(r.poster) + '">' : '<span></span>') + '<div><b>' + esc(r.title) + '</b> <span class=muted>' + (r.year ? r.year + ' · ' : '') + kindName(r.kind) + '</span><p>' + esc(r.overview) + '</p></div>' +
      (r.age_limit ? '<span class=pill title="' + (r.age_limit === 'above' ? 'Above your age limit' : 'No age rating: your account only shows rated titles') + '">' + (r.age_limit === 'above' ? 'Above your age limit' : 'Not rated') + '</span>' : r.in_library ? '<span class="pill ok">In the library</span>' : r.requested ? '<span class="pill on">Requested</span>' : '<button data-req="' + r.tmdb_id + '" data-kind="' + r.kind + '"' + (r.yt_id ? ' data-yt="' + esc(r.yt_id) + '"' : '') + '>Ask for it</button>') + '</div>').join('') || '<p class=hint style="margin:0">' + (/youtu\.?be/i.test(q) ? 'That YouTube link doesn’t point to a video YouTube knows about.' : 'No matches.') + '</p>';
  } catch (e) { $('#smsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; }
}
$('#suggest').onclick = async () => { $('#npw').value = (await api('passphrase')).passphrase; $('#npw').type = 'text'; };
$('#pwf').onsubmit = async e => { e.preventDefault();
  try { await api('password', { password: $('#npw').value, sign_out: $('#pwout').checked }); $('#pwmsg').innerHTML = '<div class=msg>Password changed.' + ($('#pwout').checked ? ' Your apps will ask you to sign in again.' : '') + '</div>'; $('#npw').value = ''; state(); }
  catch (err) { $('#pwmsg').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; } };
$('#qcf').onsubmit = async e => { e.preventDefault();
  try { const r = await api('quickconnect', { code: $('#qc').value }); $('#qcmsg').innerHTML = '<div class=msg>Done: ' + esc(r.device) + ' is signing in as you.</div>'; $('#qc').value = ''; }
  catch (err) { $('#qcmsg').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; } };
$('#notify').onchange = e => api('notify', { on: e.target.checked }).catch(() => {});
show(location.hash.slice(1) || 'start');`;
