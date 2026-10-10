/**
 * 生图模块（lib/vision/imagegen.js）离线测试：尺寸归一 + 请求/响应/超时/计数。
 * 全部走假 fetchImpl，不联网、不落盘、不依赖 DSH，可直接 `node test/imagegen.mjs`。
 */
import assert from 'node:assert/strict';
import { ImageGen, normalizeSize, parseSize } from '../lib/vision/imagegen.js';

let passed = 0;
const cases = [];
/** 异步用例挂在这里，末尾统一 await。 */
const pending = [];
function t(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => {
            passed += 1;
            cases.push({ name, ok: true });
          },
          (err) => cases.push({ name, ok: false, error: String(err?.message ?? err) }),
        ),
      );
      return;
    }
    passed += 1;
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const area = (s) => s.width * s.height;
const even = (s) => s.width % 2 === 0 && s.height % 2 === 0;
/** 长宽比相对误差，用来断言"比例没被压扁"。 */
const ratioError = (s, expected) => Math.abs(s.width / s.height - expected) / expected;
const show = (s) => `${s.width}x${s.height}(${s.basis})`;

/** 假 JSON 响应。 */
function jsonResponse(payload, { status = 200, type = 'application/json' } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** 假二进制响应（url 分支的第二次 GET）。 */
function binaryResponse(bytes, { status = 200, type = 'image/jpeg' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  };
}

/** 造一个配置齐全的 ImageGen，并给出记录调用的数组。 */
function makeGen(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] });
  };
  const gen = new ImageGen({
    enabled: true,
    model: 'seedream',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    fetchImpl,
    ...overrides,
  });
  return { gen, calls };
}

// ---- parseSize ----

t('parseSize：x/X/* 与空格都认，非法与零返回 null', () => {
  assert.deepEqual(parseSize('1024x1024'), { width: 1024, height: 1024 });
  assert.deepEqual(parseSize(' 768 * 1024 '), { width: 768, height: 1024 });
  assert.deepEqual(parseSize('1024X1024'), { width: 1024, height: 1024 });
  assert.equal(parseSize(''), null);
  assert.equal(parseSize('square'), null);
  assert.equal(parseSize('16:9'), null);
  assert.equal(parseSize('0x100'), null);
  assert.equal(parseSize('1024x'), null);
  assert.equal(parseSize(null), null);
});

// ---- normalizeSize ----

t('normalizeSize：768x1024 在 maxSize 1024x1024 下保比例且不超面积', () => {
  const s = normalizeSize('768x1024', { maxSize: '1024x1024' });
  assert.equal(s.width, 768, show(s));
  assert.equal(s.height, 1024, show(s));
  assert.ok(ratioError(s, 3 / 4) < 0.02, `比例偏差 ${ratioError(s, 3 / 4)}`);
  assert.ok(area(s) <= 1024 * 1024, `面积超标 ${area(s)}`);
  assert.ok(even(s), `出现奇数边长 ${show(s)}`);
});

t('normalizeSize：square 出正方形', () => {
  const s = normalizeSize('square', { maxSize: '1024x1024' });
  assert.equal(s.width, s.height, show(s));
  assert.ok(even(s), show(s));
  assert.ok(area(s) <= 1024 * 1024, show(s));
});

t('normalizeSize：竖版/横版/16:9 的比例误差 < 2%', () => {
  const portrait = normalizeSize('竖版', { maxSize: '1024x1024' });
  assert.ok(ratioError(portrait, 3 / 4) < 0.02, `竖版 ${show(portrait)}`);
  const wide = normalizeSize('16:9', { maxSize: '1024x1024' });
  assert.ok(ratioError(wide, 16 / 9) < 0.02, `16:9 ${show(wide)}`);
  const landscape = normalizeSize('横版', { maxSize: '1024x1024' });
  assert.ok(ratioError(landscape, 4 / 3) < 0.02, `横版 ${show(landscape)}`);
  assert.ok(even(portrait) && even(wide) && even(landscape), `${show(portrait)} ${show(wide)} ${show(landscape)}`);
});

t('normalizeSize：minSize 1920x1920 把 512x512 按面积放大，宽高仍为偶数', () => {
  const s = normalizeSize('512x512', { maxSize: '4096x4096', minSize: '1920x1920' });
  assert.ok(area(s) >= 1920 * 1920, `面积没达标 ${area(s)}`);
  assert.ok(even(s), show(s));
  assert.equal(s.width, s.height, `1:1 应保持 ${show(s)}`);
  assert.equal(s.basis, 'min-area');
});

