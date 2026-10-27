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
  url: 'https://tts.example.com/v1/audio/speech',
  apiKey: 'sk-secret-123',
  model: 'tts-1',
  voice: 'alloy',
  fetchImpl: fakeFetch(),
  ...over,
});

// ---- 开关与配置 ---------------------------------------------------------------

t('没开 / 没配全：明确说缺什么，一个请求都不发', async () => {
  const f = fakeFetch();
  const off = new Tts({ enabled: false, url: 'https://x/v1/audio/speech', apiKey: 'k', fetchImpl: f });
  const r1 = await off.synth({ text: '你好' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /未启用或配置不完整/);
  const noKey = new Tts({ enabled: true, url: 'https://x/v1/audio/speech', apiKey: '', fetchImpl: f });
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
  assert.equal(call.url, 'https://tts.example.com/v1/audio/speech', '地址原样用，不自动拼路径');
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
  assert.match(r3.error, /顶层字段：oops/, '找不到音频时要把实际收到的字段列出来');
});

// ---- chat 形状（小米 MiMo 这类）-----------------------------------------------

t('chat 形状：要读的话进 messages 的 assistant，instructions 变 system', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { audio: { data: AUDIO.toString('base64') } } }] }),
  }));
  const tts = new Tts(base({
    fetchImpl: f,
    shape: 'chat',
    url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-tts-voicedesign',
    voice: '',
    instructions: '温柔的女声，语速偏慢',
  }));
  const r = await tts.synth({ text: '今晚早点睡' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.bytes, AUDIO.length);
  const [call] = f.calls;
  assert.equal(call.url, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: '温柔的女声，语速偏慢' },
    { role: 'assistant', content: '今晚早点睡' },
  ]);
  assert.equal(call.body.input, undefined, 'chat 形状不该有 input');
  assert.equal(call.body.response_format, undefined, 'chat 形状不该有 response_format');
  assert.equal(call.body.voice, undefined, '音色没填就不该带这个字段');
  assert.equal(call.body.model, 'mimo-v2.5-tts-voicedesign');
});

t('chat 形状：没配 instructions 就只有一条 assistant；参考音频不掺进来', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { audio: { data: AUDIO.toString('base64') } } }] }),
  }));
  const tts = new Tts(base({ fetchImpl: f, shape: 'chat', voice: 'v1', refAudio: '/nope/ref.wav' }));
  const r = await tts.synth({ text: '嗯' });
  assert.equal(r.ok, true, r.error);
  const [call] = f.calls;
  assert.deepEqual(call.body.messages, [{ role: 'assistant', content: '嗯' }]);
  assert.equal(call.body.voice, 'v1');
  assert.equal(call.body.ref_audio, undefined, 'chat 形状不带参考音频');
});

t('chat 形状：音频在 audio.url 里也能取到', async () => {
  const f = async (url) => {
    if (String(url).includes('/chat/completions')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { audio: { url: 'https://cdn.example.com/a.mp3' } } }] }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => AUDIO };
  };
  const r = await new Tts(base({ fetchImpl: f, shape: 'chat', url: 'https://x/v1/chat/completions' })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mediaType, 'audio/mpeg');
});

t('形状写错时给指路：Speech 形状收到 chat 的返回会提示改 tts.shape', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: '这里是文字不是音频' } }] }),
  }));
  const r = await new Tts(base({ fetchImpl: f })).synth({ text: '你好' });
  assert.equal(r.ok, false);
  assert.match(r.error, /改 tts\.shape/);
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

// ---- 多家服务商（`tts.provider` 的五档形状，`m29544`）-----------------------------

t('minimax 形状：text + voice_setting/audio_setting，返回的 hex 要按 hex 解', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ data: { audio: AUDIO.toString('hex') }, base_resp: { status_code: 0 } }),
  }));
  const r = await new Tts(base({
    fetchImpl: f,
    shape: 'minimax',
    url: 'https://api.minimax.chat/v1/t2a_v2',
    model: 'speech-02-hd',
    voice: 'male-qn-qingse',
  })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readFileSync(r.path), AUDIO, 'hex 解错了就是一堆噪声字节');
  const body = f.calls[0].body;
  assert.equal(body.text, '你好');
  assert.equal(body.stream, false);
  assert.equal(body.voice_setting.voice_id, 'male-qn-qingse');
  assert.equal(body.audio_setting.format, 'mp3');
  assert.ok(!('input' in body), 'minimax 不认 input 字段');
});

