/**
 * 浏览器自诊断通道的可执行验证：把 `lib/client-probe.js` 里那段**注入到 `<head>` 的探针脚本**
 * 放进一个假 DOM（`vm` 上下文）里真跑一遍。
 *
 * 为什么值得单独测：这段脚本是全篇唯一在**浏览器里**执行的东西，宿主侧的任何测试都碰不到它；
 * 而它一旦有语法错/取错全局，表现是"通道装好了但永远收不到东西"——比没有通道更误导。
 * 这里验的是它真能：
 *   · 抓到资源加载失败（`<script src="plugins/??…/client.js">` 的 error，target 是元素）
 *   · 抓到未捕获异常与未处理拒绝
 *   · 抓到 `console.error` 的原文（React 渲染报错走这条）
 *   · 按 `CLIENT_PROBE_PATH` + `location.search` 批量 POST，而且**不进死循环**（探针自己的 POST 失败不报错）
 *   · 重复装载只装一次（`__ONEBOT_HUB_PROBE__` 守卫），不会把 console 套两层
 *
 * 跑法：node test/client-probe.mjs
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';

import { CLIENT_PROBE_PATH, CLIENT_PROBE_SCRIPT, clientReportStatus, noteClientReport } from '../lib/client-probe.js';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假浏览器上下文：只装探针真正用到的东西。 */
function makeBrowser() {
  const listeners = new Map();
  const fetchCalls = [];
  const logs = [];
  const add = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const dispatch = (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  const consoleStub = {
    error: (...args) => logs.push({ level: 'error', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    log: (...args) => logs.push({ level: 'log', args }),
  };
  const sandbox = {
    window: { addEventListener: add },
    document: { readyState: 'loading', scripts: [{ src: 'x' }] },
    location: { href: 'http://127.0.0.1:19387/?token=abc', search: '?token=abc' },
    console: consoleStub,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({ ok: true, status: 204 });
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  return { context, dispatch, fetchCalls, logs, sandbox };
}

check('探针脚本是语法正确的 JS，且不含 </script', () => {
  assert.ok(!CLIENT_PROBE_SCRIPT.includes('</script'), '内联脚本不能含 </script（会截断宿主注入的 <script> 标签）');
  // new Function 只解析不执行：语法错会在这里就抛。
  assert.equal(typeof new Function(CLIENT_PROBE_SCRIPT), 'function');
});

await checkAsync('探针：抓到资源加载失败 / 未捕获异常 / 未处理拒绝 / console.error，并批量上报', async () => {
  const browser = makeBrowser();
  vm.runInContext(CLIENT_PROBE_SCRIPT, browser.context);
  assert.equal(browser.sandbox.__ONEBOT_HUB_PROBE__.ok, true, '装好后要暴露 __ONEBOT_HUB_PROBE__');

  // ① 资源加载失败：error 事件的 target 是 <script> 元素（浏览器里就是这个形状）。
  browser.dispatch('error', {
    target: { tagName: 'SCRIPT', src: 'plugins/??a/client.js,b/client.js&rev=deadbeef' },
  });
  // ② 未捕获异常。
  browser.dispatch('error', { message: 'boom', filename: 'client.js', lineno: 12, error: new Error('boom') });
  // ③ 未处理的 Promise 拒绝。
  browser.dispatch('unhandledrejection', { reason: new RangeError('nope') });
  // ④ console.error 原文（React 渲染报错走这条）。
  browser.sandbox.console.error('Warning: Invalid hook call.', { componentStack: 'at Page' });

  await sleep(600); // 探针有 400ms 防抖

  assert.equal(browser.fetchCalls.length, 1, `应当只发一批（实际 ${browser.fetchCalls.length} 批）`);
  const call = browser.fetchCalls[0];
  assert.equal(call.url, `${CLIENT_PROBE_PATH}?token=abc`, '上报路径必须带 location.search（保住宿主的鉴权/查询参数）');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.keepalive, true);
  const payload = JSON.parse(call.init.body);
  assert.equal(payload.source, 'head-probe');
  assert.equal(payload.href, 'http://127.0.0.1:19387/?token=abc');
  const kinds = payload.items.map((item) => item.kind);
  assert.equal(kinds[0], 'probe', '第一件事应当是"探针已安装"里程碑');
  assert.deepEqual(kinds.slice(1), ['resource', 'error', 'rejection', 'console.error']);
  assert.match(payload.items[1].msg, /plugins\/\?\?a\/client\.js/, '资源错误要报出真正取不到的 URL');
  assert.match(payload.items[4].msg, /Invalid hook call/);
  assert.match(payload.items[4].msg, /componentStack/, 'console.error 的非字符串参数要序列化进去，不能丢');

  // 收报侧：同一份负载喂给宿主，计数要涨。
  const before = clientReportStatus().receivedItems;
  assert.equal(noteClientReport(payload).items, 5);
  const status = clientReportStatus();
  assert.equal(status.receivedItems, before + 5);
  assert.ok(status.counts.resource >= 1 && status.counts['console.error'] >= 1);
  assert.equal(status.recent.at(-1).source, 'head-probe');

  // 探针自己的上报失败不能反过来变成新的错误（否则控制台会自我放大）：
  // 这里唯一一条 console.error 就是我们上面手动打的那条，探针没有追加任何东西。
  assert.equal(browser.logs.length, 1, '探针不该往 console 里写东西');
  assert.match(String(browser.logs[0].args[0]), /Invalid hook call/);
});

check('探针：重复装载只装一次，console 不被套两层', () => {
  const browser = makeBrowser();
  vm.runInContext(CLIENT_PROBE_SCRIPT, browser.context);
  const first = browser.sandbox.__ONEBOT_HUB_PROBE__;
  vm.runInContext(CLIENT_PROBE_SCRIPT, browser.context);
  assert.equal(browser.sandbox.__ONEBOT_HUB_PROBE__, first, '第二次装载应当直接返回已装好的那一个');
  browser.sandbox.console.error('only once');
  assert.equal(browser.logs.length, 1, 'console.error 只应被转发一次（说明没套两层）');
});

check('探针：fetch 同步抛（某些拦截器）也不影响页面', () => {
  const browser = makeBrowser();
  vm.runInContext(CLIENT_PROBE_SCRIPT, browser.context);
  browser.sandbox.fetch = () => {
    throw new Error('blocked by extension');
  };
  assert.doesNotThrow(() => {
    browser.dispatch('error', { message: 'later' });
  });
});

check('收报侧：超大/畸形负载只丢弃，不抛也不编', () => {
  assert.equal(noteClientReport(undefined).ok, false);
  assert.equal(noteClientReport('boom').ok, false);
  const long = 'x'.repeat(5000);
  const result = noteClientReport({ items: [{ kind: 'error', msg: long }] });
  assert.equal(result.ok, true);
  const last = clientReportStatus().recent.at(-1).items[0];
  assert.ok(last.msg.length <= 1201, '单条文本必须被截断，否则一条巨大堆栈能占满缓冲');
  assert.equal(noteClientReport({ items: 'not-an-array' }).items, 0);
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'}  ${row.name}${row.ok ? '' : `  ← ${row.error}`}`);
console.log(`\nclient-probe: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
