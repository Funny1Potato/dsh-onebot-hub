// 语音合成（TTS）：把一句话交给一个 OpenAI 兼容的 `POST /audio/speech`，拿回音频字节。
//
// 本模块只做三件事：**拼请求、验返回、把字节落到本地**。发不发、发给谁、跟谁一起发，
// 全由上层（`lib/reply.js` 的语音段）决定；它不碰会话、不发消息、不写聊天逻辑（可离线测）。
//
// 为什么音色允许是任意字符串：
//   · OpenAI 官方只认固定几个（alloy/echo/fable/onyx/nova/shimmer…），但"OpenAI 兼容"
//     这一层早就不止官方——GPT-SoVITS、CosyVoice、IndexTTS、Fish Speech、豆包/火山这些
//     都提供同形状的 `/audio/speech`，音色是**各自注册的名字或 id**（有的甚至是克隆出来的
//     一串 hash）。把枚举写死在插件里，等于把这些服务全挡在门外，而且它们并不在意我们校验。
//   · 所以这里不校验音色合法性，只负责原样带上；写错了是上游回 400，那句话会原样进回执。
//
// 为什么参考音频（"喂一段音频，让模型照着这个声音读"）是一组**可配字段名**：
//   · 零样本克隆没有统一参数面。GPT-SoVITS 用 `ref_audio_path` + `prompt_text`，
//     CosyVoice 用 `prompt_audio` + `prompt_text`，IndexTTS 用 `ref_audio` + `ref_text`，
//     还有一堆中转把它拼成 `voice` 或干脆叫 `speaker`。每一次对接 `glossary` 都不一样，
//     而它们的共同点只是"把参考音频塞进请求体"。
//   · 硬编码一个名字 = 只对一家生效，其余全部 400；让用户改字段名 = 配一次就能对接。
//     所以默认 `ref_audio` / `ref_text`（最常见的写法），**留空即不发这个字段**——
//     严格实现（OpenAI 官方）收到未知字段会直接报错，所以默认值虽然写着，没配参考音频
//     时两个字段都不会出现在请求体里。
//
// 为什么 apiKey 绝不进请求体（与 `lib/vision/imagegen.js` 同一条纪律）：
//   · 请求体会被上游日志、代理、错误上报原样留存；`Authorization` 头才是密钥通道。
//     错误信息同样要脱敏：上游回显里带了密钥，先抹掉再往外抛。
//
// 为什么失败不抛：
//   · 调用方是聊天链路，一次合成失败只该表现成"这句没声音"，不该把整个回复打崩。
//     所有错误收敛进返回值的 `error`（中文、可读、不含密钥），并记进 `stats`。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 返回格式 → 扩展名 + MIME。官方支持的就是这几个；认不出的按 mp3 处理并如实说明。 */
const FORMATS = new Map([
  ['mp3', { ext: 'mp3', mime: 'audio/mpeg' }],
  ['opus', { ext: 'opus', mime: 'audio/ogg' }],
  ['aac', { ext: 'aac', mime: 'audio/aac' }],
  ['flac', { ext: 'flac', mime: 'audio/flac' }],
  ['wav', { ext: 'wav', mime: 'audio/wav' }],
  ['pcm', { ext: 'pcm', mime: 'audio/L16' }],
]);

/** 上游回显只捎前这么多字符，够定位问题，又不会把日志刷爆。 */
const SNIPPET_LIMIT = 200;
/** 官方 input 上限是 4096 字符；给个更保守的默认，超了先说清楚再截。 */
const DEFAULT_MAX_CHARS = 1000;

const truthyFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return !['false', '0', 'off', 'no', 'none', 'null'].includes(raw);
};

const isHttp = (v) => /^https?:\/\//i.test(v);

/** 只回 host：日志与 `stats` 里不能出现路径、查询串或 token。 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 语音合成器。
 *
 * @example
 *   const tts = new Tts({ enabled: true, baseUrl: 'https://api.example.com/v1', apiKey, model: 'tts-1' });
 *   const out = await tts.synth({ text: '今晚早点睡' });
 *   if (out.ok) sendRecord(out.path);
 */
export class Tts {
  #on;
  #fetch;
  #stats;
  #now;
  #log;