t('normalizeSize：各种 spec 全偶数、单边与面积都不超 maxSize 框', () => {
  const specs = ['square', '方形', '竖版', 'portrait', '横版', '16:9', '9:16', '768x1024', '1024*1024', '2048x1024', '', '看不懂的写法'];
  for (const spec of specs) {
    const s = normalizeSize(spec, { maxSize: '1024x1024' });
    assert.ok(Number.isInteger(s.width) && Number.isInteger(s.height), `${spec} 非整数 ${show(s)}`);
    assert.ok(even(s), `${spec} 出现奇数边长 ${show(s)}`);
    assert.ok(s.width <= 1024 && s.height <= 1024, `${spec} 单边超出 maxSize ${show(s)}`);
    assert.ok(area(s) <= 1024 * 1024, `${spec} 面积超预算 ${show(s)}`);
    assert.ok(s.width >= 2 && s.height >= 2, `${spec} 边长过小 ${show(s)}`);
    assert.ok(typeof s.basis === 'string' && s.basis.length > 0, `${spec} 缺 basis`);
  }
});

t('normalizeSize：空 spec 走确定默认 1024x1024，且受 maxSize 约束', () => {
  const s = normalizeSize('', { maxSize: '1024x1024' });
  assert.equal(s.basis, 'default');
  assert.equal(s.width, 1024);
  assert.equal(s.height, 1024);

  const small = normalizeSize('', { maxSize: '512x512' });
  assert.ok(area(small) <= 512 * 512, show(small));
  assert.ok(even(small), show(small));
});

t('normalizeSize：maxSize/minSize 为空串等于没有约束', () => {
  const s = normalizeSize('512x512', { maxSize: '', minSize: '' });
  assert.equal(s.width, 512);
  assert.equal(s.height, 512);
  const big = normalizeSize('4096x4096', { maxSize: '', minSize: '' });
  assert.deepEqual({ width: big.width, height: big.height }, { width: 4096, height: 4096 });
  assert.ok(even(big));
});

// ---- ImageGen.generate ----

t('generate：b64_json 分支的 method/URL/头/body 与字节', async () => {
  const { gen, calls } = makeGen();
  const out = await gen.generate({ prompt: '一只猫', size: 'square' });

  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(out.error, null);
  assert.deepEqual(out.size, { width: 1024, height: 1024 });
  assert.ok(out.bytes.equals(SIGNATURE), '拿回的字节应与上游一致');
  assert.equal(out.mediaType, 'image/png');
  assert.equal(out.url, null);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, 'https://api.example.com/v1/images/generations');
  assert.equal(call.init.headers.authorization, 'Bearer sk-secret');
  assert.match(String(call.init.headers['content-type']), /application\/json/);

  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'seedream');
  assert.equal(body.prompt, '一只猫');
  assert.equal(body.size, '1024x1024');
  assert.equal(body.n, 1);
  assert.equal(body.response_format, 'b64_json');
  assert.equal('watermark' in body, false, 'watermark 不是官方参数，默认不发送');
  assert.equal('image' in body, false, '没给参考图就不该有 image 键');
  assert.ok(!call.init.body.includes('sk-secret'), '请求体里绝不能出现 apiKey');

  assert.equal(gen.stats.requests, 1);
  assert.equal(gen.stats.ok, 1);
  assert.equal(gen.stats.failed, 0);
});

t('generate：watermark 显式开启才透传；size 对齐官方 16 步进', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] });
  };
  const base = { enabled: true, model: 'm', baseUrl: 'https://api.example.com', apiKey: 'k', fetchImpl };
  const plain = await new ImageGen(base).generate({ prompt: 'x', size: '3:2' });
  assert.equal(plain.ok, true, plain.error ?? '');
  assert.equal('watermark' in bodies[0], false, '默认不发 watermark');
  {
    const [w, h] = bodies[0].size.split('x').map(Number);
    assert.equal(w % 16, 0, `宽 ${w} 应是 16 的倍数（官方 gpt-image-2 规则）`);
    assert.equal(h % 16, 0, `高 ${h} 应是 16 的倍数（官方 gpt-image-2 规则）`);
    assert.ok(Math.abs(w / h - 3 / 2) / (3 / 2) < 0.02, `3:2 比例偏差过大 ${w}x${h}`);
    assert.ok(w <= 1024 && h <= 1024, `超 maxSize 框 ${w}x${h}`);
  }
  const marked = await new ImageGen({ ...base, watermark: true }).generate({ prompt: 'x' });
  assert.equal(marked.ok, true, marked.error ?? '');
  assert.equal(bodies[1].watermark, true, '显式开启才带 watermark');
});

