/**
 * 打包面检查（配置 UI）：浏览器半侧与 manifest 的连线一处都不能少。
 *
 * 为什么值得单独测：这四处任意一处写错，表现都是**设置里安安静静什么都不出现**
 * （没有报错、没有日志），排查成本极高——本插件就真出过一次"配置页没了"：
 * 只把字段标了 volatile，却以为宿主会自动生成表单，而
 * `@deepseek-ai/dsh-settings` 明确写着「no shipped client does so yet」。
 * 所以这里把"必须自己带页面"的契约钉死。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err?.message ?? String(err) });
  }
};

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const clientPath = path.join(root, 'lib', 'client.js');
const clientText = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : '';

// 枚举取值的**宿主侧单一出处**（都是纯模块，直接 import 不碰宿主服务）。
const [
  { AGENT_MODES },
  { VISION_MODES },
  { ISOLATION_LEVELS, CROSS_GROUP_FACTS, PRIVATE_FACTS },
  { ANIME_BACKENDS },
  { PRESETS, DELIVERY_MODES, PROBE_ISOLATIONS },
  { DOWNSTREAM_TYPES },
  { MODEL_LIST_PATH },
] = await Promise.all([
  import('../lib/agent/policy.js'),
  import('../lib/vision.js'),
  import('../lib/memory/isolation.js'),
  import('../lib/vision/anime.js'),
  import('../lib/router.js'),
  import('../lib/index.js'),
  import('../lib/llm-models.js'),
]);

/** 把 `const <marker> = {…}` 抠出来（括号配对，跳过字符串）并 JSON.parse。 */
const objectLiteralOf = (marker) => {
  const at = clientText.indexOf(`const ${marker} = `);
  assert.ok(at >= 0, `client.js 里找不到 \`const ${marker} = \``);
  const start = clientText.indexOf('{', at);
  assert.ok(start > at, `${marker} 后面不是对象字面量`);
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let i = start; i < clientText.length; i += 1) {
    const ch = clientText[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > start, `${marker} 的括号没配平`);
  // 严格 JSON 是**有意的**：宿主代码 import 不到浏览器半侧，只能靠这份表；
  // 用 JSON.parse 当校验，顺带保证"测试抠得出来"这件事一直成立。
  return JSON.parse(clientText.slice(start, end));
};

/** 把 `const ENUM_OPTIONS = {…}` 抠出来并 JSON.parse。 */
const enumOptionsOf = () => objectLiteralOf('ENUM_OPTIONS');

check('manifest：声明了 dsh.client 与 ./client 出口，且文件真的存在', () => {
  const client = manifest.dsh && manifest.dsh.client;
  assert.ok(client, 'dsh.client 缺失：宿主 dsh-client-modules 根本不会挂载浏览器半侧');
  assert.equal(client.platform, 'web');
  // profile 里 24 个既有客户端插件没有一个标 immediately；`packages\client\AGENTS.md:144`
  // 也只允许"stage-one 预取的基础设施行"标。普通行标了会被提前塞进共享 application
  // 批次，一个坏脚本连累整批（历史崩溃日志里就是这个形态）。
  assert.equal(client.immediately, undefined, 'immediately 只给基础设施行，普通功能行不许标');
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), '要等设置页在，才能往 settings.section 里注册');
  assert.equal(manifest.exports?.['./client']?.default, './lib/client.js');
  assert.ok(fs.existsSync(clientPath), 'lib/client.js 不存在');
});

