// 生图（文生图 / 参考图生图）：把一句提示词交给一个 OpenAI 兼容的 `images/generations`
// 接口，拿回图片字节。本模块只做"取回字节"这一件事——发不发、发给谁、发失败怎么办，
// 全由上层决定；它不碰会话、不发消息、不写聊天逻辑（可离线测）。
//
// 尺寸怎么缩放，两个方向各有一套说法，本模块各按最保守的那条来：
//   · `maxSize`（如 1024x1024）是"不许超出这个框"——既不许单边超，也不许面积超。
//     做法是等比**内缩**（contain）：缩放因子取 min(1, maxW/w, maxH/h)。单边不超了，面积
//     自然也不超，两条同时成立。要是只按面积缩（sqrt 那套），1846x1846 那种方框里放竖图会
//     得到 886x1182——面积没超，高却顶出了 1024，正是上游最可能直接拒绝的形态。
//   · `minSize`（如 1920x1920）是"像素总数不得低于这个门槛"——豆包 Seedream 这类模型只报
//     最小像素数，边长可以自由。所以只按**面积**向上放大（sqrt(目标面积 / 当前面积)），
//     长宽比一分不损；minSize 与 maxSize 打架时 **minSize 优先**，宁可超预算也不交一张
//     尺寸不达标的图。
//   · `maxSize`/`minSize` 为空字符串时视为"没这个约束"，不要拿一个空串去猜像素。
//   · 宽高一律**取偶数**：多数编解码器按 2 的倍数做下采样，奇数边长容易出现半像素错位、
//     黑边，也更容易被某些网关直接拒绝。
//   · 给不出可用尺寸时（空 spec、看不懂的写法）必须给一个**确定的默认**——默认 1024x1024，
//     再按 maxSize 的面积压回去；不能把随机值甩给上游。
//
// 为什么 apiKey 绝不能进请求体：
//   · 请求体会被上游日志、代理、错误上报原样留存；`Authorization` 头才是约定俗成的密钥通道，
//     密钥只应该出现在这一处。请求体里出现密钥 = 多了一份会被落盘的副本。
//   · 同理 `stats.baseUrl` 只回 host，绝不带路径、查询串或 token，也绝不回 apiKey。
//   · 错误信息同样要**脱敏**：上游回显里要是带了密钥，也得先抹掉再往外抛。
//
// 为什么失败不抛：
//   · 调用方是聊天链路，一次生图失败只该表现为"这张图没出来"，不该把整个会话打崩。
//     所有错误收敛进返回值的 `error` 字段（中文、可读、不含密钥），并记进 `stats`。
//
// 本模块不 import 任何宿主包；网络只走注入的 `fetchImpl`，全部可用假 fetch 离线测。

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_MEDIA_TYPE = 'image/png';
/** 上游回显只捎前这么多字符，够定位问题，又不会把日志刷爆。 */
const SNIPPET_LIMIT = 200;

const SIZE_RE = /^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/;
const RATIO_RE = /^\s*(\d+(?:\.\d+)?)\s*[:：/比]\s*(\d+(?:\.\d+)?)\s*$/;
const DATA_URI_RE = /^data:([^;,]+)?(;base64)?,/i;

/** 关键词 → 长宽比。认不出的取值一律按 square 处理（见 `resolveSpec`）。 */
const KEYWORD_RATIOS = new Map([
  ['square', 1], ['方形', 1], ['正方形', 1], ['正方', 1], ['1:1', 1],
  ['portrait', 3 / 4], ['竖版', 3 / 4], ['竖屏', 3 / 4], ['竖图', 3 / 4], ['3:4', 3 / 4],
  ['landscape', 4 / 3], ['wide', 4 / 3], ['横版', 4 / 3], ['横屏', 4 / 3], ['横图', 4 / 3], ['4:3', 4 / 3],
  ['16:9', 16 / 9], ['9:16', 9 / 16],
]);

/**
 * 宽松布尔：`'false'`/`'0'`/`'off'`/`'no'` 都当假，空值走 fallback。
 * @param {unknown} value
 * @param {boolean} [fallback]
 * @returns {boolean}
 */
function truthyFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return !['false', '0', 'off', 'no', 'none', 'null'].includes(raw);
}

/**
 * 把 `1024x1024` 这类像素规格解析成 `{ width, height }`。
 * 支持 `x`/`X`/`*`/`×` 分隔符与两侧空格；非法、零、负数一律返回 `null`。
 * @param {unknown} str
 * @returns {{width:number, height:number}|null}
 */
