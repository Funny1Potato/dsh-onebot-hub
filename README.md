# dsh-onebot-hub

**[English](#english) | 中文**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接到 **OneBot v11**（QQ）上：DSH 既是下游 bot 的协议上游，也是群里的一个 bot。

## English

A DeepSeek Harness plugin that puts DSH on an OneBot v11 bus (QQ: NapCat / LLOneBot / Lagrange up top, any number of NoneBot or other OneBot implementations below).

- **Upstream** — dials or listens for the real implementation, so the agent sees every event and has every action available.
- **Downstream** — serves or dials downstream links and **relays events verbatim**, so existing bot plugins keep working unchanged.
- **Observer** — a full timeline of every message plus a ledger of what each downstream bot did, exposed to the agent as 28 `onebot_*` tools.

Install, configure and behavior notes are in Chinese below.

## 它做什么

- **当上游**：用 OneBot v11 连上真正的 QQ 实现端（NapCat / LLOneBot / go-cqhttp…），事件**原样**收发，不合成、不改写。
- **当下游**：用同一套协议服务下游 bot（也可以主动拨号下游），把用户消息原样交给它们，同时看清它们调用了哪些 action、回了什么。
- **当群友**：agent 有自己的唤醒逻辑，知道所有会话和历史，会记人、认人、会翻旧账。
- **留证据**：全量消息时间线、下游 action 台账、原始报文与媒体都有保留（默认 7 天），排查问题用工具查，不靠猜。

## 安装

插件已发布到 npm：[`dsh-onebot-hub`](https://www.npmjs.com/package/dsh-onebot-hub)。包是纯 ESM、运行时只依赖 `ws`，并且**自带编译好的 `lib/`**——从 npm 装完即用，不需要构建。

用 DSH 的插件管理器装进某个 profile（`<你的 profile>` 换成 profile 名，如 `desktop`）：

```sh
dsh plugin --profile <你的 profile> add dsh-onebot-hub
```

这条命令把参数转给该 profile 目录下的 pnpm，所以等价的写法是：

```sh
cd ~/.dsh/profiles/<你的 profile>
pnpm add dsh-onebot-hub
```

包内声明了 `dsh.bundle`，装好后会被并入 profile 的插件层，**默认不需要手改 `cordis.patch.yml`**。然后**重启 DSH**（或直接在设置页 →「OneBot 枢纽」里配置并保存，效果与手改配置后重挂一致）。

> 万一个别版本的 DSH 没有自动并入插件层，就在该 profile 的 `cordis.patch.yml` 追加下面三行（不要动已有条目）再重启：
>
> ```yaml
> - insert:
>   - id: onebot-hub
>     name: 'dsh-onebot-hub'
> ```
>
> 想用仓库里的开发版，把上面 `add` 的包名换成 Git 源或本地路径即可：`pnpm add github:Funny1Potato/dsh-onebot-hub` / `pnpm add file:D:/path/to/dsh-onebot-hub`（Git 源是拉源码，需要 prepare 脚本并放行构建）。

## 最少要配的两项

| 键 | 说明 |
| --- | --- |
| `upstreamListen` | **推荐**。让实现端反连 hub（例 `127.0.0.1:8765/onebot/v11/ws`），不用在 hub 上填上游地址。与 `upstreamUrl` 二选一 |
| `downstreamTargets` | 下游列表，JSON 数组。支持四种连接方式（`ws-dial` / `ws-listen` / `http-api` / `http-post`），可多条，设置页有行编辑器 |

只想自己用、不接下游 bot：`downstreamTargets` 留空即可。

## 常用配置

**完整配置项（137 项，每一项的作用与默认值）见 [docs/config.md](docs/config.md)**——设置页里每个字段的中文名与说明也在那里，二者由测试对账、不会各说各话。下面是真正需要你手动改的那些：

| 键 | 什么时候改 |
| --- | --- |
| `agent.groups` / `agent.privates` | **白名单**。写了的群/QQ 才调模型，没写的连 `@` 都不理；两张都不写 = 不过滤。条目可带 `mode`（`observer` 只看不答） |
| `agent.mode` | 平时是 `assist`（被叫到才醒、参与完自己睡回去），`active` 更活跃。名单里的某一类会话可在条目上单独覆盖 |
| `chatCommands.superUsers` | 谁能用那 13 条管理命令（`help` `status` `memes` `perm`…，前缀见 `chatCommands.prefix`）。**留空 = 整条命令链沉默**（不猜谁是管理员） |
| `probe.isolation` | 测试用命令时注入给下游的账号：`link`（默认，另开一个探针账号，真人消息进不去）或 `time` |
| `vision.mode` | 看图方式：`describe`（把图交给视觉模型写成人话，默认）/ `segment`（把图本身给模型）/ `off` |
| `persona.presets` | 群里的角色设定（名字、性格、说话风格），可按群名套用 |
| `memes.enabled` | 表情包库；收哪张由 agent 自己决定，`memes.maxSend` 限一次最多发几张 |
| `imageGen.enabled` | 让 agent 自己生图（默认关，填 `model`/`baseUrl`/`apiKey` 才开） |
| `code.scopes` | 下游 bot 的源码目录。**地址不写进 prompt**，agent 需要时调 `onebot_code_scopes` 取位置，读文件用它自带的 `read`/`grep` |
| `memory.isolation.level` | 记忆隔离：`strict`（跨会话一律不可见）/ `scoped` / `balanced`（默认） |
| `memory.peopleRoster` | 上下文里【本群认识的人】最多列几个（默认 20，按最近露面排序；`0`＝整段不注入，细节仍可用 `onebot_person` 现查） |
| `agent.speakAssistantText` | 默认 `false`：**普通回复文本只是内部草稿，只有 `onebot_reply` 会真的发进聊天** |
| `retention.days` | 原始报文与媒体保留天数（默认 7） |
| `agent.replyGapMs` / `agent.replyMaxText` / `agent.replyMaxImages` | 一次回复发多条时的间隔（默认 400ms）、文字条数上限（默认 3，图另算）、图片上限（默认 9） |
| `agent.groups` / `agent.privates` 里的 `quota` | **分群额度，逐行配**（m14190：额度不再有全局块，这一行不写 `quota` 就是不限）。设置页每行一张「额度」折叠面板：计算方法 `unit:'token'`（输入+缓存+输出合算）或 `unit:'cost'`（按本行自填的每百万单价折钱，默认 CNY）、日/月上限、报数口径 `notice`、用尽回话等。用尽后那一批**只进记忆不调模型**（被 @ 兜一句固定话术，可关），恢复后下一轮补注入期间攒的最近 20 条原话；`/quota` 查、`/quota reset` 解限 |

## 聊天里的命令（13 条）

只有 `chatCommands.superUsers` 里的账号能用（**留空 = 整条命令链沉默**）。别人敲同样的字，枢纽一声不吭——回一句"你没权限"等于告诉全群这里有个能管事的 bot。

**下表省略前缀**：前缀由 `chatCommands.prefix` 定（默认 `/`）。配成 `!` 就敲 `!help`，配成 `。` 就敲 `。help`——命令名本身不变，前缀换成什么都能用。

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
| `quota [reset [额度]]` | `额度` | 查本群/私聊今天与本月的额度用量；`reset` 把今天已用抹掉（解限到当期结束，带数字＝追加额度） |

三条要知道的语义：

1. **命令不吞消息**。命中之后消息照常转发给下游、照常给模型看，只跳过"喂模型"这一步——枢纽已经用同一个账号答过这句话了。
2. **前缀撞车 = 两个都触发**，不是谁先谁赢。下游也有同名命令就各回各的；想让枢纽别管某一条，加绕开前缀 `chatCommands.bypassPrefix`（默认 `!!`），比如默认配置下敲 `!!/help`。
3. **只在开头认前缀**：`你好 /status` 是聊天，不是命令（默认前缀下）。回话超 `chatCommands.maxReplyChars`（默认 800 字）会截断。

`perm` 改的是**本次唤醒**那个 agent 会话的权限，下一次唤醒自动回部署默认——一次授权一次用。

## 使用前要知道的行为

1. **默认很安静**：群里没人叫它，它不会插话。被 `@`、被引用、或者私聊发消息时才会醒；激活一会儿没人理就自己睡回去。
2. **发言只有一条出口**：agent 写在普通回复里的字**不会**发进 QQ，只有调 `onebot_reply` 才会发。判断不该说话时它可以不调（沉默是正常手段）。
3. **下游应答过就不插话**：下游 bot 刚回过，agent 不会再凑一句（防复读）。
4. **一次调用可以发多条**：`onebot_reply` 的文字里空行断条、每张图各成一条、连续的 `@` 与文字合成一条；超过上限的部分会被如实告知。
5. **记东西是有边界的**：它会记住人、群、承诺与话题，但隔离等级决定跨会话能不能看见（默认 `balanced`：同群可见，私聊内容不进群上下文）。
6. **测试下游用探针**：排查/试探下游插件时注入的消息走**另一个账号**，真人在群里说的话不会串进去。
7. **超管给的权限只管这一次**：管理命令里的 `perm`（前缀见上面那节）改的是**本次激活**那个 agent 会话的权限；下一次唤醒是全新会话、自动回到部署默认——一次授权一次用。权限不够时它会在群里说清缺什么、要它干什么，请超管敲一条命令授权，而不是绕路或假装能做。

## agent 可用的工具

工具面 = **28 个 `onebot_*`**（本插件提供）+ **agent 预设自带的 DSH 原生工具**（不由本插件提供，由预设决定给多少）。

这 28 个工具、以及枢纽写给 agent 的那段指导文字，**只挂在枢纽自己那个会话的会话装配（agent 作用域）里**，profile 全局层一个都不留——所以同一 profile 里另外开的普通 DSH 会话、以及 agent 派生的**子代理都看不见它们**（子代理的作用域没有父链，即便 join 了同一个预设也拿不到）。代价：想手动调这些工具排查，得在枢纽自己的会话里调，普通会话里没有。

### 本插件提供的（28 个）

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

精简预设 `onebot-hub-slim`（本插件注册，默认用）补齐了这 11 个常用原生工具——照抄官方 standard 预设里对应的 6 行插件注册，注册后体检，坏了就退回 profile 默认预设：

| 用途 | 工具 | 备注 |
| --- | --- | --- |
| 读文件 | `read` | 另有 `write` / `edit`，要才用 `onebot_tools` 取回 |
| 搜代码 | `grep` `glob` | |
| 跑命令 | `pwsh` | 非 Windows 上自动停用（同官方预设） |
| 后台任务 | `job_list` `job_output` `job_kill` | 长命令放后台跑，别把回合卡住 |
| 上网 | `web_search` `web_fetch` | |
| 计划 | `todo_write` | 多步任务把计划显式列出来 |

`read_image`（自己打开图片看）**默认不给**：`vision.mode` 是 `describe` 时图片只有描述这一条路，开了它 agent 会绕过描述自己去翻 blob。要用就 `onebot_tools` 显式取回。

两条容易误解的：

- **工具面是"预设作用域"，`onebot_tools` 的 enable/disable 管不到预设自带的那些**——宿主的工具限制只作用于全局层，预设挂进来的一律豁免。想换整档工具面就换预设（`onebot_tools { preset: 'default' }` 换回 DSH 默认预设，会带全 `subagent` / `workflow` / `goal` / `task_board_*` / `plugin_manager` 等大件；换档在本次激活结束时生效）。
- **`onebot_tools` 的增删只对本次激活有效**：会话一退役，限制跟着没，下次唤醒回到预设默认。

## 排查

插件起不来（设置页一直转圈、链路不连）先看 `<storageDir>/startup.log`，里面有逐阶段标记与失败堆栈；默认 `<storageDir>` 是 `~/.dsh/onebot-hub`。

跑起来之后，状态、时间线、下游做了什么，用 `onebot_hub_status` / `onebot_timeline` / `onebot_turns` 查；原始报文与图片用 `onebot_raw` 取。

## 开发

```powershell
cd dsh-onebot-hub
npm test                                    # 全部 20 个套件
node test/smoke-core.mjs                    # 纯逻辑
node test/reply.mjs                         # 出站拆条
node test/m15-e2e.mjs                       # 编排闭环（真 Hub + 假两端）
node --import ./test/register-stubs.mjs test/load-check.mjs   # 装配与工具注册（flag 必须放在脚本前面）
```

设计与验证记录（协议取证、每个测试断言覆盖什么、历次真机事故复盘）见 [docs/design-notes.md](docs/design-notes.md)；全部配置项见 [docs/config.md](docs/config.md)；CI 与发布流程、示例值约定记在 design-notes 里。

## License

[MIT](LICENSE)