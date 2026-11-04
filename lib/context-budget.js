/**
 * 上下文预算：每个会话这一轮往 prompt 里塞了多少东西（`m77950` 阶段 3）。
 *
 * 以前只有一个笼统的「每次请求 ≈ 33K」，谁也说不清花在哪：指导段？工具描述？还是记忆。
 * 这个模块把一轮装配的账记下来，并在 `onebot_hub_status` 里摊开——**只算本插件的部分**，
 * 宿主的系统提示词与对话历史不在账上（那是宿主的，插件看不到）。
 *
 * 三处来源分开记，因为它们由三个不同的开关控制、改法也不一样：
 *   1. `sections`：快照（`assembleContext` 的段）——改配置（人物卡张数、记忆条数、目录档位）；
 *   2. `tools`：注册给这个会话的工具描述——改 `agent.toolDeny` / `keepTools` / 关掉某个功能；
 *   3. `guidance`：指导段全文（它其实是 section 之一，单列出来是因为它最容易被忽略）。
 */

/**
 * 粗估 token。中文约 1 字 1 token，ASCII 约 4 字符 1 token——按字符分类数，比一刀切 /4 准，
 * 也不至于为了"精确"去引一个分词库（那要几 MB，而这个数字只需要相对大小对）。
 */
export function estimateTokens(text = '') {
  const s = String(text ?? '');
  let wide = 0;
  let narrow = 0;
  // 一个 emoji 常常是好几个码位：ZWJ 序列（👨‍👩‍👧）、肤色修饰（👍🏻）、国旗的两次区域指示（🇨🇳）。
  // 模型看到的是一个 token，按码位逐个加会把它估成 2~5 个。这里把"连着这几类修饰码位"的粘成一个单位：
  const ZWJ = '\u200d';
  const isModifier = (code) =>
    code === 0xfe0f || // 变体选择符（要不要按彩色画）
    code === 0x20e3 || // 键帽
    (code >= 0x1f3fb && code <= 0x1f3ff) || // 肤色
    (code >= 0xe0020 && code <= 0xe007f); // 标签序列（英格兰旗之类）
  const isRegional = (code) => code >= 0x1f1e6 && code <= 0x1f1ff; // 国旗由两个字母组成
  let regionalSeen = 0;
  let lastWasZwj = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200d) {
      lastWasZwj = true;
      continue;
    }
    // 接在上一个单位后面的修饰码位：不算新的字。
    if (lastWasZwj || isModifier(code)) {
      lastWasZwj = false;
      continue;
    }
    lastWasZwj = false;
    if (isRegional(code)) {
      // 两个区域指示凑一面旗，第二个不再计。
      regionalSeen += 1;
      if (regionalSeen % 2 === 0) continue;
      wide += 1;
      continue;
    }
    regionalSeen = 0;
    // 全角标点、CJK、假名、谚文等：一个字基本就是一个 token。
    if (code > 0x2e80) wide += 1;
    else narrow += 1;
  }
  return Math.ceil(wide + narrow / 4);
}

