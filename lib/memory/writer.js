/**
 * 记忆写入（§24.11）：**模型决策，代码执行**。
 *
 * 这是整个拟人化记忆里最容易做错的一环。两种错法都常见：
 *  - 代码替模型判断"什么值得记"：结果是记满了"用户说了你好"；
 *  - 模型自己决定"这条能不能说给别人听"：结果是私聊里的话第二天出现在群里。
 *
 * 所以边界划在这里：**记什么、怎么改由模型给结构化指令；能不能跨会话说由代码按会话推断**。
 * 本模块只做四件事——校验形状、丢掉越界的字段、按 `modify → delete → add` 的顺序应用、给出人话的回执。
 * 它不调用任何 LLM，也不猜内容含义。
 *
 * 指令形状（模型只能从这里选，未知字段一律拒绝并回执说明）：
 *
 * ```json
 * {
 *   "active": {"add": [{"kind": "topic", "text": "在讨论换显卡，卡在电源瓦数"}],
 *              "update": [{"index": 0, "text": "…"}],
 *              "settle": [{"index": 0, "outcome": "keep", "summary": "群里定下了 850W 的电源",
 *                          "keep_as": {"target": "topic", "title": "显卡选购", "conclusion": "选了 850W"}}]},
 *   "long_term":  {"add": [{"text": "…"}]},
 *   "persons": {"10001": {"facts": [{"text": "…"}], "interests": [], "commitments": [{"what": "…", "due": 1730000000000}],
 *                          "corrections": [{"wrong": "…", "right": "…"}], "impression": "…", "relationship": {"closeness": 2}}},
 *   "groups": {"group:55555": {"culture": "这个群爱聊硬件，不喜欢刷屏"}},
 *   "topics": {"散热改装": {"title": "散热改装", "status": "open", "worldKeys": ["group:55555"], "events": [{"text": "讨论到风扇型号"}]}},
 *   "self": {"myStatements": [{"what": "…"}], "mistakes": [], "preferences": [], "myNames": {"group:55555": "小助"}}
 * }
 * ```
 *
 * 群档案里模型只能写 `culture`：群名、人数、群主、公告是**观测**来的，
 * 只由代码从实现端写入——让模型写它们，等于允许它凭印象编造一条不存在的群规。
 * （`highlights` 在 `m17909` 删掉了：它跟长期记忆重复，而且只被读成一行、检索不到。）
 *
 * `active` 是**活跃层**（`m17909`）：进行中的话题与 agent 正在做的事。它有生命周期，
 * 唯一的出口是 `settle`；`short_term` 的 `add` 已退役（历史残留还能改、能删），
 * 短期记忆的职能整体搬到了活跃层。详见 `applyActiveOps` 的注释。
 *
 * `index` 指向**装配时渲染出来的那一份列表的序号**（短期与长期各自从 0 开始），
 * 也就是"模型确实看见过的那几条"——这正是它唯一有资格改的集合。
 *
 * 短期/长期的**归属**由代码算（`m08521`）：本会话学到的算短期；提升过的（模型写过 `long_term`）
 * 与在别处学到的算长期。同文本写进 `long_term` ＝ 把短期里那条**就地提升**（回执里的 `promoted`），
 * 这样"重要信息提升到长期"才是一条真能执行下去的指令（用户点名参考 aigf-master）。
 */

import { inferScope, isSensitive, filterForScope } from './isolation.js';
import { ACTIVE_KINDS, MAX_ACTIVE_TEXT, activeLabel } from './active.js';

export const MAX_MEMORY_TEXT = 400;
export const MAX_FACT_TEXT = 300;
export const MEMORY_BLOCKS = ['short_term', 'long_term'];
export const PERSON_PATCH_KEYS = ['facts', 'interests', 'commitments', 'corrections', 'impression', 'profile', 'relationship'];
export const SELF_PATCH_KEYS = ['myStatements', 'mistakes', 'preferences', 'myNames'];
/** 群档案里**模型可以写**的只有提炼字段；群名/人数/群主/公告是观测所得，只能由代码写。 */
export const GROUP_PATCH_KEYS = ['culture'];
/** 话题线程（可跨群）：模型写标题/进展/结论，`id` 由调用方给。 */
export const TOPIC_PATCH_KEYS = ['title', 'status', 'conclusion', 'worldKeys', 'members', 'events'];

const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 超长 = **拒绝**，不是替模型剪短（`m22989` 用户定案："写入侧超单条 400 必须 rejected 让它改短"）。
 * 静默截断的回执会让模型以为长文已经完整记下，下次它还是写长的；拒绝 + 报实际长度，它才会改短重发。
 */
const tooLong = (text, max, path, rejected) => {
  const len = String(text ?? '').length;
  if (len <= max) return false;
  rejected.push({ path, reason: `超长：${len} 字 > 上限 ${max} 字，已拒绝——请改短（一条一句话）后重发` });
  return true;
};

/** 与 `normalizeEntry` 同一套取值：字符串直接用，对象取 `.text`（用于写入前的长度检查）。 */
const textOf = (raw) => String(typeof raw === 'string' ? raw : raw?.text ?? '').trim();

/** 校验后返回干净文本；超长记一条 rejected 并返回 `null`（调用方据此跳过写入）。 */
const bounded = (value, max, path, rejected) => {
  const text = String(value ?? '').trim();
  return tooLong(text, max, path, rejected) ? null : text;
};

/**
 * 把可见记忆切成两块，供渲染与"按序号改写"使用。
 *
 * 算长期的有两种（`m08521` 起）：
 *  - **提升过的**：`term === 'long'`——模型把这条明确写进过 `long_term`（见 `applyMemoryOps` 的提升路径）；
 *  - **别处学来的**：`scope` 不是本会话/本世界，就是跨会话可见的那批（身份、其他会话里说过、被允许复用的事实）。
 * 其余的（本会话学到的、还没提升的）是短期。
 */
export function memoryBlocks(entries = [], ctx = {}) {
  const filtered = filterForScope(entries, ctx);
  const sessionKey = String(ctx.sessionKey ?? '');
  const worldKey = String(ctx.worldKey ?? '');
  const here = (e) => {
    const s = String(e?.scope ?? '');
    return (sessionKey && s === sessionKey) || (worldKey && s === worldKey);
  };
  const isLong = (e) => String(e?.term ?? '') === 'long';
  const shortTerm = filtered.visible.filter((e) => !isLong(e) && here(e));
  const longTerm = filtered.visible.filter((e) => isLong(e) || !here(e));
  return { ...filtered, shortTerm, longTerm };
}

/**
 * 「这条记忆讲的是谁」：模型给的 QQ 号列表。归一去重、去空、上限 12 个。
 * 只认数字串——模型偶尔会写"小明"这种名字，那不是 id，硬塞进去只会让读取侧永远匹配不上。
 */
