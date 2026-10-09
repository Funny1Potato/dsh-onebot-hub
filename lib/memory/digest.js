/**
 * L2 会话卡（§21.1）：把一条时间线压成"这一轮需要知道的最小上下文"。
 *
 * 定位很重要：**会话卡是唯一默认注入的记忆层**。L1 时间线全量保留、L3 能力按需注入，
 * 只有会话卡是每轮都进 prompt 的。所以它必须短、必须机械（不调 LLM），
 * 且必须在隔离过滤**之后**再渲染（§24.5 第 6 条）。
 */

import { canonicalEvents } from '../capture.js';
import { mdhm } from '../stamp.js';

export const isMessageEntry = (e) => {
  const post = e?.payload?.post_type;
  if (typeof post === 'string') return post.startsWith('message');
  return e?.kind === 'message';
};

export function worldKeyOf(entry) {
  const payload = entry?.payload ?? {};
  if (payload.message_type === 'group' || payload.group_id !== undefined) {
    const gid = payload.group_id ?? entry?.refs?.group_id;
    if (gid !== undefined && gid !== null) return `group:${gid}`;
  }
  if (payload.user_id !== undefined && payload.user_id !== null) return `private:${payload.user_id}`;
  return entry?.sessionKey ?? 'unknown';
}

/** 说话人的显示名（`昵称(QQ)`）。会话卡落盘与现算摘要必须用同一个函数，否则重启前后一行话会换个人称。 */
export function actorName(entry) {
  const nick = entry?.actor?.nickname;
  const uid = entry?.actor?.user_id ?? entry?.payload?.user_id;
  if (nick && uid !== undefined && uid !== null) return `${nick}(${uid})`;
  if (nick) return String(nick);
  if (uid !== undefined && uid !== null) return `${uid}`;
  // 下游 bot 的动作没有“人”（capture.js 给的是 `{source:'downstream-plugin'}`）——
  // 用链路的人话名字（与最近窗口同一口径），别把内部口径亮给模型。
  if (entry?.actor?.source === 'downstream-plugin' || entry?.direction === 'downstream-in') {
    return String(entry?.refs?.downstreamLabel ?? '下游 bot');
  }
  return entry?.actor?.source ?? '未知';
}

/**
 * 机械摘要：参与者、近况、下游是否已经应答、消息量。
 * @param {Array} events TimelineEvent[]
 */
export function buildDigest(events = [], { maxMessages = 40, maxLines = 12, now = Date.now() } = {}) {
  // 先去掉转发镜像：同一条消息的 `upstream-in` 与 `downstream-out` 不能算成两条，
  // 否则会话卡的"最近 N 条"和参与者计数都会翻倍（真机事故 #3）。
  events = canonicalEvents(events);
  const relevant = events.filter((e) => e && (isMessageEntry(e) || e.action?.startsWith?.('send')));
  const messages = relevant.filter(isMessageEntry).slice(-maxMessages);
  const participants = new Map();
  const lines = [];

  for (const e of messages) {
    const uid = e.actor?.user_id ?? e.payload?.user_id ?? null;
    if (uid !== null) {
      const rec = participants.get(String(uid)) ?? { user_id: uid, nickname: e.actor?.nickname ?? null, role: e.actor?.role ?? null, count: 0, lastTs: 0 };
      rec.count += 1;
      rec.lastTs = Math.max(rec.lastTs, e.ts ?? 0);
      if (!rec.nickname && e.actor?.nickname) rec.nickname = e.actor.nickname;
      participants.set(String(uid), rec);
    }
    lines.push({
      ts: e.ts,
      direction: e.direction,
      actor: actorName(e),
      // 文本不按字数截（m24155）：条数限制（maxMessages/maxLines）保留，字数不砍。
      text: String(e.text ?? ''),
    });
  }

  // 只算"下游自己发出来的"应答：hub-out 是 hub 自己的发送，不能算进静默判定。
  const responders = relevant
    .filter((e) => e.direction === 'downstream-in' && typeof e.action === 'string' && e.action.startsWith('send'))
    .map((e) => ({ linkId: e.linkId, action: e.action, ts: e.ts }));

  const sessionKey = messages.at(-1)?.sessionKey ?? events.at(-1)?.sessionKey ?? null;
  const worldKey = messages.at(-1) ? worldKeyOf(messages.at(-1)) : events.at(-1) ? worldKeyOf(events.at(-1)) : null;

  return {
    sessionKey,
    worldKey,
    now,
    messageCount: messages.length,
    participants: [...participants.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs),
    lines: lines.slice(-maxLines),
    responders,
    downstreamResponded: responders.length > 0,
    firstTs: messages.at(0)?.ts ?? null,
    lastTs: messages.at(-1)?.ts ?? null,
    volume: { total: messages.length, byActor: Object.fromEntries([...participants.entries()].map(([k, v]) => [k, v.count])) },
  };
}

