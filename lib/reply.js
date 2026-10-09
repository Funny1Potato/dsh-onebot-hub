/**
 * 回复候选与出站构造（§21.5 / §6.5 / m32420 一次调用多条消息）。
 *
 * 三条规矩来自 dsh-onebot 的实测经验：
 *  1. `onebot_reply` 只**写候选**，由编排层在 agent 本轮 idle 后统一发送——模型一轮里可能调多次，
 *     但一个话题只应该回一次（后写覆盖，m31311 定案③）。
 *  2. 出站走 `send_msg`：下游适配器（NoneBot OneBot v11）实际只发这一个 action，
 *     把 `message_type`/`group_id`/`user_id` 摊平进 params（见方案 §19.3）。
 *  3. **一次调用可以发多条消息**（用户 m32388/m32420）。段数组的形状照 aigf-master 的 `reply`
 *     字段（`nonebot_plugin_aigf_master/response_parser.py:126-148`），拆条规则照它的
 *     `compose_unimsg_list`（`unimsg.py:398-449`）：**连续的文字/at 合成一条、每张图片独立成条**。
 *     我们比它多两处（都是用户明确定的）：①文字段之间**允许拆条**（`{"type":"break"}` 或 `text` 里的空行）；
 *     ②`at` 段**不单独拆出来**（它跟相邻文字同属一条——用户原话「@的字段不应该单独拆出来」）。
 */

export class ReplyBuffer {
  #candidate = null;
  #limits;

  /** 上限从配置来（`agent.replyMaxText` / `agent.replyMaxImages`），建缓冲时钉住。 */
  constructor({ maxText = 3, maxImages = 9 } = {}) {
    this.#limits = { maxText, maxImages };
  }

  get active() {
    return this.#candidate !== null;
  }

  get candidate() {
    return this.#candidate;
  }

  /**
   * 后写覆盖先写：一轮里多次调用只有最后一次生效。
   *
   * 复合出来的不是"一条消息"而是**一组消息**（`candidate.messages`）：拆条、上限、
   * 间隔、失败即停都发生在出站那一步，候选只负责把模型给的内容摆成原子的顺序。
   */
  capture(args = {}) {
    const plan = composeReply({ ...this.#limits, ...args });
    if (!plan.messages.length) return null;
    const first = plan.messages[0];
    this.#candidate = {
      text: plan.text,
      images: plan.images,
      memes: plan.memes,
      quote: args.quote ?? args.quote_message_id ?? null,
      // 旧字段保留：合并全部消息的段（诊断/对账用），发送按 `messages` 逐条来。
      segments: plan.messages.flatMap((m) => m.segments),
      messages: plan.messages,
      dropped: plan.dropped,
      messageType: args.messageType,
      groupId: args.groupId,
      userId: args.userId,
      ts: Date.now(),
    };
    return this.#candidate;
  }

  take() {
    const c = this.#candidate;
    this.#candidate = null;
    return c;
  }

  clear() {
    this.#candidate = null;
  }
}

/**
 * 段数组 → 消息列表（aigf 式拆条 + 文字上限）。
 *
 * 返回 `{ messages, dropped, text, images, memes, skipped }`：
 *  - `messages[i] = { segments, text, kind }`，`kind` 是 `'text'` / `'image'`（上限只算 text，用户 m32420）。
 *  - `dropped = { text: n, images: n }`：超出上限被丢掉的条数（**如实告知**，不静默）。
 *  - `skipped = [原因…]`：解不出来的 @ 段之类。
 *
 * 拆条规则（照 aigf，只多了文字可拆）：
 *  - `text`/`at` 原子连续出现 → 合成**一条**消息（at 因此不会单独成条）；
 *  - `image` 原子 → **独立一条**，它前后的文字各自成条；
 *  - `break` 原子（`{"type":"break"}`）→ 强制断开当前这条。
 */
export function composeReply({
  text,
  images = [],
  memes = [],
  parts = null,
  quote = null,
  maxText = 3,
  maxImages = 9,
} = {}) {
  const atoms = [];
  const skipped = [];
  const usedParts = Array.isArray(parts) && parts.length > 0;

  if (usedParts) {
    for (const raw of normalizeParts(parts, skipped)) atoms.push(raw);
  } else {
    // 简写 `text`：空行（两个换行）= 想分成两条消息，逐段 strip；单换行留在同一条里。
    pushText(atoms, text);
    for (const img of images ?? []) {
      const file = fileOf(img);
      if (file) atoms.push({ kind: 'image', file, source: img });
    }
    for (const meme of memes ?? []) {
      const file = typeof meme === 'string' ? meme : meme?.file;
      if (file) atoms.push({ kind: 'image', file: String(file), memeId: meme?.id ?? null, source: meme });
    }
  }

  const quoted = quote !== undefined && quote !== null && quote !== '';
  const groups = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    groups.push(cur);
    cur = [];
  };
  for (const atom of atoms) {
    if (atom.kind === 'break') {
      flush();
      continue;
    }
    if (atom.kind === 'image') {
      // 图片独立成条（aigf 同款）：先冲掉手上这条，再单开一条只装它。
      flush();
      groups.push([atom]);
      continue;
    }
    cur.push(atom);
  }
  flush();

