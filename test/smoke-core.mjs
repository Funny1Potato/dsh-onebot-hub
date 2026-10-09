/**
 * M0 纯逻辑冒烟测试：编解码零改写、重签、防环三闸。
 * 不依赖 ws / DSH，可直接 `node test/smoke-core.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  retagEvent,
  renderCq,
  parseCq,
  messageToText,
  stripDerivedFields,
  sessionKey,
  conversationKey,
  eventKind,
  makeResult,
  makeError,
  segmentsOf,
  segmentsFromParams,
  stripInlineMedia,
} from '../lib/protocol.js';
import { LoopGuard } from '../lib/trace.js';
import { DownstreamSession } from '../lib/link.js';
import { Timeline, canonicalEvents, isForwardMirror } from '../lib/capture.js';
import {
  CapabilityCache,
  CapabilityRegistry,
  baseAction,
  cacheKey,
  explainRetcode,
  isSensitive,
  shapeResult,
  tierOf,
  toWireResponse,
  ttlOf,
} from '../lib/capability.js';
import { renderPerson, renderWindow } from '../lib/memory/assembler.js';
import { buildDigest, renderDigest } from '../lib/memory/digest.js';
import { full, mdhm } from '../lib/stamp.js';
import { Cards } from '../lib/memory/cards.js';
import { MemberResolver, atTargets, cardName, isUnsupported } from '../lib/members.js';
import { ADMIN_OPS, ADMIN_OP_NAMES, planAdminOp } from '../lib/admin.js';
import { JsonStore, safeName } from '../lib/storage.js';
import { Profiles, nameIn, topicHoldsMessage } from '../lib/profile.js';
import {
  TurnIndex,
  briefTurn,
  isHubSpeech,
  isOutcomeEntry,
  isTriggerEntry,
  summarizeTurns,
} from '../lib/turns.js';
import { MemoryStore, memoryDedupeKey, normalizeMemoryText } from '../lib/memory/store.js';
import { resolveIsolation } from '../lib/memory/isolation.js';
import { applyMemoryOps } from '../lib/memory/writer.js';
import { tokenize, RecallStore } from '../lib/memory/recall.js';
import { decayStrength, isWeak, weakMessageIds } from '../lib/memory/decay.js';
import { collectCues, cueKey, Reminders } from '../lib/memory/cues.js';
import { renderCues, renderCapabilities } from '../lib/memory/assembler.js';
import { describeEvent, describeNotice, describeSegments } from '../lib/segments.js';
import { resolveReplyImages } from '../lib/reply.js';
import { Vision, normalizeVisionMode, parseDescribeReply } from '../lib/vision.js';
import { MediaStore, extOf, sniffType } from '../lib/media.js';
import {
  CapabilityMap,
  candidateFromTurn,
  capabilityId,
  firstChar,
  firstToken,
  inferPrefixes,
  matchCapability,
  normalizeName,
  renderPrediction,
  renderArgs,
  renderParams,
  splitCommand,
} from '../lib/learn.js';
import { Mind } from '../lib/mind.js';
import { mergePolicyMode, resolveAgentPolicy, sessionOverrideOf } from '../lib/agent/policy.js';

let passed = 0;
const cases = [];
/** 异步用例（媒体落地这类要碰磁盘）挂在这里，末尾统一 await。 */
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

// ---- 编解码往返 ----
t('CQ 往返：text/at/image 保真', () => {
  const segs = [
    { type: 'text', data: { text: ' /probe 参数一  参数二 ' } },
    { type: 'at', data: { qq: '10001' } },
    { type: 'image', data: { file: 'https://example.com/a.png' } },
  ];
  const cq = renderCq(segs);
  assert.equal(cq, ' /probe 参数一  参数二 [CQ:at,qq=10001][CQ:image,file=https://example.com/a.png]');
  const back = parseCq(cq);
  assert.deepEqual(back[1], { type: 'at', data: { qq: '10001' } });
  assert.equal(back[0].data.text, ' /probe 参数一  参数二 ');
});

t('CQ 转义：文本内 []& 与参数内逗号', () => {
  assert.equal(renderCq([{ type: 'text', data: { text: 'a[b]c&d' } }]), 'a&#91;b&#93;c&amp;d');
  assert.equal(renderCq([{ type: 'image', data: { file: 'a,b' } }]), '[CQ:image,file=a&#44;b]');
  assert.equal(parseCq('a&#91;b&#93;c&amp;d')[0].data.text, 'a[b]c&d');
});

t('messageToText 保留空白（不做归一化）', () => {
  const segs = [{ type: 'text', data: { text: '  a  b  ' } }];
  assert.equal(messageToText(segs), '  a  b  ');
});

// ---- 重签 ----
const upstreamGroup = {
  time: 1700000000,
  self_id: 20002000,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 111,
  user_id: 10001,
  group_id: 55555,
  raw_message: '[CQ:at,qq=20002000] /probe  x',
  font: 0,
  sender: { user_id: 10001, nickname: '甲', card: '', role: 'owner', level: '7', title: '头衔', area: '北京' },
  anonymous: null,
  message: [
    { type: 'at', data: { qq: '20002000' } },
    { type: 'text', data: { text: ' /probe  x' } },
  ],
};

t('retagEvent 重签 self_id，原事件不被改动', () => {
  const out = retagEvent(upstreamGroup, { selfId: 30001000 });
  assert.equal(out.self_id, 30001000);
  assert.equal(upstreamGroup.self_id, 20002000);
});

t('retagEvent 不改段序/空白/raw_message/sender 明细', () => {
  const out = retagEvent(upstreamGroup, { selfId: 30001000, messageId: 'virtual:linkA:1' });
  assert.equal(out.message_id, 'virtual:linkA:1');
  assert.equal(out.raw_message, upstreamGroup.raw_message);
  assert.deepEqual(out.message, upstreamGroup.message);
  assert.deepEqual(out.sender, upstreamGroup.sender);
  assert.equal(out.message[1].data.text, ' /probe  x');
});

t('retagEvent 剥掉 to_me/is_tome 且追加 dsh_trace', () => {
  const src = { ...upstreamGroup, to_me: true, is_tome: true };
  const out = retagEvent(src, { selfId: 30001000, trace: { origin: 'dsh-onebot-hub', hop: 0 } });
  assert.equal('to_me' in out, false);
  assert.equal('is_tome' in out, false);
  assert.deepEqual(out.dsh_trace, { origin: 'dsh-onebot-hub', hop: 0 });
});

t('stripDerivedFields 就地剥离', () => {
  const e = { post_type: 'message', to_me: true, is_tome: true };
  stripDerivedFields(e);
  assert.equal('to_me' in e, false);
});

t('segmentsOf 兼容字符串与数组', () => {
  assert.equal(segmentsOf({ message: '/probe' })[0].data.text, '/probe');
  assert.equal(segmentsOf({ message: [{ type: 'text', data: { text: 'x' } }] })[0].data.text, 'x');
});

t('segmentsFromParams：send_msg 与合并转发共用一个入口（m28267/m29922）', () => {
  // send_msg 形状：params.message 数组 / CQ 字符串。
  assert.equal(segmentsFromParams({ message: [{ type: 'text', data: { text: 'x' } }] })[0].data.text, 'x');
  assert.equal(segmentsFromParams({ message: '/probe' })[0].data.text, '/probe');
  // 合并转发形状：params.messages 是 node 数组——**不摊平**（m29922 用户定案：与群友聊天记录
  // 同待遇）：只包一个 forward 占位段让文本非空，节点原文挂在 data.nodes 上供 onebot_raw /
  // 媒体落地用。
  const fwd = segmentsFromParams({ messages: [
    { type: 'node', data: { name: 'a', uin: 1, content: [{ type: 'text', data: { text: '岀猪车' } }, { type: 'image', data: { file: 'https://x/y.png' } }] } },
    { type: 'node', data: { name: 'a', uin: 1, content: [{ type: 'text', data: { text: '猪溜达' } }] } },
    { type: 'node', data: { id: '49001' } },
  ] });
  assert.deepEqual(fwd.map((s) => s.type), ['forward']);
  assert.equal(fwd[0].data.count, 3);
  assert.equal(fwd[0].data.nodes.length, 3);
  assert.equal(messageToText(fwd), '[合并转发 3 条：内容未展开]');
  // 引用型节点（没有 content）也照包；空数组退化为不带条数的占位。
  assert.equal(messageToText(segmentsFromParams({ messages: [{ type: 'node', data: { id: '49001' } }] })), '[合并转发 1 条：内容未展开]');
  assert.equal(messageToText(segmentsFromParams({ messages: [] })), '[合并转发]');
  // 什么都没有：空数组，不炸。
  assert.deepEqual(segmentsFromParams({}), []);
});

t('stripInlineMedia 跟进合并转发节点（params.messages）', () => {
  const fat = `base64://${'A'.repeat(512)}`;
  const params = { group_id: 55555, messages: [
    { type: 'node', data: { name: 'a', uin: 1, content: [{ type: 'image', data: { file: fat } }, { type: 'text', data: { text: 't' } }] } },
    { type: 'node', content: [{ type: 'image', data: { file: fat } }] },
  ] };
  const out = stripInlineMedia(params);
  // 占位符保留前 24 字符（base64:// 本身就在里面），所以判据是"整坨数据没了、留了'已落地'的话"。
  assert.notEqual(out.messages[0].data.content[0].data.file, fat, 'data.content 里的内联没换掉');
  assert.match(out.messages[0].data.content[0].data.file, /内联数据/);
  assert.notEqual(out.messages[1].content[0].data.file, fat, '裸 content 里的内联没换掉');
  assert.equal(out.messages[0].data.content[1].data.text, 't', '非媒体段不许动');
  // 引用型节点（无 content）原样保留。
  const refOnly = stripInlineMedia({ messages: [{ type: 'node', data: { id: '1' } }] });
  assert.equal(refOnly.messages[0].data.id, '1');
  // message 形状行为不变。
  const msg = stripInlineMedia({ message: [{ type: 'image', data: { file: fat } }] });
  assert.match(msg.message[0].data.file, /内联数据/);
});

// ---- 分类与键 ----
t('eventKind / sessionKey / conversationKey', () => {
  assert.equal(eventKind(upstreamGroup), 'group_message');
  assert.equal(sessionKey(upstreamGroup), 'group:55555');
  assert.equal(conversationKey(upstreamGroup), 'group_55555_10001');
  const priv = { post_type: 'message', message_type: 'private', user_id: 10001, self_id: 2 };
  assert.equal(eventKind(priv), 'private_message');
  assert.equal(sessionKey(priv), 'private:10001');
  assert.equal(conversationKey(priv), '10001');
});

// ---- 信封 ----
t('结果/错误信封', () => {
  assert.deepEqual(makeResult('1', { ok: 1 }), { status: 'ok', retcode: 0, data: { ok: 1 }, echo: '1' });
  assert.deepEqual(makeError('2', 'bad'), { status: 'failed', retcode: 1, msg: 'bad', echo: '2' });
});

// ---- 防环三闸 ----
t('来源闸：带本 hub trace 的事件被丢弃', () => {
  const g = new LoopGuard();
  const ev = { ...upstreamGroup, dsh_trace: { origin: 'dsh-onebot-hub', hop: 1 } };
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: ev }).action, 'drop');
});

t('跳数闸：hop 达上限被丢弃', () => {
  const g = new LoopGuard({ maxHop: 3 });
  const ev = { ...upstreamGroup, dsh_trace: { origin: 'other-hub', hop: 3 } };
  const r = g.check({ linkId: 'A', direction: 'upstream', event: ev });
  assert.equal(r.action, 'drop');
  assert.match(r.reason, /loop:hop/);
});

t('重传闸：同 message_id 同内容重复帧丢弃', () => {
  const g = new LoopGuard();
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: upstreamGroup }).action, 'allow');
  const again = g.check({ linkId: 'A', direction: 'upstream', event: upstreamGroup });
  assert.equal(again.action, 'drop');
  assert.equal(again.reason, 'echo:duplicate');
});

t('自送闸：只对 hub 自己发过的内容判回声，不误杀用户重复发言', () => {
  const g = new LoopGuard();
  // 用户连打两条同样的"哈哈"：两条都应放行
  const haha = {
    ...upstreamGroup,
    message_id: 1,
    raw_message: '哈哈',
    message: [{ type: 'text', data: { text: '哈哈' } }],
  };
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: haha }).action, 'allow');
  const haha2 = { ...haha, message_id: 2 };
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: haha2 }).action, 'allow');

  // hub 从下游收了一条并转发出去（登记出站账本），该内容经上游回流时判回声
  const relayed = {
    ...upstreamGroup,
    message_id: 3,
    raw_message: '转发我',
    message: [{ type: 'text', data: { text: '转发我' } }],
  };
  assert.equal(g.check({ linkId: 'A', direction: 'downstream', event: relayed }).action, 'allow');
  g.noteSent({ linkId: 'A', event: relayed });
  const back = { ...relayed, message_id: 4 };
  const r = g.check({ linkId: 'A', direction: 'upstream', event: back });
  assert.equal(r.action, 'drop');
  assert.equal(r.reason, 'echo:sent');
  assert.deepEqual(g.stats, { droppedOrigin: 0, droppedHop: 0, droppedDuplicate: 0, droppedSent: 1, allowed: 3 });
});

t('不同链路/不同内容互不影响', () => {
  const g = new LoopGuard();
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: upstreamGroup }).action, 'allow');
  assert.equal(g.check({ linkId: 'B', direction: 'upstream', event: upstreamGroup }).action, 'allow');
  const other = {
    ...upstreamGroup,
    message_id: 2,
    message: [{ type: 'text', data: { text: '别的' } }],
  };
  assert.equal(g.check({ linkId: 'A', direction: 'upstream', event: other }).action, 'allow');
});

// ---- 上下文装配：转发镜像（真机事故 #3）----
t('转发镜像判定：只有"转发出去的上游消息"才算镜像', () => {
  assert.equal(isForwardMirror({ direction: 'upstream-in' }), false);
  assert.equal(isForwardMirror({ direction: 'downstream-out' }), false);
  assert.equal(isForwardMirror({ direction: 'downstream-out', refs: {} }), false);
  assert.equal(isForwardMirror({ direction: 'downstream-out', refs: { upstreamMessageId: null } }), false);
  assert.equal(isForwardMirror({ direction: 'downstream-out', refs: { upstreamMessageId: 7 } }), true);
  assert.equal(isForwardMirror({ direction: 'downstream-out', refs: { upstreamLinkId: 'up:1' } }), true);
  // 下游推来的 send_* action 不是镜像：那是下游 bot 真的在说话。
  assert.equal(isForwardMirror({ direction: 'downstream-in', action: 'send_msg' }), false);
});

