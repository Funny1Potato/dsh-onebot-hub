/**
 * 人物 / 群 / 话题 / 自我 档案（§24.2 M16 的落盘侧）。
 *
 * 定位：**时间线是"发生了什么"，档案是"这意味着什么"**。时间线机械、廉价、可重建；
 * 档案是提炼过的结论（`impression` 一句话、`corrections` 被纠正过什么、`commitments` 答应过什么），
 * 花的是模型的推理，丢了很难再算出来——所以它们必须落盘，而且**只由模型决策写入**（§24.11）。
 *
 * 两条关系上的硬约定：
 *  - **名字跟着群走、档案跟着人走**：同一个 QQ 在 A 群叫"老张"、在 B 群叫"张工"，
 *    两条都记在 `names[{name,scope}]` 里；而"他做后端、爱问细节"是人的属性，只有一份。
 *  - **系统字段由代码维护，模型不能改**：`names`、`groups[worldKey].card`、`groups[].role`、
 *    `relationship.lastInteractAt` 这些来自观测（协议字段），模型只能读。模型的写入走
 *    `upsertPerson` 的 `facts/interests/commitments/corrections/impression/profile` 这些字段。
 *
 * 本模块**不做可见性判断**：`visibility` 由模型写入的边界层（`lib/memory/writer.js`）按会话推断，
 * 这里只存。这样"模型不能自行升格为 shareable"只有一处实现，不会漂移。
 */

import { safeName } from './storage.js';

export const PROFILE_VERSION = 1;
/** 上限都是"防跑飞"，不是产品判断：超过就丢最旧的，不报错也不阻塞。 */
export const MAX_NAMES = 20;
export const MAX_FACTS = 60;
export const MAX_CORRECTIONS = 20;
export const MAX_INTERESTS = 20;
export const MAX_COMMITMENTS = 40;

/**
 * 字段单行化（trim）——**不再按字数截断**（`m24155`：不希望再看到任何因为字数被截断的事情）。
 * 原来的 `n` 参数已无作用，保留形参不惊动 15 个调用点；条数上限（MAX_* 常量）是"防跑飞"，照旧保留。
 * 超长内容在写入侧由 writer 负责 rejected，档案字段这里只做归一化。
 */
const clip = (v) => String(v ?? '').trim();

export function emptyPerson(userId) {
  return {
    version: PROFILE_VERSION,
    userId: String(userId ?? ''),
    names: [],
    profile: { sex: null, age: null, level: null, avatar: null, profileAt: null },
    groups: {},
    relationship: { closeness: 0, tone: null, lastInteractAt: null },
    interests: [],
    facts: [],
    commitments: [],
    impression: null,
    corrections: [],
    updatedAt: null,
  };
}

export function emptyGroup(worldKey) {
  return {
    version: PROFILE_VERSION,
    worldKey: String(worldKey ?? ''),
    name: null,
    memberCount: null,
    ownerId: null,
    notice: null,
    culture: null,
    activeMembers: [],
    highlights: [],
    updatedAt: null,
  };
}

export function emptyTopic(id) {
  return {
    version: PROFILE_VERSION,
    id: String(id ?? ''),
    title: null,
    status: 'open',
    worldKeys: [],
    members: [],
    startedAt: null,
    lastAt: null,
    events: [],
    conclusion: null,
    refs: [],
  };
}

export function emptySelf() {
  return {
    version: PROFILE_VERSION,
    myNames: {},
    myStatements: [],
    mistakes: [],
    preferences: [],
    updatedAt: null,
  };
}

/**
 * 从档案里取"这个会话里该怎么称呼他"。
 *
 * 同一 scope 可能有多条（昵称改了、后来又起了群名片）：**取最后一条**——最新观测到的就是
 * 现在该用的叫法。取第一条会出现"他刚改了群名片，bot 还照着三天前的昵称叫他"。
 */
export function nameIn(person, scope) {
  const names = Array.isArray(person?.names) ? person.names : [];
  const scoped = names.filter((n) => n.scope === scope);
  const hit = scoped.at(-1) ?? names.at(-1);
  return hit?.name ?? null;
}

