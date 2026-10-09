/**
 * 探针隔离（M7-④，§19）：agent 用 `onebot_invoke` 向下游投一条消息试探时，
 * **怎么保证它的产物和真人消息分得开**。
 *
 * 三档各自证明一件事：
 *   off（默认）——不隔离：注入与真人消息走同一条链路（旧行为）。
 *   link（链路隔离）——上游真人消息一条都不投给探针链路；注入只走那条；
 *                     那条链路的 `send_*` 只捕获不转发上游（探针产物先给 agent 看）。
 *   time（时间隔离）——注入之后该会话开一段独占窗口，窗口内的真人消息**暂缓**投下游、
 *                     窗口一到按原序补发；换会话的消息照常走（隔离是按会话的）；
 *                     队列上限是安全阀：超了立刻补发，绝不吞消息。
 *
 * 全部在本地进程里跑（真假上游 + 假下游），不需要 NoneBot。
 * 用法：node test/isolation.mjs
 */
import { once } from 'node:events';

import { WebSocket, WebSocketServer } from 'ws';

import { Hub } from '../lib/hub.js';
import { useWs } from '../lib/link.js';
import { normalizeTargets, resolveConfig } from '../lib/index.js';
import { decideEvent, resolvePolicy } from '../lib/router.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(30);
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

/** 一个假下游：接 hub 的拨号，把收到的帧攒起来；可以主动发 action（模拟下游插件）。 */
async function makeDownstream(name) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = server.address().port;
  const state = { name, server, port, frames: [], actions: [], sock: null };
  server.on('connection', (ws) => {
    state.sock = ws;
    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString('utf8'));
        if (frame.action) state.actions.push(frame);
        else state.frames.push(frame);
      } catch {
        /* 忽略非 JSON */
      }
    });
  });
  state.url = `ws://127.0.0.1:${port}/onebot/v11/ws`;
  state.conns = () => state.frames.length;
  state.send = (action, params, echo) => state.sock.send(JSON.stringify({ action, params, echo: echo ?? `e${state.actions.length}` }));
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

// ---------------------------------------------------------------- 假上游实现端
const upServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(upServer, 'listening');
const UP_PORT = upServer.address().port;
let upSock = null;
const upActions = [];
upServer.on('connection', (ws) => {
  upSock = ws;
  ws.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.post_type) return;
      upActions.push(frame);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 90001 }, echo: frame.echo ?? null }));
    } catch {
      /* 忽略 */
    }
  });
});

const base = {
  time: Math.floor(Date.now() / 1000),
  self_id: 40004000,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  user_id: 10001,
  group_id: 55555,
  raw_message: '大家好',
  font: 0,
  sender: { user_id: 10001, nickname: '甲', card: '', role: 'owner' },
  message: [{ type: 'text', data: { text: '大家好' } }],
};
const sendUp = (overrides = {}) => upSock.send(JSON.stringify({ ...base, ...overrides }));

useWs({ WebSocket, WebSocketServer });
const hubLog = [];
const logs = (...parts) => hubLog.push(parts.map(String).join(' '));

// ================================================================ 纯函数：probeOnly 比广播更强
{
  const relay = resolvePolicy('relay');
  const solo = resolvePolicy('solo');
  const blocked = decideEvent(relay, { linkId: 'down:p', kind: 'group_message', selfId: '1', targetSelfId: '1', probeOnly: true });
  check('F1 decideEvent：probeOnly 链路对上游消息返回 probe-only-link', blocked.deliver === false && blocked.reason === 'probe-only-link', blocked);
  const soloBlocked = decideEvent(solo, { kind: 'group_message', selfId: '1', targetSelfId: '9', probeOnly: true });
  check('F2 probeOnly 比广播判定更强：solo 的 not:broadcast 之前就拦下', soloBlocked.reason === 'probe-only-link', soloBlocked);
  const allowed = decideEvent(relay, { kind: 'group_message', selfId: '1', targetSelfId: '1', probeOnly: false });
  check('F3 没标 probeOnly 的链路照常放行（不能误伤）', allowed.deliver === true, allowed);
}

