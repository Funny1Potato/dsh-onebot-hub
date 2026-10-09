/**
 * 会话日志体检（只读）：把 `session.v4.jsonl.zstd` 解成行，打印结构报告 + 重复检测。
 *
 * 用法：
 *   node test/_dump-session.mjs <session.v4.jsonl.zstd> [结构|全文|重复]
 *
 * - 结构：每行 type/role/长度 + 顶层键
 * - 全文：把 role=user / 含 prompt 上下文的那几行完整打出来（看看到底注入了什么）
 * - 重复：把所有长字符串字段做出现次数统计，>1 的列出来（找"同一段上下文被注入了好几遍"）
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const mode = process.argv[3] ?? '结构';
if (!file) {
  console.error('用法：node test/_dump-session.mjs <session.v4.jsonl.zstd> [结构|全文|重复]');
  process.exit(2);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const buf = fs.readFileSync(file);
const offsets = [];
for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) offsets.push(i);
if (!offsets.length) throw new Error('没有找到 zstd 帧魔数');
const parts = [];
for (let k = 0; k < offsets.length; k += 1) {
  const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length);
  parts.push(zlib.zstdDecompressSync(slice).toString('utf8'));
}
const text = parts.join('');
const lines = text.split(/\r?\n/).filter(Boolean);
const rows = lines.map((l) => {
  try { return JSON.parse(l); } catch { return { __raw: l }; }
});

console.log(`file=${file}`);
console.log(`frames=${offsets.length} lines=${lines.length} chars=${text.length}`);

const textsOf = (o) => {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') { if (v.length >= 200) out.push({ path, s: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); }
  };
  walk(o, '');
  return out;
};

const firstText = (o) => {
  const t = textsOf(o);
  if (!t.length) return '';
  const pick = t.find((x) => /text|content|prompt|body|preview/i.test(x.path)) ?? t[0];
  return pick.s;
};

if (mode === '快照') {
  const snaps = [];
  rows.forEach((o, i) => {
    if (o.type !== 'user/message' || o.data?.source?.kind !== 'runtime-context') return;
    snaps.push({ i, t: (o.data.content ?? []).map((c) => c.text ?? '').join('') });
  });
  console.log(`runtime-context 快照 ${snaps.length} 份`);
  snaps.forEach((s, k) => console.log(`  #${s.i} len=${s.t.length} same_as_prev=${k > 0 && s.t === snaps[k - 1].t}`));
  for (let k = 1; k < snaps.length; k += 1) {
    const a = snaps[k - 1].t.split('\n');
    const b = snaps[k].t.split('\n');
    const diffs = [];
    for (let L = 0; L < Math.max(a.length, b.length); L += 1) if (a[L] !== b[L]) diffs.push(`  L${L}: -${(a[L] ?? '(缺)').slice(0, 160)}\n      +${(b[L] ?? '(缺)').slice(0, 160)}`);
    console.log(`\n--- 快照 #${snaps[k - 1].i} → #${snaps[k].i}：${diffs.length} 行不同（共 ${Math.max(a.length, b.length)} 行）`);
    for (const d of diffs.slice(0, 14)) console.log(d);
    if (diffs.length > 14) console.log(`  …还有 ${diffs.length - 14} 行`);
  }
} else if (mode === '面') {
  const ops = new Map();
  rows.forEach((o) => {
    const op = typeof o.surfaceOp === 'string' ? o.surfaceOp : (o.surfaceOp ? JSON.stringify(o.surfaceOp).slice(0, 40) : '(none)');
    ops.set(op, (ops.get(op) ?? 0) + 1);
  });
  console.log('surfaceOp 分布：', [...ops.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('\nuser/message 行：');
  rows.forEach((o, i) => {
    if (o.type !== 'user/message') return;
    const d = o.data ?? {};
    const t = (d.content ?? []).map((c) => c.text ?? '').join('');
    const src = d.source?.kind ?? '(无 source)';
    console.log(`#${String(i).padStart(3)} chars=${String(t.length).padStart(5)} src=${String(src).padEnd(14)} ${t.slice(0, 70).replace(/\n/g, '\\n')}`);
  });
} else if (mode === '用量') {
  for (const [i, o] of rows.entries()) {
    const d = o.data ?? {};
    const u = d.usage ?? o.usage;
    if (!u) continue;
    const step = d.step ?? '';
    const turn = d.turn ?? '';
    const role = d.message?.role ?? o.role ?? o.type;
    console.log(`#${String(i).padStart(3)} turn=${String(turn).padStart(2)} step=${String(step).padStart(2)} ${String(role).padEnd(10)} input=${String(u.inputTokens).padStart(6)} cacheRead=${String(u.cacheReadTokens ?? 0).padStart(6)} output=${String(u.outputTokens).padStart(5)} total=${String(u.totalTokens ?? 0).padStart(6)}`);
  }
} else if (mode.startsWith('行')) {
  const wanted = (process.argv[4] ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
  const cap = Number(process.argv[5] ?? 6000);
  for (const n of wanted) {
    const o = rows[n];
    if (!o) { console.log(`\n===== #${n} 不存在 =====`); continue; }
    const s = JSON.stringify(o, null, 1);
    console.log(`\n===== #${n} (${s.length} chars) =====`);
    console.log(s.length > cap ? `${s.slice(0, cap)}\n…[截断 ${s.length - cap} 字符]` : s);
  }
} else if (mode === '概览') {
  rows.forEach((o, i) => {
    const d = o.data ?? {};
    const so = o.surfaceOp ?? d.surfaceOp;
    const soName = so ? (so.name ?? so.id ?? so.kind ?? JSON.stringify(so).slice(0, 60)) : '';
    const label = [o.type, d.role, d.kind, d.name, soName].filter(Boolean).join('/');
    const head = firstText(o).replace(/\s+/g, ' ').slice(0, 180);
    console.log(`#${String(i).padStart(3)} ${label.padEnd(52)} | ${head}`);
  });
} else if (mode === '结构') {
  rows.forEach((o, i) => {
    const keys = o && typeof o === 'object' ? Object.keys(o).slice(0, 8).join(',') : '';
    const size = JSON.stringify(o).length;
    const big = textsOf(o).reduce((a, b) => a + b.s.length, 0);
    console.log(`#${String(i).padStart(3)} size=${String(size).padStart(6)} textChars=${String(big).padStart(6)} keys=[${keys}]`);
  });
} else if (mode === '全文') {
  rows.forEach((o, i) => {
    const isUser = o.role === 'user' || o.type === 'user' || o.type === 'message';
    const t = textsOf(o);
    if (!isUser && !t.some((x) => x.path.includes('prompt') || x.path.includes('section'))) return;
    console.log(`\n===== #${i} =====`);
    console.log(JSON.stringify(o, null, 1).slice(0, 20000));
  });
} else {
  const counts = new Map();
  rows.forEach((o, i) => {
    for (const { path, s } of textsOf(o)) {
      const key = s.slice(0, 160);
      const rec = counts.get(key) ?? { n: 0, where: [], len: s.length, sample: s };
      rec.n += 1;
      if (rec.where.length < 6) rec.where.push(`#${i}:${path}`);
      counts.set(key, rec);
    }
  });
  const dups = [...counts.values()].filter((r) => r.n > 1).sort((a, b) => b.n * b.len - a.n * a.len);
  console.log(`\n重复长文本（按 前160字符 归一）共 ${dups.length} 组：`);
  for (const d of dups.slice(0, 25)) {
    console.log(`\n--- x${d.n} len=${d.len} @ ${d.where.join(' ')}`);
    console.log(d.sample.slice(0, 400).replace(/\n/g, '\\n'));
  }
}
