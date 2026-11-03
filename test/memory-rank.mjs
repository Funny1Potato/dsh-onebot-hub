/**
 * 事实排序（`lib/memory/rank.js`，`m03601`）。
 *
 * 纯函数，不碰存储、不调模型——所以这里能把它按"判据逐条"测干净：
 * 话题命中 > 参与者 > 字面重叠 > 时间。
 */
import assert from 'node:assert/strict';
import { rankFacts, scoreFact, trimTopics, bigrams } from '../lib/memory/rank.js';

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

const fact = (text, at, extra = {}) => ({ text, at, actor: { user_id: '10001' }, ...extra });

t('命中当前话题的排第一，哪怕它更旧', () => {
  const facts = [
    fact('最近说的一句无关的话', 5000),
    fact('他在聊显卡选哪张', 1000, { topics: ['显卡选购'] }),
  ];
  const out = rankFacts(facts, { topics: [{ id: '显卡选购', text: '显卡选购', participants: [] }] });
  assert.equal(out[0].text, '他在聊显卡选哪张', '话题命中要压过"更新"');
});

t('命中当前话题 2 次 > 1 次：都算话题命中，但次数多的在前', () => {
  const facts = [fact('只挂了一个话题', 9000, { topics: ['a'] }), fact('挂了两个', 100, { topics: ['a', 'b'] })];
  const out = rankFacts(facts, { topics: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(out[0].text, '挂了两个');
});

t('什么信号都没有时：纯按时间倒序（老数据退化成原来的行为）', () => {
  const facts = [fact('早一点', 100), fact('晚一点', 9000), fact('中间', 5000)];
  const out = rankFacts(facts, {});
  assert.deepEqual(out.map((f) => f.text), ['晚一点', '中间', '早一点']);
});

t('空输入不抛，且不修改原数组', () => {
  assert.deepEqual(rankFacts([], {}), []);
  assert.deepEqual(rankFacts(null, {}), []);
  const facts = [fact('a', 1), fact('b', 2)];
  const copy = facts.slice();
  rankFacts(facts, {});
  assert.deepEqual(facts, copy, '排序不能就地改调用方的数组');
});

t('打分口径：话题 8 分/个、字面封顶 3 分，两者相加', () => {
  const hit = scoreFact(fact('x', 1, { topics: ['a', 'b'] }), { topics: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(hit.score, 16, '两个话题命中 = 16');
  const lex = scoreFact(fact('显卡 电源 机箱 内存 固态', 1), { haystack: '显卡 电源 机箱 内存 固态 显示器' });
  assert.ok(lex.score <= 3, );
  const none = scoreFact(fact('完全无关', 1), { topics: [{ id: 'z' }], haystack: '别的' });
  assert.equal(none.score, 0);
});

t('trimTopics：去重、只留最后 3 个、剔空', () => {
  assert.deepEqual(trimTopics(['a', 'b', 'a', '', 'c', 'd']), ['b', 'c', 'd']);
  assert.deepEqual(trimTopics(['a']), ['a']);
  assert.deepEqual(trimTopics(null), []);
});

t('bigrams：中文按两字切，标点与空白不进集合', () => {
  const set = bigrams('显卡，电源！');
  assert.ok(set.has('显卡'));
  assert.ok(set.has('电源'));
  assert.ok(![...set].some((g) => g.includes('，')), '标点不该进 2-gram');
});

const failed = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`  ok  ${c.name}`);
  } catch (err) {
    failed.push({ name: c.name, err });
    console.log(`  FAIL ${c.name}  → ${err?.message ?? err}`);
  }
}
console.log(`\nmemory-rank: ${cases.length - failed.length}/${cases.length} 通过`);
if (failed.length) {
  console.log(JSON.stringify({ passed: cases.length - failed.length, failed: failed.length, cases: failed.map((f) => f.name) }));
  process.exitCode = 1;
}
