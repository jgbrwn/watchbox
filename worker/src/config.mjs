// Deployment configuration: Worker vars (wrangler.jsonc), with defaults for a fresh install.
// configure(env) runs at the start of every request and cron run; everything else reads cfg().
//
// LIBRARY_ROOTS: the folders on the storage host, as listed by list.php. Each has an id (also part of every file's
// id, so never rename one), the library it feeds (movies | tv | youtube), and a priority: when a file exists in two
// roots (hard links, or a copy), the lower number wins. New downloads are copied into the first root of each library
// with priority 0. A fresh install has one root per library:
//   [{"id":"movies","library":"movies"},{"id":"tv","library":"tv"},{"id":"youtube","library":"youtube"}]
// Optional "label": how the Manage tab shows the folder (default: the id).

const LIBRARIES = ['movies', 'tv', 'youtube'];
export const DEFAULT_ROOTS = [{ id: 'movies', library: 'movies' }, { id: 'tv', library: 'tv' }, { id: 'youtube', library: 'youtube' }];

const safe = s => String(s || '').replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 40);

function build(env) {
  let roots = env.LIBRARY_ROOTS;
  if (typeof roots === 'string') roots = JSON.parse(roots);
  roots = (Array.isArray(roots) && roots.length ? roots : DEFAULT_ROOTS).map(r => ({
    id: String(r.id), library: String(r.library || r.kind), priority: Number(r.priority) || 0, label: r.label ? String(r.label) : String(r.id)
  }));
  for (const r of roots) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(r.id)) throw new Error(`LIBRARY_ROOTS: bad id ${r.id}`);
    if (!LIBRARIES.includes(r.library)) throw new Error(`LIBRARY_ROOTS: ${r.id} has unknown library ${r.library}`);
  }
  if (new Set(roots.map(r => r.id)).size !== roots.length) throw new Error('LIBRARY_ROOTS: duplicate id');
  const primary = {};
  for (const lib of LIBRARIES) primary[lib] = (roots.find(r => r.library === lib && r.priority === 0) || roots.find(r => r.library === lib))?.id || null;
  const num = (...v) => Number(v.find(x => x != null && x !== '') || 0);
  return {
    roots,
    libraryOf: Object.fromEntries(roots.map(r => [r.id, r.library])),   // root id -> library
    priority: Object.fromEntries(roots.map(r => [r.id, r.priority])),
    label: Object.fromEntries(roots.map(r => [r.id, r.label])),
    primary,                                                             // library -> root new files go to
    // Display names go into HTML and JS strings: letters, digits, spaces and . _ - ( ) only.
    siteName: safe(env.SERVER_NAME) || 'Watch',
    storageName: safe(env.STORAGE_NAME) || 'the storage host',          // what the UI calls the storage host
    boxName: safe(env.BOX_NAME) || 'the download box',
    publicUrl: String(env.ADMIN_ORIGIN || '').replace(/\/$/, ''),       // https://watch.example.com
    storageQuotaMb: num(env.STORAGE_QUOTA_MB, env.HOSTBRR_QUOTA_MB),       // 0 = unknown (no space bar)
    storageOtherMb: num(env.STORAGE_OTHER_MB, env.HOSTBRR_OTHER_MB),       // non-library usage, for the estimate
    boxMediaPath: String(env.BOX_MEDIA_PATH || '/home/freebsd/media/').replace(/\/?$/, '/')   // qBittorrent's finished folder
  };
}

let current = null, currentKey = null;
export function configure(env) {
  const key = JSON.stringify([env.LIBRARY_ROOTS, env.ADMIN_ORIGIN, env.SERVER_NAME, env.STORAGE_NAME, env.BOX_NAME, env.STORAGE_QUOTA_MB, env.HOSTBRR_QUOTA_MB, env.STORAGE_OTHER_MB, env.HOSTBRR_OTHER_MB, env.BOX_MEDIA_PATH]);
  if (key !== currentKey) { current = build(env); currentKey = key; }
  return current;
}
export const cfg = () => current || configure({});
