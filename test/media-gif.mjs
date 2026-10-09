/**
 * GIF → 关键帧 → sprite sheet 的自包含测试（`node test/media-gif.mjs`）。
 *
 * 为什么不拿现成的 .gif 样本文件来测：样本一旦进仓库就成了"没人敢动"的二进制黑盒，
 * 断言写不细（只看"解出来有几帧"就漏掉 disposal/交错/透明这些真正容易错的分支），
 * 而且没法构造"两帧只差一个像素"这种刚好卡在阈值上的用例。
 * 这里改成**在测试里手写一个最小 GIF 编码器**：它只会发 清空码 + 字面码 + 结束码
 * （每个字面码前都补一个清空码，字典因此永远不增长、码长恒为 minCodeSize+1），
 * 简单到可以一眼验算，却足以喂给解码器跑通全部分支。
 *
 * 全部用例确定性：不用随机数、不读磁盘、不联网。
 */

import assert from 'node:assert/strict';

import { crc32, decodePngToRgba, encodePng } from '../lib/media/png.js';
import { gifToSpriteSheet, keyFrames, mseOf, parseGif, spriteSheet } from '../lib/media/gif.js';

// ---- 最小 GIF 编码器（测试专用）------------------------------------------------

/**
 * GIF 的 LZW 是 LSB-first 打包，码与码之间不补齐整字节；而且码长会中途变化，
 * 所以不能先攒一堆码再打包，得边发边按"当前码长"写位。
 */
function packBitsStream(minCodeSize) {
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let codeSize = minCodeSize + 1;
  return {
    push(code) {
      acc |= (code & ((1 << codeSize) - 1)) << bits;
      bits += codeSize;
      while (bits >= 8) {
        bytes.push(acc & 0xff);
        acc >>>= 8;
        bits -= 8;
      }
    },
    size() {
      return codeSize;
    },
    grow() {
      codeSize += 1;
    },
    reset() {
      codeSize = minCodeSize + 1;
    },
    done() {
      if (bits > 0) bytes.push(acc & 0xff);
      return Buffer.from(bytes);
    },
  };
}

/**
 * 最保守的 LZW 编码：每个像素前都补一个清空码。
 * 解码器在清空后的第一个码只输出、不建字典条目，因此字典永远停在初始状态、
 * 码长不必增长——简单到可以手算，但它覆盖不到解码端的码长增长分支
 * （那一条交给下面的真实编码器）。
 */
function lzwEncodeSimple(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = packBitsStream(minCodeSize);
  for (const index of indices) {
    out.push(clear);
    out.push(index);
  }
  out.push(end);
  return out.done();
}

/**
 * 真实 LZW：真的建字典、码长真的会增长、字典满了真的发清空码。
 *
 * 码长增长的时机必须比解码端**晚一格**：编码端每输出一个码就立刻登记新条目，
 * 而解码端要等到读出下一个码、知道那条目的末字节之后才能登记，天生落后一条。
 * 所以解码端在自己的 next 达到 2^size 时加长码长，编码端要等到 2^size + 1。
 * 若这里写成 2^size，码流会从第一次增长起整体错位——这不是推导出来的，
 * 是该条件确实解不出任何东西之后对着解码器比对出来的。
 */
function lzwEncodeFull(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = packBitsStream(minCodeSize);
  let table = new Map();
  let next = end + 1;
  let prev = -1;
  out.push(clear);
  for (const k of indices) {
    if (prev < 0) {
      prev = k;
      continue;
    }
    const key = (prev << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prev = found;
      continue;
    }
    out.push(prev);
    if (next < 4096) {
      table.set(key, next);
      next += 1;
      if (next === (1 << out.size()) + 1 && out.size() < 12) out.grow();
    } else {
      // 字典满：发清空码，双方一起回到初始状态（码长也回到 minCodeSize+1）。
      out.push(clear);
      table = new Map();
      next = end + 1;
      out.reset();
    }
    prev = k;
  }
  if (prev >= 0) out.push(prev);
  out.push(end);
  return out.done();
}

