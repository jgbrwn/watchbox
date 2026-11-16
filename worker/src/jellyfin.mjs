// Jellyfin-compatible HTTP API.
import * as qc from './quickconnect.mjs';
import { ageClause, itemAllowed } from './ages.mjs';
import { lookupSession, login, logout, parseAuthHeader } from './auth.mjs';
import { itemDto, viewDto, mediaSources, userData, imageTag } from './dto.mjs';
import { viewId, libraryOfView, LIBRARIES } from './library/catalog.mjs';
import { hashId } from './library/sync.mjs';
import { randomHex } from './passwords.mjs';

export const VERSION = '10.10.7';
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function json(data, status = 200, headers = {}) {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}
const noContent = () => new Response(null, { status: 204 });
const notFound = () => json({ error: 'Not found' }, 404);

// Case-insensitive query params.
function params(url) {
  const m = new Map();
  for (const [k, v] of url.searchParams) m.set(k.toLowerCase(), v);
  return {
    get: k => m.get(k.toLowerCase()) ?? null,
    list: k => (m.get(k.toLowerCase()) || '').split(/[,|]/).map(s => s.trim()).filter(Boolean),
    bool: k => { const v = m.get(k.toLowerCase()); return v == null ? null : v.toLowerCase() === 'true'; },
    int: k => { const v = m.get(k.toLowerCase()); return v == null || v === '' ? null : parseInt(v, 10); }
  };
}

async function body(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, m => m.replace(/-/g, '').toLowerCase())) : {};
  } catch { return {}; }
}

function serverId(env) { return env.JELLYFIN_SERVER_ID; }

export function publicInfo(env, origin) {
  return { LocalAddress: origin, ServerName: env.SERVER_NAME || 'Watch', Version: VERSION, ProductName: 'Jellyfin Server', OperatingSystem: '', Id: serverId(env), StartupWizardCompleted: true };
}

function userDto(env, user, session) {
  return {
    Name: user.username, ServerId: serverId(env), Id: user.user_id || user.id, HasPassword: true, HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false, EnableAutoLogin: false, LastLoginDate: new Date().toISOString(), LastActivityDate: new Date().toISOString(),
    Configuration: {
      PlayDefaultAudioTrack: true, SubtitleLanguagePreference: '', DisplayMissingEpisodes: false, GroupedFolders: [], SubtitleMode: 'Default',
      DisplayCollectionsView: false, EnableLocalPassword: false, OrderedViews: [], LatestItemsExcludes: [], MyMediaExcludes: [],
      HidePlayedInLatest: true, RememberAudioSelections: true, RememberSubtitleSelections: true, EnableNextEpisodeAutoPlay: true, CastReceiverId: 'F007D354'
    },
    Policy: {
      IsAdministrator: !!(user.is_admin), IsHidden: false, EnableCollectionManagement: false, EnableSubtitleManagement: false, EnableLyricManagement: false,
      IsDisabled: false, BlockedTags: [], AllowedTags: [], EnableUserPreferenceAccess: true, AccessSchedules: [], BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false, EnableSharedDeviceControl: false, EnableRemoteAccess: true, EnableLiveTvManagement: false, EnableLiveTvAccess: false,
      EnableMediaPlayback: true, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false, EnableContentDeletion: false, EnableContentDeletionFromFolders: [], EnableContentDownloading: true,
      EnableSyncTranscoding: false, EnableMediaConversion: false, EnabledDevices: [], EnableAllDevices: true, EnabledChannels: [], EnableAllChannels: false,
      EnabledFolders: [], EnableAllFolders: true, InvalidLoginAttemptCount: 0, LoginAttemptsBeforeLockout: -1, MaxActiveSessions: 0,
      EnablePublicSharing: false, BlockedMediaFolders: [], BlockedChannels: [], RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider', SyncPlayAccess: 'None'
    }
  };
}

function sessionDto(env, s) {
  return {
    PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' },
    AdditionalUsers: [], Capabilities: { PlayableMediaTypes: ['Video'], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true },
    RemoteEndPoint: '', PlayableMediaTypes: ['Video'], Id: s.session_id, UserId: s.user_id, UserName: s.username,
    Client: s.client || '', LastActivityDate: new Date().toISOString(), LastPlaybackCheckIn: '0001-01-01T00:00:00.0000000Z',
    DeviceName: s.device_name || '', DeviceId: s.device_id || '', ApplicationVersion: s.client_version || '', IsActive: true,
    SupportsMediaControl: false, SupportsRemoteControl: false, NowPlayingQueue: [], NowPlayingQueueFullItems: [], HasCustomDeviceName: false,
    ServerId: serverId(env), SupportedCommands: []
  };
}

// ---------------- Query engine ----------------

const SORT = {
  sortname: 'i.sort_name', name: 'i.name', seriessortname: 'i.series_name', premieredate: 'i.premiere_date', productionyear: 'i.year',
  datecreated: 'i.date_created', datelastcontentadded: 'i.date_created', dateplayed: 'p.last_played', communityrating: 'i.rating',
  criticrating: 'i.rating', runtime: 'i.runtime_ticks', random: 'random()', indexnumber: 'i.index_number', parentindexnumber: 'i.parent_index',
  playcount: 'p.play_count', isfavoriteorliked: 'f.created_at', officialrating: 'i.official_rating', airedepisodeorder: 'i.parent_index, i.index_number',
  isfolder: 'i.type', isplayed: 'p.played', isunplayed: 'p.played'
};
const TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);

async function genreNameFromId(env, id) {
  const rows = (await env.DB.prepare("SELECT DISTINCT value AS g FROM items, json_each(items.genres)").all()).results;
  for (const r of rows) if (await hashId('genre:' + r.g) === id) return r.g;
  return null;
}

