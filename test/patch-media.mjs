/**
 * L1 原始层的**媒体回填**（`m02432` P9）的可执行验证。
 *
 * 为什么值得单独测：`RecallStore.rowOf()` 是在 `append()` 那一刻就把 `mediaRefs` 冻住的，
 * 而图片/语音是之后才异步落地的（`hub.#resolveMedia` / `hub.#resolveDownstreamMedia`）。
 * 不回填的话 `onebot_raw` 永远回 `mediaRefs: null, media: []`——真机上 agent 只能去翻
 * `onebot_media{list:true}`（那一次 49933 字符）才找到那张图。
 *
 * 这里验的是：
 *   · append 的瞬间 `mediaRefs` 就是 null（复现 P9 的现场，别把这条当成"已经修好了"）
 *   · `patchMedia(id, ids)` 同时改**内存行**与**当天那份 jsonl**（落盘那份才是重启后还查得到的）
 *   · 之后 `rawOf(id)` 能拿到回填后的 `mediaRefs` 与 `refs.media`
 *   · 不认识的 id / 关闭落盘（`dir:''`）都不抛
 *
 * 跑法：node test/patch-media.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RecallStore } from '../lib/memory/recall.js';
import { safeName } from '../lib/storage.js';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log(`FAIL  ${name}\n      ${String(err?.message ?? err)}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recall-'));
const linkId = 'down:127.0.0.1:8080';
const now = Date.now();
const store = new RecallStore({ dir, linkId, now: () => now });
const mediaIds = ['hub-media:a1', 'hub-media:b2'];
const entry = {
  id: 't1',
  ts: now,
  sessionKey: 'group:55555',
  direction: 'downstream-in',
  kind: 'group_message',
  actor: { user_id: '30001000', nickname: '小助手' },
  refs: { message_id: 'm1' },
  text: '（图片）',
  payload: { post_type: 'message', message: [{ type: 'image', data: { file: 'x' } }] },
};

await check('append 那一刻媒体还没落地：mediaRefs 就是 null（P9 的现场）', () => {
  assert.equal(store.append(entry), true);
  assert.equal(store.byMessage('m1')?.mediaRefs, null);
});

await check('patchMedia 回填内存行，且落盘那份 jsonl 也改了', () => {
  assert.equal(store.patchMedia('t1', mediaIds), true);
  assert.deepEqual(store.byMessage('m1')?.mediaRefs, mediaIds);
  const dayDir = path.join(dir, safeName(linkId));
  const files = fs.readdirSync(dayDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `当天应当只有一份 jsonl，实际 ${JSON.stringify(files)}`);
  const row = JSON.parse(fs.readFileSync(path.join(dayDir, files[0]), 'utf8').trim());
  assert.deepEqual(row.mediaRefs, mediaIds, '落盘那行的 mediaRefs 必须回填');
  assert.deepEqual(row.refs.media, mediaIds, 'refs.media 与 mediaRefs 要一致');
});

await check('之后 rawOf(id) 拿得到回填后的媒体引用', async () => {
  const raw = await store.rawOf('t1');
  assert.equal(raw.ok, true);
  assert.deepEqual(raw.raw.mediaRefs, mediaIds);
});

await check('不认识的 id / 空清单：返回 false，不抛', () => {
  assert.equal(store.patchMedia('t404', mediaIds), false);
  assert.equal(store.patchMedia('t1', []), false);
  assert.equal(store.patchMedia('', mediaIds), false);
});

await check('关闭落盘（dir:""）时只在内存里回填，不抛', () => {
  const off = new RecallStore({ dir: '' });
  assert.equal(off.append(entry), false, 'dir 空 = 不记 L1');
  assert.equal(off.patchMedia('t1', mediaIds), false, '没有这行就什么都不做');
});

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}

const failed = results.filter((r) => !r.ok);
console.log(`\npatch-media: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
