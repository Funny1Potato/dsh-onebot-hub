/**
 * 表情包库的自包含测试（`node test/memes.mjs`）。
 *
 * 为什么这么测：
 *  - 这个库的**真正风险不在内存里，而在两处边界**：一是"模型能不能编造 id"，
 *    所以 renderForPrompt 的约束字样与"最近使用必列"是必测项；二是"容量满了以后
 *    会不会把刚用顺手的图删掉"，所以 rotate 的用例故意让最近用过的两张留在库里。
 *  - 需要"跨进程仍然记得"的地方（noteUse 之后重建 store）必须真重建，
 *    只断言内存对象等于没测落盘。
 *  - 全部用例确定性：不联网、不读环境变量、不用随机数，时间由 `now` 注入，
 *    字节用固定字符串（库里不要求是合法图片，落盘的只是字节）。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonStore } from '../lib/storage.js';
import { MEME_ID_PREFIX, MemeStore, describeMeme, normalizeKeywords } from '../lib/memes/store.js';

// ---- 用例收集（与仓库其它测试同形）--------------------------------------------

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

// ---- 固定装置 -----------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memes-'));

/** 每个用例一个独立目录，互不污染。 */
function makeStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const storage = new JsonStore({ dir, log: () => {} });
  const store = new MemeStore({ storage, ...opts });
  return { dir, storage, store };
}

// ---- 纯函数 -------------------------------------------------------------------

t('normalizeKeywords：数组/顿号逗号字符串/空值/重复/超长/超量', () => {
  assert.equal(MEME_ID_PREFIX, 'm');
  assert.deepEqual(normalizeKeywords([' 开心 ', '得意', '开心', '', '   ']), ['开心', '得意']);
  assert.deepEqual(normalizeKeywords('开心、得意,好奇；生气'), ['开心', '得意', '好奇', '生气']);
  assert.deepEqual(normalizeKeywords(''), []);
  assert.deepEqual(normalizeKeywords('   '), []);
  assert.deepEqual(normalizeKeywords(null), []);
  assert.deepEqual(normalizeKeywords(undefined), []);
  assert.deepEqual(normalizeKeywords('猫'), ['猫'], '单个字符串也算一条关键词');

  const long = normalizeKeywords(['x'.repeat(30)]);
  assert.equal(long.length, 1);
  assert.equal(long[0].length, 24, '每条截断到 24 字符');

  const collide = normalizeKeywords(['y'.repeat(30), `${'y'.repeat(30)}tail`]);
  assert.deepEqual(collide, ['y'.repeat(24)], '截断后相同的关键词要去重');

  const many = normalizeKeywords(Array.from({ length: 15 }, (_, i) => `k${i}`));
  assert.equal(many.length, 12, '最多 12 条');
  assert.deepEqual(many, Array.from({ length: 12 }, (_, i) => `k${i}`), '保留前 12 条且顺序不变');
});

t('describeMeme：单行中文描述（关键词带"适用场景"标签，aigf-master 对比）', () => {
  assert.equal(
    describeMeme({ id: 'm3', keywords: ['开心', '得意'], description: '一只鼓掌的猫' }),
    'm3（适用场景：开心、得意）一只鼓掌的猫',
  );
  assert.equal(describeMeme({ id: 'm4', keywords: [], description: '一条鱼' }), 'm4 一条鱼');
  assert.equal(describeMeme({ id: 'm5', keywords: ['猫'] }), 'm5（适用场景：猫）');
  assert.equal(describeMeme({}), '');
  assert.equal(
    describeMeme({ id: 'm6', keywords: '开心、得意', description: '  多  空格  ' }),
    'm6（适用场景：开心、得意）多 空格',
  );
});

// ---- 收藏与落盘 ---------------------------------------------------------------

t('collect：字节真实落盘且一致，id 从 m1 单调递增', async () => {
  const { dir, store } = makeStore();
  const a = await store.collect({
    bytes: Buffer.from('AAA'),
    mediaType: 'image/jpeg',
    keywords: ['鼓掌'],
    description: '鼓掌的猫',
    source: 'group:1',
    messageId: '42',
  });
  const b = await store.collect({ bytes: Buffer.from('BBBB'), mediaType: 'image/png' });

  assert.equal(a.id, 'm1');
  assert.equal(b.id, 'm2');
  assert.equal(a.file, 'memes/m1.jpg');
  assert.equal(b.file, 'memes/m2.png');
  assert.equal(a.sha256, crypto.createHash('sha256').update(Buffer.from('AAA')).digest('hex'));
  assert.equal(a.bytes, 3);
  assert.equal(a.uses, 0);
  assert.equal(a.lastUsedAt, null);
  assert.deepEqual(a.keywords, ['鼓掌']);
  assert.equal(a.source, 'group:1');
  assert.equal(a.messageId, '42');

  const absA = store.pathOf('m1');
  assert.equal(absA, path.join(dir, 'memes', 'm1.jpg'));
  assert.deepEqual(fs.readFileSync(absA), Buffer.from('AAA'), '磁盘上的字节必须与收进来的完全一致');
  const absB = store.pathOf('m2');
  assert.equal(absB, path.join(dir, 'memes', 'm2.png'));
  assert.deepEqual(fs.readFileSync(absB), Buffer.from('BBBB'));
  assert.equal(store.pathOf('m404'), null, '不存在的 id 没有路径');
});

