/**
 * PNG 编码 + 解码（纯 JS，无依赖，只用 `node:zlib`）。
 *
 * 为什么自己造这个容器：GIF 抽帧的结果最终要当成静态图送给视觉模型，走宿主的附件管线。
 * Node 标准库只有 zlib（压缩算法本身），没有图片容器；而"把 8 位 RGBA 像素包成 PNG"
 * 恰好只需要三段 chunk 加一个 CRC32，为这点代码引一个图像库不值得（本仓库也不允许新增依赖）。
 *
 * 为什么编码端只做 8 位 RGBA（color type 6）、无交错、扫描线 filter 固定 0：
 * 像素来源是 GIF 合成画布，本来就是 4 通道 8 位；每多支持一种色型/位深就多一条
 * "对面认不认"的分支。filter 固定 0 是编码端最省事也最不容易写错的做法。
 *
 * 但解码端相反：`decodePngToRgba` 把 5 种 filter（None/Sub/Up/Average/Paeth）全实现了。
 * 因为它的职责是读回**别人重编码过**的 PNG（中间任何一个会重存图的工具都会换 filter），
 * 只认 filter 0 的话，往返测试会用自己的产物骗过自己，真机上才炸。
 *
 * 本模块不 import 任何宿主包，不联网、不读环境变量、不用随机数。
 */

import zlib from 'node:zlib';

/** PNG 文件签名，恒为这 8 个字节。 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 查表法：每个 chunk 都要算一次，逐位算法在长图（sprite sheet 可能上万像素宽）上
// 会变成明显的热点，所以启动时先把 256 项表建好，之后每字节只查一次表。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 只接受真正的字节序列：像素数据出现别的类型一律当作调用方写错了。 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('期望 Buffer / Uint8Array 字节序列');
}

const readU32 = (bytes, offset) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

/**
 * CRC32（IEEE 802.3，PNG 使用的那个多项式）。
 * @param {Buffer|Uint8Array} buf 待校验的字节
 * @param {number} [seed] 上一次的校验值；PNG 的 chunk 是"类型+数据"整体算，默认 0 就是普通 CRC32
 * @returns {number} 无符号 32 位校验值
 */
export function crc32(buf, seed = 0) {
  const bytes = toBytes(buf);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 拼一个 chunk：长度(4) + 类型(4) + 数据 + CRC(4)，CRC 覆盖"类型+数据"。 */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

/**
 * 把 8 位 RGBA 像素编码成 PNG（color type 6、无交错、每条扫描线前置 filter 字节 0）。
 * @param {object} input
 * @param {number} input.width 像素宽（正整数）
 * @param {number} input.height 像素高（正整数）
 * @param {Buffer|Uint8Array} input.rgba 行优先 RGBA 像素，长度必须恰好 width*height*4
 * @returns {Buffer} 完整的 PNG 文件字节
 */
export function encodePng({ width, height, rgba } = {}) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`PNG 尺寸非法：${width}x${height}`);
  }
  const pixels = toBytes(rgba);
  const expected = w * h * 4;
  if (pixels.length !== expected) {
    throw new Error(`PNG 像素长度 ${pixels.length} 与 ${w}x${h} 不符（应为 ${expected}）`);
  }

  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y += 1) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter 0 = None，编码端不做行间预测
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), dst + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Paeth 预测器：取 a/b/c 中与 p=a+b-c 最接近的那个。 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 成 RGBA 像素。只支持 8 位 RGBA（color type 6）、非交错；
 * 5 种扫描线 filter 都实现了，以便读回被别的工具重编码过的文件。
 * @param {Buffer|Uint8Array} buf PNG 文件字节
 * @returns {{width:number,height:number,rgba:Uint8Array}} 行优先 RGBA
 */
export function decodePngToRgba(buf) {
  const bytes = toBytes(buf);
  if (bytes.length < 8) throw new Error('不是 PNG：连签名都不完整');
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('不是 PNG：签名不符');
  }

  let off = 8;
  let header = null;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = Buffer.from(bytes.subarray(off + 4, off + 8)).toString('latin1');
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error(`PNG 块 ${type} 长度越界`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('PNG IHDR 长度不足 13 字节');
      header = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }

  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.bitDepth !== 8 || header.colorType !== 6) {
    throw new Error(`只支持 8 位 RGBA 的 PNG，收到 bitDepth=${header.bitDepth} colorType=${header.colorType}`);
  }
  if (header.interlace !== 0) throw new Error('不支持交错（interlace）PNG');
  if (header.compression !== 0) throw new Error(`不支持的 PNG 压缩方法 ${header.compression}`);
  if (header.width <= 0 || header.height <= 0) throw new Error('PNG 尺寸非法');
  if (!idat.length) throw new Error('PNG 缺少 IDAT');

  const { width, height } = header;
  const bpp = 4;
  const stride = width * bpp;
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new Error(`PNG IDAT 解压失败：${err?.message ?? err}`);
  }
  if (inflated.length < height * (stride + 1)) {
    throw new Error(`PNG 解压后字节数 ${inflated.length} 不足（应为 ${height * (stride + 1)}）`);
  }

  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride); // 第 0 行上面视为全 0
  for (let y = 0; y < height; y += 1) {
    const type = inflated[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = inflated[lineStart + i];
      switch (type) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4:
          v += paeth(a, b, c);
          break;
        default:
          throw new Error(`不支持的 PNG filter 类型 ${type}`);
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }

  return { width, height, rgba: out };
}
