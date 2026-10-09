/**
 * 唤醒策略（§21.7）：三档 + 批量窗口 + **命令静默硬约束**。
 *
 * 静默是硬约束而不是风格：下游 bot 已经应答过，hub 就不要替它说话（§16.5）。
 * 其余判断留在这里是因为它们决定"要不要花钱调模型"，属于代码该管的事。
 */

export const AGENT_MODES = ['observer', 'assist', 'active'];

export const DEFAULT_AGENT_POLICY = {
  mode: 'assist',
  batchSize: 6,
  batchMs: 8000,
  maxActive: 8,
  idleDisposeMs: 1800000,
  silenceWhenDownstreamResponded: true,
  wakeOnPrivate: true,
  wakeOnNotice: false,
  // m30383 用户定案：发言只有 onebot_reply 一个出口，回复文本只是内部草稿，不再有"文本兜底=发言"。
  // 这里保留成逃生门：配置显式 true 才恢复老行为（isSilentMarker 只服务这条逃生门路径）。
  speakAssistantText: false,
  /** 激活状态的空转上限：最后一次"有人说话或它回话"之后这么久没动静就回休眠（0 = 不超时）。 */
  awakeMs: 300000,
  /** `active` 档在休眠时的判断间隔：每隔这么久看一眼"有没有新消息"。 */
  activeTickMs: 300000,
};

/** 连续几轮没开口就退出激活状态（用户定的规则：连续 2 轮沉默）。 */
export const AWAKE_SILENT_TURNS = 2;

/**
 * 一个会话的唤醒状态（`dormant` 休眠 / `awake` 激活）。
 *
 * 状态由 `Mind` 保存（`#wakeStates`），判定逻辑留在这里——这样"什么时候醒/什么时候睡"
 * 和别的唤醒规则在同一个文件里，测试也能只喂状态、不搭整套编排。
 *
 * @param {number} [now]
 * @returns {{state:'dormant'|'awake', since:number, lastMsgAt:number, lastTurnAt:number, lastCheckAt:number, silentTurns:number}}
 */
export function initialWakeState(now = Date.now()) {
  return { state: 'dormant', since: now, lastMsgAt: 0, lastTurnAt: 0, lastCheckAt: now, silentTurns: 0 };
}

/**
 * 谁在叫我：`@` 我 / 引用我说过的话 / 文本里带我的昵称，**以及私聊的每一条**
 * （用户定的：私聊每条都算被叫到）。这是"立刻醒"的唯一途径。
 *
 * @param {{policy?:object, mentions?:string[], sessionKey?:string}} input
 * @returns {{called:boolean, reason:string|null}}
 */
export function resolveCalled({ policy, mentions = [], sessionKey = '' } = {}) {
  if (mentions.length) return { called: true, reason: `mentioned:${mentions.join('+')}` };
  const sk = String(sessionKey ?? '');
  if (sk.startsWith('private:') && policy?.wakeOnPrivate !== false) return { called: true, reason: 'private' };
  return { called: false, reason: null };
}

