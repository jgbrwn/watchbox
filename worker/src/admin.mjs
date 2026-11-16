// Owner admin page (behind Cloudflare Access): library overview and match fixes, the download
// pipeline, and the FreeBSD-box tools (c-cli, qBittorrent, rsync-web) embedded as tabs.
import { cfg } from './config.mjs';
import { handleYoutubeAdmin } from './youtube.mjs';
import { verifyAccessJwt } from './access.mjs';
import { runSync } from './cron.mjs';
import { tools, launchUrl } from './tools.mjs';
import { handlePipeline, storage } from './pipeline.mjs';
import { handleManage } from './manage.mjs';
import { handleUsers, sendEmail } from './users.mjs';
import { handlePlayer, watchHtml, WATCH_CSS, WATCH_JS } from './player.mjs';
import { page as shell } from './portal.mjs';
import { authorize as qcAuthorize } from './quickconnect.mjs';
import { createShare, listShares, revokeShare, shareSettings, setShareSettings, OWNER_DAYS } from './shares.mjs';
import { applyAges, ageOf, ageKey, AGE_KEY_SQL } from './ages.mjs';
import { requestsForOwner, decide, refreshRequests } from './requests.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A readable title and a TMDB search query from an unmatched file's path.
export function guessTitle(path) {
  const parts = String(path).split('/').slice(1);
  const pick = parts.length > 1 ? parts[0] : parts[0].replace(/\.[a-z0-9]{2,4}$/i, '');
  return pick.replace(/[._]+/g, ' ').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .split(/\bS\d{1,2}(?:E\d+)?\b|\bSeason\s*\d|\b(?:19|20)\d{2}\b.*$|\b(?:1080p|720p|2160p|480p|WEB|BluRay|DVDRip|HDTV)\b/i)[0]
    .replace(/[()\-–\s]+$/, '').replace(/\s+/g, ' ').trim() || pick;
}

// Plain-language reading of the matcher's notes (library/match.mjs, sync.mjs).
export function explainNote(note) {
  const n = String(note || '');
  if (/number collision/.test(n)) return { episode: true, text: 'The show is matched, but these files claim episode numbers that other files already use (duplicates or mislabeled files).' };
  if (/number-unknown/.test(n)) return { episode: true, text: 'The show is matched, but TMDB doesn’t list these episode numbers (often specials, or a different season numbering).' };
  if (/^no results/.test(n)) return { episode: false, text: 'TMDB has nothing under this name.' };
  const best = /best "(.*)"(?: \((\d{4})?\))?/.exec(n);
  if (best) return { episode: false, text: `Closest TMDB result was “${best[1]}”${best[2] ? ` (${best[2]})` : ''}, not close enough to pick automatically.` };
  return { episode: false, text: '' };
}

const TAB_ICONS = {
  library: '<path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"/>',
  pipeline: '<path d="M5 6h10M5 6l3-3M5 6l3 3M19 18H9m10 0-3-3m3 3-3 3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/>',
  manage: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  cc: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  dl: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  rs: '<path d="M7 4v12m0 0-3-3m3 3 3-3M17 20V8m0 0-3 3m3-3 3 3"/>'
};
const tabIcon = id => `<svg class=ti viewBox="0 0 24 24" aria-hidden="true">${TAB_ICONS[id] || TAB_ICONS.library}</svg>`;

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><rect x="2" y="4" width="20" height="16" rx="4" fill="var(--accent)"/><path d="M10 8.5v7l6-3.5z" fill="var(--accent-ink)"/></svg>`;

export async function handleAdmin(request, env, ctx) {
  let who;
  try { who = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env); }
  catch { return new Response('Forbidden', { status: 403 }); }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const origin = request.headers.get('Origin');
  if (request.method !== 'GET' && request.method !== 'HEAD' && origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });

  if (/^\/admin\/(watch|play|assets|api\/library)(\/|$)/.test(path)) {
    // The owner watches as the Jellyfin user that has their email (Users → Edit), so progress follows them to the TV.
    const me = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0').bind(who.email).first();
    const linkUsers = me ? null : (await env.DB.prepare("SELECT id, COALESCE(display_name, username) AS name FROM users WHERE email IS NULL AND disabled = 0 AND password_hash != '!' ORDER BY username = 'tv' DESC, created_at").all()).results;
    const r = await handlePlayer(request, env, ctx, { base: '/admin', userId: me?.id || null, page: d => {
      const w = watchHtml(d, { base: '/admin', back: '/admin#library', linked: !!me, canShare: true, shareDays: OWNER_DAYS, linkUsers });
      const res = shell(env, w.title, w.body, WATCH_JS, false, WATCH_CSS);
      res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
      return res;
    } });
    if (r) return r;
  }
  if (path === '/admin/api/link-me' && request.method === 'POST') {
    // "Save my progress as …": give that Jellyfin user the owner's Access email (only if it has none).
    const b = await request.json().catch(() => ({}));
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').bind(who.email).first()) return Response.json({ error: 'A user already has your email.' }, { status: 409 });
    const r = await env.DB.prepare('UPDATE users SET email = ? WHERE id = ? AND email IS NULL').bind(who.email, String(b.user || '')).run();
    return Response.json(r.meta.changes ? { ok: true } : { error: 'That user already has an email.' }, { status: r.meta.changes ? 200 : 409 });
  }
  if (path === '/admin/api/shares' && request.method === 'GET') return Response.json({ shares: await listShares(env), settings: await shareSettings(env.DB) });
  if (path === '/admin/api/shares' && request.method === 'POST') { const x = await createShare(env, url.origin, null, await request.json().catch(() => ({}))); return Response.json(x.body, { status: x.status }); }
  if (path === '/admin/api/shares/revoke' && request.method === 'POST') return Response.json(await revokeShare(env, (await request.json().catch(() => ({}))).id));
  if (path === '/admin/api/shares/settings' && request.method === 'POST') return Response.json(await setShareSettings(env.DB, await request.json().catch(() => ({}))));
  if (path === '/admin/api/ages' && request.method === 'GET') {
    // Titles without a usable rating (hidden from age-limited users) and titles the owner has rated by hand.
    const q = (await env.DB.prepare(`SELECT i.id, i.type, i.name, i.year, i.official_rating, i.age, i.provider_ids, o.key AS okey, o.age AS oage
      FROM items i LEFT JOIN age_overrides o ON o.key = ${AGE_KEY_SQL('i')}
      WHERE i.type IN ('Movie','Series') AND (i.age IS NULL OR o.key IS NOT NULL) ORDER BY o.key IS NULL, i.sort_name`).all()).results;
    return Response.json({ titles: q.map(r => ({ id: r.id, type: r.type, name: r.name, year: r.year, cert: r.official_rating, age: r.age, overridden: !!r.okey })) });
  }
  if (path === '/admin/api/ages' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const it = await env.DB.prepare("SELECT id, type, provider_ids, official_rating FROM items WHERE id = ? AND type IN ('Movie','Series')").bind(String(b.id || '')).first();
    if (!it) return Response.json({ error: 'No such title' }, { status: 404 });
    const key = ageKey(it);
    if (b.age === 'auto') await env.DB.prepare('DELETE FROM age_overrides WHERE key = ?').bind(key).run();
    else {
      const age = b.age === null || b.age === '' ? null : Number(b.age);
      if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 18)) return Response.json({ error: 'Age 0–18' }, { status: 400 });
      await env.DB.prepare('INSERT OR REPLACE INTO age_overrides(key, age, at) VALUES (?,?,unixepoch())').bind(key, age).run();
    }
    await applyAges(env.DB);
    return Response.json({ ok: true, auto: ageOf(it.official_rating) });
  }
  if (path === '/admin/api/quickconnect' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const r = await qcAuthorize(env, b.code, String(b.user || ''));
    return Response.json(r, { status: r.error ? 400 : 200 });
  }
  if (path === '/admin/api/test-email' && request.method === 'POST') {
    const r = await sendEmail(env, { to: who.email, subject: cfg().siteName + ': test email', text: 'Email sending from ' + cfg().publicUrl + ' works. Invites and "ready to watch" notices will arrive like this.\n', html: '<p>Email sending from <b>' + esc(cfg().publicUrl) + '</b> works. Invites and “ready to watch” notices will arrive like this.</p>' });
    return Response.json(r, { status: r.ok ? 200 : 502 });
  }
  if (path.startsWith('/admin/api/manage/')) return handleManage(request, env, ctx, path);
  if (path === '/admin/api/users' || path.startsWith('/admin/api/users/')) return handleUsers(request, env, path);
  if (path === '/admin/api/requests' && request.method === 'GET') { await refreshRequests(env).catch(() => {}); return Response.json({ requests: await requestsForOwner(env) }, { headers: { 'Cache-Control': 'no-store' } }); }
  if (path === '/admin/api/requests/decide' && request.method === 'POST') { const r = await decide(env, await request.json().catch(() => ({}))); return Response.json(r.body, { status: r.status }); }
  if (path === '/admin/api/youtube' || path.startsWith('/admin/api/youtube/')) return handleYoutubeAdmin(request, env, ctx, path);
  if (path.startsWith('/admin/api/')) return handlePipeline(request, env, ctx, path);

  if (path === '/admin/tools/launch') {
    const tool = tools(env).find(t => t.id === url.searchParams.get('tool'));
    if (!tool) return new Response('Unknown tool', { status: 404 });
    return new Response(null, { status: 302, headers: { Location: await launchUrl(env, tool, url.searchParams.get('next') || '/'), 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    if (path === '/admin/sync') {
      ctx.waitUntil(runSync(env, { force: true }));
    } else if (path === '/admin/override') {
      const key = String(form.get('key') || '').trim();
      const raw = String(form.get('tmdb') || '').trim();
      if (/^(movie|tv):[a-z0-9]*:\d{0,4}$/.test(key)) {
        const cur = JSON.parse((await env.DB.prepare("SELECT value FROM kv WHERE key='overrides'").first())?.value || '{}');
        const m = /(\d+)\s*$/.exec(raw.replace(/\/$/, '').replace(/-.*$/, ''));   // accepts an id or a TMDB URL
        cur[key] = raw === '' || raw === 'none' ? null : Number(m?.[1] || raw.replace(/\D/g, ''));
        await env.DB.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES ('overrides', ?)").bind(JSON.stringify(cur)).run();
        ctx.waitUntil(runSync(env, { force: true }));
      }
    }
    return Response.redirect(url.origin + '/admin?done=' + (path === '/admin/sync' ? 'sync' : 'fix') + '#library', 303);
  }

  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
  const count = Object.fromEntries((await q("SELECT type, count(*) n FROM items GROUP BY type")).map(r => [r.type, r.n]));
  const art = (await q("SELECT sum(images LIKE '%\"Primary\":\"%') p, count(*) n FROM items WHERE type IN ('Movie','Series')"))[0];
  const last = JSON.parse((await env.DB.prepare("SELECT value FROM kv WHERE key='last_sync'").first())?.value || '{}');
  const unmatched = await q("SELECT match_key, match_note, min(root||'/'||path) path, count(*) n FROM files WHERE match_status='unmatched' AND missing_since IS NULL GROUP BY match_key ORDER BY match_key");
  const recent = await q(`SELECT id, 'Movie' type, name, year, date_created, NULL n FROM items WHERE type='Movie'
    UNION ALL SELECT series_id, 'Series', series_name, NULL, max(date_created), count(*) FROM items WHERE type='Episode' AND series_id IS NOT NULL GROUP BY series_id
    ORDER BY date_created DESC LIMIT 16`);
  const logs = await q("SELECT at, step, detail FROM sync_log ORDER BY id DESC LIMIT 12");
  const missing = await q("SELECT root||'/'||path p, missing_since FROM files WHERE missing_since IS NOT NULL AND deleted_at IS NULL ORDER BY missing_since DESC LIMIT 20");
  const day = s => s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  const stamp = s => s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const toolTabs = tools(env);
  const space = await storage(env).catch(() => ({}));
  const gb = n => n >= 2 ** 40 ? (n / 2 ** 40).toFixed(2) + ' TB' : Math.round(n / 2 ** 30) + ' GB';   // binary units, like hosting panels and df
  const meter = (label, d, note) => d ? `<div class="disk ${d.level}"><div class=disk-top><b>${label}</b><span>${gb(d.total - d.used)} free of ${gb(d.total)}</span></div>
  <i class=meter2><i style="width:${Math.min(100, d.used / d.total * 100).toFixed(1)}%"></i></i><small>${Math.round(d.used / d.total * 100)}% used${note ? ' · ' + note : ''}</small></div>`
    : `<div class=disk><div class=disk-top><b>${label}</b><span class=muted>unavailable</span></div></div>`;
  const lowDisk = [space.store?.level !== 'ok' && space.store && cfg().storageName, space.box?.level !== 'ok' && space.box && 'the download box'].filter(Boolean);
  const artPct = art.n ? Math.round(art.p / art.n * 100) : 0;
  for (const u of unmatched) Object.assign(u, explainNote(u.match_note), { title: guessTitle(u.path) });
  const titles = unmatched.filter(u => !u.episode), episodes = unmatched.filter(u => u.episode);
  const fixCard = u => {
    const tv = u.match_key.startsWith('tv:');
    return `<article class=fix>
  <div class=fix-main><div class=fix-title>${esc(u.title)} <span class=tag>${tv ? 'TV' : 'Movie'}</span>${u.n > 1 ? ` <span class=tag>${u.n} files</span>` : ''}</div>
  <div class=fix-path title="${esc(u.path)}">${esc(u.path)}</div>${u.text ? `<div class=fix-note title="${esc(u.match_note)}">${esc(u.text)}</div>` : ''}</div>
  <form method=post action=/admin/override class=fix-form><input type=hidden name=key value="${esc(u.match_key)}">
  <a class=btn-ghost target=_blank rel=noopener href="https://www.themoviedb.org/search/${tv ? 'tv' : 'movie'}?query=${encodeURIComponent(u.title)}">Search TMDB ↗</a>
  <input name=tmdb required inputmode=url placeholder="${u.episode ? 'Different show? TMDB link' : 'TMDB link or id'}" aria-label="TMDB link or id for ${esc(u.title)}"><button${u.episode ? ' class=quiet' : ''}>Fix</button></form></article>`;
  };
  const done = url.searchParams.get('done');

  const stat = (n, label, extra = '') => `<div class=stat${extra}><b>${esc(n)}</b><span>${label}</span></div>`;
  const library = `
