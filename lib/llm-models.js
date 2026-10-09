/**
 * 设置页的**模型清单通道**（只读，同源精确路径）。
 *
 * 用户的诉求：`agent.defaultModel` / `agent.defaultVisionModel` 别再让人手打 `provider/model`
 * ——手打就一定会打错（provider 名不叫 `openai`、model id 带日期），而且**思考强度**（reasoning
 * effort）压根没法凭记忆写出：那是**某个模型自己声明**的档位（有的模型压根没有）。
 * 所以这两项必须从 DSH 的模型清单里选。
 *
 * 为什么不开在浏览器半侧：设置页是 `lib/client.js`，它是宿主拼出来的经典脚本，
 * 客户端只 inject `slots` / `configForms`，**拿不到 `llm` 服务**（cordis：没 declare 就读不到）。
 * 与其去 hack 一条服务通道，不如在宿主里开一条**只读回显**路由——和 `lib/client-probe.js`
 * 的上报通道是同一个形状（`webServer.register({kind:'exact', path, handler})` + 页面 fetch）。
 *
 * 两种问法（GET，query 决定）：
 *  · 不带参数 → `{ ok, providers: [{id, name, models: [{id, name, inputModalities}]}] }`
 *    清单来自宿主 `llm.listProviders()` + `llm.listModels(providerId)`，30 秒内存缓存
 *    （模型清单很少变；设置页每次打开都打一遍上游没必要）。
 *  · `?provider=&model=` → `{ ok, efforts: [{id, name}], defaultEffort }`
 *    来自 `llm.resolveModelInfo(provider, model)` 的 `reasoning.efforts`。**只查当前选中的
 *    那一个模型**，不预取全部模型的档位（那要 N 次 resolveModelInfo）。
 *
 * 拿不到就如实说：`{ ok:false, note }`，页面据此退回文本框，而不是给一份编出来的清单。
 */

/** 设置页 fetch 的同源路径（宿主自己注册，不经过网关）。 */
export const MODEL_LIST_PATH = '/onebot-hub/llm-models';

/** 清单缓存时长（毫秒）：模型清单很少变，别让每次开页面都打一遍上游。 */
export const MODEL_LIST_TTL_MS = 30000;

/** 错误说明的长度上限（页面直接显示，别把整段堆栈糊上去）。 */
const MAX_NOTE = 200;

/** @param {unknown} value @returns {string} */
function clip(value) {
  return String(value ?? '').slice(0, MAX_NOTE);
}

/** 统一的失败回执：`ok:false` + 人话说明 + 页面仍能渲染的空清单。 */
function failure(note) {
  return { ok: false, note: clip(note), providers: [], models: [], efforts: [], defaultEffort: '' };
}

/**
 * 宿主 `llm` 服务是否可用（缺了就没清单，如实降级）。
 * @param {unknown} llm
 */
function llmUsable(llm) {
  return !!(llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function');
}

/**
 * 拉一份完整清单：`listProviders()` → 每个 provider 一次 `listModels(id)`。
 * 单个 provider 拉失败不影响别的（那个 provider 记 `note`，模型列表为空）。
 * @param {object} llm 宿主 `llm` 服务
 */
export async function catalogOf(llm) {
  if (!llmUsable(llm)) return failure('宿主没有 llm 服务（或版本不符）：模型清单取不到');
  let providers = [];
  try {
    providers = await llm.listProviders();
  } catch (err) {
    return failure(`宿主 llm.listProviders() 失败：${clip(err?.message ?? err)}`);
  }
  const out = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = String(provider?.id ?? '');
    if (!id) continue;
    const entry = { id, name: String(provider?.name ?? id), models: [], note: '' };
    try {
      const models = await llm.listModels(id);
      entry.models = (Array.isArray(models) ? models : []).map((model) => {
        const modelId = String(model?.id ?? '');
        return {
          id: modelId,
          name: String(model?.name ?? modelId),
          // `inputModalities` 是**建议值**（目录里声明的），页面只拿它标注"可看图"，
          // 不拿它过滤——探不准时宁可都列出来，让用户自己选。
          inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.map(String) : [],
        };
      }).filter((model) => model.id);
    } catch (err) {
      entry.note = clip(`listModels 失败：${err?.message ?? err}`);
    }
    out.push(entry);
  }
  return { ok: true, providers: out, note: '', models: [], efforts: [], defaultEffort: '' };
}

/**
 * 某个模型的思考强度档位（`resolveModelInfo().reasoning.efforts`）。
 * 没声明 reasoning、或 resolve 失败，都如实回空数组——页面据此退回文本框。
 * @param {object} llm
 * @param {string} provider 空 = 沿用当前路由（与 `lib/vision.js` 的用法一致）
 * @param {string} model
 */