export function resolveAgentPolicy(config = {}) {
  const warnings = [];
  const src = config ?? {};
  let mode = src.mode ?? DEFAULT_AGENT_POLICY.mode;
  if (!AGENT_MODES.includes(mode)) {
    warnings.push(`未知的 agent.mode=${mode}，回退 ${DEFAULT_AGENT_POLICY.mode}`);
    mode = DEFAULT_AGENT_POLICY.mode;
  }
  const num = (v, fallback, name, min = 1) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      warnings.push(`agent.${name}=${v} 非法，回退 ${fallback}`);
      return fallback;
    }
    return Math.floor(n);
  };
  return {
    mode,
    batchSize: num(src.batchSize, DEFAULT_AGENT_POLICY.batchSize, 'batchSize'),
    batchMs: num(src.batchMs, DEFAULT_AGENT_POLICY.batchMs, 'batchMs', 0),
    maxActive: num(src.maxActive, DEFAULT_AGENT_POLICY.maxActive, 'maxActive'),
    idleDisposeMs: num(src.idleDisposeMs, DEFAULT_AGENT_POLICY.idleDisposeMs, 'idleDisposeMs', 0),
    silenceWhenDownstreamResponded:
      src.silenceWhenDownstreamResponded === undefined
        ? DEFAULT_AGENT_POLICY.silenceWhenDownstreamResponded
        : Boolean(src.silenceWhenDownstreamResponded),
    wakeOnPrivate: src.wakeOnPrivate === undefined ? DEFAULT_AGENT_POLICY.wakeOnPrivate : Boolean(src.wakeOnPrivate),
    wakeOnNotice: src.wakeOnNotice === undefined ? DEFAULT_AGENT_POLICY.wakeOnNotice : Boolean(src.wakeOnNotice),
    speakAssistantText:
      src.speakAssistantText === undefined
        ? DEFAULT_AGENT_POLICY.speakAssistantText
        : Boolean(src.speakAssistantText),
    awakeMs: num(src.awakeMs, DEFAULT_AGENT_POLICY.awakeMs, 'awakeMs', 0),
    activeTickMs: num(src.activeTickMs, DEFAULT_AGENT_POLICY.activeTickMs, 'activeTickMs', 0),
    model: src.model ?? '',
    warnings,
  };
}

/**
 * 会话白名单（`m31030` 用户定案）：**没列出来的会话不调模型**。
 *
 * 配置里两张名单：`agent.groups`（key=群号）与 `agent.privates`（key=QQ号），
 * resolveConfig 已把它们解析成 `{id: {mode?}}` 的普通对象。这里回答"这个会话在不在名单里"：
 *
 * · 两张名单**都没出现在配置里** = 白名单功能没启用（老配置、手搭的测试桩）→ 返回 `{}` 放行，
 *   老 usage 不受影响；生产 resolveConfig 恒产出两张名单（哪怕空），所以**生产默认是 deny-all**，
 *   想让哪个群/私聊能说话就在名单里加一条。
 * · 功能启用中：`group:NNN` 查 `agentGroups`、`private:NNN` 查 `agentPrivates`；该类名单缺失
 *   等价于空名单（一个都不放）。条目命中就返回它（`{}` = 只准入、策略全跟全局；`{mode}` = 覆盖模式）。
 *
 * @returns {object|null} 命中 → 条目对象（可能为 `{}`）；未命中/未列出 → `null`
 */
export function sessionOverrideOf(sessionKey, config = null) {
  const cfg = config ?? null;
  const groups = cfg?.agentGroups;
  const privates = cfg?.agentPrivates;
  if (!groups && !privates) return {};
  const sk = String(sessionKey ?? '');
  const isPrivate = sk.startsWith('private:');
  if (!isPrivate && !sk.startsWith('group:')) return null;
  const map = isPrivate ? privates : groups;
  const hit = map?.[sk.slice(sk.indexOf(':') + 1)];
  if (hit == null) return null;
  return typeof hit === 'object' ? hit : {};
}

/**
 * 把白名单条目的 `mode` 覆盖合进全局策略（`m31030` 定案：**只有 mode** 可按会话覆盖，
 * 批量窗口等参数全局统一）。mode 缺省/非法/与全局相同 → 原对象原样返回（不复制），
 * 合法且不同 → 浅复制只改 `mode`，其余字段照抄全局。
 */
export function mergePolicyMode(policy, override) {
  const mode = override?.mode;
  if (!mode || !AGENT_MODES.includes(mode) || mode === policy?.mode) return policy;
  return { ...policy, mode };
}

const isMessageEvent = (event) => typeof event?.post_type === 'string' && event.post_type.startsWith('message');

/** 这条消息里所有 at 段的指向（诊断用；`all` 表示 @全体成员）。 */
export function atTargetsOf(event) {
  const segments = Array.isArray(event?.message) ? event.message : [];
  return segments
    .filter((seg) => seg?.type === 'at')
    .map((seg) => seg?.data?.qq ?? seg?.data?.user_id ?? null)
    .filter((v) => v !== null)
    .map(String);
}

