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
import { Hub } from '../lib/hub.js';
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
import { renderPerson, renderMemoryBlocks, renderSelf, renderWindow, renderPeopleRoster, renderSessionDirectory, assembleContext } from '../lib/memory/assembler.js';
import { composeReply, buildSendParams } from '../lib/reply.js';
import { letterFor, transcode, labelOfScope, CrossRelay, letterForSay, describeParcel, scopeOfAgentId, callerOf, callerScopeOf } from '../lib/cross/relay.js';
import { ChannelStore } from '../lib/cross/channels.js';
import { PackageStore } from '../lib/cross/packages.js';
import { buildDigest, renderDigest } from '../lib/memory/digest.js';
import { full, mdhm } from '../lib/stamp.js';
import { Cards } from '../lib/memory/cards.js';
import { flatBreaks } from '../lib/text.js';
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
import { applyMemoryOps, memoryBlocks } from '../lib/memory/writer.js';
import { ActiveStore, buildShareContext, filterActive, renderActive, isActiveVisible } from '../lib/memory/active.js';
import { tokenize, RecallStore } from '../lib/memory/recall.js';
import { decayStrength, isWeak, weakMessageIds } from '../lib/memory/decay.js';
import { collectCues, cueKey, Reminders } from '../lib/memory/cues.js';
import { renderCues, renderCapabilities } from '../lib/memory/assembler.js';
import { describeEvent, describeNotice, describeSegments } from '../lib/segments.js';
import { resolvePartsMedia, resolveReplyImages } from '../lib/reply.js';
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
import { Mind, mediaTag } from '../lib/mind.js';
import { mergePolicyMode, resolveAgentPolicy, sessionOverrideOf } from '../lib/agent/policy.js';
import { canRead, describeReadScope, parseTrustedPrivates } from '../lib/read-scope.js';

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
  // 显示名口径（`m15264`）：昵称 + QQ 号，群名片只作同群附注。
  assert.match(win, /^01-09 08:12 小明\(10001\)：你还在吗$/m, `窗口行没带日期：\n${win}`);
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

    // 档案指针也要过重启（`m20216`）：`#hydrate` 是白名单式读回，漏一个字段指针就没了，
    // 模型重启后只知道"发生过这件事"，查不到细节在哪份档案里。
    s3.add({
      text: '换显卡定了 850W',
      scope: 'group:55555',
      term: 'long',
      archive: [{ target: 'topic', id: '显卡选购' }, { target: 'person', id: '10001' }],
    });
    storage.flush();
    const s3b = new MemoryStore({ storage, log: () => {} });
    const withPtr = s3b.all().find((e) => e.text === '换显卡定了 850W');
    assert.deepEqual(withPtr.archive, [{ target: 'topic', id: '显卡选购' }, { target: 'person', id: '10001' }]);

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
  const a = s.add({ text, kind: 'identity', scope: 'group:123456789', actor: { user_id: '945126014' } });
  const b = s.add({ text: `  ${text}  `, kind: 'identity', scope: 'group:123456789', actor: { user_id: '945126014' }, refs: { message_id: '99' } });
  assert.equal(s.all().length, 1, '同一条不该堆成两行');
  assert.equal(b.id, a.id, '返回的是已有那条（id 不变，模型才 modify 得到）');
  assert.equal(a.refs.message_id, '99', '折叠时补上原来缺的线索');
  assert.equal(s.stats.deduped, 1);

  // 换群 / 换说话人 = 另外的条（可见性边界与归属都不同）。
  s.add({ text, kind: 'identity', scope: 'group:55555', actor: { user_id: '945126014' } });
  assert.equal(s.all().length, 2);
  s.add({ text, kind: 'identity', scope: 'group:123456789', actor: { user_id: '10001' } });
  assert.equal(s.all().length, 3);
  // 空文本不参与合并（否则一堆空条目会挤成一条，且没有信息量）。
  s.add({ text: '' });
  s.add({ text: '   ' });
  assert.equal(s.all().length, 5);
  // 刻意造重复仍要能造（导入/测试/`dedupe:false`）。
  s.add({ text: '刻意两条', scope: 'group:123456789' }, { dedupe: false });
  s.add({ text: '刻意两条', scope: 'group:123456789' }, { dedupe: false });
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
    { long_term: { add: [{ text: '一句话' }] } },
    wbase,
  );
  assert.equal(w.all().length, 1, '同一句话不该在库里存两份');
  assert.equal(r5.blocks.long_term.add, 1);
  // 短期条目（旧版本写进来的）被同文本重写进 long_term ＝ **提升**（`m08521` 用户定案）：就地翻成长期，
  // 而不是像以前那样"已有同一条"顶回去（那样模型以为提升了，库里其实什么都没变）。
  // `short_term.add` 已退役，所以这里用 store 直接造一条历史短期条目。
  const w2 = new MemoryStore({});
  w2.add({ text: '一句话', scope: 'group:55555', term: 'short' }, { sessionKey: 'group:55555', worldKey: 'group:55555' });
  assert.equal(w2.all()[0].term, 'short');
  const promote = applyMemoryOps({ long_term: { add: [{ text: '一句话' }] } }, { ...wbase, store: w2 });
  assert.equal(promote.blocks.long_term.promoted, 1, '同文本重写进长期要就地提升');
  const promoted = w2.all()[0];
  assert.equal(promoted.term, 'long');
  assert.equal(promoted.visibility, 'shareable', '公开群里提升后就能跨会话说');
  const afterPromote = memoryBlocks(w2.all(), { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: resolveIsolation({ level: 'scoped' }) });
  assert.equal(afterPromote.shortTerm.length, 0, '提升后要离开短期块');
  assert.equal(afterPromote.longTerm.length, 1, '提升后就该在长期块里');

  // 私聊里学到的升不动（硬边界）：写 long_term 只换回一条说明，条目还是短期、还是 private。
  const wp = new MemoryStore({});
  wp.add({ text: '他说他明天要去医院', scope: 'private:10001', term: 'short' }, { sessionKey: 'private:10001', worldKey: 'private:10001' });
  const pbase = { ...wbase, store: wp, sessionKey: 'private:10001', worldKey: 'private:10001' };
  const refused = applyMemoryOps({ long_term: { add: [{ text: '他说他明天要去医院' }] } }, pbase);
  assert.equal(refused.blocks.long_term.promoted, 0);
  assert.ok(refused.rejected.some((x) => /没能提升为长期/.test(x.reason)), JSON.stringify(refused.rejected));
  assert.equal(wp.all()[0].term, 'short');
  assert.equal(wp.all()[0].visibility, 'private');

  // 敏感标记（`m20991` 用户要求）：这条敏不敏感，模型也应该能说。它只会**收窄**（锁进本会话），
  // 所以交给模型判断是安全的；反过来「声明 false 解锁」必须被拒——词表命中的内容不能被一句话放出去。
  const ws = new MemoryStore({});
  const sbase = { ...wbase, store: ws };
  const mark = applyMemoryOps(
    { long_term: { add: [{ text: '他欠了外面一笔钱', sensitive: true, related_users: ['10001'] }] } },
    sbase,
  );
  assert.equal(mark.blocks.long_term.add, 1);
  const marked = ws.all()[0];
  assert.equal(marked.sensitive, true, '模型带的 sensitive:true 要落库');
  // 标了敏感就锁在本会话：别的群一律不可见，跟档位无关。
  const asOther = memoryBlocks(ws.all(), { sessionKey: 'group:99999', worldKey: 'group:99999', isolation: resolveIsolation({ level: 'open' }) });
  assert.equal(asOther.longTerm.length, 0, '标了敏感就锁在本会话，open 档也不跨群');
  // 反向声明不生效，且要明确说为什么不生效。
  const unlock = applyMemoryOps({ long_term: { add: [{ text: '他欠了外面一笔钱', sensitive: false }] } }, sbase);
  assert.ok(unlock.rejected.some((x) => /只能标成 true/.test(x.reason)), JSON.stringify(unlock.rejected));
  assert.equal(ws.all()[0].sensitive, true, 'false 不得把 sensitive 抹掉');
  // 事后补标：`long_term.sensitive:[序号]`，按当轮渲染的序号定位。
  const ws2 = new MemoryStore({});
  ws2.add({ text: '他家里最近不太顺', scope: 'group:55555', term: 'long' }, { sessionKey: 'group:55555', worldKey: 'group:55555' });
  const late = applyMemoryOps({ long_term: { sensitive: [0] } }, { ...wbase, store: ws2 });
  assert.equal(late.blocks.long_term.sensitive, 1, '事后要能按序号补标');
  assert.equal(ws2.all()[0].sensitive, true);
  const badIdx = applyMemoryOps({ long_term: { sensitive: [9] } }, { ...wbase, store: ws2 });
  assert.equal(badIdx.blocks.long_term.sensitive, 0);
  assert.ok(badIdx.rejected.some((x) => /序号越界/.test(x.reason)), JSON.stringify(badIdx.rejected));

  // 渲染形状（`m08663` 用户指出）：短期与长期**必须各成一块**——长期标题前空一行，
  // 否则它紧贴在短期最后一条下面，看着像同一段里的下一行；每块的序号也都从 0 起。
  assert.equal(
    renderMemoryBlocks({ shortTerm: [{ text: '本会话的一条' }], longTerm: [{ text: '别处学来的一条' }] }),
    [
      '【短期记忆（本会话；序号可用于 modify/delete）】',
      '0. 本会话的一条',
      '',
      '【长期记忆（跨会话；序号可用于 modify/delete）】',
      '0. 别处学来的一条',
    ].join('\n'),
    '两块之间要空一行，且各自的序号从 0 起',
  );
  assert.equal(
    renderMemoryBlocks({ shortTerm: [{ text: '只有短期' }] }),
    '【短期记忆（本会话；序号可用于 modify/delete）】\n0. 只有短期',
    '只有一块时不留多余空行',
  );
  assert.ok(renderMemoryBlocks({ longTerm: [{ text: '只有长期' }] }).startsWith('【长期记忆'), '只有长期时开头就是长期标题');
  assert.equal(renderMemoryBlocks({}), '', '没有记忆时渲染为空串，不留孤零零的标题');
  // 档案指针（`m20216`）：长期记忆是索引，细节在档案里——没有指针，模型只知道发生过，
  // 不知道去哪儿看细节。指针只跟**真的落成**的目标走（写入侧只 push 成功的）。
  assert.equal(
    renderMemoryBlocks({ longTerm: [{ text: '换显卡定了 850W', archive: [{ target: 'topic', id: '显卡选购' }] }] }),
    '【长期记忆（跨会话；序号可用于 modify/delete）】\n0. 换显卡定了 850W〔详见 话题：显卡选购〕',
    '长期索引行要带档案指针，否则模型找不到细节',
  );
  assert.equal(
    renderMemoryBlocks({ longTerm: [{ text: '两处都落了', archive: [{ target: 'topic', id: 'T1' }, { target: 'person', id: '10001' }] }] }),
    '【长期记忆（跨会话；序号可用于 modify/delete）】\n0. 两处都落了〔详见 话题：T1、人物：10001〕',
    '一次结算落两处时，两条指针都要写出来',
  );
  assert.equal(renderMemoryBlocks({ longTerm: [{ text: '没有档案' }] }).includes('〔'), false, '没有档案就不加方括号');
  // 出处／日期／相关人（`m20892`）：以前一行只有正文——模型分不清"这是哪个群的事、什么时候的事、
  // 跟谁有关"。出处用与活跃层同一套记号，日期取**天粒度**（取时分会让快照每回合重注一次）。
  assert.equal(
    renderMemoryBlocks(
      { longTerm: [{ text: '定了磨豆机', scope: 'group:55555', ts: new Date(2026, 9, 22, 15, 30).getTime() }] },
      { sessionKey: 'group:55555', worldKey: 'group:55555' },
    ),
    '【长期记忆（跨会话；序号可用于 modify/delete）】\n0. [群 55555] 定了磨豆机（2026-10-22）',
    '行首要带出处、行尾要带日期（天粒度，不带时分）',
  );
  {
    const people = [{ userId: '10001', names: [{ name: '小张', scope: 'group:55555', at: 1 }] }];
    const line = renderMemoryBlocks(
      {
        longTerm: [
          {
            text: '定了磨豆机',
            scope: 'group:55555',
            ts: new Date(2026, 9, 22).getTime(),
            relatedUsers: ['10001', '10002'],
          },
        ],
      },
      { people, sessionKey: 'group:55555', worldKey: 'group:55555' },
    );
    assert.match(line, /（2026-10-22；相关：小张、10002）/, '相关群友要显示名字，解析不到退回 QQ 号');
    // 私聊来源：能解析出名字就写名字，解析不出退回号——否则出现"[与 10001 的私聊]"这种读不出人的行。
    const dm = renderMemoryBlocks(
      { longTerm: [{ text: '他说要换键盘', scope: 'private:10001', ts: new Date(2026, 9, 22).getTime() }] },
      { people, sessionKey: 'private:10001', worldKey: 'private:10001' },
    );
    assert.match(dm, /0\. \[与 小张 的私聊\] 他说要换键盘/, '私聊出处解析得出名字就用名字');
    const dm2 = renderMemoryBlocks(
      { longTerm: [{ text: '他说要换键盘', scope: 'private:99999', ts: new Date(2026, 9, 22).getTime() }] },
      { sessionKey: 'private:99999' },
    );
    assert.match(dm2, /0\. \[与 99999 的私聊\] 他说要换键盘/, '解析不出就退回 QQ 号，别丢出处');
  }

  // 自述档案（`m20216`）：`self.json` 以前只写不读——`profiles.self()` 有、`upsertSelf` 写，
  // 可装配层没 self 段、也没工具暴露它。这里只渲染稳定的一小撮，别的群的昵称不许串进来。
  const self = {
    myNames: { 'group:55555': '小助', 'group:77777': '阿助' },
    myStatements: [{ what: '一' }, { what: '二' }, { what: '三' }, { what: '四' }],
    mistakes: [{ what: '把 A 当成了 B' }],
    preferences: [{ text: '少用感叹号' }],
  };
  const selfText = renderSelf(self, { sessionKey: 'group:55555', worldKey: 'group:55555' });
  assert.match(selfText, /【关于我自己】/);
  assert.match(selfText, /我在这里叫：小助/, '只渲染本会话那个昵称');
  assert.equal(selfText.includes('阿助'), false, '别的群的昵称不该串进来');
  assert.match(selfText, /我的偏好：少用感叹号/);
  assert.match(selfText, /我说过的话（别自相矛盾）：\n- 二\n- 三\n- 四/, '说过的话只留最后 3 条');
  assert.equal(selfText.includes('- 一'), false, '更早的说过的话不占上下文');
  assert.match(selfText, /我犯过的错（别再犯）：\n- 把 A 当成了 B/);
  assert.equal(renderSelf(null), '', '没有档案就整段不渲染');
  assert.equal(renderSelf({}), '', '空档案也整段不渲染');

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
  const active = new ActiveStore({ storage: null });
  const base = { store, profiles, active, sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', isolation: resolveIsolation({ level: 'scoped' }), now: 1_700_000_000_000 };

  // 短期记忆的职能搬到了活跃层（`m17909`）：进行中的话题 / 正在做的事。
  const r1 = applyMemoryOps(
    { active: { add: [{ kind: 'topic', text: '第一件事' }, { kind: 'task', text: '第二件事' }] } },
    base,
  );
  assert.equal(r1.blocks ? r1.applied.active.add : 0, 2);
  assert.equal(active.all().length, 2);
  assert.ok(active.all().every((e) => e.originScope === 'group:55555'));

  // `short_term.add` 退役：明说"用 active"，而不是静默忽略。
  const r1b = applyMemoryOps({ short_term: { add: [{ text: '旧的短期' }] } }, base);
  assert.equal(r1b.blocks.short_term.add, 0);
  assert.ok(r1b.rejected.some((x) => /活跃层/.test(x.reason)), JSON.stringify(r1b.rejected));

  // 模型给 visibility：记一条 rejection，但条目仍按代码推断落盘（不能静默采纳，也不能静默丢弃）。
  const r2 = applyMemoryOps({ long_term: { add: [{ text: '私事', visibility: 'shareable' }] } }, base);
  assert.equal(r2.applied.long_term.add, 1);
  assert.ok(r2.rejected.some((x) => x.path.endsWith('visibility')), JSON.stringify(r2.rejected));
  assert.equal(store.all().find((e) => e.text === '私事').visibility, 'shareable', '没点名的长期事实按 shareable 落');

  // 活跃层的 update 序号指向**改之前**那份列表；同批 add 不会让序号错位。
  const snapshot = { entries: filterActive(active.all(), { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: resolveIsolation({ level: 'scoped' }), now: base.now }).visible };
  assert.equal(snapshot.entries.length, 2, '本会话自己写的两条都该看得见');
  const r3 = applyMemoryOps(
    { active: { update: [{ index: 0, text: '第一件事（已更正）' }], add: [{ kind: 'topic', text: '新加的' }] } },
    { ...base, activeBlocks: snapshot },
  );
  assert.equal(r3.applied.active.update, 1);
  assert.ok(active.all().some((e) => e.text === '第一件事（已更正）'));
  assert.ok(!active.all().some((e) => e.text === '第一件事'));

  const r4 = applyMemoryOps({ active: { update: [{ index: 99, text: 'x' }], 未知操作: [] }, 未知顶层: {} }, { ...base, activeBlocks: snapshot });
  assert.ok(r4.rejected.some((x) => /序号越界/.test(x.reason)));
  assert.ok(r4.rejected.some((x) => /未知操作/.test(x.reason)));
  assert.ok(r4.rejected.some((x) => /未知字段/.test(x.reason)));
  assert.equal(applyMemoryOps('不是对象', base).ok, false);
});