// ================================================================ link 档
const a = await makeDownstream('A');
const p = await makeDownstream('P');
const rawLink = JSON.stringify([
  // 两条链路属于**同一个下游**（`downstreamId` 相同）：真实那条与探针那条地址不同、账号不同，
  // 但"问哪个下游"只有一个答案——这正是真实配置的形状（probeSelfId 展开出来的两条共用 downstreamId）。
  { url: a.url, selfId: '30001000', nickname: 'down-a', downstreamId: 'nonebot-a', reconnectInterval: 60000 },
  { url: p.url, selfId: '30001999', nickname: 'down-probe', probeOnly: true, downstreamId: 'nonebot-a', reconnectInterval: 60000 },
]);
const linkTargets = normalizeTargets(rawLink);
check(
  'N1 normalizeTargets 带上 probeOnly / downstreamId（缺省 downstreamId = 该目标自己的键）',
  linkTargets.length === 2 &&
    linkTargets[1].probeOnly === true &&
    linkTargets[1].downstreamId === 'nonebot-a' &&
    linkTargets[0].probeOnly === false &&
    linkTargets[0].downstreamId === 'nonebot-a',
  linkTargets.map((t) => ({ id: t.id, selfId: t.selfId, probeOnly: t.probeOnly, downstreamId: t.downstreamId })),
);

// N2–N5：一条目标自带 `probeSelfId` → 展开成第二条 `probeOnly` 链路（同地址、另一个 bot 账号）。
const expanded = normalizeTargets(JSON.stringify([
  {
    id: 'main',
    url: 'ws://127.0.0.1:8080/onebot/v11/ws',
    selfId: '30001000',
    nickname: 'down-main',
    downstreamId: 'nonebot-main',
    probeSelfId: '30001999',
  },
]), { defaultSelfId: '30001000' });
check(
  'N2 probeSelfId 展开成第二条探针链路（id `~probe`、probeOnly、**同地址同下游组**，只有账号不同）',
  expanded.length === 2 &&
    expanded[0].probeOnly === false &&
    expanded[0].selfId === '30001000' &&
    expanded[0].url === 'ws://127.0.0.1:8080/onebot/v11/ws' &&
    expanded[1].probeOnly === true &&
    expanded[1].id === 'main~probe' &&
    expanded[1].selfId === '30001999' &&
    expanded[1].url === expanded[0].url &&
    expanded[1].address === expanded[0].address &&
    expanded[1].downstreamId === 'nonebot-main' &&
    expanded[0].downstreamId === 'nonebot-main' &&
    expanded[1].nickname === 'down-main',
  expanded.map((t) => ({ id: t.id, url: t.url, selfId: t.selfId, probeOnly: t.probeOnly, downstreamId: t.downstreamId })),
);
const sameAccount = normalizeTargets(JSON.stringify([
  { url: 'ws://127.0.0.1:8080/onebot/v11/ws', selfId: '30001000', probeSelfId: '30001000' },
]));
check(
  'N3 探针账号与主链路账号相同时不展开（下游按 self_id 注册，同 id 第二条会被 Duplicate X-Self-ID 踢掉）',
  sameAccount.length === 1 && sameAccount[0].probeOnly === false,
  sameAccount.map((t) => ({ id: t.id, selfId: t.selfId, probeOnly: t.probeOnly })),
);
const noProbe = normalizeTargets(JSON.stringify([
  { url: 'ws://127.0.0.1:8080/onebot/v11/ws', selfId: '30001000' },
]));
check(
  'N4 没写 probeSelfId 就**不展开**（链路隔离没有默认值：没配就该回退到关闭，而不是凭空多一条链路）',
  noProbe.length === 1 && noProbe[0].probeOnly === false && noProbe[0].selfId === '30001000',
  noProbe.map((t) => ({ id: t.id, selfId: t.selfId, probeOnly: t.probeOnly })),
);
const noId = normalizeTargets(JSON.stringify([
  { url: 'ws://127.0.0.1:8080/onebot/v11/ws', probeSelfId: '30001999' },
]));
check(
  'N5 没写 id 时探针链路用主链路键加 `~probe` 当键，账号仍是探针那个',
  noId.length === 2 &&
    noId[1].id === '127.0.0.1:8080~probe' &&
    noId[1].selfId === '30001999' &&
    noId[1].probeOnly === true &&
    noId[0].selfId === '' &&
    noId[1].url === noId[0].url,
  noId.map((t) => ({ id: t.id, selfId: t.selfId, url: t.url, probeOnly: t.probeOnly })),
);

