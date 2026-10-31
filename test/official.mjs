/**
 * QQ 官方通道（`lib/upstream/official.js`）的自包含测试（`node test/official.mjs`）。
 *
 * 为什么这么测：
 *  - 这个适配器是整个插件里**唯一一处"猜协议"**的地方：网关帧、intents、被动回复窗口、
 *    返回形状，全都是照文档写的，本机没有机器人账号可连。所以能测的一条都不能漏——
 *    真机上出错时，至少能排除"其实我们自己把形状写错了"。
 *  - 最贵的三件事：① 鉴权（token 怎么换、过期怎么续）；② 事件规范化（hub 只认 OneBot v11
 *    的形状，映射错了整条下游链都会哑）；③ 被动回复降级（错过 5 分钟窗口不能让话丢掉）。
 *  - 全部离线：假 `fetch`、假 `ws`，不联网、不读环境变量。
 */

import assert from 'node:assert/strict';

import {
  OfficialUpstream,
  UNSUPPORTED_ACTIONS,
  isVirtualId,
  makeWsFactory,
  replyPlan,
  toContent,
  toSegments,
  virtualId,
} from '../lib/upstream/official.js';
import { detectMention } from '../lib/agent/policy.js';

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
          },
          (err) => {
            cases.push({ name, ok: false, error: String(err?.stack ?? err) });
          },
        ),
      );
      return;
    }
    passed += 1;
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.stack ?? err) });
  }
}

const settle = async () => {
  await Promise.all(pending);
  // 让 fetch/ws 的回调链跑完（官方通道大量是"发出去就不等"的）。
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

// ---- 假协议件 -----------------------------------------------------------------

const json = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
});

/** 按 URL 路由的假 fetch；`calls` 记录每一次请求，供断言请求体。 */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method ?? 'GET', body, headers: init.headers ?? {} });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) return handler({ url: String(url), body, init });
    }
    throw new Error(`假 fetch 没有匹配的路由：${url}`);
  };
  return { fetchImpl, calls };
}

/** 假 WebSocket：把 `on` 收好，测试里手动 `emit`。 */
class FakeWs {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = new Map();
    this.sent = [];
    FakeWs.last = this;
  }
  on(evt, fn) {
    this.handlers.set(evt, fn);
    return this;
  }
  emit(evt, arg) {
    this.handlers.get(evt)?.(arg);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit('close', code);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
}

// ---- 虚拟 id ------------------------------------------------------------------

t('虚拟 id：稳定、落在 30 亿段、认得出是自己造的', () => {
  const a = virtualId('102030', 'user', 'A1B2C3');
  const b = virtualId('102030', 'user', 'A1B2C3');
  const c = virtualId('102030', 'user', 'D4E5F6');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(isVirtualId(a), `应认得出：${a}`);
  assert.ok(a >= 3_000_000_000 && a < 4_000_000_000);
  // 换 appId 也换号：两个机器人看到同一个人不该撞号。
  assert.notEqual(a, virtualId('999999', 'user', 'A1B2C3'));
  assert.equal(isVirtualId(10001), false);
});

// ---- 内容映射 ----------------------------------------------------------------

t('内容映射：`<@!openid>` 变 at 段、纯文本原样、附件计数', () => {
  const segs = toSegments('<@!ABC123> 看这个', [{ url: 'https://x/1.png', content_type: 'image/png' }]);
  assert.equal(segs[0].type, 'at');
  assert.equal(segs[0].data.qq, 'ABC123');
  assert.ok(segs.some((s) => s.type === 'text' && s.data.text.includes('看这个')));
  assert.ok(segs.some((s) => s.type === 'image' && s.data.url === 'https://x/1.png'));
  // 回官方时 @ 用原来的 openid（`<@!xxx>` 里的尖括号格式变了，但目标必须是 openid）；
  // 图片回不去内容，只能留个占位符——真正做到发图要走上传。
  assert.equal(toContent(segs), '<@ABC123>  看这个 [图片]');
});

t('内容映射：纯文字与空内容', () => {
  assert.deepEqual(toSegments('你好'), [{ type: 'text', data: { text: '你好' } }]);
  assert.deepEqual(toSegments(''), []);
  assert.deepEqual(toSegments(undefined), []);
  assert.equal(toContent([]), '');
});

// ---- 被动回复窗口 ------------------------------------------------------------

t('回复计划：没记过这条消息 → 主动', () => {
  const plan = replyPlan(null);
  assert.equal(plan.passive, false);
  assert.equal(plan.reason, 'no-msg-id');
});

