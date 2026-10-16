/**
 * 分群额度（`m13404` 第一期：只记不拦）的单元测试。
 *
 * 这里刻意不建 Hub、也不碰宿主：额度账本吃的是**已经到手的** `assistant/message.data.usage`，
 * 所以整套逻辑（去重、折算、解限、报数文案、历史裁剪）都能用纯数据测干净。
 * 真正的接线（订阅宿主会话事件、批次末尾报数行、`.quota` 命令）在 test/load-check.mjs 里对账。
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_QUOTA,
  KEEP_DAYS,
  KEEP_MONTHS,
  QuotaLedger,
  currencySymbol,
  emptyRow,
  formatQuotaValue,
  localDayKey,
  localMonthKey,
  normalizeQuota,
  quotaConfigured,
  quotaLimit,
  quotaOfEntry,
  quotaValue,
} from '../lib/quota.js';

const cases = [];
const pending = [];

function t(name, fn) {
  const entry = { name, ok: true, error: null };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(
        result.then(
          () => {
            entry.ok = true;
          },
          (err) => {
            entry.ok = false;
            entry.error = String(err?.stack ?? err);
          },
        ),
      );
    }
  } catch (err) {
    entry.ok = false;
    entry.error = String(err?.stack ?? err);
  }
  cases.push(entry);
}

/** 造一条 `assistant/message`（宿主事件形状）。 */
const msg = (seq, { input = 0, cache = 0, output = 0, turn = 1 } = {}) => ({
  type: 'assistant/message',
  seq,
  data: { usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output }, turn },
});

/** 内存版 JsonStore：只实现账本用到的那三个方法。 */
function fakeStorage(initial = {}) {
  const files = new Map(Object.entries(initial ?? {}));
  return {
    files,
    read: (file, fallback = null) => (files.has(file) ? files.get(file) : fallback),
    write: (file, data) => {
      files.set(file, data);
      return true;
    },
    schedule: (file, fn) => {
      files.set(file, fn());
      return true;
    },
  };
}

// ------------------------------------------------------------------ 纯函数

t('默认值：示例阈值一律 0 —— 不配就是不限', () => {
  assert.equal(DEFAULT_QUOTA.tokensPerDay, 0, '全局默认表本身也没有示例数字');
  assert.equal(DEFAULT_QUOTA.costPerMonth, 0);
  assert.match(DEFAULT_QUOTA.exhaustedReply, /额度/, '用尽时的固定话术（第二期才发）');
  const q = normalizeQuota({});
  assert.equal(q.enabled, false);
  assert.equal(q.unit, 'token');
  assert.equal(q.tokensPerDay, 0);
  assert.equal(q.tokensPerMonth, 0);
  assert.equal(q.costPerDay, 0);
  assert.equal(q.currency, 'CNY');
  assert.deepEqual(q.price, { input: 0, cache: 0, output: 0 });
  // 开了开关但数值全 0 = 不限，所以不算"配了额度"，报数行也不该出现
  assert.equal(quotaConfigured({ ...q, enabled: true }), false);
  assert.equal(quotaConfigured({ ...q, enabled: true, tokensPerDay: 1 }), true);
});

t('normalizeQuota：容忍字符串数字、负数归零、非法枚举回退', () => {
  const q = normalizeQuota({
    enabled: 'yes',
    unit: '法币',
    tokensPerDay: '200000',
    tokensPerMonth: -5,
    notice: '???',
    currency: '',
    price: { input: '3', cache: -1 },
  });
  assert.equal(q.enabled, false, '只有 true 才算开（配置面写脏不该悄悄开额度）');
  assert.equal(q.unit, 'token', '非法枚举回退默认口径');
  assert.equal(q.tokensPerDay, 200000);
  assert.equal(q.tokensPerMonth, 0, '负数归零');
  assert.equal(q.notice, 'detail');
  assert.equal(q.currency, 'CNY', '空币种回退');
  assert.deepEqual(q.price, { input: 3, cache: 0, output: 0 });
});