const hub = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: linkTargets,
    probe: { isolation: 'link', capture: true },
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: logs },
);
hub.connectUpstream();
hub.connectDownstreams();
const upReady = await waitFor('hub 连上假上游', () => hub.upstream?.isConnected === true);
const bothUp = await waitFor('两条下游都连上', () => a.sock !== null && p.sock !== null, 10000);
check('L1 两条下游都连上（各自的 selfId，互不覆盖）', upReady && bothUp, hub.downstreamLinks.map((l) => l.linkId));

const links = hub.downstreamLinks;
check(
  'L2 状态里报出 probeOnly 与 downstreamId，并指出探针链路是哪条',
  links.filter((l) => l.probeOnly === true).length === 1 &&
    links.find((l) => l.probeOnly === true)?.downstreamId === 'nonebot-a' &&
    hub.probeLinkId === `down:${links.find((l) => l.probeOnly === true)?.id}`,
  { probeLink: hub.probeLinkId, links: links.map((l) => ({ linkId: l.linkId, probeOnly: l.probeOnly, downstreamId: l.downstreamId })) },
);

sendUp({ message_id: 7001, raw_message: '群友说话' });
const fanned = await waitFor('A 收到上游消息', () => a.frames.some((f) => f.message_id === 7001));
await sleep(200);
check(
  'L3 link 档：上游真人消息照投普通链路，一条都不投 probeOnly 链路',
  fanned && p.frames.filter((f) => f.message_id === 7001).length === 0,
  { a: a.frames.map((f) => f.message_id), probe: p.frames.map((f) => f.message_id) },
);

upActions.length = 0;
const injectionsBefore = hub.status().probe?.stats?.injections ?? 0;
const injected = hub.sendMessageToDownstream({
  message_type: 'group',
  group_id: 55555,
  user_id: 40004000,
  text: '/probe hi',
});
const gotInjection = await waitFor('探针链路收到注入事件', () => p.frames.some((f) => Number(f.message_id) >= 900000000));
const injectedFrame = p.frames.find((f) => Number(f.message_id) >= 900000000);
check(
  'L4 link 档不给 linkId 时注入默认走 probeOnly 那条，普通链路收不到；帧里的 self_id 重签成探针账号',
  gotInjection &&
    injected.delivered === true &&
    injected.linkId === hub.probeLinkId &&
    a.frames.every((f) => Number(f.message_id) < 900000000) &&
    injectedFrame?.dsh_trace?.extra?.injected === true &&
    String(injectedFrame?.self_id) === '30001999',
  { linkId: injected.linkId, messageId: injected.messageId, selfId: injectedFrame?.self_id, trace: injectedFrame?.dsh_trace },
);

check(
  'L4b 注入结果自己带话：这次走的是探针链路、结果可能与用户触发时不同（agent 不用去翻文档）',
  injected.probeLink?.linkId === hub.probeLinkId &&
    injected.probeLink?.downstreamId === 'nonebot-a' &&
    /可能与用户触发时不同/.test(String(injected.probeLink?.caveat)),
  injected.probeLink,
);

check(
  'L4c 注入事件的说话人就是调用方给的 user_id（工具层允许 agent 指定账号）',
  String(injectedFrame?.user_id) === '40004000' && String(injectedFrame?.sender?.user_id) === '40004000',
  { user_id: injectedFrame?.user_id, sender: injectedFrame?.sender },
);

const injected2 = hub.sendMessageToDownstream({
  message_type: 'group',
  group_id: 55555,
  user_id: 50005000,
  text: '/probe again',
});
const gotInjection2 = await waitFor(
  '探针链路收到第二条注入事件',
  () => p.frames.filter((f) => Number(f.message_id) >= 900000000).length >= 2,
);
const injectedFrame2 = p.frames.filter((f) => Number(f.message_id) >= 900000000).at(-1);
check(
  'L4d 换一个 user_id 就换一个说话人（同一句话不同账号可能不同结果，所以要能指定）',
  gotInjection2 &&
    injected2.messageId !== injected.messageId &&
    String(injectedFrame2?.user_id) === '50005000' &&
    String(injectedFrame2?.sender?.user_id) === '50005000',
  { first: injectedFrame?.user_id, second: injectedFrame2?.user_id, ids: [injected.messageId, injected2.messageId] },
);

