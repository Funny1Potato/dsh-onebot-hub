/**
 * 会话间通道（`m26268`）：把"一次性递字条"升级成"两头都能接着说的线"。
 *
 * 为什么要有它：v1 的 relay 是快递——A 递一个包，B 要么回一张字条要么不回，然后就散了。
 * 用户要的是传话筒：A 说一句、B 能问一句、A 再答一句。那就不该是无状态的一次投递，
 * 而是一条**有寿命的会话**（谁跟谁、说过几句、还能说几句）。
 *
 * 三条刻意设的上限（缺一条就会变成两条群互相客气到天亮）：
 *  1. `maxPerSide`：每方最多 6 句。硬上限，不靠模型自觉。
 *  2. `ttlMs`：30 分钟硬过期。跨天的"对话"没有意义，上下文早丢了。
 *  3. `silentMs`：10 分钟没人说话就冷掉。谁都不许用一条僵尸线反复唤醒对方。
 *
 * 通道只在内存里：它是一条"正在进行"的线，重启后本来也就断了。
 */

/** 30 分钟：一条线最长活这么久。 */
export const DEFAULT_CHANNEL_TTL_MS = 30 * 60 * 1000;

/** 10 分钟没人说话就冷掉——比 TTL 短，所以"沉默"比"过期"更早生效。 */
export const DEFAULT_CHANNEL_SILENT_MS = 10 * 60 * 1000;

/** 每方最多说几句。 */
export const DEFAULT_CHANNEL_MAX_PER_SIDE = 6;

let seq = 0;

