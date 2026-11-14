import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReadTarget } from '../lib/read-scope.js';
import { JsonStore } from '../lib/storage.js';
import { MediaStore } from '../lib/media.js';
import { FailureStore } from '../lib/ops/failures.js';
import { Profiles } from '../lib/profile.js';
import { Mind } from '../lib/mind.js';
import { SessionData } from '../lib/ops/session-data.js';
import { RecallStore } from '../lib/memory/recall.js';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../lib/tasks.js';

const cases = [];
const test = (name, run) => cases.push({ name, run });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audit-'));
const mediaIn = (dir) => new MediaStore({ storage: new JsonStore({ dir }), linkId: 'up:test' });
const image = (name = 'secret.png') => ({ type: 'image', data: { file: 'base64://AQID', name } });

test('已知 id 不能替同次请求里的未知 id 背书', () => {
  const lookup = (id) => id === 'known' ? 'group:111' : '';
  assert.equal(resolveReadTarget({ message_id: 'unknown', id: 'known', group_id: 111 }, lookup).target, '?');
  assert.equal(resolveReadTarget({ message_id: 'unknown', id: 'known', group_id: 111 }, lookup, { full: true }).target, 'group:111');
});

test('媒体引用复用必须拒绝不可读归属，而非只是不新增归属', async () => {
  const dir = temp();
  try {
    const media = mediaIn(dir);
    const ref = await media.resolve(image(), { sessionKey: 'private:222' });
    const got = await media.resolve({ type: 'image', data: { file: ref.id } }, { sessionKey: 'group:111', allow: (key) => key === 'group:111' });
    assert.match(String(got?.error), /范围|权限|归属/);
    assert.equal(got.blob, undefined);
    assert.deepEqual(media.ownersOf(ref.id).sessionKeys, ['private:222']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('媒体加载失败不能置成功位，恢复后允许重试', async () => {
  const dir = temp();
  const original = fs.promises.readFile;
  try {
    await mediaIn(dir).resolve(image(), { sessionKey: 'group:111' });
    const media = mediaIn(dir);
    fs.promises.readFile = async (...args) => {
      if (String(args[0]).endsWith('.jsonl')) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
      return original(...args);
    };
    const bad = await media.purgeScope('group:111');
    assert.equal(bad.ok, false, '加载失败不能当删了零条成功');
    fs.promises.readFile = original;
    const retry = await media.purgeScope('group:111');
    assert.equal(retry.ok, true);
    assert.equal(retry.refs, 1);
  } finally { fs.promises.readFile = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('失败重放不能静默丢掉结构参数', () => {
  const store = new FailureStore();
  const row = store.record({ params: { group_id: 111, forward: { source: 'a' } }, segments: [{ type: 'text', data: { text: 'hi' } }] });
  assert.equal(row.replayable, false);
});

test('嵌套转发里的内联媒体同样不能入失败队列', () => {
  const store = new FailureStore();
  const row = store.record({ segments: [{ type: 'node', data: { user_id: '1', content: [{ type: 'image', data: { file: 'base64://c2VjcmV0' } }] } }] });
  assert.equal(row.replayable, false);
  assert.equal(JSON.stringify(store.list()).includes('c2VjcmV0'), false);
});

test('媒体列表不借私聊首次出现的描述、来源或编号', async () => {
  const dir = temp();
  try {
    const media = mediaIn(dir);
    const first = await media.resolve(image('secret.png'), { sessionKey: 'private:222', messageId: 'private-msg' });
    first.text = 'private-description';
    await media.resolve(image('public.png'), { sessionKey: 'group:111', messageId: 'public-msg' });
    const shown = media.visibleRef(media.find(first.id), { allow: (key) => key === 'group:111', preferred: 'group:111' });
    assert.equal(shown.name, 'public.png');
    assert.equal(shown.messageId, 'public-msg');
    assert.equal(JSON.stringify(shown).includes('private'), false);
    const storage = new JsonStore({ dir });
    const exported = await new SessionData({ hub: { storage, media: mediaIn(dir) } }).exportBundle('group:111');
    const bundle = JSON.parse(fs.readFileSync(exported.file, 'utf8'));
    assert.equal(bundle.counts.media, 1, '导出也要等待重启后的媒体索引');
    assert.equal(bundle.media[0].name, 'public.png');
    assert.deepEqual(bundle.media[0].sessionKeys, ['group:111']);
    storage.stop();
    await media.purgeScope('private:222');
    const restarted = mediaIn(dir);
    await restarted.ensureIndex();
    assert.equal(JSON.stringify(restarted.find(first.id)).includes('private:222'), false);
    assert.equal(JSON.stringify(restarted.find(first.id)).includes('secret.png'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('删除标记落不下盘要报失败，索引留下以便重试', async () => {
  const dir = temp();
  const original = fs.appendFileSync;
  try {
    const media = mediaIn(dir);
    const ref = await media.resolve(image(), { sessionKey: 'group:111' });
    fs.appendFileSync = () => { throw new Error('marker blocked'); };
    const bad = await media.purgeScope('group:111');
    assert.equal(bad.ok, false);
    assert.ok(media.find(ref.id));
    fs.appendFileSync = original;
    assert.equal((await media.purgeScope('group:111')).ok, true);
    const restarted = mediaIn(dir);
    await restarted.ensureIndex();
    assert.equal(restarted.find(ref.id), null);
  } finally { fs.appendFileSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite 删除失败不先清空原文与内存，第二次可以重试', async () => {
  const dir = temp();
  const recall = new RecallStore({ dir, linkId: 'up:test' });
  const original = DatabaseSync.prototype.prepare;
  try {
    recall.append({ id: 'e1', ts: Date.now(), sessionKey: 'group:111', text: 'old' });
    await recall.ensure();
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (/DELETE FROM rt WHERE id/.test(sql)) throw new Error('sqlite blocked');
      return original.call(this, sql, ...args);
    };
    const bad = await recall.purgeSession('group:111');
    assert.equal(bad.ok, false);
    assert.equal(recall.sessionOf('e1'), 'group:111');
    DatabaseSync.prototype.prepare = original;
    assert.equal((await recall.purgeSession('group:111')).ok, true);
    assert.equal(recall.sessionOf('e1'), '');
  } finally { DatabaseSync.prototype.prepare = original; recall.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('清理共享话题只摘来源，独占话题与群目录记录退场，flush 不复活', () => {
  const dir = temp();
  const storage = new JsonStore({ dir });
  try {
    const profiles = new Profiles({ storage });
    profiles.upsertTopic('shared', { worldKeys: ['group:111', 'group:333'], events: ['a', 'b'], refs: [{ messageId: 'a' }, { id: 'b' }], conclusion: '混合总结' });
    profiles.upsertTopic('only', { worldKeys: ['group:111'], events: ['a'] });
    profiles.group('group:111');
    assert.deepEqual(profiles.forgetTopicScope('group:111', (id) => id === 'a' ? 'group:111' : 'group:333'), { removed: 1, detached: 1 });
    profiles.forgetScope('group:111');
    storage.flush();
    const restarted = new Profiles({ storage });
    assert.deepEqual(restarted.topics().map((t) => t.id), ['shared']);
    assert.deepEqual(restarted.topic('shared').events, ['b']);
    assert.deepEqual(restarted.topic('shared').worldKeys, ['group:333']);
    assert.equal(restarted.groups().some((g) => g.worldKey === 'group:111'), false);
  } finally { storage.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('清理先停旧轮再删盘，不在最后才退役会话', async () => {
  const order = [];
  const hub = { mind: { beginPurge: async () => { order.push('stop'); return 1; }, endPurge: () => order.push('release') }, recall: { purgeSession: async () => { order.push('disk'); return { ok: true, rows: 0 }; } } };
  const result = await new SessionData({ hub }).purge('group:111', { confirm: 'group:111' });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['stop', 'disk', 'release']);
});

test('清理时已在上游等待的旧回复不能写回原文或发第二条', async () => {
  let release;
  let started;
  const ready = new Promise((r) => { started = r; });
  const response = new Promise((r) => { release = r; });
  const logged = [];
  let calls = 0;
  const mind = new Mind({ hub: { config: { replyGapMs: 0 }, callUpstream: async () => { calls += 1; started(); return response; } }, timeline: { record: (x) => logged.push(x) } });
  const generation = mind.beginTurn('group:111');
  const old = mind.deliver('group:111', { messages: [1, 2].map((i) => ({ text: String(i), segments: [{ type: 'text', data: { text: String(i) } }] })) }, { generation });
  await ready;
  mind.forgetSession('group:111');
  mind.beginTurn('group:111');
  release({ status: 'ok' });
  assert.equal(await old, null);
  assert.equal(calls, 1);
  assert.equal(logged.length, 0);
  assert.equal(await mind.deliver('group:111', { text: 'late' }, { generation }), null, '开新轮不能洗白旧轮 token');
});

test('旧失败记录不默认认作可原样重放，加载也检查嵌套内联媒体', () => {
  const store = new FailureStore({ storage: { read: () => ({ entries: [{ id: 'legacy', replayable: true, segments: [{ type: 'node', data: { content: [{ type: 'image', data: { file: 'base64://c2VjcmV0' } }] } }] }] }) } });
  store.load();
  assert.equal(store.paramsFor('legacy').ok, false);
  assert.equal(JSON.stringify(store.list()).includes('c2VjcmV0'), false);
});

test('另一个任务触发轮换时不退役仍有在飞任务的总机，倒计时搬迁保留原定时间', async () => {
  let release;
  let started;
  const ready = new Promise((r) => { started = r; });
  const gate = new Promise((r) => { release = r; });
  const nextAt = new Date(Date.now() + 3600000).toISOString();
  const saved = { sessionId: 'onebot-hub:tasks', tasks: [
    { id: 'a', title: 'A', target: 'group:111', active: true, scheduleId: 'sa', when: { kind: 'every', seconds: 60 } },
    { id: 'b', title: 'B', target: 'group:333', active: true, scheduleId: 'sb', when: { kind: 'every', seconds: 60 } },
    { id: 'c', title: 'C', target: 'group:444', active: true, scheduleId: 'sc', when: { kind: 'after', seconds: 7200 }, nextAt },
  ] };
  const created = [];
  let retired = 0;
  const hub = { config: { upstreamType: 'official' }, hostRef: { pinSessionId() {} }, mind: {
    ensureAgent: async () => {}, pool: { retire: async () => { retired += 1; } },
    reawake: async (scope) => { if (scope === 'group:111') { started(); await gate; } return { woke: true }; },
  }, scheduleSvc: { create: async (_session, req) => { created.push(req); return { id: `new${created.length}`, scheduledAt: nextAt }; }, delete: async () => {} } };
  const store = new TaskStore({ hub, resetEvery: 1, storage: { read: () => structuredClone(saved), write() {} } });
  store.load();
  const a = store.fire('a');
  await ready;
  await store.fire('b');
  assert.equal(retired, 0, '跳过单条在飞任务却退役总机，会把其排期留在旧会话');
  release();
  await a;
  assert.equal(retired, 1);
  const migrated = created.find((req) => req.title === 'C');
  assert.equal(migrated.at, nextAt, '不能把 after:7200 从轮换时刻重新计时');
});

test('试跑未结束时正式到点不丢，两次串行唤醒且正式那次才退场', async () => {
  let release;
  let started;
  const ready = new Promise((r) => { started = r; });
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const store = new TaskStore({ storage: { read: () => ({ sessionId: 'onebot-hub:tasks', tasks: [{ id: 'a', active: true, target: 'group:111', title: 'A', when: { kind: 'after', seconds: 60 } }] }), write() {} }, hub: { config: { upstreamType: 'official' }, mind: { reawake: async () => { calls += 1; if (calls === 1) { started(); await gate; } return { woke: true }; } } } });
  store.load();
  const trial = store.run('a');
  await ready;
  const formal = store.fire('a');
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const [tried, fired] = await Promise.all([trial, formal]);
  assert.equal(tried.finished, undefined);
  assert.equal(fired.finished, true);
  assert.equal(calls, 2);
  assert.equal(store.list().length, 0);
});

test('退役失败不越过停机屏障删盘，解除清理锁后可重试', async () => {
  let disk = 0;
  const mind = new Mind({ pool: { retire: async () => { throw new Error('retire blocked'); } } });
  const result = await new SessionData({ hub: { mind, recall: { purgeSession: async () => { disk += 1; return { ok: true }; } } } }).purge('group:111', { confirm: 'group:111' });
  assert.equal(result.ok, false);
  assert.match(result.error, /retire blocked/);
  assert.equal(disk, 0);
  assert.equal(mind.isGenerationCurrent('group:111', mind.generationOf('group:111')), true);
  mind.pool.retire = () => undefined;
  const retry = await new SessionData({ hub: { mind, recall: { purgeSession: async () => { disk += 1; return { ok: true }; } } } }).purge('group:111', { confirm: 'group:111' });
  assert.equal(retry.ok, true);
  assert.equal(disk, 1);
});

test('定时或跨会话唤醒没有真人说话人，不继承上一轮的私聊可见身份', async () => {
  const mind = new Mind({ pool: { wake: async () => ({ ok: true }) } });
  mind.actorBySession.set('group:111', '222');
  await mind.reawake('group:111', { reason: 'task', text: 'reminder' });
  assert.equal(mind.actorOf('group:111'), '');
});

let failed = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (err) { failed += 1; console.error(`FAIL ${name}: ${err.stack}`); }
}
console.log(`audit-boundaries ${cases.length - failed}/${cases.length}`);
if (failed) process.exitCode = 1;
