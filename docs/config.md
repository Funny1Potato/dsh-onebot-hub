# 配置项全表

这份表覆盖插件配置里的**每一项**（共 137 项），键就是配置文件里的完整路径，默认值 = 什么都不配时的行为。设置页里每一项也有同样的中文名与说明，二者由 `test/load-check.mjs` 对账，改配置忘了同步会直接红。

- **怎么改**：DSH 设置页 →「OneBot 枢纽」（行编辑器能拼 JSON 字符串项），或直接改 profile 里本插件的配置。改完大多要重启 DSH / 重载插件才生效（设置页保存会重挂）。
- **表格里的 `—`**：这个键不配（等价留空）；**`空`**：配了也是空字符串；**`开`/`关`**：布尔。
- **字符串型 JSON**：名单、白名单、源码范围这些在表里类型是「字符串」，因为配置里存的是 JSON 字符串（`[{"id":"123"}]`），设置页有行编辑器帮你拼。
- **命令能改的**：`chatCommands` 一族里有一部分能在聊天里临时改（人设、模型、权限），但那些是**会话级**的、只管本次唤醒，不是这里的持久配置。

## 最少要看的四项

| 键 | 为什么先看它 |
| --- | --- |
| `upstreamListen` | 接哪台 QQ 实现端（二选一） |
| `downstreamTargets` | 下游 bot 列表，不接就留空 |
| `chatCommands.superUsers` | 谁能用聊天里的管理命令；**留空 = 整条命令链沉默** |
| `agent.groups` | 哪些群才调模型；不写 = 全部静音 |

## 总开关

一个开关关掉整条链：不连上下游、不喂模型、不写盘。写 `false` 等于停用本插件。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | 开关 | 开 | **总开关**：关掉后整条链静默：不连上下游、不喂模型。profile 里写 false 就等于停用本插件。 |

## 上游：接哪台 QQ 实现端

上游就是真正登录着 QQ 的那台实现端（LLOneBot / NapCat / go-cqhttp…）。**二选一**：让实现端反连我们（`upstreamListen`）或我们去拨它（`upstreamUrl`）。上游账号一般留空让它自动认。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `upstreamUrl` | 字符串 | 空 | **上游地址（我们拨出去）**：正向 WebSocket 地址，形如 ws://127.0.0.1:3001。与 upstreamListen 二选一。 |
| `upstreamSelfId` | 字符串 | 空 | **上游账号**：上游实现端登录的 QQ 号；用来认出"哪条消息是我们自己发的"。留空 = 连上后自动认（握手头 / 事件 / get_login_info），下游"不写对方账号"的目标也会自动跟着它。 |
| `upstreamNickname` | 字符串 | 空 | **上游昵称**：上游账号的昵称（备用，昵称识别时用）。 |
| `upstreamListen` | 字符串 | — | **反向监听地址（含路径）**：上游（LLBot 等）主动拨进来的完整地址：host:port + 路径，如 127.0.0.1:8765/onebot/v11/ws（也能直接粘 ws:// 完整 URL）。**不写路径 = 只接受根路径 /**（写什么就是什么，不偷偷补默认）；留空 = 不监听。 |
| `upstreamAccessToken` | 字符串 | 空 | **上游 access token（凭据）**：留空 = 不校验；设了就要求 Bearer 或 ?access_token=。不回显明文。 |

## 下游：把事件交给哪些 bot

下游是别的 bot 程序（NoneBot 等）。一条 `downstreamTargets` = 一个下游连接，四种连接方式都支持，可写多条。不接下游就留空——只用 hub 自己聊天完全没问题。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `downstreamAccessToken` | 字符串 | 空 | **下游 access token（凭据）**：校验下游拨入/推事件时的 token，留空 = 不校验。不回显明文。 |
| `downstreamTargets` | 字符串 | — | **下游目标（可多条）**：一条 = 一个下游连接。类型四种：ws-dial（我们拨过去）｜ws-listen（我们监听、对方拨进来）｜http-api（我们提供 HTTP API）｜http-post（我们把事件 POST 给对方）。地址统一写 host:port/path（scheme 可省，按类型补 ws:// 或 http://）；对方账号留空 = 与上游账号相同；取消勾选 = 这条先不连（配置留着）。空 = 没有下游。可选字段：probeSelfId = 这条目标**自己的探针账号**——写了它就等于一次声明两条链路：主链路照旧，另加一条 probeOnly 的探针链路（**地址与本条相同、只有对方账号不同**，共用本条的地址/口令/下游组，id 是 `<id>~probe`），不用写两条必须互相对齐的条目；下游那侧要按这个账号再连一条（NoneBot 按 self_id 注册，同 id 第二条会被踢掉）；probeOnly=true 表示这条链路只收 onebot_invoke 的注入、不收上游真人消息（配合探针隔离的 link 档）；downstreamId 用来声明"哪几条链路是同一个下游"（缺省 = 对方账号），状态与时间线都带上它。 |

