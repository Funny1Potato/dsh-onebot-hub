/**
 * 渲染面真跑一遍（配置 UI）：把 `lib/client.js` 在假 React + 假 configForms 里
 * 完整执行、注册、渲染，而不是"用正则看文件里有没有 select"。
 *
 * 为什么值得这么麻烦：设置页这条链已经出过两次"整壳起不来 / 页面空白"，
 * 都是**运行期**问题（apply 抛、注册抛、hook 面不够），静态检查看不见。
 * 这里断言的是行为：枚举字段渲染成下拉、下拉显示当前值、改了再保存写回正确的 op，
 * 以及"过程里一个错误都没上报"。
 *
 * 不依赖浏览器与宿主：纯 node + `vm`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const clientText = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err?.message ?? String(err) });
  }
};

/** 最小的 React：createElement 出普通对象树、useState 真存状态、useEffect 只收集。 */
const makeReact = () => {
  const states = [];
  const effects = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}) },
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && typeof child !== 'boolean'),
    }),
    useState: (init) => {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof init === 'function' ? init() : init;
      return [states[at], (next) => { states[at] = typeof next === 'function' ? next(states[at]) : next; }];
    },
    useEffect: (fn) => { effects.push(fn); },
  };
  return { React, effects, reset: () => { cursor = 0; } };
};

/** 跑一遍浏览器半侧，返回能反复渲染的组件与收集到的写入。 */
const boot = (value, { withForms = true, value2Throw = false, user = {}, secrets = [], snapSecrets = null, fetchImpl = null } = {}) => {
  const { React, reset, effects } = makeReact();
  const registrations = [];
  const injections = [];
  const mutations = [];
  const formSnap = { status: 'ready', value, base: undefined, user, revision: 7, writable: true, mode: 'host', ...(snapSecrets ? { secrets: snapSecrets } : {}) };
  const form = {
    getSnapshot: () => formSnap,
    subscribe: () => () => {},
    mutate: async (ops) => { mutations.push(ops); return true; },
    set: async () => true,
    unset: async () => true,
  };
  // 真宿主的形状是 `describe()` → `{ namespaces: [namespaceView…] }`，`secrets` 在**命名空间那一层**
  // （`namespaceView(descriptor)` 里才有 `secrets`），不是 `view` 顶层。
  const view = { namespaces: [{ ns: 'onebot-hub', value, secrets }] };
  const mirror = { getSnapshot: () => ({ view }), subscribe: () => () => {}, ensure: () => {} };
  const ctx = {
    slots: {
      register: (spec, component) => { registrations.push({ spec, component }); return () => {}; },
      inject: (seat, callback) => { injections.push({ seat, callback }); return () => {}; },
    },
  };
  if (withForms) {
    ctx.configForms = { describe: () => mirror, get: (asked) => (asked === 'onebot-hub' ? form : undefined) };
  } else if (value2Throw) {
    // 真宿主里读没 inject 的服务是**抛**（反射代理），不是 undefined——照这个形态测降级路径。
    Object.defineProperty(ctx, 'configForms', {
      get() { throw new Error('cannot get property "configForms" without inject'); },
    });
  }

  let captured;
  const sandbox = {
    window: { addEventListener: () => {} },
    document: {},
    location: { search: '', href: 'http://localhost/settings' },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    setTimeout: () => 0,
    fetch: fetchImpl || (async () => ({ ok: true })),
  };
  sandbox.window.__ModuleLoader__ = { load: (spec) => { captured = spec; } };
  vm.createContext(sandbox);
  vm.runInContext(clientText, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured, 'client.js 没调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-onebot-hub');

  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`意外 require：${name}`);
  });
  mod.apply(ctx);
  assert.deepEqual(injections.map((row) => row.seat), ['settings.section'], '只该往 settings.section 注入一次');
  injections[0].callback();
  assert.equal(registrations.length, 1, 'settings.section 应该正好注册一次');
  assert.equal(registrations[0].spec.name, 'settings.section');

  const Page = registrations[0].component;
  // 假 React 的 `useEffect` 只收集不执行；这里手动跑一遍（去重），才能测"取到清单之后才出下拉"。
  let effectCursor = 0;
  const runEffects = async () => {
    const batch = effects.slice(effectCursor);
    effectCursor = effects.length;
    for (const fn of batch) await fn();
  };
  return {
    mutations,
    runEffects,
    // 跑一轮"渲染 → 跑 effect → 再渲染"：effect 里读到的必须是**上一轮渲染后**的 state
    // （挂载标志还没生效就发请求会拿到闭包旧值），所以中间必须真渲染一次。
    settle: async () => { reset(); Page(); await runEffects(); reset(); return Page(); },
    reports: () => (sandbox.__ONEBOT_HUB_PROBE__ && sandbox.__ONEBOT_HUB_PROBE__.dump()) || [],
    render: () => { reset(); return Page(); },
  };
};

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
};