<div class=wsearch><input type=search id=wq placeholder="Watch something: search movies and shows…" autocomplete=off aria-label="Search the library to watch"></div>
<div id=wres class=wgrid></div>
${done ? `<div class=toast role=status>${done === 'sync' ? 'Sync started. New and changed files appear within a minute.' : 'Saved. Re-matching now; it shows up in your apps within a minute.'}</div>` : ''}
<section class=stats>
  ${stat((count.Movie || 0).toLocaleString(), 'Movies')}
  ${stat((count.Series || 0).toLocaleString(), 'Shows')}
  ${stat((count.Episode || 0).toLocaleString(), 'Episodes')}
  <div class=stat><b>${artPct}%</b><span>Artwork</span><i class=meter><i style="width:${artPct}%"></i></i></div>
  <a class="stat${titles.length ? ' warn' : ''}" href="#fix"><b>${titles.length}</b><span>Need a match</span></a>
</section>

<h2>Storage</h2>
<div class=disks>${meter(cfg().storageName, space.store, space.store?.estimated ? 'estimated from library size' : 'from the hosting panel')}${meter('Download box', space.box, 'downloads wait here until sent')}</div>

<h2>Recently added</h2>
<div class=rail>${recent.map(r => `<a class=pl href="/admin/watch/${esc(r.id)}"><figure class=poster title="${esc(r.name)}">
  <div class=art><img loading=lazy alt="" src="/Items/${esc(r.id)}/Images/Primary?maxWidth=240" onerror="this.remove()"><span>${esc(r.name)}</span>${r.type === 'Series' ? `<em>${r.n} ep</em>` : ''}</div>
  <figcaption>${esc(r.name)}<small>${r.type === 'Series' ? 'Show' : esc(r.year || 'Movie')} · ${day(r.date_created)}</small></figcaption></figure></a>`).join('')}</div>

<h2 id=fix>Need a match <span class=count>${titles.length}</span></h2>
${titles.length ? `<p class=hint>These already play, under names taken from the filenames. Find the title on TMDB and paste its link or id to get artwork and details.</p>
<div class=fixes>${titles.map(fixCard).join('')}</div>` : '<p class=hint>Every title is matched on TMDB.</p>'}

${episodes.length ? `<details><summary>Episodes TMDB can’t place <span class=count>${episodes.reduce((a, u) => a + u.n, 0)}</span></summary>
<p class=hint>These play under the right show, named from the filename, but without TMDB episode details. Usually nothing to fix. Only use Fix if it’s actually the wrong show.</p>
<div class=fixes>${episodes.map(fixCard).join('')}</div></details>` : ''}

<details><summary>Override any match</summary>
<p class=hint>Keys look like <code>movie:title:year</code> or <code>tv:title:</code> (lowercase, letters and digits only). An empty id removes an override.</p>
<form method=post action=/admin/override class=row><input name=key size=30 placeholder="movie:notorious:1946" required> <input name=tmdb size=18 placeholder="TMDB link or id"> <button>Save</button></form></details>

<details${missing.length ? '' : ' disabled'}><summary>Missing from ${cfg().storageName} <span class=count>${missing.length}</span></summary>
<p class=hint>Files that were in the library but aren't on the storage box any more. They're hidden from your apps; watch history is kept if they come back.</p>
<ul class=plain>${missing.map(r => `<li><code>${esc(r.p)}</code> <span class=muted>since ${day(r.missing_since)}</span></li>`).join('') || '<li class=muted>None</li>'}</ul></details>

<details><summary>Sync history</summary>
<p class=hint>Last run ${stamp(last.at)}${last.ms ? ` · ${(last.ms / 1000).toFixed(1)} s` : ''}. Only runs that changed something are listed.</p>
<ul class=plain>${logs.map(l => { let d = l.detail; try { const j = JSON.parse(l.detail); d = [j.scan?.added && `${j.scan.added} added`, j.scan?.missing && `${j.scan.missing} missing`, j.scan?.restored && `${j.scan.restored} restored`, j.match && (j.match.movies + j.match.episodes) && `${j.match.movies + j.match.episodes} matched`, j.match?.unmatched && `${j.match.unmatched} unmatched`, j.probe?.ok && `${j.probe.ok} probed`, j.items?.written && `${j.items.written} items updated`, j.error].filter(Boolean).join(' · ') || 'no changes'; } catch {}
  return `<li><span class=muted>${stamp(l.at)}</span> ${l.step === 'sync-error' ? '<b class=bad>error</b> ' : ''}${esc(d)}</li>`; }).join('')}</ul></details>

<p class=foot>Metadata and images from <a href="https://www.themoviedb.org">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>`;

  const manage = `
<div class=msearch><input type=search id=mq placeholder="Find a title or file name…" autocomplete=off aria-label="Find a title or file name"></div>
<div id=mmsg></div>
<div id=mres></div>
<h2>Worth a look</h2>
<p class=hint>Things that usually just take up space. Nothing here is deleted until you review it.</p>
<div id=msug><p class=hint>Loading…</p></div>
<h2 id=trash>Trash <span class=count id=trash-n></span></h2>
<p class=hint>Deleted files wait here for <span id=trash-days>14</span> days and then are removed for good. <b>Restore</b> puts them back where they were, watch history included. Space on ${cfg().storageName} is only freed when the trash is emptied.</p>
<div id=mtrash class=cards><p class=hint>Loading…</p></div>
<div class=selbar id=selbar hidden><span id=selinfo></span><button class=quiet id=selclear type=button>Clear</button><button id=seldel type=button>Review<span class=long> &amp; delete</span>…</button></div>
<dialog id=mdlg aria-labelledby=mdlg-h><form method=dialog>
  <h3 id=mdlg-h>Move to trash?</h3><div id=mdlg-body></div>
  <div class=row style="justify-content:flex-end;margin-top:16px"><button class=quiet value=cancel>Cancel</button><button id=mdlg-go value=go>Move to trash</button></div>
</form></dialog>`;

  const usersHtml = `
<h2 style="margin-top:0">People <span class=count id=u-n></span></h2>
<p class=hint>Everyone with a Jellyfin login. Each person has their own watch history, favorites and devices; nobody sees anyone else’s. People with an email can also use the <a href="/me" target=_blank rel=noopener>guest page</a> to accept their invite, see setup steps for their TV, and ask for titles.</p>
<div id=umsg></div>
<div id=ulist class=cards><p class=hint>Loading…</p></div>
<h2>Invite someone</h2>
<form id=uadd class="card ugrid">
  <label>Name <input name=display_name placeholder="Sam" autocomplete=off></label>
  <label>Username <input name=username required placeholder="sam" autocomplete=off pattern="[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}"></label>
  <label class=span2>Email <small class=muted>for the invite and their guest page; leave empty to just make a login and hand them the password</small><input name=email type=email placeholder="sam@example.com" autocomplete=off></label>
  <label class=chk><input type=checkbox name=send_email checked> Email the invite <small class=muted id=email-state></small></label>
  <label class=chk><input type=checkbox name=auto_approve> Auto-approve their movie requests</label>
  <label>Age limit <select name=max_age id=uage></select></label>
  <label class=chk><input type=checkbox name=allow_unrated> Also show titles with no rating <small class=muted>(off is safer)</small></label>
  <div class=span2><button>Create</button></div>
</form>
<h2>Age ratings <span class=count id=age-n></span></h2>
<p class=hint>Users with an age limit only see titles rated at or below it, everywhere: their TV apps, search, Continue Watching, their guest page and the browser player. Ratings come from TMDB (US first, then other countries). Titles with no rating are hidden from them unless their account allows unrated titles; give those an age here (it also overrides a rating you disagree with).</p>
<div class="card" style="padding:0"><div class=agebar><input type=search id=ageq placeholder="Find any title to set its age…" autocomplete=off></div><div id=agelist class=agelist></div></div>
<h2>Shared links <span class=count id=sh-n></span></h2>
<p class=hint>Public links that play one movie or episode in any browser, no sign-in. Made with <b>Share link</b> on a watch page. Anyone who has a link can watch until it expires or you turn it off, so only share with people you trust not to pass it on.</p>
<label class=switch style="margin-bottom:10px"><input type=checkbox id=sh-guests><span class=knob aria-hidden=true></span><span><b>Guests can create share links</b><small>Up to 30 days each. Age-limited users never can.</small></span></label>
<div id=shlist class=card style="padding:0"></div>
<h2>Quick Connect</h2>
<form id=qcf class="card row"><span>A TV shows a 6-digit code on its sign-in screen (official Jellyfin apps, Swiftfin, Findroid; not VidHub or Infuse). Sign it in as</span>
<select id=qcu aria-label="User"></select><input id=qc inputmode=numeric maxlength=7 placeholder="123456" aria-label="Code" style="width:8em"><button>Sign in</button><span id=qcmsg></span></form>
<h2>Email</h2>
<div class="card row"><span id=email-line class=muted>Invites and “ready to watch” notices are sent from the Worker.</span><button type=button class=quiet id=testmail>Send me a test email</button><span id=tmmsg></span></div>
<h2>Signed-in devices <span class=count id=d-n></span></h2>
<p class=hint>Every app signed in to the server, newest activity first. Location is where the device last connected from (approximate).</p>
<div id=dlist class=card style="padding:0"></div>`;

  const pipeline = `