// 路由权在枢纽（m02768 真机事故回归）：调用方**点名真实链路**也不许绕过隔离。
a.frames.length = 0;
const injected3 = hub.sendMessageToDownstream({
  linkId: 'down:30001000', // 事故里就是这一手：relay_probe 顺手填了真实链路
  message_type: 'group',
  group_id: 55555,
  text: '/probe forced',
});
const gotInjection3 = await waitFor(
  '第三条注入到达',
  () => p.frames.filter((f) => Number(f.message_id) >= 900000000).length >= 3,
);
check(
  'L4e link 档下点名真实链路也照样走探针链路（隔离不再能被顺手绕过）',
  gotInjection3 &&
    injected3.linkId === hub.probeLinkId &&
    injected3.probeLink?.linkId === hub.probeLinkId &&
    a.frames.every((f) => Number(f.message_id) < 900000000),
  { linkId: injected3.linkId, probeLink: injected3.probeLink?.linkId, realFrames: a.frames.map((f) => f.message_id) },
);

a.frames.length = 0;
const realInject = hub.sendMessageToDownstream({
  downstream: 'down-a', // 用**备注名**点下游（不再是物理链路键）
  allowRealLink: true,
  message_type: 'group',
  group_id: 55555,
  text: '/probe real',
});
const gotReal = await waitFor('真实链路收到注入', () => a.frames.some((f) => Number(f.message_id) >= 900000000));
check(
  'L4f 只有显式 allowRealLink 才允许打真实链路，且结果里必须带 notIsolated 告警',
  gotReal &&
    realInject.linkId === 'down:30001000' &&
    /allowRealLink/.test(String(realInject.notIsolated)) &&
    realInject.probeLink === undefined,
  { sent: realInject, frames: a.frames.map((f) => f.message_id) },
);

let unknownDownstream = '';
try {
  hub.sendMessageToDownstream({ downstream: '没有这个下游', message_type: 'group', group_id: 55555, text: 'x' });
} catch (err) {
  unknownDownstream = String(err?.message ?? err);
}
check(
  'L4g 点错了下游名：明确报错并列出有哪些下游（不静默挑一条投）',
  /没有叫「没有这个下游」/.test(unknownDownstream) && /down-a|down-probe/.test(unknownDownstream),
  unknownDownstream,
);
check(
  'L4h 记录里带人话名字：真实链路与探针链路一眼分得清（多下游命名，m02768）',
  hub.labelOf('down:30001000') === 'down-a' && hub.labelOf('down:30001999') === 'down-probe（探针）',
  { real: hub.labelOf('down:30001000'), probe: hub.labelOf('down:30001999') },
);

// 下游（探针链路）用 send_msg 回一条：默认只捕获不转发上游，且带上 probe/downstreamId 标记。
p.send('send_msg', { message_type: 'group', group_id: 55555, message: [{ type: 'text', data: { text: '探针产物' } }] }, 'probe-send');
const captured = await waitFor('探针产物进时间线（capture）', () =>
  hub.timeline.recent(200).some((e) => e.decision === 'capture' && e.text === '探针产物'),
);
await sleep(200);
check(
  'L5 link 档 + capture：探针链路的 send_msg 只捕获、不转发上游',
  captured && upActions.filter((f) => f.action === 'send_msg').length === 0,
  { upstream: upActions.map((f) => f.action), decision: hub.timeline.recent(50).map((e) => e.decision) },
);
const capEntry = hub.timeline.recent(200).find((e) => e.decision === 'capture' && e.text === '探针产物');
check(
  'L6 捕获的那条标了 probe:true 与 downstreamId（一眼看出是试验结果、属于哪个下游）',
  capEntry?.refs?.probe === true && capEntry?.refs?.downstreamId === 'nonebot-a',
  capEntry?.refs,
);

// 普通链路的 send_msg 照旧转发上游（隔离只管探针那条）。
a.send('send_msg', { message_type: 'group', group_id: 55555, message: [{ type: 'text', data: { text: '正常回复' } }] }, 'normal-send');
const relayed = await waitFor('普通链路的 send_msg 转发到上游', () => upActions.some((f) => f.action === 'send_msg'));
check(
  'L7 普通链路不受影响：它的 send_msg 照旧转上游（隔离不是"全都扣下"）',
  relayed && hub.timeline.recent(200).some((e) => e.text === '正常回复'),
  { actions: upActions.map((f) => f.action) },
);