  // 上限：只限**文字**条数（图另算，用户 m32420）。超出的从尾部丢，保持顺序。
  const textCap = Number.isFinite(maxText) && maxText > 0 ? Math.floor(maxText) : Infinity;
  const imageCap = Number.isFinite(maxImages) && maxImages > 0 ? Math.floor(maxImages) : Infinity;
  let seenText = 0;
  let seenImage = 0;
  const kept = [];
  const dropped = { text: 0, images: 0 };
  for (const group of groups) {
    const isImage = group[0].kind === 'image';
    if (isImage) {
      seenImage += 1;
      if (seenImage > imageCap) {
        dropped.images += 1;
        continue;
      }
    } else {
      seenText += 1;
      if (seenText > textCap) {
        dropped.text += 1;
        continue;
      }
    }
    kept.push(group);
  }

  const messages = kept.map((group, i) => {
    const segments = [];
    // 引用只挂第一条：一条回复引一次就够，后面几条再引是同一件事重复三遍。
    if (quoted && i === 0) segments.push({ type: 'reply', data: { id: String(quote) } });
    // 组内相邻原子之间插**恰好一个空格**（aigf 同款）：两个 text 段直接相邻会被渲染端黏成一坨，
    // @ 后面不接空格也会跟文字粘在一起。头尾不插（首尾没有分隔的必要）。
    for (const [j, atom] of group.entries()) {
      if (j > 0) segments.push(SPACE_SEG);
      segments.push(...segmentsOf(atom));
    }
    const body = group
      .filter((a) => a.kind === 'text')
      .map((a) => a.text)
      .join(' ');
    return { segments, text: body, kind: group[0].kind };
  });

  return {
    messages,
    dropped,
    skipped,
    usedParts,
    maxText: textCap === Infinity ? 0 : textCap,
    maxImages: imageCap === Infinity ? 0 : imageCap,
    text: messages.map((m) => m.text).filter(Boolean).join(' '),
    images: kept.flatMap((g) => g.filter((a) => a.kind === 'image').map((a) => ({ file: a.file, id: a.memeId ?? null }))),
    memes: kept.flatMap((g) => g.filter((a) => a.kind === 'image' && a.memeId).map((a) => ({ id: a.memeId, file: a.file }))),
  };
}

/** 段的规范化：容错一点，但解不出来的**说出来**（`skipped`），不静默丢。 */
function normalizeParts(parts, skipped) {
  const out = [];
  for (const raw of Array.isArray(parts) ? parts : []) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string') {
      pushText(out, raw);
      continue;
    }
    const type = String(raw?.type ?? 'text').toLowerCase();
    if (type === 'break' || type === 'message' || type === 'new' || type === 'gap') {
      out.push({ kind: 'break' });
    } else if (type === 'image' || type === 'meme' || type === 'photo') {
      // `{"type":"meme","id":"m3"}` 是 aigf 的写法：id 本身就是图片来源。
      const id = raw?.meme_id ?? raw?.memeId ?? (type === 'meme' ? raw?.id : null);
      const file = fileOf(raw?.source ?? raw?.file ?? raw?.url ?? raw?.path ?? raw?.image ?? raw?.id ?? '');
      if (!file) skipped.push(`图片段没有可用的来源：${JSON.stringify(raw).slice(0, 80)}`);
      else out.push({ kind: 'image', file: String(file), memeId: id ? String(id) : null, source: raw });
    } else if (type === 'at') {
      const qq = atTargetOf(raw);
      if (qq) out.push({ kind: 'at', qq });
      else skipped.push(`@ 段认不出账号（OneBot 的 at 只能带 QQ 号，不能带昵称）：${JSON.stringify(raw).slice(0, 80)}`);
    } else {
      const body = String(raw?.content ?? raw?.text ?? '');
      // text 段内部也允许空行拆条（模型顺手写了多段，不必逼它用 break）。
      if (body.trim()) pushText(out, body);
      // 没写 type 的当 text 处理（schema 里不能写 `required`，见 REPLY_PART_ITEM）；
      // 写了别的类型又什么都没带的，要说出来，不能悄悄吞掉。
      else if (type && type !== 'text') skipped.push(`认不出的段类型「${type}」，也没带文字：${JSON.stringify(raw).slice(0, 80)}`);
    }
  }
  return out;
}

