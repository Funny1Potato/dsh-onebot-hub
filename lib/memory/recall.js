/**
 * 聊天记录检索（§24.9 M17）：`onebot_recall` 的引擎。
 *
 * 一个工具，多种问法：按关键词、按人、按时间窗、按消息类型、按人分组、只看没结的话题。
 * 三种能力在这里合流，缺一个都会让"检索"变成似是而非的东西：
 *
 *  1. **中文要能搜到**。FTS5 的 unicode61 会把"今天天气不错"整段切成一个 token
 *     （搜"今天"查不到），trigram 又要求查询 ≥3 字符（"梗图"这种两字词查不到）。
 *     所以写入与查询**两侧都人工切 bigram**：`今天天气` → `今天 天天 天气 气不 不错`
 *     （实测 SQLite 3.51.2 + FTS5 已编译，这是可选路线里唯一能用的）。
 *  2. **可见性是检索层的事**。翻记录最容易绕过隔离——模型不必"记得"，它直接搜就行。
 *     所以每一条命中都要过 `isVisible`，被挡下的条数照实回给调用方（`denied`），
 *     越界检索（`scope: 'all'`）默认被降级并**带回一句 note**（不能静默改变语义）。
 *  3. **索引可重建，真相永远是 jsonl**。`index.sqlite` 删了能重建、`node:sqlite` 不可用时
 *     自动降级成内存倒排索引——两种模式下检索结果一致，只是"重启后要不要重新扫一遍"的差别。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripInlineMedia } from '../protocol.js';
import { safeName } from '../storage.js';
import { inferScope, inferVisibility, isVisible, isSensitive, resolveRecallScope } from './isolation.js';
import { decayStrength, isWeak, weakMessageIds } from './decay.js';

/** 中文按 bigram 切，英文/数字按词切（"FTS5"、"3080" 这种整词比切片好搜）。 */
export function tokenize(text) {
  const out = [];
  const src = String(text ?? '');
  const cjk = /[\u3400-\u9fff\uf900-\ufaff]/;
  let buf = '';
  let word = '';
  const pushWord = () => {
    if (word.length >= 1) out.push(word.toLowerCase());
    word = '';
  };
  for (const ch of src) {
    if (cjk.test(ch)) {
      pushWord();
      buf += ch;
      if (buf.length >= 2) {
        out.push(buf.slice(-2)); // 滑动 bigram
        if (buf.length > 2) buf = buf.slice(-1);
      }
    } else if (/[A-Za-z0-9]/.test(ch)) {
      buf = '';
      word += ch;
    } else {
      buf = '';
      pushWord();
    }
  }
  pushWord();
  return [...new Set(out.filter(Boolean))];
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function segmentTypes(row) {
  const segs = row?.message ?? row?.payload?.message;
  if (!Array.isArray(segs)) return [];
  return segs.map((s) => s?.type).filter(Boolean);
}

function worldKeyOfSession(key) {
  const s = String(key ?? '');
  if (s.startsWith('group:')) return s;
  if (s.startsWith('private:')) return s;
  return s;
}

export class RecallStore {
  #rows = [];
  #byId = new Map();
  #inverted = new Map();
  #sqlite = null;
  #sqliteOk = false;
  #indexed = new Set();
  #loaded = false;
  #rebuilt = 0;
  #errors = 0;

  /**
   * @param {{dir?:string, linkId?:string, log?:Function, store?:object, now?:Function}} opts
   *   `dir` 为空 = 关闭（连内存索引都不建）；`store` 是 `MemoryStore`，用于 `sources:['memory']`。
   */
  constructor({ dir = '', linkId = '', log, store = null, now = Date.now } = {}) {
    this.dir = String(dir ?? '');
    this.linkId = String(linkId ?? 'link');
    this.log = log ?? (() => {});
    this.store = store;
    this.now = now;
  }

  get enabled() {
    return this.dir !== '';
  }

  get stats() {
    return {
      enabled: this.enabled,
      mode: this.#sqliteOk ? 'sqlite' : 'memory',
      dir: this.dir || null,
      file: this.enabled ? path.join(this.dir, safeName(this.linkId), `${dayKey(this.now())}.jsonl`) : null,
      rows: this.#rows.length,
      terms: this.#inverted.size,
      indexed: this.#indexed.size,
      rebuilt: this.#rebuilt,
      errors: this.#errors,
    };
  }

  /** L1 原始层的一行（内存环会被上限裁掉，落盘的 jsonl 才是"翻得到过去"的那份）。 */
  rowOf(entry) {
    // 原始报文（`m03065`）：**解析不了的段类型也在内**——hub 只做"能自动做的那点解析"，
    // 需要更深的理解时由 agent 取这份原文自己处理。内联大块数据换成占位（字节在 blob 里），
    // 否则一段 base64 就能让 jsonl 膨胀到几百 KB。
    const payload = entry?.payload ? stripInlineMedia(entry.payload) : null;
    return {
      id: String(entry?.id ?? ''),
      ts: Number(entry?.ts ?? this.now()),
      linkId: entry?.linkId ?? this.linkId,
      direction: entry?.direction ?? null,
      kind: entry?.kind ?? null,
      sessionKey: entry?.sessionKey ?? null,
      actor: entry?.actor ?? null,
      action: entry?.action ?? null,
      decision: entry?.decision ?? null,
      text: entry?.text ?? null,
      refs: entry?.refs ?? null,
      trace: entry?.trace ?? null,
      message: payload?.message ?? entry?.message ?? null,
      payload,
      mediaRefs: entry?.refs?.media ?? null,
    };
  }

  append(entry) {
    if (!this.enabled) return false;
    const row = this.rowOf(entry);
    if (!row.id) return false;
    if (this.#byId.has(row.id)) return false;
    this.#remember(row);
    const file = path.join(this.dir, safeName(this.linkId), `${dayKey(row.ts)}.jsonl`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (err) {
      this.#errors += 1;
      this.log(`[recall] 追加时间线失败：${err.message}`);
    }
    this.#indexRow(row);
    return true;
  }

  /**
   * 媒体**异步落地**之后回填这一行的媒体引用（`m02432` P9）。
   *
   * `rowOf()` 在 `append()` 那一刻就把 `mediaRefs` 冻结了（`recall.js` 的 `mediaRefs: entry?.refs?.media ?? null`），
   * 而图片/语音是之后才落地的（`hub.#resolveMedia` / `hub.#resolveDownstreamMedia` 是异步旁路）：
   * 不回填的话 `onebot_raw` 永远回 `mediaRefs: null, media: []`——真机上 agent 只能去
   * `onebot_media{list:true}` 里翻（那次结果是 49933 字符）。
   *
   * 内存行与当天那份 jsonl 都改：落盘那份才是重启后还查得到的东西。
   */
  patchMedia(id, ids) {
    const key = String(id ?? '').trim();
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean).map(String);
    if (!key || !list.length) return false;
    const row = this.#byId.get(key);
    if (!row) return false;
    row.mediaRefs = list;
    if (row.refs && typeof row.refs === 'object') row.refs = { ...row.refs, media: list };
    if (!this.enabled) return true;
    const file = path.join(this.dir, safeName(this.linkId), `${dayKey(Number(row.ts) || this.now())}.jsonl`);
    try {
      if (!fs.existsSync(file)) return true;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let hit = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]) continue;
        let parsed = null;
        try { parsed = JSON.parse(lines[i]); } catch { continue; }
        if (String(parsed?.id ?? '') !== key) continue;
        parsed.mediaRefs = list;
        if (parsed.refs && typeof parsed.refs === 'object') parsed.refs = { ...parsed.refs, media: list };
        lines[i] = JSON.stringify(parsed);
        hit = true;
      }
      if (hit) fs.writeFileSync(file, lines.join('\n'), 'utf8');
    } catch (err) {
      this.#errors += 1;
      this.log(`[recall] 回填媒体引用失败：${err.message}`);
    }
    return true;
  }

  /** 按 OneBot 消息 id 找 L1 原始行（`ensure()` 载入过的历史才查得到）。 */
  byMessage(messageId) {
    const id = String(messageId ?? '').trim();
    if (!id) return null;
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) {
      if (String(this.#rows[i]?.refs?.message_id ?? '') === id) return this.#rows[i];
    }
    return null;
  }

  /**
   * 某条时间线记录的**出站裁决**（`m30859`：发送失败的消息不算说过的话——
   * 会话卡/窗口/聊天记录都该跳过它，但时间线与原文（onebot_raw）保留供排查）。
   * 查不到返回 null。
   */
  verdictOf(id) {
    const row = this.#byId.get(String(id ?? '').trim());
    if (!row) return null;
    return { direction: row.direction ?? null, decision: row.decision ?? null };
  }

  /**
   * 取某一条的**原始报文**（`m03065` 用户要求：收到的所有消息都缓存并记录索引，
   * **包括 hub 解析不了的**，需要时由 agent 拿原文自己用工具处理）。
   *
   * `ref` 认时间线条目 id（`t…`）或 OneBot 消息 id；`hub-media:<id>` 属于媒体那边，不在这里。
   */
  async rawOf(ref) {
    const key = String(ref ?? '').trim();
    if (!key) return { error: '给我一个 ref：时间线条目 id（形如 t…）或消息 id' };
    if (key.startsWith('hub-media:')) return { error: `${key} 是媒体引用：用 onebot_media 取字节/路径，或看所属条目的原文` };
    await this.ensure();
    const row = this.#byId.get(key) ?? this.byMessage(key);
    if (!row) {
      // 长串不透明 id 多半是**合并转发/媒体的 id**，不是时间线条目 id——把话说清，
      // 否则 agent 会以为"原文被清了"（真机上就这么白试了一轮）。
      const looksLikeForward = !key.startsWith('t') && /^[A-Za-z0-9_\-+/=]{20,}$/.test(key);
      return {
        error: `找不到 ${key} 的原文（可能已被保留期清掉）；索引里现有 ${this.#rows.length} 条，可用 rawIndex 方式先看有哪些`
          + (looksLikeForward
            ? '。注意：这串看着像**合并转发/媒体的 id**，不是时间线条目 id——聊天记录用 onebot_media({action:"get_forward_msg", id/file/message_id}) 取，已落地的媒体用 hub-media:<id>'
            : ''),
      };
    }
    return { ok: true, raw: row };
  }

  /** 原始报文的**索引视图**（新到旧）：先看有哪些，再按 `ref` 取全文。 */
  async rawIndex({ limit = 20, sessionKey: sk = null, kind = null, direction = null, since = null, until = null } = {}) {
    await this.ensure();
    let rows = this.#rows;
    if (sk) rows = rows.filter((r) => r.sessionKey === sk);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (direction) rows = rows.filter((r) => r.direction === direction);
    if (since !== null && since !== undefined) rows = rows.filter((r) => Number(r.ts) >= Number(since));
    if (until !== null && until !== undefined) rows = rows.filter((r) => Number(r.ts) <= Number(until));
    const picked = rows.slice(-Math.max(1, Number(limit) || 20));
    return {
      count: picked.length,
      total: rows.length,
      retained: this.#rows.length,
      entries: picked.map((row) => ({
        ref: row.id,
        ts: row.ts,
        direction: row.direction ?? null,
        kind: row.kind ?? null,
        sessionKey: row.sessionKey ?? null,
        actor: row.actor ?? null,
        action: row.action ?? null,
        decision: row.decision ?? null,
        text: row.text ?? null,
        segmentTypes: segmentTypes(row),
        mediaRefs: row.mediaRefs ?? null,
      })),
    };
  }

  /**
   * 保留期清理（`retention.days`，`m03091` 用户要求"缓存超过一定天数自动清理"）。
   *
   * 两件事一起做，缺一个都会自相矛盾：**超期的日文件删掉**、**内存与索引里的旧行也掉**
   * （否则"重启前还查得到、重启后就没了"）。`days <= 0` = 不清理。
   */
  prune({ days = 0 } = {}) {
    const d = Number(days);
    if (!(d > 0) || !this.enabled) return { skipped: true, days: d, removedFiles: 0, removedRows: 0 };
    const cutoff = this.now() - d * 86400000;
    const dir = path.join(this.dir, safeName(this.linkId));
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      files = [];
    }
    let removedFiles = 0;
    for (const f of files) {
      const day = f.replace(/\.jsonl$/, '');
      const ts = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00`);
      // 整天过期才删（当天那份永远留着）。
      if (!Number.isFinite(ts) || ts + 86400000 > cutoff) continue;
      try {
        fs.rmSync(path.join(dir, f));
        removedFiles += 1;
      } catch (err) {
        this.log(`[recall] 清理旧记录失败（${f}）：${err?.message ?? err}`);
      }
    }
    const keep = [];
    let removedRows = 0;
    for (const row of this.#rows) {
      if (Number(row.ts) >= cutoff) {
        keep.push(row);
        continue;
      }
      removedRows += 1;
      this.#byId.delete(row.id);
      this.#indexed.delete(row.id);
      for (const token of this.docTokens(row)) this.#inverted.get(token)?.delete(row.id);
      if (this.#sqliteOk && this.#sqlite) {
        try {
          this.#sqlite.prepare('DELETE FROM rt WHERE id = ?').run(row.id);
        } catch (err) {
          this.#errors += 1;
          this.log(`[recall] 索引里删旧行失败：${err?.message ?? err}`);
        }
      }
    }
    this.#rows = keep;
    return { days: d, cutoff, removedFiles, removedRows };
  }

  #remember(row) {
    this.#rows.push(row);
    this.#byId.set(row.id, row);
    for (const token of this.docTokens(row)) {
      let set = this.#inverted.get(token);
      if (!set) {
        set = new Set();
        this.#inverted.set(token, set);
      }
      set.add(row.id);
    }
  }

  docTokens(row) {
    const kinds = segmentTypes(row).join(' ');
    return tokenize([row.text, row.actor?.nickname, row.actor?.user_id, row.sessionKey, kinds].filter(Boolean).join(' '));
  }

  /** 读 jsonl（真相）+ 打开/填充 sqlite 索引（可以随时删掉重建）。 */
  async ensure() {
    if (!this.enabled || this.#loaded) return this;
    this.#loaded = true;
    const dir = path.join(this.dir, safeName(this.linkId));
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      files = [];
    }
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.id && !this.#byId.has(row.id)) this.#remember(row);
        } catch {
          this.#errors += 1; // 坏行跳过：一行脏数据不该废掉整份记录
        }
      }
    }
    await this.#openSqlite();
    return this;
  }

  async #openSqlite() {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      fs.mkdirSync(this.dir, { recursive: true });
      const db = new DatabaseSync(path.join(this.dir, 'index.sqlite'));
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS rt USING fts5(id UNINDEXED, doc)");
      this.#sqlite = db;
      this.#sqliteOk = true;
      // 表里的 id 才是"已索引"的真相：`append` 在 sqlite 打开之前只往内存里堆，
      // 这里必须把缺的行补进去，否则 FTS 表是空的而内存却以为都索引过了。
      const present = new Set(db.prepare('SELECT id FROM rt').all().map((r) => String(r.id ?? '')));
      this.#indexed = present;
      for (const row of this.#rows) this.#indexRow(row);
    } catch (err) {
      this.#sqliteOk = false;
      this.#sqlite = null;
      this.log(`[recall] node:sqlite 不可用，降级内存倒排索引：${err?.message ?? err}`);
      for (const row of this.#rows) this.#indexed.add(row.id);
    }
  }

  #indexRow(row) {
    if (this.#indexed.has(row.id)) return;
    this.#indexed.add(row.id);
    if (!this.#sqliteOk || !this.#sqlite) return;
    try {
      this.#sqlite.prepare('INSERT INTO rt (id, doc) VALUES (?, ?)').run(row.id, this.docTokens(row).join(' '));
    } catch (err) {
      this.#errors += 1;
      this.log(`[recall] 索引写入失败（检索会退化成全表匹配）：${err?.message ?? err}`);
    }
  }

  /** 放开 sqlite 句柄（Windows 上文件被打开就删不掉，测试与停机都需要它）。 */
  close() {
    try {
      this.#sqlite?.close?.();
    } catch {
      /* 已经不在了就算了 */
    }
    this.#sqlite = null;
    this.#sqliteOk = false;
    return true;
  }

  /** 删了 `index.sqlite` 之后重建，结果必须一致——索引不是真相。 */
  async rebuild() {
    this.#rebuilt += 1;
    this.#indexed.clear();
    if (this.#sqliteOk && this.#sqlite) {
      try {
        this.#sqlite.exec('DROP TABLE IF EXISTS rt');
        this.#sqlite.exec('CREATE VIRTUAL TABLE rt USING fts5(id UNINDEXED, doc)');
      } catch (err) {
        this.#errors += 1;
        this.log(`[recall] 重建索引失败：${err?.message ?? err}`);
      }
    }
    for (const row of this.#rows) this.#indexRow(row);
    return { rows: this.#rows.length, mode: this.#sqliteOk ? 'sqlite' : 'memory' };
  }

  /** 命中集合：sqlite 走 FTS5 MATCH，降级时走内存倒排索引取交集（AND 语义一致）。 */
  #matchIds(tokens) {
    if (!tokens.length) return this.#rows.map((r) => r.id);
    if (this.#sqliteOk && this.#sqlite) {
      const expr = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
      try {
        const rows = this.#sqlite.prepare('SELECT id FROM rt WHERE rt MATCH ? LIMIT 2000').all(expr);
        return rows.map((r) => String(r.id ?? '')).filter(Boolean);
      } catch (err) {
        this.#errors += 1;
        this.log(`[recall] FTS 查询失败，回退内存索引：${err?.message ?? err}`);
      }
    }
    let out = null;
    for (const token of tokens) {
      const set = this.#inverted.get(token);
      if (!set) return [];
      out = out ? new Set([...out].filter((id) => set.has(id))) : new Set(set);
      if (!out.size) return [];
    }
    return [...(out ?? [])];
  }

  /**
   * 一次检索。返回 `{items, count, scanned, mode, scope, note, denied, stats}`。
   *
   * @param {{query?:string, person?:string, worldKey?:string, sessionKey?:string, actorId?:string,
   *          since?:number, until?:number, kinds?:string[], groupBy?:string, openOnly?:boolean,
   *          scope?:string, confirm?:boolean, limit?:number, includeWeak?:boolean, sources?:string[],
   *          isolation?:object, topics?:object[]}} opts
   */
  async search(opts = {}) {
    const now = this.now();
    const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 200);
    const isolation = opts.isolation ?? null;
    const sessionKey = String(opts.sessionKey ?? '');
    const actorId = opts.actorId ?? null;
    const recall = resolveRecallScope({ requested: opts.scope ?? 'visible', isolation });
    if (recall.escaped && recall.needsApproval && !opts.confirm) {
      return {
        items: [],
        count: 0,
        scanned: 0,
        mode: this.enabled ? (this.#sqliteOk ? 'sqlite' : 'memory') : 'off',
        scope: recall.scope,
        note: `${recall.note}；本次需要显式确认（confirm: true）才会返回内容`,
        needsApproval: true,
        denied: 0,
        stats: this.stats,
      };
    }
    if (!this.enabled) {
      return { items: [], count: 0, scanned: 0, mode: 'off', scope: recall.scope, note: '没有开启存储（persist: false 或 storageDir 为空），翻不到历史', denied: 0, stats: this.stats };
    }
    await this.ensure();

    // 引擎自己容错：调用方给 "image" 这种逗号串也算数（工具层也会先切一次）。
    const asList = (value) =>
      Array.isArray(value)
        ? value
        : String(value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    const tokens = tokenize(opts.query ?? '');
    const ids = new Set(this.#matchIds(tokens));
    const sources = new Set(asList(opts.sources).length ? asList(opts.sources) : ['timeline']);
    const weak = opts.includeWeak ? new Set() : weakMessageIds(this.store?.all?.() ?? [], { now });
    const since = Number(opts.since ?? 0) || 0;
    const until = Number(opts.until ?? 0) || 0;
    const kindsWanted = asList(opts.kinds).map((k) => k.toLowerCase());
    const person = String(opts.person ?? '');
    const worldKey = String(opts.worldKey ?? '');
    const topics = Array.isArray(opts.topics) ? opts.topics : [];
    let denied = 0;
    let weakHidden = 0;
    let failedHidden = 0;
    let scanned = 0;
    const items = [];

    for (const row of this.#rows) {
      if (!ids.has(row.id)) continue;
      scanned += 1;
      // 发送失败的消息不是聊天记录（真机：failed 的回复曾作为"我：…"被搜出来）。
      // 时间线（onebot_timeline / onebot_raw）仍保留全文可查。
      if (row.direction === 'hub-out' && row.decision === 'failed') {
        failedHidden += 1;
        continue;
      }
      if (since && row.ts < since) continue;
      if (until && row.ts > until) continue;
      if (worldKey && worldKeyOfSession(row.sessionKey) !== worldKey) continue;
      if (person) {
        const hit = String(row.actor?.user_id ?? '') === person || String(row.text ?? '').includes(person);
        if (!hit) continue;
      }
      if (kindsWanted.length) {
        const segs = segmentTypes(row).map((s) => String(s).toLowerCase());
        const kind = String(row.kind ?? '').toLowerCase();
        if (!kindsWanted.some((k) => segs.includes(k) || kind.includes(k))) continue;
      }
      if (opts.openOnly) {
        const open = topics.filter((t) => t?.status !== 'closed');
        const inTopic = open.some((t) => {
          const from = Number(t?.startedAt ?? 0) || 0;
          const to = Number(t?.lastAt ?? 0) || Infinity;
          if (row.ts < from || row.ts > to) return false;
          const members = (t?.members ?? []).map(String);
          return !members.length || members.includes(String(row.actor?.user_id ?? ''));
        });
        if (!inTopic) continue;
      }
      if (weak.size && weak.has(String(row.refs?.message_id ?? ''))) {
        weakHidden += 1;
        continue;
      }

      const scope = inferScope({ sessionKey: row.sessionKey, worldKey: worldKeyOfSession(row.sessionKey), actorId: row.actor?.user_id });
      const hash = { id: row.id, ts: row.ts, kind: row.kind, text: row.text, scope, worldKey: worldKeyOfSession(row.sessionKey), actor: row.actor };
      const visibility = inferVisibility(hash, { sessionKey: row.sessionKey });
      const entry = { ...hash, visibility, sensitive: isSensitive(hash) };
      const verdict = isVisible(entry, { sessionKey, worldKey: sessionKey, actorId, isolation });
      // 检索层就是隔离规则的执行点：能搜到不等于能看见。
      if (!recall.escaped && !verdict.ok) {
        denied += 1;
        continue;
      }
      items.push({
        id: row.id,
        at: new Date(row.ts).toISOString(),
        ts: row.ts,
        source: 'timeline',
        direction: row.direction,
        sessionKey: row.sessionKey,
        kind: row.kind,
        actor: row.actor,
        text: row.text,
        refs: row.refs,
        segments: segmentTypes(row),
        scope,
        visibility,
      });
    }

    // 记忆条目也当一种"来源"：它们的 refs 指向时间线，翻得到出处。
    if (sources.has('memory') && this.store?.all) {
      for (const m of this.store.all()) {
        if (tokens.length) {
          const doc = tokenize(`${m.text ?? ''} ${m.actor?.nickname ?? ''}`);
          if (!tokens.every((t) => doc.includes(t))) continue;
        }
        if (person && String(m.actor?.user_id ?? '') !== person) continue;
        if (worldKey && String(m.worldKey ?? '') !== worldKey) continue;
        if (since && Number(m.ts ?? 0) < since) continue;
        if (until && Number(m.ts ?? 0) > until) continue;
        // 淡忘：默认不出现，但数据还在（includeWeak 或 onebot_timeline 都还取得到）。
        if (!opts.includeWeak && isWeak(m, { now })) {
          weakHidden += 1;
          continue;
        }
        const entry = { ...m, scope: m.scope, worldKey: m.worldKey, visibility: m.visibility, sensitive: m.sensitive };
        if (!recall.escaped && !isVisible(entry, { sessionKey, worldKey: sessionKey, actorId, isolation })) {
          denied += 1;
          continue;
        }
        items.push({
          id: m.id,
          at: new Date(m.ts ?? now).toISOString(),
          ts: m.ts ?? now,
          source: 'memory',
          kind: m.kind,
          sessionKey: m.scope,
          actor: m.actor ?? null,
          text: m.text,
          refs: m.refs ?? null,
          scope: m.scope,
          visibility: m.visibility,
          strength: Number(decayStrength(m, { now }).toFixed(3)),
        });
      }
    }

    items.sort((a, b) => b.ts - a.ts);
    const grouped = String(opts.groupBy ?? '') === 'person';
    const out = {
      items: grouped ? undefined : items.slice(0, limit),
      groups: grouped
        ? [...items
            .reduce((map, it) => {
              const key = String(it.actor?.user_id ?? 'unknown');
              const cur = map.get(key) ?? { user_id: key, nickname: it.actor?.nickname ?? null, count: 0, lastTs: 0, lastText: null };
              cur.count += 1;
              if (it.ts > cur.lastTs) {
                cur.lastTs = it.ts;
                cur.lastText = it.text;
                cur.nickname = it.actor?.nickname ?? cur.nickname;
              }
              map.set(key, cur);
              return map;
            }, new Map())
            .values()]
            .sort((a, b) => b.lastTs - a.lastTs)
            .slice(0, limit)
        : undefined,
      count: grouped ? undefined : Math.min(items.length, limit),
      total: items.length,
      scanned,
      mode: this.#sqliteOk ? 'sqlite' : 'memory',
      scope: recall.scope,
      note: [recall.note,
        weakHidden ? `另有 ${weakHidden} 条已淡忘的记忆被默认跳过（includeWeak: true 可查）` : null,
        failedHidden ? `另有 ${failedHidden} 条发送失败的消息不算聊天记录（原文用 onebot_timeline / onebot_raw 查）` : null,
      ].filter(Boolean).join('；') || null,
      denied,
      failedHidden,
      stats: this.stats,
    };
    return out;
  }
}
