/**
 * 官方通道的**扫码绑定**：用手机 QQ 扫一下，替用户拿回 appId / appSecret。
 *
 * 为什么要有这个：官方凭据是一长串 `appSecret`，手抄进设置页错一个字就是"连不上"，
 * 而错误只会说鉴权失败——用户没有别的线索。腾讯给的 `@tencent-connect/qqbot-connector`
 * 就是干这件事的：`startQrConnect()` 返回二维码 URL，轮询到你扫码，直接把凭据交出来。
 *
 * 三条取舍：
 *  1. **凭据存进插件自己的状态目录**（`official/credentials.json`），不写回
 *     `cordis.patch.yml`。配置文件的写入权在宿主，插件去改它有并发与格式两重风险；
 *     而这里存的只是"扫码得到的凭据"，优先级**低于**配置文件里显式写的值——
 *     用户在配置里手填了，就以他填的为准。
 *  2. **不打印到控制台**（`displayQrCodeToConsole: false`）：宿主是 GUI，控制台没人看；
 *     二维码要出现在设置页上。为此这里只把 URL 交出去，PNG 由 `qr.js` 画。
 *  3. **失败要说人话**：SDK 抛的是网络/超时/被拒那几类，原样透给用户等于没说。
 *     这里统一成一句能照着做的提示，原文留在 `detail` 里给排查的人。
 */

import { qrDataUrl } from './qr.js';

/** 凭据落盘位置（相对 `storage` 根）。 */
export const CREDS_FILE = 'official/credentials.json';

/** 二维码的剩余寿命：官方给的是几分钟，这里只用来告诉页面"什么时候该重开"。 */
const QR_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {{status:'idle'|'scanning'|'ok'|'failed'|'expired', url:string, qr:string,
 *            appId:string, note:string, detail:string, startedAt:number}} OnboardSnapshot
 */
export class Onboard {
  /**
   * @param {{storage?:{read?:Function, schedule?:Function, flush?:Function}|null,
   *          log?:Function, onBound?:(creds:{appId:string,appSecret:string})=>void,
   *          loadModule?:Function, source?:string}} [opts]
   */
  constructor({ storage = null, log = () => {}, onBound = null, loadModule = null, source = 'dsh-onebot-hub' } = {}) {
    this.storage = storage;
    this.log = log;
    this.onBound = onBound;
    this.source = source;
    this.loadModule = loadModule ?? (() => import('@tencent-connect/qqbot-connector'));
    this.#snapshot = { status: 'idle', url: '', qr: '', appId: '', note: '', detail: '', startedAt: 0 };
  }

  #stop = null;
  #snapshot;
  #creds = null;
  #loaded = false;

  /** 已绑定/已保存的凭据（扫码得来的那份）。配置文件里的值优先级更高，由调用方决定。 */
  current() {
    if (!this.#loaded) {
      this.#loaded = true;
      const raw = this.storage?.read?.(CREDS_FILE, null) ?? null;
      if (raw && raw.appId && raw.appSecret) {
        this.#creds = { appId: String(raw.appId), appSecret: String(raw.appSecret) };
      }
    }
    return this.#creds ?? {};
  }

  /** 页面要的：状态 + 二维码（PNG data URL）+ 说明。 */
  snapshot() {
    const snap = this.#snapshot;
    // 二维码过期了就别再摆着让人扫——扫出来也是"已失效"。
    if (snap.status === 'scanning' && snap.startedAt && Date.now() - snap.startedAt > QR_TTL_MS) {
      return { ...snap, status: 'expired', note: '二维码已经过期了，点「重新扫码」拿一张新的。' };
    }
    return { ...snap };
  }