/** `at` 只认得 QQ 号（昵称发不出去，OneBot 的 at 段要 `qq`）。 */
function atTargetOf(raw) {
  const v = String(raw?.target ?? raw?.qq ?? raw?.user_id ?? raw?.name ?? '').trim();
  return /^-?\d+$/.test(v) ? v : null;
}

const SPACE_SEG = { type: 'text', data: { text: ' ' } };

function segmentsOf(atom) {
  if (atom.kind === 'image') return [{ type: 'image', data: { file: atom.file } }];
  if (atom.kind === 'at') return [{ type: 'at', data: { qq: atom.qq } }];
  return [{ type: 'text', data: { text: atom.text } }];
}

function fileOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.file) return String(v.file);
  if (v.url) return String(v.url);
  if (v.path) return String(v.path);
  if (v.base64) return `base64://${v.base64}`;
  return '';
}

/** 空行分段：`"a\n\nb"` → `['a','b']`；单换行留着（一条消息里的正常折行）。 */
function splitBlankLines(value) {
  const body = String(value ?? '');
  if (!body.trim()) return [];
  return body
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 文本 → 原子（**段间插 break**）。
 *
 * 这一步是"空行能断条"的全部实现：拆出来的段如果不插 break，按"连续文字合成一条"的规则
 * 又会被合回一条，等于空行没用。
 */
function pushText(atoms, value) {
  const chunks = splitBlankLines(value);
  for (const [i, chunk] of chunks.entries()) {
    if (i > 0) atoms.push({ kind: 'break' });
    atoms.push({ kind: 'text', text: chunk });
  }
}

/**
 * 段构造：只做协议层的事（CQ 段数组），不做拟人化判断。**单条消息**的快捷路径。
 *
 * `memes` 里的每一项是**已经解析好本地文件**的 `{id, file}`（由 `MemeStore.pathOf` 给路径）。
 * 这里刻意不产 `{type:'meme'}`：OneBot v11 没有这个段，实现端只认 `image`——
 * 表情包在协议上就是一张图，本地库只是"挑哪张"的选片台。
 */
export function buildSegments({ text, images = [], memes = [], quote } = {}) {
  const segs = [];
  if (quote !== undefined && quote !== null && quote !== '') segs.push({ type: 'reply', data: { id: String(quote) } });
  const body = String(text ?? '');
  if (body.trim()) segs.push({ type: 'text', data: { text: body } });
  for (const img of images ?? []) {
    if (!img) continue;
    if (typeof img === 'string') segs.push({ type: 'image', data: { file: img } });
    else if (img.file) segs.push({ type: 'image', data: { file: String(img.file) } });
    else if (img.url) segs.push({ type: 'image', data: { file: String(img.url) } });
    else if (img.base64) segs.push({ type: 'image', data: { file: `base64://${img.base64}` } });
  }
  for (const meme of memes ?? []) {
    if (!meme) continue;
    const file = typeof meme === 'string' ? meme : meme.file;
    if (file) segs.push({ type: 'image', data: { file: String(file) } });
  }
  return segs;
}

/** `group:123` / `private:456` → send_msg 的摊平参数。 */
export function parseSessionKey(sessionKey) {
  const s = String(sessionKey ?? '');
  if (s.startsWith('group:')) return { message_type: 'group', group_id: numeric(s.slice(6)) };
  if (s.startsWith('private:')) return { message_type: 'private', user_id: numeric(s.slice(8)) };
  return { message_type: null };
}

/**
 * 修1（真机事故 `failed -1935986436`）：`hub-media:<id>` 是枢纽自己的落地引用，
 * 上游实现端认不得，原样发出去只会 failed。两个 `onebot_reply`（会话缓冲版与直发版）
 * 都先走这一步：换成 blob 本地路径（与 memes 同待遇）；解析不出来**当场报错**——
 * "已排队/已发送"不能变成一句谎话。
 */
export function resolveReplyImages(hub, rawImages) {
  const out = [];
  for (const img of Array.isArray(rawImages) ? rawImages : []) {
    const ref = typeof img === 'string' ? img : String(img?.file ?? img?.url ?? '');
    if (ref.startsWith('hub-media:')) {
      const rec = hub?.media?.find?.(ref) ?? null;
      if (!rec?.blob) {
        throw new Error(`图片引用不可用：${ref}（「已存为 hub-media:…」只对近期消息有效，过期就换一个来源）`);
      }
      out.push(typeof img === 'string' ? rec.blob : { ...img, file: rec.blob });
    } else {
      out.push(img);
    }
  }
  return out;
}

const numeric = (v) => (/^-?\d+$/.test(String(v)) ? Number(v) : v);

export function buildSendParams({ segments, sessionKey, messageType, groupId, userId } = {}) {
  const fromKey = parseSessionKey(sessionKey);
  const params = {
    message_type: messageType ?? fromKey.message_type,
    message: segments ?? [],
  };
  if (params.message_type === 'group') params.group_id = groupId ?? fromKey.group_id;
  if (params.message_type === 'private') params.user_id = userId ?? fromKey.user_id;
  params.auto_escape = false;
  return { action: 'send_msg', params };
}

/** 给"唤醒通知"用的一句话摘要：让模型知道自己为什么被叫醒。 */
export function describeReply(candidate) {
  if (!candidate) return '（未回复）';
  const messages = Array.isArray(candidate.messages) && candidate.messages.length ? candidate.messages : null;
  const text = String(candidate.text ?? '').replace(/\s+/g, ' ').trim();
  const extra = [];
  if (candidate.images?.length) extra.push(`${candidate.images.length} 张图`);
  if (candidate.memes?.length) extra.push(`${candidate.memes.length} 张表情`);
  if (candidate.quote) extra.push('带引用');
  if (messages && messages.length > 1) extra.push(`共 ${messages.length} 条`);
  const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return [short || '（仅图片）', extra.length ? `[${extra.join('/')}]` : ''].filter(Boolean).join(' ');
}

/**
 * 超出上限/解不出来的段，要**说出来**（§26 的老规矩）：模型必须知道少发了什么，
 * 否则它会以为整段都说出去了（照 `memes.maxSend` 的回执口径）。
 */
export function describePlanIssues(plan) {
  const notes = [];
  if (plan?.dropped?.text) notes.push(`另有 ${plan.dropped.text} 条文字超出上限（${plan.maxText}）未发`);
  if (plan?.dropped?.images) notes.push(`另有 ${plan.dropped.images} 张图超出上限未发`);
  for (const s of plan?.skipped ?? []) notes.push(s);
  return notes;
}

/**
 * `parts` 的元素 schema。
 *
 * **不许写 `required`**：宿主的工具 schema DSL（`@deepseek-ai/dsh-tools` 的
 * `assertAuthorKeys`）只在**对象属性节点**上认 `required`，数组 `items` 里写了就会
 * `JsonSchemaError: unsupported JSON schema: parameters.parts.items.required …`，
 * 而那是在 `defineTool` 里抛的——**整个插件 apply 直接挂掉**（真机：设置页一直转圈、
 * 上下游都没连、插件行挂红标）。所以必填性靠说明文字和运行时的容错，不靠 schema。
 * **`additionalProperties` 必须显式写**：宿主的对象节点少这个键直接 `authorError`
 * （`must be explicitly true or false`）。这两条都写进 `test/stubs/dsh-tools.mjs` 了，
 * 本地 `load-check` 就能拦住（真机事故：2026-10-09）。
 */
export const REPLY_PART_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', description: 'text / image / at / break。**必填**，不写当 text 处理。' },
    content: { type: 'string', description: 'type=text 时的文字。' },
    source: { type: 'string', description: 'type=image 时的图片来源：http(s) URL、本地路径、base64://、`hub-media:<id>`，或表情包 id（m3）。' },
    target: { type: 'string', description: 'type=at 时的 **QQ 号**（协议只认数字，昵称发不出去）；它会跟相邻文字发在同一条消息里，不会单独成条。' },
  },
};

