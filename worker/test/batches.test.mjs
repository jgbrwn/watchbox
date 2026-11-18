// Downloads bigger than the box (src/batches.mjs): batches of files, sent and removed one batch at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { planBatch, batchTick, batchSent, sizeNote } from '../src/batches.mjs';
import { autoPipeline, kvGet, kvSet, handleQbitHook } from '../src/pipeline.mjs';
import { annotateFind, torrentBytes } from '../src/dupes.mjs';
import { pickTorrent } from '../src/requests.mjs';
import { cfg } from '../src/config.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = () => openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
const GB = 1e9;
const H = 'a'.repeat(40);
const envFor = d => ({ DB: d, TMDB_TOKEN: 't', TOOLS_AUTHORIZATION: 'Basic eDp5',
  TOOLS: { dl: { name: 'qBittorrent', upstream: 'https://dl.box.example' }, rs: { name: 'rsync-web', upstream: 'https://rs.box.example' } } });

// A stand-in download box: qBittorrent's Web API and rsync-web, with a disk that fills and empties.
// torrents: [{ hash, name, files: [{ name, size }], seeding: true (finished, holding its size on disk) }]
function fakeBox({ free, files, torrents }) {
  const box = { free, calls: [], pushes: [], ts: new Map() };
  box.add = spec => {
    const name = spec.name;
    const t = { hash: spec.hash, name, state: spec.seeding ? 'stalledUP' : 'downloading', progress: spec.seeding ? 1 : 0,
      total_size: spec.files.reduce((s, f) => s + f.size, 0), content_path: '/home/freebsd/media/' + (spec.seeding ? '' : 'temp/') + name };
    const fs = spec.files.map((f, i) => ({ index: i, name: name + '/' + f.name, size: f.size, progress: spec.seeding ? 1 : 0, priority: 1 }));
    box.ts.set(spec.hash, { t, files: fs });
    if (!spec.seeding) box.free -= 0;   // nothing written yet
  };
  for (const spec of torrents || [{ hash: H, name: 'Show.S01.2160p', files }]) box.add(spec);
  Object.defineProperty(box, 'torrent', { get: () => box.ts.get(H)?.t || null });
  Object.defineProperty(box, 'files', { get: () => box.ts.get(H)?.files || [] });
  const left = e => e.files.reduce((s, f) => s + (f.priority ? f.size * (1 - f.progress) : 0), 0);
  const completed = e => e.files.reduce((s, f) => s + (f.priority && !f.gone ? f.size * f.progress : 0), 0);
  box.finishBatch = (hash = H) => {   // qBittorrent downloads the selected files and moves the torrent out of temp
    const e = box.ts.get(hash);
    for (const f of e.files) if (f.priority && f.progress < 1) { box.free -= f.size * (1 - f.progress); f.progress = 1; }
    Object.assign(e.t, { progress: 1, state: 'stalledUP', content_path: '/home/freebsd/media/' + e.t.name });
  };
  box.state = hash => box.ts.get(hash).t.state;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const j = v => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
    const e = box.ts.get(u.searchParams.get('hash') || body.get('hash') || body.get('hashes'));
    box.calls.push(u.pathname);
    if (u.pathname === '/api/v2/torrents/info') return j([...box.ts.values()].map(e => ({ ...e.t, amount_left: left(e), completed: completed(e) })));
    if (u.pathname === '/api/v2/torrents/files') return j(e.files);
    if (u.pathname === '/api/v2/torrents/filePrio') {
      for (const id of body.get('id').split('|')) e.files[Number(id)].priority = Number(body.get('priority'));
      if (e.files.some(f => f.priority && f.progress < 1)) Object.assign(e.t, { progress: 0.5, state: 'stoppedDL' });
      return new Response('');
    }
    if (u.pathname === '/api/v2/torrents/stop') { e.t.state = e.t.progress < 1 ? 'stoppedDL' : 'stoppedUP'; return new Response(''); }
    if (u.pathname === '/api/v2/torrents/start') { e.t.state = 'downloading'; return new Response(''); }
    if (u.pathname === '/api/v2/torrents/recheck') return new Response('');
    if (u.pathname === '/api/v2/torrents/delete') {
      for (const h of body.get('hashes').split('|')) { const e = box.ts.get(h); if (e) box.free += completed(e); box.ts.delete(h); }
      return new Response('');
    }
    if (u.pathname.startsWith('/api/job/')) return j({ history: { status: 'completed', options: JSON.stringify(box.oldRsync ? ['-r'] : ['-r', '--remove-source-files']) } });
    if (u.pathname === '/api/status') return j({ disk_total: 72 * GB, disk_free: box.free });
    if (u.pathname === '/api/push') {
      const p = JSON.parse(init.body); box.pushes.push(p);
      const e = [...box.ts.values()].find(e => e.t.name === p.name);
      if (p.remove_source && e) for (const f of e.files) if (f.priority && f.progress === 1 && !f.gone) { f.gone = true; box.free += f.size; }
      return j({ id: 100 + box.pushes.length });
    }
    return new Response('nope', { status: 404 });
  };
  return box;
}
const inLibrary = (d, box, files) => { for (const f of box.files.filter(f => files.includes(f.index)))
  d.raw.prepare(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,added_at) VALUES (?, ?, ?, 'tv', 'episode', ?, 0, 'k', 'pending', 0)`).run('f' + f.index, cfg().primary.tv, f.name, f.size); };

test('planBatch: partly downloaded first, then in order; files that don’t fit are skipped for now', () => {
  const f = [{ name: 'a/E03.mkv', size: 30 * GB }, { name: 'a/E01.mkv', size: 30 * GB }, { name: 'a/E02.mkv', size: 30 * GB, progress: 0.5 }, { name: 'a/info.nfo', size: 1e3 }];
  assert.deepEqual(planBatch(f, [], 50 * GB).chosen, [2, 1, 3]);   // E02 (15 GB left), E01, then the small nfo; E03 waits
  assert.deepEqual(planBatch(f, [1, 2, 3], 50 * GB).chosen, [0]);
  const none = planBatch(f, [1, 2, 3], 20 * GB);
  assert.deepEqual(none.chosen, []); assert.equal(none.largest, 30 * GB);
  const mixed = planBatch([{ name: 'E01.mkv', size: 10 * GB }, { name: 'E02.mkv', size: 60 * GB }, { name: 'E03.mkv', size: 10 * GB }], [], 45 * GB);
  assert.deepEqual(mixed.chosen, [0, 2]);
  assert.deepEqual(mixed.oversize, [{ name: 'E02.mkv', size: 60 * GB }]);
});

test('a pack with one file bigger than the free space: the rest is sent, that one waits until space frees up', async () => {
  const d = db(), env = envFor(d);
  const box = fakeBox({ free: 50 * GB, files: [{ name: 'E01.mkv', size: 20 * GB }, { name: 'E02.mkv', size: 60 * GB }, { name: 'E03.mkv', size: 20 * GB }] });
  await batchTick(env);
  let rec = await kvGet(d, 'batch:' + H);
  assert.deepEqual(rec.current, [0, 2]);
  assert.match(rec.note, /E02\.mkv \(60 GB\) is bigger than the free space: left for last/);
  box.finishBatch(); await batchTick(env);
  rec = await kvGet(d, 'batch:' + H);
  inLibrary(d, box, rec.current);
  await batchSent(env, await kvGet(d, 'push:' + rec.job), 'completed');
  assert.equal((await kvGet(d, 'batch:' + H)).step, 'next');
  await batchTick(env);
  rec = await kvGet(d, 'batch:' + H);
  assert.equal(rec.step, 'too_big');
  assert.match(rec.note, /^Everything else is sent\. E02\.mkv \(60 GB\) doesn’t fit, even once other downloads leave the box \(45 GB\)/);
  assert.match(box.torrent.state, /^stopped/);
  const calls = box.calls.length;
  await batchTick(env);                                            // no more room: not even looked at
  assert.equal(box.calls.filter(c => c === '/api/v2/torrents/files').length, box.calls.slice(0, calls).filter(c => c === '/api/v2/torrents/files').length);
  box.free += 30 * GB;                                             // something else was removed from the box
  await batchTick(env);
  rec = await kvGet(d, 'batch:' + H);
  assert.equal(rec.step, 'downloading');
  assert.deepEqual(rec.current, [1]);
  assert.equal(box.torrent.state, 'downloading');
});

test('a 90 GB pack on a box with 50 GB free: three parts, each sent and removed, then the torrent is removed', async () => {
  const d = db(), env = envFor(d);
  const ep = n => ({ name: `Show.S01E0${n}.mkv`, size: 30 * GB });
  const box = fakeBox({ free: 50 * GB, files: [ep(1), ep(2), ep(3), { name: 'Show.nfo', size: 2e3 }] });

  await batchTick(env);
  let rec = await kvGet(d, 'batch:' + H);
  assert.equal(rec.step, 'downloading');
  assert.deepEqual([...rec.current].sort(), [0, 3]);                        // one episode fits (45 GB usable), plus the nfo
  assert.deepEqual(box.files.map(f => f.priority), [1, 0, 0, 1]);
  assert.equal(box.calls.includes('/api/v2/torrents/recheck'), false);

  for (let part = 1; part <= 3; part++) {
    box.finishBatch();
    // Finished downloads of batched torrents are left to the batches, not sent whole by auto-send.
    assert.deepEqual((await autoPipeline(env)).started, []);
    await batchTick(env);
    rec = await kvGet(d, 'batch:' + H);
    assert.equal(rec.step, 'sending');
    assert.equal(box.pushes.at(-1).remove_source, true);
    assert.equal(box.pushes.at(-1).preset, 'TV');
    const push = await kvGet(d, 'push:' + rec.job);
    assert.equal(push.batch, H);
    inLibrary(d, box, rec.current);
    const r = await batchSent(env, push, 'completed');
    rec = await kvGet(d, 'batch:' + H);
    if (part < 3) {
      assert.equal(r.next, true);
      assert.equal(rec.step, 'next');                              // the minute check starts the next part
      await batchTick(env);
      rec = await kvGet(d, 'batch:' + H);
      assert.equal(rec.step, 'downloading');
      assert.equal(box.files[part].priority, 1);
      assert.equal(box.files[part - 1].priority, 0);
      assert.equal(box.calls.filter(c => c === '/api/v2/torrents/recheck').length, part);
    } else {
      assert.equal(r.done, true);
      assert.equal(rec.step, 'done');
      assert.equal(box.torrent, null);
    }
  }
  assert.equal(box.free, 50 * GB);
});

test('a copy that isn’t in the library stops the batches; a failed copy is retried', async () => {
  const d = db(), env = envFor(d);
  const box = fakeBox({ free: 50 * GB, files: [{ name: 'E01.mkv', size: 30 * GB }, { name: 'E02.mkv', size: 30 * GB }] });
  await batchTick(env); box.finishBatch(); await batchTick(env);
  let rec = await kvGet(d, 'batch:' + H);
  const push = await kvGet(d, 'push:' + rec.job);
  assert.deepEqual(await batchSent(env, push, 'failed'), { retry: true });
  await batchTick(env);                                            // sent again
  assert.equal(box.pushes.length, 2);
  const r = await batchSent(env, await kvGet(d, 'push:' + (await kvGet(d, 'batch:' + H)).job), 'completed');
  assert.match(r.error, /isn’t in the library/);
  assert.equal((await kvGet(d, 'batch:' + H)).step, 'error');
});

test('an rsync-web that can’t remove sent files stops the batches with a clear error', async () => {
  const d = db(), env = envFor(d);
  const box = fakeBox({ free: 50 * GB, files: [{ name: 'E01.mkv', size: 30 * GB }, { name: 'E02.mkv', size: 30 * GB }] });
  box.oldRsync = true;
  await batchTick(env); box.finishBatch(); await batchTick(env);
  const r = await batchSent(env, await kvGet(d, 'push:' + (await kvGet(d, 'batch:' + H)).job), 'completed');
  assert.match(r.error, /too old/);
});

test('one file bigger than the free space: the torrent is stopped as too big; torrents that fit are left alone', async () => {
  const d = db(), env = envFor(d);
  let box = fakeBox({ free: 50 * GB, files: [{ name: 'Movie.2160p.mkv', size: 80 * GB }] });
  await batchTick(env);
  const rec = await kvGet(d, 'batch:' + H);
  assert.equal(rec.step, 'too_big');
  assert.match(rec.note, /Too big for the box: Movie\.2160p\.mkv \(80 GB\), 45 GB at most once other downloads leave/);
  assert.equal(box.torrent.state, 'stoppedDL');

  const d2 = db();
  box = fakeBox({ free: 50 * GB, files: [{ name: 'a.mkv', size: 10 * GB }, { name: 'b.mkv', size: 10 * GB }] });
  await batchTick(envFor(d2));
  assert.equal(await kvGet(d2, 'batch:' + H), null);
  assert.equal(box.calls.includes('/api/v2/torrents/filePrio'), false);
});

test('the queue: two packs never count on the same space, and they take turns', async () => {
  const d = db(), env = envFor(d);
  const A = 'b'.repeat(40), B = 'c'.repeat(40);
  const pack = (hash, name) => ({ hash, name, files: [{ name: 'E01.mkv', size: 30 * GB }, { name: 'E02.mkv', size: 30 * GB }] });
  const box = fakeBox({ free: 50 * GB, torrents: [pack(A, 'A.S01'), pack(B, 'B.S01')] });
  await batchTick(env);
  const step = async h => (await kvGet(d, 'batch:' + h)).step;
  // 45 GB usable: one 30 GB part, not two.
  assert.deepEqual([await step(A), await step(B)].sort(), ['downloading', 'waiting']);
  const first = (await step(A)) === 'downloading' ? A : B, second = first === A ? B : A;
  assert.match((await kvGet(d, 'batch:' + second)).note, /Waiting for other downloads to leave the box: next file 30 GB/);
  // The first sends its part; the one that waited goes next, the first waits its turn.
  box.finishBatch(first); await batchTick(env);
  const rec = await kvGet(d, 'batch:' + first);
  inLibrary(d, box, []);
  d.raw.prepare(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,added_at) VALUES ('x', ?, ?, 'tv', 'episode', ?, 0, 'k', 'pending', 0)`)
    .run(cfg().primary.tv, box.ts.get(first).files[rec.current[0]].name, 30 * GB);
  await batchSent(env, await kvGet(d, 'push:' + rec.job), 'completed');
  await batchTick(env);
  assert.equal(await step(second), 'downloading');
  assert.equal(await step(first), 'waiting');
});

