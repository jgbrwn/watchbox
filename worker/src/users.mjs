// People: Jellyfin users, invites, signed-in devices, and the emails that go with them.
//
// A user is a Jellyfin login (username + password) for the TV/phone apps. Users with an email can also sign in to
// the guest page /me (Cloudflare Access email code), where they accept their invite by choosing a password, see
// setup steps, and make requests. Everything a user does is keyed by their own user id; nobody sees anyone
// else's watch history, devices or requests. The owner manages everyone from /admin → Users.
import { hashPassword, validatePassword, validateUsername, randomHex, MIN_PASSWORD_LENGTH } from './passwords.mjs';

export const INVITE_DAYS = 14;
const now = () => Math.floor(Date.now() / 1000);
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const NO_PASSWORD = '!';   // can never match: invited users can't log in until they choose a password

export const portalUrl = env => String(env.ADMIN_ORIGIN || '').replace(/\/$/, '') + '/me';
export const serverUrl = env => String(env.ADMIN_ORIGIN || '').replace(/\/$/, '');
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(e) && e.length <= 200;

// Easy to type on a TV remote: four lowercase words and a number (about 38 bits from crypto randomness;
// logins are rate-limited to 10 a minute per user, so guessing would take thousands of years).
const WORDS = ('acorn amber anchor apple arrow aspen autumn badge bamboo banjo barley basil beacon berry birch biscuit bison blossom bonfire breeze brook bubble cabin cactus camel candle canoe canyon carbon cedar cello chalk cherry chestnut cider cinder clover cobalt comet copper coral cotton cougar crane crater cricket crystal cypress daisy delta denim desert dingo dolphin dove dragon dune eagle ember falcon fern fiddle fig finch fjord flint fossil fox frost galaxy garnet gecko geyser ginger glacier granite grape gravel harbor hazel heron hickory honey horizon husky iris island ivory jade jaguar jasmine juniper kayak kettle kiwi koala lagoon lantern lark lava lemon lilac lily linen lotus lynx magnet mango maple marble meadow melon meteor mint moose mosaic moss nectar nickel nutmeg oasis ocean olive onyx orbit orchid otter owl panda papaya parrot pebble pecan pepper pine planet plum pollen poppy prairie puffin quartz quill rabbit radish raven reef ribbon river robin rocket saffron sage salmon sapphire satin sequoia shadow shell sierra silver sparrow spruce squid summit sunset swan tango tiger timber topaz tulip tundra turtle valley velvet violet walnut walrus willow winter yarrow zebra zephyr').split(' ');
export function passphrase() {
  for (;;) {
    const r = crypto.getRandomValues(new Uint32Array(5));
    const p = [...r].slice(0, 4).map(n => WORDS[n % WORDS.length]).join('-') + '-' + (10 + r[4] % 90);
    if (p.length >= MIN_PASSWORD_LENGTH) return p;
  }
}

export function userStatus(u, t = now()) {
  if (u.disabled) return 'disabled';
  if (u.password_hash === NO_PASSWORD) return u.invite_expires && u.invite_expires > t ? 'invited' : 'invite expired';
  return 'active';
}

// ---------- email (Cloudflare Email Service; optional) ----------

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendEmail(env, { to, subject, text, html }) {
  if (!env.EMAIL || !env.EMAIL_FROM) return { ok: false, error: 'Email sending is not set up' };
  try {
    const r = await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject, text, html, ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}) });
    return { ok: true, id: r?.messageId || null };
  } catch (e) {
    console.error('email failed', e.code, e.message);
    return { ok: false, error: e.code === 'E_SENDER_DOMAIN_NOT_AVAILABLE' || e.code === 'E_SENDER_NOT_VERIFIED' ? 'Email sending is not set up for this domain yet' : e.code || e.message };
  }
}

const mailHtml = (title, paras, link, linkText) => `<!doctype html><html><body style="margin:0;background:#f5f3ef;font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19">
<div style="max-width:520px;margin:0 auto;padding:28px 20px"><div style="background:#fff;border:1px solid #e2ded6;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 14px">${escHtml(title)}</h1>${paras.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('')}
${link ? `<p style="margin:20px 0 6px"><a href="${escHtml(link)}" style="display:inline-block;background:#b7790f;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${escHtml(linkText)}</a></p><p style="margin:0;color:#6d6a63;font-size:13px">${escHtml(link)}</p>` : ''}
</div></div></body></html>`;

export function inviteEmail(env, u) {
  const link = portalUrl(env), name = u.display_name || u.username;
  const lines = [
    `Hi ${name},`,
    `You've been invited to Watch, a private movie and TV library you can stream on your TV, phone or computer.`,
    `To get started, open ${link} and sign in with this email address (${u.email}). You'll get a one-time code by email. Then choose a password for your username "${u.username}".`,
    `That page also shows how to connect your TV or phone (its Setup tab keeps those steps, so you can go back to them any time), and lets you ask for titles that aren't in the library yet.`,
    `This invite is good for ${INVITE_DAYS} days.`
  ];
  return {
    to: u.email, subject: "You're invited to Watch",
    text: lines.join('\n\n') + '\n',
    html: mailHtml("You're invited to Watch", lines.slice(0, 2).map(escHtml).concat(
      [`Sign in with this email address (<b>${escHtml(u.email)}</b>); you'll get a one-time code. Then choose a password for your username <b>${escHtml(u.username)}</b>.`,
       escHtml(lines[3]), `<span style="color:#6d6a63">This invite is good for ${INVITE_DAYS} days.</span>`]), link, 'Accept the invite')
  };
}

