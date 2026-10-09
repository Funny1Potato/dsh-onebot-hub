/**
 * M7 用法学习：Downstream Capability Map（方案 §17.1–§17.5）。
 *
 * 这一层回答的是"**下游这个 bot 到底会吃什么消息**"。它只做两件事：
 *  1. **机械事实**（本文件的前半段，纯函数）：从 L1′ 的 turn（M6）里抠触发形状、
 *     统计前缀频次、生成候选；这些都不掺 LLM，可复核、可重放。
 *  2. **知识库**（`CapabilityMap`）：把候选项按 id 累积证据，够阈值才升 active；
 *     连续未复现先标 stale 降置信，**不是直接删**（§17.2④）。
 *
 * 分工（§17.5）：是不是命令、怎么用、参数怎么写，这些语义判断由 agent 做，
 * 通过 `onebot_capabilities` 写回来；hub 只负责把客观事实摆好。
 * 所以本文件**不发任何消息**——学习过程静默（§17.2⑤）。
 *
 * 落盘：并入 `capabilities/<linkId>.json` 的 `commands` 字段（§17.1 指定的位置）。
 */

/** 前缀候选集（§17.2②）。比读下游 `COMMAND_START` 鲁棒：配置可能是空数组或多前缀。 */
export const COMMON_PREFIXES = ['/', '!', '.', '#', '／', '。', '！'];
/** 观测次数达到它就 candidate → active（§17.2④，对应 master 的 AIGFM_LEARN_MIN_CONFIDENCE）。 */
export const DEFAULT_THRESHOLD = 3;
/** 连续未复现多少次先标 stale（降置信，不删）。 */
export const DEFAULT_STALE_AFTER = 3;
/** 连续未复现多少次才真的删除（独立计数，§17.7 的 delete_confidence 同义）。 */
export const DEFAULT_FORGET_AFTER = 6;
/** 每条能力最多留多少条证据消息 id（只是往回找的线索，不是全集）。 */
export const DEFAULT_MAX_EVIDENCE = 20;

/** 首个非空白字符（没有就返回 `''`）。 */
export function firstChar(text) {
  const s = String(text ?? '');
  for (const ch of s) {
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

/** 触发文本的第一个"词"（中文不算空格，所以只在标点/空白处切）。 */
export function firstToken(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^([^\s，,。；;：:！!？?、]+)/);
  return m ? m[1] : '';
}

/**
 * 拆出前缀 / 命令名 / 其余参数。
 * 没有前缀也返回（`prefix: ''`），因为"纯文本精确命令"（如 `今日小猪`）同样常见（§17.3）。
 */
export function splitCommand(text, { prefixes = COMMON_PREFIXES } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const head = raw[0];
  let prefix = '';
  let body = raw;
  if (prefixes.includes(head)) {
    prefix = head;
    body = raw.slice(head.length).trim();
  }
  if (!body) return null;
  const m = body.match(/^([^\s，,。；;：:！!？?、]+)\s*([\s\S]*)$/);
  return {
    prefix,
    name: m ? m[1] : body,
    rest: m ? String(m[2] ?? '').trim() : '',
    raw,
  };
}

/** 触发事件的段数组（`payload.message` 是原样搬运的 OneBot 段，转发保真那条线的产物）。 */
export function segmentsOfTrigger(trigger) {
  const segs = trigger?.payload?.message ?? trigger?.message ?? null;
  return Array.isArray(segs) ? segs : [];
}

/** 触发形状：比命令名更值钱（§17.3）。 */
export function shapeOf(trigger) {
  const segs = segmentsOfTrigger(trigger);
  const has = (type) => segs.some((s) => s?.type === type);
  return {
    at: has('at'),
    reply: has('reply'),
    image: has('image'),
    media: segs.some((s) => s?.type === 'image' || s?.type === 'record' || s?.type === 'video' || s?.type === 'file'),
    text: segs
      .filter((s) => s?.type === 'text')
      .map((s) => String(s?.data?.text ?? ''))
      .join(''),
  };
}

/**
 * 前缀推断（§17.2②，hub 独有）：只看**真的被响应过**的那些 turn，
 * 统计触发消息首个非空字符落在候选集里的频次。频次最高的就是这套下游的 prefix。
 */
export function inferPrefixes(turns, { prefixCandidates = COMMON_PREFIXES, limit = 8 } = {}) {
  const counts = new Map();
  for (const turn of turns ?? []) {
    if (!turn?.outcomes?.length) continue;
    const ch = firstChar(turn.trigger?.text ?? '');
    if (!prefixCandidates.includes(ch)) continue;
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || (a.prefix < b.prefix ? -1 : 1))
    .slice(0, limit);
}

/** 能力 id：`<linkId>#<kind>:<小写名字>`，同一个下游同一个用法只落一条。 */
export function capabilityId(linkId, kind, name) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 64);
  return `${linkId || 'hub'}#${kind}:${slug}`;
}

