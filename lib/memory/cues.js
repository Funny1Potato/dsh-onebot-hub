/**
 * 主动回忆（§24.6/§24.7，M18）：代码只交**事实**，说不说由模型定。
 *
 * 这是 M18 的硬边界，值得写在最前面：
 *  - 原设计里的"规则化触发 + 指数退避定时器"已经删掉。代码不做"现在该提醒他了"这种判断——
 *    那种判断需要懂语境，规则做不好只会变成每隔 20 分钟复读一遍的催命机器人。
 *  - 代码只干三件事：① 找出还没兑现的承诺（客观事实）；② 附上"多久前提的""这人上次露面是什么时候"；
 *    ③ 一个防骚扰安全阀——同一条承诺 24 小时内最多进一次 prompt。
 *  - 因此这里产出的每一条都是**陈述句**，不是命令。渲染层（`assembler.renderCues`）也不许写"该提醒他了"。
 *
 * 衰减（`lib/memory/decay.js`）在这里只影响**排序与去留**：低强度不等于删除，数据一直在档案里。
 */

import { isVisible } from './isolation.js';
import { nameIn } from '../profile.js';

export const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
export const DEFAULT_LIMIT = 5;

const DAY = 24 * 3600 * 1000;

/** 同一条承诺的稳定标识：同一个人的同一句话只提醒一次。 */
export function cueKey(userId, what) {
  const text = String(what ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${String(userId ?? '')}:${text}`;
}

/**
 * 从人物档案里挑出"还没兑现的承诺"。
 *
 * 隔离**必须**在这里再生效一次：承诺是跨会话的档案，某个群里答应过的事不该在另一个群里被提起。
 * 判据与记忆条目完全一致（复用 `isVisible`），所以不会出现"记忆看不住、承诺漏出去"这种不对称。
 *
 * @param {{persons?:Array, sessionKey:string, worldKey?:string, actorId?:any, isolation?:object,
 *          now?:number, limit?:number}} input
 */
export function collectCues({ persons = [], sessionKey, worldKey, actorId, isolation, now = Date.now(), limit = DEFAULT_LIMIT } = {}) {
  const scope = worldKey ?? sessionKey;
  const cues = [];
  for (const person of persons) {
    if (!person || person.userId === undefined || person.userId === null) continue;
    const g = person.groups?.[scope] ?? person.groups?.[sessionKey] ?? null;
    const lastSeenAt = Number(g?.lastSentAt ?? person.relationship?.lastInteractAt ?? 0) || null;
    const name = nameIn(person, scope) ?? nameIn(person, sessionKey) ?? String(person.userId);
    for (const c of person.commitments ?? []) {
      if (c?.status !== 'open') continue;
      const what = String(c.what ?? '').replace(/\s+/g, ' ').trim();
      if (!what) continue;
      const verdict = isVisible(
        {
          kind: 'fact',
          scope: c.scope ?? null,
          worldKey: c.worldKey ?? null,
          text: what,
          actor: c.actor ?? { user_id: person.userId },
        },
        { sessionKey, worldKey, actorId, isolation },
      );
      if (!verdict.ok) continue;
      const due = c.due ? Number(c.due) : null;
      cues.push({
        key: cueKey(person.userId, what),
        kind: 'commitment',
        userId: String(person.userId),
        name,
        what,
        due: Number.isFinite(due) ? due : null,
        overdueDays: due ? Math.floor((now - due) / DAY) : null,
        lastMentionedAt: c.lastMentionedAt ?? null,
        lastSeenAt,
        strength: typeof c.strength === 'number' ? c.strength : null,
        reason: verdict.reason,
      });
    }
  }
  // 越过期越靠前；没有截止时间的排在有截止时间的后面（"答应过"本身也有价值，但别挤掉过期的）。
  cues.sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));
  return cues.slice(0, Math.max(1, limit));
}

/**
 * 防骚扰安全阀：同一条承诺 24 小时内最多进一次 prompt。
 *
 * 只记"已经注入过"，不做定时器、不主动发起——它只回答"这条现在能不能再进 prompt"。
 * 落盘是**顺带**的（`storage.schedule`），所以它坏了顶多是重启后多提醒一次，不会挡住回复。
 */
export class Reminders {
  #items = new Map();
  #file = 'reminders.json';
  #injected = 0;

  constructor({ storage = null, log, windowMs = DEFAULT_WINDOW_MS, max = 200 } = {}) {
    this.storage = storage;
    this.log = log ?? (() => {});
    this.windowMs = windowMs === 0 ? 0 : Math.max(60_000, Number(windowMs) || DEFAULT_WINDOW_MS);
    this.max = Math.max(1, Number(max) || 200);
    const raw = storage?.read?.(this.#file, null) ?? null;
    for (const row of raw?.items ?? []) {
      const key = String(row?.key ?? '');
      if (!key) continue;
      this.#items.set(key, { at: Number(row.at) || 0, count: Number(row.count) || 1 });
    }
  }

  get enabled() {
    return Boolean(this.storage?.enabled);
  }

  get stats() {
    return { enabled: this.enabled, windowHours: Math.round(this.windowMs / 3600000), tracked: this.#items.size, injected: this.#injected, file: this.storage?.path?.(this.#file) ?? null };
  }

  /** 这条承诺现在能不能再进 prompt（`at` 为空表示从没提过）。 */
  canAsk(key, now = Date.now()) {
    if (this.windowMs === 0) return true;
    const rec = this.#items.get(String(key ?? ''));
    if (!rec) return true;
    return now - rec.at >= this.windowMs;
  }

  /** 冷却中的条目直接滤掉，其余原样返回（顺序不变）。 */
  filter(cues = [], now = Date.now()) {
    return cues.filter((c) => this.canAsk(c?.key, now));
  }

  /** 记下"这条进过 prompt 了"。 */
  note(cues = [], now = Date.now()) {
    const list = Array.isArray(cues) ? cues : [cues];
    for (const c of list) {
      const key = String(c?.key ?? '');
      if (!key) continue;
      const rec = this.#items.get(key) ?? { at: 0, count: 0 };
      this.#items.set(key, { at: now, count: rec.count + 1 });
      this.#injected += 1;
    }
    // 超出上限丢最旧的（提醒账本本身不值得占地方）。
    if (this.#items.size > this.max) {
      const sorted = [...this.#items.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
      for (const [key] of sorted.slice(0, this.#items.size - this.max)) this.#items.delete(key);
    }
    this.storage?.schedule?.(this.#file, () => ({ version: 1, savedAt: Date.now(), items: [...this.#items.entries()].map(([key, v]) => ({ key, at: v.at, count: v.count })) }));
    return this.#items.size;
  }

  /** 清空冷却记录（测试与排障用；正常不该动它）。 */
  clear() {
    const n = this.#items.size;
    this.#items.clear();
    this.#injected = 0;
    this.storage?.write?.(this.#file, { version: 1, savedAt: Date.now(), items: [] });
    return n;
  }
}