/**
 * 曾用名（§24.11：`past_nicknames` 属于代码自动记录的系统字段）。
 *
 * 为什么需要它：`nameIn` 只给**当前**名字，于是"小明"改了群名片成"明哥"之后，
 * 有人再说"小明"它就认不出是同一个人了——名字的历史本来就在 `names[]` 里躺着，
 * 只是没人回头看。这里把它翻出来，按新到旧、去重、**排除当前名**。
 */
export function pastNamesIn(person, { scope = null, current = null, limit = 10 } = {}) {
  const names = Array.isArray(person?.names) ? person.names : [];
  const now = current ?? nameIn(person, scope);
  const out = [];
  const seen = new Set(now ? [now] : []);
  for (let i = names.length - 1; i >= 0; i -= 1) {
    const n = names[i];
    const value = n?.name;
    if (!value || seen.has(value)) continue;
    // 同 scope 的更可信，排在前面。
    seen.add(value);
    out.push({ name: value, scope: n.scope ?? null, at: n.at ?? null });
  }
  out.sort((a, b) => {
    const sa = a.scope === scope ? 0 : 1;
    const sb = b.scope === scope ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (b.at ?? 0) - (a.at ?? 0);
  });
  return out.slice(0, limit);
}

/**
 * 这条消息是不是某个话题线程里的消息（用于**代码侧**的话题关联，§24.4）。
 *
 * 判定只用**明写的证据**：这一条引用了话题里已有的某条消息/事件。绝不做"关键词像"
 * 那种猜测——猜错一次就把无关的事塞进同一条线里，而"记住了错的事"比"没记住"更糟。
 * 容忍两种写法：`events` 里放时间线事件 id；`refs` 里放消息 id（字符串，或
 * `{messageId|message_id|id|timelineId}`）。
 */
export function topicHoldsMessage(topic, { eventId = null, messageId = null } = {}) {
  const wanted = [eventId, messageId].filter((v) => v !== null && v !== undefined).map(String);
  if (!wanted.length) return false;
  const events = Array.isArray(topic?.events) ? topic.events : [];
  if (events.some((e) => wanted.includes(String(e)))) return true;
  const refs = Array.isArray(topic?.refs) ? topic.refs : [];
  return refs.some((r) => {
    if (r === null || r === undefined) return false;
    if (typeof r !== 'object') return wanted.includes(String(r));
    return [r.messageId, r.message_id, r.id, r.timelineId]
      .filter((v) => v !== null && v !== undefined)
      .some((v) => wanted.includes(String(v)));
  });
}


/**
 * 档案库。读路径全部走内存缓存（一次读盘，之后只读写内存），写走 `storage.schedule` 防抖落盘。
 */
export class Profiles {
  #cache = new Map();
  #writes = 0;

  constructor({ storage = null, log, now = Date.now } = {}) {
    this.storage = storage;
    this.log = log ?? (() => {});
    this.now = now;
  }

  get enabled() {
    return Boolean(this.storage?.enabled);
  }

  path(kind, key) {
    const name = { person: 'persons', group: 'groups', topic: 'topics' }[kind];
    if (name) return `${name}/${safeName(key)}.json`;
    return `${safeName(kind)}.json`;
  }

