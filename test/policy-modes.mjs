/**
 * 策略模式（§19）：把 preset 说出口的每一句**都变成可执行的断言**。
 *
 * 背景（自查发现的"说了没做"）：`README`/设置页早就把 `both`（bridge = 转上游 + 广播其它下游）、
 * `drop`（静默丢弃，连虚拟 message_id 都不给）、`shadow` 的只读（hub 不叫模型、不代答命令）
 * 写成功能，但代码里 `both` 和 `relay` 落了同一个分支、`drop` 连 case 都没有、`readonly`
 * 一个消费者都没有。这个文件就是那三块的验收。
 *
 * 拓扑（全本地，不需要 NoneBot）：
 *
 *   假上游实现端(ws://127.0.0.1:<up>) <—正向WS— hub —拨号—> 假下游 A / B
 *
 * 用法：node test/policy-modes.mjs
 */
import { once } from 'node:events';

import { WebSocket, WebSocketServer } from 'ws';

import { Hub } from '../lib/hub.js';
import { normalizeTargets } from '../lib/index.js';
import { useWs } from '../lib/link.js';
import { Mind } from '../lib/mind.js';
import { describePolicy, resolvePolicy } from '../lib/router.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

// ---------------------------------------------------------------- 纯函数：策略解析
const bridge = resolvePolicy({ preset: 'bridge' });
const shadow = resolvePolicy({ preset: 'shadow' });
const shadowOff = resolvePolicy({ preset: 'shadow', readonly: false });
const relayRo = resolvePolicy({ preset: 'relay', readonly: true });
const relay = resolvePolicy({ preset: 'relay' });

check('P1 bridge 的 action 策略真的是 both（不是悄悄退化成 relay）',
  bridge.action['*'] === 'both' && relay.action['*'] === 'capture',
  { bridge: bridge.action, relay: relay.action });
check('P2 shadow：readonly 打开；配置写 false **关不掉**（不想只读就换预设）',
  shadow.event.readonly === true && shadowOff.event.readonly === true && relay.event.readonly === false,
  { shadow: shadow.event.readonly, shadowOff: shadowOff.event.readonly, relay: relay.event.readonly });
check('P3 任何预设都能用 readonly:true 打开只读（relay + readonly）',
  relayRo.event.readonly === true, relayRo.event.readonly);
check('P4 describePolicy 报出 readonly，且不再有那个从来不是配置项的 captureAll',
  describePolicy(shadow).readonly === true &&
    describePolicy(relay).readonly === false &&
    !('captureAll' in describePolicy(relay)) &&
    !('deliverToSelf' in describePolicy(relay)),
  describePolicy(shadow));

// ---------------------------------------------------------------- 假上游 / 假下游
const upServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(upServer, 'listening');
const UP_PORT = upServer.address().port;
const upActions = [];
let latestUp = null;
upServer.on('connection', (ws) => {
  latestUp = ws;
  ws.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.post_type) return;
      upActions.push(frame);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 90000 + upActions.length }, echo: frame.echo ?? null }));
    } catch {
      /* ignore */
    }
  });
});

/** 一个假下游：收事件、收 hub 发来的 action 请求（并应答，否则 mirror 会等到超时）。 */
async function makeDownstream(name) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = server.address().port;
  const state = { name, server, port, events: [], requests: [], replies: [], headers: [] };
  server.on('connection', (ws, req) => {
    state.headers.push(req.headers);
    state.sock = ws;
    ws.on('message', (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (frame.post_type) {
        state.events.push(frame);
        return;
      }
      if (frame.action) {
        state.requests.push(frame);
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: `got:${name}` }, echo: frame.echo ?? null }));
        return;
      }
      // 没 action、没 post_type = hub 对我刚发出去那条 action 的**应答**。
      if (frame.echo !== undefined) state.replies.push(frame);
    });
  });
  state.url = `ws://127.0.0.1:${port}/onebot/v11/ws`;
  state.conns = () => state.headers.length;
  /** 以这条下游自己的身份发一个 action，拿回 hub 的应答。 */
  state.call = (action, params, echo) => {
    const frame = { action, params, echo };
    state.sock.send(JSON.stringify(frame));
    return waitFor(`hub 应答 ${action}`, () => state.replies.some((r) => r.echo === echo), 5000)
      .then(() => state.replies.find((r) => r.echo === echo));
  };
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

useWs({ WebSocket, WebSocketServer });

function makeHub(config) {
  const log = [];
  // 目标一律走 `normalizeTargets`——生产路径也是这么进来的（`resolveConfig`），
  // 不这么做等于在测试里绕过配置解析，测的就不是真链路了。
  const normalized = config.downstreamTargets
    ? { ...config, downstreamTargets: normalizeTargets(JSON.stringify(config.downstreamTargets)) }
    : config;
  const hub = new Hub(
    {
      upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
      upstreamSelfId: '40004000',
      requestTimeout: 5000,
      reconnectInterval: 60000,
      ...normalized,
    },
    { log: (...parts) => log.push(parts.map(String).join(' ')) },
  );
  hub.logLines = log;
  return hub;
}

