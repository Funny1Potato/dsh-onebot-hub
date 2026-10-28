/**
 * 官方通道的**扫码绑定**与二维码渲染（`node test/official-qr.mjs`）。
 *
 * 为什么要单独测这两块：
 *  - `qr.js` 是手写的 PNG 编码器。它出错的表现是"图裂了"或"扫不出来"，而这两件事在
 *    服务端都不会抛异常——只有人拿手机试才知道。所以至少要钉住 PNG 结构（签名、IHDR 的
 *    宽高与颜色类型、IEND）和"同样的输入出同样的字节"。
 *  - `onboard.js` 的每一步都是外部回调（扫码库回调我们）。回调顺序写错的表现是
 *    "二维码显示了但永远不变成已连接"，用户只能重启。所以把回调序列逐帧演一遍。
 */

import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { qrDataUrl, qrPng } from '../lib/official/qr.js';
import { CREDS_FILE, Onboard } from '../lib/official/onboard.js';

let passed = 0;
const cases = [];
const pending = [];
function t(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => {
            passed += 1;
          },
          (err) => {
            cases.push({ name, ok: false, error: String(err?.stack ?? err) });
          },
        ),
      );
      return;
    }
    passed += 1;
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.stack ?? err) });
  }
}

/** 读出 PNG 的 chunk 名列表（只认结构，不解像素）。 */
function chunks(buf) {
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    out.push({ type, len, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

// ---- 二维码 PNG ----------------------------------------------------------------

t('qrPng：签名 / IHDR / IDAT / IEND 齐全，宽高 =（模块数 + 静区×2）× scale', () => {
  const png = qrPng('https://q.qq.com/x', { scale: 4, margin: 2 });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const parts = chunks(png);
  assert.deepEqual(parts.map((p) => p.type), ['IHDR', 'IDAT', 'IEND']);
  const [ihdr, idat] = parts;
  assert.equal(ihdr.data.readUInt32BE(0), ihdr.data.readUInt32BE(4), '应该是正方形');
  assert.equal(ihdr.data[8], 8, '位深 8');
  assert.equal(ihdr.data[9], 0, '颜色类型：灰度');
  assert.equal(ihdr.data[12], 0, '不隔行');
  const side = ihdr.data.readUInt32BE(0);
  assert.equal(side % 4, 0);
  // 静区 ≥ 4 格才符合规范（这里给 2，只证明参数被吃进去了）。
  assert.ok(side >= (21 + 2 * 2) * 4, `边长太小：${side}`);
  // IDAT 解出来是 side 行、每行 side+1 字节（首字节是 filter type）。
  const raw = zlib.inflateSync(idat.data);
  assert.equal(raw.length, (side + 1) * side);
  assert.equal(raw[0], 0);
});

t('qrPng：同样内容出同样字节；内容不同字节不同；`qrDataUrl` 前缀对', () => {
  const a = qrPng('hello');
  const b = qrPng('hello');
  const c = qrPng('world');
  assert.ok(a.equals(b), '同输入应逐字节相同');
  assert.ok(!a.equals(c), '不同内容不该是同一张图');
  assert.ok(qrDataUrl('hello').startsWith('data:image/png;base64,'));
});

// ---- 扫码绑定 ------------------------------------------------------------------

/** 假存储：记下最后一次 schedule 的文件名与内容。 */
function fakeStorage(initial = null) {
  const writes = [];
  return {
    writes,
    storage: {
      enabled: true,
      read: (file, dflt) => (file === CREDS_FILE ? initial ?? dflt : dflt),
      schedule: (file, fn) => writes.push({ file, value: fn() }),
      flush: () => writes.length,
    },
  };
}

/** 假扫码库：把回调收起来，测试里手动按顺序触发。 */
function fakeModule() {
  const calls = [];
  return {
    calls,
    module: {
      startQrConnect(callbacks, options) {
        calls.push({ callbacks, options });
        return () => calls.push({ stopped: true });
      },
    },
  };
}

t('onboard：start → 出二维码 → 扫码成功 → 存凭据 + 回调重连', async () => {
  const { storage, writes } = fakeStorage();
  const mod = fakeModule();
  const bound = [];
  const ob = new Onboard({ storage, loadModule: async () => mod.module, onBound: (c) => bound.push(c) });

  const first = await ob.start();
  assert.equal(first.status, 'scanning');
  assert.equal(mod.calls[0].options.displayQrCodeToConsole, false, 'GUI 里不该往控制台打');
  assert.equal(mod.calls[0].options.source, 'dsh-onebot-hub');

  mod.calls[0].callbacks.onQrDisplayed('https://q.qq.com/scan?k=1');
  const shown = ob.snapshot();
  assert.equal(shown.status, 'scanning');
  assert.match(shown.qr, /^data:image\/png;base64,/);
  assert.equal(shown.url, 'https://q.qq.com/scan?k=1');

  mod.calls[0].callbacks.onSuccess([{ appId: '10086', appSecret: 'sec-1' }]);
  const done = ob.snapshot();
  assert.equal(done.status, 'ok');
  assert.equal(done.appId, '10086');
  // 存盘：文件路径与内容都对，别写到别处去。
  const wrote = writes.at(-1);
  assert.equal(wrote.file, CREDS_FILE);
  assert.deepEqual(wrote.value, { appId: '10086', appSecret: 'sec-1' });
  // 绑定后要通知外层重连（否则用户得重启才生效）。
  assert.deepEqual(bound, [{ appId: '10086', appSecret: 'sec-1' }]);
});

t('onboard：失败要说人话并留原文；取消回到 idle；重复 start 不叠轮询', async () => {
  const { storage } = fakeStorage();
  const mod = fakeModule();
  const ob = new Onboard({ storage, loadModule: async () => mod.module });

  await ob.start();
  mod.calls[0].callbacks.onFailure(new Error('network down'));
  const bad = ob.snapshot();
  assert.equal(bad.status, 'failed');
  assert.match(bad.note, /扫码失败/);
  assert.match(bad.detail, /network down/);

  // 再点一次：应该先停掉上一次，只留一条轮询。
  await ob.start();
  await ob.start();
  assert.equal(mod.calls.filter((c) => c.stopped).length, 2, '每次重开都要把上一次停掉');
  ob.cancel();
  assert.equal(ob.snapshot().status, 'idle');
  assert.equal(ob.snapshot().qr, '');
});

t('onboard：二维码放太久就报过期，不让人对着废码扫', async () => {
  const { storage } = fakeStorage();
  const mod = fakeModule();
  const ob = new Onboard({ storage, loadModule: async () => mod.module });
  await ob.start();
  mod.calls[0].callbacks.onQrDisplayed('https://q.qq.com/scan?k=2');
  assert.equal(ob.snapshot().status, 'scanning');
  // 把开始时间往前拨 6 分钟。
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60 * 1000;
    assert.equal(ob.snapshot().status, 'expired');
    assert.match(ob.snapshot().note, /过期/);
  } finally {
    Date.now = realNow;
  }
});

t('onboard：没装扫码依赖 / 版本不对都不抛，只把原因写进 note', async () => {
  const { storage } = fakeStorage();
  const missing = new Onboard({ storage, loadModule: async () => { throw new Error('Cannot find module'); } });
  const res = await missing.start();
  assert.equal(res.status, 'failed');
  assert.match(res.note, /qqbot-connector/);

  const wrong = new Onboard({ storage, loadModule: async () => ({}) });
  const res2 = await wrong.start();
  assert.equal(res2.status, 'failed');
  assert.match(res2.note, /startQrConnect/);
});

t('onboard：current() 读出已存的凭据；forget() 清掉', async () => {
  const { storage, writes } = fakeStorage({ appId: '777', appSecret: 'sec-7' });
  const ob = new Onboard({ storage });
  assert.deepEqual(ob.current(), { appId: '777', appSecret: 'sec-7' });
  ob.forget();
  assert.deepEqual(ob.current(), {});
  assert.deepEqual(writes.at(-1).value, { appId: '', appSecret: '' });
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
