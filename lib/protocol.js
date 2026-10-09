/**
 * OneBot v11 帧编解码。
 *
 * 本模块只做**中继**相关的事：忠实搬运、按下游视角重签标识、生成合规信封。
 * 它**不做**事件合成语义（不补 `to_me`、不压缩 `sender`、不改空白与段序）——
 * 那些都是 §18.2/§18.3 明确禁止的失真改写。
 */

const CQ_TEXT_ESCAPE = [
  [/&/g, '&amp;'],
  [/\[/g, '&#91;'],
  [/\]/g, '&#93;'],
];

const CQ_PARAM_ESCAPE = [...CQ_TEXT_ESCAPE, [/,/g, '&#44;']];

function applyEscapes(input, table) {
  let out = String(input ?? '');
  for (const [re, to] of table) out = out.replace(re, to);
  return out;
}

export function escapeCqText(input) {
  return applyEscapes(input, CQ_TEXT_ESCAPE);
}

export function escapeCqParam(input) {
  return applyEscapes(input, CQ_PARAM_ESCAPE);
}

export function unescapeCq(input) {
  return String(input ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#93;/g, ']')
    .replace(/&#91;/g, '[')
    .replace(/&amp;/g, '&');
}

/** 段数组 → CQ 码文本（用于 raw_message 兜底与日志）。段序、空白零改写。 */
export function renderCq(segments) {
  if (!Array.isArray(segments)) return String(segments ?? '');
  return segments
    .map((seg) => {
      if (!seg || typeof seg !== 'object') return '';
      if (seg.type === 'text') return escapeCqText(seg.data?.text ?? '');
      const params = Object.entries(seg.data ?? {})
        .map(([k, v]) => `${k}=${escapeCqParam(v)}`)
        .join(',');
      return `[CQ:${seg.type}${params ? `,${params}` : ''}]`;
    })
    .join('');
}

/** CQ 码文本 → 段数组。 */
export function parseCq(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', data: { text: unescapeCq(src.slice(last, m.index)) } });
    const data = {};
    for (const part of (m[2] || '').replace(/^,/, '').split(',')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      data[part.slice(0, eq)] = unescapeCq(part.slice(eq + 1));
    }
    out.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', data: { text: unescapeCq(src.slice(last)) } });
  return out;
}

const SEG_LABEL = {
  text: null,
  face: '[表情]',
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  at: null,
  rps: '[猜拳]',
  dice: '[骰子]',
  shake: '[窗口抖动]',
  poke: '[戳一戳]',
  anonymous: '[匿名]',
  share: '[链接]',
  contact: '[推荐]',
  location: '[位置]',
  music: '[音乐]',
  reply: '[回复]',
  forward: '[合并转发]',
  node: '[转发节点]',
  xml: '[XML]',
  json: '[JSON]',
};

/** 需要落地成 durable ref 的媒体段类型（上游侧与下游侧共用同一套）。 */
export const MEDIA_SEGMENT_TYPES = ['image', 'record', 'video', 'file'];

/**
 * 把消息段里的**内联大块数据**换成占位符——**只给"给人看的那份"和落盘索引看**，绝不碰转发帧。
 *
 * 下游用 `base64://…` 发图是常态，原样记一遍就是几百 KB：agent 既读不懂，一次查询还能把上下文
 * 撑爆（真机上见过 101KB 的捕获结果）。字节早已落成 `hub-media:<id>` 的 blob，所以这里留一句
 * "已落地"就够——要原文的去看索引里的引用。
 */
function stripSegments(segments) {
  return segments.map((seg) => {
    const file = seg?.data?.file;
    if (typeof file !== 'string') return seg;
    // `base64://` / `data:` 一定是内联数据（多小都换掉：字节已经在媒体引用里了）；别的写法
    // 只有长到不像 URL 才当成内联（有些实现端把整张图塞进 `file`）。
    const inline = file.startsWith('base64://') || file.startsWith('data:') || file.length >= 256;
    if (!inline) return seg;
    return { ...seg, data: { ...(seg.data ?? {}), file: `${file.slice(0, 24)}…（${file.length} 字符内联数据，已落地成媒体引用）` } };
  });
}

export function stripInlineMedia(params) {
  if (Array.isArray(params?.message)) return { ...params, message: stripSegments(params.message) };
  // `send_group_forward_msg`/`send_private_forward_msg` 的内容在 `params.messages`（node 数组），
  // 节点里同样可能带内联大图——strip 要跟到这层，否则 raw 索引照样被几百 KB 的 base64 顶爆。
  if (Array.isArray(params?.messages)) {
    return {
      ...params,
      messages: params.messages.map((node) => {
        const content = node?.data?.content ?? node?.content;
        if (!Array.isArray(content)) return node;
        const stripped = stripSegments(content);
        if (node?.data && Array.isArray(node.data.content)) return { ...node, data: { ...node.data, content: stripped } };
        return { ...node, content: stripped };
      }),
    };
  }
  return params;
}

/**
 * 这是不是"**聊天记录**"（合并转发段，或 QQ 的 `com.tencent.multimsg` 多消息卡片）。
 *
 * 认出来就**不展开、不解析**（`m03065` 用户要求）：hub 只把它当一条"有一坨东西在里面"的消息
 * 记进时间线与索引，需要里面的内容时由 agent 自己取原文（或调 `get_forward_msg`）再处理。
 */
export function isChatHistoryCard(seg) {
  const type = String(seg?.type ?? '');
  if (type === 'forward') return true;
  if (type !== 'json' && type !== 'xml') return false;
  const raw = String(seg?.data?.data ?? seg?.data?.string ?? seg?.data?.text ?? '');
  if (!raw.trim()) return false;
  return /multimsg|聊天记录/i.test(raw);
}

/** 段数组 → 人类可读文本（仅供日志/时间线，不参与线上帧）。 */
export function messageToText(segments) {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return '';
  let out = '';
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      out += seg.data?.text ?? '';
    } else if (seg.type === 'at') {
      out += `@${seg.data?.qq ?? '?'} `;
    } else if (seg.type === 'image') {
      out += SEG_LABEL.image;
    } else if (seg.type === 'forward') {
      // 合并转发：内容按约定不展开（`m29922`，与群友聊天记录同待遇），只报条数。
      out += seg.data?.count ? `[合并转发 ${seg.data.count} 条：内容未展开]` : SEG_LABEL.forward;
    } else {
      out += SEG_LABEL[seg.type] ?? `[${seg.type}]`;
    }
  }
  return out;
}

