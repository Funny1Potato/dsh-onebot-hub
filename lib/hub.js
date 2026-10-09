/**
 * Hub：把协议层、策略层、传输层缝在一起。
 *
 * 一条上游链路（hub 拨号真实现端）+ N 条下游链路（下游 bot 拨号 hub）。
 * 上游来的真实事件按策略**零改写下发**给下游；下游发来的 action 按策略
 * 本地答 / 捕获 / 转发上游 / 广播。hub 在两侧都是"对端",但语义不同：
 *  - 面对下游，hub 是**实现端**（必须真答 send_msg / get_msg / …）；
 *  - 面对上游，hub 是**客户端**（只用同协议转发）。
 */

import path from 'node:path';
import { CaptureLog, Timeline } from './capture.js';
import { DownstreamDialer, DownstreamEndpoint, DownstreamHttpListener, UpstreamEndpoint, UpstreamListener } from './link.js';
import {
  MEDIA_SEGMENT_TYPES,
  isMessageEvent,
  makeResult,
  messageToText,
  readTrace,
  remapAt,
  renderCq,
  replyTargetId,
  retagEvent,
  segmentsFromParams,
  segmentsOf,
  sessionKey,
  eventKind,
  stripInlineMedia,
} from './protocol.js';
import { LoopGuard } from './trace.js';
import { VirtualWorld, isGlobMatch, isLocalAction } from './virtual-world.js';
import { decideAction, decideEvent, describePolicy, resolvePolicy } from './router.js';
import { JsonStore, JsonlLog, safeName } from './storage.js';
import { Profiles, nameIn } from './profile.js';
import { RecallStore } from './memory/recall.js';
import { Reminders } from './memory/cues.js';
import { Cards } from './memory/cards.js';
import { MemberResolver } from './members.js';
import { TurnIndex } from './turns.js';
import { CapabilityMap } from './learn.js';
import { describeEvent } from './segments.js';
import { MediaStore, publicMediaRef } from './media.js';
import { Vision } from './vision.js';
import {
  CapabilityCache,
  CapabilityRegistry,
  baseAction,
  isSensitive,
  shapeResult,
  tierOf,
  toWireResponse,
  ttlOf,
} from './capability.js';

/** OneBot v11 的 id 字段是 JSON 数字，但配置里是字符串；能转数字就转。 */
function numericId(value) {
  const n = Number(value);
  return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : value;
}

/** 某个 action 是否落在允许名单里（支持 `*` 通配；没配就是空名单 = 全拒）。 */
function isAllowedAction(allow, action) {
  if (!Array.isArray(allow)) return false;
  return allow.some((pattern) => isGlobMatch(String(pattern), action));
}

/**
 * 这条下游目标是不是"账号得靠上游"的（§19）：拨号/POST 型又没写"对方账号"。
 *
 * 为什么要单独一个判定：这两种形态**必须**在握手/推送头里报出对方账号，没有身份就建不了链；
 * 而 `ws-listen`/`http-api` 是对方来找我们，不写账号也照样能跑。
 */
function needsUpstreamAccount(target) {
  const type = target?.type ?? 'ws-dial';
  if (type !== 'ws-dial' && type !== 'http-post') return false;
  return String(target?.selfId ?? '') === '';
}

export class Hub {
  #worlds = new Map();
  #dialers = new Map();
  /** 监听型目标（`ws-listen`/`http-api`）自己的 http 端口，按目标 id 存。 */
  #listeners = new Map();
  /** `http-post` 目标的推送计数（没有 socket，健康度只能自己数）。 */
  #posters = new Map();
  /** 配置里声明的下游目标（含被禁用的）——状态里要看得见"配了但没拨"。 */
  #targets = [];
  /**
   * 学到的上游账号（配置 `upstreamSelfId` 没写时用）。`null` = 还不知道。
   *
   * 存在的原因见 `learnUpstreamAccount`：配置解析在**上游连上之前**，而"下游不写对方账号 =
   * 与上游相同"这条规则要有账号才能兑现，所以账号晚到了得有个补建的机会。
   */
  #upstreamAccount = null;
  /** 学到的上游**真昵称**（`get_login_info` / 能力探测那条路；手打 `@昵称` 靠它）。 */
  #upstreamNickname = null;
  #upSeq = 0;
  #virtualSeq = 0;
  #injectedSeq = 0;
  #probedConnects = -1;
  /**
   * 探针独占窗口（M7-④ 时间隔离，§19）：`sessionKey -> {sessionKey, openedAt, until, queue, probes}`。
   *
   * 语义：agent 拿 `onebot_invoke` 往某个会话注入一条命令之后，这个会话在 `windowMs` 之内是
   * **注入的**——期间上游来的真人消息**不投下游**，只排进 `queue`；窗口一到按原序补发。
   * 这样"下游这条回复是注入引起的"就成立得干净，不用事后靠时间戳猜。
   *
   * 三条硬规矩：① **绝不吞消息**——排队的每一条最终都会投（窗口结束补发，或超限时立刻补发）；
   * ② 只在 `probe.isolation === 'time'` 时启用；③ 只对**消息类**事件生效（通知/请求照旧直投）。
   */
  #probeWindows = new Map();
  #probeTimer = null;
  #probeStats = { windowsOpened: 0, held: 0, released: 0, forcedReleases: 0, injections: 0 };
  /** 保留期清理的定时器与最近一次结果（`retention` 配置；状态里可见）。 */
  #retentionTimer = null;
  #retentionStats = null;

  /**
   * 只读（`shadow` 预设，或用 `readonly: true` 显式打开）：**hub 自己绝不动作**——
   * 不唤醒 agent（不花 token）、不代答聊天命令。事件该广播还是广播：只读的是 hub 的手，
   * 不是下游的眼睛（`mind.js` 与 `#answerChatCommand` 读这个开关）。
   */
  get readonly() {
    return this.policy.event?.readonly === true;
  }

  constructor(config = {}, { log, hooks } = {}) {
    this.config = config;
    this.log = log ?? (() => {});
    /** 编排层钩子（§21）：`onUpstreamEvent(entry, ctx)` / `onDownstreamSend(ctx)` / `onUpstreamAccount({selfId,source})`。 */
    this.hooks = { ...(hooks ?? {}) };
    this.policy = resolvePolicy(config);
    this.guard = new LoopGuard({
      windowMs: config.echoWindowMs ?? 3000,
      maxHop: config.maxHop ?? 3,
    });
    this.timeline = new Timeline({
      limitGlobal: this.policy.limits.timelineGlobal,
      limitSession: this.policy.limits.timelinePerSession,
    });
    this.capture = new CaptureLog({ limit: this.policy.limits.captureLogSize });
    // 监听地址里**带着路径**（`parseListenTarget` 解析出来的 `path`，没写就是根路径 `/`），
    // 所以链路 id 也把它带上。
    this.upstreamLinkId = config.upstreamListen
      ? `up:listen:${config.upstreamListen.host}:${config.upstreamListen.port}${config.upstreamListen.path ?? '/'}`
      : `up:${config.upstreamUrl ?? 'none'}`;
    this.upstream = null;
    this.downstream = null;
    // ---- 能力面（§22）：缓存 + 能力注册表，两侧消费者共用（agent 问 / 下游问） ----
    this.cache = new CapabilityCache();
    this.capabilities = new CapabilityRegistry();
    /**
     * 能力结论落盘（§22.1-3 / §24.10）：路径 `<storageDir>/capabilities/<linkId>.json`。
     * `config.storageDir` 为空 = 关闭（不建目录、不写文件）。
     */
    this.storage = new JsonStore({ dir: config.storageDir ?? '', log: this.log, debounceMs: config.storageDebounceMs });
    this.capabilityFile = `capabilities/${safeName(this.upstreamLinkId)}.json`;
    this.storageMeta = { loaded: false, loadedAt: null, registryEntries: 0, cacheEntries: 0 };
    /**
     * 用法学习（§17 M7）：从回合配对里学"下游吃什么消息"，够阈值才升 active。
     * 不参与任何决策、不发消息——它只是把观测变成知识库，供 L3 注入与 agent 查询。
     */
    this.learn = new CapabilityMap({
      linkId: this.upstreamLinkId,
      log: this.log,
      threshold: config.learn?.threshold,
      staleAfter: config.learn?.staleAfter,
      forgetAfter: config.learn?.forgetAfter,
      maxEvidence: config.learn?.maxEvidence,
      // 表一变就合并落盘（`JsonStore.schedule` 防抖，多喊几次不亏）。
      onChange: () => this.#persistCapabilities(),
    });
    this.#loadCapabilities();
    /**
     * 人物 / 群 / 话题档案（§24.2 M16）：**系统字段由代码写**（名字、群名片、角色是观测，
     * 不是提炼），模型能碰的只有 `facts/interests/commitments/corrections/impression` 这些。
     * 可见性判断不在这里，统一在 `lib/memory/writer.js`。
     */
    this.profiles = new Profiles({ storage: this.storage, log: this.log });
    /**
     * L1 原始层与检索索引（§24.9 M17）：
     *  - 时间线内存环会被上限裁掉，`timeline/<linkId>/<yyyymmdd>.jsonl` 才是"翻得到过去"的那份；
     *  - 检索层自己带可见性过滤（能搜到 ≠ 能看见），所以索引与 L1 由它一起管。
     * `store`（MemoryStore）是 index.js 后挂上来的，那时要同步给 `recall.store`。
     */
    this.timelineLog = new JsonlLog({
      dir: this.storage.enabled ? path.join(this.storage.dir, 'timeline') : '',
      log: this.log,
    });
    this.recall = new RecallStore({
      dir: this.storage.enabled ? path.join(this.storage.dir, 'recall') : '',
      linkId: this.upstreamLinkId,
      log: this.log,
      store: this.store ?? null,
    });
    /**
     * L2 会话卡落盘（§24.10）：L1 只追加、启动不回放，所以重启后内存环是空的——
     * 卡片落一份下来，重启之后至少还知道"刚才在聊什么"（读回来会明确标注是重启前那份）。
     */
    this.cards = new Cards({
      storage: this.storage,
      log: this.log,
      maxLines: this.config.cards?.maxLines,
      maxSessions: this.config.cards?.maxSessions,
    });
    this.cards.load();
    this.timeline.onRecord = (entry) => {
      const row = this.recall.rowOf(entry);
      this.timelineLog.append(this.upstreamLinkId, row);
      this.recall.append(entry);
      this.turns?.record(entry);
      this.cards?.note(entry);
    };
    /**
     * L1′ 回合索引（§16.4 M6）：机械配对"哪条消息触发了下游什么"。
     * 它不参与唤醒判定（那份在 `mind.js`），只负责事后可解释的配对与留档。
     */
    this.turns = new TurnIndex({
      dir: this.storage.enabled ? path.join(this.storage.dir, 'turns') : '',
      linkId: this.upstreamLinkId,
      log: this.log,
      windowMs: this.config.turns?.windowMs,
      retain: this.config.turns?.retain,
      // 封口 = 这一轮有结论了：喂给用法学习（落盘由 CapabilityMap 的 onChange 触发）。
      onClose: (turn) => {
        this.learn?.observe(turn);
      },
    });
    /**
     * 主动回忆的防骚扰账本（§24.6 M18）：同一条承诺 24 小时内最多进一次 prompt。
     * 它不做任何触发判断（那是模型的事），只记"这条已经提过了"。
     */
    this.reminders = new Reminders({
      storage: this.storage,
      log: this.log,
      // `enabled: false` 用 0 表示"不限制重复"（不是"永远不提"）。
      windowMs: this.config.reminders?.enabled === false ? 0 : (Number(this.config.reminders?.windowHours) || 24) * 3600 * 1000,
      max: this.config.reminders?.max,
    });
    /** 上游连接代数：用来做"每次连上探一次"的去重。 */
    this.#probedConnects = -1;
    /**
     * 媒体落地（§22.6 M14）：段里的 `file` 是会过期的 URL / 实现端本地路径，
     * 所以图片、语音、文件都先变成 durable ref（自己的 blob + 宿主 attachments），
     * 再把 ref 写进"人话"文本。**段数组一个字节都不改**（转发保真），
     * 文本与 ref 都只进时间线/上下文。
     */
    this.media = new MediaStore({
      storage: this.storage,
      log: this.log,
      callAction: (action, params) => this.callAction({ action, params, source: 'media' }),
      maxBytes: config.media?.maxBytes,
      timeoutMs: config.media?.fetchTimeoutMs,
      enabled: config.media?.enabled !== false,
      keepBytes: config.media?.keepBytes !== false,
      transcribe: config.media?.transcribe !== false,
      linkId: this.upstreamLinkId,
    });
    /**
     * 成员名解析（§23.6）：`at` 段里的 QQ 只有档案里有名字才叫得出来，而被 @ 的人
     * 常常一句话都没说过。这里按需问一次 `get_group_member_info`（过闸门、吃缓存、
     * 结果照旧由 `observeActionResult` 写档案），带冷却、限流与"实测不支持"停机。
     */
    this.members = new MemberResolver({
      profile: this.profiles,
      callAction: (action, params) => this.callAction({ action, params, source: 'members' }),
      log: this.log,
      storage: this.storage,
      enabled: config.members?.enabled !== false,
      cooldownMs: config.members?.cooldownMs,
      maxPerMessage: config.members?.maxPerMessage,
      maxQueue: config.members?.maxQueue,
    });
    /**
     * 看图（M14-V）：两种手段，`vision.mode` 选——
     *   · `describe`：自己用视觉模型看一次，把描述写进 L1 文本（任何模型都读得到），按 sha256 缓存；
     *   · `segment`：把图片本体作为内容段塞给看得见图的会话代理。
     * `llm` 与 `attachments` 由宿主注入（`lib/index.js` 的 `attachments`/`llm` 注入点）。
     */
    this.vision = new Vision({
      storage: this.storage,
      log: this.log,
      mode: config.vision?.mode ?? 'describe',
      // 识图默认模型由 hub 配置决定（m024167）：`agent.defaultVisionModel` 配了就用它
      // （`provider/model` 或只给 model），没配才是系统默认模型；会话里的 `/vmodel` 仍然覆盖它。
      provider: config.agentDefaultVisionModel?.provider ?? '',
      model: config.agentDefaultVisionModel?.model ?? '',
      // 思考强度（m024193）：配了就按它来，空 = 模型自己的默认档位。
      reasoningEffort: config.agentDefaultVisionReasoningEffort ?? '',
      prompt: config.vision?.prompt,
      system: config.vision?.system,
      maxTokens: config.vision?.maxTokens,
      timeoutMs: config.vision?.timeoutMs,
      cacheLimit: config.vision?.cacheLimit,
    });
    /**
     * 会话级模型选择（`/model`、`/vmodel`）。这里只放一个**引用**，模块本体由 `index.js`
     * 装配（它需要宿主 `llm` 来列清单）；没有它时看图就走系统默认模型。
     */
    this.models = null;
    this.startedAt = Date.now();
  }