t('转发镜像：会话卡与最近窗口里一句话只出现一次', () => {
  const tl = new Timeline();
  const inbound = {
    ...upstreamGroup,
    message_id: -109779875,
    raw_message: '/今日小猪',
    message: [{ type: 'text', data: { text: '/今日小猪' } }],
  };
  tl.record({ direction: 'upstream-in', linkId: 'up:1', event: inbound });
  tl.record({
    direction: 'downstream-out',
    linkId: 'down:30001000',
    event: inbound,
    decision: 'transparent',
    refs: { upstreamLinkId: 'up:1', upstreamMessageId: inbound.message_id },
  });

  const events = tl.bySession('group:55555');
  assert.equal(events.length, 2, '时间线两个视角都要留（§16 全量记录）');
  assert.equal(events[0].direction, 'upstream-in');
  assert.equal(isForwardMirror(events[1]), true);
  assert.equal(canonicalEvents(events).length, 1);

  const win = renderWindow(events, { selfId: 20002000 });
  assert.equal(win.split('\n').length, 1, `窗口里多出一行：\n${win}`);
  assert.equal(win.split('/今日小猪').length - 1, 1);

  /**
   * 真机现场（用户："下游bot发的消息没能进入会话"）：窗口里出现了 `22:51 下游 bot：` 这种**空行**——
   * 那是枢纽自己的账（`linkId: agent:memory` 的 `onebot_memory` 调用），既不是聊天也没文本。
   * 同时，真正的下游消息要靠 `refs.downstreamLabel` 报出名字，否则多下游时分不清是谁在说话。
   */
  tl.record({ direction: 'hub-in', linkId: 'agent:memory', action: 'onebot_memory', decision: 'applied', refs: { sessionKey: 'group:55555' } });
  tl.record({ direction: 'hub-out', linkId: 'hub:probe-window', action: 'held', refs: { sessionKey: 'group:55555' } });
  tl.record({
    direction: 'downstream-in',
    linkId: 'down:30001000',
    action: 'send_msg',
    decision: 'relay',
    text: '🎉 抓到新猪【猪利猪】！',
    refs: { sessionKey: 'group:55555', downstreamLabel: '127.0.0.1:8080' },
  });
  const win2 = renderWindow(tl.bySession('group:55555'), { selfId: 20002000 });
  assert.equal(win2.includes('agent:memory'), false, `枢纽自己的账不该进窗口：\n${win2}`);
  assert.equal(/下游 bot：\s*$/m.test(win2), false, `不许再现"下游 bot："这种空行：\n${win2}`);
  assert.match(win2, /127\.0\.0\.1:8080：🎉 抓到新猪/, `下游消息要带人话名字：\n${win2}`);

  const digest = buildDigest(events);
  assert.equal(digest.messageCount, 1);
  assert.equal(digest.participants.length, 1);
  assert.equal(digest.participants[0].count, 1);
  const card = renderDigest(digest);
  assert.equal(card.split('/今日小猪').length - 1, 1, `会话卡里多出一条：\n${card}`);
  assert.match(card, /最近 1 条消息/);
});

// ---- 时间戳（m34049 用户要求"所有消息都加上日期和时间"） ----
t('每条消息行都带日期和时间（只有 HH:MM 分不清跨天）', () => {
  const at = new Date(2026, 0, 9, 8, 12, 0).getTime(); // 本地时间 01-09 08:12
  assert.equal(mdhm(at), '01-09 08:12', '行内格式是 MM-DD HH:MM');
  assert.equal(full(at), '2026-01-09 08:12', '锚点格式带年份');
  assert.equal(mdhm(new Date(at)), '01-09 08:12', 'Date 对象照样能用');
  assert.equal(mdhm(null), '--', '没有时间戳：占位而不是 --:--');
  assert.equal(mdhm('昨天'), '--', '坏时间戳不抛异常');

  // 三条渲染路径都得带日期：新消息批行、live context 的窗口、落盘会话卡。
  // 直接给条目数组（时间戳写死成 01-09 08:12），这样断言能锁住"带的是哪一天"。
  const events = [{
    id: 'stamp-1',
    ts: at,
    direction: 'upstream-in',
    linkId: 'up:1',
    kind: 'message',
    sessionKey: 'group:55555',
    actor: { user_id: 10001, nickname: '小明' },
    text: '你还在吗',
    payload: { post_type: 'message', message_type: 'group', group_id: 55555 },
  }];
  const win = renderWindow(events, { selfId: 20002000 });
  assert.match(win, /^01-09 08:12 小明：你还在吗$/m, `窗口行没带日期：\n${win}`);
  const card = renderDigest(buildDigest(events));
  assert.match(card, /^- 01-09 08:12 小明\(10001\)：你还在吗$/m, `会话卡行没带日期：\n${card}`);
  const resumed = { ...buildDigest(events), resumed: true, savedAt: at };
  assert.match(renderDigest(resumed), /重启前留下的那一份，01-09 08:12 为止/, '读回的旧事要标出隔了多久');
});

// ---- 能力面（§22）：分级、retcode 中文、TTL 缓存、能力注册表 ----
t('分级三分法：read 默认、write 显式、danger 一律拦', () => {
  assert.equal(tierOf('get_group_info'), 'read');
  assert.equal(tierOf('get_stranger_info'), 'read');
  assert.equal(tierOf('send_msg'), 'write');
  assert.equal(tierOf('send_like'), 'write');
  assert.equal(tierOf('delete_msg'), 'write');
  assert.equal(tierOf('set_group_card'), 'write');
  assert.equal(tierOf('_send_group_notice'), 'write');
  assert.equal(tierOf('set_restart'), 'danger');
  assert.equal(tierOf('set_group_kick'), 'danger');
  assert.equal(tierOf('.handle_quick_operation'), 'danger');
  assert.equal(tierOf('send_packet'), 'danger');
  // 异步/限速后缀要按基名判级，否则 `_async` 会被当成新的只读 action。
  assert.equal(tierOf('send_msg_async'), 'write');
  assert.equal(tierOf('get_group_info_rate_limited'), 'read');
  assert.equal(baseAction('send_group_msg_async'), 'send_group_msg');
  // 承诺里写死的边界：绝不能让写操作掉进 read。
  for (const action of ['send_msg', 'delete_msg', 'set_group_ban']) assert.notEqual(tierOf(action), 'read');
});

t('敏感只读：凭证类默认不外露', () => {
  assert.equal(isSensitive('get_cookies'), true);
  assert.equal(isSensitive('get_csrf_token'), true);
  assert.equal(isSensitive('get_credentials'), true);
  assert.equal(isSensitive('get_group_info'), false);
  // 敏感是"只读但要授权"，不能顺便当成 danger 拦掉（它仍然只是 read）。
  assert.equal(tierOf('get_cookies'), 'read');
});

t('retcode 中文映射：认识的说人话，不认识的带实现端原文', () => {
  assert.equal(explainRetcode(0).text, '成功');
  assert.equal(explainRetcode(1201).known, true);
  assert.match(explainRetcode(1201).text, /链路未连接/);
  assert.equal(explainRetcode(1403).text, '枢纽策略拒绝');
  const unknown = explainRetcode(9999, 'implement me');
  assert.equal(unknown.known, false);
  assert.match(unknown.text, /未知 retcode 9999/);
  assert.equal(unknown.msg, 'implement me', '未知码必须带实现端 msg，不能硬猜');
  const bare = explainRetcode(null);
  assert.equal(bare.code, null);
  assert.match(bare.text, /没有 retcode/);
  // 规范没有 retcode 取值表（§22.6），所以"未知"是正常情况而不是错误。
  assert.equal(explainRetcode(104).text, '凭证失效，需要重新登录');
});

t('TTL：会话期 / 定时 / 不缓存三档齐备', () => {
  assert.equal(ttlOf('get_login_info'), Infinity);
  assert.equal(ttlOf('get_version_info'), Infinity);
  assert.equal(ttlOf('get_group_member_list'), 60_000);
  assert.equal(ttlOf('get_group_info'), 300_000);
  assert.equal(ttlOf('get_group_honor_info'), 600_000);
  assert.equal(ttlOf('get_msg'), 0, '消息内容会变，不缓存');
  assert.equal(ttlOf('get_image'), 0, '媒体 URL 会过期');
  assert.equal(ttlOf('get_something_unknown'), 60_000, '未列出的只读兜底 60s');
  assert.equal(ttlOf('send_msg'), 0, '写操作永不缓存');
});

t('缓存：键顺序无关、TTL 到期、命中率可观测', () => {
  const cache = new CapabilityCache();
  const t0 = 1_000_000;
  assert.equal(cache.get('get_group_info', { group_id: 1 }, t0), null);
  assert.equal(cache.set('get_group_info', { group_id: 1 }, { group_name: 'A' }, 300_000, t0), true);
  // 参数顺序不同也必须命中同一条。
  const hit = cache.get('get_group_info', { group_id: 1 }, t0 + 1000);
  assert.deepEqual(hit.value, { group_name: 'A' });
  assert.equal(hit.ageMs, 1000);
  assert.equal(cacheKey('get_group_info', { a: 1, b: 2 }), cacheKey('get_group_info', { b: 2, a: 1 }));
  // 到期即消失，并计入 expired。
  assert.equal(cache.get('get_group_info', { group_id: 1 }, t0 + 300_001), null);
  assert.equal(cache.stats.expired, 1);
  // ttl=0 不写。
  assert.equal(cache.set('get_msg', { message_id: 1 }, {}, 0), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 2);
  assert.equal(cache.stats.hitRate, 1 / 3);
});

t('能力注册表：实测结论，1404 不下"不支持"结论', () => {
  const reg = new CapabilityRegistry();
  assert.equal(reg.get('get_group_info'), null);
  assert.equal(reg.snapshot().supported.length, 0);
  reg.note('get_group_info', { ok: true, retcode: 0, source: 'agent' });
  assert.equal(reg.get('get_group_info').supported, 'supported');
  // 1404 = 目标不存在：这个 action 是通的，只是这次对象不对 → 不能记 unsupported。
  reg.note('get_group_info', { ok: false, retcode: 1404, msg: '群不存在' });
  assert.equal(reg.get('get_group_info').supported, 'supported');
  // 100 才是"实现端不认这个 action"。
  reg.note('_get_group_notice', { ok: false, retcode: 100, msg: 'unsupported action' });
  assert.equal(reg.get('_get_group_notice').supported, 'unsupported');
  // 英文/中文的实现端原文同样能下结论。
  reg.note('get_qq_avatar', { ok: false, retcode: 1, msg: '该接口不支持' });
  assert.equal(reg.get('get_qq_avatar').supported, 'unsupported');
  // 普通失败（超时）不下结论，只在记录里留一笔。
  reg.note('get_friend_list', { ok: false, retcode: 1200, msg: 'timeout' });
  assert.equal(reg.get('get_friend_list').supported, 'unknown');
  assert.equal(reg.get('get_friend_list').lastRetcode, 1200);
  const snap = reg.snapshot();
  assert.deepEqual(snap.supported, ['get_group_info']);
  assert.deepEqual(snap.unsupported.sort(), ['_get_group_notice', 'get_qq_avatar']);
  assert.match(snap.note, /unknown 表示还没调用过/);
  // 实现端身份探测。
  reg.noteProbe({ appName: 'LLBot', appVersion: '1.2.3', protocolVersion: 'v11', selfId: 3371846367, nickname: 'dsh-hub' });
  assert.equal(reg.impl.app_name, 'LLBot');
  assert.equal(reg.impl.self_id, 3371846367);
  assert.equal(reg.snapshot().probes.length, 1);
});

t('统一返回形状：缓存来源与失败原因都讲清楚', () => {
  const ok = shapeResult({ action: 'get_group_info', envelope: { status: 'ok', retcode: 0, data: { group_name: 'A' } }, tier: 'read' });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, 'upstream');
  assert.equal(ok.retcode, 0);
  assert.equal(ok.action, 'get_group_info');
  assert.equal(ok.note, null);
  const cached = shapeResult({
    action: 'get_group_info',
    envelope: { status: 'ok', retcode: 0, data: { group_name: 'A' } },
    source: 'cache',
    ageMs: 65_000,
    tier: 'read',
  });
  assert.equal(cached.ok, true);
  assert.match(cached.note, /来自缓存（65 秒前）/);
  const failed = shapeResult({ action: 'set_group_card', envelope: { status: 'failed', retcode: 1403, msg: '策略拒绝' }, tier: 'write' });
  assert.equal(failed.ok, false);
  assert.match(failed.note, /枢纽策略拒绝/);
  assert.match(failed.note, /实现端原文：策略拒绝/);
  // 没有 data 字段时也不许崩。
  const bare = shapeResult({ action: 'x', envelope: {} });
  assert.equal(bare.ok, false);
  assert.equal(bare.data, null);
});

t('下游响应形状：只回协议字段，status/retcode 原样透传', () => {
  // `shapeResult` 是给 agent 看的（带 source/tier/note），回给下游 bot 的必须是协议信封。
  const ok = toWireResponse(shapeResult({ action: 'get_group_info', envelope: { status: 'ok', retcode: 0, data: { group_name: 'A' } }, tier: 'read' }), 'e7');
  assert.deepEqual(Object.keys(ok).sort(), ['data', 'echo', 'retcode', 'status']);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.retcode, 0);
  assert.equal(ok.echo, 'e7');
  assert.equal(ok.data.group_name, 'A');
  // `async` 是实现端的合法应答（发送类会用到），不许被 hub 改写成 failed。
  const async = toWireResponse({ ok: false, status: 'async', retcode: 1, data: { message_id: 5 } }, 'e8');
  assert.equal(async.status, 'async');
  assert.equal(async.retcode, 1);
  // 失败时把中文说明放进 msg（实现端自己也这么发）。
  const denied = toWireResponse({ ok: false, status: 'failed', retcode: 1403, data: null, note: '策略拒绝：get_cookies 是凭证类只读接口。' }, 'e9');
  assert.equal(denied.retcode, 1403);
  assert.match(denied.msg, /凭证类只读接口/);
  assert.equal(toWireResponse(null).retcode, 1200);
  assert.equal(toWireResponse({ ok: true }).retcode, 0);
});

t('管理动作面：人话 op → OneBot action，只收集白名单字段', () => {
  const mute = planAdminOp('mute', { group_id: 55555, user_id: 10001, duration: 600, 幻觉字段: 'x' });
  assert.equal(mute.ok, true);
  assert.equal(mute.action, 'set_group_ban');
  assert.deepEqual(mute.params, { group_id: 55555, user_id: 10001, duration: 600 });
  assert.equal('幻觉字段' in mute.params, false);
  assert.match(mute.describe, /在群 55555 禁言 10001 600 秒/);
  // 每个 op 都指向**标准** action（扩展接口不放这里，要用就 onebot_call）。
  for (const [op, spec] of Object.entries(ADMIN_OPS)) {
    assert.ok(spec.action && typeof spec.action === 'string', `${op} 缺 action`);
    assert.ok(spec.required.every((f) => spec.fields.includes(f)), `${op} 的 required 不在 fields 里`);
    assert.equal(typeof spec.describe({ ...Object.fromEntries(spec.fields.map((f) => [f, 'x'])), enable: true, approve: true }), 'string');
  }
  const unmute = planAdminOp('mute', { group_id: 1, user_id: 2, duration: 0 });
  assert.match(unmute.describe, /解除禁言/);
  const kick = planAdminOp('kick', { group_id: 1, user_id: 2, reject_add_request: true });
  assert.equal(kick.action, 'set_group_kick');
  assert.equal(kick.irreversible, true);
  assert.match(kick.describe, /拒绝其再次加群/);
  const group = planAdminOp('handle_group_request', { flag: 'f1', sub_type: 'invite', approve: true });
  assert.equal(group.action, 'set_group_add_request');
  assert.match(group.describe, /同意入群邀请/);
});