t('doubao 形状：app/user/audio/request 四段，鉴权头是 `Bearer; token`', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ reqid: 'r1', code: 3000, message: 'Success', data: AUDIO.toString('base64') }),
  }));
  const r = await new Tts(base({
    fetchImpl: f,
    shape: 'doubao',
    url: 'https://openspeech.bytedance.com/api/v1/tts',
    apiKey: 'tok-abc',
    appId: 'app-123',
    voice: 'zh_female_shuangkuaisisi_moon_bigtts',
  })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readFileSync(r.path), AUDIO);
  // 分号，不是空格：写成标准 Bearer 豆包那边直接 401，且报错看不出是头写错了。
  assert.equal(f.calls[0].headers.authorization, 'Bearer; tok-abc');
  const body = f.calls[0].body;
  assert.equal(body.app.appid, 'app-123');
  assert.equal(body.app.token, 'tok-abc');
  assert.equal(body.app.cluster, 'volcano_tts', 'cluster 留空按默认');
  assert.ok(body.user.uid, 'user.uid 是必填项（真机 400 试出来的）');
  assert.equal(body.audio.voice_type, 'zh_female_shuangkuaisisi_moon_bigtts');
  assert.equal(body.audio.encoding, 'mp3');
  assert.equal(body.request.text, '你好');
  assert.equal(body.request.operation, 'query');
  assert.ok(body.request.reqid, 'request.reqid 是必填项');
  // 缺 appid = 没配全：不硬发一个空 appid 去撞 400
  assert.equal(new Tts(base({
    fetchImpl: f, shape: 'doubao', url: 'https://openspeech.bytedance.com/api/v1/tts', apiKey: 'k',
  })).configured, false);
  // 200 里带错（code≠3000）要把上游原话给出来
  const bad = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ reqid: '', code: 3001, message: 'Missing required: app.appid' }),
  }));
  const r2 = await new Tts(base({
    fetchImpl: bad, shape: 'doubao', url: 'https://openspeech.bytedance.com/api/v1/tts', apiKey: 'k', appId: 'a',
  })).synth({ text: '你好' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /3001/);
  assert.match(r2.error, /app\.appid/, '上游怎么说就怎么说，不换成"没返回音频"');
});

t('ark 形状（方舟 Agent Plan）：req_params + X-Api-Key，返回分块 JSON 流', async () => {
  const chunkA = AUDIO.subarray(0, 5).toString('base64');
  const chunkB = AUDIO.subarray(5).toString('base64');
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => [
      JSON.stringify({ code: 0, message: '', data: chunkA }),
      JSON.stringify({ code: 0, message: '', data: chunkB }),
      JSON.stringify({ code: 20000000, message: 'ok' }),
    ].join('\n'),
  }));
  const r = await new Tts(base({
    fetchImpl: f,
    shape: 'ark',
    url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
    apiKey: 'ark-key',
    voice: 'zh_female_vv_uranus_bigtts',
  })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readFileSync(r.path), AUDIO, '分块要按顺序拼回去');
  // 方舟认 X-Api-Key + X-Api-Resource-Id，而且**不能**塞 Bearer
  assert.equal(f.calls[0].headers['x-api-key'], 'ark-key');
  assert.equal(f.calls[0].headers['x-api-resource-id'], 'seed-tts-2.0', '留空按预设');
  assert.equal(f.calls[0].headers.authorization, undefined, '方舟不接受 Bearer');
  const body = f.calls[0].body;
  assert.equal(body.req_params.text, '你好');
  assert.equal(body.req_params.speaker, 'zh_female_vv_uranus_bigtts', '这一家的音色字段叫 speaker');
  assert.equal(body.req_params.audio_params.format, 'mp3');
  assert.equal(body.req_params.audio_params.sample_rate, 24000);
  // resourceId 可显式覆盖
  const f2 = fakeFetch(() => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => [
      JSON.stringify({ code: 0, data: AUDIO.toString('base64') }),
      JSON.stringify({ code: 20000000 }),
    ].join('\n'),
  }));
  await new Tts(base({
    fetchImpl: f2, shape: 'ark', url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
    apiKey: 'k', resourceId: 'my-res',
  })).synth({ text: '你好' });
  assert.equal(f2.calls[0].headers['x-api-resource-id'], 'my-res');
  // 流里报错（code>0 且不是结束码）：把上游的 message 原样给出来
  const bad = fakeFetch(() => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ code: 45000001, message: 'resource id mismatch' }),
  }));
  const r2 = await new Tts(base({
    fetchImpl: bad, shape: 'ark', url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', apiKey: 'k',
  })).synth({ text: '你好' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /45000001/);
  assert.match(r2.error, /resource id mismatch/);
  // 只有结束码、没有任何 data：要指名两个最可能的原因
  const empty = fakeFetch(() => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ code: 20000000 }),
  }));
  const r3 = await new Tts(base({
    fetchImpl: empty, shape: 'ark', url: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', apiKey: 'k',
  })).synth({ text: '你好' });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /seed-tts-2\.0/, '空流要指向 Resource-Id 与 speaker');
});