t('活跃层：跨群共享要同时过白名单与"共同活跃群友"两关，私聊来源另按 privateFacts', () => {
  const now = 1_800_000_000_000;
  const a = new ActiveStore({ storage: null });
  a.add({ kind: 'topic', text: '讨论换显卡', originScope: 'group:55555', participants: ['10002'] }, now);
  a.add({ kind: 'task', text: '替小张列清单', originScope: 'group:55555' }, now);
  a.add({ kind: 'topic', text: '帮我改配置', originScope: 'private:10001' }, now);
  // 10002 在两个群都露过面 ⇒ 群 55555 与 77777 有"共同活跃群友"；99999 一个人都不认识。
  const persons = [{ userId: '10002', groups: { 'group:55555': { lastSentAt: now - 3600e3 }, 'group:77777': { lastSentAt: now - 7200e3 } } }];
  const whitelist = new Set(['group:55555', 'group:77777', 'private:10001']);
  const share = buildShareContext({ persons, whitelist, windowDays: 30, now });
  const iso = resolveIsolation({ level: 'balanced', privateFacts: 'never' });
  const view = (target) => filterActive(a.all(), {
    sessionKey: target, worldKey: target, actorId: '10001', isolation: iso, share, whitelist, activeWindowDays: 30, now,
  });
  assert.equal(view('group:55555').visible.length, 2, '自己的群两条都看得见');
  assert.equal(view('group:77777').visible.length, 2, 'balanced + 有共同活跃群友 ⇒ 跨群可共享');
  assert.equal(view('group:99999').visible.length, 0, '不在白名单里的群一条都拿不到');
  assert.ok(view('group:99999').denied.every((d) => /not-in-whitelist/.test(d.reason)));
  assert.equal(view('private:10001').visible.length, 1, '私聊来源默认 privateFacts=never ⇒ 只在本私聊');

  // 同一条在 scoped 档就不许跨群（想共享必须动全局 level，这是 `m17922` 选的 A 方案代价）。
  const scoped = filterActive(a.all(), {
    sessionKey: 'group:77777', worldKey: 'group:77777', actorId: '10001',
    isolation: resolveIsolation({ level: 'scoped' }), share, whitelist, activeWindowDays: 30, now,
  });
  assert.equal(scoped.visible.length, 0);
  assert.ok(scoped.denied.filter((d) => /level:scoped/.test(d.reason)).length === 2, JSON.stringify(scoped.denied));
  // 没有 share 上下文（判据取不到）必须 fail-closed，不能"猜着放"。
  const blind = filterActive(a.all(), {
    sessionKey: 'group:77777', worldKey: 'group:77777', actorId: '10001', isolation: iso, whitelist, activeWindowDays: 30, now,
  });
  assert.equal(blind.visible.length, 0);

  // 渲染：序号跨两段连续（模型要靠它写 update/settle），出处永远在行首。
  const shown = view('group:77777').visible;
  const text = renderActive(shown, { limit: 8, settle: false, now });
  assert.match(text, /^【进行中的话题】$/m);
  assert.match(text, /^0\. \[群 55555\] 讨论换显卡$/m);
  assert.match(text, /^1\. \[群 55555\] 替小张列清单$/m);
  assert.ok(text.indexOf('【我正在做的事】') > text.indexOf('【进行中的话题】'), '话题在前、任务在后');
  // 开着超过一天才有【待结算】提醒（只报事实，不下命令）。
  const later = renderActive(shown, { limit: 8, settle: true, now: now + 25 * 3600e3 });
  assert.match(later, /【待结算】/);
  assert.ok(!renderActive(shown, { limit: 8, settle: true, now }).includes('【待结算】'), '刚写的不该催结算');
  // 被条数上限挤出视野的条目要说一句（`m21098` 自审）：序号只覆盖看得见的那几条，
  // 不说明的话模型会以为活跃层就这些，而挤掉的既看不见也结算不掉。
  assert.ok(!renderActive(shown, { limit: 8, now }).includes('没显示出来'), '全都在视野里时不该多那句话');
  assert.match(renderActive(shown, { limit: 1, now, hidden: 1 }), /（还有 1 条没显示出来；/);
  // 过了活跃窗口就不注入（0 = 不过滤）。
  assert.equal(filterActive(a.all(), { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: iso, now: now + 31 * 86400e3 }).visible.length, 0);
  assert.equal(filterActive(a.all(), { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: iso, activeWindowDays: 0, now: now + 31 * 86400e3 }).visible.length, 2);
});

