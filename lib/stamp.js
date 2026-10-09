/**
 * 时间戳渲染（`m34049` 用户要求："所有消息都加上日期和时间"）。
 *
 * 之前消息行只有 `HH:MM`。群聊里最常见的翻车就是**跨天**："08:12 你还在吗"可能是昨天
 * 早上，模型却按刚刚发生来接话，于是接出一条不存在的时间线；更糟的是**开局快照**里
 * 从磁盘读回的旧事（"这些不是刚刚"），只有时分根本看不出隔了几天。现在每一条消息行都带日期。
 *
 * 格式分工：
 *  - `mdhm`（行内用）：`MM-DD HH:MM`。每批消息的**头**已经锚定了绝对日期
 *    （`【新消息 N 条】…｜现在 YYYY-MM-DD HH:MM`），行里再写一遍年份只是每条多 5 个字符。
 *  - `full`（头/锚点用）：`YYYY-MM-DD HH:MM`。
 *
 * 没有时间戳时一律给 `--`（不再是 `--:--`）：占位的意思没变，但让它一眼就不像时间。
 */

const pad = (n) => String(n).padStart(2, '0');

const dateOf = (ts) => {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `MM-DD HH:MM`（消息行、窗口行、会话卡行）。 */
export const mdhm = (ts) => {
  const d = dateOf(ts);
  if (!d) return '--';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `YYYY-MM-DD HH:MM`（批头、会话标题这类需要绝对锚点的地方）。 */
export const full = (ts) => {
  const d = dateOf(ts);
  if (!d) return '--';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};