import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MediaStore } from '../lib/media.js';
import { JsonlLog, JsonStore, safeName } from '../lib/storage.js';

const DAY = 86_400_000;
const START = new Date(2025, 0, 2, 12).getTime();
const LINK = 'up:media-index';
const image = (bytes, name = 'photo.png') => ({ type: 'image', data: { file: `base64://${bytes.toString('base64')}`, name } });
const reuse = (id) => ({ type: 'image', data: { file: id } });
const bytes = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, n]);
const owners = (store, id) => store.ownersOf(id).sessionKeys;
const deferred = () => Promise.withResolvers();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: START };
  const storage = new JsonStore({ dir });
  const log = new JsonlLog({ dir: path.join(dir, 'media') });
  const logDir = path.join(log.dir, safeName(LINK));
  return {
    clock,
    make: (linkId = LINK) => new MediaStore({ storage, linkId, now: () => clock.at }),
    dayFile: (at) => log.fileFor(LINK, at),
    append: (row, at) => assert.equal(log.append(LINK, row, at), true),
    rows: () => fs.readdirSync(logDir).sort().flatMap((file) => fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n').map(JSON.parse)),
  };
}

function setOld(blob) {
  fs.utimesSync(blob, new Date(START), new Date(START));
}

test('unreadable history does not block fresh writes, but fails closed for reads and cleanup', async (t) => {
  const { clock, make, dayFile } = fixture(t);
  const seed = make();
  const first = await seed.saveBytes(bytes(1), { sessionKey: 'private:1' });
  clock.at += DAY;
  const legacy = await seed.saveBytes(bytes(2), { sessionKey: 'private:2' });
  const store = make();
  const readFile = fs.promises.readFile;
  let attempts = 0;
  fs.promises.readFile = async (file, ...args) => {
    if (String(file) === dayFile(START + DAY)) {
      attempts += 1;
      throw Object.assign(new Error('legacy media EIO'), { code: 'EIO' });
    }
    return readFile(file, ...args);
  };
  try {
    await assert.rejects(store.ensureIndex(), /legacy media EIO/);
    assert.equal(store.find(first.id), null, 'do not publish a partial history on failure');
    const fresh = await store.resolve(image(bytes(3)), { sessionKey: 'group:3' });
    const generated = await store.saveBytes(bytes(4), { sessionKey: 'group:4' });
    assert.equal(attempts, 1, 'neither fresh path reads (or retries reading) old history');
    assert.equal(fresh.error, null);
    assert.deepEqual(fs.readFileSync(fresh.blob), bytes(3));
    assert.deepEqual(fs.readFileSync(generated.blob), bytes(4));
    const denied = await store.resolve(reuse(fresh.id), { sessionKey: 'group:3' });
    assert.equal(denied.id, null);
    assert.match(denied.error, /索引加载失败.*EIO/);
    assert.equal(denied.blob, undefined);
    assert.match((await store.readRef(fresh.id)).error, /索引加载失败.*EIO/);
    assert.match((await store.purgeScope('private:2')).error, /索引加载失败.*EIO/);
    assert.match((await store.prune({ days: 1 })).error, /索引加载失败.*EIO/);
    assert.ok(fs.existsSync(legacy.blob));
  } finally { fs.promises.readFile = readFile; }
  assert.equal(await store.ensureIndex(), 4);
  assert.deepEqual(owners(store, first.id), ['private:1']);
  assert.deepEqual(owners(store, legacy.id), ['private:2']);
});

test('index append failure does not publish a new owner or claim durability', async (t) => {
  const { make } = fixture(t);
  const store = make();
  const saved = await store.saveBytes(bytes(12), { sessionKey: 'private:12' });
  const append = fs.appendFileSync;
  fs.appendFileSync = () => { throw Object.assign(new Error('index EIO'), { code: 'EIO' }); };
  try {
    const failed = await store.resolve(image(bytes(12)), { sessionKey: 'group:12' });
    assert.equal(failed.id, null);
    assert.match(failed.error, /媒体索引写入失败/);
    await assert.rejects(store.saveBytes(bytes(13), { sessionKey: 'group:13' }), /媒体索引写入失败/);
    assert.deepEqual(owners(store, saved.id), ['private:12']);
  } finally { fs.appendFileSync = append; }
  const restart = make();
  assert.equal(await restart.ensureIndex(), 1);
  assert.deepEqual(owners(restart, saved.id), ['private:12']);
});