t('管理动作面：缺参数 / 取值非法 / 未知 op 都给出可照着改的错误', () => {
  const missing = planAdminOp('mute', { group_id: 55555 });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['user_id', 'duration']);
  assert.match(missing.error, /mute 缺少必需参数：user_id、duration/);
  const bad = planAdminOp('mute', { group_id: 1, user_id: 2, duration: -1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /duration 必须是非负整数/);
  const badBool = planAdminOp('ban_all', { group_id: 1, enable: 'yes' });
  assert.equal(badBool.ok, false);
  assert.match(badBool.error, /enable 必须是布尔值/);
  const unknown = planAdminOp('踢人', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知管理动作 踢人/);
  assert.match(unknown.error, /可用：mute、kick/);
  assert.equal(planAdminOp('').ok, false);
});

t('只读缓存与能力注册表能序列化往返（重启后不必重踩同一个坑）', () => {
  const cache = new CapabilityCache();
  const now = 1_700_000_000_000;
  cache.set('get_group_info', { group_id: 55555 }, { group_name: 'A' }, 300_000, now);
  cache.set('get_msg', { message_id: 1 }, { x: 1 }, 0, now); // ttl=0 不写
  const dump = JSON.parse(JSON.stringify(cache.toJSON()));
  assert.equal(dump.entries.length, 1);
  const revived = new CapabilityCache();
  assert.equal(revived.load(dump, now + 60_000), 1, '没过期的条目应被载入');
  const hit = revived.get('get_group_info', { group_id: 55555 }, now + 60_000);
  assert.equal(hit.value.group_name, 'A');
  assert.equal(hit.ageMs, 60_000, '年龄按绝对时间算，重启后仍知道自己多旧');
  // 过期的直接丢，不占内存也不当命中。
  const late = new CapabilityCache();
  assert.equal(late.load(dump, now + 400_000), 0);
  assert.equal(late.size, 0);

  const registry = new CapabilityRegistry();
  registry.noteProbe({ appName: 'LLBot', appVersion: '1.2.3', selfId: '3371846367', nickname: 'dsh-hub' });
  registry.note('get_group_info', { ok: true, retcode: 0, source: 'upstream' });
  registry.note('_get_group_notice', { ok: false, retcode: 100, msg: 'not supported' });
  const snap = registry.snapshot();
  const loaded = new CapabilityRegistry();
  assert.equal(loaded.load(JSON.parse(JSON.stringify(registry.toJSON()))), 2);
  const after = loaded.snapshot();
  assert.deepEqual(after.supported, snap.supported);
  assert.deepEqual(after.unsupported, snap.unsupported);
  assert.equal(after.impl.app_name, 'LLBot');
  assert.equal(loaded.reset(), 2, 'reset 返回清掉了多少条');
  assert.deepEqual(loaded.snapshot().supported, []);
});