t('回复计划：窗口内、次数没用完 → 被动，并且序号递增', () => {
  const now = Date.now();
  const hit = { at: now, times: 0 };
  const p1 = replyPlan(hit, now);
  assert.equal(p1.passive, true);
  assert.equal(p1.times, 1);
  assert.equal(replyPlan({ at: now, times: 3 }, now).passive, true);
});

t('群主开了"接收全部消息"：全量群消息也进时间线，但**不**假装有人 @ 它', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { id: 'BOT-9', username: 'x' } } }));
  ws.emit(
    'message',
    JSON.stringify({
      op: 0,
      t: 'GROUP_MESSAGE_CREATE',
      d: { id: 'RAW-50', content: '今天谁去吃饭', group_openid: 'G-50', author: { member_openid: 'U-50' } },
    }),
  );
  // 本测试里第二次 settle() 会等自己（pending 已含本测试）→ 死锁，只让位。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.message_type, 'group');
  // 关键：不补 at 段。补了的话 hub 会以为有人在叫它，全量群里每条消息都会唤醒 agent。
  assert.equal(ev.message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === ev.self_id), false);
  assert.equal(String(ev.raw_message ?? '').includes('今天谁去吃饭'), true);
});

t('全量群消息里"@ 了它"的那种：认 mentions.is_you，不靠猜 openid（2026-10-29 真机）', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { id: '6592229414871772896', username: 'x' } } }));
  // 真机原样：开了全量之后，@ 它的消息也走 `GROUP_MESSAGE_CREATE`；正文里是 `<@9BDC…>`，
  // 而 READY 给的 user.id 是另一串数字——只有 `mentions[].is_you` 能说明这是 @ 它自己。
  ws.emit(
    'message',
    JSON.stringify({
      op: 0,
      t: 'GROUP_MESSAGE_CREATE',
      d: {
        id: 'RAW-52',
        content: '<@9BDCFB0D74E6161A7254BEF5C3FBE2FD> 在吗',
        group_openid: 'G-52',
        author: { member_openid: 'U-52', username: 'FunnyPotato', member_role: 'owner' },
        mentions: [
          {
            bot: true,
            id: '9BDCFB0D74E6161A7254BEF5C3FBE2FD',
            is_you: true,
            member_openid: '9BDCFB0D74E6161A7254BEF5C3FBE2FD',
            username: '大肥鱼不是鱼',
          },
        ],
      },
    }),
  );
  // 本测试里第二次 settle() 会等自己（pending 已含本测试）→ 死锁，只让位。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.length, 1);
  const ev = events[0];
  // 1) at 段指向 self_id（hub 靠这个判"在叫我"）
  assert.equal(ev.message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === ev.self_id), true);
  assert.deepEqual(detectMention(ev, { selfId: ev.self_id }), ['at']);
  // 2) 群友终于有名字、角色也有值了（之前一律空 / unknown）
  assert.equal(ev.sender.nickname, 'FunnyPotato');
  assert.equal(ev.sender.role, 'owner');
});

t('没见过的事件名留样本（status.unknownEvents），不当作消息', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { id: 'BOT-9', username: 'x' } } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'GROUP_MSG_RECEIVE', d: { group_openid: 'G-51', op_member_openid: 'U-51' } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'GROUP_MSG_RECEIVE', d: { group_openid: 'G-51' } }));
  // 本测试里第二次 settle() 会等自己（pending 已含本测试）→ 死锁，只让位。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.length, 0, '开关通知不是消息，不能变成一条对话');
  const seen = up.status.unknownEvents ?? [];
  const hit = seen.find((x) => x.t === 'GROUP_MSG_RECEIVE');
  assert.ok(hit, '未处理的事件要留下样本');
  assert.equal(hit.n, 2);
  assert.match(String(hit.sample), /G-51/);
});

t('回复计划：过 5 分钟或满 5 次 → 降级成主动（原因分开写）', () => {
  const now = Date.now();
  const old = replyPlan({ at: now - 6 * 60_000, times: 0 }, now);
  assert.equal(old.passive, false);
  assert.equal(old.reason, 'window');
  // 官方文档：每个消息最多回复 5 次（以前按 4 次算，白丢一次额度）
  assert.equal(replyPlan({ at: now, times: 4 }, now).passive, true);
  const full = replyPlan({ at: now, times: 5 }, now);
  assert.equal(full.passive, false);
  assert.equal(full.reason, 'times');
});

