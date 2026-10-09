/**
 * 浏览器半侧的**自诊断通道**（纯诊断，不参与任何业务逻辑）。
 *
 * 为什么需要它：设置页空白时，唯一的证据在**浏览器控制台**里，而枢纽跑在宿主进程里，
 * 看不到那份控制台；桌面宿主又不把渲染进程的 console 落盘（`%APPDATA%\...\logs\`
 * 里只有崩溃转储，正常启动什么都没有）。用户说"console 全是报错"时，我们在这边
 * 干瞪眼——所以把错误**自己送回来**：
 *
 *   ① 往 index HTML 的 `<head>` 里注入一段探针脚本（`webserver/index-inject` 事件）。
 *      它是内联经典脚本，在**任何模块 bundle 之前**执行，所以能抓到最要命的一类错误：
 *      bundle 脚本加载失败（`<script src="plugins/??…">` 的 error 事件）——那会让一整批
 *      插件（含本插件的设置页）全部 `import failed`，控制台刷屏、页面空白。
 *   ② 用户浏览器那一侧只要发一个同源 POST，本模块把内容存进内存环形缓冲，
 *      再用 `onebot_hub_status.host.clientReports` 读出来——不需要用户复制控制台。
 *
 * 只收：错误/拒绝/`console.error`/`console.warn`/探针自己打的几个里程碑。
 * 只读回显：不落盘、不外发、不改变任何行为；路由是精确路径、只收 POST，体量有上限。
 */

/** 探针上报的同源路径（宿主自己注册，不经过网关）。 */
export const CLIENT_PROBE_PATH = '/onebot-hub/client-report';

/** 一批最多收多少条、最多留多少批、请求体上限。 */
const MAX_BATCH_ITEMS = 120;
const MAX_BATCHES = 40;
const MAX_TOTAL_ITEMS = 400;
const MAX_BODY_BYTES = 64 * 1024;
/** 单条文本截断长度（防止一条巨大堆栈把缓冲占满）。 */
const MAX_TEXT = 1200;

/**
 * 注入 `<head>` 的探针脚本（内联经典脚本，必须不含 `</script`）。
 *
 * 抓到的东西按 kind 分类：
 *  · `resource`   —— 资源加载失败（含模块 bundle `<script>`，最关键的证据）
 *  · `error`      —— 未捕获异常（捕获阶段监听，能拿到资源错误的 target）
 *  · `rejection`  —— 未处理的 Promise 拒绝
 *  · `console.*`  —— 被 console.error / console.warn 记下的东西（React 渲染错误走这条）
 *  · `probe`      —— 探针里程碑（安装、load 完成）
 */
