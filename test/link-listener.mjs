/**
 * 上游反向 WS 监听端验收：hub 自己监听，等"实现端"拨进来。
 *
 * 场景对应真实现（LLBot-Desktop 的 `ob11.connect[]` 里只有一项
 * `type:"ws-reverse", url:"ws://127.0.0.1:14514/onebot/v11/ws"`，正向 WS 是关的）：
 *  - 实现端拨进来 → 它推事件，hub 收；
 *  - hub 通过同一条链路发 action → 实现端回应；
 *  - 路径/token 不对要拒掉；
 *  - 断开后状态回到 not connected，重连（实现端重拨）后又能用。
 *
 * 跑法：node test/link-listener.mjs
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { UpstreamListener, useWs } from '../lib/link.js';

const ws = await import('ws');
useWs(ws);

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, error: String(err?.message ?? err) });
  }
};
const checkAsync = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, error: String(err?.message ?? err) });
  }
};

const PATH = '/onebot/v11/ws';
const events = [];
let hubSideRequests = [];
let lastError = null;

const listener = new UpstreamListener({
  host: '127.0.0.1',
  port: 0,
  path: PATH,
  requestTimeout: 3000,
  onEvent: (e) => events.push(e),
  onStatus: (s) => {
    lastError = s.lastError;
  },
  log: () => {},
});
listener.start();
await delay(250);

const port = listener.status.url ? Number(listener.status.url.split(':')[2].split('/')[0]) : 0;

check('监听端起在自己的地址上', () => {
  assert.equal(listener.isConnected, false);
  assert.match(listener.status.url, /^ws:\/\/127\.0\.0\.1:\d+\/onebot\/v11\/ws$/);
  assert.equal(listener.status.mode, 'listen');
  assert.ok(port > 0, `未回填端口：${listener.status.url}`);
});

// 路径不对：应被拒（1008）
await checkAsync('路径不匹配的连接被拒绝', async () => {
  const bad = new ws.WebSocket(`ws://127.0.0.1:${port}/wrong/path`, { headers: { 'X-Self-ID': '1' } });
  const code = await new Promise((resolve) => {
    bad.on('close', (c) => resolve(c));
    bad.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 2000);
  });
  assert.ok(code === 1008 || code === 'error', `期望被拒，实际 ${code}`);
  assert.equal(listener.isConnected, false);
});

// 正常拨入：实现端推事件 + 回应 action
const impl = new ws.WebSocket(`ws://127.0.0.1:${port}${PATH}`, {
  headers: { 'X-Self-ID': '3371846367', 'X-Client-Role': 'Universal' },
});
impl.on('message', (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.action) {
    hubSideRequests.push(frame);
    impl.send(JSON.stringify({ status: 'ok', retcode: 0, data: { nickname: 'LLBot' }, echo: frame.echo }));
  }
});
await new Promise((resolve, reject) => {
  impl.on('open', resolve);
  impl.on('error', reject);
});
await delay(120);

check('握手后监听端认为已连接', () => {
  assert.equal(listener.isConnected, true);
  assert.equal(listener.status.connected, true);
  assert.equal(listener.status.connects, 1);
});

await checkAsync('实现端推事件 → onEvent 收到且计数', async () => {
  impl.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, raw_message: 'hi' }));
  await delay(150);
  assert.equal(events.length, 1);
  assert.equal(events[0].raw_message, 'hi');
  assert.equal(listener.status.events, 1);
});

await checkAsync('hub 发 action → 实现端回应 → promise 解出结果', async () => {
  const res = await listener.request('get_login_info', {});
  assert.equal(res.status, 'ok');
  assert.equal(res.data.nickname, 'LLBot');
  assert.equal(hubSideRequests.length, 1);
  assert.equal(hubSideRequests[0].action, 'get_login_info');
});

await checkAsync('实现端断开 → 状态回落，重拨后恢复', async () => {
  impl.close();
  await delay(200);
  assert.equal(listener.isConnected, false);
  assert.equal(listener.status.connected, false);
  assert.ok(listener.status.reconnects >= 1);

  const again = new ws.WebSocket(`ws://127.0.0.1:${port}${PATH}`, { headers: { 'X-Self-ID': '3371846367' } });
  await new Promise((resolve, reject) => {
    again.on('open', resolve);
    again.on('error', reject);
  });
  await delay(120);
  assert.equal(listener.isConnected, true);
  assert.equal(listener.status.connects, 2);
  again.close();
});

await checkAsync('stop() 关掉监听，端口不再可用', async () => {
  listener.stop();
  await delay(150);
  assert.equal(listener.isConnected, false);
});

// token 场景单独起一个
await checkAsync('配了 accessToken 时，不匹配的连接被拒', async () => {
  const guarded = new UpstreamListener({ host: '127.0.0.1', port: 0, path: PATH, accessToken: 'secret', log: () => {} });
  guarded.start();
  await delay(250);
  const p = Number(guarded.status.url.split(':')[2].split('/')[0]);
  const bad = new ws.WebSocket(`ws://127.0.0.1:${p}${PATH}`, { headers: { 'X-Self-ID': '1' } });
  const code = await new Promise((resolve) => {
    bad.on('close', (c) => resolve(c));
    bad.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 2000);
  });
  assert.ok(code === 1008 || code === 'error', `期望被拒，实际 ${code}`);
  const good = new ws.WebSocket(`ws://127.0.0.1:${p}${PATH}`, {
    headers: { 'X-Self-ID': '1', authorization: 'Bearer secret' },
  });
  const ok = await new Promise((resolve) => {
    good.on('open', () => resolve(true));
    good.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 2000);
  });
  assert.equal(ok, true);
  assert.equal(guarded.isConnected, true);
  good.close();
  guarded.stop();
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ok' : 'FAIL'}  ${r.label}${r.ok ? '' : `  → ${r.error}`}`);
console.log(`\nlink-listener: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
if (lastError) console.log(`（状态里记录到的 lastError：${lastError}）`);
