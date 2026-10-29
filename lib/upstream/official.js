/**
 * 上游：QQ 官方机器人通道（QQ Bot 开放平台）。
 *
 * 它是什么：`connectUpstream()` 的**第三个实现**。上游在 hub 里本来就是个鸭子类型的对象
 * （`isConnected` / `request(action, params, timeoutMs)` / `start` / `stop` + 构造器里的
 * `onEvent` / `onStatus` / `onIdentity`），`UpstreamEndpoint`（正向 WS）与
 * `UpstreamListener`（反向 WS）各是一个实现。这里再给一个：把官方通道装成"假的 OneBot 实现端"。
 *
 * 为什么要装：`handleUpstreamEvent` 之后的整条链（防环 → 命令 → 时间线 → 抓包 → 档案 →
 * 媒体 → 成员 → 能力 → 交付下游）全是按 OneBot v11 写的。装成实现端，那条链一行不用改，
 * 下游 NoneBot 也看不出上游换了。
 *
 * 三件必须自己做的事：
 *  1. **身份**：官方给的是 `openid` / `group_openid` 字符串，hub 到处按数字 id 用（白名单、
 *     `group:<gid>` 档案键、配额、下游插件）。这里派生**稳定的虚拟数字 id**：
 *     `sha256(appId|kind|openid)` 取前 12 位十六进制转十进制，落在 3e9–4e9 区间。
 *     同一个 openid 在任何机器上都是同一个号；appId 换了就换一套号——那是另一台机器人。
 *  2. **被动回复窗口**：官方发消息靠带原始 `msg_id` 做被动回复，窗口 5 分钟、上限 4 次。
 *     超过就只能主动推送（有额度、不能 @ 人）。`replyPlan()` 按这个规则决定这一条走哪条路。
 *  3. **能力洞**：群成员列表、群名、`get_msg`、群管理在官方通道上都没有。全部回
 *     `retcode 1404` + "官方通道不支持"，让 `capability` 记成不支持，而不是超时。
 *
 * 与 `dsh-qqbot` 的关系：不用它。那是端到端插件（QQ → 自己的 agent loop → LLM），
 * 桥接它等于两个 agent 抢同一句话。这里直连官方 REST + WS，只借它的协议事实。
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** 官方 API 域名（沙箱是另一套，凭据也不通用）。 */
const HOST_PROD = 'https://api.sgroup.qq.com';
const HOST_SANDBOX = 'https://sandbox.api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/**
 * 订阅位：群 @ 与私聊消息（GROUP_AND_C2C_EVENT）。
 * 官方只推"群里 @ 了机器人"的消息——所以 `requireMention` 在这条通道上是平台强制的，
 * 不是我们的配置项。私聊则全部推。
 */
const INTENT_GROUP_AND_C2C = 1 << 25;

/** 官方主动消息没有 5 分钟窗口，但受频控；被动回复上限 4 次 / 5 分钟。 */
const PASSIVE_WINDOW_MS = 5 * 60 * 1000;
const PASSIVE_MAX_TIMES = 4;

/** 虚拟 id 区间：避开真实 QQ 号（1e5–1e10 的一部分）与常见的测试号。 */
const ID_BASE = 3_000_000_000;
/** 虚拟号 ↔ 官方 openid 的对应表落盘位置（相对 `storage` 根）。 */
const PEERS_FILE = 'official/peers.json';
const ID_SPAN = 1_000_000_000;

/**
 * 附件类型 —— 官方 `files` 接口的 `file_type`（**不是** OneBot 的段类型名）。
 * 1 图片 / 2 视频 / 3 语音 / 4 文件。官方只认这四类，表情包按图片走。
 */
const MEDIA_FILE_TYPES = { image: 1, video: 2, record: 3, file: 4 };

/**
 * `openid` → 稳定的虚拟数字 id。
 *
 * 为什么不用自增序号：自增要靠本地映射文件，文件一丢、机器一换，"这个人"就换号了，
 * 而 `agent.groups` 白名单、记忆档案的 `group:<gid>` 键全都跟着错位。哈希派生没有状态，
 * 丢了文件也能算出同一个号。
 */
/**
 * 上游类型（`m34751`）：`onebot` = OneBot v11 实现端，`official` = QQ 官方机器人开放平台。
 *
 * 单一出处：`resolveConfig` 的归一、设置页下拉、`test/client-manifest.mjs` 的枚举对齐
 * 都读这一份——四处各抄一遍必然漂移成"下拉里有、配置里不认"。
 */
export const UPSTREAM_TYPES = ['onebot', 'official'];

export function virtualId(appId, kind, openid) {
  const raw = `${String(appId ?? '')}|${kind}|${String(openid ?? '')}`;
  const hex = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return String(ID_BASE + (parseInt(hex, 16) % ID_SPAN));
}

/** 反向查用：虚拟 id 只用于展示与匹配，真身永远在 `source` 里。 */
export const isVirtualId = (id) => /^[34]\d{9}$/.test(String(id ?? ''));

