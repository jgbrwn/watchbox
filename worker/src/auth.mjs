// Jellyfin-style app authentication: username/password -> opaque token.
import { verifyPassword, randomHex } from './passwords.mjs';

export async function sha256Hex(value) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Parse `MediaBrowser Client="..", Device="..", DeviceId="..", Version="..", Token=".."`.
export function parseAuthHeader(request) {
  const out = {};
  for (const name of ['Authorization', 'X-Emby-Authorization']) {
    const h = request.headers.get(name) || '';
    if (!/^(MediaBrowser|Emby)\s/i.test(h)) continue;
    for (const m of h.replace(/^(MediaBrowser|Emby)\s+/i, '').matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
      let v = m[2] ?? m[3];
      try { v = decodeURIComponent(v); } catch {}
      out[m[1].toLowerCase()] = v;
    }
  }
  return out;
}

export function extractToken(request) {
  const auth = parseAuthHeader(request);
  if (auth.token) return auth.token;
  for (const h of ['X-Emby-Token', 'X-MediaBrowser-Token']) { const v = request.headers.get(h); if (v) return v.trim(); }
  const url = new URL(request.url);
  for (const [k, v] of url.searchParams) if (['api_key', 'apikey'].includes(k.toLowerCase())) return v;
  return null;
}

// Where a request came from (Cloudflare's own geolocation of the client IP).
export function where(request) {
  const cf = request.cf || {};
  const place = [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || null;
  return { ip: request.headers.get('CF-Connecting-IP') || null, place };
}

export async function lookupSession(request, env) {
  const token = extractToken(request);
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const s = await env.DB.prepare(`SELECT s.id AS session_id, s.device_id, s.device_name, s.client, s.client_version, s.last_seen,
      u.id AS user_id, u.username, u.is_admin, u.max_age, u.allow_unrated
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0`).bind(hash, now).first();
  if (!s) return null;
  s.token = token;
  if (!s.last_seen || now - s.last_seen > 3600) {
    // Sliding expiry: active devices stay signed in, like real Jellyfin. Also where the device is now.
    const w = where(request);
    await env.DB.prepare('UPDATE sessions SET last_seen=?, expires_at=?, ip=COALESCE(?, ip), place=COALESCE(?, place) WHERE id=?').bind(now, now + 365 * 86400, w.ip, w.place, s.session_id).run();
  }
  return s;
}

export async function login(request, env, body) {
  const username = String(body?.Username ?? body?.username ?? '');
  const password = String(body?.Pw ?? body?.pw ?? body?.Password ?? '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').bind(username).first();
  const ok = await verifyPassword(password, user?.password_hash);
  if (!user || !ok) return null;
  return createSession(request, env, user);
}

// A new Jellyfin session for a user, described by the client's Authorization header.
export async function createSession(request, env, user) {
  const a = parseAuthHeader(request);
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const id = randomHex(16);
  const w = where(request);
  await env.DB.prepare(`INSERT INTO sessions(id, user_id, token_hash, device_id, device_name, client, client_version, created_at, last_seen, expires_at, ip, place)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, user.id, await sha256Hex(token), a.deviceid || null, a.device || null, a.client || null, a.version || null, now, now, now + 365 * 86400, w.ip, w.place).run();
  return { user, token, session: { session_id: id, user_id: user.id, username: user.username, device_id: a.deviceid, device_name: a.device, client: a.client, client_version: a.version } };
}

export async function logout(env, session) {
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(Math.floor(Date.now() / 1000), session.session_id).run();
}
