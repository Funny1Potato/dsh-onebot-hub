/**
 * 会话级模型选择（§26）：**聊天模型**与**识图模型**都能按会话切换。
 *
 * 为什么要有这一层：
 *  - 识图模型**不再是一个配置项**。看图（`vision.mode: describe`）本来就只是"拿一张图问一次模型"，
 *    用哪个模型属于**当前会话**的选择，写进 profile 就变成了"全部署只能有一个看图模型"——
 *    换一次要改配置、重挂插件，还得重启。现在的默认是**系统默认模型**（请求里不指定 provider/model，
 *    由宿主 `llm` 自己选），要换就在会话里用 `/vmodel` 换。
 *  - 聊天模型同理：`/model` 只改**本会话**（群/私聊各算一个会话）。实现上是把宿主
 *    `installModelSelection()` 认的那个**可变 selection 对象**改掉（宿主每轮 prompt 装配时读
 *    `selection.current`），所以是**立即生效**、并且宿主会自己追加一条"模型已变更"的会话通知。
 *  - 选择**落盘**（`sessions/models.json`），重启后各会话还是各自选的模型。
 *
 * 本模块不 import 任何宿主包，也不碰网络：模型清单由调用方（index.js 里的宿主通道）喂进来。
 */

/** 两类可选：聊天模型 / 识图模型。 */
export const MODEL_KINDS = ['chat', 'vision'];

/** 落盘文件（在 `JsonStore` 的目录下）。 */
export const SESSION_MODELS_FILE = 'sessions/models.json';

/** 这些词表示"清掉本会话的选择、回系统默认"。 */
const DEFAULT_WORDS = new Set(['default', 'auto', 'reset', '默认', '跟随默认', '清空', '系统默认']);

/** 清单太长时的保护：每个 provider 最多列这么多条，整段最多这么多字符。 */
export const MODEL_LIST_PER_PROVIDER = 12;
export const MODEL_LIST_MAX_CHARS = 700;

/**
 * 清洗一个 `{provider, model}`：两边都非空才算有效；`provider` 可省（沿用当前 provider）。
 * @param {unknown} value
 * @returns {{provider:string, model:string}|null} `provider` 为空字符串表示"沿用"
 */
export function normalizeModelRef(value) {
  if (!value || typeof value !== 'object') return null;
  const model = String(value.model ?? '').trim();
  if (!model) return null;
  const provider = String(value.provider ?? '').trim();
  return { provider, model };
}

/** 人话形式：`provider/model`（provider 缺省时只写模型名），空值写「（系统默认）」。 */
export function formatModelRef(ref) {
  const clean = normalizeModelRef(ref);
  if (!clean) return '（系统默认）';
  return clean.provider ? `${clean.provider}/${clean.model}` : clean.model;
}

/**
 * 解析一条命令参数。**不接受只写模型名**（会与"沿用 provider"混淆，用户明确只选了三种写法：
 * `provider/model`、编号、`default`）。
 *
 * @param {string} arg
 * @returns {{kind:'ref', provider:string, model:string} | {kind:'index', index:number}
 *          | {kind:'clear'} | {kind:'error', message:string}}
 */
export function parseModelArg(arg) {
  const raw = String(arg ?? '').trim();
  if (!raw) return { kind: 'error', message: '没有参数' };
  if (DEFAULT_WORDS.has(raw.toLowerCase())) return { kind: 'clear' };
  if (/^\d+$/.test(raw)) {
    const index = Number(raw);
    return index >= 1 ? { kind: 'index', index } : { kind: 'error', message: '编号从 1 开始' };
  }
  // provider 与 model 两边都不许再含 `/`：`a/b/c` 这种要么是打错了、要么是模型名里带斜杠，
  // 两种都不该被我们猜——直接报错，让人写清楚。
  const match = /^([^/\s]+)\s*\/\s*([^/\s]+)$/.exec(raw);
  if (match) return { kind: 'ref', provider: match[1], model: match[2] };
  return {
    kind: 'error',
    message: '写法认不出：要 `provider/model`（如 `volcengine/doubao-seedream-5-0-pro`）、编号（如 `3`）或 `default`',
  };
}

