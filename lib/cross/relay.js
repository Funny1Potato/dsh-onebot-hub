/**
 * 会话间转达（`m25983` 需求，`m26026` 定稿：**东西交给 B，发不发由 B 决定**）。
 *
 * 一句话：A 在一个会话里看见值得搬的东西，把「说明 + 包」递给另一个会话的 agent B；
 * B 自己决定发、加两句再发、还是不动。枢纽只负责取内容、打包、递条，**不替 B 开口**。
 *
 * 三条设计上的硬边界，都是刻意留的：
 *  1. **内容由枢纽搬，模型只写字条**。小程序卡（`json` 段）、合并转发（`forward`/`node` 段）
 *     这类整段透传的东西，模型**不能自己构造**——它只能引用枢纽打包好的 `pkg_xxx`。
 *     否则任何会话都能凭一句 tool call 伪造一张「官方通知」卡片。
 *  2. **私聊来源只禁"原文"**（`cross.allowPrivateRefs`，`m26268` 收窄、`m26439` 扩到所有方向）：
 *     私聊里取到的原消息（`refs`/包）默认不能搬到**任何别的会话**——群和私聊一样，
 *     私聊里说的话，用户期待它留在那个私聊里。模型自己写的 `text`（转述）是允许的，过一遍敏感词。
 *     其余方向（群→群、群→私聊）不受这个开关管。
 *  3. **不自动标注来源**：群友看到的就是一条转发，说不说"从哪儿来的"由 B 判断（字条里已经给了出处）。
 *
 * `m26268` 把它从"快递"升级成"对讲机"：一次 `relay` 会开一条 **通道**（`ch_xxx`，30 分钟、
 * 每方 6 句、10 分钟没人说话就冷掉），两头都能用 `say` 接着说，`close` 提前收线。
 * 同时把"私聊 → 群"的限制拆成两半：**原文（`refs`/包）仍然禁止**，因为整段原封搬进群
 * 不可撤销；**转述（`text`）允许**，但要过一遍敏感词——用户 m26268 的原话是
 * "私聊到群聊的限制可以只限制消息原文的传递，可由 agent 转写并注意隐私信息"。
 */

import { createHash } from 'node:crypto';
import { PackageStore, DEFAULT_PACKAGE_TTL_MS, DEFAULT_PACKAGE_MAX_BYTES } from './packages.js';
import { ChannelStore, DEFAULT_CHANNEL_TTL_MS, DEFAULT_CHANNEL_SILENT_MS, DEFAULT_CHANNEL_MAX_PER_SIDE } from './channels.js';
import { isSensitive } from '../memory/isolation.js';
import { segmentsOf } from '../protocol.js';

/** `note` 是给 B 的说明，不是要发的原文——给一个上限，免得变成一整段转述。 */
export const MAX_NOTE_CHARS = 300;

/** 单次转达最多搬几条消息（多条才用得上合并转发）。 */
export const MAX_REFS = 20;

/** 通道里一句话的上限（字）。长了就拆几句说——对面一次只收一条字条。 */
export const MAX_SAY_CHARS = 600;

/** 搬运形态。**`as` 必填**（用户 m26026：每次转都要 A 自己判断，不给默认值）。 */
export const RELAY_FORMS = ['message', 'forward'];

/** 这些段能原样搬过去；其余（语音/视频/文件）降级成一句占位说明。 */
const SENDABLE_TYPES = new Set(['text', 'image', 'at', 'face', 'mface', 'json', 'xml', 'forward', 'node']);

const DEGRADED_LABEL = {
  record: '语音',
  video: '视频',
  file: '文件',
  video_url: '视频',
  poke: '戳一戳',
  dice: '骰子',
  shake: '窗口抖动',
};

/**
 * 从宿主给的 agent id 里认出**枢纽会话键**。
 *
 * 宿主眼里的 agent id 是 `SessionId('onebot-hub:' + encodeURIComponent(sessionKey))`，
 * 真机上长这样：`onebot-hub:private%3A945126014.amvq0zx9vok64`（尾巴是本次激活的序号）。
 * 所以直接拿 `/^(group|private):/` 去测会**永远为假**——2026-10-27 真机就是这么被误拒的：
 * 发起方明明是枢纽自己的私聊会话，却被判成"不是枢纽会话"。
 *
 * 认不出来（比如普通工作区会话）返回空串。**不要**退回去用"枢纽最近活动的会话"顶替，
 * 那等于让外部会话借壳发言。
 */
