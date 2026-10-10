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

插件是纯 ESM、无构建步骤，运行时只依赖 `ws`。DSH 用 `pnpm add` 把它装进 profile，**Git 源直接可用**：

```sh
cd ~/.dsh/profiles/<你的 profile>
pnpm add github:Funny1Potato/dsh-onebot-hub
```

再往该 profile 的 `cordis.patch.yml` 追加（不要动已有条目）：

```yaml
- insert:
  - id: onebot-hub
    name: 'dsh-onebot-hub'
```

然后**重启 DSH**（或直接在设置页 →「OneBot 枢纽」里配置并保存，效果与手改配置后重挂一致）。

## 最少要配的两项

| 键 | 说明 |
| --- | --- |
| `upstreamListen` | **推荐**。让实现端反连 hub（例 `127.0.0.1:8765/onebot/v11/ws`），不用在 hub 上填上游地址。与 `upstreamUrl` 二选一 |
| `downstreamTargets` | 下游列表，JSON 数组。支持四种连接方式（`ws-dial` / `ws-listen` / `http-api` / `http-post`），可多条，设置页有行编辑器 |

只想自己用、不接下游 bot：`downstreamTargets` 留空即可。

## 常用配置

设置页里每一项都有中文名与说明，下面是真正需要你手动改的那些：

| 键 | 什么时候改 |
| --- | --- |
| `agent.groups` / `agent.privates` | **白名单**。写了的群/QQ 才调模型，没写的连 `@` 都不理；两张都不写 = 不过滤。条目可带 `mode`（`observer` 只看不答） |
| `agent.mode` | 平时是 `assist`（被叫到才醒、参与完自己睡回去），`active` 更活跃。名单里的某一类会话可在条目上单独覆盖 |
| `chatCommands.superUsers` | 谁能用 `/help` `/status` `/memes` `/perm` 等命令。**留空 = 整条命令链沉默**（不猜谁是管理员） |
| `probe.isolation` | 测试用命令时注入给下游的账号：`link`（默认，另开一个探针账号，真人消息进不去）或 `time` |
| `vision.mode` | 看图方式：`describe`（把图交给视觉模型写成人话，默认）/ `segment`（把图本身给模型）/ `off` |
| `persona.presets` | 群里的角色设定（名字、性格、说话风格），可按群名套用 |
| `memes.enabled` | 表情包库；收哪张由 agent 自己决定，`memes.maxSend` 限一次最多发几张 |
| `imageGen.enabled` | 让 agent 自己生图（默认关，填 `model`/`baseUrl`/`apiKey` 才开） |
| `code.scopes` | 下游 bot 的源码目录。**地址不写进 prompt**，agent 需要时调 `onebot_code_scopes` 取位置，读文件用它自带的 `read`/`grep` |
| `memory.isolation.level` | 记忆隔离：`strict`（跨会话一律不可见）/ `scoped` / `balanced`（默认） |
| `agent.speakAssistantText` | 默认 `false`：**普通回复文本只是内部草稿，只有 `onebot_reply` 会真的发进聊天** |
| `retention.days` | 原始报文与媒体保留天数（默认 7） |
| `agent.replyGapMs` / `agent.replyMaxText` / `agent.replyMaxImages` | 一次回复发多条时的间隔（默认 400ms）、文字条数上限（默认 3，图另算）、图片上限（默认 9） |

## 使用前要知道的行为

1. **默认很安静**：群里没人叫它，它不会插话。被 `@`、被引用、或者私聊发消息时才会醒；激活一会儿没人理就自己睡回去。
2. **发言只有一条出口**：agent 写在普通回复里的字**不会**发进 QQ，只有调 `onebot_reply` 才会发。判断不该说话时它可以不调（沉默是正常手段）。
3. **下游应答过就不插话**：下游 bot 刚回过，agent 不会再凑一句（防复读）。
4. **一次调用可以发多条**：`onebot_reply` 的文字里空行断条、每张图各成一条、连续的 `@` 与文字合成一条；超过上限的部分会被如实告知。
5. **记东西是有边界的**：它会记住人、群、承诺与话题，但隔离等级决定跨会话能不能看见（默认 `balanced`：同群可见，私聊内容不进群上下文）。
6. **测试下游用探针**：排查/试探下游插件时注入的消息走**另一个账号**，真人在群里说的话不会串进去。
7. **超管给的权限只管这一次**：`.perm <预设>`（见 `chatCommands.superUsers`）改的是**本次激活**那个 agent 会话的权限；下一次唤醒是全新会话、自动回到部署默认——一次授权一次用。权限不够时它会在群里说清缺什么、要它干什么，请超管敲一条命令授权，而不是绕路或假装能做。