/** 工具参数表（DSH `tools.register` 的扁平 `{name:{type,description}}` 形态）。 */
export const REPLY_TOOL_PARAMS = {
  text: {
    type: 'string',
    description:
      '要发送的文本内容。**中间的空行会分成多条消息**（一句一段，别用空行做段内排版）；留空则只发图片。',
  },
  parts: {
    type: 'array',
    description:
      '精细控制一条回复怎么拆成多条消息（给了它就以它为准，`text`/`images`/`memes` 被忽略）。' +
      '元素是段：{"type":"text","content":"…"} / {"type":"image","source":"URL|本地路径|hub-media:xx|m3"} / ' +
      '{"type":"at","target":"QQ号"} / {"type":"break"}（强制断成两条消息）。' +
      '拆条规则：**每张图独立成一条消息**，文字与 @ 各自聚成一条（@ 不会单独成条）。',
    items: REPLY_PART_ITEM,
  },
  images: {
    type: 'array',
    description: '要发送的图片，元素为 http(s) URL、本地路径或 base64 字符串。**每张图各发一条消息**。',
    items: { type: 'string' },
  },
  memes: {
    type: 'array',
    description:
      '要发送的表情包 id（形如 m3）。**只能用上下文里列出的 id**，编造的 id 会被丢掉；' +
      '不确定就先看清单，清单里没有就别发表情。每张表情各发一条消息。',
    items: { type: 'string' },
  },
  quote_message_id: { type: 'string', description: '可选。要引用的消息 message_id（只挂第一条消息）；不确定就不要传。' },
};
