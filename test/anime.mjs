/**
 * 角色识别（`lib/vision/anime.js`）纯逻辑测试。
 *
 * 全部网络调用用假 `fetchImpl` 顶掉——**不联网**，也不依赖任何宿主包。
 * 可直接 `node test/anime.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../lib/storage.js';
import {
  ANIME_BACKENDS,
  NOT_FOUND_TEXT,
  NSFW_PLACEHOLDER,
  AnimeRecognizer,
  normalizeBackend,
} from '../lib/vision/anime.js';

let passed = 0;
const cases = [];
/** 异步用例挂这里，末尾统一 await。 */
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

const IMG = Buffer.from('fake-anime-image-bytes');
const IMG2 = Buffer.from('another-anime-image-bytes');

/** 造一个 fetch 响应桩（只要 status/ok/text 三个成员）。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

/**
 * 造一个记录调用的假 fetch。`handler(call, index)` 返回响应桩；
 * 返回字符串 `'hang'` 表示"永不 resolve"（测超时用）。
 */
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? 'GET').toUpperCase(),
      headers: init.headers ?? {},
      body: init.body ?? null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    const out = await handler(call, calls.length - 1);
    if (out === 'hang') return new Promise(() => {});
    return out;
  };
  impl.calls = calls;
  return impl;
}

const headerOf = (call, name) => {
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(call.headers ?? {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
};

const bodyText = (call) => (Buffer.isBuffer(call.body) ? call.body.toString('utf8') : String(call.body ?? ''));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-anime-'));

// ---- 归一 ----

t('normalizeBackend：别名、大小写与未知值', () => {
  assert.deepEqual(ANIME_BACKENDS, ['off', 'anime-recognize', 'animetrace', 'both']);
  assert.equal(normalizeBackend('off'), 'off');
  assert.equal(normalizeBackend('none'), 'off');
  assert.equal(normalizeBackend('LOCAL'), 'anime-recognize');
  assert.equal(normalizeBackend('anime_trace'), 'animetrace');
  assert.equal(normalizeBackend('BOTH'), 'both');
  assert.equal(normalizeBackend('nonsense'), 'off');
  assert.equal(normalizeBackend('', 'anime-recognize'), 'anime-recognize');
  assert.equal(normalizeBackend(null, 'both'), 'both');
});

// ---- off ----

t('backend=off：不发任何请求，返回空 text', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse({}));
  const az = new AnimeRecognizer({ backend: 'off', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.text, '');
  assert.equal(r.source, null);
  assert.equal(r.cached, false);
  assert.equal(r.error, null);
  assert.equal(az.enabled, false);
  assert.equal(az.stats.attempts, 1);
  assert.equal(az.stats.failed, 0);
});

// ---- 本地后端 ----

t('本地后端：POST 路径/Bearer/body 正确，阈值过滤，渲染带百分号', async () => {
  const fetchImpl = makeFetch(async () =>
    jsonResponse({
      characters: [
        { name: 'hu_tao_(genshin_impact)', confidence: 0.9 },
        { name: 'cirno', confidence: 0.4 },
      ],
      rating: { nsfw: 0.12 },
      people_count: 1,
    }),
  );
  const az = new AnimeRecognizer({
    backend: 'anime-recognize',
    recognizeUrl: 'http://127.0.0.1:8899/',
    recognizeToken: 'tok',
    fetchImpl,
  });
  const r = await az.recognize({ bytes: IMG });

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:8899/recognize');
  assert.equal(call.method, 'POST');
  assert.equal(headerOf(call, 'authorization'), 'Bearer tok');
  assert.equal(headerOf(call, 'content-type'), 'application/json');
  assert.deepEqual(JSON.parse(bodyText(call)), { image: IMG.toString('base64') });

  assert.equal(r.text, '[角色识别: hu_tao_(genshin_impact) 90.0%]');
  assert.equal(r.source, 'anime-recognize');
  assert.equal(r.nsfw, false);
  assert.equal(r.cached, false);
  assert.equal(r.error, null);
  assert.deepEqual(r.characters, [{ name: 'hu_tao_(genshin_impact)', work: null, confidence: 0.9 }]);
  assert.equal(az.stats.misses, 1);
  assert.equal(az.stats.failed, 0);
});

t('本地后端：NSFW 0.9 超过阈值 0.5 → 渲染含 NSFW 且不写名字', async () => {
  const fetchImpl = makeFetch(async () =>
    jsonResponse({ characters: [{ name: 'some_lewd_char', confidence: 0.93 }], rating: { nsfw: 0.9 } }),
  );
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, NSFW_PLACEHOLDER);
  assert.ok(r.text.includes('NSFW'));
  assert.equal(r.nsfw, true);
  assert.ok(!r.text.includes('some_lewd_char'));
});