/** 标签列里那个 `<code>` 就是**完整配置键**（键必须可见：用户要拿它去 cordis.patch.yml 里对照）。 */
const keyOfLabel = (label) => {
  let found;
  walk(label, (node) => { if (found === undefined && node.type === 'code') found = textOf(node); });
  return found;
};

/** 行 → 控件：行的第一个孩子是标签列（含中文名 + 配置键 + 说明），第二格是控件。 */
const controlsFor = (tree) => {
  const out = new Map();
  walk(tree, (node) => {
    if (node.type !== 'div' || !Array.isArray(node.children)) return;
    const label = node.children[0];
    if (!label || label.type !== 'div' || !Array.isArray(label.children)) return;
    const key = keyOfLabel(label);
    if (typeof key !== 'string') return;
    const cell = node.children[1];
    const control = cell && Array.isArray(cell.children) ? cell.children[0] : undefined;
    if (control && control.type) out.set(key, control);
  });
  return out;
};

/** 行 → 标签列整段文字（中文名 + 键 + 说明），用来断言"每个字段都有人话"。 */
const labelsFor = (tree) => {
  const out = new Map();
  walk(tree, (node) => {
    if (node.type !== 'div' || !Array.isArray(node.children)) return;
    const label = node.children[0];
    if (!label || label.type !== 'div' || !Array.isArray(label.children)) return;
    const key = keyOfLabel(label);
    if (typeof key !== 'string') return;
    let text = '';
    walk(label, (inner) => { text += textOf(inner); });
    out.set(key, text);
  });
  return out;
};

const buttonsOf = (tree) => {
  const out = [];
  walk(tree, (node) => { if (node.type === 'button') out.push(node); });
  return out;
};

const textOf = (node) => (node.children || []).filter((child) => typeof child === 'string').join('');

const optionValues = (select) => select.children.map((option) => option.props.value);
const optionLabels = (select) => select.children.map((option) => textOf(option));

/** 行 → 控件格里的提示文字（档位行为什么没有下拉，就写在这里）。 */
const hintFor = (tree, key) => {
  let found = '';
  walk(tree, (node) => {
    if (found || node.type !== 'div' || !Array.isArray(node.children)) return;
    const label = node.children[0];
    if (!label || label.type !== 'div' || !Array.isArray(label.children)) return;
    if (keyOfLabel(label) !== key) return;
    for (const child of (node.children[1]?.children || [])) {
      if (child && child.type === 'div' && child.props?.key === 'hint') found += textOf(child);
    }
  });
  return found;
};

const BASE_VALUE = {
  preset: 'relay',
  deliveryMode: 'transparent',
  upstreamUrl: '',
  upstreamListen: '127.0.0.1:14514',
  downstreamTargets: '[{"type":"ws-dial","address":"127.0.0.1:8080/onebot/v11/ws","selfId":"30001"},{"type":"ws-listen","address":"127.0.0.1:8654/onebot/v11/ws","enabled":false}]',
  agent: { mode: 'assist' },
  vision: { mode: 'describe' },
  anime: { backend: 'off' },
  memory: { isolation: { level: 'scoped', crossGroupFacts: 'shareable', privateFacts: 'never' } },
};

