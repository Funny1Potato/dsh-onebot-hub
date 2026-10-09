/**
 * 出站拆条的自包含测试（`node test/reply.mjs`）。
 *
 * 为什么这么测：
 *  - 「一次 `onebot_reply` 发多条」（m32420）的**真正风险全在拆条规则**上：@ 会不会被单独甩出去、
 *    两条文字会不会黏成一坨、图有没有混进文字那条、超上限丢掉的是不是**尾部**而且**如实告知**。
 *    这些都是纯函数，直接断言形状最省事，也最不容易随重构悄悄变。
 *  - 上限口径是用户定的：**只限文字条数，图另算**——两个上限必须分别断言，别让人后来"顺手统一"。
 *  - 确定性：不联网、不读环境变量，图片用假路径。
 */

import assert from 'node:assert/strict';

import { ReplyBuffer, composeReply, describePlanIssues, describeReply } from '../lib/reply.js';

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

/** 一条消息的段类型序列（断言用，比整段 JSON 好读）。 */
const shape = (m) => m.segments.map((s) => s.type);
const texts = (m) => m.segments.filter((s) => s.type === 'text').map((s) => s.data.text);
const files = (m) => m.segments.filter((s) => s.type === 'image').map((s) => s.data.file);

// ---- 拆条规则 -----------------------------------------------------------------

t('单条文本就是一条消息；单换行不拆条', () => {
  const plan = composeReply({ text: '第一行\n第二行' });
  assert.equal(plan.messages.length, 1);
  assert.deepEqual(shape(plan.messages[0]), ['text']);
  assert.equal(plan.messages[0].text, '第一行\n第二行');
  assert.equal(plan.messages[0].kind, 'text');
});

t('空行（两个换行）分成多条消息，每段 strip', () => {
  const plan = composeReply({ text: '看这个\n\n   说明一下   \n\n\n最后一句' });
  assert.equal(plan.messages.length, 3);
  assert.deepEqual(plan.messages.map((m) => m.text), ['看这个', '说明一下', '最后一句']);
});

t('每张图各自一条消息，且不与文字混在同一条（aigf 同款）', () => {
  const plan = composeReply({ text: '看', images: ['a.png', 'b.png'] });
  assert.equal(plan.messages.length, 3);
  assert.deepEqual(shape(plan.messages[0]), ['text']);
  assert.deepEqual(shape(plan.messages[1]), ['image']);
  assert.deepEqual(shape(plan.messages[2]), ['image']);
  assert.deepEqual(files(plan.messages[1]), ['a.png']);
  assert.deepEqual(files(plan.messages[2]), ['b.png']);
  assert.equal(plan.messages[1].kind, 'image');
});

t('表情包也是图：每张一条，顺序在文字之后', () => {
  const plan = composeReply({ text: '嘿', memes: [{ id: 'm3', file: 'm3.jpg' }] });
  assert.equal(plan.messages.length, 2);
  assert.deepEqual(files(plan.messages[1]), ['m3.jpg']);
  assert.deepEqual(plan.memes, [{ id: 'm3', file: 'm3.jpg' }]);
});

t('@ 不单独拆出来：与相邻文字同属一条', () => {
  const plan = composeReply({
    parts: [{ type: 'text', content: '前面这句' }, { type: 'at', target: '12345' }, { type: 'text', content: '在吗' }],
  });
  assert.equal(plan.messages.length, 1, '@ 不应该自己成条');
  assert.deepEqual(shape(plan.messages[0]), ['text', 'text', 'at', 'text', 'text']);
  assert.deepEqual(plan.messages[0].segments.filter((s) => s.type === 'at').map((s) => s.data.qq), ['12345']);
});

t('break 让 @ 归属哪一条由调用方决定', () => {
  const plan = composeReply({
    parts: [
      { type: 'text', content: '这句是问你的' },
      { type: 'break' },
      { type: 'at', target: '12345' },
      { type: 'text', content: '在吗' },
      { type: 'break' },
      { type: 'text', content: '上面那句是在叫 12345' },
    ],
  });
  assert.equal(plan.messages.length, 3);
  assert.deepEqual(plan.messages.map((m) => m.text), ['这句是问你的', '在吗', '上面那句是在叫 12345']);
  assert.deepEqual(shape(plan.messages[1]), ['at', 'text', 'text']);
  assert.deepEqual(shape(plan.messages[2]), ['text'], '最后一条没有 break 就不该多出空段');
});

t('图片会把 @ 挤成独立一条（否则这个 @ 就丢了）', () => {
  const plan = composeReply({ parts: [{ type: 'at', target: '12345' }, { type: 'image', source: 'a.png' }] });
  assert.equal(plan.messages.length, 2);
  assert.deepEqual(shape(plan.messages[0]), ['at']);
  assert.deepEqual(shape(plan.messages[1]), ['image']);
});

t('同一条里相邻原子之间插恰好一个空格，头尾不插', () => {
  const plan = composeReply({ parts: [{ type: 'text', content: '你好' }, { type: 'text', content: '再见' }] });
  assert.deepEqual(texts(plan.messages[0]), ['你好', ' ', '再见'], '两段文字不该黏成一坨');
  assert.equal(plan.messages.length, 1, '不写 break 就是一条');

  const at = composeReply({ parts: [{ type: 'at', target: '1' }, { type: 'text', content: '在吗' }] });
  assert.deepEqual(shape(at.messages[0]), ['at', 'text', 'text'], '@ 后面要补一个空格段');
  assert.equal(at.messages[0].segments[1].data.text, ' ', '@ 后面要有空格');
});

