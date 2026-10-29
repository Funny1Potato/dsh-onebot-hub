/**
 * 编排层（§21 全局）：把"时间线 → 会话卡 → 上下文装配 → 唤醒 agent → 回复出站"串成一条线。
 *
 * 这一层刻意**不碰协议**（那是 hub.js）也**不碰宿主 API**（那是 lib/index.js 注入的 pool/setup），
 * 所以 `test/m15-e2e.mjs` 能用假 hub + 假 host 把整条链路跑通。
 */

import {
  AWAKE_SILENT_TURNS,
  BatchWindow,
  atTargetsOf,
  detectMention,
  initialWakeState,
  mergePolicyMode,
  resolveAgentPolicy,
  resolveCalled,
  sessionOverrideOf,
  shouldWake,
} from './agent/policy.js';
import { buildDigest } from './memory/digest.js';
import { assembleContext, buildSourceHeader, describeSections, renderWindow } from './memory/assembler.js';
import { memoryBlocks } from './memory/writer.js';
import { collectCues } from './memory/cues.js';
import { activeWhitelist, buildShareContext, filterActive } from './memory/active.js';
import { ReplyBuffer, buildSendParams, describeReply } from './reply.js';
import { isSuperUser } from './chat-commands.js';
import { QUOTA_CATCHUP, QUOTA_HOLD_MAX, quotaKey } from './quota.js';
import { full as fullStamp, mdhm } from './stamp.js';
import { flatBreaks } from './text.js';
import { messageToText } from './protocol.js';
import { TASK_SESSION_KEY } from './tasks.js';
import { displayActor } from './names.js';

export const SESSION_ID_PREFIX = 'onebot-hub:';

const truncate = (v, n = 160) => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** 多条消息之间的打字间隔（`agent.replyGapMs`）。0 = 连发。 */
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * 一条消息"没有字"时，它在快照里该被写成什么（`m26901` 用户要求）。
 *
 * 图片 / 语音 / 表情包 / 打包转达都是**各自单独成条**的，`text` 是空字符串；而会话卡
 * （`cards.js`）与最近窗口（`assembler.js`）都按"没有文本就不渲染"过滤，于是模型
 * 下一轮完全不知道自己发过这张图——真机上它会再发一遍，或者接不上"这张好看"。
 * 这里给一个占位符，并把时间线 id 一起写进去，下一轮想回看时用 `onebot_raw` 就能取。
 */
function carrierLabel(msg = {}) {
  const memes = (Array.isArray(msg.memeIds) ? msg.memeIds : []).filter(Boolean);
  if (memes.length) return `[表情包 ${memes.join('、')}]`;
  const segs = (Array.isArray(msg.segments) ? msg.segments : []).filter((s) => s?.type !== 'reply');
  const label = messageToText(segs).trim();
  return label.length > 80 ? `${label.slice(0, 80)}…` : label;
}

/** 从一条消息的**内容段数组**里取纯文本（宿主消息是 `[{type:'text',text}]`，不是裸字符串）。 */
export function textOfContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('');
}

/**
 * 整条文本只是括号旁白（`（不回复）` / `（沉默）` / `(no reply)`）时，视为"它不想说话"。
 *
 * 这是"文本兜底=发言"（`agent.speakAssistantText=true` 逃生门）里唯一的抑制方式：
 * 兜底默认已关（m30383：发言只走 onebot_reply 工具，回复文本只是内部草稿），
 * 打开逃生门后"这一轮我判断不该开口"仍靠整句括号旁白表达。刻意限制在短且整句被括号包住，
 * 免得把正常内容也吞掉。
 */
export function isSilentMarker(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  /**
   * 「（已回：…）」这类**旁白自述**不是发言。
   *
   * 真机上出现过：模型调完 `onebot_reply` 之后，把"我已经回了什么"写成收尾文本，
   * 而那段文本被当发言发进了群里。它通常整句在括号里、以"已回/已发送"开头，
   * 所以只在这个形状上收紧——正常括号内容（`（笑）`）与长正文都不受影响。
   */
  if (/^[（(]\s*已(回|回复|发|发送|告知|交代|处理|看过|查过)/.test(t) && /[)）]$/.test(t)) return true;
  if (t.length > 24) return false;
  return /^[（(][^（()）]{0,20}[)）]$/.test(t);
}

/**
 * 时间戳（`m02432`：时钟只写在 user message 里——每批都是新增内容，写多少次都只算一次；
 * live 上下文不带时钟，快照因此不会每分钟被整份重注）。
 *
 * 这里给的是**绝对锚点**（`YYYY-MM-DD HH:MM`）：一批消息的头把日期定死，行内再用
 * `MM-DD HH:MM`（`#batchLines`），跨天就不会把昨天的消息当成刚发生的（`m34049`）。
 */
function stampNow() {
  return fullStamp(Date.now());
}

/**
 * 带图消息的短标识（`m24656` 事故）：图消息渲染出来就四个字 `[图片]`，同一分钟的**两张不同图**
 * 在批里长得逐字一样，模型分不清"这条我回过了没有"——真机 16:06 它把一张新图判成"上一条的补描
 * 重复送达"，于是那张图一个字都没回。
 *
 * 只给媒体消息挂：文字消息靠内容本身就能区分，每行都挂 id 只是噪声。取 `message_id` 末六位——
 * 够区分同一分钟里的两条，又不至于把一行撑长。
 */
export const mediaTag = (entry) => {
  const live = entry?.live ?? entry;
  const media = live?.refs?.media;
  if (!Array.isArray(media) || !media.length) return '';
  const mid = String(live?.refs?.message_id ?? entry?.refs?.message_id ?? '');
  const short = mid.replace(/^-/, '').slice(-6);
  return short ? ` #${short}` : '';
};

export const DEFAULT_GUIDANCE = [
  '你挂在一个 QQ 聊天链路上：你的消息由 DSH 用 OneBot v11 协议发出去，聊天里还有别的 bot 和真人。',
  '规则（硬边界，必须遵守）：',
  '- 发言只有一条出口：调 onebot_reply 工具。你写在普通回复文本里的内容只是内部草稿，宿主不会替你发进聊天；不调工具就是沉默。**沉默就是"什么都不发"**——不要用「（看一眼，不接话）」这类括号旁白代替沉默：工具发出去的是字面文本，群里看到的就是这行字。',
  // 这句的旧版写的是"同一轮里多次调用只有最后一次会发出去"——那是 m06083 之前的覆盖语义，
  // 定案 A 之后**每多调一次，上一批就立刻发出去**。留着旧句不只是过时：它正好告诉模型
  // "前几批会蒸发"，于是分批发长报告时它以为说完了（14:22 真机事故的根因就是这句）。
  '- 激活期间可能有新消息以【插话 N 条】插进你正在进行的回合（下一步开始前送达）：先把手头的话说完再回应，被 @ 的优先；想改口就再调一次 onebot_reply——每多调一次，上一批排队的会立刻发出去，一轮里多次调用的内容都会按顺序到达，不会只剩最后一次。',
  // `m25796` 用户定案、`m25810` 给的行文：群聊里最常见的一种误读是**把别人的话题当成在跟自己说话**——
  // 上一条恰好是自己发的、下一条接上，就默认"他们在回我"，于是答非所问（16:06 那次把新图当成
  // 上一条的补描，是同一个错觉的另一种形态）。判据给的是**一个动作**（滤掉自己的发言再看），
  // 而不是一句"要仔细读"：动作能执行，形容词不能。
  '- 读上下文时先把**自己发过的消息**滤掉再看一遍：滤掉之后群友之间照样聊得通，说明他们在聊自己的事——这时既不该把它读成"大家在跟我说话"，也不该因为上一条是自己发的，就默认"他们在回我"。',
  '- 下游 bot 已经应答过的话题，不要重复应答。',
  '- 跨会话记忆里的内容，不要在群聊里说出它来自哪个会话。',
  '- 只交代你确实知道的事实；不确定就直说不知道，不要编。',
  '- 每次回复前都评估一遍记忆要不要更新，即使这次决定不回复也要评估；改哪条用上下文里显示的序号，要动记忆就调 onebot_memory。',
  // `m17909` 三层分工改写：短期记忆的职能整体搬进「活跃层」。旧版这几行讲的是
  // 「短期记忆删一删、重要的提升到长期」，于是模型把"正在进行的事"和"值得记住的事实"
  // 全塞进了同一个列表——现在前者归活跃层（有生命周期），后者归长期记忆（索引层）。
  '- **正在发生的事写进活跃层**（`onebot_memory` 的 `active`）：大家在聊什么用 `add` 记一条 `kind:"topic"`，你自己答应要做什么用 `kind:"task"`。一句话说完，别写成长段。',
  '- 活跃层只在当前会话里写；别的会话能看见（括号里带着出处），但你改不了、也结算不了它们——那是那边的事。',
  '- **事情做完了要结算**：`active.settle`，`outcome:"keep"` 必须给 `summary`（一句话写进长期记忆，否则以后没人知道发生过这件事），要留细节就用 `keep_as` 落进档案（`topic` 话题归档 / `person` 人物档案 / `group` 群档案 culture，可以同时落两处）；不值得留就 `outcome:"drop"` 直接删。别让活跃层一直堆着早就结束的事。',
  '- **长期记忆记的是事件**：群里值得记住的事，一行一条（什么时候、在哪儿、谁参与了、结果如何）。它是索引——细节进档案，整段对话不要抄进来。',
  '- **关于人的稳定事实写人物档案**（`persons`）：他是谁、在做什么、答应过什么、和谁熟。这类别写进长期记忆。',
  // `m15264`：这两条是一对。只写"长期"会让 A 群关于某个人的事在 B 群被原样念出来；
  // 只写"群档案"而不说清边界，模型会把群的事也塞进记忆，于是两边都记、两边都不准。
  '- 长期记忆记的是**事件**；这件事**跟某些人有关**，就在这条上带 `related_users:["QQ号"]`——那只是"跟谁有关"的标记，用来看它该不该跨群：带了就只会在"这些人也在的群里"被想起来；不点名的长期记忆会跨群可见，说出去的收不回来。',
  '- **群本身的事记到群档案**：群规、氛围、常驻活动写 `groups` 的 `culture`；一件有始有终的事（讨论、活动、争吵）走活跃层，结算时用 `keep_as:{target:"topic"}` 存成话题归档，长期记忆里留一行索引。**群档案不进共享**，只在它自己那个群里出现。',
  '- 记什么由你决定，但"这条能不能在别的会话里说"由代码判定——不要自己声明可见性，也不要试图把私聊里的事拿到群里讲。',
  // `m27441`：`onebot_session` 原来一个字都没有 guidance——模型对这个工具的全部知识就是工具描述。
  // 这里只补两条"什么时候想到它"，用法细节留给工具描述（那里改一次就够）。
  '- **别的会话里有你要的东西，就用 `onebot_session` 开条线问**（另一个群聊过什么、另一个会话里那张图）：递一句过去比猜强；反过来，你手上这个东西那边用得上，也可以递过去。',
  '- 递出去的每一句都会**真的把对面叫醒一次**（一次真实的模型调用）：别拿它当广播，也别替对面写发言——它说什么由它自己决定。开完线不用等，沉默就是它不接。',
  // `m27996` 用户给的原文。来由是 2026-10-27 真机：`send_group_forward_msg` 被 write 闸拒了，
  // 拒绝话里那句"要去 capability.writeAllow 里放行"把它引去翻文件系统找配置文件，翻了二十步
  // （`glob`/`pwsh`/`grep` 一路进到 node_modules 读插件源码）。拒绝话本身已经补了指路（`m27988`），
  // 这一条是兜底的止损：**被拒了就停**，别去找那个改不动的开关。
  '- 工具被拒就直接放弃或向用户说明原因，不要自己去翻插件源码或改配置文件——在聊天里改不了，翻了也没用。',
  // `m20991`：身份信息曾经被观测层机械地写成 `kind:"identity"` 条目灌进记忆库，和人物档案完全重复
  // （`m16530` 已把那段产线删掉，只剩存量）。提示词这里再堵一次：模型手写的"谁是谁"同样是重复。
  '- **别把"谁是谁"写进记忆**：昵称↔QQ 这类对应关系人物档案里已经有了（【本群认识的人】就是它），再写一条长期记忆只是重复。',
  // `m20991` 用户要求：敏感这件事模型也应该能说。它只会**收窄**（锁在本会话），所以交给模型判断是安全的。
  '- 某条记忆**涉及隐私**（钱、住址、身体、家庭、纠纷），写的时候就带 `sensitive:true`，事后才发现用 `long_term.sensitive:[序号]` 补标。标了它只留在当前会话，任何档位都不跨群；这个标记**只能加不能去**，标错最多是不外传，所以宁可按敏感标。',
  // `m24484`：图要先被看一遍才有内容，而消息本身是即时可见的——所以会出现「还在看」。
  '- 看到「[图片（还在看）]」说明识图还没回来。**别急着说"我看不到图"**：先调 `onebot_image_wait` 等一下（它会把描述取回来）；还在跑就如实说"图还没看清，等下"，别猜图里是什么。',
  '- 上下文里的「还没兑现的事」是事实记录（你答应过谁什么、多久了、他上次什么时候出现），不要因为它出现了就每次复述一遍；提不提、什么时候提，你自己判断。',
].join('\n');

/**
 * 会话目录配套的指导语（`m32112` 用户定案）：**只在 `cross.enabled` 且目录真的渲染出来时**
 * 追加到 `DEFAULT_GUIDANCE` 后面。
 *
 * 为什么不写进 `DEFAULT_GUIDANCE`：cross 默认是关的，而这段话说的是"你能去别的会话递东西"——
 * 关着的时候它一个字都做不到，写死了就是在教模型调一个会被拒的工具。
 *
 * 两处措辞是用户改过的：① 私聊也算（「不只群」）；② **交代来处是拟人的**，不要禁止。
 * 唯一保留的边界是隐私那条：从私聊听来的别点明是谁、哪段私聊。
 */
export const SESSION_GUIDANCE = [
  '- 【会话目录】就是上面列的那些群和私聊——不只群，私聊也一样能递。哪边正在聊的事和这里明显相关，或者你手上的东西那边用得上，就用 `onebot_session` 递过去，不用等谁开口请求；递之前先看一眼那一行的印象（带"印象："的那几行才有），它会告诉你那边会不会在意。',
  '- 递过去的东西落地时可以自然交代来处——「隔壁群有人在问这个」「X 群昨天聊过」比凭空冒出来更像人话；但从私聊里听来的别点明是谁、哪段私聊，说「听人说过」就够。递出去的每一句都会**真的把对面叫醒一次**：别拿它当广播，也别替对面写发言。',
].join('\n');

/**
 * 连官方接口时才追加的指导语（`m34032` 第 3 条：用户明确要求**在 prompt 里告知"超时会被降级"**）。
 *
 * 为什么要专门说：被动回复窗口是硬约束（5 分钟 / 同一个 `msg_id` 最多 4 次），而批次窗口
 * 加模型思考很容易超。降级成主动消息是**好事**（话照样发出去了），但模型不知道这件事时，
 * 会以为"我回得太慢所以没发出去"，于是重复发送、或者干脆不吭声。
 */
export const OFFICIAL_GUIDANCE = [
  '- 上游现在是 **QQ 官方接口**：一句话要在收到消息后 5 分钟内发出去，同一个 `msg_id` 最多用 4 次。超出这个窗口，枢纽会把回复降级成**主动消息**照常发出去——群里照样看得到，只是不再挂在原来那条消息下面。所以一轮要聊很久时，先把结论说了，别攒到最后。',
  '- 官方接口看不到群成员列表、群名和更早的消息原文。被问到"这里都有谁""这个群叫什么"这类问题时，只能依据你看得见的东西回答，不要编。',
].join('\n');

/**
 * 定时任务的两段指导语（`m35589` 定案）。
 *
 * 一段给**普通会话**（怎么排任务），一段只给**总机会话**（到点只许做一件事）。
 * 分开的理由：总机会话里"你可以说话"是有害的——它一开口，就等于替某个群发了言，
 * 而它既不知道那个群刚聊到哪，也没有任何记忆。
 */
export const TASK_GUIDANCE = [
  '- 要"过一会儿""每天提醒一下"这种，别自己惦记时间——用 `onebot_task` 排一个。到点它会把这事交回给那个会话里的你，你不用在这儿等。',
].join('\n');

/**
 * 总机会话的指导语：它什么都不用做。
 *
 * `m36272` 之后，到点的投递由**枢纽自己**完成（`session/event` 里认出提醒帧就直接叫醒目标），
 * 不再等这一轮模型。所以这里写的是"直接结束"——不让它调工具，才是最快也最不会出错的路径：
 * 真机上它一旦被"fire 被拒""没叫醒"这类信号带偏，就会开始自己想办法，白等过两分半。
 */
