/**
 * 记忆衰减与"变弱"判定（§24.6 / §24.7，M18 的底座，M17 也要用）。
 *
 * 这里只有一个函数，但它决定了三件事：
 *  - 检索默认会不会把一条旧记忆翻出来（弱记忆默认不返回）；
 *  - 主动回忆要不要提这件事（弱到一定程度就不提）；
 *  - **要不要把数据删掉——永远不要**。遗忘是检索排序问题，不是数据删除问题：
 *    L1 时间线的 jsonl 一个字都不动，`onebot_timeline` 与 `includeWeak` 都还查得到。
 *
 * 强度公式（方案 §24.6）：
 *   strength = w1·提及次数(归一) + w2·最近度(半衰期 14 天) + w3·重要度(0-1) − w4·被纠正次数
 * 权重与半衰期都可以覆盖，但默认值就是这里这几个数字——它们是**代码的**，不是模型声明的：
 * 让模型自己说"这条很重要"，等于让它给自己发免遗忘金牌。
 */

export const HALF_LIFE_DAYS = 14;
export const WEAK_THRESHOLD = 0.2;

export const DEFAULT_WEIGHTS = { mention: 0.4, recency: 0.4, importance: 0.2, corrected: 0.3 };

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 一条记忆此刻还"有多强"（0-1）。 */
export function decayStrength(entry, { now = Date.now(), weights = DEFAULT_WEIGHTS, halfLifeDays = HALF_LIFE_DAYS } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const mentions = Math.min(Number(entry?.mentions ?? 1) / 5, 1); // 提过 5 次就到顶，再多不加权
  const ageDays = Math.max(0, (now - Number(entry?.ts ?? now)) / 86400000);
  const recency = Math.pow(0.5, ageDays / Math.max(0.5, Number(halfLifeDays) || HALF_LIFE_DAYS));
  const importance = clamp01(Number(entry?.importance ?? (entry?.kind === 'identity' ? 1 : 0.5)));
  const corrected = Math.min(Number(entry?.corrections ?? 0), 3) / 3;
  return clamp01(w.mention * mentions + w.recency * recency + w.importance * importance - w.corrected * corrected);
}

export function isWeak(entry, opts = {}) {
  return decayStrength(entry, opts) < (opts.threshold ?? WEAK_THRESHOLD);
}

/**
 * 从记忆条目里挑出"已经被忘得差不多了"的那些消息 id（`refs.message_id`）。
 * 检索层拿它当**默认隐藏名单**：不返回，但绝不删。
 */
export function weakMessageIds(entries, opts = {}) {
  const out = new Set();
  for (const e of entries ?? []) {
    if (!isWeak(e, opts)) continue;
    const id = e?.refs?.message_id;
    if (id !== undefined && id !== null && id !== '') out.add(String(id));
  }
  return out;
}
