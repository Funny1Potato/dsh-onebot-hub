/**
 * 表情包 / 贴纸库：收下来、存好、列出来、给路径。
 *
 * 为什么要有这个模块
 *  - 群里有人发表情包图片，bot 得能把它**收藏**起来，之后按 id 引用再发出去。
 *    原 Python 实现踩过的坑是：模型在回复里**凭空编造**一个 id（比如 `m7`），
 *    而库里根本没有这个号——发出去要么失败、要么发错图，事后还很难查。
 *    所以 `renderForPrompt()` 必须逐字写下"只能使用下面列出的 id，不要编造 id"，
 *    并且把可用 id 连同中文描述一起喂给模型：模型被允许做的是"从清单里挑一个"，
 *    不允许做"构造一个 id"。这是本模块存在的核心理由。
 *  - **为什么按 sha256 去重**：同一张表情包会被不同人反复发（转发、保存再发、换群再发）。
 *    按字节指纹去重比按文件名或消息号去重可靠得多，也避免同一张图占满容量、让模型
 *    看到十个长得一样的候选。
 *  - **为什么淘汰要保护"最近使用过的"**：表情包的价值就在"刚用过、还能再用"。
 *    如果按纯时间或纯字节淘汰，刚被用顺手的那几张会先被清掉，模型侧就会觉得
 *    "我明明记得有这张图，怎么没了"。保护最近 `recentShown` 张，牺牲冷门图，
 *    换来的是模型引用 id 的稳定性。
 *
 * 边界：本模块**不发送消息、不判段类型**，只负责"收下来、存好、列出来、给路径"；
 * CQ 段拼装与发送由 hub 侧负责。依赖只有 node 内置 + `../storage.js`。
 * 落盘关闭（`storage` 为 null 或 `dir === ''`）时是**降级**而非报错：
 * 条目照样登记在内存里、本进程内可用，只是 `file` 为空、`pathOf()` 返回 null。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** id 前缀：清单里的 id 形如 `m1`、`m2`…… */
export const MEME_ID_PREFIX = 'm';

/** 索引文件（相对 storage 根）。图片放在 `<storageDir>/memes/<id>.<ext>`。 */
const INDEX_NAME = 'memes/index.json';

/** 单条关键词最长字符数与关键词条数上限（防止模型把一整段话塞进 keywords）。 */
const MAX_KEYWORD_CHARS = 24;
const MAX_KEYWORDS = 12;

/** 合法 id 的形状。载入坏索引时靠它把歪数据挡在外面。 */
const ID_RE = new RegExp(`^${MEME_ID_PREFIX}\\d+$`);