  /**
   * @param {object} [opts]
   * @param {{dir:string}|null} [opts.storage] 落盘根目录（音频写它的 `tts/` 子目录）
   * @param {(msg:string)=>void} [opts.log]
   * @param {boolean} [opts.enabled] 开关；还要 baseUrl/apiKey/fetch 齐全才算真能用
   * @param {string} [opts.baseUrl] 形如 `https://api.example.com/v1`（不要带 `/audio/speech`）
   * @param {string} [opts.apiKey] 只进 `Authorization` 头
   * @param {string} [opts.model] 如 `tts-1` / `gpt-4o-mini-tts` / `cosyvoice-v1`
   * @param {string} [opts.voice] 音色名或 id（**不校验**，兼容服务的自定义音色直接写）
   * @param {string} [opts.format] `mp3|opus|aac|flac|wav|pcm`，默认 mp3
   * @param {number} [opts.speed] 语速倍率，1 = 原速；只在 ≠1 时发送
   * @param {string} [opts.instructions] 官方 `gpt-4o-mini-tts` 的说话风格提示；空 = 不发
   * @param {string} [opts.refAudio] 默认参考音频（URL / 本地路径 / `base64://…` / `data:…`）
   * @param {string} [opts.refText] 参考音频对应的文本（很多克隆接口要求同时给）
   * @param {string} [opts.refAudioField] 参考音频的**请求体字段名**，留空 = 不发；默认 `ref_audio`
   * @param {string} [opts.refTextField] 参考文本的字段名，留空 = 不发；默认 `ref_text`
   * @param {number} [opts.timeoutMs] 单次请求超时，默认 30000
   * @param {number} [opts.maxChars] 单次最多多少字，默认 1000
   * @param {number} [opts.cacheLimit] 磁盘缓存条目上限（0 = 不缓存），默认 200
   * @param {Function} [opts.fetchImpl]
   * @param {()=>number} [opts.now]
   */
  constructor({
    storage = null,
    log = () => {},
    enabled = false,
    baseUrl = '',
    apiKey = '',
    model = '',
    voice = '',
    format = 'mp3',
    speed = 1,
    instructions = '',
    refAudio = '',
    refText = '',
    refAudioField = 'ref_audio',
    refTextField = 'ref_text',
    timeoutMs = 30000,
    maxChars = DEFAULT_MAX_CHARS,
    cacheLimit = 200,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.#log = typeof log === 'function' ? log : () => {};
    this.#on = truthyFlag(enabled, false);
    this.baseUrl = String(baseUrl ?? '').trim();
    this.apiKey = String(apiKey ?? '');
    this.model = String(model ?? '').trim();
    this.voice = String(voice ?? '').trim();
    const picked = FORMATS.get(String(format ?? '').trim().toLowerCase());
    this.format = picked ? String(format).trim().toLowerCase() : 'mp3';
    this.formatKnown = Boolean(picked);
    const rate = Number(speed);
    this.speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.instructions = String(instructions ?? '').trim();
    this.refAudio = String(refAudio ?? '').trim();
    this.refText = String(refText ?? '').trim();
    this.refAudioField = String(refAudioField ?? '').trim();
    this.refTextField = String(refTextField ?? '').trim();
    const timeout = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
    const cap = Number(maxChars);
    this.maxChars = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_MAX_CHARS;
    const cache = Number(cacheLimit);
    this.cacheLimit = Number.isFinite(cache) && cache >= 0 ? Math.floor(cache) : 200;
    this.#fetch = typeof fetchImpl === 'function'
      ? fetchImpl
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#stats = { requests: 0, ok: 0, cached: 0, failed: 0, lastError: null, lastAt: null, lastChars: null };
  }

  /** 配置齐不齐（baseUrl + apiKey + 可用的 fetch）；不看向量开关。 */
  get configured() {
    return Boolean(this.baseUrl && this.apiKey && this.#fetch);
  }

  /** 真能用：开关打开且配置齐全。 */
  get enabled() {
    return this.#on === true && this.configured;
  }

  /** 运行计数与最近一次失败的留痕（baseUrl 只有 host，不含密钥）。 */
  get stats() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      model: this.model || null,
      voice: this.voice || null,
      baseUrl: hostOf(this.baseUrl),
      reference: this.refAudio ? sourceOf(this.refAudio).kind : null,
      requests: this.#stats.requests,
      ok: this.#stats.ok,
      cached: this.#stats.cached,
      failed: this.#stats.failed,
      lastError: this.#stats.lastError,
      lastAt: this.#stats.lastAt,
      lastChars: this.#stats.lastChars,
    };
  }

  /** 注入了别的 fetch（带代理/统计的包装）之后是否可用。 */
  attach({ fetchImpl = null } = {}) {
    if (typeof fetchImpl === 'function') this.#fetch = fetchImpl;
    return this.enabled;
  }

