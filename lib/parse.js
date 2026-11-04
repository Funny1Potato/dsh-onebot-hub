/**
 * 纯解析：代码路径、连接形态、上游地址、目标列表、模型引用，以及一批小工具。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），逻辑逐字未改。这一块没有任何 IO、
 * 不依赖配置对象之外的运行期状态，所以搬动风险最低。
 */

/**
 * 一串路径文本 → 路径数组（`parseCodeScopes` 的零件）：一行一个，去空行、去重复。
 * 老配置里 `code.roots` 就是这种纯文本，所以这个函数留着。
 */
export function parseCodeRoots(raw) {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
  const seen = new Set();
  const out = [];
  for (const line of text.split(/[\r\n]+/)) {
    const item = line.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 下游 bot 源码范围（M7-③，`m14112` / `m14477`）：**只告诉 agent 位置、不给它扫描工具**，
 * 而且位置**不写进 prompt**——agent 需要时调 `onebot_code_scopes` 取（可能有多个下游）。
 *
 * 认三种写法，都是为了"手写配置也能活"：
 *  - JSON 数组：`[{"name":"下游A","path":"D:/x"}]`（设置页行编辑器写的就是它）
 *  - JSON 字符串数组：`["D:/x","D:/y"]`
 *  - 纯文本：一行一个路径（`备注 = 路径` 也认）
 * 去掉空项、按路径去重（先出现的那个备注留下）。
 */
export function parseCodeScopes(raw) {
  const items = [];
  const pushItem = (item) => {
    if (item === undefined || item === null) return;
    if (typeof item === 'string') {
      // 一行一个路径；`备注 = 路径` 是手写时的顺手写法（等号左边的空格会被去掉）。
      for (const line of parseCodeRoots(item)) {
        const at = line.indexOf('=');
        if (at > 0) items.push({ name: line.slice(0, at).trim(), path: line.slice(at + 1).trim() });
        else items.push({ name: '', path: line });
      }
      return;
    }
    if (typeof item !== 'object') return;
    items.push({
      name: String(item.name ?? item.label ?? item.note ?? '').trim(),
      path: String(item.path ?? item.dir ?? item.root ?? item.value ?? '').trim(),
    });
  };

  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        value = JSON.parse(text);
      } catch {
        // 坏 JSON 也**不许**把整条配置丢掉：把里面的路径值抠出来（名字丢了，总比整条没了强）。
        const salvaged = [];
        for (const match of text.matchAll(/"(?:path|dir|root|value)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          salvaged.push({ name: '', path: match[1].replace(/\\"/g, '"') });
        }
        // 一个也没抠出来（比如只是少了个括号）时，退回按行解析。
        value = salvaged.length ? salvaged : [text];
      }
    } else {
      value = [text];
    }
  }
  if (Array.isArray(value)) for (const item of value) pushItem(item);
  else pushItem(value);

  const seen = new Set();
  const out = [];
  for (const item of items) {
    const path = String(item?.path ?? '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ name: String(item?.name ?? '').trim(), path });
  }
  return out;
}

/** 源码范围的**人读**写法（日志与状态用）：`备注（路径）`，没备注就只写路径。 */
export function describeCodeScopes(scopes) {
  return (Array.isArray(scopes) ? scopes : [])
    .map((scope) => (scope?.name ? `${scope.name}（${scope.path}）` : String(scope?.path ?? '')))
    .filter(Boolean);
}

export function readField(value, fallback) {
  if (value === undefined) return fallback;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const inner = value.get();
    return inner === undefined ? fallback : inner;
  }
  return value;
}

/** 把"用户填的 0~1 数值"夹到合法区间；坏值（NaN/字符串）退回默认，不让 NaN 传下去。 */
export function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