export function scopeOfAgentId(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  // 裸会话键也按"截到号码为止"取：`private:10001.a<激活序号>` 这种带后缀的 id
  // 如果整串返回，后面拿它比对来源作用域就会永远不等（`private:10001.a1b2` ≠ `private:10001`）。
  const direct = raw.match(/^(group|private):(\d+)/);
  if (direct) return `${direct[1]}:${direct[2]}`;
  // 宿主那份是 `SessionId('onebot-hub:' + encodeURIComponent(会话键))`，可能被再转义一层，
  // 所以最多解两次（`%253A` → `%3A` → `:`）；解不动就用原串继续找。
  let decoded = raw;
  for (let i = 0; i < 2; i += 1) {
    let next = decoded;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // 坏转义：保留当前串，下面用已经解开的进度找
    }
    const m = next.match(/(?:^|[^0-9A-Za-z])(group|private):(\d+)/);
    if (m) return `${m[1]}:${m[2]}`;
    if (next === decoded) break; // 没有新的可解，别空转
    decoded = next;
  }
  return '';
}

/**
 * 这次调用是谁发起的。
 *
 * `exec.agent.id` 优先（宿主给的，模型伪造不了）。它**没给出枢纽会话键**就直接空着、
 * 不退回 `fallback`——否则普通会话在宿主不给 id 的环境里能借枢纽最近那轮的身份说话。
 * 只有宿主压根没给 id（老版本 / 嵌入场景）才用 `fallback`。
 */
export function callerOf(exec, fallback = '') {
  const id = String(exec?.agent?.id ?? '').trim();
  if (id) return scopeOfAgentId(id);
  // `fallback` 可以是函数：调用点在那个"只有宿主没给 id 才求值"的路径上，别提前算。
  const fb = typeof fallback === 'function' ? fallback() : fallback;
  return String(fb ?? '').trim();
}

/** `group:123456789` → `群 123456789`；`private:10001` → `10001 的私聊`。 */
export function labelOfScope(scope) {
  const s = String(scope ?? '');
  if (s.startsWith('group:')) return `群 ${s.slice(6)}`;
  if (s.startsWith('private:')) return `${s.slice(8)} 的私聊`;
  return s || '未知会话';
}

/** 字条正文（`m26026` 定稿；不要再写"已经放到这个群里了"——B 才是发送方）。 */
export function letterFor({ fromLabel = '', fromScope = '', note = '', packageId = '', parcel = '', caveats = [], channel = '', left = 0, transcribed = false } = {}) {
  const lines = [
    `【会话间的转达】来自 ${fromScope || fromLabel}（${fromLabel || '未知会话'}）。`,
    '递信的是那边的另一个你。',
  ];
  if (transcribed) {
    // 私聊 → 群走的是转述路线：必须让 B 知道自己听到的是二手话，不是原始记录。
    lines.push('（这段话是那边的 agent 用自己的话转述的，不是原文；细节可能已经被它删掉。）');
  }
  const body = String(note ?? '').trim();
  if (body) lines.push(`它觉得这个这边用得上：${body.slice(0, MAX_NOTE_CHARS)}`);
  if (packageId) {
    lines.push(`东西在我这儿，是个包（${packageId}）。`);
    if (parcel) lines.push(`包里有：${parcel}。`);
    // 转不过来的东西要跟着说：不然 B 以为收齐了，发出去少一段自己还不知道。
    for (const c of (Array.isArray(caveats) ? caveats : []).slice(0, 3)) lines.push(`注意：${c}。`);
    lines.push('要发就把包带上一起发；想加两句就一起写。');
  }
  if (channel) {
    lines.push(
      `这是一条会话间的通道（${channel}），你有 ${left} 句话可以说。要接着聊就调 \`onebot_session\`：` +
        `{"op":"say","channel":"${channel}","text":"…"}；聊完了可以 \`{"op":"close","channel":"${channel}"}\` 收线。`,
    );
  }
  lines.push('不想接就不用动——那边不会追问，这条线会自己过期。');
  return lines.join('\n');
}

/**
 * 通道里的一句（`m26268`）。和开线时的字条分开写，因为这里**每句都要带轮次与剩余句数**——
 * 让模型知道"我还能说 2 句"，比突然被拒要体面得多。
 */
export function letterForSay({ fromLabel = '', fromScope = '', text = '', channel = '', round = 1, left = 0, transcribed = false } = {}) {
  const lines = [
    `【会话间的对话】${fromScope}（${fromLabel || '未知会话'}）· 通道 ${channel} · 第 ${round} 轮`,
  ];
  if (transcribed) lines.push('（这段话是那边的 agent 用自己的话转述的，不是原文。）');
  lines.push(`那边说：${String(text ?? '').trim().slice(0, MAX_NOTE_CHARS * 2)}`);
  lines.push(
    `要接着回就 \`{"op":"say","channel":"${channel}","text":"…"}\`（你还能说 ${left} 句）；` +
      '不想接就不用管，这条线会自己过期。',
  );
  return lines.join('\n');
}