## 事件怎么投给下游

这一族决定"一条 QQ 消息到达之后，谁能看到、变成什么样"。默认 `relay` 是管理者 + 原样透传；想完全不惊动下游就切 `shadow`。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `preset` | 字符串 | relay | **策略预设**：决定谁管链路、事件怎么投：relay 管理者+透传 / solo（事件不给下游）｜shadow（只观察：hub 不叫模型、不代答、不发消息）｜bridge（下游 send_msg 真发上游，同时广播给其它下游）｜fabric（下游 send_msg 只广播给其它下游，不惊动 QQ）。 |
| `deliveryMode` | 字符串 | transparent | **投递模式**：事件投给下游的方式：transparent 原帧重签 / replay 按目标账号重放 / synthesize 合成事件。 |
| `broadcast` | 开关 | 开 | **广播到所有下游**：一条入站消息是否投给每条下游链路（关掉只投给首个可用链路）。 |
| `readonly` | 开关 | 关 | **只读（hub 不动作）**：打开后 hub 自己绝不动作：不唤醒 agent（不花 token）、不代答聊天命令、也不发消息；事件照旧广播给下游。shadow 预设自带打开；只能打开，关不掉预设自带的那份。 |
| `deliverMessageSent` | 开关 | 关 | **也投递 message_sent**：打开后把"自己发的消息"也当事件投给下游（默认关，防回声）。 |
| `virtualizeMessageId` | 开关 | 关 | **虚拟化消息 id**：透传时改写 message_id，避免上下游 id 空间撞车；部分下游依赖真实 id，慎开。 |

## 链路维护：超时、重连、防环

纯机械参数。默认值对本地网络都够用；跨机器部署再按链路质量调。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `reconnectInterval` | 数字 | 5000 | **重连间隔（ms）**：下游断线后多久重拨一次。 |
| `requestTimeout` | 数字 | 30000 | **action 超时（ms）**：等实现端回 echo 的上限，超时返回 1200 错误。 |
| `heartbeatTimeout` | 数字 | 120000 | **心跳超时（ms）**：监听端多久没收到任何帧就判定上游掉线并断开。 |
| `downstreamHeartbeatMs` | 数字 | 30000 | **下游心跳间隔（ms）**：枢纽主动向下游发心跳的频率。 |
| `echoWindowMs` | 数字 | 3000 | **echo 配对窗口（ms）**：回合配对时，在这段时间内找下游的应答。 |
| `maxHop` | 数字 | 3 | **最大跳数**：防环：事件已带的跳数达到它就停止转发。 |

## 探针隔离（试探下游时别污染真人群）

agent 用 `onebot_invoke` / `onebot_relay_probe` 试探下游命令时，注入的消息要不要和真人消息隔开。默认 `off`（不隔离）；要隔离就在下游目标里补一个 `probeSelfId`。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `probe.isolation` | 字符串 | off | **探针隔离**：agent 用 onebot_invoke 试探下游时怎么和真人消息隔开。off（默认）=不隔离，注入与真人消息走同一条链路；time=探测窗口内该会话的上游消息暂缓投下游、窗口一到按原序补发（不需要额外配置）；link=上游消息一条都不投给探针链路、注入只走那条——探针链路要在下游目标里填 **probeSelfId**（同一个下游的另一个 bot 账号，地址不用改），一个都没配时这一档会**自动回退到 off**。开了链路隔离后，探针结果**可能与用户触发时不同**（这条会写进给 agent 的指导段与每次注入的结果里）。 |
| `probe.windowMs` | 数字 | 8000 | **探测窗口（ms）**：time 档：注入之后多久算这个会话的独占窗口。窗口内的真人消息只是晚到，不会丢。 |
| `probe.maxQueued` | 数字 | 50 | **窗口排队上限**：安全阀：排到这个数就立刻按原序补发，绝不吞消息。 |
| `probe.capture` | 开关 | 开 | **探针链路只捕获不转发**：link 档：探针链路的 send_* 只记进时间线/捕获账本，不真的发到 QQ——探针产物先给 agent 看，要不要说由它决定（默认开）。 |

## 证据与保留（能查到什么、能留多久）