test('the queue: the oldest waiting torrent goes first once it has waited long enough', async () => {
  const d = db(), env = envFor(d);
  const A = 'b'.repeat(40), B = 'c'.repeat(40), S = 'd'.repeat(40);
  // A seeding download holds 30 GB; 30 GB usable. A needs a 40 GB file: it fits once the seeding one leaves.
  const box = fakeBox({ free: 35 * GB, torrents: [{ hash: S, name: 'Seeding', seeding: true, files: [{ name: 'm.mkv', size: 30 * GB }] },
    { hash: A, name: 'A.S01', files: [{ name: 'E01.mkv', size: 40 * GB }, { name: 'E02.mkv', size: 40 * GB }] }] });
  await batchTick(env);
  let a = await kvGet(d, 'batch:' + A);
  assert.equal(a.step, 'waiting');
  const pack20 = { hash: B, name: 'B.S01', files: [{ name: 'E01.mkv', size: 20 * GB }, { name: 'E02.mkv', size: 20 * GB }] };
  // Not waited long: a smaller part may go ahead.
  box.add(pack20);
  await batchTick(env);
  assert.equal((await kvGet(d, 'batch:' + B)).step, 'downloading');
  // Start over with A at the head of the queue for 13 hours: B is held behind it.
  const d2 = db(), env2 = envFor(d2);
  const box2 = fakeBox({ free: 35 * GB, torrents: [{ hash: S, name: 'Seeding', seeding: true, files: [{ name: 'm.mkv', size: 30 * GB }] },
    { hash: A, name: 'A.S01', files: [{ name: 'E01.mkv', size: 40 * GB }, { name: 'E02.mkv', size: 40 * GB }] }] });
  await batchTick(env2);
  a = await kvGet(d2, 'batch:' + A);
  a.queued_at -= 13 * 3600;
  d2.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(a), 'batch:' + A);
  box2.add(pack20);
  await batchTick(env2);
  let b = await kvGet(d2, 'batch:' + B);
  assert.equal(b.step, 'waiting');
  assert.match(b.note, /Queued behind A\.S01/);
  assert.match(box2.state(B), /^stopped/);
  // The seeding download is removed (60 GB usable): A gets its 40 GB first, then B its 20 GB from what's left.
  box2.ts.delete(S); box2.free += 30 * GB;
  await batchTick(env2);
  assert.equal((await kvGet(d2, 'batch:' + A)).step, 'downloading');
  b = await kvGet(d2, 'batch:' + B);
  assert.equal(b.step, 'downloading');
  assert.deepEqual(b.current.length, 1);
});