/** 把字节切成 GIF 的"数据子块"链（<=255 字节一块，0 长度块收尾）。 */
function subBlocks(buf) {
  const parts = [];
  for (let i = 0; i < buf.length; i += 255) {
    const slice = buf.subarray(i, Math.min(i + 255, buf.length));
    parts.push(Buffer.from([slice.length]), slice);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * 造一个 GIF89a。
 * frames 项：{ indices, left, top, width, height, delay(1/100 秒), disposal, transparentIndex, interlace, compress }
 * `compress: 'full'` 用真实 LZW；默认用上面那个清空码打底的简化编码器。
 */
function buildGif({ width, height, palette, frames, loopCount = null }) {
  // 色表必须是 2 的幂且至少 2 项；最小码长至少 2（GIF 规范不允许更小）。
  const tableSize = Math.max(2, 1 << Math.ceil(Math.log2(Math.max(2, palette.length))));
  const sizeField = Math.log2(tableSize) - 1;
  const minCodeSize = Math.max(2, Math.ceil(Math.log2(tableSize)));

  const parts = [Buffer.from('GIF89a', 'latin1')];

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | (0x07 << 4) | sizeField; // 有全局色表 + 色分辨率 8 位
  lsd[5] = 0; // 背景色索引（解码端一律当透明，填什么都不影响断言）
  lsd[6] = 0; // 像素宽高比
  parts.push(lsd);

  const table = Buffer.alloc(tableSize * 3);
  for (let i = 0; i < tableSize; i += 1) {
    const c = palette[i] ?? [0, 0, 0];
    table[i * 3] = c[0];
    table[i * 3 + 1] = c[1];
    table[i * 3 + 2] = c[2];
  }
  parts.push(table);

  if (loopCount !== null) {
    parts.push(Buffer.from([0x21, 0xff, 0x0b]));
    parts.push(Buffer.from('NETSCAPE2.0', 'latin1'));
    parts.push(Buffer.from([0x03, 0x01, loopCount & 0xff, (loopCount >> 8) & 0xff, 0x00]));
  }

  for (const f of frames) {
    const left = f.left ?? 0;
    const top = f.top ?? 0;
    const fw = f.width ?? width;
    const fh = f.height ?? height;
    const disposal = f.disposal ?? 1;
    const delay = f.delay ?? 0;
    const hasTransparent = f.transparentIndex !== null && f.transparentIndex !== undefined;
    const gp = ((disposal & 0x07) << 2) | (hasTransparent ? 1 : 0);
    parts.push(Buffer.from([
      0x21, 0xf9, 0x04, gp,
      delay & 0xff, (delay >> 8) & 0xff,
      hasTransparent ? f.transparentIndex : 0,
      0x00,
    ]));

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(left, 1);
    descriptor.writeUInt16LE(top, 3);
    descriptor.writeUInt16LE(fw, 5);
    descriptor.writeUInt16LE(fh, 7);
    descriptor[9] = f.interlace ? 0x40 : 0x00;
    parts.push(descriptor);
    const encodeLzw = f.compress === 'full' ? lzwEncodeFull : lzwEncodeSimple;
    parts.push(Buffer.from([minCodeSize]));
    parts.push(subBlocks(encodeLzw(f.indices, minCodeSize)));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** 交错帧的存储行 → 显示行顺序，与实现里那份保持一致，用来构造用例。 */
function interlacedOrder(height) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];
const YELLOW = [255, 255, 0];
const PALETTE = [RED, BLUE, GREEN, YELLOW];

const solid = (w, h, rgba) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) out.set(rgba, i * 4);
  return out;
};

/** 读合成帧上某个像素。 */
const px = (frame, x, y) => {
  const o = (y * frame.width + x) * 4;
  return [frame.rgba[o], frame.rgba[o + 1], frame.rgba[o + 2], frame.rgba[o + 3]];
};

// ---- 用例收集（与仓库其它测试同形）--------------------------------------------

let passed = 0;
const cases = [];
const pending = [];
function t(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => {
            passed += 1;
            cases.push({ name, ok: true });
          },
          (err) => cases.push({ name, ok: false, error: String(err?.message ?? err) }),
        ),
      );
      return;
    }
    passed += 1;
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

