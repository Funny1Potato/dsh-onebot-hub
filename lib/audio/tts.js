// 语音合成（TTS）：把一句话交给一个音频接口，拿回音频字节。
//
// 本模块只做三件事：**拼请求、验返回、把字节落到本地**。发不发、发给谁、跟谁一起发，
// 全由上层（`lib/reply.js` 的语音段）决定；它不碰会话、不发消息、不写聊天逻辑（可离线测）。
//
// 为什么地址是**一整个 URL**、请求体还分两种形状：
//   · 原先写死 `POST {baseUrl}/audio/speech`，等于替所有上游假定"OpenAI 那一套"。真机立刻
//     碰到反例：小米 MiMo 的 TTS 走 `chat/completions`——`.../v1/audio/speech` 在它的两个域
//     全是 404，而 `chat/completions` 回的是「messages must contain an assistant role for
//     TTS model」。**路径不同，请求体也不同**，所以只把路径改成可配仍然不通。
//   · 于是退到最小假设：地址由用户给全（`url`，带不带 `/audio/speech` 都由他），请求体由
//     `shape` 选——`speech`（`input`/`voice`/`response_format` 那一套）与 `chat`（要读的话
//     放进 `messages` 里的一条 `assistant`，`instructions` 则作为 `system` 描述音色）。
//   · 形状猜错的代价被压到最小：返回里找不到音频时，错误信息会把**实际收到的顶层字段**列
//     出来，下一次照着它改就行，不必再猜。
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
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

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
/** MiMo 的内置音色（`mimo-v2.5-tts` 认这些；别的字符串会被当成无效音色）。 */
const MIMO_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'mia', 'chloe', 'milo', 'dean']);

/** MiniMax `audio_setting.format` 的取值（wav 只在非流式下支持，我们本来就是非流式）。 */
const MINIMAX_FORMATS = new Set(['mp3', 'pcm', 'flac', 'wav']);

/** 火山系（豆包语音 / 方舟）`encoding` 的取值。 */
const VOLC_FORMATS = new Set(['mp3', 'wav', 'pcm', 'ogg_opus']);

/** MiMo 的 `audio.format` 只认这四种。 */
const MIMO_FORMATS = new Set(['wav', 'mp3', 'pcm', 'pcm16']);

/** `data:audio/wav;base64,xxx` → `xxx`（MiMo 的 `audio.voice` 只收裸 base64）。 */
const base64Of = (value) => {
  const text = String(value ?? '');
  const at = text.indexOf('base64,');
  return at >= 0 ? text.slice(at + 7) : text;
};

/** 请求体形状：`speech` = `/audio/speech` 那一套；`chat` = 塞进 `messages` 的那一套。 */
const SHAPES = new Set(['speech', 'chat', 'minimax', 'doubao', 'ark', 'plugin']);
/** 用十六进制音频串的形状（MiniMax 的 `data.audio` 就是 hex，不是 base64）。 */
const HEX_SHAPES = new Set(['minimax']);

const truthyFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return !['false', '0', 'off', 'no', 'none', 'null'].includes(raw);
};

const isHttp = (v) => /^https?:\/\//i.test(v);
/**
 * 看起来像一整段 base64 音频吗？
 *
 * `content` 里塞音频的实现会把 base64 直接放进字符串，而正常聊天回复也放在这里——所以要求
 * 足够长（短字符串不可能是音频）且整串都是 base64 字符（不能带空格、冒号、中文）。
 */
const looksLikeBase64 = (v) => typeof v === 'string'
  && v.length > 256
  && !/\s/.test(v)
  && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
/**
 * 把一段响应文本拆成若干 JSON 对象：整段是一个对象就用它；是 SSE（`data: {...}` 若干行）
 * 就逐行解出来。解不出任何东西时返回空数组——交回给调用方去报"看不懂"。
 */
const jsonCandidates = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const whole = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  if (whole !== undefined) return Array.isArray(whole) ? whole : [whole];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* 半截的块就跳过 */
    }
  }
  return out;
};

/** MiniMax 的 `data.audio` 是 **hex** 不是 base64：解的姿势错了只会得到一堆噪声字节。 */
const decodeAudio = (text, shape) => {
  const raw = String(text ?? '').trim().replace(/^data:[^,]*,/, '');
  if (!raw) return Buffer.alloc(0);
  if (HEX_SHAPES.has(shape) && /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const bytes = Buffer.from(raw, 'hex');
    if (bytes.length) return bytes;
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length) return bytes;
  // base64 解不动再试 hex：换个中转回来还是同一份东西，别让形状配置把出路堵死。
  return /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, 'hex') : bytes;
};

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
 *   const tts = new Tts({ enabled: true, url: 'https://api.example.com/v1/audio/speech', apiKey, model: 'tts-1' });
 *   const out = await tts.synth({ text: '今晚早点睡' });
 *   if (out.ok) sendRecord(out.path);
 */
