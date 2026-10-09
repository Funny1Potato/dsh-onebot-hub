// 二次元角色识别（§23.6 看图链路的第二层）。
//
// 为什么要有这一层：
//   上游发来的图片已经会交给视觉模型写一段中文描述（见 `lib/vision.js`），但描述是"给人看"
//   的——"一个白发少女站着"——它认不出这是谁。想知道"这张图是谁"，得问专门的角色识别后端：
//   本地 WD14 服务（`anime-recognize`，延迟低、图不出机器、能给出置信度与 NSFW 分）或公共
//   AnimeTrace API（覆盖面广，但只有名字、要过第三方）。
//
// 三条自律，和 `vision.js` 一脉相承：
//   1. **本地优先**（backend='both'）：本地服务在自己的机器上，快、可控、还能给置信度。
//      只有本地没认出、或本地服务报错，才把图发给公共 API——图是用户的，能不出门就不出门。
//   2. **"服务挂掉"不等于"没认出"**：后端全挂时 `recognize()` 返回**空字符串**，绝不渲染
//      `[角色识别: 未能识别]`。前者是"我们现在问不到"，后者是"图里确实没有角色"；把故障
//      写成结论，模型会把"没有角色"当成事实记进上下文。宁可什么都不说。
//   3. **缓存按 backend 分键**：同一张图的 sha256 在 'anime-recognize' 与 'animetrace' 下
//      答案可能不同（本地会按阈值丢掉低置信度的角色，公共 API 照样给名字），所以键是
//      `sha256:backend` 而不是裸 sha256。丢一次哈希钱，换缓存不串味。
//
// 本模块不 import 任何宿主包（可离线、可确定性测试）：网络走注入的 `fetchImpl`，
// 落盘走注入的 `storage`（JsonStore）。

import crypto from 'node:crypto';

/** 识别后端：off 关闭 / anime-recognize 本地服务 / animetrace 公共 API / both 本地优先再公共。 */
export const ANIME_BACKENDS = ['off', 'anime-recognize', 'animetrace', 'both'];

/** 缓存文件（相对 `storage.dir`）。 */
export const ANIME_CACHE_FILE = 'vision/anime-cache.json';

export const DEFAULT_MIN_CONFIDENCE = 0.85;
// 只显示置信度最高的那一个（用户 m30282 定案）：之前默认 3 个，一串名字又长又吵。
export const DEFAULT_MAX_CHARACTERS = 1;
export const DEFAULT_NSFW_THRESHOLD = 0.5;
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_ANIMETRACE_TIMEOUT_MS = 20000;
export const DEFAULT_CACHE_LIMIT = 500;
export const DEFAULT_ANIMETRACE_URL = 'https://api.animetrace.com';

/** AnimeTrace 的业务码白名单：ok / 老版本 ok / "没找到匹配"（也是有效回答，不算故障）。 */
export const ANIMETRACE_OK_CODES = new Set([0, 200, 17720]);
/** 业务码 17703：模型名过期，要重查模型列表再重试。 */
export const ANIMETRACE_MODEL_EXPIRED_CODE = 17703;

/** 命中但整条结果被标记为 NSFW 时的渲染串（名字会被扣掉，不下发到聊天里）。 */
export const NSFW_PLACEHOLDER = '[角色识别: 已识别但标记为 NSFW]';
/**
 * 后端答了、但没认出任何（够置信度的）角色。
 * `m30282` 起**渲染层不再输出它**——置信度低的不显示结果，认不出也什么都不说（返回空串）；
 * 常量保留给测试与调用方对语义，别再把"没认出"写成一条上下文事实。
 */
export const NOT_FOUND_TEXT = '[角色识别: 未能识别]';

/** 后端别名表：部署配置里手写的值五花八门，宽松认一下。 */
const BACKEND_ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['no', 'off'],
  ['false', 'off'],
  ['disable', 'off'],
  ['disabled', 'off'],
  ['anime-recognize', 'anime-recognize'],
  ['anime_recognize', 'anime-recognize'],
  ['animerecognize', 'anime-recognize'],
  ['local', 'anime-recognize'],
  ['wd14', 'anime-recognize'],
  ['animetrace', 'animetrace'],
  ['anime-trace', 'animetrace'],
  ['anime_trace', 'animetrace'],
  ['trace', 'animetrace'],
  ['both', 'both'],
  ['all', 'both'],
]);

