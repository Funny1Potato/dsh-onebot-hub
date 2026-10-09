/**
 * L1′ 回合索引：(trigger, outcome) 配对（方案 §16.4，里程碑 M6）。
 *
 * 这一层回答的是用户最初那个问题——「**什么样的消息能触发下游 bot 的反应**」——
 * 而且只用协议层观测，不掺任何 LLM 判断、不要求下游配合上报。
 *
 * 三条设计约束（§16.4 原文的"先机械、可解释"）：
 *  - 每条 `upstream-in` 的消息事件开启一个 turn；
 *  - window（默认 8s）内下游发出的 `send_*` action 归入该 turn；window 内又来了
 *    新的用户消息就**提前封口**（否则后续消息的响应会错配到上一条上）；
 *  - 归属不明（没有开着 turn，或已经超窗）的下游动作单列 `unsolicited`，
 *    **绝不硬塞进最近的 turn**——自发的定时消息不是对谁的回应。
 *
 * 静默判定（§16.5）不在这里：那一份在 `lib/mind.js`（按 `sessionKey` + `openedAt`
 * 判"本轮下游已应答"），因为它要的是"此刻该不该唤醒"，而这里要的是"事后怎么解释"。
 * 两者共用同一组事实，但一个要挡在唤醒前，一个要给 agent 事后追查。
 *
 * 落盘：`turns/<linkId>.jsonl`，每条**封口**的 turn 一行（未封口的不落盘，
 * 进程重启后最多少一条正在进行中的配对——它本来也还没结束）。
 */

import { JsonlLog, safeName } from './storage.js';

/** 默认配对窗口（ms）：比多数命令的首字节响应慢一些，又不至于跨过下一次对话。 */
export const DEFAULT_WINDOW_MS = 8000;
/** 内存里保留多少个已封口的 turn（更早的只在 jsonl 里）。 */
export const DEFAULT_RETAIN = 400;
/** 下游 bot 的"说话"就这几种 action（它只会调 send_*，见 lib/reply.js 注释）。 */
export const SEND_RE = /^send_/;

/** 这条时间线条目是否开启/属于一个 turn 的"触发"。 */
export function isTriggerEntry(entry) {
  if (!entry || entry.direction !== 'upstream-in') return false;
  const kind = String(entry.kind ?? '');
  return kind === 'group_message' || kind === 'private_message' || kind === 'message' || kind === '';
}

/** 这条时间线条目是否是"下游 bot 真的说话了"（= outcome）。 */
export function isOutcomeEntry(entry) {
  return !!entry && entry.direction === 'downstream-in' && SEND_RE.test(String(entry.action ?? ''));
}

/**
 * 这条时间线条目是否是 **hub 自己** 的发言。
 * 关键在 `refs.fromLink`：中继下游 action 时会带上它（`hub.js` 的 `#routeOutbound`），
 * 那种条目只是一个镜像，真正说话的是下游；自己发的（`mind.deliver`）没有这个字段。
 */
export function isHubSpeech(entry) {
  if (!entry || entry.direction !== 'hub-out') return false;
  if (!SEND_RE.test(String(entry.action ?? ''))) return false;
  return !entry.refs?.fromLink;
}

/** 把一条时间线条目压成 outcome 摘要（保留 refs，方便回溯原文）。 */
export function briefOutcome(entry) {
  return {
    id: entry.id ?? null,
    ts: entry.ts ?? null,
    linkId: entry.linkId ?? null,
    action: entry.action ?? null,
    text: entry.text ?? null,
    decision: entry.decision ?? null,
    message_id: entry.refs?.message_id ?? null,
  };
}

function briefTrigger(entry) {
  return {
    id: entry.id ?? null,
    ts: entry.ts ?? null,
    kind: entry.kind ?? null,
    sessionKey: entry.sessionKey ?? null,
    conversationKey: entry.conversationKey ?? null,
    actor: entry.actor ?? null,
    text: entry.text ?? null,
    message_id: entry.refs?.message_id ?? null,
    group_id: entry.refs?.group_id ?? null,
  };
}

