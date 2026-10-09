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
  #bySession = new Map();
  #limitGlobal;
  #limitSession;
  #total = 0;

  constructor({ limitGlobal = 10000, limitSession = 1000, onRecord = null } = {}) {
    this.#limitGlobal = limitGlobal;
    this.#limitSession = limitSession;
    this.onRecord = onRecord;
  }

  get stats() {
    return { total: this.#total, retained: this.#global.length, sessions: this.#bySession.size };
  }

  /**
   * @param {{direction:'upstream-in'|'downstream-in'|'downstream-out'|'hub-out'|'hub-in',
   *          linkId:string, selfId?:any, event?:object, action?:string, params?:object,
   *          decision?:string, text?:string, refs?:object}} input
   */
  record(input) {
    const { direction, linkId, selfId, event, action, params, decision, refs } = input;
    const kind = event ? eventKind(event) : action ? 'action' : 'unknown';
    const key = event ? sessionKey(event) : refs?.sessionKey ?? `link:${linkId}`;
    const entry = {
      id: nextId(),
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
    if (this.#global.length > this.#limitGlobal) this.#global.splice(0, this.#global.length - this.#limitGlobal);

    let bucket = this.#bySession.get(key);
    if (!bucket) {
      bucket = [];
      this.#bySession.set(key, bucket);
    }
    bucket.push(entry);
    if (bucket.length > this.#limitSession) bucket.splice(0, bucket.length - this.#limitSession);

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
    return (this.#bySession.get(key) ?? []).slice(-limit);
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

  clear() {
    this.#global = [];
    this.#bySession.clear();
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

  clear() {
    this.#entries = [];
    this.#counters.clear();
  }
}