export const CLIENT_PROBE_SCRIPT = [
  '(function () {',
  '  var existing = globalThis.__ONEBOT_HUB_PROBE__;',
  '  if (existing && existing.ok) return;',
  '  var MAX = 120, seen = 0, buf = [], timer = null, installedAt = Date.now();',
  '  function send() {',
  '    if (timer) return;',
  '    timer = setTimeout(function () {',
  '      timer = null;',
  '      if (buf.length === 0) return;',
  '      var items = buf.splice(0, buf.length), body;',
  '      try {',
  '        body = JSON.stringify({',
  '          source: "head-probe", installedAt: installedAt, now: Date.now(),',
  '          href: String(location.href).slice(0, 300), ready: document.readyState,',
  '          boot: typeof globalThis.__DSH_BOOT__ !== "undefined",',
  '          loader: typeof globalThis.__ModuleLoader__, scripts: document.scripts.length,',
  '          items: items,',
  '        });',
  '      } catch (err) { return; }',
  '      try {',
  '        fetch("/onebot-hub/client-report" + location.search, {',
  '          method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true,',
  '        })["catch"](function () {});',
  '      } catch (err) {}',
  '    }, 400);',
  '  }',
  '  function push(kind, msg, extra) {',
  '    if (seen >= MAX) return;',
  '    seen++;',
  '    var item = { at: Date.now(), kind: String(kind).slice(0, 40), msg: String(msg == null ? "" : msg).slice(0, 1400) };',
  '    if (extra) item.extra = String(extra).slice(0, 1400);',
  '    buf.push(item);',
  '    send();',
  '  }',
  '  window.addEventListener("error", function (ev) {',
  '    var t = ev && ev.target;',
  '    if (t && t !== window && t !== document && (t.src || t.href)) {',
  '      push("resource", String(t.tagName || "") + " " + (t.src || t.href));',
  '      return;',
  '    }',
  '    push("error", (ev && ev.message) || "unknown",',
  '      (ev && ev.error && ev.error.stack) || ((ev && ev.filename) || "") + ":" + ((ev && ev.lineno) || 0));',
  '  }, true);',
  '  window.addEventListener("unhandledrejection", function (ev) {',
  '    var r = ev && ev.reason;',
  '    push("rejection", (r && r.message) || r, (r && r.stack) || "");',
  '  });',
  '  try {',
  '    ["error", "warn"].forEach(function (level) {',
  '      var orig = console[level];',
  '      console[level] = function () {',
  '        try {',
  '          var parts = [], i;',
  '          for (i = 0; i < arguments.length; i++) {',
  '            var a = arguments[i];',
  '            if (a instanceof Error) parts.push(a.message + (a.stack ? "\\n" + a.stack : ""));',
  '            else if (typeof a === "string") parts.push(a);',
  '            else { try { parts.push(JSON.stringify(a)); } catch (e2) { parts.push(String(a)); } }',
  '          }',
  '          push("console." + level, parts.join(" ").slice(0, 1400), "");',
  '        } catch (e3) {}',
  '        return orig.apply(console, arguments);',
  '      };',
  '    });',
  '  } catch (e4) {}',
  '  window.addEventListener("load", function () { push("probe", "load readyState=" + document.readyState); });',
  '  globalThis.__ONEBOT_HUB_PROBE__ = { ok: true, report: push, dump: function () { return buf.slice(); } };',
  '  push("probe", "head 探针已安装");',
  '})();',
].join('\n');

/** 内存里的接收缓冲（进程内，不落盘）。 */
const state = {
  install: null,
  batches: [],
  counts: Object.create(null),
  lastAt: null,
  firstAt: null,
  hosts: [],
  errors: [],
};

/** 归一化成可读的一行，并截断。 */
function clip(value, max = MAX_TEXT) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 收一批浏览器上报。任何字段缺失/类型不对都只是丢弃该字段，不抛错。
 * @param {unknown} payload 探针 POST 上来的 JSON。
 * @returns {{ok: boolean, note?: string, items?: number}}
 */
export function noteClientReport(payload) {
  const body = payload && typeof payload === 'object' ? payload : null;
  if (!body) return { ok: false, note: 'payload 不是对象' };
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH_ITEMS) : [];
  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = clip(raw.kind || 'unknown', 40);
    const item = {
      at: Number(raw.at) || Date.now(),
      kind,
      msg: clip(raw.msg),
    };
    if (raw.extra) item.extra = clip(raw.extra);
    items.push(item);
    state.counts[kind] = (state.counts[kind] ?? 0) + 1;
  }
  const at = Date.now();
  if (state.firstAt === null) state.firstAt = at;
  state.lastAt = at;
  if (typeof body.href === 'string') {
    const href = clip(body.href, 300);
    if (!state.hosts.includes(href)) state.hosts = [...state.hosts.slice(-4), href];
  }
  const batch = {
    at,
    source: clip(body.source || 'unknown', 60),
    href: clip(body.href || '', 300),
    ready: clip(body.ready || '', 20),
    boot: body.boot === undefined ? null : !!body.boot,
    loader: body.loader === undefined ? null : clip(body.loader, 20),
    items,
  };
  state.batches.push(batch);
  if (state.batches.length > MAX_BATCHES) state.batches = state.batches.slice(-MAX_BATCHES);
  let total = state.batches.reduce((sum, entry) => sum + entry.items.length, 0);
  while (total > MAX_TOTAL_ITEMS && state.batches.length > 1) {
    const dropped = state.batches.shift();
    total -= dropped.items.length;
  }
  return { ok: true, items: items.length };
}