const relIds = (v) => {
  const raw = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]);
  const out = [];
  for (const x of raw) {
    const s = String(x ?? '').trim();
    if (/^\d+$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 12) break;
  }
  return out;
};

/**
 * 可见性推断——**唯一**允许决定"这条能不能跨会话说"的地方。
 * 私聊来源一律 `private`；敏感内容一票否决（连代码也不升格）；公开群里明确标"长期"的才 `shareable`。
 */
export function inferWriteVisibility({ block = 'short_term', scope = '', sessionKey = '', text = '', relatedUsers = [] } = {}) {
  const s = String(sessionKey ?? '');
  if (String(scope).startsWith('private:') || s.startsWith('private:')) return 'private';
  if (isSensitive({ text })) return scope || 'private';
  // 「讲的是群里的某些人」的记忆（`m15264` 用户拍板）：**长期 ≠ 可以到处说**。
  // 以前 `long_term.add` 一律盖成 `shareable`，于是 A 群里"小张下周离职"进了长期记忆库，
  // 下一个回合就在 B 群被原样念出来——长期记忆反而成了跨群泄密的通道。
  // 现在有 `relatedUsers` 就落回本群 scope，由读取侧按"这些人在不在这个群"放行。
  if (relatedUsers.length) return scope || 'private';
  if (block === 'long_term') return 'shareable';
  return scope || (s.startsWith('group:') ? s : 'private');
}

/** 一条待写入的记忆条目（模型只给 text，其余边界字段由代码补）。 */
export function normalizeEntry(raw, ctx = {}) {
  const block = ctx.block ?? 'short_term';
  const sessionKey = String(ctx.sessionKey ?? '');
  const worldKey = String(ctx.worldKey ?? '');
  const scope = ctx.scope ?? inferScope({ sessionKey, worldKey, actorId: ctx.actorId });
  // 不再 clip：超长在调用处（add/modify）已按 MAX_MEMORY_TEXT 拒绝，这里只做清首尾空白。
  const text = textOf(raw);
  if (!text) return null;
  const relatedUsers = relIds(isPlain(raw) ? raw.related_users : undefined);
  const visibility = inferWriteVisibility({ block, scope, sessionKey, text, relatedUsers });
  // 档案指针（`m20216`）：只有 `settle keep` 会带，指向"这条索引的细节在哪份档案里"。
  const archive = isPlain(raw) && Array.isArray(raw.archive)
    ? raw.archive
      .filter((a) => isPlain(a) && a.id !== undefined && a.id !== null && String(a.id).trim())
      .map((a) => ({ target: String(a.target ?? 'topic'), id: String(a.id) }))
      .slice(0, 4)
    : [];
  return {
    kind: block === 'long_term' ? 'fact' : (ctx.kind ?? 'fact'),
    scope,
    worldKey: worldKey || null,
    actor: ctx.actor ?? (ctx.actorId !== undefined && ctx.actorId !== null ? { user_id: ctx.actorId } : null),
    text,
    refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null),
    visibility,
    // 「讲的是谁」（`m15264`）：模型显式点名就按它走；没点名就只有条目自己。
    relatedUsers: relatedUsers.length ? relatedUsers : null,
    ...(archive.length ? { archive } : {}),
    // 「这条敏感」可以由模型自己说（`m20991` 用户要求）：它只会**收窄**可见性（锁定在本会话），
    // 所以是安全的；反向（`sensitive:false` 解锁）在 `applyMemoryOps` 里明确拒绝——
    // 词表命中的内容不能被一句 false 放出去。`store.normalize` 会把这里与词表结果取「或」。
    ...(isPlain(raw) && raw.sensitive === true ? { sensitive: true } : {}),
    confidence: isPlain(raw) && raw.confidence !== undefined ? clamp01(raw.confidence) : undefined,
    source: ctx.source ?? 'model',
    // 「提升」的存储位（`m08521`）：`long_term` 写进来的本身就是长期；
    // 短期里那条被同文本重写进 `long_term` 时，由 `tryPromote` 就地翻成 `long`。
    term: block === 'long_term' ? 'long' : 'short',
  };
}

/**
 * 试把一条**本会话学到的**同文本条目提升为长期（`m08521` 用户定案，参考 aigf-master 的
 * "重要且长期有效的信息→提升到长期记忆"）。
 *
 * 为什么必须走这条路径：块归属过去完全由 `scope` 推，模型把同一句话写进 `long_term` 只会撞上
 * "已有同一条"，库里什么都没变——于是"提升"在 prompt 里是个说不通的词，模型照着做还以为成功了。
 * 现在 `long_term.add` 命中本会话自己的短期条目时**就地提升**（回执记 `promoted`）；
 * 升不动的（私聊来源、敏感内容、别处学来的同文本）照旧拒绝，并把原因说清楚。
 */
function tryPromote(existing, ctx = {}) {
  if (!existing) return { ok: false, reason: '没有找到要提升的条目' };
  if (String(existing.term ?? '') === 'long') return { ok: false, reason: '这条已经是长期记忆' };
  if (String(existing.scope ?? '') !== String(ctx.scope ?? '')) {
    return { ok: false, reason: '同文本的条目是在别的会话里学到的，不归这次写入管' };
  }
  const plain = inferWriteVisibility({ block: 'long_term', scope: existing.scope, sessionKey: ctx.sessionKey, text: existing.text });
  const visibility = inferWriteVisibility({ block: 'long_term', scope: existing.scope, sessionKey: ctx.sessionKey, text: existing.text, relatedUsers: existing.relatedUsers ?? [] });
  // 「讲的是某些人」不等于升不动：模型要的就是"长期记着"，只是长期≠跨群（读取侧另有闸门）。
  // 真正升不动的还是私聊来源与敏感内容——`plain` 仍不是 shareable 时照旧拒绝。
  if (visibility !== 'shareable' && plain !== 'shareable') {
    return {
      ok: false,
      reason: String(ctx.sessionKey ?? '').startsWith('private:')
        ? '私聊里学到的不能跨会话说'
        : '内容被判为敏感，连代码也不升格',
    };
  }
  const rec = ctx.store?.promote?.(existing.id, { visibility, now: ctx.now });
  return rec ? { ok: true, rec } : { ok: false, reason: '目标条目已不存在' };
}

const clamp01 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
};