const groupEvent = (extra = {}) => ({
  time: Math.floor(Date.now() / 1000),
  self_id: 40004000,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 777,
  user_id: 10001,
  group_id: 55555,
  raw_message: '大家好',
  font: 0,
  sender: { user_id: 10001, nickname: '甲', card: '', role: 'owner' },
  message: [{ type: 'text', data: { text: '大家好' } }],
  ...extra,
});

// ---------------------------------------------------------------- both / bridge：转上游 **同时** 广播
const A = await makeDownstream('A');
const B = await makeDownstream('B');
const hub1 = makeHub({
  preset: 'bridge',
  downstreamTargets: [
    { type: 'ws-dial', address: A.url, selfId: '30001000', nickname: 'down-a', reconnectInterval: 60000 },
    { type: 'ws-dial', address: B.url, selfId: '30002000', nickname: 'down-b', reconnectInterval: 60000 },
  ],
});
hub1.connectUpstream();
hub1.connectDownstreams();
await waitFor('hub1 连上假上游', () => hub1.upstream?.isConnected === true);
await waitFor('A/B 两条下游都连上', () => A.conns() === 1 && B.conns() === 1, 10000);
upActions.length = 0;

const bothReply = await A.call('send_msg', {
  message_type: 'group',
  group_id: 55555,
  message: [{ type: 'text', data: { text: 'bridge 一句话' } }],
}, 'both-1');
await waitFor('B 收到镜像 action', () => B.requests.length >= 1, 5000);

check('B1 both = 转上游（fake 上游真收到 send_msg）',
  upActions.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('bridge 一句话')),
  upActions.map((f) => f.action));
check('B2 both = **同时**广播给其它下游（B 收到 %s 的 action 请求，来源 A 不重复收）',
  B.requests.length === 1 &&
    B.requests[0].action === 'send_msg' &&
    JSON.stringify(B.requests[0].params).includes('bridge 一句话') &&
    A.requests.length === 0,
  { b: B.requests.map((r) => r.action), a: A.requests.length });
check('B3 both 的应答：真上游的 message_id 保留，并报出镜像条数',
  bothReply?.retcode === 0 &&
    bothReply?.data?.message_id === 90000 + upActions.length &&
    bothReply?.data?.mirrored === 1 &&
    bothReply?.data?.mirroredTotal === 1,
  bothReply);
hub1.stop();
await sleep(200);

// ---------------------------------------------------------------- drop vs capture：一个句柄都不给
A.events.length = 0;
A.requests.length = 0;
const hub2 = makeHub({
  preset: 'relay',
  actionPolicy: { send_msg: 'drop' },
  downstreamTargets: [{ type: 'ws-dial', address: A.url, selfId: '30001000', nickname: 'down-a', reconnectInterval: 60000 }],
});
hub2.connectUpstream();
hub2.connectDownstreams();
await waitFor('hub2 连上假上游', () => hub2.upstream?.isConnected === true);
await waitFor('A 重新连上 hub2', () => A.conns() === 2, 10000);
upActions.length = 0;

const dropReply = await A.call('send_msg', {
  message_type: 'group',
  group_id: 55555,
  message: [{ type: 'text', data: { text: '这条会被丢掉' } }],
}, 'drop-1');
check('D1 drop：上游一个字节都没收到，但仍回"成功"（不惊动下游）',
  upActions.length === 0 && dropReply?.status === 'ok' && dropReply?.retcode === 0,
  { actions: upActions.length, reply: dropReply });
check('D2 drop 与 capture 的区别就在**没有句柄**：不给虚拟 message_id',
  dropReply?.data?.message_id === undefined, dropReply?.data);
check('D3 drop 照样留痕（timeline 里是 downstream-out + decision:drop）',
  hub2.timeline.recent(50, { direction: 'downstream-out' }).some((e) => e.decision === 'drop'),
  hub2.timeline.recent(50, { direction: 'downstream-out' }).map((e) => e.decision));

hub2.policy = resolvePolicy({ preset: 'relay', actionPolicy: { send_msg: 'capture' } });
const captureReply = await A.call('send_msg', {
  message_type: 'group',
  group_id: 55555,
  message: [{ type: 'text', data: { text: '只记录' } }],
}, 'cap-1');
check('D4 对照 capture：同样不惊动上游，但给一个虚拟 message_id（下游以为自己发成功了）',
  upActions.length === 0 && typeof captureReply?.data?.message_id === 'string' && captureReply.data.message_id.length > 0,
  captureReply);
hub2.stop();
await sleep(200);

// ---------------------------------------------------------------- 只读（shadow）：hub 不动作，下游照旧看见
A.events.length = 0;
const hub3 = makeHub({
  preset: 'shadow',
  downstreamTargets: [{ type: 'ws-dial', address: A.url, selfId: '30001000', nickname: 'down-a', reconnectInterval: 60000 }],
});
check('R1 shadow 预设让 hub 只读（policyDescription 也这么报）',
  hub3.readonly === true && hub3.policyDescription.readonly === true, hub3.policyDescription);