// ---- 连接与鉴权 --------------------------------------------------------------

function makeUpstream({ routes, events = [], identities = [], statuses = [] } = {}) {
  const fake = fakeFetch(
    routes ?? [
      ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
      ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
      ['/v2/groups/', () => json({ id: 'msg-100' })],
      ['/v2/users/', () => json({ id: 'msg-200' })],
    ],
  );
  const sockets = [];
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    log: () => {},
    onEvent: (e) => events.push(e),
    onIdentity: (i) => identities.push(i),
    onStatus: (s) => statuses.push(s),
  });
  return { up, fake, events, identities, statuses, sockets };
}

t('连接：换 token → 取网关 → hello 后 Identify 带 token 与 intents', async () => {
  const { up, fake, sockets } = makeUpstream();
  up.start();
  await settle();
  const tokenCall = fake.calls.find((c) => c.url.includes('getAppAccessToken'));
  assert.ok(tokenCall, '应该先换 token');
  assert.deepEqual(tokenCall.body, { appId: '102030', clientSecret: 'sec' });
  const ws = sockets.at(-1);
  assert.equal(ws.url, 'wss://gw.example/ws');
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  const identify = ws.sent.find((f) => f.op === 2);
  assert.ok(identify, 'hello 之后应发 Identify');
  assert.equal(identify.d.token, 'QQBot tk-1');
  assert.equal(identify.d.intents, 1 << 25);
  up.stop();
});

t('READY：把官方机器人映射成虚拟号并报身份', async () => {
  const { up, identities, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { username: '小鱼' } } }));
  assert.equal(identities.length, 1);
  assert.equal(identities[0].selfId, virtualId('102030', 'bot', '102030'));
  assert.equal(identities[0].nickname, '小鱼');
  assert.equal(identities[0].source, 'official-handshake');
  up.stop();
});

t('群消息事件 → OneBot v11 形状（虚拟号 + 保留 openid 真身）', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit(
    'message',
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'raw-1',
        content: '<@!OPENID-A> 在吗',
        group_openid: 'G-1',
        author: { user_openid: 'OPENID-A', username: '小张' },
        timestamp: 1_700_000_000,
      },
    }),
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.post_type, 'message');
  assert.equal(e.font, 0, 'OneBot v11 的 font 必填，少了下游整条事件会被丢掉（m72313）');
  assert.equal(e.message_type, 'group');
  assert.equal(e.message_id, 'raw-1');
  assert.equal(e.user_id, virtualId('102030', 'user', 'OPENID-A'));
  assert.equal(e.group_id, virtualId('102030', 'group', 'G-1'));
  assert.equal(e.self_id, virtualId('102030', 'bot', '102030'));
  assert.equal(e.sender.role, 'unknown');
  assert.equal(e.source.openid, 'OPENID-A');
  assert.equal(e.source.groupOpenid, 'G-1');
  // 群里每一条都是"@ 了机器人"，所以**必须有一个指向 self_id 的 at 段**——
  // 官方不会把那个 @ 放进 content，不补的话 hub 认不出"在叫我"（m37239）。
  const ats = e.message.filter((s) => s.type === 'at');
  assert.ok(
    ats.some((s) => String(s.data.qq) === String(e.self_id)),
    `群消息必须带一个指向 self_id 的 at：${JSON.stringify(ats)}`,
  );
  // 正文里显式写出来的 `<@!OPENID-A>` 仍按普通用户映射（它不是机器人自己）。
  const other = ats.find((s) => s.data.openid === 'OPENID-A');
  assert.equal(other.data.qq, virtualId('102030', 'user', 'OPENID-A'));
  assert.equal(other.data.openid, 'OPENID-A');
  assert.equal(e.raw_message, '<@!OPENID-A> 在吗');
  up.stop();
});

t('私聊消息事件：没有 group_id，message_type 是 private', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'raw-2', content: 'hi', author: { user_openid: 'OPENID-B' } } }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].message_type, 'private');
  assert.equal(events[0].group_id, undefined);
  assert.equal(events[0].user_id, virtualId('102030', 'user', 'OPENID-B'));
  up.stop();
});

// ---- 发送与降级 --------------------------------------------------------------