/** 渲染成 prompt 里那一段"会话卡"。跨群条目不带来源（§24.5 第 3 条）。 */
export function renderDigest(digest, { maxLines = 12, maxParticipants = 8 } = {}) {
  if (!digest) return '';
  // 这张卡最要紧的一句是"这些是什么时候说的"——从磁盘读回的旧事只有时分根本看不出隔了
  // 几天（`m34049`：日期和时间都带上）。
  const stamp = digest.resumed && digest.savedAt ? `（重启前留下的那一份，${mdhm(digest.savedAt)} 为止）` : '';
  const head = `【会话卡】${digest.worldKey ?? digest.sessionKey ?? '未知会话'}${stamp}｜最近 ${digest.messageCount} 条消息`;
  const people = digest.participants.slice(0, maxParticipants).map((p) => {
    const name = p.nickname ?? String(p.user_id);
    const badge = p.role && p.role !== 'member' ? `/${p.role}` : '';
    return `${name}${badge}(${p.count})`;
  });
  const lines = digest.lines.slice(-maxLines).map((l) => {
    const who = l.direction === 'hub-out' ? '我' : l.text.trim().startsWith(l.actor) ? l.actor : `${l.actor}`;
    return `- ${mdhm(l.ts)} ${who}：${l.text.replace(/\s+/g, ' ').trim()}`;
  });
  const out = [head];
  if (people.length) out.push(`参与者：${people.join('、')}`);
  if (lines.length) out.push('最近：', ...lines);
  // 落盘的那份必须自报家门：不然模型会把几天前的对话当成"刚刚发生"（这条比它多记了几行重要）。
  if (digest.resumed) out.push('（这条卡是从磁盘读回来的，不是刚从内存里算的：下面这些话是重启之前说的，现在的实时窗口是空的。）');
  if (digest.downstreamResponded) out.push(`注意：本轮下游 bot 已经应答过（${digest.responders.map((r) => r.action).join('、')}）。`);
  return out.join('\n');
}

/**
 * 观测学习的最小机械产物：把"谁说过话"变成可跨群复用的**身份记忆**。
 * 内容事实不由代码推断（§24.11：写入由模型决策），所以这里只产出身份类条目。
 */
export function buildObservedEntries(events = [], { limit = 50 } = {}) {
  const seen = new Map();
  for (const e of events.slice(-limit)) {
    if (!isMessageEntry(e)) continue;
    const uid = e.actor?.user_id ?? e.payload?.user_id;
    if (uid === undefined || uid === null) continue;
    const key = `${e.sessionKey}|${uid}`;
    const rec = seen.get(key) ?? {
      kind: 'identity',
      scope: e.sessionKey,
      worldKey: worldKeyOf(e),
      actor: { user_id: uid },
      text: `${e.actor?.nickname ?? uid} 是 QQ ${uid}${e.actor?.role && e.actor.role !== 'member' ? `（${e.actor.role}）` : ''}`,
      visibility: 'shareable',
      refs: { message_id: e.refs?.message_id ?? null, sessionKey: e.sessionKey },
      source: 'observe',
    };
    seen.set(key, rec);
  }
  return [...seen.values()];
}