/**
 * 一个被响应过的 turn → 能力候选。**只有机械判断，不做语义判断**：
 * 前缀命令 / 带 @ / 需回复 / 其余按关键词记（`on_keyword`、`on_message` 这类只能靠观测，§17.3）。
 * @returns {null|{kind:string,name:string,prefix:string,args:object,preconditions:object,shape:object,text:string}}
 */
export function candidateFromTurn(turn, { prefixes = COMMON_PREFIXES } = {}) {
  const trigger = turn?.trigger ?? null;
  if (!trigger) return null;
  const shape = shapeOf(trigger);
  const text = String(trigger.text ?? '').trim();
  const cmd = splitCommand(text, { prefixes });
  const preconditions = {};
  const args = {};
  let kind = '';
  let name = '';
  let prefix = '';

  if (cmd?.prefix) {
    kind = 'command';
    prefix = cmd.prefix;
    name = cmd.name;
    if (cmd.rest) args.text = cmd.rest;
  } else if (shape.at) {
    kind = 'at';
    name = cmd?.name || firstToken(shape.text) || firstToken(text);
  } else if (shape.reply) {
    kind = 'reply';
    name = cmd?.name || firstToken(shape.text) || firstToken(text);
  } else if (cmd?.name) {
    kind = 'keyword';
    name = cmd.name;
    if (cmd.rest) args.text = cmd.rest;
  } else {
    return null;
  }
  if (!name) return null;

  if (shape.at) {
    preconditions.needsAt = true;
    args.atTarget = '某人';
  }
  if (shape.reply) preconditions.needsReply = true;
  if (shape.media) args.hasMedia = true;

  return { kind, name, prefix, args, preconditions, shape, text };
}

/** 把 `args`/`preconditions` 渲染成一行给人（也是 agent 看的样子）。 */
export function renderArgs(rec) {
  const parts = [];
  if (rec?.prefix) parts.push(`${rec.prefix}${rec.name}`);
  else parts.push(String(rec?.name ?? ''));
  const params = renderParams(rec);
  if (params) parts.push(params);
  return parts.join(' ').trim();
}

/** 只渲染参数形态（不含命令名）：L3 注入时名字由装配层拼（它自己带前缀）。 */
export function renderParams(rec) {
  const parts = [];
  if (rec?.preconditions?.needsAt) parts.push('@某人');
  if (rec?.args?.text) parts.push(String(rec.args.text));
  if (rec?.preconditions?.needsReply) parts.push('（需回复它）');
  if (rec?.args?.hasMedia) parts.push('（带图/文件）');
  return parts.join(' ').trim();
}

/** 结果一行：用了哪些 action、大概多慢（延迟是"这命令要等多久"的证据）。 */
export function renderOutcome(rec) {
  const actions = rec?.outcome?.actions ?? [];
  if (!actions.length) return '';
  const ms = rec.outcome?.typicalLatencyMs;
  return `${actions.join('/')}${Number.isFinite(ms) ? ` ~${ms}ms` : ''}`;
}

/** §17.4/M7-③ 预测用：把名字与别名的比较统一成"去空白、小写"。 */
export function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 用一条已学到的用法去匹配一句消息（§10 `onebot_relay_probe` 的判定核）。
 * 纯函数、无副作用：只回答"按这条形状，这句话像不像它能吃的东西"。
 */
