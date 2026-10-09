/**
 * 聊天管理命令（②）的单元测试。
 *
 * 这里刻意**不建 Hub**：命令面最要紧的语义是"谁来触发、命中之后拦成什么样"，那部分是
 * 纯函数 + 一个路由器对象，用假的 services 就能测清楚。真正"命中后不转发、不唤醒"的
 * 端到端行为在 m15-e2e.mjs 的 scenarioChatCommands 里验。
 */

import assert from 'node:assert/strict';
import {
  ChatCommands,
  COMMAND_SPECS,
  COMMAND_INDEX,
  parseChatCommand,
  plainTextOf,
  isSuperUser,
  clipReply,
  usageLine,
} from '../lib/chat-commands.js';

const cases = [];
const pending = [];

function t(name, fn) {
  const entry = { name, ok: true, error: null };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(
        result.then(
          () => {
            entry.ok = true;
          },
          (err) => {
            entry.ok = false;
            entry.error = String(err?.stack ?? err);
          },
        ),
      );
    }
  } catch (err) {
    entry.ok = false;
    entry.error = String(err?.stack ?? err);
  }
  cases.push(entry);
}

// ------------------------------------------------------------------ plainTextOf

t('plainTextOf：只取 text 段，@ 与图片不干扰命令识别', () => {
  const event = {
    message: [
      { type: 'at', data: { qq: '3371846367' } },
      { type: 'text', data: { text: ' /status' } },
    ],
  };
  assert.equal(plainTextOf(event), ' /status');
});

t('plainTextOf：message 缺失时退回 raw_message 并剥掉 CQ 码', () => {
  const event = { raw_message: '[CQ:at,qq=1] /help' };
  assert.equal(plainTextOf(event), ' /help');
});

t('plainTextOf：没有任何文本段就是空串（纯图/纯表情不可能是命令）', () => {
  assert.equal(plainTextOf({ message: [{ type: 'image', data: { file: 'a.jpg' } }] }), '');
  assert.equal(plainTextOf({}), '');
  assert.equal(plainTextOf(null), '');
});

// ------------------------------------------------------------------ parseChatCommand

t('parseChatCommand：只在开头认前缀', () => {
  assert.deepEqual(parseChatCommand('/status'), { name: 'status', args: '', argv: [], text: '/status' });
  assert.equal(parseChatCommand('你好 /status'), null);
  assert.equal(parseChatCommand(''), null);
  assert.equal(parseChatCommand(null), null);
});

t('parseChatCommand：命令名大小写不敏感，参数按空白切', () => {
  const parsed = parseChatCommand('/SET_ROLE 小烤 你是一只猪');
  assert.equal(parsed.name, 'set_role');
  assert.deepEqual(parsed.argv, ['小烤', '你是一只猪']);
  assert.equal(parsed.args, '小烤 你是一只猪');
});

t('parseChatCommand：逃生前缀表示"这条别拦"', () => {
  const parsed = parseChatCommand('!!/status 转发给下游');
  assert.equal(parsed.bypass, true);
  assert.equal(parsed.text, '/status 转发给下游');
});

t('parseChatCommand：光一个前缀不算命令', () => {
  assert.equal(parseChatCommand('/'), null);
  assert.equal(parseChatCommand('/   '), null);
});

// ------------------------------------------------------------------ 权限

t('isSuperUser：字符串/数字两种写法都认，空名单与空账号都判 false', () => {
  assert.equal(isSuperUser(10001, ['10001']), true);
  assert.equal(isSuperUser('10001', [10001]), true);
  assert.equal(isSuperUser('10002', ['10001']), false);
  assert.equal(isSuperUser('10001', []), false);
  assert.equal(isSuperUser('', ['10001']), false);
  assert.equal(isSuperUser(undefined, ['10001']), false);
});

t('isSuperUser：`*` 是显式全开', () => {
  assert.equal(isSuperUser('999', ['*']), true);
});

t('clipReply：超长截断并留一个省略号', () => {
  assert.equal(clipReply('abc', 10), 'abc');
  assert.equal(clipReply('abcdef', 4), 'abc…');
});

// ------------------------------------------------------------------ 命令表