t('本地后端：rating 字符串 sfw、缺 confidence 的角色保留（渲染无百分号）、空名字不丢但也不占位', async () => {
  const fetchImpl = makeFetch(async () =>
    jsonResponse({ characters: [{ name: 'rumia' }, { name: '   ' }], rating: 'sfw' }),
  );
  // 显式 maxCharacters:3：本例测的是"空名字条目不丢"，默认只显示 top-1（m30282）会让断言落空
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl, maxCharacters: 3 });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '[角色识别: rumia]');
  assert.ok(!r.text.includes('%'));
  assert.equal(r.nsfw, false);
  // 空名字的条目照样留在 characters 里（"没名字"不等于"服务没返回她"）
  assert.equal(r.characters.length, 2);
  assert.equal(r.characters[1].name, '');
});

t('本地后端 HTTP 500：不抛、text 空、error 非空、failed 计数', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse('boom', 500));
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '');
  assert.equal(r.source, null);
  assert.ok(r.error, '应有 error');
  assert.match(r.error, /500/);
  assert.ok(az.stats.failed >= 1);
  assert.equal(az.stats.lastError, r.error);
  assert.equal(typeof az.stats.lastAt, 'number');
});

t('本地后端超时：fake fetch 永不 resolve 也能按 timeoutMs 中止', async () => {
  const fetchImpl = makeFetch(async () => 'hang');
  const az = new AnimeRecognizer({
    backend: 'anime-recognize',
    recognizeUrl: 'http://local.test',
    fetchImpl,
    timeoutMs: 30,
  });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(r.text, '');
  assert.match(String(r.error), /超时/);
  assert.ok(az.stats.failed >= 1);
});

t('本地后端答了但没认出：渲染空串（置信度低的不显示结果，m30282），与故障区分', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse({ characters: [], rating: 'sfw', people_count: 0 }));
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '', '没认出就什么都不说，不再渲染"未能识别"');
  assert.equal(r.error, null);
  assert.equal(r.source, null);
  assert.equal(r.characters.length, 0);
  assert.notEqual(r.text, NOT_FOUND_TEXT);
});

// ---- AnimeTrace ----

t('AnimeTrace：先 GET 模型列表，再 POST multipart 搜图（四个字段齐全）', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'animetrace_v3' } });
    return jsonResponse({ code: 0, data: [{ character: ['hu_tao_(genshin_impact)'] }] });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG, mediaType: 'image/png' });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, 'http://trace.test/v1/model/list');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[1].url, 'http://trace.test/v1/search');
  assert.equal(fetchImpl.calls[1].method, 'POST');

  const body = bodyText(fetchImpl.calls[1]);
  assert.ok(body.includes('name="is_multi"'), 'multipart 要带 is_multi');
  assert.ok(body.includes('name="ai_detect"'), 'multipart 要带 ai_detect');
  assert.ok(body.includes('name="model"'), 'multipart 要带 model');
  assert.ok(body.includes('name="file"'), 'multipart 要带 file');
  assert.ok(/name="is_multi"\r\n\r\n1/.test(body));
  assert.ok(/name="ai_detect"\r\n\r\n0/.test(body));
  assert.ok(body.includes('animetrace_v3'), 'model 字段要用模型列表里的名字');
  assert.ok(body.includes('image/png'));
  assert.ok(headerOf(fetchImpl.calls[1], 'content-type').startsWith('multipart/form-data; boundary='));

  assert.equal(r.text, '[角色识别: hu_tao_(genshin_impact)]');
  assert.ok(!r.text.includes('%'), 'AnimeTrace 没有置信度，不该出现百分号');
  assert.equal(r.source, 'animetrace');
  assert.equal(r.nsfw, null);
  assert.deepEqual(r.characters, [{ name: 'hu_tao_(genshin_impact)', work: null, confidence: null }]);
});

