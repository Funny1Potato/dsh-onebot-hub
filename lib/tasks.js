/**
 * 定时任务（`onebot_task`）——宿主管时钟，hub 只记"到点叫醒谁"。
 *
 * 三条职责刻意不重叠：
 *  1. 宿主 `schedule` 服务只知道**什么时候**响（cron/daily/every 都是它的活，我们一行不写）；
 *  2. hub 只知道**哪个任务叫醒哪个会话**（`tasks.json`）；
 *  3. 被叫醒的那个 agent 才知道**该说什么**（它有自己的记忆与上下文）。
 *
 * 中间必须有一个"总机会话"（`task:hub`），因为宿主的排期是**绑在某个 sessionId 上**的：
 * 直接把任务绑在群会话上，那个群就再也回收不掉（上下文会一直涨到顶）。所以中间人是一条
 * 永不回收、但**没有任何记忆**的会话：它每次被叫起来只做一件事——把 id 丢回给 hub（`fire`）。
 *
 * 为什么不自己写定时器：宿主的 schedule 已经做了持久化、错过不补、时区、频率闸，
 * 再写一套只会多一个会漏的地方（v6 提过、被否掉，v9 定案用宿主）。
 */

import { sessionAllowlistOff } from './agent/policy.js';

/** 总机会话的会话键；它不在任何白名单里，也不进会话目录。 */
export const TASK_SESSION_KEY = 'task:hub';
/** 新建总机会话时给它的名字（会话列表里看得见，便于一眼认出）。 */
export const TASK_SESSION_NAME = 'onebot-hub::tasks';
/** 每个会话最多排多少条活动任务。宿主管线本身不限，这是防"模型给自己排了一百条"。 */
export const MAX_TASKS = 50;
/** `every:` 的最短间隔（秒）。宿主对更密的排期会回 `frequency_too_high`，我们提前拦下并说清楚。 */
export const MIN_EVERY_SECONDS = 60;
/** 同一个任务在这个窗口内第二次 `fire` 视为重复（重置换会话时新旧排期可能各触发一次）。 */
// fire 最多等这么久就要叫醒结果，超了按已投递（排队中）返回（`m36117`）。
const WAKE_ASYNC_MS = 8000;
const FIRE_DEDUPE_MS = 60_000;
const TITLE_MAX = 40;
const PROMPT_MAX = 500;

const DEFAULT_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const fail = (error) => ({ ok: false, error });
const ok = (data = {}) => ({ ok: true, ...data });

/** 现在几点（注入时间便于测试；不传就是真实时钟）。 */
const nowOf = (at) => (Number.isFinite(Number(at)) ? Number(at) : Date.now());

/**
 * 解析 `when` 小语法。**只认四种**——多一种写法，模型选错的概率就多一分（定案 v9）。
 *
 * `at:2026-11-01T08:00` / `after:3600`（秒） / `every:600`（秒） / `every:daily@08:00`
 *
 * 返回 `{ok:true, when:{kind,...}, host:{...ScheduleCreateRequest 的时间字段}, label}`，
 * 校验失败返回 `{ok:false, error}`（文案直接给模型看，所以要说清错在哪）。
 */
export function parseWhen(raw, at) {
  const text = String(raw ?? '').trim();
  if (!text) return fail('when 没写。四种写法：at:2026-11-01T08:00 / after:3600 / every:600 / every:daily@08:00');
  const now = nowOf(at);
  const m = /^(at|after|every)\s*:\s*(.+)$/i.exec(text);
  if (!m) return fail(`when 看不懂：「${text}」。只认四种写法：at:2026-11-01T08:00 / after:3600 / every:600 / every:daily@08:00`);
  const head = m[1].toLowerCase();
  const tail = m[2].trim();

  if (head === 'at') {
    const ts = Date.parse(tail.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(tail) ? tail : tail.replace(' ', 'T'));
    if (!Number.isFinite(ts)) return fail(`at: 后面的时间看不懂：「${tail}」。写成 2026-11-01T08:00`);
    if (ts <= now) return fail(`at: 那个时刻已经过去了（${new Date(ts).toLocaleString('zh-CN')}）。要现在之后的时间`);
    return ok({ when: { kind: 'at', ts }, host: { at: new Date(ts).toISOString() }, label: labelAt(ts) });
  }
  if (head === 'after') {
    const sec = Number(tail);
    if (!Number.isFinite(sec) || sec <= 0) return fail(`after: 后面要写秒数，例如 after:3600`);
    return ok({ when: { kind: 'after', seconds: sec }, host: { after_seconds: Math.round(sec) }, label: labelAfter(sec) });
  }
  // every:*（含 every:daily@08:00）
  const daily = /^daily\s*@\s*(\d{1,2}):(\d{2})$/i.exec(tail);
  if (daily) {
    const hh = Number(daily[1]);
    const mm = Number(daily[2]);
    if (hh > 23 || mm > 59) return fail(`every:daily 的时刻不合法：「${tail}」。写成 08:00 这种`);
    const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    return ok({ when: { kind: 'daily', time }, host: { daily: { time, time_zone: DEFAULT_TZ } }, label: `每天 ${time}` });
  }
  const sec = Number(tail);
  if (!Number.isFinite(sec) || sec <= 0) return fail(`every: 后面要写秒数，或者 every:daily@08:00`);
  if (sec < MIN_EVERY_SECONDS) {
    return fail(`every: 最短 ${MIN_EVERY_SECONDS} 秒（宿主对更密的排期会拒）。要更频繁就排多条，但那样每次到点都是一次模型调用`);
  }
  return ok({ when: { kind: 'every', seconds: Math.round(sec) }, host: { every_seconds: Math.round(sec) }, label: labelEvery(sec) });
}