// ---------- reading ----------

export async function listUsers(db) {
  const users = (await db.prepare(`SELECT u.id, u.username, u.display_name, u.email, u.disabled, u.is_admin, u.auto_approve, u.notify, u.created_at, u.max_age, u.allow_unrated,
      (SELECT count(*) FROM shares x WHERE x.user_id = u.id AND x.revoked_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > unixepoch())) AS shares,
      u.invited_at, u.invite_expires, u.accepted_at, u.invite_email, u.password_hash,
      (SELECT max(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
      (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > unixepoch()) AS devices,
      (SELECT count(*) FROM requests r WHERE r.user_id = u.id AND r.status IN ('pending','approved','sent')) AS open_requests,
      (SELECT count(*) FROM progress p WHERE p.user_id = u.id AND p.played = 1) AS watched
    FROM users u ORDER BY u.created_at`).all()).results;
  return users.map(u => {
    const { password_hash, ...rest } = u;
    return { ...rest, status: userStatus(u), invite_email: u.invite_email ? JSON.parse(u.invite_email) : null };
  });
}

export async function listDevices(db, userId = null) {
  return (await db.prepare(`SELECT s.id, s.user_id, u.username, u.display_name, s.device_name, s.client, s.client_version, s.created_at, s.last_seen, s.ip, s.place
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.revoked_at IS NULL AND s.expires_at > unixepoch() ${userId ? 'AND s.user_id = ?' : ''}
    ORDER BY s.last_seen DESC`).bind(...(userId ? [userId] : [])).all()).results;
}

export async function signOut(db, { sessionId, userId, exceptSessionId } = {}) {
  const t = now();
  if (sessionId) return db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL' + (userId ? ' AND user_id = ?' : '')).bind(t, sessionId, ...(userId ? [userId] : [])).run();
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?').bind(t, userId, exceptSessionId || '').run();
}

