/**
 * 「OneBot 日志」面板的数据通道（宿主侧）。
 *
 * 形状照 `lib/official/route.js`：`webServer.register({kind:'exact', path, handler})`。
 * 两条路由：
 *  · `GET /onebot-hub/log/recent?n=200&after=0` → `{ok, stats, rows}`（首屏一次取回）
 *  · `GET /onebot-hub/log/stream`              → SSE，`text/event-stream`
 *
 * 为什么用 SSE 而不是 WebSocket：这是**单向**推送，`EventSource` 是浏览器原生的、
 * 自带重连，不需要在客户端半侧引入任何依赖；而 WebSocket 还得考虑和上游那条长连接
 * 抢同一个服务、以及 Electron 里的代理问题。
 */

export const LOG_RECENT_PATH = '/onebot-hub/log/recent';
export const LOG_STREAM_PATH = '/onebot-hub/log/stream';

const HEARTBEAT_MS = 25000;
const STATS_MS = 2000;

const clip = (value, n = 200) => String(value ?? '').slice(0, n);

function jsonBody(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** 从查询串里取正整数，坏值退回默认。 */
function intOf(url, key, fallback) {
  try {
    const value = new URL(url, 'http://x').searchParams.get(key);
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function createLogRecentHandler(getLogbus) {
  return function handle(req, res) {
    const bus = getLogbus();
    if (!bus) return jsonBody(res, 200, { ok: false, rows: [], note: '日志缓冲还没就绪' });
    const n = intOf(req.url, 'n', 200);
    const after = intOf(req.url, 'after', 0);
    jsonBody(res, 200, { ok: true, stats: bus.stats(), rows: bus.recent(n, { after }) });
  };
}

export function createLogStreamHandler(getLogbus) {
  return function handle(req, res) {
    const bus = getLogbus();
    if (!bus) {
      jsonBody(res, 200, { ok: false, note: '日志缓冲还没就绪' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    // 反向代理（Electron 自己的 http 层也算）有时会攒包，这一句让它别攒。
    res.setHeader('x-accel-buffering', 'no');
    // 先把响应头刷出去：有的宿主层会攒着等第一个 chunk，进度条就卡在"正在连…"。
    res.flushHeaders?.();
    res.write?.('retry: 3000\n\n');

    const send = (row) => {
      try {
        res.write?.(`data: ${JSON.stringify(row)}\n\n`);
      } catch {
        /* 连接已经断了，下面 close 会收尾 */
      }
    };
    // 先把缓冲里的补上，免得面板刚打开是空的（`after` 给了就只补新的）。
    // 追一个比现有序号还大的 `after`（面板记的序号来自另一个实例、或缓冲被清空过）时，
    // `recent()` 只会给空——那样这条连接此后只靠 ping 续命，新条目一条也追不上（`m78216` 自查）。
    // 补不到东西就改成从头给：宁可重复几条，也不要一条不给。
    let after = intOf(req.url, 'after', 0);
    let backfill = bus.recent(200, { after });
    if (after > 0 && !backfill.length) {
      const seq = Number(bus.stats?.().seq ?? 0);
      if (seq > 0 && after > seq) {
        after = 0;
        backfill = bus.recent(200);
      }
    }
    for (const row of backfill) send(row);

    const off = bus.subscribe(send);
    // 每帧带一条 stats（每秒一次，就是面板右上那行数字）——它拿不到新条目数量时
    // 也得知道自己落后了多少，不然那个"已记 N 条"会永远停在打开那一刻。
    const sendStats = () => {
      try {
        res.write?.(`event: stats\ndata: ${JSON.stringify(bus.stats())}\n\n`);
      } catch {
        /* 连接断了，close 会收尾 */
      }
    };
    sendStats();
    const statsTimer = setInterval(sendStats, STATS_MS);
    statsTimer.unref?.();

    const timer = setInterval(() => {
      try {
        res.write?.(': ping\n\n');
      } catch {
        /* 同上 */
      }
    }, HEARTBEAT_MS);
    timer.unref?.();

    const close = () => {
      clearInterval(timer);
      clearInterval(statsTimer);
      off();
    };
    res.on?.('close', close);
    res.on?.('error', close);
  };
}

/**
 * 装上两条路由。返回 `{available, paths, dispose, note}`——装不上只记一行日志，
 * 不能让一块面板把插件装配拖垮。
 */
export function installLogRoute(ctx, { getLogbus = () => null, log = () => {} } = {}) {
  const out = { available: false, paths: [LOG_RECENT_PATH, LOG_STREAM_PATH], note: '' };
  const webServer = (ctx && ctx.webServer) || (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer || typeof webServer.register !== 'function') {
    out.note = '宿主没有 webServer.register：日志面板取不到数据';
    return out;
  }
  const disposers = [];
  try {
    disposers.push(webServer.register({ kind: 'exact', path: LOG_RECENT_PATH, handler: createLogRecentHandler(getLogbus) }));
    disposers.push(webServer.register({ kind: 'exact', path: LOG_STREAM_PATH, handler: createLogStreamHandler(getLogbus) }));
    out.available = true;
    out.dispose = () => {
      for (const fn of disposers) {
        try {
          if (typeof fn === 'function') fn();
        } catch {
          /* 退订失败不该冒泡 */
        }
      }
    };
    log(`日志面板通道已装：${LOG_RECENT_PATH} / ${LOG_STREAM_PATH}`);
  } catch (err) {
    out.note = clip(err?.message ?? err);
  }
  return out;
}