t('发送：带 reply 段且窗口内 → 被动回复，请求体带 msg_id 与 msg_seq', async () => {
  const { up, fake, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'raw-9', content: '在吗', group_openid: 'G-1', author: { user_openid: 'O-9' } } }),
  );
  assert.equal(events.length, 1);
  const gid = events[0].group_id;
  const res = await up.request('send_group_msg', {
    group_id: gid,
    message: [{ type: 'reply', data: { id: 'raw-9' } }, { type: 'text', data: { text: '在' } }],
  });
  assert.equal(res.status, 'ok');
  const send = fake.calls.filter((c) => c.url.includes('/v2/groups/')).pop();
  assert.equal(send.body.msg_id, 'raw-9');
  assert.equal(send.body.msg_seq, 1);
  assert.equal(send.body.content, '在');
  up.stop();
});

t('发送：msg_id 越权（40034024）不降级重试——否则真错误被"主动消息无权限"顶掉', async () => {
  let attempt = 0;
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    [
      '/v2/groups/',
      () => {
        attempt += 1;
        return json({ code: 40034024, message: '请求参数msg_id无效或越权' }, 400);
      },
    ],
  ]);
  const events = [];
  const sockets = [];
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    log: () => {},
    onEvent: (e) => events.push(e),
  });
  up.start();
  while (!sockets.length) await new Promise((r) => setTimeout(r, 0));
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'raw-88', content: '在吗', group_openid: 'G-3', author: { user_openid: 'O-88' } } }),
  );
  await new Promise((r) => setTimeout(r, 10));
  const res = await up.request('send_group_msg', {
    group_id: events[0].group_id,
    message: [{ type: 'reply', data: { id: 'raw-88' } }, { type: 'text', data: { text: '在' } }],
  });
  assert.equal(res.status, 'failed');
  // 只发了一次：这是请求写错了，不是"被动过期"，不该换条路再撞一堵墙。
  assert.equal(attempt, 1, '不该降级成主动消息重试');
  assert.match(String(res.message), /无效或越权/);
  assert.doesNotMatch(String(res.message), /主动消息/);
});

t('发送：被动被拒（400）→ 就地降级成主动，回执写明 degraded 与上游原话', async () => {
  let attempt = 0;
  const sent = [];
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    [
      '/v2/groups/',
      ({ body }) => {
        attempt += 1;
        sent.push(body);
        // 第一次（带 msg_id）被拒，第二次（主动）成功。
        return attempt === 1 ? json({ code: 40054005, message: 'msg_id expired' }, 400) : json({ id: 'msg-ok' });
      },
    ],
  ]);
  const events = [];
  const sockets = [];
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    log: () => {},
    onEvent: (e) => events.push(e),
  });
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  // 先来一条真的群消息：它的原始 id 会被记成被动凭据。
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'raw-77', content: '在吗', group_openid: 'G-2', author: { user_openid: 'O-77' } } }),
  );
  assert.equal(events.length, 1);
  const res = await up.request('send_group_msg', {
    group_id: events[0].group_id,
    message: [{ type: 'reply', data: { id: 'raw-77' } }, { type: 'text', data: { text: '在' } }],
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.message_id, 'msg-ok');
  assert.equal(res.data.degraded, 'active');
  assert.match(String(res.data.reason), /msg_id expired/);
  // 两次请求：第一次带 msg_id，第二次不带（这才是"降级"）。
  assert.equal(attempt, 2);
  assert.equal(sent[0].msg_id, 'raw-77');
  assert.equal(sent[1].msg_id, undefined);
  up.stop();
});

t('发送：群号/用户号缺失与空内容都被拒，且给出可读原因', async () => {
  const { up } = makeUpstream();
  const noTarget = await up.request('send_group_msg', { message: [{ type: 'text', data: { text: 'x' } }] });
  assert.notEqual(noTarget.status, 'ok');
  const empty = await up.request('send_group_msg', { group_id: 123, message: [] });
  assert.notEqual(empty.status, 'ok');
  assert.match(empty.message ?? empty.wording ?? String(empty.data ?? ''), /空/);
});

t('不支持的 action 明确回 1404，而不是超时或空回', async () => {
  const { up } = makeUpstream();
  const name = [...UNSUPPORTED_ACTIONS][0];
  const res = await up.request(name, {});
  assert.notEqual(res.status, 'ok');
  assert.equal(res.retcode, 100);
  assert.match(String(res.message ?? res.wording ?? ''), /不支持/);
});