export function segmentsOf(event) {
  const raw = event?.message;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return parseCq(raw);
  return [];
}

/**
 * 动作参数 → 消息段数组（下游侧提文本/落媒体的共享入口）。
 *
 * 之前只认 `params.message`（`send_msg` 形状），`send_group_forward_msg`/`send_private_forward_msg`
 * 的 `params.messages`（node 数组）没人读——下游 bot 回合并转发时整条提不出文本（`m28267`），
 * 空 body 被批次挡掉。
 *
 * 合并转发**不展开节点内容**（`m29922` 用户定案：与群友发的聊天记录同待遇）：只包一个 forward
 * 占位段让文本非空、能进批次，节点原文挂在 `data.nodes` 上——agent 要看内容就自己 `onebot_raw`
 * 取原文（或调 `get_forward_msg`），媒体落地按需读 `data.nodes` 里的字节。
 */
export function segmentsFromParams(params) {
  if (Array.isArray(params?.message)) return params.message;
  if (Array.isArray(params?.messages)) {
    return [{ type: 'forward', data: { count: params.messages.length, nodes: params.messages } }];
  }
  if (typeof params?.message === 'string') return parseCq(params.message);
  return [];
}

/**
 * 这条消息**引用了哪条消息**（`reply` 段里的 id），没有就是 null。
 *
 * 单独抽出来是因为它有第二处用途：话题关联（§24.4）只认这条明写的证据，
 * 不像"关键词像"那样猜。
 */
export function replyTargetId(event) {
  for (const seg of segmentsOf(event)) {
    if (seg?.type !== 'reply') continue;
    const id = seg.data?.id ?? seg.data?.message_id ?? seg.data?.messageId;
    if (id !== undefined && id !== null && id !== '') return String(id);
  }
  return null;
}

/** 事件分类：hub 的路由与捕获都以它为准。 */
export function eventKind(event) {
  const post = event?.post_type;
  if (post === 'message') return event.message_type === 'private' ? 'private_message' : 'group_message';
  if (post === 'notice') return 'notice';
  if (post === 'request') return 'request';
  if (post === 'meta_event') return 'meta_event';
  return 'unknown';
}

export function isMessageEvent(event) {
  const kind = eventKind(event);
  return kind === 'group_message' || kind === 'private_message';
}

/** 会话键（群/私聊），不含发言人。 */
export function sessionKey(event) {
  if (eventKind(event) === 'group_message') return `group:${event.group_id}`;
  if (eventKind(event) === 'private_message') return `private:${event.user_id}`;
  return `other:${event?.post_type ?? 'unknown'}`;
}

