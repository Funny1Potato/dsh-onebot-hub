/**
 * 公共契约快照（`node test/contract.mjs`；`node test/contract.mjs --update` 重新生成）。
 *
 * 为什么单独一个档：2026-11 起要把 `lib/index.js`（6800 行）拆成模块。搬代码最容易犯的错
 * 不是逻辑写错（那有 38 个测试档盯着），而是**搬丢了东西**——某个 export 忘了转出、
 * 某个工具名被改、`resolveConfig` 少算一个键。这类错不一定会让别的测试变红，
 * 但会让外部调用方（设置页、路由、别的插件）在真机上炸。
 *
 * 这里只冻结“对外可见的形状”，不冻行为：
 *   - `lib/index.js` 的导出名与类型
 *   - `Config` 的顶层键、`resolveConfig({})` 的键集
 *   - 指导语全文的 sha256 与长度
 *   - 全部 `onebot_*` 工具名（扫描源码，重构后仍应一致）
 *
 * 页面上的每一个设置格也算对外形状（`m78215` 补上）：不仅是键名不能变，
 * 它们的**默认值与类型**也不能在拆文件时惄惄变了——`resolveConfig({})` 不报错、
 * 测试也不变红，可用户第二天会发现本来开着的东西关了。
 *
 * 改契约是允许的，但要**显式**：跑 `--update` 生成新快照，并把 diff 一起提交——
 * 这样“我不小心改了一个字”会在 review 里被看见。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SNAPSHOT = join(here, 'contract.snapshot.json');
const update = process.argv.includes('--update');

const mod = await import('../lib/index.js');

/** 递归列出 `lib/` 下的所有 .js（跳过 media 里的大二进制同名文件之类）。 */
function listSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      listSources(full, out);
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** 工具名靠扫源码拿：`name: 'onebot_xxx'`（定义处不会用变量拼名字）。 */
function scanToolNames() {
  const names = new Set();
  for (const file of listSources(join(root, 'lib'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bname:\s*'(onebot_[a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** 从 `Config` 的字符串形状里数出顶层键（嵌套对象的键靠缩进/括号深度排除）。 */
function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\??:/.exec(text.slice(i));
      if (m && (i === 0 || /[\s,{]/.test(text[i - 1]))) {
        keys.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return [...new Set(keys)].sort();
}

/**
 * `resolveConfig({})` 摊平成"叶子路径 -> 默认值"，只留布尔、数字、字符串、null。
 *
 * 为什么不连数组一起冻：数组顺序不重要（下游名单、模型候选），而且一有新增就会因为
 * 结尾多一项而误报。这里要守的是"这个开关默认还是不是开着"，不是"名单有多长"。
 */
function mixedLeaves(obj, prefix = '', out = {}) {
  const walk = (value, path) => {
    if (Array.isArray(value)) return;
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], path ? `${path}.${key}` : key);
      return;
    }
    const type = value === null ? 'null' : typeof value;
    if (!['boolean', 'number', 'string', 'null'].includes(type)) return;
    out[path] = type === 'string' ? value : `${type}:${JSON.stringify(value)}`;
  };
  walk(obj, prefix);
  return out;
}

/**
 * 默认值进快照之前，先把"这台机器 / 这个平台 / 这个安装方式"抹掉。
 *
 * 契约冻结的是**形状**，不是别的东西。`0.13.0-beta.2` 第一次推上去连红三次，每次都是同一个病：
 *   1. `storageDir` 记成了 `C:\Users\94512\...`——换台机器就报"契约变了"；
 *   2. 只抹家目录还不够：ubuntu 上默认值是 `~/.dsh/onebot-hub`，`path.join` 出来是**斜杠**，
 *      windows 上是反斜杠，字符串照样不等；
 *   3. `exports.Config` 记的是 `function`——可 `@deepseek-ai/schemastery` 是 devDependency，
 *      CI 用 `npm install --omit=peer` 装不上它，`Config` 就成了 `undefined`。
 *
 * 于是规矩改成：**路径只比形状（段名与段数），不比分隔符与家目录**。
 */
function portableValue(value) {
  if (typeof value !== 'string') return value;
  if (!/[\\/]/.test(value)) return value;
  const segs = value.split(/[\\/]+/).filter((x) => x !== '');
  const home = String(process.env.USERPROFILE || process.env.HOME || '').trim();
  const homeSegs = home ? home.split(/[\\/]+/).filter(Boolean) : [];
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    // 用户目录整段换成 `<home>`（`C:\Users\x`、`/home/x`、`/Users/x` 都认）。
    if (homeSegs.length && segs.slice(i, i + homeSegs.length).join('/') === homeSegs.join('/')) {
      out.push('<home>');
      i += homeSegs.length - 1;
      continue;
    }
    if (/^[A-Za-z]:$/.test(segs[i])) continue;
    if (i === 0 && /^(Users|home|root)$/.test(segs[i])) {
      out.push('<home>');
      continue;
    }
    out.push(segs[i]);
  }
  return out.join('/');
}

const guidance = String(mod.buildHubGuidance({}) ?? '');
const resolved = mod.resolveConfig({});

/** 这次跑的是不是"真宿主"：`Config` 只在装得到 schemastery 时才存在。 */
const runtime = {
  configSchema: typeof mod.Config === 'function',
};

const current = {
  exports: Object.fromEntries(
    Object.keys(mod)
      .filter((k) => k !== 'default')
      .sort()
      .map((k) => [k, typeof mod[k]]),
  ),
  configKeys: topLevelKeys(String(mod.Config ?? '')),
  resolveKeys: Object.keys(resolved).sort(),
  guidance: {
    length: guidance.length,
    sha256: createHash('sha256').update(guidance).digest('hex'),
  },
  toolNames: scanToolNames(),
  defaults: Object.fromEntries(Object.entries(mixedLeaves(resolved)).map(([k, v]) => [k, portableValue(v)])),
};

const describe = (snap) => ({
  exports: Object.keys(snap.exports ?? {}).length,
  configKeys: (snap.configKeys ?? []).length,
  resolveKeys: (snap.resolveKeys ?? []).length,
  guidance: snap.guidance?.length ?? 0,
  toolNames: (snap.toolNames ?? []).length,
  defaults: Object.keys(snap.defaults ?? {}).length,
});

if (update || !existsSync(SNAPSHOT)) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log(`[contract] 已写入快照 ${relative(root, SNAPSHOT)}：`, describe(current));
  process.exit(0);
}

const saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
let failed = 0;

/** 对比一组键：少了/多了都点名，免得只看到一句“不相等”。 */
function sameSet(label, a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  const missing = a.filter((x) => !sb.has(x));
  const added = b.filter((x) => !sa.has(x));
  try {
    assert.deepEqual([...sa].sort(), [...sb].sort(), `${label} 变了`);
    return true;
  } catch {
    failed += 1;
    console.log(`✗ ${label}`);
    if (missing.length) console.log(`    少了：${missing.join(', ')}`);
    if (added.length) console.log(`    多了：${added.join(', ')}`);
    return false;
  }
}

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(true);
  } catch (err) {
    failed += 1;
    checks.push(false);
    console.log(`✗ ${name}\n    ${String(err?.message ?? err)}`);
  }
};

/**
 * 快照里记的 `Config` 是"真宿主里长什么样"：`function`。
 * 环境装不到 schemastery 时（CI 用 `--omit=peer`，它是 devDependency），`Config` 本来就会是
 * `undefined`——那不是契约变了，是**这次没能力验**。所以按快照里的 `runtime.configSchema`
 * 决定这一格是"必须对"还是"跳过"，而不是把它冻成 `undefined` 让本地永远红。
 * 依据是**这次跑出来的** `runtime`（不是快照里那份）：快照记的是"真宿主应当有"，环境说了不算。
 */
const needConfigSchema = runtime.configSchema === true;

check('导出面没变', () => {
  const names = Object.keys(saved.exports);
  sameSet('导出名', names, Object.keys(current.exports));
  for (const name of names) {
    if (name === 'Config' && !needConfigSchema) continue;
    const type = saved.exports[name];
    assert.equal(current.exports[name], type, `导出 ${name} 的类型从 ${type} 变成了 ${current.exports[name]}`);
  }
});

// 同上：`Config` 建不出来时这一格无从比，跳过而不是判红。
check('Config 顶层键没变', () => (needConfigSchema ? sameSet('Config 顶层键', saved.configKeys, current.configKeys) : true));
check('resolveConfig 键集没变', () => sameSet('resolveConfig 键', saved.resolveKeys, current.resolveKeys));
check('工具名单没变', () => sameSet('工具名', saved.toolNames, current.toolNames));

check('配置格默认值没变', () => {
  const old = saved.defaults ?? {};
  const now = current.defaults;
  if (!Object.keys(old).length) return;
  sameSet('配置格键', Object.keys(old), Object.keys(now));
  const changed = [];
  for (const key of Object.keys(old)) {
    if (!(key in now)) continue;
    if (String(old[key]) !== String(now[key])) changed.push(`${key}: ${old[key]} -> ${now[key]}`);
  }
  assert.deepEqual(changed, [], `默认值变了（确实想改就 --update 并把 diff 一起提交）：\n    ${changed.join('\n    ')}`);
});

check('指导语没变', () => {
  assert.equal(current.guidance.length, saved.guidance.length, `指导语长度 ${saved.guidance.length} → ${current.guidance.length}`);
  assert.equal(current.guidance.sha256, saved.guidance.sha256, '指导语全文变了（改了措辞就要 --update 并一起提交 diff）');
});

const passed = checks.filter(Boolean).length;
console.log(`\n[contract] ${passed}/${checks.length} 通过`);
if (failed) {
  console.log('[contract] 若是**有意**改契约：node test/contract.mjs --update，并把快照 diff 一起提交');
  process.exit(1);
}
