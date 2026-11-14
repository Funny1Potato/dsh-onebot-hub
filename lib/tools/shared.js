/**
 * 工具层的小共用件：文本输出形状、生图限额、客户端模块自检。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），逻辑逐字未改。
 */

export function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export const TEXT_OUTPUT = { schema: { type: 'string' }, render: textRender };

/**
 * 回执里的「有什么被丢掉了」统一记在这里（`m77611`）——字段名就叫 `notes`，是一个字符串数组。
 *
 * 起因：一次真机回合里，模型看见的是"已经发出 4 条"，而另外 3 条**被合并**进最后一条；
 * 用户看见的却是一段断在半截的话。丢弃、忽略、降级、截断、降级换路……这些"我没照你说的做"，
 * 从前散落在 `note`（单数字符串）、`hidden`、`skipped`、`degraded` 十几个字段里，
 * 模型要不要读全凭猜。现在统一成一处，并且**只要与它有关，就必须写**。
 *
 * `note` 与 `notes` 的区别不是"新旧"，是**谁在说**：
 *   · `note` —— 给你办事的那个人在回答（"档案里没有这个名字"）；
 *   · `notes` —— 办事的人在中途**没能照办**的地方（"3 张图超出上限没发"）。
 * 前者读不读都不影响判断，后者漏了模型就会以为事情全做完了。
 *
 * @param {{notes?: string[]}} body 回执对象（就地补一个空数组，调用方 push）
 * @returns {object} 同一个 body（链式用），它的  就是那个空数组
 */
export function withNotes(body = {}) {
  if (!Array.isArray(body.notes)) body.notes = [];
  return body;
}

/** 把一批"可能为空"的原因塞进 notes（空串/空值会被丢掉，不占一行）。返回同一个 body。 */
export function addNotes(body, ...items) {
  const list = withNotes(body).notes;
  for (const item of items.flat()) {
    if (item === undefined || item === null) continue;
    const text = String(item).trim();
    if (text) list.push(text);
  }
  return body;
}

/**
 * 把表情包 id 解析成"可以发出去的图片"（④§26）。
 *
 * 两件事在这里发生，顺序不能反：
 *  1. **只认库里真实存在的 id**——模型编造的 id 被丢掉并记一行日志。这是"不要编造 id"
 *     那条提示词约束的**执行侧**：光在提示词里写"不许编"是拦不住的。
 *  2. `noteUse()` 记账后立刻取 `pathOf()`，让"最近用过的"真的按发送次数排。
 */
/**
 * 「我正在替哪个会话办事」的解析器（`m85249` 审查报告 P1-1）。
 *
 * 以前工具一律用 `mind.activeSessionKey ?? mind.stats.lastTurn.sessionKey` 现推身份，
 * 而 `mind.activeSessionKey` 是**进程级共享变量**：`Mind#scanDue()` 用
 * `Promise.all(due.map(...flush))` **并发**跑多个会话，任何一条 `flush()` 都会覆写它。
 * 于是 A 群的长回合进行中 B 私聊被叫醒，A 的剩下几步里 `onebot_memory` 会往 B 写记忆、
 * `onebot_task` 会把任务记到 B 名下、读范围闸会拿 B 的身份去判 A 该不该读。
 *
 * 修法不是"再猜准一点"，而是**注册时就绑死**：`setup(agentCtx, { sessionKey })` 的闭包里
 * 本来就拿着这一会话的真身份，工具注册时把它传进来，此后不再推断。
 *
 * 兜底链只在没有绑定值时才走（老调用点 / 单会话的测试环境）：
 * 绑定的 sessionKey → `activeSessionKey` → 上一轮回合的 sessionKey → 空串。
 *
 * @param {{bound?: string, mind?: {activeSessionKey?: string|null, stats?: {lastTurn?: {sessionKey?: string}}}}} input
 * @returns {() => string} 取当前会话键（永不抛）
 */
export function makeSessionKeyResolver({ bound, mind } = {}) {
  const fixed = String(bound ?? '').trim();
  return () => {
    if (fixed) return fixed;
    const live = String(mind?.activeSessionKey ?? '').trim();
    if (live) return live;
    return String(mind?.stats?.lastTurn?.sessionKey ?? '').trim();
  };
}

/** 每轮生图额度账：键是 `<会话>#<轮次>`，只在内存里（限额只管这一轮）。 */
export const imageGenUsed = new Map();

/**
 * 领一次"本轮生图额度"（`imageGen.maxPerTurn`）。
 *
 * 抽成纯函数是为了能被单独测：限额是**代码侧的硬边界**，不能只写在配置里。
 * @param {Map<string, number>} map 额度账
 * @param {string} key `<会话>#<轮次>`
 * @param {number} limit 本轮上限（≥1）
 * @returns {{ok:boolean, used:number, limit:number}}
 */
export function claimImageQuota(map, key, limit) {
  const cap = Math.max(1, Number(limit) || 1);
  const used = Number(map.get(key) ?? 0) || 0;
  if (used >= cap) return { ok: false, used, limit: cap };
  map.set(key, used + 1);
  return { ok: true, used: used + 1, limit: cap };
}

/**
 * 配置 UI 的"宿主侧体检"：浏览器半侧（`client.js`）到底有没有被宿主扫描到、会不会被服务出去。
 *
 * 纯诊断，用来区分设置页空白的两种可能：
 *   · 页面**根本没加载**（host 没扫到 `dsh.client`、没有 bundle 行）——看 `path`/`hubRows`；
 *   · 页面**加载了但渲染失败**（那一侧会自己把错误画在页面上）——这时 `path` 有值。
 * 读的是宿主 `clientModules` 服务；读不到就如实说读不到，不编。
 */
export function auditClientModules(ctx, id = 'dsh-onebot-hub') {
  const mod = ctx && typeof ctx.get === 'function' ? ctx.get('clientModules') : null;
  if (!mod) return { available: false, note: '宿主没有 clientModules 服务（非 web 组合？）' };
  const out = { available: true, id };
  try {
    out.path = typeof mod.clientPath === 'function' ? mod.clientPath(id) ?? null : null;
  } catch (err) {
    out.pathError = String(err?.message ?? err);
  }
  try {
    const graph = typeof mod.graph === 'function' ? mod.graph() : undefined;
    const rows = Array.isArray(graph)
      ? graph
      : Array.isArray(graph?.rows) ? graph.rows
        : Array.isArray(graph?.plugins) ? graph.plugins
          : Array.isArray(graph?.entries) ? graph.entries : [];
    out.rows = rows
      .map((row) => (typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.specifier ?? null))
      .filter((entry) => typeof entry === 'string' && entry.length > 0);
    out.hubRows = out.rows.filter((entry) => entry.toLowerCase().includes('onebot'));
  } catch (err) {
    out.graphError = String(err?.message ?? err);
  }
  try {
    const baseline = typeof mod.artifactBaseline === 'function' ? mod.artifactBaseline(id) : undefined;
    out.baseline = baseline === undefined || baseline === null ? null : typeof baseline === 'string' ? baseline : 'present';
  } catch (err) {
    out.baselineError = String(err?.message ?? err);
  }
  return out;
}