t('quotaOfEntry：额度只认白名单条目里那一份，没写就是不限（m14190）', () => {
  const entry = { quota: { enabled: true, unit: 'cost', currency: 'USD', costPerDay: 5, price: { input: 2 } } };
  const q = quotaOfEntry(entry);
  assert.equal(q.enabled, true);
  assert.equal(q.unit, 'cost');
  assert.equal(q.costPerDay, 5);
  assert.equal(q.currency, 'USD');
  assert.equal(q.price.input, 2);
  assert.equal(q.price.output, 0, '没写的补默认，不留上一份的值');
  assert.equal(q.notice, 'detail', '报数口径没写就用默认');
  // 条目里压根没 quota（没勾"启用额度"）＝ `enabled:false`＝不限
  assert.equal(quotaOfEntry({}).enabled, false);
  assert.equal(quotaOfEntry(null).enabled, false);
  assert.equal(quotaOfEntry({ quota: '写坏了' }).enabled, false, '写坏了也别炸，降级成不限');
  // 写坏了的字段照旧能救回来（宽松解析，跟面板里手输的值对得上）
  assert.equal(quotaOfEntry({ quota: { enabled: true, tokensPerDay: '5000' } }).tokensPerDay, 5000);
});

t('用尽话术：不填用默认，清空（空串/空白）也回默认，不该说出字面量 "0"（m14469）', () => {
  const def = quotaOfEntry({ quota: {} }).exhaustedReply;
  assert.equal(def, '本群今天的额度已经用完了，我先歇会儿，明天 00:00 自动恢复。');
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: '' } }).exhaustedReply, def, '清空＝不填＝默认');
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: '   ' } }).exhaustedReply, def, '纯空白也当没填');
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: 0 } }).exhaustedReply, def, '数字 0 不是话术（设置页清空框曾写成 0）');
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: null } }).exhaustedReply, def);
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: '  明天见～  ' } }).exhaustedReply, '明天见～', '写了就用写的，顺手 trim 掉前后空格');
  assert.equal(quotaOfEntry({ quota: { exhaustedReply: 'x'.repeat(400) } }).exhaustedReply.length, 300, '超长截断，别拿一整屏糊群');
  // 想彻底闭嘴是另一件事：onExhaust:'silent'（面板上"用尽后的行为"）
  assert.equal(quotaOfEntry({ quota: { onExhaust: 'silent' } }).onExhaust, 'silent');
});

t('quotaValue：token 口径合算三元组，cost 口径按每百万单价折算', () => {
  const row = { input: 1e6, cache: 2e6, output: 0.5e6 };
  assert.equal(quotaValue(row, { unit: 'token' }), 3.5e6);
  const cost = quotaValue(row, { unit: 'cost', price: { input: 3, cache: 0.3, output: 15 } });
  // 1e6*3 + 2e6*0.3 + 0.5e6*15 = 3 + 0.6 + 7.5
  assert.ok(Math.abs(cost - 11.1) < 1e-9, `cost 折算不对：${cost}`);
  assert.equal(quotaValue(null, { unit: 'token' }), 0, '没记账不是 NaN');
});

t('quotaLimit：按口径取对应的那条限额，enabled 关掉一律 0', () => {
  const q = normalizeQuota({ enabled: true, unit: 'cost', costPerDay: 5, costPerMonth: 100, tokensPerDay: 999 });
  assert.equal(quotaLimit(q, 'day'), 5, 'cost 口径看的是钱那条');
  assert.equal(quotaLimit(q, 'month'), 100);
  assert.equal(quotaLimit({ ...q, enabled: false }, 'day'), 0);
});

t('展示：token 千分位、钱两位小数、币种符号', () => {
  assert.equal(formatQuotaValue(1234567.4, { unit: 'token' }), '1,234,567 token');
  assert.equal(formatQuotaValue(1.239, { unit: 'cost', currency: 'CNY' }), '¥1.24');
  assert.equal(formatQuotaValue(1.239, { unit: 'cost', currency: 'USD' }), '$1.24');
  assert.equal(currencySymbol('EUR'), 'EUR ');
});

t('本地日/月键用本机时区（"当天"＝本地那一天）', () => {
  const at = new Date(2026, 0, 5, 23, 30).getTime(); // 本地 1 月 5 日 23:30
  assert.equal(localDayKey(at), '2026-01-05');
  assert.equal(localMonthKey(at), '2026-01');
});

// ------------------------------------------------------------------ 记账

t('note：只认带 usage 的 assistant/message，日月两行一起累加', () => {
  const ledger = new QuotaLedger({ now: () => Date.parse('2026-03-04T10:00:00') });
  assert.equal(ledger.note('group:1', { type: 'tool/call', data: { usage: { inputTokens: 999 } } }), null);
  assert.equal(ledger.note('group:1', { type: 'assistant/message', data: {} }), null);
  assert.ok(ledger.note('group:1', msg(1, { input: 100, cache: 20, output: 30 })), '带 usage 的 assistant/message 记账');

  ledger.note('group:1', msg(2, { input: 50, cache: 5, output: 15 }));
  const { day, month } = ledger.usage('group:1', Date.parse('2026-03-04T12:00:00'));
  assert.equal(day.input, 150);
  assert.equal(day.cache, 25);
  assert.equal(day.output, 45);
  assert.deepEqual(
    { input: month.input, cache: month.cache, output: month.output },
    { input: 150, cache: 25, output: 45 },
    '月行与日行同增',
  );
  assert.equal(day.firstAt > 0 && day.lastAt > 0, true);
});

