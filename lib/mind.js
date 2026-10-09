/**
 * 编排层（§21 全局）：把"时间线 → 会话卡 → 上下文装配 → 唤醒 agent → 回复出站"串成一条线。
 *
 * 这一层刻意**不碰协议**（那是 hub.js）也**不碰宿主 API**（那是 lib/index.js 注入的 pool/setup），
 * 所以 `test/m15-e2e.mjs` 能用假 hub + 假 host 把整条链路跑通。
 */

import {
  AWAKE_SILENT_TURNS,
  BatchWindow,
  atTargetsOf,
  detectMention,
  initialWakeState,
  mergePolicyMode,
  resolveAgentPolicy,
  resolveCalled,
  sessionOverrideOf,
  shouldWake,
} from './agent/policy.js';
import { buildDigest, buildObservedEntries } from './memory/digest.js';
import { assembleContext, buildSourceHeader, describeSections, renderWindow } from './memory/assembler.js';
import { memoryBlocks } from './memory/writer.js';
import { collectCues } from './memory/cues.js';
import { ReplyBuffer, buildSendParams, describeReply } from './reply.js';
import { full as fullStamp, mdhm } from './stamp.js';

export const SESSION_ID_PREFIX = 'onebot-hub:';

const truncate = (v, n = 160) => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** 多条消息之间的打字间隔（`agent.replyGapMs`）。0 = 连发。 */
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 从一条消息的**内容段数组**里取纯文本（宿主消息是 `[{type:'text',text}]`，不是裸字符串）。 */
export function textOfContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('');
}

/**
 * 整条文本只是括号旁白（`（不回复）` / `（沉默）` / `(no reply)`）时，视为"它不想说话"。
 *
 * 这是"文本兜底=发言"（`agent.speakAssistantText=true` 逃生门）里唯一的抑制方式：
 * 兜底默认已关（m30383：发言只走 onebot_reply 工具，回复文本只是内部草稿），
 * 打开逃生门后"这一轮我判断不该开口"仍靠整句括号旁白表达。刻意限制在短且整句被括号包住，
 * 免得把正常内容也吞掉。
 */
export function isSilentMarker(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  /**
   * 「（已回：…）」这类**旁白自述**不是发言。
   *
   * 真机上出现过：模型调完 `onebot_reply` 之后，把"我已经回了什么"写成收尾文本，
   * 而那段文本被当发言发进了群里。它通常整句在括号里、以"已回/已发送"开头，
   * 所以只在这个形状上收紧——正常括号内容（`（笑）`）与长正文都不受影响。
   */
  if (/^[（(]\s*已(回|回复|发|发送|告知|交代|处理|看过|查过)/.test(t) && /[)）]$/.test(t)) return true;
  if (t.length > 24) return false;
  return /^[（(][^（()）]{0,20}[)）]$/.test(t);
}

/**
 * 时间戳（`m02432`：时钟只写在 user message 里——每批都是新增内容，写多少次都只算一次；
 * live 上下文不带时钟，快照因此不会每分钟被整份重注）。
 *
 * 这里给的是**绝对锚点**（`YYYY-MM-DD HH:MM`）：一批消息的头把日期定死，行内再用
 * `MM-DD HH:MM`（`#batchLines`），跨天就不会把昨天的消息当成刚发生的（`m34049`）。
 */
function stampNow() {
  return fullStamp(Date.now());
}

export const DEFAULT_GUIDANCE = [
  '你挂在一个 QQ 聊天链路上：你的消息由 DSH 用 OneBot v11 协议发出去，聊天里还有别的 bot 和真人。',
  '规则（硬边界，必须遵守）：',
  '- 发言只有一条出口：调 onebot_reply 工具。你写在普通回复文本里的内容只是内部草稿，宿主不会替你发进聊天；不调工具就是沉默。',
  '- 激活期间可能有新消息以【插话 N 条】插进你正在进行的回合（下一步开始前送达）：先把手头的话说完再回应，被 @ 的优先；想改口就再调一次 onebot_reply——同一轮里多次调用只有最后一次会发出去。',
  '- 下游 bot 已经应答过的话题，不要重复应答。',
  '- 跨会话记忆里的内容，不要在群聊里说出它来自哪个会话。',
  '- 只交代你确实知道的事实；不确定就直说不知道，不要编。',
  '- 每次回复前都评估一遍记忆要不要更新，即使这次决定不回复也要评估；改哪条用上下文里「短期记忆/长期记忆」显示的序号，要动记忆就调 onebot_memory。',
  '- 记什么由你决定，但"这条能不能在别的会话里说"由代码判定——不要自己声明可见性，也不要试图把私聊里的事拿到群里讲。',
  '- 上下文里的「还没兑现的事」是事实记录（你答应过谁什么、多久了、他上次什么时候出现），不要因为它出现了就每次复述一遍；提不提、什么时候提，你自己判断。',
].join('\n');

export class Mind {
  #batches = new Map(); // sessionKey -> BatchWindow
  #nicknames = new Set(); // 我叫什么（一组：备注名 + 上游真昵称，事故 #11）
  #outcomes = new Map(); // sessionKey -> { ts, action }
  #replies = new Map(); // agentKey -> ReplyBuffer
  #feed = new Map(); // agentKey -> 本轮会话账本（session/event 摘要）
  #flushing = new Map();
  /** 插话在飞的会话（sessionKey → 任务 promise，m31311）：`#expireAwake` 拿它当"忙"，单会话单飞行。 */
  #steering = new Map();
  /** 上一轮发送失败的会话（agentKey → { text, status, retcode, error }）：下一批开头一次性告知（修3）。 */
  #sendFailures = new Map();
  /**
   * 每个会话的唤醒状态（`dormant` 休眠 / `awake` 激活，见 `lib/agent/policy.js` 的
   * `initialWakeState`）。休眠期**只记录不叫模型**；被叫到才进激活，激活期按批量窗口说话，
   * 连续 `AWAKE_SILENT_TURNS` 轮没开口或空转超过 `awakeMs` 就回休眠（`m01733` 用户定的规则）。
   */
  #wakeStates = new Map(); // sessionKey -> { state, since, lastMsgAt, lastTurnAt, lastCheckAt, silentTurns }
  /**
   * "开局快照已经随哪一段会话给过了"（v4，`m24409`）。每段会话（激活）开始时转录是空的，
   * 模型需要一份"这段之前发生了什么"——但只给**一次**，且只给本批消息**之前**的（同一批
   * 消息再出现在快照里就是重复注入）。交还转录时清掉（见 `#retireAfterDormant`）。
   */
  #openingPresented = new Set(); // sessionKey -> 开局快照已给过

  constructor({ hub, timeline, store, audit, isolation, policy, pool, setup, log, guidance, capabilities, now } = {}) {
    this.hub = hub ?? null;
    /** 当前正在跑的那一轮的会话键：工具（onebot_memory 等）靠它落回正确的会话。 */
    this.activeSessionKey = null;
    this.activeActorId = null;
    this.timeline = timeline ?? hub?.timeline ?? null;
    this.store = store ?? null;
    this.audit = audit ?? null;
    this.isolation = isolation ?? null;
    this.policy = policy ?? resolveAgentPolicy({});
    this.pool = pool ?? null;
    this.setup = setup ?? null;
    this.log = log ?? (() => {});
    this.guidance = guidance ?? DEFAULT_GUIDANCE;
    this.capabilities = capabilities ?? [];
    this.selfId = hub?.config?.selfId ?? hub?.config?.upstreamSelfId ?? null;
    /**
     * 名字是**一组**（事故 #11）：配置里的 `nickname`/`upstreamNickname` 是"备注名"，
     * 上游账号的真昵称要靠 `get_login_info` 学。人 @ 我 时用的是哪个名字，事先不知道——
     * 只留一个名字，另一个名字的 @ 就永远叫不醒我。
     */
    this.nickname = hub?.config?.nickname ?? hub?.config?.upstreamNickname ?? null;
    this.#nicknames = new Set([this.nickname, hub?.config?.upstreamNickname].filter(Boolean).map(String));
    this.stats = {
      observed: 0,
      woken: 0,
      silent: 0,
      readonly: 0,
      /** 被会话白名单挡掉的消息数（m31030）：没列出的群/私聊不调模型，`lastObserve.reason` 会写明。 */
      unlisted: 0,
      /** 插话递进在飞回合的消息条数（m31311）。 */
      steered: 0,
      lastSteer: null,
      sent: 0,
      errors: 0,
      /** 进入激活的次数（被叫到、active 节拍、激活期窗口到期都算）。 */
      awakened: 0,
      /** 回休眠的次数（连续沉默、激活空转超时）。 */
      dormant: 0,
      /** 激活结束交还会话的次数（清空宿主转录；用户定案）。 */
      retired: 0,
      lastTurn: null,
      lastSetup: null,
      lastRetire: null,
    };
    this.lastActedAt = now ?? Date.now();
  }

