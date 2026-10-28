/**
 * 设置页的**扫码绑定通道**（宿主侧）。
 *
 * 形状照 `lib/persona/route.js`：`webServer.register({kind:'exact', path, handler})` +
 * 页面 `fetch`。不开在客户端是因为客户端拿不到 `storage` 与官方 SDK（cordis：没 declare 就读不到）。
 *
 * 接口：
 *  · `GET`            → `{ok, status, url, qr, appId, note, detail}`
 *  · `POST {op:'start'}`  → 同上（`qr` 是 `data:image/png;base64,…`）
 *  · `POST {op:'cancel'}` → 同上
 *  · `POST {op:'forget'}` → 清掉扫码存的凭据
 *
 * 为什么把 PNG 塞进 JSON：页面只有一个 `<img src>` 的位置，多开一个 `/qr.png` 端点等于
 * 让二维码和状态分两次请求、还可能拿到不同轮次的那张（扫了旧码会提示过期）。
 */

export const OFFICIAL_QR_PATH = '/onebot-hub/official/qr';

const MAX_BODY_BYTES = 8 * 1024;

const clip = (value, n = 200) => String(value ?? '').slice(0, n);

function readBody(req) {
  return new Promise((resolve, reject) => {
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
}

/** @param {() => (import('./onboard.js').Onboard | null)} getOnboard */
export function createOfficialQrHandler(getOnboard, { log = () => {} } = {}) {
  return async function handle(req, res) {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const onboard = getOnboard();
    if (!onboard) {
      send(200, { ok: false, status: 'idle', qr: '', url: '', appId: '', note: '上游类型不是「官方接口」，先在设置页「基础」里选它。', detail: '' });
      return;
    }
    try {
      if ((req.method ?? 'GET').toUpperCase() === 'GET') {
        send(200, { ok: true, ...onboard.snapshot() });
        return;
      }
      const body = await readBody(req);
      const op = String(body?.op ?? 'status');
      if (op === 'start') {
        const snap = await onboard.start();
        send(200, { ok: snap.status !== 'failed', ...snap });
        return;
      }
      if (op === 'cancel') {
        onboard.cancel();
        send(200, { ok: true, ...onboard.snapshot() });
        return;
      }
      if (op === 'forget') {
        onboard.forget();
        send(200, { ok: true, ...onboard.snapshot() });
        return;
      }
      send(200, { ok: true, ...onboard.snapshot() });
    } catch (err) {
      const note = clip(err?.message ?? err);
      log(`扫码通道出错：${note}`);
      send(500, { ok: false, status: 'failed', qr: '', url: '', appId: '', note, detail: '' });
    }
  };
}

export function installOfficialQrRoute(ctx, { getOnboard = () => null, log = () => {} } = {}) {
  const out = { available: false, path: OFFICIAL_QR_PATH, note: '' };
  const webServer = (ctx && ctx.webServer) || (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer) {
    out.note = '宿主没有 webServer 服务：设置页的扫码连接不可用';
    return out;
  }
  if (typeof webServer.register !== 'function') {
    out.note = 'webServer 没有 register（版本不符）：设置页的扫码连接不可用';
    return out;
  }
  try {
    out.dispose = webServer.register({ kind: 'exact', path: OFFICIAL_QR_PATH, handler: createOfficialQrHandler(getOnboard, { log }) });
    out.available = true;
    log(`设置页扫码通道已装：${OFFICIAL_QR_PATH}`);
  } catch (err) {
    out.note = clip(err?.message ?? err);
  }
  return out;
}
