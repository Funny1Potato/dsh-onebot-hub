/**
 * 「OneBot 日志」的两块：环形缓冲（`lib/logbus.js`）与两条路由（`lib/log/route.js`）。
 *
 * 测什么：缓冲不会无限长、序号不断档、脱敏真的抹掉了密钥、SSE 先补旧再推新且能收尾。
 * 不测什么：面板长什么样（那是 `client-render` 的事，而且这里没有 DOM）。
 */
import assert from 'node:assert/strict';
import { LogBus, redact } from '../lib/logbus.js';
import { createLogRecentHandler, createLogStreamHandler, LOG_RECENT_PATH, LOG_STREAM_PATH } from '../lib/log/route.js';

const cases = [];
const t = (name, fn) => cases.push({ name, fn });

/** 假响应：把写进来的东西攒着，方便断言。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    listeners: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.ended = true;
    },
    on(ev, fn) {
      (this.listeners[ev] ??= []).push(fn);
    },
    emit(ev) {
      for (const fn of this.listeners[ev] ?? []) fn();
    },
    get body() {
      return this.chunks.join('');
    },
  };
  return res;
}

t('环形缓冲：超过上限只留最近的，丢了几条如实记', () => {
  const bus = new LogBus({ limit: 50, now: () => 1000 });
  for (let i = 0; i < 60; i += 1) bus.push({ kind: 'system', summary: `第 ${i} 条` });
  assert.equal(bus.size, 50, '容量就是上限');
  const rows = bus.recent(50);
  assert.equal(rows[rows.length - 1].summary, '第 59 条', '留下的必须是最新的');
  assert.equal(bus.stats().dropped, 10);
  assert.equal(bus.seq, 60, '序号不因为覆盖而回退');
});

t('recent：给了 after 就只回更新的那几条（面板增量补）', () => {
  const bus = new LogBus({ limit: 10, now: () => 1 });
  for (let i = 0; i < 5; i += 1) bus.push({ kind: 'system', summary: `s${i}` });
  const all = bus.recent(10);
  assert.equal(all.length, 5);
  const after = bus.recent(10, { after: 3 });
  assert.deepEqual(after.map((row) => row.seq), [4, 5]);
});

t('clear：清空缓冲但不重置序号（否则订阅方以为全丢了）', () => {
  const bus = new LogBus({ limit: 10, now: () => 1 });
  bus.push({ kind: 'system', summary: 'a' });
  bus.push({ kind: 'system', summary: 'b' });
  const seq = bus.clear();
  assert.equal(seq, 2);
  assert.equal(bus.size, 0);
  assert.equal(bus.push({ kind: 'system', summary: 'c' }), 3, '清空后序号接着走');
});

t('订阅：能退订，且一个订阅者抛错不影响别的', () => {
  const bus = new LogBus({ limit: 10, now: () => 1 });
  const got = [];
  bus.subscribe(() => {
    throw new Error('这个订阅者坏了');
  });
  const off = bus.subscribe((row) => got.push(row.summary));
  bus.push({ kind: 'system', summary: 'x' });
  assert.deepEqual(got, ['x'], '坏订阅者不能把这条吞掉');
  off();
  bus.push({ kind: 'system', summary: 'y' });
  assert.deepEqual(got, ['x'], '退订后不再收到');
  assert.equal(bus.stats().subscribers, 1, '只剩那个坏的还在');
});

t('脱敏：token / secret / apikey / cookie 一律抹掉，正文照留', () => {
  const out = redact({
    action: 'send_group_msg',
    accessToken: 'abc123',
    nested: { apiKey: 'k-1', authorization: 'Bearer zzz', text: '群里的话' },
    list: [{ password: 'p' }, '短字符串'],
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('abc123'), 'accessToken 不该出现');
  assert.ok(!text.includes('k-1'), 'apiKey 不该出现');
  assert.ok(!text.includes('Bearer zzz'), 'authorization 不该出现');
  assert.ok(!text.includes('"p"'), 'password 不该出现');
  assert.ok(text.includes('群里的话'), '正文要留着，否则面板没意义');
  assert.ok(text.includes('send_group_msg'));
});

t('脱敏：超长字符串截断，且能处理循环引用（不抛）', () => {
  const long = 'x'.repeat(5000);
  const out = redact({ text: long });
  assert.ok(JSON.stringify(out).length < 4500, '长正文要截断');
  const cyc = { name: 'a' };
  cyc.self = cyc;
  assert.doesNotThrow(() => redact(cyc), '循环引用不能把面板拖崩');
});

t('最近这条路由：返回 stats 与 rows，没有缓冲就说清楚', () => {
  const bus = new LogBus({ limit: 10, now: () => 1 });
  bus.push({ kind: 'upstream', direction: 'in', summary: '收到一条' });
  const res = fakeRes();
  createLogRecentHandler(() => bus)({ url: `${LOG_RECENT_PATH}?n=10` }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.rows.length, 1);
  assert.equal(body.stats.size, 1);

  const res2 = fakeRes();
  createLogRecentHandler(() => null)({ url: LOG_RECENT_PATH }, res2);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.ok, false, '没有缓冲要如实说，别假装空列表');
});

t('SSE：先补缓冲再推新条目，关连接时退订并停心跳', () => {
  const bus = new LogBus({ limit: 10, now: () => 1 });
  bus.push({ kind: 'upstream', direction: 'in', summary: '旧的' });

  const timers = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn) => {
    timers.push(fn);
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};
  try {
    const res = fakeRes();
    createLogStreamHandler(() => bus)({ url: LOG_STREAM_PATH }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /retry: 3000/, '重连提示要发');
    assert.match(res.body, /旧的数据|旧的/, '缓冲里那条要先补上');

    const before = bus.stats().subscribers;
    assert.equal(before, 1, '已经订阅上了');
    bus.push({ kind: 'agent', direction: 'out', summary: '新的' });
    assert.match(res.body, /新的/, '新条目要实时推');

    // 两个定时器：一条立即推 stats（右上那行数字），一条心跳保活。
    assert.equal(timers.length, 2, '要起 stats 与心跳两个定时器');
    assert.match(res.body, /event: stats/, '要推一条 stats 帧');
    for (const fn of timers) fn();
    assert.match(res.body, /: ping/, '心跳是一条注释行');

    res.emit('close');
    assert.equal(bus.stats().subscribers, 0, '关连接必须退订，否则缓冲里堆监听');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
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
console.log(`\nlogbus: ${cases.length - failed.length}/${cases.length} 通过`);
if (failed.length) {
  console.log(JSON.stringify({ passed: cases.length - failed.length, failed: failed.length, cases: failed.map((f) => f.name) }));
  process.exitCode = 1;
}