await check('枚举字段渲染成下拉，且默认选中当前值', () => {
  const app = boot(BASE_VALUE);
  const controls = controlsFor(app.render());
  const expected = {
    preset: ['relay', 'solo', 'shadow', 'bridge', 'fabric'],
    deliveryMode: ['transparent', 'replay', 'synthesize'],
    'agent.mode': ['assist', 'observer', 'active'],
    'vision.mode': ['describe', 'segment', 'both', 'off'],
    'anime.backend': ['off', 'anime-recognize', 'animetrace', 'both'],
    'memory.isolation.level': ['scoped', 'strict', 'balanced', 'open'],
    'memory.isolation.crossGroupFacts': ['shareable', 'never', 'all'],
    'memory.isolation.privateFacts': ['never', 'sameActor', 'all'],
  };
  for (const [key, values] of Object.entries(expected)) {
    const control = controls.get(key);
    assert.ok(control, `找不到 ${key} 这一行的控件`);
    assert.equal(control.type, 'select', `${key} 应该是下拉，实际是 ${control.type}`);
    // 多出来的那一个固定是"自定义…"逃生口
    assert.deepEqual(optionValues(control), [...values, '__custom__'], `${key} 的选项不对`);
    for (const label of optionLabels(control).slice(0, values.length)) assert.ok(label.length > 0, `${key} 有空标签`);
  }
  assert.equal(controls.get('agent.mode').props.value, 'assist', '下拉要先显示当前值');
  assert.equal(controls.get('preset').props.value, 'relay');
  // 非枚举字段保持原样（文本框），别把什么都做成下拉
  const url = controls.get('upstreamUrl');
  assert.equal(url.type, 'input');
  assert.equal(url.props.type, 'text');
  const reports = app.reports().map((row) => row.kind);
  assert.ok(!reports.includes('apply'), `装配不该出错：${JSON.stringify(app.reports())}`);
  assert.ok(!reports.includes('render'), '渲染不该出错');
  assert.ok(reports.includes('page'), '渲染成功要有 page 里程碑');
});

await check('下拉改值 → 保存 → 写回的 op 正确（这是本功能的全部意义）', async () => {
  const app = boot(BASE_VALUE);
  const select = controlsFor(app.render()).get('agent.mode');
  select.props.onChange({ target: { value: 'active' } });
  const second = controlsFor(app.render());
  assert.equal(second.get('agent.mode').props.value, 'active', '改完要显示新选的值');
  const save = buttonsOf(app.render()).find((button) => textOf(button).startsWith('保存'));
  assert.ok(save, '找不到保存按钮');
  assert.equal(textOf(save), '保存 1 项', '改了一项就该提示一项');
  assert.equal(save.props.disabled, false, '有改动时保存按钮要可点');
  save.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    // 跨 vm realm 的对象原型不同，deepEqual 会嫌"结构一样但不是同一个引用"，走一趟 JSON。
    JSON.parse(JSON.stringify(app.mutations)),
    [[{ op: 'set', path: ['agent', 'mode'], value: 'active' }]],
  );
});

await check('当前值不在预设里：如实显示、不静默改写，且能切到"自定义…"', () => {
  const app = boot({ ...BASE_VALUE, agent: { mode: 'weird' } });
  const select = controlsFor(app.render()).get('agent.mode');
  assert.equal(select.props.value, '', '不在预设里的值不能被静默改成别的');
  const unknown = optionLabels(select).find((label) => label.includes('不在预设里'));
  assert.ok(unknown, '要如实列出"当前值不在预设里"这一项');
  assert.ok(unknown.includes('weird'), `提示里要带上原值：${unknown}`);

  select.props.onChange({ target: { value: '__custom__' } });
  const custom = controlsFor(app.render()).get('agent.mode');
  assert.equal(custom.type, 'span', '自定义态该是一段"输入框 + 回到下拉"');
  const input = custom.children.find((child) => child.type === 'input');
  assert.ok(input, '自定义态要有文本框');
  assert.equal(input.props.value, 'weird', '切过去不该丢掉原值');
  const back = custom.children.find((child) => child.type === 'button');
  assert.equal(textOf(back), '回到下拉');
  back.props.onClick();
  assert.equal(controlsFor(app.render()).get('agent.mode').type, 'select', '能切回下拉');
  assert.deepEqual(app.mutations, [], '只是切换控件不该写任何东西');
});

await check('每个配置项都有人话：中文名 + 完整配置键 + 一句说明', () => {
  const app = boot(BASE_VALUE);
  const labels = labelsFor(app.render());
  assert.ok(labels.size > 0, '一个标签都没渲染出来');
  const han = /[\u4e00-\u9fff]/;
  for (const [key, text] of labels) {
    assert.ok(text.includes(key), `${key} 的标签里必须能看到完整配置键（用户要拿它去配置文件里对照）`);
    const zh = text.replace(key, '');
    assert.ok(han.test(zh), `${key} 没有中文名/说明：${text}`);
    // 中文名之外还要有一句说明——只写"超时"两个字不算说明。
    assert.ok(zh.trim().length >= 4, `${key} 的说明太短：${text}`);
  }
  assert.ok(labels.get('agent.mode').includes('代理模式'), `agent.mode 的中文名不对：${labels.get('agent.mode')}`);
  assert.ok(labels.get('upstreamListen').includes('反向监听'), 'upstreamListen 要讲清"是上游拨进来的"');
});