/** 把宿主的 `[{id,name,models:[{id,name}]}]` 摊平成带序号的清单（编号给命令用）。 */
export function flattenModels(providers) {
  const out = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = String(provider?.id ?? '').trim();
    if (!providerId) continue;
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      const modelId = String(model?.id ?? '').trim();
      if (!modelId) continue;
      out.push({
        index: out.length + 1,
        provider: providerId,
        providerName: String(provider?.name ?? providerId),
        model: modelId,
        name: String(model?.name ?? modelId),
      });
    }
  }
  return out;
}

/**
 * 把参数解析成"要设置成什么"：编号按**摊平后的清单**取（1 开始）。
 * @param {string} arg
 * @param {Array} providers 宿主给的模型清单
 * @returns {{kind:'ref'|'clear', ref?:object} | {kind:'error', message:string}}
 */
export function resolveModelArg(arg, providers) {
  const parsed = parseModelArg(arg);
  if (parsed.kind === 'clear') return { kind: 'clear' };
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message };
  if (parsed.kind === 'ref') return { kind: 'ref', ref: { provider: parsed.provider, model: parsed.model } };
  const flat = flattenModels(providers);
  const hit = flat.find((item) => item.index === parsed.index);
  if (!hit) return { kind: 'error', message: `清单里没有第 ${parsed.index} 个（共 ${flat.length} 个）` };
  return { kind: 'ref', ref: { provider: hit.provider, model: hit.model } };
}

/**
 * 渲染模型清单（`/model` 与 `/vmodel` 无参时回的那段）。
 *
 * 太长会被上游拒，所以每个 provider 只列前 `perProvider` 条并注明还有多少；整段再按 `maxChars`
 * 截断。当前在用的那个用 `→` 标出来（拿 `provider/model` 完整比对，避免同名不同 provider 误标）。
 *
 * `command`/`prefix` 由调用方给（命令前缀可配，见 `chat-commands.js` 的 `usageLine`）：
 * 这里只负责把它拼进提示语，**不假死任何一个前缀**——给不出就不写提示语里的命令。
 *
 * @param {{providers?:Array, current?:object|null, title?:string, perProvider?:number,
 *          maxChars?:number, command?:string, prefix?:string}} [opts]
 */
