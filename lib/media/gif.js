/**
 * GIF 解析 + 关键帧抽取 + 横向 sprite sheet（纯 JS，无依赖）。
 *
 * 为什么要有这个模块：上游用户发来的动图，视觉模型看不懂——它只看得到一帧（甚至看不到）。
 * master 版插件用 Pillow+numpy 做"GIF 解码 → 按帧间差异挑关键帧 → 横向拼一张长图"，
 * 这里要在没有图像库的纯 JS 环境里复刻同一件事，最后交给 png.js 落成静态 PNG。
 *
 * 三处最容易踩坑的地方，实现时按这个优先级取舍：
 *
 *  1. **disposal 语义**。GIF 的"处置方式"是**画完当前帧之后**才生效的，不是画之前。
 *     0/1 = 保留画布（下一帧叠上去，这是动图之所以能"动一点"的原因）；
 *     2 = 把当前帧矩形还原成背景色（OneBot 场景里一律当透明，见 applyDisposal 的注释）；
 *     3 = 还原成"画这一帧之前"的样子——所以必须在画之前整块快照，事后仅凭当前画布无法反推。
 *     每次输出的是**合成后的整块逻辑屏幕**，不是帧自己的小矩形；否则关键帧比对会因为
 *     尺寸/偏移不同而失真。
 *
 *  2. **LZW 码长增长**。字典每到 2^codeSize 就长一位，且 KwKwK（码号等于"下一个待分配号"）
 *     那个分支必须特判，否则遇到稍微复杂一点的图就解出花屏。字典用 前缀+末字节+首字节
 *     三个定长数组表示，不存整段字节，避免大动图下的内存/拷贝开销。
 *
 *  3. **MSE 阈值只在 RGB 上算**。master 的 1000 是在 3 通道上定的；本模块的帧带 alpha，
 *     若把每像素恒为 255 的 alpha 也算进分母，同一个阈值会悄悄变得更敏感（多抽帧、长图变胖）。
 *
 * 本模块不 import 任何宿主包，不联网、不读环境变量、不用随机数。
 */

const MAX_LZW_CODE = 4096;
const MAX_PALETTE = 256;

/** 只接受字节序列，坏输入要在这里就炸，不要拖到后面变成"空帧"这种沉默失败。 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('期望 Buffer / Uint8Array 字节序列');
}

const latin1 = (bytes, start, end) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
const readU16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

/** 读一张色表（size*3 字节）成 [r,g,b] 数组。 */
function readColorTable(bytes, offset, size) {
  if (offset + size * 3 > bytes.length) throw new Error('GIF 色表越界');
  const table = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const o = offset + i * 3;
    table[i] = [bytes[o], bytes[o + 1], bytes[o + 2]];
  }
  return table;
}

/** 读"数据子块"链（每块 长度+数据，直到长度为 0），返回拼好的字节与下一个块的位置。 */
function readSubBlocks(bytes, offset) {
  const parts = [];
  let off = offset;
  let total = 0;
  while (true) {
    if (off >= bytes.length) throw new Error('GIF 数据子块在读长度时越界');
    const len = bytes[off];
    off += 1;
    if (len === 0) break;
    if (off + len > bytes.length) throw new Error('GIF 数据子块越界');
    parts.push(Buffer.from(bytes.subarray(off, off + len)));
    total += len;
    off += len;
  }
  return { bytes: Buffer.concat(parts, total), next: off };
}

/**
 * 交错（interlace）帧的存储行 → 显示行映射。
 * 四个 pass 依次是 0/8、4/8、2/4、1/2；存储里的第 i 行其实是显示图的 rows[i] 行。
 * 不处理它的话，交错 GIF 会解成锯齿条带——这类图在真人发的表情包里相当常见。
 */
function interlaceRows(height) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

/**
 * GIF LZW 解码。用"前缀码 + 末字节 + 首字节"三张定长表表示字典，
 * 输出长度必须恰好等于帧的像素数，否则按坏数据抛错。
 */
