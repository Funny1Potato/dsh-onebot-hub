/**
 * OneBot 能力面（§22 需求 2）：把"实现端能提供的信息"做成稳定可用的能力面。
 *
 * 本模块只放**纯逻辑**，不碰链路：
 *  - `tierOf(action)`：三分法分级（§22.1-2）——`read` 只读 / `write` 有副作用 / `danger` 默认禁用。
 *  - `explainRetcode(retcode, msg)`：把 retcode 翻成人话，让 agent 能优雅降级（§22.1-5）。
 *  - `CapabilityCache`：只读结果 TTL 缓存（§22.1-4）——"这人是谁""这群多少人"会被反复问。
 *  - `CapabilityRegistry`：能力探测与失败记录（§22.1-3）——**不支持也要缓存结论**，
 *    否则每次调用都要等一次超时。
 *  - `shapeResult` / `toWireResponse`：前者是给 agent 看的形状（带 `source`/`note`），
 *    后者是回给下游 bot 的**协议形状**（只有 status/retcode/data/echo，多一个字节都不加）。
 *
 * 设计约束（§22.6）：标准 OneBot v11 只有 39 个 action，清单见
 * `docs/onebot11-action-inventory.md`；实现端扩展（`_get_group_notice`、`get_qq_avatar`…）
 * **不能当标准用**，所以本模块只做"分级 + 缓存 + 记录"，
 * 任何"某个 action 是否可用"的结论都来自 `CapabilityRegistry` 的实测记录，而不是硬编码猜测。
 */

/** 去掉异步/限速后缀：分级与缓存都按"基名"判断。 */
export function baseAction(action) {
  return String(action ?? '')
    .replace(/_(async|rate_limited)$/, '')
    .replace(/_(async|rate_limited)$/, '');
}

/**
 * `danger`：默认禁用，需要显式白名单（§22.6 末段 + 清单里风险"高"的那些）。
 * 隐藏 API 与原始数据包一律在此——它们不是"不方便"，是"会出事"。
 */
export const DANGER_ACTIONS = new Set([
  '.handle_quick_operation',
  'set_restart',
  'set_group_kick',
  'set_group_ban',
  'set_group_anonymous_ban',
  'set_group_whole_ban',
  'set_group_admin',
  'set_group_leave',
]);

/** `danger` 的前缀（隐藏 API 一律以点号开头；原始数据包按前缀封死）。 */
export const DANGER_PREFIXES = ['.', 'send_packet', 'send_pb'];

/** 凭证类：只读，但泄露风险中（§22.3 末几行）——默认不外露给 agent。 */
export const SENSITIVE_ACTIONS = new Set([
  'get_cookies',
  'get_csrf_token',
  'get_credentials',
  'get_online_clients',
]);

/** `write`：有对外副作用，需按策略/审批放行（§22.6 里风险"中/低"的写操作）。 */
export const WRITE_ACTIONS = new Set([
  'send_like',
  'delete_msg',
  'set_group_card',
  'set_group_name',
  'set_group_special_title',
  'set_group_anonymous',
  'set_friend_add_request',
  'set_group_add_request',
  'clean_cache',
  'mark_msg_as_read',
  'set_input_status',
  'set_group_reaction',
  'set_msg_emoji_like',
  'set_qq_profile',
  'set_qq_avatar',
]);

/** 写操作前缀：`send_*` 全是发送（含 send_msg / send_group_forward_msg 等扩展）。 */
export const WRITE_PREFIXES = ['send_', 'set_', '_send_', '_del_', '_delete_', 'delete_'];

/**
 * 三分法分级。默认 `read`——因为**只读是安全侧**，
 * 而"把写操作误判成只读"比"把只读误判成写"危险得多，所以写/危险全部显式列举。
 * @returns {'read'|'write'|'danger'}
 */
export function tierOf(action) {
  const name = baseAction(action);
  if (DANGER_ACTIONS.has(name) || DANGER_PREFIXES.some((p) => name.startsWith(p))) return 'danger';
  if (WRITE_ACTIONS.has(name) || WRITE_PREFIXES.some((p) => name.startsWith(p))) return 'write';
  return 'read';
}

/** 是否属于需要额外授权的敏感只读（凭证类）。 */
export function isSensitive(action) {
  return SENSITIVE_ACTIONS.has(baseAction(action));
}

