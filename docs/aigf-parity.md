# 与 nonebot-plugin-aigf-master 的能力对照（记忆 / 消息处理）

对照对象：`D:\DSH-workspace\DSH-QQ\nonebot-plugin-aigf-master` = **nonebot-plugin-aigf-master v2.0.0b3**（git `c5933e2`，Python / NoneBot2，52 个源文件）。

- aigf 侧路径前缀 **P** = `D:\DSH-workspace\DSH-QQ\nonebot-plugin-aigf-master\nonebot_plugin_aigf_master\`
- hub 侧路径相对本仓根（`D:\DSH-workspace\DSH-QQ\dsh-onebot-hub\`）

> 本文只做**事实对照**，不含改动方案。两侧结论都带 `文件:行号`。

---

## 0. 一句话结论

两者是**相反的设计取向**：

- **aigf-master 把判断权交给模型**。没有唤醒规则、没有回复概率、没有隔离等级、没有检索——攒一批消息，把**四层记忆全量 JSON** 与最近 20 条历史塞进**一条 user message**（无 system role），让模型一次输出「回什么 + 记忆怎么改 + 命令学什么」。结构简单，上限取决于模型自觉。
- **dsh-onebot-hub 把判断权留在代码**。显式白名单闸、睡/醒状态机、逐条记忆的 `scope`/`visibility` + 四级隔离 + 审计账本、FTS5 检索、衰减、主动回忆、会话卡落盘，并**严格照顾 prompt cache**（段序按变化频率排、不许相对时间）。记忆写入由模型走工具，但**能不能被看见由代码判**。

**结论：记忆这块 aigf 明显更弱，hub 已经在它前面**（aigf 没有任何检索 / 衰减 / 隔离 / 上限 / 审批，条目连 id 和时间都没有）。
**值得学的集中在「消息处理」与「一次调用多产」** —— 见 §3。

---

## 1. 记忆系统对照

### 1.1 数据模型

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 形态 | **四层纯字符串列表**：短期 `{"items":[...]}`（`P/memory_store.py:34,42`）、长期 `{"facts":[...]}`（`:52,60`）、`culture.json`、滚动 `recent.json` | 统一记忆条目 **`{id,ts,kind,scope,worldKey,actor,text,refs,strength,source,term,sensitive,visibility,modifiedAt,corrected,promotedAt}`**（`lib/memory/store.js:98-115,140-159`）；`kind` 默认 `'fact'`，`term` ∈ `'short'\|'long'`（`:154`）；`id = m<base36序号><时间戳>`（`:15`）。**外加五档档案**：人物 / 群 / 话题 / self / 会话（`lib/profile.js`） |
| 条目字段 | **无 id、无时间、无来源、无重要度** | 上列全字段，落盘后 id/时间/来源/可见性都读得回（能 `modify` 昨天那条） |
| 群友档案 | `memory/friends/{user_id}.json`：`id`/`nickname`/`aliases`/`past_nicknames`/`info`/`groups`/`cards`（`:150-154,176,311-312`）；`card` **不入库**、加载时按群派生（`:138`） | `person`（`lib/profile.js:36-51`）：`names[]`（`{name,scope,at}`，上限 **20**，取最后一条为当前名，`:23,101-106`）、`profile{sex,age,level,avatar,profileAt}`、`groups{}`、`relationship{closeness:-5..5,tone,lastInteractAt}`、`interests[]`、`facts[]`（上限 **60**，键 `text`）、`commitments[]`（上限 **40**，`{what,due,refs,scope,status:'open',mentions,lastMentionedAt,strength:0.6}`）、`impression`（单句）、`corrections[]`（上限 **20**，`{wrong,right,refs,scope,at}`）（`:24-27,381-384`；`lib/memory/writer.js:185-208`） |
| 文化 | 独立一层：`term`/`meaning`/`context`/`usage_examples`/`first_seen`(`%Y-%m-%d`)/`usage_count=1`/`source`(默认 `"learned"`)（`:377-385`） | 无「文化词」专门层；等价物是群档案 `group.culture` + 记忆条目 |
| 落盘布局 | `memory/{disk_key}/short_term.json\|long_term.json\|culture.json\|recent.json` + `memory/friends/*.json`；`disk_key` 把 `onebot11:617770183`→`onebot11_617770183`（`P/session.py:47-49`） | `store.json`（`lib/memory/store.js:49`，上限 `memory.limit` 默认 **5000**，`lib/index.js:381`）、`persons/<userId>.json`、`groups/<worldKey>.json`、`topics/<id>.json`、`self.json`、`sessions.json`（`lib/profile.js:178-182,281,289`）、`recall/<linkId>/<yyyymmdd>.jsonl` + `recall/index.sqlite`（FTS5，`lib/memory/recall.js:106,146,386`）、`timeline/<linkId>/…`（`lib/hub.js:188`）、会话卡 |
| 持久化范围 | 四层 + 群友 | **七样**：档案、L1 聊天记录、能力结论与缓存、用法表、提醒账本、记忆条目、L2 会话卡 |

### 1.2 作用域与隔离

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 分层作用域 | 短期/长期/文化/recent **按会话键**各一份（私聊键 `onebot11_<user_id>`）；**群友是全局单目录** | 每条记忆自己带 `scope` / `worldKey` = `group:<群号>` 或 `private:<QQ号>`（`lib/memory/isolation.js:79-84`；`lib/hub.js:1450,1466`） |
| 可见性怎么定 | 只靠 `groups` 白名单：`P/memory_store.py:136` `if data.get("id") and self.group_id in data.get("groups", [])`；注释 `:137`「card 只带当前群的群名片（cards 按群保存，避免跨群串名片）」→ **只有群名片按群隔离，`info`/`aliases`/`nickname` 跨群共享** | 条目 `visibility` 只有 `'private'\|'shareable'`，**由写入侧按会话推断、模型自报值一律忽略**（`lib/memory/writer.js:97-103`：`private:` 前缀或敏感→`private`；`long_term`→`shareable`；`lib/index.js:3980`）。判定再叠四级 `level` |
| 隔离等级 | **没有** | `['strict','scoped','balanced','open']`，默认 `'scoped'`（`lib/memory/isolation.js:11`；`lib/index.js:394`） |
| 默认策略 | — | `{level:'scoped', crossGroupIdentity:true, crossGroupFacts:'shareable', privateFacts:'never', sensitivityAlwaysLocal:true, recallEscape:false, recallEscapeNeedsApproval:true, audit:true, auditRetain:200}`（`lib/memory/isolation.js:15-27`；`lib/index.js:394-405`）→ **跨群共用档案、shareable 可跨群、私聊不出私聊、敏感永在本会话** |
| 判定顺序 | — | `isVisible`/`filterForScope`（`lib/memory/isolation.js:142-197`）：同 scope → 同 world → 敏感 always-local → `strict` → `kind==='identity'` → private(never/sameActor/all) → shareable(crossGroupFacts/level) → 群内事实；跨 scope 且 `audit` 才记审计（`:203-221`）；覆盖顺序 `overrides` → `trustedGroups` → `level`（`:102-135`） |
| 敏感信息 | **完全没有**过滤/脱敏/授权，全靠 prompt 引导（`P/prompt_builder.py:330`「职业、生日、居住地…」） | `sensitivityAlwaysLocal` + 5 组正则兜底（住址/身份证/银行卡/工资/病历/离婚 等，`lib/memory/isolation.js:30-36`），命中即**一律不出本会话** |
| 越界检索 | 无检索 | `scope:'all'` 且 `recallEscape=false`（默认）→ 降级为当前可见，并带回 note `memory.isolation.recallEscape=false，已降级为当前可见范围`（`lib/memory/isolation.js:224-233`；`lib/memory/recall.js:13`） |
| 会话闸 | `aigfm_enabled_groups` / `aigfm_enabled_private`（`P/config.py:47-54`） | `agent.groups` / `agent.privates` 严格白名单，**默认 deny-all**，未列入的群/私聊在 `observe()` 就返回 `reason:'unlisted'`（`lib/agent/policy.js:99-124`） |

### 1.3 写入

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 触发 | 唯一：`P/processor.py:487-492` `extract_memory_ops(result)` → `await self.memory.apply_ops(memory_ops)`；**模型提议，代码只归一化 + 落盘** | 四个写入方：① 代码观测 `noteName`/`noteGroupCard`/`touchSession`（`lib/hub.js:1444-1471`）；② 每轮 flush 前 `store.addMany(buildObservedEntries(...))`（`lib/mind.js:1361`，额度用尽亦然 `:1335-1341`）；③ 时间线 `onRecord`→`recall.append`/`turns.record`/`cards.note`（`lib/hub.js:208-214`）；④ 模型 `onebot_memory`→`applyMemoryOps`（`lib/index.js:4000`） |
| 上限 | **代码里没有任何条数/字数上限**，唯一约束是 prompt 一句「建议不超过 8 条」（`P/prompt_builder.py:305`） | 逐字段上限（names 20 / facts 60 / commitments 40 / corrections 20）+ writer 超长 **拒绝不截断**（`lib/memory/writer.js:55-60`） |
| 审批 | 无 | 有（走工具 + 策略约束） |
| 去重 | `item not in items`（`:281,332,338`）；文化按 `term` 命中则 `usage_count += 1`（`:373-375`） | 去重键 `kind+scope+worldKey+actor.user_id+归一化text`（`lib/memory/store.js:28-36`） |
| 淘汰 | 无 | 超 `memory.limit` 从最旧 `splice` ＝ **纯 FIFO**（`lib/memory/store.js:185-197`） |
| 冲突 | 无消解，`modify` 依赖 LLM 给对 index（index 删除逆序执行 `:267-270`） | `corrections[]` 记录"纠正过我"（`lib/profile.js:369`；`lib/memory/writer.js:185-208`） |
| 容错 | `apply_ops` 四字段各自 try/except（`:216-239`）；`_ops_entry_list` 归一畸形输出（`:241-256,261-266`） | 超限 rejected、坏文件跳过 |

### 1.4 检索 / 召回 / 衰减

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 检索 | **没有**。全仓 grep `decay\|forget\|衰减\|过期\|embedding\|向量\|重要度\|importance\|summar` 只命中无关的 `P/animetrace_client.py:132` | `onebot_recall` 一个工具多种问法（关键词/按人/时间窗/段类型/按人分组/没结的话题）；**中文滑动 bigram**（`lib/memory/recall.js:26-54`）；`index.sqlite`（FTS5），`node:sqlite` 不可用则降级内存倒排索引；检索**逐条过 `isVisible`**，默认跳过已淡忘（`:510,598-599`） |
| 召回方式 | 四层**全量注入**；唯一"匹配"是文化子串 `if term_str and term_str in text_lower`（`P/memory_store.py:390-397`，输入为本批新消息 `P/processor.py:383-384`），且**匹配不自增 `usage_count`** | 主动回忆 `cues`：只把**还没兑现的承诺**连时间线索当事实交出去（`lib/mind.js:791-807` + `renderCues`），24h 防重复 |
| 衰减 | 无 TTL / 无遗忘 | `lib/memory/decay.js:8` 强度公式**只降默认可见性、不删数据**（`includeWeak: true` 仍翻得到） |
| 摘要压缩 | 无。只有 `recent` 滚动窗口（内存/落盘上限 `_RECENT_KEEP = 50`，`P/processor.py:150`） | `digest` **机械统计**（`maxMessages 40`/`maxLines 12`，`lib/mind.js:772`）+ `cards.js` 增量落盘 + 重启恢复卡。**注意：hub 也没有 LLM 自动总结压缩** |

### 1.5 注入形式（差异最大的一处）

**aigf** —— `P/prompt_builder.py:293-294` 标题逐字：

```
## 你的记忆
这是你的记忆库。每次回复前都必须主动检查并维护：群友是否透露了新信息（职业/生日/爱好/偏好/约定）？已有信息是否过时或错误？是否学到新梗或网络用语？
```

子段逐字：`### 短期记忆`（`:296`）、`### 长期记忆`（`:308`）、`### 相关群友信息`（`:319`）、`### 文化记忆`（`:339`）。
每段用三引号包 `json.dumps(..., ensure_ascii=False, indent=2)`，空值回落 `"[]"`／`"{}"`（`:77-79,98`）。
另有独立段（`:267-269`）：`## 相关文化知识` + `以下是当前聊天中涉及的文化词汇：` + `- {term}: {meaning} ({context})`。
**无条数/字数预算**。**无 prompt cache 处理**——记忆 JSON 在 prompt 前部、聊天记录在其后，记忆一变整段前缀失效。

**hub** —— `assembleContext`（`lib/memory/assembler.js:365-392`），段序 = 变化频率升序，**逐字标题**：

```
【来源】/【身份】（来源头 assembler.js:76-93）
→ 人设 → guidance → 表情包清单
→ 【会话卡（重启前那份…）】（仅重启时）
→ 【下游会吃的命令（观测 N 条，置信度＝真被触发过的次数）】
→ 【还没兑现的事】
→ 【人物卡】
→ 【本群认识的人】
→ 【群档案】
→ 【短期记忆（本会话；序号可用于 modify/delete）】/【长期记忆（跨会话；序号可用于 modify/delete）】
→ 【最近窗口】
```

- `DEFAULT_BUDGET = {maxLines:80, maxChars:6000, perSection:{memory/window/person/people: Infinity}, peopleLimit:20}`（`lib/memory/assembler.js:35-54`）——**默认路径不再因为字数砍尾巴**（`m24155`），只有显式传预算才截；长度在写入侧管。
- 记忆先过 `filterForScope`，**进 prompt 的只有已过滤结果**。
- 【人物卡】`renderPerson`（`:166-203`）：facts 逐条构造成带 `scope`/`visibility`/`sensitive` 的对象再过滤（`:188-192`），通过才渲染「我知道的：」。
- 【本群认识的人】`renderPeopleRoster`（`:224-275`）：`:236-237` `const g = p.groups?.[scope]; if (!g) continue;`——**只列本群有记录的**；而且**只给条数、不展开 facts 正文**（`:246-250`），正文留给 `onebot_person` 现查。标题逐字（`:270`）：
  `【本群认识的人】下面是我在这个群有记录的人（按最近露面的先后排，同一天内按 QQ 排）：想了解某个人，调 onebot_person 查他的档案。`
- prompt cache 纪律（`:18-22,259-263` 与 `:415-421`）：易变内容（时间/计数）不进 system prompt，时间改放每批新消息；段内排序键取**天粒度**、不取时间戳（否则每条群消息刷新 `lastSentAt` → 每回合重排 → 宿主整份快照重注）。
- 进 runtime-context 快照的是 `liveContext()` → `snapshot().text`（`lib/mind.js:862-889`）：上面全部**除**会话卡与【最近窗口】；每轮现算、一轮内冻结（`#liveCache`）。

### 1.6 配置项

- **aigf：`P/config.py` 里没有任何 memory/记忆 键**（grep 0 命中）。间接相关：`aigfm_recent_messages=20`（`:62`）、`aigfm_enabled_groups/private`（`:47`/`:51`）、`aigfm_default_preset`（`:55`）、`aigfm_energy_baseline`（`:66`）、`aigfm_meme_max_count`（`:70`）；硬编码 `_RECENT_KEEP = 50`。
- **hub**：`memory.limit=5000`、`memory.peopleRoster=20`、`memory.reminders{enabled:true, windowHours:24, limit:5, max:200}`（`lib/index.js:379-408`）；另有 `memory.isolation.*`。

### 1.7 aigf 记忆侧的已知缺陷（对照时别抄）

- `P/prompt_builder.py:268` 在 `if matched_culture:` 内**重新赋值 `culture_str`**，覆盖了 `:79` 生成的完整 JSON；于是 `:341` 的「### 文化记忆」代码块注进去的是**命中子集的 `- term: meaning (context)` 文本**（非法 JSON，且与「相关文化知识」段重复）。
- 群友 `info` 跨群共享（只有名片按群隔离）。
- `/reset` 明确**不删**记忆（只清 recent 与缓冲）——这是行为约定，不是缺陷（README.md:204，`P/__init__.py:509-517`）。

### 1.8 aigf 记忆侧的亮点（可以借）

1. **四层结构直觉清晰**：短期（还在聊的）/ 长期（沉淀的）/ 群友 / 文化——模型一眼知道"该往哪写"。
2. **文化词条带 `first_seen`/`usage_count`/`source`**，命中后**单独成段**注入——比塞在记忆里更容易被用上。
3. **群名片按群隔离**（`cards` 按群保存），`past_nicknames` 由事件自动维护。
4. **畸形输出归一化**：字符串当单元素、裸数组当 `add`、index 删除逆序执行。
5. **单字段失败隔离**：`apply_ops` 四个字段各自 try/except，一个字段格式错不废掉整批记忆。
6. **`recent.json` 滚动窗口重启续读**（`P/processor.py:334-343`）。
7. **一次调用同时产出 reply + 记忆增删改**（§2.7 第 3 条）——记忆写入不额外花一轮。

### 1.9 hub 记忆侧已知的自相矛盾

- `memory.limit` 在设置页写着"按重要度与新旧淘汰"（`lib/client.js:293`），实现却是**纯 FIFO**（`lib/memory/store.js:185-197`）——**文案与代码不符**。

---

## 2. 消息处理对照

### 2.1 入站与「要不要回」

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 入口 | `P/__init__.py:470` `on_message(rule=_is_message, priority=1, block=False)` + `:473` `on_notice(...)`；**无 request/meta** | `humanText`→`observeProfiles`→`attachTopic`→`#resolveMedia`→成员名→命令回话（不 await）→`hooks.onUpstreamEvent`→`mind.observe`（`lib/hub.js:1625-1679`）；**转发不等模型**（`lib/mind.js:678-682`） |
| 忽略链 | `_maybe_enabled`(`:120-128`) → `resolve_session`(`P/session.py:152-186`) → `is_enabled`(`:189-192`) → 自己发的(`:560`) → 合成命令事件(`:563`) → 空 content(`:605-611`)。**无黑名单、无机器人消息过滤** | `readonly` → `silent` → 白名单 `unlisted`（默认 deny-all）→ `detectMention` → 前置 `shouldWake`（self/observer/kind 不入窗）→ `batch.push`（`lib/mind.js:558-637`；`lib/agent/policy.js:99-124`） |
| 唤醒判定 | **没有**。无概率、无关键词、无状态机——完全交给 LLM 的 `## 回复决策`（`P/prompt_builder.py:438-450`）+ 社交能量（`:429-436`）；`reply` 为空即不回（`P/processor.py:517-528`） | **显式决策**（`lib/agent/policy.js:249-282` 顺序）：`observer` → `self` → `meta_event` → 非消息无文本 → `wakeOnNotice` → **被叫到**（@我／引用我的话／私聊每条，`:51-56,164-178`）→ `silent:downstream-responded` → 激活态批量窗口 → 休眠态 `dormant`。**无概率唤醒、不认昵称关键词**（`:149-163`；`m02678` 定案，防 `npm test` 误唤醒） |
| @ 自己的作用 | 只**提升能量** `+0.1`：`P/processor.py:373` `if f"@{self.bot_name}" in msg.content or msg.is_at_only: at_boost = 0.1` | 直接**当被叫到**，连"下游已应答"的静默闸都不挡 |
| 睡/醒 | 无 | `AWAKE_SILENT_TURNS=2`、`awakeMs=300000`、`activeTickMs=300000`（`lib/agent/policy.js:22-29`）；连续 2 轮没开口或 `awakeMs` 内两边都没动静 → 回休眠 |
| 档位 | 无 | `observer` / `assist` / `active` 三档（默认 `assist`），可逐群覆盖（`sessionOverrideOf`） |
| 并发 | 同会话**可并发两批**（`asyncio.Lock` 只包 chunk 读写，LLM 调用在锁外，`P/__init__.py:331-382`） | 同一 `agentKey` **串行**（`lib/agent/pool.js`），LRU 回收、空闲 dispose |

### 2.2 攒批与节流

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 触发 | `P/__init__.py:357-368`：`len(chunk) >= aigfm_batch_count`(10) 或 `(now-last_time) >= effective_timeout` | `BatchWindow`：`size=6` / `ms=8000` / `sizeLimit=200`，reason `batch:full\|batch:timeout\|batch:pending`（`lib/agent/policy.js:181-218`） |
| 「不完整消息」判定 | 末条 `is_at_only` → 窗口从 30s **延到 40s**；末两条同 `user_id` 且间隔 < `aigfm_merge_window`(5s) → 同样 40s | **无** |
| 图片等待 | `_pending_images > 0` 时**整批推迟**，超 `batch_timeout + incomplete_timeout`（70s）硬放行（`P/__init__.py:349-354`）；VLM 一开始就重置计时（`:229-233`） | 看图描述**异步回填**：先发裸占位，晚到的描述用 `【图片补描 N 条】` 单独补（`lib/mind.js:1088-1117`） |
| 同人连发合并 | `P/prompt_builder.py:10-25` `_merge_consecutive` 用 `" "` 拼成一条（历史与新消息都做） | 不合并，逐条成行 |
| 冷却/限额 | **无冷却、无每分钟限额、无主动沉默** | 无速率限制；靠睡/醒 + `observer` 档 + 分群额度记账控成本 |
| 节流手段 | **社交能量**（连续值）：每批向 `aigfm_energy_baseline`(0.7) 回归 15%、加 `random.uniform(-0.08,0.08)`、@ +0.1（`P/processor.py:377-380`）；回复扣 `energy_cost = 0.03 + min(0.12, text_length * 0.002)`（`:536`） | 睡/醒状态机 + 额度记账（用尽退 `observer`） |

### 2.3 送给模型的文本

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 发送者名 | `P/__init__.py:617` `msg.user_name = f"{nickname}({user_id})" if user_id else nickname` → **昵称紧贴半角圆括号 QQ 号、无空格** | `who = actor.nickname \|\| actor.card \|\| actor.user_id \|\| '下游'\|'某人'`（`lib/mind.js:1053`）——**群名片优先、且不带 QQ 号** ← 用户问题 ① 的病灶 |
| 批次头 | — | `【新消息 N 条】会话 <sessionKey>｜现在 <stampNow>`（`lib/mind.js:911-925`） |
| 批次行 | `P/prompt_builder.py:111` `f"[{m.user_name}]: '{m.content}'"`（外部来源）／`f"{m.user_name}: '{m.content}'"` | `` `- MM-DD HH:MM <via><who>(<role>)：<text>` ``，`via`＝`下游→`／`我→`／空（`lib/mind.js:1064`） |
| 历史行 | `P/prompt_builder.py:496` `f"{msg.user_name}: {msg.content}"` | 开局快照/窗口 `renderWindow`；【最近窗口】只在开局快照里给一次 |
| 时间戳 | **可选**开关 `aigfm_show_message_time`（默认 False），格式 `[MM-DD HH:MM]`（`P/prompt_builder.py:41-43`） | **恒定**行内 `MM-DD HH:MM` + 批头 `full` 绝对锚点（`m34049` 用户要求"所有消息都加上日期和时间"）；换行留 ` ⏎ ` |
| @ 自己 | `P/unimsg.py:350-351` `content += f" @{deps.bot_name} "`——**用的是 agent 自己的名字** | `lib/segments.js:133-137,146-148` `callName(qq)` → 查不到回落 **`用户{qq}`** ← 用户问题 ③ 的病灶 |
| @ 别人 | `P/unimsg.py:353` `f" @{await display_user(bot, session, target)}({target}) "` | `@名字 `（`lib/segments.js:142-252`） |
| 回复引用 | `P/unimsg.py:323` `f"[回复 {label} 的消息: \"{text}\"] "`，label = `f"{nick}({uid})"`（`:286`）；取不到则 `:312` `…（无法获取被回复消息）` | `↩回复「…」`（`lib/segments.js:142-252`）；`quoteOf` 取 `nameOf(...) ?? sender.card ?? sender.nickname`（`lib/hub.js:389`） |
| 图片 | `P/__init__.py:185/190/194-196`：`"\n[发送了一张图片, id: {cache_id}]\n"`、`"\n[发送了一张图片]（识图失败）\n"`、`"\n[发送了一张可能是表情包的图片, id: {cache_id}] [情感:{emotion}] [内容:{description}]{anime_text}\n"`、`f"\n[发送了一张图片, id: {cache_id}] [内容:{desc.description}]{anime_text}\n"`；`cache_id` = md5 前 12 位（`P/meme_store.py:99`） | `[图片：描述]`／`[动图]`／`[…｜可能是表情包｜情感：…]`（`lib/segments.js:142-252`）；媒体落地成 durable ref + 描述写回文本 + 识番；GIF 自己解析取关键帧拼长图（`lib/media/gif.js`） |
| 其它段 | `P/unimsg.py`：`:357` `f"[QQ表情 {name}] "`、`:377` `"[收到一条语音消息] "`、`:380` 视频、`:368` `"[收到一条合并聊天记录] "`、`:165` `f"[小程序/卡片: {', '.join(...)}] "`、`:166` `"[收到一条JSON消息] "`、`:371` XML、`:192` 分享、`:202` 位置、`:205` 音乐、`:208` 骰子、`:215` `f"[群文件: {name}{size}] "`、`:217` 其他 | `[表情：微笑]`、`[语音 12s]“…”` 或 `（我听不了语音，别猜内容）`、`[合并转发 N 条：内容未展开]`、`[卡片：…]`、`@全体成员`、`用户<qq>` 兜底（`lib/segments.js:134-137,142-252`） |
| 多模态 | 默认 `vlm`：先描述成文本；`=llm` 时 base64 随请求（`P/processor.py:356-368` → `P/llm_client.py:40-44` `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}`） | 视觉模型描述写回（`lib/vision.js`）+ 识番（`lib/vision/anime.js`）+ 生图（`lib/vision/imagegen.js`） |
| 语音 | 只出占位，**无 ASR** | 同：无 ASR |
| 合并转发 | `[收到一条合并聊天记录]` 占位 | `[合并转发 N 条：内容未展开]`（`lib/segments.js:184-189`） |

### 2.4 Prompt 结构

**aigf** —— 单条 `{"role":"user"}`（`P/llm_client.py:44/68`），**没有 system role**。段序逐字（`P/prompt_builder.py:272-460`）：

```
你是 {bot_name}，{bot_role}
## 回复风格
## 当前状态
## 你的知识
## 相关文化知识
## 你的记忆
## 理解群聊对话
## 图片消息说明
## 最近的聊天记录
## 新消息
## 可用的表情包（用于发送）
## 表情包收藏判断
## 已知群友昵称
## 可用的群功能
## 其它 bot 的命令
## 你最近代为执行过的命令
## 调用身份 / ## 插件响应 / ## 重要：已知命令的处理 / ## 命令学习与管理 / ## 功能调用的边界
---
（JSON 输出模板，:380-417）
## 社交能量与回复
## 回复决策
## 其他规则
```

**每轮全量重建**：历史取 `history[-aigfm_recent_messages:]`（默认 20），内存/落盘上限 `_RECENT_KEEP = 50`；记忆/群友/文化全量 JSON。**无增量、无 messages 复用、无 prompt cache 设计**。台账固定展示 10 条（`P/processor.py:147` `_LEDGER_DISPLAY = 10`）。JSON 解析失败时把 `prompt + "\n## 注意\n..."` 重发一次（`:471-475`）。

**hub** —— system prompt（人设 + `plugin:dsh-onebot-hub` 指导，order 160）+ runtime-context 快照 + 批次 user message：

- 宿主对 runtime-context 快照是**整份文本变了就追加一份**（append、不替换），所以 v4（`m24409` 用户定案）把**会话卡与【最近窗口】移出快照**——它们改随**每段会话第一批**的【开局快照】注入一次（见 §2.5），之后一切消息都走批次 user message。
- 唯一例外是重启恢复卡（`digest.resumed`），窗口空着期间文本恒定，不会反复触发重注。
- 段序按变化频率升序（§1.5），**前缀越长越利于 cache**。

### 2.5 开局快照与插话

- **开局快照 `#openingText`**（`lib/mind.js:1142-1216`）：**每段会话第一批只给一次**（`#openingPresented` 按 sessionKey）。头逐字 `【开局快照】本段开始之前的事` ＋ 可选 `（含重启前的旧事，不是刚刚）`；内含 `参与者：` 与 `renderWindow`。生成时机在 `snapshot()` 之后、`pool.wake` 之前，拼在 `#batchText` 最前（`:1396,1401`）；换装/裸激活 `force:true`（`:1155`）。
- **插话 steer**：`agent.steer` 默认 true（`lib/index.js:185`）；`pool.steer` 走宿主 next-step 原语（`lib/agent/pool.js:80-119`）；回合在飞时 `#trySteer`，**成功才** `batch.flush()`（`lib/mind.js:1253-1292,1303`）；`#steerMessage` 头 `【插话 N 条】`、不带快照（`:1130-1140`）。

### 2.6 出站

| | aigf-master | dsh-onebot-hub |
|---|---|---|
| 解析 | `P/response_parser.py:126-148`：`reply` 数组，字符串 = text；dict `type` ∈ text/meme/at（meme 用 `id`，at 用 `name`）。顶层键 `_RESPONSE_KEYS = ("reply","memory","command_learning","command_edit","command_delete")`（`:9`） | agent 调 `onebot_reply` 工具（**候选**）→ 出站 `send_msg` |
| 组装 | `P/__init__.py:394-409` → `compose_unimsg_list`（`P/unimsg.py:398-449`）：条目间**固定插一个空格**、文本首尾 strip、**图片各自独立成条**，随后逐条 send | 投递模式 / 动作模式（design-notes §5） |
| @ 目标解析 | `P/session.py:217-249`：纯数字直用 → uninfo 成员昵称/群名片精确匹配 → `get_group_member_list` 回落；失败跳过并回执 `（没能识别 @ 目标：… 本次已跳过该 @）`（`P/processor.py:319-324`） | `onebot_reply` 的 at 候选 |
| 协议细节 | 走 alconna `UniMessage`，**无 CQ 码拼接** | 上游真发（`base64://` 等） |
| 打字/延迟/撤回 | **都没有**（无打字模拟、无分段延迟、无撤回补发、不引用回复） | 无 |
| 错误兜底 | JSON 解析失败重试一次（`P/processor.py:469-484`）；无 reply 只告警（`:518-528`） | 额度用尽兜底告知、发送失败记账 |

### 2.7 跨插件上下文

- **aigf 有、hub 没有等价物**：`P/api_hooks.py:44-102` 用 `Bot.on_calling_api` 钩子捕获**同实例其它插件**的输出，`ContextBus` 每会话 `deque(50)` 缓存，注入历史段时格式为 `[插件名] bot名: 内容`，并与消息缓冲去重（`aigfm_context_max_messages=50`、`aigfm_context_in_prompt=10`）。
- hub 侧对应的是 `onebot_invoke`（往下游注入事件驱动其它插件）+ `lib/learn.js`（只从观测里学"下游吃什么"），**但不监听同实例其它插件的输出**。

### 2.8 aigf 消息处理的亮点（值得学）

1. **攒批 +「不完整消息」判定**：末条是纯 `@`、或同一个人 5 秒内连发 → 把 30s 窗口延到 40s，等他把话说完。
2. **图片解析期间整批推迟**：`_pending_images` 计数，VLM 没出结果就不发批，70s 硬上限兜底——**绝不把占位文喂给模型**。
3. **一次调用多产**：同一个 JSON 同时给出 `reply` + 四层记忆增删改 + 命令学习；解析容错（修未转义内层引号 `_escape_inner_quotes`、花括号平衡、按顶层键优先选对象）。hub 现在记忆是独立工具调用，多花一轮。
4. **连续「社交能量」取代生硬的开关**：能量同时驱动"回不回 / 回多长 / 愿不愿意代执行命令"，形成"话多 → 累 → 安静"的周期。hub 是睡/醒 + 档位，边界是硬的。
5. **function calling 闭环**：命令清单 + 「你最近代为执行过的命令」台账（带相对时间）+ 极详尽的调用边界规则；服务端再做自身管理命令拒绝、插件白名单核对、命令 + 参数 + 身份三键去重、能量门槛（`P/processor.py:273-281, 605-649`）。
6. **`prompt_builder` / `response_parser` 纯函数化**、渲染与解析零副作用、易测。

### 2.9 aigf 消息侧不该抄的

- **每轮全量重建 prompt、无 cache 设计**（hub 花了大力气做的事，别退回去）。
- **同会话可并发两批**（LLM 在锁外）——两个回复可能交叉。
- **`aigfm_llm_temperature` 配置未生效**：`P/llm_client.py:48/71/98` 硬编码 `0.5`。
- **`## 回复决策` 全靠模型自觉**，没有任何代码侧兜底（hub 的显式唤醒 + 白名单闸更适合"额度要花钱"的场景）。

---

## 3. 建议对齐的项（按"该抄"的优先级）

| 优先级 | 项 | 对应 | 为什么 |
|---|---|---|---|
| P0 | **发送者名统一成「昵称(QQ)」** | 用户问题 ① | 正对用户诉求；hub 现在 `actor.nickname \|\| actor.card \|\| actor.user_id` 既优先群名片又没有 QQ 号 |
| P0 | **@ 自己渲染成 agent 自己的名字** | 用户问题 ③ | aigf 一行就做到了（`@{deps.bot_name}`）；hub 现在会掉到 `用户{selfId}` |
| P0 | **群友 facts 的跨群可见性收紧** | 用户问题 ② | hub 的 `renderPeopleRoster` **已按群过滤**；真正会漏的是 person `facts` 的 `visibility` 被写入侧判成 `shareable`（`long_term`→shareable，`lib/memory/writer.js:97-103`）后跨群可见 |
| P1 | **「不完整消息」延长窗口** | — | 纯 `@` / 同人连发时别急着 flush |
| P1 | **图片解析期间整批推迟 + 硬上限** | — | hub 现在是"先发裸占位再补描"，模型第一眼看不到内容 |
| P1 | **社交能量式的连续节流** | — | 让"回不回/回多长"平滑，而不是靠睡/醒硬切 |
| P2 | **一次调用同时产出回复与记忆变更** | — | 省一轮工具调用（但会牺牲 hub 现在的"写入可审计/可拒绝"） |
| P2 | **文化词条层**（`first_seen`/`usage_count`/`source` + 命中后单独成段） | — | hub 的群档案 `culture` 没有命中机制 |
| P2 | **跨插件输出捕获**（`ContextBus`） | — | hub 有 `onebot_invoke`，但没有"看见"其它插件说了什么 |
| P3 | **畸形输出归一化**（字符串当单元素、裸数组当 `add`、index 逆序删） | — | 低成本容错 |

---

## 4. hub 已经更强、**不要倒退**的部分

1. **隔离体系**：四级 + 敏感词兜底 + 逐条 `scope`/`visibility` + 审计账本。aigf 完全没有。
2. **检索**：FTS5 + 中文 bigram + 按人/时间窗/段类型/话题多种问法。aigf 是"全量注入"。
3. **衰减与主动回忆**：`decay.js` 降权不删；`cues.js` 只报事实不催促（写"你答应过…"，提不提由模型判断，避免变成催债机器人）。
4. **会话卡机制**：`digest.js` 机械压缩 + `cards.js` 落盘 + 恢复卡标注"从磁盘读回来的"。aigf 只有一个 50 条滚动窗口。
5. **prompt cache 纪律**：段序按变化频率升序、时间写绝对日期、排序取天粒度。aigf 一点没考虑。
6. **唤醒与成本控制**：显式唤醒决策、白名单闸（默认 deny-all）、observer/assist/active 档、睡/醒状态机、分群额度记账。aigf 全交给 LLM。
7. **L1 只追加、启动不回放**（刻意）：回放会把整条历史重新变成"现在"。

---

## 5. 与用户三个问题的对应

| 用户问题（`m15264`） | aigf 的做法 | hub 现状 | 落差 |
|---|---|---|---|
| ① 名字按**实际 QQ 昵称 + QQ 号**渲染，不用群名片 | `f"{nickname}({user_id})"`（`P/__init__.py:617`） | `lib/mind.js:1053`、`lib/hub.js:373`（`hit.actor?.card \|\| hit.actor?.nickname`）、`lib/members.js:58`（`data.card \|\| data.nickname`）、`lib/profile.js:319-331`（`noteGroupCard` 把名片并进 `names[]`，scope=该群）——**四处口径都优先群名片，且都不带 QQ 号** | 不是单点问题，是四条渲染链都要改口径 |
| ② 群友记忆按群隔离，各群只注入本群成员 | 群友**全局单目录**，只 `groups` 白名单 + 名片按群（`P/memory_store.py:136-137`） | `renderPeopleRoster` **已按群过滤**（`lib/memory/assembler.js:236-237`）；但 person `facts` 的 `visibility` 由 `long_term`→`shareable`（`lib/memory/writer.js:97-103`），默认 `crossGroupFacts:'shareable'`（`lib/memory/isolation.js:15-27`）⇒ **跨群可见** | 根因在 facts 的可见性推断，而不是名单过滤 |
| ③ @ 自己渲染成 agent 自己的名字 | `@{deps.bot_name}`（`P/unimsg.py:350-351`） | `callName(qq)` → 查不到回落 `用户{qq}`（`lib/segments.js:133-137`） | hub 缺"selfId → agent 名字"的映射（`lib/mind.js:105,199-204,418-432,451-452` 已有 `#nicknames`/`nickname`/`setIdentity` 可复用） |

---

## 6. 取材

- **aigf 侧**（v2.0.0b3，`c5933e2`）：`memory_store.py`、`prompt_builder.py`、`processor.py`、`unimsg.py`、`session.py`、`response_parser.py`、`models.py`、`config.py`、`api_hooks.py`、`meme_store.py`、`image_handler.py`、`llm_client.py`、`README.md`。路径前缀 `P` 见文首。
- **hub 侧**：`lib/memory/store.js`、`lib/memory/writer.js`、`lib/memory/recall.js`、`lib/memory/cards.js`、`lib/memory/cues.js`、`lib/memory/decay.js`、`lib/memory/isolation.js`、`lib/memory/assembler.js`、`lib/profile.js`、`lib/mind.js`、`lib/hub.js`、`lib/segments.js`、`lib/members.js`、`lib/agent/policy.js`、`lib/agent/pool.js`、`lib/index.js`、`lib/client.js`，以及 `docs/design-notes.md` §6.1 / §9。