export async function effortsOf(llm, provider, model) {
  const modelId = String(model ?? '').trim();
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    return failure('宿主 llm.resolveModelInfo 不可用：取不到思考强度');
  }
  // 没选模型不是错误：只是"这一栏现在没有可列的档位"（页面据此退回文本框）。
  if (!modelId) {
    return { ok: true, providers: [], models: [], efforts: [], defaultEffort: '', note: '没选模型：没有可列的思考强度' };
  }
  let info = null;
  try {
    info = await llm.resolveModelInfo(String(provider ?? '').trim() || undefined, modelId);
  } catch (err) {
    return failure(`resolveModelInfo(${String(provider ?? '').trim() || '(当前) '}/${modelId}) 失败：${clip(err?.message ?? err)}`);
  }
  const reasoning = info && typeof info === 'object' ? info.reasoning : null;
  const efforts = (Array.isArray(reasoning?.efforts) ? reasoning.efforts : [])
    .map((effort) => ({ id: String(effort?.id ?? ''), name: String(effort?.name ?? effort?.id ?? '') }))
    .filter((effort) => effort.id);
  return {
    ok: true,
    providers: [],
    models: [],
    efforts,
    defaultEffort: String(reasoning?.defaultEffort ?? ''),
    note: reasoning ? '' : '该模型没有声明思考强度（只能留空）',
  };
}

/**
 * 路由处理器：GET 查清单 / 查档位，其余 405。
 * @param {() => (object|null)} getLlm 现取 `llm` 服务（服务可能晚于路由注册才到位）
 * @param {object} [opts]
 * @param {number} [opts.cacheTtlMs]
 * @param {() => number} [opts.now]
 */
export function createModelListHandler(getLlm, { cacheTtlMs = MODEL_LIST_TTL_MS, now = Date.now } = {}) {
  let cached = null; // { at, value }
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        send(res, 405, failure('只接受 GET'));
        return;
      }
      const url = new URL(String(req?.url ?? '/'), 'http://localhost');
      const provider = String(url.searchParams.get('provider') ?? '').trim();
      const model = String(url.searchParams.get('model') ?? '').trim();
      if (provider || model) {
        send(res, 200, await effortsOf(getLlm?.() ?? null, provider, model));
        return;
      }
      const at = now();
      if (cached && at - cached.at < cacheTtlMs) {
        send(res, 200, cached.value);
        return;
      }
      const value = await catalogOf(getLlm?.() ?? null);
      // 失败的回执不缓存：宿主服务晚到时，第一次失败不该把"取不到"钉住 30 秒。
      if (value.ok) cached = { at, value };
      send(res, 200, value);
    } catch (err) {
      send(res, 500, failure(`模型清单路由出错：${clip(err?.message ?? err)}`));
    }
  };
}

/**
 * 把路由装上（形状照 `lib/client-probe.js` 的 `installClientProbe`）：
 * 拿不到 `webServer` 就如实回 `available:false`，绝不假装装上了。
 * @param {object} ctx
 * @param {{ log?: (msg:string)=>void }} [opts]
 */
export function installModelListRoute(ctx, { log = () => {} } = {}) {
  const out = { available: false, path: MODEL_LIST_PATH, note: '' };
  const webServer = (ctx && ctx.webServer) || (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer) {
    out.note = '宿主没有 webServer 服务（不是 web 组合）：设置页模型下拉不可用';
    return out;
  }
  let llm = null;
  if (typeof ctx?.inject === 'function') {
    try {
      out.disposeLlm = ctx.inject(['llm'], (sctx) => {
        llm = sctx.llm ?? (typeof sctx?.get === 'function' ? sctx.get('llm') : null) ?? null;
      });
    } catch (err) {
      out.note = clip(err?.message ?? err);
    }
  }
  if (typeof webServer.register !== 'function') {
    out.note = 'webServer 没有 register（版本不符）：设置页模型下拉不可用';
    return out;
  }
  // `llm` 可能是**晚于路由注册**才到位的（服务注入晚于 apply），所以处理器现取，不缓存引用。
  const read = () => llm ?? ((typeof ctx?.get === 'function' ? ctx.get('llm') : null) || ctx?.llm || null);
  try {
    out.dispose = webServer.register({ kind: 'exact', path: MODEL_LIST_PATH, handler: createModelListHandler(read) });
    out.available = true;
    log(`设置页模型清单通道已装：${MODEL_LIST_PATH}`);
  } catch (err) {
    out.note = `模型清单路由注册失败（路径被占用？）：${clip(err?.message ?? err)}`;
  }
  return out;
}
