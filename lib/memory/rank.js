/**
 * 人物 facts 的排序：哪几条该顶到前面给人看。
 *
 * 为什么单独一个文件：这里全是纯函数（输入数组 → 输出数组），不碰存储、不碰时间，
 * 所以能直接写断言；塞进 `assembler.js` 就得连带造一堆档案对象才能测。
 *
 * 全部是**字面**信号——没有向量、没有模型调用。三层权重递减：
 *
 *  1. 事实挂着的话题，正好是当前活跃话题             +8 / 个
 *  2. 事实正文与"当前话题 + 这批新消息"的 2-gram 重叠   +1 / 个（最多 3）
 *  3. 打平时比 `at`（最近提到的在前）
 *
 * 为什么只有两层分：原方案还有一层"他正参与当前话题 +4"，实现时发现它是**冗余的**——
 * 排序是**按人**做的（每张卡只排一个人的事实），那条分对同一个人的所有事实都一样加，
 * 等于常量，区分不出任何东西。删掉了，只留"这条事实本身属不属于当前这件事"。
 */

/** 一条事实最多挂几个话题（写入侧裁剪，读回来也按这个兜底）。 */
export const MAX_TOPICS_PER_FACT = 3;

/**
 * 取中文的 2-gram 集合。
 *
 * 中文没有空格分词，用 2-gram 是最省事的近似：不需要分词器、无依赖、对短文本灵敏。
 * 标点与空白先剔掉，否则「显卡，电源」会被切成「卡，」「，电」这种噪声。
 *
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function bigrams(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 两个字符串的 2-gram 重叠个数（交集大小）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function overlapCount(a, b) {
  const left = typeof a === 'string' ? bigrams(a) : a;
  const right = typeof b === 'string' ? bigrams(b) : b;
  if (!left?.size || !right?.size) return 0;
  let n = 0;
  const [small, big] = left.size <= right.size ? [left, right] : [right, left];
  for (const gram of small) if (big.has(gram)) n += 1;
  return n;
}

/**
 * 给一条事实打分。
 *
 * 只有三层，因为中间那层是**冗余的**（自查当场发现并删掉）：原本想“他正参与当前话题 → 加分”，
 * 但排序是**按人**做的（每张卡只排一个人的事实），那条分对同一个人的所有事实都一样加，
 * 等于常量——干脆不要。真正能区分的是“这条事实本身是不是属于当前这件事”。
 *
 * - 话题命中：`fact.topics` 与当前活跃话题的 id 相交，每个 +8；
 * - 字面重叠：与 haystack 的 2-gram 交集数，封顶 +3（兜底老数据：没有 topics 字段时也能分个先后）；
 * - 时间：不打分，只在前两层相同时用来定序。
 *
 * @returns {{ hitTopics: number, lexical: number, score: number }}
 */
export function scoreFact(fact, { topics = [], haystack = '' } = {}) {
  const activeIds = new Set(topics.map((t) => String(t?.id ?? '')).filter(Boolean));
  const own = (Array.isArray(fact?.topics) ? fact.topics : []).map(String).filter(Boolean);
  const hitTopics = own.filter((id) => activeIds.has(id)).length;
  const lexical = haystack ? Math.min(3, overlapCount(fact?.text ?? '', haystack)) : 0;
  return { hitTopics, lexical, score: hitTopics * 8 + lexical };
}

/**
 * 排序（不改原数组）。没有话题、没有 haystack 时退化成"按 `at` 倒序"。
 *
 * @param {Array<object>} facts
 * @param {{ topics?: Array<object>, actorId?: string, haystack?: string }} [opts]
 * @returns {Array<object>}
 */
export function rankFacts(facts, { topics = [], actorId = '', haystack = '' } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return [];
  const ctx = { topics, actorId, haystack };
  return list
    .map((fact, index) => ({
      fact,
      index,
      at: Number(fact?.at ?? 0) || 0,
      ...scoreFact(fact, ctx),
    }))
    .sort((a, b) => b.score - a.score || b.at - a.at || a.index - b.index)
    .map((row) => row.fact);
}

/**
 * 把一批话题 id 裁到上限（写入侧用：一次 settle 里写了五个话题，早期的不该再跟着新事实走）。
 * @param {Array<unknown>} ids
 * @returns {string[]}
 */
export function trimTopics(ids) {
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw ?? '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(-MAX_TOPICS_PER_FACT);
}