  /**
   * 合成一句语音并落盘。
   *
   * @param {object} [input]
   * @param {string} input.text 要读的字（必填）
   * @param {string} [input.voice] 覆盖默认音色
   * @param {number} [input.speed] 覆盖默认语速
   * @param {string} [input.refAudio] 覆盖默认参考音频（空串 = 这次不用参考音频）
   * @param {string} [input.refText] 覆盖默认参考文本
   * @param {boolean} [input.noCache] 跳过缓存
   * @returns {Promise<{ok:boolean, path:string|null, bytes:number, mediaType:string|null, ext:string|null, cached:boolean, error:string|null}>}
   */
  async synth({ text = '', voice = '', speed = null, refAudio = undefined, refText = undefined, noCache = false } = {}) {
    const fail = (error) => ({ ok: false, path: null, bytes: 0, mediaType: null, ext: null, cached: false, error });
    if (!this.enabled) return fail('语音合成未启用或配置不完整（需要 enabled、baseUrl、apiKey 与可用的 fetch）');

    const body = String(text ?? '').trim();
    if (!body) return fail('要读的内容是空的');
    if (body.length > this.maxChars) {
      return fail(`太长（${body.length} 字，上限 ${this.maxChars}）：分几句分别合成，或者把 tts.maxChars 调大`);
    }

    const useVoice = String(voice ?? '').trim() || this.voice;
    const useSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : this.speed;
    const useRef = refAudio === undefined ? this.refAudio : String(refAudio ?? '').trim();
    const useRefText = refText === undefined ? this.refText : String(refText ?? '').trim();
    const refPayload = useRef ? await this.#refPayload(useRef) : null;
    if (refPayload && refPayload.error) return fail(refPayload.error);

    const request = {
      model: this.model,
      input: body,
      ...(useVoice ? { voice: useVoice } : {}),
      response_format: this.format,
      ...(useSpeed !== 1 ? { speed: useSpeed } : {}),
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(refPayload && this.refAudioField ? { [this.refAudioField]: refPayload.value } : {}),
      ...(refPayload && useRefText && this.refTextField ? { [this.refTextField]: useRefText } : {}),
    };

    const ext = (FORMATS.get(this.format) ?? FORMATS.get('mp3')).ext;
    const signature = crypto
      .createHash('sha256')
      .update(JSON.stringify({ url: this.baseUrl, ...request }))
      .digest('hex');
    const target = this.#cachePath(`${signature}.${ext}`);
    if (!noCache && target && fs.existsSync(target)) {
      this.#stats.cached += 1;
      this.#stats.lastAt = this.#now();
      this.#stats.lastChars = body.length;
      return {
        ok: true,
        path: target,
        bytes: fs.statSync(target).size,
        mediaType: FORMATS.get(this.format)?.mime ?? 'audio/mpeg',
        ext,
        cached: true,
        error: null,
      };
    }

    this.#stats.requests += 1;
    this.#stats.lastAt = this.#now();
    this.#stats.lastChars = body.length;
    try {
      const res = await this.#request(this.#endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'audio/*,application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
      });
      if (!res || !res.ok) {
        const detail = await this.#snippet(res);
        throw new Error(`上游返回 HTTP ${res?.status ?? '未知'}${detail ? `：${detail}` : ''}`);
      }