收到的每条消息都会留原文与索引（默认 7 天），agent 排查时用 `onebot_raw` 自己取原文解析。这是"不靠猜"的地基。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `retention.days` | 数字 | 7 | **原始报文保留天数**：收到的每条消息都会缓存原文 + 索引（包括 hub 解析不了的段、以及**不展开**的聊天记录），agent 需要时自己取原文解析。超过这么多天自动清掉：落盘的原始报文日文件、索引里的旧行、以及媒体 blob。**0 = 不清理**。 |
| `retention.cleanupIntervalMs` | 数字 | 21600000 | **清理间隔（ms）**：多久跑一次保留期清理（默认 6 小时）。启动时也会先跑一次。 |
| `persist` | 开关 | 开 | **落盘**：关掉后时间线/记忆/表情包都不写盘，重启即空（调试用）。 |
| `storageDir` | 字符串 | 空 | **存储目录**：留空 = 用宿主 profile 下的默认目录；所有 jsonl 与媒体 blob 都在这里。 |
| `logFrames` | 开关 | 关 | **打印帧日志**：打开后每个 OneBot 帧都写日志，排查用（量很大）。 |

## agent：什么时候醒、说什么、发几条

这一族是拟人化的行为面，也是最常调的一族。默认配置下它很安静：群里没人叫它就不插话。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `agent.mode` | 字符串 | assist | **代理模式**：assist 平时休眠、被叫到才醒（醒了就持续参与一会儿）/ observer 只看不说（不喂模型）/ active 休眠时每 5 分钟看一眼有没有新消息。 |
| `agent.batchSize` | 数字 | 6 | **一批最多几条**：激活状态下攒够这么多条就唤醒一次；休眠时收到的话只是攒着（下次醒来一起看）。 |
| `agent.batchMs` | 数字 | 8000 | **攒批等待（ms）**：激活状态下从第一条新消息算起，等这么久就把这一批交给模型。 |
| `agent.maxActive` | 数字 | 8 | **同时活跃的会话数**：超过就按最近活跃淘汰，防会话池无限涨。 |
| `agent.idleDisposeMs` | 数字 | 1800000 | **空闲回收（ms）**：会话多久没动静就释放它的 agent（下次再建）。 |
| `agent.tickMs` | 数字 | 1000 | **调度节拍（ms）**：批量窗口、激活超时与社交能量的检查频率。 |
| `agent.silenceWhenDownstreamResponded` | 开关 | 开 | **下游答过就闭嘴**：打开后下游 bot 已应答的消息不再喂模型（命令静默）。 |
| `agent.wakeOnPrivate` | 开关 | 开 | **私聊也唤醒**：打开时私聊每条都算被叫到（立刻醒）；关掉后私聊只转发、不叫模型。 |
| `agent.wakeOnNotice` | 开关 | 关 | **通知类也唤醒**：戳一戳、群名片变更等 notice 是否也叫模型（默认关）。 |
| `agent.speakAssistantText` | 开关 | 关 | **把回复文本当发言（老行为）**：默认关：发言一律走 onebot_reply 工具，模型写在回复里的文字只是内部草稿、不发进聊天；打开才恢复『文本兜底＝发言』的老行为。 |
| `agent.awakeMs` | 数字 | 300000 | **激活空转上限（ms）**：最后一次有人说话或它自己回话之后，这么久两边都没动静就回到休眠；0 = 不超时（一直挂着激活状态）。 |
| `agent.activeTickMs` | 数字 | 300000 | **active 判断间隔（ms）**：active 档休眠时每隔这么久看一眼该会话有没有新消息，有就唤醒一次。 |
| `agent.guidance` | 字符串 | 空 | **追加指导（每轮注入）**：写在这里的话每轮都作为系统段进模型，用来调语气、加规矩。 |
| `agent.defaultModel` | 字符串 | 空 | **默认聊天模型**：留空跟 DSH 系统默认路由；从 DSH 的模型清单里选一个就以它为默认，会话里 /model default 也复位回它。清单取不到时退回手写。 |
| `agent.defaultVisionModel` | 字符串 | 空 | **默认识图模型**：留空用系统默认模型；选一个就以它为看图默认，会话里 /vmodel 仍然可以覆盖。 |
| `agent.defaultReasoningEffort` | 字符串 | 空 | **聊天思考强度**：跟上面那个模型配对；档位从该模型的 reasoning 里出（上游 DSH 没给它声明档位就不列）。留空 = 模型自己的默认。 |
| `agent.defaultVisionReasoningEffort` | 字符串 | 空 | **识图思考强度**：跟默认识图模型配对，同上；留空 = 模型自己的默认。 |
| `agent.groups` | 字符串 | [] | **群白名单**：只有列出的群才会调模型（没列的群 @ 也不理）；每条可单独选模式，留「跟随全局」就用上面的代理模式。 |
| `agent.privates` | 字符串 | [] | **私聊白名单**：只有列出的 QQ 号才会调模型；同样可单独选模式。两张名单都是白名单制：清空 = 全部静音。 |
| `agent.steer` | 开关 | 开 | **激活期插话**：打开时，回合没跑完就来的新消息会直接插进正在进行的回合（模型下一步就能看到）；关掉则排队等这一轮说完再看。 |
| `agent.replyGapMs` | 数字 | 400 | **多条消息的间隔（ms）**：一次 onebot_reply 拆成多条时，条与条之间等这么久（像人在一句句打字）。0 = 连发不带停顿。 |
| `agent.replyMaxText` | 数字 | 3 | **一次回复最多几条文字**：只限文字消息的条数——图片不占额度（图另有上限）。超出部分不发送，并在工具回执里如实告知模型。 |
| `agent.replyMaxImages` | 数字 | 9 | **一次回复最多几张图**：图片/表情包的条数上限（每张各自发一条消息）。0 = 不限。 |

