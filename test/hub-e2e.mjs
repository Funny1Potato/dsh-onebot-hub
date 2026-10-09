/**
 * M3 端到端验收（§18.4）：真下游（NoneBot + 探针插件）+ 伪上游实现端（OneBot v11 WS 服务端）。
 *
 * 拓扑：
 *   伪上游实现端(ws://127.0.0.1:8798)  <——正向WS——  hub  ——拨号反向WS——>  NoneBot 下游(ws://127.0.0.1:8080/onebot/v11/ws)
 *
 * 验收点：
 *   A 透传：上游真实事件零改写下发（无 to_me、at 段保留、空白保留）
 *   B 触发：下游插件真被触发（on_command 命中，to_me 由下游重算为 true）
 *   C 回程：下游的 send_msg 被 hub 按 relay 策略转发回上游实现端
 *   D get_msg：下游 _check_reply 主动调 get_msg，hub 真答
 *   E trace：dsh_trace 扩展字段被下游保留
 *   F 防环：hub 自己发出去的内容回流时被自送闸丢弃
 *
 * 用法：node test/hub-e2e.mjs   （需先启动那台 NoneBot 下游，并把它探针写的日志位置用
 *   环境变量 HUB_E2E_PROBE_LOG 指过来；不指就默认读系统临时目录下的 probe_out.jsonl）
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

import { Hub } from '../lib/hub.js';
import { useWs } from '../lib/link.js';

const UP_PORT = 8798;
const DOWN_URL = 'ws://127.0.0.1:8080/onebot/v11/ws';
const HUB_SELF_ID = '40004000'; // hub 在群里的账号（上游实现端上的登录号）
const DOWN_SELF_ID = '30001000'; // hub 为下游链路扮演的账号（下游 NoneBot 自己的号）
const GROUP_ID = 55555;
const USER_ID = 10001;
// 下游 NoneBot 那侧探针写的日志：路径随部署走，所以这里不给死某个机器的绝对路径。
const PROBE_LOG = process.env.HUB_E2E_PROBE_LOG || path.join(os.tmpdir(), 'probe_out.jsonl');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(100);
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

// ---------------------------------------------------------------- 伪上游实现端
const upFrames = [];
const upEvents = [];
const upHandshake = {};
const upEventsSent = [];
let upSock = null;

const upServer = new WebSocketServer({ port: UP_PORT });
upServer.on('connection', (ws, req) => {
  upHandshake.selfId = req.headers['x-self-id'];
  upHandshake.role = req.headers['x-client-role'];
  upSock = ws;
  ws.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (frame.post_type) {
      upEvents.push(frame);
      return;
    }
    upFrames.push(frame);
    const data = frame.action === 'send_msg' ? { message_id: 9001 } : { echoed: frame.action };
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo ?? null }));
  });
});

function sendEvent(event) {
  upEventsSent.push(event);
  upSock.send(JSON.stringify(event));
}

function groupEvent({ messageId, segments, raw, extra = {} }) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(HUB_SELF_ID),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    user_id: USER_ID,
    group_id: GROUP_ID,
    raw_message: raw,
    font: 0,
    sender: { user_id: USER_ID, nickname: '甲', card: '', role: 'owner', level: '7', title: '头衔', area: '北京' },
    anonymous: null,
    message: segments,
    ...extra,
  };
}

// ---------------------------------------------------------------- hub
useWs({ WebSocket, WebSocketServer });
const hubLog = [];
const hub = new Hub(
  {
    upstreamUrl: `ws://127.0.0.1:${UP_PORT}`,
    upstreamSelfId: HUB_SELF_ID,
    preset: 'relay',
    downstreamTargets: [{ url: DOWN_URL, selfId: DOWN_SELF_ID, nickname: 'probe-bot' }],
    requestTimeout: 10000,
    heartbeatTimeout: 60000,
  },
  { log: (...a) => hubLog.push(a.map(String).join(' ')) },
);
hub.connectUpstream();
hub.connectDownstreams();

const probeOffset = existsSync(PROBE_LOG) ? statSync(PROBE_LOG).size : 0;

const connected = await waitFor('上下游同时连上', () => hub.upstream?.isConnected && hub.downstreamLinks.some((l) => l.connected && l.selfId === DOWN_SELF_ID), 20000);
check('上下游链路建立', connected, hub.status().downstream);
if (!connected) {
  hub.stop();
  upServer.close();
  writeFileSync('e2e-report.json', JSON.stringify({ results, hubLog }, null, 2));
  process.exit(1);
}
await sleep(500);

// ---------------------------------------------------------------- A/B/C：透传 → 触发 → 回程
const probeAtMe = groupEvent({
  messageId: 111,
  segments: [
    { type: 'at', data: { qq: DOWN_SELF_ID } },
    { type: 'text', data: { text: ' /probe 参数一  参数二 ' } },
  ],
  raw: `[CQ:at,qq=${DOWN_SELF_ID}] /probe 参数一  参数二 `,
});
sendEvent(probeAtMe);

const gotPong = await waitFor('下游回复 pong-probe 经 hub 转发回上游', () =>
  upFrames.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('pong-probe')), 20000);
check('A/B/C 透传触发回程：下游 on_command 命中并回程到上游', gotPong, upFrames.filter((f) => f.action === 'send_msg').map((f) => f.params));

const relayed = hub.timeline.recent(50, { direction: 'downstream-out' }).find((e) => e.refs?.upstreamMessageId === 111);
check('A1 下发事件不含 to_me（交给下游重算）', relayed !== undefined && !('to_me' in (relayed.payload ?? {})) && !('is_tome' in (relayed.payload ?? {})), relayed?.payload && Object.keys(relayed.payload));
check(
  'A2 段序与空白零改写',
  relayed?.payload?.message?.[1]?.data?.text === ' /probe 参数一  参数二 ' &&
    relayed?.payload?.message?.[0]?.data?.qq === DOWN_SELF_ID,
  relayed?.payload?.message,
);
check('A3 sender 全字段保真（role/level/title/area）', relayed?.payload?.sender?.title === '头衔' && relayed?.payload?.sender?.area === '北京', relayed?.payload?.sender);
check('A4 self_id 重签为下游账号', String(relayed?.payload?.self_id) === DOWN_SELF_ID, { got: relayed?.payload?.self_id, want: DOWN_SELF_ID });
check('A5 raw_message 原样搬运', relayed?.payload?.raw_message === probeAtMe.raw_message, relayed?.payload?.raw_message);

const sendUp = upFrames.find((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('pong-probe'));
check('C1 下游只用 send_msg（不是 send_group_msg）', sendUp !== undefined && !upFrames.some((f) => f.action === 'send_group_msg'), upFrames.map((f) => f.action));

// ---------------------------------------------------------------- D：reply → get_msg
const prior = groupEvent({ messageId: 222, segments: [{ type: 'text', data: { text: '上一条' } }], raw: '上一条' });
sendEvent(prior);
await sleep(800);
const replyEvent = groupEvent({
  messageId: 223,
  segments: [
    { type: 'reply', data: { id: '222' } },
    { type: 'text', data: { text: '/probe' } },
  ],
  raw: '[CQ:reply,id=222]/probe',
});
upFrames.length = 0;
sendEvent(replyEvent);

const gotGetMsg = await waitFor('下游主动调 get_msg', () => hub.capture.list({ limit: 200 }).some((e) => e.action === 'get_msg'), 15000);
check('D1 下游 _check_reply 主动调 get_msg', gotGetMsg, hub.capture.list({ limit: 200 }).filter((e) => e.action === 'get_msg'));
const gotPong2 = await waitFor('带 reply 的 /probe 也触发下游', () => upFrames.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('pong-probe')), 15000);
check('D2 带 reply 的事件仍触发下游命令（reply 解析成功）', gotPong2, upFrames.map((f) => f.action));

// ---------------------------------------------------------------- E/F
const probeNew = existsSync(PROBE_LOG) ? readFileSync(PROBE_LOG, 'utf8').slice(probeOffset).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const cmdMatches = probeNew.filter((r) => r.kind === 'cmd_probe_match');
check('B1 下游探针记录了 on_command 命中', cmdMatches.length >= 2, cmdMatches.map((r) => ({ raw: r.raw, to_me: r.to_me })));
check('B2 to_me 由下游重算为 true（hub 没写这个字段）', cmdMatches.some((r) => r.to_me === true), cmdMatches.map((r) => r.to_me));
const anyRec = probeNew.find((r) => r.kind === 'any_message');
check('E1 dsh_trace 被下游原样保留', anyRec?.has_dsh_trace === true, anyRec && { has: anyRec.has_dsh_trace, trace: anyRec.model_extra?.dsh_trace });
check('E2 下游收到的 raw_message 非空（hub 补齐渲染）', Boolean(anyRec?.raw_message), anyRec?.raw_message);

// ---------------------------------------------------------------- H：§18.4-1 管理员权限命令
upFrames.length = 0;
sendEvent(groupEvent({ messageId: 444, segments: [{ type: 'text', data: { text: '/admin_probe' } }], raw: '/admin_probe' }));
const gotAdmin = await waitFor('管理员权限命令被下游执行', () =>
  upFrames.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('pong-admin')), 20000);
check('H1 §18.4-1 需 SUPERUSER 的下游命令真的被执行（下游用真事件的 user_id 判权限）', gotAdmin, {
  upstreamFrames: upFrames.map((f) => f.action),
  superusers: '10001',
  senderUserId: USER_ID,
});

// ---------------------------------------------------------------- G：onebot_invoke（event 模式 = 注入事件触发下游）
upFrames.length = 0;
const injectRes = hub.sendMessageToDownstream({
  linkId: `down:${DOWN_SELF_ID}`,
  message_type: 'group',
  group_id: GROUP_ID,
  text: '/probe 注入',
});
check('G1 注入事件成功投递下游', injectRes.delivered === true, injectRes);
const gotInjected = await waitFor('注入的事件真的触发了下游并回程', () =>
  upFrames.some((f) => f.action === 'send_msg' && JSON.stringify(f.params).includes('pong-probe')), 20000);
check('G2 onebot_invoke(event)：下游 matcher 真被触发并回程到上游', gotInjected, upFrames.map((f) => f.action));

let rejectMsg = null;
try {
  await hub.invokeDownstream(`down:${DOWN_SELF_ID}`, 'get_status', {});
} catch (err) {
  rejectMsg = err?.message ?? String(err);
}
check('G3 onebot_invoke(action) 对 bot-app 型链路快速拒绝（不挂到超时）', typeof rejectMsg === 'string' && rejectMsg.includes('bot-app'), rejectMsg);

// F 防环：把 hub 刚转发出去的内容原样回流
const echoEvent = groupEvent({
  messageId: 333,
  segments: [{ type: 'text', data: { text: 'pong-probe' } }],
  raw: 'pong-probe',
  extra: { user_id: Number(HUB_SELF_ID) },
});
echoEvent.user_id = Number(HUB_SELF_ID);
sendEvent(echoEvent);
await sleep(600);
check('F1 自送闸丢弃回流内容', hub.guard.stats.droppedSent >= 1, hub.guard.stats);

// ---------------------------------------------------------------- 汇总
const status = hub.status();
const failed = results.filter((r) => !r.ok);
const report = {
  when: new Date().toISOString(),
  topology: { upstream: `ws://127.0.0.1:${UP_PORT}`, downstream: DOWN_URL, hubSelfId: HUB_SELF_ID, downSelfId: DOWN_SELF_ID },
  handshake: upHandshake,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  upstreamFramesSeen: upFrames.map((f) => f.action),
  status,
  hubLog: hubLog.slice(-40),
};
writeFileSync('e2e-report.json', JSON.stringify(report, null, 2));
console.log(`\n=== ${report.passed}/${results.length} 通过 ===`);

hub.stop();
upServer.close();
await sleep(200);
process.exit(failed.length ? 1 : 0);
