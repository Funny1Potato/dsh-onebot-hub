/**
 * WebSocket 传输层。
 *
 * 两个方向都用 OneBot v11 原生协议：
 *  - **DownstreamEndpoint**：hub 充当"实现端"，接受下游 bot 的反向 WS 连接
 *    （下游是客户端，握手头带 `X-Self-ID`，§19.5 实测 NoneBot 只校验这一个头）。
 *    挂载方式与附录 B 一致：`new WebSocketServer({noServer:true})` + `handleUpgrade`。
 *  - **UpstreamEndpoint**：hub 充当"客户端"，拨号真正的 QQ 实现端（正向 WS），
 *    握手头带 `X-Self-ID` + `X-Client-Role: Universal`（一份连接同时收事件发 action）。
 *  - **UpstreamListener**：hub 充当"服务端"，等实现端用**反向 WS** 拨进来（LLOneBot/
 *    Lagrange 一类实现端就是这个模式：它配置里只有 `ws-reverse` 的 url，正向 WS 服务端是关的）。
 *    收进来的这条 socket 语义与正向链完全一样——实现端推事件、answer action。
 */

import { createServer } from 'node:http';

import { makeError } from './protocol.js';

const WS_OPEN = 1;
const MAX_BODY_BYTES = 1024 * 1024;