t('命令表：没有重名/重别名，每条都有 usage 与 summary', () => {
  const seen = new Set();
  for (const spec of COMMAND_SPECS) {
    assert.ok(spec.name, 'spec 必须有 name');
    assert.ok(!seen.has(spec.name), `命令名重复：${spec.name}`);
    seen.add(spec.name);
    for (const alias of spec.aliases ?? []) {
      const key = String(alias).toLowerCase();
      assert.ok(!seen.has(key), `别名与已有命令冲突：${alias}`);
      seen.add(key);
    }
    // usage **不带前缀**：前缀可配（chatCommands.prefix），写死 `/` 的话用户换了前缀
    // 照回话敲的命令会被当成普通聊天。渲染统一走 usageLine(spec, prefix)。
    assert.ok(spec.usage, `${spec.name} 缺 usage`);
    assert.ok(!/^[/!#。！]/.test(spec.usage), `${spec.name} 的 usage 不该带前缀：${spec.usage}`);
    assert.equal(usageLine(spec, '/'), `/${spec.usage}`, `${spec.name} 的 usageLine 要拼当前前缀`);
    assert.equal(usageLine(spec, '!!'), `!!${spec.usage}`, `${spec.name} 要认多字符前缀`);
    assert.ok(spec.summary, `${spec.name} 缺 summary`);
    assert.equal(typeof spec.run, 'function', `${spec.name} 缺 run`);
    assert.equal(COMMAND_INDEX.get(spec.name), spec);
    for (const alias of spec.aliases ?? []) assert.equal(COMMAND_INDEX.get(String(alias).toLowerCase()), spec);
  }
});

t('命令表：对标 master 的六条管理命令都存在（含中文别名）', () => {
  for (const name of ['status', 'set_role', 'reset', 'presets', 'set_preset', 'reload_meme']) {
    assert.ok(COMMAND_INDEX.has(name), `缺命令 ${name}`);
  }
  assert.equal(COMMAND_INDEX.get('状态')?.name, 'status');
  assert.equal(COMMAND_INDEX.get('设置角色')?.name, 'set_role');
  assert.equal(COMMAND_INDEX.get('重置')?.name, 'reset');
  assert.equal(COMMAND_INDEX.get('set_presets')?.name, 'set_preset');
  assert.equal(COMMAND_INDEX.get('重载表情包')?.name, 'reload_meme');
});

// ------------------------------------------------------------------ 路由器

function makeServices() {
  const calls = [];
  return {
    calls,
    services: {
      hub: {
        config: { nickname: 'dsh-hub', agent: { mode: 'assist' } },
        status: () => ({
          uptimeMs: 65000,
          policy: { preset: 'relay' },
          upstream: { connected: true, url: 'ws://127.0.0.1:14514/onebot/v11/ws' },
          downstream: [{ linkId: 'down:30001000' }],
          timeline: { total: 42, sessions: 3 },
        }),
      },
      persona: {
        list: () => [
          { name: 'default', role: '默认角色' },
          { name: '小烤', role: '一只认真的猪' },
        ],
        has: (name) => name === 'default' || name === '小烤',
        bind: (key, name) => {
          calls.push(['bind', key, name]);
          return true;
        },
        boundName: () => '小烤',
        unbind: (key) => {
          calls.push(['unbind', key]);
          return true;
        },
        resolve: () => ({ name: '小烤', role: '一只认真的猪' }),
        setRole: (key, patch) => {
          calls.push(['setRole', key, patch]);
          return true;
        },
      },
      memes: {
        stats: { count: 2, capacity: 200 },
        list: () => [
          { id: 'm1', description: '鼓掌的猫', keywords: ['开心'] },
          { id: 'm2', description: '瘫着的狗', keywords: ['累'] },
        ],
        remove: (id) => id === 'm1',
        load: () => {
          calls.push(['memes.load']);
        },
      },
    },
  };
}

function router(overrides = {}) {
  const { services } = makeServices();
  return new ChatCommands({
    log: () => {},
    services,
    config: { enabled: true, superUsers: ['10001'], ...overrides },
  });
}

const GROUP_EVENT = { post_type: 'message', message_type: 'group', group_id: 55555, user_id: 10001 };

t('inactive：没配超管时整条链沉默，连命令都不解析', async () => {
  const bare = new ChatCommands({ services: {}, config: { enabled: true, superUsers: [] } });
  assert.equal(bare.active, false);
  const result = await bare.handle({ event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/status' } }] }, sessionKey: 'group:55555' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'inactive');
});

t('非超管敲命令：静默放行（不回"你没权限"），交给正常流程', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, user_id: 99999, message: [{ type: 'text', data: { text: '/status' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not-superuser');
  assert.equal(r.stats.denied, 1);
});

t('超管敲 /status：拦下来并回一屏概览', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/status' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, true);
  assert.equal(result.command, 'status');
  assert.match(result.reply, /上游 已连接/);
  assert.match(result.reply, /下游 1 条/);
  assert.match(result.reply, /relay/);
  assert.match(result.reply, /小烤/);
  assert.match(result.reply, /表情包：2 个/);
  assert.equal(r.stats.handled, 1);
});

t('逃生前缀：不拦、不回，reason=bypass', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '!!/status' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'bypass');
  assert.equal(r.stats.bypassed, 1);
});

t('未知命令：不拦（那是别人的命令），但记一笔', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/draw a cat' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unknown-command');
  assert.equal(r.stats.unknown, 1);
});

t('/help 列出所有命令', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/help' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, true);
  for (const spec of COMMAND_SPECS) assert.match(result.reply, new RegExp(`/${spec.name}\\b`));
  assert.match(result.reply, /dsh-hub 的命令/);
});

