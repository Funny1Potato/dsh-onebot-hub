/**
 * 多下游（§19）：一个 hub 同时连**多条**下游链路，像 LLBot 的 `ob11.connect[]` 那样。
 *
 * 拓扑（全部在本地进程里，不需要 NoneBot）：
 *
 *   假上游实现端(ws://127.0.0.1:<up>) <——正向WS—— hub ——拨号——> 假下游 A / B / D
 *                                                              C 配了但 enabled:false
 *
 * 验收点：
 *   1 `connectDownstreams()` 只拨启用的（3/4），被禁用的那条一个连接都不发
 *   2 上游一条群消息 → **A/B/D 三条下游都收到**（多下游的核心语义）
 *   3 每条下游拿到的事件 `self_id` 各自重签成它自己的账号（互不串）
 *   4 `downstreamLinks` 把"配了没拨/没连上"的也列出来（否则分不清"没配"和"连不上"）
 *   5 按 **id** 寻址：`down:30002` 只投第二条，别的链路一个字节都不多收
 *   6 同 selfId 的两条目标（不同 url）经 `normalizeTargets` 后 id 分别是
 *     `30001000` / `30001000#2`，两条**各自独立**连上、链路 id 不互相覆盖
 *
 * 用法：node test/multi-downstream.mjs
 */
import { once } from 'node:events';
import { createServer } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { Hub } from '../lib/hub.js';
import { useWs } from '../lib/link.js';
import { normalizeDownstreamType, normalizeTargets } from '../lib/index.js';

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

/** 一个假下游：接受 hub 的拨号，把收到的帧攒起来。 */
async function makeDownstream(name) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = server.address().port;
  const state = { name, server, port, frames: [], headers: [], firstMessageId: null };
  server.on('connection', (ws, req) => {
    state.headers.push(req.headers);
    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString('utf8'));
        state.frames.push(frame);
        if (frame.post_type && state.firstMessageId === null) state.firstMessageId = frame.message_id;
      } catch {
        /* 忽略非 JSON */
      }
    });
  });
  state.url = `ws://127.0.0.1:${port}/onebot/v11/ws`;
  state.conns = () => state.headers.length;
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
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: frame.echo ?? null }));
    } catch {
      /* ignore */
    }
  });
});

const a = await makeDownstream('A');
const b = await makeDownstream('B');
const c = await makeDownstream('C'); // 配置里 enabled:false，不该有人连它
const d = await makeDownstream('D'); // 与 A 同 selfId，换一个 url

const raw = JSON.stringify([
  { url: a.url, selfId: '30001000', nickname: 'down-a', reconnectInterval: 60000 },
  { url: b.url, selfId: '30002000', nickname: 'down-b', reconnectInterval: 500 },
  { url: c.url, selfId: '30003000', nickname: 'down-c', enabled: false, reconnectInterval: 60000 },
  { url: d.url, selfId: '30001000', nickname: 'down-d', reconnectInterval: 60000 },
]);
const targets = normalizeTargets(raw);
check('N1 normalizeTargets：四条都留着（含被禁用的），id 去重成 30001000 / 30001000#2',
  targets.length === 4 &&
    targets.map((t) => t.id).join(',') === '30001000,30002000,30003000,30001000#2' &&
    targets[2].enabled === false &&
    targets[0].reconnectInterval === 60000,
  targets);

useWs({ WebSocket, WebSocketServer });
const hubLog = [];
const hub = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: targets,
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: (...parts) => hubLog.push(parts.map(String).join(' ')) },
);
hub.connectUpstream();
const started = hub.connectDownstreams();
check('D1 connectDownstreams() 只拨启用条目（4 条里 3 条）', started === 3, { started, log: hubLog.slice(-3) });

const upConnected = await waitFor('hub 连上假上游', () => hub.upstream?.isConnected === true);
check('D2 上游链路建立', upConnected === true, hub.upstream?.status);
const allUp = await waitFor('三条启用的下游都拨通', () => a.conns() === 1 && b.conns() === 1 && d.conns() === 1, 10000);
check('D3 A/B/D 三条下游都连上了', allUp, { a: a.conns(), b: b.conns(), d: d.conns() });

await sleep(300);
check('D4 被禁用那条（C）一个连接都没收到', c.conns() === 0, { c: c.conns() });

