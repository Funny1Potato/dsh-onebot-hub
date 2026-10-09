/**
 * 成员名解析（§23.6 的"@换称呼"只差最后一步）。
 *
 * 段语义化把 `at` 段里的 QQ 换成称呼，靠的是档案里已经记下的名字。可群里
 * **被 @ 的那个人往往一句话都没说过**——事件里只有他的 QQ，`sender` 是说话
 * 人的，档案对他一片空白。于是第一条提到他的消息永远渲成 `@用户10002`，
 * 只有等他哪天自己开口，名字才补上。
 *
 * 这个模块补的就是这一步：看到 `at` 里出现"这群里还没名字"的 QQ，就**按需**
 * 问一次实现端 `get_group_member_info`（走 `hub.callAction`，因此照样过闸门、
 * 吃缓存、并自动被 `observeActionResult` 写进档案）。
 *
 * 三条自律，都为"别把上游问烦"：
 *
 *  1. **只问缺的**：档案里这个群里已经有名字就不问（缓存 TTL 之上再加一层判断）。
 *  2. **冷却与限流**：同一个 (群, 人) 冷却期内只问一次（默认 6 小时，落盘，重启
 *     也不重问）；一条消息最多问几个人；队列有上限，满了就丢。
 *  3. **实测不支持就停手**：实现端回"不支持"（`1404`/`code 100`/注册表结论）
 *     时整个解析器停机——继续问只会每次都白等一次超时。
 *
 * 刻意不做的事：不猜名字（拿不到就继续显示 QQ）、不问没被提到的陌生人
 * （那会变成群体画像采集）、不改写已经渲染好的那条消息（下一句自然就对了）。
 */

import { nameIn } from './profile.js';

/** 同一个 (群, 人) 的默认冷却：6 小时。 */
export const DEFAULT_MEMBER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** 落盘的尝试账本最多留多少条（超出按时间最老的丢）。 */
export const MAX_ATTEMPTS = 500;

/**
 * 从事件里挑出"被 @ 到"的 QQ（不含自己、不含 @全体）。
 *
 * @param {object} event OneBot 群消息事件
 * @param {{ selfId?: string }} [opts]
 * @returns {string[]} 去重后的 QQ 字符串
 */
export function atTargets(event, { selfId = '' } = {}) {
  const segments = Array.isArray(event?.message) ? event.message : [];
  const self = String(selfId ?? '');
  const out = [];
  for (const seg of segments) {
    if (seg?.type !== 'at') continue;
    const raw = seg?.data?.qq;
    const qq = String(raw ?? '');
    if (!qq || qq === 'all' || qq === '0' || qq === self) continue;
    if (!/^\d+$/.test(qq)) continue;
    if (!out.includes(qq)) out.push(qq);
  }
  return out;
}

/** 群里的成员名（群名片优先于昵称），拿不到回 null。 */
export function cardName(data) {
  if (!data || typeof data !== 'object') return null;
  const name = data.card || data.nickname;
  return name ? String(name) : null;
}

/** `成员解析` 的落盘键：一个 (群, 人) 一行。 */
export function attemptFile() {
  return 'members/attempts.json';
}

