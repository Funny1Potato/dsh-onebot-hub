/**
 * 语音合成（TTS）的自包含测试（`node test/tts.mjs`）。
 *
 * 为什么这么测：
 *  - 这条链**唯一会花钱**的地方就是"发出去的那一次请求"，所以最该锁住的三件事是：
 *    ① 请求体长什么样（字段名、参考音频怎么带、哪些字段到不了请求体）；
 *    ② 同一句话第二次不该再花钱（磁盘缓存）；
 *    ③ 密钥绝不能出现在请求体与错误信息里（`lib/vision/imagegen.js` 同一条纪律）。
 *  - 失败路径比成功路径更容易出问题：一句话合成失败只该"少这一条"，不该把整次回复打崩，
 *    所以错误必须收在返回值里、并且可读。
 *  - 全部离线：用假 fetch，不联网、不读环境变量；落盘用临时目录。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Tts } from '../lib/audio/tts.js';
import { composeReply, resolvePartsSpeech } from '../lib/reply.js';

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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
const AUDIO = Buffer.from('ID3fake-mp3-bytes');

/** 假 fetch：记下每次请求的 url/body，按 `respond` 决定回什么。 */
function fakeFetch(respond = () => ({ ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => AUDIO })) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    return respond(calls.length, { url: String(url), init });
  };
  impl.calls = calls;
  return impl;
}

const base = (over = {}) => ({
  enabled: true,
  baseUrl: 'https://tts.example.com/v1',
  apiKey: 'sk-secret-123',
  model: 'tts-1',
  voice: 'alloy',
  fetchImpl: fakeFetch(),
  ...over,
});

// ---- 开关与配置 ---------------------------------------------------------------

