/** Validate and apply agent memory updates. Old active rows remain on disk, not writable. */
import { inferScope, isSensitive, filterForScope } from './isolation.js';
import { activeLabel } from './active.js';
import { trimTopics } from './rank.js';
import { isTopicScope, topicEvidenceRef } from './topic-input.js';

export const MAX_MEMORY_TEXT = 400;
export const MAX_FACT_TEXT = 300;
export const MEMORY_BLOCKS = ['short_term', 'long_term'];
export const PERSON_PATCH_KEYS = ['facts', 'interests', 'corrections', 'impression', 'profile', 'relationship'];
export const SELF_PATCH_KEYS = ['mistakes', 'preferences', 'myNames'];
/** 群档案里**模型可以写**的只有提炼字段；群名/人数/群主/公告是观测所得，只能由代码写。 */
export const GROUP_PATCH_KEYS = ['agreements', 'style'];
/** 同一个会话内沿用话题 id；会话归属和原始证据由运行时确认。 */
export const TOPIC_PATCH_KEYS = ['title', 'aliases', 'status', 'conclusion', 'unresolved', 'worldKeys', 'members', 'events', 'evidenceIds'];

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
  // 点名失败（`m03888` 用户定）：给了名单却解析不出号码（写的是名字、或者混了非号码），
  // 以前是**静默丢掉**——于是这条记忆变成"没点名"，会在别的群里被原样念出来，
  // 比模型以为的开放得多。现在按隐私算：锁在本会话，代价是它不外传，而不是它乱外传。
  const relRaw = isPlain(raw) && Array.isArray(raw.related_users) ? raw.related_users : [];
  const relatedUsers = relIds(relRaw);
  // 只数**真的解析不出**的项。用 `relRaw.length - relatedUsers.length` 会把重复项和
  // 超出 12 个上限的那些也算成失败，于是正常的写法（点同一个人两次）也会被锁进单会话。
  const relDropped = relRaw.filter((x) => {
    const v = String(x ?? '').trim();
    return !v || !/^\d+$/.test(v);
  }).length;
  if (relDropped > 0 && Array.isArray(ctx.warnings)) {
    ctx.warnings.push(
      `这条记忆的 related_users 里有 ${relDropped} 项点不出 QQ 号（写名字等于没点），已按隐私处理：只留在当前会话；要跨群就改成号码后重写`,
    );
  }
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
    // 解析不出的点名项数（`m03930` 自查）：回执要能说清"为什么这条被锁进了单会话"。
    ...(relDropped > 0 ? { relDropped } : {}),
    ...(archive.length ? { archive } : {}),
    // 「这条敏感」可以由模型自己说（`m20991` 用户要求）：它只会**收窄**可见性（锁定在本会话），
    // 所以是安全的；反向（`sensitive:false` 解锁）在 `applyMemoryOps` 里明确拒绝——
    // 词表命中的内容不能被一句 false 放出去。`store.normalize` 会把这里与词表结果取「或」。
    ...(isPlain(raw) && raw.sensitive === true ? { sensitive: true } : {}),
    // 点名失败 = 当敏感处理（只收窄，不外放）；`relDropped` 跟着走，回执要能说清为什么锁了。
    ...(relDropped > 0 ? { sensitive: true, relDropped } : {}),
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

const collectBatchTopics = (ops) => trimTopics(isPlain(ops?.topics) ? Object.keys(ops.topics) : []);

const sourceActor = (ctx) => ({ user_id: String(ctx.scope?.startsWith('private:') ? ctx.scope.slice(8) : ctx.actorId ?? '') });

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
    actor: sourceActor(ctx),
    ...(raw?.sensitive === true && { sensitive: true }),
    at: ctx.now,
    // 同一批 settle 里写的话题（`m03601`）：以后排序时"这条事实属于当前这件事"就靠它。
    // 没有就是没有——老数据没有这个字段，排序会自然退化成按时间。
    ...(Array.isArray(ctx.batchTopics) && ctx.batchTopics.length ? { topics: trimTopics(ctx.batchTopics) } : {}),
  };
}