t('minimax 的 GroupId 拼在地址上；200 里的 base_resp 错误要认出来', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ data: { audio: AUDIO.toString('hex') }, base_resp: { status_code: 0 } }),
  }));
  const r = await new Tts(base({
    fetchImpl: f,
    shape: 'minimax',
    url: 'https://api.minimax.chat/v1/t2a_v2',
    groupId: '1234567890',
    apiKey: 'k',
  })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.match(f.calls[0].url, /GroupId=1234567890$/);
  // 没填就不拼（新接口不要它，多带一个查询串反而可能被拒）
  const f2 = fakeFetch(() => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ data: { audio: AUDIO.toString('hex') }, base_resp: { status_code: 0 } }),
  }));
  await new Tts(base({ fetchImpl: f2, shape: 'minimax', url: 'https://api.minimax.chat/v1/t2a_v2', apiKey: 'k' })).synth({ text: '你好' });
  assert.ok(!f2.calls[0].url.includes('GroupId'));
  // 跨域用错 Key：MiniMax 回的是 HTTP 200 + status_code 1004，不认就变成"没返回音频"
  const bad = fakeFetch(() => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'login fail: Please carry the API secret key' } }),
  }));
  const r2 = await new Tts(base({ fetchImpl: bad, shape: 'minimax', url: 'https://api.minimax.chat/v1/t2a_v2', apiKey: 'k' })).synth({ text: '你好' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /1004/);
  assert.match(r2.error, /login fail/);
});

t('dashscope 形状：input:{text,voice}，只给了 URL 就自己再下载一次', async () => {
  const f = fakeFetch((n) => (n === 1
    ? { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ output: { audio: { url: 'https://oss.example.com/a.mp3' } } }) }
    : { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => AUDIO }));
  const r = await new Tts(base({
    fetchImpl: f,
    shape: 'dashscope',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
  })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readFileSync(r.path), AUDIO);
  assert.equal(f.calls.length, 2, '第一次合成、第二次取音频');
  assert.equal(f.calls[1].url, 'https://oss.example.com/a.mp3');
  assert.equal(f.calls[0].body.input.text, '你好');
  assert.equal(f.calls[0].body.input.voice, 'Cherry');
});

t('SSE 返回也能认（有些实现在音频模式下默认流式）', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => `data: ${JSON.stringify({ audio: { data: AUDIO.toString('base64') } })}\n\ndata: [DONE]\n`,
  }));
  const r = await new Tts(base({ fetchImpl: f, shape: 'speech' })).synth({ text: '你好' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readFileSync(r.path), AUDIO);
});

t('provider=plugin：一个请求都不发，回执直接说下一步该调哪个工具', async () => {
  const f = fakeFetch();
  const r = await new Tts({
    enabled: true,
    provider: 'plugin',
    pluginTools: ['voice_tts'],
    apiKey: '',
    url: '',
    fetchImpl: f,
  }).synth({ text: '你好' });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0, 'plugin 档不该打任何请求');
  assert.match(r.error, /voice_tts/);
  assert.match(r.error, /record/);
});