const links = hub.downstreamLinks;
check('D5 downstreamLinks 列出全部 4 条（含禁用的那条，connected:false / enabled:false）',
  links.length === 4 &&
    links.filter((l) => l.connected).length === 3 &&
    links.some((l) => l.id === '30003000' && l.enabled === false && l.connected === false) &&
    links.every((l) => l.url),
  links.map((l) => ({ id: l.id, url: l.url, connected: l.connected, enabled: l.enabled, reconnects: l.reconnects })));
check('D6 同一个 selfId 的两条目标各占一条链路（linkId 不互相覆盖）',
  links.filter((l) => l.selfId === '30001000').length === 2 &&
    links.some((l) => l.linkId === 'down:30001000') &&
    links.some((l) => l.linkId === 'down:30001000#2'),
  links.filter((l) => l.selfId === '30001000').map((l) => l.linkId));

// ---------------------------------------------------------------- 上游一条消息 → 三条下游都收到
const event = {
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
};
upSock.send(JSON.stringify(event));

const fanned = await waitFor('三条下游都收到同一条事件', () => a.frames.length >= 1 && b.frames.length >= 1 && d.frames.length >= 1);
const gotA = a.frames.find((f) => f.message_id === 777);
const gotB = b.frames.find((f) => f.message_id === 777);
const gotD = d.frames.find((f) => f.message_id === 777);
check('M1 上游一条群消息广播给 A/B/D 三条下游', fanned && Boolean(gotA) && Boolean(gotB) && Boolean(gotD),
  { a: a.frames.length, b: b.frames.length, d: d.frames.length, c: c.frames.length });
check('M2 每条下游拿到的 self_id 是自己的账号（互不串）',
  String(gotA?.self_id) === '30001000' && String(gotB?.self_id) === '30002000' && String(gotD?.self_id) === '30001000',
  { a: gotA?.self_id, b: gotB?.self_id, d: gotD?.self_id });
check('M3 事件内容保真（raw_message / message_id / group_id / 段序）',
  gotA?.raw_message === '大家好' && gotA?.group_id === 55555 && gotA?.message?.[0]?.data?.text === '大家好' &&
    gotB?.raw_message === '大家好' && gotD?.raw_message === '大家好',
  { a: gotA, b: gotB?.raw_message, d: gotD?.raw_message });
check('M4 被禁用的 C 一条事件都没收到', c.frames.length === 0, { c: c.frames.length });
check('M5 timeline 里三条 downstream-out 各记一笔',
  hub.timeline.recent(50, { direction: 'downstream-out' }).filter((e) => e.refs?.upstreamMessageId === 777).length === 3,
  hub.timeline.recent(50, { direction: 'downstream-out' }).map((e) => e.linkId));

// ---------------------------------------------------------------- 按 id 精确寻址
a.frames.length = 0;
d.frames.length = 0;
b.frames.length = 0;
const injected = hub.sendMessageToDownstream({
  linkId: 'down:30002000',
  message_type: 'group',
  group_id: 55555,
  text: '只给 B 的一句',
});
await sleep(400);
check('I1 按 id 注入：只投 B（A 与 D 一个字节都不多收）',
  injected.delivered === true && b.frames.some((f) => JSON.stringify(f).includes('只给 B 的一句')) && a.frames.length === 0 && d.frames.length === 0,
  { delivered: injected.delivered, a: a.frames.length, b: b.frames.length, d: d.frames.length });

const byAlias = hub.sendMessageToDownstream({
  linkId: '30001000#2',
  message_type: 'group',
  group_id: 55555,
  text: '只给 D 的一句',
});
await sleep(400);
check('I2 裸 id 也能寻址（`30001000#2` = 第四条目标 D）',
  byAlias.delivered === true && d.frames.some((f) => JSON.stringify(f).includes('只给 D 的一句')),
  { delivered: byAlias.delivered, d: d.frames.map((f) => f.raw_message ?? f.message) });

