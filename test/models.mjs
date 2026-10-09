/**
 * 会话级模型选择（lib/models.js，§26）自包含测试。
 *
 * 覆盖两件事：
 *  1. **纯函数**：命令参数解析（`provider/model` / 编号 / `default` / 认不出的写法）、清单摊平与
 *     渲染（`→` 标当前、超长截断、编号连续）。
 *  2. **`SessionModels`**：按会话隔离、清空回默认、`JsonStore` 落盘往返（"重启一次"读到同一份选择）。
 *
 * 不依赖 ws / DSH，可直接 `node test/models.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MODEL_KINDS,
  SESSION_MODELS_FILE,
  SessionModels,
  flattenModels,
  formatModelRef,
  normalizeModelRef,
  parseModelArg,
  renderModelList,
  resolveModelArg,
} from '../lib/models.js';
import { JsonStore } from '../lib/storage.js';

let passed = 0;
const cases = [];
const pending = [];
function t(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => {
            passed += 1;
            cases.push({ name, ok: true });
          },
          (err) => cases.push({ name, ok: false, error: String(err?.message ?? err) }),
        ),
      );
      return;
    }
    passed += 1;
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    models: [{ id: 'doubao-vision-pro', name: '豆包视觉 Pro' }],
  },
];

// ------------------------------------------------------------------ 纯函数

t('MODEL_KINDS：只有聊天与识图两类', () => {
  assert.deepEqual(MODEL_KINDS, ['chat', 'vision']);
  assert.equal(SESSION_MODELS_FILE, 'sessions/models.json');
});

t('normalizeModelRef：模型名必填、provider 可省、坏值一律 null', () => {
  assert.deepEqual(normalizeModelRef({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(normalizeModelRef({ model: ' m ' }), { provider: '', model: 'm' });
  assert.equal(normalizeModelRef({ provider: 'p' }), null, '没有模型名 = 没选');
  assert.equal(normalizeModelRef({ provider: 'p', model: '   ' }), null);
  assert.equal(normalizeModelRef(null), null);
  assert.equal(normalizeModelRef('p/m'), null, '字符串不是合法形状');
});

t('formatModelRef：空选择说「系统默认」，不编一个假模型名', () => {
  assert.equal(formatModelRef(null), '（系统默认）');
  assert.equal(formatModelRef({ provider: 'p', model: 'm' }), 'p/m');
  assert.equal(formatModelRef({ model: 'm' }), 'm');
});

t('parseModelArg：三种写法认，其余明确报错（不接受只写模型名）', () => {
  assert.deepEqual(parseModelArg('deepseek/deepseek-chat'), { kind: 'ref', provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(parseModelArg(' volcengine / doubao-vision-pro '), {
    kind: 'ref',
    provider: 'volcengine',
    model: 'doubao-vision-pro',
  });
  assert.deepEqual(parseModelArg('3'), { kind: 'index', index: 3 });
  for (const word of ['default', 'DEFAULT', '默认', 'reset', '清空', '系统默认']) {
    assert.equal(parseModelArg(word).kind, 'clear', `${word} 应当表示回默认`);
  }
  assert.equal(parseModelArg('').kind, 'error');
  assert.equal(parseModelArg('0').kind, 'error', '编号从 1 开始');
  const bare = parseModelArg('deepseek-chat');
  assert.equal(bare.kind, 'error');
  assert.match(bare.message, /provider\/model/, '报错要说清楚该怎么写');
  assert.match(parseModelArg('a/b/c').message, /provider\/model/, '斜杠太多也算认不出');
});

t('flattenModels：编号连续、跳过坏条目', () => {
  const flat = flattenModels([...PROVIDERS, { id: '', models: [{ id: 'x' }] }, { id: 'p', models: [{ id: '' }, null] }]);
  assert.deepEqual(flat.map((item) => item.index), [1, 2, 3]);
  assert.deepEqual(flat.map((item) => `${item.provider}/${item.model}`), [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-reasoner',
    'volcengine/doubao-vision-pro',
  ]);
  assert.equal(flat[0].providerName, 'DeepSeek');
  assert.equal(flat[2].name, '豆包视觉 Pro');
  assert.deepEqual(flattenModels(null), []);
});

t('resolveModelArg：编号按清单取，越界要说"共几个"', () => {
  assert.deepEqual(resolveModelArg('2', PROVIDERS), { kind: 'ref', ref: { provider: 'deepseek', model: 'deepseek-reasoner' } });
  assert.deepEqual(resolveModelArg('volcengine/doubao-vision-pro', PROVIDERS), {
    kind: 'ref',
    ref: { provider: 'volcengine', model: 'doubao-vision-pro' },
  });
  assert.equal(resolveModelArg('default', PROVIDERS).kind, 'clear');
  const over = resolveModelArg('9', PROVIDERS);
  assert.equal(over.kind, 'error');
  assert.match(over.message, /共 3 个/);
});

t('renderModelList：分组、标当前、超出每组就截断并注明', () => {
  const text = renderModelList({ providers: PROVIDERS, current: { provider: 'deepseek', model: 'deepseek-chat' } });
  assert.match(text, /当前：deepseek\/deepseek-chat/);
  assert.match(text, /【DeepSeek】/);
  assert.match(text, /→ 1\. deepseek-chat（DeepSeek Chat）/);
  assert.match(text, /· 3\. doubao-vision-pro（豆包视觉 Pro）/);
  assert.match(text, /发编号就能切/);

  // 前缀可配（m02289）：提示语里的命令要用调用方给的前缀，不许写死 `/`
  const bang = renderModelList({ providers: PROVIDERS, prefix: '!', command: 'vmodel' });
  assert.match(bang, /`!vmodel 3`/);
  assert.ok(!bang.includes('/vmodel'), `不许写死斜杠：\n${bang}`);
  const generic = renderModelList({ providers: PROVIDERS });
  assert.match(generic, /直接写 `provider\/model`/, '给不出命令名就不编一个');

  const many = [{ id: 'p', name: 'P', models: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) }];
  const clipped = renderModelList({ providers: many, perProvider: 3 });
  assert.match(clipped, /…还有 17 个/);

  const empty = renderModelList({ providers: [], current: null });
  assert.match(empty, /当前：（系统默认）/);
  assert.match(empty, /没给可用模型清单/);

  const huge = renderModelList({
    providers: [{ id: 'p', name: 'P', models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) }],
    maxChars: 120,
  });
  assert.ok(huge.length <= 120, `超长要截断：${huge.length}`);
  assert.match(huge, /…$/);
});

// ------------------------------------------------------------------ SessionModels

t('SessionModels：按会话隔离，清掉一个还剩另一个', () => {
  const models = new SessionModels({ storage: null });
  assert.deepEqual(models.get('group:1'), { chat: null, vision: null, at: 0 });
  assert.equal(models.chatFor('group:1'), null);

  models.set('group:1', 'chat', { provider: 'deepseek', model: 'deepseek-chat' });
  models.set('group:1', 'vision', { provider: 'volcengine', model: 'doubao-vision-pro' });
  models.set('group:2', 'vision', { model: 'only-model' });
  assert.deepEqual(models.chatFor('group:1'), { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(models.visionFor('group:2'), { provider: '', model: 'only-model' });
  assert.equal(models.chatFor('group:2'), null, '没设过的会话不受别的会话影响');

  models.set('group:1', 'chat', null);
  assert.equal(models.chatFor('group:1'), null, '清掉就回系统默认');
  assert.deepEqual(models.visionFor('group:1'), { provider: 'volcengine', model: 'doubao-vision-pro' });
  assert.equal(models.stats.sessions, 2);
  assert.equal(models.stats.chat, 0);
  assert.equal(models.stats.vision, 2);

  models.set('group:1', 'vision', null);
  assert.equal(models.stats.sessions, 1, '两类都清掉的会话不该再占一行');
  assert.deepEqual(models.list().map((row) => row.sessionKey), ['group:2']);
});

t('SessionModels：坏参数不静默（空会话键、未知类型）', () => {
  const models = new SessionModels({ storage: null });
  assert.throws(() => models.set('', 'chat', { model: 'm' }), /会话键为空/);
  assert.throws(() => models.set('group:1', 'image', { model: 'm' }), /未知的模型类型/);
});

t('SessionModels：落盘往返（等于重启一次），坏文件不崩', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-models-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 0 });
  const models = new SessionModels({ storage });
  models.set('group:55555', 'chat', { provider: 'p', model: 'm' });
  models.set('private:10001', 'vision', { provider: 'p2', model: 'v2' });
  assert.ok(fs.existsSync(storage.path(SESSION_MODELS_FILE)), '命令写下的选择要立刻落盘');

  const revived = new SessionModels({ storage });
  assert.deepEqual(revived.chatFor('group:55555'), { provider: 'p', model: 'm' });
  assert.deepEqual(revived.visionFor('private:10001'), { provider: 'p2', model: 'v2' });
  assert.equal(revived.stats.file, storage.path(SESSION_MODELS_FILE));

  fs.writeFileSync(storage.path(SESSION_MODELS_FILE), '{坏 JSON', 'utf8');
  const broken = new SessionModels({ storage });
  assert.equal(broken.stats.sessions, 0, '坏文件只是读不回来，不许崩');
  assert.ok(fs.existsSync(`${storage.path(SESSION_MODELS_FILE)}.bad`), '坏文件改名留证据');

  // 坏记录（缺 model / 不是对象）也要被丢掉，不能变成一条"选了空模型"
  fs.writeFileSync(
    storage.path(SESSION_MODELS_FILE),
    JSON.stringify({ version: 1, sessions: { 'group:1': { chat: { provider: 'p' }, vision: { model: 'v' } }, 'group:2': 'nope' } }),
    'utf8',
  );
  const mixed = new SessionModels({ storage });
  assert.equal(mixed.chatFor('group:1'), null);
  assert.deepEqual(mixed.visionFor('group:1'), { provider: '', model: 'v' });
  assert.equal(mixed.get('group:2').chat, null);
  assert.equal(mixed.stats.sessions, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('SessionModels：注入时钟记在 at 上（排查"什么时候换的"）', () => {
  const models = new SessionModels({ storage: null, now: () => 1_700_000_000_000 });
  models.set('group:1', 'chat', { model: 'm' });
  assert.equal(models.get('group:1').at, 1_700_000_000_000);
});

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