/** 给人看的一句话节奏（`list` 与提醒帧都用它，两处必须是同一句话）。 */
export function whenLabel(when) {
  if (!when) return '';
  if (when.kind === 'at') return labelAt(Number(when.ts));
  if (when.kind === 'after') return labelAfter(Number(when.seconds));
  if (when.kind === 'daily') return `每天 ${when.time}`;
  if (when.kind === 'every') return labelEvery(Number(when.seconds));
  return '';
}

function labelAt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function labelAfter(sec) {
  if (sec < 3600) return `${Math.round(sec / 60) || 1} 分钟后`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时后`;
  return `${Math.round(sec / 86400)} 天后`;
}

function labelEvery(sec) {
  if (sec < 3600) return `每 ${Math.round(sec / 60) || 1} 分钟`;
  if (sec < 86400) return `每 ${Math.round(sec / 3600)} 小时`;
  return `每 ${Math.round(sec / 86400)} 天`;
}

/** `group:833194406` / `private:945126014` —— 只认这两种，别的写法说明调用处自己写错了。 */
export function parseTarget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return fail('target 要写成 group:<群号> 或 private:<QQ号>');
  const m = /^(group|private)\s*:\s*(\d{3,})$/i.exec(text);
  if (!m) return fail(`target 看不懂：「${text}」。写成 group:833194406 或 private:945126014`);
  return ok({ target: `${m[1].toLowerCase()}:${m[2]}` });
}

/** 目标是否在这份配置的会话名单里（官方上游时名单不生效，那就一律允许）。 */
export function targetAllowed(config, target) {
  if (!target) return false;
  if (sessionAllowlistOff(config)) return true;
  const [kind, id] = String(target).split(':');
  const table = kind === 'group' ? config?.agentGroups : config?.agentPrivates;
  return Boolean(table && table[id]);
}

/**
 * 任务表 + 总机会话。落盘走 hub 的 `JsonStore`（`data/tasks.json`）。
 *
 * 一条记录的字段：
 * ```
 * { id, title, prompt, when:{kind,...}, target, createdBy,
 *   sessionId, scheduleId, active, lastAt, lastResult, fireCount }
 * ```
 * `fireCount` 同时是 `resetEvery` 的计数器；`lastResult` 只有三种：`静默` / `说了 N 条` / `失败：…`。
 */
/**
 * 判断"调用者是不是总机会话"。
 *
 * 不能拿会话键直接比：宿主给 agent 的 id 是 `onebot-hub:task%3Ahub.a<激活码>` 这种带后缀的
 * 编码串（`m36229`：真机上 `fire` 就是因为只比 `onebot-hub:tasks` 而被判成外部会话，
 * 中间人当场失败、改用别的路子叫醒，硬是把提醒拖晚了两分多钟）。
 * 所以三种都认：裸会话键、编码串里解出来的 `task:hub`、以及记录里那个真身 sessionId。
 */
export function isTaskSession(ids, currentSessionId) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((v) => String(v ?? '').trim()).filter(Boolean);
  const decode = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  for (const raw of list) {
    if (raw === TASK_SESSION_KEY) return true;
    if (currentSessionId && raw === currentSessionId) return true;
    if (decode(raw).includes(TASK_SESSION_KEY)) return true;
    if (raw.includes('task%3Ahub')) return true;
  }
  return false;
}

/**
 * 从会话事件里认出宿主注入的定时提醒，取出 `schedule_id`。
 *
 * 形态（真机日志 `m36229`）：`agent/inbox/spliced` 与随后的 `user/message`，
 * 正文以 `[SCHEDULE REMINDER]` 开头，里面一行 `schedule_id_json: "schedule-…"`。
 */
export const scheduleReminderOf = (event) => {
  const type = String(event?.type ?? '');
  if (type !== 'agent/inbox/spliced' && type !== 'user/message') return null;
  const texts = [];
  const push = (v) => {
    if (typeof v === 'string') texts.push(v);
  };
  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') return push(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (k === 'schedule_id_json' && typeof item === 'string') texts.push(`schedule_id_json: ${item}`);
        walk(item, depth + 1);
      }
    }
  };
  walk(event?.data);
  const joined = texts.join('\n');
  if (!joined.includes('SCHEDULE REMINDER') && !joined.includes('schedule_id_json')) return null;
  const m = /schedule_id_json["']?\s*:\s*["']?([\w:.-]+)/.exec(joined);
  return m ? { scheduleId: m[1] } : null;
};

export class TaskStore {
  #tasks = [];
  #sessionId = '';
  #fired = new Map(); // 任务 id → 上次 fire 的时间戳（去重）
  #trials = new Map(); // 手动试跑专用的去重账（第三轮 T11：不能和到点共用一个）
  #busy = false;
  #running = new Map();

  /**
   * @param {{storage:object, hub:object, log?:Function, resetEvery?:number}} opts
   *   `storage` 是 hub 的 `JsonStore`；`hub` 用来取 `mind` / `hostRef` / `scheduleSvc` / `config`。
   */
  constructor({ storage, hub, log, resetEvery = 0 } = {}) {
    this.storage = storage ?? null;
    this.hub = hub ?? null;
    this.log = log ?? (() => {});
    this.resetEvery = Math.max(0, Math.floor(Number(resetEvery) || 0));
  }

  get sessionKey() {
    return TASK_SESSION_KEY;
  }

  get sessionId() {
    return this.#sessionId;
  }

  /**
   * 任务归谁管（`m85249` 审查报告 P1-4）。
   *
   * `createdBy` 一直都记着，但从来没有一处拿它比对过——于是任意一个群会话
   * `list` 就能看见别人排了什么（标题、完整 prompt、到点叫醒哪个会话），
   * `remove` 还能直接删掉。
   *
   * 归**两个**人：建它的人，以及它到点要叫醒的那个会话。后者不是多余的——
   * 一条"提醒这个群"的任务，那个群自己也该能管；而且老数据里 `createdBy`
   * 建库时会退回 `target`，不认 target 就会把升级前建的任务全判成别人的。
   */
  owns(task, caller = '') {
    const me = String(caller ?? '').trim();
    if (!me) return true;
    const by = String(task?.createdBy ?? '').trim();
    const to = String(task?.target ?? '').trim();
    return me === by || me === to;
  }

  /**
   * 活动任务（只读快照，调用方别拿它改内部状态）。
   * @param {{all?: boolean, owner?: string}} [options] `owner` 填了只返回它管得着的
   */
  list(options = {}) {
    // 老调用点是 `list(true)`（= 连已结束的一起列）。两种都认，别让旧代码静默变形。
    const opts = typeof options === 'boolean' ? { all: options } : (options ?? {});
    const all = opts.all === true;
    const owner = String(opts.owner ?? '').trim();
    return this.#tasks
      .filter((t) => all || t.active)
      .filter((t) => !owner || this.owns(t, owner))
      .map((t) => ({ ...t }));
  }

  /** 全部任务（含已被宿主标成结束的一次性任务，`list({all:true})` 用）。 */
  all() {
    return this.#tasks.map((t) => ({ ...t }));
  }

  /** 从盘上读回来。没有文件时什么都不做（第一次建任务时才落盘）。 */
  load() {
    const raw = this.storage?.read?.('tasks', null) ?? null;
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
    // 老版本（`<03a7f6d`）把带激活后缀的 id 存进来了：那时 pin 没生效，id 每次唤醒都换。
    // 读回来时把 `.a…` 后缀去掉——总机会话本来就该钉在一个固定 id 上，后缀是"每次都换"的残留。
    this.#sessionId = String(raw?.sessionId ?? '')
      .trim()
      .replace(/\.a[0-9a-z]{4,}$/i, '');
    this.#tasks = tasks.filter((t) => t && typeof t === 'object' && t.id).map((t) => { const copy = { ...t, active: t.active !== false }; delete copy.inflight; return copy; });
    return { tasks: this.#tasks.length, sessionId: this.#sessionId };
  }

  #save() {
    this.storage?.write?.('tasks', { v: 1, sessionId: this.#sessionId, tasks: this.#tasks });
  }

  /**
   * 保证总机会话存在，并把它**钉在记录里的 sessionId 上**。
   *
   * 为什么必须钉：宿主的排期绑 sessionId。hub 平时的会话 id 每次激活都会换（带 `.a<时间戳>` 后缀），
   * 那样重启一次所有排期就全指向一个没人用的会话——到点会由宿主**另起一个** agent 去跑，
   * 既没有我们的工具，也没有我们的 guidance，中间人就哑了。
   *
   * 所以总机用固定 id，且**跨重启复用**（id 存在 `tasks.json` 里）。
   */
  async ensureSession() {
    if (!this.#sessionId) {
      // 第一次：用固定 id（不带激活后缀）。轮换另起 `.r<N>`，见 `#rotate()`。
      this.#sessionId = 'onebot-hub:tasks';
      this.#save();
    }
    const pinned = this.hub?.hostRef?.pinSessionId?.(TASK_SESSION_KEY, this.#sessionId);
    await this.hub?.mind?.ensureAgent?.(TASK_SESSION_KEY);
    // 钉不住就得知道：宿主那边真身（可能带 `.a…` 后缀）与我们记的不一致时，排期会绑到空会话，
    // 到点一声不响。真踩过（`m35955`：`hub.hostRef` 没挂上，pin 被 `?.` 吃掉），所以这里
    // 一律读回真身并**以真身为准**——哪怕它每次激活都在变，至少这一次是通的。
    const live = this.hub?.hostRef?.sessionIdOf?.(TASK_SESSION_KEY) ?? null;
    if (live && live !== this.#sessionId) {
      this.log?.(`总机会话 id 与宿主对不上：记的 ${this.#sessionId}，宿主的 ${live}；按宿主的来`);
      this.#sessionId = live;
      this.#save();
    } else if (!pinned) {
      this.log?.('总机会话 id 没钉住（宿主没给 pinSessionId？），重启后排期可能指向旧会话');
    }
    return this.#sessionId;
  }

  /** 把本轮"到这里结束了"落到一条任务的记录上（`run` / `fire` 共用）。 */
  /**
   * 一次性任务响过就退场（`m85249` 审查报告 P2-7）。
   *
   * `at:` / `after:` 只该响一次，可这条记录以前**永远 `active: true`**：`list()` 一直列着它、
   * `MAX_TASKS`（50）的名额被它永久占着，而每次总机轮换 `#rotateIfNeeded()` 还会按
   * `encodeWhen()` 把它重新建一遍——`after:60` 于是每轮都复活一次。
   * （宿主管的排期本身是一次性的，问题只出在我们这份记录上。）
   */
  /** 一次性任务（`at:` / `after:`）——只有它们需要退场与在飞标记。 */
  #isOneShot(task) {
    // `when` 存的是解析后的对象（`{kind:'after',seconds:60}`），老数据里也可能是字符串。
    const kind = typeof task?.when === 'string'
      ? String(task.when).split(':')[0]
      : String(task?.when?.kind ?? '');
    return kind === 'at' || kind === 'after';
  }

  #retireIfOneShot(id) {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task || !task.active) return false;
    // `when` 存的是解析后的对象（`{kind:'after',seconds:60}`），老数据里也可能是字符串。
    const kind = typeof task.when === 'string'
      ? String(task.when).split(':')[0]
      : String(task.when?.kind ?? '');
    if (kind !== 'at' && kind !== 'after') return false;
    task.active = false;
    task.finishedAt = Date.now();
    this.#save();
    return true;
  }

  #note(id, result) {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) return null;
    task.lastAt = Date.now();
    task.lastResult = result;
    task.fireCount = (Number(task.fireCount) || 0) + 1;
    this.#save();
    return task;
  }

  async create({ title, prompt, when, target, createdBy } = {}) {
    const name = String(title ?? '').trim();
    if (!name) return fail('title 得写一句，`list` 与提醒里都靠它认任务');
    if (name.length > TITLE_MAX) return fail(`title 太长了（${name.length} 字），${TITLE_MAX} 字以内`);
    const body = String(prompt ?? '').trim();
    if (!body) return fail('prompt 得写清楚到点要办什么，否则那一轮只能瞎猜');
    if (body.length > PROMPT_MAX) return fail(`prompt 太长了（${body.length} 字），${PROMPT_MAX} 字以内`);
    const parsed = parseWhen(when);
    if (!parsed.ok) return parsed;
    if (this.list().length >= MAX_TASKS) {
      return fail(`这个会话已经有 ${MAX_TASKS} 条活动任务了（上限）。先 remove 掉一些再排`);
    }
    const creator = String(createdBy ?? '').trim();
    const rawTarget = String(target ?? '').trim();
    const to = rawTarget ? parseTarget(rawTarget) : { ok: true, target: creator };
    if (!to.ok) return to;
    if (!to.target) return fail('没法确定到点叫醒谁：target 没写，而且当前会话也不是群或私聊');
    if (!targetAllowed(this.hub?.config, to.target)) {
      return fail(
        `target ${to.target} 不在这个插件的会话名单里（agent.groups / agent.privates）。` +
          '要么先把它加进去，要么排给一个已经在名单里的会话',
      );
    }

    let sessionId;
    try {
      sessionId = await this.ensureSession();
    } catch (err) {
      return fail(`总机会话没起来（宿主 agents 不可用？）：${err?.message ?? err}`);
    }
    const svc = this.hub?.scheduleSvcOf?.() ?? this.hub?.scheduleSvc ?? null;
    if (typeof svc?.create !== 'function') {
      return fail('宿主没有 schedule 服务，排不了定时任务（DSH 版本太老？）');
    }

    const id = `tsk_${Math.random().toString(36).slice(2, 8)}`;
    // 宿主塞给总机会话的那句（`m36360`）：**只留一个标记**。
    // 枢纽是从 `session/event` 里的 `schedule_id_json` 认出这条排期的，不靠这句话；
    // 一句话里写"处理它：调 fire"只会让总机会话真去调，然后多花一轮模型。
    const frame = '[定时提醒]';
    let record;
    try {
      record = await svc.create(sessionId, { title: name, prompt: frame, ...parsed.host });
    } catch (err) {
      return fail(scheduleErrorText(err));
    }
    const task = {
      id,
      title: name,
      prompt: body,
      when: parsed.when,
      target: to.target,
      createdBy: creator || to.target,
      sessionId,
      scheduleId: String(record?.id ?? ''),
      nextAt: String(record?.scheduledAt ?? ''),
      active: true,
      lastAt: null,
      lastResult: '',
      fireCount: 0,
    };
    this.#tasks.push(task);
    this.#save();
    return ok({ id, title: name, wakes: to.target, every: parsed.label, nextAt: task.nextAt });
  }

  /**
   * 暂停一条任务（`m85685`）：**把宿主的排期删掉，本地记录留着**。
   *
   * 为什么不直接 remove：用户想的是"先别响，过阵子再说"，删了就只剩"重建一条"这一条路，
   * 而重建意味着 prompt 要重新写。暂停只动排期那一段，`title`/`prompt`/`when` 都还在。
   *
   * 一次性任务（`at:` / `after:`）也允许暂停——它还没响过的话，暂停就是"先别响"，恢复时按
   * `when` 重新算时间（`after:` 从**恢复那一刻**起算，`at:` 的定点已经过了就直说不干了）。
   */
  async pause(id, { caller = '' } = {}) {
    const task = this.#tasks.find((t) => t.id === String(id ?? '').trim());
    if (!task) return fail(`没有这个任务：${id}。用 list 看一眼 id`);
    if (!this.owns(task, caller)) {
      return fail(`暂停不了 ${task.id}：这条不是你排的（建它的是 ${task.createdBy || '不清楚'}）。`);
    }
    if (task.paused) return ok({ id: task.id, paused: true, already: true });
    if (task.active === false) return fail(`${task.id} 已经结束了，不用暂停。`);
    const svc = this.hub?.scheduleSvcOf?.() ?? this.hub?.scheduleSvc;
    let deleted = false;
    if (typeof svc?.delete === 'function' && task.scheduleId) {
      try {
        const r = await svc.delete({ sessionId: task.sessionId || this.#sessionId, id: task.scheduleId });
        deleted = r?.deleted === true;
      } catch (err) {
        // 删不掉宿主排期就别标暂停：标了也照样会响，等于骗人。
        return fail(`宿主那边取消失败：${err?.message ?? err}`);
      }
      if (!deleted) return fail('宿主说这条排期已经不存在了；刷新一下 list 再试');
    }
    task.paused = true;
    task.pausedAt = Date.now();
    task.scheduleId = '';
    task.nextAt = '';
    this.#save();
    this.log?.(`[tasks] 暂停 ${task.id}（${task.title}）→ 叫醒 ${task.target}`);
    return ok({ id: task.id, paused: true, wakes: task.target, every: whenLabel(task.when) });
  }

  /** 恢复一条被暂停的任务：按原来那份 `when` 重新向宿主排一次。 */
  async resume(id, { caller = '' } = {}) {
    const task = this.#tasks.find((t) => t.id === String(id ?? '').trim());
    if (!task) return fail(`没有这个任务：${id}。用 list 看一眼 id`);
    if (!this.owns(task, caller)) {
      return fail(`恢复不了 ${task.id}：这条不是你排的（建它的是 ${task.createdBy || '不清楚'}）。`);
    }
    if (!task.paused) return ok({ id: task.id, paused: false, already: true });
    const svc = this.hub?.scheduleSvcOf?.() ?? this.hub?.scheduleSvc;
    if (typeof svc?.create !== 'function') return fail('宿主没有 schedule 服务，恢复不了（DSH 版本太老？）');
    const encoded = encodeWhen(task.when);
    const again = parseWhen(encoded);
    if (!again.ok) return fail(`这条任务的 when 读不回来（${encoded || '空'}），干脆 remove 掉重建一条吧`);
    if (this.list().filter((t) => t.active && !t.paused).length >= MAX_TASKS) {
      return fail(`活动任务已经到 ${MAX_TASKS} 条上限了，先停掉别的再恢复`);
    }
    if (!targetAllowed(this.hub?.config, task.target)) {
      return fail(
        `target ${task.target} 现在不在会话名单里（agent.groups / agent.privates 改过？），先把它加回去`,
      );
    }
    let sessionId;
    try {
      sessionId = await this.ensureSession();
    } catch (err) {
      return fail(`总机会话没起来：${err?.message ?? err}`);
    }
    let record;
    try {
      record = await svc.create(sessionId, { title: task.title || '定时提醒', prompt: '[定时提醒]', ...again.host });
    } catch (err) {
      return fail(scheduleErrorText(err));
    }
    task.paused = false;
    task.sessionId = sessionId;
    task.scheduleId = String(record?.id ?? '');
    task.nextAt = String(record?.scheduledAt ?? '');
    delete task.pausedAt;
    this.#save();
    this.log?.(`[tasks] 恢复 ${task.id}（${task.title}）→ 下次 ${task.nextAt || '?'}`);
    return ok({ id: task.id, paused: false, wakes: task.target, every: whenLabel(task.when), nextAt: task.nextAt });
  }

  /** 删任务：本地记录与宿主排期**一起删**。宿主那边已经没有时也算成功（幂等）。 */
  /**
   * 按会话清掉任务（审查报告"按会话清理与导出数据"，`m85685`）。
   *
   * 判定看两处：`target`（到点叫醒的那个会话）与 `createdBy`（在哪儿建的）。
   * 逐条走 `remove`，宿主的排期也跟着一起删——只删本地记录会留下"删了还在响"。
   */
  async purgeScope(scope, { dryRun = false } = {}) {
    const key = String(scope ?? '').trim();
    if (!key) return { ok: false, error: '没给会话键，删不了', removed: 0 };
    const hit = this.#tasks.filter((t) => String(t.target ?? '') === key || String(t.createdBy ?? '') === key);
    if (dryRun) return { ok: true, dryRun: true, removed: hit.length, ids: hit.map((t) => t.id) };
    let removed = 0;
    const failed = [];
    for (const t of hit) {
      const r = await this.remove(t.id, { caller: '' });
      if (r?.ok) removed += 1;
      else failed.push({ id: t.id, error: r?.error ?? '未知原因' });
    }
    this.log?.(`[tasks] 按会话清理：${key} 去掉 ${removed} 条`);
    return { ok: true, removed, failed };
  }

  async remove(id, { caller = '' } = {}) {
    const task = this.#tasks.find((t) => t.id === String(id ?? '').trim());
    if (!task) return fail(`没有这个任务：${id}。用 list 看一眼 id`);
    // 归属（`m85249` P1-4）：不是你的任务，删不掉。说清楚它归谁，免得模型以为 id 写错了。
    if (!this.owns(task, caller)) {
      return fail(
        `删不了 ${task.id}：这条不是你排的（建它的是 ${task.createdBy || '不清楚'}，到点叫醒 ${task.target || '不清楚'}）。` +
          '只有建它的人、和它要叫醒的那个会话能删。',
      );
    }
    let deleted = false;
    const svc = this.hub?.scheduleSvcOf?.() ?? this.hub?.scheduleSvc;
    if (typeof svc?.delete === 'function' && task.scheduleId) {
      try {
        const r = await svc.delete({ sessionId: task.sessionId || this.#sessionId, id: task.scheduleId });
        deleted = r?.deleted === true;
      } catch (err) {
        // 删不掉就**别删本地记录**：留着还能再删一次；删了记录却留下排期，是"删了却还在响"。
        return fail(`宿主那边删除失败：${err?.message ?? err}`);
      }
    }
    this.#tasks = this.#tasks.filter((t) => t.id !== task.id);
    this.#fired.delete(task.id);
    this.#save();
    return ok({ id: task.id, title: task.title, hostDeleted: deleted, note: deleted ? '' : '宿主里本来就没有这条排期，已清掉本地记录' });
  }

  /**
   * 宿主把提醒投进了总机会话：按 `schedule_id` 找回任务并投递。
   *
   * 这条路是**枢纽自己**走的（`m36272` 用户定案），不再让中间人跑一轮模型去调 `fire`——
   * 中间人那轮既慢又会出错，而"到点什么"这件事本来就不需要模型理解。
   */
  async fireBySchedule(scheduleId, opts = {}) {
    const key = String(scheduleId ?? '').trim();
    if (!key) return fail('没有 schedule_id');
    const task = this.#tasks.find((t) => t && t.scheduleId === key);
    if (!task) return fail(`没有对应 ${key} 的任务（可能已经删了）`);
    return this.fire(task.id, opts);
  }

  /**
   * 到点响应：按记录把提醒投给目标会话并唤醒它。
   *
   * 只有总机会话能调（`caller` 校验在工具层做，那里才知道是谁在调）；这里只管"这一次算处理完了"。
   */
  async fire(id, { note = '', caller = '', manual = false } = {}) {
    const key = String(id ?? '').trim();
    const task = this.#tasks.find((t) => t.id === key);
    if (!task) return fail(`没有这个任务：${key}。用 list 看一眼 id`);
    if (caller && caller !== TASK_SESSION_KEY) {
      return fail('这是任务到点的内部动作。自己排的提醒用 create，别直接调 fire');
    }
    if (!task.active) return fail(`任务 ${key} 已经结束了`);
    // 暂停的任务不该被叫醒（复审 F11）：以前暂停只拆了宿主排期，`active` 仍是 true，
    // 一旦轮换或别的路径走到这里，它照样会响。
    if (task.paused) return fail(`任务 ${key} 暂停着：要它继续响就先 resume。`);
    /**
     * 两本账（第三轮 T11）：`#fired` 记"到点真的响过了"，`#trials` 记"人让我试跑"。
     * 以前共用一个 Map，试跑一次就把正式那次占位占了——到点时被当成"已经投过"。
     */
    const ledger = manual ? this.#trials : this.#fired;
    const last = ledger.get(key) ?? 0;
    // 已经投过就**正常返回**（`m36272`）：枢纽接管投递之后，中间人那一轮总会晚一步调到这里。
    // 报错会让模型以为失败、然后开始"想办法"（真机上这样白等过两分半）。
    if (Date.now() - last < FIRE_DEDUPE_MS) {
      return ok({ id: key, already: true, woke: task.target, note: '这一轮已经由枢纽投递过了' });
    }
    // **先占位再干活**（`m36360`）：宿主的同一次到点会先后发两个事件
    // （`agent/inbox/spliced` 与 `user/message`），枢纽两条都会看见。占位放在 `await` 之后，
    // 两次调用就都能通过去重检查——真机上就是同一个 20 秒提醒响了两次，第二份还排队等
    // 目标空闲，晚了一分多钟才砸下去。
    ledger.set(key, Date.now());

    const extra = String(note ?? '').trim();
    const text = [
      `[定时提醒] ${task.title}（${whenLabel(task.when)}）`,
      `提醒内容：${task.prompt}`,
      extra ? `补充：${extra}` : '',
      '（这是你自己排的提醒，不是谁在跟你说话。要不要说话、说什么，你定；不说也完全没问题。）',
    ]
      .filter(Boolean)
      .join('\n');

    // **不许在这儿等**（`m36117`）：`reawake` 会先等目标会话当前那一回合落定再叫醒它
    // （对话中就排队），目标那边只要还在跑，这一次 `fire` 就会挂在那里——真机上挂了 140 秒，
    // 宿主把整个 tool call 判成 aborted，那一条提醒就这么丢了。
    // 提醒本来就是排进去、等它空下来再说，所以这里只负责投递，不等结果。
    let woke = null;
    let rebuilt = false;
    /**
     * 在飞标记（第三轮 T11）：一次性任务正在排队等目标空下来时，轮换会把它按 `encodeWhen()`
     * 重建一份排期——等于这条提醒被排了两遍，或者倒计时被重置。轮换见到 `inflight` 就跳过。
     */
    const oneShot = this.#isOneShot(task);
    if (oneShot) task.inflight = true;
    const preceding = this.#running.get(key);
    const wakeP = Promise.resolve(preceding).catch(() => {})
      .then(() =>
        this.hub?.mind?.reawake?.(task.target, {
          reason: 'task',
          text,
          summary: `定时提醒：${task.title}`,
        }),
      )
      .then(
        (r) => r,
        (err) => ({ woke: false, reason: err?.message ?? String(err) }),
      );
    this.#running.set(key, wakeP);
    const settleInflight = () => {
      if (this.#running.get(key) !== wakeP) return;
      this.#running.delete(key);
      if (!oneShot) return;
      const hit = this.#tasks.find((t) => t.id === key);
      if (hit) delete hit.inflight;
    };
    let wakeTimer;
    try {
      woke = await Promise.race([wakeP, new Promise((r) => { wakeTimer = setTimeout(() => r(null), WAKE_ASYNC_MS); })]);
    } catch (err) {
      settleInflight();
      ledger.delete(key); // 失败不占位：允许下一轮再投
      this.#note(key, `失败：${err?.message ?? err}`);
      return fail(`叫醒 ${task.target} 失败：${err?.message ?? err}`);
    } finally { clearTimeout(wakeTimer); }
    if (woke === null) {
      // 还没叫醒就先记成已投递，结果等它落地了再补写。
      this.#note(key, '已投递，等那边空下来');
      void wakeP.then((r) => {
        settleInflight();
        const why = r?.woke === false ? r?.reason ?? '没叫醒' : '';
        this.#note(key, why ? `失败：${why}` : '已投递');
        // 一次性任务：**真叫醒了才退场**。没叫醒就留着，下一轮还能再响。
        // 手动试跑（`manual`）不退场（复审 F12）：人只是想看看效果，不该把明天的提醒用掉。
        if (why) ledger.delete(key);
        if (!why && !manual) this.#retireIfOneShot(key);
        this.#save();
        if (!manual) void this.#rotateIfNeeded().catch((err) => this.log(`排队任务结束后轮换失败：${err?.message ?? err}`));
      });
      if (!manual) await this.#rotateIfNeeded();
      return ok({ id: key, woke: task.target, every: whenLabel(task.when), queued: true });
    }
    settleInflight();
    if (woke?.woke === false) {
      ledger.delete(key);
      this.#note(key, `失败：${woke.reason ?? '没叫醒'}`);
      return fail(`叫醒 ${task.target} 没成功：${woke.reason ?? '宿主没接住这一轮'}`);
    }
    rebuilt = Boolean(woke?.result?.unarchive);
    const sent = Number(woke?.reply?.parts?.length ?? 0) || (woke?.reply ? 1 : 0);
    this.#note(key, sent > 0 ? `说了 ${sent} 条` : '静默');
    const finished = manual ? false : this.#retireIfOneShot(key);
    // 手动试跑不触发轮换（复审 F12）：轮换会把还没到点的一次性任务按 `encodeWhen()` 重建，
    // `after:60` 的倒计时因此被重置——试一下不该把别人的提醒往后推。
    if (!manual) await this.#rotateIfNeeded();
    return ok({ id: key, woke: task.target, every: whenLabel(task.when), rebuilt, ...(finished ? { finished: true } : {}) });
  }

  /** 立刻投一次（调试用）：不动排期，也不改任务本身。 */
  async run(id, { caller = '' } = {}) {
    const key = String(id ?? '').trim();
    // 同一条归属（`m85249` P1-4）：`run` 会真的叫醒目标会话、花一次模型调用，
    // 让谁都能按 id 触发别人的提醒，等于把"排任务"变成"骚扰任意群"的按钮。
    const task = this.#tasks.find((t) => t.id === key);
    if (task && !this.owns(task, caller)) {
      return fail(`跑不了 ${key}：这条不是你排的，也不叫醒你这个会话。要试就自己排一条。`);
    }
    this.#trials.delete(key); // 手动跑不受 60 秒去重限制（也不碰正式那本账，T11）
    // `run` 是"人让我现在试一下"，任何会话都能对自己的任务用；所以不传 caller（`fire` 里
    // 只有**非空** caller 才做总机校验——空串表示"这条不是定时器触发的"）。
    return this.fire(key, { caller: '', manual: true, requestedBy: caller });
  }

  /**
   * 总机上下文回收：触发满 N 次就换一条新会话，把排期整体搬过去。
   *
   * 顺序是**先建后删**：新排期全部建成才删旧的，所以中间没有"两头都没有"的空档。
   * 代价是重叠的几秒里同一个任务可能被两处各触发一次——`fire` 的 60 秒去重挡住。
   * 任何一步失败就整体回滚（删掉刚建的），旧会话继续用：宁可上下文涨，也不能让任务全丢。
   */
  async #rotateIfNeeded() {
    const every = this.resetEvery;
    if (!every || this.#busy || this.#running.size) return null;
    // 任何在飞任务仍引用旧总机；跳过单条却退役总机会把那条排期遗留在旧地址。
    const oneShots = this.#tasks.filter((t) => t.active && !t.paused && this.#isOneShot(t));
    if (oneShots.some((t) => !(Date.parse(t.nextAt) > Date.now()))) return null;
    const total = this.#tasks.reduce((sum, t) => sum + (Number(t.fireCount) || 0), 0);
    if (total < every) return null;
    this.#busy = true;
    const svc = this.hub?.scheduleSvcOf?.() ?? this.hub?.scheduleSvc;
    const from = this.#sessionId;
    const created = [];
    try {
      const next = `onebot-hub:tasks.r${Date.now().toString(36)}`;
      this.hub?.hostRef?.pinSessionId?.(TASK_SESSION_KEY, next);
      await this.hub?.mind?.pool?.retire?.(TASK_SESSION_KEY, 'task-reset').catch?.(() => {});
      this.#sessionId = next;
      await this.hub?.mind?.ensureAgent?.(TASK_SESSION_KEY);

      // 暂停的任务不搬（复审 F11）：它的排期已经被拆掉了，重建等于把"先别响"作废。
      for (const task of this.#tasks.filter((t) => t.active && !t.paused && !t.inflight)) {
        const parsed = parseWhen(this.#isOneShot(task) ? `at:${task.nextAt}` : encodeWhen(task.when));
        if (!parsed.ok) continue;
        const frame = `[定时提醒] 任务 ${task.id}「${task.title}」到点。\n处理它：onebot_task(op:'fire', id:'${task.id}')`;
        const record = await svc.create(next, { title: task.title, prompt: frame, ...parsed.host });
        created.push({ task, oldId: task.scheduleId, newId: String(record?.id ?? ''), nextAt: String(record?.scheduledAt ?? '') });
      }
      for (const row of created) {
        row.task.scheduleId = row.newId;
        row.task.sessionId = next;
        row.task.nextAt = row.nextAt;
        row.task.fireCount = 0;
      }
      for (const row of created) {
        if (!row.oldId) continue;
        try {
          await svc.delete({ sessionId: from, id: row.oldId });
        } catch {
          /* 删不掉旧排期只会多重触发一次，去重挡得住；不因此回滚已经成功的新排期 */
        }
      }
      this.#save();
      this.log(`定时任务总机会话已轮换：${from} → ${next}（搬了 ${created.length} 条）`);
      return { ok: true, from, to: next, moved: created.length };
    } catch (err) {
      for (const row of created) {
        try {
          await svc.delete({ sessionId: this.#sessionId, id: row.newId });
        } catch {
          /* 回滚尽力而为 */
        }
      }
      this.#sessionId = from;
      this.hub?.hostRef?.pinSessionId?.(TASK_SESSION_KEY, from);
      this.log(`定时任务总机会话轮换失败，继续用旧会话：${err?.message ?? err}`);
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      this.#busy = false;
    }
  }
}

/** 把内部 `when` 还原成 `when:` 小语法（轮换时要按同样的节奏重新排）。 */
export function encodeWhen(when) {
  if (!when) return '';
  if (when.kind === 'at') return `at:${new Date(Number(when.ts)).toISOString()}`;
  if (when.kind === 'after') return `after:${when.seconds}`;
  if (when.kind === 'daily') return `every:daily@${when.time}`;
  if (when.kind === 'every') return `every:${when.seconds}`;
  return '';
}

/** 把宿主的 `ScheduleToolError` 翻成模型看得懂的一句话（别把 code 直接甩给它）。 */
export function scheduleErrorText(err) {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? err ?? '');
  if (code === 'frequency_too_high') return `排得太密了：${message}`;
  if (code === 'not_future') return `那个时刻已经过去了：${message}`;
  if (code === 'invalid_time_zone') return `时区不对：${message}`;
  if (code === 'invalid_prompt' || code === 'invalid_rule') return `内容或节奏不合法：${message}`;
  if (code === 'subagent_session') return '这个会话是子 agent 的，宿主不接受给它排任务';
  return `排期失败：${message}`;
}