/**
 * 宽松归一后端取值：认不出的返回 `fallback`（`fallback` 自己也归一一次，归一失败落 'off'）。
 * @param {unknown} value
 * @param {string} [fallback='off']
 * @returns {'off'|'anime-recognize'|'animetrace'|'both'}
 */
export function normalizeBackend(value, fallback = 'off') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw) {
    const hit = BACKEND_ALIASES.get(raw);
    if (hit) return hit;
  }
  const fb = BACKEND_ALIASES.get(String(fallback ?? '').trim().toLowerCase());
  return fb ?? 'off';
}

/** 图片字节的 sha256（调用方已经算过就传进来，省一次哈希）。 */
export function sha256Of(bytes) {
  if (!bytes) return null;
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * 渲染一行可直接拼进聊天的角色识别结果。
 *
 * 规则：
 *   · 有可用名字且未被判 NSFW → `[角色识别: 名字 90.0%]`（逗号分隔，最多 maxCharacters 个；
 *     没有置信度的（AnimeTrace / 本地缺字段）只写名字、不带百分号）；**有作品名时写成
 *     `名字（作品）`**（"这是谁"的一半答案在作品上），作品名**不截断**——一行长一点，
 *     好过让模型对着一个认不出的名字猜。
 *   · 有角色但整条被标记 NSFW → `[角色识别: 已识别但标记为 NSFW]`（名字不下发）。
 *   · 后端答了但一个角色都没认出（或全被置信度筛掉）→ **空串**（`m30282`：不显示结果）。
 *
 * @param {{characters?: Array<{name:string,work?:string|null,confidence:number|null}>, nsfw?: boolean|null, maxCharacters?: number}} input
 * @returns {string}
 */
export function renderAnimeLine({ characters = [], nsfw = null, maxCharacters = DEFAULT_MAX_CHARACTERS } = {}) {
  const max = Math.max(1, Number(maxCharacters) || DEFAULT_MAX_CHARACTERS);
  const list = Array.isArray(characters) ? characters : [];
  const named = list.filter((c) => c && String(c.name ?? '').trim());
  // 只有"确实认出了角色、但被判 NSFW"才用占位串；没认出/全被置信度筛掉 → 空串（m30282：
  // 置信度低的不显示结果——"没认出"不再写成一条上下文事实，模型看到没有这行字就对了）。
  if (nsfw === true && list.length > 0) return NSFW_PLACEHOLDER;
  if (!named.length) return '';
  const parts = named.slice(0, max).map((c) => {
    const conf = typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : null;
    const work = String(c.work ?? '').trim();
    const label = work ? `${c.name}（${work}）` : c.name;
    return conf === null ? label : `${label} ${(conf * 100).toFixed(1)}%`;
  });
  return `[角色识别: ${parts.join(', ')}]`;
}

/** 拼 URL：base 去掉尾斜杠 + '/' + suffix 去掉头斜杠。 */
function joinUrl(base, suffix) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const s = String(suffix ?? '').replace(/^\/+/, '');
  return b ? `${b}/${s}` : `/${s}`;
}

/** 只在真的是数字时返回数字：`null`/`''`/布尔都按"没有"处理（`Number(null)` 是 0，会坑人）。 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * rating 归一成 NSFW 分：对象取 `nsfw`（或 `nsfw_score`/`r18`），字符串 'sfw' 记 0、其它记 1，
 * 认不出返回 null（"不知道"而不是"不 NSFW"）。
 */
function nsfwScoreOf(rating) {
  if (rating === null || rating === undefined) return null;
  if (typeof rating === 'number') return Number.isFinite(rating) ? rating : null;
  if (typeof rating === 'string') {
    const s = rating.trim().toLowerCase();
    if (!s) return null;
    if (s === 'sfw' || s === 'safe' || s === 'general' || s === 'none') return 0;
    return 1;
  }
  if (typeof rating === 'object') return toFiniteNumber(rating.nsfw ?? rating.nsfw_score ?? rating.r18);
  return null;
}