<section id=requests-wrap hidden style="margin-bottom:28px"><h2 id=requests style="margin-top:0">Requests <span class=count id=req-n></span></h2>
<p class=hint>Titles people asked for on their <a href="/me" target=_blank rel=noopener>guest page</a>. <b>Download</b> picks the best 1080p YTS release with seeders and sends it to the box; the pipeline does the rest and they’re told when it’s ready. Shows are found by hand on the Find tab: mark them <b>Approved</b> so people know.</p>
<div id=reqs class=cards></div></section>
<ol class=flow>
  <li><a href="#cc"><b>1</b><span>Find</span><small>Search and send a .torrent to the box</small></a></li>
  <li><a href="#dl"><b>2</b><span>Download</span><small id=f-dl>qBittorrent</small></a></li>
  <li><a href="#ready"><b>3</b><span>Send to library</span><small id=f-ready>Copy to ${cfg().storageName}</small></a></li>
  <li><a href="#library"><b>4</b><span>Watch</span><small id=f-sync>Library syncs on arrival</small></a></li>
</ol>
<div id=perr></div>
<section class=settings aria-label="Pipeline settings">
  <label class=switch><input type=checkbox id=s-auto disabled><span class=knob aria-hidden=true></span><span><b>Send finished downloads automatically</b><small>As soon as qBittorrent finishes. Movie or TV is guessed from the name.</small></span></label>
  <label class=switch><input type=checkbox id=s-cleanup disabled><span class=knob aria-hidden=true></span><span><b>Then remove them from the download box</b><small>Only after every video file is confirmed on ${cfg().storageName} at the same size, and after seeding. Deletes the torrent and its files on the box, never anything on ${cfg().storageName}.</small>
  <span class=seed>Keep seeding until ratio <input id=s-seed_ratio type=number min=0 max=20 step=0.1 inputmode=decimal aria-label="Seed ratio"> or <input id=s-seed_hours type=number min=0 max=1440 step=1 inputmode=numeric aria-label="Seed hours"> hours, whichever comes first.</span></span></label>
</section>
<h2 id=ready>On the download box <span class=count id=pready-n></span></h2>
<p class=hint>Finished downloads waiting in <code>~/media</code>. <b>Send</b> copies one to ${cfg().storageName} (movies → <code>${esc(cfg().label[cfg().primary.movies] || '')}</code>, TV → <code>${esc(cfg().label[cfg().primary.tv] || '')}</code>) and the library updates by itself.</p>
<div id=pready class=cards><p class=hint>Loading…</p></div>
<h2>Downloading</h2><div id=ptorrents class=cards></div>
<h2>Recent copies</h2><div id=pjobs class=cards></div>
<h2 id=youtube>YouTube <span class=count id=yt-n></span></h2>
<p class=hint>Paste a video or playlist link. The download box fetches it (H.264 up to the quality you pick; 4K is VP9), copies it with its thumbnail, description and English subtitles to <code>media/youtube/&lt;channel&gt;/</code>, and it appears in a <b>YouTube</b> library. Remove one later from the Manage tab.</p>
<form id=ytf class="card row"><input id=yturl type=url required placeholder="https://www.youtube.com/watch?v=…" aria-label="YouTube link" style="flex:1;min-width:220px">
<select id=ytq aria-label=Quality><option value=1080 selected>1080p</option><option value=720>720p</option><option value=2160>4K (VP9)</option></select><button>Add</button></form>
<div id=ytmsg></div><div id=ytpl></div><div id=ytbox class=hint></div><div id=ytjobs class=cards></div>`;

  const html = `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name=color-scheme content="dark light"><title>Watch · Admin</title>
<script>try{const t=localStorage.getItem('watch-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch{}</script>
<link rel=icon href="data:image/svg+xml,${encodeURIComponent(ICON.replace(/var\(--accent\)/g, '#f2b43c').replace(/var\(--accent-ink\)/g, '#1a1408').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}">
<style>
:root{--bg:#0e0f12;--surface:#16181d;--surface-2:#1d2027;--line:#2a2e37;--text:#ece9e4;--muted:#9a968e;--accent:#f2b43c;--accent-ink:#1a1408;--good:#6fcf8e;--bad:#f2767a;--warn:#f2b43c;--radius:12px;color-scheme:dark}
@media (prefers-color-scheme:light){:root:not([data-theme]){--bg:#f5f3ef;--surface:#fff;--surface-2:#efece6;--line:#e2ded6;--text:#1c1b19;--muted:#6d6a63;--accent:#b7790f;--accent-ink:#fff;--good:#1f8a4c;--bad:#c2383e;--warn:#a86a00;color-scheme:light}}
:root[data-theme=light]{--bg:#f5f3ef;--surface:#fff;--surface-2:#efece6;--line:#e2ded6;--text:#1c1b19;--muted:#6d6a63;--accent:#b7790f;--accent-ink:#fff;--good:#1f8a4c;--bad:#c2383e;--warn:#a86a00;color-scheme:light}
.theme{width:34px;height:34px;padding:0;display:grid;place-items:center}.theme svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:5px;word-break:break-all}
header{flex:none;display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}.brand small{color:var(--muted);font-weight:500}
nav{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}nav::-webkit-scrollbar{display:none}
.tab{border:0;background:none;color:var(--muted);padding:7px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;font:inherit;font-weight:550}
.tab:hover{color:var(--text);background:var(--surface-2)}.tab[aria-selected=true]{color:var(--text);background:var(--surface-2);box-shadow:inset 0 -2px 0 var(--accent)}
.tab small{color:var(--muted);font:500 11px ui-monospace,monospace;margin-left:4px;opacity:.8}
.side{display:flex;align-items:center;gap:10px;white-space:nowrap}.pill{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 20%,transparent)}.dot.bad{background:var(--bad)}
.ext{font-size:13px}
button,.btn-ghost{font:inherit;font-weight:600;border-radius:8px;padding:7px 14px;cursor:pointer;border:1px solid transparent;background:var(--accent);color:var(--accent-ink);white-space:nowrap;display:inline-block}
button.quiet,.btn-ghost{background:transparent;color:var(--text);border-color:var(--line)}button.quiet:hover,.btn-ghost:hover{border-color:var(--muted);text-decoration:none}
button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input,select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-width:0}
main{flex:1;min-height:0;position:relative}.pane:focus,.pane:focus-visible{outline:none}.pane{display:none;height:100%}.pane.on{display:block}
.doc{overflow:auto}.wrap{max-width:1080px;margin:0 auto;padding:24px 20px 48px}
iframe{border:0;width:100%;height:100%;display:block;background:var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='20'%3E%3Ctext x='0' y='15' fill='%239a968e' font-family='sans-serif' font-size='13'%3ELoading%E2%80%A6%3C/text%3E%3C/svg%3E") center 40% no-repeat}
h2{font-size:15px;font-weight:650;margin:32px 0 12px;display:flex;align-items:center;gap:8px;letter-spacing:-.005em}
.count:empty{display:none}.count{font:600 12px ui-monospace,monospace;color:var(--muted);background:var(--surface-2);border-radius:99px;padding:1px 8px}
.hint{color:var(--muted);margin:0 0 12px;max-width:70ch}.muted{color:var(--muted)}.bad{color:var(--bad)}.good{color:var(--good)}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;color:var(--text);display:block;position:relative}
.stat b{display:block;font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}.stat span{color:var(--muted);font-size:13px}
a.stat:hover{text-decoration:none;border-color:var(--muted)}.stat.warn b{color:var(--warn)}
.meter{position:absolute;left:16px;right:16px;bottom:10px;height:3px;border-radius:2px;background:var(--line);overflow:hidden}.meter i{display:block;height:100%;background:var(--good)}
.rail{display:grid;grid-auto-flow:column;grid-auto-columns:128px;gap:14px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x proximity}
.poster{margin:0;scroll-snap-align:start}.art{position:relative;aspect-ratio:2/3;border-radius:10px;overflow:hidden;background:linear-gradient(160deg,var(--surface-2),var(--surface));border:1px solid var(--line);display:flex;align-items:flex-end;padding:8px}
.art span{font-size:12px;color:var(--muted)}.art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.art em{position:absolute;top:6px;right:6px;font:600 11px ui-sans-serif,system-ui;font-style:normal;background:rgb(0 0 0 / .7);color:#fff;border-radius:6px;padding:1px 6px}
figcaption{font-size:13px;font-weight:550;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}figcaption small{display:block;color:var(--muted);font-weight:400;font-size:12px}
.fixes,.cards{display:grid;gap:10px}
.fix,.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.fix{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 20px;align-items:center}
.fix-title,.card .name{font-weight:600;word-break:break-word}.tag{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:4px;vertical-align:1px}
.fix-path{font:12px ui-monospace,monospace;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.fix-note{font-size:12px;color:var(--muted);margin-top:2px}
.fix-form{display:flex;gap:8px;align-items:center}.fix-form input{width:170px}
details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;font-weight:600;display:flex;align-items:center;gap:8px;list-style:none}
summary::before{content:"›";display:inline-block;width:12px;color:var(--muted);transition:transform .15s}details[open] summary::before{transform:rotate(90deg)}summary::-webkit-details-marker{display:none}
details>:not(summary){margin-top:10px}ul.plain{list-style:none;padding:0;margin:0;display:grid;gap:6px;font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap}.foot{margin-top:40px;color:var(--muted);font-size:12px}
.toast{background:color-mix(in srgb,var(--good) 14%,var(--surface));border:1px solid color-mix(in srgb,var(--good) 40%,var(--line));border-radius:10px;padding:10px 14px;margin-bottom:16px}
.flow{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;counter-reset:s}
.flow a{display:grid;grid-template-columns:auto 1fr;column-gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;color:var(--text);height:100%}
.flow a:hover{text-decoration:none;border-color:var(--muted)}.flow b{grid-row:span 2;width:26px;height:26px;border-radius:50%;background:var(--surface-2);display:grid;place-items:center;font-size:13px;color:var(--accent)}
.flow span{font-weight:600}.flow small{color:var(--muted);font-size:12px}
.card .meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:4px 0 10px}.card .meta:last-child{margin-bottom:0}
.prog{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin:10px 0 6px}.prog i{display:block;height:100%;background:var(--accent);transition:width .6s}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;margin:10px 0 0;max-height:10em;overflow:auto}
.mnote{display:none}
.disks{display:grid;grid-template-columns:1fr 1fr;gap:12px}.disk{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px}
.disk-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.disk-top span{color:var(--muted);font-size:13px}.disk small{color:var(--muted);font-size:12px}
.meter2{display:block;height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:8px 0 4px}.meter2 i{display:block;height:100%;background:var(--good)}
.disk.warn .meter2 i{background:var(--warn)}.disk.bad .meter2 i{background:var(--bad)}.disk.warn b::after,.disk.bad b::after{content:" · low";color:var(--warn);font-weight:600}.disk.bad b::after{color:var(--bad)}
.alert{flex:none;background:color-mix(in srgb,var(--bad) 16%,var(--surface));border-bottom:1px solid color-mix(in srgb,var(--bad) 40%,var(--line));padding:8px 16px;font-size:13px}
.seed{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:13px;color:var(--muted)}.seed input{width:72px;padding:4px 8px}
.settings{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.switch{display:flex;gap:12px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;cursor:pointer}
.switch>input{position:absolute;opacity:0;pointer-events:none}.switch b{display:block;font-weight:600}.switch small{color:var(--muted);font-size:12px;display:block;margin-top:2px}
.knob{flex:none;width:36px;height:20px;border-radius:99px;background:var(--line);position:relative;margin-top:2px;transition:background .15s}
.knob::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--text);transition:transform .15s}
.switch input:checked+.knob{background:var(--accent)}.switch input:checked+.knob::after{transform:translateX(16px);background:var(--accent-ink)}
.switch input:focus-visible+.knob{outline:2px solid var(--accent);outline-offset:2px}.switch input:disabled+.knob{opacity:.5}
.ti{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:none}
.note{border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));background:color-mix(in srgb,var(--warn) 8%,var(--surface));border-radius:10px;padding:10px 14px;margin:14px 0}
.status{font-size:12px;font-weight:600;border-radius:99px;padding:1px 8px;background:var(--surface-2)}.status.completed{color:var(--good)}.status.failed,.status.cancelled{color:var(--bad)}.status.running{color:var(--accent)}
.msearch input{width:100%;font-size:16px;padding:10px 14px;border-radius:10px;background:var(--surface)}
.mgroup{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);margin-top:10px;overflow:hidden}
.mgroup>header{all:unset;display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.mgroup>header b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mgroup>header button{padding:3px 10px;font-size:12px}
.frow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;padding:9px 14px;border-top:1px solid var(--line);cursor:pointer}
.frow:first-of-type{border-top:0}.frow:hover{background:color-mix(in srgb,var(--surface-2) 60%,transparent)}.frow input{margin-top:3px;width:16px;height:16px;accent-color:var(--accent)}
.frow b{font-weight:550;display:block;word-break:break-word}.frow small{color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:2px}
.frow small code{font-size:11px}.frow .w{color:var(--warn)}
.selbar{position:sticky;bottom:12px;margin-top:20px;display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--accent);border-radius:12px;padding:10px 12px 10px 16px;box-shadow:0 8px 30px rgb(0 0 0 / .35);z-index:5}
.selbar #selinfo{flex:1;font-weight:600;white-space:nowrap}.selbar[hidden]{display:none}
dialog{background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:20px;width:min(640px,calc(100vw - 32px));max-height:calc(100vh - 64px)}
dialog::backdrop{background:rgb(0 0 0 / .55)}dialog h3{margin:0 0 10px;font-size:17px}
dialog ul{margin:8px 0;padding-left:18px;max-height:40vh;overflow:auto;font-size:13px}dialog li{margin:4px 0;word-break:break-word}dialog li small{color:var(--muted);display:block}
.note.bad{border-color:color-mix(in srgb,var(--bad) 50%,var(--line));background:color-mix(in srgb,var(--bad) 8%,var(--surface))}
.ugrid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}.ugrid label{display:grid;gap:4px;font-weight:550;font-size:13px}.ugrid label small{font-weight:400}.ugrid .span2{grid-column:span 2}
.ugrid label.chk{display:flex;gap:8px;align-items:center;font-weight:500}.ugrid input:not([type=checkbox]){width:100%}
.ucard{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px}.ucard .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-content:start}.ucard .acts button{padding:5px 10px;font-size:13px}
.st{font-size:12px;font-weight:600;border-radius:99px;padding:1px 8px;background:var(--surface-2)}.st.active{color:var(--good)}.st.invited{color:var(--accent)}.st.disabled,.st.invite-expired{color:var(--bad)}
.secret{font:14px ui-monospace,monospace;background:var(--bg);border:1px dashed var(--accent);border-radius:8px;padding:8px 12px;display:inline-block;user-select:all;word-break:break-all}
.drow{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) auto;gap:4px 14px;align-items:center;padding:10px 16px;border-top:1px solid var(--line);font-size:13px}.drow:first-child{border-top:0}.drow small{color:var(--muted);display:block}
.rq{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:12px;align-items:start}.rq img{width:54px;height:81px;border-radius:6px;object-fit:cover;background:var(--surface-2)}.rq img.yt,.rq.ytj img{height:30px}
.pl-head{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.pl-dest{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0}
.pl-rows{display:grid;gap:2px;max-height:460px;overflow:auto;border-top:1px solid var(--line);margin-top:8px}.pl-row{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}
.pl-row input[type=number]{width:52px;padding:3px 4px}.pl-se{display:flex;gap:4px;align-items:center}.pl-row small{color:var(--muted)}
.bar{height:4px;border-radius:2px;background:var(--surface-2);margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.rq .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.wsearch{display:flex;gap:8px;margin-bottom:12px}.wsearch input{flex:1;font-size:16px;padding:10px 14px;border-radius:10px;background:var(--surface)}
.wgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:14px;margin-bottom:8px}.wgrid:empty{display:none}
a.pl{color:var(--text);text-decoration:none}a.pl:hover{text-decoration:none}a.pl:hover .art{outline:2px solid var(--accent)}
.agebar{padding:10px 14px;border-bottom:1px solid var(--line)}.agebar input{width:100%}.agelist{max-height:420px;overflow:auto}
.arow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 14px;border-top:1px solid var(--line);font-size:13px}.arow:first-child{border-top:0}.arow small{color:var(--muted)}
.ucard .agesel{margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}.ucard .agesel select{padding:4px 8px;font-size:13px}
@media (max-width:860px){.stats{grid-template-columns:repeat(3,1fr)}.flow{grid-template-columns:repeat(2,1fr)}}
@media (max-width:640px){.disks{grid-template-columns:1fr}header{gap:8px;padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top))}.pill .lbl{display:none}.wrap{padding:16px 16px 32px}
nav{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--surface);border-top:1px solid var(--line);gap:0;padding:4px 4px max(4px,env(safe-area-inset-bottom));overflow:visible}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 1px;font-size:min(10.5px,2.55vw);letter-spacing:-.02em;border-radius:10px;min-width:0;white-space:nowrap}.tab small{display:none}.ti{display:block;width:22px;height:22px}
.tab[aria-selected=true]{box-shadow:none;color:var(--accent);background:transparent}main{padding-bottom:calc(58px + env(safe-area-inset-bottom))}.mnote{display:block;margin:0;padding:8px 14px;font-size:13px;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--line)}.pane:has(.mnote){display:none}.pane.on:has(.mnote){display:flex;flex-direction:column}.pane:has(.mnote) iframe{flex:1;height:auto}
.side .ext{font-size:0;width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px}.side .ext::before{content:"↗";font-size:16px}
.side .ext[hidden]{display:none}.side button.quiet{padding:6px 10px}.settings{grid-template-columns:1fr}.flow small{display:none}.flow a{padding:10px 12px}
.stats{grid-template-columns:repeat(2,1fr)}.stats>:last-child{grid-column:span 2}.fix{grid-template-columns:1fr}.fix-form{flex-wrap:wrap}.fix-form input{flex:1;width:auto}.rail{grid-auto-columns:108px}.ugrid{grid-template-columns:1fr}.ugrid .span2{grid-column:auto}.ucard{grid-template-columns:1fr}.ucard .acts{justify-content:flex-start}.drow{grid-template-columns:1fr auto}.drow>:nth-child(2),.drow>:nth-child(3){grid-column:1}.rq{grid-template-columns:44px 1fr}.rq img{width:44px;height:66px}.rq img.yt,.rq.ytj img{height:25px}.rq .acts{grid-column:2;justify-content:flex-start}.selbar{bottom:calc(66px + env(safe-area-inset-bottom));padding:8px 8px 8px 12px;gap:8px}.selbar .long{display:none}dialog{padding:16px}}
</style>
<header>
  <div class=brand>${ICON}Watch <small>admin</small></div>
  <nav role=tablist aria-label=Sections>
    <button class=tab role=tab data-tab=library>${tabIcon('library')}Library</button>
    <button class=tab role=tab data-tab=manage>${tabIcon('manage')}Manage</button>
    <button class=tab role=tab data-tab=users>${tabIcon('users')}Users</button>
    <button class=tab role=tab data-tab=pipeline>${tabIcon('pipeline')}Pipeline</button>
    ${toolTabs.map(x => `<button class=tab role=tab data-tab=${esc(x.id)}>${tabIcon(x.id)}${esc(x.label)}<small>${esc(x.id)}</small></button>`).join('')}
  </nav>
  <div class=side>
    <span class=pill title="Library sync runs every 15 minutes and right after each copy"><i class="dot${last.error ? ' bad' : ''}"></i><span class=lbl id=synced data-at="${last.at || 0}">${last.error ? 'Sync error' : 'Synced'}</span></span>
    <button type=button class="quiet theme" id=theme aria-label="Theme"></button>
    <form method=post action=/admin/sync><button class=quiet title="Check ${cfg().storageName} for new files now">Sync now</button></form>
    <a class=ext id=ext target=_blank rel="noopener noreferrer" hidden title="Open in a new tab" aria-label="Open in a new tab">Open in new tab ↗</a>
  </div>