// ---- PNG ----------------------------------------------------------------------

t('PNG：编码产物签名正确，IHDR/IDAT/IEND 三段齐全', () => {
  const png = encodePng({ width: 2, height: 2, rgba: solid(2, 2, [1, 2, 3, 4]) });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(8), 13, 'IHDR 数据段应为 13 字节');
  const type = (offset) => png.subarray(offset, offset + 4).toString('latin1');
  assert.equal(type(12), 'IHDR');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND', 'IEND 必须是最后一段');
  assert.ok(png.toString('latin1').includes('IDAT'));
});

t('PNG：编码→解码往返像素完全一致', () => {
  const width = 3;
  const height = 5;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = (i * 37 + 11) & 0xff; // 3*5*4=60 字节，37 与 256 互质
  const back = decodePngToRgba(encodePng({ width, height, rgba }));
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.deepEqual(back.rgba, rgba);
});

t('PNG：尺寸/像素长度不合法会抛错', () => {
  assert.throws(() => encodePng({ width: 3, height: 3, rgba: new Uint8Array(3 * 3 * 4 - 1) }), /不符/);
  assert.throws(() => encodePng({ width: 0, height: 3, rgba: new Uint8Array(0) }), /尺寸非法/);
  assert.throws(() => decodePngToRgba(Buffer.from('not a png')), /不是 PNG/);
});

t('PNG：crc32 命中标准向量，且能增量串算', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const first = crc32(Buffer.from('1234'));
  assert.equal(crc32(Buffer.from('56789'), first), 0xcbf43926, '分两段算应等于整体算');
});

// ---- GIF 解析 -----------------------------------------------------------------

t('GIF：单帧 4×4 纯色，四角颜色与延时正确', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [{ indices: new Array(16).fill(0), delay: 7, disposal: 1 }],
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 4);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].delayMs, 70, 'GIF 的延时单位是 1/100 秒');
  assert.equal(parsed.loopCount, 0, '没有 NETSCAPE 块时循环次数为 0');
  for (const [x, y] of [[0, 0], [3, 0], [0, 3], [3, 3]]) {
    assert.deepEqual(px(parsed.frames[0], x, y), [255, 0, 0, 255]);
  }
});

t('GIF：两帧 GIF 合成后保留上一帧画布（disposal=1）', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { indices: new Array(16).fill(0), delay: 5, disposal: 1 }, // 整块红
      { indices: new Array(4).fill(1), left: 0, top: 0, width: 2, height: 2, delay: 5, disposal: 1 }, // 左上角 2×2 蓝
    ],
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(px(parsed.frames[0], 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(parsed.frames[1], 0, 0), [0, 0, 255, 255], '第二帧应能看见新颜色');
  assert.deepEqual(px(parsed.frames[1], 1, 1), [0, 0, 255, 255]);
  assert.deepEqual(px(parsed.frames[1], 2, 0), [255, 0, 0, 255], '矩形外仍是上一帧的红');
  assert.deepEqual(px(parsed.frames[1], 3, 3), [255, 0, 0, 255]);
  assert.equal(parsed.frames[1].disposal, 1);
});

t('GIF：disposal=2 把帧矩形还原成透明背景', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { indices: new Array(16).fill(0), disposal: 2 },
      { indices: new Array(4).fill(1), left: 0, top: 0, width: 2, height: 2, disposal: 1 },
    ],
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames[0].disposal, 2);
  assert.deepEqual(px(parsed.frames[1], 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(parsed.frames[1], 2, 0), [0, 0, 0, 0], '第一帧处置为 2，矩形外应被抹成透明');
  assert.deepEqual(px(parsed.frames[1], 3, 3), [0, 0, 0, 0]);
});