  /**
   * 开始扫码。可以重复调用（会先取消上一次），页面按"按钮点两下"那种用法来做也不会叠两条轮询。
   */
  async start() {
    this.cancel();
    let mod;
    try {
      mod = await this.loadModule();
    } catch (err) {
      this.#snapshot = {
        ...this.#snapshot,
        status: 'failed',
        note: '没装扫码依赖 `@tencent-connect/qqbot-connector`，装一下再试（或者直接手填 appId / appSecret）。',
        detail: String(err?.message ?? err),
      };
      return this.snapshot();
    }
    if (typeof mod?.startQrConnect !== 'function') {
      this.#snapshot = { ...this.#snapshot, status: 'failed', note: '扫码依赖版本不对（没有 startQrConnect）。', detail: '' };
      return this.snapshot();
    }

    this.#snapshot = { status: 'scanning', url: '', qr: '', appId: '', note: '正在取二维码…', detail: '', startedAt: Date.now() };
    this.#stop = mod.startQrConnect(
      {
        onQrDisplayed: (url) => {
          const text = String(url ?? '');
          let qr = '';
          try {
            qr = qrDataUrl(text);
          } catch (err) {
            // 画不出图也别让人干等：把链接摆出来，用户可以复制到别处生成。
            this.log(`二维码画不出来：${String(err?.message ?? err)}`);
          }
          this.#snapshot = {
            ...this.#snapshot,
            status: 'scanning',
            url: text,
            qr,
            startedAt: Date.now(),
            note: qr ? '用手机 QQ 扫下面的二维码，扫完这里会自动变成已连接。' : '二维码画不出来，请复制下面的链接。',
          };
        },
        onQrExpired: () => {
          this.#snapshot = { ...this.#snapshot, status: 'scanning', note: '二维码过期了，正在换一张…' };
        },
        onSuccess: (list) => {
          const first = Array.isArray(list) ? list[0] : list;
          const appId = String(first?.appId ?? '').trim();
          const appSecret = String(first?.appSecret ?? '').trim();
          if (!appId || !appSecret) {
            this.#snapshot = { ...this.#snapshot, status: 'failed', note: '扫码成功但没拿到凭据，再扫一次。', detail: JSON.stringify(first ?? null).slice(0, 200) };
            return;
          }
          this.#save({ appId, appSecret });
          this.#snapshot = {
            ...this.#snapshot,
            status: 'ok',
            qr: '',
            appId,
            note: `已绑定应用 ${appId}。正在用这份凭据连接官方通道…`,
            detail: '',
          };
          this.log(`官方通道扫码绑定成功：appId=${appId}`);
          try {
            this.onBound?.({ appId, appSecret });
          } catch (err) {
            this.log(`绑定后重连失败：${String(err?.message ?? err)}`);
          }
        },
        onFailure: (err) => {
          this.#snapshot = {
            ...this.#snapshot,
            status: 'failed',
            note: '扫码失败或已取消。可以让它重来一次，或者直接手填 appId / appSecret。',
            detail: String(err?.message ?? err ?? '').slice(0, 300),
          };
        },
      },
      { displayQrCodeToConsole: false, source: this.source },
    );
    return this.snapshot();
  }

  /** 取消（页面关掉、用户点了取消、或者又点了一次开始）。重复调用安全。 */
  cancel() {
    const stop = this.#stop;
    this.#stop = null;
    if (typeof stop !== 'function') return;
    try {
      stop();
    } catch {
      /* 已经停了就别再抛 */
    }
    if (this.#snapshot.status === 'scanning') {
      this.#snapshot = { ...this.#snapshot, status: 'idle', qr: '', url: '', note: '已取消扫码。' };
    }
  }

  /** 清掉已保存的凭据（重新扫码前用；配置文件里的手填值不受影响）。 */
  forget() {
    this.#creds = null;
    this.#loaded = true;
    this.storage?.schedule?.(CREDS_FILE, () => ({ appId: '', appSecret: '' }));
    this.storage?.flush?.();
    this.#snapshot = { ...this.#snapshot, status: 'idle', appId: '', qr: '', note: '已清除扫码保存的凭据。' };
  }

  #save({ appId, appSecret }) {
    this.#creds = { appId, appSecret };
    this.#loaded = true;
    this.storage?.schedule?.(CREDS_FILE, () => ({ appId, appSecret }));
    this.storage?.flush?.();
  }
}