</header>
${lowDisk.length ? `<div class=alert role=alert>Disk space is running low on ${lowDisk.join(' and ')}. <a href="#library">See storage</a></div>` : ''}
<main>
<section class="pane doc" id=library role=tabpanel><div class=wrap>${library}</div></section>
<section class="pane doc" id=manage role=tabpanel><div class=wrap>${manage}</div></section>
<section class="pane doc" id=users role=tabpanel><div class=wrap>${usersHtml}</div></section>
<section class="pane doc" id=pipeline role=tabpanel><div class=wrap>${pipeline}</div></section>
${toolTabs.map(x => `<section class=pane id=${esc(x.id)} role=tabpanel>${x.phone_note ? `<p class=mnote>${esc(x.phone_note)} <a href="#pipeline">Pipeline</a> tab.</p>` : ''}<iframe title="${esc(x.name)}" data-src="/admin/tools/launch?tool=${esc(x.id)}" allow="clipboard-write"></iframe></section>`).join('')}
</main>
<script>
const $ = s => document.querySelector(s), esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = s => { if (!s) return 'never'; const d = Date.now() / 1000 - s; return d < 90 ? 'just now' : d < 5400 ? Math.round(d / 60) + ' min ago' : d < 172800 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' days ago'; };
const syncedEl = $('#synced');
const showSynced = at => { if (at) syncedEl.dataset.at = at; if (!syncedEl.textContent.startsWith('Sync error')) syncedEl.textContent = 'Synced ' + ago(Number(syncedEl.dataset.at)); };
showSynced(); setInterval(showSynced, 30000);

// Theme: Auto (follow the system) -> Dark -> Light. Remembered per browser.
const THEMES = { auto: ['Theme: automatic (follows the system)', '<path d="M12 3a9 9 0 1 0 0 18z" fill="currentColor"/><circle cx="12" cy="12" r="9"/>'],
  dark: ['Theme: dark', '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'],
  light: ['Theme: light', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'] };
const themeBtn = $('#theme');
function paintTheme() {
  const t = document.documentElement.dataset.theme || 'auto', [label, icon] = THEMES[t];
  themeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icon + '</svg>';
  themeBtn.title = label + '. Click to change.'; themeBtn.setAttribute('aria-label', label);
}
themeBtn.onclick = () => {
  const order = ['auto', 'dark', 'light'], next = order[(order.indexOf(document.documentElement.dataset.theme || 'auto') + 1) % 3];
  if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
  try { next === 'auto' ? localStorage.removeItem('watch-theme') : localStorage.setItem('watch-theme', next); } catch {}
  paintTheme();
};
paintTheme();

var manageLoaded = false;
const tabs = [...document.querySelectorAll('.tab')];
function show(id) {
  if (!document.getElementById(id) || !document.getElementById(id).classList.contains('pane')) {
    const el = document.getElementById(id);
    if (el) { const pane = el.closest('.pane'); if (pane) { show(pane.id); el.scrollIntoView({ block: 'start' }); } return; }
    id = 'library';
  }
  for (const b of tabs) b.setAttribute('aria-selected', b.dataset.tab === id);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === id);
  const f = document.querySelector('#' + id + ' iframe');
  if (f && !f.src) f.src = f.dataset.src;
  const ext = $('#ext'); ext.hidden = !f; if (f) ext.href = f.dataset.src;
  if (id === 'pipeline') refresh();
  if (id === 'manage' && !manageLoaded) { manageLoaded = true; setTimeout(() => { loadSuggestions(); loadTrash(); }); }
  if (id === 'users') setTimeout(() => { loadUsers(); loadShares(); loadAges(); });
  if (id === 'pipeline') setTimeout(() => { loadRequests(); loadYoutube(); });
}
tabs.forEach(b => b.onclick = () => { history.replaceState(null, '', '#' + b.dataset.tab); show(b.dataset.tab); });
addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1) || 'library');
if (location.search) history.replaceState(null, '', location.pathname + location.hash);

