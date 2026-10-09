/**
 * L2 会话卡落盘（§24.10）。
 *
 * 为什么需要它：L1（聊天记录）是**只追加**的，启动时不回放进内存环。所以重启之后
 * `timeline.bySession()` 是空的 —— 检索索引还能搜到过去（那是 L1 + index.sqlite 的功劳），
 * 但**每一轮都要注入的会话卡与最近窗口会变成"最近 0 条消息"**：它认得出人、翻得到历史，
 * 却不知道刚才在聊什么。会话卡是唯一默认注入的记忆层，这一格空了，重启就等于失忆一分钟。
 *
 * 设计上刻意**不做回放**（把 jsonl 重新灌回内存环）：
 *  - 回放会把整条历史重新变成"现在"，模型会以为那些话是刚说的；
 *  - L1 会按上限裁掉、按天分文件，回放多少条是个说不清的量。
 * 所以这里只把**卡片本身**（参与者、最近若干行、时间戳）落盘，读回来时明确标注
 * "这是重启前留下的会话卡"，让它知道自己站在什么时候说话。
 *
 * 增量维护（每来一条消息就地更新），不做全量重算：会话卡每次装配都要用，
 * 每轮把上千条事件重压一遍是白烧 CPU。
 */

import { isForwardMirror } from '../capture.js';
import { safeName } from '../storage.js';
import { actorName, isMessageEntry, worldKeyOf } from './digest.js';

const MAX_IDS = 50;

function emptyCard(sessionKey, at = Date.now()) {
  return {
    version: 1,
    sessionKey: String(sessionKey ?? 'unknown'),
    worldKey: null,
    savedAt: at,
    updatedAt: at,
    firstTs: null,
    lastTs: null,
    messageCount: 0,
    participants: [],
    lines: [],
    ids: [],
  };
}

/** 一行"真在聊天里发生过的事"（转发镜像不算，否则同一条话会显示两遍）。 */
function isCardWorthy(entry) {
  if (!entry) return false;
  if (isForwardMirror(entry)) return false;
  // 发送失败的回复没说出口，不入卡（真机：failed 的回复在卡里存成"我：…"，
  // 还会落盘——重启之后模型照样以为自己说过）。时间线留着排查。
  if (entry.direction === 'hub-out' && entry.decision === 'failed') return false;
  if (isMessageEntry(entry)) return true;
  return typeof entry.action === 'string' && entry.action.startsWith('send');
}

export class Cards {
  #map = new Map();
  #dirty = new Set();
  #loaded = 0;
  #written = 0;
  #skipped = 0;
  #lastError = null;

  /**
   * @param {{storage?:object, dir?:string, log?:Function, maxSessions?:number,
   *          maxLines?:number, maxParticipants?:number, now?:Function}} [opts]
   *   `storage` 是 `JsonStore`；它关闭时本类退化成纯内存（重启即空，但不会报错）。
   */
  constructor({ storage = null, dir = 'cards', log, maxSessions = 200, maxLines = 40, maxParticipants = 12, now = Date.now } = {}) {
    this.storage = storage;
    this.dir = String(dir ?? 'cards');
    this.log = log ?? (() => {});
    this.maxSessions = Math.max(1, Number(maxSessions) || 200);
    this.maxLines = Math.max(1, Number(maxLines) || 40);
    this.maxParticipants = Math.max(1, Number(maxParticipants) || 12);
    this.now = typeof now === 'function' ? now : Date.now;
  }

  get enabled() {
    return Boolean(this.storage?.enabled);
  }

  get stats() {
    return {
      enabled: this.enabled,
      dir: this.enabled ? this.dir : null,
      cards: this.#map.size,
      loaded: this.#loaded,
      pending: this.#dirty.size,
      written: this.#written,
      skipped: this.#skipped,
      maxLines: this.maxLines,
      lastError: this.#lastError,
    };
  }

  get size() {
    return this.#map.size;
  }

  fileOf(sessionKey) {
    return `${this.dir}/${safeName(sessionKey)}.json`;
  }

