/**
 * 下游实现端（VirtualWorld）：hub 在每条下游链路面前**扮演"上游 QQ 实现"**。
 *
 * §19.2/§19.3 实测得出必须真答的最小集与硬约束：
 *  - `send_msg`：下游 `bot.send()` 只会调它（不会调 send_group_msg/send_private_msg）；
 *  - `get_msg`：下游 `_check_reply` 会主动调它，答不上来 reply 就解析失败；
 *  - `get_login_info` / `get_group_member_list` / `get_status`：下游插件与适配器常用；
 *  - `echo` 必须原样回填（实测是字符串 "1"…"11"）；
 *  - 事件里的 `self_id` 必须是**该链路自己的账号**，at/昵称匹配才成立。
 *
 * 本类只负责"实现端语义"：查库、组装合规响应、决定某个 action 该不该放行。
 * 真正的路由（发到上游还是别的下游）由 Hub 通过 `onOutbound` 回调裁决。
 */

import { makeError, makeResult, messageToText, renderCq } from './protocol.js';

/** 本地就能忠实回答的只读 action（不产生对外副作用）。 */
export const LOCAL_ACTIONS = new Set([
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_msg',
  'get_group_list',
  'get_group_info',
  'get_group_member_list',
  'get_group_member_info',
  'get_friend_list',
  'get_stranger_info',
  'can_send_image',
  'can_send_record',
  'get_cookies',
  'get_csrf_token',
]);

/** 会产生对外副作用的 action（默认按策略走，hub 侧默认 capture）。 */
export const SIDE_EFFECT_ACTIONS = new Set([
  'send_msg',
  'send_private_msg',
  'send_group_msg',
  'delete_msg',
  'set_group_ban',
  'set_group_kick',
  'set_group_leave',
  'set_group_card',
  'set_group_name',
  'set_friend_add_request',
  'set_group_add_request',
  'set_group_special_title',
  'send_group_forward_msg',
  'send_private_forward_msg',
  'set_restart',
]);

