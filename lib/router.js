/**
 * 路由与投递策略（§6.5 三种投递模式、§7 五种预设、§16.1 默认全量捕获）。
 *
 * 两条互相独立的决策：
 *  - **事件投递**：上游真实事件要不要下发给某条下游链路（`transparent` 默认）；
 *  - **动作裁决**：下游发来的 action 怎么处理（本地答 / 捕获 / 转发上游 / 广播 / 拒绝）。
 *
 * 设计要点：hub 是**管理者与总线**，默认目标是"用户指令畅通无阻"，
 * 因此事件默认 `transparent`（原帧零改写下发），只有显式收紧才降级。
 */

import { isGlobMatch } from './virtual-world.js';

/** 事件投递模式。 */
export const DELIVERY_MODES = {
  transparent: '原帧重签后照发（只动 self_id/message_id/dsh_trace，§18.3）',
  replay: '按目标链路的自己的账号重放（等价 transparent，保留语义别名）',
  synthesize: '合成事件（仅在下游明确要求时使用，§18.2 列出其系统性失效）',
};

/** 动作裁决模式。 */
export const ACTION_MODES = {
  local: 'hub 本地忠实回答（只读类）',
  capture: '只记录不执行（默认；观测下游用法而不干扰链路）',
  relay: '转发给上游实现端并等待真实结果',
  mirror: '广播给其它下游链路（不含来源链路）',
  both: '转发上游 **且** 广播给其它下游链路（两处都做）',
  drop: '静默丢弃，回成功空壳（连虚拟 message_id 都不给，下游拿不到任何句柄）',
  deny: '拒绝并回 retcode 1403（明确告诉下游"不给做"）',
};

/** 预设（§7）。v2 默认 = `relay`。 */
export const PRESETS = {
  /** 单一 bot：只把 hub 当一个普通 bot 用，不接管链路。 */
  solo: { event: { mode: 'transparent', broadcast: false }, action: { '*': 'capture' } },
  /**
   * 影子观察：全量捕获、绝不动作。
   * `readonly` 管的是**hub 自己**出不出手（不唤醒 agent、不代答聊天命令）；
   * 事件该广播还是广播——"观察"要看得见，"不动手"指 hub 的手。
   */
  shadow: { event: { mode: 'transparent', broadcast: true, readonly: true }, action: { '*': 'capture' } },
  /** 双向桥：上下游等权互转（`both` = 转上游 + 同时广播其它下游）。 */
  bridge: { event: { mode: 'transparent', broadcast: true }, action: { '*': 'both' } },
  /** 多下游织网：任意链路的消息广播到所有链路。 */
  fabric: { event: { mode: 'transparent', broadcast: true }, action: { 'send_*': 'mirror', '*': 'capture' } },
  /** 管理者+透传（v2 默认）：用户指令直达目标下游，DSH 全知并学习。 */
  relay: { event: { mode: 'transparent', broadcast: true }, action: { 'send_*': 'relay', 'get_*': 'local', '*': 'capture' } },
};

export const DEFAULT_PRESET = 'relay';

/**
 * 探针隔离档位（§19 探针隔离，M7-④）：agent 用 `onebot_invoke` 试探下游时，
 * 怎么让它的产物不跟真人消息搅在一起。
 *
 * 单一出处：`lib/index.js` 的默认值校验与 `lib/client.js` 的下拉选项都从这里对齐
 * （两边漂移会被 `test/client-manifest.mjs` 抓住）。
 */
export const PROBE_ISOLATIONS = ['time', 'link', 'off'];

/**
 * @param {object} config 插件配置
 * @returns {{preset:string, event:object, action:Record<string,string>, limits:object}}
 */
export function resolvePolicy(config = {}) {
  const presetName = PRESETS[config.preset] ? config.preset : DEFAULT_PRESET;
  const preset = PRESETS[presetName];
  const action = { ...preset.action };

  const rules = config.actionPolicy ?? {};
  for (const [pattern, mode] of Object.entries(rules)) {
    if (!ACTION_MODES[mode] && mode !== 'local') continue;
    // 更具体的模式（无通配符）覆盖通配符规则
    if (action[pattern] === undefined || !pattern.includes('*')) action[pattern] = mode;
  }

  return {
    preset: presetName,
    event: {
      mode: config.deliveryMode ?? preset.event.mode,
      broadcast: config.broadcast ?? preset.event.broadcast,
      kinds: config.deliverKinds ?? ['group_message', 'private_message', 'notice', 'request'],
      /**
       * 只读：hub 自己绝不动作（不唤醒 agent、不代答聊天命令）。两个来源取**或**：
       * 预设自带的（`shadow`），或配置里显式打开（任何预设都能"全量观察"）。
       *
       * 刻意**只能打开、不能用 `false` 关掉预设的那个**：`shadow` 的定义就是只读，
       * 让配置把它关掉会造出"影子观察却能说话"的自相矛盾状态。想不只看，换预设
       * （`fabric`/`bridge`/`relay`）。
       */
      readonly: config.readonly === true || Boolean(preset.event.readonly),
    },
    action,
    limits: {
      maxEventsPerSecond: config.maxEventsPerSecond ?? 0,
      timelinePerSession: config.timelinePerSession ?? 1000,
      timelineGlobal: config.timelineGlobal ?? 10000,
      captureLogSize: config.captureLogSize ?? 2000,
    },
  };
}

/** 某条事件要不要下发给某条下游链路。 */
export function decideEvent(policy, { linkId, kind, selfId, targetSelfId, probeOnly }) {
  if (!policy.event.kinds.includes(kind)) return { deliver: false, reason: `kind:${kind}` };
  /**
   * 探针专用链路（§19 探针隔离 `probe.isolation: 'link'`）：**只收 hub 的注入**，
   * 上游真人消息一条都不投。排在 kind 判定之后、广播判定之前——它比"广播不广播"更强：
   * 就算 `broadcast: true`，这条链路也不该看见群友的话。
   */
  if (probeOnly === true) return { deliver: false, reason: 'probe-only-link' };
  if (!policy.event.broadcast && targetSelfId !== undefined && selfId !== undefined && String(selfId) !== String(targetSelfId)) {
    return { deliver: false, reason: 'not:broadcast' };
  }
  return { deliver: true, mode: policy.event.mode };
}

/** 某个 action 对某条下游链路的裁决模式。 */
export function decideAction(policy, { action }) {
  if (policy.action[action] !== undefined) return policy.action[action];
  // 无通配符的显式规则优先
  const exact = Object.keys(policy.action).find((p) => !p.includes('*') && p === action);
  if (exact) return policy.action[exact];
  const wildcard = Object.keys(policy.action).filter((p) => p.includes('*') && isGlobMatch(p, action));
  if (wildcard.length) {
    wildcard.sort((a, b) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length);
    return policy.action[wildcard[0]];
  }
  return 'capture';
}

export function describePolicy(policy) {
  return {
    preset: policy.preset,
    readonly: policy.event.readonly === true,
    event: { ...policy.event },
    action: { ...policy.action },
  };
}
