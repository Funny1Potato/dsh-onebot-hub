/**
 * 给宿主 agent 的指导段与「探针链路」判定。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），内容逐字未改：这个文件是一段很长的
 * 文案拼装，改一个字就会改变模型的行为，所以单独放一处、也方便对照快照测试。
 */

import { COMMAND_SPECS } from './chat-commands.js';

/**
 * 有没有**配好的探针链路**：目标里写了 `probeSelfId`（normalize 阶段展开出一条 `probeOnly` 的），
 * 或者有人显式标了 `probeOnly`。链路隔离（`probe.isolation: 'link'`）靠它才成立——一条都没有时
 * Hub 会把档位回退成 `off`，给 agent 的指导段也就不该再提"链路隔离"。
 */
/** 表情包来源的合法取值（`m73315`）：schema、resolveConfig、设置页下拉共用这一份。 */
export const MEME_ENGINES = ['builtin', 'plugin', 'both'];

export function hasProbeLink(config = {}) {
  const targets = Array.isArray(config?.downstreamTargets) ? config.downstreamTargets : [];
  return targets.some((entry) => entry?.probeOnly === true);
}

/** 插件给宿主 agent 的指导段。 */
/**
 * 表情包那一段的指导语（`m73315`）：自带库与外部插件是两种完全不同的说法。
 * builtin 讲收藏判断；plugin 只列外部工具名，绝不替别人的工具承诺能力；both 两句都给。
 */
function memeGuidanceLines(config = {}) {
  const raw = config?.memes?.engine;
  const engine = raw === 'plugin' || raw === 'both' ? raw : 'builtin';
  if (engine === 'builtin') {
    return [
      '表情包收藏判断（值得才收）：如果是表情包（能表达一定的情感，适合在群聊中反复使用），且表情包库里没有类似的图片，且你觉得值得保存的，才 `onebot_memes{action:"add", messageId, brief, description?, keywords}` 收录——brief 和描述由你写（description 没写就用已生成的图片描述）；随手截图、风景照、bot 自己生的图（生图/截图）不收，收藏群友发的梗图；正文里绝不出现表情包 id。',
    ];
  }
  const tools = Array.isArray(config?.memes?.pluginTool) ? config.memes.pluginTool.filter(Boolean) : [];
  if (!tools.length) {
    return [
      engine === 'both'
        ? '表情包：枢纽自带的库仍可用（清单见【表情包】段，onebot_memes 与 reply 的 memes 参数照旧）。外部插件这边暂时没有探测到可用工具——别自己编表情包 id，也别用占位符假装发过表情。'
        : '这个模式下的表情包由外部插件负责，但现在没有可用的表情工具。不要自己编表情包 id，也不要用占位符假装发过表情；要发图就直接给图片地址或本地文件。',
    ];
  }
  const listed = `\n${tools.map((n) => `- ${n}`).join('\n')}`;
  const out = [];
  out.push(
    engine === 'both'
      ? `表情包有两个来源：枢纽自带的库（清单见【表情包】段）与外部插件。外部插件可用的工具：${listed}`
      : `表情包交给外部插件，可用的工具：${listed}`,
  );
  out.push(
    '要用表情时就用上面这些工具找，每个工具能做什么看它自己的说明；找到图之后按 onebot_reply 的 {"type":"image","file":"…"} 发出去（本地路径、URL、base64:// 都行）。',
  );
  if (engine === 'both') {
    out.push('自带库仍然能用（onebot_memes、reply 的 memes 参数），收藏判断（值得才收）同以前，两套库各数各的，别混。');
  }
  out.push('闲聊聊到兴头上该用就用，不必每句都贴；也可以直接使用合适的表情包替代你的发言；正文里绝不出现表情包 id。');
  return out;
}

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
    'onebot_invoke 向下游链路投递任意 OneBot action（含触发下游插件的命令消息），可用 user_id 以**指定的账号**说话——换账号常常换结果（权限/冷却/用户级状态）；**走哪条链路由枢纽决定**（`downstream` 只说"问哪个下游"，探针还是真实按 `probe.isolation` 选，真要点真实链路得显式 `allow_real_link`）；发言**只有一条出口**：onebot_reply 工具——任何需要发出的内容都必须走它（列清单、汇报、回答都一样）；你写在普通回复文本里的话只是内部草稿，宿主**不会**替你发进聊天，不调它就是沉默；它用 hub 自己的身份发言（可带 memes：只能用上下文里列出的表情包 id，编造的 id 会被丢掉并如实告诉你）。',
    '人设/表情包/看图/识番/生图：persona.* 给每个会话一套人设（/set_role 只改本群，不泄漏给共用同一预设的别的群）；memes.* 表情包库由你自己管理（收录/改简介/删除，清单里只有一行简介，想看某个的完整描述用 action:"get"）；vision.anime 给图片补一行角色名（认不出就说认不出，全挂时不编造）；imageGen.* 让模型能自己生图（默认关，必须配 model/baseUrl/apiKey；engine 选 builtin 自带生图或 plugin 委托第三方插件；delivery 默认 agent＝生成后由 agent 决定发不发群，生成的图都会落地并补上描述）。',
    ...memeGuidanceLines(config),
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
    // `m72467`：一次 invoke 里有**两个不相干的身份**，混在一起讲最容易出事，所以分开说。
    // 链路不点名（探针链路用哪个号是内部信息），只说“和真实链路不是同一条”。
    lines.push(
      '`onebot_invoke` 里有两个不相干的身份，别混：**说话人**是你用 `user_id` 指定的，'
        + '下游拿它判权限、冷却、进度，这部分你完全控制。'
        + '**链路**决定这句话从哪条路进去：默认是探针链路，**和真实链路不是同一条**——'
        + '它收不到群里的真人消息，回复也不进群，这正是"借用下游功能、又不打扰群"的路径；'
        + '要真的让群里看到就填 `link:"real"`。',
      '探针链路的状态可能与真实链路不同（在线情况、插件里按会话存的进度、权限），'
        + '所以它的结果不代表群里真实发生过什么；事后在 onebot_capture / onebot_turns 里看到的 `self_id` '
        + '属于那条链路，不是你指定的说话人。',
    );
  } else {
    // 不在链路隔离档：只有真实链路，于是要做的事就是“讲清楚这次一定会进群”。
    lines.push(
      '`onebot_invoke` 里有两个身份：**说话人**由 `user_id` 决定（下游按它判权限与用户级状态）；'
        + '**链路**这次是真实链路——注入会触发下游，**它的回复会进群**。'
        + '想让下游干活又不希望群里看到，现在做不到（要先把探针隔离配成 link）。',
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
