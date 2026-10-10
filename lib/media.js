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

  /** 已落地的媒体（新到旧），给工具与排障用。 */
  list({ limit = 20 } = {}) {
    return [...this.#index.values()]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, Math.max(1, limit));
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
   */
  prune({ days = 0 } = {}) {
    const d = Number(days);
    if (!(d > 0) || !this.enabled) return { skipped: true, days: d, removed: 0, bytes: 0 };
    const cutoff = this.now() - d * 86400000;
    let removed = 0;
    let freed = 0;
    if (this.keepBytes && this.storage?.enabled) {
      const dir = path.join(this.storage.dir, 'media', 'blobs');
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        files = [];
      }
      for (const f of files) {
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoff) continue;
          fs.rmSync(full);
          removed += 1;
          freed += st.size;
        } catch (err) {
          this.log(`媒体 blob 清理失败（${f}）：${err?.message ?? err}`);
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
  async resolve(seg, { messageId = null, index = null } = {}) {
    const kind = String(seg?.type ?? '');
    if (!['image', 'record', 'video', 'file'].includes(kind)) return null;
    const data = seg?.data ?? {};
    const at = this.now();
    // `file`/`url` 有可能是**整份内联字节**（base64://…）。名字与来源必须按"人读的一行"来取，
    // 绝不能把 16 万字符的 base64 存进索引（那会一路漏进 onebot_raw 的工具结果）。
    const rawSource = data.url ?? data.file ?? null;
    const inline = INLINE_PREFIX.test(String(rawSource ?? ''));
    const ref = {
      id: null,
      kind,
      at,
      messageId,
      index,
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
      if (this.#log && bytes.length <= this.maxBytes) {
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
      if (this.attachments && bytes.length <= this.maxBytes) {
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
        ref.error = `超过上限（${bytes.length} > ${this.maxBytes} 字节），只记元信息`;
        this.#stats.degraded += 1;
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
  async resolveEvent(segments, { messageId = null } = {}) {
    const refs = new Map();
    const records = [];
    const list = Array.isArray(segments) ? segments : [];
    for (let i = 0; i < list.length; i += 1) {
      const seg = list[i];
      if (!seg || !['image', 'record', 'video', 'file'].includes(seg.type)) continue;
      const ref = await this.resolve(seg, { messageId, index: i });
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
  async saveBytes(bytes, { mediaType = null, name = null, kind = 'file' } = {}) {
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
    };
    if (this.#log && bytes.length <= this.maxBytes) {
      const blobDir = path.join(this.storage.dir, 'media', 'blobs');
      fs.mkdirSync(blobDir, { recursive: true });
      const target = path.join(blobDir, `${sha256}.${extOf(type)}`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
      ref.blob = target;
      this.#stats.blobs += 1;
    }
    // 顺手登记到宿主 attachments（`resolve()` 同款）：生成图也要"DSH 的模型真能看到"——
    // 看图（`lib/vision.js`）直接吃 `ref.attachment`，别让同一张图再登记一次。
    if (this.attachments && bytes.length <= this.maxBytes) {
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

  #remember(ref) {
    if (!ref?.id) return;
    this.#index.set(ref.id, ref);
    this.#meta.set(ref.id, ref);
    try {
      this.#log?.append(this.linkId || 'media', ref, ref.at);
    } catch (err) {
      this.log(`media 索引落盘失败（不影响转发）：${err?.message ?? err}`);
    }
  }

  /** 取字节：base64 / data: / http(s) / 本地路径 / `hub-media:<id>` / 先用 get_image·get_record 换 URL 再取。 */
  async #readBytes({ kind, data, messageId }) {
    const raw = data?.url ?? data?.file;
    // 已经落地过的 ref 再当来源用（`onebot_media{link:'hub-media:…'}`）：直接读它自己的 blob，
    // 不用再让实现端去换 URL——原来这条写法的落地区分支只会回"拿不到字节"。
    if (typeof raw === 'string' && raw.startsWith('hub-media:')) {
      const got = await this.readRef(raw, { kind });
      return got?.error ? { error: got.error, provenance: 'hub-media' } : got;
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

  async #download(url, kind) {
    if (typeof this.fetchImpl !== 'function') return { error: '运行环境没有 fetch，无法下载媒体', provenance: 'remote' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, { signal: controller?.signal });
      if (!res?.ok) return { error: `下载失败：HTTP ${res?.status ?? '?'}`, provenance: 'remote' };
      const declared = Number(res.headers?.get?.('content-length') ?? 0);
      if (declared && declared > this.maxBytes) {
        // 还是读回来（要算 sha256 就得有字节），但明确标注超限：调用方据此只记元信息
        const buf = Buffer.from(await res.arrayBuffer());
        return { data: buf, mediaType: res.headers?.get?.('content-type')?.split(';')[0] ?? null, provenance: 'remote' };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { data: buf, mediaType: res.headers?.get?.('content-type')?.split(';')[0] ?? null, provenance: 'remote' };
    } catch (err) {
      return { error: `下载失败：${err?.message ?? err}`, provenance: 'remote' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #readLocal(file, kind) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > this.maxBytes * 4) return { error: `本地文件过大（${stat.size} 字节）`, provenance: 'local' };
      const data = fs.readFileSync(file);
      return { data, mediaType: guessTypeFromName(file), provenance: 'local' };
    } catch (err) {
      return { error: `读本地文件失败：${err?.message ?? err}`, provenance: 'local' };
    }
  }
}

export { extOf };