test('hydration atomically merges reads and writes, including omitted and already-read puts', async (t) => {
  const { clock, make, dayFile, append } = fixture(t);
  const seed = make();
  const same = await seed.saveBytes(bytes(5), { sessionKey: 'private:5', name: 'legacy-first.png' });
  const old = await seed.saveBytes(bytes(6), { sessionKey: 'private:6' });
  // Emulate a beta.4 full snapshot, followed by a detach and a full drop.
  append({ ...same, sessionKeys: ['private:5', 'group:7'], occurrences: [{ sessionKey: 'group:7', at: START, name: 'legacy-kept.png' }] }, START);
  append({ op: 'detach', id: same.id, sessionKey: 'private:5' }, START + DAY);
  append({ op: 'drop', ids: [old.id] }, START + DAY);
  const store = make();
  const readFile = fs.promises.readFile;
  const entered = deferred();
  const unblock = deferred();
  let reads = 0;
  fs.promises.readFile = async (file, ...args) => {
    const contents = await readFile(file, ...args);
    if (!String(file).endsWith('.jsonl')) return contents;
    reads += 1;
    if (String(file) === dayFile(START)) {
      entered.resolve();
      await unblock.promise;
    }
    return contents;
  };
  try {
    const pending = store.ensureIndex();
    const sameLoad = store.ensureIndex();
    await entered.promise;
    await store.saveBytes(bytes(5), { name: 'missed-append.png', sessionKey: 'group:8' });
    clock.at += DAY;
    await store.resolve(image(bytes(5), 'included-append.png'), { sessionKey: 'group:9', messageId: 'seen' });
    clock.at += DAY;
    await store.resolve(image(bytes(5), 'unlisted-day.png'), { sessionKey: 'group:9', messageId: 'latest' });
    assert.deepEqual(owners(store, same.id), ['group:8', 'group:9'], 'legacy state is not published before completion');
    const purge = store.purgeScope('group:8');
    unblock.resolve();
    assert.deepEqual(await Promise.all([pending, sameLoad]), [1, 1]);
    assert.equal((await purge).shared, 1);
    assert.equal(reads, 2, 'one shared traversal; new day was not in its listing');
    assert.equal(store.find(old.id), null);
    assert.deepEqual(owners(store, same.id), ['group:7', 'group:9']);
    const shown = await store.resolve(reuse(same.id), { sessionKey: 'group:9', allow: () => true });
    assert.equal(shown.messageId, 'latest');
    const inaccessible = await store.resolve(reuse(same.id), { sessionKey: 'private:5' });
    assert.equal(inaccessible.id, null);
  } finally {
    unblock.resolve();
    fs.promises.readFile = readFile;
  }
  const restart = make();
  assert.equal(await restart.ensureIndex(), 1);
  assert.deepEqual(owners(restart, same.id), ['group:7', 'group:9']);
  assert.equal((await restart.resolve(reuse(same.id), { sessionKey: 'group:9' })).name, 'unlisted-day.png');
});

test('one bounded occurrence per write, while all hot SHA owners survive replay', async (t) => {
  const { make, rows } = fixture(t);
  const store = make();
  store.attach({ saveImage: async () => ({ id: 'attachment', data: 'not-in-index'.repeat(100_000) }) });
  let id;
  for (let i = 1; i <= 180; i += 1) {
    const ref = await store.saveBytes(bytes(7), { kind: 'image', name: `scope-${i}.png`, sessionKey: `group:${i}` });
    id ??= ref.id;
    assert.equal(ref.id, id);
  }
  const records = rows();
  assert.equal(records.length, 180);
  assert.ok(records.every((r) => r.op === 'put' && r.sessionKey && !r.sessionKeys && !r.occurrences && !r.attachment));
  assert.ok(Buffer.byteLength(JSON.stringify(records)) < 120_000, 'index grows linearly, without previous scopes or attachment payloads');
  const restart = make();
  await restart.ensureIndex();
  assert.equal(owners(restart, id).length, 180);
  assert.equal(restart.ownersOf(id).occurrences.length, 20);
  assert.equal((await restart.resolve(reuse(id), { sessionKey: 'group:1', allow: () => true })).name, null, 'evicted metadata does not borrow another scope’s name');
  assert.equal((await restart.resolve(reuse(id), { sessionKey: 'group:180' })).name, 'scope-180.png');
  assert.equal((await restart.purgeScope('group:1')).shared, 1, 'evicting metadata does not evict ownership');
  const again = make();
  await again.ensureIndex();
  assert.equal(owners(again, id).length, 179);
  assert.ok(!owners(again, id).includes('group:1'));
});