/** 对外暴露的 turn 形状（`withOutcomes` 控制要不要带完整 outcome 列表）。 */
export function briefTurn(turn, { withOutcomes = false } = {}) {
  if (!turn) return null;
  const out = {
    id: turn.id,
    trigger: briefTrigger(turn.trigger),
    at: turn.at,
    closedAt: turn.closedAt ?? null,
    closeReason: turn.closeReason ?? null,
    responders: [...turn.responders],
    silent: turn.outcomes.length === 0,
    hubSpoke: turn.hubSpoke,
    latencyMs: turn.latencyMs,
    outcomeCount: turn.outcomes.length,
  };
  if (withOutcomes) out.outcomes = turn.outcomes.map((o) => ({ ...o }));
  return out;
}

/** 一批 turn 的机械统计（给 `onebot_turns` 的 `stats` 与 §17.2 的候选生成用）。 */
export function summarizeTurns(turns) {
  const responsive = turns.filter((t) => t.outcomes.length > 0);
  const latencies = responsive.map((t) => t.latencyMs).filter((n) => Number.isFinite(n));
  const byResponder = new Map();
  for (const t of responsive) {
    for (const link of t.responders) byResponder.set(link, (byResponder.get(link) ?? 0) + 1);
  }
  return {
    turns: turns.length,
    responsive: responsive.length,
    silent: turns.length - responsive.length,
    hubSpokeWhileSilent: turns.filter((t) => t.hubSpoke && t.outcomes.length === 0).length,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
    responders: [...byResponder.entries()].map(([linkId, count]) => ({ linkId, count })).sort((a, b) => b.count - a.count),
  };
}

export class TurnIndex {
  constructor({ dir = '', linkId = '', log, windowMs = DEFAULT_WINDOW_MS, retain = DEFAULT_RETAIN, now = Date.now, onClose = null } = {}) {
    this.dir = dir;
    this.linkId = linkId;
    this.log = log;
    /** 封口回调（M7 用法学习挂在这里；抛错不影响配对与落盘）。 */
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.windowMs = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_WINDOW_MS;
    this.retain = Number(retain) > 0 ? Number(retain) : DEFAULT_RETAIN;
    this.now = now;
    this.logs = new JsonlLog({ dir, log });
    /** 已封口的 turn，新→旧。 */
    this.closed = [];
    /** 归属不明的下游动作（挂不到任何 trigger）。 */
    this.unsolicited = [];
    this.open = null;
    this.sequence = 0;
    this.stats = {
      observed: 0,
      closed: 0,
      responsive: 0,
      silent: 0,
      unsolicited: 0,
      lastCloseReason: null,
      lastTurnAt: null,
    };
  }

  /** 配对不需要任何开关就能工作；`persistence` 才取决于有没有 storageDir。 */
  get enabled() {
    return true;
  }

  get persistence() {
    return Boolean(this.dir);
  }

  get snapshot() {
    return {
      ...this.stats,
      enabled: true,
      persistence: this.persistence,
      windowMs: this.windowMs,
      open: Boolean(this.open),
      openTriggerAt: this.open?.at ?? null,
      retained: this.closed.length,
      unsolicitedRetained: this.unsolicited.length,
      file: this.dir ? this.logs.fileFor(safeName(this.linkId || 'hub'), this.now()) : null,
    };
  }

  /** 时间线 `onRecord` 的入口：喂进来的每一条都可能改变配对。 */
  record(entry) {
    if (!entry) return;
    const at = Number(entry.ts) || this.now();
    this.#expire(at);
    this.stats.observed += 1;

    if (isTriggerEntry(entry)) {
      // 新消息提前封口上一条：窗口再等下去只会把它的响应错配给这一条。
      if (this.open) this.#close('superseded', at);
      this.open = {
        id: `${safeName(this.linkId || 'hub')}#${++this.sequence}`,
        trigger: entry,
        at,
        outcomes: [],
        hubOutcomes: [],
        responders: [],
        hubSpoke: false,
        latencyMs: null,
        closedAt: null,
        closeReason: null,
      };
      return;
    }

