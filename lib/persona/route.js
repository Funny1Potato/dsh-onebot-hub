/**
 * 设置页的**人设库通道**（读写，同源精确路径）。
 *
 * 用户的诉求（`m23678`）：设置页里那三个人设配置项不够用——`persona.presets` 是一整段
 * JSON 塞在单行输入框里，`persona.defaultName` 要手打名字（打错就是悄悄回落默认），
 * 想改角色性格只能在配置文件里改种子、重启。所以要两样东西：**下拉选默认人设**、
 * **选中那一条的 JSON 编辑窗口**。
 *
 * 关键取舍：改的是**运行时那本预设库**（`persona/presets.json`，跟 `/presets`、`/set_preset`
 * 用的是同一份），改完立刻生效、重启还在；配置文件里的 `persona.defaultName` / `persona.presets`
 * 降级成"首次启动的种子"——这个口径必须写在页面上，否则用户改了配置文件发现没效果。
 *
 * 为什么开在宿主侧：设置页是 `lib/client.js`，客户端只 inject `slots` / `configForms`，
 * 拿不到 `PersonaStore`（cordis：没 declare 就读不到）。形状照 `lib/llm-models.js` 的只读通道
 * （`webServer.register({kind:'exact',path,handler})` + 页面 fetch），只是这个能写。
 *
 * 接口（GET 拿状态，POST 改）：
 *  · `GET`  → `{ ok, defaultName, presets:[{name,role,knowledges,hidden}], note }`
 *  · `POST {op:'set-default', name}`
 *  · `POST {op:'save', preset:{name, role, knowledges}}`（同名＝覆盖，新名＝新建）
 *  · `POST {op:'remove', name}`（默认人设拒绝删，回 `ok:false` 说明为什么）
 * 三种写操作都回一份**改完之后的最新状态**，页面据此一次刷新，不用再发一次 GET。
 */

/** 设置页 fetch 的同源路径（宿主自己注册，不经过网关）。 */
export const PERSONA_PATH = '/onebot-hub/persona';

/** 请求体上限：一条人设的知识点上限 50 条、每条不截断，留够余量但别让人塞整本书。 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 错误说明的长度上限（页面直接显示，不糊堆栈）。 */
const MAX_NOTE = 200;

/** @param {unknown} value */
const clip = (value) => String(value ?? '').slice(0, MAX_NOTE);

/** 只读快照：页面要的就是这几样，`hidden` 也带上（隐藏的条目不该进下拉，但 JSON 窗口要能打开）。 */
function snapshot(store) {
  if (!store || typeof store.list !== 'function') {
    return { ok: false, defaultName: '', presets: [], note: '人设服务不可用（`persona.enabled` 可能是 false）' };
  }
  let rows = [];
  try {
    rows = store.list({ includeHidden: true }) ?? [];
  } catch (err) {
    return { ok: false, defaultName: '', presets: [], note: `读人设库失败：${clip(err?.message ?? err)}` };
  }
  return {
    ok: true,
    defaultName: String(store.defaultName ?? ''),
    presets: (Array.isArray(rows) ? rows : []).map((preset) => ({
      name: String(preset?.name ?? ''),
      role: String(preset?.role ?? ''),
      knowledges: Array.isArray(preset?.knowledges) ? preset.knowledges.map(String) : [],
      hidden: preset?.hidden === true,
    })),
    note: '',
  };
}

/** 读请求体（`webServer` 给的是原生 IncomingMessage）。 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024)}KB`));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 路由处理器：GET 读状态，POST 按 `op` 改，其余 405。
 * @param {() => (object|null)} getStore 现取 `PersonaStore`（服务可能晚于路由注册才到位）
 * @param {{ log?: (msg:string)=>void, maxBytes?: number }} [opts]
 */