await check('过滤框同时认配置键与中文名（记得住"看图"记不住 vision.mode）', () => {
  const app = boot(BASE_VALUE);
  const box = () => {
    let found;
    walk(app.render(), (node) => { if (node.type === 'input' && node.props && node.props.type === 'search') found = node; });
    return found;
  };
  const search = box();
  assert.ok(search, '找不到过滤框');
  search.props.onChange({ target: { value: '看图' } });
  const controls = controlsFor(app.render());
  assert.ok(controls.has('vision.mode'), `按中文名过滤应该留下 vision.mode，实际剩：${[...controls.keys()].join(', ')}`);
  assert.ok(!controls.has('upstreamUrl'), '不相关的字段不该留下');
  search.props.onChange({ target: { value: 'vision.mode' } });
  assert.ok(controlsFor(app.render()).has('vision.mode'), '按配置键过滤也要照旧能用');
});

const inList = (node, predicate) => {
  const out = [];
  walk(node, (inner) => { if (predicate(inner)) out.push(inner); });
  return out;
};
const urlInputsIn = (node) => inList(node, (inner) => inner.type === 'input' && typeof inner.props?.placeholder === 'string' && inner.props.placeholder.startsWith('127.0.0.1'));
const selectsIn = (node) => inList(node, (inner) => inner.type === 'select');
const checkboxesIn = (node) => inList(node, (inner) => inner.type === 'input' && inner.props?.type === 'checkbox');
const listControl = (tree) => controlsFor(tree).get('downstreamTargets');

await check('多下游行编辑器：一条一行，带类型下拉，能加、能删、能逐条停用', () => {
  const app = boot(BASE_VALUE);
  const control = listControl(app.render());
  assert.ok(control, '找不到 downstreamTargets 的控件');
  const urls = urlInputsIn(control);
  assert.equal(urls.length, 2, '两条目标要渲染成两行');
  assert.equal(urls[0].props.value, '127.0.0.1:8080/onebot/v11/ws', '地址是 host:port/path 的统一样式');
  assert.equal(urls[1].props.value, '127.0.0.1:8654/onebot/v11/ws');
  const types = selectsIn(control);
  assert.equal(types.length, 2, '每行一个类型下拉');
  assert.deepEqual(types[0].children.map((option) => option.props.value), ['ws-dial', 'ws-listen', 'http-api', 'http-post']);
  assert.equal(types[0].props.value, 'ws-dial');
  assert.equal(types[1].props.value, 'ws-listen', '已有的类型要如实选中');
  assert.deepEqual(checkboxesIn(control).map((box) => box.props.checked), [true, false], '第二条是 enabled:false，勾选状态要如实显示');

  buttonsOf(control).find((button) => textOf(button) === '添加一个下游').props.onClick();
  const afterAdd = listControl(app.render());
  assert.equal(urlInputsIn(afterAdd).length, 3, '点「添加一个下游」要多一行');
  assert.equal(selectsIn(afterAdd)[2].props.value, 'ws-dial', '新行默认类型 = 拨号型');

  buttonsOf(listControl(app.render())).find((button) => textOf(button) === '删除').props.onClick();
  const afterDelete = urlInputsIn(listControl(app.render()));
  assert.equal(afterDelete.length, 2, '删一条要少一行');
  assert.equal(afterDelete[0].props.value, '127.0.0.1:8654/onebot/v11/ws', '删的是第一行');
  assert.deepEqual(app.mutations, [], '只是编辑，不该写任何东西');
});

await check('多下游行编辑器：保存写回同一个 JSON 字符串（type + address 的统一样式）', async () => {
  const app = boot(BASE_VALUE);
  const control = listControl(app.render());
  checkboxesIn(control)[1].props.onChange({ target: { checked: true } });
  urlInputsIn(listControl(app.render()))[1].props.onChange({ target: { value: '127.0.0.1:9999/onebot/v11/ws' } });
  buttonsOf(app.render()).find((button) => textOf(button).startsWith('保存')).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const ops = JSON.parse(JSON.stringify(app.mutations.at(-1)));
  assert.deepEqual(ops.map((op) => op.path), [['downstreamTargets']]);
  assert.equal(typeof ops[0].value, 'string', 'schema 是字符串，写回的也必须是字符串');
  const parsed = JSON.parse(ops[0].value);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].type, 'ws-listen', '类型要写回');
  assert.equal(parsed[1].address, '127.0.0.1:9999/onebot/v11/ws', '地址要写回（含路径）');
  assert.ok(!('url' in parsed[1]), '写的是统一后的 address，不再写 url');
  assert.ok(!('enabled' in parsed[1]), '重新启用后不再写 enabled（缺省就是启用）');
  assert.equal(parsed[0].address, '127.0.0.1:8080/onebot/v11/ws', '没碰的那条一字不动');
});