    if (isOutcomeEntry(entry)) {
      if (!this.open) {
        this.#noteUnsolicited(entry);
        return;
      }
      const brief = briefOutcome(entry);
      this.open.outcomes.push(brief);
      if (entry.linkId && !this.open.responders.includes(entry.linkId)) this.open.responders.push(entry.linkId);
      if (this.open.latencyMs === null) this.open.latencyMs = Math.max(0, at - this.open.at);
      return;
    }

    if (isHubSpeech(entry)) {
      if (this.open) {
        this.open.hubSpoke = true;
        this.open.hubOutcomes.push(briefOutcome(entry));
      }
    }
  }

  /** 窗口到期就封口（惰性：每次 record / list / snapshot 前顺手做一次）。 */
  #expire(at) {
    if (this.open && at - this.open.at > this.windowMs) this.#close('window', at);
  }

  #close(reason, at) {
    const turn = this.open;
    this.open = null;
    if (!turn) return null;
    turn.closedAt = at;
    turn.closeReason = reason;
    this.stats.closed += 1;
    this.stats.lastCloseReason = reason;
    this.stats.lastTurnAt = at;
    if (turn.outcomes.length) this.stats.responsive += 1;
    else this.stats.silent += 1;
    this.closed.push(turn);
    if (this.closed.length > this.retain) this.closed.splice(0, this.closed.length - this.retain);
    // 落盘只记事实，失败不影响运行（JsonlLog 自己吞错并记日志）。
    try {
      this.logs.append(
        this.linkId || 'hub',
        {
          id: turn.id,
          at: turn.at,
          closedAt: turn.closedAt,
          closeReason: turn.closeReason,
          trigger: briefTrigger(turn.trigger),
          outcomes: turn.outcomes,
          responders: turn.responders,
          silent: turn.outcomes.length === 0,
          hubSpoke: turn.hubSpoke,
          latencyMs: turn.latencyMs,
        },
        at,
      );
    } catch (err) {
      this.log?.(`回合配对落盘失败（不影响运行）：${err?.message ?? err}`);
    }
    // 封口是"这一轮有结论了"的信号：M7 的用法学习在这里取证据（失败不影响配对）。
    try {
      this.onClose?.(turn);
    } catch (err) {
      this.log?.(`回合封口回调失败（不影响配对）：${err?.message ?? err}`);
    }
    return turn;
  }

  #noteUnsolicited(entry) {
    const brief = briefOutcome(entry);
    this.unsolicited.push(brief);
    this.stats.unsolicited += 1;
    if (this.unsolicited.length > this.retain) this.unsolicited.splice(0, this.unsolicited.length - this.retain);
  }

  /**
   * 查询（`onebot_turns` 的实现）。
   * 注意：**未封口的 turn 也会被算进来**（否则"刚发完消息想看看触发了什么"永远查不到），
   * 所以列表里可能出现 `closeReason: null` 的那一条。
   */
  list({ since = null, onlyResponsive = false, sessionKey = null, limit = 20, withOutcomes = false } = {}) {
    this.#expire(this.now());
    let turns = [...this.closed].reverse(); // 新→旧
    if (this.open) turns.unshift(this.open);
    if (since) turns = turns.filter((t) => t.at >= Number(since));
    if (sessionKey) turns = turns.filter((t) => t.trigger?.sessionKey === sessionKey);
    if (onlyResponsive) turns = turns.filter((t) => t.outcomes.length > 0);
    const n = Number(limit) > 0 ? Number(limit) : 20;
    const sliced = turns.slice(0, n);
    return {
      turns: sliced.map((t) => briefTurn(t, { withOutcomes })),
      count: sliced.length,
      total: turns.length,
      stats: summarizeTurns(turns),
      unsolicited: this.unsolicited.slice(-n).map((o) => ({ ...o })),
      windowMs: this.windowMs,
    };
  }

  /** 清空内存里的配对（`onebot_turns({reset:true})`）；落盘的 jsonl 不动。 */
  clear() {
    const n = this.closed.length;
    this.closed = [];
    this.unsolicited = [];
    this.open = null;
    return n;
  }

  close() {
    this.logs?.close?.();
  }
}
