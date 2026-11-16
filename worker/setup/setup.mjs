#!/usr/bin/env node
// watchbox Cloudflare setup: creates (or reuses) everything on your Cloudflare account and deploys the Worker.
//
//   node setup/setup.mjs --answers my-answers.json        (see setup/answers.example.json; asks for anything missing)
//   node setup/setup.mjs --answers my-answers.json --teardown   (deletes what it created for that "name")
//
// Steps: check the API token(s) -> find the account and the zone of your hostname -> D1 database -> Zero Trust:
// one-time-PIN login, two Access apps (/admin for you, /me for invited guests) -> write wrangler.<name>.jsonc ->
// apply database migrations -> deploy (custom domains create their DNS records) -> set secrets -> create your
// Jellyfin login -> check the server answers. Safe to run again: existing resources are found by name and reused.
//
// Needs Node 20+ and `npm install` in app/ (for wrangler). Requires the Workers Paid plan (the library sync needs
// more CPU time than the free plan allows).
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { hashPassword, randomHex, MIN_PASSWORD_LENGTH } from '../src/passwords.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const TEARDOWN = args.includes('--teardown');
const say = (...m) => console.log(...m);
const step = m => console.log('\n== ' + m);
const die = m => { console.error('\nSetup stopped: ' + m); process.exit(1); };

// ---------- answers ----------
const A = arg('--answers') ? JSON.parse(readFileSync(arg('--answers'), 'utf8')) : {};
const readKv = f => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
if (A.storage_values_file) Object.assign(A.storage ||= {}, mapStorage(readKv(A.storage_values_file)));
if (A.box_values_file) Object.assign(A.box ||= {}, mapBox(readKv(A.box_values_file)));
function mapStorage(v) { return { origin_base_url: v.ORIGIN_BASE_URL, origin_authorization: v.ORIGIN_AUTHORIZATION, manage_secret: v.MANAGE_SECRET }; }
function mapBox(v) { const t = v.TOOLS ? JSON.parse(v.TOOLS) : {}; return { cc_upstream: t.cc?.upstream, dl_upstream: t.dl?.upstream, rs_upstream: t.rs?.upstream, services: { cc: t.cc?.service, dl: t.dl?.service, rs: t.rs?.service }, tools_authorization: v.TOOLS_AUTHORIZATION, rsync_webhook_secret: v.RSYNC_WEBHOOK_SECRET, media_path: v.BOX_MEDIA_PATH }; }
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function need(key, question, { secret = false, optional = false, check } = {}) {
  let v = key.split('.').reduce((o, k) => o?.[k], A);
  while (v == null || v === '') {
    if (optional) return null;
    if (!rl) die(`missing "${key}" in the answers file`);
    v = (await rl.question(question + (secret ? ' (input shown; paste carefully) ' : ' '))).trim();
  }
  if (check && !check(v)) die(`"${key}" doesn't look right: ${secret ? '(hidden)' : v}`);
  return v;
}

const NAME = await need('name', 'A short name for this install (Worker and database name), e.g. watchbox:', { check: v => /^[a-z][a-z0-9-]{1,40}$/.test(v) });
const TOKEN = await need('api_token', 'Cloudflare API token (Workers Scripts, Workers Routes, D1, Zone DNS, Account Settings read):', { secret: true });
const ACCESS_TOKEN = A.access_api_token || TOKEN;   // may be a separate token with Access: Apps and Policies edit

async function cf(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;   // deleted, no body
  const d = await r.json().catch(() => ({}));
  if (!d.success) throw new Error(`${method} ${path.replace(/[0-9a-f]{32}/g, '…')}: ${(d.errors || []).map(e => e.message).join('; ') || 'HTTP ' + r.status}`);
  return d.result;
}
const api = (m, p, b) => cf(TOKEN, m, p, b);
const access = (m, p, b) => cf(ACCESS_TOKEN, m, p, b);