export async function setPassword(db, userId, password, { signOutAll = false } = {}) {
  if (!validatePassword(password)) return { error: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` };
  await db.prepare('UPDATE users SET password_hash = ?, accepted_at = COALESCE(accepted_at, ?), invite_expires = NULL WHERE id = ?').bind(await hashPassword(password), now(), userId).run();
  if (signOutAll) await signOut(db, { userId });
  return { ok: true };
}

// ---------- owner actions ----------

// Age limits offered in /admin (see src/ages.mjs for how certificates map to ages).
export const AGE_LIMITS = [
  { value: null, label: 'No limit' },
  { value: 16, label: 'Older teens (16+ and below: adds UK 15, FSK 16)' },
  { value: 14, label: 'Teens (PG-13, TV-14 and below)' },
  { value: 12, label: 'Kids under 13 (PG, TV-PG, UK 12 and below)' },
  { value: 7, label: 'Young kids (G, TV-Y7 and below)' }
];
const parseMaxAge = v => v === '' || v == null || v === 'none' ? null : AGE_LIMITS.some(a => a.value === Number(v)) ? Number(v) : undefined;

async function createUser(env, b) {
  const db = env.DB;
  const username = String(b.username || '').trim(), email = normEmail(b.email), name = String(b.display_name || '').trim().slice(0, 80) || null;
  if (!validateUsername(username)) return json({ error: 'Usernames are letters, numbers and . _ - @ (up to 64), starting with a letter or number.' }, 400);
  if (email && !validEmail(email)) return json({ error: 'That email address doesn’t look right.' }, 400);
  if (await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) return json({ error: `The username “${username}” is taken.` }, 409);
  if (email && await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) return json({ error: 'Another user already has that email.' }, 409);
  const id = randomHex(16), t = now();
  let password = null;
  if (!email) {   // No email: no guest page; the owner hands over a password.
    password = b.password ? String(b.password) : passphrase();
    if (!validatePassword(password)) return json({ error: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
  }
  const maxAge = parseMaxAge(b.max_age);
  if (maxAge === undefined) return json({ error: 'Unknown age limit.' }, 400);
  await db.prepare(`INSERT INTO users(id, username, password_hash, is_admin, disabled, created_at, display_name, email, auto_approve, invited_at, invite_expires, accepted_at, max_age, allow_unrated)
    VALUES (?,?,?,0,0,?,?,?,?,?,?,?,?,?)`).bind(id, username, password ? await hashPassword(password) : NO_PASSWORD, t, name, email || null, b.auto_approve && maxAge == null ? 1 : 0,
      email ? t : null, email ? t + INVITE_DAYS * 86400 : null, email ? null : t, maxAge, b.allow_unrated ? 1 : 0).run();
  const out = { id, username, password, portal: portalUrl(env) };
  if (email && b.send_email !== false) out.email = await sendInvite(env, id);
  return json(out);
}

export async function sendInvite(env, id) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!u?.email) return { ok: false, error: 'This user has no email' };
  const r = await sendEmail(env, inviteEmail(env, u));
  await env.DB.prepare('UPDATE users SET invite_email = ? WHERE id = ?').bind(JSON.stringify({ at: now(), ok: r.ok, error: r.error || null }), id).run();
  return r;
}

export async function handleUsers(request, env, path) {
  const db = env.DB;
  if (path === '/admin/api/users' && request.method === 'GET')
    return json({ users: await listUsers(db), devices: await listDevices(db), portal: portalUrl(env), email_ready: !!(env.EMAIL && env.EMAIL_FROM), invite_days: INVITE_DAYS, age_limits: AGE_LIMITS });
  if (path === '/admin/api/users/passphrase' && request.method === 'GET') return json({ passphrase: passphrase() });
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await request.json().catch(() => ({}));
  if (path === '/admin/api/users/create') return createUser(env, b);
  if (path === '/admin/api/users/signout') {
    if (b.session) await signOut(db, { sessionId: String(b.session) });
    else if (b.user) await signOut(db, { userId: String(b.user) });
    return json({ ok: true });
  }
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(String(b.id || '')).first();
  if (!u) return json({ error: 'No such user' }, 404);
  const act = path.split('/').pop();
  if (act === 'update') {
    const sets = [], args = [];
    if ('display_name' in b) { sets.push('display_name = ?'); args.push(String(b.display_name || '').trim().slice(0, 80) || null); }
    if ('auto_approve' in b) { sets.push('auto_approve = ?'); args.push(b.auto_approve ? 1 : 0); }
    if ('notify' in b) { sets.push('notify = ?'); args.push(b.notify ? 1 : 0); }
    if ('max_age' in b) {
      const v = parseMaxAge(b.max_age);
      if (v === undefined) return json({ error: 'Unknown age limit.' }, 400);
      sets.push('max_age = ?'); args.push(v);
      if (v != null) { sets.push('auto_approve = 0'); await db.prepare('UPDATE shares SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL').bind(u.id).run(); }
    }
    if ('allow_unrated' in b) { sets.push('allow_unrated = ?'); args.push(b.allow_unrated ? 1 : 0); }
    if ('email' in b) {
      const email = normEmail(b.email);
      if (email && !validEmail(email)) return json({ error: 'That email address doesn’t look right.' }, 400);
      if (email && await db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(email, u.id).first()) return json({ error: 'Another user already has that email.' }, 409);
      sets.push('email = ?'); args.push(email || null);
    }
    if ('disabled' in b) {
      sets.push('disabled = ?'); args.push(b.disabled ? 1 : 0);
      if (b.disabled) await signOut(db, { userId: u.id });
    }
    if (sets.length) await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args, u.id).run();
    return json({ ok: true });
  }
  if (act === 'password') {
    const password = b.password ? String(b.password) : passphrase();
    const r = await setPassword(db, u.id, password, { signOutAll: !!b.sign_out });
    return r.error ? json(r, 400) : json({ password });
  }
  if (act === 'invite') {   // (re)send: renews the 14 days
    if (!u.email) return json({ error: 'Add an email first.' }, 400);
    await db.prepare('UPDATE users SET invited_at = ?, invite_expires = ? WHERE id = ?').bind(now(), now() + INVITE_DAYS * 86400, u.id).run();
    return json({ email: b.send_email === false ? null : await sendInvite(env, u.id), portal: portalUrl(env) });
  }
  if (act === 'delete') {
    if (b.confirm !== u.username) return json({ error: 'Type the username to confirm.' }, 400);
    await db.batch(['sessions', 'progress', 'favorites', 'requests', 'shares'].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(u.id))
      .concat(db.prepare('DELETE FROM users WHERE id = ?').bind(u.id)));
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}