t('活跃层：序号不漂移、过期条目说得出原因、没露过面的人不算活跃', () => {
  const now = 1_800_000_000_000;
  const a = new ActiveStore({ storage: null });
  a.add({ kind: 'topic', text: '讨论换显卡', originScope: 'group:55555' }, now);
  a.add({ kind: 'task', text: '替小张列清单', originScope: 'group:55555' }, now);
  const iso = resolveIsolation({ level: 'balanced' });
  const view = (at) => filterActive(a.all(), { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: iso, activeWindowDays: 30, now: at });

  // 改正文不换位：模型是照着屏幕上的号写 update/settle 的，号一漂就改错条目。
  a.update(a.all()[0].id, { text: '讨论换显卡（已改）' }, now + 1000);
  assert.deepEqual(view(now).visible.map((e) => e.text), ['讨论换显卡（已改）', '替小张列清单']);

  // 同一类里新增往后排，不把前面的号顶掉。
  a.add({ kind: 'task', text: '再列一份', originScope: 'group:55555' }, now + 2000);
  assert.deepEqual(view(now).visible.map((e) => e.text), ['讨论换显卡（已改）', '替小张列清单', '再列一份']);

  // 过期条目要**说得出原因**（window:expired），不能静默消失——查起来才知道它去哪了。
  const expired = view(now + 31 * 86400e3);
  assert.equal(expired.visible.length, 0);
  assert.equal(expired.denied.filter((d) => d.reason === 'window:expired').length, 3, JSON.stringify(expired.denied));

  // 从没露过面的人不算活跃（窗口关掉时也不能把"没说过话"当活跃）。
  const quiet = buildShareContext({
    persons: [{ userId: '10002', groups: { 'group:55555': {}, 'group:77777': {} } }],
    windowDays: 0,
    now,
  });
  assert.equal(quiet.commonActive('group:55555', 'group:77777'), false, '没有 lastSentAt 就不算露过面');
  const alive = buildShareContext({
    persons: [{ userId: '10002', groups: { 'group:55555': { lastSentAt: now - 1000 }, 'group:77777': { lastSentAt: now - 2000 } } }],
    windowDays: 0,
    now,
  });
  assert.equal(alive.commonActive('group:55555', 'group:77777'), true);

  // 写入层的硬边界：非法的 kind 拒掉**而且不落盘**；空正文不认；不替别的会话写。
  const base = {
    store: new MemoryStore({}),
    profiles: new Profiles({ storage: null }),
    active: a,
    sessionKey: 'group:55555',
    worldKey: 'group:55555',
    actorId: '10001',
    isolation: iso,
    now,
  };
  const before = a.all().length;
  const rk = applyMemoryOps({ active: { add: [{ kind: 'note', text: '不合法的类目' }] } }, base);
  assert.equal(rk.applied.active.add, 0);
  assert.equal(a.all().length, before, '非法的 kind 不能落盘');
  assert.ok(rk.rejected.some((x) => /只认/.test(x.reason)), JSON.stringify(rk.rejected));

  const ru = applyMemoryOps({ active: { update: [{ index: 0, text: '' }] } }, { ...base, activeBlocks: { entries: view(now).visible } });
  assert.equal(ru.applied.active.update, 0);
  assert.ok(ru.rejected.some((x) => /text 为空/.test(x.reason)), JSON.stringify(ru.rejected));

  const rx = applyMemoryOps(
    { active: { add: [{ kind: 'topic', text: '替别的群开的' }] } },
    { ...base, sessionKey: 'group:66666', currentSessionKey: 'group:55555' },
  );
  assert.equal(rx.applied.active.add, 0);
  assert.ok(rx.rejected.some((x) => /不能替别的会话写/.test(x.reason)), JSON.stringify(rx.rejected));
  assert.ok(!a.all().some((e) => e.text === '替别的群开的'));

  // 参与者只认 QQ 号（`m21098` 自审）：写名字会被丢掉，而"没参与者"意味着结算出的索引行
  // 是不点名的 `shareable`，会被念到别的群去——这是 fail-open，必须当面说出来。
  const rp = applyMemoryOps(
    { active: { add: [{ kind: 'task', text: '替小张整理清单', participants: ['小张', '10001'] }] } },
    base,
  );
  assert.equal(rp.applied.active.add, 1, '名字被忽略，但这条照写');
  assert.ok(rp.rejected.some((x) => /participants 只认 QQ 号/.test(x.reason) && /小张/.test(x.reason)), JSON.stringify(rp.rejected));
  const added = a.all().find((e) => e.text === '替小张整理清单');
  assert.deepEqual(added.participants, ['10001'], '只留纯数字的');

  // 同一批里同一个序号只能结算一次：`visible` 是快照，不挡就会重复写索引行、重复计数。
  const dupSnap = { entries: view(now).visible };
  const dupSettle = applyMemoryOps(
    {
      active: {
        settle: [
          { index: 0, outcome: 'keep', summary: '第一次结算写的索引' },
          { index: 0, outcome: 'keep', summary: '第二次又写一行' },
        ],
      },
    },
    { ...base, activeBlocks: dupSnap },
  );
  assert.equal(dupSettle.applied.active.settle.keep, 1, '只该结算成功一次');
  assert.ok(dupSettle.rejected.some((x) => /已经结算过了/.test(x.reason)), JSON.stringify(dupSettle.rejected));
  assert.equal(base.store.all().filter((e) => e.text === '第二次又写一行').length, 0, '重复那条不能落库');

  // 摸一下不续命：`update` 只改参与者（正文没变）时不刷新 `updatedAt`。
  const touchView = view(now).visible;
  const touchIdx = touchView.findIndex((e) => e.text === '再列一份');
  assert.ok(touchIdx >= 0, '要有一条还没被结算掉的条目');
  const touchTarget = touchView[touchIdx];
  const touchedAt = touchTarget.updatedAt;
  // ① 原样重写一遍：什么都没变，就不该续命（否则模型每轮"顺手摸一下"就能让 30 天窗口永不过期）。
  const noop = applyMemoryOps(
    { active: { update: [{ index: touchIdx, text: '再列一份' }] } },
    { ...base, now: now + 5000, activeBlocks: { entries: touchView } },
  );
  assert.equal(noop.applied.active.update, 1);
  assert.equal(a.byId(touchTarget.id).updatedAt, touchedAt, '正文没变就不该刷新 updatedAt');
  // ② 真的改了点东西（参与者变了）：这才算"又被提起"，刷新 updatedAt。
  applyMemoryOps(
    { active: { update: [{ index: touchIdx, text: '再列一份', participants: ['10003'] }] } },
    { ...base, now: now + 9000, activeBlocks: { entries: touchView } },
  );
  assert.equal(a.byId(touchTarget.id).updatedAt, now + 9000, '内容真变了才刷新');
  assert.deepEqual(a.byId(touchTarget.id).participants, ['10003'], '参与者变了还是要落');
  // 活跃条目也能自己标敏感（跟长期记忆一个口径）：标了就永远不出本会话，哪怕白名单里的另一个群也拿不到。
  applyMemoryOps({ active: { add: [{ kind: 'topic', text: '小张私下跟我说的事', sensitive: true }] } }, base);
  const secret = a.all().find((e) => e.text === '小张私下跟我说的事');
  assert.equal(secret.sensitive, true, '敏感标记要落盘');
  assert.ok(!isActiveVisible(secret, { sessionKey: 'group:99999', worldKey: 'group:99999', isolation: iso }).ok, '标了敏感就不出本会话');
  assert.ok(isActiveVisible(secret, { sessionKey: 'group:55555', worldKey: 'group:55555', isolation: iso }).ok, '本会话自己还是看得见的');
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
  // `interests` 以前只写不读（`m20216`）：能写、能落盘、`onebot_person` 读得到，
  // 但装配层从来没渲染过——模型写了等于只写进了文件。
  profiles.upsertPerson('10001', { interests: [{ text: '显卡' }, { text: '机械键盘' }, { text: '显卡' }] }, at + 10);
  const cardWithInterests = renderPerson(profiles.person('10001'), { sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', isolation: resolveIsolation({ level: 'balanced' }) });
  assert.match(cardWithInterests, /爱聊：显卡、机械键盘/, '兴趣要进人物卡，且同一条不重复');

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
  // `m15264`：昵称才是跨群唯一的身份，名片是**每个群各一份**的观测，不再并进 `names[]`
  // （否则"这个人是谁"会在 A 群/B 群之间来回飘）。名片留在同群档案里按需附注。
  assert.equal(p.names.length, 2, '群名片不算一个名字（它是同群附注，不是身份）');
  assert.equal(nameIn(p, 'group:55555'), '小明', '同一个群里用昵称，名片不顶替');
  assert.equal(p.groups['group:55555'].card, '小明同学', '名片仍在群档案里没丢');
  assert.equal(nameIn(p, 'group:77777'), '明哥', '名字跟着群走');
  assert.equal(p.groups['group:55555'].role, 'admin');

  // 模型改不了系统字段：`upsertPerson` 只认白名单（names/groups 不在其中）。
  profiles.upsertPerson('10001', { names: [{ name: '假名字' }], groups: {}, impression: '话不多' }, at + 4000);
  assert.equal(profiles.person('10001').names.length, 2);
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

t('本群认识的人：一行一人、只列本群、排除当前对话者与 bot 自己、不展开 facts（m09409）', () => {
  const at = 1_700_000_000_000;
  const profiles = new Profiles({ storage: null, now: () => at });
  // 本群的三个人：当前对话者、一个有内容的老友、一个空壳（只被拉过成员表）
  profiles.noteGroupCard('10001', 'group:55555', { card: '群主小明', role: 'owner' }, at);
  profiles.noteGroupCard('10002', 'group:55555', { card: '老张', lastSentAt: at - 1000 }, at);
  profiles.noteGroupCard('10003', 'group:55555', {}, at);
  profiles.upsertPerson('10002', { facts: [{ text: '做后端，爱问细节' }, { text: '喝奶茶只喝三分糖' }], impression: '话不多但靠谱' }, at);
  profiles.upsertPerson('10002', { commitments: [{ what: '帮他看一个 bug', status: 'open' }] }, at);
  // 别的群认识的人：不该出现在这个群的名单里
  profiles.noteGroupCard('20002', 'group:77777', { card: '张工' }, at);
  // bot 自己也有档案（拉成员表建档），同样不该列出来
  profiles.noteGroupCard('30001', 'group:55555', {}, at);

  const people = profiles.persons();
  const text = renderPeopleRoster(people, {
    sessionKey: 'group:55555',
    worldKey: 'group:55555',
    actorId: '10001',
    selfId: '30001',
    limit: 20,
  });
  assert.match(text, /【本群认识的人】/);
  assert.match(text, /onebot_person/, '得告诉模型细节去哪儿查');
  assert.match(text, /- 老张\(10002\)｜印象：话不多但靠谱｜知道 2 件事｜有 1 件没兑现的承诺/, '名片与名字相同时不重复写（真机上一半人名片＝昵称）');
  assert.match(text, /^- 10003$/m, '没内容的人也列，只是信息少——这是"我认识他"的事实（只有 QQ 号时不重复包一层括号）');
  assert.ok(!text.includes('10001'), '当前对话对象有自己的完整卡片，不重复列');
  assert.ok(!text.includes('30001'), 'bot 自己不是"认识的人"');
  assert.ok(!text.includes('张工') && !text.includes('20002'), '别的群的人不进这个群的名单');
  assert.ok(!text.includes('三分糖'), '别人的 facts 正文不展开（只给条数）');
  assert.ok(!/\d+ (分钟|小时|天)前/.test(text), '不渲染相对时间：快照按逐字节判重，时间一变整份重注');

  // 条数上限来自配置，不写死：超出的按"还有 N 人"交代，而不是悄悄少列
  const capped = renderPeopleRoster(people, { sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', selfId: '30001', limit: 1 });
  assert.equal((capped.match(/^- /gm) ?? []).length, 1);
  assert.match(capped, /还有 1 人没列出来/);
  assert.equal(renderPeopleRoster(people, { sessionKey: 'group:55555', worldKey: 'group:55555', limit: 0 }), '', '0 = 整段不注入');
  assert.equal(renderPeopleRoster([], { limit: 5 }), '');
  // 私聊视角：档案里没有 `groups['private:…']` 这条记录，于是整段为空——群里的人不会顺着私聊跑出来。
  assert.equal(renderPeopleRoster(people, { sessionKey: 'private:10001', worldKey: 'private:10001', actorId: '10001', limit: 20 }), '');
  // 段本身由装配层决定放不放（私聊不注入这一段），渲染器只管"这个 scope 里我认识谁"。
  const priv = assembleContext({
    guidance: '',
    sessionKey: 'private:10001',
    worldKey: 'private:10001',
    actorId: '10001',
    isolation: resolveIsolation({ level: 'balanced' }),
    memoryEntries: [],
    people,
    peopleLimit: 20,
  });
  assert.ok(!priv.text.includes('【本群认识的人】'), '私聊不注入【本群认识的人】');
  const grp = assembleContext({
    guidance: '',
    sessionKey: 'group:55555',
    worldKey: 'group:55555',
    actorId: '10001',
    isolation: resolveIsolation({ level: 'balanced' }),
    memoryEntries: [],
    people,
    peopleLimit: 20,
  });
  // 注意：`assembleContext` 返回的 `sections` 刻意剥掉了 `text`（只有名字/序号/字数），正文看 `text`。
  const peopleSection = grp.sections.find((s) => s.name === 'people');
  assert.ok(peopleSection && peopleSection.chars > 0, '群会话里这一段在（有内容）');
  assert.ok(grp.text.includes('老张'), '群会话里这一段在（正文里有本群的人）');
  assert.ok(grp.text.indexOf('【人物卡】') < grp.text.indexOf('【本群认识的人】'), '先人物卡、再名单（order 33 → 34）');
});

t('本群认识的人：同一天里谁又冒泡，名单文本必须逐字不变；跨天才重排（m09699）', () => {
  // 用**本地正午**当基准：无论机器在哪个时区，+10 分钟仍在同一天，+20 小时一定跨天。
  const base = new Date(2024, 4, 15, 12, 0, 0, 0).getTime();
  const roster = (at) => {
    const p = new Profiles({ storage: null, now: () => at });
    p.noteGroupCard('10001', 'group:55555', { card: '群主小明', role: 'owner' }, at);
    p.noteGroupCard('10002', 'group:55555', { card: '老张', lastSentAt: at }, at);
    p.noteGroupCard('10003', 'group:55555', { card: '小王' }, at);
    return renderPeopleRoster(p.persons(), {
      sessionKey: 'group:55555', worldKey: 'group:55555', actorId: '10001', selfId: '30001', limit: 20,
    });
  };
  // hub 每条群消息都会刷新发言人的 lastSentAt（lib/hub.js noteGroupCard）——按时间戳排的话
  // 每来一条消息顺序就变，快照（逐字节判重）就整份重注一次。排序键必须是天粒度。
  assert.equal(roster(base + 10 * 60_000), roster(base), '同一天内谁又说了话，名单文本不许变');
  // 跨天确实会重排：最近露面的排前面。
  const p3 = new Profiles({ storage: null, now: () => base });
  p3.noteGroupCard('10002', 'group:55555', { card: '老张', lastSentAt: base + 20 * 3600_000 }, base);
  p3.noteGroupCard('10003', 'group:55555', { card: '小王', lastSentAt: base }, base);
  p3.noteGroupCard('10004', 'group:55555', { card: '小李', lastSentAt: base - 20 * 3600_000 }, base);
  const days = renderPeopleRoster(p3.persons(), { worldKey: 'group:55555', sessionKey: 'group:55555', limit: 20 });
  // 显示名是 `昵称(QQ)`（半角括号，`m15264`），取到 `(` 之前就是名字本身。
  const order = [...days.matchAll(/^- ([^(（｜]+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['老张', '小王', '小李'], '跨天时按最近露面的先后排');
});

t('主动回忆的渲染是陈述句，不是命令', () => {
  const now = 1_700_000_000_000;
  const text = renderCues(
    [{ key: 'k', name: '小明', what: '帮他看一个 bug', due: now - 3 * 86400_000, overdueDays: 3, lastSeenAt: now - 2 * 3600_000 }],
    { now },
  );
  assert.match(text, /【还没兑现的事】/);
  assert.match(text, /你答应过「小明」：帮他看一个 bug（当时说大约 .*，已经过了 3 天；他上次露面是 \d{4}-\d{2}-\d{2}）/);
  assert.ok(!/\d+ (分钟|小时|天)前/.test(text), '时间写绝对日期：相对时间每回合都在变，快照逐字节判重会整份重注（m09699）');
  assert.ok(!/(该提醒|必须|现在就去|别忘了|催)/.test(text), '代码不下命令：提不提由模型判断');
  assert.equal(renderCues([], { now }), '');
  // 同一份承诺隔一小时再渲染一次，文本必须逐字相同（否则每回合重注一次整份上下文）。
  const later = renderCues(
    [{ key: 'k', name: '小明', what: '帮他看一个 bug', due: now - 3 * 86400_000, overdueDays: 3, lastSeenAt: now - 2 * 3600_000 }],
    { now: now + 3600_000 },
  );
  assert.equal(later, text, '一小时后重渲染，文本必须逐字不变（快照重注的判据就是逐字节相等）');
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

  // 识图没回来时的占位（`m24484`）：光写 `[图片]` 时模型只会答"我看不到图"，
  // 标上"还在看"它才知道该等（回合开始前会等一次，或者自己调 onebot_image_wait）。
  const imgEvent = { post_type: 'message', message: [{ type: 'image', data: { file: 'a.png' } }] };
  assert.match(describeEvent(imgEvent, { describing: true }), /\[图片（还在看）\]/);
  assert.match(describeEvent(imgEvent), /\[图片\]/, '不带这个标记时还是老形状');
  // 描述回来后照旧是内容，不会留着"还在看"。
  const described = new Map([[0, { text: '一只金毛趴在键盘上' }]]);
  assert.match(describeEvent(imgEvent, { describing: true, descriptions: described }), /\[图片：一只金毛趴在键盘上\]/);
  // 表情包那条分支也要标（否则表情包永远显示"可能是表情包"却不说在看）。
  const memeEvent = { post_type: 'message', message: [{ type: 'image', data: { file: 'b.png', sub_type: '1' } }] };
  assert.match(describeEvent(memeEvent, { describing: true }), /还在看/);
});

t('图消息在批里带短标识（`m24656`）：同一分钟两张图不再长得一模一样', () => {
  const mk = (mid, media, extra = {}) => ({ ts: 1_700_000_000_000, text: '[图片]', refs: { message_id: mid, media }, ...extra });
  // 真机那两条：16:04/16:06 的图消息批行都是 `- 10-24 16:06 某人(945126014)：[图片]`，
  // 逐字相同，模型于是把新图判成"上一条的重复送达"，那张图一个字都没回。
  assert.equal(mediaTag(mk('-1589196849', ['m112'])), ' #196849');
  assert.equal(mediaTag(mk('856180595', ['m112'])), ' #180595');
  assert.notEqual(mediaTag(mk('-1589196849', ['m112'])), mediaTag(mk('856180595', ['m112'])), '两条必须能区分');
  // 没图的消息不加：文字消息靠内容本身就能区分，每行挂 id 只是噪声。
  assert.equal(mediaTag(mk('856180595', [])), '');
  assert.equal(mediaTag(mk('856180595', undefined)), '');
  assert.equal(mediaTag({ ts: 1, text: '纯文字', refs: { message_id: '9' } }), '');
  // 批条目带 `live`（真身）时照样读得到（批行正文优先取 live，标识也一样）。
  assert.equal(mediaTag({ ts: 1, text: '[图片]', live: { refs: { message_id: '-1589196849', media: ['m112'] } } }), ' #196849');
});

t('补描去重（`m24656`）：工具已经把描述交给模型，就别再排一句【图片补描】', () => {
  const hub = new Hub({}, { log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), log: () => {} });
  // 队列空时是安全的空操作（工具每次读完都会调一遍）。
  assert.equal(mind.markDescribed('group:1', ['856180595']), 0);
  assert.equal(mind.markDescribed('group:1', []), 0);
  assert.equal(mind.markDescribed('group:1', null), 0);
  hub.stop?.();
});

t('会话目录（`m32112`）：列群、按最近有人说话排序、私聊只报数量', () => {
  const rec = (worldKey, name, memberCount, at, culture) => ({
    worldKey,
    name,
    memberCount,
    culture,
    activeMembers: [{ userId: '1', lastSentAt: at }],
  });
  const groups = [
    rec('group:111', '闲聊群', 328, 1000, '聊显卡装机，晚上人多'),
    rec('group:222', '测试群', 12, 5000, null),
  ];
  const hub = {
    config: {
      cross: { enabled: true, directory: 'names', rosterLimit: 30 },
      agent: { groups: ['111', '222'], privates: ['945126014', '10001'] },
    },
    profiles: { groups: () => groups, group: (k) => groups.find((g) => g.worldKey === k) ?? null },
  };
  const mind = new Mind({ hub, log: () => {} });

  // 三种"不出现"：cross 关着、目录关着、条数 0。
  assert.equal(new Mind({ hub: { config: {} }, log: () => {} }).sessionDirectory('group:111'), null);
  assert.equal(
    new Mind({ hub: { config: { cross: { enabled: true, directory: 'off' } } }, log: () => {} }).sessionDirectory('group:111'),
    null,
  );
  assert.equal(
    new Mind({ hub: { config: { cross: { enabled: true, directory: 'names', rosterLimit: 0 } } }, log: () => {} }).sessionDirectory('group:111'),
    null,
  );

  // 群里看到：按最近有人说话倒序，当前群标「这里」，别的私聊只报数量。
  const inGroup = mind.sessionDirectory('group:222');
  assert.equal(inGroup.rows[0].text, '群 222（测试群）· 12 人');
  assert.equal(inGroup.rows[0].mine, true);
  assert.equal(inGroup.rows[1].text, '群 111（闲聊群）· 328 人');
  assert.equal(inGroup.rows[1].mine, false);
  assert.equal(inGroup.rows.some((r) => /私聊/.test(r.text)), false, '群里不许出现私聊 id');
  assert.ok(inGroup.tail.includes('私聊 2 个，不列编号'));

  // 私聊里看到：全部私聊都列编号，自己那条标「这里」（`m32426` 放开了这条）。
  const inPrivate = mind.sessionDirectory('private:945126014');
  const privateRows = inPrivate.rows.filter((r) => /^私聊/.test(r.text));
  assert.equal(privateRows.length, 2, '私聊视角要列出全部私聊编号');
  assert.equal(privateRows.find((r) => r.text === '私聊 945126014').mine, true);
  assert.equal(inPrivate.tail.some((x) => x.startsWith('私聊')), false);
  // 群里永远只报数量，`m28349`「群里看不到私聊」这条红线不破。
  assert.equal(inGroup.rows.some((r) => /私聊/.test(r.text)), false);

  // names 不带印象；full 才带，且只取群档案的 culture。
  assert.equal(inGroup.rows[1].note, null);
  const full = new Mind({
    hub: { ...hub, config: { ...hub.config, cross: { enabled: true, directory: 'full' } } },
    log: () => {},
  });
  const withNote = full.sessionDirectory('group:111');
  assert.match(withNote.rows.find((r) => r.text.startsWith('群 111')).note, /^印象：聊显卡装机/);
  assert.equal(withNote.rows.find((r) => r.text.startsWith('群 222')).note, null);
});

t('会话目录渲染：标题、当前会话标记与「还有 N 个没列」', () => {
  assert.equal(renderSessionDirectory(null), '');
  assert.equal(renderSessionDirectory({ rows: [] }), '');
  const text = renderSessionDirectory({
    title: '2 个群',
    rows: [
      { text: '群 833194406（测试群）· 12 人', mine: true },
      { text: '群 451403506（示例群）· 328 人', note: '印象：聊显卡装机' },
    ],
    tail: ['私聊 1 个，不列编号', '还有 3 个没列'],
  });
  assert.equal(
    text,
    [
      '【会话目录】这个插件接的群和私聊（2 个群）',
      '- 群 833194406（测试群）· 12 人 · 这里',
      '- 群 451403506（示例群）· 328 人 · 印象：聊显卡装机',
      '私聊 1 个，不列编号',
      '还有 3 个没列',
    ].join('\n'),
  );
});

t('识图等完了也要能回读（`m24656`）：没有 pending 时取最近几张图，否则"已经看完了"等于没有', () => {
  const hub = new Hub({}, { log: () => {} });
  // 没有图：返回空，工具照实说"最近也没有带图的消息"。
  assert.deepEqual(hub.recentMediaIds('group:1'), []);
  const record = (mid, media) => {
    const entry = hub.timeline.record({
      direction: 'upstream-in',
      linkId: 'up:test',
      event: {
        post_type: 'message',
        message_type: 'group',
        group_id: 1,
        user_id: 2,
        message_id: mid,
        self_id: 9,
        message: [{ type: 'text', data: { text: '[图片]' } }],
      },
      decision: 'recorded',
    });
    if (media) entry.refs = { ...(entry.refs ?? {}), media };
    return entry;
  };
  record(401, ['m1']);
  record(402, null); // 纯文字：不该被回读
  record(403, ['m2']);
  record(404, ['m3']);
  record(405, ['m4']);
  assert.deepEqual(hub.recentMediaIds('group:1'), ['403', '404', '405'], '默认最近三条带图的');
  assert.deepEqual(hub.recentMediaIds('group:1', { limit: 2 }), ['404', '405']);
  assert.deepEqual(hub.recentMediaIds('group:2'), [], '别的会话不许串');
  hub.stop?.();
});

t('等识图（`m24484`）：只等这一批、有上限、失败也放行', async () => {
  const hub = new Hub({}, { log: () => {} });
  // ① 没有在跑的图：一毫秒都不等（绝大多数回合走这条）。
  const none = await hub.awaitVisionPending({ key: 'group:1', messageIds: ['m1'], timeoutMs: 50 });
  assert.deepEqual(none, { count: 0, settled: 0, timedOut: 0, waitedMs: 0 });

  // ② 等到了：这是主路径——描述回来会就地改写 `entry.text`，所以回合只要等它就行。
  let release = null;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  hub.trackVision('group:1', 'm1', slow);
  assert.deepEqual(hub.pendingVisionIds('group:1'), ['m1']);
  const waiting = hub.awaitVisionPending({ key: 'group:1', messageIds: ['m1'], timeoutMs: 2000 });
  release('看过来了');
  const got = await waiting;
  assert.deepEqual({ c: got.count, s: got.settled, t: got.timedOut }, { c: 1, s: 1, t: 0 });
  assert.deepEqual(hub.pendingVisionIds('group:1'), [], '结束后必须从表里消失，否则下一轮会等一个死 promise');

  // ③ 超时：到点就放行，不能把回合拖死（剩下的交给下一轮【图片补描】）。
  hub.trackVision('group:1', 'm2', new Promise(() => {}));
  const to = await hub.awaitVisionPending({ key: 'group:1', messageIds: ['m2'], timeoutMs: 60 });
  assert.equal(to.count, 1);
  assert.equal(to.timedOut, 1);
  assert.ok(to.waitedMs >= 50, `应当真的等了，实际 ${to.waitedMs}ms`);

  // ④ 只等这一批：名单里没有的图（别的消息、别的会话）不参与。
  hub.trackVision('group:1', 'm3', new Promise(() => {}));
  hub.trackVision('group:2', 'm1', new Promise(() => {}));
  const only = await hub.awaitVisionPending({ key: 'group:1', messageIds: ['m9'], timeoutMs: 30 });
  assert.equal(only.count, 0, '别的消息的图不该被顺手等上');

  // ⑤ 失败也算结束：识图报错不能让回合再干等 2 秒。
  hub.trackVision('group:1', 'm4', Promise.reject(new Error('识图失败')));
  const failed = await hub.awaitVisionPending({ key: 'group:1', messageIds: ['m4'], timeoutMs: 2000 });
  assert.equal(failed.settled, 1);
  assert.equal(failed.timedOut, 0);

  // ⑥ 采样：状态里要看得出"等了几轮、超时几次"，否则"等了但没用"没人发现。
  const st = hub.visionWaitStats;
  assert.ok(st.turns >= 3, `turns=${st.turns}`);
  assert.ok(st.timedOut >= 1);
  hub.stop?.();
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

t('媒体上限：超大图放行落盘且不标 error（识图要看字节），非图片照旧拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-image-limit-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const tiny = new MediaStore({ storage: store, linkId: 'up:test', log: () => {}, maxBytes: 64 * 1024 });

  return Promise.resolve().then(async () => {
    const bigPng = Buffer.alloc(200 * 1024, 0x61);
    bigPng[0] = 0x89; bigPng[1] = 0x50; bigPng[2] = 0x4e; bigPng[3] = 0x47; // PNG magic → kind=image
    const ref = await tiny.resolve({ type: 'image', data: { file: `base64://${bigPng.toString('base64')}` } }, { messageId: 33 });
    assert.equal(ref.error, null, '超大图不标 error——识图环节见 error 会放弃');
    assert.ok(ref.blob, '超大图要落盘（识图链要字节）');
    assert.equal(ref.bytes, bigPng.length, '大小照记');
    assert.equal(tiny.stats.blobs, 1);
    assert.equal(ref.attachment ?? null, null, '超大图不登记宿主附件（主请求别被巨图撑爆）');

    // 非图片照旧：超限只记元信息。
    const bigBin = Buffer.alloc(200 * 1024, 1);
    const ref2 = await tiny.resolve({ type: 'file', data: { file: `base64://${bigBin.toString('base64')}`, name: 'big.bin' } }, { messageId: 34 });
    assert.match(ref2.error, /超过上限/);
    assert.equal(ref2.blob ?? null, null);
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

t('L3 注入：前缀来自学到的形状 + 能力段自带标题（§6.1）', () => {
  /**
   * 能力段以前光秃秃几行 `- /roll …`，夹在表情包清单后面看不出是什么（`m08997`）。
   * 分组标题就是干这个的：观测到几条、置信度是什么意思，都写在标题里。
   */
  const head = (n) => `【下游会吃的命令（观测 ${n} 条，置信度＝真被触发过的次数）】：`;
  assert.equal(
    renderCapabilities([{ name: 'roll', prefix: '/', args: '10', outcome: 'send_msg ~130ms', confidence: 3 }]),
    `${head(1)}\n- /roll 10 → send_msg ~130ms（置信度 3）`,
  );
  assert.equal(
    renderCapabilities([{ name: '今日小猪', prefix: '', confidence: 2 }, { name: 'roll' }]),
    `${head(2)}\n- 今日小猪（置信度 2）\n- /roll`,
  );
  assert.equal(renderCapabilities([]), '', '没有观测就不占段');
  assert.equal(renderArgs({ prefix: '#', name: '抽签', preconditions: { needsAt: true }, args: { text: '3' } }), '#抽签 @某人 3');
  assert.equal(renderParams({ preconditions: { needsReply: true } }), '（需回复它）');
});

t('注入文本的换行留痕：一条消息一行，断行渲染成 ⏎（m08997）', () => {
  /**
   * 真机现场（用户 11:29 那轮）：开头那条"完整清单（可见 28 个）：\n【消息与会话】…"
   * 入库存的是真换行，但快照/窗口/恢复卡各自 `replace(/\s+/g,' ')` 把它吃成了空格，
   * 五个【分组】挤成一条 200 多字单行——只有【新消息】那一路是 `⏎`。
   */
  assert.equal(flatBreaks('清单：\n【甲】a\n【乙】b'), '清单： ⏎ 【甲】a ⏎ 【乙】b');
  assert.equal(flatBreaks('一行\n二行'), '一行 ⏎ 二行');
  assert.equal(flatBreaks('  挤   在 一起  '), '挤 在 一起', '行内空白照旧压一格');
  assert.equal(flatBreaks('a\r\nb'), 'a ⏎ b', 'CRLF 一样');
  assert.equal(flatBreaks(undefined), '');
  // 真换行会裂成多行、伪造 `- ` 列表项与段标题 → 那是注入面，只能留痕不能还原。
  assert.equal(flatBreaks('a\n- 假列表').includes('\n'), false);

  const events = [
    { direction: 'downstream-in', ts: 1700000000000, text: '完整清单：\n【消息与会话】a\n【本体】b', actor: '945126014', refs: { downstreamLabel: 'test' } },
  ];
  const win = renderWindow(events, { selfId: 20002000 });
  assert.equal(win.split('\n').length, 1, `一条消息只能占一行：\n${win}`);
  assert.ok(win.includes('【消息与会话】a ⏎ 【本体】b'), `断行要留痕：\n${win}`);
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
    sessionKey: 'group:123456789',
    actor: { user_id: uid, nickname: nick },
    text,
    payload: { post_type: 'message', message_type: 'group', group_id: 123456789 },
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
      sessionKey: 'group:123456789',
      text: '在吗',
      refs: { upstreamLinkId: 'up:1' },
      payload: { post_type: 'message', message_type: 'group', group_id: 123456789 },
    }),
    null,
  );
  // 同一个 entry 重复进来自动忽略。
  cards.note(msg('t3', 10001, '小明', '那我去睡了'));
  // 什么都不像的条目不进卡。
  assert.equal(cards.note({ id: 't10', direction: 'upstream-in', sessionKey: 'group:123456789', kind: 'meta_event' }), null);

  const card = cards.get('group:123456789');
  assert.equal(card.messageCount, 3, '转发镜像、重复条目、meta_event 都不计数');
  assert.equal(card.worldKey, 'group:123456789');
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
  const resumed = again.digestFor('group:123456789');
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
  assert.equal(memoryOnly.digestFor('group:123456789').messageCount, 1);
  assert.equal(memoryOnly.flush(), 0);
  assert.equal(memoryOnly.stats.dir, null);

  assert.equal(cards.reset(), 1);
  assert.equal(cards.get('group:123456789'), null);
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

  // 修2（`m25247` 真机事故 retcode 1200「未知文件类型或路径不存在: hub-media:…」）：
  // 同一条引用写在 `parts:[{type:'image',source:'hub-media:…'}]` 里时也必须落成 blob 路径——
  // 工具描述把它列为合法写法，而只有 `images` 那条路会解析。
  const partsIn = [
    { type: 'text', content: '喏' },
    { type: 'image', source: 'hub-media:ok' },
    { type: 'image', file: 'hub-media:ok' },
    { type: 'image', source: 'https://x/y.jpg' },
    { type: 'image', id: 'hub-media:ok' },
    '纯字符串段不动',
  ];
  assert.deepEqual(resolvePartsMedia(fakeHub, partsIn), [
    { type: 'text', content: '喏' },
    { type: 'image', source: 'D:\\blobs\\ok.png' },
    { type: 'image', file: 'D:\\blobs\\ok.png' },
    { type: 'image', source: 'https://x/y.jpg' },
    { type: 'image', id: 'D:\\blobs\\ok.png' },
    '纯字符串段不动',
  ]);
  assert.throws(() => resolvePartsMedia(fakeHub, [{ type: 'image', source: 'hub-media:gone' }]), /图片引用不可用：hub-media:gone/);
  assert.deepEqual(resolvePartsMedia(fakeHub, undefined), [], '不传 parts 不炸');
  // 表情包段里的 `id` 是表情包 id（`m3`），不是图片路径——不能被这条解析误碰。
  assert.deepEqual(resolvePartsMedia(fakeHub, [{ type: 'meme', id: 'm3' }]), [{ type: 'meme', id: 'm3' }]);

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
  const frames = [];
  const ws = new EventEmitter();
  ws.readyState = 1; // WS_OPEN
  ws.send = (raw) => frames.push(JSON.parse(raw));
  ws.close = () => {
    ws.readyState = 3;
  };
  /**
   * **心跳测试不碰真实计时器**（`m24175`）。这条红过四次，每次都是
   * `应发出至少两次心跳，实际 1`：CI 的 Windows 机器上 `setInterval(20ms)` 三秒里
   * 就只跑了一次——那测的不是心跳，是机器有多快。现在注入一对假计时器手动 tick，
   * 断言"tick 几次就该发几条、内容对不对"，跟机器速度无关。
   */
  const live = new Map();
  let seq = 0;
  const timers = {
    setInterval(fn) {
      seq += 1;
      live.set(seq, fn);
      return { id: seq, unref: () => {} };
    },
    clearInterval(handle) {
      live.delete(handle.id);
    },
    tick(n = 1) {
      for (let i = 0; i < n; i += 1) for (const fn of [...live.values()]) fn();
    },
    get running() {
      return live.size;
    },
  };
  const session = new DownstreamSession({ selfId: '30001000', ws, role: 'Implementation', log: () => {}, timers });

  // 0 = 关（bot-app 型链路就是这么关掉的）
  assert.equal(session.startHeartbeat({ intervalMs: 0 }), false);
  timers.tick(3);
  assert.equal(frames.length, 0, 'intervalMs: 0 一个字节都不该发');
  assert.equal(timers.running, 0, '关着的时候不该有计时器在跑');

  assert.equal(session.startHeartbeat({ intervalMs: 20 }), true);
  assert.equal(timers.running, 1, '开着的时候正好一个计时器');
  timers.tick(2);
  const beats = frames.filter((f) => f.meta_event_type === 'heartbeat');
  assert.equal(beats.length, 2, `tick 两次就该发两条，实际 ${beats.length}`);
  assert.equal(beats[0].post_type, 'meta_event');
  assert.equal(beats[0].self_id, '30001000');
  assert.equal(beats[0].interval, 20);
  assert.equal(beats[0].status.online, true);
  assert.equal(beats[0].status.good, true);
  assert.equal(typeof beats[0].time, 'number');

  // 停了之后一条都不许多发，计时器也要清掉
  session.stopHeartbeat();
  const afterStop = frames.length;
  timers.tick(3);
  assert.equal(frames.length, afterStop, 'stopHeartbeat 之后不再发');
  assert.equal(timers.running, 0, 'stopHeartbeat 要把计时器清掉');

  // 连接关掉也要停，不然心跳会往死链路上打
  session.startHeartbeat({ intervalMs: 20 });
  session.close();
  const afterClose = frames.length;
  timers.tick(3);
  assert.equal(frames.length, afterClose, 'close 之后不再发');
  assert.equal(session.heartbeatMs, 0);
  assert.equal(timers.running, 0, 'close 也要把计时器清掉');
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
    // `m21653`：`prune` 改成异步（fs.promises + 批量事务），因为它是 O(数据量) 的 IO。
    const out = await recall.prune({ days: 7 });
    assert.equal(out.removedFiles, 1, '超期的日文件要删掉');
    assert.equal(out.removedRows, 1, '内存与索引里的旧行也要掉');
    assert.equal(fs.existsSync(oldFile), false);
    const after = await recall.rawIndex({ limit: 10 });
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].ref, 'tnew');
    // days: 0 = 不清理
    assert.equal((await recall.prune({ days: 0 })).skipped, true);
    // 删完还得搜得到（`m21653`）：过期行占多数时 prune 会走"清表重灌"那条快路，
    // 这条路要保证索引与留在内存里的行一致——否则删完就搜不到任何东西了。
    const hit = await recall.search({ query: '刚刚', limit: 5, sessionKey: 'group:1' });
    assert.ok((hit?.items ?? []).length >= 1, `删完之后剩下的行还得能搜到：${JSON.stringify(hit?.items ?? hit)}`);

    // 媒体 blob 同样的保留期：blob 的 mtime 与索引里的 at 都要看
    const store = new JsonStore({ dir, debounceMs: 0 });
    const media = new MediaStore({ storage: store, linkId: 'up:test', log: () => {} });
    return media
      .saveBytes(Buffer.from('hello'), { mediaType: 'text/plain', name: 'a.txt', kind: 'file' })
      .then(async (ref) => {
        assert.ok(fs.existsSync(ref.blob));
        assert.ok(media.find(ref.id), 'find 能按 hub-media id 取回引用');
        assert.equal(media.find('hub-media:nope'), null);
        fs.utimesSync(ref.blob, new Date(old), new Date(old));
        ref.at = old;
        const pruned = await media.prune({ days: 7 });
        assert.equal(pruned.removed, 1);
        assert.equal(pruned.dropped, 1);
        assert.equal(fs.existsSync(ref.blob), false);
        assert.equal(media.find(ref.id), null, '索引里的老引用也要掉');
        recall.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
  });
});

t('保留期清理：过期行占多数时走「清表重灌」，删完索引仍然可用（`m21653`）', async () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prune-rebuild-'));
  const recall = new RecallStore({ dir, linkId: 'up:test', log: () => {} });
  const dayOf = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const old = Date.now() - 40 * 86400000;
  const oldFile = path.join(dir, 'up_test', `${dayOf(old)}.jsonl`);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  // 120 条旧行 + 1 条新行：过期行占绝大多数 → 触发 rebuild（清表重灌）那条快路。
  const lines = [];
  for (let i = 0; i < 120; i += 1) lines.push(JSON.stringify({ id: `old${i}`, ts: old, sessionKey: 'group:1', text: `很久以前第${i}条` }));
  fs.writeFileSync(oldFile, `${lines.join('\n')}\n`, 'utf8');
  recall.append({ id: 'fresh', ts: Date.now(), sessionKey: 'group:1', text: '刚刚发生的事' });
  try {
    await recall.ensure();
    const out = await recall.prune({ days: 7 });
    assert.equal(out.removedRows, 120, `旧行要全删掉：${JSON.stringify(out)}`);
    // 慢路是逐条 DELETE，快路是 `DELETE FROM rt` + 重灌——后者必须把留下的行灌回去，
    // 否则"清完表就什么都搜不到了"（索引与内存对不上，而且这种错不会报错）。
    const hit = await recall.search({ query: '刚刚发生的事', limit: 5, sessionKey: 'group:1' });
    assert.equal(hit.items.length, 1, `清表重灌之后剩下的行还得搜得到：${JSON.stringify(hit.items)}`);
    assert.ok(JSON.stringify(hit.items[0]).includes('fresh'), `搜到的该是新那条：${JSON.stringify(hit.items[0])}`);
  } finally {
    recall.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('saveBytes：声明类型与字节魔数打架时信字节（生成图上游标错类型的兜底）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sniff-'));
  const store = new JsonStore({ dir, debounceMs: 0 });
  const media = new MediaStore({ storage: store, linkId: 'up:test', log: () => {} });
  try {
    // 豆包 Seedream 实测：JPEG 字节顶着 image/png 的声明来，宿主登记被当场拒绝。
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x11)]);
    const ref = await media.saveBytes(jpeg, { mediaType: 'image/png', kind: 'image' });
    assert.equal(ref.mediaType, 'image/jpeg', 'JPEG 字节不该顶着 image/png 的声明走');
    assert.ok(ref.blob.endsWith('.jpg'), `blob 扩展名应跟着改判成 .jpg：${ref.blob}`);
    // 声明与字节一致时不受影响
    const png = await media.saveBytes(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      { mediaType: 'image/png', kind: 'image' },
    );
    assert.equal(png.mediaType, 'image/png');
    // 嗅探没命中（不是任何已知魔数）≠声明错了，保留调用方声明
    const text = await media.saveBytes(Buffer.from('hello'), { mediaType: 'text/plain', kind: 'file' });
    assert.equal(text.mediaType, 'text/plain', '嗅探没命中时保留声明');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const cfg = { agentGroups: { 123456789: { mode: 'observer' }, 55555: {} }, agentPrivates: { 10001: {} } };
  assert.deepEqual(sessionOverrideOf('group:123456789', cfg), { mode: 'observer' });
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

t('发送失败当场回执：立刻排一次唤醒把失败递回去，窗口内有次数上限（m25376）', async () => {
  // 假 hub：上游拒收（retcode 1200 那种）。假池子只记「有没有起一轮新回合」。
  const nudges = [];
  const pool = {
    presetSwapPlan: () => ({ freshSession: false }),
    async wake(agentKey, opts) {
      nudges.push({ agentKey, text: String(opts?.text ?? '') });
      return { ok: true };
    },
  };
  const hub = {
    config: { agentSendFailureNudgeMax: 2, agentSendFailureNudgeWindowMs: 60000 },
    callUpstream: async () => ({ status: 'failed', retcode: 1200, message: '未知文件类型或路径不存在' }),
  };
  const mind = new Mind({ hub, pool, log: () => {} });
  const candidate = { text: '本鲸给你画了一张', messages: [{ segments: [{ type: 'text', data: { text: '本鲸给你画了一张' } }], text: '本鲸给你画了一张', kind: 'text' }] };
  const res = await mind.deliver('group:55555', candidate);
  assert.equal(res.status, 'failed');
  // 回执排在 flush 之后（不能在自己这一轮里 await 自己），等它落地再断言。
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(nudges.length, 1, '失败要立刻排一次回执唤醒');
  assert.match(nudges[0].text, /没发出去/, '回执要写清哪一条没发');
  assert.match(nudges[0].text, /retcode=1200/);
  assert.match(nudges[0].text, /「本鲸给你画了一张」/, '要带上是哪句话');
  // 已经当场告知过了：下一批开头不该再念一遍。
  assert.equal(mind.pendingSendFailureNotice('group:55555'), null, '当场回执之后不再重复告知');
  assert.equal(mind.stats.sendFailureNudges, 1);
  // 关掉开关就完全不动（退回老行为：存起来等下一批开头告知）。
  const offPool = { presetSwapPlan: () => ({ freshSession: false }), wake: async () => { throw new Error('不该被调'); } };
  const offMind = new Mind({ hub: { config: { agentReplyOnSendFailure: false }, callUpstream: async () => ({ status: 'failed' }) }, pool: offPool, log: () => {} });
  await offMind.deliver('group:55555', candidate);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(offMind.pendingSendFailureNotice('group:55555'), '关掉开关时失败照旧存起来，等下一批开头告知');
  // 上限：窗口内第三次失败不再自动开回合（防止「重试→又失败→又收到回执」转圈）。
  const capNudges = [];
  const capMind = new Mind({
    hub: { config: { agentSendFailureNudgeMax: 2, agentSendFailureNudgeWindowMs: 600000 }, callUpstream: async () => ({ status: 'failed', retcode: 1200 }) },
    pool: { presetSwapPlan: () => ({ freshSession: false }), wake: async (k, o) => { capNudges.push(o); return { ok: true }; } },
    log: () => {},
  });
  for (let i = 0; i < 4; i += 1) {
    await capMind.deliver('group:55555', candidate);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(capNudges.length, 2, '一个窗口里最多自动开 2 次');
  assert.ok(capMind.pendingSendFailureNotice('group:55555'), '撞上限后改由下一批开头告知，失败不能丢');

  // 排不上**不消耗额度**：回执没送达时额度必须还回去，否则一次池子忙就把这个会话的
  // 当场告知废掉五分钟。这里把 `reawake` 打成永远 woke:false，连失败 4 次也不该吃额度。
  const busyMind = new Mind({
    hub: { config: { agentSendFailureNudgeMax: 2, agentSendFailureNudgeWindowMs: 600000 }, callUpstream: async () => ({ status: 'failed', retcode: 1200 }) },
    pool: { presetSwapPlan: () => ({ freshSession: false }), wake: async () => ({ ok: true }) },
    log: () => {},
  });
  busyMind.reawake = async () => ({ woke: false, reason: 'busy' });
  for (let i = 0; i < 4; i += 1) {
    await busyMind.deliver('group:55555', candidate);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(busyMind.stats.sendFailureNudges, 0, '没排上就不该计数');
  assert.ok(busyMind.pendingSendFailureNotice('group:55555'), '没排上时失败条目要留着，等下一批开头告知');

  // 新失败不会被旧回执吞掉：回执成功后只删"它自己那条"。这里用两条不同文本模拟
  // 「回执在飞 → 又来一次失败」——旧实现对 map 无脑 delete，会把新的那条一起吞了。
  const seq = [];
  const raceMind = new Mind({
    hub: { config: { agentSendFailureNudgeMax: 5, agentSendFailureNudgeWindowMs: 600000 }, callUpstream: async () => ({ status: 'failed', retcode: 1200 }) },
    pool: { presetSwapPlan: () => ({ freshSession: false }), wake: async (k, o) => { seq.push(String(o?.text ?? '')); return { ok: true }; } },
    log: () => {},
  });
  const first = await raceMind.deliver('group:55555', candidate);
  assert.equal(first.status, 'failed');
  // 在回执落地之前再制造一次失败（换一句正文，好分辨是哪条被留下）。
  const second = { text: '第二句也没发出去', messages: [{ segments: [{ type: 'text', data: { text: '第二句也没发出去' } }], text: '第二句也没发出去', kind: 'text' }] };
  await raceMind.deliver('group:55555', second);
  await new Promise((r) => setTimeout(r, 20));
  const left = raceMind.pendingSendFailureNotice('group:55555');
  assert.ok(left === null || /第二句/.test(left), `留下的必须是新那条（或已被新回执吃掉），实际：${left}`);
});

t('发出去的图片/表情包在快照里留痕：占位符带上时间线编号（m26901）', async () => {
  // 用户问的是"AI 生图发出去以后，下一轮的聊天记录快照里有没有记录"——以前没有：
  // 图片单独成条、`text` 是空字符串，而会话卡与最近窗口都按"没文本就不渲染"过滤，
  // 于是模型下一轮完全不知道自己发过图（会重复发，或接不上"这张好看"）。
  const timeline = new Timeline({});
  const hub = { config: {}, upstreamLinkId: 'up:test', callUpstream: async () => ({ status: 'ok', data: { message_id: 1 } }) };
  const mind = new Mind({ hub, timeline, log: () => {} });

  const imageOnly = composeReply({ images: ['D:/tmp/a.png'] });
  assert.equal(imageOnly.messages[0].text, '', '前提：只有图的那条文本是空的');
  const res = await mind.deliver('group:55555', imageOnly);
  assert.equal(res.status, 'ok');

  const rows = timeline.bySession('group:55555');
  assert.equal(rows.length, 1);
  const id = rows[0].id;
  assert.equal(rows[0].text, `[图片]〔${id}〕`, '占位符要带上编号，下一轮才回查得到');
  assert.equal(rows[0].refs.carrier, true, '标出来这是占位符，不是真的说过这句话');

  // 会话卡与最近窗口都得看得见这一行（两处是同一道"没文本就滤掉"的过滤）。
  const cards = new Cards({ log: () => {} });
  cards.note(rows[0]);
  const card = renderDigest(cards.digestFor('group:55555'));
  assert.match(card, new RegExp(`我：\\[图片\\]〔${id}〕`), '会话卡里要看得见发过图');
  assert.match(renderWindow(rows, {}), new RegExp(`我：\\[图片\\]〔${id}〕`), '窗口里也要看得见');

  // 表情包：占位符带的是表情包 id（图片段里只剩本地路径，memeId 到不了出站那层）。
  const meme = composeReply({ memes: [{ id: 'meme_bigfish', file: 'D:/tmp/b.png' }] });
  assert.deepEqual(meme.messages[0].memeIds, ['meme_bigfish']);
  await mind.deliver('group:55555', meme);
  const rows2 = timeline.bySession('group:55555');
  const memeRow = rows2.at(-1);
  assert.equal(memeRow.text, `[表情包 meme_bigfish]〔${memeRow.id}〕`);

  // 有字的消息不加占位符也不加编号（内容本来就在，不用回查）。
  await mind.deliver('group:55555', composeReply({ text: '本鲸给你画了一张' }));
  assert.equal(timeline.bySession('group:55555').at(-1).text, '本鲸给你画了一张');
});

// ---------------------------------------------------------------- 跨会话转达（m25983 / m26026）

t('跨会话转达：字条不说"已经发出去了"，包只能用一次且会过期', () => {
  // `m26026` 用户指出的问题：早一版字条写"已经放到这个群里了"，会让 B 以为消息已经发出去。
  // 现在是"东西在我这儿，是个包"——B 才是发送方。
  const letter = letterFor({ fromScope: 'group:123456789', fromLabel: '群 123456789', note: '这边有人在问显卡', packageId: 'pkg_7f3a' });
  assert.match(letter, /【会话间的转达】来自 group:123456789（群 123456789）/);
  assert.match(letter, /递信的是那边的另一个你/);
  assert.match(letter, /pkg_7f3a/);
  assert.match(letter, /不想接就不用动/);
  assert.equal(letter.includes('已经放到这个群里了'), false, '不能说"已经发到群里"：B 才是发送方');
  assert.equal(labelOfScope('private:10001'), '10001 的私聊');
  assert.equal(labelOfScope('group:55555'), '群 55555');

  let now = 1_000_000;
  const store = new PackageStore({ ttlMs: 60_000, now: () => now });
  const pkg = store.put({ segments: [{ type: 'text', data: { text: 'hi' } }], from: 'group:1', to: 'group:2' });
  assert.ok(pkg.id.startsWith('pkg_'));
  // 单次使用：第一次取到，第二次就没了。
  assert.deepEqual(store.take(pkg.id), [{ type: 'text', data: { text: 'hi' } }]);
  assert.equal(store.take(pkg.id), null, '包只能用一次');
  // 过期就取不到。
  const pkg2 = store.put({ segments: [{ type: 'text', data: { text: 'later' } }] });
  now += 61_000;
  assert.equal(store.take(pkg2.id), null, '过期取不到');
  // 超限直接拒绝，不悄悄截断。
  const big = store.put({ segments: [{ type: 'text', data: { text: 'x'.repeat(400 * 1024) } }] });
  assert.equal(big.rejected, 'too-large');
});

t('发起方身份：宿主给的 agent id 是包装过的，要能解回会话键', () => {
  // 2026-10-27 真机：枢纽自己的私聊会话发起转达，被"只有枢纽自己拉起的会话能做跨会话转达"拒了。
  // 根因是宿主给的 `exec.agent.id` 是 `SessionId('onebot-hub:' + encodeURIComponent(会话键))`
  // 再拼上本次激活序号，不是裸的 `private:xxxx`——原来拿 `/^(group|private):/` 一测就假。
  assert.equal(scopeOfAgentId('onebot-hub:private%3A945126014.amvq0zx9vok64'), 'private:945126014');
  assert.equal(scopeOfAgentId('onebot-hub:group%3A833194406.amvq0zx9vok64'), 'group:833194406');
  // 已经是裸会话键就直接认（别的宿主/嵌入场景可能就给这个）。
  assert.equal(scopeOfAgentId('group:833194406'), 'group:833194406');
  assert.equal(scopeOfAgentId('private:945126014'), 'private:945126014');
  // 带激活序号的裸键要截到号码为止，否则和来源作用域永远比不等。
  assert.equal(scopeOfAgentId('private:945126014.a1b2c3'), 'private:945126014');
  assert.equal(scopeOfAgentId('group:833194406.amvq0zx9vok64'), 'group:833194406');
  // 宿主那边再转义一层也能解（`%253A` → `%3A` → `:`）。
  assert.equal(scopeOfAgentId('onebot-hub:private%253A945126014.amvq0zx9vok64'), 'private:945126014');
  // 坏转义不抛、也**不硬猜**：解不开就当认不出（宁可拒绝一次，也别把一个外部会话撮合进来）。
  assert.equal(scopeOfAgentId('onebot-hub:private%3A94512%ZZ'), '');
  assert.equal(scopeOfAgentId('onebot-hub:%E0%A4%A'), '');
  // 普通工作区会话认不出来 → 空串（不是"撮合一个"）。
  assert.equal(scopeOfAgentId('main:3f2a9c'), '');
  assert.equal(scopeOfAgentId(''), '');
  assert.equal(scopeOfAgentId(undefined), '');
  // 宿主给了 id 但认不出 → 保持空。**不**退回"枢纽最近活动的会话"，否则外部会话能借壳发言。
  assert.equal(callerOf({ agent: { id: 'main:3f2a9c' } }, 'private:945126014'), '');
  // 宿主给了 id 且认得出 → 用它，忽略 fallback。
  assert.equal(callerOf({ agent: { id: 'onebot-hub:group%3A777.abc' } }, 'private:1'), 'group:777');
  // 宿主压根没给 id（老版本 / 嵌入场景）→ 才用 fallback。
  assert.equal(callerOf({}, 'private:945126014'), 'private:945126014');
  assert.equal(callerOf({ agent: {} }, 'group:55'), 'group:55');
});

t('会话间通道：两条线能来回说，句数封顶，收线后就不再递（m26268）', async () => {
  // 通道本身：开→说→封顶→收线。
  let now = 1_000_000;
  const ch = new ChannelStore({ ttlMs: 60_000, silentMs: 30_000, maxPerSide: 2, now: () => now });
  const rec = ch.open({ from: 'group:111', to: 'group:222', fromLabel: '群 111', toLabel: '群 222' });
  assert.ok(rec.id.startsWith('ch_'));
  assert.equal(ch.live(rec.id).ok, true);
  assert.equal(ch.left(rec.id, 'a'), 2);
  assert.deepEqual(ch.note(rec.id, 'a').left, 1, '说了 1 句还剩 1 句');
  assert.deepEqual(ch.left(rec.id, 'b'), 2, '对面还是满额');
  ch.note(rec.id, 'b');
  ch.note(rec.id, 'a');
  assert.equal(ch.note(rec.id, 'a'), null, '每方封顶后不再给额度');
  // 冷掉：超过 silentMs 没人说话。
  now += 31_000;
  const stale = ch.live(rec.id);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /冷掉/, '10 分钟没人说话就冷掉');
  // 收线。
  const c2 = ch.open({ from: 'group:1', to: 'group:2' });
  assert.equal(ch.close(c2.id).closed, true);
  assert.match(ch.live(c2.id).reason, /主动收线/, '关掉的线再说话要被告知通道已关闭');
  // 30 分钟硬过期。
  now += 10 * 60_000;
  const c3 = ch.open({ from: 'group:1', to: 'group:3' });
  now += 61_000;
  assert.match(ch.live(c3.id).reason, /过期/);

  // 真的走一条线：开线 → 对面回一句 → 收线。
  const delivered = [];
  const relay = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async (scope, opts) => { delivered.push({ scope, text: opts.text }); return { woke: true }; } },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const open = await relay.relay({ from: 'group:111', to: 'group:222', note: '这边在聊显卡', text: '看到一张显卡图', as: 'message' });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.ok(open.channel.startsWith('ch_'), '开线要回一个通道号');
  assert.match(delivered[0].text, /会话间的通道（ch_/);
  const back = await relay.say({ from: 'group:222', channel: open.channel, text: '我看看' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.to, 'group:111', '回话要递回发起方');
  assert.match(delivered.at(-1).text, /【会话间的对话】group:222/);
  assert.match(delivered.at(-1).text, new RegExp(open.channel));
  assert.equal(relay.close({ from: 'group:222', channel: open.channel }).closed, true);
  const after = await relay.say({ from: 'group:111', channel: open.channel, text: '还在吗' });
  assert.equal(after.ok, false);
  assert.match(after.error, /已关闭/);
  // 不认识这条线的人说不了话。
  const stranger = await relay.say({ from: 'group:999', channel: open.channel, text: '插一句' });
  assert.match(stranger.error, /没有你/);
});

t('私聊来源：原文到任何别的会话都禁、转述放行但要过隐私词表（m26268 / m26439）', async () => {
  const delivered = [];
  const now = 1_000_000;
  const relay = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async (scope, opts) => { delivered.push({ scope, text: opts.text }); return { woke: true }; } },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  // 原文：私聊里的一条消息 id → 群里，默认禁。
  const refsOnly = await relay.relay({ from: 'private:10001', to: 'group:222', note: '看这个', refs: ['42'], as: 'message' });
  assert.equal(refsOnly.ok, false);
  assert.match(refsOnly.error, /原文不能搬到别的会话/);
  // 转述：放行，且字条里要标明"这是转述，不是原文"。
  const told = await relay.relay({ from: 'private:10001', to: 'group:222', note: '那边问显卡', text: '那位最近在挑显卡，预算卡在一万以内', as: 'message' });
  assert.equal(told.ok, true, JSON.stringify(told));
  assert.match(delivered.at(-1).text, /是那边的 agent 用自己的话转述的/);
  // 转述里带隐私 → 直接拒，不留余地。
  const leaky = await relay.relay({ from: 'private:10001', to: 'group:333', text: '他工资三万八', as: 'message' });
  assert.equal(leaky.ok, false);
  assert.match(leaky.error, /隐私/);
  // 同一个人从私聊往群里 say 一句，也走同样的检查。
  const open = await relay.relay({ from: 'private:10002', to: 'group:333', note: 'x', text: '他最近在忙', as: 'message' });
  assert.equal(open.ok, true, JSON.stringify(open));
  const bad = await relay.say({ from: 'private:10002', channel: open.channel, text: '他住址在某某路' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /隐私/);
  // 正常的一句能过。
  const good = await relay.say({ from: 'private:10002', channel: open.channel, text: '他大概下周有空' });
  assert.equal(good.ok, true, JSON.stringify(good));

  // `m26439`：私聊 → 另一个私聊，原文同样不能搬。
  const toPrivate = await relay.relay({ from: 'private:10001', to: 'private:10003', note: 'x', refs: ['43'], as: 'message' });
  assert.equal(toPrivate.ok, false);
  assert.match(toPrivate.error, /原文不能搬到别的会话/);
  // 但转述可以，而且字条里一样标明"这是转述"。
  const toldPrivate = await relay.relay({ from: 'private:10001', to: 'private:10003', note: 'x', text: '他最近在挑显卡', as: 'message' });
  assert.equal(toldPrivate.ok, true, JSON.stringify(toldPrivate));
  assert.match(delivered.at(-1).text, /是那边的 agent 用自己的话转述的/);
  // 群来源不受这个开关管：群里取到的原文照旧能搬。
  const fromGroup = await relay.relay({ from: 'group:222', to: 'private:10003', note: 'x', refs: ['44'], as: 'message' });
  assert.equal(fromGroup.ok, false, '取不到消息 id 时会报错，但不该报"原文不能搬"');
  assert.doesNotMatch(fromGroup.error, /原文不能搬/);
});

t('会话间通道的自查修复：额度会退回、不能转给自己、太长的话劝你拆开说（m26370）', async () => {
  const now = 1_000_000;
  // 递送失败要退额度：`get()` 是浅拷贝，改拷贝不算数（这一处曾经真错）。
  let fail = true;
  const relay = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: {
      reawake: async () => (fail ? { woke: false, reason: '上游没醒' } : { woke: true }),
    },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const open = await relay.relay({ from: 'group:1', to: 'group:2', note: 'x', text: '第一句', as: 'message' });
  assert.equal(open.ok, false, '递不到就不算开成');
  assert.equal(relay.channels.stats.open, 0, '递送失败的线要收掉，别留一条僵尸通道');
  fail = false;
  const ok = await relay.relay({ from: 'group:1', to: 'group:2', note: 'x', text: '再试一次', as: 'message' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const ch = ok.channel;
  const before = relay.channels.left(ch, 'b');
  fail = true;
  const bad = await relay.say({ from: 'group:2', channel: ch, text: '说一句但递不到' });
  assert.equal(bad.ok, false);
  assert.equal(relay.channels.left(ch, 'b'), before, '递送失败要把额度还回去');
  fail = false;

  // 不能转给自己。
  const self = await relay.relay({ from: 'group:3', to: 'group:3', note: 'x', text: '喂', as: 'message' });
  assert.equal(self.ok, false);
  assert.match(self.error, /不能转给自己/);

  // 太长的话：明确劝拆，不静默截断，而且不能白扣一句额度。
  const leftBefore = relay.channels.left(ch, 'a');
  const long = await relay.say({ from: 'group:1', channel: ch, text: '啊'.repeat(601) });
  assert.equal(long.ok, false);
  assert.match(long.error, /拆成/);
  assert.equal(relay.channels.left(ch, 'a'), leftBefore, '被拒的长句不该吃掉额度');

  // `as:"forward"` 但只有一段话：降级成单条，不整次废掉。
  const only = await relay.relay({ from: 'group:1', to: 'group:4', note: 'x', text: '只有一句话', as: 'forward' });
  assert.equal(only.ok, true, JSON.stringify(only));
  assert.equal(only.as, 'message');

  // channelSilentMs=0：不按沉默冷掉，只看 TTL。
  const warm = new ChannelStore({ ttlMs: 60_000, silentMs: 0, maxPerSide: 6, now: () => now });
  const c = warm.open({ from: 'group:1', to: 'group:2' });
  assert.equal(warm.live(c.id).ok, true);
});

t('跨会话转达的自查（m26473）：note 也是转述、递送失败不吃额度也不记指纹、不归枢纽管的会话不去叫醒、@全体成员不跟着搬', async () => {
  const now = 1_000_000;
  const relay = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async () => ({ woke: true }) },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  // `note` 是模型写给对面看的一整段话，和 `text` 一样原样递过去——只查 `text` 就是个后门。
  const smuggle = await relay.relay({ from: 'private:10001', to: 'group:222', note: '他工资三万八', text: '那位在挑显卡', as: 'message' });
  assert.equal(smuggle.ok, false);
  assert.match(smuggle.error, /隐私/);
  // 群来源的 note 不受管（群里的话本来半公开）。
  const groupNote = await relay.relay({ from: 'group:222', to: 'group:333', note: '他工资三万八', text: '群 222 在聊薪资', as: 'message' });
  assert.equal(groupNote.ok, true, JSON.stringify(groupNote));

  // 递送失败：既不能把指纹记上（否则重试撞"刚转达过"），也不能把频率名额吃掉。
  let fail = true;
  const flaky = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async () => (fail ? { woke: false, reason: '上游没醒' } : { woke: true }) },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const same = { from: 'group:1', to: 'group:2', note: 'x', text: '同一句话', as: 'message' };
  for (let i = 0; i < 3; i += 1) {
    const bad = await flaky.relay(same);
    assert.equal(bad.ok, false);
    assert.doesNotMatch(bad.error, /太频繁|刚转达过/, `第 ${i + 1} 次失败不该被自己的失败挡住`);
  }
  fail = false;
  const retry = await flaky.relay(same);
  assert.equal(retry.ok, true, `三次失败之后仍然要能真递到：${JSON.stringify(retry)}`);

  // 不归枢纽管的群：不能去叫醒它（否则机器人会在没人管的群里说话）。
  const scoped = new CrossRelay({
    hub: { config: { agentGroups: { 222: {}, 333: {} }, agentPrivates: {} }, profiles: { person: () => null } },
    mind: { reawake: async () => ({ woke: true }) },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const stranger = await scoped.relay({ from: 'group:222', to: 'group:999999', note: 'x', text: '喂', as: 'message' });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /不归枢纽管/);
  const inBook = await scoped.relay({ from: 'group:222', to: 'group:333', note: 'x', text: '喂', as: 'message' });
  assert.equal(inBook.ok, true, `白名单里配了的群要能递：${JSON.stringify(inBook)}`);
  const selfToo = await scoped.relay({ from: 'group:222', to: 'group:222', note: 'x', text: '喂', as: 'message' });
  assert.match(selfToo.error, /不能转给自己/);

  // `@全体成员` 跟着搬会变成一次真通知：降级成纯文字。
  const { sendable, degraded } = transcode([
    { type: 'at', data: { qq: 'all' } },
    { type: 'at', data: { qq: '10002' } },
  ]);
  assert.deepEqual(sendable.map((s) => s.type), ['text', 'at'], '@全体成员变文字，@个人照旧');
  assert.match(degraded[0] ?? '', /全体成员/);
});

t('外部会话开线要留住地址（2026-10-27 真机：字条写「未知会话」、回喊报「递不到 ：」）', async () => {
  const now = 1_000_000;
  const OUT = 'session-4760fa3f-7bf1-4e68-b3b7-a4dbc93cb7d4';
  const hubLetters = []; // 递进枢纽会话的字条
  const outLetters = []; // 递回外部会话的字条（followup）
  const lookedUp = [];
  const relay = new CrossRelay({
    hub: { config: { agentGroups: { 222: {} }, agentPrivates: {} }, profiles: { person: () => null } },
    mind: {
      reawake: async (scope, opts) => {
        hubLetters.push({ scope, text: opts.text });
        return { woke: true };
      },
    },
    host: {
      getLive: (key) => {
        lookedUp.push(key);
        return key === OUT ? { followup: async (msg) => outLetters.push(msg) } : null;
      },
    },
    config: { cross: { enabled: true, allowFrom: 'all' } },
    now: () => now,
  });

  // 身份三态：解得出枢纽键是 hub；解不出但**有 id** 的是 external（要留住原 id）；什么都没有才是 none。
  assert.deepEqual(callerScopeOf({ agent: { id: OUT } }), { kind: 'external', scope: OUT });
  assert.deepEqual(callerScopeOf({ agent: { id: 'onebot-hub:private%3A945126014.amvq0zx9vok64' } }), {
    kind: 'hub',
    scope: 'private:945126014',
  });
  assert.deepEqual(callerScopeOf({}, () => 'group:1'), { kind: 'hub', scope: 'group:1' });
  assert.deepEqual(callerScopeOf({}, ''), { kind: 'none', scope: '' });
  assert.equal(labelOfScope(OUT), '另一个会话（4760fa3f）', '外部会话也要能对上是哪一条线');

  // 开线：字条里得有地址，不能是「来自 未知会话」。
  const open = await relay.relay({ from: OUT, fromKind: 'external', to: 'group:222', note: '想问一句', text: '那边在聊什么', as: 'message' });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.match(hubLetters.at(-1).text, /另一个会话（4760fa3f）/);
  assert.doesNotMatch(hubLetters.at(-1).text, /未知会话/);

  // 回话：`getLive` 必须拿到**原样**的会话 id——包成 `onebot-hub:<编码>` 就永远查不到（真机就是这么断的）。
  const back = await relay.say({ from: 'group:222', channel: open.channel, text: '在聊显卡' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.ok(lookedUp.includes(OUT), `getLive 要拿到原串，实际收到：${lookedUp.join(',')}`);
  assert.match(String(outLetters.at(-1)?.content ?? ''), /在聊显卡/, '回话要真的落进外部会话');

  // 认不出的身份：`allowFrom: all` 也不能开线——开了就是一条没有回信地址的线。
  const anonymous = await relay.relay({ from: '', fromKind: 'none', to: 'group:222', note: 'x', text: '喂', as: 'message' });
  assert.equal(anonymous.ok, false);
  assert.match(anonymous.error, /认不出你是谁/);

  // 默认 `allowFrom: hub`：外部会话仍然被拒，但理由要写清怎么放开。
  const strict = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async () => ({ woke: true }) },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const denied = await strict.relay({ from: OUT, fromKind: 'external', to: 'group:222', note: 'x', text: '喂', as: 'message' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /cross\.allowFrom/);
});

t('跨会话转达的第三轮自查（m27100）：去重不占名额、失败不白吃名额、引用段不当噪声、包 id 猜不到', async () => {
  const now = 1_000_000;
  const relay = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async () => ({ woke: true }) },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const first = await relay.relay({ from: 'group:1', to: 'group:2', note: 'n', text: '同一句', as: 'message' });
  assert.equal(first.ok, true, JSON.stringify(first));
  // 同一内容连撞三次：挡住它的是去重，不该顺手把五分钟的三个名额吃光。
  for (let i = 0; i < 3; i += 1) {
    const dup = await relay.relay({ from: 'group:1', to: 'group:2', note: 'n', text: '同一句', as: 'message' });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /刚转达过/);
  }
  const other = await relay.relay({ from: 'group:1', to: 'group:2', note: 'n', text: '换一句', as: 'message' });
  assert.equal(other.ok, true, `重复内容被拒之后，新内容还得转得出去：${JSON.stringify(other)}`);

  // 因为"包太大"被拒的那几次，名额也得还回来。
  const tight = new CrossRelay({
    hub: { config: {}, profiles: { person: () => null } },
    mind: { reawake: async () => ({ woke: true }) },
    config: { cross: { enabled: true, maxBytes: 1024 } },
    now: () => now,
  });
  for (let i = 0; i < 3; i += 1) {
    const big = await tight.relay({ from: 'group:1', to: 'group:2', note: 'n', text: '大'.repeat(2000), as: 'message' });
    assert.equal(big.ok, false);
    assert.match(big.error, /内容太大/);
  }
  const small = await tight.relay({ from: 'group:1', to: 'group:2', note: 'n', text: '小的一句', as: 'message' });
  assert.equal(small.ok, true, `三次"太大"之后还得转得出去：${JSON.stringify(small)}`);

  // `reply` 段（"这条是在回哪句"）搬过去指向也不成立，不该被说成"转不过来"。
  const quoted = transcode([{ type: 'text', data: { text: '好' } }, { type: 'reply', data: { id: '42' } }]);
  assert.deepEqual(quoted.sendable.map((s) => s.type), ['text']);
  assert.deepEqual(quoted.degraded, [], '引用段是噪声，不该出现在回执里');

  // 包 id 不能被顺着念出来：8 位随机十六进制（原来是序号拼随机数，跑一阵后能枚举）。
  let tickp = 0;
  const store = new PackageStore({ ttlMs: 60_000, now: () => (tickp += 1) });
  const pkA = store.put({ segments: [{ type: 'text', data: { text: 'x' } }] });
  const pkB = store.put({ segments: [{ type: 'text', data: { text: 'y' } }] });
  assert.match(pkA.id, /^pkg_[0-9a-f]{8}$/);
  assert.notEqual(pkA.id, pkB.id);
  assert.equal(store.take(pkA.id)?.length, 1, '包仍然单次可用');
  assert.equal(store.take(pkA.id), null, '再取一次就没有了');

  // 递送失败退额度时，沉默时钟也要拨回去——没送出去的话不算"刚有人说过话"。
  let tick = 1_000_000;
  const chStore = new ChannelStore({ ttlMs: 3_600_000, silentMs: 300_000, maxPerSide: 6, now: () => tick });
  const line = chStore.open({ from: 'group:1', to: 'group:2' });
  tick += 240_000;
  const marker = chStore.note(line.id, 'a', tick);
  assert.equal(chStore.get(line.id).lastAt, tick);
  chStore.refund(line.id, 'a', marker.prevLastAt);
  assert.equal(chStore.get(line.id).lastAt, 1_000_000, '没送出去的那句话不该把线推老');
  assert.equal(chStore.left(line.id, 'a'), 6, '额度要还回来');
});

t('跨会话转达：只能搬自己这个会话里看见的消息（时间线按 id 找得到，别人的要报清楚）', async () => {
  const now = 1_000_000;
  const delivered = [];
  const timeline = new Timeline({});
  const mine = { ...upstreamGroup, group_id: 222, message_id: 900001, message: [{ type: 'text', data: { text: '群 222 里那句话' } }] };
  const others = { ...upstreamGroup, group_id: 333, message_id: 900002, message: [{ type: 'text', data: { text: '群 333 的话' } }] };
  const mineEntry = timeline.record({ direction: 'upstream-in', linkId: 'up:1', event: mine });
  timeline.record({ direction: 'upstream-in', linkId: 'up:2', event: others });
  // 时间线现在真能按 id 找到了：内部 id 与 OneBot 的 message_id 都认。
  assert.equal(timeline.byId(mineEntry.id)?.sessionKey, 'group:222', '按内部 id 找得到');
  assert.equal(timeline.byId('900001')?.sessionKey, 'group:222', '按 message_id 也找得到');
  assert.equal(timeline.byId('nope'), null);

  const relay = new CrossRelay({
    hub: { timeline, config: {}, profiles: { person: () => null } },
    mind: { reawake: async (scope, opts) => { delivered.push({ scope, text: opts.text }); return { woke: true }; } },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  // 自己会话里的消息：从本地时间线取，不用问上游，包里有原文。
  const own = await relay.relay({ from: 'group:222', to: 'group:444', note: 'x', refs: ['900001'], as: 'message' });
  assert.equal(own.ok, true, JSON.stringify(own));
  const pkgSegments = relay.takePackage(own.packageId);
  assert.deepEqual(pkgSegments?.map((s) => s.data?.text), ['群 222 里那句话'], '本地取到的原文要能搬过去');

  // 别的群的消息：不许搬，而且要直接说清"这不是你这个会话里的"。
  const stolen = await relay.relay({ from: 'group:333', to: 'group:444', note: 'x', refs: ['900001'], as: 'message' });
  assert.equal(stolen.ok, false);
  assert.ok(
    (stolen.degraded ?? []).some((d) => /不在你现在的会话里/.test(d)),
    `跨会话搬别人的消息要被挡住：${JSON.stringify(stolen)}`,
  );
});

t('跨会话转达：语音/视频/文件降级成一句说明，不静默丢', () => {
  const { sendable, degraded } = transcode([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'record', data: { file: 'a.amr', duration: 12 } },
    { type: 'file', data: { file: 'a.zip', file_size: 300 * 1024 } },
    { type: 'json', data: { data: '{"app":"x"}' } },
  ]);
  assert.deepEqual(sendable.map((s) => s.type), ['text', 'image', 'json'], '能搬的原样带过去');
  assert.equal(degraded.length, 2);
  assert.match(degraded[0], /语音（12 秒）/);
  assert.match(degraded[1], /文件（300 KB）/);
});

t('字条要报包里有什么（只报形状），转不过来的要跟着说（m27441）', async () => {
  // 只报形状，不带内容：B 拿到的应当是"1 张图片、1 段文字"，不是图里的字。
  assert.equal(describeParcel([{ type: 'text', data: { text: '秘密' } }, { type: 'image', data: {} }]), '1 张图片、1 段文字');
  assert.equal(describeParcel([{ type: 'json', data: {} }]), '1 张卡片');
  assert.equal(describeParcel([{ type: 'forward', data: { content: [{}, {}, {}] } }]), '1 条聊天记录（3 条消息）');
  assert.equal(describeParcel([]), '', '空包不报');
  // 超过四项只报前四项 + 总数，别让字条长成一屏。
  const many = describeParcel([
    { type: 'image' }, { type: 'json' }, { type: 'text' }, { type: 'face' }, { type: 'at', data: { qq: '1' } },
  ]);
  assert.match(many, /等 5 项$/);

  const delivered = [];
  const now = 1_000_000;
  const timeline = new Timeline({});
  const entry = timeline.record({
    direction: 'upstream-in',
    linkId: 'up:1',
    event: {
      ...upstreamGroup,
      group_id: 222,
      message_id: 910001,
      message: [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { file: 'a.jpg' } }, { type: 'record', data: { file: 'a.amr', duration: 12 } }],
    },
  });
  const relay = new CrossRelay({
    hub: { timeline, config: {}, profiles: { person: () => null } },
    mind: { reawake: async (scope, opts) => { delivered.push({ scope, text: opts.text }); return { woke: true }; } },
    config: { cross: { enabled: true } },
    now: () => now,
  });
  const out = await relay.relay({ from: 'group:222', to: 'group:444', note: 'x', refs: [entry.id], as: 'message' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const letter = delivered.at(-1).text;
  assert.match(letter, /包里有：1 张图片、1 段文字。/, '要报清包里是什么形状');
  assert.match(letter, /注意：那边还有一段语音（12 秒），转不过来。/, '转不过来的要跟着说，别让 B 以为收齐了');
  assert.doesNotMatch(letter, /看这个/, '清单只报形状，不抄内容');
  assert.doesNotMatch(letter, /\bm\d{5}\b/, '给对面看的字条里不许出现内部编号');
});

t('跨会话转达：包在 onebot_reply 里展开，编造 id 会说清；node 段走合并转发动作', () => {
  const store = new PackageStore({ now: () => 1_000_000 });
  const pkg = store.put({ segments: [{ type: 'image', data: { file: 'blob.jpg' } }] });
  const plan = composeReply({
    parts: [{ type: 'text', content: '给你看个东西' }, { type: 'package', id: pkg.id }],
    resolvePackage: (id) => store.take(id),
  });
  // 包里的段**独立成条**，不能跟相邻文字合并（否则一张 json 卡片会被塞进普通消息里）。
  assert.equal(plan.messages.length, 2);
  assert.deepEqual(plan.messages[1].segments, [{ type: 'image', data: { file: 'blob.jpg' } }]);
  // 同一个包再用一次：说清为什么发不出去。
  const again = composeReply({ parts: [{ type: 'package', id: pkg.id }], resolvePackage: (id) => store.take(id) });
  assert.equal(again.messages.length, 0);
  assert.ok(again.skipped.some((x) => /不存在或已过期/.test(x)), JSON.stringify(again.skipped));
  // 合并转发：node 段要换成 send_group_forward_msg，而不是塞进 send_msg（那个认不得 node）。
  const { action, params } = buildSendParams({
    segments: [{ type: 'node', data: { uin: '10001', name: '小张', content: [{ type: 'text', data: { text: '原话' } }] } }],
    sessionKey: 'group:55555',
  });
  assert.equal(action, 'send_group_forward_msg');
  assert.equal(params.group_id, 55555);
  assert.equal(params.messages[0].type, 'node');
  // 没有 node 时行为不变。
  assert.equal(buildSendParams({ segments: [{ type: 'text', data: { text: 'hi' } }], sessionKey: 'group:55555' }).action, 'send_msg');
});

// ---------------- 跨会话读取的受众闸（`m28449`） ----------------
t('读范围：白名单为空时谁都不给跨会话', () => {
  const trusted = parseTrustedPrivates('[]');
  for (const current of ['group:55555', 'private:10001']) {
    const r = canRead({ current, target: 'group:66666', trusted });
    assert.equal(r.ok, false, `${current} 不该能读`);
    assert.match(r.reason, /白名单/);
  }
});

t('读范围：群读群放行、群读私聊恒拒（硬边界，白名单也救不了）', () => {
  const trusted = parseTrustedPrivates('["10001"]');
  assert.equal(canRead({ current: 'group:55555', target: 'group:66666', trusted }).ok, true);
  for (const ok of [true, false]) {
    const set = ok ? trusted : new Set();
    const r = canRead({ current: 'group:55555', target: 'private:10001', trusted: set });
    assert.equal(r.ok, false);
    assert.match(r.reason, /群会话不读任何私聊|白名单/);
  }
});

t('读范围：白名单私聊读一切、普通私聊只读自己', () => {
  const trusted = parseTrustedPrivates('["10001"]');
  assert.equal(canRead({ current: 'private:10001', target: 'private:20002', trusted }).ok, true);
  assert.equal(canRead({ current: 'private:10001', target: 'group:55555', trusted }).ok, true);
  const r = canRead({ current: 'private:20002', target: 'group:55555', trusted });
  assert.equal(r.ok, false);
  assert.equal(canRead({ current: 'private:20002', target: 'private:20002', trusted }).ok, true, '自己的会话永远能读');
});

t('读范围：认不出当前会话就一律拒（fail-closed）', () => {
  const trusted = parseTrustedPrivates('["10001"]');
  const r = canRead({ current: '', target: 'group:55555', trusted });
  assert.equal(r.ok, false);
  assert.match(r.reason, /认不出/);
  assert.match(describeReadScope({ current: 'group:55555', trusted }), /私聊一律不可读/);
});

t('白名单解析：裸号 / private: 前缀 / JSON 数组 / 逗号串都认，非法值丢掉', () => {
  assert.deepEqual([...parseTrustedPrivates('[10001,"private:20002"]')].sort(), ['10001', '20002']);
  assert.deepEqual([...parseTrustedPrivates('10001, 20002')].sort(), ['10001', '20002']);
  assert.deepEqual([...parseTrustedPrivates('["abc", -1, ""]')], []);
  assert.deepEqual([...parseTrustedPrivates('')], []);
});

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