check(
  'L8 状态里的 probe 段说清档位/探针链路/计数（本节共 4 次注入：默认/换账号/点名真实/allowRealLink）',
  hub.status().probe?.isolation === 'link' &&
    hub.status().probe?.probeLink === hub.probeLinkId &&
    hub.status().probe?.capture === true &&
    hub.status().probe?.stats?.injections === injectionsBefore + 4,
  hub.status().probe,
);

// link 档但没有任何探针链路：**回退到关闭**（假装隔离比明说不隔离更危险），注入照普通链路走。
{
  const lonely = new Hub(
    { upstreamUrl: `ws://127.0.0.1:${UP_PORT}`, upstreamSelfId: '40004000', preset: 'relay', downstreamTargets: linkTargets.slice(0, 1), probe: { isolation: 'link' }, reconnectInterval: 60000 },
    { log: logs },
  );
  lonely.connectUpstream();
  lonely.connectDownstreams();
  await waitFor('lonely 连上假上游', () => lonely.upstream?.isConnected === true);
  await waitFor('lonely 的唯一下游连上', () => lonely.downstreamLinks.some((l) => l.connected === true), 10000);
  const snap = lonely.status().probe;
  check(
    'L9 link 档但一条探针链路都没有：**生效档位回退到 off**，状态里如实说明（requested 还是 link）',
    lonely.probeIsolation === 'off' &&
      snap?.isolation === 'off' &&
      snap?.requested === 'link' &&
      /回退/.test(String(snap?.note)) &&
      lonely.probeLinkId === null,
    snap,
  );
  const fallbackInjected = lonely.sendMessageToDownstream({ message_type: 'group', group_id: 55555, text: 'hi' });
  check(
    'L10 回退之后的注入走那条普通链路（不报错、也不假装用了探针链路）',
    fallbackInjected.delivered === true &&
      fallbackInjected.linkId === 'down:30001000' &&
      fallbackInjected.probeLink === undefined &&
      fallbackInjected.probeWindow === undefined,
    fallbackInjected,
  );
  lonely.stop();
}

hub.stop();
await a.close();
await p.close();

// ================================================================ time 档（显式配）
const t1 = await makeDownstream('T1');
const t2 = await makeDownstream('T2');
const timeTargets = normalizeTargets(
  JSON.stringify([
    { url: t1.url, selfId: '30001000', nickname: 'down-t1', reconnectInterval: 60000 },
    { url: t2.url, selfId: '30002000', nickname: 'down-t2', reconnectInterval: 60000 },
  ]),
);
const hubT = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: timeTargets,
    probe: { isolation: 'time', windowMs: 700, maxQueued: 50 },
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: logs },
);
hubT.connectUpstream();
hubT.connectDownstreams();
await waitFor('hubT 连上假上游', () => hubT.upstream?.isConnected === true);
await waitFor('hubT 两条下游连上', () => t1.sock !== null && t2.sock !== null, 10000);

sendUp({ message_id: 7101, raw_message: '窗口前的消息' });
await waitFor('窗口前的消息先到', () => t1.frames.some((f) => f.message_id === 7101));

const win = hubT.sendMessageToDownstream({ linkId: 'down:30001000', message_type: 'group', group_id: 55555, text: '/probe hi' });
check(
  'T1 time 档：注入之后返回独占窗口（含到期时间），状态里能看到活跃窗口',
  win.delivered === true &&
    win.probeWindow?.isolation === 'time' &&
    win.probeWindow?.until > Date.now() &&
    hubT.status().probe.activeWindows.length === 1 &&
    hubT.status().probe.activeWindows[0].sessionKey === 'group:55555',
  { probeWindow: win.probeWindow, active: hubT.status().probe.activeWindows },
);

t1.frames.length = 0;
sendUp({ message_id: 7102, raw_message: '窗口内的第一条' });
sendUp({ message_id: 7103, raw_message: '窗口内的第二条' });
sendUp({ message_id: 7104, group_id: 66666, raw_message: '别的会话不受影响' });
await sleep(250);
const heldNow = hubT.status().probe;
check(
  'T2 窗口内的上游消息被暂缓（没投下游），队列里等着',
  t1.frames.every((f) => f.message_id !== 7102 && f.message_id !== 7103) &&
    heldNow.activeWindows[0]?.queued === 2 &&
    heldNow.stats.held === 2,
  { frames: t1.frames.map((f) => f.message_id), active: heldNow.activeWindows, stats: heldNow.stats },
);
check(
  'T3 隔离是按会话的：另一个群的消息照常投（群友不该被别的群的探测拖住）',
  t2.frames.some((f) => f.message_id === 7104),
  { t2: t2.frames.map((f) => f.message_id) },
);
const heldRecord = hubT.timeline.recent(300).find((e) => e.decision === 'held:probe-window' && e.refs?.upstreamMessageId === 7102);
check(
  'T4 暂缓不是"没发生"：留痕带 upstreamMessageId（会话卡不会把它当成两件事）',
  heldRecord?.refs?.heldFor === 'probe' && heldRecord?.refs?.probeSessionKey === 'group:55555',
  heldRecord?.refs,
);

