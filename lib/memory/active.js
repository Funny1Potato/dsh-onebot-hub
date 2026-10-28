/**
 * 活跃层（`m17909`）：短期记忆不再记"事实"，只记**现在活着的事**——
 * 进行中的话题（`kind:'topic'`）与 agent 正在做的事（`kind:'task'`）。
 *
 * 与短期/长期记忆的三点区别，决定了它是独立一层而不是存储里的一个 kind：
 *  1. **写入只认来源会话**：条目带 `originScope`（建立它的会话），模型不能替别的群写。
 *  2. **可见性不看记忆隔离矩阵**：走"白名单 + 共同活跃群友"，见 `isActiveVisible`。
 *     群里的热闹可以同步给别的群，但"上周三谁跟谁吵架"不该跟着长期事实一起流动。
 *  3. **有生命周期**：`open` → 结算（`settle`）后从这一层消失。留下的东西去
 *     长期记忆（一行索引）/ 人物档案 / 群档案 / 话题归档，由结算时的 `keep_as` 决定。
 *
 * 落盘 `memory/active.json`；上限按**每个来源会话**算（`maxPerOrigin`），不按全局——
 * 一个群刷屏不该把另一个群正在做的事挤掉。
 */
import { isSensitive, levelForScope, resolveIsolation } from './isolation.js';
import { sessionAllowlistOff } from '../agent/policy.js';

export const ACTIVE_KINDS = ['topic', 'task'];
export const ACTIVE_KIND_LABELS = { topic: '进行中的话题', task: '我正在做的事' };
/** 一条活跃条目的正文上限（比记忆的 400 更紧：它每轮都进上下文）。 */
export const MAX_ACTIVE_TEXT = 200;
export const DEFAULT_ACTIVE_WINDOW_DAYS = 30;
export const DEFAULT_ACTIVE_INJECT_LIMIT = 8;
export const DEFAULT_ACTIVE_MAX_PER_ORIGIN = 20;
/** 开了这么久还没结算的，进「待结算」那一行（每天最多提一次）。 */
export const SETTLE_STALE_MS = 24 * 3600 * 1000;

