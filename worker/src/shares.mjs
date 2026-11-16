// Public share links: /s/<token> plays ONE movie or episode in any browser, no sign-in. Made from a watch page by
// the owner (/admin) or a guest (/me, if the owner allows it). Links can expire and be revoked; views are counted.
//
// What a link can reach: that title's page, its file(s) and subtitles, and conversions of those files. Nothing
// else: not the library, not other titles, not anyone's progress. Tokens are 128-bit random. Pages are noindex and
// send no referrer. Page loads and conversion starts are rate-limited per IP. A link stops working when it expires,
// is revoked, its creator is turned off or deleted, or the title leaves the library.
import { randomHex } from './passwords.mjs';
import { handlePlayer, watchData, watchHtml, WATCH_CSS, WATCH_JS } from './player.mjs';
import { page } from './portal.mjs';

const now = () => Math.floor(Date.now() / 1000);
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const GUEST_DAYS = [1, 7, 30];
export const OWNER_DAYS = [1, 7, 30, 0];   // 0 = never expires
const DEFAULTS = { guests: true };

export async function shareSettings(db) {
  const v = (await db.prepare("SELECT value FROM kv WHERE key = 'share_settings'").first())?.value;
  return { ...DEFAULTS, ...(v ? JSON.parse(v) : {}) };
}

export async function setShareSettings(db, b) {
  const s = await shareSettings(db);
  if (typeof b.guests === 'boolean') s.guests = b.guests;
  await db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('share_settings', ?)").bind(JSON.stringify(s)).run();
  return s;
}

// user: the guest's row, or null for the owner.
export async function canShare(env, user) {
  if (!user) return true;
  if (user.max_age != null) return false;            // age-limited users can't publish links
  return (await shareSettings(env.DB)).guests;
}

export async function createShare(env, origin, user, b) {
  if (!(await canShare(env, user))) return { status: 403, body: { error: 'Sharing links is turned off for your account.' } };
  const item = await env.DB.prepare("SELECT id, name, type FROM items WHERE id = ? AND type IN ('Movie','Episode')").bind(String(b.item || '')).first();
  if (!item) return { status: 404, body: { error: 'Only movies and episodes can be shared.' } };
  const days = Number(b.days);
  if (!(user ? GUEST_DAYS : OWNER_DAYS).includes(days)) return { status: 400, body: { error: 'Pick how long the link should work.' } };
  const id = randomHex(16), t = now();
  await env.DB.prepare('INSERT INTO shares(id, item_id, user_id, created_at, expires_at) VALUES (?,?,?,?,?)')
    .bind(id, item.id, user?.id || null, t, days ? t + days * 86400 : null).run();
  return { status: 200, body: { id, url: `${origin}/s/${id}`, expires_at: days ? t + days * 86400 : null } };
}

export async function listShares(env, userId /* undefined = everyone (owner) */) {
  const rows = (await env.DB.prepare(`SELECT s.*, i.name, i.type, i.series_name, i.parent_index, i.index_number, i.year, u.username, u.display_name
    FROM shares s LEFT JOIN items i ON i.id = s.item_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ${userId !== undefined ? 'AND s.user_id = ?' : ''}
    ORDER BY s.created_at DESC`).bind(now(), ...(userId !== undefined ? [userId] : [])).all()).results;
  return rows.map(r => ({ id: r.id, title: r.type === 'Episode' ? `${r.series_name} · S${r.parent_index}E${r.index_number} · ${r.name}` : r.name ? `${r.name}${r.year ? ` (${r.year})` : ''}` : '(no longer in the library)',
    by: r.user_id ? (r.display_name || r.username || 'deleted user') : 'you', created_at: r.created_at, expires_at: r.expires_at, views: r.views, last_view_at: r.last_view_at }));
}

export async function revokeShare(env, id, userId /* undefined = owner, may revoke any */) {
  await env.DB.prepare(`UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL ${userId !== undefined ? 'AND user_id = ?' : ''}`)
    .bind(now(), String(id || ''), ...(userId !== undefined ? [userId] : [])).run();
  return { ok: true };
}

// What someone sees on a dead link (410 Gone): when it expired, or that it was turned off. Nothing about the title.
function gone(sh) {
  const expired = sh && !sh.revoked_at && sh.expires_at && sh.expires_at <= now();
  const when = expired ? new Date(sh.expires_at * 1000).toUTCString().replace(/:\d\d GMT$/, ' UTC') : '';
  const res = page({}, 'Link unavailable', `<div class=card><h2>${expired ? 'This link has expired' : 'This link doesn’t work any more'}</h2>
<p>${expired ? `It stopped working on ${when}.` : 'It has been turned off.'} Ask the person who sent it for a new one.</p></div>`);
  return new Response(res.body, { status: 410, headers: res.headers });
}

export async function handleShare(request, env, ctx, token, rest) {
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response('Not found', { status: 404 });
  const sh = await env.DB.prepare(`SELECT s.*, u.disabled FROM shares s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
  const active = sh && !sh.revoked_at && (!sh.expires_at || sh.expires_at > now()) && (!sh.user_id || sh.disabled === 0);
  const res = await (async () => {
    if (!active) return rest ? new Response('Not found', { status: 404 }) : gone(sh);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = async () => env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: 'share:' + ip })).success;
    const item = await env.DB.prepare('SELECT id, versions FROM items WHERE id = ?').bind(sh.item_id).first();
    if (!item) return rest ? new Response('Not found', { status: 404 }) : gone(null);
    const fileIds = new Set([item.id, ...(JSON.parse(item.versions || '[]')).map(v => v.id)]);
    const base = `/s/${token}`;
    if (!rest) {
      if (await limited()) return new Response('Too many requests. Try again in a minute.', { status: 429 });
      const d = await watchData(env, sh.item_id, null);
      if (!d) return gone(null);
      ctx.waitUntil(env.DB.prepare('UPDATE shares SET views = views + 1, last_view_at = ? WHERE id = ?').bind(now(), token).run());
      const w = watchHtml(d, { base, back: null, linked: false, share: { expires_at: sh.expires_at } });
      return page(env, w.title, w.body, WATCH_JS, false, WATCH_CSS);
    }
    if (!/^\/(play\/|assets\/hls\.js$)/.test(rest)) return new Response('Not found', { status: 404 });   // nothing but playback
    if (rest.endsWith('/convert') && await limited()) return json({ error: 'Too many requests. Try again in a minute.' }, 429);
    const r = await handlePlayer(request, env, ctx, { base, userId: null, viewer: null, allow: async id => fileIds.has(id), page: () => new Response('Not found', { status: 404 }) });
    return r || new Response('Not found', { status: 404 });
  })();
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow'); h.set('Referrer-Policy', 'no-referrer');
  return new Response(res.body, { status: res.status, headers: h });
}
