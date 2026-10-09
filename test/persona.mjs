/**
 * PersonaStore 单测：预设规范化、会话绑定隔离、会话级人设分叉、落盘持久化、render 降级。
 * 不依赖 ws / DSH，可直接 `node test/persona.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../lib/storage.js';
import {
  DEFAULT_PRESET_NAME,
  PersonaStore,
  makeDefaultPreset,
  normalizePreset,
} from '../lib/persona/store.js';

/** 每个用例一个独立临时目录 + 独立 JsonStore，避免相互污染。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-persona-'));
  const storage = new JsonStore({ dir, debounceMs: 30 });
  return { dir, storage, store: new PersonaStore({ storage }).load() };
}

const registry = [];
const t = (name, fn) => registry.push({ name, fn });

// --- 载入与兜底 -------------------------------------------------------------

t('空目录 load() 后自动补 default，resolve/render 都拿得到', () => {
  const { store } = scratch();
  assert.equal(store.has(DEFAULT_PRESET_NAME), true);
  assert.equal(store.list().map((p) => p.name).join(','), DEFAULT_PRESET_NAME);
  const resolved = store.resolve('group:1');
  assert.equal(resolved.name, DEFAULT_PRESET_NAME);
  assert.equal(resolved.role, makeDefaultPreset().role);
  assert.match(store.render('group:1'), /你是/);
  // 没绑定的任何键形状都回落到 default（不假设只有 group:/private: 两种）
  assert.equal(store.resolve('私聊:某个人').name, DEFAULT_PRESET_NAME);
});

t('normalizePreset 只留规范字段：hidden 只认 true、knowledge 去重且上限 50', () => {
  const empty = normalizePreset(null, '兜底名');
  assert.deepEqual(empty, { name: '兜底名', role: '', knowledges: [], hidden: false });
  assert.deepEqual(Object.keys(empty).sort(), ['hidden', 'knowledges', 'name', 'role']);

  const dirty = normalizePreset(
    { name: '   ', role: '  负责整理  ', knowledges: ['x', 'x', '', '  ', ' y '], hidden: 'yes', 别的字段: 1 },
    'k',
  );
  assert.deepEqual(dirty, { name: 'k', role: '负责整理', knowledges: ['x', 'y'], hidden: false });

  const many = normalizePreset({ name: 'n', knowledges: Array.from({ length: 60 }, (_, i) => `k${i}`) }, 'n');
  assert.equal(many.knowledges.length, 50);

  assert.equal(normalizePreset({ name: 'h', hidden: 1 }, 'h').hidden, false);
  assert.equal(normalizePreset({ name: 'h', hidden: true }, 'h').hidden, true);
});

// --- 保存与列表 -------------------------------------------------------------

t('save 去重 knowledges，list 顺序稳定且同名覆盖不新增条目', () => {
  const { store } = scratch();
  const saved = store.save({
    name: '整理员',
    role: '负责整理资料',
    knowledges: ['第一条', '', '第一条', '   ', '第二条', 42, null],
  });
  assert.deepEqual(saved, {
    name: '整理员',
    role: '负责整理资料',
    knowledges: ['第一条', '第二条'],
    hidden: false,
  });
  assert.equal(store.get('整理员').knowledges.length, 2);

  assert.deepEqual(store.list().map((p) => p.name), [DEFAULT_PRESET_NAME, '整理员']);
  store.save({ name: '主持人', role: '控场' });
  assert.deepEqual(store.list().map((p) => p.name), [DEFAULT_PRESET_NAME, '整理员', '主持人']);

  store.save({ name: '整理员', role: '改过的职责', knowledges: ['只剩一条'] });
  assert.deepEqual(
    store.list().map((p) => p.name),
    [DEFAULT_PRESET_NAME, '整理员', '主持人'],
    '同名覆盖不应改变顺序或新增条目',
  );
  assert.deepEqual(store.get('整理员').knowledges, ['只剩一条']);
});

t('hidden 预设默认不出现在 list，includeHidden 才出现', () => {
  const { store } = scratch();
  store.save({ name: '内部默认', role: 'r', hidden: true });
  store.save({ name: '公开', role: 'r' });
  assert.equal(store.list().some((p) => p.name === '内部默认'), false);
  assert.equal(store.list({ includeHidden: true }).some((p) => p.name === '内部默认'), true);
  assert.equal(store.setHidden('内部默认', false), true);
  assert.equal(store.list().some((p) => p.name === '内部默认'), true);
  assert.equal(store.setHidden('不存在的预设', true), false);
});

// --- 绑定 -------------------------------------------------------------------

t('bind 按会话隔离，未绑定的会话仍然用 default', () => {
  const { store } = scratch();
  store.save({ name: '某某', role: '甲的人设' });
  assert.equal(store.bind('group:1', '某某'), true);
  assert.equal(store.resolve('group:1').name, '某某');
  assert.equal(store.resolve('group:2').name, DEFAULT_PRESET_NAME);
  assert.equal(store.resolve('private:7').name, DEFAULT_PRESET_NAME);
  assert.equal(store.boundName('group:1'), '某某');
  assert.equal(store.boundName('group:2'), null);
  assert.equal(store.unbind('group:1'), true);
  assert.equal(store.resolve('group:1').name, DEFAULT_PRESET_NAME);
  assert.equal(store.unbind('group:1'), false);
});

t('bind 一个不存在的预设返回 false 且不产生绑定', () => {
  const { store } = scratch();
  assert.equal(store.bind('group:9', '根本不存在'), false);
  assert.equal(store.boundName('group:9'), null);
  assert.equal(store.resolve('group:9').name, DEFAULT_PRESET_NAME);
  // 已有绑定不能被"打错名字"毁掉
  store.save({ name: '真预设', role: 'r' });
  store.bind('group:9', '真预设');
  assert.equal(store.bind('group:9', '打错了'), false);
  assert.equal(store.boundName('group:9'), '真预设');
});

// --- 删除 -------------------------------------------------------------------

t('remove(default) 被拒绝，default 仍在', () => {
  const { store } = scratch();
  assert.equal(store.remove(DEFAULT_PRESET_NAME), false);
  assert.equal(store.has(DEFAULT_PRESET_NAME), true);
  assert.equal(store.resolve('group:1').name, DEFAULT_PRESET_NAME);
});

t('remove 被绑定的预设 → 该会话回落 default，不报错', () => {
  const { store } = scratch();
  store.save({ name: '临时', role: 'r' });
  store.bind('group:1', '临时');
  store.bind('group:2', '临时');
  assert.equal(store.remove('临时'), true);
  assert.equal(store.has('临时'), false);
  assert.equal(store.resolve('group:1').name, DEFAULT_PRESET_NAME);
  assert.equal(store.resolve('group:2').name, DEFAULT_PRESET_NAME);
  assert.equal(store.boundName('group:1'), null);
  assert.equal(store.remove('临时'), false);
});

// --- 会话级人设 -------------------------------------------------------------

t('setRole 只改本会话：角色名保持、role 变化、共享预设不被改写', () => {
  const { store } = scratch();
  store.save({ name: '某某', role: '原始设定', knowledges: ['知识甲'] });
  store.bind('group:1', '某某');
  const nameBefore = store.resolve('group:1').name;
  assert.equal(nameBefore, '某某');

  store.setRole('group:1', { role: '改过的设定' });
  const after = store.resolve('group:1');
  assert.equal(after.name, nameBefore, '只给 role 时角色名必须保持不变');
  assert.equal(after.role, '改过的设定');
  assert.deepEqual(after.knowledges, ['知识甲'], '未显式给 knowledges 时应保留');
  assert.match(store.render('group:1'), /改过的设定/);
  assert.equal(store.get('某某').role, '原始设定', '共享的预设本身不应被改动');

  // 只给 knowledges 时 role 保留；空数组才是真清空
  store.setRole('group:1', { knowledges: ['新知识', '新知识', ''] });
  assert.equal(store.resolve('group:1').role, '改过的设定');
  assert.deepEqual(store.resolve('group:1').knowledges, ['新知识']);
  store.setRole('group:1', { knowledges: [] });
  assert.deepEqual(store.resolve('group:1').knowledges, []);

  // 显式改名字才改
  store.setRole('group:1', { name: '新名字' });
  assert.equal(store.resolve('group:1').name, '新名字');
});

t('setRole 对共用同一预设 / 共用 default 的其他会话都没有影响', () => {
  const { store } = scratch();
  store.save({ name: '共享', role: '原样' });
  store.bind('group:1', '共享');
  store.bind('group:2', '共享');
  store.setRole('group:1', { role: '只给 group:1' });
  assert.equal(store.resolve('group:2').role, '原样');
  assert.equal(store.resolve('group:2').name, '共享');
  assert.equal(store.get('共享').role, '原样');

  // 直接改 default 上的会话，也不能污染 default 本身与其他会话
  store.setRole('group:5', { role: '专属语气' });
  assert.equal(store.resolve('group:5').role, '专属语气');
  assert.equal(store.resolve('group:6').role, makeDefaultPreset().role);
  assert.equal(store.get(DEFAULT_PRESET_NAME).role, makeDefaultPreset().role);
  assert.equal(store.resolve('group:6').name, DEFAULT_PRESET_NAME);
});

// --- 持久化 -----------------------------------------------------------------

t('持久化：flush 后重建 PersonaStore，预设 / 绑定 / hidden / 会话人设全部还原', async () => {
  const { dir, storage, store } = scratch();
  store.save({ name: '落盘甲', role: '甲的人设', knowledges: ['甲知识一', '甲知识二'] });
  store.save({ name: '落盘乙', role: '乙的人设', hidden: true });
  assert.equal(store.bind('group:1', '落盘甲'), true);
  store.setRole('group:1', { role: '落盘后的会话设定' });

  const written = await store.flush();
  assert.ok(written >= 1, `flush 至少应写下一个文件，实际 ${written}`);
  assert.equal(storage.stats.errors, 0, `落盘不应报错：${storage.stats.lastError ?? ''}`);

  const store2 = new PersonaStore({ storage: new JsonStore({ dir }) }).load();
  assert.deepEqual(store2.list({ includeHidden: true }).map((p) => p.name), [
    DEFAULT_PRESET_NAME,
    '落盘甲',
    '落盘乙',
  ]);
  assert.deepEqual(store2.get('落盘甲').knowledges, ['甲知识一', '甲知识二']);
  assert.equal(store2.get('落盘乙').hidden, true);
  assert.equal(store2.list().some((p) => p.name === '落盘乙'), false);
  assert.equal(store2.boundName('group:1'), '落盘甲');

  const revived = store2.resolve('group:1');
  assert.equal(revived.name, '落盘甲');
  assert.equal(revived.role, '落盘后的会话设定', '会话私有分叉也必须落盘');
  assert.deepEqual(revived.knowledges, ['甲知识一', '甲知识二']);
  assert.equal(store2.resolve('group:2').name, DEFAULT_PRESET_NAME);

  const snap = store2.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.defaultName, DEFAULT_PRESET_NAME);
  assert.equal(Object.keys(snap.presets).includes(DEFAULT_PRESET_NAME), true);
  assert.equal(typeof snap.bindings['group:1'], 'string');
  await store2.flush();
});

// --- render 与统计 ----------------------------------------------------------

t('render 边界：无知识不输出知识段，空 role 不产生畸形串', () => {
  const { store } = scratch();
  store.save({ name: '无知识', role: '只会说话' });
  store.bind('group:1', '无知识');
  const r1 = store.render('group:1');
  assert.equal(r1.includes('## 你的知识'), false);
  assert.equal(r1, '你是 无知识，只会说话');

  store.save({ name: '空设定', role: '' });
  store.bind('group:2', '空设定');
  const r2 = store.render('group:2');
  assert.equal(r2.includes('你是 ，'), false);
  assert.equal(r2.includes('，'), false);
  assert.equal(r2, '你是 空设定。');

  store.save({ name: '有知识', role: 'r', knowledges: ['第一条', '第二条'] });
  store.bind('group:3', '有知识');
  assert.equal(store.render('group:3'), '你是 有知识，r\n## 你的知识\n- 第一条\n- 第二条');

  // 既没有 default 又没有绑定（没 load 的空库）→ 空串，调用方据此不装配人设段
  const bare = new PersonaStore({});
  assert.equal(bare.render('group:1'), '');
  assert.equal(bare.resolve('group:1'), null);
});

t('stats 数字与实际一致', () => {
  const { store } = scratch();
  store.save({ name: 'a', role: 'x' });
  store.save({ name: 'b', role: 'y', hidden: true });
  store.bind('group:1', 'a');
  store.bind('group:2', 'a');
  store.bind('group:3', 'b');

  const s = store.stats;
  assert.equal(s.presets, 3, 'default + a + b（含 hidden）');
  assert.equal(s.presets, store.list({ includeHidden: true }).length);
  assert.equal(s.bindings, 3);
  assert.equal(s.defaultName, DEFAULT_PRESET_NAME);
  assert.equal(s.storage, true);
  assert.equal(s.forks, 0);

  store.setRole('group:1', { role: 'x2' });
  assert.equal(store.stats.forks, 1, '会话私有分叉单独计数');
  assert.equal(store.stats.presets, 3, '会话私有分叉不计入可见预设数');
  assert.equal(store.stats.bindings, 3);
});

t('没有 storage（dir 为空）时退化为纯内存，不抛异常', () => {
  const bare = new PersonaStore({}).load();
  assert.equal(bare.stats.storage, false);
  assert.equal(bare.stats.presets, 1);
  assert.equal(bare.resolve('group:1').name, DEFAULT_PRESET_NAME);
  assert.equal(bare.save({ name: '内存预设', role: 'r' }).name, '内存预设');
  assert.equal(bare.bind('group:1', '内存预设'), true);
  assert.equal(bare.resolve('group:1').name, '内存预设');
  assert.equal(bare.flush(), 0);
});

// --- 执行 -------------------------------------------------------------------

const failures = [];
let passed = 0;
for (const { name, fn } of registry) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, error: err.message });
    console.log(`FAIL  ${name}  → ${err.message}`);
  }
}
console.log(JSON.stringify({ passed, failed: failures.length, cases: failures }, null, 2));
if (failures.length) process.exitCode = 1;
