// Dump a byte range of an asar (or any file) as UTF-8 text.
// Usage: node test/asar-slice.mjs <file> <offset> <length>
import fs from 'node:fs';

const file = process.argv[2];
const offset = Number(process.argv[3]);
const length = Number(process.argv[4] ?? 8000);
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(length);
const read = fs.readSync(fd, buf, 0, length, offset);
fs.closeSync(fd);
process.stdout.write(buf.subarray(0, read).toString('utf8'));