/** mediaType → 扩展名。未知一律 `bin`（宁可后缀丑，也不要猜错格式）。 */
const EXT_BY_MEDIA = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** 取扩展名；`image/jpeg; charset=x` 这种带参数的也认。 */
function extFor(mediaType) {
  const key = String(mediaType ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MEDIA.get(key) ?? 'bin';
}

/** 常见图片格式的魔数 → mediaType。迁移导入用：见 sniffMemeImage 的注释。 */
function sniffMemeImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = bytes.toString('latin1', 0, 12);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 扩展名 → mediaType：嗅探不中时的兜底（aigf 的图片是按扩展名存的，文件名基本可信）。 */
const MEDIA_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

function memeImageByExt(name) {
  return MEDIA_BY_EXT.get(path.extname(String(name ?? '')).toLowerCase()) ?? null;
}

/** `m12` → 12；不是合法 id 返回 0。 */
function idNumber(id) {
  const m = /^m(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
}

/** 按数字大小比 id（字符串比较会让 m10 排在 m2 前面）。 */
function cmpId(a, b) {
  return idNumber(a) - idNumber(b);
}

/**
 * 关键词归一化：既接受数组，也接受顿号/逗号分隔的字符串。
 * 去空、trim、每条截断到 24 字符、去重、最多 12 条。
 * 不引入任何分词库——关键词是模型给的短标签，不需要切词。
 *
 * @param {unknown} raw 数组或字符串
 * @returns {string[]} 归一化后的关键词
 */
export function normalizeKeywords(raw) {
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(/[、,，;；|/\n\r\t]+/);
  else if (raw == null) parts = [];
  else parts = [raw];

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const word = String(part ?? '').trim().slice(0, MAX_KEYWORD_CHARS);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * 条目 → 单行中文描述，给 prompt 用：`m3（适用场景：开心、得意）一只鼓掌的猫`。
 * 没有关键词时省略括号，没有描述时只给 id。
 * 优先用 agent 写的 `brief`（prompt 只放简介），没有才退回 `description`。
 *
 * @param {{id?:string, keywords?:unknown, brief?:unknown, description?:unknown}} entry
 * @returns {string}
 */
export function describeMeme(entry) {
  const id = String(entry?.id ?? '').trim();
  if (!id) return '';
  const words = normalizeKeywords(entry?.keywords);
  const desc = String(entry?.brief || entry?.description || '').replace(/\s+/g, ' ').trim();
  // 「适用场景」标签（aigf-master 对比）：光给关键词，模型读不出"什么时候该用"；
  // 点明是场景，才是在告诉模型"遇到这个气氛就可以发"。
  const head = words.length ? `${id}（适用场景：${words.join('、')}）` : id;
  if (!desc) return head;
  // 有括号时括号自己就是分隔符（`m3（适用场景：开心、得意）一只鼓掌的猫`），没括号时空一格。
  return words.length ? `${head}${desc}` : `${head} ${desc}`;
}

/**
 * 把一条索引记录洗成合法条目；缺字段补默认值，id 非法直接丢弃（`null`）。
 * 这样"坏索引不崩"是靠**逐条降级**做到的，而不是靠 try/catch 吞掉整份文件。
 *
 * @param {unknown} row
 * @returns {object|null}
 */
function sanitizeEntry(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!ID_RE.test(id)) return null;
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    id,
    file: typeof row.file === 'string' ? row.file : '',
    mediaType: typeof row.mediaType === 'string' && row.mediaType ? row.mediaType : 'image/jpeg',
    bytes: Math.max(0, Math.floor(num(row.bytes))),
    sha256: typeof row.sha256 === 'string' && row.sha256 ? row.sha256.toLowerCase() : null,
    keywords: normalizeKeywords(row.keywords),
    brief: typeof row.brief === 'string' ? row.brief.replace(/\s+/g, ' ').trim() : '',
    description: typeof row.description === 'string' ? row.description : '',
    savedBy: typeof row.savedBy === 'string' ? row.savedBy : '',
    source: typeof row.source === 'string' ? row.source : '',
    messageId: row.messageId == null ? '' : String(row.messageId),
    createdAt: Math.max(0, Math.floor(num(row.createdAt))),
    lastUsedAt: row.lastUsedAt == null ? null : Math.max(0, Math.floor(num(row.lastUsedAt))),
    uses: Math.max(0, Math.floor(num(row.uses))),
  };
}

/**
 * 表情包库。
 *
 * 条目形状（`entries[i]`，也是 `collect()` 的返回值 / `list()` 的元素）：
 * ```js
 * {
 *   id: 'm3',              // 唯一引用，形如 m<数字>，单调递增
 *   file: 'memes/m3.jpg',  // 相对 storage 根的路径；落盘关闭时是 ''
 *   mediaType: 'image/jpeg',
 *   bytes: 12345,          // 字节数
 *   sha256: 'ab12…',       // 字节指纹，去重依据
 *   keywords: ['开心'],    // 归一化后的关键词
 *   brief: '一只鼓掌的猫',  // agent 写的一行简介（进 prompt 的就是它）
 *   description: '',       // 完整描述（不进 prompt，agent 用 get 查看）
 *   savedBy: 'agent',      // 谁收的；老条目（自动收集时代）没有这个字段，载入即清
 *   source: 'group:12345', // 从哪来（会话键之类，由调用方决定）
 *   messageId: '67890',    // 原始消息 id，便于回溯
 *   createdAt: 1700000000000,
 *   lastUsedAt: null,      // 从未用过是 null；用过就是 now()
 *   uses: 0,
 * }
 * ```
 */
export class MemeStore {
  /** @type {Map<string, object>} */
  #entries = new Map();
  /** 已分配到的最大 id 数字；由索引里的 `seq` 保证跨进程单调递增。 */
  #seq = 0;

  /**
   * @param {object} [opts]
   * @param {{dir?:string, enabled?:boolean, read?:Function, write?:Function, path?:Function}|null} [opts.storage]
   *   `JsonStore` 实例；`null` 或不 enabled = 关闭落盘（降级：条目只在内存里）。
   * @param {(msg:string)=>void} [opts.log] 日志；默认吞掉。
   * @param {number} [opts.maxCount] 容量上限，默认 200。
   * @param {number} [opts.recentShown] 最近使用过、必须出现在 prompt 清单里、且淘汰时受保护的条数，默认 5。
   * @param {() => number} [opts.now] 时间源（测试注入，保证确定性）；默认 `Date.now`。
   */
  constructor({ storage = null, log = () => {}, maxCount = 200, recentShown = 5, now = Date.now } = {}) {
    this.storage = storage ?? null;
    this.log = typeof log === 'function' ? log : () => {};
    this.maxCount = Math.max(1, Math.floor(Number(maxCount) || 200));
    this.recentShown = Math.max(0, Math.floor(Number(recentShown) || 0));
    this.now = typeof now === 'function' ? now : Date.now;
    /** 仅做诊断用：null 表示不吞异常，直接打给日志。 */
    this.load();
  }

  /** 落盘是否真的可用（`storage` 存在且 `dir` 非空）。 */
  get enabled() {
    return !!(this.storage && this.storage.enabled);
  }

  /**
   * 从 `memes/index.json` 载入。可重复调用（会重置内存状态）。
   * 坏记录逐条丢弃，不会让一次坏索引废掉整个库。
   * @returns {this}
   */
  load() {
    this.#entries = new Map();
    this.#seq = 0;
    const raw = this.storage ? this.storage.read(INDEX_NAME, null) : null;
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    const seqTop = Number.isFinite(Number(raw?.seq)) ? Math.max(0, Math.floor(Number(raw.seq))) : 0;
    let seq = seqTop;
    let purged = 0;
    for (const row of rows) {
      const entry = sanitizeEntry(row);
      // 老条目清空重来：改造前的库没有 savedBy（自动收集的产物），整条丢掉、
      // 连图片文件一起删，但 id 数字照算——seq 继续单调，新 id 不会撞旧号。
      if (entry && !entry.savedBy) {
        seq = Math.max(seq, idNumber(entry.id));
        purged += 1;
        const abs = this.#absOf(entry.file);
        if (abs) {
          try {
            fs.rmSync(abs, { force: true });
          } catch (err) {
            this.log(`[memes] 清理老条目文件 ${entry.file} 失败：${err.message}`);
          }
        }
        continue;
      }
      if (!entry || this.#entries.has(entry.id)) continue;
      this.#entries.set(entry.id, entry);
      seq = Math.max(seq, idNumber(entry.id));
    }
    this.#seq = seq;
    if (purged) {
      this.log(`[memes] 清掉 ${purged} 条改造前的老条目（图片文件已删，id 不复用）`);
      this.#persist();
    }
    return this;
  }

  /** 全部条目，按 id 数字升序（`m2` 在 `m10` 前面）。 */
  list() {
    return [...this.#entries.values()].sort((a, b) => cmpId(a.id, b.id));
  }

  /** 取一个条目，没有返回 null。 */
  get(id) {
    return this.#entries.get(this.#key(id)) ?? null;
  }

  /** id 是否存在。 */
  has(id) {
    return this.#entries.has(this.#key(id));
  }

  /**
   * 收藏一张表情包：字节写到 `<storageDir>/memes/<id>.<ext>`，登记条目并落盘索引。
   *
   * `sha256` 已经收藏过时**不重复收藏**，直接返回已有条目：同一张图被反复发是常态，
   * 重复登记只会让模型看到一堆一模一样的候选、并且白占容量。
   *
   * @param {object} input
   * @param {Buffer|Uint8Array} input.bytes 图片字节（必填）
   * @param {string} [input.mediaType] 默认 `image/jpeg`
   * @param {string|null} [input.sha256] 不给就用 `node:crypto` 算
   * @param {unknown} [input.keywords] 数组或顿号/逗号分隔字符串
   * @param {string} [input.brief] agent 写的一行简介（进 prompt）
   * @param {string} [input.description] 完整描述（不进 prompt）
   * @param {string} [input.savedBy] 谁收的，默认 `agent`
   * @param {string} [input.source]
   * @param {string} [input.messageId]
   * @returns {Promise<object>} 条目（新建的，或去重命中的已有条目）
   */
  async collect({
    bytes,
    mediaType = 'image/jpeg',
    sha256 = null,
    keywords = [],
    brief = '',
    description = '',
    savedBy = 'agent',
    source = '',
    messageId = '',
  } = {}) {
    if (bytes == null) throw new TypeError('collect 需要 bytes（图片字节）');
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const media = String(mediaType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    const hash = sha256
      ? String(sha256).trim().toLowerCase()
      : crypto.createHash('sha256').update(buf).digest('hex');

    const dup = this.#findBySha(hash);
    if (dup) return dup;

    const id = `${MEME_ID_PREFIX}${(this.#seq += 1)}`;
    const rel = `memes/${id}.${extFor(media)}`;
    const entry = {
      id,
      file: '',
      mediaType: media,
      bytes: buf.length,
      sha256: hash,
      keywords: normalizeKeywords(keywords),
      brief: String(brief ?? '').replace(/\s+/g, ' ').trim(),
      description: String(description ?? ''),
      savedBy: String(savedBy ?? 'agent'),
      source: String(source ?? ''),
      messageId: messageId == null ? '' : String(messageId),
      createdAt: Math.floor(this.now()),
      lastUsedAt: null,
      uses: 0,
    };
    this.#entries.set(id, entry);

    const abs = this.#absOf(rel);
    if (abs) {
      try {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
        entry.file = rel;
      } catch (err) {
        // 写不了磁盘也照样返回条目：本进程内还能用，只是 pathOf 给不出路径。
        this.log(`[memes] 写 ${rel} 失败：${err.message}（条目仅存在于内存）`);
      }
    }
    // abs 为 null = 落盘关闭：条目仍然登记（降级），file 保持 ''。

    this.#persist();
    this.#trim();
    return entry;
  }

  /**
   * 从 aigf-master（nonebot-plugin-aigf-master）的数据目录一次性迁移表情包。
   *
   * 为什么不走 `collect()` 逐条收：aigf 的元数据带着 `usage_count` 与 `saved_at`，
   * collect 会把它们抹成 0 与 now——迁移要保真（usage 决定清单排序与淘汰次序）；
   * 且上百条逐条 collect 会逐条落盘。这里是**一次读、批量收、一次落盘**。
   *
   * 数据形状（勘察于实际数据）：`<dir>/memes.json` 是管理员收录
   * `{id, path, keywords, description}`，`<dir>/collected.json` 是自动收集
   * `{…同上, usage_count, saved_at(epoch 秒 float)}`，`path` 是相对 `<dir>` 的裸文件名。
   * 收编次序：管理员收录优先，自动收集按 usage_count 降序——容量不够时先保住人工挑的那批。
   *
   * 映射：description → brief + description（aigf 的描述就是一句话简介，正好两用）；
   * keywords 原样；usage_count → uses；saved_at → createdAt；lastUsedAt 置 null
   * （迁移过来的"用过"不是这个 bot 用过的，不能算进保护池）；savedBy='import:aigf-master'
   * （载入侧凭 savedBy 非空认正身，source 同值留迁移来源，aigf 侧 id 存进 messageId 便于回溯）。
   * 去重：sha256 批内互查 + 对已有库（#findBySha）。媒体类型：魔数嗅探优先、扩展名兜底，
   * 两个都认不出就跳过——宁可少收一张，不收一张说谎类型的图。
   * 容量是硬约束：装不下的**不淘汰现有条目**，如实计入 skippedOverCap。
   *
   * @param {string} dir aigf-master 的 memes 数据目录（含 memes.json / collected.json 与图片）
   * @returns {Promise<object>} 汇总 {dir, candidates, imported, adminImported, collectedImported,
   *   skippedDuplicate, skippedMissing, skippedUnreadable, skippedOverCap, ids}
   */
  async importAigf(dir) {
    const root = String(dir ?? '').trim();
    if (!root) throw new TypeError('importAigf 需要 aigf-master 的 memes 数据目录');
    const readRows = async (name) => {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(root, name), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        if (err?.code === 'ENOENT') return []; // 两份元数据都可选：只拿得到其中一份也能迁
        throw err;
      }
    };
    const byUsage = (a, b) =>
      (Number(b?.usage_count) || 0) - (Number(a?.usage_count) || 0) ||
      (Number(b?.saved_at) || 0) - (Number(a?.saved_at) || 0);
    const admin = (await readRows('memes.json')).map((row) => ({ ...row, isAdmin: true }));
    const collected = (await readRows('collected.json')).sort(byUsage);

    const summary = {
      dir: root,
      candidates: admin.length + collected.length,
      imported: 0,
      adminImported: 0,
      collectedImported: 0,
      skippedDuplicate: 0,
      skippedMissing: 0,
      skippedUnreadable: 0,
      skippedOverCap: 0,
      ids: [],
    };
    const seenSha = new Set();
    for (const row of [...admin, ...collected]) {
      if (this.#entries.size >= this.maxCount) {
        summary.skippedOverCap += 1;
        continue;
      }
      let bytes;
      try {
        bytes = await fsp.readFile(path.join(root, String(row?.path ?? '')));
      } catch {
        summary.skippedMissing += 1;
        continue;
      }
      const mediaType = sniffMemeImage(bytes) ?? memeImageByExt(row?.path);
      if (!mediaType) {
        summary.skippedUnreadable += 1;
        continue;
      }
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (this.#findBySha(hash) || seenSha.has(hash)) {
        summary.skippedDuplicate += 1;
        continue;
      }
      seenSha.add(hash);

      const id = `${MEME_ID_PREFIX}${(this.#seq += 1)}`;
      const rel = `memes/${id}.${extFor(mediaType)}`;
      const savedAt = Number(row?.saved_at);
      const entry = {
        id,
        file: '',
        mediaType,
        bytes: bytes.length,
        sha256: hash,
        keywords: normalizeKeywords(row?.keywords),
        brief: String(row?.description ?? '').replace(/\s+/g, ' ').trim(),
        description: String(row?.description ?? ''),
        savedBy: 'import:aigf-master',
        source: 'aigf-master',
        messageId: row?.id == null ? '' : String(row.id),
        createdAt:
          Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt * 1000) : Math.floor(this.now()),
        lastUsedAt: null,
        uses: Math.max(0, Math.floor(Number(row?.usage_count) || 0)),
      };
      this.#entries.set(id, entry);

      const abs = this.#absOf(rel);
      if (abs) {
        try {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, bytes);
          entry.file = rel;
        } catch (err) {
          // 与 collect 同一降级：写不了磁盘条目照样登记，本进程内可用、pathOf 给不出路径。
          this.log(`[memes] 写 ${rel} 失败：${err.message}（条目仅存在于内存）`);
        }
      }

      summary.imported += 1;
      summary.ids.push(id);
      if (row.isAdmin) summary.adminImported += 1;
      else summary.collectedImported += 1;
    }
    if (summary.imported) this.#persist();
    return summary;
  }

  /**
   * 按关键词子串给候选打分（**不做分词**，只比子串），命中多的排前面。
   * 同分时用"用得多 → 刚用过 → id 小"兜底，保证顺序确定。
   *
   * @param {string} text 模型/用户说的话
   * @param {{limit?:number}} [opts]
   * @returns {object[]} 条目数组，最多 `limit` 个
   */
  matchByKeywords(text, { limit = 8 } = {}) {
    const q = String(text ?? '').toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const entry of this.#entries.values()) {
      let score = 0;
      for (const word of entry.keywords) {
        if (word && q.includes(word.toLowerCase())) score += 2 + Math.min(word.length, 6);
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.uses - a.entry.uses ||
        (b.entry.lastUsedAt ?? 0) - (a.entry.lastUsedAt ?? 0) ||
        cmpId(a.entry.id, b.entry.id),
    );
    const cap = Math.max(0, Math.floor(Number(limit) || 0));
    return scored.slice(0, cap).map((row) => row.entry);
  }

  /**
   * 记一次使用：`uses+1`、`lastUsedAt=now()`，并落盘。
   * @param {string} id
   * @returns {boolean} 条目不存在返回 false
   */
  noteUse(id) {
    const entry = this.get(id);
    if (!entry) return false;
    entry.uses += 1;
    entry.lastUsedAt = Math.floor(this.now());
    this.#persist();
    return true;
  }

  /**
   * 渲染给 prompt 的中文文本块。
   *
   * 两条硬约束：
   *  1. 逐字写出"只能使用下面列出的 id，不要编造 id"——原实现就是在这里栽的；
   *  2. 最近使用过的 `recentShown` 个（按 `lastUsedAt` 倒序）**必须**在清单里，
   *     即使它们不在 `limit` 个高频项里（所以清单总行数最多是 `limit + recentShown`）。
   *
   * @param {{limit?:number}} [opts] 高频项条数，默认 8
   * @returns {string}
   */
  renderForPrompt({ limit = 8 } = {}) {
    const total = this.#entries.size;
    if (total === 0) {
      return '（还没有收藏表情包：看到值得反复用的表情图就 onebot_memes{action:"add"} 收录，brief 由你写；当前没有任何可用 id，不要编造 id）';
    }
    const recent = this.#recent(this.recentShown);
    const recentIds = new Set(recent.map((entry) => entry.id));
    const cap = Math.max(0, Math.floor(Number(limit) || 0));
    const popular = [...this.#entries.values()]
      .filter((entry) => !recentIds.has(entry.id))
      .sort(
        (a, b) =>
          b.uses - a.uses ||
          (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
          cmpId(a.id, b.id),
      )
      .slice(0, cap);

    const picked = [...recent, ...popular];
    const lines = picked.map((entry) => `- ${describeMeme(entry)}`);
    return [
      // aigf-master 对比（用户 2026-10-11 定）：标题点明"用于发送"的用途 + 一句正向引导。
      // 光有"不要编造 id"这类禁令，模型会把清单当约束读，不会主动用——积极性问题出在语言取向。
      `表情包库（用于发送，共 ${total} 个；只能使用下面列出的 id，不要编造 id；发送时用 {"type":"meme","id":"m1"} 这样的段引用；气氛合适就发一个，别让库白攒着）：`,
      ...lines,
    ].join('\n');
  }

  /**
   * 删掉一个条目，连磁盘文件一起删（文件删不掉只记日志，条目该没还是没）。
   * @param {string} id
   * @returns {boolean} 条目不存在返回 false
   */
  remove(id) {
    const key = this.#key(id);
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#persist();
    const abs = this.#absOf(entry.file);
    if (abs) {
      try {
        fs.rmSync(abs, { force: true });
      } catch (err) {
        this.log(`[memes] 删 ${entry.file} 失败：${err.message}`);
      }
    }
    return true;
  }

  /**
   * 改一个条目的元数据（简介/关键词/描述）——**只改元数据，不动图片字节与 id**。
   *
   * 存在的理由：表情包是"群友发过的一张图"，人（或模型）事后给它起名字这件事
   * 只能发生在看过它之后。改完立刻落盘，否则重启就白标了。
   * @param {string} id
   * @param {{keywords?:string[]|string, brief?:string, description?:string}} patch
   * @returns {object|null} 更新后的条目；没有这个 id 时返回 null
   */
  update(id, patch = {}) {
    const key = this.#key(id);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (patch.keywords !== undefined) entry.keywords = normalizeKeywords(patch.keywords);
    if (patch.brief !== undefined) entry.brief = String(patch.brief ?? '').replace(/\s+/g, ' ').trim();
    if (patch.description !== undefined) entry.description = String(patch.description ?? '');
    this.#persist();
    return { ...entry, keywords: [...entry.keywords] };
  }

  /**
   * 条目的本地绝对路径；没有这个条目、`file` 为空（落盘关闭）、或落盘不可用时返回 null。
   * @param {string} id
   * @returns {string|null}
   */
  pathOf(id) {
    const entry = this.get(id);
    if (!entry || !entry.file) return null;
    return this.#absOf(entry.file);
  }

  /**
   * 超容量时淘汰：先按「最少使用 → 最久未用 → 建得早 → id 小」挑，淘汰到 `maxCount` 为止。
   *
   * **永远不淘汰最近 `recentShown` 个"用过"的条目**（没有用过的条目不算"最近使用"，
   * 否则新库里一次收满就会集体免疫，容量约束永远兑现不了）。极端情况下——
   * 全库都是最近用过的——保护会让位给容量：先把非保护项淘汰干净，
   * 还不够就从保护项里挑最旧的那个继续淘汰，宁可丢冷门也不让库无限长。
   *
   * @returns {string[]} 被删掉的 id
   */
  rotate() {
    const removed = [];
    let over = this.#entries.size - this.maxCount;
    if (over <= 0) return removed;

    const protectedIds = new Set(this.#recent(this.recentShown).map((entry) => entry.id));
    const rank = (a, b) =>
      a.uses - b.uses ||
      (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) ||
      a.createdAt - b.createdAt ||
      cmpId(a.id, b.id);

    const all = [...this.#entries.values()];
    const order = [...all.filter((entry) => !protectedIds.has(entry.id)).sort(rank), ...all.filter((entry) => protectedIds.has(entry.id)).sort(rank)];

    for (const entry of order) {
      if (over <= 0) break;
      removed.push(entry.id);
      this.remove(entry.id);
      over -= 1;
    }
    return removed;
  }

  /**
   * 概况。
   * @returns {{enabled:boolean, count:number, capacity:number, bytes:number, hits:number, lastAt:number|null}}
   *   `enabled` 落盘是否可用；`count` 条目数；`capacity` 容量上限；`bytes` 图片总字节；
   *   `hits` 累计使用次数（`uses` 之和）；`lastAt` 最近一次使用时间，从没用过是 null。
   */
  get stats() {
    let bytes = 0;
    let hits = 0;
    let lastAt = null;
    for (const entry of this.#entries.values()) {
      bytes += entry.bytes;
      hits += entry.uses;
      if (entry.lastUsedAt != null && (lastAt == null || entry.lastUsedAt > lastAt)) lastAt = entry.lastUsedAt;
    }
    return {
      enabled: this.enabled,
      count: this.#entries.size,
      capacity: this.maxCount,
      bytes,
      hits,
      lastAt,
    };
  }

  /** 只读快照（深拷贝，改它不会影响库）。 */
  snapshot() {
    return {
      seq: this.#seq,
      maxCount: this.maxCount,
      recentShown: this.recentShown,
      enabled: this.enabled,
      entries: this.list().map((entry) => ({ ...entry, keywords: [...entry.keywords] })),
    };
  }

  // ---- 内部 -------------------------------------------------------------------

  /** id 归一化：容忍 `m3` / `#m3` / `3` 三种写法（模型偶尔会漏前缀）。 */
  #key(raw) {
    const text = String(raw ?? '').trim().replace(/^#/, '');
    if (!text) return '';
    return /^\d+$/.test(text) ? `${MEME_ID_PREFIX}${text}` : text;
  }

  /** 相对路径 → 绝对路径；落盘关闭返回 null。 */
  #absOf(rel) {
    if (!rel) return null;
    if (!this.enabled) return null;
    return this.storage.path(rel);
  }

  /** 按字节指纹找已有条目（同一张图只收一次）。 */
  #findBySha(hash) {
    if (!hash) return null;
    for (const entry of this.#entries.values()) {
      if (entry.sha256 === hash) return entry;
    }
    return null;
  }

  /** 最近使用过的条目，按 `lastUsedAt` 倒序，最多 n 个。 */
  #recent(n) {
    if (!n) return [];
    return [...this.#entries.values()]
      .filter((entry) => entry.lastUsedAt != null)
      .sort(
        (a, b) =>
          b.lastUsedAt - a.lastUsedAt ||
          b.uses - a.uses ||
          cmpId(a.id, b.id),
      )
      .slice(0, n);
  }

  /** 落盘索引；`storage` 为 null 或关闭时静默 no-op（这也是 collect 的降级路径）。 */
  #persist() {
    if (!this.storage || typeof this.storage.write !== 'function') return false;
    return this.storage.write(INDEX_NAME, {
      version: 1,
      seq: this.#seq,
      entries: this.list().map((entry) => ({ ...entry, keywords: [...entry.keywords] })),
    });
  }

  /** 超过容量就自动整理（容量是硬约束，不指望调用方记得手动 rotate）。 */
  #trim() {
    if (this.#entries.size > this.maxCount) this.rotate();
  }
}
