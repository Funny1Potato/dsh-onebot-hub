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
      tts: '语音合成（TTS）',
      memory: '记忆与隔离',
      official: '上游：QQ 官方接口',
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
      "upstreamMode": { "label": "连接方式", "note": "正向 = 我们连到实现端给的地址；反向 = 我们开着端口等实现端连进来（LLOneBot / NapCat 默认是反向）。" },
      "upstreamAddress": { "label": "地址", "note": "反向写 host:port（可带路径），如 127.0.0.1:8765/onebot/v11/ws；正向写完整地址，如 ws://127.0.0.1:3001。" },
      "upstreamUrl": { "label": "上游地址（旧键）", "note": "旧配置里（我们拨出去）的那个地址。现在已经由「连接方式 + 地址」表达；这格只在自动迁移时会用到，改它不会生效。" },
      "upstreamSelfId": { "label": "上游账号", "note": "上游实现端登录的 QQ 号；用来认出\"哪条消息是我们自己发的\"。留空 = 连上后自动认（握手头 / 事件 / get_login_info），下游\"不写对方账号\"的目标也会自动跟着它。" },
      "upstreamNickname": { "label": "上游昵称", "note": "上游账号的昵称（备用，昵称识别时用）。" },
      "upstreamListen": { "label": "反向监听地址（旧键）", "note": "旧配置里（它拨进来）的那个地址。现在已经由「连接方式 + 地址」表达；这格只在自动迁移时会用到，改它不会生效。" },
      "upstreamAccessToken": { "label": "上游 access token（凭据）", "note": "留空 = 不校验；设了就要求 Bearer 或 ?access_token=。不回显明文。" },
      "downstreamAccessToken": { "label": "下游 access token（凭据）", "note": "校验下游拨入/推事件时的 token，留空 = 不校验。不回显明文。" },
      "upstreamType": { "label": "上游类型", "note": "这个插件从哪儿收消息：OneBot v11 实现端（LLOneBot / NapCat 这类）或 QQ 官方机器人开放平台。下游那条 OneBot 面两种都一样，不用改。" },
      "official.appId": { "label": "应用 appId", "note": "QQ 机器人开放平台的 AppID（纯数字）。开放平台只支持接一个机器人，所以这里只填一个。扫码绑定的话这格会自动填上（存在插件状态里，不回显）。" },
      "official.appSecret": { "label": "appSecret（凭据）", "note": "开放平台的 AppSecret，用来换 access token（有效期约 2 小时，自动续）。不回显明文。" },
      "official.sandbox": { "label": "沙箱环境", "note": "开 = 连 sandbox.api.sgroup.qq.com（只能在开放平台配置的沙箱群里测试）；关 = 正式环境。" },
      "official.intents": { "label": "订阅位（实验）", "note": "0 = 用内置的「群与私聊」位（正常情况别动）。开机器人后台的某些能力后如果收不到群消息，可以在这里填订阅位的十进制值试试；改完要重启宿主。" },
      "official.crossShare": { "label": "跨群共享活跃记忆", "note": "官方模式下会话白名单不生效（能收到哪些群由开放平台决定），所以默认只在同群共享活跃记忆：一个群正在聊的事不会自动出现在另一个群里。想让它们互相看得见就打开——只影响「进行中的话题 / 我正在做的事」这一层，长期记忆与人物档案另有隔离规则。" },
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
      "agent.groups": { "label": "群白名单", "note": "只有列出的群才会调模型（没列的群 @ 也不理）；每条可单独选模式，留「跟随全局」就用上面的代理模式。额度也在这张名单里逐行配：点开该行的「额度」填计算方法（按 token / 按钱）、单价、日月上限与报数口径；不填＝不限。**上游选「官方接口」时以下两张名单都不生效**——能收到哪些群由开放平台决定。" },
      "agent.privates": { "label": "私聊白名单", "note": "只有列出的 QQ 号才会调模型；同样可单独选模式，也能逐行填额度（同群白名单）。两张名单都是白名单制：清空 = 全部静音。上游是官方接口时这张名单不生效（开放平台那边已经限定了能私聊谁）。" },
      "agent.tasks.enabled": { "label": "定时任务", "note": "打开后模型可以给自己排提醒（onebot_task）：到点由枢纽叫醒那个会话，说什么由它自己定。宿主没有 schedule 服务时这项无效。" },
      "agent.tasks.resetEvery": { "label": "总机会话轮换", "note": "定时任务共用一个永不回收的总机会话，每次触发会让它的上下文增长。填 N（>0）表示累计触发 N 次后换一条新会话并把所有排期搬过去；0 = 永不轮换。" },
      "agent.steer": { "label": "激活期插话", "note": "打开时，回合没跑完就来的新消息会直接插进正在进行的回合（模型下一步就能看到）；关掉则排队等这一轮说完再看。" },
      "agent.replyGapMs": { "label": "多条消息的间隔（ms）", "note": "一次 onebot_reply 拆成多条时，条与条之间等这么久（像人在一句句打字）。0 = 连发不带停顿。" },
      "agent.replyMaxText": { "label": "一次回复最多几条文字", "note": "只限文字消息的条数——图片不占额度（图另有上限）。超出部分不发送，并在工具回执里如实告知模型。" },
      "agent.replyMaxImages": { "label": "一次回复最多几张图", "note": "图片/表情包的条数上限（每张各自发一条消息）。0 = 不限。" },
      "capability.writeAllow": { "label": "写操作白名单", "note": "勾上就放行（撤回、点赞、改群名片…）。也可以「手写 JSON」填 glob，比如 send_* 命中一切发送。空 = 全部拒绝。" },
      "capability.dangerAllow": { "label": "危险操作白名单", "note": "会直接作用到别人身上的动作（禁言、踢人、退群、重启实现端）。默认全拒，勾一个开一个。" },
      "capability.exposeSensitive": { "label": "回显敏感字段", "note": "打开后只读查询里带 token 之类字段（默认关，防泄漏）。" },
      "capability.cache": { "label": "只读查询缓存", "note": "打开后 get_group_info 之类有 TTL 缓存，返回里 source=cache。" },
      "capability.probe": { "label": "主动探测能力", "note": "启动后自测哪些 action 可用，结果进 onebot_caps。" },
      "capability.downstreamReads": { "label": "下游只读查询", "note": "允许把下游链路也当作实现端来查。" },
      "capability.callTimeoutMs": { "label": "只读查询超时（ms）", "note": "单次 action 调用的等待上限。" },
      "capability.probeTimeoutMs": { "label": "探测超时（ms）", "note": "能力自测里每个 action 的等待上限。" },
      "media.enabled": { "label": "媒体落地", "note": "关掉后图片/语音/文件都不落地，也就没有 durable ref。" },
      "media.keepBytes": { "label": "保留原始字节", "note": "打开后 blob 存字节，上游 URL 过期也不影响引用。" },
      "media.transcribe": { "label": "语音转写", "note": "试实现端的转写能力；拿不到就如实说\"听不了\"，不猜内容。" },
      "media.maxBytes": { "label": "单文件字节上限", "note": "超过就只记元信息不落地、不进宿主附件（语音/视频/文件走这条）。图片不受此限：大图总会落 blob（识图要原图，超大的图看图前会先压小），只是不进模型主请求。" },
      "media.fetchTimeoutMs": { "label": "取媒体超时（ms）", "note": "下载图片/语音的等待上限。" },
      "turns.windowMs": { "label": "配对窗口（ms）", "note": "入站消息之后多久内，下游的 send_* 才算它触发的。" },
      "turns.retain": { "label": "保留回合数", "note": "内存里最多留多少条回合记录。" },
      "probe.isolation": { "label": "探针隔离", "note": "agent 用 onebot_invoke 试探下游时怎么和真人消息隔开。off（默认）=不隔离，注入与真人消息走同一条链路；time=探测窗口内该会话的上游消息暂缓投下游、窗口一到按原序补发（不需要额外配置）；link=上游消息一条都不投给探针链路、注入只走那条——探针链路要在下游目标里填 **probeSelfId**（同一个下游的另一个 bot 账号，地址不用改），一个都没配时这一档会**自动回退到 off**。开了链路隔离后，探针结果**可能与用户触发时不同**（这条会写进给 agent 的指导段与每次注入的结果里）。" },
      "probe.windowMs": { "label": "探测窗口（ms）", "note": "time 档：注入之后多久算这个会话的独占窗口。窗口内的真人消息只是晚到，不会丢。" },
      "probe.maxQueued": { "label": "窗口排队上限", "note": "安全阀：排到这个数就立刻按原序补发，绝不吞消息。" },
      "probe.capture": { "label": "探针链路只捕获不转发", "note": "link 档：探针链路的 send_* 只记进时间线/捕获账本，不真的发到 QQ——探针产物先给 agent 看，要不要说由它决定（默认开）。" },
      "retention.days": { "label": "原始报文保留天数", "note": "收到的每条消息都会缓存原文 + 索引（包括 hub 解析不了的段、以及**不展开**的聊天记录），agent 需要时自己取原文解析。超过这么多天自动清掉：落盘的原始报文日文件、索引里的旧行、以及媒体 blob。**0 = 不清理**。" },
      "retention.cleanupIntervalMs": { "label": "清理间隔（ms）", "note": "多久跑一次保留期清理（默认 6 小时）。" },
      "retention.firstRunDelayMs": { "label": "首次清理延迟（ms）", "note": "启动后隔多久跑第一次清理（默认 20 秒）。清理是 O(数据量) 的 IO，别把它放回启动路径上。" },
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
      "vision.segmentWaitMs": { "label": "回合前等图片落地（ms）", "note": "默认 1500。`segment` 模式要把图本身喂给模型，而图要先下载、存盘、回填才拿得到；这一项是拍快照前最多等多久。只开 `describe` 时不影响任何行为。" },
      "vision.waitBeforeTurnMs": { "label": "回合前等识图（ms）", "note": "默认 4000。图片消息进上下文时只有「[图片（还在看）]」，这一项让回合开始前等描述回来；0 = 不等（老行为，模型往往直接说看不到图）。超时后模型可以调 onebot_image_wait 再等一次。" },
      "agent.workspace": { "label": "会话工作区路径", "note": "留空 = 用宿主进程的 cwd，会话不进任何工作区（默认）。填绝对路径：把它当会话 cwd 并挂进该路径对应的工作区；没有对应工作区就自动建一个（标题取路径末段）。路径会先规范化再比对，目录不存在则退回进程 cwd 且不挂。" },
      "agent.archiveOnRetire": { "label": "结束后归档会话", "note": "默认开。关掉后激活结束不归档，会话留在 DSH 会话列表里（能 pin）；代价是每次激活都多留一条会话。" },
      "agent.replyOnSendFailure": { "label": "发送失败当场告知", "note": "默认开。回复没发出去时立刻排一次唤醒把失败递回去，agent 能当场重试，不用等下一轮（群里没人说话时那一轮可能永远不来）。" },
      "agent.sendFailureNudgeMax": { "label": "失败回执最多几次", "note": "默认 2。同一会话在一个窗口里最多自动重开这么多次，撞上限就退回「下一批开头告知」，防止重试→又失败→又收到回执自我转圈。" },
      "agent.sendFailureNudgeWindowMs": { "label": "失败回执窗口（毫秒）", "note": "默认 300000（5 分钟）。上面那个次数按这个窗口计。" },
      "persona.enabled": { "label": "人设", "note": "关掉后没有角色设定段，模型按默认风格说话。预设库与默认人设不在这几行里改——用上面的「人设库」面板。" },
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
      "imageGen.maxSize": { "label": "尺寸上限", "note": "形如 2560x1440；请求的 size 会等比内缩到它以内。" },
      "imageGen.minSize": { "label": "尺寸下限", "note": "留空 = 不设下限。" },
      "imageGen.watermark": { "label": "加水印", "note": "非 OpenAI 官方参数，默认不发；显式开启才透传 watermark 给支持它的中转接口。" },
      "imageGen.timeoutMs": { "label": "超时（ms）", "note": "生图等待上限（图确实慢，默认给得很宽）。" },
      "imageGen.maxPerTurn": { "label": "每轮最多几张", "note": "一轮对话里的硬上限，超了明确说\"这轮画完了\"。" },
      "imageGen.engine": { "label": "生图引擎", "note": "builtin＝hub 自带的 OpenAI 兼容生图（默认）；plugin＝不自己生图，把第三方插件的生图工具放进 agent 工具面。" },
      "imageGen.delivery": { "label": "生成后发送时机", "note": "agent（默认）＝生成后由 agent 决定发不发群；direct＝生成完立刻直发到指定会话。" },
      "imageGen.plugin.tool": { "label": "第三方生图工具名", "note": "engine=plugin 时用；逗号分隔或数组。留空＝自动探测（generate_image 等已知名单）。" },
      "imageGen.plugin.timeoutMs": { "label": "探测/后处理超时（ms）", "note": "预留的后处理等待上限，当前主要留作扩展。" },
      "tts.enabled": { "label": "语音合成", "note": "默认关；开了还要配地址与 API Key，缺一个仍然是关（provider 选 plugin 时不用地址）。开了之后 onebot_reply 的 {\"type\":\"tts\",\"text\":\"…\"} 段会当场合成语音再发。" },
      "tts.provider": { "label": "服务商", "note": "选一家，接口地址和请求形状就由它决定（这两格会藏起来），只有它用得上的参数才会显示；模型仍然可以换。同一家的不同计费方式（小米的 Token Plan / 按量付费、MiniMax 的国内 / 海外站）是**两个选项**，地址不通用，选错报的是鉴权错。要完全自己填就选 custom；plugin = 枢纽不合成，交给第三方插件的语音工具。" },
      "tts.plugin.tool": { "label": "插件工具名", "note": "provider=plugin 时用：填第三方插件的语音工具名（多个用逗号分隔，如 voice_tts）。留空 = 按已知名单 + 名字里带 tts/speech 自动探测。" },
      "tts.url": { "label": "接口地址（完整）", "note": "仅服务商 = custom 时显示。填完整 URL，不自动拼路径。OpenAI 官方是 https://api.openai.com/v1/audio/speech；小米 MiMo 填 https://token-plan-cn.xiaomimimo.com/v1/chat/completions。" },
      "tts.shape": { "label": "请求形状", "note": "仅服务商 = custom 时显示。speech = input/voice/response_format（OpenAI /audio/speech）；chat = 塞进 messages 的 assistant（MiMo）；minimax = text + voice_setting（返回 hex）；doubao = 豆包的 app/user/audio/request 四段（鉴权头是 Bearer; token）；plugin = 不打请求。选错只会拿到 400/404，回执里会写清上游怎么说的。" },
      "tts.apiKey": { "label": "API Key（凭据）", "note": "留空 = 不改。不回显明文；只进 Authorization 头，绝不进请求体（豆包例外：它的 token 文档要求 body 里也放一份）。" },
      "tts.appId": { "label": "AppID（豆包语音）", "note": "只有豆包语音要：填控制台里的 appid（请求体 app.appid）。缺了算没配全，不会硬发一个空 appid 去撞 400。" },
      "tts.cluster": { "label": "Cluster（豆包集群）", "note": "只有豆包语音要，留空按 volcano_tts。" },
      "tts.groupId": { "label": "GroupId（MiniMax 账号组）", "note": "只有老版 MiniMax 要：填了就拼成 ?GroupId=xxx，新版接口留空即可。" },
      "tts.resourceId": { "label": "Resource-Id（方舟）", "note": "只有火山方舟 Agent Plan 用：请求头 X-Api-Resource-Id，TTS 模型是 seed-tts-2.0。留空就按预设。" },
      "tts.model": { "label": "模型", "note": "每家都能换，手填即可（例：speech-02-turbo、mimo-v2.5-tts、qwen-tts、gpt-4o-mini-tts）。留空 = 用这家预设的默认模型。方舟 / 豆包的 TTS 不吃模型名——那两家的「型号」是 Resource-Id 与模型接入点。" },
      "tts.voice": { "label": "音色", "note": "没有默认值，填了才进请求体；不做枚举校验，写服务注册的音色名或 id（MiniMax 填 voice_id 这类）。小米 MiMo 分三种：普通模型填内置音色（冰糖、茉莉、mimo_default 之类）；voicedesign 模型这里要填**一段音色描述**，它会变成 user 消息；voiceclone 模型不用填这里，改填参考音频。" },
      "tts.format": { "label": "音频格式", "note": "mp3|opus|aac|flac|wav|pcm，默认 mp3（QQ 最稳）。只影响落盘扩展名与 speech 形状的 response_format。" },
      "tts.speed": { "label": "语速", "note": "1 = 原速；只在 ≠1 时才往请求体里带。" },
      "tts.instructions": { "label": "风格/音色提示", "note": "speech 形状里作 instructions 字段；chat 形状里作一条 system 消息（描述音色用）；留空 = 不发。" },
      "tts.refAudio": { "label": "参考音频", "note": "零样本克隆用：URL / 本地路径 / base64://… / data:… 都认；留空 = 不做克隆，只用默认音色。" },
      "tts.refText": { "label": "参考音频对应的文本", "note": "多数克隆接口要求同时给（音频里读的到底是什么字）。" },
      "tts.refAudioField": { "label": "参考音频的字段名", "note": "各家写法不同：ref_audio / ref_audio_path / prompt_audio…留空 = 这个字段根本不发（OpenAI 官方收到未知字段会报错）。" },
      "tts.refTextField": { "label": "参考文本的字段名", "note": "ref_text / prompt_text…留空 = 不发。" },
      "tts.timeoutMs": { "label": "超时（ms）", "note": "单次合成的等待上限。" },
      "tts.maxChars": { "label": "单次最多多少字", "note": "官方 input 上限 4096；超了明确说\"太长，分几句\"，不偷偷截断。" },
      "tts.cacheLimit": { "label": "缓存上限（条）", "note": "同一句话同一音色直接复用本地文件，不重复花钱；0 = 不缓存。" },
      "memory.limit": { "label": "记忆总条数上限", "note": "超过就按重要度与新旧淘汰。" },
      "memory.peopleRoster": { "label": "本群认识的人（最多几个）", "note": "上下文里列出本群我认识的人（按最近露面排序）；0 = 不列。细节仍可用 onebot_person 现查。" },
      "memory.reminders.enabled": { "label": "定时提醒", "note": "打开后\"答应过的事\"到期会冒出来提醒。" },
      "memory.reminders.windowHours": { "label": "提醒窗口（小时）", "note": "到期前后多久内算\"该提了\"。" },
      "memory.reminders.limit": { "label": "一次提几条", "note": "单轮最多提醒几条。" },
      "memory.reminders.max": { "label": "最多存几条提醒", "note": "超过淘汰最旧的。" },
      "memory.isolation.level": { "label": "隔离级别", "note": "strict 只在本会话 / scoped 按会话可见 / balanced 折中（默认，活跃层能跨共享会话看见彼此进行中的话题）/ open 最松。注意：改松不只放活跃层，长期事实的跨群放行也会一起放松。" },
      "memory.isolation.crossGroupIdentity": { "label": "跨群认同一个人", "note": "打开后同一个人在不同群共用一个档案。" },
      "memory.isolation.crossGroupFacts": { "label": "跨群事实", "note": "shareable 标记过的，以及点了名、人都在本群的，可跨群（默认）/ never 永不 / all 全部（连没点名的也跨）。" },
      "memory.isolation.privateFacts": { "label": "私聊事实", "note": "never 私聊内容不出私聊 / sameActor 那个人自己在场时可见（默认）/ all 全部。敏感内容任何档位都不外传。" },
      "memory.isolation.sensitivityAlwaysLocal": { "label": "敏感内容永远本地", "note": "打开后敏感事实不参与跨会话装配（不看 level）。" },
      "memory.isolation.overrides": { "label": "逐项覆盖（JSON）", "note": "JSON 数组：给单条记忆指定可见范围。" },
      "memory.isolation.trustedGroups": { "label": "可信群（JSON）", "note": "JSON 数组：这些群之间可以互相看见（仍受 level 约束）。" },
      "memory.isolation.trustedPrivates": { "label": "白名单私聊（JSON）", "note": "这些人的私聊能读任何会话；留空则吃超管名单，超管也没配就谁都不能跨会话读。" },
      "memory.isolation.recallEscape": { "label": "允许越界检索", "note": "打开后 onebot_recall 能跨会话翻旧账（默认关）。" },
      "memory.isolation.recallEscapeNeedsApproval": { "label": "越界要确认", "note": "打开后越界检索要显式 confirm 才给。" },
      "memory.isolation.audit": { "label": "留审计", "note": "每次放行/拦截都记一条，可用 onebot_memory_audit 查。" },
      "memory.isolation.auditRetain": { "label": "审计保留条数", "note": "账本最多留多少条。" },
      "memory.active.enabled": { "label": "活跃层", "note": "打开后记录\"进行中的话题\"和\"agent 正在做的事\"，做完由 agent 结算；关闭则这一层整段不注入。" },
      "cross.enabled": { "label": "会话间转达", "note": "打开后 agent 能把一个会话里的东西（图/链接/卡片/聊天记录）递给别的会话——由那边自己决定发不发。默认关：它会把一个群里的内容带到另一个群，属于要人显式打开的能力。" },
      "cross.allowFrom": { "label": "谁能发起", "note": "hub＝只有枢纽自己拉起的会话能发起（默认）；all＝任何会话都能调这个全局工具。" },
      "cross.allowTo": { "label": "可投递到", "note": "目标会话白名单（JSON 数组，如 [\"group:123456789\"]）。留空＝枢纽的全部会话都能当目标。" },
      "cross.allowPrivateRefs": { "label": "私聊原文可外搬", "note": "默认关。私聊里说的话，用户期待它留在那个私聊里——原样搬进群或另一个私聊都撤不回来。关着时只能用自己的话转述（转述会过隐私词表）。" },
      "cross.relayMaxPerWindow": { "label": "转达频率", "note": "时间窗内最多能发起几次转达（按\"发起会话 + 目标会话\"分别算）。" },
      "cross.windowMs": { "label": "频率窗口", "note": "上面那个次数的时间窗，单位毫秒；默认 5 分钟。" },
      "cross.packageTtlMs": { "label": "包存活时间", "note": "递过去的包多久内有效，单位毫秒；默认 30 分钟。过期后那边再发就会被告知\"包不存在或已过期\"。" },
      "cross.maxBytes": { "label": "单包上限", "note": "一次转达能打包多少内容（字节）；超了直接拒绝并说明，不会悄悄截断。" },
      "cross.channelTtlMs": { "label": "通道存活时间", "note": "一条会话间通道最长活多久（毫秒，默认 30 分钟）。两头可以在这段时间里来回说几句，过期就断。" },
      "cross.channelSilentMs": { "label": "通道冷掉时间", "note": "多久没人说话就把通道冷掉（毫秒，默认 10 分钟）。比存活时间短，所以「沉默」比「过期」更早生效。" },
      "cross.channelMaxPerSide": { "label": "每方句数", "note": "通道里每一方最多说几句（默认 6）。防两个会话互相客气到天亮。" },
      "cross.wakeGraceMs": { "label": "递送等待上限", "note": "递一条消息给另一个会话时，最多等它那一轮多久（毫秒）。默认 1200；调大没有好处——两个会话互相递话时，等太久会让两边一起卡住。" },
      "cross.peerListLimit": { "label": "外部会话条数", "note": "`list` 里最多报几个外部会话（别的插件拉起的会话）。只报跟枢纽来往过、且现在活着的；默认 10。" },
      "cross.directory": { "label": "会话目录", "note": "转达开着时，把「这个插件接了哪些群和私聊」列进提示词——模型看得见门牌号，才谈得上主动串门。不列＝整段不出现；只列群号和人数（群里私聊只报几个，私聊里才列编号）；再加印象＝尾巴带一句群档案里观测到的样子（只有本来就能看到那边的人才给）。" },
      "cross.rosterLimit": { "label": "目录条数", "note": "目录最多列几行（默认 30，0＝不列）。按群号顺序排（固定顺序，不然每回合前缀都变），超出的写「还有 N 个没列」。" },
      "memory.active.activeWindowDays": { "label": "活跃层保留天数", "note": "多久没动过的条目就不进上下文了；0 = 不过滤（会留下早就结束的僵尸条目）。" },
      "memory.active.injectLimit": { "label": "一次注入几条", "note": "上下文里最多列几条进行中的事（按话题在前、任务在后，组内新的在前）；0 = 不注入。" },
      "memory.active.maxPerOrigin": { "label": "每个会话最多存几条", "note": "防止某个群把活跃层塞满；超了淘汰该会话最旧的（只防跑偏，不代替结算）。" },
      "memory.active.dailySettleReminder": { "label": "每天提醒结算", "note": "开着时，开了超过一天还没结算的条目会在下一次会话活动时被提一句（每天最多一次）。" }
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
      "upstreamMode": [
        { "value": "reverse", "label": "反向 WebSocket（我们开端口，等实现端连进来）" },
        { "value": "forward", "label": "正向 WebSocket（我们连到实现端给的地址）" }
      ],
      "upstreamType": [
        { "value": "onebot", "label": "OneBot v11 实现端（LLOneBot / NapCat，默认）" },
        { "value": "official", "label": "QQ 官方机器人开放平台（appId + appSecret）" }
      ],
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
      "cross.directory": [
        { "value": "off", "label": "off · 不列" },
        { "value": "names", "label": "names · 只列群号和人数（默认，私聊只报几个）" },
        { "value": "full", "label": "full · 再加一句群档案里的印象" }
      ],
      "tts.provider": [
        { "value": "custom", "label": "custom · 自定义（下面自己填，默认）" },
        { "value": "openai", "label": "openai · OpenAI 官方" },
        { "value": "mimo", "label": "mimo · 小米 MiMo（Token Plan · 国内）" },
        { "value": "mimo-pay", "label": "mimo-pay · 小米 MiMo（按量付费）" },
        { "value": "minimax", "label": "minimax · MiniMax（t2a_v2，返回 hex）" },
        { "value": "minimaxi", "label": "minimaxi · MiniMax（海外站）" },
        { "value": "ark", "label": "ark · 火山方舟（Agent Plan，分块流）" },
        { "value": "doubao", "label": "doubao · 火山引擎（豆包语音 V1）" },
        { "value": "plugin", "label": "plugin · 第三方插件工具（枢纽不合成）" }
      ],
      "tts.shape": [
        { "value": "speech", "label": "speech · OpenAI /audio/speech 那一套" },
        { "value": "chat", "label": "chat · 塞进 messages 的 assistant" },
        { "value": "minimax", "label": "minimax · text + voice_setting/audio_setting" },
        { "value": "doubao", "label": "doubao · app/user/audio/request 四段" },
        { "value": "ark", "label": "ark · req_params + X-Api-Resource-Id（分块流）" },
        { "value": "plugin", "label": "plugin · 交给第三方工具，不打请求" }
      ],
      "memory.isolation.level": [
        { "value": "scoped", "label": "scoped · 按会话可见" },
        { "value": "strict", "label": "strict · 最严，只在本会话内" },
        { "value": "balanced", "label": "balanced · 折中（默认）" },
        { "value": "open", "label": "open · 最松" }
      ],
      "memory.isolation.crossGroupFacts": [
        { "value": "shareable", "label": "shareable · 标记为 shareable 的 + 点名且人在本群的，可跨群（默认）" },
        { "value": "never", "label": "never · 永不跨群" },
        { "value": "all", "label": "all · 全部跨群（连没点名的群内事实也跨）" }
      ],
      "memory.isolation.privateFacts": [
        { "value": "never", "label": "never · 私聊内容不出私聊" },
        { "value": "sameActor", "label": "sameActor · 那个人自己在场时可见（默认）" },
        { "value": "all", "label": "all · 全部可见" }
      ]
    };

    /**
     * 能力白名单的勾选项（`m38115` 用户要求：常用能力做成选项，不要再让人手写 glob）。
     *
     * 分组和取值抄自 `lib/capability.js` 的三分法——**write 与 danger 是两个字段**，
     * 不能混：`set_group_ban` 这类在 danger 里，勾进 writeAllow 一样会被拒，
     * 表现是"明明勾了却还是不让调"。`test/client-manifest.mjs` 逐项比对两张表，
     * 少一个、多一个都会红。
     *
     * `*` = 全部放行，单独一项；`send_*` 是前缀通配（一切发送动作）。
     */
    const CHECK_GROUPS = {
      "capability.writeAllow": [
        {
          "title": "消息",
          "items": [
            { "value": "delete_msg", "label": "撤回消息" },
            { "value": "send_like", "label": "点赞（拍一拍）" },
            { "value": "mark_msg_as_read", "label": "标记已读" },
            { "value": "set_msg_emoji_like", "label": "给消息贴表情" },
            { "value": "set_group_reaction", "label": "群表情回应" },
            { "value": "set_input_status", "label": "输入中状态" },
            { "value": "send_*", "label": "一切发送（send_ 开头，含合并转发）" }
          ]
        },
        {
          "title": "群资料",
          "items": [
            { "value": "set_group_card", "label": "改群名片" },
            { "value": "set_group_name", "label": "改群名" },
            { "value": "set_group_special_title", "label": "设专属头衔" },
            { "value": "set_group_anonymous", "label": "开/关匿名" }
          ]
        },
        {
          "title": "请求与账号",
          "items": [
            { "value": "set_friend_add_request", "label": "同意好友请求" },
            { "value": "set_group_add_request", "label": "同意加群请求" },
            { "value": "set_qq_profile", "label": "改自己的资料" },
            { "value": "set_qq_avatar", "label": "换头像" },
            { "value": "clean_cache", "label": "清实现端缓存" }
          ]
        }
      ],
      "capability.dangerAllow": [
        {
          "title": "群管理（会直接作用于别人）",
          "items": [
            { "value": "set_group_ban", "label": "禁言成员" },
            { "value": "set_group_whole_ban", "label": "全员禁言" },
            { "value": "set_group_kick", "label": "踢人" },
            { "value": "set_group_admin", "label": "设/撤管理员" },
            { "value": "set_group_anonymous_ban", "label": "匿名禁言" },
            { "value": "set_group_leave", "label": "让机器人退群" }
          ]
        },
        {
          "title": "实现端（会打断它自己）",
          "items": [
            { "value": "set_restart", "label": "重启实现端" },
            { "value": ".handle_quick_operation", "label": "隐藏接口 handle_quick_operation" }
          ]
        }
      ]
    };

    /**
     * 上游类型切换时要藏掉的对方专属字段（`m34751`）。
     *
     * 选 OneBot 就看不见官方那三格，选官方就看不见 OneBot 的连接方式——两边同时显示，
     * 等于让人自己判断"到底哪几个才算数"，而这恰好是最容易填错的地方。
     * `reconnectInterval` / `requestTimeout` / `heartbeatTimeout` **不藏**：两条路都用它们。
     */
    // `m71864`：连接方式与地址取代了旧的两个地址框——旧键不再显示（值还在，供自动迁移读）。
    const ONEBOT_UPSTREAM_KEYS = ['upstreamMode', 'upstreamAddress', 'upstreamSelfId', 'upstreamNickname', 'upstreamAccessToken'];
    const HIDDEN_UPSTREAM_KEYS = ['upstreamUrl', 'upstreamListen'];
    const OFFICIAL_UPSTREAM_KEYS = ['official.appId', 'official.appSecret', 'official.sandbox'];
    const upstreamHidden = (key, type) => {
      const official = String(type ?? '').trim().toLowerCase() === 'official';
      if (OFFICIAL_UPSTREAM_KEYS.includes(key)) return !official;
      if (ONEBOT_UPSTREAM_KEYS.includes(key)) return official;
      if (HIDDEN_UPSTREAM_KEYS.includes(key)) return true;
      return false;
    };

    /**
     * 选了服务商就不用再看见的字段（`m29830` / `m30480`）。
     *
     * 两档：**地址与形状**跟着服务商走，只有 `custom` 下才有意义（选了一家还显示这两格
     * = "看着碍事"且"改完不生效"）；**这一家不用的那几格**（appId/cluster/groupId/
     * resourceId）也藏起来——选了小米却看见"豆包 AppID"，是把选择成本又还给用户。
     *
     * `tts.model` **不藏**：每个服务商都要能选模型（同一家有 hd/turbo、voicedesign/tts
     * 这些档），下拉见 `ENUM_OPTIONS['tts.model']`。
     */
    const PRESET_KEYS = ['tts.url', 'tts.shape'];
    /** 每家用得上的"额外项"（与宿主 `lib/audio/providers.js` 的 `PROVIDER_FIELDS` 同一份，测试对齐）。 */
    const PROVIDER_EXTRA = {
      "custom": [],
      "openai": [],
      "mimo": [],
      "mimo-pay": [],
      "minimax": ["groupId"],
      "minimaxi": ["groupId"],
      "ark": ["resourceId"],
      "doubao": ["appId", "cluster"],
      "plugin": []
    };
    const EXTRA_KEYS = ['tts.appId', 'tts.cluster', 'tts.groupId', 'tts.resourceId'];
    const presetHidden = (key, provider) => {
      const id = String(provider ?? '').trim().toLowerCase();
      const chosen = id !== '' && id !== 'custom';
      if (PRESET_KEYS.includes(key)) return chosen;
      // 插件工具名只对 plugin 有意义（别的服务商看见它会以为"填了就能换工具"）。
      if (key === 'tts.plugin.tool') return id !== 'plugin';
      if (key === 'tts.plugin') return id !== 'plugin';
      if (!EXTRA_KEYS.includes(key)) return false;
      // 自定义 = 全给（手填的人得找得到地方填）；认不出的服务商也当自定义。
      if (!chosen || !PROVIDER_EXTRA[id]) return false;
      return !PROVIDER_EXTRA[id].includes(key.slice('tts.'.length));
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
     * 人设库读写通道（`m23678`，宿主侧实现见 `lib/persona/route.js` 的 `PERSONA_PATH`）。
     * **两处字面量必须一致**：`test/client-manifest.mjs` 会抠出宿主那份来比对。
     *
     * 为什么这条是**可写**的：设置页要能"下拉选默认人设 + 直接改某一条的 JSON"。
     * 改的是**运行时那本库**（跟 `/presets`、`/set_preset` 同一份，改完立即生效、重启还在）。
     * 配置项那条路已经删了（`m24027`：原来 `persona.presets` 是每次启动重写一遍的种子，
     * 会把设置页里改过的同名预设打回去）——所以这块面板现在是**唯一**的库编辑器。
     */
    const HUB_PERSONA_PATH = '/onebot-hub/persona';
    /** 进程内缓存：进设置页只取一次，之后由每次写操作的回执就地刷新。 */
    const personaCache = { value: null };

    /** 统一形状：`{ ok, defaultName, presets:[{name,role,knowledges,hidden}], note }`。 */
    const normalizePersona = (body) => ({
      ok: body && body.ok === true,
      defaultName: String((body && body.defaultName) || ''),
      presets: (Array.isArray(body && body.presets) ? body.presets : [])
        .filter((preset) => preset && preset.name)
        .map((preset) => ({
          name: String(preset.name),
          role: String(preset.role || ''),
          knowledges: Array.isArray(preset.knowledges) ? preset.knowledges.map(String) : [],
          hidden: preset.hidden === true,
        })),
      note: String((body && body.note) || ''),
    });

    /** 取一次人设库。失败**不抛**：返回 `{ ok:false, presets:[], note }`，页面照旧渲染。 */
    const fetchPersona = async () => {
      if (personaCache.value) return personaCache.value;
      try {
        const res = await fetch(HUB_PERSONA_PATH + location.search, { headers: { accept: 'application/json' } });
        if (!res || !res.ok) return { ok: false, presets: [], note: `人设通道返回 ${res ? res.status : '（无响应）'}` };
        const next = normalizePersona(await res.json());
        // 只缓存成功的那一份：一次偶发失败不该把"取不到"钉住整个会话。
        if (next.ok) personaCache.value = next;
        return next;
      } catch (err) {
        return { ok: false, presets: [], note: `取人设库失败：${(err && err.message) || err}` };
      }
    };

    /** 写一次人设库：`{op, ...}`，回执是改完之后的**最新状态**（省掉一次往返）。 */
    const postPersona = async (payload) => {
      try {
        const res = await fetch(HUB_PERSONA_PATH + location.search, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res || !res.ok) return { ok: false, presets: [], note: `人设通道返回 ${res ? res.status : '（无响应）'}` };
        const next = normalizePersona(await res.json());
        if (next.ok) personaCache.value = next;
        return next;
      } catch (err) {
        return { ok: false, presets: [], note: `保存人设失败：${(err && err.message) || err}` };
      }
    };

    // ---- 官方通道扫码（`m34313`） -------------------------------------------------

    /**
     * 扫码绑定通道。宿主侧见 `lib/official/route.js`：GET 拿状态（带一张 PNG 的 data URL），
     * POST `{op:'start'|'cancel'|'forget'}` 改状态。
     *
     * 为什么不做缓存：这里的状态每一步都会变（等码、扫码中、成功），缓存一份只会让人看着
     * 一张过期的二维码扫到最后提示"已失效"。
     */
    const HUB_OFFICIAL_QR_PATH = '/onebot-hub/official/qr';
    const normalizeOfficialQr = (body) => ({
      ok: body && body.ok === true,
      status: String((body && body.status) || 'idle'),
      qr: String((body && body.qr) || ''),
      url: String((body && body.url) || ''),
      appId: String((body && body.appId) || ''),
      note: String((body && body.note) || ''),
      detail: String((body && body.detail) || ''),
    });
    const fetchOfficialQr = async () => {
      try {
        const res = await fetch(HUB_OFFICIAL_QR_PATH + location.search, { headers: { accept: 'application/json' } });
        if (!res || !res.ok) return { ok: false, status: 'failed', qr: '', url: '', appId: '', note: `扫码通道返回 ${res ? res.status : '（无响应）'}`, detail: '' };
        return normalizeOfficialQr(await res.json());
      } catch (err) {
        return { ok: false, status: 'failed', qr: '', url: '', appId: '', note: `取扫码状态失败：${(err && err.message) || err}`, detail: '' };
      }
    };
    const postOfficialQr = async (op) => {
      try {
        const res = await fetch(HUB_OFFICIAL_QR_PATH + location.search, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ op }),
        });
        if (!res || !res.ok) return { ok: false, status: 'failed', qr: '', url: '', appId: '', note: `扫码通道返回 ${res ? res.status : '（无响应）'}`, detail: '' };
        return normalizeOfficialQr(await res.json());
      } catch (err) {
        return { ok: false, status: 'failed', qr: '', url: '', appId: '', note: `扫码请求失败：${(err && err.message) || err}`, detail: '' };
      }
    };

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
      { "path": ["upstreamMode"], "key": "upstreamMode", "kind": "enum" },
      { "path": ["upstreamAddress"], "key": "upstreamAddress", "kind": "string" },
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
    /**
     * 异步版：`safeCall` 只接得住**同步**抛。`form.mutate()` 回的是 Promise，
     * 它 reject 时原来会一路穿出去（`void save()` 把它变成未处理拒绝），
     * `setBusy(false)` 永远不执行 → 保存按钮从此灰着，只能重开设置页才能再点。
     */
    const safeAwait = async (label, fn, fallback) => {
      try {
        return await fn();
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
      // 标签列不再写死 260px：改成**按比例分、封顶 240px**，剩下的全给右侧的输入框。
      label: { flex: '0 1 30%', maxWidth: 240, minWidth: 0, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
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
      // 人设库面板（`m23678`）：一块带边框的小卡片，嵌在「人设与预设」这一组里。
      card: { margin: '4px 0 10px', padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 },
      cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      // JSON 编辑窗口：盖住整页的蒙层 + 居中的白板（滚动交给 textarea，白板本身不滚）。
      overlay: { position: 'fixed', inset: 0, background: 'rgba(8, 12, 24, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 60 },
      dialog: { width: 'min(720px, 100%)', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box', padding: 16, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, boxShadow: '0 12px 40px rgba(8, 12, 24, 0.28)' },
    };

    /**
     * 布局：**宽的时候按比例分，窄了叠起来**。
     *
     * 之前标签列写死 `0 0 260px`——窗口多宽都先扣掉 260，剩下的才轮到输入框；
     * 一旦这段设置被塞进更窄的一栏（额度子面板、行编辑器、窄窗口），
     * 这 260px 就把输入框挤成一条缝，而那一栏里还有自己的标签列要再分一次。
     * 现在分两步走：
     * ① 宽版：标签列 `0 1 30%` 封顶 240px，控件 `1 1 auto` 吃掉其余全部；
     * ② 窄版：容器窄过 `NARROW_AT`（CSS 容器查询）就把「标签 / 控件 / 按钮」
     *    三格竖排，输入框因此拿到**整栏宽度**——二级菜单里只有这样才装得下。
     *    竖排时必须同时给 `align-items:stretch`：列方向的主轴变成竖的，
     *    交叉轴就归 `align-items` 管，不拉满的话输入框会缩成内容宽。
     *
     * 容器查询是渐进增强：宿主浏览器不认 `@container` 时**只丢叠加功能**，
     * 宽版比例布局照旧（那份比例写在行内样式里，不依赖这张表）。
     * 窄模式里用 `!important` 压行内样式——行内优先级高于类，不压就压不住。
     */
    const NARROW_AT = 620;
    const CLS = {
      page: 'oh-page', row: 'oh-row', label: 'oh-label', control: 'oh-control', actions: 'oh-actions',
      sub: 'oh-sub', subLabel: 'oh-sub-label', subInput: 'oh-sub-input',
      // 顶栏（标题 + 过滤 + 保存）：设置项有几十行，保存按钮跟着滚走就得来回拖（`m31436`）。
      sticky: 'oh-sticky',
    };
    const SHEET = [
      `.${CLS.page}{container-type:inline-size;width:100%;box-sizing:border-box}`,
      // 吸顶：标题 + 过滤框 + 保存按钮钉在滚动区顶部。
      // 底色必须**不透明**（用页面底色的 token），否则滚上来的行会从字缝里透出来。
      `.${CLS.sticky}{position:sticky;top:0;z-index:6;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));`
        + `padding-top:6px;border-bottom:1px solid var(--dsw-alias-border-l1);`
        + `box-shadow:0 6px 12px -10px rgba(8,12,24,.22)}`,
      `@container (max-width:${NARROW_AT}px){`,
      `.${CLS.row}{flex-direction:column!important;align-items:stretch!important;gap:4px!important}`,
      `.${CLS.label}{flex:1 1 auto!important;max-width:none!important}`,
      `.${CLS.control}{width:100%!important}`,
      `.${CLS.actions}{align-self:flex-end!important}`,
      `.${CLS.sub}{flex-direction:column!important;align-items:stretch!important;gap:2px!important}`,
      `.${CLS.subLabel}{flex:0 0 auto!important;max-width:none!important;min-width:0!important}`,
      `.${CLS.subInput}{width:100%!important}`,
      `}`,
    ].join('');

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
         * 哪些名单行的「额度」面板是展开的（m14190）：键是 `字段:行号`。
         * 展开状态**不进配置**——刷新页面就收起来，免得把"我刚才在看哪个群"存进 profile。
         */
        const [quotaOpen, setQuotaOpen] = React.useState({});
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
        /**
         * 人设库（`m23678`）：设置页里的下拉与 JSON 窗口读的是**运行时那本库**，
         * 不是配置项。`personaEdit` 是那个弹窗的状态：
         * `{ name, text, error, isNew }`／`null`＝关着。
         */
        const [persona, setPersona] = React.useState(() => personaCache.value || { ok: false, presets: [], note: '还没取（正在取）' });
        const [personaEdit, setPersonaEdit] = React.useState(null);
        const [personaBusy, setPersonaBusy] = React.useState(false);
        /**
         * 官方通道扫码（`m34313`）：`{ ok, status, qr, url, appId, note, detail }`。
         * `status` 是 `idle / scanning / ok / failed / expired`——只有 `scanning` 才轮询；
         * 扫完立刻停，别对着一个死状态每秒打一次宿主。
         */
        const [officialQr, setOfficialQr] = React.useState(() => ({ ok: false, status: 'idle', qr: '', url: '', appId: '', note: '', detail: '' }));
        const [officialBusy, setOfficialBusy] = React.useState(false);
        React.useEffect(() => {
          let alive = true;
          void fetchOfficialQr().then((next) => {
            if (alive) setOfficialQr(next);
          });
          return () => { alive = false; };
        }, []);
        React.useEffect(() => {
          if (officialQr.status !== 'scanning') return undefined;
          let alive = true;
          const timer = setInterval(() => {
            void fetchOfficialQr().then((next) => {
              if (alive) setOfficialQr(next);
            });
          }, 2000);
          return () => { alive = false; clearInterval(timer); };
        }, [officialQr.status]);
        React.useEffect(() => {
          let alive = true;
          void fetchPersona().then((next) => {
            if (!alive) return;
            setPersona(next);
            if (!next.ok && next.note) report('persona', next.note);
          });
          return () => { alive = false; };
        }, []);
        /** 一次写操作：把回执就地当新状态，成功时在顶栏留一句人话。 */
        const applyPersona = async (payload, okText) => {
          setPersonaBusy(true);
          try {
            const next = await postPersona(payload);
            setPersona(next);
            if (next.ok) setNote({ kind: 'ok', text: okText });
            else setNote({ kind: 'err', text: next.note || '没改成' });
            return next;
          } finally {
            setPersonaBusy(false);
          }
        };
        // 只在两个 effort 字段的宿主依赖上跑，不跟 renders 抖动。
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
            let ok = false;
            try {
              ok = await safeAwait('unset', () => form.mutate([{ op: 'unset', path: field.path }]), false) === true;
            } finally {
              setBusy(false);
            }
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
                /**
                 * 留空**不能**变成 0：`Number('')` 是 0 且能过 `isFinite`，于是"我把这个框
                 * 清空"会静默写进一个 0——对上限类字段（`maxReplyChars`、`perDay`）
                 * 0 往往等于"不限"，正好和用户的意图相反。
                 */
                const blank = raw === undefined || raw === null || String(raw).trim() === '';
                if (blank) {
                  setNote({ kind: 'err', text: `${key} 留空了：数字框不会把它当成 0，想恢复默认请点「恢复默认」` });
                  return;
                }
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
            let ok = false;
            try {
              ok = await safeAwait('mutate', () => form.mutate(ops), false) === true;
            } finally {
              setBusy(false);
            }
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
          // 选了一家服务商，地址/形状/模型就由那家决定了（`m29830`）——这三格只剩"看着碍事"和
          // "改完还不生效"，所以直接不显示；想手填就把服务商切回「自定义」，那时它们才回来。
          // 判据要**跟着当前正在编辑的值**走（`edits` 优先），否则刚在下拉里选了一家、这一行
          // 还要等一次保存才消失。
          const effOf = (key) => {
            if (Object.prototype.hasOwnProperty.call(edits, key)) return edits[key];
            const field = fields.find((item) => item.key === key);
            return field ? field.value : undefined;
          };
          const visible = filtered
            .filter((field) => !presetHidden(field.key, effOf('tts.provider')))
            .filter((field) => !upstreamHidden(field.key, effOf('upstreamType')));
          const groups = new Map();
          for (const field of visible) {
            const head = field.path.length > 1 ? field.path[0] : '';
            if (!groups.has(head)) groups.set(head, []);
            groups.get(head).push(field);
          }
          // 组的顺序：`official` 打头（连不上就什么都没有，先给人看它），基础段次之，其余按字母。
          const HEAD_ORDER = ['official', ''];
          const headRank = (key) => {
            const at = HEAD_ORDER.indexOf(key);
            return at === -1 ? HEAD_ORDER.length : at;
          };
          const groupKeys = [...groups.keys()].sort((a, b) => {
            const d = headRank(a) - headRank(b);
            return d !== 0 ? d : a.localeCompare(b);
          });

          /**
           * 行 → 干净的配置对象：空值省略、`enabled: true` 省略（少写一个字节，profile 也更好读）。
           *
           * **从原行出发、只重写行编辑器管得着的键**。以前是从零重建，于是「以 JSON 编辑」里写的
           * `probeOnly` 一保存就被静默删掉——探针链路悄悄变回真链路，界面上完全看不出来。
           * 从原行复制也顺带保护了以后新增的键：行编辑器不认识它，不等于它该被删。
           */
          const cleanTarget = (row) => {
            const out = { ...row };
            delete out.url; // 规范成 address 一个键
            delete out.probe_only; // 归一成 probeOnly
            out.type = String(row.type || 'ws-dial');
            out.address = String(row.address ?? row.url ?? '');
            if (row.probeOnly === true || row.probe_only === true) out.probeOnly = true;
            else delete out.probeOnly;
            for (const key of ['id', 'selfId', 'nickname', 'accessToken', 'probeSelfId', 'downstreamId']) {
              const value = row[key];
              if (value === undefined || value === null || String(value).trim() === '') delete out[key];
              else out[key] = String(value);
            }
            if (row.reconnectInterval !== undefined && row.reconnectInterval !== null && String(row.reconnectInterval) !== '') {
              const n = Number(row.reconnectInterval);
              out.reconnectInterval = Number.isFinite(n) && n > 0 ? n : String(row.reconnectInterval);
            } else {
              delete out.reconnectInterval;
            }
            if (row.enabled === false) out.enabled = false;
            else delete out.enabled;
            if (!out.address) delete out.address;
            return out;
          };

          /** 行 → 一条源码范围：`{name, path}`。**空行不丢**，否则"添加"按钮刚按下去行就没了。 */
          const cleanScope = (row) => {
            const out = { name: String(row.name ?? ''), path: String(row.path ?? row.dir ?? '') };
            return out;
          };

          /**
           * 分群额度的**面板字段表**（m14190：额度按群逐行配，没有全局块）。
           * `unit` 决定「每日/每月上限」读写的是哪对键：token 口径落 `tokensPerDay/tokensPerMonth`，
           * cost 口径落 `costPerDay/costPerMonth`；单价三项永远写 `price.{input,cache,output}`
           * （每百万 token）——账本只存三元组原值，所以改单价是**自动重算历史账**，不用清账。
           */
          const QUOTA_FIELDS = [
            { key: 'enabled', kind: 'check', label: '启用额度', hint: '不勾＝这个群不限额（连报数都不出）。限额全 0 也算没配。' },
            { key: 'unit', kind: 'select', label: '计算方法', options: [
              { value: 'token', label: '按 token（输入+缓存+输出合算）' },
              { value: 'cost', label: '按钱（用下面自填的单价折算）' },
            ], hint: '口径是这个群自己的事：贵模型按 token 记，走额度包/内部结算的按钱记。' },
            { key: 'currency', kind: 'text', label: '币种', placeholder: 'CNY', hint: '按钱口径的计价币种；只影响账本显示与文字，不做换算。' },
            { key: 'perDay', kind: 'number', limit: true, label: '每日上限', hint: '按本地自然日 00:00 重置；0 = 不限。' },
            { key: 'perMonth', kind: 'number', limit: true, label: '每月上限', hint: '按本地自然月 1 日重置；0 = 不限。日与月谁先到听谁的。' },
            { key: 'priceInput', kind: 'number', price: 'input', label: '输入单价（每百万 token）', hint: '按钱口径才用得上；改了自动按新价重算历史账。' },
            { key: 'priceCache', kind: 'number', price: 'cache', label: '缓存单价（每百万 token）', hint: '命中缓存那部分；很多中转站比输入便宜一大截。' },
            { key: 'priceOutput', kind: 'number', price: 'output', label: '输出单价（每百万 token）', hint: '模型输出那部分，通常最贵。' },
            { key: 'notice', kind: 'select', label: '报数口径', options: [
              { value: 'detail', label: 'detail · 已用/限额/剩余' },
              { value: 'percent', label: 'percent · 只给剩余百分比' },
              { value: 'off', label: 'off · 不出声' },
            ], hint: '每批末尾给模型补一行报数，它自己心里有数；default 会叮嘱它别把账目播给群友。' },
            { key: 'noticeHint', kind: 'check', label: '顺带提醒模型省着点', hint: '剩余不足时在指导里提一句额度将尽，让它自己收着回话。' },
            { key: 'onExhaust', kind: 'select', label: '用尽后的行为', options: [
              { value: 'notice', label: 'notice · 被 @ 时替模型回一句' },
              { value: 'silent', label: 'silent · 一个字都不发' },
            ], hint: '用尽后那批只存记忆不调模型；恢复后会把期间的原话补给它（最多 20 条）。' },
            { key: 'exhaustedReply', kind: 'text', label: '用尽时的回话', hint: '额度用完又有人 @ 时，替模型发出去的那句固定话术。留空 = 用默认那句；要一个字都不发请把上面「用尽后的行为」选成 silent。' },
            { key: 'cooldownSec', kind: 'number', slot: 'noticeCooldownMs', label: '报数冷却（秒）', hint: '两次报数至少隔这么久，防话痨群刷屏；快用完/已用完时豁免。' },
            { key: 'superuserBypass', kind: 'check', label: '超管 @ 豁免额度', hint: '默认关：超管 @ 也不绕过，账对全群一视同仁。打开后超管 @ 照常调模型，账照记。' },
          ];

          /** 面板里的扁平键 → 额度对象里的真键（`limit` 两项要跟着 `unit` 变）。 */
          const quotaSlot = (field, unit) => {
            if (field.price) return ['price', field.price];
            if (!field.limit) return [field.slot ?? field.key];
            if (unit === 'cost') return [field.key === 'perDay' ? 'costPerDay' : 'costPerMonth'];
            return [field.key === 'perDay' ? 'tokensPerDay' : 'tokensPerMonth'];
          };

          /** 面板字段 → 读出行编辑器那一行上的现值（宽松：写坏的字符串也能读出来给人看）。 */
          const readQuotaField = (quota, field) => {
            const raw = isObject(quota) ? quota : {};
            const [head, tail] = quotaSlot(field, raw.unit === 'cost' ? 'cost' : 'token');
            const value = head === 'price' ? (isObject(raw.price) ? raw.price[tail] : 0) : raw[head];
            if (field.key === 'cooldownSec') return Math.max(0, Math.round(Number(value) || 0) / 1000);
            return value === undefined || value === null ? '' : value;
          };

          /** 写回：面板字段 → 额度对象（数字/布尔按真类型落，字符串数字交给 `normalizeQuota` 兜）。 */
          const writeQuotaField = (quota, field, rawValue) => {
            const next = { ...(isObject(quota) ? quota : {}) };
            const unit = next.unit === 'cost' ? 'cost' : 'token';
            const [head, tail] = quotaSlot(field, unit);
            if (field.key === 'cooldownSec') {
              const sec = Number(rawValue);
              next.noticeCooldownMs = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) * 1000 : 0;
              return next;
            }
            if (head === 'price') {
              const price = { ...(isObject(next.price) ? next.price : {}) };
              price[tail] = quotaNumber(rawValue);
              next.price = price;
              return next;
            }
            next[head] = field.kind === 'check'
              ? Boolean(rawValue)
              : field.kind === 'number'
                ? quotaNumber(rawValue)
                : String(rawValue);   // select 与 text 都是字符串：套数字转换会让 `unit:'cost'` 变 0、把话术清成字面量 "0"
            return next;
          };

          /** 数字框的值落进 JSON 前先转真数字：空＝0（0 就是"不限"，也是它的自然默认）。 */
          const quotaNumber = (rawValue) => {
            if (rawValue === '' || rawValue === null || rawValue === undefined) return 0;
            const num = Number(rawValue);
            return Number.isFinite(num) ? num : 0;
          };

          /**
           * 这一行算不算"写过额度"：**勾了启用**或者**已经填了限额**就算。
           * 勾了启用但限额还没填也留着——那是"正在配"的中间态，存下来面板才不会弹回未勾选；
           * 而"没勾也没填"的行不写 `quota`，JSON 保持干净（也不会让人误以为限了）。
           */
          const quotaWritten = (quota) => {
            if (!isObject(quota)) return false;
            const cost = quota.unit === 'cost';
            const day = Number(cost ? quota.costPerDay : quota.tokensPerDay) || 0;
            const month = Number(cost ? quota.costPerMonth : quota.tokensPerMonth) || 0;
            return quota.enabled === true || day > 0 || month > 0;
          };

          /**
           * 行 → 白名单条目：`{id, mode?, quota?}`（m31030；m14190 起额度也挂在行上）。
           * **空行不丢**；mode 留空（"跟随全局"）不写；取消勾选保留 `enabled:false`。
           * `quota` 只在**真配了**的时候才写进去 —— 没配的群 JSON 里干干净净，不带一坨默认值。
           */
          const cleanWhitelist = (row) => {
            const out = { id: String(row.id ?? row.key ?? '').trim() };
            const mode = String(row.mode ?? '');
            if (mode) out.mode = mode;
            if (row.enabled === false) out.enabled = false;
            if (quotaWritten(row.quota)) {
              // 面板上碰过的字段逐个写回（`readQuotaField` 认宽松值，`writeQuotaField` 落真类型）。
              let quota = isObject(row.quota) ? { ...row.quota } : {};
              for (const field of QUOTA_FIELDS) {
                const value = readQuotaField(quota, field);
                if (value !== '' && value !== undefined) quota = writeQuotaField(quota, field, value);
              }
              out.quota = quota;
            }
            return out;
          };

          /** 行标题旁那颗小徽标：把"这个群按什么算、限多少"直接写在行上，不用点开面板。 */
          const quotaBadgeLimit = (quota) => {
            const cost = quota.unit === 'cost';
            const unit = cost ? (quota.currency || 'CNY') : 'token';
            const parts = [];
            const day = Number(cost ? quota.costPerDay : quota.tokensPerDay) || 0;
            const month = Number(cost ? quota.costPerMonth : quota.tokensPerMonth) || 0;
            if (day > 0) parts.push(`每日 ${cost ? `${day} ${unit}` : day}`);
            if (month > 0) parts.push(`每月 ${cost ? `${month} ${unit}` : month}`);
            return parts.length ? parts.join(' / ') : '限额未填（＝不限）';
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
              /** 额度按行配（m14190）：这一行有额度就标一眼，省得翻 JSON 才知道配过没有。 */
              badge: (row) => (quotaWritten(row.quota)
                ? `${row.quota.unit === 'cost' ? '按钱' : '按 token'} · ${quotaBadgeLimit(row.quota)}`
                : ''),
              panel: true,
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
            /**
             * 白名单行的「额度」折叠面板（m14190）：额度按群逐行配，计算方法/单价/报数口径都在这。
             * 面板值直接写回这一行的 `row.quota`——`commit` 会顺手跑 `cleanWhitelist`，
             * 没勾"启用"或限额全 0 的行**不写 quota**，所以 JSON 干净、也不误报"限了"。
             */
            const renderQuotaPanel = (row, index) => {
              const openKey = `${field.key}:${index}`;
              const quota = isObject(row.quota) ? row.quota : {};
              const cost = quota.unit === 'cost';
              const badge = kind.badge ? kind.badge(row) : '';
              return h('div', { key: 'q', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
                h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                  h('button', {
                    key: 't', type: 'button', style: S.button, disabled: !writable || busy,
                    title: '额度按群逐行配：口径（按 token 还是按钱）、单价、日月上限、报数口径',
                    onClick: () => setQuotaOpen((prev) => {
                      const draft = { ...prev };
                      if (draft[openKey]) delete draft[openKey];
                      else draft[openKey] = true;
                      return draft;
                    }),
                  }, quotaOpen[openKey] ? '收起额度' : '额度'),
                  h('span', { key: 'b', style: { ...S.muted, fontSize: 12 } },
                    badge || '不限额（不勾「启用额度」就是不限）'),
                ]),
                quotaOpen[openKey]
                  ? h('div', {
                    key: 'p',
                    style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6 },
                  }, [
                    h('div', { key: 'note', style: { ...S.muted, fontSize: 12 } },
                      `这是 ${kind.title(row)} 自己的账：口径、单价、限额、报数口径都在这儿，不跟别的群混算。`),
                    ...QUOTA_FIELDS.map((field) => {
                      const value = readQuotaField(quota, field);
                      const label = field.limit
                        ? `${field.label}（${cost ? (quota.currency || 'CNY') : 'token'}）`
                        : field.label;
                      return h('label', {
                        key: field.key,
                        className: CLS.sub,
                        style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
                        title: field.hint || '',
                      }, [
                        h('span', { key: 'l', className: CLS.subLabel, style: { flex: '0 1 auto', maxWidth: 168, minWidth: 72, color: 'var(--dsw-alias-label-secondary)' } }, label),
                        field.kind === 'check'
                          ? h('input', {
                            key: 'c', type: 'checkbox', checked: value === true, disabled: !writable || busy,
                            onChange: (event) => update(index, { quota: writeQuotaField(quota, field, event.target.checked) }),
                          })
                          : field.kind === 'select'
                            ? h('select', {
                              key: 's', value: String(value || field.options[0].value), disabled: !writable || busy,
                              className: CLS.subInput,
                              style: { ...S.input, ...S.mono, flex: '1 1 auto', minWidth: 0 },
                              onChange: (event) => update(index, { quota: writeQuotaField(quota, field, event.target.value) }),
                            }, field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
                            : h('input', {
                              key: 'i', type: field.kind === 'number' ? 'number' : 'text',
                              min: field.kind === 'number' ? 0 : undefined,
                              value: value === '' ? '' : String(value),
                              placeholder: field.placeholder,
                              disabled: !writable || busy,
                              className: CLS.subInput,
                              style: { ...S.input, ...S.mono, flex: '1 1 auto', minWidth: 0 },
                              onChange: (event) => update(index, { quota: writeQuotaField(quota, field, event.target.value) }),
                            }),
                      ]);
                    }),
                    h('div', { key: 'foot', style: { ...S.muted, fontSize: 12 } },
                      '用尽后那批只存记忆不调模型，被 @ 时按上面的话术兜一句；额度恢复后会把期间攒的原话补给它（最多 20 条）。账本只存输入/缓存/输出原值，改单价会自动重算历史账。'),
                  ])
                  : null,
              ]);
            };
            return h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              rows.length === 0
                ? h('div', { key: 'empty', style: S.muted }, kind.empty)
                : null,
              ...rows.map((row, index) => h('div', {
                key: `t:${index}`,
                style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
              }, [
                h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
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
                  key: column.key, className: CLS.sub,
                  style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
                }, [
                  h('span', { key: 'l', className: CLS.subLabel, style: { flex: '0 1 auto', maxWidth: 120, minWidth: 48, color: 'var(--dsw-alias-label-secondary)' } }, column.label),
                  Array.isArray(column.options)
                    ? h('select', {
                      key: 's',
                      value: String(row[column.key] ?? column.options[0].value),
                      disabled: !writable || busy,
                      className: CLS.subInput,
                      style: { ...S.input, ...S.mono, flex: '1 1 auto', minWidth: 0 },
                      onChange: (event) => update(index, { [column.key]: event.target.value }),
                    }, column.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
                    : h('input', {
                      key: 'i',
                      type: column.secret ? 'password' : (column.numeric ? 'number' : 'text'),
                      value: row[column.key] === undefined || row[column.key] === null ? '' : String(row[column.key]),
                      placeholder: column.placeholder,
                      disabled: !writable || busy,
                      className: CLS.subInput,
                      style: { ...S.input, ...S.mono, flex: '1 1 auto', minWidth: 0 },
                      onChange: (event) => update(index, { [column.key]: event.target.value }),
                    }),
                ])),
                kind.panel ? renderQuotaPanel(row, index) : null,
              ])),
              h('div', { key: 'ops', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
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

          // 能力白名单：勾选即写入（`m38115`）。值仍是那个 JSON 数组字符串，
          // 所以"手写 glob"这条路没被掐掉——勾选只是它的快捷方式。
          const renderCheckGroup = (field, current) => {
            const text = String(current === undefined || current === null ? '' : current);
            const dis = !writable || busy;
            let list = null;
            try {
              const parsed = JSON.parse(text || '[]');
              if (Array.isArray(parsed)) list = parsed.map((x) => String(x));
            } catch {
              list = null;
            }
            const toInput = (next) => setEdit(field.key, JSON.stringify([...new Set(next)]));
            if (list === null) {
              // 不是合法 JSON：不要猜，让人自己改。猜错了写回去等于把配置吃掉。
              return h('span', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('textarea', {
                  key: 'ta', rows: 3, value: text, disabled: dis,
                  style: { ...S.input, ...S.mono },
                  onChange: (event) => setEdit(field.key, event.target.value),
                }),
                h('span', { key: 'h', style: S.muted }, '这一项不是合法的 JSON 数组（例如 ["delete_msg"]），先修好它。'),
              ]);
            }
            const has = (v) => list.includes(v);
            const toggle = (v) => toInput(has(v) ? list.filter((x) => x !== v) : [...list, v]);
            const row = (item) => h('label', {
              key: item.value,
              title: item.value,
              style: { display: 'flex', alignItems: 'center', gap: 6, ...(dis ? { opacity: 0.6 } : {}) },
            }, [
              h('input', {
                key: 'c', type: 'checkbox', checked: has(item.value), disabled: dis,
                onChange: () => toggle(item.value),
              }),
              h('span', { key: 'l' }, item.label),
            ]);
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
              h('label', {
                key: 'all',
                style: { display: 'flex', alignItems: 'center', gap: 6, ...(dis ? { opacity: 0.6 } : {}) },
              }, [
                h('input', {
                  key: 'c', type: 'checkbox', checked: has('*'), disabled: dis,
                  onChange: () => toggle('*'),
                }),
                h('strong', { key: 'l' }, '全部放行（*）'),
                h('span', { key: 'n', style: S.muted }, `当前 ${list.length} 项`),
              ]),
              ...(CHECK_GROUPS[field.key] || []).map((group) => h('div', {
                key: group.title, style: { display: 'flex', flexDirection: 'column', gap: 4 },
              }, [
                h('span', { key: 't', style: S.muted }, group.title),
                h('div', {
                  key: 'g',
                  style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 12px' },
                }, group.items.map(row)),
              ])),
              h('button', {
                key: 'raw', type: 'button', style: S.button, disabled: busy,
                title: '直接写 glob（比如 send_* 或某个扩展 action），勾选表会跟着重算',
                onClick: () => setCustomKeys((prev) => { const draft = new Set(prev); draft.add(field.key); return draft; }),
              }, '手写 JSON'),
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
            } else if (CHECK_GROUPS[field.key] && onCustom) {
              control = h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                h('input', {
                  key: 'i', type: 'text', value: String(current === undefined || current === null ? '' : current), disabled: !writable || busy,
                  style: { ...S.input, ...S.mono, flex: '1 1 auto' }, onChange: (event) => setEdit(field.key, event.target.value),
                }),
                h('button', {
                  key: 'b', type: 'button', style: S.button, disabled: busy,
                  title: '回到勾选（已写的内容会按它重新勾好）',
                  onClick: () => setCustomKeys((prev) => { const draft = new Set(prev); draft.delete(field.key); return draft; }),
                }, '回到勾选'),
              ]);
            } else if (CHECK_GROUPS[field.key]) {
              control = renderCheckGroup(field, current);
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
            return h('div', { key: field.key, className: CLS.row, style: S.row }, [
              h('div', { key: 'l', className: CLS.label, style: S.label }, [
                h('div', { key: 'zh', style: S.labelZh }, text.label || field.key),
                h('code', { key: 'k', style: S.labelKey }, field.key),
                dirty ? h('span', { key: 'd', style: { ...S.badge, ...S.dirty } }, '已改，未保存') : null,
                isSecret ? h('span', { key: 's', style: S.badge }, secretFilled ? '凭据已设置' : '凭据未设置') : null,
                text.note ? h('span', { key: 'n', style: S.note }, text.note) : null,
              ]),
              h('div', { key: 'c', className: CLS.control, style: S.control }, [
                control,
                hint ? h('div', { key: 'hint', style: S.note }, hint) : null,
              ]),
              h('div', { key: 'a', className: CLS.actions, style: { flex: '0 0 auto', display: 'flex', gap: 6 } }, [
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

          /**
           * 人设库面板（`m23678`）：下拉选默认人设、按钮打开 JSON 编辑窗口。
           *
           * 放在「人设与预设」这一组的配置行**上面**：预设库现在只有这一个入口
           * （`m24027` 把 `persona.defaultName` / `persona.presets` 两个种子配置项删了——
           * 那两项每次启动都会把设置页里改过的同名预设打回去）。
           */
          const personaPanel = () => {
            const rows = (persona.presets || []).filter((preset) => !preset.hidden);
            const current = persona.defaultName || (rows[0] ? rows[0].name : '');
            const selected = rows.find((preset) => preset.name === current) || null;
            const isDefault = !!current && current === persona.defaultName;
            const open = (preset) => setPersonaEdit({
              name: preset ? preset.name : '',
              isNew: !preset,
              error: '',
              text: JSON.stringify(preset
                ? { name: preset.name, role: preset.role, knowledges: preset.knowledges }
                : { name: '', role: '', knowledges: [] }, null, 2),
            });
            return h('div', { key: 'persona', style: S.card }, [
              h('div', { key: 't', style: S.cardTitle }, '人设库（运行时，改完立即生效）'),
              h('div', { key: 'n', style: S.muted },
                '没绑定过角色的会话都用「默认人设」。这块改的是插件运行时那本库（跟 /presets、/set_preset 同一份），'
                + '改完立即生效、重启还在；想给某个群单独换角色，用群里的 /set_preset 或 /set_role。'),
              h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 } }, [
                h('span', { key: 'l', style: S.muted }, '默认人设'),
                h('select', {
                  key: 's',
                  value: current,
                  disabled: personaBusy || !writable || !persona.ok || rows.length === 0,
                  style: { ...S.input, width: 'auto', minWidth: 140, maxWidth: 240 },
                  onChange: (event) => {
                    const name = event.target.value;
                    void applyPersona({ op: 'set-default', name }, `默认人设已改为「${name}」`);
                  },
                }, rows.length === 0
                  ? [h('option', { key: '-', value: '' }, '（库里还没有人设）')]
                  : rows.map((preset) => h('option', { key: preset.name, value: preset.name }, preset.name))),
                h('button', {
                  key: 'e',
                  type: 'button',
                  style: S.button,
                  disabled: personaBusy || !persona.ok || !selected,
                  title: '打开 JSON 窗口，直接改这一条的 name / role / knowledges',
                  onClick: () => open(selected),
                }, '编辑 JSON'),
                h('button', {
                  key: 'new',
                  type: 'button',
                  style: S.button,
                  disabled: personaBusy || !persona.ok || !writable,
                  onClick: () => open(null),
                }, '新建'),
                h('button', {
                  key: 'del',
                  type: 'button',
                  style: S.button,
                  disabled: personaBusy || !persona.ok || !current || isDefault || !writable,
                  title: isDefault ? '默认人设不能删：先把别的设成默认' : `删掉「${current}」（绑定到它的会话会回落默认）`,
                  onClick: () => {
                    void applyPersona({ op: 'remove', name: current }, `已删除人设「${current}」`);
                  },
                }, '删除'),
                personaBusy ? h('span', { key: 'b', style: S.muted }, '写入中…') : null,
              ]),
              persona.ok
                ? null
                : h('div', { key: 'err', style: { ...S.err, marginTop: 6 } },
                  `${persona.note || '人设通道不可用'}——但群里的 /presets 与 /set_role 仍然能用。`),
            ]);
          };

          /** JSON 编辑窗口（`m23678`）：改的是选中那一条，保存后回执就地刷新下拉与列表。 */
          /**
           * 官方通道的扫码面板（`m34313`）：一块二维码 + 三种状态。
           *
           * 只在 `official` 这一组出现——它是**这一组**的专属动作，混进别处会让人以为
           * 扫码能顺带配好别的通道。
           */
          const officialPanel = () => {
            const status = officialQr.status;
            const scanning = status === 'scanning';
            const apply = async (op) => {
              setOfficialBusy(true);
              try {
                const next = await postOfficialQr(op);
                setOfficialQr(next);
                if (next.status === 'ok' && next.appId) report('official-qr', `官方通道已绑定应用 ${next.appId}`);
                else if (!next.ok && next.note) report('official-qr', next.note);
              } finally {
                setOfficialBusy(false);
              }
            };
            const line = (text, style) => h('div', { key: `l:${text}`, style: style || S.muted }, text);
            return h('div', { key: 'official', style: S.card }, [
              h('div', { key: 't', style: S.cardTitle }, '扫码连接官方机器人'),
              h('div', { key: 'n', style: S.muted },
                '用手机 QQ 扫一下，自动拿回 appId / appSecret——不用手抄那串密钥。'
                + '凭据存在插件状态里；配置文件里显式写了 appId / appSecret 的话，以你写的为准。'
                + '扫完会立刻用新凭据重连，不用重启。'),
              status === 'ok' && officialQr.appId
                ? line(
                  `已绑定应用 ${officialQr.appId}。想换一个就重新扫码。`
                  + (officialQr.enabled === false
                    ? ' 不过上游类型还不是「官方接口」——在「基础」里选它才会真的连。'
                    : (officialQr.connected ? ' 当前已连上。' : ' 上游类型选的是官方接口，但这会儿没连上（看日志）。')),
                  officialQr.enabled === false || !officialQr.connected ? S.muted : S.ok,
                )
                : null,
              scanning && officialQr.qr
                ? h('img', {
                  key: 'qr',
                  src: officialQr.qr,
                  alt: '扫码绑定官方机器人',
                  style: { display: 'block', width: 200, height: 200, marginTop: 10, imageRendering: 'pixelated', borderRadius: 6 },
                })
                : null,
              scanning && !officialQr.qr && officialQr.url
                ? line(`二维码画不出来，复制这个链接去别处生成：${officialQr.url}`)
                : null,
              officialQr.note && officialQr.note !== '' ? line(officialQr.note, scanning ? S.muted : S.muted) : null,
              h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 } }, [
                h('button', {
                  key: 'go',
                  type: 'button',
                  style: S.button,
                  disabled: officialBusy || scanning,
                  onClick: () => { void apply('start'); },
                }, scanning ? '正在等扫码…' : (status === 'ok' ? '重新扫码' : '扫码连接')),
                scanning
                  ? h('button', { key: 'no', type: 'button', style: S.button, disabled: officialBusy, onClick: () => { void apply('cancel'); } }, '取消')
                  : null,
                status === 'ok'
                  ? h('button', { key: 'fg', type: 'button', style: S.button, disabled: officialBusy, onClick: () => { void apply('forget'); } }, '清除凭据')
                  : null,
                officialBusy ? h('span', { key: 'b', style: S.muted }, '处理中…') : null,
              ]),
              officialQr.detail ? h('div', { key: 'd', style: { ...S.muted, marginTop: 6, fontSize: 12, opacity: 0.75 } }, officialQr.detail) : null,
            ]);
          };
          const personaDialog = () => {
            if (!personaEdit) return null;
            const close = () => setPersonaEdit(null);
            const fail = (text) => setPersonaEdit({ ...personaEdit, error: text });
            const commit = () => {
              let parsed = null;
              try {
                parsed = JSON.parse(personaEdit.text);
              } catch (err) {
                fail(`不是合法 JSON：${(err && err.message) || err}`);
                return;
              }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                fail('要一个对象：{"name":"…","role":"…","knowledges":["…"]}');
                return;
              }
              const name = String((personaEdit.isNew ? (personaEdit.name || parsed.name) : personaEdit.name) ?? '').trim();
              if (!name) {
                fail('人设必须有名字（保存后改默认、绑定都靠它）');
                return;
              }
              void applyPersona(
                {
                  op: 'save',
                  preset: {
                    name,
                    role: String(parsed.role ?? ''),
                    knowledges: Array.isArray(parsed.knowledges) ? parsed.knowledges : [],
                  },
                },
                `已保存人设「${name}」`,
              ).then((next) => { if (next.ok) setPersonaEdit(null); });
            };
            return h('div', { key: 'overlay', style: S.overlay }, [
              h('div', { key: 'box', style: S.dialog }, [
                h('div', { key: 't', style: S.cardTitle },
                  personaEdit.isNew ? '新建人设' : `编辑人设：${personaEdit.name}`),
                personaEdit.isNew
                  ? h('input', {
                    key: 'name',
                    value: personaEdit.name,
                    placeholder: '人设名字（名字就是身份，保存后要换名只能新建一条）',
                    style: { ...S.input, marginTop: 8 },
                    onChange: (event) => setPersonaEdit({ ...personaEdit, name: event.target.value, error: '' }),
                  })
                  : null,
                h('div', { key: 'n', style: { ...S.muted, marginTop: 8, fontSize: 12 } },
                  'role 是注入 prompt 的第一句（「你是 X，<role>」），写"你是什么人、什么语气"；'
                  + 'knowledges 是一条一条的补充知识，最多 50 条。'),
                h('textarea', {
                  key: 'ta',
                  rows: 16,
                  value: personaEdit.text,
                  spellCheck: false,
                  style: { ...S.input, ...S.mono, marginTop: 6, width: '100%', resize: 'vertical' },
                  onChange: (event) => setPersonaEdit({ ...personaEdit, text: event.target.value, error: '' }),
                }),
                personaEdit.error ? h('div', { key: 'e', style: { ...S.err, marginTop: 6 } }, personaEdit.error) : null,
                h('div', { key: 'act', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } }, [
                  h('button', { key: 'c', type: 'button', style: S.button, disabled: personaBusy, onClick: close }, '取消'),
                  h('button', { key: 's', type: 'button', style: S.primary, disabled: personaBusy, onClick: commit }, '保存'),
                ]),
              ]),
            ]);
          };

          return h('div', { className: CLS.page, style: { padding: '4px 2px 40px' } }, [
            h('style', { key: 'css' }, SHEET),
            // 标题行 + 工具条包成一块吸顶（`m31436`）：几十行配置里保存按钮不用再上下找。
            h('div', { key: 'stick', className: CLS.sticky }, [
              h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, [
                h('div', { key: 't', style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, 'OneBot 枢纽'),
                h('div', { key: 'm', style: S.muted }, [
                  `命名空间 ${ns}`,
                  snap.revision === undefined ? '' : ` · revision ${snap.revision}`,
                  ` · ${fields.length} 个配置项`,
                  writable ? '' : ' · 当前 profile 不允许写入',
                ]),
              ]),
              h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 8px', flexWrap: 'wrap' } }, [
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
            ]),
            h('div', { key: 'hint', style: S.muted }, '改完点保存：值写进 profile 的 cordis.patch.yml，插件会即时重新装配（改的是配置值，不需要重启）。凭据字段不回显明文，留空表示不改。JSON 字符串字段（downstreamTargets / superUsers / presets 等）按 JSON 写。'),
            groupKeys.length === 0 ? h('div', { key: 'empty', style: { ...S.muted, marginTop: 12 } }, '没有匹配的配置键。') : null,
            ...groupKeys.map((head) => h('div', { key: `g:${head || '-'}`, style: S.group }, [
              h('div', { key: 'h', style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } },
                head === '' ? '基础' : (FAMILY_LABELS[head] || head)),
              // 人设这一组先给运行时那块（下拉 + JSON 窗口），开关那行排在后面。
              head === 'persona' ? personaPanel() : null,
              // 官方通道这一组先给扫码（省得手抄 appSecret），下面才是几个配置项。
              head === 'official' ? officialPanel() : null,
              ...groups.get(head).map(renderRow),
            ])),
            personaDialog(),
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