function wrangler(cmdArgs, { input, quiet = false } = {}) {
  let r;
  for (let attempt = 1; attempt <= 4; attempt++) {
    r = spawnSync(join(APP, 'node_modules/.bin/wrangler'), cmdArgs, { cwd: APP, input, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, FORCE_COLOR: '0' } });
    // A brand-new Worker can take a few seconds to be visible to the API wrangler reads right after uploading it.
    if (r.status === 0 || !/does not exist on your account|code: 10007/.test(r.stderr + r.stdout)) break;
    spawnSync('sleep', [String(5 * attempt)]);
  }
  if (r.status !== 0) die(`wrangler ${cmdArgs.slice(0, 3).join(' ')} failed:\n${(r.stderr || r.stdout || '').split('\n').filter(l => !/token|secret/i.test(l)).slice(-15).join('\n')}`);
  if (!quiet) {
    const lines = (r.stdout || '').split('\n').map(l => l.trim()).filter(l => /Uploaded|Deployed|Current Version ID|No migrations|Executed/i.test(l));
    for (const l of new Set(lines)) say('  ' + l);
    const applied = new Set([...(r.stdout || '').matchAll(/(\d{4}_[\w]+\.sql)\s*│\s*✅/g)].map(m => m[1]));
    if (applied.size) say(`  applied ${applied.size} migration(s), last ${[...applied].sort().at(-1)}`);
  }
  return r.stdout;
}

// ---------- account and zone ----------
step('Cloudflare account');
await api('GET', '/user/tokens/verify').catch(e => die('the API token was refused: ' + e.message));
const accounts = await api('GET', '/accounts?per_page=50');
const ACCOUNT = A.account_id || (accounts.length === 1 ? accounts[0].id : die('the token sees several accounts; set "account_id"'));
say('  account: ' + (accounts.find(a => a.id === ACCOUNT)?.name || ACCOUNT));
const HOST = await need('hostname', 'Hostname for your server (a name on a domain in this account), e.g. watch.example.com:', { check: v => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) });
let zone = null;
for (let parts = HOST.split('.'); parts.length >= 2 && !zone; parts = parts.slice(1)) zone = (await api('GET', `/zones?name=${parts.join('.')}&account.id=${ACCOUNT}`))[0] || null;
if (!zone) die(`no zone in this account for ${HOST}. Add the domain to Cloudflare first.`);
say('  zone: ' + zone.name);
await tlsCheck();
const sub = HOST.slice(0, -(zone.name.length + 1)) || 'watch';
const toolHost = id => A.tool_hosts?.[id] || `${sub}-${id}.${zone.name}`;
const D1_NAME = NAME;
const CONFIG = join(APP, `wrangler.${NAME}.jsonc`);

if (TEARDOWN) await teardown();

// ---------- D1 ----------
step('Database');
let db = (await api('GET', `/accounts/${ACCOUNT}/d1/database?name=${D1_NAME}`)).find(d => d.name === D1_NAME);
if (!db) { db = await api('POST', `/accounts/${ACCOUNT}/d1/database`, { name: D1_NAME }); say('  created D1 ' + D1_NAME); }
else say('  using existing D1 ' + D1_NAME);