/**
 * 谁在叫我：**只认 at 段指向我、或引用了我说过的话**（`m02678` 用户定案）。
 *
 * 为什么不认"文本里带昵称"：上游账号昵称就是 `test`，而 `latest`、`contest`、`npm test`
 * 里都含 `test`；就算加词边界，`npm test` 这种独立词照样会唤醒，而误唤醒的代价是整轮模型
 * 被叫起来说话。群友真要点名，@ 一下或引用一句就够了。
 *
 * 真机坑（事故 #11）：`selfId` 取自配置 `upstreamSelfId`，而那条配置**可以是空的**（该写不写都行，
 * 账号本就能从握手里学到）。空 `selfId` 下 `String(qq) === String('')` 恒假 → 明明被 @ 了却
 * `mentions: []` → 休眠态永不唤醒。两条对策：① 调用方必须给**学到的**账号兜底（`Mind.liveSelfId`）；
 * ② `qq`/`user_id` 两种写法都认（不同实现端字段不同），`all`（@全体成员）不算叫我。
 *
 * `nickname`/`nicknames` 调用方照旧会传（`onebot_hub_status` 的 `agents.identity` 还在展示），
 * 但**不再参与唤醒判定**——这里刻意不解构它们，免得读代码的人以为还有这条路。
 */
export function detectMention(event, { selfId, selfMessageIds } = {}) {
  const reasons = [];
  if (!event) return reasons;
  const segments = Array.isArray(event.message) ? event.message : [];
  const me = selfId === undefined || selfId === null ? '' : String(selfId).trim();
  for (const seg of segments) {
    const target = seg?.data?.qq ?? seg?.data?.user_id;
    if (seg?.type === 'at' && target !== undefined && String(target) !== 'all' && me && String(target) === me) {
      reasons.push('at');
    }
    if (seg?.type === 'reply' && seg?.data?.id !== undefined && selfMessageIds?.has?.(String(seg.data.id))) reasons.push('reply');
  }
  if (event.reply?.sender?.user_id !== undefined && me && String(event.reply.sender.user_id) === me) reasons.push('reply:sender');
  return [...new Set(reasons)];
}

/** 批量窗口：攒够条数或超时就该唤醒（§21.7）。 */
export class BatchWindow {
  constructor({ size = 6, ms = 8000, sizeLimit = 200 } = {}) {
    this.size = size;
    this.ms = ms;
    this.sizeLimit = sizeLimit;
    this.entries = [];
    this.openedAt = null;
  }

  get count() {
    return this.entries.length;
  }

  push(entry, now = Date.now()) {
    if (this.openedAt === null) this.openedAt = now;
    this.entries.push(entry);
    if (this.entries.length > this.sizeLimit) this.entries.splice(0, this.entries.length - this.sizeLimit);
    return this;
  }

  get ageMs() {
    return this.openedAt === null ? 0 : Date.now() - this.openedAt;
  }

  shouldFlush(now = Date.now()) {
    if (!this.entries.length) return { flush: false, reason: 'batch:empty' };
    if (this.count >= this.size) return { flush: true, reason: 'batch:full' };
    if (this.openedAt !== null && now - this.openedAt >= this.ms) return { flush: true, reason: 'batch:timeout' };
    return { flush: false, reason: 'batch:pending' };
  }

  flush() {
    const out = this.entries;
    this.entries = [];
    this.openedAt = null;
    return out;
  }
}