/**
 * retcode → 人话（§22.1-5）。
 *
 * 可信度说明（§22.6 最后一条）：OneBot v11 规范**只定义了 `status`/`retcode` 字段的存在，
 * 没有定义取值表**（规范原文：响应里"另有 status、retcode 字段"，取值由实现端自定）。
 * 所以下表是"常见实现端的通行取值"，每条都允许被实测推翻；
 * 真正权威的是响应里的 `msg` 原文——`explainRetcode` 一律把它带上，未知码不硬猜。
 */
export const RETCODE_TEXT = {
  0: '成功',
  1: '失败（实现端未细分原因）',
  100: '实现端不支持该 action，或缺少必需参数',
  102: '参数格式错误',
  103: '操作失败',
  104: '凭证失效，需要重新登录',
  1200: '请求超时',
  1201: '链路未连接（上游断开）',
  1400: '参数错误',
  1401: '权限不足',
  1403: '枢纽策略拒绝',
  1404: '目标不存在（群 / 用户 / 消息）',
  1500: '实现端内部错误',
};

/**
 * @param {number|string|null} retcode
 * @param {string} [msg] 实现端原文，永远原样带出
 * @returns {{code:number|null, text:string, msg:string|null, known:boolean}}
 */
export function explainRetcode(retcode, msg) {
  const code = retcode === null || retcode === undefined || retcode === '' ? null : Number(retcode);
  const known = code !== null && Object.prototype.hasOwnProperty.call(RETCODE_TEXT, code);
  return {
    code: Number.isFinite(code) ? code : null,
    text: known ? RETCODE_TEXT[code] : code === null ? '响应里没有 retcode' : `未知 retcode ${retcode}`,
    msg: msg === undefined || msg === null || msg === '' ? null : String(msg),
    known,
  };
}

/**
 * 只读结果的 TTL（§22.3 的"缓存 TTL"列）。
 *  - `Infinity` = 会话期（进程生命周期内不变的东西：登录号、实现端版本）；
 *  - `0` = 不缓存（消息、媒体 URL 这类会过期的）；
 *  - 未列出的按 `get_*` 通配 60s。
 */
export const TTL_MS = {
  get_login_info: Infinity,
  get_version_info: Infinity,
  get_status: 30_000,
  get_group_member_list: 60_000,
  get_group_member_info: 300_000,
  get_stranger_info: 300_000,
  get_friend_list: 300_000,
  get_group_info: 300_000,
  get_group_list: 300_000,
  get_group_honor_info: 600_000,
  get_msg: 0,
  get_forward_msg: 0,
  get_image: 0,
  get_record: 0,
  can_send_image: 600_000,
  can_send_record: 600_000,
};

/** 某个 action 的缓存时长（毫秒；0 = 不缓存）。 */
export function ttlOf(action) {
  const name = baseAction(action);
  if (Object.prototype.hasOwnProperty.call(TTL_MS, name)) return TTL_MS[name];
  if (name.startsWith('get_')) return 60_000;
  return 0;
}

/** 稳定的缓存键：参数按键名排序，避免 `{a:1,b:2}` 与 `{b:2,a:1}` 算两条。 */
export function cacheKey(action, params = {}) {
  const keys = Object.keys(params ?? {}).sort();
  const pairs = keys.map((k) => [k, params[k]]);
  return `${baseAction(action)}|${JSON.stringify(pairs)}`;
}

/** 只读结果 TTL 缓存（§22.1-4）。命中/未命中都记账，供 `onebot_caps` 观察。 */
export class CapabilityCache {
  #entries = new Map();
  #stats = { hits: 0, misses: 0, sets: 0, expired: 0 };

  /**
   * @param {string} action
   * @param {object} params
   * @param {number} [now] 便于测试注入时间
   * @returns {{value:any, ageMs:number}|null}
   */
  get(action, params, now = Date.now()) {
    const key = cacheKey(action, params);
    const hit = this.#entries.get(key);
    if (!hit) {
      this.#stats.misses += 1;
      return null;
    }
    const ageMs = now - hit.at;
    if (hit.ttlMs !== Infinity && ageMs >= hit.ttlMs) {
      this.#entries.delete(key);
      this.#stats.expired += 1;
      this.#stats.misses += 1;
      return null;
    }
    this.#stats.hits += 1;
    return { value: hit.value, ageMs };
  }

  /** @returns {boolean} 是否真的写了（ttl 为 0 时不写） */
  set(action, params, value, ttlMs = ttlOf(action), now = Date.now()) {
    if (!(ttlMs > 0) && ttlMs !== Infinity) return false;
    this.#entries.set(cacheKey(action, params), { value, at: now, ttlMs });
    this.#stats.sets += 1;
    return true;
  }