t('provider 预设：认得的给地址/形状/模型，认不得的退回自定义', async () => {
  const { providerOf, PROVIDER_IDS, TTS_PROVIDERS } = await import('../lib/audio/providers.js');
  assert.deepEqual(providerOf('mimo'), TTS_PROVIDERS.find((p) => p.id === 'mimo'));
  assert.equal(providerOf('mimo').shape, 'chat');
  assert.equal(providerOf('minimax').shape, 'minimax');
  assert.equal(providerOf('dashscope').shape, 'dashscope');
  assert.equal(providerOf('doubao').shape, 'doubao');
  assert.equal(providerOf('ark').shape, 'ark');
  assert.match(providerOf('ark').url, /\/api\/v3\/plan\/tts\/unidirectional$/);
  assert.equal(providerOf('ark').resourceId, 'seed-tts-2.0', '方舟的 Resource-Id 跟着预设走');
  assert.notEqual(providerOf('ark').url, providerOf('doubao').url, '方舟 Agent Plan 与豆包 V1 是两个地址、两套凭据');
  // MiniMax 两个站点是两个选项（Key 不通用，跨域直接 401）：
  assert.equal(providerOf('minimaxi').shape, 'minimax');
  assert.match(providerOf('minimax').url, /^https:\/\/api\.minimax\.chat/);
  assert.match(providerOf('minimaxi').url, /^https:\/\/api\.minimaxi\.com/);
  assert.notEqual(providerOf('minimax').url, providerOf('minimaxi').url);
  // 同一家的两种计费方式是两个独立选项，地址不能撞（`m30030`）：
  // 小米 Token Plan = token-plan-cn…、按量付费 = api.xiaomimimo.com；百炼同理（compatible-mode）。
  assert.equal(providerOf('mimo-pay').shape, 'chat');
  assert.match(providerOf('mimo').url, /token-plan-cn\.xiaomimimo\.com/);
  assert.match(providerOf('mimo-pay').url, /^https:\/\/api\.xiaomimimo\.com/);
  assert.notEqual(providerOf('mimo').url, providerOf('mimo-pay').url);
  assert.equal(providerOf('dashscope-plan').shape, 'speech');
  assert.match(providerOf('dashscope-plan').url, /token-plan\.cn-beijing\.maas\.aliyuncs\.com/);
  assert.notEqual(providerOf('dashscope').url, providerOf('dashscope-plan').url);
  assert.equal(providerOf('plugin').shape, 'plugin');
  assert.equal(providerOf('不认识').id, 'custom', '认不得就当自定义，不静默改用户的地址');
  assert.ok(PROVIDER_IDS.includes('custom') && PROVIDER_IDS.includes('openai'));
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length, 'id 不许重复');
  assert.equal(new Set(TTS_PROVIDERS.map((p) => p.url).filter(Boolean)).size,
    TTS_PROVIDERS.filter((p) => p.url).length, '同一个地址不许挂两个选项（选哪条都一样，纯噪声）');
  for (const p of TTS_PROVIDERS) {
    assert.ok(p.id && p.label, '每家都要有 id 与 label');
    if (p.id !== 'custom' && p.id !== 'plugin') assert.match(p.url, /^https:\/\//, `${p.id} 要给完整地址`);
  }
});

t('resolveTtsTarget：选了服务商就整套听它的，只有 custom 才用用户填的（`m29830`）', async () => {
  const { resolveTtsTarget } = await import('../lib/audio/providers.js');
  // 选了一家：手填的三项一律不算数（设置页已经把这三格藏了，代码不能再听那些看不见的旧值）
  assert.deepEqual(
    resolveTtsTarget({ provider: 'mimo', url: 'https://old.example/audio/speech', shape: 'speech', model: 'old-model' }),
    { provider: 'mimo', url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', shape: 'chat', model: 'mimo-v2.5-tts-voicedesign', resourceId: '' },
  );
  // custom：用户填的才算数，形状认不出退回 speech
  assert.deepEqual(
    resolveTtsTarget({ provider: 'custom', url: ' https://self.example/v1/tts ', shape: 'chat', model: 'my-model' }),
    { provider: 'custom', url: 'https://self.example/v1/tts', shape: 'chat', model: 'my-model', resourceId: '' },
  );
  assert.equal(resolveTtsTarget({ provider: 'custom', url: 'u', shape: '不认识的形状' }).shape, 'speech');
  // 方舟那条预设的 Resource-Id 也跟着预设走，才能让 `ark` 开箱可用
  assert.equal(resolveTtsTarget({ provider: 'ark' }).resourceId, 'seed-tts-2.0');
  // 认不出的服务商按 custom 处理（依旧用用户填的，不静默换成别家）
  assert.equal(resolveTtsTarget({ provider: '某家', url: 'https://x.example/tts' }).url, 'https://x.example/tts');
  // plugin 不打请求，形状固定成 plugin
  assert.equal(resolveTtsTarget({ provider: 'plugin' }).shape, 'plugin');
  // OpenAI 官方那条要能开箱用（模型名不能是空）
  assert.equal(resolveTtsTarget({ provider: 'openai' }).model, 'tts-1');
});

// ---- 汇总 ---------------------------------------------------------------------

await Promise.all(pending);
const failed = cases.filter((c) => !c.ok);
console.log(JSON.stringify({ passed, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
