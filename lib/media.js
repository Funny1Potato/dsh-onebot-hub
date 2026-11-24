/**
 * 媒体落地（§22.6、§24.10）：把"会过期的 URL / 只存在于实现端本地路径里的图"变成**durable ref**。
 *
 * 为什么必须有这一层：OneBot 的媒体段给的是 `file`（URL 或实现端本地路径），
 * `get_image`/`get_record` 取回的也是**会过期的 URL**。原样塞进 prompt，模型今天看得见、
 * 明天点开是 404；而"用户发过一张图"这件事本身必须留得住。
 *
 * 落地顺序（每一步都可单独失败，失败只降级、不影响转发）：
 *   1. 拿到字节（`base64://` / `data:` / http(s) / 本地路径 / `get_image`·`get_record` 换 URL）；
 *   2. 有 `<storageDir>` 就写自己的 blob（`media/blobs/<sha256><ext>`）——真相留在我们手里；
 *   3. 宿主挂了 `attachments` 服务再顺手登记一份（这样 DSH 的模型真能看到图）；
 *   4. 语音尝试实现端扩展转写（`fetch_ptt_text` / `voice_msg_to_text`），**取不到就诚实说听不了**。
 *
 * 铁律：本模块**从不修改段数组**（转发必须零改写）。它只产出 `段下标 → ref` 的旁路表，
 * 由 `describeSegments` 决定要不要把 ref 写进"人话"文本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { JsonlLog, safeName } from './storage.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** 生成图的上限（见 `imageMaxBytes`）：比下载宽松一档，但不是无上限。 */
const DEFAULT_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