t('AnimeTrace 模型列表：`id` 才是机器名，绝不能把展示名 `name` 塞进 model 字段（真机事故：整条识别链 500）', async () => {
  // 真接口的形状（2026-10 实测）：`{id:'animetrace-yuri-4.2', name:'AnimeTrace Yuri 4.2', enabled:true, default:true}`，
  // 拿展示名去搜图，服务端回 500 + `{"code":17729,"zh_message":"未找到选择的模型"}`。
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) {
      return jsonResponse({
        code: 0,
        data: [
          { id: 'animetrace-yuri-4.2', name: 'AnimeTrace Yuri 4.2', enabled: true, default: true },
          { id: 'animetrace-aqours-3.5', name: 'AnimeTrace Aqours 3.5', enabled: false, default: false },
        ],
      });
    }
    return jsonResponse({ code: 0, data: [{ character: 'エルウェシィ', work: '妖精の物理学' }] });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  const body = bodyText(fetchImpl.calls[1]);
  assert.ok(body.includes('animetrace-yuri-4.2'), `model 字段要用 id：${body.slice(0, 300)}`);
  assert.ok(!body.includes('AnimeTrace Yuri 4.2'), '不能把展示名当模型名发出去');
  assert.equal(r.text, '[角色识别: エルウェシィ（妖精の物理学）]');
});

t('AnimeTrace：真机形状（框 + not_confident:false + character[{work,character}]）→ 名字带作品名，且作品名不截断', async () => {
  const longWork = 'この素晴らしい世界に祝福を！３　Ｂｅｙｏｎｄ　ｔｈｅ　Ｗｏｒｌｄ　スペシャルエディション';
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'animetrace-yuri-4.2' } });
    // 2026-10-07 实测形状（`box`/`box_id`/`not_confident`/`character` 里的 `{work, character}`）
    return jsonResponse({
      code: 0,
      data: [
        {
          box: [0.23, 0.2, 0.68, 0.65],
          box_id: '2b7e8a18-1f49-4b56-b9cc-2bc12526bcaf',
          not_confident: false,
          character: [{ work: longWork, character: 'めぐみん' }],
        },
      ],
    });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, `[角色识别: めぐみん（${longWork}）]`, '作品名要带上、且一个字都不截');
  assert.deepEqual(r.characters, [{ name: 'めぐみん', work: longWork, confidence: null }]);
});

t('AnimeTrace：not_confident 的框不采纳；全都拿不准就渲染空串（m30282：不显示结果）', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'm' } });
    return jsonResponse({
      code: 0,
      data: [{ box_id: 'a', not_confident: true, character: [{ work: '某作品', character: '大概是某人' }] }],
    });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '', '拿不准的名字不许写进上下文，"没认出"也不再显示');
  assert.notEqual(r.text, NOT_FOUND_TEXT);
  assert.deepEqual(r.characters, []);
  assert.equal(r.error, null, '"没认出"不是故障');
});

t('AnimeTrace：混合（一框拿不准、一框正常）只留正常那框；没有 work 时只写名字', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'm' } });
    return jsonResponse({
      code: 0,
      data: [
        { box_id: 'a', not_confident: true, character: [{ work: 'W1', character: '拿不准的' }] },
        { box_id: 'b', not_confident: false, character: [{ character: '确定的' }] },
      ],
    });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '[角色识别: 确定的]');
  assert.deepEqual(r.characters, [{ name: '确定的', work: null, confidence: null }]);
});

t('AnimeTrace 模型列表：没有 default 标记时挑 `enabled: true` 的那个', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) {
      return jsonResponse({ code: 0, data: [{ id: 'off-1', name: 'Off', enabled: false }, { id: 'on-2', name: 'On', enabled: true }] });
    }
    return jsonResponse({ code: 0, data: [{ character: 'rem' }] });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  await az.recognize({ bytes: IMG });
  assert.ok(bodyText(fetchImpl.calls[1]).includes('on-2'), '要挑启用的那个模型');
});