test('retention keeps recent actual ownership, drops aged/missing refs durably, and reports marker failures', async (t) => {
  const { make, clock, rows } = fixture(t);
  const first = make();
  const shared = await first.resolve(image(bytes(8), 'old-private.png'), { sessionKey: 'private:8' });
  await first.saveBytes(bytes(8), { sessionKey: 'group:8', kind: 'image', name: 'old-group.png' });
  const old = await first.saveBytes(bytes(9), { sessionKey: 'group:9' });
  const missing = await first.saveBytes(bytes(10), { sessionKey: 'group:10' });
  fs.rmSync(missing.blob);
  clock.at += 9 * DAY;
  const store = make();
  await store.resolve(image(bytes(8), 'new-group.png'), { sessionKey: 'group:8' });
  setOld(shared.blob);
  setOld(old.blob);
  // Authorized reuse can read, but may not refresh lifetime or transfer ownership.
  assert.ok((await store.resolve(reuse(shared.id), { sessionKey: 'private:8' })).blob);
  const appendFileSync = fs.appendFileSync;
  fs.appendFileSync = () => { throw Object.assign(new Error('marker EIO'), { code: 'EIO' }); };
  try {
    const failed = await store.prune({ days: 7 });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /标记写入失败/);
    assert.equal(failed.removed, 0);
    assert.ok(fs.existsSync(old.blob), 'an index commit failure may not delete its blob');
  } finally { fs.appendFileSync = appendFileSync; }
  const pruned = await store.prune({ days: 7, chunk: 1 });
  assert.deepEqual([pruned.ok, pruned.dropped, pruned.detached, pruned.removed], [true, 2, 1, 1]);
  assert.ok(fs.existsSync(shared.blob), 'old file mtime cannot delete fresh ownership');
  assert.equal(fs.existsSync(old.blob), false);
  assert.ok(rows().some((r) => r.op === 'drop' && r.ids.includes(old.id)));
  const restart = make();
  await restart.ensureIndex();
  assert.equal(restart.find(old.id), null);
  assert.equal(restart.find(missing.id), null);
  assert.deepEqual(owners(restart, shared.id), ['group:8']);
  assert.equal((await restart.resolve(reuse(shared.id), { sessionKey: 'group:8' })).name, 'new-group.png');
  assert.equal((await restart.resolve(reuse(shared.id), { sessionKey: 'private:8' })).id, null);
});

test('genuine use refreshes a shared blob across links, even during another link’s orphan sweep', async (t) => {
  const { make, clock } = fixture(t);
  const oldLink = make();
  const old = await oldLink.saveBytes(bytes(14), { sessionKey: 'private:14' });
  setOld(old.blob);
  clock.at += 9 * DAY;
  await oldLink.resolve(reuse(old.id), { sessionKey: 'private:14' });
  assert.equal(fs.statSync(old.blob).mtimeMs, START, 'reference reuse must not update physical retention');
  const stat = fs.promises.stat;
  const entered = deferred();
  const unblock = deferred();
  let reads = 0;
  fs.promises.stat = async (file, ...args) => {
    const result = await stat(file, ...args);
    if (file === old.blob && ++reads === 2) {
      entered.resolve();
      await unblock.promise;
    }
    return result;
  };
  try {
    const prune = oldLink.prune({ days: 7 });
    await entered.promise;
    const newLink = make('up:new-link');
    const fresh = await newLink.saveBytes(bytes(14), { sessionKey: 'group:14' });
    assert.equal(fresh.blob, old.blob);
    assert.ok(fs.statSync(fresh.blob).mtimeMs > START);
    unblock.resolve();
    assert.equal((await prune).removed, 0);
    assert.ok(fs.existsSync(fresh.blob));
  } finally { unblock.resolve(); fs.promises.stat = stat; }
  assert.equal(oldLink.find(old.id), null);
});

test('an occurrence committed during the retention stat cannot lose its blob to a stale result', async (t) => {
  const { make, clock } = fixture(t);
  const store = make();
  const old = await store.saveBytes(bytes(11), { sessionKey: 'private:11' });
  setOld(old.blob);
  clock.at += 9 * DAY;
  const stat = fs.promises.stat;
  const entered = deferred();
  const unblock = deferred();
  let once = false;
  fs.promises.stat = async (file, ...args) => {
    const result = await stat(file, ...args);
    if (file === old.blob && !once) {
      once = true;
      entered.resolve();
      await unblock.promise;
    }
    return result;
  };
  try {
    const prune = store.prune({ days: 7 });
    await entered.promise;
    const fresh = await store.saveBytes(bytes(11), { sessionKey: 'group:11' });
    unblock.resolve();
    assert.equal((await prune).removed, 0);
    assert.ok(fs.existsSync(fresh.blob));
  } finally { unblock.resolve(); fs.promises.stat = stat; }
  const followup = await store.prune({ days: 7 });
  assert.equal(followup.detached, 1);
  assert.deepEqual(owners(store, old.id), ['group:11']);
  assert.ok(fs.existsSync(old.blob));
});