t('note：同一会话同一 seq 不重复记账（root 与会话作用域两条订阅都会送）', () => {
  const ledger = new QuotaLedger();
  const event = msg(7, { input: 1000, output: 100 });
  assert.ok(ledger.note('group:2', event, 'sess-a'), '第一次记账');
  assert.equal(ledger.note('group:2', event, 'sess-a'), null, '同一条被第二层作用域再送一次 → 不计');
  assert.equal(ledger.note('group:2', { ...event, seq: 6 }, 'sess-a'), null, '更旧的 seq → 不计');
  assert.ok(ledger.note('group:2', { ...event, seq: 9 }, 'sess-a'), '更新的 seq 照记');
  const { day } = ledger.usage('group:2');
  assert.equal(day.input, 2000, '只记了两次');
});

t('note：轮次按 data.turn 去重（一个回合好几条 assistant/message 只算一轮）', () => {
  const ledger = new QuotaLedger();
  ledger.note('group:3', msg(1, { input: 100, turn: 7 }));
  ledger.note('group:3', msg(2, { input: 100, turn: 7 }));
  ledger.note('group:3', msg(3, { input: 100, turn: 8 }));
  const { day } = ledger.usage('group:3');
  assert.equal(day.input, 300, 'token 该笔该笔都记');
  assert.equal(day.turns, 2, '轮次只算两轮');
});

t('usage：没记账的会话返回 null，而且不顺手建空行', () => {
  const ledger = new QuotaLedger();
  const empty = ledger.usage('group:404');
  assert.equal(empty.day, null);
  assert.equal(empty.month, null);
  assert.equal(ledger.toJSON().agents['group:404'], undefined);
});

t('记账按会话隔离：群与私聊各记各的', () => {
  const ledger = new QuotaLedger();
  ledger.note('group:1', msg(1, { input: 100 }));
  ledger.note('private:9', msg(1, { input: 999 }));
  assert.equal(ledger.usage('group:1').day.input, 100);
  assert.equal(ledger.usage('private:9').day.input, 999);
});

// ------------------------------------------------------------------ 解限

t('waive：解限不减账，只让"剩余"变多；不给金额就是抹掉当期已用', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:5', msg(1, { input: 1000, output: 500 }));
  const cfg = normalizeQuota({ enabled: true, tokensPerDay: 10000 });
  assert.match(ledger.render('group:5', cfg, at), /剩余 85\.0%/);

  ledger.waive('group:5', { scope: 'day', by: '123', amount: 1500 });
  assert.equal(ledger.usage('group:5').day.input, 1000, '原始账不动');
  assert.equal(ledger.waived('group:5', 'day', localDayKey(at)), 1500);
  // 第二句报数要越过冷却（默认 10 分钟）才准出。
  assert.match(ledger.render('group:5', cfg, at + 11 * 60 * 1000), /剩余 100\.0%/, '解掉 1500 正好补回');
  assert.match(ledger.describe('group:5', cfg), /已解限 1,500 token/, '解限在明细里如实写出');
  assert.equal(ledger.waiversOf('group:5').length, 1);
});

t('waive：月口径的解限不该影响当日余额', () => {
  const ledger = new QuotaLedger({ now: () => Date.parse('2026-03-04T10:00:00') });
  ledger.note('group:6', msg(1, { input: 1000 }));
  ledger.waive('group:6', { scope: 'month', amount: 1000 });
  assert.equal(ledger.waived('group:6', 'month', localMonthKey(Date.parse('2026-03-04T10:00:00'))), 1000);
  assert.equal(ledger.waived('group:6', 'day', localDayKey(Date.parse('2026-03-04T10:00:00'))), 0);
});

// ------------------------------------------------------------------ 报数行

t('render：没配额度就完全不出声（默认关闭不打扰）', () => {
  const ledger = new QuotaLedger();
  ledger.note('group:7', msg(1, { input: 1000 }));
  assert.equal(ledger.render('group:7', normalizeQuota({})), '');
  assert.equal(ledger.render('group:7', normalizeQuota({ enabled: true })), '', '开了开关但全 0 = 不限，也不出声');
});

