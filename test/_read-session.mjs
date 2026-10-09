/**
 * 读 DSH 的会话日志（`session.v4.jsonl.zstd`）。
 * 坑：这个文件是**多个 zstd 帧顺序追加**的（每次 flush 追加一帧），
 * `zlib.zstdDecompressSync` 只解第一帧（症状：1423 字节的文件只解出 182 字节、只有 session 头）。
 * 流式解压器会连续吃完整串帧，所以这里用 stream。
 *
 * 用法：node test/_read-session.mjs <session.v4.jsonl.zstd> [最多打印行数]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const f = process.argv[2];
const limit = Number(process.argv[3] ?? 40);
const buf = fs.readFileSync(f);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 魔数把文件切成若干帧，逐帧解压（每帧都是独立完整的一帧）。 */
function inflateFrames(buffer) {
  const offsets = [];
  for (let i = buffer.indexOf(MAGIC); i !== -1; i = buffer.indexOf(MAGIC, i + 4)) offsets.push(i);
  if (offsets.length === 0) throw new Error('没有找到 zstd 帧魔数');
  const outs = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const slice = buffer.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buffer.length);
    outs.push(zlib.zstdDecompressSync(slice).toString('utf8'));
  }
  return outs.join('');
}

let text;
try {
  text = inflateFrames(buf);
} catch (err) {
  console.log('decompress failed:', err.message);
  process.exit(1);
}
const lines = text.split(/\r?\n/).filter(Boolean);
console.log('lines:', lines.length, 'bytes:', text.length);
for (const line of lines.slice(0, limit)) {
  try {
    const o = JSON.parse(line);
    const brief = { type: o.type ?? o.kind, role: o.role, ts: o.time ?? o.timestamp ?? o.ts };
    const s = JSON.stringify(o);
    console.log(JSON.stringify(brief), s.length > 900 ? s.slice(0, 900) + '…' : s);
  } catch {
    console.log('RAW', line.slice(0, 300));
  }
}
