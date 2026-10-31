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

import { isChatHistoryCard, isRedPacket, redPacketTitle } from './protocol.js';

/**
 * QQ 表情 id → 名字。**这是 QQ 客户端自己的数据，不是 OneBot 规范**：规范只给 `face_id`。
 *
 * 来源（`m71463` 找到的权威版）：NapCat 仓库里那份 `face_config.json`
 * （`packages/napcat-core/external/face_config.json`）——直接拷自 QQNT 的
 * `emoji-resource` 资源，**329 条** `QSid → QDes`。QQ 客户端自己就是拿它把
 * `/微笑` 翻成 id 的，所以它就是"官方答案"，只是没有官方文档。
 *
 * 之前那张 121 条的表是社区抄的（2012 年那批），比对下来只有 44 条对得上：
 * 74 它写「便便」实际是「太阳」、59 它写「乒乓」实际是「便便」、79 它写「强」实际是「胜利」、
 * 76 它写「太阳」实际是「赞」。**整表按权威数据重写**（`m71542`）。
 *
 * 代价：这份表是**某个客户端版本的快照**。QQ 以后还会加表情（id 越往后越新），
 * 所以"未知就报数字"这条兜底要一直留着——宁可显示 `[表情 500]`，也别把新表情叫成旧名字。
 */