t('GIF：disposal=3 回滚到画这一帧之前的画布', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { indices: new Array(16).fill(0), disposal: 1 }, // 红（保留）
      { indices: new Array(16).fill(1), disposal: 3 }, // 蓝，但看完要回滚
      { indices: new Array(4).fill(2), left: 2, top: 2, width: 2, height: 2, disposal: 1 }, // 右下角绿
    ],
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(px(parsed.frames[1], 0, 0), [0, 0, 255, 255], '第三帧显示时第二帧应当是蓝的');
  assert.deepEqual(px(parsed.frames[2], 0, 0), [255, 0, 0, 255], '回滚后应恢复成红');
  assert.deepEqual(px(parsed.frames[2], 2, 2), [0, 255, 0, 255]);
});

t('GIF：透明索引不覆盖下层像素', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { indices: new Array(16).fill(0), disposal: 1 },
      { indices: new Array(4).fill(1), left: 0, top: 0, width: 2, height: 2, disposal: 1, transparentIndex: 1 },
    ],
  });
  const parsed = parseGif(gif);
  assert.deepEqual(px(parsed.frames[1], 0, 0), [255, 0, 0, 255], '整块透明等于什么都不画');
});

t('GIF：交错帧按 interlaced 行序还原', () => {
  const order = interlacedOrder(4);
  const indices = [];
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) indices.push(order[sy]); // 每行用"行号"当颜色索引
  }
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [{ indices, interlace: true, disposal: 1 }],
  });
  const parsed = parseGif(gif);
  for (let y = 0; y < 4; y += 1) {
    assert.deepEqual(px(parsed.frames[0], 0, y), [...PALETTE[y], 255], `显示第 ${y} 行应是色表第 ${y} 项`);
  }
});

t('GIF：NETSCAPE 循环次数被读出', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: PALETTE,
    loopCount: 3,
    frames: [{ indices: new Array(4).fill(0), disposal: 1 }],
  });
  assert.equal(parseGif(gif).loopCount, 3);
});

t('GIF：真实 LZW 的码长增长与字典重置也能逐像素解对', () => {
  const width = 128;
  const height = 128;
  const count = width * height;
  // 16 色噪声：字符串多到字典必然长满 12 位、并至少触发一次清空码。
  // 用 xorshift 而不是 Math.random，测试必须可复现。
  let x = 2463534242;
  const rnd = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const palette = Array.from({ length: 16 }, (_, i) => [(i * 16) & 0xff, (i * 5 + 3) & 0xff, (i * 11 + 7) & 0xff]);
  const indices = Array.from({ length: count }, () => (rnd() >>> 8) & 15);

  const gif = buildGif({
    width,
    height,
    palette,
    frames: [{ indices, compress: 'full', disposal: 1 }],
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 1);

  let mismatched = 0;
  let firstBad = -1;
  for (let p = 0; p < count; p += 1) {
    const o = p * 4;
    const want = palette[indices[p]];
    const frame = parsed.frames[0];
    if (frame.rgba[o] !== want[0] || frame.rgba[o + 1] !== want[1] || frame.rgba[o + 2] !== want[2]) {
      mismatched += 1;
      if (firstBad < 0) firstBad = p;
    }
  }
  assert.equal(mismatched, 0, `真实 LZW 码流应逐像素还原，首个错像素 #${firstBad}`);
});

t('GIF：坏数据抛带说明的错误，不静默返回空帧', () => {
  assert.throws(() => parseGif(Buffer.from('not a gif')), /不是 GIF/);
  assert.throws(() => parseGif(Buffer.from('GIF89a')), /太短/);
  const good = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [{ indices: new Array(16).fill(0), disposal: 1 }],
  });
  assert.throws(() => parseGif(good.subarray(0, 20)), Error, '截断的数据必须炸');
});

// ---- 关键帧与拼图 -------------------------------------------------------------

