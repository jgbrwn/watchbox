// Home screen rows apps build from Latest (per library), Resume and NextUp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openLocalDb } from '../tools/local-db.mjs';
import { handleJellyfin } from '../src/jellyfin.mjs';
import { sha256Hex } from '../src/auth.mjs';
import { viewId } from '../src/library/catalog.mjs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const id = n => n.toString(16).padStart(32, '0');

test('Latest and Resume return the newest items, not the oldest, whatever the library size', async () => {
  const d = openLocalDb(':memory:', { migrations: readdirSync(MIG).sort().map(f => MIG + f) });
  const movies = await viewId('movies');
  const ins = d.raw.prepare(`INSERT INTO items(id,type,library,parent_id,name,sort_name,date_created,hash,file_id,age) VALUES (?,'Movie','movies',?,?,?,?,'h',?,0)`);
  for (let n = 1; n <= 450; n++) ins.run(id(n), movies, 'Movie ' + n, 'movie ' + String(n).padStart(3, '0'), 1_700_000_000 + n, id(n));   // Movie 450 is the newest
  const uid = 'f'.repeat(32);
  d.raw.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES (?,'owner','x',0)").run(uid);
  d.raw.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,last_seen) VALUES (?,?,?,0,9999999999,?)').run('s1', uid, await sha256Hex('tok'), Math.floor(Date.now() / 1000));
  for (let n = 1; n <= 30; n++) d.raw.prepare('INSERT INTO progress(user_id,item_id,position_ticks,played,play_count,last_played) VALUES (?,?,?,0,0,?)').run(uid, id(n), 1e9, 1000 + n);   // Movie 30 played last
  const env = { DB: d, SERVER_ID: 'x' };
  const get = async path => (await handleJellyfin(new Request('https://w.example' + path, { headers: { Authorization: 'MediaBrowser Client="VidHub", Device="t", DeviceId="t", Version="1", Token="tok"' } }), env, {})).json();

  // As VidHub asks: no SortOrder, grouped, IsPlayed=false.
  const latest = await get(`/Users/${uid}/Items/Latest?ParentId=${movies}&Recursive=true&MediaTypes=Video&Limit=20&IsPlayed=false`);
  assert.deepEqual(latest.slice(0, 3).map(i => i.Name), ['Movie 450', 'Movie 449', 'Movie 448']);
  assert.equal(latest.length, 20);
  const flat = await get(`/Users/${uid}/Items/Latest?ParentId=${movies}&GroupItems=false&Limit=2`);
  assert.deepEqual(flat.map(i => i.Name), ['Movie 450', 'Movie 449']);

  const resume = await get(`/Users/${uid}/Items/Resume?Recursive=true&MediaTypes=Video&Limit=3`);
  assert.deepEqual(resume.Items.map(i => i.Name), ['Movie 30', 'Movie 29', 'Movie 28']);
});