t('没开 / 没配全：明确说缺什么，一个请求都不发', async () => {
  const f = fakeFetch();
  const off = new Tts({ enabled: false, baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: f });
  const r1 = await off.synth({ text: '你好' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /未启用或配置不完整/);
  const noKey = new Tts({ enabled: true, baseUrl: 'https://x/v1', apiKey: '', fetchImpl: f });
  assert.equal(noKey.enabled, false, '缺 apiKey 就该是关着的');
  assert.equal((await noKey.synth({ text: '你好' })).ok, false);
  assert.equal(f.calls.length, 0);
});

t('空文本与超长：先说清楚，不发请求（超长不偷偷截断）', async () => {
  const f = fakeFetch();
  const tts = new Tts(base({ fetchImpl: f, maxChars: 10 }));
  assert.match((await tts.synth({ text: '   ' })).error, /空的/);
  const long = await tts.synth({ text: 'x'.repeat(11) });
  assert.equal(long.ok, false);
  assert.match(long.error, /太长（11 字，上限 10）/);
  assert.equal(f.calls.length, 0);
});

// ---- 请求体 -------------------------------------------------------------------

t('请求体：URL 拼对、密钥只在 Authorization 头里、默认只带必要字段', async () => {
  const f = fakeFetch();
  const tts = new Tts(base({ fetchImpl: f }));
  const r = await tts.synth({ text: '今晚早点睡' });
  assert.equal(r.ok, true, r.error);
  const [call] = f.calls;
  assert.equal(call.url, 'https://tts.example.com/v1/audio/speech');
  assert.equal(call.headers.authorization, 'Bearer sk-secret-123');
  assert.equal(call.body.model, 'tts-1');
  assert.equal(call.body.input, '今晚早点睡');
  assert.equal(call.body.voice, 'alloy');
  assert.equal(call.body.response_format, 'mp3');
  assert.equal(call.body.speed, undefined, '语速 1 不该出现在请求体里');
  assert.equal(call.body.ref_audio, undefined, '没配参考音频就不该有这个字段');
  assert.equal(call.body.ref_text, undefined);
  assert.ok(!JSON.stringify(call.body).includes('sk-secret-123'), '密钥绝不能进请求体');
});

t('语速与风格：≠1 才带 speed，instructions 空就不发', async () => {
  const f1 = fakeFetch();
  await new Tts(base({ fetchImpl: f1, speed: 1.5, instructions: '语气轻快' })).synth({ text: '嗨' });
  assert.equal(f1.calls[0].body.speed, 1.5);
  assert.equal(f1.calls[0].body.instructions, '语气轻快');
  const f2 = fakeFetch();
  await new Tts(base({ fetchImpl: f2, speed: 1, instructions: '' })).synth({ text: '嗨' });
  assert.equal(f2.calls[0].body.speed, undefined);
  assert.equal(f2.calls[0].body.instructions, undefined);
});

t('自定义音色：任意字符串原样透传（兼容服务用自己注册的名字）', async () => {
  const f = fakeFetch();
  const tts = new Tts(base({ fetchImpl: f, voice: 'zh_female_01' }));
  await tts.synth({ text: '你好' });
  assert.equal(f.calls[0].body.voice, 'zh_female_01');
  const f2 = fakeFetch();
  await new Tts(base({ fetchImpl: f2 })).synth({ text: '你好', voice: '某个克隆音色' });
  assert.equal(f2.calls[0].body.voice, '某个克隆音色', '单次指定的音色要盖过默认值');
});

// ---- 参考音频（零样本克隆）----------------------------------------------------

t('参考音频：URL 原样给、base64:// 剥前缀、本地路径读成 data URL', async () => {
  const f = fakeFetch();
  const tts = new Tts(base({ fetchImpl: f, refAudio: 'https://cdn.example.com/ref.mp3', refText: '参考音频里的话' }));
  await tts.synth({ text: '照着说' });
  assert.equal(f.calls[0].body.ref_audio, 'https://cdn.example.com/ref.mp3', 'URL 不该被下载，让上游自己取');
  assert.equal(f.calls[0].body.ref_text, '参考音频里的话');

  const f2 = fakeFetch();
  await new Tts(base({ fetchImpl: f2, refAudio: 'base64://QUJD' })).synth({ text: 'x' });
  assert.equal(f2.calls[0].body.ref_audio, 'QUJD');

  const dir = tmpDir();
  const refFile = path.join(dir, 'ref.wav');
  fs.writeFileSync(refFile, Buffer.from('RIFFfake'));
  const f3 = fakeFetch();
  await new Tts(base({ fetchImpl: f3, refAudio: refFile })).synth({ text: 'x' });
  assert.match(f3.calls[0].body.ref_audio, /^data:audio\/wav;base64,/);
});

t('参考音频的字段名可配；留空 = 这个字段根本不发', async () => {
  const f = fakeFetch();
  await new Tts(base({ fetchImpl: f, refAudio: 'https://a/b.mp3', refAudioField: 'prompt_audio', refText: 't', refTextField: 'prompt_text' }))
    .synth({ text: 'x' });
  assert.equal(f.calls[0].body.prompt_audio, 'https://a/b.mp3');
  assert.equal(f.calls[0].body.prompt_text, 't');
  assert.equal(f.calls[0].body.ref_audio, undefined);

  const f2 = fakeFetch();
  await new Tts(base({ fetchImpl: f2, refAudio: 'https://a/b.mp3', refAudioField: '', refText: 't', refTextField: '' }))
    .synth({ text: 'x' });
  assert.equal(f2.calls[0].body.ref_audio, undefined);
  assert.equal(f2.calls[0].body.ref_text, undefined);
  assert.equal(f2.calls[0].body[''], undefined, '不该留下一个空键');
});

t('参考音频读不到：明确失败，不退化成"没克隆"', async () => {
  const f = fakeFetch();
  const r = await new Tts(base({ fetchImpl: f, refAudio: '/no/such/file.wav' })).synth({ text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /读不到参考音频/);
  assert.equal(f.calls.length, 0, '读不到就不该发请求');
});

// ---- 返回形态 -----------------------------------------------------------------

t('二进制返回：落盘到 tts/ 目录，扩展名跟着 format', async () => {
  const storage = { dir: tmpDir() };
  const r = await new Tts(base({ storage })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.path.startsWith(path.join(storage.dir, 'tts')), r.path);
  assert.ok(r.path.endsWith('.mp3'));
  assert.equal(r.bytes, AUDIO.length);
  assert.equal(fs.existsSync(r.path), true);

  const wavDir = tmpDir();
  const wavF = fakeFetch(() => ({ ok: true, status: 200, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => AUDIO }));
  const r2 = await new Tts(base({ storage: { dir: wavDir }, format: 'wav', fetchImpl: wavF })).synth({ text: '你好' });
  assert.ok(r2.path.endsWith('.wav'));
});

t('JSON 返回（中转站常见）：base64 与 url 两条路都认', async () => {
  const b64 = AUDIO.toString('base64');
  const jsonF = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ audio: b64 }),
  }));
  const r = await new Tts(base({ fetchImpl: jsonF })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.bytes, AUDIO.length);

  const urlF = async (url) => {
    if (String(url).includes('/audio/speech')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data: [{ url: 'https://cdn.example.com/a.mp3' }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => AUDIO };
  };
  const r2 = await new Tts(base({ fetchImpl: urlF })).synth({ text: '你好' });
  assert.equal(r2.ok, true, r2.error);

  const bad = fakeFetch(() => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ oops: 1 }) }));
  const r3 = await new Tts(base({ fetchImpl: bad })).synth({ text: '你好' });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /没有返回音频/);
});