await check('源码范围行编辑器：一条一行（备注 + 路径），能加能删，写回同一个 JSON 字符串（m14477）', async () => {
  const app = boot({ ...BASE_VALUE, code: { scopes: '[{"name":"下游A","path":"D:/a"},{"path":"D:/b"}]' } });
  const scopePathInputs = (node) => inList(node, (inner) => inner.type === 'input' && typeof inner.props?.placeholder === 'string' && inner.props.placeholder.startsWith('D:/'));
  const control = controlsFor(app.render()).get('code.scopes');
  assert.ok(control, '找不到 code.scopes 的控件');
  const paths = scopePathInputs(control);
  assert.equal(paths.length, 2, '两条范围要渲染成两行');
  assert.equal(paths[0].props.value, 'D:/a');
  assert.equal(paths[1].props.value, 'D:/b');
  const names = inList(control, (inner) => inner.type === 'input' && inner.props?.placeholder === '下游A（可空）');
  assert.deepEqual(names.map((input) => input.props.value), ['下游A', ''], '备注列要如实显示');

  buttonsOf(control).find((button) => textOf(button) === '添加一个范围').props.onClick();
  assert.equal(scopePathInputs(controlsFor(app.render()).get('code.scopes')).length, 3, '点「添加一个范围」要多一行');

  buttonsOf(controlsFor(app.render()).get('code.scopes')).find((button) => textOf(button) === '删除').props.onClick();
  assert.equal(scopePathInputs(controlsFor(app.render()).get('code.scopes')).length, 2, '删一条要少一行');

  scopePathInputs(controlsFor(app.render()).get('code.scopes'))[1].props.onChange({ target: { value: 'D:/c' } });
  buttonsOf(app.render()).find((button) => textOf(button).startsWith('保存')).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const op = JSON.parse(JSON.stringify(app.mutations.at(-1))).find((row) => row.path.join('.') === 'code.scopes');
  assert.ok(op, '要写回 code.scopes');
  assert.equal(typeof op.value, 'string', 'schema 是字符串，写回的也必须是字符串');
  const parsed = JSON.parse(op.value);
  assert.deepEqual(parsed, [{ name: '', path: 'D:/b' }, { name: '', path: 'D:/c' }], '删的是第一行（下游A），剩下的备注照旧');
});

await check('源码范围写的是空数组时渲染成"0 条 + 添加按钮"（空 ≠ 找不到这一行）', () => {
  const app = boot({ ...BASE_VALUE, code: { scopes: '[]' } });
  const control = controlsFor(app.render()).get('code.scopes');
  assert.ok(control, 'code.scopes 必须始终渲染');
  assert.equal(inList(control, (inner) => inner.type === 'input' && String(inner.props?.placeholder || '').startsWith('D:/')).length, 0, '没配 = 0 条');
  assert.ok(buttonsOf(control).some((button) => textOf(button) === '添加一个范围'), '要有添加按钮');
});

await check('多下游列表编辑器：坏 JSON 不猜，退回文本框并说明原因', () => {
  const app = boot({ ...BASE_VALUE, downstreamTargets: '{坏 JSON' });
  const control = listControl(app.render());
  const texts = [];
  walk(control, (inner) => { for (const child of inner.children || []) if (typeof child === 'string') texts.push(child); });
  assert.ok(texts.join(' ').includes('不是合法 JSON 数组'), `要说明原因：${texts.join(' ')}`);
  const areas = inList(control, (inner) => inner.type === 'textarea');
  assert.equal(areas.length, 1, '坏值要能直接改');
  assert.equal(areas[0].props.value, '{坏 JSON', '原样给出来，不静默丢弃');
  assert.ok(!app.reports().some((row) => row.kind === 'render'), '坏值也不许把页面渲染炸掉');
});

await check('多下游列表编辑器：「以 JSON 编辑」能切出去再切回来', () => {
  const app = boot(BASE_VALUE);
  buttonsOf(app.render()).find((button) => textOf(button) === '以 JSON 编辑').props.onClick();
  const control = listControl(app.render());
  assert.equal(inList(control, (inner) => inner.type === 'textarea').length, 1, '切到 JSON 编辑后是文本框');
  const back = buttonsOf(control).find((button) => textOf(button) === '回到列表');
  assert.ok(back, '要有「回到列表」');
  back.props.onClick();
  assert.equal(urlInputsIn(listControl(app.render())).length, 2, '能切回行编辑');
});