/** Returns { rows, total } with per-row user data columns attached. */
export async function queryItems(env, s, p, extra = {}) {
  const where = [], args = [];
  const parentId = extra.parentId ?? p.get('ParentId');
  const parentLib = parentId ? await libraryOfView(parentId) : null;
  const recursive = extra.recursive ?? p.bool('Recursive');
  let types = (extra.types || p.list('IncludeItemTypes')).filter(Boolean);
  const exclude = p.list('ExcludeItemTypes');
  if (p.list('MediaTypes').length && !types.length) types = ['Movie', 'Episode'];
  if (types.length) {
    const ok = types.filter(t => TYPES.has(t));
    if (!ok.length) return { rows: [], total: 0 };
    where.push(`i.type IN (${ok.map(() => '?')})`); args.push(...ok);
  }
  if (exclude.length) { where.push(`i.type NOT IN (${exclude.map(() => '?')})`); args.push(...exclude); }
  if (parentId) {
    if (parentLib) {
      where.push('i.library = ?'); args.push(parentLib);
      if (!recursive) { where.push('i.parent_id = ?'); args.push(parentId); }
    } else if (recursive) { where.push('(i.parent_id = ? OR i.series_id = ? OR i.season_id = ?)'); args.push(parentId, parentId, parentId); }
    else { where.push('i.parent_id = ?'); args.push(parentId); }
  } else if (!recursive && !types.length && !p.get('Ids') && !p.get('SearchTerm') && !extra.ids) {
    const views = await Promise.all(LIBRARIES.map(viewId));
    where.push(`i.parent_id IN (${views.map(() => '?')})`); args.push(...views);
  }
  const ids = extra.ids || p.list('Ids');
  if (ids.length) { where.push(`i.id IN (${ids.map(() => '?')})`); args.push(...ids); }
  const excludeIds = p.list('ExcludeItemIds');
  if (excludeIds.length) { where.push(`i.id NOT IN (${excludeIds.map(() => '?')})`); args.push(...excludeIds); }
  const term = p.get('SearchTerm');
  if (term) { where.push('(i.name LIKE ? OR i.original_title LIKE ? OR i.sort_name LIKE ?)'); args.push(`%${term}%`, `%${term}%`, `%${term.toLowerCase()}%`); }
  const sw = p.get('NameStartsWith');
  if (sw) { where.push('i.sort_name LIKE ?'); args.push(sw.toLowerCase() + '%'); }
  const swg = p.get('NameStartsWithOrGreater');
  if (swg) { where.push('i.sort_name >= ?'); args.push(swg.toLowerCase()); }
  const nlt = p.get('NameLessThan');
  if (nlt) { where.push('i.sort_name < ?'); args.push(nlt.toLowerCase()); }
  let genres = p.list('Genres');
  for (const gid of p.list('GenreIds')) { const g = await genreNameFromId(env, gid); if (g) genres.push(g); }
  if (genres.length) { where.push('(' + genres.map(() => 'i.genres LIKE ?').join(' OR ') + ')'); args.push(...genres.map(g => `%"${g}"%`)); }
  const years = p.list('Years').map(Number).filter(Boolean);
  if (years.length) { where.push(`i.year IN (${years.map(() => '?')})`); args.push(...years); }
  const ratings = p.list('OfficialRatings');
  if (ratings.length) { where.push(`i.official_rating IN (${ratings.map(() => '?')})`); args.push(...ratings); }
  const persons = p.list('PersonIds');
  if (persons.length) { where.push('(' + persons.map(() => 'i.people LIKE ?').join(' OR ') + ')'); args.push(...persons.map(x => `%"id":"${x}"%`)); }
  const studios = p.list('Studios');
  if (studios.length) { where.push('(' + studios.map(() => 'i.studios LIKE ?').join(' OR ') + ')'); args.push(...studios.map(x => `%"${x}"%`)); }
  const status = p.list('SeriesStatus');
  if (status.length) { where.push(`i.status IN (${status.map(() => '?')})`); args.push(...status); }
  const minRating = p.get('MinCommunityRating');
  if (minRating) { where.push('i.rating >= ?'); args.push(Number(minRating)); }
  const filters = new Set(p.list('Filters').map(f => f.toLowerCase()));
  if (p.bool('IsFavorite') === true || filters.has('isfavorite') || filters.has('isfavoriteorlikes')) where.push('f.item_id IS NOT NULL');
  if (p.bool('IsFavorite') === false) where.push('f.item_id IS NULL');
  if (filters.has('isresumable')) where.push('p.position_ticks > 0 AND p.played = 0');
  const playedFolder = played => `(i.type IN ('Series','Season') AND ${played ? 'NOT ' : ''}EXISTS (SELECT 1 FROM items e LEFT JOIN progress pe ON pe.user_id = ? AND pe.item_id = e.id WHERE e.type = 'Episode' AND (e.series_id = i.id OR e.season_id = i.id) AND IFNULL(pe.played,0) = 0))`;
  const isPlayed = p.bool('IsPlayed') ?? (filters.has('isplayed') ? true : filters.has('isunplayed') ? false : null);
  if (isPlayed === true) { where.push(`((i.type IN ('Movie','Episode') AND p.played = 1) OR ${playedFolder(true)})`); args.push(s.user_id); }
  if (isPlayed === false) { where.push(`((i.type IN ('Movie','Episode') AND IFNULL(p.played,0) = 0) OR ${playedFolder(false)})`); args.push(s.user_id); }
  if (filters.has('isfolder') || p.bool('IsFolder') === true) where.push("i.type IN ('Series','Season')");
  if (filters.has('isnotfolder') || p.bool('IsFolder') === false) where.push("i.type IN ('Movie','Episode')");
  const ac = ageClause(s);   // age limits (src/ages.mjs): applies to every listing, search and Continue Watching
  if (ac.sql) { where.push(ac.sql.replace(/^ AND /, '')); args.push(...ac.args); }
  if (extra.where) { where.push(extra.where); args.push(...(extra.whereArgs || [])); }

  const from = `FROM items i LEFT JOIN progress p ON p.user_id = ? AND p.item_id = i.id LEFT JOIN favorites f ON f.user_id = ? AND f.item_id = i.id`;
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sortBy = extra.sort || p.list('SortBy');
  const desc = (p.list('SortOrder')[0] || 'Ascending').toLowerCase().startsWith('desc');
  const order = [];
  for (const k of sortBy) { const c = SORT[k.toLowerCase()]; if (c) order.push(c.split(', ').map(x => `${x} ${desc ? 'DESC' : 'ASC'} NULLS LAST`).join(', ')); }
  if (!order.length) order.push(types.length === 1 && types[0] === 'Episode' || (parentId && !recursive && types[0] !== 'Movie') ? 'i.parent_index, i.index_number, i.sort_name' : 'i.sort_name');
  order.push('i.id');
  const limit = Math.min(extra.limit ?? p.int('Limit') ?? 5000, 5000);
  const start = Math.max(0, p.int('StartIndex') ?? 0);
  const base = [s.user_id, s.user_id, ...args];
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT i.*, p.position_ticks, p.played, p.play_count, p.last_played, f.item_id IS NOT NULL AS favorite ${from} ${w} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`).bind(...base, limit, start).all(),
    p.bool('EnableTotalRecordCount') === false ? null : env.DB.prepare(`SELECT count(*) AS n ${from} ${w}`).bind(...base).first()
  ]);
  return { rows: rows.results, total: count?.n ?? rows.results.length, start };
}

// Attach series/season rows (for image fallbacks) and folder play counts, then serialize.
export async function serialize(env, s, rows, ctx) {
  const parentIds = [...new Set(rows.flatMap(r => [r.series_id, r.season_id]).filter(Boolean))];
  const parents = new Map();
  for (let i = 0; i < parentIds.length; i += 90) {
    const chunk = parentIds.slice(i, i + 90);
    for (const r of (await env.DB.prepare(`SELECT id, images FROM items WHERE id IN (${chunk.map(() => '?')})`).bind(...chunk).all()).results) parents.set(r.id, r);
  }
  const folders = rows.filter(r => r.type === 'Series' || r.type === 'Season').map(r => r.id);
  const counts = new Map();
  for (let i = 0; i < folders.length; i += 45) {
    const chunk = folders.slice(i, i + 45);
    const q = `SELECT k AS id, count(*) AS total, sum(IFNULL(pe.played,0) = 0) AS unplayed FROM (
        SELECT e.id, e.series_id AS k FROM items e WHERE e.type = 'Episode' AND e.series_id IN (${chunk.map(() => '?')})
        UNION ALL SELECT e.id, e.season_id AS k FROM items e WHERE e.type = 'Episode' AND e.season_id IN (${chunk.map(() => '?')})
      ) x LEFT JOIN progress pe ON pe.user_id = ? AND pe.item_id = x.id GROUP BY k`;
    for (const r of (await env.DB.prepare(q).bind(...chunk, ...chunk, s.user_id).all()).results) counts.set(r.id, r);
  }
  const c = { ...ctx, parents };
  return Promise.all(rows.map(r => {
    const cnt = counts.get(r.id);
    return itemDto(r, c, { position_ticks: r.position_ticks, played: r.played, play_count: r.play_count, last_played: r.last_played, favorite: r.favorite, ...(cnt ? { unplayed: cnt.unplayed, total: cnt.total } : {}) });
  }));
}

// One item by id (null when it doesn't exist or is above the user's age limit, so it 404s like a missing item).
async function getItemRow(env, s, id) {
  const ac = ageClause(s);
  return env.DB.prepare(`SELECT i.*, p.position_ticks, p.played, p.play_count, p.last_played, f.item_id IS NOT NULL AS favorite
    FROM items i LEFT JOIN progress p ON p.user_id = ? AND p.item_id = i.id LEFT JOIN favorites f ON f.user_id = ? AND f.item_id = i.id
    WHERE i.id = ?${ac.sql}`).bind(s.user_id, s.user_id, id, ...ac.args).first();
}

async function views(env, s, ctx) {
  const rootId = await hashId('root');
  const out = [];
  for (const lib of LIBRARIES) {
    const id = await viewId(lib);
    const top = await env.DB.prepare("SELECT images FROM items WHERE library = ? AND type IN ('Movie','Series') AND images LIKE '%\"Backdrop\":\"%' ORDER BY rating DESC NULLS LAST, date_created DESC LIMIT 1").bind(lib).first();
    const count = (await env.DB.prepare("SELECT count(*) n FROM items WHERE parent_id = ?").bind(id).first()).n;
    if (lib === 'youtube' && !count) continue;   // shown once the first video is in
    out.push(await viewDto(lib, ctx, { id, rootId, count, image: parse(top?.images)?.Backdrop }));
  }
  return out;
}

// ---------------- Progress ----------------

export async function saveProgress(env, s, itemId, positionTicks, { stopped = false } = {}) {
  const item = await env.DB.prepare("SELECT id, runtime_ticks, type FROM items WHERE id = ?").bind(itemId).first();
  if (!item || !['Movie', 'Episode'].includes(item.type)) return;
  const now = Math.floor(Date.now() / 1000);
  let pos = Math.max(0, Math.round(Number(positionTicks) || 0));
  const prev = await env.DB.prepare('SELECT * FROM progress WHERE user_id = ? AND item_id = ?').bind(s.user_id, itemId).first();
  let played = prev?.played || 0, count = prev?.play_count || 0;
  if (stopped && item.runtime_ticks) {
    const pct = (pos / item.runtime_ticks) * 100;
    if (pct >= 90) { played = 1; count += 1; pos = 0; }
    else if (pct < 5 && pos < 3000 * 10_000_000 / 10) { pos = 0; } // under 5% (and < 5 min): don't offer resume
    else if (pct >= 5) played = 0;
  } else if (!stopped && pos > 0 && played && item.runtime_ticks && pos / item.runtime_ticks < 0.9) {
    played = 0; // rewatching
  }
  await env.DB.prepare(`INSERT INTO progress(user_id, item_id, position_ticks, played, play_count, last_played) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET position_ticks = excluded.position_ticks, played = excluded.played, play_count = excluded.play_count, last_played = excluded.last_played`)
    .bind(s.user_id, itemId, pos, played, count, now).run();
}

async function setPlayed(env, s, id, played) {
  const item = await env.DB.prepare('SELECT id, type FROM items WHERE id = ?').bind(id).first();
  if (!item) return null;
  const targets = item.type === 'Series' || item.type === 'Season'
    ? (await env.DB.prepare("SELECT id FROM items WHERE type = 'Episode' AND (series_id = ? OR season_id = ?)").bind(id, id).all()).results.map(r => r.id)
    : [id];
  const now = Math.floor(Date.now() / 1000);
  const stmts = targets.map(t => played
    ? env.DB.prepare(`INSERT INTO progress(user_id, item_id, position_ticks, played, play_count, last_played) VALUES (?,?,0,1,1,?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET played = 1, position_ticks = 0, play_count = play_count + 1, last_played = excluded.last_played`).bind(s.user_id, t, now)
    : env.DB.prepare('UPDATE progress SET played = 0, position_ticks = 0 WHERE user_id = ? AND item_id = ?').bind(s.user_id, t));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return item;
}

// ---------------- Next up ----------------

async function nextUp(env, s, p, ctx) {
  const seriesFilter = p.get('SeriesId');
  const limit = p.int('Limit') ?? 24;
  // Last fully watched (or in-progress) episode per series, most recent first.
  const recent = (await env.DB.prepare(`SELECT e.series_id, e.parent_index, e.index_number, pr.last_played, pr.played
      FROM progress pr JOIN items e ON e.id = pr.item_id
      WHERE pr.user_id = ? AND e.type = 'Episode' ${seriesFilter ? 'AND e.series_id = ?' : ''}
      ORDER BY pr.last_played DESC`).bind(s.user_id, ...(seriesFilter ? [seriesFilter] : [])).all()).results;
  const seen = new Set(), out = [];
  for (const r of recent) {
    if (seen.has(r.series_id)) continue;
    seen.add(r.series_id);
    const next = await env.DB.prepare(`SELECT i.id FROM items i LEFT JOIN progress pe ON pe.user_id = ? AND pe.item_id = i.id
        WHERE i.type = 'Episode' AND i.series_id = ? AND IFNULL(pe.played,0) = 0 AND IFNULL(pe.position_ticks,0) = 0
          AND (i.parent_index > ? OR (i.parent_index = ? AND IFNULL(i.index_number,0) > ?)) AND i.parent_index > 0
        ORDER BY i.parent_index, i.index_number LIMIT 1`).bind(s.user_id, r.series_id, r.parent_index ?? 0, r.parent_index ?? 0, r.index_number ?? 0).first();
    if (next) out.push(next.id);
    if (out.length >= limit) break;
  }
  if (!out.length) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  const { rows } = await queryItems(env, s, params(new URL('http://x/')), { ids: out, recursive: true, limit: out.length });
  rows.sort((a, b) => out.indexOf(a.id) - out.indexOf(b.id));
  return { Items: await serialize(env, s, rows, ctx), TotalRecordCount: rows.length, StartIndex: 0 };
}

// ---------------- Router ----------------

export async function handleJellyfin(request, env, ctxBase) {
  const url = new URL(request.url);
  let path = url.pathname.replace(/^\/(emby|jellyfin)(?=\/)/i, '').replace(/\/+$/, '') || '/';
  const lower = path.toLowerCase();
  const seg = lower.split('/').filter(Boolean);
  const raw = path.split('/').filter(Boolean);
  const m = request.method;
  const p = params(url);
  const origin = url.origin;

  // ---- Public endpoints ----
  if (lower === '/system/info/public') return json(publicInfo(env, origin));
  if (lower === '/system/ping') return json('Jellyfin Server');
  if (lower === '/branding/configuration') return json({ LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false });
  if (lower === '/branding/css' || lower === '/branding/css.css') return new Response('', { headers: { 'Content-Type': 'text/css' } });
  if (lower === '/users/public') return json([]);
  if (lower === '/quickconnect/enabled') return json(true);
  if (lower === '/quickconnect/initiate' && (m === 'POST' || m === 'GET')) {
    if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: 'qc:' + (request.headers.get('CF-Connecting-IP') || 'unknown') })).success) return json({ error: 'Too many requests' }, 429);
    return json(await qc.initiate(request, env));
  }
  if (lower === '/quickconnect/connect' && m === 'GET') {
    const r = await qc.connect(env, p.get('Secret'));
    return r ? json(r) : json({ error: 'Unknown or expired code' }, 404);
  }
  if (lower === '/users/authenticatewithquickconnect' && m === 'POST') {
    const b = await body(request);
    const r = await qc.authenticate(request, env, b?.Secret ?? b?.secret);
    if (!r) return json({ error: 'Not authorized' }, 401);
    return json({ User: userDto(env, { ...r.user, user_id: r.user.id }), SessionInfo: sessionDto(env, r.session), AccessToken: r.token, ServerId: serverId(env) });
  }
  if (lower === '/system/endpoint') return json({ IsLocal: false, IsInNetwork: false });
  if (lower === '/users/authenticatebyname' && m === 'POST') {
    const b = await body(request);
    // Brute-force guard: 10 attempts a minute per IP and per username (Workers rate limiting binding).
    if (env.LOGIN_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const user = String(b?.Username ?? b?.username ?? '').toLowerCase().slice(0, 100);
      const [a, u] = await Promise.all([env.LOGIN_LIMITER.limit({ key: 'ip:' + ip }), env.LOGIN_LIMITER.limit({ key: 'user:' + user })]);
      if (!a.success || !u.success) return json({ error: 'Too many login attempts. Try again in a minute.' }, 429);
    }
    const r = await login(request, env, b);
    if (!r) return json({ error: 'Invalid username or password' }, 401);
    return json({ User: userDto(env, { ...r.user, user_id: r.user.id }), SessionInfo: sessionDto(env, r.session), AccessToken: r.token, ServerId: serverId(env) });
  }

  const s = await lookupSession(request, env);
  if (!s) return json({ error: 'Unauthorized' }, 401);
  const fieldsParam = p.list('Fields');
  const ctx = { ...ctxBase, serverId: serverId(env), origin, token: s.token, fields: fieldsParam.length ? new Set(fieldsParam.map(f => f.toLowerCase())) : new Set(['overview', 'primaryimageaspectratio']) };
  const ctxAll = { ...ctx, fields: null };

  // Normalize "/Users/{uid}/..." to the modern unprefixed equivalents.
  let rest = seg, restRaw = raw;
  if (seg[0] === 'users' && seg.length >= 2 && /^[0-9a-f-]{32,36}$/.test(seg[1])) {
    rest = seg.slice(2); restRaw = raw.slice(2);
    if (!rest.length) return json(userDto(env, s));
  }
  const r0 = rest[0], r1 = rest[1], r2 = rest[2], r3 = rest[3];

  // ---- System / users / sessions ----
  if (lower === '/system/info') return json({ ...publicInfo(env, origin), OperatingSystemDisplayName: 'Cloudflare Workers', HasPendingRestart: false, IsShuttingDown: false, SupportsLibraryMonitor: true, WebSocketPortNumber: 443, CompletedInstallations: [], CanSelfRestart: false, CanLaunchWebBrowser: false, HasUpdateAvailable: false, TranscodingTempPath: '', ServerName: env.SERVER_NAME || 'Watch', SystemArchitecture: 'X64', CastReceiverApplications: [] });
  if (lower === '/users/me' || (seg[0] === 'users' && seg.length === 2 && seg[1] === s.user_id)) return json(userDto(env, s));
  if (lower === '/users' && m === 'GET') return json([userDto(env, s)]);
  if (lower === '/sessions' && m === 'GET') return json([sessionDto(env, s)]);
  if (lower === '/quickconnect/authorize' && m === 'POST') {
    const r = await qc.authorize(env, p.get('Code'), s.user_id);
    return r.error ? json({ error: r.error }, 404) : json(true);
  }
  if (lower === '/sessions/logout' && m === 'POST') { await logout(env, s); return noContent(); }
  if (lower.startsWith('/sessions/capabilities') || lower === '/sessions/viewing') return noContent();
  if (seg[0] === 'displaypreferences') {
    if (m !== 'GET') return noContent();
    return json({ Id: raw[1], SortBy: 'SortName', RememberIndexing: false, PrimaryImageHeight: 250, PrimaryImageWidth: 250, CustomPrefs: {}, ScrollDirection: 'Horizontal', ShowBackdrop: true, RememberSorting: false, SortOrder: 'Ascending', ShowSidebar: false, Client: p.get('client') || 'emby' });
  }
  if (lower.startsWith('/localization/') || lower === '/plugins' || lower === '/packages' || lower === '/library/virtualfolders' || lower === '/livetv/channels') return json(lower === '/livetv/channels' ? { Items: [], TotalRecordCount: 0 } : []);
  if (lower === '/system/configuration') return json({ EnableMetrics: false, ServerName: env.SERVER_NAME || 'Watch', UICulture: 'en-US', MinResumePct: 5, MaxResumePct: 90, MinResumeDurationSeconds: 300 });
  if (lower === '/playback/bitratetest') {
    const size = Math.min(p.int('size') || 1_000_000, 10_000_000);
    return new Response(new Uint8Array(size), { headers: { 'Content-Type': 'application/octet-stream' } });
  }

  // ---- Playback reporting ----
  if (lower === '/sessions/playing' || lower === '/sessions/playing/progress' || lower === '/sessions/playing/stopped') {
    const b = await body(request);
    const itemId = b.ItemId || p.get('ItemId');
    if (itemId && (b.PositionTicks != null || lower.endsWith('stopped'))) await saveProgress(env, s, itemId, b.PositionTicks ?? 0, { stopped: lower.endsWith('stopped') });
    return noContent();
  }
  if (lower === '/sessions/playing/ping') return noContent();
  if (r0 === 'playingitems' && r1) { // legacy /Users/{u}/PlayingItems/{id}[/Progress]
    const pos = p.get('PositionTicks');
    if (pos != null || m === 'DELETE') await saveProgress(env, s, restRaw[1], pos ?? 0, { stopped: m === 'DELETE' });
    return noContent();
  }

  // ---- Views ----
  if (lower === '/userviews' || r0 === 'views') { const v = await views(env, s, ctx); return json({ Items: v, TotalRecordCount: v.length, StartIndex: 0 }); }
  if (lower === '/library/mediafolders') { const v = await views(env, s, ctx); return json({ Items: v, TotalRecordCount: v.length, StartIndex: 0 }); }
  if (lower === '/userviews/groupingoptions' || r0 === 'groupingoptions') return json([]);

  // ---- Played / favorites ----
  if ((r0 === 'playeditems' || lower.startsWith('/userplayeditems/')) && (m === 'POST' || m === 'DELETE')) {
    const id = r0 === 'playeditems' ? restRaw[1] : raw[1];
    const item = await setPlayed(env, s, id, m === 'POST');
    if (!item) return notFound();
    const row = await getItemRow(env, s, id);
    return json((await serialize(env, s, [row], ctx))[0].UserData);
  }
  if ((r0 === 'favoriteitems' || lower.startsWith('/userfavoriteitems/')) && (m === 'POST' || m === 'DELETE')) {
    const id = r0 === 'favoriteitems' ? restRaw[1] : raw[1];
    if (m === 'POST') await env.DB.prepare('INSERT OR IGNORE INTO favorites(user_id, item_id, created_at) VALUES (?,?,?)').bind(s.user_id, id, Math.floor(Date.now() / 1000)).run();
    else await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').bind(s.user_id, id).run();
    const row = await getItemRow(env, s, id);
    if (!row) return notFound();
    return json((await serialize(env, s, [row], ctx))[0].UserData);
  }
  // UserData get/update: /UserItems/{id}/UserData, /Users/{u}/Items/{id}/UserData
  const udMatch = (seg[0] === 'useritems' && seg[2] === 'userdata') ? raw[1] : (r0 === 'items' && r2 === 'userdata') ? restRaw[1] : null;
  if (udMatch) {
    if (m === 'POST') {
      const b = await body(request);
      if (b.Played != null) await setPlayed(env, s, udMatch, !!b.Played);
      if (b.IsFavorite === true) await env.DB.prepare('INSERT OR IGNORE INTO favorites(user_id, item_id, created_at) VALUES (?,?,?)').bind(s.user_id, udMatch, Math.floor(Date.now() / 1000)).run();
      if (b.IsFavorite === false) await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').bind(s.user_id, udMatch).run();
      if (b.PlaybackPositionTicks != null) await saveProgress(env, s, udMatch, b.PlaybackPositionTicks);
    }
    const row = await getItemRow(env, s, udMatch);
    if (!row) return notFound();
    return json((await serialize(env, s, [row], ctx))[0].UserData);
  }
  if (r0 === 'items' && r2 === 'rating') { const row = await getItemRow(env, s, restRaw[1]); return row ? json((await serialize(env, s, [row], ctx))[0].UserData) : notFound(); }

  // ---- Resume / Latest / NextUp ----
  if (lower === '/useritems/resume' || (r0 === 'items' && r1 === 'resume')) {
    const { rows, total, start } = await queryItems(env, s, p, { where: 'p.position_ticks > 0 AND IFNULL(p.played,0) = 0', recursive: true, sort: ['DatePlayed'], types: p.list('IncludeItemTypes').length ? p.list('IncludeItemTypes') : ['Movie', 'Episode'] });
    rows.sort((a, b) => (b.last_played || 0) - (a.last_played || 0));
    return json({ Items: await serialize(env, s, rows, ctx), TotalRecordCount: total, StartIndex: start });
  }
  if (lower === '/items/latest' || (r0 === 'items' && r1 === 'latest')) {
    const limit = p.int('Limit') ?? 20;
    const parentId = p.get('ParentId');
    const lib = parentId ? await libraryOfView(parentId) : null;
    let types = p.list('IncludeItemTypes');
    if (!types.length) types = lib === 'tv' ? ['Episode'] : lib ? ['Movie'] : ['Movie', 'Episode'];
    const hidePlayed = p.bool('IsPlayed') === false || p.bool('IsPlayed') == null;
    const grouped = p.bool('GroupItems') !== false;
    const { rows } = await queryItems(env, s, p, { recursive: true, types, sort: ['DateCreated'], limit: grouped ? 400 : limit, where: hidePlayed ? 'IFNULL(p.played,0) = 0' : undefined });
    rows.sort((a, b) => b.date_created - a.date_created);
    if (!grouped) return json(await serialize(env, s, rows.slice(0, limit), ctx));
    // Group episodes by series (as Jellyfin does): one Series card per show.
    const out = [], seriesSeen = new Set();
    for (const r of rows) {
      if (r.type !== 'Episode') { out.push(r.id); }
      else if (!seriesSeen.has(r.series_id)) { seriesSeen.add(r.series_id); out.push(r.series_id); }
      if (out.length >= limit) break;
    }
    const { rows: final } = await queryItems(env, s, params(new URL('http://x/')), { ids: out, recursive: true, limit: out.length });
    final.sort((a, b) => out.indexOf(a.id) - out.indexOf(b.id));
    return json(await serialize(env, s, final, ctx));
  }
  if (lower === '/shows/nextup') return json(await nextUp(env, s, p, ctx));
  if (seg[0] === 'shows' && seg[2] === 'seasons') {
    const { rows, total } = await queryItems(env, s, p, { parentId: raw[1], types: ['Season'], recursive: false, sort: ['IndexNumber'] });
    return json({ Items: await serialize(env, s, rows, ctx), TotalRecordCount: total, StartIndex: 0 });
  }
  if (seg[0] === 'shows' && seg[2] === 'episodes') {
    const seasonId = p.get('SeasonId');
    const seasonNum = p.int('Season');
    const extra = { types: ['Episode'], recursive: true, parentId: seasonId || raw[1], sort: ['ParentIndexNumber', 'IndexNumber'] };
    if (!seasonId && seasonNum != null) { extra.where = 'i.parent_index = ?'; extra.whereArgs = [seasonNum]; }
    let { rows, total } = await queryItems(env, s, p, extra);
    const startItem = p.get('StartItemId');
    if (startItem) { const i = rows.findIndex(r => r.id === startItem); if (i > 0) rows = rows.slice(i); }
    const adjacent = p.get('AdjacentTo');
    if (adjacent) { const i = rows.findIndex(r => r.id === adjacent); if (i >= 0) rows = rows.slice(Math.max(0, i - 1), i + 2); }
    return json({ Items: await serialize(env, s, rows, ctx), TotalRecordCount: startItem || adjacent ? rows.length : total, StartIndex: 0 });
  }

  // ---- Genres / studios / persons / years / filters ----
  if (lower === '/genres' || lower === '/studios' || lower === '/years') {
    const col = lower === '/genres' ? 'genres' : 'studios';
    const lib = p.get('ParentId') ? await libraryOfView(p.get('ParentId')) : null;
    const types = p.list('IncludeItemTypes').filter(t => TYPES.has(t));
    let q, b = [];
    const ac = ageClause(s, 'items');
    if (lower === '/years') {
      q = `SELECT year AS name, count(*) n FROM items WHERE year IS NOT NULL AND type IN ('Movie','Series') ${lib ? 'AND library = ?' : ''}${ac.sql} GROUP BY year ORDER BY year DESC`;
    } else {
      q = `SELECT j.value AS name, count(*) n FROM items, json_each(items.${col}) j WHERE items.type IN (${types.length ? types.map(() => '?') : "'Movie','Series'"}) ${lib ? 'AND items.library = ?' : ''}${ac.sql} GROUP BY j.value ORDER BY j.value`;
      b = types;
    }
    const rows = (await env.DB.prepare(q).bind(...b, ...(lib ? [lib] : []), ...ac.args).all()).results;
    const items = await Promise.all(rows.map(async r => ({ Name: String(r.name), Id: await hashId((lower === '/genres' ? 'genre:' : lower === '/studios' ? 'studio:' : 'year:') + r.name), ServerId: serverId(env), Type: lower === '/genres' ? 'Genre' : lower === '/studios' ? 'Studio' : 'Year', ImageTags: {}, BackdropImageTags: [], ChildCount: r.n, UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false } })));
    return json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
  }
  if (seg[0] === 'genres' && raw[1]) {
    const name = decodeURIComponent(raw[1]);
    return json({ Name: name, Id: await hashId('genre:' + name), ServerId: serverId(env), Type: 'Genre', ImageTags: {}, BackdropImageTags: [], UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0, PlayCount: 0 } });
  }
  if (lower === '/persons') {
    const term = p.get('SearchTerm');
    const rows = (await env.DB.prepare(`SELECT * FROM persons ${term ? 'WHERE name LIKE ?' : ''} ORDER BY name LIMIT ?`).bind(...(term ? [`%${term}%`] : []), p.int('Limit') ?? 100).all()).results;
    return json({ Items: rows.map(r => personDto(env, r)), TotalRecordCount: rows.length, StartIndex: 0 });
  }
  if (lower === '/items/filters') {
    const g = (await env.DB.prepare("SELECT DISTINCT j.value AS v FROM items, json_each(items.genres) j ORDER BY 1").all()).results.map(r => r.v);
    const y = (await env.DB.prepare("SELECT DISTINCT year AS v FROM items WHERE year IS NOT NULL AND type IN ('Movie','Series') ORDER BY 1 DESC").all()).results.map(r => r.v);
    const o = (await env.DB.prepare("SELECT DISTINCT official_rating AS v FROM items WHERE official_rating IS NOT NULL ORDER BY 1").all()).results.map(r => r.v);
    return json({ Genres: g, Tags: [], OfficialRatings: o, Years: y });
  }
  if (lower === '/items/filters2') {
    const g = (await env.DB.prepare("SELECT DISTINCT j.value AS v FROM items, json_each(items.genres) j ORDER BY 1").all()).results.map(r => r.v);
    return json({ Genres: await Promise.all(g.map(async n => ({ Name: n, Id: await hashId('genre:' + n) }))), Tags: [] });
  }
  if (lower === '/items/counts') {
    const ac = ageClause(s);
    const c = Object.fromEntries((await env.DB.prepare(`SELECT type, count(*) n FROM items i WHERE 1=1${ac.sql} GROUP BY type`).bind(...ac.args).all()).results.map(r => [r.type, r.n]));
    return json({ MovieCount: c.Movie || 0, SeriesCount: c.Series || 0, EpisodeCount: c.Episode || 0, ArtistCount: 0, ProgramCount: 0, TrailerCount: 0, SongCount: 0, AlbumCount: 0, MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: (c.Movie || 0) + (c.Episode || 0) });
  }
  if (lower === '/search/hints') {
    const term = p.get('searchTerm');
    if (!term) return json({ SearchHints: [], TotalRecordCount: 0 });
    const { rows, total } = await queryItems(env, s, p, { recursive: true, types: p.list('IncludeItemTypes').length ? p.list('IncludeItemTypes') : ['Movie', 'Series', 'Episode'], limit: p.int('Limit') ?? 30, sort: ['SortName'] });
    return json({ SearchHints: rows.map(r => { const img = parse(r.images) || {}; return { ItemId: r.id, Id: r.id, Name: r.name, ProductionYear: r.year || undefined, PrimaryImageTag: imageTag(img.Primary) || undefined, ThumbImageTag: imageTag(img.Thumb) || undefined, BackdropImageTag: imageTag(img.Backdrop) || undefined, Type: r.type, IsFolder: r.type === 'Series' || r.type === 'Season', RunTimeTicks: r.runtime_ticks || undefined, MediaType: r.type === 'Movie' || r.type === 'Episode' ? 'Video' : 'Unknown', Series: r.series_name || undefined, IndexNumber: r.index_number ?? undefined, ParentIndexNumber: r.parent_index ?? undefined }; }), TotalRecordCount: total });
  }

  // ---- Items ----
  if (lower === '/items' || (r0 === 'items' && rest.length === 1)) {
    if (p.get('ParentId') === await hashId('root') || (!p.get('ParentId') && !p.bool('Recursive') && !p.list('IncludeItemTypes').length && !p.get('Ids') && !p.get('SearchTerm'))) {
      const v = await views(env, s, ctx); return json({ Items: v, TotalRecordCount: v.length, StartIndex: 0 });
    }
    const { rows, total, start } = await queryItems(env, s, p);
    return json({ Items: await serialize(env, s, rows, ctx), TotalRecordCount: total, StartIndex: start });
  }
  if (lower === '/items/root' || (r0 === 'items' && r1 === 'root')) {
    const id = await hashId('root');
    return json({ Name: 'Media Folders', ServerId: serverId(env), Id: id, IsFolder: true, Type: 'UserRootFolder', ImageTags: {}, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id } });
  }
  // /Items/{id}/... and /Users/{u}/Items/{id}/...
  const isItemPath = (r0 === 'items' && r1) || (seg[0] === 'useritems' && seg[1]);
  if (isItemPath) {
    const id = seg[0] === 'useritems' ? raw[1] : restRaw[1];
    const sub = seg[0] === 'useritems' ? seg[2] : r2;
    if (sub === 'playbackinfo') {
      const row = await getItemRow(env, s, id);
      if (!row || !row.file_id) return notFound();
      const sources = mediaSources(row, ctxAll);
      const wanted = p.get('MediaSourceId');
      const pick = wanted ? sources.filter(x => x.Id === wanted) : sources;
      return json({ MediaSources: pick.length ? pick : sources, PlaySessionId: randomHex(16) });
    }
    if (sub === 'similar') {
      const row = await getItemRow(env, s, id);
      if (!row) return notFound();
      const gs = parse(row.genres) || [];
      const type = row.type === 'Episode' || row.type === 'Season' ? 'Series' : row.type;
      if (!gs.length) return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      const score = gs.map(() => '(i.genres LIKE ?)').join(' + ');
      const rows = (await env.DB.prepare(`SELECT i.*, p.position_ticks, p.played, p.play_count, p.last_played, f.item_id IS NOT NULL AS favorite FROM items i
          LEFT JOIN progress p ON p.user_id = ? AND p.item_id = i.id LEFT JOIN favorites f ON f.user_id = ? AND f.item_id = i.id
          WHERE i.type = ? AND i.id != ?${ageClause(s).sql} ORDER BY (${score}) DESC, i.rating DESC NULLS LAST LIMIT ?`)
        .bind(s.user_id, s.user_id, type, row.series_id || id, ...ageClause(s).args, ...gs.map(g => `%"${g}"%`), p.int('Limit') ?? 12).all()).results;
      return json({ Items: await serialize(env, s, rows, ctx), TotalRecordCount: rows.length, StartIndex: 0 });
    }
    if (sub === 'thememedia') return json({ ThemeVideosResult: { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: id }, ThemeSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: id }, SoundtrackSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: id } });
    if (sub === 'themesongs' || sub === 'themevideos') return json({ Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: id });
    if (sub === 'specialfeatures' || sub === 'localtrailers') return json([]);
    if (sub === 'intros') return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    if (sub === 'ancestors') {
      const row = await getItemRow(env, s, id);
      if (!row) return notFound();
      const ids = [row.season_id, row.series_id].filter(Boolean);
      const { rows } = ids.length ? await queryItems(env, s, params(new URL('http://x/')), { ids, recursive: true }) : { rows: [] };
      const vid = await viewId(row.library);
      const v = (await views(env, s, ctx)).filter(x => x.Id === vid);
      return json([...(await serialize(env, s, rows, ctx)), ...v]);
    }
    if (sub === 'criticreviews') return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    if (sub) return notFound();
    // Single item
    const row = await getItemRow(env, s, id);
    if (row) return json((await serialize(env, s, [row], ctxAll))[0]);
    const view = (await views(env, s, ctx)).find(v => v.Id === id);
    if (view) return json(view);
    const person = await env.DB.prepare('SELECT * FROM persons WHERE id = ?').bind(id).first();
    if (person) return json(personDto(env, person));
    return notFound();
  }

  return null;
}

function personDto(env, r) {
  return { Name: r.name, ServerId: serverId(env), Id: r.id, Type: 'Person', ImageTags: r.image ? { Primary: imageTag(r.image) } : {}, BackdropImageTags: [], PrimaryImageAspectRatio: r.image ? 2 / 3 : undefined, ProviderIds: { Tmdb: String(r.tmdb_id) }, UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: r.id } };
}

export { parseAuthHeader, params };