function lzwDecode(src, minCodeSize, expected) {
  if (minCodeSize < 2 || minCodeSize > 11) {
    throw new Error(`GIF LZW 最小码长非法：${minCodeSize}`);
  }
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const prefix = new Int16Array(MAX_LZW_CODE);
  const suffix = new Uint8Array(MAX_LZW_CODE);
  const firstByte = new Uint8Array(MAX_LZW_CODE);

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let prev = -1;

  const resetDictionary = () => {
    for (let i = 0; i < clearCode; i += 1) {
      prefix[i] = -1;
      suffix[i] = i;
      firstByte[i] = i;
    }
    next = endCode + 1;
    codeSize = minCodeSize + 1;
    prev = -1;
  };
  resetDictionary();

  const out = new Uint8Array(expected);
  let outLen = 0;
  const stack = new Uint8Array(MAX_LZW_CODE);

  // 把某个码对应的整串字节倒出来。字典是"前缀链"结构，所以沿链压栈再反序写出。
  const emitCode = (code) => {
    let sp = 0;
    let c = code;
    while (c >= 0 && sp < stack.length) {
      stack[sp] = suffix[c];
      sp += 1;
      c = prefix[c];
    }
    while (sp > 0) {
      sp -= 1;
      if (outLen < out.length) {
        out[outLen] = stack[sp];
        outLen += 1;
      }
    }
  };

  let pos = 0;
  let acc = 0;
  let bits = 0;
  let truncated = false;

  while (outLen < out.length) {
    while (bits < codeSize) {
      if (pos >= src.length) {
        truncated = true;
        break;
      }
      acc |= src[pos] << bits;
      pos += 1;
      bits += 8;
    }
    if (truncated) break;

    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;

    if (code === clearCode) {
      resetDictionary();
      continue;
    }
    if (code === endCode) break;

    if (prev === -1) {
      // 清字典后的第一个码只输出、不建条目——建了就会把字典整体错位一格。
      emitCode(code);
      prev = code;
      continue;
    }

    if (code > next) throw new Error('GIF LZW 码流非法：码号出现跳跃');

    if (code === next) {
      // KwKwK：编码端用了"字典里刚好多出一个"的码号。它对应的串就是
      // prev 串 + prev 串的首字节；而这一条同时**正是**接下来要登记的新条目，
      // 所以此处只登记一次、直接输出它，不要再走下面那条常规登记（会多出一条、字典错位）。
      if (next >= MAX_LZW_CODE) throw new Error('GIF LZW 字典越界');
      prefix[next] = prev;
      suffix[next] = firstByte[prev];
      firstByte[next] = firstByte[prev];
      emitCode(next);
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      prev = code;
      continue;
    }

    emitCode(code);

    // 常规路径：每输出一个码，就把"prev 串 + 当前串首字节"登记进字典。
    if (next < MAX_LZW_CODE) {
      prefix[next] = prev;
      suffix[next] = firstByte[code];
      firstByte[next] = firstByte[prev];
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }

  if (outLen !== expected) {
    const why = truncated ? '数据提前结束' : '结束码来得太早';
    throw new Error(`GIF LZW 只解出 ${outLen}/${expected} 像素（${why}）`);
  }
  return out;
}

/** 把一帧（可带偏移/交错）画到合成画布上；透明索引等于"这一步不画"，露出下面的层。 */
function drawFrame(canvas, canvasW, canvasH, pixels, frameW, frameH, left, top, interlaced, table, gce) {
  const rows = interlaced ? interlaceRows(frameH) : null;
  for (let sy = 0; sy < frameH; sy += 1) {
    const dy = top + (rows ? rows[sy] : sy);
    if (dy < 0 || dy >= canvasH) continue;
    for (let sx = 0; sx < frameW; sx += 1) {
      const dx = left + sx;
      if (dx < 0 || dx >= canvasW) continue;
      const index = pixels[sy * frameW + sx];
      if (gce.transparent && index === gce.transparentIndex) continue;
      const rgb = table[index];
      // 索引越界（比色表大）在真实动图里偶有见到，按透明处理，
      // 不为了一个脏像素把整张图判成坏数据。
      if (!rgb) continue;
      const o = (dy * canvasW + dx) * 4;
      canvas[o] = rgb[0];
      canvas[o + 1] = rgb[1];
      canvas[o + 2] = rgb[2];
      canvas[o + 3] = 255;
    }
  }
}

/** 画完当前帧后按 disposal 收拾画布：0/1 什么都不做，2 抹透明，3 用快照回滚当前矩形。 */
function applyDisposal(canvas, canvasW, canvasH, left, top, frameW, frameH, disposal, snapshot) {
  if (disposal === 2) {
    // "还原成背景色"。逻辑屏幕里的背景色索引在真实 GIF 里几乎没人填对，
    // 而我们要的是给视觉模型看的长图：填黑会糊出一片黑框，所以一律当透明。
    for (let y = top; y < top + frameH; y += 1) {
      if (y < 0 || y >= canvasH) continue;
      for (let x = left; x < left + frameW; x += 1) {
        if (x < 0 || x >= canvasW) continue;
        const o = (y * canvasW + x) * 4;
        canvas[o] = 0;
        canvas[o + 1] = 0;
        canvas[o + 2] = 0;
        canvas[o + 3] = 0;
      }
    }
    return;
  }
  if (disposal === 3) {
    if (!snapshot) return;
    for (let y = top; y < top + frameH; y += 1) {
      if (y < 0 || y >= canvasH) continue;
      for (let x = left; x < left + frameW; x += 1) {
        if (x < 0 || x >= canvasW) continue;
        const o = (y * canvasW + x) * 4;
        canvas[o] = snapshot[o];
        canvas[o + 1] = snapshot[o + 1];
        canvas[o + 2] = snapshot[o + 2];
        canvas[o + 3] = snapshot[o + 3];
      }
    }
  }
  // 0 / 1：保留上一帧画布，什么都不做。
}

/**
 * 解析 GIF（87a/89a）成合成后的 RGBA 帧序列。
 * @param {Buffer|Uint8Array} bytes GIF 文件字节
 * @returns {{width:number,height:number,frames:Array<{rgba:Uint8Array,width:number,height:number,delayMs:number,disposal:number}>,loopCount:number}}
 *   每帧的 `rgba` 是**合成后的整块逻辑屏幕**（宽高与最外层一致）；`width`/`height` 是画布尺寸，
 *   缩放到 sprite sheet 时要用；`delayMs` 已由 GIF 的 1/100 秒换算成毫秒。
 * @throws {Error} 签名、块结构、LZW 数据有问题，或一帧都没有
 */
export function parseGif(bytes) {
  const b = toBytes(bytes);
  // 先看签名再看长度：随手丢进来的文本（"not a gif" 这类）多数够 6 字节但不够 13 字节，
  // 先报"不是 GIF"比先报"太短"更接近调用方真正的问题。
  if (b.length < 6) throw new Error('GIF 太短：连文件签名都不够');
  const signature = latin1(b, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new Error(`不是 GIF：签名为 ${JSON.stringify(signature)}`);
  }
  if (b.length < 13) throw new Error('GIF 太短：缺少逻辑屏幕描述符');

  const width = readU16(b, 6);
  const height = readU16(b, 8);
  if (width <= 0 || height <= 0) throw new Error(`GIF 逻辑屏幕尺寸非法：${width}x${height}`);
  const packed = b[10];
  let off = 13;

  let globalTable = null;
  if ((packed & 0x80) !== 0) {
    const size = 1 << ((packed & 0x07) + 1);
    globalTable = readColorTable(b, off, size);
    off += size * 3;
  }

  const canvas = new Uint8Array(width * height * 4); // 起始全透明
  const frames = [];
  let loopCount = 0;
  let pendingGce = null;

  while (off < b.length) {
    const marker = b[off];

    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      // 扩展块。图形控制扩展（0xF9）要挂起来给下一个图像用，其余按子块跳过。
      if (off + 2 >= b.length) throw new Error('GIF 扩展块越界');
      const label = b[off + 1];
      if (label === 0xf9) {
        const size = b[off + 2];
        if (size < 4 || off + 3 + size >= b.length) throw new Error('GIF 图形控制扩展长度非法');
        const gp = b[off + 3];
        const delay = readU16(b, off + 4);
        const transparentIndex = b[off + 6];
        pendingGce = {
          disposal: (gp >> 2) & 0x07,
          transparent: (gp & 0x01) === 1,
          transparentIndex,
          delayMs: delay * 10, // GIF 的单位是 1/100 秒
        };
        off += 3 + size; // 0x21 0xF9 size + size 字节
        if (b[off] !== 0) throw new Error('GIF 图形控制扩展缺少终止符');
        off += 1;
      } else if (label === 0xff) {
        const size = b[off + 2];
        const app = latin1(b, off + 3, off + 3 + size);
        off += 3 + size;
        while (off < b.length && b[off] !== 0) {
          const len = b[off];
          if (off + 1 + len > b.length) throw new Error('GIF 应用扩展子块越界');
          if (app.startsWith('NETSCAPE')) {
            const sub = b.subarray(off + 1, off + 1 + len);
            // NETSCAPE2.0 的循环块：01 + 小端 loop count
            if (sub[0] === 1 && len >= 3) loopCount = sub[1] | (sub[2] << 8);
          }
          off += 1 + len;
        }
        if (off >= b.length) throw new Error('GIF 应用扩展缺少终止符');
        off += 1;
      } else {
        off += 2;
        while (off < b.length && b[off] !== 0) off += 1 + b[off];
        if (off >= b.length) throw new Error('GIF 扩展块缺少终止符');
        off += 1;
      }
      continue;
    }

    if (marker !== 0x2c) {
      throw new Error(`GIF 未识别的块标记 0x${marker.toString(16)}（偏移 ${off}）`);
    }

    // 图像描述符：0x2C + left(2) top(2) width(2) height(2) packed(1)
    if (off + 10 > b.length) throw new Error('GIF 图像描述符越界');
    const left = readU16(b, off + 1);
    const top = readU16(b, off + 3);
    const frameW = readU16(b, off + 5);
    const frameH = readU16(b, off + 7);
    const ipacked = b[off + 9];
    off += 10;
    if (frameW <= 0 || frameH <= 0) throw new Error(`GIF 帧尺寸非法：${frameW}x${frameH}`);

    let localTable = null;
    if ((ipacked & 0x80) !== 0) {
      const size = 1 << ((ipacked & 0x07) + 1);
      localTable = readColorTable(b, off, size);
      off += size * 3;
    }
    const interlaced = (ipacked & 0x40) !== 0;

    if (off >= b.length) throw new Error('GIF 图像数据缺失');
    const minCodeSize = b[off];
    off += 1;
    const data = readSubBlocks(b, off);
    off = data.next;

    const table = localTable ?? globalTable;
    if (!table) throw new Error('GIF 帧既无局部色表也无全局色表');
    if (table.length > MAX_PALETTE) throw new Error('GIF 色表超过 256 项');

    const pixels = lzwDecode(data.bytes, minCodeSize, frameW * frameH);
    const gce = pendingGce ?? { disposal: 0, transparent: false, transparentIndex: 0, delayMs: 0 };
    pendingGce = null;

    // disposal=3 要还原到"这一帧画上去之前"，事后只靠画布推不出来，只能先整块快照。
    // 其余情况不做快照，避免每帧一次整画布拷贝。
    const snapshot = gce.disposal === 3 ? canvas.slice() : null;
    drawFrame(canvas, width, height, pixels, frameW, frameH, left, top, interlaced, table, gce);
    frames.push({
      rgba: canvas.slice(),
      width,
      height,
      delayMs: gce.delayMs,
      disposal: gce.disposal,
    });
    applyDisposal(canvas, width, height, left, top, frameW, frameH, gce.disposal, snapshot);
  }

  if (!frames.length) throw new Error('GIF 里一帧都没有');
  return { width, height, frames, loopCount };
}