/** 官方通道不提供的 OneBot action（一次说清，别让下游靠超时去猜）。 */
export const UNSUPPORTED_ACTIONS = new Set([
  'get_msg',
  'get_group_member_list',
  'get_group_member_info',
  'get_group_info',
  'get_stranger_info',
  'get_friend_list',
  'get_group_list',
  'set_group_ban',
  'set_group_kick',
  'set_group_whole_ban',
  'set_group_admin',
  'set_group_leave',
  'set_group_card',
  'set_group_name',
  'set_group_special_title',
  'set_friend_add_request',
  'set_group_add_request',
  'send_like',
  'get_image',
  'get_record',
  'get_file',
  'clean_cache',
]);

const seg = {
  text: (text) => ({ type: 'text', data: { text } }),
  image: (url) => ({ type: 'image', data: { file: url, url } }),
  at: (qq) => ({ type: 'at', data: { qq } }),
};

/**
 * 官方消息内容 → OneBot 消息段。
 *
 * 官方给的是 `content` 字符串（`<@!123> 你好`）+ `attachments` 数组。这里做两件事：
 * 段落化，以及**把 `<@!openid>` 换成 `<at qq="虚拟号">`**——hub 判断"在叫我"看的是
 * `message` 里 `at` 段的 `qq === self_id`，而官方原文里只有 openid。
 */
export function toSegments(content, attachments) {
  const out = [];
  const text = String(content ?? '');
  const re = /<@!?([^>\s]+)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(seg.text(text.slice(last, m.index)));
    out.push({ type: 'at', data: { qq: m[1], raw: m[0] } });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(seg.text(text.slice(last)));
  for (const att of Array.isArray(attachments) ? attachments : []) {
    const url = att?.url ?? att?.file_info ?? '';
    if (!url) continue;
    const ct = String(att?.content_type ?? '');
    if (ct.startsWith('image') || /\.(png|jpe?g|gif|webp)$/i.test(url)) out.push(seg.image(url));
    else out.push({ type: 'file', data: { file: url, url } });
  }
  return out;
}

/** OneBot 消息段 → 官方 `content`。图片等富媒体要单独上传，这里只出文本与 @。 */
export function toContent(segments) {
  let text = '';
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'text') text += String(s.data?.text ?? '');
    // @ 回官方要用 openid，不是虚拟号：发出去的 `<@虚拟号>` 官方不认。
    else if (s.type === 'at') text += ` <@${s.data?.openid ?? s.data?.qq ?? ''}> `;
    else if (s.type === 'image') text += ' [图片] ';
    else if (s.type === 'record') text += ' [语音] ';
  }
  return text.trim();
}

/**
 * 被动回复的计划：这一条能带 `msg_id`（被动回复），还是只能主动推送。
 *
 * 规则来自官方：同一 `msg_id` 最多回 4 次、5 分钟内有效。超了就不带 `msg_id` 直接发——
 * 官方允许主动发送（有频控），**这比"发不出去"好**，所以超窗不报错，只在回执里标
 * `degraded: 'active'`，并让模型知道（提示词里写明了这一点）。
 */
export function replyPlan(hit, now = Date.now()) {
  if (!hit) return { passive: false, times: 0, reason: 'no-msg-id' };
  if (now - hit.at > PASSIVE_WINDOW_MS) return { passive: false, times: hit.times, reason: 'window' };
  if (hit.times >= PASSIVE_MAX_TIMES) return { passive: false, times: hit.times, reason: 'times' };
  return { passive: true, times: hit.times + 1, reason: '' };
}

/** 官方回包 → OneBot action 回包。 */
const okResult = (data) => ({ status: 'ok', retcode: 0, message: '', data: data ?? null });
const failResult = (retcode, message) => ({ status: 'failed', retcode, message, data: null });

/**
 * 发送类参数的**本地**校验（不碰网络）：缺目标、内容为空。
 *
 * 单独抽出来是为了"在连不上之前就报对"——这两个错与网络无关，报成"未连接"
 * 会让调用方一直重试一个永远好不了的东西。
 */
function validateSend(action, params) {
  if (action === 'delete_msg') {
    return params?.message_id ? null : 'delete_msg 缺 message_id';
  }
  const isGroup = action === 'send_group_msg' || params?.message_type === 'group' || params?.group_id !== undefined;
  const toId = isGroup ? String(params?.group_id ?? '') : String(params?.user_id ?? '');
  if (!toId) return '发送缺目标（group_id / user_id）';
  const segments = Array.isArray(params?.message) ? params.message : [];
  // 图片/语音/视频/文件都算"有内容"——它们随后会被上传成媒体消息。
  // 只认 image 的话，纯语音会被判成"内容为空"，而这个错会让人以为是自己没写对。
  const hasContent = segments.some(
    (x) => (x?.type === 'text' && String(x.data?.text ?? '').trim()) || MEDIA_FILE_TYPES[x?.type],
  );
  return hasContent ? null : '发送内容为空';
}