## agent 可用的工具（28 个）

| 用途 | 工具 |
| --- | --- |
| 发言 | `onebot_reply`（发消息，支持多条 / 图片 / 表情 / 引用） |
| 看链路与消息 | `onebot_hub_status` `onebot_timeline` `onebot_turns` `onebot_raw` `onebot_capture` `onebot_context` |
| 人与群 | `onebot_profile` `onebot_group` `onebot_members` `onebot_avatar` `onebot_sessions` `onebot_recall` |
| 记忆 | `onebot_memory` `onebot_person` `onebot_topic` `onebot_memory_audit` |
| 控制下游 | `onebot_invoke` `onebot_relay_probe` `onebot_capabilities` `onebot_code_scopes` |
| 协议与能力 | `onebot_call` `onebot_caps` `onebot_admin` `onebot_media` `onebot_imagegen` `onebot_memes` |
| 其它 | `onebot_tools`（按需取回 DSH 的其它工具） |

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

设计与验证记录（协议取证、每个测试断言覆盖什么、历次真机事故复盘）见 [docs/design-notes.md](docs/design-notes.md)。

### CI 与发布

- **CI**：`.github/workflows/ci.yml`。push 到 `main`、提 PR 或手动触发时跑 `npm test`，矩阵是 Node 22/24 × Ubuntu/Windows。装依赖用 `npm install --omit=peer --legacy-peer-deps`：宿主那几个 `@deepseek-ai/dsh-*` 是 peer 依赖（测试用 `test/register-stubs.mjs` 打桩），而 registry 上它们自己的 peer 区间互相冲突，不加 `--legacy-peer-deps` 会直接 ERESOLVE。`devDependencies` 里的 `@deepseek-ai/schemastery` 才是 `test/load-check.mjs` 用的**真** Config schema 校验器，不能省。
- **发到 npm**：`.github/workflows/publish.yml`，走 **npm Trusted Publishing**（OIDC 免 token，provenance 自动附带，仓库里不需要任何 npm secret）。`git push origin vX.Y.Z` 触发——先校验 tag 与 `package.json` 版本一致，再跑一遍测试，然后 `npm publish`；发布成功后自动建同名 GitHub Release（自动生成 notes，附上与 npm 同一内容的 tarball）。前置条件：包已在 npmjs.com 上存在，并且在 npmjs.com → 包 → Settings → Trusted publishing 里登记本仓库为 trusted publisher（repository `Funny1Potato/dsh-onebot-hub`，workflow 文件名填 `publish.yml`；2026-09 之后新建的配置默认只允许 `npm stage publish`，要手动勾上直接 `npm publish` 的许可）。**首发例外**：包还不存在时 OIDC 无处落地，先用本地登录的 npm 把 0.1.0 发出去（或 `npm stage publish`），登记好配置后，之后的版本才由 CI 发。手动触发默认只 dry-run，只跑测试和 `npm pack --dry-run`。
- 本机 `npm publish` 如果报 `DEPTH_ZERO_SELF_SIGNED_CERT`（公司/杀软 TLS 拦截），加 `NODE_OPTIONS=--use-system-ca`；CI 上不受影响。

### 示例值约定

文档、注释、设置页提示和工具描述里的示例值**一律用编造的占位**：群号 `123456789`、QQ 号 `10001`、下游账号 `30001000`、上游反连端口 `8765`、下游地址 `127.0.0.1:8080`。真机上用的群号、QQ 号、端口、密钥不要写进来（`docs/design-notes.md` 里的真机复盘记录除外——那是事故日志，改动前先问）。

## License

[MIT](LICENSE)