/** 会话键（NoneBot 风格 group_<gid>_<uid>），用于对齐下游插件的预期。 */
export function conversationKey(event) {
  if (eventKind(event) === 'group_message') return `group_${event.group_id}_${event.user_id}`;
  if (eventKind(event) === 'private_message') return String(event.user_id ?? '');
  return `notice_${event?.notice_type ?? 'unknown'}`;
}

/**
 * 剥掉**由适配器派生**的字段。hub 绝不写 `to_me`（§19.2）：
 * 下游 NoneBot 无论如何都会按自己的 self_id/昵称重算，写进去反而掩盖真实判定。
 */
export function stripDerivedFields(event) {
  if (event && typeof event === 'object') {
    delete event.to_me;
    delete event.is_tome;
  }
  return event;
}

/**
 * 按**下游视角**重签事件（§18.3）：
 *  - `self_id` → 该下游链路自己的账号；
 *  - `message_id` → 需要跨链路隔离时改铸的虚拟 id；
 *  - 追加 `dsh_trace` 扩展字段（§19.1 实测下游会原样保留）；
 *  - 其余字段（含 `raw_message`、`sender` 全字段、段数组及其空白与顺序）**原样搬运**；
 *  - 永远剥掉 `to_me`/`is_tome`。
 *
 * @param {object} event 上游真实事件（不会被就地修改）
 * @param {{selfId?: string|number, selfIds?: Array<string|number>, messageId?: string|number, trace?: object}} opts
 * @returns {object} 可下发的下游视角事件
 */
export function retagEvent(event, opts = {}) {
  const out = structuredClone(event);
  stripDerivedFields(out);

  const { selfId, messageId, trace } = opts;
  if (selfId !== undefined && selfId !== null) {
    const prev = out.self_id;
    out.self_id = typeof prev === 'number' ? Number(selfId) : String(selfId);
  }
  if (messageId !== undefined && messageId !== null) {
    out.message_id = messageId;
    // raw_message 是"消息内容的 CQ 文本"，与 message_id 无关：不要重算它。
  }
  // 只有**缺失**时才补：实现端本就该给 raw_message，给了就原样搬运。
  if ((out.raw_message === undefined || out.raw_message === null || out.raw_message === '') && Array.isArray(out.message)) {
    out.raw_message = renderCq(out.message);
  }
  if (trace) out.dsh_trace = trace;
  return out;
}

/**
 * 把指向 `from` 的 at 段改指向 `to`。
 *
 * **默认不做**：自然拓扑里用户直接 @ 的是下游 bot 自己（at 本来就指向下游账号），
 * 改它反而失真。只有当用户 @ 的是 hub 自己的账号、却希望下游按"在叫我"处理时才需要，
 * 所以由配置显式开启（`remapAtSelf`）。
 */
export function remapAt(event, from, to) {
  if (!Array.isArray(event?.message)) return event;
  const fromStr = String(from);
  const toStr = String(to);
  for (const seg of event.message) {
    if (seg?.type === 'at' && String(seg.data?.qq) === fromStr) {
      seg.data = { ...seg.data, qq: toStr };
      // raw_message 若原本也指向 from，同步改，保持两处一致
      if (typeof event.raw_message === 'string') {
        event.raw_message = event.raw_message.replaceAll(`[CQ:at,qq=${fromStr}]`, `[CQ:at,qq=${toStr}]`);
      }
    }
  }
  return event;
}

export function readTrace(event) {
  const t = event?.dsh_trace;
  return t && typeof t === 'object' ? t : null;
}

/** 是否为本 hub（或同类枢纽）自己铸造的事件——防环的第一道闸。 */
export function isHubOriginated(event) {
  const t = readTrace(event);
  return Boolean(t && (t.origin === 'dsh-onebot-hub' || t.hub));
}

export function makeResult(echo, data) {
  return { status: 'ok', retcode: 0, data: data ?? null, echo: echo ?? null };
}

export function makeError(echo, msg, retcode = 1) {
  return { status: 'failed', retcode, msg: String(msg ?? 'error'), echo: echo ?? null };
}

/** OneBot v11 富媒体文件字段 → hub 的统一图片描述（只做识别，不做下载）。 */
export function describeImageSegment(seg) {
  const file = seg?.data?.file;
  const url = seg?.data?.url;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { kind: 'url', value: url };
  if (typeof file === 'string') {
    if (/^https?:\/\//i.test(file)) return { kind: 'url', value: file };
    if (file.startsWith('base64://')) return { kind: 'base64', value: file.slice('base64://'.length) };
    if (file.startsWith('file://')) return { kind: 'file', value: file.slice('file://'.length) };
  }
  return null;
}