export const FACE_NAMES = {
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
  16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢', 24: '饥饿',
  25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗', 31: '咒骂', 32: '疑问',
  33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打', 39: '再见', 41: '发抖',
  42: '爱情', 43: '跳跳', 46: '猪头', 49: '拥抱', 53: '蛋糕', 55: '炸弹', 56: '刀', 59: '便便',
  60: '咖啡', 63: '玫瑰', 64: '凋谢', 66: '爱心', 67: '心碎', 74: '太阳', 75: '月亮', 76: '赞',
  77: '踩', 78: '握手', 79: '胜利', 85: '飞吻', 86: '怄火', 89: '西瓜', 96: '冷汗', 97: '擦汗',
  98: '抠鼻', 99: '鼓掌', 100: '糗大了', 101: '坏笑', 102: '左哼哼', 103: '右哼哼', 104: '哈欠', 105: '鄙视',
  106: '委屈', 107: '快哭了', 108: '阴险', 109: '左亲亲', 110: '吓', 111: '可怜', 112: '菜刀', 114: '篮球',
  116: '示爱', 118: '抱拳', 119: '勾引', 120: '拳头', 121: '差劲', 122: '爱你', 123: 'NO', 124: 'OK',
  125: '转圈', 129: '挥手', 137: '鞭炮', 144: '喝彩', 146: '爆筋', 147: '棒棒糖', 148: '喝奶', 169: '手枪',
  171: '茶', 172: '眨眼睛', 173: '泪奔', 174: '无奈', 175: '卖萌', 176: '小纠结', 177: '喷血', 178: '斜眼笑',
  179: 'doge', 180: '惊喜', 181: '戳一戳', 182: '笑哭', 183: '我最美', 185: '羊驼', 187: '幽灵', 193: '大笑',
  194: '不开心', 198: '呃', 200: '求求', 201: '点赞', 202: '无聊', 203: '托脸', 204: '吃', 206: '害怕',
  210: '飙泪', 211: '我不看', 212: '托腮', 214: '啵啵', 215: '糊脸', 216: '拍头', 217: '扯一扯', 218: '舔一舔',
  219: '蹭一蹭', 221: '顶呱呱', 222: '抱抱', 223: '暴击', 224: '开枪', 225: '撩一撩', 226: '拍桌', 227: '拍手',
  229: '干杯', 230: '嘲讽', 231: '哼', 232: '佛系', 233: '掐一掐', 235: '颤抖', 237: '偷看', 238: '扇脸',
  239: '原谅', 240: '喷脸', 241: '生日快乐', 243: '甩头', 244: '扔狗', 262: '脑阔疼', 263: '沧桑', 264: '捂脸',
  265: '辣眼睛', 266: '哦哟', 267: '头秃', 268: '问号脸', 269: '暗中观察', 270: 'emm', 271: '吃瓜', 272: '呵呵哒',
  273: '我酸了', 277: '汪汪', 278: '汗', 281: '无眼笑', 282: '敬礼', 283: '狂笑', 284: '面无表情', 285: '摸鱼',
  286: '魔鬼笑', 287: '哦', 288: '请', 289: '睁眼', 290: '敲开心', 292: '让我康康', 293: '摸锦鲤', 294: '期待',
  295: '拿到红包', 297: '拜谢', 298: '元宝', 299: '牛啊', 300: '胖三斤', 301: '好闪', 302: '左拜年', 303: '右拜年',
  305: '右亲亲', 306: '牛气冲天', 307: '喵喵', 311: '打call', 312: '变形', 314: '仔细分析', 317: '菜汪', 318: '崇拜',
  319: '比心', 320: '庆祝', 322: '拒绝', 323: '嫌弃', 324: '吃糖', 325: '惊吓', 326: '生气', 332: '举牌牌',
  333: '烟花', 334: '虎虎生威', 336: '豹富', 337: '花朵脸', 338: '我想开了', 339: '舔屏', 341: '打招呼', 342: '酸Q',
  343: '我方了', 344: '大怨种', 345: '红包多多', 346: '你真棒棒', 347: '大展宏兔', 348: '福萝卜', 349: '坚强', 350: '贴贴',
  351: '敲敲', 352: '咦', 353: '拜托', 354: '尊嘟假嘟', 355: '耶', 356: '666', 357: '裂开', 358: '骰子',
  359: '包剪锤', 360: '亲亲', 361: '狗狗笑哭', 362: '好兄弟', 363: '狗狗可怜', 364: '超级赞', 365: '狗狗生气', 366: '芒狗',
  367: '狗狗疑问', 368: '奥特笑哭', 369: '彩虹', 370: '祝贺', 371: '冒泡', 372: '气呼呼', 373: '忙', 374: '波波流泪',
  375: '超级鼓掌', 376: '跺脚', 377: '嗨', 378: '企鹅笑哭', 379: '企鹅流泪', 380: '真棒', 381: '路过', 382: 'emo',
  383: '企鹅爱心', 384: '晚安', 385: '太气了', 386: '呜呜呜', 387: '太好笑', 388: '太头疼', 389: '太赞了', 390: '太头秃',
  391: '太沧桑', 392: '龙年快乐', 393: '新年中龙', 394: '新年大龙', 395: '略略略', 396: '狼狗', 397: '抛媚眼', 398: '超级ok',
  399: 'tui', 400: '快乐', 401: '超级转圈', 402: '别说话', 403: '出去玩', 404: '闪亮登场', 405: '好运来', 406: '姐是女王',
  407: '我听听', 408: '臭美', 409: '送你花花', 410: '么么哒', 411: '一起嗨', 412: '开心', 413: '摇起来', 415: '划龙舟',
  416: '中龙舟', 417: '大龙舟', 419: '火车', 420: '中火车', 421: '大火车', 422: '粽于等到你', 423: '复兴号', 424: '续标识',
  425: '求放过', 426: '玩火', 427: '偷感', 428: '收到', 429: '蛇年快乐', 430: '蛇身', 431: '蛇尾', 432: '灵蛇献瑞',
  450: '撇嘴', 451: '色', 452: '微笑', 453: '发呆', 454: '得意', 455: '害羞', 456: '闭嘴', 457: '睡',
  458: '我吗', 459: '优雅', 460: '硬撑', 461: '宕机', 462: '无语', 463: '新年快乐', 464: '马上到', 465: '拆红包',
  466: '羞羞哒', 467: '摇花手', 468: '失眠', 469: '坚毅', 470: '马到成功', 472: '心动', 474: '给你一拳', 475: '干饭',
  476: '不是吧', 477: '你懂的', 478: '对的对的', 479: '不对不对', 480: '散味儿', 481: '学习', 482: '热化了', 483: '略',
  484: '比爱心',
};

/** 表情 id → 名字；未知 id 返回 null（调用方自己决定怎么退）。 */
export function faceName(id) {
  const key = String(id ?? '');
  return Object.prototype.hasOwnProperty.call(FACE_NAMES, key) ? FACE_NAMES[key] : null;
}