await check('没默认值的两项仍然渲染成空行（"没配"不等于"这一行不存在"）', () => {
  const withoutBoth = { ...BASE_VALUE };
  delete withoutBoth.upstreamListen;
  delete withoutBoth.downstreamTargets;
  const app = boot(withoutBoth);
  const controls = controlsFor(app.render());
  assert.ok(controls.has('upstreamListen'), '上游监听地址要仍在（否则永远没机会配它）');
  assert.equal(controls.get('upstreamListen').props.value, '', '没配 = 空，不是某个默认值');
  const listCtl = controls.get('downstreamTargets');
  assert.ok(listCtl, '下游列表要仍在');
  assert.equal(urlInputsIn(listCtl).length, 0, '没配 = 0 条（不是默认的 []）');
});

await check('「恢复默认」按钮：上游监听地址与下游列表这两行不给，别的字段照旧', () => {
  const app = boot(BASE_VALUE, {
    user: {
      upstreamListen: '127.0.0.1:14514/onebot/v11/ws',
      downstreamTargets: '[{"type":"ws-dial","address":"127.0.0.1:8080/onebot/v11/ws","selfId":"30001"}]',
      vision: { mode: 'describe' },
    },
  });
  const withReset = [];
  walk(app.render(), (node) => {
    if (node.type !== 'div' || !Array.isArray(node.children)) return;
    const label = node.children[0];
    if (!label || label.type !== 'div' || !Array.isArray(label.children)) return;
    const key = keyOfLabel(label);
    if (typeof key !== 'string') return;
    const actions = node.children[2];
    const texts = [];
    walk(actions, (inner) => { for (const child of inner.children || []) if (typeof child === 'string') texts.push(child); });
    if (texts.includes('恢复默认')) withReset.push(key);
  });
  assert.ok(!withReset.includes('upstreamListen'), '上游监听地址不该有「恢复默认」');
  assert.ok(!withReset.includes('downstreamTargets'), '下游列表不该有「恢复默认」');
  assert.ok(withReset.includes('vision.mode'), '别的字段仍然要有「恢复默认」');
});

await check('凭据被宿主脱敏删掉后自己补行：不然"没地方填 key"，且徽章要按 view.secrets 说真话', async () => {
  // 真事故 #6：宿主 `settings.describe({ redactSecrets: true })` 对 `role('secret')` 字段
  // 是**从值里删掉**（redact.js 的 walker `if (stripped !== void 0) rebuilt[key] = stripped`），
  // 所以 `imageGen.apiKey` 在 snap.value 里根本不存在 → 不补行的话这一行整行消失。
  const value = {
    ...BASE_VALUE,
    imageGen: { enabled: true, model: 'doubao-seedream-5.0-pro', baseUrl: 'https://ark.example/api' },
  };
  const app = boot(value, {
    secrets: [
      { path: ['imageGen', 'apiKey'], set: false },
      { path: ['anime', 'recognizeToken'], set: true },
    ],
  });
  const controls = controlsFor(app.render());
  assert.ok(controls.has('imageGen.apiKey'), '凭据行不能消失（这是"设置里没地方配 key"的根因）');
  assert.equal(controls.get('imageGen.apiKey').props.value, '', '宿主不回显明文，框里永远是空');
  assert.equal(controls.get('imageGen.apiKey').props.type, 'password', '凭据框该是密码框');
  const labels = labelsFor(app.render());
  assert.ok(labels.get('imageGen.apiKey').includes('凭据未设置'), `没设过要如实说：${labels.get('imageGen.apiKey')}`);
  assert.ok(labels.get('anime.recognizeToken').includes('凭据已设置'), '设过要如实说（用 snap.user 判断会误报未设置）');
  assert.ok(labels.get('imageGen.apiKey').includes('API Key'), '补出来的行也要有人话标签');

  // 填一个 → 保存 → op 要落到正确的 path
  controls.get('imageGen.apiKey').props.onChange({ target: { value: 'sk-test' } });
  const save = buttonsOf(app.render()).find((button) => textOf(button).startsWith('保存'));
  assert.ok(save, '找不到保存按钮');
  save.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(app.mutations)),
    [[{ op: 'set', path: ['imageGen', 'apiKey'], value: 'sk-test' }]],
  );

  // 留空 = 不改：不能把空串当成"把凭据清空"写回去
  const app2 = boot(value, { secrets: [{ path: ['imageGen', 'apiKey'], set: true }] });
  controlsFor(app2.render()).get('imageGen.apiKey').props.onChange({ target: { value: '' } });
  const save2 = buttonsOf(app2.render()).find((button) => textOf(button).startsWith('保存'));
  save2.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app2.mutations, [], '留空的凭据不该写回任何东西');
});