t('能力盘点（m38120 之后）：合并转发/群公告/历史消息明确说"没有"，而不是含糊的 1404', async () => {
  const { up } = makeUpstream();
  const fwd = await up.request('send_group_forward_msg', { group_id: 1, messages: [] });
  // 100 = "实现端不支持该 action"；1404（目标不存在）会让人以为是自己传错了号。
  assert.equal(fwd.retcode, 100);
  assert.match(fwd.message, /合并转发/);
  const hist = await up.request('get_group_msg_history', { group_id: 1 });
  assert.equal(hist.retcode, 100);
  assert.match(hist.message, /历史消息/);
  // 健康检查本地就能答，不该因为"没连上"或"不支持"报错
  const st = await up.request('get_status', {});
  assert.equal(st.status, 'ok');
  const ver = await up.request('get_version_info', {});
  assert.equal(ver.status, 'ok');
});

t('错误文案要走 `msg`：只放 `message` 的话，shapeResult 读不到，模型只看到"未知 retcode"', async () => {
  const { up } = makeUpstream();
  const res = await up.request('send_group_msg', { group_id: 1, message: [] });
  assert.equal(res.status, 'failed');
  assert.ok(res.msg && res.msg.length > 0, 'msg 必须带上，否则上游原话在枢纽那一层就丢了');
  assert.equal(res.msg, res.message, '两个字段同时存在且一致');
});

t('@ 某人：虚拟号换不出 openid 就不发那个 at，并告诉模型它没 @ 上', async () => {
  const { up, fake } = makeUpstream({
    routes: [
      ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
      ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
      ['/v2/groups/', () => json({ id: 'msg-77' })],
    ],
  });
  const tick = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  up.start();
  await tick();
  const ws = FakeWs.last;
  ws.open();
  ws.emit('message', JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: {
    id: 'raw-7', content: ' 在吗', group_openid: 'G-7', group_id: 'G-7',
    author: { member_openid: 'O-7', username: '小明' },
    mentions: [{ bot: true, is_you: true, member_openid: 'bot', username: 'bot' }],
  } }));
  await tick();
  // 3820113110 这类虚拟号不在对端表里 → 这个 at 不能原样发出去
  const res = await up.request('send_group_msg', {
    group_id: 'G-7',
    message: [
      { type: 'at', data: { qq: '3820113110' } },
      { type: 'text', data: { text: '你好' } },
    ],
  });
  assert.equal(res.status, 'ok', JSON.stringify(res));
  assert.equal(res.data.droppedAt, 1);
  const call = fake.calls.at(-1);
  assert.ok(!String(call.body?.content ?? '').includes('3820113110'), '不能把虚拟号当 openid 发出去');
});

t('get_login_info 回虚拟身份（下游按 OneBot 形状问也能答）', async () => {
  const { up } = makeUpstream();
  const res = await up.request('get_login_info', {});
  assert.equal(res.status, 'ok');
  assert.equal(res.data.user_id, virtualId('102030', 'bot', '102030'));
  assert.equal(res.data.app_id, '102030');
});

t('makeWsFactory：没注入 ws 时报错，不静默降级', () => {
  assert.throws(() => makeWsFactory(null), /ws/);
  assert.throws(() => makeWsFactory({}), /ws/);
  const factory = makeWsFactory({ WebSocket: FakeWs });
  assert.ok(factory('wss://x') instanceof FakeWs);
});

// ---- 附件：先上传再发（官方不吃图文混排） ---------------------------------------

/** 起一个连着假网关、并且已经收到过一条群消息的 upstream（被动凭据就位）。 */
async function readyWithQuote(rawId = 'raw-1', groupOpenid = 'G-1') {
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    ['/files', () => json({ file_info: 'FILE-INFO-1', file_uuid: 'u-1', ttl: 3600 })],
    ['/v2/groups/', () => json({ id: 'msg-1' })],
    ['/v2/users/', () => json({ id: 'msg-2' })],
  ]);
  const events = [];
  const sockets = [];
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    log: () => {},
    onEvent: (e) => events.push(e),
  });
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: rawId, content: '看图', group_openid: groupOpenid, author: { user_openid: 'O-1' } } }),
  );
  return { up, fake, events };
}