export function parseSize(str) {
  if (typeof str !== 'string' && typeof str !== 'number') return null;
  const m = SIZE_RE.exec(String(str));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 把请求里的尺寸说法解析成"基准长宽比 + 是否显式给了像素"。
 * @param {unknown} spec
 * @returns {{kind:'pixels'|'ratio'|'default', ratio:number, explicit:{width:number,height:number}|null}}
 */
function resolveSpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return { kind: 'default', ratio: 1, explicit: null };
  const px = parseSize(raw);
  if (px) return { kind: 'pixels', ratio: px.width / px.height, explicit: px };
  const key = raw.toLowerCase().replace(/\s+/g, '');
  if (KEYWORD_RATIOS.has(key)) return { kind: 'ratio', ratio: KEYWORD_RATIOS.get(key), explicit: null };
  const m = RATIO_RE.exec(raw);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return { kind: 'ratio', ratio: a / b, explicit: null };
  }
  // 看不懂的取值按 square，走默认分支。
  return { kind: 'default', ratio: 1, explicit: null };
}

/**
 * 把浮点边长贴到 `step` 的整数倍上（默认即"取偶数"），并保证至少 `step`。
 * @param {number} value
 * @param {number} step
 * @param {'round'|'floor'|'ceil'} mode
 * @returns {number}
 */
function snapTo(value, step, mode = 'round') {
  const n = Math.max(step, Number.isFinite(value) ? value : step);
  const q = mode === 'ceil' ? Math.ceil(n / step) : mode === 'floor' ? Math.floor(n / step) : Math.round(n / step);
  return Math.max(step, q * step);
}

/**
 * 归一化生图尺寸：保持长宽比、等比内缩到 `maxSize` 框内（单边与面积都不超）、
 * 按**面积**满足 `minSize`、宽高取偶数。
 *
 * 顺序：定基准 → 内缩到 maxSize 框内 → 抬到 minSize 面积以上 → 贴偶数 → 贴完后越界再校一次。
 * `minSize` 与 `maxSize` 冲突时 **minSize 优先**（宁可超预算，也不给上游一张尺寸不达标的图）。
 *
 * @param {string} spec `1024x1024` / `768x1024` / `square` / `方形` / `竖版` / `横版` / `16:9` / 空
 * @param {object} [opts]
 * @param {string} [opts.maxSize] 尺寸上限框，如 `1024x1024`；空字符串表示没有约束
 * @param {string} [opts.minSize] 面积下限，如 `1920x1920`；空字符串表示没有约束
 * @param {number} [opts.align] 边长对齐粒度，默认 2（偶数）
 * @returns {{width:number, height:number, basis:'ratio'|'clamped'|'min-area'|'default'}}
 *   `basis` 记录尺寸最终是怎么来的：`ratio` 只按比例推、`clamped` 被 maxSize 压过、
 *   `min-area` 被 minSize 抬过、`default` 是给不出规格时用的默认值。
 */
export function normalizeSize(spec, { maxSize = '', minSize = '', align = 2 } = {}) {
  const step = Math.max(1, Math.round(Number(align) || 2));
  const max = parseSize(maxSize);
  const min = parseSize(minSize);
  const minArea = min ? min.width * min.height : 0;

  const resolved = resolveSpec(spec);
  let width;
  let height;
  let basis;

  if (resolved.kind === 'pixels') {
    // 显式像素：就按它给的比例和大小起步，后面只做必要的压/抬。
    width = resolved.explicit.width;
    height = resolved.explicit.height;
    basis = 'ratio';
  } else if (resolved.kind === 'default') {
    // 空 spec / 看不懂：一个确定的默认值，再按 maxSize 压回去。
    width = DEFAULT_WIDTH;
    height = DEFAULT_HEIGHT;
    basis = 'default';
  } else {
    // 关键词/比例：在 maxSize 的框里按比例内缩（没给 maxSize 就用 1024x1024 当框）。
    const box = max || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    if (box.width / box.height > resolved.ratio) {
      height = box.height;
      width = height * resolved.ratio;
    } else {
      width = box.width;
      height = width / resolved.ratio;
    }
    basis = 'ratio';
  }

  if (max) {
    const scale = Math.min(1, max.width / width, max.height / height);
    if (scale < 1) {
      width *= scale;
      height *= scale;
      basis = 'clamped';
    }
  }

  if (minArea && width * height < minArea) {
    const scale = Math.sqrt(minArea / (width * height));
    width *= scale;
    height *= scale;
    basis = 'min-area';
  }

  width = snapTo(width, step, 'round');
  height = snapTo(height, step, 'round');

  // 贴偶数可能把边长顶出框，这里再校一次；但别把 minSize 又破坏掉。
  if (max) {
    const scale = Math.min(1, max.width / width, max.height / height);
    if (scale < 1) {
      const w2 = snapTo(width * scale, step, 'floor');
      const h2 = snapTo(height * scale, step, 'floor');
      if (!(minArea && w2 * h2 < minArea)) {
        width = w2;
        height = h2;
        if (basis !== 'min-area') basis = 'clamped';
      }
    }
  }

  if (minArea && width * height < minArea) {
    const scale = Math.sqrt(minArea / (width * height));
    width = snapTo(width * scale, step, 'ceil');
    height = snapTo(height * scale, step, 'ceil');
    basis = 'min-area';
  }

  return { width: Math.round(width), height: Math.round(height), basis };
}