  /**
   * 取（并缓存）一条档案记录。**返回的是缓存里的那个对象本身**——调用方直接改它就等于改了内存态，
   * 再 `#touch` 一下即可落盘。返回副本会让"先记名片、再合并其他字段"这类连续写入互相覆盖
   * （踩过：`noteGroupCard` 里先 `noteName` 写缓存、后 `cache.set` 写回旧副本，刚记下的名字被抹掉）。
   */
  #record(name, fallback) {
    const cached = this.#cache.get(name);
    if (cached) return cached;
    const raw = this.storage?.read?.(name, null) ?? null;
    const rec = raw && typeof raw === 'object' ? Object.assign(fallback, raw) : fallback;
    this.#cache.set(name, rec);
    return rec;
  }

  #touch(name) {
    this.#writes += 1;
    this.storage?.schedule?.(name, () => this.#cache.get(name));
  }

  person(userId) {
    const key = String(userId ?? '');
    return this.#normalizePerson(this.#record(this.path('person', key), emptyPerson(key)));
  }

  /** 兼容手改过/版本更早的文件：字段缺失就补上，不让"少一个 key"变成后面某处的 TypeError。 */
  #normalizePerson(rec) {
    rec.names = Array.isArray(rec.names) ? rec.names : [];
    rec.groups = rec.groups && typeof rec.groups === 'object' ? rec.groups : {};
    rec.relationship = rec.relationship && typeof rec.relationship === 'object' ? rec.relationship : { closeness: 0, tone: null, lastInteractAt: null };
    rec.profile = rec.profile && typeof rec.profile === 'object' ? rec.profile : { sex: null, age: null, level: null, avatar: null, profileAt: null };
    for (const f of ['facts', 'commitments', 'corrections', 'interests']) rec[f] = Array.isArray(rec[f]) ? rec[f] : [];
    return rec;
  }

  group(worldKey) {
    const key = String(worldKey ?? '');
    const rec = this.#record(this.path('group', key), emptyGroup(key));
    rec.activeMembers = Array.isArray(rec.activeMembers) ? rec.activeMembers : [];
    rec.highlights = Array.isArray(rec.highlights) ? rec.highlights : [];
    return rec;
  }

  topic(id) {
    const key = String(id ?? '');
    const rec = this.#record(this.path('topic', key), emptyTopic(key));
    for (const f of ['worldKeys', 'members', 'events', 'refs']) rec[f] = Array.isArray(rec[f]) ? rec[f] : [];
    return rec;
  }

  /**
   * 所有话题线程：内存里的 + 已经落盘的（按文件名去重）。
   * 落盘过的话题在重启后仍要能被列出来，否则"聊到哪了"会随重启消失。
   */
  topics() {
    const seen = new Set();
    const out = [];
    for (const [name, rec] of this.#cache) {
      if (!name.startsWith('topics/')) continue;
      seen.add(name);
      out.push(this.#normalizeTopic(rec));
    }
    for (const file of this.storage?.list?.('topics') ?? []) {
      const name = `topics/${file}`;
      if (seen.has(name)) continue;
      out.push(this.#normalizeTopic(this.#record(name, emptyTopic(file.replace(/\.json$/, '')))));
    }
    return out;
  }

  /**
   * 所有人物档案：内存里的 + 已经落盘的（按文件名去重）。
   * 主动回忆（M18）要从"所有我知道的人"里找还没兑现的承诺，所以需要能整体遍历；
   * 只用内存缓存会让重启后的承诺全部失忆。
   */
  persons() {
    const seen = new Set();
    const out = [];
    for (const [name, rec] of this.#cache) {
      if (!name.startsWith('persons/')) continue;
      seen.add(name);
      out.push(this.#normalizePerson(rec));
    }
    for (const file of this.storage?.list?.('persons') ?? []) {
      const name = `persons/${file}`;
      if (seen.has(name)) continue;
      out.push(this.person(file.replace(/\.json$/, '')));
    }
    return out;
  }

  #normalizeTopic(rec) {
    for (const f of ['worldKeys', 'members', 'events', 'refs']) rec[f] = Array.isArray(rec[f]) ? rec[f] : [];
    if (rec.status !== 'closed') rec.status = 'open';
    return rec;
  }

  self() {
    const rec = this.#record('self.json', emptySelf());
    rec.myNames = rec.myNames && typeof rec.myNames === 'object' ? rec.myNames : {};
    for (const f of ['myStatements', 'mistakes', 'preferences']) rec[f] = Array.isArray(rec[f]) ? rec[f] : [];
    return rec;
  }

  /** 会话清单（§24.3 `onebot_sessions`）：每个 worldKey 一条。 */
  sessions() {
    const doc = this.#record('sessions.json', { version: PROFILE_VERSION, items: [] });
    if (!Array.isArray(doc.items)) doc.items = [];
    return doc.items;
  }

  /**
   * 只记名字，不碰别的字段。协议里的 `sender.card`/`nickname` 每次事件都能看到，
   * 所以这是唯一由**代码**写入档案的地方——名字不是"提炼"，是观测。
   */
  noteName(userId, name, scope, at = this.now()) {
    const value = clip(name, 60);
    if (!value) return null;
    const key = String(userId ?? '');
    const file = this.path('person', key);
    const rec = this.person(key);
    rec.names = Array.isArray(rec.names) ? rec.names : [];
    const same = rec.names.find((n) => n.name === value && n.scope === scope);
    if (same) {
      same.at = at;
    } else {
      rec.names.push({ name: value, scope, at });
      if (rec.names.length > MAX_NAMES) rec.names.splice(0, rec.names.length - MAX_NAMES);
    }
    rec.updatedAt = at;
    this.#cache.set(file, rec);
    this.#touch(file);
    return rec;
  }

  /** 群名片/角色/头衔/等级：同一个人在不同群有不同名片，所以按 worldKey 存。 */
  noteGroupCard(userId, worldKey, { card, role, title, level, lastSentAt } = {}, at = this.now()) {
    const key = String(userId ?? '');
    const world = String(worldKey ?? '');
    if (!world) return null;
    const file = this.path('person', key);
    const rec = this.person(key);
    rec.groups = rec.groups && typeof rec.groups === 'object' ? rec.groups : {};
    const g = rec.groups[world] ?? { card: null, role: null, title: null, level: null, lastSentAt: null };
    if (card !== undefined && card !== null && card !== '') {
      g.card = clip(card, 60);
      // 群名片也是"名字跟着群走"的一种：把它并进 names，scope 就是这个世界。
      this.noteName(key, g.card, world, at);
    }
    if (role !== undefined && role !== null) g.role = String(role);
    if (title !== undefined && title !== null) g.title = clip(title, 60);
    if (level !== undefined && level !== null) g.level = String(level);
    if (lastSentAt !== undefined && lastSentAt !== null) g.lastSentAt = lastSentAt;
    rec.groups[world] = g;
    rec.relationship.lastInteractAt = at;
    rec.updatedAt = at;
    this.#cache.set(file, rec);
    this.#touch(file);
    return g;
  }

  /**
   * 模型写入人物档案的唯一入口（字段白名单：`profile/facts/interests/commitments/corrections/impression/relationship`）。
   * 传进来的 `facts` 等**已由 writer.js 补好 refs/visibility**；这里只做去重、上限与合并。
   * @param {string} userId
   * @param {object} patch
   */
  upsertPerson(userId, patch = {}, at = this.now()) {
    const key = String(userId ?? '');
    if (!key) return null;
    const file = this.path('person', key);
    const rec = this.person(key);

    if (patch.profile && typeof patch.profile === 'object') {
      for (const [k, v] of Object.entries(patch.profile)) {
        if (['sex', 'age', 'level', 'avatar'].includes(k) && v !== undefined) rec.profile[k] = v;
      }
      rec.profile.profileAt = patch.profile.profileAt ?? at;
    }
    if (patch.relationship && typeof patch.relationship === 'object') {
      if (patch.relationship.closeness !== undefined) {
        const c = Number(patch.relationship.closeness);
        if (Number.isFinite(c)) rec.relationship.closeness = Math.max(-5, Math.min(5, c));
      }
      if (patch.relationship.tone !== undefined) rec.relationship.tone = clip(patch.relationship.tone, 40) || null;
    }
    if (patch.impression !== undefined) rec.impression = clip(patch.impression, 200) || null;

    const pushUnique = (field, item, keyOf, cap) => {
      const list = Array.isArray(rec[field]) ? rec[field] : [];
      const k = keyOf(item);
      const idx = list.findIndex((x) => keyOf(x) === k);
      if (idx >= 0) list[idx] = { ...list[idx], ...item };
      else list.push(item);
      if (list.length > cap) list.splice(0, list.length - cap);
      rec[field] = list;
    };

    for (const f of patch.facts ?? []) pushUnique('facts', f, (x) => clip(x?.text, 400), MAX_FACTS);
    for (const i of patch.interests ?? []) pushUnique('interests', i, (x) => clip(x?.text ?? x, 80), MAX_INTERESTS);
    for (const c of patch.commitments ?? []) pushUnique('commitments', c, (x) => clip(x?.what, 200), MAX_COMMITMENTS);
    for (const c of patch.corrections ?? []) pushUnique('corrections', c, (x) => clip(x?.right, 200), MAX_CORRECTIONS);

    rec.relationship.lastInteractAt = at;
    rec.updatedAt = at;
    this.#cache.set(file, rec);
    this.#touch(file);
    return rec;
  }

  upsertGroup(worldKey, patch = {}, at = this.now()) {
    const key = String(worldKey ?? '');
    if (!key) return null;
    const file = this.path('group', key);
    const rec = this.group(key);
    for (const k of ['name', 'notice', 'culture']) {
      if (patch[k] !== undefined) rec[k] = clip(patch[k], k === 'culture' ? 300 : 120) || null;
    }
    if (patch.memberCount !== undefined) {
      const n = Number(patch.memberCount);
      if (Number.isFinite(n)) rec.memberCount = n;
    }
    if (patch.ownerId !== undefined) rec.ownerId = patch.ownerId === null ? null : String(patch.ownerId);
    if (Array.isArray(patch.activeMembers)) rec.activeMembers = patch.activeMembers.slice(0, 10);
    if (patch.highlights) {
      const list = Array.isArray(rec.highlights) ? rec.highlights : [];
      list.push(...(Array.isArray(patch.highlights) ? patch.highlights : [patch.highlights]));
      rec.highlights = list.slice(-20);
    }
    rec.updatedAt = at;
    this.#cache.set(file, rec);
    this.#touch(file);
    return rec;
  }

  upsertTopic(id, patch = {}, at = this.now()) {
    const key = String(id ?? '');
    if (!key) return null;
    const file = this.path('topic', key);
    const rec = this.topic(key);
    for (const k of ['title', 'conclusion']) if (patch[k] !== undefined) rec[k] = clip(patch[k], 300) || null;
    if (patch.status !== undefined) rec.status = patch.status === 'closed' ? 'closed' : 'open';
    if (Array.isArray(patch.worldKeys)) rec.worldKeys = [...new Set(patch.worldKeys.map(String))];
    if (Array.isArray(patch.members)) rec.members = [...new Set(patch.members.map(String))].slice(0, 20);
    if (patch.events) {
      const list = Array.isArray(rec.events) ? rec.events : [];
      list.push(...(Array.isArray(patch.events) ? patch.events : [patch.events]));
      rec.events = list.slice(-40);
    }
    if (patch.refs) {
      const list = Array.isArray(rec.refs) ? rec.refs : [];
      list.push(...(Array.isArray(patch.refs) ? patch.refs : [patch.refs]));
      rec.refs = list.slice(-40);
    }
    rec.startedAt = rec.startedAt ?? patch.startedAt ?? at;
    rec.lastAt = at;
    this.#cache.set(file, rec);
    this.#touch(file);
    return rec;
  }

  /**
   * 曾用名（只读）：把 `names[]` 里的历史翻出来，排除当前名。
   */
  pastNames(userId, { scope = null, limit = 10 } = {}) {
    const person = this.person(userId);
    if (!person) return [];
    return pastNamesIn(person, { scope, current: nameIn(person, scope), limit });
  }

  /**
   * 名字反查（只读）：**别人说"小明"时，那是谁**。
   *
   * 顺序是刻意的：先看这个 scope 的当前名，再看别处的当前名，最后才认曾用名——
   * 同名时当前名比历史名更可信（不然改回旧名的人会被旧记录抓住）。
   */
  lookupName(name, { scope = null, limit = 5 } = {}) {
    const want = clip(name, 60);
    if (!want) return [];
    const hits = [];
    for (const person of this.persons()) {
      const names = Array.isArray(person.names) ? person.names : [];
      const exactScope = names.find((n) => n.name === want && n.scope === scope);
      const anyScope = names.find((n) => n.name === want);
      if (!exactScope && !anyScope) continue;
      // "是不是当前名"要按**命中的那个 scope** 判，不能按查询 scope——否则跨 scope 反查
      // 会把这个群当下的名字说成"曾用名"。
      const matchedScope = (exactScope ?? anyScope).scope ?? null;
      const current = nameIn(person, matchedScope);
      const isCurrent = current === want;
      const rank = isCurrent && exactScope ? 0 : isCurrent ? 1 : exactScope ? 2 : 3;
      hits.push({
        userId: person.userId,
        name: want,
        current,
        matchedScope,
        past: !isCurrent,
        rank,
      });
    }
    hits.sort((a, b) => a.rank - b.rank || String(a.userId).localeCompare(String(b.userId)));
    return hits.slice(0, limit);
  }

  /**
   * 话题关联（§24.4，代码侧）：这一条**引用了**某条已有话题里的消息时，把它接进同一条线。
   *
   * 只用明写的证据（见 `topicHoldsMessage`），不做"关键词像"的猜测——猜错一次就把无关的事
   * 塞进同一条线，而"记住了错的事"比"没记住"更糟。返回接上的话题 id（没接上就是 null）。
   */
  attachTopicByReply({ eventId = null, messageId = null, worldKey = null, actorId = null, at = this.now() } = {}) {
    if (!eventId && !messageId) return null;
    const hit = this.topics().find((t) => topicHoldsMessage(t, { eventId, messageId }));
    if (!hit) return null;
    const patch = { events: eventId ? [eventId] : [] };
    if (worldKey && !hit.worldKeys.includes(worldKey)) patch.worldKeys = [...hit.worldKeys, worldKey];
    if (actorId && !hit.members.includes(String(actorId))) patch.members = [...hit.members, String(actorId)];
    return this.upsertTopic(hit.id, patch, at);
  }

  upsertSelf(patch = {}, at = this.now()) {
    const rec = this.self();
    if (patch.myNames && typeof patch.myNames === 'object') {
      rec.myNames = { ...rec.myNames, ...patch.myNames };
    }
    const push = (field, item, keyOf, cap) => {
      const list = Array.isArray(rec[field]) ? rec[field] : [];
      const k = keyOf(item);
      const idx = list.findIndex((x) => keyOf(x) === k);
      if (idx >= 0) list[idx] = { ...list[idx], ...item };
      else list.push(item);
      rec[field] = list.slice(-cap);
    };
    for (const s of patch.myStatements ?? []) push('myStatements', s, (x) => clip(x?.what, 300), 100);
    for (const m of patch.mistakes ?? []) push('mistakes', m, (x) => clip(x?.what, 300), 50);
    for (const p of patch.preferences ?? []) push('preferences', p, (x) => clip(x?.text ?? x, 120), 30);
    rec.updatedAt = at;
    this.#cache.set('self.json', rec);
    this.#touch('self.json');
    return rec;
  }

  /** 每看到一条消息就更新"这个会话最近什么样"：`onebot_sessions` 的数据源。 */
  touchSession(worldKey, patch = {}, at = this.now()) {
    const key = String(worldKey ?? '');
    if (!key) return null;
    const file = 'sessions.json';
    const doc = this.#record(file, { version: PROFILE_VERSION, items: [] });
    if (!Array.isArray(doc.items)) doc.items = [];
    const idx = doc.items.findIndex((s) => s.worldKey === key);
    const base = { worldKey: key, kind: key.startsWith('group:') ? 'group' : 'private', title: null, lastMessageAt: null, lastSeenAt: null, unread: 0, myLastSpeakAt: null, muted: false };
    const rec = idx >= 0 ? { ...base, ...doc.items[idx] } : base;
    Object.assign(rec, patch, { worldKey: key });
    if (idx >= 0) doc.items[idx] = rec;
    else doc.items.push(rec);
    doc.items = doc.items.slice(-200);
    this.#cache.set(file, doc);
    this.#touch(file);
    return rec;
  }

  /** 每个 worldKey 的会话概要（`recall` / `onebot_sessions` 都读它）。 */
  sessionOf(worldKey) {
    return this.sessions().find((s) => s.worldKey === String(worldKey ?? '')) ?? null;
  }

  snapshot() {
    const names = [...this.#cache.keys()];
    return {
      enabled: this.enabled,
      cached: names.length,
      files: { persons: names.filter((n) => n.startsWith('persons/')).length, groups: names.filter((n) => n.startsWith('groups/')).length, topics: names.filter((n) => n.startsWith('topics/')).length },
      sessions: this.sessions().length,
      writes: this.#writes,
    };
  }

  flush() {
    return this.storage?.flush?.() ?? 0;
  }
}