function isGlobMatch(pattern, value) {
  if (pattern === '*' || pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

function normalizeSend(params, action) {
  const message = params.message ?? params.messages ?? '';
  if (action === 'send_group_msg' || params.group_id !== undefined) {
    return { message_type: 'group', group_id: params.group_id, user_id: params.user_id, message };
  }
  if (action === 'send_private_msg' || params.user_id !== undefined) {
    return { message_type: 'private', user_id: params.user_id, group_id: params.group_id, message };
  }
  if (params.message_type === 'group') {
    return { message_type: 'group', group_id: params.group_id, user_id: params.user_id, message };
  }
  return { message_type: params.message_type ?? 'private', user_id: params.user_id, group_id: params.group_id, message };
}

export class VirtualWorld {
  #messages = new Map();
  #members = new Map();
  #memberLists = new Map();
  #groups = new Map();
  #selfId;
  #linkId;
  #nickname;
  #sendSeq = 0;
  #onOutbound;
  #log;
  #log_actions = [];

  /**
   * @param {{linkId:string, selfId:string|number, nickname?:string,
   *          onOutbound?:(out:{action:string, send:object, raw:object, world:VirtualWorld}) => Promise<object>|object,
   *          log?:(...a:any[])=>void}} opts
   */
  constructor({ linkId, selfId, nickname, onOutbound, log } = {}) {
    this.#linkId = linkId;
    this.#selfId = selfId;
    this.#nickname = nickname ?? `hub-${selfId ?? linkId}`;
    this.#onOutbound = onOutbound;
    this.#log = log ?? (() => {});
  }

  get linkId() {
    return this.#linkId;
  }

  get selfId() {
    return this.#selfId;
  }

  get nickname() {
    return this.#nickname;
  }

  set nickname(value) {
    if (value) this.#nickname = String(value);
  }

  /** 最近若干次 action 调用（供 `onebot_capture` / 排障查看）。 */
  get recentActions() {
    return this.#log_actions.slice(-64);
  }

  /** 登记一条**已下发给下游**的事件，供 `get_msg` 查回。 */
  rememberEvent(event, { virtualId } = {}) {
    if (event?.post_type !== 'message') return;
    const record = {
      message_id: event.message_id,
      real_id: event.message_id,
      sender: {
        user_id: event.user_id,
        nickname: event.sender?.nickname ?? String(event.user_id ?? ''),
        sex: event.sender?.sex ?? 'unknown',
        age: event.sender?.age ?? 0,
        card: event.sender?.card ?? '',
        role: event.sender?.role ?? 'member',
      },
      time: event.time ?? Math.floor(Date.now() / 1000),
      message_type: event.message_type,
      message: event.message,
      raw_message: event.raw_message ?? renderCq(Array.isArray(event.message) ? event.message : []),
      ...(event.group_id !== undefined ? { group_id: event.group_id } : {}),
    };
    if (event.message_id !== undefined && event.message_id !== null) this.#messages.set(String(event.message_id), record);
    if (virtualId !== undefined && virtualId !== null) this.#messages.set(String(virtualId), record);
    return record;
  }

  rememberMembers(groupId, list) {
    const key = String(groupId);
    this.#memberLists.set(key, Array.isArray(list) ? list : []);
    for (const m of list ?? []) this.#members.set(`${key}|${m.user_id}`, m);
  }

  rememberGroup(group) {
    if (group?.group_id !== undefined) this.#groups.set(String(group.group_id), group);
  }

  hasMessage(id) {
    return this.#messages.has(String(id));
  }

  /** 取回记住的那条消息（引用渲染要用它的原文）。 */
  getMessage(id) {
    return this.#messages.get(String(id)) ?? null;
  }

  /**
   * 处理一帧下游 action。
   * @param {{action:string, params?:object, echo?:any}} frame
   * @returns {Promise<object>} 合规信封
   */
  async handleAction(frame) {
    const action = String(frame?.action ?? '');
    const params = frame?.params ?? {};
    const echo = frame?.echo ?? null;
    this.#log_actions.push({ ts: Date.now(), action, params });
    if (this.#log_actions.length > 128) this.#log_actions.shift();

    try {
      const out = await this.#dispatch(action, params, echo);
      this.#log(`[${this.#linkId}] action ${action} -> retcode ${out.retcode}`);
      return out;
    } catch (err) {
      this.#log(`[${this.#linkId}] action ${action} 抛错: ${err?.stack ?? err}`);
      return makeError(echo, `hub 内部错误: ${err?.message ?? err}`, 1200);
    }
  }

  async #dispatch(action, params, echo) {
    switch (action) {
      case 'send_msg':
      case 'send_private_msg':
      case 'send_group_msg':
      case 'send_group_forward_msg':
      case 'send_private_forward_msg': {
        const send = normalizeSend(params, action);
        if (!this.#onOutbound) return makeError(echo, 'hub 未装配出站路由', 1201);
        const result = await this.#onOutbound({ action, send, raw: params, world: this });
        if (result && result.__error) return makeError(echo, result.__error, result.retcode ?? 1202);
        // 策略判 `drop` 时出站路由回这个哨兵：回"成功空壳"，**不补虚拟 message_id**——
        // 给下游一个它永远查不到的句柄，比什么都不给更糟。
        if (result?.__silent) return makeResult(echo, {});
        this.#sendSeq += 1;
        // `extra` 是策略层想随应答一起交还给下游的附加信息（如 `both` 的镜像条数）。
        // 只有显式放在 `extra` 下的字段会透出去——出站路由的内部标记（`captured` 等）
        // 不该漏给下游，否则下游会以为 OneBot 有这些字段。
        return makeResult(echo, { ...(result?.extra ?? {}), message_id: result?.message_id ?? this.#virtualMessageId() });
      }

      case 'get_msg': {
        const record = this.#messages.get(String(params.message_id));
        if (!record) return makeError(echo, '消息不存在或已被 hub 释放', 1404);
        return makeResult(echo, record);
      }

      case 'get_login_info':
        return makeResult(echo, { user_id: this.#asNumberish(this.#selfId), nickname: this.#nickname });

      case 'get_status':
        return makeResult(echo, { online: true, good: true, stat: { link: this.#linkId, role: 'hub-implementation' } });

      case 'get_version_info':
        return makeResult(echo, {
          app_name: 'dsh-onebot-hub',
          app_version: '0.1.0',
          protocol_version: 11,
        });

      case 'get_group_member_list': {
        const list = this.#memberLists.get(String(params.group_id));
        if (!list) return makeError(echo, 'hub 尚未观测到该群成员列表', 1404);
        return makeResult(echo, list);
      }

      case 'get_group_member_info': {
        const m = this.#members.get(`${params.group_id}|${params.user_id}`);
        if (!m) return makeError(echo, 'hub 尚未观测到该成员', 1404);
        return makeResult(echo, m);
      }

      case 'get_group_list':
        return makeResult(echo, [...this.#groups.values()]);

      case 'get_group_info': {
        const g = this.#groups.get(String(params.group_id));
        if (!g) return makeError(echo, 'hub 尚未观测到该群', 1404);
        return makeResult(echo, g);
      }

      case 'get_friend_list':
        return makeResult(echo, []);

      case 'get_stranger_info':
        return makeResult(echo, { user_id: this.#asNumberish(params.user_id), nickname: '', sex: 'unknown', age: 0 });

      case 'can_send_image':
      case 'can_send_record':
        return makeResult(echo, { yes: true });

      default:
        return makeError(echo, `hub 未实现该 action: ${action}`, 1404);
    }
  }

  /** 虚拟 message_id：下游只会拿它来 reply，hub 侧建立映射即可。 */
  #virtualMessageId() {
    return `virtual:${this.#linkId}:${++this.#sendSeq}:${Date.now()}`;
  }

  #asNumberish(value) {
    if (value === undefined || value === null) return value;
    const n = Number(value);
    return Number.isFinite(n) && String(n) === String(value) ? n : value;
  }
}

/** 某个 action 是否属于"hub 本地可忠实回答"的只读集合。 */
export function isLocalAction(action, { allow = [], deny = [] } = {}) {
  if (deny.some((p) => isGlobMatch(p, action))) return false;
  if (allow.some((p) => isGlobMatch(p, action))) return true;
  return LOCAL_ACTIONS.has(action);
}

export { isGlobMatch, normalizeSend };
