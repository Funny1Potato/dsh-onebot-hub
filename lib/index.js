/**
 * DSH 插件入口：OneBot v11 枢纽。
 *
 * 角色（§1.1 / §7）：DSH 在这套链路里既是**下游 bot 的管理者**，自身也是一个 bot。
 *  - 上游：hub 以正向 WS 客户端身份接入真正的 OneBot v11 实现端（QQ 实现）；
 *  - 下游：hub 反向 WS 监听，接受下游 bot 拨号，在它面前扮演"实现端"；
 *  - 中间：真实事件零改写下发（透传 > 合成，§18），下游 action 按策略本地答/捕获/转发；
 *  - 观测：全量时间线 + 捕获账本，供 agent 得知所有消息并学习下游用法（§16/§17）。
 */

// 宿主包一律「动态探测 + 兜底」，绝不静态 import。
// 原因（实测 2026-06）：不同 DSH 装配（desktop / web / headless）对 `@deepseek-ai/*`
// 的解析方式并不一致，静态 import 一旦解析不到，**整个插件模块 import 失败**，
// 连枢纽转发都起不来（症状：`onebot-hub (dsh-onebot-hub): failed to import`，
// 且 cordis 侧 fiber 为 undefined，拿不到更细的堆栈）。
// 兜底后最坏情况只是「少一层 schema 校验 / 工具定义包装」，核心链路照常工作。
let defineTool = (definition) => definition;
try {
  const toolsMod = await import('@deepseek-ai/dsh-tools');
  if (typeof toolsMod?.defineTool === 'function') defineTool = toolsMod.defineTool;
} catch {
  /* 宿主未暴露 dsh-tools：用恒等兜底 */
}
let schemaLib = null;
try {
  schemaLib = (await import('@deepseek-ai/schemastery')).default ?? null;
} catch {
  schemaLib = null;
}
let wsLib = null;
try {
  wsLib = await import('ws');
  if (typeof wsLib?.WebSocket !== 'function') wsLib = null;
} catch (err) {
  wsLib = null;
  console.log('[dsh-onebot-hub] ws 依赖不可用（下游 WebSocket 端点将无法启用）：', err?.message ?? err);
}
import { Hub } from './hub.js';
import { useWs } from './link.js';
import { PRESETS, PROBE_ISOLATIONS } from './router.js';
import { Mind, SESSION_ID_PREFIX } from './mind.js';
import { REPLY_TOOL_PARAMS, composeReply, describePlanIssues, describeReply, resolveReplyImages } from './reply.js';
import { AgentPool } from './agent/pool.js';
import { ADMIN_OP_NAMES, planAdminOp } from './admin.js';
import { AGENT_MODES, AWAKE_SILENT_TURNS, describeAgentPolicy, resolveAgentPolicy } from './agent/policy.js';
import { MemoryStore } from './memory/store.js';
import { IsolationAudit, describeIsolation, filterForScope, resolveIsolation } from './memory/isolation.js';
import { applyMemoryOps } from './memory/writer.js';
import { defaultStorageDir } from './storage.js';
import { createStartupLog } from './startup-log.js';
import { normalizeVisionMode } from './vision.js';
import { DEFAULT_ANIMETRACE_URL, AnimeRecognizer, normalizeBackend as normalizeAnimeBackend } from './vision/anime.js';
import { ImageGen } from './vision/imagegen.js';
import { PersonaStore } from './persona/store.js';

import { ChatCommands, COMMAND_SPECS } from './chat-commands.js';
import { MemeStore, normalizeKeywords } from './memes/store.js';
import { SessionModels } from './models.js';
import { clientReportStatus, installClientProbe } from './client-probe.js';
import { MODEL_LIST_PATH, installModelListRoute } from './llm-models.js';

export const name = 'dsh-onebot-hub';
export const inject = ['webServer', 'tools'];

/**
 * 标注一个字段为**凭据**：宿主 `@deepseek-ai/dsh-settings` 投影表单时会把它整段抹掉，
 * 只留"设过没设过"（`redactSecrets`）。老版本 schemastery 没有 `role()` 就原样退回，
 * 缺这个标注顶多是设置页把 token 明文显示，不该因此让插件加载不了。
 */
const secretField = (field) => (typeof field?.role === 'function' ? field.role('secret') : field);

// 配置表：只有 schemastery 可用时才构造 schema（否则 Config 为 undefined，
// 由 resolveConfig() 的默认值兜底，插件照样能加载）。
const buildConfigSpec = (z) => ({
  enabled: z.boolean().default(true),
  upstreamUrl: z.string().default(''),
  upstreamSelfId: z.string().default(''),
  upstreamNickname: z.string().default(''),
  // 这两项**刻意不给默认值**（用户要求）：没配过就是"没有这一项"，清空就是清空。
  // 少一个 `.default('')`/`.default('[]')`，resolved 配置里就没有这个键——设置页靠
  // `lib/client.js` 的 ALWAYS_FIELDS 补出空行，运行时由 resolveConfig 兜底。
  upstreamListen: z.string(),
  upstreamAccessToken: secretField(z.string().default('')),
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
    })
    .default({}),
  actionPolicy: z.string().default('{}'),
  logFrames: z.boolean().default(false),
  persist: z.boolean().default(true),
  storageDir: z.string().default(''),
  agent: z
    .object({
      mode: z.string().default('assist'),
      batchSize: z.number().default(6),
      batchMs: z.number().default(8000),
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
      // 识图那边的思考强度（同上，跟 `defaultVisionModel` 配对）。
      defaultVisionReasoningEffort: z.string().default(''),
      // 会话白名单（m31030）：JSON 数组字符串 `[{"id":"617770183","mode":"assist"}]`。
      // `groups` 的 id=群号、`privates` 的 id=QQ号；没列出的会话**不喂模型**（@ 也不理）。
      // mode 可省（= 跟全局 agent.mode），合法值 observer/assist/active；批量参数全局统一。
      // 两张名单都留着不写 = 全部静音；设置页有行编辑器（群号/QQ号 + 模式下拉）。
      groups: z.string().default('[]'),
      privates: z.string().default('[]'),
      // 激活期插话（m31311）：回合在飞时新到的消息不再排队等下一轮，直接 steer 进正在跑的
      // 回合（宿主 next-step 原语，下一步边界送达、同一回合继续）。默认开；关掉回到旧行为。
      steer: z.boolean().default(true),
      // 一次 `onebot_reply` 可以发多条消息（m32420）：拆条照 aigf-master（图片各自一条、
      // 文字/@ 各聚一条，`break` 或空行强制断开）。下面三个键是发送节奏与防刷屏。
      replyGapMs: z.number().default(400),
      // 文字条数上限（**图不占额度**，用户 m32420 定案）。
      replyMaxText: z.number().default(3),
      replyMaxImages: z.number().default(9),
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
      maxBytes: z.number().default(8 * 1024 * 1024),
      fetchTimeoutMs: z.number().default(5000),
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
    })
    .default({}),
  /**
   * 人设（①§26）：预设库 + **按会话绑定**。
   *
   * 和 master 那版最大的区别就在这里：那边的预设选择**不落盘**，一重启所有群都回默认；
   * 这里 `bindings.json` 把"哪个会话用哪个预设"写进 storage，重启后各群还是各自的角色。
   * `presets` 是启动时的种子（JSON 数组，空就用内置 default），之后以落盘内容为准。
   */
  persona: z
    .object({
      enabled: z.boolean().default(true),
      defaultName: z.string().default('default'),
      presets: z.string().default('[]'),
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
      maxReplyChars: z.number().default(800),
    })
    .default({}),
  /**
   * 表情包库（④§26）：**由 agent 决定收不收**（方案 v2）——不再自动收集。
   * `autoCollect` 是总闸：关掉后连 agent 也不许收录（工具 add 直接拒绝）。
   */
  memes: z
    .object({
      enabled: z.boolean().default(true),
      topK: z.number().default(8),
      maxSend: z.number().default(3),
      autoCollect: z.boolean().default(true),
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
      maxSize: z.string().default('1024x1024'),
      minSize: z.string().default(''),
      watermark: z.boolean().default(false),
      timeoutMs: z.number().default(120000),
      maxPerTurn: z.number().default(1),
    })
    .default({}),
  memory: z
    .object({
      limit: z.number().default(5000),
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
          level: z.string().default('scoped'),
          crossGroupIdentity: z.boolean().default(true),
          crossGroupFacts: z.string().default('shareable'),
          privateFacts: z.string().default('never'),
          sensitivityAlwaysLocal: z.boolean().default(true),
          overrides: z.string().default('[]'),
          trustedGroups: z.string().default('[]'),
          recallEscape: z.boolean().default(false),
          recallEscapeNeedsApproval: z.boolean().default(true),
          audit: z.boolean().default(true),
          auditRetain: z.number().default(200),
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

export const Config = schemaLib ? markEditable(schemaLib.object(buildConfigSpec(schemaLib))) : undefined;

const DEFAULT_PRESET_NAME = 'relay';

/**
 * 一串路径文本 → 路径数组（`parseCodeScopes` 的零件）：一行一个，去空行、去重复。
 * 老配置里 `code.roots` 就是这种纯文本，所以这个函数留着。
 */
export function parseCodeRoots(raw) {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
  const seen = new Set();
  const out = [];
  for (const line of text.split(/[\r\n]+/)) {
    const item = line.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 下游 bot 源码范围（M7-③，`m14112` / `m14477`）：**只告诉 agent 位置、不给它扫描工具**，
 * 而且位置**不写进 prompt**——agent 需要时调 `onebot_code_scopes` 取（可能有多个下游）。
 *
 * 认三种写法，都是为了"手写配置也能活"：
 *  - JSON 数组：`[{"name":"下游A","path":"D:/x"}]`（设置页行编辑器写的就是它）
 *  - JSON 字符串数组：`["D:/x","D:/y"]`
 *  - 纯文本：一行一个路径（`备注 = 路径` 也认）
 * 去掉空项、按路径去重（先出现的那个备注留下）。
 */
export function parseCodeScopes(raw) {
  const items = [];
  const pushItem = (item) => {
    if (item === undefined || item === null) return;
    if (typeof item === 'string') {
      // 一行一个路径；`备注 = 路径` 是手写时的顺手写法（等号左边的空格会被去掉）。
      for (const line of parseCodeRoots(item)) {
        const at = line.indexOf('=');
        if (at > 0) items.push({ name: line.slice(0, at).trim(), path: line.slice(at + 1).trim() });
        else items.push({ name: '', path: line });
      }
      return;
    }
    if (typeof item !== 'object') return;
    items.push({
      name: String(item.name ?? item.label ?? item.note ?? '').trim(),
      path: String(item.path ?? item.dir ?? item.root ?? item.value ?? '').trim(),
    });
  };

  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        value = JSON.parse(text);
      } catch {
        // 坏 JSON 也**不许**把整条配置丢掉：把里面的路径值抠出来（名字丢了，总比整条没了强）。
        const salvaged = [];
        for (const match of text.matchAll(/"(?:path|dir|root|value)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          salvaged.push({ name: '', path: match[1].replace(/\\"/g, '"') });
        }
        // 一个也没抠出来（比如只是少了个括号）时，退回按行解析。
        value = salvaged.length ? salvaged : [text];
      }
    } else {
      value = [text];
    }
  }
  if (Array.isArray(value)) for (const item of value) pushItem(item);
  else pushItem(value);

  const seen = new Set();
  const out = [];
  for (const item of items) {
    const path = String(item?.path ?? '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ name: String(item?.name ?? '').trim(), path });
  }
  return out;
}

/** 源码范围的**人读**写法（日志与状态用）：`备注（路径）`，没备注就只写路径。 */
export function describeCodeScopes(scopes) {
  return (Array.isArray(scopes) ? scopes : [])
    .map((scope) => (scope?.name ? `${scope.name}（${scope.path}）` : String(scope?.path ?? '')))
    .filter(Boolean);
}

/**
 * 有没有**配好的探针链路**：目标里写了 `probeSelfId`（normalize 阶段展开出一条 `probeOnly` 的），
 * 或者有人显式标了 `probeOnly`。链路隔离（`probe.isolation: 'link'`）靠它才成立——一条都没有时
 * Hub 会把档位回退成 `off`，给 agent 的指导段也就不该再提"链路隔离"。
 */
export function hasProbeLink(config = {}) {
  const targets = Array.isArray(config?.downstreamTargets) ? config.downstreamTargets : [];
  return targets.some((entry) => entry?.probeOnly === true);
}

/** 插件给宿主 agent 的指导段。 */
export function buildHubGuidance(config = {}) {
  const lines = [
    '本机已安装 dsh-onebot-hub 插件（OneBot v11 枢纽）：DSH 在下游 bot 面前扮演实现端，同时自身也是一个 bot。',
    '能力：onebot_hub_status 查看上下游链路、agent 池与记忆统计；onebot_timeline 读全量消息时间线（它知道所有消息）；',
    'onebot_context 看某个会话此刻装配进 prompt 的上下文与隔离审计；onebot_memory_audit 查跨会话记忆的放行/拦截留痕；',
    'onebot_capture 看下游插件实际发过哪些 action（学习下游用法的原始证据）；onebot_turns 看"哪条消息触发了下游什么"（回合配对、响应者、延迟、沉默回合）；onebot_capabilities 读/写"下游会吃什么消息"的知识库（用法学习，够证据才升 active）；onebot_relay_probe 先预测再动手（默认只回答"这句话会不会触发下游"，不发任何东西）；',
  ];
  // 命令前缀必须跟着配置走（`m02289`/`m33950`：用户把 `/` 改成 `.` 过，写死就教错了模型）。
  const chatPrefix = String(config?.chatCommands?.prefix ?? '/') || '/';
  const hasSuperUser = Array.isArray(config?.chatCommands?.superUsers)
    && config.chatCommands.superUsers.length > 0;
  const commandList = COMMAND_SPECS.map((spec) => `${chatPrefix}${spec.name}`).join(' ');
  lines.push(
    '能力面：onebot_call 是通用 action 通道（直接问上游真实现端）；onebot_caps 看实测可用性、onebot_profile/onebot_group/onebot_members/onebot_avatar 读人与群、onebot_media 解析图片语音与转发消息；',
    'onebot_admin 是群管理动作的结构化入口（踢人/禁言/管理员/退群/撤回等），两段式：先不带 confirm 预演看会发生什么，确认后再 confirm=true 真发；',
    '只读查询有 TTL 缓存且返回 source 字段（upstream=实时 / cache=缓存），write 与 danger 级 action 默认拒绝，必须先显式配置白名单；',
    'onebot_invoke 向下游链路投递任意 OneBot action（含触发下游插件的命令消息），可用 user_id 以**指定的账号**说话——换账号常常换结果（权限/冷却/用户级状态）；**走哪条链路由枢纽决定**（`downstream` 只说"问哪个下游"，探针还是真实按 `probe.isolation` 选，真要点真实链路得显式 `allow_real_link`）；发言**只有一条出口**：onebot_reply 工具——你写在普通回复文本里的话只是内部草稿，宿主**不会**替你发进聊天，不调它就是沉默；它用 hub 自己的身份发言（可带 memes：只能用上下文里列出的表情包 id，编造的 id 会被丢掉并如实告诉你）。',
    '人设/表情包/看图/识番/生图：persona.* 给每个会话一套人设（/set_role 只改本群，不泄漏给共用同一预设的别的群）；memes.* 表情包库由你自己管理（收录/改简介/删除，清单里只有一行简介，想看某个的完整描述用 action:"get"）；vision.anime 给图片补一行角色名（认不出就说认不出，全挂时不编造）；imageGen.* 让模型能自己生图（默认关，必须配 model/baseUrl/apiKey）。',
    '表情包收藏判断（值得才收）：如果是表情包（能表达一定的情感，适合在群聊中反复使用），且表情包库里没有类似的图片，且你觉得值得保存的，才 `onebot_memes{action:"add", messageId, brief, description?, keywords}` 收录——brief 和描述由你写（description 没写就用已生成的图片描述）；随手截图、风景照、bot 自己生的图（生图/截图）不收，收藏群友发的梗图；正文里绝不出现表情包 id。',
    '多下游的记录**都带人话名字**（时间线的 `linkLabel`、捕获与回合的 `downstreamLabel` / `responderLabels`、状态的 `label`）：`linkId`/`downstreamId` 常常只是 `host:port`，真实链路与探针链路只差一个 `~probe`，别拿它当名字分辨。下游发出来的图片/语音会落地成媒体引用（`mediaRefs`）并按需给出描述——上下文里看到的是引用，不是 base64。',
    '**收到的每一条消息都留了原文与索引**：`onebot_timeline` 每条都带 `rawRef`，用它调 `onebot_raw` 能取回**完整原始报文**与这条已落地的媒体（`media[].blob` 是本地路径）。hub 只做"能自动做的那点解析"——认不出的段类型、以及**故意不展开**的聊天记录（合并转发 / 多消息卡片），都要你用**自己的工具**读原文与 blob 自行解析。缓存按 `retention.days`（默认 7 天）自动清理。',
    '**拿不到完整内容的消息，多半不是对你说的，一般不需要阅读**：`[合并转发 N 条：内容未展开]`、`[聊天记录卡片：内容未展开]`、`[卡片：…]`（JSON/XML/小程序/链接卡片）这类你只看到占位的内容，正常对话不必理会，也**不要为了"看懂它们"去调工具**；只在明确需要解析时（群友点名让你看那条记录、问卡片里写了什么）才读原文——合并转发与聊天记录卡片用 `onebot_media{action:"get_forward_msg", id|file|message_id}`，其它任意消息按时间线 `rawRef` 调 `onebot_raw`。回复引用（`↩回复「…」`）是已经取好的上下文，直接读即可，不在此列。',
    '**排查类问题要快出结论**："下游到底收到没 / 为什么没反应 / 链路通不通"这类问题，`onebot_turns`（带 `withOutcomes`）一轮就能回答；只有它解释不了才补一次 `onebot_timeline` / `onebot_capture`，**两三次调用内必须给结论**——别把排查当连续剧一集集追，群友还在等回复。',
    '铁律：下游适配器会自己重算 to_me 并按自己的 self_id 匹配 at/昵称，所以事件必须保持原样搬运——不要手工合成事件、不要改写空白或段序；',
    '下游已应答时 DSH 必须保持沉默（命令静默）。拟人化不是靠延迟和分条堆出来的，是判断问题：说不说、说什么由你决定。',
  );
  // 聊天管理命令这一段**只在真有超管名单时才写进 prompt**（`m33950`）：名单为空时整条链沉默，
  // 而"引导群友敲一条没人能执行的命令"是教模型做没用的事。
  if (hasSuperUser) {
    lines.push(
      `聊天管理命令（${commandList}）只认 chatCommands.superUsers 里的账号。`
        + '前缀+名字命中时枢纽**自己回一条**，但**不吞消息**：原消息照常投下游（下游有同名命令就两个都触发），'
        + '只有"喂给模型"这一步跳过（回话已用同一个账号发过）。非超管敲这些命令不回复、当普通消息走；'
        + `让路前缀（\`!!\`，可配）表示连枢纽那条回话都不要（\`!!${chatPrefix}reset\` 当普通文本走）。`,
    );
  } else {
    lines.push('这台部署**没有配聊天管理命令的超管名单**：管理命令整条链沉默（不猜谁是管理员），别去引导群友敲它们。');
  }
  // 权限不够怎么办（`m33950` 用户要求写进 prompt）：DSH 的权限是**超管给的**、而且**一次授权只管
  // 这次唤醒**，所以"自己想办法"和"假装能做"都不对——正确的动作是**开口要**：说清缺什么权限、
  // 要它来干什么，让超管敲一条命令（有超管名单才教命令；前缀已在上方按配置取好）。
  if (hasSuperUser) {
    lines.push(
      `**权限不够就开口要（DSH 的权限是超管给的，你改不了自己的）**：文件读不了、命令跑不了、目录不可写时，`
        + `别绕路也别假装能做——在回话里说清"缺什么权限、要它干什么"，并请超管敲 \`${chatPrefix}perm <预设名>\``
        + `（认不出的预设名就把可选项列出来；这条命令只认 chatCommands.superUsers 里的账号）。`
        + `常见对应：只读资料 \`${chatPrefix}perm read-only\`、要改文件或跑命令 \`${chatPrefix}perm workspace-write\`。`
        + `授权**只对这一次唤醒有效**，下一次醒过来又会回到部署默认——所以别指望"上次给过了"，该要还是要要；`
        + `也别用 onebot_tools 去开后门给自己加权限。`,
    );
  } else {
    lines.push(
      '**权限不够就如实说**：文件读不了、命令跑不了、目录不可写时，别绕路也别假装能做——'
        + '在回话里说清缺什么权限、要它干什么，让超管去改（这台部署没有配命令超管名单，超管暂时没法用命令给你授权）。',
    );
  }
  const scopes = Array.isArray(config?.codeScopes) ? config.codeScopes : [];
  // 看图只有描述这一条路时，把"图片怎么读"写死在指导段（`m26571`）：工具面里没有 `read_image`，
  // 光指望模型自觉是没用的——它之前自己开了 28 次。
  const visionMode = String(config?.vision?.mode ?? 'describe');
  if (visionMode === 'describe' || visionMode === 'off') {
    lines.push(
      '看图：**图片一律以上下文里的描述为准**（`[图片：…]`，看图模型已经把图看过一遍并把描述拼进正文了）。'
        + '`vision.mode` 现在是 `describe`——图片本体不会作为内容段给你，`read_image` 也不在默认工具面里，'
        + '这是有意的：别自己打开图片文件重看一遍（有专门的看图链路，读描述就是读图）。',
      '**更不要绕道看图**：不要用 `onebot_tools` 把 `read_image`/`read` 开回来自己看图，也不要为看图另起 subagent——'
        + '描述已经是看过图的结论，重看一遍只会拖慢回复（实测有 agent 这么干，回复被拖到激活超时、整段会话被宿主掐断）。',
    );
  } else {
    lines.push(
      '看图：`vision.mode` 含 `segment`——看得见的模型会直接收到图片本体，随消息另附一段 `[图片：…]` 描述'
        + '（看不见图的模型靠它）。描述与图像有出入时，以你**自己看到的**为准。',
    );
  }
  if (config?.probe?.isolation === 'link' && hasProbeLink(config)) {
    // 链路隔离开着才说这段：这是"探测手段会改变观测结果"的提醒，不是操作说明。
    lines.push(
      '探针隔离是**链路隔离**：onebot_invoke 的注入走一条专用探针链路（另一个账号），'
        + '那条链路收不到群里的真人消息，它自己的 send_* 也只被捕获、不会进群。',
      '所以**探针的执行结果可能与用户触发时不同**（链路状态、在线与否、插件里按账号存的状态都可能不一样）：'
        + '别把探针结果当成群里真实发生过的对话，也别据此断言"用户这么发一定会这样"——要断言就得有真消息上的证据。',
    );
  }
  if (scopes.length) {
    // 只提"去哪儿取"，**不列地址**（`m14477`）：填的路径可能很多、还会变，没必要每轮都塞进 prompt。
    lines.push(
      '下游 bot 的源码位置**不在这里**（可能有多个下游）：要知道在哪儿就调 onebot_code_scopes（只回答位置，不读文件）；' +
        '读文件用你自己的工具（read/grep/glob），权限不够就按上面那条开口要权限（说清缺什么、要它干什么），不要绕路，也不要改下游的文件。',
    );
  }
  return lines.join('\n');
}

function readField(value, fallback) {
  if (value === undefined) return fallback;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const inner = value.get();
    return inner === undefined ? fallback : inner;
  }
  return value;
}