function normalizeCorrection(raw, ctx) {
  const wrong = isPlain(raw) ? String(raw.wrong ?? '').trim() : '';
  const right = String(isPlain(raw) ? raw.right ?? '' : raw ?? '').trim();
  if (tooLong(wrong, MAX_FACT_TEXT, ctx.path ?? 'corrections', ctx.rejected ?? []) || tooLong(right, MAX_FACT_TEXT, ctx.path ?? 'corrections', ctx.rejected ?? [])) return null;
  if (!right) return null;
  return { wrong: wrong || null, right, relatedUsers: [ctx.userId], actor: sourceActor(ctx), ...(raw?.sensitive === true && { sensitive: true }), refs: isPlain(raw) && raw.refs ? raw.refs : (ctx.refs ?? null), scope: ctx.scope, at: ctx.now };
}

function writeScopedTopic(rawId, patch, ctx) {
  const { profiles, scope, sessionKey, currentSessionKey, topicSessionKey = currentSessionKey, now, path, rejected } = ctx;
  const reject = (field, reason) => { rejected.push({ path: field ? `${path}.${field}` : path, reason }); return null; };
  if (!isTopicScope(scope) || scope !== sessionKey || scope !== topicSessionKey) {
    return reject('', '话题只能写在当前群或私聊，不能指定其它会话作为来源');
  }
  if (typeof profiles?.upsertScopedTopic !== 'function') return reject('', '话题档案不可用');
  if (!isPlain(patch)) return reject('', '必须是对象');
  const id = String(rawId ?? '').trim();
  if (!id || /[\u0000-\u001f\u007f]/.test(id) || tooLong(id, 96, `${path}.id`, rejected)) {
    if (!id || /[\u0000-\u001f\u007f]/.test(id)) return reject('id', '话题 ID 必须是非空单行文本');
    return null;
  }
  const before = rejected.length;
  for (const key of Object.keys(patch)) {
    if (!TOPIC_PATCH_KEYS.includes(key)) reject(key, `未知字段（可用：${TOPIC_PATCH_KEYS.join('/')}）`);
  }
  if (patch.worldKeys !== undefined && (!Array.isArray(patch.worldKeys) || patch.worldKeys.some((key) => key !== scope))) {
    reject('worldKeys', '只接受本会话；话题归属由枢纽绑定');
  }
  const out = {};
  for (const key of ['title', 'conclusion']) {
    if (patch[key] === undefined) continue;
    if (key === 'conclusion' && patch[key] === null) { out[key] = null; continue; }
    if (typeof patch[key] !== 'string') { reject(key, key === 'conclusion' ? '必须是文本，或用 null 清除当前结论' : '必须是文本'); continue; }
    const text = bounded(patch[key], 300, `${path}.${key}`, rejected);
    if (text) out[key] = text;
    else if (text === '') reject(key, '不能为空');
  }
  if (patch.status !== undefined) {
    if (patch.status === 'open' || patch.status === 'closed') out.status = patch.status;
    else reject('status', '只认 open 或 closed');
  }
  for (const [key, cap, max] of [['aliases', 8, 40], ['unresolved', 8, 160], ['members', 20, 20], ['events', 8, 300], ['evidenceIds', 12, 160]]) {
    if (patch[key] === undefined) continue;
    if (!Array.isArray(patch[key]) || patch[key].length > cap) { reject(key, `必须是数组，最多 ${cap} 项`); continue; }
    const values = [];
    for (const item of patch[key]) {
      const raw = key === 'events' && isPlain(item) ? item.text : item;
      if (key === 'events' && isPlain(item) && Object.keys(item).some((name) => name !== 'text')) {
        reject(key, '事件只接受 text；原话出处请用 evidenceIds');
        continue;
      }
      if (typeof raw !== 'string' && !(typeof raw === 'number' && (key === 'members' || key === 'evidenceIds'))) {
        reject(key, '项目内容必须是文本或相应的消息/成员编号');
        continue;
      }
      const text = bounded(raw, max, `${path}.${key}`, rejected);
      if (!text) { if (text === '') reject(key, '项目不能为空'); continue; }
      if (key === 'members' && !/^\d+$/.test(text)) { reject(key, '成员只认数字 QQ 号'); continue; }
      if (!values.includes(text)) values.push(text);
    }
    if (key === 'evidenceIds') {
      const rows = ctx.topicEvidenceOf?.(values) ?? [];
      const verified = rows.filter((row) => row.scope === scope && row.id);
      const recognized = new Set(verified.flatMap((row) => [row.id, row.messageId]));
      if (values.some((value) => !recognized.has(value))) reject(key, '有消息编号无法在当前会话的真实入站消息中验证，未写入话题');
      if (verified.length) {
        out.evidence = verified;
        out.refs = verified.map(topicEvidenceRef);
      }
    } else if (key === 'events') {
      if (values.length) out.events = values.map((text) => ({ text }));
    } else {
      out[key] = values;
    }
  }
  if (rejected.length !== before) return null;
  if (!Object.keys(out).length) return reject('', '没有可写入的字段');
  try {
    // Explicit assertions may be uncited; they never manufacture raw evidence.
    return profiles.upsertScopedTopic(scope, id, out, now, { allowUncited: true })
      ?? reject('', '话题没有保存成功；请检查新话题是否给了标题，或稍后重试');
  } catch {
    return reject('', '话题落盘失败，未确认写入');
  }
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
  /**
   * 这一批 settle 里 agent 自己建/写的话题 id（`m03601`）。
   *
   * 用途只有一个：同一批里写进人物档案的 facts，把它当作"这条事实是从哪件事里聊出来的"。
   * **只连不建**——话题仍然由 agent 自己起（用户定案），这里只是把同一次收尾的两样东西
   * 关联起来，用"批次"当证据，不猜。
   *
   * 必须在写 persons 之前算好：`ops.persons` 在 `ops.topics` 之前处理。
   */
  base.batchTopics = collectBatchTopics(ops);
  const rejected = [];
  /** 不拒绝但必须说出来的一句（点名失败被锁成隐私是典型，`m03930`）。 */
  const warnings = [];
  base.warnings = warnings;
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

  // Reject the retired ledger explicitly; open topics only live in topic cards.
  const activeReport = { add: 0, update: 0, settle: { keep: 0, drop: 0 }, rejected: 0 };
  if (ops.active !== undefined && ops.active !== null) {
    rejected.push({ path: 'memory.active', reason: '活跃层现在只展示本会话的开放话题；用 topics 按同一 ID 更新或结案，不再收待办或结算' });
    activeReport.rejected += 1;
  }
  if (ops.short_term !== undefined && ops.short_term !== null) {
    if (isPlain(ops.short_term) && ops.short_term.add !== undefined) {
      rejected.push({
        path: 'memory.short_term.add',
        reason: '短期记忆不再新增；进行中的事使用本会话的 topics，历史 short_term 条目仍可按 ID 改删',
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
    const displayed = ctx.displayedBlocks ? (name === 'short_term' ? ctx.displayedBlocks.shortTerm : ctx.displayedBlocks.longTerm) ?? [] : list;
    const resolveTarget = (raw) => {
      const obj = isPlain(raw);
      const value = obj ? raw.id ?? raw.index : raw;
      if (obj && raw.id !== undefined && raw.index !== undefined) return null;
      if (typeof value === 'string' && !/^\d+$/.test(value)) return list.find((entry) => entry.id === value) ?? null;
      const idx = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      const id = Number.isSafeInteger(idx) && idx >= 0 ? displayed[idx]?.id : null;
      return id ? list.find((entry) => entry.id === id) ?? null : null;
    };
    // 长期记忆也只准写在**当前这一轮所在的会话**名下（`m28425`）。以前这里的口径是
    // "长期记忆/人物档案不受这条限制"——理由是"记住某个人的事跟会话无关"，但实现上
    // `long_term.add` 的 scope 就是传进来的 `sessionKey`：私聊里带 `sessionKey:"group:X"`
    // 就能往那个群的记忆里种一条，下一轮它会当作"那个群记得的事"注入进去。
    // 人物档案（persons）不在这里判：它的键是人不是会话，写进去本来就跨会话共享。
    {
      const currentSessionKey = String(ctx.currentSessionKey ?? '');
      // 短期块同样要判（P2-18）：它虽已退役成"只读兼容"，但 `modify`/`delete`
      // 还开着——不判的话私聊会话照样能改别的群的历史短期记忆。
      if (currentSessionKey && sessionKey && currentSessionKey !== sessionKey) {
        rejected.push({
          path: `memory.${name}`,
          reason: `${name === 'long_term' ? '长期记忆' : '短期记忆'}只能写在当前会话（${activeLabel(currentSessionKey)}）名下，不能替别的会话写`,
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
      const target = resolveTarget(raw);
      if (!target) {
        rejected.push({ path: `memory.${name}.sensitive`, reason: `目标 ID/原上下文序号不可用（当前 ${list.length} 条，请用 ID）：${raw}`, index: typeof raw === 'number' ? raw : null });
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
      const content = bounded(isPlain(item) ? item.content : item, MAX_MEMORY_TEXT, `memory.${name}.modify`, rejected);
      if (content === null) {
        // `bounded` 已经把"超长"写进 rejected 了；这里只补计数并跳过。
        blockReport[name].rejected += 1;
        continue;
      }
      const target = isPlain(item) ? resolveTarget(item) : null;
      if (!target) {
        rejected.push({ path: `memory.${name}.modify`, reason: `目标 ID/原上下文序号不可用（当前 ${list.length} 条，请用 ID）：${isPlain(item) ? item.index : item}`, index: isPlain(item) ? item.index : null });
        blockReport[name].rejected += 1;
        continue;
      }
      if (!content) {
        rejected.push({ path: `memory.${name}.modify`, reason: 'content 为空' });
        blockReport[name].rejected += 1;
        continue;
      }
      // `related_users`：模型点名这条记忆讲的是谁（QQ 号列表）。只能**收窄**可见性，不能放宽。
      const relRaw = isPlain(item) ? item.related_users : undefined;
      const rel = relIds(relRaw);
      // 与写入侧同一个坑（`m03930`）：点不出号就**什么都不会发生**，而模型以为改了。
      if (relRaw !== undefined && !rel.length) {
        rejected.push({
          path: `memory.${name}.modify.related_users`,
          reason: 'related_users 只认 QQ 号（纯数字）；这些项都点不出号，这次修改没有改动可见性——要把这条锁进本会话请用 memory.long_term.sensitive:[序号]',
        });
      }
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

    // 目标先映射到快照中的稳定 ID，删除顺序不影响其他条目。
    for (const raw of asArray(spec.delete, `memory.${name}.delete`, rejected)) {
      const target = resolveTarget(raw);
      if (!target) {
        rejected.push({ path: `memory.${name}.delete`, reason: `目标 ID/原上下文序号不可用（当前 ${list.length} 条，请用 ID）：${raw}`, index: Number.isSafeInteger(raw) ? raw : null });
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
        // 这句必须与真实后果一致：以前说"跨群仍可见"，而现在（`m03888`）点不出号就按隐私锁起来。
        rejected.push({ path: `memory.${name}.add.related_users`, reason: 'related_users 只认 QQ 号（纯数字）；这些项都点不出号，这条已按隐私处理——只留在当前会话，要跨群请改成号码后重写' });
      }
      // 超长在写入前拒绝（`m22989`）：MAX_MEMORY_TEXT=400，报实际长度让模型改短。
      if (tooLong(textOf(raw), MAX_MEMORY_TEXT, `memory.${name}.add`, rejected)) {
        blockReport[name].rejected += 1;
        continue;
      }
      if (isPlain(raw) && raw.archive !== undefined) {
        rejected.push({ path: 'memory.long_term.add.archive', reason: '话题、人物和群档案不再另存一条长期记忆；请直接维护对应档案' });
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
        if (!isTopicScope(scope) || (ctx.currentSessionKey && ctx.currentSessionKey !== sessionKey)) {
          rejected.push({ path: `memory.persons.${userId}`, reason: '人物档案的事实只能从当前会话写入' });
          continue;
        }
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
          .map((i) => ({
            text: bounded(isPlain(i) ? i.text : i, 80, `memory.persons.${userId}.interests`, rejected),
            // 盖 `scope`：没有它，装配层只能把"这个人在私聊里爱聊什么"原样念给每个群听。
            scope: pctx.scope ?? null,
            relatedUsers: [pctx.userId],
            actor: sourceActor(pctx),
            ...(i?.sensitive === true && { sensitive: true }),
            at: now,
          }))
          .filter((i) => i.text);
        // 硬边界：纠错必须落 `corrections`（§24.11 第 2 条），不是当作一条普通 fact 收下。
        const corrections = asArray(patch.corrections, `memory.persons.${userId}.corrections`, rejected)
          .map((c) => normalizeCorrection(c, { ...pctx, path: `memory.persons.${userId}.corrections` })).filter(Boolean);
        const out = {};
        if (facts.length) out.facts = facts;
        if (interests.length) out.interests = interests;
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
        const { impression, relationship, ...details } = out;
        if (impression !== undefined || relationship !== undefined) details.localNotes = { scope, impression, relationship };
        ctx.profiles.upsertPerson(userId, details, now);
        personReport[String(userId)] = { facts: facts.length, interests: interests.length, corrections: corrections.length, impression: out.impression ? 1 : 0 };
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
      rejected.push({ path: 'memory.groups', reason: '必须是对象 {<当前群会话>: {agreements?,style?}}' });
    } else {
      for (const [worldKey, patch] of Object.entries(ops.groups)) {
        if (!/^group:\d+$/.test(worldKey) || worldKey !== sessionKey || worldKey !== ctx.topicSessionKey || !ctx.profiles) {
          rejected.push({ path: `memory.groups.${worldKey}`, reason: '只能在实际绑定的群里写本群档案' });
          continue;
        }
        if (!isPlain(patch)) {
          rejected.push({ path: `memory.groups.${worldKey}`, reason: '必须是对象' });
          continue;
        }
        for (const key of Object.keys(patch)) {
          if (!GROUP_PATCH_KEYS.includes(key)) rejected.push({ path: `memory.groups.${worldKey}.${key}`, reason: `未知字段（可用：${GROUP_PATCH_KEYS.join('/')}）` });
        }
        const out = {};
        if (patch.style !== undefined) {
          if (patch.style === null) out.style = null;
          else if (typeof patch.style === 'string' && patch.style.trim() && !tooLong(patch.style.trim(), 300, `memory.groups.${worldKey}.style`, rejected)) out.style = patch.style.trim();
          else rejected.push({ path: `memory.groups.${worldKey}.style`, reason: '风格需要非空文字或 null（清除）' });
        }
        if (patch.agreements !== undefined) {
          if (!Array.isArray(patch.agreements) || patch.agreements.length > 12 || patch.agreements.some((s) => typeof s !== 'string' || !s.trim() || s.trim().length > 200)) {
            rejected.push({ path: `memory.groups.${worldKey}.agreements`, reason: '需要完整约定列表，最多 12 条、每条 1–200 字；[] 清空' });
          } else out.agreements = [...new Set(patch.agreements.map((s) => s.trim()))];
        }
        if (!Object.keys(out).length) continue;
        ctx.profiles.upsertGroup(worldKey, out, now);
        groupReport[worldKey] = { ...(Object.hasOwn(out, 'style') && { style: out.style }), ...(out.agreements && { agreements: out.agreements.length }) };
        applied.groups += 1;
      }
    }
  }

  const topicReport = Object.create(null);
  if (ops.topics !== undefined && ops.topics !== null) {
    if (!isPlain(ops.topics)) {
      rejected.push({ path: 'memory.topics', reason: '必须是对象 {<topicId>: {title?,aliases?,status?,conclusion?,unresolved?,events?,evidenceIds?}}' });
    } else {
      for (const [topicId, patch] of Object.entries(ops.topics)) {
        const rec = writeScopedTopic(topicId, patch, { ...ctx, ...base, rejected, path: `memory.topics.${topicId}` });
        if (!rec) continue;
        topicReport[rec.id] = { id: rec.id, status: rec.status, unresolved: rec.unresolved?.length ?? 0 };
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
      const mistakes = asArray(ops.self.mistakes, 'memory.self.mistakes', rejected)
        .map((s) => ({ what: bounded(isPlain(s) ? s.what : s, MAX_FACT_TEXT, 'memory.self.mistakes', rejected), refs: isPlain(s) && s.refs ? s.refs : base.refs, at: now }))
        .filter((s) => s.what);
      const preferences = asArray(ops.self.preferences, 'memory.self.preferences', rejected)
        .map((s) => ({ text: bounded(isPlain(s) ? s.text : s, 120, 'memory.self.preferences', rejected), at: now }))
        .filter((s) => s.text);
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
        const { myStatements: _legacy, ...saved } = ctx.profiles.upsertSelf(patch, now);
        selfOut = saved;
        applied.self += 1;
      } else if (!ctx.profiles) {
        rejected.push({ path: 'memory.self', reason: '档案层未启用（hub.profiles 不可用）' });
      }
    }
  }

  applied.short_term = blockReport.short_term;
  applied.long_term = blockReport.long_term;
  applied.active = activeReport;
  // 点名失败不是"拒绝写入"，是"按隐私锁起来"——不主动说一句，模型永远不知道发生了什么。
  // 在写入那一刻就记（store 的 normalize 有字段白名单，回读 `relDropped` 会被丢掉）。
  return {
    ok: true,
    at: now,
    scope,
    blocks: blockReport,
    active: activeReport,
    persons: personReport,
    groups: groupReport,
    topics: topicReport,
    self: selfOut ? { mistakes: selfOut.mistakes?.length ?? 0 } : null,
    rejected,
    ...(warnings.length ? { warnings } : {}),
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