const size = n => n == null ? '' : n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(0) + ' MB';
const speed = n => n > 0 ? (n / 1e6).toFixed(1) + ' MB/s' : '';
const api = async (p, body) => { const r = await fetch('/admin/api/' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const d = await r.json().catch(() => ({ error: r.status === 403 || r.redirected ? 'Your admin session expired. Reload the page.' : 'HTTP ' + r.status })); if (!r.ok || d.error) throw new Error(d.error || r.status); return d; };
const watching = new Set();
let timer;

async function refresh() {
  clearTimeout(timer);
  if (!$('#pipeline').classList.contains('on')) return;
  try {
    const d = await api('pipeline');
    showSynced(d.last_sync);
    const errs = [];
    if (d.errors.rs) errs.push('Can’t reach rsync-web on the download box (' + d.errors.rs + ').');
    if (d.errors.dl) errs.push('Can’t reach qBittorrent on the download box (' + d.errors.dl + ').');
    $('#perr').innerHTML = errs.map(e => '<div class=note>' + esc(e) + '</div>').join('');
    for (const k of ['auto', 'cleanup']) { const el = $('#s-' + k); el.checked = !!d.settings[k]; el.disabled = false; }
    for (const k of ['seed_ratio', 'seed_hours']) { const el = $('#s-' + k); if (document.activeElement !== el) el.value = d.settings[k]; }
    if (d.storage && d.storage.box) $('#f-dl').textContent += ' · ' + Math.round((d.storage.box.total - d.storage.box.used) / 2 ** 30) + ' GB free';
    const active = d.torrents.filter(t => t.progress < 1);
    $('#f-dl').textContent = active.length ? active.length + ' downloading' + (d.transfer && d.transfer.dl ? ' · ' + speed(d.transfer.dl) : '') : 'Nothing downloading';
    $('#f-ready').textContent = d.items.filter(i => !i.in_library).length + ' waiting to send';
    $('#f-sync').textContent = 'Library synced ' + ago(d.last_sync);
    $('#pready-n').textContent = d.items.length || '';
    const running = new Set(d.jobs.filter(j => j.status === 'running').map(j => j.source));
    $('#pready').innerHTML = d.items.map(i => {
      const busy = running.has('media/' + i.name);
      return '<div class=card data-name="' + esc(i.name) + '"><div class=name>' + esc(i.name) + '</div><div class=meta>' +
        (i.size ? '<span>' + size(i.size) + '</span>' : '') +
        (i.in_library ? '<span class=good>✓ In library · ' + i.in_library + ' video' + (i.in_library > 1 ? 's' : '') + '</span>' : '<span>Not in library yet</span>') +
        (busy ? '<span class=status>copying…</span>' : (!i.in_library && i.hash && d.settings.auto ? '<span>sending automatically…</span>' : '')) +
        (i.in_library && i.hash && i.ratio != null ? '<span>seeding · ratio ' + i.ratio.toFixed(2) + ' of ' + d.settings.seed_ratio + ' · ' + Math.floor(i.seeding_time / 3600) + ' of ' + d.settings.seed_hours + ' h' + (i.upspeed ? ' · ↑ ' + speed(i.upspeed) : '') + (d.settings.cleanup ? ' · removed after' : '') + '</span>' : '') + '</div><div class=row>' +
        '<select aria-label="Library for ' + esc(i.name) + '"><option value=movie' + (i.kind === 'movie' ? ' selected' : '') + '>Movie</option><option value=tv' + (i.kind === 'tv' ? ' selected' : '') + '>TV show</option></select>' +
        '<button data-act=push' + (busy ? ' disabled' : '') + (i.in_library ? ' class=quiet' : '') + '>' + (i.in_library ? 'Send again' : 'Send to library') + '</button>' +
        (i.hash ? '<button class=quiet data-act=remove data-hash=' + i.hash + '>Remove from box</button>' : '') +
        '</div></div>';
    }).join('') || '<p class=hint>Nothing waiting. Finished downloads show up here.</p>';
    $('#ptorrents').innerHTML = active.map(t => '<div class=card><div class=name>' + esc(t.name) + '</div><div class=prog><i style="width:' + (t.progress * 100).toFixed(1) + '%"></i></div><div class=meta><span>' + (t.progress * 100).toFixed(1) + '%</span><span>' + size(t.size) + '</span>' + (speed(t.dlspeed) ? '<span>' + speed(t.dlspeed) + '</span>' : '') + (t.eta > 0 && t.eta < 8640000 ? '<span>' + (t.eta > 5400 ? Math.round(t.eta / 3600) + ' h' : Math.max(1, Math.round(t.eta / 60)) + ' min') + ' left</span>' : '') + '<span>' + esc(t.state) + '</span></div></div>').join('') || '<p class=hint>Nothing downloading.</p>';
    $('#pjobs').innerHTML = d.jobs.slice(0, 8).map(j => {
      if (j.status === 'running') watching.add(j.id);
      return '<div class=card><div class=name>' + esc(j.source === 'media/' ? 'Everything in ~/media' : j.source.replace(/^media[/]/, '')) + '</div><div class=meta><span class="status ' + esc(j.status) + '">' + esc(j.status) + '</span>' + (j.auto ? '<span class=tag>auto</span>' : '') + '<span>→ ' + esc(j.destination) + '</span><span>' + esc((j.created_at || '').replace('T', ' ').slice(0, 16)) + '</span>' +
        (j.cleanup ? (j.cleanup.removed ? '<span class=good>✓ removed from box</span>' : j.cleanup.waiting ? '<span>seeding, then removed</span>' : j.cleanup.gone ? '<span>removed by hand</span>' : '<span class=bad title="' + esc(j.cleanup.error) + '">kept on box: ' + esc(j.cleanup.error) + '</span>') : '') + '</div><pre id=job' + j.id + ' hidden></pre></div>';
    }).join('') || '<p class=hint>No copies yet.</p>';
    for (const id of watching) pollJob(id);
  } catch (e) { $('#perr').innerHTML = '<div class=note>Couldn’t load the pipeline: ' + esc(e.message) + '</div>'; }
  timer = setTimeout(refresh, document.hidden ? 30000 : 6000);
}

async function pollJob(id) {
  try {
    const j = await api('job/' + id), pre = document.getElementById('job' + id);
    if (pre) { pre.hidden = false; pre.textContent = j.tail.join('\\n'); }
    if (j.status !== 'running') { watching.delete(id); if (j.status === 'completed' && j.synced && pre) pre.textContent += '\\n✓ Copied. The library is updating; it will be in your apps within a minute.' + (j.cleanup?.removed ? '\\n✓ Removed from the download box.' : ''); }
  } catch {}
}

$('#pready').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  const card = b.closest('.card'), name = card.dataset.name;
  try {
    if (b.dataset.act === 'push') {
      b.disabled = true; b.textContent = 'Starting…';
      const r = await api('push', { name, kind: card.querySelector('select').value });
      watching.add(r.job);
    } else if (b.dataset.act === 'remove') {
      if (!confirm('Delete “' + name + '” from the download box and remove its torrent?\\n\\n${cfg().storageName} and your library are not touched.')) return;
      b.disabled = true; await api('remove', { hash: b.dataset.hash });
    }
  } catch (e) { alert(e.message); b.disabled = false; }
  refresh();
});
for (const k of ['seed_ratio', 'seed_hours']) $('#s-' + k).addEventListener('change', async ev => {
  try { await api('settings', { [k]: Number(ev.target.value) }); } catch (e) { alert(e.message); }
  refresh();
});
for (const k of ['auto', 'cleanup']) $('#s-' + k).addEventListener('change', async ev => {
  ev.target.disabled = true;
  try { await api('settings', { [k]: ev.target.checked }); } catch (e) { alert(e.message); ev.target.checked = !ev.target.checked; }
  ev.target.disabled = false; refresh();
});