/** 把"用户填的 0~1 数值"夹到合法区间；坏值（NaN/字符串）退回默认，不让 NaN 传下去。 */
function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function parseJsonObject(text, fallback) {
  const parsed = parseJsonValue(text, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function parseJsonValue(text, fallback) {
  if (typeof text !== 'string') return text === undefined ? fallback : text;
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * `onebot_memory` 的 `ops`：对象与字符串都收，**包括"双重编码"**（`m02432` P8）。
 *
 * 真机症状：模型把 `{short_term:{...}}` 先 stringify 成字符串、然后又当字符串发了一次，于是
 * `parseJsonValue` 解出来还是一个字符串 → 写入侧看到"不是对象"，整轮 `applied` 全是 0、
 * `rejected:[{path:'memory',reason:'指令必须是对象'}]`，而模型以为自己写成功了。
 * 所以这里最多连解三层（顺带剥掉 ```json 代码围栏）；解析不出来就交给 `applyMemoryOps`
 * 给一条读得懂的拒绝理由。
 */
function coerceOps(value) {
  let cur = value;
  for (let i = 0; i < 3; i += 1) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) return cur;
    if (typeof cur !== 'string') return null;
    const text = cur.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (!text) return null;
    try {
      cur = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : null;
}

/**
 * 解析"上游反向 WS 监听地址"：**地址里直接带路径**——`host:port/path`。
 * 接受：
 *  - `127.0.0.1:14514/onebot/v11/ws`（推荐写法，一份配置说完整）
 *  - `ws://127.0.0.1:14514/onebot/v11/ws`（直接粘完整 URL 也认，scheme 被忽略）
 *  - `:14514/onebot/v11/ws`、`14514/onebot/v11/ws`（缺 host 时默认 `127.0.0.1`）
 *  - `127.0.0.1:14514`、`127.0.0.1:14514/`（**没写路径 = 根路径 `/`**）
 * 空串表示不监听。
 *
 * 为什么把路径并进来：路径本来就是"这个监听地址的一部分"（实现端拨的 URL 里有它），
 * 拆成两个配置项只会让人改了一半（改了地址忘了路径）然后对着 1008 发呆。
 *
 * 为什么**不做**"缺省补 `/onebot/v11/ws`"：写什么就是什么。偷偷补一条默认路径，
 * 就会出现"我明明写的是 `127.0.0.1:14514`，它却只接受 `/onebot/v11/ws`"这种
 * 怎么查都查不出来的错配——那比不监听更难排查。
 *
 * 为什么要有这个模式（§19 实测）：LLOneBot/Lagrange 这类实现端常配成**反向 WS**——
 * 它主动拨 app 的地址（例：`D:\LLBot-Desktop-win-x64\bin\llbot\data\config_3371846367.json`
 * 里 `{"type":"ws-reverse","url":"ws://127.0.0.1:14514/onebot/v11/ws","enable":true}`），
 * 而正向 WS 服务端是关的。此时 hub 拨号永远 ECONNREFUSED，只能自己监听那个地址。
 */
export function parseListenTarget(raw) {
  const parsed = parseAddress(raw, { defaultHost: '127.0.0.1' });
  // 上游监听端**不许 0 端口**：没人能拨一个"内核随便挑的端口"（下游监听型目标才允许 0）。
  return parsed && parsed.port > 0 ? { host: parsed.host, port: parsed.port, path: parsed.path } : null;
}

/** 从地址里认出 scheme（`ws`/`wss`/`http`/`https`），没有就返回 null。 */
export function schemeOfAddress(raw) {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(raw ?? '').trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return ['ws', 'wss', 'http', 'https'].includes(scheme) ? scheme : null;
}

/**
 * 统一地址解析（§19）：`[scheme://]host[:port][/path]` → `{scheme, host, port, path}`。
 *
 * 上下游**同一套写法**（用户定的规矩）：`127.0.0.1:8654/onebot/v11/ws`，scheme 可省；
 * 不写路径 = 根路径 `/`（**不偷偷补默认**，写什么就是什么）。`port: 0` 允许——监听型
 * 目标可以用它让内核分配端口（测试就这么用）。解析不出来（没有端口 / 端口不是数字 /
 * 越界）返回 null，调用方按"这条目标无效"处理。
 */
export function parseAddress(raw, { defaultHost = '127.0.0.1' } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const scheme = schemeOfAddress(text);
  const withoutScheme = scheme ? text.slice(text.indexOf('://') + 3) : text;
  const cut = withoutScheme.search(/[/?#]/);
  const authority = cut === -1 ? withoutScheme : withoutScheme.slice(0, cut);
  const rawPath = cut === -1 ? '' : withoutScheme.slice(cut).split('?')[0].split('#')[0];
  const colon = authority.lastIndexOf(':');
  const host = (colon === -1 ? '' : authority.slice(0, colon)).trim();
  const portText = colon === -1 ? authority : authority.slice(colon + 1);
  if (portText.trim() === '' || !/^\d+$/.test(portText.trim())) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let path = rawPath.trim();
  if (path === '') path = '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return { scheme, host: host === '' ? defaultHost : host, port, path };
}

/** 下游目标的连接形态（§19）：从 **hub 自己的动作**命名，避免"正/反向"两套叫法打架。 */
export const DOWNSTREAM_TYPES = ['ws-dial', 'ws-listen', 'http-api', 'http-post'];

const DOWNSTREAM_TYPE_ALIASES = {
  'ws-dial': 'ws-dial',
  dial: 'ws-dial',
  'ws-reverse': 'ws-dial', // LLBot/NoneBot 的说法：实现端拨出去
  'ws-listen': 'ws-listen',
  listen: 'ws-listen',
  ws: 'ws-listen', // LLBot 的 `ws`：实现端开服务端，等 app 拨进来
  'http-api': 'http-api',
  api: 'http-api',
  http: 'http-api', // LLBot 的 `http`
  'http-post': 'http-post',
  post: 'http-post',
  http_post: 'http-post',
  'http-post-url': 'http-post',
};

/** 把类型字符串规整成四种之一；认不出来就用 `fallback`（默认拨号）。 */
export function normalizeDownstreamType(raw, fallback = 'ws-dial') {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  return DOWNSTREAM_TYPE_ALIASES[text] ?? fallback;
}

/** 每条目标自己的协议族：`ws-*` 走 WebSocket，`http-*` 走 HTTP。 */
function protocolOfType(type) {
  return type.startsWith('http') ? 'http' : 'ws';
}

/**
 * 把配置里的 JSON 字符串或数组规整成下游目标列表（§19 多下游）。
 *
 * 每条目标：
 *  - `id`：**唯一键**（缺省 = 显式写的 `selfId`；没写 selfId 时用 `<host>:<port>`，免得
 *    多条"默认账号"的目标互相撞成 `#2`）。同 `id` 出现多次时自动加 `#2`/`#3`——两个目标
 *    用同一个 bot 账号接两个 app 是合法用法，但链路必须各自可寻址。
 *  - `type`：`ws-dial`（默认，hub 拨出去）｜`ws-listen`（hub 监听，对方拨进来）｜
 *    `http-api`（hub 提供 HTTP API）｜`http-post`（hub 把事件 POST 给对方）。
 *    也认 LLBot 的写法：`ws-reverse`→`ws-dial`、`ws`→`ws-listen`、`http`→`http-api`。
 *  - `address`（别名 `url`）：**统一写法** `host:port/path`（scheme 可省，按类型补
 *    `ws://` / `http://`；写了 `wss://`/`https://` 就按 TLS 走）。
 *  - `selfId`：这条链路上**对方（app）的账号**。**不写 = 与上游相同**（取
 *    `options.defaultSelfId`，也就是 `upstreamSelfId`）。
 *  - `nickname`、`accessToken`、`enabled`（默认 true）、`reconnectInterval`（拨号型）。
 *  - `probeOnly`（默认 false）：标了它的链路在链路隔离（`probe.isolation: 'link'`）下**只收注入**、
 *    不收上游消息；上游消息广播时跳过它。
 *  - `probeSelfId`：**探针账号**——同一个下游、另一个 bot 账号。写了它就等于一次声明两条链路：
 *    主链路照旧，另加一条探针链路（`probeOnly: true`，地址与本条**相同**，只有 `selfId` 不同），
 *    两者共用同一个 `downstreamId`，探针那条的 id 是 `<id>~probe`。**不写就不展开**——
 *    链路隔离因此没有默认值：没配探针账号时那一档会回退到关闭。与主链路账号相同时也不展开
 *    （下游会拿 `Duplicate X-Self-ID` 把第二条踢掉）。
 *  - `downstreamId`：**逻辑下游** id（缺省 = `selfId`）。同一逻辑下游的多条物理链路写同一个
 *    值，agent 才知道"这两条是同一个 bot 的两个实例"；`id` 是物理链路键，两者不是一回事。
 *
 * **不做静默丢弃**：缺地址 / 缺端口 / 拨号型把 0 端口当监听地址写的条目会被跳过（hub 会记日志）。
 * 拨号型既没写 selfId、上游账号也还没配时**不丢**：照旧登记，`pendingAccount: true`，hub 先不建链，
 * 等学到上游账号（握手头 / 事件 `self_id` / `get_login_info`）再自动补建。
 * 类型与地址里的 scheme 打架（例：`http-api` 写了 `ws://`）不丢条目，但会带一条
 * `warning` 说明"按哪个走"。
 */
export function normalizeTargets(raw, options = {}) {
  const defaultSelfId = String(options.defaultSelfId ?? '');
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const counts = new Map();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const typed = String(entry.selfId ?? entry.self_id ?? '');
    // 不写对方账号 = 与上游相同（用户要求）。上游账号**也还不知道**时留空、但**不丢**这条目标：
    // hub 先不建链（拿空身份握手没意义），等学到上游账号再补建——学到账号的路子有三条
    // （对方握手头 `X-Self-ID`、上游事件的 `self_id`、`get_login_info` 探测），见 hub.js 的
    // `learnUpstreamAccount` / `#adoptUpstreamAccount`。
    const selfId = typed || defaultSelfId;
    const explicitId = String(entry.id ?? '');
    const mainParsed = parseAddress(entry.address ?? entry.url, { defaultHost: '127.0.0.1' });
    // id 只认**显式**写的 selfId：默认账号（= 上游账号）可能落在多条目标上，拿它当键会
    // 让它们互相挤成 `#2`/`#3`，反倒不好寻址；没写就用地址。`||` 而非 `??`：空串要落到下一档。
    const mainBase = String(explicitId || typed || (mainParsed ? `${mainParsed.host}:${mainParsed.port}` : ''));
    /**
     * 逻辑下游 id（§19 / M7-④）：**两条物理链路属于同一个下游**这件事只能由人声明，
     * agent 猜不出来——`selfId` 是枢纽替对方扮演的账号（可以随便配），不是身份证据。
     * 缺省 = 这条链路的对方账号（`selfId`，没写就与上游相同），所以"只换端口不换 selfId"
     * 的两条链路**天然归到同一组**；要显式分组就写 `downstreamId`。
     */
    const downstreamId = String(entry.downstreamId ?? entry.downstream_id ?? selfId ?? '').trim() || mainBase;
    /**
     * 一条目标可以自带**探针账号**（`probeSelfId`，别名 `probe_self_id`）：hub 把它展开成
     * **第二条链路**（`probeOnly: true`，地址与本条相同、只有 `selfId` 不同），与主链路共用
     * 同一个 `downstreamId`——**一个下游写一条配置**，不必写两条必须互相对齐的条目（写岔了
     * 就会把探针注入打到真链路上）。**不写就不展开**，所以链路隔离没有默认值。与主链路账号
     * 相同时也不展开（下游按 `self_id` 注册，同 id 第二条会被 `Duplicate X-Self-ID` 踢掉）。
     */
    const probeSelfId = String(entry.probeSelfId ?? entry.probe_self_id ?? '').trim();
    const probeDiffers = probeSelfId !== '' && probeSelfId !== selfId;
    const variants = [{
      parsed: mainParsed,
      type: normalizeDownstreamType(entry.type),
      probeOnly: entry.probeOnly === true || entry.probe_only === true,
      idBase: mainBase,
      selfId,
    }];
    if (mainParsed && probeDiffers) {
      variants.push({
        parsed: mainParsed,
        type: normalizeDownstreamType(entry.type),
        probeOnly: true,
        // 探针那条的 id 不能与主链路撞：显式 id 加 `~probe`，否则用主链路键加后缀。
        idBase: (explicitId || typed || `${mainParsed.host}:${mainParsed.port}`) + '~probe',
        selfId: probeSelfId,
      });
    }
    for (const variant of variants) {
      const parsed = variant.parsed;
      if (!parsed) continue;
      const type = variant.type;
      const targetSelfId = variant.selfId;
      const dialsOut = type === 'ws-dial' || type === 'http-post';
      if (dialsOut && parsed.port === 0) continue;
      const want = protocolOfType(type);
      const scheme = parsed.scheme ?? (want === 'http' ? 'http' : 'ws');
      const schemeFamily = scheme === 'wss' || scheme === 'ws' ? 'ws' : 'http';
      const warning = schemeFamily === want ? undefined : `type=${type} 但地址写的是 ${scheme}://，按 ${type} 解释（scheme 只用来决定要不要 TLS）`;
      const base = variant.idBase || `${parsed.host}:${parsed.port}`;
      const seen = (counts.get(base) ?? 0) + 1;
      counts.set(base, seen);
      const reconnectInterval = Number(entry.reconnectInterval ?? entry.reconnect_interval);
      out.push({
        id: seen === 1 ? base : `${base}#${seen}`,
        type,
        scheme,
        host: parsed.host,
        port: parsed.port,
        path: parsed.path,
        address: `${parsed.host}:${parsed.port}${parsed.path}`,
        url: `${scheme}://${parsed.host}:${parsed.port}${parsed.path}`,
        selfId: targetSelfId,
        downstreamId,
        // 探针专用链路（`probe.isolation: 'link'` 时用）：上游消息**一律不投**这条，
        // `onebot_invoke` 缺省投给它。见 §19 探针隔离。
        probeOnly: variant.probeOnly,
        nickname: entry.nickname === undefined ? undefined : String(entry.nickname),
        accessToken: entry.accessToken === undefined ? undefined : String(entry.accessToken),
        enabled: entry.enabled !== false,
        // 拨号/POST 型还缺"对方账号"（上游账号没配、这条也没写）：hub 会先留着不建链，
        // 学到上游账号后自动补建。这个标记只用于状态展示与诊断。
        ...(dialsOut && targetSelfId === '' ? { pendingAccount: true } : {}),
        reconnectInterval: Number.isFinite(reconnectInterval) && reconnectInterval > 0 ? reconnectInterval : undefined,
        warning,
      });
    }
  }
  return out;
}

/**
 * 解析配置里的模型写法（m024167）：`provider/model`、或只给 `model`（provider 留空，
 * 由调用方决定用谁的 provider——聊天沿用会话现有 provider，识图交上游挑）。
 * 认不出的写法返回 null = 没配 = 跟 DSH 系统默认路由；**不猜**一个模型名出来。
 */
export function parseModelRef(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash < 0) return { provider: '', model: text };
  const provider = text.slice(0, slash).trim();
  const model = text.slice(slash + 1).trim();
  if (!model) return null;
  return { provider, model };
}

/** 把 schema 默认值 + 运行期覆盖合并成 Hub 用的普通对象。 */
export function resolveConfig(raw = {}) {
  // 先算上游账号：下游目标里没写"对方账号"的都默认与它相同（见 normalizeTargets 的注释）。
  const upstreamSelfId = readField(raw.upstreamSelfId, '');
  const cfg = {
    enabled: readField(raw.enabled, true),
    upstreamUrl: readField(raw.upstreamUrl, ''),
    upstreamSelfId,
    upstreamNickname: readField(raw.upstreamNickname, ''),
    upstreamListen: parseListenTarget(readField(raw.upstreamListen, '')),
    upstreamAccessToken: readField(raw.upstreamAccessToken, ''),
    downstreamAccessToken: readField(raw.downstreamAccessToken, ''),
    downstreamTargets: normalizeTargets(readField(raw.downstreamTargets, '[]'), { defaultSelfId: upstreamSelfId }),
    preset: readField(raw.preset, DEFAULT_PRESET_NAME),
    deliveryMode: readField(raw.deliveryMode, 'transparent'),
    broadcast: readField(raw.broadcast, true),
    readonly: readField(raw.readonly, false) === true,
    deliverMessageSent: readField(raw.deliverMessageSent, false),
    virtualizeMessageId: readField(raw.virtualizeMessageId, false),
    reconnectInterval: readField(raw.reconnectInterval, 5000),
    requestTimeout: readField(raw.requestTimeout, 30000),
    heartbeatTimeout: readField(raw.heartbeatTimeout, 120000),
    // 下游心跳（只发给 implementation 型链路；0 = 不发）。
    downstreamHeartbeatMs: Math.max(0, Number(readField(raw.downstreamHeartbeatMs, 30000)) || 0),
    echoWindowMs: readField(raw.echoWindowMs, 3000),
    maxHop: readField(raw.maxHop, 3),
    logFrames: readField(raw.logFrames, false),
    actionPolicy: parseJsonObject(readField(raw.actionPolicy, '{}'), {}),
  };
  // 落盘（§22.1-3 / §24.10）：默认开，目录留空 = 用 `~/.dsh/onebot-hub`；`persist:false` 则整个关掉。
  const persist = readField(raw.persist, true) !== false;
  cfg.storageDir = persist ? String(readField(raw.storageDir, '') ?? '').trim() || defaultStorageDir() : '';
  if (!PRESETS[cfg.preset]) cfg.preset = DEFAULT_PRESET_NAME;

  // ---- 记忆与 agent（§21 / §24.5）：嵌套对象，但兼容扁平键写法 ----
  const agentRaw = readField(raw.agent, {}) ?? {};
  const memoryRaw = readField(raw.memory, {}) ?? {};
  const isolationRaw = readField(memoryRaw.isolation, {}) ?? {};
  cfg.agentGuidance = String(readField(agentRaw.guidance, '') ?? '');
  cfg.agentPolicy = resolveAgentPolicy({
    mode: readField(agentRaw.mode, readField(raw.agentMode, undefined)),
    batchSize: readField(agentRaw.batchSize, readField(raw.agentBatchSize, undefined)),
    batchMs: readField(agentRaw.batchMs, readField(raw.agentBatchMs, undefined)),
    maxActive: readField(agentRaw.maxActive, readField(raw.agentMaxActive, undefined)),
    idleDisposeMs: readField(agentRaw.idleDisposeMs, readField(raw.agentIdleDisposeMs, undefined)),
    silenceWhenDownstreamResponded: readField(agentRaw.silenceWhenDownstreamResponded, undefined),
    wakeOnPrivate: readField(agentRaw.wakeOnPrivate, undefined),
    wakeOnNotice: readField(agentRaw.wakeOnNotice, undefined),
    speakAssistantText: readField(agentRaw.speakAssistantText, undefined),
    awakeMs: readField(agentRaw.awakeMs, readField(raw.agentAwakeMs, undefined)),
    activeTickMs: readField(agentRaw.activeTickMs, readField(raw.agentActiveTickMs, undefined)),
  });
  cfg.agentTickMs = Math.max(200, Number(readField(agentRaw.tickMs, 1000)) || 1000);
  // hub 配置的默认模型（m024167）：`provider/model`（或只给 model，provider 用会话现有的）。
  // 解析失败/留空 = null = 跟 DSH 系统默认路由。
  cfg.agentDefaultModel = parseModelRef(readField(agentRaw.defaultModel, ''));
  cfg.agentDefaultVisionModel = parseModelRef(readField(agentRaw.defaultVisionModel, ''));
  // 思考强度（m024193）：纯字符串（档位名由**模型自己**定义，hub 不解释），空 = 交给模型默认。
  cfg.agentDefaultReasoningEffort = String(readField(agentRaw.defaultReasoningEffort, '') ?? '').trim();
  cfg.agentDefaultVisionReasoningEffort = String(readField(agentRaw.defaultVisionReasoningEffort, '') ?? '').trim();
  // 会话白名单（m31030）：`agent.groups` / `agent.privates` 存 JSON 字符串（设置页行编辑器拼的），
  // 也容忍直接写对象。解析成 `{id: {mode?}}`：id 空跳过、mode 非法丢弃（该条仍准入，模式跟全局）。
  // 两张名单解析后恒存在（哪怕空对象）→ `sessionOverrideOf` 据此认定"功能已启用"→ 生产默认 deny-all。
  const parseWhitelist = (raw) => {
    const parsed = parseJsonValue(raw, null);
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? Object.entries(parsed).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) }))
        : null;
    const out = {};
    if (!rows) return out;
    for (const row of rows) {
      if (row?.enabled === false) continue; // 行编辑器里的"取消勾选"：条目留着，但不生效
      const id = String(row?.id ?? row?.key ?? '').trim();
      if (!id) continue;
      const mode = AGENT_MODES.includes(row?.mode) ? row.mode : undefined;
      out[id] = mode ? { mode } : {};
    }
    return out;
  };
  cfg.agentGroups = parseWhitelist(readField(agentRaw.groups, undefined));
  cfg.agentPrivates = parseWhitelist(readField(agentRaw.privates, undefined));
  // 激活期插话（m31311）：默认开（不写这个键 = 开）。Mind 里读 `config.agentSteer === false` 判关。
  cfg.agentSteer = readField(agentRaw.steer, true) !== false;
  // 一次调用发多条（m32420）：间隔、文字条数上限（**图不占额度**）、图片条数上限。
  // 0 = 不限（ReplyBuffer 里当成 Infinity）；间隔 0 = 连发不带停顿。
  cfg.replyGapMs = Math.max(0, Number(readField(agentRaw.replyGapMs, 400)) || 0);
  cfg.replyMaxText = Math.max(0, Number(readField(agentRaw.replyMaxText, 3)) || 0);
  cfg.replyMaxImages = Math.max(0, Number(readField(agentRaw.replyMaxImages, 9)) || 0);
  // ---- 能力面（§22）：分级白名单是**字符串数组**（JSON 写法 + 通配），保持和其它配置一致 ----
  const capabilityRaw = readField(raw.capability, {}) ?? {};
  cfg.capability = {
    writeAllow: parseJsonValue(readField(capabilityRaw.writeAllow, '[]'), []),
    dangerAllow: parseJsonValue(readField(capabilityRaw.dangerAllow, '[]'), []),
    exposeSensitive: readField(capabilityRaw.exposeSensitive, false) === true,
    cache: readField(capabilityRaw.cache, true) !== false,
    probe: readField(capabilityRaw.probe, true) !== false,
    downstreamReads: readField(capabilityRaw.downstreamReads, true) !== false,
    callTimeoutMs: Math.max(1000, Number(readField(capabilityRaw.callTimeoutMs, 15000)) || 15000),
    probeTimeoutMs: Math.max(1000, Number(readField(capabilityRaw.probeTimeoutMs, 8000)) || 8000),
  };
  // 探针隔离（M7-④）：默认 `off`（不隔离）。名字刻意不叫 `isolation`
  // ——那个键已经被**记忆隔离**（§24.5 `memory.isolation`）占了。
  // `link` 档要有一条探针链路（目标里写了 `probeSelfId`）才有意义，一个都没有时 Hub 会把它
  // 回退成 `off`（见 hub.js 的 `probeIsolation`）——这里只管认不认这个值。
  const probeRaw = readField(raw.probe, {}) ?? {};
  const probeMode = String(readField(probeRaw.isolation, 'off'));
  cfg.probe = {
    isolation: PROBE_ISOLATIONS.includes(probeMode) ? probeMode : 'off',
    windowMs: Math.max(500, Number(readField(probeRaw.windowMs, 8000)) || 8000),
    maxQueued: Math.max(1, Number(readField(probeRaw.maxQueued, 50)) || 50),
    capture: readField(probeRaw.capture, true) !== false,
  };
  // 原始报文/媒体的保留期（`m03091`）：默认 7 天，0 = 不清理。
  const retentionRaw = readField(raw.retention, {}) ?? {};
  cfg.retention = {
    days: Math.max(0, Number(readField(retentionRaw.days, 7)) || 0),
    cleanupIntervalMs: Math.max(60000, Number(readField(retentionRaw.cleanupIntervalMs, 6 * 3600 * 1000)) || 6 * 3600 * 1000),
  };
  // 媒体落地（§22.6 M14）：上游给的是会过期的 URL / 实现端本地路径，一律先落成 durable ref。
  const mediaRaw = readField(raw.media, {}) ?? {};
  cfg.media = {
    enabled: readField(mediaRaw.enabled, true) !== false,
    keepBytes: readField(mediaRaw.keepBytes, true) !== false,
    transcribe: readField(mediaRaw.transcribe, true) !== false,
    maxBytes: Math.max(64 * 1024, Number(readField(mediaRaw.maxBytes, 8 * 1024 * 1024)) || 8 * 1024 * 1024),
    fetchTimeoutMs: Math.max(200, Number(readField(mediaRaw.fetchTimeoutMs, 5000)) || 5000),
  };
  cfg.memoryLimit = Math.max(100, Number(readField(memoryRaw.limit, 5000)) || 5000);
  // 回合配对（§16.4 M6）：机械配对不需要开关，只有窗口与内存保留条数可调。
  const turnsRaw = readField(raw.turns, {}) ?? {};
  cfg.turns = {
    windowMs: Math.max(500, Number(readField(turnsRaw.windowMs, 8000)) || 8000),
    retain: Math.max(10, Number(readField(turnsRaw.retain, 400)) || 400),
  };
  // 用法学习（§17 M7）：阈值是"几次观测算数"，另两个是过时与删除的独立计数（§17.7）。
  const learnRaw = readField(raw.learn, {}) ?? {};
  cfg.learn = {
    threshold: Math.max(1, Number(readField(learnRaw.threshold, 3)) || 3),
    staleAfter: Math.max(1, Number(readField(learnRaw.staleAfter, 3)) || 3),
    forgetAfter: Math.max(2, Number(readField(learnRaw.forgetAfter, 6)) || 6),
    maxEvidence: Math.max(1, Number(readField(learnRaw.maxEvidence, 20)) || 20),
  };
  if (cfg.learn.forgetAfter < cfg.learn.staleAfter) cfg.learn.forgetAfter = cfg.learn.staleAfter;
  // 下游 bot 源码范围（M7-③，`m14112`/`m14477`）：多条，**不写进 prompt**，agent 需要时调工具取。
  const codeRaw = readField(raw.code, {}) ?? {};
  cfg.codeScopes = parseCodeScopes(readField(codeRaw.scopes, ''));
  // L2 会话卡落盘（§24.10）：重启不回放 L1，所以卡片单独存一份（只影响"记得多少"，不影响正确性）。
  const cardsRaw = readField(raw.cards, {}) ?? {};
  cfg.cards = {
    maxLines: Math.max(1, Number(readField(cardsRaw.maxLines, 40)) || 40),
    maxSessions: Math.max(1, Number(readField(cardsRaw.maxSessions, 200)) || 200),
  };
  // 成员名解析（§23.6）：只为"@到的人叫不出名字"这件事，问一次实现端就停（带冷却）。
  const membersRaw = readField(raw.members, {}) ?? {};
  cfg.members = {
    enabled: readField(membersRaw.enabled, true) !== false,
    cooldownMs: Math.max(0, Number(readField(membersRaw.cooldownMs, 6 * 60 * 60 * 1000)) || 0),
    maxPerMessage: Math.max(1, Number(readField(membersRaw.maxPerMessage, 5)) || 5),
    maxQueue: Math.max(1, Number(readField(membersRaw.maxQueue, 50)) || 50),
  };
  // 看图（M14-V）：`mode` 是唯一开关，两条路各自判断（详见 Config 里的注释）。
  const visionRaw = readField(raw.vision, {}) ?? {};
  cfg.vision = {
    mode: normalizeVisionMode(readField(visionRaw.mode, 'describe'), 'describe'),
    // 识图模型没有配置项：默认系统默认模型，`/vmodel` 做会话级覆盖（旧的 provider/model 已删）。
    prompt: readField(visionRaw.prompt, '') || undefined,
    system: readField(visionRaw.system, '') || undefined,
    // 0 = 不传 maxTokens 给上游（描述不做长度闸，m24155）；>0 才生效。
    maxTokens: (() => {
      const v = Number(readField(visionRaw.maxTokens, 0));
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    })(),
    timeoutMs: Math.max(1000, Number(readField(visionRaw.timeoutMs, 30000)) || 30000),
    cacheLimit: Math.max(1, Number(readField(visionRaw.cacheLimit, 500)) || 500),
  };
  // 人设（①）：种子预设只在这里解析一次，之后以 `persona/presets.json` 为准。
  const personaRaw = readField(raw.persona, {}) ?? {};
  cfg.persona = {
    enabled: readField(personaRaw.enabled, true) !== false,
    defaultName: String(readField(personaRaw.defaultName, 'default') ?? '') || 'default',
    presets: parseJsonValue(readField(personaRaw.presets, '[]'), []),
  };
  // 聊天命令（②）：**没配超管就是空的**（`ChatCommands.active` 会因此整条沉默）。
  const chatRaw = readField(raw.chatCommands, {}) ?? {};
  cfg.chatCommands = {
    enabled: readField(chatRaw.enabled, true) !== false,
    prefix: String(readField(chatRaw.prefix, '/') ?? ''),
    bypassPrefix: String(readField(chatRaw.bypassPrefix, '!!') ?? ''),
    superUsers: parseJsonValue(readField(chatRaw.superUsers, '[]'), []).map((v) => String(v)),
    maxReplyChars: Math.max(80, Number(readField(chatRaw.maxReplyChars, 800)) || 800),
  };
  // 表情包（④）：索引与图片固定落在 `<storageDir>/memes/`（跟着 storage 走，跨重启）。
  const memesRaw = readField(raw.memes, {}) ?? {};
  cfg.memes = {
    enabled: readField(memesRaw.enabled, true) !== false,
    topK: Math.max(1, Number(readField(memesRaw.topK, 8)) || 8),
    maxSend: Math.max(1, Number(readField(memesRaw.maxSend, 3)) || 3),
    autoCollect: readField(memesRaw.autoCollect, true) !== false,
  };
  // 二次元识别（⑥）：默认 `off`——没配后端时一次请求都不发。
  const animeRaw = readField(raw.anime, {}) ?? {};
  cfg.anime = {
    backend: normalizeAnimeBackend(readField(animeRaw.backend, 'off'), 'off'),
    recognizeUrl: String(readField(animeRaw.recognizeUrl, '') ?? ''),
    recognizeToken: String(readField(animeRaw.recognizeToken, '') ?? ''),
    animetraceUrl: String(readField(animeRaw.animetraceUrl, DEFAULT_ANIMETRACE_URL) ?? '') || DEFAULT_ANIMETRACE_URL,
    minConfidence: clamp01(readField(animeRaw.minConfidence, 0.85), 0.85),
    maxCharacters: Math.max(1, Number(readField(animeRaw.maxCharacters, 1)) || 1),
    nsfwThreshold: clamp01(readField(animeRaw.nsfwThreshold, 0.5), 0.5),
    timeoutMs: Math.max(1000, Number(readField(animeRaw.timeoutMs, 15000)) || 15000),
    cacheLimit: Math.max(1, Number(readField(animeRaw.cacheLimit, 500)) || 500),
  };
  // 生图（⑦）：`enabled` 只表示"愿意用"，真正的开关是 `ImageGen.enabled`（还要配全 baseUrl/apiKey）。
  const imageGenRaw = readField(raw.imageGen, {}) ?? {};
  cfg.imageGen = {
    enabled: readField(imageGenRaw.enabled, false) === true,
    model: String(readField(imageGenRaw.model, '') ?? ''),
    baseUrl: String(readField(imageGenRaw.baseUrl, '') ?? ''),
    apiKey: String(readField(imageGenRaw.apiKey, '') ?? ''),
    maxSize: String(readField(imageGenRaw.maxSize, '1024x1024') ?? ''),
    minSize: String(readField(imageGenRaw.minSize, '') ?? ''),
    watermark: readField(imageGenRaw.watermark, false) === true,
    timeoutMs: Math.max(1000, Number(readField(imageGenRaw.timeoutMs, 120000)) || 120000),
    maxPerTurn: Math.max(1, Number(readField(imageGenRaw.maxPerTurn, 1)) || 1),
  };
  // 主动回忆（§24.6 M18）：代码不判断"该提醒了"，只做两件事——给出事实、限制重复注入的频率。
  const remindersRaw = readField(memoryRaw.reminders, {}) ?? {};
  cfg.reminders = {
    enabled: readField(remindersRaw.enabled, true) !== false,
    windowHours: Math.max(0.02, Number(readField(remindersRaw.windowHours, 24)) || 24),
    limit: Math.max(1, Number(readField(remindersRaw.limit, 5)) || 5),
    max: Math.max(1, Number(readField(remindersRaw.max, 200)) || 200),
  };
  cfg.isolation = resolveIsolation({
    level: readField(isolationRaw.level, readField(raw.isolationLevel, undefined)),
    crossGroupIdentity: readField(isolationRaw.crossGroupIdentity, undefined),
    crossGroupFacts: readField(isolationRaw.crossGroupFacts, undefined),
    privateFacts: readField(isolationRaw.privateFacts, undefined),
    sensitivityAlwaysLocal: readField(isolationRaw.sensitivityAlwaysLocal, undefined),
    overrides: parseJsonValue(readField(isolationRaw.overrides, '[]'), []),
    trustedGroups: parseJsonValue(readField(isolationRaw.trustedGroups, '[]'), []),
    recallEscape: readField(isolationRaw.recallEscape, undefined),
    recallEscapeNeedsApproval: readField(isolationRaw.recallEscapeNeedsApproval, undefined),
    audit: readField(isolationRaw.audit, undefined),
    auditRetain: readField(isolationRaw.auditRetain, undefined),
  });
  // 别名：`Mind` 需要的是"这条链路上我自己是谁"，而 hub 用的是 upstreamSelfId。
  cfg.selfId = cfg.upstreamSelfId;
  cfg.nickname = cfg.upstreamNickname || undefined;
  return cfg;
}