t('generate：b64_json 带 data: 前缀也能剥掉', async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: `data:image/webp;base64,${bytes.toString('base64')}` }] }),
  });
  const out = await gen.generate({ prompt: 'x' });
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(out.mediaType, 'image/webp');
  assert.ok(out.bytes.equals(bytes));
});

t('generate：参考图 → body.image 是 dataUri；没有参考图就没有该键', async () => {
  const seen = [];
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return jsonResponse({ data: [{ b64_json: Buffer.from([9]).toString('base64') }] });
    },
  });

  await gen.generate({ prompt: 'a', reference: { bytes: Buffer.from([1, 2, 3]), mediaType: 'image/png' } });
  assert.ok(Array.isArray(seen[0].image), '有参考图时 image 应是数组');
  assert.equal(seen[0].image.length, 1);
  assert.match(seen[0].image[0], /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

  await gen.generate({ prompt: 'b' });
  assert.equal('image' in seen[1], false);
});

t('generate：参考图给了字符串（URL/路径）→ 明确失败，绝不静默退化成文生图', async () => {
  const seen = [];
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return jsonResponse({ data: [{ b64_json: Buffer.from([9]).toString('base64') }] });
    },
  });

  // 真机事故：工具把参数原样透传，老代码 `if (reference && reference.bytes)` 直接跳过 →
  // 请求照发、用户拿到一张"和参考图没关系"的图，还以为是模型不听话。
  const out = await gen.generate({ prompt: 'a', reference: 'C:\\tmp\\ref.jpg' });
  assert.equal(out.ok, false);
  assert.match(out.error, /参考图要传字节/);
  assert.equal(seen.length, 0, '参考图用不了就不该发请求');

  const empty = await gen.generate({ prompt: 'a', reference: { mediaType: 'image/png' } });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有 bytes 的对象/);
  assert.equal(seen.length, 0);
});

t('generate：url 分支会再 GET 一次并采用 content-type', async () => {
  const bytes = Buffer.from([7, 7, 7, 7]);
  const calls = [];
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') return jsonResponse({ data: [{ url: 'https://cdn.example.com/a.jpg' }] });
      return binaryResponse(bytes, { type: 'image/jpeg; charset=utf-8' });
    },
  });

  const out = await gen.generate({ prompt: 'x' });
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(calls.length, 2, 'url 分支必须再发一次 GET');
  assert.equal(calls[1].url, 'https://cdn.example.com/a.jpg');
  assert.equal(calls[1].init.method, 'GET');
  assert.ok(out.bytes.equals(bytes));
  assert.equal(out.mediaType, 'image/jpeg');
  assert.equal(out.url, 'https://cdn.example.com/a.jpg');
});

t('generate：上游 400 → ok:false、error 非空、不抛', async () => {
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async () => jsonResponse('{"error":"bad prompt"}', { status: 400 }),
  });
  let out = null;
  await assert.doesNotReject(async () => {
    out = await gen.generate({ prompt: 'x' });
  });
  assert.equal(out.ok, false);
  assert.ok(out.error, '错误信息不能为空');
  assert.match(out.error, /400/);
  assert.equal(out.bytes, null);
  assert.equal(gen.stats.failed, 1);
  assert.ok(gen.stats.lastError);
});

t('generate：没有 data[0] 时给中文错误并捎上上游片段', async () => {
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async () => jsonResponse({ error: '模型不存在' }),
  });
  const out = await gen.generate({ prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /data\[0\]/);
  assert.match(out.error, /模型不存在/);
});

t('generate：超时（fetch 永不 resolve）→ ok:false 且 error 含超时', async () => {
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  const out = await gen.generate({ prompt: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.error, /超时/);
  assert.equal(gen.stats.failed, 1);
});

t('generate：enabled:false 或缺 baseUrl 直接返回失败且一次请求都不发', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] });
  };

  const off = new ImageGen({ enabled: false, model: 'm', baseUrl: 'https://api.example.com', apiKey: 'k', fetchImpl });
  assert.equal(off.configured, true);
  assert.equal(off.enabled, false);
  const offOut = await off.generate({ prompt: 'x' });
  assert.equal(offOut.ok, false);
  assert.ok(offOut.error);

  const noBase = new ImageGen({ enabled: true, model: 'm', baseUrl: '', apiKey: 'k', fetchImpl });
  assert.equal(noBase.configured, false);
  assert.equal(noBase.enabled, false);
  const noBaseOut = await noBase.generate({ prompt: 'x' });
  assert.equal(noBaseOut.ok, false);
  assert.ok(noBaseOut.error);

  assert.equal(calls, 0, '未配置/未启用时一次网络都不该发');
  assert.equal(off.stats.requests, 0);
  assert.equal(noBase.stats.requests, 0);
});

