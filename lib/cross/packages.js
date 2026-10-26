/**
 * 会话间转达的「包」（`m25983` 起的设计，`m26026` 定稿：东西交给 B，发不发由 B 决定）。
 *
 * 为什么要有这一层：跨群搬运的内容里，小程序卡（`json` 段）和合并转发（`forward` 段）
 * 是**整段透传**的东西——枢纽把上游的原始段原样带过来，但**不能**把"自己造一段 json 发出去"
 * 的能力交给模型。模型一旦能构造卡片，就能伪造一条"官方通知"。
 *
 * 所以中间隔一层：搬运时枢纽把归一化好的段存进这里，只给 B 一个短 id（`pkg_7f3a`）。
 * B 发消息时带 `{"type":"package","id":"pkg_7f3a"}`，枢纽在**展开的那一刻**才把真实段塞进去。
 * B 从头到尾没见过卡片的原始 json，也造不出第二张。
 *
 * 三条约束，都是刻意的：
 *  - **单次使用**：取走即删。B 想再发一次得重新要包（避免"一条转达被反复刷出去"）。
 *  - **有寿命**：默认 30 分钟。B 可能很久之后才醒，过期了就该重新判断一次。
 *  - **有上限**：条数与字节数都封顶，防止一条搬运把内存撑爆。
 */

import { randomBytes } from 'node:crypto';

/** 包 id 的形状：`pkg_` + 8 位十六进制。短到模型抄不错，长到**猜不到**（见下）。 */
const ID_PREFIX = 'pkg_';

/**
 * 为什么是随机的而不是递增序号（`m27100` 自查）：
 * 包是全局的，`onebot_reply` 只凭 id 就能把段展开到**任何**会话里。原来是
 * `seq + random(0..4095)` 拼出来的四位 base36，跑一阵后编号全落在 1..4000 —— 任何
 * 会话的模型只要顺着念一遍，就有机会把**别的群**的转达内容发到自己群里。隔离不该
 * 依赖"模型不会乱试"，所以这里换成 32 位随机。仍然单次使用、仍然 30 分钟过期。
 */
function nextPackageId() {
  return `${ID_PREFIX}${randomBytes(4).toString('hex')}`;
}

export const DEFAULT_PACKAGE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_PACKAGE_MAX_BYTES = 300 * 1024;
export const DEFAULT_PACKAGE_MAX = 50;

/** 段数组的字节量（按 JSON 估算，不用精确——它只是防呆的上限闸）。 */
export function segmentsBytes(segments) {
  try {
    return Buffer.byteLength(JSON.stringify(segments ?? []), 'utf8');
  } catch {
    return Infinity;
  }
}

export class PackageStore {
  #items = new Map();

  constructor({ ttlMs = DEFAULT_PACKAGE_TTL_MS, maxBytes = DEFAULT_PACKAGE_MAX_BYTES, max = DEFAULT_PACKAGE_MAX, now = Date.now } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_PACKAGE_TTL_MS);
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_PACKAGE_MAX_BYTES);
    this.max = Math.max(1, Number(max) || DEFAULT_PACKAGE_MAX);
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  #now;

  /** 存一个包。段数组超限直接拒绝（返回 `null`），让调用方把原因写进回执。 */
  put({ segments, from = '', to = '', note = '', as = 'message' } = {}) {
    const list = Array.isArray(segments) ? segments : [];
    if (!list.length) return null;
    const bytes = segmentsBytes(list);
    if (bytes > this.maxBytes) return { rejected: 'too-large', bytes, maxBytes: this.maxBytes };
    this.sweep();
    // 满了就丢最旧的（搬运是"当下的事"，旧包早就没人要了）。
    while (this.#items.size >= this.max) {
      const oldest = [...this.#items.values()].sort((a, b) => a.at - b.at)[0];
      if (!oldest) break;
      this.#items.delete(oldest.id);
    }
    const id = nextPackageId();
    const at = this.#now();
    const rec = { id, segments: list, from, to, note, as, at, expiresAt: at + this.ttlMs, bytes, usedAt: null };
    this.#items.set(id, rec);
    return rec;
  }

  /** 看一眼（不消费）。给状态展示与调试用。 */
  peek(id) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const rec = this.#items.get(key) ?? null;
    if (!rec) return null;
    if (rec.expiresAt <= this.#now()) {
      this.#items.delete(key);
      return null;
    }
    return rec;
  }

  /**
   * 取走并消费。返回段数组或 `null`。
   * `take` 而不是 `get`：单次使用是这里的一部分语义，不是调用方的责任。
   */
  take(id) {
    const rec = this.peek(id);
    if (!rec) return null;
    if (rec.usedAt) return null;
    rec.usedAt = this.#now();
    this.#items.delete(rec.id);
    return rec.segments;
  }

  /** 清掉过期的。每次 `put` 都会顺手调一次，不必单独定时。 */
  sweep() {
    const now = this.#now();
    let dropped = 0;
    for (const [id, rec] of this.#items) {
      if (rec.expiresAt <= now) {
        this.#items.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  get stats() {
    return { live: this.#items.size, ttlMs: this.ttlMs, maxBytes: this.maxBytes, max: this.max };
  }

  clear() {
    this.#items.clear();
  }
}