t('附件：先 POST /files 拿 file_info，再拆成"文本一条 + 图片一条"', async () => {
  const { up, fake, events } = await readyWithQuote();
  const res = await up.request('send_group_msg', {
    group_id: events[0].group_id,
    message: [
      { type: 'reply', data: { id: 'raw-1' } },
      { type: 'text', data: { text: '给你' } },
      { type: 'image', data: { url: 'https://cdn.example/a.png' } },
    ],
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.media, 1);
  assert.equal(res.data.parts, 2);

  const upload = fake.calls.find((c) => c.url.includes('/files'));
  assert.ok(upload, '应该先上传');
  assert.equal(upload.method, 'POST');
  // 公网地址直接交给官方去拉，省一次下载。
  assert.deepEqual(upload.body, { file_type: 1, srv_send_msg: false, url: 'https://cdn.example/a.png' });

  const sends = fake.calls.filter((c) => c.url.includes('/messages'));
  assert.equal(sends.length, 2);
  // 第一条挂被动回复；附件那条走主动——同一个 msg_id 只有 4 次额度，不能被附件吃掉。
  assert.equal(sends[0].body.msg_id, 'raw-1');
  assert.equal(sends[0].body.content, '给你');
  assert.equal(sends[1].body.msg_id, undefined);
  assert.equal(sends[1].body.msg_type, 7);
  assert.deepEqual(sends[1].body.media, { file_info: 'FILE-INFO-1' });
  up.stop();
});

t('附件：base64:// 剥前缀塞 file_data，语音按 file_type 3；没 file_info 就不发', async () => {
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    ['/files', () => json({ file_type: 3 })],
    ['/v2/users/', () => json({ id: 'msg-2' })],
  ]);
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => new FakeWs(url),
    log: () => {},
    onEvent: () => {},
  });
  up.start();
  await settle();
  const res = await up.request('send_private_msg', {
    user_id: 'O-9',
    message: [{ type: 'record', data: { file: 'base64://QUJD' } }],
  });
  assert.equal(res.status, 'failed');
  // 上传成功但没给 file_info：不能当成发出去，要说清收到的字段。
  assert.match(String(res.message ?? ''), /file_info/);
  const upload = fake.calls.find((c) => c.url.includes('/files'));
  assert.equal(upload.body.file_type, 3);
  assert.equal(upload.body.file_data, 'QUJD');
  assert.equal(fake.calls.filter((c) => c.url.includes('/messages')).length, 0);
  up.stop();
});

t('附件：上传失败就整条不发（不要出现"文本发了、图丢了"）', async () => {
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    ['/files', () => json({ code: 40034001, message: 'file too large' }, 400)],
    ['/v2/groups/', () => json({ id: 'msg-1' })],
  ]);
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => new FakeWs(url),
    log: () => {},
    onEvent: () => {},
  });
  up.start();
  await settle();
  const res = await up.request('send_group_msg', {
    group_id: 'G-9',
    message: [
      { type: 'text', data: { text: '图在这儿' } },
      { type: 'image', data: { url: 'https://cdn.example/a.png' } },
    ],
  });
  assert.equal(res.status, 'failed');
  assert.match(String(res.message ?? ''), /附件上传失败/);
  assert.equal(fake.calls.filter((c) => c.url.includes('/messages')).length, 0);
  up.stop();
});


// ---- 虚拟号 ↔ openid（真机 `m35049`）
/**
 * 只把已排队的回调跑完，**不等全局 `settle()`**。
 *
 * 理由：`settle()` 等的是 `Promise.all(pending)`——既有用例里有"先 settle 一次、
 * 再 settle 一次"的写法，第二次的快照会把**后来定义的**用例也圈进来，而后来者又在等它，
 * 于是互相等。新用例统一用这个本地 flush，互不牵连。
 */
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/**
 * 真机错在哪：`virtualId()` 是单向派生号，发消息时手里只有它；直接当 openid 打过去，
 * 官方回 `400 请求的资源不存在(用户/群已注销)`——读起来像"对方注销了"，其实是我们没换号。
 */
const peersFixture = () => {
  const store = {};
  return {
    store,
    storage: {
      read: (file, fallback) => (file in store ? JSON.parse(JSON.stringify(store[file])) : fallback),
      schedule: (file, fn) => {
        store[file] = fn();
      },
      flush: () => {},
    },
  };
};

function upstreamWithPeers({ storage }) {
  const fake = fakeFetch([
    ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
    ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
    ['/v2/groups/', () => json({ id: 'msg-g' })],
    ['/v2/users/', () => json({ id: 'msg-u' })],
  ]);
  const sockets = [];
  const up = new OfficialUpstream({
    appId: '102030',
    appSecret: 'sec',
    storage,
    fetchImpl: fake.fetchImpl,
    wsFactory: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    log: () => {},
    onEvent: () => {},
  });
  up.start();
  return { up, fake, sockets };
}

