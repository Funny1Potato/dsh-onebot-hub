/**
 * 配置归一：schema 默认值 + 运行期覆盖 → Hub 用的普通对象。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），逻辑逐字未改。纯函数：不碰 IO、不建定时器，
 * 方便单独对照契约快照（`test/contract.mjs` 比对它算出来的键集）。
 */

import { AGENT_MODES, resolveAgentPolicy, sessionOverrideOf } from '../agent/policy.js';
import { resolveTtsTarget } from '../audio/providers.js';
import { TTS_FORMATS, Tts } from '../audio/tts.js';
import { ChatCommands } from '../chat-commands.js';
import { DEFAULT_DIRECTORY_MODE, DIRECTORY_MODES } from '../cross/directory.js';
import { CrossRelay } from '../cross/relay.js';
import { MEME_ENGINES } from '../guidance.js';
import { Hub } from '../hub.js';
import { resolveIsolation } from '../memory/isolation.js';
import { Mind } from '../mind.js';
import { DOWNSTREAM_TYPES, clamp01, describeCodeScopes, normalizeDownstreamType, normalizeTargets, parseAddress, parseCodeRoots, parseCodeScopes, parseJsonObject, parseJsonValue, parseListenTarget, parseModelRef, readField, schemeOfAddress } from '../parse.js';
import { quotaOfEntry } from '../quota.js';
import { parseTrustedPrivates } from '../read-scope.js';
import { PRESETS, PROBE_ISOLATIONS } from '../router.js';
import { defaultStorageDir } from '../storage.js';
import { normalizeVisionMode } from '../vision.js';
import { DEFAULT_ANIMETRACE_URL, AnimeRecognizer, normalizeBackend as normalizeAnimeBackend } from '../vision/anime.js';
import { IMAGEGEN_DELIVERIES, IMAGEGEN_ENGINES, ImageGen } from '../vision/imagegen.js';

const DEFAULT_PRESET_NAME = 'relay';


