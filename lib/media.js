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
import { createHash } from 'node:crypto';
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
const occurrenceOf = (ref) => ({
  sessionKey: ref.sessionKey, name: ref.name ?? null, messageId: ref.messageId ?? null,
  at: ref.at ?? null, source: ref.source ?? null, text: ref.text ?? null, index: ref.index ?? null,
});
const mergeRef = (prev, row) => {
  if (!prev) { row.sessionKeys = scopeKeys(row); return row; }
  const occurrences = [...(prev.occurrences ?? [])];
  for (const one of [prev.sessionKey ? occurrenceOf(prev) : null, ...(row.occurrences ?? []), row.sessionKey ? occurrenceOf(row) : null]) {
    if (!one?.sessionKey) continue;
    const at = occurrences.findIndex((x) => x.sessionKey === one.sessionKey);
    if (at >= 0) occurrences[at] = { ...occurrences[at], ...one };
    else occurrences.push({ ...one });
  }
  return { ...prev, sessionKeys: [...new Set([...scopeKeys(prev), ...scopeKeys(row)])], occurrences: occurrences.slice(-20),
    blob: row.blob ?? prev.blob, attachmentId: row.attachmentId ?? prev.attachmentId };
};
const detachRef = (ref, scope) => {
  const keys = scopeKeys(ref).filter((key) => key !== scope);
  const occurrences = (ref.occurrences ?? []).filter((one) => one.sessionKey !== scope);
  const chosen = ref.sessionKey === scope ? occurrences.find((one) => keys.includes(one.sessionKey)) : occurrenceOf(ref);
  return { ...ref, name: null, messageId: null, source: null, text: null, index: null, at: null,
    ...(chosen ?? {}), sessionKey: chosen?.sessionKey ?? keys[0] ?? null, sessionKeys: keys, occurrences };
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
    this.#meta = new Map();
    this.#stats = {
      resolved: 0, degraded: 0, blobs: 0, attached: 0, transcribed: 0, bytes: 0, failed: 0, lastError: null, lastAt: null,
    };
    this.#log = this.storage?.enabled && this.keepBytes
      ? new JsonlLog({ dir: path.join(this.storage.dir, 'media'), log: this.log })
      : null;
  }

  #index;
  #meta;
  #stats;
  #log;
  #hydrated = false;
  #indexing = null;

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
    const rows = [...this.#index.values()];
    const kept = typeof allow === 'function' ? rows.filter((row) => allow(row)) : rows;
    return kept
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, Math.max(1, limit));
  }

  /**
   * 按会话删掉媒体（审查报告"按会话清理与导出"，`m85685`）。
   *
   * 两种情形分开处理：**只属于这个会话**的，连 blob 文件一起删、索引里也去掉；
   * **多个会话共用**同一份字节的（内容寻址，见 `#remember`），只把它从归属集合里摘掉——
   * 另一个会话还得看得见自己发过的图。
   *
   * 顺带重写审计日志（`<storageDir>/media/<linkId>/<day>.jsonl`）：那份是 append-only，
   * 不重写的话"删掉的图名"会一直躺在里面。
   */
  /**
   * 从审计日志把索引读回来（复审 F08）。
   *
   * 索引本来只在内存里：重启之后 `#index` 是空的，于是 `purgeScope()` 数出来 0 条、
   * 回一句"删了 0 条"，blob 原封不动躺在盘上——**重启过的进程永远清不掉旧数据**。
   * 审计日志（`media/<linkId>/<day>.jsonl`）本来就是每次落地写的，正好拿来重建。
   */
  async ensureIndex() {
    if (this.#hydrated) return this.#index.size;
    /**
     * 并发调用要共用同一次加载（第三轮 T06）：以前进门就置 `#hydrated = true`，
     * 第二个调用看到置位就直接按"空索引"返回——两个清理任务同时跑时，一个在读盘、
     * 另一个已经开始删了。现在共享同一份 Promise，成功之后才置位（失败还能重试）。
     */
    if (this.#indexing) return this.#indexing;
    this.#indexing = this.#loadIndex()
      .then((n) => {
        this.#hydrated = true;
        return n;
      })
      .catch((err) => {
        this.log(`媒体索引：重建失败（下次再试）：${err?.message ?? err}`);
        throw err;
      })
      .finally(() => {
        this.#indexing = null;
      });
    return this.#indexing;
  }

  async #loadIndex() {
    if (!this.#log?.dir) return this.#index.size;
    const dir = path.join(this.#log.dir, safeName(this.linkId || 'media'));
    let files;
    try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort(); }
    catch (err) { if (err?.code === 'ENOENT') return this.#index.size; throw err; }
    // 全部读完才发布；读到一半失败时，不把半张索引留给下一次调用。
    const loaded = new Map();
    for (const f of files) {
      const text = await fs.promises.readFile(path.join(dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.op === 'drop') {
          for (const id of row.ids ?? []) loaded.delete(String(id));
        } else if (row?.op === 'detach') {
          const hit = loaded.get(String(row.id));
          if (hit) loaded.set(String(row.id), detachRef(hit, String(row.sessionKey)));
        } else if (row?.id) loaded.set(row.id, mergeRef(loaded.get(row.id), row));
      }
    }
    // 所有落地路径先等 ensureIndex，因此这里不会吞掉加载期间新写的记录。
    for (const [id, ref] of this.#index) loaded.set(id, mergeRef(loaded.get(id), ref));
    this.#index = loaded;
    this.#meta = new Map(loaded);
    this.#stats.blobs = loaded.size;
    return loaded.size;
  }

  async purgeScope(scope, { dryRun = false } = {}) {
    const target = String(scope ?? '').trim();
    if (!target) return { ok: false, error: '没给会话键，删不了', refs: 0 };
    // 重启过的进程索引是空的：先把审计日志读回来，否则这里会"删 0 条"然后什么都不做。
    try { await this.ensureIndex(); }
    catch (err) { return { ok: false, target, refs: 0, error: `媒体索引加载失败：${err?.message ?? err}` }; }
    const drop = [];
    const detach = [];
    for (const [id, ref] of this.#index.entries()) {
      const keys = Array.isArray(ref?.sessionKeys) && ref.sessionKeys.length
        ? ref.sessionKeys.map(String)
        : [String(ref?.sessionKey ?? '')];
      if (!keys.includes(target)) continue;
      if (keys.filter((k) => k && k !== target).length === 0) drop.push({ id, ref });
      else detach.push({ id, ref, keys });
    }
    if (dryRun) return { ok: true, dryRun: true, refs: drop.length + detach.length, blobs: drop.length, shared: detach.length, target };

    let freed = 0;
    const failed = [];
    const droppedIds = [];
    const detached = [];
    // 同步提交短事务：检查当前归属、删除文件、追加标记、更新内存之间不让出。
    // 不重写日志，也不会把并发 resolve 新添的那次归属一起删掉。
    for (const { id, ref } of drop) {
      const blob = String(ref?.blob ?? '');
      try {
        let bytes = 0;
        if (blob) {
          try { bytes = fs.statSync(blob).size; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
          fs.rmSync(blob, { force: true });
        }
        this.#markLog({ op: 'drop', ids: [id] });
        this.#index.delete(id);
        this.#meta.delete(id);
        freed += bytes;
        droppedIds.push(id);
      } catch (err) {
        // 文件或标记写失败均保留索引，可在下次清理继续定位并重试。
        failed.push({ id, error: String(err?.message ?? err) });
      }
    }
    for (const { id, ref } of detach) {
      try {
        this.#markLog({ op: 'detach', id, sessionKey: target });
        const kept = detachRef(ref, target);
        this.#index.set(id, kept);
        this.#meta.set(id, kept);
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
    const occurrences = [...(ref.occurrences ?? [])];
    if (ref.sessionKey && !occurrences.some((one) => one.sessionKey === ref.sessionKey)) occurrences.push(occurrenceOf(ref));
    const chosen = occurrences.find((one) => one.sessionKey === preferred && keys.includes(one.sessionKey))
      ?? occurrences.find((one) => keys.includes(one.sessionKey));
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
    return this.#index.get(key) ?? this.#meta.get(key) ?? null;
  }

  /**
   * 保留期清理：删掉超期的 blob，并把索引里的老引用一起掉（`retention.days`，`m03091` 用户要求）。
   * `days <= 0` = 不清理。**不动宿主 attachments 里已登记的份**——那份归宿主管。
   *
   * **异步 + 分批**（`m21653`）：以前这里是 `readdirSync` 然后逐个 `statSync`/`rmSync`——
   * 同步的、O(文件数) 的。它挂在启动路径上（`Hub.pruneOld` 由 `connectUpstream` 触发），
   * 于是每多存一天图，启动就多卡一点：真机日志里这一段从 6ms（10-09）长到 2.5s（10-23），
   * 一路单调上涨。现在改成 `fs.promises`，每 200 个让出一次事件循环，
   * 并且调用方（`#startRetention`）会把它推迟到启动完成之后——启动路径上不再有它。
   */
  async prune({ days = 0, chunk = 200 } = {}) {
    const d = Number(days);
    if (!(d > 0) || !this.enabled) return { skipped: true, days: d, removed: 0, bytes: 0 };
    const cutoff = this.now() - d * 86400000;
    let removed = 0;
    let freed = 0;
    if (this.keepBytes && this.storage?.enabled) {
      const dir = path.join(this.storage.dir, 'media', 'blobs');
      const files = await fs.promises.readdir(dir).catch(() => []);
      const step = Math.max(1, Number(chunk) || 200);
      for (let i = 0; i < files.length; i += step) {
        const slice = files.slice(i, i + step);
        // 一次 stat 一批：比逐个 await 快，又不至于把事件循环占住。
        const stats = await Promise.all(slice.map((f) => fs.promises.stat(path.join(dir, f)).catch(() => null)));
        for (let j = 0; j < slice.length; j += 1) {
          const st = stats[j];
          if (!st || st.mtimeMs >= cutoff) continue;
          const full = path.join(dir, slice[j]);
          try {
            await fs.promises.rm(full, { force: true });
            removed += 1;
            freed += st.size;
          } catch (err) {
            this.log(`媒体 blob 清理失败（${slice[j]}）：${err?.message ?? err}`);
          }
        }
      }
    }
    let dropped = 0;
    for (const [id, ref] of [...this.#index.entries()]) {
      const at = Number(ref?.at ?? 0);
      if (at && at < cutoff) {
        this.#index.delete(id);
        this.#meta.delete(id);
        dropped += 1;
      }
    }
    this.#stats.pruned = (this.#stats.pruned ?? 0) + removed;
    return { days: d, cutoff, removed, dropped, bytes: freed };
  }

  /**
   * 落一条媒体段。
   * @returns {Promise<object>} ref（失败时带 `error`，`id` 为 null——调用方照常渲染占位）
   */
  async resolve(seg, { messageId = null, index = null, sessionKey = null, allow = null } = {}) {
    await this.ensureIndex();
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
      sessionKey: reusing ? null : String(sessionKey ?? '').trim() || null,
      sessionKeys: !reusing && String(sessionKey ?? '').trim() ? [String(sessionKey).trim()] : [],
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
      const fetched = await this.#readBytes({ kind, data, messageId });
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

      // 1) 自己的 blob：真相留在我们手里（URL 会过期，这个不会）
      // 图片不受 maxBytes 限制（m04935 用户定案）：上限掐的是 blob 落盘，落了看图链才拿得到
      // 字节——等于变相识图上限。大图 blob 只落我们自己的盘、不进宿主 attachments（下面第 2 步
      // 仍守上限），segment 模式的模型主请求不会被巨图撑爆。
      if (this.#log && (kind === 'image' || bytes.length <= this.maxBytes)) {
        const file = `${ref.sha256}${ref.mediaType ? `.${extOf(ref.mediaType)}` : ''}`;
        const blobDir = path.join(this.storage.dir, 'media', 'blobs');
        try {
          fs.mkdirSync(blobDir, { recursive: true });
          const target = path.join(blobDir, file);
          if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
          ref.blob = target;
          this.#stats.blobs += 1;
          this.#stats.bytes += bytes.length;
        } catch (err) {
          this.log(`媒体 blob 落盘失败（不影响转发）：${err?.message ?? err}`);
        }
      }

      // 2) 顺手登记到宿主 attachments：登记之后，DSH 的模型是真能看到这张图的
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
      if (bytes.length > this.maxBytes) {
        if (kind === 'image') {
          // 超大图：blob 已在上面第 1 步落地（识图链照常工作），只是不登记宿主附件。**不标
          // error**——hub 的识图环节见到 error 会直接放弃描述（m04935）。
        } else {
          ref.error = `超过上限（${bytes.length} > ${this.maxBytes} 字节），只记元信息`;
          this.#stats.degraded += 1;
        }
      }

      // 3) 语音：优先实现端扩展，拿不到就诚实标注（不猜内容）
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

      this.#remember(ref);
      this.#stats.resolved += 1;
      this.#stats.lastAt = at;
      return ref;
    } catch (err) {
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
      const hit = this.#index.get(raw) ?? this.#meta.get(raw) ?? null;
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
    await this.ensureIndex();
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
      ...(sessionKey ? { sessionKey: String(sessionKey), sessionKeys: [String(sessionKey)] } : {}),
    };
    if (this.#log && bytes.length <= ceiling) {
      const blobDir = path.join(this.storage.dir, 'media', 'blobs');
      fs.mkdirSync(blobDir, { recursive: true });
      const target = path.join(blobDir, `${sha256}.${extOf(type)}`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
      ref.blob = target;
      this.#stats.blobs += 1;
    }
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
    this.#remember(ref);
    return ref;
  }

  /** 追加一条删除标记（`op:'drop'` 整条丢 / `op:'detach'` 只摘归属）。 */
  #markLog(row) {
    if (this.#log && !this.#log.append(this.linkId || 'media', { ...row, opAt: this.now() }, this.now())) {
      throw new Error('媒体清理标记写入失败');
    }
  }

  #remember(ref) {
    if (!ref?.id) return;
    const stored = mergeRef(this.#index.get(ref.id), ref);
    this.#index.set(ref.id, stored);
    this.#meta.set(ref.id, stored);
    // 日志按写入日期排序，不能按第一次出现的旧日期追加，否则会排在删除标记前。
    if (this.#log && !this.#log.append(this.linkId || 'media', stored, this.now())) {
      this.log(`媒体索引写入失败：${ref.id}`);
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
    const hit = this.#index.get(key) ?? this.#meta.get(key) ?? null;
    if (!hit) return { found: false, sessionKeys: [], occurrences: [], mediaType: null };
    const keys = Array.isArray(hit.sessionKeys) && hit.sessionKeys.length
      ? hit.sessionKeys
      : (hit.sessionKey ? [String(hit.sessionKey)] : []);
    return { found: true, sessionKeys: keys, occurrences: hit.occurrences ?? [], mediaType: hit.mediaType ?? null };
  }

  /** 取字节：base64 / data: / http(s) / 本地路径 / `hub-media:<id>` / 先用 get_image·get_record 换 URL 再取。 */
  async #readBytes({ kind, data, messageId }) {
    const raw = data?.url ?? data?.file;
    // 已经落地过的 ref 再当来源用（`onebot_media{link:'hub-media:…'}`）：直接读它自己的 blob，
    // 不用再让实现端去换 URL——原来这条写法的落地区分支只会回"拿不到字节"。
    if (typeof raw === 'string' && raw.startsWith('hub-media:')) {
      const got = await this.readRef(raw, { kind });
      if (got?.error) return { error: got.error, provenance: 'hub-media' };
      // `readRef` 的对外形状是 `{bytes, mediaType}`，而这条内部通道的调用方（`resolve()`）
      // 读的是 `.data`——直接透传会在 `bytes.length` 上炸（复审 F15）。在这里转成内部形状。
      return { data: got.bytes, mediaType: got.mediaType ?? null, provenance: 'hub-media' };
    }
    const inline = this.#decodeInline(raw);
    if (inline) return inline;
    if (inline?.error) return null; // 明确不是内联：继续走 URL 分支

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