// ---- 缓存 ---------------------------------------------------------------------

t('缓存：同一句话同一音色第二次直接复用，不再花钱', async () => {
  const f = fakeFetch();
  const storage = { dir: tmpDir() };
  const tts = new Tts(base({ storage, fetchImpl: f }));
  const a = await tts.synth({ text: '同一句话' });
  const b = await tts.synth({ text: '同一句话' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(f.calls.length, 1, '第二次不该再发请求');
  assert.equal(b.cached, true);
  assert.equal(a.path, b.path);
  // 换了音色就是另一段音频，必须重新合成
  await tts.synth({ text: '同一句话', voice: 'nova' });
  assert.equal(f.calls.length, 2);
  assert.equal(tts.stats.cached, 1);
});

// ---- 失败与脱敏 ---------------------------------------------------------------

t('上游报错：错误可读、密钥被抹掉，且不外抛', async () => {
  const f = fakeFetch(() => ({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    text: async () => '{"error":"invalid key sk-secret-123"}',
  }));
  const tts = new Tts(base({ fetchImpl: f }));
  const r = await tts.synth({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.match(r.error, /invalid key/);
  assert.ok(!r.error.includes('sk-secret-123'), '错误信息里不能出现密钥');
  assert.equal(tts.stats.failed, 1);
});

t('超时：按 timeoutMs 断开并如实说明', async () => {
  const hang = () => new Promise(() => {});
  const tts = new Tts(base({ fetchImpl: hang, timeoutMs: 30 }));
  const r = await tts.synth({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时（30ms）/);
});

// ---- 与 onebot_reply 的接口 ---------------------------------------------------

t('resolvePartsSpeech：tts 段换成 record 段（本地文件），文字段原样留着', async () => {
  const storage = { dir: tmpDir() };
  const hub = { tts: new Tts(base({ storage })) };
  const out = await resolvePartsSpeech(hub, [
    { type: 'text', content: '听我说' },
    { type: 'tts', text: '今晚早点睡' },
  ]);
  assert.equal(out.notes.length, 0);
  assert.equal(out.parts.length, 2);
  assert.equal(out.parts[0].type, 'text');
  assert.equal(out.parts[1].type, 'record');
  assert.ok(String(out.parts[1].source).endsWith('.mp3'));
  // 换成 record 之后，它跟模型自己写的 record 段走同一条出站路：独立成一条
  const plan = composeReply({ text: '听我说', parts: out.parts });
  assert.deepEqual(plan.messages.map((m) => m.kind), ['text', 'record']);
});

t('resolvePartsSpeech：没开合成 / 内容为空 → 只少这一条，原因进回执', async () => {
  const out = await resolvePartsSpeech({ tts: null }, [{ type: 'tts', text: '喂' }]);
  assert.equal(out.parts.length, 0);
  assert.match(out.notes[0], /没开启/);
  const empty = await resolvePartsSpeech({ tts: null }, [{ type: 'tts', text: '  ' }]);
  assert.match(empty.notes[0], /空的/);
  // 合不成时整次回复仍然要能发出去：notes 走 skipped，不抛
  const plan = composeReply({ text: '剩下的照说', parts: [], notes: empty.notes });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.skipped.length, 1);
});

t('resolvePartsSpeech：合成失败的那条不会变成空消息', async () => {
  const bad = new Tts(base({ fetchImpl: fakeFetch(() => ({ ok: false, status: 500, headers: { get: () => 'text/plain' }, text: async () => 'boom' })) }));
  const out = await resolvePartsSpeech({ tts: bad }, [{ type: 'tts', text: '要说的' }, { type: 'text', content: '文字在' }]);
  assert.equal(out.parts.length, 1, '失败的那条被丢掉，文字还留着');
  assert.equal(out.parts[0].type, 'text');
  assert.match(out.notes[0], /语音没合成出来/);
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
