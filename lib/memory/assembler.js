/**
 * 上下文装配（§21.4 + §25）：按"变化频率升序"排列以利 prompt cache。
 *
 *   0 全局指导（几乎不变） → 10 来源头 → 15 人设 → 18 表情包清单
 *   → 30 能力 → 32 待办（主动回忆） → 33 人物卡 → 34 本群认识的人 → 35 群档案 → 36 记忆
 *
 * **v4（`m24409` 用户定案）：会话卡（20）与最近窗口（40）不再进快照。**
 * 这两段每来一条消息都会变，而宿主对 runtime-context 快照是"整份文本变了就追加一份"
 * （append、不替换）——等于每条消息都把整份上下文重注一遍；实测同一批消息最多被注入
 * 3 次（批次 user 消息、卡明细、窗口各一次）。现在：易变的"状态"只在**每段会话的第一批**
 * 随开局快照注入一次（`Mind.#openingText`），之后一切消息都走批次 user message，
 * 转录本身就是最新状态。`digest`/`windowEntries` 参数保留——调用方仍传，快照返回值还带着
 * 它们（`onebot_context` 工具与开局快照要用）。
 *
 * 两条硬约束：
 *  1. 记忆段**必须**先过隔离过滤（§24.5）；进 prompt 的只有已过滤结果。
 *  2. 跨群引用**不带来源**：渲染里不出现"这条来自 group:222"，来源只进审计账本。
 *  3.（`m09699`）**段内不许出现"每回合都在变"的东西**——宿主 `RuntimeContextProjection.project`
 *     逐字节判重，快照里一个字节变了就整份（约 6KB）追加一份。所以：时间写绝对日期、不写
 *     "3 小时前"；排序键取**天粒度**、不取时间戳（每条群消息都会刷新发言人的 `lastSentAt`）。
 *     踩过的坑：`m09409` 的【本群认识的人】按 `lastSentAt` 排，真机 14:21 那场两回合的快照
 *     只差这一行的顺序，于是每批次都重注一次。
 *
 * 人设（15）与表情包清单（18）放在来源头之后：人设是**每会话固定**的（切预设才会变），
 * 都比状态稳定——命中 cache 的那部分前缀越长越好。
 */

import { filterForScope } from './isolation.js';
import { canonicalEvents } from '../capture.js';
import { renderDigest } from './digest.js';
import { nameIn, pastNamesIn } from '../profile.js';
import { mdhm } from '../stamp.js';
import { flatBreaks } from '../text.js';

export const DEFAULT_BUDGET = {
  // 段预算**全部不截**（`m24155` 用户要求"不希望再看到任何因为字数被截断的事情"）：
  // 渲染侧保留 clip 机制只是为了给调用方留一个"显式传预算就还能截"的口子，默认路径不再砍。
  // 内容长度在写入侧已经管住（writer 超限 rejected、条数限制），轮不到这里砍尾巴。
  guidance: Infinity,
  source: Infinity,
  persona: Infinity,
  // 表情包清单一行式（brief+关键词，`m23141` 定案）。
  memes: Infinity,
  // 恢复卡专用（v4 例外）：正常会话卡不进快照，只有"从磁盘读回、实时窗口还空着"的那张
  // 才渲染一次（文本在窗口空着期间恒定，不会反复重注）。
  card: Infinity,
  capabilities: Infinity,
  cues: Infinity,
  person: Infinity,
  // 【本群认识的人】：条数由 `memory.peopleRoster` 配置（默认 20，0＝不注入），
  // 不是"预算不够了就砍尾巴"——渲染层不截，取多少条是产品决定。
  people: Infinity,
  memory: Infinity,
};

const clip = (text, max, tail = '\n…（已截断）') => {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: 0 };
  return { text: s.slice(0, Math.max(0, max - tail.length)) + tail, truncated: s.length - max };
};

