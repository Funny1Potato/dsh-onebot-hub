<div align="center">

# dsh-onebot-hub

**把 DeepSeek Harness 接到 QQ（OneBot v11）上，并让它看清整条链路发生了什么。**

<p>
<img src="https://img.shields.io/npm/v/dsh-onebot-hub?style=flat-square&logo=npm&logoColor=white" alt="npm">
<img src="https://img.shields.io/npm/l/dsh-onebot-hub?style=flat-square" alt="license">
<a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
</p>

中文 | [English](#english)

</div>

> **已经有一个 NoneBot 机器人，又用不上 DSH？**
> 那这个插件解决不了你的问题——它自己不是聊天机器人，只是把 **DSH agent** 和一个看得见的
> OneBot 枢纽接在一起。想要一个能直接聊天的群友，装
> [nonebot-plugin-aigf-master](https://github.com/Funny1Potato/nonebot-plugin-aigf-master)
> 就行：记忆、人设、表情包、什么时候该开口，它都自带。
> 往下读的前提是这两个之一：**你想让 DSH 进群**，或者**你想看清群里到底发生了什么**。

## 📖 这是什么

一句话：**它是一个 OneBot v11 的"枢纽"**——上面接真正登录着 QQ 的实现端，下面接你的 NoneBot 插件，中间坐着 DSH 的 agent。

```
              QQ 客户端（真人在聊天）
                     │
                     ▼
        ┌──────────────────────────┐
        │  QQ 实现端                │   LLOneBot / NapCat / go-cqhttp
        └────────────┬─────────────┘
                     │ OneBot v11 WebSocket
                     ▼
        ┌────────────────────────────────────────┐
        │  dsh-onebot-hub                        │
        │  ① 上游：收全部事件，持有全部 action      │
        │  ② 观测：时间线 / 谁做了什么 / 原始报文   │
        │  ③ agent：记忆、人设、决定要不要说话      │
        │  ④ 下游：把事件原样转发给 N 个下游 bot    │
        └────────────────────────┬───────────────┘
                     │ OneBot v11（四种连法任选，可多条）
                     ▼
            NoneBot / 其它 OneBot bot（可多个）
```

### 为什么需要它 → 它能替你做什么

| 你想要 | 没有 hub | 有 hub |
| --- | --- | --- |
| 让 DSH 进群聊天 | DSH 不认 OneBot 协议，接不上 | agent 拿到全部消息与全部 action |
| 机器人到底在干什么 | 只能翻日志猜 | `onebot_timeline` 看消息、`onebot_turns` 看"谁引发了什么"、`onebot_raw` 看原始报文 |
| 想换/加一个下游 bot | 得把 QQ 实现端重新接一遍 | 加一条 `downstreamTargets`，现有插件**一行代码都不用改**（事件原样转发） |
| 试探下游插件又怕惊动群 | 真发消息试 | 探针走**另一个账号**，真人消息串不进去 |
| 一个群一个模型/一个角色 | 做不到 | 白名单 + 人设预设 + 分群额度，逐群配 |

> 只想让 DSH 在群里说话、不接任何下游 bot？完全可以：`downstreamTargets` 留空就行。

## ✅ 前置条件

开始之前，你至少需要：

1. **一个 QQ 实现端**（真正登录着 QQ 号的那一层）：LLOneBot、NapCat、go-cqhttp 等，且它支持 OneBot v11 的 WebSocket（反向或正向都行）。
2. **一个能跑的 DSH**（DeepSeek Harness），并且里面配好了可用的模型。
3. 可选：想路由给下游的 NoneBot 插件（没有也能用）。

> 插件本身**不需要** Python、不需要编译，运行时只依赖 `ws`，包里自带构建好的 `lib/`。

## 💿 安装

插件已发布到 npm：[`dsh-onebot-hub`](https://www.npmjs.com/package/dsh-onebot-hub)。

用 DSH 自带的插件管理器装进某个 profile（`<你的 profile>` 换成 profile 名，比如 `desktop`）：

```sh
dsh plugin --profile <你的 profile> add dsh-onebot-hub
```

这条命令只是把参数转给该 profile 目录下的 pnpm，所以等价写法是：

```sh
cd ~/.dsh/profiles/<你的 profile>
pnpm add dsh-onebot-hub
```

<details>
<summary>装完要不要手改 <code>cordis.patch.yml</code>？</summary>

**默认不需要**。包里声明了 `dsh.bundle`，装好会被自动并入 profile 的插件层。

万一个别版本的 DSH 没有自动并入，就在该 profile 的 `cordis.patch.yml` 里**追加**下面三行（别动已有条目）再重启：

```yaml
- insert:
  - id: onebot-hub
    name: 'dsh-onebot-hub'
```

</details>

<details>
<summary>想装开发版 / 自己改过的版本？</summary>

```sh
pnpm add github:Funny1Potato/dsh-onebot-hub     # Git 源：拉源码，需要 prepare 脚本并放行构建
pnpm add file:D:/path/to/dsh-onebot-hub         # 本地目录：改完重启即生效
```

</details>

装好后**重启 DSH**，设置页里会多出一个「OneBot 枢纽」分节。

## 🚀 五分钟上手

### 第 1 步：装好并重启

打开 DSH 设置页 →「OneBot 枢纽」，能看到一堆配置项就说明插件加载成功了。

### 第 2 步：把你的 QQ 实现端接上来

推荐**让实现端反连 hub**（不用在 hub 里填上游地址，实现端换 IP 也不影响）：

1. 在设置页填 `upstreamListen`：

   ```
   127.0.0.1:8765/onebot/v11/ws
   ```

   > 这是"监听地址 + 路径"，写什么就监听什么，**不写路径只接受根路径 `/`**。

2. 在 LLOneBot（或 NapCat）里打开 **WebSocket 反向（反向 WS）**，地址填同一个：

   ```
   ws://127.0.0.1:8765/onebot/v11/ws
   ```

3. 保存 → 重启 DSH（或直接在设置页保存，效果一样）。

**怎么确认接上了**：在 hub 自己的会话里问它一句，让它调 `onebot_hub_status`；或者看设置页顶部状态。日志在 `<storageDir>/startup.log`（默认 `~/.dsh/onebot-hub/startup.log`）。

> 也可以反过来——hub 主动拨实现端：填 `upstreamUrl`（形如 `ws://127.0.0.1:3001`），`upstreamListen` 留空。两者**二选一**。

### 第 3 步：告诉它"哪些群可以说话"

**默认它是全静音的**：不写白名单，任何群、任何人 @ 它都不响。

- `agent.groups`：允许调模型的群号，JSON 数组，如 `["123456789"]`
- `agent.privates`：允许调模型的 QQ 号，JSON 数组，如 `["10001"]`
- `chatCommands.superUsers`：谁能用聊天里的管理命令，如 `["10001"]`（**留空 = 整条命令链沉默**）

**怎么确认**：在群里敲 `/status`，超管应该能收到一条状态回执。

### 第 4 步：在群里 @ 它

被 `@`、被引用、或者私聊发消息，它才会醒——醒了会参与一会儿，之后没人理它就自己睡回去。

**至此最小可用配置就完成了**，剩下的都是按需打开。

## ⚙️ 配置

**全部配置项与默认值见 [docs/config.md](docs/config.md)**（设置页里每个字段的中文名和说明也来自那里，二者由测试对账，不会各说各话）。

### 最少要配的

| 键 | 说明 |
| --- | --- |
| `upstreamListen` | 接哪台 QQ 实现端。推荐用它（让实现端反连）。与 `upstreamUrl` 二选一 |
| `downstreamTargets` | 下游列表，JSON 数组，可多条。**不接下游就留空** |
| `agent.groups` / `agent.privates` | 白名单：写了的群/QQ 才调模型。两张都空 = 全部静音 |
| `chatCommands.superUsers` | 谁能用管理命令。留空 = 命令链整条沉默 |

### 常改的

| 键 | 什么时候改它 |
| --- | --- |
| `agent.mode` | `assist`（默认，被叫到才醒）/ `observer`（只看不说）/ `active`（休眠时每 5 分钟看一眼有没有新消息） |
| `agent.batchSize` / `agent.batchMs` | 一批攒几条（默认 10）、等多久（默认 20000 ms） |
| `agent.speakAssistantText` | 默认 `false`：**普通回复文本只是内部草稿，只有调 `onebot_reply` 才会真发进群** |
| `agent.replyMaxText` / `replyMaxImages` / `replyGapMs` | 一次回复最多几条文字（3）、几张图（9）、条与条之间隔多久（400 ms） |
| `agent.replyOnSendFailure` | 发送失败当场告知模型（默认开）：立刻排一次唤醒让它知道第几条没发出去，能当场重试；`sendFailureNudgeMax`/`sendFailureNudgeWindowMs` 是刹车（2 次 / 5 分钟） |
| `chatCommands.prefix` / `bypassPrefix` | 命令前缀（默认 `/`）、让路前缀（默认 `!!`） |
| `vision.mode` | 看图方式：`describe`（把图交给视觉模型写成人话，默认）/ `segment`（把图本身给模型）/ `off` |
| 人设预设 | 群里的角色设定（名字、性格、说话风格），可按群套用——在设置页「人设与预设」里改。库里自带「小助手」（默认）与「蓝色大肥鱼」两条，可改可删 |
| `memes.enabled` / `memes.maxSend` | 表情包库；收哪张由 agent 自己决定，`maxSend` 限一次发几张 |
| `imageGen.enabled` | 让 agent 自己生图（默认关，填 `model`/`baseUrl`/`apiKey` 才开） |
| `anime.backend` | 二次元角色识别（默认 `off`；[anime-recognize](https://github.com/Funny1Potato/aigfm-anime-recognize) 本地 / `animetrace` 公共 API / `both`） |
| `memory.isolation.level` | 记忆隔离：`strict` / `scoped` / `balanced`（默认）/ `open`，见[记忆系统](#-记忆系统) |
| `memory.peopleRoster` | 上下文里【本群认识的人】最多列几个（默认 20；`0` = 整段不注入） |
| `retention.days` | 原始报文与媒体保留天数（默认 7） |
| `probe.isolation` | 试探下游时怎么和真人消息隔开：`off`（默认）/ `time`（时间窗）/ `link`（另开探针账号），见[探针](#探针试探下游不惊动群) |
| `code.scopes` | 下游 bot 的源码目录。地址不写进 prompt，agent 需要时用 `onebot_code_scopes` 取 |
| `agent.groups` 行内的 `quota` | 分群额度，**逐行配**，见[额度](#额度分群记账) |

### 设置页

设置页里的每个字段都有中文名、配置键和一句说明；改动**先暂存**，点保存才落盘（个别字段标了 `volatile`，改了立刻生效）。宽屏是左右两栏，窄屏会自动堆叠成上下结构。

## 💬 聊天里的命令（13 条）

只有 `chatCommands.superUsers` 里的账号能用（**留空 = 整条命令链沉默**）。别人敲同样的字，枢纽一声不吭——回一句"你没权限"等于告诉全群这里有个能管事的 bot。

**下表省略前缀**：前缀由 `chatCommands.prefix` 定（默认 `/`）。配成 `!` 就敲 `!help`——命令名本身不变。

| 命令 | 别名 | 作用 |
| --- | --- | --- |
| `help` | `帮助` `?` | 列出这 13 条 |
| `status` | `状态` | 链路、模式、时间线、运行时长、人设、表情包一屏概览 |
| `presets` | `preset` `预设` | 列出可用人设预设（`→` 表示本会话在用） |
| `set_preset <预设名>` | `set_presets` `设置预设` | 把本会话切到某个预设 |
| `set_role <名字> <设定>` | `设置角色` | 临时给本会话换个角色名和设定 |
| `preset_role <设定>` | `设置设定` | 只改设定，不改角色名 |
| `memes` ｜ `memes del <id>` | `表情包` `meme` | 看最近 10 个；`del` 删掉某个 |
| `reload_meme` | `重载表情包` | 从磁盘重读一遍表情包索引 |
| `perm [预设名]` | `permission` `权限` | 看 / 换**本会话 agent** 的权限预设（只管本次激活） |
| `model [provider/model｜编号｜default]` | `模型` `聊天模型` | 看 / 换本会话的聊天模型 |
| `vmodel [provider/model｜编号｜default]` | `视觉模型` `识图模型` | 看 / 换本会话的识图模型 |
| `reset` | `重置` | 本会话的人设绑定与模型选择回初始（**不动长期记忆**） |
| `quota [reset [额度]]` | `额度` | 查今天/本月用量；`reset` 抹掉今天已用，带数字＝追加额度 |

三条要知道的语义：

1. **命令不吞消息**：命中后消息照常转发给下游、照常给模型看，只跳过"喂模型"这一步（枢纽已经用同一个账号答过这句话）。
2. **前缀撞车 = 两个都触发**，不是谁先谁赢。想让枢纽别管某一条，加让路前缀：`!!/help`。
3. **只在开头认前缀**：`你好 /status` 是聊天，不是命令。回话超 `chatCommands.maxReplyChars`（默认 1500 字）会截断。

预设库有三条改法：**设置页「人设与预设」**（最省事——下拉选默认人设、JSON 窗口改选中的那一条，改完立即生效）、`/set_preset`（把**当前会话**切过去）、`/set_role` 与 `/preset_role`（给当前会话复制一份私有分叉 `@session/<会话>`，不污染共享预设）。预设库只有一份权威：`<storageDir>/persona/presets.json`，**没有对应的配置项**。

## 🧠 记忆系统

agent 不是"每轮都把聊天记录读一遍"，它有**三层心智 + 五个落点**：

| 层 | 记什么 | 什么时候用 |
| --- | --- | --- |
| **活跃层** | 现在活着的事：进行中的话题、agent 正在做的事 | 每轮都注入，做完要结算 |
| **长期记忆** | 群里值得记住的**事件**，一行一条 | 每轮常驻，是"索引" |
| **人物档案** | 关于某个人的稳定事实：处境、答应过什么、爱聊什么 | 聊到这个人时注入 |
| **群档案** | 群名、人数、群主、公告、群氛围 | 只在本群注入 |
| **话题归档** | 一件事的细节：事件、参与人、结论、起止时间 | 按 id 查，不常驻 |

### 活跃层：它现在在干什么

活跃层回答两个问题——「这个群现在在聊什么」和「我自己正在做什么」。注入时长这样：

```
【进行中的话题】
0. [群 55555] 讨论换显卡型号，卡在电源瓦数上
1. [与 10001 的私聊] 帮我改插件的配置项
【我正在做的事】
2. [群 55555] 正在替小张整理显卡选购清单
```

- **每条都带出处**，所以你在 A 群能看见"B 群还在聊什么"——不会张冠李戴。
- 做完一件事要**结算**：留在长期记忆里一行摘要，或者直接删掉。一直不结算的条目，一天后会提醒它一次。
- 活跃层**跨会话共享**要看隔离档位和白名单，见下。

### 长期记忆：一行一条的索引

```
0. [群 123456789] 群里最后定了磨豆机买 A 款（2026-10-06；相关：小张）
1. [群 55555] 周末的抽奖活动取消了（2026-10-02）
```

- 行首是**出处**，行尾是**日期**和**跟谁有关**。
- 它是**索引**：细节在档案里，方括号会告诉你去哪儿看（`〔详见 话题：显卡选购〕`）。
- `related_users` 不是"这条记的是谁"，而是**"这件事跟谁有关"**——带上了，它就只会在"这些人也在的群"里被想起来。

### 隔离：谁能看见什么

`memory.isolation.level` 四档（默认 `balanced`）：

| 档位 | 别的群的群内事实 | 私聊内容 | 身份（谁是谁） | 活跃层跨群 |
| --- | --- | --- | --- | --- |
| `strict` | 不可见 | 不可见 | 可见 | 只在本会话 |
| `scoped` | 不可见 | 按 `privateFacts`（默认 `sameActor`：那个人自己在场时才看得见） | 可见 | 只在本群 |
| `balanced`（默认） | 标了 `shareable` 的可见 | 同上 | 可见 | 白名单内 + 有共同活跃群友 |
| `open` | 全部可见 | 按 `privateFacts` | 可见 | 白名单内全可见 |

两条覆盖规则：

- **敏感内容永远留在本会话**——命中词表（住址、身份证、银行卡、工资、病历、离婚…）或模型自己标了 `sensitive`，任何档位都不外传。
- **群档案不进共享**：`culture`、公告、成员表只在本群上下文里出现。

### 谁在写

- **代码观测**：群名、人数、群主、公告、成员表、谁最近说过话——这些是"观测到的"，模型改不了。
- **模型写**：事件、人物事实、群氛围、话题细节——写错了可以改，用上下文里的序号定位。
- **可见性**：任何情况下都由代码判定，模型声明的 `visibility` 一律被忽略（`sensitive:true` 例外：它只会**收窄**）。

## 🔌 上游、下游与观测

### 上游：接哪台 QQ 实现端

`upstreamListen`（推荐，实现端反连）或 `upstreamUrl`（hub 拨出去）二选一。上游账号一般留空，连上后自动认（握手头 / 事件 / `get_login_info`）。

### 下游：把事件交给别的 bot

一条 `downstreamTargets` = 一个下游连接，**四种连法**：

| 类型 | 谁连谁 | 用在哪 |
| --- | --- | --- |
| `ws-dial` | hub 拨给下游 | 下游开了正向 WS |
| `ws-listen` | 下游拨给 hub | NoneBot 配置反向 WS 最常见 |
| `http-api` | hub 提供 HTTP API | 下游用 HTTP 轮询/调用 |
| `http-post` | hub POST 给下游 | 下游开 HTTP 上报 |

一行还可以带：`selfId`（对方账号，留空同上游）、`probeSelfId`（这条目标自己的探针账号）、`probeOnly`（只收注入、不收真人消息）、`downstreamId`（声明哪几条是同一个下游）。

### 事件怎么投给下游

`preset` 决定"谁管链路、事件怎么投"：

| preset | 行为 |
| --- | --- |
| `relay`（默认） | hub 是管理者，事件原样透传 |
| `solo` | 事件不给下游，hub 自己聊 |
| `shadow` | 只观察：hub 不叫模型、不代答、不发消息 |
| `bridge` | 下游 `send_msg` 真发到 QQ，同时广播给其它下游 |
| `fabric` | 下游 `send_msg` 只广播给其它下游，不惊动 QQ |

`deliveryMode` 管"同一条事件以什么形式交给下游"：`transparent` 原帧重签（默认）/ `replay` 按目标账号重放 / `synthesize` 合成事件。

### 观测：出了事不用猜

| 想看什么 | 用什么 |
| --- | --- |
| 这条消息长什么样 | `onebot_timeline` |
| 谁引发了下游什么反应 | `onebot_turns`（回合配对、响应者、延迟、沉默回合） |
| 原始报文 | `onebot_raw` |
| 下游插件实际发过哪些 action | `onebot_capture` |
| 图片/语音/文件 | `onebot_media`（落地成 blob，用 `hub-media:<id>` 引用） |

原始报文与媒体默认**保留 7 天**（`retention.days`），启动时不在启动路径上做清理，数据再多也不拖慢启动。

### 探针：试探下游，不惊动群

想验证"这句话会不会触发下游插件"，不用在群里真发一条——用探针：

| 工具 | 干什么 |
| --- | --- |
| `onebot_relay_probe` | **只预测不投递**：同一条事件如果现在给下游，会走到哪几个插件、命中什么命令 |
| `onebot_invoke` | **真投递**一次 action 给下游，看它怎么回 |

两种都会在结果里写明"这一次用的是哪一档隔离"，以及**结果可能与你亲自触发时不同**（隔离把真人消息挡在外面了）。

#### 怎么配

四个键都在 `probe.*` 下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `probe.isolation` | `off` | 隔离方式，见下表 |
| `probe.windowMs` | `8000` | `time` 档的独占窗口时长 |
| `probe.maxQueued` | `50` | `time` 档的排队安全阀：排到这个数就立刻按原序补发，绝不吞消息 |
| `probe.capture` | 开 | `link` 档：探针链路的 `send_*` 只记进时间线与捕获账本，**不真发到 QQ** |

三档隔离：

| `probe.isolation` | 探针怎么走 | 适合 |
| --- | --- | --- |
| `off`（默认） | 不隔离：注入和真人消息走**同一条链路** | 先试水、下游插件本来就不敏感 |
| `time` | 注入之后 `windowMs` 内，这个会话的上游消息**暂缓投下游**，窗口一到按原序补发（晚到，不丢） | 不想多开账号，又怕探测期间真人插话 |
| `link` | 上游消息**一条都不投**给探针链路，注入只走那条 | 最干净：真人聊天完全不影响探测结果 |

#### `link` 档要多做一步

`link` 需要"同一个下游的**另一个 bot 账号**"来当探针——地址不用改，只在 `downstreamTargets` 那一行加 `probeSelfId`：

```json
[{
  "url": "ws://127.0.0.1:8080/onebot/v11/ws",
  "selfId": "30001000",
  "probeSelfId": "30001001"
}]
```

配套两个可选项：

- `probeOnly: true`：这条目标**只收注入、不收真人消息**——想专门留一条"实验室链路"时用。
- **一个 `probeSelfId` 都没配时，`link` 档会自动回退到 `off`**（不会静默变成"号称隔离了其实没隔"，回执里会说）。

> 探针最实用的场景是**改完下游插件之后**：先 `onebot_relay_probe` 看一眼这条消息会被谁接走，再决定要不要真发。

### 用法学习

`onebot_capabilities` 是"下游会吃什么命令"的知识库——从真实投递里学，证据够了才升到 `active`。

## 🎭 agent 行为

### 什么时候醒

`agent.mode` 决定"它怎么参与"，三种模式差别很大：

| 模式 | 被叫到时 | 没被叫到时 | 适合 |
| --- | --- | --- | --- |
| `observer` | **也不醒**（消息照常记账、照常转发，但**不叫模型、不发言**） | 不醒 | 只想观测、或者给配额用尽时兜底 |
| `assist`（默认） | 醒 | 不醒，一直等你叫它 | 群里有个正经用途的 bot：问它才答 |
| `active` | 醒 | **每 5 分钟自己看一眼**：这个会话有新消息就醒一次 | 想让它在群里"自然存在"：不 @ 也会偶尔接话 |

`active` 档具体是这么跑起来的（`agent.activeTickMs`，默认 300000 ms = 5 分钟）：

1. 定时器到点，**只看还睡着的会话**——已醒的不走这条路（那是攒批路径）。
2. 看这个会话的窗口里有没有东西（没被处理的新消息）。**没有就什么都不做**，等下一次节拍。
3. 有的话再看一眼下游：**如果下游 bot 这一轮已经答过了**，这批消息只记账、不进模型（防复读），本次节拍作废。
4. 否则**醒一次**，按正常流程攒批、装配、调模型——它可以选择说话，也可以选择不说话。

所以 `active` 不是"每 5 分钟说一句"，而是"每 5 分钟给一次**机会**"：醒了之后仍然要走完"该不该开口"的判断，连续两轮不开口照样睡回去。

其余规则：

- 醒了之后会**参与一段时间**（`agent.awakeMs`，默认 5 分钟）：期间群里继续说话它会接着看。
- **连续 2 轮都不开口**，或者两边都没动静到超时 → 睡回去；`assist` 下之后只在被点名时再叫，`active` 下靠下一次节拍。
- **模式可以按会话覆盖**：`agent.groups` 是 JSON 数组，每一行可以带 `mode`：

  ```json
  [{ "id": "123456789", "mode": "active" }, { "id": "987654321" }]
  ```

  这样第一个群用 `active`（不 @ 也会接话），第二个群仍是全局默认（`assist`：问它才答）——"某个群热闹、其它群安静"不用二选一。
- 节拍只对**白名单里的会话**生效，名单外连窗口都不建。

### 攒批

不是每条消息都调一次模型：**攒够 10 条**（`agent.batchSize`）或**等够 20 秒**（`agent.batchMs`）才交给模型一批。回合没跑完就来的新消息会直接插进这一轮（`agent.steer`），不用等下一批。

### 发言只有一条出口

agent 写在普通回复里的字**不会**发进 QQ——**只有调 `onebot_reply` 才会发**。判断不该说话时它可以不调，**沉默是正常手段**（不是故障）。

一次 `onebot_reply` 可以发多条：文字里空行断条、每张图各成一条、连续的 `@` 与文字合成一条；条与条之间隔 400 ms（像在打字）。超过上限的部分不会静默丢弃，工具回执里会如实告诉它。

### 额度（分群记账）

额度不设全局块，直接写在 `agent.groups` / `agent.privates` 的**每一行**里：写了 `quota` 就按那行算，没写就不限。

- 计算口径：`unit:'token'`（输入+缓存+输出合算）或 `unit:'cost'`（按行内自填的每百万单价折钱）。
- 限额：日/月各一项（`tokensPerDay` / `costPerMonth` …），全是 `0` 或不写 = 不限。
- 用尽之后：**那一批只进记忆、不调模型**（群里照常看得见发生过什么），被 @ 就替模型回一句固定话术；恢复后下一轮会把期间攒下的最近 20 条原话补上。
- 随时可查：`/quota`；解限：`/quota reset` 或 `/quota reset 50000`。

## 🖼️ 看图、生图、表情包、番剧识别

| 能力 | 怎么开 | 说明 |
| --- | --- | --- |
| **看图** | `vision.mode`（默认 `describe`） | 把图交给视觉模型写成一段人话再进上下文；`segment` 直接把图给模型（模型得支持视觉）；`off` 完全不看图。同一张图按 sha256 缓存，不重复问。描述还没回来时上下文里是「[图片（还在看）]」，回合开始前会等它一次（`vision.waitBeforeTurnMs`，默认 4 秒，0＝不等）；等超了模型可以调 `onebot_image_wait` 再等一次 |
| **生图** | `imageGen.enabled` + `model`/`baseUrl`/`apiKey` | 让 agent 自己画图发到群里；`engine: builtin` 用内置 OpenAI 兼容接口，`plugin` 接第三方生图工具；`maxPerTurn` 限每轮几张 |
| **表情包** | `memes.enabled`（默认开） | 群里发表情时自动收集，agent 自己决定发哪张（只能发上下文里列出的 id，编造的会被丢掉并如实告知）；`maxSend` 限一次几张 |
| **番剧识别** | `anime.backend`（默认 `off`） | 认出图片里的二次元角色并写进描述；本地 [anime-recognize](https://github.com/Funny1Potato/aigfm-anime-recognize) 或公共 `animetrace`，`both` 本地优先 |

语音转写也默认开着（`media.transcribe`）：实现端支持就转成文字，转不了会如实说明，不会假装听过。

## 🧰 agent 可用的工具

工具面 = **28 个 `onebot_*`**（本插件提供）+ **agent 预设自带的 DSH 原生工具**。

> 这 28 个工具、以及写给 agent 的指导文字，**只挂在枢纽自己那个会话里**（agent 作用域）——同一 profile 里另外开的普通 DSH 会话、以及 agent 派生的**子代理都看不见**它们。想在普通会话里手动排查是做不到的。
>
> 唯一的例外是 `onebot_session`（会话之间转达）：它是**全局**工具，同一 profile 的任何会话都能看见，见 [会话之间转达](#-会话之间转达)。

### 本插件提供的 28 个

| 用途 | 工具 |
| --- | --- |
| 发言 | `onebot_reply`（发消息，支持多条 / 图片 / 表情 / 引用） |
| 看链路与消息 | `onebot_hub_status` `onebot_timeline` `onebot_turns` `onebot_raw` `onebot_capture` `onebot_context` |
| 人与群 | `onebot_profile` `onebot_group` `onebot_members` `onebot_avatar` `onebot_sessions` `onebot_recall` |
| 记忆 | `onebot_memory` `onebot_person` `onebot_topic` `onebot_memory_audit` |
| 控制下游 | `onebot_invoke` `onebot_relay_probe` `onebot_capabilities` `onebot_code_scopes` |
| 协议与能力 | `onebot_call` `onebot_caps` `onebot_admin` `onebot_media` `onebot_imagegen` `onebot_memes` |
| 其它 | `onebot_tools`（按需取回 DSH 的其它工具） |

### 预设自带的原生工具

默认用精简预设 `onebot-hub-slim`（本插件注册），只给常用的一小撮：读文件、搜代码、跑命令、后台任务、上网、计划。`write` / `edit` / `read_image` 等要时才用 `onebot_tools` 取回——`read_image` 默认不给，是因为 `vision.mode: describe` 时图片只有"描述"这一条路，开了它 agent 会绕过描述自己去翻 blob。

两条容易误解的：

- **`onebot_tools` 的 enable/disable 管不到预设自带的那些**（宿主的工具限制只作用于全局层）。想换整档工具面就换预设：`onebot_tools { preset: 'default' }`。
- **`onebot_tools` 的增删只对本次激活有效**：会话退役后回到预设默认。

## 📡 会话之间转达

一个会话里的 agent，把值得搬的东西递给**另一个会话的 agent**——由那边自己决定发不发——
递完之后两边还能在同一根线上来回说几句。默认**关**。

### 拿来干什么

| 场景 | 怎么走 |
| --- | --- |
| 群 A 有人问"上次那个活动什么时候"，答案在群 B | A 里的 agent `relay` 过去问一句，B 答，A 回群里说 |
| 群里的图、小程序卡、合并聊天记录，想搬给另一个群 | `relay` 带 `refs`（原文），枢纽替你搬 |
| 私聊里聊定的事，要在群里说一声 | 只能 `text` **转述**（原文默认不许搬），转述会过隐私词表 |

### 四个动作

| `op` | 干什么 |
| --- | --- |
| `list` | 有哪些会话可以递、手上还有哪几条活着的线 |
| `relay` | 开一条线并递东西（`refs` 原文 / `text` 话），返回通道号 `ch_xxx` |
| `say` | 在这条线上接着说一句，**两边都能用** |
| `close` | 主动收线 |

### 三条上限，缺一条它就会没完没了

| 上限 | 默认 | 为什么 |
| --- | --- | --- |
| 每方 6 句 | `channelMaxPerSide` | 每句注入都写着"还剩 N 句"，比突然被拒体面 |
| 30 分钟 | `channelTtlMs` | 跨天的"对话"没意义，上下文早丢了 |
| 10 分钟没人说话就冷掉 | `channelSilentMs` | 比过期更早生效——谁都不许用僵尸线反复唤醒对方 |

### 隐私：原文和转述分开算

- **原文**（整段搬运，进了群就撤不回来）：私聊 → 群**默认禁止**。要开得显式打开 `cross.allowPrivateRefs`。
- **转述**（agent 自己写的话）：放行，但代码会过一遍隐私词表（住址、证件、工资、病历……），命中直接拒并让它改写。
- 递过去的字条里会明写"这段话是那边的 agent 用自己的话转述的，不是原文"，让对面知道自己在听二手话。

### 打开

```yaml
cross:
  enabled: true
```

开了之后默认只有枢纽自己拉起的会话能发起（`allowFrom: hub`）；`allowTo` 留空＝枢纽的全部会话都能当目标。
完整 12 个配置项见 [docs/config.md](docs/config.md#会话间转达cross)。

### 版本与已知限制

- 这条能力随 **`0.12.0`** 一起进来，目前只有预发布版有：`dsh plugin --profile <profile> add dsh-onebot-hub@next`。`@latest` 上还没有它。
- **真机只验过一半**：上游是否支持 `get_msg` 回完整消息段、`send_group_forward_msg` 发合并转发、`send_msg` 带 `json` 段，不同实现端差别很大。
- 通道只活在内存里，**重启就断**——这是有意的，跨重启的"对话"没有上下文可依。
- 每递一句话都是把对面**真的叫醒**一次，也就是一次真实的模型调用——随手试着玩也是真的花一次。

## 🗂️ 数据存储

默认 `<storageDir>` = `~/.dsh/onebot-hub`：

```
~/.dsh/onebot-hub/
  startup.log                启动逐阶段标记与失败堆栈（起不来先看它）
  sessions.json              会话与唤醒状态
  self.json                  agent 自己的档案（说过什么、犯过什么错）
  memory/
    store.json               长期记忆与短期残留
    active.json              活跃层（进行中的话题 / 正在做的事）
    reminders.json           提醒冷却账本
  persons/<QQ号>.json         人物档案（含每个群的昵称、名片、最近露面）
  groups/<群号>.json          群档案（名字、人数、群主、公告、culture、成员表）
  topics/<id>.json            话题归档（事件、参与人、结论、起止时间）
  timeline/                  全量消息时间线（按天一个 jsonl）
  media/                     图片/语音/文件 blob（用 hub-media:<id> 引用）
  turns/                     回合账本（谁引发了谁、延迟、沉默回合）
  quota/                     额度账本
  memes/                     表情包库
  cards/  energy/  members/  recall/  vision/  capabilities/
```

**想删干净一切**：停掉 DSH，删掉这个目录即可。想保留记忆只清时间线：只删 `timeline/` 与 `turns/`。

**枢纽的会话在 DSH 里为什么都在「未分类」**：枢纽建的是一条**一次性**会话——每次激活起一个新 id，激活结束就归档。这是刻意的，否则群里每说几轮就会在会话列表里堆一条。它不进任何工作区，所以 DSH Web 把它放在「未分类」。想让它们归位有两个开关：

| 需求 | 怎么配 |
| --- | --- |
| 想在某处能找到活跃中的会话 | `agent.workspace` = 那个工作区的绝对路径（会话 cwd 也用它，建完会挂进该工作区；没有对应工作区就自动建一个） |
| 想留住历史会话、能 pin | `agent.archiveOnRetire: false`（不归档；代价是每次激活多留一条） |

两个都不配就是默认行为：cwd 用宿主进程的目录、会话不进工作区、结束即归档。

**会话名**：每次建会话都会用「群 123456789 · 2026-10-24 15:31」这样的名字（取得到群名/昵称就写成「群 某某群（123456789）」），所以会话列表里一眼能认出来。名字是靠宿主的 `sessionTitle.rename` 写进去的，写成功之后这个标题就被**钉住**了——后面往会话里灌多少条群消息都不会把它改掉。升级前建的老会话不会被追认改名（宿主的改名接口只认活着的会话），它们停在归档里。

## 🔧 排查

| 症状 | 先看哪里 |
| --- | --- |
| 插件起不来 / 设置页一直转圈 | `<storageDir>/startup.log`，逐阶段标记 + 失败堆栈 |
| 上游连不上 | 设置页状态；`upstreamListen` 的路径要和实现端填的**完全一致**（含 `/onebot/v11/ws`） |
| 它在群里不说话 | ① `agent.groups` 里有这个群吗 ② 是不是没被 @ / 没被引用 ③ 下游刚答过（命令静默）④ 额度用完了 ⑤ `agent.speakAssistantText` 没开时它写在正文里的话不算发言 |
| 命令没反应 | `chatCommands.superUsers` 空着 = 整条命令链沉默 |
| 下游收不到事件 | `preset` 是不是 `solo`；`downstreamTargets` 那一行是不是没勾"启用"；`broadcast` 关掉时只投第一条可用链路 |
| 想看它这轮为什么没说话 | `onebot_turns`（沉默回合也记） |

跑起来之后，状态、时间线、下游做了什么，用 `onebot_hub_status` / `onebot_timeline` / `onebot_turns` 查，不靠猜。

## ❓ 常见问题

<details>
<summary>装完之后普通 DSH 会话里怎么调不到 onebot_* 工具？</summary>

这是设计如此：这 28 个工具注册在**枢纽自己的会话作用域**里，不是 profile 全局层。要在枢纽的会话里调，普通会话和子代理都看不见。
</details>

<details>
<summary>能不能不接下游 bot，只让 DSH 在群里聊天？</summary>

能。`downstreamTargets` 留空即可，hub 就变成一个纯粹的"DSH ↔ OneBot"桥。
</details>

<details>
<summary>下游会不会因为我加了 hub 就坏掉？</summary>

默认 `preset: relay` + `deliveryMode: transparent`：事件**原样**转发，不改写、不合成，现有插件不需要任何改动。真正的风险只有两个：两侧账号没对齐（`selfId` 留空时默认跟随上游），以及 `virtualizeMessageId` 打开后 message_id 变了。
</details>

<details>
<summary>它会不会在群里刷屏？</summary>

默认很安静：没人叫它不插话、下游答过不插话、一次回复最多 3 条文字并且条间有间隔、同一个群里报数有冷却。要更安静就把 `agent.mode` 设成 `observer`（只看不说）。
</details>

<details>
<summary>记忆里的东西会不会被别的群看到？</summary>

由 `memory.isolation.level` 与白名单决定（见[记忆系统](#-记忆系统)）。默认 `balanced`：同群可见；私聊内容只在**那个人自己在场**时可见（`privateFacts: sameActor`，敏感内容除外的除外规则见下）；敏感内容任何档位都不外传；群档案不进共享。
</details>

<details>
<summary>数据都存在哪，怎么备份/迁移？</summary>

全部在 `<storageDir>`（默认 `~/.dsh/onebot-hub`）里，纯 JSON + jsonl。整个目录复制过去即可迁移。
</details>

## 🧪 开发

```powershell
cd dsh-onebot-hub
npm test                                    # 全部 20 个套件
node test/smoke-core.mjs                    # 纯逻辑
node test/reply.mjs                         # 出站拆条
node test/m15-e2e.mjs                       # 编排闭环（真 Hub + 假两端）
node --import ./test/register-stubs.mjs test/load-check.mjs   # 装配与工具注册（flag 必须放在脚本前面）
```

设计与验证记录（协议取证、每个测试断言覆盖什么、历次真机事故复盘）见 [docs/design-notes.md](docs/design-notes.md)；全部配置项见 [docs/config.md](docs/config.md)。

## 更新日志

| 版本 | 要点 |
| --- | --- |
| `0.12.0-beta.1` | **会话之间转达**（`0.12.0` 起，当前只有预发布）：一个会话的 agent 能把图片、小程序卡、合并记录递给另一个会话，两边在同一根线上来回说几句（每方 6 句 / 30 分钟 / 10 分钟沉默即冷）；私聊里的话只能转述、原文默认不许搬，转述过隐私词表。工具 `onebot_session` 是全局的，**默认关**。beta.2：说明改成非枢纽会话也读得懂的措辞，字条会先报一句包里有什么 |
| `0.11.0` | **启动提速**：把三处同步 IO 挪出启动路径（大库实测"读回历史"47.7 s → 0.24 s）；**记忆系统改为三层心智**（活跃层 / 长期记忆＝事件索引 / 档案带），删掉群档案里的 highlights，默认隔离档位 `scoped` → `balanced`；记忆每一行带出处、日期与相关群友 |
| `0.10.0` | 版本号规则改为 `x.y.z`；设置页布局自适应（窄容器自动堆叠）；记忆按人隔离 |
| 更早 | 见 [Releases](https://github.com/Funny1Potato/dsh-onebot-hub/releases) |

## English

A DeepSeek Harness plugin that puts DSH on an OneBot v11 bus: LLOneBot / NapCat / go-cqhttp on top, any number of NoneBot or other OneBot implementations below.

> **Already running a NoneBot bot and have no use for DSH?**
> Then this plugin won't solve your problem — it isn't a chatbot itself, it's the socket that puts a
> **DSH agent** and a visible OneBot bus together. If you just want a bot that chats, install
> [nonebot-plugin-aigf-master](https://github.com/Funny1Potato/nonebot-plugin-aigf-master):
> memory, persona, memes and when-to-speak are all built in.
> Read on only if you want **DSH in the group**, or want to **see what actually happens on the bus**.

- **Upstream** — dial or listen for the real implementation, so the agent sees every event and has every action available.
- **Downstream** — serve or dial downstream links and **relay events verbatim**, so existing bot plugins keep working unchanged.
- **Observer** — a full timeline of every message plus a ledger of what each downstream bot did, exposed to the agent as 28 `onebot_*` tools.
- **Agent** — wake logic, layered memory (active / long-term index / person / group / topic), persona presets, per-group quotas.
- **Cross-session relay** (off by default, from `0.12.0`; prerelease only for now) — one session's agent hands a picture, a mini-program card or a merged forward to *another* session, then both sides keep talking on the same short-lived channel; private-chat originals are never moved verbatim into a group, only paraphrased and filtered.

Install: `dsh plugin --profile <profile> add dsh-onebot-hub`. Configuration, commands and behavior notes are in Chinese above, and every config key is documented in [docs/config.md](docs/config.md).

## License

[MIT](LICENSE)