t('私聊：回复打的是 openid，不是虚拟号', async () => {
  const { storage } = peersFixture();
  const { up, fake, sockets } = upstreamWithPeers({ storage });
  await flush();
  sockets.at(-1).open();
  sockets.at(-1).emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  sockets.at(-1).emit(
    'message',
    JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'raw-c1', content: '在吗', author: { user_openid: 'OPENID-A' } } }),
  );
  const vid = virtualId('102030', 'user', 'OPENID-A');
  const res = await up.request('send_private_msg', { user_id: vid, message: [{ type: 'text', data: { text: '在的' } }] });
  assert.equal(res.status, 'ok', JSON.stringify(res));
  const call = fake.calls.find((c) => c.url.includes('/messages'));
  assert.ok(call, '应该发出去了');
  assert.match(call.url, /\/v2\/users\/OPENID-A\/messages/, `打的必须是 openid：${call.url}`);
  assert.ok(!call.url.includes(String(vid)), '不能把虚拟号当 openid 打过去');
  up.stop();
});

t('没写 quote 也要走被动回复：官方主动消息要单独开通权限（m37568）', async () => {
  const { up, fake, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { id: 'BOT', username: 'x' } } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'RAW-9', content: '在吗', group_openid: 'G-9', author: { user_openid: 'U-9' } } }),
  );
  // 注意：测试里的第二次 settle() 会等自己（pending 已含本测试）→ 死锁，这里只让位。
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  const gid = virtualId('102030', 'group', 'G-9');
  // 调用方**不带** reply 段：它不知道也没关系，枢纽替它引用最近进来那条。
  const out = await up.request('send_group_msg', { group_id: gid, message: [{ type: 'text', data: { text: '在的' } }] });
  assert.equal(out.retcode, 0, JSON.stringify(out));
  assert.equal(out.data?.degraded, undefined, '自动引用之后不该降级成主动消息');
  const sent = fake.calls.find((c) => c.url.includes('/v2/groups/'));
  assert.equal(sent.body.msg_id, 'RAW-9', '没写 quote 时应自动引用最近一条进来的消息');
  assert.equal(sent.body.msg_seq, 1);

  up.stop();
});

t('群里的 @ 官方不放进 content：枢纽要自己补一个指向 self_id 的 at（m37239）', async () => {
  const { up, events, sockets } = makeUpstream();
  up.start();
  await settle();
  const ws = sockets.at(-1);
  ws.open();
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  // READY 带机器人自己的 openid；随后一条**只有空格**的群消息（真机上"@"一下什么也没打"就是这样）。
  ws.emit('message', JSON.stringify({ op: 0, t: 'READY', d: { user: { id: 'BOT-OPENID', username: '大肥鱼' } } }));
  ws.emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'raw-g0', content: ' ', group_openid: 'G-0', author: { user_openid: 'O-0' } } }),
  );
  const e = events.find((x) => x.message_type === 'group');
  assert.ok(e, '群消息应该进事件');
  const at = e.message.find((s) => s.type === 'at');
  assert.ok(at, '必须补一个 at 段，否则 hub 认不出"在叫我"');
  assert.equal(String(at.data.qq), String(e.self_id), '这个 at 必须指向 self_id');
  // 真机症状的回归断言：detectMention 要能说出"在叫我"。
  const reasons = detectMention(e, { selfId: e.self_id });
  assert.deepEqual(reasons, ['at'], `detectMention 应该认出 at：${JSON.stringify(reasons)}`);
  up.stop();
});

t('群聊：群号也是虚拟号，发之前换成 group_openid', async () => {
  const { storage } = peersFixture();
  const { up, fake, sockets } = upstreamWithPeers({ storage });
  await flush();
  sockets.at(-1).open();
  sockets.at(-1).emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  sockets.at(-1).emit(
    'message',
    JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'raw-g1', content: '在吗', group_openid: 'GROUP-A', author: { user_openid: 'OPENID-B' } } }),
  );
  const gid = virtualId('102030', 'group', 'GROUP-A');
  const res = await up.request('send_group_msg', { group_id: gid, message: [{ type: 'text', data: { text: '在的' } }] });
  assert.equal(res.status, 'ok', JSON.stringify(res));
  const call = fake.calls.find((c) => c.url.includes('/messages'));
  assert.match(call.url, /\/v2\/groups\/GROUP-A\/messages/);
  up.stop();
});