t('引用只挂第一条消息', () => {
  const plan = composeReply({ text: '一\n\n二\n\n三', quote: '40001' });
  assert.equal(plan.messages.length, 3);
  assert.deepEqual(shape(plan.messages[0]), ['reply', 'text']);
  assert.deepEqual(shape(plan.messages[1]), ['text']);
  assert.equal(plan.messages[0].segments[0].data.id, '40001');
});

t('给 parts 时以 parts 为准，简写字段不再叠加', () => {
  const plan = composeReply({ parts: [{ type: 'text', content: '只有这句' }], text: '不该出现', images: ['x.png'] });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.usedParts, true);
  assert.equal(plan.messages[0].text, '只有这句');
});

// ---- 上限与如实告知 ------------------------------------------------------------

t('上限只限文字条数，图片不占额度', () => {
  const plan = composeReply({ text: '一\n\n二\n\n三\n\n四', images: ['a.png', 'b.png', 'c.png', 'd.png'], maxText: 2, maxImages: 9 });
  assert.equal(plan.messages.filter((m) => m.kind === 'text').length, 2, '文字被砍到 2 条');
  assert.equal(plan.messages.filter((m) => m.kind === 'image').length, 4, '4 张图一张都没少');
  assert.deepEqual(plan.dropped, { text: 2, images: 0 });
  assert.deepEqual(plan.messages.slice(0, 2).map((m) => m.text), ['一', '二'], '丢的是尾部，顺序不变');
});

t('图片条数另有上限，超出记在 images 上', () => {
  const plan = composeReply({ images: ['a.png', 'b.png', 'c.png'], maxText: 3, maxImages: 2 });
  assert.equal(plan.messages.length, 2);
  assert.deepEqual(plan.dropped, { text: 0, images: 1 });
});

t('上限 0 = 不限', () => {
  const plan = composeReply({ text: '一\n\n二\n\n三', maxText: 0, maxImages: 0 });
  assert.equal(plan.messages.length, 3);
  assert.deepEqual(plan.dropped, { text: 0, images: 0 });
  assert.equal(plan.maxText, 0);
});

t('describePlanIssues：少发了什么必须说出来（§26 的老规矩）', () => {
  const plan = composeReply({ text: '一\n\n二\n\n三\n\n四', maxText: 2 });
  const notes = describePlanIssues(plan);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /2 条文字超出上限/);
  assert.equal(describePlanIssues(composeReply({ text: '一句' })).length, 0);
});

t('解不出来的 @ 段：丢掉但说出来（昵称发不出去）', () => {
  const plan = composeReply({ parts: [{ type: 'text', content: '在吗' }, { type: 'at', name: '张三' }] });
  assert.equal(plan.messages.length, 1);
  assert.deepEqual(shape(plan.messages[0]), ['text'], '@ 被丢掉后不该留下空段');
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0], /认不出账号/);
  assert.match(describePlanIssues(plan)[0], /认不出账号/);
});

t('图片段没有来源：丢掉并说出来', () => {
  const plan = composeReply({ parts: [{ type: 'text', content: '看这个' }, { type: 'image' }] });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.skipped.length, 1);
});

t('纯空白/空 parts 排不出任何消息', () => {
  assert.deepEqual(composeReply({ text: '   \n\n  ' }).messages, []);
  assert.deepEqual(composeReply({}).messages, []);
  assert.deepEqual(composeReply({ parts: [] }).messages, []);
  assert.deepEqual(composeReply({ parts: [{ type: 'break' }] }).messages, [], '光一个 break 不该产生空消息');
});

// ---- ReplyBuffer（会话缓冲版的行为） -------------------------------------------

t('capture 产出 messages；后写覆盖先写', () => {
  const buf = new ReplyBuffer({ maxText: 3, maxImages: 9 });
  assert.equal(buf.active, false);
  assert.equal(buf.capture({ text: '第一版\n\n第二版' }).messages.length, 2);
  const second = buf.capture({ text: '只有这句' });
  assert.equal(buf.take().text, '只有这句', '后写覆盖先写');
  assert.equal(buf.active, false);
  assert.equal(second.messages.length, 1);
});

t('capture 的上限来自构造参数（配置钉在这里）', () => {
  const buf = new ReplyBuffer({ maxText: 1, maxImages: 9 });
  const c = buf.capture({ text: '一\n\n二' });
  assert.equal(c.messages.length, 1);
  assert.deepEqual(c.dropped, { text: 1, images: 0 });
});

t('candidate 保留旧字段（segments/text/images/memes），供诊断与旧调用点', () => {
  const buf = new ReplyBuffer();
  const c = buf.capture({ text: '看', images: ['a.png'], quote: '7' });
  assert.equal(c.quote, '7');
  assert.deepEqual(c.segments.map((s) => s.type), ['reply', 'text', 'image']);
  assert.equal(c.text, '看');
  assert.deepEqual(c.images, [{ file: 'a.png', id: null }]);
  assert.equal(buf.capture({ text: '   ' }), null, '空文本应当被忽略');
});

t('describeReply：多条时标出条数，长度仍然有上限', () => {
  assert.equal(describeReply({ text: '短' }), '短');
  const multi = describeReply({ text: '短', messages: [{ kind: 'text' }, { kind: 'image' }], images: [{ file: 'a' }] });
  assert.match(multi, /共 2 条/);
  assert.ok(describeReply({ text: 'x'.repeat(100) }).length <= 60);
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