// 设置页的模型两行（m024193）：`agent.defaultModel` / `defaultVisionModel` 从 DSH 的
// 模型清单里下拉选，`defaultReasoningEffort` / `defaultVisionReasoningEffort` 只在**配对模型
// 自己声明了档位**时才是下拉——没声明就该退回文本框并说明原因，而不是编一排假档位。
const MODEL_CATALOG = {
  ok: true,
  providers: [
    { id: 'prov-a', name: 'Provider A', models: [{ id: 'm-reason', name: 'M Reason', inputModalities: ['text', 'image'] }, { id: 'm-plain', name: 'M Plain', inputModalities: ['text'] }] },
    { id: 'prov-b', name: 'Provider B', models: [{ id: 'only-one', name: 'Only One', vision: false }] },
  ],
  models: [],
  efforts: [],
  defaultEffort: '',
  note: '',
};
const EFFORTS = {
  // 路由按 `?provider=&model=` 两个独立参数回话，key 就是 model id。
  'm-reason': { ok: true, providers: [], models: [], efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low', note: '' },
  'm-plain': { ok: true, providers: [], models: [], efforts: [], defaultEffort: '', note: '该模型没有声明思考强度（只能留空）' },
};
const catalogFetch = async (url) => {
  const text = String(url ?? '');
  const asked = new URL(text, 'http://localhost').searchParams;
  const payload = text.includes('model=')
    ? (EFFORTS[asked.get('model')] ?? { ok: true, efforts: [], defaultEffort: '', note: '' })
    : MODEL_CATALOG;
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};
const MODEL_VALUE = {
  ...BASE_VALUE,
  agent: { mode: 'assist', defaultModel: '', defaultVisionModel: '', defaultReasoningEffort: '', defaultVisionReasoningEffort: '' },
};

await check('模型两行从 DSH 清单出下拉；档位只列配对模型声明的那些', async () => {
  const app = boot(MODEL_VALUE, { fetchImpl: catalogFetch });
  // 一轮只推进一步：挂载标志 → 取清单 → 取档位，所以每次要状态都跑够两轮。
  const next = async () => { await app.settle(); await app.settle(); return app.render(); };
  const controls = controlsFor(await next());

  const model = controls.get('agent.defaultModel');
  assert.ok(model, '找不到 agent.defaultModel 这一行');
  assert.equal(model.type, 'select', '取到清单后模型行应该是下拉');
  const values = optionValues(model);
  assert.ok(values.includes('prov-a/m-reason'), `下拉里要有清单里的模型：${JSON.stringify(values)}`);
  assert.ok(values.includes('prov-b/only-one'));
  assert.ok(optionLabels(model).some((label) => label.includes('可看图')), '能看图的模型要标出来');
  // 末尾仍然是"自定义…"：清单可能少列某个模型（那个 provider 拉失败、或宿主目录不全），
  // 手写一个仍然得能进去——这是全页统一的逃生口，模型行也不例外。
  assert.equal(optionValues(model).at(-1), '__custom__');
  assert.equal(optionValues(model).at(0), '', '第一档永远是"跟 DSH 系统默认"');

  // 还没配模型时：两个档位行都退回文本框，且要说明"没选模型"。
  assert.equal(controls.get('agent.defaultReasoningEffort').type, 'input', '没选模型时不该编出档位下拉');

  // 选了声明了 reasoning 的模型 → 档位变下拉，且只有它自己那两个。
  controls.get('agent.defaultModel').props.onChange({ target: { value: 'prov-a/m-reason' } });
  const effort = controlsFor(await next()).get('agent.defaultReasoningEffort');
  assert.equal(effort.type, 'select', '配对模型声明了档位就该是下拉');
  // 只列它自己声明的档位 + 留空；末尾同样是手写口子（模型目录没写全时还能填 id）。
  assert.deepEqual(optionValues(effort), ['', 'low', 'high', '__custom__'], '只列它自己声明的档位 + 留空 + 手写');
  assert.deepEqual(optionLabels(effort).slice(1, 3), ['低', '高'], '档位显示宿主给的人话名字，不是裸 id');
  assert.equal(effort.props.value, '', '还没选过档位：先显示留空（=跟宿主默认）');

  // 选一个没声明档位的模型 → 退回文本框 + 说明原因，不是空下拉也不是编档位。
  controlsFor(app.render()).get('agent.defaultModel').props.onChange({ target: { value: 'prov-a/m-plain' } });
  const back = controlsFor(await next());
  assert.equal(back.get('agent.defaultReasoningEffort').type, 'input', '没声明档位的模型该退回文本框');
  const note = hintFor(app.render(), 'agent.defaultReasoningEffort');
  assert.ok(note.includes('思考档位'), `要说明为什么没有下拉：${note}`);
  assert.ok(note.includes('m-plain'), `说明里要点名是哪个模型：${note}`);

  // 下拉选完 → 保存写回的 op 就是 provider/model 一整串 + 档位。
  controlsFor(app.render()).get('agent.defaultReasoningEffort').props.onChange({ target: { value: 'high' } });
  const save = buttonsOf(app.render()).find((button) => textOf(button).startsWith('保存'));
  save.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const ops = app.mutations.flat().reduce((acc, op) => {
    acc[op.path.join('.')] = op.value;
    return acc;
  }, {});
  assert.equal(ops['agent.defaultModel'], 'prov-a/m-plain');
  assert.equal(ops['agent.defaultReasoningEffort'], 'high');

  const reports = app.reports().map((row) => row.kind);
  assert.ok(!reports.includes('render'), `渲染不该出错：${JSON.stringify(app.reports())}`);
});

await check('取不到清单时安静退回手写框，并说明宿主没给出清单', async () => {
  const app = boot(MODEL_VALUE, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, note: '宿主没有 llm 服务', providers: [], models: [], efforts: [] }) }),
  });
  const controls = controlsFor(await app.settle());
  assert.equal(controls.get('agent.defaultModel').type, 'input', '取不到清单就该退回手写');
  assert.ok(controls.has('agent.defaultReasoningEffort'), '档位行不许消失');
  const reports = app.reports().map((row) => row.kind);
  assert.ok(!reports.includes('render'), '降级路径也不该报错');
});

