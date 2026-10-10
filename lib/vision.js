// 看图（M14-V，§23.6 / §22.6）。
//
// 上游发来的图片有两种处理手段，由 `vision.mode` 选（两种都做，不互斥）：
//
//   · `describe`：让一个**支持图片输入的模型**用 `ctx.llm.stream()` 看一次图，拿回一段中文描述，
//     按 **sha256 缓存**，再把描述**拼进 L1 文本**（`[图片：一个人举着猫]`）。这样任何模型——
//     包括看不见图的——都能从文本里读到"这张图里有什么"。
//     用哪个模型：**默认系统默认模型**（请求里不指定 provider/model），要换用会话级覆盖
//     （`/vmodel`，见 `lib/models.js`）；`vision.provider`/`vision.model` 这两个配置项已经删掉了，
//     因为"全部署只能有一个看图模型"这件事本身就不该是一个配置项。
//   · `segment`：把图片本体作为 `{type:'image', attachment}` 内容段直接塞给会话代理，
//     让看得见的模型自己看。前提是它的 `inputModalities` 含 `'image'`（宿主客户端对不含
//     图片能力的模型会直接抛 `does not support image input`），所以要先 `imageCapable()` 探一下。
//
// 两条自律：
//   · **不猜**。模型没看到、看不清的，就让它说看不清（prompt 里写死）。描述失败时留占位，
//     不编内容。
//   · **同一张图只花一次钱**。缓存键是字节的 sha256（master 用的是 md5，同理），跨重启有效。
//
// 本模块不 import 任何宿主包（可离线测）：`llm`/`attachments` 都由外部 `attach()` 注入。

import crypto from 'node:crypto';
import { basenameOf } from './media.js';

/** 处理手段：off 不看图 / segment 交给会话代理 / describe 自己看后写进文本 / both 两者都做。 */
export const VISION_MODES = ['off', 'segment', 'describe', 'both'];

export const DEFAULT_DESCRIBE_PROMPT =
  '用中文简短描述这张图片的内容。如果图中有人物，只描述外貌特征，不要识别角色。若有文字请描述。看不清的地方就说看不清，不要猜。';

/**
 * 结构化输出格式（附在用户自定义 prompt 之后，不进配置）：首行给表情包判定，
 * 第二行给二次元判定（三道门 ①：是二次元才问角色识别，`m30282`），是表情包才要情绪词，
 * 之后才是内容——渲染侧靠这几段拼 `[可能是表情包｜情感：…｜内容：…]`。
 */
export const DESCRIBE_OUTPUT_FORMAT =
  '按下面的格式回答（用换行分几部分）：\n'
  + '第一行：这张图是不是表情包——是就写“表情包”，不是就写“图片”，只有这两个词。\n'
  + '第二行：这张图是不是二次元画风（动漫、漫画、游戏立绘等，二次元表情包也算）——写“二次元：是”或“二次元：否”；真实照片、屏幕截图、软件界面、纯文字图都算“否”。\n'
  + '第三行：只在第一行是“表情包”时写——3个描述情绪的词，用顿号分隔，如：开心、得意、搞笑；第一行是“图片”就不要写这一行。\n'
  + '之后：图片内容描述。';

/** 协议先验（`sub_type==1`）并进主描述请求——发送端说它是表情包，模型判断时以这个为强信号。 */
export const DESCRIBE_MEME_HINT = '发送端已把这张图标记为表情包（sub_type=1），判断时以表情包对待。';

/**
 * 解析看图回复的三段结构。
 *
 * 解析不出来（模型没按格式回）→ `meme:null`、整段当内容**原样返回**，绝不猜；
 * 判定结果（`true`/`false`/`null`）都会进缓存，`null` 表示"问过但没按格式答"，
 * 不会在下次反复重问（惰性重判只针对**缺 `meme`/`anime` 字段**的旧条目）。
 *
 * @param {string} raw 模型回复原文
 * @returns {{meme: boolean|null, emotion: string|null, anime: boolean|null, text: string}|null} 空回复给 null
 */