function nextId() {
  seq = (seq + 1) % 1e6;
  return `ch_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class ChannelStore {
  #channels = new Map();

  constructor({ ttlMs = DEFAULT_CHANNEL_TTL_MS, silentMs = DEFAULT_CHANNEL_SILENT_MS, maxPerSide = DEFAULT_CHANNEL_MAX_PER_SIDE, now = Date.now } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_CHANNEL_TTL_MS);
    // 0 是合法值：表示不按沉默冷掉（只看 TTL）。`|| DEFAULT` 会把 0 吃掉，所以单独判。
    const sv = Number(silentMs);
    this.silentMs = Number.isFinite(sv) && sv >= 0 ? sv : DEFAULT_CHANNEL_SILENT_MS;
    this.maxPerSide = Math.max(1, Number(maxPerSide) || DEFAULT_CHANNEL_MAX_PER_SIDE);
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  #now;

  get stats() {
    this.sweep();
    let open = 0;
    for (const c of this.#channels.values()) if (!c.closed) open += 1;
    return { open, total: this.#channels.size, maxPerSide: this.maxPerSide, ttlMs: this.ttlMs, silentMs: this.silentMs };
  }

  /** 开一条线。A 是发起方（`from`），B 是目标（`to`）。 */
  open({ from, to, fromLabel = '', toLabel = '' } = {}) {
    const now = this.#now();
    this.sweep(now);
    const id = nextId();
    const rec = {
      id,
      a: { scope: String(from ?? ''), label: String(fromLabel ?? '') },
      b: { scope: String(to ?? ''), label: String(toLabel ?? '') },
      createdAt: now,
      lastAt: now,
      turns: { a: 0, b: 0 },
      // 说过的话（`m36610`）：只记计数时，对面回了什么模型根本读不到——
      // 它只能看见 `turns.b` 在涨，于是反复 say/list 空转。记正文才谈得上"读"。
      log: [],
      closed: false,
      reason: null,
    };
    this.#channels.set(id, rec);
    return { ...rec };
  }

  get(id) {
    const rec = this.#channels.get(String(id ?? ''));
    return rec ? { ...rec } : null;
  }

  /** 这条线现在还活着吗？（关了 / 过期 / 冷掉都算不活） */
  live(id, now = this.#now()) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return { ok: false, reason: '没有这条通道（可能已经过期）' };
    if (rec.closed) return { ok: false, reason: rec.reason ? `通道已关闭：${rec.reason}` : '通道已关闭' };
    if (now - rec.createdAt >= this.ttlMs) {
      rec.closed = true;
      rec.reason = '过期';
      return { ok: false, reason: `通道已过期（${Math.round(this.ttlMs / 60000)} 分钟）` };
    }
    if (this.silentMs && now - rec.lastAt >= this.silentMs) {
      rec.closed = true;
      rec.reason = '太久没人说话';
      return { ok: false, reason: `通道冷掉了（${Math.round(this.silentMs / 60000)} 分钟没人说话）` };
    }
    return { ok: true, rec };
  }

  /** 谁是这一方、对面是谁。`side` 是 'a' | 'b'。 */
  sides(id, scope) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return null;
    const me = String(scope ?? '');
    if (rec.a.scope === me) return { rec, side: 'a', other: rec.b, otherSide: 'b' };
    if (rec.b.scope === me) return { rec, side: 'b', other: rec.a, otherSide: 'a' };
    return null;
  }

  /** 记一句（已经确认要发出去的时候才调）。返回这句是第几轮、还剩几句。 */
  note(id, side, now = this.#now()) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec || rec.closed) return null;
    const key = side === 'b' ? 'b' : 'a';
    if (rec.turns[key] >= this.maxPerSide) return null;
    const prevLastAt = rec.lastAt;
    rec.turns[key] += 1;
    rec.lastAt = now;
    const mine = rec.turns[key];
    return { round: rec.turns.a + rec.turns.b, mine: mine, left: this.maxPerSide - mine, prevLastAt };
  }

  /**
   * 还一句额度（递送失败时用）。**必须走这里**——`get()` 返回的是浅拷贝，
   * 在拷贝上改 `turns` 什么也不会发生（这一条自己踩过）。
   * `prevLastAt` 把沉默时钟也拨回去：一句话没送出去，它就不该算是"刚有人说过话"
   * （`m27100` 自查）。
   */
  refund(id, side, prevLastAt = null) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return 0;
    const key = side === 'b' ? 'b' : 'a';
    rec.turns[key] = Math.max(0, rec.turns[key] - 1);
    if (Number.isFinite(prevLastAt) && prevLastAt < rec.lastAt) rec.lastAt = prevLastAt;
    return this.maxPerSide - rec.turns[key];
  }

  /**
   * 记下一句**真发出去**的话（正文，不含字条的框架说明）。
   * 递送失败时不要调——那一句会被 `refund()` 退额度，也就不该出现在历史里。
   */
  record(id, side, round, text, now = this.#now()) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return null;
    const body = String(text ?? '').trim();
    if (!body) return null;
    rec.log.push({ side: side === 'b' ? 'b' : 'a', round: Number(round) || 0, at: now, text: body.slice(0, 600) });
    if (rec.log.length > 40) rec.log.splice(0, rec.log.length - 40);
    return rec.log.length;
  }

  /** 这条线上说过的话（正序）。`from` 标成 mine/theirs，模型才分得清谁说的。 */
  read(id, side, { limit = 20 } = {}) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return { ok: false, error: '没有这条通道（可能已经过期）' };
    const mine = side === 'b' ? 'b' : 'a';
    const size = Math.max(1, Math.min(40, Number(limit) || 20));
    const entries = (rec.log ?? []).slice(-size).map((e) => ({
      from: e.side === mine ? 'mine' : 'theirs',
      round: e.round,
      at: e.at,
      text: e.text,
    }));
    return {
      ok: true,
      channel: rec.id,
      closed: Boolean(rec.closed),
      ...(rec.closed ? { reason: rec.reason } : {}),
      entries,
      ...(entries.length ? {} : { note: '这条线上还没人说过话。' }),
    };
  }

  left(id, side) {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return 0;
    return Math.max(0, this.maxPerSide - (rec.turns[side === 'b' ? 'b' : 'a'] ?? 0));
  }

  close(id, reason = '主动收线') {
    const rec = this.#channels.get(String(id ?? ''));
    if (!rec) return null;
    rec.closed = true;
    rec.reason = String(reason ?? '主动收线');
    return { ...rec };
  }

  /** 某个会话现在参与着哪些活着的线。 */
  forScope(scope, now = this.#now()) {
    this.sweep(now);
    const me = String(scope ?? '');
    const out = [];
    for (const rec of this.#channels.values()) {
      if (rec.closed) continue;
      if (rec.a.scope === me) out.push({ ...rec, side: 'a', other: rec.b });
      else if (rec.b.scope === me) out.push({ ...rec, side: 'b', other: rec.a });
    }
    return out;
  }

  /** 清掉关了/过期的记录，别让 Map 无限长。 */
  sweep(now = this.#now()) {
    for (const [id, rec] of this.#channels) {
      const expired = now - rec.createdAt >= this.ttlMs;
      const silent = this.silentMs && now - rec.lastAt >= this.silentMs;
      if (rec.closed || expired || silent) {
        // 留一小会儿给"它刚过期"这类回执用，超过 TTL 两倍才真删
        if (rec.closed && now - rec.lastAt > this.ttlMs) this.#channels.delete(id);
        else if (expired || silent) {
          rec.closed = true;
          // 死因要写准：冷掉和过期是两件事，回执里会原样念给模型听。
          rec.reason = rec.reason ?? (expired ? '过期' : '太久没人说话');
          if (now - rec.createdAt > this.ttlMs * 2) this.#channels.delete(id);
        }
      }
    }
  }

  clear() {
    this.#channels.clear();
  }
}
