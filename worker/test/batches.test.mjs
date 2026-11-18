// Downloads bigger than the box (src/batches.mjs): batches of files, sent and removed one batch at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { planBatch, batchTick, batchSent, sizeNote } from '../src/batches.mjs';
import { autoPipeline, kvGet } from '../src/pipeline.mjs';
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
function fakeBox({ free, files }) {
  const box = { free, calls: [], pushes: [], torrent: null };
  const name = 'Show.S01.2160p';
  box.torrent = { hash: H, name, state: 'downloading', progress: 0, total_size: files.reduce((s, f) => s + f.size, 0), content_path: '/home/freebsd/media/temp/' + name };
  box.files = files.map((f, i) => ({ index: i, name: name + '/' + f.name, size: f.size, progress: 0, priority: 1 }));
  const left = () => box.files.reduce((s, f) => s + (f.priority ? f.size * (1 - f.progress) : 0), 0);
  box.finishBatch = () => {   // qBittorrent downloads the selected files and moves the torrent out of temp
    for (const f of box.files) if (f.priority && f.progress < 1) { box.free -= f.size * (1 - f.progress); f.progress = 1; }
    Object.assign(box.torrent, { progress: 1, state: 'stalledUP', content_path: '/home/freebsd/media/' + name });
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const j = v => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
    box.calls.push(u.pathname);
    if (u.pathname === '/api/v2/torrents/info') return j(box.torrent ? [{ ...box.torrent, amount_left: left() }] : []);
    if (u.pathname === '/api/v2/torrents/files') return j(box.files);
    if (u.pathname === '/api/v2/torrents/filePrio') {
      for (const id of body.get('id').split('|')) box.files[Number(id)].priority = Number(body.get('priority'));
      if (box.files.some(f => f.priority && f.progress < 1)) Object.assign(box.torrent, { progress: 0.5, state: 'stoppedDL' });
      return new Response('');
    }
    if (u.pathname === '/api/v2/torrents/stop') { box.torrent.state = box.torrent.progress < 1 ? 'stoppedDL' : 'stoppedUP'; return new Response(''); }
    if (u.pathname === '/api/v2/torrents/start') { box.torrent.state = 'downloading'; return new Response(''); }
    if (u.pathname === '/api/v2/torrents/recheck') return new Response('');
    if (u.pathname === '/api/v2/torrents/delete') { box.torrent = null; return new Response(''); }
    if (u.pathname.startsWith('/api/job/')) return j({ history: { status: 'completed', options: JSON.stringify(box.oldRsync ? ['-r'] : ['-r', '--remove-source-files']) } });
    if (u.pathname === '/api/status') return j({ disk_total: 72 * GB, disk_free: box.free });
    if (u.pathname === '/api/push') {
      const p = JSON.parse(init.body); box.pushes.push(p);
      if (p.remove_source) for (const f of box.files) if (f.priority && f.progress === 1 && !f.gone) { f.gone = true; box.free += f.size; }
      return j({ id: 100 + box.pushes.length });
    }
    return new Response('nope', { status: 404 });
  };
  return box;
}
const inLibrary = (d, box, files) => { for (const f of box.files.filter(f => files.includes(f.index)))
  d.raw.prepare(`INSERT INTO files(id,root,path,library,kind,size,mtime,match_key,match_status,added_at) VALUES (?, ?, ?, 'tv', 'episode', ?, 0, 'k', 'pending', 0)`).run('f' + f.index, cfg().primary.tv, f.name, f.size); };

test('planBatch: partly downloaded first, then in order; small files fill gaps; nothing if the next file is too big', () => {
  const f = [{ name: 'a/E03.mkv', size: 30 * GB }, { name: 'a/E01.mkv', size: 30 * GB }, { name: 'a/E02.mkv', size: 30 * GB, progress: 0.5 }, { name: 'a/info.nfo', size: 1e3 }];
  assert.deepEqual(planBatch(f, [], 50 * GB).chosen, [2, 1, 3]);   // E02 (15 GB left), E01, then the small nfo; E03 waits
  assert.deepEqual(planBatch(f, [1, 2, 3], 50 * GB).chosen, [0]);
  const none = planBatch(f, [1, 2, 3], 20 * GB);
  assert.deepEqual(none.chosen, []); assert.equal(none.largest, 30 * GB);
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
      assert.equal(r.next, 1);
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
  assert.match(rec.note, /80 GB file, 45 GB usable/);
  assert.equal(box.torrent.state, 'stoppedDL');

  const d2 = db();
  box = fakeBox({ free: 50 * GB, files: [{ name: 'a.mkv', size: 10 * GB }, { name: 'b.mkv', size: 10 * GB }] });
  await batchTick(envFor(d2));
  assert.equal(await kvGet(d2, 'batch:' + H), null);
  assert.equal(box.calls.includes('/api/v2/torrents/filePrio'), false);
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
