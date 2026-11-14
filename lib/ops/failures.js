/**
 * 投递失败队列（审查报告"投递失败队列"，`m85685`）。
 *
 * 现在失败的知识只活在两处：`#sendFailures`（按会话，下一批开头告诉模型一次就没了）
 * 与 `stats.lastTurn`（只留最后一轮）。于是"刚才那条没发出去"在群里没有任何痕迹——
 * 用户看不见、运营者也看不见，只有模型被口头告知过。
 *
 * 这里只做三件事：**记下来（有上限）· 让人看见 · 手动重放一次**。
 * 不做自动重试：发送失败大多是系统性的（被踢、禁言、权限、内容违规），
 * 盲目重试会把同一个错误放大成一串（对照 `m35050` 那次"失败后连醒三轮"）。
 *
 * 落盘 `<storageDir>/ops/failures.json`，最多 `limit` 条（新的在前，旧的挤掉）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeName } from '../storage.js';

const DEFAULT_LIMIT = 50;
const MAX_TEXT = 300;
const MAX_SEGMENTS = 12;
/** 卡片（`json`/`xml`）整份都要留着才重放得出来，所以放宽到 4K 字符。 */
const MAX_CARD = 4000;

/**
 * 每种段允许保留哪些字段（第三轮 T12）。
 *
 * 以前只认 `text/qq/id/file` 四个：`json` 段的 `data`（整张卡片）、只给 `data.url` 的图片
 * 全被清空，回执却还说"可以重放"——重放出去就是一条空消息。现在按段类型列白名单，
 * 白名单外还有字段就明说"这段还原不了"，`replayable` 跟着 false。
 */
const SEGMENT_FIELDS = {
  text: ['text'],
  at: ['qq', 'name', 'user_id'],
  face: ['id', 'faceText', 'faceType'],
  mface: ['id', 'emoji_id', 'emojiId', 'summary', 'key', 'url', 'text'],
  image: ['file', 'url', 'path', 'name', 'summary', 'sub_type', 'subType', 'type'],
  record: ['file', 'url', 'path', 'name', 'magic'],
  video: ['file', 'url', 'path', 'name'],
  file: ['file', 'url', 'path', 'name', 'file_id', 'file_size', 'file_name'],
  reply: ['id'],
  json: ['data', 'content'],
  xml: ['data', 'content'],
  forward: ['id', 'content'],
  node: ['id', 'user_id', 'nickname', 'content'],
  poke: ['id', 'type', 'name'],
  markdown: ['content', 'data'],
};

/** 内容摘要：同一错误配不同的话要分开记（复审 F13）。 */
const digestOf = (parts) =>
  crypto.createHash('sha1').update(parts.map((x) => String(x ?? '')).join('\u0000')).digest('hex').slice(0, 12);

/** 只留能看懂形状的段：内联的 base64 不能进队列（一条就几百 KB，还重放不了）。 */
function sanitizeSegments(segments) {
  const list = Array.isArray(segments) ? segments.slice(0, MAX_SEGMENTS) : [];
  const reasons = [];
  let lossy = false;
  const out = list.map((seg) => {
    const type = String(seg?.type ?? '').toLowerCase();
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
    const allowed = SEGMENT_FIELDS[type] ?? null;
    if (!allowed) {
      // 不认识的段：连形状都还原不了，别假装能重放。
      reasons.push(`不认识的段：${type || '空类型'}`);
      lossy = true;
      return { type, data: {} };
    }
    const keep = new Set(allowed);
    const extra = Object.keys(data).filter((k) => {
      if (keep.has(k)) return false;
      const v = data[k];
      if (v === undefined || v === null || v === '') return false;
      if (typeof v === 'object') return Object.keys(v).length > 0;
      return true;
    });
    if (extra.length) {
      reasons.push(`段里有还原不了的字段：${type}(${extra.join(',')})`);
      lossy = true;
    }
    const kept = {};
    for (const key of allowed) {
      if (data[key] === undefined || data[key] === null) continue;
      const value = data[key];
      if (typeof value === 'string') {
        if (/^(base64:\/\/|data:)/i.test(value)) {
          reasons.push('内联媒体');
          lossy = true;
          continue;
        }
        const cap = type === 'json' || type === 'xml' ? MAX_CARD : MAX_TEXT;
        if (value.length > cap) {
          reasons.push(type === 'json' || type === 'xml' ? '卡片过长' : '文字过长');
          lossy = true;
          kept[key] = value.slice(0, cap);
          continue;
        }
        kept[key] = value;
        continue;
      }
      if (typeof value === 'object') {
        // 结构内也可能藏着内联媒体。复制并逐层检查，不能把原对象直接带进队列。
        let nodes = 0;
        const copy = (v, depth = 0) => {
          if (++nodes > 256 || depth > 12) throw new Error('结构过大');
          if (typeof v === 'string') {
            if (/(?:base64:\/\/|data:[^,]*;base64,)/i.test(v)) throw new Error('嵌套内联媒体');
            if (v.length > MAX_CARD) throw new Error('结构过大');
            return v;
          }
          if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
          if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]));
          return v;
        };
        try {
          const copied = copy(value);
          if (JSON.stringify(copied).length > MAX_CARD) throw new Error('结构过大');
          kept[key] = copied;
        } catch (err) { reasons.push(String(err.message)); lossy = true; }
        continue;
      }
      kept[key] = value;
    }
    return { type, data: kept };
  });
  if (Array.isArray(segments) && segments.length > MAX_SEGMENTS) {
    reasons.push('段数过多');
    lossy = true;
  }
  return { segments: out, trimmed: lossy, reasons: [...new Set(reasons)] };
}

