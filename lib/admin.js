/**
 * 管理动作面（M13-②，§22.6）：把"群管理 / 请求处理"这类**有副作用**的操作做成
 * 结构化、可预演的接口。
 *
 * 分工（重要，别在这里加第二道闸门）：
 *  - 这里只做两件事：**人话 op → OneBot action + 参数**的映射，以及**预演**（dry run）。
 *  - 权限判断只有一处，就是 `hub.callAction` 的分级闸门（`capability.writeAllow` /
 *    `dangerAllow` / `exposeSensitive`）。工具把它的结论提前告诉模型，而不是自己再判一遍
 *    （两处判断必然漂移，最后没人知道哪处是权威）。
 *  - 预演阶段**一个字节都不发**：模型先拿到"将要发生什么、现在会不会被拦"，再用
 *    `confirm: true` 真发。踢人/禁言/全体禁言/退群这类不可逆动作即便已放行也要过一次确认——
 *    "拟人化"不等于"乱动手"。
 *
 * 动作清单只收 OneBot v11 **标准** action（会说话的实现端都该有）；实现端扩展不放这里，
 * 需要就用 `onebot_call` 直接问，并靠 `CapabilityRegistry` 的实测结论说话。
 */

/**
 * @typedef {object} AdminOpSpec
 * @property {string} action   对应的 OneBot action
 * @property {string[]} fields  从入参里收集的字段（其余字段一律忽略，免得把幻觉参数透传出去）
 * @property {string[]} required 必需字段
 * @property {(p: object) => (string|null)} [check] 取值校验，返回错误说明或 null
 * @property {(p: object) => string} describe 给人看的一句话（预演就是靠它）
 * @property {boolean} [irreversible] 是否不可撤销
 */