t('collect：相同字节只收藏一次（sha256 去重）', async () => {
  const { dir, store } = makeStore();
  const a = await store.collect({ bytes: Buffer.from('same-bytes'), description: '第一次' });
  const b = await store.collect({ bytes: Buffer.from('same-bytes'), description: '第二次' });

  assert.equal(b.id, a.id, '同一张图返回已有条目，不新建 id');
  assert.equal(store.list().length, 1);
  assert.equal(store.stats.count, 1);
  assert.equal(store.get('m1').description, '第一次', '去重命中不改已有条目');
  const files = fs.readdirSync(path.join(dir, 'memes')).filter((f) => f.endsWith('.jpg'));
  assert.deepEqual(files, ['m1.jpg'], '不会多写一份文件');
});

// ---- prompt 渲染 --------------------------------------------------------------

t('renderForPrompt：空库给出一句说明而不是空串', () => {
  const { store } = makeStore();
  const text = store.renderForPrompt();
  assert.match(text, /还没有收藏/);
  assert.match(text, /不要编造 id/);
});

t('renderForPrompt：列出所有 id 与中文描述，并逐字带上"只能使用列出的 id"约束', async () => {
  const { store } = makeStore();
  await store.collect({ bytes: Buffer.from('a'), keywords: ['开心', '得意'], description: '一只鼓掌的猫' });
  await store.collect({ bytes: Buffer.from('b'), keywords: ['生气'], description: '一只炸毛的狗' });
  await store.collect({ bytes: Buffer.from('c'), description: '一条沉默的鱼' });

  const text = store.renderForPrompt();
  for (const id of ['m1', 'm2', 'm3']) assert.ok(text.includes(id), `清单应包含 id ${id}`);
  for (const desc of ['一只鼓掌的猫', '一只炸毛的狗', '一条沉默的鱼']) {
    assert.ok(text.includes(desc), `清单应包含中文描述 ${desc}`);
  }
  assert.match(text, /只能使用下面列出的 id/);
  assert.match(text, /不要编造 id/);
  assert.ok(text.includes('m1（适用场景：开心、得意）一只鼓掌的猫'), '描述行形如 m1（适用场景：关键词）说明');
  // aigf-master 对比：标题点明"用于发送"，且有一句正向引导（别全是禁令）。
  assert.match(text, /用于发送/);
  assert.match(text, /气氛合适就发一个/);
  assert.equal(text.split('\n').length, 4, '一行表头 + 三行清单');
});

t('renderForPrompt：最近使用过的即使不在高频前 limit 个里也必须出现', async () => {
  const { store } = makeStore();
  for (let i = 0; i < 12; i += 1) {
    await store.collect({ bytes: Buffer.from(`img-${i}`), keywords: [`kw${i}`], description: `描述${i}` });
  }
  assert.equal(store.noteUse('m11'), true);

  const text = store.renderForPrompt(); // 默认 limit 8、recentShown 5
  const lines = text.split('\n').slice(1);
  assert.ok(
    lines.some((line) => line.startsWith('- m11')),
    'm11 排不进高频前 8 个，但它是最近用过的，必须被列出来',
  );
  assert.ok(text.includes('描述10'));
  assert.equal(lines.length, 9, '8 个高频项 + 1 个最近使用项（去重后共 9 行）');
});

// ---- 使用与持久化 -------------------------------------------------------------

t('noteUse：uses/lastUsedAt 正确变化，重建 store 后仍然保留', async () => {
  let clock = 1000;
  const { dir, store } = makeStore({ now: () => clock });
  await store.collect({ bytes: Buffer.from('note-me'), keywords: ['猫'] });

  assert.equal(store.noteUse('m1'), true);
  assert.equal(store.get('m1').uses, 1);
  assert.equal(store.get('m1').lastUsedAt, 1000);

  clock = 2000;
  assert.equal(store.noteUse('m1'), true);
  assert.equal(store.get('m1').uses, 2);
  assert.equal(store.get('m1').lastUsedAt, 2000);
  assert.equal(store.noteUse('m9'), false, '不存在的 id 什么都不改');

  const again = new MemeStore({ storage: new JsonStore({ dir, log: () => {} }), now: () => clock });
  assert.equal(again.get('m1').uses, 2, '重建后 uses 应保留');
  assert.equal(again.get('m1').lastUsedAt, 2000, '重建后 lastUsedAt 应保留');
  assert.deepEqual(again.get('m1').keywords, ['猫']);
  assert.equal(again.get('m1').file, 'memes/m1.jpg');
});