/**
 * 给 `onebot_hub_status.host.clientReports` 用的读数：装机结果 + 计数 + 最近几批原文。
 * @param {number} [limit] 回几批（默认 6，最多 20）。
 */
export function clientReportStatus(limit = 6) {
  const size = Math.max(1, Math.min(20, Number(limit) || 6));
  const total = state.batches.reduce((sum, entry) => sum + entry.items.length, 0);
  return {
    install: state.install,
    receivedBatches: state.batches.length,
    receivedItems: total,
    counts: { ...state.counts },
    firstAt: state.firstAt,
    lastAt: state.lastAt,
    hosts: state.hosts,
    recent: state.batches.slice(-size),
  };
}

/** 读一个请求体，超限返回 null（不抛）。 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        finish(null);
        try { req.destroy(); } catch { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

/** 路由处理器：GET 回读、POST 收报，其余 405。 */
function createHandler(log) {
  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        const text = JSON.stringify(clientReportStatus(20), null, 2);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw === null) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('too large');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch (err) {
        state.errors = [...state.errors.slice(-4), { at: Date.now(), note: `JSON 解析失败：${clip(err?.message ?? err, 200)}` }];
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad json');
        return;
      }
      const result = noteClientReport(parsed);
      if (!result.ok) log(`浏览器上报被丢弃：${result.note}`);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    } catch (err) {
      state.errors = [...state.errors.slice(-4), { at: Date.now(), note: `处理器异常：${clip(err?.message ?? err, 200)}` }];
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('probe failed');
      } catch { /* 忽略 */ }
    }
  };
}

/**
 * 装上自诊断通道：注入 head 探针 + 注册同源上报路由。
 *
 * 宿主没有 `webServer`（非 web 组合）或版本不符时**如实返回**，绝不假装装上了。
 * @param {any} ctx 插件上下文。
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ available: boolean, path: string, note?: string, indexInject?: boolean, dispose?: () => void }}
 */
export function installClientProbe(ctx, { log = () => {} } = {}) {
  const out = { available: false, path: CLIENT_PROBE_PATH, note: '' };
  const fromService = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  const webServer = (ctx && ctx.webServer) || fromService;
  if (!webServer) {
    out.note = '宿主没有 webServer 服务（不是 web 组合）：自诊断通道未装';
    state.install = out;
    return out;
  }
  // 注入：往 index 的 <head> 里塞一份内联探针。
  //
  // 事件由 `webServer` 服务在自己的 ctx 上 emit；cordis 的事件**向上冒泡**，
  // 所以只看插件根 ctx 未必收得到。两条都挂、按"表里已经有同一段脚本"去重——
  // 收两次不会出现两个 <script>，收不到才是真的白忙。
  const pushRow = (table) => {
    if (!Array.isArray(table)) return;
    if (table.some((row) => row && row.kind === 'script' && row.text === CLIENT_PROBE_SCRIPT)) return;
    table.push({ kind: 'script', placement: 'head', text: CLIENT_PROBE_SCRIPT });
  };
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('webserver/index-inject', pushRow);
      out.indexInject = true;
    } catch (err) {
      out.injectError = clip(err?.message ?? err, 200);
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sctx) => {
        if (sctx && typeof sctx.on === 'function') {
          sctx.on('webserver/index-inject', pushRow);
          out.indexInject = true;
        }
      });
    } catch (err) {
      out.injectError = out.injectError ?? clip(err?.message ?? err, 200);
    }
  }
  if (typeof webServer.register !== 'function') {
    out.note = 'webServer 没有 register（版本不符）：自诊断通道未装';
    state.install = out;
    return out;
  }
  try {
    out.dispose = webServer.register({ kind: 'exact', path: CLIENT_PROBE_PATH, handler: createHandler(log) });
    out.available = true;
    log(`浏览器自诊断通道已装：${CLIENT_PROBE_PATH}`);
  } catch (err) {
    out.registerError = clip(err?.message ?? err, 200);
    out.note = '上报路由注册失败（路径被占用？）';
  }
  state.install = out;
  return out;
}