const MAGIC = [
  { ext: 'png', mediaType: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mediaType: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mediaType: 'image/gif', test: (b) => b.length > 5 && b.subarray(0, 3).toString('latin1') === 'GIF' },
  { ext: 'webp', mediaType: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: 'amr', mediaType: 'audio/amr', test: (b) => b.length > 6 && b.subarray(0, 6).toString('latin1').startsWith('#!AMR') },
  { ext: 'silk', mediaType: 'audio/silk', test: (b) => b.length > 10 && b.subarray(0, 10).toString('latin1') === '#!SILK_V3' },
  { ext: 'mp3', mediaType: 'audio/mpeg', test: (b) => b.length > 3 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { ext: 'mp4', mediaType: 'video/mp4', test: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { ext: 'ogg', mediaType: 'audio/ogg', test: (b) => b.length > 4 && b.subarray(0, 4).toString('latin1') === 'OggS' },
];

/** 猜字节的媒体类型与扩展名；猜不到就 `application/octet-stream`。 */
export function sniffType(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  for (const m of MAGIC) if (m.test(buf)) return { mediaType: m.mediaType, ext: m.ext, sniffed: true };
  return { mediaType: 'application/octet-stream', ext: 'bin', sniffed: false };
}

const extOf = (mediaType) => MAGIC.find((m) => m.mediaType === mediaType)?.ext ?? extFromType(mediaType);

function extFromType(mediaType) {
  const sub = String(mediaType ?? '').split('/')[1] ?? '';
  const clean = sub.replace(/[^a-z0-9]/gi, '');
  return clean || 'bin';
}

const guessTypeFromName = (name) => {
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  const hit = MAGIC.find((m) => m.ext === ext);
  return hit?.mediaType ?? null;
};

/** 只允许 http(s)：媒体段里的 file 是外部输入，不能拿它当任意协议的入口。 */
function isHttp(url) {
  return /^https?:\/\//i.test(String(url ?? ''));
}

/** 内联写法：`base64://…` 或 `data:…;base64,…`——**整张图/整段语音都在这串字里**。 */
const INLINE_PREFIX = /^base64:\/\/|^data:[^,]*;base64,/i;

/** 对外的名字/来源上限：这两个字段是"人读的一行"，不是字节仓库。 */
const MAX_NAME_CHARS = 120;
const MAX_SOURCE_CHARS = 200;

/** 一段 URL/路径的末段（`…/abc.png` → `abc.png`）；认不出来就 null。内联/base64/超长一律 null。 */
export function basenameOf(raw) {
  const text = String(raw ?? '').trim();
  if (!text || INLINE_PREFIX.test(text) || /^hub-media:/i.test(text) || text.length > 512) return null;
  const cut = text.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '';
  return cut && cut.length <= MAX_NAME_CHARS ? cut : null;
}

/**
 * 媒体引用**对外**的投影：只露人能读的字段，`name`/`source` 一律短名。
 *
 * 为什么必须有这层：`file` 段有时是 `base64://…`（整张图在字串里）。一旦把它当 `name`
 * 存下，`onebot_raw` 会把 16 万字符的 base64 塞进工具结果（实测一个 ref 332190 字符，
 * 一天的媒体索引 1.8MB），模型既读不动也不需要——字节在 `blob` 上，真要看就去读 blob。
 *
 * @param {object} ref
 */
export function publicMediaRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const name = basenameOf(ref.name);
  const source = INLINE_PREFIX.test(String(ref.source ?? ''))
    ? `inline:${ref.mediaType ?? 'application/octet-stream'}`
    : String(ref.source ?? '').slice(0, MAX_SOURCE_CHARS);
  return {
    id: ref.id ?? null,
    kind: ref.kind ?? null,
    mediaType: ref.mediaType ?? null,
    bytes: ref.bytes ?? null,
    sha256: ref.sha256 ?? null,
    blob: ref.blob ?? null,
    name: name ?? (ref.mediaType ? `${ref.kind || 'media'}.${extOf(ref.mediaType)}` : null),
    source: source || null,
    width: ref.width ?? null,
    height: ref.height ?? null,
    duration: ref.duration ?? null,
    text: ref.text ?? null,
    error: ref.error ?? null,
  };
}

const scopeKeys = (ref) => [...new Set([...(ref?.sessionKeys ?? []), ref?.sessionKey].filter(Boolean).map(String))];
const scopeOf = (value) => typeof value === 'string' && value.length <= 512 ? value.trim() || null : null;
const short = (value, limit) => typeof value === 'string' ? value.slice(0, limit) || null : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const dateOf = (value) => number(value) > 0 ? value : null;
const MAX_OCCURRENCES = 20;
const occurrenceOf = (ref) => ({
  sessionKey: scopeOf(ref.sessionKey), name: basenameOf(ref.name),
  messageId: short(ref.messageId, 200) ?? number(ref.messageId), at: dateOf(ref.at),
  source: INLINE_PREFIX.test(String(ref.source ?? '')) ? null : short(ref.source, MAX_SOURCE_CHARS),
  text: short(ref.text, 4096), index: number(ref.index),
});
// Do not serialize the host attachment object (it can contain the full data), or copy
// other scopes into an occurrence. Keep content-level fields separate from scoped fields.
const contentOf = (row) => ({
  id: row.id, kind: short(row.kind, 20), sha256: short(row.sha256, 64),
  blob: short(row.blob, 32768), bytes: number(row.bytes), mediaType: short(row.mediaType, 200),
  attachmentId: short(row.attachmentId, 200) ?? number(row.attachmentId),
  width: number(row.width), height: number(row.height), duration: number(row.duration),
  provenance: short(row.provenance, 40), error: short(row.error, 512),
});

function addOccurrence(entry, occurrence) {
  const key = occurrence.sessionKey;
  if (!key) {
    if (!entry.unscoped || (occurrence.at ?? 0) >= (entry.unscoped.at ?? 0)) entry.unscoped = occurrence;
    return;
  }
  if (entry.scopes.has(key) && (occurrence.at ?? 0) < (entry.scopes.get(key) ?? 0)) return;
  entry.scopes.set(key, occurrence.at);
  entry.occurrences.delete(key);
  entry.occurrences.set(key, occurrence);
  if (entry.occurrences.size > MAX_OCCURRENCES) entry.occurrences.delete(entry.occurrences.keys().next().value);
}

function applyRow(index, row) {
  if (row?.op === 'drop') {
    if (Array.isArray(row.ids)) for (const id of row.ids) index.delete(String(id));
    return;
  }
  if (row?.op === 'detach') {
    const entry = index.get(String(row.id));
    if (entry) {
      const key = String(row.sessionKey);
      entry.scopes.delete(key);
      entry.occurrences.delete(key);
      entry.revision += 1;
      if (!entry.scopes.size && !entry.unscoped) index.delete(String(row.id));
    }
    return;
  }
  if (typeof row?.id !== 'string' || !row.id || (row.op && row.op !== 'put')) return;
  const next = contentOf(row);
  let entry = index.get(row.id);
  if (!entry) {
    entry = { content: next, scopes: new Map(), occurrences: new Map(), unscoped: null, liveUnscoped: null, revision: 0 };
    index.set(row.id, entry);
  } else {
    for (const [key, value] of Object.entries(next)) {
      if (value != null) entry.content[key] = value;
    }
  }
  const one = occurrenceOf(row);
  if (!row.op) {
    // Legacy full snapshots repeat earlier observations, sometimes with the first
    // scope's stale primary metadata. Recover facts from each occurrence first.
    const newKeys = [];
    if (Array.isArray(row.sessionKeys)) {
      for (const raw of row.sessionKeys) {
        const key = scopeOf(raw);
        if (key && !entry.scopes.has(key)) {
          entry.scopes.set(key, null);
          newKeys.push(key);
        }
      }
    }
    if (Array.isArray(row.occurrences)) {
      for (const item of row.occurrences) if (scopeOf(item?.sessionKey)) addOccurrence(entry, occurrenceOf(item));
    }
    // When compaction lost an occurrence, remember its first available age.
    // Do not keep refreshing it from a full snapshot's unrelated occurrences.
    for (const key of newKeys) if (entry.scopes.get(key) == null) entry.scopes.set(key, one.at);
  }
  // A legacy snapshot's primary scope at an equal timestamp can be older than
  // its matching occurrence. Do not overwrite the occurrence with that copy.
  if (row.op || !one.sessionKey || !entry.occurrences.has(one.sessionKey) ||
      (one.at ?? 0) > (entry.scopes.get(one.sessionKey) ?? 0)) addOccurrence(entry, one);
  entry.revision += 1;
}

const unscopedAt = (entry) => {
  const live = entry.liveUnscoped;
  return live && live.recordedAt === entry.unscoped?.at ? dateOf(live.at) : entry.unscoped?.at;
};
const newestAt = (entry) => {
  let latest = unscopedAt(entry);
  for (const at of entry.scopes.values()) if ((at ?? 0) > (latest ?? 0)) latest = at;
  return latest ?? null;
};
const projectEntry = (entry) => {
  const sessionKeys = [...entry.scopes.keys()];
  const occurrences = [...entry.occurrences.values()].reverse().map((one) => ({ ...one }));
  const chosen = occurrences[0] ?? entry.unscoped ?? occurrenceOf({});
  return { ...entry.content, ...chosen, at: newestAt(entry), sessionKey: chosen.sessionKey ?? sessionKeys[0] ?? null, sessionKeys, occurrences };
};

export class MediaStore {
  /**
   * @param {object} opts
   * @param {object} [opts.storage] JsonStore（取 dir 与 enabled；blob 与索引都落在它下面）
   * @param {(msg:string)=>void} [opts.log]
   * @param {(action:string, params:object)=>Promise<object>} [opts.callAction] 能力面调用（走闸门与缓存）
   * @param {Function} [opts.fetchImpl] 便于测试注入
   * @param {number} [opts.maxBytes] 单文件上限，超过就只记元信息、不落地
   * @param {number} [opts.timeoutMs] 下载/转写超时
   * @param {boolean} [opts.enabled] 总开关
   * @param {boolean} [opts.keepBytes] 是否把字节写进 `<storageDir>/media/blobs`
   * @param {boolean} [opts.transcribe] 是否尝试语音转写
   * @param {string} [opts.linkId] 上游链路 id（决定索引文件名）
   */
  constructor({
    storage = null,
    log = () => {},
    callAction = null,
    fetchImpl = null,
    maxBytes = DEFAULT_MAX_BYTES,
    imageMaxBytes = DEFAULT_IMAGE_MAX_BYTES,
    timeoutMs = 5000,
    enabled = true,
    keepBytes = true,
    transcribe = true,
    linkId = '',
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.log = log;
    this.callAction = callAction;
    this.fetchImpl = fetchImpl ?? globalThis.fetch ?? null;
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    /**
     * 生成图（我们自己产出的字节）单独一档上限：`maxBytes` 是"**下载**一条媒体最多收多少"，
     * 拿它卡生成图会造成"图生成了、模型却看不见"——没有 blob、没有 attachment，
     * `hub-media:<id>` 读回来是空。定案是生成图不受下载上限管（`m04935`），
     * 但也不能真的无上限（一张 200MB 的 PNG 会把内存和宿主登记都拖垮）。
     */
    this.imageMaxBytes = Math.max(this.maxBytes, Number(imageMaxBytes) || DEFAULT_IMAGE_MAX_BYTES);
    this.timeoutMs = Math.max(200, Number(timeoutMs) || 5000);
    this.keepBytes = keepBytes !== false;
    this.transcribeEnabled = transcribe !== false;
    this.linkId = linkId;
    this.now = now;
    this.attachments = null;
    this.enabled = enabled !== false;
    this.#index = new Map();
    this.#stats = {
      resolved: 0, degraded: 0, blobs: 0, attached: 0, transcribed: 0, bytes: 0, failed: 0, lastError: null, lastAt: null,
    };
    this.#log = this.storage?.enabled && this.keepBytes
      ? new JsonlLog({ dir: path.join(this.storage.dir, 'media'), log: this.log })
      : null;
  }

  #index;
  #stats;
  #log;
  #hydrated = false;
  #indexing = null;
  #loadingWrites = null;

  get stats() {
    return {
      enabled: this.enabled,
      keepBytes: this.keepBytes,
      transcribe: this.transcribeEnabled,
      attachments: this.attachments !== null,
      dir: this.#log ? this.#log.dir : null,
      cached: this.#index.size,
      maxBytes: this.maxBytes,
      ...this.#stats,
    };
  }

  /** 宿主 `attachments` 服务（`ctx.get('attachments')`）：有它就顺手登记一份。 */
  attach(service) {
    if (!service) return false;
    this.attachments = service;
    return true;
  }

  detach() {
    this.attachments = null;
  }

  /**
   * 已落地的媒体（新到旧），给工具与排障用。
   *
   * `allow` 是**可见性谓词**（`m85249` 审查报告 P1-3）：媒体以前是全局一张表，
   * 群会话 `list:true` 就能看到私聊图片的文件名与识图描述。现在每条落地时都盖上
   * `sessionKey`，列表按调用方能读的范围过滤；没有 `allow` 的调用（排障/内部）保持原样。
   */
  list({ limit = 20, allow = null } = {}) {
    const rows = [...this.#index.values()].map(projectEntry);
    const kept = typeof allow === 'function' ? rows.filter((row) => allow(row)) : rows;
    return kept
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, Math.max(1, limit));
  }

  /** 从审计日志重建索引。授权查询和删除必须等完整索引；新媒体落盘不用等。 */
  async ensureIndex() {
    if (this.#hydrated) return this.#index.size;
    if (!this.#log?.dir) {
      this.#hydrated = true;
      return this.#index.size;
    }
    if (this.#indexing) return this.#indexing;
    const writes = this.#loadingWrites = { tag: randomUUID(), rows: [] };
    this.#indexing = this.#loadIndex(writes)
      .catch((err) => {
        this.log(`媒体索引：重建失败（下次再试）：${err?.message ?? err}`);
        throw err;
      })
      .finally(() => {
        this.#loadingWrites = null;
        this.#indexing = null;
      });
    return this.#indexing;
  }

  async #loadIndex(writes) {
    const dir = path.join(this.#log.dir, safeName(this.linkId || 'media'));
    let files;
    try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort(); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; files = []; }
    // Build privately, then publish once. An async read may or may not see an
    // append made during this pass, including at day rollover. Skip this pass's
    // tagged puts on disk and replay them once, in commit order, at publication.
    const loaded = new Map();
    for (const f of files) {
      const text = await fs.promises.readFile(path.join(dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.loadTag !== writes.tag) applyRow(loaded, row);
      }
    }
    for (const row of writes.rows) applyRow(loaded, row);
    // Keep the live, unscoped occurrence's mutable timestamp for existing callers.
    for (const [id, entry] of this.#index) {
      if (!entry.liveUnscoped) continue;
      const hit = loaded.get(id);
      if (hit && hit.unscoped?.at === entry.liveUnscoped.recordedAt) hit.liveUnscoped = entry.liveUnscoped;
    }
    this.#index = loaded;
    this.#stats.blobs = loaded.size;
    this.#hydrated = true;
    this.#loadingWrites = null;
    return loaded.size;
  }

  /** Drop exclusive refs, detach shared ones; both operations append tombstones. */
  async purgeScope(scope, { dryRun = false } = {}) {
    const target = String(scope ?? '').trim();
    if (!target) return { ok: false, error: '没给会话键，删不了', refs: 0 };
    // 重启过的进程索引是空的：先把审计日志读回来，否则这里会"删 0 条"然后什么都不做。
    try { await this.ensureIndex(); }
    catch (err) { return { ok: false, target, refs: 0, error: `媒体索引加载失败：${err?.message ?? err}` }; }
    const drop = [];
    const detach = [];
    for (const [id, entry] of this.#index) {
      if (!entry.scopes.has(target)) continue;
      if (entry.scopes.size === 1) drop.push({ id, blob: entry.content.blob });
      else detach.push(id);
    }
    if (dryRun) return { ok: true, dryRun: true, refs: drop.length + detach.length, blobs: drop.length, shared: detach.length, target };

    let freed = 0;
    const failed = [];
    const droppedIds = [];
    const detached = [];
    // 同步提交短事务：检查当前归属、删除文件、追加标记、更新内存之间不让出。
    // 不重写日志，也不会把并发 resolve 新添的那次归属一起删掉。
    for (const { id, blob } of drop) {
      try {
        let bytes = 0;
        if (blob) {
          try { bytes = fs.statSync(blob).size; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
          fs.rmSync(blob, { force: true });
        }
        this.#markLog({ op: 'drop', ids: [id] });
        freed += bytes;
        droppedIds.push(id);
      } catch (err) {
        // 文件或标记写失败均保留索引，可在下次清理继续定位并重试。
        failed.push({ id, error: String(err?.message ?? err) });
      }
    }
    for (const id of detach) {
      try {
        this.#markLog({ op: 'detach', id, sessionKey: target });
        detached.push(id);
      } catch (err) { failed.push({ id, error: String(err?.message ?? err) }); }
    }
    this.#stats.blobs = this.#index.size;
    this.log(
      `[media] 按会话清理：${target} 删掉 ${droppedIds.length} 条（共用 ${detach.length} 条摘归属），回收 ${freed} 字节`
      + (failed.length ? `，${failed.length} 项没做成` : ''),
    );
    return {
      ok: failed.length === 0,
      error: failed.length ? `${failed.length} 项没做成（${failed[0]?.id ?? failed[0]?.file}）：${failed[0]?.error ?? ''}` : null,
      target,
      refs: droppedIds.length + detached.length,
      blobs: droppedIds.length,
      shared: detach.length,
      bytes: freed,
      failed,
    };
  }

  /** 只公开可读那次出现的元数据，不能把私聊首次出现的字段铺回群列表。 */
  visibleRef(ref, { allow = () => true, preferred = '' } = {}) {
    const keys = scopeKeys(ref).filter(allow);
    if (!keys.length) return null;
    const occurrences = ref.occurrences ?? (ref.sessionKey ? [occurrenceOf(ref)] : []);
    const readable = new Set(keys);
    const chosen = occurrences.find((one) => one.sessionKey === preferred && readable.has(one.sessionKey))
      ?? (preferred && readable.has(preferred) ? { sessionKey: preferred } : occurrences.find((one) => readable.has(one.sessionKey)));
    return {
      id: ref.id, kind: ref.kind, blob: ref.blob, bytes: ref.bytes, mediaType: ref.mediaType,
      sha256: ref.sha256, attachmentId: ref.attachmentId, error: ref.error ?? null,
      sessionKeys: keys, sessionKey: chosen?.sessionKey ?? keys[0],
      name: chosen?.name ?? null, messageId: chosen?.messageId ?? null, at: chosen?.at ?? null,
      source: chosen?.source ?? null, text: chosen?.text ?? null, index: chosen?.index ?? null,
    };
  }

  /** 按 `hub-media:<id>` / `<id>` 取一条已落地的媒体引用（给工具回原文用；没有返回 null）。 */
  find(id) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const entry = this.#index.get(key);
    return entry ? projectEntry(entry) : null;
  }

  /** Age ownership by genuine occurrences, never by a read-only reuse. */
  async prune({ days = 0, chunk = 200 } = {}) {
    const d = Number(days);
    if (!(d > 0) || !this.enabled) return { skipped: true, days: d, removed: 0, bytes: 0 };
    const cutoff = this.now() - d * 86400000;
    try { await this.ensureIndex(); }
    catch (err) {
      return { ok: false, days: d, cutoff, removed: 0, dropped: 0, bytes: 0, error: `媒体索引加载失败：${err?.message ?? err}` };
    }
    const step = Math.max(1, Math.floor(Number(chunk) || 200));
    let removed = 0;
    let dropped = 0;
    let detached = 0;
    let freed = 0;
    const failed = [];
    const noteFailure = (id, err) => failed.push({ id, error: String(err?.message ?? err) });
    const stat = async (file) => {
      if (!file) return {};
      try { return { st: await fs.promises.stat(file) }; }
      catch (err) { return err?.code === 'ENOENT' ? { missing: true } : { err }; }
    };
    const ids = [...this.#index.keys()];
    for (let i = 0; i < ids.length; i += step) {
      const batch = await Promise.all(ids.slice(i, i + step).map(async (id) => {
        const entry = this.#index.get(id);
        return { id, entry, revision: entry?.revision, ...(await stat(entry?.content.blob)) };
      }));
      for (const { id, entry, revision, st, missing, err } of batch) {
        // An actual save or another cleanup may have committed during the stat.
        if (!entry || this.#index.get(id) !== entry || entry.revision !== revision) continue;
        if (err) { noteFailure(id, err); continue; }
        const expired = (at) => (at ?? st?.mtimeMs ?? Infinity) < cutoff;
        const stale = [];
        for (const [scope, at] of entry.scopes) if (expired(at)) stale.push(scope);
        try {
          // Missing (already pruned by an earlier version) and expired IDs must
          // stay gone after restart. Commit markers before the orphan sweep.
          if (missing || (stale.length === entry.scopes.size && (!entry.unscoped || expired(unscopedAt(entry))))) {
            this.#markLog({ op: 'drop', ids: [id] });
            dropped += 1;
          } else {
            for (const sessionKey of stale) {
              this.#markLog({ op: 'detach', id, sessionKey });
              detached += 1;
            }
          }
        } catch (err) { noteFailure(id, err); }
      }
      if (i + step < ids.length) await yieldLoop();
    }
    if (this.#log) {
      const dir = path.join(this.storage.dir, 'media', 'blobs');
      let files = [];
      try { files = await fs.promises.readdir(dir); }
      catch (err) { if (err?.code !== 'ENOENT') noteFailure(dir, err); }
      const retained = new Set([...this.#index.values()].map((entry) => entry.content.blob));
      for (let i = 0; i < files.length; i += step) {
        const batch = await Promise.all(files.slice(i, i + step).map(async (file) => {
          const full = path.join(dir, file);
          return { file, full, ...(await stat(full)) };
        }));
        for (const { file, full, st, err } of batch) {
          if (err) { noteFailure(full, err); continue; }
          if (!st?.isFile() || st.mtimeMs >= cutoff || retained.has(full)) continue;
          const id = /^([0-9a-f]{12})[0-9a-f]{52}\./.exec(file)?.[1];
          // The retained snapshot protects older paths; recheck the content
          // address before unlinking in case a new write committed since it.
          if (id && this.#index.get(`hub-media:${id}`)?.content.blob === full) continue;
          try {
            // Another upstream link can use this shared blob without changing
            // our index. Check its mtime again before the synchronous unlink.
            const current = fs.statSync(full);
            if (!current.isFile() || current.mtimeMs >= cutoff) continue;
            fs.rmSync(full);
            removed += 1;
            freed += current.size;
          } catch (err) { if (err?.code !== 'ENOENT') noteFailure(full, err); }
        }
        if (i + step < files.length) await yieldLoop();
      }
    }
    this.#stats.blobs = this.#index.size;
    this.#stats.pruned = (this.#stats.pruned ?? 0) + removed;
    const error = failed[0] ? `媒体清理失败（${failed[0].id}）：${failed[0].error}` : null;
    if (error) this.log(error);
    return { ok: !error, days: d, cutoff, removed, dropped, detached, bytes: freed, error, failed };
  }

  /**
   * 落一条媒体段。
   * @returns {Promise<object>} ref（失败时带 `error`，`id` 为 null——调用方照常渲染占位）
   */
  async resolve(seg, { messageId = null, index = null, sessionKey = null, allow = null } = {}) {
    const kind = String(seg?.type ?? '');
    if (!['image', 'record', 'video', 'file'].includes(kind)) return null;
    const data = seg?.data ?? {};
    const at = this.now();
    // `file`/`url` 有可能是**整份内联字节**（base64://…）。名字与来源必须按"人读的一行"来取，
    // 绝不能把 16 万字符的 base64 存进索引（那会一路漏进 onebot_raw 的工具结果）。
    const rawSource = data.url ?? data.file ?? null;
    const inline = INLINE_PREFIX.test(String(rawSource ?? ''));
    /**
     * 把一个**已经落地过**的引用再当来源用（`onebot_media{link:'hub-media:私聊那张'}`）。
     *
     * 字节是同一份（id 就是 sha256），所以这次不能顺手给它盖上本会话的归属（第三轮 T03）：
     * 否则群会话拿一次私聊的引用，就把那张图重新登记成了自己也能读的东西。
     * 归属只由真正收到它的那次决定。
     */
    const reusing = typeof rawSource === 'string' && rawSource.startsWith('hub-media:');
    if (reusing) {
      try { await this.ensureIndex(); }
      catch (err) { return { id: null, error: `媒体索引加载失败：${err?.message ?? err}` }; }
      const existing = this.find(rawSource);
      if (!existing) return { id: null, error: '媒体引用不存在或已清理' };
      if (!sessionKey && typeof allow !== 'function') return { ...existing, provenance: 'hub-media' }; // 宿主内部引用，不增加归属
      const allowed = typeof allow === 'function' ? allow : (key) => !sessionKey || key === sessionKey;
      const visible = this.visibleRef(existing, { allow: allowed, preferred: sessionKey });
      return visible ?? { id: null, error: '媒体归属不在这个会话能读的范围里' };
    }
    const ref = {
      id: null,
      kind,
      at,
      messageId,
      index,
      // 归属（`m85249` P1-3）：这条媒体是在哪个会话里落地的。没有它，列表就是一张
      // 跨会话的大表——群会话能看见私聊的图片名与识图描述。
      sessionKey: scopeOf(sessionKey),
      sessionKeys: scopeOf(sessionKey) ? [scopeOf(sessionKey)] : [],
      name: String(data.name ?? '').trim().slice(0, MAX_NAME_CHARS) || basenameOf(rawSource),
      source: inline ? null : String(rawSource ?? '').slice(0, MAX_SOURCE_CHARS) || null,
      inline,
      mediaType: null,
      bytes: null,
      sha256: null,
      blob: null,
      attachmentId: null,
      attachment: null,
      width: null,
      height: null,
      duration: Number(data.duration ?? data.seconds) || null,
      text: null,
      provenance: 'segment',
      error: null,
    };
    if (!this.enabled) {
      ref.error = 'media.enabled=false';
      return ref;
    }
    try {
      const fetched = await this.#readBytes({ kind, raw: rawSource, messageId });
      if (fetched?.error) {
        ref.error = fetched.error;
        ref.provenance = fetched.provenance ?? 'segment';
        this.#stats.degraded += 1;
        return ref;
      }
      if (!fetched) {
        ref.error = '拿不到字节（也没有可用的 URL）';
        ref.provenance = 'segment';
        this.#stats.degraded += 1;
        return ref;
      }
      const bytes = fetched.data;
      const sniffed = kind === 'image' ? sniffType(bytes) : { ...sniffType(bytes), mediaType: fetched.mediaType ?? sniffType(bytes).mediaType };
      ref.mediaType = (bytes.length && sniffed.sniffed ? sniffed.mediaType : null) ?? fetched.mediaType ?? guessTypeFromName(ref.name) ?? sniffed.mediaType;
      ref.bytes = bytes.length;
      ref.sha256 = createHash('sha256').update(bytes).digest('hex');
      ref.id = `hub-media:${ref.sha256.slice(0, 12)}`;
      ref.provenance = fetched.provenance;
      // 名字兜底：内联来的一张图连文件名都没有，就按"图片/png"这种人类说法补一个短名，
      // 免得 `name` 为空让附件登记和工具回执都缺一个能看的东西。
      if (!ref.name && ref.mediaType) ref.name = `${kind}.${extOf(ref.mediaType)}`;
      if (inline) ref.source = `inline:${ref.mediaType ?? 'application/octet-stream'}`;

      // 顺手登记到宿主 attachments：登记之后，DSH 的模型是真能看到这张图的
      if (this.attachments && (kind === 'image' || bytes.length <= this.maxBytes)) {
        try {
          const input = { data: bytes, mediaType: ref.mediaType, name: ref.name ?? undefined };
          const saved = kind === 'image' && typeof this.attachments.saveImage === 'function'
            ? await this.attachments.saveImage(input)
            : typeof this.attachments.saveFile === 'function'
              ? await this.attachments.saveFile(input)
              : null;
          const one = Array.isArray(saved) ? saved[0] : saved;
          if (one) {
            ref.attachmentId = one.attachmentId ?? one.id ?? null;
            ref.width = one.width ?? null;
            ref.height = one.height ?? null;
            // 整份 ref 留一份：看图（`lib/vision.js`）直接用它做 `{type:'image', attachment}`，
            // 不用为了同一张图再登记一次。
            ref.attachment = one;
            this.#stats.attached += 1;
          }
        } catch (err) {
          this.log(`media 登记到宿主 attachments 失败（不影响转发）：${err?.message ?? err}`);
        }
      }
      if (kind !== 'image' && bytes.length > this.maxBytes) {
        ref.error = `超过上限（${bytes.length} > ${this.maxBytes} 字节），只记元信息`;
        this.#stats.degraded += 1;
      }

      // 语音：优先实现端扩展，拿不到就诚实标注（不猜内容）
      if (kind === 'record' || kind === 'video') {
        const asr = await this.transcribe({ ref, seg });
        if (asr?.text) {
          ref.text = asr.text;
          ref.asrVia = asr.via;
          this.#stats.transcribed += 1;
        } else if (asr?.note) {
          ref.asrNote = asr.note;
        }
      }

      // Commit the blob and its journal row together after any awaited work.
      // Prune/purge can't remove a blob between this write and its occurrence.
      // Images keep their existing download/persistence ceiling.
      if (this.#log && (kind === 'image' || bytes.length <= this.maxBytes)) {
        try {
          this.#writeBlob(ref, bytes);
          this.#stats.bytes += bytes.length;
        } catch (err) {
          this.log(`媒体 blob 落盘失败（不影响转发）：${err?.message ?? err}`);
        }
      }
      this.#remember(ref);
      this.#stats.resolved += 1;
      this.#stats.lastAt = at;
      return ref;
    } catch (err) {
      ref.id = null;
      ref.error = String(err?.message ?? err);
      this.#stats.failed += 1;
      this.#stats.lastError = ref.error;
      this.log(`媒体落地失败（不影响转发）：${ref.error}`);
      return ref;
    }
  }

  /**
   * 一条消息里的所有媒体段。
   * @returns {Promise<{refs: Map<number,object>, records: object[]}>}
   */
  async resolveEvent(segments, { messageId = null, sessionKey = null } = {}) {
    const refs = new Map();
    const records = [];
    const list = Array.isArray(segments) ? segments : [];
    for (let i = 0; i < list.length; i += 1) {
      const seg = list[i];
      if (!seg || !['image', 'record', 'video', 'file'].includes(seg.type)) continue;
      const ref = await this.resolve(seg, { messageId, index: i, sessionKey });
      if (!ref) continue;
      refs.set(i, ref);
      records.push(ref);
    }
    return { refs, records };
  }

  /** 语音转写：走实现端扩展（§22.6），两个都试；都不行就返回一句诚实的话。 */
  async transcribe({ ref, seg = null } = {}) {
    if (!this.transcribeEnabled || typeof this.callAction !== 'function') return null;
    const messageId = ref?.messageId ?? null;
    // `source` 现在可能是 `inline:audio/amr` 这种"字节就在段里"的记号——那不是实现端认识的
    // `file`，硬塞回去只会得到一句莫名其妙的失败，所以内联来源就不给 file。
    const inlineSource = /^inline:/i.test(String(ref?.source ?? ''));
    const file = seg?.data?.url ?? seg?.data?.file ?? (inlineSource ? null : ref?.source) ?? null;
    const tried = [];
    for (const action of ['fetch_ptt_text', 'voice_msg_to_text']) {
      try {
        const res = await this.callAction(action, { message_id: messageId, file, id: messageId });
        if (res?.ok) {
          const data = res.data;
          const text = typeof data === 'string' ? data : data?.text ?? data?.message ?? data?.result ?? null;
          if (text) return { text: String(text), via: action };
          tried.push(`${action}: 实现端返回成功但没给文本`);
        } else {
          tried.push(`${action}: ${res?.note ?? `retcode ${res?.retcode}`}`);
        }
      } catch (err) {
        tried.push(`${action}: ${err?.message ?? err}`);
      }
    }
    return { text: null, note: tried.join('；') || '实现端不支持语音转写' };
  }

  /**
   * 把"一句参考图写法"读成字节（图生图等下游用途）。
   *
   * 认这些写法（都沿用本模块既有的那套解析，不另立一套）：
   * `data:image/...;base64,…` / `base64://…` / `http(s)://…` / `file://…` / 本地路径 /
   * `hub-media:<id>`（已经落地过的 ref，直接读它的 blob）。
   *
   * 与 `resolve()` 的区别：**不落盘、不登记、不改任何状态**——它只回答"这串字节能拿到吗"。
   * 拿不到时返回 `{ error }` 而不是 null，调用方才能把原因说给模型听（静默丢参考图
   * 会让一次"图生图"悄悄变成"文生图"，用户只会觉得"参考图没起作用"）。
   *
   * @param {string} link 参考图写法
   * @param {{kind?:string}} [opts]
   * @returns {Promise<{bytes:Buffer, mediaType:string|null, provenance:string}|{error:string}>}
   */
  async readRef(link, { kind = 'image' } = {}) {
    const raw = typeof link === 'string' ? link.trim() : '';
    if (!raw) return { error: '参考图是空的' };

    if (raw.startsWith('hub-media:')) {
      try { await this.ensureIndex(); }
      catch (err) { return { error: `媒体索引加载失败：${err?.message ?? err}` }; }
      const hit = this.#index.get(raw)?.content;
      const file = hit?.blob ?? null;
      if (!file) return { error: `找不到已落地的媒体 ${raw}（它的字节可能没留下）` };
      const got = this.#readLocal(file, kind);
      if (!got?.data) return { error: got?.error ?? `读取 ${raw} 失败` };
      return { bytes: got.data, mediaType: hit.mediaType ?? got.mediaType ?? null, provenance: 'hub-media' };
    }

    const inline = this.#decodeInline(raw);
    if (inline) return { bytes: inline.data, mediaType: inline.mediaType, provenance: 'inline' };

    if (isHttp(raw)) {
      const got = await this.#download(raw, kind);
      if (!got?.data) return { error: got?.error ?? '下载参考图失败' };
      return { bytes: got.data, mediaType: got.mediaType ?? sniffType(got.data).mediaType, provenance: 'remote' };
    }

    const local = /^file:\/\//i.test(raw)
      ? decodeURIComponent(raw.replace(/^file:\/\//i, ''))
      : /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : null;
    if (local) {
      const got = this.#readLocal(local, kind);
      if (!got?.data) return { error: got?.error ?? '读本地参考图失败' };
      return { bytes: got.data, mediaType: got.mediaType ?? sniffType(got.data).mediaType, provenance: 'local' };
    }

    return { error: '认不出的参考图写法（要 URL / data: 或 base64:// / 本地路径 / hub-media:<id>）' };
  }

  /** 字节落地到自己的 blob 目录（供工具/测试直接调用）。 */
  async saveBytes(bytes, { mediaType = null, name = null, kind = 'file', sessionKey = '' } = {}) {
    const sniffed = sniffType(bytes);
    // 声明类型与字节魔数打架时信字节：上游给什么格式由它说了算（生成图上游标错类型的
    // 兜底——豆包回 JPEG 却带着 image/png 的声明，宿主登记会被当场拒绝）。只在两边都是
    // image/* 且嗅探确定命中时改判，其余场景保留调用方声明（嗅探没命中≠声明错了）。
    let type = mediaType ?? sniffed.mediaType;
    if (
      mediaType && sniffed.sniffed && mediaType !== sniffed.mediaType &&
      String(mediaType).startsWith('image/') && sniffed.mediaType.startsWith('image/')
    ) {
      type = sniffed.mediaType;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ceiling = kind === 'image' ? this.imageMaxBytes : this.maxBytes;
    const ref = {
      id: `hub-media:${sha256.slice(0, 12)}`,
      kind,
      at: this.now(),
      name,
      mediaType: type,
      bytes: bytes.length,
      sha256,
      blob: null,
      attachmentId: null,
      provenance: 'bytes',
      // 归属（复审 F03）：生成的图以前谁都不认领，列表就把它当成"当前会话的"，
      // 于是群会话能看见私聊生成图的元数据。产出方必须报门牌。
      ...(scopeOf(sessionKey) ? { sessionKey: scopeOf(sessionKey), sessionKeys: [scopeOf(sessionKey)] } : {}),
    };
    // 顺手登记到宿主 attachments（`resolve()` 同款）：生成图也要"DSH 的模型真能看到"——
    // 看图（`lib/vision.js`）直接吃 `ref.attachment`，别让同一张图再登记一次。
    if (this.attachments && bytes.length <= ceiling) {
      try {
        if (!ref.name && ref.mediaType) ref.name = `${kind}.${extOf(ref.mediaType)}`;
        const input = { data: bytes, mediaType: ref.mediaType, name: ref.name ?? undefined };
        const saved = kind === 'image' && typeof this.attachments.saveImage === 'function'
          ? await this.attachments.saveImage(input)
          : typeof this.attachments.saveFile === 'function'
            ? await this.attachments.saveFile(input)
            : null;
        const one = Array.isArray(saved) ? saved[0] : saved;
        if (one) {
          ref.attachmentId = one.attachmentId ?? one.id ?? null;
          ref.width = one.width ?? null;
          ref.height = one.height ?? null;
          ref.attachment = one;
          this.#stats.attached += 1;
        }
      } catch (err) {
        this.log(`media 登记到宿主 attachments 失败（不影响落地）：${err?.message ?? err}`);
      }
    }
    if (this.#log && bytes.length <= ceiling) this.#writeBlob(ref, bytes);
    this.#remember(ref);
    return ref;
  }

  #writeBlob(ref, bytes) {
    const blobDir = path.join(this.storage.dir, 'media', 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    const target = path.join(blobDir, `${ref.sha256}.${extOf(ref.mediaType)}`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    else {
      // Bytes are shared across upstream link IDs, while ownership journals
      // are not. Refresh the file only on an actual ingestion, not a ref read.
      const time = this.now() / 1000;
      try { fs.utimesSync(target, time, time); }
      catch (err) { this.log(`媒体 blob 更新时间失败：${err?.message ?? err}`); }
    }
    ref.blob = target;
  }

  /** 追加一条删除标记（`op:'drop'` 整条丢 / `op:'detach'` 只摘归属）。 */
  #markLog(row) {
    const time = this.now();
    if (this.#log && !this.#log.append(this.linkId || 'media', { ...row, opAt: time }, time)) {
      throw new Error('媒体清理标记写入失败');
    }
    applyRow(this.#index, row);
  }

  #remember(ref) {
    if (!ref?.id) return;
    const loading = this.#loadingWrites;
    const row = { op: 'put', ...contentOf(ref), ...occurrenceOf(ref), ...(loading ? { loadTag: loading.tag } : {}) };
    // Append a single occurrence, using commit day (not the occurrence day).
    if (this.#log && !this.#log.append(this.linkId || 'media', row, this.now())) {
      throw new Error(`媒体索引写入失败：${ref.id}`);
    }
    loading?.rows.push(row);
    applyRow(this.#index, row);
    const entry = this.#index.get(ref.id);
    if (!row.sessionKey && entry.unscoped?.at === row.at) {
      // Older callers can adjust the returned unscoped ref's in-memory age.
      // Share only that scalar, not a ref that may hold a large attachment.
      const live = entry.liveUnscoped = { at: ref.at, recordedAt: row.at };
      Object.defineProperty(ref, 'at', {
        enumerable: true, configurable: true,
        get: () => live.at,
        set: (value) => { live.at = value; },
      });
    }
    this.#stats.blobs = this.#index.size;
  }

  /**
   * 这条媒体是谁的（复审 F03）：给 `hub-media:` 引用做读权限检查用。
   *
   * 返回 `null` 表示"这不是 hub-media 引用"（调用方不必管）；`found:false` 是认得出形状
   * 但索引里没有——那种也别替它背书，调用方按"未知归属"处理。
   *
   * @param {string} id
   * @returns {{found:boolean, sessionKeys:string[], occurrences:Array<object>, mediaType:string|null}|null}
   */
  ownersOf(id) {
    const key = String(id ?? '').trim();
    if (!key.startsWith('hub-media:')) return null;
    const hit = this.find(key);
    if (!hit) return { found: false, sessionKeys: [], occurrences: [], mediaType: null };
    return { found: true, sessionKeys: hit.sessionKeys, occurrences: hit.occurrences, mediaType: hit.mediaType };
  }

  /** 取新字节：base64 / data: / http(s) / 本地路径 / 先用 get_image·get_record 换 URL 再取。 */
  async #readBytes({ kind, raw, messageId }) {
    const inline = this.#decodeInline(raw);
    if (inline) return inline;

    if (typeof raw === 'string' && isHttp(raw)) {
      const got = await this.#download(raw, kind);
      return got;
    }
    if (typeof raw === 'string' && /^file:\/\//i.test(raw)) {
      return this.#readLocal(decodeURIComponent(raw.replace(/^file:\/\//i, '')), kind);
    }
    if (typeof raw === 'string' && /^[A-Za-z]:[\\/]|^\//.test(raw)) {
      return this.#readLocal(raw, kind);
    }

    // 最后一条路：让实现端把文件换成一个 URL（这一步走能力面，受闸门与实测结论约束）
    if (typeof this.callAction === 'function') {
      const action = kind === 'image' ? 'get_image' : kind === 'record' ? 'get_record' : 'get_file';
      const res = await this.callAction(action, { message_id: messageId, file: raw });
      if (res?.ok && res.data) {
        const url = res.data.url ?? res.data.file ?? res.data.path ?? null;
        if (typeof url === 'string' && isHttp(url)) return this.#download(url, kind);
        if (typeof url === 'string' && url) return this.#readLocal(url, kind);
      }
    }
    return null;
  }

  #decodeInline(raw) {
    if (typeof raw !== 'string') return null;
    const b64 = raw.startsWith('base64://') ? raw.slice('base64://'.length) : null;
    if (b64) {
      const data = Buffer.from(b64, 'base64');
      return { data, mediaType: sniffType(data).mediaType, provenance: 'inline' };
    }
    const m = /^data:([^;,]+);base64,(.*)$/i.exec(raw);
    if (m) {
      const data = Buffer.from(m[2], 'base64');
      return { data, mediaType: m[1], provenance: 'inline' };
    }
    return null;
  }

  /**
   * 边下边数，**超过 ceiling 就立刻停**。
   *
   * 以前是 `await res.arrayBuffer()` 一把梭：`content-length` 超限也照读（注释说"要算 sha256
   * 就得有字节"），但 2GB 的响应会在这一步直接把进程打死——OOM 不可 catch。
   * 现在按流读，超过上限就 `cancel()` 并如实回报"超限"，调用方按元信息处理。
   */
  async #readCapped(res, ceiling) {
    const limit = Math.max(1024, Number(ceiling) || DEFAULT_MAX_BYTES);
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer());
      return { data: buf, over: buf.length > limit };
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.length ?? 0;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            /* 取消失败不影响结论 */
          }
          return { data: null, over: true, bytes: total };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* 已释放 */
      }
    }
    return { data: Buffer.concat(chunks), over: false };
  }

  async #download(url, kind) {
    if (typeof this.fetchImpl !== 'function') return { error: '运行环境没有 fetch，无法下载媒体', provenance: 'remote' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    // 图片按用户定案不受 maxBytes 约束（上限掐的是 blob 落盘），但下载本身仍要有硬天花板：
    // 比 maxBytes 宽一个数量级，够放下常见大图，又不至于让一张恶意文件把内存吃光。
    const ceiling = kind === 'image' ? Math.max(this.maxBytes * 8, 64 * 1024 * 1024) : this.maxBytes;
    try {
      const res = await this.fetchImpl(url, { signal: controller?.signal });
      if (!res?.ok) return { error: `下载失败：HTTP ${res?.status ?? '?'}`, provenance: 'remote' };
      const declared = Number(res.headers?.get?.('content-length') ?? 0);
      const mediaType = res.headers?.get?.('content-type')?.split(';')[0] ?? null;
      if (declared && declared > ceiling) {
        try {
          if (controller) controller.abort();
        } catch {
          /* 忽略 */
        }
        return { error: `文件过大（声明 ${declared} 字节 > 上限 ${ceiling}），不下载`, mediaType, provenance: 'remote' };
      }
      const got = await this.#readCapped(res, ceiling);
      if (got.over) return { error: `文件过大（超过上限 ${ceiling} 字节），不下载`, mediaType, provenance: 'remote' };
      return { data: got.data, mediaType, provenance: 'remote' };
    } catch (err) {
      return { error: `下载失败：${err?.message ?? err}`, provenance: 'remote' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #readLocal(file, kind) {
    try {
      const stat = fs.statSync(file);
      // 以前只掐非图片（`kind !== 'image'`），于是"读一张 5GB 的图片"直接读进内存。
      // 图片的天花板与下载侧同口径，其它类型仍按 maxBytes × 4（转码前的余量）。
      const ceiling = kind === 'image' ? Math.max(this.maxBytes * 8, 64 * 1024 * 1024) : this.maxBytes * 4;
      if (stat.size > ceiling) return { error: `本地文件过大（${stat.size} 字节 > 上限 ${ceiling}）`, provenance: 'local' };
      const data = fs.readFileSync(file);
      return { data, mediaType: guessTypeFromName(file), provenance: 'local' };
    } catch (err) {
      return { error: `读本地文件失败：${err?.message ?? err}`, provenance: 'local' };
    }
  }
}

export { extOf };
