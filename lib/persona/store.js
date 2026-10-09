/**
 * 人设 / 预设库（对齐 NoneBot 版的 persona 语义）。
 *
 * 三个问题决定了这里为什么长这样：
 *
 * 1. **绑定为什么必须落盘。** 预设是全局一份的"我可能是谁"，绑定是"这个会话里的我是谁"。
 *    只放在内存里的绑定，进程一重启就全部回落到默认——用户刚在某个群调好的人设没有任何
 *    提示地消失，而模型自己并不知道发生过这件事（它只会照着 prompt 说话）。绑定是用户
 *    显式做出的决定，属于"丢一次就要用户重说一遍"的那类数据，所以和预设一起落盘
 *    （`persona/presets.json` + `persona/bindings.json`）。
 *
 * 2. **为什么 default 不允许删。** `resolve()` 是所有会话的兜底：任何没绑定、绑定失效、
 *    或会话键形状奇怪的会话，最终都靠 default 拿到一份人设。删掉 default 不是"少一个
 *    预设"，而是"所有人设一起消失"——`render()` 会返回空串，prompt 里整段人设凭空不见。
 *    所以 default 是结构性兜底：`remove()` 对它直接返回 false，而不是悄悄删掉再补一个。
 *
 * 3. **为什么会话级 setRole 必须隔离。** 一个预设可能被很多会话绑定，默认预设更是几乎
 *    所有会话都在用。如果 `setRole('group:1', …)` 直接改写"当前绑定的那个预设"，改一个群
 *    的人设就会同时改掉所有共用它的群——用户说的是"这个群里你这样说话"，实际效果却是全局
 *    行为变更，而且没有撤销入口。因此 setRole 走**会话私有分叉**：把当前生效的预设复制成
 *    一份只被该会话绑定的私有副本（键名带 `@session/` 前缀，不出现在 `list()` 里），字段
 *    覆盖只落在这个副本上；其他会话看到的仍然是原来的预设。
 *
 * 存储格式（`storage.js` 的 JsonStore；`dir === ''` 时全部退化为内存态，写操作静默 no-op）：
 *   persona/presets.json  { version: 1, presets: { [key]: preset }, order: [key, …] }
 *   persona/bindings.json { version: 1, bindings: { [sessionKey]: key } }
 * 普通预设的 `key` 就是 `preset.name`；会话私有副本的 `key` 是 `@session/<sessionKey>`，
 * 这个前缀是保留的，不要拿它当预设名。
 *
 * 写操作全部走 `storage.schedule()`（惰性合并写），随时可以 `flush()` 强制落盘。
 * schema 层面的脏数据一律丢弃并记日志：库是聊天链路上的一环，不能因为一个坏条目整份崩掉。
 * 全程不读环境变量、不用随机数、不联网。
 */

/** 落盘文件版本号（以后改结构时用它区分）。 */
const PRESET_FILE_VERSION = 1;
/** 每个预设的知识条数上限，纯粹是防跑飞，不是产品判断。 */
const MAX_KNOWLEDGES = 50;
/** 会话私有预设的键名前缀（保留字）。 */
const SESSION_KEY_PREFIX = '@session/';

/** 默认预设名：所有兜底路径最后都落到它身上。 */
export const DEFAULT_PRESET_NAME = 'default';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isForkKey = (key) => String(key ?? '').startsWith(SESSION_KEY_PREFIX);
const forkKeyOf = (sessionKey) => `${SESSION_KEY_PREFIX}${String(sessionKey ?? '')}`;

/** 只留规范化后的四个字段，避免持久化的东西悄悄变胖。 */
const clonePreset = (preset) => ({
  name: preset.name,
  role: preset.role,
  knowledges: [...preset.knowledges],
  hidden: preset.hidden === true,
});

/**
 * 默认预设。角色名取 `DEFAULT_PRESET_NAME`（而不是另起一个中文名），这样 `resolve()` 的
 * 兜底结果可以直接和常量比较，测试与上层判断都不用再记一个魔法字符串。
 *
 * @returns {{name:string, role:string, knowledges:string[], hidden:boolean}}
 */