// ---------- Zero Trust: login and Access apps ----------
step('Zero Trust (Access)');
const org = await access('GET', `/accounts/${ACCOUNT}/access/organizations`).catch(e => die('Zero Trust isn\'t set up on this account, or the token lacks Access permissions (' + e.message + '). Open the Cloudflare dashboard → Zero Trust once to create your team (the free plan is enough), then run setup again.'));
const TEAM = 'https://' + org.auth_domain;
say('  team: ' + TEAM);
let otp = (await access('GET', `/accounts/${ACCOUNT}/access/identity_providers`)).find(p => p.type === 'onetimepin');
if (!otp) { otp = await access('POST', `/accounts/${ACCOUNT}/access/identity_providers`, { name: 'One-time PIN', type: 'onetimepin', config: {} }); say('  enabled one-time PIN login'); }
const ADMIN_EMAIL = (await need('admin_email', 'Your email (the only one allowed into /admin):', { check: v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) })).toLowerCase();
const apps = await access('GET', `/accounts/${ACCOUNT}/access/apps`);
async function accessApp(label, path, session, include) {
  const name = `${NAME}: ${label}`;
  let app = apps.find(a => a.name === name);
  const body = { name, type: 'self_hosted', domain: `${HOST}/${path}`, destinations: [{ type: 'public', uri: `${HOST}/${path}` }, { type: 'public', uri: `${HOST}/${path}/*` }],
    session_duration: session, allowed_idps: [otp.id], auto_redirect_to_identity: true, app_launcher_visible: false, allow_authenticate_via_warp: false, policies: [] };
  if (!app) { app = await access('POST', `/accounts/${ACCOUNT}/access/apps`, body); say(`  created Access app "${name}"`); }
  else { app = await access('PUT', `/accounts/${ACCOUNT}/access/apps/${app.id}`, { ...body, policies: undefined }); say(`  updated Access app "${name}"`); }
  const pols = await access('GET', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`);
  const pol = { name: `${label}: allow`, decision: 'allow', include, session_duration: session };
  if (!pols.length) await access('POST', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, pol);
  else await access('PUT', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies/${pols[0].id}`, pol);
  return app.aud;
}
const ADMIN_AUD = await accessApp('admin', 'admin', '24h', [{ email: { email: ADMIN_EMAIL } }]);
const GUEST_AUD = await accessApp('guests', 'me', '720h', [{ everyone: {} }]);   // the Worker only admits users' emails

// ---------- configuration ----------
step('Configuration');
const TMDB = await need('tmdb_token', 'TMDB API Read Access Token (themoviedb.org → Settings → API):', { secret: true });
const ORIGIN = await need('storage.origin_base_url', 'Storage ORIGIN_BASE_URL (from the storage installer):', { check: v => /^https:\/\//.test(v) });
const ORIGIN_AUTH = await need('storage.origin_authorization', 'Storage ORIGIN_AUTHORIZATION:', { secret: true, check: v => v.startsWith('Basic ') });
const MANAGE = await need('storage.manage_secret', 'Storage MANAGE_SECRET:', { secret: true });
const box = A.box?.dl_upstream ? A.box : null;
const prev = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\s*\/\/.*$/mg, '')) : null;
const vars = {
  SERVER_NAME: A.server_name || 'Watch',
  ORIGIN_BASE_URL: ORIGIN.replace(/\/?$/, '/'),
  JELLYFIN_SERVER_ID: prev?.vars?.JELLYFIN_SERVER_ID || randomHex(16),   // keep: apps remember the server by it
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: ADMIN_AUD, GUEST_ACCESS_AUD: GUEST_AUD,
  ADMIN_EMAIL_ALLOWLIST: ADMIN_EMAIL, ADMIN_ORIGIN: 'https://' + HOST,
  EMAIL_FROM: A.email_from || `${A.server_name || 'Watch'} <watch@${zone.name}>`,
  LIBRARY_ROOTS: A.library_roots || [{ id: 'movies', library: 'movies' }, { id: 'tv', library: 'tv' }, { id: 'youtube', library: 'youtube' }],
  STORAGE_NAME: A.storage?.name || 'storage', BOX_NAME: 'the download box',
  ...(A.storage?.quota_mb ? { STORAGE_QUOTA_MB: String(A.storage.quota_mb) } : {}),
  ...(box ? { BOX_MEDIA_PATH: box.media_path || '/home/watchbox/media/', TOOLS: {
    cc: { label: 'Find', name: 'c-cli', host: toolHost('cc'), upstream: box.cc_upstream, service: box.services?.cc || 'watchbox-c-cli-web' },
    dl: { label: 'Downloads', name: 'qBittorrent (VueTorrent)', host: toolHost('dl'), upstream: box.dl_upstream, service: box.services?.dl || 'watchbox-qbittorrent',
          storage_defaults: { vuetorrent_webuiSettings: '{"theme":{"mode":"dark","light":"light-legacy","dark":"dark-legacy"}}' } },
    rs: { label: 'Transfer', name: 'rsync-web', host: toolHost('rs'), upstream: box.rs_upstream, service: box.services?.rs || 'watchbox-rsync-web' } } } : {})
};
const routes = [HOST, ...(box ? ['cc', 'dl', 'rs'].map(toolHost) : [])].map(pattern => ({ pattern, custom_domain: true }));
const config = {
  $schema: 'node_modules/wrangler/config-schema.json', name: NAME, main: 'src/index.mjs', compatibility_date: '2026-10-15',
  workers_dev: false, preview_urls: false, routes, vars,
  d1_databases: [{ binding: 'DB', database_name: D1_NAME, database_id: db.uuid, migrations_dir: 'migrations' }],
  send_email: [{ name: 'EMAIL' }],
  ratelimits: [{ name: 'LOGIN_LIMITER', namespace_id: String(A.ratelimit_namespace || 1001), simple: { limit: 10, period: 60 } }],
  triggers: { crons: ['*/15 * * * *'] }, limits: { cpu_ms: 120000 }, observability: { enabled: true }
};
writeFileSync(CONFIG, '// Written by setup/setup.mjs for "' + NAME + '". Re-run setup to change it.\n' + JSON.stringify(config, null, 2) + '\n');
say('  wrote ' + CONFIG.slice(APP.length + 1));

