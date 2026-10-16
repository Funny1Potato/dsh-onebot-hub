/**
 * 分群额度（`m13404` 用户定案；本期 **P1＝只记不拦**）。
 *
 * 为什么单开一个模块：额度是**跨会话**的账——同一个群今天换过几次会话、枢纽重启过几次，
 * 账都得连着（键就是 `group:<群号>` / `private:<QQ号>`）。所以它不挂在某段会话上，
 * 而是吃根作用域那条 `session/event`（见 `lib/index.js` 的会话账本订阅）里的
 * `assistant/message.data.usage`，按 (agentKey, 本地日/月) 累加。
 *
 * 三条口径（用户定）：
 *  1. `unit: 'token'` = `input + cache + output`，**不区分输入输出**；
 *  2. `unit: 'cost'`  = 按群里自填的 `price.{input,cache,output}`（每百万 token）折算；
 *  3. 账本**只存三元组原值**，钱在读取时现算——改单价、换口径都自动重算，不丢数据。
 *
 * 只算枢纽主会话：会话 id 前缀里本来就编码着 agentKey，归因零成本；
 * subagent/子会话与旁路 LLM（识图 describe 等）**不计入**（用户定）。
 *
 * ⚠️ `usage` 是**每一步**到账的（一个回合会有好几条 `assistant/message`），
 * 所以报数永远是"截至上一批"，当前在飞回合还没入账——文案里不要承诺实时。
 */

/** 落盘文件名（相对 `hub.storage` 的数据目录，即 `~/.dsh/onebot-hub`）。 */
export const QUOTA_FILE = 'quota/ledger.json';
/** 账本结构版本：以后改形状靠它做迁移/丢弃。 */
export const QUOTA_VERSION = 1;
/** 历史保留：日行 90 天、月行 24 个月（超出即丢，账本不能无限长）。 */
export const KEEP_DAYS = 90;
export const KEEP_MONTHS = 24;

export const QUOTA_UNITS = ['token', 'cost'];
export const QUOTA_NOTICES = ['detail', 'percent', 'off'];
export const QUOTA_EXHAUST = ['notice', 'silent'];

const n = (value, fallback = 0) => {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
};
const bool = (value, fallback) => (value === undefined ? fallback : value === true);