t('前缀可配：文案里不许写死 `/`，`!` 前缀下 /help 与 /model 的回话都用 `!`', async () => {
  // 用户明确要求（m02289）：前缀不一定是 `/`，文案要跟着 `chatCommands.prefix` 走。
  const { services } = makeServices();
  services.models = {
    list: async () => [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }],
    current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    set: () => ({}),
  };
  const r = new ChatCommands({ services, config: { superUsers: ['10001'], prefix: '!' } });

  const help = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '!help' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(help.handled, true);
  assert.match(help.reply, /!status/, 'help 里的用法要用配置的前缀');
  assert.ok(!help.reply.includes('/status'), `help 里不该出现写死的斜杠命令：\n${help.reply}`);
  assert.match(help.reply, /!model \[provider\/model/, 'usage 里的 provider/model 照旧（那不是前缀）');

  const list = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '!model' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(list.reply, /!model 3/, '清单提示里的命令要用配置的前缀');
  assert.ok(!list.reply.includes('/model 3'), '不许写死 /model');

  const bad = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '!model 瞎写' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(bad.reply, /用法：!model provider\/model/);

  // 旧前缀在这套配置下不再是命令（会被当普通聊天，一如既往不回复）
  const stale = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/status' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(stale.handled, false);
  assert.equal(stale.reason, 'not-command');

  // 让路前缀也按配置：`!!` 默认，配成别的就认别的
  const other = new ChatCommands({ services, config: { superUsers: ['10001'], prefix: '!', bypassPrefix: '?' } });
  const bypassed = await other.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '?!help' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(bypassed.handled, false);
  assert.equal(bypassed.reason, 'bypass');
});

t('/set_preset 切换绑定，未知预设回一句人话', async () => {
  const { services, calls } = makeServices();
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  const ok = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/set_preset 小烤' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(ok.handled, true);
  assert.deepEqual(calls.at(-1), ['bind', 'group:55555', '小烤']);
  const bad = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/set_preset 不存在' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(bad.reply, /没有叫「不存在」的预设/);
});

t('/set_role 把名字与设定一起写进本会话', async () => {
  const { services, calls } = makeServices();
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/设置角色 小烤 你是一只认真的猪' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, true);
  assert.deepEqual(calls.at(-1), ['setRole', 'group:55555', { name: '小烤', role: '你是一只认真的猪' }]);
});

t('/preset_role 只改设定', async () => {
  const { services, calls } = makeServices();
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/preset_role 换成更懒的语气' } }] },
    sessionKey: 'group:55555',
  });
  assert.deepEqual(calls.at(-1), ['setRole', 'group:55555', { role: '换成更懒的语气' }]);
});

