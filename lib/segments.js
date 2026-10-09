/**
 * 段结构 → 人话（§23.6）。
 *
 * 分清两件事：
 * - `protocol.js` 的 `messageToText` 是**协议层**的占位渲染（日志、CQ 兜底），够用就行；
 * - 这里做的是**给人/给模型看**的语义化：`[CQ:at,qq=10001]` 要变成"@小明"，
 *   `reply` 要带上被引内容，`json/xml` 卡片要挖出标题，语音要么给转写、要么**诚实说听不了**。
 *
 * 本模块**纯函数、同步**：不下载、不调实现端、不碰网络。异步的东西（取图、取被引消息、
 * 语音转写）由 `lib/media.js` 与 `hub` 供料，这里只负责把手里已有的事实排成句子。
 *
 * 另一条铁律：**不改动原段数组**。转发给下游的帧必须零改写，所以这里只读，
 * 任何"补充信息"都通过返回值（媒体引用表）另行传递。
 */

import { isChatHistoryCard } from './protocol.js';

/**
 * QQ 表情 id → 名字。**这是社区通行表，不是 OneBot 规范**：规范只给 `face_id`，
 * 没有名字表。取不到就退回 `[表情 id]`，不猜。
 */
export const FACE_NAMES = {
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '惊讶', 15: '难过',
  16: '酷', 17: '冷汗', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢',
  24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '大兵', 30: '奋斗',
  31: '咒骂', 32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打',
  39: '再见', 40: '擦汗', 41: '抠鼻', 42: '鼓掌', 43: '糗大了', 44: '坏笑', 45: '左哼哼',
  46: '右哼哼', 47: '哈欠', 48: '鄙视', 49: '委屈', 50: '快哭了', 51: '阴险', 52: '亲亲',
  53: '吓', 54: '可怜', 55: '菜刀', 56: '西瓜', 57: '啤酒', 58: '篮球', 59: '乒乓',
  60: '咖啡', 61: '饭', 62: '猪头', 63: '玫瑰', 64: '凋谢', 65: '示爱', 66: '爱心',
  67: '心碎', 68: '蛋糕', 69: '闪电', 70: '炸弹', 71: '刀', 72: '足球', 73: '瓢虫',
  74: '便便', 75: '月亮', 76: '太阳', 77: '礼物', 78: '拥抱', 79: '强', 80: '弱',
  81: '握手', 82: '胜利', 83: '抱拳', 84: '勾引', 85: '拳头', 86: '差劲', 87: '爱你',
  88: 'NO', 89: 'OK', 90: '爱情', 91: '飞吻', 92: '跳跳', 93: '发抖', 94: '怄火',
  95: '转圈', 96: '磕头', 97: '回头', 98: '跳绳', 99: '挥手', 100: '激动', 101: '街舞',
  102: '献吻', 103: '左太极', 104: '右太极', 105: '双喜', 106: '鞭炮', 107: '灯笼',
  108: 'K歌', 109: '喝彩', 110: '祈祷', 111: '爆筋', 112: '棒棒糖', 113: '喝奶',
  114: '下面', 115: '香蕉', 116: '飞机', 117: '开车', 118: '高铁', 119: '车厢', 120: '国旗',
};

/** 表情 id → 名字；未知 id 返回 null（调用方自己决定怎么退）。 */
export function faceName(id) {
  const key = String(id ?? '');
  return Object.prototype.hasOwnProperty.call(FACE_NAMES, key) ? FACE_NAMES[key] : null;
}

/** 秒 → "12s" / "1分05秒"。 */
export function durationText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

/** 字节 → "1.2 MB"（文件段用）。 */
export function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 单行化（压空白 + trim）。**不再按字数截断**（`m24155`：不希望再看到任何因为字数被截断的事情）——
 * 原来的 max 参数已无作用，保留形参只为不惊动调用点；长度在写入侧（vision/writer）管。
 */
function clampText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** json/xml 卡片里挖标题：OneBot 的卡片字段各家不同，取不到就不装懂。 */
function cardDigest(seg) {
  const raw = seg?.data?.data ?? seg?.data?.string ?? seg?.data?.text;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const src = raw.trim();
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      const obj = JSON.parse(src);
      const meta = obj?.meta ?? {};
      const first = Object.values(meta)[0] ?? obj;
      const title = first?.title ?? first?.detail_1?.title ?? first?.news?.title ?? first?.desc ?? obj?.prompt;
      const desc = first?.desc ?? first?.detail_1?.desc ?? obj?.desc;
      if (title) return [String(title), desc ? clampText(desc, 60) : null].filter(Boolean).join(' — ');
      if (obj?.prompt) return clampText(obj.prompt, 80);
      return null;
    } catch {
      return null; // 不是合法 JSON：宁可漏，不可编
    }
  }
  // XML：标签里挖 title/desc/summary（够用就行，不做 XML 解析器）
  const pick = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(src);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
  };
  const title = pick('title') ?? null;
  const desc = pick('desc') ?? pick('summary') ?? null;
  if (title) return [title, desc ? clampText(desc, 60) : null].filter(Boolean).join(' — ');
  return desc ? clampText(desc, 80) : null;
}