  agentKeyOf(sessionKey) {
    return sessionKey;
  }

  /**
   * 这个 agent 的回复缓冲（没有就建一个）。必须跨轮稳定：会话级 `onebot_reply` 工具握着它的引用，
   * 而工具只在会话首次建立时注册一次（见 flush 里的注释）。
   */
  #replyFor(agentKey) {
    let buf = this.#replies.get(agentKey);
    if (!buf) {
      // 上限在这里钉住（m32420）：只限文字条数，图片不占额度。
      buf = new ReplyBuffer({
        maxText: Number(this.hub?.config?.replyMaxText ?? 3),
        maxImages: Number(this.hub?.config?.replyMaxImages ?? 9),
      });
      this.#replies.set(agentKey, buf);
    }
    return buf;
  }

  /** 释放某个 agent 的回复缓冲（会话被淘汰/关停时调用，避免留着一个再也没人读的引用）。 */
  releaseReply(agentKey) {
    return this.#replies.delete(agentKey);
  }

  /** 这个会话的唤醒状态（没有就按"休眠"建一个）。 */
  #wakeStateFor(sessionKey, now = Date.now()) {
    let st = this.#wakeStates.get(sessionKey);
    if (!st) {
      st = initialWakeState(now);
      this.#wakeStates.set(sessionKey, st);
    }
    return st;
  }

  /** 唤醒状态快照（`onebot_hub_status` 用它，排查"为什么它不说话了"时看得到睡/醒）。 */
  wakeStateOf(sessionKey) {
    const st = this.#wakeStates.get(String(sessionKey));
    return st ? { sessionKey: String(sessionKey), ...st } : null;
  }

  /** 进入激活（重复调用只刷新 `lastCheckAt`，不重置沉默轮数）。 */
  #enterAwake(sessionKey, st, now = Date.now(), reason = null) {
    if (st.state !== 'awake') {
      st.state = 'awake';
      st.since = now;
      st.silentTurns = 0;
      this.stats.awakened += 1;
      this.log(`会话 ${sessionKey} 进入激活（${reason ?? '唤醒'}）`);
    }
    st.lastCheckAt = now;
    return st;
  }

  /** 回休眠（记录原因，便于事后解释"它怎么突然不吭声了"）。 */
  #backToDormant(sessionKey, st, now = Date.now(), reason = '') {
    st.state = 'dormant';
    st.since = now;
    st.lastCheckAt = now;
    st.silentTurns = 0;
    this.stats.dormant += 1;
    if (reason) this.log(`会话 ${sessionKey} 回休眠（${reason}）`);
    // 用户定案：**激活结束就把这一段收尾**——先落盘，再清掉宿主会话的转录。
    void this.#retireAfterDormant(sessionKey, reason);
    return st;
  }

  /**
   * 激活结束的收尾：**落盘 → 交还会话（清空转录）**。
   *
   * 为什么清：一轮激活的转录 = 我们喂进去的本批消息 + 模型的回复，到下一次激活时它就是"旧账"，
   * 而且会排在 system prompt 那个**最近窗口之前**——模型会拿很久以前的话当上下文（用户指出的
   * 那个坑）。清掉之后每次激活都是新会话，上下文完全由 `liveContext()` 现算。
   *
   * 顺序不能反：**先落盘再交还**。会话卡与观察条目本来就是逐条落的，这里再冲一次盘，
   * 保证后面的 dispose 不会带走还没写下去的东西。
   */
  async #retireAfterDormant(sessionKey, reason = '') {
    const agentKey = this.agentKeyOf(sessionKey);
    try {
      this.hub?.flushStorage?.();
    } catch (err) {
      this.log(`落盘失败（不影响交还会话）：${err?.message ?? err}`);
    }
    /**
     * 交还之后**下一次激活是一个全新的会话**：它的事件 `seq` 从 1 重新开始，
     * 而这个账本按 seq 去重（`noteSessionEvent`）——不重置的话新会话的事件会被当成
     * "旧序号"全部丢掉，模型就再也看不自己的回合产出了。回复缓冲同理，清一下更干净。
     */
    try {
      this.#feed.delete(agentKey);
      this.#replyFor(agentKey).clear();
    } catch (err) {
      this.log(`重置会话账本失败（不影响交还）：${err?.message ?? err}`);
    }
    if (!this.pool?.retire) return null;
    try {
      const info = await this.pool.retire(agentKey, `dormant:${reason || 'unknown'}`);
      this.stats.retired = (this.stats.retired ?? 0) + 1;
      // 新会话（转录已清空）⇒ 下一段的第一批要重新带开局快照。
      // 交还失败时**不清**：旧转录还在，再给一遍"这段之前的事"就是重复注入。
      this.#openingPresented.delete(sessionKey);
      this.log(`会话 ${sessionKey} 激活结束：转录已交还（${info?.removed ? `删除 ${info.sessionId}` : `换新会话 id ${info?.sessionId ?? '?'}`}）`);
      return info;
    } catch (err) {
      this.log(`交还会话失败（下次激活会接着用旧转录）：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 激活空转超时：**最后一次动静之后** `awakeMs` 没人说话、它也没再开口 → 回休眠。
   * 没有这条就会永远挂着"激活"，下一次有人说话时还以为在对话中途。
   *
   * 动静看两样里更新的那个（m34646 用户定案）：`lastMsgAt`（有人发消息）与
   * `lastTurnAt`（它这一轮回完话）。只按"最后一条消息"算的话，`active` 档会错得很明显：
   * 消息先到、批量窗口和 active 节拍再拖一会儿才唤醒，模型答完时 `awakeMs` 的额度已经
   * 烧掉大半，于是"刚回完话就睡回去"——会话被归档、下一条消息又得从头开快照。
   * 两个都还没有过（刚进激活就空转）才退回 `since`。
   */
  #expireAwake(now = Date.now()) {
    const back = [];
    const limit = Number(this.policy?.awakeMs ?? 0);
    if (!(limit > 0)) return back;
    for (const [sessionKey, st] of this.#wakeStates) {
      if (st.state !== 'awake') continue;
      const last = Math.max(Number(st.lastMsgAt) || 0, Number(st.lastTurnAt) || 0) || Number(st.since) || 0;
      if (now - last < limit) continue;
      // m30055 防误杀：实测 agent 长思考 + 连环排查会把回合拖过 `awakeMs`，此刻归档
      // （宿主 stopActivity）会把在飞回合连同 subagent 一起掐掉。手头有活（在飞回合或
      // 排队中的唤醒）的不算"空转"，顺延到下一拍再判；活儿干完后自然超时回休眠。
      // 插话等待（m31311）同理：steer 任务不在 pool 的账上，`isBusy` 看不见，单独挡。
      if (this.#steering.has(sessionKey)) continue;
      if (this.pool?.isBusy?.(this.agentKeyOf(sessionKey))) continue;
      this.#backToDormant(sessionKey, st, now, `激活 ${limit}ms 没有新消息也没有回复`);
      back.push(sessionKey);
    }
    return back;
  }

  /**
   * 记"这一轮到底开口没有"，用来决定激活状态要不要结束。
   * 连续 `AWAKE_SILENT_TURNS` 轮没说 → 回休眠（用户定的规则：连续 2 轮沉默）。
   */
  #noteSpokeOutcome(sessionKey, spoke) {
    const st = this.#wakeStateFor(sessionKey);
    if (spoke) {
      st.silentTurns = 0;
      return st;
    }
    if (st.state !== 'awake') return st;
    st.silentTurns += 1;
    if (st.silentTurns >= AWAKE_SILENT_TURNS) {
      this.#backToDormant(sessionKey, st, Date.now(), `连续 ${AWAKE_SILENT_TURNS} 轮没说话`);
    }
    return st;
  }

  /**
   * 把某个会话的 agent **建起来**（已经建过就直接返回），但不喂消息、不叫模型。
   *
   * 为什么要它：聊天管理命令要在**模型跑之前**改这个会话的权限（`/perm`），而权限只能设在一个
   * 已经存在的 `Session` 上——那时会话可能还没被任何一条消息唤醒过。这里复用 `wake()` 同一套
   * setup（同一个回复缓冲、同一套模型选择包装），所以"命令先建的会话"和"聊天建的会话"完全一样，
   * 不会出现"先用命令建的会话没有 onebot_reply 工具"这种偏差。
   */
  async ensureAgent(sessionKey) {
    if (!this.pool) throw new Error('agent 池未接入');
    const agentKey = this.agentKeyOf(sessionKey);
    return this.pool.enqueue(agentKey, async () => {
      const reply = this.#replyFor(agentKey);
      await this.pool.ensure(
        agentKey,
        this.setup ? (agentCtx) => this.setup(agentCtx, { reply, mind: this, sessionKey, agentKey }) : undefined,
      );
      return agentKey;
    });
  }

  /**
   * 上游连上后补全"我是谁"（配置没写账号/昵称时用 get_login_info 与握手结果）。
   *
   * 昵称是**累加**的（`#nicknames` 是一组而不是一个）：配置里写的备注名和上游账号的真昵称
   * 都要能把我叫醒——群里的人是手打 `@真昵称` 还是 `@备注名`，我们事先不知道（事故 #11）。
   */
  setIdentity({ selfId, nickname } = {}) {
    if (selfId) this.selfId = String(selfId);
    if (nickname) {
      this.#nicknames.add(String(nickname));
      if (!this.nickname) this.nickname = String(nickname);
    }
    return this.identity();
  }

  /** 我叫什么、账号是多少（诊断与提示词都在看它）。 */
  identity() {
    return { selfId: this.liveSelfId, nickname: this.nickname, nicknames: [...this.#nicknames] };
  }

  /**
   * "这条链路上我自己是谁"的实时答案。
   *
   * 为什么不能直接用 `this.selfId`：它来自配置 `upstreamSelfId`，而**那条配置是可空的**
   * （账号本来就能从握手/事件里学到）。配置空着时 `this.selfId` 是 `''`，
   * `detectMention` 的 at 比对就恒假——真机症状是"被 @ 了却 mentions: []，休眠态永不唤醒"（事故 #11）。
   * 所以这里按 配置 → 学到的上游账号 兜底。
   */
  get liveSelfId() {
    const configured = String(this.selfId ?? '').trim();
    if (configured) return configured;
    const learned = String(this.hub?.upstreamAccount ?? '').trim();
    return learned || null;
  }

  /** 我叫什么（一组名字，诊断用）。 */
  get nicknames() {
    return [...this.#nicknames];
  }

  /**
   * 记一次会话 setup 的落地情况（诊断用）。
   *
   * 为什么要留这个：`agentCtx.tools?.register?.(...)` 是**静默**的——真宿主里那个 `agentCtx`
   * 如果没暴露 `tools`，回复工具就根本没注册，模型只能写普通文本，于是表现为"叫醒了却不说话"，
   * 和"模型自己决定沉默"长得一模一样。把注册结果记下来就能一眼分辨。
   */
  noteSetup(info = {}) {
    this.stats.lastSetup = { at: Date.now(), ...info };
    return this.stats.lastSetup;
  }

  #newFeed(agentKey = null) {
    return {
      agentKey,
      at: 0,
      turn: null,
      assistantText: '',
      assistantMessages: 0,
      toolCalls: [],
      toolResults: [],
      turnEnd: null,
      turnError: null,
      interrupted: false,
      lastSeq: null,
    };
  }

  /**
   * 记一条**会话账本事件**（宿主的 `session/event`）。
   *
   * 为什么必须有它：真宿主里 `whenIdle()` 只保证"驱动器归于安静"，回合内模型报错/工具参数错
   * 会被 `kick()` 的 `catch {}` 吞掉，`sent=0` 因此无法归因；而会话文件要等关闭才落盘。
   * 这里把 `assistant/message` 正文、`tool/call`、`tool/result`、`turn/end` 的原因留存下来。
   *
   * @param {string} agentKey 会话键（`private:…` / `group:…`）
   * @param {object} event 宿主 `SessionEvent`：`{type, seq, time, data}`
   */
  noteSessionEvent(agentKey, event) {
    if (!agentKey || !event || typeof event.type !== 'string') return null;
    const rec = this.#feed.get(agentKey) ?? this.#newFeed(agentKey);
    this.#feed.set(agentKey, rec);
    // 同一事件可能被 root 级与会话作用域两条订阅同时送到（seq 在同一会话内单调递增），
    // 去重才能保住"同一句话只记一次"——否则模型那句回复会被发两遍。
    if (typeof event.seq === 'number') {
      if (rec.lastSeq !== null && event.seq <= rec.lastSeq) return rec;
      rec.lastSeq = event.seq;
    }
    const data = event.data ?? {};
    rec.at = Date.now();
    if (typeof data.turn === 'number') rec.turn = data.turn;
    if (event.type === 'assistant/message') {
      const text = textOfContent(data.message);
      if (text) rec.assistantText = rec.assistantText ? `${rec.assistantText}\n${text}` : text;
      rec.assistantMessages += 1;
      if (data.interrupted) rec.interrupted = true;
    } else if (event.type === 'tool/call') {
      rec.toolCalls.push({ name: String(data.name ?? ''), arguments: truncate(data.arguments) });
    } else if (event.type === 'tool/result') {
      rec.toolResults.push({
        error: data.error ? `${data.error.name ?? 'error'}: ${data.error.reason ?? data.error.code ?? ''}`.trim() : null,
        text: truncate(textOfContent(data.message)),
      });
    } else if (event.type === 'turn/end') {
      rec.turnEnd = data.reason?.kind ?? null;
      if (data.reason?.kind === 'error') rec.turnError = data.reason.error?.message ?? 'unknown';
    }
    return rec;
  }

  /**
   * 只读（§19 `preset: shadow`，或配置 `readonly: true`）：**hub 自己绝不动作**。
   *
   * 这一层管的是"叫不叫模型、以什么身份替它说话"——只读时：
   * 不叫模型（不花 token）、不发消息。**事件照旧广播给下游**：那是 hub 主链路的事，
   * 只读的是 hub 的手，不是下游的眼睛。开关在 hub 上（路由策略），这里只是读它。
   */
  get readonly() {
    return this.hub?.readonly === true;
  }

  /**
   * 这个会话该用哪份策略：全局 `policy` 为底，白名单条目只覆盖 `mode`（`m31030` 定案：
   * 批量窗口等参数全局统一）。每次现算不缓存——设置页改配置后插件会重新装配，但就算
   * 同一实例里配置对象被换掉，这里也立即生效。
   */
  #policyFor(sessionKey) {
    return mergePolicyMode(this.policy, sessionOverrideOf(sessionKey, this.hub?.config));
  }

  /** 某个 agent 最近一轮的会话账本（诊断用）。 */
  feedOf(agentKey) {
    return this.#feed.get(agentKey) ?? null;
  }

  /** 上游进来一条事件（hub.js 在写完时间线后调用）。 */
  observe(entry, { event, isSelf = false, nickname, selfId, silent = null } = {}) {
    this.stats.observed += 1;
    /**
     * 只读：观察计数照记，然后**到此为止**——不入批量窗口、不叫模型。
     * 判定放在 `silent` 之前还是之后无所谓（两条路都不叫模型），放前面是为了让日志/统计
     * 把"因为只读而没叫"和"因为命令已答而没叫"分开，排查时不会互相冒充。
     */
    if (this.readonly) {
      this.stats.readonly += 1;
      return { wake: false, reason: 'readonly', batch: 0 };
    }
    /**
     * hub 认定这条**已经被枢纽自己处理过**了（命中聊天管理命令，hub 传 `silent: 'chat-command'`）。
     *
     * 看见了，但不入批量窗口、不叫模型：枢纽已经用同一个账号回过这句话，再让模型说一遍就是
     * 同一个账号对同一句话答两次。注意这不影响消息的转发——那是 hub 主链路的事，已经做完了。
     */
    if (silent) return { wake: false, reason: silent, batch: 0 };
    const sessionKey = entry?.sessionKey ?? 'unknown';
    /**
     * 会话白名单（`m31030` 用户定案）：**没列出来的群/私聊不调模型**——不入批量窗口、
     * 不建唤醒状态、@ 也不理。这道门站在一切判定与花钱之前；"它为什么不醒"直接写在
     * `lastObserve.reason`（`onebot_hub_status` 一眼可见），省得去猜。
     */
    if (sessionOverrideOf(sessionKey, this.hub?.config) === null) {
      this.stats.unlisted += 1;
      this.lastObserve = {
        at: Date.now(),
        sessionKey,
        text: truncate(entry?.text ?? '', 120),
        mentions: [],
        selfId: this.liveSelfId,
        nicknames: this.nicknames,
        atTargets: [],
        wake: false,
        reason: 'unlisted',
        state: null,
        pending: 0,
        downstreamResponded: false,
      };
      return { wake: false, reason: 'unlisted', batch: 0 };
    }
    const payload = event ?? entry?.payload ?? null;
    const mentions = detectMention(payload, {
      selfId: selfId ?? this.liveSelfId,
      nickname: nickname ?? this.nickname,
      nicknames: this.nicknames,
    });

    // 先判"这条根本不值得叫人"：心跳/通知（未开 wakeOnNotice）/自己的消息，**不入批量窗口**。
    // 坑（实测）：以前无条件 `batch.push()`，心跳的批量窗口到期后由 `scanDue` 照常唤醒 agent，
    // 结果每条 meta_event 都白跑一个模型回合（`other:meta_event` 会话跑满 turns）。
    const pre = shouldWake({
      policy: this.#policyFor(sessionKey),
      entry,
      event: payload,
      batch: null,
      mentions,
      isSelf,
      downstreamResponded: false,
    });
    if (!pre.wake && (pre.reason === 'self' || pre.reason === 'mode:observer' || pre.reason.startsWith('kind:'))) {
      // 名单把这一类会话改成 observer 时，"@ 也不醒"是**策略**而不是意外——所以要把原因写进
      // `lastObserve`（`onebot_hub_status` 一次看见），否则这条消息在诊断里彻底不留痕。
      // `self` / 心跳通知不写：它们是常态噪声，会把真正值得看的那条观察冲掉。
      if (pre.reason === 'mode:observer') {
        this.lastObserve = {
          at: Date.now(),
          sessionKey,
          text: truncate(entry?.text ?? payload?.raw_message ?? '', 120),
          mentions: mentions.slice(),
          selfId: this.liveSelfId,
          nicknames: this.nicknames,
          atTargets: atTargetsOf(payload),
          wake: false,
          reason: pre.reason,
          state: null,
          pending: 0,
          downstreamResponded: false,
        };
      }
      return { wake: false, ...pre, batch: 0 };
    }

    const batch = this.#batches.get(sessionKey) ?? new BatchWindow({ size: this.policy.batchSize, ms: this.policy.batchMs });
    batch.push(entry);
    this.#batches.set(sessionKey, batch);

    /**
     * 唤醒状态机（`m01733`）：这一条算一条"新消息"——心跳/自己的话/命令回执都在上面被挡掉了，
     * 所以激活空转超时（`awakeMs`）与 active 节拍都按它计时。休眠期只入窗口、不叫模型。
     */
    const now = Date.now();
    const st = this.#wakeStateFor(sessionKey, now);
    st.lastMsgAt = now;

    const verdict = shouldWake({
      policy: this.#policyFor(sessionKey),
      entry,
      event: payload,
      batch,
      mentions,
      isSelf,
      wakeState: st,
      now,
      downstreamResponded: this.isDownstreamResponded(sessionKey, this.#silenceSince(batch, now)),
    });
    // 诊断闭环：把"这条为什么没叫我"记在最近一次观察里（`onebot_hub_status` 的
    // `agents.lastObserve` 直接看得到），省得每次都要靠 @ 一遍再猜。
    this.lastObserve = {
      at: now,
      sessionKey,
      text: truncate(entry?.text ?? payload?.raw_message ?? '', 120),
      mentions: mentions.slice(),
      selfId: this.liveSelfId,
      nicknames: this.nicknames,
      atTargets: atTargetsOf(payload),
      wake: Boolean(verdict.wake),
      reason: verdict.reason ?? null,
      state: st.state,
      pending: batch.count,
      downstreamResponded: Boolean(verdict.reason === 'silent:downstream-responded'),
    };
    if (!verdict.wake) return { wake: false, ...verdict, batch: batch.count, wakeState: st.state };

    this.#enterAwake(sessionKey, st, now, verdict.reason);

    // 唤醒路径：异步执行，不阻塞上游事件转发（转发不能因为模型慢而变慢）。
    void this.flush(sessionKey, { reason: verdict.reason }).catch((err) => {
      this.stats.errors += 1;
      this.log(`flush 失败 ${sessionKey}: ${err?.message ?? err}`);
    });
    return { wake: true, ...verdict, batch: batch.count, wakeState: st.state };
  }

  /**
   * 下游发出了 `send_*`（hub.js 在出手时调用）——两件事：
   *
   *  ① **"命令静默"判定**：下游应答过就闭嘴（原来的用途）。
   *  ② **进本批**（用户实测："下游bot发的消息没能进入会话"）：下游 bot 说的话也是**这个会话里
   *     发生过的事**，光留在时间线窗口里不够——窗口是"当前状态"，转录里没有它，模型看过就没了。
   *     所以把它推进批量窗口：下一次唤醒的"本批新消息"里就会带上它（`#batchText` 会渲染
   *     `下游→<名字>：…`）。
   *
   * **不叫醒**：只入窗口、不入唤醒判定——"下游已应答 → 保持沉默"这条硬约束不变（只有被叫到才醒）。
   * **休眠期也入批**（v4，`m24409`）：以前有 `state === 'awake'` 门槛，休眠期下游的回应只留在
   * 时间线窗口里、进不了批次——真机 16:12 那轮模型因此完全没看到隔壁 bot 说了什么。批次
   * 在休眠期只会攒着（assist 档的休眠不走节拍、不会被消费），下一次唤醒时随"本批新消息"一起
   * 带进去，正好和开局快照的去重对上（快照只放本批**之前**的）。
   */
  noteDownstreamSend({ sessionKey, action, ts = Date.now(), text, label, linkId, timelineId, entry = null } = {}) {
    if (!sessionKey) return null;
    // 会话白名单（m31030）：没列出的会话连"下游应答过"的账都不记——它永远不会被 flush。
    if (sessionOverrideOf(sessionKey, this.hub?.config) === null) return null;
    const rec = { ts, action: action ?? null };
    this.#outcomes.set(sessionKey, rec);
    const body = String(text ?? '').replace(/\s+/g, ' ').trim();
    const isSend = String(action ?? 'send_msg').startsWith('send_');
    if (body && isSend) {
      const batch = this.#batches.get(sessionKey) ?? new BatchWindow({ size: this.policy.batchSize, ms: this.policy.batchMs });
      batch.push({
        sessionKey,
        direction: 'downstream-in',
        kind: 'action',
        action: action ?? 'send_msg',
        ts,
        text: body,
        // `live`：时间线真身。看图描述/媒体引用是异步回填到 `entry.text` 的（`hub.#enrichImages`
        // 之后还会 `cards.patch`），批次条目只留一份快照文本的话，"本批新消息"永远停在
        // `[回复][图片]`，比开局快照还糙——同一件事两处两个样（v4，`m26571`）。
        live: entry && typeof entry === 'object' ? entry : null,
        actor: { nickname: label || '下游 bot', role: null },
        // `timelineId`：这条在时间线里已有真身（hub.js `record` 的 downstream-in），
        // 开局快照按它去重，免得同一条话在"本批之前"和"本批"各出现一次。
        refs: { downstreamLabel: label ?? null, linkId: linkId ?? null, downstreamSend: true, timelineId: timelineId ?? null },
      });
      this.#batches.set(sessionKey, batch);
    }
    return rec;
  }

  isDownstreamResponded(sessionKey, sinceTs = 0) {
    const rec = this.#outcomes.get(sessionKey);
    if (!rec) return false;
    return sinceTs ? rec.ts >= sinceTs : true;
  }

  /**
   * "下游已应答"这道闸的**回看起点**。
   *
   * 休眠期的批量窗口不会 flush，`openedAt` 可能停在几十分钟前——直接拿它当判据，只要那之后
   * 有过任何一次下游应答，这个会话就被**永久静默**（真机事故 #10：用户 @ 我，我因为隔壁 bot
   * 26 秒前回过别人一句而装死，`woken: 0`、`batches.pending: 7`）。所以取"窗口开启时间"与
   * "最近一个批量窗口时长"里**更晚**的那个：同一轮里的应答照样压得住，陈年老账不算。
   */
  #silenceSince(batch, now = Date.now()) {
    const openedAt = batch?.openedAt ?? 0;
    const lookback = Math.max(1000, Number(this.policy?.batchMs ?? 0) || 8000);
    return Math.max(openedAt, now - lookback);
  }

  /** 这一批里有没有"在叫我"的消息（`@我`/引用我的话/喊昵称；私聊每条都算）。 */
  #calledIn(entries, sessionKey) {
    const sk = String(sessionKey ?? '');
    if (sk.startsWith('private:') && this.policy?.wakeOnPrivate !== false) return true;
    for (const item of Array.isArray(entries) ? entries : []) {
      const event = item?.payload ?? item?.event ?? null;
      const mentions = detectMention(event, {
        selfId: this.liveSelfId,
        nickname: this.nickname,
        nicknames: this.nicknames,
      });
      if (mentions.length) return true;
    }
    return false;
  }

  /** 组装某一会话的上下文（供 `onebot_context` 工具与 flush 共用）。 */
  snapshot(sessionKey, { actorId, windowLimit = 40, budget, audit = true } = {}) {
    const events = this.timeline?.bySession?.(sessionKey, 200) ?? [];
    let digest = buildDigest(events, { maxMessages: 40, maxLines: 12 });
    /**
     * 重启之后内存环是空的（L1 只追加、不回放），会话卡会变成"最近 0 条消息"。
     * 所以环里没有这一会话时，退回落盘的那张卡——它是**重启前**的，`resumed: true` 会
     * 一路标到 prompt 里，模型不会把几天前的话当成刚说的。
     */
    if (!digest.messageCount && !events.length) {
      const stored = this.hub?.cards?.digestFor?.(sessionKey);
      if (stored) digest = stored;
    }
    const windowEntries = events.slice(-windowLimit);
    const memoryEntries = this.store?.all?.() ?? [];
    const worldKey = digest.worldKey ?? sessionKey;
    /**
     * 记忆分块（§24.11）：短期=本会话/本世界的，长期=跨会话的。
     * 模型改写记忆时说的"第 N 条"指的就是这两块里的下标，所以**装配与写入必须看同一份列表**——
     * 这里切好的 `blocks` 会原样回给 `onebot_memory` 校验用。
     */
    const blocks = memoryBlocks(memoryEntries, { sessionKey, worldKey, actorId, isolation: this.isolation });
    /**
     * 主动回忆（§24.6 M18）：代码只交事实（谁、答应了什么、多久前提的、他上次露面是什么时候），
     * 说不说由模型定。这里只做一件事——把 24 小时内已经提过的滤掉（防骚扰安全阀）。
     * **注意**：`snapshot()` 是只读的（`onebot_context` 也会调它），所以这里不记账；
     * 记账在 `flush()` 里真的把这段交给模型之后（否则看一眼上下文就把提醒额度用掉了）。
     */
    const cues = this.hub?.profiles
      ? collectCues({
          persons: this.hub.profiles.persons?.() ?? [],
          sessionKey,
          worldKey,
          actorId,
          isolation: this.isolation,
          limit: this.hub?.config?.reminders?.limit ?? undefined,
        })
      : [];
    const freshCues = this.hub?.reminders ? this.hub.reminders.filter(cues) : cues;
    /**
     * 人设（①）：在 hub 上后挂，没接就空着（装配层会跳过空段）。
     * 人设是**每会话**解析出来的（可能绑在某个预设上），不是全局一份——同一个 bot 在群 A
     * 和群 B 可以是两个角色，这在 master 那版是做不到的。
     */
    const persona = this.hub?.persona?.render?.(sessionKey) ?? '';
    // 表情包清单（④§26）：**必须进上下文**，否则模型会开始编造 id。
    // 条数上限由 memes.topK 控制（默认 8），清单本身由 MemeStore 负责"最近用过的强制入列"。
    const memes = this.hub?.memes?.renderForPrompt?.({ limit: this.hub?.config?.memes?.topK ?? 8 }) ?? '';
    const assembled = assembleContext({
      guidance: this.guidance,
      persona,
      memes,
      sourceHeader: buildSourceHeader({
        selfId: this.liveSelfId,
        nickname: this.nickname,
        sessionKey,
        worldKey,
        // 链路取"最近一条**真实会话**条目"的链路（`agent:*`/`hub:*` 是枢纽自己的账：
        // 拿它们当链路会写出 `【来源】… 链路 agent:memory` 这种莫名其妙的来源——真机就是这么漏的）。
        // 链路优先取**上游**条目（会话是从群里来的）。以前取"最近一条真实条目"，下游 bot 一发言
        // 来源头就写成「链路 down:127.0.0.1:8080」——语义不对（`m02432` P5）。
        linkId:
          [...windowEntries].reverse().find((e) => e?.direction === 'upstream-in' && String(e?.linkId ?? ''))
            ?.linkId ?? this.hub?.upstreamLinkId,
      }),
      digest,
      capabilities: typeof this.capabilities === 'function' ? this.capabilities() : this.capabilities,
      windowEntries,
      memoryEntries,
      memory: blocks,
      person: actorId ? this.hub?.profiles?.person?.(actorId) ?? null : null,
      group: worldKey.startsWith('group:') ? this.hub?.profiles?.group?.(worldKey) ?? null : null,
      cues: freshCues,
      sessionKey,
      worldKey,
      actorId,
      isolation: this.isolation,
      budget,
      selfId: this.selfId,
    });
    // 每次装配都留痕（§24.5）：跨会话记忆的放行/拦截必须可解释、可追溯。
    // `audit:false` 只有 live 上下文那条路用（宿主每次装配都会调它，一次回合可能装配多次，
    // 全记会把审计账本刷满；真正"这一轮"的那次装配仍然记账）。
    if (this.audit && audit) {
      for (const a of assembled.audit) this.audit.add({ ...a, sessionKey, at: Date.now() });
    }
    return { ...assembled, digest, events, cues: freshCues, window: renderWindow(windowEntries, { selfId: this.selfId }) };
  }

  /**
   * **每轮现算**的易变上下文（用户定案）＝ 卡片 / 记忆 / 最近窗口 / cues / 人设 / 表情包清单…
   *
   * 它由宿主的 `systemPrompt.context({ text })` 在**每次装配 prompt 时**调用（那条 `text` 是函数），
   * 所以：① 永远是最新的；② 它进的是 system prompt，**不进会话记录**——不会像以前那样"每轮把
   * 整份上下文塞进用户消息、于是转录里堆 N 份、并且与 system prompt 里的最近窗口前后错位"。
   *
   * 用户消息那边只剩"本批新消息"（见 `#batchText`）。
   */
  liveContext(sessionKey, { actorId } = {}) {
    const key = String(sessionKey ?? '');
    if (!key) return '';
    try {
      return this.snapshot(key, { actorId: actorId ?? this.activeActorId, audit: false }).text;
    } catch (err) {
      // 装配失败不能伪装成"没有上下文"：明说，模型与排查的人都看得见。
      return `（本会话上下文装配失败：${err?.message ?? err}）`;
    }
  }

  /**
   * 本批**新消息**的紧凑文本——这就是每一轮用户消息的全部内容。
   *
   * 卡片/记忆/窗口这类"状态"已经由 `liveContext()` 每轮现算进 system prompt，
   * 所以这里**只写这一批真实发生的事**：转录里因此只剩对话本身，不再叠上下文副本。
   * 每段会话的第一批额外带一份开局快照（`#openingText`，v4）。
   */
  #batchText(sessionKey, batchEntries = [], opening = '') {
    const head = `【新消息 ${batchEntries.length} 条】会话 ${sessionKey}｜现在 ${stampNow()}`;
    const fail = this.#takeSendFailureNotice(sessionKey);
    const parts = [];
    if (fail) parts.push(fail);
    parts.push(head, ...this.#batchLines(batchEntries));
    const body = parts.join('\n');
    // 开局快照放前面：先交代"这段之前发生了什么"，再给这一批的新消息。
    return opening ? `${opening}\n\n${body}` : body;
  }

  /** 批量行渲染（`#batchText` 与插话消息共用；正文取真身，见 m26571）。 */
  #batchLines(batchEntries = []) {
    const lines = [];
    for (const entry of batchEntries) {
      const actor = entry?.actor ?? {};
      const who = actor.nickname || actor.card || actor.user_id || (entry?.direction === 'downstream-in' ? '下游' : '某人');
      const role = actor.role ? `(${actor.role})` : '';
      const via = entry?.direction === 'downstream-in' ? '下游→' : entry?.direction === 'downstream-out' ? '我→' : '';
      // 文本取真身（`live`）优先：看图描述是异步回填的，渲染时读真身才能带上 `[图片：…]`
      // ——否则本批比开局快照还糙，同一件事两个样（`m26571`）。
      const raw = entry?.live && typeof entry.live.text === 'string' && entry.live.text ? entry.live.text : entry?.text;
      const text = String(raw ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim();
      // 逐条带日期时间（`m34049` 用户要求"所有消息都加上日期和时间"）：批头那个"现在"只是
      // 凑批时刻——群里攒批常常跨好几分钟，"08:12 那条"是哪天说的只有行内时间说了算。
      lines.push(`- ${mdhm(entry?.ts)} ${via}${who}${role}：${text}`);
    }
    return lines;
  }

  /** 修3 的一次性失败告知（取走即清）。主 flush 与插话消息共用，谁先带出去谁消费。 */
  #takeSendFailureNotice(sessionKey) {
    const fail = this.#sendFailures.get(this.agentKeyOf(sessionKey)) ?? null;
    if (!fail) return null;
    this.#sendFailures.delete(this.agentKeyOf(sessionKey));
    const detail = `status=${fail.status}${fail.retcode != null ? ` retcode=${fail.retcode}` : ''}${fail.error ? ` ${fail.error}` : ''}`;
    // 一次调用发多条时要说清"第几条没发出去、后面几条根本没发"（m32420）。
    const where = fail.of > 1 ? `第 ${fail.part}/${fail.of} 条没发出去${fail.rest ? `，后面 ${fail.rest} 条也因此没发` : ''}` : '回复没发出去';
    return `【系统提示】你上一轮排队的${where}（${detail}）：「${fail.text}」。别当成已经说过话——要么用 onebot_reply 重试，要么这轮就沉默。`;
  }

  /** 插话消息的正文：与 `#batchText` 同一套渲染，只换头（【插话 N 条】）且不带开局快照（本段已给过）。 */
  #steerMessage(sessionKey, batchEntries = []) {
    const head = `【插话 ${batchEntries.length} 条】会话 ${sessionKey}｜现在 ${stampNow()}`;
    const fail = this.#takeSendFailureNotice(sessionKey);
    const parts = [];
    if (fail) parts.push(fail);
    parts.push(head, ...this.#batchLines(batchEntries));
    return parts.join('\n');
  }

  /**
   * 开局快照（v4，`m24409` 用户定案）：**每段会话的第一批**带一份"这段开始之前发生过什么"。
   *
   * 为什么需要：交还转录后每次激活都是新会话（`#retireAfterDormant`），系统提示里又不再有
   * 会话卡/最近窗口（v4 把它们移出了快照）——没有这份快照，模型对"上一段聊到哪了"一无所知。
   * 为什么只给一次：它是状态不是事件，第二批再给就是重复注入（用户要解决的正是这个问题）。
   * 为什么只放"本批之前"：本批消息马上会以【新消息 N 条】出现，两处都有就是同一条话注入两遍。
   */
  #openingText(sessionKey, batchEntries = [], snapshot = null) {
    if (this.#openingPresented.has(sessionKey)) return '';
    this.#openingPresented.add(sessionKey);
    const events = snapshot?.events ?? [];
    // 去重两道：①按时间线 id（本批条目就是时间线条目；下游批次条目带 `refs.timelineId`）；
    // ②按归一化正文兜底（测试钩子/老路径没给 id 时，同文同归一也算同一条）。
    const presentedIds = new Set();
    const presentedTexts = new Set();
    const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    // 本批条目的正文取真身（`m26571`）：去重要跟"渲染时读到的那份"对齐——
    // 否则描述晚到一步时，本批是 `[图片]`、卡里是 `[图片：描述]`，文本去重失配，同一条进两遍。
    const bodyOf = (b) => (b?.live && typeof b.live.text === 'string' && b.live.text ? b.live.text : b?.text);
    for (const b of batchEntries) {
      if (b?.id != null && b.id !== '') presentedIds.add(String(b.id));
      const tid = b?.refs?.timelineId;
      if (tid != null && tid !== '') presentedIds.add(String(tid));
      const t = norm(bodyOf(b));
      if (t) presentedTexts.add(t);
    }
    const before = events.filter((e) => e && !presentedIds.has(String(e?.id ?? '')) && !presentedTexts.has(norm(e?.text)));
    const window = renderWindow(before, { selfId: this.selfId });
    const digest = snapshot?.digest ?? null;
    if (!window) {
      /**
       * 重启后的第一批：环里"本批之前"是空的（L1 只追加、不回放），但落盘的那张会话卡
       * 还记着重启前聊到哪——它就是这份快照要交代的"这段之前的事"。按本批正文滤一遍，
       * 免得马上要以【新消息】出现的那条又被卡说一次。
       */
      const stored = digest?.resumed ? digest : (this.hub?.cards?.digestFor?.(sessionKey) ?? null);
      // 两道过滤：正文（老卡没记 id 时的兜底）**和 id**（`m26571`——会话卡行带
      // `line.id`= 时间线 id，本批条目带 `refs.timelineId`，两边能对上；只比正文的话，
      // 「快照写的是 `↩回复「…」[图片：描述]（已存为 hub-media:…）」、「本批写的是 `[回复][图片]`」
      // 永不相等，同一条话会在快照和新消息里各出现一次）。
      const oldLines = (stored?.lines ?? []).filter((l) => (
        (l?.id != null && l.id !== '' ? !presentedIds.has(String(l.id)) : true)
        && !presentedTexts.has(norm(l?.text))
        // 存量卡里的空行（旧版本把提不出文本的下游动作也记了行）不进快照。
        && String(l?.text ?? '').trim() !== ''
      ));
      if (!oldLines.length) return '';
      const out = [`【开局快照】本段开始之前的事${stored?.resumed ? '（含重启前的旧事，不是刚刚）' : ''}`];
      out.push('最近：', ...oldLines.map((l) => {
        const who = l?.direction === 'hub-out' ? '我' : String(l?.actor ?? '某人');
        return `- ${mdhm(l?.ts)} ${who}：${String(l?.text ?? '').replace(/\s+/g, ' ').trim()}`;
      }));
      if (stored?.resumed) out.push('（这些是本段开始之前说的，不是刚刚。）');
      return out.join('\n');
    }
    const people = (digest?.participants ?? []).slice(0, 8).map((p) => {
      const name = p.nickname ?? String(p.user_id);
      const badge = p.role && p.role !== 'member' ? `/${p.role}` : '';
      return `${name}${badge}(${p.count})`;
    });
    const head = `【开局快照】本段开始之前的事${digest?.resumed ? '（含重启前的旧事，不是刚刚）' : ''}`;
    const out = [head];
    if (people.length) out.push(`参与者：${people.join('、')}`);
    out.push(window);
    return out.join('\n');
  }

  /**
   * 看图（M14-V）的第二种手段：会话代理自己看得见，就把图片本体作为内容段给它。
   * 只在 `vision.mode` 含 `segment`、且模型确实声明了图片输入能力时才给——宿主客户端
   * 对不支持的模型会直接抛 `does not support image input`，那一轮就白跑了。
   */
  async segmentPartsFor(events = []) {
    const vision = this.hub?.vision;
    if (!vision?.segmentEnabled || !vision.enabled) return null;
    const refs = [];
    for (let i = events.length - 1; i >= 0 && refs.length === 0; i -= 1) {
      for (const ref of events[i]?.media ?? []) if (ref?.kind === 'image') refs.push(ref);
    }
    if (!refs.length) return null;
    if (!(await vision.imageCapable())) {
      this.hub?.log?.(`看图：模型 ${vision.provider || '(默认)'}/${vision.model || '(默认)'} 不支持图片输入，本轮只用文本`);
      return null;
    }
    const parts = vision.segmentParts(refs);
    return parts.length ? parts : null;
  }

  /**
   * 插话（m31311 用户定案，宿主原语 `steer`/next-step）：回合在飞时把积压直接递进去。
   *
   * **结算只归主 flush**：steer 成功后 `whenIdle()` 覆盖插话延长的回合，主 flush 的
   * `await whenIdle()` 与这里的 waiter 等到同一个空闲点——回复缓冲的 take/deliver、
   * 发言结算（`#noteSpokeOutcome`）都由主 flush 一次做完；插话路径只递消息，不碰
   * 回复缓冲/账本/轮次序号，避免双计"沉默轮"把激活误打回休眠。
   *
   * 静默闸与主 flush 同口径（被叫到的那批不受它管）；steer 失败/会话不在飞一律回落
   * 普通排队（返回 `batch:in-flight`，消息留在窗口里，等下一次触发正常结算）。
   */
  async #trySteer(sessionKey, { reason } = {}) {
    if (this.readonly) return { woke: false, reason: 'batch:in-flight' };
    if (this.hub?.config && this.hub.config.agentSteer === false) return { woke: false, reason: 'batch:in-flight' };
    if (this.#steering.has(sessionKey)) return { woke: false, reason: 'steer:pending' };
    const batch = this.#batches.get(sessionKey);
    if (!batch || !batch.count) return { woke: false, reason: 'batch:empty' };
    if (typeof this.pool?.steer !== 'function') return { woke: false, reason: 'batch:in-flight' };
    const peeked = [...batch.entries];
    const calledNow = this.#calledIn(peeked, sessionKey);
    if (!calledNow && this.policy.silenceWhenDownstreamResponded && this.isDownstreamResponded(sessionKey, this.#silenceSince(batch))) {
      // 不插也不排水：留给下一轮正常 flush 结算（那边会 stats.silent+1 并照常轮转窗口）。
      return { woke: false, reason: 'silent:downstream-responded' };
    }
    const wait = this.pool.steer(this.agentKeyOf(sessionKey), {
      text: this.#steerMessage(sessionKey, peeked),
      summary: `插话 ${peeked.length} 条`,
    });
    if (!wait) return { woke: false, reason: 'batch:in-flight' };
    batch.flush(); // 已递给宿主才排水；不在飞/失败时消息留在窗口，不丢
    const task = (async () => {
      this.stats.steered += peeked.length;
      this.stats.lastSteer = { at: Date.now(), sessionKey, reason: reason ?? null, count: peeked.length };
      this.log(`会话 ${sessionKey} 插话 ${peeked.length} 条（${reason ?? 'manual'}）`);
      await wait();
    })();
    this.#steering.set(sessionKey, task);
    try {
      await task;
    } catch (err) {
      this.stats.errors += 1;
      this.log(`插话等待失败 ${sessionKey}: ${err?.message ?? err}`);
    } finally {
      this.#steering.delete(sessionKey);
    }
    return { woke: true, reason: `steer:${reason ?? 'manual'}`, steered: peeked.length };
  }

  /**
   * 真正唤醒一轮。
   * @returns {Promise<{woke:boolean, reason:string, reply?:string, context?:object}>}
   */
  async flush(sessionKey, { reason = 'manual', actorId, budget } = {}) {
    const batch = this.#batches.get(sessionKey);
    if (!batch || !batch.count) return { woke: false, reason: 'batch:empty' };
    // 回合在飞（m31311 用户定案）：不再排队等下一轮，把积压**插话**进正在跑的回合；
    // 不在飞/不支持/插话中 → 维持原语义（`batch:in-flight`，消息留窗，等下一次触发）。
    if (this.#flushing.has(sessionKey)) return this.#trySteer(sessionKey, { reason });

    const openedAt = batch.openedAt ?? 0;
    // 工具是在"某一轮"里被调用的：这轮里没有显式给 sessionKey 的调用（onebot_memory 等）
    // 都要落回同一个会话，否则模型会往别的会话的记忆里写东西。
    this.activeSessionKey = sessionKey;
    if (actorId) this.activeActorId = String(actorId);
    /**
     * 轮次序号：只在内存里递增，用来给"每轮限额"这类工具当作用域
     * （`imageGen.maxPerTurn`）。它不需要跨进程稳定——限额只管这一轮。
     */
    this.turnSeq = (this.turnSeq ?? 0) + 1;
    const task = (async () => {
      const batchEntries = batch.flush();
      // 只读：批次照收照丢，但绝不往下走（不装配、不叫模型、不发消息）。
      // 放在 `batch.flush()` 之后是为了让批量窗口正常轮转，不留下永远不结算的窗口。
      if (this.readonly) {
        this.stats.readonly += 1;
        return { woke: false, reason: 'readonly' };
      }
      /**
       * 静默闸（真机事故 #10）：① **被叫到的那一批不受它管**——人家点名找我，
       * 隔壁 bot 刚回过别人一句不是我装死的理由；② 回看起点取
       * `#silenceSince()`（窗口开启时间与最近一个 batchMs 里更晚的那个），
       * 免得休眠期那个永不 flush 的旧窗口把会话永久压死。
       */
      const calledNow = this.#calledIn(batchEntries, sessionKey);
      if (!calledNow && this.policy.silenceWhenDownstreamResponded && this.isDownstreamResponded(sessionKey, this.#silenceSince({ openedAt }))) {
        this.stats.silent += 1;
        return { woke: false, reason: 'silent:downstream-responded' };
      }

      const snapshot = this.snapshot(sessionKey, { actorId, budget });
      if (this.store) this.store.addMany(buildObservedEntries(snapshot.events));

      if (!this.pool) {
        return { woke: false, reason: 'dry-run', context: { text: snapshot.text, sections: describeSections(snapshot.sections) } };
      }

      const agentKey = this.agentKeyOf(sessionKey);
      /**
       * 回复缓冲**每个 agent 一份、跨轮复用**（真机事故修正）。
       *
       * 会话级的 `onebot_reply` 工具是 `setup` 时注册的，而 `pool.ensure()` 只在会话**首次**
       * 建立时跑 setup——后来每一轮 `resume` 都不会再注册一次。早先这里每轮 `new ReplyBuffer()`，
       * 于是"模型调了工具、工具写进了第一轮那个缓冲、我这边却在读新缓冲"：候选永远为空，
       * 兜底逻辑转而把 assistant 的收尾文本当成发言发出去（线上真发出过「（已回：…）」这种旁白）。
       * 复用的代价只是要在开轮前 clear 一次，别把上一轮没取走的候选混进来。
       */
      const reply = this.#replyFor(agentKey);
      reply.clear();
      this.#feed.set(agentKey, this.#newFeed(agentKey)); // 本轮重新开账，避免读到上一轮的话
      const summary = `会话 ${sessionKey} 有新消息（${snapshot.digest.messageCount} 条）`;
      const parts = await this.segmentPartsFor(snapshot.events);
      /**
       * 用户消息**只放本批新消息**（用户定案）：易变上下文已经由 `liveContext()` 走 system prompt
       * 现算了，再往这里塞一份就是重复——而且会滞留在转录里，让旧上下文排到"最近窗口"前面。
       * 每段会话的第一批额外带开局快照（本批**之前**发生的事，只给一次，v4）。
       */
      const opening = this.#openingText(sessionKey, batchEntries, snapshot);
      const result = await this.pool.wake(agentKey, {
        text: this.#batchText(sessionKey, batchEntries, opening),
        summary,
        parts,
        setup: this.setup ? (agentCtx) => this.setup(agentCtx, { reply, mind: this, sessionKey, agentKey }) : undefined,
      });
      // 唤醒本身失败（例如宿主报 "session already exists"）不能算"叫醒过"，要单独计数，
      // 否则线上看到 woken 在涨、却一条消息都没回，会误判成"模型不愿说话"。
      const ok = result?.ok !== false;
      if (ok) this.stats.woken += 1;
      else this.stats.errors += 1;
      // 再进 prompt 要等 24 小时（§24.6 的防骚扰安全阀）。只在**真的交给模型之后**记账：
      // 唤醒失败不算提过，否则一次宿主抖动就能让这条承诺沉默一整天。
      if (ok && snapshot.cues?.length) this.hub?.reminders?.note(snapshot.cues);

      const candidate0 = reply.take();
      const feed = this.#feed.get(agentKey) ?? null;
      let candidate = candidate0;
      let spokeFrom = candidate ? 'tool' : 'none';
      // 文本兜底**默认关**（m30383 用户定案：发言只走 onebot_reply 工具，回复文本只是内部草稿，
      // 收尾旁白从此没有进群的路）。`agent.speakAssistantText=true` 是逃生门，恢复"文本=发言"的
      // 老行为；逃生门下"不想说话"仍用整句括号旁白表达（isSilentMarker）。
      if (!candidate && ok && this.policy.speakAssistantText === true && feed?.assistantText) {
        const text = String(feed.assistantText).trim();
        if (text && !isSilentMarker(text)) {
          candidate = reply.capture({ text });
          spokeFrom = 'assistant-text';
        }
      }
      const delivered = candidate ? await this.deliver(sessionKey, candidate) : null;
      /**
       * 唤醒状态机记一笔：这一轮到底开口没有。
       * 连续 `AWAKE_SILENT_TURNS` 轮不说话 → 回休眠（用户定的"agent 认为无需回复就回休眠"）。
       * 记账点选在"候选已定、投递已发"之后：只有真正有话说才续命，被上游拒收也算说过话
       * （它确实开了口，不该因为发送失败就当成沉默）。
       */
      const wakeState = this.#noteSpokeOutcome(sessionKey, Boolean(candidate));
      /**
       * 这一轮到此为止——**回合结束也算一次"动静"**（m34646 用户定案："agent 回复完后等待
       * awakeMs 再休眠"）。记在结算处而不是 `#enterAwake`：额度该从"说完"重新算，
       * 否则一个长回合 + `active` 节拍的延迟就把 `awakeMs` 提前烧光，回完话立刻睡回去。
       */
      if (wakeState) wakeState.lastTurnAt = Date.now();
      // 留一条"最近一轮"诊断：真宿主的会话文件要等关闭才落盘，光看 sent=0 分不清
      // 「模型没调 onebot_reply」还是「唤醒本身失败了」，所以把这几件事分开记。
      this.stats.lastTurn = {
        sessionKey,
        at: Date.now(),
        reason,
        ok,
        error: ok ? null : (result?.error ?? 'unknown'),
        hadReply: Boolean(candidate),
        spokeFrom,
        // 这一轮结束时这个会话的睡/醒状态（连续沉默会把激活打回休眠）。
        wakeState: wakeState?.state ?? null,
        silentTurns: wakeState?.silentTurns ?? null,
        // 唤醒前摘掉归档门控的结果（`archived:true` 说明这一轮原本会以 blocked 结束）。
        unarchive: result?.unarchive ?? null,
        reply: candidate ? describeReply(candidate) : null,
        sent: Boolean(delivered?.sentCount > 0),
        sentCount: delivered?.sentCount ?? 0,
        totalMessages: delivered?.total ?? 0,
        failedAt: delivered?.failedAt ?? null,
        retcode: delivered?.retcode ?? null,
        diag: feed
          ? {
              turn: feed.turn,
              turnEnd: feed.turnEnd,
              turnError: feed.turnError,
              interrupted: feed.interrupted,
              assistantText: truncate(feed.assistantText, 200),
              toolCalls: feed.toolCalls,
              toolResults: feed.toolResults,
            }
          : null,
      };
      return {
        woke: true,
        reason,
        agentKey,
        reply: describeReply(candidate),
        delivered,
        sections: describeSections(snapshot.sections),
        result,
        wakeState: wakeState?.state ?? null,
      };
    })();

    this.#flushing.set(sessionKey, task);
    try {
      return await task;
    } catch (err) {
      this.stats.errors += 1;
      return { woke: false, reason: 'error', error: String(err?.message ?? err) };
    } finally {
      this.#flushing.delete(sessionKey);
    }
  }

  /**
   * 把候选回复发给上游（OneBot `send_msg`）——**一次调用可能有多条消息**（m32420）。
   *
   * 三条规矩（都是用户定的）：
   *  1. 条与条之间有固定间隔（`agent.replyGapMs`，默认 400ms）——连发太快不像人在打字。
   *  2. **第 k 条失败即停**，剩下不发。失败必须让模型知道（下一批开头告知），
   *     否则它会以为整段话说完了（修3 的老事故：`failed -1935986436` 后 agent 仍以为说出口了）。
   *  3. 只读预设**一个字节都不发**——"绝不动作"这种承诺不该只靠上游调用点的自觉。
   */
  async deliver(sessionKey, candidate) {
    if (this.readonly) {
      this.stats.readonly += 1;
      this.log(`只读预设：放弃发送（${sessionKey}）`);
      return null;
    }
    const messages = Array.isArray(candidate?.messages) && candidate.messages.length
      ? candidate.messages
      : [{ segments: candidate?.segments ?? [], text: candidate?.text ?? '', kind: 'text' }];
    const gapMs = Math.max(0, Number(this.hub?.config?.replyGapMs ?? 400) || 0);
    const results = [];
    for (const [i, msg] of messages.entries()) {
      if (i > 0 && gapMs > 0) await sleep(gapMs);
      const { action, params } = buildSendParams({
        segments: msg.segments,
        sessionKey,
        messageType: candidate.messageType,
        groupId: candidate.groupId,
        userId: candidate.userId,
      });
      let response = null;
      if (this.hub?.callUpstream) {
        response = await this.hub.callUpstream(action, params);
      }
      const status = response?.status ?? 'no-hub';
      const ok = !this.hub?.callUpstream || status === 'ok';
      this.timeline?.record?.({
        direction: 'hub-out',
        linkId: this.hub?.upstreamLinkId ?? 'hub',
        selfId: this.selfId,
        action,
        params,
        decision: status === 'failed' ? 'failed' : 'sent',
        text: msg.text,
        refs: { sessionKey, part: i + 1, of: messages.length },
      });
      if (ok) this.stats.sent += 1;
      this.lastActedAt = Date.now();
      results.push({ index: i + 1, kind: msg.kind, text: msg.text, status, ok, retcode: response?.retcode ?? null });
      if (!ok) {
        // 修3 的告知升级成"第几条没发出去、后面几条没发"：模型才知道该重试多少。
        const rest = messages.length - i - 1;
        this.#sendFailures.set(this.agentKeyOf(sessionKey), {
          text: truncate(candidate.text ?? '', 120),
          status,
          retcode: response?.retcode ?? null,
          error: response?.error ?? response?.message ?? response?.msg ?? null,
          at: Date.now(),
          part: i + 1,
          of: messages.length,
          rest,
        });
        break;
      }
    }
    const first = results[0] ?? { action: 'send_msg', status: 'no-hub', retcode: null };
    const failedAt = results.findIndex((r) => !r.ok);
    return {
      action: 'send_msg',
      params: messages[0] ? buildSendParams({
        segments: messages[0].segments,
        sessionKey,
        messageType: candidate.messageType,
        groupId: candidate.groupId,
        userId: candidate.userId,
      }).params : null,
      status: failedAt >= 0 ? 'failed' : first.status,
      retcode: first.retcode ?? null,
      sentCount: results.filter((r) => r.ok).length,
      total: messages.length,
      failedAt: failedAt >= 0 ? failedAt + 1 : null,
      results,
    };
  }

  /**
   * 定时器每 `agent.tickMs` 调一次：决定"现在该不该醒"。
   *
   * 两种时机（`m01733` 的规格）：
   *   · **激活中**：批量窗口攒够条数/到期 → 再唤醒一次（`batch:full` / `batch:timeout`）。
   *   · **休眠 + `active` 档**：每 `activeTickMs` 看一眼该会话有没有新消息（窗口里有东西就是有），
   *     有就唤醒一次并进激活（`tick:active`）；没有就什么都不做，等下一次。
   *     `assist` 的休眠会话**不靠节拍**——只有被叫到才醒。
   */
  async scanDue(now = Date.now()) {
    const due = [];
    for (const [sessionKey, batch] of this.#batches) {
      // 白名单自愈（m31030）：不该存在的批直接丢掉（配置改过/测试注入残留），别让它等着叫人。
      if (sessionOverrideOf(sessionKey, this.hub?.config) === null) {
        this.#batches.delete(sessionKey);
        continue;
      }
      if (!batch.count) continue;
      const st = this.#wakeStateFor(sessionKey, now);
      /**
       * 下游本轮已应答 → 硬静默（激活与否都不说话）。回看起点走 `#silenceSince()`：
       * 休眠窗口可能几十分钟没 flush，用它的 `openedAt` 当判据会把会话永久压死（事故 #10）。
       * 批里有 @ 我 / 私聊的那种"被叫到"不在节拍路径上（那走 `observe`），所以这里只看时间和窗口。
       */
      const silenceNow = () =>
        this.policy.silenceWhenDownstreamResponded &&
        this.isDownstreamResponded(sessionKey, this.#silenceSince(batch, now));

      if (st.state !== 'awake') {
        // `active` 档按会话判定（m31030）：某群覆盖成 active 才有节拍唤醒，assist/observer 不节拍。
        if (this.#policyFor(sessionKey).mode !== 'active') continue;
        const tick = Number(this.policy.activeTickMs ?? 0);
        if (!(tick > 0) || now - (st.lastCheckAt ?? 0) < tick) continue;
        st.lastCheckAt = now;
        if (silenceNow()) {
          batch.flush();
          this.stats.silent += 1;
          continue;
        }
        this.#enterAwake(sessionKey, st, now, 'tick:active');
        due.push({ sessionKey, reason: 'tick:active' });
        continue;
      }

      const verdict = batch.shouldFlush(now);
      if (!verdict.flush) continue;
      if (silenceNow()) {
        batch.flush();
        this.stats.silent += 1;
        continue;
      }
      due.push({ sessionKey, reason: verdict.reason });
    }
    return Promise.all(due.map(({ sessionKey, reason }) => this.flush(sessionKey, { reason })));
  }

  async tick(now = Date.now()) {
    // 先处理"激活空转超时"：睡回去的会话不该在同一拍里又被节拍叫醒（下一条消息才重新计时）。
    const dormant = this.#expireAwake(now);
    const flushed = await this.scanDue(now);
    const disposed = this.pool?.disposeIdle?.(now) ?? [];
    return { flushed, dormant, disposed };
  }

  get statsSnapshot() {
    const whitelistCfg = this.hub?.config ?? {};
    return {
      ...this.stats,
      /** 会话白名单现状（m31030）：多少群/私聊被允许喂模型（`unlisted` 计数是被挡掉的消息数）。 */
      whitelist: {
        groups: Object.keys(whitelistCfg.agentGroups ?? {}).length,
        privates: Object.keys(whitelistCfg.agentPrivates ?? {}).length,
      },
      batches: [...this.#batches.entries()].filter(([, b]) => b.count).map(([k, b]) => ({ sessionKey: k, pending: b.count })),
      wakeStates: [...this.#wakeStates.entries()].map(([k, v]) => ({ sessionKey: k, ...v })),
      /** 插话在飞的会话（m31311）：排查"这条消息怎么插进回合的"时看这里。 */
      steering: [...this.#steering.keys()],
      /** 最近一次观察的判定明细：`reason` 就是"它为什么不醒"。 */
      lastObserve: this.lastObserve ?? null,
      /** "我是谁"：@ 匹配用的账号与一组名字（配置 + 学到的），排查"被 @ 了不醒"先看这里。 */
      identity: this.identity(),
      agents: this.pool?.list?.() ?? [],
      pool: this.pool?.stats ?? null,
    };
  }
}