/** 是否达到 NSFW 阈值；分不清就返回 null。 */
function nsfwFlagOf(rating, threshold) {
  const score = nsfwScoreOf(rating);
  if (score === null) return null;
  return score >= threshold;
}

/** JSON 解析（失败抛给调用方的 catch）。 */
function parseJson(text) {
  return JSON.parse(String(text ?? ''));
}

/**
 * 后端报错时把"它到底说了什么"带上（压成一行，**不按字数截**——`m24155`：不希望再看到任何
 * 因为字数被截断的事情；原文多长都给全，只去掉换行防止刷屏）。
 *
 * 为什么：真接口非 2xx 时响应体里其实写清了原因（例如限流是 `{"code":17737,
 * "zh_message":"请求过于频繁，请稍后再试"}`），只报 `HTTP 429` 会让人以为是接口坏了；
 * 而"HTTP 500"也可能是我们自己把 `model` 填成了展示名。错误串里带一句原文，分诊才有的下手。
 */
function detailOf(payload, raw) {
  const said = [payload?.zh_message, payload?.message, payload?.msg, payload?.detail].find((v) => typeof v === 'string' && v.trim());
  const text = String(said ?? raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `（${text}）`;
}

/** 错误转成人话：超时单独说，其余用 message。 */
function describeError(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return '请求超时';
  return String(err?.message ?? err);
}

/** 手拼 multipart/form-data：不依赖 FormData 的实现差异，body 与 boundary 都由我们说了算。 */
function buildMultipart(fields, file) {
  const boundary = `----dsh-onebot-hub-${crypto.randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`, 'utf8'));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mediaType}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 压缩回调是调用方给的：它抛错/返回空都按"压不了"处理，绝不把异常漏出去。 */
async function callShrink(shrink, bytes) {
  if (typeof shrink !== 'function') return null;
  try {
    const out = await shrink(bytes);
    return out && out.length ? Buffer.from(out) : null;
  } catch {
    return null;
  }
}