function headerOf(req, name) {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearerOf(req) {
  const auth = headerOf(req, 'authorization');
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

export class DownstreamEndpoint {
  #wss;
  #sessions = new Map();
  #accessToken;
  #onConnection;
  #onClose;
  #log;

  /**
   * @param {{accessToken?:string, onConnection:(session:DownstreamSession)=>void,
   *          onClose?:(session:DownstreamSession)=>void, log?:(...a:any[])=>void}} opts
   */
  constructor({ accessToken, onConnection, onClose, log } = {}) {
    this.#accessToken = accessToken ?? null;
    this.#onConnection = onConnection;
    this.#onClose = onClose;
    this.#log = log ?? (() => {});
  }

  get sessions() {
    return [...this.#sessions.values()];
  }

  sessionBySelfId(selfId) {
    return this.#sessions.get(String(selfId)) ?? null;
  }

  /** 供 `ctx.webServer.registerUpgrade` 或裸 http server 的 `upgrade` 事件使用。 */
  handleUpgrade(req, socket, head) {
    const selfId = headerOf(req, 'x-self-id');
    if (!selfId) {
      this.#log('拒绝连接：缺少 X-Self-ID 头');
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.#accessToken) {
      const token = bearerOf(req) ?? headerOf(req, 'x-access-token');
      if (token !== this.#accessToken) {
        this.#log(`拒绝连接 ${selfId}：access token 不匹配`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    this.#wss ??= new (requireWs().WebSocketServer)({ noServer: true });

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const key = String(selfId);
      const prev = this.#sessions.get(key);
      if (prev && prev.isOpen) {
        this.#log(`self_id ${key} 重复连接，关闭旧连接`);
        prev.close(1008, 'Duplicate X-Self-ID');
      }
      const session = new DownstreamSession({
        selfId: key,
        ws,
        role: headerOf(req, 'x-client-role') ?? 'Universal',
        log: this.#log,
      });
      this.#sessions.set(key, session);
      ws.on('close', () => {
        if (this.#sessions.get(key) === session) this.#sessions.delete(key);
        this.#onClose?.(session);
      });
      this.#log(`下游链路已连接：self_id=${key} role=${session.role}`);
      this.#onConnection?.(session);
    });
  }

  close() {
    for (const s of this.#sessions.values()) s.close(1001, 'hub shutting down');
    this.#sessions.clear();
  }
}

let _ws;
function requireWs() {
  if (!_ws) throw new Error('未加载 ws 模块');
  return _ws;
}
/** 由 index.js 在启动时注入 `ws` 模块（插件环境下从 profile 解析）。 */
export function useWs(wsModule) {
  _ws = wsModule;
}

/**
 * 下游拨号端：hub 主动拨号下游 bot 的**反向 WS 服务端**（§19.5 实测 NoneBot 的
 * `/onebot/v11/ws` 就是这种服务端）。
 *
 * 现实的拓扑里，下游是一个 NoneBot 实例时它自己是"反向 WS 服务端"，
 * 由**实现端**去拨它并声明 `X-Self-ID`；所以"hub 控制下游"必须支持这个方向。
 * 拨通后得到一个与"被拨入"完全等价的 DownstreamSession：
 * hub 往这条连接推事件（下游当作上游事件收到），下游从这条连接回 action。
 */
/**
 * 下游**自有端口**的接入端（§19 多下游）：
 *  - `ws` 型（hub 监听、对方拨进来）：一个目标一个 ws 端点，upgrade 交给 `onUpgrade`
 *    （通常是 `DownstreamEndpoint.handleUpgrade`）；
 *  - `http` 型（hub 提供 HTTP API）：`POST <path>/<action>`，交给 `onRequest`。
 *
 * 为什么要自己起 http 服务器而不是挂 DSH 的 webServer：下游应用拨的地址是它自己配的
 * （`ws://127.0.0.1:8654/onebot/v11/ws`），地址里的端口得由**我们**真的监听上——
 * 挂在宿主 webServer 上就只能用宿主的端口，配置里的端口是个摆设。一个目标一个端口，
 * 谁也不影响谁，和 `upstreamListen` 是同一套思路。
 */
export class DownstreamHttpListener {
  #host;
  #port;
  #path;
  #scheme;
  #accessToken;
  #onUpgrade;
  #onRequest;
  #log;
  #server = null;
  #stats = { requests: 0, upgrades: 0, rejected: 0, errors: 0, lastError: null, lastErrorAt: null };

  /**
   * @param {{host?:string, port:number, path?:string, accessToken?:string,
   *          onUpgrade?:(req:any, socket:any, head:any)=>void,
   *          onRequest?:(input:{action:string, params:any, echo:any, selfId:string|null, req:any, res:any})=>void,
   *          log?:(...a:any[])=>void}} opts
   */
  constructor({ host = '127.0.0.1', port, path = '/', scheme = 'ws', accessToken, onUpgrade, onRequest, log } = {}) {
    this.#host = host;
    this.#port = Number(port) || 0;
    this.#path = normalizePath(path);
    this.#scheme = scheme === 'http' ? 'http' : 'ws';
    this.#accessToken = accessToken ?? null;
    this.#onUpgrade = onUpgrade;
    this.#onRequest = onRequest;
    this.#log = log ?? (() => {});
  }

  get path() {
    return this.#path;
  }

  /** 真正绑上的地址（`port: 0` 时端口由内核分配，测试要用它）。 */
  get address() {
    const addr = this.#server?.address();
    if (!addr || typeof addr !== 'object') return { host: this.#host, port: this.#port, path: this.#path };
    return { host: addr.address, port: addr.port, path: this.#path };
  }

  get isListening() {
    return this.#server?.listening === true;
  }

  get url() {
    const { host, port, path } = this.address;
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `${this.#scheme}://${shown}:${port}${path}`;
  }

  get status() {
    return { listening: this.isListening, ...this.address, url: this.url, ...this.#stats };
  }

  start() {
    if (this.#server) return this;
    const server = createServer((req, res) => this.#handleRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    server.on('error', (err) => {
      this.#stats.errors += 1;
      this.#stats.lastError = String(err?.message ?? err);
      this.#stats.lastErrorAt = Date.now();
      this.#log(`下游接入端 ${this.#host}:${this.#port}${this.#path} 出错：${err?.message ?? err}`);
    });
    server.listen(this.#port, this.#host, () => {
      const { port, host } = this.address;
      this.#log(`下游接入端已监听 ${host}:${port}${this.#path}`);
    });
    this.#server = server;
    return this;
  }

  stop() {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    try {
      // 先掐掉活着的连接：否则 close() 要等它们自己断，测试和重启都会卡住。
      server.closeAllConnections?.();
      server.close();
    } catch {
      /* ignore */
    }
  }

  #authorized(req) {
    if (!this.#accessToken) return true;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = url.searchParams.get('access_token');
    const bearer = bearerOf(req);
    return bearer === this.#accessToken || query === this.#accessToken;
  }

  #handleUpgrade(req, socket, head) {
    const urlPath = String(req.url ?? '/').split('?')[0];
    if (!pathMatches(this.#path, urlPath) || !this.#authorized(req)) {
      this.#stats.rejected += 1;
      this.#log(`拒绝下游接入：path=${urlPath}（期望 ${this.#path}）`);
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    this.#stats.upgrades += 1;
    if (!this.#onUpgrade) {
      this.#log(`下游接入端 ${this.#path} 收到 upgrade，但这个目标不是 ws 型`);
      socket.destroy();
      return;
    }
    this.#onUpgrade(req, socket, head);
  }

  #handleRequest(req, res) {
    const send = (status, payload) => {
      try {
        const body = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body);
      } catch {
        /* 客户端可能已经断了 */
      }
    };
    if (req.method !== 'POST') {
      this.#stats.rejected += 1;
      send(405, { status: 'failed', retcode: 1404, msg: '只接受 POST 的 OneBot action' });
      return;
    }
    if (!this.#authorized(req)) {
      this.#stats.rejected += 1;
      this.#log(`下游 HTTP API 拒绝：token 不匹配（${req.url}）`);
      send(401, { status: 'failed', retcode: 1401, msg: 'access token 不匹配' });
      return;
    }
    const urlPath = String(req.url ?? '/').split('?')[0];
    const prefix = this.#path === '/' ? '' : this.#path;
    // 前缀是**前缀**：`/onebot/v11/send_msg` 要落在 `/onebot/v11` 之下（相等或 `前缀/…`）。
    if (prefix && urlPath !== prefix && !urlPath.startsWith(`${prefix}/`)) {
      this.#stats.rejected += 1;
      send(404, { status: 'failed', retcode: 1404, msg: `路径不匹配：期望 ${prefix}/<action>` });
      return;
    }
    const action = urlPath.slice(prefix.length).replace(/^\/+/, '');
    if (!action) {
      this.#stats.rejected += 1;
      send(404, { status: 'failed', retcode: 1404, msg: 'URL 里没有 action 名（形如 /send_msg）' });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        this.#stats.errors += 1;
        send(413, { status: 'failed', retcode: 1404, msg: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let params = {};
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) {
        try {
          params = JSON.parse(raw);
        } catch (err) {
          this.#stats.errors += 1;
          send(400, { status: 'failed', retcode: 1400, msg: `请求体不是合法 JSON：${err?.message ?? err}` });
          return;
        }
      }
      this.#stats.requests += 1;
      try {
        this.#onRequest?.({
          action,
          params: params && typeof params === 'object' ? params : {},
          echo: params && typeof params === 'object' ? (params.echo ?? null) : null,
          selfId: headerOf(req, 'x-self-id') ?? null,
          req,
          res,
        });
      } catch (err) {
        this.#stats.errors += 1;
        this.#stats.lastError = String(err?.message ?? err);
        this.#stats.lastErrorAt = Date.now();
        send(500, { status: 'failed', retcode: 1500, msg: String(err?.message ?? err) });
      }
    });
    req.on('error', () => {
      this.#stats.errors += 1;
    });
  }
}

/** 路径规整：空 = `/`，不以 `/` 开头的补上，尾部多余的 `/` 去掉（`/` 本身除外）。 */
function normalizePath(path) {
  let p = String(path ?? '').trim();
  if (p === '') return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** `期望 /a/b` 与 `/a/b` 或 `/a/b/` 都算匹配。 */
function pathMatches(expected, actual) {
  const want = normalizePath(expected);
  const got = normalizePath(actual);
  return want === got;
}

export class DownstreamDialer {
  #url;
  #selfId;
  #accessToken;
  #reconnectInterval;
  #onConnection;
  #onClose;
  #log;
  #ws = null;
  #timer = null;
  #stopped = true;
  #session = null;
  #attempts = 0;
  #connects = 0;
  #reconnects = 0;
  #lastError = null;
  #lastErrorAt = null;
  #lastOkAt = null;

  /**
   * @param {{id?:string|number, url:string, selfId:string|number, nickname?:string, accessToken?:string,
   *   reconnectInterval?:number, onConnection?:Function, onClose?:Function, log?:Function}} opts
   *   `id` 是**这条目标的唯一键**（配置里的 `id`，缺省 = `selfId`）：多条下游可以各自独立地
   *   连、断、重连，状态与寻址都按 `id` 走，不再只认 selfId（§19 多下游）。
   */
  constructor({ id, url, selfId, nickname, accessToken, reconnectInterval = 5000, onConnection, onClose, log } = {}) {
    this.#url = url;
    this.#selfId = String(selfId);
    this.id = String(id ?? selfId);
    this.nickname = nickname ?? null;
    this.#accessToken = accessToken ?? null;
    this.#reconnectInterval = reconnectInterval;
    this.#onConnection = onConnection;
    this.#onClose = onClose;
    this.#log = log ?? (() => {});
  }

  get selfId() {
    return this.#selfId;
  }

  get url() {
    return this.#url;
  }

  get reconnectInterval() {
    return this.#reconnectInterval;
  }

  get isConnected() {
    return this.#ws?.readyState === WS_OPEN;
  }

  /** 这条目标自己的健康度：多下游时"是哪一条在反复重连"必须看得出来。 */
  get status() {
    return {
      id: this.id,
      selfId: this.#selfId,
      url: this.#url,
      nickname: this.nickname,
      reconnectInterval: this.#reconnectInterval,
      connected: this.isConnected,
      connects: this.#connects,
      reconnects: this.#reconnects,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
      lastOkAt: this.#lastOkAt,
    };
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    try {
      this.#ws?.close(1000, 'hub stopping');
    } catch {
      /* ignore */
    }
    this.#ws = null;
    this.#session = null;
  }

  send(frame) {
    return this.#session ? this.#session.send(frame) : false;
  }

  request(action, params = {}, timeoutMs) {
    if (!this.#session) return Promise.reject(new Error('下游链路未连接'));
    return this.#session.request(action, params, timeoutMs);
  }

  #connect() {
    const WebSocket = requireWs().default ?? requireWs().WebSocket;
    const headers = { 'X-Self-ID': this.#selfId, 'X-Client-Role': 'Universal' };
    if (this.#accessToken) headers.Authorization = `Bearer ${this.#accessToken}`;
    let ws;
    try {
      ws = new WebSocket(this.#url, { headers });
    } catch (err) {
      this.#noteError(err);
      this.#log(`拨号下游 ${this.id} ${this.#url} 失败：${err?.message ?? err}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.on('open', () => {
      this.#attempts = 0;
      this.#connects += 1;
      this.#lastOkAt = Date.now();
      this.#lastError = null;
      const session = new DownstreamSession({
        selfId: this.#selfId,
        ws,
        role: 'Universal(dialed)',
        log: this.#log,
      });
      this.#session = session;
      this.#log(`已拨通下游 ${this.id} ${this.#url}（X-Self-ID=${this.#selfId}）`);
      this.#onConnection?.(session);
    });

    ws.on('close', () => {
      const session = this.#session;
      this.#session = null;
      if (session) this.#onClose?.(session);
      if (!this.#stopped) this.#scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.#noteError(err);
      this.#log(`下游 ${this.id} ${this.#url} socket 错误：${err?.message ?? err}`);
    });
  }

  #noteError(err) {
    this.#lastError = String(err?.message ?? err);
    this.#lastErrorAt = Date.now();
  }

  #scheduleReconnect() {
    clearTimeout(this.#timer);
    this.#reconnects += 1;
    this.#timer = setTimeout(() => {
      if (!this.#stopped) this.#connect();
    }, this.#reconnectInterval);
    this.#timer.unref?.();
  }
}

export class DownstreamSession {
  #ws;
  #pending = new Map();
  #seq = 0;
  #heartbeatTimer = null;

  constructor({ selfId, ws, role, log }) {
    this.selfId = selfId;
    this.role = role;
    this.#ws = ws;
    this.log = log ?? (() => {});
    ws.on('message', (data) => this.#onFrame(data));
    ws.on('error', (err) => this.log(`[${selfId}] socket 错误: ${err?.message ?? err}`));
  }

  get isOpen() {
    return this.#ws.readyState === WS_OPEN;
  }

  send(frame) {
    if (!this.isOpen) return false;
    this.#ws.send(JSON.stringify(frame));
    return true;
  }

  close(code = 1000, reason = '') {
    this.stopHeartbeat();
    try {
      this.#ws.close(code, reason);
    } catch {
      /* 已关闭 */
    }
  }

  /**
   * 往下游发心跳（§19）。
   *
   * 只有 `implementation` 型链路需要：对端把 hub 当 bot 应用，按协议它会等 bot 应用
   * 周期推 `meta_event: heartbeat`；`bot-app` 型（NoneBot 这类）不需要，实测也不认。
   * `intervalMs <= 0` 即关闭。
   */
  startHeartbeat({ intervalMs = 0, status = null, selfId = this.selfId } = {}) {
    this.stopHeartbeat();
    const ms = Math.floor(Number(intervalMs) || 0);
    if (ms <= 0) return false;
    const beat = () => {
      if (!this.isOpen) return;
      this.send({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        self_id: selfId,
        time: Math.floor(Date.now() / 1000),
        interval: ms,
        status: { online: true, good: true, ...(typeof status === 'function' ? status() : status ?? {}) },
      });
    };
    this.#heartbeatTimer = setInterval(beat, ms);
    this.#heartbeatTimer.unref?.();
    this.heartbeatMs = ms;
    return true;
  }

  stopHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.heartbeatMs = 0;
  }

  /** 向该下游请求一个 action 的真实结果（用于镜像/探针）。 */
  request(action, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error('链路未连接'));
        return;
      }
      const echo = `hub-${++this.#seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`action ${action} 超时`));
      }, timeoutMs);
      this.#pending.set(echo, { resolve, reject, timer, action });
      this.send({ action, params, echo });
    });
  }

  #onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      this.log(`[${this.selfId}] 收到非 JSON 帧，已忽略`);
      return;
    }
    const echo = frame?.echo;
    if (echo !== undefined && this.#pending.has(String(echo))) {
      const p = this.#pending.get(String(echo));
      this.#pending.delete(String(echo));
      clearTimeout(p.timer);
      p.resolve(frame);
      return;
    }
    this.onFrame?.(frame);
  }
}

export class UpstreamEndpoint {
  #ws = null;
  #url;
  #selfId;
  #accessToken;
  #reconnectInterval;
  #requestTimeout;
  #heartbeatTimeout;
  #pending = new Map();
  #seq = 0;
  #timer = null;
  #hbTimer = null;
  #stopped = true;
  #lastFrameAt = 0;
  #status = { connected: false, url: null, connects: 0, events: 0, reconnects: 0, lastError: null };

  /**
   * @param {{url:string, selfId:string|number, accessToken?:string, reconnectInterval?:number,
   *          requestTimeout?:number, heartbeatTimeout?:number,
   *          onEvent?:(event:object)=>void, onStatus?:(status:object)=>void, log?:(...a:any[])=>void}} opts
   */
  constructor({ url, selfId, accessToken, reconnectInterval = 5000, requestTimeout = 30000, heartbeatTimeout = 120000, onEvent, onStatus, log } = {}) {
    this.#url = url;
    this.#selfId = selfId;
    this.#accessToken = accessToken ?? null;
    this.#reconnectInterval = reconnectInterval;
    this.#requestTimeout = requestTimeout;
    this.#heartbeatTimeout = heartbeatTimeout;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = log ?? (() => {});
    this.#status.url = url;
  }

  get status() {
    return { ...this.#status, pending: this.#pending.size };
  }

  get isConnected() {
    return this.#ws?.readyState === WS_OPEN;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#hbTimer);
    this.#failAll('hub 已停止');
    try {
      this.#ws?.close(1000, 'hub stopping');
    } catch {
      /* ignore */
    }
    this.#ws = null;
    this.#setStatus({ connected: false });
  }

  #connect() {
    const WebSocket = requireWs().default ?? requireWs().WebSocket;
    const headers = { 'X-Self-ID': String(this.#selfId), 'X-Client-Role': 'Universal' };
    if (this.#accessToken) headers.Authorization = `Bearer ${this.#accessToken}`;
    let ws;
    try {
      ws = new WebSocket(this.#url, { headers });
    } catch (err) {
      this.#setStatus({ connected: false, lastError: String(err?.message ?? err) });
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#lastFrameAt = Date.now();

    ws.on('open', () => {
      this.#setStatus({ connected: true, connects: this.#status.connects + 1, lastError: null });
      this.log(`上游链路已连接：${this.#url}`);
      clearInterval(this.#hbTimer);
      this.#hbTimer = setInterval(() => {
        if (!this.isConnected) return;
        if (Date.now() - this.#lastFrameAt > this.#heartbeatTimeout) {
          this.log('上游心跳超时，主动重连');
          try {
            ws.close(1001, 'heartbeat timeout');
          } catch {
            /* ignore */
          }
        }
      }, Math.max(1000, Math.floor(this.#heartbeatTimeout / 3)));
      this.#hbTimer.unref?.();
    });

    ws.on('message', (data) => {
      this.#lastFrameAt = Date.now();
      this.#onFrame(data);
    });

    ws.on('close', () => {
      clearInterval(this.#hbTimer);
      this.#setStatus({ connected: false });
      this.#failAll('上游链路已断开');
      if (!this.#stopped) {
        this.#setStatus({ reconnects: this.#status.reconnects + 1 });
        this.#scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.#setStatus({ lastError: String(err?.message ?? err) });
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (!this.#stopped) this.#connect();
    }, this.#reconnectInterval);
    this.#timer.unref?.();
  }

  /** 向上游推一条事件（Universal 角色下允许；枢纽对枢纽转发用）。 */
  sendEvent(event) {
    if (!this.isConnected) return false;
    this.#ws.send(JSON.stringify(event));
    return true;
  }

  /** 向上游发 action 并等待真实结果。 */
  request(action, params = {}, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.isConnected) {
        resolve(makeError(null, '上游链路未连接', 1201));
        return;
      }
      const echo = `hub-up-${++this.#seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        resolve(makeError(echo, `上游 action ${action} 超时`, 1200));
      }, timeoutMs ?? this.#requestTimeout);
      this.#pending.set(echo, { resolve, timer });
      this.#ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  #onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      this.log('上游收到非 JSON 帧，已忽略');
      return;
    }
    if (frame?.post_type) {
      this.#setStatus({ events: this.#status.events + 1 });
      this.onEvent?.(frame);
      return;
    }
    const echo = frame?.echo;
    if (echo !== undefined && this.#pending.has(String(echo))) {
      const p = this.#pending.get(String(echo));
      this.#pending.delete(String(echo));
      clearTimeout(p.timer);
      p.resolve(frame);
    }
  }

  #failAll(reason) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve(makeError(null, reason, 1201));
    }
    this.#pending.clear();
  }

  #setStatus(patch) {
    this.#status = { ...this.#status, ...patch };
    this.onStatus?.(this.status);
  }
}

/**
 * 上游**反向 WS 监听端**：hub 自己监听 `host:port/path`，等实现端拨进来。
 *
 * 为什么需要它：OneBot v11 的"反向 WS"里，**实现端主动拨号**到 app 的地址。实测
 * LLBot-Desktop（装在 `D:\LLBot-Desktop`）的配置就是这样——`ob11.connect[]` 里
 * 只有一项 `type:"ws-reverse", enable:true, url:"ws://127.0.0.1:8765/onebot/v11/ws"`，
 * 而正向 WS 服务端（3001）是关的。此时 hub 拨号永远拨不通（ECONNREFUSED），
 * 必须换成本类：监听那个地址，让实现端连进来。
 *
 * 对外接口与 `UpstreamEndpoint` 完全一致（`isConnected` / `status` / `sendEvent` /
 * `request` / `start` / `stop`），所以 hub、工具、状态面板都不用分支。
 */
export class UpstreamListener {
  #host;
  #port;
  #path;
  #accessToken;
  #requestTimeout;
  #heartbeatTimeout;
  #wss = null;
  #ws = null;
  #pending = new Map();
  #seq = 0;
  #hbTimer = null;
  #stopped = true;
  #lastFrameAt = 0;
  #status = {
    connected: false,
    url: null,
    mode: 'listen',
    connects: 0,
    events: 0,
    reconnects: 0,
    lastError: null,
  };

  /**
   * @param {{host?:string, port:number, path?:string, accessToken?:string,
   *          requestTimeout?:number, heartbeatTimeout?:number,
   *          onEvent?:(event:object)=>void, onStatus?:(status:object)=>void,
   *          onIdentity?:(info:{selfId:string, source:string})=>void, log?:(...a:any[])=>void}} opts
   */
  constructor({
    host = '127.0.0.1',
    port,
    path = '/onebot/v11/ws',
    accessToken,
    requestTimeout = 30000,
    heartbeatTimeout = 120000,
    onEvent,
    onStatus,
    onIdentity,
    log,
  } = {}) {
    this.#host = host || '127.0.0.1';
    this.#port = Number(port);
    this.#path = path || '/onebot/v11/ws';
    this.#accessToken = accessToken || null;
    this.#requestTimeout = requestTimeout;
    this.#heartbeatTimeout = heartbeatTimeout;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onIdentity = onIdentity;
    this.log = log ?? (() => {});
    this.#status.url = `ws://${this.#host}:${this.#port}${this.#path}`;
  }

  get status() {
    return { ...this.#status, pending: this.#pending.size };
  }

  get isConnected() {
    return this.#ws?.readyState === WS_OPEN;
  }

  start() {
    this.#stopped = false;
    let WebSocketServer;
    try {
      ({ WebSocketServer } = requireWs());
    } catch (err) {
      this.#setStatus({ lastError: String(err?.message ?? err) });
      return this;
    }
    try {
      this.#wss = new WebSocketServer({ host: this.#host, port: this.#port });
    } catch (err) {
      this.#setStatus({ lastError: `监听 ${this.#host}:${this.#port} 失败：${err?.message ?? err}` });
      return this;
    }
    this.#wss.on('listening', () => {
      // port=0 时由系统分配：把真实端口回填进状态与 url（测试用得上）。
      const addr = this.#wss?.address?.();
      if (addr && typeof addr === 'object' && addr.port) {
        this.#port = addr.port;
        this.#status.url = `ws://${this.#host}:${this.#port}${this.#path}`;
      }
      this.#setStatus({ lastError: null });
      this.log(`上游反向 WS 已监听：${this.#status.url}（等实现端拨进来）`);
    });
    this.#wss.on('error', (err) => this.#setStatus({ lastError: String(err?.message ?? err) }));
    this.#wss.on('connection', (ws, req) => this.#attach(ws, req));
    return this;
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#hbTimer);
    this.#failAll('hub 已停止');
    try {
      this.#ws?.close(1000, 'hub stopping');
    } catch {
      /* ignore */
    }
    this.#ws = null;
    try {
      this.#wss?.close();
    } catch {
      /* ignore */
    }
    this.#wss = null;
    this.#setStatus({ connected: false });
  }

  #authorized(req) {
    if (!this.#accessToken) return true;
    const auth = req?.headers?.authorization;
    if (auth === `Bearer ${this.#accessToken}`) return true;
    const query = String(req?.url ?? '').split('?')[1] ?? '';
    return new URLSearchParams(query).get('access_token') === this.#accessToken;
  }

  #attach(ws, req) {
    const path = String(req?.url ?? '').split('?')[0];
    if (path !== this.#path && path !== `${this.#path}/`) {
      this.log(`拒绝上游连接：path=${path}（期望 ${this.#path}）`);
      try {
        ws.close(1008, 'path mismatch');
      } catch {
        /* ignore */
      }
      return;
    }
    if (!this.#authorized(req)) {
      this.log('拒绝上游连接：access token 不匹配');
      try {
        ws.close(1008, 'unauthorized');
      } catch {
        /* ignore */
      }
      return;
    }
    if (this.#ws && this.#ws !== ws) {
      this.log('已有上游连接，用最新的一条替换');
      try {
        this.#ws.close(1000, 'replaced by a newer upstream');
      } catch {
        /* ignore */
      }
    }
    this.#ws = ws;
    this.#lastFrameAt = Date.now();
    this.#setStatus({ connected: true, connects: this.#status.connects + 1, lastError: null });
    this.log(
      `上游实现端已接入：self_id=${req?.headers?.['x-self-id'] ?? '?'} role=${req?.headers?.['x-client-role'] ?? '?'}`,
    );
    // 对端在握手头里报了它的账号：**从这里就能学到"上游是谁"**，不用等第一条事件。
    // 配置没写 `upstreamSelfId` 时，下游那些"不写对方账号 = 与上游相同"的目标要靠它建链。
    const peerSelfId = req?.headers?.['x-self-id'];
    if (peerSelfId) {
      try {
        this.onIdentity?.({ selfId: String(peerSelfId), source: 'upstream-handshake' });
      } catch (err) {
        this.log(`上报上游账号失败（不影响链路）：${err?.message ?? err}`);
      }
    }
    clearInterval(this.#hbTimer);
    this.#hbTimer = setInterval(() => {
      if (!this.isConnected) return;
      if (Date.now() - this.#lastFrameAt > this.#heartbeatTimeout) {
        this.log('上游心跳超时，断开等待实现端重连');
        try {
          ws.close(1001, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
      }
    }, Math.max(1000, Math.floor(this.#heartbeatTimeout / 3)));
    this.#hbTimer.unref?.();

    ws.on('message', (data) => {
      this.#lastFrameAt = Date.now();
      this.#onFrame(data);
    });
    ws.on('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      clearInterval(this.#hbTimer);
      this.#failAll('上游实现端已断开');
      if (!this.#stopped) this.#setStatus({ connected: false, reconnects: this.#status.reconnects + 1 });
      else this.#setStatus({ connected: false });
    });
    ws.on('error', (err) => this.#setStatus({ lastError: String(err?.message ?? err) }));
  }

  /** 向上游推一条事件（反向链路上实现端通常不接受事件，保留以对齐接口）。 */
  sendEvent(event) {
    if (!this.isConnected) return false;
    this.#ws.send(JSON.stringify(event));
    return true;
  }

  /** 通过这条反向链路向实现端发 action。 */
  request(action, params = {}, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.isConnected) {
        resolve(makeError(null, '上游链路未连接', 1201));
        return;
      }
      const echo = `hub-up-${++this.#seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        resolve(makeError(echo, `上游 action ${action} 超时`, 1200));
      }, timeoutMs ?? this.#requestTimeout);
      this.#pending.set(echo, { resolve, timer });
      this.#ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  #onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      this.log('上游收到非 JSON 帧，已忽略');
      return;
    }
    if (frame?.post_type) {
      this.#setStatus({ events: this.#status.events + 1 });
      this.onEvent?.(frame);
      return;
    }
    const echo = frame?.echo;
    if (echo !== undefined && this.#pending.has(String(echo))) {
      const p = this.#pending.get(String(echo));
      this.#pending.delete(String(echo));
      clearTimeout(p.timer);
      p.resolve(frame);
    }
  }

  #failAll(reason) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve(makeError(null, reason, 1201));
    }
    this.#pending.clear();
  }

  #setStatus(patch) {
    this.#status = { ...this.#status, ...patch };
    this.onStatus?.(this.status);
  }
}