function normalizeFact(raw, ctx) {
  const text = textOf(raw);
  if (!text) return null;
  // 超长拒绝（`m22989`）：不替模型剪短，报实际长度让它改后再写。
  if (tooLong(text, MAX_FACT_TEXT, ctx.path ?? 'facts', ctx.rejected ?? [])) return null;
  // 写进**这个人的档案**里的事实，"讲的是谁"不用模型点名——就是他本人（`m15264`）。
  // 不这么定的话，人物 facts 走的也是 `long_term → shareable` 那条路：A 群认识的人，
  // 到了 B 群照样能被 `onebot_person` 调出来，档案就成了跨群泄露的旁路。
  const relatedUsers = [String(ctx.userId ?? '')].filter((s) => /^\d+$/.test(s));
  const visibility = inferWriteVisibility({ block: 'long_term', scope: ctx.scope, sessionKey: ctx.sessionKey, text, relatedUsers });
  return {
    text,
    refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null),
    confidence: isPlain(raw) && raw.confidence !== undefined ? clamp01(raw.confidence) : undefined,
    visibility,
    relatedUsers: relatedUsers.length ? relatedUsers : null,
    // `scope` 是"这条是在哪儿学到的"：回本群可见，跨群要过 §24.5 的分级判定。
    scope: ctx.scope,
    worldKey: ctx.worldKey ?? null,
    // 代码判定：事实归这个人的档案，所以 actor 就是这个人。
    actor: { user_id: String(ctx.userId) },
    at: ctx.now,
  };
}

function normalizeCommitment(raw, ctx) {
  const what = String(isPlain(raw) ? raw.what ?? '' : raw ?? '').trim();
  if (tooLong(what, MAX_FACT_TEXT, ctx.path ?? 'commitments', ctx.rejected ?? [])) return null;
  if (!what) return null;
  const due = isPlain(raw) && raw.due !== undefined && raw.due !== null ? Number(raw.due) : null;
  return {
    what,
    due: Number.isFinite(due) ? due : null,
    refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null),
    scope: ctx.scope,
    status: isPlain(raw) && ['open', 'done', 'dropped'].includes(raw.status) ? raw.status : 'open',
    mentions: 1,
    lastMentionedAt: ctx.now,
    strength: isPlain(raw) && raw.strength !== undefined ? clamp01(raw.strength) ?? 0.6 : 0.6,
  };
}

function normalizeCorrection(raw, ctx) {
  const wrong = isPlain(raw) ? String(raw.wrong ?? '').trim() : '';
  const right = String(isPlain(raw) ? raw.right ?? '' : raw ?? '').trim();
  if (tooLong(wrong, MAX_FACT_TEXT, ctx.path ?? 'corrections', ctx.rejected ?? []) || tooLong(right, MAX_FACT_TEXT, ctx.path ?? 'corrections', ctx.rejected ?? [])) return null;
  if (!right) return null;
  return { wrong: wrong || null, right, refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null), scope: ctx.scope, at: ctx.now };
}

/**
 * 应用一批记忆指令。
 *
 * @param {object} ops 模型给的 `memory` 对象
 * @param {{store:object, profiles:object, sessionKey:string, worldKey?:string, actorId?:any,
 *          isolation?:object, now?:number, refs?:object, blocks?:object, source?:string}} ctx
 * @returns {{ok:boolean, at:number, blocks:object, persons:object, self:object|null, rejected:Array, applied:object}}
 */