export function parseDescribeReply(raw) {
  const text = String(raw ?? '').replace(/\r/g, '').trim();
  if (!text) return null;
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const head = lines[0] ?? '';
  const bare = /^(表情包|图片)\s*[：:.。!！?？]*$/.exec(head);
  const inline = bare ? null : /^(表情包|图片)\s*[：:]\s*(.+)$/.exec(head);
  if (!bare && !inline) return { meme: null, emotion: null, anime: null, text };
  const meme = (bare ? bare[1] : inline[1]) === '表情包';
  const rest = bare ? lines.slice(1) : [inline[2], ...lines.slice(1)].filter(Boolean);
  // 二次元判定行（三道门 ①）：`二次元：是` / `二次元：否`；后面跟的括号说明不碍事。
  // 没有这一行 → null（"没按格式答"），上层宁可多问一次角色识别也不漏判。
  let anime = null;
  const animeAt = rest.findIndex((l) => /^二次元\s*[：:]\s*(是|否)/.test(l));
  if (animeAt >= 0) {
    anime = /^二次元\s*[：:]\s*是/.test(rest[animeAt]);
    rest.splice(animeAt, 1);
  }
  let emotion = null;
  if (meme && rest.length) {
    // 情绪词那一行：2~4 个顿号分隔的短词、不带句读——像句子的内容行不会被误吞。
    if (/^[^，。！？、\s]{1,12}(、[^，。！？、\s]{1,12}){1,3}$/.test(rest[0])) {
      emotion = rest[0];
      rest.shift();
    }
  }
  return { meme, emotion, anime, text: rest.join(' ').trim() };
}

export const DEFAULT_VISION_SYSTEM = '你在替一个看不见图片的聊天机器人看图。只写你确实看见的东西，别脑补、别评价、别客套。';

/** 0 = **不传** `maxTokens`（交给上游按模型自己的默认跑）——描述不做长度控制（`m24155`）。 */
export const DEFAULT_MAX_TOKENS = 0;
export const DEFAULT_CACHE_LIMIT = 500;
export const DEFAULT_TIMEOUT_MS = 30000;
export const VISION_CACHE_FILE = 'vision/cache.json';

/** 宽松归一：`true`/`on` 当作 `describe`，认不出的取值退回 fallback。 */
export function normalizeVisionMode(value, fallback = 'describe') {
  if (value === true) return 'describe';
  if (value === false) return 'off';
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'on' || raw === 'true' || raw === 'yes') return 'describe';
  if (raw === 'no' || raw === 'false') return 'off';
  return VISION_MODES.includes(raw) ? raw : fallback;
}