// ---------------------------------------------------------------- 断线重连（各自的间隔）
const beforeReconnects = hub.downstreamLinks.find((l) => l.id === '30001000')?.reconnects ?? 0;
b.server.clients.forEach((client) => client.close(1000, '测试主动断开'));
const reconnected = await waitFor('B 断线后自己重连回来（reconnects 计数增加）', () => {
  const link = hub.downstreamLinks.find((l) => l.id === '30002000');
  return link?.connected === true && (link.reconnects ?? 0) > 0 && b.conns() >= 2;
}, 10000);
check('R1 单条下游断线只影响它自己，且按自己的间隔重连（A/D 不受影响）',
  reconnected && a.conns() === 1 && d.conns() === 1,
  { b: { conns: b.conns(), reconnects: hub.downstreamLinks.find((l) => l.id === '30002000')?.reconnects }, a: a.conns(), d: d.conns(), beforeReconnects });

// ---------------------------------------------------------------- 四种连接形态（§19）
// 上一段验的是"拨号型 × N"；这一段验其余三种：ws-listen（对方拨进来）、http-post（我们推给它）、
// http-api（对方 POST action 给我们）。换个干净实例，免得两条上游连接互相干扰。
hub.stop();
await sleep(200);

const posted = [];
const postServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    posted.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await once(postServer.listen(0, '127.0.0.1'), 'listening');
const POST_PORT = postServer.address().port;

const targets2 = normalizeTargets(JSON.stringify([
  { id: 'E', type: 'ws-listen', address: '127.0.0.1:0/onebot/v11/ws', nickname: 'listen-e' },
  { id: 'G', type: 'http-api', address: '127.0.0.1:0/onebot/v11', nickname: 'api-g', accessToken: 'apitok' },
  { id: 'F', type: 'http-post', address: `127.0.0.1:${POST_PORT}/events`, selfId: '30008000', nickname: 'post-f' },
]));
check(
  'T1 类型别名都认：ws-reverse→ws-dial / ws→ws-listen / http→http-api / http_post→http-post',
  normalizeDownstreamType('ws-reverse') === 'ws-dial' &&
    normalizeDownstreamType('ws') === 'ws-listen' &&
    normalizeDownstreamType('http') === 'http-api' &&
    normalizeDownstreamType('http_post') === 'http-post' &&
    targets2.map((t) => t.type).join(',') === 'ws-listen,http-api,http-post',
  targets2,
);

const hub2 = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: targets2,
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: (...parts) => hubLog.push(parts.map(String).join(' ')) },
);
hub2.connectUpstream();
check('T2 三种形态都登记成功', hub2.connectDownstreams() === 3, hub2.downstreamLinks.map((l) => [l.id, l.type, l.listening]));

const listeningBoth = await waitFor('两个监听型目标真的在听', () =>
  hub2.downstreamLinks.filter((l) => l.listening === true).length === 2, 8000);
const linkE = hub2.downstreamLinks.find((l) => l.id === 'E');
const linkG = hub2.downstreamLinks.find((l) => l.id === 'G');
check(
  'T3 ws-listen / http-api 各自绑到自己的端口，状态里给出的 url 是真的',
  listeningBoth &&
    linkE.type === 'ws-listen' && /^ws:\/\/127\.0\.0\.1:\d+\/onebot\/v11\/ws$/.test(linkE.url ?? '') &&
    linkG.type === 'http-api' && /^http:\/\/127\.0\.0\.1:\d+\/onebot\/v11$/.test(linkG.url ?? ''),
  { e: linkE?.url, g: linkG?.url },
);

await waitFor('hub2 连上倒上游', () => hub2.upstream?.isConnected === true, 8000);
const inbound = new WebSocket(linkE.url, { headers: { 'X-Self-ID': '30007000' } });
await once(inbound, 'open');
const inboundFrames = [];
inbound.on('message', (raw) => {
  try {
    inboundFrames.push(JSON.parse(raw.toString('utf8')));
  } catch {
    /* ignore */
  }
});
await sleep(200);

const event2 = { ...event, message_id: 888, raw_message: '四种形态', message: [{ type: 'text', data: { text: '四种形态' } }] };
upSock.send(JSON.stringify(event2));
const fanned2 = await waitFor('三种形态都收到事件（拨进来的 ws、POST 出去、以及被禁用的不掺和）', () =>
  inboundFrames.some((f) => f.message_id === 888) && posted.some((p) => p.body.includes('888')), 8000);
check('T4 上游一条事件：ws-listen 的接入连接收到 + http-post 目标被 POST',
  fanned2 && String(inboundFrames.find((f) => f.message_id === 888)?.self_id) === '30007000',
  { inbound: inboundFrames.length, posted: posted.length });
