/**
 * 插件配置的 schema（`Config` 的形状）。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），键名、默认值、说明文字逐字未改——
 * 改这里会直接改设置页与 `resolveConfig` 的行为，`test/contract.mjs` 会比对顶层键。
 */

import { readField } from '../parse.js';
import { quotaOfEntry } from '../quota.js';

export { buildConfigSpec, markEditable };
export const secretField = (field) => (typeof field?.role === 'function' ? field.role('secret') : field);

// 配置表：只有 schemastery 可用时才构造 schema（否则 Config 为 undefined，
// 由 resolveConfig() 的默认值兜底，插件照样能加载）。
const buildConfigSpec = (z) => ({
  enabled: z.boolean().default(true),
  /**
   * 上游怎么连（`m71864` 用户定案：一个下拉选类型、一个下拉选方式、一个地址框）。
   *
   * 以前是 `upstreamUrl` / `upstreamListen` 两个框，靠"填哪个"来表达方向——于是两个都填时
   * 反向静默胜出、正向那句被丢掉，而没有任何地方会告诉你这件事。
   */
  upstreamMode: z.string().default(''),
  upstreamAddress: z.string().default(''),
  // 旧键：保留可读（删了老配置会读不出来），但设置页不再渲染；由 resolveConfig 按需推导。
  upstreamUrl: z.string().default(''),
  upstreamSelfId: z.string().default(''),
  upstreamNickname: z.string().default(''),
  // 这两项**刻意不给默认值**（用户要求）：没配过就是"没有这一项"，清空就是清空。
  // 少一个 `.default('')`/`.default('[]')`，resolved 配置里就没有这个键——设置页靠
  // `lib/client.js` 的 ALWAYS_FIELDS 补出空行，运行时由 resolveConfig 兜底。
  upstreamListen: z.string(),
  upstreamAccessToken: secretField(z.string().default('')),
  /**
   * 上游换一条路：`onebot`（默认，OneBot v11 实现端）或 `official`（QQ 官方机器人开放平台）。
   *
   * 一个下拉就够，不再给官方通道单独一个开关（`m34751`）：开关和"填了凭据"曾经是两个
   * 独立状态，扫码绑定只写后者，于是"绑定成功"仍然判定成关闭、官方那一路一次都没连。
   * 上游只有一条，用"选哪一种"表达比"官方开/关"少一个能自相矛盾的状态。
   *
   * 空串 = 没选过（`resolveConfig` 里按老配置的 `official.enabled` 兜底，见那边注释）。
   */
  upstreamType: z.string().default(''),
  /**
   * 官方通道的凭据。选 `upstreamType: official` 之后才用得上；
   * `appId`/`appSecret` 也由设置页的扫码直接填进插件状态，这里留空不算错。
   */
  official: z.object({
    appId: z.string().default(''),
    appSecret: secretField(z.string().default('')),
    sandbox: z.boolean().default(false),
    /**
     * 官方模式下「活跃记忆跨群共享」（`m35008` 用户定案：**默认不共享，留开关**）。
     *
     * 官方上游下会话白名单不生效（`m34897`），于是"哪些群之间能共享活跃条目"这个问题
     * 没有答案了。默认选保守的那头：只在同群可见。想放开再打开这个开关。
     */
    crossShare: z.boolean().default(false),
    /**
     * 订阅位（实验用）：0 = 用内置的「群与私聊」那一位。
     *
     * 为什么留这个口子：官方开了"接收全部群消息"之后事件名与所需权限都可能有变化，
     * 而猜权限位没法靠文档确认。留一个可以直接填数字、重启即生效的开关，
     * 比来回发版本快。
     */
    intents: z.number().default(0),
  }),
  downstreamAccessToken: secretField(z.string().default('')),
  downstreamTargets: z.string(),
  preset: z.string().default('relay'),
  deliveryMode: z.string().default('transparent'),
  broadcast: z.boolean().default(true),
  /**
   * 只读（§19）：打开后 **hub 自己绝不动作**——不唤醒 agent（不花 token）、不代答聊天命令；
   * 事件该广播还是广播（"观察"要看得见，"不动手"指 hub 的手）。`shadow` 预设自带打开，
   * 这里打开则是"任何预设都能全量观察"。只能打开，关不掉预设自带的那份。
   */
  readonly: z.boolean().default(false),
  deliverMessageSent: z.boolean().default(false),
  virtualizeMessageId: z.boolean().default(false),
  reconnectInterval: z.number().default(5000),
  requestTimeout: z.number().default(30000),
  heartbeatTimeout: z.number().default(120000),
  downstreamHeartbeatMs: z.number().default(30000),
  echoWindowMs: z.number().default(3000),
  maxHop: z.number().default(3),
  /**
   * 探针隔离（M7-④）：agent 用 `onebot_invoke` 试探下游时，怎么把它和真人消息隔开。
   *
   * 为什么需要：注入的事件**会真的触发下游 matcher**，它的回复也真的会进群。探测窗口里
   * 刚好有群友说话、下游同时回了，事后就分不清哪条回复是谁引起的。
   *
   *   · `off`（默认）——不隔离：注入与真人消息走同一条链路（旧行为）。
   *   · `time`——探测窗口内该会话的上游消息**暂缓**投下游，窗口一到按原序补发。群友的话
   *     不会丢，只是晚几秒到；注入引发的回复独占窗口。**不需要额外配置**。
   *   · `link`——上游消息一条都不投给探针链路，注入只走那条，归属由"从哪条链路回来的"决定。
   *     探针链路由下游目标里的 `probeSelfId` 展开（**同一个下游、另一个 bot 账号，地址不用改**）；
   *     一个都没配时**回退到 `off`**（假装隔离比明说不隔离更危险）。探针链路的结果与用户
   *     真发那句话时**可能不同**，这一点会写进给 agent 的指导段与每次注入的结果里。
   */
  probe: z
    .object({
      isolation: z.string().default('off'),
      windowMs: z.number().default(8000),
      maxQueued: z.number().default(50),
      capture: z.boolean().default(true),
    })
    .default({}),
  /**
   * 原始报文与媒体的**保留期**（`m03091` 用户要求"缓存超过一定天数自动清理即可"）。
   *
   * 收到的每条消息都会缓存原文 + 索引（`m03065`：包括 hub 解析不了的段、以及**不展开**的聊天记录），
   * 但缓存不该无限长：超过 `days` 天就把落盘的原始报文日文件、索引里的旧行、以及媒体 blob 一起清掉。
   * `days: 0` = 不清理（想自己管就关掉）。启动时跑一次，之后每 `cleanupIntervalMs` 一次。
   */
  retention: z
    .object({
      days: z.number().default(7),
      cleanupIntervalMs: z.number().default(6 * 3600 * 1000),
      // 启动后隔多久跑第一次清理（`m21653`）：清理是 O(数据量) 的 IO，以前同步跑在
      // 启动路径上，于是"库存越久、启动越慢"。挪到启动之后再跑，晚 20 秒完全无所谓。
      firstRunDelayMs: z.number().default(20000),
    })
    .default({}),
  actionPolicy: z.string().default('{}'),
  logFrames: z.boolean().default(false),
  persist: z.boolean().default(true),
  storageDir: z.string().default(''),
  agent: z
    .object({
      mode: z.string().default('assist'),
      batchSize: z.number().default(10),
      batchMs: z.number().default(20000),
      maxActive: z.number().default(8),
      idleDisposeMs: z.number().default(1800000),
      tickMs: z.number().default(1000),
      silenceWhenDownstreamResponded: z.boolean().default(true),
      wakeOnPrivate: z.boolean().default(true),
      wakeOnNotice: z.boolean().default(false),
      speakAssistantText: z.boolean().default(false),
      // 激活状态的空转上限：这么久没有新消息就回休眠（0 = 不超时）。
      awakeMs: z.number().default(300000),
      // `active` 档在休眠时的判断间隔：每隔这么久看一眼"该会话有没有新消息"。
      activeTickMs: z.number().default(300000),
      // 云部署/无人值守时碰到"需要人点一下"的动作怎么办（`m84407`）：
      // deny = 直接拒绝并告诉模型（默认）；auto = 取第一个选项并说明；ask = 老行为，挂着等人。
      unattended: z.string().default('deny'),
      guidance: z.string().default(''),
      // hub 配置的默认聊天模型（m024167）：`provider/model`（或只给 model）。
      // 留空 = 跟 DSH 系统默认路由；配了就**以 hub 配置为准**，`/model default` 复位也回到它。
      defaultModel: z.string().default(''),
      // hub 配置的默认识图模型（同上）：留空 = 系统默认模型；会话里的 `/vmodel` 仍然覆盖它。
      defaultVisionModel: z.string().default(''),
      // 思考强度（m024193）：`defaultModel` 那个模型的 reasoning effort 档位。
      // 留空 = 交给模型自己默认。设置页从 DSH 模型清单里读 efforts 出下拉，
      // 没声明 reasoning 的模型压根不列（手填也不该被允许——上游会拒）。
      defaultReasoningEffort: z.string().default(''),
      // hub 自带精简预设（m04972 用户定案）：hub 建的会话**默认**进它，不用用户在 profile 里
      // 手动定义；agent 要大件工具（subagent/workflow/goal…）时用 onebot_tools 的 preset 参数
      // 整档切到 DSH 默认预设（本回合结束立刻重开生效），切换后**整段会话保持全量工具面**：
      // 中途再发多少条消息都不切回，等它回到休眠之后的下一次激活才建回精简（m12945 定案）。
      // 预设工具是作用域注册，遮罩管不到——开关大件只能换预设。
      // 识图那边的思考强度（同上，跟 `defaultVisionModel` 配对）。
      defaultVisionReasoningEffort: z.string().default(''),
      // 会话白名单（m31030）：JSON 数组字符串 `[{"id":"123456789","mode":"assist"}]`。
      // `groups` 的 id=群号、`privates` 的 id=QQ号；没列出的会话**不喂模型**（@ 也不理）。
      // mode 可省（= 跟全局 agent.mode），合法值 observer/assist/active；批量参数全局统一。
      // 两张名单都留着不写 = 全部静音；设置页有行编辑器（群号/QQ号 + 模式下拉）。
      groups: z.string().default('[]'),
      privates: z.string().default('[]'),
      // 激活期插话（m31311）：回合在飞时新到的消息不再排队等下一轮，直接 steer 进正在跑的
      // 回合（宿主 next-step 原语，下一步边界送达、同一回合继续）。默认开；关掉回到旧行为。
      steer: z.boolean().default(true),
      /**
       * 定时任务（`m35589` 定案）：工具 `onebot_task`，宿主管时钟、hub 记"叫醒谁"。
       * `resetEvery` = 总机会话累计触发多少次后换一条新会话（`0` 不换）。总机会话不能回收
       * （宿主的排期绑着它的 sessionId），所以它的上下文只涨不清；这个旋钮是唯一的清理手段。
       */
      tasks: z
        .object({
          enabled: z.boolean().default(true),
          resetEvery: z.number().default(0),
        })
        .default({ enabled: true, resetEvery: 0 }),
      // 一次 `onebot_reply` 可以发多条消息（m32420）：拆条照 aigf-master（图片各自一条、
      // 文字/@ 各聚一条，`break` 或空行强制断开）。下面三个键是发送节奏与防刷屏。
      replyGapMs: z.number().default(400),
      // 文字条数上限（**图不占额度**，用户 m32420 定案）。
      replyMaxText: z.number().default(3),
      replyMaxImages: z.number().default(9),
      // 会话归属（issue #1，用户 m22855 定案）：**默认什么都不改**——每次激活一个新会话、
      // 结束即归档、不挂进任何工作区（所以 DSH Web 的会话列表里它们都在「未分类」）。
      // 下面两个键是"想改的人自己开"的出口：
      //  - `workspace`：绝对路径。留空 = 用宿主进程的 cwd 且不 attach（现状）；
      //    填了就**用它当 cwd**，并在建完会话后把这个 id 挂进该路径对应的已登记工作区。
      //  - `archiveOnRetire`：默认 true（结束后归档，会话从活跃列表挪走）。关掉它，
      //    会话就留在会话列表里——代价是**每次激活都会多留一条**（id 每次激活都换）。
      workspace: z.string().default(''),
      archiveOnRetire: z.boolean().default(true),
      // 遮蔽别的插件塞进提示词的段落（`m72820`）：逗号分隔的段落名，默认空（不遮蔽）。
      // 宿主把提示词分成「全局层 + agent 层」，**同名时 agent 层盖掉全局层**
      // （`ScopedLayers.merge` 用 `set` 覆盖，宿主注释原话是 "shadows its deployment default
      // instead of appearing beside it"），所以列在里面的名字，枢纽会话里那一段会变成空文本，
      // 而别的会话不受影响。名字是对方插件自己起的（比如 `raw-html-v2:vcp`），它改了名这里就
      // 会静默失效——所以默认一个都不遮蔽，要谁消失自己把名字填进来。
      hidePromptSections: z.string().default(''),
      // 默认放行的全局工具（`m73105`）：逗号分隔的工具名，默认空——白名单保持原样。
      // 枢纽会话的全局工具面是"白名单式"的：`defaultToolDeny` 把全局视图里除 11 个原生工具、
      // `onebot_*`、插件生图/语音工具之外的全部遮掉。这项把额外名字并进那个白名单。
      // 两个前提：写错的名字**静默丢掉**（宿主 `restrict()` 对未知名字当场抛错，不能让整轮炸）；
      // 放行不等于能用——它依赖的 provider 服务得在 profile 里，否则有名字也挂不上。
      keepTools: z.string().default(''),
      // 发送失败当场回执（用户 m25376 定案）：失败常常是本轮最后一件事，等"下一批"可能永远
      // 等不到（群里没人再说话），模型会一直以为自己说出口了。默认开——失败后立刻排一次裸唤醒，
      // 把"第几条没发出去"递回去。下面两个键是刹车：同一会话在一个窗口里最多自动重开这么多次，
      // 撞上限就退回老行为（下一批开头告知），防止"重试→又失败→又收到回执"自我转圈。
      replyOnSendFailure: z.boolean().default(true),
      sendFailureNudgeMax: z.number().default(2),
      sendFailureNudgeWindowMs: z.number().default(300000),
      // 分群额度（m13404 起，m14190 定案位置）：**没有全局额度块**——口径（按 token 还是按钱）、
      // 单价、限额、报数口径都写在 `groups`/`privates` 白名单每一行的 `quota` 里，
      // 那个群自己算自己的账（`quotaOfEntry` 归一，未勾"启用"＝不限）。
    })
    .default({}),
  capability: z
    .object({
      writeAllow: z.string().default('[]'),
      dangerAllow: z.string().default('[]'),
      exposeSensitive: z.boolean().default(false),
      cache: z.boolean().default(true),
      probe: z.boolean().default(true),
      downstreamReads: z.boolean().default(true),
      callTimeoutMs: z.number().default(15000),
      probeTimeoutMs: z.number().default(8000),
    })
    .default({}),
  media: z
    .object({
      enabled: z.boolean().default(true),
      keepBytes: z.boolean().default(true),
      transcribe: z.boolean().default(true),
      // 非图片媒体的单文件上限：超了只记元信息。图片不受此限（m04935：上限会变相识图上限），
      // 大图总会落 blob，看图前按需压小；只是不登记宿主附件（防巨图进模型主请求）。
      maxBytes: z.number().default(8 * 1024 * 1024),
      fetchTimeoutMs: z.number().default(5000),
    })
    .default({}),
  /**
   * 会话间转达（`m25983` 需求，`m26026` 定稿）：让一个会话里的 agent 把值得搬的东西
   * 递给另一个会话的 agent，由**那边**决定发不发。
   *
   * **默认关**：它会打通"一个群里的东西出现在另一个群"这条路，属于必须由人显式打开的能力。
   */
  cross: z
    .object({
      enabled: z.boolean().default(false),
      /** 谁能发起：`hub`＝只有枢纽自己拉起的会话（默认）；`all`＝任何会话都能调这个全局工具。 */
      allowFrom: z.string().default('hub'),
      /** 目标白名单（JSON 数组）。空＝枢纽的全部会话都能当目标。 */
      allowTo: z.string().default('[]'),
      /**
       * 私聊里取到的**原文**能不能原封搬到别的会话（`m26268` 起只管原文，`m26439` 起管所有目标：
       * 群和私聊一样）。转述由 `text` 走，过隐私词表。
       */
      allowPrivateRefs: z.boolean().default(false),
      relayMaxPerWindow: z.number().default(3),
      windowMs: z.number().default(300000),
      packageTtlMs: z.number().default(1800000),
      maxBytes: z.number().default(300 * 1024),
      /** 一条会话间通道最长活多久（`m26268`）。 */
      channelTtlMs: z.number().default(1800000),
      /** 多久没人说话就把通道冷掉。 */
      channelSilentMs: z.number().default(600000),
      /** 每方最多说几句——防两个会话互相客气到天亮。 */
      channelMaxPerSide: z.number().default(6),
      // 递送最多等目标那一轮多久（`m36748`）：两个会话互相递话时，等整轮会死锁。
      wakeGraceMs: z.number().default(1200),
      peerListLimit: z.number().default(10),
      /**
       * 会话目录（`m32112`）：cross 开着时，把"这个插件接了哪些群和私聊"列进提示词，
       * 模型才谈得上主动串门。`off` 不列；`names` 只给群号和人数；`full` 再加一句印象。
       */
      directory: z.string().default('names'),
      /** 目录最多列几行（默认 30，0＝不列）。按"最近有人说话"排序。 */
      rosterLimit: z.number().default(30),
    })
    .default({}),
  /** 回合配对（§16.4 M6）：机械配对不需要开关，只有窗口与保留条数可调。 */
  turns: z
    .object({
      windowMs: z.number().default(8000),
      retain: z.number().default(400),
    })
    .default({}),
  /** 用法学习（§17 M7）：观测几次算数、多久没复现算过时、多久才真删。 */
  learn: z
    .object({
      threshold: z.number().default(3),
      staleAfter: z.number().default(3),
      forgetAfter: z.number().default(6),
      maxEvidence: z.number().default(20),
    })
    .default({}),
  /**
   * 下游 bot 的源码范围（M7-③，`m14112` / `m14477`）：**只告诉 agent 在哪，不给它工具**。
   * 可以有多条（可能有多个下游）：`[{"name":"下游A","path":"D:/somewhere"}]`，`name` 是备注、
   * `path` 是目录或文件。**位置不写进 prompt**——agent 需要时调 `onebot_code_scopes` 取，
   * 读文件用它自己的 read/grep/glob。存成 JSON 字符串（同 `downstreamTargets`：
   * 设置页用行编辑器拼/拆它，profile 里就是一个字符串），也认一行一个路径的老写法。
   */
  code: z
    .object({
      scopes: z.string().default('[]'),
    })
    .default({}),
  /** L2 会话卡落盘（§24.10）：重启之后还记得刚才在聊什么。 */
  cards: z
    .object({
      maxLines: z.number().default(40),
      maxSessions: z.number().default(200),
    })
    .default({}),
  /**
   * 成员名解析（§23.6）：`at` 到还没名字的人时按需问一次实现端。
   * 默认开着（问一次比一直叫"用户10002"强），但带冷却与限流。
   */
  members: z
    .object({
      enabled: z.boolean().default(true),
      cooldownMs: z.number().default(6 * 60 * 60 * 1000),
      maxPerMessage: z.number().default(5),
      maxQueue: z.number().default(50),
    })
    .default({}),
  /**
   * 看图（M14-V，§23.6）：上游发的图片有两种处理手段，`mode` 选：
   *   · `segment` —— 图片本体作为内容段交给会话代理（要求模型能收图，否则自动跳过）；
   *   · `describe` —— 自己向视觉模型要一段中文描述，写进 L1 文本（任何模型都读得到），按 sha256 缓存；
   *   · `both` / `off`。
   * 识图默认模型在 `agent.defaultVisionModel`（m024167）：留空 = 系统默认模型，会话里 `/vmodel` 仍然覆盖它。
   */
  vision: z
    .object({
      mode: z.string().default('describe'),
      prompt: z.string().default(''),
      system: z.string().default(''),
      maxTokens: z.number().default(0),
      timeoutMs: z.number().default(30000),
      cacheLimit: z.number().default(500),
      // 回合开始前最多等识图多久（`m24484`）：图片消息进窗口时只有「还在看」，
      // 不等就会出现"图刚发、模型立刻说我看不到"。0＝不等（回到老行为）。
      waitBeforeTurnMs: z.number().default(4000),
      // `segment` 模式等的是**图片落地**（下载 + 回填 `entry.media`），不是描述（`m37401`）。
      // 只开 segment 时这条路以前根本没有等待对象，快照总拍在"图还没落地"的那一刻。
      segmentWaitMs: z.number().default(1500),
    })
    .default({}),
  /**
   * 人设（①§26）：预设库 + **按会话绑定**。
   *
   * 和 master 那版最大的区别就在这里：那边的预设选择**不落盘**，一重启所有群都回默认；
   * 这里 `bindings.json` 把"哪个会话用哪个预设"写进 storage，重启后各群还是各自的角色。
   *
   * **预设库与默认人设不再走配置项**（`m24027`）：以前有 `defaultName` 与 `presets` 两个键，
   * 但它们只在**第一次启动**有意义，之后一概被 `persona/presets.json` 覆盖；更糟的是
   * `presets` 那个种子是**每次启动重写一遍**的，于是设置页里改过的同名预设会在重启后被打回去。
   * 两个来源互相打架，删掉配置这一头。改人设只剩一条路：设置页「人设与预设」那块面板
   * （或群里的 `/set_preset`、`/set_role`）。
   */
  persona: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  /**
   * 聊天管理命令（②§26）：`/status` `/presets` `/set_role` … 走**超管闸门**。
   *
   * `superUsers` 是唯一权威名单（空数组 = 整条链沉默）。前缀 + 名字命中时，枢纽**自己回一条**，
   * 但**不吞消息**：原消息照常投下游（下游有同名命令也照常触发，撞车就是两个都触发），
   * 也照常记时间线；只有"喂给模型"这一步被跳过——回话已经用同一个账号发过了。
   * `bypassPrefix`（默认 `!!`）是"连枢纽自己那条回话都不要"：`!!/reset` 当普通消息走。
   */
  chatCommands: z
    .object({
      enabled: z.boolean().default(true),
      prefix: z.string().default('/'),
      bypassPrefix: z.string().default('!!'),
      superUsers: z.string().default('[]'),
      maxReplyChars: z.number().default(1500),
    })
    .default({}),
  /**
   * 表情包库（④§26）：**由 agent 决定收不收**（方案 v2）——不再自动收集。
   * `autoCollect` 是总闸：关掉后连 agent 也不许收录（工具 add 直接拒绝）。
   */
  memes: z
    .object({
      enabled: z.boolean().default(true),
      topK: z.number().default(50),
      // 新入库的表情包在提示词清单里额外列几个（`m73189`，默认 10）。
      // 清单原来只按"用得多的"排，新收的（uses=0）永远排在后面；库一满 topK 它就一次都进不了
      // 清单，模型想不起来用，收藏变成只进不出。这一块单独排在最后，标题里也点名。
      newShown: z.number().default(10),
      maxSend: z.number().default(3),
      // 库容量上限（用户 2026-10-11 定）：超了自动淘汰，逻辑参考 aigf-master（少用且旧的先走）。
      maxCount: z.number().default(200),
      autoCollect: z.boolean().default(true),
      // 表情包来源（`m73315`）：builtin 用枢纽自带的库；plugin 整个交给第三方插件
      // （自带库下线：清单不注入、onebot_memes 不注册、reply 的 memes 参数不可用）；both 两套并存。
      engine: z.string().default('builtin'),
      // plugin/both 下要放行的第三方表情工具名，逗号分隔；留空则按关键词从实时工具表里探测。
      pluginTool: z.string().default(''),
    })
    .default({}),
  /**
   * 二次元识别（⑥§26）：可选后端，`off` 时不发任何请求（离线部署也不会变慢）。
   * 识别结果只是**挂在图片描述后面的一行**，认不出来就说认不出来，不猜角色名。
   */
  anime: z
    .object({
      backend: z.string().default('off'),
      recognizeUrl: z.string().default(''),
      recognizeToken: secretField(z.string().default('')),
      animetraceUrl: z.string().default('https://api.animetrace.com'),
      minConfidence: z.number().default(0.85),
      maxCharacters: z.number().default(1),
      nsfwThreshold: z.number().default(0.5),
      timeoutMs: z.number().default(15000),
      cacheLimit: z.number().default(500),
    })
    .default({}),
  /**
   * 生图（⑦§26）：**默认关闭**。开了就要配 `baseUrl`/`apiKey`，否则 `enabled` 仍是 false。
   * 生成的图走正常图片通道落地（可被引用、可被再次描述），不是凭空贴一个 URL。
   */
  imageGen: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default(''),
      baseUrl: z.string().default(''),
      apiKey: secretField(z.string().default('')),
      maxSize: z.string().default('2560x1440'),
      minSize: z.string().default(''),
      watermark: z.boolean().default(false),
      timeoutMs: z.number().default(120000),
      maxPerTurn: z.number().default(1),
      /**
       * engine（用户 2026-10-11 定）：`builtin`＝hub 自带的 OpenAI 兼容生图（老行为）；
       * `plugin`＝hub 不自己生图，把第三方插件的生图工具（dsh-image-gen 等）放进 agent
       * 工具面，agent 自己调、自己决定发不发群；hub 只负责在结果里把图落地成
       * hub-media 引用并补一段图片描述（tools/post-execute 瀑布）。
       */
      engine: z.string().default('builtin'),
      /** delivery：生成后 `agent`＝由 agent 决定发不发（默认）；`direct`＝生成完立刻直发（老行为）。 */
      delivery: z.string().default('agent'),
      plugin: z
        .object({
          /** 第三方生图工具名（字符串或逗号分隔/数组）；留空＝自动探测。 */
          tool: z.string().default(''),
          timeoutMs: z.number().default(180000),
        })
        .default({}),
    })
    .default({}),
  /**
   * 语音合成（TTS，`m29000`）：**默认关闭**。开了要配 `baseUrl`/`apiKey`，缺一个仍然是关。
   *
   * 接口形状是 OpenAI 的 `POST /audio/speech`——但"OpenAI 兼容"这一层早就不止官方：
   * GPT-SoVITS、CosyVoice、IndexTTS、Fish Speech 这些都给同形状的接口，音色是**各自注册的
   * 名字或 id**。所以 `voice` 不做枚举校验（写错是上游回 400，那句话会原样进回执）。
   *
   * 参考音频（零样本克隆）没有统一参数面，`refAudioField`/`refTextField` 就是为此留的：
   * 谁家的字段名叫什么，配一次即可；留空 = 这个字段根本不发（官方严格实现收到未知字段会报错）。
   */
  tts: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * 选一家（`m29544`）：地址/形状/模型**整套取它那一套**，下面三项只在 `custom` 下生效
       * （`m29830`——设置页在选了服务商之后会把那三格藏起来，代码也就不能再听它们的旧值）。
       * `custom` ＝ 全自己填；`plugin` ＝ 枢纽不合成，交给第三方插件的工具（`m29571`）。
       */
      provider: z.string().default('custom'),
      /** 第三方插件的语音工具名（逗号分隔）；留空则按已知名单 + 名字里带 tts/voice 自动探测。 */
      plugin: z
        .object({
          tool: z.string().default(''),
        })
        .default({}),
      /**
       * **完整**接口地址——不自动拼 `/audio/speech`（`m29304`）。
       *
       * 小米 MiMo 这类把 TTS 挂在 `chat/completions` 上，路径与请求体都不一样；写死一条路径
       * 等于只服务 OpenAI 那一套，真机只会拿到 404。**仅 `provider=custom` 时生效。**
       */
      url: z.string().default(''),
      /** `speech` = `input`/`voice`/`response_format`；`chat` = 塞进 `messages` 的 `assistant`。仅 `provider=custom` 时生效。 */
      shape: z.string().default('speech'),
      apiKey: secretField(z.string().default('')),
      /** 豆包语音的 appid（`app.appid`）；只有 `doubao` 形状要它，缺了直接判"没配全"。 */
      appId: z.string().default(''),
      /** 豆包语音的 cluster，留空按 `volcano_tts`（只有 `doubao` 形状用）。 */
      cluster: z.string().default(''),
      /** MiniMax 的 GroupId：老账号必须拼在地址后面（`?GroupId=`），留空就不拼。 */
      groupId: z.string().default(''),
      /** 方舟 Agent Plan 的 `X-Api-Resource-Id`；留空按预设（`seed-tts-2.0`）。只有 `ark` 形状用。 */
      resourceId: z.string().default(''),
      /** 模型名。**没有默认值**：各家叫法不同，填了才进请求体；仅 `provider=custom` 时生效。 */
      model: z.string().default(''),
      /** 音色名或 id。**没有默认值**：填了才进请求体（`chat` 形状里作 `voice` 发）。 */
      voice: z.string().default(''),
      /** `mp3|opus|aac|flac|wav|pcm`；认不出的按 mp3 处理并如实说明。 */
      format: z.string().default('mp3'),
      /** 语速倍率，1 = 原速；只在 ≠1 时才往请求体里带。 */
      speed: z.number().default(1),
      /** 风格/音色提示；`speech` 里叫 `instructions`，`chat` 里作一条 `system` 消息；空 = 不发。 */
      instructions: z.string().default(''),
      /** 参考音频：URL / 本地路径 / `base64://…` / `data:…` 都认；空 = 不做克隆。 */
      refAudio: z.string().default(''),
      /** 参考音频对应的文本（多数克隆接口要求同时给）。 */
      refText: z.string().default(''),
      /** 参考音频的请求体字段名；留空 = 不发（官方不认这个字段）。 */
      refAudioField: z.string().default('ref_audio'),
      /** 参考文本的字段名；留空 = 不发。 */
      refTextField: z.string().default('ref_text'),
      timeoutMs: z.number().default(30000),
      /** 单次最多多少字（官方 input 上限 4096，这里给个更保守的默认）。 */
      maxChars: z.number().default(1000),
      /** 磁盘缓存条目上限（同一句话同一音色不重复花钱）；0 = 不缓存。 */
      cacheLimit: z.number().default(200),
    })
    .default({}),
  memory: z
    .object({
      limit: z.number().default(5000),
      /** 【本群认识的人】最多列几个人（按最近露面排序，`0`＝整段不注入）。 */
      peopleRoster: z.number().default(20),
      /**
       * 【这次说话的人】（`m03031` 用户定）：这一批里说过话的人，一次最多给几张精简卡。
       * 只有一个人说话时不受它管——那种情形照旧给完整人物卡。`0` = 回到"只给当前说话人"。
       */
      personCards: z.number().default(5),
      /** 每张精简卡最多列几条事实（超出在行尾标「还有 N 条没列出」）。 */
      personFactsShown: z.number().default(3),
      reminders: z
        .object({
          enabled: z.boolean().default(true),
          windowHours: z.number().default(24),
          limit: z.number().default(5),
          max: z.number().default(200),
        })
        .default({}),
      isolation: z
        .object({
          // `m18072` 用户定案：默认档位从 `scoped` 改为 `balanced`——活跃层要能开箱共享，
          // 而活跃层跟随全局档位（不另设旋钮）。代价是长期事实的跨群放行也一起放松，
          // 所以设置页与发版说明都要写清"想更严就改回 scoped"。
          level: z.string().default('balanced'),
          crossGroupIdentity: z.boolean().default(true),
          crossGroupFacts: z.string().default('shareable'),
          privateFacts: z.string().default('sameActor'),
          sensitivityAlwaysLocal: z.boolean().default(true),
          overrides: z.string().default('[]'),
          trustedGroups: z.string().default('[]'),
          /** 白名单私聊（`m28349`）：这些人私聊时可读任何会话；其余私聊只能读自己那条。 */
          trustedPrivates: z.string().default('[]'),
          recallEscape: z.boolean().default(false),
          recallEscapeNeedsApproval: z.boolean().default(true),
          audit: z.boolean().default(true),
          auditRetain: z.number().default(200),
        })
        .default({}),
      /**
       * 活跃层（`m17909`）：短期记忆的职能改成"记录进行中的话题 + agent 正在做的事"。
       * 没有 `shareLevel`——共享尺度跟 `isolation.level` 走，不另开一个容易配歪的旋钮。
       */
      active: z
        .object({
          enabled: z.boolean().default(true),
          /** 多久没动过的条目就不进上下文了（`0`＝不过滤，会留僵尸）。 */
          activeWindowDays: z.number().default(30),
          /** 一次最多注入几条（按种类分组、组内新的在前）。 */
          injectLimit: z.number().default(8),
          /** 每个来源会话最多存几条（超了淘汰最旧的；只防跑偏，不代替结算）。 */
          maxPerOrigin: z.number().default(20),
          /** 「待结算」那行提醒：每天最多一次。 */
          dailySettleReminder: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
});

/**
 * 把 schema 树里**每个叶子字段**标成 `volatile` —— 这就是"设置页可编辑"的开关。
 *
 * 宿主的 `@deepseek-ai/dsh-settings` 用 `volatileForm()` 投影表单，它**只**认这个标记：
 * 没有 volatile 的字段在设置页里根本不存在。写入经当前 profile 的 Cordis patch 落盘、
 * 由 Loader 重载本插件——所以设置页改 `upstreamListen` 之类是即时生效的，
 * 不需要用户手改 `cordis.patch.yml`。
 *
 * 为什么标在**叶子**而不是整棵树上（**别改成根节点 volatile**）：
 *  schemastery 的 volatile 不只写元数据，它同时改变**取值**语义（该字段被解析成带 `.get()`
 *  的稳定引用）。根节点标了它，`Schema.resolve` 会把整个配置包成一个 `Volatile`，Loader 交给
 *  `apply(ctx, rawConfig)` 的就不再是普通对象——`resolveConfig()` 一个字段都读不到，
 *  全部悄悄退回默认值。叶子标法不改变对象形状，而 `readField()` 本来就会解包 `.get()`。
 *  另外 `vendor\schemastery` 的 `validateVolatileSchema` 明确禁止 volatile 被另一个 volatile
 *  包住（`volatile fields require a fixed object path without an enclosing volatile field`）。
 *
 * 口径：**这个插件声明的每一个配置项都能在设置页里改**（用户要求"所有配置项都做个 UI"）。
 * 唯一的例外是凭据字段，它们额外标了 `role('secret')`——设置页只会告诉你"设过没设过"，
 * 不会把 token 明文回显到浏览器。
 */
function markEditable(schema) {
  const walk = (node) => {
    // schemastery 的 schema 节点是**可调用对象**（`typeof node === 'function'`），
    // 所以这里不能用 `typeof node !== 'object'` 当"不是节点"的判据——那会让整棵树一个都遍历不到。
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) return;
    // 对象节点本身不标：它的"可编辑"由子字段的 volatile 递归带出来
    // （`volatileForm` 对 object 节点就是这么做投影的）。给对象节点标 volatile 还会破坏取值
    // （实测 `Schema.resolve` 报 `unsupported type "undefined"`）。
    if (node.dict && typeof node.dict === 'object' && Object.keys(node.dict).length > 0) {
      for (const child of Object.values(node.dict)) walk(child);
      return;
    }
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
    if (node.meta?.volatile) return;
    // **必须就地改 `node.meta`**：schemastery 的 `extra()`/`volatile()` 都走 `Schema(this)`
    // 复制出一个新节点再改，返回的是副本——照那样写只会标到一堆被丢掉的副本上。
    node.meta = { ...node.meta, volatile: true };
  };
  walk(schema);
  return schema;
}