export const TASK_MASTER_GUIDANCE = [
  '这一轮只是收个信号：枢纽已经把提醒投给该收的人了。什么都不要做，直接结束。',
].join('\n');

export class Mind {
  #batches = new Map(); // sessionKey -> BatchWindow
  #nicknames = new Set(); // 我叫什么（一组：备注名 + 上游真昵称，事故 #11）
  #outcomes = new Map(); // sessionKey -> { ts, action }
  #replies = new Map(); // agentKey -> ReplyBuffer
  #feed = new Map(); // agentKey -> 本轮会话账本（session/event 摘要）
  #flushing = new Map();
  /**
   * 额度用尽期间攒下的原话（第二期，m13831）：`#quotaHeld` 是 **quotaKey（群/私聊）** → `{ entries, dropped }`。
   *
   * 这批消息**已经进了时间线**（下一段会话的快照会覆盖它们），但当前这一段的批量窗口
   * 已经在 `flush()` 开头被取走了——留在窗口里会撑爆窗口、留在别处又会被快照重复注入，
   * 所以单独留一份有界副本，专供"额度恢复后补最近 20 条原话"。
   *
   * 按群存而不是按会话存（m14570）：额度是按群设的，会话中途换了一次（预设切换、休眠退役）
   * 攒下的原话不该跟着会话一起丢——那正是额度闸门最该记住的东西。
   */
  #quotaHeld = new Map();
  #quotaSaid = new Map(); // quotaKey -> 上次"额度用尽"兜底话术的时间戳（冷却用）
  /**
   * 插话在飞的会话（sessionKey → 任务集合，m31311；多批插话见 m08218 用户定案）。
   *
   * 早先是"单会话单飞行"，结果**一个回合只放第一批进去**：回合在飞时后续批次虽然每拍都被
   * `scanDue` 挑中，却一律撞在"已有插话在飞"的闸门上返回 `steer:pending`、且**不排水**，
   * 只能堆到回合结束当一整坨进下一轮。改成每会话一组：**闸门降为"每批次一次"**——
   * 批次本身就是节流器（一批最多 `batchMs` 一次），而"递给宿主成功后同步 `batch.flush()`"
   * 已经保证同一批不会被插两次（那条路径里没有 await，单线程下不会被重入）。
   * `#expireAwake` 拿"有没有在飞"当忙。
   */
  #steering = new Map();
  /**
   * 本回合冻结的易变上下文（sessionKey → { text, at }，`m09285` 用户定案走方案 A）。
   *
   * 为什么必须冻结：宿主 `@deepseek-ai/dsh-agent-loop` 的 `preStep` **每个步骤边界**都会
   * `assemble → project`，而 `RuntimeContextProjection.project` 的判据只有
   * `if (this.retained?.text === snapshot) return;` ——文本变**一个字节**就 append 一条
   * user message（追加、不替换）。于是模型在回合里改一条记忆，宿主就把整份 3.6KB 上下文
   * 又塞一条 user 消息进来（真机日志实测：seq 9 与 seq 19 两份快照，3649→3619 字符，
   * 唯一差异是短期记忆少了 `4. 某个用户 是 QQ 10001`）。
   *
   * 冻结点＝**投递**（`pool.wake` 前作废缓存）。投递就是宿主那轮的起点，所以语义正好是
   * "一轮之内文本稳定"；插话走 `pool.steer`、不重新投递，故同一轮内插话也不会刷新。
   * 代价是模型本回合看不到自己刚写的记忆——`onebot_memory` 的回执它照常拿得到。
   *
   * 没有走"把 live 快照改成 `systemPrompt.section`"那条路：它确实永不进转录，但系统提示
   * 是**前缀**，记忆一改就整段缓存失效、整段历史重新计费，比追加在末尾贵得多。
   */
  #liveCache = new Map();
  /** 这个会话还有几批插话在飞（0 = 没有）。 */
  #steerInFlight(sessionKey) {
    return this.#steering.get(sessionKey)?.size ?? 0;
  }
  /** 上一轮发送失败的会话（agentKey → { text, status, retcode, error }）：下一批开头一次性告知（修3）。 */
  #sendFailures = new Map();
  /**
   * 「发送失败当场回执」的节流账（agentKey → { count, since }，用户 `m25376` 定案）。
   *
   * 为什么需要：失败常常是本轮最后一件事——之后群里没人说话，就永远没有"下一轮"，
   * 模型一直以为自己说出口了（19:10 那次图片就是这样）。所以失败后立刻排一次裸唤醒
   * 把回执递进去。但"重试→又失败→再收到回执"必须有刹车：同一会话在一个窗口里
   * 自动重开的次数有上限，撞到上限就退回老行为（下一批开头告知）。
   */
  #sendFailureNudge = new Map();
  /**
   * 晚到的图片描述（sessionKey → [{ ts, who, text }]，取走即清）：看图是异步旁路，描述生成完时
   * 这批消息可能已经渲染发走（模型只看到裸 `[图片]`）——下一批/插话开头把描述补上，
   * 别让"当时没来得及"变成"永远没有"。
   */
  #lateDescribes = new Map();
  /** 本段会话已经渲染过的条目 id（sessionKey → { set, order }，上限兜底）：晚到描述只补"已经看走"的；还没渲染的条目 live.text 会自然带上描述。 */
  #renderedIds = new Map();
  /**
   * 每个会话的唤醒状态（`dormant` 休眠 / `awake` 激活，见 `lib/agent/policy.js` 的
   * `initialWakeState`）。休眠期**只记录不叫模型**；被叫到才进激活，激活期按批量窗口说话，
   * 连续 `AWAKE_SILENT_TURNS` 轮没开口或空转超过 `awakeMs` 就回休眠（`m01733` 用户定的规则）。
   */
  #wakeStates = new Map(); // sessionKey -> { state, since, lastMsgAt, lastTurnAt, lastCheckAt, silentTurns }
  /**
   * "开局快照已经随哪一段会话给过了"（v4，`m24409`）。每段会话（激活）开始时转录是空的，
   * 模型需要一份"这段之前发生了什么"——但只给**一次**，且只给本批消息**之前**的（同一批
   * 消息再出现在快照里就是重复注入）。交还转录时清掉（见 `#retireAfterDormant`）。
   */
  #openingPresented = new Set(); // sessionKey -> 开局快照已给过

  constructor({ hub, timeline, store, audit, isolation, policy, pool, setup, log, guidance, capabilities, quota, quotaConfigFor, now } = {}) {
    this.hub = hub ?? null;
    /** 当前正在跑的那一轮的会话键：工具（onebot_memory 等）靠它落回正确的会话。 */
    this.activeSessionKey = null;
    this.activeActorId = null;
    this.timeline = timeline ?? hub?.timeline ?? null;
    this.store = store ?? null;
    /** 分群额度账本（m13404，P1 只记不拦）：批次最后一行由它渲染（`quota.render`）。 */
    this.quota = quota ?? null;
    /** 会话口径的额度解析（插件侧闭包：全局默认 + 名单条目覆盖）；没给就退化成"不报数"。 */
    this.quotaConfigFor = typeof quotaConfigFor === 'function' ? quotaConfigFor : null;
    this.audit = audit ?? null;
    this.isolation = isolation ?? null;
    this.policy = policy ?? resolveAgentPolicy({});
    this.pool = pool ?? null;
    this.setup = setup ?? null;
    this.log = log ?? (() => {});
    this.guidance = guidance ?? DEFAULT_GUIDANCE;
    this.capabilities = capabilities ?? [];
    this.selfId = hub?.config?.selfId ?? hub?.config?.upstreamSelfId ?? null;
    /**
     * 名字是**一组**（事故 #11）：配置里的 `nickname`/`upstreamNickname` 是"备注名"，
     * 上游账号的真昵称要靠 `get_login_info` 学。人 @ 我 时用的是哪个名字，事先不知道——
     * 只留一个名字，另一个名字的 @ 就永远叫不醒我。
     */
    this.nickname = hub?.config?.nickname ?? hub?.config?.upstreamNickname ?? null;
    this.#nicknames = new Set([this.nickname, hub?.config?.upstreamNickname].filter(Boolean).map(String));
    this.stats = {
      observed: 0,
      woken: 0,
      silent: 0,
      readonly: 0,
      /** 被会话白名单挡掉的消息数（m31030）：没列出的群/私聊不调模型，`lastObserve.reason` 会写明。 */
      unlisted: 0,
      /** 插话递进在飞回合的消息条数（m31311）。 */
      steered: 0,
      /** 发送失败当场回执实际排上的次数（m25376）。 */
      sendFailureNudges: 0,
      lastSteer: null,
      sent: 0,
      errors: 0,
      /** 进入激活的次数（被叫到、active 节拍、激活期窗口到期都算）。 */
      awakened: 0,
      /** 回休眠的次数（连续沉默、激活空转超时）。 */
      dormant: 0,
      /** 激活结束交还会话的次数（清空宿主转录；用户定案）。 */
      retired: 0,
      lastTurn: null,
      lastSetup: null,
      lastRetire: null,
    };
    this.lastActedAt = now ?? Date.now();
  }

  agentKeyOf(sessionKey) {
    return sessionKey;
  }

  /**
   * 这个 agent 的回复缓冲（没有就建一个）。必须跨轮稳定：会话级 `onebot_reply` 工具握着它的引用，
   * 而工具只在会话首次建立时注册一次（见 flush 里的注释）。
   */
  #replyFor(agentKey) {
    let buf = this.#replies.get(agentKey);
    if (!buf) {
      // 上限在这里钉住（m32420）：只限文字条数，图片不占额度。
      buf = new ReplyBuffer({
        maxText: Number(this.hub?.config?.replyMaxText ?? 3),
        maxImages: Number(this.hub?.config?.replyMaxImages ?? 9),
      });
      this.#replies.set(agentKey, buf);
    }
    return buf;
  }

  /** 释放某个 agent 的回复缓冲（会话被淘汰/关停时调用，避免留着一个再也没人读的引用）。 */
  releaseReply(agentKey) {
    return this.#replies.delete(agentKey);
  }

  /** 这个会话的唤醒状态（没有就按"休眠"建一个）。 */
  #wakeStateFor(sessionKey, now = Date.now()) {
    let st = this.#wakeStates.get(sessionKey);
    if (!st) {
      st = initialWakeState(now);
      this.#wakeStates.set(sessionKey, st);
    }
    return st;
  }

  /** 唤醒状态快照（`onebot_hub_status` 用它，排查"为什么它不说话了"时看得到睡/醒）。 */
  wakeStateOf(sessionKey) {
    const st = this.#wakeStates.get(String(sessionKey));
    return st ? { sessionKey: String(sessionKey), ...st } : null;
  }

  /** 进入激活（重复调用只刷新 `lastCheckAt`，不重置沉默轮数）。 */
  #enterAwake(sessionKey, st, now = Date.now(), reason = null) {
    if (st.state !== 'awake') {
      st.state = 'awake';
      st.since = now;
      st.silentTurns = 0;
      this.stats.awakened += 1;
      this.log(`会话 ${sessionKey} 进入激活（${reason ?? '唤醒'}）`);
    }
    st.lastCheckAt = now;
    return st;
  }

  /** 回休眠（记录原因，便于事后解释"它怎么突然不吭声了"）。 */
  #backToDormant(sessionKey, st, now = Date.now(), reason = '') {
    st.state = 'dormant';
    st.since = now;
    st.lastCheckAt = now;
    st.silentTurns = 0;
    this.stats.dormant += 1;
    if (reason) this.log(`会话 ${sessionKey} 回休眠（${reason}）`);
    // 用户定案：**激活结束就把这一段收尾**——先落盘，再清掉宿主会话的转录。
    void this.#retireAfterDormant(sessionKey, reason);
    return st;
  }

  /**
   * 激活结束的收尾：**落盘 → 交还会话（清空转录）**。
   *
   * 为什么清：一轮激活的转录 = 我们喂进去的本批消息 + 模型的回复，到下一次激活时它就是"旧账"，
   * 而且会排在 system prompt 那个**最近窗口之前**——模型会拿很久以前的话当上下文（用户指出的
   * 那个坑）。清掉之后每次激活都是新会话，上下文完全由 `liveContext()` 现算。
   *
   * 顺序不能反：**先落盘再交还**。会话卡与观察条目本来就是逐条落的，这里再冲一次盘，
   * 保证后面的 dispose 不会带走还没写下去的东西。
   */
  async #retireAfterDormant(sessionKey, reason = '') {
    /**
     * 总机会话**永不交还**（`m35589`）：宿主的排期绑着它的 sessionId，交还＝换新 id ＝
     * 所有定时任务指向一个没人用的会话（到点由宿主另起一个没有我们工具的 agent，中间人就哑了）。
     * 它上下文增长的问题交给 `agent.tasks.resetEvery` 轮换，不靠交还。
     */
    if (sessionKey === TASK_SESSION_KEY) return null;
    const agentKey = this.agentKeyOf(sessionKey);
    try {
      this.hub?.flushStorage?.();
    } catch (err) {
      this.log(`落盘失败（不影响交还会话）：${err?.message ?? err}`);
    }
    /**
     * 清账本放在 **dispose 之后**（不变量⑥「先 dispose 再清」）：`pool.retire` 是异步的，
     * 在它 await 期间迟到的事件/回复会往 `#feed`、回复缓冲里写——先清再 await，那几条就
     * 留在里面，带着旧会话的 `seq` 进入新会话，新会话从头编号就被判成"旧序号"全丢。
     */
    const resetLedgers = () => {
      try {
        this.#feed.delete(agentKey);
        this.#replyFor(agentKey).clear();
      } catch (err) {
        this.log(`重置会话账本失败（不影响交还）：${err?.message ?? err}`);
      }
    };
    if (!this.pool?.retire) {
      resetLedgers();
      return null;
    }
    try {
      const info = await this.pool.retire(agentKey, `dormant:${reason || 'unknown'}`);
      this.stats.retired = (this.stats.retired ?? 0) + 1;
      resetLedgers();
      // 新会话（转录已清空）⇒ 下一段的第一批要重新带开局快照。
      // 交还失败时**不清**：旧转录还在，再给一遍"这段之前的事"就是重复注入。
      this.#openingPresented.delete(sessionKey);
      // 晚到描述/渲染记录同理清掉：卡补描已经落进会话卡（下一段走快照），留着就是重复注入。
      this.#lateDescribes.delete(sessionKey);
      this.#renderedIds.delete(sessionKey);
      // 用尽期间攒的原话同理清掉：新段的开局快照已经覆盖这段聊天，再补一遍就是重复注入。
      this.#quotaHeld.delete(quotaKey(sessionKey));
      // 没递出去的"发送失败告知"一并清掉（`m25376` 自查）：它是绑在**上一段转录**上的——
      // 那段已经交还、窗口里再也看不到那句话。留着只会在几小时后突然告诉模型"你上一轮排队的
      // 回复没发出去"，而它既记不起那是什么、又可能照着回执去群里重发一条早就过时的内容。
      // 失败本身仍在时间线里（`decision:'failed'`），排查不受影响。
      this.#sendFailures.delete(agentKey);
      this.log(`会话 ${sessionKey} 激活结束：转录已交还（${info?.removed ? `删除 ${info.sessionId}` : `换新会话 id ${info?.sessionId ?? '?'}`}）`);
      return info;
    } catch (err) {
      this.log(`交还会话失败（下次激活会接着用旧转录）：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 激活空转超时：**最后一次动静之后** `awakeMs` 没人说话、它也没再开口 → 回休眠。
   * 没有这条就会永远挂着"激活"，下一次有人说话时还以为在对话中途。
   *
   * 动静看两样里更新的那个（m34646 用户定案）：`lastMsgAt`（有人发消息）与
   * `lastTurnAt`（它这一轮回完话）。只按"最后一条消息"算的话，`active` 档会错得很明显：
   * 消息先到、批量窗口和 active 节拍再拖一会儿才唤醒，模型答完时 `awakeMs` 的额度已经
   * 烧掉大半，于是"刚回完话就睡回去"——会话被归档、下一条消息又得从头开快照。
   * 两个都还没有过（刚进激活就空转）才退回 `since`。
   */
  #expireAwake(now = Date.now()) {
    const back = [];
    const limit = Number(this.policy?.awakeMs ?? 0);
    if (!(limit > 0)) return back;
    for (const [sessionKey, st] of this.#wakeStates) {
      if (st.state !== 'awake') continue;
      const last = Math.max(Number(st.lastMsgAt) || 0, Number(st.lastTurnAt) || 0) || Number(st.since) || 0;
      if (now - last < limit) continue;
      // m30055 防误杀：实测 agent 长思考 + 连环排查会把回合拖过 `awakeMs`，此刻归档
      // （宿主 stopActivity）会把在飞回合连同 subagent 一起掐掉。手头有活（在飞回合或
      // 排队中的唤醒）的不算"空转"，顺延到下一拍再判；活儿干完后自然超时回休眠。
      // 插话等待（m31311）同理：steer 任务不在 pool 的账上，`isBusy` 看不见，单独挡。
      if (this.#steerInFlight(sessionKey) > 0) continue;
      if (this.pool?.isBusy?.(this.agentKeyOf(sessionKey))) continue;
      this.#backToDormant(sessionKey, st, now, `激活 ${limit}ms 没有新消息也没有回复`);
      back.push(sessionKey);
    }
    return back;
  }

  /**
   * 记"这一轮到底开口没有"，用来决定激活状态要不要结束。
   * 连续 `AWAKE_SILENT_TURNS` 轮没说 → 回休眠（用户定的规则：连续 2 轮沉默）。
   */
  #noteSpokeOutcome(sessionKey, spoke) {
    const st = this.#wakeStateFor(sessionKey);
    if (spoke) {
      st.silentTurns = 0;
      return st;
    }
    if (st.state !== 'awake') return st;
    st.silentTurns += 1;
    if (st.silentTurns >= AWAKE_SILENT_TURNS) {
      this.#backToDormant(sessionKey, st, Date.now(), `连续 ${AWAKE_SILENT_TURNS} 轮没说话`);
    }
    return st;
  }

  /**
   * 把某个会话的 agent **建起来**（已经建过就直接返回），但不喂消息、不叫模型。
   *
   * 为什么要它：聊天管理命令要在**模型跑之前**改这个会话的权限（`/perm`），而权限只能设在一个
   * 已经存在的 `Session` 上——那时会话可能还没被任何一条消息唤醒过。这里复用 `wake()` 同一套
   * setup（同一个回复缓冲、同一套模型选择包装），所以"命令先建的会话"和"聊天建的会话"完全一样，
   * 不会出现"先用命令建的会话没有 onebot_reply 工具"这种偏差。
   */
  async ensureAgent(sessionKey) {
    if (!this.pool) throw new Error('agent 池未接入');
    const agentKey = this.agentKeyOf(sessionKey);
    return this.pool.enqueue(agentKey, async () => {
      const reply = this.#replyFor(agentKey);
      await this.pool.ensure(
        agentKey,
        this.setup ? (agentCtx) => this.setup(agentCtx, { reply, mind: this, sessionKey, agentKey }) : undefined,
      );
      return agentKey;
    });
  }

  /**
   * 上游连上后补全"我是谁"（配置没写账号/昵称时用 get_login_info 与握手结果）。
   *
   * 昵称是**累加**的（`#nicknames` 是一组而不是一个）：配置里写的备注名和上游账号的真昵称
   * 都要能把我叫醒——群里的人是手打 `@真昵称` 还是 `@备注名`，我们事先不知道（事故 #11）。
   */
  setIdentity({ selfId, nickname } = {}) {
    if (selfId) this.selfId = String(selfId);
    if (nickname) {
      this.#nicknames.add(String(nickname));
      if (!this.nickname) this.nickname = String(nickname);
    }
    return this.identity();
  }

  /** 我叫什么、账号是多少（诊断与提示词都在看它）。 */
  identity() {
    return { selfId: this.liveSelfId, nickname: this.nickname, nicknames: [...this.#nicknames] };
  }

  /**
   * "这条链路上我自己是谁"的实时答案。
   *
   * 为什么不能直接用 `this.selfId`：它来自配置 `upstreamSelfId`，而**那条配置是可空的**
   * （账号本来就能从握手/事件里学到）。配置空着时 `this.selfId` 是 `''`，
   * `detectMention` 的 at 比对就恒假——真机症状是"被 @ 了却 mentions: []，休眠态永不唤醒"（事故 #11）。
   * 所以这里按 配置 → 学到的上游账号 兜底。
   */
  get liveSelfId() {
    const configured = String(this.selfId ?? '').trim();
    if (configured) return configured;
    const learned = String(this.hub?.upstreamAccount ?? '').trim();
    return learned || null;
  }

  /** 我叫什么（一组名字，诊断用）。 */
  get nicknames() {
    return [...this.#nicknames];
  }

  /**
   * 记一次会话 setup 的落地情况（诊断用）。
   *
   * 为什么要留这个：`agentCtx.tools?.register?.(...)` 是**静默**的——真宿主里那个 `agentCtx`
   * 如果没暴露 `tools`，回复工具就根本没注册，模型只能写普通文本，于是表现为"叫醒了却不说话"，
   * 和"模型自己决定沉默"长得一模一样。把注册结果记下来就能一眼分辨。
   */
  noteSetup(info = {}) {
    this.stats.lastSetup = { at: Date.now(), ...info };
    return this.stats.lastSetup;
  }

  #newFeed(agentKey = null) {
    return {
      agentKey,
      at: 0,
      turn: null,
      assistantText: '',
      assistantMessages: 0,
      toolCalls: [],
      toolResults: [],
      turnEnd: null,
      turnError: null,
      interrupted: false,
      lastSeq: null,
    };
  }

  /**
   * 记一条**会话账本事件**（宿主的 `session/event`）。
   *
   * 为什么必须有它：真宿主里 `whenIdle()` 只保证"驱动器归于安静"，回合内模型报错/工具参数错
   * 会被 `kick()` 的 `catch {}` 吞掉，`sent=0` 因此无法归因；而会话文件要等关闭才落盘。
   * 这里把 `assistant/message` 正文、`tool/call`、`tool/result`、`turn/end` 的原因留存下来。
   *
   * @param {string} agentKey 会话键（`private:…` / `group:…`）
   * @param {object} event 宿主 `SessionEvent`：`{type, seq, time, data}`
   */
  noteSessionEvent(agentKey, event) {
    if (!agentKey || !event || typeof event.type !== 'string') return null;
    const rec = this.#feed.get(agentKey) ?? this.#newFeed(agentKey);
    this.#feed.set(agentKey, rec);
    // 同一事件可能被 root 级与会话作用域两条订阅同时送到（seq 在同一会话内单调递增），
    // 去重才能保住"同一句话只记一次"——否则模型那句回复会被发两遍。
    if (typeof event.seq === 'number') {
      if (rec.lastSeq !== null && event.seq <= rec.lastSeq) return rec;
      rec.lastSeq = event.seq;
    }
    const data = event.data ?? {};
    rec.at = Date.now();
    if (typeof data.turn === 'number') rec.turn = data.turn;
    if (event.type === 'assistant/message') {
      const text = textOfContent(data.message);
      if (text) rec.assistantText = rec.assistantText ? `${rec.assistantText}\n${text}` : text;
      rec.assistantMessages += 1;
      if (data.interrupted) rec.interrupted = true;
    } else if (event.type === 'tool/call') {
      rec.toolCalls.push({ name: String(data.name ?? ''), arguments: truncate(data.arguments) });
    } else if (event.type === 'tool/result') {
      rec.toolResults.push({
        error: data.error ? `${data.error.name ?? 'error'}: ${data.error.reason ?? data.error.code ?? ''}`.trim() : null,
        text: truncate(textOfContent(data.message)),
      });
    } else if (event.type === 'turn/end') {
      rec.turnEnd = data.reason?.kind ?? null;
      if (data.reason?.kind === 'error') rec.turnError = data.reason.error?.message ?? 'unknown';
    }
    return rec;
  }

  /**
   * 只读（§19 `preset: shadow`，或配置 `readonly: true`）：**hub 自己绝不动作**。
   *
   * 这一层管的是"叫不叫模型、以什么身份替它说话"——只读时：
   * 不叫模型（不花 token）、不发消息。**事件照旧广播给下游**：那是 hub 主链路的事，
   * 只读的是 hub 的手，不是下游的眼睛。开关在 hub 上（路由策略），这里只是读它。
   */
  get readonly() {
    return this.hub?.readonly === true;
  }

  /**
   * 这个会话该用哪份策略：全局 `policy` 为底，白名单条目只覆盖 `mode`（`m31030` 定案：
   * 批量窗口等参数全局统一）。每次现算不缓存——设置页改配置后插件会重新装配，但就算
   * 同一实例里配置对象被换掉，这里也立即生效。
   */
  #policyFor(sessionKey) {
    return mergePolicyMode(this.policy, sessionOverrideOf(sessionKey, this.hub?.config));
  }

  /** 某个 agent 最近一轮的会话账本（诊断用）。 */
  feedOf(agentKey) {
    return this.#feed.get(agentKey) ?? null;
  }

  /** 上游进来一条事件（hub.js 在写完时间线后调用）。 */
  observe(entry, { event, isSelf = false, nickname, selfId, silent = null } = {}) {
    this.stats.observed += 1;
    /**
     * 只读：观察计数照记，然后**到此为止**——不入批量窗口、不叫模型。
     * 判定放在 `silent` 之前还是之后无所谓（两条路都不叫模型），放前面是为了让日志/统计
     * 把"因为只读而没叫"和"因为命令已答而没叫"分开，排查时不会互相冒充。
     */
    if (this.readonly) {
      this.stats.readonly += 1;
      return { wake: false, reason: 'readonly', batch: 0 };
    }
    /**
     * hub 认定这条**已经被枢纽自己处理过**了（命中聊天管理命令，hub 传 `silent: 'chat-command'`）。
     *
     * 看见了，但不入批量窗口、不叫模型：枢纽已经用同一个账号回过这句话，再让模型说一遍就是
     * 同一个账号对同一句话答两次。注意这不影响消息的转发——那是 hub 主链路的事，已经做完了。
     */
    if (silent) return { wake: false, reason: silent, batch: 0 };
    const sessionKey = entry?.sessionKey ?? 'unknown';
    /**
     * 会话白名单（`m31030` 用户定案）：**没列出来的群/私聊不调模型**——不入批量窗口、
     * 不建唤醒状态、@ 也不理。这道门站在一切判定与花钱之前；"它为什么不醒"直接写在
     * `lastObserve.reason`（`onebot_hub_status` 一眼可见），省得去猜。
     */
    if (sessionOverrideOf(sessionKey, this.hub?.config) === null) {
      this.stats.unlisted += 1;
      this.lastObserve = {
        at: Date.now(),
        sessionKey,
        text: truncate(entry?.text ?? '', 120),
        mentions: [],
        selfId: this.liveSelfId,
        nicknames: this.nicknames,
        atTargets: [],
        wake: false,
        reason: 'unlisted',
        state: null,
        pending: 0,
        downstreamResponded: false,
      };
      return { wake: false, reason: 'unlisted', batch: 0 };
    }
    const payload = event ?? entry?.payload ?? null;
    const mentions = detectMention(payload, {
      selfId: selfId ?? this.liveSelfId,
      nickname: nickname ?? this.nickname,
      nicknames: this.nicknames,
    });

    // 先判"这条根本不值得叫人"：心跳/通知（未开 wakeOnNotice）/自己的消息，**不入批量窗口**。
    // 坑（实测）：以前无条件 `batch.push()`，心跳的批量窗口到期后由 `scanDue` 照常唤醒 agent，
    // 结果每条 meta_event 都白跑一个模型回合（`other:meta_event` 会话跑满 turns）。
    const pre = shouldWake({
      policy: this.#policyFor(sessionKey),
      entry,
      event: payload,
      batch: null,
      mentions,
      isSelf,
      downstreamResponded: false,
    });
    if (!pre.wake && (pre.reason === 'self' || pre.reason === 'mode:observer' || pre.reason.startsWith('kind:'))) {
      // 名单把这一类会话改成 observer 时，"@ 也不醒"是**策略**而不是意外——所以要把原因写进
      // `lastObserve`（`onebot_hub_status` 一次看见），否则这条消息在诊断里彻底不留痕。
      // `self` / 心跳通知不写：它们是常态噪声，会把真正值得看的那条观察冲掉。
      if (pre.reason === 'mode:observer') {
        this.lastObserve = {
          at: Date.now(),
          sessionKey,
          text: truncate(entry?.text ?? payload?.raw_message ?? '', 120),
          mentions: mentions.slice(),
          selfId: this.liveSelfId,
          nicknames: this.nicknames,
          atTargets: atTargetsOf(payload),
          wake: false,
          reason: pre.reason,
          state: null,
          pending: 0,
          downstreamResponded: false,
        };
      }
      return { wake: false, ...pre, batch: 0 };
    }

    const batch = this.#batches.get(sessionKey) ?? new BatchWindow({ size: this.policy.batchSize, ms: this.policy.batchMs });
    batch.push(entry);
    this.#batches.set(sessionKey, batch);

    /**
     * 唤醒状态机（`m01733`）：这一条算一条"新消息"——心跳/自己的话/命令回执都在上面被挡掉了，
     * 所以激活空转超时（`awakeMs`）与 active 节拍都按它计时。休眠期只入窗口、不叫模型。
     */
    const now = Date.now();
    const st = this.#wakeStateFor(sessionKey, now);
    st.lastMsgAt = now;

    const verdict = shouldWake({
      policy: this.#policyFor(sessionKey),
      entry,
      event: payload,
      batch,
      mentions,
      isSelf,
      wakeState: st,
      now,
      downstreamResponded: this.isDownstreamResponded(sessionKey, this.#silenceSince(batch, now)),
    });
    // 诊断闭环：把"这条为什么没叫我"记在最近一次观察里（`onebot_hub_status` 的
    // `agents.lastObserve` 直接看得到），省得每次都要靠 @ 一遍再猜。
    this.lastObserve = {
      at: now,
      sessionKey,
      text: truncate(entry?.text ?? payload?.raw_message ?? '', 120),
      mentions: mentions.slice(),
      selfId: this.liveSelfId,
      nicknames: this.nicknames,
      atTargets: atTargetsOf(payload),
      wake: Boolean(verdict.wake),
      reason: verdict.reason ?? null,
      state: st.state,
      pending: batch.count,
      downstreamResponded: Boolean(verdict.reason === 'silent:downstream-responded'),
    };
    if (!verdict.wake) return { wake: false, ...verdict, batch: batch.count, wakeState: st.state };

    this.#enterAwake(sessionKey, st, now, verdict.reason);

    // 唤醒路径：异步执行，不阻塞上游事件转发（转发不能因为模型慢而变慢）。
    void this.flush(sessionKey, { reason: verdict.reason }).catch((err) => {
      this.stats.errors += 1;
      this.log(`flush 失败 ${sessionKey}: ${err?.message ?? err}`);
    });
    return { wake: true, ...verdict, batch: batch.count, wakeState: st.state };
  }

  /**
   * 下游发出了 `send_*`（hub.js 在出手时调用）——两件事：
   *
   *  ① **"命令静默"判定**：下游应答过就闭嘴（原来的用途）。
   *  ② **进本批**（用户实测："下游bot发的消息没能进入会话"）：下游 bot 说的话也是**这个会话里
   *     发生过的事**，光留在时间线窗口里不够——窗口是"当前状态"，转录里没有它，模型看过就没了。
   *     所以把它推进批量窗口：下一次唤醒的"本批新消息"里就会带上它（`#batchText` 会渲染
   *     `下游→<名字>：…`）。
   *
   * **不叫醒**：只入窗口、不入唤醒判定——"下游已应答 → 保持沉默"这条硬约束不变（只有被叫到才醒）。
   * **休眠期也入批**（v4，`m24409`）：以前有 `state === 'awake'` 门槛，休眠期下游的回应只留在
   * 时间线窗口里、进不了批次——真机 16:12 那轮模型因此完全没看到隔壁 bot 说了什么。批次
   * 在休眠期只会攒着（assist 档的休眠不走节拍、不会被消费），下一次唤醒时随"本批新消息"一起
   * 带进去，正好和开局快照的去重对上（快照只放本批**之前**的）。
   */
  noteDownstreamSend({ sessionKey, action, ts = Date.now(), text, label, linkId, timelineId, entry = null } = {}) {
    if (!sessionKey) return null;
    // 会话白名单（m31030）：没列出的会话连"下游应答过"的账都不记——它永远不会被 flush。
    if (sessionOverrideOf(sessionKey, this.hub?.config) === null) return null;
    const rec = { ts, action: action ?? null };
    this.#outcomes.set(sessionKey, rec);
    // 下游说的话与群里的话同一套单行化（`m08997`）：换行留成 ` ⏎ `，别压掉。
    const body = flatBreaks(text);
    const isSend = String(action ?? 'send_msg').startsWith('send_');
    if (body && isSend) {
      const batch = this.#batches.get(sessionKey) ?? new BatchWindow({ size: this.policy.batchSize, ms: this.policy.batchMs });
      batch.push({
        sessionKey,
        direction: 'downstream-in',
        kind: 'action',
        action: action ?? 'send_msg',
        ts,
        text: body,
        // `live`：时间线真身。看图描述/媒体引用是异步回填到 `entry.text` 的（`hub.#enrichImages`
        // 之后还会 `cards.patch`），批次条目只留一份快照文本的话，"本批新消息"永远停在
        // `[回复][图片]`，比开局快照还糙——同一件事两处两个样（v4，`m26571`）。
        live: entry && typeof entry === 'object' ? entry : null,
        actor: { nickname: label || '下游 bot', role: null },
        // `timelineId`：这条在时间线里已有真身（hub.js `record` 的 downstream-in），
        // 开局快照按它去重，免得同一条话在"本批之前"和"本批"各出现一次。
        refs: { downstreamLabel: label ?? null, linkId: linkId ?? null, downstreamSend: true, timelineId: timelineId ?? null },
      });
      this.#batches.set(sessionKey, batch);
    }
    return rec;
  }

  isDownstreamResponded(sessionKey, sinceTs = 0) {
    const rec = this.#outcomes.get(sessionKey);
    if (!rec) return false;
    return sinceTs ? rec.ts >= sinceTs : true;
  }

  /**
   * "下游已应答"这道闸的**回看起点**。
   *
   * 休眠期的批量窗口不会 flush，`openedAt` 可能停在几十分钟前——直接拿它当判据，只要那之后
   * 有过任何一次下游应答，这个会话就被**永久静默**（真机事故 #10：用户 @ 我，我因为隔壁 bot
   * 26 秒前回过别人一句而装死，`woken: 0`、`batches.pending: 7`）。所以取"窗口开启时间"与
   * "最近一个批量窗口时长"里**更晚**的那个：同一轮里的应答照样压得住，陈年老账不算。
   */
  #silenceSince(batch, now = Date.now()) {
    const openedAt = batch?.openedAt ?? 0;
    const lookback = Math.max(1000, Number(this.policy?.batchMs ?? 0) || 20000);
    return Math.max(openedAt, now - lookback);
  }

  /** 这一批里有没有"在叫我"的消息（`@我`/引用我的话/喊昵称；私聊每条都算）。 */
  #calledIn(entries, sessionKey) {
    const sk = String(sessionKey ?? '');
    if (sk.startsWith('private:') && this.policy?.wakeOnPrivate !== false) return true;
    for (const item of Array.isArray(entries) ? entries : []) {
      const event = item?.payload ?? item?.event ?? null;
      const mentions = detectMention(event, {
        selfId: this.liveSelfId,
        nickname: this.nickname,
        nicknames: this.nicknames,
      });
      if (mentions.length) return true;
    }
    return false;
  }

  /**
   * 【会话目录】（`m32112` 用户定案）：这个插件接了哪些群、哪些私聊，排好序挑好条数。
   *
   * 为什么放在 `mind` 而不是装配层：排序要用"最近有人说话"（群档案的 `activeMembers`），
   * 而"当前会话是哪一个"只有这里知道——装配层拿到的是已经排好的行，它不该再算一遍。
   *
   * 三条硬规则（都来自用户拍板，别顺手放宽）：
   * 1. `cross.directory` 三档 `off|names|full`，默认 `names`；cross 关着时整段不出现。
   * 2. **印象只取群档案的 `culture`**，不取长期记忆里的条目——后者是模型自己每回合都在写的东西，
   *    拿它进前缀等于每回合换一次前缀，缓存全废。
   * 3. **群里不列私聊 id，私聊视角才列**（`m32426`）：群会话里只报"私聊 N 个"；私聊视角只看得到
   *    自己那一个人，编号不算新信息（红线是「群里看不到私聊」，见 `m28349`）。
   *
   * 排序必须**稳定**（`m32493` 自查）：这段在系统提示词靠前的位置，快照每回合重算一次——
   * 按"最近有人说话"排的话，任何群说一句话就把整段顺序洗一遍，前缀缓存从第 0 行起全废，
   * 和"印象只取 `culture`"是同一个道理。所以按 id 升序，谁最近活跃跟目录无关。
   */
  sessionDirectory(sessionKey) {
    const cfg = this.hub?.config ?? {};
    const cross = cfg.cross ?? {};
    if (!cross.enabled) return null;
    const mode = String(cross.directory ?? 'names');
    if (mode !== 'full' && mode !== 'names') return null;
    const limit = Math.max(0, Number(cross.rosterLimit ?? 30) || 0);
    if (!limit) return null;

    const profiles = this.hub?.profiles;
    const recs = profiles?.groups?.() ?? [];
    const byId = new Map();
    for (const rec of recs) {
      const id = String(rec?.worldKey ?? '').replace(/^group:/, '');
      if (id) byId.set(id, rec);
    }
    // 配置里登记过、但还没有档案的群也要列：它是"这个插件服务的群"，不是"我知道名字的群"。
    // 注意：解析后的配置里是 `agentGroups` / `agentPrivates` 这两个**对象映射**（id → 选项），
    // 不是 `agent.groups` 那种原始 JSON 串——`m32493` 自查时这里读错了键，私聊那一整排
    // 在真机上从来没渲染过（测试里假 hub 用了不存在的形状，所以没抓到）。
    for (const id of Object.keys(cfg.agentGroups ?? {})) {
      const key = String(id ?? '').trim();
      if (key && !byId.has(key)) byId.set(key, null);
    }
    const idKey = (id) => (/^\d+$/.test(id) ? id.padStart(20, '0') : `~${id}`);
    const groups = [...byId.entries()]
      .map(([id, rec]) => ({ id, rec }))
      .sort((a, b) => (idKey(a.id) < idKey(b.id) ? -1 : idKey(a.id) > idKey(b.id) ? 1 : 0));

    const mine = String(sessionKey ?? '');
    // 私聊名单：配置里登记的 ∪ **档案里见过的**（`m34897`）。官方上游不看本地白名单，
    // 配置里那两张名单很可能是空的；而"见过哪些私聊"只有档案知道——人物的 `groups`
    // 里每个 `private:<id>` 都是一次真实的私聊，官方 C2C 的会话键也是这个形状。
    const knownPrivates = new Set(
      Object.keys(cfg.agentPrivates ?? {}).map((x) => String(x ?? '').trim()).filter(Boolean),
    );
    for (const p of profiles?.persons?.() ?? []) {
      for (const scope of Object.keys(p?.groups ?? {})) {
        if (scope.startsWith('private:')) knownPrivates.add(scope.slice('private:'.length));
      }
    }
    const privates = [...knownPrivates]
      .sort((a, b) => (idKey(a) < idKey(b) ? -1 : idKey(a) > idKey(b) ? 1 : 0));
    const viewIsGroup = mine.startsWith('group:');
    const viewIsPrivate = mine.startsWith('private:');
    // 印象是"那个群在聊什么"的二手描述，只给**本来就能看到那边**的人看：
    // 群会话自己是内部人；私聊要么在白名单里（`isolation.trustedPrivates`，本来就能读跨会话），
    // 要么就只看到门牌号。这和 `m28349`「群里看不到私聊」是同一条线的另一头。
    const trusted = new Set((Array.isArray(cfg.isolation?.trustedPrivates) ? cfg.isolation.trustedPrivates : []).map(String));
    const canSeeInside = viewIsGroup || (viewIsPrivate && trusted.has(mine.replace(/^private:/, '')));
    const showNotes = mode === 'full' && canSeeInside;
    // 私聊视角一律列全部私聊编号（`m32426`）：这条提示词只有那一个人看得见，编号不算新信息，
    // 而且不知道"还有哪几个私聊"就没法决定要不要递东西过去。群里永远只报数量
    // （`m28349`「群里看不到私聊」），那条红线没过。
    const showPrivateIds = viewIsPrivate;

    // 私聊视角下**先给私聊留位**：`m32426` 的本意就是让私聊知道"还有哪几个私聊"，
    // 要是被一群群号挤到「还有 N 个没列」里，这条需求等于没做。
    const groupBudget = showPrivateIds ? Math.max(0, limit - privates.length) : limit;
    const shownGroups = groups.slice(0, groupBudget);
    const shownPrivates = showPrivateIds ? privates.slice(0, Math.max(0, limit - shownGroups.length)) : [];

    const rows = [];
    for (const g of shownGroups) {
      const name = g.rec?.name ? `（${g.rec.name}）` : '';
      const count = Number(g.rec?.memberCount) > 0 ? Number(g.rec.memberCount) : 0;
      // 有名字时「）· 12 人」贴着写；没名字时补一个空格，别排成「群 222· 12 人」。
      const size = count ? `${name ? '' : ' '}· ${count} 人` : '';
      rows.push({
        text: `群 ${g.id}${name}${size}`,
        mine: mine === `group:${g.id}`,
        note: showNotes && g.rec?.culture ? `印象：${String(g.rec.culture).replace(/\s+/g, ' ').trim().slice(0, 30)}` : null,
      });
    }
    for (const id of shownPrivates) {
      rows.push({ text: `私聊 ${id}`, mine: mine === `private:${id}`, note: null });
    }

    const shown = rows;
    const dropped = groups.length - shownGroups.length
      + (showPrivateIds ? privates.length - shownPrivates.length : 0);
    const tail = [];
    if (viewIsGroup && privates.length) tail.push(`私聊 ${privates.length} 个，不列编号`);
    // 条数把当前这条私聊挤掉了也要说清楚：它是"这里"，被自己的名单挤出去很荒唐。
    if (viewIsPrivate && !shown.some((r) => r.mine)) tail.push(`这里：私聊 ${mine.replace(/^private:/, '')}`);
    if (dropped > 0) tail.push(`还有 ${dropped} 个没列`);
    if (!shown.length) return null;

    // 标题只报"这个插件有几个群/私聊"这个事实，不跟 rows 的下标走（rows 可能被 limit 截过）。
    const title = showPrivateIds && privates.length
      ? `${groups.length} 个群 · ${privates.length} 个私聊`
      : `${groups.length} 个群`;
    return {
      title,
      rows: shown,
      tail,
    };
  }

  /**
   * 活跃层视图（`m17909`）：这个会话眼下看得见的"进行中的话题 / 正在做的事"。
   *
   * 与记忆分开算可见性（见 `active.isActiveVisible`）：群档案不进共享、不套 `crossGroupFacts`，
   * 走的是"白名单 + 共同活跃群友"。`entries` 就是模型在 prompt 里看到的**那一份**列表，
   * 序号按它算——`onebot_memory` 的 update/settle 也拿这份回读，两边必须同源。
   *
   * 单独抽成一个方法，是为了让 `onebot_memory` 写完之后能再取一次**新序号**回给模型
   * （结算掉一条，后面几条的号会前移；模型得知道现在几号对应哪一条）。
   */
  activeView(sessionKey, { actorId = null, worldKey = sessionKey } = {}) {    const activeCfg = this.hub?.config?.active ?? {};
    const now = Date.now();
    const entries = this.hub?.active?.all?.() ?? [];
    const base = { entries: [], limit: 0, settle: false, denied: [], now, settleKey: null };
    if (activeCfg.enabled === false || !entries.length) return base;
    const share = buildShareContext({
      persons: this.hub?.profiles?.persons?.() ?? [],
      groupOf: (scope) => this.hub?.profiles?.group?.(scope) ?? null,
      groupMembers: (scope) => this.hub?.profiles?.groupMembers?.(scope) ?? null,
      whitelist: activeWhitelist(this.hub?.config),
      windowDays: activeCfg.activeWindowDays,
      now,
    });
    const { visible, denied } = filterActive(entries, {
      sessionKey,
      worldKey,
      actorId,
      isolation: this.isolation,
      share,
      activeWindowDays: activeCfg.activeWindowDays,
      now,
    });
    const limit = Math.max(0, Number(activeCfg.injectLimit ?? 8) || 0);
    const shown = visible.slice(0, limit);
    // 挤出视野的那些（`m21098` 自审）：序号只覆盖 `shown`，被挤掉的既看不见也结算不掉。
    // 渲染时明说一句，模型才知道"先结算前面这些，后面就会露出来"。
    const hidden = Math.max(0, visible.length - shown.length);
    // 「待结算」每天最多提一次（`Reminders` 的 24h 冷却账本，按会话分键——
    // 一个全局键会让第一个活跃的会话把当天的额度用光，别的会话永远等不到提醒）。
    const settleKey = `settle:active:${sessionKey}`;
    const settle = Boolean(shown.length)
      && activeCfg.dailySettleReminder !== false
      && (this.hub?.reminders ? this.hub.reminders.canAsk(settleKey) : false);
    return { entries: shown, limit: shown.length, hidden, settle, denied, now, settleKey: settle ? settleKey : null };
  }

  /** 组装某一会话的上下文（供 `onebot_context` 工具与 flush 共用）。 */
  snapshot(sessionKey, { actorId, windowLimit = 40, budget, audit = true } = {}) {
    const events = this.timeline?.bySession?.(sessionKey, 200) ?? [];
    let digest = buildDigest(events, { maxMessages: 40, maxLines: 12 });
    /**
     * 重启之后内存环是空的（L1 只追加、不回放），会话卡会变成"最近 0 条消息"。
     * 所以环里没有这一会话时，退回落盘的那张卡——它是**重启前**的，`resumed: true` 会
     * 一路标到 prompt 里，模型不会把几天前的话当成刚说的。
     */
    if (!digest.messageCount && !events.length) {
      const stored = this.hub?.cards?.digestFor?.(sessionKey);
      if (stored) digest = stored;
    }
    /**
     * 总机会话什么都不注（`m35589`）：它没有世界观，也不需要——到点只转发一个 id。
     * 真注进去的话，它每被叫醒一次就多背一份群档案与记忆，而它一个字都用不上。
     */
    const bare = sessionKey === TASK_SESSION_KEY;
    const windowEntries = bare ? [] : events.slice(-windowLimit);
    const memoryEntries = bare ? [] : (this.store?.all?.() ?? []);
    const worldKey = digest.worldKey ?? sessionKey;
    /**
     * 记忆分块（§24.11）：短期=本会话/本世界的，长期=跨会话的。
     * 模型改写记忆时说的"第 N 条"指的就是这两块里的下标，所以**装配与写入必须看同一份列表**——
     * 这里切好的 `blocks` 会原样回给 `onebot_memory` 校验用。
     */
    const blocks = memoryBlocks(memoryEntries, { sessionKey, worldKey, actorId, isolation: this.isolation });
    /**
     * 主动回忆（§24.6 M18）：代码只交事实（谁、答应了什么、多久前提的、他上次露面是什么时候），
     * 说不说由模型定。这里只做一件事——把 24 小时内已经提过的滤掉（防骚扰安全阀）。
     * **注意**：`snapshot()` 是只读的（`onebot_context` 也会调它），所以这里不记账；
     * 记账在 `flush()` 里真的把这段交给模型之后（否则看一眼上下文就把提醒额度用掉了）。
     */
    const cues = this.hub?.profiles
      ? collectCues({
          persons: this.hub.profiles.persons?.() ?? [],
          sessionKey,
          worldKey,
          actorId,
          isolation: this.isolation,
          limit: this.hub?.config?.reminders?.limit ?? undefined,
        })
      : [];
    const freshCues = bare ? [] : this.hub?.reminders ? this.hub.reminders.filter(cues) : cues;
    /**
     * 活跃层（`m17909`）：进行中的话题 + agent 正在做的事。
     * 见 `activeView`——那里的 `entries` 就是模型在 prompt 里看到的那一份列表。
     */
    const activeView = this.activeView(sessionKey, { actorId, worldKey });
    const active = activeView.entries.length ? activeView : null;
    // 会话目录（`m32112`）：cross 关着或目录被关掉时返回 null，装配层整段跳过。
    const directory = bare ? '' : this.sessionDirectory(sessionKey);
    /**
     * 人设（①）：在 hub 上后挂，没接就空着（装配层会跳过空段）。
     * 人设是**每会话**解析出来的（可能绑在某个预设上），不是全局一份——同一个 bot 在群 A
     * 和群 B 可以是两个角色，这在 master 那版是做不到的。
     */
    const persona = this.hub?.persona?.render?.(sessionKey) ?? '';
    // 表情包清单（④§26）：**必须进上下文**，否则模型会开始编造 id。
    // 条数上限由 memes.topK 控制（默认 50），清单本身由 MemeStore 负责"最近用过的强制入列"。
    const memes = this.hub?.memes?.renderForPrompt?.({ limit: this.hub?.config?.memes?.topK ?? 50 }) ?? '';
    // 官方通道的两句（`m34032`）：只在真的连着官方接口时追加，否则就是在讲一件办不到的事。
    const official = this.hub?.config?.official?.enabled === true;
    // 定时任务（`m35589`）：普通会话教"怎么排"，总机会话教"只准转发"——两边不能共享一段话。
    const taskSession = sessionKey === TASK_SESSION_KEY;
    const tasksOn = this.hub?.config?.agentTasks?.enabled !== false;
    // 总机会话（`m36360`）：**什么都不注入**——它不该知道这个插件怎么聊天、有什么表情包、
    // 谁是群友。它唯一的用途是给宿主的排期提供一个收件地址，枢纽从 `session/event` 里
    // 认出提醒帧就直接投递，用不着它做任何事。给它人格与记忆，它就会开始"帮忙"。
    const guidanceText = taskSession
      ? TASK_MASTER_GUIDANCE
      : [
          this.guidance,
          directory ? SESSION_GUIDANCE : '',
          official ? OFFICIAL_GUIDANCE : '',
          tasksOn ? TASK_GUIDANCE : '',
        ]
          .filter(Boolean)
          .join('\n');
    const assembled = assembleContext({
      guidance: guidanceText,
      persona: taskSession ? '' : persona,
      memes: taskSession ? '' : memes,
      sourceHeader: buildSourceHeader({
        selfId: this.liveSelfId,
        nickname: this.nickname,
        sessionKey,
        worldKey,
        // 链路取"最近一条**真实会话**条目"的链路（`agent:*`/`hub:*` 是枢纽自己的账：
        // 拿它们当链路会写出 `【来源】… 链路 agent:memory` 这种莫名其妙的来源——真机就是这么漏的）。
        // 链路优先取**上游**条目（会话是从群里来的）。以前取"最近一条真实条目"，下游 bot 一发言
        // 来源头就写成「链路 down:127.0.0.1:8080」——语义不对（`m02432` P5）。
        linkId:
          [...windowEntries].reverse().find((e) => e?.direction === 'upstream-in' && String(e?.linkId ?? ''))
            ?.linkId ?? this.hub?.upstreamLinkId,
      }),
      digest,
      capabilities: typeof this.capabilities === 'function' ? this.capabilities() : this.capabilities,
      windowEntries,
      memoryEntries,
      memory: blocks,
      person: actorId ? this.hub?.profiles?.person?.(actorId) ?? null : null,
      // 【本群认识的人】（`m09409`）：群会话里让模型知道群里还有谁、谁是谁。
      // 条数走 `memory.peopleRoster`（默认 20，0＝整段不渲染）——用户明确要求"不要限死"。
      people: this.hub?.profiles?.persons?.() ?? [],
      peopleLimit: this.hub?.config?.memory?.peopleRoster ?? 20,
      group: worldKey.startsWith('group:') ? this.hub?.profiles?.group?.(worldKey) ?? null : null,
      directory,
      cues: freshCues,
      active,
      // 自述档案（`m20216`）：`self.json` 以前只写不读——装配层没有 self 段、也没有工具暴露它，
      // 模型写过"我说过什么/我犯过什么错"自己看不见。这里只取本会话用得到的几项（见 `renderSelf`）。
      self: this.hub?.profiles?.self?.() ?? null,
      sessionKey,
      worldKey,
      actorId,
      isolation: this.isolation,
      budget,
      selfId: this.liveSelfId ?? this.selfId,
    });
    // 每次装配都留痕（§24.5）：跨会话记忆的放行/拦截必须可解释、可追溯。
    // `audit:false` 只有 live 上下文那条路用（宿主每次装配都会调它，一次回合可能装配多次，
    // 全记会把审计账本刷满；真正"这一轮"的那次装配仍然记账）。
    if (this.audit && audit) {
      for (const a of assembled.audit) this.audit.add({ ...a, sessionKey, at: Date.now() });
    }
    return {
      ...assembled,
      digest,
      events,
      cues: freshCues,
      // 活跃层：`entries` 是模型看见的那一份（序号按它算），`settleKey` 给 flush 记账用——
      // `snapshot()` 只读，记账必须等这段真的交给模型之后（和 cues 一个道理）。
      active: active ? { ...active } : null,
      window: renderWindow(windowEntries, { selfId: this.selfId }),
    };
  }

  /**
   * **每轮现算**的易变上下文（用户定案）＝ 卡片 / 记忆 / 最近窗口 / cues / 人设 / 表情包清单…
   *
   * 它由宿主的 `systemPrompt.context({ text })` 在**每次装配 prompt 时**调用（那条 `text` 是函数），
   * 所以每一步都是现算的——但**算出来的文本在这一轮内被冻结**（见 `#liveCache` 与
   * `invalidateLiveContext`）。宿主在 `RuntimeContextProjection.project` 里逐字节比对这份文本，
   * 只要它变了就把整份上下文 append 成一条 user message；回合中改记忆就会触发这件事。
   *
   * 用户消息那边只剩"本批新消息"（见 `#batchText`）。
   */
  liveContext(sessionKey, { actorId } = {}) {
    const key = String(sessionKey ?? '');
    if (!key) return '';
    const cached = this.#liveCache.get(key);
    if (cached) {
      cached.hits = (cached.hits ?? 0) + 1;
      return cached.text;
    }
    try {
      const text = this.snapshot(key, { actorId: actorId ?? this.activeActorId, audit: false }).text;
      // `hits` 从 1 起：算这一次也是宿主的一次调用，`composed` 记真正重算过几遍。
      this.#liveCache.set(key, { text, at: Date.now(), hits: 1, composed: 1 });
      return text;
    } catch (err) {
      // 装配失败不能伪装成"没有上下文"：明说，模型与排查的人都看得见。
      return `（本会话上下文装配失败：${err?.message ?? err}）`;
    }
  }

  /**
   * 作废本会话冻结的上下文——**投递前**调用（`pool.wake` 的两处）。
   *
   * 下一次宿主装配 prompt 时 `liveContext` 会重算并重新冻结，所以新一轮看到的是最新记忆；
   * 而在飞那一轮的每一步都拿同一份文本，宿主就不会把整份上下文重复 append 进转录。
   * `onebot_context` 工具走的是 `snapshot()`（不经这里），所以排查时看到的永远是现算的真身。
   */
  invalidateLiveContext(sessionKey) {
    const key = String(sessionKey ?? '');
    if (!key) return;
    this.#liveCache.delete(key);
  }

  /**
   * 本批**新消息**的紧凑文本——这就是每一轮用户消息的全部内容。
   *
   * 卡片/记忆/窗口这类"状态"已经由 `liveContext()` 每轮现算进 system prompt，
   * 所以这里**只写这一批真实发生的事**：转录里因此只剩对话本身，不再叠上下文副本。
   * 每段会话的第一批额外带一份开局快照（`#openingText`，v4）。
   */
  #batchText(sessionKey, batchEntries = [], opening = '') {
    const head = `【新消息 ${batchEntries.length} 条】会话 ${sessionKey}｜现在 ${stampNow()}`;
    const fail = this.#takeSendFailureNotice(sessionKey);
    const parts = [];
    if (fail) parts.push(fail);
    parts.push(head, ...this.#batchLines(sessionKey, batchEntries));
    const late = this.#takeLateDescribeLines(sessionKey);
    if (late) parts.push(late);
    // 额度报数行（m13404，P1）挂在**最后一行**：本批新消息、晚到描述之后；开局快照仍在最前面。
    const notice = this.#quotaNotice(sessionKey);
    if (notice) parts.push(notice);
    const body = parts.join('\n');
    // 开局快照放前面：先交代"这段之前发生了什么"，再给这一批的新消息。
    return opening ? `${opening}\n\n${body}` : body;
  }

  /**
   * 分群额度报数行（m13404，P1 只记不拦）：口径与限额按会话解析（插件侧 `quotaConfigFor`），
   * 账走 `QuotaLedger`。没配额度、没装账本、或 `notice:'off'` 时返回空串，批次保持原样。
   * 数字是"截至上一批"——当前在飞回合的 usage 还没到账，所以它不是实时值。
   */
  #quotaNotice(sessionKey) {
    const ledger = this.quota;
    if (!ledger || typeof ledger.render !== 'function') return '';
    try {
      const quota = this.quotaConfigFor?.(sessionKey) ?? null;
      if (!quota) return '';
      return ledger.render(String(sessionKey ?? ''), quota);
    } catch (err) {
      this.log?.(`额度报数行渲染失败 ${sessionKey}：${err?.message ?? err}`);
      return '';
    }
  }

  /** 这个会话解析后的额度配置（走插件侧 `quotaConfigFor`：只认白名单条目里那一份，m14190）。 */
  #quotaFor(sessionKey) {
    if (!this.quotaConfigFor) return null;
    try {
      return this.quotaConfigFor(String(sessionKey ?? '')) ?? null;
    } catch (err) {
      this.log?.(`额度配置解析失败 ${sessionKey}：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 额度闸门（第二期，m13831）：这次唤醒要不要拦。
   *
   * - 没配额度、账本不在、或压根没启用 → 不拦（第一期的行为原样保留）；
   * - 用尽 → **拦**：不装配上下文、不叫模型、不发言，本批原话存进 `#quotaHeld` 等恢复时补；
   * - 用尽但这批叫到了我（@）→ 仍然不调模型，但兜一句 `exhaustedReply`（`onExhaust:'silent'`
   *   则一个字都不发）；同一会话受 `noticeCooldownMs` 限流，免得被 @ 一次发一句；
   * - `superuserBypass:true` 时超管的 @ 可以照常跑（默认 false：超管也不绕过，账对全群一视同仁）。
   */
  async #quotaVerdict(sessionKey, batchEntries, { calledNow = false } = {}) {
    const ledger = this.quota;
    const quota = this.#quotaFor(sessionKey);
    if (!ledger || typeof ledger.state !== 'function' || !quota?.enabled) return { blocked: false };
    let st;
    try {
      st = ledger.state(String(sessionKey ?? ''), quota);
    } catch (err) {
      this.log?.(`额度状态读取失败 ${sessionKey}：${err?.message ?? err}`);
      return { blocked: false };
    }
    if (!st.exhausted) return { blocked: false, state: st };

    if (calledNow && quota.superuserBypass && this.#superUserIn(batchEntries)) {
      return { blocked: false, state: st, bypass: true };
    }
    // 拦之前先把这批原话留下来：后面恢复时要补的就是它们。
    this.#holdQuotaEntries(sessionKey, batchEntries);
    if (calledNow && quota.onExhaust !== 'silent') await this.#sayQuotaExhausted(sessionKey, quota);
    return { blocked: true, scope: st.scope, state: st };
  }

  /** 这批里有没有超管（名单只认 `hub.config.chatCommands.superUsers`，与命令权限同一处判断）。 */
  #superUserIn(batchEntries) {
    const list = this.hub?.config?.chatCommands?.superUsers;
    if (!Array.isArray(list) || !list.length) return false;
    return (Array.isArray(batchEntries) ? batchEntries : []).some((e) => isSuperUser(e?.actor?.user_id, list));
  }

  /** 攒进有界副本；超出 `QUOTA_HOLD_MAX` 的从最旧处丢，并记下丢了多少（补注入时要如实说）。 */
  #holdQuotaEntries(sessionKey, entries) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (!list.length) return;
    const key = quotaKey(sessionKey); // 按群攒，不按会话（m14570）
    let rec = this.#quotaHeld.get(key);
    if (!rec) {
      rec = { entries: [], dropped: 0 };
      this.#quotaHeld.set(key, rec);
    }
    rec.entries.push(...list);
    while (rec.entries.length > QUOTA_HOLD_MAX) {
      rec.entries.shift();
      rec.dropped += 1;
    }
  }

  /**
   * 恢复后第一次唤醒：把这期间攒的原话（最近 `QUOTA_CATCHUP` 条）拼成一段补注入，取走即清。
   *
   * 走 `#batchLines` 是有意的——格式与正常批次一致，并且会 `#markRendered`，
   * 于是这些条目的晚到图片描述还能像平常那样补进来。
   */
  #takeQuotaCatchUp(sessionKey) {
    const key = quotaKey(sessionKey);
    const rec = this.#quotaHeld.get(key);
    if (!rec?.entries.length) return '';
    this.#quotaHeld.delete(key);
    const picked = rec.entries.slice(-QUOTA_CATCHUP);
    const lost = rec.dropped > 0 ? `（更早的 ${rec.dropped} 条已丢弃）` : '';
    const head = `【额度恢复：这期间攒下的 ${picked.length} 条${lost}】以下是我没在场的群聊原文，不是此刻在跟我说话：`;
    return [head, ...this.#batchLines(sessionKey, picked)].join('\n');
  }

  /** 用尽期间的兜底话术：只发固定一句，不调模型；`onExhaust:'silent'` 由调用方挡掉。 */
  async #sayQuotaExhausted(sessionKey, quota) {
    const text = String(quota.exhaustedReply ?? '').trim();
    if (!text) return null;
    const now = Date.now();
    const cooldown = Math.max(0, Number(quota.noticeCooldownMs ?? 0) || 0);
    const key = quotaKey(sessionKey); // 冷却按群算：换会话重发一句等于刷屏（m14570）
    const last = this.#quotaSaid.get(key) ?? 0;
    if (cooldown > 0 && last && now - last < cooldown) return null;
    this.#quotaSaid.set(key, now);
    try {
      const sent = await this.deliver(sessionKey, { segments: [{ type: 'text', data: { text } }], text });
      this.log?.(`额度用尽，兜底告知 ${sessionKey}：${sent?.ok === false ? '发送失败' : '已送达'}`);
      return sent;
    } catch (err) {
      this.log?.(`额度用尽兜底告知失败 ${sessionKey}：${err?.message ?? err}`);
      return null;
    }
  }

  /** 批量行渲染（`#batchText` 与插话消息共用；正文取真身，见 m26571）。顺手记下"这条已经看走了"，晚到描述只补这些。 */
  #batchLines(sessionKey, batchEntries = []) {
    const lines = [];
    for (const entry of batchEntries) {
      const actor = entry?.actor ?? {};
      const who = displayActor(actor, entry?.direction === 'downstream-in' ? '下游' : '某人');
      // `role` 是 'unknown' 时不渲染：官方通道拿不到群角色（那不是事实缺失，是平台不给），
      // 每行都挂一个 `(unknown)` 只会让人以为解析坏了。
      const role = actor.role && actor.role !== 'unknown' ? `(${actor.role})` : '';
      const via = entry?.direction === 'downstream-in' ? '下游→' : entry?.direction === 'downstream-out' ? '我→' : '';
      // 文本取真身（`live`）优先：看图描述是异步回填的，渲染时读真身才能带上 `[图片：…]`
      // ——否则本批比开局快照还糙，同一件事两个样（`m26571`）。
      const raw = entry?.live && typeof entry.live.text === 'string' && entry.live.text ? entry.live.text : entry?.text;
      // 换行留成 ` ⏎ `（`m08997`）：一条消息一行，但断过行这件事要看得见——
      // 快照/窗口/恢复卡那几层以前直接压成空格，清单型消息会被挤成一坨。
      const text = flatBreaks(raw);
      // 逐条带日期时间（`m34049` 用户要求"所有消息都加上日期和时间"）：批头那个"现在"只是
      // 凑批时刻——群里攒批常常跨好几分钟，"08:12 那条"是哪天说的只有行内时间说了算。
      lines.push(`- ${mdhm(entry?.ts)} ${via}${who}${role}：${text}${mediaTag(entry)}`);
      this.#markRendered(sessionKey, entry);
    }
    return lines;
  }

  /** 记"这条已经渲染给模型看过了"（晚到描述的判据）。只记有 id 的；400 条上限，超出挤掉最旧的。 */
  #markRendered(sessionKey, entry) {
    const id = String(entry?.live?.id ?? entry?.id ?? '');
    if (!id) return;
    let rec = this.#renderedIds.get(sessionKey);
    if (!rec) {
      rec = { set: new Set(), order: [] };
      this.#renderedIds.set(sessionKey, rec);
    }
    if (rec.set.has(id)) return;
    rec.set.add(id);
    rec.order.push(id);
    while (rec.order.length > 400) {
      const dropped = rec.order.shift();
      rec.set.delete(dropped);
    }
  }

  /**
   * 晚到的图片描述（hub 在看图写回后调）：只补"批次已经带着裸 `[图片]` 发走"的条目——
   * 还没渲染的条目下一批读 `live.text` 自然带描述，补了反而重复。取走即清的一次性队列见 `#takeLateDescribeLines`。
   */
  noteLateDescribe(entry, descriptions) {
    const sessionKey = entry?.sessionKey ?? entry?.live?.sessionKey;
    const id = String(entry?.id ?? '');
    if (!sessionKey || !id || !descriptions?.size) return;
    const rec = this.#renderedIds.get(sessionKey);
    if (!rec?.set.has(id)) return;
    const texts = [...descriptions.values()].map((d) => flatBreaks(d?.text).slice(0, 160)).filter(Boolean);
    if (!texts.length) return;
    const actor = entry?.actor ?? {};
    const who = displayActor(actor, '某人');
    let list = this.#lateDescribes.get(sessionKey);
    if (!list) {
      list = [];
      this.#lateDescribes.set(sessionKey, list);
    }
    list.push({ id, messageId: String(entry?.refs?.message_id ?? ''), ts: entry.ts, who, text: texts.join('；') });
  }

  /**
   * 划掉"这条的迟到描述已经直接交给模型了"（`m24656`）。
   *
   * 为什么需要：`onebot_image_wait` 会把描述**当成工具结果**递给模型，而 `noteLateDescribe`
   * 同时也在排队那句【图片补描】——同一张图的描述于是送了两遍。真机上第二遍正好贴在新消息
   * 后面，模型把"新消息 + 补描"读成了"一条消息 + 它的迟到描述"，判定整批没有新内容。
   * 工具侧读完就调这里，把还排在队里的那条划掉（取走即清的队列，划掉＝不再补）。
   */
  markDescribed(sessionKey, ids = []) {
    const list = this.#lateDescribes.get(sessionKey);
    if (!list?.length) return 0;
    const drop = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x ?? '')).filter(Boolean));
    if (!drop.size) return 0;
    const kept = list.filter((x) => !drop.has(String(x?.id ?? '')) && !drop.has(String(x?.messageId ?? '')));
    const removed = list.length - kept.length;
    if (removed) {
      if (kept.length) this.#lateDescribes.set(sessionKey, kept);
      else this.#lateDescribes.delete(sessionKey);
    }
    return removed;
  }

  /**
   * 回合开始前等本批的识图（`m24484`，用户定案：按 A 做，默认 4 秒、可配置）。
   *
   * 为什么必须在这里等：`snapshot()` 读的是**读取那一刻**的 `entry.text`，而描述回来时
   * 是就地改写它（`hub.#enrichImages`）——所以只要在 snapshot 之前等到，prompt 里就是描述而不是占位。
   *
   * 三条边界：①`vision.waitBeforeTurnMs` 为 0 ＝关闭，行为回到"不等"；②hub 没这个能力
   * （测试里的假 hub）就跳过；③等完只在真的等了东西时记一笔日志，别每轮都吵。
   */
  async #awaitVision(sessionKey, batchEntries = []) {
    const waitMs = Math.max(0, Number(this.hub?.config?.vision?.waitBeforeTurnMs ?? 0) || 0);
    /**
     * `segment` 模式要等的是**别的东西**（`m37401`，issue #2）。
     *
     * `waitBeforeTurnMs` 等的是"描述文本"；而 segment 要给模型喂的是**图本身**，图要下载、
     * 存 blob、回填 `entry.media`，比描述更早开始、也常常更晚结束。以前只等描述，于是 segment
     * 模式下快照永远拍在"图还没落地"的那一刻，`segmentPartsFor` 找不到 ref → 图从没进过 prompt。
     *
     * 现在两种都等，用同一个上限：segment 模式取 `segmentWaitMs`（默认 1500ms）与
     * `waitBeforeTurnMs` 的较大者；只开 describe 的话行为完全不变。
     */
    const segMode = (this.hub?.vision?.segmentEnabled ?? false) && (this.hub?.vision?.enabled ?? false);
    const segMs = segMode
      ? Math.max(waitMs, Math.max(0, Number(this.hub?.config?.vision?.segmentWaitMs ?? 1500) || 0))
      : 0;
    if (!waitMs && !segMs) return null;
    // **`refs.message_id` 才是 OneBot 的 message_id**（`hub.trackVision` 就是用这个键登记的）；
    // 条目顶层的 `id` 是枢纽自己的 `t_xxx`。以前读顶层 `message_id` 恒为空 → ids 恒空 →
    // `awaitVisionPending` 立即返回"没有在跑的"→ 这个"回合前等识图"从来没生效过。
    const ids = (Array.isArray(batchEntries) ? batchEntries : [])
      .map((e) => String(e?.refs?.message_id ?? e?.message_id ?? '').trim())
      .filter(Boolean);
    let media = null;
    if (segMs && typeof this.hub?.awaitMediaPending === 'function') {
      try {
        media = await this.hub.awaitMediaPending({ key: sessionKey, messageIds: ids, timeoutMs: segMs });
        if (media?.timedOut) {
          this.log?.(`看图：媒体没落地就开跑：${sessionKey} 等 ${media.waitedMs}ms，${media.timedOut} 条仍在落地`);
        }
      } catch (err) {
        this.log?.(`等媒体落地失败（不影响本轮）：${err?.message ?? err}`);
      }
    }
    if (!waitMs || typeof this.hub?.awaitVisionPending !== 'function') {
      return media?.count ? media : null;
    }
    let res = null;
    try {
      res = await this.hub.awaitVisionPending({ key: sessionKey, messageIds: ids, timeoutMs: waitMs });
    } catch (err) {
      this.log?.(`等识图失败（不影响本轮）：${err?.message ?? err}`);
      return null;
    }
    if (!res?.count) return null;
    this.stats.visionWaitTurns = (this.stats.visionWaitTurns ?? 0) + 1;
    if (res.timedOut) {
      this.log?.(`识图没等到就开跑：${sessionKey} 等 ${res.waitedMs}ms，${res.timedOut} 张仍在跑（下轮补描）`);
    }
    return res;
  }

  /** 取走即清：把晚到的描述拼成一块系统提示（`#batchText` 与插话消息共用，谁先带出去谁消费）。 */
  #takeLateDescribeLines(sessionKey) {
    const list = this.#lateDescribes.get(sessionKey);
    if (!list?.length) return null;
    this.#lateDescribes.delete(sessionKey);
    const lines = list.map((it) => `- ${mdhm(it.ts)} ${it.who}：${it.text}`);
    return `【图片补描 ${list.length} 条】之前你看到的 [图片]（当时还没描述出来）现在看清了，按说话人对上：\n${lines.join('\n')}`;
  }

  /**
   * 只读看一眼"这个会话还有没有待告知的发送失败"（**不消费**）。
   *
   * `#takeSendFailureNotice` 取走即清，外部（状态 / 测试）想观察就得有个不破坏语义的读口。
   */
  pendingSendFailureNotice(sessionKey) {
    const fail = this.#sendFailures.get(this.agentKeyOf(sessionKey)) ?? null;
    return fail ? this.#failureNotice(fail) : null;
  }

  /** 失败告知的正文：下一批开头（`#takeSendFailureNotice`）与"当场回执"共用，两处口径必须一样。 */
  #failureNotice(fail) {
    const detail = `status=${fail.status}${fail.retcode != null ? ` retcode=${fail.retcode}` : ''}${fail.error ? ` ${fail.error}` : ''}`;
    // 一次调用发多条时要说清"第几条没发出去、后面几条根本没发"（m32420）。
    const where = fail.of > 1 ? `第 ${fail.part}/${fail.of} 条没发出去${fail.rest ? `，后面 ${fail.rest} 条也因此没发` : ''}` : '回复没发出去';
    return `【系统提示】你上一轮排队的${where}（${detail}）：「${fail.text}」。别当成已经说过话——要么用 onebot_reply 重试，要么这轮就沉默。${fail.hint ? `\n${fail.hint}` : ''}`;
  }

  /** 修3 的一次性失败告知（取走即清）。主 flush 与插话消息共用，谁先带出去谁消费。 */
  #takeSendFailureNotice(sessionKey) {
    const fail = this.#sendFailures.get(this.agentKeyOf(sessionKey)) ?? null;
    if (!fail) return null;
    this.#sendFailures.delete(this.agentKeyOf(sessionKey));
    return this.#failureNotice(fail);
  }

  /**
   * 发送失败**当场**给模型一个回执（用户 `m25376` 定案）。
   *
   * 老行为是"存起来，等下一批/下一轮开头再告知"——可失败常常就是本轮的最后一件事：
   * 之后群里没人说话，那条告知就永远递不出去，模型一直以为自己说出口了。这里立刻排一次
   * **裸唤醒**（`reawake`：不带批次、不认新消息，正文就是这条回执），让它在几秒内看到失败
   * 并决定重试；这次唤醒里它调 `onebot_reply` 重发，走的是正常的投递路径。
   *
   * 三道闸：只读模式不发；`agent.replyOnSendFailure=false` 不发；同一会话在
   * `agent.sendFailureNudgeWindowMs` 窗口内最多 `agent.sendFailureNudgeMax` 次——
   * 否则"重试→又失败→又收到回执"会自己转圈（每次失败都是真的，但没必要一直重开回合）。
   * 撞到上限就退回老行为：下一批开头告知。
   */
  #nudgeSendFailure(sessionKey, fail) {
    if (this.readonly || !fail) return;
    const cfg = this.hub?.config ?? {};
    if (cfg.agentReplyOnSendFailure === false) return;
    // 这里调的是 **Mind 自己的** `reawake`（不是池子的），所以守卫看池子有没有 `wake`。
    if (typeof this.pool?.wake !== 'function') return;
    const cap = Math.max(0, Math.floor(Number(cfg.agentSendFailureNudgeMax ?? 2) || 0));
    const windowMs = Math.max(1000, Number(cfg.agentSendFailureNudgeWindowMs ?? 300000) || 300000);
    if (!cap) return;
    const key = this.agentKeyOf(sessionKey);
    const now = Date.now();
    const rec = this.#sendFailureNudge.get(key) ?? null;
    const fresh = !rec || now - rec.since > windowMs;
    // 先记账再排队：两次失败挨得很近时，先记才能挡住"两个都以为自己是第一次"。
    // 但**排不上要回滚**——否则额度会被白吃（`reawake` 可能因为池子忙/宿主没就绪而 woke:false，
    // 那时这条回执根本没送达，下一次失败理应还能再试）。
    const prev = rec ? { ...rec } : null;
    if (fresh) this.#sendFailureNudge.set(key, { count: 1, since: now });
    else if (rec.count >= cap) {
      this.log(`发送失败回执已达上限（${cap} 次/${Math.round(windowMs / 1000)}s）：${sessionKey} 不再自动开一轮，改由下一批开头告知`);
      return;
    } else this.#sendFailureNudge.set(key, { ...rec, count: rec.count + 1 });
    const notice = this.#failureNotice(fail);
    // 不 await：这条回执本来就排在本轮**之后**（`reawake` 会先等当前回合落定），
    // 在这儿 await 会死锁在自己身上。
    void Promise.resolve()
      .then(() => this.reawake(sessionKey, { reason: 'send-failed', text: notice, summary: '发送失败' }))
      .then((res) => {
        if (!res?.woke) {
          // 没排上：把额度还回去，并且**别动**待告知条目（下一批开头照旧会念）。
          if (prev) this.#sendFailureNudge.set(key, prev);
          else this.#sendFailureNudge.delete(key);
          this.log(`发送失败回执没排上 ${sessionKey}（${res?.reason ?? 'unknown'}），改由下一批开头告知`);
          return;
        }
        // 已经当场告诉它了，别让下一批再念一遍同一条。
        // **要比对象**：这期间若又失败了一次，待告知条目已经被换成新的那条，删掉就等于把它也吞了。
        if (this.#sendFailures.get(key) === fail) this.#sendFailures.delete(key);
        this.stats.sendFailureNudges = (this.stats.sendFailureNudges ?? 0) + 1;
      })
      .catch((err) => {
        if (prev) this.#sendFailureNudge.set(key, prev);
        else this.#sendFailureNudge.delete(key);
        this.log(`发送失败回执没排上 ${sessionKey}: ${err?.message ?? err}`);
      });
  }

  /** 插话消息的正文：与 `#batchText` 同一套渲染，只换头（【插话 N 条】）且不带开局快照（本段已给过）。 */
  #steerMessage(sessionKey, batchEntries = []) {
    const head = `【插话 ${batchEntries.length} 条】会话 ${sessionKey}｜现在 ${stampNow()}`;
    const fail = this.#takeSendFailureNotice(sessionKey);
    const parts = [];
    if (fail) parts.push(fail);
    parts.push(head, ...this.#batchLines(sessionKey, batchEntries));
    const late = this.#takeLateDescribeLines(sessionKey);
    if (late) parts.push(late);
    return parts.join('\n');
  }

  /**
   * 开局快照（v4，`m24409` 用户定案）：**每段会话的第一批**带一份"这段开始之前发生过什么"。
   *
   * 为什么需要：交还转录后每次激活都是新会话（`#retireAfterDormant`），系统提示里又不再有
   * 会话卡/最近窗口（v4 把它们移出了快照）——没有这份快照，模型对"上一段聊到哪了"一无所知。
   * 为什么只给一次：它是状态不是事件，第二批再给就是重复注入（用户要解决的正是这个问题）。
   * 为什么只放"本批之前"：本批消息马上会以【新消息 N 条】出现，两处都有就是同一条话注入两遍。
   * @param force 调用方已经确认这确实是**新会话**（预设换装那次激活）：先把"已给过"的账清掉。
   *   不给这个力，新会话的第一批会被**旧会话**留下的账挡住（`#openingPresented` 按 sessionKey
   *   记账，只有 `#retireAfterDormant` 会清，而换装走的是 `applyPresetSwitch` 自己的 retire）——
   *   于是整段新会话一次快照都没有，模型对"这段之前聊到哪"一无所知（真机事故，m12385）。
   */
  #openingText(sessionKey, batchEntries = [], snapshot = null, { force = false } = {}) {
    if (force) this.#openingPresented.delete(sessionKey);
    if (this.#openingPresented.has(sessionKey)) return '';
    this.#openingPresented.add(sessionKey);
    const events = snapshot?.events ?? [];
    // 去重两道：①按时间线 id（本批条目就是时间线条目；下游批次条目带 `refs.timelineId`）；
    // ②按归一化正文兜底（测试钩子/老路径没给 id 时，同文同归一也算同一条）。
    const presentedIds = new Set();
    const presentedTexts = new Set();
    const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    // 本批条目的正文取真身（`m26571`）：去重要跟"渲染时读到的那份"对齐——
    // 否则描述晚到一步时，本批是 `[图片]`、卡里是 `[图片：描述]`，文本去重失配，同一条进两遍。
    const bodyOf = (b) => (b?.live && typeof b.live.text === 'string' && b.live.text ? b.live.text : b?.text);
    for (const b of batchEntries) {
      if (b?.id != null && b.id !== '') presentedIds.add(String(b.id));
      const tid = b?.refs?.timelineId;
      if (tid != null && tid !== '') presentedIds.add(String(tid));
      const t = norm(bodyOf(b));
      if (t) presentedTexts.add(t);
    }
    const before = events.filter((e) => e && !presentedIds.has(String(e?.id ?? '')) && !presentedTexts.has(norm(e?.text)));
    const window = renderWindow(before, { selfId: this.selfId });
    const digest = snapshot?.digest ?? null;
    if (!window) {
      /**
       * 重启后的第一批：环里"本批之前"是空的（L1 只追加、不回放），但落盘的那张会话卡
       * 还记着重启前聊到哪——它就是这份快照要交代的"这段之前的事"。按本批正文滤一遍，
       * 免得马上要以【新消息】出现的那条又被卡说一次。
       */
      const stored = digest?.resumed ? digest : (this.hub?.cards?.digestFor?.(sessionKey) ?? null);
      // 两道过滤：正文（老卡没记 id 时的兜底）**和 id**（`m26571`——会话卡行带
      // `line.id`= 时间线 id，本批条目带 `refs.timelineId`，两边能对上；只比正文的话，
      // 「快照写的是 `↩回复「…」[图片：描述]（已存为 hub-media:…）」、「本批写的是 `[回复][图片]`」
      // 永不相等，同一条话会在快照和新消息里各出现一次）。
      const oldLines = (stored?.lines ?? []).filter((l) => (
        (l?.id != null && l.id !== '' ? !presentedIds.has(String(l.id)) : true)
        && !presentedTexts.has(norm(l?.text))
        // 存量卡里的空行（旧版本把提不出文本的下游动作也记了行）不进快照。
        && String(l?.text ?? '').trim() !== ''
      ));
      if (!oldLines.length) return '';
      const out = [`【开局快照】本段开始之前的事${stored?.resumed ? '（含重启前的旧事，不是刚刚）' : ''}`];
      out.push('最近：', ...oldLines.map((l) => {
        const who = l?.direction === 'hub-out' ? '我' : String(l?.actor ?? '某人');
        // 与 `#batchLines` 同一套单行化（`m08997`）：换行留成 ` ⏎ `。
        // 以前这里 `replace(/\s+/g,' ')` 把换行吃掉了，于是模型开头那条发出去时
        // 一行一个【分组】的工具清单，在快照里挤成一条 200 多字的单行。
        return `- ${mdhm(l?.ts)} ${who}：${flatBreaks(l?.text)}`;
      }));
      if (stored?.resumed) out.push('（这些是本段开始之前说的，不是刚刚。）');
      return out.join('\n');
    }
    const people = (digest?.participants ?? []).slice(0, 8).map((p) => {
      const name = displayActor(p);
      const badge = p.role && p.role !== 'member' ? `/${p.role}` : '';
      return `${name}${badge}(${p.count})`;
    });
    const head = `【开局快照】本段开始之前的事${digest?.resumed ? '（含重启前的旧事，不是刚刚）' : ''}`;
    const out = [head];
    if (people.length) out.push(`参与者：${people.join('、')}`);
    out.push(window);
    return out.join('\n');
  }

  /**
   * 看图（M14-V）的第二种手段：会话代理自己看得见，就把图片本体作为内容段给它。
   * 只在 `vision.mode` 含 `segment`、且模型确实声明了图片输入能力时才给——宿主客户端
   * 对不支持的模型会直接抛 `does not support image input`，那一轮就白跑了。
   */
  async segmentPartsFor(events = []) {
    const vision = this.hub?.vision;
    if (!vision?.segmentEnabled || !vision.enabled) {
      vision?.noteSkip?.('mode', `mode=${vision?.mode ?? 'off'}`);
      return null;
    }
    const refs = [];
    for (let i = events.length - 1; i >= 0 && refs.length === 0; i -= 1) {
      // 内存里的时间线条目带 `entry.media`（对象数组，落地完成后才写）；落盘的 L1 行只有
      // `refs.media`/`mediaRefs`（id 字符串），那是索引层的形状，不是这里的数据源。
      for (const ref of events[i]?.media ?? []) if (ref?.kind === 'image') refs.push(ref);
    }
    if (!refs.length) {
      // 走到这儿通常是"图还没落地就被拍进快照了"——`#awaitVision` 会先等一次落地。
      vision.noteSkip?.('no-media', `events=${events.length}`);
      return null;
    }
    if (!(await vision.imageCapable())) {
      vision.noteSkip?.('capability', `${vision.provider || '(默认)'}/${vision.model || '(默认)'}`);
      this.hub?.log?.(`看图：模型 ${vision.provider || '(默认)'}/${vision.model || '(默认)'} 不支持图片输入，本轮只用文本`);
      return null;
    }
    const parts = vision.segmentParts(refs);
    if (!parts.length) {
      vision.noteSkip?.('empty', `refs=${refs.length}`);
      return null;
    }
    vision.noteSkip?.('none');
    return parts;
  }

  /**
   * 插话（m31311 用户定案，宿主原语 `steer`/next-step）：回合在飞时把积压直接递进去。
   *
   * **结算只归主 flush**：steer 成功后 `whenIdle()` 覆盖插话延长的回合，主 flush 的
   * `await whenIdle()` 与这里的 waiter 等到同一个空闲点——回复缓冲的 take/deliver、
   * 发言结算（`#noteSpokeOutcome`）都由主 flush 一次做完；插话路径只递消息，不碰
   * 回复缓冲/账本/轮次序号，避免双计"沉默轮"把激活误打回休眠。
   *
   * 静默闸与主 flush 同口径（被叫到的那批不受它管）；steer 失败/会话不在飞一律回落
   * 普通排队（返回 `batch:in-flight`，消息留在窗口里，等下一次触发正常结算）。
   *
   * **多批**（m08218 用户定案）：一个回合里可以插**多次**——闸门是每批次一次，批次自身就是
   * 节流器（一批最多 `batchMs` 一次）；同一批不会被插两次，因为 `batch.flush()` 与递送同步完成。
   */
  async #trySteer(sessionKey, { reason } = {}) {
    if (this.readonly) return { woke: false, reason: 'batch:in-flight' };
    if (this.hub?.config && this.hub.config.agentSteer === false) return { woke: false, reason: 'batch:in-flight' };
    // 这里**不再**拦"已有插话在飞"（m08218 用户定案）：闸门是每批次一次，不是每回合一次。
    // 同一批不会被插两次——`pool.steer()` 成功后同步 `batch.flush()`（下面那行，中间没有 await）。
    const batch = this.#batches.get(sessionKey);
    if (!batch || !batch.count) return { woke: false, reason: 'batch:empty' };
    if (typeof this.pool?.steer !== 'function') return { woke: false, reason: 'batch:in-flight' };
    const peeked = [...batch.entries];
    const calledNow = this.#calledIn(peeked, sessionKey);
    if (!calledNow && this.policy.silenceWhenDownstreamResponded && this.isDownstreamResponded(sessionKey, this.#silenceSince(batch))) {
      // 不插也不排水：留给下一轮正常 flush 结算（那边会 stats.silent+1 并照常轮转窗口）。
      return { woke: false, reason: 'silent:downstream-responded' };
    }
    const wait = this.pool.steer(this.agentKeyOf(sessionKey), {
      text: this.#steerMessage(sessionKey, peeked),
      summary: `插话 ${peeked.length} 条`,
    });
    if (!wait) return { woke: false, reason: 'batch:in-flight' };
    batch.flush(); // 已递给宿主才排水；不在飞/失败时消息留在窗口，不丢
    const task = (async () => {
      this.stats.steered += peeked.length;
      this.stats.lastSteer = { at: Date.now(), sessionKey, reason: reason ?? null, count: peeked.length };
      this.log(`会话 ${sessionKey} 插话 ${peeked.length} 条（${reason ?? 'manual'}）`);
      await wait();
    })();
    const inFlight = this.#steering.get(sessionKey) ?? new Set();
    inFlight.add(task);
    this.#steering.set(sessionKey, inFlight);
    try {
      await task;
    } catch (err) {
      this.stats.errors += 1;
      this.log(`插话等待失败 ${sessionKey}: ${err?.message ?? err}`);
    } finally {
      inFlight.delete(task);
      if (!inFlight.size) this.#steering.delete(sessionKey);
    }
    return { woke: true, reason: `steer:${reason ?? 'manual'}`, steered: peeked.length };
  }

  /**
   * 真正唤醒一轮。
   * @returns {Promise<{woke:boolean, reason:string, reply?:string, context?:object}>}
   */
  async flush(sessionKey, { reason = 'manual', actorId, budget } = {}) {
    const batch = this.#batches.get(sessionKey);
    if (!batch || !batch.count) return { woke: false, reason: 'batch:empty' };
    // 回合在飞（m31311 用户定案）：不再排队等下一轮，把积压**插话**进正在跑的回合；
    // 不在飞/不支持/插话中 → 维持原语义（`batch:in-flight`，消息留窗，等下一次触发）。
    if (this.#flushing.has(sessionKey)) return this.#trySteer(sessionKey, { reason });

    const openedAt = batch.openedAt ?? 0;
    // 工具是在"某一轮"里被调用的：这轮里没有显式给 sessionKey 的调用（onebot_memory 等）
    // 都要落回同一个会话，否则模型会往别的会话的记忆里写东西。
    this.activeSessionKey = sessionKey;
    if (actorId) this.activeActorId = String(actorId);
    /**
     * 轮次序号：只在内存里递增，用来给"每轮限额"这类工具当作用域
     * （`imageGen.maxPerTurn`）。它不需要跨进程稳定——限额只管这一轮。
     */
    this.turnSeq = (this.turnSeq ?? 0) + 1;
    const task = (async () => {
      const batchEntries = batch.flush();
      // 只读：批次照收照丢，但绝不往下走（不装配、不叫模型、不发消息）。
      // 放在 `batch.flush()` 之后是为了让批量窗口正常轮转，不留下永远不结算的窗口。
      if (this.readonly) {
        this.stats.readonly += 1;
        return { woke: false, reason: 'readonly' };
      }
      const calledNow = this.#calledIn(batchEntries, sessionKey);
      /**
       * 额度闸门（第二期，m13831）：用尽 → 退成 observer。
       *
       * 放在静默闸**之前**：静默闸是"隔壁 bot 刚回过、我不插话"的省电策略，额度是"再跑就是白烧钱"的
       * 硬闸——省电的时候可以不烧，烧超了就必须停，谁都不许放行。恢复后第一轮会自动补上
       * 这期间攒的原话（`#takeQuotaCatchUp`）。
       */
      const quotaVerdict = await this.#quotaVerdict(sessionKey, batchEntries, { calledNow });
      if (quotaVerdict.blocked) {
        // "只存不发"是 observer 的定义：不装配、不叫模型、不发言。
        // **这段时间不再写记忆条目**（`m16530`）：以前这里补的是身份观测（`buildObservedEntries`），
        // 而身份观测现在只进人物档案、不进记忆库（见 design-notes §9）。原始消息仍在 L1 时间线里，
        // 恢复后窗口重放照旧带着它们——"群里的事被抹掉"这件事从来没靠这条路径兜住过。
        return {
          woke: false,
          reason: 'quota:exhausted',
          scope: quotaVerdict.scope,
          held: batchEntries.length,
        };
      }
      /**
       * 静默闸（真机事故 #10）：① **被叫到的那一批不受它管**——人家点名找我，
       * 隔壁 bot 刚回过别人一句不是我装死的理由；② 回看起点取
       * `#silenceSince()`（窗口开启时间与最近一个 batchMs 里更晚的那个），
       * 免得休眠期那个永不 flush 的旧窗口把会话永久压死。
       */
      if (!calledNow && this.policy.silenceWhenDownstreamResponded && this.isDownstreamResponded(sessionKey, this.#silenceSince({ openedAt }))) {
        this.stats.silent += 1;
        return { woke: false, reason: 'silent:downstream-responded' };
      }

      // 识图还没回来就先等一等（`m24484`）：图片消息进窗口时正文只能是「还在看」，
      // 描述要一两秒。不等就会出现"图刚发、模型立刻说我看不到"。
      // 放在三道闸**之后**——这轮本来就不发言的话，一毫秒都不该为图多等。
      await this.#awaitVision(sessionKey, batchEntries);

      const snapshot = this.snapshot(sessionKey, { actorId, budget });

      if (!this.pool) {
        return { woke: false, reason: 'dry-run', context: { text: snapshot.text, sections: describeSections(snapshot.sections) } };
      }

      const agentKey = this.agentKeyOf(sessionKey);
      /**
       * 回复缓冲**每个 agent 一份、跨轮复用**（真机事故修正）。
       *
       * 会话级的 `onebot_reply` 工具是 `setup` 时注册的，而 `pool.ensure()` 只在会话**首次**
       * 建立时跑 setup——后来每一轮 `resume` 都不会再注册一次。早先这里每轮 `new ReplyBuffer()`，
       * 于是"模型调了工具、工具写进了第一轮那个缓冲、我这边却在读新缓冲"：候选永远为空，
       * 兜底逻辑转而把 assistant 的收尾文本当成发言发出去（线上真发出过「（已回：…）」这种旁白）。
       * 复用的代价只是要在开轮前 clear 一次，别把上一轮没取走的候选混进来。
       */
      const reply = this.#replyFor(agentKey);
      reply.clear();
      this.#feed.set(agentKey, this.#newFeed(agentKey)); // 本轮重新开账，避免读到上一轮的话
      // 开轮＝上下文解冻：这一轮里模型改记忆也不会把整份上下文重复塞进转录（`#liveCache`）。
      this.invalidateLiveContext(sessionKey);
      const summary = `会话 ${sessionKey} 有新消息（${snapshot.digest.messageCount} 条）`;
      const parts = await this.segmentPartsFor(snapshot.events);
      /**
       * 用户消息**只放本批新消息**（用户定案）：易变上下文已经由 `liveContext()` 走 system prompt
       * 现算了，再往这里塞一份就是重复——而且会滞留在转录里，让旧上下文排到"最近窗口"前面。
       * 每段会话的第一批额外带开局快照（本批**之前**发生的事，只给一次，v4）。
       *
       * 换装会发生在这后面的 `pool.wake` 里（预设代理在 wake 开头才判形态），而这里必须先把
       * 文本拼好——所以要提前问一句"这次唤醒会不会跑在新会话上"（`presetSwapPlan(...).freshSession`）。
       * 不问的话，回程切档换出来的那段会话拿到的是**空转录且没有开局快照**，模型既不知道这段之前
       * 聊到哪、也接不上旧会话里答应过的话（真机 m12699：切 default 后第一条消息就把会话弹回
       * 精简，且那一段没有快照）。裸激活（`reawake`）那条路同理，见调用方传的 `snapshot`。
       */
      const swapPlan = this.pool?.presetSwapPlan?.(agentKey) ?? null;
      const opening = this.#openingText(sessionKey, batchEntries, snapshot, { force: Boolean(swapPlan?.freshSession) });
      // 用尽期间攒的原话（恢复后**仅此一次**）：放在本批新消息**之前**——它们是背景，不是现在的请求。
      const catchUp = this.#takeQuotaCatchUp(sessionKey);
      const result = await this.pool.wake(agentKey, {
        realTurn: true, // 自有标记：预设代理据此判断"这次是真实激活"（兑现全量窗口），转发前抹掉
        text: this.#batchText(sessionKey, batchEntries, [catchUp, opening].filter(Boolean).join('\n\n')),
        summary,
        parts,
        setup: this.setup ? (agentCtx) => this.setup(agentCtx, { reply, mind: this, sessionKey, agentKey }) : undefined,
      });
      // 唤醒本身失败（例如宿主报 "session already exists"）不能算"叫醒过"，要单独计数，
      // 否则线上看到 woken 在涨、却一条消息都没回，会误判成"模型不愿说话"。
      const ok = result?.ok !== false;
      if (ok) this.stats.woken += 1;
      else this.stats.errors += 1;
      // 再进 prompt 要等 24 小时（§24.6 的防骚扰安全阀）。只在**真的交给模型之后**记账：
      // 唤醒失败不算提过，否则一次宿主抖动就能让这条承诺沉默一整天。
      if (ok && snapshot.cues?.length) this.hub?.reminders?.note(snapshot.cues);
      // 「待结算」那一行同理：真的交给模型之后才记账，否则看一眼上下文就把当天的额度用掉了。
      if (ok && snapshot.active?.settleKey) this.hub?.reminders?.note([{ key: snapshot.active.settleKey }]);

      const candidate0 = reply.take();
      const feed = this.#feed.get(agentKey) ?? null;
      let candidate = candidate0;
      let spokeFrom = candidate ? 'tool' : 'none';
      // 文本兜底**默认关**（m30383 用户定案：发言只走 onebot_reply 工具，回复文本只是内部草稿，
      // 收尾旁白从此没有进群的路）。`agent.speakAssistantText=true` 是逃生门，恢复"文本=发言"的
      // 老行为；逃生门下"不想说话"仍用整句括号旁白表达（isSilentMarker）。
      if (!candidate && ok && this.policy.speakAssistantText === true && feed?.assistantText) {
        const text = String(feed.assistantText).trim();
        if (text && !isSilentMarker(text)) {
          candidate = reply.capture({ text });
          spokeFrom = 'assistant-text';
        }
      }
      const delivered = candidate ? await this.deliver(sessionKey, candidate) : null;
      /**
       * 唤醒状态机记一笔：这一轮到底开口没有。
       * 连续 `AWAKE_SILENT_TURNS` 轮不说话 → 回休眠（用户定的"agent 认为无需回复就回休眠"）。
       * 记账点选在"候选已定、投递已发"之后：只有真正有话说才续命，被上游拒收也算说过话
       * （它确实开了口，不该因为发送失败就当成沉默）。
       */
      const wakeState = this.#noteSpokeOutcome(sessionKey, Boolean(candidate));
      /**
       * 这一轮到此为止——**回合结束也算一次"动静"**（m34646 用户定案："agent 回复完后等待
       * awakeMs 再休眠"）。记在结算处而不是 `#enterAwake`：额度该从"说完"重新算，
       * 否则一个长回合 + `active` 节拍的延迟就把 `awakeMs` 提前烧光，回完话立刻睡回去。
       */
      if (wakeState) wakeState.lastTurnAt = Date.now();
      // 留一条"最近一轮"诊断：真宿主的会话文件要等关闭才落盘，光看 sent=0 分不清
      // 「模型没调 onebot_reply」还是「唤醒本身失败了」，所以把这几件事分开记。
      this.stats.lastTurn = {
        sessionKey,
        at: Date.now(),
        reason,
        ok,
        error: ok ? null : (result?.error ?? 'unknown'),
        hadReply: Boolean(candidate),
        spokeFrom,
        // 这一轮结束时这个会话的睡/醒状态（连续沉默会把激活打回休眠）。
        wakeState: wakeState?.state ?? null,
        silentTurns: wakeState?.silentTurns ?? null,
        // 唤醒前摘掉归档门控的结果（`archived:true` 说明这一轮原本会以 blocked 结束）。
        unarchive: result?.unarchive ?? null,
        reply: candidate ? describeReply(candidate) : null,
        sent: Boolean(delivered?.sentCount > 0),
        sentCount: delivered?.sentCount ?? 0,
        totalMessages: delivered?.total ?? 0,
        failedAt: delivered?.failedAt ?? null,
        retcode: delivered?.retcode ?? null,
        diag: feed
          ? {
              turn: feed.turn,
              turnEnd: feed.turnEnd,
              turnError: feed.turnError,
              interrupted: feed.interrupted,
              assistantText: truncate(feed.assistantText, 200),
              toolCalls: feed.toolCalls,
              toolResults: feed.toolResults,
            }
          : null,
      };
      return {
        woke: ok,
        reason,
        agentKey,
        reply: describeReply(candidate),
        delivered,
        sections: describeSections(snapshot.sections),
        result,
        wakeState: wakeState?.state ?? null,
      };
    })();

    this.#flushing.set(sessionKey, task);
    try {
      return await task;
    } catch (err) {
      this.stats.errors += 1;
      return { woke: false, reason: 'error', error: String(err?.message ?? err) };
    } finally {
      this.#flushing.delete(sessionKey);
    }
  }

  /**
   * 换装后的**裸唤醒**（m04972 定案③"立刻生效"）：onebot_tools 点名换预设后，从工具调用里
   * 排一个激活，把新工具面送进去——不等下一次自然唤醒。与 `flush` 的区别：
   * - 不碰批次（没有新消息要带，`text` 就是调用方给的一句话）、不走静默闸（这次激活是 hub
   *   自己点名的，不是在"回应群消息"）；
   * - 换预设必须重开会话，插话进旧回合没有意义，所以**不做 #trySteer**；
   * - 调用方（onebot_tools）就在当前回合里：这里只**等当前回合落定**（不嵌套 await 它——
   *   那会死锁在回合内），再通过池子的 agentKey 串行排队执行；#flushing 的占位也等到那时
   *   才挂上，免得把在飞回合的条目顶掉。
   * @param snapshot 调用方判定"这次唤醒会换出一段**新会话**"时为 true：换装必开开局快照。
   *   传 false/省略时自己问池子的 `presetSwapPlan(agentKey).freshSession`，所以不传也不会漏。
   *   换预设＝新会话，转录是空的，只递一句"预设刚切换"的话，模型既不知道这段之前聊到哪，
   *   也接不上旧会话里已经答应过的事——真机上它判"本轮无新对话内容"就沉默了（m12385）。
   *   同会话的重复唤醒（已是目标形态）判定为 false，否则旧形态的快照会在同一段转录里再递一遍。
   * @returns {Promise<{woke:boolean, reason:string, agentKey?:string, reply?:object, error?:string}>}
   */
  async reawake(sessionKey, { reason = 'preset-switch', text = '', summary = '预设切换', snapshot = false } = {}) {
    if (this.readonly) return { woke: false, reason: 'readonly' };
    if (!this.pool) return { woke: false, reason: 'dry-run' };
    const pending = this.#flushing.get(sessionKey) ?? null; // 多半是调用方所在的当前回合
    const task = (async () => {
      await Promise.resolve(); // 先让出同步段：IIFE 同步跑到底会撞上 `const task` 自己的 TDZ
      if (pending) {
        try {
          await pending;
        } catch {
          /* 上一轮失败不影响排队 */
        }
      }
      this.#flushing.set(sessionKey, task);
      try {
        const agentKey = this.agentKeyOf(sessionKey);
        this.activeSessionKey = sessionKey;
        this.turnSeq = (this.turnSeq ?? 0) + 1;
        const reply = this.#replyFor(agentKey);
        reply.clear();
        this.#feed.set(agentKey, this.#newFeed(agentKey)); // 本轮重新开账，避免读到上一轮的话
        this.invalidateLiveContext(sessionKey); // 换预设＝新会话新回合，同样解冻
        // 开局快照：这次唤醒换出的是新会话（调用方按账本判定过），转录是空的，所以快照由**这次**
        // 激活递，而不是等下一次自然批次——那样等来的新会话同样没快照。调用方没给 `snapshot`
        // 就自己问一次账本（`presetSwapPlan(...).freshSession`），免得换装判断抄两份抄漏（m12699）。
        // `force` 清掉旧会话留下的"已给过"账；递过之后自然批次自然不会再递（每段一次）。
        const willSwap = this.pool?.presetSwapPlan?.(agentKey)?.freshSession === true;
        const opening =
          snapshot || willSwap ? this.#openingText(sessionKey, [], this.snapshot(sessionKey), { force: true }) : '';
        const result = await this.pool.wake(agentKey, {
          text: [opening, String(text ?? '').trim()].filter(Boolean).join('\n\n'),
          summary,
          parts: [],
          setup: this.setup ? (agentCtx) => this.setup(agentCtx, { reply, mind: this, sessionKey, agentKey }) : undefined,
        });
        const ok = result?.ok !== false;
        if (ok) this.stats.woken += 1;
        else this.stats.errors += 1;
        const candidate0 = reply.take();
        const feed = this.#feed.get(agentKey) ?? null;
        let candidate = candidate0;
        let spokeFrom = candidate ? 'tool' : 'none';
        // 文本兜底与 flush 同规矩（默认关，`agent.speakAssistantText=true` 逃生门）。
        if (!candidate && ok && this.policy.speakAssistantText === true && feed?.assistantText) {
          const said = String(feed.assistantText).trim();
          if (said && !isSilentMarker(said)) {
            candidate = reply.capture({ text: said });
            spokeFrom = 'assistant-text';
          }
        }
        const delivered = candidate ? await this.deliver(sessionKey, candidate) : null;
        const wakeState = this.#noteSpokeOutcome(sessionKey, Boolean(candidate));
        if (wakeState) wakeState.lastTurnAt = Date.now();
        this.stats.lastTurn = {
          sessionKey,
          at: Date.now(),
          reason,
          ok,
          error: ok ? null : (result?.error ?? 'unknown'),
          hadReply: Boolean(candidate),
          spokeFrom,
          wakeState: wakeState?.state ?? null,
          silentTurns: wakeState?.silentTurns ?? null,
          unarchive: result?.unarchive ?? null,
          reply: candidate ? describeReply(candidate) : null,
          sent: Boolean(delivered?.sentCount > 0),
          sentCount: delivered?.sentCount ?? 0,
          totalMessages: delivered?.total ?? 0,
          failedAt: delivered?.failedAt ?? null,
          retcode: delivered?.retcode ?? null,
          diag: null,
        };
        return { woke: ok, reason, agentKey, reply: describeReply(candidate), delivered, result };
      } finally {
        if (this.#flushing.get(sessionKey) === task) this.#flushing.delete(sessionKey);
      }
    })();
    try {
      return await task;
    } catch (err) {
      this.stats.errors += 1;
      return { woke: false, reason: 'error', error: String(err?.message ?? err) };
    }
  }

  /**
   * 把候选回复发给上游（OneBot `send_msg`）——**一次调用可能有多条消息**（m32420）。
   *
   * 三条规矩（都是用户定的）：
   *  1. 条与条之间有固定间隔（`agent.replyGapMs`，默认 400ms）——连发太快不像人在打字。
   *  2. **第 k 条失败即停**，剩下不发。失败必须让模型知道（下一批开头告知），
   *     否则它会以为整段话说完了（修3 的老事故：`failed -1935986436` 后 agent 仍以为说出口了）。
   *  3. 只读预设**一个字节都不发**——"绝不动作"这种承诺不该只靠上游调用点的自觉。
   */
  async deliver(sessionKey, candidate) {
    if (this.readonly) {
      this.stats.readonly += 1;
      this.log(`只读预设：放弃发送（${sessionKey}）`);
      return null;
    }
    const messages = Array.isArray(candidate?.messages) && candidate.messages.length
      ? candidate.messages
      : [{ segments: candidate?.segments ?? [], text: candidate?.text ?? '', kind: 'text' }];
    const gapMs = Math.max(0, Number(this.hub?.config?.replyGapMs ?? 400) || 0);
    const results = [];
    for (const [i, msg] of messages.entries()) {
      if (i > 0 && gapMs > 0) await sleep(gapMs);
      const { action, params } = buildSendParams({
        segments: msg.segments,
        sessionKey,
        messageType: candidate.messageType,
        groupId: candidate.groupId,
        userId: candidate.userId,
      });
      let response = null;
      if (this.hub?.callUpstream) {
        response = await this.hub.callUpstream(action, params);
      }
      const status = response?.status ?? 'no-hub';
      const ok = !this.hub?.callUpstream || status === 'ok';
      /**
       * 只有图片/语音/表情包这类消息的 `text` 是空的，记进时间线就是一行空白——
       * 会话卡与最近窗口都会把它滤掉（`m26901`）。所以这里先给占位符，再把**编号**
       * 一起写进去：`我：[图片]〔t_k3x8a91〕`。编号得自己先领，写进去之后才拿得到。
       */
      const said = String(msg.text ?? '');
      const label = said.trim() ? '' : carrierLabel(msg);
      const minted = label && typeof this.timeline?.mintId === 'function' ? this.timeline.mintId() : null;
      const logged = label ? `${label}${minted ? `〔${minted}〕` : ''}` : said;
      this.timeline?.record?.({
        ...(minted ? { id: minted } : {}),
        direction: 'hub-out',
        linkId: this.hub?.upstreamLinkId ?? 'hub',
        selfId: this.selfId,
        action,
        params,
        decision: status === 'failed' ? 'failed' : 'sent',
        text: logged,
        refs: { sessionKey, part: i + 1, of: messages.length, ...(label ? { carrier: true } : {}) },
      });
      if (ok) this.stats.sent += 1;
      this.lastActedAt = Date.now();
      results.push({ index: i + 1, kind: msg.kind, text: msg.text, status, ok, retcode: response?.retcode ?? null });
      if (!ok) {
        // 修3 的告知升级成"第几条没发出去、后面几条没发"：模型才知道该重试多少。
        const rest = messages.length - i - 1;
        const fail = {
          text: truncate(candidate.text ?? '', 120),
          status,
          retcode: response?.retcode ?? null,
          error: response?.error ?? response?.message ?? response?.msg ?? null,
          at: Date.now(),
          part: i + 1,
          of: messages.length,
          rest,
          // 语音失败的原因几乎永远是"实现端不吃这个格式/不支持发语音"，而 retcode 里看不出来
          // （`m28823`：模型只能看到 1200 之类）。所以只对这种段补一句指路，别的段不加。
          ...(msg.segments.some((s) => String(s?.type ?? '').toLowerCase() === 'record')
            ? {
                hint:
                  '这一条是语音（record 段）：实现端多半只吃 silk/amr，或干脆不支持发语音。' +
                  '可用 `onebot_caps`（或 onebot_call 的 can_send_record）确认，再决定换格式还是别发。',
              }
            : {}),
        };
        this.#sendFailures.set(this.agentKeyOf(sessionKey), fail);
        // **当场**把回执递回去（`m25376`）：失败往往就是本轮的最后一件事，等"下一批"
        // 可能永远等不到（群里没人再说话），模型就一直以为自己说出口了。
        this.#nudgeSendFailure(sessionKey, fail);
        break;
      }
    }
    const first = results[0] ?? { action: 'send_msg', status: 'no-hub', retcode: null };
    const failedAt = results.findIndex((r) => !r.ok);
    return {
      action: 'send_msg',
      params: messages[0] ? buildSendParams({
        segments: messages[0].segments,
        sessionKey,
        messageType: candidate.messageType,
        groupId: candidate.groupId,
        userId: candidate.userId,
      }).params : null,
      status: failedAt >= 0 ? 'failed' : first.status,
      retcode: first.retcode ?? null,
      sentCount: results.filter((r) => r.ok).length,
      total: messages.length,
      failedAt: failedAt >= 0 ? failedAt + 1 : null,
      results,
    };
  }

  /**
   * 定时器每 `agent.tickMs` 调一次：决定"现在该不该醒"。
   *
   * 两种时机（`m01733` 的规格）：
   *   · **激活中**：批量窗口攒够条数/到期 → 再唤醒一次（`batch:full` / `batch:timeout`）。
   *   · **休眠 + `active` 档**：每 `activeTickMs` 看一眼该会话有没有新消息（窗口里有东西就是有），
   *     有就唤醒一次并进激活（`tick:active`）；没有就什么都不做，等下一次。
   *     `assist` 的休眠会话**不靠节拍**——只有被叫到才醒。
   */
  async scanDue(now = Date.now()) {
    const due = [];
    for (const [sessionKey, batch] of this.#batches) {
      // 白名单自愈（m31030）：不该存在的批直接丢掉（配置改过/测试注入残留），别让它等着叫人。
      if (sessionOverrideOf(sessionKey, this.hub?.config) === null) {
        this.#batches.delete(sessionKey);
        continue;
      }
      if (!batch.count) continue;
      const st = this.#wakeStateFor(sessionKey, now);
      /**
       * 下游本轮已应答 → 硬静默（激活与否都不说话）。回看起点走 `#silenceSince()`：
       * 休眠窗口可能几十分钟没 flush，用它的 `openedAt` 当判据会把会话永久压死（事故 #10）。
       * 批里有 @ 我 / 私聊的那种"被叫到"不在节拍路径上（那走 `observe`），所以这里只看时间和窗口。
       */
      const silenceNow = () =>
        this.policy.silenceWhenDownstreamResponded &&
        this.isDownstreamResponded(sessionKey, this.#silenceSince(batch, now));

      if (st.state !== 'awake') {
        // `active` 档按会话判定（m31030）：某群覆盖成 active 才有节拍唤醒，assist/observer 不节拍。
        if (this.#policyFor(sessionKey).mode !== 'active') continue;
        const tick = Number(this.policy.activeTickMs ?? 0);
        if (!(tick > 0) || now - (st.lastCheckAt ?? 0) < tick) continue;
        st.lastCheckAt = now;
        if (silenceNow()) {
          batch.flush();
          this.stats.silent += 1;
          continue;
        }
        this.#enterAwake(sessionKey, st, now, 'tick:active');
        due.push({ sessionKey, reason: 'tick:active' });
        continue;
      }

      const verdict = batch.shouldFlush(now);
      if (!verdict.flush) continue;
      if (silenceNow()) {
        batch.flush();
        this.stats.silent += 1;
        continue;
      }
      due.push({ sessionKey, reason: verdict.reason });
    }
    return Promise.all(due.map(({ sessionKey, reason }) => this.flush(sessionKey, { reason })));
  }

  async tick(now = Date.now()) {
    // 先处理"激活空转超时"：睡回去的会话不该在同一拍里又被节拍叫醒（下一条消息才重新计时）。
    const dormant = this.#expireAwake(now);
    const flushed = await this.scanDue(now);
    const disposed = this.pool?.disposeIdle?.(now) ?? [];
    return { flushed, dormant, disposed };
  }

  get statsSnapshot() {
    const whitelistCfg = this.hub?.config ?? {};
    return {
      ...this.stats,
      /** 会话白名单现状（m31030）：多少群/私聊被允许喂模型（`unlisted` 计数是被挡掉的消息数）。 */
      whitelist: {
        groups: Object.keys(whitelistCfg.agentGroups ?? {}).length,
        privates: Object.keys(whitelistCfg.agentPrivates ?? {}).length,
      },
      batches: [...this.#batches.entries()].filter(([, b]) => b.count).map(([k, b]) => ({ sessionKey: k, pending: b.count })),
      wakeStates: [...this.#wakeStates.entries()].map(([k, v]) => ({ sessionKey: k, ...v })),
      /** 插话在飞的会话与批次数（m31311；多批后带 count）：排查"这条消息怎么插进回合的"时看这里。 */
      steering: [...this.#steering.entries()].map(([sessionKey, tasks]) => ({ sessionKey, count: tasks.size })),
      /**
       * 本回合冻结着的易变上下文（m09285 方案 A）。真机上验证"回合中不再重复注入"就看这里：
       * `hits` 是这一轮里 `liveContext` 被调了几次（宿主每步都调），`composed` 是真正重算了几次。
       * 冻结生效时 `composed` 应该远小于 `hits`。
       */
      liveContext: [...this.#liveCache.entries()].map(([sessionKey, v]) => ({
        sessionKey,
        chars: v.text.length,
        at: v.at,
        ageMs: Date.now() - v.at,
        hits: v.hits ?? 0,
        composed: v.composed ?? 0,
      })),
      /** 最近一次观察的判定明细：`reason` 就是"它为什么不醒"。 */
      lastObserve: this.lastObserve ?? null,
      /** "我是谁"：@ 匹配用的账号与一组名字（配置 + 学到的），排查"被 @ 了不醒"先看这里。 */
      identity: this.identity(),
      agents: this.pool?.list?.() ?? [],
      pool: this.pool?.stats ?? null,
    };
  }
}
