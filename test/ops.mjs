/**
 * 按会话的盘点 / 导出 / 清理（审查报告"按会话清理与导出数据"，`m85685`）。
 *
 * 这里用**真件**（真的 RecallStore / MediaStore / MemoryStore / ActiveStore / Profiles）
 * 挂在临时目录上跑，不写假 store：这条路的价值全在"五处都真的动到了"，
 * 用假件测等于只测了自己写的那个编排函数。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonStore } from '../lib/storage.js';
import { RecallStore } from '../lib/memory/recall.js';
import { MediaStore } from '../lib/media.js';
import { MemoryStore } from '../lib/memory/store.js';
import { ActiveStore } from '../lib/memory/active.js';
import { Profiles } from '../lib/profile.js';
import { SessionData } from '../lib/ops/session-data.js';
import { createOpsHandler } from '../lib/ops/route.js';
import { FailureStore } from '../lib/ops/failures.js';
import { resolveConfig } from '../lib/config/resolve.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-'));
  const log = () => {};
  const storage = new JsonStore({ dir, log, debounceMs: 0 });
  const recall = new RecallStore({ dir: path.join(dir, 'recall'), linkId: 'up:test', log });
  const media = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  const store = new MemoryStore({ storage, log });
  const active = new ActiveStore({ storage, log });
  const profiles = new Profiles({ storage, log });

  const now = Date.now();
  recall.append({ id: 't_a1', ts: now - 2000, sessionKey: 'group:111', direction: 'upstream-in', text: '甲群的话', actor: { user_id: '10001', nickname: '小明' } });
  recall.append({ id: 't_a2', ts: now - 1500, sessionKey: 'group:111', direction: 'upstream-in', text: '甲群第二句', actor: { user_id: '10001' } });
  recall.append({ id: 't_b1', ts: now - 1000, sessionKey: 'private:222', direction: 'upstream-in', text: '私聊的话', actor: { user_id: '20002' } });

  await media.resolve({ type: 'image', data: { file: `base64://${PNG.toString('base64')}`, name: '甲群的图.png' } }, { messageId: '1', index: 0, sessionKey: 'group:111' });
  await media.resolve({ type: 'image', data: { file: `base64://${Buffer.concat([PNG, Buffer.from([7])]).toString('base64')}`, name: '私聊的图.png' } }, { messageId: '2', index: 0, sessionKey: 'private:222' });

  store.add({ kind: 'long_term', text: '甲群记下的长期事实' }, { sessionKey: 'group:111' });
  store.add({ kind: 'long_term', text: '私聊记下的长期事实' }, { sessionKey: 'private:222' });
  active.add({ kind: 'topic', text: '甲群在聊装修', originScope: 'group:111' });
  active.add({ kind: 'topic', text: '私聊在聊搬家', originScope: 'private:222' });
  profiles.noteName('10001', '小明', 'group:111');
  profiles.noteGroupCard('10001', 'group:111', { card: '小明同学', role: 'member' });
  profiles.noteName('20002', '小张', 'private:222');
  profiles.noteGroupCard('20002', 'private:222', { card: '小张' });
  profiles.upsertGroup('group:111', { name: '甲群', memberCount: 12 });
  profiles.upsertGroup('private:222', { name: '小张私聊' });

  const removedTasks = [];
  const taskCalls = [];
  const tasks = {
    pause: async (id, opts) => { taskCalls.push({ op: 'pause', id, opts }); return { ok: true, id, paused: true }; },
    resume: async (id, opts) => { taskCalls.push({ op: 'resume', id, opts }); return { ok: true, id, paused: false }; },
    remove: async (id, opts) => { taskCalls.push({ op: 'remove', id, opts }); return { ok: true, id }; },
    list: () => [
      { id: 'tsk_a', target: 'group:111', createdBy: 'group:111', title: '甲群的提醒' },
      { id: 'tsk_b', target: 'private:222', createdBy: 'private:222', title: '私聊的提醒' },
    ],
    purgeScope: async (scope, { dryRun = false } = {}) => {
      const hit = tasks.list().filter((t) => t.target === scope || t.createdBy === scope);
      if (dryRun) return { ok: true, dryRun: true, removed: hit.length, ids: hit.map((t) => t.id) };
      removedTasks.push(...hit.map((t) => t.id));
      return { ok: true, removed: hit.length, failed: [] };
    },
  };

  const hub = { storage, recall, media, store, active, profiles, tasks, config: {}, timeline: { recent: () => [] } };
  return { dir, storage, recall, media, store, active, profiles, tasks, hub, removedTasks, taskCalls };
}

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

t('盘点：五处各数各的，另一个会话的不算进来', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  const inv = await ops.inventory('group:111');
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.equal(inv.recall, 2, '原文两条');
  assert.equal(inv.media, 1, '媒体一条');
  assert.equal(inv.memory, 1, '记忆一条');
  assert.equal(inv.active, 1, '活跃层一条');
  assert.equal(inv.tasks, 1, '任务一条');
  assert.equal(inv.persons, 1, '人物档案里有一格');
  assert.equal(inv.group, 1, '群档案在');
  const other = await ops.inventory('private:222');
  assert.equal(other.recall, 1);
  assert.equal(other.memory, 1);
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('盘点：会话键写歪了要当场说清楚，不拿 0 冒充"没有"', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  const bad = await ops.inventory('甲群');
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /group:<群号>/);
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('导出：一份包落在 exports/ 里，条数逐项对得上，且不写 base64', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  const r = await ops.exportBundle('group:111');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.file, /exports[\\/]group_111-.*\.json$/, `导出路径：${r.file}`);
  assert.ok(fs.existsSync(r.file), '文件要真的在');
  const bundle = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(bundle.scope, 'group:111');
  assert.equal(bundle.counts.recall, 2);
  assert.equal(bundle.counts.media, 1);
  assert.equal(bundle.counts.memory, 1);
  assert.equal(bundle.counts.active, 1);
  assert.equal(bundle.counts.tasks, 1);
  assert.equal(bundle.profiles.persons.length, 1);
  assert.equal(bundle.profiles.group.name, '甲群');
  assert.equal(JSON.stringify(bundle).includes(PNG.toString('base64').slice(0, 40)), false, '包里不该塞整张图的 base64');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：confirm 不对就不动手，且报错要说清怎么确认', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  const r = await ops.purge('group:111', { confirm: '对' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /confirm/);
  assert.equal(w.recall.stats.rows, 3, '一条都不许少');
  const still = await ops.inventory('group:111');
  assert.equal(still.recall, 2);
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：六处一起清，另一个会话原样不动（含共用 blob 的归属）', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  // 让甲群那张图也在私聊里出现一次：删甲群时它该留下，只是摘掉归属
  const shared = (await w.media.list({ allow: (row) => (row.sessionKeys ?? []).includes('group:111') }))[0];
  // 同一份字节再落一次（内容寻址：id 就是 sha256，所以两个会话拿到的是同一个 id）
  await w.media.resolve({ type: 'image', data: { file: `base64://${PNG.toString('base64')}`, name: '私聊转发的同一张.png' } }, { messageId: '3', index: 0, sessionKey: 'private:222' });
  assert.deepEqual([...(w.media.find(shared.id)?.sessionKeys ?? [])], ['group:111', 'private:222'], '两个会话都该看得见同一份字节');
  const r = await ops.purge('group:111', { confirm: 'group:111' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.removed.recall, 2);
  assert.equal(r.removed.media, 1, '删掉的是"只属于甲群"的那条图片');
  assert.equal(r.removed.memory, 1);
  assert.equal(r.removed.active, 1);
  assert.equal(r.removed.tasks, 1);
  assert.equal(r.removed.persons, 1);
  assert.equal(r.removed.group, 1);

  // 另一个会话：原文、记忆、活跃、任务、档案都在
  const inv = await ops.inventory('private:222');
  assert.equal(inv.recall, 1, '私聊的原文不该被连坐');
  assert.equal(inv.memory, 1, '私聊的记忆不该被连坐');
  assert.equal(inv.active, 1);
  assert.equal(inv.tasks, 1);
  assert.equal(inv.persons, 1);
  assert.equal(w.store.query({ scope: 'group:111', limit: 10 }).length, 0, '甲群的记忆要真没了');
  assert.equal(w.active.all().filter((e) => e.originScope === 'group:111').length, 0);
  assert.equal(w.profiles.person('10001').groups['group:111'], undefined, '人物档案里那一格要摘掉');
  assert.equal(w.profiles.person('10001').names.length >= 0, true, '但人本身还在（名字不属于某个会话）');
  assert.equal(w.profiles.group('group:111').name, null, '群档案被清空');
  assert.equal(w.profiles.group('private:222').name, '小张私聊', '另一个群档案不受影响');

  // 共用 blob：还在索引里，只是归给私聊
  const left = w.media.find(shared.id);
  assert.ok(left, '共用 blob 不能被删掉');
  assert.deepEqual([...(left.sessionKeys ?? [])], ['private:222']);
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：原文的日文件被真的重写（重启后不会自己回来）', async () => {
  const w = await makeWorld();
  const ops = new SessionData({ hub: w.hub });
  const before = w.recall.rawIndex({ sessionKey: 'group:111', limit: 10 });
  await before;
  await ops.purge('group:111', { confirm: 'group:111' });
  // 重新建一个 RecallStore 读同一批文件：这是"重启后还看得见吗"的等价问法
  const again = new RecallStore({ dir: path.join(w.dir, 'recall'), linkId: 'up:test', log: () => {} });
  await again.ensure();
  const idx = await again.rawIndex({ limit: 10 });
  again.close();
  assert.equal(idx.entries.filter((e) => e.sessionKey === 'group:111').length, 0, '甲群的原文还在文件里');
  assert.equal(idx.entries.filter((e) => e.sessionKey === 'private:222').length, 1, '私聊那行要留着');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：内存里的副本也一起清掉（复审 F07）', async () => {
  const w = await makeWorld();
  const { Timeline, CaptureLog } = await import('../lib/capture.js');
  const timeline = new Timeline({ limitGlobal: 100, limitSession: 100 });
  const capture = new CaptureLog({ limit: 100 });
  const eventFor = (groupId) => ({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 222, self_id: 1,
    message: [{ type: 'text', data: { text: '还在内存里' } }],
  });
  timeline.record({ direction: 'upstream-in', linkId: 'l1', event: eventFor(111) });
  timeline.record({ direction: 'upstream-in', linkId: 'l1', event: eventFor(222) });
  capture.add({ action: 'send_group_msg', sessionKey: 'group:111' });
  const forgotten = [];
  const hub = { ...w.hub, timeline, capture, mind: { forgetSession: (key) => { forgotten.push(key); return 4; } } };
  const ops = new SessionData({ hub });
  // 盘算时也看得见内存副本（删除前先数一眼）：时间线 1 条 + 捕获账本 1 条。
  const inv = await ops.inventory('group:111');
  assert.equal(inv.live, 2, `盘点要带内存副本，实际 ${inv.live}`);
  const res = await ops.purge('group:111', { confirm: 'group:111' });
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.equal(res.removed.timeline, 1, '内存时间线被摘掉一条');
  assert.equal(res.removed.capture, 1, '捕获账本被摘掉一条');
  assert.equal(res.removed.mind, 4);
  assert.deepEqual(forgotten, ['group:111'], '每会话的批次/唤醒状态也要清');
  assert.equal(timeline.bySession('group:111').length, 0);
  assert.equal(timeline.bySession('group:222').length, 1, '别的会话不动');
  assert.equal((await ops.inventory('group:111')).live, 0, '清完之后盘算也该是 0');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：会话卡与失败队列也一起清（第三轮 T10）', async () => {
  const w = await makeWorld();
  const { Cards } = await import('../lib/memory/cards.js');
  const cards = new Cards({ storage: w.storage, dir: 'cards', log: () => {} });
  // 卡里存的是"刚才在聊什么"——最直白的一份原话。
  for (const key of ['group:111', 'private:222']) {
    cards.note({
      id: `t_${key}`,
      direction: 'upstream-in',
      sessionKey: key,
      ts: Date.now(),
      text: `这句话属于 ${key}`,
      refs: { message_id: `m_${key}` },
      payload: {
        post_type: 'message',
        message_type: 'group',
        group_id: 111,
        user_id: 222,
        message: [{ type: 'text', data: { text: `这句话属于 ${key}` } }],
      },
    });
  }
  await cards.flush?.();
  const failures = new FailureStore({ storage: w.storage, log: () => {} });
  for (const key of ['group:111', 'private:222']) {
    failures.record({
      scope: key,
      action: 'send_group_msg',
      params: { group_id: 111 },
      segments: [{ type: 'text', data: { text: `没发出去的一句话（${key}）` } }],
      text: `没发出去的一句话（${key}）`,
      status: 'failed',
      retcode: 1200,
      error: '风控',
    });
  }
  const hub = { ...w.hub, cards, failures };
  const ops = new SessionData({ hub });
  const res = await ops.purge('group:111', { confirm: 'group:111' });
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.equal(res.removed.cards, 1, '会话卡要算进「删了多少」');
  assert.equal(res.removed.failures, 1, '失败队列同样');
  assert.equal(cards.get('group:111'), null, '甲群的卡没了');
  assert.ok(cards.get('private:222'), '私聊的卡还在');
  assert.equal(failures.list().length, 1, '失败队列只该剩私聊那条');
  assert.equal(failures.list()[0].scope, 'private:222');
  // 卡是落盘的：新建一个实例读同一份存储，甲群不该自己回来。
  const again = new Cards({ storage: w.storage, dir: 'cards', log: () => {} });
  again.load();
  assert.equal(again.get('group:111'), null, '落盘的卡也要删掉，否则重启就又回来了');
  assert.ok(again.get('private:222'), '私聊的卡读得回来');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('清理：索引只在内存里时也能清掉旧媒体（重启过的进程，复审 F08）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-media-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const log = () => {};
  const first = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  const ref = await first.resolve(
    { type: 'image', data: { file: `base64://${PNG.toString('base64')}`, name: '旧图.png' } },
    { messageId: '9', index: 0, sessionKey: 'group:111' },
  );
  assert.ok(ref?.id, '先落地一张图');
  const blob = String(ref.blob ?? '');
  assert.ok(blob && fs.existsSync(blob), 'blob 应该在盘上');

  // 新的实例 = 重启：内存索引是空的，只有审计日志还在。
  const again = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  assert.equal(again.list({ limit: 10 }).length, 0, '重启后内存索引确实是空的');
  const res = await again.purgeScope('group:111');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.refs, 1, '要从审计日志里认出这条');
  assert.equal(fs.existsSync(blob), false, 'blob 必须真的被删掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('清理只追加标记、不改写日志：重启后删掉的不会回来、共用那条还认得（第三轮 T06/T07）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-marker-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const log = () => {};
  const media = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  const only = await media.resolve(
    { type: 'image', data: { file: `base64://${PNG.toString('base64')}`, name: '甲群独有.png' } },
    { messageId: '1', index: 0, sessionKey: 'group:111' },
  );
  const sharedBytes = Buffer.concat([PNG, Buffer.from([7])]);
  const shared = await media.resolve(
    { type: 'image', data: { file: `base64://${sharedBytes.toString('base64')}`, name: '两边都有.png' } },
    { messageId: '2', index: 0, sessionKey: 'group:111' },
  );
  await media.resolve(
    { type: 'image', data: { file: `base64://${sharedBytes.toString('base64')}`, name: '两边都有.png' } },
    { messageId: '3', index: 0, sessionKey: 'private:222' },
  );
  const res = await media.purgeScope('group:111');
  assert.equal(res.ok, true, JSON.stringify(res));
  // 日志不许被重写：盘上那份应该还留着原来那些行（这是"只追加"的直接证据）。
  const logDir = path.join(dir, 'media', 'up:test'.replace(/[^0-9A-Za-z._-]/g, '_'));
  const raw = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  assert.match(raw, /甲群独有\.png/, '落地那行还在（只是后面补了删除标记）');
  assert.match(raw, /"op":"drop"|"op": ?"drop"/, '要有 drop 标记');

  // 新建实例 = 重启：按标记重建索引，删掉的不会回来，共用的那条还在。
  const again = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  await again.ensureIndex();
  assert.equal(again.find(only.id), null, '删掉的那条重启后不许回来');
  const kept = again.find(shared.id);
  assert.ok(kept, '共用那条还认得');
  assert.deepEqual(kept.sessionKeys, ['private:222'], '只摘掉甲群的归属，私聊还在');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('并发重建索引共用同一次加载，不会有一边按空索引开删（第三轮 T06）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-concurrent-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const log = () => {};
  const first = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  await first.resolve(
    { type: 'image', data: { file: `base64://${PNG.toString('base64')}`, name: '并发.png' } },
    { messageId: '4', index: 0, sessionKey: 'group:111' },
  );
  const again = new MediaStore({ storage, linkId: 'up:test', log, fetchImpl: async () => null });
  const [a, b] = await Promise.all([again.ensureIndex(), again.ensureIndex()]);
  assert.equal(a, 1, '第一份加载要把审计日志算进去');
  assert.equal(b, 1, '第二份要等同一份结果，而不是直接回 0');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('失败队列：同一错误 60 秒内只留一条（计数），内联媒体不进队列也不谎称能重放', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fail-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const store = new FailureStore({ storage, log: () => {} });
  const first = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'text', data: { text: '在吗' } }],
    text: '在吗',
    status: 'failed',
    retcode: 1200,
    error: '发送失败',
  });
  const second = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'text', data: { text: '在吗' } }],
    text: '在吗',
    status: 'failed',
    retcode: 1200,
    error: '发送失败',
  });
  assert.equal(store.size, 1, '同一个错不该刷满队列');
  assert.equal(second.id, first.id);
  assert.equal(store.list()[0].count, 2, '重复要计数');

  const plan = store.paramsFor(first.id);
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'send_group_msg');
  assert.deepEqual(plan.params.group_id, 111);
  assert.deepEqual(plan.params.message, [{ type: 'text', data: { text: '在吗' } }]);

  const inline = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'image', data: { file: `base64://${PNG.toString('base64')}` } }],
    text: '',
    status: 'failed',
    retcode: 1200,
    error: '图片没发出去',
  });
  assert.equal(inline.replayable, false, '内联数据存不下，就要老实说重放不了');
  assert.equal(JSON.stringify(store.list()).includes(PNG.toString('base64').slice(0, 40)), false, '队列里不该有整张图');
  assert.match(String(store.paramsFor(inline.id).error), /重放|不完整|截短/);

  // 上限：最多 50 条，新的在前
  for (let i = 0; i < 60; i += 1) {
    store.record({ scope: `group:${900 + i}`, action: 'send_msg', segments: [{ type: 'text', data: { text: `第 ${i} 条` } }], text: `第 ${i} 条`, status: 'failed', retcode: 1200, error: '发送失败' });
  }
  assert.equal(store.list({ limit: 999 }).length, 50);
  assert.equal(store.list()[0].scope, 'group:959', '新的在前');
  assert.equal(store.find(first.id), null, '第一条被挤出去了');
  storage.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

t('失败队列：同一错误配不同的话要分开记（复审 F13）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fail-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const store = new FailureStore({ storage, log: () => {} });
  const base = { scope: 'group:111', action: 'send_group_msg', params: { group_id: 111 }, status: 'failed', retcode: 1200, error: '风控' };
  store.record({ ...base, text: '第一句话', segments: [{ type: 'text', data: { text: '第一句话' } }] });
  store.record({ ...base, text: '第二句话', segments: [{ type: 'text', data: { text: '第二句话' } }] });
  assert.equal(store.size, 2, '同错误不同内容不该合并成一条');
  // 完全一样的内容才计数。
  store.record({ ...base, text: '第一句话', segments: [{ type: 'text', data: { text: '第一句话' } }] });
  assert.equal(store.size, 2);
  assert.equal(store.list()[0].count >= 1, true);
  const same = store.list().find((row) => row.text === '第一句话');
  assert.equal(same?.count, 2, '同一条内容重复失败要计数');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('失败队列：文字被截短过就不能当原样重放（复审 F14）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fail-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const store = new FailureStore({ storage, log: () => {} });
  const long = '很长的正文'.repeat(120); // 600 字，超过 300 的展示上限
  const row = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'text', data: { text: long } }],
    text: long,
    status: 'failed',
    retcode: 1200,
    error: '风控',
  });
  assert.equal(row.replayable, false, '截短过的不能重放');
  assert.ok((row.trimReasons ?? []).includes('文字过长'), JSON.stringify(row.trimReasons));
  assert.ok(row.text.length <= 300, '展示用的仍是截短版');
  const again = store.paramsFor(row.id);
  assert.equal(again.ok, false);
  assert.match(String(again.error), /不完整|截短/);
  // 短文本照旧能重放。
  const okRow = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'text', data: { text: '短句' } }],
    text: '短句',
    status: 'failed',
    retcode: 1200,
    error: '风控2',
  });
  assert.equal(okRow.replayable, true);
  assert.equal(store.paramsFor(okRow.id).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('失败队列：卡片段整份留着就能重放，白名单外的字段让它还原不了（第三轮 T12）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fail-card-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const store = new FailureStore({ storage, log: () => {} });
  const card = JSON.stringify({ app: 'com.tencent.miniapp', desc: '点我看看' });
  const ok = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'json', data: { data: card } }],
    text: '[卡片]',
    status: 'failed',
    retcode: 1200,
    error: '发送失败',
  });
  assert.equal(ok.replayable, true, '卡片整份留着就该能重放');
  const got = store.paramsFor(ok.id);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.params.message[0].data.data, card, '重放要用原卡片，不是空壳');

  // 同一个段里多了一个还原不了的字段：不许再声称能原样重放。
  const bad = store.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: 111 },
    segments: [{ type: 'json', data: { data: card, extra_blob: { a: 1 } } }],
    text: '[卡片]',
    status: 'failed',
    retcode: 1200,
    error: '发送失败2',
  });
  assert.equal(bad.replayable, false, '有还原不了的字段就必须标出来');
  assert.match(String(bad.trimReasons), /还原不了/);
  assert.equal(store.paramsFor(bad.id).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('路由：失败队列能重放（成功就出队），也能只移除', async () => {
  const w = await makeWorld();
  const replayed = [];
  w.hub.callUpstream = async (action, params) => {
    replayed.push({ action, params });
    return { status: 'ok' };
  };
  w.hub.failures = new FailureStore({ storage: w.storage, log: () => {} });
  const rec = w.hub.failures.record({
    scope: 'group:111',
    action: 'send_group_msg',
    params: { group_id: '111' },
    segments: [{ type: 'text', data: { text: '重来一次' } }],
    text: '重来一次',
    status: 'failed',
    retcode: 1200,
    error: '发送失败',
  });
  const handler = createOpsHandler({ getHub: () => w.hub, getConfig: () => ({ agentGroups: [{ id: '111' }] }) });
  const call = (method, url, body) => new Promise((resolve) => {
    const req = {
      method,
      url,
      on: (name, fn) => {
        if (name === 'data' && body) fn(Buffer.from(JSON.stringify(body)));
        if (name === 'end') fn();
      },
    };
    const out = { statusCode: 0 };
    const res = {
      set statusCode(code) { out.statusCode = code; },
      get statusCode() { return out.statusCode; },
      setHeader: () => {},
      end: (text) => resolve({ ...out, body: JSON.parse(text) }),
    };
    handler(req, res);
  });
  const got = await call('GET', '/onebot-hub/ops');
  assert.equal(got.body.failures.length, 1);
  const done = await call('POST', '/onebot-hub/ops', { op: 'replay', id: rec.id });
  assert.equal(done.body.result.ok, true, JSON.stringify(done.body.result));
  assert.equal(replayed.length, 1);
  assert.deepEqual(replayed[0].params.message, [{ type: 'text', data: { text: '重来一次' } }]);
  assert.equal(w.hub.failures.size, 0, '重放成功要出队');

  const again = w.hub.failures.record({ scope: 'group:111', action: 'send_msg', segments: [{ type: 'text', data: { text: 'x' } }], text: 'x', status: 'failed', error: 'e2' });
  const gone = await call('POST', '/onebot-hub/ops', { op: 'forget_failure', id: again.id });
  assert.equal(gone.body.result.ok, true);
  assert.equal(w.hub.failures.size, 0);
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('路由：喂真实 resolveConfig 结果也不许抛（名单是按 id 的对象，不是数组）', async () => {
  // 复审 F10：`agentGroups`/`agentPrivates` 解析出来是 `{ '617770183': {...} }`，
  // 按数组遍历会 `object is not iterable`——而这正是设置页真实拿到的那份配置。
  const w = await makeWorld();
  const cfg = resolveConfig({ agent: { groups: '[{"id":"617770183"}]', privates: '[{"id":"945126014"}]' } });
  const handler = createOpsHandler({ getHub: () => w.hub, getConfig: () => cfg });
  const got = await new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/onebot-hub/ops', on: () => {} };
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (text) => { try { resolve(JSON.parse(text)); } catch (err) { reject(err); } },
    };
    handler(req, res).catch(reject);
  });
  assert.equal(got.ok, true, JSON.stringify(got));
  const keys = got.sessions.map((row) => row.key);
  assert.ok(keys.includes('group:617770183'), '名单里的群要出现在会话清单里');
  assert.ok(keys.includes('private:945126014'), '名单里的私聊也要');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

t('路由：GET 给出权限预览与会话清单，POST 未知 op 直接拒', async () => {
  const w = await makeWorld();
  w.hub.mind = { activeSessionKey: 'private:945126014' };
  const handler = createOpsHandler({
    getHub: () => w.hub,
    getConfig: () => ({
      isolation: { trustedPrivates: ['945126014'] },
      capability: { writeAllow: ['send_msg'], dangerAllow: [] },
      agentPolicy: { unattended: 'deny' },
      agentGroups: [{ id: '111', name: '甲群' }],
      agentPrivates: [{ id: '222' }],
    }),
  });
  const call = (method, url, body) => new Promise((resolve) => {
    const req = Object.assign(
      {
        method,
        url,
        on: (name, fn) => {
          if (name === 'data' && body) fn(Buffer.from(JSON.stringify(body)));
          if (name === 'end') fn();
        },
      },
      {},
    );
    const out = { statusCode: 0, body: null, headers: {} };
    const res = {
      set statusCode(code) { out.statusCode = code; },
      get statusCode() { return out.statusCode; },
      setHeader: (k, v) => { out.headers[k] = v; },
      end: (text) => resolve({ ...out, body: JSON.parse(text) }),
    };
    handler(req, res);
  });
  const got = await call('GET', '/onebot-hub/ops?scope=group:111');
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.ok, true);
  assert.match(String(got.body.readScope.text), /读/, '权限预览要有一句人话');
  assert.equal(got.body.readScope.current, 'private:945126014', '要报"现在是哪个会话在看"');
  assert.deepEqual(got.body.permissions.writeAllow, ['send_msg']);
  assert.equal(got.body.inventory.recall, 2);
  assert.equal(got.body.sessions.length >= 2, true, '会话清单要有群和私聊');
  assert.equal(got.body.tasks.length, 2);

  const bad = await call('POST', '/onebot-hub/ops', { op: 'wipe' });
  assert.equal(bad.statusCode, 400);
  assert.match(String(bad.body.error), /不认识的操作/);

  const noConfirm = await call('POST', '/onebot-hub/ops', { op: 'purge', scope: 'group:111' });
  assert.equal(noConfirm.body.result.ok, false);
  assert.equal(noConfirm.body.inventory.recall, 2, '没确认就不许动');

  // 任务台账上的三个动作（m85685）：暂停 / 恢复 / 删除
  const paused = await call('POST', '/onebot-hub/ops', { op: 'pause_task', id: 'tsk_a' });
  assert.equal(paused.body.result.ok, true);
  assert.equal(w.taskCalls[0].op, 'pause');
  assert.equal(w.taskCalls[0].id, 'tsk_a');
  const resumed = await call('POST', '/onebot-hub/ops', { op: 'resume_task', id: 'tsk_a' });
  assert.equal(resumed.body.result.paused, false);
  const removed = await call('POST', '/onebot-hub/ops', { op: 'remove_task', id: 'tsk_b' });
  assert.equal(removed.body.result.ok, true);
  const noId = await call('POST', '/onebot-hub/ops', { op: 'pause_task' });
  assert.equal(noId.statusCode, 400, '不带 id 要直接拒');

  const done = await call('POST', '/onebot-hub/ops', { op: 'purge', scope: 'group:111', confirm: 'group:111' });
  assert.equal(done.body.result.ok, true);
  assert.equal(done.body.inventory.recall, 0, '删完快照要跟着变');
  w.recall.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`  ok  ${c.name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${c.name} → ${err?.message ?? err}`);
  }
}
console.log(`ops: ${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