/**
 * 一帧上 RGB 三通道的均方误差。
 * 只看 RGB 是刻意的：阈值 1000 沿用 master 在 3 通道上的经验值，
 * 而本模块的帧是 RGBA——把恒为 255 的 alpha 也算进分母，等于把阈值悄悄调紧了。
 */
function rgbMse(a, b) {
  if (a.length !== b.length) throw new Error(`帧尺寸不一致：${a.length} 与 ${b.length}`);
  const n = a.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    sum += dr * dr + dg * dg + db * db;
  }
  return sum / ((n / 4) * 3);
}

/**
 * 两个等长字节序列的逐通道均方误差（0~255 量纲）。
 * @param {Buffer|Uint8Array} a
 * @param {Buffer|Uint8Array} b
 * @returns {number} 均方误差；长度不同抛错
 */
export function mseOf(a, b) {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) throw new Error(`均方误差要求等长，收到 ${x.length} 与 ${y.length}`);
  if (x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) {
    const d = x[i] - y[i];
    sum += d * d;
  }
  return sum / x.length;
}

/**
 * 按帧间差异挑关键帧：第一帧恒定入选，之后逐帧和**上一张入选帧**比较，
 * 差异超过阈值才入选（和上一张入选帧比，而不是和上一原始帧比，
 * 否则缓慢渐变会被每一帧的小差异逐帧"追上"，最后全被丢掉）。
 * @param {Array<{rgba:Uint8Array}>} frames 合成后的帧
 * @param {object} [opts]
 * @param {number} [opts.mseThreshold] RGB 均方误差阈值，超过才入选
 * @param {number} [opts.maxFrames] 最多保留几帧（含第一帧）
 * @returns {Array} 入选帧，元素就是传入的原对象
 */
