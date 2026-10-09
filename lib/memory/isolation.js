/**
 * 记忆隔离：分级开关（§24.5）。
 *
 * 一条不可让步的约束：**写入永远全量，隔离只作用于"装配与检索"**。
 * 因此本模块是纯函数集合——给一批记忆条目和当前会话，返回"这一轮能看见哪些、各自依据哪条规则"。
 * 级别随时可调：调严不丢历史，调松立即生效。
 */

import { isGlobMatch } from '../virtual-world.js';

export const ISOLATION_LEVELS = ['strict', 'scoped', 'balanced', 'open'];
export const CROSS_GROUP_FACTS = ['never', 'shareable', 'all'];
export const PRIVATE_FACTS = ['never', 'sameActor', 'all'];

export const DEFAULT_ISOLATION = {
  level: 'scoped',
  crossGroupIdentity: true,
  crossGroupFacts: 'shareable',
  privateFacts: 'never',
  sensitivityAlwaysLocal: true,
  overrides: [],
  trustedGroups: [],
  recallEscape: false,
  recallEscapeNeedsApproval: true,
  audit: true,
  auditRetain: 200,
};

/** 敏感度兜底词表：属于"事故"类兜底（§23.5 的分界），不是风格判断。 */
const SENSITIVE_PATTERNS = [
  /住址|家庭地址|地址是|租房|房东/,
  /身份证|护照号|银行卡|信用卡|支付密码|验证码/,
  /工资|月薪|年薪|收入|存款|欠款|贷款/,
  /病历|诊断|抑郁|焦虑症|住院|手术|怀孕/,
  /离婚|分居|家里出事/,
];

export function resolveIsolation(raw = {}) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  let level = src.level;
  if (level === undefined || level === null || level === '') level = DEFAULT_ISOLATION.level;
  if (!ISOLATION_LEVELS.includes(level)) {
    warnings.push(`未知的 memory.isolation.level=${level}，回退 ${DEFAULT_ISOLATION.level}`);
    level = DEFAULT_ISOLATION.level;
  }
  if (level === 'open') warnings.push('memory.isolation.level=open：私聊内容会进入群聊上下文，仅用于测试/单人自用');

  const pick = (value, allowed, fallback, name) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!allowed.includes(value)) {
      warnings.push(`memory.isolation.${name}=${value} 非法，回退 ${fallback}`);
      return fallback;
    }
    return value;
  };

  return {
    level,
    crossGroupIdentity: src.crossGroupIdentity === undefined ? DEFAULT_ISOLATION.crossGroupIdentity : Boolean(src.crossGroupIdentity),
    crossGroupFacts: pick(src.crossGroupFacts, CROSS_GROUP_FACTS, DEFAULT_ISOLATION.crossGroupFacts, 'crossGroupFacts'),
    privateFacts: pick(src.privateFacts, PRIVATE_FACTS, DEFAULT_ISOLATION.privateFacts, 'privateFacts'),
    sensitivityAlwaysLocal:
      src.sensitivityAlwaysLocal === undefined ? DEFAULT_ISOLATION.sensitivityAlwaysLocal : Boolean(src.sensitivityAlwaysLocal),
    overrides: Array.isArray(src.overrides) ? src.overrides.filter((o) => o && typeof o === 'object' && o.match) : [],
    trustedGroups: Array.isArray(src.trustedGroups)
      ? src.trustedGroups.filter((g) => Array.isArray(g) && g.length > 1).map((g) => g.map(String))
      : [],
    recallEscape: Boolean(src.recallEscape),
    recallEscapeNeedsApproval:
      src.recallEscapeNeedsApproval === undefined ? DEFAULT_ISOLATION.recallEscapeNeedsApproval : Boolean(src.recallEscapeNeedsApproval),
    audit: src.audit === undefined ? DEFAULT_ISOLATION.audit : Boolean(src.audit),
    auditRetain: Number.isFinite(src.auditRetain) && src.auditRetain > 0 ? Math.floor(src.auditRetain) : DEFAULT_ISOLATION.auditRetain,
    warnings,
  };
}

/** 这条记忆天然属于哪个 scope（写入侧推断，模型不能自行升格，§24.11 硬边界）。 */
export function inferScope({ sessionKey, worldKey, actorId } = {}) {
  if (sessionKey && String(sessionKey).startsWith('group:')) return String(sessionKey);
  if (sessionKey && String(sessionKey).startsWith('private:')) return String(sessionKey);
  if (actorId !== undefined && actorId !== null) return `private:${actorId}`;
  return worldKey ? String(worldKey) : 'unknown';
}