t('/memes 列表与删除', async () => {
  const r = router();
  const list = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/memes' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(list.reply, /表情包 2\/200 个/);
  assert.match(list.reply, /m1 鼓掌的猫（开心）/);
  const del = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/meme del m1' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(del.reply, /已删掉 m1/);
  const miss = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/meme del m9' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(miss.reply, /没有 m9/);
});

t('/reset 明确声明不动长期记忆', async () => {
  const r = router();
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/reset' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(result.reply, /人设绑定回默认/);
  assert.match(result.reply, /长期记忆.*没动/);
});

t('命令 run 抛错：回一句失败原因，且 stats.failed 记到，handled 仍为 true（不能被当普通消息转发）', async () => {
  const services = { persona: { list: () => { throw new Error('磁盘炸了'); } } };
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  const result = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/presets' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, 'error');
  assert.match(result.reply, /执行失败：磁盘炸了/);
  assert.equal(r.stats.failed, 1);
  assert.match(r.stats.lastError.message, /磁盘炸了/);
});

t('服务缺失：每条命令都降级成一句话而不是抛错', async () => {
  const r = new ChatCommands({ services: {}, config: { superUsers: ['10001'] } });
  for (const name of ['presets', 'set_preset', 'set_role', 'preset_role', 'memes', 'reload_meme', 'status', 'perm', 'reset']) {
    const result = await r.handle({
      event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: `/${name} x` } }] },
      sessionKey: 'group:55555',
    });
    assert.equal(result.handled, true, `${name} 应该被拦下`);
    assert.equal(result.reason, 'ok', `${name} 不该抛错：${result.reply}`);
    assert.ok(result.reply.length > 0, `${name} 应该回一句`);
  }
});

t('/perm：会话键原样交给权限服务，没给预设名就只问现状', async () => {
  const calls = [];
  const services = {
    perms: {
      describe: ({ sessionKey }) => {
        calls.push(['describe', sessionKey]);
        return `本会话的 agent（onebot-hub:${encodeURIComponent(sessionKey)}）还没建起来：敲 /perm <预设名> 会顺手建，或先随便聊一句。`;
      },
      setPreset: async (name, { sessionKey }) => {
        calls.push(['setPreset', name, sessionKey]);
        return `已把本会话的 agent 权限设为 ${name}。`;
      },
    },
  };
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  const ask = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/perm' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(ask.handled, true);
  assert.match(ask.reply, /还没建起来/);
  assert.match(ask.reply, /onebot-hub:group%3A55555/, '会话键要编码进 id，别自己拼个别的');
  const set = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/perm workspace-write' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(set.reply, /workspace-write/);
  const cn = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/权限 danger-full-access' } }] },
    sessionKey: 'group:55555',
  });
  assert.match(cn.reply, /danger-full-access/);
  assert.deepEqual(calls, [
    ['describe', 'group:55555'],
    ['setPreset', 'workspace-write', 'group:55555'],
    ['setPreset', 'danger-full-access', 'group:55555'],
  ]);
});

