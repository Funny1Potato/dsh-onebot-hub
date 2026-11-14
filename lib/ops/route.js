/**
 * 设置页的**运维一栏**（审查报告"会话权限预览 / 按会话清理与导出"，`m85685`）。
 *
 * 形状照 `lib/persona/route.js` 与 `lib/official/route.js`：`webServer.register` 一个精确路径，
 * 页面自己 `fetch`。不开在客户端里是因为这些数据都在服务端（存储、时间线、档案、任务），
 * 客户端 declare 不到。
 *
 * 接口：
 *  · `GET  /onebot-hub/ops?scope=<会话键>`
 *      → `{ ok, scope, readScope, permissions, inventory, tasks, exports, sessions }`
 *  · `POST /onebot-hub/ops  { op:'export', scope }`
 *  · `POST /onebot-hub/ops  { op:'purge',  scope, confirm }`   ← 两道确认，见 `session-data.js`
 *
 * 只读的那一半永远在（GET）；写的那一半只有 `export` / `purge` 两种，且都要 `scope`——
 * 这个端点不做"随便删点什么"，误调用的代价太大。
 */

import { describeReadScope, parseTrustedPrivates } from '../read-scope.js';
import { SessionData } from './session-data.js';

export const OPS_PATH = '/onebot-hub/ops';

const MAX_BODY_BYTES = 8 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const parts = [];
  req.on('data', (buf) => {
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('请求体过大'));
      req.destroy?.();
      return;
    }
    parts.push(buf);
  });
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8').trim();
    if (!text) return resolve({});
    try {
      resolve(JSON.parse(text));
    } catch {
      reject(new Error('请求体不是合法 JSON'));
    }
  });
  req.on('error', reject);
});

/** 名单的三种形状（数组 / 按 id 的对象 / 空）统一成 `[id, row]`。 */
function pairsOf(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list.map((row) => [String(row?.id ?? row ?? ''), row]);
  if (typeof list === 'object') return Object.entries(list).map(([id, row]) => [id, row]);
  return [];
}

/** 会话清单：配了名单的群/私聊 + 时间线里出现过的（最多 40 条，新的在前）。 */
function sessionList(hub, config, limit = 40) {
  const out = new Map();
  const push = (key, label) => {
    const k = String(key ?? '').trim();
    if (!k || !/^(group|private):\d+$/.test(k)) return;
    if (!out.has(k)) out.set(k, { key: k, label: String(label ?? '').trim() });
  };
  // 名单在两种形状之间来回：schema 里是 JSON 字符串，`resolveConfig()` 解析成**按 id 索引的对象**
  // （`{ '617770183': { mode } }`），只有测试里的假配置才是数组。这里三种都认——按数组遍历对象
  // 会直接抛 `object is not iterable`，而所有快照都要经过这里（复审 F10）。
  for (const [id, row] of pairsOf(config?.agentGroups)) push(`group:${id}`, row?.name ?? '');
  for (const [id, row] of pairsOf(config?.agentPrivates)) push(`private:${id}`, row?.name ?? '');
  try {
    const recent = hub?.timeline?.recent?.(200, {}) ?? [];
    for (const e of recent) push(e?.sessionKey, '');
  } catch {
    /* 时间线不可用就只报名单里那些 */
  }
  return [...out.values()].slice(0, limit);
}