  /** 清缓存；给 action 则只清它。 */
  invalidate(action) {
    if (action === undefined) {
      const n = this.#entries.size;
      this.#entries.clear();
      return n;
    }
    const prefix = `${baseAction(action)}|`;
    let n = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key);
        n += 1;
      }
    }
    return n;
  }

  get size() {
    return this.#entries.size;
  }

  get stats() {
    const { hits, misses } = this.#stats;
    return { ...this.#stats, size: this.#entries.size, hitRate: hits + misses === 0 ? null : hits / (hits + misses) };
  }

  /**
   * 序列化（§24.10 的 `capabilities/<linkId>.json`）。
   * `at` 存**绝对时间**而不是"剩余寿命"：重启后还知道这条缓存多旧，
   * 过期与否交给 `get()` 的同一套判断，不写第二份逻辑。
   */
  toJSON() {
    return {
      entries: [...this.#entries.entries()].map(([key, hit]) => ({ key, value: hit.value, at: hit.at, ttlMs: hit.ttlMs })),
    };
  }

  /** @returns {number} 载入了多少条（过期的直接丢掉，不占内存） */
  load(data, now = Date.now()) {
    const rows = Array.isArray(data?.entries) ? data.entries : [];
    let n = 0;
    for (const row of rows) {
      if (!row || typeof row.key !== 'string') continue;
      const ttlMs = row.ttlMs === null || row.ttlMs === undefined ? 0 : row.ttlMs;
      const at = Number(row.at);
      if (!Number.isFinite(at)) continue;
      if (ttlMs !== Infinity && now - at >= ttlMs) {
        this.#stats.expired += 1;
        continue;
      }
      this.#entries.set(row.key, { value: row.value, at, ttlMs });
      n += 1;
    }
    return n;
  }
}

/**
 * 能力注册表（§22.1-3）：记录每个 action **实测**能不能用。
 *
 * 这是"能力探测而不是猜"的落点：调用成功记 `supported`，返回"不支持/参数错误"记
 * `unsupported`（**带结论就不会反复重试**），其它失败只是记一笔错误、不下结论。
 */
export class CapabilityRegistry {
  #actions = new Map();
  #impl = null;
  #probes = [];

  /** 实现端身份探测（`get_version_info` / `get_login_info` / `get_status`）。 */
  noteProbe({ appName, appVersion, protocolVersion, selfId, nickname, at = Date.now(), ok = true } = {}) {
    this.#probes.push({ at, ok, appName: appName ?? null, appVersion: appVersion ?? null });
    if (!ok) return null;
    this.#impl = {
      app_name: appName ?? this.#impl?.app_name ?? null,
      app_version: appVersion ?? this.#impl?.app_version ?? null,
      protocol_version: protocolVersion ?? this.#impl?.protocol_version ?? 'v11',
      self_id: selfId ?? this.#impl?.self_id ?? null,
      nickname: nickname ?? this.#impl?.nickname ?? null,
      at,
    };
    return this.#impl;
  }

  get impl() {
    return this.#impl;
  }

  /**
   * 记一次调用结果。
   * @param {string} action
   * @param {{ok:boolean, retcode?:number|null, msg?:string|null, at?:number, source?:string, cached?:boolean}} result
   */
  note(action, { ok, retcode = null, msg = null, at = Date.now(), source = 'upstream', cached = false } = {}) {
    const name = baseAction(action);
    const rec = this.#actions.get(name) ?? {
      action: name,
      supported: 'unknown',
      calls: 0,
      ok: 0,
      failed: 0,
      lastRetcode: null,
      lastMsg: null,
      lastErrorAt: null,
      lastOkAt: null,
      firstSeenAt: at,
    };
    rec.calls += 1;
    if (ok) {
      rec.ok += 1;
      rec.supported = 'supported';
      rec.lastOkAt = at;
    } else {
      rec.failed += 1;
      rec.lastRetcode = retcode ?? null;
      rec.lastMsg = msg ?? null;
      rec.lastErrorAt = at;
      // 1404（目标不存在）说明 action 是通的，只是这次对象不对 → 不下"不支持"的结论。
      // 100/1400/102 才更像"这个 action/参数实现端不认"。
      if ([100, 102, 1400].includes(Number(retcode)) || /not (support|implement)|unsupported|不支持|未实现/i.test(String(msg ?? ''))) {
        rec.supported = 'unsupported';
      }
    }
    if (source && !cached) rec.lastSource = source;
    this.#actions.set(name, rec);
    return rec;
  }

  get(action) {
    return this.#actions.get(baseAction(action)) ?? null;
  }

  /** 供 `onebot_caps` 输出：只读结论、失败记录、可移植性提示。 */
  snapshot() {
    const actions = [...this.#actions.values()].sort((a, b) => a.action.localeCompare(b.action));
    return {
      impl: this.#impl,
      probes: this.#probes.slice(-10),
      note: 'supported/unsupported 都来自实测；unknown 表示还没调用过，不代表不支持。',
      supported: actions.filter((a) => a.supported === 'supported').map((a) => a.action),
      unsupported: actions.filter((a) => a.supported === 'unsupported').map((a) => a.action),
      actions,
    };
  }

  /**
   * 序列化到 `capabilities/<linkId>.json`（§22.1-3 的"结论要留下来"）。
   *
   * 落盘的意义不是省一次网络往返，而是**重启后不再把同一个坑踩一遍**：
   * "这个实现端没有 `_get_group_notice`"是花一次超时换来的结论，
   * 不该因为 DSH 重启就重新花一次。
   */
  toJSON() {
    return {
      impl: this.#impl,
      probes: this.#probes.slice(-10),
      actions: [...this.#actions.values()],
    };
  }

  /** @returns {number} 载入的 action 条数 */
  load(data) {
    if (!data || typeof data !== 'object') return 0;
    if (data.impl && typeof data.impl === 'object') this.#impl = { ...data.impl };
    if (Array.isArray(data.probes)) this.#probes = data.probes.slice(-10).map((p) => ({ ...p }));
    const rows = Array.isArray(data.actions) ? data.actions : [];
    let n = 0;
    for (const row of rows) {
      if (!row || typeof row.action !== 'string') continue;
      this.#actions.set(baseAction(row.action), { ...row, action: baseAction(row.action) });
      n += 1;
    }
    return n;
  }

  /** 清空实测结论（`onebot_caps({reset:true})`）：实现端换了或升级了时用。 */
  reset() {
    const n = this.#actions.size;
    this.#actions.clear();
    this.#probes = [];
    return n;
  }
}

/**
 * 统一返回形状（§22.5 末）：`{ ok, retcode, data, source, note, provenance? }`。
 * `source` 让 agent 知道拿到的是实时值还是缓存值——拟人化时"我刚看了下"和"我记得"不是一回事。
 */
export function shapeResult({ action, envelope, source = 'upstream', ageMs = null, tier, sensitive = false, note = null } = {}) {
  const retcode = envelope?.retcode ?? null;
  const status = envelope?.status ?? (retcode === 0 ? 'ok' : 'failed');
  const ok = retcode === 0 || status === 'ok';
  const explained = explainRetcode(retcode, envelope?.msg);
  const parts = [];
  if (!ok) parts.push(explained.text);
  if (explained.msg) parts.push(`实现端原文：${explained.msg}`);
  if (source === 'cache') parts.push(`来自缓存（${Math.round((ageMs ?? 0) / 1000)} 秒前）`);
  if (sensitive) parts.push('敏感只读（凭证类），默认不外露给 agent');
  return {
    ok,
    status,
    action: baseAction(action),
    retcode,
    data: envelope?.data ?? null,
    source,
    ageMs,
    tier,
    sensitive,
    note: note ?? (parts.length ? parts.join('；') : null),
  };
}

/**
 * 把 `shapeResult` 的结果压回 OneBot 的**响应信封**（§22.5 末）。
 *
 * 为什么不能直接把 `shapeResult` 的结果发给下游：它是给 agent 看的形状，带
 * `source`/`tier`/`note` 这些 hub 内部字段。下游 bot 收到的是协议响应，
 * 只该有 `status`/`retcode`/`data`/`echo`——多出来的字段虽然大概率被忽略，
 * 但没有理由让下游看到 hub 的内部决策。`status` 与 `retcode` **原样透传**
 * （不能把实现端的 `async` 改写成 `failed`），失败时把中文说明放进 `msg`
 * （实现端自己也会这么发）。
 */
export function toWireResponse(shaped, echo = null) {
  const res = {
    status: shaped?.status ?? (shaped?.ok ? 'ok' : 'failed'),
    retcode: shaped?.retcode ?? (shaped?.ok ? 0 : 1200),
    data: shaped?.data ?? null,
    echo: echo ?? null,
  };
  if (!shaped?.ok && shaped?.note) res.msg = shaped.note;
  return res;
}