const postHit = posted.find((p) => p.body.includes('888'));
check('T5 http-post 带上 X-Self-ID 与 JSON 事件体，计数进状态',
  postHit?.headers['x-self-id'] === '30008000' &&
    postHit?.headers['content-type'] === 'application/json' &&
    JSON.parse(postHit.body).group_id === 55555 &&
    (hub2.downstreamLinks.find((l) => l.id === 'F')?.posts ?? 0) >= 1 &&
    (hub2.downstreamLinks.find((l) => l.id === 'F')?.failures ?? 0) === 0,
  { headers: postHit?.headers, status: hub2.downstreamLinks.find((l) => l.id === 'F') });

const unauth = await fetch(`${linkG.url}/send_msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('T6 http-api：token 不对直接 401（不是静默放行）', unauth.status === 401, unauth.status);

upActions.length = 0;
const apiRes = await fetch(`${linkG.url}/send_msg`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-self-id': '30009000', authorization: 'Bearer apitok' },
  body: JSON.stringify({ message_type: 'group', group_id: 55555, user_id: 10001, message: [{ type: 'text', data: { text: '来自 HTTP API' } }] }),
});
const apiJson = await apiRes.json();
check('T7 http-api 的 action 走的是和 ws 下游同一条管线（回 JSON + 按策略转发上游）',
  apiRes.status === 200 &&
    (apiJson.retcode === 0 || apiJson.status === 'ok') &&
    upActions.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('来自 HTTP API')),
  { status: apiRes.status, json: apiJson, actions: upActions.map((f) => f.action) });
check('T8 http-api 的请求/拒绝计数进状态',
  (hub2.downstreamLinks.find((l) => l.id === 'G')?.requests ?? 0) >= 1 &&
    (hub2.downstreamLinks.find((l) => l.id === 'G')?.rejected ?? 0) >= 1,
  hub2.downstreamLinks.find((l) => l.id === 'G'));

// ---------------------------------------------------------------- T9 不写"对方账号" = 与上游相同
// 用户要求：下游目标里不填账号时，默认与上游账号相同。这条在**配置解析**里可以断言（见
// load-check），但"所以链路真的拿上游账号去握手、事件真的透传"只有端到端才算数。
const e2 = await makeDownstream('E2');
const targets3 = normalizeTargets(
  JSON.stringify([{ url: e2.url, nickname: 'transparent' }]), // 故意不写 selfId
  { defaultSelfId: '40004000' },                              // = 上游账号
);
const hub3 = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '40004000',
    preset: 'relay',
    downstreamTargets: targets3,
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: (...parts) => hubLog.push(parts.map(String).join(' ')) },
);
hub3.connectUpstream();
hub3.connectDownstreams();
const dialed3 = await waitFor('T9 没写账号的下游照样拨得出去', () => e2.conns() === 1, 8000);
await waitFor('hub3 连上假上游', () => hub3.upstream?.isConnected === true, 8000);
await sleep(200);
upSock.send(JSON.stringify({ ...event, message_id: 999, raw_message: '透传' }));
const gotE2 = await waitFor('E2 收到事件', () => e2.frames.some((f) => f.message_id === 999), 8000);
const frame999 = e2.frames.find((f) => f.message_id === 999);
check(
  'T9 不写"对方账号" = 与上游相同：握手头与事件 self_id 都是上游账号（真的透传）',
  dialed3 &&
    gotE2 &&
    e2.headers[0]?.['x-self-id'] === '40004000' &&
    String(frame999?.self_id) === '40004000' &&
    frame999?.raw_message === '透传',
  { headers: e2.headers[0]?.['x-self-id'], selfId: frame999?.self_id, linkId: hub3.downstreamLinks[0]?.linkId, id: targets3[0]?.id },
);
hub3.stop();
await e2.close();

// ---------------------------------------------------------------- T10 账号晚到：学到上游账号后自动补建
// 现实里的顺序问题：下游默认账号在**解析配置那一刻**就算好了，而那时上游通常还没连上；
// `ws-dial` 的 `X-Self-ID` 又是握手时就要发出去的。所以配置里既没写上游账号、下游也没写
// 对方账号时：这条链**先不建**（拿空身份握手没意义），等学到账号再补建。
const e3 = await makeDownstream('E3');
const targets4 = normalizeTargets(
  JSON.stringify([{ url: e3.url, nickname: 'learned' }]),  // 没写 selfId
  { defaultSelfId: '' },                                   // 上游账号也还不知道
);
const hub4 = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: '',   // 刻意不写：等学
    preset: 'relay',
    downstreamTargets: targets4,
    requestTimeout: 5000,
    reconnectInterval: 60000,
  },
  { log: (...parts) => hubLog.push(parts.map(String).join(' ')) },
);
hub4.connectUpstream();
const started4 = hub4.connectDownstreams();
const pending4 = hub4.downstreamLinks.find((l) => l.id === targets4[0].id);
check('T10 账号还不知道：目标照旧登记（不静默丢），但先不建链，状态里标着"在等账号"',
  started4 === 0 && e3.conns() === 0 && pending4?.pendingAccount === true && pending4?.connected === false &&
    pending4?.selfId === '',
  { started: started4, conns: e3.conns(), link: pending4 });

const up4 = await waitFor('hub4 连上假上游', () => hub4.upstream?.isConnected === true, 8000);
// 上游连上后**每条事件都带着实现端的 self_id**——这是学账号最省事的一条路（不发额外请求）。
upSock.send(JSON.stringify({ ...event, message_id: 1001, raw_message: '学账号' }));
const dialed4 = await waitFor('学到账号后自动补建这条链', () => e3.conns() === 1, 8000);
check('T10 上游账号从"未知"变"已知"后，那条"在等账号"的链被补建出来',
  up4 && dialed4, { conns: e3.conns(), learned: hub4.upstreamAccountLearned, log: hubLog.slice(-4) });

await sleep(200);
upSock.send(JSON.stringify({ ...event, message_id: 1002, raw_message: '补建后再来一条' }));
const gotE3 = await waitFor('E3 收到补建后的事件', () => e3.frames.some((f) => f.message_id === 1002), 8000);
const frame1002 = e3.frames.find((f) => f.message_id === 1002);
check('T10 补建的链路带上学到的上游账号（握手头 + 事件 self_id 都是它）',
  gotE3 && e3.headers[0]?.['x-self-id'] === '40004000' && String(frame1002?.self_id) === '40004000',
  { headers: e3.headers[0]?.['x-self-id'], selfId: frame1002?.self_id, linkId: hub4.downstreamLinks[0]?.linkId });
check('T10 状态里说清账号是从哪来的（learned = 观测到的，不是配置写的）',
  hub4.status().upstreamAccount?.selfId === '40004000' && hub4.status().upstreamAccount?.source === 'learned',
  hub4.status().upstreamAccount);
check('T10 等账号的不是故障：补建后状态里不再标 pendingAccount',
  hub4.downstreamLinks.find((l) => l.id === targets4[0].id)?.pendingAccount !== true, hub4.downstreamLinks);

// 配置优先：显式写了账号就别被观测悄悄推翻（改行为才是真的危险）
const cfgHub = new Hub({ upstreamSelfId: '77777', preset: 'relay', downstreamTargets: [] }, { log: () => {} });
check('T10 显式配置优先：观测到别的账号只回 config-wins，不改行为',
  cfgHub.learnUpstreamAccount('88888', 'manual').reason === 'config-wins' &&
    cfgHub.upstreamAccount === '77777' &&
    cfgHub.status().upstreamAccount.source === 'configured' &&
    cfgHub.learnUpstreamAccount('', 'manual').reason === 'empty',
  { account: cfgHub.upstreamAccount, status: cfgHub.status().upstreamAccount });

hub4.stop();
await e3.close();

const failed = results.filter((r) => !r.ok);
hub2.stop();
inbound.close();
await Promise.all([a.close(), b.close(), c.close(), d.close()]);
await new Promise((resolve) => postServer.close(resolve));
await new Promise((resolve) => upServer.close(resolve));
// Windows 上"句柄还在关的同时 process.exit"会踩 libuv 断言
// （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）——先让关闭走完再退。
await sleep(300);
console.log(`\nmulti-downstream: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log(JSON.stringify({ failed, hubLog: hubLog.slice(-25) }, null, 2));
process.exit(failed.length ? 1 : 0);