/** 从 AnimeTrace `GET /v1/model/list` 的响应里挑出默认模型名（形状不唯一，能认的都认）。 */
function pickModelName(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const asString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // **机器名优先**：真接口的每一项是 `{ id: 'animetrace-yuri-4.2', name: 'AnimeTrace Yuri 4.2' }`，
  // `id` 才是能塞进 `model` 字段的那个；`name` 是给人看的展示名，拿它去搜图服务端直接 HTTP 500
  // （真机事故：整条识别链因此全挂，而错误只报"HTTP 500"，看不出是名字挑错了）。
  const fromItem = (item) => {
    if (typeof item === 'string') return asString(item);
    if (!item || typeof item !== 'object') return null;
    return asString(item.id) ?? asString(item.model) ?? asString(item.model_name) ?? asString(item.model_id) ?? asString(item.name);
  };
  const data = payload.data ?? payload;
  if (typeof data === 'string') return asString(data);
  if (Array.isArray(data)) {
    const usable = data.filter((it) => it && typeof it === 'object');
    const dflt = usable.find((it) => it.default === true || it.is_default === true || it.isDefault === true);
    // 没有 default 标记时，优先挑 `enabled: true` 的那一个（真接口会列出多个模型，只有一个 enabled）。
    const picked = dflt ?? usable.find((it) => it.enabled === true) ?? usable[0] ?? data[0];
    return fromItem(picked);
  }
  if (data && typeof data === 'object') {
    const direct =
      asString(data.default) ?? asString(data.model_default) ?? asString(data.default_model) ?? asString(data.model) ?? asString(data.name);
    if (direct) return direct;
    if (data.default && typeof data.default === 'object') {
      const nested = fromItem(data.default);
      if (nested) return nested;
    }
    for (const key of ['models', 'list', 'items']) {
      if (Array.isArray(data[key])) {
        const nested = pickModelName({ data: data[key] });
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * 从 AnimeTrace `POST /v1/search` 的 `data` 里摊平出角色（去重、保序，带作品名）。
 *
 * 真机返回的形状（2026-10-07 实测，`data` 每一项是一张脸的框）：
 *
 *   { code: 0, data: [ { box: [0.23, 0.20, 0.68, 0.65], box_id: '2b7e…',
 *                        not_confident: false, character: [ { work: 'ハミダシクリエイティブ', character: '和泉妃愛' } ] } ] }
 *
 * 两条规矩：
 *   · **`not_confident: true` 的整框不采纳**：公共 API 不给数字分（`confidence` 恒为 null），
 *     这个布尔就是它的"我拿不准"。拿不准的名字一旦写进上下文，模型会当成事实说出去，
 *     用户明确要求"可信度低的不采用，显示识别失败即可"——所以整框丢掉，全部如此就渲染"未能识别"。
 *     字段缺失 ≠ 拿不准：老形状没有这个键时照旧采纳。
 *   · **作品名一起带上**：`work` 是"这是谁"的一半答案（用户要求，且**不截断**）；
 *     缺了就只写角色名，不编。
 *
 * @param {unknown} data `payload.data`
 * @returns {Array<{name:string, work:string|null, confidence:null}>}
 */
function readTraceCharacters(data) {
  const out = [];
  const seen = new Set();
  const push = (name, work) => {
    const n = String(name ?? '').trim();
    if (!n) return;
    const w = String(work ?? '').trim();
    const key = `${n}\u0000${w}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, work: w || null, confidence: null });
  };
  const add = (value, work) => {
    if (typeof value === 'string') {
      push(value, work);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) add(v, work);
      return;
    }
    if (value && typeof value === 'object') {
      const inherited = typeof value.work === 'string' && value.work.trim() ? value.work : work;
      for (const key of ['character', 'characters', 'name', 'names', 'character_name', 'char', 'model']) {
        if (value[key] !== undefined) {
          add(value[key], inherited);
          return;
        }
      }
    }
  };
  const list = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
  for (const item of list) {
    if (typeof item === 'string') {
      push(item, null);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    // 这一框它自己都拿不准 → 整框不采纳（见上面第一条）。
    if (item.not_confident === true || item.notConfident === true) continue;
    const own = typeof item.work === 'string' && item.work.trim() ? item.work : null;
    let found = false;
    for (const key of ['character', 'characters', 'name', 'names', 'character_name', 'char', 'model']) {
      if (item[key] !== undefined) {
        add(item[key], own);
        found = true;
      }
    }
    if (!found && typeof item.name === 'string') add(item.name, own);
  }
  return out;
}

/**
 * 二次元角色识别器。网络全靠注入的 `fetchImpl`，落盘全靠注入的 `storage`，
 * 因此可以完全离线、确定性地测。
 */
export class AnimeRecognizer {
  #cache = new Map();
  #stats;
  #model = null;

  /**
   * @param {object} [opts]
   * @param {object} [opts.storage] JsonStore（缓存落在 `<dir>/vision/anime-cache.json`）
   * @param {(msg:string)=>void} [opts.log]
   * @param {string} [opts.backend] `ANIME_BACKENDS` 之一（宽松归一）
   * @param {string} [opts.recognizeUrl] 本地 WD14 服务根地址，如 `http://127.0.0.1:8899`
   * @param {string} [opts.recognizeToken] 本地服务 token（非空则带 `Authorization: Bearer`）
   * @param {string} [opts.animetraceUrl] AnimeTrace 根地址
   * @param {number} [opts.minConfidence] 本地后端的最低置信度（缺 confidence 的角色不参与比较）
   * @param {number} [opts.maxCharacters] 渲染时最多保留几个角色名
   * @param {number} [opts.nsfwThreshold] NSFW 阈值（只对本地后端判断）
   * @param {number} [opts.timeoutMs] 本地后端超时
   * @param {number} [opts.animetraceTimeoutMs] AnimeTrace 超时
   * @param {number} [opts.cacheLimit] 缓存条数上限
   * @param {Function} [opts.fetchImpl] fetch 实现（`attach()` 可后注入）
   * @param {Function} [opts.now]
   */
  constructor({
    storage = null,
    log = () => {},
    backend = 'off',
    recognizeUrl = '',
    recognizeToken = '',
    animetraceUrl = DEFAULT_ANIMETRACE_URL,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    maxCharacters = DEFAULT_MAX_CHARACTERS,
    nsfwThreshold = DEFAULT_NSFW_THRESHOLD,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    animetraceTimeoutMs = DEFAULT_ANIMETRACE_TIMEOUT_MS,
    cacheLimit = DEFAULT_CACHE_LIMIT,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.log = log;
    this.backend = normalizeBackend(backend, 'off');
    this.recognizeUrl = String(recognizeUrl ?? '').trim();
    this.recognizeToken = String(recognizeToken ?? '').trim();
    this.animetraceUrl = String(animetraceUrl ?? '').trim() || DEFAULT_ANIMETRACE_URL;
    this.minConfidence = clampUnit(minConfidence, DEFAULT_MIN_CONFIDENCE);
    this.maxCharacters = Math.max(1, Number(maxCharacters) || DEFAULT_MAX_CHARACTERS);
    this.nsfwThreshold = clampUnit(nsfwThreshold, DEFAULT_NSFW_THRESHOLD);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.animetraceTimeoutMs = Math.max(1, Number(animetraceTimeoutMs) || DEFAULT_ANIMETRACE_TIMEOUT_MS);
    this.cacheLimit = Math.max(1, Number(cacheLimit) || DEFAULT_CACHE_LIMIT);
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.now = now;
    this.#stats = { attempts: 0, hits: 0, misses: 0, failed: 0, lastError: null, lastAt: null };
    this.#load();
  }

  /** 后端不是 off、且真的有 fetch 可用，才谈得上识别。 */
  get enabled() {
    return this.backend !== 'off' && typeof this.fetchImpl === 'function';
  }

  get stats() {
    return {
      backend: this.backend,
      enabled: this.enabled,
      cache: this.#cache.size,
      attempts: this.#stats.attempts,
      hits: this.#stats.hits,
      misses: this.#stats.misses,
      failed: this.#stats.failed,
      lastError: this.#stats.lastError,
      lastAt: this.#stats.lastAt,
    };
  }

  /** 注入/替换 fetch（宿主 `attach()` 时调）。传空则不覆盖已有的。 */
  attach({ fetchImpl = null } = {}) {
    if (typeof fetchImpl === 'function') this.fetchImpl = fetchImpl;
    return this.enabled;
  }

  /** 摘掉 fetch（关停链路时调）：随后 `enabled` 为 false，`recognize` 直接返回空串。 */
  detach() {
    this.fetchImpl = null;
    return this.enabled;
  }

  /**
   * 认一次图。
   *
   * `shrink` 是调用方给的"把图压小"回调（本模块不实现压缩）：只有 AnimeTrace 回 413 时才会调它，
   * 压缩后重试一次；压缩失败按"图太大"报错。注意压缩后仍然用**原图**的 sha256 做缓存键——
   * 调用方问的是"这张图是谁"，缓存也该按那张图算。
   *
   * @param {object} input
   * @param {Buffer|Uint8Array} [input.bytes] 图片字节
   * @param {string} [input.mediaType]
   * @param {string} [input.sha256] 已经有摘要就直接用
   * @param {(bytes:Buffer)=>Promise<Buffer|null>} [input.shrink] 413 时的压缩回调
   * @returns {Promise<{text:string, source:('anime-recognize'|'animetrace'|null), characters:Array<{name:string,confidence:number|null}>, nsfw:boolean|null, cached:boolean, error:string|null}>}
   */
  async recognize({ bytes = null, mediaType = 'image/jpeg', sha256 = null, shrink = null } = {}) {
    this.#stats.attempts += 1;
    const empty = { text: '', source: null, characters: [], nsfw: null, cached: false, error: null };
    // off 是配置选择，不是故障：什么都不说，也不记 error。
    if (!this.enabled) return { ...empty };
    let buf = null;
    try {
      buf = bytes ? Buffer.from(bytes) : null;
    } catch {
      return { ...empty, error: '图片字节不可用' };
    }
    if (!buf?.length) return { ...empty, error: '没有图片字节' };
    const hash = sha256 ? String(sha256) : sha256Of(buf);
    const key = `${hash}:${this.backend}`;
    const hit = this.#cache.get(key);
    if (hit) {
      this.#stats.hits += 1;
      return {
        text: hit.text,
        source: hit.source ?? null,
        characters: (hit.characters ?? []).map((c) => ({ name: c.name, work: c.work ?? null, confidence: c.confidence ?? null })),
        nsfw: hit.nsfw ?? null,
        cached: true,
        error: null,
      };
    }
    this.#stats.misses += 1;

    const wantsLocal = this.backend === 'anime-recognize' || this.backend === 'both';
    const wantsTrace = this.backend === 'animetrace' || this.backend === 'both';

    let characters = [];
    let nsfw = null;
    let source = null;
    let error = null;
    let answered = false;

    if (wantsLocal) {
      const local = await this.#recognizeLocal(buf, mediaType, shrink);
      if (local.ok) {
        answered = true;
        if (local.recognized) {
          characters = local.characters;
          nsfw = local.nsfw;
          source = 'anime-recognize';
        }
        // 本地答了但没认出：'anime-recognize' 落到空串（不渲染），'both' 继续问公共 API。
      } else {
        this.#recordFailure(local.error);
        error = local.error;
      }
    }

    if (!source && wantsTrace) {
      const trace = await this.#recognizeTrace(buf, mediaType, shrink);
      if (trace.ok) {
        answered = true;
        error = null; // 公共 API 答了，故障就算恢复（text 才是结论）
        if (trace.recognized) {
          characters = trace.characters;
          nsfw = trace.nsfw;
          source = 'animetrace';
        }
      } else {
        this.#recordFailure(trace.error);
        error = error ?? trace.error;
      }
    }

    // 只显示置信度最高的那个（m30282）：数字置信度降序，没给分的排后面；再由
    // renderAnimeLine 按 maxCharacters（默认 1）截取。
    characters = [...characters].sort(
      (a, b) => (b?.confidence ?? -1) - (a?.confidence ?? -1),
    );
    // 全挂：返回空串（"问不到"）；答了但没认出/全被筛掉：也是空串（"不显示"，m30282）。
    const text = answered ? renderAnimeLine({ characters, nsfw, maxCharacters: this.maxCharacters }) : '';
    const result = {
      text,
      source,
      characters: characters.slice(0, this.maxCharacters).map((c) => ({ name: c.name, work: c.work ?? null, confidence: c.confidence ?? null })),
      nsfw,
      cached: false,
      error,
    };
    // 至少有一个后端给了回答才落缓存（"答了但没认出"也留痕，下次不重问）；全挂的结果不留痕。
    if (answered) this.remember(hash, { text, source, characters, nsfw });
    this.#stats.lastAt = this.now();
    return result;
  }

  /** 缓存写回（跨重启复用；失败只记日志）。`hash` 是裸 sha256，键由 `sha256:backend` 拼。
   * text 允许空串——"答了但没认出"也要落缓存防重问（m30282）；text 缺席才拒。 */
  remember(hash, entry, backend = this.backend) {
    if (!hash || !entry || entry.text == null) return false;
    this.#cache.set(`${String(hash)}:${String(backend)}`, { ...entry, at: this.now() });
    while (this.#cache.size > this.cacheLimit) {
      // Map 保插入序，最旧的先丢
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    this.#persist();
    return true;
  }

  /** 读缓存（键含 backend）。 */
  cacheOf(hash, backend = this.backend) {
    return hash ? this.#cache.get(`${String(hash)}:${String(backend)}`) ?? null : null;
  }

  /** 缓存导出（`hash` 字段是 `sha256:backend` 复合键）。 */
  snapshot() {
    return [...this.#cache.entries()].map(([hash, entry]) => ({ hash, ...entry }));
  }

  #recordFailure(message) {
    this.#stats.failed += 1;
    this.#stats.lastError = message;
    this.#stats.lastAt = this.now();
  }

  /**
   * 跑一次 HTTP 请求，带 `AbortController` 超时。
   *
   * 关键点是 `Promise.race`：即使 fetch 实现**完全不理 signal**（测试里的"永不 resolve"桩、
   * 某些 adapter），超时也一定会到点结算，不会把调用方吊死。
   */
  async #request(url, init, timeoutMs) {
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch 未接入');
    const controller = new AbortController();
    let timer = null;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const err = new Error('请求超时');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
    });
    // 刻意不 unref：请求超时是必须兑现的承诺，进程不能因为它"不算活"就提前退出。
    timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const pending = Promise.resolve().then(() => this.fetchImpl(url, { ...init, signal: controller.signal }));
      const res = await Promise.race([pending, aborted]);
      let text = '';
      try {
        text = String((await res?.text?.()) ?? '');
      } catch {
        text = '';
      }
      const status = Number(res?.status) || 0;
      const ok = res?.ok === undefined ? status >= 200 && status < 300 : Boolean(res.ok);
      return { ok, status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 本地 WD14 服务：`POST {url}/recognize`，body `{"image":"<base64>"}`。 */
  async #recognizeLocal(bytes, mediaType, shrink) {
    try {
      if (!this.recognizeUrl) throw new Error('未配置本地识别服务地址');
      const url = joinUrl(this.recognizeUrl, 'recognize');
      const headers = { 'content-type': 'application/json' };
      if (this.recognizeToken) headers.authorization = `Bearer ${this.recognizeToken}`;
      let buf = bytes;
      let attempt = 0;
      let payload = null;
      for (;;) {
        const res = await this.#request(url, { method: 'POST', headers, body: JSON.stringify({ image: buf.toString('base64') }) }, this.timeoutMs);
        if (res.status === 413 && attempt < 1) {
          const smaller = await callShrink(shrink, buf);
          if (smaller) {
            buf = smaller;
            attempt += 1;
            continue;
          }
          throw new Error('本地识别服务 HTTP 413（图片太大且无法压小）');
        }
        if (!res.ok) throw new Error(`本地识别服务 HTTP ${res.status}`);
        payload = parseJson(res.text);
        break;
      }
      return this.#readLocalPayload(payload);
    } catch (err) {
      return { ok: false, recognized: false, characters: [], nsfw: null, error: `本地识别失败：${describeError(err)}` };
    }
  }

  /**
   * 解析本地服务的响应。
   *
   * 两条容易踩的规矩：
   *   · **confidence 缺失按 null 处理，并保留该角色**（不按"未达阈值"丢弃）。本地的阈值是给
   *     数字用的；服务没给分，说明它没打算让我们用分筛，此时丢掉一个它已经点名的角色，
   *     比留着更糟。渲染时它只写名字、不带百分号。
   *   · **空名字的条目不悄悄丢**：`characters` 里照样保留（`name` 为空串），只是渲染阶段不占
   *     名额——"名字是空的"和"服务没返回这个角色"是两回事，前者要能看见。
   */
  #readLocalPayload(payload) {
    const raw = Array.isArray(payload?.characters) ? payload.characters : [];
    const characters = [];
    for (const item of raw) {
      const name = String(item?.name ?? '').trim();
      const confidence = toFiniteNumber(item?.confidence);
      if (confidence !== null && confidence < this.minConfidence) continue;
      const work = String(item?.work ?? '').trim();
      characters.push({ name, work: work || null, confidence });
    }
    const nsfw = nsfwFlagOf(payload?.rating, this.nsfwThreshold);
    return { ok: true, recognized: characters.length > 0, characters, nsfw, error: null };
  }

  /** AnimeTrace：先懒加载模型名，再 multipart 搜图。 */
  async #recognizeTrace(bytes, mediaType, shrink) {
    try {
      let buf = bytes;
      let attempt = 0;
      for (;;) {
        const model = await this.#modelName();
        const form = buildMultipart(
          { is_multi: '1', ai_detect: '0', model },
          { field: 'file', filename: 'image.jpg', mediaType: mediaType || 'image/jpeg', bytes: buf },
        );
        const res = await this.#request(
          joinUrl(this.animetraceUrl, 'v1/search'),
          { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body },
          this.animetraceTimeoutMs,
        );
        if (res.status === 413 && attempt < 2) {
          const smaller = await callShrink(shrink, buf);
          if (smaller) {
            buf = smaller;
            attempt += 1;
            continue;
          }
          throw new Error('AnimeTrace HTTP 413（图片太大且无法压小）');
        }
        let payload = null;
        try {
          payload = parseJson(res.text);
        } catch {
          payload = null;
        }
        const code = toFiniteNumber(payload?.code);
        // 400/422 与业务码 17703 都是"模型名过期了"：清掉缓存，重查列表后重试。
        const expired = res.status === 400 || res.status === 422 || code === ANIMETRACE_MODEL_EXPIRED_CODE;
        if (expired && attempt < 2) {
          this.#model = null;
          attempt += 1;
          continue;
        }
        if (!res.ok) throw new Error(`AnimeTrace HTTP ${res.status}${detailOf(payload, res.text)}`);
        if (code === null || !ANIMETRACE_OK_CODES.has(code)) throw new Error(`AnimeTrace 业务码 ${code ?? '未知'}`);
        const characters = readTraceCharacters(payload?.data);
        // 公共 API 不给 NSFW 分：nsfw 保持 null（"不知道"），别假装它说了"安全"。
        return { ok: true, recognized: characters.length > 0, characters, nsfw: null, error: null };
      }
    } catch (err) {
      return { ok: false, recognized: false, characters: [], nsfw: null, error: `AnimeTrace 失败：${describeError(err)}` };
    }
  }

  /**
   * 懒加载 AnimeTrace 的默认模型名，只成功时记住：失败不写缓存，下次还会再问
   * （否则一次网络抖动就会把这个进程的 AnimeTrace 永久废掉）。
   */
  async #modelName() {
    if (this.#model) return this.#model;
    const res = await this.#request(joinUrl(this.animetraceUrl, 'v1/model/list'), { method: 'GET', headers: {} }, this.animetraceTimeoutMs);
    let payload = null;
    try {
      payload = parseJson(res.text);
    } catch {
      payload = null;
    }
    if (!res.ok) throw new Error(`模型列表 HTTP ${res.status}${detailOf(payload, res.text)}`);
    const code = toFiniteNumber(payload?.code);
    if (code !== null && !ANIMETRACE_OK_CODES.has(code)) throw new Error(`模型列表业务码 ${code}`);
    const name = pickModelName(payload);
    if (!name) throw new Error('模型列表里没有可用模型名');
    this.#model = name;
    return name;
  }

  #load() {
    try {
      const data = this.storage?.read?.(ANIME_CACHE_FILE, null);
      const entries = data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : null;
      if (!entries) return;
      let n = 0;
      for (const [key, entry] of Object.entries(entries)) {
        // 键必须是 `sha256:backend`：老格式/坏键直接丢，避免串味。
        // text 允许空串（"答了但没认出"的留痕，m30282）；缺 text 字段才算坏条目。
        if (!entry || typeof entry.text !== 'string') continue;
        if (!String(key).includes(':')) continue;
        this.#cache.set(String(key), {
          text: entry.text,
          source: entry.source === 'anime-recognize' || entry.source === 'animetrace' ? entry.source : null,
          characters: Array.isArray(entry.characters)
            ? entry.characters.map((c) => {
                // 老缓存没有 `work`（那是 2026-10-07 才加上的）：当作"没作品名"用，不失效、不重问。
                const work = String(c?.work ?? '').trim();
                return { name: String(c?.name ?? '').trim(), work: work || null, confidence: toFiniteNumber(c?.confidence) };
              })
            : [],
          nsfw: entry.nsfw === true ? true : entry.nsfw === false ? false : null,
          at: Number(entry.at) || 0,
        });
        n += 1;
      }
      if (n) this.log(`角色识别缓存载入 ${n} 条（同一张图不再问第二次）`);
    } catch (err) {
      this.log(`角色识别缓存载入失败（忽略）：${err?.message ?? err}`);
    }
  }

  #persist() {
    if (!this.storage?.schedule) return;
    try {
      this.storage.schedule(ANIME_CACHE_FILE, () => ({
        version: 1,
        savedAt: this.now(),
        entries: Object.fromEntries(this.#cache),
      }));
    } catch (err) {
      this.log(`角色识别缓存排队失败（忽略）：${err?.message ?? err}`);
    }
  }
}

/** 阈值类参数归一到 [0,1]；NaN/缺省落回默认值。 */
function clampUnit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