### 分群额度（每个群/私聊各记各的）

额度**不再有全局块**，就在 `agent.groups` / `agent.privates` 白名单里**逐行配**：某行写了 `quota` 就按那行算，没写就是这个会话不限。设置页每行有张「额度」折叠面板（口径、单价、限额、报数口径都在里面），行标题旁还会挂个徽标写明"按 token · 每日 1000"之类。记账按本地自然日/自然月，`.quota` 命令随时能查（`.quota reset` 追加解限额度，`.quota reset 50000` 也可）。账本只存输入/缓存/输出三元组原值，**钱是读取时现算的**——改单价、换口径都自动重算历史账。

用尽之后（第二期，m13831）：那一批**只进记忆、不调模型**（退成 observer，群里照常看得见发生过什么，不会丢档）；同时被 @ 就替模型回一句固定话术（`onExhaust`）。攒下的消息不会烂在窗口里——恢复后下一轮会把**期间攒下的最近 20 条原话**补在开头（只补一次，超过 60 条丢最旧的并注明丢了多少），免得模型回来时对群里的事一无所知。报数行受 `noticeCooldownMs` 冷却防刷屏，但**快用完/已用完时不冷却**（那正是模型该知道的时候）。

行内字段（`quota` 对象，全部可选；**限额全是 `0` 或不写 = 不限**）：

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `agent.groups[].quota.enabled` | 开关 | 关 | **这一行要不要记账**：关着就是不设额度（面板里的值会被收起来不写进 JSON）。 |
| `agent.groups[].quota.unit` | 字符串 | token | **计算方法**：`token` = 输入+缓存+输出合算（不区分输入输出）；`cost` = 按下面自填单价折钱。 |
| `agent.groups[].quota.tokensPerDay` | 数字 | 0 | **每日 token 上限**：按本地自然日重置；0 = 不限。 |
| `agent.groups[].quota.tokensPerMonth` | 数字 | 0 | **每月 token 上限**：按本地自然月重置；0 = 不限。日与月谁先到听谁的。 |
| `agent.groups[].quota.costPerDay` | 数字 | 0 | **每日花费上限**：`unit:'cost'` 时才看，单位是 `currency` 那个币种；0 = 不限。 |
| `agent.groups[].quota.costPerMonth` | 数字 | 0 | **每月花费上限**：同上，按本地自然月重置；0 = 不限。 |
| `agent.groups[].quota.currency` | 字符串 | CNY | **币种**：只影响账本显示与文案，不做换算。 |
| `agent.groups[].quota.price.input` | 数字 | 0 | **输入单价（每百万 token）**：群里自填；改了自动按新价重算历史账。 |
| `agent.groups[].quota.price.cache` | 数字 | 0 | **缓存单价（每百万 token）**：命中缓存那部分的单价。 |
| `agent.groups[].quota.price.output` | 数字 | 0 | **输出单价（每百万 token）**：通常最贵的一项。 |
| `agent.groups[].quota.notice` | 字符串 | detail | **报数口径**：`detail` = 每批末尾给已用/限额/剩余；`percent` = 只给剩余百分比；`off` = 不出声。 |
| `agent.groups[].quota.noticeHint` | 开关 | 开 | **顺带提醒模型省着点**：剩余不足时在给模型的指导里提一句，让它自己收着回话。 |
| `agent.groups[].quota.onExhaust` | 字符串 | notice | **用尽后的行为**：`notice` = 被 @ 时回一句额度用完；`silent` = 一个字都不发。 |
| `agent.groups[].quota.exhaustedReply` | 字符串 | 本群今天的额度已经用完了，我先歇会儿，明天 00:00 自动恢复。 | **用尽时的回话**：额度用完且有人 @ 时，替模型发出去的那句固定话术（受 `noticeCooldownMs` 限流）。**不填或留空 = 用上面那句默认**；想彻底闭嘴请把 `onExhaust` 设成 `silent`。 |
| `agent.groups[].quota.noticeCooldownMs` | 数字 | 600000 | **报数冷却（ms）**：两次报数之间至少隔这么久，防话痨群刷屏；快用完/已用完时豁免。设置页里填的是**秒**。 |
| `agent.groups[].quota.superuserBypass` | 开关 | 关 | **超管 @ 也照常记**：默认关——超管 @ 不绕过额度；打开后超管 @ 照常调模型（记账照旧）。 |

