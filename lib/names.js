/**
 * 显示名：**实际 QQ 昵称 + QQ 号**，群名片只在**同一个群里**作为附注保留。
 *
 * 为什么这么定（`m15264` 用户拍板）：以前渲染用的是 `nickname || card || user_id`，
 * 但 OneBot 群消息里 `card`（群名片）是**每个群各一份**的——同一个人在 A 群叫"明哥"、B 群叫"老王"。
 * 于是模型上下文里的"这个人是谁"在不同群之间来回飘，`@` 出来的东西也对不上号。
 * QQ 昵称才是这个人**跨群唯一**的身份，所以拿它当主名；名片降级成同群附注（`小明(10002)·名片：明哥`），
 * 既不丢信息，又不会污染跨群记忆。
 *
 * 另一条硬约束：`@` 段里 @ 自己要用 agent 名而不是昵称（见 `segments.js`），
 * 否则模型给自己发消息会 `@小明(10002)`，跟它"我就是那个助手"的身份打架。
 */

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/**
 * 渲染一个发言者的显示名。
 *
 * @param {{nickname?:string, card?:string, user_id?:any, userId?:any}} actor OneBot 事件里的 `sender`
 * @param {string} [fallback] 连 user_id 都没有时的兜底（下游事件之类）
 * @returns {string}
 */
export function displayActor(actor = {}, fallback = '某人') {
  const id = str(actor?.user_id ?? actor?.userId);
  const nick = str(actor?.nickname);
  const card = str(actor?.card);
  if (!id) return nick || card || fallback;
  // 昵称与名片都没有时就只报 QQ 号——"用户12345(12345)" 又长又没多出任何信息。
  if (!nick && !card) return id;
  const base = `${nick || card}(${id})`;
  return card && card !== nick ? `${base}·名片：${card}` : base;
}