/**
 * 从 face 段的 `raw` 里取客户端给的名字（`m71541` 真机：NapCat 的 `raw.faceText` 是 `"[打call]"`）。
 *
 * 为什么优先用它：协议端已经从客户端那边拿到了答案，比我们这张表更准也更新。
 * 但它不是标准字段（LLOneBot 不给 `raw`），取不到就回落到表。
 */
export function faceTextOf(data) {
  const raw = data?.raw;
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.faceText ?? '').trim();
  if (!text) return null;
  // 客户端给的是 `/微笑` 或 `[打call]` 这种带记号的形态，剥掉只留名字。
  const bare = text.replace(/^\/+/, '').replace(/^\[(.*)\]$/, '$1').trim();
  return bare || null;
}

/**
 * 表情回应的名字表 = 表情表本体。
 *
 * 以前这里单独一张五条的表，理由是"回应用的是另一套号"——**那个判断是错的**（`m71541`）。
 * 实证：回应用到的 76 / 277 / 424 / 311 在权威 `face_config.json` 里全都能查到，
 * 而且一个是「赞」、一个是「汪汪」、一个是「续标识」、一个是「打call」，全都对得上。
 * 这两处本来就是同一套 `QSid`，以前之所以看着"打架"，是因为我们抄的那张老表本身错了
 * （它把 76 写成「太阳」）。
 *
 * 留着这个名字是为了让调用方读起来还是"表情回应"，实际查的就是同一张表。
 */
export const EMOJI_LIKE_NAMES = FACE_NAMES;

/**
 * 回应的 `emoji_id` → 可读文本。
 *
 * 三种可能：① 表里的 QQ 表情 id → 名字；② Unicode 码位（客户端直接把 emoji 的码位当 id 发，
 * 实测见过 `128077` = 👍）→ 真正的字符；③ 不认识 → 原样报数字。
 */