/** @type {Record<string, AdminOpSpec>} */
export const ADMIN_OPS = {
  mute: {
    action: 'set_group_ban',
    fields: ['group_id', 'user_id', 'duration'],
    required: ['group_id', 'user_id', 'duration'],
    check: (p) => (Number.isInteger(Number(p.duration)) && Number(p.duration) >= 0 ? null : 'duration 必须是非负整数（秒），0 表示解除禁言'),
    describe: (p) =>
      `在群 ${p.group_id} 禁言 ${p.user_id} ${p.duration} 秒${Number(p.duration) === 0 ? '（= 解除禁言）' : ''}`,
  },
  kick: {
    action: 'set_group_kick',
    fields: ['group_id', 'user_id', 'reject_add_request'],
    required: ['group_id', 'user_id'],
    describe: (p) => `把 ${p.user_id} 移出群 ${p.group_id}${p.reject_add_request === true ? '，并拒绝其再次加群' : ''}`,
    irreversible: true,
  },
  ban_all: {
    action: 'set_group_whole_ban',
    fields: ['group_id', 'enable'],
    required: ['group_id', 'enable'],
    check: (p) => (typeof p.enable === 'boolean' ? null : 'enable 必须是布尔值（true = 全员禁言，false = 解除）'),
    describe: (p) => `${p.enable === true ? '开启' : '解除'}群 ${p.group_id} 的全员禁言`,
  },
  set_admin: {
    action: 'set_group_admin',
    fields: ['group_id', 'user_id', 'enable'],
    required: ['group_id', 'user_id', 'enable'],
    check: (p) => (typeof p.enable === 'boolean' ? null : 'enable 必须是布尔值（true = 设为管理员，false = 取消）'),
    describe: (p) => `${p.enable === true ? `把 ${p.user_id} 设为` : `取消 ${p.user_id} 的`}群 ${p.group_id} 管理员`,
  },
  leave_group: {
    action: 'set_group_leave',
    fields: ['group_id', 'is_dismiss'],
    required: ['group_id'],
    describe: (p) => `让机器人退出群 ${p.group_id}${p.is_dismiss === true ? '（顺带解散该群，仅群主可用）' : ''}`,
    irreversible: true,
  },
  set_card: {
    action: 'set_group_card',
    fields: ['group_id', 'user_id', 'card'],
    required: ['group_id', 'user_id', 'card'],
    describe: (p) => `把群 ${p.group_id} 里 ${p.user_id} 的群名片改成「${p.card}」`,
  },
  rename_group: {
    action: 'set_group_name',
    fields: ['group_id', 'group_name'],
    required: ['group_id', 'group_name'],
    describe: (p) => `把群 ${p.group_id} 的群名改成「${p.group_name}」`,
  },
  recall: {
    action: 'delete_msg',
    fields: ['message_id'],
    required: ['message_id'],
    describe: (p) => `撤回消息 ${p.message_id}`,
    irreversible: true,
  },
  like: {
    action: 'send_like',
    fields: ['user_id', 'times'],
    required: ['user_id'],
    describe: (p) => `给 ${p.user_id} 点赞${p.times ? ` ${p.times} 次` : ''}`,
  },
  set_title: {
    action: 'set_group_special_title',
    fields: ['group_id', 'user_id', 'special_title'],
    required: ['group_id', 'user_id'],
    describe: (p) => `给群 ${p.group_id} 的 ${p.user_id} 设置专属头衔${p.special_title ? `「${p.special_title}」` : ''}`,
  },
  handle_friend_request: {
    action: 'set_friend_add_request',
    fields: ['flag', 'approve', 'remark'],
    required: ['flag', 'approve'],
    check: (p) => (typeof p.approve === 'boolean' ? null : 'approve 必须是布尔值（true = 同意，false = 拒绝）'),
    describe: (p) => `${p.approve === true ? '同意' : '拒绝'}好友请求（flag=${p.flag}）${p.remark ? `，备注「${p.remark}」` : ''}`,
  },
  handle_group_request: {
    action: 'set_group_add_request',
    fields: ['flag', 'sub_type', 'approve', 'reason'],
    required: ['flag', 'sub_type', 'approve'],
    check: (p) => (typeof p.approve === 'boolean' ? null : 'approve 必须是布尔值（true = 同意，false = 拒绝）'),
    describe: (p) =>
      `${p.approve === true ? '同意' : '拒绝'}${p.sub_type === 'invite' ? '入群邀请' : '加群申请'}（flag=${p.flag}）${p.reason ? `，理由「${p.reason}」` : ''}`,
  },
};

/** 可用 op 名（工具描述与报错都用它，避免两处手抄漂移）。 */
export const ADMIN_OP_NAMES = Object.keys(ADMIN_OPS);

/**
 * 把"人话 op + 参数"翻译成**将要下发的** OneBot 调用，不做任何网络动作。
 *
 * 返回 `{ ok: true, op, action, params, describe, irreversible }` 或
 * `{ ok: false, error, op?, action?, missing? }`。错误一律写成模型能照着改的一句话。
 */
export function planAdminOp(op, raw = {}) {
  const key = String(op ?? '').trim();
  const spec = ADMIN_OPS[key];
  if (!spec) {
    return { ok: false, error: `未知管理动作 ${key || '(空)'}；可用：${ADMIN_OP_NAMES.join('、')}` };
  }
  const params = {};
  for (const field of spec.fields) {
    const value = raw?.[field];
    if (value !== undefined && value !== null && value !== '') params[field] = value;
  }
  const missing = spec.required.filter((field) => params[field] === undefined);
  if (missing.length > 0) {
    return { ok: false, op: key, action: spec.action, missing, error: `${key} 缺少必需参数：${missing.join('、')}` };
  }
  const bad = spec.check?.(params) ?? null;
  if (bad) return { ok: false, op: key, action: spec.action, error: bad };
  return {
    ok: true,
    op: key,
    action: spec.action,
    params,
    describe: spec.describe(params),
    irreversible: spec.irreversible === true,
  };
}