t('render：detail / percent / off 三种口径', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:8', msg(1, { input: 400, cache: 100, output: 500 }));
  const base = { enabled: true, tokensPerDay: 10000, noticeHint: false };
  const detail = ledger.render('group:8', normalizeQuota(base), at);
  assert.match(detail, /^\[额度\] 本群 /);
  assert.match(detail, /今日 已用 1,000 token \/ 10,000 token（剩余 90\.0%）· 明日 00:00 重置/);
  const later = at + 11 * 60 * 1000;
  const percent = ledger.render('group:8', normalizeQuota({ ...base, notice: 'percent' }), later);
  assert.match(percent, /今日剩余 90\.0%/);
  assert.doesNotMatch(percent, /明日 00:00/);
  assert.equal(ledger.render('group:8', normalizeQuota({ ...base, notice: 'off' }), at), '');
});

t('render：私聊口径说"本私聊"，cost 口径带币种，noticeHint 加内部提醒', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('private:7', msg(1, { input: 1e6, output: 1e6 }));
  const cost = normalizeQuota({ enabled: true, unit: 'cost', costPerDay: 20, price: { input: 3, output: 9 } });
  const out = ledger.render('private:7', cost, at);
  assert.match(out, /本私聊/);
  assert.match(out, /已用 ¥12\.00 \/ ¥20\.00/);
  assert.match(out, /仅内部参考，不要轻易播报额度/, '默认提醒模型这是内部参考、且别随口往外说（m14543）');
  assert.doesNotMatch(
    ledger.render('private:7', normalizeQuota({ ...cost, noticeHint: false }), at + 11 * 60 * 1000),
    /不要轻易播报/,
  );
});

t('render：冷却挡得住话痨群，但"快到/已经超"不挡（要超了正是模型该知道的时候）', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:12', msg(1, { input: 1000 }));
  const q = normalizeQuota({ enabled: true, tokensPerDay: 100000, noticeCooldownMs: 600000 });
  assert.match(ledger.render('group:12', q, at), /剩余 99\.0%/);
  assert.equal(ledger.render('group:12', q, at + 60 * 1000), '', '冷却期内不出声');
  assert.match(ledger.render('group:12', q, at + 601 * 1000), /剩余 99\.0%/, '过了冷却再说');
  assert.match(
    ledger.render('group:12', normalizeQuota({ ...q, noticeCooldownMs: 0 }), at + 602 * 1000),
    /剩余 99\.0%/,
    '冷却设 0 = 每批都报',
  );
  // 逼近限额（剩余 ≤ 10%）不受冷却限制
  const hot = normalizeQuota({ enabled: true, tokensPerDay: 1050, noticeCooldownMs: 600000 });
  assert.match(ledger.render('group:12', hot, at), /剩余 4\.8%/);
  assert.match(ledger.render('group:12', hot, at + 60 * 1000), /剩余 4\.8%/, '快超了每批都报');
  // 已经超了更不能被冷却盖住
  const over = normalizeQuota({ enabled: true, tokensPerDay: 1000, noticeCooldownMs: 600000 });
  assert.match(ledger.render('group:12', over, at), /剩余 0\.0%/);
  assert.match(ledger.render('group:12', over, at + 60 * 1000), /剩余 0\.0%/, '已超：每批都报');
});

t('state：日/月的 used/left/over 如实，解限后立刻不再超（不用清零）', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:13', msg(1, { input: 1000 }));
  const q = normalizeQuota({ enabled: true, tokensPerDay: 1000, tokensPerMonth: 100000 });
  const before = ledger.state('group:13', q, at);
  assert.equal(before.exhausted, true);
  assert.equal(before.scope, 'day');
  assert.equal(before.day.used, 1000);
  assert.equal(before.day.left, 0);
  assert.equal(before.day.over, true);
  assert.equal(before.month.over, false);
  assert.equal(before.month.left, 99000);

  ledger.waive('group:13', { scope: 'day', by: '1', amount: 400 });
  const after = ledger.state('group:13', q, at);
  assert.equal(after.day.used, 600, '已用里减掉解限额');
  assert.equal(after.day.left, 400);
  assert.equal(after.exhausted, false, '解限即恢复，不需要清零');
  assert.equal(after.scope, null);
  assert.equal(ledger.usage('group:13', at).day.input, 1000, '原始账仍然不动');
});