/** 包里的东西长什么样：只报形状，不报内容。
 *
 * 为什么要有：字条原来只说"东西在我这儿，是个包（pkg_xxx）"——B 看不见包里是什么，只能
 * 要么不看就发、要么白开一次通道问"这是什么"。报形状（几张图、几段字）足够它判断轻重，
 * 又不至于把内容提前泄给一个还没决定接不接的会话。
 */
const PARCEL_KINDS = [
  ['image', '张图片'],
  ['card', '张卡片'],
  ['text', '段文字'],
  ['face', '个表情'],
  ['at', '处 @'],
];
const PARCEL_TYPE_OF = { image: 'image', json: 'card', xml: 'card', text: 'text', face: 'face', mface: 'face', at: 'at' };

export function describeParcel(segments = []) {
  const count = new Map();
  let records = 0;
  let recordMsgs = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = String(seg?.type ?? '').toLowerCase();
    if (type === 'node') {
      records += 1;
      recordMsgs += 1;
      continue;
    }
    if (type === 'forward') {
      records += 1;
      const nodes = Array.isArray(seg?.data?.content) ? seg.data.content : [];
      recordMsgs += nodes.length || 1;
      continue;
    }
    const kind = PARCEL_TYPE_OF[type];
    if (!kind) continue;
    count.set(kind, (count.get(kind) ?? 0) + 1);
  }
  // 顺序按"看图先看图"：图片 → 卡片 → 文字 → 表情 → @；聊天记录压在最后（它本身是一整包）。
  const parts = PARCEL_KINDS.filter(([kind]) => count.get(kind)).map(([kind, noun]) => `${count.get(kind)} ${noun}`);
  if (records) {
    parts.push(records === 1 ? `1 条聊天记录（${recordMsgs} 条消息）` : `${records} 条聊天记录（合计 ${recordMsgs} 条消息）`);
  }
  if (!parts.length) return '';
  if (parts.length > 4) return `${parts.slice(0, 4).join('、')} 等 ${parts.length} 项`;
  return parts.join('、');
}

/** 段数组 → 可搬的段 + 降级说明。图片原样带 `file`（上游地址在短时间内有效，够发送用）。 */
export function transcode(segments = []) {
  const sendable = [];
  const degraded = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = String(seg?.type ?? '').toLowerCase();
    if (!type) continue;
    // `reply` 段（"这条是在回某某那句"）不搬，也**不报**：它指向的消息在新会话里根本不存在，
    // 报成"那边还有一段 reply 转不过来"只是噪声（`m27100` 自查）。
    if (type === 'reply') continue;
    if (type === 'at' && String(seg?.data?.qq ?? '') === 'all') {
      // `@全体成员` 不能跟着搬：它在新会话里会变成一次真通知，把一整个群的人叫一遍。
      // 降级成纯文字，人还是看得见"@全体成员"这几个字，但不会响。
      sendable.push({ type: 'text', data: { text: '@全体成员' } });
      degraded.push('那边 @ 了全体成员，转过来改成普通文字（不响）');
      continue;
    }
    if (SENDABLE_TYPES.has(type)) {
      sendable.push(seg);
      continue;
    }
    const label = DEGRADED_LABEL[type] ?? type;
    const dur = Number(seg?.data?.duration ?? 0);
    const size = Number(seg?.data?.file_size ?? 0);
    const extra = dur > 0 ? `（${Math.round(dur)} 秒）` : size > 0 ? `（${Math.round(size / 1024)} KB）` : '';
    degraded.push(`那边还有一段${label}${extra}，转不过来`);
  }
  return { sendable, degraded };
}

/** 指纹：同一个人把同几条消息反复搬，10 分钟内只算一次。 */
function fingerprintOf({ from, to, as, refs, text }) {
  const body = [from, to, as, ...(refs ?? []).map(String), String(text ?? '').slice(0, 120)].join('|');
  return createHash('sha1').update(body).digest('hex').slice(0, 16);
}

export class CrossRelay {
  #sends = new Map(); // fingerprint -> ts
  #hits = new Map(); // `${from}|${to}` -> number[]（时间戳）

