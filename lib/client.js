/**
 * 浏览器半侧：在「设置」里长出一个 **OneBot 枢纽** 页，直接编辑本插件的全部配置项。
 *
 * 为什么要自己写页面（而不是等宿主自动生成表单）：
 *  宿主 `@deepseek-ai/dsh-settings` 只会把**带 `volatile` 的字段**做成"可写字段"
 *  （`volatileForm()`），并把它们经 `settings` 命名空间交给客户端；但它
 *  `README.md:39` 明说「no shipped client does so yet」——**没有任何已发布客户端
 *  会按 schema 自动生成表单**。`ui-plugin-manager` 那边同理：只有当某个
 *  `plugins.row.config` 注册者点名这一行时，行详情页才存在。所以页面必须自带，
 *  否则设置里什么都看不到（这正是本插件曾经"配置页没了"的原因）。
 *
 * 这个文件（`lib/client.js`，与 profile 里其它客户端插件同位置）由宿主
 * `dsh-client-modules` 按 `package.json` 的 `dsh.client` + `exports['./client']`
 * 挂在 Loader 那一行上，**不经构建**：它是普通的模块加载器声明，不能出现 ESM
 * `export`。React 从模块表里取（`require('react')`），样式只用宿主主题 token
 * （`--dsw-alias-*`），不 require 任何 Harness 客户端包。
 *
 * **写法约束（踩过的坑，都拿别的插件对齐过）**：
 *   · 模块形状照抄 profile 里的既有客户端插件：`factory: (require) => {...}` 里
 *     自建 `module/exports`，末尾 `exports.apply = apply; exports.inject = inject;
 *     return module.exports;`；
 *   · `apply` **绝对不许抛**——`boot-client.ts:83` 的门禁是逐条看 fiber 状态，
 *     非 `active` 就 `web boot: N entries did not activate`，桌面壳会直接放弃启动
 *     （这一次就是这样把整个 App 拖死的）。槽位注册失败必须是"上报 + no-op disposer"，
 *     照既有插件的写法 `() => { try { return ctx.slots.register(...) } catch { return () => {} } }`；
 *   · 宿主对动态客户端半侧公开的 React 面只保证 `createElement` / `useState` /
 *     `useEffect`：只用这三个 + 下面的 `safeMemo`（`useMemo` 在才用，不在就直接算）；
 *   · 订阅、快照、渲染任何一步出错都**必须变成页面上的文字**，
 *     绝不能让它 throw 出去——槽位条目一崩整页就是白的（`slot entry crashed in '<slot>'`）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-onebot-hub',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    /**
     * 自诊断：把浏览器侧的错误送回宿主（宿主侧见 `lib/client-probe.js`）。
     *
     * 正常情况宿主已经在 `<head>` 里装了探针（`globalThis.__ONEBOT_HUB_PROBE__`，
     * 它在任何模块 bundle 之前执行，能抓到"bundle script failed to load"这类最要命的错误）。
     * 这里只是**兜底**：探针不在（老宿主、注入没生效）时自己装一个最小的，
     * 保证"页面为什么是白的"这件事至少有一条回传路径，而不是只躺在用户的控制台里。
     */
    const diagnostics = (() => {
      try {
        const existing = globalThis.__ONEBOT_HUB_PROBE__;
        if (existing && existing.ok) return existing;
        const buf = [];
        let timer = null;
        const flush = () => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            if (buf.length === 0) return;
            const items = buf.splice(0, buf.length);
            try {
              fetch('/onebot-hub/client-report' + location.search, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'client.js fallback', href: String(location.href).slice(0, 300), items }),
                keepalive: true,
              }).catch(() => {});
            } catch (err) {
              /* 上报失败绝不影响页面 */
            }
          }, 300);
        };
        const push = (kind, msg, extra) => {
          if (buf.length > 100) return;
          const item = { at: Date.now(), kind: String(kind).slice(0, 40), msg: String(msg == null ? '' : msg).slice(0, 1400) };
          if (extra) item.extra = String(extra).slice(0, 1400);
          buf.push(item);
          flush();
        };
        try {
          window.addEventListener('error', (ev) => {
            const target = ev && ev.target;
            if (target && target !== window && target !== document && (target.src || target.href)) {
              push('resource', `资源加载失败：${target.tagName || ''} ${target.src || target.href}`);
              return;
            }
            push('error', (ev && ev.message) || 'unknown', (ev && ev.error && ev.error.stack) || '');
          }, true);
          window.addEventListener('unhandledrejection', (ev) => {
            const reason = ev && ev.reason;
            push('rejection', (reason && reason.message) || reason, (reason && reason.stack) || '');
          });
          const origError = console.error;
          console.error = function (...args) {
            try {
              push(
                'console.error',
                args
                  .map((arg) => {
                    if (arg instanceof Error) return `${arg.message}\n${arg.stack || ''}`;
                    if (typeof arg === 'string') return arg;
                    try {
                      return JSON.stringify(arg);
                    } catch (err) {
                      return String(arg);
                    }
                  })
                  .join(' '),
              );
            } catch (err) {
              /* 忽略 */
            }
            return origError.apply(console, args);
          };
        } catch (err) {
          /* 忽略：监听器装不上也不该拖垮页面 */
        }
        const probe = { ok: true, report: push, dump: () => buf.slice() };
        globalThis.__ONEBOT_HUB_PROBE__ = probe;
        return probe;
      } catch (err) {
        return { ok: false, report: () => {}, dump: () => [] };
      }
    })();
    const report = (kind, msg, extra) => {
      try {
        diagnostics.report(kind, msg, extra);
      } catch (err) {
        /* 诊断通道本身绝不许抛 */
      }
    };
    let reportedOnce = false;
    report('client-half', `factory 已执行（探针来源：${diagnostics.ok ? 'globalThis' : '不可用'}）`);

    let React;
    try {
      React = require('react');
    } catch (err) {
      report('client-half', `require('react') 失败：${err?.message ?? err}`, err?.stack);
      React = undefined;
    }
    /** 没有 React 就没有页面：`h` 退化成空元素，apply 会在入口如实上报后安静退出。 */
    const h = React && typeof React.createElement === 'function' ? React.createElement : () => null;

    /** 顶层分组的读法；没列到的键归到「其它」。嵌套对象各自成组。 */
    const FAMILY_LABELS = {
      agent: 'Agent（会话代理）',
      capability: '能力面（只读 / 写 / 危险闸门）',
      media: '媒体落地（图片、语音、文件）',
      turns: '回合配对',
      learn: '用法学习（下游会吃什么消息）',
      code: '下游源码范围（多条；agent 需要时取）',
      cards: '会话卡落盘',
      members: '成员名解析',
      vision: '看图（M14-V：描述 / 内容段）',
      persona: '人设与预设',
      chatCommands: '聊天管理命令',
      memes: '表情包库',
      anime: '二次元识别',
      imageGen: '生图',
      memory: '记忆与隔离',
    };

    /**
     * **每一个**配置项的界面文字：`label` 是中文名，`note` 是一句话说明"这项到底管什么、
     * 改了会怎样"。键是**完整配置路径**（`agent.mode` 而不是 `mode`）——按最后一段查表会撞车
     * （`enabled` / `limit` / `timeoutMs` 在好几族里都有，含义完全不同）。
     *
     * **严格 JSON**（双引号、无注释、无尾逗号）：`test/load-check.mjs` 会用括号配对把它抠出来
     * `JSON.parse`，再和**真实 schema 的叶子清单**对账——少一个字段、多一个不存在的字段，
     * 或者哪条没写中文，测试都直接红。新增配置项时**必须同时在这里补一条**。
     *
     * 客户端半侧没法 import 宿主代码（combo 脚本是各包 `client.js` 的经典脚本拼接，不经打包器），
     * 所以这张表只能自己维护；靠上面的对账测试防漂移。
     */
    const FIELD_TEXT = {
      "enabled": { "label": "总开关", "note": "关掉后整条链静默：不连上下游、不喂模型。profile 里写 false 就等于停用本插件。" },
      "upstreamUrl": { "label": "上游地址（我们拨出去）", "note": "正向 WebSocket 地址，形如 ws://127.0.0.1:3001。与 upstreamListen 二选一。" },
      "upstreamSelfId": { "label": "上游账号", "note": "上游实现端登录的 QQ 号；用来认出\"哪条消息是我们自己发的\"。留空 = 连上后自动认（握手头 / 事件 / get_login_info），下游\"不写对方账号\"的目标也会自动跟着它。" },
      "upstreamNickname": { "label": "上游昵称", "note": "上游账号的昵称（备用，昵称识别时用）。" },
      "upstreamListen": { "label": "反向监听地址（含路径）", "note": "上游（LLBot 等）主动拨进来的完整地址：host:port + 路径，如 127.0.0.1:8765/onebot/v11/ws（也能直接粘 ws:// 完整 URL）。**不写路径 = 只接受根路径 /**（写什么就是什么，不偷偷补默认）；留空 = 不监听。" },
      "upstreamAccessToken": { "label": "上游 access token（凭据）", "note": "留空 = 不校验；设了就要求 Bearer 或 ?access_token=。不回显明文。" },
      "downstreamAccessToken": { "label": "下游 access token（凭据）", "note": "校验下游拨入/推事件时的 token，留空 = 不校验。不回显明文。" },
      "downstreamTargets": { "label": "下游目标（可多条）", "note": "一条 = 一个下游连接。类型四种：ws-dial（我们拨过去）｜ws-listen（我们监听、对方拨进来）｜http-api（我们提供 HTTP API）｜http-post（我们把事件 POST 给对方）。地址统一写 host:port/path（scheme 可省，按类型补 ws:// 或 http://）；对方账号留空 = 与上游账号相同；取消勾选 = 这条先不连（配置留着）。空 = 没有下游。可选字段：probeSelfId = 这条目标**自己的探针账号**——写了它就等于一次声明两条链路：主链路照旧，另加一条 probeOnly 的探针链路（**地址与本条相同、只有对方账号不同**，共用本条的地址/口令/下游组，id 是 `<id>~probe`），不用写两条必须互相对齐的条目；下游那侧要按这个账号再连一条（NoneBot 按 self_id 注册，同 id 第二条会被踢掉）；probeOnly=true 表示这条链路只收 onebot_invoke 的注入、不收上游真人消息（配合探针隔离的 link 档）；downstreamId 用来声明\"哪几条链路是同一个下游\"（缺省 = 对方账号），状态与时间线都带上它。" },
      "preset": { "label": "策略预设", "note": "决定谁管链路、事件怎么投：relay 管理者+透传 / solo（事件不给下游）｜shadow（只观察：hub 不叫模型、不代答、不发消息）｜bridge（下游 send_msg 真发上游，同时广播给其它下游）｜fabric（下游 send_msg 只广播给其它下游，不惊动 QQ）。" },
      "deliveryMode": { "label": "投递模式", "note": "事件投给下游的方式：transparent 原帧重签 / replay 按目标账号重放 / synthesize 合成事件。" },
      "broadcast": { "label": "广播到所有下游", "note": "一条入站消息是否投给每条下游链路（关掉只投给首个可用链路）。" },
      "readonly": { "label": "只读（hub 不动作）", "note": "打开后 hub 自己绝不动作：不唤醒 agent（不花 token）、不代答聊天命令、也不发消息；事件照旧广播给下游。shadow 预设自带打开；只能打开，关不掉预设自带的那份。" },
      "deliverMessageSent": { "label": "也投递 message_sent", "note": "打开后把\"自己发的消息\"也当事件投给下游（默认关，防回声）。" },
      "virtualizeMessageId": { "label": "虚拟化消息 id", "note": "透传时改写 message_id，避免上下游 id 空间撞车；部分下游依赖真实 id，慎开。" },
      "reconnectInterval": { "label": "重连间隔（ms）", "note": "下游断线后多久重拨一次。" },
      "requestTimeout": { "label": "action 超时（ms）", "note": "等实现端回 echo 的上限，超时返回 1200 错误。" },
      "heartbeatTimeout": { "label": "心跳超时（ms）", "note": "监听端多久没收到任何帧就判定上游掉线并断开。" },
      "downstreamHeartbeatMs": { "label": "下游心跳间隔（ms）", "note": "枢纽主动向下游发心跳的频率。" },
      "echoWindowMs": { "label": "echo 配对窗口（ms）", "note": "回合配对时，在这段时间内找下游的应答。" },
      "maxHop": { "label": "最大跳数", "note": "防环：事件已带的跳数达到它就停止转发。" },
      "actionPolicy": { "label": "action 策略（JSON）", "note": "JSON：逐 action 的允许/拒绝规则（与 capability 白名单一起生效）。" },
      "logFrames": { "label": "打印帧日志", "note": "打开后每个 OneBot 帧都写日志，排查用（量很大）。" },
      "persist": { "label": "落盘", "note": "关掉后时间线/记忆/表情包都不写盘，重启即空（调试用）。" },
      "storageDir": { "label": "存储目录", "note": "留空 = 用宿主 profile 下的默认目录；所有 jsonl 与媒体 blob 都在这里。" },
      "agent.mode": { "label": "代理模式", "note": "assist 平时休眠、被叫到才醒（醒了就持续参与一会儿）/ observer 只看不说（不喂模型）/ active 休眠时每 5 分钟看一眼有没有新消息。" },
      "agent.batchSize": { "label": "一批最多几条", "note": "激活状态下攒够这么多条就唤醒一次；休眠时收到的话只是攒着（下次醒来一起看）。" },
      "agent.batchMs": { "label": "攒批等待（ms）", "note": "激活状态下从第一条新消息算起，等这么久就把这一批交给模型。" },
      "agent.maxActive": { "label": "同时活跃的会话数", "note": "超过就按最近活跃淘汰，防会话池无限涨。" },
      "agent.idleDisposeMs": { "label": "空闲回收（ms）", "note": "会话多久没动静就释放它的 agent（下次再建）。" },
      "agent.tickMs": { "label": "调度节拍（ms）", "note": "批量窗口、激活超时与社交能量的检查频率。" },
      "agent.silenceWhenDownstreamResponded": { "label": "下游答过就闭嘴", "note": "打开后下游 bot 已应答的消息不再喂模型（命令静默）。" },
      "agent.wakeOnPrivate": { "label": "私聊也唤醒", "note": "打开时私聊每条都算被叫到（立刻醒）；关掉后私聊只转发、不叫模型。" },
      "agent.wakeOnNotice": { "label": "通知类也唤醒", "note": "戳一戳、群名片变更等 notice 是否也叫模型（默认关）。" },
      "agent.speakAssistantText": { "label": "把回复文本当发言（老行为）", "note": "默认关：发言一律走 onebot_reply 工具，模型写在回复里的文字只是内部草稿、不发进聊天；打开才恢复『文本兜底＝发言』的老行为。" },
      "agent.awakeMs": { "label": "激活空转上限（ms）", "note": "最后一次有人说话或它自己回话之后，这么久两边都没动静就回到休眠；0 = 不超时（一直挂着激活状态）。" },
      "agent.activeTickMs": { "label": "active 判断间隔（ms）", "note": "active 档休眠时每隔这么久看一眼该会话有没有新消息，有就唤醒一次。" },
      "agent.guidance": { "label": "追加指导（每轮注入）", "note": "写在这里的话每轮都作为系统段进模型，用来调语气、加规矩。" },
      "agent.defaultModel": { "label": "默认聊天模型", "note": "留空跟 DSH 系统默认路由；从 DSH 的模型清单里选一个就以它为默认，会话里 /model default 也复位回它。清单取不到时退回手写。" },
      "agent.defaultVisionModel": { "label": "默认识图模型", "note": "留空用系统默认模型；选一个就以它为看图默认，会话里 /vmodel 仍然可以覆盖。" },
      "agent.defaultReasoningEffort": { "label": "聊天思考强度", "note": "跟上面那个模型配对；档位从该模型的 reasoning 里出（上游 DSH 没给它声明档位就不列）。留空 = 模型自己的默认。" },
      "agent.defaultVisionReasoningEffort": { "label": "识图思考强度", "note": "跟默认识图模型配对，同上；留空 = 模型自己的默认。" },
      "agent.groups": { "label": "群白名单", "note": "只有列出的群才会调模型（没列的群 @ 也不理）；每条可单独选模式，留「跟随全局」就用上面的代理模式。" },
      "agent.privates": { "label": "私聊白名单", "note": "只有列出的 QQ 号才会调模型；同样可单独选模式。两张名单都是白名单制：清空 = 全部静音。" },
      "agent.steer": { "label": "激活期插话", "note": "打开时，回合没跑完就来的新消息会直接插进正在进行的回合（模型下一步就能看到）；关掉则排队等这一轮说完再看。" },
      "agent.replyGapMs": { "label": "多条消息的间隔（ms）", "note": "一次 onebot_reply 拆成多条时，条与条之间等这么久（像人在一句句打字）。0 = 连发不带停顿。" },
      "agent.replyMaxText": { "label": "一次回复最多几条文字", "note": "只限文字消息的条数——图片不占额度（图另有上限）。超出部分不发送，并在工具回执里如实告知模型。" },
      "agent.replyMaxImages": { "label": "一次回复最多几张图", "note": "图片/表情包的条数上限（每张各自发一条消息）。0 = 不限。" },
      "capability.writeAllow": { "label": "写操作白名单（JSON）", "note": "JSON 数组：允许下调的写级 action（如 send_msg）；空 = 全部拒绝。" },
      "capability.dangerAllow": { "label": "危险操作白名单（JSON）", "note": "JSON 数组：踢人/禁言/退群一类；空 = 全部拒绝。" },
      "capability.exposeSensitive": { "label": "回显敏感字段", "note": "打开后只读查询里带 token 之类字段（默认关，防泄漏）。" },
      "capability.cache": { "label": "只读查询缓存", "note": "打开后 get_group_info 之类有 TTL 缓存，返回里 source=cache。" },
      "capability.probe": { "label": "主动探测能力", "note": "启动后自测哪些 action 可用，结果进 onebot_caps。" },
      "capability.downstreamReads": { "label": "下游只读查询", "note": "允许把下游链路也当作实现端来查。" },
      "capability.callTimeoutMs": { "label": "只读查询超时（ms）", "note": "单次 action 调用的等待上限。" },
      "capability.probeTimeoutMs": { "label": "探测超时（ms）", "note": "能力自测里每个 action 的等待上限。" },
      "media.enabled": { "label": "媒体落地", "note": "关掉后图片/语音/文件都不落地，也就没有 durable ref。" },
      "media.keepBytes": { "label": "保留原始字节", "note": "打开后 blob 存字节，上游 URL 过期也不影响引用。" },
      "media.transcribe": { "label": "语音转写", "note": "试实现端的转写能力；拿不到就如实说\"听不了\"，不猜内容。" },
      "media.maxBytes": { "label": "单文件字节上限", "note": "超过就拒绝落地。" },
      "media.fetchTimeoutMs": { "label": "取媒体超时（ms）", "note": "下载图片/语音的等待上限。" },
      "turns.windowMs": { "label": "配对窗口（ms）", "note": "入站消息之后多久内，下游的 send_* 才算它触发的。" },
      "turns.retain": { "label": "保留回合数", "note": "内存里最多留多少条回合记录。" },
      "probe.isolation": { "label": "探针隔离", "note": "agent 用 onebot_invoke 试探下游时怎么和真人消息隔开。off（默认）=不隔离，注入与真人消息走同一条链路；time=探测窗口内该会话的上游消息暂缓投下游、窗口一到按原序补发（不需要额外配置）；link=上游消息一条都不投给探针链路、注入只走那条——探针链路要在下游目标里填 **probeSelfId**（同一个下游的另一个 bot 账号，地址不用改），一个都没配时这一档会**自动回退到 off**。开了链路隔离后，探针结果**可能与用户触发时不同**（这条会写进给 agent 的指导段与每次注入的结果里）。" },
      "probe.windowMs": { "label": "探测窗口（ms）", "note": "time 档：注入之后多久算这个会话的独占窗口。窗口内的真人消息只是晚到，不会丢。" },
      "probe.maxQueued": { "label": "窗口排队上限", "note": "安全阀：排到这个数就立刻按原序补发，绝不吞消息。" },
      "probe.capture": { "label": "探针链路只捕获不转发", "note": "link 档：探针链路的 send_* 只记进时间线/捕获账本，不真的发到 QQ——探针产物先给 agent 看，要不要说由它决定（默认开）。" },
      "retention.days": { "label": "原始报文保留天数", "note": "收到的每条消息都会缓存原文 + 索引（包括 hub 解析不了的段、以及**不展开**的聊天记录），agent 需要时自己取原文解析。超过这么多天自动清掉：落盘的原始报文日文件、索引里的旧行、以及媒体 blob。**0 = 不清理**。" },
      "retention.cleanupIntervalMs": { "label": "清理间隔（ms）", "note": "多久跑一次保留期清理（默认 6 小时）。启动时也会先跑一次。" },
      "learn.threshold": { "label": "几次观测算数", "note": "下游真响应过 N 次，才把这条用法升为 active。" },
      "learn.staleAfter": { "label": "几次没复现降级", "note": "连续 N 次未复现就标 stale、降置信。" },
      "learn.forgetAfter": { "label": "几次没复现删除", "note": "连续 N 次未复现才真正从表里删掉。" },
      "learn.maxEvidence": { "label": "每条最多留几条证据", "note": "证据是\"哪条消息触发了什么\"，用于回看。" },
      "code.scopes": { "label": "下游源码范围（可多条）", "note": "一条 = 一个下游的源码在哪（可能有多个下游）。备注可空。**这些路径不写进 prompt**：agent 需要时调 onebot_code_scopes 取位置，读文件用它自己带的工具（read/grep/glob）——枢纽不代读、也不需要配扫描器。权限由超管在会话里给（或 /perm）。空 = agent 问位置时如实说没配。" },
      "cards.maxLines": { "label": "会话卡最多几行", "note": "每张会话卡保留的行为条数。" },
      "cards.maxSessions": { "label": "最多几张会话卡", "note": "超过按最久没用的淘汰。" },
      "members.enabled": { "label": "按需解析成员名", "note": "at 到还没名字的人时问一次实现端（比一直叫\"用户10002\"强）。" },
      "members.cooldownMs": { "label": "同一人冷却（ms）", "note": "多久之内不再为同一个人问名字。" },
      "members.maxPerMessage": { "label": "每条最多问几个", "note": "一条消息里最多解析几个陌生人，防刷。" },
      "members.maxQueue": { "label": "排队上限", "note": "待解析队列满了就丢弃新的。" },
      "vision.mode": { "label": "看图模式", "note": "describe 让视觉模型给描述 / segment 只把图片段交给会话模型 / both / off。识图模型默认用系统默认模型，要按会话换就用模型切换命令（按下面的命令前缀，默认是 /vmodel）。" },
      "vision.prompt": { "label": "用户侧提示词", "note": "给视觉模型的图描述要求；留空用内置中文提示。" },
      "vision.system": { "label": "系统提示", "note": "视觉模型的 system 段。" },
      "vision.maxTokens": { "label": "单次最多输出 token", "note": "0 = 不传该参数（默认，描述不做长度控制）；填 >0 才给单次生成加上限。" },
      "vision.timeoutMs": { "label": "超时（ms）", "note": "等描述的上限，超时就放弃并如实说明。" },
      "vision.cacheLimit": { "label": "缓存张数", "note": "按 sha256 缓存描述，同一张图不重复问。" },
      "persona.enabled": { "label": "人设", "note": "关掉后没有角色设定段，模型按默认风格说话。" },
      "persona.defaultName": { "label": "默认预设名", "note": "新会话没绑定过角色时用哪一个预设。" },
      "persona.presets": { "label": "预设库（JSON）", "note": "JSON 数组：启动时的种子；之后以落盘的 bindings.json 为准（空 = 用内置 default）。" },
      "chatCommands.enabled": { "label": "聊天管理命令", "note": "关掉后 /status 一类命令不再由枢纽处理（消息照常转发给下游）。" },
      "chatCommands.prefix": { "label": "命令前缀", "note": "默认 /；它是公共前缀，下游有同名命令也照常触发，枢纽不抢。" },
      "chatCommands.bypassPrefix": { "label": "让路前缀", "note": "默认 !!：!!/reset 连枢纽那条回话都不要，当普通消息走。" },
      "chatCommands.superUsers": { "label": "超管名单（JSON）", "note": "JSON 数组，如 [\"10001\"]；空 = 整条链沉默（不猜谁是管理员）。" },
      "chatCommands.maxReplyChars": { "label": "回话长度上限", "note": "超长就截断，防刷屏。" },
      "memes.enabled": { "label": "表情包库", "note": "关掉后不收集也不发送表情。" },
      "memes.topK": { "label": "上下文里列几张", "note": "装配 prompt 时最多列几个候选 id。" },
      "memes.maxSend": { "label": "一次最多发几张", "note": "单条回复里的表情数量上限。" },
      "memes.maxCount": { "label": "库容量上限（张）", "note": "超过后自动淘汰最少用、最久未用的；最近用过的几张受保护。改动重启后生效。" },
      "memes.autoCollect": { "label": "允许收录", "note": "关掉后 agent 也不许收录表情包（库只读）。收集本身由 agent 判断，不自动收。" },
      "anime.backend": { "label": "识番后端", "note": "off 完全关 / anime-recognize 本地 / animetrace 线上 / both 本地优先。" },
      "anime.recognizeUrl": { "label": "本地识别接口", "note": "anime-recognize 服务的地址。" },
      "anime.recognizeToken": { "label": "本地识别 token（凭据）", "note": "留空 = 不带鉴权头。不回显明文。" },
      "anime.animetraceUrl": { "label": "AnimeTrace 地址", "note": "默认官方接口，可换自建。" },
      "anime.minConfidence": { "label": "置信度下限", "note": "低于它不报角色名（宁缺毋滥）。" },
      "anime.maxCharacters": { "label": "最多报几个角色", "note": "超出按置信度截断。" },
      "anime.nsfwThreshold": { "label": "NSFW 阈值", "note": "超过就不发识别结果（防翻车）。" },
      "anime.timeoutMs": { "label": "超时（ms）", "note": "识别请求的等待上限。" },
      "anime.cacheLimit": { "label": "缓存张数", "note": "按 sha256 缓存识别结果。" },
      "imageGen.enabled": { "label": "生图", "note": "默认关；开了还要配 model/baseUrl/apiKey，缺一个仍是关。" },
      "imageGen.model": { "label": "模型名", "note": "OpenAI 兼容生图接口的模型 id。" },
      "imageGen.baseUrl": { "label": "接口地址", "note": "形如 https://…/v1（不要带 /images/generations）。" },
      "imageGen.apiKey": { "label": "API Key（凭据）", "note": "留空 = 不改。不回显明文。" },
      "imageGen.maxSize": { "label": "尺寸上限", "note": "形如 1024x1024；请求的 size 会等比内缩到它以内。" },
      "imageGen.minSize": { "label": "尺寸下限", "note": "留空 = 不设下限。" },
      "imageGen.watermark": { "label": "加水印", "note": "非 OpenAI 官方参数，默认不发；显式开启才透传 watermark 给支持它的中转接口。" },
      "imageGen.timeoutMs": { "label": "超时（ms）", "note": "生图等待上限（图确实慢，默认给得很宽）。" },
      "imageGen.maxPerTurn": { "label": "每轮最多几张", "note": "一轮对话里的硬上限，超了明确说\"这轮画完了\"。" },
      "imageGen.engine": { "label": "生图引擎", "note": "builtin＝hub 自带的 OpenAI 兼容生图（默认）；plugin＝不自己生图，把第三方插件的生图工具放进 agent 工具面。" },
      "imageGen.delivery": { "label": "生成后发送时机", "note": "agent（默认）＝生成后由 agent 决定发不发群；direct＝生成完立刻直发到指定会话。" },
      "imageGen.plugin.tool": { "label": "第三方生图工具名", "note": "engine=plugin 时用；逗号分隔或数组。留空＝自动探测（generate_image 等已知名单）。" },
      "imageGen.plugin.timeoutMs": { "label": "探测/后处理超时（ms）", "note": "预留的后处理等待上限，当前主要留作扩展。" },
      "memory.limit": { "label": "记忆总条数上限", "note": "超过就按重要度与新旧淘汰。" },
      "memory.reminders.enabled": { "label": "定时提醒", "note": "打开后\"答应过的事\"到期会冒出来提醒。" },
      "memory.reminders.windowHours": { "label": "提醒窗口（小时）", "note": "到期前后多久内算\"该提了\"。" },
      "memory.reminders.limit": { "label": "一次提几条", "note": "单轮最多提醒几条。" },
      "memory.reminders.max": { "label": "最多存几条提醒", "note": "超过淘汰最旧的。" },
      "memory.isolation.level": { "label": "隔离级别", "note": "strict 只在本会话 / scoped 按会话可见（默认）/ balanced 折中 / open 最松。" },
      "memory.isolation.crossGroupIdentity": { "label": "跨群认同一个人", "note": "打开后同一个人在不同群共用一个档案。" },
      "memory.isolation.crossGroupFacts": { "label": "跨群事实", "note": "shareable 标记过的可跨群（默认）/ never 永不 / all 全部。" },
      "memory.isolation.privateFacts": { "label": "私聊事实", "note": "never 私聊内容不出私聊（默认）/ sameActor 同一个人可见 / all 全部。" },
      "memory.isolation.sensitivityAlwaysLocal": { "label": "敏感内容永远本地", "note": "打开后敏感事实不参与跨会话装配（不看 level）。" },
      "memory.isolation.overrides": { "label": "逐项覆盖（JSON）", "note": "JSON 数组：给单条记忆指定可见范围。" },
      "memory.isolation.trustedGroups": { "label": "可信群（JSON）", "note": "JSON 数组：这些群之间可以互相看见（仍受 level 约束）。" },
      "memory.isolation.recallEscape": { "label": "允许越界检索", "note": "打开后 onebot_recall 能跨会话翻旧账（默认关）。" },
      "memory.isolation.recallEscapeNeedsApproval": { "label": "越界要确认", "note": "打开后越界检索要显式 confirm 才给。" },
      "memory.isolation.audit": { "label": "留审计", "note": "每次放行/拦截都记一条，可用 onebot_memory_audit 查。" },
      "memory.isolation.auditRetain": { "label": "审计保留条数", "note": "账本最多留多少条。" }
    };

    /**
     * 取值封闭的字段 → 下拉列表。**严格 JSON**（双引号、无注释、无尾逗号），
     * 因为 `test/client-manifest.mjs` 会用括号配对把它抠出来 `JSON.parse`，
     * 再和宿主的单一出处逐一对齐（`AGENT_MODES` / `VISION_MODES` /
     * `ISOLATION_LEVELS` / `CROSS_GROUP_FACTS` / `PRIVATE_FACTS` /
     * `ANIME_BACKENDS` / `PRESETS` / `DELIVERY_MODES`），防止两边漂移。
     *
     * 客户端半侧没法 import 宿主代码（combo 脚本是各包 `client.js` 的经典脚本拼接，
     * 不经打包器），所以只能在这里抄一份**取值**；标签是给人看的说明，
     * 不在测试比对范围内。默认值排在第一位。
     */
    const ENUM_OPTIONS = {
      "preset": [
        { "value": "relay", "label": "relay · 管理者+透传（默认）" },
        { "value": "solo", "label": "solo · 事件不给下游，只本地观察" },
        { "value": "shadow", "label": "shadow · 影子观察：全量转发，hub 不叫模型/不代答/不发消息" },
        { "value": "bridge", "label": "bridge · 双向桥：下游 send_msg 真发上游 + 广播其它下游" },
        { "value": "fabric", "label": "fabric · 织网：下游 send_msg 只广播其它下游，不惊动 QQ" }
      ],
      "deliveryMode": [
        { "value": "transparent", "label": "transparent · 原帧重签后照发（默认）" },
        { "value": "replay", "label": "replay · 按目标链路的账号重放" },
        { "value": "synthesize", "label": "synthesize · 合成事件（有系统性失效，慎用）" }
      ],
      "agent.mode": [
        { "value": "assist", "label": "assist · 助手：平时休眠，被叫到才醒（默认）" },
        { "value": "observer", "label": "observer · 只看不说（不喂模型）" },
        { "value": "active", "label": "active · 休眠时每 5 分钟看一眼新消息" }
      ],
      "vision.mode": [
        { "value": "describe", "label": "describe · 看图给描述（默认）" },
        { "value": "segment", "label": "segment · 只解析媒体段" },
        { "value": "both", "label": "both · 解析段 + 看图" },
        { "value": "off", "label": "off · 关" }
      ],
      "probe.isolation": [
        { "value": "off", "label": "off · 不隔离（默认，注入与真人消息走同一条链路）" },
        { "value": "time", "label": "time · 探测窗口内暂缓该会话的上游消息（不需要额外配置）" },
        { "value": "link", "label": "link · 上游消息不投探针链路，注入只走那条（要填 probeSelfId：同一下游的另一个机器人账号）" }
      ],
      "anime.backend": [
        { "value": "off", "label": "off · 关（默认）" },
        { "value": "anime-recognize", "label": "anime-recognize · 本地 anime-recognize" },
        { "value": "animetrace", "label": "animetrace · animetrace.com" },
        { "value": "both", "label": "both · 本地优先，失败再走线上" }
      ],
      "imageGen.engine": [
        { "value": "builtin", "label": "builtin · hub 自带生图（默认，OpenAI 兼容接口）" },
        { "value": "plugin", "label": "plugin · 委托第三方插件的生图工具" }
      ],
      "imageGen.delivery": [
        { "value": "agent", "label": "agent · 生成后由 agent 决定发不发群（默认）" },
        { "value": "direct", "label": "direct · 生成完立刻直发到指定会话" }
      ],
      "memory.isolation.level": [
        { "value": "scoped", "label": "scoped · 按会话可见（默认）" },
        { "value": "strict", "label": "strict · 最严，只在本会话内" },
        { "value": "balanced", "label": "balanced · 折中" },
        { "value": "open", "label": "open · 最松" }
      ],
      "memory.isolation.crossGroupFacts": [
        { "value": "shareable", "label": "shareable · 标记为 shareable 的事实可跨群（默认）" },
        { "value": "never", "label": "never · 永不跨群" },
        { "value": "all", "label": "all · 全部跨群" }
      ],
      "memory.isolation.privateFacts": [
        { "value": "never", "label": "never · 私聊内容不出私聊（默认）" },
        { "value": "sameActor", "label": "sameActor · 同一个人在哪都可见" },
        { "value": "all", "label": "all · 全部可见" }
      ]
    };

    /**
     * 「从 DSH 模型清单里选」的四个字段（m024193）。
     *
     * 为什么不在 `ENUM_OPTIONS` 里：那份是**静态**取值表（抄一份防漂移，测试逐一对齐），
     * 而模型清单只有宿主 `llm` 服务知道（设置页在浏览器半侧，拿不到服务），所以选项是
     * 运行时从 `lib/llm-models.js` 那条只读路由取回来的。
     *
     * **严格 JSON**（同 `ENUM_OPTIONS`/`LIST_EDITORS`，`test/client-manifest.mjs` 会
     * 括号配对抠出来 `JSON.parse`）：这里只声明"谁配对谁、为什么"，不抄任何模型 id。
     */
    const MODEL_FIELDS = {
      "agent.defaultModel": { "kind": "model" },
      "agent.defaultVisionModel": { "kind": "model" },
      "agent.defaultReasoningEffort": { "kind": "effort", "modelKey": "agent.defaultModel" },
      "agent.defaultVisionReasoningEffort": { "kind": "effort", "modelKey": "agent.defaultVisionModel" }
    };

    /**
     * 需要**结构化编辑**的 JSON 字符串字段：一行一条，能加、能删、能逐条停用。
     *
     * 为什么要有它：`downstreamTargets` 是"连接多个下游"的入口（§19），让人手写
     * `[{"url":"ws://…","selfId":"…"}]` 这种长 JSON 迟早会写错一个逗号。这里的行编辑只
     * 负责**拼/拆那个 JSON 字符串**（schema 仍是字符串，profile 里已存的值一字不动），
     * 所以老配置、手改配置文件、单条目标这些用法全都不受影响。
     *
     * **严格 JSON**（同 `ENUM_OPTIONS`/`FIELD_TEXT`，测试要用括号配对抠出来比对）。
     * `secret: true` 的列渲染成密码框；`numeric: true` 的列存成数字。
     */
    const LIST_EDITORS = {
      "downstreamTargets": {
        "label": "下游目标",
        "addLabel": "添加一个下游",
        "kind": "targets",
        "columns": [
          {
            "key": "type",
            "label": "类型",
            "options": [
              { "value": "ws-dial", "label": "ws-dial · 我们拨过去（默认）" },
              { "value": "ws-listen", "label": "ws-listen · 我们监听，对方拨进来" },
              { "value": "http-api", "label": "http-api · 我们提供 HTTP API" },
              { "value": "http-post", "label": "http-post · 我们把事件 POST 给对方" }
            ]
          },
          { "key": "address", "label": "地址", "placeholder": "127.0.0.1:8080/onebot/v11/ws（含路径）" },
          { "key": "selfId", "label": "对方账号", "placeholder": "留空 = 与上游账号相同" },
          { "key": "nickname", "label": "备注名", "placeholder": "probe-bot（可空）" },
          { "key": "accessToken", "label": "token", "placeholder": "留空 = 不校验", "secret": true },
          { "key": "probeSelfId", "label": "探针账号", "placeholder": "同一下游的另一个机器人账号（留空 = 不要探针链路）" },
          { "key": "downstreamId", "label": "下游组", "placeholder": "留空 = 按对方账号归组" },
          { "key": "reconnectInterval", "label": "重连(ms)", "placeholder": "5000（可空）", "numeric": true }
        ]
      },
      "code.scopes": {
        "label": "下游源码范围",
        "addLabel": "添加一个范围",
        "kind": "scopes",
        "columns": [
          { "key": "name", "label": "备注", "placeholder": "下游A（可空）" },
          { "key": "path", "label": "源码路径", "placeholder": "D:/somewhere/my-bot" }
        ]
      },
      "agent.groups": {
        "label": "群白名单",
        "addLabel": "添加一个群",
        "kind": "whitelist",
        "columns": [
          { "key": "id", "label": "群号", "placeholder": "123456789" },
          {
            "key": "mode",
            "label": "模式",
            "options": [
              { "value": "", "label": "跟随全局" },
              { "value": "observer", "label": "observer · 只看不说" },
              { "value": "assist", "label": "assist · 被叫到才醒" },
              { "value": "active", "label": "active · 常看新消息" }
            ]
          }
        ]
      },
      "agent.privates": {
        "label": "私聊白名单",
        "addLabel": "添加一个 QQ",
        "kind": "whitelist",
        "columns": [
          { "key": "id", "label": "QQ 号", "placeholder": "10001" },
          {
            "key": "mode",
            "label": "模式",
            "options": [
              { "value": "", "label": "跟随全局" },
              { "value": "observer", "label": "observer · 只看不说" },
              { "value": "assist", "label": "assist · 被叫到才醒" },
              { "value": "active", "label": "active · 常看新消息" }
            ]
          }
        ]
      }
    };

    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    /**
     * 模型清单只读路由（m024193，宿主侧实现见 `lib/llm-models.js` 的 `MODEL_LIST_PATH`）。
     * **两处字面量必须一致**：`test/client-manifest.mjs` 会抠出宿主那份来比对。
     * 拿不到（老宿主、路由没装、被反向代理挡了）时设置页退回手写，功能不受影响。
     */
    const HUB_MODEL_LIST_PATH = '/onebot-hub/llm-models';
    /** 进程内缓存：同一页反复进出不该每次都问宿主要清单（模型清单变动极少）。 */
    const modelListCache = { value: null };

    /**
     * 取一次 DSH 模型清单。结果形状见 `lib/llm-models.js`：
     * `{ ok, providers: [{ id, name, models: [{ id, name, inputModalities }], note }], note }`。
     * 失败**不抛**：返回 `{ available: false, providers: [], note }`，页面照旧渲染。
     */
    const fetchModelList = async () => {
      if (modelListCache.value) return modelListCache.value;
      try {
        const res = await fetch(HUB_MODEL_LIST_PATH + location.search, {
          headers: { accept: 'application/json' },
        });
        if (!res || !res.ok) {
          const body = await modelListText(res);
          return { available: false, providers: [], note: `模型清单路由返回 ${res ? res.status : '（无响应）'}${body ? `：${body}` : ''}` };
        }
        const body = await res.json();
        const providers = Array.isArray(body && body.providers) ? body.providers : [];
        modelListCache.value = {
          available: body && body.ok === true && providers.length > 0,
          providers,
          note: String((body && body.note) || ''),
        };
        return modelListCache.value;
      } catch (err) {
        return { available: false, providers: [], note: `取模型清单失败：${(err && err.message) || err}` };
      }
    };
    const modelListText = async (res) => {
      try {
        const text = await res.text();
        return text ? String(text).slice(0, 200) : '';
      } catch {
        return '';
      }
    };

    /**
     * 某个模型的思考强度档位（**按需问**，不预取全部模型——那要 N 次 resolveModelInfo）。
     * 结果：`{ ok, efforts: [{ value, label }], defaultEffort, note }`；失败/没声明都如实回
     * `ok:false` 或空数组，页面退回文本框。缓存按 `provider/model` 记（档位极少变）。
     */
    const effortCache = {};
    const fetchEfforts = async (provider, model) => {
      const key = `${provider || '·'}/${model}`;
      if (effortCache[key]) return effortCache[key];
      try {
        const query = `?provider=${encodeURIComponent(String(provider ?? ''))}&model=${encodeURIComponent(String(model ?? ''))}`;
        const res = await fetch(HUB_MODEL_LIST_PATH + query, { headers: { accept: 'application/json' } });
        if (!res || !res.ok) return { ok: false, efforts: [], note: `档位查询返回 ${res ? res.status : '（无响应）'}` };
        const body = await res.json();
        const efforts = (Array.isArray(body && body.efforts) ? body.efforts : [])
          .filter((effort) => effort && effort.id)
          .map((effort) => ({ value: String(effort.id), label: String(effort.name ?? effort.id) }));
        effortCache[key] = {
          ok: body && body.ok === true,
          efforts,
          defaultEffort: String((body && body.defaultEffort) || ''),
          note: String((body && body.note) || ''),
        };
        return effortCache[key];
      } catch (err) {
        return { ok: false, efforts: [], note: `取档位失败：${(err && err.message) || err}` };
      }
    };

    /** 配置里的 `provider/model` 文本 → `{ provider, model }`（与宿主 `parseModelRef` 同一套规则）。 */
    const parseModelRef = (raw) => {
      const text = String(raw ?? '').trim();
      if (!text) return null;
      const at = text.lastIndexOf('/');
      return at > 0
        ? { provider: text.slice(0, at), model: text.slice(at + 1), ref: text }
        : { provider: '', model: text, ref: text };
    };

    /** 从配置值里按点路径取一项（`pickPath(v, 'agent.defaultModel')`）。 */
    const pickPath = (value, dotted) => {
      let cur = value;
      for (const part of String(dotted).split('.')) {
        if (!isObject(cur)) return undefined;
        cur = cur[part];
      }
      return cur;
    };

    /** 配置值 → 叶子清单。数组按 JSON 文本处理（当前配置里不该出现，防御性保留）。 */
    const flatten = (value, path, out) => {
      if (isObject(value)) {
        for (const key of Object.keys(value)) flatten(value[key], path.concat(key), out);
        return out;
      }
      const kind = typeof value === 'boolean' ? 'boolean'
        : typeof value === 'number' ? 'number'
          : typeof value === 'string' ? 'string'
            : 'json';
      out.push({ path, key: path.join('.'), kind, value });
      return out;
    };

    /**
     * **天生没有默认值**的字段：schema 里不给 `default`，所以没配过的 profile 里这些键
     * 根本不存在（`resolveConfig` 只在运行时兜底），页面就得自己把它们补出来，否则
     * "没配"= 这一行消失 = 你永远没机会配它。补出来的是**空行**（值 undefined）。
     *
     * 为什么坚持不给默认值：用户要求这两项不要有"默认值"（例如下游列表曾经显示的
     * `[]`），清空就是清空，别让它回退到某个我们替他选的值。**严格 JSON**。
     */
    const ALWAYS_FIELDS = [
      { "path": ["upstreamListen"], "key": "upstreamListen", "kind": "string" },
      { "path": ["downstreamTargets"], "key": "downstreamTargets", "kind": "string" }
    ];

    /** 这些行不给「恢复默认」按钮：它们本来就没有"默认值"可恢复（用户明确要求）。 */
    const NO_RESET_KEYS = new Set(ALWAYS_FIELDS.map((field) => field.key));

    /** 宿主给的 store 一律当"可能会坏"来用：抛错就返回兜底值。 */
    const safeCall = (label, fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        try {
          console.error(`[onebot-hub/settings] ${label} 失败：`, err);
        } catch {
          /* console 也可能是受限的 */
        }
        return fallback;
      }
    };

    const S = {
      row: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      label: { flex: '0 0 260px', minWidth: 0, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
      labelZh: { fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      labelKey: { display: 'block', marginTop: 1, fontFamily: 'inherit', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      note: { display: 'block', marginTop: 2, fontFamily: 'inherit', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      control: { flex: '1 1 auto', minWidth: 0 },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: 13, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12 },
      button: { padding: '4px 10px', fontSize: 12, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, cursor: 'pointer' },
      primary: { padding: '5px 14px', fontSize: 13, color: 'var(--dsw-alias-bg-base)', background: 'var(--dsw-alias-brand-primary)', border: 'none', borderRadius: 6, cursor: 'pointer' },
      badge: { marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
      dirty: { color: 'var(--dsw-alias-state-warn-primary)' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      err: { color: 'var(--dsw-alias-state-error-primary)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      group: { margin: '14px 0 6px', padding: '8px 12px 2px', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 },
      pre: { margin: '8px 0', padding: 10, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 8, color: 'var(--dsw-alias-label-primary)' },
    };

    /** 注册进「设置 → OneBot 枢纽」。组件定义在 apply 内，闭包拿到 ctx。 */
    /**
     * 真正的装配体。外面包一层 `apply`：里面无论发生什么，**都不许抛出去**——
     * 条目状态一旦变成 `failed`，`packages\client\web\src\boot-client.ts:83` 的
     * 门禁就会 `web boot: 1 entry did not activate`，桌面壳直接放弃启动。
     */
    const runApply = (ctx) => {
      /**
       * 读 `configForms`。**读服务属性必须先声明 inject**——cordis 的 ctx 是
       * 反射代理，`vendor\cordis\src\reflect.ts:144` 对没 inject 的属性直接抛
       * `cannot get property "configForms" without inject`；当初就是这一句把
       * `apply` 炸掉、条目变 FAILED、整个桌面壳起不来的。现在 `inject` 里已经
       * 声明了它，这里再兜一层 try/catch 只为了"读不到就少一页配置"。
       */
      const readFormService = () => {
        try {
          return ctx.configForms;
        } catch (err) {
          report('configForms', `读 configForms 失败：${(err && err.message) || err}`, err && err.stack);
          return undefined;
        }
      };
      const formService = readFormService();
      report('client-half', `apply 拿到 ctx（configForms=${formService ? '有' : '（没有）'}，slots=${ctx && ctx.slots ? '有' : '（没有）'}）`);
      if (!React || typeof React.createElement !== 'function') {
        report('client-half', '宿主没给可用的 React（require("react") 失败）：设置页没法建，安静跳过。');
        return;
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
        report('client-half', `宿主没有 slots 服务（slots.inject 不是函数）：设置页没法注册，安静跳过。ctx 键=${ctx ? Object.keys(ctx).slice(0, 20).join(',') : '（没有 ctx）'}`);
        return;
      }
      const matchesHub = (ns) => {
        const v = String(ns ?? '').toLowerCase();
        return v === 'onebot-hub' || v.endsWith(':onebot-hub') || v.includes('onebot-hub');
      };

      const hooksReady = !!React && typeof React.useState === 'function' && typeof React.useEffect === 'function';
      /** `useMemo` 只是优化：宿主没暴露就直接算，绝不因为缺它而崩。 */
      const safeMemo = (fn, deps) => (React && typeof React.useMemo === 'function' ? React.useMemo(fn, deps) : fn());

      /** 订阅快照型 store；store 缺失、getSnapshot/subscribe 抛错都只返回 undefined。 */
      const useSnapshot = (store, label) => {
        const [snap, setSnap] = React.useState(() => safeCall(`${label}:getSnapshot`, () => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined), undefined));
        React.useEffect(() => {
          if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined;
          safeCall(`${label}:getSnapshot`, () => setSnap(store.getSnapshot()), undefined);
          const off = safeCall(`${label}:subscribe`, () => store.subscribe(() => setSnap(safeCall(`${label}:getSnapshot`, () => store.getSnapshot(), undefined))), undefined);
          return typeof off === 'function' ? off : undefined;
        }, [store]);
        return snap;
      };

      const errorBox = (title, err) => h('div', { style: S.pre }, [
        h('div', { key: 't', style: { fontWeight: 600 } }, title),
        h('div', { key: 'm', style: { marginTop: 6 } }, String((err && err.message) || err)),
        h('div', { key: 'h', style: { marginTop: 6, ...S.muted } }, '把这段文字发给我就能修（不需要开控制台）。'),
      ]);

      /** 真正的页面主体：hooks 先全部调用，任何计算/渲染错误都落到页面上。 */
      function Page() {
        if (!hooksReady) {
          return h('div', { style: S.muted }, '这个宿主的 React 没有暴露 useState/useEffect，OneBot 枢纽页无法渲染。');
        }
        const forms = formService || readFormService();
        const mirror = forms && typeof forms.describe === 'function'
          ? safeCall('describe', () => forms.describe(), undefined)
          : undefined;
        React.useEffect(() => {
          if (mirror && typeof mirror.ensure === 'function') safeCall('ensure', () => mirror.ensure(), undefined);
        }, [mirror]);
        const mirrorSnap = useSnapshot(mirror, 'mirror');
        const view = mirrorSnap && mirrorSnap.view ? mirrorSnap.view : undefined;
        const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : [];
        const nsEntry = namespaces.find((entry) => matchesHub(entry && entry.ns)) || {};
        const ns = nsEntry.ns;
        // 一次性里程碑：页面真的渲染起来了（说明 slots 注册与组件树都没问题），
        // 顺便把宿主给的命名空间清单报回去——"入口在、里面没东西"时这就是分诊依据。
        if (!reportedOnce) {
          reportedOnce = true;
          report(
            'page',
            `Page 已渲染；命名空间=${namespaces.map((entry) => (entry && entry.ns) || '?').join(', ') || '（空）'}；命中=${ns || '（无）'}；hooksReady=${hooksReady}`,
          );
        }
        const form = safeMemo(() => (forms && ns && typeof forms.get === 'function' ? safeCall('get', () => forms.get(ns), undefined) : undefined), [forms, ns]);
        const snap = useSnapshot(form, 'form');

        // 本地暂存：{ 路径字符串: 输入框里的原始值 }；只在点保存时才写回宿主。
        const [edits, setEdits] = React.useState({});
        const [filter, setFilter] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [note, setNote] = React.useState(null);
        /** 哪些枚举字段被切到了"自定义…"（下拉里没有的值，走文本框写）。 */
        const [customKeys, setCustomKeys] = React.useState(() => new Set());
        /** 哪些列表型字段被切到了"以 JSON 编辑"（结构化编辑器之外的手工逃生口）。 */
        const [jsonKeys, setJsonKeys] = React.useState(() => new Set());
        /**
         * DSH 模型清单（m024193）：`available:false` 时模型/档位两行退回手写文本框。
         * 初始化同步读缓存，于是第二次进设置页不会再等一次网络。
         */
        const [modelList, setModelList] = React.useState(() => modelListCache.value || { available: false, providers: [], note: '还没取（正在取）' });
        /** 思考强度档位：`{ 'provider/model': { ok, efforts, defaultEffort, note } }`，按需问、只问选中的那个模型。 */
        const [effortState, setEffortState] = React.useState(() => ({ ...effortCache }));
        React.useEffect(() => {
          let alive = true;
          void fetchModelList().then((next) => {
            if (!alive) return;
            setModelList(next);
            if (!next.available && next.note) report('model-list', next.note);
          });
          return () => { alive = false; };
        }, []);
        // 配对模型一变，就去问那个模型的档位（缓存过的跳过）。
        // 只在两个 effort 字段的宿主依赖上跑，不跟 renders 抖动。
        const storedValue = (key) => (Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : pickPath(snap && snap.value, key));
        const pairedModels = Object.entries(MODEL_FIELDS)
          .filter(([, spec]) => spec.kind === 'effort')
          .map(([effortKey, spec]) => {
            const parsed = parseModelRef(storedValue(spec.modelKey));
            if (!parsed) return [effortKey, null];
            // 没写 provider 的老配置：在清单里按 model id 反查 provider，问得准一点。
            let provider = parsed.provider;
            if (!provider && modelList.available) {
              for (const entry of modelList.providers || []) {
                if ((entry.models || []).some((model) => model.id === parsed.model)) {
                  provider = entry.id;
                  break;
                }
              }
            }
            return [effortKey, { ...parsed, provider }];
          });
        const pairedKey = JSON.stringify(pairedModels.map(([, model]) => (model ? `${model.provider}/${model.model}` : '')));
        React.useEffect(() => {
          let alive = true;
          const pending = pairedModels.filter(([, model]) => model && !effortCache[`${model.provider || '·'}/${model.model}`]);
          if (pending.length === 0) return undefined;
          void (async () => {
            for (const [, model] of pending) {
              const next = await fetchEfforts(model.provider, model.model);
              effortCache[`${model.provider || '·'}/${model.model}`] = next;
            }
            if (alive) setEffortState({ ...effortCache });
          })();
          return () => { alive = false; };
        }, [pairedKey]);

        try {
          const value = snap && snap.value !== undefined ? snap.value : undefined;
          const fields = isObject(value) ? flatten(value, [], []) : [];
          // 宿主读配置一律走 `redactSecrets`：`role('secret')` 的字段会被**从值里删掉**
          // （不是清空），所以凭据在 `value` 里根本不存在——不补行的话这些行整行消失，
          // 用户看到的就是"根本没地方填 key"。宿主另给了 secrets（`[{ path, set }]`，只报
          // "设过没设过"，不回显明文），补行与徽章都以它为准。
          // 注意它在**命名空间那一层**（`describe()` → `namespaces: [namespaceView…]` →
          // `namespaceView` 里才有 `secrets`），不是 `view` 顶层——真机上曾经因为读错层
          // 而一行都没补出来。三个可能的落点都看一遍，哪个有就用哪个。
          const secretSource = [snap && snap.secrets, nsEntry.secrets, view && view.secrets]
            .find((list) => Array.isArray(list) && list.length) || [];
          const secretMap = new Map(secretSource
            .filter((secret) => secret && Array.isArray(secret.path) && secret.path.length)
            .map((secret) => [secret.path.join('.'), { path: secret.path.map(String), set: secret.set === true }]));
          // 没默认值的字段（见 ALWAYS_FIELDS）在没配过的 profile 里根本不存在：补成空行，
          // 否则"这一项还没配"看起来就是"这一项不存在"。
          for (const spare of ALWAYS_FIELDS) {
            if (!fields.some((field) => field.key === spare.key)) fields.push({ ...spare, value: undefined });
          }
          for (const [key, secret] of secretMap) {
            if (fields.some((field) => field.key === key)) continue;
            fields.push({ path: secret.path, key, kind: 'string', value: undefined, secret: true });
          }
          const secretKeys = new Set(secretMap.keys());
          const userKeys = new Set(snap && isObject(snap.user) ? flatten(snap.user, [], []).map((field) => field.key) : []);

          const writable = !!(snap && snap.writable);
          const dirtyKeys = Object.keys(edits);

          // ---- 模型清单派生的下拉（m024193）----
          // 模型行：清单里的每个模型拍成 `provider/model`；effort 行：**配对那个模型**声明的档位
          // （按需问出来的，缓存在 `effortState`）。取不到清单、没配模型、或那个模型没声明
          // reasoning 时都退回 `null`（= 走原来的文本框），并给一行说明为什么没有下拉——
          // 而不是把选项藏起来让人猜。
          const pairedOf = (key) => {
            const spec = MODEL_FIELDS[key];
            return spec && spec.kind === 'effort' ? pairedModels.find(([effortKey]) => effortKey === key)?.[1] || null : null;
          };
          const modelOptionsFor = (key) => {
            if (!modelList.available) return null;
            const options = [{ value: '', label: '（留空 · 跟 DSH 系统默认）' }];
            for (const provider of modelList.providers || []) {
              const providerName = provider.name || provider.id;
              for (const model of provider.models || []) {
                const vision = (model.inputModalities || []).includes('image') ? ' · 可看图' : '';
                options.push({
                  value: `${provider.id}/${model.id}`,
                  label: `${providerName} · ${model.name || model.id}${vision}`,
                });
              }
            }
            return options.length > 1 ? options : null;
          };
          const effortOptionsFor = (key) => {
            if (!modelList.available) return null;
            const model = pairedOf(key);
            if (!model) return null;
            const fetched = effortState[`${model.provider || '·'}/${model.model}`];
            if (!fetched || !fetched.ok || !(fetched.efforts || []).length) return null;
            return [{ value: '', label: '（留空 · 用模型自己的默认）' }, ...fetched.efforts];
          };
          const effortHintFor = (key) => {
            const spec = MODEL_FIELDS[key];
            if (!spec || spec.kind !== 'effort') return '';
            if (!modelList.available) return `没取到 DSH 的模型清单（${modelList.note || '路由不可用'}），只能手填档位名`;
            const model = pairedOf(key);
            if (!model) return `先在「${FIELD_TEXT[spec.modelKey]?.label || spec.modelKey}」里选一个模型，这里才有档位可选`;
            const fetched = effortState[`${model.provider || '·'}/${model.model}`];
            if (!fetched) return '正在问这个模型有哪些档位…';
            if (!fetched.ok) return `问档位失败：${fetched.note || '（无说明）'}`;
            if (!(fetched.efforts || []).length) return `${model.provider ? `${model.provider}/` : ''}${model.model} 没声明思考档位，留空即可`;
            return '';
          };

          const setEdit = (key, next) => setEdits((prev) => {
            const draft = { ...prev };
            if (next === undefined) delete draft[key];
            else draft[key] = next;
            return draft;
          });

          const revert = async (field) => {
            if (!form || !writable) return;
            setBusy(true);
            const ok = await safeCall('unset', () => form.mutate([{ op: 'unset', path: field.path }]), false);
            setBusy(false);
            setNote(ok
              ? { kind: 'ok', text: `已恢复默认：${field.key}` }
              : { kind: 'err', text: `恢复默认被拒绝：${field.key}` });
          };

          const save = async () => {
            if (!form || !writable || dirtyKeys.length === 0) return;
            const ops = [];
            const byKey = new Map(fields.map((field) => [field.key, field]));
            for (const key of dirtyKeys) {
              const field = byKey.get(key);
              if (!field) continue;
              const raw = edits[key];
              let next;
              if (field.kind === 'boolean') next = raw === true;
              else if (field.kind === 'number') {
                next = Number(raw);
                if (!Number.isFinite(next)) {
                  setNote({ kind: 'err', text: `${key} 不是合法数字：${String(raw)}` });
                  return;
                }
              } else if (field.kind === 'json') {
                try {
                  next = JSON.parse(String(raw));
                } catch (err) {
                  setNote({ kind: 'err', text: `${key} 不是合法 JSON：${(err && err.message) || err}` });
                  return;
                }
              } else next = String(raw ?? '');
              // 凭据留空 = 不改（宿主只显示"设过没设过"，不该把空串当成"清空"）。
              if (secretKeys.has(key) && field.kind === 'string' && next === '') continue;
              ops.push({ op: 'set', path: field.path, value: next });
            }
            if (ops.length === 0) {
              setEdits({});
              setNote({ kind: 'ok', text: '没有需要写回的改动' });
              return;
            }
            setBusy(true);
            const ok = await safeCall('mutate', () => form.mutate(ops), false);
            setBusy(false);
            if (ok) {
              setEdits({});
              setNote({ kind: 'ok', text: '已保存（写进 profile 的 cordis.patch.yml，插件会重新装配一遍）' });
            } else {
              setNote({ kind: 'err', text: '宿主拒绝了这次写入（多半是 revision 过期：已重新读取当前值，请再改一次）' });
            }
          };

          if (!forms) {
            return h('div', { style: S.muted }, '宿主没有提供配置表单服务（configForms）：本页需要 dsh-client-ui-settings。');
          }
          if (view === undefined) {
            return h('div', { style: S.muted }, '正在读取配置…（如果一直停在这里，把这句话发给我）');
          }
          if (snap === undefined) {
            return h('div', { style: S.muted }, '正在读取本插件的配置…（如果一直停在这里，把这句话发给我）');
          }
          if (ns === undefined || snap.status === 'unavailable') {
            return h('div', null, [
              h('div', { key: 'a' }, '宿主没有为 dsh-onebot-hub 提供可编辑的配置面。'),
              h('div', { key: 'b', style: { marginTop: 6, ...S.muted } }, '通常是：插件没加载，或它的配置里没有 volatile 字段（老版本代码）。'),
              h('pre', { key: 'c', style: S.pre }, `宿主当前提供的命名空间（${namespaces.length} 个）：\n${namespaces.map((entry) => `· ${entry && entry.ns}`).join('\n') || '（空）'}`),
            ]);
          }

          // 过滤同时认配置键与中文名/说明：记得住"看图"记不住 vision.mode 的人也能找到。
          const needle = filter.trim().toLowerCase();
          const filtered = needle === ''
            ? fields
            : fields.filter((field) => {
              const text = FIELD_TEXT[field.key] || {};
              return `${field.key} ${text.label || ''} ${text.note || ''}`.toLowerCase().includes(needle);
            });
          const groups = new Map();
          for (const field of filtered) {
            const head = field.path.length > 1 ? field.path[0] : '';
            if (!groups.has(head)) groups.set(head, []);
            groups.get(head).push(field);
          }
          const groupKeys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

          /** 行 → 干净的配置对象：空值省略、`enabled: true` 省略（少写一个字节，profile 也更好读）。 */
          const cleanTarget = (row) => {
            const out = { type: String(row.type || 'ws-dial'), address: String(row.address ?? row.url ?? '') };
            if (row.id) out.id = String(row.id);
            if (row.selfId) out.selfId = String(row.selfId);
            if (row.nickname) out.nickname = String(row.nickname);
            if (row.accessToken) out.accessToken = String(row.accessToken);
            // 探针隔离（§19 M7-④）：探针账号/逻辑下游组。行编辑器里留空 = 不写。
            if (row.probeSelfId) out.probeSelfId = String(row.probeSelfId);
            if (row.downstreamId) out.downstreamId = String(row.downstreamId);
            if (row.reconnectInterval !== undefined && row.reconnectInterval !== null && String(row.reconnectInterval) !== '') {
              const n = Number(row.reconnectInterval);
              out.reconnectInterval = Number.isFinite(n) && n > 0 ? n : String(row.reconnectInterval);
            }
            if (row.enabled === false) out.enabled = false;
            return out;
          };

          /** 行 → 一条源码范围：`{name, path}`。**空行不丢**，否则"添加"按钮刚按下去行就没了。 */
          const cleanScope = (row) => {
            const out = { name: String(row.name ?? ''), path: String(row.path ?? row.dir ?? '') };
            return out;
          };

          /**
           * 行 → 一条白名单条目：`{id, mode?}`（m31030）。**空行不丢**（同上）；mode 留空
           * （"跟随全局"）就不写进 JSON；取消勾选保留为 `enabled:false`（宿主解析时跳过）。
           */
          const cleanWhitelist = (row) => {
            const out = { id: String(row.id ?? row.key ?? '').trim() };
            const mode = String(row.mode ?? '');
            if (mode) out.mode = mode;
            if (row.enabled === false) out.enabled = false;
            return out;
          };

          /**
           * 每种列表**各是什么**（`LIST_EDITORS` 里只能放严格 JSON，所以函数放这儿）。
           * `kind` 缺省按 `targets` 走，老配置不受影响。
           */
          const LIST_KINDS = {
            targets: {
              clean: cleanTarget,
              add: () => ({ type: 'ws-dial', address: '' }),
              empty: '还没有下游目标（空 = 只接受下游主动拨入）。',
              title: (row) => row.nickname || row.selfId || row.address || row.url || '（未填地址）',
            },
            scopes: {
              clean: cleanScope,
              add: () => ({ name: '', path: '' }),
              empty: '还没有源码范围（空 = agent 问"源码在哪"时会如实说没配）。',
              title: (row) => row.name || row.path || '（未填路径）',
            },
            whitelist: {
              clean: cleanWhitelist,
              add: () => ({ id: '', mode: '' }),
              empty: '名单是空的：白名单制下一个会话都不喂模型。',
              title: (row) => row.id || '（未填）',
            },
          };

          /**
           * 列表型字段的行编辑器（`LIST_EDITORS` 里声明的那些）。
           *
           * 它只做一件事：把当前**字符串**解析成行、把每次改动立刻序列化回字符串塞进 `edits`。
           * 这样保存路径一个字都不用改（schema 仍是字符串，profile 里存的仍是同一个 JSON）。
           * 当前值不是合法 JSON 数组时**不猜**：原样给出文本框并说明原因。
           */
          const renderListEditor = (field, text) => {
            const spec = LIST_EDITORS[field.key];
            const raw = text === undefined || text === null ? '' : String(text);
            let rows = null;
            let parseError = '';
            try {
              const parsed = raw.trim() === '' ? [] : JSON.parse(raw);
              if (Array.isArray(parsed)) rows = parsed.map((row) => (isObject(row) ? row : {}));
              else parseError = '当前值不是 JSON 数组';
            } catch (err) {
              parseError = (err && err.message) || String(err);
            }
            if (rows === null) {
              return h('div', { key: 'bad' }, [
                h('div', { key: 'e', style: S.err }, `当前值不是合法 JSON 数组（${parseError}）：按 JSON 改，或者点「恢复默认」清空。`),
                h('textarea', {
                  key: 'ta', rows: 3, value: raw, disabled: !writable || busy, style: { ...S.input, ...S.mono },
                  onChange: (event) => setEdit(field.key, event.target.value),
                }),
              ]);
            }
            const kind = LIST_KINDS[spec.kind] ?? LIST_KINDS.targets;
            const commit = (next) => setEdit(field.key, JSON.stringify(next.map(kind.clean)));
            const update = (index, patch) => commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
            const remove = (index) => commit(rows.filter((_, at) => at !== index));
            const add = () => commit([...rows, kind.add()]);
            return h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              rows.length === 0
                ? h('div', { key: 'empty', style: S.muted }, kind.empty)
                : null,
              ...rows.map((row, index) => h('div', {
                key: `t:${index}`,
                style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
              }, [
                h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
                  h('input', {
                    key: 'on', type: 'checkbox', checked: row.enabled !== false, disabled: !writable || busy,
                    title: '取消勾选 = 这条不连接（配置留着，随时再开）',
                    onChange: (event) => update(index, { enabled: event.target.checked }),
                  }),
                  h('span', { key: 'n', style: S.mono }, `#${index + 1} ${kind.title(row)}`),
                  h('button', {
                    key: 'd', type: 'button', style: S.button, disabled: !writable || busy,
                    onClick: () => remove(index),
                  }, '删除'),
                ]),
                ...spec.columns.map((column) => h('label', {
                  key: column.key, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
                }, [
                  h('span', { key: 'l', style: { flex: '0 0 72px', color: 'var(--dsw-alias-label-secondary)' } }, column.label),
                  Array.isArray(column.options)
                    ? h('select', {
                      key: 's',
                      value: String(row[column.key] ?? column.options[0].value),
                      disabled: !writable || busy,
                      style: { ...S.input, ...S.mono, flex: '1 1 auto' },
                      onChange: (event) => update(index, { [column.key]: event.target.value }),
                    }, column.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
                    : h('input', {
                      key: 'i',
                      type: column.secret ? 'password' : (column.numeric ? 'number' : 'text'),
                      value: row[column.key] === undefined || row[column.key] === null ? '' : String(row[column.key]),
                      placeholder: column.placeholder,
                      disabled: !writable || busy,
                      style: { ...S.input, ...S.mono, flex: '1 1 auto' },
                      onChange: (event) => update(index, { [column.key]: event.target.value }),
                    }),
                ])),
              ])),
              h('div', { key: 'ops', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
                h('button', { key: 'add', type: 'button', style: S.button, disabled: !writable || busy, onClick: add }, spec.addLabel),
                h('button', {
                  key: 'raw', type: 'button', style: S.button, disabled: busy,
                  title: '直接改 JSON 字符串（粘贴、批量编辑用）',
                  onClick: () => setJsonKeys((prev) => { const draft = new Set(prev); draft.add(field.key); return draft; }),
                }, '以 JSON 编辑'),
                h('span', { key: 'count', style: S.muted }, `${rows.length} 条`),
              ]),
            ]);
          };

          const renderRow = (field) => {            const dirty = Object.prototype.hasOwnProperty.call(edits, field.key);
            const current = dirty ? edits[field.key] : field.value;
            const isSecret = secretKeys.has(field.key);
            // 凭据的"设过没设过"只能问宿主的 `view.secrets`（`snap.user` 同样被脱敏，
            // 用 userKeys 判断会把已设好的凭据显示成"未设置"）。
            const secretSet = isSecret && secretMap.get(field.key)?.set === true;
            const secretFilled = secretSet || (dirty && String(edits[field.key] ?? '') !== '');
            const options = ENUM_OPTIONS[field.key]
              || (MODEL_FIELDS[field.key] ? (MODEL_FIELDS[field.key].kind === 'model' ? modelOptionsFor(field.key) : effortOptionsFor(field.key)) : null);
            const hint = MODEL_FIELDS[field.key] ? effortHintFor(field.key) : '';
            const onCustom = customKeys.has(field.key);
            let control;
            if (options && !onCustom) {
              const currentText = String(current === undefined || current === null ? '' : current);
              const known = options.some((option) => option.value === currentText);
              control = h('select', {
                value: known ? currentText : '',
                disabled: !writable || busy,
                style: { ...S.input, ...S.mono },
                onChange: (event) => {
                  const next = event.target.value;
                  if (next === '__custom__') {
                    setCustomKeys((prev) => { const draft = new Set(prev); draft.add(field.key); return draft; });
                    return;
                  }
                  setEdit(field.key, next);
                },
              }, [
                ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                // 当前值不在预设里（手工写过、或是老配置）：如实显示，不要静默改掉它。
                known ? null : h('option', { key: '__unknown__', value: '' }, `（当前值 ${currentText || '（空）'} 不在预设里）`),
                h('option', { key: '__custom__', value: '__custom__' }, '自定义…'),
              ]);
            } else if (options && onCustom) {
              control = h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                h('input', {
                  key: 'i', type: 'text', value: String(current === undefined || current === null ? '' : current), disabled: !writable || busy,
                  style: { ...S.input, ...S.mono, flex: '1 1 auto' }, onChange: (event) => setEdit(field.key, event.target.value),
                }),
                h('button', {
                  key: 'b', type: 'button', style: S.button, disabled: busy,
                  title: '回到下拉列表（已改的值不会被丢掉）',
                  onClick: () => setCustomKeys((prev) => { const draft = new Set(prev); draft.delete(field.key); return draft; }),
                }, '回到下拉'),
              ]);
            } else if (LIST_EDITORS[field.key] && jsonKeys.has(field.key)) {
              // 手工逃生口：粘贴/批量编辑长 JSON 时用，切回去不丢已改的值。
              control = h('span', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } }, [
                h('textarea', {
                  key: 'ta', rows: 4, value: String(current === undefined || current === null ? '' : current),
                  disabled: !writable || busy, style: { ...S.input, ...S.mono, flex: '1 1 auto' },
                  onChange: (event) => setEdit(field.key, event.target.value),
                }),
                h('button', {
                  key: 'b', type: 'button', style: S.button, disabled: busy,
                  title: '回到一条一条的列表编辑（已改的值不会被丢掉）',
                  onClick: () => setJsonKeys((prev) => { const draft = new Set(prev); draft.delete(field.key); return draft; }),
                }, '回到列表'),
              ]);
            } else if (LIST_EDITORS[field.key]) {
              control = renderListEditor(field, current);
            } else if (field.kind === 'boolean') {
              control = h('input', {
                type: 'checkbox', checked: current === true, disabled: !writable || busy,
                onChange: (event) => setEdit(field.key, event.target.checked),
              });
            } else if (field.kind === 'number') {
              control = h('input', {
                type: 'number', value: String(current === undefined || current === null ? '' : current), disabled: !writable || busy,
                style: { ...S.input, ...S.mono }, onChange: (event) => setEdit(field.key, event.target.value),
              });
            } else if (field.kind === 'json' || (typeof current === 'string' && (current.length > 48 || /(prompt|system|guidance|notes?|roots?)$/.test(field.key)))) {
              control = h('textarea', {
                rows: 3, value: String(current === undefined || current === null ? '' : current), disabled: !writable || busy,
                style: { ...S.input, ...S.mono }, onChange: (event) => setEdit(field.key, event.target.value),
              });
            } else {
              control = h('input', {
                type: isSecret ? 'password' : 'text',
                value: String(current === undefined || current === null ? '' : current), disabled: !writable || busy,
                placeholder: isSecret ? '（凭据：留空 = 不改）' : '',
                style: { ...S.input, ...S.mono }, onChange: (event) => setEdit(field.key, event.target.value),
              });
            }
            const text = FIELD_TEXT[field.key] || {};
            return h('div', { key: field.key, style: S.row }, [
              h('div', { key: 'l', style: S.label }, [
                h('div', { key: 'zh', style: S.labelZh }, text.label || field.key),
                h('code', { key: 'k', style: S.labelKey }, field.key),
                dirty ? h('span', { key: 'd', style: { ...S.badge, ...S.dirty } }, '已改，未保存') : null,
                isSecret ? h('span', { key: 's', style: S.badge }, secretFilled ? '凭据已设置' : '凭据未设置') : null,
                text.note ? h('span', { key: 'n', style: S.note }, text.note) : null,
              ]),
              h('div', { key: 'c', style: S.control }, [
                control,
                hint ? h('div', { key: 'hint', style: S.note }, hint) : null,
              ]),
              h('div', { key: 'a', style: { flex: '0 0 auto', display: 'flex', gap: 6 } }, [
                dirty ? h('button', {
                  key: 'undo', type: 'button', style: S.button, disabled: busy,
                  onClick: () => setEdit(field.key, undefined),
                }, '撤销') : null,
                (isSecret ? secretSet : userKeys.has(field.key)) && !NO_RESET_KEYS.has(field.key) ? h('button', {
                  key: 'reset', type: 'button', style: S.button, disabled: busy || !writable,
                  title: '删掉 profile 里这一条覆盖，恢复组成层的值',
                  onClick: () => { void revert(field); },
                }, '恢复默认') : null,
              ]),
            ]);
          };

          return h('div', { style: { padding: '4px 2px 40px' } }, [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, [
              h('div', { key: 't', style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, 'OneBot 枢纽'),
              h('div', { key: 'm', style: S.muted }, [
                `命名空间 ${ns}`,
                snap.revision === undefined ? '' : ` · revision ${snap.revision}`,
                ` · ${fields.length} 个配置项`,
                writable ? '' : ' · 当前 profile 不允许写入',
              ]),
            ]),
            h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', flexWrap: 'wrap' } }, [
              h('input', {
                key: 'f', type: 'search', value: filter, placeholder: '过滤配置项（配置键或中文名，如 vision、看图、超管）',
                style: { ...S.input, maxWidth: 320 }, onChange: (event) => setFilter(event.target.value),
              }),
              h('button', {
                key: 'save', type: 'button', style: { ...S.primary, opacity: (!writable || busy || dirtyKeys.length === 0) ? 0.5 : 1 },
                disabled: !writable || busy || dirtyKeys.length === 0, onClick: () => { void save(); },
              }, dirtyKeys.length === 0 ? '保存' : `保存 ${dirtyKeys.length} 项`),
              dirtyKeys.length === 0 ? null : h('button', {
                key: 'drop', type: 'button', style: S.button, disabled: busy, onClick: () => { setEdits({}); setNote(null); },
              }, '放弃修改'),
              busy ? h('span', { key: 'b', style: S.muted }, '写入中…') : null,
              note ? h('span', { key: 'n', style: note.kind === 'ok' ? S.ok : S.err }, note.text) : null,
            ]),
            h('div', { key: 'hint', style: S.muted }, '改完点保存：值写进 profile 的 cordis.patch.yml，插件会即时重新装配（改的是配置值，不需要重启）。凭据字段不回显明文，留空表示不改。JSON 字符串字段（downstreamTargets / superUsers / presets 等）按 JSON 写。'),
            groupKeys.length === 0 ? h('div', { key: 'empty', style: { ...S.muted, marginTop: 12 } }, '没有匹配的配置键。') : null,
            ...groupKeys.map((head) => h('div', { key: `g:${head || '-'}`, style: S.group }, [
              h('div', { key: 'h', style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } },
                head === '' ? '基础' : (FAMILY_LABELS[head] || head)),
              ...groups.get(head).map(renderRow),
            ])),
          ]);
        } catch (err) {
          report('render', `OneBot 枢纽页渲染出错：${(err && err.message) || err}`, err && err.stack);
          return errorBox('OneBot 枢纽页渲染出错', err);
        }
      }

      /**
       * 注册进设置侧栏。照既有客户端插件的写法：**回调里自带 try/catch 并回
       * 一个 no-op disposer**，注册失败只上报（`onebot_hub_status.host.clientReports`
       * 上能看到原因），绝不让异常穿回 `inject`/`apply`。
       * `id` 备一个候选：万一是 "同一 id 已被占用"（重复装配/HMR），第二个能顶上。
       */
      const registerSection = (id) => {
        try {
          const off = ctx.slots.register({
            name: 'settings.section',
            id,
            order: 200,
            label: 'OneBot 枢纽',
          }, Page);
          report('client-half', `settings.section 已注册（id=${id}）`);
          return typeof off === 'function' ? off : (() => {});
        } catch (err) {
          report('register', `settings.section 注册失败（id=${id}）：${(err && err.message) || err}`, err && err.stack);
          return null;
        }
      };

      try {
        ctx.slots.inject('settings.section', () => (
          registerSection('onebot-hub') || registerSection('onebot-hub-config') || (() => {})
        ));
        report('client-half', 'settings.section 注册请求已提交');
      } catch (err) {
        report('inject', `slots.inject("settings.section") 本身抛出：${(err && err.message) || err}`, err && err.stack);
      }
    };

    const apply = (ctx) => {
      try {
        runApply(ctx);
      } catch (err) {
        report('apply', `客户端装配抛出（已吞掉，避免 web boot 门禁把整个 App 拖死）：${(err && err.message) || err}`, err && err.stack);
      }
    };

    exports.apply = apply;
    /**
     * **必须是声明过的服务才能 `ctx.<服务名>` 读**（`vendor\cordis\src\reflect.ts:144`）。
     * `slots` 是注册座位用的；`configForms` 是读写配置用的（既有客户端插件同样
     * 把它列在 inject 里）。少写一个，读它的那一行就抛。
     */
    exports.inject = ['slots', 'configForms'];
    return module.exports;
  },
});