test('several downloads that each fit but not together: the biggest waits, the rest go on', async () => {
  const d = db(), env = envFor(d);
  const hs = ['e', 'f', 'g'].map(c => c.repeat(40));
  const box = fakeBox({ free: 50 * GB, torrents: hs.map((h, i) => ({ hash: h, name: 'Movie' + i, files: [{ name: 'm.mkv', size: (20 + i) * GB }] })) });
  await batchTick(env);
  const steps = await Promise.all(hs.map(async h => (await kvGet(d, 'batch:' + h))?.step || null));
  assert.deepEqual(steps, [null, null, 'waiting']);                // 20 + 21 fit in 45 GB; the 22 GB one waits
  assert.match(box.state(hs[2]), /^stopped/);
  assert.equal(box.state(hs[0]), 'downloading');
});

test('a download held up past 12 hours ends seeding early for finished downloads already in the library', async () => {
  const d = db(), env = envFor(d);
  const A = 'b'.repeat(40), S1 = 'd'.repeat(40), S2 = 'e'.repeat(40);
  const seed = (hash, name) => ({ hash, name, seeding: true, files: [{ name: 'm.mkv', size: 20 * GB }] });
  const box = fakeBox({ free: 25 * GB, torrents: [seed(S1, 'Old'), seed(S2, 'NotInLibrary'),
    { hash: A, name: 'A.S01', files: [{ name: 'E01.mkv', size: 35 * GB }, { name: 'E02.mkv', size: 35 * GB }] }] });
  box.ts.get(S1).t.ratio = 0.4; box.ts.get(S2).t.ratio = 0.9;
  // Both finished downloads were sent and are seeding before removal; only Old is (verified) in the library.
  await kvSet(d, 'push:1', { job: 1, name: 'Old', kind: 'movie', hash: S1, at: 0, finished: 1, cleanup: { waiting: true } });
  await kvSet(d, 'push:2', { job: 2, name: 'NotInLibrary', kind: 'movie', hash: S2, at: 0, finished: 1, cleanup: { waiting: true } });
  d.raw.prepare(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,added_at) VALUES ('o', ?, 'Old/m.mkv', 'movies', 'movie', ?, 0, 'k', 'pending', 0)`).run(cfg().primary.movies, 20 * GB);
  await batchTick(env);
  let a = await kvGet(d, 'batch:' + A);
  assert.equal(a.step, 'waiting');                                  // 20 GB usable, needs 35: waits; nothing ended yet
  assert.equal(box.ts.has(S1), true);
  a.queued_at -= 13 * 3600;
  d.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(a), 'batch:' + A);
  await batchTick(env);
  assert.equal(box.ts.has(S1), false);                               // ended early (freed 20 GB: enough)
  assert.equal(box.ts.has(S2), true);                                // never one that isn't safely in the library
  const p1 = await kvGet(d, 'push:1');
  assert.equal(p1.cleanup.early, true);
  await batchTick(env);
  assert.equal((await kvGet(d, 'batch:' + A)).step, 'downloading');
});

test('qBittorrent "added" hook checks the space at once; "finished" also runs auto-send', async () => {
  const d = db();
  const env = { ...envFor(d), RSYNC_WEBHOOK_SECRET: 'hook-secret' };
  const box = fakeBox({ free: 50 * GB, files: [{ name: 'Movie.mkv', size: 80 * GB }] });
  const post = async event => {
    const body = JSON.stringify({ hash: H, event, at: 1 });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('hook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
    const waits = [];
    const r = await handleQbitHook(new Request('https://w/hooks/qbit', { method: 'POST', body, headers: { 'X-Watch-Signature': 'sha256=' + sig } }), env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return r.status;
  };
  assert.equal(await post('added'), 200);
  assert.equal((await kvGet(d, 'batch:' + H)).step, 'too_big');
  assert.equal(box.calls.filter(c => c === '/api/v2/torrents/info').length, 1);   // batches only, no auto-send pass
  await post('finished');
  assert.ok(box.calls.filter(c => c === '/api/v2/torrents/info').length > 2);
});

test('Find: torrents bigger than the free space get a box_note; requests pick a release that fits', async () => {
  const d = db(), env = envFor(d);
  fakeBox({ free: 50 * GB, files: [{ name: 'x.mkv', size: 1 }] });
  assert.equal(torrentBytes({ size: '1.95 GB' }), 1.95 * GB);
  assert.equal(torrentBytes({ size_bytes: 123 }), 123);
  assert.equal(sizeNote(40 * GB, 50 * GB), null);
  const movie = await annotateFind(env, '/api/movie/1', { torrents: [{ size: '2.1 GB' }, { size: '62 GB' }] });
  assert.equal(movie.torrents[0].box_note, undefined);
  assert.match(movie.torrents[1].box_note, /45 GB usable/);
  const csv = await annotateFind(env, '/api/search?q=x&source=torrents-csv', { results: [{ title: 'Pack', size_bytes: 98 * GB }, { title: 'Small', size_bytes: GB }] });
  assert.deepEqual(csv.results.map(r => !!r.box_note), [true, false]);

  const m = ts => [{ imdb_code: 'tt1', torrents: ts }];
  const ts = [{ hash: 'big', quality: '1080p', type: 'bluray', size: '30 GB', seeds: 9 }, { hash: 'small', quality: '720p', size: '1.2 GB', seeds: 5 }];
  assert.equal(pickTorrent(m(ts), 'tt1').torrent.hash, 'big');
  assert.equal(pickTorrent(m(ts), 'tt1', 10 * GB).torrent.hash, 'small');
  assert.equal(pickTorrent(m(ts), 'tt1', 1 * GB).fits, false);
});