t('/model 与 /vmodel：按会话换聊天/识图模型（清单、编号、default、中文别名）', async () => {
  const calls = [];
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }] },
    { id: 'volcengine', name: '火山方舟', models: [{ id: 'doubao-vision-pro', name: '豆包视觉 Pro' }] },
  ];
  /** 假的会话级选择：真实现是 `SessionModels` + 宿主 `installModelSelection`。 */
  const store = { chat: null, vision: null };
  const services = {
    models: {
      list: async () => providers,
      current: (sessionKey, kind) => {
        calls.push(['current', sessionKey, kind]);
        return kind === 'vision' ? store.vision : store.chat ?? { provider: 'deepseek', model: 'deepseek-chat' };
      },
      set: (sessionKey, kind, ref) => {
        calls.push(['set', sessionKey, kind, ref]);
        store[kind] = ref;
        return { chat: store.chat, vision: store.vision };
      },
    },
  };
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  const send = (text, sessionKey = 'group:55555') =>
    r.handle({ event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text } }] }, sessionKey });

  // 无参：列清单 + 当前值（→ 标当前）
  const list = await send('/model');
  assert.equal(list.handled, true);
  assert.match(list.reply, /当前：deepseek\/deepseek-chat/);
  assert.match(list.reply, /→ 1\. deepseek-chat/);
  assert.match(list.reply, /3\. doubao-vision-pro/);
  assert.equal(calls.at(-1).join('|'), 'current|group:55555|chat');

  // provider/model
  const byRef = await send('/model volcengine/doubao-vision-pro');
  assert.match(byRef.reply, /已切到 volcengine\/doubao-vision-pro/);
  assert.match(byRef.reply, /只对本会话生效/);
  assert.deepEqual(calls.at(-1), ['set', 'group:55555', 'chat', { provider: 'volcengine', model: 'doubao-vision-pro' }]);

  // 编号（按清单摊平后的序号）
  const byIndex = await send('/model 2');
  assert.match(byIndex.reply, /deepseek\/deepseek-reasoner/);
  assert.deepEqual(calls.at(-1), ['set', 'group:55555', 'chat', { provider: 'deepseek', model: 'deepseek-reasoner' }]);

  // default → 回系统默认（写 null）
  const cleared = await send('/model default');
  assert.match(cleared.reply, /已回系统默认/);
  assert.deepEqual(calls.at(-1), ['set', 'group:55555', 'chat', null]);

  // 识图模型走同一个实现，但 kind=vision、别名也认
  const vmodel = await send('/vmodel volcengine/doubao-vision-pro');
  assert.match(vmodel.reply, /识图模型已切到/);
  assert.deepEqual(calls.at(-1), ['set', 'group:55555', 'vision', { provider: 'volcengine', model: 'doubao-vision-pro' }]);
  assert.equal(store.chat, null, '换识图模型不许动聊天模型');
  const alias = await send('/视觉模型 default');
  assert.match(alias.reply, /识图模型已回系统默认模型/);
  assert.deepEqual(calls.at(-1), ['set', 'group:55555', 'vision', null]);

  // 认不出的写法：明确报错 + 列出三种写法，而不是瞎猜
  const setsBefore = calls.filter((call) => call[0] === 'set').length;
  const bad = await send('/model 随便写点什么');
  assert.match(bad.reply, /provider\/model/);
  assert.match(bad.reply, /\/model 编号/);
  assert.equal(calls.filter((call) => call[0] === 'set').length, setsBefore, '认不出就不该写任何东西');

  // 编号越界：说清楚共几个（同样不写）
  const over = await send('/model 9');
  assert.match(over.reply, /共 3 个/);
  assert.equal(calls.filter((call) => call[0] === 'set').length, setsBefore);

  // 会话键原样透传（别的形状的会话也照办）
  await send('/model 1', 'channel:guild-7/room-9');
  assert.equal(calls.at(-1)[1], 'channel:guild-7/room-9');
});

t('/model：宿主没接上 llm 通道时如实说，不编模型名', async () => {
  const r = new ChatCommands({ services: {}, config: { superUsers: ['10001'] } });
  const out = await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/vmodel' } }] },
    sessionKey: 'group:55555',
  });
  assert.equal(out.handled, true);
  assert.match(out.reply, /识图模型换不了/);
  assert.match(out.reply, /llm/);
});

t('describe()：把命令面状态摊开给工具面看', () => {
  const r = router();
  const described = r.describe();
  assert.equal(described.active, true);
  assert.equal(described.prefix, '/');
  assert.equal(described.bypassPrefix, '!!');
  assert.equal(described.superUsers, 1);
  assert.ok(described.commands.includes('status'));
});

t('sessionKey 原样透传（不假设只有 group/private 两种形状）', async () => {
  const { services, calls } = makeServices();
  const r = new ChatCommands({ services, config: { superUsers: ['10001'] } });
  await r.handle({
    event: { ...GROUP_EVENT, message: [{ type: 'text', data: { text: '/set_role 换个角色' } }] },
    sessionKey: 'channel:guild-7/room-9',
  });
  assert.equal(calls.at(-1)[0], 'setRole');
  assert.equal(calls.at(-1)[1], 'channel:guild-7/room-9');
});

await Promise.all(pending);
const failed = cases.filter((entry) => !entry.ok);
console.log(JSON.stringify({ passed: cases.length - failed.length, failed: failed.length, cases: failed }, null, 2));
if (failed.length) process.exitCode = 1;