let seq = 0;
function nextId() {
  seq += 1;
  return `a${seq.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function qqIds(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw ?? '').trim();
    if (/^\d{5,12}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 12);
}

/** 活跃层条目的一句话出处：`[群 55555]` / `[与 10001 的私聊]`。 */
export function activeLabel(scope) {
  const s = String(scope ?? '');
  if (s.startsWith('group:')) return `[群 ${s.slice(6)}]`;
  if (s.startsWith('private:')) return `[与 ${s.slice(8)} 的私聊]`;
  return `[${s || '未知会话'}]`;
}

/**
 * 活跃层存储。条目：`{id, kind, text, originScope, participants, status, startedAt, updatedAt, settledAs}`。
 *
 * `updatedAt` = **最后一次被提到的时间**（正文改了，或者又提了同一句）；它只喂给两处：
 * 活跃窗口（多久没人提就淡出）和「待结算」的判断。**它不进正文、也不参与排序**，
 * 所以它动一动不会把屏幕上的序号顶掉（序号稳定性见 `sortActive`）。
 */
export class ActiveStore {
  #entries = [];
  #byId = new Map();

  constructor({ storage = null, log = () => {}, file = 'memory/active.json', maxPerOrigin = DEFAULT_ACTIVE_MAX_PER_ORIGIN } = {}) {
    this.storage = storage;
    this.log = log;
    this.file = file;
    this.maxPerOrigin = maxPerOrigin;
    this.loaded = 0;
    const data = this.storage?.read?.(this.file, null);
    if (data && Array.isArray(data.entries)) {
      for (const raw of data.entries) this.#hydrate(raw);
      this.loaded = this.#entries.length;
      seq += this.loaded;
    }
  }

  get stats() {
    const open = this.#entries.filter((e) => e.status === 'open');
    const origins = new Set(open.map((e) => e.originScope));
    return {
      total: this.#entries.length,
      open: open.length,
      origins: origins.size,
      persistent: Boolean(this.storage?.enabled),
      file: this.storage?.enabled ? this.storage.path(this.file) : null,
      loaded: this.loaded,
    };
  }

  toJSON() {
    return { version: 1, savedAt: Date.now(), entries: this.#entries.map((e) => ({ ...e })) };
  }

  #hydrate(raw) {
    if (!raw || !raw.id || typeof raw.text !== 'string') return false;
    const id = String(raw.id);
    if (this.#byId.has(id)) return false;
    const kind = ACTIVE_KINDS.includes(raw.kind) ? raw.kind : 'topic';
    const rec = {
      id,
      kind,
      text: clip(raw.text, MAX_ACTIVE_TEXT),
      originScope: String(raw.originScope ?? ''),
      participants: qqIds(raw.participants),
      status: raw.status === 'open' ? 'open' : 'settled',
      startedAt: Number(raw.startedAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.startedAt) || Date.now(),
      settledAs: raw.settledAs ?? null,
      ...(raw.sensitive === true ? { sensitive: true } : {}),
    };
    if (!rec.text || !rec.originScope) return false;
    this.#entries.push(rec);
    this.#byId.set(rec.id, rec);
    return true;
  }

  #persist() {
    try {
      this.storage?.schedule?.(this.file, () => this.toJSON());
    } catch (err) {
      this.log(`[active] 落盘排队失败：${err?.message ?? err}`);
    }
  }

  all() {
    return this.#entries.map((e) => ({ ...e }));
  }

  byId(id) {
    const rec = this.#byId.get(String(id));
    return rec ? { ...rec } : null;
  }

  /** 某个来源会话还开着的条目（老的在前，注入时再按需倒序）。 */
  openByOrigin(originScope) {
    return this.#entries.filter((e) => e.status === 'open' && e.originScope === originScope).map((e) => ({ ...e }));
  }

  /**
   * 加一条。`originScope` 必须是**当前会话**（调用方保证），这里的 `maxPerOrigin`
   * 只防跑偏（模型忘记结算就一路 add），不代替结算：超了淘汰该来源最旧的那条。
   */
  add({ kind, text, originScope, participants = [], sensitive = false } = {}, at = Date.now()) {
    const now = Number(at) || Date.now();
    const origin = String(originScope ?? '');
    const body = clip(text, MAX_ACTIVE_TEXT);
    if (!origin) return { ok: false, reason: 'active:no-origin' };
    if (!body) return { ok: false, reason: 'active:empty-text' };
    const k = ACTIVE_KINDS.includes(kind) ? kind : 'topic';
    // 同一来源里"同一件事"只留一条（模型常常隔几句又 add 一次同一话题）。
    const dup = this.#entries.find((e) => e.status === 'open' && e.originScope === origin && e.text === body);
    if (dup) {
      // 同一件事被再提一次＝它还在进行，这里**刷新** `updatedAt`（30 天窗口与「待结算」）——
      // 这是整层唯一的心跳，且只在模型主动重申时发生；改正文/结算不会顺手续命。
      // `sortActive` 只按种类排、组内保持加入顺序，所以刷新不会让序号漂移。
      dup.updatedAt = now;
      dup.participants = qqIds([...dup.participants, ...participants]);
      this.#persist();
      return { ok: true, entry: { ...dup }, deduped: true };
    }
    const rec = {
      id: nextId(),
      kind: k,
      text: body,
      originScope: origin,
      participants: qqIds(participants),
      status: 'open',
      startedAt: now,
      updatedAt: now,
      settledAs: null,
      ...(sensitive === true ? { sensitive: true } : {}),
    };
    this.#entries.push(rec);
    this.#byId.set(rec.id, rec);
    const mine = this.#entries.filter((e) => e.status === 'open' && e.originScope === origin);
    if (mine.length > this.maxPerOrigin) {
      const oldest = mine.slice(0, mine.length - this.maxPerOrigin);
      for (const e of oldest) this.remove(e.id);
    }
    this.#persist();
    return { ok: true, entry: { ...rec } };
  }

  /** 改正文（序号指向注入列表里的下标由调用方换算成 id）。 */
  update(id, { text, participants } = {}, at = Date.now()) {
    const now = Number(at) || Date.now();
    const rec = this.#byId.get(String(id));
    if (!rec) return { ok: false, reason: 'active:not-found' };
    const body = clip(text, MAX_ACTIVE_TEXT);
    let changed = false;
    if (body && body !== rec.text) {
      rec.text = body;
      changed = true;
    }
    if (Array.isArray(participants)) {
      const next = qqIds(participants);
      if (next.join(',') !== (rec.participants ?? []).join(',')) {
        rec.participants = next;
        changed = true;
      }
    }
    // 只有真改了才动 updatedAt（`m21098` 自审）：它是"多久没人再提起"的计时器，
    // 顺手摸一下就续命的话，30 天窗口和「待结算」提醒都会失效。
    if (!changed) return { ok: true, entry: { ...rec }, unchanged: true };
    rec.updatedAt = now;
    this.#persist();
    return { ok: true, entry: { ...rec } };
  }

  remove(id) {
    const key = String(id);
    const rec = this.#byId.get(key);
    if (!rec) return false;
    this.#byId.delete(key);
    const at = this.#entries.indexOf(rec);
    if (at >= 0) this.#entries.splice(at, 1);
    this.#persist();
    return true;
  }

  clear() {
    this.#entries = [];
    this.#byId.clear();
    this.#persist();
  }
}

/**
 * 共享判据要用的只读上下文。
 *
 * - `whitelist`：`agent.groups` ∪ `agent.privates` 解析出来的 scope 集合（`group:1`/`private:2`），
 *   传 `null` 表示**名单功能没启用**（两张都没配），此时不限。
 * - `commonActive(origin, target)`：两个群有没有共同活跃群友。
 * - `activeInGroup(userId, scope)`：这个人是不是那个群的活跃成员（私聊目标用）。
 *
 * 判据两步（`m17909`）：①候选＝persons 里两边都见过的人 ∪ 两边新鲜成员表交集；
 * ②过滤僵尸＝候选中须有人在窗口内于**来源群**真的露过面——只出现在名单里、
 * 从没说过话的人不算活跃。取不到任何证据 → fail-closed，宁可不共享。
 */
export function buildShareContext({
  persons = [],
  groupOf = () => null,
  groupMembers = () => null,
  whitelist = null,
  windowDays = DEFAULT_ACTIVE_WINDOW_DAYS,
  now = Date.now(),
} = {}) {
  const days = Number(windowDays);
  const windowMs = Number.isFinite(days) && days > 0 ? days * 86400 * 1000 : 0;
  const since = windowMs ? now - windowMs : 0;
  const byId = new Map();
  for (const p of Array.isArray(persons) ? persons : []) {
    if (p?.userId) byId.set(String(p.userId), p);
  }
  const lastSeen = (person, scope) => {
    const at = Number(person?.groups?.[scope]?.lastSentAt ?? 0);
    return Number.isFinite(at) ? at : 0;
  };
  /** 名单里/名单外还活着的证据：person 档案的 lastSentAt，或群档案 activeMembers 的 lastSentAt。 */
  const aliveIn = (userId, scope) => {
    const id = String(userId);
    const person = byId.get(id);
    // `lastSentAt` 缺失 = 0 = 从没露过面：窗口关掉（days=0）时也不能算活跃。
    const seen = person ? lastSeen(person, scope) : 0;
    if (seen > 0 && seen >= since) return true;
    const group = groupOf(scope);
    const member = (group?.activeMembers ?? []).find((m) => String(m?.user_id ?? '') === id);
    const memberAt = Number(member?.lastSentAt ?? 0);
    if (memberAt > 0 && memberAt >= since) return true;
    return false;
  };
  const commonActive = (origin, target) => {
    const ids = new Set();
    for (const p of byId.values()) {
      if (p.groups?.[origin] && p.groups?.[target]) ids.add(String(p.userId));
    }
    const a = groupMembers(origin);
    const b = groupMembers(target);
    if (a?.complete && b?.complete) {
      for (const id of a.ids) if (b.ids.has(id)) ids.add(String(id));
    }
    for (const id of ids) if (aliveIn(id, origin)) return true;
    return false;
  };
  const activeInGroup = (userId, scope) => aliveIn(userId, scope);
  return { whitelist, windowMs, since, commonActive, activeInGroup };
}

/**
 * 活跃层可见性。**不是**记忆那套隔离矩阵，单独一套（群档案不进共享、不套 crossGroupFacts）：
 *
 *  | 档位 | 群来源条目 | 私聊来源条目 |
 *  | strict | 只来源会话 | 只本私聊 |
 *  | scoped | 只来源群 | 按 privateFacts |
 *  | balanced | 白名单内 + 至少 1 个共同活跃群友 | 按 privateFacts |
 *  | open | 白名单内全共享 | 按 privateFacts |
 *
 * 敏感条目任何档位都只在本会话；任何档位先被白名单卡住（`share.whitelist` 为 null 时不限）。
 */
export function isActiveVisible(entry, ctx = {}) {
  const sessionKey = String(ctx.sessionKey ?? '');
  const origin = String(entry?.originScope ?? '');
  if (!origin) return { ok: false, reason: 'active:no-origin' };
  if (origin === sessionKey) return { ok: true, reason: 'same-scope' };
  // 敏感条目永远不出本会话：词表命中，或模型自己标了 sensitive:true（跟长期记忆同一个口径）。
  if (entry?.sensitive === true || isSensitive({ text: entry?.text })) return { ok: false, reason: 'sensitive:always-local' };
  const iso = ctx.isolation ?? resolveIsolation({});
  const lim = levelForScope(iso, { sessionKey, worldKey: ctx.worldKey, scope: origin });
  if (lim.level === 'strict') return { ok: false, reason: 'level:strict' };
  const share = ctx.share ?? null;
  if (share?.whitelist && !(share.whitelist.has(origin) && share.whitelist.has(sessionKey))) {
    return { ok: false, reason: 'not-in-whitelist' };
  }
  if (origin.startsWith('private:')) {
    // 私聊来源怎么走由 privateFacts 定，跟 level 无关（strict 上面已经拦掉了）。
    const peer = origin.slice('private:'.length);
    if (lim.privateFacts === 'all') return { ok: true, reason: 'privateFacts:all' };
    if (lim.privateFacts === 'sameActor' && sessionKey === `private:${peer}`) return { ok: true, reason: 'privateFacts:sameActor' };
    return { ok: false, reason: 'privateFacts:never' };
  }
  if (lim.level === 'scoped') return { ok: false, reason: 'level:scoped' };
  if (lim.level === 'open') return { ok: true, reason: 'level:open' };
  // balanced：两个群之间得有人既在那边又在这边，而且是真的还在说话的人。
  if (!share) return { ok: false, reason: 'balanced:no-share-context' };
  if (sessionKey.startsWith('private:')) {
    const peer = sessionKey.slice('private:'.length);
    return share.activeInGroup(peer, origin)
      ? { ok: true, reason: 'balanced:private-peer-active' }
      : { ok: false, reason: 'balanced:no-common-member' };
  }
  return share.commonActive(origin, sessionKey)
    ? { ok: true, reason: 'balanced:common-active' }
    : { ok: false, reason: 'balanced:no-common-member' };
}

/**
 * 活跃层的显示顺序：**种类优先（话题在前、任务在后），组内保持加入顺序**。
 *
 * 为什么不用"新的在前"：模型是照着**屏幕上的序号**写 `update`/`settle` 的，
 * 排序一旦随内容变动，前后的号会集体漂移，模型就会改错条目、结算错事。
 * 加入顺序稳得多——同一类里新增只能往后排，改正文完全不换位；
 * 只有结算/删除才会让后面的号前移（所以每次写完，回执里都回一份**新序号**给模型）。
 */
export function sortActive(entries = []) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort((a, b) => {
    const da = ACTIVE_KINDS.indexOf(a?.kind);
    const db = ACTIVE_KINDS.indexOf(b?.kind);
    if (da !== db) return (da < 0 ? ACTIVE_KINDS.length : da) - (db < 0 ? ACTIVE_KINDS.length : db);
    return 0;
  });
  return list;
}

/** 过滤出本会话能看见的 open 条目（顺带把过期的丢掉）。 */
export function filterActive(entries = [], ctx = {}) {
  const now = ctx.now ?? Date.now();
  const days = Number(ctx.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS);
  const windowMs = Number.isFinite(days) && days > 0 ? days * 86400 * 1000 : 0;
  const visible = [];
  const denied = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.status !== 'open') continue;
    // 过期也记一笔，免得"条目怎么不见了"查不出来。
    if (windowMs && now - Number(entry.updatedAt ?? entry.startedAt ?? 0) > windowMs) {
      denied.push({ id: entry.id, originScope: entry.originScope, reason: 'window:expired' });
      continue;
    }
    const verdict = isActiveVisible(entry, ctx);
    if (verdict.ok) visible.push(entry);
    else denied.push({ id: entry.id, originScope: entry.originScope, reason: verdict.reason });
  }
  // 序号按这个顺序连续编，与 `renderActive` 的显示顺序完全一致——
  // 模型照着屏幕上的号引用才不会串行。
  return { visible: sortActive(visible), denied };
}

/**
 * 共享白名单：`agent.groups` ∪ `agent.privates` 的 scope 集合（`group:55555` / `private:10001`）。
 *
 * 两张名单**都没配置**时返回 `null`＝名单功能未启用、不做限制（与 `sessionOverrideOf` 同口径）；
 * 只配了一张也照常生效——配了就是"只在这些会话之间共享"。
 */
export function activeWhitelist(config = null) {
  // 官方上游下会话白名单整个不生效（`m34897`）：这里也得跟着退，否则"本地配了一堆群"
  // 会让活跃层只剩那几个群之间共享——而官方那边根本收不到它们。
  //
  // 但"不生效"不等于"全放开"（`m35008` 用户定案：默认不共享，留开关）。返回**空集**表示
  // 谁都别跨过来：`isActiveVisible` 判同会话时早退放行，所以活跃条目仍然在自己那个群里
  // 看得见，只是一条都不往外走。要跨群共享就把 `official.crossShare` 打开（那时返回 null
  // ＝名单未启用、不做限制）。
  if (sessionAllowlistOff(config)) {
    return config?.official?.crossShare === true ? null : new Set();
  }
  const groups = config?.agentGroups;
  const privates = config?.agentPrivates;
  if (!groups && !privates) return null;
  const set = new Set();
  for (const id of Object.keys(groups ?? {})) set.add(`group:${id}`);
  for (const id of Object.keys(privates ?? {})) set.add(`private:${id}`);
  return set;
}

/**
 * 渲染三段。序号**跨「进行中的话题」「我正在做的事」连续编号**（0 起），
 * 因为 `update`/`settle` 都按这个序号引用；「待结算」只是同一批条目的一个提醒，
 * 不重新编号，但**把号带上**，模型能直接照着号去结算。
 */
export function renderActive(entries = [], { limit = DEFAULT_ACTIVE_INJECT_LIMIT, settle = false, now = Date.now(), hidden = 0 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, Math.max(0, Number(limit) || 0));
  if (!list.length) return '';
  const lines = [];
  const stale = [];
  let lastKind = null;
  // 一次遍历：换种类时插小标题，序号取条目在 `list` 里的下标——模型看到的号就是它要写的下标。
  list.forEach((entry, i) => {
    if (entry.kind !== lastKind) {
      lastKind = entry.kind;
      lines.push(`【${ACTIVE_KIND_LABELS[entry.kind] ?? '进行中'}】`);
    }
    lines.push(`${i}. ${activeLabel(entry.originScope)} ${entry.text}`);
    // 「超过一天没人提」= 多久没人再提起它（不是它开了多久）——长跑的任务不该天天被催。
    const touched = Number(entry.updatedAt ?? entry.startedAt ?? 0);
    if (touched > 0 && now - touched >= SETTLE_STALE_MS) stale.push(i);
  });
  if (settle && stale.length) {
    lines.push('【待结算】');
    lines.push(`${stale.join('、')} 号超过一天没人提了，还没有结算。`);
  }
  // 被条数上限挤出视野的那些（`m21098` 自审）：不说一句，模型会以为活跃层只有这几条，
  // 而挤掉的那些既看不见、也没法结算（序号只覆盖看得见的）。
  const extra = Math.max(0, Number(hidden) || 0);
  if (extra) lines.push(`（还有 ${extra} 条没显示出来；结算掉前面这些，后面就会露出来。）`);
  return lines.join('\n');
}