const released = await waitFor('窗口到期后按原序补发', () => t1.frames.some((f) => f.message_id === 7103));
const order = t1.frames.filter((f) => [7102, 7103].includes(f.message_id)).map((f) => f.message_id);
check(
  'T5 窗口一到按原序补发（一条不丢、顺序不乱）',
  released && order.join(',') === '7102,7103' && hubT.status().probe.stats.released === 2 && hubT.status().probe.activeWindows.length === 0,
  { order, stats: hubT.status().probe.stats },
);
const releasedMark = hubT.timeline.recent(400).find((e) => e.refs?.probeReleased === true && e.refs?.upstreamMessageId === 7103);
check(
  'T6 补发留痕带 probeReleased 与延后了多久（可审计：晚到多少毫秒）',
  typeof releasedMark?.refs?.probeHeldMs === 'number' && releasedMark.refs.probeHeldMs >= 0,
  releasedMark?.refs,
);

// 队列上限是安全阀：超了立刻按原序补发，绝不吞。
t1.frames.length = 0;
hubT.config.probe.maxQueued = 2;
hubT.config.probe.windowMs = 5000;
hubT.sendMessageToDownstream({ linkId: 'down:30001000', message_type: 'group', group_id: 55555, text: '/probe burst' });
sendUp({ message_id: 7201, raw_message: '一' });
sendUp({ message_id: 7202, raw_message: '二' });
await sleep(120);
const beforeValve = t1.frames.filter((f) => [7201, 7202].includes(f.message_id)).length;
sendUp({ message_id: 7203, raw_message: '三' });
const valve = await waitFor('超限立刻补发', () => [7201, 7202, 7203].every((id) => t1.frames.some((f) => f.message_id === id)));
check(
  'T7 队列超上限（安全阀）：立刻按原序补发全部，一条不吞',
  valve && beforeValve === 0 && t1.frames.filter((f) => [7201, 7202, 7203].includes(f.message_id)).map((f) => f.message_id).join(',') === '7201,7202,7203',
  { frames: t1.frames.map((f) => f.message_id), stats: hubT.status().probe.stats },
);
check(
  'T8 安全阀触发有计数与日志（不是悄悄发生）',
  hubT.status().probe.stats.forcedReleases >= 1 && hubLog.some((line) => line.includes('探针窗口队列超限')),
  { stats: hubT.status().probe.stats },
);

hubT.stop();
await t1.close();
await t2.close();

// ================================================================ off 档
const o1 = await makeDownstream('O1');
const offTargets = normalizeTargets(JSON.stringify([{ url: o1.url, selfId: '30001000', nickname: 'down-o1', reconnectInterval: 60000 }]));
const hubO = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: offTargets,
    probe: { isolation: 'off', capture: true },
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: logs },
);
hubO.connectUpstream();
hubO.connectDownstreams();
await waitFor('hubO 连上假上游', () => hubO.upstream?.isConnected === true);
await waitFor('hubO 下游连上', () => o1.sock !== null, 10000);
o1.frames.length = 0;
const offInject = hubO.sendMessageToDownstream({ linkId: 'down:30001000', message_type: 'group', group_id: 55555, text: '/probe hi' });
await waitFor('off 档注入到达', () => o1.frames.length >= 1);
sendUp({ message_id: 7301, raw_message: '不隔离就该立刻到' });
const offNow = await waitFor('off 档上游消息立刻到', () => o1.frames.some((f) => f.message_id === 7301), 3000);
check(
  'O1 off 档：不开窗口、不暂缓，注入与真人消息混在一条链路上（旧行为）',
  offInject.probeWindow === undefined &&
    hubO.status().probe.activeWindows.length === 0 &&
    hubO.status().probe.stats.windowsOpened === 0 &&
    offNow,
  { probe: hubO.status().probe, frames: o1.frames.map((f) => f.message_id) },
);
hubO.stop();
await o1.close();