const mind = new Mind({ hub: hub3, log: (...p) => hub3.logLines.push(p.map(String).join(' ')) });
const observed3 = [];
hub3.hooks.onUpstreamEvent = (entry, info) => {
  const verdict = mind.observe(entry, info);
  observed3.push({ verdict, silent: info?.silent ?? null });
  return verdict;
};
hub3.connectUpstream();
hub3.connectDownstreams();
await waitFor('hub3 连上假上游', () => hub3.upstream?.isConnected === true);
await waitFor('A 连上 hub3', () => A.conns() === 3, 10000);

const seenBefore = mind.stats.observed;
latestUp.send(JSON.stringify(groupEvent({ message_id: 1201 })));
await waitFor('A 收到事件', () => A.events.some((e) => e.message_id === 1201));
check('R2 只读 ≠ 看不见：事件照旧广播给下游',
  A.events.some((e) => e.message_id === 1201), A.events.map((e) => e.message_id));
check('R3 只读：观测计数照记，但**不叫模型**（reason=readonly，readonly 计数 +1）',
  mind.stats.observed > seenBefore && mind.stats.readonly >= 1 && mind.stats.woken === 0,
  { observed: mind.stats.observed, readonly: mind.stats.readonly, woken: mind.stats.woken });

upActions.length = 0;
const refused = await mind.deliver('group:55555', {
  segments: [{ type: 'text', data: { text: '我偏要说' } }],
  text: '我偏要说',
  messageType: 'group',
  groupId: 55555,
});
check('R4 只读：最后一道闸真的发不出去（deliver 直接放弃，上游零字节）',
  refused === null && upActions.length === 0, { refused, actions: upActions.length });

// 命令：只读时"识别 + 记录 + 转发"照旧，只有 hub 那张嘴闭上
hub3.chatCommands = {
  classify: () => ({ act: true, command: 'status', sessionKey: 'group:55555' }),
  run: async () => ({ ok: true, reply: 'hub-status-reply' }),
};
upActions.length = 0;
A.events.length = 0;
latestUp.send(JSON.stringify(groupEvent({ message_id: 1202, raw_message: '/status', message: [{ type: 'text', data: { text: '/status' } }] })));
await waitFor('A 收到那条命令消息', () => A.events.some((e) => e.message_id === 1202));
await sleep(250);
check('R5 只读：命中命令也不代替作答（上游零 send_msg），但**命令消息照旧转发**给下游',
  upActions.length === 0 && A.events.some((e) => e.message_id === 1202),
  { actions: upActions.map((f) => f.action), forwarded: A.events.some((e) => e.message_id === 1202) });
check('R6 只读时命令**不是**被当成"已答"静默的：reason=readonly、silent=null（不冒充已回话）',
  observed3.at(-1)?.verdict?.reason === 'readonly' && observed3.at(-1)?.silent === null && mind.stats.silent === 0,
  { last: observed3.at(-1), silent: mind.stats.silent });
hub3.stop();
await sleep(200);

// 对照组：同一个 stub 命令，非只读的 hub 必须真的回一条
const hub4 = makeHub({
  preset: 'relay',
  downstreamTargets: [{ type: 'ws-dial', address: A.url, selfId: '30001000', nickname: 'down-a', reconnectInterval: 60000 }],
});
hub4.chatCommands = {
  classify: () => ({ act: true, command: 'status', sessionKey: 'group:55555' }),
  run: async () => ({ ok: true, reply: 'hub-status-reply' }),
};
const mind4 = new Mind({ hub: hub4, log: () => {} });
const observed4 = [];
hub4.hooks.onUpstreamEvent = (entry, info) => {
  const verdict = mind4.observe(entry, info);
  observed4.push({ verdict, silent: info?.silent ?? null });
  return verdict;
};
hub4.connectUpstream();
hub4.connectDownstreams();
await waitFor('hub4 连上假上游', () => hub4.upstream?.isConnected === true);
await waitFor('A 连上 hub4', () => A.conns() === 4, 10000);
upActions.length = 0;
latestUp.send(JSON.stringify(groupEvent({ message_id: 1203, raw_message: '/status', message: [{ type: 'text', data: { text: '/status' } }] })));
const replied = await waitFor('非只读 hub 回了那条命令', () =>
  upActions.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('hub-status-reply')), 5000);
check('R7 对照（relay）：同一条命令 hub 真的回话，而模型被静默（不重复说同一句）',
  replied && observed4.at(-1)?.silent === 'chat-command' && observed4.at(-1)?.verdict?.reason === 'chat-command' && mind4.stats.woken === 0,
  { actions: upActions.map((f) => f.action), last: observed4.at(-1), woken: mind4.stats.woken });

hub4.stop();
await sleep(300);

await A.close();
await B.close();
await new Promise((resolve) => upServer.close(() => resolve()));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败：');
  for (const f of failed) console.log(` - ${f.name}  ${JSON.stringify(f.detail)}`);
}
process.exit(failed.length ? 1 : 0);