t('AnimeTrace 非 2xx：错误串带上后端原话（限流/模型名不对都看得出，而不是光一句 HTTP 500）', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'animetrace-yuri-4.2' } });
    return jsonResponse({ code: 17737, zh_message: '请求过于频繁，请稍后再试' }, 429);
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '', '问不到就是空串，不许渲染"未能识别"');
  assert.ok(r.error.includes('HTTP 429'), r.error);
  assert.ok(r.error.includes('请求过于频繁'), `错误串要带后端原话：${r.error}`);
  assert.equal(r.characters.length, 0);
});

t('AnimeTrace 模型列表本身报错：错误串也带后端原话', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse({ code: 17729, zh_message: '未找到选择的模型' }, 500));
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '');
  assert.ok(r.error.includes('模型列表 HTTP 500'), r.error);
  assert.ok(r.error.includes('未找到选择的模型'), `错误串要带后端原话：${r.error}`);
});

t('AnimeTrace 业务码 17703：重查模型列表后重试成功', async () => {
  let modelRound = 0;
  let searchRound = 0;
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) {
      modelRound += 1;
      return jsonResponse({ code: 0, data: [{ name: modelRound === 1 ? 'model_v3' : 'model_v4', default: true }] });
    }
    searchRound += 1;
    if (searchRound === 1) return jsonResponse({ code: 17703, message: 'model expired' });
    return jsonResponse({ code: 0, data: [{ name: 'rem' }] });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG2 });

  assert.deepEqual(
    fetchImpl.calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET http://trace.test/v1/model/list',
      'POST http://trace.test/v1/search',
      'GET http://trace.test/v1/model/list',
      'POST http://trace.test/v1/search',
    ],
  );
  assert.ok(bodyText(fetchImpl.calls[1]).includes('model_v3'));
  assert.ok(bodyText(fetchImpl.calls[3]).includes('model_v4'), '重试要用新模型名');
  assert.equal(r.text, '[角色识别: rem]');
  assert.equal(r.source, 'animetrace');
  assert.equal(r.error, null);
});

t('AnimeTrace：模型名懒加载只问一次，第二次搜图复用', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'v1' } });
    return jsonResponse({ code: 0, data: [{ name: 'rem' }] });
  });
  const az = new AnimeRecognizer({ backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  await az.recognize({ bytes: IMG });
  await az.recognize({ bytes: IMG2 });
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/v1/model/list')).length, 1);
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/v1/search')).length, 2);
});

// ---- both ----

t('both：本地高置信度命中时不问 AnimeTrace', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.includes('/recognize')) return jsonResponse({ characters: [{ name: 'frieren', confidence: 0.99 }], rating: { nsfw: 0.01 } });
    return jsonResponse({ code: 0, data: [{ name: 'should_not_happen' }] });
  });
  const az = new AnimeRecognizer({
    backend: 'both',
    recognizeUrl: 'http://local.test',
    animetraceUrl: 'http://trace.test',
    fetchImpl,
  });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://local.test/recognize');
  assert.equal(r.text, '[角色识别: frieren 99.0%]');
  assert.equal(r.source, 'anime-recognize');
});

t('both：本地未命中时回落到 AnimeTrace', async () => {
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.includes('/recognize')) return jsonResponse({ characters: [{ name: 'too_low', confidence: 0.2 }], rating: 'sfw' });
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'model_v3' } });
    return jsonResponse({ code: 0, data: [{ name: 'nahida' }] });
  });
  const az = new AnimeRecognizer({
    backend: 'both',
    recognizeUrl: 'http://local.test',
    animetraceUrl: 'http://trace.test',
    fetchImpl,
  });
  const r = await az.recognize({ bytes: IMG2 });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(r.text, '[角色识别: nahida]');
  assert.equal(r.source, 'animetrace');
});

t('both：两端全挂 → 空串，绝不渲染"未能识别"', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse('down', 503));
  const az = new AnimeRecognizer({
    backend: 'both',
    recognizeUrl: 'http://local.test',
    animetraceUrl: 'http://trace.test',
    fetchImpl,
  });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '');
  assert.notEqual(r.text, NOT_FOUND_TEXT);
  assert.ok(r.error, '全挂要有 error 说明');
  assert.ok(az.stats.failed >= 2);
});

// ---- 缓存 ----

