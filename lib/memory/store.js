/**
 * 记忆条目的内存存储（L1/L2 之间的落盘层的最小实现）。
 *
 * 关键契约（§24.5 / §24.11）：
 *  - **写入永远全量**：不管隔离多严，条目都照常进来；隔离只影响"装配时能看见什么"。
 *  - 条目的 `scope`/`visibility` 由写入侧推断，模型不能自行升格。
 *  - **同一条只留一条**：`add` 是"也许该记一条"，不是"追加一行"。代码侧每轮都会把观测到的
 *    身份喂进来（`buildObservedEntries`），模型也可能反复说同一件事——不去重的话库会随轮数
 *    线性膨胀（真机上同一个人的身份条目堆过 3 条）。`modify` 仍是模型修正既有条目的正道。
 */

import { inferScope, inferVisibility, isSensitive } from './isolation.js';

let seq = 0;
const nextId = () => `m${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

/** 比较"是不是同一条"时用的文本：折叠空白、去掉首尾。**存进库里的仍是原文**。 */
export function normalizeMemoryText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 去重键：同 `kind` + 同 `scope` + 同 `worldKey` + 同说话人 + 同文本 = 同一条。
 *
 * `scope` 必须进键——同一句话在另一个群学会的属于另一条（可见性边界不同）；
 * 说话人也必须进键——"他说他喜欢辣"和"她说她喜欢辣"不是一条。
 */
export function memoryDedupeKey(rec = {}) {
  return [
    rec.kind ?? 'fact',
    rec.scope ?? '',
    rec.worldKey ?? '',
    rec.actor?.user_id ?? '',
    normalizeMemoryText(rec.text),
  ].join('\u0000');
}

export class MemoryStore {
  #entries = [];
  #byId = new Map();
  #byKey = new Map();
  #limit;

  /**
   * @param {{limit?:number, storage?:object, log?:Function, file?:string}} [opts]
   *   `storage` 是 `JsonStore`（`dir === ''` 即不落盘）。落盘是**合并写**：写记忆的频率
   *   跟着聊天走，逐次落盘等于把磁盘当内存用（§24.10）。
   */
  constructor({ limit = 5000, storage = null, log, file = 'memory/store.json' } = {}) {
    this.#limit = limit;
    this.storage = storage ?? null;
    this.file = String(file);
    this.log = log ?? (() => {});
    this.loaded = 0;
    this.loadedAt = null;
    /** 被折叠掉的重复写入次数（`add` 命中已有条目）。 */
    this.deduped = 0;
    /** 读回时折叠掉的历史重复条数（修复前落盘的文件会带进来）。 */
    this.collapsed = 0;
    const data = this.storage?.read?.(this.file, null);
    if (data && Array.isArray(data.entries)) {
      for (const raw of data.entries) this.#hydrate(raw);
      this.loaded = this.#entries.length;
      this.loadedAt = this.loaded ? Date.now() : null;
      if (!this.loaded) this.#entries = [];
      if (this.collapsed) this.log(`[memory] 读回时折叠了 ${this.collapsed} 条重复记忆（同 kind/scope/世界/说话人/文本只留最早那条）`);
      // 新 id 不能被重启前用过的编号撞上（id 里带时间戳，但计数器也要接着走）。
      seq += this.loaded;
    }
  }

  get stats() {
    const kinds = {};
    for (const e of this.#entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return {
      total: this.#entries.length,
      byKind: kinds,
      scopes: new Set(this.#entries.map((e) => e.scope)).size,
      persistent: Boolean(this.storage?.enabled),
      file: this.storage?.enabled ? this.storage.path(this.file) : null,
      loaded: this.loaded,
      loadedAt: this.loadedAt,
      deduped: this.deduped,
      collapsed: this.collapsed,
    };
  }

  /** 落盘用的形状：真相就是这一份（重建/读回都用它，不另存索引）。 */
  toJSON() {
    return { version: 1, savedAt: Date.now(), entries: this.#entries.map((e) => ({ ...e })) };
  }

  /** 读回来的一条：字段不合法就跳过（一行脏数据不该废掉整份记忆）。 */
  #hydrate(raw) {
    if (!raw || !raw.id || typeof raw.text !== 'string') return false;
    const id = String(raw.id);
    if (this.#byId.has(id)) return false;
    const rec = {
      id,
      ts: Number(raw.ts) || Date.now(),
      kind: raw.kind ?? 'fact',
      scope: raw.scope ?? 'private',
      worldKey: raw.worldKey ?? null,
      actor: raw.actor ?? null,
      text: raw.text,
      refs: raw.refs ?? null,
      strength: Number(raw.strength ?? 1),
      source: raw.source ?? 'observe',
    };
    if (raw.visibility !== undefined) rec.visibility = raw.visibility;
    if (raw.sensitive !== undefined) rec.sensitive = raw.sensitive;
    if (raw.modifiedAt !== undefined) rec.modifiedAt = raw.modifiedAt;
    if (raw.corrected !== undefined) rec.corrected = raw.corrected;
    // 历史文件里可能已经堆了重复（修复前每轮观测都会加一条）：读回时就折掉，不再等到下次写。
    const key = memoryDedupeKey(rec);
    const existing = normalizeMemoryText(rec.text) ? this.#byKey.get(key) : null;
    if (existing) {
      if (!existing.refs && rec.refs) existing.refs = rec.refs;
      if (existing.sensitive === undefined && rec.sensitive !== undefined) existing.sensitive = rec.sensitive;
      this.collapsed += 1;
      return false;
    }
    this.#entries.push(rec);
    this.#byId.set(rec.id, rec);
    if (normalizeMemoryText(rec.text)) this.#byKey.set(key, rec);
    return true;
  }

  /** 有改动就排队合并写（失败只记日志，绝不影响聊天链路）。 */
  #persist() {
    try {
      this.storage?.schedule?.(this.file, () => this.toJSON());
    } catch (err) {
      this.log(`[memory] 落盘排队失败：${err?.message ?? err}`);
    }
  }

  normalize(entry, ctx = {}) {
    const scope = entry.scope ?? inferScope({ sessionKey: ctx.sessionKey, worldKey: ctx.worldKey ?? entry.worldKey, actorId: entry.actor?.user_id });
    const out = {
      id: entry.id ?? nextId(),
      ts: entry.ts ?? Date.now(),
      kind: entry.kind ?? 'fact',
      scope,
      worldKey: entry.worldKey ?? ctx.worldKey ?? null,
      actor: entry.actor ?? null,
      text: entry.text ?? '',
      refs: entry.refs ?? null,
      strength: entry.strength ?? 1,
      sensitive: entry.sensitive ?? undefined,
      source: entry.source ?? 'observe',
    };
    out.visibility = inferVisibility({ ...entry, scope }, { sessionKey: scope });
    if (entry.sensitive === undefined) out.sensitive = isSensitive(out) || undefined;
    return out;
  }

  /**
   * 加一条记忆。**同一条只会有一条**（见 `memoryDedupeKey`）：命中已有条目时**返回那一条**，
   * 而不是报错——调用方不必知道"这条早就有了"，模型那边也不会以为自己写失败了。
   *
   * 想绕过合并（导入、测试里刻意造重复）传 `{dedupe: false}`。
   */
  add(entry, ctx = {}) {
    const rec = this.normalize(entry, ctx);
    const text = normalizeMemoryText(rec.text);
    if (ctx.dedupe !== false && text) {
      const key = memoryDedupeKey(rec);
      const existing = this.#byKey.get(key);
      if (existing) {
        // 补上这次带来的、原来缺的线索；`id`/`ts`/原文都不动（它就是这么记下的）。
        if (!existing.refs && rec.refs) existing.refs = rec.refs;
        if (existing.sensitive === undefined && rec.sensitive !== undefined) existing.sensitive = rec.sensitive;
        this.deduped += 1;
        this.#persist();
        return existing;
      }
      this.#byKey.set(key, rec);
    }
    this.#entries.push(rec);
    this.#byId.set(rec.id, rec);
    if (this.#entries.length > this.#limit) {
      const dropped = this.#entries.splice(0, this.#entries.length - this.#limit);
      let lostKey = false;
      for (const d of dropped) {
        this.#byId.delete(d.id);
        const key = memoryDedupeKey(d);
        if (this.#byKey.get(key) === d) {
          this.#byKey.delete(key);
          lostKey = true;
        }
      }
      if (lostKey) this.#rebuildIndex();
    }
    this.#persist();
    return rec;
  }

  addMany(list = [], ctx = {}) {
    return list.map((e) => this.add(e, ctx));
  }

  /**
   * 重建去重索引：**先到的那条占键**（和"读回时只留最早那条"同一个口径）。
   *
   * 用重建而不是"改一条就补一条"的增量维护，是因为 `modify` 可能把两条改成同一句话——
   * 那时一个键下有两条、而键只能指向一条；增量维护下的删除/裁剪会把键指向一条已经不存在的
   * 条目，于是下一次 `add` 又写出一个重复。整表重建在这种边角上不会骗人（条目数上限几千，
   * 而 `modify`/`remove` 每轮只有几条）。
   */
  #rebuildIndex() {
    this.#byKey.clear();
    for (const e of this.#entries) {
      const text = normalizeMemoryText(e.text);
      if (!text) continue;
      const key = memoryDedupeKey(e);
      if (!this.#byKey.has(key)) this.#byKey.set(key, e);
    }
  }

  /**
   * 改写一条已存在的记忆（§24.11：`modify` 优先于 `add`）。
   *
   * 为什么必须有它：模型"越改越准"的方式是**重写原来那句**，而不是再补一句新话。
   * 只给 `add` 的记忆库会随对话线性膨胀，最后谁也读不完。这里**不允许**改 `id`/`scope`/`visibility`
   * ——那三个是代码判定的边界，模型改不了。
   */
  modify(id, patch = {}, now = Date.now()) {
    const rec = this.#byId.get(String(id));
    if (!rec) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (['id', 'scope', 'visibility', 'sensitive'].includes(k)) continue;
      rec[k] = v;
    }
    if (patch.text !== undefined) rec.text = String(patch.text);
    rec.modifiedAt = now;
    this.#rebuildIndex();
    this.#persist();
    return rec;
  }

  /** 删掉一条记忆。数据只从**内存态**消失；L1 原始时间线里那句话仍然查得到（遗忘≠销毁）。 */
  remove(id) {
    const key = String(id);
    const idx = this.#entries.findIndex((e) => e.id === key);
    if (idx < 0) return null;
    const [rec] = this.#entries.splice(idx, 1);
    this.#byId.delete(key);
    this.#rebuildIndex();
    this.#persist();
    return rec;
  }

  all() {
    return [...this.#entries];
  }

  byId(id) {
    return this.#byId.get(id) ?? null;
  }

  query({ kind, worldKey, scope, actorId, visibility, limit = 100 } = {}) {
    return this.#entries
      .filter(
        (e) =>
          (kind === undefined || e.kind === kind) &&
          (worldKey === undefined || e.worldKey === worldKey) &&
          (scope === undefined || e.scope === scope) &&
          (visibility === undefined || e.visibility === visibility) &&
          (actorId === undefined || String(e.actor?.user_id ?? '') === String(actorId)),
      )
      .slice(-limit);
  }

  clear() {
    this.#entries = [];
    this.#byId.clear();
    this.#byKey.clear();
    this.#persist();
  }
}