/**
 * 自己发一个 POST，返回一个"长得像 `Response`"的对象（只实现用到的那几样）。
 *
 * 为什么不直接用 `fetch`：宿主里可能装着会包装 `globalThis.fetch` 的插件，
 * 而它们通常专挑 `/chat/completions`、`/v1/messages` 这类路径做拦截改写——
 * 语音合成恰好也打 `/chat/completions`，于是请求被代理按"模型补全"重新拼装，
 * 上游收到的就不是我们发的那一份（`m31125`：上游报 `messages[0] system role`，
 * 而本地发的是 `[user, assistant]`，一个字节都没错，就是路上被改了）。
 * 合成只要一个 JSON POST，走 `node:http(s)` 才能保证"发出去什么就是什么"。
 */
function httpPost(url, init, signal) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`接口地址不是合法 URL：${url}`));
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    const payload = Buffer.from(String(init.body ?? ''), 'utf8');
    const headers = { ...(init.headers ?? {}) };
    // 绝不覆盖用户/上游要求的头，只补长度与编码（有些服务不认 chunked）。
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(payload.length);
    }
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
            text: async () => raw.toString('utf8'),
            json: async () => JSON.parse(raw.toString('utf8')),
            arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 参考音频的本地文件上限：再大既没意义，也会把进程读崩。 */
const MAX_REF_AUDIO_BYTES = 16 * 1024 * 1024;

export class Tts {
  #on;
  #fetch;
  /** 没注入 fetch：POST 自己走 node:http(s)，绕开任何全局 fetch 包装。 */
  #direct;
  #stats;
  #now;
  #log;