/** 最近消息窗口：把时间线条目渲染成人话（hub 视角的"我"= 我们的账号）。 */
export function renderWindow(entries = [], { maxLines = 40, selfId } = {}) {
  // 同一个会话的时间线里，一条上游消息会被记两次（收到 + 转发给下游）。
  // 窗口只能出现一行，否则模型会以为用户把同一句话说成了两遍（真机事故 #3）。
  const rows = canonicalEvents(entries)
    /**
     * **只渲染"这个会话里真实发生过的话"**（用户实测：窗口里出现过 `22:51 下游 bot：` 这种空行）：
     *  - `agent:*` / `hub:*` 这些是枢纽自己的账（工具调用、探针窗口、记忆写入…），不是聊天；
     *  - 没有文本的条目（比如一次 `onebot_memory` 调用）渲染出来就是一行"谁："，纯噪声。
     */
    .filter((e) => {
      const link = String(e?.linkId ?? '');
      if (link.startsWith('agent:') || link.startsWith('hub:')) return false;
      // 发送失败的回复**不是说过的话**（真机：hub-media 引用发不出去 → 上游 failed，
      // 它却以"我：xxx"进了窗口，模型以为自己已经回过了）。时间线留着排查，窗口不渲染。
      if (e?.direction === 'hub-out' && e?.decision === 'failed') return false;
      return String(e?.text ?? '').replace(/\s+/g, ' ').trim() !== '';
    })
    .slice(-maxLines)
    .map((e) => {
      // 注意：入站事件的 `e.selfId` 是**事件里的 self_id（= 本 bot 账号）**，不能拿来判"是不是我说的"——
      // 用它会把自己收到的每条消息都标成"我"（实测：FunnyPotato 的 "111" 被渲染成 "我：111"）。
      // 真正的判据：出站方向，或**说话人**就是自己。
      const speaker = e.actor?.user_id;
      const isSelf =
        e.direction === 'hub-out' ||
        (selfId !== undefined && speaker !== undefined && speaker !== null && String(speaker) === String(selfId));
      // 下游 bot 的条目没有 `actor.nickname`（或那里存的是机器名）：**优先用它的
      // `refs.downstreamLabel` 人话名字**（含"（探针）"），再退昵称/账号/泛称。
      const downstreamName = e.direction === 'downstream-in' ? String(e.refs?.downstreamLabel ?? '').trim() : '';
      const who = isSelf
        ? '我'
        : (downstreamName || e.actor?.nickname || e.actor?.user_id || '下游 bot');
      // 换行留成 ` ⏎ `，与 `#batchLines` 一致（`m08997`）：这里原来压成空格，
      // 同一条消息在【新消息】里看得见断行、到了窗口里就挤成一坨。
      const text = flatBreaks(e.text);
      // 逐行带日期（`m34049`）：窗口跨天很常见，只有 `HH:MM` 分不清"早上那条"是今天还是昨天。
      return `${mdhm(e.ts)} ${who}：${text}`;
    });
  return rows.join('\n');
}