t('缓存：同图第二次 cached=true 且不再发请求；JsonStore 重建后仍命中', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async () => jsonResponse({ characters: [{ name: 'marisa', confidence: 0.95 }], rating: 'sfw' }));
  const az = new AnimeRecognizer({
    storage: store,
    backend: 'anime-recognize',
    recognizeUrl: 'http://local.test',
    fetchImpl,
  });

  const first = await az.recognize({ bytes: IMG });
  assert.equal(first.cached, false);
  assert.equal(first.text, '[角色识别: marisa 95.0%]');
  assert.equal(fetchImpl.calls.length, 1);
  store.flush();

  const second = await az.recognize({ bytes: IMG });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(fetchImpl.calls.length, 1, '命中缓存不该再发请求');
  assert.equal(az.stats.hits, 1);

  // 跨"进程"：新 JsonStore + 新识别器读同一个目录
  const store2 = new JsonStore({ dir });
  const fetch2 = makeFetch(async () => {
    throw new Error('命中落盘缓存就不该发请求');
  });
  const az2 = new AnimeRecognizer({
    storage: store2,
    backend: 'anime-recognize',
    recognizeUrl: 'http://local.test',
    fetchImpl: fetch2,
  });
  const third = await az2.recognize({ bytes: IMG });
  assert.equal(third.cached, true);
  assert.equal(third.text, '[角色识别: marisa 95.0%]');
  assert.equal(fetch2.calls.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

t('缓存：作品名一起落盘；老缓存（没有 work 字段）照样能读，不失效也不重问', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'm' } });
    return jsonResponse({ code: 0, data: [{ not_confident: false, character: [{ work: 'ぼっち・ざ・ろっく！', character: '後藤ひとり' }] }] });
  });
  const az = new AnimeRecognizer({ storage: store, backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl });
  const first = await az.recognize({ bytes: IMG });
  assert.equal(first.text, '[角色识别: 後藤ひとり（ぼっち・ざ・ろっく！）]');
  store.flush();

  const az2 = new AnimeRecognizer({ storage: new JsonStore({ dir }), backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl: makeFetch(async () => { throw new Error('不该重问'); }) });
  const second = await az2.recognize({ bytes: IMG });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.characters, [{ name: '後藤ひとり', work: 'ぼっち・ざ・ろっく！', confidence: null }]);

  // 老缓存（2026-10-07 之前写下的条目没有 `work`）：读成"没作品名"，不报错、不重问
  const legacy = new JsonStore({ dir: tmpDir() });
  legacy.write('vision/anime-cache.json', {
    version: 1,
    entries: { 'legacyhash:animetrace': { text: '[角色识别: 老条目]', source: 'animetrace', characters: [{ name: '老条目', confidence: null }], nsfw: null, at: 1 } },
  });
  legacy.flush();
  const az3 = new AnimeRecognizer({ storage: legacy, backend: 'animetrace', animetraceUrl: 'http://trace.test', fetchImpl: makeFetch(async () => { throw new Error('不该重问'); }) });
  const third = await az3.recognize({ bytes: IMG, sha256: 'legacyhash' });
  assert.equal(third.cached, true);
  assert.deepEqual(third.characters, [{ name: '老条目', work: null, confidence: null }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

t('缓存：键含 backend，不同后端不串味', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async (call) => {
    if (call.url.includes('/recognize')) return jsonResponse({ characters: [{ name: 'local_name', confidence: 0.9 }], rating: 'sfw' });
    if (call.url.endsWith('/v1/model/list')) return jsonResponse({ code: 0, data: { default: 'v3' } });
    return jsonResponse({ code: 0, data: [{ name: 'trace_name' }] });
  });
  const opts = { storage: store, recognizeUrl: 'http://local.test', animetraceUrl: 'http://trace.test', fetchImpl };
  const local = new AnimeRecognizer({ ...opts, backend: 'anime-recognize' });
  const trace = new AnimeRecognizer({ ...opts, backend: 'animetrace' });
  const a = await local.recognize({ bytes: IMG });
  const b = await trace.recognize({ bytes: IMG });
  assert.equal(a.text, '[角色识别: local_name 90.0%]');
  assert.equal(b.text, '[角色识别: trace_name]');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('缓存：snapshot() 条目数与 stats.cache 一致', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async () => jsonResponse({ characters: [{ name: 'x', confidence: 0.9 }], rating: 'sfw' }));
  const az = new AnimeRecognizer({ storage: store, backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  await az.recognize({ bytes: IMG });
  await az.recognize({ bytes: IMG2 });
  await az.recognize({ bytes: IMG }); // 命中缓存，不该多出条目
  assert.equal(az.stats.cache, 2);
  assert.equal(az.snapshot().length, 2);
  assert.equal(az.snapshot().filter((e) => e.cached).length, 0);
  assert.ok(az.snapshot().every((e) => String(e.hash).endsWith(':anime-recognize')));
  assert.ok(az.snapshot().every((e) => typeof e.text === 'string' && e.text.startsWith('[角色识别:')));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('缓存：全挂的结果不落缓存（下次还会重问）', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async () => jsonResponse('nope', 500));
  const az = new AnimeRecognizer({ storage: store, backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  await az.recognize({ bytes: IMG });
  store.flush();
  assert.equal(az.stats.cache, 0);
  assert.equal(az.snapshot().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'vision', 'anime-cache.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- maxCharacters ----

t('maxCharacters=2：只保留两个名字，且按置信度降序（最高分排最前，m30282）', async () => {
  const fetchImpl = makeFetch(async () =>
    jsonResponse({
      characters: [
        { name: 'alpha', confidence: 0.9 },
        { name: 'beta', confidence: 0.91 },
        { name: 'gamma', confidence: 0.92 },
      ],
      rating: 'sfw',
    }),
  );
  const az = new AnimeRecognizer({
    backend: 'anime-recognize',
    recognizeUrl: 'http://local.test',
    fetchImpl,
    maxCharacters: 2,
  });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '[角色识别: gamma 92.0%, beta 91.0%]', '先按置信度降序再截取：gamma(0.92) 在 beta(0.91) 前面');
  assert.ok(!r.text.includes('alpha'), '第三名被截掉');
  assert.equal(r.characters.length, 2);
  assert.equal(r.characters[0].name, 'gamma');
});

t('maxCharacters 默认 1：只显示置信度最高的那一个（m30282）', async () => {
  const fetchImpl = makeFetch(async () =>
    jsonResponse({
      characters: [
        { name: 'alpha', confidence: 0.9 },
        { name: 'beta', confidence: 0.99 },
      ],
      rating: 'sfw',
    }),
  );
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  const r = await az.recognize({ bytes: IMG });
  assert.equal(r.text, '[角色识别: beta 99.0%]', '显示的是最高分，不是列表第一个');
  assert.equal(r.characters.length, 1);
});

t('没认出（answered=true）的结果也落缓存，下次不重问（m30282）', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ dir });
  const fetchImpl = makeFetch(async () => jsonResponse({ characters: [], rating: 'sfw', people_count: 0 }));
  const az = new AnimeRecognizer({ storage: store, backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl });
  const first = await az.recognize({ bytes: IMG });
  assert.equal(first.text, '');
  assert.equal(first.cached, false);
  store.flush();
  assert.equal(az.stats.cache, 1, '答了但没认出：要落缓存');

  const az2 = new AnimeRecognizer({ storage: new JsonStore({ dir }), backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl: makeFetch(async () => { throw new Error('不该重问'); }) });
  const second = await az2.recognize({ bytes: IMG });
  assert.equal(second.cached, true);
  assert.equal(second.text, '', '缓存命中的"没认出"同样是空串');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- attach/detach ----

t('attach/detach：摘掉 fetch 后 enabled 为 false 且不发请求', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse({ characters: [], rating: 'sfw' }));
  // 显式传 fetchImpl: null：Node 里 globalThis.fetch 是存在的，不显式关掉就没法测"没接 fetch"
  const az = new AnimeRecognizer({ backend: 'anime-recognize', recognizeUrl: 'http://local.test', fetchImpl: null });
  assert.equal(az.enabled, false);
  az.attach({ fetchImpl });
  assert.equal(az.enabled, true);
  await az.recognize({ bytes: IMG });
  assert.equal(fetchImpl.calls.length, 1);
  az.detach();
  assert.equal(az.enabled, false);
  const r = await az.recognize({ bytes: IMG2 });
  assert.equal(r.text, '');
  assert.equal(fetchImpl.calls.length, 1);
});

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases }, null, 2));
if (failed.length) process.exitCode = 1;