function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

const TEXT_OUTPUT = { schema: { type: 'string' }, render: textRender };

/**
 * 把表情包 id 解析成"可以发出去的图片"（④§26）。
 *
 * 两件事在这里发生，顺序不能反：
 *  1. **只认库里真实存在的 id**——模型编造的 id 被丢掉并记一行日志。这是"不要编造 id"
 *     那条提示词约束的**执行侧**：光在提示词里写"不许编"是拦不住的。
 *  2. `noteUse()` 记账后立刻取 `pathOf()`，让"最近用过的"真的按发送次数排。
 */
/** 每轮生图额度账：键是 `<会话>#<轮次>`，只在内存里（限额只管这一轮）。 */
const imageGenUsed = new Map();

/**
 * 领一次"本轮生图额度"（`imageGen.maxPerTurn`）。
 *
 * 抽成纯函数是为了能被单独测：限额是**代码侧的硬边界**，不能只写在配置里。
 * @param {Map<string, number>} map 额度账
 * @param {string} key `<会话>#<轮次>`
 * @param {number} limit 本轮上限（≥1）
 * @returns {{ok:boolean, used:number, limit:number}}
 */
export function claimImageQuota(map, key, limit) {
  const cap = Math.max(1, Number(limit) || 1);
  const used = Number(map.get(key) ?? 0) || 0;
  if (used >= cap) return { ok: false, used, limit: cap };
  map.set(key, used + 1);
  return { ok: true, used: used + 1, limit: cap };
}

/**
 * 配置 UI 的"宿主侧体检"：浏览器半侧（`client.js`）到底有没有被宿主扫描到、会不会被服务出去。
 *
 * 纯诊断，用来区分设置页空白的两种可能：
 *   · 页面**根本没加载**（host 没扫到 `dsh.client`、没有 bundle 行）——看 `path`/`hubRows`；
 *   · 页面**加载了但渲染失败**（那一侧会自己把错误画在页面上）——这时 `path` 有值。
 * 读的是宿主 `clientModules` 服务；读不到就如实说读不到，不编。
 */
export function auditClientModules(ctx, id = 'dsh-onebot-hub') {
  const mod = ctx && typeof ctx.get === 'function' ? ctx.get('clientModules') : null;
  if (!mod) return { available: false, note: '宿主没有 clientModules 服务（非 web 组合？）' };
  const out = { available: true, id };
  try {
    out.path = typeof mod.clientPath === 'function' ? mod.clientPath(id) ?? null : null;
  } catch (err) {
    out.pathError = String(err?.message ?? err);
  }
  try {
    const graph = typeof mod.graph === 'function' ? mod.graph() : undefined;
    const rows = Array.isArray(graph)
      ? graph
      : Array.isArray(graph?.rows) ? graph.rows
        : Array.isArray(graph?.plugins) ? graph.plugins
          : Array.isArray(graph?.entries) ? graph.entries : [];
    out.rows = rows
      .map((row) => (typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.specifier ?? null))
      .filter((entry) => typeof entry === 'string' && entry.length > 0);
    out.hubRows = out.rows.filter((entry) => entry.toLowerCase().includes('onebot'));
  } catch (err) {
    out.graphError = String(err?.message ?? err);
  }
  try {
    const baseline = typeof mod.artifactBaseline === 'function' ? mod.artifactBaseline(id) : undefined;
    out.baseline = baseline === undefined || baseline === null ? null : typeof baseline === 'string' ? baseline : 'present';
  } catch (err) {
    out.baselineError = String(err?.message ?? err);
  }
  return out;
}

function resolveMemesForSend(hub, ids, log = () => {}) {  const out = [];
  // 一轮最多发几张（`memes.maxSend`）——模型列十个 id 就会刷十条图，硬上限在代码侧。
  const maxSend = Math.max(1, Number(hub?.config?.memes?.maxSend ?? 3) || 3);
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (out.length >= maxSend) {
      log(`表情包一次最多发 ${maxSend} 张，后面的已忽略`);
      break;
    }
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const item = hub?.memes?.get?.(id);
    if (!item) {
      log(`表情包 id 不存在，已忽略：${id}`);
      continue;
    }
    const file = hub.memes.pathOf(id);
    if (!file) {
      log(`表情包没有本地文件，已忽略：${id}`);
      continue;
    }
    hub.memes.noteUse(id);
    out.push({ id: item.id, file });
  }
  return out;
}

/** 会话作用域的回复工具：只写候选，由编排层在本轮 idle 后统一发出（§21.5）。 */
function makeReplyTool(reply, hub, log) {
  return defineTool({
    name: 'onebot_reply',
    description:
      '**唯一的发言出口**：把这一轮要说的话发到当前 OneBot 会话（一轮里后一次调用覆盖前一次）。' +
      '你写在普通回复文本里的内容只是内部草稿，宿主**不会**替你发出去——不调这个工具就是沉默；' +
      '它可以附图、带引用、发表情包，也可以**一次发多条消息**（见下）。' +
      '纯灌水、只有表情、或下游 bot 已经应答过的话题，就不要调。',
    parameters: REPLY_TOOL_PARAMS,
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      // 修1（真机事故：reply failed -1935986436）：`hub-media:<id>` 先解析成 blob 本地路径，
      // 解析不出来当场报错——"已排队回复"不能变成一句谎话（与直发版共用 resolveReplyImages）。
      const images = resolveReplyImages(hub, args.images);
      const memes = resolveMemesForSend(hub, args.memes, log);
      const missing = (Array.isArray(args.memes) ? args.memes : []).filter(
        (id) => !memes.some((m) => m.id === String(id ?? '').trim()),
      );
      if (!String(args.text ?? '').trim() && !images.length && !memes.length && !(Array.isArray(args.parts) && args.parts.length)) {
        throw new Error(
          missing.length
            ? `这些表情包 id 不存在：${missing.join('、')}；请改用上下文清单里的 id`
            : 'onebot_reply 需要 text、parts、images 或 memes',
        );
      }
      const candidate = reply.capture({
        text: args.text,
        parts: args.parts,
        images,
        memes,
        quote: args.quote_message_id,
      });
      if (!candidate) {
        // 什么都没排上：把"为什么"说清楚（编造的 id、解不出的 @ 段…），别让它以为发出去了。
        const plan = composeReply({ text: args.text, parts: args.parts, images, memes });
        const why = [...describePlanIssues(plan), ...(missing.length ? [`这些表情包 id 不存在：${missing.join('、')}`] : [])];
        throw new Error(why.length ? why.join('；') : 'onebot_reply 排出的内容全是空的，已忽略。');
      }
      // 回执要如实反映"这次排了几条、少发了几条"（§26 的老规矩）：模型必须知道拆成了什么。
      const lines = [`已排队回复：${describeReply(candidate)}`];
      if (candidate.messages.length > 1) {
        const kinds = candidate.messages.map((m, i) => `${i + 1}.${m.kind === 'image' ? '图' : '文字'}`).join(' ');
        lines.push(`拆成 ${candidate.messages.length} 条消息（${kinds}），按顺序隔一小段发。`);
      }
      if (missing.length) lines.push(`这些表情包 id 不存在，没有发送：${missing.join('、')}`);
      lines.push(...describePlanIssues({ dropped: candidate.dropped }));
      return lines.join('\n');
    },
  });
}

/**
 * 时间线条目的紧凑投影（`onebot_timeline` 用）。
 *
 * `labelOf` 由调用方注入：多下游时 `linkId` 只是一串 `down:host:port`，两条链路（真实/探针）
 * 长得几乎一样，agent 分不出"这是哪个 bot"（`m02768`）。`linkLabel` 是给人看的那份，
 * `linkId` 原样保留（过滤、对账都还要用）。
 */
function compactTimelineEntry(e, labelOf = null) {
  const label = typeof labelOf === 'function' && e?.linkId ? labelOf(e.linkId) : undefined;
  return {
    ts: new Date(e.ts).toISOString(),
    direction: e.direction,
    linkId: e.linkId,
    ...(label ? { linkLabel: label } : {}),
    kind: e.kind,
    sessionKey: e.sessionKey,
    conversationKey: e.conversationKey,
    actor: e.actor,
    action: e.action,
    decision: e.decision,
    text: e.text,
    refs: e.refs,
    // 原始报文的取件号（`onebot_raw` 用）：hub 只做"能自动做的那点解析"，
    // 认不出的段类型与故意不展开的聊天记录，都靠这个号回原文。
    rawRef: e.id,
  };
}

/**
 * 装配入口：只干两件事——开启动轨迹、把异常记进轨迹再原样抛出（`applyInner` 是真正的装配）。
 * @param {object} ctx DSH 宿主上下文（webServer / tools 已在 inject 中声明）
 * @param {object} rawConfig 插件配置
 */
export function apply(ctx, rawConfig) {
  // 装配一旦抛错，宿主只在插件列表上挂个红标、不落日志（`lib/startup-log.js` 的存在理由）。
  const startup = createStartupLog(resolveConfig(rawConfig).storageDir);
  startup?.reset();
  try {
    return applyInner(ctx, rawConfig, startup);
  } catch (err) {
    startup?.fail(err);
    throw err;
  }
}

/**
 * 装配枢纽：路由 + WS 链路 + agent 工具。
 * @param {object} ctx DSH 宿主上下文（webServer / tools 已在 inject 中声明）
 * @param {object} rawConfig 插件配置
 * @param {{note:(stage:string)=>void,fail:(err:unknown)=>void}|null} startup 启动轨迹（可为 null）
 */