  /**
   * 读回落盘的会话卡。构造时不自动调用（要等 `storage` 挂上），由 hub 显式调一次。
   * 坏文件跳过、不废整份目录——与 L1/记忆条目一个规矩。
   */
  load() {
    if (!this.enabled) return 0;
    const files = this.storage.list?.(this.dir) ?? [];
    let n = 0;
    for (const f of files) {
      let data;
      try {
        data = this.storage.read(`${this.dir}/${f}`, null);
      } catch {
        data = null;
      }
      if (!data || typeof data !== 'object' || !data.sessionKey) {
        this.#skipped += 1;
        continue;
      }
      const card = emptyCard(data.sessionKey, Number(data.updatedAt ?? data.savedAt ?? this.now()));
      card.worldKey = data.worldKey ?? null;
      card.savedAt = Number(data.savedAt ?? this.now());
      card.firstTs = data.firstTs ?? null;
      card.lastTs = data.lastTs ?? null;
      card.messageCount = Math.max(0, Number(data.messageCount ?? 0) || 0);
      card.participants = Array.isArray(data.participants) ? data.participants.slice(0, this.maxParticipants) : [];
      card.lines = Array.isArray(data.lines) ? data.lines.slice(-this.maxLines) : [];
      card.ids = Array.isArray(data.ids) ? data.ids.slice(-MAX_IDS).map(String) : [];
      this.#map.set(String(data.sessionKey), card);
      n += 1;
    }
    this.#loaded = n;
    if (n) this.log(`[cards] 载入 ${n} 张会话卡（重启之后至少还知道刚才在聊什么）`);
    this.#trim();
    return n;
  }

  /**
   * 增量记一笔。返回更新后的卡（不值得记的返回 null）。
   * 同一 entry.id 重复进来自动忽略——时间线里同一条消息可能有多个视角。
   */
  note(entry) {
    if (!isCardWorthy(entry)) return null;
    const sessionKey = String(entry.sessionKey ?? 'unknown');
    let card = this.#map.get(sessionKey);
    if (!card) {
      card = emptyCard(sessionKey, this.now());
      this.#map.set(sessionKey, card);
    }
    const id = String(entry.id ?? '');
    if (id && card.ids.includes(id)) return card;
    if (id) {
      card.ids.push(id);
      if (card.ids.length > MAX_IDS) card.ids.splice(0, card.ids.length - MAX_IDS);
    }
    const ts = Number(entry.ts ?? this.now());
    const uid = entry.actor?.user_id ?? entry.payload?.user_id ?? null;
    if (uid !== undefined && uid !== null) {
      let rec = card.participants.find((p) => String(p.user_id) === String(uid));
      if (!rec) {
        rec = { user_id: uid, nickname: entry.actor?.nickname ?? null, role: entry.actor?.role ?? null, count: 0, lastTs: 0 };
        card.participants.push(rec);
      }
      rec.count += 1;
      rec.lastTs = Math.max(Number(rec.lastTs ?? 0), ts);
      if (!rec.nickname && entry.actor?.nickname) rec.nickname = entry.actor.nickname;
      card.participants.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
      if (card.participants.length > this.maxParticipants) card.participants.length = this.maxParticipants;
    }
    // 文本不按字数截（m24155）：行数/条数限制（maxLines、MAX_IDS）保留，字数不砍。
    const text = String(entry.text ?? '');
    // 空行不入卡（A′ 后提不出文本的下游动作不该再有，这里兜底）：宁缺一行，不留空话——
    // 快照把它渲染出来就是一行只有时间戳和说话人的空话，模型读不出任何内容。
    if (text.trim()) card.lines.push({ id: id || undefined, ts, direction: entry.direction ?? null, actor: actorName(entry), text });
    if (card.lines.length > this.maxLines) card.lines.splice(0, card.lines.length - this.maxLines);
    card.messageCount += 1;
    card.firstTs = card.firstTs ?? ts;
    card.lastTs = ts;
    card.updatedAt = this.now();
    card.worldKey = card.worldKey ?? worldKeyOf(entry);
    this.#dirty.add(sessionKey);
    this.#schedule(sessionKey);
    this.#trim();
    return card;
  }

  /**
   * 同一条消息的文本后来变过（媒体引用回填、看图描述落地）——把卡片里那一行也换掉。
   * 卡片是**唯一默认注入**的记忆层：窗口里的话更新了、卡片里还留着旧的那句，模型就会
   * 在同一次上下文里读到两个版本。找不到对应行（老卡没记 id）就安静地什么都不做。
   */
  patch(entry) {
    const id = String(entry?.id ?? '');
    if (!id) return null;
    const sessionKey = String(entry.sessionKey ?? 'unknown');
    const card = this.#map.get(sessionKey);
    if (!card) return null;
    const line = card.lines.find((l) => String(l.id ?? '') === id);
    if (!line) return null;
    const text = String(entry.text ?? '');
    if (line.text === text) return card;
    line.text = text;
    card.updatedAt = this.now();
    this.#dirty.add(sessionKey);
    this.#schedule(sessionKey);
    return card;
  }