// ---------- Manage ----------
const ROOT_LABEL = ${JSON.stringify(cfg().label)};
const picked = new Map();   // id -> file
const fileName = f => f.path.split('/').pop();
function fileRow(f) {
  const dir = f.path.split('/').slice(0, -1).join('/');
  const bits = [(f.label ? '<b class=tag>' + esc(f.label) + '</b>' : ''), '<code>' + esc(ROOT_LABEL[f.root] || f.root) + (dir ? '/' + esc(dir) : '') + '</code>', '<span>' + size(f.size) + '</span>'];
  if (f.minutes != null) bits.push('<span>' + (f.minutes < 10 ? f.minutes : Math.round(f.minutes)) + ' min</span>');
  if (f.height) { const r = Math.max(f.height, Math.round((f.width || 0) * 9 / 16)); bits.push('<span>' + (r >= 2000 ? '4K' : r >= 1000 ? '1080p' : r >= 700 ? '720p' : r + 'p') + '</span>'); }
  if (f.kind === 'sample' || f.kind === 'extra') bits.push('<span>' + f.kind + '</span>');
  if (f.copies > 1) bits.push('<span title="The same data is stored under ' + f.copies + ' paths (hard links); all are removed together">' + f.copies + ' paths</span>');
  for (const w of f.watch || []) bits.push('<span class=w>' + esc(w.user) + (w.played ? ' watched' : w.pct ? ' ' + w.pct + '% in' : ' started') + '</span>');
  return '<label class=frow><input type=checkbox value="' + f.id + '"' + (picked.has(f.id) ? ' checked' : '') + '><span><b>' + esc(fileName(f)) + '</b><small>' + bits.filter(Boolean).join('') + '</small></span></label>';
}
function groupBox(title, files, extra) {
  return '<div class=mgroup><header><b>' + esc(title) + '</b>' + (extra || '') + '<span class=muted>' + files.length + ' · ' + size(files.reduce((n, f) => n + f.size, 0)) + '</span>' +
    '<button type=button class=quiet data-all="' + files.map(f => f.id).join(',') + '">Select all</button></header>' + files.map(fileRow).join('') + '</div>';
}
const known = new Map();   // id -> file, for every file shown
const remember = fs => { for (const f of fs) known.set(f.id, f); return fs; };
function grouped(files) {
  const g = new Map();
  for (const f of files) { if (!g.has(f.group)) g.set(f.group, { title: f.title, files: [] }); g.get(f.group).files.push(f); }
  return [...g.values()].map(x => groupBox(x.title, x.files)).join('');
}
let qTimer;
$('#mq').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 250); });
async function runSearch() {
  const q = $('#mq').value.trim();
  if (q.length < 2) { $('#mres').innerHTML = ''; return; }
  try {
    const d = await api('manage/search?q=' + encodeURIComponent(q));
    $('#mres').innerHTML = d.files.length ? grouped(remember(d.files)) + (d.files.length >= 400 ? '<p class=hint>Showing the first 400 files; narrow the search.</p>' : '') : '<p class=hint>No files match “' + esc(q) + '”.</p>';
  } catch (e) { $('#mres').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; }
}
function section(title, hint, body, open) {
  return '<details' + (open ? ' open' : '') + '><summary>' + title + '</summary>' + (hint ? '<p class=hint>' + hint + '</p>' : '') + body + '</details>';
}
async function loadSuggestions() {
  try {
    const d = await api('manage/suggestions');
    remember(d.samples); remember(d.short); remember(d.extras); d.duplicates.forEach(g => remember(g.files));
    const n = a => '<span class=count>' + a.length + '</span>';
    const copies = d.duplicates.filter(g => g.copies), other = d.duplicates.filter(g => !g.copies);
    $('#msug').innerHTML =
      section('Sample clips ' + n(d.samples), 'Short preview clips that came with downloads. They’re already hidden from your apps.', d.samples.length ? groupBox('All sample clips', d.samples) : '<p class=hint>None.</p>', false) +
      section('Very short files ' + n(d.short), 'Movies under ' + d.short_minutes.movie + ' minutes and episodes under ' + d.short_minutes.episode + ' minutes. Usually a sample or trailer that was mistaken for the real thing, but short films exist too, so check.', d.short.length ? grouped(d.short) : '<p class=hint>None.</p>', d.short.length > 0) +
      section('Same title, several copies ' + n(copies), 'The same movie or episode more than once at about the same length. Best quality first. Keep one.', copies.map(g => groupBox(g.title, g.files)).join('') || '<p class=hint>None.</p>', copies.length > 0) +
      section('Parts or different cuts ' + n(other), 'Several files of one title with different lengths: usually parts (1, 2, 3) or cuts (extended, director’s). Most of these should stay.', other.map(g => groupBox(g.title, g.files)).join('') || '<p class=hint>None.</p>', false) +
      section('Extras ' + n(d.extras), 'Featurettes, behind-the-scenes and other bonus files. Hidden from your apps.', d.extras.length ? grouped(d.extras) : '<p class=hint>None.</p>', false);
  } catch (e) { $('#msug').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; }
}
async function loadTrash() {
  try {
    const d = await api('manage/trash');
    $('#trash-days').textContent = d.days;
    $('#trash-n').textContent = d.batches.length || '';
    const total = d.batches.reduce((n, b) => n + b.bytes, 0);
    $('#mtrash').innerHTML = d.batches.map(b => {
      const left = Math.max(0, Math.ceil((b.at + d.days * 86400 - Date.now() / 1000) / 86400));
      return '<div class=card><div class=name>' + esc(b.label || b.files.length + ' files') + '</div><div class=meta><span>' + ago(b.at) + '</span><span>' + b.files.length + ' file' + (b.files.length === 1 ? '' : 's') + (b.folders.length ? ' + ' + b.folders.length + ' folder' + (b.folders.length === 1 ? '' : 's') : '') + '</span><span>' + size(b.bytes) + '</span><span>removed for good in ' + left + ' day' + (left === 1 ? '' : 's') + '</span>' +
        (b.linked_elsewhere.length ? '<span class=w title="' + esc(b.linked_elsewhere.join('\\n')) + '">some data is also linked elsewhere, so emptying frees less</span>' : '') + '</div>' +
        '<details><summary>What’s in it</summary><ul class=plain>' + b.files.map(f => '<li><code>' + esc((ROOT_LABEL[f.root] || f.root) + '/' + f.rel) + '</code></li>').join('') + b.folders.map(f => '<li><code>' + esc((ROOT_LABEL[f.root] || f.root) + '/' + f.rel) + '/</code> <span class=muted>leftover folder</span></li>').join('') + '</ul></details>' +
        '<div class=row style="margin-top:10px"><button type=button data-restore="' + b.batch + '">Restore</button><button type=button class=quiet data-purge="' + b.batch + '">Delete for good</button></div></div>';
    }).join('') + (d.batches.length > 1 ? '<div class=row><button type=button class=quiet data-purge=all>Empty trash (' + size(total) + ')</button></div>' : '') || '<p class=hint>The trash is empty.</p>';
  } catch (e) { $('#mtrash').innerHTML = '<div class=note>Couldn’t read the trash: ' + esc(e.message) + '</div>'; }
}
function updateSel() {
  for (const cb of document.querySelectorAll('#manage .frow input')) cb.checked = picked.has(cb.value);
  const bytes = [...picked.values()].reduce((n, f) => n + f.size, 0);
  $('#selbar').hidden = !picked.size;
  $('#selinfo').textContent = picked.size + ' selected · ' + size(bytes);
}
$('#manage').addEventListener('change', ev => {
  const cb = ev.target.closest('.frow input'); if (!cb) return;
  if (cb.checked) picked.set(cb.value, known.get(cb.value)); else picked.delete(cb.value);
  updateSel();
});
$('#manage').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.all) { const ids = b.dataset.all.split(','), on = !ids.every(id => picked.has(id)); for (const id of ids) on ? picked.set(id, known.get(id)) : picked.delete(id); updateSel(); return; }
  if (b.dataset.restore) {
    b.disabled = true; b.textContent = 'Restoring…';
    try { const r = await api('manage/restore', { batch: b.dataset.restore }); msg('Restored ' + r.restored.length + ' item' + (r.restored.length === 1 ? '' : 's') + '. They’re back in your apps.' + (r.conflicts.length ? ' Not restored because something else is there now: ' + r.conflicts.join(', ') : ''), !r.conflicts.length); }
    catch (e) { msg(e.message, false); }
    reloadManage(); return;
  }
  if (b.dataset.purge) {
    if (!confirm(b.dataset.purge === 'all' ? 'Permanently delete everything in the trash? This can’t be undone.' : 'Permanently delete these files? This can’t be undone.')) return;
    b.disabled = true;
    try { const r = await api('manage/purge', b.dataset.purge === 'all' ? { all: true } : { batch: b.dataset.purge }); msg('Deleted for good. ' + size(r.bytes) + ' freed on ${cfg().storageName} (the storage meter catches up within 15 minutes).', true); }
    catch (e) { msg(e.message, false); }
    loadTrash();
  }
});
function msg(text, good, undo) {
  $('#mmsg').innerHTML = '<div class="' + (good ? 'toast' : 'note bad') + '">' + esc(text) + (undo ? ' <button type=button class=quiet data-restore="' + undo + '">Undo</button>' : '') + '</div>';
  $('#mmsg').scrollIntoView({ block: 'nearest' });
}
$('#selclear').onclick = () => { picked.clear(); updateSel(); };
const SELDEL = $('#seldel').innerHTML;
$('#seldel').onclick = async () => {
  const btn = $('#seldel'); btn.disabled = true; btn.textContent = 'Checking…';
  let plan;
  try { plan = await api('manage/plan', { ids: [...picked.keys()] }); }
  catch (e) { msg(e.message, false); btn.disabled = false; btn.innerHTML = SELDEL; return; }
  btn.disabled = false; btn.innerHTML = SELDEL;
  const blocked = new Set(plan.blocked.map(x => x.id));
  $('#mdlg-h').textContent = 'Move ' + plan.files.length + ' file' + (plan.files.length === 1 ? '' : 's') + ' (' + size(plan.bytes) + ') to the trash?';
  $('#mdlg-body').innerHTML =
    (plan.box_error ? '<div class="note bad">' + esc(plan.box_error) + '</div>' : '') +
    plan.blocked.map(x => '<div class="note bad"><b>Can’t delete ' + esc(x.name) + '.</b> ' + esc(x.reason) + '</div>').join('') +
    plan.warnings.map(w => '<div class=note>' + esc(w) + '</div>').join('') +
    '<ul>' + plan.files.map(f => '<li' + (blocked.has(f.id) ? ' class=bad' : '') + '>' + esc(f.title) + (f.label ? ' ' + esc(f.label) : '') + ' — <b>' + esc(fileName(f)) + '</b><small>' +
      f.paths.map(p => { const i = p.indexOf('/'); return esc((ROOT_LABEL[p.slice(0, i)] || p.slice(0, i)) + p.slice(i)); }).join('<br>') + (f.subtitles ? '<br>+ ' + f.subtitles + ' subtitle file' + (f.subtitles === 1 ? '' : 's') : '') + '</small></li>').join('') + '</ul>' +
    '<p class=hint>Every path of each file goes, plus its subtitles, and any folder left holding only small leftovers (nfo, images). The library updates right away. You can restore from the trash for ' + ($('#trash-days').textContent || 14) + ' days.</p>';
  const go = $('#mdlg-go'); go.disabled = !!plan.box_error || plan.blocked.length > 0; go.textContent = 'Move to trash';
  $('#mdlg').showModal();
  $('#mdlg').onclose = async () => {
    if ($('#mdlg').returnValue !== 'go') return;
    const titles = [...new Set(plan.files.map(f => f.title + (f.kind === 'sample' ? ' (sample)' : f.label ? ' ' + f.label : '')))];
    const label = titles.slice(0, 3).join(', ') + (titles.length > 3 ? ' and ' + (titles.length - 3) + ' more' : '');
    msg('Moving to the trash…', true);
    try {
      const r = await api('manage/delete', { ids: plan.files.map(f => f.id), label });
      picked.clear(); updateSel();
      msg('Moved ' + r.moved + ' file' + (r.moved === 1 ? '' : 's') + (r.folders ? ' and ' + r.folders + ' leftover folder' + (r.folders === 1 ? '' : 's') : '') + ' to the trash. Your apps no longer show ' + (r.moved === 1 ? 'it' : 'them') + '. Emptying the trash frees ' + size(r.frees) + '.' +
        (r.linked_elsewhere.length ? ' Some of the data is also linked from outside the library, so less space is freed.' : ''), true, r.batch);
    } catch (e) { msg(e.message, false); }
    reloadManage();
  };
};
function reloadManage() { loadSuggestions(); loadTrash(); runSearch(); }

