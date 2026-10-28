/**
 * 把一段文本画成二维码 PNG。
 *
 * 为什么要自己画 PNG：扫码连接要**把二维码送到用户眼前**，而设置页发的是 HTTP 响应、
 * 消息通道发的是图片文件——两者都不吃终端那套字符块。`qrcode-terminal` 只能在控制台摆
 * 字符画，用户在 GUI 里根本看不到。所以这里用 `qrcode-generator`（零依赖，只算矩阵）
 * 拿到黑白格子，再手写一个最小 PNG 编码器把格子变成图片。
 *
 * 为什么不用 `qrcode` 那个包：它为了输出各种格式拉了一串依赖（pngjs / yargs…），而我们
 * 只需要"灰度高图 + 无损压缩"，PNG 的格式本身就是为这件事设计的，四十行足够，出错的
 * 面也小。
 *
 * 灰度、8 位、无调色板：1 像素 = 1 字节。扫码只认黑白，灰度图在手机上反而更稳。
 */

import zlib from 'node:zlib';

import qrcode from 'qrcode-generator';

/** CRC32（PNG 每个 chunk 都要）。表只算一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 文本 → 二维码矩阵。纠错等级默认 M（脏屏幕、反光、手机斜着扫都还认得出）；
 * 内容太长自动升级版本（`typeNumber 0` = 让库自己挑）。
 */
export function qrMatrix(text, ecc = 'M') {
  const qr = qrcode(0, ecc);
  qr.addData(String(text ?? ''));
  qr.make();
  return qr;
}

/**
 * 二维码 → PNG。`scale` 是每个格子的像素数（默认 8：一屏放得下，手机也扫得动），
 * `margin` 是静区格数（二维码规范要求 ≥4，边框太窄手机对焦不上）。
 */
export function qrPng(text, { scale = 8, margin = 4, ecc = 'M' } = {}) {
  const qr = qrMatrix(text, ecc);
  const n = qr.getModuleCount();
  const side = (n + margin * 2) * scale;
  // 每行前面多一个字节：PNG 的 filter type（0 = 不过滤）。灰度图用 0 最省事也最快。
  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (side + 1);
    raw[rowStart] = 0;
    const gy = Math.floor(y / scale) - margin;
    if (gy < 0 || gy >= n) continue;
    for (let x = 0; x < side; x += 1) {
      const gx = Math.floor(x / scale) - margin;
      if (gx < 0 || gx >= n) continue;
      if (qr.isDark(gy, gx)) raw[rowStart + 1 + x] = 0x00;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 颜色类型：灰度
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 隔行扫描：否

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 直接给 `<img src>` 用：`data:image/png;base64,…`。 */
export function qrDataUrl(text, opts) {
  return `data:image/png;base64,${qrPng(text, opts).toString('base64')}`;
}