/**
 * 段数组 → 人话。
 *
 * @param {Array} segments OneBot 段数组（只读，不修改）
 * @param {object} [opts]
 * @param {(userId:string|number)=>string|null} [opts.nameOf] QQ 号 → 称呼（人物档案/群名片供料）
 * @param {(messageId:string|number)=>{actor?:string,text?:string}|null} [opts.quoteOf] 被引消息（优先 get_msg，其次 hub 自己的时间线）
 * @param {Map<number,object>|object} [opts.mediaRefs] 段下标 → 媒体引用（`lib/media.js` 落地后回填）
 * @param {Map<number,(string|{text:string|null, meme:boolean|null, emotion:string|null})>|object} [opts.descriptions] 段下标 → 看图模型给的描述/表情包判定（`lib/vision.js` 回填；旧的纯字符串也认）
 * @param {boolean} [opts.withMediaRefs] 是否把媒体引用写进文本（默认 true）
 */
export function describeSegments(segments, opts = {}) {
  const segs = Array.isArray(segments) ? segments : typeof segments === 'string' ? [{ type: 'text', data: { text: segments } }] : [];
  const { nameOf, quoteOf, mediaRefs, descriptions, withMediaRefs = true } = opts;
  const refAt = (i) => {
    if (!mediaRefs) return null;
    const ref = typeof mediaRefs.get === 'function' ? mediaRefs.get(i) : mediaRefs[i];
    return ref ?? null;
  };
  const descAt = (i) => {
    if (!descriptions) return null;
    const v = typeof descriptions.get === 'function' ? descriptions.get(i) : descriptions[i];
    if (!v) return null;
    // 旧形态是纯字符串，新形态带表情包判定——都归一成对象。
    return typeof v === 'object'
      ? { text: v.text ? String(v.text) : null, meme: v.meme ?? null, emotion: v.emotion ?? null }
      : { text: String(v), meme: null, emotion: null };
  };
  const callName = (qq) => {
    if (qq === 'all' || qq === '0' || qq === 0) return '全体成员';
    const name = typeof nameOf === 'function' ? nameOf(qq) : null;
    return name || `用户${qq}`;
  };
  let out = '';
  segs.forEach((seg, i) => {
    if (!seg || typeof seg !== 'object') return;
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        out += data.text ?? '';
        break;
      case 'at':
        out += `@${callName(data.qq ?? data.user_id)} `;
        break;
      case 'reply': {
        const id = data.id ?? data.message_id;
        const quoted = typeof quoteOf === 'function' ? quoteOf(id) : null;
        if (quoted?.text) out += `↩回复「${quoted.actor ? `${quoted.actor}：` : ''}${clampText(quoted.text, 80)}」\n`;
        else out += `↩回复了一条消息（id ${id ?? '?'}，内容不在手边）\n`;
        break;
      }
      case 'image': {
        const ref = refAt(i);
        const tail = withMediaRefs && ref?.id ? `（已存为 ${ref.id}）` : '';
        // 协议先验：`sub_type==1` 是发送端标的表情包信号（不再当"动图"用——动图看 gif）。
        const sticker = String(data.sub_type ?? data.subType ?? '0') === '1';
        const info = descAt(i);
        const gif = ref?.mediaType === 'image/gif' || /\.gif(?:$|[?#])/i.test(String(data.file ?? data.url ?? ''));
        // 判定：看图模型说它是表情包，或者协议先验标了——任一成立就按表情包渲。
        const meme = sticker || info?.meme === true;
        const content = info?.text || (data.summary ? clampText(data.summary, 40) : null);
        if (meme) {
          const parts = [];
          if (gif) parts.push('动图');
          parts.push('可能是表情包');
          if (info?.emotion) parts.push(`情感：${clampText(info.emotion, 60)}`);
          if (content) parts.push(`内容：${clampText(content, 200)}`);
          out += `[${parts.join('｜')}]${tail}`;
        } else {
          out += `[${gif ? '动图' : '图片'}${content ? `：${clampText(content, 200)}` : ''}]${tail}`;
        }
        break;
      }
      case 'face': {
        const name = faceName(data.id);
        out += name ? `[表情：${name}]` : `[表情 ${data.id ?? '?'}]`;
        break;
      }
      case 'forward': {
        // 聊天记录**不展开、不解析**（`m03065` 用户要求）：hub 只记"这里有一坨聊天记录"，
        // 原文连同索引一起留在 raw 里，需要里面的内容时由 agent 自己取（或调 get_forward_msg）。
        const nodes = Array.isArray(data.content) ? data.content : null;
        const id = data.id ?? data.forward_id ?? data.res_id;
        out += `[合并转发${nodes?.length ? ` ${nodes.length} 条` : ''}${id ? `（id ${id}）` : ''}：内容未展开]\n`;
        break;
      }
      case 'record': {
        const dur = durationText(data.duration ?? data.seconds);
        const ref = refAt(i);
        const memo = ref?.text ? `“${clampText(ref.text, 120)}”` : '（我听不了语音，别猜内容）';
        out += `[语音${dur ? ` ${dur}` : ''}]${memo}`;
        break;
      }
      case 'video': {
        const dur = durationText(data.duration ?? data.seconds);
        out += `[视频${dur ? ` ${dur}` : ''}]`;
        break;
      }
      case 'json':
      case 'xml': {
        // 聊天记录卡片（`com.tencent.multimsg`）同样是"不展开也不解析"：挖标题也算替 agent 做了解析。
        if (isChatHistoryCard(seg)) {
          out += '[聊天记录卡片：内容未展开]\n';
          break;
        }
        const digest = cardDigest(seg);
        out += digest ? `[卡片：${digest}]` : `[${seg.type === 'json' ? '卡片' : 'XML 消息'}（无标题）]`;
        break;
      }
      case 'file': {
        const size = sizeText(data.file_size ?? data.size);
        out += `[文件：${data.name ?? data.file ?? '未命名'}${size ? ` ${size}` : ''}]`;
        break;
      }
      case 'poke':
        out += `[戳一戳 ${data.qq ? callName(data.qq) : ''}]`.replace(' ]', ']');
        break;
      case 'location':
        out += `[位置：${data.title ?? data.name ?? ''}${data.lat ? ` ${data.lat},${data.lon ?? data.lng}` : ''}]`.replace('：]', ']');
        break;
      case 'music':
        out += `[音乐：${data.title ?? data.id ?? ''}]`.replace('：]', ']');
        break;
      case 'share':
        out += `[链接：${data.title ?? data.url ?? ''}]`.replace('：]', ']');
        break;
      case 'contact':
        out += `[推荐${String(data.type ?? '') === 'group' ? '群' : '联系人'}：${data.id ?? ''}]`.replace('：]', ']');
        break;
      case 'rps':
        out += '[猜拳]';
        break;
      case 'dice':
        out += '[骰子]';
        break;
      case 'shake':
        out += '[窗口抖动]';
        break;
      case 'anonymous':
        out += '[匿名消息]';
        break;
      case 'node':
        out += `[转发节点${data.name ? `：${data.name}` : ''}]`;
        break;
      default:
        out += `[${seg.type}]`;
        break;
    }
  });
  return out;
}

/** 通知类事件 → 人话（§23.6 的 `poke`/`notice` 行）。取不到字段就少说一句，不编。 */
export function describeNotice(event) {
  const t = event?.notice_type;
  const who = (id) => (id === undefined || id === null ? '某人' : `用户${id}`);
  switch (t) {
    case 'poke':
      return `${who(event.user_id)} 戳了 ${who(event.target_id)}${event.group_id ? `（群 ${event.group_id}）` : ''}`;
    case 'group_upload':
      return `${who(event.user_id)} 上传了群文件「${event.file?.name ?? '未命名'}」${sizeText(event.file?.size) ? ` (${sizeText(event.file.size)})` : ''}`;
    case 'group_admin':
      return `${who(event.user_id)} 被${event.sub_type === 'unset' ? '取消' : '设为'}管理员`;
    case 'group_decrease':
      return `${who(event.user_id)} ${event.sub_type === 'kick' ? `被 ${who(event.operator_id)} 移出群` : '退群了'}`;
    case 'group_increase':
      return `${who(event.user_id)} 加入了群`;
    case 'friend_add':
      return `${who(event.user_id)} 加了你为好友`;
    case 'group_recall':
      return `${who(event.operator_id ?? event.user_id)} 撤回了一条消息${event.message_id ? `（id ${event.message_id}）` : ''}`;
    case 'friend_recall':
      return `对方撤回了一条私聊消息${event.message_id ? `（id ${event.message_id}）` : ''}`;
    case 'group_card':
      return `${who(event.user_id)} 的群名片改成了「${event.card ?? ''}」`;
    case 'notify':
      return `${who(event.user_id)} 的${event.sub_type === 'honor' ? '群荣誉' : event.sub_type ?? '通知'}更新${event.honor_type ? `（${event.honor_type}）` : ''}`;
    case 'group_ban':
      return `${who(event.user_id)} 被${event.sub_type === 'ban' ? `禁言 ${durationText(event.duration)}` : '解除禁言'}`;
    default:
      return t ? `[通知 ${t}]` : '[通知]';
  }
}

/** 事件 → 时间线里的 `text`：消息走段语义化，其余走通知语义化。 */
export function describeEvent(event, opts = {}) {
  const post = event?.post_type;
  if (post === 'message' || post === 'message_sent') {
    return describeSegments(event?.message, opts);
  }
  if (post === 'notice' || post === 'request') return describeNotice(event);
  if (post === 'meta_event') return `[元事件 ${event?.meta_event_type ?? ''}]`.replace(' ]', ']');
  return '';
}