`agent.privates` 里的 `quota` 结构一模一样。私聊同样支持额度（配在 `agent.privates` 行里）。

## 能力闸门（谁能写、能不能探测）

安全面：写操作与危险 action 默认**拒绝**，工具不能绕过这里的闸门。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `actionPolicy` | 字符串 | {} | **action 策略（JSON）**：JSON：逐 action 的允许/拒绝规则（与 capability 白名单一起生效）。 |
| `capability.writeAllow` | 字符串 | [] | **写操作白名单（JSON）**：JSON 数组：允许下调的写级 action（如 send_msg）；空 = 全部拒绝。 |
| `capability.dangerAllow` | 字符串 | [] | **危险操作白名单（JSON）**：JSON 数组：踢人/禁言/退群一类；空 = 全部拒绝。 |
| `capability.exposeSensitive` | 开关 | 关 | **回显敏感字段**：打开后只读查询里带 token 之类字段（默认关，防泄漏）。 |
| `capability.cache` | 开关 | 开 | **只读查询缓存**：打开后 get_group_info 之类有 TTL 缓存，返回里 source=cache。 |
| `capability.probe` | 开关 | 开 | **主动探测能力**：启动后自测哪些 action 可用，结果进 onebot_caps。 |
| `capability.downstreamReads` | 开关 | 开 | **下游只读查询**：允许把下游链路也当作实现端来查。 |
| `capability.callTimeoutMs` | 数字 | 15000 | **只读查询超时（ms）**：单次 action 调用的等待上限。 |
| `capability.probeTimeoutMs` | 数字 | 8000 | **探测超时（ms）**：能力自测里每个 action 的等待上限。 |

## 媒体落地（图片语音怎么存）

收到的图片/语音/文件会落成 durable 引用，上游给的 URL 会过期、引用不会。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `media.enabled` | 开关 | 开 | **媒体落地**：关掉后图片/语音/文件都不落地，也就没有 durable ref。 |
| `media.keepBytes` | 开关 | 开 | **保留原始字节**：打开后 blob 存字节，上游 URL 过期也不影响引用。 |
| `media.transcribe` | 开关 | 开 | **语音转写**：试实现端的转写能力；拿不到就如实说"听不了"，不猜内容。 |
| `media.maxBytes` | 数字 | 8388608 | **单文件字节上限**：超过就只记元信息不落地、不进宿主附件（语音/视频/文件走这条）。图片不受此限：大图总会落 blob（识图要原图，超大的图看图前会先压小），只是不进模型主请求。 |
| `media.fetchTimeoutMs` | 数字 | 5000 | **取媒体超时（ms）**：下载图片/语音的等待上限。 |

## 回合配对（谁的消息引发了谁的回复）

纯协议层观测，用来回答"这条消息触发下游做了什么"。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `turns.windowMs` | 数字 | 8000 | **配对窗口（ms）**：入站消息之后多久内，下游的 send_* 才算它触发的。 |
| `turns.retain` | 数字 | 400 | **保留回合数**：内存里最多留多少条回合记录。 |

## 用法学习（下游会吃什么命令）

机械观测：只有下游**真的响应过**的消息才算一次证据，够阈值才升 `active`。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `learn.threshold` | 数字 | 3 | **几次观测算数**：下游真响应过 N 次，才把这条用法升为 active。 |
| `learn.staleAfter` | 数字 | 3 | **几次没复现降级**：连续 N 次未复现就标 stale、降置信。 |
| `learn.forgetAfter` | 数字 | 6 | **几次没复现删除**：连续 N 次未复现才真正从表里删掉。 |
| `learn.maxEvidence` | 数字 | 20 | **每条最多留几条证据**：证据是"哪条消息触发了什么"，用于回看。 |

## 代码范围与群资料

`code.scopes` 只告诉 agent 源码在哪，不给它工具；`cards`/`members` 决定要不要把群资料和成员表抓下来备查。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `code.scopes` | 字符串 | [] | **下游源码范围（可多条）**：一条 = 一个下游的源码在哪（可能有多个下游）。备注可空。**这些路径不写进 prompt**：agent 需要时调 onebot_code_scopes 取位置，读文件用它自己带的工具（read/grep/glob）——枢纽不代读、也不需要配扫描器。权限由超管在会话里给（或 /perm）。空 = agent 问位置时如实说没配。 |
| `cards.maxLines` | 数字 | 40 | **会话卡最多几行**：每张会话卡保留的行为条数。 |
| `cards.maxSessions` | 数字 | 200 | **最多几张会话卡**：超过按最久没用的淘汰。 |
| `members.enabled` | 开关 | 开 | **按需解析成员名**：at 到还没名字的人时问一次实现端（比一直叫"用户10002"强）。 |
| `members.cooldownMs` | 数字 | 21600000 | **同一人冷却（ms）**：多久之内不再为同一个人问名字。 |
| `members.maxPerMessage` | 数字 | 5 | **每条最多问几个**：一条消息里最多解析几个陌生人，防刷。 |
| `members.maxQueue` | 数字 | 50 | **排队上限**：待解析队列满了就丢弃新的。 |