  #schedule(sessionKey) {
    if (!this.enabled) return false;
    return Boolean(this.storage.schedule?.(this.fileOf(sessionKey), () => this.toJSON(sessionKey)));
  }

  toJSON(sessionKey) {
    const card = this.#map.get(String(sessionKey));
    if (!card) return null;
    return {
      version: 1,
      sessionKey: card.sessionKey,
      worldKey: card.worldKey,
      savedAt: this.now(),
      updatedAt: card.updatedAt,
      firstTs: card.firstTs,
      lastTs: card.lastTs,
      messageCount: card.messageCount,
      participants: card.participants,
      lines: card.lines,
      ids: card.ids,
    };
  }

  /** 立刻落盘（`onebot_caps({flush:true})` 与停机走它；平时交给防抖）。 */
  flush() {
    if (!this.enabled) return 0;
    let n = 0;
    for (const key of [...this.#dirty]) {
      if (this.storage.write(this.fileOf(key), this.toJSON(key))) n += 1;
    }
    this.#written += n;
    this.#dirty.clear();
    return n;
  }

  get(sessionKey) {
    return this.#map.get(String(sessionKey)) ?? null;
  }

  list({ limit = 20 } = {}) {
    const out = [...this.#map.values()]
      .sort((a, b) => Number(b.lastTs ?? b.updatedAt ?? 0) - Number(a.lastTs ?? a.updatedAt ?? 0))
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((c) => ({
        sessionKey: c.sessionKey,
        worldKey: c.worldKey,
        messageCount: c.messageCount,
        firstTs: c.firstTs,
        lastTs: c.lastTs,
        updatedAt: c.updatedAt,
        participants: c.participants.length,
      }));
    return { cards: out, count: out.length, total: this.#map.size };
  }

  /**
   * 渲染层要的形状（与 `buildDigest` 的输出同构），**带 `resumed: true`**：
   * 它是落盘的那份，不是刚刚从内存环里算出来的。
   */
  digestFor(sessionKey) {
    const card = this.#map.get(String(sessionKey));
    if (!card || !card.messageCount) return null;
    return {
      sessionKey: card.sessionKey,
      worldKey: card.worldKey,
      now: this.now(),
      resumed: true,
      savedAt: card.savedAt,
      messageCount: card.messageCount,
      participants: card.participants,
      lines: card.lines,
      responders: [],
      downstreamResponded: false,
      firstTs: card.firstTs,
      lastTs: card.lastTs,
      volume: {
        total: card.messageCount,
        byActor: Object.fromEntries(card.participants.map((p) => [String(p.user_id), p.count])),
      },
    };
  }

  reset() {
    const n = this.#map.size;
    this.#map.clear();
    this.#dirty.clear();
    return n;
  }

  /**
   * 清掉不再算数的历史行（真机：发送失败的回复曾以"我：…"留在卡里冒充发言，
   * 且卡片落盘——光改 `isCardWorthy` 救不了已经写下去的那份）。`fn(line)` 返回
   * true 的行删掉，messageCount 同步下修并安排落盘。返回删掉的行数。
   */
  pruneLinesWhere(fn) {
    if (typeof fn !== 'function') return 0;
    let total = 0;
    for (const [key, card] of this.#map) {
      const before = card.lines.length;
      const kept = card.lines.filter((line) => !fn(line));
      if (kept.length === before) continue;
      const removed = before - kept.length;
      card.lines = kept;
      card.messageCount = Math.max(0, Number(card.messageCount ?? 0) - removed);
      card.updatedAt = this.now();
      this.#dirty.add(key);
      this.#schedule(key);
      total += removed;
    }
    if (total) this.#trim();
    return total;
  }

  #trim() {
    if (this.#map.size <= this.maxSessions) return 0;
    const ordered = [...this.#map.entries()].sort(
      (a, b) => Number(a[1].updatedAt ?? 0) - Number(b[1].updatedAt ?? 0),
    );
    let n = 0;
    for (const [key] of ordered) {
      if (this.#map.size <= this.maxSessions) break;
      this.#map.delete(key); // 只从内存里丢；磁盘上那份留着，下次重启还能读回来
      n += 1;
    }
    return n;
  }
}