export class MemberResolver {
  /**
   * @param {object} opts
   * @param {object} [opts.profile] `Profiles` 实例（只为读名字）
   * @param {(action: string, params: object) => Promise<object>} [opts.callAction] 走 hub 的能力面
   * @param {(msg: string) => void} [opts.log]
   * @param {object} [opts.storage] `JsonStore`（冷却账本落盘；关了也能用，只是重启会重问）
   * @param {boolean} [opts.enabled]
   * @param {number} [opts.cooldownMs]
   * @param {number} [opts.maxPerMessage]
   * @param {number} [opts.maxQueue]
   * @param {() => number} [opts.now]
   */
  constructor({
    profile = null,
    callAction = null,
    log = () => {},
    storage = null,
    enabled = true,
    cooldownMs = DEFAULT_MEMBER_COOLDOWN_MS,
    maxPerMessage = 5,
    maxQueue = 50,
    now = Date.now,
  } = {}) {
    this.profile = profile;
    this.callAction = callAction;
    this.log = typeof log === 'function' ? log : () => {};
    this.storage = storage;
    this.enabled = enabled !== false;
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.maxPerMessage = Math.max(1, Number(maxPerMessage) || 5);
    this.maxQueue = Math.max(1, Number(maxQueue) || 50);
    this.now = typeof now === 'function' ? now : Date.now;
    this.file = storage?.enabled ? attemptFile() : null;

    /** @type {Map<string, number>} `群:人` → 上次问的时间 */
    this.attempts = new Map(this.#readAttempts());
    this.queue = [];
    this.queued = new Set();
    this.running = null;
    this.supported = true;
    this.stats = {
      enabled: this.enabled,
      supported: true,
      queued: 0,
      asked: 0,
      learned: 0,
      failed: 0,
      skipped: 0,
      dropped: 0,
      pending: 0,
      cooldownMs: this.cooldownMs,
      lastError: null,
      lastAt: null,
      file: this.file,
    };
  }

  #readAttempts() {
    if (!this.storage?.enabled) return [];
    try {
      const data = this.storage.read(this.file, null);
      const rows = Array.isArray(data?.attempts) ? data.attempts : [];
      return rows.filter((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string').map(([k, v]) => [k, Number(v) || 0]);
    } catch (err) {
      this.log(`成员解析：冷却账本读不回来（不影响使用）：${err?.message ?? err}`);
      return [];
    }
  }

  #persist() {
    if (!this.file) return;
    try {
      const rows = [...this.attempts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ATTEMPTS);
      this.storage.schedule(this.file, () => ({ version: 1, savedAt: this.now(), attempts: rows }));
    } catch (err) {
      this.log(`成员解析：冷却账本落盘失败（只记日志）：${err?.message ?? err}`);
    }
  }

  /** 这个群里是不是已经有名字了。 */
  knownName(groupId, userId) {
    const scope = `group:${groupId}`;
    try {
      const person = this.profile?.person?.(userId);
      if (!person) return null;
      return nameIn(person, scope) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 观测一条事件：把"被 @ 到但还没名字"的人排进队列（不等待）。
   *
   * @param {object} event
   * @returns {number} 这次真正入队的条数
   */
  note(event, { selfId = '' } = {}) {
    if (!this.enabled || !this.supported || !this.callAction) return 0;
    if (event?.post_type !== 'message' || event?.message_type !== 'group') return 0;
    const groupId = String(event?.group_id ?? '');
    if (!groupId) return 0;
    const targets = atTargets(event, { selfId });
    if (!targets.length) return 0;

    let added = 0;
    for (const userId of targets) {
      if (added >= this.maxPerMessage) break;
      if (this.knownName(groupId, userId)) continue;
      const key = `${groupId}:${userId}`;
      if (this.queued.has(key)) continue;
      const last = this.attempts.get(key) ?? 0;
      if (last && this.now() - last < this.cooldownMs) {
        this.stats.skipped += 1;
        continue;
      }
      if (this.queue.length >= this.maxQueue) {
        this.stats.dropped += 1;
        continue;
      }
      this.queue.push({ groupId, userId, key });
      this.queued.add(key);
      added += 1;
    }
    this.stats.queued += added;
    this.stats.pending = this.queue.length;
    return added;
  }

  /**
   * 把队列里的问题一个个问完（串行，一次一问；已经在跑就复用同一个 Promise）。
   *
   * @returns {Promise<{asked:number, learned:number, failed:number}>}
   */
  pump() {
    if (this.running) return this.running;
    const job = (async () => {
      const out = { asked: 0, learned: 0, failed: 0 };
      while (this.queue.length) {
        if (!this.enabled || !this.supported || !this.callAction) break;
        const item = this.queue.shift();
        this.queued.delete(item.key);
        this.stats.pending = this.queue.length;
        // 先记账再问：失败了也要冷却，免得坏掉的实现端被无限重试。
        this.attempts.set(item.key, this.now());
        const at = this.now();
        this.stats.asked += 1;
        this.stats.lastAt = at;
        out.asked += 1;
        let result = null;
        try {
          result = await this.callAction('get_group_member_info', { group_id: item.groupId, user_id: item.userId });
        } catch (err) {
          result = { ok: false, retcode: 1200, note: String(err?.message ?? err) };
        }
        const name = result?.ok ? cardName(result.data) : null;
        if (result?.ok && name) {
          this.stats.learned += 1;
          out.learned += 1;
          this.log(`成员解析：问到了 ${item.groupId} 群里的 ${item.userId} 叫「${name}」（下一句起就能叫名字了）`);
        } else {
          this.stats.failed += 1;
          out.failed += 1;
          this.stats.lastError = result?.note ?? result?.msg ?? `retcode ${result?.retcode ?? '未知'}`;
          // 实测不支持就停机：继续问只是每次白等一次超时（§22.1-3）。
          if (isUnsupported(result)) {
            this.supported = false;
            this.stats.supported = false;
            this.stats.dropped += this.queue.length;
            this.queue = [];
            this.queued.clear();
            this.stats.pending = 0;
            this.log(`成员解析：实现端不支持 get_group_member_info（${this.stats.lastError}），停机不再问`);
            break;
          }
        }
      }
      this.#persist();
      return out;
    })().finally(() => {
      this.running = null;
      this.stats.pending = this.queue.length;
    });
    this.running = job;
    return job;
  }

  /** 清空队列（停机/复位用）。 */
  clear() {
    const n = this.queue.length;
    this.queue = [];
    this.queued.clear();
    this.stats.pending = 0;
    return n;
  }

  snapshot() {
    return { ...this.stats, supported: this.supported, pending: this.queue.length, attempts: this.attempts.size };
  }
}

/** 这条失败到底算不算"实现端没有这个接口"。 */
export function isUnsupported(result) {
  if (!result || result.ok) return false;
  if (result.source === 'registry') return true;
  const text = String(result.note ?? result.msg ?? '');
  if (/不支持|not support|unsupported|unknown action|找不到/i.test(text)) return true;
  const code = Number(result.retcode);
  return code === 1404 || code === 100;
}