export function makeDefaultPreset() {
  return {
    name: DEFAULT_PRESET_NAME,
    role: '一个友好的群聊助手，会用轻松的语气和大家聊天',
    knowledges: [],
    hidden: false,
  };
}

/**
 * 规范化一条预设：只保留 `{ name, role, knowledges, hidden }`，其余字段丢弃。
 *
 * - `name`：非空字符串（trim 后）；否则退回 `fallbackName`（载入时就是它在文件里的键，
 *   这样"名字丢了"不会变成一条无名预设）。
 * - `role`：字符串（trim）。非字符串一律当空串。
 * - `knowledges`：只留非空字符串，trim 后去重、保持出现顺序、上限 50 条。
 * - `hidden`：**只认严格的 `true`**——'yes' / 1 / undefined 都是"不隐藏"，免得脏数据把
 *   预设藏起来让人找不到。
 *
 * @param {unknown} raw 任何形状的原始数据（坏数据返回一条空预设，不抛）
 * @param {string} [fallbackName] `name` 缺失时用的名字
 * @returns {{name:string, role:string, knowledges:string[], hidden:boolean}}
 */
export function normalizePreset(raw, fallbackName = DEFAULT_PRESET_NAME) {
  const src = isPlainObject(raw) ? raw : {};
  const rawName = typeof src.name === 'string' ? src.name.trim() : '';
  const name = rawName || String(fallbackName ?? '').trim();
  const role = typeof src.role === 'string' ? src.role.trim() : '';

  const knowledges = [];
  const seen = new Set();
  const list = Array.isArray(src.knowledges) ? src.knowledges : [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    knowledges.push(value);
    if (knowledges.length >= MAX_KNOWLEDGES) break;
  }

  return { name, role, knowledges, hidden: src.hidden === true };
}

/**
 * 预设库。构造后需要显式 `load()`（构造器不自动读盘，测试与离线工具都能拿到可预测的空态）。
 */
export class PersonaStore {
  /** @type {Map<string, {name:string, role:string, knowledges:string[], hidden:boolean}>} */
  #presets = new Map();
  /** @type {Map<string, string>} sessionKey → preset key */
  #bindings = new Map();
  /** @type {string[]} 预设键顺序（`list()` 的排序依据，default 永远在最前） */
  #order = [];

  /**
   * @param {{storage?:{schedule?:Function, read?:Function, flush?:Function, enabled?:boolean}|null, log?:Function, defaultName?:string}} [opts]
   */
  constructor({ storage = null, log = () => {}, defaultName = DEFAULT_PRESET_NAME } = {}) {
    this.storage = storage;
    this.log = typeof log === 'function' ? log : () => {};
    this.defaultName = String(defaultName || DEFAULT_PRESET_NAME);
  }

  /** 是否落盘（关闭落盘时所有写操作都是 no-op，状态只活在内存里）。 */
  get enabled() {
    return Boolean(this.storage?.enabled);
  }