t('generate：attach/detach 能换 fetch，detach 回落到构造函数给的那个', async () => {
  let baseCalls = 0;
  const base = async () => {
    baseCalls += 1;
    return jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] });
  };
  const gen = new ImageGen({ enabled: true, model: 'm', baseUrl: 'https://api.example.com', apiKey: 'k', fetchImpl: base });

  let injected = 0;
  gen.attach({
    fetchImpl: async () => {
      injected += 1;
      return jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] });
    },
  });
  assert.equal((await gen.generate({ prompt: 'x' })).ok, true);
  assert.equal(injected, 1);
  assert.equal(baseCalls, 0);

  gen.detach();
  assert.equal((await gen.generate({ prompt: 'x' })).ok, true);
  assert.equal(baseCalls, 1);
});

t('stats：baseUrl 只留 host 不含密钥，requests/ok/failed 计数正确', async () => {
  let n = 0;
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com/v1?token=sk-secret',
    apiKey: 'sk-secret',
    now: () => 777,
    fetchImpl: async () => {
      n += 1;
      return n === 1
        ? jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] })
        : jsonResponse('boom', { status: 500 });
    },
  });

  const first = await gen.generate({ prompt: 'a', size: 'square' });
  const second = await gen.generate({ prompt: 'b', size: 'square' });
  const stats = gen.stats;

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(stats.requests, 2);
  assert.equal(stats.ok, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.baseUrl, 'api.example.com');
  assert.ok(!stats.baseUrl.includes('sk-secret'));
  assert.ok(!stats.baseUrl.includes('/v1'));
  assert.ok(!JSON.stringify(stats).includes('sk-secret'), 'stats 里绝不能出现密钥');
  assert.equal(stats.lastAt, 777);
  assert.deepEqual(stats.lastSize, { width: 1024, height: 1024 });
  assert.equal(stats.model, 'm');
  assert.match(stats.lastError, /500/);
});

t('generate：错误信息会把回显里的 apiKey 抹成 ***', async () => {
  const gen = new ImageGen({
    enabled: true,
    model: 'm',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-secret',
    fetchImpl: async () => jsonResponse(`{"error":"key sk-secret rejected"}`, { status: 401 }),
  });
  const out = await gen.generate({ prompt: 'x' });
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('sk-secret'), `错误里泄漏了密钥：${out.error}`);
  assert.match(out.error, /\*\*\*/);
});

t('generate：裸 b64_json 的魔数决定 mediaType，不再一律当 image/png', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x11)]);
  const base = { enabled: true, model: 'm', baseUrl: 'https://api.example.com', apiKey: 'k' };
  // 豆包 Seedream 实测形态：裸 base64 的 JPEG 字节，之前被兜底成 image/png，
  // 登记宿主 attachments 时被字节嗅探拒绝（"Declared image type does not match its bytes."）。
  const raw = await new ImageGen({
    ...base,
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: jpeg.toString('base64') }] }),
  }).generate({ prompt: 'x' });
  assert.equal(raw.ok, true, raw.error ?? '');
  assert.equal(raw.mediaType, 'image/jpeg', '裸 base64 的 JPEG 字节不该被标成 image/png');
  // data: 前缀谎报 png、字节是 jpeg：魔数赢过声明
  const lied = await new ImageGen({
    ...base,
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: `data:image/png;base64,${jpeg.toString('base64')}` }] }),
  }).generate({ prompt: 'x' });
  assert.equal(lied.ok, true, lied.error ?? '');
  assert.equal(lied.mediaType, 'image/jpeg', '魔数优先于 data: 前缀的声明');
  // 真 PNG 不受影响
  const png = await new ImageGen({
    ...base,
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: SIGNATURE.toString('base64') }] }),
  }).generate({ prompt: 'x' });
  assert.equal(png.ok, true, png.error ?? '');
  assert.equal(png.mediaType, 'image/png');
});

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
