/**
 * 全知时间线与捕获账本（§16）。
 *
 * 与 aigfm-master 的根本差别：master 在 NoneBot 里靠白名单去"猜"哪些输出算数，
 * hub 在协议层，`linkId`/`selfId`/方向都是天然已知的，所以**默认全量记录**，
 * 白名单只作为可选的收窄手段（§16.1）。
 */

import { conversationKey, eventKind, messageToText, readTrace, segmentsOf, sessionKey } from './protocol.js';

let seq = 0;
const nextId = () => `t${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

/**
 * 转发镜像判定（真机事故 #3）。
 *
 * 同一条消息在时间线里有**两个视角**：上游收到（`upstream-in`）和我们把它转发给下游
 * （`downstream-out`，带 `refs.upstreamLinkId` / `refs.upstreamMessageId`）。
 * 时间线本身两个都要留（§16 全量记录、可追溯），但**进 prompt 的会话卡与最近窗口只能留一行**，
 * 否则模型会以为用户把同一句话说成了两遍——实测模型据此对用户说"你连着发了两次 /今日小猪"。
 */
export function isForwardMirror(entry) {
  if (entry?.direction !== 'downstream-out') return false;
  const refs = entry?.refs ?? {};
  return refs.upstreamLinkId !== undefined && refs.upstreamLinkId !== null
    || refs.upstreamMessageId !== undefined && refs.upstreamMessageId !== null;
}

/** 只保留"聊天里真实发生过的事"，丢掉枢纽自己转发的镜像（相对顺序不变）。 */
export function canonicalEvents(entries = []) {
  return entries.filter((entry) => !isForwardMirror(entry));
}

export class Timeline {
  #global = [];
  // 全局环的会话索引：只保留同一批对象的引用，随全局裁剪摘除，最多 limitGlobal 条。
  #globalBySession = new Map();
  // 热桶按最后写入顺序排列，可比全局环为单个活跃会话保留更长的历史。
  #bySession = new Map();
  #limitGlobal;
  #limitSession;
  #limitSessions;
  #total = 0;

  constructor({ limitGlobal = 10000, limitSession = 1000, limitSessions = 500, onRecord = null } = {}) {
    this.#limitGlobal = limitGlobal;
    this.#limitSession = limitSession;
    this.#limitSessions = Math.max(8, Number(limitSessions) || 500);
    this.onRecord = onRecord;
  }

  get stats() {
    return {
      total: this.#total,
      retained: this.#global.length,
      sessions: this.#bySession.size,
      sessionLimit: this.#limitSessions,
    };
  }

  /**
   * 先领一个编号（`m26901`）。
   *
   * 为什么需要这个：有些条目要在**写入之前**就知道自己的 id——发送图片/表情包时，
   * 时间线里那条的文本是占位符（`[图片]`），模型下一轮只看见占位符没法回查，
   * 所以把 id 也写进文本里（`我：[图片]〔t_k3x8a91〕`）。领了不用只是跳号，无副作用。
   */
  mintId() {
    return nextId();
  }

  /**
   * @param {{id?:string,
   *          direction:'upstream-in'|'downstream-in'|'downstream-out'|'hub-out'|'hub-in',
   *          linkId:string, selfId?:any, event?:object, action?:string, params?:object,
   *          decision?:string, text?:string, refs?:object}} input
   */
  record(input) {
    const { direction, linkId, selfId, event, action, params, decision, refs } = input;
    const kind = event ? eventKind(event) : action ? 'action' : 'unknown';
    const key = event ? sessionKey(event) : refs?.sessionKey ?? `link:${linkId}`;
    const entry = {
      id: input.id ? String(input.id) : nextId(),
      ts: Date.now(),
      direction,
      linkId,
      selfId: selfId ?? event?.self_id ?? null,
      kind,
      sessionKey: key,
      conversationKey: event ? conversationKey(event) : null,
      actor: event
        ? { user_id: event.user_id ?? null, nickname: event.sender?.nickname ?? null, role: event.sender?.role ?? null }
        : { source: 'downstream-plugin' },
      action: action ?? null,
      decision: decision ?? null,
      text: input.text ?? (event ? messageToText(segmentsOf(event)) : undefined),
      refs: { message_id: event?.message_id ?? null, group_id: event?.group_id ?? null, ...(refs ?? {}) },
      trace: event ? readTrace(event) : null,
      payload: event ? structuredClone(event) : params ? structuredClone(params) : null,
    };

    this.#total += 1;
    this.#global.push(entry);
    let retained = this.#globalBySession.get(key);
    if (!retained) this.#globalBySession.set(key, retained = new Set());
    retained.add(entry);
    if (this.#global.length > this.#limitGlobal) {
      for (const old of this.#global.splice(0, this.#global.length - this.#limitGlobal)) {
        const rows = this.#globalBySession.get(old.sessionKey);
        if (rows?.delete(old) && !rows.size) this.#globalBySession.delete(old.sessionKey);
      }
    }

    const bucket = this.#bySession.get(key) ?? [];
    bucket.push(entry);
    if (bucket.length > this.#limitSession) bucket.splice(0, bucket.length - this.#limitSession);
    // 改写时移到尾端，淘汰 Map 首项即可；同毫秒的记录也按真实写入顺序排。
    this.#bySession.delete(key);
    this.#bySession.set(key, bucket);
    if (this.#bySession.size > this.#limitSessions) this.#bySession.delete(this.#bySession.keys().next().value);

    // L1 原始层（§24.10）：内存环会被上限裁掉，落盘的 jsonl 才是"翻得到过去"的那份。
    // 这里用 try 包住——时间线记不下来是小事，绝不能因此让转发本身失败。
    try {
      this.onRecord?.(entry);
    } catch {
      /* 落盘/索引失败不影响时间线 */
    }

    return entry;
  }

  recent(limit = 50, filter = {}) {
    return this.#filter(this.#global, filter).slice(-limit);
  }

  bySession(key, limit = 200) {
    const bucket = this.#bySession.get(key) ?? [];
    const retained = this.#globalBySession.get(key);
    // 同一会话的两份记录都是按写入留尾；较长的一份包含较短的一份。不需要拼接或去重。
    if (retained && retained.size > bucket.length && bucket.length < this.#limitSession) {
      return [...retained].slice(-this.#limitSession).slice(-limit);
    }
    return bucket.slice(-limit);
  }

  /**
   * 按 id 找一条（`m26473`）。
   *
   * 两种 id 都认：内部 `id`（`t_xxx`，回执里给的是它）和 OneBot 的 `refs.message_id`
   * ——模型从 `onebot_recall` 的 refs 里抄出来的是后者。之前根本没有这个方法，
   * 跨会话转达那边 `timeline?.byId?.()` 恒为 undefined，于是每条都白问一次上游。
   */
  byId(id) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    for (let i = this.#global.length - 1; i >= 0; i -= 1) {
      const e = this.#global[i];
      if (e.id === key) return e;
      if (e.refs?.message_id != null && String(e.refs.message_id) === key) return e;
    }
    return null;
  }

  sessions() {
    return [...this.#bySession.entries()].map(([key, list]) => ({
      sessionKey: key,
      count: list.length,
      lastTs: list.at(-1)?.ts ?? null,
    }));
  }

  #filter(entries, { linkId, direction, kind, sessionKey: sk } = {}) {
    return entries.filter(
      (e) =>
        (linkId === undefined || e.linkId === linkId) &&
        (direction === undefined || e.direction === direction) &&
        (kind === undefined || e.kind === kind) &&
        (sk === undefined || e.sessionKey === sk),
    );
  }

  /**
   * 把一个会话从内存时间线里摘掉（复审 F07：按会话清理时漏了内存副本，
   * 删完原文重启前还能从 `onebot_timeline` 看见）。
   *
   * 落盘的 jsonl 不在这里管——那是 `recall.purgeSession` 的事。
   */
  dropSession(key) {
    const target = String(key ?? '').trim();
    if (!target) return 0;
    const before = this.#global.length;
    this.#global = this.#global.filter((entry) => String(entry?.sessionKey ?? '') !== target);
    const dropped = before - this.#global.length;
    this.#bySession.delete(target);
    this.#globalBySession.delete(target);
    this.#total -= dropped;
    return dropped;
  }

  clear() {
    this.#global = [];
    this.#globalBySession.clear();
    this.#bySession.clear();
    this.#total = 0;
  }
}

/** action 捕获账本：下游到底干了什么（§16.6 `onebot_capture` 的数据源）。 */
export class CaptureLog {
  #entries = [];
  #limit;
  #counters = new Map();

  constructor({ limit = 2000 } = {}) {
    this.#limit = limit;
  }

  get stats() {
    return {
      total: [...this.#counters.values()].reduce((a, b) => a + b, 0),
      retained: this.#entries.length,
      byAction: Object.fromEntries([...this.#counters.entries()].sort((a, b) => b[1] - a[1])),
    };
  }

  add(entry) {
    const rec = { ts: Date.now(), ...entry };
    this.#entries.push(rec);
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit);
    const key = rec.action ?? rec.kind ?? 'unknown';
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
    return rec;
  }

  list({ limit = 50, action, linkId, sessionKey: sk } = {}) {
    return this.#entries
      .filter(
        (e) =>
          (action === undefined || e.action === action) &&
          (linkId === undefined || e.linkId === linkId) &&
          (sk === undefined || e.sessionKey === sk),
      )
      .slice(-limit);
  }

  /** 按会话摘掉捕获账本里属于它的一批（复审 F07）。计数是累计的，不跟着回退。 */
  dropSession(key) {
    const target = String(key ?? '').trim();
    if (!target) return 0;
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => String(entry?.sessionKey ?? '') !== target);
    return before - this.#entries.length;
  }

  clear() {
    this.#entries = [];
    this.#counters.clear();
  }
}