t('state：没配额度一律不算超（默认关闭＝不拦）', () => {
  const ledger = new QuotaLedger();
  assert.equal(ledger.state('group:14', normalizeQuota({})).exhausted, false);
  assert.equal(ledger.state('group:14', normalizeQuota({ enabled: true })).exhausted, false);
});

t('render：日月两条限额都在就都报，谁先到听谁的文案由限额各自给', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:9', msg(1, { input: 250000 }));
  const out = ledger.render('group:9', normalizeQuota({ enabled: true, tokensPerDay: 500000, tokensPerMonth: 1000000, noticeHint: false }), at);
  assert.match(out, /今日 已用 250,000 token \/ 500,000 token（剩余 50\.0%）/);
  assert.match(out, /本月 已用 250,000 token \/ 1,000,000 token（剩余 75\.0%）· 下月 1 日重置/);
});

t('describe：没配额度要说清怎么配，别只丢一句"没配"', () => {
  const ledger = new QuotaLedger();
  const out = ledger.describe('group:10', normalizeQuota({}));
  assert.match(out, /没配额度/);
  assert.match(out, /enabled:true/);
  assert.match(out, /groups\/privates/);
});

t('describe：配了就给已用/限额/剩余/原始计数与单价', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:11', msg(1, { input: 100, cache: 20, output: 30 }));
  const q = normalizeQuota({ enabled: true, unit: 'cost', costPerMonth: 100, price: { input: 2, cache: 0.5, output: 6 } });
  const out = ledger.describe('group:11', q, at);
  assert.match(out, /本群额度（按钱（CNY））/);
  assert.match(out, /本月：已用 ¥0\.00 \/ ¥100\.00（剩余 100\.0%），下月 1 日重置/);
  assert.match(out, /原始计数：input 100 · cache 20 · output 30 · 1 轮（今日）/);
  assert.match(out, /单价：input ¥2\/百万 · cache ¥0\.5\/百万 · output ¥6\/百万/);
  assert.doesNotMatch(out, /今日：/, '只配了月限额就不该编出今日那条');
});

// ------------------------------------------------------------------ 落盘

t('落盘：走 storage 的 read/schedule，重启后账还在', () => {
  const storage = fakeStorage();
  const at = Date.parse('2026-03-04T10:00:00');
  const first = new QuotaLedger({ storage, now: () => at });
  first.note('group:12', msg(1, { input: 700, output: 300 }));
  first.waive('group:12', { scope: 'day', amount: 200, by: '123' });

  const second = new QuotaLedger({ storage, now: () => at });
  assert.equal(second.usage('group:12', at).day.input, 700, '重启后读得回来');
  assert.equal(second.waived('group:12', 'day', localDayKey(at)), 200, '解限记录也在');
});

t('落盘：坏文件/坏形状不抛账本一命呜呼，只当没有历史', () => {
  for (const bad of [null, {}, { version: 1 }, { agents: null }, { agents: { 'group:x': 'nope' } }]) {
    const storage = fakeStorage(bad ? { 'quota/ledger.json': bad } : {});
    const ledger = new QuotaLedger({ storage });
    assert.equal(ledger.usage('group:x').day, null);
  }
});

t('prune：日行留 KEEP_DAYS 天、月行留 24 个月，老账丢掉', () => {
  const at = Date.parse('2026-03-04T10:00:00');
  const ledger = new QuotaLedger({ now: () => at });
  ledger.note('group:13', msg(1, { input: 10 }));
  const oldDay = localDayKey(at - (KEEP_DAYS + 5) * 86400000);
  const oldMonth = localMonthKey(at - (KEEP_MONTHS * 31 + 60) * 86400000);
  const entry = ledger.usage('group:13', at).entry;
  entry.days[oldDay] = emptyRow();
  entry.months[oldMonth] = emptyRow();
  ledger.prune(at);
  assert.equal(entry.days[oldDay], undefined, '过期日行丢掉');
  assert.equal(entry.months[oldMonth], undefined, '过期月行丢掉');
  assert.ok(entry.days[localDayKey(at)], '当期还在');
});

t('空键与垃圾输入：note 用空 agentKey 不记账', () => {
  const ledger = new QuotaLedger();
  assert.equal(ledger.note('', msg(1, { input: 100 })), null);
  assert.equal(ledger.note(null, null), null);
});

await Promise.all(pending);
const failed = cases.filter((entry) => !entry.ok);
console.log(JSON.stringify({ passed: cases.length - failed.length, failed: failed.length, cases: failed }, null, 2));