  constructor({ hub = null, mind = null, host = null, config = null, log = () => {}, now = Date.now } = {}) {
    const cfg = config?.cross ?? {};
    this.hub = hub;
    this.mind = mind;
    this.host = host;
    this.cfg = {
      enabled: cfg.enabled === true,
      allowFrom: String(cfg.allowFrom ?? 'hub'),
      allowTo: Array.isArray(cfg.allowTo) ? cfg.allowTo.map(String) : [],
      // 老名字 `allowPrivateToGroup` 只在没发布过的本地配置里出现过，当别名读，不报错。
      allowPrivateRefs: (cfg.allowPrivateRefs ?? cfg.allowPrivateToGroup) === true,
      relayMaxPerWindow: Math.max(1, Number(cfg.relayMaxPerWindow) || 3),
      windowMs: Math.max(1000, Number(cfg.windowMs) || 300000),
      packageTtlMs: Math.max(1000, Number(cfg.packageTtlMs) || DEFAULT_PACKAGE_TTL_MS),
      maxBytes: Math.max(1024, Number(cfg.maxBytes) || DEFAULT_PACKAGE_MAX_BYTES),
      channelTtlMs: Math.max(1000, Number(cfg.channelTtlMs) || DEFAULT_CHANNEL_TTL_MS),
      // 0 = 不按沉默冷掉（只看 TTL）；`|| DEFAULT` 会把 0 吃掉，所以单独判。
      channelSilentMs: (() => {
        const v = Number(cfg.channelSilentMs);
        return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CHANNEL_SILENT_MS;
      })(),
      channelMaxPerSide: Math.max(1, Number(cfg.channelMaxPerSide) || DEFAULT_CHANNEL_MAX_PER_SIDE),
    };
    this.log = log;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.packages = new PackageStore({ ttlMs: this.cfg.packageTtlMs, maxBytes: this.cfg.maxBytes, now: this.#now });
    this.channels = new ChannelStore({
      ttlMs: this.cfg.channelTtlMs,
      silentMs: this.cfg.channelSilentMs,
      maxPerSide: this.cfg.channelMaxPerSide,
      now: this.#now,
    });
    this.stats = { relayed: 0, delivered: 0, refused: 0, degraded: 0, receipts: 0, said: 0, closed: 0 };
  }

  #now;

  get enabled() {
    return this.cfg.enabled === true;
  }

  /**
   * 当前时钟。测试注入的是假表，`list` 里算"还剩多久过期"也得走它——
   * 直接用 `Date.now()` 会和通道自己的判活用两个钟（`m27100` 自查）。
   */
  now() {
    return this.#now();
  }

  /** 供 `onebot_reply` 的 `parts:[{"type":"package","id":…}]` 展开。取走即消耗。 */
  takePackage(id) {
    return this.packages.take(id);
  }

  /**
   * `to` 到底归不归枢纽管（`m26473` 自查）。
   *
   * 不加这道闸，模型（或群里某人塞进来的"帮我转给 group:999999"）就能让枢纽去叫醒一个
   * 根本没配的群，那边真回复了就成"机器人在没人管的群里说话"。名单在 `resolveConfig` 里
   * 恒存在（哪怕空对象），所以"空"就是"一个都不服务"，不是"全都服务"。
   * 宿主没给名单（嵌入/测试）时不拦。
   */
  #addressable(scope) {
    const key = String(scope ?? '');
    if (!/^(group|private):/.test(key)) return Boolean(this.host?.getLive?.(key));
    const groups = this.hub?.config?.agentGroups;
    const privates = this.hub?.config?.agentPrivates;
    if (!groups && !privates) return true;
    const id = key.slice(key.indexOf(':') + 1);
    const book = key.startsWith('group:') ? groups : privates;
    return Boolean(book) && book[id] !== undefined;
  }

  /** 可投递的会话清单。只列 hub 自己的会话（能真发消息的那些）＋ 活着的外部会话。 */
  list() {
    const out = [];
    const seen = new Set();
    // `statsSnapshot` 是 **getter**，不是方法——多写一对括号就会炸在这里。
    const states = this.mind?.statsSnapshot?.wakeStates ?? null;
    const add = (scope, extra = {}) => {
      const key = String(scope ?? '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ to: key, label: labelOfScope(key), ...extra });
    };
    const groups = this.hub?.config?.agentGroups ?? null;
    const privates = this.hub?.config?.agentPrivates ?? null;
    for (const id of Object.keys(groups ?? {})) add(`group:${id}`, { kind: 'group' });
    for (const id of Object.keys(privates ?? {})) add(`private:${id}`, { kind: 'private' });
    // 白名单没配时至少给出"当前活着的那些"
    if (!out.length) {
      for (const key of Object.keys(states ?? {})) add(key, { kind: key.startsWith('group:') ? 'group' : 'private' });
    }
    return out;
  }

  #rateOk(from, to) {
    const key = `${from}|${to}`;
    const now = this.#now();
    const list = (this.#hits.get(key) ?? []).filter((t) => now - t < this.cfg.windowMs);
    if (list.length >= this.cfg.relayMaxPerWindow) {
      this.#hits.set(key, list);
      return { ok: false, reason: `太频繁：${Math.round(this.cfg.windowMs / 60000)} 分钟内最多 ${this.cfg.relayMaxPerWindow} 次` };
    }
    list.push(now);
    this.#hits.set(key, list);
    return { ok: true };
  }

  /** 退掉刚占的一个频率名额（递送失败时用：没送出去就不该占额度）。 */
  #rateRefund(from, to) {
    const list = this.#hits.get(`${from}|${to}`);
    if (Array.isArray(list) && list.length) list.pop();
  }

  /**
   * 去重表的回收（`m27100` 自查）：它原来只长不消——每转达成功一次多一条，
   * 而真正有用的只是最近 10 分钟那几条。攒到一定规模顺手清一遍过期的，
   * 免得跑上几个月留下几千条永远不会再命中的指纹。
   */
  #pruneSends() {
    if (this.#sends.size < 256) return;
    const now = this.#now();
    for (const [fp, at] of this.#sends) {
      if (now - at >= 10 * 60 * 1000) this.#sends.delete(fp);
    }
  }

  /**
   * 从上一条消息里搬内容。
   * `get_msg` 是标准 OneBot 动作；取不到的条目降级成一句占位（不静默丢）。
   */
  async #fetchOne(ref, fromScope = '') {
    const id = String(ref ?? '').trim();
    if (!id) return { segments: [], error: '空的消息 id' };
    // 先问枢纽自己的时间线（本地就有，不受上游是否支持 get_msg 影响）。
    // `m26473` 自查：这里原来有两个坑——`Timeline` 上压根没有 `byId`（恒 null），
    // 而本地条目根本没有 `segments`（段在 `payload.message` 里），所以这条"先问本地"从来没走过。
    const local = this.hub?.timeline?.byId?.(id) ?? null;
    if (local) {
      // 只能搬**你自己这个会话**里看见过的消息：不然 A 在群 1 里凭一个 id 就能把群 2 的话搬走。
      const owner = String(local.sessionKey ?? '');
      if (fromScope && owner && owner !== fromScope) {
        return { segments: [], error: `这条消息不在你现在的会话里（它在 ${owner}）` };
      }
      const segments = segmentsOf(local.payload ?? null);
      if (segments.length) {
        return {
          segments,
          sender: local.actor?.user_id != null ? { user_id: local.actor.user_id, nickname: local.actor.nickname ?? '', card: '' } : null,
          source: 'timeline',
        };
      }
    }
    const res = await this.hub?.callAction?.({ action: 'get_msg', params: { message_id: id }, source: 'cross' });
    if (res?.retcode !== 0) return { segments: [], error: res?.wording ?? res?.message ?? '取不到这条消息' };
    const data = res.data ?? {};
    // 本地没记账时只能问上游，那也得核对"这条是不是你这个会话的"。
    const mismatch = this.#foreignMessage(fromScope, data);
    if (mismatch) return { segments: [], error: mismatch };
    const message = Array.isArray(data.message) ? data.message : Array.isArray(data.raw_message) ? data.raw_message : [];
    return { segments: message, sender: data.sender ?? null, source: 'upstream' };
  }