// ---- 淘汰 ---------------------------------------------------------------------

t('rotate：maxCount=3 收 6 个，最近用过的留下、被淘汰的磁盘文件真的消失', async () => {
  let clock = 1000;
  const { dir, store } = makeStore({ maxCount: 3, recentShown: 2, now: () => clock });

  clock += 10;
  const first = await store.collect({ bytes: Buffer.from('A') });
  const goneAbs = path.join(dir, 'memes', 'm1.jpg');
  assert.equal(first.id, 'm1');
  assert.ok(fs.existsSync(goneAbs), '刚收下来的文件必须在磁盘上');

  const rest = [];
  for (const tag of ['B', 'C', 'D']) {
    clock += 10;
    rest.push(await store.collect({ bytes: Buffer.from(tag) }));
  }
  assert.deepEqual([first, ...rest].map((e) => e.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(store.has('m1'), false, '谁都没用过时先淘汰 id 最小的');
  assert.equal(fs.existsSync(goneAbs), false, '被淘汰时文件就已经删掉了');

  clock += 10;
  store.noteUse('m2');
  clock += 10;
  store.noteUse('m3');

  clock += 10;
  await store.collect({ bytes: Buffer.from('E') });
  clock += 10;
  await store.collect({ bytes: Buffer.from('F') });

  assert.equal(store.list().length, 3, '总数不能超过 maxCount');
  assert.deepEqual(store.list().map((e) => e.id), ['m2', 'm3', 'm6'], '最近用过的 m2/m3 必须留下');
  assert.ok(!store.has('m4') && !store.has('m5'));
  assert.equal(fs.existsSync(goneAbs), false, '被淘汰条目的磁盘文件必须一并删掉');
  assert.equal(store.pathOf('m1'), null);
});

t('rotate：手动调用返回被淘汰的 id，且不会重复淘汰', async () => {
  let clock = 2000;
  const { store } = makeStore({ maxCount: 10, recentShown: 1, now: () => clock });
  for (let i = 0; i < 6; i += 1) {
    clock += 10;
    await store.collect({ bytes: Buffer.from(`M${i}`) });
  }
  clock += 10;
  assert.equal(store.noteUse('m6'), true);
  assert.equal(store.list().length, 6, 'maxCount 是 10，此时还没有淘汰');

  store.maxCount = 3;
  const removed = store.rotate();
  assert.equal(removed.length, 3);
  assert.deepEqual(removed, ['m1', 'm2', 'm3'], '最少使用 → 最久未用 → id 小，依次淘汰');
  assert.equal(store.list().length, 3);
  assert.ok(store.has('m6'), '最近使用过的那张不能被淘汰');
  assert.equal(removed.includes('m6'), false);
  assert.deepEqual(store.rotate(), [], '已经在容量以内，再 rotate 无事发生');
});

// ---- 删除与匹配 ---------------------------------------------------------------

t('remove：条目与磁盘文件一起消失，不存在的 id 返回 false', async () => {
  const { store } = makeStore();
  const a = await store.collect({ bytes: Buffer.from('del-me') });
  const abs = store.pathOf(a.id);
  assert.ok(abs && fs.existsSync(abs));

  assert.equal(store.remove(a.id), true);
  assert.equal(store.has(a.id), false);
  assert.equal(store.stats.count, 0);
  assert.equal(store.pathOf(a.id), null);
  assert.equal(fs.existsSync(abs), false, '文件必须被删');

  assert.equal(store.remove('m999'), false);
  assert.equal(store.remove(null), false);
  assert.equal(store.remove(undefined), false);
});

t('matchByKeywords：命中关键字的排在前面，没命中不返回', async () => {
  const { store } = makeStore();
  await store.collect({ bytes: Buffer.from('1'), keywords: '开心、鼓掌', description: '鼓掌的猫' });
  await store.collect({ bytes: Buffer.from('2'), keywords: ['生气'], description: '炸毛的狗' });
  await store.collect({ bytes: Buffer.from('3'), keywords: ['开心'], description: '微笑的猫' });

  const hits = store.matchByKeywords('今天有点开心，来个鼓掌的表情');
  assert.deepEqual(hits.map((e) => e.id), ['m1', 'm3'], '命中两个关键词的排最前');
  assert.equal(hits[0].id, 'm1');
  assert.deepEqual(store.matchByKeywords(''), []);
  assert.deepEqual(store.matchByKeywords('完全无关的一句话'), []);
  assert.equal(store.matchByKeywords('开心', { limit: 1 }).length, 1, 'limit 生效');
});

// ---- 降级与统计 ---------------------------------------------------------------

t('storage 为 null：collect 不抛、file 为空、pathOf 返回 null', async () => {
  const store = new MemeStore({ storage: null });
  const entry = await store.collect({ bytes: Buffer.from('no-disk'), keywords: ['x'], description: '只在内存里' });
  assert.equal(entry.id, 'm1');
  assert.equal(entry.file, '', '落盘关闭时没有相对路径');
  assert.equal(store.pathOf('m1'), null);
  assert.equal(store.stats.enabled, false);
  assert.equal(store.stats.count, 1);
  assert.ok(store.renderForPrompt().includes('m1'), '清单照样能列出来');
  assert.equal(store.noteUse('m1'), true);
  assert.equal(store.remove('m1'), true);
  assert.equal(store.stats.count, 0);

  const disabled = new MemeStore({ storage: new JsonStore({ dir: '' }) });
  const e2 = await disabled.collect({ bytes: Buffer.from('also-no-disk') });
  assert.equal(e2.file, '');
  assert.equal(disabled.pathOf(e2.id), null);
  assert.equal(disabled.stats.enabled, false);
});

t('stats：count 与实际条目数一致，bytes/hits/lastAt 跟着走', async () => {
  let clock = 5000;
  const { store } = makeStore({ maxCount: 50, now: () => clock });
  assert.deepEqual(store.stats, { enabled: true, count: 0, capacity: 50, bytes: 0, hits: 0, lastAt: null });

  clock += 10;
  await store.collect({ bytes: Buffer.from('12345') });
  clock += 10;
  await store.collect({ bytes: Buffer.from('1234567') });
  assert.equal(store.stats.count, store.list().length);
  assert.equal(store.stats.count, 2);
  assert.equal(store.stats.bytes, 12);
  assert.equal(store.stats.hits, 0);
  assert.equal(store.stats.lastAt, null);

  clock += 10;
  store.noteUse('m1');
  assert.equal(store.stats.hits, 1);
  assert.equal(store.stats.lastAt, clock);
  assert.equal(store.snapshot().entries.length, 2);
  assert.equal(store.snapshot().maxCount, 50);
});

// ---- 坏索引 -------------------------------------------------------------------

t('load：坏索引（缺字段/非法 id/重复 id）不崩，只丢坏记录并续上 seq', async () => {
  const { storage } = makeStore();
  storage.write('memes/index.json', {
    seq: 4,
    entries: [
      { id: 'm1', file: 'memes/m1.jpg', bytes: 3, keywords: ['a'], description: '好的条目', savedBy: 'agent', uses: 1, lastUsedAt: 100 },
      null,
      'nope',
      7,
      {},
      { id: 'mX' },
      { id: 'm2', savedBy: 'agent' },
      { id: 'm2', description: '重复 id，应被忽略' },
    ],
  });

  const store = new MemeStore({ storage });
  assert.deepEqual(store.list().map((e) => e.id), ['m1', 'm2']);
  assert.equal(store.get('m1').description, '好的条目');
  assert.equal(store.get('m1').uses, 1);
  assert.equal(store.get('m1').lastUsedAt, 100);
  assert.deepEqual(store.get('m2').keywords, [], '缺字段补默认值');
  assert.equal(store.get('m2').file, '');
  assert.equal(store.get('m2').uses, 0);
  assert.equal(store.pathOf('m2'), null);

  const next = await store.collect({ bytes: Buffer.from('next'), brief: '测试' });
  assert.equal(next.id, 'm5', 'seq 从索引里的 4 续上，保证 id 跨进程单调递增');
});

t('load：改造前的老条目（没 savedBy）载入即清，但 seq 保留、id 不复用', async () => {
  const { storage } = makeStore();
  storage.write('memes/index.json', {
    seq: 9,
    entries: [
      { id: 'm1', file: 'memes/m1.jpg', bytes: 3, keywords: ['a'], description: '自动收集时代的条目' },
      { id: 'm7', file: '', bytes: 1, savedBy: 'agent', brief: '新条目' },
    ],
  });

  const store = new MemeStore({ storage });
  assert.deepEqual(store.list().map((e) => e.id), ['m7'], '老条目被清掉，新条目留下');
  assert.equal(store.get('m7').brief, '新条目');
  const next = await store.collect({ bytes: Buffer.from('x'), brief: 'y' });
  assert.equal(next.id, 'm10', '被清条目参与过 seq 计算，id 不复用（跨进程单调）');
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
