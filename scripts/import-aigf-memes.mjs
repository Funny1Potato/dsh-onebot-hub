#!/usr/bin/env node
/**
 * aigf-master → dsh-onebot-hub 表情包一次性迁移。
 *
 * 用法：
 *   node scripts/import-aigf-memes.mjs <aigf-master 的 memes 数据目录> <hub 的 storage 目录> [--max-count N]
 *
 * 例（本机实弹那次的形状）：
 *   node scripts/import-aigf-memes.mjs D:\...\nonebot_plugin_aigf_master\memes C:\Users\me\.dsh\onebot-hub
 *
 * 数据来源（nonebot-plugin-aigf-master 的落盘形状）：`<数据目录>\memes.json`（管理员收录）
 * 与 `collected.json`（自动收集），图片就在同一目录，`path` 是裸文件名。
 * 去处：图片字节写进 `<storage>\memes\m<N>.<ext>`，索引合并进 `<storage>\memes\index.json`
 * （seq 续着排、sha256 去重；管理员收录优先，自动收集按使用次数降序；容量默认 200，
 * 可用 --max-count 覆盖——应与 hub 配置的 memes.maxCount 一致，否则下次收录时才会淘汰到它）。
 *
 * 什么时候跑：**离线跑**。先停 DSH（或确认醒着也不会动表情包库）再执行；跑完启动/重启
 * DSH，新库随插件装配载入。唯一要避开的坑：运行中的 hub 内存态若在导入之后又发生表情包
 * 变更（收藏/使用/淘汰），它落盘时会用旧内存态盖掉这次导入——上游断着、没人聊天时没有这个风险。
 */

import fs from 'node:fs';
import { MemeStore } from '../lib/memes/store.js';
import { JsonStore } from '../lib/storage.js';

function fail(msg) {
  console.error(`导入失败：${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positionals = [];
let maxCount = 200;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--max-count') {
    maxCount = Number(argv[(i += 1)]);
  } else if (arg.startsWith('--max-count=')) {
    maxCount = Number(arg.slice('--max-count='.length));
  } else {
    positionals.push(arg);
    continue;
  }
  if (!Number.isInteger(maxCount) || maxCount < 1) fail('--max-count 需要正整数');
}

const [dataDir, storageDir] = positionals;
if (!dataDir || !storageDir) {
  fail('用法：node scripts/import-aigf-memes.mjs <aigf memes 数据目录> <hub storage 目录> [--max-count N]');
}

let stat;
try {
  stat = fs.statSync(dataDir);
} catch {
  fail(`数据目录不存在：${dataDir}`);
}
if (!stat.isDirectory()) fail(`数据目录不是目录：${dataDir}`);
if (!fs.existsSync(storageDir)) {
  console.error(`提示：storage 目录还不存在（${storageDir}），会是全新的一库——如果这不是本意，先检查路径。`);
}

const storage = new JsonStore({ dir: storageDir, log: (msg) => console.error(msg) });
const store = new MemeStore({ storage, maxCount, log: (msg) => console.error(msg) });

try {
  const summary = await store.importAigf(dataDir);
  const stats = store.stats;
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\n导入完成：候选 ${summary.candidates}，收下 ${summary.imported}` +
      `（管理员 ${summary.adminImported}、自动收集 ${summary.collectedImported}）；` +
      `去重 ${summary.skippedDuplicate}、缺文件 ${summary.skippedMissing}、` +
      `认不出类型 ${summary.skippedUnreadable}、超容量 ${summary.skippedOverCap}`,
  );
  console.log(`库现状：${stats.count} 个条目 / 容量 ${stats.capacity}，seq=${store.snapshot().seq}，索引在 ${storage.path('memes/index.json') ?? storageDir}`);
  console.log('启动/重启 DSH 后生效；跑之前请确认 hub 不在运行中（见文件头说明）。');
} catch (err) {
  fail(String(err?.message ?? err));
}