export function sha256Of(bytes) {
  if (!bytes) return null;
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

export class Vision {
  /**
   * @param {object} [opts]
   * @param {object} [opts.storage] JsonStore（缓存落在它下面）
   * @param {(msg:string)=>void} [opts.log]
   * @param {string} [opts.mode] `VISION_MODES` 之一
   * @param {string} [opts.provider] 看图用的 provider（默认空 = **系统默认模型**；一般只给测试用）
   * @param {string} [opts.model] 看图用的 model（同上；线上按会话走 `describeImage` 的 `override`）
   * @param {string} [opts.prompt] 描述用的提示词
   * @param {string} [opts.system] 描述用的 system
   * @param {number} [opts.maxTokens] 0/不填 = 不传该参数（上游按模型默认生成，不做长度控制）
   * @param {string} [opts.reasoningEffort] 思考强度档位（m024193）：**空 = 不传**，
   *   交给模型自己的默认；非空才带 `reasoningEffort` 进请求（档位由模型自己定义，hub 不解释）。
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.cacheLimit]
   * @param {Function} [opts.now]
   */
  constructor({
    storage = null,
    log = () => {},
    mode = 'describe',
    provider = '',
    model = '',
    prompt = DEFAULT_DESCRIBE_PROMPT,
    system = DEFAULT_VISION_SYSTEM,
    maxTokens = DEFAULT_MAX_TOKENS,
    reasoningEffort = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheLimit = DEFAULT_CACHE_LIMIT,
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.log = log;
    this.mode = normalizeVisionMode(mode, 'describe');
    this.provider = String(provider ?? '');
    this.model = String(model ?? '');
    this.reasoningEffort = String(reasoningEffort ?? '').trim();
    this.prompt = String(prompt ?? '').trim() || DEFAULT_DESCRIBE_PROMPT;
    this.system = String(system ?? '').trim() || DEFAULT_VISION_SYSTEM;
    // 0 = 不传（`m24257`：长度不该由 hub 控制，reasoning 怎么计数各家还不一样）。
    const mt = Number(maxTokens);
    this.maxTokens = Number.isFinite(mt) && mt > 0 ? Math.floor(mt) : 0;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.cacheLimit = Math.max(1, Number(cacheLimit) || DEFAULT_CACHE_LIMIT);
    this.now = now;
    this.llm = null;
    this.attachments = null;
    this.#capable = new Map();
    this.#stats = {
      described: 0, cached: 0, failed: 0, skipped: 0, parts: 0, lastError: null, lastAt: null, lastText: null,
      // 失败构成（错误文本 → 次数）：lastError 只留最后一条，分布才能看出"是空回多还是超时多"。
      errorCounts: {},
    };
    this.#load();
  }

  #cache = new Map();
  #stats;
  #capable;

  get describeEnabled() {
    return this.mode === 'describe' || this.mode === 'both';
  }

  get segmentEnabled() {
    return this.mode === 'segment' || this.mode === 'both';
  }

  /** describe 手段此刻能不能跑：要 llm，也要 attachments（图片得先变成 durable ref 才能进消息）。 */
  get enabled() {
    return this.mode !== 'off' && Boolean(this.llm);
  }

  get stats() {
    return {
      mode: this.mode,
      enabled: this.mode !== 'off' && Boolean(this.llm),
      describe: this.describeEnabled,
      segment: this.segmentEnabled,
      llm: Boolean(this.llm),
      attachments: Boolean(this.attachments),
      provider: this.provider || null,
      model: this.model || null,
      cache: this.#cache.size,
      cacheFile: this.storage?.enabled ? VISION_CACHE_FILE : null,
      ...this.#stats,
    };
  }

  /** 注入宿主能力：`llm`（`ctx.get('llm')`）与 `attachments`（`ctx.get('attachments')`）。 */
  attach({ llm = null, attachments = null, provider, model } = {}) {
    // 换了 llm 服务（或换了路由）就得重新探"能不能收图"——旧结论是另一个模型留下的。
    if (llm) {
      this.llm = llm;
      this.#capable.clear();
    }
    if (attachments) this.attachments = attachments;
    const routeChanged = provider !== undefined && provider !== null && provider !== '' && String(provider) !== this.provider;
    const modelChanged = model !== undefined && model !== null && model !== '' && String(model) !== this.model;
    if (routeChanged) this.provider = String(provider);
    if (modelChanged) this.model = String(model);
    // 换了 llm 服务或换了模型，旧结论就是另一个模型留下的，得重新探。
    if (routeChanged || modelChanged) this.#capable.clear();
    return this.enabled;
  }

  detach() {
    this.llm = null;
    this.attachments = null;
  }

  /**
   * 这个模型能不能收图片（宿主 `llm.resolveModelInfo` 的 `inputModalities`）。探不到就当不能。
   * @returns {Promise<boolean>}
   */
  async imageCapable(provider = this.provider, model = this.model) {
    const key = `${provider || ''}/${model || ''}`;
    if (this.#capable.has(key)) return this.#capable.get(key);
    let ok = false;
    try {
      const info = await this.llm?.resolveModelInfo?.(provider || undefined, model || undefined);
      ok = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
      if (!ok && info?.inputModalities && !info.inputModalities.length) ok = false;
    } catch (err) {
      this.#stats.lastError = `看图能力探测失败：${err?.message ?? err}`;
      ok = false;
    }
    this.#capable.set(key, ok);
    return ok;
  }

  /**
   * 把图片交给支持图片输入的模型看一次，拿回表情包判定 + 中文描述（按 sha256 缓存）。
   *
   * 回复按 `DESCRIBE_OUTPUT_FORMAT` 三段解析：判定（表情包/图片）→ 情绪词（仅表情包）→ 内容。
   * 解析不出来就 `meme:null`、整段当内容。缓存条目带 `meme` 字段；**旧条目缺该字段时
   * 下次遇到这张图会重新请求一次补判**（惰性重判），判不了（没 llm / vision 关着）则先回旧文字。
   *
   * @param {object} input
   * @param {Buffer|Uint8Array} [input.bytes]
   * @param {string} [input.mediaType] `image/png` 等
   * @param {string} [input.name]
   * @param {string} [input.sha256] 已有摘要就直接用（省一次哈希）
   * @param {object} [input.attachment] 已有的 `ImageAttachmentRef`
   * @param {boolean} [input.memeHint] 协议先验：`sub_type==1`（发送端标了表情包）并进主描述请求
   * @returns {Promise<{text:string|null, meme:boolean|null, emotion:string|null, anime:boolean|null, cached:boolean, error:string|null}>}
   */
  async describeImage({
    bytes = null,
    mediaType = null,
    name = null,
    sha256 = null,
    attachment = null,
    override = null,
    memeHint = false,
  } = {}) {
    const hash = sha256 ?? sha256Of(bytes);
    const hit = hash ? this.#cache.get(hash) : null;
    // 惰性重判：缺 `meme` **或** `anime` 字段的旧条目重问一次（三道门 ①需要二次元判定）。
    const judged = hit && hit.meme !== undefined && hit.anime !== undefined;
    if (judged) {
      this.#stats.cached += 1;
      return { text: hit.text, meme: hit.meme ?? null, emotion: hit.emotion ?? null, anime: hit.anime ?? null, cached: true, error: null };
    }
    const canJudge = Boolean(this.llm) && this.describeEnabled;
    if (hit?.text && !canJudge) {
      // 旧条目缺判定字段，但现在判不了（没 llm / vision 关着）：先用旧文字顶上，别把描述弄丢。
      this.#stats.cached += 1;
      return { text: hit.text, meme: null, emotion: null, anime: null, cached: true, error: null };
    }
    if (!this.llm) {
      this.#stats.skipped += 1;
      return { text: null, meme: null, emotion: null, anime: null, cached: false, error: 'llm 未接入' };
    }
    if (!this.describeEnabled) {
      this.#stats.skipped += 1;
      return { text: null, meme: null, emotion: null, anime: null, cached: false, error: `vision.mode=${this.mode}` };
    }
    /**
     * 会话级覆盖（`/vmodel`）：`override` 为空就用构造时给的（现在恒为空，即**系统默认模型**）。
     * 缓存键**只按图片 sha256**——用户明确选了"切模型也不重看"，同一张图换模型仍吃旧描述。
     */
    const provider = String(override?.provider ?? this.provider ?? '');
    const model = String(override?.model ?? this.model ?? '');
    let ref = attachment;
    if (!ref) {
      if (!bytes) {
        this.#stats.skipped += 1;
        return { text: null, meme: null, emotion: null, cached: false, error: '没有图片字节' };
      }
      try {
        ref = await this.#saveImage(bytes, mediaType, name);
      } catch (err) {
        this.#stats.failed += 1;
        this.#stats.lastError = `图片登记失败：${err?.message ?? err}`;
        this.#countError(this.#stats.lastError);
        return { text: null, meme: null, emotion: null, anime: null, cached: false, error: this.#stats.lastError };
      }
    }
    if (!ref?.attachmentId) {
      this.#stats.skipped += 1;
      return { text: null, meme: null, emotion: null, anime: null, cached: false, error: '没有 durable 图片引用（宿主 attachments 未接入？）' };
    }
    const prompt = [this.prompt, memeHint ? DESCRIBE_MEME_HINT : null, DESCRIBE_OUTPUT_FORMAT]
      .filter(Boolean)
      .join('\n\n');
    const content = [
      { type: 'text', text: prompt },
      { type: 'image', attachment: ref },
    ];
    // 空回复重试一次：便宜档多模态模型（实测 mimo-v2.6-flash，failed 77 / described 21）对图片
    // 经常"跑完了但一个字都不回"，同样的请求再问一次往往就答了。只对空回重试——超时/网络错误
    // 重试会把最坏延迟翻倍，交给调用方的失败日志与图片补描兜底。
    const attempts = 2;
    let parsed = null;
    let streamError = null;
    for (let attempt = 1; attempt <= attempts && !parsed; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
      try {
        const stream = this.llm.stream({
          provider,
          model,
          system: this.system,
          messages: [{ role: 'user', content }],
          // 0 = 不传该参数：交给上游按模型自己的默认生成（m24155——不给描述加长度闸）。
          ...(this.maxTokens > 0 ? { maxTokens: this.maxTokens } : {}),
          // 思考强度（m024193）：空 = 不传，走模型默认档位。
          ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
          signal: controller.signal,
        });
        let text = '';
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += String(chunk.text ?? '');
        }
        parsed = parseDescribeReply(text);
        if (!parsed && attempt < attempts) {
          this.log?.(`看图空回复，再试一次：${basenameOf(name) ?? basenameOf(ref?.name) ?? hash?.slice(0, 8) ?? '图片'}`);
        }
      } catch (err) {
        streamError = err;
        break; // 请求本身炸了（超时/网络）：不重试，直接走失败分支。
      } finally {
        clearTimeout(timer);
      }
    }
    if (!parsed) {
      this.#stats.failed += 1;
      this.#stats.lastAt = this.now();
      if (streamError) {
        this.#stats.lastError = `${streamError?.name === 'AbortError' ? '看图超时' : '看图失败'}：${streamError?.message ?? streamError}`;
        this.#countError(this.#stats.lastError);
        return { text: null, meme: null, emotion: null, anime: null, cached: false, error: this.#stats.lastError };
      }
      this.#stats.lastError = '视觉模型没有回任何文字';
      this.#countError(this.#stats.lastError);
      return { text: null, meme: null, emotion: null, anime: null, cached: false, error: this.#stats.lastError };
    }
    // 判定要进缓存（哪怕内容为空）：`meme:null`/`anime:null` 表示"问过但没按格式答"，不再反复重问。
    // 描述不做字数截断（m24155：不希望再看到任何因为字数被截断的事情）。
    const out = String(parsed.text ?? '').trim();
    this.remember(hash, {
      text: out,
      meme: parsed.meme,
      emotion: parsed.emotion,
      anime: parsed.anime,
      mediaType: mediaType ?? ref.mediaType ?? null,
      // name 只留短文件名：`file` 段有时是整份 `base64://…`（实测 165725 字符），
      // 原样存进缓存会把 cache.json 顶成 2.4MB，而且每次 remember 都要全量重写一遍（m26571）。
      name: basenameOf(name) ?? basenameOf(ref?.name) ?? null,
    });
    this.#stats.described += 1;
    this.#stats.lastAt = this.now();
    this.#stats.lastText = out;
    return { text: out, meme: parsed.meme, emotion: parsed.emotion, anime: parsed.anime, cached: false, error: null };
  }

  /**
   * 失败构成计数：错误全文做键（可能带上游消息，每条都不同），超过 16 个键后丢最冷的。
   * 只增不减——stats.errorCounts 是给 onebot_hub_status 看的分布，不是审计账本。
   * @param {string} message
   */
  #countError(message) {
    const key = String(message ?? '').slice(0, 200) || '未知错误';
    const counts = this.#stats.errorCounts;
    counts[key] = (counts[key] ?? 0) + 1;
    const keys = Object.keys(counts);
    if (keys.length <= 16) return;
    let coldest = keys[0];
    for (const k of keys) if (counts[k] < counts[coldest]) coldest = k;
    delete counts[coldest];
  }

  /**
   * segment 手段：从落地过的媒体引用里挑出图片，做成 `{type:'image', attachment}` 内容段。
   * 同步、不发请求——图片在 `MediaStore` 落地时已经登记过 durable ref 了。
   *
   * @param {Iterable<object>|Map<any,object>} refs
   * @returns {Array<{type:'image', attachment:object}>}
   */
  segmentParts(refs) {
    if (!this.segmentEnabled) return [];
    const list = refs instanceof Map ? [...refs.values()] : Array.isArray(refs) ? refs : refs ? [...refs] : [];
    const out = [];
    const seen = new Set();
    for (const ref of list) {
      if (!ref || ref.kind !== 'image') continue;
      const attachment = ref.attachment ?? null;
      const id = attachment?.attachmentId ?? ref.attachmentId ?? null;
      if (!id || seen.has(String(id))) continue;
      seen.add(String(id));
      out.push({
        type: 'image',
        attachment: attachment ?? {
          attachmentId: id,
          mediaType: ref.mediaType ?? 'image/png',
          bytes: ref.bytes ?? null,
          width: ref.width ?? null,
          height: ref.height ?? null,
          name: ref.name ?? undefined,
        },
      });
    }
    if (out.length) this.#stats.parts += out.length;
    return out;
  }

  /** 缓存写回（跨重启复用；失败只记日志）。`meme` 判定即使内容为空也一起存。 */
  remember(hash, entry) {
    if (!hash || !entry) return false;
    if (!entry.text && entry.meme === undefined) return false;
    this.#cache.set(String(hash), { ...entry, at: this.now() });
    while (this.#cache.size > this.cacheLimit) {
      // 最旧的先丢（Map 保插入序，够用了）
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    this.#persist();
    return true;
  }

  cacheOf(hash) {
    return hash ? this.#cache.get(String(hash)) ?? null : null;
  }

  snapshot() {
    return [...this.#cache.entries()].map(([hash, entry]) => ({ hash, ...entry }));
  }

  async #saveImage(bytes, mediaType, name) {
    const save = this.attachments?.saveImage;
    if (typeof save !== 'function') throw new Error('宿主 attachments 不可用');
    return await save.call(this.attachments, {
      data: Buffer.from(bytes),
      mediaType: mediaType ?? 'image/png',
      name: name ?? undefined,
    });
  }

  #load() {
    try {
      const data = this.storage?.read?.(VISION_CACHE_FILE, null);
      const entries = data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : null;
      if (!entries) return;
      let n = 0;
      let dirty = false;
      for (const [hash, entry] of Object.entries(entries)) {
        if (!entry || typeof entry.text !== 'string') continue;
        if (!entry.text && entry.meme === undefined) continue;
        // 旧条目里的 name 可能整份是 base64 data URI（m26571）：只留短名，描述本身不动。
        const shortName = basenameOf(entry.name) ?? null;
        if (entry.name !== shortName) dirty = true;
        const row = {
          text: entry.text,
          mediaType: entry.mediaType ?? null,
          name: shortName,
          at: Number(entry.at) || 0,
        };
        // 旧条目没有 meme/anime 字段就**不补**——留着触发惰性重判（下次遇到这张图补问一次）。
        if (entry.meme !== undefined) {
          row.meme = entry.meme;
          row.emotion = entry.emotion ?? null;
        }
        if (entry.anime !== undefined) row.anime = entry.anime;
        this.#cache.set(String(hash), row);
        n += 1;
      }
      if (n) this.log(`看图缓存载入 ${n} 条（同一张图不再问第二次）`);
      // 清洗过（老条目 name 里是 base64）就立刻重写一次，别让胖文件一直躺在盘上（m26571）。
      if (dirty) {
        this.#persist();
        this.log('看图缓存已清洗：旧条目 name 里的内联数据已换成短名');
      }
    } catch (err) {
      this.log(`看图缓存载入失败（忽略）：${err?.message ?? err}`);
    }
  }

  #persist() {
    if (!this.storage?.schedule) return;
    try {
      this.storage.schedule(VISION_CACHE_FILE, () => ({
        version: 1,
        savedAt: this.now(),
        entries: Object.fromEntries(this.#cache),
      }));
    } catch (err) {
      this.log(`看图缓存排队失败（忽略）：${err?.message ?? err}`);
    }
  }
}