export function matchCapability(rec = {}, { text = '', hasAt = false, hasReply = false } = {}) {
  const raw = String(text ?? '');
  const body = raw.trim();
  const names = [rec.name, ...(rec.aliases ?? [])].filter(Boolean);
  const kind = rec.kind ?? 'command';
  const prefixOk = !rec.prefix || raw.startsWith(rec.prefix);
  const bare = prefixOk && rec.prefix ? raw.slice(String(rec.prefix).length) : raw;

  if (kind === 'keyword') {
    const hit = names.find((n) => body.includes(String(n)));
    return hit ? { score: 0.8, why: `正文里出现了关键词「${hit}」`, args: {} } : null;
  }
  if (kind === 'regex') {
    for (const n of names) {
      try {
        const m = new RegExp(String(n)).exec(body);
        if (m) return { score: 0.7, why: `正则 /${n}/ 命中`, args: m[1] ? { text: m[1] } : {} };
      } catch {
        // 学来的正则不合法就跳过，不能因为一条坏记录让预测崩掉。
      }
    }
    return null;
  }
  if (kind === 'message') return { score: 0.2, why: '这条用法声明了"任意消息都处理"，但用途只能靠观测', args: {} };

  // command / at / reply：先看前缀，再比对首个词（中文命令没有空白，按前缀匹配整句开头）。
  if (rec.prefix && !prefixOk) return null;
  const firstToken = bare.trim().split(/[\s:：,，]/)[0] ?? '';
  const exact = names.find((n) => normalizeName(n) === normalizeName(firstToken));
  const headHit = !exact ? names.find((n) => normalizeName(n) && normalizeName(bare).startsWith(normalizeName(n))) : null;
  const hit = exact ?? headHit;
  if (!hit) return null;
  if (kind === 'at' && !hasAt) return { score: 0.35, why: `命令「${hit}」对上了，但这条用法需要 @ 某人，而消息里没有 @`, args: {} };
  if (kind === 'reply' && !hasReply) return { score: 0.35, why: `命令「${hit}」对上了，但这条用法要先回复它，而消息不是回复`, args: {} };
  const rest = exact ? bare.trim().slice(firstToken.length).trim() : bare.trim().slice(String(hit).length).trim();
  return {
    score: 1,
    why: exact ? `命令名/别名精确命中「${hit}」` : `句首就是命令「${hit}」`,
    args: rest ? { text: rest } : {},
  };
}

/** 状态影响"有多可信"：active 是踩过的，candidate/stale 只能算猜。 */
export function statusFactor(status) {
  if (status === 'active') return 1;
  if (status === 'candidate') return 0.8;
  return 0.4;
}

/** 把预测结果渲染成一句人话（agent 先看结论，再看明细）。 */
export function renderPrediction(result = {}) {
  const { wouldTrigger, matches = [], text = '' } = result;
  if (!matches.length) return `「${text}」按现有用法表看不出会触发任何下游（表里没有对得上的形状）。`;
  const best = matches[0];
  return wouldTrigger
    ? `「${text}」很可能触发 ${best.linkId ?? ''} 的「${best.prefix}${best.name}」（${best.why}，证据 ${best.confidence} 次，状态 ${best.status}）。`
    : `「${text}」看起来像「${best.prefix}${best.name}」，但整体把握不足（${best.why}；状态 ${best.status}，证据 ${best.confidence} 次）——真发之前最好先确认。`;
}

function briefRec(rec) {
  return {
    id: rec.id,
    kind: rec.kind,
    name: rec.name,
    prefix: rec.prefix,
    aliases: [...(rec.aliases ?? [])],
    args: rec.args ?? {},
    preconditions: rec.preconditions ?? {},
    outcome: rec.outcome ?? {},
    confidence: rec.evidence?.observations ?? 0,
    status: rec.status,
    source: rec.source,
    evidence: { ...rec.evidence, messageIds: [...(rec.evidence?.messageIds ?? [])] },
    scope: { ...(rec.scope ?? {}) },
    notes: rec.notes ?? '',
    misses: rec.misses ?? 0,
    missStreak: rec.missStreak ?? 0,
    firstSeen: rec.evidence?.firstSeen ?? null,
    lastSeen: rec.evidence?.lastSeen ?? null,
  };
}

/**
 * Downstream Capability Map（§17.1）。
 * 形状对齐方案里的字段名：`{id, scope, kind, name, aliases, prefix, args, preconditions,
 * outcome, confidence, evidence, source, notes}`，额外几项是运行时要用的计数器。
 */