t('没见过的号码：明确拒绝，一个请求都不发（别让人去查"对方注销了"）', async () => {
  const { storage } = peersFixture();
  const { up, fake } = upstreamWithPeers({ storage });
  await flush();
  const res = await up.request('send_private_msg', {
    user_id: virtualId('102030', 'user', 'NEVER-SEEN'),
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.retcode, 1404);
  assert.match(String(res.message ?? ''), /还不认识/);
  assert.equal(fake.calls.filter((c) => c.url.includes('/messages')).length, 0);
  up.stop();
});

t('非纯数字 id 当 openid 原样用（onebot_call 直传真身这条路）', async () => {
  const { storage } = peersFixture();
  const { up, fake } = upstreamWithPeers({ storage });
  await flush();
  const res = await up.request('send_private_msg', { user_id: 'OPENID-RAW', message: [{ type: 'text', data: { text: 'hi' } }] });
  assert.equal(res.status, 'ok', JSON.stringify(res));
  const call = fake.calls.find((c) => c.url.includes('/messages'));
  assert.match(call.url, /\/v2\/users\/OPENID-RAW\/messages/);
  up.stop();
});

t('对端表落盘：重建实例（同一份 storage）仍然认识刚说过话的人', async () => {
  const { store, storage } = peersFixture();
  const first = upstreamWithPeers({ storage });
  await flush();
  first.sockets.at(-1).open();
  first.sockets.at(-1).emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  first.sockets.at(-1).emit(
    'message',
    JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'raw-c2', content: '在吗', author: { user_openid: 'OPENID-C' } } }),
  );
  first.up.stop(); // stop 会兜一次落盘
  assert.ok(store['official/peers.json'], '停止时要把对端表写下去');
  assert.ok(
    Object.values(store['official/peers.json'].users ?? {}).includes('OPENID-C'),
    `表里应该有这个 openid：${JSON.stringify(store['official/peers.json'])}`,
  );

  const second = upstreamWithPeers({ storage });
  await flush();
  const vid = virtualId('102030', 'user', 'OPENID-C');
  const res = await second.up.request('send_private_msg', { user_id: vid, message: [{ type: 'text', data: { text: '还在' } }] });
  assert.equal(res.status, 'ok', JSON.stringify(res));
  second.up.stop();
});

// ---- 汇总 ---------------------------------------------------------------------

await settle();
t('撤回：打的是 DELETE /v2/groups/{openid}/…，且要知道发在谁身上（m38120）', async () => {
  const { up, fake } = makeUpstream({
    routes: [
      ['getAppAccessToken', () => json({ access_token: 'tk-1', expires_in: '7200' })],
      ['/gateway', () => json({ url: 'wss://gw.example/ws' })],
      ['/v2/groups/', () => json({ id: 'msg-100' })],
      ['/v2/messages/', () => json({}, 200), ],
      ['/v2/users/', () => json({ id: 'msg-200' })],
      ['messages/msg-100', () => json({}, 200)],
    ],
  });
  const tick = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  up.start();
  await tick();
  const ws = FakeWs.last;
  ws.open();
  ws.emit('message', JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: {
    id: 'raw-1', content: '<@bot> 在吗', group_openid: 'G-9', group_id: 'G-9',
    author: { member_openid: 'O-1', username: '小明' },
    mentions: [{ bot: true, is_you: true, member_openid: 'bot', username: 'bot' }],
  } }));
  await tick();
  // 先发一条（记下 id → 对象），再撤
  const sent = await up.request('send_group_msg', { group_id: 'G-9', message: [{ type: 'text', data: { text: 'hi' } }] });
  assert.equal(sent.status, 'ok', JSON.stringify(sent));
  const del = await up.request('delete_msg', { message_id: sent.data.message_id });
  assert.equal(del.status, 'ok', JSON.stringify(del));
  const call = fake.calls.at(-1);
  assert.equal(call.method, 'DELETE', '官方撤回是 DELETE，不是 POST');
  assert.match(call.url, /\/v2\/groups\/G-9\/messages\/msg-100$/);
  assert.equal(call.body, null, 'DELETE 不带请求体');

  // 不认识的 id、又没给对象 → 明确说清为什么撤不了，而不是打一个 404 回来
  const blind = await up.request('delete_msg', { message_id: 'msg-999' });
  assert.equal(blind.status, 'failed', JSON.stringify(blind));
  assert.match(blind.message, /光有消息 id 不够|哪个群/);
  assert.match(blind.message, /group_id/);
});

await settle();
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed: passed + 0, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
