// Scan an asar archive's raw bytes for needle strings and print context.
import fs from 'node:fs';

const file = process.argv[2];
const needles = process.argv.slice(3);
const MAX = Number(process.env.ASAR_MAX ?? 3) || 3;
const CONTEXT = Number(process.env.ASAR_CONTEXT ?? 500) || 500;
const FILTER = process.env.ASAR_FILTER ? new RegExp(process.env.ASAR_FILTER) : null;
const fd = fs.openSync(file, 'r');
const size = fs.statSync(file).size;
const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK + 4096);
let carry = Buffer.alloc(0);
let pos = 0;
const hits = new Map(needles.map((n) => [n, Object.assign([], { total: 0 })]));

while (pos < size) {
  const read = fs.readSync(fd, buf, 0, CHUNK, pos);
  if (read <= 0) break;
  const chunk = Buffer.concat([carry, buf.subarray(0, read)]);
  const base = pos - carry.length;
  for (const n of needles) {
    // 're:<pattern>' scans with a regular expression (for minified sources that
    // write `kind:"reject"` without the space a literal needle would need).
    if (n.startsWith('re:')) {
      const rx = new RegExp(n.slice(3), 'g');
      const text = chunk.toString('utf8');
      let m;
      let searchFrom = 0;
      while ((m = rx.exec(text)) !== null) {
        const total = hits.get(n).total + 1;
        hits.get(n).total = total;
        if (hits.get(n).length < MAX) {
          const byteIdx = chunk.indexOf(Buffer.from(m[0], 'utf8'), searchFrom);
          searchFrom = byteIdx + 1;
          const from = Math.max(0, byteIdx - CONTEXT);
          const to = Math.min(chunk.length, byteIdx + CONTEXT + 200);
          const window = chunk.subarray(from, to).toString('utf8');
          if (!FILTER || FILTER.test(window)) {
            hits.get(n).push({ offset: base + byteIdx, text: `[match ${JSON.stringify(m[0])}]\n${window}` });
          }
        }
        if (m[0].length === 0) rx.lastIndex += 1;
      }
      continue;
    }
    const nb = Buffer.from(n, 'utf8');
    let idx = chunk.indexOf(nb);
    while (idx !== -1) {
      const total = hits.get(n).total + 1;
      hits.get(n).total = total;
      if (hits.get(n).length < MAX) {
        const from = Math.max(0, idx - CONTEXT);
        const to = Math.min(chunk.length, idx + CONTEXT + 200);
        const text = chunk.subarray(from, to).toString('utf8');
        if (!FILTER || FILTER.test(text)) hits.get(n).push({ offset: base + idx, text });
      }
      idx = chunk.indexOf(nb, idx + 1);
    }
  }
  carry = chunk.subarray(Math.max(0, chunk.length - 4096));
  pos += read;
}
fs.closeSync(fd);
for (const [n, list] of hits) {
  console.log(`\n===== ${n} : ${list.total === 0 ? 'NOT FOUND' : list.total + ' hit(s), showing ' + list.length} =====`);
  for (const h of list) console.log(`@${h.offset}\n${h.text}\n---`);
}