  /**
   * @param {object} [opts]
   * @param {{dir:string}|null} [opts.storage] 落盘根目录（音频写它的 `tts/` 子目录）
   * @param {(msg:string)=>void} [opts.log]
   * @param {boolean} [opts.enabled] 开关；还要 url/apiKey/fetch 齐全才算真能用
   * @param {string} [opts.url] **完整**接口地址（带不带 `/audio/speech` 由你；不自动拼路径）
   * @param {string} [opts.shape] `speech`（`input`/`voice`/`response_format`）或 `chat`
   *   （要读的话放进 `messages` 的 `assistant` 里）；默认 `speech`
   * @param {string} [opts.apiKey] 只进 `Authorization` 头
   * @param {string} [opts.model] 模型名（**不校验**，也没有默认值——空则不出现在请求体里）
   * @param {string} [opts.voice] 音色名或 id（**不校验**，也没有默认值；空则不出现）
   * @param {string} [opts.format] `mp3|opus|aac|flac|wav|pcm`，默认 mp3（只影响落盘扩展名与
   *   `speech` 形状的 `response_format`）
   * @param {number} [opts.speed] 语速倍率，1 = 原速；只在 ≠1 时发送
   * @param {string} [opts.instructions] 风格/音色提示；`speech` 里叫 `instructions`，
   *   `chat` 里作为一条 `system` 消息；空 = 不发
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
    provider = 'custom',
    pluginTools = [],
    url = '',
    shape = 'speech',
    apiKey = '',
    appId = '',
    cluster = '',
    groupId = '',
    resourceId = '',
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
    // 注意默认值是 `undefined` 而不是 `globalThis.fetch`：只有真的有人传进来才算"注入"，
    // 否则一律自己发（见下面 `#direct`）。
    fetchImpl = undefined,
    now = Date.now,
    diagFile = '',
  } = {}) {
    this.storage = storage;
    this.#log = typeof log === 'function' ? log : () => {};
    this.#on = truthyFlag(enabled, false);
    const wantedProvider = String(provider ?? '').trim().toLowerCase();
    this.provider = wantedProvider || 'custom';
    this.pluginTools = (Array.isArray(pluginTools) ? pluginTools : []).map(String).filter(Boolean);
    this.url = String(url ?? '').trim();
    // `plugin` 形状不看 url/shape：那一档压根不发请求（`m29571`，对齐生图的 plugin 引擎）。
    if (this.provider === 'plugin') {
      this.shape = 'plugin';
    } else {
      const wanted = String(shape ?? '').trim().toLowerCase();
      this.shape = SHAPES.has(wanted) ? wanted : 'speech';
    }
    this.apiKey = String(apiKey ?? '');
    // 豆包语音要 appid + cluster（token 就是 apiKey）；MiniMax 老接口要 GroupId 拼在地址上。
    // 这三样是**账号属性**不是形状属性，所以跟着服务商一起填，不跟着形状走。
    this.appId = String(appId ?? '').trim();
    this.cluster = String(cluster ?? '').trim() || (this.shape === 'doubao' ? 'volcano_tts' : '');
    this.groupId = String(groupId ?? '').trim();
    // 方舟 Agent Plan 的 `X-Api-Resource-Id`：TTS 是 `seed-tts-2.0`，留空就按它（别的形状用不到）。
    this.resourceId = String(resourceId ?? '').trim() || (this.shape === 'ark' ? 'seed-tts-2.0' : '');
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
    // 有注入就用注入的（测试）；没注入**不用全局 fetch**，改自己走 http(s)。
    // 原因：宿主里可能有别的插件把 `globalThis.fetch` 换成自己的链（哪怕只是"顺手包一层"），
    // 而 `/chat/completions` 这种路径是各家模型代理的重点拦截对象——请求会被改写到代理、
    // 并按"模型补全请求"重新组装，上游看到的就不是我们拼的那份（`m31125` 的 system role 400 就是这么来的）。
    // 合成只需要一个 JSON POST，自己发才谈得上"我发的是什么就是什么"。
    const injected = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.#fetch = injected ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    this.#direct = injected === null;
    this.#now = typeof now === 'function' ? now : Date.now;
    // 诊断落点：默认 `<tmp>/onebot-tts-last.json`；只在出错时写，测试里指到自己的临时文件，
    // 免得几例并行跑的时候互相踩同一个文件。
    this.diagFile = String(diagFile ?? '').trim() || path.join(os.tmpdir(), 'onebot-tts-last.json');
    this.#stats = { requests: 0, ok: 0, cached: 0, failed: 0, lastError: null, lastAt: null, lastChars: null };
  }

  /** 配置齐不齐（url + apiKey + 可用的 fetch）；`plugin` 档不用这三样，只要开关打开。 */
  get configured() {
    if (this.shape === 'plugin') return this.#on === true;
    // 豆包语音少了 appid 一定失败（上游回 `Missing required: app.appid`），所以算"没配全"。
    if (this.shape === 'doubao' && !this.appId) return false;
    return Boolean(this.url && this.apiKey && (this.#direct || this.#fetch));
  }

  /** 真正打出去的地址：MiniMax 老接口要把 GroupId 拼在查询串上。 */
  get endpoint() {
    if (this.shape !== 'minimax' || !this.groupId) return this.url;
    try {
      const url = new URL(this.url);
      url.searchParams.set('GroupId', this.groupId);
      return url.toString();
    } catch {
      // 不是合法 URL 就按"用户自己拼好了"处理，不再闹一次。
      return this.url;
    }
  }

  /** 真能用：开关打开且配置齐全。 */
  get enabled() {
    return this.#on === true && this.configured;
  }

  /** 运行计数与最近一次失败的留痕（`endpoint` 只有 host，不含路径与密钥）。 */
  get stats() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      provider: this.provider,
      shape: this.shape,
      tools: this.shape === 'plugin' ? this.pluginTools : [],
      model: this.model || null,
      voice: this.voice || null,
      endpoint: hostOf(this.url),
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
    if (typeof fetchImpl === 'function') {
      this.#fetch = fetchImpl;
      this.#direct = false;
    }
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
    if (!this.enabled) return fail('语音合成未启用或配置不完整（需要 enabled、url、apiKey 与可用的 fetch）');
    // `plugin` 档：不打请求，把"下一步做什么"直接回给模型（对齐生图的 plugin 引擎）。
    if (this.shape === 'plugin') return fail(this.#pluginHint());

    const body = String(text ?? '').trim();
    if (!body) return fail('要读的内容是空的');
    if (body.length > this.maxChars) {
      return fail(`太长（${body.length} 字，上限 ${this.maxChars}）：分几句分别合成，或者把 tts.maxChars 调大`);
    }

    const useVoice = String(voice ?? '').trim() || this.voice;
    const useSpeed = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : this.speed;
    const useRef = refAudio === undefined ? this.refAudio : String(refAudio ?? '').trim();
    const useRefText = refText === undefined ? this.refText : String(refText ?? '').trim();
    // 参考音频：`speech` 形状按可配字段发；`chat` 形状只有 MiMo 的 `voiceclone` 模型吃得下
    // （它要的是参考音频的裸 base64，放在 `audio.voice` 里）。
    const needRef = this.shape === 'speech' || (this.shape === 'chat' && /voiceclone/i.test(this.model));
    const refPayload = needRef && useRef ? await this.#refPayload(useRef) : null;
    if (refPayload && refPayload.error) return fail(refPayload.error);

    // 两家模型的必填项先在本地说清，别让上游回一句看不清因果的 400。
    if (this.shape === 'chat') {
      const model = String(this.model || '').toLowerCase();
      const style = useVoice || String(this.instructions || '').trim();
      if (model.includes('voicedesign') && !style) {
        return fail('voicedesign 模型必须给音色描述：把那段描述填在「音色」里（tts.voice 或段里的 voice）');
      }
      if (model.includes('voiceclone') && !refPayload) {
        return fail('voiceclone 模型必须给参考音频：填 tts.refAudio（mp3/wav 文件或 data URL）');
      }
    }

    const request = this.#bodyFor({ body, useVoice, useSpeed, refPayload, useRefText });

    const ext = (FORMATS.get(this.format) ?? FORMATS.get('mp3')).ext;
    const signature = crypto
      .createHash('sha256')
      .update(JSON.stringify({ url: this.url, shape: this.shape, ...request }))
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
    // 线上字节单独留一份：出错时它和 `request` 一起进诊断文件（`#dumpDiag`），
    // 用来回答"本地拼的和真正发出去的是不是一个东西"——这一问在 `m31125` 上卡了一整天。
    const wire = JSON.stringify(request);
    let wireStatus = null;
    let wireSnippet = '';
    try {
      const res = await this.#request(this.endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body: wire,
      });
      wireStatus = res?.status ?? null;
      if (!res || !res.ok) {
        const detail = await this.#snippet(res);
        wireSnippet = detail;
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
      const raw = String(err?.message ?? err) || '语音合成失败';
      // 这一句是给人看的诊断（`m30659` 真机又报了一次同样的 400，但代码里早就只发 assistant）：
      // 上游说"不许 system"，就把它这次真正收到的角色、模型、每条长度都写清楚——
      // 下次再出现时，光看这句话就能判断是形状错、模型错，还是本地发的和上游收的不是一回事。
      const msgs = Array.isArray(request.messages) ? request.messages : [];
      // 指纹也并进回执：这句话会原样出现在工具结果里，用户贴回来就能与本地复刻逐字节比对，
      // 不必等下一次重启再去翻 tmp 里的诊断文件（`m31125` 那条链路上到底是谁改了请求体）。
      const wireSha = crypto.createHash('sha256').update(wire).digest('hex').slice(0, 12);
      const wireBytes = Buffer.byteLength(wire, 'utf8');
      const hint =
        this.shape === 'chat' && /system\s*(role|message)/i.test(raw)
          ? `（本地这次发的是 [${msgs.map((m) => m.role).join(', ')}]，` +
            `model=${this.model || '(空)'}，每条 ${msgs.map((m) => String(m.content ?? '').length).join('/')} 字，` +
            `共 ${wireBytes} 字节 / 指纹 ${wireSha}` +
            `；仍报这句就把这句原话贴回来，好和本地复刻逐字节比对）`
          : '';
      const message = this.#redact(raw).slice(0, 600) + hint;
      this.#dumpDiag({ wire, request, wireStatus, wireSnippet, message: raw });
      this.#stats.failed += 1;
      this.#stats.lastError = message;
      this.#log(`语音合成失败：${message}`);
      return fail(message);
    }
  }

  /**
   * 出错时把"这次到底发了什么、谁发的、回了什么"落到一个固定文件里。
   *
   * 为什么要落到磁盘而不是日志里：宿主（Electron）的 stdout 不落盘，`log()` 打完就没了，
   * 而这条链路上"本地拼的请求体"和"真正上线的字节"可能不一致（中间换了 fetch 实现/代理）。
   * 文件固定为 `<tmp>/onebot-tts-last.json`，每次失败覆盖，不带密钥（`#redact` 过一遍）。
   */
  #dumpDiag({ wire, request, wireStatus, wireSnippet, message }) {
    try {
      const impl = this.#fetch;
      const rec = {
        at: new Date(this.#now()).toISOString(),
        endpoint: this.endpoint,
        shape: this.shape,
        provider: this.provider,
        model: this.model ?? null,
        // 请求体：解析后的结构 + 真正发出去的字节（长度、指纹、开头一小段）。
        messages: (request.messages ?? []).map((m) => ({ role: m.role, len: String(m.content ?? '').length })),
        bodyKeys: Object.keys(request),
        wireBytes: Buffer.byteLength(wire, 'utf8'),
        wireSha: crypto.createHash('sha256').update(wire).digest('hex').slice(0, 16),
        wireHead: this.#redact(wire).slice(0, 240),
        // 到底是谁在发：宿主可能把 globalThis.fetch 换成了自己的实现（代理/埋点），
        // 换过之后"我们拼的"和"它发的"就不是一回事了，这里把它记下来。
        fetchSame: impl === globalThis.fetch,
        fetchName: typeof impl?.name === 'string' ? impl.name : null,
        fetchSrc: (() => {
          try {
            return String(impl).replace(/\s+/g, ' ').slice(0, 200);
          } catch {
            return null;
          }
        })(),
        status: wireStatus,
        responseHead: this.#redact(String(wireSnippet ?? '')).slice(0, 300),
        error: this.#redact(String(message ?? '')).slice(0, 400),
      };
      fs.writeFileSync(this.diagFile, JSON.stringify(rec, null, 1), 'utf8');
    } catch {
      /* 诊断本身绝不往上抛：合成失败已经够糟了 */
    }
  }

  /**
   * 请求头按形状分开：方舟 Agent Plan 认 `X-Api-Key` + `X-Api-Resource-Id`（不认 Bearer），
   * 豆包语音 V1 的鉴权头是 `Bearer; <token>`（**分号不是空格**，写成标准 Bearer 直接 401），
   * 其余兼容服务一律标准 Bearer。
   */
  #headers() {
    if (this.shape === 'ark') {
      return {
        'content-type': 'application/json',
        accept: 'audio/*,application/json',
        'x-api-key': this.apiKey,
        'x-api-resource-id': this.resourceId,
        // 想要的响应里带回 usage（计费 token 数），不带也没影响。
        'x-control-require-usage-tokens-return': '*',
      };
    }
    return {
      'content-type': 'application/json',
      accept: 'audio/*,application/json',
      authorization: this.shape === 'doubao' ? `Bearer; ${this.apiKey}` : `Bearer ${this.apiKey}`,
    };
  }