const paramsOf = (params) => {
  const src = params && typeof params === 'object' ? params : {};
  const out = {};
  let trimmed = false;
  for (const [k, v] of Object.entries(src)) {
    if (k === 'message') continue; // 段数组单独存，别在 params 里存第二份
    if (typeof v === 'string' && /(?:base64:\/\/|data:[^,]*;base64,)/i.test(v)) { trimmed = true; continue; }
    if (typeof v === 'string' && v.length > MAX_TEXT) {
      out[k] = v.slice(0, MAX_TEXT);
      trimmed = true; // 参数被截短了，同样不能当"原样"重放
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else if (v !== null && v !== undefined) trimmed = true;
  }
  return { params: out, trimmed };
};

export class FailureStore {
  constructor({ storage = null, log = () => {}, limit = DEFAULT_LIMIT, file = 'ops/failures.json' } = {}) {
    this.storage = storage;
    this.log = log;
    this.limit = Math.max(5, Number(limit) || DEFAULT_LIMIT);
    this.file = file;
    this.#entries = [];
    this.loaded = false;
  }

  #entries;

  load() {
    this.loaded = true;
    const raw = this.storage?.read?.(this.file, null) ?? null;
    const rows = Array.isArray(raw?.entries) ? raw.entries : [];
    this.#entries = rows
      .filter((row) => row && typeof row === 'object' && row.id)
      .slice(0, this.limit)
      .map((row) => {
        const clean = sanitizeSegments(row.segments);
        const packed = paramsOf(row.params);
        const valid = row.payloadVersion === 2 && row.replayable === true && !clean.trimmed && !packed.trimmed && clean.segments.length > 0;
        return { ...row, segments: clean.segments, params: packed.params, replayable: valid,
          trimReasons: [...new Set([...(row.trimReasons ?? []), ...clean.reasons, ...(!valid ? ['旧记录或不完整载荷'] : [])])] };
      });
    return this.#entries.length;
  }

  get size() {
    if (!this.loaded) this.load();
    return this.#entries.length;
  }

  /** 新到旧。 */
  list({ limit = this.limit } = {}) {
    if (!this.loaded) this.load();
    return this.#entries.slice(0, Math.max(1, limit)).map((row) => structuredClone(row));
  }

  /**
   * 按会话清掉失败记录（第三轮复审 T10）。
   *
   * 队列里存着原回复的正文——用户点"删掉这个会话"，他不期望那几句话还躺在运维面板里。
   * 只按 `scope` 匹配；返回删掉的条数。
   */
  forgetScope(scope) {
    if (!this.loaded) this.load();
    const key = String(scope ?? '').trim();
    if (!key) return 0;
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((row) => String(row?.scope ?? '') !== key);
    const n = before - this.#entries.length;
    if (n > 0) this.#save();
    return n;
  }

  find(id) {
    if (!this.loaded) this.load();
    return this.#entries.find((row) => row.id === String(id ?? '').trim()) ?? null;
  }

  /**
   * 记一条失败。同一目标 + 同一段内容 + 同一错误在 60 秒内只留一条（否则一个坏掉的
   * 通道会在几秒内刷满队列，把真正的第一条挤出去）。
   */
  record({ scope = '', action = 'send_msg', params = null, segments = null, text = '', status = '', retcode = null, error = '', at = Date.now() } = {}) {
    if (!this.loaded) this.load();
    const clean = sanitizeSegments(segments);
    const packed = paramsOf(params);
    const full = String(text ?? '');
    const said = full.slice(0, MAX_TEXT);
    if (full.length > MAX_TEXT) clean.reasons.push('正文过长');
    const reason = String(error ?? '').slice(0, MAX_TEXT);
    // 键里要带内容摘要（复审 F13）：同一条通道上"没发出去的两句不同的话"是两条记录，
    // 只看错误码会把它们合成一条、只留下第一句。
    const key = `${scope}|${action}|${retcode}|${reason}|${digestOf([full, JSON.stringify(clean.segments), JSON.stringify(packed.params)])}`;
    const replayable = clean.segments.length > 0 && clean.trimmed === false && packed.trimmed === false;
    const hit = this.#entries.find((row) => row.key === key && at - Number(row.at ?? 0) < 60000);
    if (hit) {
      hit.count = (Number(hit.count) || 1) + 1;
      hit.at = at;
      this.#save();
      return hit;
    }
    const entry = {
      payloadVersion: 2,
      id: `fail_${Math.random().toString(36).slice(2, 8)}`,
      key,
      at,
      scope: String(scope ?? ''),
      action: String(action ?? 'send_msg'),
      params: packed.params,
      text: said,
      segments: clean.segments,
      segmentsTrimmed: clean.trimmed || packed.trimmed,
      trimReasons: [...new Set([...(clean.reasons ?? []), ...(packed.trimmed ? ['参数过长'] : [])])],
      replayable,
      status: String(status ?? ''),
      retcode: retcode === null || retcode === undefined ? null : Number(retcode),
      error: reason,
      count: 1,
    };
    this.#entries.unshift(entry);
    if (this.#entries.length > this.limit) this.#entries.length = this.limit;
    this.#save();
    this.log(`[failures] 记下一条投递失败：${entry.scope || '?'} ${entry.action} ${entry.status}${entry.retcode != null ? ` retcode=${entry.retcode}` : ''}`);
    return { ...entry };
  }

  remove(id) {
    if (!this.loaded) this.load();
    const key = String(id ?? '').trim();
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((row) => row.id !== key);
    const changed = this.#entries.length !== before;
    if (changed) this.#save();
    return changed;
  }

  clear() {
    if (!this.loaded) this.load();
    const n = this.#entries.length;
    this.#entries = [];
    this.#save();
    return n;
  }

  /** 重放用的 params：把段数组拼回 `message`（与 `buildSendParams` 的产物同形）。 */
  paramsFor(id) {
    const row = this.find(id);
    if (!row) return { ok: false, error: `没有这条失败记录：${id}` };
    const clean = sanitizeSegments(row.segments);
    const packed = paramsOf(row.params);
    if (row.replayable !== true || clean.trimmed || packed.trimmed || !clean.segments.length) {
      const why = (row.trimReasons ?? []).join('、') || '内容不完整';
      return {
        ok: false,
        error: `这条队列里存得不完整（${why}），不能当原样重放——直接让模型再发一次，别发半条出去。`,
      };
    }
    const params = { ...(row.params ?? {}) };
    if (Array.isArray(row.segments) && row.segments.length) params.message = row.segments;
    return { ok: true, action: row.action, params };
  }

  #save() {
    if (!this.storage?.enabled) return;
    this.storage.schedule(this.file, () => ({ version: 1, entries: this.#entries }));
  }

  /** 设置页的健康摘要（`onebot_hub_status` 用）。 */
  get stats() {
    if (!this.loaded) this.load();
    const last = this.#entries[0] ?? null;
    return { count: this.#entries.length, limit: this.limit, lastAt: last?.at ?? null, lastError: last?.error ?? null };
  }

  /** 导出目录名（仅用于诊断打印）。 */
  get pathOnDisk() {
    const dir = this.storage?.dir;
    return dir ? path.join(dir, safeName('ops'), 'failures.json') : '';
  }

  /** 只给测试/排障用：磁盘上的真身存在吗。 */
  existsOnDisk() {
    return Boolean(this.pathOnDisk) && fs.existsSync(this.pathOnDisk);
  }
}