t('JsonStore：原子写、坏文件兜底、dir 为空即关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-store-'));
  const store = new JsonStore({ dir });
  assert.equal(store.enabled, true);
  assert.equal(store.write('capabilities/x.json', { a: 1 }), true);
  assert.deepEqual(store.read('capabilities/x.json'), { a: 1 });
  assert.equal(store.read('capabilities/不存在.json', 'fallback'), 'fallback');
  // 坏文件：返回兜底，并把坏文件改名保留（不然下次读还是坏的）。
  fs.writeFileSync(store.path('bad.json'), '{ 半截', 'utf8');
  assert.equal(store.read('bad.json', null), null);
  assert.equal(fs.existsSync(store.path('bad.json.bad')), true);
  // 防抖合并写：producer 真的落盘时才调用，flush 一次全部落地。
  let produced = 0;
  store.schedule('a.json', () => ({ n: ++produced }));
  store.schedule('a.json', () => ({ n: ++produced }));
  assert.deepEqual(store.read('a.json', null), null, 'schedule 不应立刻写');
  assert.equal(store.flush(), 1, '两个待写同名文件应合并成一次');
  assert.deepEqual(store.read('a.json'), { n: 1 });
  assert.equal(store.stats.written >= 2, true);
  const disabled = new JsonStore({ dir: '' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.path('x.json'), null);
  assert.equal(disabled.write('x.json', { a: 1 }), false);
  assert.equal(disabled.schedule('x.json', () => ({})), false);
  assert.equal(safeName('up:listen:127.0.0.1:14514/onebot/v11/ws'), 'up_listen_127.0.0.1_14514_onebot_v11_ws');
  // 中文键必须逐字转义，不能一起塌成 `_`：否则"每个中文话题写进同一个文件、读谁都是最后写的那个"。
  assert.notEqual(safeName('散热改装'), safeName('没这个话题'));
  assert.equal(safeName('散热改装'), safeName('散热改装'));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('记忆条目落盘：合并写、重启读回、一行脏数据不废整份（§24.10）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mem-'));
  try {
    const storage = new JsonStore({ dir, debounceMs: 50 });
    const s1 = new MemoryStore({ storage, log: () => {} });
    assert.equal(s1.stats.persistent, true);
    assert.equal(s1.loaded, 0);

    const a = s1.add({
      text: '我喜欢吃辣',
      kind: 'identity',
      scope: 'group:55555',
      ts: 1_700_000_000_000,
      actor: { user_id: '10001' },
      refs: { message_id: '12' },
    });
    s1.add({ text: '他今天心情不好', scope: 'private:10001', sensitive: true });
    assert.equal(storage.stats.pending >= 1, true, '改动只排队，不逐次落盘');
    storage.flush();

    // 重启读回：id/时间/来源/可见性都要还在（id 对不上，模型就没法 modify）。
    const s2 = new MemoryStore({ storage, log: () => {} });
    assert.equal(s2.loaded, 2);
    assert.equal(s2.stats.loaded, 2);
    const back = s2.byId(a.id);
    assert.ok(back, 'id 要能对上');
    assert.equal(back.text, '我喜欢吃辣');
    assert.equal(back.kind, 'identity');
    assert.equal(back.ts, 1_700_000_000_000);
    assert.equal(back.actor.user_id, '10001');
    assert.equal(back.refs.message_id, '12');
    assert.equal(s2.all().find((e) => e.text.includes('心情')).sensitive, true);

    // 改与删也要落盘（否则重启后"改回来的"又变回去）。
    const target = s2.all().find((e) => e.text.includes('心情'));
    s2.modify(target.id, { text: '他今天心情不错' });
    s2.remove(a.id);
    storage.flush();
    const s3 = new MemoryStore({ storage, log: () => {} });
    assert.equal(s3.all().length, 1);
    assert.equal(s3.all()[0].text, '他今天心情不错');

    // 脏数据：没有 id/text 的坏条目跳过，好的照常读回。
    fs.writeFileSync(
      path.join(dir, 'memory', 'store.json'),
      JSON.stringify({ version: 1, entries: [{ nope: true }, { id: 'x1', text: '还在', ts: 1 }] }),
      'utf8',
    );
    const s4 = new MemoryStore({ storage, log: () => {} });
    assert.equal(s4.loaded, 1);
    assert.equal(s4.all()[0].text, '还在');

    // 不接存储 = 纯内存（测试与"不留痕"部署都靠它）。
    const mem = new MemoryStore({});
    assert.equal(mem.stats.persistent, false);
    assert.equal(mem.stats.file, null);
    mem.add({ text: '只活在内存里' });
    assert.equal(mem.all().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('记忆去重：同一条只留一条、读回折掉历史重复、索引不会指向死条目（§24.11）', () => {
  // 键本身：空白折叠后才比较，"同一个人"在不同 scope/不同说话人那里仍是不同的条。
  assert.equal(normalizeMemoryText('  a\t b\n c  '), 'a b c');
  assert.equal(
    memoryDedupeKey({ kind: 'identity', scope: 'group:1', text: 'x' }),
    memoryDedupeKey({ kind: 'identity', scope: 'group:1', text: ' x ' }),
  );
  assert.notEqual(
    memoryDedupeKey({ kind: 'identity', scope: 'group:1', text: 'x' }),
    memoryDedupeKey({ kind: 'identity', scope: 'group:2', text: 'x' }),
  );

  const s = new MemoryStore({});
  const text = 'FunnyPotato 是 QQ 945126014（owner）';
  const a = s.add({ text, kind: 'identity', scope: 'group:617770183', actor: { user_id: '945126014' } });
  const b = s.add({ text: `  ${text}  `, kind: 'identity', scope: 'group:617770183', actor: { user_id: '945126014' }, refs: { message_id: '99' } });
  assert.equal(s.all().length, 1, '同一条不该堆成两行');
  assert.equal(b.id, a.id, '返回的是已有那条（id 不变，模型才 modify 得到）');
  assert.equal(a.refs.message_id, '99', '折叠时补上原来缺的线索');
  assert.equal(s.stats.deduped, 1);

  // 换群 / 换说话人 = 另外的条（可见性边界与归属都不同）。
  s.add({ text, kind: 'identity', scope: 'group:55555', actor: { user_id: '945126014' } });
  assert.equal(s.all().length, 2);
  s.add({ text, kind: 'identity', scope: 'group:617770183', actor: { user_id: '10001' } });
  assert.equal(s.all().length, 3);
  // 空文本不参与合并（否则一堆空条目会挤成一条，且没有信息量）。
  s.add({ text: '' });
  s.add({ text: '   ' });
  assert.equal(s.all().length, 5);
  // 刻意造重复仍要能造（导入/测试/`dedupe:false`）。
  s.add({ text: '刻意两条', scope: 'group:617770183' }, { dedupe: false });
  s.add({ text: '刻意两条', scope: 'group:617770183' }, { dedupe: false });
  assert.equal(s.all().filter((e) => e.text === '刻意两条').length, 2);

  // 模型把同一句话同时写进短期与长期（同一批、`blocks` 快照还没更新）：库里只该有一条，
  // 而且报告要如实说"去重了 1 条"，不能报成 add 2。
  const w = new MemoryStore({});
  const wbase = {
    store: w,
    profiles: new Profiles({ storage: null }),
    sessionKey: 'group:55555',
    worldKey: 'group:55555',
    actorId: '10001',
    isolation: resolveIsolation({ level: 'scoped' }),
  };
  const r5 = applyMemoryOps(
    { short_term: { add: [{ text: '一句话' }] }, long_term: { add: [{ text: '一句话' }] } },
    wbase,
  );
  assert.equal(w.all().length, 1, '同一句话不该在库里存两份');
  assert.equal(r5.blocks.short_term.add + r5.blocks.long_term.add, 1);
  assert.equal(r5.blocks.short_term.deduped + r5.blocks.long_term.deduped, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dedupe-'));
  try {
    const storage = new JsonStore({ dir, debounceMs: 50 });
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'memory', 'store.json'),
      JSON.stringify({
        version: 1,
        // 修复前落盘的文件长这样：同一件事被每轮观测各加了一次。
        entries: [
          { id: 'x1', text: '同一件事', kind: 'fact', scope: 'group:1', ts: 1 },
          { id: 'x2', text: '同一件事', kind: 'fact', scope: 'group:1', ts: 2, refs: { message_id: '7' } },
          { id: 'x3', text: '另一件事', kind: 'fact', scope: 'group:1', ts: 3 },
        ],
      }),
      'utf8',
    );
    const logs = [];
    const s2 = new MemoryStore({ storage, log: (m) => logs.push(String(m)) });
    assert.equal(s2.loaded, 2, '读回时折掉重复');
    assert.equal(s2.collapsed, 1);
    assert.equal(s2.byId('x2'), null, '被折掉的那条真的不在');
    assert.equal(s2.all()[0].refs.message_id, '7', '线索要补到留下的那条上');
    assert.ok(logs.some((m) => m.includes('折叠了 1 条')), '折叠过就要留一行日志，别静默删数据');

    // modify 把两条改成同一句话 → 索引仍指向活着的那条；这条再被删掉，也不会写出重复。
    const target = s2.all().find((e) => e.text === '另一件事');
    s2.modify(target.id, { text: '同一件事' });
    assert.equal(s2.all().length, 2);
    s2.remove(target.id);
    assert.equal(s2.all().length, 1);
    const again = s2.add({ text: '同一件事', kind: 'fact', scope: 'group:1' });
    assert.equal(s2.all().length, 1, '删掉后同文本应是"已经有了"，不是又加一条');
    assert.equal(again.id, 'x1');
    assert.equal(s2.byId('x2'), null);

    // clear 之后索引也要清干净（否则清空后写第一条会被自己挡下）。
    s2.clear();
    assert.equal(s2.all().length, 0);
    s2.add({ text: '同一件事', kind: 'fact', scope: 'group:1' });
    assert.equal(s2.all().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('记忆写入：modify 优先于 add、越界与未知字段不静默、可见性由代码判定', () => {
  const store = new MemoryStore({});
  const profiles = new Profiles({ storage: null });
  const base = { store, profiles, sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', isolation: resolveIsolation({ level: 'scoped' }), now: 1_700_000_000_000 };

  const r1 = applyMemoryOps(
    { short_term: { add: [{ text: '第一件事' }, { text: '第二件事' }] } },
    base,
  );
  assert.equal(r1.blocks.short_term.add, 2);
  assert.equal(store.all().length, 2);

  // 模型给 visibility：记一条 rejection，但条目仍按代码推断落盘（不能静默采纳，也不能静默丢弃）。
  const r2 = applyMemoryOps({ short_term: { add: [{ text: '私事', visibility: 'shareable' }] } }, base);
  assert.equal(r2.applied.short_term.add, 1);
  assert.ok(r2.rejected.some((x) => x.path.endsWith('visibility')), JSON.stringify(r2.rejected));
  assert.equal(store.all().find((e) => e.text === '私事').visibility, 'group:55555');

  // modify 先于 add：同批里"改第 0 条"必须打到**改之前**的第 0 条。
  const r3 = applyMemoryOps({ short_term: { modify: [{ index: 0, content: '第一件事（已更正）' }], add: [{ text: '新加的' }] } }, base);
  assert.equal(r3.blocks.short_term.modify, 1);
  assert.equal(store.all().filter((e) => e.text === '第一件事').length, 0);
  assert.ok(store.all().some((e) => e.text === '第一件事（已更正）'));

  const r4 = applyMemoryOps({ short_term: { modify: [{ index: 99, content: 'x' }], 未知操作: [] }, 未知顶层: {} }, base);
  assert.ok(r4.rejected.some((x) => /序号越界/.test(x.reason)));
  assert.ok(r4.rejected.some((x) => /未知操作/.test(x.reason)));
  assert.ok(r4.rejected.some((x) => /未知字段/.test(x.reason)));
  assert.equal(applyMemoryOps('不是对象', base).ok, false);
});

t('曾用名与话题关联：改名之后还认得出人，引用关系才接线（§24.11/§24.4）', () => {
  const profiles = new Profiles({ storage: null, now: () => 1_700_000_000_000 });
  const at = 1_700_000_000_000;
  profiles.noteName('10001', '小明', 'group:55555', at);
  profiles.noteName('10001', '明哥', 'group:55555', at + 1000);
  profiles.noteName('10001', '老张', 'group:77777', at + 2000);

  // 曾用名：排除当前名，同 scope 的排前面。
  const past = profiles.pastNames('10001', { scope: 'group:55555' });
  assert.deepEqual(past.map((p) => p.name), ['小明', '老张']);
  assert.equal(past[0].scope, 'group:55555');
  assert.equal(profiles.pastNames('99999').length, 0, '没有档案的人不该凭空有曾用名');

  // 反查：当前名优先于曾用名，且"当前"要按命中的那个 scope 判。
  const byCurrent = profiles.lookupName('明哥', { scope: 'group:55555' });
  assert.equal(byCurrent[0].userId, '10001');
  assert.equal(byCurrent[0].past, false);
  assert.equal(byCurrent[0].current, '明哥');
  const byPast = profiles.lookupName('小明', { scope: 'group:55555' });
  assert.equal(byPast[0].past, true);
  assert.equal(byPast[0].current, '明哥');
  assert.equal(profiles.lookupName('没人叫这个').length, 0);

  // 人物卡里要写出来，否则模型会把同一个人当两个。
  const card = renderPerson(profiles.person('10001'), { sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', isolation: resolveIsolation({ level: 'balanced' }) });
  assert.match(card, /也曾叫过：小明/);

  // 话题关联：只认明写的引用（events 里的时间线 id / refs 里的消息 id），不做关键词猜测。
  const topic = profiles.upsertTopic('t1', { title: '那个 bug', refs: [{ messageId: '9001' }], members: ['10002'] }, at);
  assert.equal(topic.events.length, 0);
  assert.equal(topicHoldsMessage(topic, { messageId: '9002' }), false);
  assert.equal(topicHoldsMessage(topic, { messageId: '9001' }), true);
  assert.equal(topicHoldsMessage({ events: ['ev1'] }, { eventId: 'ev1' }), true);
  assert.equal(topicHoldsMessage(topic, {}), false, '没有证据就不要接');

  const attached = profiles.attachTopicByReply({ eventId: 'ev2', messageId: '9001', worldKey: 'group:66666', actorId: '10003' });
  assert.equal(attached.id, 't1');
  assert.deepEqual(attached.events, ['ev2']);
  assert.ok(attached.worldKeys.includes('group:66666'), '话题可跨群：接进来的世界要补上');
  assert.ok(attached.members.includes('10003'));
  assert.equal(attached.title, '那个 bug', '接进来不能把已有内容冲掉');
  assert.equal(profiles.attachTopicByReply({ eventId: 'ev9', messageId: '9999' }), null, '没有对得上的话题就不接');
});

t('档案：名字跟着群走、档案跟着人走；系统字段与禁区不给模型改', () => {
  const profiles = new Profiles({ storage: null });
  const at = 1_700_000_000_000;
  profiles.noteName('10001', '小明', 'group:55555', at);
  profiles.noteName('10001', '小明', 'group:55555', at + 1000); // 同名同 scope 只更新时间
  profiles.noteName('10001', '明哥', 'group:77777', at + 2000);
  profiles.noteGroupCard('10001', 'group:55555', { card: '小明同学', role: 'admin', title: '课代表' }, at + 3000);
  const p = profiles.person('10001');
  assert.equal(p.names.length, 3, '群名片也算一个名字');
  assert.equal(nameIn(p, 'group:55555'), '小明同学', '同一个群里有名片就用名片');
  assert.equal(nameIn(p, 'group:77777'), '明哥', '名字跟着群走');
  assert.equal(p.groups['group:55555'].role, 'admin');

  // 模型改不了系统字段：`upsertPerson` 只认白名单（names/groups 不在其中）。
  profiles.upsertPerson('10001', { names: [{ name: '假名字' }], groups: {}, impression: '话不多' }, at + 4000);
  assert.equal(profiles.person('10001').names.length, 3);
  assert.equal(profiles.person('10001').impression, '话不多');
  // 亲近度夹在 -5..5
  profiles.upsertPerson('10001', { relationship: { closeness: 99 } }, at + 5000);
  assert.equal(profiles.person('10001').relationship.closeness, 5);
  // 同名去重按各自的上限合并，而不是无限追加
  profiles.upsertPerson('10001', { facts: [{ text: '在写机器人' }, { text: '在写机器人' }] }, at + 6000);
  assert.equal(profiles.person('10001').facts.length, 1);
  // 会话清单：同 worldKey 只有一条，且 lastSeenAt 能更新
  profiles.touchSession('group:55555', { kind: 'group', lastMessageAt: at }, at);
  profiles.touchSession('group:55555', { lastSeenAt: at + 9000 }, at + 9000);
  assert.equal(profiles.sessions().length, 1);
  assert.equal(profiles.sessionOf('group:55555').lastSeenAt, at + 9000);
  // 存储关掉时仍能读能写（只是不落盘）
  assert.equal(profiles.enabled, false);
  assert.equal(profiles.snapshot().cached >= 1, true);
});

// ---- 检索（§24.9 M17）：中文分词、衰减、检索层的隔离 ----
t('检索分词：中文按 bigram 切，两字词搜得到四字句', () => {
  const tokens = tokenize('今天天气不错');
  assert.ok(tokens.includes('今天'));
  assert.ok(tokens.includes('天气'), '两字词必须成 token，否则 FTS5 的 unicode61 会把整句当一个词');
  assert.ok(tokenize('FTS5 与 SQLite3').includes('fts5'), '英文数字按整词小写');
  assert.deepEqual(tokenize('!!!'), []);
  assert.deepEqual(tokenize(''), []);
});

t('遗忘是降权不是删除：旧事强度低但仍查得到', () => {
  const now = 1_700_000_000_000;
  const fresh = { id: 'm1', kind: 'fact', text: '他最近在写机器人', ts: now - 3600_000, refs: { message_id: 1 }, mentions: 5 };
  const stale = { id: 'm2', kind: 'fact', text: '他半年前说过要换工作', ts: now - 200 * 24 * 3600_000, refs: { message_id: 2 }, mentions: 1 };
  const good = decayStrength(fresh, { now });
  const bad = decayStrength(stale, { now });
  assert.ok(good > bad, `新的比旧的高：${good} vs ${bad}`);
  assert.equal(isWeak(stale, { now }), true);
  assert.equal(isWeak(fresh, { now }), false);
  assert.deepEqual([...weakMessageIds([fresh, stale], { now })], ['2'], '弱记忆只降检索权重，数据还在');
});

// ---- 主动回忆（§24.6 M18）：只交事实、隔离再生效一次、24 小时安全阀 ----
t('主动回忆只挑"还没兑现的承诺"，并且要过一遍隔离', () => {
  const now = 1_700_000_000_000;
  const persons = [
    {
      userId: '10001',
      names: [{ name: '小明', scope: 'group:55555' }],
      groups: { 'group:55555': { card: '小明', lastSentAt: now - 3600_000 } },
      commitments: [
        { what: '帮他看一个 bug', due: now - 3 * 86400_000, status: 'open', scope: 'group:55555' },
        { what: '已经做完了的事', status: 'done', scope: 'group:55555' },
      ],
    },
    {
      userId: '10002',
      names: [{ name: '小红', scope: 'private:10002' }],
      commitments: [{ what: '帮他带一份午饭', status: 'open', scope: 'private:10002' }],
    },
  ];
  const isolation = resolveIsolation({ level: 'scoped' });
  const inGroup = collectCues({ persons, sessionKey: 'group:55555', worldKey: 'group:55555', isolation, now });
  assert.equal(inGroup.length, 1, '已兑现的不算，别的会话学到的也不该漏过来');
  assert.equal(inGroup[0].name, '小明');
  assert.equal(inGroup[0].what, '帮他看一个 bug');
  assert.equal(inGroup[0].overdueDays, 3);
  assert.equal(inGroup[0].lastSeenAt, now - 3600_000);
  assert.equal(inGroup[0].key, cueKey('10001', '帮他看一个 bug'));

  const inPrivate = collectCues({ persons, sessionKey: 'private:10002', worldKey: 'private:10002', isolation, now });
  assert.deepEqual(inPrivate.map((c) => c.what), ['帮他带一份午饭'], '私聊视角只看得到私聊里答应的事');
});

t('主动回忆的渲染是陈述句，不是命令', () => {
  const now = 1_700_000_000_000;
  const text = renderCues(
    [{ key: 'k', name: '小明', what: '帮他看一个 bug', due: now - 3 * 86400_000, overdueDays: 3, lastSeenAt: now - 2 * 3600_000 }],
    { now },
  );
  assert.match(text, /【还没兑现的事】/);
  assert.match(text, /你答应过「小明」：帮他看一个 bug（当时说大约 .*，已经过了 3 天；他上次露面是 2 小时前）/);
  assert.ok(!/(该提醒|必须|现在就去|别忘了|催)/.test(text), '代码不下命令：提不提由模型判断');
  assert.equal(renderCues([], { now }), '');
});

t('24 小时安全阀：同一条承诺一天最多进一次 prompt', () => {
  const now = 1_700_000_000_000;
  const reminders = new Reminders({});
  const cues = [{ key: '10001:帮他看一个 bug' }];
  assert.equal(reminders.canAsk(cues[0].key, now), true, '从没提过');
  reminders.note(cues, now);
  assert.equal(reminders.filter(cues, now + 1000).length, 0);
  assert.equal(reminders.filter(cues, now + 24 * 3600_000).length, 1, '满 24 小时可以再来');
  assert.equal(reminders.stats.windowHours, 24);
  // 关掉安全阀 = 每次都提（windowMs 为 0），不是"永远不提"
  const off = new Reminders({ windowMs: 0 });
  off.note(cues, now);
  assert.equal(off.filter(cues, now + 1).length, 1);
  // 账本本身有上限，不会无限长
  const many = new Reminders({ max: 2 });
  many.note([{ key: 'a' }, { key: 'b' }, { key: 'c' }], now);
  assert.equal(many.stats.tracked, 2);
});

t('段 → 人话：@换称呼、引用带原文、媒体带 durable ref', () => {
  const segments = [
    { type: 'at', data: { qq: '10002' } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: ' 看这个  ' } },
    { type: 'image', data: { file: 'x.png', summary: '一张图' } },
    { type: 'record', data: { file: 'a.amr', duration: 12 } },
    { type: 'face', data: { id: 13 } },
    { type: 'face', data: { id: 9999 } },
    { type: 'reply', data: { id: 77 } },
    { type: 'reply', data: { id: 78 } },
    { type: 'file', data: { name: '报告.pdf', file_size: 1258291 } },
    { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { title: '分享' } }, prompt: '标题' }) } },
    { type: 'unknown_thing', data: {} },
  ];
  const text = describeSegments(segments, {
    nameOf: (qq) => (String(qq) === '10002' ? '小红' : null),
    quoteOf: (id) => (String(id) === '77' ? { actor: '小明', text: '我发了个图' } : null),
    mediaRefs: new Map([
      [3, { id: 'hub-media:deadbeef1234' }],
      [4, { id: 'hub-media:cafe00001111', text: '我到了，别等我吃饭' }],
    ]),
  });
  assert.match(text, /@小红 @全体成员 /, 'at 段换成称呼；@全体是事故，代码直接拒不了但必须显式标注');
  assert.ok(text.includes(' 看这个  '), 'text 段原文保留空白');
  assert.match(text, /\[图片：一张图\]（已存为 hub-media:deadbeef1234）/);
  assert.match(text, /\[语音 12s\]“我到了，别等我吃饭”/, '有转写就给转写');
  assert.match(text, /\[表情：呲牙\]/);
  assert.match(text, /\[表情 9999\]/, '映射表里没有的就老老实实给编号');
  assert.match(text, /↩回复「小明：我发了个图」/);
  assert.match(text, /↩回复了一条消息（id 78，内容不在手边）/);
  assert.match(text, /\[文件：报告\.pdf 1\.2 MB\]/);
  assert.match(text, /\[卡片：分享\]/);
  assert.match(text, /\[unknown_thing\]/, '不认识的段给占位，不许静默丢掉');

  // 没有转写时说"听不了"，不猜内容
  const noAsr = describeSegments([{ type: 'record', data: { duration: 5 } }]);
  assert.match(noAsr, /\[语音 5s\]（我听不了语音，别猜内容）/);

  // notice 也要人话
  assert.match(describeNotice({ notice_type: 'group_decrease', user_id: 1, operator_id: 2, sub_type: 'kick' }), /被 用户2 移出群/);
  assert.match(describeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), /\[元事件 heartbeat\]/);
});

t('字节嗅探：按 magic 认类型，认不出来就是 octet-stream', () => {
  assert.equal(sniffType(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')).mediaType, 'image/png');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mediaType, 'image/jpeg');
  assert.equal(sniffType(Buffer.from('#!AMR\n0011', 'latin1')).mediaType, 'audio/amr');
  assert.equal(sniffType(Buffer.from([0x00, 0x01, 0x02, 0x03])).mediaType, 'application/octet-stream');
  assert.equal(extOf('image/webp'), 'webp');
  assert.equal(extOf('audio/mpeg'), 'mp3');
});

t('媒体落地：内联字节写成自己的 blob，同时登记宿主 attachments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-core-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const attached = [];
  const media = new MediaStore({ storage: store, linkId: 'up:test', log: () => {} });
  media.attach({
    async saveImage(input) {
      attached.push(['image', input.mediaType, input.data.length]);
      return { attachmentId: 'sha256:abc', mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length };
    },
    async saveFile(input) {
      attached.push(['file', input.mediaType, input.data.length]);
      return { attachmentId: 'sha256:def', mediaType: input.mediaType, bytes: input.data.length };
    },
  });

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  return Promise.resolve()
    .then(async () => {
      const ref = await media.resolve({ type: 'image', data: { file: `base64://${png}` } }, { messageId: 11, index: 0 });
      assert.equal(ref.kind, 'image');
      assert.equal(ref.mediaType, 'image/png');
      assert.match(ref.sha256, /^[0-9a-f]{64}$/);
      assert.equal(ref.provenance, 'inline');
      assert.equal(ref.attachmentId, 'sha256:abc');
      assert.ok(fs.existsSync(ref.blob), 'blob 必须真的落盘');
      assert.deepEqual(attached[0], ['image', 'image/png', Buffer.from(png, 'base64').length]);

      // 同一条消息里的多个媒体段 → 旁路表（下标 → ref），段数组零改写
      const segments = [
        { type: 'text', data: { text: '看图' } },
        { type: 'image', data: { file: `base64://${png}` } },
        { type: 'file', data: { file: `base64://${Buffer.from('hello').toString('base64')}`, name: 'a.txt' } },
      ];
      const before = JSON.stringify(segments);
      const { refs, records } = await media.resolveEvent(segments, { messageId: 12 });
      assert.equal(JSON.stringify(segments), before, '落地不许改段数组');
      assert.equal(records.length, 2);
      assert.equal(refs.get(1).kind, 'image');
      assert.equal(refs.get(2).kind, 'file');
      assert.equal(media.stats.blobs >= 2, true);
      assert.equal(media.list({ limit: 5 }).length >= 2, true);

      media.detach();
      assert.equal(media.stats.attachments, false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
});

t('媒体 readRef：URL/data:/base64:///本地路径/hub-media 都读成字节，且不落盘不登记', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-readref-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const media = new MediaStore({
    storage: store,
    linkId: 'up:test',
    log: () => {},
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => png,
    }),
  });

  return Promise.resolve().then(async () => {
    const before = media.stats.cached;

    const inline = await media.readRef(`base64://${png.toString('base64')}`);
    assert.equal(inline.provenance, 'inline');
    assert.equal(inline.mediaType, 'image/png');
    assert.equal(inline.bytes.length, png.length);

    const dataUri = await media.readRef(`data:image/png;base64,${png.toString('base64')}`);
    assert.equal(dataUri.mediaType, 'image/png');
    assert.equal(dataUri.bytes.length, png.length);

    const file = path.join(dir, 'ref.png');
    fs.writeFileSync(file, png);
    const local = await media.readRef(file);
    assert.equal(local.provenance, 'local');
    assert.equal(local.mediaType, 'image/png');
    assert.equal(local.bytes.length, png.length);

    const remote = await media.readRef('https://example.com/a.png');
    assert.equal(remote.provenance, 'remote');
    assert.equal(remote.mediaType, 'image/png');

    // 落地过的 ref 直接读它的 blob（模型常拿到 `hub-media:<id>`）
    const saved = await media.resolve({ type: 'image', data: { file: `base64://${png.toString('base64')}` } }, { messageId: 21, index: 0 });
    const fromRef = await media.readRef(saved.id);
    assert.equal(fromRef.provenance, 'hub-media');
    assert.equal(fromRef.bytes.length, png.length);
    assert.equal(fromRef.mediaType, 'image/png');

    // 认不出的写法要说出"该怎么给"，不能空手返回让上游以为没传
    const bad = await media.readRef('随便一句话');
    assert.match(bad.error, /认不出的参考图写法/);
    assert.equal(bad.bytes, undefined);
    const missing = await media.readRef('hub-media:不存在的id');
    assert.match(missing.error, /找不到已落地的媒体/);

    assert.equal(media.stats.cached, before + 1, 'readRef 自己不许登记新 ref（只允许那次 resolve）');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

t('语音转写：两个扩展都试，都拿不到就诚实说听不了（绝不猜）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-asr-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const calls = [];
  const make = (answer) => new MediaStore({
    storage: store,
    linkId: 'up:test',
    log: () => {},
    callAction: async (action) => {
      calls.push(action);
      return answer(action);
    },
  });

  return Promise.resolve().then(async () => {
    const amr = `base64://${Buffer.from('#!AMR\n0000', 'latin1').toString('base64')}`;
    const ok = make((a) => (a === 'voice_msg_to_text' ? { ok: true, data: { text: '转写结果' } } : { ok: false, retcode: 100, note: '实现端不支持 fetch_ptt_text' }));
    const good = await ok.resolve({ type: 'record', data: { file: amr, duration: 4 } }, { messageId: 21 });
    assert.equal(good.text, '转写结果');
    assert.equal(good.asrVia, 'voice_msg_to_text');
    assert.deepEqual(calls, ['fetch_ptt_text', 'voice_msg_to_text'], '先试 NapCat 的，再试 LLOneBot 的');

    const bad = make(() => ({ ok: false, retcode: 100, note: '实现端没这个扩展' }));
    const weak = await bad.resolve({ type: 'record', data: { file: amr, duration: 4 } }, { messageId: 22 });
    assert.equal(weak.text, null);
    assert.match(weak.asrNote, /fetch_ptt_text/);
    assert.match(describeSegments([{ type: 'record', data: { duration: 4 } }], { mediaRefs: new Map([[0, weak]]) }), /我听不了语音/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

t('媒体上限与关开关：超限只记元信息，关掉就只标注不落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-limit-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const tiny = new MediaStore({ storage: store, linkId: 'up:test', log: () => {}, maxBytes: 64 * 1024, keepBytes: false });
  const off = new MediaStore({ storage: store, linkId: 'up:test', log: () => {}, enabled: false });

  return Promise.resolve().then(async () => {
    const big = Buffer.alloc(200 * 1024, 1);
    const ref = await tiny.resolve({ type: 'file', data: { file: `base64://${big.toString('base64')}`, name: 'big.bin' } }, { messageId: 31 });
    assert.match(ref.error, /超过上限/);
    assert.equal(ref.blob, null, 'keepBytes=false 就不落字节');
    assert.equal(ref.bytes, big.length, '但大小与 sha256 还是要记下来');
    assert.equal(tiny.stats.degraded >= 1, true);

    const disabled = await off.resolve({ type: 'image', data: { file: 'x.png' } }, { messageId: 32 });
    assert.match(disabled.error, /media\.enabled=false/);
    assert.equal(off.stats.blobs, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

t('回合配对判定：谁能开回合、谁算下游说话、什么是 hub 自己说话', () => {
  const trigger = { direction: 'upstream-in', kind: 'group_message', ts: 1 };
  assert.equal(isTriggerEntry(trigger), true);
  assert.equal(isTriggerEntry({ direction: 'upstream-in', kind: 'meta_event' }), false);
  assert.equal(isTriggerEntry({ direction: 'downstream-out', kind: 'group_message' }), false);

  assert.equal(isOutcomeEntry({ direction: 'downstream-in', action: 'send_msg' }), true);
  assert.equal(isOutcomeEntry({ direction: 'downstream-in', action: 'send_group_msg' }), true);
  assert.equal(isOutcomeEntry({ direction: 'downstream-in', action: 'get_msg' }), false, '只读不算说话');
  assert.equal(isOutcomeEntry({ direction: 'downstream-out', action: 'send_msg' }), false);

  assert.equal(isHubSpeech({ direction: 'hub-out', action: 'send_msg', refs: { sessionKey: 'group:1' } }), true);
  assert.equal(
    isHubSpeech({ direction: 'hub-out', action: 'send_msg', refs: { fromLink: 'down:1' } }),
    false,
    '中继下游的镜像不是自己说话',
  );
  assert.equal(isHubSpeech({ direction: 'hub-out', action: 'get_msg', refs: {} }), false);
});

t('TurnIndex：谁触发谁、新消息提前封口、挂不上的动作单列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-turns-'));
  const turns = new TurnIndex({ dir, linkId: 'up:test', log: () => {}, windowMs: 1000, retain: 2, now: () => 9500 });
  const trigger = (messageId, ts) => ({
    id: `t${messageId}`,
    ts,
    direction: 'upstream-in',
    kind: 'group_message',
    sessionKey: 'group:55555',
    text: `/cmd ${messageId}`,
    refs: { message_id: messageId, group_id: 55555 },
  });
  const outcome = (ts, linkId = 'down:1') => ({
    id: `o${ts}`,
    ts,
    direction: 'downstream-in',
    linkId,
    action: 'send_msg',
    text: 'pong',
    refs: {},
  });

  turns.record(trigger(1, 1000));
  turns.record(outcome(1200));
  turns.record(outcome(1300, 'down:2'));
  turns.record(trigger(2, 2000)); // 提前封口 1
  turns.record(outcome(2100));
  assert.equal(turns.closed.length, 1);
  assert.equal(turns.closed[0].closeReason, 'superseded');
  assert.equal(turns.closed[0].latencyMs, 200, '延迟取第一条响应的差');
  assert.deepEqual(turns.closed[0].responders, ['down:1', 'down:2'], '响应者按链路去重');

  // 窗口到期：惰性，下次 record / list 才封
  turns.record(trigger(3, 9000));
  assert.equal(turns.open.trigger.refs.message_id, 3);
  turns.record({ direction: 'hub-out', action: 'send_msg', ts: 9100, refs: { sessionKey: 'group:55555' } });
  assert.equal(turns.open.hubSpoke, true);
  assert.equal(turns.open.outcomes.length, 0, 'hub 自己说话不算下游响应');

  const list = turns.list({ limit: 10, withOutcomes: true });
  const t1 = list.turns.find((x) => x.trigger.message_id === 1);
  const t2 = list.turns.find((x) => x.trigger.message_id === 2);
  const t3 = list.turns.find((x) => x.trigger.message_id === 3);
  assert.equal(t1.silent, false);
  assert.equal(t1.outcomeCount, 2);
  assert.equal(t1.outcomes[0].action, 'send_msg');
  assert.equal(t2.closeReason, 'window');
  assert.equal(t3.silent, true);
  assert.equal(t3.latencyMs, null);

  const stats = summarizeTurns(turns.closed.concat(turns.open ? [turns.open] : []));
  assert.equal(stats.responsive, 2);
  assert.equal(stats.silent, 1);
  assert.equal(stats.responders.find((r) => r.linkId === 'down:2').count, 1);
  assert.equal(typeof stats.avgLatencyMs, 'number');

  // 挂不上任何触发的下游动作：单列，不硬塞
  const orphan = new TurnIndex({ linkId: 'up:test', log: () => {}, windowMs: 1000 });
  orphan.record(outcome(5000));
  assert.equal(orphan.unsolicited.length, 1);
  assert.equal(orphan.stats.unsolicited, 1);
  assert.equal(orphan.list({ limit: 5 }).turns.length, 0);

  // 保留上限与落盘：只落封口的
  assert.equal(turns.closed.length <= 2, true);
  const file = turns.snapshot.file;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.every((l) => l.trigger && Array.isArray(l.outcomes)), true);
  assert.equal(lines.some((l) => l.trigger.message_id === 3), false, '还没封口的不落盘');
  assert.equal(briefTurn(turns.open).id.startsWith(safeName('up:test')), true);

  assert.equal(turns.clear() >= 1, true);
  assert.equal(turns.list({ limit: 5 }).turns.length, 0);
  turns.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- M7 用法学习（§17）：机械事实 + 知识库阈值 ----

/** 造一条"被封口的 turn"：只有 trigger/outcomes/latencyMs，够测学习用。 */
const learnTurn = ({ text, segments = null, responded = true, latencyMs = 130, messageId = 1, at = 1000 }) => ({
  id: `t${messageId}`,
  at,
  closedAt: at,
  closeReason: 'window',
  trigger: {
    text,
    refs: { message_id: messageId },
    payload: { message: segments ?? [{ type: 'text', data: { text } }] },
  },
  outcomes: responded ? [{ action: 'send_msg', text: 'pong' }] : [],
  responders: responded ? ['down:30001000'] : [],
  latencyMs: responded ? latencyMs : null,
});

t('用法学习：前缀推断与触发形状（§17.2/§17.3）', () => {
  assert.equal(firstChar('  /roll 10'), '/');
  assert.equal(firstChar(''), '');
  assert.equal(firstToken('今日小猪 两份'), '今日小猪');
  assert.deepEqual(splitCommand('/roll 10'), { prefix: '/', name: 'roll', rest: '10', raw: '/roll 10' });
  assert.deepEqual(splitCommand('今日小猪'), { prefix: '', name: '今日小猪', rest: '', raw: '今日小猪' });
  assert.equal(splitCommand('   '), null);
  assert.equal(splitCommand('/'), null);

  const batch = [
    learnTurn({ text: '/roll 10', messageId: 1 }),
    learnTurn({ text: '/roll 20', messageId: 2 }),
    learnTurn({ text: '今天天气不错', responded: false, messageId: 3 }),
  ];
  // 只有被响应过的才算前缀证据：没人理的闲聊不该教会它"这套下游没有前缀"。
  assert.deepEqual(inferPrefixes(batch), [{ prefix: '/', count: 2 }]);

  const cmd = candidateFromTurn(batch[0], {});
  assert.equal(cmd.kind, 'command');
  assert.equal(cmd.name, 'roll');
  assert.equal(cmd.prefix, '/');
  assert.equal(cmd.args.text, '10');

  const atTurn = learnTurn({
    text: '决斗 @张三 10',
    segments: [
      { type: 'at', data: { qq: '10002' } },
      { type: 'text', data: { text: '决斗 @张三 10' } },
    ],
    messageId: 4,
  });
  const atCand = candidateFromTurn(atTurn, {});
  assert.equal(atCand.kind, 'at');
  assert.equal(atCand.preconditions.needsAt, true);

  const replyTurn = learnTurn({
    text: '再加一张',
    segments: [
      { type: 'reply', data: { id: '9' } },
      { type: 'text', data: { text: '再加一张' } },
    ],
    messageId: 5,
  });
  assert.equal(candidateFromTurn(replyTurn, {}).kind, 'reply');
  assert.equal(candidateFromTurn(replyTurn, {}).preconditions.needsReply, true);

  const kw = candidateFromTurn(learnTurn({ text: '今日小猪', messageId: 6 }), {});
  assert.equal(kw.kind, 'keyword');
  assert.equal(kw.name, '今日小猪');
  assert.equal(capabilityId('down:1', 'command', 'Roll'), 'down:1#command:roll');
});

t('用法学习：够阈值才 active，code 并入保观测用法，未复现先 stale 后删（§17.2④/§17.4）', () => {
  let now = 1000;
  const map = new CapabilityMap({
    linkId: 'down:30001000',
    log: () => {},
    now: () => now,
    threshold: 3,
    staleAfter: 2,
    forgetAfter: 4,
  });

  const first = map.observe(learnTurn({ text: '/roll 10', messageId: 11 }));
  assert.equal(first.status, 'candidate');
  assert.equal(first.confidence, 1);
  now += 10;
  assert.equal(map.observe(learnTurn({ text: '/roll 10', messageId: 12 })).confidence, 2);
  now += 10;
  const third = map.observe(learnTurn({ text: '/roll 10', messageId: 13, latencyMs: 160 }));
  assert.equal(third.status, 'active', '观测到阈值就升 active');
  assert.equal(third.confidence, 3);
  assert.deepEqual(third.evidence.messageIds, ['11', '12', '13']);
  assert.equal(third.outcome.actions[0], 'send_msg');
  assert.equal(third.outcome.typicalLatencyMs > 0, true);

  // 没人响应的闲聊：既不建条目，也不算 miss（它根本不是已知用法）。
  assert.equal(map.observe(learnTurn({ text: '闲聊一句', responded: false, messageId: 14 })), null);
  assert.equal(map.size, 1);

  // L3 注入：active 的排在前面，置信度就是观测次数。
  const forPrompt = map.renderForPrompt();
  assert.equal(forPrompt.length, 1);
  assert.deepEqual(
    { name: forPrompt[0].name, prefix: forPrompt[0].prefix, args: forPrompt[0].args, confidence: forPrompt[0].confidence },
    { name: 'roll', prefix: '/', args: '10', confidence: 3 },
  );

  // §17.4：code 给名字与声明，冲突时观测到的用法优先。
  map.mergeCode([{ name: 'roll', aliases: ['掷骰子'], prefix: '/', notes: '来自 test 插件的 on_command' }]);
  const merged = map.get('roll');
  assert.equal(merged.source, 'both');
  assert.deepEqual(merged.aliases, ['掷骰子']);
  assert.deepEqual(merged.args, { text: '10' }, '静态清单不覆盖观测到的参数形态');
  assert.equal(map.get('掷骰子').id, merged.id);
  assert.equal(merged.evidence.observations, 3);

  // 序列化往返（`capabilities/<linkId>.json` 的 commands 字段）。
  const round = new CapabilityMap({ linkId: 'down:30001000', log: () => {}, now: () => now });
  assert.equal(round.load(map.toJSON()), 1);
  assert.equal(round.get('roll').status, 'active');
  assert.equal(round.prefixHints[0].prefix, '/');

  // 已知用法连续没被响应：先 stale 降置信，够独立阈值才删。
  now += 10;
  assert.equal(map.observe(learnTurn({ text: '/roll 10', responded: false, messageId: 15 })), null);
  assert.equal(map.get('roll').missStreak, 1);
  now += 10;
  assert.equal(map.observe(learnTurn({ text: '/roll 10', messageId: 16 })).confidence, 4, '复现就把未复现计数清零');
  assert.equal(map.get('roll').missStreak, 0);

  now += 10;
  map.observe(learnTurn({ text: '/roll 10', responded: false, messageId: 17 }));
  now += 10;
  map.observe(learnTurn({ text: '/roll 10', responded: false, messageId: 18 }));
  assert.equal(map.get('roll').status, 'stale', '连续未复现 → stale，但还在表里');
  assert.equal(map.records.size, 1);

  now += 10;
  map.observe(learnTurn({ text: '/roll 10', responded: false, messageId: 19 }));
  now += 10;
  map.observe(learnTurn({ text: '/roll 10', responded: false, messageId: 20 }));
  assert.equal(map.get('roll'), null, '够 forgetAfter 才真删（§17.7 的 delete_confidence）');
  assert.equal(map.snapshot.forgotten, 1);
  assert.equal(map.renderForPrompt().length, 0);

  // agent 写回：没有证据也能建条目，来源是 manual（观测过才降级成 both）。
  const manual = map.upsert({ name: '天气', kind: 'keyword', notes: '用户问天气时会自动回', status: 'candidate' });
  assert.equal(manual.source, 'manual');
  assert.equal(map.list({ query: '天气' }).total, 1);
  assert.equal(map.markStale('天气').status, 'stale');
  assert.equal(map.forget('天气').name, '天气');
  assert.equal(map.size, 0);
});

t('L3 注入：前缀来自学到的形状（§6.1）', () => {
  assert.equal(
    renderCapabilities([{ name: 'roll', prefix: '/', args: '10', outcome: 'send_msg ~130ms', confidence: 3 }]),
    '- /roll 10 → send_msg ~130ms（置信度 3）',
  );
  assert.equal(renderCapabilities([{ name: '今日小猪', prefix: '', confidence: 2 }]), '- 今日小猪（置信度 2）');
  assert.equal(renderCapabilities([{ name: 'roll' }]), '- /roll');
  assert.equal(renderArgs({ prefix: '#', name: '抽签', preconditions: { needsAt: true }, args: { text: '3' } }), '#抽签 @某人 3');
  assert.equal(renderParams({ preconditions: { needsReply: true } }), '（需回复它）');
});

t('先预测再动手：dryRun 探针只按现有用法表回答，不发送（M7-③）', () => {
  assert.equal(normalizeName(' Roll '), 'roll');

  // 形状判定：前缀、别名、中文无空白、关键词、正则、前置条件。
  const cmd = { name: 'roll', prefix: '/', kind: 'command', aliases: ['掷骰子'] };
  assert.deepEqual(matchCapability(cmd, { text: '/roll 10' }), {
    score: 1,
    why: '命令名/别名精确命中「roll」',
    args: { text: '10' },
  });
  assert.equal(matchCapability(cmd, { text: 'roll 10' }), null, '带了前缀的用法不吃没前缀的说法');
  assert.equal(matchCapability(cmd, { text: '/掷骰子' }).score, 1, '别名同样命中');
  assert.equal(
    matchCapability({ name: '抽签', kind: 'keyword', aliases: ['来一发'] }, { text: '今天想抽签试试' }).score,
    0.8,
  );
  const re = matchCapability({ name: '^查(.*)$', kind: 'regex' }, { text: '查天气' });
  assert.equal(re.score, 0.7);
  assert.equal(re.args.text, '天气', '正则的捕获组当参数');
  assert.equal(matchCapability({ name: '{坏正则', kind: 'regex' }, { text: 'x' }), null, '坏正则不炸');
  const at = { name: '决斗', kind: 'at', prefix: '' };
  assert.equal(matchCapability(at, { text: '决斗 10' }).score, 0.35, '缺 @ 只算"像"，不算命中');
  assert.equal(matchCapability(at, { text: '决斗 10', hasAt: true }).score, 1);
  assert.equal(matchCapability({ name: '战绩', kind: 'reply', prefix: '' }, { text: '战绩' }).score, 0.35);
  assert.equal(matchCapability({ name: '战绩', kind: 'reply', prefix: '' }, { text: '战绩', hasReply: true }).score, 1);
  assert.equal(matchCapability({ name: 'anything', kind: 'message' }, { text: '随便' }).score, 0.2);
  assert.equal(matchCapability(cmd, { text: '今天天气不错' }), null);

  // 整张表的预测：状态打折、并列排序、结论不发送。
  const map = new CapabilityMap({ linkId: 'down:1', log: () => {} });
  map.upsert({ name: 'roll', prefix: '/', status: 'active', confidence: 3, args: { text: '点数' } });
  map.upsert({ name: '抽签', kind: 'keyword', status: 'candidate', confidence: 1 });
  const hit = map.predict({ text: '/roll 10' });
  assert.equal(hit.wouldTrigger, true);
  assert.equal(hit.exact, true);
  assert.equal(hit.best.name, 'roll');
  assert.equal(hit.best.confidence, 3);
  assert.equal(hit.sent, false);
  assert.match(hit.note, /很可能触发/);
  assert.match(hit.note, /\/roll/);

  const weak = map.predict({ text: '我要抽签' });
  assert.equal(weak.best.name, '抽签');
  assert.equal(weak.best.score, 0.64, 'candidate 打折：0.8 × 0.8');
  assert.equal(weak.wouldTrigger, false, '证据不足时不说"会触发"');
  assert.match(weak.note, /把握不足/);

  map.markStale('roll', '好久没见');
  const stale = map.predict({ text: '/roll 10' });
  assert.equal(stale.best.status, 'stale');
  assert.equal(stale.best.score, 0.4);
  assert.equal(stale.wouldTrigger, false);

  const miss = map.predict({ text: '今天天气不错' });
  assert.equal(miss.wouldTrigger, false);
  assert.deepEqual(miss.matches, []);
  assert.match(miss.note, /看不出会触发/);
  assert.equal(
    renderPrediction({ text: 'x', wouldTrigger: false, matches: [] }),
    '「x」按现有用法表看不出会触发任何下游（表里没有对得上的形状）。',
  );
});

t('会话卡落盘：重启之后还记得刚才在聊什么，且自报"这是重启前那份"（§24.10）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cards-'));
  const storage = new JsonStore({ dir, debounceMs: 50 });
  const cards = new Cards({ storage, maxLines: 3 });
  const msg = (id, uid, nick, text, extra = {}) => ({
    id,
    ts: 1700000000000 + Number(String(id).replace(/\D/g, '') || 0),
    direction: 'upstream-in',
    sessionKey: 'group:617770183',
    actor: { user_id: uid, nickname: nick },
    text,
    payload: { post_type: 'message', message_type: 'group', group_id: 617770183 },
    ...extra,
  });

  cards.note(msg('t1', 10001, '小明', '在吗'));
  cards.note(msg('t2', 10002, '小红', '在的'));
  cards.note(msg('t3', 10001, '小明', '那我去睡了'));
  // 转发镜像不能算成另一条（否则同一条话在卡上出现两遍，真机事故 #3）。
  assert.equal(
    cards.note({
      id: 't9',
      ts: 1700000009999,
      direction: 'downstream-out',
      sessionKey: 'group:617770183',
      text: '在吗',
      refs: { upstreamLinkId: 'up:1' },
      payload: { post_type: 'message', message_type: 'group', group_id: 617770183 },
    }),
    null,
  );
  // 同一个 entry 重复进来自动忽略。
  cards.note(msg('t3', 10001, '小明', '那我去睡了'));
  // 什么都不像的条目不进卡。
  assert.equal(cards.note({ id: 't10', direction: 'upstream-in', sessionKey: 'group:617770183', kind: 'meta_event' }), null);

  const card = cards.get('group:617770183');
  assert.equal(card.messageCount, 3, '转发镜像、重复条目、meta_event 都不计数');
  assert.equal(card.worldKey, 'group:617770183');
  assert.equal(card.participants.length, 2);
  assert.equal(card.participants[0].user_id, 10001, '说话多的排前面');
  assert.equal(card.participants[0].count, 2);
  assert.equal(card.lines.length, 3, 'maxLines 生效');
  assert.equal(storage.stats.pending >= 1, true, '写盘是防抖排队的，不是逐条写');

  const list = cards.list();
  assert.equal(list.total, 1);
  assert.equal(list.cards[0].participants, 2);

  cards.flush();
  // 一份脏文件不该废掉整个目录（与 L1/记忆条目一个规矩）。
  fs.writeFileSync(path.join(dir, 'cards', 'broken.json'), '{不是 JSON', 'utf8');
  const again = new Cards({ storage });
  assert.equal(again.load(), 1);
  assert.equal(again.stats.skipped, 1);
  const resumed = again.digestFor('group:617770183');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.messageCount, 3);
  assert.equal(resumed.participants.length, 2);
  assert.equal(resumed.lines.at(-1).text, '那我去睡了');
  const rendered = renderDigest(resumed);
  assert.match(rendered, /重启前留下的那一份/);
  assert.match(rendered, /从磁盘读回来/);
  assert.match(rendered, /那我去睡了/);
  // 现算的卡不许带 resumed（否则每轮都在说"这是重启前的"）。
  assert.doesNotMatch(renderDigest(buildDigest([msg('t1', 10001, '小明', '在吗')])), /重启前/);

  // 关掉存储时退化成纯内存：不报错，但重启就没了。
  const memoryOnly = new Cards({});
  assert.equal(memoryOnly.enabled, false);
  memoryOnly.note(msg('t1', 10001, '小明', '在吗'));
  assert.equal(memoryOnly.digestFor('group:617770183').messageCount, 1);
  assert.equal(memoryOnly.flush(), 0);
  assert.equal(memoryOnly.stats.dir, null);

  assert.equal(cards.reset(), 1);
  assert.equal(cards.get('group:617770183'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('会话卡：提不出文本的下游动作不留空行，发言人用链路人话名字（m28267）', () => {
  const cards = new Cards({});
  const action = (id, text, extra = {}) => ({
    id,
    ts: 1700000000000,
    direction: 'downstream-in',
    sessionKey: 'group:55555',
    action: 'send_group_forward_msg',
    actor: { source: 'downstream-plugin' },
    refs: { downstreamId: '127.0.0.1:8080', downstreamLabel: '127.0.0.1:8080（探针）' },
    text,
    ...extra,
  });
  // 空文本（旧版提不出的那种）不入行——快照渲染它只会得到一行空话。
  cards.note(action('t-fwd-empty', ''));
  const card = cards.get('group:55555');
  assert.equal(card.lines.length, 0, `空文本不该入行：${JSON.stringify(card.lines)}`);
  // 有文本的正常入行，发言人取 refs.downstreamLabel（与最近窗口同一口径），不亮内部口径。
  cards.note(action('t-fwd', '岀猪车[图片]猪溜达(倒车)'));
  assert.equal(card.lines.length, 1);
  assert.equal(card.lines[0].actor, '127.0.0.1:8080（探针）');
  assert.equal(card.lines[0].text, '岀猪车[图片]猪溜达(倒车)');
  // 连 refs.downstreamLabel 都没有时退到"下游 bot"，不出现 downstream-plugin 字样。
  cards.note({ ...action('t-fwd2', '第二条'), refs: {} });
  assert.equal(card.lines[1].actor, '下游 bot');
});

t('成员名解析：@ 到没名字的人才问、问过就冷却、实现端不支持就停机（§23.6）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-members-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 50 });
  const profiles = new Profiles({ storage, log: () => {} });
  // 已经认识的一个人：档案里有群名片，就不该再问一次。
  profiles.noteGroupCard('10001', 'group:55555', { card: '小明', role: 'member' }, 1700000000000);

  const asked = [];
  const answers = new Map([
    ['10002', { user_id: '10002', nickname: '小刚', card: '刚哥', role: 'member' }],
  ]);
  const resolver = new MemberResolver({
    profile: profiles,
    storage,
    log: () => {},
    callAction: async (action, params) => {
      asked.push({ action, params });
      const data = answers.get(String(params.user_id));
      if (action !== 'get_group_member_info') return { ok: false, retcode: 1404, note: '没有这个接口' };
      if (!data) return { ok: false, retcode: 1400, note: '查无此人' };
      return { ok: true, status: 'ok', retcode: 0, data };
    },
  });

  const groupMsg = (messageId, qqs, extraText = '看这个') => ({
    post_type: 'message',
    message_type: 'group',
    group_id: 55555,
    user_id: 10001,
    message_id: messageId,
    message: [
      ...qqs.map((qq) => ({ type: 'at', data: { qq: String(qq) } })),
      { type: 'text', data: { text: extraText } },
    ],
  });

  // ① 认识的（10001，说话人自己）、@全体、自己账号都不问；不认识的 10002 才问。
  assert.deepEqual(atTargets(groupMsg(1, ['10001', 'all', 30001000, '10002']), { selfId: '30001000' }), ['10001', '10002']);
  assert.equal(cardName({ nickname: '小刚', card: '' }), '小刚', '没群名片就用昵称');
  assert.equal(cardName({}), null);
  assert.equal(cardName(null), null);
  assert.equal(resolver.note(groupMsg(1, ['10001', 'all', 30001000, '10002']), { selfId: '30001000' }), 1);
  assert.deepEqual(resolver.queue.map((i) => i.key), ['55555:10002']);
  // 同一条里的重复 @ 不重复入队。
  assert.equal(resolver.note(groupMsg(2, ['10002'])), 0);
  assert.equal(resolver.note({ post_type: 'message', message_type: 'private', user_id: 10002, message: [] }), 0, '私聊不查群成员');

  const out = await resolver.pump();
  assert.equal(out.asked, 1);
  assert.equal(out.learned, 1);
  assert.deepEqual(asked.map((a) => a.action), ['get_group_member_info'], '只问这一个接口');
  assert.equal(asked[0].params.group_id, '55555');
  assert.equal(asked[0].params.user_id, '10002');
  assert.equal(resolver.stats.learned, 1);
  assert.equal(resolver.stats.pending, 0);
  // 冷却账本落盘（重启之后不重问）。
  assert.equal(Boolean(resolver.file), true);
  assert.equal(storage.stats.pending >= 1, true);

  // ② 冷却期内不再问（同一个群同一个人）。
  assert.equal(resolver.note(groupMsg(3, ['10002'])), 0);
  assert.equal(resolver.stats.skipped >= 1, true);
  // ③ 冷却到期后可以再问一次。
  const later = new MemberResolver({
    profile: profiles,
    log: () => {},
    now: () => Date.now() + 7 * 3600 * 1000,
    callAction: resolver.callAction,
  });
  later.attempts.set('55555:10002', Date.now() - 7 * 3600 * 1000);
  assert.equal(later.note(groupMsg(4, ['10002'])), 1);

  // ④ 一次消息最多问 maxPerMessage 个人（默认 5），超出的丢掉而不是排队。
  const many = new MemberResolver({ profile: profiles, callAction: async () => ({ ok: false, retcode: 1400 }), maxPerMessage: 2 });
  assert.equal(many.note(groupMsg(5, ['20001', '20002', '20003', '20004'])), 2);
  assert.equal(many.stats.pending, 2);

  // ⑤ 实现端说"没有这个接口"就停机：继续问只是每次白等一次超时。
  const unsupported = new MemberResolver({
    profile: profiles,
    callAction: async () => ({ ok: false, retcode: 1404, note: '未知的 action' }),
  });
  unsupported.note(groupMsg(6, ['30001', '30002', '30003']));
  const res = await unsupported.pump();
  assert.equal(res.asked, 1, '只问了第一个人就停机');
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.stats.supported, false);
  assert.equal(unsupported.stats.pending, 0, '剩下的直接丢掉，不留在队列里反复重试');
  assert.equal(unsupported.note(groupMsg(7, ['30009'])), 0, '停机之后不再入队');
  // 注册表里已知"不支持"（source: registry）同样算停机信号。
  assert.equal(isUnsupported({ ok: false, source: 'registry' }), true);
  assert.equal(isUnsupported({ ok: false, retcode: 1400, note: '查无此人' }), false, '"查无此人"是失败，不是不支持');
  assert.equal(isUnsupported({ ok: true }), false);

  // ⑥ 关掉开关就完全不动。
  const off = new MemberResolver({ profile: profiles, enabled: false, callAction: async () => ({ ok: true }) });
  assert.equal(off.note(groupMsg(8, ['40001'])), 0);
  assert.equal((await off.pump()).asked, 0);

  // ⑦ 从落盘账本读回冷却：新实例不会立刻重问同一个人。
  storage.flush();
  const revived = new MemberResolver({ profile: profiles, storage, callAction: async () => ({ ok: true }) });
  assert.equal(revived.attempts.size >= 1, true);
  assert.equal(revived.note(groupMsg(9, ['10002'])), 0);

  assert.equal(resolver.clear() >= 0, true);
  assert.equal(resolver.snapshot().attempts >= 1, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 看图（M14-V，§23.6） ----
t('看图：两种手段、按 sha256 缓存、看不见就降级不猜（M14-V/§23.6）', async () => {
  // 模式归一：认不出的取值不许"默认开着"，也不许把 true 当成乱码
  assert.equal(normalizeVisionMode('BOTH'), 'both');
  assert.equal(normalizeVisionMode(true), 'describe');
  assert.equal(normalizeVisionMode(false), 'off');
  assert.equal(normalizeVisionMode('胡说'), 'describe');
  assert.equal(normalizeVisionMode('胡说', 'off'), 'off');
  assert.equal(normalizeVisionMode('', 'segment'), 'segment');

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vision-'));
  const storage = new JsonStore({ dir, log: () => {}, debounceMs: 20 });

  let streams = 0;
  const streamArgs = [];
  const saved = [];
  const llm = {
    async *stream(input) {
      streams += 1;
      streamArgs.push(input);
      yield { type: 'text-delta', text: '一只橘猫' };
      yield { type: 'text-delta', text: '趴在窗台上。' };
      yield { type: 'finish', reason: 'stop' };
    },
    async resolveModelInfo() {
      return { inputModalities: ['text', 'image'] };
    },
  };
  const attachments = {
    async saveImage(input) {
      saved.push(input);
      return {
        attachmentId: `sha256:${'a'.repeat(64)}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 4,
        height: 4,
        name: input.name,
      };
    },
  };

  const vision = new Vision({ storage, log: () => {}, mode: 'both', provider: 'p', model: 'm' });
  assert.equal(vision.enabled, false, 'llm 没接进来就不算开着');
  vision.attach({ llm, attachments });
  assert.equal(vision.mode, 'both');
  assert.equal(await vision.imageCapable(), true);
  assert.equal(await vision.imageCapable(), true, '探测结论要记住，不反复问宿主');
  assert.equal(saved.length, 0, '没看之前不登记任何东西');

  // describe 手段：向视觉模型要一段中文描述
  const first = await vision.describeImage({ bytes: PNG, mediaType: 'image/png', name: 'cat.png' });
  assert.equal(first.text, '一只橘猫趴在窗台上。');
  assert.equal(first.cached, false);
  assert.equal(first.error, null);
  assert.equal(streams, 1);
  assert.equal(saved.length, 1, '图片先变成 durable ref 才进得了模型消息');
  assert.equal(saved[0].mediaType, 'image/png');

  // 同一张图：命中缓存，不再花第二次钱
  const again = await vision.describeImage({ bytes: PNG, mediaType: 'image/png' });
  assert.equal(again.cached, true);
  assert.equal(again.text, first.text);
  assert.equal(streams, 1, '同一张图只问一次');
  assert.equal(vision.stats.described, 1);
  assert.equal(vision.stats.cached, 1);
  assert.equal(storage.stats.pending >= 1, true, '缓存排队落盘（合并写）');

  // 手里已经有 durable ref 的图片：不再登记一次
  const reused = await vision.describeImage({
    bytes: Buffer.from([1]),
    sha256: 'deadbeef',
    attachment: { attachmentId: 'sha256:zzz', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
  });
  assert.equal(reused.cached, false);
  assert.equal(reused.text, '一只橘猫趴在窗台上。');
  assert.equal(saved.length, 1, 'ref 已经在手就不重复登记');

  // 会话级 `/vmodel`（m01993）：同一次看图按 override 指定模型，**不改** Vision 自己的默认值
  const overridden = await vision.describeImage({
    bytes: Buffer.from([2]),
    sha256: 'override-1',
    attachment: { attachmentId: 'sha256:ovr', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    override: { provider: 'other', model: 'vision-x' },
  });
  assert.equal(overridden.text, '一只橘猫趴在窗台上。');
  assert.equal(streamArgs.at(-1).provider, 'other', '会话级覆盖要传进 llm.stream');
  assert.equal(streamArgs.at(-1).model, 'vision-x');
  assert.equal(vision.model, 'm', '覆盖只作用于这一次调用，不动模块默认值');
  // 没给 override 时仍是模块默认（线上=空，即系统默认模型）
  await vision.describeImage({
    bytes: Buffer.from([3]),
    sha256: 'override-2',
    attachment: { attachmentId: 'sha256:ovr2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
  });
  assert.equal(streamArgs.at(-1).provider, 'p');
  assert.equal(streamArgs.at(-1).model, 'm');

  // segment 手段：图片做成内容段，非图片与重复的都不给
  const parts = vision.segmentParts([
    { kind: 'image', attachmentId: 'sha256:one', mediaType: 'image/png', bytes: 9, width: 2, height: 2 },
    { kind: 'image', attachmentId: 'sha256:one' },
    { kind: 'record', attachmentId: 'sha256:two' },
    { kind: 'image', attachment: { attachmentId: 'sha256:three', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'image');
  assert.equal(parts[0].attachment.attachmentId, 'sha256:one');
  assert.equal(parts[0].attachment.mediaType, 'image/png');
  assert.equal(parts[1].attachment.attachmentId, 'sha256:three', '整份 ref 在手就直接用');

  // 描述优先于上游 summary，并且写进"人话"文本
  const rendered = describeSegments(
    [
      { type: 'image', data: { file: 'x', summary: '旧概要' } },
      { type: 'text', data: { text: ' 好看吗' } },
    ],
    { descriptions: new Map([[0, '一只橘猫趴在窗台上。']]) },
  );
  assert.equal(rendered.includes('[图片：一只橘猫趴在窗台上。]'), true);
  assert.equal(rendered.includes('旧概要'), false, '有真的描述就别拿 summary 凑');
  assert.equal(rendered.endsWith(' 好看吗'), true, '文本原样，空白不归一');

  // 缓存跨重启：进程换了也不重问同一张图
  storage.flush();
  const revived = new Vision({ storage, log: () => {}, mode: 'describe', provider: 'p', model: 'm' });
  revived.attach({
    llm: {
      async *stream() {
        throw new Error('缓存命中就不该再发请求');
      },
    },
    attachments,
  });
  const fromDisk = await revived.describeImage({ bytes: PNG, mediaType: 'image/png' });
  assert.equal(fromDisk.cached, true);
  assert.equal(fromDisk.text, first.text);
  assert.equal(revived.stats.cache >= 1, true);

  // `name` 只留短名（`m26571`）：上游的 `file` 段有时是整份 `base64://…`，原样存进缓存
  // 会把 cache.json 顶成几 MB，而且每次命中都全量重写一遍。
  const INLINE = `base64://${'A'.repeat(4096)}`;
  const named = new Vision({ storage, log: () => {}, mode: 'describe', provider: 'p', model: 'm' });
  named.attach({ llm, attachments });
  await named.describeImage({ bytes: Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9]), mediaType: 'image/jpeg', name: INLINE });
  const rows = named.snapshot();
  assert.equal(rows.some((r) => r.mediaType === 'image/jpeg'), true, '这张图确实进缓存了');
  const fat = rows.filter((r) => String(r.name ?? '').includes('base64://'));
  assert.equal(fat.length, 0, `内联数据不能进 name：${fat.map((r) => r.name.length)}`);

  // 老条目里 name 存着整份 base64（真机：单条 2.37MB）：载入时换成短名并重写文件。
  fs.mkdirSync(path.join(dir, 'vision'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'vision', 'cache.json'),
    JSON.stringify({ version: 1, savedAt: 1, entries: { fat: { text: '一只橘猫。', mediaType: 'image/png', name: INLINE, at: 1 } } }),
    'utf8',
  );
  const cleaned = new Vision({ storage, log: () => {}, mode: 'describe', provider: 'p', model: 'm' });
  assert.equal(cleaned.cacheOf('fat')?.text, '一只橘猫。', '描述本身不动');
  assert.equal(cleaned.cacheOf('fat')?.name ?? null, null, '老条目里的内联数据要清掉');
  storage.flush();
  const cleanedFile = fs.readFileSync(path.join(dir, 'vision', 'cache.json'), 'utf8');
  assert.equal(cleanedFile.includes('base64://'), false, `清洗后不该再有内联数据：${cleanedFile.slice(0, 200)}`);

  // 描述格式第二行「二次元：是/否」是角色识别的门①（`m30282`）：解析要稳，
  // 缺行一律 null（宁可多问一次后端，也不能把照片错当成动漫）。
  const no = parseDescribeReply('图片\n二次元：否\n一只真实的橘猫照片。');
  assert.equal(no.anime, false);
  assert.equal(no.meme, false);
  assert.equal(no.text, '一只真实的橘猫照片。', '二次元行要从正文里拿掉');
  const yes = parseDescribeReply('表情包\n二次元：是（明显画风）\n一只猫猫。');
  assert.equal(yes.anime, true, '全角冒号和括号说明都要容忍');
  assert.equal(yes.meme, true);
  assert.equal(yes.text, '一只猫猫。');
  assert.equal(parseDescribeReply('一只橘猫。').anime, null, '老模型没报这行 → 判定缺失');
  assert.equal(parseDescribeReply('图片\n二次元：大概吧\n一只橘猫。').anime, null, '认不出的值不给假判定');

  // 老缓存条目没有 anime 字段（门①上线前存的）：惰性重判——必须重看一次补上判定，
  // 而且重看后写回的条目要带 anime，下次才不再问。
  fs.writeFileSync(
    path.join(dir, 'vision', 'cache.json'),
    JSON.stringify({ version: 1, savedAt: 1, entries: { old: { text: '一只橘猫。', mediaType: 'image/png', at: 1 } } }),
    'utf8',
  );
  let rejudged = 0;
  const lazy = new Vision({ storage, log: () => {}, mode: 'describe', provider: 'p', model: 'm' });
  lazy.attach({
    llm: {
      async *stream() {
        rejudged += 1;
        yield { type: 'text-delta', text: '图片\n二次元：否\n一只真实的橘猫照片。' };
      },
    },
    attachments,
  });
  const lazySeen = await lazy.describeImage({ bytes: Buffer.from([7, 7, 7]), mediaType: 'image/png' });
  assert.equal(lazySeen.cached, false, '缺 anime 字段的老条目要重看（不能拿旧描述蒙混）');
  assert.equal(lazySeen.anime, false);
  assert.equal(lazySeen.text, '一只真实的橘猫照片。');
  assert.equal(rejudged, 1);
  storage.flush();
  const reread = await lazy.describeImage({ bytes: Buffer.from([7, 7, 7]), mediaType: 'image/png' });
  assert.equal(reread.cached, true, '重判结果要落缓存');
  assert.equal(reread.anime, false);
  assert.equal(rejudged, 1, '带上 anime 之后不再重问');

  // 修1（真机 failed -1935986436）：两个 onebot_reply（会话缓冲版/直发版）共用的
  // hub-media 解析——发之前换成 blob 本地路径，解析不出来当场报错。
  const fakeHub = { media: { find: (id) => (id === 'hub-media:ok' ? { id, blob: 'D:\\blobs\\ok.png' } : null) } };
  const resolved = resolveReplyImages(fakeHub, ['https://x/y.jpg', 'hub-media:ok', { file: 'hub-media:ok', summary: 's' }]);
  assert.deepEqual(resolved, ['https://x/y.jpg', 'D:\\blobs\\ok.png', { file: 'D:\\blobs\\ok.png', summary: 's' }]);
  assert.throws(() => resolveReplyImages(fakeHub, ['hub-media:gone']), /图片引用不可用：hub-media:gone/);
  assert.deepEqual(resolveReplyImages(fakeHub, undefined), [], '不传图片不炸');

  // 关掉 / 没接 llm / 模型看不见：都给一句话，绝不编内容
  const off = new Vision({ mode: 'off' });
  off.attach({ llm, attachments });
  assert.equal((await off.describeImage({ bytes: PNG })).error, 'vision.mode=off');
  assert.equal(off.segmentParts([{ kind: 'image', attachmentId: 'x' }]).length, 0, 'off 时连内容段都不给');

  const noLlm = new Vision({ mode: 'describe' });
  assert.equal((await noLlm.describeImage({ bytes: PNG })).error, 'llm 未接入');

  const textOnly = new Vision({ mode: 'segment' });
  textOnly.attach({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: 'x' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text'] };
      },
    },
    attachments,
  });
  assert.equal(await textOnly.imageCapable(), false, '只收文本的模型不算看得见');

  // 描述失败（模型不说话）也是失败，不留半句编的话
  const mute = new Vision({ mode: 'describe' });
  mute.attach({
    llm: {
      async *stream() {
        yield { type: 'finish', reason: 'stop' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] };
      },
    },
    attachments,
  });
  const muted = await mute.describeImage({ bytes: Buffer.from([9, 9, 9]) });
  assert.equal(muted.text, null);
  assert.match(muted.error, /没有回任何文字/);
  assert.equal(mute.stats.failed, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 下游心跳（§19）----
t('下游心跳：只给实现端型链路发，stop/close 都要停（§19）', async () => {
  const { EventEmitter } = await import('node:events');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = [];
  const ws = new EventEmitter();
  ws.readyState = 1; // WS_OPEN
  ws.send = (raw) => frames.push(JSON.parse(raw));
  ws.close = () => {
    ws.readyState = 3;
  };
  const session = new DownstreamSession({ selfId: '30001000', ws, role: 'Implementation', log: () => {} });

  // 0 = 关（bot-app 型链路就是这么关掉的）
  assert.equal(session.startHeartbeat({ intervalMs: 0 }), false);
  await sleep(40);
  assert.equal(frames.length, 0, 'intervalMs: 0 一个字节都不该发');

  assert.equal(session.startHeartbeat({ intervalMs: 20 }), true);
  await sleep(75);
  const beats = frames.filter((f) => f.meta_event_type === 'heartbeat');
  assert.ok(beats.length >= 2, `应发出至少两次心跳，实际 ${beats.length}`);
  assert.equal(beats[0].post_type, 'meta_event');
  assert.equal(beats[0].self_id, '30001000');
  assert.equal(beats[0].interval, 20);
  assert.equal(beats[0].status.online, true);
  assert.equal(beats[0].status.good, true);
  assert.equal(typeof beats[0].time, 'number');

  session.stopHeartbeat();
  const afterStop = frames.length;
  await sleep(50);
  assert.equal(frames.length, afterStop, 'stopHeartbeat 之后不再发');

  // 连接关掉也要停，不然心跳会往死链路上打
  session.startHeartbeat({ intervalMs: 20 });
  session.close();
  const afterClose = frames.length;
  await sleep(50);
  assert.equal(frames.length, afterClose, 'close 之后不再发');
  assert.equal(session.heartbeatMs, 0);
});

t('原始报文缓存：解析不了的段也留原文 + 索引，按 rawRef / 消息 id 都能取回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-raw-'));
  const recall = new RecallStore({ dir, linkId: 'up:test', log: () => {} });
  const timeline = new Timeline({});
  timeline.onRecord = (entry) => {
    recall.append(entry);
  };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const entry = timeline.record({
    direction: 'upstream-in',
    linkId: 'up:test',
    event: {
      post_type: 'message',
      message_type: 'group',
      group_id: 1,
      user_id: 2,
      message_id: 7,
      self_id: 9,
      message: [
        // hub 不认识的段：**也要留原文**（m03065）
        { type: 'mystery', data: { stuff: 'x' } },
        { type: 'image', data: { file: `base64://${png}` } },
      ],
    },
    decision: 'recorded',
  });
  assert.match(String(entry.id), /^t/, '条目 id 就是 rawRef');
  return Promise.resolve().then(async () => {
    const byRef = await recall.rawOf(entry.id);
    assert.equal(byRef.ok, true);
    assert.equal(byRef.raw.payload.message[0].type, 'mystery', '认不出的段必须在原文里');
    assert.equal(byRef.raw.payload.message[0].data.stuff, 'x');
    assert.match(String(byRef.raw.payload.message[1].data.file), /已落地成媒体引用/, '内联 base64 换成占位（字节在 blob 里）');
    // 同一条也能按 OneBot 消息 id 取回来
    const byMsg = await recall.rawOf('7');
    assert.equal(byMsg.ok, true);
    assert.equal(byMsg.raw.id, entry.id);
    // 索引视图：先看有哪些（能按会话/类型过滤，并报出段类型）
    const idx = await recall.rawIndex({ limit: 5, sessionKey: 'group:1' });
    assert.equal(idx.count, 1);
    assert.equal(idx.entries[0].ref, entry.id);
    assert.deepEqual(idx.entries[0].segmentTypes, ['mystery', 'image']);
    // 找不到时给一条人话，不抛；**长串不透明 id** 要指明它多半是合并转发/媒体的 id
    const missing = await recall.rawOf('t-nope');
    assert.match(String(missing.error), /找不到/);
    const forwardish = await recall.rawOf('LrJn3gtg71dcn7bQfRhNQJQs506LzWGyCo9p9pVumKSATZBLHoofHpv7v71xXpjN');
    assert.match(String(forwardish.error), /合并转发/, `长串 id 应提示去看 onebot_media：${forwardish.error}`);
    // 落盘的 jsonl 里也带着原文（重启后还翻得到）
    const file = path.join(dir, safeName('up:test'), `${new Date(entry.ts).getFullYear()}${String(new Date(entry.ts).getMonth() + 1).padStart(2, '0')}${String(new Date(entry.ts).getDate()).padStart(2, '0')}.jsonl`);
    const line = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
    assert.equal(JSON.parse(line).payload.message[0].type, 'mystery', 'jsonl 里要有原文');
    recall.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

t('聊天记录不展开也不解析：合并转发与多消息卡片只留标记（m03065）', () => {
  const forward = describeSegments([
    {
      type: 'forward',
      data: {
        id: 'f1',
        content: [{ data: { name: '甲', content: [{ type: 'text', data: { text: '秘密内容' } }] } }],
      },
    },
  ]);
  assert.match(forward, /内容未展开/);
  assert.match(forward, /id f1/);
  assert.equal(forward.includes('秘密内容'), false, '不展开 = 连前 5 条摘要都不给');
  assert.equal(forward.includes('甲'), false);

  const card = describeSegments([
    { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail_1: { title: '群聊的聊天记录' } } }) } },
  ]);
  assert.match(card, /聊天记录卡片：内容未展开/);
  assert.equal(card.includes('群聊的聊天记录'), false, '不解析标题');

  // 普通卡片照旧挖标题（这条不是聊天记录）
  const normal = describeSegments([{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { title: '某新闻', desc: '摘要' } } }) } }]);
  assert.match(normal, /卡片：某新闻/);
});

t('保留期清理：超期的日文件、内存行与媒体 blob 一起清（m03091）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retention-'));
  const recall = new RecallStore({ dir, linkId: 'up:test', log: () => {} });
  const old = Date.now() - 40 * 86400000;
  const dayOf = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const oldFile = path.join(dir, safeName('up:test'), `${dayOf(old)}.jsonl`);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, `${JSON.stringify({ id: 'told', ts: old, sessionKey: 'group:1', text: '很久以前' })}\n`, 'utf8');
  recall.append({ id: 'tnew', ts: Date.now(), sessionKey: 'group:1', text: '刚刚' });

  return recall.ensure().then(async () => {
    assert.equal((await recall.rawIndex({ limit: 10 })).entries.length, 2, '清理前两条都在');
    const out = recall.prune({ days: 7 });
    assert.equal(out.removedFiles, 1, '超期的日文件要删掉');
    assert.equal(out.removedRows, 1, '内存与索引里的旧行也要掉');
    assert.equal(fs.existsSync(oldFile), false);
    const after = await recall.rawIndex({ limit: 10 });
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].ref, 'tnew');
    // days: 0 = 不清理
    assert.equal(recall.prune({ days: 0 }).skipped, true);

    // 媒体 blob 同样的保留期：blob 的 mtime 与索引里的 at 都要看
    const store = new JsonStore({ dir, debounceMs: 0 });
    const media = new MediaStore({ storage: store, linkId: 'up:test', log: () => {} });
    return media
      .saveBytes(Buffer.from('hello'), { mediaType: 'text/plain', name: 'a.txt', kind: 'file' })
      .then((ref) => {
        assert.ok(fs.existsSync(ref.blob));
        assert.ok(media.find(ref.id), 'find 能按 hub-media id 取回引用');
        assert.equal(media.find('hub-media:nope'), null);
        fs.utimesSync(ref.blob, new Date(old), new Date(old));
        ref.at = old;
        const pruned = media.prune({ days: 7 });
        assert.equal(pruned.removed, 1);
        assert.equal(pruned.dropped, 1);
        assert.equal(fs.existsSync(ref.blob), false);
        assert.equal(media.find(ref.id), null, '索引里的老引用也要掉');
        recall.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
  });
});

t('发送失败的消息不算聊天记录：检索跳过、原文仍在、裁决可反查（m30859）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-failed-'));
  const recall = new RecallStore({ dir, linkId: 'up:test', log: () => {} });
  const timeline = new Timeline({});
  timeline.onRecord = (entry) => {
    recall.append(entry);
  };
  const failed = timeline.record({
    direction: 'hub-out',
    linkId: 'up:test',
    action: 'send_msg',
    params: { message_type: 'group', group_id: 1, message: [{ type: 'text', data: { text: '这句话没发出去' } }] },
    decision: 'failed',
    text: '这句话没发出去',
    refs: { sessionKey: 'group:1' },
  });
  const sent = timeline.record({
    direction: 'hub-out',
    linkId: 'up:test',
    action: 'send_msg',
    params: { message_type: 'group', group_id: 1, message: [{ type: 'text', data: { text: '这句话发出去了' } }] },
    decision: 'sent',
    text: '这句话发出去了',
    refs: { sessionKey: 'group:1' },
  });
  return Promise.resolve().then(async () => {
    const out = await recall.search({ query: '这句话', sessionKey: 'group:1' });
    assert.equal(out.items.some((i) => i.id === failed.id), false, 'failed 的不能搜出来');
    assert.equal(out.items.some((i) => i.id === sent.id), true, 'sent 的照常');
    assert.equal(out.failedHidden, 1, '要报出跳过几条');
    assert.equal((await recall.rawOf(failed.id)).ok, true, '原文仍可取（排查用）');
    assert.equal(recall.verdictOf(failed.id)?.decision, 'failed');
    assert.equal(recall.verdictOf('t-nope'), null);
    // 窗口渲染同理：failed 的不渲染成"我：…"
    const win = renderWindow(timeline.bySession('group:1', 200), { selfId: 9 });
    assert.ok(!win.includes('这句话没发出去'), `窗口不该出现失败的话：${win}`);
    assert.ok(win.includes('这句话发出去了'));
    recall.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

t('会话卡：发送失败的消息不入卡，存量行可按裁决清掉（m30859）', () => {
  const cards = new Cards({ log: () => {} });
  const failed = {
    id: 'tf1', ts: Date.now(), direction: 'hub-out', decision: 'failed', sessionKey: 'group:1',
    action: 'send_msg', text: '没发出去', actor: { source: 'downstream-plugin' },
  };
  const sent = {
    id: 'ts1', ts: Date.now(), direction: 'hub-out', decision: 'sent', sessionKey: 'group:1',
    action: 'send_msg', text: '发出去了', actor: { source: 'downstream-plugin' },
  };
  assert.equal(cards.note(failed), null, 'failed 不入卡');
  const card = cards.note(sent);
  assert.ok(card, 'sent 照常入卡');
  assert.equal(card.lines.some((l) => l.id === 'tf1'), false);
  assert.equal(card.lines.some((l) => l.id === 'ts1'), true);
  // 存量（老代码写进卡并落了盘的）也能清：pruneLinesWhere 按 fn 挑行删
  card.lines.push({ id: 'tf2', ts: Date.now(), direction: 'hub-out', actor: '我', text: '以前留下的失败话' });
  const countBefore = card.messageCount;
  const removed = cards.pruneLinesWhere((line) => line.id === 'tf2');
  assert.equal(removed, 1);
  assert.equal(cards.get('group:1').lines.some((l) => l.id === 'tf2'), false);
  assert.equal(cards.get('group:1').messageCount, countBefore - 1, 'messageCount 同步下修');
  assert.equal(cards.pruneLinesWhere(() => false), 0, '不匹配就一张嘴都不动');
});

t('会话白名单：sessionOverrideOf / mergePolicyMode（m31030）', () => {
  const cfg = { agentGroups: { 617770183: { mode: 'observer' }, 55555: {} }, agentPrivates: { 10001: {} } };
  assert.deepEqual(sessionOverrideOf('group:617770183', cfg), { mode: 'observer' });
  assert.deepEqual(sessionOverrideOf('group:55555', cfg), {}, '命中但没写覆盖 = 只准入');
  assert.deepEqual(sessionOverrideOf('private:10001', cfg), {});
  assert.equal(sessionOverrideOf('group:99999', cfg), null, '功能启用中，没列出的群 = 拒');
  assert.equal(sessionOverrideOf('private:99999', cfg), null);
  assert.equal(sessionOverrideOf('unknown', cfg), null, '认不出的会话键不喂');
  // 两张名单都没写 = 功能没启用（老配置 / 测试桩）→ 放行；只写一张 → 另一类全拒。
  assert.deepEqual(sessionOverrideOf('group:55555', {}), {});
  assert.deepEqual(sessionOverrideOf('private:10001', null), {});
  assert.equal(sessionOverrideOf('private:10001', { agentGroups: { 55555: {} } }), null);
  // 命中非对象（手写的 true/字符串）也按"只准入"处理。
  assert.deepEqual(sessionOverrideOf('group:7', { agentGroups: { 7: true } }), {});
  // mode 覆盖：空/同值/非法都不复制对象；合法且不同只改 mode、其余照抄。
  const base = resolveAgentPolicy({ mode: 'assist' });
  assert.equal(mergePolicyMode(base, {}), base);
  assert.equal(mergePolicyMode(base, { mode: 'assist' }), base);
  assert.equal(mergePolicyMode(base, { mode: 'nope' }), base, '非法 mode 回全局');
  assert.equal(mergePolicyMode(base, null), base);
  const merged = mergePolicyMode(base, { mode: 'active' });
  assert.equal(merged.mode, 'active');
  assert.equal(merged.batchSize, base.batchSize, '其余字段照抄全局');
});

t('会话白名单：Mind 的闸在 observe/noteDownstreamSend 上生效（m31030）', () => {
  const cfg = { agentGroups: { 55555: { mode: 'observer' }, 88888: {} }, agentPrivates: { 10001: {} } };
  const mind = new Mind({ hub: { config: cfg }, log: () => {} });
  // 未列出的群：连判定都不进，直接 unlisted。
  const blocked = mind.observe({ sessionKey: 'group:99999', kind: 'message', text: '@hub 在吗', payload: { post_type: 'message', message_type: 'group', group_id: 99999, message: [] } });
  assert.equal(blocked.wake, false);
  assert.equal(blocked.reason, 'unlisted');
  assert.equal(mind.stats.unlisted, 1);
  assert.equal(mind.statsSnapshot.batches.length, 0, '不入批量窗口');
  assert.equal(mind.statsSnapshot.whitelist.groups, 2, '白名单规模进状态');
  assert.equal(mind.statsSnapshot.whitelist.privates, 1);
  assert.equal(mind.lastObserve?.reason, 'unlisted', '诊断闭环：为什么不醒写明 unlisted');
  assert.equal(mind.noteDownstreamSend({ sessionKey: 'group:99999', text: '下游在没列出的群里说话' }), null);
  // 列出的群：走到正常判定（observer 档 → mode:observer，不再报 unlisted）。
  const listed = mind.observe({
    sessionKey: 'group:55555', kind: 'message', text: '@hub 在吗',
    payload: { post_type: 'message', message_type: 'group', group_id: 55555, message: [{ type: 'text', data: { text: '@hub 在吗' } }] },
  }, { isSelf: false });
  assert.equal(listed.reason, 'mode:observer', '白名单条目覆盖的 mode 生效');
  // 列出的私聊：不被闸挡（后续唤醒链路不在本例范围）。
  const priv = mind.observe({
    sessionKey: 'private:10001', kind: 'message', text: '早',
    payload: { post_type: 'message', message_type: 'private', user_id: 10001, message: [{ type: 'text', data: { text: '早' } }] },
  }, { isSelf: false });
  assert.notEqual(priv.reason, 'unlisted');
  // 无白名单配置（老测试桩形状）= 功能未启用 = 不拦。
  const open = new Mind({ hub: { config: {} }, log: () => {} });
  const pass = open.observe({ sessionKey: 'group:42', kind: 'message', text: 'x', payload: { post_type: 'message', message_type: 'group', group_id: 42, message: [] } });
  assert.notEqual(pass.reason, 'unlisted');
});

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