/** 默认可见性：私聊＝private，群内＝group:<gid>；只有"当事人在公开群里说过"才允许标 shareable。 */
export function inferVisibility(entry, { sessionKey } = {}) {
  if (entry?.visibility) return entry.visibility;
  const scope = String(entry?.scope ?? sessionKey ?? '');
  if (scope.startsWith('group:')) return scope;
  return 'private';
}

export function isSensitive(entry) {
  if (!entry) return false;
  if (entry.sensitive === true) return true;
  if (entry.sensitivity === 'sensitive') return true;
  const text = String(entry.text ?? '');
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

/** 覆盖解析：overrides → trustedGroups → level 预设（§24.5 第 6 条判定顺序）。 */
export function levelForScope(iso, { sessionKey, worldKey, scope } = {}) {
  const targets = [sessionKey, worldKey, scope].filter(Boolean).map(String);
  let level = iso.level;
  let facts = iso.crossGroupFacts;
  let identity = iso.crossGroupIdentity;
  let priv = iso.privateFacts;
  const reasons = [`level:${level}`];

  for (const group of iso.trustedGroups) {
    const hit = targets.some((t) => group.includes(t));
    const entryInGroup = scope !== undefined && group.includes(String(scope));
    if (hit && (entryInGroup || targets.length > 0)) {
      const rank = (v) => (v === 'balanced' ? 2 : 0);
      if (level === 'strict' && rank('balanced') > rank(level)) {
        level = 'balanced';
        reasons.push('trustedGroups');
      }
    }
  }

  for (const o of iso.overrides) {
    if (!targets.some((t) => isGlobMatch(o.match, t))) continue;
    if (o.level && ISOLATION_LEVELS.includes(o.level)) {
      level = o.level;
      reasons.push(`override:${o.match}:level=${o.level}`);
    }
    if (o.crossGroupFacts && CROSS_GROUP_FACTS.includes(o.crossGroupFacts)) facts = o.crossGroupFacts;
    if (o.privateFacts && PRIVATE_FACTS.includes(o.privateFacts)) priv = o.privateFacts;
    if (o.crossGroupIdentity !== undefined) identity = Boolean(o.crossGroupIdentity);
  }

  return { level, facts, identity, privateFacts: priv, reasons };
}

/**
 * 单条记忆是否可见。
 * @param {object} entry 记忆条目 { id, kind, scope, worldKey, visibility, sensitive, actor, text }
 * @param {{sessionKey:string, worldKey?:string, actorId?:any, isolation:object}} ctx
 */
export function isVisible(entry, ctx) {
  const iso = ctx.isolation ?? resolveIsolation({});
  const entryScope = String(entry?.scope ?? '');
  const sessionKey = String(ctx.sessionKey ?? '');
  const worldKey = String(ctx.worldKey ?? '');

  if (entryScope && entryScope === sessionKey) return { ok: true, reason: 'same-scope' };
  if (entryScope && worldKey && entryScope === worldKey) return { ok: true, reason: 'same-world' };
  if (!entryScope && entry?.worldKey && String(entry.worldKey) === worldKey) return { ok: true, reason: 'same-world' };

  const lim = levelForScope(iso, { sessionKey, worldKey, scope: entryScope });
  const local = { ...iso, level: lim.level, crossGroupFacts: lim.facts, crossGroupIdentity: lim.identity, privateFacts: lim.privateFacts };

  if (isSensitive(entry) && local.sensitivityAlwaysLocal) return { ok: false, reason: 'sensitive:always-local', level: local.level };
  if (local.level === 'strict') return { ok: false, reason: 'level:strict', level: local.level };

  const kind = entry?.kind ?? 'fact';
  if (kind === 'identity') {
    return { ok: local.crossGroupIdentity, reason: local.crossGroupIdentity ? 'crossGroupIdentity' : 'crossGroupIdentity:off', level: local.level };
  }

  const visibility = inferVisibility(entry, { sessionKey: entryScope });

  // 私聊里的事实：级别不放开时一律不可见（§24.5 第 4 条）。
  if (visibility === 'private' || visibility.startsWith('private')) {
    if (local.privateFacts === 'all') return { ok: true, reason: 'privateFacts:all', level: local.level };
    if (
      local.privateFacts === 'sameActor' &&
      sessionKey.startsWith('private:') &&
      entry?.actor?.user_id !== undefined &&
      String(entry.actor.user_id) === sessionKey.slice('private:'.length)
    ) {
      return { ok: true, reason: 'privateFacts:sameActor', level: local.level };
    }
    return { ok: false, reason: 'privateFacts:never', level: local.level };
  }

  const override = lim.reasons.find((r) => r.startsWith('override') || r === 'trustedGroups');

  // 当事人在公开场合说过、允许跨会话复用的事实。
  if (visibility === 'shareable') {
    if (local.crossGroupFacts === 'never') return { ok: false, reason: 'crossGroupFacts:never', level: local.level };
    if (local.level === 'balanced' || local.level === 'open') {
      return { ok: true, reason: override ? `${override}|shareable` : 'crossGroupFacts:shareable', level: local.level };
    }
    // scoped：只放身份，不放别人的事
    return { ok: false, reason: `level:${local.level}`, level: local.level };
  }

  // 群内事实（visibility = group:<gid>）：只有 balanced+ 且显式要求 all 才跨群可见。
  if (local.level === 'open') return { ok: true, reason: 'level:open', level: local.level };
  if (local.level === 'balanced' && local.crossGroupFacts === 'all') {
    return { ok: true, reason: 'crossGroupFacts:all', level: local.level };
  }
  return { ok: false, reason: 'scope:not-visible', level: local.level };
}

/**
 * 装配前的过滤：返回可见条目 + 被拒明细（审计用）。
 * 这是**唯一可靠**的做法——prompt 永远只收到已过滤的结果（§24.5 第 6 条）。
 */
export function filterForScope(entries = [], { sessionKey, worldKey, actorId, isolation } = {}) {
  const iso = isolation ?? resolveIsolation({});
  const visible = [];
  const denied = [];
  const audit = [];
  for (const entry of entries) {
    const verdict = isVisible(entry, { sessionKey, worldKey, actorId, isolation: iso });
    if (verdict.ok) {
      visible.push(entry);
      const crossScope = String(entry?.scope ?? '') !== String(sessionKey ?? '') && String(entry?.scope ?? '') !== String(worldKey ?? '');
      if (iso.audit && crossScope) {
        audit.push({ id: entry.id, kind: entry.kind ?? 'fact', scope: entry.scope ?? null, reason: verdict.reason, level: verdict.level ?? iso.level });
      }
    } else {
      denied.push({ id: entry.id, scope: entry.scope ?? null, reason: verdict.reason });
    }
  }
  return { visible, denied, audit };
}

/** 检索工具的越界裁决（§24.5 第 4 条）。 */
export function resolveRecallScope({ requested = 'visible', isolation } = {}) {
  const iso = isolation ?? resolveIsolation({});
  if (requested === 'all' && !iso.recallEscape) {
    return { scope: 'visible', escaped: false, needsApproval: false, note: 'memory.isolation.recallEscape=false，已降级为当前可见范围' };
  }
  if (requested === 'all') {
    return { scope: 'all', escaped: true, needsApproval: iso.recallEscapeNeedsApproval, note: '越界检索：本次检索范围超过当前会话可见性' };
  }
  return { scope: 'visible', escaped: false, needsApproval: false, note: null };
}

export function describeIsolation(iso) {
  const base = iso ?? resolveIsolation({});
  const lines = [
    `级别 ${base.level}｜身份跨群 ${base.crossGroupIdentity ? '开' : '关'}｜跨群事实 ${base.crossGroupFacts}｜私聊内容 ${base.privateFacts}｜敏感一票否决 ${base.sensitivityAlwaysLocal ? '开' : '关'}`,
  ];
  if (base.overrides.length) lines.push(`覆盖 ${base.overrides.length} 条：${base.overrides.map((o) => o.match).join(', ')}`);
  if (base.trustedGroups.length) lines.push(`同世界群组 ${base.trustedGroups.length} 组`);
  if (base.level === 'open') lines.push('⚠️ level=open');
  return lines.join('\n');
}

/** 审计账本：回答"这一轮到底看见了哪些跨 scope 记忆、依据什么放行"。 */
export class IsolationAudit {
  #records = [];
  #limit;

  constructor({ limit = 200 } = {}) {
    this.#limit = limit;
  }

  get stats() {
    return { retained: this.#records.length, total: this.#records.length };
  }

  add(record) {
    const rec = { ts: Date.now(), ...record };
    this.#records.push(rec);
    if (this.#records.length > this.#limit) this.#records.splice(0, this.#records.length - this.#limit);
    return rec;
  }

  list({ limit = 20, sessionKey } = {}) {
    return this.#records
      .filter((r) => (sessionKey === undefined || r.sessionKey === sessionKey))
      .slice(-limit);
  }

  clear() {
    this.#records = [];
  }
}