export function createPersonaHandler(getStore, { log = () => {}, maxBytes = MAX_BODY_BYTES } = {}) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        send(res, 200, snapshot(getStore?.() ?? null));
        return;
      }
      if (req.method !== 'POST') {
        send(res, 405, { ...snapshot(getStore?.() ?? null), ok: false, note: '只接受 GET / POST' });
        return;
      }
      const store = getStore?.() ?? null;
      if (!store) {
        send(res, 200, { ok: false, defaultName: '', presets: [], note: '人设服务不可用（`persona.enabled` 可能是 false）' });
        return;
      }

      let body = null;
      try {
        const text = await readBody(req, maxBytes);
        body = text.trim() === '' ? null : JSON.parse(text);
      } catch (err) {
        send(res, 400, { ...snapshot(store), ok: false, note: `请求体不是合法 JSON：${clip(err?.message ?? err)}` });
        return;
      }
      const op = String(body?.op ?? '').trim();

      if (op === 'set-default') {
        const name = String(body?.name ?? '').trim();
        if (!store.setDefault(name)) {
          send(res, 200, { ...snapshot(store), ok: false, note: `没有叫「${name || '(空)'}」的人设，默认人设没改` });
          return;
        }
        log(`[persona] 默认人设改为 ${store.defaultName}（来自设置页）`);
        send(res, 200, snapshot(store));
        return;
      }

      if (op === 'save') {
        const preset = body?.preset;
        if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
          send(res, 400, { ...snapshot(store), ok: false, note: 'save 需要一个 preset 对象' });
          return;
        }
        const name = String(preset.name ?? '').trim();
        if (!name) {
          send(res, 400, { ...snapshot(store), ok: false, note: '人设必须有名字（保存后再改默认、绑定都要靠它）' });
          return;
        }
        // `save()` 自己会归一化（角色裁剪、知识点去重、上限 50 条），这里不重复做。
        const saved = store.save({
          name,
          role: String(preset.role ?? ''),
          knowledges: Array.isArray(preset.knowledges) ? preset.knowledges : [],
        });
        log(`[persona] 保存人设 ${saved?.name ?? name}（来自设置页）`);
        send(res, 200, snapshot(store));
        return;
      }

      if (op === 'remove') {
        const name = String(body?.name ?? '').trim();
        if (!store.remove(name)) {
          const why = name === String(store.defaultName ?? '')
            ? '默认人设不能删（先把别的设成默认，再删它）'
            : `没有叫「${name || '(空)'}」的人设，或者它正在被删除`;
          send(res, 200, { ...snapshot(store), ok: false, note: why });
          return;
        }
        log(`[persona] 删除人设 ${name}（来自设置页）`);
        send(res, 200, snapshot(store));
        return;
      }

      send(res, 400, { ...snapshot(store), ok: false, note: `未知 op「${op || '(空)'}」（可用：set-default / save / remove）` });
    } catch (err) {
      send(res, 500, { ok: false, defaultName: '', presets: [], note: `人设路由出错：${clip(err?.message ?? err)}` });
    }
  };
}

/**
 * 把路由装上（形状照 `lib/llm-models.js` 的 `installModelListRoute`）：
 * 拿不到 `webServer` 就如实回 `available:false`，绝不假装装上了。
 * @param {object} ctx
 * @param {{ getStore?: () => (object|null), log?: (msg:string)=>void }} [opts]
 */
export function installPersonaRoute(ctx, { getStore = () => null, log = () => {} } = {}) {
  const out = { available: false, path: PERSONA_PATH, note: '' };
  const webServer = (ctx && ctx.webServer) || (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer) {
    out.note = '宿主没有 webServer 服务（不是 web 组合）：设置页人设下拉不可用';
    return out;
  }
  if (typeof webServer.register !== 'function') {
    out.note = 'webServer 没有 register（版本不符）：设置页人设下拉不可用';
    return out;
  }
  try {
    out.dispose = webServer.register({ kind: 'exact', path: PERSONA_PATH, handler: createPersonaHandler(getStore, { log }) });
    out.available = true;
    log(`设置页人设通道已装：${PERSONA_PATH}`);
  } catch (err) {
    out.note = clip(err?.message ?? err);
  }
  return out;
}
