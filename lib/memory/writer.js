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
 *   "short_term": {"add": [{"text": "…"}], "modify": [{"index": 0, "content": "…"}], "delete": [1]},
 *   "long_term":  {"add": [{"text": "…"}]},
 *   "persons": {"10001": {"facts": [{"text": "…"}], "interests": [], "commitments": [{"what": "…", "due": 1730000000000}],
 *                          "corrections": [{"wrong": "…", "right": "…"}], "impression": "…", "relationship": {"closeness": 2}}},
 *   "groups": {"group:55555": {"culture": "这个群爱聊硬件，不喜欢刷屏", "highlights": [{"text": "上次的抽奖取消了"}]}},
 *   "topics": {"散热改装": {"title": "散热改装", "status": "open", "worldKeys": ["group:55555"], "events": [{"text": "讨论到风扇型号"}]}},
 *   "self": {"myStatements": [{"what": "…"}], "mistakes": [], "preferences": [], "myNames": {"group:55555": "小助"}}
 * }
 * ```
 *
 * 群档案里模型只能写 `culture`/`highlights`：群名、人数、群主、公告是**观测**来的，
 * 只由代码从实现端写入——让模型写它们，等于允许它凭印象编造一条不存在的群规。
 *
 * `index` 指向**装配时渲染出来的那一份列表的序号**（短期与长期各自从 0 开始），
 * 也就是"模型确实看见过的那几条"——这正是它唯一有资格改的集合。
 */

import { inferScope, isSensitive, filterForScope } from './isolation.js';

export const MAX_MEMORY_TEXT = 400;
export const MAX_FACT_TEXT = 300;
export const MEMORY_BLOCKS = ['short_term', 'long_term'];
export const PERSON_PATCH_KEYS = ['facts', 'interests', 'commitments', 'corrections', 'impression', 'profile', 'relationship'];
export const SELF_PATCH_KEYS = ['myStatements', 'mistakes', 'preferences', 'myNames'];
/** 群档案里**模型可以写**的只有提炼字段；群名/人数/群主/公告是观测所得，只能由代码写。 */
export const GROUP_PATCH_KEYS = ['culture', 'highlights'];
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
 * 短期＝本会话/本世界看得见的那批；长期＝跨会话可见的那批（身份与其他会话里说过、被允许复用的事实）。
 */
export function memoryBlocks(entries = [], ctx = {}) {
  const filtered = filterForScope(entries, ctx);
  const sessionKey = String(ctx.sessionKey ?? '');
  const worldKey = String(ctx.worldKey ?? '');
  const same = (e) => {
    const s = String(e?.scope ?? '');
    return (sessionKey && s === sessionKey) || (worldKey && s === worldKey);
  };
  const shortTerm = filtered.visible.filter(same);
  const longTerm = filtered.visible.filter((e) => !same(e));
  return { ...filtered, shortTerm, longTerm };
}

/**
 * 可见性推断——**唯一**允许决定"这条能不能跨会话说"的地方。
 * 私聊来源一律 `private`；敏感内容一票否决（连代码也不升格）；公开群里明确标"长期"的才 `shareable`。
 */
export function inferWriteVisibility({ block = 'short_term', scope = '', sessionKey = '', text = '' } = {}) {
  const s = String(sessionKey ?? '');
  if (String(scope).startsWith('private:') || s.startsWith('private:')) return 'private';
  if (isSensitive({ text })) return scope || 'private';
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
  const visibility = inferWriteVisibility({ block, scope, sessionKey, text });
  return {
    kind: block === 'long_term' ? 'fact' : (ctx.kind ?? 'fact'),
    scope,
    worldKey: worldKey || null,
    actor: ctx.actor ?? (ctx.actorId !== undefined && ctx.actorId !== null ? { user_id: ctx.actorId } : null),
    text,
    refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null),
    visibility,
    confidence: isPlain(raw) && raw.confidence !== undefined ? clamp01(raw.confidence) : undefined,
    source: ctx.source ?? 'model',
  };
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
  const visibility = inferWriteVisibility({ block: 'long_term', scope: ctx.scope, sessionKey: ctx.sessionKey, text });
  return {
    text,
    refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null),
    confidence: isPlain(raw) && raw.confidence !== undefined ? clamp01(raw.confidence) : undefined,
    visibility,
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
  const applied = { short_term: { add: 0, modify: 0, delete: 0 }, long_term: { add: 0, modify: 0, delete: 0 }, persons: 0, groups: 0, topics: 0, self: 0 };
  const blockReport = { short_term: { add: 0, modify: 0, delete: 0, deduped: 0, rejected: 0 }, long_term: { add: 0, modify: 0, delete: 0, deduped: 0, rejected: 0 } };
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
    if (!['short_term', 'long_term', 'persons', 'groups', 'topics', 'self'].includes(key)) {
      rejected.push({ path: `memory.${key}`, reason: '未知字段（可用：short_term/long_term/persons/groups/topics/self）' });
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
    for (const key of Object.keys(spec)) {
      if (!['add', 'modify', 'delete'].includes(key)) {
        rejected.push({ path: `memory.${name}.${key}`, reason: '未知操作（可用：add/modify/delete）' });
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
      const rec = ctx.store?.modify?.(target.id, { text: content, refs: base.refs ?? target.refs, source: 'model' }, now);
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
      if (isPlain(raw) && raw.visibility !== undefined) {
        // 硬边界：可见性由代码判定。模型写的值不会生效，但要说出来（不静默）。
        rejected.push({ path: `memory.${name}.add.visibility`, reason: `visibility 由代码按会话推断，忽略模型给的 ${JSON.stringify(raw.visibility)}` });
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
      const dup = [...(blocks.shortTerm ?? []), ...(blocks.longTerm ?? [])].some((e) => String(e.text ?? '').trim() === entry.text);
      if (dup) {
        rejected.push({ path: `memory.${name}.add`, reason: `已有同一条：${entry.text}` });
        blockReport[name].rejected += 1;
        continue;
      }
      // 库里已经有同一条时，`store.add` 会折叠（不新增条目）并把 `deduped` 加一：这里如实记成
      // "去重"而不是谎报"加了 1 条"——模型看得到自己那句话早就记着了。
      const dedupeBefore = Number(ctx.store?.deduped ?? 0);
      ctx.store?.add?.(entry, { sessionKey, worldKey });
      if (Number(ctx.store?.deduped ?? 0) > dedupeBefore) blockReport[name].deduped += 1;
      else blockReport[name].add += 1;
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
      rejected.push({ path: 'memory.groups', reason: '必须是对象 {<worldKey>: {culture?, highlights?}}' });
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
        const highlights = asArray(patch.highlights, `memory.groups.${worldKey}.highlights`, rejected)
          .map((h) => ({ text: bounded(isPlain(h) ? h.text : h, 200, `memory.groups.${worldKey}.highlights`, rejected), at: now, refs: (isPlain(h) && h.refs) || ctx.refs || null }))
          .filter((h) => h.text);
        if (highlights.length) out.highlights = highlights;
        if (!Object.keys(out).length) {
          rejected.push({ path: `memory.groups.${worldKey}`, reason: 'patch 里没有可写入的字段' });
          continue;
        }
        ctx.profiles.upsertGroup(String(worldKey), out, now);
        groupReport[String(worldKey)] = { culture: out.culture ? 1 : 0, highlights: highlights.length };
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
  return {
    ok: true,
    at: now,
    scope,
    blocks: blockReport,
    persons: personReport,
    groups: groupReport,
    topics: topicReport,
    self: selfOut ? { statements: selfOut.myStatements?.length ?? 0, mistakes: selfOut.mistakes?.length ?? 0 } : null,
    rejected,
    applied,
  };
}

function asArray(value, path, rejected) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    rejected.push({ path, reason: '必须是数组' });
    return [];
  }
  return value;
}
