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

const DEFAULT_HUB_ID = 'dsh-onebot-hub';

export class LoopGuard {
  #seen = new Map();
  #sent = new Map();
  #windowMs;
  #maxHop;
  #maxEntries;
  #stats = { droppedOrigin: 0, droppedHop: 0, droppedDuplicate: 0, droppedSent: 0, allowed: 0 };

  constructor({ windowMs = 3000, maxHop = 3, maxEntries = 512 } = {}) {
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

    if (trace && trace.origin === DEFAULT_HUB_ID) {
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

  /** 与链路和方向无关的内容键；`withId` 决定是否把 message_id 计入（重传判据）。 */
  #key(linkId, direction, event, withId) {
    if (event?.post_type !== 'message') return null;
    const text = messageToText(segmentsOf(event));
    if (!text) return null;
    const from = event.user_id ?? event.self_id ?? '?';
    const dir = direction ?? '*';
    const mid = withId ? (event.message_id ?? '') : '';
    return `${linkId}|${dir}|${sessionKey(event)}|${from}|${mid}|${text}`;
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