/** 把 schema 默认值 + 运行期覆盖合并成 Hub 用的普通对象。 */
export function resolveConfig(raw = {}) {
  // 先算上游账号：下游目标里没写"对方账号"的都默认与它相同（见 normalizeTargets 的注释）。
  const upstreamSelfId = readField(raw.upstreamSelfId, '');
  /**
   * 上游连接方式与地址（`m71864`）：新配置是"模式 + 一个地址"，内部仍然翻译成
   * `upstreamUrl` / `upstreamListen` 两个老形状——`hub.js` 那边一行都不用改。
   *
   * `upstreamMode` 为空 = 老配置，按旧键推导（顺序与 hub 的判定一致：先看监听）。
   */
  const upstreamAddress = String(readField(raw.upstreamAddress, '') ?? '').trim();
  const modeRaw = String(readField(raw.upstreamMode, '') ?? '').trim().toLowerCase();
  const legacyListen = parseListenTarget(readField(raw.upstreamListen, ''));
  const legacyUrl = String(readField(raw.upstreamUrl, '') ?? '').trim();
  const upstreamMode = (() => {
    if (modeRaw === 'forward' || modeRaw === 'reverse') return modeRaw;
    // 推导：先看"有没有人在拨进来"，再看"我拨不拨出去"。
    if (legacyListen) return 'reverse';
    if (legacyUrl) return 'forward';
    return '';
  })();
  const addressOf = (() => {
    if (upstreamAddress) return upstreamAddress;
    // 没填新地址就沿用旧值，免得"切了模式"就把地址丢了。
    if (upstreamMode === 'reverse' && legacyListen) {
      const path = legacyListen.path && legacyListen.path !== '/' ? legacyListen.path : '';
      return `${legacyListen.host}:${legacyListen.port}${path}`;
    }
    if (upstreamMode === 'forward') return legacyUrl;
    return '';
  })();
  const cfg = {
    enabled: readField(raw.enabled, true),
    upstreamMode,
    upstreamAddress: addressOf,
    // 旧键的"推导结果"仍然写进这两个字段：hub 读的是它们。
    upstreamUrl: upstreamMode === 'forward' ? addressOf : '',
    upstreamSelfId,
    upstreamNickname: readField(raw.upstreamNickname, ''),
    upstreamListen: upstreamMode === 'reverse' ? parseListenTarget(addressOf) : null,
    upstreamAccessToken: readField(raw.upstreamAccessToken, ''),
    // 地址填得不像样时给一句人话（`m71864`）：以前是"什么都不发生"，日志里只有
    // "未配置 upstreamUrl / upstreamListen"，看不出是格式错还是根本没填。
    ...(() => {
      if (!addressOf) return {};
      if (upstreamMode === 'reverse' && !parseListenTarget(addressOf)) {
        return {
          upstreamModeError:
            `反向地址「${addressOf}」解析不出端口——反向是开着端口等实现端拨进来，` +
            '得写成 host:port（可以带路径，如 127.0.0.1:8765/onebot/v11/ws）。',
        };
      }
      if (upstreamMode === 'forward' && !/^wss?:\/\//i.test(addressOf)) {
        return {
          upstreamModeError:
            `正向地址「${addressOf}」少了 ws:// 或 wss:// 前缀——正向是我们拨出去的完整地址，` +
            '如 ws://127.0.0.1:3001。',
        };
      }
      return {};
    })(),
    // 老配置被推导过：让 `apply` 记一行，提示去设置页确认一次。
    ...(modeRaw === '' && upstreamMode !== '' && (addressOf !== '' || legacyListen || legacyUrl)
      ? { upstreamModeInferred: true }
      : {}),
    // 官方通道：`enabled` 且 appId/appSecret 都在，才算真的配上了（少一个就是没开）。
    upstreamType: (() => {
      // 三态：显式 onebot / 显式 official / 没选过（''）。
      // 没选过时按老配置的 `official.enabled: true` 兜底——0.12.0-beta.6 之前只有那个开关，
      // 直接换键会让老配置静默退回 OneBot（连不上，且没有任何提示）。
      const shown = String(readField(raw.upstreamType, '') ?? '').trim().toLowerCase();
      const legacy = (readField(raw.official, {}) ?? {}).enabled === true;
      if (shown === 'official') return 'official';
      if (shown === 'onebot') return 'onebot';
      return legacy ? 'official' : 'onebot';
    })(),
    official: (() => {
      const o = readField(raw.official, {}) ?? {};
      const appId = String(readField(o.appId, '') ?? '').trim();
      const appSecret = String(readField(o.appSecret, '') ?? '');
      const upstreamType = String(readField(raw.upstreamType, '') ?? '').trim().toLowerCase();
      // `enabled` 现在是**派生值**（`upstreamType === 'official'`），保留这个名字是因为
      // hub 里有几处按它分流；判断"缺凭据"仍然在 `Hub.#connectOfficialUpstream()`——
      // 那里能同时看到配置与扫码两份凭据。
      return {
        enabled: upstreamType === 'official' || (upstreamType === '' && o.enabled === true),
        appId,
        appSecret,
        sandbox: readField(o.sandbox, false) === true,
        crossShare: readField(o.crossShare, false) === true,
        intents: (() => {
          const v = Number(readField(o.intents, 0));
          return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
        })(),
        // 老配置里还留着 `official.enabled`：记一句"这个键没了"，别让人改完发现没反应。
        ...(o.enabled === undefined ? {} : { legacyEnabled: true }),
      };
    })(),
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
      // 裸号码写法（`["111"]` / `["945126014"]`）也要认：手写配置的人十有八九这么写，
      // 只认 `{id:…}` 的话整份名单会被静默丢掉，用户只看到"配了没生效"（`m32493` 自查）。
      const bare = typeof row === 'string' || typeof row === 'number' ? row : null;
      if (bare === null && row?.enabled === false) continue; // 行编辑器里的"取消勾选"：条目留着，但不生效
      const id = String(bare ?? row?.id ?? row?.key ?? '').trim();
      if (!id) continue;
      const mode = bare === null && AGENT_MODES.includes(row?.mode) ? row.mode : undefined;
      // 条目级额度（m13404 起，m14190 定案：**额度只在这里配**）：行编辑器把它塞成 JSON 字符串
      // 也认；归一后存的是**完整一份**，这样设置页读回来能照着显示现值（而不是"半份覆盖"）。
      const rawQuota = typeof row?.quota === 'string' ? parseJsonValue(row.quota, null) : row?.quota;
      const quota = rawQuota && typeof rawQuota === 'object' ? quotaOfEntry({ quota: rawQuota }) : null;
      out[id] = { ...(mode ? { mode } : {}), ...(quota ? { quota } : {}) };
    }
    return out;
  };
  cfg.agentGroups = parseWhitelist(readField(agentRaw.groups, undefined));
  cfg.agentPrivates = parseWhitelist(readField(agentRaw.privates, undefined));
  // 激活期插话（m31311）：默认开（不写这个键 = 开）。Mind 里读 `config.agentSteer === false` 判关。
  cfg.agentSteer = readField(agentRaw.steer, true) !== false;
  cfg.agentTasks = {
    enabled: readField(agentRaw.tasks?.enabled, true) !== false,
    resetEvery: Math.max(0, Math.floor(Number(readField(agentRaw.tasks?.resetEvery, 0)) || 0)),
  };
  // 会话归属（issue #1）：两个键的默认值合起来就是**不改现状**，各自要显式写才变。
  //  - `agent.workspace`：绝对路径（留空 = 用进程 cwd 且不挂工作区）。
  //  - `agent.archiveOnRetire`：默认 true（结束后归档）；只有明确写 false 才不归档。
  cfg.agentWorkspace = String(readField(agentRaw.workspace, '') ?? '').trim();
  cfg.agentArchiveOnRetire = readField(agentRaw.archiveOnRetire, true) !== false;
  // 要遮蔽的提示词段落（`m72820`）：逗号/空白分隔，解析成去重后的名字数组。
  // 默认空 = 谁都不遮蔽——名字属于别的插件，猜错只会让人困惑"为什么它不见了"。
  cfg.hidePromptSections = [
    ...new Set(
      String(readField(agentRaw.hidePromptSections, '') ?? '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  // 默认放行的全局工具（`m73105`）：逗号/空白分隔，去重；默认空 = 不动现有白名单。
  cfg.keepTools = [
    ...new Set(
      String(readField(agentRaw.keepTools, '') ?? '')
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  // 发送失败当场回执（m25376）：开关 + 节流（窗口内最多几次自动重开一轮）。
  cfg.agentReplyOnSendFailure = readField(agentRaw.replyOnSendFailure, true) !== false;
  cfg.agentSendFailureNudgeMax = Math.max(0, Math.floor(Number(readField(agentRaw.sendFailureNudgeMax, 2)) || 0));
  cfg.agentSendFailureNudgeWindowMs = Math.max(1000, Number(readField(agentRaw.sendFailureNudgeWindowMs, 300000)) || 300000);
  // 一次调用发多条（m32420）：间隔、文字条数上限（**图不占额度**）、图片条数上限。
  // 0 = 不限（ReplyBuffer 里当成 Infinity）；间隔 0 = 连发不带停顿。
  cfg.replyGapMs = Math.max(0, Number(readField(agentRaw.replyGapMs, 400)) || 0);
  cfg.replyMaxText = Math.max(0, Number(readField(agentRaw.replyMaxText, 3)) || 0);
  cfg.replyMaxImages = Math.max(0, Number(readField(agentRaw.replyMaxImages, 9)) || 0);
  // 分群额度（m14190）：**没有全局默认**。口径/单价/限额/报数都挂在白名单每一行的 `quota` 上，
  // `parseWhitelist` 那里就地 `quotaOfEntry` 归一；没写＝不限。账本与报数行见 `lib/quota.js`。
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
    firstRunDelayMs: Math.max(0, Number(readField(retentionRaw.firstRunDelayMs, 20000)) || 0),
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
  // 会话间转达（m25983）：默认关，其它值按原样收，范围在 CrossRelay 里夹。
  const crossRaw = readField(raw.cross, {}) ?? {};
  cfg.cross = {
    enabled: readField(crossRaw.enabled, false) === true,
    allowFrom: String(readField(crossRaw.allowFrom, 'hub') || 'hub'),
    allowTo: (() => {
      const list = parseJsonValue(readField(crossRaw.allowTo, '[]'), []);
      return Array.isArray(list) ? list.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    })(),
    // `allowPrivateToGroup` 是没发布过的旧名（当时只管私聊→群），当别名读，老配置不报错。
    allowPrivateRefs:
      readField(crossRaw.allowPrivateRefs, readField(crossRaw.allowPrivateToGroup, false)) === true,
    relayMaxPerWindow: Number(readField(crossRaw.relayMaxPerWindow, 3)) || 3,
    windowMs: Number(readField(crossRaw.windowMs, 300000)) || 300000,
    packageTtlMs: Number(readField(crossRaw.packageTtlMs, 1800000)) || 1800000,
    maxBytes: Number(readField(crossRaw.maxBytes, 300 * 1024)) || 300 * 1024,
    channelTtlMs: Number(readField(crossRaw.channelTtlMs, 1800000)) || 1800000,
    // 0 = 不按沉默冷掉（只看 TTL）；`|| 默认值` 会把 0 吃掉，所以单独判（`m32493` 自查：
    // relay 那边早就按有限数判了，配置层这里又把 0 吃回 10 分钟，等于白修）。
    channelSilentMs: (() => {
      const v = Number(readField(crossRaw.channelSilentMs, 600000));
      return Number.isFinite(v) && v >= 0 ? v : 600000;
    })(),
    channelMaxPerSide: Math.max(1, Number(readField(crossRaw.channelMaxPerSide, 6)) || 6),
    wakeGraceMs: Math.max(1, Number(readField(crossRaw.wakeGraceMs, 1200)) || 1200),
    peerListLimit: Math.max(1, Number(readField(crossRaw.peerListLimit, 10)) || 10),
    // 会话目录（`m32112`）：认不出的档位一律回落 names（不静默关掉整段，也不猜 full）。
    directory: (() => {
      const v = String(readField(crossRaw.directory, DEFAULT_DIRECTORY_MODE) ?? DEFAULT_DIRECTORY_MODE).trim().toLowerCase();
      return DIRECTORY_MODES.includes(v) && v !== 'off' ? v : v === 'off' ? 'off' : DEFAULT_DIRECTORY_MODE;
    })(),
    rosterLimit: Math.max(0, Number(readField(crossRaw.rosterLimit, 30)) || 0),
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
    // 坏值要回落**默认**，不是归 0：`|| 0` 会把"写错一个字母"变成"冷却关掉"，
    // 而这恰好是本插件最不想被意外关掉的一档节流（同表其它字段都是回落默认）。
    cooldownMs: (() => {
      const v = Number(readField(membersRaw.cooldownMs, 6 * 60 * 60 * 1000));
      return Number.isFinite(v) && v >= 0 ? v : 6 * 60 * 60 * 1000;
    })(),
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
    // 0 是合法值（＝不等），所以不能写 `|| 4000`——那样就再也关不掉了。
    waitBeforeTurnMs: (() => {
      const v = Number(readField(visionRaw.waitBeforeTurnMs, 4000));
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    })(),
    // 同上：0 也是合法值（＝不等媒体落地，直接拍快照）。
    segmentWaitMs: (() => {
      const v = Number(readField(visionRaw.segmentWaitMs, 1500));
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 1500;
    })(),
  };
  // 人设（①）：只剩一个开关（`m24027` 删掉了 `defaultName` / `presets` 两个种子键）。
  // 旧配置里还留着它们的话不报错——记一句"现在去哪儿改"，免得用户改了发现没反应。
  const personaRaw = readField(raw.persona, {}) ?? {};
  const personaLegacy = ['defaultName', 'presets'].filter((key) => personaRaw[key] !== undefined);
  cfg.persona = {
    enabled: readField(personaRaw.enabled, true) !== false,
    ...(personaLegacy.length ? { legacyKeys: personaLegacy } : {}),
  };
  // 聊天命令（②）：**没配超管就是空的**（`ChatCommands.active` 会因此整条沉默）。
  const chatRaw = readField(raw.chatCommands, {}) ?? {};
  cfg.chatCommands = {
    enabled: readField(chatRaw.enabled, true) !== false,
    prefix: String(readField(chatRaw.prefix, '/') ?? ''),
    bypassPrefix: String(readField(chatRaw.bypassPrefix, '!!') ?? ''),
    superUsers: parseJsonValue(readField(chatRaw.superUsers, '[]'), []).map((v) => String(v)),
    maxReplyChars: Math.max(80, Number(readField(chatRaw.maxReplyChars, 1500)) || 1500),
  };
  // 表情包（④）：索引与图片固定落在 `<storageDir>/memes/`（跟着 storage 走，跨重启）。
  const memesRaw = readField(raw.memes, {}) ?? {};
  cfg.memes = {
    enabled: readField(memesRaw.enabled, true) !== false,
    topK: Math.max(1, Number(readField(memesRaw.topK, 50)) || 50),
    // 新入库那一段的条数（`m73189`）：0 = 不列（回到旧行为）。
    newShown: Math.max(0, Math.floor(Number(readField(memesRaw.newShown, 10)) || 0)),
    maxSend: Math.max(1, Number(readField(memesRaw.maxSend, 3)) || 3),
    maxCount: Math.max(1, Math.floor(Number(readField(memesRaw.maxCount, 200)) || 200)),
    autoCollect: readField(memesRaw.autoCollect, true) !== false,
    engine: (() => {
      const raw = String(readField(memesRaw.engine, 'builtin')).trim().toLowerCase();
      return MEME_ENGINES.includes(raw) ? raw : 'builtin';
    })(),
    pluginTool: String(readField(memesRaw.pluginTool, ''))
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
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
    maxSize: String(readField(imageGenRaw.maxSize, '2560x1440') ?? ''),
    minSize: String(readField(imageGenRaw.minSize, '') ?? ''),
    watermark: readField(imageGenRaw.watermark, false) === true,
    timeoutMs: Math.max(1000, Number(readField(imageGenRaw.timeoutMs, 120000)) || 120000),
    maxPerTurn: Math.max(1, Number(readField(imageGenRaw.maxPerTurn, 1)) || 1),
  };
  // engine / delivery（用户 2026-10-11 定）：engine 默认 builtin（老行为不变），delivery 默认
  // agent——生成后把图交给 agent 自己决定发不发，不再立刻直发（用户明确接受这个行为变化）。
  // 合法集收窄用 imagegen.js 导出的常量（与设置页下拉、client-manifest 测试同一份出处）。
  cfg.imageGen.engine = IMAGEGEN_ENGINES.includes(String(readField(imageGenRaw.engine, 'builtin') ?? '')) ? String(readField(imageGenRaw.engine, 'builtin')) : 'builtin';
  cfg.imageGen.delivery = IMAGEGEN_DELIVERIES.includes(String(readField(imageGenRaw.delivery, 'agent') ?? '')) ? String(readField(imageGenRaw.delivery, 'agent')) : 'agent';
  const imageGenPluginRaw = readField(imageGenRaw.plugin, {}) ?? {};
  const imageGenToolRaw = readField(imageGenPluginRaw.tool, null);
  cfg.imageGen.plugin = {
    tool: (Array.isArray(imageGenToolRaw)
      ? imageGenToolRaw
      : typeof imageGenToolRaw === 'string' && imageGenToolRaw.trim()
        ? imageGenToolRaw.split(/[,\s，、]+/)
        : []
    )
      .map((s) => String(s ?? '').trim())
      .filter(Boolean),
    timeoutMs: Math.max(1000, Number(readField(imageGenPluginRaw.timeoutMs, 180000)) || 180000),
  };
  // 语音合成（`m29000`）：与生图同一条纪律——`enabled` 只表示"愿意用"，真开关要配全
  // url/apiKey（`Tts.enabled` 自己再判一次）。格式认不出的按 mp3 收下、并在 stats 里说清。
  const ttsRaw = readField(raw.tts, {}) ?? {};
  const ttsFormat = String(readField(ttsRaw.format, 'mp3') ?? '').trim().toLowerCase();
  // 选了一家（`tts.provider`）就**按它那一套**：地址、形状、模型都取预设，手填的那三项
  // 只在服务商是 `custom` 时才生效（`m29830`——设置页已经把这三格藏起来了，代码就不能再听
  // 那三个看不见的旧值）。旧值不清掉，切回「自定义」时还在。
  const ttsTarget = resolveTtsTarget({
    provider: readField(ttsRaw.provider, 'custom'),
    // `baseUrl` 是旧键（`m30926` 在真机配置里还留着它）：认它当 `url`，免得手填过的人
    // 切到「自定义」时看见地址是空的、以为配置丢了。
    url: readField(ttsRaw.url, '') || readField(ttsRaw.baseUrl, ''),
    shape: ttsRaw.shape,
    model: readField(ttsRaw.model, ''),
    resourceId: readField(ttsRaw.resourceId, ''),
  });
  const ttsPluginRaw = readField(ttsRaw.plugin, {}) ?? {};
  const ttsPluginTools = String(readField(ttsPluginRaw, 'tool', '') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  cfg.tts = {
    enabled: readField(ttsRaw.enabled, false) === true,
    provider: ttsTarget.provider,
    pluginTools: ttsPluginTools,
    url: ttsTarget.url,
    shape: ttsTarget.shape,
    apiKey: String(readField(ttsRaw.apiKey, '') ?? ''),
    appId: String(readField(ttsRaw.appId, '') ?? '').trim(),
    cluster: String(readField(ttsRaw.cluster, '') ?? '').trim(),
    groupId: String(readField(ttsRaw.groupId, '') ?? '').trim(),
    resourceId: String(ttsTarget.resourceId ?? readField(ttsRaw.resourceId, '') ?? '').trim(),
    model: ttsTarget.model,
    voice: String(readField(ttsRaw.voice, '') ?? ''),
    format: TTS_FORMATS.has(ttsFormat) ? ttsFormat : 'mp3',
    speed: (() => {
      const v = Number(readField(ttsRaw.speed, 1));
      return Number.isFinite(v) && v > 0 ? v : 1;
    })(),
    instructions: String(readField(ttsRaw.instructions, '') ?? ''),
    refAudio: String(readField(ttsRaw.refAudio, '') ?? '').trim(),
    refText: String(readField(ttsRaw.refText, '') ?? '').trim(),
    refAudioField: String(readField(ttsRaw.refAudioField, 'ref_audio') ?? '').trim(),
    refTextField: String(readField(ttsRaw.refTextField, 'ref_text') ?? '').trim(),
    timeoutMs: Math.max(1000, Number(readField(ttsRaw.timeoutMs, 30000)) || 30000),
    maxChars: Math.max(1, Number(readField(ttsRaw.maxChars, 1000)) || 1000),
    cacheLimit: Math.max(0, Number(readField(ttsRaw.cacheLimit, 200)) || 0),
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
    trustedPrivates: readField(isolationRaw.trustedPrivates, '[]'),
    recallEscape: readField(isolationRaw.recallEscape, undefined),
    recallEscapeNeedsApproval: readField(isolationRaw.recallEscapeNeedsApproval, undefined),
    audit: readField(isolationRaw.audit, undefined),
    auditRetain: readField(isolationRaw.auditRetain, undefined),
  });
  // 白名单私聊没单独配，就吃聊天命令的超管名单（`m28425` 定案 ②）：超管本来就是"这台机器上
  // 说话算数的人"，让他自己的私聊能读全部会话是零配置可用的起点；名单为空 = 谁都不授权。
  if (!cfg.isolation.trustedPrivates.length) {
    cfg.isolation.trustedPrivates = [...parseTrustedPrivates(cfg.chatCommands.superUsers)].sort();
  }
  // 活跃层（`m17909`）：短期记忆的职能改成"进行中的话题 + agent 正在做的事"。
  const activeRaw = readField(memoryRaw.active, {}) ?? {};
  cfg.active = {
    enabled: readField(activeRaw.enabled, true) !== false,
    activeWindowDays: Math.max(0, Number(readField(activeRaw.activeWindowDays, 30)) || 0),
    injectLimit: Math.max(0, Number(readField(activeRaw.injectLimit, 8)) || 0),
    maxPerOrigin: Math.max(1, Number(readField(activeRaw.maxPerOrigin, 20)) || 20),
    dailySettleReminder: readField(activeRaw.dailySettleReminder, true) !== false,
  };
  // 别名：`Mind` 需要的是"这条链路上我自己是谁"，而 hub 用的是 upstreamSelfId。
  cfg.selfId = cfg.upstreamSelfId;
  cfg.nickname = cfg.upstreamNickname || undefined;
  return cfg;
}