export function applyMemoryOps(ops, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const sessionKey = String(ctx.sessionKey ?? '');
  const worldKey = String(ctx.worldKey ?? sessionKey);
  const scope = inferScope({ sessionKey, worldKey, actorId: ctx.actorId });
  const base = { sessionKey, worldKey, actorId: ctx.actorId, scope, now, refs: ctx.refs ?? null, source: ctx.source ?? 'model' };
  const rejected = [];
  const applied = { short_term: { add: 0, modify: 0, delete: 0, promoted: 0 }, long_term: { add: 0, modify: 0, delete: 0, promoted: 0 }, active: { add: 0, update: 0, settle: { keep: 0, drop: 0 }, rejected: 0 }, persons: 0, groups: 0, topics: 0, self: 0 };
  const blockReport = { short_term: { add: 0, modify: 0, delete: 0, sensitive: 0, deduped: 0, promoted: 0, rejected: 0 }, long_term: { add: 0, modify: 0, delete: 0, sensitive: 0, deduped: 0, promoted: 0, rejected: 0 } };
  const personReport = {};

  if (!isPlain(ops)) {
    // 说清"收到的是什么"（`m02432` P8）：真机上模型把对象 stringify 了两遍，
    // 只回一句"指令必须是对象"，它下一轮还是照样错。
    const got =
      ops === null || ops === undefined
        ? '空值/解析不出来'
        : Array.isArray(ops)
          ? '数组'
          : typeof ops === 'string'
            ? `字符串（前 40 字：${String(ops).slice(0, 40)}）`
            : typeof ops;
    return {
      ok: false,
      at: now,
      blocks: blockReport,
      persons: personReport,
      self: null,
      rejected: [{ path: 'memory', reason: `ops 必须是对象，收到的是${got}；给 {short_term:…} 这样的 JSON 对象即可` }],
      applied,
    };
  }

  // 1) 已知字段之外的东西一律拒绝（模型幻觉出的字段不该静默生效）。
  for (const key of Object.keys(ops)) {
    if (!['short_term', 'long_term', 'active', 'persons', 'groups', 'topics', 'self'].includes(key)) {
      rejected.push({ path: `memory.${key}`, reason: '未知字段（可用：short_term/long_term/active/persons/groups/topics/self）' });
    }
  }

  // 1.5) **活跃层**（`m17909`）：进行中的话题与 agent 正在做的事。
  // `short_term` 已经退役为"只读的历史兼容块"——短期记忆的职能整体搬到了这里，
  // 因为它要跨会话共享、要带出处、要有生命周期，这三件事旧的 short_term 一条都做不到。
  const activeReport = { add: 0, update: 0, settle: { keep: 0, drop: 0 }, rejected: 0 };
  if (ops.active !== undefined && ops.active !== null) {
    applyActiveOps(ops.active, { ...ctx, now, scope, base, rejected, report: activeReport });
  }
  if (ops.short_term !== undefined && ops.short_term !== null) {
    if (isPlain(ops.short_term) && ops.short_term.add !== undefined) {
      rejected.push({
        path: 'memory.short_term.add',
        reason: '短期记忆已改为「活跃层」：进行中的话题与正在做的事写 active.add，做完用 active.settle 结算（keep 存长期记忆 / drop 删掉）；short_term 只剩历史残留可改可删',
      });
    }
  }

  const blocks = ctx.blocks ?? memoryBlocks(ctx.store?.all?.() ?? [], { sessionKey, worldKey, actorId: ctx.actorId, isolation: ctx.isolation });

  for (const name of MEMORY_BLOCKS) {
    const spec = ops[name];
    if (spec === undefined || spec === null) continue;
    if (!isPlain(spec)) {
      rejected.push({ path: `memory.${name}`, reason: '必须是对象 {add,modify,delete}' });
      continue;
    }
    const list = name === 'short_term' ? (blocks.shortTerm ?? []) : (blocks.longTerm ?? []);
    // 长期记忆也只准写在**当前这一轮所在的会话**名下（`m28425`）。以前这里的口径是
    // "长期记忆/人物档案不受这条限制"——理由是"记住某个人的事跟会话无关"，但实现上
    // `long_term.add` 的 scope 就是传进来的 `sessionKey`：私聊里带 `sessionKey:"group:X"`
    // 就能往那个群的记忆里种一条，下一轮它会当作"那个群记得的事"注入进去。
    // 人物档案（persons）不在这里判：它的键是人不是会话，写进去本来就跨会话共享。
    {
      const currentSessionKey = String(ctx.currentSessionKey ?? '');
      if (name === 'long_term' && currentSessionKey && sessionKey && currentSessionKey !== sessionKey) {
        rejected.push({
          path: `memory.${name}`,
          reason: `长期记忆只能写在当前会话（${activeLabel(currentSessionKey)}）名下，不能替别的会话写`,
        });
        blockReport[name].rejected += 1;
        continue;
      }
    }
    for (const key of Object.keys(spec)) {
      if (!['add', 'modify', 'delete', 'sensitive'].includes(key)) {
        rejected.push({ path: `memory.${name}.${key}`, reason: '未知操作（可用：add/modify/delete/sensitive）' });
      }
    }

    // 「标成敏感」（`m20991`）：按序号标，**只能加不能去**。它只是把条目锁进本会话，
    // 不会让它更可见，所以交给模型判断是安全的；反过来（解锁）没有入口。
    for (const raw of asArray(spec.sensitive, `memory.${name}.sensitive`, rejected)) {
      const index = Number(raw);
      const target = Number.isInteger(index) && index >= 0 ? list[index] : null;
      if (!target) {
        rejected.push({ path: `memory.${name}.sensitive`, reason: `序号越界（当前 ${list.length} 条）：${raw}`, index: Number.isFinite(index) ? index : null });
        blockReport[name].rejected += 1;
        continue;
      }
      if (ctx.store?.markSensitive?.(target.id, now)) blockReport[name].sensitive += 1;
      else {
        rejected.push({ path: `memory.${name}.sensitive`, reason: '目标条目已不存在' });
        blockReport[name].rejected += 1;
      }
    }

    // **modify 先于 add**（§24.12 验收）：只加不改的记忆库会线性膨胀，而且模型想"纠正上一条"时
    // 如果先 add 再 modify，序号会错位到新加的那条上。
    for (const item of asArray(spec.modify, `memory.${name}.modify`, rejected)) {
      const index = Number(isPlain(item) ? item.index : NaN);
      const content = bounded(isPlain(item) ? item.content : item, MAX_MEMORY_TEXT, `memory.${name}.modify`, rejected);
      if (content === null) {
        // `bounded` 已经把"超长"写进 rejected 了；这里只补计数并跳过。
        blockReport[name].rejected += 1;
        continue;
      }
      const target = Number.isInteger(index) && index >= 0 ? list[index] : null;
      if (!target) {
        rejected.push({ path: `memory.${name}.modify`, reason: `序号越界（当前 ${list.length} 条）：${isPlain(item) ? item.index : item}`, index: isPlain(item) ? item.index : null });
        blockReport[name].rejected += 1;
        continue;
      }
      if (!content) {
        rejected.push({ path: `memory.${name}.modify`, reason: 'content 为空' });
        blockReport[name].rejected += 1;
        continue;
      }
      // `related_users`：模型点名这条记忆讲的是谁（QQ 号列表）。只能**收窄**可见性，不能放宽。
      const rel = relIds(isPlain(item) ? item.related_users : undefined);
      const rec = ctx.store?.modify?.(target.id, {
        text: content,
        refs: base.refs ?? target.refs,
        source: 'model',
        ...(rel.length ? { relatedUsers: rel } : {}),
      }, now);
      if (rec) blockReport[name].modify += 1;
      else {
        rejected.push({ path: `memory.${name}.modify`, reason: '目标条目已不存在' });
        blockReport[name].rejected += 1;
      }
    }

    // 删除按序号从大到小来，免得删掉前面的之后后面全错位。
    for (const raw of asArray(spec.delete, `memory.${name}.delete`, rejected)) {
      const index = Number(raw);
      const target = Number.isInteger(index) && index >= 0 ? list[index] : null;
      if (!target) {
        rejected.push({ path: `memory.${name}.delete`, reason: `序号越界（当前 ${list.length} 条）：${raw}`, index: Number.isFinite(index) ? index : null });
        blockReport[name].rejected += 1;
        continue;
      }
      if (ctx.store?.remove?.(target.id)) blockReport[name].delete += 1;
      else {
        rejected.push({ path: `memory.${name}.delete`, reason: '目标条目已不存在' });
        blockReport[name].rejected += 1;
      }
    }

    for (const raw of asArray(spec.add, `memory.${name}.add`, rejected)) {
      // `short_term.add` 已退役（短期记忆的职能搬到了活跃层，见上方 `active` 的注释）：
      // 历史条目还能改、能删，但不再新增。rejected 在上面已经写过一次，这里只计个数。
      if (name === 'short_term') {
        blockReport[name].rejected += 1;
        continue;
      }
      if (isPlain(raw) && raw.visibility !== undefined) {
        // 硬边界：可见性由代码判定。模型写的值不会生效，但要说出来（不静默）。
        rejected.push({ path: `memory.${name}.add.visibility`, reason: `visibility 由代码按会话推断，忽略模型给的 ${JSON.stringify(raw.visibility)}` });
      }
      if (isPlain(raw) && raw.sensitive === false) {
        // 只能加不能去（`m20991`）：词表命中的内容不能被一句 false 放出去。
        rejected.push({ path: `memory.${name}.add.sensitive`, reason: 'sensitive 只能标成 true（锁定在本会话），不能声明 false' });
      }
      if (isPlain(raw) && raw.related_users !== undefined && !relIds(raw.related_users).length) {
        rejected.push({ path: `memory.${name}.add.related_users`, reason: 'related_users 只认 QQ 号（纯数字）；这条按"不涉及具体的人"写入，跨群仍可见' });
      }
      // 超长在写入前拒绝（`m22989`）：MAX_MEMORY_TEXT=400，报实际长度让模型改短。
      if (tooLong(textOf(raw), MAX_MEMORY_TEXT, `memory.${name}.add`, rejected)) {
        blockReport[name].rejected += 1;
        continue;
      }
      const entry = normalizeEntry(raw, { ...base, block: name });
      if (!entry) {
        rejected.push({ path: `memory.${name}.add`, reason: 'text 为空' });
        blockReport[name].rejected += 1;
        continue;
      }
      const dup = [...(blocks.shortTerm ?? []), ...(blocks.longTerm ?? [])].find((e) => String(e.text ?? '').trim() === entry.text);
      const dedupeBefore = Number(ctx.store?.deduped ?? 0);
      // 可见列表里已有同文本就不必再写库；否则写库，靠 `deduped` 认出"其实库里有这条"——
      // 同一批里前面几行刚写进去的条目就在这一路上（`blocks` 是批开始时的快照）。
      const saved = dup ?? ctx.store?.add?.(entry, { sessionKey, worldKey });
      const existed = Boolean(dup) || Number(ctx.store?.deduped ?? 0) > dedupeBefore;
      if (existed) {
        // 同文本写进 `long_term` ＝ **提升**（`m08521`）：就地把它翻成长期，
        // 而不是像以前那样一句"已有同一条"顶回去——那样模型以为自己在提升，库里其实什么都没变。
        if (name === 'long_term') {
          const verdict = tryPromote(saved, { ...base, store: ctx.store });
          if (verdict.ok) {
            blockReport.long_term.promoted += 1;
            continue;
          }
          rejected.push({ path: 'memory.long_term.add', reason: `已有同一条，且没能提升为长期：${verdict.reason}（${entry.text}）` });
          blockReport.long_term.rejected += 1;
          continue;
        }
        if (dup) {
          rejected.push({ path: `memory.${name}.add`, reason: `已有同一条：${entry.text}` });
          blockReport[name].rejected += 1;
          continue;
        }
        // 库里已经有同一条时如实记成"去重"而不是谎报"加了 1 条"——模型看得到那句话早就记着了。
        blockReport[name].deduped += 1;
        continue;
      }
      blockReport[name].add += 1;
    }
  }

  // 2) 人物档案（§24.2）：这是"跨会话记忆"真正有价值的部分——身份可以跨群，事情不能。
  if (ops.persons !== undefined && ops.persons !== null) {
    if (!isPlain(ops.persons)) {
      rejected.push({ path: 'memory.persons', reason: '必须是 {userId: patch} 对象' });
    } else if (!ctx.profiles) {
      rejected.push({ path: 'memory.persons', reason: '档案层未启用（hub.profiles 不可用）' });
    } else {
      for (const [userId, patch] of Object.entries(ops.persons)) {
        if (!isPlain(patch)) {
          rejected.push({ path: `memory.persons.${userId}`, reason: 'patch 必须是对象' });
          continue;
        }
        for (const key of Object.keys(patch)) {
          if (!PERSON_PATCH_KEYS.includes(key)) rejected.push({ path: `memory.persons.${userId}.${key}`, reason: `未知字段（可用：${PERSON_PATCH_KEYS.join('/')}）` });
        }
        const pctx = { ...base, userId: String(userId), rejected, path: `memory.persons.${userId}` };
        const facts = asArray(patch.facts, `memory.persons.${userId}.facts`, rejected)
          .map((f) => normalizeFact(f, { ...pctx, path: `memory.persons.${userId}.facts` })).filter(Boolean);
        const interests = asArray(patch.interests, `memory.persons.${userId}.interests`, rejected)
          .map((i) => ({ text: bounded(isPlain(i) ? i.text : i, 80, `memory.persons.${userId}.interests`, rejected), at: now }))
          .filter((i) => i.text);
        const commitments = asArray(patch.commitments, `memory.persons.${userId}.commitments`, rejected)
          .map((c) => normalizeCommitment(c, { ...pctx, path: `memory.persons.${userId}.commitments` })).filter(Boolean);
        // 硬边界：纠错必须落 `corrections`（§24.11 第 2 条），不是当作一条普通 fact 收下。
        const corrections = asArray(patch.corrections, `memory.persons.${userId}.corrections`, rejected)
          .map((c) => normalizeCorrection(c, { ...pctx, path: `memory.persons.${userId}.corrections` })).filter(Boolean);
        const out = {};
        if (facts.length) out.facts = facts;
        if (interests.length) out.interests = interests;
        if (commitments.length) out.commitments = commitments;
        if (corrections.length) out.corrections = corrections;
        if (patch.impression !== undefined) {
          const impression = bounded(patch.impression, 200, `memory.persons.${userId}.impression`, rejected);
          if (impression) out.impression = impression;
        }
        if (isPlain(patch.profile)) {
          const profile = {};
          for (const k of ['sex', 'age', 'level', 'avatar']) if (patch.profile[k] !== undefined) profile[k] = patch.profile[k];
          profile.profileAt = now;
          if (Object.keys(profile).length > 1) out.profile = profile;
        }
        if (isPlain(patch.relationship)) {
          const relationship = {};
          if (patch.relationship.closeness !== undefined) relationship.closeness = patch.relationship.closeness;
          if (patch.relationship.tone !== undefined) relationship.tone = patch.relationship.tone;
          if (Object.keys(relationship).length) out.relationship = relationship;
        }
        if (!Object.keys(out).length) {
          rejected.push({ path: `memory.persons.${userId}`, reason: 'patch 里没有可写入的字段' });
          continue;
        }
        ctx.profiles.upsertPerson(userId, out, now);
        personReport[String(userId)] = { facts: facts.length, interests: interests.length, commitments: commitments.length, corrections: corrections.length, impression: out.impression ? 1 : 0 };
        applied.persons += 1;
      }
    }
  }

  // 2.5) 群档案与话题（§24.2）。**模型能写的只有"提炼"字段**：群的规矩、文化、出过什么事，
  // 以及一个话题的结论。群名/人数/群主/公告这些是"看到的"，只由代码从实现端观测写入——
  // 让模型去写它们，等于允许它凭印象编造一个不存在的群规。
  const groupReport = {};
  if (ops.groups !== undefined && ops.groups !== null) {
    if (!isPlain(ops.groups)) {
      rejected.push({ path: 'memory.groups', reason: '必须是对象 {<worldKey>: {culture?}}' });
    } else {
      for (const [worldKey, patch] of Object.entries(ops.groups)) {
        if (!isPlain(patch)) {
          rejected.push({ path: `memory.groups.${worldKey}`, reason: '必须是对象' });
          continue;
        }
        for (const key of Object.keys(patch)) {
          if (!GROUP_PATCH_KEYS.includes(key)) rejected.push({ path: `memory.groups.${worldKey}.${key}`, reason: `未知字段（可用：${GROUP_PATCH_KEYS.join('/')}）` });
        }
        const out = {};
        if (patch.culture !== undefined) {
          const culture = bounded(patch.culture, 300, `memory.groups.${worldKey}.culture`, rejected);
          if (culture) out.culture = culture;
        }
        // `highlights` 在 `m17909` 删掉了（跟长期记忆重复、只有一行、检索不到）：
        // 写它会被当成未知字段拒绝，旧文件里残留的读进来也会被清掉。
        if (!Object.keys(out).length) {
          rejected.push({ path: `memory.groups.${worldKey}`, reason: 'patch 里没有可写入的字段（可用：culture）' });
          continue;
        }
        ctx.profiles.upsertGroup(String(worldKey), out, now);
        groupReport[String(worldKey)] = { culture: out.culture ? 1 : 0 };
        applied.groups += 1;
      }
    }
  }

  const topicReport = {};
  if (ops.topics !== undefined && ops.topics !== null) {
    if (!isPlain(ops.topics)) {
      rejected.push({ path: 'memory.topics', reason: '必须是对象 {<topicId>: {title?,status?,conclusion?,worldKeys?,members?,events?}}' });
    } else {
      for (const [topicId, patch] of Object.entries(ops.topics)) {
        if (!isPlain(patch)) {
          rejected.push({ path: `memory.topics.${topicId}`, reason: '必须是对象' });
          continue;
        }
        for (const key of Object.keys(patch)) {
          if (!TOPIC_PATCH_KEYS.includes(key)) rejected.push({ path: `memory.topics.${topicId}.${key}`, reason: `未知字段（可用：${TOPIC_PATCH_KEYS.join('/')}）` });
        }
        const out = {};
        if (patch.title !== undefined) {
          const title = bounded(patch.title, 300, `memory.topics.${topicId}.title`, rejected);
          if (title) out.title = title;
        }
        if (patch.conclusion !== undefined) {
          const conclusion = bounded(patch.conclusion, 300, `memory.topics.${topicId}.conclusion`, rejected);
          if (conclusion) out.conclusion = conclusion;
        }
        if (patch.status !== undefined) out.status = patch.status === 'closed' ? 'closed' : 'open';
        if (Array.isArray(patch.worldKeys)) out.worldKeys = patch.worldKeys.map(String);
        if (Array.isArray(patch.members)) out.members = patch.members.map(String);
        const events = asArray(patch.events, `memory.topics.${topicId}.events`, rejected)
          .map((e) => ({ text: bounded(isPlain(e) ? e.text : e, 300, `memory.topics.${topicId}.events`, rejected), at: now, refs: (isPlain(e) && e.refs) || ctx.refs || null }))
          .filter((e) => e.text);
        if (events.length) out.events = events;
        if (!Object.keys(out).length) {
          rejected.push({ path: `memory.topics.${topicId}`, reason: 'patch 里没有可写入的字段' });
          continue;
        }
        ctx.profiles.upsertTopic(String(topicId), { ...out, refs: ctx.refs ?? null }, now);
        topicReport[String(topicId)] = { status: out.status ?? null, events: events.length };
        applied.topics += 1;
      }
    }
  }

  // 3) 自我档案（`self.json`）：我说过什么、错过什么、偏好什么，以及"在这个群里我叫什么"。
  let selfOut = null;
  if (ops.self !== undefined && ops.self !== null) {
    if (!isPlain(ops.self)) {
      rejected.push({ path: 'memory.self', reason: '必须是对象' });
    } else {
      for (const key of Object.keys(ops.self)) {
        if (!SELF_PATCH_KEYS.includes(key)) rejected.push({ path: `memory.self.${key}`, reason: `未知字段（可用：${SELF_PATCH_KEYS.join('/')}）` });
      }
      const patch = {};
      const statements = asArray(ops.self.myStatements, 'memory.self.myStatements', rejected)
        .map((s) => ({ what: bounded(isPlain(s) ? s.what : s, MAX_FACT_TEXT, 'memory.self.myStatements', rejected), refs: isPlain(s) && s.refs ? s.refs : base.refs, at: now }))
        .filter((s) => s.what);
      const mistakes = asArray(ops.self.mistakes, 'memory.self.mistakes', rejected)
        .map((s) => ({ what: bounded(isPlain(s) ? s.what : s, MAX_FACT_TEXT, 'memory.self.mistakes', rejected), refs: isPlain(s) && s.refs ? s.refs : base.refs, at: now }))
        .filter((s) => s.what);
      const preferences = asArray(ops.self.preferences, 'memory.self.preferences', rejected)
        .map((s) => ({ text: bounded(isPlain(s) ? s.text : s, 120, 'memory.self.preferences', rejected), at: now }))
        .filter((s) => s.text);
      if (statements.length) patch.myStatements = statements;
      if (mistakes.length) patch.mistakes = mistakes;
      if (preferences.length) patch.preferences = preferences;
      if (isPlain(ops.self.myNames)) {
        patch.myNames = {};
        for (const [k, v] of Object.entries(ops.self.myNames)) {
          const name = bounded(v, 40, `memory.self.myNames.${k}`, rejected);
          if (name) patch.myNames[k] = name;
        }
        if (!Object.keys(patch.myNames).length) delete patch.myNames;
      }
      if (ctx.profiles && Object.keys(patch).length) {
        selfOut = ctx.profiles.upsertSelf(patch, now);
        applied.self += 1;
      } else if (!ctx.profiles) {
        rejected.push({ path: 'memory.self', reason: '档案层未启用（hub.profiles 不可用）' });
      }
    }
  }

  applied.short_term = blockReport.short_term;
  applied.long_term = blockReport.long_term;
  applied.active = activeReport;
  return {
    ok: true,
    at: now,
    scope,
    blocks: blockReport,
    active: activeReport,
    persons: personReport,
    groups: groupReport,
    topics: topicReport,
    self: selfOut ? { statements: selfOut.myStatements?.length ?? 0, mistakes: selfOut.mistakes?.length ?? 0 } : null,
    rejected,
    applied,
  };
}