export class CapabilityMap {
  constructor({
    linkId = '',
    log,
    now = Date.now,
    threshold = DEFAULT_THRESHOLD,
    staleAfter = DEFAULT_STALE_AFTER,
    forgetAfter = DEFAULT_FORGET_AFTER,
    maxEvidence = DEFAULT_MAX_EVIDENCE,
    prefixCandidates = COMMON_PREFIXES,
    limit = 500,
    onChange = null,
  } = {}) {
    this.linkId = linkId;
    this.log = log;
    this.now = now;
    /** 表被改动时的回调（hub 用它触发防抖落盘）。 */
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.threshold = Math.max(1, Number(threshold) || DEFAULT_THRESHOLD);
    this.staleAfter = Math.max(1, Number(staleAfter) || DEFAULT_STALE_AFTER);
    this.forgetAfter = Math.max(this.staleAfter, Number(forgetAfter) || DEFAULT_FORGET_AFTER);
    this.maxEvidence = Math.max(1, Number(maxEvidence) || DEFAULT_MAX_EVIDENCE);
    this.prefixCandidates = Array.isArray(prefixCandidates) && prefixCandidates.length ? prefixCandidates : COMMON_PREFIXES;
    this.limit = Math.max(10, Number(limit) || 500);
    /** id → 记录。 */
    this.records = new Map();
    /** 前缀频次（只统计被响应过的触发）。 */
    this.prefixCounts = new Map();
    this.stats = {
      observations: 0,
      promoted: 0,
      missed: 0,
      staled: 0,
      forgotten: 0,
      lastLearnedAt: null,
      lastForgottenAt: null,
    };
  }

  get size() {
    return this.records.size;
  }