// ================================================================ 默认档：什么都不配 = 不隔离
{
  const cfg = resolveConfig({});
  check(
    'O2 默认不隔离：不写 probe.isolation 时是 off（不是隐式开时间隔离——隔离是"用户决定要不要"的事）',
    cfg.probe.isolation === 'off',
    cfg.probe,
  );
  const withProbe = normalizeTargets(
    JSON.stringify([
      { id: 'one', url: 'ws://127.0.0.1:8080/onebot/v11/ws', selfId: '1', probeSelfId: '2' },
      { id: 'two', url: 'ws://127.0.0.1:8081/onebot/v11/ws', selfId: '3' },
    ]),
  );
  check(
    'O3 探针账号只作用在写了它的那条目标上（另一条不凭空多出一条链路）',
    withProbe.length === 3 &&
      withProbe.filter((t) => t.probeOnly === true).length === 1 &&
      withProbe.find((t) => t.probeOnly === true)?.id === 'one~probe' &&
      withProbe.find((t) => t.probeOnly === true)?.url === 'ws://127.0.0.1:8080/onebot/v11/ws',
    withProbe.map((t) => ({ id: t.id, selfId: t.selfId, probeOnly: t.probeOnly })),
  );
}

// ================================================================ 下游发出的媒体也要解析（m02768 任务③）
{
  const m1 = await makeDownstream('M1');
  const mediaTargets = normalizeTargets(
    JSON.stringify([{ url: m1.url, selfId: '30003000', nickname: 'media-bot', reconnectInterval: 60000 }]),
  );
  const hubM = new Hub(
    {
      upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
      upstreamSelfId: '40004000',
      preset: 'relay',
      downstreamTargets: mediaTargets,
      probe: { isolation: 'off' },
      media: { enabled: true },
      requestTimeout: 5000,
      reconnectInterval: 60000,
    },
    { log: logs },
  );
  hubM.connectUpstream();
  hubM.connectDownstreams();
  await waitFor('hubM 连上假上游', () => hubM.upstream?.isConnected === true);
  await waitFor('hubM 下游连上', () => m1.sock !== null, 10000);

  // 1×1 的 PNG（真字节，能过 sniff）：下游常用的 base64:// 写法。
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  m1.send('send_msg', {
    message_type: 'group',
    group_id: 55555,
    message: [{ type: 'image', data: { file: `base64://${png}` } }],
  }, 'm1-send');
  const landed = await waitFor(
    '下游图片落地成媒体引用',
    () => hubM.timeline.recent(50).some((e) => e.direction === 'downstream-in' && (e.refs?.media?.length ?? 0) > 0),
    15000,
  );
  const entry = hubM.timeline.recent(50).find((e) => e.direction === 'downstream-in' && e.action === 'send_msg');
  const cap = hubM.capture.list({ action: 'send_msg', linkId: 'down:30003000' }).at(-1);
  check(
    'M1 下游发出的图片会被解析：落地成媒体引用、文本里带引用号、记录带下游名字',
    landed &&
      (entry?.refs?.media?.length ?? 0) > 0 &&
      /已存为/.test(String(entry?.text)) &&
      entry?.refs?.downstreamLabel === 'media-bot',
    { text: entry?.text, refs: entry?.refs, captureText: cap?.text },
  );
  check(
    'M2 捕获账本里不再塞 base64：内联数据换成占位说明，并给出 mediaRefs（否则一次查询就能撑爆上下文）',
    (cap?.mediaRefs?.length ?? 0) > 0 &&
      !JSON.stringify(cap?.params ?? {}).includes('ErkJggg') &&
      /已落地成媒体引用/.test(String(cap?.params?.message?.[0]?.data?.file ?? '')),
    { mediaRefs: cap?.mediaRefs, file: cap?.params?.message?.[0]?.data?.file },
  );
  hubM.stop();
  await m1.close();
}

// ---------------------------------------------------------------- 收尾
const failed = results.filter((r) => !r.ok);
await new Promise((resolve) => upServer.close(resolve));
await sleep(200);
console.log(`\nisolation: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log(JSON.stringify({ failed, hubLog: hubLog.slice(-25) }, null, 2));
process.exit(failed.length ? 1 : 0);
