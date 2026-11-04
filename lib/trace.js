/**
 * 防环与去重（§8）。
 *
 * 四道闸门，顺序执行：
 *  1. **来源闸**：事件带着本 hub 铸造的 `dsh_trace` 又回来 → 直接丢弃（bridge/fabric 场景必打环）。
 *  2. **跳数闸**：`hop` 超过上限 → 丢弃（跨多个枢纽时兜底）。
 *  3. **重传闸**：同一链路、同一会话、同一发送者、同一 `message_id`、同一内容 → 重复帧，丢弃。
 *  4. **自送闸**：内容与 hub 自己刚发出去的那条完全一致 → 回声，丢弃。
 *
 * 第 4 条不能靠"内容重复"实现：那会误杀用户连打两条同样的"哈哈"。
 * 所以 hub 每发一条消息都登记在**出站账本**里（`noteSent`），只按账本判回声。
 */

import { messageToText, readTrace, sessionKey, segmentsOf } from './protocol.js';

export const DEFAULT_HUB_ID = 'dsh-onebot-hub';

/**
 * 「会话里另一个人」是谁（`m78216` 自查）。
 *
 * 出站账本与回流事件里的发送者字段**不是一套**：hub 自己发出去的私聊，账本里拿到的是
 * `user_id`（=自己）与 `group_id`（=对方），而它从下游回流时对方在 `user_id`、自己在 `target_id`。
 * 两边一直按 `user_id` 取，键就永远对不上——自送闸在私聊里从来没生效过。
 */
function peerOf(event) {
  if (event?.post_type !== 'message') return String(event?.user_id ?? '?');
  if (event.message_type !== 'private') return String(event?.group_id ?? '?');
  const self = String(event?.self_id ?? '');
  const target = event?.target_id;
  if (target != null && String(target) !== '' && String(target) !== self) return String(target);
  if (String(event?.user_id ?? '') === self) return String(event?.group_id ?? self);
  return String(event?.user_id ?? event?.group_id ?? '?');
}

/** 内容键里的会话部分，同样按「对方」算。 */
function peerSession(event) {
  if (event?.post_type !== 'message') return sessionKey(event);
  const kind = event.message_type === 'private' ? 'private' : 'group';
  return `${kind}:${peerOf(event)}`;
}

export class LoopGuard {
  #seen = new Map();
  #sent = new Map();
  #windowMs;
  #maxHop;
  #maxEntries;
  #selfOrigin;
  #stats = { droppedOrigin: 0, droppedHop: 0, droppedDuplicate: 0, droppedSent: 0, allowed: 0 };

  constructor({ windowMs = 3000, maxHop = 3, maxEntries = 512, selfOrigin = DEFAULT_HUB_ID } = {}) {
    // 来源闸只认**本枢纽自己**铸的 id。两个枢纽互桥时它们各自的 origin 不同，
    // 对方的帧必须放行（否则跳数闸永远轮不到，环形也只能靠"对方先崩"来结束）。
    this.#selfOrigin = String(selfOrigin ?? '').trim() || DEFAULT_HUB_ID;
    this.#windowMs = windowMs;
    this.#maxHop = maxHop;
    this.#maxEntries = maxEntries;
  }

  get stats() {
    return { ...this.#stats };
  }

  /** 铸造本 hub 的 trace 标记。 */
  static stamp({ hop = 0, linkId = null, origin = DEFAULT_HUB_ID, extra = null } = {}) {
    return {
      origin,
      hop,
      link: linkId,
      at: Date.now(),
      ...(extra ? { extra } : {}),
    };
  }

  /**
   * @param {{linkId:string, direction:'upstream'|'downstream', event:object}} input
   * @returns {{action:'allow'|'drop', reason?:string, trace:object|null}}
   */
  check({ linkId, direction, event }) {
    const trace = readTrace(event);

    if (trace && trace.origin === this.#selfOrigin) {
      this.#stats.droppedOrigin += 1;
      return { action: 'drop', reason: `loop:origin(hop=${trace.hop ?? '?'})`, trace };
    }
    if (trace && Number(trace.hop) >= this.#maxHop) {
      this.#stats.droppedHop += 1;
      return { action: 'drop', reason: `loop:hop(${trace.hop})`, trace };
    }

    const now = Date.now();

    const dupKey = this.#key(linkId, direction, event, true);
    if (dupKey) {
      const prev = this.#seen.get(dupKey);
      if (prev !== undefined && now - prev < this.#windowMs) {
        this.#stats.droppedDuplicate += 1;
        return { action: 'drop', reason: 'echo:duplicate', trace };
      }
      this.#seen.set(dupKey, now);
    }

    const sentKey = this.#key(linkId, null, event, false);
    if (sentKey) {
      const prev = this.#sent.get(sentKey);
      if (prev !== undefined && now - prev < this.#windowMs) {
        this.#stats.droppedSent += 1;
        return { action: 'drop', reason: 'echo:sent', trace };
      }
    }

    this.#prune(now);
    this.#stats.allowed += 1;
    return { action: 'allow', trace };
  }

  /**
   * 登记一条 hub 自己发出的消息，供自送闸比对。
   * @param {{linkId:string, event:object}} input
   */
  noteSent({ linkId, event }) {
    const key = this.#key(linkId, null, event, false);
    if (key) this.#sent.set(key, Date.now());
  }

  /**
   * 与链路和方向无关的内容键；`withId` 决定是否把 message_id 计入（重传判据）。
   *
   * 会话与发送人都按「会话里另一个人」取（`peerOf`）：账本与回流事件的字段口径不同，
   * 只有都换算到同一个人才对得上。
   */
  #key(linkId, direction, event, withId) {
    if (event?.post_type !== 'message') return null;
    const text = messageToText(segmentsOf(event));
    if (!text) return null;
    const dir = direction ?? '*';
    const mid = withId ? (event.message_id ?? "") : "";
    return `${linkId}|${dir}|${peerSession(event)}|${peerOf(event)}|${mid}|${text}`;
  }

  #prune(now) {
    if (this.#seen.size <= this.#maxEntries && this.#sent.size <= this.#maxEntries) return;
    for (const [k, ts] of this.#seen) {
      if (now - ts >= this.#windowMs) this.#seen.delete(k);
    }
    for (const [k, ts] of this.#sent) {
      if (now - ts >= this.#windowMs) this.#sent.delete(k);
    }
  }
}