  /** 表变了就通知一声（落盘是防抖合并的，多喊几次不亏）。 */
  #changed() {
    try {
      this.onChange?.();
    } catch (err) {
      this.log?.(`用法学习落盘回调失败（不影响学习）：${err?.message ?? err}`);
    }
  }

  /** 当前推断出的前缀（按频次降序）。 */
  get prefixes() {
    return [...this.prefixCounts.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count)
      .map((p) => p.prefix);
  }

  get prefixHints() {
    return [...this.prefixCounts.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count);
  }

  get snapshot() {
    const byStatus = { candidate: 0, active: 0, stale: 0 };
    for (const rec of this.records.values()) byStatus[rec.status] = (byStatus[rec.status] ?? 0) + 1;
    return {
      enabled: true,
      linkId: this.linkId,
      total: this.records.size,
      active: byStatus.active,
      candidate: byStatus.candidate,
      stale: byStatus.stale,
      threshold: this.threshold,
      staleAfter: this.staleAfter,
      forgetAfter: this.forgetAfter,
      prefixHints: this.prefixHints.slice(0, 8),
      ...this.stats,
    };
  }

  /**
   * 从一条封口的 turn 学一点东西（`TurnIndex.onClose` 调）。
   * 只有**被响应过**的 turn 才算证据；已知用法这次没被响应 → 记一次 miss（§17.2④）。
   */
  observe(turn, { prefixes = this.prefixes.length ? this.prefixes : this.prefixCandidates } = {}) {
    if (!turn?.trigger) return null;
    const cand = candidateFromTurn(turn, { prefixes });
    if (!cand) return null;
    const id = capabilityId(this.linkId, cand.kind, cand.name);
    const existing = this.records.get(id) ?? null;
    const responded = Array.isArray(turn.outcomes) && turn.outcomes.length > 0;

    if (!responded) {
      if (existing) this.#noteMiss(existing);
      return null;
    }

    const at = Number(turn.closedAt) || this.now();
    const ch = firstChar(turn.trigger?.text ?? '');
    if (this.prefixCandidates.includes(ch)) this.prefixCounts.set(ch, (this.prefixCounts.get(ch) ?? 0) + 1);

    const rec = existing ?? this.#blank(id, cand, turn, at);
    rec.evidence.observations += 1;
    rec.evidence.lastSeen = at;
    rec.missStreak = 0;
    rec.updatedAt = at;
    const messageId = turn.trigger?.refs?.message_id;
    if (messageId !== undefined && messageId !== null) {
      const ref = String(messageId);
      if (!rec.evidence.messageIds.includes(ref)) rec.evidence.messageIds.push(ref);
      if (rec.evidence.messageIds.length > this.maxEvidence) rec.evidence.messageIds.shift();
    }
    // 观测到的真实用法优先覆盖"猜测"的那部分。
    if (cand.args && Object.keys(cand.args).length) rec.args = { ...rec.args, ...cand.args };
    if (cand.preconditions && Object.keys(cand.preconditions).length) {
      rec.preconditions = { ...rec.preconditions, ...cand.preconditions };
    }
    const actions = [...new Set((turn.outcomes ?? []).map((o) => o.action).filter(Boolean))];
    if (actions.length) {
      const prev = rec.outcome.actions ?? [];
      rec.outcome.actions = [...new Set([...prev, ...actions])];
    }
    if (Number.isFinite(turn.latencyMs)) {
      const n = Math.max(1, rec.evidence.observations);
      const prevAvg = Number.isFinite(rec.outcome.typicalLatencyMs) ? rec.outcome.typicalLatencyMs : turn.latencyMs;
      rec.outcome.typicalLatencyMs = Math.round((prevAvg * (n - 1) + turn.latencyMs) / n);
    }
    if (rec.evidence.observations >= this.threshold && rec.status === 'candidate') {
      rec.status = 'active';
      this.stats.promoted += 1;
      this.log?.(`用法学习：${rec.prefix}${rec.name}（${rec.kind}）观测 ${rec.evidence.observations} 次 → active`);
    } else if (rec.status === 'stale') {
      rec.status = rec.evidence.observations >= this.threshold ? 'active' : 'candidate';
    }
    this.stats.observations += 1;
    this.stats.lastLearnedAt = at;
    this.#trim();
    this.#changed();
    return briefRec(rec);
  }

  /** 连续未复现：先 stale 降置信，够 `forgetAfter` 才删（§17.2④/§17.7）。 */
  #noteMiss(rec) {
    const at = this.now();
    rec.misses += 1;
    rec.missStreak += 1;
    rec.lastMissAt = at;
    this.stats.missed += 1;
    if (rec.missStreak >= this.forgetAfter) {
      this.records.delete(rec.id);
      this.stats.forgotten += 1;
      this.stats.lastForgottenAt = at;
      this.log?.(`用法学习：${rec.prefix}${rec.name} 连续 ${rec.missStreak} 次未复现，删除（delete_confidence 达阈值）`);
      this.#changed();
      return 'forgotten';
    }
    if (rec.missStreak >= this.staleAfter && rec.status !== 'stale') {
      rec.status = 'stale';
      rec.confidence = Math.max(0, Number(rec.confidence ?? 0) - 1);
      this.stats.staled += 1;
      this.log?.(`用法学习：${rec.prefix}${rec.name} 连续 ${rec.missStreak} 次未复现 → stale（降置信，不删）`);
      this.#changed();
      return 'stale';
    }
    return 'miss';
  }

  /** agent 通过 `onebot_capabilities({upsert})` 写回的学习结论（§17.5）。 */
  upsert(input, { source = 'manual' } = {}) {
    const raw = typeof input === 'string' ? { name: input } : input ?? {};
    const name = String(raw.name ?? '').trim();
    if (!name) return null;
    const kind = String(raw.kind ?? 'command');
    const id = String(raw.id ?? capabilityId(this.linkId, kind, name));
    const at = this.now();
    let rec = this.records.get(id) ?? null;
    if (!rec) {
      // 名字/别名命中已有记录就复用（agent 报名字往往不带前缀）。
      const lowered = name.toLowerCase();
      rec =
        [...this.records.values()].find(
          (r) => r.name.toLowerCase() === lowered || (r.aliases ?? []).some((a) => String(a).toLowerCase() === lowered),
        ) ?? null;
    }
    if (!rec) {
      rec = {
        id,
        scope: { linkId: this.linkId, ...(raw.scope ?? {}) },
        kind,
        name,
        aliases: [],
        prefix: String(raw.prefix ?? ''),
        args: {},
        preconditions: {},
        outcome: { actions: [], typicalLatencyMs: null },
        confidence: 0,
        evidence: { messageIds: [], firstSeen: at, lastSeen: null, observations: 0 },
        source,
        notes: '',
        status: 'candidate',
        misses: 0,
        missStreak: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.records.set(rec.id, rec);
    }
    if (Array.isArray(raw.aliases)) rec.aliases = [...new Set(raw.aliases.map((a) => String(a)).filter(Boolean))];
    if (raw.prefix !== undefined) rec.prefix = String(raw.prefix ?? '');
    if (raw.args && typeof raw.args === 'object') rec.args = { ...rec.args, ...raw.args };
    if (raw.preconditions && typeof raw.preconditions === 'object') {
      rec.preconditions = { ...rec.preconditions, ...raw.preconditions };
    }
    if (raw.outcome && typeof raw.outcome === 'object') rec.outcome = { ...rec.outcome, ...raw.outcome };
    if (raw.notes !== undefined) rec.notes = String(raw.notes ?? '');
    if (raw.usage !== undefined) rec.notes = [rec.notes, `用法：${String(raw.usage)}`].filter(Boolean).join('\n');
    if (raw.examples !== undefined) {
      const ex = Array.isArray(raw.examples) ? raw.examples : [raw.examples];
      rec.notes = [rec.notes, `示例：${ex.map((e) => String(e)).join(' / ')}`].filter(Boolean).join('\n');
    }
    if (raw.status && ['candidate', 'active', 'stale'].includes(String(raw.status))) rec.status = String(raw.status);
    if (Number.isFinite(Number(raw.confidence)) && rec.evidence.observations === 0) {
      rec.evidence.observations = Math.max(0, Number(raw.confidence));
    }
    // 观测过就是事实：写入来源降级为"两者"，但不清空证据（§17.4 冲突时观测优先）。
    if (rec.evidence.observations > 0 && source !== 'observed') rec.source = 'both';
    else rec.source = source;
    rec.updatedAt = at;
    this.#trim();
    this.#changed();
    return briefRec(rec);
  }

  /** §17.4 静态清单并入：code 出名字与声明，observed 出真实用法。 */
  mergeCode(entries = []) {
    const out = [];
    for (const entry of entries ?? []) {
      if (!entry?.name) continue;
      const existing = [...this.records.values()].find(
        (r) =>
          r.name.toLowerCase() === String(entry.name).toLowerCase() ||
          (r.aliases ?? []).some((a) => String(a).toLowerCase() === String(entry.name).toLowerCase()),
      );
      if (existing) {
        // 只补声明面：别名、来源标记、notes 里的出处；用法/参数形态保持观测到的样子。
        if (Array.isArray(entry.aliases)) {
          existing.aliases = [...new Set([...existing.aliases, ...entry.aliases.map((a) => String(a)).filter(Boolean)])];
        }
        if (!existing.prefix && entry.prefix) existing.prefix = String(entry.prefix);
        existing.source = 'both';
        if (entry.notes) existing.notes = [existing.notes, entry.notes].filter(Boolean).join('\n');
        existing.updatedAt = this.now();
        out.push(briefRec(existing));
        continue;
      }
      const at = this.now();
      const rec = {
        id: String(entry.id ?? capabilityId(this.linkId, entry.kind ?? 'command', entry.name)),
        scope: { linkId: this.linkId },
        kind: String(entry.kind ?? 'command'),
        name: String(entry.name),
        aliases: Array.isArray(entry.aliases) ? [...new Set(entry.aliases.map((a) => String(a)).filter(Boolean))] : [],
        prefix: String(entry.prefix ?? ''),
        args: entry.args && typeof entry.args === 'object' ? { ...entry.args } : {},
        preconditions: entry.preconditions && typeof entry.preconditions === 'object' ? { ...entry.preconditions } : {},
        outcome: entry.outcome && typeof entry.outcome === 'object' ? { ...entry.outcome } : { actions: [], typicalLatencyMs: null },
        confidence: 0,
        evidence: { messageIds: [], firstSeen: at, lastSeen: null, observations: 0 },
        source: 'code',
        notes: String(entry.notes ?? ''),
        status: 'candidate',
        misses: 0,
        missStreak: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.records.set(rec.id, rec);
      out.push(briefRec(rec));
    }
    this.#trim();
    this.#changed();
    return out;
  }

  #blank(id, cand, turn, at) {
    const rec = {
      id,
      scope: { linkId: this.linkId, worldKey: turn.trigger?.sessionKey ?? null },
      kind: cand.kind,
      name: cand.name,
      aliases: [],
      prefix: cand.prefix,
      args: { ...cand.args },
      preconditions: { ...cand.preconditions },
      outcome: { actions: [], typicalLatencyMs: null },
      confidence: 0,
      evidence: { messageIds: [], firstSeen: at, lastSeen: null, observations: 0 },
      source: 'observed',
      notes: '',
      status: 'candidate',
      misses: 0,
      missStreak: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(id, rec);
    return rec;
  }

  /** id 或名字都认（agent 通常只记得名字）。 */
  #find(key) {
    const raw = String(key ?? '').trim();
    if (!raw) return null;
    if (this.records.has(raw)) return this.records.get(raw);
    const lowered = raw.toLowerCase();
    return (
      [...this.records.values()].find(
        (r) => r.name.toLowerCase() === lowered || (r.aliases ?? []).some((a) => String(a).toLowerCase() === lowered),
      ) ?? null
    );
  }

  get(key) {
    const rec = this.#find(key);
    return rec ? briefRec(rec) : null;
  }

  list({ query = '', kind = '', status = '', limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const order = { active: 0, candidate: 1, stale: 2 };
    const all = [...this.records.values()]
      .filter((r) => (kind ? r.kind === kind : true))
      .filter((r) => (status ? r.status === status : true))
      .filter((r) =>
        q
          ? r.name.toLowerCase().includes(q) ||
            String(r.prefix ?? '').includes(q) ||
            (r.aliases ?? []).some((a) => String(a).toLowerCase().includes(q)) ||
            String(r.notes ?? '').toLowerCase().includes(q)
          : true,
      )
      .sort(
        (a, b) =>
          (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
          (b.evidence?.observations ?? 0) - (a.evidence?.observations ?? 0) ||
          (a.name < b.name ? -1 : 1),
      );
    const n = Number(limit) > 0 ? Number(limit) : 20;
    return { items: all.slice(0, n).map(briefRec), count: Math.min(n, all.length), total: all.length };
  }

  /** 手动删除（agent 判定"这条根本不存在"）。 */
  forget(key) {
    const rec = this.#find(key);
    if (!rec) return null;
    this.records.delete(rec.id);
    this.stats.forgotten += 1;
    this.stats.lastForgottenAt = this.now();
    this.#changed();
    return briefRec(rec);
  }

  /** 手动降置信（"这条还没确认"）。 */
  markStale(key, note = '') {
    const rec = this.#find(key);
    if (!rec) return null;
    rec.status = 'stale';
    rec.confidence = Math.max(0, Number(rec.confidence ?? 0) - 1);
    if (note) rec.notes = [rec.notes, String(note)].filter(Boolean).join('\n');
    rec.updatedAt = this.now();
    this.#changed();
    return briefRec(rec);
  }

  #trim() {
    if (this.records.size <= this.limit) return;
    // 超出上限时先扔最老的 stale（有证据的 record 是资产，不该被新候选挤掉）。
    const stale = [...this.records.values()].filter((r) => r.status === 'stale').sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    while (this.records.size > this.limit && stale.length) this.records.delete(stale.shift().id);
    if (this.records.size <= this.limit) return;
    const all = [...this.records.values()].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    while (this.records.size > this.limit) this.records.delete(all.shift().id);
  }

  /** L3 注入（§6.1）：只给 active/candidate，且按证据量排序。 */
  renderForPrompt({ limit = 5 } = {}) {
    const order = { active: 0, candidate: 1, stale: 9 };
    return [...this.records.values()]
      .filter((r) => r.status !== 'stale')
      .sort(
        (a, b) =>
          (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
          (b.evidence?.observations ?? 0) - (a.evidence?.observations ?? 0),
      )
      .slice(0, limit)
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        prefix: r.prefix,
        args: renderParams(r),
        outcome: renderOutcome(r),
        confidence: r.evidence?.observations ?? 0,
        status: r.status,
      }));
  }

  /**
   * §10 `onebot_relay_probe` 的判定：这句话按现有表会不会触发下游、会被谁触发。
   * 纯预测——不发送任何东西（真发是调用方的事），stale 条目也参与但分数会打折。
   */
  predict({ text = '', linkId = '', hasAt = false, hasReply = false, limit = 5 } = {}) {
    const matches = [];
    for (const rec of this.records.values()) {
      if (linkId && rec.scope?.linkId && rec.scope.linkId !== linkId) continue;
      const hit = matchCapability(rec, { text, hasAt, hasReply });
      if (!hit) continue;
      matches.push({
        id: rec.id,
        linkId: rec.scope?.linkId ?? this.linkId,
        kind: rec.kind,
        name: rec.name,
        prefix: rec.prefix ?? '',
        aliases: [...(rec.aliases ?? [])],
        status: rec.status ?? 'candidate',
        confidence: rec.evidence?.observations ?? 0,
        source: rec.source,
        score: Number((hit.score * statusFactor(rec.status)).toFixed(3)),
        shapeScore: hit.score,
        why: hit.why,
        args: hit.args ?? {},
        outcome: rec.outcome ?? null,
        preconditions: rec.preconditions ?? {},
        usage: rec.notes ?? '',
      });
    }
    matches.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
    const top = matches.slice(0, limit);
    const best = top[0] ?? null;
    const result = {
      text: String(text ?? ''),
      linkId: linkId || this.linkId,
      // 打分已经含状态折扣：candidate 打折也能到 0.8，stale 只有 0.4 → 不足以说"会触发"。
      wouldTrigger: Boolean(best) && best.score >= 0.7,
      exact: Boolean(best) && best.shapeScore >= 1 && best.status === 'active',
      best,
      matches: top,
      total: matches.length,
      table: { total: this.records.size, prefixes: this.prefixes },
      sent: false,
    };
    result.note = renderPrediction(result);
    return result;
  }

  reset() {
    const n = this.records.size;
    this.records = new Map();
    this.prefixCounts = new Map();
    this.#changed();
    return n;
  }

  toJSON() {
    return {
      version: 1,
      linkId: this.linkId,
      savedAt: this.now(),
      stats: { ...this.stats },
      prefixCounts: [...this.prefixCounts.entries()],
      records: [...this.records.values()].map((r) => ({
        ...r,
        evidence: { ...r.evidence, messageIds: [...(r.evidence?.messageIds ?? [])] },
        aliases: [...(r.aliases ?? [])],
      })),
    };
  }

  load(data) {
    if (!data || !Array.isArray(data.records)) return 0;
    let n = 0;
    for (const raw of data.records) {
      if (!raw?.id || !raw?.name) continue;
      const rec = {
        id: String(raw.id),
        scope: { linkId: this.linkId, ...(raw.scope ?? {}) },
        kind: String(raw.kind ?? 'command'),
        name: String(raw.name),
        aliases: Array.isArray(raw.aliases) ? raw.aliases.map((a) => String(a)) : [],
        prefix: String(raw.prefix ?? ''),
        args: raw.args && typeof raw.args === 'object' ? { ...raw.args } : {},
        preconditions: raw.preconditions && typeof raw.preconditions === 'object' ? { ...raw.preconditions } : {},
        outcome: raw.outcome && typeof raw.outcome === 'object' ? { ...raw.outcome } : { actions: [], typicalLatencyMs: null },
        confidence: Number(raw.confidence) || 0,
        evidence: {
          messageIds: Array.isArray(raw.evidence?.messageIds) ? raw.evidence.messageIds.map((m) => String(m)) : [],
          firstSeen: raw.evidence?.firstSeen ?? null,
          lastSeen: raw.evidence?.lastSeen ?? null,
          observations: Number(raw.evidence?.observations) || 0,
        },
        source: String(raw.source ?? 'observed'),
        notes: String(raw.notes ?? ''),
        status: ['candidate', 'active', 'stale'].includes(String(raw.status)) ? String(raw.status) : 'candidate',
        misses: Number(raw.misses) || 0,
        missStreak: Number(raw.missStreak) || 0,
        createdAt: raw.createdAt ?? null,
        updatedAt: raw.updatedAt ?? null,
      };
      this.records.set(rec.id, rec);
      n += 1;
    }
    if (Array.isArray(data.prefixCounts)) {
      for (const [prefix, count] of data.prefixCounts) this.prefixCounts.set(String(prefix), Number(count) || 0);
    }
    if (data.stats && typeof data.stats === 'object') {
      this.stats = { ...this.stats, ...data.stats };
    }
    return n;
  }
}