/** 一组 {name, chars, text?} 的账。`text` 没给时用 chars 估 token；给了就按正文精确估。 */
function summarize(list, keyOf = (x) => String(x?.name ?? '')) {
  const rows = list
    .map((x) => {
      const chars = Number(x?.chars ?? 0) || 0;
      return {
        name: keyOf(x),
        chars,
        tokens: typeof x?.text === 'string' ? estimateTokens(x.text) : Math.ceil(chars),
        note: x?.note ?? null,
      };
    })
    .filter((x) => x.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  return { rows, chars: rows.reduce((n, x) => n + x.chars, 0), tokens: rows.reduce((n, x) => n + x.tokens, 0) };
}

/**
 * 一份会话的预算账。
 *
 * @param {object} input
 * @param {string} input.sessionKey
 * @param {string} [input.pluginGuidance] `buildHubGuidance` 那一段（order 160 的 `plugin:dsh-onebot-hub`）
 * @param {Array<{name:string,chars:number,note?:string}>} [input.sections] 快照段（`assembleContext` 的 sections）
 * @param {string} [input.snapshotText] 快照全文（用于精确估 token 与"段与段之间的空行"）
 * @param {Array<{name:string,description:string}>} [input.tools] 这个会话拿到的工具与描述
 * @param {Array<string>} [input.unavailable] 这个会话**没有**拿到的工具名（被 deny 掉的，只报名字不报描述）
 * @param {number} [input.at] 采样时刻
 */
export function contextBudget({
  sessionKey = '',
  sections = [],
  snapshotText = '',
  tools = [],
  unavailable = [],
  pluginGuidance = '',
  at = Date.now(),
} = {}) {
  const sec = summarize(Array.isArray(sections) ? sections : []);
  const guidanceRow = sec.rows.find((x) => x.name === 'guidance') ?? null;
  const toolRows = (Array.isArray(tools) ? tools : [])
    .map((t) => {
      const desc = String(t?.description ?? '');
      const name = String(t?.name ?? '');
      return { name, chars: desc.length, tokens: estimateTokens(`${name}\n${desc}`) };
    })
    .filter((t) => t.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  const toolChars = toolRows.reduce((n, t) => n + t.chars, 0);
  const toolTokens = toolRows.reduce((n, t) => n + t.tokens, 0);
  // 快照全文单独估一次：段与段之间还有空行，逐段相加会略少，两个数都在也无妨。
  const snapshotTokens = snapshotText ? estimateTokens(snapshotText) : sec.tokens;
  return {
    sessionKey,
    at,
    // 只算插件自己的部分：`pluginTokens` 是这个插件往这一轮里塞的全部字（快照 + 工具描述）。
    plugin: {
      chars: sec.chars + toolChars + (pluginGuidance ? String(pluginGuidance).length : 0),
      tokens: sec.tokens + toolTokens + (pluginGuidance ? estimateTokens(pluginGuidance) : 0),
    },
    snapshot: {
      chars: sec.chars,
      tokens: Math.max(sec.tokens, snapshotTokens),
      // 前几段是谁——摊开看才知道该从哪里省。
      top: sec.rows.slice(0, 6),
      sections: sec.rows.map(({ name, chars, tokens }) => ({ name, chars, tokens })),
    },
    /**
     * 指导语其实有**两块**，内容不同、开关也不同，以前只报了一块（`m78129` 自查）：
     *   - `pluginSection`：`buildHubGuidance` 那一段，注册成 `plugin:dsh-onebot-hub`（order 160）；
     *   - `snapshot`：快照里的 `guidance` 段（`DEFAULT_GUIDANCE` + 按开关拼的 CROSS/SESSION/OFFICIAL/TASK）。
     * 只报后者会让真实开销被少算一半以上（真机实测 2210 vs 3334），所以两半都列、再给 `total`。
     */
    guidance: {
      snapshot: guidanceRow ? { chars: guidanceRow.chars, tokens: guidanceRow.tokens } : { chars: 0, tokens: 0 },
      pluginSection: pluginGuidance
        ? { chars: String(pluginGuidance).length, tokens: estimateTokens(pluginGuidance) }
        : { chars: 0, tokens: 0 },
      // 两个字都在才算数：`total` 是这一项的总字数，`totalTokens` 同理——
      // 只给一个字，读的人拿到的就是"和 plugin.chars 对不上的数"（`m78216` 自查）。
      total: (guidanceRow?.chars ?? 0) + (pluginGuidance ? String(pluginGuidance).length : 0),
      totalTokens: (guidanceRow?.tokens ?? 0) + (pluginGuidance ? estimateTokens(pluginGuidance) : 0),
    },
    tools: {
      count: toolRows.length,
      chars: toolChars,
      tokens: toolTokens,
      top: toolRows.slice(0, 6),
      /** 被 deny 掉的只报名字：它们的描述根本没进 prompt，列出来是防止"以为它们也在花钱"。 */
      unavailable: (Array.isArray(unavailable) ? unavailable : []).map(String).filter(Boolean),
    },
    // 一句话口径，省得读的人自己去加：这两个数不含宿主的系统提示词与对话历史。
    note: '只算这个插件塞进去的部分（快照 + 指导段 + 注册给这个会话的工具描述）；宿主的系统提示词与对话历史不在内，所以它比"每次请求的输入 token"小。',
  };
}

/** 从工具清单里挑出"描述指得上的" —— 兼容宿主两种注册形态（数组或 Map 值）。 */
export function toolsOf(registered = []) {
  const list = Array.isArray(registered) ? registered : Object.values(registered ?? {});
  return list
    .map((t) => ({ name: String(t?.name ?? t?.id ?? ''), description: String(t?.description ?? '') }))
    .filter((t) => t.name);
}