  /** 从磁盘恢复实测结论与只读缓存（重启后不用把同一个坑再踩一遍）。 */
  #loadCapabilities() {
    const data = this.storage.read(this.capabilityFile, null);
    if (!data) return null;
    const registryEntries = this.capabilities.load(data.registry);
    const cacheEntries = this.cache.load(data.cache);
    const commands = this.learn?.load?.(data.commands) ?? 0;
    this.storageMeta = { loaded: true, loadedAt: Date.now(), savedAt: data.savedAt ?? null, registryEntries, cacheEntries, commands };
    this.log(
      `能力面从磁盘恢复：${registryEntries} 条实测结论、${cacheEntries} 条只读缓存、${commands} 条用法（${this.storage.path(this.capabilityFile)}）`,
    );
    return data;
  }

  /** 合并写（防抖）：连续几十次调用只落一次盘。 */
  #persistCapabilities() {
    if (!this.storage.enabled) return false;
    return this.storage.schedule(this.capabilityFile, () => ({
      version: 1,
      linkId: this.upstreamLinkId,
      savedAt: Date.now(),
      registry: this.capabilities.toJSON(),
      cache: this.cache.toJSON(),
      // 用法学习（§17.1 指定就落这份文件，不另起一份）。
      commands: this.learn?.toJSON?.() ?? null,
    }));
  }

  /** 立刻把能力结论落盘（`onebot_caps({flush:true})` 与 `stop()` 走这里）。 */
  flushStorage() {
    return this.storage.flush();
  }

  /** 用法学习被写回后合并落盘（`onebot_capabilities` 用它；防抖合并，不立刻写）。 */
  persistLearn() {
    return this.#persistCapabilities();
  }

  /**
   * 段结构 → 人话（§23.6）：这是写进时间线、进而进模型的 `text`。
   * 同步、无 I/O —— 转发路径不能被媒体下载拖住（落地是异步旁路，见 `#resolveMedia`）。
   * `mediaRefs` 只有异步落地完成后才拿得到，所以会再渲染一次把 ref 补进文本。
   */
  humanText(event, { mediaRefs = null, descriptions = null } = {}) {
    const key = sessionKey(event);
    return describeEvent(event, {
      nameOf: (qq) => this.nameOf(qq, key),
      quoteOf: (id) => this.quoteOf(id, key),
      mediaRefs,
      descriptions,
    });
  }

  /** QQ 号 → 称呼：名字跟着群走（§24.2），所以必须带上当前会话的 scope。 */
  nameOf(qq, key = '') {
    if (qq === null || qq === undefined) return null;
    const id = String(qq);
    try {
      const person = this.profiles?.person?.(id);
      if (person) {
        const named = nameIn(person, key);
        if (named) return named;
      }
      // 档案里还没有（比如从没被观测过）：退一步，用时间线里这个人最近出现时的名字
      const hit = this.timeline
        .recent(200, {})
        .filter((e) => String(e.actor?.user_id ?? '') === id)
        .pop();
      if (hit) return hit.actor?.card || hit.actor?.nickname || null;
    } catch (err) {
      this.log(`查称呼失败（不影响转发）：${err?.message ?? err}`);
    }
    return null;
  }

  /** 被引消息：先问虚拟世界记住的那条（下游问 get_msg 用的就是它），再翻自己的时间线。 */
  quoteOf(messageId, key = '') {
    const id = String(messageId ?? '').trim();
    if (!id) return null;
    try {
      for (const [, { world }] of this.#worlds) {
        const rec = world?.getMessage?.(id);
        if (rec) {
          return {
            actor: this.nameOf(rec.sender?.user_id, key) ?? rec.sender?.card ?? rec.sender?.nickname ?? null,
            text: messageToText(Array.isArray(rec.message) ? rec.message : []),
          };
        }
      }
      const hit = this.timeline
        .recent(200, {})
        .find((e) => String(e.refs?.message_id ?? '') === id || String(e.refs?.real_id ?? '') === id);
      if (hit) return { actor: hit.actor?.nickname ?? null, text: hit.text ?? '' };
    } catch (err) {
      this.log(`查被引消息失败（不影响转发）：${err?.message ?? err}`);
    }
    return null;
  }

  /**
   * 下游 `send_*` 里的媒体落地（§22.6 的**下游侧**，`m02768` 用户要求"下游发出的图片消息并没有
   * 进行解析，修一下"）。
   *
   * 上游进来的图早就有一条落地 + 看图 + 识番的旁路（`#resolveMedia`），下游发出来的却没有：
   * agent 在时间线里只看到 `[图片]`，而捕获账本里塞的是**完整的 base64**（一次就能把上下文撑爆）。
   * 这里补上同一条路：落地成 durable ref、把 ref 写回文本、按需交给视觉模型看一次。
   *
   * 与上游那条路的区别（刻意的）：
   *  - **不改转发内容**：`params` 原样转给上游/其它下游，我们只改"给人看的那份"
   *    （时间线条目与捕获账本），保真铁律不允许在这里动帧；
   *  - **不收藏表情包**：下游发的是 bot 产物，不是群友的"纯表情"；
   *  - 失败只是一段文字缺失，绝不改变"这条消息已经转发出去"这个事实。
   */
  #resolveDownstreamMedia({ entry = null, capture = null } = {}, params, segments) {
    if (!this.media?.enabled) return;
    // 合并转发（`send_*_forward_msg`）：文本只给占位（`m29922`，与群友聊天记录同待遇），
    // 但节点里的图/语音照样落字节——`stripInlineMedia` 占位里"已落地成媒体引用"这句才为真，
    // agent 想看图也能从媒体索引（`onebot_raw` 的 media[].blob）自己看。
    let hasForward = false;
    const flat = [];
    for (const seg of segments ?? []) {
      if (seg?.type === 'forward' && Array.isArray(seg.data?.nodes)) {
        hasForward = true;
        for (const node of seg.data.nodes) {
          const content = node?.data?.content ?? node?.content;
          if (Array.isArray(content)) flat.push(...content);
        }
      } else {
        flat.push(seg);
      }
    }
    if (!flat.some((s) => MEDIA_SEGMENT_TYPES.includes(s?.type))) return;
    // 描述用的事件是**合成的**（下游 action 没有事件对象）：字段够 `describeEvent`/`humanText` 用就行。
    // `message` 保持原 segments（forward 占位段）——文本重渲染依旧是占位，不会把节点内容摊回正文。
    const pseudo = {
      post_type: 'message',
      message_type: params.message_type ?? (params.group_id ? 'group' : 'private'),
      sub_type: 'normal',
      self_id: params.self_id ?? null,
      user_id: params.user_id,
      ...(params.group_id !== undefined ? { group_id: params.group_id } : {}),
      message: segments,
      // forward 占位段不能进 renderCq：nodes 会被序列化成 `nodes=[object Object]` 的垃圾。
      raw_message: hasForward ? '' : renderCq(segments),
    };
    void this.media
      .resolveEvent(flat, { messageId: params.message_id ?? null })
      .then(({ refs, records }) => {
        if (!records?.length) return null;
        const ids = records.map((r) => r.id).filter(Boolean);
        if (entry) {
          entry.refs = { ...(entry.refs ?? {}), media: ids };
          entry.media = records;
          entry.text = this.humanText(pseudo, { mediaRefs: refs });
        }
        // 捕获账本里那份也要换掉：它的存在意义是"让 agent 看下游到底发了什么"，
        // 留一串 base64 既读不懂又占地方。
        if (capture) {
          capture.mediaRefs = ids;
          capture.params = stripInlineMedia(params);
          capture.text = entry?.text ?? capture.text;
        }
        // L1 原始层那行是在 `append()` 时就冻住的（`recall.rowOf`），媒体却是**这里**才落地：
        // 不回填的话 `onebot_raw` 永远回 `mediaRefs: null`（P9，真机上 agent 只能去翻 49933 字符的列表）。
        this.recall?.patchMedia?.(entry?.id, ids);
        return this.#enrichImages(entry, pseudo, refs, records);
      })
      .catch((err) => this.log(`下游媒体落地失败（不影响转发）：${err?.message ?? err}`));
  }

  /**
   * 媒体落地的**异步旁路**：转发不等它，失败也不影响转发。
   * 完成后回填 `entry.refs.media` 并重渲染 `entry.text`（这样"（已存为 hub-media:xxx）"才进得了上下文）。
   */
  #resolveMedia(entry, event) {
    if (!this.media?.enabled) return;
    const segments = segmentsOf(event);
    if (!Array.isArray(segments) || !segments.some((s) => ['image', 'record', 'video', 'file'].includes(s?.type))) return;
    void this.media
      .resolveEvent(segments, { messageId: event?.message_id ?? null })
      .then(({ refs, records }) => {
        if (!records?.length) return null;
        const ids = records.map((r) => r.id).filter(Boolean);
        if (entry) {
          entry.refs = { ...(entry.refs ?? {}), media: ids };
          entry.media = records;
          entry.text = this.humanText(event, { mediaRefs: refs });
        }
        // 同上（P9）：L1 那行的 `mediaRefs` 必须回填，否则 `onebot_raw` 看不到这条的媒体。
        this.recall?.patchMedia?.(entry?.id, ids);
        return this.#enrichImages(entry, event, refs, records);
      })
      .catch((err) => this.log(`媒体落地失败（不影响转发）：${err?.message ?? err}`));
  }

  /**
   * 一张图在一次旁路里**只读一次字节**，做两件事（§26 ⑤⑥ 的合流点）：
   *
   *  1. **视觉描述**（`vision.mode` 含 `describe`）：交给视觉模型看一次，写回文本；
   *  2. **角色识别**（`anime.backend !== 'off'`）：识别出的角色作为**附加的一行**接在描述后面
   *     ——"这是谁"是"画了什么"的补充，不是替代，认不出来就说认不出来。
   *
   * **不再自动收藏表情包**（方案 v2）：收不收由 agent 判断（`onebot_memes` 的 add），
   * 简介也由 agent 自己写——这里只负责把"这张图是什么"讲清楚（打标）。
   *
   * 这条链上任何一步失败都只是少一段文字，绝不改变"消息已经转发出去"这个事实。
   */
  async #enrichImages(entry, event, refs, records) {
    const images = (records ?? []).filter((r) => r?.kind === 'image');
    if (!images.length) return null;
    const describeOn = !!(this.vision?.describeEnabled && this.vision.enabled);
    const animeOn = !!this.anime?.enabled;
    if (!describeOn && !animeOn) return null;
    const descriptions = new Map();
    const segs = segmentsOf(event);

    for (const ref of images) {
      const bytes = await this.#blobBytes(ref);
      const parts = [];
      // 协议先验：`sub_type==1`（发送端标的表情包）并进主描述请求。
      const seg = Array.isArray(segs) ? segs[ref.index] : null;
      const memeHint = String(seg?.data?.sub_type ?? seg?.data?.subType ?? '0') === '1';
      let judged = null;
      if (describeOn) {
        const res = await this.vision.describeImage({
          bytes,
          mediaType: ref.mediaType,
          name: ref.name,
          sha256: ref.sha256,
          attachment: ref.attachment,
          // 会话级 `/vmodel`；没有就用 hub 配置的默认（`agent.defaultVisionModel`），
          // 还没配才是系统默认模型（`Vision` 构造时 provider/model 都为空）。
          override: this.models?.visionFor?.(entry?.sessionKey) ?? null,
          memeHint,
        });
        if (res) judged = { meme: res.meme ?? null, emotion: res.emotion ?? null, anime: res.anime ?? null };
        if (res?.text) parts.push(res.text);
        else if (res?.error) this.log(`看图失败（不影响转发）：${ref.id ?? '?'} ${res.error}`);
      }
      // 二次元三道门（用户 m30282 定案，对齐 aigf-master）：①看图模型先判"是不是二次元"；
      // ②判"否"就不吃角色识别配额（/status 截图这类实拍/界面图直接跳过）；③渲染层按置信度
      // 过滤、只显示 top-1（anime.js）。判定缺失（vision 关着/模型没按格式答）宁可多问不漏判。
      if (animeOn && bytes && judged?.anime !== false) {
        try {
          const res = await this.anime.recognize({
            bytes,
            mediaType: ref.mediaType,
            sha256: ref.sha256,
            shrink: () => this.#shrinkImage(ref, bytes),
          });
          if (res?.text) parts.push(res.text);
          else if (res?.error) this.log(`角色识别失败（不影响转发）：${ref.id ?? '?'} ${res.error}`);
        } catch (err) {
          this.log(`角色识别异常（不影响转发）：${err?.message ?? err}`);
        }
      }
      // 有内容、或模型给出了表情包判定（哪怕没内容）才回填——失败就什么都不写。
      if (parts.length || judged?.meme === true) {
        if (parts.length) ref.text = parts.join(' ');
        // 描述存对象（文本 + 表情包判定）；`ref.text` 保持干净内容描述（add 的 description 兜底用它）。
        descriptions.set(ref.index, {
          text: ref.text ?? '',
          meme: judged?.meme ?? null,
          emotion: judged?.emotion ?? null,
        });
      }
    }

    if (descriptions.size && entry) {
      entry.descriptions = Object.fromEntries(descriptions);
      entry.text = this.humanText(event, { mediaRefs: refs, descriptions });
      this.cards?.patch?.(entry);
    }
    if (descriptions.size) {
      this.log(`看图完成：${descriptions.size} 张（${[...descriptions.values()].map((v) => String(v?.text ?? '').slice(0, 24)).join(' / ')}）`);
    }
    return descriptions;
  }

  /**
   * 把图片压小重试（AnimeTrace 413 时用）。只做**自家能解的格式**：
   * PNG 直接解码后等比缩到 60% 再编码，GIF 取关键帧拼图当 PNG 发。
   * JPEG 没法解（不想为它引一个解码器），返回 `null` —— 上层看到 null 就当压缩不可用，正常放弃。
   */
  async #shrinkImage(ref, bytes) {
    try {
      const type = String(ref?.mediaType ?? '').toLowerCase();
      if (type.includes('png')) {
        const { decodePngToRgba, encodePng } = await import('./media/png.js');
        const img = decodePngToRgba(Buffer.from(bytes));
        const width = Math.max(1, Math.round(img.width * 0.6));
        const height = Math.max(1, Math.round(img.height * 0.6));
        const rgba = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y += 1) {
          const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
          for (let x = 0; x < width; x += 1) {
            const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
            const from = (sy * img.width + sx) * 4;
            const to = (y * width + x) * 4;
            rgba[to] = img.rgba[from];
            rgba[to + 1] = img.rgba[from + 1];
            rgba[to + 2] = img.rgba[from + 2];
            rgba[to + 3] = img.rgba[from + 3];
          }
        }
        return encodePng({ width, height, rgba });
      }
      if (type.includes('gif')) {
        const { gifToSpriteSheet } = await import('./media/gif.js');
        const { encodePng } = await import('./media/png.js');
        const shot = gifToSpriteSheet(Buffer.from(bytes), { maxFrames: 4, height: 120 });
        const sprite = shot?.sprite;
        if (!sprite?.rgba) return null;
        return encodePng({ width: sprite.width, height: sprite.height, rgba: Buffer.from(sprite.rgba) });
      }
    } catch (err) {
      this.log(`图片压缩失败（${ref?.mediaType ?? '?'}）：${err?.message ?? err}`);
    }
    return null;
  }

  /** 图片字节：优先读自己落的 blob（上游 URL 会过期，blob 不会）。 */
  async #blobBytes(ref) {
    if (!ref?.blob) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(ref.blob);
    } catch (err) {
      this.log(`读媒体 blob 失败：${err?.message ?? err}`);
      return null;
    }
  }

  get policyDescription() {
    return describePolicy(this.policy);
  }

  /** 创建下游实现端（不自行挂路由，由调用方把 handleUpgrade 接到宿主上）。 */
  createDownstreamEndpoint({ accessToken } = {}) {
    this.downstream = new DownstreamEndpoint({
      accessToken: accessToken ?? this.config.downstreamAccessToken ?? null,
      log: this.log,
      onConnection: (session) => this.#attachDownstream(session),
      onClose: (session) => this.log(`下游链路断开：${session.selfId}`),
    });
    return this.downstream;
  }

  /**
   * 挂上一条下游链路。
   *
   * `kind` 决定 hub 对这条链路该**往哪个方向发什么**，这是 OneBot v11 的方向性决定的：
   *  - `bot-app`：对端是 bot 应用（NoneBot 之类）。hub 扮演实现端，只能**推事件**给它，
   *    它只回 action 请求。`onebot_invoke` 的 event 模式走这里。
   *  - `implementation`：对端是另一个实现端（它以为 hub 是 bot 应用）。此时 hub 可以
   *    合法地向它**发 action 请求**，它会推事件过来。`onebot_invoke` 的 action 模式走这里。
   */
  #attachDownstream(session, nickname, kind = 'implementation', id) {
    // 链路 id 用**目标自己的键**（配置里的 `id`，缺省 = selfId）。多下游时 selfId 可能重复
    // （同一个 bot 账号接到两个 app），只有 `id` 能唯一定位一条链路。
    const linkId = `down:${id ?? session.selfId}`;
    session.linkId = linkId;
    const world = new VirtualWorld({
      linkId,
      selfId: session.selfId,
      nickname: nickname ?? this.config.downstreamNickname ?? `hub-${session.selfId}`,
      log: this.log,
      onOutbound: (out) => this.#routeOutbound(session, world, out),
    });
    this.#worlds.set(linkId, { session, world, kind });
    session.onFrame = (frame) => this.handleDownstreamFrame(session, frame);
    // 心跳只发给 `implementation` 型（对端把 hub 当 bot 应用，按协议在等心跳）；
    // `bot-app`（NoneBot 这类）不要，实测不认也没必要。`downstreamHeartbeatMs: 0` 即关。
    if (kind === 'implementation') {
      session.startHeartbeat?.({
        intervalMs: this.config.downstreamHeartbeatMs ?? 30000,
        selfId: session.selfId,
        status: () => ({ online: this.upstream?.isConnected === true, good: true }),
      });
    }
    return world;
  }

  /**
   * 登记一条下游目标（§19）：按 `type` 分派到四种形态之一。
   *
   *  - `ws-dial`（默认）：hub 拨号过去（下游是 NoneBot 这类"反向 WS 服务端"时用）。
   *  - `ws-listen`：hub 在目标自己的地址上开 ws 端点，等对方拨进来。
   *  - `http-api`：hub 在目标地址上开 HTTP API（对方 `POST /<path>/<action>`）。
   *  - `http-post`：hub 把事件 POST 到目标地址。
   *
   * 一条目标 = 一个 `id` + 自己的地址/token/重连间隔，**彼此独立**：一条连不上不会拖住
   * 别的，状态里也分得清是哪一条在反复重连。目标之间只共享「上游来的事件投给所有已挂上
   * 的链路」这层语义（见 `#dispatchUpstream` 的循环）。
   *
   *  @param {{id?:string, type?:string, url?:string, address?:string, host?:string, port?:number,
   *   path?:string, selfId?:string|number, nickname?:string, accessToken?:string, reconnectInterval?:number,
   *   probeOnly?:boolean, downstreamId?:string}} target
   */
  addDownstreamTarget(target) {
    const type = target.type ?? 'ws-dial';
    if (target.warning) this.log(`下游目标 ${target.id} 提醒：${target.warning}`);
    if (type === 'ws-listen' || type === 'http-api') return this.#addListenTarget(target, type);
    if (type === 'http-post') return this.#addPostTarget(target);
    return this.#addDialTarget(target);
  }

  /** `ws-dial`：拨号一条下游链路。 */
  #addDialTarget(target) {
    const id = String(target.id ?? target.selfId);
    const reconnectInterval = Number.isFinite(Number(target.reconnectInterval)) && Number(target.reconnectInterval) > 0
      ? Number(target.reconnectInterval)
      : (this.config.reconnectInterval ?? 5000);
    const dialer = new DownstreamDialer({
      id,
      url: target.url,
      selfId: target.selfId,
      nickname: target.nickname,
      accessToken: target.accessToken ?? this.config.downstreamAccessToken,
      reconnectInterval,
      log: this.log,
      onConnection: (session) => this.#attachDownstream(session, target.nickname, 'bot-app', id),
      onClose: (session) => this.log(`下游拨号链路断开：${id} (${target.url})`),
    });
    const prev = this.#dialers.get(id);
    if (prev) {
      // 同一个 id 被登记两次（配置里重复 / 热重挂）：旧的必须停掉，否则它还在偷偷重连。
      this.log(`下游目标 ${id} 重复登记，停掉旧连接`);
      prev.stop();
    }
    this.#dialers.set(id, dialer);
    dialer.start();
    return dialer;
  }

  /**
   * `ws-listen` / `http-api`：在目标自己的地址上开一个 http 端口。
   *
   * `ws-listen` 的 upgrade 交给一个**这条目标专属**的 `DownstreamEndpoint`（自带 token），
   * 连上来的 app 用 `#attachDownstream(..., id)` 挂进世界——和拨号来的链路走同一套下游语义。
   * `http-api` 没有 socket：挂一条"永远在"的伪链路，让 action 路由（`worldOf`/`linkId`）
   * 与别的下游完全一致；它**收不到事件推送**（那是 `http-post` 的活），真被推到时会如实记一笔。
   */
  #addListenTarget(target, type) {
    const id = String(target.id ?? `${target.host}:${target.port}`);
    const token = target.accessToken ?? this.config.downstreamAccessToken;
    const previous = this.#listeners.get(id);
    if (previous) previous.stop();
    const endpoint = type === 'ws-listen'
      ? new DownstreamEndpoint({
        accessToken: token,
        log: this.log,
        onConnection: (session) => this.#attachDownstream(session, target.nickname, 'bot-app', id),
        onClose: (session) => this.log(`下游链路断开：${id}（${session.selfId}）`),
      })
      : null;
    if (type === 'http-api') {
      this.#attachDownstream({
        selfId: String(target.selfId || `http-api:${id}`),
        linkId: `down:${id}`,
        isOpen: true,
        send: () => {
          this.log(`下游 ${id} 是 http-api 型：事件不会主动推给它（要收事件请另配一条 http-post 目标）`);
          return false;
        },
      }, target.nickname, 'bot-app', id);
    }
    const listener = new DownstreamHttpListener({
      host: target.host ?? '127.0.0.1',
      port: target.port ?? 0,
      path: target.path ?? '/',
      scheme: type === 'http-api' ? 'http' : 'ws',
      accessToken: token,
      log: this.log,
      onUpgrade: endpoint ? (req, socket, head) => endpoint.handleUpgrade(req, socket, head) : undefined,
      onRequest: type === 'http-api' ? (input) => this.#handleHttpAction(id, input) : undefined,
    });
    this.#listeners.set(id, listener);
    listener.start();
    return listener;
  }

  /** `http-post`：事件通过 HTTP POST 推给对方（没有 socket，健康度自己数）。 */
  #addPostTarget(target) {
    const id = String(target.id ?? target.selfId);
    const stats = this.#posters.get(id) ?? { id, url: target.url, posts: 0, failures: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
    stats.url = target.url;
    this.#posters.set(id, stats);
    this.#attachDownstream({
      selfId: String(target.selfId),
      linkId: `down:${id}`,
      isOpen: true,
      send: (frame) => {
        void this.#postEvent(stats, target, frame);
        return true;
      },
    }, target.nickname, 'bot-app', id);
    return stats;
  }

  async #postEvent(stats, target, event) {
    const token = target.accessToken ?? this.config.downstreamAccessToken;
    const timeoutMs = Math.max(1000, Number(this.config.requestTimeout ?? 30000) || 30000);
    // 超时用**自己的** controller + unref 定时器：`AbortSignal.timeout()` 的定时器没法清，
    // 会一直挂到超时为止（测试里表现为进程退不干净、重启时表现为留一个活 handle）。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-self-id': String(target.selfId ?? ''),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      stats.posts += 1;
      if (response.ok) {
        stats.lastOkAt = Date.now();
        stats.lastError = null;
      } else {
        stats.failures += 1;
        stats.lastError = `HTTP ${response.status}`;
        stats.lastErrorAt = Date.now();
        this.log(`下游 ${stats.id} 事件推送被拒：HTTP ${response.status}`);
      }
    } catch (err) {
      stats.failures += 1;
      stats.lastError = String(err?.message ?? err);
      stats.lastErrorAt = Date.now();
      this.log(`下游 ${stats.id} 事件推送失败：${stats.lastError}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `http-api`：把一次 HTTP action 请求灌进和 ws 下游完全相同的处理管线。 */
  async #handleHttpAction(id, { action, params, echo, selfId, res }) {
    const linkId = `down:${id}`;
    let replied = false;
    const respond = (payload) => {
      if (replied) return true;
      replied = true;
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch {
        /* 客户端可能已经断了 */
      }
      return true;
    };
    const session = {
      selfId: selfId ?? String(this.#worlds.get(linkId)?.session?.selfId ?? 'http'),
      linkId,
      isOpen: true,
      send: (frame) => respond(frame),
    };
    const result = await this.#handleDownstreamAction(session, { action, params, echo });
    if (replied) return result;
    const fallback = { status: 'failed', retcode: 1404, msg: `这个 action 没有产生回复：${action}` };
    respond(fallback);
    return fallback;
  }

  /** 按配置登记所有下游目标（`enabled: false` 的只登记不连）。返回真正启动的条数。 */
  connectDownstreams() {
    const targets = Array.isArray(this.config.downstreamTargets) ? this.config.downstreamTargets : [];
    this.#targets = targets.map((target) => ({
      id: String(target?.id ?? target?.selfId ?? target?.address ?? ''),
      type: target?.type ?? 'ws-dial',
      selfId: String(target?.selfId ?? ''),
      url: target?.url === undefined ? '' : String(target.url),
      address: target?.address === undefined ? '' : String(target.address),
      port: target?.port,
      nickname: target?.nickname === undefined ? undefined : String(target.nickname),
      // 逻辑下游分组与"探针专用"标记（M7-④）：状态与寻址都要用，所以从配置里带过来。
      downstreamId: target?.downstreamId === undefined ? undefined : String(target.downstreamId),
      probeOnly: target?.probeOnly === true,
      enabled: target?.enabled !== false,
      // 拨号/POST 型又没写对方账号、上游账号也还不知道：这条链**先不建**（拿空身份握手没意义），
      // 等学到上游账号后由 `#adoptUpstreamAccount` 建起来。状态里要看得见"在等账号"。
      pendingAccount: needsUpstreamAccount(target) && !this.upstreamAccount,
    }));
    let started = 0;
    let waiting = 0;
    for (const target of targets) {
      const id = String(target?.id ?? target?.selfId ?? target?.address ?? '');
      if (target?.enabled === false) {
        this.log(`下游目标 ${id || '(未命名)'} 已禁用，不连接`);
        continue;
      }
      if (needsUpstreamAccount(target) && !this.upstreamAccount) {
        waiting += 1;
        this.log(`下游目标 ${id || '(未命名)'} 没写"对方账号"、上游账号也还不知道：先留着，上游连上后自动建链`);
        continue;
      }
      if (needsUpstreamAccount(target)) target.selfId = this.upstreamAccount;
      this.addDownstreamTarget(target);
      started += 1;
    }
    if (waiting > 0) this.log(`有 ${waiting} 条下游目标在等上游账号（学到后自动建链）`);
    if (targets.length > 0) {
      const byType = {};
      for (const target of targets) {
        const type = target?.type ?? 'ws-dial';
        byType[type] = (byType[type] ?? 0) + 1;
      }
      this.log(`下游目标：${targets.length} 条（启用 ${started} 条：${Object.entries(byType).map(([type, n]) => `${type}×${n}`).join('、')}）`);
    }
    return started;
  }

  /** 按 id 找配置里的目标（状态与寻址都要用）。 */
  targetOf(id) {
    const key = String(id ?? '').replace(/^down:/, '');
    return this.#targets.find((target) => target.id === key) ?? null;
  }

  /** 上游是哪个账号：配置优先，其次是从握手里学到的；都不知道就是空串。 */
  get upstreamAccount() {
    return String(this.config.upstreamSelfId ?? this.config.selfId ?? '').trim() || this.#upstreamAccount || '';
  }

  /** 这个账号是不是"学来的"（配置里没写）。状态与诊断用。 */
  get upstreamAccountLearned() {
    return this.#upstreamAccount;
  }

  /**
   * 学到"上游是谁"（§19，用户要求：下游目标不写对方账号时默认与上游相同）。
   *
   * 为什么需要这一步：下游的默认账号是在**解析配置那一刻**（`resolveConfig`）算好的，而那时
   * 上游通常还没连上；`ws-dial` 的 `X-Self-ID` 又是**握手时**就要发出去的。所以账号晚到了
   * 得有个后手——账号从"未知"变"已知"的那一刻，把那些"在等账号"的目标真建起来。
   *
   * 学到账号的三条路：监听模式下对方握手头里的 `X-Self-ID`、上游事件里的 `self_id`、
   * 以及 `index.js` 的身份探测（`get_login_info`）。三条都汇到这里。
   *
   * **配置优先**：配置里显式写了 `upstreamSelfId` 就以它为准；观测到不一致时**不改行为**，
   * 只回一条 `config-wins`（显式配置是用户的意图，不该被观测悄悄推翻）。
   */
  /**
   * 把"我是谁"的最新结论同步给编排层（`hub.hooks.onUpstreamAccount`）。
   * 账号与昵称**分开给**：账号可能早就有、昵称是后学的（反之亦然），少给一样就等于少一条叫醒我的路。
   */
  #notifyIdentity({ selfId = null, nickname = null, source = 'event', previous = null } = {}) {
    try {
      this.hooks.onUpstreamAccount?.({
        selfId: selfId ? String(selfId) : null,
        nickname: nickname ? String(nickname) : null,
        source,
        previous,
      });
    } catch (err) {
      this.log(`onUpstreamAccount 钩子失败：${err?.message ?? err}`);
    }
  }

  learnUpstreamAccount(selfId, source = 'event', nickname = null) {
    const id = String(selfId ?? '').trim();
    const name = String(nickname ?? '').trim();
    /**
     * **昵称单独同步**（真机事故排查）：账号早就在了（`reason: 'known'`）也不代表昵称学过——
     * 群友手打 `@真昵称` 靠的就是它。以前只有"账号变化"这一条路会通知编排层，而账号往往在
     * 握手里就学到了（`get_login_info` 那一路反而因为信封没拆干净拿不到昵称），于是
     * `Mind.#nicknames` 一直是空集：用 at 段能叫醒，手打昵称叫不醒。
     */
    if (name) {
      this.#upstreamNickname = name;
      this.#notifyIdentity({ selfId: id || this.#upstreamAccount, nickname: name, source });
    }
    if (!id) return { learned: false, reason: 'empty' };
    const configured = String(this.config.upstreamSelfId ?? '').trim();
    if (configured) {
      return configured === id
        ? { learned: false, reason: 'configured', selfId: configured }
        : { learned: false, reason: 'config-wins', configured, actual: id };
    }
    const previous = this.#upstreamAccount;
    if (previous === id) return { learned: false, reason: 'known', selfId: id };
    this.#upstreamAccount = id;
    /**
     * 学到账号要**通知编排层**（`onUpstreamAccount`）：`Mind` 的"我是谁"就是靠它兜底的
     * （配置 `upstreamSelfId` 空着时，`configured ? … : learned` 这条路是唯一的账号来源）。
     * 事故 #11 的教训：只把账号存在 hub 里、忘了同步给判定层，表现是"被 @ 了却听不见"。
     */
    this.#notifyIdentity({ selfId: id, nickname: null, source, previous: previous ?? null });
    if (previous === null) {
      this.log(`学到上游账号：${id}（来自${source}）`);
      this.#adoptUpstreamAccount(id);
    } else {
      this.log(`上游账号变了：${previous} → ${id}（来自${source}）；已建的下游链路不重建，新建的用新账号`);
    }
    return { learned: true, selfId: id, source, previous: previous ?? undefined };
  }

  /**
   * 账号已知后，把"在等账号"的下游目标建起来。
   *
   * 只补建**还没建过**的那些（它们在 `connectDownstreams` 里被跳过了），所以不存在"打断已有
   * 连接"的问题；id 用地址（`normalizeTargets` 里定的），所以寻址不变、`down:…` 引用照旧。
   */
  #adoptUpstreamAccount(selfId) {
    const list = Array.isArray(this.config.downstreamTargets) ? this.config.downstreamTargets : [];
    let built = 0;
    for (const target of list) {
      if (!target || target.enabled === false) continue;
      if (!needsUpstreamAccount(target)) continue;
      target.selfId = String(selfId);
      const known = this.#targets.find((entry) => entry.id === String(target.id ?? ''));
      if (known) {
        known.selfId = String(selfId);
        known.pendingAccount = false;
      }
      this.log(`上游账号已知（${selfId}）：下游目标 ${target.id} 开始建链`);
      this.addDownstreamTarget(target);
      built += 1;
    }
    if (built > 0) this.log(`共补建 ${built} 条下游链路`);
    return built;
  }

  worldOf(linkId) {
    return this.#worlds.get(linkId)?.world ?? null;
  }

  /**
   * 这条链路在**给人看的记录**里叫什么（§19 多下游）。
   *
   * 为什么需要：`linkId`（`down:127.0.0.1:8080`）和 `downstreamId`（缺省也是 `127.0.0.1:8080`）
   * 在多下游时根本分不出"这是哪个 bot"——两条链路的名字可能一模一样，探针链路更是只差一个
   * `~probe` 后缀。所以记录里必须带一个**人能读的名字**：备注名（设置页那列）优先，其次逻辑
   * 下游名，再退到目标键；探针链路加"（探针）"。
   *
   * 只用于显示，**不参与任何路由判断**（路由看 `linkId`/`downstreamId`）。
   */
  labelOf(linkId) {
    const id = String(linkId ?? '').replace(/^down:/, '');
    const target = this.targetOf(id);
    if (!target) return id || undefined;
    const base = String(target.nickname ?? '').trim()
      || String(target.downstreamId ?? '').trim()
      || String(target.id ?? id);
    return target.probeOnly === true ? `${base}（探针）` : base;
  }

  /** 现有下游的人话清单（报错/状态用）：`名字（逻辑下游 id）`，探针链路一并列出。 */
  describeDownstreams() {
    const seen = new Set();
    const out = [];
    for (const target of this.#targets) {
      if (!target?.id) continue;
      const name = String(target.nickname ?? '').trim() || String(target.id);
      const group = String(target.downstreamId ?? '');
      const key = `${group}\u0000${target.probeOnly === true ? 'probe' : 'real'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target.probeOnly === true ? `${name}（探针，逻辑下游 ${group || target.id}）` : `${name}（逻辑下游 ${group || target.id}）`);
    }
    return out.join('、');
  }

  /**
   * 注入该走哪条**物理链路**——这是**枢纽的路由决策**，不是调用方的选择（`m02768` 用户定案）。
   *
   * 调用方只回答"我要问**哪个下游**"（`downstream`：逻辑下游名 / 备注名 / 对方账号 / 目标键；
   * 缺省 = 只有一条下游时就用它），物理链路按隔离档位决定：
   *  - `link` 档 → 一律走那条下游的**探针链路**（探针链路收不到真人消息，注入不会跟真人消息混）；
   *  - 其它档 → 走**真实链路**；
   *  - `allowRealLink: true` 是**显式**的逃生口：链路隔离下故意打真实链路（产物可能直接进群），
   *    调用方必须在结果里看到"本次未隔离"的告警。
   *
   * 为什么不让调用方直接点链路名：见 `m02768`——`onebot_relay_probe` 一次"顺手填了 `link`"
   * 就把隔离绕过去了，而隔离的全部意义是"注入只走那条"。
   */
  pickInjectLink({ downstream = '', allowRealLink = false } = {}) {
    const want = String(downstream ?? '').trim().replace(/^down:/, '');
    const enabled = this.#targets.filter((target) => target?.enabled !== false && target.id);
    if (!enabled.length) {
      throw new Error('没有配好任何下游；请先在设置页配 downstreamTargets（或用 onebot_hub_status 看现有链路）。');
    }
    let group = enabled;
    if (want) {
      const matched = enabled.filter((target) => [target.downstreamId, target.nickname, target.selfId, target.id]
        .some((value) => String(value ?? '') !== '' && String(value ?? '') === want));
      if (!matched.length) {
        throw new Error(
          `没有叫「${want}」的下游。现有：${this.describeDownstreams()}。`
          + '可以给逻辑下游名（downstreamId）、备注名、对方账号或目标键；**不要填物理链路**——探针还是真实由枢纽按 probe.isolation 决定。',
        );
      }
      // 名字命中的是"哪个下游"，不是"哪条链路"：把它名下**所有**物理链路（主 + 探针）都取回来，
      // 再由下面的隔离档位挑一条。只按命中的那一条走会漏掉同组的探针链路（真实链路与探针链路
      // 共用 downstreamId，名字常常只能命中其中一条）。
      const groups = new Set(matched.map((target) => String(target.downstreamId ?? target.id ?? '')));
      group = enabled.filter((target) => groups.has(String(target.downstreamId ?? target.id ?? '')));
    } else {
      const groups = new Map();
      for (const target of enabled) {
        const key = String(target.downstreamId ?? target.id ?? '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(target);
      }
      if (groups.size > 1) {
        throw new Error(`有 ${groups.size} 个下游，必须用 downstream 点名要问哪个：${this.describeDownstreams()}。`);
      }
      group = [...groups.values()][0];
    }
    const probe = group.find((target) => target.probeOnly === true) ?? null;
    const real = group.find((target) => target.probeOnly !== true) ?? null;
    const linkMode = this.probeIsolation === 'link';
    const name = String(group[0]?.nickname ?? '').trim() || String(group[0]?.downstreamId ?? group[0]?.id ?? '');
    if (linkMode && !allowRealLink && !probe) {
      throw new Error(
        `链路隔离是 link 档，但下游「${name}」没有探针链路：请在它的目标里填 probeSelfId`
        + '（另一个账号；不写就不展开），或者把 probe.isolation 改回 off/time。',
      );
    }
    const target = linkMode && !allowRealLink ? (probe ?? real) : (real ?? probe);
    if (!target) throw new Error(`下游「${name}」没有任何可用的物理链路。`);
    const probeOnly = target.probeOnly === true;
    return {
      linkId: `down:${target.id}`,
      target,
      downstreamId: String(target.downstreamId ?? target.id),
      label: this.labelOf(`down:${target.id}`),
      // `notIsolated` 只在"链路隔离开着、却显式要求打真实链路"时有值——调用方必须把它讲给 agent 听。
      ...(linkMode && allowRealLink && !probeOnly
        ? { notIsolated: '链路隔离开着，但这次**显式**打了真实链路（allowRealLink）：注入的产物会跟真人消息混在一条链路上，可能直接进群。' }
        : {}),
    };
  }

  get downstreamLinks() {
    const links = [...this.#worlds.entries()].map(([linkId, { session, world, kind }]) => {
      const id = String(session.linkId ?? linkId).replace(/^down:/, '');
      const target = this.targetOf(id);
      return {
        linkId,
        id,
        type: target?.type ?? 'ws-dial',
        selfId: session.selfId,
        role: session.role ?? 'Universal(dialed)',
        // 逻辑下游（人声明的分组）+ 探针专用标记：agent 靠这两个字段判断"哪两条链路是
        // 同一个下游"，而不是拿 selfId 猜（selfId 可以重复、可以随便配）。
        downstreamId: target?.downstreamId,
        probeOnly: target?.probeOnly === true,
        // 人话名字：多下游时 `linkId`/`downstreamId` 分不出"这是哪个 bot"，记录里必须带上它。
        label: this.labelOf(linkId),
        kind,
        connected: session.isOpen === true,
        enabled: target ? target.enabled !== false : true,
        nickname: world.nickname,
        actions: world.recentActions.length,
        url: target?.url,
        // 健康度**必须跟着世界一起报**：连上之后 `#worlds` 里有它，早先的写法在这里
        // `continue` 掉，结果"已连上的那条反而没有重连计数"。
        ...this.#healthOf(id),
      };
    });
    // 配了但还没挂上链路的目标（没连上 / 被禁用 / 纯 http-api）也要出现在状态里：否则
    // 用户只看到"一条都没有"，无从判断是"没配"还是"配了但连不上"（§19 最容易踩的坑）。
    for (const target of this.#targets) {
      if (!target.id || links.some((link) => link.id === target.id)) continue;
      links.push({
        linkId: `down:${target.id}`,
        id: target.id,
        type: target.type,
        selfId: target.selfId,
        role: 'Universal(dialed)',
        kind: 'bot-app',
        connected: false,
        enabled: target.enabled,
        nickname: target.nickname,
        downstreamId: target.downstreamId,
        probeOnly: target.probeOnly === true,
        label: this.labelOf(`down:${target.id}`),
        actions: 0,
        url: target.url,
        address: target.address,
        // "在等上游账号"和"连不上"要分得清：前者不是故障，上游一连上就会自己建链。
        ...(target.pendingAccount ? { pendingAccount: true, note: '没写"对方账号"，等上游账号（学到后自动建链）' } : {}),
        ...this.#healthOf(target.id),
      });
    }
    return links;
  }

  /** 一条目标的健康度：拨号型看 dialer、监听型看 listener、推送型看计数器。 */
  #healthOf(id) {
    const dialer = this.#dialers.get(id);
    if (dialer) {
      const s = dialer.status;
      return {
        url: s.url,
        reconnectInterval: s.reconnectInterval,
        connects: s.connects,
        reconnects: s.reconnects,
        lastError: s.lastError,
        lastErrorAt: s.lastErrorAt,
        lastOkAt: s.lastOkAt,
      };
    }
    const listener = this.#listeners.get(id);
    if (listener) {
      const s = listener.status;
      return {
        url: s.url,
        address: `${s.host}:${s.port}${s.path}`,
        listening: s.listening,
        connected: s.listening,
        upgrades: s.upgrades,
        requests: s.requests,
        rejected: s.rejected,
        errors: s.errors,
        lastError: s.lastError,
        lastErrorAt: s.lastErrorAt,
      };
    }
    const poster = this.#posters.get(id);
    if (poster) {
      return {
        url: poster.url,
        connected: true,
        posts: poster.posts,
        failures: poster.failures,
        lastError: poster.lastError,
        lastErrorAt: poster.lastErrorAt,
        lastOkAt: poster.lastOkAt,
      };
    }
    return {};
  }

  /** 上游状态变化：日志 + 每次"连上"探一次能力（§22.1-3）。 */
  #onUpstreamStatus(status) {
    this.log(`上游状态：connected=${status.connected} events=${status.events}`);
    if (status.connected) void this.probeCapabilities().catch((err) => this.log(`能力探测失败：${err?.message ?? err}`));
  }

  /** 连接上游真实现端：默认拨号（正向 WS 客户端）；配了 upstreamListen 则改为监听等它拨进来。 */
  /**
   * 取一条的**原始报文**（`m03065`）：收到的所有消息都在 L1 里留了原文与索引，**解析不了的也在**
   * （hub 只做"能自动做的那点解析"）。返回里带上这条已落地的媒体（含 blob 路径），
   * agent 可以拿它们用**自己带的工具**继续处理（读文件、转换格式、OCR……）。
   */
  async rawFrameOf(ref) {
    const found = await this.recall.rawOf(ref);
    if (!found?.ok) return found;
    const row = found.raw;
    const ids = Array.isArray(row.mediaRefs) ? row.mediaRefs : [];
    const media = ids
      .map((id) => this.media?.find?.(id))
      .filter(Boolean)
      // 过一遍对外投影（`m26571`）：工具结果里绝不能出现整份 base64——老记录里
      // `name`/`source` 就存着它（一个 ref 能到 33 万字符，DSH 会 spill 到临时文件再让模型去翻）。
      .map((r) => publicMediaRef(r));
    return {
      ok: true,
      raw: row,
      media,
      note: media.length
        ? '媒体字节在 media[].blob 这个路径上：要理解内容请用你自己的工具读它（枢纽不代读）'
        : undefined,
    };
  }

  /** 原始报文的**索引视图**：先看有哪些，再按 `ref` 取全文。 */
  rawIndex(opts = {}) {
    return this.recall.rawIndex(opts);
  }

  /**
   * 保留期清理（`retention.days`，`m03091` 用户要求"缓存超过一定天数自动清理"）：
   * 落盘的原始报文日文件 + 索引里的旧行 + 媒体 blob 一起清。内存环另有上限（`policy.limits`）。
   */
  pruneOld() {
    const days = Number(this.config.retention?.days ?? 0);
    if (!(days > 0)) return { skipped: true, days, note: 'retention.days 为 0 = 不清理' };
    const recall = this.recall?.prune?.({ days }) ?? null;
    const media = this.media?.prune?.({ days }) ?? null;
    const stats = { at: Date.now(), days, recall, media };
    this.#retentionStats = stats;
    const cleaned = (recall?.removedFiles ?? 0) + (recall?.removedRows ?? 0) + (media?.removed ?? 0);
    if (cleaned) {
      this.log(
        `保留期清理（${days} 天）：原始报文文件 ${recall?.removedFiles ?? 0} 个 / 内存行 ${recall?.removedRows ?? 0} 条 / `
        + `媒体 blob ${media?.removed ?? 0} 个（释放 ${media?.bytes ?? 0} 字节）`,
      );
    }
    return stats;
  }

  /**
   * 启动清理：会话卡里"发送失败却记成发言"的历史行（真机事故：hub-media 引用发不出去，
   * failed 的回复在卡里以"我：…"存着且落了盘——重启后模型照样以为自己说过）。
   * 按条目 id 反查 recall 账本里的裁决，`decision === 'failed'` 的行删掉；
   * 时间线与原文保留（排查用）。返回删掉的行数。
   */
  async purgeFailedSends() {
    await this.recall?.ensure?.();
    return this.cards?.pruneLinesWhere?.((line) => {
      const row = this.recall?.verdictOf?.(line?.id);
      return row?.decision === 'failed';
    }) ?? 0;
  }

  /** 启动时跑一次 + 之后按 `retention.cleanupIntervalMs` 周期跑（只建一次）。 */
  #startRetention() {
    const days = Number(this.config.retention?.days ?? 0);
    if (!(days > 0) || this.#retentionTimer) return null;
    try {
      this.pruneOld();
    } catch (err) {
      this.log(`保留期清理失败（不影响运行）：${err?.message ?? err}`);
    }
    const interval = Math.max(60000, Number(this.config.retention?.cleanupIntervalMs ?? 6 * 3600 * 1000) || 0);
    this.#retentionTimer = setInterval(() => {
      try {
        this.pruneOld();
      } catch (err) {
        this.log(`保留期清理失败（不影响运行）：${err?.message ?? err}`);
      }
    }, interval);
    this.#retentionTimer.unref?.();
    return interval;
  }

  connectUpstream() {
    this.#startRetention();

    if (this.config.upstreamListen) {
      const { host, port } = this.config.upstreamListen;
      this.upstream = new UpstreamListener({
        host,
        port,
        path: this.config.upstreamListen.path ?? '/',
        accessToken: this.config.upstreamAccessToken,
        requestTimeout: this.config.requestTimeout ?? 30000,
        heartbeatTimeout: this.config.heartbeatTimeout ?? 120000,
        log: this.log,
        onEvent: (event) => this.handleUpstreamEvent(event),
        onStatus: (status) => this.#onUpstreamStatus(status),
        // 对方拨进来时握手头里就带着它的账号：这里立刻学到，不必等第一条事件。
        onIdentity: ({ selfId, source }) => this.learnUpstreamAccount(selfId, source ?? 'upstream-handshake'),
      });
      this.upstream.start();
      return this.upstream;
    }
    if (!this.config.upstreamUrl) {
      this.log('未配置 upstreamUrl / upstreamListen，hub 仅作为下游实现端运行（可被其它枢纽接驳）');
      return null;
    }
    this.upstream = new UpstreamEndpoint({
      url: this.config.upstreamUrl,
      selfId: this.config.upstreamSelfId ?? this.config.selfId ?? '0',
      accessToken: this.config.upstreamAccessToken,
      reconnectInterval: this.config.reconnectInterval ?? 5000,
      requestTimeout: this.config.requestTimeout ?? 30000,
      heartbeatTimeout: this.config.heartbeatTimeout ?? 120000,
      log: this.log,
      onEvent: (event) => this.handleUpstreamEvent(event),
      onStatus: (status) => this.#onUpstreamStatus(status),
    });
    this.upstream.start();
    return this.upstream;
  }

  stop() {
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = null;
    }
    if (this.#retentionTimer) {
      clearInterval(this.#retentionTimer);
      this.#retentionTimer = null;
    }
    this.#probeWindows.clear();
    this.upstream?.stop();
    for (const dialer of this.#dialers.values()) dialer.stop();
    for (const listener of this.#listeners.values()) listener.stop();
    this.#listeners.clear();
    this.downstream?.close();
    this.flushStorage();
    this.recall?.close?.();
    this.turns?.close?.();
  }

  // ---------------------------------------------------------------- 上游 → 下游

  /**
   * 观测写档案（§24.2 M16）：**只有"看到就知道"的东西由代码写**——这个人叫什么、
   * 在这个群里挂什么名片、什么角色；以及"这个会话最后热闹到什么时候"。
   *
   * 兴趣、印象、承诺、纠正这些**提炼**一律不写：那是模型的事（`onebot_memory`），
   * 代码去猜就是越权，而且猜错了没人能纠正它。
   */
  observeProfiles(event) {
    // 注意：**不看 `storage.enabled`**。关掉存储只是"不写盘"，进程内的档案照样该攒——
    // 否则一次配置失手会让 bot 当场失忆，而它其实还活着。
    if (!this.profiles) return null;
    if (event?.post_type !== 'message') return null;
    const at = Date.now();
    const scope = sessionKey(event);
    const userId = String(event.user_id ?? '');
    const sender = event.sender ?? {};
    try {
      if (userId) {
        const name = sender.card || sender.nickname;
        if (name) this.profiles.noteName(userId, name, scope, at);
        if (event.group_id) {
          this.profiles.noteGroupCard(
            userId,
            `group:${event.group_id}`,
            { card: sender.card ?? null, role: sender.role ?? null, title: sender.title ?? null, level: sender.level ?? null, lastSentAt: at },
            at,
          );
        }
      }
      const worldKey = event.group_id ? `group:${event.group_id}` : userId ? `private:${userId}` : scope;
      this.profiles.touchSession(
        worldKey,
        { kind: event.group_id ? 'group' : 'private', lastMessageAt: at, lastSeenAt: at },
        at,
      );
    } catch (err) {
      this.log(`观测写档案失败（不影响转发）：${err?.message ?? err}`);
    }
    return true;
  }

  /**
   * 话题关联（§24.4，代码侧）：**"这条在聊同一件事"是语义判断，代码不做**；
   * 代码只做一件机械的事——这一条明确引用了（`reply` 段）某条已经在话题里的消息时，
   * 把它接进同一条线，顺手把世界与人补上。
   *
   * 为什么只用引用关系：关键词相似是猜测，猜错一次就把无关的事塞进同一条线。
   * 而"引用了那条消息"是协议里明写的证据，错了也不是它在猜。
   */
  attachTopic(entry, event) {
    if (!this.profiles || !entry) return null;
    const messageId = entry.refs?.message_id ?? event?.message_id ?? null;
    const target = replyTargetId(event);
    if (!target) return null;
    const worldKey = event?.group_id ? `group:${event.group_id}` : event?.user_id ? `private:${event.user_id}` : entry.sessionKey;
    const topic = this.profiles.attachTopicByReply({
      eventId: entry.id,
      messageId: target,
      worldKey,
      actorId: event?.user_id ?? null,
      at: Date.now(),
    });
    if (!topic) return null;
    this.log?.(`话题关联：消息 ${messageId ?? entry.id} 引用了 ${target}，接进话题「${topic.title ?? topic.id}」`);
    return topic;
  }

  /**
   * 观测写档案（续）：能力调用**拿回来的**观测信息（群名、人数、群主、公告、名片、性别年龄）。
   *
   * 和 `observeProfiles` 同一条界线：这些是"看到的"。模型可以去记"这个群爱聊硬件"，
   * 但不能凭空写"这群有三百人"——所以人数、群主、公告只从这里进来。
   * 整段容错：写档案失败绝不能影响这次能力调用的返回值。
   */
  observeActionResult(action, params = {}, data) {
    if (!this.profiles || !data) return null;
    const name = String(action ?? '').replace(/^_/, '');
    const at = Date.now();
    const worldOf = (gid) => `group:${gid}`;
    try {
      if (name === 'get_group_info' && data.group_id) {
        const patch = {};
        if (data.group_name) patch.name = data.group_name;
        if (Number.isFinite(Number(data.member_count))) patch.memberCount = Number(data.member_count);
        if (Object.keys(patch).length) this.profiles.upsertGroup(worldOf(data.group_id), patch, at);
      } else if (name === 'get_group_notice') {
        const list = Array.isArray(data) ? data : Array.isArray(data.notices) ? data.notices : [];
        const latest = list.slice().sort((a, b) => (b?.publish_time ?? 0) - (a?.publish_time ?? 0))[0];
        const text = latest?.message?.text ?? (typeof latest?.message === 'string' ? latest.message : '');
        const gid = params.group_id ?? latest?.group_id;
        // 不按字数截（m24155）：公告全文落档案，渲染侧的长度控制由调用方负责。
        if (text && gid) this.profiles.upsertGroup(worldOf(gid), { notice: String(text) }, at);
      } else if (name === 'get_group_member_list' && Array.isArray(data) && params.group_id) {
        const world = worldOf(params.group_id);
        const owner = data.find((m) => m?.role === 'owner');
        const active = data
          .slice()
          .sort((a, b) => (b?.last_sent_time ?? 0) - (a?.last_sent_time ?? 0))
          .slice(0, 5)
          .map((m) => ({ user_id: String(m?.user_id ?? ''), nickname: m?.card || m?.nickname || '', lastSentAt: m?.last_sent_time ?? null }))
          .filter((m) => m.user_id);
        this.profiles.upsertGroup(world, { ownerId: owner?.user_id ?? null, activeMembers: active }, at);
        for (const m of data.slice(0, 50)) {
          if (!m?.user_id) continue;
          this.profiles.noteGroupCard(
            m.user_id,
            world,
            { card: m.card || m.nickname, role: m.role, title: m.title, level: m.level, lastSentAt: m.last_sent_time },
            at,
          );
        }
      } else if (name === 'get_group_member_info' && data.user_id && params.group_id) {
        this.profiles.noteGroupCard(
          data.user_id,
          worldOf(params.group_id),
          { card: data.card || data.nickname, role: data.role, title: data.title, level: data.level, lastSentAt: data.last_sent_time },
          at,
        );
      } else if (name === 'get_stranger_info' && data.user_id) {
        const patch = {};
        for (const k of ['sex', 'age', 'level']) if (data[k] !== undefined && data[k] !== null) patch[k] = data[k];
        if (Object.keys(patch).length) this.profiles.upsertPerson(data.user_id, { profile: { ...patch, profileAt: at } }, at);
        if (data.nickname) this.profiles.noteName(data.user_id, data.nickname, `private:${data.user_id}`, at);
      }
    } catch (err) {
      this.log(`观测 action 结果写档案失败（不影响调用）：${err?.message ?? err}`);
    }
    return true;
  }

  /** 处理一条上游真实事件：防环 → 记时间线 → 按策略零改写下发。 */
  handleUpstreamEvent(event) {
    const linkId = this.upstreamLinkId;
    const kind = eventKind(event);
    // "上游是谁"：每条 OneBot 事件的 `self_id` 都是**实现端登录的账号**，所以这是最省事的
    // 一条学习路径（不额外发请求）。配置没写 `upstreamSelfId` 时，下游"默认与上游相同"的
    // 目标就靠它建链。学到什么不改转发决策，只是记账。
    if (event?.self_id !== undefined) this.learnUpstreamAccount(event.self_id, '上游事件');

    const verdict = this.guard.check({ linkId, direction: 'upstream', event });
    if (verdict.action === 'drop') {
      this.capture.add({
        linkId,
        kind,
        direction: 'upstream-in',
        action: 'event',
        decision: 'dropped',
        reason: verdict.reason,
        sessionKey: sessionKey(event),
        text: this.humanText(event),
      });
      return { delivered: 0, dropped: verdict.reason };
    }

    /**
     * 聊天管理命令（②§26）的**同步分诊**。
     *
     * 放在这里（guard 之后、记账之前）有两个原因：
     *  1. 判定**必须是同步的**：转发主链路不能因为要等一次命令回话就变成异步。
     *     真正执行（可能发网络）在后面 fire-and-forget。
     *  2. 命中时 `decision` 记成 `chat-command:xxx`，一眼能看出这条消息**同时**被枢纽当命令
     *     处理过。注意这个 decision **不代表它没被转发**——它照常投下游。
     */
    let commandVerdict = null;
    if (this.chatCommands && isMessageEvent(event)) {
      try {
        const verdict = this.chatCommands.classify({
          event,
          userId: event.user_id ?? event.sender?.user_id,
          sessionKey: sessionKey(event),
        });
        if (verdict?.act) commandVerdict = verdict;
      } catch (err) {
        // 判定本身出错绝不能连累转发：退化成"这是一条普通消息"。
        this.log(`聊天命令判定失败（按普通消息处理）：${err?.message ?? err}`);
      }
    }

    const recordDecision = commandVerdict
      ? `chat-command:${commandVerdict.command}`
      : event.post_type === 'message_sent' && !this.config.deliverMessageSent
        ? 'recorded:message_sent'
        : 'recorded';
    const entry = this.timeline.record({
      direction: 'upstream-in',
      linkId,
      event,
      decision: recordDecision,
      text: this.humanText(event),
    });
    this.observeProfiles(event);
    // 话题关联（§24.4，代码侧）：这一条**引用了**某条已有话题里的消息时，接进同一条线。
    // 只用明写的引用关系，不做关键词猜测；接不上就算了（没记住比记错好）。
    try {
      this.attachTopic(entry, event);
    } catch (err) {
      this.log(`话题关联失败：${err?.message ?? err}`);
    }
    // 媒体落地是异步旁路：转发不等它，落地后回填 refs/文本（§22.6 M14）
    this.#resolveMedia(entry, event);
    // 成员名解析（§23.6）：@ 到的人若这群里还没名字，按需问一次实现端；
    // 同样是旁路——这一条消息照旧渲成 QQ，问到了下一句就叫得出名字。
    try {
      if (this.members?.note(event, { selfId: this.config.upstreamSelfId ?? this.config.selfId ?? '' })) {
        this.members.pump().catch((err) => this.log(`成员解析失败（不影响转发）：${err?.message ?? err}`));
      }
    } catch (err) {
      this.log(`成员解析入队失败：${err?.message ?? err}`);
    }
    /**
     * 命令回话（②§26）：**与转发并行，不是替代**。
     *
     * 命中命令时枢纽以上游身份回一条，而且**不 await**——转发主链路不该被一次命令回话拖住，
     * 命令自己的成败有它自己的日志和 stats。回完**继续往下走**去投下游：`/` 是公共前缀，
     * 下游插件可能也有同名命令，枢纽没有资格把消息从转发链路上摘掉。
     *
     * 唯一被抑制的是**模型**：下面把 `silent: 'chat-command'` 传给钩子，`mind.observe` 看见
     * 就不入批量窗口。理由是枢纽已经用同一个账号答过这句话了，同一个账号对同一句话答两次是
     * 鬼故事。这不是"拦截消息"——转发循环一个字节都没少投。
     */
    if (commandVerdict) {
      // 只读（`shadow`）：命令**照常识别、照常记时间线**，但 hub 不代替作答——
      // "全量观察，绝不动作"里的"动作"就包括 hub 自己开口。命令的识别结果照样喂给模型钩子，
      // 下游也照样收到原消息（下一段），所以只读模式不会让消息凭空消失。
      if (this.readonly) {
        this.log(`只读预设：命中命令 /${commandVerdict.command}，只记录不代替作答`);
      } else {
        this.#answerChatCommand(commandVerdict, event).catch((err) =>
          this.log(`命令回话失败（/${commandVerdict.command}）：${err?.message ?? err}`),
        );
      }
    }

    try {
      this.hooks.onUpstreamEvent?.(entry, {
        event,
        linkId,
        isSelf: event.post_type === 'message_sent',
        silent: commandVerdict && !this.readonly ? 'chat-command' : null,
      });
    } catch (err) {
      this.log(`onUpstreamEvent 钩子失败：${err?.message ?? err}`);
    }

    if (event.post_type === 'message_sent' && !this.config.deliverMessageSent) {
      return { delivered: 0, dropped: 'message_sent(未配置下发)' };
    }

    // ---- 探针隔离（M7-④）：探测窗口内的真人消息**暂缓**投下游，窗口一到按原序补发 ----
    const window = this.#probeWindowFor(event);
    if (window) {
      this.#holdForProbe(window, event, kind);
      return { delivered: 0, held: true, probeWindow: window.sessionKey };
    }

    const { delivered } = this.#deliverToDownstreams(event, kind);
    return { delivered, dropped: null };
  }

  /**
   * 把一条上游事件投给所有该收的下游链路（原帧重签，只动 `self_id`/`message_id`/`dsh_trace`）。
   *
   * 抽成独立方法只有一个原因：**探针窗口的补发要走完全相同的一段逻辑**——同一次策略判定、
   * 同样的重签与记账。否则"晚几秒到"会变成"到得不一样"，那比不隔离更糟。
   */
  #deliverToDownstreams(event, kind, extraRefs = null) {
    const linkId = this.upstreamLinkId;
    const hop = Number(readTrace(event)?.hop ?? 0) + 1;
    let delivered = 0;
    for (const [downLinkId, { session, world }] of this.#worlds) {
      if (!session.isOpen) continue;
      const target = this.targetOf(String(downLinkId).replace(/^down:/, ''));
      const decision = decideEvent(this.policy, {
        linkId: downLinkId,
        kind,
        selfId: event.self_id,
        targetSelfId: session.selfId,
        // 链路隔离（`probe.isolation: 'link'`）：标了 probeOnly 的链路**只收注入**，
        // 上游真人消息一条都不投——归属就退化成"从哪条链路回来的"，零推断。
        probeOnly: target?.probeOnly === true,
      });
      if (!decision.deliver) continue;

      const virtualId = this.config.virtualizeMessageId && isMessageEvent(event)
        ? `virtual:${session.selfId}:${++this.#virtualSeq}`
        : undefined;
      const downstreamEvent = retagEvent(event, {
        selfId: session.selfId,
        messageId: virtualId,
        trace: LoopGuard.stamp({ hop, linkId: downLinkId }),
      });
      if (this.config.remapAtSelf) {
        remapAt(downstreamEvent, this.config.upstreamSelfId ?? this.config.selfId, session.selfId);
      }
      world.rememberEvent(downstreamEvent, { virtualId });
      const ok = session.send(downstreamEvent);
      if (ok) {
        delivered += 1;
        this.timeline.record({
          direction: 'downstream-out',
          linkId: downLinkId,
          event: downstreamEvent,
          decision: decision.mode,
          refs: {
            upstreamLinkId: linkId,
            upstreamMessageId: event.message_id ?? null,
            downstreamId: target?.downstreamId,
            downstreamLabel: this.labelOf(downLinkId),
            ...(extraRefs ?? {}),
          },
        });
      }
    }
    return { delivered, dropped: null };
  }

  // ---------------------------------------------------------------- 探针隔离（M7-④，§19）

  /**
   * 这个会话此刻是不是处在探针独占窗口里（只有 `time` 档有窗口）。
   *
   * 只对**消息类**事件生效：通知/请求不入队——群友的发言要保证送达，系统通知晚到毫无意义。
   */
  #probeWindowFor(event) {
    if (this.probeIsolation !== 'time') return null;
    if (!isMessageEvent(event)) return null;
    const key = sessionKey(event);
    const window = this.#probeWindows.get(key);
    if (!window) return null;
    if (window.until <= Date.now()) return null; // 已到点：等 tick 释放（不在这里补发，避免递归）
    return window;
  }

  /**
   * 把一条真人消息排进窗口队列。
   *
   * 记一条 `held:probe-window` 时间线**不是**"它没投"的宣告：它带着与正常转发相同的
   * `upstreamLinkId`/`upstreamMessageId`（所以会话卡里仍只算一行，不会让模型以为群友说了两遍），
   * 补发时会有各自的 `probeReleased` 记录。一眼能看出"这条被延后了、延后多久"。
   */
  #holdForProbe(window, event, kind) {
    const maxQueued = Math.max(1, Number(this.config.probe?.maxQueued ?? 50) || 50);
    window.queue.push({ event, kind, at: Date.now() });
    this.#probeStats.held += 1;
    this.timeline.record({
      direction: 'downstream-out',
      linkId: 'hub:probe-window',
      event,
      decision: 'held:probe-window',
      refs: {
        upstreamLinkId: this.upstreamLinkId,
        upstreamMessageId: event.message_id ?? null,
        heldFor: 'probe',
        probeSessionKey: window.sessionKey,
        queued: window.queue.length,
      },
    });
    // 上限是**安全阀**，不是丢弃理由：超了就立刻按原序补发，绝不吞消息。
    if (window.queue.length > maxQueued) {
      this.log(`探针窗口队列超限（${window.queue.length}/${maxQueued}）：立刻按原序补发，绝不吞消息`);
      this.#probeStats.forcedReleases += 1;
      this.#releaseProbeWindow(window.sessionKey);
    }
  }

  /** 打开（或延长）一个探针独占窗口——`sendMessageToDownstream` 注入之后调。 */
  #openProbeWindow(key, { reason } = {}) {
    // 注入计数与档位无关：它是"agent 试了几次"的账，`link`/`off` 档也要记。
    this.#probeStats.injections += 1;
    if (!key) return null;
    // 窗口只属于 `time` 档：`link` 档靠链路分家，`off` 档本来就不隔离——开了也没人看，白跑定时器。
    if (this.probeIsolation !== 'time') return null;
    const ms = Math.max(500, Number(this.config.probe?.windowMs ?? 8000) || 8000);
    const window = this.#probeWindows.get(key) ?? {
      sessionKey: key,
      openedAt: Date.now(),
      until: 0,
      queue: [],
      probes: 0,
      reason: null,
    };
    window.until = Date.now() + ms;
    window.probes += 1;
    window.reason = reason ?? window.reason;
    if (window.probes === 1) this.#probeStats.windowsOpened += 1;
    this.#probeWindows.set(key, window);
    this.#armProbeTimer();
    return window;
  }

  /** 到点才释放：轮询比给每条消息挂定时器省事，200ms 的粒度对"等几秒"够用。 */
  #armProbeTimer() {
    if (this.#probeTimer) return;
    const tick = () => {
      this.#probeTimer = null;
      this.#releaseProbeWindows();
      if (this.#probeWindows.size) this.#armProbeTimer();
    };
    this.#probeTimer = setTimeout(tick, 200);
    this.#probeTimer.unref?.();
  }

  #releaseProbeWindows() {
    const now = Date.now();
    for (const [key, window] of [...this.#probeWindows]) {
      if (window.until > now) continue;
      this.#releaseProbeWindow(key);
    }
  }

  /**
   * 关掉一个窗口并按原序补发它排下的消息。
   *
   * 补发走 `#deliverToDownstreams`（**不经过**窗口判定），所以补发过程不会再排回同一个窗口；
   * 窗口在补发前就已从表里删除，重复调用是安全的。
   */
  #releaseProbeWindow(key) {
    const window = this.#probeWindows.get(key);
    if (!window) return 0;
    this.#probeWindows.delete(key);
    const queued = window.queue.splice(0);
    const now = Date.now();
    for (const item of queued) {
      try {
        this.#deliverToDownstreams(item.event, item.kind, {
          probeReleased: true,
          probeHeldMs: now - item.at,
          probeSessionKey: key,
        });
      } catch (err) {
        this.log(`探针窗口补发失败（${key}）：${err?.message ?? err}`);
      }
    }
    this.#probeStats.released += queued.length;
    if (queued.length) this.log(`探针窗口关闭（${key}）：补发 ${queued.length} 条上游消息`);
    return queued.length;
  }

  /**
   * **生效的**探针隔离档位（不是配置里写的那一档）。
   *
   * `link` 档要有一条探针链路（目标里写了 `probeSelfId`，或显式标了 `probeOnly`）才有意义：
   * 一条都没有时**回退到 `off`**。这是刻意的——假装隔离了比明说不隔离更危险，agent 会以为
   * "注入的结果就是群里的真实结果"，而实际上两组消息可能混在同一条链路上。
   */
  get probeIsolation() {
    const mode = this.config.probe?.isolation ?? 'off';
    if (mode === 'link' && !this.probeLinkId) return 'off';
    return mode;
  }

  /** 标了 `probeOnly` 的那条链路（`down:<id>` 形态）；没有就是 `null`。 */
  get probeLinkId() {
    const target = this.#targets.find((entry) => entry.probeOnly === true);
    return target?.id ? `down:${target.id}` : null;
  }

  /** 一条链路的**逻辑下游** id（人声明的分组；缺省 = 该目标自己的键）。 */
  downstreamIdOf(linkId) {
    const id = String(linkId ?? '').replace(/^down:/, '');
    return this.targetOf(id)?.downstreamId ?? (id || undefined);
  }

  /** 探针隔离现状（`onebot_hub_status` 的 `probe` 段）。 */
  get probeSnapshot() {
    const cfg = this.config.probe ?? {};
    const requested = cfg.isolation ?? 'off';
    const mode = this.probeIsolation;
    const fallback = requested !== mode;
    return {
      isolation: mode,
      requested,
      note: fallback
        ? `配置写的是 link，但没有任何探针链路（目标里没写 probeSelfId、也没有显式 probeOnly 的目标），已**回退到关闭隔离**：注入和真人消息走同一条链路，探针结果可能与用户触发时不同。`
        : mode === 'time'
          ? '探测窗口内该会话的上游消息暂缓投下游，窗口一到按原序补发（不需要额外配置）'
          : mode === 'link'
            ? '上游消息一条都不投给探针链路（另一个账号），注入默认只走那条；探针链路的结果与用户触发时**可能不同**，别当成群里真实发生的事'
            : '不隔离：注入与真人消息混在同一条链路上（旧行为）',
      windowMs: cfg.windowMs,
      maxQueued: cfg.maxQueued,
      capture: cfg.capture !== false,
      probeLink: this.probeLinkId,
      activeWindows: [...this.#probeWindows.values()].map((window) => ({
        sessionKey: window.sessionKey,
        openedAt: window.openedAt,
        until: window.until,
        remainingMs: Math.max(0, window.until - Date.now()),
        probes: window.probes,
        queued: window.queue.length,
        reason: window.reason,
      })),
      stats: { ...this.#probeStats },
    };
  }

  // ---------------------------------------------------------------- 下游 → 上游

  /** 处理下游来的任意帧：action（绝大多数）或它自己推来的事件。 */
  async handleDownstreamFrame(session, frame) {
    if (frame?.post_type) return this.#handleDownstreamEvent(session, frame);
    if (frame?.action) return this.#handleDownstreamAction(session, frame);
    if (frame?.status !== undefined && frame?.echo !== undefined) return null;
    this.log(`[${session.selfId}] 未识别帧：${JSON.stringify(frame)?.slice(0, 200)}`);
    return null;
  }

  async #handleDownstreamAction(session, frame) {
    // 用挂载时算好的 linkId（`#attachDownstream` 里写的）：多下游时 selfId 可能重复，
    // 只有目标键能唯一定位这条链路。
    const linkId = session.linkId ?? `down:${session.selfId}`;
    const action = String(frame.action);
    const params = frame.params ?? {};
    const echo = frame.echo ?? null;
    const mode = decideAction(this.policy, { action });
    const isSend = action.startsWith('send_');
    // 共享入口（A′，`m28267`/`m29922`）：`send_msg` 走 `params.message`；`send_*_forward_msg`
    // 只包一个 forward 占位段（与群友聊天记录同待遇，内容不展开）——文本非空能进批次，
    // 节点里的图由 `#resolveDownstreamMedia` 照样落媒体。
    const segments = segmentsFromParams(params);
    const text = isSend ? messageToText(segments) : undefined;
    // 多下游时 `linkId`/`downstreamId` 常常长得一模一样（`host:port`），记录里必须带上人话名字。
    const label = this.labelOf(linkId);
    const downstreamId = this.downstreamIdOf(linkId);

    const capture = this.capture.add({
      linkId,
      downstreamId,
      downstreamLabel: label,
      selfId: session.selfId,
      action,
      params,
      decision: mode,
      text,
      direction: 'downstream-in',
    });
    const outKey = sessionKey({
      post_type: 'message',
      message_type: params.message_type ?? (params.group_id ? 'group' : 'private'),
      group_id: params.group_id,
      user_id: params.user_id,
    });
    const entry = this.timeline.record({
      direction: 'downstream-in',
      linkId,
      selfId: session.selfId,
      action,
      params,
      decision: mode,
      text,
      refs: { sessionKey: outKey, downstreamId, downstreamLabel: label },
    });
    if (isSend) {
      // 下游发出来的图/语音也要落地 + 看图（`m02768`）：否则 agent 只看到 `[图片]`，捕获账本里
      // 还塞着整段 base64。异步旁路，不改转发帧（转发用的是原始 `params`）。
      this.#resolveDownstreamMedia({ entry, capture }, params, segments);
      try {
        this.hooks.onDownstreamSend?.({
          linkId,
          sessionKey: outKey,
          action,
          params,
          selfId: session.selfId,
          text,
          // 多下游时"这条是谁发的"要能分辨（`labelOf` 带"（探针）"后缀）；编排层拿它当说话人名字，
          // 写进"本批新消息"（见 `Mind.noteDownstreamSend`）。
          label,
          // 时间线真身：批次条目带上它，开局快照就能按 id 去重（同一条话不再出现两遍）。
          ts: entry.ts,
          timelineId: entry.id,
          // 真身对象本身（v4，`m26571`）：看图描述是**异步**回填到 `entry.text` 的，
          // 批次条目只快照一份 `text` 的话，描述晚到一步就永远停在 `[图片]`——
          // 于是"本批新消息"比"开局快照"还糙（快照那侧走会话卡，`cards.patch` 会同步改）。
          entry,
        });
      } catch (err) {
        this.log(`onDownstreamSend 钩子失败：${err?.message ?? err}`);
      }
    }

    const world = this.worldOf(linkId);
    if (!world) return null;

    // M13-①（§22.2）：`bot-app` 型下游（NoneBot 这类 bot 应用）的**只读**请求先问真实现端，
    // 与 agent 共享同一份缓存和"实测不支持"结论。答不了再退回虚拟世界：世界只看得见 hub
    // 转发过的东西，是近似的第二选择——但正因如此，hub 自己注入的事件（实现端根本没那条消息）
    // 它反而答得上，而 `get_msg` 正是 NoneBot 的 `_check_reply` 每次都会问的。
    // 策略拒绝（敏感只读之类）**绝不回退**，否则闸门形同虚设。
    // 注意 `mode`：relay 预设把 `get_*` 判成 `local`（"本地作答"），而对 `bot-app` 型下游，
    // "本地"的正解就是**先走能力面**（真实现端 + 与 agent 共享的缓存），答不了才退回虚拟世界。
    // 'deny' 不在放行之列——策略说要拒，就不该拿能力面绕过去。
    const kind = this.#worlds.get(linkId)?.kind;
    if (
      !isSend &&
      kind === 'bot-app' &&
      this.config.capability?.downstreamReads !== false &&
      tierOf(baseAction(action)) === 'read' &&
      (mode === 'local' || mode === 'relay' || mode === 'both')
    ) {
      const shaped = await this.callAction({ action, params, source: 'downstream' });
      if (shaped.ok || shaped.source === 'policy') {
        const result = toWireResponse(shaped, echo);
        session.send(result);
        return result;
      }
      const local = await world.handleAction(frame);
      if (local && (local.status === 'ok' || local.retcode === 0)) {
        this.log(`能力面答不了 ${action}（${shaped.source}/${shaped.retcode}），按虚拟世界观测回复下游`);
        session.send(local);
        return local;
      }
      this.log(`能力面答不了 ${action}（${shaped.source}/${shaped.retcode}），虚拟世界也没有，按能力面结论回复`);
      const result = toWireResponse(shaped, echo);
      session.send(result);
      return result;
    }

    // 只读 action 与发送类永远交给 world（world 内部再按策略路由出站）。
    if (isSend || isLocalAction(action, { allow: this.config.localActionAllow ?? [], deny: this.config.localActionDeny ?? [] })) {
      const result = await world.handleAction(frame);
      session.send(result);
      return result;
    }

    let result;
    switch (mode) {
      case 'deny':
        result = { status: 'failed', retcode: 1403, msg: `策略拒绝：${action}`, echo };
        break;
      case 'relay':
      case 'both': {
        if (!this.upstream?.isConnected) {
          result = { status: 'failed', retcode: 1201, msg: '上游链路未连接', echo };
          break;
        }
        const res = await this.upstream.request(action, params);
        this.timeline.record({ direction: 'hub-out', linkId: this.upstreamLinkId, action, params, decision: mode });
        result = { ...res, echo };
        if (mode === 'both') {
          // `bridge` 预设：既转给上游，也广播给其它下游（不含来源链路）。
          const mirrored = await this.#mirror(session, action, params, echo);
          result.data = { ...(res?.data ?? {}), mirrored: mirrored?.data?.mirrored ?? 0, mirroredTotal: mirrored?.data?.total ?? 0 };
        }
        break;
      }
      case 'mirror': {
        result = await this.#mirror(session, action, params, echo);
        break;
      }
      case 'drop': {
        // 静默丢弃：回"成功空壳"——与 `capture` 的区别就在**没有句柄**：
        // capture 给一个虚拟 message_id（下游以为自己发成功了），drop 什么都不给。
        result = makeResult(echo, {});
        break;
      }
      case 'local':
        result = await world.handleAction(frame);
        break;
      default:
        result = makeResult(echo, { captured: true, note: 'hub 按策略仅记录，未执行' });
        break;
    }
    session.send(result);
    return result;
  }

  /** 出站裁决：下游调 send_* 时由 world 回调进来。 */
  async #routeOutbound(session, world, out) {
    const linkId = world.linkId;
    /**
     * 链路隔离的另一半（M7-④）：探针链路的产物**先给 agent 看**，不直接进群。
     *
     * 为什么默认这么做：探针那条链路存在的唯一理由就是"试探"。它发出来的东西是**试验结果**，
     * 要不要真的说出去是 agent 的判断（用户 m19548 的原话就是"由 agent 拿到后决定是否发出"）。
     * 这里不做成"扣住等裁决"（那会让下游以为它已经说过了），而是把出站判成 `capture`——
     * 下游照常拿到成功回包与虚拟句柄，内容进时间线/捕获账本，agent 想看就看。
     */
    const probeCapture =
      this.config.probe?.capture !== false && this.isProbeLink(linkId) && String(out.action).startsWith('send_');
    const mode = probeCapture ? 'capture' : decideAction(this.policy, { action: out.action });
    const text = messageToText(segmentsOf({ message: out.send.message }));
    const pseudo = {
      post_type: 'message',
      message_type: out.send.message_type,
      self_id: this.config.upstreamSelfId ?? this.config.selfId ?? session.selfId,
      user_id: this.config.upstreamSelfId ?? this.config.selfId ?? session.selfId,
      group_id: out.send.group_id,
      message: out.send.message,
    };

    switch (mode) {
      case 'deny':
        return { __error: `策略拒绝：${out.action}`, retcode: 1403 };
      case 'relay':
      case 'both': {
        if (!this.upstream?.isConnected) return { __error: '上游链路未连接', retcode: 1201 };
        const res = await this.upstream.request(out.action, out.raw);
        if (res.status !== 'ok') return { __error: res.msg ?? '上游拒绝', retcode: res.retcode ?? 1200 };
        this.guard.noteSent({ linkId: this.upstreamLinkId, event: pseudo });
        this.timeline.record({
          direction: 'hub-out',
          linkId: this.upstreamLinkId,
          action: out.action,
          params: out.raw,
          decision: mode,
          text,
          refs: { fromLink: world.linkId, fromLabel: this.labelOf(world.linkId), message_id: res.data?.message_id ?? null },
        });
        if (mode === 'both') {
          // 真实发出的那条以**上游结果**为准（回真 message_id），广播给其它下游是附加动作：
          // 它成功几条要如实告诉下游（`extra` 会被 world 并进应答），但**不能**用它冒充
          // "发到 QQ 成功了"——那件事的真假只看上游那一次。
          const fanned = await this.#mirror(session, out.action, out.raw, null);
          return {
            message_id: res.data?.message_id,
            extra: { mirrored: fanned?.data?.mirrored ?? 0, mirroredTotal: fanned?.data?.total ?? 0 },
          };
        }
        return { message_id: res.data?.message_id };
      }
      case 'mirror': {
        const mirrored = await this.#mirror(session, out.action, out.raw, null);
        return {
          message_id: mirrored?.data?.message_id,
          extra: { mirrored: mirrored?.data?.mirrored ?? 0, mirroredTotal: mirrored?.data?.total ?? 0 },
        };
      }
      case 'drop': {
        // 出站被静默丢弃：先把观测记下来（这条真的来过），再回哨兵 `__silent`——
        // world 看见它就回成功空壳，**不会**补一个虚拟 message_id。
        this.timeline.record({
          direction: 'downstream-out',
          linkId: world.linkId,
          action: out.action,
          params: out.raw,
          decision: mode,
          text,
        });
        return { __silent: true };
      }
      default: {
        this.timeline.record({
          direction: 'downstream-out',
          linkId: world.linkId,
          action: out.action,
          params: out.raw,
          decision: mode,
          text,
          // 探针产物：`probe: true` 就是"这条是试验结果，还没真的发出去"的标记。
          ...(probeCapture
            ? { refs: { probe: true, downstreamId: this.downstreamIdOf(linkId), downstreamLabel: this.labelOf(linkId) } }
            : {}),
        });
        return { captured: true };
      }
    }
  }

  /** 广播到其它下游链路（不含来源链路）。 */
  async #mirror(session, action, params, echo) {
    const targets = [...this.#worlds.values()].filter(({ session: s }) => s !== session && s.isOpen);
    if (!targets.length) return makeResult(echo, { mirrored: 0 });
    const results = await Promise.allSettled(targets.map(({ session: s }) => s.request(action, params)));
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value?.status === 'ok');
    return makeResult(echo, { mirrored: ok.length, total: targets.length });
  }

  /** 下游推来的事件（下游自己也是枢纽时才会发生）。 */
  #handleDownstreamEvent(session, event) {
    const linkId = session.linkId ?? `down:${session.selfId}`;
    const verdict = this.guard.check({ linkId, direction: 'downstream', event });
    if (verdict.action === 'drop') return { delivered: 0, dropped: verdict.reason };
    this.timeline.record({ direction: 'downstream-in', linkId, event, decision: 'recorded' });

    const hop = Number(readTrace(event)?.hop ?? 0) + 1;
    let delivered = 0;
    if (this.upstream?.isConnected && this.policy.event.broadcast) {
      const out = retagEvent(event, { selfId: this.config.upstreamSelfId ?? this.config.selfId, trace: LoopGuard.stamp({ hop, linkId: this.upstreamLinkId }) });
      this.upstream.sendEvent?.(out);
      delivered += 1;
    }
    for (const [otherLinkId, { session: other, world }] of this.#worlds) {
      if (other === session || !other.isOpen) continue;
      const out = retagEvent(event, { selfId: other.selfId, trace: LoopGuard.stamp({ hop, linkId: otherLinkId }) });
      world.rememberEvent(out);
      if (other.send(out)) delivered += 1;
    }
    return { delivered };
  }

  /**
   * 解析下游链路。接受三种写法：`down:<目标id>`（规范写法）、裸 `<目标id>`、裸 `<selfId>`。
   * 多下游时以 `id` 为准；`selfId` 只是"没重名时才成立"的便利写法（同一 selfId 挂两条链路时
   * 会命中第一条，所以状态里给出的 linkId 才是可靠入口）。
   */
  #resolveDownstream(linkId) {
    const key = String(linkId ?? '');
    const entry =
      this.#worlds.get(key) ??
      this.#worlds.get(`down:${key}`) ??
      [...this.#worlds.values()].find((w) => {
        const id = String(w.session.linkId ?? '').replace(/^down:/, '');
        return String(w.session.selfId) === key || id === key;
      });
    if (!entry) {
      const known = this.downstreamLinks.map((l) => `${l.linkId}${l.connected ? '' : '（未连接）'}`).join(', ') || '(无)';
      throw new Error(`未找到下游链路 ${linkId}；当前可用：${known}`);
    }
    if (!entry.session.isOpen) throw new Error(`下游链路 ${linkId} 未连接`);
    return entry;
  }

  /**
   * 向某条下游链路发一个 **action 请求**并等真实回包。
   *
   * 只有 `kind === 'implementation'` 的链路（对端是另一个实现端、它以为 hub 是 bot 应用）
   * 才合法。对 bot 应用型链路（NoneBot 等）发 action 请求会被对端当"无主回包"静默丢弃并
   * 挂到超时，所以在入口直接拒绝，引导调用方改用 `sendMessageToDownstream`。
   */
  async invokeDownstream(linkId, action, params = {}, timeoutMs) {
    const entry = this.#resolveDownstream(linkId);
    if (entry.kind !== 'implementation') {
      throw new Error(
        `链路 ${linkId} 是 bot 应用型（kind=bot-app）：OneBot v11 里 bot 应用只**发** action 请求、不**收** action 请求。` +
          `要让它做事，请改用 event 模式向下游注入一条消息事件。`,
      );
    }
    return entry.session.request(action, params, timeoutMs);
  }

  /**
   * 向某条下游链路**注入一条消息事件**（`onebot_invoke` 的默认模式）。
   *
   * 这是"控制下游 bot / 借它的嘴发消息"的正道：bot 应用只有收到**事件**才会跑它的
   * matcher，它的回应再以 `send_msg` action 回到 hub，由出站策略决定转发上游还是仅捕获。
   * 注入的事件带 `dsh_trace:{injected:true}`，万一被对端原样回推也能被防环闸识别。
   *
   * 三句关于寻址的话（M7-④ 链路隔离 + `m02768` 定案）：
   *  - **物理链路由枢纽决定**：调用方给 `downstream`（逻辑下游名/备注名/账号/目标键）就够，
   *    路由规则见 `pickInjectLink`（`link` 档一律探针链路，其它档走真实链路）。`linkId` 只在
   *    **非** `link` 档被当成物理链路键（测试与高级用法）；`allowRealLink: true` 才能让
   *    `link` 档故意打真实链路，且结果里一定带 `notIsolated` 告警。
   *  - 链路隔离下没有探针链路就**明确报错**，不猜一条来投。
   *  - 时间隔离下，注入成功即**打开该会话的探针独占窗口**：窗口内的真人消息
   *    先排队、窗口一关按原序补发（见 `#probeWindows`）。
   */
  sendMessageToDownstream({
    linkId,
    downstream,
    allowRealLink,
    message,
    text,
    message_type,
    group_id,
    user_id,
    sender,
    quote_message_id,
    sub_type,
  } = {}) {
    const pickedInfo = this.#pickInjectLink({ linkId, downstream, allowRealLink });
    const picked = pickedInfo.linkId;
    const { session, world } = this.#resolveDownstream(picked);
    const type = message_type ?? (group_id !== undefined && group_id !== null ? 'group' : 'private');
    let segments;
    if (Array.isArray(message)) {
      segments = message.map((s) => ({ type: String(s.type), data: { ...(s.data ?? {}) } }));
    } else {
      segments = [];
      if (quote_message_id !== undefined && quote_message_id !== '') {
        segments.push({ type: 'reply', data: { id: String(quote_message_id) } });
      }
      segments.push({ type: 'text', data: { text: String(text ?? '') } });
    }
    const speaker = user_id ?? this.config.upstreamSelfId ?? session.selfId;
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: numericId(session.selfId),
      post_type: 'message',
      message_type: type,
      sub_type: sub_type ?? (type === 'group' ? 'normal' : 'friend'),
      message_id: 900000000 + (this.#injectedSeq += 1),
      user_id: numericId(speaker),
      ...(type === 'group' ? { group_id: numericId(group_id) } : {}),
      raw_message: renderCq(segments),
      font: 0,
      sender: {
        user_id: numericId(speaker),
        nickname: sender?.nickname ?? 'hub',
        ...(type === 'group' ? { card: sender?.card ?? '', role: sender?.role ?? 'member' } : {}),
      },
      anonymous: null,
      message: segments,
      dsh_trace: LoopGuard.stamp({ hop: 1, linkId: picked, extra: { injected: true } }),
    };

    world.rememberEvent(event);
    const ok = session.send(event);
    const key = sessionKey(event);
    this.timeline.record({
      direction: 'downstream-out',
      linkId: picked,
      event,
      decision: 'injected',
      refs: {
        injected: true,
        sessionKey: key,
        downstreamId: this.downstreamIdOf(picked),
        // 多下游时 `downstreamId` 常常就是 `host:port`，两条链路的记录长得一模一样；
        // 记录里必须有个人能读的名字（探针链路带"（探针）"）。
        downstreamLabel: this.labelOf(picked),
      },
    });
    // 时间隔离（默认档）：注入成功就为这个会话开一段独占窗口，让"下游这条回复是注入引起的"
    // 不用靠时间戳猜。**只在实际发出去了**才开——发送失败时没有"归因"可言，不该拖住群友的话。
    const window = ok ? this.#openProbeWindow(key, { reason: '注入' }) : null;
    return {
      delivered: ok,
      linkId: picked,
      downstream: pickedInfo.downstreamId ?? this.downstreamIdOf(picked),
      downstreamLabel: pickedInfo.label ?? this.labelOf(picked),
      selfId: session.selfId,
      messageId: event.message_id,
      sessionKey: key,
      ...(window
        ? {
            probeWindow: {
              isolation: 'time',
              until: window.until,
              windowMs: Math.max(0, window.until - Date.now()),
              note: '窗口内该会话的上游消息暂缓投下游，窗口一到按原序补发（绝不丢）',
            },
          }
        : {}),
      // `allowRealLink` 的告警与探针链路的提醒都叫 caveat，但说的是两件不同的事，都要回去。
      ...(pickedInfo.notIsolated ? { notIsolated: pickedInfo.notIsolated } : {}),
      ...(pickedInfo.probeOnly === true || this.isProbeLink(picked)
        ? {
            // 链路隔离下，这次注入走的是**另一个账号**：它有自己的连接、自己的
            // 在线状态、自己的一份插件状态（如果下游另起进程的话），所以拿到的结果与群里用户
            // 真发那句话时的结果**可能不同**。这句必须跟着结果回去，别让 agent 把试验当事实。
            probeLink: {
              linkId: picked,
              downstreamId: this.downstreamIdOf(picked),
              downstreamLabel: this.labelOf(picked),
              caveat:
                '这是探针专用链路（另一个账号）：上游真人消息不会投给它，它也可能与真实链路状态不同'
                + '——本次执行结果**可能与用户触发时不同**，不要当成群里真实发生过的对话，也不要据此断言"用户这么发一定会这样"。',
            },
          }
        : {}),
      note: ok ? '事件已注入下游，等待它的 send_msg 回应' : '下游链路发送失败',
    };
  }

  /**
   * 决定这次注入走哪条链路。**路由权在枢纽**（`m02768`）：调用方给的名字一律当作"我要问哪个
   * **下游**"解释（`pickInjectLink`），**不当作物理链路**；只有内部保留的 `linkId` 参数、且
   * 隔离档不是 `link` 时，才允许按链路键直接投递（测试与高级用法用）。
   *
   * 为什么不再"点名就照发"：`onebot_relay_probe` 一次顺手填了 `link` 就把链路隔离绕过去了
   * （真机事故：注入的图直接进了群）——隔离的全部意义是"注入只走那条"，静默绕过等于没隔离。
   */
  #pickInjectLink({ linkId, downstream, allowRealLink } = {}) {
    const named = String(downstream ?? '').trim() || String(linkId ?? '').trim();
    const explicitAllowed = this.probeIsolation !== 'link';
    if (named) {
      // 链路隔离下，调用方给的名字只用来挑"下游"，物理链路仍由 pickInjectLink 决定。
      if (explicitAllowed) {
        const exact = this.#targets.find((target) => target?.id === String(linkId ?? '').trim().replace(/^down:/, ''));
        if (exact) {
          return {
            linkId: `down:${exact.id}`,
            target: exact,
            downstreamId: String(exact.downstreamId ?? exact.id),
            label: this.labelOf(`down:${exact.id}`),
            probeOnly: exact.probeOnly === true,
          };
        }
      }
      const picked = this.pickInjectLink({ downstream: named, allowRealLink: allowRealLink === true });
      return { ...picked, probeOnly: picked.target?.probeOnly === true };
    }
    if (this.probeIsolation === 'link') {
      const probe = this.probeLinkId;
      if (!probe) {
        throw new Error(
          '探针隔离是 link 档，但没有任何探针链路：请在下游目标里填 probeSelfId（另一个账号，'
            + '地址不用改），或者显式给这条目标标 probeOnly；也可以把 probe.isolation 改回 off/time。',
        );
      }
      const target = this.targetOf(String(probe).replace(/^down:/, ''));
      return {
        linkId: probe,
        target,
        downstreamId: this.downstreamIdOf(probe),
        label: this.labelOf(probe),
        probeOnly: true,
      };
    }
    // 没点名也没开链路隔离：只有一条下游时就用它；多条必须点名——投错链路比报错难查得多。
    const usable = this.downstreamLinks.filter((l) => l.enabled !== false && l.linkId && l.linkId !== 'down:');
    if (usable.length === 1) {
      const only = this.targetOf(String(usable[0].linkId).replace(/^down:/, ''));
      return {
        linkId: usable[0].linkId,
        target: only,
        downstreamId: this.downstreamIdOf(usable[0].linkId),
        label: this.labelOf(usable[0].linkId),
        probeOnly: only?.probeOnly === true,
      };
    }
    if (!usable.length) throw new Error('没有可用的下游链路；请先在设置页配 downstreamTargets（或用 onebot_hub_status 看它们的 linkId）。');
    throw new Error(
      `有多个下游，必须用 downstream 点名要问哪个：${this.describeDownstreams()}`
      + `（可用链路：${usable.map((l) => l.linkId).join('、')}）`,
    );
  }

  /**
   * 这条链路是不是"探针专用"（探针链路，且当前**生效**的隔离档是 `link`）。
   *
   * 用途只有一处，但很关键：`probe.capture` 打开时，探针链路的 `send_*` **只捕获不转发上游**
   * ——探针的产物先给 agent 看，要不要发由它决定，而不是直接进群。
   */
  isProbeLink(linkId) {
    if (this.probeIsolation !== 'link') return false;
    const id = String(linkId ?? '').replace(/^down:/, '');
    return this.targetOf(id)?.probeOnly === true;
  }

  /** 直接向上游发一个 action（hub 自己的 bot 身份发言，`onebot_reply` 的实现）。 */
  async callUpstream(action, params = {}, timeoutMs) {
    if (!this.upstream) throw new Error('hub 未配置 upstreamUrl，无法向上游发送');
    if (!this.upstream.isConnected) throw new Error('上游链路未连接');
    return this.upstream.request(action, params, timeoutMs);
  }

  /**
   * 把一条聊天命令的执行结果**用 hub 自己的 bot 身份**发回原会话（②§26）。
   *
   * 两个刻意的选择：
   *  - 回话是纯文本段，不走下游——命令是 owner 和 hub 之间的事，转发给下游只会让
   *    下游 bot 也看见一条它不认识的 `/status`。
   *  - 回话**引用原消息**（有 message_id 时），这样群里能看出是哪条命令的回答，
   *    而不是一条凭空冒出来的话。
   */
  async #answerChatCommand(verdict, event) {
    // `run` 返回 `{ok, reply}`：成功与失败都带一句话（失败不会抛，也不会当普通消息转发）。
    const out = await this.chatCommands.run(verdict, {
      sessionKey: verdict.sessionKey ?? sessionKey(event),
      event,
    });
    const reply = out?.reply;
    if (typeof reply !== 'string' || !reply) {
      this.log(`命令 /${verdict.command} 没有可回的内容`);
      return null;
    }
    const isGroup = event.message_type === 'group' || event.group_id !== undefined;
    const segments = [];
    const quoteId = event.message_id !== undefined && event.message_id !== null ? String(event.message_id) : '';
    if (quoteId && isGroup) segments.push({ type: 'reply', data: { id: quoteId } });
    segments.push({ type: 'text', data: { text: reply } });
    const frame = this.buildMessageFrame({
      message: segments,
      message_type: isGroup ? 'group' : 'private',
      group_id: event.group_id,
      user_id: event.user_id ?? event.sender?.user_id,
    });
    const response = await this.callUpstream(frame.action, frame.params);
    this.log(`命令 /${verdict.command} 已回话（${isGroup ? `group:${event.group_id}` : `private:${event.user_id}`}）`);
    return response;
  }

  // ------------------------------------------------------- 能力面（§22 需求 2）

  /**
   * 启动/重连后的能力探测（§22.1-3）：拿实现端身份，并给三个基础只读接口留下实测结论。
   * 同一条连接只探一次（`status.connects` 作代数）——否则每次心跳重连都打三个请求。
   */
  async probeCapabilities({ timeoutMs } = {}) {
    const cap = this.config.capability ?? {};
    if (cap.probe === false || !this.upstream?.isConnected) return null;
    const connects = this.upstream.status?.connects ?? 0;
    if (this.#probedConnects === connects) return this.capabilities.impl;
    this.#probedConnects = connects;
    const t = timeoutMs ?? cap.probeTimeoutMs ?? 8000;
    const results = {};
    for (const action of ['get_version_info', 'get_login_info', 'get_status']) {
      try {
        const envelope = await this.upstream.request(action, {}, t);
        const ok = envelope?.retcode === 0 || envelope?.status === 'ok';
        this.capabilities.note(action, { ok, retcode: envelope?.retcode, msg: envelope?.msg, source: 'probe' });
        if (ok) {
          this.cache.set(action, {}, envelope.data, ttlOf(action));
          results[action] = envelope.data ?? null;
        }
      } catch (err) {
        this.capabilities.note(action, { ok: false, msg: String(err?.message ?? err), source: 'probe' });
      }
    }
    const version = results.get_version_info ?? {};
    const login = results.get_login_info ?? {};
    const impl = this.capabilities.noteProbe({
      appName: version.app_name,
      appVersion: version.app_version,
      protocolVersion: version.protocol_version,
      selfId: login.user_id,
      nickname: login.nickname,
    });
    /**
     * 身份探测这条路**也要**把结论喂给编排层（`get_login_info` 里有真昵称）：
     * 群友手打 `@真昵称` 能不能叫醒我，取决于 `Mind.#nicknames` 里有没有它。
     * 账号 + 昵称一起给（账号它是"配置优先"的，`learnUpstreamAccount` 自己判）。
     */
    if (login.user_id || login.nickname) {
      this.learnUpstreamAccount(login.user_id, 'probe', login.nickname);
    }
    this.log(
      `能力探测：实现端 ${impl?.app_name ?? '未知'} ${impl?.app_version ?? ''}`.trim() +
        `（协议 ${impl?.protocol_version ?? '?'}，账号 ${impl?.self_id ?? '?'} ${impl?.nickname ?? ''}）`,
    );
    this.#persistCapabilities();
    return impl;
  }

  /**
   * 分级闸门的**只读判定**：说清"这个 action 现在能不能发"，但不发任何字节、不改任何状态。
   *
   * 抽出来是为了让 `onebot_admin` 的预演和 `callAction` 的真判定**用同一处逻辑**——
   * 两边各判一次必然漂移，最后没人知道哪处是权威。
   * @returns {{name: string, tier: string, sensitive: boolean, denied: boolean, reason: string|null, note: string|null}}
   */
  gateDecision(action) {
    const cap = this.config.capability ?? {};
    const name = baseAction(action);
    const tier = tierOf(name);
    const sensitive = isSensitive(name);
    if (tier === 'danger' && !isAllowedAction(cap.dangerAllow, name)) {
      return {
        name,
        tier,
        sensitive,
        denied: true,
        reason: 'danger',
        note: `策略拒绝：${name} 属于 danger 级（默认禁用）。要放行必须在插件配置 capability.dangerAllow 里显式列出它。`,
      };
    }
    if (tier === 'write' && !isAllowedAction(cap.writeAllow, name)) {
      return {
        name,
        tier,
        sensitive,
        denied: true,
        reason: 'write',
        note: `策略拒绝：${name} 属于 write 级（有副作用）。要放行必须在插件配置 capability.writeAllow 里显式列出它。`,
      };
    }
    if (sensitive && cap.exposeSensitive !== true) {
      return {
        name,
        tier,
        sensitive,
        denied: true,
        reason: 'sensitive',
        note: `策略拒绝：${name} 是凭证类只读接口（泄露风险）。要放行需配置 capability.exposeSensitive = true。`,
      };
    }
    return { name, tier, sensitive, denied: false, reason: null, note: null };
  }

  /** 预演：不下发任何请求，只回答"这个 action 现在会不会被策略拦、有没有实测结论"。 */
  previewAction(action) {
    const gate = this.gateDecision(action);
    const known = this.capabilities.get(gate.name);
    return {
      action: gate.name,
      tier: gate.tier,
      sensitive: gate.sensitive,
      allowed: !gate.denied,
      reason: gate.reason,
      note: gate.note,
      known: known?.supported ?? 'unknown',
      cacheable: ttlOf(gate.name) > 0,
    };
  }

  /**
   * 能力面统一入口（§22.5）：**agent 问**与**下游问**共用同一条路径，
   * 所以一次查询惠及两侧——下游问过群成员表，上游断线期间 agent 仍能答（§22.2）。
   *
   * 闸门顺序：分级（danger → write → 敏感只读）→ 缓存 → 上游。
   *
   * 每个分支都在时间线上留一条 `hub-out`（`decision` 分别是 `denied`/`unsupported`/
   * `offline`/`cache`/`call`/`call-failed`），否则"下游问了却没答"在账本上没有痕迹。
   * @returns {Promise<object>} `shapeResult` 形状（§22.5 末），永不抛给调用方。
   */
  async callAction({ action, params = {}, timeoutMs, refresh = false, source = 'agent' } = {}) {
    const cap = this.config.capability ?? {};
    const name = baseAction(action);
    const tier = tierOf(name);
    const sensitive = isSensitive(name);
    const record = (decision, extra = {}) =>
      this.timeline.record({
        direction: 'hub-out',
        linkId: this.upstreamLinkId,
        action: name,
        params,
        decision,
        refs: { capabilitySource: source, ...extra },
      });
    const deny = (note) => {
      this.log(`能力面拒绝（${source}）：${name} —— ${note}`);
      record('denied');
      return { ok: false, status: 'failed', action: name, retcode: 1403, tier, sensitive, data: null, source: 'policy', note };
    };

    const gate = this.gateDecision(name);
    if (gate.denied) return deny(gate.note);

    const ttl = ttlOf(name);
    const cacheOn = cap.cache !== false && tier === 'read' && ttl > 0;
    // 已实测"实现端不支持"就直接回结论（§22.1-3）：别让每次调用都白等一次超时。
    // `refresh: true` 是逃生口——实现端升级后第一次重试必须走真链路。
    const known = this.capabilities.get(name);
    if (!refresh && known?.supported === 'unsupported') {
      record('unsupported');
      return {
        ok: false,
        status: 'failed',
        action: name,
        retcode: known.lastRetcode ?? 100,
        tier,
        sensitive,
        data: null,
        source: 'registry',
        note: `已实测记录"实现端不支持 ${name}"（${new Date(known.lastErrorAt ?? Date.now()).toISOString()}，实现端原文：${known.lastMsg ?? '无'}）。要重试请传 refresh=true。`,
      };
    }
    if (cacheOn && !refresh) {
      const hit = this.cache.get(name, params);
      if (hit) {
        record('cache');
        return shapeResult({
          action: name,
          envelope: { status: 'ok', retcode: 0, data: hit.value },
          source: 'cache',
          ageMs: hit.ageMs,
          tier,
          sensitive,
        });
      }
    }
    if (!this.upstream?.isConnected) {
      const msg = '上游链路未连接';
      this.capabilities.note(name, { ok: false, retcode: 1201, msg, source });
      this.#persistCapabilities();
      record('offline');
      return shapeResult({ action: name, envelope: { status: 'failed', retcode: 1201, msg }, tier, sensitive, source: 'upstream' });
    }

    // `upstream.request` 正常情况返回错误信封，但链路中途断开也可能直接抛 —— 统一收敛成信封。
    let envelope;
    try {
      envelope = await this.upstream.request(name, params, timeoutMs ?? cap.callTimeoutMs ?? 15000);
    } catch (err) {
      envelope = { status: 'failed', retcode: 1200, msg: String(err?.message ?? err), data: null };
    }
    const shaped = shapeResult({ action: name, envelope, source: 'upstream', tier, sensitive });
    this.capabilities.note(name, { ok: shaped.ok, retcode: shaped.retcode, msg: envelope?.msg, source });
    if (shaped.ok && cacheOn && cap.cache !== false) this.cache.set(name, params, shaped.data, ttl);
    if (shaped.ok) this.observeActionResult(name, params, shaped.data);
    this.#persistCapabilities();
    record(shaped.ok ? 'call' : 'call-failed');
    return shaped;
  }

  /** `onebot_caps` 的输出：实测结论 + 缓存与闸门现状。 */
  capabilitiesSnapshot() {
    const cap = this.config.capability ?? {};
    return {
      ...this.capabilities.snapshot(),
      cache: this.cache.stats,
      gates: {
        writeAllow: cap.writeAllow ?? [],
        dangerAllow: cap.dangerAllow ?? [],
        exposeSensitive: cap.exposeSensitive === true,
        cache: cap.cache !== false,
        probe: cap.probe !== false,
        downstreamReads: cap.downstreamReads !== false,
      },
      storage: {
        ...this.storage.stats,
        file: this.storage.path(this.capabilityFile),
        ...this.storageMeta,
      },
      memory: this.profiles?.snapshot() ?? null,
      recall: this.recall?.stats ?? null,
      reminders: this.reminders?.stats ?? null,
      media: this.media?.stats ?? null,
      turns: this.turns?.snapshot ?? null,
      learn: this.learn?.snapshot ?? null,
      cards: this.cards?.stats ?? null,
      members: this.members?.snapshot?.() ?? null,
      vision: this.vision?.stats ?? null,
      // §26 的"活状态"：人设是每会话解析的，所以这里给的是**预设库**而不是某一会话的角色。
      persona: this.persona?.stats ?? null,
      memes: this.memes?.stats ?? null,
      anime: this.anime?.stats ?? null,
      imageGen: this.imageGen?.stats ?? null,
      chatCommands: this.chatCommands?.stats ?? null,
    };
  }

  /** 构造一条群/私聊消息帧（hub 自己发言时用）。 */
  buildMessageFrame({ message, message_type, group_id, user_id, auto_escape = false }) {
    const params = { message, auto_escape };
    if (message_type === 'group') {
      params.message_type = 'group';
      params.group_id = group_id;
    } else {
      params.message_type = 'private';
      params.user_id = user_id;
    }
    return { action: 'send_msg', params };
  }

  // ---------------------------------------------------------------- 观测/工具用

  status() {
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      policy: this.policyDescription,
      upstream: this.upstream ? this.upstream.status : null,
      // 上游账号对下游有实际后果（"不写对方账号 = 与上游相同"），所以状态里要说清它从哪来：
      // `configured` 是配置写的，`learned` 是观测到的（握手头/事件/get_login_info）。
      upstreamAccount: {
        selfId: this.upstreamAccount || null,
        source: String(this.config.upstreamSelfId ?? '').trim() ? 'configured' : this.#upstreamAccount ? 'learned' : 'unknown',
      },
      downstream: this.downstreamLinks,
      // 探针隔离现状（M7-④）：当前档位、探针链路、活跃窗口（还压着几条）与累计计数。
      probe: this.probeSnapshot,
      timeline: this.timeline.stats,
      capture: this.capture.stats,
      // 原始报文缓存与保留期（`m03065` / `m03091`）：收到的每条消息都留原文与索引，
      // 超期的按 `retention.days` 自动清。
      raw: {
        ...(this.recall?.stats ?? {}),
        payloadCached: true,
        retentionDays: Number(this.config.retention?.days ?? 0),
        lastPrune: this.#retentionStats,
      },
      guard: this.guard.stats,
      capability: this.capabilitiesSnapshot(),
    };
  }
}