check('manifest：浏览器半侧的位置与形状照既有客户端插件（lib/client.js）', () => {
  // profile 的 node_modules 里 24 个能用的客户端插件全在 `lib/client.js`，
  // 且 factory 自建 module/exports、末尾 `return module.exports`。
  assert.ok(!fs.existsSync(path.join(root, 'client.js')), '旧的包根 client.js 应已挪进 lib/');
  assert.match(clientText, /factory:\s*\(require\)\s*=>\s*\{/, 'factory 用箭头函数并自建 module/exports（照抄既有写法）');
  assert.match(clientText, /var exports = module\.exports;/, '自己搭 exports');
  assert.match(clientText, /exports\.apply = apply;/, 'apply 挂到 exports 上');
  assert.match(clientText, /exports\.inject = inject;/, 'inject 挂到 exports 上');
  assert.match(clientText, /return module\.exports;/, 'factory 必须返回 module.exports');
});

check('client.js：apply 绝不许抛（抛一次就把整个 web boot 拖死）', () => {
  // `packages\client\web\src\boot-client.ts:83`：非 active 的条目会被
  // `web boot: N entries did not activate` 拒掉，桌面壳直接放弃启动——
  // 本插件真把 App 拖死过一次（注册失败被 rethrow）。
  assert.match(clientText, /const runApply = \(ctx\) => \{/, '装配体要单独成函数，便于整段兜住');
  assert.match(clientText, /const apply = \(ctx\) => \{\s*try \{\s*runApply\(ctx\);/, 'apply 必须把 runApply 包在 try 里');
  assert.match(clientText, /客户端装配抛出/, '兜底 catch 要如实上报');
  assert.ok(!/throw err;/.test(clientText), 'apply 路径上不许出现 throw err');
  assert.match(clientText, /registerSection\(/, '注册失败要走 registerSection（内含 try/catch + no-op disposer）');
  assert.match(clientText, /typeof off === 'function' \? off : \(\(\) => \{\}\)/, '注册成功要回 disposer，失败要回 no-op');
});

check('client.js：读到的服务必须都写在 inject 里（漏一个就是整壳起不来）', () => {
  // 真事故：`apply` 里一句 `!!(ctx && ctx.configForms)`，而 inject 只写了 ['slots']。
  // cordis 的 ctx 是反射代理，`vendor\cordis\src\reflect.ts:144` 对没 inject 的属性
  // 直接抛 `cannot get property "configForms" without inject` → apply 抛 → 条目 FAILED
  // → `web boot: 1 entry did not activate` → 桌面壳拒绝启动。这里把契约钉死。
  const declaredMatch = /exports\.inject = (\[[^\]]*\])/.exec(clientText);
  assert.ok(declaredMatch, '找不到 `exports.inject = [...]`');
  const declared = (declaredMatch[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  assert.ok(declared.includes('slots'), 'slots 必须 inject：注册座位要用');
  assert.ok(declared.includes('configForms'), 'configForms 必须 inject：读配置要用');
  // ctx 自带的非服务成员（读它们不受 inject 约束）
  const builtins = new Set(['reflect', 'events', 'fiber', 'root', 'scope', 'get', 'set', 'isolate', 'logger', 'registry']);
  // 注释里也会写 `ctx.xxx` 举例子，先剥掉注释再扫代码
  const code = clientText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\n]*\/\/.*$/gm, '');
  const used = new Set();
  for (const match of code.matchAll(/\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!builtins.has(match[1])) used.add(match[1]);
  }
  for (const name of used) {
    assert.ok(
      declared.includes(name),
      `ctx.${name} 被读了却没写进 inject，会抛 cannot get property "${name}" without inject；当前 inject=${declared.join(' / ')}`,
    );
  }
});

check('client.js：模块加载器声明，id 必须等于包名', () => {
  assert.match(clientText, /window\.__ModuleLoader__\.load\(/, '必须是模块加载器声明（不经构建）');
  assert.match(clientText, new RegExp(`id:\\s*'${manifest.name.replace(/[/@.]/g, (m) => `\\${m}`)}'`), 'id 与包名不一致：宿主按包名挂载这一行，对不上就永远不加载');
  assert.ok(!/^\s*export\s/m.test(clientText), '浏览器半侧由加载器直接执行，出现 ESM export 会直接语法错误');
});

check('client.js：注册进 settings.section，并走 configForms 读写', () => {
  assert.match(clientText, /exports\.inject = \[[^\]]*'slots'[^\]]*\]/, '要 inject slots 才拿得到槽位服务');
  assert.match(clientText, /settings\.section/, '没有注册设置页入口，就等于没做 UI');
  assert.match(clientText, /ctx\.configForms/, '必须经 configForms 读值/写值，别自己发明 RPC');
  assert.match(clientText, /\.mutate\(/, '写入只能走 ConfigForm.mutate（带 revision 栅栏）');
  // 颜色只允许主题 token：写死颜色会在浅色/深色切换里瞎掉。
  const literalColors = clientText.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(literalColors, [], `出现写死颜色：${literalColors.join(', ')}`);
});

check('client.js：命名空间按"含 onebot-hub"匹配，不依赖 include: 前缀形态', () => {
  assert.match(clientText, /onebot-hub/, '要能认出自己的命名空间');
  assert.match(clientText, /endsWith|includes/, '命名空间可能是 onebot-hub 或 include:onebot-hub，必须模糊匹配');
});

check('client.js：只用宿主保证暴露的 React 面，其余 hook 必须"在才用"', () => {
  // 宿主对动态客户端半侧公开的 React 签名只有 createElement/useState/useEffect
  // （client `Builtin` 目录）。用了没保证的 hook，一旦没有就是整页空白。
  assert.match(clientText, /React\.createElement/, '要用 createElement（不经 JSX 构建）');
  assert.match(clientText, /React\.useState\(/, '要有 useState');
  assert.match(clientText, /React\.useEffect\(/, '要有 useEffect');
  for (const forbidden of ['React.useRef(', 'React.useContext(', 'React.useCallback(', 'React.useLayoutEffect(', 'React.Component', 'React.Fragment']) {
    assert.ok(!clientText.includes(forbidden), `用了宿主不保证的 ${forbidden}`);
  }
  if (clientText.includes('React.useMemo(')) {
    assert.match(clientText, /typeof React\.useMemo === 'function'/, 'useMemo 必须先判断存在再用，否则宿主没有它就是白页');
  }
});

check('client.js：任何失败都要变成页面上的文字，不能 throw 出去', () => {
  // 槽位条目一抛错整页就是白的（`slot entry crashed in '<slot>'`），
  // 用户屏幕上只会看到"入口在、里面没东西"，连报错都没有。
  assert.match(clientText, /catch\s*\(err\)/, '要有 try/catch 兜住渲染与订阅');
  assert.match(clientText, /渲染出错/, '渲染失败要在页面上说明');
  assert.match(clientText, /safeCall\(/, '订阅/快照/写入都要经 safeCall 兜住');
  assert.match(clientText, /命名空间/, '找不到命名空间时要把宿主提供过哪些命名空间列出来，便于排查');
});

check('client.js：浏览器侧的错误必须自己送回宿主（能不开控制台就分诊）', () => {
  // 设置页空白时，唯一可靠的证据在浏览器控制台里；宿主不落盘渲染进程日志，
  // 所以我方必须有一条回传路径：用 __ONEBOT_HUB_PROBE__，没有就自己装一个最小的。
  assert.match(clientText, /__ONEBOT_HUB_PROBE__/, '要复用宿主注入的 head 探针');
  assert.match(clientText, /\/onebot-hub\/client-report/, '上报路径必须与 lib/client-probe.js 的 CLIENT_PROBE_PATH 一致');
  assert.match(clientText, /globalThis\.__ONEBOT_HUB_PROBE__\s*=/, '探针不在时要自己装兜底版');
  assert.match(clientText, /report\('client-half'/, '至少要有客户端半侧里程碑上报');
  assert.match(clientText, /report\(\s*'render'|report\('render'/, '渲染失败也要上报，而不只是画在页面上');
});

check('client.js：枚举字段渲染成下拉（带"自定义…"逃生口）', () => {
  // 用户的诉求：`agent.mode` 这类"只有几个值"的字段别再让人手打（打错就静默退回默认）。
  assert.match(clientText, /const ENUM_OPTIONS = \{/, '要有枚举表');
  assert.match(clientText, /ENUM_OPTIONS\[field\.key\]/, 'renderRow 要按字段键查枚举表');
  assert.match(clientText, /h\('select'/, '命中枚举要渲染 select');
  assert.match(clientText, /__custom__/, '要有"自定义…"，否则手工写过/老配置里的值没法保留下来改');
  assert.match(clientText, /回到下拉/, '自定义态要能切回下拉');
});

check('client.js：枚举下拉的取值与宿主的单一出处一致（两边不许漂移）', () => {
  const table = enumOptionsOf();
  const expect = {
    preset: Object.keys(PRESETS),
    deliveryMode: Object.keys(DELIVERY_MODES),
    'agent.mode': AGENT_MODES,
    'vision.mode': VISION_MODES,
    'probe.isolation': PROBE_ISOLATIONS,
    'anime.backend': ANIME_BACKENDS,
    'memory.isolation.level': ISOLATION_LEVELS,
    'memory.isolation.crossGroupFacts': CROSS_GROUP_FACTS,
    'memory.isolation.privateFacts': PRIVATE_FACTS,
  };
  for (const [key, values] of Object.entries(expect)) {
    const row = table[key];
    assert.ok(Array.isArray(row) && row.length > 0, `ENUM_OPTIONS 缺 ${key}`);
    const got = row.map((option) => option && option.value);
    assert.deepEqual([...got].sort(), [...values].sort(), `${key} 下拉取值与宿主不一致：下拉=${got.join('/')} 宿主=${values.join('/')}`);
    for (const option of row) {
      assert.ok(typeof option.label === 'string' && option.label.length > 0, `${key} 的选项 ${option.value} 缺 label`);
    }
  }
  // 键集本身也要盯住：新增/去掉枚举键都该在这里显式过一遍（免得"以为加了其实没加"）。
  assert.deepEqual(Object.keys(table).sort(), Object.keys(expect).sort(), 'ENUM_OPTIONS 的键集与宿主枚举清单不一致');
});

check('client.js：模型清单路由的字面量与宿主那份一致（不一致 = 永远取不到清单）', () => {
  // 用户诉求：默认模型"从 DSH 的模型列表里选"。浏览器半侧没有 `llm` 服务（inject 只有
  // slots/configForms），所以选项只能经一条只读路由取回来；两边路径必须逐字相同。
  assert.ok(typeof MODEL_LIST_PATH === 'string' && MODEL_LIST_PATH.startsWith('/'), '宿主侧要导出模型清单路径');
  assert.ok(
    clientText.includes(`'${MODEL_LIST_PATH}'`),
    `client.js 里的路由路径要与 lib/llm-models.js 的 MODEL_LIST_PATH 一致（${MODEL_LIST_PATH}）`,
  );
  assert.match(clientText, /fetchModelList/, '要有取清单的函数');
  assert.match(clientText, /modelListCache/, '同一页反复进出别每次都问宿主要');
  assert.match(clientText, /没取到 DSH 的模型清单/, '取不到时要在页面上说清楚为什么退回手写');
  // 档位必须由宿主问出来：`llm.listModels()` 给的 `LlmModelInfo` **不含 reasoning**，
  // 只有 `llm.resolveModelInfo()` 才有 `reasoning.efforts`（浏览器半侧自己问不了）。
  const routeText = fs.readFileSync(path.join(root, 'lib', 'llm-models.js'), 'utf8');
  assert.match(routeText, /resolveModelInfo/, '宿主路由要用 resolveModelInfo 取 reasoning 档位');
  assert.match(routeText, /listProviders[\s\S]*listModels|listModels/, '宿主路由要列 provider 与模型');
});

check('client.js：模型两行出下拉、思考强度两行只列配对模型声明的档位', () => {
  const table = objectLiteralOf('MODEL_FIELDS');
  assert.deepEqual(
    Object.keys(table).sort(),
    ['agent.defaultModel', 'agent.defaultReasoningEffort', 'agent.defaultVisionModel', 'agent.defaultVisionReasoningEffort'].sort(),
    'MODEL_FIELDS 的键集要与宿主 schema 的这四个字段对齐',
  );
  for (const [key, spec] of Object.entries(table)) {
    assert.ok(spec.kind === 'model' || spec.kind === 'effort', `${key} 的 kind 只能是 model/effort`);
    if (spec.kind === 'effort') {
      assert.ok(spec.modelKey && table[spec.modelKey] && table[spec.modelKey].kind === 'model',
        `${key} 要指着一个 model 字段（档位得跟着那个模型的 reasoning 走）`);
    }
  }
  // 四个字段都必须在 FIELD_TEXT 里有中文名与说明（缺了就只剩一个裸下拉框）。
  const texts = objectLiteralOf('FIELD_TEXT');
  for (const key of Object.keys(table)) {
    const text = texts[key];
    assert.ok(text && typeof text.label === 'string' && text.label.length > 0, `FIELD_TEXT 缺 ${key} 的中文名`);
    assert.ok(typeof text.note === 'string' && text.note.length > 0, `FIELD_TEXT 缺 ${key} 的说明`);
  }
  assert.match(clientText, /MODEL_FIELDS\[field\.key\]/, 'renderRow 要按字段键查模型表');
  assert.match(clientText, /efforts/, '档位要读清单里的 efforts（上游声明了什么就是什么）');
});

check('client.js：列表型字段（多下游）有行编辑器，且列名与宿主认的字段对齐', () => {
  // 用户的诉求：多条下游要能像 LLBot 的 connect[] 那样加/删/逐条停用，而不是手写长 JSON。
  assert.match(clientText, /const LIST_EDITORS = \{/, '要有列表编辑器规格表');
  assert.match(clientText, /renderListEditor/, 'renderRow 要接上列表编辑器');
  assert.match(clientText, /添加一个下游|addLabel/, '要能加一条');
  assert.match(clientText, /以 JSON 编辑/, '要留手工改 JSON 的逃生口');
  const table = objectLiteralOf('LIST_EDITORS');
  assert.deepEqual(
    Object.keys(table),
    ['downstreamTargets', 'code.scopes', 'agent.groups', 'agent.privates'],
    '下游目标、源码范围与两张会话白名单都要结构化编辑',
  );
  const spec = table.downstreamTargets;
  assert.equal(spec.kind, 'targets', '缺 kind = 行编辑器不知道按哪套字段清洗');
  assert.ok(typeof spec.addLabel === 'string' && spec.addLabel.length > 0, '缺"添加"按钮文案');
  const columns = [];
  for (const column of spec.columns) {
    assert.ok(typeof column.key === 'string' && column.key, '列缺 key');
    assert.ok(typeof column.label === 'string' && column.label, `列 ${column.key} 缺中文名`);
    columns.push(column.key);
  }
  // 列必须落在宿主 `normalizeTargets` 认的字段里——写一个它不认识的键 = 静默丢失。
  const known = new Set(['id', 'type', 'address', 'url', 'selfId', 'nickname', 'accessToken', 'reconnectInterval', 'enabled', 'probeOnly', 'probeSelfId', 'probe_self_id', 'downstreamId']);
  for (const key of columns) assert.ok(known.has(key), `列 ${key} 不是宿主认的目标字段（会被静默丢掉）`);
  for (const required of ['type', 'address']) assert.ok(columns.includes(required), `列里必须有 ${required}`);
  // 类型列必须是**枚举**（四种连接形态，别让人手打字符串）。
  const typeColumn = spec.columns.find((column) => column.key === 'type');
  assert.ok(Array.isArray(typeColumn.options) && typeColumn.options.length === 4, '类型列要是 4 个选项的下拉');
  assert.deepEqual(
    typeColumn.options.map((option) => option.value),
    DOWNSTREAM_TYPES,
    '类型选项与宿主 DOWNSTREAM_TYPES 必须一致',
  );
  // 源码范围（m14477）：列必须落在 `parseCodeScopes` 认的键上（name/path）。
  const scopes = table['code.scopes'];
  assert.equal(scopes.kind, 'scopes');
  assert.ok(typeof scopes.addLabel === 'string' && scopes.addLabel.length > 0, '缺"添加"按钮文案');
  const scopeKeys = scopes.columns.map((column) => column.key);
  assert.deepEqual(scopeKeys, ['name', 'path'], '只认 name / path，多写一个键就会被解析器丢掉');
  assert.equal(scopes.columns.some((column) => Array.isArray(column.options)), false, '范围没有枚举列');
  // 会话白名单（m31030）：群号/QQ号 + 模式下拉，两张名单同一套列。
  for (const key of ['agent.groups', 'agent.privates']) {
    const spec = table[key];
    assert.equal(spec.kind, 'whitelist', `${key} 缺 kind`);
    assert.ok(typeof spec.addLabel === 'string' && spec.addLabel.length > 0, `${key} 缺"添加"按钮文案`);
    const columnKeys = spec.columns.map((column) => column.key);
    assert.deepEqual(columnKeys, ['id', 'mode'], `${key} 只认 id / mode`);
    const modeColumn = spec.columns.find((column) => column.key === 'mode');
    assert.ok(Array.isArray(modeColumn.options) && modeColumn.options.length === 4, `${key} 模式列要含"跟随全局"与三档`);
    assert.ok(modeColumn.options.some((option) => option.value === ''), `${key} 模式列缺"跟随全局"空值项`);
  }
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `  ← ${row.error}`}`);
console.log(`\nclient-manifest: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