  /**
   * `speech` 形状：OpenAI `/audio/speech` 那一套（`input` + `voice` + `response_format`）。
   * 空字段一律**不发**——`model`/`voice` 没有默认值，用户不填就是不填。
   */
  #speechBody({ body, useVoice, useSpeed, refPayload = null, useRefText = '' }) {    return {
      ...(this.model ? { model: this.model } : {}),
      input: body,
      ...(useVoice ? { voice: useVoice } : {}),
      response_format: this.format,
      ...(useSpeed !== 1 ? { speed: useSpeed } : {}),
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(refPayload && this.refAudioField ? { [this.refAudioField]: refPayload.value } : {}),
      ...(refPayload && useRefText && this.refTextField ? { [this.refTextField]: useRefText } : {}),
    };
  }

  /**
   * 每家认的格式不一样，认不出的一律退回它自己的默认——比把 `opus` 硬塞给只认
   * `mp3/pcm/flac/wav` 的实现、再回一句"参数错误"强。
   */
  #fmt(allowed, fallback) {
    return allowed.has(this.format) ? this.format : fallback;
  }

  /**
   * `chat` 形状：小米 MiMo 的 TTS 走 `chat/completions`，形状按官方文档来
   * （<https://mimo.mi.com/static/docs/api/audio/tts.md>，`m30769` 真机也对上了）。
   *
   * 三个模型的规矩各不相同，混着来就是 400：
   * - `mimo-v2.5-tts-voicedesign`：**必须有 `user` 消息**（内容是音色描述），要念的正文放
   *   `assistant`；**不能带 `audio.voice`**（带了回 `audio.voice is not supported for
   *   voice design model`）。
   * - `mimo-v2.5-tts-voiceclone`：`audio.voice` **必填**，且只收参考音频的 base64（mp3/wav）。
   * - `mimo-v2.5-tts`（不带后缀）：`audio.voice` 可填内置音色（`mimo_default`/`冰糖`/`茉莉`/
   *   `苏打`/`白桦`/`Mia`/`Chloe`/`Milo`/`Dean`）；填一段描述会被当成无效音色，所以描述一律
   *   走 `user` 消息（那一层不会被念出来）。
   *
   * 另外三条铁律：不发 `system`（`m30480` 真机）、`voice` 在 `audio` 里面而不是顶层、不带 `speed`
   * （文档没有这个字段）。
   */
  #chatBody({ body, useVoice, useSpeed, refPayload = null }) {
    const style = String(useVoice || this.instructions || '').trim();
    const model = String(this.model || '').toLowerCase();
    const design = model.includes('voicedesign');
    const clone = model.includes('voiceclone');
    const builtin = MIMO_VOICES.has(style.toLowerCase());
    // MiMo 只认这四种格式（默认 wav）；别的形状才用 opus/aac/flac 那套。
    const format = MIMO_FORMATS.has(this.format) ? this.format : 'wav';
    // user 消息只在"要描述音色"的时候出现：voicedesign 必须给，普通模型只在给的是
    // 一段描述（不是内置音色名）时给——把 `冰糖` 当描述发过去，等于让模型自己猜音色。
    const messages = [];
    if (style && (design || !clone && !builtin)) messages.push({ role: 'user', content: style });
    messages.push({ role: 'assistant', content: body });
    // voiceclone 要的是 **DataURL**（`audio.voice must be a DataURL for voice clone model`，
    // `m30926` 真机 400 原话）：本地文件本来就被读成 data URL，别再剥成裸 base64。
    const cloneVoice = (() => {
      const v = String(refPayload?.value ?? '');
      if (!v) return undefined;
      return /^data:/i.test(v) ? v : `data:audio/wav;base64,${v.replace(/^base64:\/\//i, '')}`;
    })();
    const audio = {
      format,
      ...(clone
        ? { voice: cloneVoice }
        : !design && builtin
          ? { voice: style }
          : {}),
    };
    return {
      ...(this.model ? { model: this.model } : {}),
      messages,
      audio,
    };
  }

  /** 按形状挑请求体（新加一家只动这里 + `#audioIn`，`synth` 不用改）。 */
  #bodyFor({ body, useVoice, useSpeed, refPayload = null, useRefText = '' }) {
    switch (this.shape) {
      case 'chat':
        return this.#chatBody({ body, useVoice, useSpeed, refPayload });
      case 'minimax':
        return this.#minimaxBody({ body, useVoice, useSpeed });
      case 'doubao':
        return this.#doubaoBody({ body, useVoice, useSpeed });
      case 'ark':
        return this.#arkBody({ body, useVoice, useSpeed });
      default:
        return this.#speechBody({ body, useVoice, useSpeed, refPayload, useRefText });
    }
  }

  /**
   * `minimax` 形状：`text` 平铺，音色/语速在 `voice_setting` 里，格式在 `audio_setting` 里。
   * `voice_setting` 整体只在有音色时才发——空对象进去那一档会报参数缺失。
   */
  #minimaxBody({ body, useVoice, useSpeed }) {
    return {
      ...(this.model ? { model: this.model } : {}),
      text: body,
      stream: false,
      ...(useVoice
        ? {
            voice_setting: {
              voice_id: useVoice,
              // 文档：speed 范围 [0.5, 2]，超了直接报参数错误。
              speed: Math.min(2, Math.max(0.5, useSpeed)),
              vol: 1,
              pitch: 0,
            },
          }
        : {}),
      audio_setting: {
        format: this.#fmt(MINIMAX_FORMATS, 'mp3'),
        sample_rate: 32000,
        bitrate: 128000,
      },
    };
  }

  /**
   * `doubao` 形状（豆包语音 V1 `POST /api/v1/tts`）：`app` / `user` / `audio` / `request` 四段，
   * 段名与必填项是对着真机 400 一句句试出来的（`Missing required: app.appid → app.cluster →
   * user.uid → audio → request.reqid`）——这家的文档把必填项写在示例里，不试就不知道哪些是硬的。
   *
   * `app.token` 要再放一份：它的鉴权头与 body 里都认 token，只给头在某些账号上仍报 login fail。
   */
  #doubaoBody({ body, useVoice, useSpeed }) {
    return {
      app: {
        appid: this.appId,
        token: this.apiKey,
        ...(this.cluster ? { cluster: this.cluster } : {}),
      },
      user: { uid: 'dsh-onebot-hub' },
      audio: {
        ...(useVoice ? { voice_type: useVoice } : {}),
        encoding: this.#fmt(VOLC_FORMATS, 'mp3'),
        ...(useSpeed !== 1 ? { speed_ratio: useSpeed } : {}),
      },
      request: {
        reqid: crypto.randomUUID(),
        text: body,
        operation: 'query',
      },
    };
  }

  /**
   * `ark` 形状（火山方舟 Agent Plan `POST /api/v3/plan/tts/unidirectional`）：
   * `req_params{ text, speaker, audio_params{format, sample_rate} }`，鉴权走 `X-Api-Key` +
   * `X-Api-Resource-Id: seed-tts-2.0`（这套凭据和豆包语音 V1 的 appid/token **不通用**）。
   * 音色这一家叫 `speaker`（`zh_female_vv_uranus_bigtts` 这类），不叫 `voice`。
   */
  #arkBody({ body, useVoice, useSpeed }) {
    return {
      req_params: {
        text: body,
        ...(useVoice ? { speaker: useVoice } : {}),
        audio_params: {
          format: this.#fmt(VOLC_FORMATS, 'mp3'),
          sample_rate: 24000,
          ...(useSpeed !== 1 ? { speed_ratio: useSpeed } : {}),
        },
      },
    };
  }

  /**
   * 方舟的分块 JSON 流：每行一个对象，成功行的 `data` 是一小段 base64，`code:20000000` 是结束标记。
   * 所以既不能当二进制读（会拿到一堆 `{`），也不能当单个 JSON 解析（第一行就已经是完整 JSON 了）。
   * 出错时（`code > 0` 且不是结束码）把上游的 `message` 原样给出来——它的 message 通常直接点名字段。
   */
  async #arkAudio(res) {
    let raw = '';
    try {
      if (typeof res.text === 'function') raw = await res.text();
      else if (typeof res.json === 'function') raw = JSON.stringify((await res.json()) ?? null);
    } catch {
      raw = '';
    }
    const chunks = [];
    let lastCode = 0;
    let lastMessage = '';
    let useUrl = '';
    for (const line of String(raw).split(/\r?\n/)) {
      const text = line.trim().replace(/^data:\s*/, '');
      if (!text || text === '[DONE]') continue;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      const code = Number(json.code ?? 0);
      if (code === 20000000) break; // 合成结束
      if (code > 0) {
        lastCode = code;
        lastMessage = String(json.message ?? json.msg ?? '').trim();
        break;
      }
      if (typeof json.data === 'string' && json.data) chunks.push(Buffer.from(json.data, 'base64'));
      else useUrl = useUrl || String(json.url ?? json.audio?.url ?? '').trim();
    }
    if (chunks.length) {
      const bytes = Buffer.concat(chunks);
      if (bytes.length) return { bytes, mediaType: FORMATS.get(this.format)?.mime ?? null };
    }
    if (useUrl && isHttp(useUrl)) {
      const audio = await this.#request(useUrl, { method: 'GET', headers: { accept: 'audio/*' } });
      if (audio && audio.ok) {
        const bytes = Buffer.from(await audio.arrayBuffer());
        if (bytes.length) return { bytes, mediaType: audio.headers?.get?.('content-type') ?? null };
      }
    }
    if (lastCode) {
      return { error: `上游返回失败（${lastCode}）：${lastMessage || '没有说明'}` };
    }
    const keys = String(raw).trim().slice(0, SNIPPET_LIMIT);
    return {
      error: '上游没有返回音频（方舟的分块流里没有 data 片段）'
        + (keys ? `；收到的内容前 ${keys.length} 字符：${this.#redact(keys)}` : '')
        + '。检查 X-Api-Resource-Id 是否为 seed-tts-2.0，以及 speaker 是否是这套音色里存在的名字',
    };
  }

  /**
   * `plugin` 档的说明：**枢纽不在这一档合成**（对齐生图的 plugin 引擎，`m29571`）。
   *
   * 与其让模型猜「为什么说了没声音」，不如把下一步直接写给它：调哪个工具、拿到文件之后
   * 按哪个段发出去。工具名来自配置（没配就让它自己看工具面）。
   */
  #pluginHint() {
    const tools = this.pluginTools.length
      ? this.pluginTools.map((n) => `\`${n}\``).join(' / ')
      : '语音合成工具';
    return `没合成：tts.provider=plugin，枢纽不自己合成——用 ${tools} 生成音频文件，`
      + '再把文件按 {"type":"record","file":"<路径>"} 段发出去';
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
      /**
       * **先看大小再读**：参考音频是本地路径，配置写成一个 2GB 的视频文件不会有任何提示，
       * 读进来的那一刻进程就 OOM 了。上限 16MB——比任何一家要求的参考音频长度都宽得多。
       */
      const stat = fs.statSync(source.value);
      if (!stat.isFile()) return { error: `参考音频不是文件：${source.value}` };
      if (stat.size > MAX_REF_AUDIO_BYTES) {
        return { error: `参考音频太大（${(stat.size / 1048576).toFixed(1)}MB，上限 ${MAX_REF_AUDIO_BYTES / 1048576}MB）` };
      }
      if (!stat.size) return { error: '参考音频是空文件' };
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
      // 落到系统临时目录而不是 `process.cwd()`——工作目录可能是仓库或只读目录，
      // 往里写会在源码树里留下 `tts-out/`（测试跑一遍就脏一次）。
      const dir = path.join(os.tmpdir(), 'dsh-onebot-tts');
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
   * 走到 `chat` 形状时还要多认一处：音频挂在 `choices[0].message.audio.data`（chat
   * completions 的音频模态就是这么回的），`content` 里直接塞 base64 或 URL 的也见过。
   * 另外**按文本读再自己解析**，不直接 `res.json()`：有些实现在音频模式下默认走 SSE
   * （整段是 `data: {...}` 若干行），`res.json()` 当场抛错就什么都看不到了。
   */
  async #audioOf(res) {
    // 方舟 Agent Plan 的返回是**分块 JSON 流**（一行一个对象，音频在每行的 `data` 里，
    // `code:20000000` 表示结束），不是"一个 JSON 里挂着 base64"，所以先单独走一条。
    if (this.shape === 'ark') return this.#arkAudio(res);
    const type = String(res?.headers?.get?.('content-type') ?? '').toLowerCase();
    if (type.includes('json') || type.includes('event-stream')) {
      let raw = '';
      try {
        // 真 fetch 两条都有；测试替身可能只给 `json()`，那就退化成先解析再序列化。
        if (typeof res.text === 'function') raw = await res.text();
        else if (typeof res.json === 'function') raw = JSON.stringify((await res.json()) ?? null);
      } catch {
        raw = '';
      }
      const candidates = jsonCandidates(raw);
      for (const json of candidates) {
        const got = await this.#audioIn(json);
        if (got) return got;
      }
      // 找不到音频时把**实际收到的字段**列出来：形状不对靠猜没用，靠这个一眼就改对。
      const head = candidates[0] ?? null;
      const keys = head && typeof head === 'object' ? Object.keys(head).slice(0, 12).join('、') : '（不是 JSON 对象）';
      const echo = this.#redact(raw || JSON.stringify(head)).slice(0, SNIPPET_LIMIT);
      return {
        error: `上游没有返回音频（顶层字段：${keys}；内容前 ${echo.length} 字符：${echo}）`
          + '。形状对不上就改 tts.shape（speech / chat / minimax / doubao / ark），'
          + '或者把 tts.provider 换成对应的那一家',
      };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return { error: '上游返回的音频是空的' };
    return { bytes, mediaType: (type.split(';')[0].trim()) || null };
  }

  /**
   * 上游在 200 里带的错误：`{base_resp:{status_code,status_msg}}`（MiniMax）、
   * `{code:3001,message}`（豆包，3000 才是成功）、`{error:{code,message}}`（方舟/OpenAI 兼容）。
   * 认出来后原样当失败返回——把上游的原话给用户，比我们自己猜要快得多。
   */
  #upstreamError(json) {
    const text = (v) => (v === undefined || v === null ? '' : String(v)).trim();
    const base = json.base_resp ?? null;
    if (base && Number(base.status_code) !== 0 && Number(base.status_code) !== 1000) {
      return `上游返回失败（${base.status_code}）：${text(base.status_msg) || '没有说明'}`;
    }
    if (typeof json.code === 'number' && json.code !== 0 && json.code !== 3000) {
      return `上游返回失败（${json.code}）：${text(json.message) || '没有说明'}`;
    }
    const err = json.error ?? null;
    if (err && typeof err === 'object' && (err.message || err.code)) {
      return `上游返回失败（${text(err.code) || '未知'}）：${text(err.message) || '没有说明'}`;
    }
    return null;
  }

  /** 从一段 JSON 里挑出音频（base64/hex 字符串，或要靠 URL 再取一次）；挑不到返回 `null`。 */
  async #audioIn(json) {
    if (!json || typeof json !== 'object') return null;
    // 上游用 HTTP 200 报错是常态（MiniMax 的 `base_resp`、豆包的 `code` 都是 200 里的错），
    // 不认这两处的话，鉴权失败会显示成"没返回音频"，看起来像形状配错了。
    const upstream = this.#upstreamError(json);
    if (upstream) return { error: upstream };
    const message = json.choices?.[0]?.message ?? json.choices?.[0]?.delta ?? null;
    // ① 音频本体：各家挂的位置不一样（`m29544` 的五档），按"最像"的排前面。
    const packed = json.audio?.data // OpenAI 音频模态 / MiMo
      ?? json.data?.audio // MiniMax：{data:{audio:'<hex>'}}
      ?? json.output?.audio?.b64_json
      ?? json.audio // {audio:'<base64>'} 这类中转
      ?? json.b64_json
      ?? json.data?.[0]?.b64_json
      ?? json.data?.[0]?.audio
      ?? message?.audio?.data
      ?? (typeof json.data === 'string' ? json.data : null) // 方舟这类 `data` 直接是串
      ?? (typeof message?.content === 'string' && looksLikeBase64(message.content) ? message.content : null);
    if (typeof packed === 'string' && packed.trim()) {
      const bytes = decodeAudio(packed, this.shape);
      if (!bytes.length) {
        const how = HEX_SHAPES.has(this.shape) ? 'hex' : 'base64';
        return { error: `上游返回的音频解不开（按 ${how} 解出来是空的）` };
      }
      const mediaType = json.media_type
        ?? message?.audio?.mime_type
        ?? json.output?.audio?.mime_type
        ?? null;
      return { bytes, mediaType };
    }
    // ② 只给了地址：自己再取一次（有的实现把成品放 OSS/CDN 上）。
    const url = json.url
      ?? json.audio?.url
      ?? json.data?.[0]?.url
      ?? json.output?.audio?.url
      ?? message?.audio?.url
      ?? (typeof message?.content === 'string' && isHttp(message.content) ? message.content : null);
    if (typeof url === 'string' && isHttp(url)) {
      const audio = await this.#request(url, { method: 'GET', headers: { accept: 'audio/*' } });
      if (!audio || !audio.ok) return { error: `音频下载失败：上游返回 HTTP ${audio?.status ?? '未知'}` };
      const bytes = Buffer.from(await audio.arrayBuffer());
      if (!bytes.length) return { error: '音频下载回来是空的' };
      return { bytes, mediaType: audio.headers?.get?.('content-type') ?? null };
    }
    return null;
  }

  /** 真正发请求的地方：AbortController + 超时竞速（上游不理会 abort 也不会把这里挂死）。 */
  async #request(url, init = {}) {
    const fetchImpl = this.#fetch;
    const method = String(init.method ?? 'POST').toUpperCase();
    const direct = this.#direct === true && method === 'POST';
    if (!direct && typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch');
    const controller = new AbortController();
    let timerId = null;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error(`语音合成请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
    });
    try {
      const pending = direct
        ? httpPost(url, init, controller.signal)
        : Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }));
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