## 识图（图片怎么变成模型看得懂的话）

默认 `describe`：把图交给视觉模型写成人话再进上下文，图本身不进请求。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `vision.mode` | 字符串 | describe | **看图模式**：describe 让视觉模型给描述 / segment 只把图片段交给会话模型 / both / off。识图模型默认用系统默认模型，要按会话换就用 `vmodel` 命令（前缀见「聊天管理命令」那节）。 |
| `vision.prompt` | 字符串 | 空 | **用户侧提示词**：给视觉模型的图描述要求；留空用内置中文提示。 |
| `vision.system` | 字符串 | 空 | **系统提示**：视觉模型的 system 段。 |
| `vision.maxTokens` | 数字 | 0 | **单次最多输出 token**：0 = 不传该参数（默认，描述不做长度控制）；填 >0 才给单次生成加上限。 |
| `vision.timeoutMs` | 数字 | 30000 | **超时（ms）**：等描述的上限，超时就放弃并如实说明。 |
| `vision.cacheLimit` | 数字 | 500 | **缓存张数**：按 sha256 缓存描述，同一张图不重复问。 |

## 人设（agent 是谁）

名字、性格、说话风格。可以按群套不同预设。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `persona.enabled` | 开关 | 开 | **人设**：关掉后没有角色设定段，模型按默认风格说话。 |
| `persona.defaultName` | 字符串 | default | **默认预设名**：新会话没绑定过角色时用哪一个预设。 |
| `persona.presets` | 字符串 | [] | **预设库（JSON）**：JSON 数组：启动时的种子；之后以落盘的 bindings.json 为准（空 = 用内置 default）。 |

## 聊天管理命令（人打的那几条）

这些命令只认消息文本、完全不经过模型，触发者必须是 `superUsers` 里的账号。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `chatCommands.enabled` | 开关 | 开 | **聊天管理命令**：关掉后 `status` 一类命令不再由枢纽处理（消息照常转发给下游）。 |
| `chatCommands.prefix` | 字符串 | / | **命令前缀**：命令名本身固定，前缀换成什么都能用（配成 `!` 就敲 `!help`）；只认**句首**前缀。它是公共前缀，下游有同名命令也照常触发，枢纽不抢。 |
| `chatCommands.bypassPrefix` | 字符串 | !! | **让路前缀**：加在原命令前面，枢纽连那条回话都不要、当普通消息走（默认前缀下如 `!!/reset`）。 |
| `chatCommands.superUsers` | 字符串 | [] | **超管名单（JSON）**：JSON 数组，如 ["10001"]；空 = 整条链沉默（不猜谁是管理员）。 |
| `chatCommands.maxReplyChars` | 数字 | 800 | **回话长度上限**：超长就截断，防刷屏。 |

## 表情包库

收哪张由 agent 自己决定；这里管容量、每次最多发几张、进上下文列几个。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `memes.enabled` | 开关 | 开 | **表情包库**：关掉后不收集也不发送表情。 |
| `memes.topK` | 数字 | 8 | **上下文里列几张**：装配 prompt 时最多列几个候选 id。 |
| `memes.maxSend` | 数字 | 3 | **一次最多发几张**：单条回复里的表情数量上限。 |
| `memes.maxCount` | 数字 | 200 | **库容量上限（张）**：超过后自动淘汰最少用、最久未用的；最近用过的几张受保护。改动重启后生效。 |
| `memes.autoCollect` | 开关 | 开 | **允许收录**：关掉后 agent 也不许收录表情包（库只读）。收集本身由 agent 判断，不自动收。 |

## 番剧识别（图片补角色名）

接动漫识别后端给图片补一行角色名；默认关。认不出就说认不出，不编造。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `anime.backend` | 字符串 | off | **识番后端**：off 完全关 / anime-recognize 本地 / animetrace 线上 / both 本地优先。 |
| `anime.recognizeUrl` | 字符串 | 空 | **本地识别接口**：anime-recognize 服务的地址。 |
| `anime.recognizeToken` | 字符串 | 空 | **本地识别 token（凭据）**：留空 = 不带鉴权头。不回显明文。 |
| `anime.animetraceUrl` | 字符串 | https://api.animetrace.com | **AnimeTrace 地址**：默认官方接口，可换自建。 |
| `anime.minConfidence` | 数字 | 0.85 | **置信度下限**：低于它不报角色名（宁缺毋滥）。 |
| `anime.maxCharacters` | 数字 | 1 | **最多报几个角色**：超出按置信度截断。 |
| `anime.nsfwThreshold` | 数字 | 0.5 | **NSFW 阈值**：超过就不发识别结果（防翻车）。 |
| `anime.timeoutMs` | 数字 | 15000 | **超时（ms）**：识别请求的等待上限。 |
| `anime.cacheLimit` | 数字 | 500 | **缓存张数**：按 sha256 缓存识别结果。 |