// ---------- Users ----------
let usersLoaded = false, AGES = [];
const AGE_OPTS = cur => AGES.map(a => '<option value="' + (a.value ?? '') + '"' + ((a.value ?? null) === (cur ?? null) ? ' selected' : '') + '>' + esc(a.label) + '</option>').join('');
async function loadUsers() {
  try {
    const d = await api('users');
    AGES = d.age_limits;
    if (!$('#uage').options.length) $('#uage').innerHTML = AGE_OPTS(null);
    $('#u-n').textContent = d.users.length;
    $('#qcu').innerHTML = d.users.filter(u => u.status === 'active').map(u => '<option value="' + u.id + '">' + esc(u.display_name || u.username) + '</option>').join('');
    $('#email-state').textContent = d.email_ready ? '' : '(email sending isn’t set up yet: you’ll get a link to share instead)';
    $('#ulist').innerHTML = d.users.map(u => {
      const st = u.status, inv = u.invite_email;
      const bits = ['<span class="st ' + st.replace(' ', '-') + '">' + st + '</span>', '<code>' + esc(u.username) + '</code>', u.email ? esc(u.email) : '<span class=muted>no email</span>',
        u.devices + ' device' + (u.devices === 1 ? '' : 's'), 'last active ' + ago(u.last_seen), u.watched + ' watched'];
      if (u.open_requests) bits.push(u.open_requests + ' open request' + (u.open_requests === 1 ? '' : 's'));
      if (u.auto_approve) bits.push('<span class=tag>auto-approve</span>');
      if (u.max_age != null) bits.push('<span class=tag>age limit ' + u.max_age + (u.allow_unrated ? ', unrated shown' : '') + '</span>');
      if (u.shares) bits.push(u.shares + ' shared link' + (u.shares === 1 ? '' : 's'));
      if (st === 'invited') bits.push('invite expires in ' + Math.max(1, Math.ceil((u.invite_expires - Date.now() / 1000) / 86400)) + ' days' + (inv ? (inv.ok ? ' · emailed ' + ago(inv.at) : ' · email not sent: ' + esc(inv.error)) : ''));
      const acts = [];
      if (u.email && st !== 'active') acts.push('<button class=quiet data-u=invite>' + (st === 'invited' ? 'Resend invite' : 'New invite') + '</button>');
      if (st !== 'invited' && st !== 'invite expired') acts.push('<button class=quiet data-u=password>Reset password</button>');
      if (u.devices) acts.push('<button class=quiet data-u=signout>Sign out everywhere</button>');
      acts.push('<button class=quiet data-u=edit>Edit</button>');
      acts.push('<button class=quiet data-u=' + (u.disabled ? 'enable>Turn on' : 'disable>Turn off') + '</button>');
      acts.push('<button class=quiet data-u=delete>Delete</button>');
      return '<div class="card ucard" data-id="' + u.id + '" data-username="' + esc(u.username) + '" data-email="' + esc(u.email || '') + '" data-name="' + esc(u.display_name || '') + '" data-auto="' + u.auto_approve + '"><div><div class=name>' + esc(u.display_name || u.username) + '</div><div class=meta style="margin-bottom:0">' + bits.map(x => '<span>' + x + '</span>').join('') + '</div><div class=agesel>Age limit <select data-agesel>' + AGE_OPTS(u.max_age) + '</select><label><input type=checkbox data-unrated' + (u.allow_unrated ? ' checked' : '') + (u.max_age == null ? ' disabled' : '') + '> show unrated</label></div><div class=uout></div></div><div class=acts>' + acts.join('') + '</div></div>';
    }).join('');
    $('#d-n').textContent = d.devices.length;
    $('#dlist').innerHTML = d.devices.map(x => '<div class=drow><div><b>' + esc(x.display_name || x.username) + '</b><small>' + esc(x.device_name || 'Unknown device') + '</small></div><div>' + esc((x.client || '') + (x.client_version ? ' ' + x.client_version : '')) + '<small>signed in ' + new Date(x.created_at * 1000).toLocaleDateString() + '</small></div><div>' + ago(x.last_seen) + '<small>' + esc(x.place || '') + (x.ip ? ' · ' + esc(x.ip) : '') + '</small></div><button class=quiet data-session="' + x.id + '">Sign out</button></div>').join('') || '<p class=hint style="padding:14px 16px;margin:0">No devices signed in.</p>';
  } catch (e) { $('#ulist').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; }
}
function showSecret(card, html) { card.querySelector('.uout').innerHTML = '<div class=toast style="margin:10px 0 0">' + html + '</div>'; }
const inviteText = (u, portal) => 'Open ' + portal + ' and sign in with ' + u + '. You’ll get a code by email, then choose your password.';
async function shareLink(text) { if (navigator.share) { try { await navigator.share({ text }); return; } catch {} } try { await navigator.clipboard.writeText(text); } catch {} }
$('#uadd').onsubmit = async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target), b = Object.fromEntries(f);
  b.send_email = f.has('send_email'); b.auto_approve = f.has('auto_approve'); b.allow_unrated = f.has('allow_unrated');
  try {
    const r = await api('users/create', b);
    let html = 'Created <b>' + esc(b.username) + '</b>. ';
    if (r.password) html += 'Their password (shown once): <span class=secret>' + esc(r.password) + '</span><br>Server: <code>' + esc(location.origin) + '</code>';
    else html += (r.email && r.email.ok ? 'Invite emailed to ' + esc(b.email) + '. ' : 'Invite not emailed' + (r.email && r.email.error ? ' (' + esc(r.email.error) + ')' : '') + '. ') +
      'You can also send them this: <span class=secret>' + esc(inviteText(b.email, r.portal)) + '</span> <button type=button class=quiet data-share="' + esc(inviteText(b.email, r.portal)) + '">Copy / share</button>';
    $('#umsg').innerHTML = '<div class=toast>' + html + '</div>';
    ev.target.reset(); loadUsers();
  } catch (e) { $('#umsg').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; }
  $('#umsg').scrollIntoView({ block: 'nearest' });
};
$('#users').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.share) { await shareLink(b.dataset.share); b.textContent = 'Copied'; return; }
  if (b.dataset.unshare) { if (!confirm('Turn this link off? Anyone who has it won’t be able to watch any more.')) return; b.disabled = true; try { await api('shares/revoke', { id: b.dataset.unshare }); } catch (e) { alert(e.message); } loadShares(); return; }
  if (b.dataset.session) { b.disabled = true; try { await api('users/signout', { session: b.dataset.session }); } catch (e) { alert(e.message); } loadUsers(); return; }
  const card = b.closest('.ucard'); if (!card || !b.dataset.u) return;
  const id = card.dataset.id, name = card.dataset.username;
  try {
    switch (b.dataset.u) {
      case 'invite': { const r = await api('users/invite', { id }); showSecret(card, (r.email && r.email.ok ? 'Invite emailed. ' : 'Invite renewed' + (r.email && r.email.error ? ' (not emailed: ' + esc(r.email.error) + ')' : '') + '. ') + 'Share: <span class=secret>' + esc(inviteText(card.dataset.email, r.portal)) + '</span>'); return loadUsersKeep(card); }
      case 'password': { if (!confirm('Give ' + name + ' a new password? You’ll see it once and need to pass it on.')) return; const so = confirm('Also sign ' + name + ' out of all their devices?'); const r = await api('users/password', { id, sign_out: so }); showSecret(card, 'New password for ' + esc(name) + ' (shown once): <span class=secret>' + esc(r.password) + '</span>'); return; }
      case 'signout': if (!confirm('Sign ' + name + ' out of every device?')) return; await api('users/signout', { user: id }); break;
      case 'disable': if (!confirm('Turn off ' + name + '? They’re signed out everywhere and can’t sign in until you turn them back on.')) return; await api('users/update', { id, disabled: true }); break;
      case 'enable': await api('users/update', { id, disabled: false }); break;
      case 'edit': {
        const dn = prompt('Name', card.dataset.name); if (dn === null) return;
        const em = prompt('Email (empty for none)', card.dataset.email); if (em === null) return;
        const auto = confirm('Auto-approve ' + name + '’s movie requests?\\n\\nOK = yes, Cancel = no (you approve each one)');
        await api('users/update', { id, display_name: dn, email: em, auto_approve: auto }); break;
      }
      case 'delete': {
        const c = prompt('Delete ' + name + ' with their watch history, favorites, devices and requests? This can’t be undone.\\n\\nType the username to confirm:');
        if (c === null) return; await api('users/delete', { id, confirm: c }); break;
      }
    }
  } catch (e) { alert(e.message); }
  loadUsers();
});
$('#users').addEventListener('change', async ev => {
  const card = ev.target.closest('.ucard');
  try {
    if (card && ev.target.matches('[data-agesel]')) await api('users/update', { id: card.dataset.id, max_age: ev.target.value });
    else if (card && ev.target.matches('[data-unrated]')) await api('users/update', { id: card.dataset.id, allow_unrated: ev.target.checked });
    else if (ev.target.id === 'sh-guests') { await api('shares/settings', { guests: ev.target.checked }); return; }
    else if (ev.target.matches('[data-ageset]')) { await api('ages', { id: ev.target.dataset.ageset, age: ev.target.value === 'auto' ? 'auto' : ev.target.value === '' ? null : Number(ev.target.value) }); loadAges(); return; }
    else return;
  } catch (e) { alert(e.message); }
  loadUsers();
});
const AGE_SET = (cur, overridden) => ['<option value=auto' + (!overridden ? ' selected' : '') + '>From rating</option>', '<option value=""' + (overridden && cur == null ? ' selected' : '') + '>Unrated (hide)</option>']
  .concat([0, 7, 10, 13, 14, 16, 17, 18].map(a => '<option value=' + a + (overridden && cur === a ? ' selected' : '') + '>' + (a ? a + '+' : 'All ages') + '</option>')).join('');
const ageRow = t => '<div class=arow><div><b>' + esc(t.name) + '</b> <small>' + (t.type === 'Series' ? 'show' : 'movie') + (t.year ? ' · ' + t.year : '') + ' · rating: ' + esc(t.cert || 'none') + ' · age: ' + (t.age == null ? 'unknown (hidden from limited users)' : t.age + '+') + '</small></div><select data-ageset="' + t.id + '" aria-label="Age for ' + esc(t.name) + '">' + AGE_SET(t.age, t.overridden) + '</select></div>';
async function loadAges() {
  try { const d = await api('ages'); $('#age-n').textContent = d.titles.filter(t => t.age == null).length || ''; if (!$('#ageq').value.trim()) $('#agelist').innerHTML = d.titles.map(ageRow).join('') || '<p class=hint style="padding:12px 14px;margin:0">Every title has a rating.</p>'; }
  catch (e) { $('#agelist').innerHTML = '<p class=hint style="padding:12px 14px">' + esc(e.message) + '</p>'; }
}
let aqT; $('#ageq').addEventListener('input', () => { clearTimeout(aqT); aqT = setTimeout(async () => {
  const q = $('#ageq').value.trim(); if (!q) return loadAges();
  const lib = await (await fetch('/admin/api/library?q=' + encodeURIComponent(q))).json();
  const all = (await api('ages')).titles; const over = new Map(all.map(t => [t.id, t]));
  $('#agelist').innerHTML = lib.items.map(i => ageRow(over.get(i.id) || { id: i.id, type: i.type, name: i.name, year: i.year, cert: '(rated)', age: '…', overridden: false })).join('') || '<p class=hint style="padding:12px 14px;margin:0">Nothing matches.</p>';
}, 300); });
async function loadShares() {
  try {
    const d = await api('shares');
    $('#sh-guests').checked = d.settings.guests; $('#sh-n').textContent = d.shares.length || '';
    $('#shlist').innerHTML = d.shares.map(x => '<div class=drow><div><b>' + esc(x.title) + '</b><small>by ' + esc(x.by) + ' · ' + new Date(x.created_at * 1000).toLocaleDateString() + '</small></div><div>' + x.views + ' view' + (x.views === 1 ? '' : 's') + '<small>' + (x.last_view_at ? 'last ' + ago(x.last_view_at) : 'not opened yet') + '</small></div><div>' + (x.expires_at ? 'until ' + new Date(x.expires_at * 1000).toLocaleDateString() : 'no expiry') + '<small><a href="/s/' + x.id + '" target=_blank rel=noopener>open</a></small></div><button class=quiet data-unshare="' + x.id + '">Turn off</button></div>').join('') || '<p class=hint style="padding:14px 16px;margin:0">No active links.</p>';
  } catch (e) { $('#shlist').innerHTML = '<p class=hint style="padding:14px 16px">' + esc(e.message) + '</p>'; }
}
function loadUsersKeep(card) { const keep = card.querySelector('.uout').innerHTML, id = card.dataset.id; loadUsers().then(() => { const c = document.querySelector('.ucard[data-id="' + id + '"] .uout'); if (c) c.innerHTML = keep; }); }

// ---------- Requests (Pipeline tab) ----------
async function loadRequests() {
  try {
    const d = await api('requests');
    const open = d.requests.filter(r => r.status === 'pending');
    $('#requests-wrap').hidden = !d.requests.length;
    $('#req-n').textContent = open.length || '';
    $('#reqs').innerHTML = d.requests.map(r => {
      const who = r.people.map(p => esc(p.name) + (p.note ? ': “' + esc(p.note) + '”' : '')).join('<br>');
      const acts = r.status === 'pending' || r.status === 'approved'
        ? (r.kind === 'youtube' && String(r.yt_id).startsWith('list:') ? '<button data-rq=auto title="All videos into the YouTube library">Download all</button><button class=quiet data-rq=asshow>Add as a show…</button>' : '') +
          (r.kind === 'movie' || (r.kind === 'youtube' && !String(r.yt_id).startsWith('list:')) ? '<button data-rq=auto>Download</button>' : '') + (r.status === 'pending' ? '<button class=quiet data-rq=manual>Approve</button>' : '') + '<button class=quiet data-rq=decline>Decline</button>' : '';
      return '<div class="card rq" data-kind="' + r.kind + '" data-tmdb="' + r.tmdb_id + '" data-yt="' + esc(r.yt_id || '') + '">' + (r.poster ? '<img alt=""' + (r.kind === 'youtube' ? ' class=yt referrerpolicy=no-referrer' : '') + ' src="' + esc(r.poster) + '">' : '<span></span>') +
        '<div><div class=name>' + (r.yt_id ? '<a href="https://www.youtube.com/' + (String(r.yt_id).startsWith('list:') ? 'playlist?list=' + esc(r.yt_id.slice(5)) : 'watch?v=' + esc(r.yt_id)) + '" target=_blank rel="noopener noreferrer">' + esc(r.title) + '</a>' : esc(r.title)) + ' <span class=muted>' + (r.year ? r.year + ' · ' : '') + (r.kind === 'tv' ? 'show' : r.kind === 'youtube' ? 'YouTube' : 'movie') + '</span></div><div class=meta><span class="status ' + (r.status === 'available' ? 'completed' : r.status === 'declined' ? 'failed' : 'running') + '">' + esc(r.label) + '</span>' + (r.torrent_name ? '<span>' + esc(r.torrent_name) + '</span>' : '') + '</div><div style="font-size:13px">' + who + '</div>' + (r.reply ? '<div class=muted style="font-size:13px;margin-top:4px">' + esc(r.reply) + '</div>' : '') + '<div class=rout></div></div><div class=acts>' + acts + '</div></div>';
    }).join('');
  } catch (e) { $('#reqs').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; $('#requests-wrap').hidden = false; }
}
$('#reqs').addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-rq]'); if (!b) return;
  const card = b.closest('.rq'), action = b.dataset.rq;
  if (action === 'asshow') { $('#yturl').value = 'https://www.youtube.com/playlist?list=' + card.dataset.yt.slice(5); document.getElementById('youtube').scrollIntoView({ behavior: 'smooth' }); previewList($('#yturl').value); return; }
  let reply = null;
  if (action === 'decline') { reply = prompt('Decline. A short reason for them? (optional)'); if (reply === null) return; }
  if (action === 'manual') { reply = prompt('Approve: you’ll find it yourself on the Find tab. A note for them? (optional)', ''); if (reply === null) return; }
  b.disabled = true; const t = b.textContent; b.textContent = action === 'auto' ? 'Finding…' : '…';
  try { const r = await api('requests/decide', { kind: card.dataset.kind, tmdb_id: Number(card.dataset.tmdb), yt_id: card.dataset.yt, action, reply }); if (card.dataset.kind === 'youtube') loadYoutube(); if (r.name) card.querySelector('.rout').innerHTML = '<div class=good style="font-size:13px">Sent to the box: ' + esc(r.name) + '</div>'; }
  catch (e) { card.querySelector('.rout').innerHTML = '<div class=bad style="font-size:13px">' + esc(e.message) + ' You can find it on the Find tab and then press Approve.</div>'; b.textContent = t; b.disabled = false; return; }
  setTimeout(loadRequests, 600);
});