  /** 上游 `get_msg` 回来的这条，与发起方会话对不对得上？对不上就说清为什么。 */
  #foreignMessage(fromScope, data = {}) {
    const scope = String(fromScope ?? '');
    if (!/^(group|private):/.test(scope)) return null;
    const gid = data.group_id == null ? '' : String(data.group_id);
    if (scope.startsWith('group:')) {
      const want = scope.slice(6);
      if (gid && gid !== want) return `那条消息是群 ${gid} 的，不是你现在这个群`;
      return null;
    }
    if (gid) return '那条消息是群里发的，不是这个私聊里的';
    const uid = String(data.user_id ?? data.sender?.user_id ?? '');
    const want = scope.slice(8);
    if (uid && uid !== want) return `那条消息是 ${uid} 发的，不是这个私聊里的人`;
    return null;
  }

  /**
   * 主入口。`as` 必填（`m26026`）：A 每次都要自己判断这是"原样一条"还是"合并转发"。
   */
  async relay({ from, to, note, refs = [], text = '', as = null } = {}) {
    if (!this.enabled) return { ok: false, error: '会话间转达没有开启（配置项 `cross.enabled`）' };
    const form = String(as ?? '').trim();
    if (!form) return { ok: false, error: '缺少 `as`：这次转达要显式选 `message`（原样一条）还是 `forward`（合并转发）' };
    if (!RELAY_FORMS.includes(form)) return { ok: false, error: `\`as\` 只能是 ${RELAY_FORMS.join(' / ')}，收到的是「${form}」` };

    const fromScope = String(from ?? '');
    const toScope = String(to ?? '').trim();
    if (!toScope) return { ok: false, error: '缺少 `to`（目标会话）' };

    // 发起方必须是 hub 自己的会话（`exec.agent.id` 给的，不信任参数自报）。
    if (this.cfg.allowFrom === 'hub' && !/^(group|private):/.test(fromScope)) {
      return { ok: false, error: '只有枢纽自己拉起的会话能做跨会话转达' };
    }
    if (toScope === fromScope) {
      return { ok: false, error: '不能转给自己：`to` 就是你现在这个会话。要跟自己说话不用开通道。' };
    }
    if (this.cfg.allowTo.length && !this.cfg.allowTo.includes(toScope)) {
      return { ok: false, error: `目标会话不在白名单里（allowTo）：${toScope}` };
    }
    if (!this.#addressable(toScope)) {
      return {
        ok: false,
        error: `「${toScope}」不归枢纽管：它既不在 agent.groups / agent.privates 里，也不是活着的会话。用 onebot_session 的 list 看能递给谁。`,
      };
    }
    // 私聊来源：**只限制"原文"**（`m26268` 收窄到"原文"、`m26439` 扩到所有目标）。
    // `refs` 是整段原封搬运，从私聊搬进群或另一个私聊都不可撤销，所以默认关；
    // 模型自己写的 `text` 是转述，允许——但要让代码把隐私词过一遍，别把卡号工资一起转述出去。
    const crossing = fromScope.startsWith('private:');
    let ids = (Array.isArray(refs) ? refs : []).map(String).filter(Boolean).slice(0, MAX_REFS);
    const bodyText = String(text ?? '').trim();
    const droppedRefs = [];
    if (crossing && ids.length && !this.cfg.allowPrivateRefs) {
      droppedRefs.push(...ids);
      ids = [];
    }
    // `note` 也算转述：它是模型写给对面看的一整段说明，和 `text` 一样会原样递过去。
    // 只查 `text` 等于留了个后门——把内容挪进 `note` 就能绕过去（`m26473` 自查）。
    const probe = [String(note ?? ''), bodyText].filter(Boolean).join('\n');
    if (crossing && probe && isSensitive({ text: probe })) {
      this.stats.refused += 1;
      return { ok: false, error: '这段转述里带着能定位到个人的隐私（住址/证件/工资/病历这类），不能搬出去。改写或放弃。' };
    }
    if (!ids.length && !bodyText) {
      if (droppedRefs.length) {
        this.stats.refused += 1;
        return { ok: false, error: '私聊里的原文不能搬到别的会话：要么改成自己的话（`text`）转述，要么别转。' };
      }
      return { ok: false, error: '没有可转达的内容：给 `refs`（消息 id）或 `text`' };
    }

    // 「同样几条内容刚转过」先判，而且**不占频率名额**（`m27100` 自查）：
    // 原来顺序反了——连按三次重复内容就把五分钟的三个名额全吃光，真想转点别的反而被
    // "太频繁"挡住。去重是本地判断，一分钱不花，没理由排在限流后面。
    const fp = fingerprintOf({ from: fromScope, to: toScope, as: form, refs: ids, text });
    const lastAt = this.#sends.get(fp) ?? 0;
    if (this.#now() - lastAt < 10 * 60 * 1000) {
      this.stats.refused += 1;
      return { ok: false, error: '同样几条内容刚转达过（10 分钟内不重复搬）' };
    }

    const rate = this.#rateOk(fromScope, toScope);
    if (!rate.ok) {
      this.stats.refused += 1;
      return { ok: false, error: rate.reason };
    }
    // 从这一行往下，每一条"没成"的返回都要把名额还回去（`m27100`）：
    // 占额度是为了挡连发，不是为了惩罚一次失败——否则取不到消息、包太大都会白扣一次。

    const degraded = [];
    const nodes = [];
    const plain = [];
    if (String(text ?? '').trim()) plain.push({ type: 'text', data: { text: String(text).trim() } });
    for (const id of ids) {
      const got = await this.#fetchOne(id, fromScope);
      if (got.error) {
        degraded.push(`有一条消息没取到（${id}）：${got.error}`);
        continue;
      }
      const { sendable, degraded: deg } = transcode(got.segments);
      degraded.push(...deg);
      if (!sendable.length) continue;
      if (form === 'forward') {
        const sender = got.sender ?? {};
        nodes.push({
          type: 'node',
          data: {
            uin: String(sender.user_id ?? 0) === '0' ? '0' : String(sender.user_id),
            name: String(sender.card || sender.nickname || this.#nameOf(sender.user_id) || '某人').slice(0, 40),
            content: sendable,
          },
        });
      } else {
        plain.push(...sendable);
      }
    }

    // 合并转发至少要有两条才有意义；只有一条时如实说明，退回单条。
    let segments = plain;
    let actualForm = form;
    if (form === 'forward') {
      if (nodes.length === 0) {
        // 只有一段话、没有可打包的消息：如实降级成单条，别让"as 选错"把整次转达废掉。
        if (!plain.length) return { ok: false, error: '没有可打包成合并转发的内容', degraded };
        actualForm = 'message';
        segments = plain;
        degraded.push('这次只有一段话，没有可打包的消息，已按单条发送');
      } else if (nodes.length === 1 && plain.length === 0) {
        actualForm = 'message';
        segments = nodes[0].data.content;
        degraded.push('只有一条消息，合并转发没意义，已按单条发送');
      } else {
        segments = [...plain, ...nodes];
      }
    }
    // 失败时也把 degraded 带回去：不然模型只知道"没内容"，不知道为什么（`m26473`）。
    if (!segments.length) {
      this.#rateRefund(fromScope, toScope);
      return { ok: false, error: '没有可转达的内容（取到的消息里没有能搬的段）', degraded };
    }

    const parcel = describeParcel(segments);
    const pkg = this.packages.put({ segments, from: fromScope, to: toScope, note: String(note ?? ''), as: actualForm, summary: parcel });
    if (!pkg) {
      this.#rateRefund(fromScope, toScope);
      return { ok: false, error: '打包失败（内容为空）' };
    }
    if (pkg.rejected === 'too-large') {
      this.#rateRefund(fromScope, toScope);
      return { ok: false, error: `内容太大（${Math.round(pkg.bytes / 1024)} KB，上限 ${Math.round(pkg.maxBytes / 1024)} KB）` };
    }

    // 开一条通道（`m26268`）：递过去的不只是一张字条，而是一条两头都能接着说的线。
    const channel = this.channels.open({
      from: fromScope,
      to: toScope,
      fromLabel: labelOfScope(fromScope),
      toLabel: labelOfScope(toScope),
    });
    const opening = this.channels.note(channel.id, 'a', this.#now());
    const letter = letterFor({
      fromScope,
      fromLabel: labelOfScope(fromScope),
      note,
      packageId: pkg.id,
      parcel,
      caveats: degraded.slice(0, 3),
      channel: channel.id,
      left: this.channels.left(channel.id, 'b'),
      transcribed: crossing && Boolean(bodyText),
    });

    const delivered = await this.#deliver(toScope, letter, `转达自 ${fromScope}`);
    if (!delivered.ok) {
      this.packages.take(pkg.id); // 递不到就把包收掉，不占着
      this.channels.close(channel.id, '递送失败');
      // 递不到不算“转过”：指纹和频率额度都退回去，否则两条这么抖一下，
      // 五分钟里的三个名额就没了，重试还得撞“同样几条内容刚转达过”（`m26473` 自查）。
      this.#rateRefund(fromScope, toScope);
      return { ok: false, error: `内容已打包但递不到 ${toScope}：${delivered.error}`, degraded };
    }
    this.#pruneSends();
    this.#sends.set(fp, this.#now());
    this.stats.relayed += 1;
    this.stats.delivered += 1;
    if (droppedRefs.length) degraded.push(`私聊里的 ${droppedRefs.length} 条原消息没有转过去，只发了你的转述`);
    if (degraded.length) this.stats.degraded += 1;
    return {
      ok: true,
      to: toScope,
      as: actualForm,
      packageId: pkg.id,
      expiresAt: pkg.expiresAt,
      channel: channel.id,
      leftMine: opening?.left ?? null,
      leftTheirs: this.channels.left(channel.id, 'b'),
      degraded,
      note: '对方会话已经收到字条与包，一条通道开了。它发不发、加不加话由它判断；你也可以用 say 接着说。',
    };
  }

  /**
   * 在通道里说一句（`m26268`：两头都能说）。
   *
   * 每一句都要过三道：这条线还活着吗、这一方还有额度吗、跨私聊→群时这句里有没有隐私。
   * 三道都过才记轮次——先记后发会让"发失败"白吃掉一句额度。
   */
  async say({ from, channel: channelId, text } = {}) {
    if (!this.enabled) return { ok: false, error: '会话间转达没有开启（配置项 `cross.enabled`）' };
    const fromScope = String(from ?? '');
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: '缺少 `text`：要说的话' };
    if (body.length > MAX_SAY_CHARS) {
      // 这条检查必须在记轮次之前：说过头再报错的活，额度已经被扣掉了。
      return {
        ok: false,
        error: `这一句 ${body.length} 字，太长了（上限 ${MAX_SAY_CHARS}）。对面只能收到一段话，长文拆成两三句说。`,
      };
    }
    const found = this.channels.sides(channelId, fromScope);
    if (!found) return { ok: false, error: `通道 ${channelId || '(空)'} 里没有你——通道号对不对？是不是另一条线？` };
    const live = this.channels.live(channelId);
    if (!live.ok) {
      this.stats.refused += 1;
      return { ok: false, error: live.reason };
    }
    const leftMine = this.channels.left(channelId, found.side);
    if (leftMine <= 0) {
      this.stats.refused += 1;
      return { ok: false, error: `你在这条通道里已经说满 ${this.cfg.channelMaxPerSide} 句了。用 close 收线吧。` };
    }
    const crossing = fromScope.startsWith('private:');
    // `say` 里 from 是私聊就已经是"往外搬"了（通道另一头必然不是自己），所以直接看来源。
    if (crossing && isSensitive({ text: body })) {
      this.stats.refused += 1;
      return { ok: false, error: '这段转述里带着能定位到个人的隐私（住址/证件/工资/病历这类），不能搬出去。改写或放弃。' };
    }
    const marker = this.channels.note(channelId, found.side, this.#now());
    if (!marker) {
      this.stats.refused += 1;
      return { ok: false, error: `你在这条通道里已经说满 ${this.cfg.channelMaxPerSide} 句了。用 close 收线吧。` };
    }
    const letter = letterForSay({
      fromScope,
      fromLabel: labelOfScope(fromScope),
      text: body,
      channel: channelId,
      round: marker.round,
      left: this.channels.left(channelId, found.otherSide),
      transcribed: crossing,
    });
    const delivered = await this.#deliver(found.other.scope, letter, `通道 ${channelId} 第 ${marker.round} 轮`);
    if (!delivered.ok) {
      // 递不到就把这一句的额度还回去——否则一次网络抖动就白扣一句。
      // 注意要走 `refund()`：`get()` 给的是浅拷贝，在拷贝上改 turns 不会生效。
      this.channels.refund(channelId, found.side, marker.prevLastAt);
      this.stats.refused += 1;
      return { ok: false, error: `递不到 ${found.other.scope}：${delivered.error}` };
    }
    this.stats.said += 1;
    return {
      ok: true,
      channel: channelId,
      to: found.other.scope,
      round: marker.round,
      left: this.channels.left(channelId, found.side),
      note: '这一句已经递过去了。它回不回由它判断。',
    };
  }

  /** 提前收线（任一方都行）。收完两边再 say 都会拿到"通道已关闭"。 */
  close({ from, channel: channelId, reason = '' } = {}) {
    if (!this.channels.sides(channelId, String(from ?? ''))) {
      return { ok: false, error: `通道 ${channelId || '(空)'} 里没有你` };
    }
    const rec = this.channels.get(channelId);
    if (rec?.closed) return { ok: true, channel: channelId, closed: true, reason: rec.reason };
    this.channels.close(channelId, String(reason ?? '').trim() || '对方收线');
    this.stats.closed += 1;
    return { ok: true, channel: channelId, closed: true, note: '收线了。那边再说会被告知通道已关闭。' };
  }

  /** 名字：优先人物档案，其次空。 */
  #nameOf(userId) {
    const id = String(userId ?? '');
    if (!id) return null;
    const p = this.hub?.profiles?.person?.(id) ?? null;
    const names = Array.isArray(p?.names) ? p.names : [];
    return names.length ? String(names[names.length - 1]?.name ?? '') || null : null;
  }

  /** 递字条：hub 会话走 `mind.reawake`（会唤醒它）；外部会话走活的 agent 的 `followup`。 */
  async #deliver(toScope, letter, summary) {
    const scope = String(toScope ?? '');
    if (/^(group|private):/.test(scope)) {
      if (!this.mind) return { ok: false, error: 'mind 不可用' };
      try {
        const res = await this.mind.reawake(scope, { reason: 'cross-relay', text: letter, summary });
        if (res?.woke === false) return { ok: false, error: `唤醒失败：${res?.reason ?? 'unknown'}` };
        return { ok: true, via: 'reawake' };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    }
    // 其它插件拉起的会话：只有它活着、且宿主给了我 followup 通道时才递得进去。
    const live = this.host?.getLive?.(scope) ?? null;
    if (!live || typeof live.followup !== 'function') {
      return { ok: false, error: '找不到这个会话（它可能没在运行），或它的 agent 不接受 followup' };
    }
    try {
      const msg = this.host?.createUserMessage
        ? this.host.createUserMessage({ content: [{ type: 'text', text: letter }], source: { kind: 'onebot-hub', form: 'chat', summary } })
        : { role: 'user', content: letter };
      await live.followup(msg);
      return { ok: true, via: 'followup' };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }
}