export function parseJsonObject(text, fallback) {
  const parsed = parseJsonValue(text, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

export function parseJsonValue(text, fallback) {
  if (typeof text !== 'string') return text === undefined ? fallback : text;
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * `onebot_memory` 的 `ops`：对象与字符串都收，**包括"双重编码"**（`m02432` P8）。
 *
 * 真机症状：模型把 `{short_term:{...}}` 先 stringify 成字符串、然后又当字符串发了一次，于是
 * `parseJsonValue` 解出来还是一个字符串 → 写入侧看到"不是对象"，整轮 `applied` 全是 0、
 * `rejected:[{path:'memory',reason:'指令必须是对象'}]`，而模型以为自己写成功了。
 * 所以这里最多连解三层（顺带剥掉 ```json 代码围栏）；解析不出来就交给 `applyMemoryOps`
 * 给一条读得懂的拒绝理由。
 */
export function coerceOps(value) {
  let cur = value;
  for (let i = 0; i < 3; i += 1) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) return cur;
    if (typeof cur !== 'string') return null;
    const text = cur.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (!text) return null;
    try {
      cur = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : null;
}

/**
 * 解析"上游反向 WS 监听地址"：**地址里直接带路径**——`host:port/path`。
 * 接受：
 *  - `127.0.0.1:8765/onebot/v11/ws`（推荐写法，一份配置说完整）
 *  - `ws://127.0.0.1:8765/onebot/v11/ws`（直接粘完整 URL 也认，scheme 被忽略）
 *  - `:8765/onebot/v11/ws`、`8765/onebot/v11/ws`（缺 host 时默认 `127.0.0.1`）
 *  - `127.0.0.1:8765`、`127.0.0.1:8765/`（**没写路径 = 根路径 `/`**）
 * 空串表示不监听。
 *
 * 为什么把路径并进来：路径本来就是"这个监听地址的一部分"（实现端拨的 URL 里有它），
 * 拆成两个配置项只会让人改了一半（改了地址忘了路径）然后对着 1008 发呆。
 *
 * 为什么**不做**"缺省补 `/onebot/v11/ws`"：写什么就是什么。偷偷补一条默认路径，
 * 就会出现"我明明写的是 `127.0.0.1:8765`，它却只接受 `/onebot/v11/ws`"这种
 * 怎么查都查不出来的错配——那比不监听更难排查。
 *
 * 为什么要有这个模式（§19 实测）：LLOneBot/Lagrange 这类实现端常配成**反向 WS**——
 * 它主动拨 app 的地址（例：`D:\LLBot-Desktop\data\config_<QQ号>.json`
 * 里 `{"type":"ws-reverse","url":"ws://127.0.0.1:8765/onebot/v11/ws","enable":true}`），
 * 而正向 WS 服务端是关的。此时 hub 拨号永远 ECONNREFUSED，只能自己监听那个地址。
 */
export function parseListenTarget(raw) {
  const parsed = parseAddress(raw, { defaultHost: '127.0.0.1' });
  // 上游监听端**不许 0 端口**：没人能拨一个"内核随便挑的端口"（下游监听型目标才允许 0）。
  return parsed && parsed.port > 0 ? { host: parsed.host, port: parsed.port, path: parsed.path } : null;
}

/** 从地址里认出 scheme（`ws`/`wss`/`http`/`https`），没有就返回 null。 */
export function schemeOfAddress(raw) {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(raw ?? '').trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return ['ws', 'wss', 'http', 'https'].includes(scheme) ? scheme : null;
}

/**
 * 统一地址解析（§19）：`[scheme://]host[:port][/path]` → `{scheme, host, port, path}`。
 *
 * 上下游**同一套写法**（用户定的规矩）：`127.0.0.1:8654/onebot/v11/ws`，scheme 可省；
 * 不写路径 = 根路径 `/`（**不偷偷补默认**，写什么就是什么）。`port: 0` 允许——监听型
 * 目标可以用它让内核分配端口（测试就这么用）。解析不出来（没有端口 / 端口不是数字 /
 * 越界）返回 null，调用方按"这条目标无效"处理。
 */
export function parseAddress(raw, { defaultHost = '127.0.0.1' } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const scheme = schemeOfAddress(text);
  const withoutScheme = scheme ? text.slice(text.indexOf('://') + 3) : text;
  const cut = withoutScheme.search(/[/?#]/);
  const authority = cut === -1 ? withoutScheme : withoutScheme.slice(0, cut);
  const rawPath = cut === -1 ? '' : withoutScheme.slice(cut).split('?')[0].split('#')[0];
  const colon = authority.lastIndexOf(':');
  const host = (colon === -1 ? '' : authority.slice(0, colon)).trim();
  const portText = colon === -1 ? authority : authority.slice(colon + 1);
  if (portText.trim() === '' || !/^\d+$/.test(portText.trim())) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let path = rawPath.trim();
  if (path === '') path = '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return { scheme, host: host === '' ? defaultHost : host, port, path };
}

/** 下游目标的连接形态（§19）：从 **hub 自己的动作**命名，避免"正/反向"两套叫法打架。 */
export const DOWNSTREAM_TYPES = ['ws-dial', 'ws-listen', 'http-api', 'http-post'];

export const DOWNSTREAM_TYPE_ALIASES = {
  'ws-dial': 'ws-dial',
  dial: 'ws-dial',
  'ws-reverse': 'ws-dial', // LLBot/NoneBot 的说法：实现端拨出去
  'ws-listen': 'ws-listen',
  listen: 'ws-listen',
  ws: 'ws-listen', // LLBot 的 `ws`：实现端开服务端，等 app 拨进来
  'http-api': 'http-api',
  api: 'http-api',
  http: 'http-api', // LLBot 的 `http`
  'http-post': 'http-post',
  post: 'http-post',
  http_post: 'http-post',
  'http-post-url': 'http-post',
};

/** 把类型字符串规整成四种之一；认不出来就用 `fallback`（默认拨号）。 */
export function normalizeDownstreamType(raw, fallback = 'ws-dial') {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  return DOWNSTREAM_TYPE_ALIASES[text] ?? fallback;
}

/** 每条目标自己的协议族：`ws-*` 走 WebSocket，`http-*` 走 HTTP。 */
export function protocolOfType(type) {
  return type.startsWith('http') ? 'http' : 'ws';
}

/**
 * 把配置里的 JSON 字符串或数组规整成下游目标列表（§19 多下游）。
 *
 * 每条目标：
 *  - `id`：**唯一键**（缺省 = 显式写的 `selfId`；没写 selfId 时用 `<host>:<port>`，免得
 *    多条"默认账号"的目标互相撞成 `#2`）。同 `id` 出现多次时自动加 `#2`/`#3`——两个目标
 *    用同一个 bot 账号接两个 app 是合法用法，但链路必须各自可寻址。
 *  - `type`：`ws-dial`（默认，hub 拨出去）｜`ws-listen`（hub 监听，对方拨进来）｜
 *    `http-api`（hub 提供 HTTP API）｜`http-post`（hub 把事件 POST 给对方）。
 *    也认 LLBot 的写法：`ws-reverse`→`ws-dial`、`ws`→`ws-listen`、`http`→`http-api`。
 *  - `address`（别名 `url`）：**统一写法** `host:port/path`（scheme 可省，按类型补
 *    `ws://` / `http://`；写了 `wss://`/`https://` 就按 TLS 走）。
 *  - `selfId`：这条链路上**对方（app）的账号**。**不写 = 与上游相同**（取
 *    `options.defaultSelfId`，也就是 `upstreamSelfId`）。
 *  - `nickname`、`accessToken`、`enabled`（默认 true）、`reconnectInterval`（拨号型）。
 *  - `probeOnly`（默认 false）：标了它的链路在链路隔离（`probe.isolation: 'link'`）下**只收注入**、
 *    不收上游消息；上游消息广播时跳过它。
 *  - `probeSelfId`：**探针账号**——同一个下游、另一个 bot 账号。写了它就等于一次声明两条链路：
 *    主链路照旧，另加一条探针链路（`probeOnly: true`，地址与本条**相同**，只有 `selfId` 不同），
 *    两者共用同一个 `downstreamId`，探针那条的 id 是 `<id>~probe`。**不写就不展开**——
 *    链路隔离因此没有默认值：没配探针账号时那一档会回退到关闭。与主链路账号相同时也不展开
 *    （下游会拿 `Duplicate X-Self-ID` 把第二条踢掉）。
 *  - `downstreamId`：**逻辑下游** id（缺省 = `selfId`）。同一逻辑下游的多条物理链路写同一个
 *    值，agent 才知道"这两条是同一个 bot 的两个实例"；`id` 是物理链路键，两者不是一回事。
 *
 * **不做静默丢弃**：缺地址 / 缺端口 / 拨号型把 0 端口当监听地址写的条目会被跳过（hub 会记日志）。
 * 拨号型既没写 selfId、上游账号也还没配时**不丢**：照旧登记，`pendingAccount: true`，hub 先不建链，
 * 等学到上游账号（握手头 / 事件 `self_id` / `get_login_info`）再自动补建。
 * 类型与地址里的 scheme 打架（例：`http-api` 写了 `ws://`）不丢条目，但会带一条
 * `warning` 说明"按哪个走"。
 */
export function normalizeTargets(raw, options = {}) {
  const defaultSelfId = String(options.defaultSelfId ?? '');
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const counts = new Map();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const typed = String(entry.selfId ?? entry.self_id ?? '');
    // 不写对方账号 = 与上游相同（用户要求）。上游账号**也还不知道**时留空、但**不丢**这条目标：
    // hub 先不建链（拿空身份握手没意义），等学到上游账号再补建——学到账号的路子有三条
    // （对方握手头 `X-Self-ID`、上游事件的 `self_id`、`get_login_info` 探测），见 hub.js 的
    // `learnUpstreamAccount` / `#adoptUpstreamAccount`。
    const selfId = typed || defaultSelfId;
    const explicitId = String(entry.id ?? '');
    const mainParsed = parseAddress(entry.address ?? entry.url, { defaultHost: '127.0.0.1' });
    // id 只认**显式**写的 selfId：默认账号（= 上游账号）可能落在多条目标上，拿它当键会
    // 让它们互相挤成 `#2`/`#3`，反倒不好寻址；没写就用地址。`||` 而非 `??`：空串要落到下一档。
    const mainBase = String(explicitId || typed || (mainParsed ? `${mainParsed.host}:${mainParsed.port}` : ''));
    /**
     * 逻辑下游 id（§19 / M7-④）：**两条物理链路属于同一个下游**这件事只能由人声明，
     * agent 猜不出来——`selfId` 是枢纽替对方扮演的账号（可以随便配），不是身份证据。
     * 缺省 = 这条链路的对方账号（`selfId`，没写就与上游相同），所以"只换端口不换 selfId"
     * 的两条链路**天然归到同一组**；要显式分组就写 `downstreamId`。
     */
    const downstreamId = String(entry.downstreamId ?? entry.downstream_id ?? selfId ?? '').trim() || mainBase;
    /**
     * 一条目标可以自带**探针账号**（`probeSelfId`，别名 `probe_self_id`）：hub 把它展开成
     * **第二条链路**（`probeOnly: true`，地址与本条相同、只有 `selfId` 不同），与主链路共用
     * 同一个 `downstreamId`——**一个下游写一条配置**，不必写两条必须互相对齐的条目（写岔了
     * 就会把探针注入打到真链路上）。**不写就不展开**，所以链路隔离没有默认值。与主链路账号
     * 相同时也不展开（下游按 `self_id` 注册，同 id 第二条会被 `Duplicate X-Self-ID` 踢掉）。
     */
    const probeSelfId = String(entry.probeSelfId ?? entry.probe_self_id ?? '').trim();
    const probeDiffers = probeSelfId !== '' && probeSelfId !== selfId;
    const variants = [{
      parsed: mainParsed,
      type: normalizeDownstreamType(entry.type),
      probeOnly: entry.probeOnly === true || entry.probe_only === true,
      idBase: mainBase,
      selfId,
    }];
    if (mainParsed && probeDiffers) {
      variants.push({
        parsed: mainParsed,
        type: normalizeDownstreamType(entry.type),
        probeOnly: true,
        // 探针那条的 id 不能与主链路撞：显式 id 加 `~probe`，否则用主链路键加后缀。
        idBase: (explicitId || typed || `${mainParsed.host}:${mainParsed.port}`) + '~probe',
        selfId: probeSelfId,
      });
    }
    for (const variant of variants) {
      const parsed = variant.parsed;
      if (!parsed) continue;
      const type = variant.type;
      const targetSelfId = variant.selfId;
      const dialsOut = type === 'ws-dial' || type === 'http-post';
      if (dialsOut && parsed.port === 0) continue;
      const want = protocolOfType(type);
      const scheme = parsed.scheme ?? (want === 'http' ? 'http' : 'ws');
      const schemeFamily = scheme === 'wss' || scheme === 'ws' ? 'ws' : 'http';
      const warning = schemeFamily === want ? undefined : `type=${type} 但地址写的是 ${scheme}://，按 ${type} 解释（scheme 只用来决定要不要 TLS）`;
      const base = variant.idBase || `${parsed.host}:${parsed.port}`;
      const seen = (counts.get(base) ?? 0) + 1;
      counts.set(base, seen);
      const reconnectInterval = Number(entry.reconnectInterval ?? entry.reconnect_interval);
      out.push({
        id: seen === 1 ? base : `${base}#${seen}`,
        type,
        scheme,
        host: parsed.host,
        port: parsed.port,
        path: parsed.path,
        address: `${parsed.host}:${parsed.port}${parsed.path}`,
        url: `${scheme}://${parsed.host}:${parsed.port}${parsed.path}`,
        selfId: targetSelfId,
        downstreamId,
        // 探针专用链路（`probe.isolation: 'link'` 时用）：上游消息**一律不投**这条，
        // `onebot_invoke` 缺省投给它。见 §19 探针隔离。
        probeOnly: variant.probeOnly,
        nickname: entry.nickname === undefined ? undefined : String(entry.nickname),
        accessToken: entry.accessToken === undefined ? undefined : String(entry.accessToken),
        enabled: entry.enabled !== false,
        // 拨号/POST 型还缺"对方账号"（上游账号没配、这条也没写）：hub 会先留着不建链，
        // 学到上游账号后自动补建。这个标记只用于状态展示与诊断。
        ...(dialsOut && targetSelfId === '' ? { pendingAccount: true } : {}),
        reconnectInterval: Number.isFinite(reconnectInterval) && reconnectInterval > 0 ? reconnectInterval : undefined,
        warning,
      });
    }
  }
  return out;
}

/**
 * 解析配置里的模型写法（m024167）：`provider/model`、或只给 `model`（provider 留空，
 * 由调用方决定用谁的 provider——聊天沿用会话现有 provider，识图交上游挑）。
 * 认不出的写法返回 null = 没配 = 跟 DSH 系统默认路由；**不猜**一个模型名出来。
 */
export function parseModelRef(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash < 0) return { provider: '', model: text };
  const provider = text.slice(0, slash).trim();
  const model = text.slice(slash + 1).trim();
  if (!model) return null;
  return { provider, model };
}