export function emojiLikeName(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(FACE_NAMES, key)) return FACE_NAMES[key];
  const n = Number(key);
  /**
   * 码位形态（`m71404` 真机校准出来的）：表情回应的 id **有时候就是 Unicode 码位**——
   * 用户点的那两个正好是 10068 = U+2754「❔」、12951 = U+3297「㊗️」。
   * 但另一些 id 是 QQ 自己的编号（424 = 续标识、277 = 汪汪），它们的十进制值
   * 落在拉丁字母区（0x1A8、0x115），当码位翻出来是 `ƨ`/`ŕ` 这种鬼东西。
   *
   * 所以只放行"本来就是符号/表情"的三段：通用标点与符号（0x2000-0x2BFF）、
   * CJK 符号（0x3000-0x33FF，㊗️ 在这段）、以及 emoji 主区（0x1F000-0x1FAFF，👍）。
   * 拉丁、希腊这些不可能是表情的区域一律不碰——宁可报数字。
   */
  if (Number.isInteger(n) && n >= 0x2000 && n <= 0x1faff) {
    try {
      const ch = String.fromCodePoint(n);
      // 光看区间不够：0x3000-0x33FF 里绝大多数是汉字笔画（12345 会是「〹」）。
      // 直接问 Unicode —— 这个码位到底是不是表情。
      if (!/\p{Emoji}/u.test(ch)) return null;
      // BMP 里这些符号默认是文本呈现（黑白），补一个变体选择符让它按表情画。
      return ch + (n < 0x1f000 ? '\ufe0f' : '');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 秒 → "12s" / "1分05秒"。
 *
 * **先整体取整再拆分秒**：以前是 `Math.round(n % 60)`，59.6 秒会先落进 `< 60` 分支
 * 得到"60s"，119.6 秒得到"1分60秒"——两个都是肉眼可见的错。
 */
export function durationText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n);
  if (total < 1) return '<1s';
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
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
 * @param {string} [opts.selfId] 上游账号自己的 QQ 号——@到它时改用 `selfName`
 * @param {string} [opts.selfName] agent 自己的名字（配置备注名／上游昵称）
 */
export function describeSegments(segments, opts = {}) {
  const segs = Array.isArray(segments) ? segments : typeof segments === 'string' ? [{ type: 'text', data: { text: segments } }] : [];
  const { nameOf, quoteOf, mediaRefs, descriptions, withMediaRefs = true, selfId = null, selfName = null } = opts;
  /**
   * 「还在看」（`m24484`）：识图要一两秒，而消息进窗口是即时的——正文先渲成 `[图片]` 的话，
   * 模型看到四个字就只会说"我看不到图"。带这个标记时渲成 `[图片（还在看）]`，
   * 它就知道该等（回合开始前会等一次，见 `hub.awaitVisionPending`），或者调 `onebot_image_wait`。
   */
  const describing = opts.describing === true;
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
    // @自己 → **agent 名**（`m15264`）：渲染这条的是"我"自己；把它渲成 QQ 昵称，
    // 模型看到的就是"我在叫别人"，身份在上下文里打架。所以这里显式走 agent 名。
    if (selfId !== null && selfId !== undefined && selfId !== '' && String(qq) === String(selfId)) {
      return String(selfName ?? '') || '我';
    }
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
          else if (describing) parts.push('还在看');
          out += `[${parts.join('｜')}]${tail}`;
        } else {
          const body = content ? `：${clampText(content, 200)}` : describing ? '（还在看）' : '';
          out += `[${gif ? '动图' : '图片'}${body}]${tail}`;
        }
        break;
      }
      case 'face': {
        // 顺序：客户端给的名字（`raw.faceText`）→ 表 → 数字。
        const name = faceTextOf(data) ?? faceName(data?.raw?.faceIndex ?? data.id);
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
        // 红包（`m36521`）：只有 xml 段、没有结构化对象，模型看见"一张无标题卡片"就不知道群里发了红包。
        // 认出来只为了说得出这件事——领不了，也不去伪造领取（要带号主登录态开 h5，协议层做不到）。
        if (isRedPacket(seg)) {
          const title = redPacketTitle(seg);
          out += title ? `[红包：${title}]` : '[红包]';
          break;
        }
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
      case 'poke': {
        // 以前是拼个空串再 `.replace(' ]', ']')`——替换的是**整个串里第一次出现**的那个，
        // 昵称里带 " ]" 就会先被改掉。条件拼接没有这个问题。
        const who = data.qq ? callName(data.qq) : '';
        out += who ? `[戳一戳 ${who}]` : '[戳一戳]';
        break;
      }
      case 'location': {
        const title = data.title ?? data.name ?? '';
        const lat = data.lat ?? data.latitude;
        const lon = data.lon ?? data.lng ?? data.longitude;
        // `lat = 0` 是赤道上的真实坐标，不能用真值判断（会当成"没坐标"）
        const has = lat !== undefined && lat !== null && lat !== '' && Number.isFinite(Number(lat));
        if (has) out += title ? `[位置：${title} ${lat},${lon ?? ''}]` : `[位置 ${lat},${lon ?? ''}]`;
        else out += title ? `[位置：${title}]` : '[位置]';
        break;
      }
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
    // 表情回应（`m71214` 真机 payload：`{likes:[{emoji_id:"76",count:1}], is_add:true}`）。
    // 名字只给**确认过**的那几个（`EMOJI_LIKE_NAMES`），其余报编号：经典 / 大 / 商城
    // 三套编号空间互不通，配全表迟早会读错（"爱心"读成"赞"）。
    case 'group_msg_emoji_like': {
      const likes = Array.isArray(event.likes) ? event.likes : [];
      const marks = likes
        .map((l) => {
          const raw = String(l?.emoji_id ?? '').trim() || '未知';
          const label = emojiLikeName(raw) ?? raw;
          const n = Number(l?.count);
          return Number.isFinite(n) && n > 1 ? `${label}×${n}` : label;
        })
        .join('、');
      const id = event.message_id;
      const target = id === undefined || id === null ? '一条消息' : `消息 ${id}`;
      const tail = `表情 ${marks || '（未知名）'}`;
      return event.is_add === false
        ? `${who(event.user_id)} 取消了${target} 上的${tail}`
        : `${who(event.user_id)} 给${target} 贴了${tail}`;
    }
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
  if (post === 'meta_event') {
    const kind = event?.meta_event_type ?? '';
    return kind ? `[元事件 ${kind}]` : '[元事件]';
  }
  return '';
}