      const got = await this.#audioOf(res);
      if (got.error) throw new Error(got.error);
      const mediaType = got.mediaType ?? FORMATS.get(this.format)?.mime ?? 'audio/mpeg';
      const file = this.#write(target, got.bytes, ext);
      this.#trimCache();
      this.#stats.ok += 1;
      return { ok: true, path: file, bytes: got.bytes.length, mediaType, ext, cached: false, error: null };
    } catch (err) {
      const message = this.#redact(String(err?.message ?? err) || '语音合成失败').slice(0, 600);
      this.#stats.failed += 1;
      this.#stats.lastError = message;
      this.#log(`语音合成失败：${message}`);
      return fail(message);
    }
  }

  #endpoint() {
    return `${this.baseUrl.replace(/\/+$/, '')}/audio/speech`;
  }

  /**
   * 参考音频 → 请求体里的值。
   *
   * 三种来源分开处理：URL 原样给（让上游自己取，它多半和音频在同一边）、
   * `data:` 原样给、`base64://` 剥掉前缀给裸 base64、本地路径读成 `data:` URL。
   * 读不到就**明确失败**——悄悄不带参考音频，用户只会觉得"克隆没生效"。
   */
  async #refPayload(link) {
    const raw = String(link ?? '').trim();
    const source = sourceOf(raw);
    if (source.kind === 'empty') return { error: '参考音频是空的' };
    if (source.kind === 'data') return { value: raw };
    if (source.kind === 'base64') return { value: raw.replace(/^base64:\/\//i, '') };
    if (source.kind === 'url') return { value: raw };
    try {
      const bytes = fs.readFileSync(source.value);
      if (!bytes.length) return { error: '参考音频是空文件' };
      return { value: `data:${mimeOf(source.value)};base64,${bytes.toString('base64')}` };
    } catch (err) {
      return { error: `读不到参考音频（${source.value}）：${err?.code ?? err?.message ?? '未知错误'}` };
    }
  }

  #cachePath(name) {
    if (!this.storage?.dir || this.cacheLimit <= 0) return null;
    return path.join(this.storage.dir, 'tts', name);
  }

  #write(target, bytes, ext) {
    if (!target) {
      // 没开缓存/没存储目录：仍要落一个文件（OneBot 的 record 段要的是路径）。
      const dir = path.join(process.cwd(), 'tts-out');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${ext}`);
      fs.writeFileSync(tmp, bytes);
      return tmp;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  }

  /** 缓存按条数与总字节双限：先按 mtime 淘汰最旧的（目录里都是我们写的文件）。 */
  #trimCache() {
    const dir = this.storage?.dir ? path.join(this.storage.dir, 'tts') : null;
    if (!dir || this.cacheLimit <= 0) return;
    try {
      const files = fs.readdirSync(dir)
        .map((name) => {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            return st.isFile() ? { full, at: st.mtimeMs } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at);
      const extra = files.length - this.cacheLimit;
      for (let i = 0; i < extra; i += 1) {
        try {
          fs.unlinkSync(files[i].full);
        } catch {
          /* 删不掉就算了，下次再说 */
        }
      }
    } catch {
      /* 目录还没建起来，本来就没东西可删 */
    }
  }

  /**
   * 从响应里取出音频字节。
   *
   * 绝大多数兼容服务直接回二进制，但有几类中转会回 JSON（`{audio: base64}` /
   * `{data:[{b64_json}]}` / `{url}`），只认二进制就等于只对官方可用，所以两条路都认。
   */
  async #audioOf(res) {
    const type = String(res?.headers?.get?.('content-type') ?? '').toLowerCase();
    if (type.includes('json')) {
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const b64 = json?.audio ?? json?.b64_json ?? json?.data?.[0]?.b64_json ?? json?.data?.[0]?.audio ?? null;
      if (typeof b64 === 'string' && b64.trim()) {
        const bytes = Buffer.from(b64.trim(), 'base64');
        if (!bytes.length) return { error: '上游返回的 base64 音频是空的' };
        return { bytes, mediaType: json?.media_type ?? null };
      }
      const url = json?.url ?? json?.data?.[0]?.url ?? null;
      if (typeof url === 'string' && isHttp(url)) {
        const audio = await this.#request(url, { method: 'GET', headers: { accept: 'audio/*' } });
        if (!audio || !audio.ok) return { error: `音频下载失败：上游返回 HTTP ${audio?.status ?? '未知'}` };
        const bytes = Buffer.from(await audio.arrayBuffer());
        if (!bytes.length) return { error: '音频下载回来是空的' };
        return { bytes, mediaType: audio.headers?.get?.('content-type') ?? null };
      }
      const echo = this.#redact(JSON.stringify(json)).slice(0, SNIPPET_LIMIT);
      return { error: `上游没有返回音频（返回内容前 ${echo.length} 字符：${echo}）` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return { error: '上游返回的音频是空的' };
    return { bytes, mediaType: type.split(';')[0].trim() || null };
  }

  /** 真正发请求的地方：AbortController + 超时竞速（上游不理会 abort 也不会把这里挂死）。 */
  async #request(url, init = {}) {
    const fetchImpl = this.#fetch;
    if (typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch');
    const controller = new AbortController();
    let timerId = null;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error(`语音合成请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
    });
    try {
      const pending = Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }));
      pending.catch(() => {});
      return await Promise.race([pending, timeout]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  /** 出错时捎上上游回显的前 200 字符，便于排查（已脱敏）。 */
  async #snippet(res) {
    try {
      const text = typeof res?.text === 'function' ? await res.text() : '';
      return this.#redact(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LIMIT);
    } catch {
      return '';
    }
  }

  #redact(text) {
    const raw = String(text ?? '');
    if (!this.apiKey) return raw;
    return raw.split(this.apiKey).join('***');
  }
}

/** 参考音频这串字的**形态**判定（`stats` 与 `#refPayload` 共用一份，免得两处说法不一致）。 */
function sourceOf(link) {
  const raw = String(link ?? '').trim();
  if (!raw) return { kind: 'empty', value: '' };
  if (/^data:/i.test(raw)) return { kind: 'data', value: raw };
  if (/^base64:\/\//i.test(raw)) return { kind: 'base64', value: raw };
  if (isHttp(raw)) return { kind: 'url', value: raw };
  const local = /^file:\/\//i.test(raw)
    ? decodeURIComponent(raw.replace(/^file:\/\//i, ''))
    : raw;
  return { kind: 'file', value: local };
}

/** 按扩展名给个 MIME：参考音频只是转发，类型错了由上游判断，这里不猜内容。 */
function mimeOf(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase();
  return {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.silk': 'audio/silk',
    '.amr': 'audio/amr',
  }[ext] ?? 'application/octet-stream';
}

export { FORMATS as TTS_FORMATS };