/**
 * 要不要为这条消息唤醒 agent。判定顺序即优先级，返回 reason 供审计。
 *
 * 两段式（`m01733` 用户定的规则）：
 *   · **休眠态**（默认）：只记录不叫模型。**被叫到**（`resolveCalled`）才立刻醒并进入激活；
 *     `active` 档的"每 `activeTickMs` 看一眼"由 `Mind` 的定时器发起（`tick:active`），
 *     不走这条函数。
 *   · **激活态**：被叫到照样立刻醒；否则按批量窗口——攒满 `batchSize` 条或窗口到 `batchMs`
 *     再唤醒一次。退出激活的条件（连续 N 轮沉默、激活超时）也在 `Mind` 里判定。
 *
 * @param {{policy:object, entry:object, event?:object, batch?:BatchWindow,
 *          mentions?:string[], downstreamResponded?:boolean, isSelf?:boolean, now?:number,
 *          wakeState?:object|null}} input
 */
export function shouldWake(input = {}) {
  const {
    policy,
    entry,
    event,
    batch,
    mentions = [],
    downstreamResponded = false,
    isSelf = false,
    now = Date.now(),
    wakeState = null,
  } = input;
  const kind = event?.post_type ?? entry?.kind ?? 'unknown';
  const sessionKey = String(entry?.sessionKey ?? '');

  if (policy.mode === 'observer') return { wake: false, reason: 'mode:observer' };
  if (isSelf) return { wake: false, reason: 'self' };
  // 元事件（heartbeat / lifecycle）**永远**不叫模型，`wakeOnNotice` 也放不进来。
  // 坑（实测线上）：`entry.text` 对元事件也有值（`[元事件 heartbeat]`），所以它过了上面那道
  // "notice 且没有文本"的判定；开着 `wakeOnNotice` 时它会进批量窗口，窗口到期由 `scanDue`
  // 唤醒——每条心跳白跑一个模型回合（`other:meta_event` 会话 turns 一直涨，用户看得见）。
  // 心跳不是聊天内容，没有"要不要回应"的判断可做：根本不该进窗口。
  if (kind === 'meta_event') return { wake: false, reason: 'kind:meta_event' };
  if (!isMessageEvent(event) && !entry?.text) return { wake: false, reason: `kind:${kind}` };
  if (!isMessageEvent(event) && !policy.wakeOnNotice) return { wake: false, reason: `kind:${kind}` };
  const call = resolveCalled({ policy, mentions, sessionKey });
  /**
   * **被叫到优先于"下游已应答"这道静默闸**。
   *
   * 静默的本意是"同一个话题下游 bot 已经答过了，我不重复答"；但人家**点名找我**
   * （@我 / 引用我的话 / 喊我昵称 / 私聊）时还用这条挡着，就变成了"我装死"。
   * 真机事故 #10 就是这么爆的：休眠期的批量窗口不会 flush，`openedAt` 停在几十分钟前，
   * 只要那之后有过任何一次下游应答，这个会话就被**永久静默**——用户 @ 我，我一声不吭。
   */
  if (call.called) return { wake: true, reason: call.reason };
  if (downstreamResponded && policy.silenceWhenDownstreamResponded) {
    return { wake: false, reason: 'silent:downstream-responded' };
  }

  const awake = wakeState?.state === 'awake';
  if (awake) {
    // 激活态：没被点名就按批量窗口（"攒满 batchSize 或窗口到 batchMs 再唤醒"）。
    if (!batch) return { wake: false, reason: 'awake:idle' };
    const verdict = batch.shouldFlush(now);
    return verdict.flush ? { wake: true, reason: verdict.reason } : { wake: false, reason: verdict.reason };
  }

  // 休眠态：只有被叫到才立刻醒（上面的 `call.called` 已经处理）；群里没叫我 → 攒着。
  return { wake: false, reason: policy.mode === 'active' ? 'dormant:active' : 'dormant' };
}

export function describeAgentPolicy(policy) {
  const p = policy ?? resolveAgentPolicy({});
  return (
    `模式 ${p.mode}｜批量 ${p.batchSize} 条 / ${p.batchMs}ms｜激活空转上限 ${p.awakeMs}ms｜active 节拍 ${p.activeTickMs}ms｜` +
    `并发上限 ${p.maxActive}｜静默硬约束 ${p.silenceWhenDownstreamResponded ? '开' : '关'}`
  );
}