  /**
   * 从 `persona/presets.json` + `persona/bindings.json` 载入；没有 default 预设就自动补一个。
   * 坏 JSON 由 `JsonStore.read` 兜住，schema 层面的脏数据在这里丢弃并记日志，绝不抛。
   * 载入本身不写盘：默认预设是惰性的，下一次写操作才会把它带出去。
   *
   * @returns {PersonaStore} this（便于 `new PersonaStore(...).load()`）
   */
  load() {
    this.#presets.clear();
    this.#bindings.clear();
    this.#order = [];

    const presetsRaw = this.storage?.read?.('persona/presets.json', null) ?? null;
    if (presetsRaw !== null && !isPlainObject(presetsRaw)) {
      this.log('[persona] presets.json 形状不对（期望对象），按空库处理');
    }
    const rawPresets = isPlainObject(presetsRaw?.presets) ? presetsRaw.presets : {};
    for (const [key, value] of Object.entries(rawPresets)) {
      const k = String(key);
      if (!k) continue;
      if (!isPlainObject(value)) {
        this.log(`[persona] 丢弃预设 ${k}：不是对象`);
        continue;
      }
      // 键就是普通预设的名字；私有副本的键是 @session/…，名字丢了退回 defaultName。
      const preset = normalizePreset(value, isForkKey(k) ? this.defaultName : k);
      if (!preset.name) {
        this.log(`[persona] 丢弃预设 ${k}：名字为空`);
        continue;
      }
      this.#presets.set(k, preset);
    }

    // 顺序：先认落盘的 order（去重、丢掉已不存在的键），其余按名字排序补齐，保证稳定。
    const rawOrder = Array.isArray(presetsRaw?.order) ? presetsRaw.order : [];
    const seen = new Set();
    for (const item of rawOrder) {
      const k = String(item ?? '');
      if (!k || seen.has(k) || !this.#presets.has(k)) continue;
      seen.add(k);
      this.#order.push(k);
    }
    for (const k of [...this.#presets.keys()].filter((x) => !seen.has(x)).sort()) this.#order.push(k);

    if (!this.#presets.has(this.defaultName)) {
      const fallback = normalizePreset({ ...makeDefaultPreset(), name: this.defaultName }, this.defaultName);
      this.#presets.set(this.defaultName, fallback);
      this.#order.unshift(this.defaultName);
      if (presetsRaw !== null) this.log(`[persona] 没有 ${this.defaultName} 预设，已自动补一个`);
    }

    const bindingsRaw = this.storage?.read?.('persona/bindings.json', null) ?? null;
    if (bindingsRaw !== null && !isPlainObject(bindingsRaw)) {
      this.log('[persona] bindings.json 形状不对（期望对象），按无绑定处理');
    }
    const rawBindings = isPlainObject(bindingsRaw?.bindings) ? bindingsRaw.bindings : {};
    for (const [sessionKey, value] of Object.entries(rawBindings)) {
      const key = String(value ?? '');
      if (!key) continue;
      if (!this.#presets.has(key)) {
        // 失效绑定留着没有意义：resolve() 本来就会回落默认，留着只会让 boundName() 说谎。
        this.log(`[persona] 丢弃失效绑定 ${sessionKey} → ${key}（预设不存在）`);
        continue;
      }
      this.#bindings.set(String(sessionKey), key);
    }

    return this;
  }

  /**
   * 预设列表（不含会话私有副本），按 `order` 排，顺序稳定。
   * 返回的是库里的**同一个对象**（与 `get()` 一致）：调用方只读，要改请走 `save()`/`setHidden()`。
   *
   * @param {{includeHidden?:boolean}} [opts]
   * @returns {Array<{name:string, role:string, knowledges:string[], hidden:boolean}>}
   */
  list({ includeHidden = false } = {}) {
    const out = [];
    for (const key of this.#order) {
      if (isForkKey(key)) continue;
      const preset = this.#presets.get(key);
      if (!preset) continue;
      if (!includeHidden && preset.hidden) continue;
      out.push(preset);
    }
    return out;
  }

  /** @param {string} name @returns {boolean} */
  has(name) {
    return this.#presets.has(String(name ?? ''));
  }

  /** @param {string} name @returns {object|null} */
  get(name) {
    return this.#presets.get(String(name ?? '')) ?? null;
  }

  /**
   * 写入（同名覆盖）。名字缺失时落到 `defaultName` 上——即覆盖默认预设，调用方自己注意。
   *
   * @param {object} preset
   * @returns {{name:string, role:string, knowledges:string[], hidden:boolean}} 最终落库的对象
   */
  save(preset) {
    const normalized = normalizePreset(preset, this.defaultName);
    this.#presets.set(normalized.name, normalized);
    if (!this.#order.includes(normalized.name)) this.#order.push(normalized.name);
    this.#persist();
    return normalized;
  }

  /**
   * 删除预设。**default 不允许删**（见文件头第 2 条），删它返回 false。
   * 删掉之后：指向它的绑定直接摘掉（resolve 自然回落默认）；由它复制出来的会话私有副本
   * 也一并删掉，否则"预设删了但那些会话还在用它的旧副本"。
   *
   * @param {string} name
   * @returns {boolean} 是否真的删掉了一个预设
   */
  remove(name) {
    const key = String(name ?? '');
    if (key === this.defaultName) return false;
    if (!this.#presets.has(key)) return false;

    this.#presets.delete(key);
    this.#order = this.#order.filter((k) => k !== key);
    for (const [k, preset] of [...this.#presets]) {
      if (isForkKey(k) && preset.name === key) this.#presets.delete(k);
    }
    this.#order = this.#order.filter((k) => this.#presets.has(k));
    for (const [sessionKey, bound] of [...this.#bindings]) {
      if (bound === key || !this.#presets.has(bound)) this.#bindings.delete(sessionKey);
    }

    this.#persist();
    return true;
  }

  /**
   * 设置/取消"不在列表里展示"。只认严格布尔语义（`hidden === true`）。
   *
   * @param {string} name
   * @param {boolean} hidden
   * @returns {boolean} 预设是否存在（不存在返回 false，什么都不改）
   */
  setHidden(name, hidden) {
    const preset = this.#presets.get(String(name ?? ''));
    if (!preset) return false;
    preset.hidden = hidden === true;
    this.#persist();
    return true;
  }

  /**
   * 把一个会话绑定到某个预设。预设不存在则返回 false 且**不动**原有绑定
   * （半途改成 default 会让"名字打错了"看起来像"绑定成功了"）。
   *
   * @param {string} sessionKey 任何字符串都能当键（`group:123` / `private:456` / 别的东西）
   * @param {string} name
   * @returns {boolean}
   */
  bind(sessionKey, name) {
    const key = String(name ?? '');
    if (!this.#presets.has(key)) return false;
    this.#bindings.set(String(sessionKey ?? ''), key);
    this.#persist();
    return true;
  }

  /** @param {string} sessionKey @returns {boolean} 之前是否存在绑定 */
  unbind(sessionKey) {
    const had = this.#bindings.delete(String(sessionKey ?? ''));
    if (had) this.#persist();
    return had;
  }

  /**
   * 该会话绑定的预设名。没绑定、或绑定已失效（预设被删）时返回 null。
   *
   * @param {string} sessionKey
   * @returns {string|null}
   */
  boundName(sessionKey) {
    const key = this.#bindings.get(String(sessionKey ?? ''));
    if (!key) return null;
    const preset = this.#presets.get(key);
    return preset ? preset.name : null;
  }

  /**
   * 该会话**实际生效**的预设：绑定缺失/失效 → default。
   *
   * @param {string} sessionKey
   * @returns {object|null} 连 default 都没有时返回 null（正常 load 过不会是 null）
   */
  resolve(sessionKey) {
    const key = this.#bindings.get(String(sessionKey ?? ''));
    if (key) {
      const preset = this.#presets.get(key);
      if (preset) return preset;
    }
    return this.#presets.get(this.defaultName) ?? null;
  }

  /**
   * 会话级人设：写一份**会话私有预设**（把当前生效预设复制成 `@session/<sessionKey>` 并
   * 把该会话绑过去），而不是改写绑定预设本身。理由见文件头第 3 条——预设是共享的、绑定是
   * 私有的，改共享体会泄漏给所有共用它的会话。私有副本不出现在 `list()` 里，但随
   * presets.json 一起落盘，所以重建 PersonaStore 之后仍然生效。
   *
   * 只覆盖**显式给到**的字段：`setRole(key, { role })` 不动角色名；
   * `setRole(key, { knowledges: [] })` 才是真的清空。不传参数等价于"把当前预设固化成该会话
   * 的私有副本"。
   *
   * @param {string} sessionKey
   * @param {{name?:string, role?:string, knowledges?:string[]}} [patch]
   * @returns {object|null} 覆盖后的私有预设；没有可用基底时返回 null
   */
  setRole(sessionKey, { name, role, knowledges } = {}) {
    const sk = String(sessionKey ?? '');
    const base = this.resolve(sk);
    if (!base) return null;

    const current = this.#bindings.get(sk);
    const key = current && isForkKey(current) ? current : forkKeyOf(sk);
    const patched = normalizePreset(
      {
        name: name !== undefined ? name : base.name,
        role: role !== undefined ? role : base.role,
        knowledges: knowledges !== undefined ? knowledges : base.knowledges,
        hidden: base.hidden,
      },
      base.name,
    );

    this.#presets.set(key, patched);
    if (!this.#order.includes(key)) this.#order.push(key);
    this.#bindings.set(sk, key);
    this.#persist();
    return patched;
  }

  /**
   * 给 prompt 用的中文人设文本块：
   *
   * ```
   * 你是 {name}，{role}
   * ## 你的知识
   * - 第一条
   * ```
   *
   * 降级规则：两者都有才写"你是 X，Y"；只有名字写"你是 X。"；只有 role 就只写 role——
   * 绝不会出现"你是 ，"这种畸形串。没有 knowledges 时不输出"## 你的知识"段。
   * `resolve()` 返回 null（既没有 default 又没有绑定，比如 `new PersonaStore({})` 没 load）
   * 时返回空串，调用方据此判断"这段人设整个不装配"。
   *
   * @param {string} sessionKey
   * @returns {string}
   */
  render(sessionKey) {
    const preset = this.resolve(sessionKey);
    if (!preset) return '';
    const name = String(preset.name ?? '').trim();
    const role = String(preset.role ?? '').trim();

    const lines = [];
    if (name && role) lines.push(`你是 ${name}，${role}`);
    else if (name) lines.push(`你是 ${name}。`);
    else if (role) lines.push(role);

    const knowledges = Array.isArray(preset.knowledges) ? preset.knowledges : [];
    if (knowledges.length) {
      lines.push('## 你的知识');
      for (const item of knowledges) lines.push(`- ${item}`);
    }
    return lines.join('\n');
  }

  /** 诊断用统计：预设数按"用户可见"算（不含会话私有分叉，分叉另计 `forks`）。 */
  get stats() {
    let forks = 0;
    for (const key of this.#presets.keys()) if (isForkKey(key)) forks += 1;
    return {
      presets: this.list({ includeHidden: true }).length,
      bindings: this.#bindings.size,
      defaultName: this.defaultName,
      storage: this.enabled,
      forks,
    };
  }

  /** 可持久化的完整快照（和落盘内容同构，多带一个 `defaultName`）。 */
  snapshot() {
    return {
      version: PRESET_FILE_VERSION,
      defaultName: this.defaultName,
      presets: this.#presetsFile().presets,
      order: this.#presetsFile().order,
      bindings: this.#bindingsFile().bindings,
    };
  }

  /** 转发 `JsonStore.flush()`（关盘时是 0），方便 `await store.flush()`。 */
  flush() {
    return this.storage?.flush?.() ?? 0;
  }

  #presetsFile() {
    const presets = {};
    for (const [key, preset] of this.#presets) presets[key] = clonePreset(preset);
    return { version: PRESET_FILE_VERSION, presets, order: [...this.#order] };
  }

  #bindingsFile() {
    return { version: PRESET_FILE_VERSION, bindings: Object.fromEntries(this.#bindings) };
  }

  /** 惰性落盘：producer 在 flush 时才执行，所以连改十次也只序列化一次。 */
  #persist() {
    this.storage?.schedule?.('persona/presets.json', () => this.#presetsFile());
    this.storage?.schedule?.('persona/bindings.json', () => this.#bindingsFile());
  }
}