// ---------- database, deploy, secrets ----------
step('Database tables');
wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote', '--config', CONFIG], { input: 'y\n' });
step('Deploy');
wrangler(['deploy', '--config', CONFIG]);
step('Secrets');
const secrets = { TMDB_TOKEN: TMDB, ORIGIN_AUTHORIZATION: ORIGIN_AUTH, MANAGE_SECRET: MANAGE, TOOLS_SECRET: A.tools_secret || randomHex(32),
  ...(box ? { TOOLS_AUTHORIZATION: box.tools_authorization, RSYNC_WEBHOOK_SECRET: box.rsync_webhook_secret } : {}) };
const existing = JSON.parse(wrangler(['secret', 'list', '--config', CONFIG, '--format', 'json'], { quiet: true }) || '[]').map(s => s.name);
for (const [k, v] of Object.entries(secrets)) {
  if (!v) continue;
  if (k === 'TOOLS_SECRET' && existing.includes(k) && !A.tools_secret) continue;   // keep the existing random one
  wrangler(['secret', 'put', k, '--config', CONFIG], { input: v, quiet: true });
  say('  set ' + k);
}

// ---------- your Jellyfin login ----------
step('Your login for the apps');
const OWNER_USER = A.owner_user?.username || 'me';
const have = wrangler(['d1', 'execute', D1_NAME, '--remote', '--json', '--config', CONFIG, '--command', `SELECT id FROM users WHERE username = '${OWNER_USER.replace(/'/g, "''")}'`], { quiet: true });
if (JSON.parse(have)[0].results.length) say(`  user "${OWNER_USER}" already exists (unchanged)`);
else {
  const pw = A.owner_user?.password || randomHex(12);
  if (pw.length < MIN_PASSWORD_LENGTH) die(`owner_user.password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  wrangler(['d1', 'execute', D1_NAME, '--remote', '--config', CONFIG, '--command',
    `INSERT INTO users(id, username, password_hash, is_admin, created_at, email) VALUES (${q(randomHex(16))}, ${q(OWNER_USER)}, ${q(await hashPassword(pw))}, 1, unixepoch(), ${q(ADMIN_EMAIL)})`], { quiet: true });
  say(`  created user "${OWNER_USER}" with password: ${pw}`);
  say('  (use it in VidHub / the Jellyfin apps; change it later on /admin → Users)');
}

// ---------- check ----------
step('Check');
let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  try { const r = await fetch(`https://${HOST}/System/Info/Public`); ok = r.ok && (await r.json()).ProductName === 'Jellyfin Server'; } catch {}
  if (!ok) await new Promise(r => setTimeout(r, 4000));
}
say(ok ? `  https://${HOST} answers as a Jellyfin server` : `  https://${HOST} isn't answering yet (DNS for a new custom domain can take a few minutes)`);
say(`\nDone. Admin page: https://${HOST}/admin (sign in with ${ADMIN_EMAIL}). The first library sync runs within 15 minutes.`);
say('Email: to send invites, set up Email Sending for ' + zone.name + ' in the Cloudflare dashboard (Email → Email Sending).');
rl?.close();

// ---------- TLS settings of the zone ----------
// Logins, passwords and video all go through this domain: refuse old TLS and plain HTTP. Reads the zone's
// settings (needs "Zone Settings: Read" on the token); fixes them only with "fix_tls": true (needs "Edit").
async function tlsCheck() {
  const get = async k => (await api('GET', `/zones/${zone.id}/settings/${k}`)).value;
  let min, https;
  try { [min, https] = [await get('min_tls_version'), await get('always_use_https')]; }
  catch { say('  TLS: couldn\'t read the zone\'s TLS settings (give the token "Zone Settings: Read" to check them)'); return; }
  const weak = !['1.2', '1.3'].includes(min), plain = https !== 'on';
  if (!weak && !plain) { say(`  TLS: minimum ${min}, HTTPS always on`); return; }
  if (weak) say(`  TLS: the zone accepts TLS ${min}; 1.2 or newer is recommended (every current app and browser supports it)`);
  if (plain) say('  TLS: "Always Use HTTPS" is off, so plain-HTTP links to the server work; turning it on is recommended');
  if (A.fix_tls === true) {
    try {
      if (weak) await api('PATCH', `/zones/${zone.id}/settings/min_tls_version`, { value: '1.2' });
      if (plain) await api('PATCH', `/zones/${zone.id}/settings/always_use_https`, { value: 'on' });
      say('  TLS: fixed (minimum 1.2, Always Use HTTPS on)');
    } catch (e) { say('  TLS: couldn\'t change the settings (' + e.message + '); change them in the dashboard: SSL/TLS → Edge Certificates'); }
  } else say('  (set "fix_tls": true in the answers to change this, or: dashboard → SSL/TLS → Edge Certificates; it affects the whole domain)');
}

// ---------- teardown ----------
async function teardown() {
  step(`Deleting the "${NAME}" install`);
  if (rl && (await rl.question(`Type the name (${NAME}) to delete its Worker, database, Access apps and custom domains: `)).trim() !== NAME) die('not confirmed');
  const doms = await api('GET', `/accounts/${ACCOUNT}/workers/domains?service=${NAME}`).catch(() => []);
  for (const d of doms) { await api('DELETE', `/accounts/${ACCOUNT}/workers/domains/${d.id}`); say('  removed custom domain ' + d.hostname); }
  await api('DELETE', `/accounts/${ACCOUNT}/workers/scripts/${NAME}?force=true`).then(() => say('  deleted Worker ' + NAME)).catch(e => say('  Worker: ' + e.message));
  const dbs = (await api('GET', `/accounts/${ACCOUNT}/d1/database?name=${NAME}`)).filter(d => d.name === NAME);
  for (const d of dbs) { await api('DELETE', `/accounts/${ACCOUNT}/d1/database/${d.uuid}`); say('  deleted D1 ' + d.name); }
  for (const a of (await access('GET', `/accounts/${ACCOUNT}/access/apps`)).filter(a => a.name.startsWith(NAME + ': '))) {
    await access('DELETE', `/accounts/${ACCOUNT}/access/apps/${a.id}`); say('  deleted Access app "' + a.name + '"');
  }
  if (existsSync(CONFIG)) { unlinkSync(CONFIG); say('  removed ' + CONFIG.slice(APP.length + 1)); }
  say('Done (the one-time PIN login method and your zone are left as they were).');
  process.exit(0);
}