/** 本地日键 `YYYY-MM-DD`（用户口径："当天"＝本机时区的那一天）。 */
export function localDayKey(at = Date.now()) {
  const d = new Date(n(at, Date.now()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 本地月键 `YYYY-MM`。 */
export function localMonthKey(at = Date.now()) {
  const d = new Date(n(at, Date.now()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 空行（日/月共用形状）。 */
export const emptyRow = () => ({ input: 0, cache: 0, output: 0, turns: 0, firstAt: 0, lastAt: 0 });

/** 全局默认：**不配就是不限**（用户定案：示例阈值一律 0）。 */
export const DEFAULT_QUOTA = Object.freeze({
  enabled: false,
  unit: 'token',
  tokensPerDay: 0,
  tokensPerMonth: 0,
  costPerDay: 0,
  costPerMonth: 0,
  currency: 'CNY',
  price: { input: 0, cache: 0, output: 0 },
  notice: 'detail',
  noticeHint: true,
  onExhaust: 'notice',
  exhaustedReply: '本群今天的额度已经用完了，我先歇会儿，明天 00:00 自动恢复。',
  noticeCooldownMs: 600000,
  // 用户 m13404 定：超管 @ **也不**唤醒（照常按额度说话），所以默认 false。
  superuserBypass: false,
});

/**
 * 归一**一份**额度配置（`base` 只在测试拼装时用得到）。容忍字符串数字；非法值回退默认，
 * 不抛错——配置面写错不该让插件起不来。
 *
 * m14190 起这份配置**只挂在白名单条目上**（`groups`/`privates` 每行的 `quota`），
 * 没有全局 `agent.quota` 了：口径（按 token 还是按钱）、单价、报数口径都是"这个群自己的事"。
 */
export function normalizeQuota(raw = {}, base = DEFAULT_QUOTA) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const price = src.price && typeof src.price === 'object' ? src.price : {};
  const basePrice = base?.price ?? DEFAULT_QUOTA.price;
  return {
    enabled: bool(src.enabled, base?.enabled ?? false),
    unit: QUOTA_UNITS.includes(src.unit) ? src.unit : (base?.unit ?? 'token'),
    tokensPerDay: Math.max(0, n(src.tokensPerDay, base?.tokensPerDay ?? 0)),
    tokensPerMonth: Math.max(0, n(src.tokensPerMonth, base?.tokensPerMonth ?? 0)),
    costPerDay: Math.max(0, n(src.costPerDay, base?.costPerDay ?? 0)),
    costPerMonth: Math.max(0, n(src.costPerMonth, base?.costPerMonth ?? 0)),
    currency: String(src.currency ?? base?.currency ?? 'CNY').slice(0, 8) || 'CNY',
    price: {
      input: Math.max(0, n(price.input, basePrice.input ?? 0)),
      cache: Math.max(0, n(price.cache, basePrice.cache ?? 0)),
      output: Math.max(0, n(price.output, basePrice.output ?? 0)),
    },
    notice: QUOTA_NOTICES.includes(src.notice) ? src.notice : (base?.notice ?? 'detail'),
    noticeHint: bool(src.noticeHint, base?.noticeHint ?? true),
    onExhaust: QUOTA_EXHAUST.includes(src.onExhaust) ? src.onExhaust : (base?.onExhaust ?? 'notice'),
    // 空串/纯空白/非字符串都当"没填"→ 用默认话术（清空 ≠ 说"0"）；想彻底闭嘴走 onExhaust:'silent'。
    exhaustedReply: (typeof (src.exhaustedReply ?? base?.exhaustedReply) === 'string'
      ? String(src.exhaustedReply ?? base?.exhaustedReply).trim().slice(0, 300)
      : '') || DEFAULT_QUOTA.exhaustedReply,
    noticeCooldownMs: Math.max(0, n(src.noticeCooldownMs, base?.noticeCooldownMs ?? 600000)),
    superuserBypass: bool(src.superuserBypass, base?.superuserBypass ?? false),
  };
}

/**
 * 名单条目上的额度（m14190：**额度只按群/私聊分别设，没有全局块**）。
 * 条目里没写 `quota`、写坏了、或没勾"启用" → 返回默认（`enabled:false`）＝不限。
 * 这里只归一不判"有没有配"，判不配是 `quotaConfigured()` 的事（闸门与报数共用一个口径）。
 */
export function quotaOfEntry(entry) {
  const raw = entry?.quota;
  return normalizeQuota(raw && typeof raw === 'object' ? raw : {});
}

/** 该额度在 `scope`（`day` / `month`）上的限额；0 = 不限。 */
export function quotaLimit(quota, scope) {
  if (!quota?.enabled) return 0;
  return scope === 'month'
    ? (quota.unit === 'cost' ? quota.costPerMonth : quota.tokensPerMonth)
    : (quota.unit === 'cost' ? quota.costPerDay : quota.tokensPerDay);
}

/** 限额是否真的配了（配了 enabled 但数值全 0 = 不限，报数行也不该出现）。 */
export function quotaConfigured(quota) {
  return Boolean(quota?.enabled) && (quotaLimit(quota, 'day') > 0 || quotaLimit(quota, 'month') > 0);
}

/** 一行账按口径折算成"已用值"。 */
export function quotaValue(row, quota) {
  if (!row) return 0;
  if (quota?.unit === 'cost') {
    const p = quota.price ?? {};
    return (n(row.input) / 1e6) * n(p.input) + (n(row.cache) / 1e6) * n(p.cache) + (n(row.output) / 1e6) * n(p.output);
  }
  return n(row.input) + n(row.cache) + n(row.output);
}

/** 金额符号：CNY/USD 之外原样显示代码。 */
export function currencySymbol(currency) {
  const c = String(currency ?? 'CNY').toUpperCase();
  if (c === 'CNY' || c === 'RMB') return '¥';
  if (c === 'USD') return '$';
  return `${c} `;
}

/** 数值展示：token 千分位、钱两位小数，带上口径后缀。 */
export function formatQuotaValue(value, quota) {
  if (quota?.unit === 'cost') return `${currencySymbol(quota.currency)}${n(value).toFixed(2)}`;
  return `${Math.round(n(value)).toLocaleString('en-US')} token`;
}

/**
 * 恢复后补注入的原话条数（用户 m13831 选 A：最近 20 条）。
 * 攒的环形记忆留 `QUOTA_HOLD_MAX` 条，多出来的丢掉并计数——补的是"最近"，不是全量回放。
 */
export const QUOTA_CATCHUP = 20;
export const QUOTA_HOLD_MAX = 60;

/** 剩余 ≤ 这个比例时报数行不受冷却限制：要超了正是模型最该知道的时候。 */
export const NOTICE_URGENT = 0.1;

const percentLeft = (used, limit) => {
  if (!(limit > 0)) return 100;
  return Math.max(0, Math.min(100, (1 - n(used) / limit) * 100));
};

/** `今日 00:00 重置` 那半句：日=明天零点，月=下月 1 日。 */
function resetLabel(scope) {
  return scope === 'month' ? '下月 1 日重置' : '明日 00:00 重置';
}

/**
 * 分群额度账本。
 *
 * 数据形状（落盘 `QUOTA_FILE`）：
 * ```json
 * { "version": 1, "agents": { "group:123": {
 *   "days":   { "2026-10-16": { "input":0,"cache":0,"output":0,"turns":0,"firstAt":0,"lastAt":0 } },
 *   "months": { "2026-10": { ... } },
 *   "waivers":[ { "scope":"day","key":"2026-10-16","by":"123","at":0,"amount":0,"note":"" } ] } } }
 * ```
 * `waivers`（超管解限）**不清零**：`剩余 = 限额 − 已用 + 解限额`，否则账本对不上、也丢审计。
 */
export class QuotaLedger {
  #agents = new Map();
  #last = new Map();
  #dirty = false;
  #noticeAt = new Map(); // agentKey -> 上次报数的时间戳（冷却用，只在内存）

  /**
   * @param {{storage?:object, log?:Function, now?:Function}} [opts]
   *   `storage` 传 `hub.storage`（`lib/storage.js` 的 `JsonStore`）；关存储时退化成纯内存。
   */
  constructor({ storage = null, log, now } = {}) {
    this.storage = storage ?? null;
    this.log = log ?? (() => {});
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.load();
  }

  /** 从磁盘读回（坏文件由 JsonStore 兜底成 `null`）。 */
  load() {
    const raw = this.storage?.read?.(QUOTA_FILE, null) ?? null;
    if (!raw || typeof raw !== 'object' || !raw.agents || typeof raw.agents !== 'object') return this;
    for (const [agentKey, value] of Object.entries(raw.agents)) {
      if (!value || typeof value !== 'object') continue;
      this.#agents.set(String(agentKey), {
        days: value.days && typeof value.days === 'object' ? value.days : {},
        months: value.months && typeof value.months === 'object' ? value.months : {},
        waivers: Array.isArray(value.waivers) ? value.waivers : [],
      });
    }
    return this;
  }

  /** 序列化（惰性落盘用）。 */
  toJSON() {
    const agents = {};
    for (const [agentKey, value] of this.#agents) {
      if (!value.days || !Object.keys(value.days).length) {
        // 没有任何账的条目（只有 waiver）也要留，否则解限记录会凭空消失
        if (!value.waivers?.length) continue;
      }
      agents[agentKey] = { days: value.days ?? {}, months: value.months ?? {}, waivers: value.waivers ?? [] };
    }
    return { version: QUOTA_VERSION, agents };
  }

  #scheduleSave() {
    this.#dirty = true;
    this.storage?.schedule?.(QUOTA_FILE, () => this.toJSON());
  }

  /** 立即落盘（`hub.stop()` 那条路上由 `JsonStore.flush()` 统一做，这里留个手动口）。 */
  flush() {
    if (this.#dirty) this.storage?.write?.(QUOTA_FILE, this.toJSON());
    this.#dirty = false;
    return true;
  }

  #entry(agentKey) {
    const key = String(agentKey ?? '');
    let entry = this.#agents.get(key);
    if (!entry) {
      entry = { days: {}, months: {}, waivers: [] };
      this.#agents.set(key, entry);
    }
    return entry;
  }

  /** 取某会话当前日/月两行（不存在就是 `null`，**不**顺手建空行）。 */
  usage(agentKey, at = this.now()) {
    const entry = this.#agents.get(String(agentKey ?? '')) ?? null;
    return {
      entry,
      day: entry?.days?.[localDayKey(at)] ?? null,
      month: entry?.months?.[localMonthKey(at)] ?? null,
    };
  }

  /**
   * 记一条宿主会话事件。只认 `assistant/message` 且带 `usage` 的那些；
   * 其余（tool/call、turn/end…）一概不碰。
   *
   * `sessionId` 只用于去重：同一事件可能被 root 级与会话作用域两条订阅同时送到，
   * 重复记账会让额度凭空翻倍。
   *
   * @returns {object|null} 命中的日/月行，未记账返回 `null`
   */
  note(agentKey, event, sessionId = '') {
    if (!agentKey || !event || event.type !== 'assistant/message') return null;
    const usage = event.data?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const seq = Number(event.seq);
    const sid = String(sessionId ?? '');
    const last = this.#last.get(agentKey);
    if (last && last.id === sid && Number.isFinite(seq) && seq <= last.seq) return null;
    if (Number.isFinite(seq)) this.#last.set(agentKey, { id: sid, seq });

    const at = n(this.now(), Date.now());
    const entry = this.#entry(agentKey);
    const dayKey = localDayKey(at);
    const monthKey = localMonthKey(at);
    const day = (entry.days[dayKey] ??= emptyRow());
    const month = (entry.months[monthKey] ??= emptyRow());
    const input = n(usage.inputTokens);
    const cache = n(usage.cacheReadTokens);
    const output = n(usage.outputTokens);
    for (const row of [day, month]) {
      row.input += input;
      row.cache += cache;
      row.output += output;
      row.lastAt = at;
      if (!row.firstAt) row.firstAt = at;
    }
    // 轮次按 `data.turn` 去重：一个回合好几条 assistant/message，只算一轮。
    const turn = Number(event.data?.turn);
    if (Number.isFinite(turn) && entry.lastTurn !== turn) {
      entry.lastTurn = turn;
      day.turns += 1;
      month.turns += 1;
    }
    this.#scheduleSave();
    return { day, month };
  }

  /** 解限：`scope='day'|'month'`，`amount` 用当前口径单位（token 或币值）。 */
  waive(agentKey, { scope = 'day', key = null, by = '', amount = 0, note = '' } = {}) {
    const at = n(this.now(), Date.now());
    const entry = this.#entry(agentKey);
    const row = {
      scope: scope === 'month' ? 'month' : 'day',
      key: String(key ?? (scope === 'month' ? localMonthKey(at) : localDayKey(at))),
      by: String(by ?? '').slice(0, 64),
      at,
      amount: Math.max(0, n(amount)),
      note: String(note ?? '').slice(0, 200),
    };
    entry.waivers.push(row);
    this.#scheduleSave();
    return row;
  }

  /** 某期已解限的总量。 */
  waived(agentKey, scope, key) {
    const entry = this.#agents.get(String(agentKey ?? '')) ?? null;
    if (!entry?.waivers?.length) return 0;
    const s = scope === 'month' ? 'month' : 'day';
    let sum = 0;
    for (const w of entry.waivers) if (w?.scope === s && String(w.key) === String(key)) sum += Math.max(0, n(w.amount));
    return sum;
  }

  /** 最近若干条解限记录（命令输出用）。 */
  waiversOf(agentKey, limit = 3) {
    const entry = this.#agents.get(String(agentKey ?? '')) ?? null;
    return (entry?.waivers ?? []).slice(-Math.max(1, limit));
  }

  /**
   * 这个会话此刻的额度状态——第二期的闸门读它（`lib/mind.js` 的 `#quotaVerdict`）。
   *
   * `used` 已经减掉解限额：`剩余 = 限额 − 已用 + 解限额`，所以解限后 `over` 立刻变 false，
   * 不需要任何"清零"动作。
   * @returns {{configured:boolean, day:object, month:object, exhausted:boolean, scope:string|null}}
   */
  state(agentKey, quota, at = this.now()) {
    const { day, month } = this.usage(agentKey, at);
    const view = (scope, row, limit) => {
      const bucketKey = scope === 'month' ? localMonthKey(at) : localDayKey(at);
      const waived = limit > 0 ? this.waived(agentKey, scope, bucketKey) : 0;
      const used = Math.max(0, quotaValue(row, quota) - waived);
      return {
        scope,
        key: bucketKey,
        used,
        limit,
        waived,
        left: Math.max(0, limit > 0 ? limit - used : 0),
        pct: limit > 0 ? percentLeft(used, limit) : 100,
        over: limit > 0 && used >= limit,
        turns: n(row?.turns),
      };
    };
    const d = view('day', day, quotaLimit(quota, 'day'));
    const m = view('month', month, quotaLimit(quota, 'month'));
    const configured = quotaConfigured(quota);
    const hit = d.over ? d : (m.over ? m : null);
    return { configured, day: d, month: m, exhausted: Boolean(configured && hit), scope: hit?.scope ?? null };
  }

  /**
   * 批次最后一行（新消息下方）的额度提示；没配额度返回空串。
   *
   * `detail` 给"已用/限额/剩余百分比"，`percent` 只给剩余百分比，`off` 完全不出声。
   * 数字是"截至上一批"：当前在飞回合的 usage 还没到账。
   *
   * 冷却（`noticeCooldownMs`）：两次报数之间至少隔这么久，免得话痨群每批都刷一行；
   * 但"快到限额/已经超了"不冷却——那正是模型最该知道的时候。
   */
  render(agentKey, quota, at = this.now()) {
    if (!quotaConfigured(quota) || quota.notice === 'off') return '';
    const { day, month } = this.usage(agentKey, at);
    const dayLimit = quotaLimit(quota, 'day');
    const monthLimit = quotaLimit(quota, 'month');
    const where = String(agentKey ?? '').startsWith('private:') ? '本私聊' : '本群';
    const fmt = (value) => formatQuotaValue(value, quota);
    const usedOf = (row, scope) => Math.max(0, quotaValue(row, quota) - this.waived(agentKey, scope, scope === 'month' ? localMonthKey(at) : localDayKey(at)));
    const clauses = [];
    if (dayLimit > 0) {
      const used = usedOf(day, 'day');
      clauses.push(quota.notice === 'percent'
        ? `今日剩余 ${percentLeft(used, dayLimit).toFixed(1)}%`
        : `今日 已用 ${fmt(used)} / ${fmt(dayLimit)}（剩余 ${percentLeft(used, dayLimit).toFixed(1)}%）· ${resetLabel('day')}`);
    }
    if (monthLimit > 0) {
      const used = usedOf(month, 'month');
      clauses.push(quota.notice === 'percent'
        ? `本月剩余 ${percentLeft(used, monthLimit).toFixed(1)}%`
        : `本月 已用 ${fmt(used)} / ${fmt(monthLimit)}（剩余 ${percentLeft(used, monthLimit).toFixed(1)}%）· ${resetLabel('month')}`);
    }
    if (!clauses.length) return '';
    // 冷却：默认两次报数至少隔 `noticeCooldownMs`（0 = 每批都报）；"快到/已经超"不冷却。
    const st = this.state(agentKey, quota, at);
    const near = (v) => v.limit > 0 && v.left <= v.limit * NOTICE_URGENT;
    const cooldown = Math.max(0, n(quota.noticeCooldownMs, 0));
    const key = String(agentKey ?? '');
    const last = this.#noticeAt.get(key) ?? 0;
    if (cooldown > 0 && last && !st.exhausted && !near(st.day) && !near(st.month) && n(at) - last < cooldown) return '';
    this.#noticeAt.set(key, n(at));
    // 提醒模型自己收着用，不是硬禁令：额度该不该说、什么时候说，模型自己看场合（m14543）
    const hint = quota.noticeHint ? '（仅内部参考，不要轻易播报额度）' : '';
    return `[额度] ${where} ${clauses.join(' · ')}${hint}`;
  }

  /** `/quota` 的多行明细。 */
  describe(agentKey, quota, at = this.now()) {
    const where = String(agentKey ?? '').startsWith('private:') ? '本私聊' : '本群';
    const unitLabel = quota.unit === 'cost' ? `按钱（${quota.currency}）` : '按 token';
    if (!quotaConfigured(quota)) {
      return `${where}没配额度。要限的话，在 groups/privates 条目里加 quota（或配 agent.quota 做全局默认）：enabled:true + tokensPerDay/tokensPerMonth（或 costPerDay/costPerMonth）。`;
    }
    const { day, month } = this.usage(agentKey, at);
    const lines = [`${where}额度（${unitLabel}）`];
    const fmt = (value) => formatQuotaValue(value, quota);
    const dayLimit = quotaLimit(quota, 'day');
    if (dayLimit > 0) {
      const waived = this.waived(agentKey, 'day', localDayKey(at));
      const used = Math.max(0, quotaValue(day, quota) - waived);
      lines.push(`今日：已用 ${fmt(used)} / ${fmt(dayLimit)}（剩余 ${percentLeft(used, dayLimit).toFixed(1)}%），${resetLabel('day')}${waived > 0 ? `｜已解限 ${fmt(waived)}` : ''}`);
    }
    const monthLimit = quotaLimit(quota, 'month');
    if (monthLimit > 0) {
      const waived = this.waived(agentKey, 'month', localMonthKey(at));
      const used = Math.max(0, quotaValue(month, quota) - waived);
      lines.push(`本月：已用 ${fmt(used)} / ${fmt(monthLimit)}（剩余 ${percentLeft(used, monthLimit).toFixed(1)}%），${resetLabel('month')}${waived > 0 ? `｜已解限 ${fmt(waived)}` : ''}`);
    }
    if (day) lines.push(`原始计数：input ${Math.round(day.input)} · cache ${Math.round(day.cache)} · output ${Math.round(day.output)} · ${day.turns} 轮（今日）`);
    if (quota.unit === 'cost') {
      lines.push(`单价：input ${currencySymbol(quota.currency)}${quota.price.input}/百万 · cache ${currencySymbol(quota.currency)}${quota.price.cache}/百万 · output ${currencySymbol(quota.currency)}${quota.price.output}/百万`);
    }
    for (const w of this.waiversOf(agentKey, 2)) {
      const when = new Date(n(w.at)).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`解限记录：${w.by || '某人'} 于 ${when} 解 ${w.scope === 'month' ? '月' : '日'}额度 ${fmt(w.amount)}`);
    }
    return lines.join('\n');
  }

  /** 历史裁剪：日行留 90 天、月行留 24 个月，old waiver 一并丢。 */
  prune(at = this.now()) {
    const dayFloor = localDayKey(n(at) - KEEP_DAYS * 86400000);
    const monthFloor = localMonthKey(n(at) - KEEP_MONTHS * 31 * 86400000);
    for (const entry of this.#agents.values()) {
      for (const key of Object.keys(entry.days ?? {})) if (key < dayFloor) delete entry.days[key];
      for (const key of Object.keys(entry.months ?? {})) if (key < monthFloor) delete entry.months[key];
      entry.waivers = (entry.waivers ?? []).filter((w) => String(w?.key ?? '') >= (w?.scope === 'month' ? monthFloor : dayFloor));
    }
    this.#scheduleSave();
    return this;
  }

  get stats() {
    return { agents: this.#agents.size, file: QUOTA_FILE, storage: Boolean(this.storage?.enabled) };
  }
}
