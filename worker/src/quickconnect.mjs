// Jellyfin Quick Connect. A TV app asks for a code (Initiate), shows it, and polls (Connect) until a signed-in person
// approves the code: on the guest page /me, in /admin → Users, or from another Jellyfin app (Authorize). The TV then
// trades its secret for a normal session (AuthenticateWithQuickConnect). Codes live 10 minutes and work once.
import { parseAuthHeader, sha256Hex, createSession } from './auth.mjs';
import { randomHex } from './passwords.mjs';

export const QC_TTL = 600;
const now = () => Math.floor(Date.now() / 1000);

const result = (row, secret) => ({
  Authenticated: !!row.authorized_at, Secret: secret, Code: row.code, DeviceId: row.device_id || '', DeviceName: row.device_name || '',
  AppName: row.client || '', AppVersion: row.client_version || '', DateAdded: new Date(row.created_at * 1000).toISOString()
});

export async function initiate(request, env) {
  const a = parseAuthHeader(request), t = now();
  await env.DB.prepare('DELETE FROM quickconnect WHERE created_at < ?').bind(t - QC_TTL).run();
  let code;
  for (let i = 0; i < 10; i++) {
    code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    if (!(await env.DB.prepare('SELECT 1 FROM quickconnect WHERE code = ?').bind(code).first())) break;
  }
  const secret = randomHex(32);
  const row = { code, device_id: a.deviceid || null, device_name: a.device || null, client: a.client || null, client_version: a.version || null, created_at: t, authorized_at: null };
  await env.DB.prepare('INSERT INTO quickconnect(secret_hash, code, device_id, device_name, client, client_version, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(await sha256Hex(secret), code, row.device_id, row.device_name, row.client, row.client_version, t).run();
  return result(row, secret);
}

async function bySecret(env, secret) {
  if (typeof secret !== 'string' || secret.length > 200) return null;
  const row = await env.DB.prepare('SELECT * FROM quickconnect WHERE secret_hash = ?').bind(await sha256Hex(secret)).first();
  return row && row.created_at > now() - QC_TTL ? row : null;
}

export async function connect(env, secret) {
  const row = await bySecret(env, secret);
  return row ? result(row, secret) : null;
}

// Approve a code for a user. Returns the device that will be signed in, or an error.
export async function authorize(env, code, userId) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return { error: 'Codes have 6 digits.' };
  const row = await env.DB.prepare('SELECT * FROM quickconnect WHERE code = ? AND created_at > ?').bind(code, now() - QC_TTL).first();
  if (!row) return { error: 'That code isn’t valid any more. Codes last 10 minutes; ask the TV for a new one.' };
  if (row.authorized_at) return { error: 'That code has already been used.' };
  await env.DB.prepare('UPDATE quickconnect SET user_id = ?, authorized_at = ? WHERE secret_hash = ?').bind(userId, now(), row.secret_hash).run();
  return { device: [row.device_name, row.client].filter(Boolean).join(' · ') || 'a device' };
}

// The TV trades its approved secret for a session (once).
export async function authenticate(request, env, secret) {
  const row = await bySecret(env, secret);
  if (!row || !row.authorized_at || !row.user_id) return null;
  await env.DB.prepare('DELETE FROM quickconnect WHERE secret_hash = ?').bind(row.secret_hash).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').bind(row.user_id).first();
  if (!user) return null;
  return createSession(request, env, user);
}