/** 官方通道**有**实现的 action。不在里面的按"不认识"回 1404（不静默、不超时）。 */
const SUPPORTED_ACTIONS = new Set(['send_msg', 'send_group_msg', 'send_private_msg', 'get_login_info', 'delete_msg']);

/**
 * 官方通道适配器。
 *
 * 生命周期与 `UpstreamEndpoint` 一致：`start()` 之后自己维持连接（鉴权 → 取网关 → 订阅 →
 * 心跳），断线按 `reconnectInterval` 重连；`request()` 把 OneBot action 翻成官方 REST。
 */
export class OfficialUpstream {
  #appId;
  /** 机器人自己的 openid（`READY` 里的 `user.id`）：群里的 `<@!xxx>` 可能就是它。 */
  #selfOpenid = null;
  #appSecret;
  #sandbox;
  #apiBase;
  #token = null;
  #tokenExpireAt = 0;
  #ws = null;
  #url = null;
  #hbTimer = null;
  #reconnectTimer = null;
  #tokenTimer = null;
  #stopped = true;
  #seq = 0;
  #lastFrameAt = 0;
  /** 被动回复表：`msg_id` → `{at, times}`。 */
  #passive = new Map();
  #peers = null;
  #peersLoaded = false;
  #peerTimer = null;
  #status = {
    connected: false,
    url: null,
    connects: 0,
    events: 0,
    reconnects: 0,
    lastError: null,
    botId: null,
  };
  /**
   * @param {{appId:string, appSecret:string, sandbox?:boolean, reconnectInterval?:number,
   *          heartbeatTimeout?:number, requestTimeout?:number, log?:Function,
   *          onEvent?:(event:object)=>void, onStatus?:(status:object)=>void,
   *          onIdentity?:(info:{selfId:string, nickname?:string, source?:string})=>void,
   *          fetchImpl?:Function, wsFactory?:Function}} opts
   */
  constructor({
    appId,
    appSecret,
    sandbox = false,
    reconnectInterval = 5000,
    heartbeatTimeout = 120000,
    requestTimeout = 30000,
    mediaMaxBytes = 10 * 1024 * 1024,
    log,
    onEvent,
    onStatus,
    onIdentity,
    storage = null,
    fetchImpl,
    wsFactory,
  } = {}) {
    this.#appId = String(appId ?? '').trim();
    this.#appSecret = String(appSecret ?? '').trim();
    this.#sandbox = sandbox === true;
    this.#apiBase = this.#sandbox ? HOST_SANDBOX : HOST_PROD;
    this.log = log ?? (() => {});
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onIdentity = onIdentity;
    this.storage = storage;
    /**
     * 虚拟号 → openid。**必修**（真机 `m35049`）：`virtualId()` 是 sha256 派生的**单向**映射，
     * 发消息时手里只有虚拟号，不查这张表就只能把虚拟号当 openid 打过去——官方回
     * `400 请求的资源不存在(用户/群已注销)`，而 hub 会以为"对方注销了"。
     * 表从进来的消息里长出来；落盘是为了重启后还能给刚说过话的人回话。
     */
    this.#peers = { users: {}, groups: {} };
    this.#requestTimeout = requestTimeout;
    this.#heartbeatTimeout = heartbeatTimeout;
    this.#reconnectInterval = reconnectInterval;
    this.#mediaMaxBytes = mediaMaxBytes;
    // 测试可注入；生产走宿主自带的 fetch 与 ws 包。
    this.#fetch = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.#wsFactory = typeof wsFactory === 'function' ? wsFactory : null;
    this.#status.botId = this.#appId ? virtualId(this.#appId, 'bot', this.#appId) : null;
  }

  #requestTimeout;
  #heartbeatTimeout;
  #reconnectInterval;
  #mediaMaxBytes;
  #fetch;
  #wsFactory;

  get isConnected() {
    return this.#ws?.readyState === 1;
  }

  get status() {
    return { ...this.#status, sandbox: this.#sandbox, passive: this.#passive.size };
  }

  /** 官方通道没有"事件上推"这回事（它只收平台推来的），保留方法以免调用方报错。 */
  sendEvent() {
    return false;
  }

  start() {
    this.#stopped = false;
    this.#loadPeers();
    this.#boot().catch((err) => {
      this.#setStatus({ connected: false, lastError: String(err?.message ?? err) });
      this.#scheduleReconnect();
    });
  }

  stop() {
    this.#stopped = true;
    if (this.#peerTimer) {
      clearTimeout(this.#peerTimer);
      this.#peerTimer = null;
    }
    this.#persistPeers();
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#tokenTimer);
    clearInterval(this.#hbTimer);
    try {
      this.#ws?.close(1000, 'hub stopping');
    } catch {
      /* ignore */
    }
    this.#ws = null;
    this.#setStatus({ connected: false });
  }

  // ------------------------------------------------------------------ 鉴权

  async #post(url, body, headers = {}) {
    const doFetch = this.#fetch ?? globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#requestTimeout);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async #get(url, headers = {}) {
    const doFetch = this.#fetch ?? globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#requestTimeout);
    try {
      const res = await doFetch(url, { method: 'GET', headers, signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拿 access_token。官方给 7200 秒，这里提前 60 秒续。 */
  async #ensureToken(force = false) {
    if (!force && this.#token && Date.now() < this.#tokenExpireAt - 60_000) return this.#token;
    if (!this.#appId || !this.#appSecret) throw new Error('官方通道缺 appId / appSecret');
    const out = await this.#post(TOKEN_URL, { appId: this.#appId, clientSecret: this.#appSecret });
    const token = out.json?.access_token;
    if (!token) {
      throw new Error(`官方通道鉴权失败（HTTP ${out.status}）：${out.json?.message ?? out.text.slice(0, 200)}`);
    }
    this.#token = token;
    const expires = Number(out.json?.expires_in ?? 7200);
    this.#tokenExpireAt = Date.now() + Math.max(60, expires) * 1000;
    clearTimeout(this.#tokenTimer);
    this.#tokenTimer = setTimeout(() => {
      if (!this.#stopped) this.#ensureToken(true).catch(() => {});
    }, Math.max(60_000, (expires - 120) * 1000));
    this.#tokenTimer.unref?.();
    return token;
  }

  #authHeaders() {
    return { authorization: `QQBot ${this.#token ?? ''}` };
  }

  async #api(method, path, body) {
    await this.#ensureToken();
    const url = `${this.#apiBase}${path}`;
    const out = method === 'GET' ? await this.#get(url, this.#authHeaders()) : await this.#post(url, body, this.#authHeaders());
    if (out.status === 401) {
      // token 被提前吊销：重取一次再试。
      await this.#ensureToken(true);
      return method === 'GET'
        ? this.#get(url, this.#authHeaders())
        : this.#post(url, body, this.#authHeaders());
    }
    return out;
  }

  // ------------------------------------------------------------------ 连接

  async #boot() {
    await this.#ensureToken();
    const gw = await this.#api('GET', '/gateway');
    const url = gw.json?.url;
    if (!url) throw new Error(`官方通道取网关失败（HTTP ${gw.status}）：${gw.text.slice(0, 200)}`);
    this.#url = url;
    this.#status.url = url;
    this.#connect();
  }

  #connect() {
    if (!this.#wsFactory) {
      this.#setStatus({ connected: false, lastError: '未注入 ws 模块' });
      this.log('官方通道缺 ws 模块，无法连接（应由 index.js 注入）');
      return;
    }
    let ws;
    try {
      ws = this.#wsFactory(this.#url);
    } catch (err) {
      this.#setStatus({ connected: false, lastError: String(err?.message ?? err) });
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#lastFrameAt = Date.now();

    ws.on('open', () => {
      this.log(`官方通道已连接：${this.#url}`);
      this.#setStatus({ connected: true, connects: this.#status.connects + 1, lastError: null });
    });

    ws.on('message', (data) => {
      this.#lastFrameAt = Date.now();
      this.#onFrame(data);
    });

    ws.on('close', () => {
      clearInterval(this.#hbTimer);
      this.#setStatus({ connected: false });
      if (!this.#stopped) {
        this.#setStatus({ reconnects: this.#status.reconnects + 1 });
        this.#scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.#setStatus({ lastError: String(err?.message ?? err) });
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#stopped) return;
      this.#boot().catch((err) => {
        this.#setStatus({ lastError: String(err?.message ?? err) });
        this.#scheduleReconnect();
      });
    }, this.#reconnectInterval);
    this.#reconnectTimer.unref?.();
  }

  // ------------------------------------------------------------------ 协议

  #onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      this.log('官方通道收到非 JSON 帧，已忽略');
      return;
    }
    const op = Number(frame?.op);
    if (op === 10) {
      // Hello：给心跳间隔，同时是发 Identify 的时机。
      const interval = Math.max(1000, Number(frame?.d?.heartbeat_interval ?? 30000));
      this.#identify();
      clearInterval(this.#hbTimer);
      this.#hbTimer = setInterval(() => this.#heartbeat(), interval);
      this.#hbTimer.unref?.();
      return;
    }
    if (op === 11) return; // 心跳 ACK
    if (op === 7) {
      // 服务端要求重连。
      try {
        this.#ws?.close(4000, 'reconnect requested');
      } catch {
        /* ignore */
      }
      return;
    }
    if (op === 9) {
      // Invalid Session：token 或 intents 不对，重取 token 再连。
      this.log('官方通道会话无效，重取凭据后重连');
      this.#token = null;
      try {
        this.#ws?.close(4000, 'invalid session');
      } catch {
        /* ignore */
      }
      return;
    }
    if (op === 0) {
      this.#dispatch(String(frame?.t ?? ''), frame?.d ?? {});
    }
  }

  #heartbeat() {
    if (!this.isConnected) return;
    if (Date.now() - this.#lastFrameAt > this.#heartbeatTimeout) {
      this.log('官方通道心跳超时，主动重连');
      try {
        this.#ws?.close(4001, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
      return;
    }
    this.#send({ op: 1, d: this.#seq });
  }

  #identify() {
    this.#send({
      op: 2,
      d: {
        token: `QQBot ${this.#token ?? ''}`,
        intents: INTENT_GROUP_AND_C2C,
        shard: [0, 1],
        properties: {},
      },
    });
  }

  #send(payload) {
    if (!this.isConnected) return false;
    try {
      this.#ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- 对端映射
  /**
   * 虚拟号 → openid 的对应表。
   *
   * 为什么必须有：`virtualId()` 是 sha256 派生的**单向**号（这是刻意的——官方不给真号，
   * 派生的号在 hub 内部当身份用）。但发消息打的是 `/v2/users/{openid}/messages`，
   * 手里只有虚拟号时不查表就只能把虚拟号当 openid 发过去，官方回
   * `400 请求的资源不存在(用户/群已注销)`——真机 `m35049` 就是这么错的，而且这个错误
   * 读起来像"对方注销了"，会把人往完全错的方向带。
   *
   * 表从**进来的消息**里长出来：官方只允许给"来过消息的对象"发消息，所以"见过"本身就是
   * 能发的前提。落盘（`official/peers.json`）是为了重启后还能回刚说过话的人。
   */
  #loadPeers() {
    if (this.#peersLoaded) return;
    this.#peersLoaded = true;
    try {
      const raw = this.storage?.read?.(PEERS_FILE, null) ?? null;
      if (raw && typeof raw === 'object') {
        this.#peers = {
          users: { ...(raw.users ?? {}) },
          groups: { ...(raw.groups ?? {}) },
        };
      }
    } catch (err) {
      this.log(`读对端表失败（忽略，继续跑）：${String(err?.message ?? err)}`);
    }
  }

  #rememberPeer({ userId, openid, groupId, groupOpenid }) {
    this.#loadPeers();
    let dirty = false;
    if (userId && openid && this.#peers.users[userId] !== openid) {
      this.#peers.users[userId] = openid;
      dirty = true;
    }
    if (groupId && groupOpenid && this.#peers.groups[groupId] !== groupOpenid) {
      this.#peers.groups[groupId] = groupOpenid;
      dirty = true;
    }
    if (dirty) this.#schedulePersistPeers();
  }

  /**
   * 合并写：群里一分钟几十条消息，每条都 `flush()` 一次就是几十次写盘。
   * 映射变化很慢（同一个人/群反复出现），攒 5 秒写一次足够；`stop()` 里再兜一次。
   */
  #schedulePersistPeers() {
    if (!this.storage?.schedule) return;
    if (this.#peerTimer) return;
    this.#peerTimer = setTimeout(() => {
      this.#peerTimer = null;
      this.#persistPeers();
    }, 5000);
    this.#peerTimer.unref?.();
  }

  #persistPeers() {
    try {
      const snapshot = { users: { ...this.#peers.users }, groups: { ...this.#peers.groups } };
      this.storage?.schedule?.(PEERS_FILE, () => snapshot);
      this.storage?.flush?.();
    } catch (err) {
      this.log(`写对端表失败（忽略）：${String(err?.message ?? err)}`);
    }
  }

  /**
   * 虚拟号 → 真正的官方 id。
   *
   * 三条路，按顺序：本来就是 openid（非纯数字，比如 `onebot_call` 里直接传了 openid）→ 原样用；
   * 表里有 → 用表里的；都没有 → 返回 null，让调用方报一句能照着做的话。
   */
  #resolveTarget(isGroup, id) {
    const raw = String(id ?? '');
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return raw;
    this.#loadPeers();
    const hit = isGroup ? this.#peers.groups[raw] : this.#peers.users[raw];
    return hit ?? null;
  }

  // ------------------------------------------------------------------ 事件

  #dispatch(type, data) {
    this.#setStatus({ events: this.#status.events + 1 });
    if (type === 'READY') {
      const name = data?.user?.username ?? null;
      const selfId = virtualId(this.#appId, 'bot', this.#appId);
      // 记下机器人自己的 openid：群里 `@机器人` 的 `<@!xxx>` 就是它，见 `#toOneBot` 的 at 映射。
      this.#selfOpenid = data?.user?.id != null ? String(data.user.id) : null;
      this.log(`官方通道就绪（appId=${this.#appId}${name ? `，${name}` : ''}）`);
      this.onIdentity?.({ selfId, nickname: name ?? undefined, source: 'official-handshake' });
      return;
    }
    if (type !== 'GROUP_AT_MESSAGE_CREATE' && type !== 'C2C_MESSAGE_CREATE') return;
    const event = this.#toOneBot(type, data);
    if (!event) return;
    // 被动回复靠原始 msg_id，先记下来。
    if (event.message_id && data?.id) {
      this.#passive.set(String(data.id), { at: Date.now(), times: 0 });
      if (this.#passive.size > 2000) {
        const now = Date.now();
        for (const [id, hit] of this.#passive) {
          if (now - hit.at > PASSIVE_WINDOW_MS) this.#passive.delete(id);
        }
      }
    }
    this.onEvent?.(event);
  }

  /**
   * 官方事件 → OneBot v11 消息事件。
   *
   * `source` 里保留真身（openid / group_openid / 原始 id）：hub 内部用虚拟号，但要让
   * 下游或排障的人能反查回去——官方通道的"没有真号"是事实，不能装作没有。
   */
  #toOneBot(type, data) {
    const isGroup = type === 'GROUP_AT_MESSAGE_CREATE';
    const author = data?.author ?? {};
    const openid = String(author.user_openid ?? author.id ?? '');
    if (!openid) return null;
    const groupOpenid = String(data?.group_openid ?? '');
    const userId = virtualId(this.#appId, 'user', openid);
    const groupId = isGroup ? virtualId(this.#appId, 'group', groupOpenid) : undefined;
    // 把"见过"记下来：回复时只有虚拟号，靠这张表换回 openid（见 #resolveTarget）。
    this.#rememberPeer({ userId, openid, groupId, groupOpenid });
    let segments = toSegments(data?.content, data?.attachments);
    // `<@!openid>` 里的 openid → 虚拟号，hub 才认得出"在叫我"。
    segments = segments.map((s) => {
      if (s?.type !== 'at') return s;
      const raw = s.data?.qq ?? '';
      // 官方 @ 里写的是 openid（32 位 hex 这类字符串），hub 只认数字号；已经是数字就原样留着。
      // **@ 的是机器人自己时映射成 `self_id`**：hub 判"在叫我"拿 at 的 qq 跟 self_id 比
      // （`detectMention`）。按普通用户映射的话，群里 @ 它永远是"没叫我"——私聊不需要 @ 所以
      // 只表现为"群里收不到消息"（2026-10-29 真机）。
      const selfId = virtualId(this.#appId, 'bot', this.#appId);
      const mapped = /^\d+$/.test(raw)
        ? raw
        : this.#selfOpenid && raw === this.#selfOpenid
          ? selfId
          : virtualId(this.#appId, 'user', raw);
      return { type: 'at', data: { qq: mapped, openid: raw } };
    });
    // 群里的每一条都是 "有人 @ 了机器人"（事件名就叫 `GROUP_AT_MESSAGE_CREATE`），
    // 但官方**不会把那个 @ 放进 `content`**——内容只有用户自己打的字，甚至可能只有一个空格。
    // 不补这个 at 段的话，hub 的 `detectMention` 拿不到 mentions，群消息就永远不会唤醒 agent
    // （私聊不需要 @，所以只表现为"群里收不到消息"，2026-10-29 真机）。
    const selfId = virtualId(this.#appId, 'bot', this.#appId);
    if (isGroup && !segments.some((s) => s?.type === 'at' && String(s?.data?.qq ?? '') === selfId)) {
      segments = [{ type: 'at', data: { qq: selfId, openid: this.#selfOpenid ?? '' } }, ...segments];
    }
    const text = segments
      .map((s) => (s.type === 'text' ? s.data.text : ''))
      .join('')
      .trim();
    return {
      time: Math.floor(Number(data?.timestamp ?? Date.now() / 1000)) || Math.floor(Date.now() / 1000),
      self_id: virtualId(this.#appId, 'bot', this.#appId),
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      sub_type: 'normal',
      message_id: String(data?.id ?? `${userId}-${Date.now()}`),
      user_id: userId,
      ...(isGroup ? { group_id: groupId } : {}),
      sender: {
        user_id: userId,
        // 官方不给昵称（C2C/群 @ 的事件里 `author` 只有 openid）。这里留空而不是填虚拟号：
        // 填了 `displayActor` 会渲染成"3820113110(3820113110)"，看着像两个号。
        nickname: String(author.username ?? author.nickname ?? ''),
        card: '',
        // 官方通道不给角色；标 unknown，让权限逻辑走降级分支而不是误判。
        role: 'unknown',
      },
      message: segments,
      // `raw_message` 保留官方原文（含 `<@!openid>`）：OneBot 那边它是"原文"，
      // 换个渲染就丢信息了；要可读文本有 `message` 段，两边都不缺。
      raw_message: String(data?.content ?? text),
      source: {
        platform: 'qq-official',
        appId: this.#appId,
        openid,
        ...(isGroup ? { groupOpenid } : {}),
        rawId: String(data?.id ?? ''),
      },
    };
  }

  // ------------------------------------------------------------------ action

  /**
   * OneBot action → 官方 REST。
   *
   * 回包形状必须和 `UpstreamEndpoint` 一致（`{status, retcode, message, data}`），
   * 因为 `callUpstream` / `capability.note` / `gateDecision` 全都按那个形状判断。
   */
  async request(action, params = {}, _timeoutMs) {
    const name = String(action ?? '');
    // 「没有这个能力」和「现在连不上」必须分开报：前者是永久事实，报成后者会让所有
    // 调用方（含下游）以为等会儿就好，于是反复重试。
    if (UNSUPPORTED_ACTIONS.has(name)) return failResult(1404, `官方通道不支持 ${name}`);
    if (!SUPPORTED_ACTIONS.has(name)) return failResult(1404, `官方通道不认识的 action：${name}`);
    // 身份是本地就能答的：不需要令牌，也不该因为"还没连上"就说不知道我是谁。
    if (name === 'get_login_info') {
      return okResult({
        user_id: virtualId(this.#appId, 'bot', this.#appId),
        nickname: '官方机器人',
        platform: 'qq-official',
        app_id: this.#appId,
      });
    }
    // 参数错是**永久错**，先查出来：报成"未连接"会让调用方一直重试一个永远好不了的东西。
    const bad = validateSend(name, params);
    if (bad) return failResult(1400, bad);
    if (!this.isConnected && !this.#token) return failResult(1201, '官方通道未连接');
    try {
      if (name === 'send_msg' || name === 'send_group_msg' || name === 'send_private_msg') {
        return await this.#sendMessage(name, params);
      }
      return await this.#deleteMsg(params);
    } catch (err) {
      return failResult(1200, `官方通道调用 ${name} 失败：${String(err?.message ?? err)}`);
    }
  }

  async #deleteMsg(params) {
    const id = String(params?.message_id ?? '');
    if (!id) return failResult(1400, 'delete_msg 缺 message_id');
    const q = `?message_id=${encodeURIComponent(id)}`;
    const out = await this.#api('POST', `/v2/messages/${encodeURIComponent(id)}${q}`, {});
    if (out.status >= 400) return failResult(out.status, `撤回失败：${out.text.slice(0, 200)}`);
    return okResult(null);
  }

  /**
   * 发消息。两条路：带 `msg_id` 是被动回复（5 分钟 / 4 次），不带是主动推送。
   *
   * 回执里带 `degraded`：`'active'` 表示原计划被动、实际改成了主动。模型提示词里写了
   * 这件事，它才知道"这条可能顶到频控"。
   */
  async #sendMessage(action, params) {
    const isGroup = action === 'send_group_msg' || (action === 'send_msg' && params?.message_type === 'group') || params?.group_id !== undefined;
    const asked = isGroup ? String(params?.group_id ?? '') : String(params?.user_id ?? '');
    if (!asked) return failResult(1400, '发送缺目标（group_id / user_id）');
    // 虚拟号 → openid。换不出来就说清楚"为什么发不出去、怎么才能发出去"，
    // 不要打一个假号过去再把人引到"对方已注销"那条错路上（真机 `m35049`）。
    const toId = this.#resolveTarget(isGroup, asked);
    if (!toId) {
      const who = isGroup ? '群' : '这个人';
      return failResult(
        1404,
        `官方通道还不认识${who} ${asked}：只给"来过消息的对象"发消息。等${who}先发一条（或先用 onebot_call 传它真正的 openid），之后再回就行了。`,
      );
    }
    const segments = Array.isArray(params?.message) ? params.message : [];
    // 文本只取**非附件**的段：图片/语音会单独发成媒体消息，再把 `[图片]` 留在正文里
    // 就是重复一遍，而且"给你 [图片]"这种句子在真机上看起来像模型写错了。
    const content = toContent(segments.filter((s) => !MEDIA_FILE_TYPES[s?.type]));
    const mediaSegs = segments.filter((s) => MEDIA_FILE_TYPES[s?.type]);
    if (!content && !mediaSegs.length) return failResult(1400, '发送内容为空');

    // 附件先全部上传：上传失败就整条不发。否则会出现"文本已经发出去了、图没发出去"，
    // 而模型那边拿到的是成功回执——它不会知道图丢了。
    const media = [];
    for (let i = 0; i < mediaSegs.length; i += 1) {
      const up = await this.#uploadMedia(isGroup, toId, mediaSegs[i]);
      if (!up.ok) return up;
      media.push(up.fileInfo);
    }

    // `reply` 段带的是 hub 侧的 message_id，也就是官方的原始 id。
    const quoteSeg = segments.find((s) => s?.type === 'reply');
    const quoteId = String(quoteSeg?.data?.id ?? '');
    const hit = quoteId ? this.#passive.get(quoteId) : null;
    const plan = replyPlan(hit);

    // 官方不支持图文混排，只能拆成"文本一条 + 每个附件一条"。
    // 被动回复只挂在第一条上：同一个 msg_id 全生命周期只能用 4 次，附件吃掉额度的话，
    // 这一轮就再也回不了话了。
    const jobs = [];
    if (content) jobs.push({ content, msg_type: 0 });
    for (const fileInfo of media) jobs.push({ content: ' ', msg_type: 7, media: { file_info: fileInfo } });

    const path = isGroup
      ? `/v2/groups/${encodeURIComponent(toId)}/messages`
      : `/v2/users/${encodeURIComponent(toId)}/messages`;

    let firstId = '';
    let degradedReason = '';
    for (let i = 0; i < jobs.length; i += 1) {
      const body = { ...jobs[i] };
      const passive = i === 0 && plan.passive;
      if (passive) {
        body.msg_id = quoteId;
        body.msg_seq = plan.times;
        if (hit) hit.times = plan.times;
      }
      const out = await this.#api('POST', path, body);
      if (out.status < 400 && !out.json?.code) {
        if (i === 0) firstId = String(out.json?.id ?? '');
        continue;
      }
      const msg = out.json?.message ?? out.text.slice(0, 200);
      // 被动回复被拒（过期/次数用完）→ 就地降级成主动再试一次。
      if (passive && (out.status === 400 || /msg_id|expired|time/i.test(String(msg)))) {
        delete body.msg_id;
        delete body.msg_seq;
        const retry = await this.#api('POST', path, body);
        if (retry.status < 400 && !retry.json?.code) {
          this.log(`被动回复被拒（${msg}），已降级为主动消息`);
          degradedReason = String(msg);
          if (i === 0) firstId = String(retry.json?.id ?? '');
          continue;
        }
        return failResult(retry.status, `发送失败（被动与主动都试过了）：${retry.json?.message ?? retry.text.slice(0, 200)}`);
      }
      // 附件那几条要说清是第几条失败，否则"发送失败"看不出是文本还是图。
      return failResult(out.status, i === 0 ? `发送失败：${msg}` : `第 ${i + 1} 条（附件）发送失败：${msg}`);
    }

    return okResult({
      message_id: firstId,
      ...(plan.passive && !degradedReason ? {} : { degraded: 'active', reason: degradedReason || plan.reason }),
      ...(media.length ? { media: media.length } : {}),
      ...(jobs.length > 1 ? { parts: jobs.length } : {}),
    });
  }

  /**
   * 上传一个附件，拿回 `file_info`（随后用 `msg_type: 7` + `media.file_info` 发出去）。
   *
   * 两种来源：公网 URL 直接把地址交给官方去拉（省一次下载），本地文件/`base64://` 读成
   * base64 塞 `file_data`。上限按官方给的单文件上限卡，超了在**上传之前**就拒绝——
   * 传一半失败会留下一个孤儿媒体。
   */
  async #uploadMedia(isGroup, toId, seg) {
    const type = MEDIA_FILE_TYPES[seg?.type];
    const src = String(seg?.data?.url ?? seg?.data?.file ?? '');
    const body = { file_type: type, srv_send_msg: false };
    if (/^https?:\/\//i.test(src)) {
      body.url = src;
    } else if (/^base64:\/\//i.test(src)) {
      body.file_data = src.slice('base64://'.length);
    } else if (src) {
      let buf;
      try {
        buf = await readFile(src);
      } catch (err) {
        return failResult(1400, `附件读不到：${src}（${err?.code ?? err?.message ?? '未知错误'}）`);
      }
      if (buf.length > this.#mediaMaxBytes) {
        return failResult(1400, `附件太大：${(buf.length / 1024 / 1024).toFixed(1)}MB，官方通道上限 ${(this.#mediaMaxBytes / 1024 / 1024).toFixed(0)}MB`);
      }
      body.file_data = buf.toString('base64');
    } else {
      return failResult(1400, '附件没有地址（url / file 都空）');
    }

    const path = isGroup
      ? `/v2/groups/${encodeURIComponent(toId)}/files`
      : `/v2/users/${encodeURIComponent(toId)}/files`;
    const out = await this.#api('POST', path, body);
    if (out.status >= 400 || out.json?.code) {
      return failResult(out.status, `附件上传失败：${out.json?.message ?? out.text.slice(0, 200)}`);
    }
    const fileInfo = out.json?.file_info;
    if (!fileInfo) {
      return failResult(1400, `附件上传没有返回 file_info（收到的字段：${Object.keys(out.json ?? {}).join(' / ') || '空'}）`);
    }
    return { ok: true, fileInfo: String(fileInfo) };
  }

  #setStatus(patch) {
    this.#status = { ...this.#status, ...patch };
    this.onStatus?.(this.status);
  }
}

/**
 * `ws` 由 `index.js` 在启动时注入（和 `lib/link.js` 的 `useWs` 同一份模块）。
 *
 * 不在这里 `import ws` 的理由与那边一致：插件环境里 `ws` 是**宿主 profile 的依赖**，
 * 不是一个能静态解析的包名。拿不到就明确报错，不要静默降级成"连上了但收不到事件"。
 */
export function makeWsFactory(wsModule) {
  const WS = wsModule?.WebSocket ?? wsModule?.default ?? wsModule;
  if (typeof WS !== 'function') throw new Error('官方通道需要 ws 模块（由 index.js 注入）');
  return (url) => new WS(url);
}