t('GIF：keyFrames 按 RGB 差异挑帧——差异大取 2 帧，完全相同只取 1 帧', () => {
  const palette = [RED, BLUE, GREEN, YELLOW];
  const differing = parseGif(buildGif({
    width: 4,
    height: 4,
    palette,
    frames: [
      { indices: new Array(16).fill(0), disposal: 1 },
      { indices: new Array(16).fill(1), disposal: 1 },
    ],
  }));
  assert.equal(differing.frames.length, 2);
  const kept = keyFrames(differing.frames);
  assert.equal(kept.length, 2, '红→蓝差异远超阈值，两帧都该留下');
  assert.equal(kept[0], differing.frames[0], '入选项必须保持原结构（同一对象）');

  const identical = parseGif(buildGif({
    width: 4,
    height: 4,
    palette,
    frames: [
      { indices: new Array(16).fill(0), disposal: 1 },
      { indices: new Array(16).fill(0), disposal: 1 },
    ],
  }));
  assert.equal(identical.frames.length, 2);
  assert.equal(keyFrames(identical.frames).length, 1, '两帧完全相同只留第一帧');

  // 阈值抬到超过红蓝差异 → 同样只留第一帧，证明判据真的在比 MSE
  assert.equal(keyFrames(differing.frames, { mseThreshold: 1e9 }).length, 1);
  assert.equal(keyFrames(differing.frames, { maxFrames: 1 }).length, 1);
  assert.deepEqual(keyFrames([]), []);
});

t('mseOf：等长才可比，数值符合手算', () => {
  assert.equal(mseOf(new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 0])), 0);
  assert.equal(mseOf(new Uint8Array([0]), new Uint8Array([10])), 100);
  assert.throws(() => mseOf(new Uint8Array(2), new Uint8Array(3)), /等长/);
});

t('spriteSheet：最近邻等比缩放到目标高度，宽度向上取偶', () => {
  const frame = { rgba: solid(3, 3, [10, 20, 30, 255]), width: 3, height: 3 };
  const sheet = spriteSheet([frame], { height: 5 });
  assert.equal(sheet.height, 5);
  assert.equal(sheet.cells[0].width, 6, 'floor(3*5/3)=5 是奇数，应向上取偶成 6');
  assert.deepEqual(sheet.cells, [{ x: 0, width: 6 }]);
  assert.deepEqual(px({ ...sheet, ...sheet.cells[0] }, 5, 4), [10, 20, 30, 255]);
});

t('GIF：gifToSpriteSheet 宽度等于各帧缩放宽度之和，且能编成合法 PNG', () => {
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: PALETTE,
    frames: [
      { indices: new Array(16).fill(0), delay: 6, disposal: 1 },
      { indices: new Array(16).fill(1), delay: 6, disposal: 1 },
    ],
  });

  const out = gifToSpriteSheet(gif, { height: 8, gap: 0 });
  assert.equal(out.total, 2);
  assert.equal(out.kept, 2);
  assert.equal(out.frames.length, 2);
  const sum = out.sprite.cells.reduce((s, c) => s + c.width, 0);
  assert.equal(out.sprite.width, sum, 'sprite 宽度应等于各帧缩放宽度之和');
  assert.equal(out.sprite.width, 16, '4×4 → 高 8 宽 8，两帧');
  assert.equal(out.sprite.height, 8);
  for (const cell of out.sprite.cells) assert.equal(cell.width % 2, 0, '每格宽度应为偶数');

  const png = encodePng(out.sprite);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const back = decodePngToRgba(png);
  assert.equal(back.width, out.sprite.width);
  assert.equal(back.height, 8);
  assert.deepEqual(back.rgba, out.sprite.rgba);

  // 间隔要算进总宽，且后面的格子整体右移
  const spaced = gifToSpriteSheet(gif, { height: 8, gap: 3 });
  assert.equal(spaced.sprite.width, 19);
  assert.equal(spaced.sprite.cells[0].x, 0);
  assert.equal(spaced.sprite.cells[1].x, 11);
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