export function renderCapabilities(caps = [], { limit = 5 } = {}) {
  const rows = caps
    .slice(0, limit)
    .map((c) => {
      const args = c.args ? ` ${c.args}` : '';
      const pre = c.confidence !== undefined ? `（置信度 ${c.confidence}）` : '';
      // 前缀来自学习到的真实形状；没学过就沿用协议层默认的 `/`。
      const prefix = c.prefix === undefined || c.prefix === null ? '/' : String(c.prefix);
      const name = String(c.name ?? '').replace(/^\//, '');
      return `- ${prefix}${name}${args}${c.outcome ? ` → ${c.outcome}` : ''}${pre}`;
    });
  if (!rows.length) return '';
  /**
   * 带标题（`m08997`）：以前这层只有光秃秃的 `- /今日小猪 → send_msg` 几行，
   * 夹在表情包清单后面，读者（模型）看不出这是"下游 bot 会吃什么命令"——
   * 分组标题这一层就是干这个的，别让它匿名。置信度＝真被下游触发过的次数。
   */
  return [`【下游会吃的命令（观测 ${caps.length} 条，置信度＝真被触发过的次数）】：`, ...rows].join('\n');
}

const oneLine = (m) => String(m?.text ?? '').replace(/\s+/g, ' ').trim();

/**
 * 记忆段（§24.11）：短期与长期**分开渲染，序号各自从 0 开始**，两块之间空一行（`m08663`）。
 *
 * 为什么必须带序号：模型改写记忆用的是"第几条"（`modify: [{index, content}]`），
 * 而它唯一有资格改的就是它**看得见的**这份列表。序号必须与 `writer.js` 的数组下标完全一致，
 * 否则模型说"改第 0 条"就会打到别人的记忆上。
 *
 * **不截断**（`m23141` 用户要求"直接把截断去掉"）：以前每条 clip 到 200 字符、每块只渲染
 * 最后 12 条，长叙事记忆会被砍半句，且"看不全就改"容易覆盖错条目。现在全部渲染（offset 恒为 0），
 * 长度由写入侧管——单条超 400/300 字直接 rejected，让模型改短后再写。
 */
export function renderMemoryBlocks(blocks = {}) {
  const part = (title, entries = []) => {
    if (!entries.length) return [];
    const rows = entries.map((m, i) => `${i}. ${oneLine(m)}`);
    return [`【${title}】`, ...rows];
  };
  const shortLines = part('短期记忆（本会话；序号可用于 modify/delete）', blocks.shortTerm ?? []);
  const longLines = part('长期记忆（跨会话；序号可用于 modify/delete）', blocks.longTerm ?? []);
  // 两块之间空一行（`m08663` 用户指出：以前把两块 `.join('\n')` 拍平，长期标题紧贴在短期最后
  // 一条记忆下面，看着像同一段里的下一行，而不是另起一块）。标题里也不再写"序号同上"——
  // 每块序号都从 0 起、各自对各自的列表，"同上"容易被读成"接着上面的号数往下数"。
  return [shortLines, longLines]
    .filter((lines) => lines.length)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

const day = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 人物卡（§24.2 M16）：关于"这个人"的提炼，而不是他刚说了什么（那是会话卡与窗口的事）。
 *
 * 隔离在这里**必须**再生效一次：人物档案是跨会话的，里面可能有别的群里学到的事。
 * 过滤依据是每条 fact 自己的 `scope`/`visibility`（写入时由代码判定），不是模型声明的。
 */
export function renderPerson(person, { sessionKey, worldKey, actorId, isolation } = {}) {
  if (!person || !person.userId) return '';
  const scope = worldKey ?? sessionKey;
  const name = nameIn(person, scope) ?? nameIn(person, sessionKey) ?? String(person.userId);
  const lines = [`【人物卡】${name}（QQ ${person.userId}）`];
  const g = person.groups?.[scope] ?? person.groups?.[sessionKey];
  if (g && (g.card || g.role || g.title)) {
    const bits = [g.role && g.role !== 'member' ? g.role : null, g.title, g.card].filter(Boolean);
    if (bits.length) lines.push(`在这个群里：${bits.join('｜')}`);
  }
  // 曾用名（§24.11）：**代码自动记的**事实，写进卡里模型才不会把"小明"和"明哥"当两个人。
  // 不写"以前叫"这种日期细节，只给名字——它出现在这里是为了认人，不是为了考古。
  const past = pastNamesIn(person, { scope, current: name, limit: 3 }).filter((p) => p.name !== name);
  if (past.length) lines.push(`也曾叫过：${past.map((p) => p.name).join('、')}`);
  // 资料是**看到的**（get_stranger_info），会过时：30 天后就不再当事实讲。
  const prof = person.profile ?? {};
  const fresh = !prof.profileAt || Date.now() - Number(prof.profileAt) < 30 * 24 * 3600 * 1000;
  const bits = [];
  if (prof.sex) bits.push(`性别 ${prof.sex}`);
  if (prof.age) bits.push(`${prof.age} 岁`);
  if (prof.level) bits.push(`等级 ${prof.level}`);
  if (fresh && bits.length) lines.push(`资料：${bits.join('｜')}`);
  const facts = filterForScope(
    (person.facts ?? []).map((f, i) => ({ id: `f${i}`, kind: 'fact', text: f.text, scope: f.scope ?? null, worldKey: f.worldKey ?? null, visibility: f.visibility, sensitive: f.sensitive, actor: f.actor })),
    { sessionKey, worldKey: scope, actorId, isolation },
  ).visible;
  if (facts.length) lines.push('我知道的：', ...facts.map((f) => `- ${oneLine(f)}`));
  // 不再按 limit 截（`m23141`：人物档案同样去截断）——看到多少渲染多少，
  // 单条超长在写入侧就被 rejected（MAX_FACT_TEXT=300）。
  const open = (person.commitments ?? []).filter((c) => c.status === 'open');
  if (open.length) lines.push('答应过还没做的：', ...open.map((c) => `- ${String(c.what ?? '').replace(/\s+/g, ' ').trim()}${c.due ? `（约 ${day(c.due)}）` : ''}`));
  const corrections = person.corrections ?? [];
  if (corrections.length) lines.push(`纠正过我：${corrections.map((c) => c.right).join('；')}`);
  if (person.impression) lines.push(`印象：${String(person.impression).replace(/\s+/g, ' ').trim()}`);
  const rel = person.relationship ?? {};
  if (rel.closeness || rel.tone) lines.push(`关系：亲近度 ${rel.closeness ?? 0}${rel.tone ? `｜语气 ${rel.tone}` : ''}`);
  return lines.join('\n');
}

/**
 * 本群认识的人（`m09409` 用户批准）：上下文里原本**只有当前对话对象那一张卡**，
 * 于是模型看不见"群里还有谁"——认不出谁在说话、也接不上曾用名（`pastNamesIn` 只在人物卡里）。
 *
 * 三条硬约束（都是踩过才知道的）：
 *  1. **只列本群的**：判据是档案里有没有 `groups[worldKey]` 这条记录——这正是"我认识他"的证据。
 *     不按群过滤就等于把别的群认识的人搬过来，跨群名单泄漏。
 *  2. **不展开别人的 facts 正文**：只给条数（"知道 3 件事"）。正文是 `onebot_person` 的活，
 *     而且 facts 必须逐条过 `filterForScope`（§24.5）才准进 prompt——在这里展开等于绕过隔离。
 *  3. **不写相对时间**（"3 小时前"这种）。同一份快照按逐字节比对判重（宿主
 *     `RuntimeContextProjection.project`），时间一变整份重注；排序用时间戳，但**不渲染它**——
 *     这正是 `renderCues` 现在会抖的坑，别在这儿再挖一个。
 *
 * `impression` 不逐条过滤：它是人物级的一句话，**人物卡里本来就是原样渲染的**（见 `renderPerson`），
 * 这里与卡片保持一致；真正带可见性标记、必须过滤的是 facts，而 facts 只出条数。
 *
 * @param {Array} people `profiles.persons()` 的全部档案
 * @param {{limit?:number, selfId?:any}} opts `limit`＝最多列几人（0＝整段不渲染），按最近露面排序
 */
export function renderPeopleRoster(people = [], { sessionKey, worldKey, actorId, selfId, limit = 20 } = {}) {
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 20;
  if (!cap || !Array.isArray(people) || !people.length) return '';
  const scope = worldKey ?? sessionKey;
  const mine = new Set([actorId, selfId].filter((v) => v !== undefined && v !== null).map(String));

  const rows = [];
  for (const p of people) {
    if (!p?.userId) continue;
    // 当前对话对象有自己的完整卡片；bot 自己也不该出现在"认识的人"里。
    if (mine.has(String(p.userId))) continue;
    // 本群记录 = 我确实在这个群见过/认识他（noteGroupCard 写的）。
    const g = p.groups?.[scope];
    if (!g) continue;
    const name = nameIn(p, scope) ?? nameIn(p, sessionKey) ?? String(p.userId);
    const bits = [];
    // 群里的身份：名片/头衔/角色，**和人物卡同一套字段**（名字跟着群走）。
    // 去掉与名字重复的那几个——"战舰世界yuyuko助手（2854209449）｜战舰世界yuyuko助手" 是纯噪声。
    const who = [g.card, g.role && g.role !== 'member' ? g.role : null, g.title]
      .filter(Boolean)
      .filter((v, _i, arr) => v !== name && arr.indexOf(v) === _i);
    if (who.length) bits.push(who.join('／'));
    if (p.impression) bits.push(`印象：${String(p.impression).replace(/\s+/g, ' ').trim()}`);
    const factCount = (p.facts ?? []).length;
    if (factCount) bits.push(`知道 ${factCount} 件事`);
    const open = (p.commitments ?? []).filter((c) => c.status === 'open').length;
    if (open) bits.push(`有 ${open} 件没兑现的承诺`);
    rows.push({
      userId: String(p.userId),
      // 排序键取"他在这个群最后一次露面"**所在的那一天**，不是时间戳本身（理由见下面的 sort）。
      seenDay: day(Number(g.lastSentAt ?? 0) || Number(p.relationship?.lastInteractAt ?? 0) || Number(p.updatedAt ?? 0)) ?? '',
      line: `- ${name}（${p.userId}）${bits.length ? `｜${bits.join('｜')}` : ''}`,
    });
  }
  if (!rows.length) return '';
  // **天粒度**排序（m09699）：宿主的 `RuntimeContextProjection.project` 逐字节判重，快照里
  // 任何一个字节变了就整份（约 6KB）重注一次。而每条群消息都会刷新发言人的 `lastSentAt`
  // （lib/hub.js `noteGroupCard`），**按时间戳排 = 每回合必重排 = 每回合必重注**——真机
  // 14:21 那场两回合就是只差【本群认识的人】这一行的顺序。改成按"最近露面的那一天"排，
  // 一天内顺序恒定（同一天按 QQ 兜底），只有有人跨天时才重排一次。
  rows.sort((a, b) =>
    a.seenDay < b.seenDay ? 1 : a.seenDay > b.seenDay ? -1 : 0
      || a.userId.localeCompare(b.userId));
  const shown = rows.slice(0, cap);
  const left = rows.length - shown.length;
  const lines = [
    `【本群认识的人】下面是我在这个群有记录的人（按最近露面的先后排，同一天内按 QQ 排）：想了解某个人，调 onebot_person 查他的档案。`,
  ];
  lines.push(...shown.map((r) => r.line));
  if (left > 0) lines.push(`（还有 ${left} 人没列出来，同样可以用 onebot_person 查。）`);
  return lines.join('\n');
}

/**
 * 主动回忆段（§24.6 M18）：**只报事实，不下命令**。
 *
 * 这一段的措辞是设计的一部分：如果这里写"该提醒他一下了"，模型就会照着念，于是变成
 * 每 24 小时复读一次的催债机器人；写成"你答应过……他上次露面是……"，提不提才是模型的判断。
 * 所以标题里明确写出"只是事实"。
 */
export function renderCues(cues = [], { now = Date.now(), limit = 5 } = {}) {
  if (!cues.length) return '';
  // 时间一律渲染成**绝对日期**（m09699），不写"3 小时前"：宿主逐字节判重，快照里相对时间
  // 每个回合都在变 → 整份重注。绝对日期既稳定，信息还不丢（今天的日期模型从【来源】/批次
  // 那一行就有，自己能算出隔了多久）。
  const lines = ['【还没兑现的事】下面是你自己答应过的原话，只是事实——要不要现在提起、怎么提，由你判断。'];
  for (const c of cues.slice(0, limit)) {
    const bits = [];
    if (c.due) bits.push(c.overdueDays > 0 ? `当时说大约 ${day(c.due)}，已经过了 ${c.overdueDays} 天` : `当时说大约 ${day(c.due)}`);
    else if (c.lastMentionedAt) bits.push(`${day(c.lastMentionedAt) ?? '之前'}提过`);
    if (c.lastSeenAt) bits.push(`他上次露面是 ${day(c.lastSeenAt) ?? '不确定的时间'}`);
    lines.push(`- 你答应过「${oneLine({ text: c.name })}」：${oneLine({ text: c.what })}${bits.length ? `（${bits.join('；')}）` : ''}`);
  }
  return lines.join('\n');
}

/** 群档案（§24.2）：群规是**观测所得**，不是从百科读来的，所以措辞要留余地。 */
export function renderGroupProfile(group) {
  if (!group || !group.worldKey) return '';
  const lines = [`【群档案】${group.name ?? group.worldKey}`];
  if (group.memberCount) lines.push(`人数 ${group.memberCount}${group.ownerId ? `｜群主 ${group.ownerId}` : ''}`);
  if (group.culture) lines.push(`这个群的样子：${group.culture}`);
  if (group.notice) lines.push(`群公告（观测）：${String(group.notice).replace(/\s+/g, ' ').trim()}`);
  if (group.activeMembers?.length) {
    lines.push(`常说话的人：${group.activeMembers.slice(0, 5).map((m) => { const label = m.nickname ?? m.name ?? ''; const id = m.user_id ?? m.userId; return label ? `${label}${id ? `(${id})` : ''}` : id ?? ''; }).join('、')}`);
  }
  // 条数限制（最后 3 条）保留，条内字数不截（m24155）。
  if (group.highlights?.length) lines.push(`之前出过的事：${group.highlights.slice(-3).map((h) => String(h.text ?? h)).join('；')}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 装配上下文。
 * @param {{guidance?:string, sourceHeader?:string, persona?:string, digest?:object,
 *          capabilities?:Array, windowEntries?:Array, memoryEntries?:Array, sessionKey:string,
 *          worldKey?:string, actorId?:any, isolation:object, budget?:object, selfId?:any,
 *          people?:Array, peopleLimit?:number}} input
 *
 * `persona` / `memes` 由调用方（`mind.snapshot`）渲染好再传进来：装配层只管"插在哪、占多大
 * 预算"，不认识 PersonaStore / MemeStore，也就不会在这里长出第二套渲染逻辑。
 */
export function assembleContext(input = {}) {
  const {
    guidance = '',
    sourceHeader = '',
    persona = '',
    memes = '',
    capabilities = [],
    memoryEntries = [],
    memory = null,
    person = null,
    people = [],
    peopleLimit = 20,
    group = null,
    cues = [],
    sessionKey,
    worldKey,
    actorId,
    isolation,
    budget = {},
    // v4：`digest` / `windowEntries` / `selfId` 正常不渲染（会话卡与窗口已移出快照，见文件头），
    // 例外是 `digest.resumed`——从磁盘读回、实时窗口还空着的那张恢复卡仍渲染一次。
    digest = null,
    windowEntries = [],
    selfId,
  } = input;
  const lim = { ...DEFAULT_BUDGET, ...budget };

  const filtered = filterForScope(memoryEntries, { sessionKey, worldKey, actorId, isolation });
  // 调用方可以只给已过滤好的 `memory` 分块（`writer.memoryBlocks` 的产物），
  // 那是写入侧与装配侧看到**同一份列表**的保证——序号才敢用来改写。
  const blocks = memory ?? { shortTerm: filtered.visible, longTerm: [] };
  const sections = [];
  const truncated = [];

  const push = (name, order, raw, max, note) => {
    const { text, truncated: cut } = clip(raw, max);
    if (cut) truncated.push({ section: name, chars: cut });
    sections.push({ name, order, chars: text.length, note: note ?? null, text });
  };

  push('guidance', 0, guidance, lim.guidance);
  push('source', 10, sourceHeader, lim.source);
  push('persona', 15, persona, lim.persona);
  push('memes', 18, memes, lim.memes);
  // 会话卡（20）与最近窗口（40）不进快照——见文件头 v4 注释。唯一例外：**恢复卡**
  // （`digest.resumed`，重启后 L1 不回放、环是空的）——它就是"这段之前发生了什么"的唯一
  // 来源，且在窗口空着期间文本恒定（不随消息变化），不会触发宿主的快照重注。
  if (digest?.resumed) push('card', 20, renderDigest(digest), lim.card);
  push('capabilities', 30, renderCapabilities(capabilities), lim.capabilities);
  push('cues', 32, renderCues(cues), lim.cues, cues.length ? `${cues.length} 条待办` : null);
  push('person', 33, person ? renderPerson(person, { sessionKey, worldKey, actorId, isolation }) : '', lim.person);
  // 【本群认识的人】：只在这段是群会话时渲染（私聊里"认识的人"是另一回事，见 renderPeopleRoster 注释）。
  push(
    'people',
    34,
    (worldKey ?? sessionKey ?? '').startsWith('group:')
      ? renderPeopleRoster(people, { sessionKey, worldKey, actorId, selfId, limit: peopleLimit })
      : '',
    lim.people,
  );
  push('group', 35, group ? renderGroupProfile(group) : '', Math.round(lim.person / 2));
  push(
    'memory',
    36,
    renderMemoryBlocks(blocks),
    lim.memory,
    filtered.audit.length ? `${filtered.audit.length} 条跨会话` : null,
  );

  const text = sections
    .filter((s) => s.text.trim())
    .sort((a, b) => a.order - b.order)
    .map((s) => s.text.trim())
    .join('\n\n');

  return {
    text,
    sections: sections.map(({ text: _t, ...rest }) => rest),
    audit: filtered.audit,
    denied: filtered.denied,
    truncated,
    blocks,
    memoryVisible: (blocks.shortTerm?.length ?? 0) + (blocks.longTerm?.length ?? 0),
    memoryTotal: memoryEntries.length,
  };
}

/** 来源头：让模型知道"我在哪、我是谁、这条链路通向谁"（§21.4 第 2 段）。 */
export function buildSourceHeader({ selfId, nickname, sessionKey, worldKey, linkId, kind } = {}) {
  const where = sessionKey?.startsWith('group:') ? `群 ${sessionKey.slice('group:'.length)}` : sessionKey?.startsWith('private:') ? `与 ${sessionKey.slice('private:'.length)} 的私聊` : (sessionKey ?? '未知会话');
  /**
   * **这里刻意没有"现在几点"**（`m02432` 用户要求修注入上下文）：这一段属于宿主的
   * runtime-context 快照，宿主只在**整份文本变了**的时候才追加一份新快照
   * （`RuntimeContextProjection.project`：`if (this.retained?.text === snapshot) return;`）。
   * 分钟精度的时钟会让整份快照每分钟重注一遍（实测一次回话 3 分钟 = 4 份 3613 字符的重复快照）。
   * 时间挪到每批新消息里（`Mind.#batchText`）——那条 user message 本来就是新增内容，不额外花代价。
   */
  return [
    `【来源】${where}（worldKey=${worldKey ?? sessionKey}，链路 ${linkId ?? '未知'}${kind ? `/${kind}` : ''}）`,
    `【身份】你是 ${nickname ?? '本机 bot'}（QQ ${selfId ?? '未知'}），你通过 DSH 在这个聊天里说话。`,
  ].join('\n');
}

export function describeSections(sections = []) {
  return sections.map((s) => `${s.name}:${s.chars}${s.note ? `(${s.note})` : ''}`).join(' ');
}