## 生图（让 agent 自己画）

默认关，必须配 `model`/`baseUrl`/`apiKey` 才开；生成后**不自动发群**，由 agent 决定要不要发。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `imageGen.enabled` | 开关 | 关 | **生图**：默认关；开了还要配 model/baseUrl/apiKey，缺一个仍是关。 |
| `imageGen.model` | 字符串 | 空 | **模型名**：OpenAI 兼容生图接口的模型 id。 |
| `imageGen.baseUrl` | 字符串 | 空 | **接口地址**：形如 https://…/v1（不要带 /images/generations）。 |
| `imageGen.apiKey` | 字符串 | 空 | **API Key（凭据）**：留空 = 不改。不回显明文。 |
| `imageGen.maxSize` | 字符串 | 1024x1024 | **尺寸上限**：形如 1024x1024；请求的 size 会等比内缩到它以内。 |
| `imageGen.minSize` | 字符串 | 空 | **尺寸下限**：留空 = 不设下限。 |
| `imageGen.watermark` | 开关 | 关 | **加水印**：非 OpenAI 官方参数，默认不发；显式开启才透传 watermark 给支持它的中转接口。 |
| `imageGen.timeoutMs` | 数字 | 120000 | **超时（ms）**：生图等待上限（图确实慢，默认给得很宽）。 |
| `imageGen.maxPerTurn` | 数字 | 1 | **每轮最多几张**：一轮对话里的硬上限，超了明确说"这轮画完了"。 |
| `imageGen.engine` | 字符串 | builtin | **生图引擎**：builtin＝hub 自带的 OpenAI 兼容生图（默认）；plugin＝不自己生图，把第三方插件的生图工具放进 agent 工具面。 |
| `imageGen.delivery` | 字符串 | agent | **生成后发送时机**：agent（默认）＝生成后由 agent 决定发不发群；direct＝生成完立刻直发到指定会话。 |
| `imageGen.plugin.tool` | 字符串 | 空 | **第三方生图工具名**：engine=plugin 时用；逗号分隔或数组。留空＝自动探测（generate_image 等已知名单）。 |
| `imageGen.plugin.timeoutMs` | 数字 | 180000 | **探测/后处理超时（ms）**：预留的后处理等待上限，当前主要留作扩展。 |

## 记忆（记人、记群、记承诺）

它会记住人、群、承诺与话题；`isolation` 决定这些内容跨会话能不能互相看见。

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `memory.limit` | 数字 | 5000 | **记忆总条数上限**：超过就按重要度与新旧淘汰。 |
| `memory.peopleRoster` | 数字 | 20 | **本群认识的人（最多几个）**：上下文里列出本群我认识的人（按最近露面排序）；0 = 不列。细节仍可用 onebot_person 现查。 |
| `memory.reminders.enabled` | 开关 | 开 | **定时提醒**：打开后"答应过的事"到期会冒出来提醒。 |
| `memory.reminders.windowHours` | 数字 | 24 | **提醒窗口（小时）**：到期前后多久内算"该提了"。 |
| `memory.reminders.limit` | 数字 | 5 | **一次提几条**：单轮最多提醒几条。 |
| `memory.reminders.max` | 数字 | 200 | **最多存几条提醒**：超过淘汰最旧的。 |
| `memory.isolation.level` | 字符串 | scoped | **隔离级别**：strict 只在本会话 / scoped 按会话可见（默认）/ balanced 折中 / open 最松。 |
| `memory.isolation.crossGroupIdentity` | 开关 | 开 | **跨群认同一个人**：打开后同一个人在不同群共用一个档案。 |
| `memory.isolation.crossGroupFacts` | 字符串 | shareable | **跨群事实**：shareable 标记过的，以及点了名、人都在本群的，可跨群（默认）/ never 永不 / all 全部（连没点名的群内事实也跨）。 |
| `memory.isolation.privateFacts` | 字符串 | never | **私聊事实**：never 私聊内容不出私聊（默认）/ sameActor 同一个人可见 / all 全部。 |
| `memory.isolation.sensitivityAlwaysLocal` | 开关 | 开 | **敏感内容永远本地**：打开后敏感事实不参与跨会话装配（不看 level）。 |
| `memory.isolation.overrides` | 字符串 | [] | **逐项覆盖（JSON）**：JSON 数组：给单条记忆指定可见范围。 |
| `memory.isolation.trustedGroups` | 字符串 | [] | **可信群（JSON）**：JSON 数组：这些群之间可以互相看见（仍受 level 约束）。 |
| `memory.isolation.recallEscape` | 开关 | 关 | **允许越界检索**：打开后 onebot_recall 能跨会话翻旧账（默认关）。 |
| `memory.isolation.recallEscapeNeedsApproval` | 开关 | 开 | **越界要确认**：打开后越界检索要显式 confirm 才给。 |
| `memory.isolation.audit` | 开关 | 开 | **留审计**：每次放行/拦截都记一条，可用 onebot_memory_audit 查。 |
| `memory.isolation.auditRetain` | 数字 | 200 | **审计保留条数**：账本最多留多少条。 |