/**
 * 活跃层的三个操作（`m17909`）：`add` / `update` / `settle`。
 *
 * 序号引用的是**模型看得见的那份列表**（`ctx.activeBlocks.entries`，与装配层同源），
 * 所以越界就是越界，不做模糊匹配——写错一行 = 改到别人的话题上。
 *
 * 两条硬边界：
 *  1. **写入只认来源会话**：`entry.originScope` 必须等于当前 `scope`。别的群正在做的事
 *     可以看见（共享），但不能替它改、更不能替它结算——否则 B 群一句话就能把 A 群的话题删掉。
 *  2. **可见性由代码算**，模型说不了，活跃层这里连参数都不给它。
 *
 * 结算（`settle`）是这一层唯一的出口：
 *  - `drop` → 直接删，不留痕；
 *  - `keep` → **必填 `summary`**，写成一行长期记忆索引（带 `related_users`，
 *    这样"相关群友标记"才真的决定它能不能跨群）；`keep_as` 再把细节落进档案
 *    （话题归档 / 人物档案 / 群档案 culture），允许一次落两处。
 *
 * 为什么 keep 一定要进长期记忆（`m18037` 用户原话："所有需要长期保存的记忆都需要进 long_term，
 * 具体细节可以保留在档案里，但需要在长期记忆里让 agent 知道有这个事情"）：档案不进 prompt，
 * 只进档案 = agent 根本不知道发生过这件事，也就永远不会去查。
 */
