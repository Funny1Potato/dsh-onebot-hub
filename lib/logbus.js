/**
 * 最近发生了什么——给「OneBot 日志」面板用的内存流水。
 *
 * 它和 `timeline` 的区别是**用途**：时间线是给 agent 看的内容（消息、谁说的、上下文），
 * 这里是给**人**看的运行状态（哪条边进来了、哪个 action 发了、多久、返回什么）。
 * 所以：
 *  - 纯内存、不落盘、重启即空（"现在怎么样"，不是"历史是什么"）；
 *  - 只存摘要 + 结构化字段，正文进 `detail` 且已脱敏、已截断；
 *  - 环形覆盖，默认 2000 条，够看一晚上的来回。
 *
 * 为什么不让面板直接读 `timeline`：时间线里**没有**下游动作、没有 retcode、没有耗时，
 * 而这三样正是排查"为什么没发出去"时要看的。反过来时间线里那些内容也不该出现在
 * 一个谁都能点开的页面里。
 */

const DEFAULT_LIMIT = 2000;
const SUMMARY_MAX = 300;
const DETAIL_MAX = 4000;

/** 这些键的值一律不落进流水（大小写不敏感） */
const SECRET_KEY = /token|secret|apikey|api_key|cookie|password|authorization/i;

const clip = (value, n) => String(value ?? '').slice(0, n);

/** 深拷贝并抹掉敏感键；超过 `max` 的字符串截断。不抛。 */
export function redact(value, max = DETAIL_MAX, depth = 0) {
  if (depth > 6) return '<…>';
  if (typeof value === 'string') return clip(value, max);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, max, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '<已隐去>' : redact(item, max, depth + 1);
  }
  return out;
}

/** 一条流水的规范化：多余的键丢掉，缺的补默认值，文本一定截断。 */
function normalize(entry, seq, now) {
  const src = entry && typeof entry === 'object' ? entry : {};
  return {
    seq,
    ts: Number.isFinite(src.ts) ? src.ts : now(),
    kind: clip(src.kind || 'system', 20),
    direction: src.direction === 'in' || src.direction === 'out' ? src.direction : 'sys',
    ok: src.ok === false ? false : src.ok === true ? true : null,
    sessionKey: clip(src.sessionKey ?? '', 80),
    action: clip(src.action ?? '', 60),
    retcode: Number.isFinite(src.retcode) ? src.retcode : null,
    ms: Number.isFinite(src.ms) ? Math.max(0, Math.round(src.ms)) : null,
    summary: clip(src.summary ?? '', SUMMARY_MAX),
    detail: src.detail === undefined ? null : redact(src.detail),
  };
}

export class LogBus {
  /**
   * @param {{limit?:number, now?:() => number}} [opts]
   */
  constructor({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
    this.limit = Math.max(50, Math.floor(Number(limit) || DEFAULT_LIMIT));
    this.now = typeof now === 'function' ? now : () => Date.now();
    /** @type {Array<ReturnType<typeof normalize>>} */
    this.#items = [];
    this.#seq = 0;
    this.dropped = 0;
  }

  #items;
  #seq;
  #subs = new Set();

  get size() {
    return this.#items.length;
  }

  /** 最近一条的序号（面板用它判断"有没有漏"）。 */
  get seq() {
    return this.#seq;
  }

  /**
   * 记一条。返回值是它的序号——SSE 用它做增量对齐。
   * 订阅者抛异常不影响别的订阅者（日志面板崩了不该带崩枢纽）。
   */
  push(entry = {}) {
    const seq = ++this.#seq;
    const row = normalize(entry, seq, this.now);
    this.#items.push(row);
    if (this.#items.length > this.limit) {
      this.#items.shift();
      this.dropped += 1;
    }
    for (const fn of this.#subs) {
      try {
        fn(row);
      } catch {
        /* 订阅者自己的问题 */
      }
    }
    return seq;
  }

  /** 最近 n 条（旧→新），`after` 给了就只回序号更大的。 */
  recent(n = 200, { after = 0 } = {}) {
    const size = Math.max(1, Math.min(this.limit, Math.floor(Number(n) || 200)));
    const pool = after > 0 ? this.#items.filter((row) => row.seq > after) : this.#items;
    return pool.slice(-size);
  }

  /** 订阅新条目，返回退订函数。 */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** 面板上的"清屏"：清空缓冲但**不**重置序号（否则订阅方会以为全丢了）。 */
  clear() {
    this.#items = [];
    return this.#seq;
  }

  stats() {
    return { size: this.#items.length, limit: this.limit, seq: this.#seq, dropped: this.dropped, subscribers: this.#subs.size };
  }
}
