/**
 * 按会话的**盘点 / 导出 / 清理**（审查报告"按会话清理与导出数据"，`m85685`）。
 *
 * 为什么需要它：数据散在六处，各自都只认自己的键——
 *   ① 原文（`recall`，按 `sessionKey` 落日文件）② 媒体（按 sha256 落 blob，带会话归属集合）
 *   ③ 记忆条目（`store`，条目自带 `scope`）④ 活跃层（`active`，按 `originScope`）
 *   ⑤ 定时任务（`tasks`，按 `target` / `createdBy`）⑥ 人物与群档案（`profiles`，按 scope 的那一格）
 * 少删一处，"删过的数据"就会从另一处冒出来；少导出一样，迁移过去就是缺胳膊少腿。
 * 还有一处不算"数据"但同样会漏：**内存里的副本**（时间线环、捕获账本、每会话的批次窗口与
 * 唤醒状态，复审 F07）——盘上删干净了、重启前却还看得见，那种"删了没删"最让人不放心。
 *
 * 三条纪律：
 * - **删除必须是两步**：先 `inventory`（或 `purge({ dryRun:true })`）看数，再带 `confirm`
 *   （值必须**正好等于**会话键，防手滑）才真删。
 * - **导出是只读的**，产物落在 `<storageDir>/exports/`，回执给路径与条数，不回内容本身
 *   （一包 base64 能撑爆回执，也撑爆上下文）。
 * - 四家 store 的删除是各自实现的（`recall.purgeSession` / `media.purgeScope` /
 *   `tasks.purgeScope` / `profiles.forgetScope`），这里只做编排与对账，不自己动文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeName } from '../storage.js';

const scopeOf = (raw) => String(raw ?? '').trim();

const keysOf = (row) => {
  const keys = Array.isArray(row?.sessionKeys) && row.sessionKeys.length
    ? row.sessionKeys
    : [row?.sessionKey];
  return keys.map((k) => String(k ?? '')).filter(Boolean);
};

export class SessionData {
  constructor({ hub, log = () => {} } = {}) {
    this.hub = hub ?? null;
    this.log = log;
  }

  get enabled() {
    return Boolean(this.hub);
  }

  #recall() {
    return this.hub?.recall ?? null;
  }

  #media() {
    return this.hub?.media ?? null;
  }

  #memory() {
    return this.hub?.store ?? null;
  }

  #active() {
    return this.hub?.active ?? null;
  }

  #tasks() {
    return this.hub?.tasks ?? null;
  }

  #profiles() {
    return this.hub?.profiles ?? null;
  }

  /** 会话键形状校验：这里只认 `group:<数字>` / `private:<数字>`，别的一律当"写错了"。 */
  static normalKey(raw) {
    const key = scopeOf(raw);
    return /^(group|private):\d+$/.test(key) ? key : '';
  }

  /** 盘点：每一处有多少条属于这个会话。数不出来的一律给 `null`，不拿 0 冒充"没有"。 */
  async inventory(raw) {
    const scope = scopeOf(raw);
    const key = SessionData.normalKey(scope);
    if (!key) return { ok: false, error: `会话键要写成 group:<群号> 或 private:<QQ号>，收到的是「${scope || '空'}」`, scope };

    const out = {
      ok: true, scope: key,
      recall: null, media: null, memory: null, active: null, tasks: null, persons: null, group: null, live: null,
    };
    try {
      const recall = this.#recall();
      if (recall) {
        const pre = await recall.purgeSession(key, { dryRun: true });
        out.recall = pre?.ok ? pre.rows : null;
      }
    } catch (err) {
      this.log(`[ops] 盘点原文失败：${err?.message ?? err}`);
    }
    try {
      const media = this.#media();
      if (media) {
        const pre = await media.purgeScope(key, { dryRun: true });
        out.media = pre?.ok ? pre.refs : null;
      }
    } catch (err) {
      this.log(`[ops] 盘点媒体失败：${err?.message ?? err}`);
    }
    try {
      const store = this.#memory();
      if (store) out.memory = store.query({ scope: key, limit: 100000 }).length;
    } catch (err) {
      this.log(`[ops] 盘点记忆失败：${err?.message ?? err}`);
    }
    try {
      const active = this.#active();
      if (active) out.active = active.all().filter((e) => String(e?.originScope ?? '') === key).length;
    } catch (err) {
      this.log(`[ops] 盘点活跃层失败：${err?.message ?? err}`);
    }
    try {
      const tasks = this.#tasks();
      if (tasks) {
        const pre = await tasks.purgeScope(key, { dryRun: true });
        out.tasks = pre?.ok ? pre.removed : null;
      }
    } catch (err) {
      this.log(`[ops] 盘点任务失败：${err?.message ?? err}`);
    }
    try {
      const profiles = this.#profiles();
      if (profiles) {
        out.persons = profiles.persons().filter((p) => p?.groups && p.groups[key]).length;
        const g = profiles.groups().find((rec) => String(rec?.worldKey ?? '') === key);
        out.group = g ? 1 : 0;
      }
    } catch (err) {
      this.log(`[ops] 盘点档案失败：${err?.message ?? err}`);
    }
    try {
      // 内存里的副本也报个数：删除会连它一起清（复审 F07），盘算时得看得见。
      const ring = this.hub?.timeline?.bySession?.(key)?.length ?? null;
      const captured = (this.hub?.capture?.list?.({ sessionKey: key, limit: 100000 }) ?? []).length;
      out.live = ring === null ? null : ring + captured;
    } catch (err) {
      this.log(`[ops] 盘点内存副本失败：${err?.message ?? err}`);
    }
    return out;
  }

  /**
   * 导出一份可搬走的包。
   *
   * 里面有什么：原文索引行（含 `ref`，要全文可以再取）、媒体的元信息与 blob 路径
   * （**不带字节**：一包 base64 又大又没用，真要搬图就搬整个 `media/blobs` 目录）、
   * 记忆条目、活跃层、任务、以及这个会话在人物档案里的那一格。
   */
  async exportBundle(raw) {
    const scope = scopeOf(raw);
    const key = SessionData.normalKey(scope);
    if (!key) return { ok: false, error: `会话键要写成 group:<群号> 或 private:<QQ号>，收到的是「${scope || '空'}」` };
    const now = Date.now();
    const bundle = { version: 1, scope: key, exportedAt: new Date(now).toISOString(), counts: {}, recall: [], media: [], memory: [], active: [], tasks: [], profiles: {} };
    try {
      const recall = this.#recall();
      if (recall) {
        const idx = await recall.rawIndex({ sessionKey: key, limit: 100000 });
        bundle.recall = idx?.entries ?? [];
        bundle.counts.recall = bundle.recall.length;
      }
    } catch (err) {
      bundle.counts.recall = null;
      this.log(`[ops] 导出原文失败：${err?.message ?? err}`);
    }
    try {
      const media = this.#media();
      if (media) {
        await media.ensureIndex?.();
        bundle.media = media
          .list({ limit: 100000, allow: (row) => keysOf(row).includes(key) })
          .map((row) => media.visibleRef?.(row, { allow: (home) => home === key, preferred: key }) ?? row)
          .map((row) => ({
            id: row.id,
            name: row.name ?? null,
            mediaType: row.mediaType ?? null,
            bytes: row.bytes ?? null,
            at: row.at ?? null,
            sha256: row.sha256 ?? null,
            sessionKeys: keysOf(row),
            blob: row.blob ?? null,
          }));
        bundle.counts.media = bundle.media.length;
      }
    } catch (err) {
      bundle.counts.media = null;
      this.log(`[ops] 导出媒体失败：${err?.message ?? err}`);
    }
    try {
      const store = this.#memory();
      if (store) {
        bundle.memory = store.query({ scope: key, limit: 100000 });
        bundle.counts.memory = bundle.memory.length;
      }
    } catch (err) {
      bundle.counts.memory = null;
      this.log(`[ops] 导出记忆失败：${err?.message ?? err}`);
    }
    try {
      const active = this.#active();
      if (active) {
        bundle.active = active.all().filter((e) => String(e?.originScope ?? '') === key);
        bundle.counts.active = bundle.active.length;
      }
    } catch (err) {
      bundle.counts.active = null;
      this.log(`[ops] 导出活跃层失败：${err?.message ?? err}`);
    }
    try {
      const tasks = this.#tasks();
      if (tasks) {
        bundle.tasks = tasks.list({ all: true }).filter((t) => String(t?.target ?? '') === key || String(t?.createdBy ?? '') === key);
        bundle.counts.tasks = bundle.tasks.length;
      }
    } catch (err) {
      bundle.counts.tasks = null;
      this.log(`[ops] 导出任务失败：${err?.message ?? err}`);
    }
    try {
      const profiles = this.#profiles();
      if (profiles) {
        const persons = profiles.persons()
          .filter((p) => p?.groups && p.groups[key])
          .map((p) => ({ userId: p.userId ?? null, name: p.names?.[0]?.name ?? null, slot: p.groups[key] }));
        const group = profiles.groups().find((rec) => String(rec?.worldKey ?? '') === key) ?? null;
        bundle.profiles = { persons, group };
        bundle.counts.persons = persons.length;
        bundle.counts.group = group ? 1 : 0;
      }
    } catch (err) {
      bundle.counts.persons = null;
      this.log(`[ops] 导出档案失败：${err?.message ?? err}`);
    }

    // `JsonStore.write` 自己会 `JSON.stringify`，所以这里交**对象**而不是先拼好的字符串
    // （先拼再写会变成双重编码：文件里是一整条带引号的字符串，读回来 `scope` 是 undefined）。
    const storage = this.hub?.storage;
    const bytes = Buffer.byteLength(JSON.stringify(bundle, null, 2));
    let file = '';
    if (storage?.enabled) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const name = `exports/${safeName(key)}-${stamp}.json`;
      if (storage.write(name, bundle)) {
        await storage.flush?.();
        file = storage.path(name);
      }
    }
    return { ok: true, scope: key, file, bytes, counts: bundle.counts };
  }

  /**
   * 真删。`confirm` 必须**正好等于**会话键——这一步是不可逆的，防手滑比防误用重要。
   * 返回值逐项报"删了多少"，删不掉的也点名（不吞）。
   */
  async purge(raw, { confirm = '' } = {}) {
    const scope = scopeOf(raw);
    const key = SessionData.normalKey(scope);
    if (!key) return { ok: false, error: `会话键要写成 group:<群号> 或 private:<QQ号>，收到的是「${scope || '空'}」` };
    if (String(confirm ?? '').trim() !== key) {
      return { ok: false, error: `这是不可逆的删除。确认要把「${key}」的数据整段删掉，就把会话键原样填进 confirm 再试一次。` };
    }
    const mind = this.hub?.mind;
    let liveCleared = 0;
    try { liveCleared = mind?.beginPurge ? await mind.beginPurge(key) : (mind?.forgetSession?.(key) ?? 0); }
    catch (err) { return { ok: false, scope: key, error: String(err?.message ?? err), failed: [{ where: 'quiesce', error: String(err?.message ?? err) }] }; }
    try {
    const removed = {
      recall: null, media: null, memory: null, active: null, tasks: null, persons: null, group: null,
      timeline: null, capture: null, mind: liveCleared, cards: null, failures: null, topics: null,
    };
    const failed = [];
    // 原文还在时才查得到事件归属，必须早于 recall.purgeSession。
    try {
      await this.#recall()?.ensure?.();
      const profiles = this.#profiles();
      removed.topics = profiles?.forgetTopicScope?.(key, (id) => {
        const row = this.hub?.timeline?.byId?.(id) ?? this.#recall()?.byId?.(id) ?? this.#recall()?.byMessage?.(id);
        return row?.sessionKey ?? row?.refs?.sessionKey ?? this.#recall()?.sessionOf?.(id) ?? '';
      }) ?? null;
    } catch (err) { failed.push({ where: 'topics', error: String(err?.message ?? err) }); }
    try {
      const recall = this.#recall();
      if (recall) {
        const r = await recall.purgeSession(key);
        removed.recall = r?.ok ? r.rows : null;
        if (!r?.ok) failed.push({ where: 'recall', error: r?.error ?? '未知原因' });
      }
    } catch (err) {
      failed.push({ where: 'recall', error: String(err?.message ?? err) });
    }
    try {
      const media = this.#media();
      if (media) {
        const r = await media.purgeScope(key);
        removed.media = r?.ok ? r.refs : null;
        if (!r?.ok) failed.push({ where: 'media', error: r?.error ?? '未知原因' });
      }
    } catch (err) {
      failed.push({ where: 'media', error: String(err?.message ?? err) });
    }
    try {
      const store = this.#memory();
      if (store) {
        const hit = store.query({ scope: key, limit: 100000 });
        let n = 0;
        for (const entry of hit) if (store.remove(entry.id)) n += 1;
        removed.memory = n;
      }
    } catch (err) {
      failed.push({ where: 'memory', error: String(err?.message ?? err) });
    }
    try {
      const active = this.#active();
      if (active) {
        const hit = active.all().filter((e) => String(e?.originScope ?? '') === key);
        let n = 0;
        for (const entry of hit) if (active.remove(entry.id)) n += 1;
        removed.active = n;
      }
    } catch (err) {
      failed.push({ where: 'active', error: String(err?.message ?? err) });
    }
    try {
      const tasks = this.#tasks();
      if (tasks) {
        const r = await tasks.purgeScope(key);
        removed.tasks = r?.ok ? r.removed : null;
        for (const f of r?.failed ?? []) failed.push({ where: `task:${f.id}`, error: f.error });
      }
    } catch (err) {
      failed.push({ where: 'tasks', error: String(err?.message ?? err) });
    }
    try {
      const profiles = this.#profiles();
      if (profiles) {
        const r = profiles.forgetScope(key);
        removed.persons = r?.persons ?? null;
        removed.group = r?.groups ?? null;
      }
    } catch (err) {
      failed.push({ where: 'profiles', error: String(err?.message ?? err) });
    }
    try {
      /**
       * 内存副本（复审 F07）：时间线环、捕获账本、每会话的批次窗口/唤醒状态/失败队列。
       * 这三处不清，重启前 `onebot_timeline`、快照、回复缓冲还带着这个会话的影子。
       */
      removed.timeline = this.hub?.timeline?.dropSession?.(key) ?? 0;
      removed.capture = this.hub?.capture?.dropSession?.(key) ?? 0;
      // 旧回合已经在任何删盘操作之前停稳，不在这里再退役新一代。
    } catch (err) {
      failed.push({ where: 'memory-live', error: String(err?.message ?? err) });
    }
    /**
     * 会话卡与失败队列（第三轮复审 T10）：这两处不在 `storage` 的按会话清单里，
     * 但都存着**原话**——卡里是"刚才在聊什么"，队列里是"那句话没发出去时是什么"。
     * 用户点"删掉这个会话"时，这两份是最直观的残留。
     */
    try {
      const cards = this.hub?.cards;
      if (cards?.forgetScope) removed.cards = cards.forgetScope(key);
    } catch (err) {
      failed.push({ where: 'cards', error: String(err?.message ?? err) });
    }
    try {
      const failures = this.hub?.failures;
      if (failures?.forgetScope) removed.failures = failures.forgetScope(key);
    } catch (err) {
      failed.push({ where: 'failures', error: String(err?.message ?? err) });
    }
    this.log(`[ops] 按会话清理完成：${key} ${JSON.stringify(removed)}${failed.length ? ` 失败 ${failed.length} 项` : ''}`);
    return { ok: failed.length === 0, scope: key, removed, failed };
    } finally { mind?.endPurge?.(key); }
  }

  /** 导出产物列表（设置页用）：只报文件名与大小，不读内容。 */
  exports() {
    const storage = this.hub?.storage;
    if (!storage?.enabled) return [];
    const dir = path.join(storage.dir, 'exports');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((name) => {
        const full = path.join(dir, name);
        const st = fs.statSync(full, { throwIfNoEntry: false });
        return { name, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0 };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 20);
  }
}

export const DEFAULT_OPS_LIMITS = { maxExportBytes: 32 * 1024 * 1024 };