export function renderModelList({
  providers,
  current = null,
  title = '可选模型',
  perProvider = MODEL_LIST_PER_PROVIDER,
  maxChars = MODEL_LIST_MAX_CHARS,
  command = '',
  prefix = '',
} = {}) {
  const flat = flattenModels(providers);
  const currentLabel = formatModelRef(current);
  const lines = [`${title}（当前：${currentLabel}）：`];
  const full = command ? `${prefix}${command}` : '';
  if (!flat.length) {
    lines.push('· 宿主没给可用模型清单（`llm.listProviders()` 返回空），可以直接写 `provider/model`。');
  } else {
    const groups = new Map();
    for (const item of flat) {
      if (!groups.has(item.provider)) groups.set(item.provider, []);
      groups.get(item.provider).push(item);
    }
    for (const [provider, items] of groups) {
      lines.push(`【${items[0].providerName}】`);
      for (const item of items.slice(0, perProvider)) {
        const mark = current && current.provider === item.provider && current.model === item.model ? '→' : '·';
        const label = item.name && item.name !== item.model ? `${item.model}（${item.name}）` : item.model;
        lines.push(`${mark} ${item.index}. ${label}`);
      }
      if (items.length > perProvider) lines.push(`  …还有 ${items.length - perProvider} 个`);
    }
    lines.push(
      full
        ? `发编号就能切，例如 \`${full} 3\`；\`${full} default\` 回系统默认。`
        : '发编号就能切（编号见上），或直接写 `provider/model`；`default` 回系统默认。',
    );
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

/**
 * 会话级模型选择（聊天 / 识图），落盘在 `sessions/models.json`。
 *
 * 与 persona 那些模块一样：**只存选择**，不管调用；`index.js` 负责把它接到宿主的
 * `llm.stream`（识图）与 `installModelSelection`（聊天）上。
 */
export class SessionModels {
  #map = new Map();

  /**
   * @param {{storage?:object, log?:Function, now?:Function}} [opts]
   * @param {object} [opts.storage] `JsonStore`（`read`/`write`）
   */
  constructor({ storage = null, log = () => {}, now = Date.now } = {}) {
    this.storage = storage;
    this.log = log;
    this.now = now;
    this.#load();
  }

  #load() {
    const data = this.storage?.read?.(SESSION_MODELS_FILE, null);
    const sessions = data && typeof data === 'object' ? data.sessions : null;
    if (!sessions || typeof sessions !== 'object') return;
    for (const [key, rec] of Object.entries(sessions)) {
      const row = {
        chat: normalizeModelRef(rec?.chat),
        vision: normalizeModelRef(rec?.vision),
        at: Number(rec?.at) || 0,
      };
      if (row.chat || row.vision) this.#map.set(String(key), row);
    }
  }

  /** 立刻原子落盘：命令是**人**发的，用户敲完就该存住，不像缓存那样可以等防抖。 */
  #persist() {
    if (!this.storage?.write) return false;
    return this.storage.write(SESSION_MODELS_FILE, {
      version: 1,
      savedAt: this.now(),
      sessions: Object.fromEntries(this.#map.entries()),
    });
  }

  /** 某个会话的两类选择（没有就是 `null` = 系统默认）。 */
  get(sessionKey) {
    const row = this.#map.get(String(sessionKey ?? ''));
    return { chat: row?.chat ? { ...row.chat } : null, vision: row?.vision ? { ...row.vision } : null, at: row?.at ?? 0 };
  }

  chatFor(sessionKey) {
    return this.get(sessionKey).chat;
  }

  visionFor(sessionKey) {
    return this.get(sessionKey).vision;
  }

  /**
   * 写入一类选择；`ref` 传 `null` 表示"清掉、回系统默认"。
   * @param {string} sessionKey
   * @param {'chat'|'vision'} kind
   * @param {{provider?:string, model?:string}|null} ref
   */
  set(sessionKey, kind, ref) {
    const key = String(sessionKey ?? '').trim();
    if (!key) throw new Error('会话键为空');
    if (!MODEL_KINDS.includes(kind)) throw new Error(`未知的模型类型：${kind}（只能是 ${MODEL_KINDS.join(' / ')}）`);
    const row = this.#map.get(key) ?? { chat: null, vision: null, at: 0 };
    row[kind] = normalizeModelRef(ref);
    row.at = this.now();
    if (!row.chat && !row.vision) this.#map.delete(key);
    else this.#map.set(key, row);
    this.#persist();
    return this.get(key);
  }

  clear(sessionKey) {
    const key = String(sessionKey ?? '');
    const had = this.#map.delete(key);
    if (had) this.#persist();
    return had;
  }

  list() {
    return [...this.#map.entries()].map(([sessionKey, row]) => ({
      sessionKey,
      chat: row.chat ? { ...row.chat } : null,
      vision: row.vision ? { ...row.vision } : null,
      at: row.at,
    }));
  }

  get stats() {
    const rows = [...this.#map.values()];
    return {
      sessions: rows.length,
      chat: rows.filter((row) => row.chat).length,
      vision: rows.filter((row) => row.vision).length,
      file: this.storage?.path?.(SESSION_MODELS_FILE) ?? null,
      savedAt: this.storage?.read?.(SESSION_MODELS_FILE, null)?.savedAt ?? null,
    };
  }
}