function applyInner(ctx, rawConfig, startup) {
  const config = resolveConfig(rawConfig);
  startup?.note('config:ready');
  const log = (...args) => console.log('[dsh-onebot-hub]', ...args);

  /**
   * 配置改动怎么落地（配置 UI）。
   *
   * `Config` 的每个叶子字段都标了 `volatile`（设置页据此投影表单），代价是：**只改 volatile 字段**
   * 的保存走 Loader 的**热更新**通道——新值被提交进运行中的引用、发一个 `loader/volatile-update`，
   * 插件**不会**被重新 `apply`。而本插件的配置绝大多数是"建时生效"的（监听地址、上游账号、
   * 落盘目录、下游目标、各模块开关，乃至 `enabled` 本身），光把引用换掉不会改变已经装配好的东西。
   *
   * 所以这里主动要求一次**正常重挂**：`fiber.restart()` 会用当前 fiber 的配置重新激活插件
   * （新值此刻已经提交进去了，重新解析就拿到新配置），`apply()` 于是从头装配一遍——和用户手改
   * `cordis.patch.yml` 之后 Loader 的行为一致，不会出现"设置页点了保存但什么也没发生"。
   *
   * 这段**必须在 `enabled` 判断之前**注册：`enabled: false` 时 apply 提前返回，
   * 但用户在设置页里把开关重新打开时，仍然只有这个监听能把插件叫回来。
   * 失败只记日志——Loader 已保证"新值已提交、监听器抛错不影响更新"，
   * 最坏情况是这次改动等到下次重启才彻底生效，而不是配置被改坏。
   */
  const reloadForConfigChange = (paths) => {
    const fiber = ctx.fiber;
    const changed = Array.isArray(paths) ? paths.map((p) => (Array.isArray(p) ? p.join('.') : String(p))).join(', ') : '';
    try {
      if (typeof fiber?.restart === 'function') {
        // 首选直接用当前 fiber 的配置重启：新值此刻**已经**提交进 fiber 的引用里，
        // 重启时重新解析配置，于是 apply() 读到的是新配置。
        Promise.resolve(fiber.restart()).catch((err) => log(`配置已更新，但重挂失败（改动会在下次重启后生效）：${err?.message ?? err}`));
        log(`配置已更新 → 重新装配插件（${changed || '未知路径'}）`);
        return;
      }
      const raw = fiber?.entry?.options?.config;
      if (raw !== undefined && typeof fiber.update === 'function') {
        // 兜底：restart 不可用时，把 entry 上那份新原始配置交回去走正常更新流程。
        fiber.update(raw, true);
        log(`配置已更新 → 重新装配插件（${changed || '未知路径'}）`);
        return;
      }
      log(`配置已更新（${changed || '未知路径'}），但当前宿主没有可用的重挂入口；这次改动要等下次重启才彻底生效`);
    } catch (err) {
      log(`配置已更新，但重挂失败（改动会在下次重启后生效）：${err?.message ?? err}`);
    }
  };
  try {
    // 延迟一个任务再重挂：别在 Loader 正在派发这个事件的同一拍里把插件拆了。
    ctx.on?.('loader/volatile-update', (paths) => {
      setTimeout(() => reloadForConfigChange(paths), 0);
    });
  } catch {
    /* 老宿主没有这个事件：改动走普通的文件改动路径，本来就会重挂 */
  }

  if (!config.enabled) return;

  // ---- 浏览器半侧的自诊断通道（见 lib/client-probe.js）----
  // 设置页空白时唯一可靠的证据在浏览器控制台里，而宿主不落盘渲染进程日志。
  // 这里往 index 的 <head> 注入一段探针、并开一个同源上报路由，把错误送回进程内缓冲，
  // 于是 `onebot_hub_status.host.clientReports` 就能读到——不需要用户复制控制台。
  // 纯诊断：不落盘、不外发；宿主没有 webServer 时如实标 available:false。
  ctx.effect?.(() => {
    const probe = installClientProbe(ctx, { log });
    return () => {
      try {
        probe.dispose?.();
      } catch {
        /* 忽略：拆通道不该影响插件卸载 */
      }
    };
  });

  // ---- 设置页的模型清单通道（m024193，见 lib/llm-models.js）----
  // `agent.defaultModel` / `agent.defaultVisionModel` / 两个思考强度都改成从 DSH 的模型清单里选，
  // 而清单与 efforts 只有宿主 `llm` 服务知道（设置页在浏览器半侧，拿不到服务），所以开一条只读路由。
  // 拿不到 webServer 时如实降级（设置页退回手写，功能不受影响）；装机状态进 `onebot_hub_status.host.modelList`。
  const routeInfo = { modelList: null };
  ctx.effect?.(() => {
    const catalog = installModelListRoute(ctx, { log });
    routeInfo.modelList = catalog;
    if (!catalog.available && catalog.note) log(catalog.note);
    return () => {
      try {
        catalog.dispose?.();
        catalog.disposeLlm?.();
      } catch {
        /* 忽略 */
      }
    };
  });

  if (wsLib) useWs({ WebSocket: wsLib.WebSocket, WebSocketServer: wsLib.WebSocketServer });
  const hub = new Hub(config, { log });
  startup?.note('hub:ready');

  // ---- 人格与状态（①③§26）：人设、社交能量都是"每个会话一份"的活状态 ----
  // 顺序有讲究：先 `load()`（空库会自动补一个 default），再把配置里给的种子预设写进去。
  // 于是配置文件既能当"首次部署的初值"，又不会每次启动都覆盖聊天里改过的人设——
  // 落盘内容永远是权威，config 只是种子。
  const persona = new PersonaStore({ storage: hub.storage, log, defaultName: config.persona.defaultName });
  if (config.persona.enabled !== false) {
    persona.load();
    for (const preset of Array.isArray(config.persona.presets) ? config.persona.presets : []) {
      try {
        persona.save(preset);
      } catch (err) {
        log(`人设种子跳过（${JSON.stringify(preset)?.slice(0, 60)}）：${err?.message ?? err}`);
      }
    }
  }
  // ---- 看图的两条增强路（⑥⑦§26）：识别后端与生图 ----------
  // 都注入 `storage` 以便按 sha256 缓存；都用全局 fetch（宿主 Node 自带），
  // 后端不可达时只记一行日志，绝不影响转发主链路。
  const anime = new AnimeRecognizer({
    storage: hub.storage,
    log,
    backend: config.anime.backend,
    recognizeUrl: config.anime.recognizeUrl,
    recognizeToken: config.anime.recognizeToken,
    animetraceUrl: config.anime.animetraceUrl,
    minConfidence: config.anime.minConfidence,
    maxCharacters: config.anime.maxCharacters,
    nsfwThreshold: config.anime.nsfwThreshold,
    timeoutMs: config.anime.timeoutMs,
    cacheLimit: config.anime.cacheLimit,
  });
  const imageGen = new ImageGen({
    storage: hub.storage,
    log,
    enabled: config.imageGen.enabled,
    model: config.imageGen.model,
    baseUrl: config.imageGen.baseUrl,
    apiKey: config.imageGen.apiKey,
    maxSize: config.imageGen.maxSize,
    minSize: config.imageGen.minSize,
    watermark: config.imageGen.watermark,
    timeoutMs: config.imageGen.timeoutMs,
  });
  if (config.anime.backend !== 'off') log(`二次元识别后端：${config.anime.backend}`);
  if (imageGen.configured && config.imageGen.enabled) log(`生图已就绪：${imageGen.stats.baseUrl || '(默认)'}`);

  // ---- 表情包库（④§26）：索引与图片都落在 `<storageDir>/memes/`，跨重启跟着 storage 走 ----
  // 关掉时**不构造**：一个被禁用的模块不该占内存、更不该接 `collect` 的自动入库。
  const memes = config.memes.enabled === false ? null : new MemeStore({ storage: hub.storage, log });
  if (memes) log(`表情包库就绪：${memes.stats.count} 张（容量 ${memes.stats.capacity}）`);

  // ---- 会话级模型选择（§26）：聊天模型与识图模型都能按会话换（`/model`、`/vmodel`）----
  // 识图模型的默认值就是**系统默认模型**（请求里不指定 provider/model）；这里只存"哪个会话
  // 覆盖成了什么"，落盘在 `<storageDir>/sessions/models.json`。
  const sessionModels = new SessionModels({ storage: hub.storage, log });
  if (sessionModels.stats.sessions) {
    log(`会话级模型选择：${sessionModels.stats.sessions} 个会话有覆盖（聊天 ${sessionModels.stats.chat}、识图 ${sessionModels.stats.vision}）`);
  }

  // 后挂模块统一挂在 hub 上：`mind` 取人设装配上下文，`chatCommands` 拿它们执行命令，
  // 工具层（onebot_*）也按同一份引用读状态——只有一处真相。
  hub.persona = config.persona.enabled === false ? null : persona;
  hub.anime = anime.enabled ? anime : null;
  hub.imageGen = imageGen.enabled ? imageGen : null;
  hub.memes = memes;
  // 看图那条路要按会话取识图模型（`hub.js` 的 `#enrichImages` 读它）。
  hub.models = sessionModels;
  /** 宿主 `llm` 侧的能力（列清单、改活会话的模型选择）由 agent 通道补齐，没接上就如实降级。 */
  const modelControl = {
    /** @type {null | (() => Promise<Array>)} 宿主 `llm.listProviders()/listModels()` 的包装。 */
    list: null,
    /** 默认聊天路由（宿主 `agentDefaultModel.currentSelection()`）。 */
    defaultChat: null,
    /** 把某个会话的聊天模型**立刻**换到活着的 agent 上（改宿主认的那个可变 selection）。 */
    applyChat: null,
  };
  // `services` 是**活引用**：命令处理器读的永远是这个对象上的当前值。
  const commandServices = {
    hub,
    persona: hub.persona,
    memes: hub.memes,
    anime: hub.anime,
    imageGen: hub.imageGen,
    /**
     * 会话级模型选择（`/model`、`/vmodel`）：读走 `SessionModels`，写还要**同时**把活着的 agent
     * 一起改（宿主 `installModelSelection` 每轮读 `selection.current`，所以改它就是立即生效）。
     * 宿主 `llm` 没接上时 `list()` 回空数组、`applyChat` 为空——命令会如实说"宿主没给清单"。
     */
    models: {
      stats: () => sessionModels.stats,
      current: (sessionKey, kind) =>
        kind === 'vision'
          ? sessionModels.visionFor(sessionKey) ?? config.agentDefaultVisionModel
          : sessionModels.chatFor(sessionKey) ?? modelControl.defaultChat?.() ?? null,
      /** hub 配置里的默认路由（m024167）：`/model default` 复位回到的就是它；没配 = null。 */
      defaultRef: (kind) => (kind === 'vision' ? config.agentDefaultVisionModel : config.agentDefaultModel),
      list: () => (typeof modelControl.list === 'function' ? modelControl.list() : Promise.resolve([])),
      set: (sessionKey, kind, ref) => {
        const row = sessionModels.set(sessionKey, kind, ref);
        if (kind === 'chat') modelControl.applyChat?.(sessionKey, row.chat);
        return row;
      },
    },
  };
  const chatCommands = new ChatCommands({
    log,
    services: commandServices,
    config: {
      enabled: config.chatCommands.enabled,
      prefix: config.chatCommands.prefix,
      bypassPrefix: config.chatCommands.bypassPrefix,
      superUsers: config.chatCommands.superUsers,
      maxReplyChars: config.chatCommands.maxReplyChars,
    },
  });
  hub.chatCommands = chatCommands.active ? chatCommands : null;
  if (config.chatCommands.enabled && !chatCommands.active) {
    log('聊天命令未启用：chatCommands.superUsers 是空的（没人能用，也就不会吞任何消息）');
  }

  // ---- 记忆与编排（§21）：时间线在 hub 里，这里挂"观察 / 唤醒 / 回复" ----
  // 记忆条目**跨进程持久化**（§24.10）：落 `<storageDir>/memory/store.json`，
  // 与档案/L1/用法共用同一个 JsonStore（合并写，关存储时自动退化成纯内存）。
  const store = new MemoryStore({ limit: config.memoryLimit, storage: hub.storage, log });
  const audit = config.isolation.audit ? new IsolationAudit({ limit: config.isolation.auditRetain }) : null;
  const hostRef = { hasSession: null, create: null, resume: null, createUserMessage: null, unarchive: null, lastUnarchive: null, getLive: null, lastFork: null, retire: null, lastRetire: null };
  const pool = new AgentPool({ policy: config.agentPolicy, host: hostRef, log });
  const mind = new Mind({
    hub,
    timeline: hub.timeline,
    store,
    audit,
    isolation: config.isolation,
    policy: config.agentPolicy,
    pool,
    log,
    // 源码位置**不进这里**（`m14477`）：可能有很多条、还会变，agent 需要时调 onebot_code_scopes 取。
    guidance: config.agentGuidance || undefined,
    // L3 Capability 注入（§6.1）：每次装配现取，因为用法是边聊边学出来的。
    capabilities: () => hub.learn?.renderForPrompt?.({ limit: 5 }) ?? [],
    setup: (agentCtx, { reply, sessionKey, agentKey }) => {
      let promptOk = false;
      try {
        agentCtx.systemPrompt?.context?.({
          name: 'onebot-hub:reply',
          order: 110,
          text:
            `当前是 OneBot 会话 ${sessionKey}。**你这一轮写下的回复文本就是你在聊天里说的话**，` +
            '会直接发到聊天里；要发图片、指定引用、或分开多次发，用 onebot_reply。' +
            '判断这一轮不该开口（纯灌水、只有表情、下游 bot 已经应答过），就只写一句括号旁白（例如（不回复））或干脆不写。' +
            '注意：这个会话现在处于"跟人聊着"的**活跃**状态——你说完话之后它还会把后续消息继续送来；' +
            `**连续 ${AWAKE_SILENT_TURNS} 轮你都不开口**、或 ${Math.round((config.agentPolicy?.awakeMs ?? 300000) / 60000)} 分钟没有新消息，它就会回到休眠，` +
            '只在被点名时才再叫你。所以沉默是你结束一段对话的正常手段，不必每轮都硬找话。',
        });
        promptOk = true;
      } catch (err) {
        log(`systemPrompt.context 失败：${err?.message ?? err}`);
      }
      /**
       * **易变上下文的唯一入口**（用户定案，v4）：记忆 / cues / 人设 / 表情包清单这些
       * "状态"走**会话级 context section**、由宿主每次装配时现算
       * （`text` 是个函数——宿主 `sandbox:policy` 就是这么用的）。这样它进的是 system prompt，
       * **不进会话记录**：以前那种"每轮把这些整份塞进用户消息、于是转录里堆 N 份、窗口互相重叠"
       * 的重复就没了（`mind.liveContext` 里有详细注释）。
       * **v4（`m24409`）**：会话卡与最近窗口不再进这份快照（它们每来一条消息都变，宿主
       * append 不替换 ⇒ 整份重注）——"这段之前发生了什么"改由每段会话第一批的【开局快照】
       * 随批次 user message 注入一次（`Mind.#openingText`）。
       */
      try {
        agentCtx.systemPrompt?.context?.({
          name: 'onebot-hub:context',
          order: 100,
          text: () => mind.liveContext(sessionKey, { actorId: mind.activeActorId }),
        });
      } catch (err) {
        log(`systemPrompt.context（live 上下文）失败：${err?.message ?? err}`);
      }
      // 注册失败**不能静默**：没有这个工具，模型想说话也只能写普通文本，表现出来和"它自己选择沉默"一模一样。
      let toolRegistered = false;
      let toolError = null;
      try {
        if (typeof agentCtx.tools?.register === 'function') {
          agentCtx.tools.register(makeReplyTool(reply, hub, log));
          toolRegistered = true;
        } else {
          toolError = 'agentCtx.tools.register 不是函数';
        }
      } catch (err) {
        toolError = err?.message ?? String(err);
      }
      if (!toolRegistered) log(`回复工具注册失败：${toolError}`);
      // 会话账本的**第二条订阅**：root 级那条依赖事件是否冒泡，这里绑在会话作用域上做保底。
      // 两条都收到同一事件时由 `noteSessionEvent` 按 seq 去重（否则那句话会被发两遍）。
      let feedSubscribed = false;
      try {
        if (typeof agentCtx.on === 'function') {
          const off = agentCtx.on('session/event', (_session, event) => {
            mind.noteSessionEvent(agentKey, event);
          });
          if (typeof agentCtx.effect === 'function' && typeof off === 'function') agentCtx.effect(() => off);
          feedSubscribed = true;
        }
      } catch (err) {
        log(`会话作用域订阅 session/event 失败：${err?.message ?? err}`);
      }
      mind.noteSetup({
        sessionKey,
        hasToolsApi: Boolean(agentCtx.tools),
        hasPromptApi: typeof agentCtx.systemPrompt?.context === 'function',
        promptOk,
        toolRegistered,
        toolError,
        feedSubscribed,
      });
    },
  });
  startup?.note('mind:ready');
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.hooks.onDownstreamSend = (info) => mind.noteDownstreamSend(info);
  /**
   * 上游账号一学到就同步给"我是谁"的判定层（事故 #11）。
   *
   * 配置里 `upstreamSelfId` 可以留空（账号本就能从握手/事件里学到），而 `Mind` 的
   * `detectMention` 要拿**这个账号**去比对 at 段——不同步的话，被 @ 了也认不出来，
   * 表现是"群友 @ 了枢纽，枢纽一声不吭"（休眠态永不唤醒）。
   *
   * **昵称也要同步**（真机排查）：手打 `@真昵称` 那条路靠 `Mind.#nicknames`，而昵称是从
   * `get_login_info` / 能力探测里学的——只在"账号变化"时才通知编排层的话，账号早在握手里
   * 学到、昵称就永远学不到（实测 `agents.identity.nicknames: []`，手打昵称叫不醒）。
   */
  hub.hooks.onUpstreamAccount = ({ selfId, nickname }) => mind.setIdentity({ selfId, nickname });

  /**
   * 「枢纽 agent 的工具面」（`m02675`/`m02678` 用户定案）：默认只给本插件与这个会话真正会用到的
   * DSH 原生工具，第三方插件注册的工具（`task_board_*`、bili 的 `acp_*`/`compress`…）一律按需。
   *
   * 为什么用 `tools.restrict({ allow })`：宿主 `ScopedLayers.view` 里限制只遮 **global/祖先层**，
   * 作用域自己注册的工具不受影响——`onebot_reply` 正是逐会话 setup 里注册在 agent 作用域的那个
   * （own 层），所以它既不会被遮、**也不能写进 allow**（scope-local 名字会让 `restrict` 直接抛）。
   * 白名单只取 `agentCtx.tools.schemas()`（省略 scope ＝ 全局视图）里真实存在的名字，把
   * "未知名字"与"scope-local 名字"两种抛错一起避开。
   *
   * 放宽＝先 dispose 再按新的 allow 重挂（restrictions 是**相交**的，不 dispose 就再也松不开）。
   * 只在本次激活内有效：会话退役后 `agentCtx` 连同限制一起没了，下次激活回到默认白名单。
   */
  const toolFace = new Map(); // agentKey -> { ctx, dispose, allow }
  /** 默认额外保留的 DSH 原生工具（用户批准的那 11 个）。 */
  const SLIM_KEEP_EXTRA = [
    'read', 'grep', 'glob', 'read_image',
    'pwsh', 'job_list', 'job_kill', 'job_output',
    'web_search', 'web_fetch', 'todo_write',
  ];
  /**
   * `vision.mode` 里有没有 `segment`（`segment`/`both`）——也就是"图片本体作为内容段直接进对话"。
   * 没有它的时候看图**只有描述这一条路**（`m26571`），默认工具面里就不给 `read_image`：
   * 实测 agent 自己调了 28 次 `read_image` 去打开 blob，把"图片一律读描述"绕开了。
   * 想自己看它可以用 `onebot_tools` 显式把工具取回来——默认不给 ≠ 彻底没有。
   */
  const visionFeedsImages = () => {
    const mode = String(config?.vision?.mode ?? 'describe');
    return mode === 'segment' || mode === 'both';
  };
  const globalToolNames = (agentCtx) => {
    try {
      return (agentCtx?.tools?.schemas?.() ?? []).map((t) => String(t?.name ?? '')).filter(Boolean);
    } catch (err) {
      log(`读工具清单失败：${err?.message ?? err}`);
      return [];
    }
  };
  /** 默认白名单：本插件全部工具（`onebot_reply` 除外——它是 own 层）＋ 上面那 11 个常用原生工具
   *  （`vision.mode` 不含 segment 时去掉 `read_image`，见 `visionFeedsImages`）。 */
  const defaultToolAllow = (agentCtx) => {
    const known = new Set(globalToolNames(agentCtx));
    const mine = [...known].filter((n) => n.startsWith('onebot_') && n !== 'onebot_reply');
    const extra = visionFeedsImages() ? SLIM_KEEP_EXTRA : SLIM_KEEP_EXTRA.filter((n) => n !== 'read_image');
    return [...new Set([...mine, ...extra])].filter((n) => known.has(n));
  };
  const applyToolAllow = (agentKey, agentCtx, allow) => {
    const rec = toolFace.get(agentKey) ?? { ctx: agentCtx, dispose: null, allow: null, at: 0 };
    rec.ctx = agentCtx ?? rec.ctx;
    try {
      rec.dispose?.();
    } catch {
      /* 旧限制随会话没了就算了 */
    }
    rec.dispose = null;
    if (Array.isArray(allow) && allow.length) {
      const known = new Set(globalToolNames(rec.ctx));
      const list = [...new Set(allow.map(String))].filter((n) => known.has(n) && n !== 'onebot_reply');
      if (!list.length) throw new Error('allow 里没有一个可用的全局工具名（名字对不上？）');
      rec.dispose = rec.ctx.tools.restrict({ allow: list });
      rec.allow = list;
    } else {
      rec.allow = null; // null ＝ 不限制（全局工具全可见）
    }
    rec.at = Date.now();
    toolFace.set(agentKey, rec);
    return rec;
  };
  const toolFaceOf = (agentKey) => (agentKey ? toolFace.get(agentKey) ?? null : null);
  /** 逗号/空白分隔与 JSON 数组两种写法都收（模型两种都会用）。 */
  const parseToolNames = (value) => {
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) return arr.map(String).map((s) => s.trim()).filter(Boolean);
      } catch {
        /* 不是 JSON 就当分隔符列表处理 */
      }
    }
    return text.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  };

  /**
   * 「超管用命令给会话权限」（`m14477`）：`/perm` 的执行体。
   *
   * 为什么单独包一层：宿主里权限只能设在**已经存在的 `Session`** 上，而会话只有开过之后才存在；
   * 命令命中时那个会话可能还没被任何消息唤醒过（超管往往就是想"先给权限、再让它读下游源码"），
   * 所以要能**先把它建起来**——用 `mind.ensureAgent()`，走的是同一套 setup（回复工具等一个不少）。
   *
   * 三条诚实边界：服务拿不到就说拿不到；会话建不出来（agent 通道还没就绪）就说没就绪；
   * 预设名不是部署里有的就不改，把可选项列出来。这个命令**不动任何人自己会话的权限**，
   * 只改枢纽自建的那个 agent 会话。
   *
   * **权限故意不持久**（用户定案 `m33800`："每次会话给一次权限才安全"）：宿主把权限设在
   * `Session` 对象上，而 `964ddcf` 之后**每次激活都开一个全新会话**，所以下一次唤醒自然回到
   * 部署默认——正好符合"群里的权限是一次性的、醒一次收一次"。`.perm` 的回话里必须把这条说清楚。
   *
   * **真机 bug（`m33779`）**：这张表原来在 `perms` 的作用域外面，而真正在跑的会话 id 每次激活
   * 都带 `.a<时间戳><随机>` 后缀（`sessionIdOf`），于是 `sessions.get(无后缀 id)` 永远查不到，
   * `.perm <预设名>` 只会回"找不到它，改不了权限"。修法是把表提到外层，两边共用同一张。
   */
  const chosenSessionIds = new Map();
  /** 本次激活真正在跑的会话 id；还没激活过 = null（**不是**无后缀那个 id，那是历史遗留）。 */
  const liveSessionIdOf = (sessionKey) => chosenSessionIds.get(String(sessionKey)) ?? null;
  const perms = {
    services() {
      const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null;
      return {
        presets: get ? get('permissionPresets') ?? null : null,
        sessions: get ? get('sessions') ?? null : null,
      };
    },
    /** 部署里有哪些预设（`{value,label}`）；宿主没报就返回空数组，调用方负责说"没报"。 */
    options() {
      const { presets } = this.services();
      if (typeof presets?.catalog !== 'function') return [];
      try {
        const catalog = presets.catalog();
        return (catalog?.options ?? [])
          .map((option) => ({
            value: String(option?.value ?? option?.name ?? '').trim(),
            label: String(option?.label ?? option?.name ?? option?.value ?? '').trim(),
          }))
          .filter((option) => option.value);
      } catch (err) {
        log(`permissionPresets.catalog 失败：${err?.message ?? err}`);
        return [];
      }
    },
    /** 需要时把会话建起来；返回 `{session,created,id}` 或 `{error,id}`。 */
    async sessionFor(sessionKey) {
      const { sessions } = this.services();
      // 只认**本次激活**那个 id：权限设在 Session 对象上，而每次激活都是新会话，
      // 拿历史会话（无后缀那个 id 或上一轮带后缀的）去设，等于改了个没在跑的东西。
      let id = liveSessionIdOf(sessionKey);
      const found = id ? sessions?.get?.(id) : null;
      if (found) return { session: found, created: false, id };
      if (typeof hostRef.create !== 'function') {
        return { error: 'agent 通道还没就绪（宿主的 agents 服务还没接上），现在还建不了会话。', id: id ?? null };
      }
      await mind.ensureAgent(sessionKey);
      id = liveSessionIdOf(sessionKey);
      const after = id ? sessions?.get?.(id) ?? null : null;
      if (!after) {
        return {
          error:
            '会话建起来了，但拿不到它这次激活的 id（.a<时间戳> 后缀那张表里没有），改不了权限。' +
            '先在这个群聊一句让它醒一次，再敲权限命令。',
          id: id ?? null,
        };
      }
      return { session: after, created: true, id };
    },
    async describe({ sessionKey } = {}) {
      const { presets, sessions } = this.services();
      if (!presets || !sessions || typeof presets.set !== 'function') {
        return '这个部署没有权限预设服务（宿主没提供 permissionPresets / sessions），改不了会话权限。';
      }
      // 命令前缀可配：文案里一律用**当前配置的那个前缀**，不许写死 `/`（否则用户改了前缀，
      // 照回话敲的命令会被当成普通聊天）。
      const cmd = `${config.chatCommands?.prefix || '/'}perm`;
      const id = liveSessionIdOf(sessionKey);
      const current = id ? sessions.get?.(id) : null;
      const lines = [
        current && typeof presets.current === 'function'
          ? `本会话这次激活的 agent（${id}）权限预设：${presets.current(current)}`
          : '这个会话这次激活的 agent 还没建起来（没被唤醒过）：敲 ' +
            `${cmd} <预设名> 会顺手建，或先随便聊一句。`,
      ];
      const options = this.options();
      lines.push(`可用：${options.length ? options.map((option) => option.value).join(' / ') : '(宿主没报可选项)'}`);
      lines.push(`改：${cmd} <预设名>（只改枢纽自建的这个 agent 会话，不动你自己会话的权限）`);
      lines.push('注意：权限只对**这一次激活**有效——下次唤醒是全新会话，自动回到部署默认（故意的：一次授权一次用）。');
      return lines.join('\n');
    },
    async setPreset(name, { sessionKey } = {}) {
      const { presets, sessions } = this.services();
      if (!presets || typeof presets.set !== 'function' || !sessions) {
        return '这个部署没有权限预设服务（宿主没提供 permissionPresets / sessions），改不了会话权限。';
      }
      const wanted = String(name ?? '').trim();
      if (!wanted) return '用法：/perm <预设名>。';
      const options = this.options();
      const hit = options.find((option) => option.value === wanted) ?? options.find((option) => option.label === wanted);
      if (options.length && !hit) {
        return `没有「${wanted}」这个预设。可用：${options.map((option) => option.value).join(' / ')}。`;
      }
      const found = await this.sessionFor(sessionKey);
      if (found.error) return found.error;
      const value = hit?.value ?? wanted;
      try {
        presets.set(found.session, value);
      } catch (err) {
        return `设权限失败：${String(err?.message ?? err)}`;
      }
      const after = typeof presets.current === 'function' ? presets.current(found.session) : value;
      log(`会话权限：${found.id} → ${value}${after && after !== value ? `（宿主报回来的是 ${after}）` : ''}`);
      return (
        `已把本会话这次激活的 agent 权限设为 ${after || value}` +
        `${found.created ? '（顺带把 agent 会话建起来了）' : ''}。` +
        '只对这一次激活有效：下次唤醒是新会话、自动回到部署默认。' +
        '读下游源码用你自己的工具，权限不够就如实说。'
      );
    },
  };
  commandServices.perms = perms;

  ctx.effect(() => {
    const timer = setInterval(() => {
      void mind.tick().catch((err) => log(`tick 失败：${err?.message ?? err}`));
    }, config.agentTickMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-onebot-hub: mind tick');

  // ---- 会话账本（§21.8）：宿主 agent 这一轮到底产出了什么，必须看得见 ----
  // `session/event` 是 post-commit 的追加 feed（`(session, event) => …`）。订阅它有两个理由：
  //  1. 诊断：`whenIdle()` 只保证驱动器安静，回合内的模型错误被 `kick()` 的 catch 吞掉，
  //     会话文件又要等关闭才落盘——没有这个 feed，"叫醒了却不说话"无法归因。
  //  2. 文本兜底（默认关，`m30383`：发言只走 onebot_reply 工具）：`agent.speakAssistantText=true`
  //     的逃生门要靠这个 feed 才能拿到模型的收尾文本。
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {};
    const onSessionEvent = (session, event) => {
      const id = String(session?.id ?? '');
      if (!id.startsWith(SESSION_ID_PREFIX)) return;
      const agentKey = decodeURIComponent(id.slice(SESSION_ID_PREFIX.length));
      try {
        mind.noteSessionEvent(agentKey, event);
      } catch (err) {
        log(`会话账本记录失败 ${agentKey}：${err?.message ?? err}`);
      }
    };
    return ctx.on('session/event', onSessionEvent);
  }, 'dsh-onebot-hub: session ledger');

  ctx.effect(() => {
    // 下游接入端不再挂在宿主 webServer 上：`ws-listen` / `http-api` 型目标各自带着自己的
    // 地址（host:port/path），由 hub 真的在那个端口上监听（§19）。这样配置里写的端口就是
    // 真在听的端口，也不需要宿主提供 webServer。
    startup?.note('links:connecting');
    hub.connectUpstream();
    hub.connectDownstreams();
    // 启动清理（m30859）：会话卡里"发送失败却记成发言"的历史行（真机：failed 的回复
    // 以"我：…"落了盘）。要等 recall 的磁盘账本载入才能按条目 id 反查裁决，所以异步跑。
    void (async () => {
      try {
        const pruned = await hub.purgeFailedSends();
        if (pruned) log(`会话卡清理：删掉 ${pruned} 行发送失败的消息（发送失败的不算说过的话）`);
      } catch (err) {
        log(`会话卡清理失败（不影响运行）：${err?.message ?? err}`);
      }
    })();
    // 身份补全：配置里没写昵称（@我 要靠它匹配）或没写账号时，等上游连上后问一次
    // `get_login_info`。账号这一路还会喂给 hub（`learnUpstreamAccount`）——它是"下游目标不写
    // 对方账号 = 与上游相同"那条规则的数据来源；上游一直不来事件时，这是唯一能补上账号的路。
    let identityProbe = null;
    if (!config.upstreamSelfId || !config.upstreamNickname) {
      let attempts = 0;
      identityProbe = setInterval(() => {
        attempts += 1;
        void (async () => {
          try {
            if (!hub.upstream?.isConnected) {
              if (attempts >= 20) clearInterval(identityProbe);
              return;
            }
            const envelope = await hub.callUpstream('get_login_info', {}, 5000);
            // `callUpstream` 返回的是**信封**（`{status, retcode, data, echo}`），字段在 `data` 里。
            // 以前这里直接读 `info.user_id` → 恒 undefined → 整段被跳过：账号靠握手学到了，
            // **真昵称却永远没学到**（`Mind.#nicknames` 空集 → 手打 `@真昵称` 叫不醒）。
            const info = envelope?.data ?? null;
            if (info?.user_id) {
              hub.learnUpstreamAccount(info.user_id, 'get_login_info', info.nickname);
              /**
               * **无条件喂给 `Mind`**（事故 #11）：以前这里写着 `if (!config.upstreamNickname)`，
               * 于是"配置里写了备注名"就成了不再学真昵称的理由——而群里人 @ 的是**真昵称**，
               * 不是我们内部起的备注名。两个名字都留着才叫"听得见"（`setIdentity` 是累加的）。
               */
              mind.setIdentity({ selfId: String(info.user_id), nickname: info.nickname });
            }
            clearInterval(identityProbe);
          } catch {
            if (attempts >= 20) clearInterval(identityProbe);
          }
        })();
      }, 3000);
      identityProbe.unref?.();
    }
    const enabledTargets = config.downstreamTargets.filter((target) => target.enabled !== false);
    log(
      `枢纽已启动：下游目标 ${enabledTargets.length}/${config.downstreamTargets.length} 条（${
        enabledTargets.map((t) => `${t.type}:${t.id}→${t.url}`).join('、') || '无'
      }），上游 ${config.upstreamUrl || '(未配置)'}，预设 ${config.preset}`,
    );
    // 下游源码范围（`m14112`/`m14477`）：**不写进 prompt**，agent 需要时调 onebot_code_scopes 取。
    if (config.codeScopes?.length) {
      log(
        `下游源码范围 ${config.codeScopes.length} 条（不写进 prompt；agent 需要时用 onebot_code_scopes 取）：` +
          describeCodeScopes(config.codeScopes).join('、'),
      );
    }
    return () => {
      if (identityProbe) clearInterval(identityProbe);
      hub.stop();
    };
  }, 'dsh-onebot-hub: links');

  ctx.effect(() => {
    const disposers = [];

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_hub_status',
          description:
            '查看 OneBot 枢纽的实时状态：策略预设、上游链路连接情况、每条下游链路（self_id/角色/昵称/连接状态、`downstreamId` 逻辑下游分组、`probeOnly` 探针专用标记、**`label` 人话名字**）、时间线与捕获计数、防环统计，' +
            '`probe` 段是探针隔离现状（`isolation` 是**生效**档位、`requested` 是配置里写的那档、`note` 说明回退原因；探针链路、活跃窗口还压着几条、累计 held/released 计数），' +
            '以及 agent 的睡/醒状态（`agents.wakeStates`：休眠/激活、激活多久、连续几轮没说话；`agents.lastObserve`：最近一条消息为什么醒/为什么没醒，含 `mentions`/`atTargets`/`selfId`/`nicknames`；`agents.identity`：@ 匹配时"我是谁"）。排查"消息为什么没到下游"时先看它。',
          parameters: {},
          output: TEXT_OUTPUT,
          async execute() {
            return JSON.stringify(
              {
                ...hub.status(),
                agents: mind.statsSnapshot,
                agentPolicy: describeAgentPolicy(config.agentPolicy),
                host: {
                  unarchiveAvailable: typeof hostRef.unarchive === 'function',
                  lastUnarchive: hostRef.lastUnarchive ?? null,
                  liveLookupAvailable: typeof hostRef.getLive === 'function',
                  lastFork: hostRef.lastFork ?? null,
                  lastTitle: hostRef.lastTitle ?? null,
                  lastRetire: hostRef.lastRetire ?? null,
                  clientModules: auditClientModules(ctx),
                  clientReports: clientReportStatus(),
                  modelList: {
                    path: MODEL_LIST_PATH,
                    available: routeInfo.modelList?.available === true,
                    note: String(routeInfo.modelList?.note ?? ''),
                    noteText: '设置页模型下拉的数据源；available:false 时设置页退回手写 provider/model 与文本填思考强度。',
                  },
                },
                memory: store.stats,
                isolation: describeIsolation(config.isolation),
                code: {
                  scopes: config.codeScopes ?? [],
                  note: 'scopes 是超管填的"下游源码在哪"（多条）；它**不进 prompt**，agent 需要时调 onebot_code_scopes 取。读文件用的是 agent 自带的工具与超管给的权限，枢纽不代管。',
                },
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    // 下游源码范围（`m14477`）：**地址不进 prompt**，agent 需要时调这个工具取。
    // 它只回答"在哪"，**不读文件**——读文件是 agent 自己的 read/grep/glob 与它自己的权限。
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_code_scopes',
          description:
            '列出"下游 bot 的源码在哪"：超管在 code.scopes 里填的源码范围（可以有多条，对应多个下游）。只回答位置，不读文件；读文件请用你自己的 read/grep/glob，权限不够就如实说"没权限读"，不要绕路，也不要改下游的文件。',
          parameters: {},
          output: TEXT_OUTPUT,
          async execute() {
            const scopes = Array.isArray(config.codeScopes) ? config.codeScopes : [];
            if (!scopes.length) {
              return JSON.stringify(
                {
                  ok: true,
                  count: 0,
                  scopes: [],
                  note: '超管还没在 code.scopes 里配"下游源码在哪"。要位置就去问超管，别猜路径，也别去翻别的目录。',
                },
                null,
                2,
              );
            }
            const fs = await import('node:fs');
            const rows = scopes.map((scope) => {
              const row = { name: scope.name || null, path: scope.path };
              try {
                const st = fs.statSync(scope.path);
                row.exists = true;
                row.kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
              } catch (err) {
                // 路径不存在（或连 stat 都被挡住）：如实报，别替超管猜一个"大概在这儿"。
                row.exists = false;
                row.kind = 'missing';
                row.error = String(err?.code ?? err?.message ?? err);
              }
              return row;
            });
            return JSON.stringify(
              {
                ok: true,
                count: rows.length,
                scopes: rows,
                note: '这些就是可以读的范围。读文件用你自己的工具（read/grep/glob）；权限不够就如实说"没权限读"，不要绕路，也不要改下游的文件。',
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_timeline',
          description:
            '读取 OneBot 全量消息时间线（上游入站/下游出站/下游插件动作）。枢纽在协议层，默认记录所有消息，这是"得知所有消息"的入口。可按会话、链路、方向、类型过滤。',
          parameters: {
            limit: { type: 'integer', description: '返回条数，默认 30，最大 200。' },
            sessionKey: { type: 'string', description: '会话键，如 group:55555 或 private:10001。' },
            linkId: { type: 'string', description: '链路 id，如 down:30001000 或 up:ws://...' },
            direction: {
              type: 'string',
              description: 'upstream-in | downstream-in | downstream-out | hub-out | hub-in',
            },
            kind: { type: 'string', description: 'group_message | private_message | notice | request | action' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const limit = Math.min(Number(args.limit ?? 30) || 30, 200);
            const entries = hub.timeline.recent(limit, {
              sessionKey: args.sessionKey,
              linkId: args.linkId,
              direction: args.direction,
              kind: args.kind,
            });
            return JSON.stringify({ count: entries.length, entries: entries.map((e) => compactTimelineEntry(e, (linkId) => hub.labelOf(linkId))) }, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_capture',
          description:
            '查看下游 bot 的插件实际调用过哪些 OneBot action（含 send_msg 的内容与目标）。这是学习下游用法的原始证据：用户发了什么、下游回了什么，成对出现。',
          parameters: {
            limit: { type: 'integer', description: '返回条数，默认 30，最大 200。' },
            action: { type: 'string', description: '只看某个 action，如 send_msg。' },
            linkId: { type: 'string', description: '只看某条下游链路，如 down:30001000。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const limit = Math.min(Number(args.limit ?? 30) || 30, 200);
            const entries = hub.capture.list({ limit, action: args.action, linkId: args.linkId });
            return JSON.stringify({ stats: hub.capture.stats, count: entries.length, entries }, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_invoke',
          description:
            '控制下游 bot。默认 mode=event：向目标下游链路注入一条消息事件——等于"以某个身份向下游说一句话/发一条命令"，会真实触发它的 matcher（等价于 aigfm 的 invoke_peer_plugin，但走协议层，事件是真的）。mode=action 则向**实现端型**下游链路发一个 OneBot action 请求。这也是验证"某条命令到底能不能触发这个下游插件"的探针。'
            + '以谁的身份说由 `user_id` 决定（默认 hub 的上游账号）——想试"只有某个账号能触发的命令/权限判断"就换成他的账号。'
            + '**换 `user_id` 常常就是换结果**：下游大多按说话人做权限判断（超管/管理员/黑名单）、冷却、以及用户级状态'
            + '（积分、开关、绑定、好感度、正在进行的对话），同一句话这个账号能触发、那个账号可能被拒、或者被当成另一个人。'
            + '所以"这条命令行不行"的结论只对**你用的那个账号**成立：要验证某人的体验，就用**他的账号**再试一次，'
            + '别拿默认账号的结果当成所有人的结果。'
            + '**注入走哪条链路由枢纽决定，不由你选**（`m02768`）：你只用 `downstream` 说明"要问哪个下游"，'
            + '探针链路（另一个账号、收不到群里的真人消息）还是真实链路按 `probe.isolation` 自动选——'
            + '所以别去点物理链路名；真要点真实链路得显式 `allow_real_link: true`，结果里会写明"本次未隔离"。'
            + (config.probe?.isolation === 'link' && hasProbeLink(config)
              ? ' 注意：当前是**链路隔离**，注入走的是专用探针链路（另一个账号），它收不到真人消息、状态也可能与真实链路不同——**执行结果可能与用户触发时不同**，别当成群里真实发生过的事。'
                + '**记账里的账号与这里指定的 `user_id` 对不上是正常的**：探针链路的收发都记在**它自己的 bot 账号**名下，'
                + '所以事后在 onebot_capture / onebot_turns 里看到的 `user_id`/`self_id` 不是你指定的说话人——那是链路账号，别当成出错或当成"有人冒名"。'
              : ''),
          parameters: {
            downstream: {
              type: 'string',
              description:
                'event 模式：要问哪个**下游**（逻辑下游名 / 备注名 / 对方账号 / 目标键，如 `probe-bot` 或 `127.0.0.1:8080`；'
                + '缺省 = 只有一条下游时就用它，多条才要求点名）。**不要填物理链路**——探针还是真实由枢纽按 `probe.isolation` 决定。',
            },
            allow_real_link: {
              type: 'boolean',
              description:
                'event 模式：默认 false。链路隔离开着时置 true = **故意**把注入打到真实链路上'
                + '（产物可能与真人消息混在一起、直接进群，隔离不生效）；结果里会带 `notIsolated` 说明。',
            },
            linkId: {
              type: 'string',
              description:
                '**mode=action 专用**：向哪条下游链路发这个 action（只对实现端型链路有效）。event 模式**别填**它——'
                + '给了也只会被当成"要问哪个下游"，物理链路由枢纽决定。',
            },
            mode: {
              type: 'string',
              description: "event（默认）向下游注入消息事件；action 向实现端型链路发 action 请求。",
            },
            text: { type: 'string', description: 'event 模式：消息文本（纯文本自动做 CQ 转义）。与 message 二选一。' },
            message: {
              type: 'string',
              description:
                'event 模式：完整消息段数组的 JSON，如 [{"type":"at","data":{"qq":"30001000"}},{"type":"text","data":{"text":"/probe hi"}}]。优先于 text。',
            },
            message_type: { type: 'string', description: 'event 模式：group 或 private，默认按是否给 group_id 推断。' },
            group_id: { type: 'string', description: 'event 模式：群号。' },
            user_id: {
              type: 'string',
              description:
                'event 模式：说话人账号（QQ 号，字符串）。不写 = hub 的上游账号。**换账号就是换说话人**——' +
                '下游按账号做的权限/冷却/用户级状态都会跟着变，同一句话可能一个账号能触发、另一个不能。',
            },
            quote_message_id: {
              type: 'string',
              description: 'event 模式：给消息加一个 reply 段（用于测试"必须先回复才触发"的命令）。',
            },
            action: { type: 'string', description: 'action 模式：OneBot action 名。' },
            params: { type: 'string', description: 'action 模式：JSON 对象形式的参数。' },
            timeoutMs: { type: 'integer', description: 'action 模式：等待超时，默认 30000。' },
            session_key: {
              type: 'string',
              description:
                '可选：这一轮所在的 OneBot 会话（如 group:55555）。填了它只是把"这次代调属于哪个会话"讲清楚，' +
                '不参与任何准入判定。',
            },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const mode = args.mode ?? (args.action ? 'action' : 'event');
            if (mode === 'action') {
              const params = typeof args.params === 'string' ? parseJsonObject(args.params, {}) : (args.params ?? {});
              const result = await hub.invokeDownstream(args.linkId, args.action ?? 'send_msg', params, args.timeoutMs);
              return JSON.stringify(result, null, 2);
            }
            const message = parseJsonValue(args.message, null);
            const result = hub.sendMessageToDownstream({
              // 旧名 `linkId` 也接受，但只当作"要问哪个下游"——物理链路一律由枢纽选（m02768）。
              downstream: args.downstream ?? args.linkId,
              allowRealLink: args.allow_real_link === true,
              message: Array.isArray(message) ? message : undefined,
              text: args.text,
              message_type: args.message_type,
              group_id: args.group_id,
              user_id: args.user_id,
              quote_message_id: args.quote_message_id,
            });
            return JSON.stringify(result, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_reply',
          description:
            '用枢纽自己的 bot 身份向上游发送消息（发到群里或私聊）。注意：如果下游 bot 已经应答过这条消息，按"命令静默"约定不要再用本工具插话。' +
            '一次调用可以发多条消息：每张图各自一条，文字与 @ 各聚一条，`break` 或文本里的空行强制断开；' +
            '条与条之间有固定间隔，第 k 条失败即停（剩下的不发）。',
          parameters: {
            ...REPLY_TOOL_PARAMS,
            message_type: { type: 'string', description: 'group 或 private。' },
            group_id: { type: 'string', description: 'group 时必填。' },
            user_id: { type: 'string', description: 'private 时必填。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            // 直发版与会话缓冲版**同一套拆条**（m32420）：同一件事两条路径行为必须一致。
            const askedMemes = Array.isArray(args.memes) ? args.memes : [];
            const resolvedMemes = resolveMemesForSend(hub, askedMemes, log);
            const missing = askedMemes
              .map((id) => String(id ?? '').trim())
              .filter((id) => id && !resolvedMemes.some((m) => m.id === id));
            // 修1：直发版同样吃 hub-media 引用（工具面里它就是"onebot_reply"，模型不分两份）。
            const images = resolveReplyImages(hub, args.images);
            const plan = composeReply({
              text: args.text,
              parts: args.parts,
              images,
              memes: resolvedMemes,
              quote: args.quote_message_id,
              maxText: Number(hub?.config?.replyMaxText ?? 3),
              maxImages: Number(hub?.config?.replyMaxImages ?? 9),
            });
            if (!plan.messages.length) {
              // "编造 id 被丢掉"必须说出来：静默失败会让模型以为已经发出去了（§26）。
              const why = [...describePlanIssues(plan), ...(missing.length ? [`这些表情包 id 不存在：${missing.join('、')}`] : [])];
              throw new Error(
                why.length ? why.join('；') : 'onebot_reply 需要 text、parts、images 或 memes',
              );
            }
            const type = args.message_type ?? (args.group_id ? 'group' : 'private');
            const gapMs = Math.max(0, Number(hub?.config?.replyGapMs ?? 400) || 0);
            const sent = [];
            let failure = null;
            for (const [i, msg] of plan.messages.entries()) {
              if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
              const frame = hub.buildMessageFrame({
                message: msg.segments,
                message_type: type,
                group_id: args.group_id,
                user_id: args.user_id,
              });
              const result = await hub.callUpstream(frame.action, frame.params);
              sent.push({ index: i + 1, kind: msg.kind, text: msg.text, status: result?.status ?? null, retcode: result?.retcode ?? null });
              // 第 k 条失败即停（m32420）：剩下几条根本没发，不能让它以为整段都说完了。
              if (result?.status !== 'ok') {
                failure = { index: i + 1, ...result, rest: plan.messages.length - i - 1 };
                break;
              }
            }
            return JSON.stringify(
              {
                sent: sent.length,
                total: plan.messages.length,
                messages: sent,
                dropped: plan.dropped,
                issues: describePlanIssues(plan),
                ...(missing.length ? { missingMemeIds: missing } : {}),
                ...(failure
                  ? { stopped: `第 ${failure.index}/${plan.messages.length} 条发送失败，剩下 ${failure.rest} 条未发送`, failure }
                  : {}),
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    // ---------------- 能力面（§22 需求 2）：通用通道 + 类型化封装 ----------------
    // 所有只读查询都经 `hub.callAction`（分级闸门 → TTL 缓存 → 上游真答），
    // 返回统一形状 `{ ok, retcode, data, source, note }`：source 让 agent 知道这是
    // 实时值还是缓存值（"我刚看了下"和"我记得"不是一回事）。
    const capCall = (action, params = {}, opts = {}) =>
      hub.callAction({
        action,
        params,
        timeoutMs: opts.timeoutMs,
        refresh: opts.refresh === true,
        source: opts.source ?? 'agent',
      });
    const capJson = (value) => JSON.stringify(value, null, 2);
    /** 当前轮次所在会话：工具总是在某一轮里被调用，mind 记着那一轮的会话键。 */
    const inferSessionKey = () => mind.activeSessionKey ?? mind.stats?.lastTurn?.sessionKey ?? '';
    /** 这一轮在跟谁说话：该会话最后一条**入站**消息的说话人（hub 自己发的不算）。 */
    const actorOf = (entries) => {
      for (const e of entries) {
        if (e?.direction === 'upstream-in' && e.actor?.user_id) return String(e.actor.user_id);
      }
      return '';
    };
    const pick = (args, keys) => {
      const out = {};
      for (const key of keys) {
        const value = args?.[key];
        if (value !== undefined && value !== null && value !== '') out[key] = value;
      }
      return out;
    };

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_call',
          description:
            '通用 OneBot v11 action 通道：问上游真实现端任何 action（协议层原语，不经过下游）。只读查询有 TTL 缓存与中文 retcode 说明；' +
            'write/danger 级 action 默认被策略拒绝（需在插件配置 capability.writeAllow / dangerAllow 显式放行）。' +
            '不确定某个 action 能不能用时先 onebot_caps 看实测结论，别靠猜。',
          parameters: {
            action: { type: 'string', description: 'OneBot action 名，如 get_group_info、get_msg、send_like。' },
            params: { type: 'string', description: 'JSON 对象形式的参数，如 {"group_id":617770183}。' },
            refresh: { type: 'boolean', description: '忽略缓存强制取实时值，默认 false。' },
            timeoutMs: { type: 'integer', description: '等待超时毫秒，默认取配置 capability.callTimeoutMs。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const action = String(args.action ?? '').trim();
            if (!action) throw new Error('onebot_call 需要 action');
            const params = typeof args.params === 'string' ? parseJsonObject(args.params, {}) : (args.params ?? {});
            return capJson(await capCall(action, params, { refresh: args.refresh, timeoutMs: args.timeoutMs }));
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_admin',
          description:
            '群管理动作（踢人/禁言/全员禁言/管理员/退群/改名片/改群名/撤回/点赞/头衔/处理加好友与加群请求）的结构化入口。' +
            `可用 op：${ADMIN_OP_NAMES.join('、')}。` +
            '两段式：先**不带** confirm 调一次做预演（不下发任何字节），它会说明将要发生什么、以及当前策略会不会拦；确认后带 confirm=true 才真发。' +
            '写操作默认被策略拒绝（需 capability.writeAllow / dangerAllow 放行）——本工具不能绕过闸门。',
          parameters: {
            op: { type: 'string', description: `管理动作名：${ADMIN_OP_NAMES.join('、')}。` },
            params: {
              type: 'string',
              description: 'JSON 对象形式的参数，如 {"group_id":617770183,"user_id":945126014,"duration":600}。各 op 必需的字段见描述。',
            },
            confirm: { type: 'boolean', description: 'true 才真正下发；缺省或 false 只预演。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const op = String(args.op ?? '').trim();
            if (!op) throw new Error(`onebot_admin 需要 op（可用：${ADMIN_OP_NAMES.join('、')}）`);
            const raw = typeof args.params === 'string' ? parseJsonObject(args.params, {}) : (args.params ?? {});
            const plan = planAdminOp(op, raw);
            if (!plan.ok) throw new Error(plan.error);
            const gate = hub.previewAction(plan.action);
            const body = {
              op: plan.op,
              action: plan.action,
              params: plan.params,
              willDo: plan.describe,
              irreversible: plan.irreversible,
              gate,
            };
            if (args.confirm !== true) {
              return capJson({
                dryRun: true,
                ...body,
                hint: gate.allowed
                  ? '策略已放行，确认无误后带 confirm=true 再调一次（这次调用没有下发任何字节）'
                  : `当前策略会拦下它：${gate.note}（这次调用没有下发任何字节）`,
              });
            }
            const result = await capCall(plan.action, plan.params, { source: 'agent:admin' });
            return capJson({ dryRun: false, ...body, result });
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_caps',
          description:
            '查看上游实现端的能力现状：实现端名称/版本/协议/登录账号、哪些 action 实测可用（supported）、哪些实测不支持（unsupported）、' +
            '缓存命中情况、闸门设置与落盘情况（storage）。结论全部来自实测调用记录，unknown 只表示"还没试过"，不代表不支持。' +
            'refresh=true 会重新探测实现端身份；reset=true 会清空实测结论（实现端换了或升级了时用）；flush=true 立刻把结论落盘。',
          parameters: {
            refresh: { type: 'boolean', description: '重新探测上游实现端身份（get_version_info 等），默认 false。' },
            reset: { type: 'boolean', description: '清空实测能力结论与探测历史（不删落盘文件，随后会被新结论覆盖），默认 false。' },
            flush: { type: 'boolean', description: '立刻把能力结论与只读缓存落盘（默认是防抖合并写），默认 false。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            if (args.reset === true) {
              const cleared = hub.capabilities.reset();
              hub.cache.invalidate();
              hub.flushStorage();
              return capJson({ reset: true, clearedActions: cleared, ...hub.capabilitiesSnapshot() });
            }
            if (args.refresh === true) await hub.probeCapabilities({ timeoutMs: config.capability?.probeTimeoutMs });
            if (args.flush === true) hub.flushStorage();
            return capJson(hub.capabilitiesSnapshot());
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_profile',
          description:
            '看"人"：hub 自己是谁（self，即上游登录账号）、某个陌生人/好友的资料（user_id）、好友列表（friends）。' +
            '这些都是只读查询，走缓存。',
          parameters: {
            user_id: { type: 'string', description: '要查的账号（get_stranger_info）。' },
            friends: { type: 'boolean', description: '是否带出好友列表（get_friend_list），默认 false。' },
            self: { type: 'boolean', description: '是否带出 hub 自己的登录信息（get_login_info），默认 true。' },
            refresh: { type: 'boolean', description: '忽略缓存，默认 false。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const out = {};
            if (args.self !== false) out.self = await capCall('get_login_info', {}, { refresh: args.refresh });
            if (args.user_id) out.user = await capCall('get_stranger_info', pick(args, ['user_id']), { refresh: args.refresh });
            if (args.friends === true) out.friends = await capCall('get_friend_list', {}, { refresh: args.refresh });
            return capJson(out);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_group',
          description:
            '看"群"：群资料（group_id）、荣誉/龙王（honor 指定类型）、群公告（notices，扩展 action `_get_group_notice`，' +
            '不是标准接口，实现端不支持时返回 note）、或已加入的群列表（list=true）。只读。',
          parameters: {
            group_id: { type: 'string', description: '群号；list=true 时可省略。' },
            list: { type: 'boolean', description: '是否列出机器人加入的群（get_group_list），默认 false。' },
            honor: { type: 'string', description: '群荣誉类型，如 talkative / performer / legend / strong_newbie / emotion / all。' },
            notices: { type: 'boolean', description: '是否取群公告（扩展接口，默认 false）。' },
            refresh: { type: 'boolean', description: '忽略缓存，默认 false。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const out = {};
            if (args.list === true) out.groups = await capCall('get_group_list', {}, { refresh: args.refresh });
            if (args.group_id) {
              out.info = await capCall('get_group_info', pick(args, ['group_id']), { refresh: args.refresh });
              if (args.honor) {
                out.honor = await capCall('get_group_honor_info', { ...pick(args, ['group_id']), type: args.honor }, { refresh: args.refresh });
              }
              if (args.notices === true) {
                out.notices = await capCall('_get_group_notice', pick(args, ['group_id']), { refresh: args.refresh });
              }
            }
            if (!Object.keys(out).length) throw new Error('onebot_group 需要 group_id 或 list=true');
            return capJson(out);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_members',
          description:
            '看"群里的人"：成员列表（get_group_member_list，默认按 limit 截断并给出总数）或单个成员资料（get_group_member_info）。只读，走缓存。',
          parameters: {
            group_id: { type: 'string', description: '群号（必填）。' },
            user_id: { type: 'string', description: '指定成员则查单人资料，否则取列表。' },
            limit: { type: 'integer', description: '列表最多返回多少人，默认 50。' },
            refresh: { type: 'boolean', description: '忽略缓存，默认 false。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const group_id = args.group_id;
            if (!group_id) throw new Error('onebot_members 需要 group_id');
            if (args.user_id) {
              return capJson(await capCall('get_group_member_info', { group_id, user_id: args.user_id }, { refresh: args.refresh }));
            }
            const shaped = await capCall('get_group_member_list', { group_id }, { refresh: args.refresh });
            const all = Array.isArray(shaped.data) ? shaped.data : null;
            if (!all) return capJson(shaped);
            const limit = Math.min(Number(args.limit ?? 50) || 50, 500);
            return capJson({ ...shaped, total: all.length, data: all.slice(0, limit), truncated: all.length > limit });
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_avatar',
          description:
            '头像 URL：OneBot v11 规范里没有头像接口，这里用社区通行惯例拼——用户 `https://q1.qlogo.cn/g?b=qq&nk=<qq>&s=<size>`（非规范，' +
            'provenance=community），群 `https://p.qlogo.cn/gh/{gid}/{gid}/{size}`（有 go-cqhttp 文档出处，provenance=impl-doc）。',
          parameters: {
            user_id: { type: 'string', description: '用户账号（与 group_id 二选一）。' },
            group_id: { type: 'string', description: '群号（与 user_id 二选一）。' },
            size: { type: 'integer', description: '像素尺寸，默认 640（用户）/ 100（群）。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const size = Number(args.size ?? 0) || 0;
            if (args.user_id) {
              const qq = String(args.user_id);
              return capJson({ ok: true, kind: 'user', qq, size: size || 640, url: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=${size || 640}`, provenance: 'community' });
            }
            if (args.group_id) {
              const gid = String(args.group_id);
              return capJson({ ok: true, kind: 'group', group_id: gid, size: size || 100, url: `https://p.qlogo.cn/gh/${gid}/${gid}/${size || 100}`, provenance: 'impl-doc' });
            }
            throw new Error('onebot_avatar 需要 user_id 或 group_id');
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_media',
          description:
            '媒体：两种用法。① **落地成 durable ref**（§22.6 M14）——给 `messageId`（或直接给 `link`），把图/语音/文件存进 `<storageDir>/media/blobs`，' +
            '顺带登记到宿主 attachments；上游给的 URL 会过期，ref 不会。语音会试实现端转写，拿不到就标明"听不了"，不猜内容。`list:true` 看最近落地过什么。' +
            '落地时给 `describe:true` 就把图片交给视觉模型看一次，描述写进 ref（按 sha256 缓存）。' +
            '② **问实现端**——`action: get_image | get_record | get_forward_msg`（给 file 或 message_id 得到可下载 url / 转发里消息段）；这类结果不缓存（URL 会过期），' +
            '失败时看 note 里的实现端原文。**聊天记录（合并转发）走 get_forward_msg**：`id`/`file`/`message_id` 三个都认（各家实现端参数名不一样），' +
            '而且它是**可能几十秒**的大请求——默认超时给到 60s，还嫌慢就显式加 `timeoutMs`（实测 30s 会以 `retcode 1200` 超时告终）。',
          parameters: {
            action: { type: 'string', description: 'get_image | get_record | get_forward_msg；只在"问实现端"这条路上用。' },
            file: { type: 'string', description: 'get_image / get_record 的文件名或 file_id；get_forward_msg 也认它（= 转发 id）。' },
            message_id: { type: 'string', description: 'get_forward_msg 的转发消息 id。' },
            id: { type: 'string', description: 'get_forward_msg 的转发 id（不少实现端只认这个名字，合并转发段里的 `data.id` 就是它）。' },
            messageId: { type: 'string', description: '落地模式：这条消息里的媒体落成 durable ref。' },
            type: { type: 'string', description: '落地模式：auto（默认）/ image / record / video / file。' },
            link: { type: 'string', description: '落地模式：直接给一个 URL / base64:// / data: / 本地路径。' },
            name: { type: 'string', description: '落地模式：给这个媒体起个名字。' },
            durable: { type: 'boolean', description: '配合 file：把 file 当成媒体源落地，而不是问实现端要 URL。' },
            describe: { type: 'boolean', description: '落地模式：把图片交给视觉模型看一次，描述写进 ref.text（按字节 sha256 缓存，同一张图不会问第二次）。' },
            list: { type: 'boolean', description: 'true = 只列出最近落地过的媒体与统计。' },
            limit: { type: 'integer', description: 'list 时的条数，默认 20。' },
            timeoutMs: { type: 'integer', description: '问实现端时的等待超时毫秒。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const media = hub.media;
            const durableWanted =
              args.list === true || args.messageId !== undefined || args.link !== undefined || args.durable === true;

            if (durableWanted) {
              if (!media?.enabled) {
                return JSON.stringify({ enabled: false, note: 'media.enabled=false：媒体不落地（转发照旧）' }, null, 2);
              }
              if (args.list === true) {
                /**
                 * **逐条截断**（`m02432` P4）：这条一次回过 49933 字符（20 条 × 每条几百字的
                 * 视觉描述），够把一整轮上下文顶爆；而 agent 拿 list 通常只是想找一个 id。
                 * 要某一条的完整描述，就按它的 `id`/`messageId` 单独取那一条。
                 */
                const items = (media.list({ limit: args.limit }) ?? []).map((item) => {
                  const text = item?.text === undefined || item?.text === null ? null : String(item.text);
                  if (text === null || text.length <= 160) return { ...item, text };
                  return { ...item, text: `${text.slice(0, 160)}…（共 ${text.length} 字符，要全文按 id 取）` };
                });
                return JSON.stringify(
                  { stats: media.stats, items, note: 'list 里的 text 已截断到 160 字符；某一条的完整描述用 messageId/action 单独取' },
                  null,
                  2,
                );
              }
              const want = String(args.type ?? 'auto');
              const mediaTypes = ['image', 'record', 'video', 'file'];

              // 直接给的 URL / base64 / 路径：造一个与消息段同形状的输入，走同一条落地路径
              const source = args.link ?? (args.durable === true ? args.file : undefined);
              if (source) {
                const kind = mediaTypes.includes(want) ? want : 'file';
                const ref = await media.resolve(
                  { type: kind, data: { file: source, name: args.name ?? null } },
                  { messageId: args.messageId ?? null },
                );
                return JSON.stringify({ refs: ref ? [ref] : [], note: ref?.error ?? null, stats: media.stats }, null, 2);
              }

              // 按消息 id：先翻内存时间线（带完整事件），再翻 L1 原始行（重启后仍在）
              const messageId = args.messageId === undefined || args.messageId === null ? '' : String(args.messageId);
              if (!messageId) {
                return JSON.stringify({ error: '落地模式要么给 messageId，要么给 link（或 file + durable:true）' }, null, 2);
              }
              const entry = hub.timeline.recent(500, {}).find((e) => String(e.refs?.message_id ?? '') === messageId);
              let segments = entry?.payload?.message ?? null;
              let origin = 'timeline';
              if (!Array.isArray(segments)) {
                const row = hub.recall?.byMessage?.(messageId) ?? null;
                segments = row?.message ?? null;
                origin = row ? 'l1' : 'none';
              }
              if (!Array.isArray(segments)) {
                return JSON.stringify({ error: `消息 ${messageId} 的段不在手边（时间线没命中、L1 也没有）`, origin }, null, 2);
              }
              const refs = [];
              for (let i = 0; i < segments.length; i += 1) {
                const seg = segments[i];
                if (!seg || !mediaTypes.includes(seg.type)) continue;
                if (!(want === 'auto' || want === seg.type)) continue;
                refs.push(await media.resolve(seg, { messageId, index: i }));
              }
              // 顺带看图（M14-V + ⑥）：`describe:true` 时把图片交给视觉模型看一次，
              // 再让二次元后端认一次角色；两段文本拼在一起写进 ref（缓存键是字节的 sha256）。
              const described = [];
              if ((args.describe === true && hub.vision?.describeEnabled) || hub.anime?.enabled) {
                const { readFile } = await import('node:fs/promises');
                for (const ref of refs) {
                  if (!ref || ref.kind !== 'image') continue;
                  const bytes = ref.blob ? await readFile(ref.blob).catch(() => null) : null;
                  const parts = [];
                  if (args.describe === true && hub.vision?.describeEnabled) {
                    // 协议先验：这条图片段自己标的 `sub_type==1` 一并带给识图模型。
                    const seg = Array.isArray(segments) ? segments[ref.index] : null;
                    const memeHint = String(seg?.data?.sub_type ?? seg?.data?.subType ?? '0') === '1';
                    const out = await hub.vision.describeImage({
                      bytes,
                      mediaType: ref.mediaType,
                      name: ref.name,
                      sha256: ref.sha256,
                      attachment: ref.attachment,
                      // 会话级 `/vmodel`：这条工具调用也按当前会话的识图模型走。
                      override: hub.models?.visionFor?.(inferSessionKey() ?? '') ?? null,
                      memeHint,
                    });
                    if (out?.text) parts.push(out.text);
                    described.push({
                      id: ref.id ?? null,
                      text: out?.text ?? null,
                      meme: out?.meme ?? null,
                      emotion: out?.emotion ?? null,
                      cached: out?.cached ?? false,
                      error: out?.error ?? null,
                    });
                  }
                  if (hub.anime?.enabled && bytes) {
                    const out = await hub.anime.recognize({
                      bytes,
                      mediaType: ref.mediaType,
                      sha256: ref.sha256,
                    });
                    if (out?.text) parts.push(out.text);
                    described.push({ id: ref.id ?? null, anime: out?.text ?? null, source: out?.source ?? null, error: out?.error ?? null });
                  }
                  if (parts.length) ref.text = parts.join(' ');
                }
              }
              return JSON.stringify(
                {
                  origin,
                  messageId,
                  refs: refs.filter(Boolean),
                  descriptions: described.length ? described : null,
                  note: refs.length ? null : `这条消息里没有${want === 'auto' ? '媒体段' : ` ${want} 段`}`,
                  stats: media.stats,
                },
                null,
                2,
              );
            }

            const action = String(args.action ?? 'get_image');
            /**
             * 合并转发（聊天记录）取回：**三个参数名都塞进去**（`id` / `file` / `message_id`），
             * 因为各家实现端认的不一样——实测 LLOneBot 只认 `id`，而 agent 按工具说明先试了
             * `file`、又试了 `message_id`，白烧了三次调用。多给的键实现端会忽略，不亏。
             */
            const params = action === 'get_forward_msg'
              ? pick(args, ['id', 'file', 'message_id'])
              : pick(args, ['file', 'message_id']);
            // 合并转发是"一次几十秒"的大请求：默认给 60s（实测 30s 会 1200 超时）。
            const timeoutMs = Number(args.timeoutMs) > 0
              ? Number(args.timeoutMs)
              : action === 'get_forward_msg' ? 60000 : undefined;
            return capJson(await capCall(action, params, { timeoutMs }));
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_memes',
          description:
            '表情包库（④§26）：**是否收藏由你决定**——对话里出现值得留的表情图，你判断值得反复用就 `add` 收录，' +
            '并自己写一行简要介绍 `brief`（会进 prompt 清单）；`get` 查看单个条目的完整描述，`list` 看有什么、' +
            '`update` 按对话内容更新简介/关键词、`remove` 删掉、`stats` 看容量。上下文里只列简介，正文别写 id（发送时用 {"type":"meme","id":"m1"} 引用）。' +
            '库有硬容量（默认 200 张，超了自动淘汰少用/久未用的）。',
          parameters: {
            action: { type: 'string', description: 'list（默认）| get | add | update | remove | stats。' },
            id: { type: 'string', description: 'get / update / remove 的目标 id，如 m3。' },
            messageId: { type: 'string', description: 'add：从这条消息里的图片收录。' },
            link: { type: 'string', description: 'add：图片来源——`hub-media:<id>`（上下文里「已存为 …」的那个）/ URL / base64 / 本地路径。' },
            brief: { type: 'string', description: 'add（必填）/ update：你写的一行简介，进 prompt 清单（如「一只鼓掌的猫」）。' },
            keywords: { type: 'string', description: 'add / update：关键词，顿号或逗号分隔。' },
            description: { type: 'string', description: 'add / update：完整描述（不进 prompt，用 get 查看）；不写则用已生成的图片描述。' },
            limit: { type: 'integer', description: 'list 的条数，默认 20。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            if (!hub.memes) return JSON.stringify({ ok: false, enabled: false, note: 'memes.enabled=false' }, null, 2);
            const action = String(args.action ?? 'list').toLowerCase();
            if (action === 'stats') return JSON.stringify({ ok: true, stats: hub.memes.stats }, null, 2);
            if (action === 'list') {
              return JSON.stringify(
                {
                  ok: true,
                  stats: hub.memes.stats,
                  items: hub.memes.list().slice(0, Math.max(1, Number(args.limit ?? 20) || 20)),
                  promptText: hub.memes.renderForPrompt({ limit: Number(config.memes.topK ?? 8) || 8 }),
                },
                null,
                2,
              );
            }
            if (action === 'get') {
              const item = hub.memes.get(String(args.id ?? ''));
              if (!item) return JSON.stringify({ ok: false, error: `没有这个 id：${args.id}` }, null, 2);
              return JSON.stringify({ ok: true, item }, null, 2);
            }
            if (action === 'remove') {
              const ok = hub.memes.remove(String(args.id ?? ''));
              return JSON.stringify({ ok, id: args.id ?? null, stats: hub.memes.stats }, null, 2);
            }
            if (action === 'update') {
              const updated = hub.memes.update(String(args.id ?? ''), {
                ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
                ...(args.brief !== undefined ? { brief: args.brief } : {}),
                ...(args.description !== undefined ? { description: args.description } : {}),
              });
              if (!updated) return JSON.stringify({ ok: false, error: `没有这个 id：${args.id}` }, null, 2);
              return JSON.stringify({ ok: true, item: updated }, null, 2);
            }
            if (action === 'add') {
              // 总闸：`memes.autoCollect=false` 连 agent 也不许收录（表情包库整体关闭）。
              if (config.memes?.autoCollect === false)
                return JSON.stringify({ ok: false, error: 'memes.autoCollect=false：表情包库不允许收录' }, null, 2);
              const brief = String(args.brief ?? '').replace(/\s+/g, ' ').trim();
              if (!brief) return JSON.stringify({ ok: false, error: 'add 需要 brief：用一句话写这张表情包是什么（会显示在 prompt 清单里）' }, null, 2);
              let bytes = null;
              let mediaType = 'image/jpeg';
              let sha256 = null;
              let refText = '';
              const source = args.link ?? null;
              if (source) {
                const s = String(source);
                if (s.startsWith('hub-media:')) {
                  // 已经落地过的 ref：直接读它的 blob（resolve 不认 hub-media: 写法）
                  const got = await hub.media?.readRef?.(s, { kind: 'image' });
                  if (got?.error) return JSON.stringify({ ok: false, error: got.error }, null, 2);
                  bytes = got?.bytes ?? null;
                  mediaType = got?.mediaType ?? mediaType;
                  const ref = hub.media?.find?.(s) ?? null;
                  sha256 = ref?.sha256 ?? null;
                  refText = typeof ref?.text === 'string' ? ref.text : '';
                } else {
                  const ref = await hub.media?.resolve?.({ type: 'image', data: { file: s } }, {}).catch(() => null);
                  bytes = ref?.blob ? await (await import('node:fs/promises')).readFile(ref.blob).catch(() => null) : null;
                  mediaType = ref?.mediaType ?? mediaType;
                  sha256 = ref?.sha256 ?? null;
                  refText = typeof ref?.text === 'string' ? ref.text : '';
                }
              } else {
                const messageId = String(args.messageId ?? '');
                if (!messageId) return JSON.stringify({ ok: false, error: 'add 需要 messageId 或 link' }, null, 2);
                const ref = await hub.media?.resolve?.({ type: 'image', data: { file: '' } }, { messageId }).catch(() => null);
                bytes = ref?.blob ? await (await import('node:fs/promises')).readFile(ref.blob).catch(() => null) : null;
                mediaType = ref?.mediaType ?? mediaType;
                sha256 = ref?.sha256 ?? null;
                refText = typeof ref?.text === 'string' ? ref.text : '';
              }
              if (!bytes) return JSON.stringify({ ok: false, error: '拿不到图片字节（图不在手边或落地失败）' }, null, 2);
              // description 兜底链：agent 写的 → 已生成的图片描述 → 空
              const cached = !sha256 ? null : hub.vision?.cacheOf?.(sha256) ?? null;
              const description =
                String(args.description ?? '').trim() || refText || (typeof cached?.text === 'string' ? cached.text : '');
              const item = await hub.memes.collect({
                bytes,
                mediaType,
                sha256,
                brief,
                keywords: normalizeKeywords(args.keywords),
                description,
                savedBy: 'agent',
                source: 'onebot_memes',
                messageId: String(args.messageId ?? ''),
              });
              return JSON.stringify({ ok: Boolean(item), item, stats: hub.memes.stats }, null, 2);
            }
            return JSON.stringify({ ok: false, error: `未知 action：${action}` }, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_imagegen',
          description:
            '生图（⑦§26）：调配置好的 OpenAI 兼容生图接口（`imageGen.*`），把生成的图**直接发到指定会话**。' +
            '没配置就明确告诉你没配置，不会假装成功。`size` 会按 `imageGen.maxSize` 等比内缩，不会强行拉变形。',
          parameters: {
            prompt: { type: 'string', description: '画面描述。' },
            size: { type: 'string', description: '可选：如 1024x1024 / 768x1024（会按上限等比内缩）。' },
            reference: {
              type: 'string',
              description:
                '可选：参考图（图生图）——URL / data: 或 base64:// / 本地路径 / `hub-media:<id>`（已落地过的图）。',
            },
            message_type: { type: 'string', description: 'group 或 private，默认按 session_key 推断。' },
            session_key: { type: 'string', description: '目标会话，如 group:55555；给了就省掉 message_type 与 id。' },
            group_id: { type: 'string', description: 'group 时必填（除非给了 session_key）。' },
            user_id: { type: 'string', description: 'private 时必填（除非给了 session_key）。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            if (!hub.imageGen) {
              return JSON.stringify(
                { ok: false, note: '生图未启用：请先配置 imageGen.enabled/model/baseUrl/apiKey' },
                null,
                2,
              );
            }
            // 参考图先读成字节（URL / 本地路径 / data: / base64:// / hub-media:<id>）。
            // 读不出来就明确回绝：老写法把字符串原样透传给生图器，而那边只认 `.bytes`，
            // 于是"图生图"悄悄变成"文生图"——用户只会觉得参考图没起作用（真机事故 #9）。
            // 放在领额度之前：读不出参考图这一轮根本没画，不该扣额度。
            let reference = null;
            const refLink = String(args.reference ?? '').trim();
            if (refLink) {
              const got = hub.media?.readRef
                ? await hub.media.readRef(refLink, { kind: 'image' })
                : { error: '媒体服务不可用（读不出参考图）' };
              if (!got?.bytes?.length) {
                return JSON.stringify({ ok: false, error: `参考图读不出来：${got?.error ?? '未知原因'}` }, null, 2);
              }
              reference = { bytes: got.bytes, mediaType: got.mediaType ?? null };
            }
            // 每轮限额（`imageGen.maxPerTurn`）：生图又慢又贵，模型不该把它当聊天用。
            // 轮次用 `mind.turnSeq` 划界——一次唤醒就是一轮，不需要跨进程稳定。
            const targetKey = String(args.session_key ?? inferSessionKey() ?? '');
            const limit = Math.max(1, Number(config.imageGen.maxPerTurn ?? 1) || 1);
            const quotaKey = `${targetKey}#${mind.turnSeq ?? 0}`;
            const quota = claimImageQuota(imageGenUsed, quotaKey, limit);
            if (!quota.ok) {
              return JSON.stringify(
                { ok: false, note: `本轮生图额度用完了（imageGen.maxPerTurn=${limit}）；下一轮再画。` },
                null,
                2,
              );
            }
            if (imageGenUsed.size > 200) {
              for (const key of [...imageGenUsed.keys()].slice(0, imageGenUsed.size - 100)) imageGenUsed.delete(key);
            }
            const out = await hub.imageGen.generate({
              prompt: args.prompt ?? '',
              size: args.size ?? '',
              reference,
            });
            if (!out?.ok) return JSON.stringify({ ok: false, error: out?.error ?? '生图失败' }, null, 2);
            const fromKey = String(args.session_key ?? '');
            const messageType = args.message_type ?? (fromKey.startsWith('group:') ? 'group' : args.group_id ? 'group' : 'private');
            const frame = hub.buildMessageFrame({
              message: [{ type: 'image', data: { file: `base64://${Buffer.from(out.bytes).toString('base64')}` } }],
              message_type: messageType,
              group_id: args.group_id ?? (fromKey.startsWith('group:') ? fromKey.slice(6) : undefined),
              user_id: args.user_id ?? (fromKey.startsWith('private:') ? fromKey.slice(8) : undefined),
            });
            const sent = await hub.callUpstream(frame.action, frame.params);
            return JSON.stringify(
              { ok: true, size: out.size, mediaType: out.mediaType, bytes: out.bytes?.length ?? 0, sent, url: out.url ?? null },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_context',          description:
            '查看枢纽为某个会话装配的上下文（v4：状态段 + 会话卡/最近窗口的旁路数据——后两者不再进 prompt，排查时还得看），以及隔离审计：哪些跨会话记忆可见、哪些被挡下。排查"为什么它记得/不记得某件事"时用它。',
          parameters: {
            sessionKey: { type: 'string', description: '会话键，如 group:55555 或 private:10001。' },
            actorId: { type: 'string', description: '可选：以某个用户视角装配（影响同人可见性）。' },
            windowLimit: { type: 'integer', description: '最近窗口条数，默认 40。' },
            text: { type: 'boolean', description: '是否返回装配好的上下文正文，默认 true。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const sessionKey = String(args.sessionKey ?? '');
            if (!sessionKey) throw new Error('onebot_context 需要 sessionKey');
            const snapshot = mind.snapshot(sessionKey, {
              actorId: args.actorId,
              windowLimit: Math.min(Number(args.windowLimit ?? 40) || 40, 200),
            });
            return JSON.stringify(
              {
                sessionKey,
                sections: snapshot.sections,
                digest: {
                  messageCount: snapshot.digest.messageCount,
                  participants: snapshot.digest.participants,
                  downstreamResponded: snapshot.digest.downstreamResponded,
                },
                memory: { visible: snapshot.memoryVisible, total: snapshot.memoryTotal },
                // v4 起会话卡明细与最近窗口不进 prompt，但排查时还得能看（快照返回值里一直带着）。
                window: snapshot.window ?? '',
                audit: snapshot.audit,
                denied: snapshot.denied,
                truncated: snapshot.truncated,
                text: args.text === false ? undefined : snapshot.text,
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_memory_audit',
          description:
            '读取跨会话记忆的可见性审计账本（§24.5）：某条记忆为什么被放行或被隔离挡下。级别由 memory.isolation.level 决定，留痕可查。',
          parameters: {
            limit: { type: 'integer', description: '返回条数，默认 30。' },
            sessionKey: { type: 'string', description: '只看某个会话的判定。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const limit = Math.min(Number(args.limit ?? 30) || 30, 200);
            if (!audit) return JSON.stringify({ enabled: false, note: 'memory.isolation.audit 已关闭' }, null, 2);
            return JSON.stringify({ enabled: true, stats: audit.stats, entries: audit.list({ limit, sessionKey: args.sessionKey }) }, null, 2);
          },
        }),
      ),
    );

    /**
     * 「按需取回 DSH 的其它工具」（`m02675`/`m02678` 用户定案）：默认白名单只留本插件与几个常用
     * 原生工具，其余（任务板、子代理、工作流、插件管理、第三方上下文压缩…）要用了再点名放开。
     * 账很实在：工具目录是**每次请求都在**的缓存前缀，76 个工具 ≈ 69K 字符、约 17–20K token。
     */
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_tools',
          description:
            '按需取回 DSH 的其它工具。枢纽默认只放开本插件的工具与 read/grep/glob/read_image/pwsh/job_*/web_*/todo_write；' +
            '其余工具（task_board_*、subagent、workflow、skill、plugin_manager、compress…）默认不给，' +
            '为的是每次请求少背约 45K 字符的工具目录。要用就先 `list:true` 看有什么、再 `enable` 点名放开；' +
            '**只对本次激活有效**（休眠/重启后回到默认），放开后立刻可用。',
          parameters: {
            list: { type: 'boolean', description: 'true = 列出"当前已放开"与"可以放开（被挡下）"的工具。' },
            enable: { type: 'string', description: '要放开的工具名：逗号/空格分隔，或 JSON 数组字符串。' },
            disable: { type: 'string', description: '要收回的工具名（同样两种写法）。' },
            all: { type: 'boolean', description: 'true = 解除限制，放开**全部**全局工具。' },
            slim: { type: 'boolean', description: 'true = 回到默认白名单。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const sessionKey = inferSessionKey();
            const agentKey = sessionKey ? mind.agentKeyOf(sessionKey) : null;
            const rec = toolFaceOf(agentKey);
            if (!rec) {
              return JSON.stringify(
                {
                  enabled: false,
                  sessionKey: sessionKey || null,
                  note: '当前没有活跃的枢纽会话：工具面在会话 setup 时挂上，休眠期无处可放',
                },
                null,
                2,
              );
            }
            const known = globalToolNames(rec.ctx);
            const enable = parseToolNames(args.enable);
            const disable = parseToolNames(args.disable);
            const unknown = [...enable, ...disable].filter((n) => !known.includes(n));
            let note = null;
            if (args.all === true) {
              applyToolAllow(agentKey, rec.ctx, null);
              note = '已解除限制：全局工具全部可见（仅本次激活）';
            } else if (args.slim === true) {
              applyToolAllow(agentKey, rec.ctx, defaultToolAllow(rec.ctx));
              note = '已回到默认白名单';
            } else if (enable.length || disable.length) {
              const current = rec.allow ?? known;
              const next = [...new Set([...current, ...enable])].filter((n) => !disable.includes(n));
              if (!next.length) {
                note = '收回后一个工具都不剩，已忽略（要清空用 slim 或 all）';
              } else {
                applyToolAllow(agentKey, rec.ctx, next);
                note = `白名单已更新（放开 ${enable.length} 个 / 收回 ${disable.length} 个）`;
              }
            }
            const now = toolFaceOf(agentKey) ?? rec;
            const allowed = now.allow ?? known;
            const allowedSet = now.allow ? new Set(now.allow) : null;
            const blocked = allowedSet ? known.filter((n) => !allowedSet.has(n)) : [];
            const described = new Map(
              (rec.ctx.tools?.schemas?.() ?? []).map((t) => [String(t?.name ?? ''), String(t?.description ?? '')]),
            );
            const line = (n) => `${n}：${(described.get(n) ?? '').replace(/\s+/g, ' ').slice(0, 70)}`;
            return JSON.stringify(
              {
                sessionKey,
                restricted: Boolean(now.dispose),
                allowedCount: allowed.length,
                knownCount: known.length,
                allowed: args.list === true ? undefined : allowed,
                canEnable: args.list === true ? blocked.map(line) : blocked,
                unknown: unknown.length ? unknown : undefined,
                note,
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_memory',
          description:
            '更新拟人记忆（§24.11）：短期/长期记忆与人物档案。**记什么由你决定**——代码只做校验、落盘，' +
            '并把"这条能不能在别的会话里说"按会话推断（你声明的 visibility 一律被忽略）。' +
            '改已有条目用你上下文里「短期记忆 / 长期记忆」显示的序号；同一件事要改就 modify，别 add 一条新的。',
          parameters: {
            ops: { type: 'string', description: 'JSON 对象（直接给对象也行）：{short_term:{add:[{text}],modify:[{index,content}],delete:[index]},long_term:{...},persons:{<userId>:{facts:[{text}],interests:[{text}],commitments:[{what,due}],corrections:[{wrong,right}],impression}},groups:{"group:55555":{culture,highlights:[{text}]}},topics:{<话题名>:{title,status,conclusion,events:[{text}]}},self:{myStatements,mistakes,preferences,myNames}}' },
            sessionKey: { type: 'string', description: '会话键，如 group:55555；缺省用当前轮次所在会话。' },
            actorId: { type: 'string', description: '可选：这轮在跟谁说话；缺省用该会话最后一条入站消息的说话人。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const sessionKey = String(args.sessionKey ?? '').trim() || inferSessionKey();
            if (!sessionKey) throw new Error('onebot_memory 需要 sessionKey（当前轮次无法自动推断）');
            const worldKey = sessionKey;
            const recent = hub.timeline?.bySession?.(sessionKey, 5) ?? [];
            const actorId = String(args.actorId ?? '').trim() || actorOf([...recent].reverse()) || null;
            const snapshot = mind.snapshot(sessionKey, { actorId, windowLimit: 40 });
            const refs = recent.map((e) => e.refs?.message_id ?? e.refs?.id ?? e.id).filter((v) => v !== undefined && v !== null).slice(-5);
            const result = applyMemoryOps(coerceOps(args.ops), {
              store,
              profiles: hub.profiles,
              sessionKey,
              worldKey,
              actorId,
              isolation: config.isolation,
              refs,
              blocks: snapshot.blocks,
              source: 'agent:memory',
            });
            // 留痕：记忆被改了什么要能在时间线上倒查（§24.5 的可追溯性不只管可见性）。
            hub.timeline?.record?.({
              direction: 'hub-in',
              linkId: 'agent:memory',
              action: 'onebot_memory',
              decision: result.ok ? 'applied' : 'rejected',
              refs: { sessionKey, actorId, applied: result.applied, rejected: result.rejected.length },
            });
            return JSON.stringify(
              {
                sessionKey,
                actorId,
                applied: result.applied,
                blocks: result.blocks,
                persons: result.persons,
                groups: result.groups,
                topics: result.topics,
                self: result.self,
                rejected: result.rejected,
                note: result.ok ? undefined : result.error,
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_person',
          description:
            '读某个人的人物档案（§24.2）：我知道关于他的事、他答应过什么、他纠正过我什么、印象与亲疏。' +
            '看不到的内容可能是被隔离规则挡下的（用 onebot_memory_audit 查为什么）。省略 userId 则看当前会话的说话人。' +
            '也可以用 name 反查：别人嘴里说的"小明"是谁（改名之后还认得出，曾用名由代码记）。',
          parameters: {
            userId: { type: 'string', description: 'QQ 号；省略则用当前会话最后一条入站消息的说话人。' },
            name: { type: 'string', description: '反查：这个名字（当前名或曾用名）是谁，可省略 userId。' },
            sessionKey: { type: 'string', description: '以哪个会话的视角看（决定哪些事实可见），如 group:55555。' },
            raw: { type: 'boolean', description: '是否返回完整档案（默认只返回过滤后可见的部分）。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const sessionKey = String(args.sessionKey ?? '').trim() || inferSessionKey();
            const worldKey = sessionKey;
            // 名字反查（§24.11 `past_nicknames`）：改名之后"小明"还认得出是他，
            // 否则同一个人会被当成两个人。当前名优先于曾用名（`lookupName` 里排的序）。
            const wantName = String(args.name ?? '').trim();
            if (wantName && !String(args.userId ?? '').trim()) {
              const hits = hub.profiles?.lookupName?.(wantName, { scope: worldKey }) ?? [];
              if (!hits.length) return JSON.stringify({ name: wantName, hits: [], note: '档案里没有这个名字（当前名与曾用名都查过了）。' }, null, 2);
              return JSON.stringify({ name: wantName, hits }, null, 2);
            }
            const recent = hub.timeline?.bySession?.(sessionKey, 5) ?? [];
            const userId = String(args.userId ?? '').trim() || actorOf([...recent].reverse());
            if (!userId) throw new Error('onebot_person 需要 userId（当前会话没有可推断的说话人）');
            const person = hub.profiles?.person?.(userId);
            if (!person) throw new Error(`没有 ${userId} 的人物档案（还没观测到）`);
            if (args.raw === true) return JSON.stringify(person, null, 2);
            // 档案是**按需创建**的：只有 id 的空壳和"真知道点什么"必须分得清，
            // 否则模型会把"我对他一无所知"读成"他就是个空白的人"。
            const known = Boolean(person.names?.length || person.impression || person.facts?.length || person.commitments?.length);
            if (!known) return JSON.stringify({ userId, empty: true, note: '还没有关于他的档案：只在被提到名字/发过言之后才会有内容。' }, null, 2);
            const visible = filterForScope(
              (person.facts ?? []).map((f, i) => ({ id: `f${i}`, kind: 'fact', text: f.text, scope: f.scope ?? null, worldKey: f.worldKey ?? null, visibility: f.visibility, sensitive: f.sensitive, actor: f.actor })),
              { sessionKey, worldKey, actorId: userId, isolation: config.isolation },
            );
            return JSON.stringify(
              {
                userId,
                names: person.names,
                // 曾用名单独给一份：模型按 `names` 全量读容易看漏，改名之后要认得出人。
                pastNames: hub.profiles?.pastNames?.(userId, { scope: worldKey }) ?? [],
                groupCard: person.groups?.[worldKey] ?? null,
                relationship: person.relationship,
                impression: person.impression ?? null,
                facts: visible.visible.map((f) => ({ text: f.text, scope: f.scope ?? null, visibility: f.visibility })),
                commitments: (person.commitments ?? []).map((c) => ({ what: c.what, due: c.due ?? null, status: c.status })),
                corrections: person.corrections ?? [],
                interests: person.interests ?? [],
                denied: visible.denied.length,
              },
              null,
              2,
            );
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_sessions',
          description:
            '看所有会话的清单（§24.2）：每个群/私聊最后热闹到什么时候、上次我说话是什么时候、有没有未读。' +
            '`lastSeenAt` 的意义是让你能说"刚才没在"，而不是假装什么都看到了。',
          parameters: {
            limit: { type: 'integer', description: '返回条数，默认 20。' },
            onlyUnread: { type: 'boolean', description: '只看有未读的。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const limit = Math.min(Number(args.limit ?? 20) || 20, 200);
            const items = (hub.profiles?.sessions?.() ?? [])
              .filter((s) => (args.onlyUnread === true ? (s.unread ?? 0) > 0 : true))
              .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
              .slice(0, limit);
            return JSON.stringify({ count: items.length, items }, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_topic',
          description:
            '看话题线程（§24.2，可以跨群）：每件事聊到哪一步了、有没有结论。给 id 看一条，不给就列开着的。' +
            '话题由你自己用 onebot_memory 的 topics 维护——代码不替你判断"这算不算一个话题"。',
          parameters: {
            id: { type: 'string', description: '话题 id（就是你在 onebot_memory 里用的那个名字）。' },
            status: { type: 'string', description: '列表时只看 open 或 closed，默认全部。' },
            limit: { type: 'integer', description: '返回条数，默认 10。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const id = String(args.id ?? '').trim();
            if (id) {
              const rec = hub.profiles?.topic?.(id);
              if (!rec || !rec.title) throw new Error(`没有「${id}」这个话题`);
              return JSON.stringify(rec, null, 2);
            }
            const limit = Math.min(Number(args.limit ?? 10) || 10, 50);
            const wanted = String(args.status ?? '').trim();
            const all = hub.profiles?.topics?.() ?? [];
            const items = all
              .filter((t) => (wanted ? t.status === wanted : true))
              .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
              .slice(0, limit)
              .map((t) => ({ id: t.id, title: t.title, status: t.status, worldKeys: t.worldKeys, lastAt: t.lastAt, conclusion: t.conclusion, events: t.events?.length ?? 0 }));
            return JSON.stringify({ count: items.length, total: all.length, items }, null, 2);
          },
        }),
      ),
    );

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_recall',
          description:
            '翻聊天记录（§24.9）：一个工具多种问法——按关键词（中文两字词也搜得到）、按人、按时间窗、按消息类型（image/file 等）、按人分组、只看还没结的话题。' +
            '检索**只给你当前会话看得见的东西**，被隔离挡下的条数回在 denied 里；要跨会话翻必须 scope:"all"，而它默认会被降级或要求 confirm。' +
            '结果里的 refs 指向时间线条目，能对回原文。',
          parameters: {
            query: { type: 'string', description: '关键词。中文按两字切分，所以"天气"搜得到"今天天气不错"。' },
            person: { type: 'string', description: '只看某人（QQ 号，或名字出现在文本里也行）。' },
            worldKey: { type: 'string', description: '只看某个会话，如 group:55555 / private:10001。' },
            since: { type: 'string', description: '起点（ISO 时间或毫秒时间戳）。' },
            until: { type: 'string', description: '终点（ISO 时间或毫秒时间戳）。' },
            kinds: { type: 'string', description: '消息段类型过滤，逗号分隔，如 image,file,voice。' },
            groupBy: { type: 'string', description: '填 person 就按人聚合，返回每人几条、最近说了什么。' },
            openOnly: { type: 'boolean', description: '只看还没结的话题覆盖到的话。' },
            sources: { type: 'string', description: '数据来源，默认 timeline；加 memory 也搜记忆条目。' },
            scope: { type: 'string', description: 'visible（默认）或 all；all 是越界检索，可能被降级或需要 confirm。' },
            confirm: { type: 'boolean', description: '越界检索的显式确认（配置要求审批时才需要）。' },
            includeWeak: { type: 'boolean', description: '连已经淡忘的旧事一起翻出来（默认跳过）。' },
            limit: { type: 'integer', description: '返回条数，默认 20，最多 200。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const sessionKey = String(args.sessionKey ?? inferSessionKey());
            const entries = hub.timeline.bySession(sessionKey, 8);
            const actorId = String(args.actorId ?? actorOf(entries) ?? '');
            const toTs = (value) => {
              if (value === undefined || value === null || value === '') return undefined;
              const n = Number(value);
              if (Number.isFinite(n) && String(value).trim() !== '') return n;
              const t = Date.parse(String(value));
              return Number.isFinite(t) ? t : undefined;
            };
            const list = (value) =>
              Array.isArray(value)
                ? value.map(String)
                : String(value ?? '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            const result = await hub.recall.search({
              query: args.query ?? '',
              person: args.person,
              worldKey: args.worldKey,
              since: toTs(args.since),
              until: toTs(args.until),
              kinds: list(args.kinds),
              groupBy: args.groupBy,
              openOnly: args.openOnly === true,
              sources: list(args.sources).length ? list(args.sources) : ['timeline'],
              scope: String(args.scope ?? 'visible'),
              confirm: args.confirm === true,
              includeWeak: args.includeWeak === true,
              limit: args.limit,
              sessionKey,
              actorId: actorId || null,
              isolation: config.isolation,
              topics: hub.profiles?.topics?.() ?? [],
            });
            return JSON.stringify(result, null, 2);
          },
        }),
      ),
    );

    /**
     * §16.6 的 `linkId?` 参数。本实例只接**一条**上游链路（`upstreamListen` 或
     * `upstreamUrl`），所以给了 `linkId` 就必须对得上：对不上就明说，而不是
     * 静默地拿本链路的数据糊弄过去。多上游的正确做法是起多个实例。
     */
    const linkMismatch = (raw) => {
      const want = String(raw ?? '').trim();
      if (!want) return null;
      const mine = String(hub.upstreamLinkId ?? '');
      const self = String(config.upstreamSelfId ?? '');
      if (want === mine || (self && want === self) || (mine && mine.endsWith(want))) return null;
      return {
        ok: false,
        linkId: want,
        upstreamLinkId: mine || null,
        upstreamSelfId: self || null,
        note:
          `本实例只接一条上游链路（${mine || '当前未连接'}${self ? `，self_id ${self}` : ''}）；${want} 不在其中。` +
          '这个参数不是被忽略，是明确不匹配——多上游请起多实例（每个实例一个 upstreamListen / upstreamUrl）。',
      };
    };

    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'onebot_turns',
          description:
            '回合配对（§16.4）：看"**哪条消息触发了下游什么**"——每条入站消息开一个回合，把配对窗口内下游 bot 真正发出的 send_* 归到它名下，' +
            '给出响应者、延迟、以及"没人响应"的沉默回合。纯协议层观测，不掺判断、不需要下游配合。' +
            '挂不到任何触发上的下游动作单列在 unsolicited 里（定时任务、自发消息），不会被硬塞给最近的那条。' +
            '**账号对不上是正常的**：链路隔离开着时探针走的是另一个账号，所以响应明细里的 `user_id`/`self_id` 与你当时指定的说话人不一致——那是探针链路自己的账号，别当成出错，也别据此断言"群里有人这么说过"。要看是谁在说话，看 `downstreamLabel`。',
          parameters: {
            since: { type: 'string', description: '起点（ISO 时间或毫秒时间戳）。' },
            sessionKey: { type: 'string', description: '只看某个会话，如 group:55555。' },
            onlyResponsive: { type: 'boolean', description: '只看有下游响应的回合（学习候选就看这个）。' },
            withOutcomes: { type: 'boolean', description: '带上每个回合的完整响应明细（默认只给条数与响应者）。' },
            reset: { type: 'boolean', description: '清空内存里的配对（落盘的 jsonl 不动）。' },
            limit: { type: 'integer', description: '返回条数，默认 20，最多 200。' },
            linkId: { type: 'string', description: '限定下游链路（§16.6）。本实例只接一条上游，给的值对不上会明确回"不匹配"而不是静默无视。' },
          },
          output: TEXT_OUTPUT,
          async execute(args = {}) {
            const mismatch = linkMismatch(args.linkId);
            if (mismatch) return JSON.stringify(mismatch, null, 2);
            if (args.reset === true) {
              const cleared = hub.turns?.clear?.() ?? 0;
              return JSON.stringify({ reset: true, cleared, stats: hub.turns?.snapshot ?? null }, null, 2);
            }
            const toTs = (value) => {
              if (value === undefined || value === null || value === '') return null;
              const n = Number(value);
              if (Number.isFinite(n) && String(value).trim() !== '') return n;
              const t = Date.parse(String(value));
              return Number.isFinite(t) ? t : null;
            };
            const result = hub.turns?.list?.({
              since: toTs(args.since),
              sessionKey: args.sessionKey ? String(args.sessionKey) : null,
              onlyResponsive: args.onlyResponsive === true,
              withOutcomes: args.withOutcomes === true,
              limit: Math.min(200, Math.max(1, Number(args.limit) || 20)),
            }) ?? { turns: [], count: 0, total: 0, note: '回合索引不可用' };
            /**
             * 多下游时 `responders` 只是一串 linkId——`down:127.0.0.1:8080` 和它的探针链路
             * 只差一个 `~probe`，agent 看不出"这是哪个 bot"（`m02768`）。所以每条都补上人话名字，
             * 原来的 linkId 保留（过滤/对账还要用）。
             */
            const label = (linkId) => (linkId ? hub.labelOf(linkId) : undefined);
            const withLabels = (list) => (Array.isArray(list) ? list : []).map((turn) => ({
              ...turn,
              ...(Array.isArray(turn?.responders) ? { responderLabels: turn.responders.map(label) } : {}),
              ...(Array.isArray(turn?.outcomes)
                ? { outcomes: turn.outcomes.map((o) => ({ ...o, ...(o?.linkId ? { downstreamLabel: label(o.linkId) } : {}) })) }
                : {}),
            }));
            result.turns = withLabels(result.turns);
            if (Array.isArray(result.unsolicited)) result.unsolicited = withLabels(result.unsolicited);
            if (Array.isArray(result.stats?.responders)) {
              result.stats.responders = result.stats.responders.map((r) => ({ ...r, ...(r?.linkId ? { label: label(r.linkId) } : {}) }));
            }
            return JSON.stringify(result, null, 2);
          },
        }),
      ),
    );

    ctx.tools.register(
      defineTool({
        name: 'onebot_raw',
        description:
          '原始报文缓存与索引（§16 L1，`m03065`）：**收到的每一条消息/动作都留了原文与索引**——包括 hub 认不出的段类型、'
          + '以及**故意不展开**的聊天记录（合并转发 / 多消息卡片）。hub 只做"能自动做的那点解析"（文本、@、图片落地、卡片标题…），'
          + '更深的语义由**你自己**处理：先不带 `ref` 看索引挑出要哪条，再带 `ref` 取原文 + 这条已落地的媒体'
          + '（`media[].blob` 是本地路径），然后用你自己的工具读它（换格式、OCR、解包转发节点、看语音字节…）。'
          + '原文里的内联 base64 已换成占位说明（字节都在媒体 blob 里），所以看到的是引用而不是几百 KB 的字符串。'
          + '缓存按 `retention.days`（默认 7 天）自动清理，超期的取不到——要留证据请当场处理。',
        parameters: {
          ref: {
            type: 'string',
            description: '取某一条的原文：时间线条目 id（形如 `t…`，就是 `onebot_timeline` 每条里的 `rawRef`）或 OneBot 消息 id。',
          },
          sessionKey: { type: 'string', description: '不带 ref 时：只看某个会话，如 group:55555。' },
          kind: { type: 'string', description: '不带 ref 时：按类型过滤，如 group_message / private_message / notice / action。' },
          direction: { type: 'string', description: '不带 ref 时：按方向过滤 upstream-in / downstream-in / downstream-out / hub-out。' },
          since: { type: 'string', description: '不带 ref 时：起点（ISO 时间或毫秒时间戳）。' },
          until: { type: 'string', description: '不带 ref 时：终点（ISO 时间或毫秒时间戳）。' },
          limit: { type: 'integer', description: '不带 ref 时返回条数，默认 20，最多 200。' },
        },
        output: TEXT_OUTPUT,
        async execute(args = {}) {
          const ref = String(args.ref ?? '').trim();
          if (ref) return JSON.stringify(await hub.rawFrameOf(ref), null, 2);
          const toTs = (value) => {
            if (value === undefined || value === null || value === '') return null;
            const n = Number(value);
            if (Number.isFinite(n) && String(value).trim() !== '') return n;
            const t = Date.parse(String(value));
            return Number.isFinite(t) ? t : null;
          };
          const out = await hub.rawIndex({
            limit: Math.min(200, Math.max(1, Number(args.limit) || 20)),
            sessionKey: args.sessionKey ? String(args.sessionKey) : null,
            kind: args.kind ? String(args.kind) : null,
            direction: args.direction ? String(args.direction) : null,
            since: toTs(args.since),
            until: toTs(args.until),
          });
          return JSON.stringify(out, null, 2);
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'onebot_capabilities',
        description:
          '下游用法知识库（§17 M7）：回答"**这个 bot 会吃什么消息**"。不传参数就是读清单——每条给出触发形状（前缀命令 / 带 @ / 需回复 / 关键词）、' +
          '用到的 action、典型延迟、观测次数（confidence）与状态（candidate/active/stale）。' +
          '观测学习是机械的：只有下游**真的响应过**的消息才算一次证据，够阈值（默认 3 次）才升 active；连续未复现先标 stale 降置信，够独立阈值才删。' +
          '语义判断由你做：用 upsert 把"这是命令吗、名字/参数/用法/示例"写回去（会与观测证据合并，`source` 变 both；**观测到的用法优先**）；' +
          'forget 删掉不存在的，stale 把没把握的降置信。写入只动本插件的知识库，不发任何消息。',
        parameters: {
          query: { type: 'string', description: '按名字/前缀/别名/备注模糊查。' },
          kind: { type: 'string', description: '只看某种触发形状：command / keyword / at / reply / notice / unknown。' },
          status: { type: 'string', description: '只看某状态：candidate / active / stale。' },
          limit: { type: 'integer', description: '返回条数，默认 20，最多 200。' },
          upsert: {
            type: 'string',
            description:
              '写入学习结论：JSON 对象或纯命令名。字段 name(必填)/kind/prefix/aliases/args/preconditions/outcome/notes/usage/examples/status/confidence。',
          },
          forget: { type: 'string', description: '删除一条（id 或名字）：确认它根本不存在时用。' },
          stale: { type: 'string', description: '把一条降置信（id 或名字）。' },
          prefixCandidates: {
            type: 'string',
            description: '逗号分隔的前缀候选集（默认 /,!,#,／,。,！）——只影响后续候选的形状判断。',
          },
          reset: { type: 'boolean', description: '清空整张表（落盘的文件随后被覆盖）。' },
          flush: { type: 'boolean', description: '立刻把合并写落盘。' },
          linkId: { type: 'string', description: '限定下游链路（§16.6）。本实例只接一条上游，给的值对不上会明确回"不匹配"而不是静默无视。' },
        },
        output: TEXT_OUTPUT,
        async execute(args = {}) {
          const mismatch = linkMismatch(args.linkId);
          if (mismatch) return JSON.stringify(mismatch, null, 2);
          const learn = hub.learn;
          if (!learn) return JSON.stringify({ enabled: false, note: '用法学习不可用' }, null, 2);
          if (Array.isArray(args.prefixCandidates) || typeof args.prefixCandidates === 'string') {
            const list = (Array.isArray(args.prefixCandidates) ? args.prefixCandidates : String(args.prefixCandidates).split(','))
              .map((s) => String(s).trim())
              .filter(Boolean);
            if (list.length) learn.prefixCandidates = list;
          }
          if (args.reset === true) {
            const cleared = learn.reset();
            hub.persistLearn?.();
            return JSON.stringify({ reset: true, cleared, ...learn.snapshot }, null, 2);
          }
          if (args.forget !== undefined && args.forget !== '') {
            const removed = learn.forget(args.forget);
            if (removed) hub.persistLearn?.();
            return JSON.stringify(
              { forget: true, removed: removed ? { id: removed.id, name: removed.name } : null, ...learn.snapshot },
              null,
              2,
            );
          }
          if (args.stale !== undefined && args.stale !== '') {
            const marked = learn.markStale(args.stale);
            if (marked) hub.persistLearn?.();
            return JSON.stringify({ stale: true, marked, ...learn.snapshot }, null, 2);
          }
          if (args.upsert !== undefined && args.upsert !== '') {
            let input = args.upsert;
            if (typeof input === 'string') {
              const text = input.trim();
              if (text.startsWith('{')) {
                try {
                  input = JSON.parse(text);
                } catch (err) {
                  return JSON.stringify({ ok: false, note: `upsert 不是合法 JSON：${err?.message ?? err}` }, null, 2);
                }
              } else {
                input = { name: text };
              }
            }
            const saved = learn.upsert(input, { source: 'manual' });
            if (!saved) return JSON.stringify({ ok: false, note: 'upsert 至少要给 name' }, null, 2);
            hub.persistLearn?.();
            if (args.flush === true) hub.flushStorage?.();
            return JSON.stringify({ upsert: saved, ...learn.snapshot }, null, 2);
          }
          if (args.flush === true) hub.flushStorage?.();
          const result = learn.list({
            query: args.query ? String(args.query) : '',
            kind: args.kind ? String(args.kind) : '',
            status: args.status ? String(args.status) : '',
            limit: Math.min(200, Math.max(1, Number(args.limit) || 20)),
          });
          return JSON.stringify({ ...result, stats: learn.snapshot }, null, 2);
        },
      }),
    );


    // 先预测再动手（§10 / M7-③）：dryRun 默认只回答"会不会触发"，不发任何东西。
    ctx.tools.register(
      defineTool({
        name: 'onebot_relay_probe',
        description:
          '试运行探针（§10 / M7-③）：**先预测再动手**——`dryRun` 为真（默认）时只回答"这句话按现有用法知识库会不会触发下游、会被谁触发、匹配到哪条形状、参数是什么"，**不发送任何东西**（群里瞎试命令的代价是真的发出消息）。' +
          '预测只依据 `onebot_capabilities` 攒出来的那张表：精确命中命令名/别名、句首命令、关键词包含、正则匹配、以及"需要 @/需要回复"的前置条件不满足时的降级判断；证据不足（candidate）或已过时（stale）的条目也会列出来，但结论会打折并说明。' +
          '真发要显式 `dryRun: false` 且 `confirm: true`——那才会以 hub 的身份向下游投递这条消息（事件是真的，会触发它的 matcher）。'
          + '**走哪条链路由枢纽决定**（`m02768`）：`downstream` 只说"要问哪个下游"，探针链路（另一个账号、收不到真人消息）'
          + '还是真实链路按 `probe.isolation` 自动选；真要点真实链路得显式 `allow_real_link: true`（结果里会写明"本次未隔离"）。',
        parameters: {
          downstream: { type: 'string', description: '真发时问哪个**下游**（逻辑下游名/备注名/对方账号；缺省 = 只有一条下游时用它）。**不是物理链路**——探针还是真实由枢纽决定。**不影响预测**。' },
          allow_real_link: { type: 'boolean', description: '真发时默认 false。链路隔离开着时置 true = 故意打真实链路（产物可能直接进群），结果里会带 `notIsolated`。' },
          linkId: { type: 'string', description: '预测时限定用法知识库的来源链路（§16.6，值是本实例的上游链路）；给的值对不上会明确回"不匹配"而不是静默无视。' },
          text: { type: 'string', description: '要试的那句话（原文，含前缀，如 `/roll 10`）。' },
          hasAt: { type: 'boolean', description: '这句话里有没有 @ 别人（预测需要 @ 的命令时用）。' },
          hasReply: { type: 'boolean', description: '这句话是不是"回复某条消息"（预测 reply 依赖的命令时用）。' },
          dryRun: { type: 'boolean', description: '默认 true：只预测不发送。' },
          confirm: { type: 'boolean', description: 'dryRun=false 时必须显式确认，否则拒绝发送。' },
          group_id: { type: 'string', description: '真发时的群号（dryRun=false 且发群里）。' },
          user_id: { type: 'string', description: '真发时的说话人账号（不写 = hub 的上游账号）；**换账号可能换结果**——下游按账号判权限/冷却/用户级状态。' },
        },
        output: TEXT_OUTPUT,
        async execute(args = {}) {
          const text = args.text === undefined ? '' : String(args.text);
          if (!text) return JSON.stringify({ ok: false, note: '要给它一句 text（原文）' }, null, 2);
          const mismatch = linkMismatch(args.linkId);
          if (mismatch) return JSON.stringify(mismatch, null, 2);
          const prediction = hub.learn?.predict
            ? hub.learn.predict({
                text,
                // 预测的 scope 是**上游**链路（learn 的落盘位置就是按它分的）；
                // `link` 只决定真发时投给谁，拿它当过滤条件会把表整个滤空。
                linkId: args.linkId ? String(args.linkId) : '',
                hasAt: args.hasAt === true,
                hasReply: args.hasReply === true,
              })
            : { text, wouldTrigger: false, matches: [], note: '用法知识库没开（没接上 learn）', sent: false };
          const payload = { ok: true, dryRun: args.dryRun !== false, prediction };
          if (args.dryRun === false) {
            if (args.confirm !== true) {
              payload.sent = false;
              payload.refused = true;
              payload.note = 'dryRun=false 需要 confirm: true 才真发（先预测、再动手）。这次什么都没发。';
              return JSON.stringify(payload, null, 2);
            }
            payload.sent = hub.sendMessageToDownstream({
              downstream: args.downstream ?? args.link,
              allowRealLink: args.allow_real_link === true,
              text,
              message_type: args.group_id ? 'group' : undefined,
              group_id: args.group_id,
              user_id: args.user_id,
            });
          }
          return JSON.stringify(payload, null, 2);
        },
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-onebot-hub: tools');
  startup?.note('tools:registered');

  try {
    ctx.inject?.(['systemPrompt'], (sctx) => {
      sctx.effect(
        () => sctx.systemPrompt.section({ name: 'plugin:dsh-onebot-hub', order: 160, text: buildHubGuidance(hub.config) }),
        'dsh-onebot-hub: guidance',
      );
    });
  } catch (err) {
    log(`systemPrompt 指导注入失败（可忽略）：${err?.message ?? err}`);
  }

  // ---- agent 通道（§21.6）：宿主 API 动态获取；拿不到时枢纽照常转发，只是不唤醒 ----
  try {
    ctx.inject?.(['agents', 'agentDefaultModel'], (sctx) => {
      const scope = typeof sctx.effect === 'function' ? sctx.effect.bind(sctx) : ctx.effect.bind(ctx);
      scope(() => {
        let disposed = false;
        void (async () => {
          try {
            const [llmMod, sessionMod, agentMod] = await Promise.all([
              import('@deepseek-ai/dsh-llm'),
              import('@deepseek-ai/dsh-session'),
              import('@deepseek-ai/dsh-agent'),
            ]);
            const { createUserMessage } = llmMod;
            const { SessionId } = sessionMod;
            const { installModelSelection } = agentMod;
            const selection = sctx.agentDefaultModel.currentSelection();
            /**
             * 基准路由（m024167：默认模型**由 hub 配置决定**，不跟 DSH 系统默认）：
             * `agent.defaultModel` 配了就以它为默认（provider 没写就沿用会话现有的 provider），
             * 没配才退回宿主的系统默认路由。`selectionFor`/`applyChat`/`defaultChat` 全从 `base` 出发。
             */
            const hubDefaultModel = config.agentDefaultModel;
            // 思考强度（m024193）：配了就**覆盖**宿主系统默认的档位（`base` 里其余键照旧继承）。
            // 留空 = 不带这个键，让模型走它自己的默认 effort。
            const hubEffort = String(config.agentDefaultReasoningEffort ?? '').trim();
            const base = {
              ...selection,
              ...(hubDefaultModel
                ? { provider: hubDefaultModel.provider || selection.provider, model: hubDefaultModel.model }
                : {}),
              ...(hubEffort ? { reasoningEffort: hubEffort } : {}),
            };
            /**
             * 会话级聊天模型（`/model`）：每个 agent 一个**可变** selection 对象，交给宿主
             * `installModelSelection()` 之后，宿主每一轮装配 prompt 时都会读 `selection.current`
             * ——所以**改它就等于给活着的会话换模型**（宿主自己还会追加一条"模型已变更"通知）。
             * 键是 agentKey（本插件里等于 sessionKey）。
             */
            const agentSelections = new Map();
            const selectionFor = (agentKey) => {
              const key = String(agentKey ?? '');
              let sel = agentSelections.get(key);
              if (sel) return sel;
              const override = sessionModels.chatFor(key);
              sel = {
                current: override
                  ? { ...base, provider: override.provider || base.provider, model: override.model }
                  : { ...base },
                assembled: undefined,
              };
              agentSelections.set(key, sel);
              return sel;
            };
            /** 命令面拿它显示"当前聊天模型"（没覆盖时就是 hub 配置的默认，或宿主默认路由）。 */
            modelControl.defaultChat = () => ({ provider: base.provider, model: base.model });
            /**
             * 命令面点了 `/model` 之后：活着的会话立刻改 `selection.current`；还没建的会话
             * （休眠中）什么都不用做——覆盖已经落盘，建的时候 `selectionFor()` 会带上它。
             */
            modelControl.applyChat = (agentKey, override) => {
              const sel = agentSelections.get(String(agentKey ?? ''));
              if (!sel) return false;
              sel.current = override
                ? { ...base, provider: override.provider || base.provider, model: override.model }
                : { ...base };
              return true;
            };
            const sessionIdFor = (agentKey) => SessionId(`onebot-hub:${encodeURIComponent(String(agentKey))}`);
            /**
             * 会话的人话名字（用户要求："会话按群名+时间命个名"）。
             *
             * 名字取自枢纽自己的档案（群名/人物名，都是观测得来的），取不到就退会话键；
             * 后面接一个本地时间戳——这样宿主的会话列表里一眼能看出"哪个群、什么时候那一段"，
             * 而不是一串 `onebot-hub:group%3A617770183.a…`。
             */
            const titleForAgent = (agentKey) => {
              const key = String(agentKey ?? '');
              let label = key || 'OneBot 会话';
              try {
                if (key.startsWith('group:')) {
                  const gid = key.slice('group:'.length);
                  const name = String(hub.profiles?.group?.(key)?.name ?? '').trim();
                  label = name ? `群 ${name}（${gid}）` : `群 ${gid}`;
                } else if (key.startsWith('private:')) {
                  const uid = key.slice('private:'.length);
                  const name = String(hub.profiles?.person?.(uid)?.name ?? '').trim();
                  label = name ? `私聊 ${name}（${uid}）` : `私聊 ${uid}`;
                }
              } catch {
                /* 名字取不到就用会话键——命名失败不该影响唤醒 */
              }
              const d = new Date();
              const p = (n) => String(n).padStart(2, '0');
              return `${label} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
            };
            /**
             * 实际用的会话 id。
             *
             * **每次激活一个全新会话，永不 resume 旧转录**（用户定案 + 真机 bug 修正）：
             * 早先的写法是"默认用 `sessionIdFor(agentKey)`，只有写句柄被占时才另起一个"，而
             * `chosenSessionIds` 只是**进程内**的一张表——重启之后表空了，`sessionIdOf` 又回到
             * 那个默认 id，`hasSession()` 一查到它就把**上一轮的旧转录** resume 回来了
             * （用户实测："重启以后新消息会被放到旧的会话里面"）。
             *
             * 所以改成：**id 只生成一次、带激活时间戳**，激活结束（回休眠 / 交还会话）时把它从表里
             * 删掉，下一次激活再生成一个新的。配合 `hostRef.hasSession` 恒为 `false`，
             * 重启前后都不会再捡回旧转录；旧会话文件留在宿主的会话库里（宿主没暴露删除接口）。
             *
             * `chosenSessionIds` 这张表**声明在外层**（`/perm` 那段旁边，`m33779` 修的 bug）：
             * 超管给会话改权限要按同一个 id 找会话，两边必须是同一张表，不能各建一张。
             */
            const sessionIdOf = (agentKey) => {
              const key = String(agentKey);
              const known = chosenSessionIds.get(key);
              if (known) return known;
              const fresh = SessionId(
                `${sessionIdFor(key)}.a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              );
              chosenSessionIds.set(key, fresh);
              return fresh;
            };
            // Agent 预设（实测坑）：宿主有一条不变量——**没加入任何预设的 agent 一旦去喊模型，
            // `system-prompt/assemble` 直接判失败**（原文：`addressed a model without joining any
            // agent preset while a roster is composed; its tools, prompt sections, and skill catalog
            // resolve against the empty global layer`）。表现就是"唤醒了、turns 在涨，但永远不开口"。
            // 出厂做法（DSH 自己 webhook 建会话那处）是两件事一起做：`meta.agentPreset` 记进会话头，
            // 并在 **setup 回调里** `agentPresets.mount(agentCtx, preset.id)` 真正加入。
            // 这里照做：拿不到预设服务时原样退回（老行为），不因此挡住转发。
            const presetsSvc = sctx.get?.('agentPresets') ?? sctx.agentPresets ?? null;
            let presetId = null;
            if (presetsSvc?.resolve) {
              try {
                presetId = (await presetsSvc.resolve())?.id ?? null;
              } catch (err) {
                log(`取 Agent 预设失败（自建会话将不进预设，模型可能被不变量挡下）：${err?.message ?? err}`);
              }
            }
            const wrapSetup = (agentKey, setup) => async (agentCtx) => {
              if (presetsSvc?.mount) {
                // 失败就让它抛：进不了预设的话这一轮照样会被不变量拒掉，早报错比"默默不开口"好。
                await presetsSvc.mount(agentCtx, presetId ?? undefined);
              }
              // 装的是**这个 agent 自己的**可变 selection（`/model` 改的就是它）。
              installModelSelection(agentCtx, selectionFor(agentKey));
              setup?.(agentCtx);
              /**
               * 工具面（`m02678`）：**放在 mount 与 setup 之后**——这时预设带来的工具已经就位，
               * `schemas()`（全局视图）才认得全；`onebot_reply` 是 setup 里注册在 agent 作用域的，
               * 本来就绕开限制（见 `toolFace` 上方那段注释）。
               */
              let toolFaceInfo = null;
              try {
                if (typeof agentCtx.tools?.restrict === 'function') {
                  const rec = applyToolAllow(agentKey, agentCtx, defaultToolAllow(agentCtx));
                  toolFaceInfo = {
                    slim: true,
                    keep: rec.allow?.length ?? 0,
                    universe: globalToolNames(agentCtx).length,
                    allow: rec.allow,
                  };
                } else {
                  toolFaceInfo = { slim: false, note: 'agentCtx.tools.restrict 不是函数（宿主版本不认？）' };
                }
              } catch (err) {
                // 精简失败**不挡这一轮**：模型看到全部工具也能聊，只是多背 45K 字符。
                toolFaceInfo = { slim: false, error: String(err?.message ?? err) };
                log(`工具面精简失败（本轮模型会看到全部工具）：${toolFaceInfo.error}`);
              }
              try {
                mind.noteSetup({ ...(mind.stats?.lastSetup ?? {}), toolFace: toolFaceInfo });
              } catch (err) {
                log(`记工具面诊断失败：${err?.message ?? err}`);
              }
            };
            if (disposed) return;
            /**
             * **恒为 false：枢纽的会话从不 resume**（用户定案"激活结束清转录"）。
             *
             * 为什么把这条写死而不是去查 `sessionPersistence.list()`：`sessionIdOf` 现在每次激活
             * 都会生成一个带时间戳的新 id，"查到旧会话"这件事只可能发生在**同一进程内**被误用；
             * 而真机 bug 正是"重启后表空了 → 又回到默认 id → 把旧转录 resume 回来"。查一遍
             * 反而给了它复活的机会，所以这里直接返回 false：永远 create 一个空转录的新会话。
             * （会话 id 带时间戳 + 随机后缀，撞 id 的概率可以忽略；万一真撞了，`ensure()` 里还有
             * "create 抛 already exists 就回退 resume" 那条兜底。）
             */
            hostRef.hasSession = async () => false;
            /** 建/恢复会话时的初始路由：带会话级覆盖（`/model`）就用覆盖的，否则用 hub 配置的默认。 */
            const agentOptionsFor = (agentKey) => {
              const current = selectionFor(agentKey).current ?? base;
              return { provider: current.provider, model: current.model };
            };
            /**
             * 给会话**起个人话名字**（用户要求"会话按群名+时间命个名"）。
             *
             * 用宿主会话服务的 `rename(sessionId, title)`（宿主里那条
             * "Rename a Session and update its title projection without opening its history"）；
             * 拿不到就静默跳过——**命名失败不该影响唤醒**，但要留痕（`onebot_hub_status` 的
             * `host.lastTitle`）好排查。
             */
            hostRef.title = async (agentKey) => {
              const id = sessionIdOf(agentKey);
              const title = titleForAgent(agentKey);
              /**
               * 顺序很重要（`m02432` P10）：`workspaceRegistry.rename(sessionId, title)` 是**认 id** 的那条
               * （它转到 `remote.session.rename`，回 `{ok, value:{title, seq}}`）；而 `sessions` /
               * `sessionTitle` 的 `rename()` 要一个**活着的 Session 对象**，拿 id 直接调会抛
               * `session "undefined" is not live in this store`——真机就是这条把会话名一直卡住的。
               */
              const candidates = [
                ['workspaceRegistry', sctx.get?.('workspaceRegistry') ?? sctx.workspaceRegistry],
                ['sessions', sctx.get?.('sessions') ?? sctx.sessions],
                ['sessionTitle', sctx.get?.('sessionTitle') ?? sctx.sessionTitle],
              ];
              for (const [via, svc] of candidates) {
                if (typeof svc?.rename !== 'function') continue;
                try {
                  const res = await svc.rename(id, title);
                  const ok = res?.ok !== false;
                  hostRef.lastTitle = { ok, agentKey, sessionId: id, title, via, at: Date.now() };
                  if (ok) return hostRef.lastTitle;
                } catch (err) {
                  hostRef.lastTitle = {
                    ok: false, agentKey, sessionId: id, title, via, error: String(err?.message ?? err), at: Date.now(),
                  };
                }
              }
              if (!hostRef.lastTitle || hostRef.lastTitle.agentKey !== agentKey) {
                hostRef.lastTitle = {
                  ok: false, agentKey, sessionId: id, title, note: '宿主没暴露会话改名接口（会话列表里会显示默认名）', at: Date.now(),
                };
              }
              return hostRef.lastTitle;
            };
            hostRef.create = async ({ agentKey, setup }) => {
              const handle = await sctx.agents.create({
                sessionId: sessionIdOf(agentKey),
                meta: { cwd: process.cwd(), ...(presetId ? { agentPreset: presetId } : {}) },
                agentOptions: agentOptionsFor(agentKey),
                setup: wrapSetup(agentKey, setup),
              });
              // 起名是"锦上添花"：不 await（宿主慢/没这接口都不该拖住唤醒），失败只留痕。
              void hostRef.title?.(agentKey);
              return handle;
            };
            hostRef.resume = async ({ agentKey, setup }) => {
              try {
                return await sctx.agents.resume({
                  resumeSessionId: sessionIdOf(agentKey),
                  agentOptions: agentOptionsFor(agentKey),
                  setup: wrapSetup(agentKey, setup),
                });
              } catch (err) {
                // 最后一道兜底（实测线上）：这个会话的**写句柄**被别人占着——多半是本进程里上一轮
                // 已经发布过这个 agent、而它又不在这张表里（`pool` 那边会先试领养）。领养也救不回来时，
                // 与其让用户看到"没回复了"，不如换一个会话 id 重新起一个：枢纽的上下文（会话卡/记忆/
                // 最近窗口）本来就不依赖宿主那份转录，用户视角的连续性不受影响。
                // 只在写句柄冲突时走这条路（不是把别的错误也吞掉），并记进 status 供排查。
                const message = String(err?.message ?? err);
                if (!/already owned by an active write handle/i.test(message) || typeof sctx.agents.create !== 'function') {
                  throw err;
                }
                const from = sessionIdOf(agentKey);
                const forked = SessionId(`${sessionIdFor(agentKey)}.r${Date.now().toString(36)}`);
                chosenSessionIds.set(agentKey, forked);
                hostRef.lastFork = { agentKey, from, to: forked, at: Date.now(), error: message };
                log(
                  `会话 ${from} 的写句柄被占且没有活着的 agent（${message}）；` +
                    `改用 ${forked} 另起一个会话，这一轮照常回话`,
                );
                return sctx.agents.create({
                  sessionId: forked,
                  meta: { cwd: process.cwd(), ...(presetId ? { agentPreset: presetId } : {}) },
                  agentOptions: agentOptionsFor(agentKey),
                  setup: wrapSetup(agentKey, setup),
                });
              }
            };
            hostRef.createUserMessage = (input) => createUserMessage(input);
            /**
             * **激活结束 = 清空宿主会话**（用户定案："每次激活状态结束后直接落盘记忆并清除会话记录"）。
             *
             * 为什么需要：一轮激活里的转录是"我们喂进去的本批消息 + 模型自己的回复"，激活结束之后
             * 它就成了**旧账**——下一轮激活时它会排在 system prompt 那个"最近窗口"**前面**，
             * 模型会拿很久以前的话当上下文，反而更容易误判。所以每次回到休眠就把会话交还。
             *
             * 两条路，优先第一条（能删就删，id 保持稳定）：
             *  1. 宿主的会话服务若有 `delete/remove/deleteSession`，直接删掉这个 id；
             *  2. 删不掉就**换一个会话 id**（`.a<时间戳>`）——下一次 `ensure()` 走 create，
             *     得到的是一个空转录的新会话（旧会话的文件留着，宿主没暴露删除接口）。
             */
            hostRef.retire = async (agentKey) => {
              const id = sessionIdOf(agentKey);
              let archived = false;
              let removed = false;
              let via = null;
              let error = null;
              /**
               * **旧会话直接归档**（用户定案）——`workspaceRegistry.archiveSession(sessionId,
               * { stopActivity: true })`：宿主自己那条"归档"通路（会话列表里收进归档、不再占着活跃位），
               * 也是我们唯一能碰到的"收拾旧会话"手段。删不掉也不强求。
               */
              const registry = sctx.get?.('workspaceRegistry') ?? sctx.workspaceRegistry;
              if (typeof registry?.archiveSession === 'function') {
                try {
                  const res = await registry.archiveSession(id, { stopActivity: true });
                  archived = res?.ok !== false;
                  via = 'archiveSession';
                  if (!archived) error = String(res?.error?.message ?? res?.error ?? 'archiveSession 返回失败');
                } catch (err) {
                  error = String(err?.message ?? err);
                }
              }
              // 退路：宿主哪天把删除接口暴露出来就用它（现在没有）。
              if (!archived) {
                for (const svc of [sctx.get?.('sessions'), sctx.get?.('sessionPersistence')]) {
                  for (const method of ['delete', 'remove', 'deleteSession']) {
                    if (typeof svc?.[method] !== 'function') continue;
                    try {
                      await svc[method](id);
                      removed = true;
                      via = method;
                      break;
                    } catch {
                      /* 换下一个方法/服务试 */
                    }
                  }
                  if (removed) break;
                }
              }
              /**
               * **无论收拾成没成，都把这张表里的 id 清掉**：下一次激活 `sessionIdOf()` 会现生成一个
               * 带时间戳的新 id，配合恒 false 的 `hasSession`，绝不可能再 resume 回旧转录。
               */
              chosenSessionIds.delete(String(agentKey));
              const info = {
                ok: true, agentKey, sessionId: id, archived, removed, via, rotated: true, error, at: Date.now(),
              };
              hostRef.lastRetire = info;
              if (archived) log(`激活结束：已归档宿主会话 ${id}（${via}）；下一次激活起新会话`);
              else log(`激活结束：归档没成（${error ?? '宿主没暴露归档接口'}）；下一次激活直接起一个新会话 id（旧转录不再被读回）`);
              return info;
            };
            // 宿主里活着的 agent（`ctx.agents.get(id)`，"Look up a live agent"）。
            // 用途见 `lib/agent/pool.js` 的领养逻辑：已发布的 agent 握着会话写句柄，
            // 再 create/resume 同一个 session 会分别撞 "already exists" / "already owned … write handle"，
            // 活着的那个直接领养才能不丢这一轮。
            hostRef.getLive = (agentKey) => {
              const agentsSvc = sctx.get?.('agents') ?? sctx.agents;
              if (typeof agentsSvc?.get !== 'function') return null;
              return agentsSvc.get(sessionIdOf(agentKey)) ?? null;
            };
            // 真机事故 #2（`turnEnd:'blocked'`）：会话被用户/界面归档后，宿主的
            // `archived-session-gate` 在 `agent/pre-step` 直接 reject，整轮在**发出模型请求之前**
            // 就结束（会话日志里只有 `turn/start` → `agent/inbox/spliced(removedCount:1)` →
            // `turn/end {kind:'blocked'}`）。枢纽自己建的会话不该受这个门控，所以唤醒前先取消归档。
            hostRef.unarchive = async (agentKey) => {
              const registry = sctx.get?.('workspaceRegistry') ?? sctx.workspaceRegistry;
              const id = sessionIdOf(agentKey);
              if (typeof registry?.unarchiveSession !== 'function') {
                return { ok: false, sessionId: id, error: 'workspaceRegistry.unarchiveSession 不可用' };
              }
              const listed = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : null;
              if (listed && !listed.includes(id)) return { ok: true, sessionId: id, archived: false };
              await registry.unarchiveSession(id);
              const info = { ok: true, sessionId: id, archived: true, at: Date.now() };
              hostRef.lastUnarchive = info;
              log(`会话 ${id} 曾被归档，已取消归档（否则每一轮都会以 blocked 结束、模型不会跑）`);
              return info;
            };
            log(
              `agent 通道就绪：模型 ${base.provider || '（系统）'}/${base.model}${hubDefaultModel ? '（hub 配置的默认）' : ''}` +
                `${base.reasoningEffort ? `，思考强度 ${base.reasoningEffort}${hubEffort ? '（hub 配置的）' : '（系统默认）'}` : ''}` +
                `，模式 ${config.agentPolicy.mode}，` +
                `Agent 预设 ${presetId ?? '（没拿到，自建会话不进预设）'}`,
            );
            // 看图（M14-V）：`describe` 手段要自己发一次模型请求，用宿主 `ctx.llm.stream`。
            // 识图默认模型由 hub 配置决定（`agent.defaultVisionModel`，m024167：留空 = 系统默认模型）；
            // 会话里用 `/vmodel` 覆盖（每次调用按 `hub.models.visionFor(sessionKey)` 带 override）。
            try {
              const llmService = sctx.get?.('llm') ?? sctx.llm ?? null;
              const attached = hub.vision?.attach({ llm: llmService });
              if (config.vision?.mode !== 'off') {
                log(
                  `看图已接入：模式 ${config.vision?.mode}，识图模型 ${
                    config.agentDefaultVisionModel
                      ? `${config.agentDefaultVisionModel.provider ? `${config.agentDefaultVisionModel.provider}/` : ''}${config.agentDefaultVisionModel.model}（hub 配置的默认）`
                      : '系统默认'
                  }${config.agentDefaultVisionReasoningEffort ? `，思考强度 ${config.agentDefaultVisionReasoningEffort}` : ''}（要在会话里换发 /vmodel）` +
                    `${attached ? '' : '（llm 服务没拿到，describe 会降级）'}`,
                );
              }
              /**
               * `/model`、`/vmodel` 的清单来源：宿主 `llm.listProviders()` + `llm.listModels(id)`。
               * 拿不到就回空清单——命令会如实说"宿主没给清单"，而不是编几个模型名出来。
               */
              if (typeof llmService?.listProviders === 'function') {
                modelControl.list = async () => {
                  const providers = await llmService.listProviders();
                  const out = [];
                  for (const provider of Array.isArray(providers) ? providers : []) {
                    const id = String(provider?.id ?? '');
                    if (!id) continue;
                    let models = [];
                    try {
                      models = await llmService.listModels(id);
                    } catch {
                      models = [];
                    }
                    out.push({
                      id,
                      name: String(provider?.name ?? id),
                      models: (Array.isArray(models) ? models : []).map((model) => ({
                        id: String(model?.id ?? ''),
                        name: String(model?.name ?? model?.id ?? ''),
                      })),
                    });
                  }
                  return out;
                };
              }
            } catch (err) {
              log(`看图接入失败（可忽略，图片仍会落 ref）：${err?.message ?? err}`);
            }
          } catch (err) {
            log(`agent 通道未启用（只观察、不唤醒）：${err?.message ?? err}`);
          }
        })();
        return () => {
          disposed = true;
          hostRef.hasSession = null;
          hostRef.create = null;
          hostRef.resume = null;
          hostRef.createUserMessage = null;
          hostRef.unarchive = null;
          hostRef.getLive = null;
          pool.disposeAll();
        };
      }, 'dsh-onebot-hub: agent host');
    });
  } catch (err) {
    log(`agent 通道注入失败（可忽略）：${err?.message ?? err}`);
  }

  /**
   * 宿主 `attachments` 服务（§21 / §22.6 M14）：有它就把落地过的媒体登记一份进去，
   * 这样模型的 prompt 里**真的看得到图**（我们自己的 blob 只是"留得住"）。
   * 没有它也一切照旧：ref 照样落盘、时间线照样有记录。
   */
  try {
    ctx.inject?.(['attachments'], (sctx) => {
      const scope = typeof sctx.effect === 'function' ? sctx.effect.bind(sctx) : ctx.effect.bind(ctx);
      scope(() => {
        const service = sctx.get?.('attachments') ?? sctx.attachments ?? null;
        if (!service) return () => {};
        hub.media?.attach(service);
        // 看图也用同一个服务：`describe` 手段要把图片变成 durable ref 才进得了模型消息。
        hub.vision?.attach?.({ attachments: service });
        log('媒体落地已接上宿主 attachments（图片/文件会登记成 durable ref）');
        return () => {
          hub.media?.detach();
          hub.vision?.attach?.({ attachments: null });
        };
      }, 'dsh-onebot-hub: attachments');
    });
  } catch (err) {
    log(`attachments 注入失败（可忽略，媒体仍落自己的 blob）：${err?.message ?? err}`);
  }

  hub.mind = mind;
  hub.store = store;
  // 检索层要搜"记忆"这个来源，得先拿得到 MemoryStore（hub 构造时它还不存在）。
  if (hub.recall) hub.recall.store = store;
  hub.pool = pool;
  startup?.note('apply:done');
  return hub;
}