export function createOpsHandler({ getHub, getConfig, log = () => {} } = {}) {
  return async function handle(req, res) {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const hub = getHub?.() ?? null;
    if (!hub) return send(200, { ok: false, error: '枢纽还没装配好' });
    const config = getConfig?.() ?? {};
    const ops = new SessionData({ hub, log });
    const trusted = new Set(parseTrustedPrivates(config?.isolation?.trustedPrivates ?? []));
    const current = String(hub?.mind?.activeSessionKey ?? '');

    // 快照本身不许抛（复审 F10）：POST 是先干活再取快照，快照一抛，界面就会"操作做完了却报失败"。
    // 逐块兜底，坏一块只少一块，别把整页拖下去。
    const snapshot = async (scopeRaw) => {
      const scope = String(scopeRaw ?? '').trim();
      let inventory = null;
      if (scope) {
        try {
          inventory = await ops.inventory(scope);
        } catch (err) {
          inventory = { error: `盘不出来：${err?.message ?? err}` };
        }
      }
      return {
        ok: true,
        scope,
        readScope: {
          current,
          text: describeReadScope({ current, trusted }),
          trusted: [...trusted],
        },
        permissions: {
          writeAllow: Array.isArray(config?.capability?.writeAllow) ? config.capability.writeAllow : [],
          dangerAllow: Array.isArray(config?.capability?.dangerAllow) ? config.capability.dangerAllow : [],
          unattended: config?.agentPolicy?.unattended ?? '',
          permissionPreset: config?.agentPermissionPreset ?? '',
          vendor: hub?.capabilities?.snapshot?.()?.vendor ?? null,
        },
        inventory,
        tasks: (() => {
          try {
            return hub?.tasks?.list?.({ all: true }) ?? [];
          } catch {
            return [];
          }
        })(),
        failures: (() => {
          try {
            return hub?.failures?.list?.({ limit: 20 }) ?? [];
          } catch {
            return [];
          }
        })(),
        exports: ops.exports(),
        sessions: sessionList(hub, config),
      };
    };

    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return send(200, await snapshot(url.searchParams.get('scope') ?? ''));
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 GET / POST' });

    let body = {};
    try {
      body = await readBody(req);
    } catch (err) {
      return send(400, { ok: false, error: String(err?.message ?? err) });
    }
    const op = String(body?.op ?? '').trim();
    if (op === 'export') {
      // 导出本身就返回一份快照：页面不用再多打一次 GET（两次请求之间数据可能已经变了）。
      const r = await ops.exportBundle(body?.scope);
      return send(200, { ...(await snapshot(String(body?.scope ?? ''))), result: r });
    }
    if (op === 'purge') {
      const r = await ops.purge(body?.scope, { confirm: body?.confirm });
      return send(200, { ...(await snapshot(String(body?.scope ?? ''))), result: r });
    }
    /**
     * 任务台账上的三个动作（`m85685`）。`caller: ''` = 设置页面的操作者视角：
     * 能打开设置页的人本来就能改配置，再按会话卡权限只是自欺（工具面那一层仍然按会话卡）。
     */
    if (op === 'pause_task' || op === 'resume_task' || op === 'remove_task') {
      const id = String(body?.id ?? '').trim();
      if (!id) return send(400, { ok: false, error: '要带 id' });
      const tasks = hub?.tasks ?? null;
      if (!tasks || typeof tasks.pause !== 'function') {
        return send(200, { ...(await snapshot('')), result: { ok: false, error: '这个版本没有任务面板能力' } });
      }
      const r = op === 'pause_task'
        ? await tasks.pause(id, { caller: '' })
        : (op === 'resume_task' ? await tasks.resume(id, { caller: '' }) : await tasks.remove(id, { caller: '' }));
      return send(200, { ...(await snapshot(String(body?.scope ?? ''))), result: r });
    }
    /**
     * 失败队列（`m85685`）：`replay` 手动重发一次，`forget_failure` 只从队列里抹掉。
     * 重放**不改内容**——当初是什么就发什么；失败通常是系统性的，改参数重试是另一件事。
     */
    if (op === 'replay' || op === 'forget_failure') {
      const id = String(body?.id ?? '').trim();
      if (!id) return send(400, { ok: false, error: '要带 id' });
      const failures = hub?.failures ?? null;
      if (!failures) return send(200, { ...(await snapshot('')), result: { ok: false, error: '这个版本没有失败队列' } });
      if (op === 'forget_failure') {
        const gone = failures.remove(id);
        return send(200, { ...(await snapshot('')), result: gone ? { ok: true, id } : { ok: false, error: `没有这条：${id}` } });
      }
      const plan = failures.paramsFor(id);
      if (!plan.ok) return send(200, { ...(await snapshot('')), result: plan });
      let response = null;
      try {
        response = await hub.callUpstream(plan.action, plan.params);
      } catch (err) {
        return send(200, { ...(await snapshot('')), result: { ok: false, error: `重放失败：${err?.message ?? err}` } });
      }
      const ok = response?.status === 'ok';
      if (ok) failures.remove(id);
      return send(200, {
        ...(await snapshot('')),
        result: {
          ok,
          id,
          action: plan.action,
          ...(ok ? { replayed: true } : { error: response?.error ?? response?.message ?? response?.msg ?? `上游回 ${response?.status ?? '?'}` }),
        },
      });
    }
    return send(400, { ok: false, error: `不认识的操作：${op || '空'}（只支持 export / purge / pause_task / resume_task / remove_task / replay / forget_failure）` });
  };
}

/** 把路由挂到宿主的 webServer 上（`ctx.effect` 里调，返回值形如 persona/official 的 routeInfo）。 */
export function installOpsRoute(ctx, { getHub, getConfig, log = () => {} } = {}) {
  if (typeof ctx?.webServer?.register !== 'function') return null;
  const handler = createOpsHandler({ getHub, getConfig, log });
  const route = ctx.webServer.register({ kind: 'exact', path: OPS_PATH, handler });
  return { ops: OPS_PATH, route };
}