/** 参考图/上游 b64 统一成 data URI。 */
function toDataUri(bytes, mediaType) {
  const type = String(mediaType ?? '').trim().toLowerCase() || DEFAULT_MEDIA_TYPE;
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** 剥掉可能的 `data:image/png;base64,` 前缀并解码；返回的 mediaType 可能为 null。 */
function decodeB64(raw) {
  const text = String(raw ?? '').trim();
  const m = DATA_URI_RE.exec(text);
  const mediaType = m && m[1] ? String(m[1]).toLowerCase() : null;
  const payload = (m ? text.slice(m[0].length) : text).replace(/\s+/g, '');
  return { mediaType, payload, bytes: Buffer.from(payload, 'base64') };
}

/** 只要 host（含端口），把协议、路径、查询串、userinfo 全部丢掉。 */
function hostOf(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.host) return u.host;
  } catch {
    // 不是完整 URL 时退化为手工剥离，别把疑似 token 的部分带出去。
  }
  const bare = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '');
  const host = bare.split(/[/?#]/)[0];
  return host || null;
}

/** 取响应头，兼容 Headers 实例与普通对象。 */
function headerOf(res, name) {
  const headers = res && res.headers;
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      return typeof value === 'string' ? value : null;
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** `image/jpeg; charset=utf-8` → `image/jpeg`。 */
function normalizeMediaType(value) {
  const raw = String(value ?? '').split(';')[0].trim().toLowerCase();
  return raw || DEFAULT_MEDIA_TYPE;
}

/**
 * OpenAI 兼容的生图客户端：给一句 prompt（可选一张参考图），拿回图片字节。
 *
 * 只承诺"尽力拿回字节"：任何失败都落在返回值的 `error` 里，**绝不抛异常**。
 */
export class ImageGen {
  #on;
  #injected = null;
  #stats;

  /**
   * @param {object} [opts]
   * @param {object} [opts.storage] 预留的存储句柄（本模块目前不用它落盘）
   * @param {(msg:string)=>void} [opts.log]
   * @param {boolean} [opts.enabled] 开关；还要 model/baseUrl/apiKey/fetch 齐全才算真能用
   * @param {string} [opts.model]
   * @param {string} [opts.baseUrl] 如 `https://api.example.com/v1`
   * @param {string} [opts.apiKey] 只进 `Authorization` 头，绝不进请求体
   * @param {string} [opts.maxSize] 尺寸上限框，空串表示没约束
   * @param {string} [opts.minSize] 面积下限，空串表示没约束
   * @param {boolean} [opts.watermark] 是否透传 watermark；**非 OpenAI 官方参数，默认不发**，显式 true 才带上（给支持它的中转接口用）
   * @param {number} [opts.timeoutMs] 单次请求超时，默认 120000
   * @param {Function} [opts.fetchImpl] 注入的 fetch，默认 `globalThis.fetch`
   * @param {()=>number} [opts.now] 计时函数，默认 `Date.now`（测试可注入）
   */
  constructor({
    storage = null,
    log = () => {},
    enabled = false,
    model = '',
    baseUrl = '',
    apiKey = '',
    maxSize = '1024x1024',
    minSize = '',
    watermark = false,
    timeoutMs = 120000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.log = typeof log === 'function' ? log : () => {};
    this.#on = truthyFlag(enabled, false);
    this.model = String(model ?? '').trim();
    this.baseUrl = String(baseUrl ?? '').trim();
    this.apiKey = String(apiKey ?? '');
    this.maxSize = String(maxSize ?? '');
    this.minSize = String(minSize ?? '');
    this.watermark = truthyFlag(watermark, false);
    const timeout = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 120000;
    this.fetchImpl = typeof fetchImpl === 'function'
      ? fetchImpl
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    this.now = typeof now === 'function' ? now : Date.now;
    this.#stats = { requests: 0, ok: 0, failed: 0, lastError: null, lastAt: null, lastSize: null };
  }

  /** 配置齐不齐（model + baseUrl + apiKey + 可用的 fetch），不看向量开关。 */
  get configured() {
    return Boolean(this.model && this.baseUrl && this.apiKey && this.#fetchOf());
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
      baseUrl: hostOf(this.baseUrl),
      requests: this.#stats.requests,
      ok: this.#stats.ok,
      failed: this.#stats.failed,
      lastError: this.#stats.lastError,
      lastAt: this.#stats.lastAt,
      lastSize: this.#stats.lastSize,
    };
  }

  /**
   * 注入宿主的 fetch（例如带代理/统计的包装）。
   * @param {{fetchImpl?: Function}} [opts]
   * @returns {boolean} 注入后是否可用
   */
  attach({ fetchImpl = null } = {}) {
    if (typeof fetchImpl === 'function') this.#injected = fetchImpl;
    return this.enabled;
  }

  /** 撤掉注入的 fetch，回落到构造函数给的那个。 */
  detach() {
    this.#injected = null;
    return this.enabled;
  }

  /**
   * 生成一张图。
   *
   * @param {object} [input]
   * @param {string} [input.prompt] 提示词
   * @param {string} [input.size] 尺寸说法，交给 {@link normalizeSize}
   * @param {{bytes:Buffer|Uint8Array, mediaType?:string}|null} [input.reference] 参考图**字节**；
   *   传了却给不出字节（例如只给了 URL / 路径字符串）会**明确失败**，不再静默退化成文生图
   * @returns {Promise<{ok:boolean, bytes:Buffer|null, mediaType:string|null, size:{width:number,height:number}|null, url:string|null, error:string|null}>}
   */
  async generate({ prompt = '', size = '', reference = null } = {}) {
    if (!this.enabled) {
      return this.#refusal('生图未启用或配置不完整（需要 enabled、model、baseUrl、apiKey 与可用的 fetch）');
    }
    const text = String(prompt ?? '').trim();
    if (!text) return this.#refusal('提示词为空');

    // 传了参考图就必须真的把它带上。老写法 `if (reference && reference.bytes)` 对字符串
    // 一律跳过 → 悄悄变成文生图，用户只会觉得"参考图没起作用"（真机事故：模型给了本地路径）。
    const refBytes = reference ? reference.bytes ?? null : null;
    if (reference && (!refBytes || !refBytes.length)) {
      const what = typeof reference === 'string'
        ? '字符串——要先把它（URL / 本地路径 / base64）读成字节'
        : '没有 bytes 的对象';
      return this.#refusal(`参考图要传字节（{bytes, mediaType}），拿到的是${what}`);
    }

    // 官方对 size 的规则：gpt-image-2 起任意宽高都要能被 16 整除（宽高比 1:3~3:1）。
    // 对齐到 16 对"只要偶数"的网关是安全的（16 的倍数必是偶数），对官方才是合法值。
    const picked = normalizeSize(size, { maxSize: this.maxSize, minSize: this.minSize, align: 16 });
    const chosen = { width: picked.width, height: picked.height };
    this.#stats.requests += 1;
    this.#stats.lastAt = this.now();
    this.#stats.lastSize = chosen;

    try {
      const body = {
        model: this.model,
        prompt: text,
        size: `${chosen.width}x${chosen.height}`,
        n: 1,
        response_format: 'b64_json',
      };
      // watermark 不在 OpenAI 官方参数面里（规范只有 model/prompt/n/size/quality/…）：
      // 严格实现会对未知参数报错，所以默认不发、显式配置了才透传。
      if (this.watermark) body.watermark = true;
      if (refBytes) {
        body.image = [toDataUri(refBytes, reference.mediaType)];
      }

      const res = await this.#request(this.#endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res || !res.ok) {
        const detail = await this.#snippet(res);
        throw new Error(`上游返回 HTTP ${res?.status ?? '未知'}${detail ? `：${detail}` : ''}`);
      }

      const { text: rawText, json } = await this.#readPayload(res);
      const item = json && Array.isArray(json.data) ? json.data[0] : null;
      if (!item || typeof item !== 'object') {
        const echo = this.#redact(rawText || safeStringify(json)).slice(0, SNIPPET_LIMIT);
        throw new Error(`上游没有返回 data[0]${echo ? `（返回内容前 ${echo.length} 字符：${echo}）` : ''}`);
      }

      if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
        const decoded = decodeB64(item.b64_json);
        if (!decoded.payload || !decoded.bytes.length) throw new Error('上游返回的 b64_json 为空或不是合法 base64');
        this.#stats.ok += 1;
        return {
          ok: true,
          bytes: decoded.bytes,
          mediaType: decoded.mediaType || DEFAULT_MEDIA_TYPE,
          size: chosen,
          url: null,
          error: null,
        };
      }

      if (typeof item.url === 'string' && item.url.trim()) {
        const imageUrl = item.url.trim();
        const imageRes = await this.#request(imageUrl, { method: 'GET', headers: { accept: 'image/*' } });
        if (!imageRes || !imageRes.ok) {
          throw new Error(`图片下载失败：上游返回 HTTP ${imageRes?.status ?? '未知'}`);
        }
        const raw = typeof imageRes.arrayBuffer === 'function' ? await imageRes.arrayBuffer() : null;
        const bytes = raw ? Buffer.from(raw) : Buffer.alloc(0);
        if (!bytes.length) throw new Error('图片下载回来是空的');
        this.#stats.ok += 1;
        return {
          ok: true,
          bytes,
          mediaType: normalizeMediaType(headerOf(imageRes, 'content-type') || item.media_type),
          size: chosen,
          url: imageUrl,
          error: null,
        };
      }

      throw new Error('上游 data[0] 里既没有 b64_json 也没有 url');
    } catch (err) {
      return this.#failure(chosen, err);
    }
  }

  /** 真正发请求的地方：AbortController + 超时竞速（上游不理会 abort 也不会把这里挂死）。 */
  async #request(url, init = {}) {
    const fetchImpl = this.#fetchOf();
    const controller = new AbortController();
    let timerId = null;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error(`生图请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
    });
    try {
      const pending = Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }));
      // 超时后上游的 reject 已经没人接了，先标记为已处理，免得冒 unhandledRejection。
      pending.catch(() => {});
      return await Promise.race([pending, timeout]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  #fetchOf() {
    const impl = this.#injected ?? this.fetchImpl;
    return typeof impl === 'function' ? impl : null;
  }

  #endpoint() {
    return `${this.baseUrl.replace(/\/+$/, '')}/images/generations`;
  }

  /** 尽量把响应读成文本 + JSON（两种读法都失败就给空）。 */
  async #readPayload(res) {
    let text = null;
    try {
      if (res && typeof res.text === 'function') text = await res.text();
    } catch {
      text = null;
    }
    if (text == null && res && typeof res.json === 'function') {
      try {
        text = JSON.stringify(await res.json());
      } catch {
        text = null;
      }
    }
    const raw = typeof text === 'string' ? text : '';
    let json = null;
    if (raw.trim()) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    return { text: raw, json };
  }

  /** 出错时捎上上游回显的前 200 字符，便于排查（已脱敏）。 */
  async #snippet(res) {
    try {
      const { text } = await this.#readPayload(res);
      return this.#redact(text).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LIMIT);
    } catch {
      return '';
    }
  }

  /** 密钥不能外泄：回显里要是带了 apiKey，先抹掉。 */
  #redact(text) {
    const raw = String(text ?? '');
    if (!this.apiKey) return raw;
    return raw.split(this.apiKey).join('***');
  }

  #refusal(reason) {
    return { ok: false, bytes: null, mediaType: null, size: null, url: null, error: reason };
  }

  #failure(size, err) {
    const message = this.#redact(String(err?.message ?? err) || '生图失败').slice(0, 600);
    this.#stats.failed += 1;
    this.#stats.lastError = message;
    this.log(`生图失败：${message}`);
    return { ok: false, bytes: null, mediaType: null, size, url: null, error: message };
  }
}

/** JSON.stringify 的安全版（循环引用/不可序列化时退回 String）。 */
function safeStringify(value) {
  if (value === undefined || value === null) return '';
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

export { SNIPPET_LIMIT, DEFAULT_MEDIA_TYPE };