// ---------- YouTube (Pipeline tab) ----------
let ytTimer;
async function loadYoutube() {
  clearTimeout(ytTimer);
  try {
    const d = await api('youtube');
    $('#ytbox').textContent = d.box.error ? 'Download box: ' + d.box.error : 'Download box: ' + d.box.free_gb + ' GB free' + (d.box.ytdlp ? ' · yt-dlp checked ' + d.box.ytdlp.replace(/T.*? /, ' ') : '');
    const active = d.jobs.filter(j => !['added', 'failed'].includes(j.status));
    $('#yt-n').textContent = active.length || '';
    $('#ytjobs').innerHTML = d.jobs.map(j => {
      const cls = j.status === 'added' ? 'completed' : j.status === 'failed' ? 'failed' : 'running';
      const acts = (['waiting', 'queued', 'downloading', 'processing'].includes(j.status) ? '<button class=quiet data-yt=cancel>Cancel</button>' : '') +
        (j.status === 'failed' ? '<button data-yt=retry>Retry</button>' : '') + (j.item ? '<a class=btn-ghost href="/admin/watch/' + j.item + '">Watch</a>' : '') +
        (['added', 'failed'].includes(j.status) ? '<button class=quiet data-yt=forget title="Remove from this list (the video stays in the library)">✕</button>' : '');
      return '<div class="card rq ytj" data-id="' + esc(j.id) + '"><img alt="" referrerpolicy=no-referrer src="' + esc(j.thumb) + '"><div><div class=name><a href="https://www.youtube.com/watch?v=' + esc(j.id) + '" target=_blank rel="noopener noreferrer">' + esc(j.title || j.id) + '</a></div>' +
        '<div class=meta><span class="status ' + cls + '">' + esc(j.label) + '</span>' + (j.dest === 'tv' ? '<span>' + esc(j.show || '') + ' ' + esc(j.episode || '') + ' (TV)</span>' : j.channel ? '<span>' + esc(j.channel) + '</span>' : '') + '<span>' + (j.quality === '2160' ? '4K' : j.quality + 'p') + '</span>' + (j.size ? '<span>' + (j.size / 1e9 >= 1 ? (j.size / 1e9).toFixed(1) + ' GB' : Math.round(j.size / 1e6) + ' MB') + '</span>' : '') + (j.by ? '<span>for ' + esc(j.by) + '</span>' : '') + '<span>' + ago(j.updated_at) + '</span></div>' +
        (j.status === 'downloading' ? '<div class=bar><i style="width:' + Math.round((j.progress || 0) * 100) + '%"></i></div>' : '') + '</div><div class=acts>' + acts + '</div></div>';
    }).join('') || '<p class=hint>Nothing added yet.</p>';
    if (active.length && $('#pipeline').classList.contains('on')) ytTimer = setTimeout(loadYoutube, 4000);
  } catch (e) { $('#ytjobs').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; }
}
let ytList = null;
const mmss = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '';
async function previewList(url) {
  $('#ytpl').innerHTML = '<p class=hint>Reading the playlist…</p>';
  try {
    const d = await api('youtube/playlist?url=' + encodeURIComponent(url)); ytList = d;
    const tv = !!d.series || d.entries.every(e => e.how === 'title');
    $('#ytpl').innerHTML = '<div class=card><div class=pl-head><b>' + esc(d.title || 'Playlist') + '</b><span class=muted>' + d.entries.length + ' videos' + (d.channel ? ' · ' + esc(d.channel) : '') + '</span></div>' +
      '<div class=pl-dest><label><input type=radio name=pld value=youtube' + (tv ? '' : ' checked') + '> YouTube library</label><label><input type=radio name=pld value=tv' + (tv ? ' checked' : '') + '> As episodes of a TV show:</label>' +
      '<input id=plshow value="' + esc(d.show || '') + '" placeholder="Show name, as on TMDB" style="min-width:200px"></div>' +
      '<p class=hint id=plhint style="margin:0">' + (d.series ? 'Matches <b>' + esc(d.series.name) + '</b> in your library (' + d.series.seasons + ' seasons). Episodes you already have become extra versions; the 1080p copy plays by default, and the old ones show up under Manage → several copies so you can delete them.' : 'Saved under media/tvshows/&lt;show&gt;/Season NN/ and matched on TMDB like any episode. Check the season and episode numbers.') + '</p>' +
      '<div class=pl-rows>' + d.entries.map(e => '<label class=pl-row data-id="' + esc(e.id) + '"><input type=checkbox' + (e.in_library ? '' : ' checked') + '><span class=pl-se>S<input type=number class=pls min=0 max=99 value=' + e.season + '>E<input type=number class=ple min=1 max=999 value=' + e.episode + '></span><span>' + esc(e.title) + ' <small>' + mmss(e.duration) + (e.how === 'position' ? ' · number from playlist order' : '') + '</small></span><small>' +
        (e.in_library ? 'in the library' : e.job && !['added', 'failed'].includes(e.job) ? 'queued' : e.existing ? 'have ' + esc(e.existing) : '') + '</small></label>').join('') + '</div>' +
      '<div class=row style="margin-top:10px"><button id=pladd>Add selected</button><button type=button class=quiet id=plclose>Close</button><span id=plmsg></span></div></div>';
    const sync = () => { const tvOn = document.querySelector('input[name=pld]:checked').value === 'tv'; document.querySelectorAll('.pl-se').forEach(x => x.style.visibility = tvOn ? '' : 'hidden'); $('#plshow').disabled = !tvOn; $('#plhint').style.display = tvOn ? '' : 'none'; };
    document.querySelectorAll('input[name=pld]').forEach(r => r.onchange = sync); sync();
    $('#plclose').onclick = () => { $('#ytpl').innerHTML = ''; ytList = null; };
    $('#pladd').onclick = async () => {
      const dest = document.querySelector('input[name=pld]:checked').value;
      const items = [...document.querySelectorAll('.pl-row')].filter(r => r.querySelector('input[type=checkbox]').checked).map(r => ({ id: r.dataset.id, season: Number(r.querySelector('.pls').value), episode: Number(r.querySelector('.ple').value) }));
      $('#pladd').disabled = true;
      try { const r = await api('youtube/add-list', { list: ytList.id, dest, show: $('#plshow').value, quality: $('#ytq').value, items }); $('#ytpl').innerHTML = ''; $('#yturl').value = ''; $('#ytmsg').innerHTML = '<div class=good style="font-size:13px;margin:6px 0">Queued ' + r.added + ' of ' + r.total + ' videos' + (dest === 'tv' ? ' as ' + esc($('#plshow').value) : '') + '.</div>'; loadYoutube(); }
      catch (e) { $('#plmsg').innerHTML = '<span class=bad style="font-size:13px">' + esc(e.message) + '</span>'; $('#pladd').disabled = false; }
    };
  } catch (e) { $('#ytpl').innerHTML = '<div class=note>' + esc(e.message) + '</div>'; }
}
$('#ytf').onsubmit = async ev => {
  ev.preventDefault(); const b = $('#ytf button'); b.disabled = true; $('#ytmsg').innerHTML = '';
  if (/[?&]list=/.test($('#yturl').value) && $('#yturl').value.includes('/playlist')) { await previewList($('#yturl').value); b.disabled = false; return; }
  try { const r = await api('youtube/add', { url: $('#yturl').value, quality: $('#ytq').value }); $('#yturl').value = ''; $('#ytmsg').innerHTML = '<div class=good style="font-size:13px;margin:6px 0">Added: ' + esc(r.title || r.id) + '</div>'; loadYoutube(); }
  catch (e) { $('#ytmsg').innerHTML = '<div class=bad style="font-size:13px;margin:6px 0">' + esc(e.message) + '</div>'; }
  b.disabled = false;
};
$('#ytjobs').addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-yt]'); if (!b) return;
  const id = b.closest('.ytj').dataset.id; b.disabled = true;
  try { await api('youtube/' + b.dataset.yt, { id }); } catch (e) { alert(e.message); }
  loadYoutube();
});

// ---------- Watch (Library tab) ----------
let wt;
async function watchSearch() {
  const q = $('#wq').value.trim();
  if (!q) { $('#wres').innerHTML = ''; return; }
  try {
    const d = await (await fetch('/admin/api/library?q=' + encodeURIComponent(q))).json();
    $('#wres').innerHTML = d.items.map(i => '<a class=pl href="/admin/watch/' + i.id + '"><figure class=poster><div class=art><img loading=lazy alt="" src="/Items/' + i.id + '/Images/Primary?maxWidth=240" onerror="this.remove()"><span>' + esc(i.name) + '</span></div><figcaption>' + esc(i.name) + '<small>' + (i.type === 'Series' ? 'Show' : i.library === 'youtube' ? 'YouTube' : 'Movie') + (i.year ? ' · ' + i.year : '') + '</small></figcaption></figure></a>').join('') || '<p class=hint style="grid-column:1/-1">Nothing matches “' + esc(q) + '”.</p>';
  } catch (e) { $('#wres').innerHTML = '<p class=hint>' + esc(e.message) + '</p>'; }
}
$('#wq').addEventListener('input', () => { clearTimeout(wt); wt = setTimeout(watchSearch, 250); });
$('#qcf').addEventListener('submit', async ev => {
  ev.preventDefault();
  try { const r = await api('quickconnect', { code: $('#qc').value, user: $('#qcu').value }); $('#qcmsg').innerHTML = '<span class=good>' + esc(r.device) + ' is signing in.</span>'; $('#qc').value = ''; }
  catch (e) { $('#qcmsg').innerHTML = '<span class=bad>' + esc(e.message) + '</span>'; }
});
$('#testmail').addEventListener('click', async () => {
  $('#tmmsg').textContent = 'Sending…';
  try { await api('test-email', {}); $('#tmmsg').innerHTML = '<span class=good>Sent to your admin email. Check your inbox (and spam).</span>'; }
  catch (e) { $('#tmmsg').innerHTML = '<span class=bad>' + esc(e.message) + '</span>'; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } });
}