function applyActiveOps(spec, ctx = {}) {
  const {
    rejected = [],
    report = { add: 0, update: 0, settle: { keep: 0, drop: 0 }, rejected: 0 },
    active = null,
    profiles = null,
    store = null,
    now = Date.now(),
    scope = '',
    sessionKey = '',
    worldKey = '',
    base = {},
  } = ctx;
  const root = 'memory.active';
  if (!isPlain(spec)) {
    rejected.push({ path: root, reason: '必须是对象 {add,update,settle}' });
    report.rejected += 1;
    return;
  }
  for (const key of Object.keys(spec)) {
    if (!['add', 'update', 'settle'].includes(key)) rejected.push({ path: `${root}.${key}`, reason: '未知操作（可用：add/update/settle）' });
  }
  if (!active) {
    rejected.push({ path: root, reason: '活跃层未启用（hub.active 不可用）' });
    report.rejected += 1;
    return;
  }
  // 活跃层只准写在**当前这一轮所在的会话**名下：模型不能替别的群开话题。
  // （长期记忆同理，闸在 `applyMemoryOps` 的块循环里；人物档案不受限——那是"记住某个人的事"。）
  const currentSessionKey = String(ctx.currentSessionKey ?? '');
  if (currentSessionKey && sessionKey && currentSessionKey !== sessionKey) {
    rejected.push({
      path: root,
      reason: `活跃层只能写在当前会话（${activeLabel(currentSessionKey)}）名下，不能替别的会话写`,
    });
    report.rejected += 1;
    return;
  }
  const visible = Array.isArray(ctx.activeBlocks?.entries) ? ctx.activeBlocks.entries : [];
  const pick = (index) => {
    const n = Number(index);
    return Number.isInteger(n) && n >= 0 && n < visible.length ? visible[n] : null;
  };
  const mismatch = (path, entry) => {
    rejected.push({
      path,
      reason: `这条记在 ${activeLabel(entry.originScope)} 名下，只能由那个会话改/结算（现在在 ${activeLabel(scope)}）`,
    });
    report.rejected += 1;
  };

  for (const raw of asArray(spec.add, `${root}.add`, rejected)) {
    const item = isPlain(raw) ? raw : { text: raw };
    const text = textOf(item);
    if (!text) {
      rejected.push({ path: `${root}.add`, reason: 'text 为空' });
      report.rejected += 1;
      continue;
    }
    if (tooLong(text, MAX_ACTIVE_TEXT, `${root}.add`, rejected)) {
      report.rejected += 1;
      continue;
    }
    if (item.kind !== undefined && !ACTIVE_KINDS.includes(item.kind)) {
      rejected.push({ path: `${root}.add.kind`, reason: `只认 ${ACTIVE_KINDS.join('/')}（topic＝进行中的话题，task＝我正在做的事）` });
      report.rejected += 1;
      continue;
    }
    // 「跟谁有关」只认 QQ 号（`m21098` 自审）：以前非数字的写了会被 `qqIds` 静默丢掉，
    // 模型以为标上了，结算时却变成"跟谁都不相关"的索引行——那是 `shareable`，会被念到别的群去。
    // 宁可在这里说一句「这几个我忽略了」，也别让它悄悄 fail-open。
    const asked = Array.isArray(item.participants)
      ? item.participants
      : (Array.isArray(item.related_users) ? item.related_users : []);
    const dropped = asked.filter((p) => !/^\d{5,12}$/.test(String(p ?? '').trim()));
    if (dropped.length) {
      rejected.push({
        path: `${root}.add.participants`,
        reason: `participants 只认 QQ 号，这几个被忽略：${dropped.join('、')}（这条仍然写进去了；`
          + '不写参与者＝"跟谁都不相关"，结算出来的索引行会被念到别的群）',
      });
    }
    const res = active.add(
      {
        kind: item.kind,
        text,
        originScope: scope,
        participants: item.participants ?? item.related_users,
        // 敏感标记（m21098）：活跃条目也允许模型自己说“这件事别外传”，口径与长期记忆一致——只能加不能去。
        sensitive: item.sensitive === true,
      },
      now,
    );
    if (!res.ok) {
      rejected.push({ path: `${root}.add`, reason: res.reason });
      report.rejected += 1;
      continue;
    }
    report.add += 1;
  }

  for (const raw of asArray(spec.update, `${root}.update`, rejected)) {
    if (!isPlain(raw)) {
      rejected.push({ path: `${root}.update`, reason: '必须是 {index, text}' });
      report.rejected += 1;
      continue;
    }
    const entry = pick(raw.index);
    if (!entry) {
      rejected.push({ path: `${root}.update`, reason: `序号越界（当前 ${visible.length} 条）：${raw.index}`, index: raw.index ?? null });
      report.rejected += 1;
      continue;
    }
    if (entry.originScope !== scope) {
      mismatch(`${root}.update`, entry);
      continue;
    }
    const text = textOf(raw.text ?? raw.content);
    if (!text) {
      rejected.push({ path: `${root}.update`, reason: 'text 为空（要改正文就给新正文）' });
      report.rejected += 1;
      continue;
    }
    if (tooLong(text, MAX_ACTIVE_TEXT, `${root}.update`, rejected)) {
      report.rejected += 1;
      continue;
    }
    const res = active.update(entry.id, { text, participants: raw.participants }, now);
    if (!res.ok) {
      rejected.push({ path: `${root}.update`, reason: res.reason });
      report.rejected += 1;
      continue;
    }
    report.update += 1;
  }

  // 同一批里同一个序号只能结算一次（`m21098` 自审）：`visible` 是批开始时的快照，
  // `active.remove()` 不会把它改掉，于是第二次 `pick(0)` 还是同一条——会重复写索引行、重复计数。
  const settledIds = new Set();

  for (const raw of asArray(spec.settle, `${root}.settle`, rejected)) {
    if (!isPlain(raw)) {
      rejected.push({ path: `${root}.settle`, reason: '必须是 {index, outcome, summary?, keep_as?}' });
      report.rejected += 1;
      continue;
    }
    const entry = pick(raw.index);
    if (!entry) {
      rejected.push({ path: `${root}.settle`, reason: `序号越界（当前 ${visible.length} 条）：${raw.index}`, index: raw.index ?? null });
      report.rejected += 1;
      continue;
    }
    if (settledIds.has(entry.id)) {
      rejected.push({
        path: `${root}.settle`,
        reason: `第 ${raw.index} 条这一批里已经结算过了（结算一次就够，别重复写索引行）`,
        index: raw.index ?? null,
      });
      report.rejected += 1;
      continue;
    }
    if (entry.originScope !== scope) {
      mismatch(`${root}.settle`, entry);
      continue;
    }
    const outcome = raw.outcome === 'keep' ? 'keep' : raw.outcome === 'drop' ? 'drop' : '';
    if (!outcome) {
      rejected.push({ path: `${root}.settle.outcome`, reason: "只认 keep（存成长期记忆）或 drop（删掉）" });
      report.rejected += 1;
      continue;
    }
    if (outcome === 'drop') {
      settledIds.add(entry.id);
      active.remove(entry.id);
      report.settle.drop += 1;
      continue;
    }

    // keep：先保证长期记忆里有那一行索引，再谈细节落哪。
    const summary = textOf(raw.summary ?? raw.text);
    if (!summary) {
      rejected.push({
        path: `${root}.settle.summary`,
        reason: 'keep 必须给 summary（一句话写进长期记忆，否则以后没人知道发生过这件事）；只想删就用 drop',
      });
      report.rejected += 1;
      continue;
    }
    if (tooLong(summary, MAX_MEMORY_TEXT, `${root}.settle.summary`, rejected)) {
      report.rejected += 1;
      continue;
    }
    const rel = relIds([...(entry.participants ?? []), ...relIds(raw.related_users)]);
    // 索引那一行**先记着，等档案落完再写**（`m20216`）：这一行要带上"详情在哪份档案里"
    // 的指针，否则模型以后只看得见"发生过这件事"，不知道该 `onebot_topic` 查哪个 id。
    // 顺序反过来（先写行再落档）就只能再回去改那一行，而 modify 是按序号寻址的，脆。
    let pointer = normalizeEntry(
      { text: summary, related_users: rel },
      { ...base, scope: entry.originScope, block: 'long_term' },
    );

    // 细节去处（可一次落两处，`m18092` ③）：每处失败只记 rejected，不影响索引那一行。
    // 单个对象也收（模型经常只写一处，逼它套一层数组纯属找茬）。
    const keepRaw = raw.keep_as ?? raw.keepAs;
    const targets = isPlain(keepRaw) ? [keepRaw] : asArray(keepRaw, `${root}.settle.keep_as`, rejected);
    const archive = [];
    for (const t of targets) {
      if (!isPlain(t)) {
        rejected.push({ path: `${root}.settle.keep_as`, reason: '必须是 {target, …}' });
        continue;
      }
      const target = String(t.target ?? '');
      const detail = textOf(t.text ?? t.conclusion ?? t.summary) || summary;
      if (!profiles) {
        rejected.push({ path: `${root}.settle.keep_as`, reason: '档案层未启用（hub.profiles 不可用）' });
        continue;
      }
      if (target === 'topic' || target === 'topic_archive') {
        // id 优先取模型给的名字/标题：档案是靠 `onebot_topic <id>` 查的，
        // 用内部 id 也能存，但模型下次就不知道该查什么了。
        const id = String(t.id ?? t.topic_id ?? t.title ?? t.name ?? entry.id);
        const title = bounded(t.title ?? t.name ?? detail, 300, `${root}.settle.keep_as.title`, rejected);
        const conclusion = bounded(t.conclusion ?? detail, 300, `${root}.settle.keep_as.conclusion`, rejected);
        const events = asArray(t.events, `${root}.settle.keep_as.events`, rejected)
          .map((e) => ({ text: bounded(isPlain(e) ? e.text : e, 300, `${root}.settle.keep_as.events`, rejected), at: now, refs: base.refs ?? null }))
          .filter((e) => e.text);
        const members = [...new Set([...(entry.participants ?? []), ...(Array.isArray(t.members) ? t.members.map(String) : [])])].slice(0, 20);
        profiles.upsertTopic(id, {
          title,
          status: 'closed',
          conclusion,
          worldKeys: [entry.originScope],
          members,
          events: events.length ? events : [{ text: detail, at: now, refs: base.refs ?? null }],
          refs: base.refs ?? null,
        }, now);
        archive.push({ target: 'topic', id });
      } else if (target === 'person') {
        const userId = String(t.user_id ?? t.userId ?? '').trim();
        if (!/^\d{5,12}$/.test(userId)) {
          rejected.push({ path: `${root}.settle.keep_as.user_id`, reason: 'person 目标要给数字 QQ 号' });
          continue;
        }
        const fact = bounded(t.text ?? detail, MAX_FACT_TEXT, `${root}.settle.keep_as.text`, rejected);
        if (fact) {
          profiles.upsertPerson(userId, { facts: [{ text: fact, at: now, refs: base.refs ?? null }] }, now);
          archive.push({ target: 'person', userId });
        }
      } else if (target === 'group') {
        const gk = String(t.world_key ?? t.worldKey ?? entry.originScope);
        const culture = bounded(t.text ?? t.culture ?? detail, 300, `${root}.settle.keep_as.text`, rejected);
        if (culture) {
          profiles.upsertGroup(gk, { culture }, now);
          archive.push({ target: 'group', worldKey: gk });
        }
      } else {
        rejected.push({
          path: `${root}.settle.keep_as.target`,
          reason: "只认 topic（话题归档）/ person（人物档案）/ group（群档案 culture）；长期记忆那一行索引总是会写",
        });
      }
    }
    // 档案落完了，现在把索引那一行写下去，并**带上指针**（`m20216`）：
    // 「换显卡定了 850W〔详见 话题：显卡选购〕」——一句话是索引，方括号是路。
    // 只带真的落成的目标（`archive` 里是成功的那些），失败的别给模型指一条不存在的路。
    if (archive.length) {
      pointer = normalizeEntry(
        { text: summary, related_users: rel, archive },
        { ...base, scope: entry.originScope, block: 'long_term' },
      );
    }
    if (pointer && store?.add) store.add(pointer, { sessionKey, worldKey });
    settledIds.add(entry.id);
    active.remove(entry.id);
    report.settle.keep += 1;
    report.lastKeep = { text: entry.text, summary, archive };
  }
}


function asArray(value, path, rejected) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    rejected.push({ path, reason: '必须是数组' });
    return [];
  }
  return value;
}