await check('凭据的三个落点都认：命名空间那层（真宿主形状）、表单单据那层、view 顶层', () => {
  // 真宿主把 `secrets` 放在 `describe()` 的命名空间条目里；不同版本/不同服务也可能塞在
  // 表单快照或 `view` 顶层。三处都认，才不至于"又一次整行消失"。
  const value = { ...BASE_VALUE, imageGen: { enabled: true, model: 'm', baseUrl: 'https://ark.example/api' } };
  const nsOnly = boot(value, { secrets: [{ path: ['imageGen', 'apiKey'], set: false }] });
  assert.ok(controlsFor(nsOnly.render()).has('imageGen.apiKey'), '命名空间那层的 secrets 要认（真宿主就是这一种）');

  const snapOnly = boot(value, { snapSecrets: [{ path: ['imageGen', 'apiKey'], set: true }] });
  assert.ok(controlsFor(snapOnly.render()).has('imageGen.apiKey'), '表单快照里的 secrets 也要认');

  const none = boot(value);
  assert.ok(!controlsFor(none.render()).has('imageGen.apiKey'), '宿主一句都没说时不许凭空造一行（那才是编）');
});

await check('读不到 configForms 时安静降级（页面给出文字，不抛）', () => {
  // 真事故的形态：读没 inject 的服务是**抛**（`reflect.ts:144`），apply 再把它放出去
  // 就把整个 App 拖死。这里照"属性 getter 直接抛"的形态跑一遍降级路径。
  const app = boot(BASE_VALUE, { withForms: false, value2Throw: true });
  const tree = app.render();
  const texts = [];
  walk(tree, (node) => { for (const child of node.children || []) if (typeof child === 'string') texts.push(child); });
  const joined = texts.join(' ');
  assert.ok(joined.includes('configForms'), `要如实说明宿主没提供配置表单服务：${joined.slice(0, 200)}`);
  const reports = app.reports();
  assert.ok(!reports.some((row) => row.kind === 'apply'), `读不到 configForms 不该让 apply 抛：${JSON.stringify(reports)}`);
  assert.ok(reports.some((row) => row.kind === 'configForms'), '读失败要上报（分诊依据）');
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `  ← ${row.error}`}`);
console.log(`\nclient-render: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