### 谁能看见什么（放行表）

跨会话装配记忆时，`isolation` 实际怎么判定。**同会话、同世界一律可见**，不看下面任何一档（敏感条目与"点的人已不在群"也一样）——它们连闸门都走不到，早退发生在那之前。

| 条目类型（跨群时） | strict | scoped | balanced | open |
| --- | --- | --- | --- | --- |
| 身份条目（`X 是 QQ Y`；现在只剩存量与导入数据） | 拦 | 放 | 放 | 放 |
| 私聊事实（`visibility: private:*`） | 拦 | 拦 | 拦 | 拦 |
| 可共享事实（`visibility: shareable`） | 拦 | 拦 | 放 | 放 |
| 群内事实 · 点了名且人都在本群 | 拦 | 拦 | 放 | 放 |
| 群内事实 · 没点名 | 拦 | 拦 | 拦 | 放 |
| 敏感条目（任何 `visibility`） | 拦 | 拦 | 拦 | 拦 |
| 点了名但有人不在本群 / 成员表不全 | 拦 | 拦 | 拦 | 拦 |

三点容易误解的地方：

1. **档位只切 `level`，不改四个子开关。** 上表是四个子开关取默认值（`crossGroupIdentity` 开、`crossGroupFacts` shareable、`privateFacts` never、`sensitivityAlwaysLocal` 开）的结果。所以 `open` **也不放**私聊事实与敏感条目——想放得单独改那两个开关。
2. **`level` 不是"档位名越大越宽松"的单一旋钮**：`open` 与 `balanced` 的差别只有"没点名的群内事实"和"点了个不在群的人"这两类（后者在 open 下由闸门先拦，档位管不到）。
3. **点名闸门排在 `level:open` 之前**：只要「讲的是谁」里的人此刻不在本群，`open` 也放不出去。

### `crossGroupFacts` 到底管哪几格

它只作用于两类条目（`shareable` 与 `group:x`），而且**要么完全无效、要么就是唯一决定因素**：

| `level` · `crossGroupFacts` | 可共享事实 | 群内事实·点名·人在本群 | 群内事实·没点名 | 身份条目 |
| --- | --- | --- | --- | --- |
| `scoped` · 任意值 | 拦 | 拦 | 拦 | 放 |
| `balanced` · `never` | 拦 | 拦 | 拦 | 放 |
| `balanced` · `shareable`（默认） | 放 | 放 | 拦 | 放 |
| `balanced` · `all` | 放 | 放 | 放 | 放 |
| `open` · `never` | 拦 | 放 | 放 | 放 |
| `open` · `shareable` / `all` | 放 | 放 | 放 | 放 |

- **`scoped` 下它完全无效**（三种取值结果一模一样，那两类条目本来就不放）；**只有 `balanced` 是它真正决定结果的档位**。
- **它不动身份条目与私聊事实**——那两类分别由 `crossGroupIdentity`、`privateFacts` 管。
- `all` 与 `shareable` 的**唯一差别**就是"没点名的群内事实"那一格：`all` 放开全部群内事实（实测一个群几百条），`shareable` 只放点了名、且人确实在本群的。
- 已知不自洽：`open · never` 那一行，可共享事实被 `never` 拦住、群内事实却照样放行——两条分支的返回顺序不同（可共享事实先查 `never` 再看档位，群内事实先看 `open` 再查 `never`）。

## 排查用的落盘物

- `<storageDir>/startup.log`：启动逐阶段标记与失败堆栈，插件起不来先看它。
- `<storageDir>` 默认 `~/.dsh/onebot-hub`：时间线 jsonl、原始报文、媒体 blob、记忆与人物档案都在这里。
- 跑起来之后用 `onebot_hub_status` / `onebot_timeline` / `onebot_turns` / `onebot_raw` 查，不靠猜。

相关文档：[README](../README.md)（行为与工具概览）、[design-notes.md](design-notes.md)（每个决定的来龙去脉）。