export function keyFrames(frames, { mseThreshold = 1000, maxFrames = 15 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const kept = [frames[0]];
  const limit = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.trunc(maxFrames) : 1;
  for (let i = 1; i < frames.length; i += 1) {
    if (kept.length >= limit) break;
    const last = kept[kept.length - 1];
    if (rgbMse(last.rgba, frames[i].rgba) > mseThreshold) kept.push(frames[i]);
  }
  return kept;
}

/**
 * 把若干帧用最近邻等比缩放到统一高度，再横向排成一张长图。
 * 宽度向上取偶是给下游编码器留余量（部分工具对奇数宽度的色度处理会错一行）。
 * @param {Array<{rgba:Uint8Array,width:number,height:number}>} frames
 * @param {object} [opts]
 * @param {number} [opts.height] 目标高度（默认 200，与 master 一致）
 * @param {number} [opts.gap] 帧之间的透明间隔像素
 * @returns {{width:number,height:number,rgba:Uint8Array,cells:Array<{x:number,width:number}>}}
 */
export function spriteSheet(frames, { height = 200, gap = 0 } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const targetH = Math.max(1, Math.trunc(Number(height)));
  if (!Number.isFinite(targetH)) throw new Error(`sprite sheet 高度非法：${height}`);
  const g = Math.max(0, Math.trunc(Number(gap)) || 0);

  const cells = [];
  let x = 0;
  for (const frame of list) {
    const fw = Math.trunc(Number(frame?.width));
    const fh = Math.trunc(Number(frame?.height));
    if (!Number.isFinite(fw) || !Number.isFinite(fh) || fw <= 0 || fh <= 0) {
      throw new Error('sprite sheet 的帧缺少合法 width/height，无法等比缩放');
    }
    let cellW = Math.max(1, Math.floor((fw * targetH) / fh));
    if (cellW % 2 !== 0) cellW += 1; // 向上取偶
    cells.push({ x, width: cellW });
    x += cellW + g;
  }

  const totalW = cells.length ? x - g : 0;
  const rgba = new Uint8Array(totalW * targetH * 4);
  for (let i = 0; i < list.length; i += 1) {
    const frame = list[i];
    const cell = cells[i];
    const fw = Math.trunc(Number(frame.width));
    const fh = Math.trunc(Number(frame.height));
    const src = frame.rgba;
    for (let y = 0; y < targetH; y += 1) {
      const sy = Math.min(fh - 1, Math.floor((y * fh) / targetH));
      for (let px = 0; px < cell.width; px += 1) {
        const sx = Math.min(fw - 1, Math.floor((px * fw) / cell.width));
        const so = (sy * fw + sx) * 4;
        const dst = (y * totalW + cell.x + px) * 4;
        rgba[dst] = src[so];
        rgba[dst + 1] = src[so + 1];
        rgba[dst + 2] = src[so + 2];
        rgba[dst + 3] = src[so + 3];
      }
    }
  }

  return { width: totalW, height: targetH, rgba, cells };
}

/**
 * 一步到位：GIF 字节 → 抽关键帧 → 横向 sprite sheet。
 * @param {Buffer|Uint8Array} bytes GIF 文件字节
 * @param {object} [opts] 透传给 `keyFrames` / `spriteSheet`（mseThreshold/maxFrames/height/gap）
 * @returns {{sprite:{width:number,height:number,rgba:Uint8Array,cells:Array},kept:number,total:number,frames:Array}}
 *   `frames` 是入选的那些帧
 * @throws {Error} GIF 解不出帧，或抽帧结果为空
 */
export function gifToSpriteSheet(bytes, { mseThreshold = 1000, maxFrames = 15, height = 200, gap = 0 } = {}) {
  const parsed = parseGif(bytes);
  const total = parsed.frames.length;
  if (total === 0) throw new Error('GIF 没有可用的帧');
  const kept = keyFrames(parsed.frames, { mseThreshold, maxFrames });
  if (kept.length === 0) throw new Error('GIF 抽帧结果为空');
  const sprite = spriteSheet(kept, { height, gap });
  return { sprite, kept: kept.length, total, frames: kept };
}
