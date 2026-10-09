/**
 * M15 最小闭环端到端：时间线 → 会话卡 → 上下文装配 → 唤醒会话 agent → 回复出站。
 *
 * 用**真实**的 Hub / Mind / MemoryStore / AgentPool，只把两处外部依赖换成假的：
 *  - `hub.upstream`：假上游实现端（收 send_msg）
 *  - `AgentPool.host`：假宿主（create/resume/createUserMessage），agent 由 `whenIdle` 脚本驱动
 *
 * 跑法：node test/m15-e2e.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hub } from '../lib/hub.js';
import { useWs } from '../lib/link.js';
import { planAdminOp } from '../lib/admin.js';
import { JsonlLog, safeName } from '../lib/storage.js';
import { nameIn } from '../lib/profile.js';
import { Mind, SESSION_ID_PREFIX, isSilentMarker, textOfContent } from '../lib/mind.js';
import { AgentPool } from '../lib/agent/pool.js';
import { resolveAgentPolicy, shouldWake } from '../lib/agent/policy.js';
import { MemoryStore } from '../lib/memory/store.js';
import { IsolationAudit, describeIsolation, resolveIsolation } from '../lib/memory/isolation.js';
import { applyMemoryOps } from '../lib/memory/writer.js';
import { PersonaStore } from '../lib/persona/store.js';
import { MemeStore } from '../lib/memes/store.js';
import { ChatCommands } from '../lib/chat-commands.js';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
  }
};

const SELF_ID = 30001000;

function groupMessage({ groupId, userId = 10001, messageId, text, nickname = '小明', segments }) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: groupId,
    user_id: userId,
    raw_message: text,
    font: 0,
    sender: { user_id: userId, nickname, role: 'member', card: '' },
    anonymous: null,
    message: segments ?? [{ type: 'text', data: { text } }],
  };
}

function makeHub(overrides = {}) {
  const sent = [];
  const hub = new Hub(
    { preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: SELF_ID, ...overrides },
    { log: () => {} },
  );
  hub.upstream = {
    isConnected: true,
    // 假上游也得有 stop()：`hub.stop()` 是无条件调的，缺了它收尾就炸。
    stop() {},
    async request(action, params) {
      sent.push({ action, params });
      return { status: 'ok', retcode: 0, data: { message_id: 1000 + sent.length }, echo: params?.echo ?? null };
    },
  };
  return { hub, sent };
}

function makeFakeHost({ script, archivedKeys = [], unarchiveThrows = false } = {}) {
  const created = new Map();
  // 调用顺序账本：真机事故 #2 要求 `unarchive` 必须发生在 `followup` 之前。
  const calls = [];
  const archived = new Set(archivedKeys);
  const host = {
    // 宿主的归档门控（真宿主是 `archived-session-gate` 插件，在 agent/pre-step 返回 reject）。
    async unarchive(agentKey) {
      calls.push(`unarchive:${agentKey}`);
      if (unarchiveThrows) throw new Error('workspaceRegistry 坏了');
      const was = archived.delete(agentKey);
      return { ok: true, sessionId: `onebot-hub:${encodeURIComponent(agentKey)}`, archived: was };
    },
    async hasSession(agentKey) {
      return created.has(agentKey);
    },
    // 真宿主 create/resume 返回的是**句柄**（`{ agent, dispose }`），会话对象在 handle.agent。
    // 这里刻意照真形状返回，好让"忘了取 .agent"这类错在测试里就暴露。
    async create({ agentKey, setup }) {
      const agent = makeAgent(agentKey, setup, script);
      return { agent, id: agentKey, dispose: () => agent.dispose() };
    },
    async resume({ agentKey, setup }) {
      const agent = makeAgent(agentKey, setup, script);
      return { agent, id: agentKey, dispose: () => agent.dispose() };
    },
    createUserMessage(input) {
      // 真契约：content 必须是**内容段数组**，source.kind 必须是生产者自己的 kind
      // （`'plugin'` 是已退役的 V3 写法，真宿主的 v4 录取会拒绝）。
      if (!Array.isArray(input?.content) || input.content.length === 0) {
        throw new Error('createUserMessage: content 必须是内容段数组');
      }
      assert.equal(input.source?.kind, 'onebot-hub');
      assert.notEqual(input.source?.kind, 'plugin');
      return { ...input, kind: 'user-message' };
    },
  };
  return { host, created, calls, archived };

  function makeAgent(agentKey, setup, scriptFn) {
    const agent = {
      agentKey,
      prompts: [],
      tools: new Map(),
      // 账本（永久保留，断言读 `followups.at(-1)`）+ 消费游标：真宿主里 steer 会在回合
      // 进行中送达，假宿主用"游标 + 单飞行驱动器"复刻这个语义（m31311 插话）。
      followups: [],
      steered: [],
      consumedTurns: 0,
      consumedSteers: 0,
      lastInput: null,
      idleCalls: 0,
      disposed: false,
      followup(msg) {
        calls.push('followup');
        agent.followups.push(msg);
      },
      steer(msg) {
        calls.push('steer');
        agent.steered.push(msg);
        // 真宿主：steer 会唤醒/推进回合的驱动器。这里同理，正在飞就由驱动器在下一个
        // 步骤边界认领，没在飞就立刻开始跑。
        void drive();
      },
      async whenIdle() {
        agent.idleCalls += 1;
        await drive();
      },
      dispose() {
        agent.disposed = true;
      },
    };
    let running = null;
    const drive = () => {
      if (running) return running;
      running = (async () => {
        for (;;) {
          if (agent.followups.length > agent.consumedTurns) {
            agent.lastInput = { kind: 'turn', message: agent.followups[agent.consumedTurns] };
            agent.consumedTurns += 1;
          } else if (agent.steered.length > agent.consumedSteers) {
            agent.lastInput = { kind: 'steer', message: agent.steered[agent.consumedSteers] };
            agent.consumedSteers += 1;
          } else {
            break;
          }
          await scriptFn?.(agent);
        }
      })().finally(() => {
        running = null;
        agent.lastInput = null;
      });
      return running;
    };
    const agentCtx = {
      systemPrompt: { context: (spec) => agent.prompts.push(spec) },
      tools: {
        register(tool) {
          agent.tools.set(tool.name, tool);
          return () => agent.tools.delete(tool.name);
        },
      },
    };
    setup?.(agentCtx);
    created.set(agentKey, agent);
    return agent;
  }
}

// ------------------------------------------------------------------ 场景一：唤醒 → 回复出站

async function scenarioReply() {
  const { hub, sent } = makeHub();
  const store = new MemoryStore({ limit: 200 });
  const audit = new IsolationAudit({ limit: 50 });
  const isolation = resolveIsolation({ level: 'scoped' });
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({
    script: async (agent) => {
      const tool = agent.tools.get('onebot_reply');
      assert.ok(tool, '会话 agent 应当注册了 onebot_reply');
      await tool.execute({ text: '在的，你说' });
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store, audit, isolation, policy, pool, setup: (agentCtx, { reply }) => {
    agentCtx.systemPrompt?.context?.({ name: 'onebot-hub:reply', order: 110, text: '只能通过 onebot_reply 说话' });
    agentCtx.tools?.register?.({
      name: 'onebot_reply',
      async execute(args = {}) {
        const candidate = reply.capture({ text: args.text, images: args.images ?? [], quote: args.quote_message_id });
        return candidate ? `queued:${candidate.text}` : 'empty';
      },
    });
  } });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.hooks.onDownstreamSend = (info) => mind.noteDownstreamSend(info);

  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 40001, text: 'hub 你在吗' }));
  // 真机里下游链路是通的，同一条消息会被转发给下游 → 时间线里有**两个视角**
  // （upstream-in 收到 + downstream-out 转发出去）。这里手工补上那个镜像，好让
  // "窗口里同一句话出现两次"这类回归在测试里就暴露（真机事故 #3）。
  hub.timeline.record({
    direction: 'downstream-out',
    linkId: 'down:30001000',
    event: groupMessage({ groupId: 55555, messageId: 40001, text: 'hub 你在吗' }),
    decision: 'transparent',
    refs: { upstreamLinkId: hub.upstreamLinkId, upstreamMessageId: 40001 },
  });
  check('时间线保留两个视角（§16 全量记录）', () => {
    const dirs = hub.timeline.bySession('group:55555').map((e) => e.direction);
    assert.deepEqual(dirs, ['upstream-in', 'downstream-out']);
  });
  const observed = mind.statsSnapshot;
  check('观察一条消息后进入批量窗口（未立即唤醒）', () => {
    assert.equal(observed.batches[0].pending, 1);
    assert.equal(mind.stats.woken, 0);
  });

  const flushed = await mind.flush('group:55555', { reason: 'test:manual' });
  check('手动 flush 唤醒会话 agent', () => {
    assert.equal(flushed.woke, true);
    assert.equal(created.size, 1);
    assert.match(flushed.sections, /source:\d+/);
    assert.ok(!/(^| )card:|(^| )window:/.test(flushed.sections), `v4：会话卡/最近窗口不再进快照段：${flushed.sections}`);
  });

  const agent = created.get('group:55555');
  /**
   * v4（m24409 用户定案）：易变的会话卡/最近窗口**不再进 live 快照**——宿主对 runtime-context
   * 快照是 append 不替换，它们每来一条消息都变 ⇒ 整份快照每条消息重注一遍。现在消息只在
   * 批次 user message 里出现一次（"这段之前的事"由每段会话第一批的【开局快照】带一次）。
   */
  const live = mind.liveContext('group:55555');
  const followup = agent.followups[0].content.map((part) => part.text ?? '').join('');
  check('注入的上下文含来源/身份，但不再含会话卡与消息明细（v4）', () => {
    assert.match(live, /【来源】/);
    assert.ok(!live.includes('【会话卡】'), `v4：会话卡不该再进快照：\n${live}`);
    assert.ok(!live.includes('hub 你在吗'), `v4：消息不该再出现在快照（卡/窗都移出了）：\n${live}`);
    assert.ok(!live.includes('dsh_trace'), '不应把 trace 塞进 prompt');
  });

  check('消息只在批次 user message 出现一次，且按说话人标注（不把自己标成"我"）', () => {
    // 入站事件的 self_id 就是本 bot 账号，早期用 e.selfId 判"我"会把别人的话标成"我：…"。
    assert.ok(!/我：hub 你在吗/.test(followup), `批次把自己收到的消息标成了"我"：\n${followup}`);
    assert.match(followup, /小明(?:\(member\))?：hub 你在吗/);
    const hits = followup.split('hub 你在吗').length - 1;
    assert.equal(hits, 1, `"hub 你在吗" 在批次里出现 ${hits} 次（镜像重复注入=真机事故 #3）：\n${followup}`);
  });

  check('用户消息只放本批新消息（不再把整份上下文塞进转录）', () => {
    assert.match(followup, /【新消息 1 条】会话 group:55555/);
    assert.match(followup, /hub 你在吗/);
    // 批头有绝对日期还不够（那是"凑批时刻"）：消息行自己也要带日期时间（m34049），
    // 否则跨天时模型分不清"08:12 那条"是今天还是昨天。
    assert.match(followup, /^-\s*\d{2}-\d{2} \d{2}:\d{2} .*hub 你在吗$/m, `新消息行没带日期时间：\n${followup}`);
    assert.match(followup, /【新消息 1 条】会话 group:55555｜现在 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '批头保留完整时间戳');
    assert.ok(!followup.includes('【会话卡】'), `用户消息里不该再有会话卡：\n${followup}`);
    assert.ok(followup.length < live.length, `用户消息应当明显短于整份上下文（${followup.length} vs ${live.length}）`);
  });

  /**
   * 用户实测："下游bot发的消息没能进入会话"。v4 后它**走批次进转录**（live 快照里已没有
   * 最近窗口），对 live 快照的要求反过来：不许有下游消息/枢纽内部账的残留，
   * 也不许有 `下游 bot：` 这种**空行**（那是枢纽自己的账 `linkId: agent:memory`）。
   * 另外：它**入批**（v4 起休眠期也入）但**不自己叫醒模型**（"下游已应答 → 保持沉默"不变）。
   */
  hub.timeline.record({
    direction: 'downstream-in',
    linkId: 'down:30001000',
    action: 'send_msg',
    decision: 'relay',
    text: '🎉 抓到新猪【猪利猪】！',
    refs: { sessionKey: 'group:55555', downstreamLabel: '127.0.0.1:8080' },
  });
  hub.timeline.record({ direction: 'hub-in', linkId: 'agent:memory', action: 'onebot_memory', decision: 'applied', refs: { sessionKey: 'group:55555' } });
  const live2 = mind.liveContext('group:55555');
  check('live 快照里没有下游消息与枢纽内部账（v4：消息只走批次）', () => {
    assert.equal(live2.includes('抓到新猪'), false, `下游消息不该再进 live 快照（走批次）：\n${live2}`);
    assert.equal(/下游 bot：\s*$/m.test(live2), false, `不该有"下游 bot："空行：\n${live2}`);
    assert.equal(live2.includes('agent:memory'), false, `枢纽自己的账不该进会话上下文：\n${live2}`);
  });

  const wokenBefore = mind.stats.woken;
  mind.noteDownstreamSend({ sessionKey: 'group:55555', action: 'send_msg', text: '🎉 抓到新猪【猪利猪】！', label: '127.0.0.1:8080' });
  check('下游消息入批但不自己叫醒模型（"下游已应答 → 保持沉默"不变）', () => {
    assert.equal(mind.stats.woken, wokenBefore, '下游消息不该自己叫醒模型');
    const pending = mind.statsSnapshot.batches.find((b) => b.sessionKey === 'group:55555');
    assert.ok(pending && pending.pending >= 1, `下游消息没进批量窗口：${JSON.stringify(mind.statsSnapshot.batches)}`);
  });

  // 心跳/通知这类非消息事件：时间线照记，但绝不能唤醒 agent（实测线上每条 meta_event 白跑一轮）。
  const heartbeat = {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
    interval: 60000,
  };
  hub.handleUpstreamEvent(heartbeat);
  await mind.tick(Date.now() + 120000);
  check('心跳不唤醒、不入批量窗口，窗口到期也不叫人', () => {
    const snap = mind.statsSnapshot;
    assert.ok(
      !snap.batches.some((b) => b.sessionKey === 'other:meta_event'),
      `心跳不该进批量窗口：${JSON.stringify(snap.batches)}`,
    );
    assert.equal(created.get('other:meta_event'), undefined, '心跳不该创建会话');
  });

  check('回复经 send_msg 出站，参数按会话摊平', () => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'send_msg');
    assert.equal(sent[0].params.message_type, 'group');
    assert.equal(sent[0].params.group_id, 55555);
    assert.equal(sent[0].params.message[0].data.text, '在的，你说');
  });

  const entries = hub.timeline.bySession('group:55555');
  check('时间线记下 hub-out 出站帧', () => {
    const out = entries.filter((e) => e.direction === 'hub-out');
    assert.equal(out.length, 1);
    assert.equal(out[0].action, 'send_msg');
    assert.equal(out[0].decision, 'sent');
  });
  return { hub, mind, pool, store, audit };
}

// ------------------------------------------------------------------ 场景二：命令静默

async function scenarioSilence() {
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.hooks.onDownstreamSend = (info) => mind.noteDownstreamSend(info);

  hub.handleUpstreamEvent(groupMessage({ groupId: 77777, messageId: 40010, text: '/help' }));
  mind.noteDownstreamSend({ sessionKey: 'group:77777', action: 'send_msg' });
  const flushed = await mind.flush('group:77777', { reason: 'test:manual' });

  check('下游已应答 → 硬静默，不唤醒也不发言', () => {
    assert.equal(flushed.woke, false);
    assert.equal(flushed.reason, 'silent:downstream-responded');
    assert.equal(created.size, 0);
    assert.equal(sent.length, 0);
  });

  // 静默判定要看"本轮"：更早的应答不该压住新消息
  check('跨轮次的旧应答不永久静默（按 openedAt 判定）', () => {
    assert.equal(mind.isDownstreamResponded('group:77777'), true);
    assert.equal(mind.isDownstreamResponded('group:77777', Date.now() + 1000), false);
  });
}

// ------------------------------------------------------------------ 场景三：休眠 / 激活状态机（assist）

async function scenarioBatchTimeout() {
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 5000, awakeMs: 300000, activeTickMs: 300000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  // 休眠期：普通群消息**只记录**（进窗口），不叫模型；窗口到期也不叫——assist 只认"被叫到"。
  hub.handleUpstreamEvent(groupMessage({ groupId: 88888, messageId: 40020, text: '攒着' }));
  const early = await mind.tick(Date.now());
  check('assist 休眠：普通群消息只记录不唤醒', () => {
    assert.equal(early.flushed.length, 0);
    assert.equal(created.size, 0);
    assert.equal(mind.wakeStateOf('group:88888').state, 'dormant');
    assert.equal(mind.stats.woken, 0);
  });

  const late = await mind.tick(Date.now() + 600000);
  check('assist 休眠：窗口到期也不唤醒（平时就是不说话）', () => {
    assert.equal(late.flushed.length, 0);
    assert.equal(created.size, 0, '休眠态不该因为窗口到期就烧一轮模型');
  });

  // 被 @ → 立刻醒并进入激活；休眠期攒下的消息本来就是同一条时间线，一起给模型看
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 88888,
      messageId: 40021,
      text: '@hub 在吗',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('assist：被 @ 立刻唤醒并进入激活态', () => {
    assert.equal(mind.wakeStateOf('group:88888').state, 'awake');
    assert.equal(created.size, 1, '被叫到就该真的叫模型');
    assert.equal(mind.stats.woken, 1);
  });

  // 激活态：再来的普通消息不再"等被叫"，攒够 batchSize 或窗口到 batchMs 就再唤醒一次
  hub.handleUpstreamEvent(groupMessage({ groupId: 88888, messageId: 40022, text: '继续说' }));
  const pending = await mind.tick(Date.now());
  check('激活态：窗口没到不唤醒', () => {
    assert.equal(pending.flushed.length, 0);
    assert.equal(mind.stats.woken, 1);
  });
  const again = await mind.tick(Date.now() + 6000);
  check('激活态：窗口到期再唤醒一次（这就是"一直聊着"）', () => {
    assert.equal(again.flushed.length, 1);
    assert.equal(again.flushed[0].woke, true);
    assert.equal(again.flushed[0].reason, 'batch:timeout');
    assert.equal(mind.stats.woken, 2);
  });
  check('没有 onebot_reply 候选时不凭空发言', () => {
    assert.equal(sent.length, 0);
  });

  // 上面两轮都没开口 → 连续 2 轮沉默，这一轮结束时就该回休眠
  const st = mind.wakeStateOf('group:88888');
  check('连续 2 轮没说话 → 回休眠（可解释、有计数）', () => {
    assert.equal(st.state, 'dormant', `连沉默两轮后应回休眠：${JSON.stringify(st)}`);
    assert.ok(mind.stats.dormant >= 1);
  });

  // 激活结束 = 先落盘、再交还会话（用户定案）：dispose 之后请宿主把这个会话的转录清掉。
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('激活结束交还会话：回休眠时 dispose 并请宿主清空转录（清旧账）', () => {
    assert.ok(pool.stats.retired >= 1, `pool 没记录 retire：${JSON.stringify(pool.stats)}`);
    assert.equal(pool.stats.lastRetire?.agentKey, 'group:88888');
    assert.ok(mind.stats.retired >= 1, 'mind 没记"激活结束交还"的次数');
    assert.ok(pool.stats.disposed >= 1, 'retire 必须先 dispose（否则会话写句柄不放，下一轮 create 会撞）');
  });

  // 休眠之后又有人 @ 我 → 重新进激活（状态机不是一次性开关）
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 88888,
      messageId: 40023,
      text: '@hub 再来',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 再来' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('回休眠之后再被叫到 → 重新进激活', () => {
    assert.equal(mind.wakeStateOf('group:88888').state, 'awake');
    assert.equal(mind.stats.awakened >= 2, true);
  });

  /**
   * 下游 bot 说的话也要**进会话**（用户实测："下游bot发的消息没能进入会话"）：
   * 激活态下把它推进批量窗口——下一次唤醒的"本批新消息"里就会带上它（`下游→<名字>：…`）；
   * 但它**不能自己叫醒模型**（"下游已应答 → 保持沉默"这条硬约束不变）。
   */
  const wokenBeforeDownstream = mind.stats.woken;
  mind.noteDownstreamSend({ sessionKey: 'group:88888', action: 'send_msg', text: '🎉 抓到新猪【猪利猪】！', label: '127.0.0.1:8080' });
  check('下游消息进本批（激活态），但不自己叫醒模型', () => {
    const pending = mind.statsSnapshot.batches.find((b) => b.sessionKey === 'group:88888');
    assert.ok(pending && pending.pending >= 1, `下游消息没进批量窗口：${JSON.stringify(mind.statsSnapshot.batches)}`);
    assert.equal(mind.stats.woken, wokenBeforeDownstream, '下游消息不该自己叫醒模型');
  });

  // 下一批真正唤醒时它要出现在"本批新消息"里（`下游→<人话名字>`）——真机 16:12 那轮缺的就是这个（v4）。
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 88888,
      messageId: 40024,
      text: '@hub 补充',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 补充' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const withDownstream = created.get('group:88888').followups.at(-1).content.map((p) => p.text ?? '').join('');
  check('下游消息随下一批进会话带人话名字，开局快照只给一次（v4）', () => {
    assert.match(withDownstream, /【新消息 2 条】/, `本批=下游回应+@补充：\n${withDownstream}`);
    assert.match(withDownstream, /下游→127\.0\.0\.1:8080：🎉 抓到新猪/, `下游消息没进批次：\n${withDownstream}`);
    assert.ok(!withDownstream.includes('【开局快照】'), '开局快照每段会话只给一次，第二批不许再给');
  });
}

// ------------------------------------------------------------------ 场景二之二：静默闸不该永久压死会话（真机事故 #10）

/**
 * v4（`m26571` 用户看日志发现）：同一件事在【开局快照】和【新消息】里各出现一次，
 * 而且**快照那条更详细**（带 `[图片：…]`）、新消息那条只有 `[回复][图片]`。两个独立根因：
 *   · 下游批次条目只快照了一份 `text`，而看图描述/媒体引用是**异步**回填到时间线真身上的
 *     （`hub.#enrichImages` 之后还会 `cards.patch`）→ 批次永远停在占位符，比快照还糙；
 *   · 开局快照的"重启后回退"分支**只按正文去重**：卡行明明带着 id（= 时间线 id）却没比，
 *     而两边正文本来就不同（`↩回复「…」[图片：描述]（已存为 hub-media:…）` vs `[回复][图片]`）。
 */
async function scenarioBatchRichText() {
  const { hub } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  // 下游 bot 发了一条带图的消息：真身上先记的是发送瞬间的文本。
  const entry = hub.timeline.record({
    direction: 'downstream-in',
    linkId: 'down:30001000',
    event: groupMessage({ groupId: 55555, messageId: 90001, text: '[回复][图片]' }),
    decision: 'transparent',
  });
  const real = entry?.text ? entry : hub.timeline.recent(1)[0];
  mind.noteDownstreamSend({
    sessionKey: 'group:55555',
    action: 'send_msg',
    text: '[回复][图片]',
    label: '127.0.0.1:8080',
    timelineId: real?.id,
    entry: real,
  });
  // 看图是异步旁路：描述这时才回填到真身（真机上就是这几毫秒的差别）。
  if (real) real.text = '↩回复「/猪猪图鉴」 [回复][图片：一只橘猫趴在窗台上。]（已存为 hub-media:6040b31ddccf）';
  // 再来一条 @hub 的消息把这一批叫醒（下游那条自己不会叫醒模型——那是硬约束）。
  hub.handleUpstreamEvent(groupMessage({
    groupId: 55555,
    messageId: 90003,
    text: '@hub 这个图是啥',
    segments: [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ' 这个图是啥' } },
    ],
  }));

  // 被 @ 到会当场唤醒并结算这一批（不需要再手动 flush），等它跑完。
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = created.get('group:55555')?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('新消息带图片描述：批次读的是时间线真身，不是发送瞬间的占位符（m26571）', () => {
    assert.ok(text, '这一批没喂给 agent');
    assert.match(text, /【新消息 2 条】/, `本批应含下游回应与 @hub：\n${text}`);
    assert.match(text, /图片：一只橘猫趴在窗台上/, `本批还是占位符，没拿到看图描述：\n${text}`);
  });

  // 第二段：开局快照的卡行去重。卡里那条带着 id，正文与批次那条**不一致**（模拟描述晚到）。
  const { hub: hub2 } = makeHub();
  const policy2 = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host: host2, created: created2 } = makeFakeHost({ script: async () => {} });
  const pool2 = new AgentPool({ policy: policy2, host: host2, log: () => {} });
  const mind2 = new Mind({ hub: hub2, timeline: hub2.timeline, store: new MemoryStore({}), policy: policy2, pool: pool2, log: () => {} });
  hub2.hooks.onUpstreamEvent = (entry, info) => mind2.observe(entry, info);
  hub2.cards.note({
    id: 't-90002',
    direction: 'downstream-in',
    sessionKey: 'group:55555',
    actor: { nickname: '127.0.0.1:8080' },
    text: '↩回复「/猪猪图鉴」 [图片：一只橘猫趴在窗台上。]（已存为 hub-media:6040b31ddccf）',
    ts: Date.now(),
  });
  mind2.noteDownstreamSend({
    sessionKey: 'group:55555',
    action: 'send_msg',
    text: '[回复][图片]',
    label: '127.0.0.1:8080',
    timelineId: 't-90002',
  });
  hub2.handleUpstreamEvent(groupMessage({
    groupId: 55555,
    messageId: 90004,
    text: '@hub 这个图是啥',
    segments: [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ' 这个图是啥' } },
    ],
  }));
  // 被 @ 到会当场唤醒并结算这一批，等它跑完。
  await new Promise((resolve) => setTimeout(resolve, 60));
  const opening = created2.get('group:55555')?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('开局快照按 id 去重：同一条话不会在快照和新消息里各出现一次（m26571）', () => {
    assert.ok(opening, '这一批没喂给 agent');
    assert.match(opening, /下游→127\.0\.0\.1:8080：\[回复\]\[图片\]/, `本批缺下游那句话：\n${opening}`);
    assert.ok(!opening.includes('橘猫'), `快照里又出现了一次同一条事实：\n${opening}`);
    assert.ok(!opening.includes('猪猪图鉴'), `快照里又出现了一次同一条事实：\n${opening}`);
  });
}

async function scenarioDownstreamForward() {
  // m28267/m29922：下游 bot 回**合并转发**（`send_group_forward_msg`，内容在 `params.messages`
  // 的 node 数组里）——之前只认 `params.message`，整条提不出文本，空 body 被批次挡掉。现在走
  // `segmentsFromParams` 共享入口：与群友聊天记录**同待遇**，只给占位不展开内容；agent 要看
  // 就自己 `onebot_raw` 取原文（params.messages 原样留在时间线）。
  const { hub } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.hooks.onDownstreamSend = (info) => mind.noteDownstreamSend(info);

  const frame = {
    action: 'send_group_forward_msg',
    echo: 'fwd-1',
    params: {
      group_id: 55555,
      messages: [
        { type: 'node', data: { name: '搜猪小助手', uin: 3371846367, content: [
          { type: 'text', data: { text: '岀猪车' } },
          { type: 'image', data: { file: 'https://pighub.example/images/a.png' } },
        ] } },
        { type: 'node', data: { name: '搜猪小助手', uin: 3371846367, content: [
          { type: 'text', data: { text: '猪溜达(倒车)' } },
        ] } },
        // 引用型节点（`data.id` 指向已有消息，没有 content）：不该炸，照进条数。
        { type: 'node', data: { id: '49001' } },
      ],
    },
  };
  await hub.handleDownstreamFrame({ linkId: 'down:30001000', selfId: 30001000 }, frame);
  check('下游合并转发只给占位不展开（m29922：与群友聊天记录同待遇）', () => {
    const rows = hub.timeline.bySession('group:55555').filter((e) => e.direction === 'downstream-in');
    const last = rows.at(-1);
    assert.ok(last, '时间线里没有下游动作');
    assert.equal(last.action, 'send_group_forward_msg');
    assert.equal(last.text, '[合并转发 3 条：内容未展开]', `提文本失败：${JSON.stringify(last.text)}`);
    // 原文不丢：payload（= params 的克隆）里 messages 原样留在时间线（agent 的 onebot_raw 就靠它）。
    assert.equal(last.payload?.messages?.length, 3, 'params.messages 原文得留在时间线');
  });

  // 转发应答要进【新消息】批次（下游应答自己不叫醒模型——硬约束，用一条 @hub 收尾）。
  hub.handleUpstreamEvent(groupMessage({
    groupId: 55555,
    messageId: 91001,
    text: '@hub 猪车是什么',
    segments: [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ' 猪车是什么' } },
    ],
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = created.get('group:55555')?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('下游合并转发进【新消息】批次（占位，内容不摊进去）', () => {
    assert.ok(text, '这一批没喂给 agent');
    assert.match(text, /【新消息 2 条】/, `本批应含下游转发应答与 @hub：\n${text}`);
    assert.match(text, /\[合并转发 3 条：内容未展开\]/, `批次缺下游合并转发的占位：\n${text}`);
    assert.ok(!text.includes('岀猪车'), `节点内容不该摊进批次：\n${text}`);
    assert.ok(!/下游[^：\n]*：\s*\n/.test(text), `批次里不该有空文本的下游行：\n${text}`);
  });
}

async function scenarioSilenceLookback() {
  // 真机现场：用户 @ 了枢纽，枢纽一声不吭。`agents.woken: 0`、`batches.pending: 7`、
  // `wakeStates.state: dormant`。根因是"下游已应答 → 硬静默"这道闸拿**休眠窗口的 openedAt**
  // 当判据：休眠窗口永远不会 flush，于是只要那之后有过任何一次下游应答，这个会话就被永久静默。
  const { hub } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.hooks.onDownstreamSend = (info) => mind.noteDownstreamSend(info);

  // ① 纯函数层：被叫到优先于静默闸
  const calledWake = shouldWake({
    policy: resolveAgentPolicy({ mode: 'assist' }),
    entry: { sessionKey: 'group:1', kind: 'group_message', text: '@我 在吗' },
    event: { post_type: 'message', message_type: 'group', raw_message: '@我 在吗' },
    batch: { count: 1, shouldFlush: () => ({ flush: false, reason: 'batch:pending' }) },
    mentions: ['at'],
    downstreamResponded: true,
    wakeState: { state: 'dormant' },
  });
  check('静默闸·优先级：被 @ 时"下游已应答"不许挡（人家点名找我）', () => {
    assert.equal(calledWake.wake, true);
    assert.equal(calledWake.reason, 'mentioned:at');
  });

  // ② 端到端：休眠期攒了消息、窗口开着很久、刚有下游应答 → @ 我照样醒
  for (let i = 0; i < 3; i += 1) {
    hub.handleUpstreamEvent(groupMessage({ groupId: 66666, messageId: 40200 + i, text: `闲聊 ${i}` }));
  }
  mind.noteDownstreamSend({ sessionKey: 'group:66666', action: 'send_msg', ts: Date.now() });
  const before = mind.stats.woken;
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 66666,
      messageId: 40210,
      text: '@test 帮我查一下',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 帮我查一下' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('静默闸·真机复现：休眠期攒了消息、刚有下游应答，@ 我仍然唤醒', () => {
    assert.equal(mind.stats.woken, before + 1, `应当唤醒一次：${JSON.stringify(mind.statsSnapshot.lastObserve)}`);
    assert.equal(created.size >= 1, true);
    assert.equal(mind.wakeStateOf('group:66666').state, 'awake');
  });
  check('静默闸·诊断：lastObserve 把"为什么醒/为什么没醒"记下来', () => {
    const last = mind.statsSnapshot.lastObserve;
    assert.equal(last.sessionKey, 'group:66666');
    assert.deepEqual(last.mentions, ['at']);
    assert.equal(last.wake, true);
    assert.match(String(last.text), /帮我查一下/);
  });

  // ③ 普通消息 + 同一轮里的下游应答：静默照旧（这条不能一起放开）
  hub.handleUpstreamEvent(groupMessage({ groupId: 66666, messageId: 40211, text: '随便说说' }));
  mind.noteDownstreamSend({ sessionKey: 'group:66666', action: 'send_msg', ts: Date.now() });
  const silenced = await mind.flush('group:66666', { reason: 'test:manual' });
  check('静默闸·不能一起放开：没有人在叫我时，下游刚答过就不说话', () => {
    assert.equal(silenced.woke, false);
    assert.equal(silenced.reason, 'silent:downstream-responded');
  });

  // ④ 回看有界：几秒内的应答压得住，几分钟前的陈年老账不压（休眠窗口的 openedAt 可能很旧）
  const activeHub = makeHub();
  const activePolicy = resolveAgentPolicy({ mode: 'active', batchSize: 6, batchMs: 8000, activeTickMs: 1000 });
  const activeHost = makeFakeHost({ script: async () => {} });
  const activePool = new AgentPool({ policy: activePolicy, host: activeHost.host, log: () => {} });
  const activeMind = new Mind({
    hub: activeHub.hub,
    timeline: activeHub.hub.timeline,
    store: new MemoryStore({}),
    policy: activePolicy,
    pool: activePool,
    log: () => {},
  });
  activeHub.hub.hooks.onUpstreamEvent = (entry, info) => activeMind.observe(entry, info);

  activeHub.hub.handleUpstreamEvent(groupMessage({ groupId: 55556, messageId: 40300, text: '有人吗' }));
  activeMind.noteDownstreamSend({ sessionKey: 'group:55556', action: 'send_msg', ts: Date.now() - 600000 });
  const ticked = await activeMind.tick(Date.now() + 2000);
  check('静默闸·陈年应答不算：十分钟前的下游应答不该压住 active 的节拍唤醒', () => {
    assert.equal(ticked.flushed.length, 1, `应当唤醒一次：${JSON.stringify(ticked)}`);
    assert.equal(ticked.flushed[0].reason, 'tick:active');
  });

  activeHub.hub.handleUpstreamEvent(groupMessage({ groupId: 55557, messageId: 40301, text: '有人吗' }));
  activeMind.noteDownstreamSend({ sessionKey: 'group:55557', action: 'send_msg', ts: Date.now() });
  const stillSilent = await activeMind.tick(Date.now() + 2000);
  check('静默闸·刚刚的应答仍然算数：active 节拍被它压住', () => {
    assert.equal(stillSilent.flushed.length, 0);
  });
}

// ------------------------------------------------------------------ 场景二之三：@ 我 却没醒（真机事故 #11）

async function scenarioMentionIdentity() {
  // 真机现场：群里 `@test 帮我查一下今日小猪`，hub 一声不吭；`agents.lastObserve.mentions: []`、
  // `reason: 'dormant'`。两个独立原因叠在一起：
  //  ① 配置没写 `upstreamSelfId`（账号从握手里学到），而 `Mind.selfId` 只认配置 → 空账号，
  //     at 段比对恒假；
  //  ② 配置写了 `upstreamNickname: 'dsh-hub'`（内部备注名），于是 get_login_info 学到的真昵称
  //     `test` 被那行 `if (!config.upstreamNickname)` 挡在门外 → 手打的 `@test` 也匹配不上。
  const { hub } = makeHub({ upstreamSelfId: '' });
  hub.learnUpstreamAccount('30001000', 'handshake');

  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 8000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  hub.config.nickname = 'dsh-hub';
  hub.config.upstreamNickname = 'dsh-hub';
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  check('身份·账号兜底：配置没写 upstreamSelfId 时，"我是谁"取学到的账号', () => {
    assert.equal(mind.liveSelfId, '30001000');
    assert.deepEqual(mind.identity().nicknames, ['dsh-hub']);
  });

  check('身份·昵称是累加的：学到真昵称之后，备注名不丢', () => {
    const id = mind.setIdentity({ nickname: 'test' });
    assert.deepEqual(id.nicknames.sort(), ['dsh-hub', 'test']);
    assert.equal(mind.liveSelfId, '30001000');
  });

  /**
   * 真机回归（用户"试了一下"的现场）：`agents.identity.nicknames` 是**空集**，
   * 而 `capability.impl.nickname` 明明是 `test`——账号早在握手里学到了，于是
   * `learnUpstreamAccount` 走 `reason: 'known'` 直接返回，**昵称那一路被整段跳过**；
   * 再加上 `index.js` 的身份探测读的是信封（`{status, retcode, data}`）而不是 `data`，
   * `info.user_id` 恒 undefined → 真昵称永远学不到 → 手打 `@真昵称` 叫不醒。
   */
  check('身份·账号已在、昵称后到：hook 必须把后到的昵称也传下去（真机 bug）', () => {
    hub.hooks.onUpstreamAccount = ({ selfId, nickname }) => mind.setIdentity({ selfId, nickname });
    const before = mind.identity().nicknames.length;
    const r = hub.learnUpstreamAccount('30001000', 'get_login_info', 'test2');
    assert.equal(r.reason, 'known', '账号没变（这正是当初漏掉昵称的原因）');
    assert.ok(mind.identity().nicknames.includes('test2'), `昵称没传到判定层：${JSON.stringify(mind.identity())}`);
    assert.ok(mind.identity().nicknames.length > before);
  });

  // at 段的两种写法都要认（`qq` 是 v11 的写法，`user_id` 是某些实现端的写法）；@全体成员不算叫我。
  const { detectMention, atTargetsOf } = await import('../lib/agent/policy.js');
  check('身份·at 段：`user_id` 写法也认，@全体成员不认', () => {
    const byQq = detectMention({ message: [{ type: 'at', data: { qq: '30001000' } }] }, { selfId: '30001000' });
    const byUserId = detectMention({ message: [{ type: 'at', data: { user_id: 30001000 } }] }, { selfId: '30001000' });
    const all = detectMention({ message: [{ type: 'at', data: { qq: 'all' } }] }, { selfId: '30001000' });
    assert.deepEqual(byQq, ['at']);
    assert.deepEqual(byUserId, ['at']);
    assert.deepEqual(all, []);
    assert.deepEqual(atTargetsOf({ message: [{ type: 'at', data: { qq: 'all' } }, { type: 'at', data: { user_id: 7 } }] }), ['all', '7']);
  });

  /**
   * `m02678` 用户定案：**只认 @ 与回复引用，纯文本昵称完全不唤醒**。
   *
   * 以前这里走的是"文本里出现昵称（含备注名/学到的真昵称）也算被叫到"，但上游账号昵称就是
   * `test`——`latest`、`contest`、`npm test` 里都含它，就算加词边界，`npm test` 这种独立词
   * 照样唤醒；误唤醒的代价是整轮模型被叫起来说话。所以这条路整个删掉：名字只留在身份展示里。
   */
  check('身份·纯文本昵称**不再**唤醒（只认 @ 与回复引用）', () => {
    const hit = detectMention(
      { raw_message: '@test 帮我查一下', message: [{ type: 'text', data: { text: '@test 帮我查一下' } }] },
      { selfId: '30001000', nickname: 'dsh-hub', nicknames: ['dsh-hub', 'test'] },
    );
    assert.deepEqual(hit, [], '文本里出现昵称不该再唤醒（误命中 latest/npm test 的代价太大）');
    const at = detectMention(
      { raw_message: '@dsh-hub 在吗', message: [{ type: 'at', data: { qq: '30001000' } }] },
      { selfId: '30001000', nickname: 'dsh-hub', nicknames: ['dsh-hub'] },
    );
    assert.deepEqual(at, ['at'], '@ 仍然要唤醒');
  });

  // 端到端：空 upstreamSelfId 的真机形状 —— @ 段指向学到的账号，必须唤醒。
  const before = mind.stats.woken;
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 66777,
      messageId: 40400,
      text: '@test 帮我查一下今日小猪',
      segments: [
        { type: 'at', data: { qq: '30001000' } },
        { type: 'text', data: { text: ' 帮我查一下今日小猪' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('身份·真机复现：配置没写账号 + @ 我 → 必须唤醒（mentions 不许为空）', () => {
    const last = mind.statsSnapshot.lastObserve;
    assert.equal(last.mentions.includes('at'), true, `mentions 应当含 at：${JSON.stringify(last)}`);
    assert.equal(last.selfId, '30001000');
    assert.deepEqual(last.atTargets, ['30001000']);
    assert.equal(mind.stats.woken, before + 1, `应当唤醒一次：${JSON.stringify(last)}`);
    assert.equal(created.size >= 1, true);
  });
}

// ------------------------------------------------------------------ 场景三之二：active 节拍 + 激活空转超时

async function scenarioActiveTick() {
  const { hub } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'active', batchSize: 6, batchMs: 5000, awakeMs: 60000, activeTickMs: 300000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  // active 不再是"每条都醒"：普通消息只进窗口，等节拍判断
  hub.handleUpstreamEvent(groupMessage({ groupId: 99999, messageId: 40030, text: '有人吗' }));
  check('active 休眠：普通消息不立刻唤醒（先攒着等节拍）', () => {
    assert.equal(created.size, 0);
    assert.equal(mind.wakeStateOf('group:99999').state, 'dormant');
  });

  const before = await mind.tick(Date.now() + 1000);
  check('active 休眠：没到节拍不唤醒', () => {
    assert.equal(before.flushed.length, 0);
    assert.equal(created.size, 0);
  });

  const due = await mind.tick(Date.now() + 300001);
  check('active 休眠：到节拍且窗口里有新消息 → 唤醒一次并进入激活', () => {
    assert.equal(due.flushed.length, 1);
    assert.equal(due.flushed[0].reason, 'tick:active');
    assert.equal(mind.wakeStateOf('group:99999').state, 'awake');
    assert.equal(mind.stats.woken, 1);
  });

  // 没有新消息时，节拍到了也不唤醒（窗口是空的）；但空转没到 awakeMs 就还是激活态
  const quiet = await mind.tick(Date.now() + 30000);
  check('active：没有新消息时，节拍到了也不叫模型（要么被叫，要么有新消息）', () => {
    assert.equal(quiet.flushed.length, 0);
    assert.equal(mind.stats.woken, 1);
    assert.equal(mind.wakeStateOf('group:99999').state, 'awake', '没到 awakeMs 不该提前睡回去');
  });

  const slept = await mind.tick(Date.now() + 120000);
  check('激活空转超过 awakeMs → 回休眠（不会永远挂着"激活"）', () => {
    assert.ok(slept.dormant.includes('group:99999'), JSON.stringify(slept.dormant));
    assert.equal(mind.wakeStateOf('group:99999').state, 'dormant');
    assert.ok(mind.stats.dormant >= 1);
  });

  // 被叫到：与 assist 相同——立刻醒，不等节拍
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 99999,
      messageId: 40031,
      text: '@hub 来',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 来' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('active：被叫到与 assist 相同（立刻醒，不等节拍）', () => {
    assert.equal(mind.wakeStateOf('group:99999').state, 'awake');
    assert.equal(mind.stats.woken, 2);
  });

  // —— 防误杀（m30055）：手头有在飞回合/排队唤醒时，空转到点也**顺延**，不把干活的 agent 连坐归档。
  // 实测：长思考 + 连环排查把回合拖过 awakeMs，归档时宿主 stopActivity 把在飞回合连同 subagent 一起掐了。
  {
    const agentKey = mind.agentKeyOf('group:99999');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    pool.enqueue(agentKey, () => gate);
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('pool.isBusy：排队/在飞的任务算忙', () => {
      assert.equal(pool.isBusy(agentKey), true);
    });
    const held = await mind.tick(Date.now() + 120000);
    check('空转超过 awakeMs 但 agent 忙 → 顺延不归档', () => {
      assert.equal(held.dormant.includes('group:99999'), false, JSON.stringify(held.dormant));
      assert.equal(mind.wakeStateOf('group:99999').state, 'awake');
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('pool.isBusy：活儿干完就不忙', () => {
      assert.equal(pool.isBusy(agentKey), false);
    });
    const late = await mind.tick(Date.now() + 120000);
    check('忙完之后空转超时 → 正常回休眠（守卫只顺延，不放飞）', () => {
      assert.ok(late.dormant.includes('group:99999'), JSON.stringify(late.dormant));
      assert.equal(mind.wakeStateOf('group:99999').state, 'dormant');
    });
  }

  // 私聊：每条都算被叫到 → 立刻醒（休眠不挡私聊）
  hub.handleUpstreamEvent({
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 40032,
    user_id: 10001,
    raw_message: '在吗',
    sender: { user_id: 10001, nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('私聊：每条都算被叫到 → 立刻醒', () => {
    assert.equal(mind.wakeStateOf('private:10001').state, 'awake');
    assert.equal(mind.stats.woken, 3);
  });
}

// ------------------------------------------------------------------ 场景三点二：回完话再等 awakeMs 才休眠（m34646）

/**
 * 用户原话：「active模式唤醒的激活状态在agent回复完后就回到休眠了，应该把激活状态改成
 * agent回复完后等待agent.awakeMs后再休眠。」
 *
 * 旧的空转基准是"最后一条**入站消息**"。`active` 档下这个基准错得很明显：消息先到、批量窗口
 * 与 active 节拍再拖一会儿才唤醒、模型再想一会儿才答完——等它把话发出去，`awakeMs` 的额度
 * 早就烧掉大半，于是"刚回完话就睡回去"，会话被归档交还，下一条消息又得从头开局快照。
 *
 * 现在基准取 `max(最后一条消息, 最后一个回合结束)`。用例不靠 sleep 猜时间：`#expireAwake(now)`
 * 收 `now`，而 `lastTurnAt` 就在状态里，所以断言可以钉在精确的边界两侧（awakeMs±50ms），
 * 唯一真实的等待只有"这一轮要想多久"。
 */
async function scenarioAwakeGraceAfterReply() {
  const groupId = 777400;
  const sessionKey = `group:${groupId}`;
  const AWAKE_MS = 600;
  const THINK_MS = 700; // 这一轮"想"多久：比 awakeMs 还长，才拉得开两个基准
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(10);
    }
    return false;
  };

  const { hub } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'active', batchSize: 6, batchMs: 5000, awakeMs: AWAKE_MS, activeTickMs: 300000 });
  let turns = 0;
  const { host } = makeFakeHost({
    script: async (agent) => {
      turns += 1;
      if (turns > 1) return; // 第二轮故意沉默，见末尾用例
      await sleep(THINK_MS);
      await agent.tools.get('onebot_reply').execute({ text: '在的' });
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, setup: (agentCtx, { reply }) => {
    agentCtx.tools?.register?.({
      name: 'onebot_reply',
      async execute(args = {}) {
        const candidate = reply.capture({ text: args.text });
        return candidate ? `queued:${candidate.text}` : 'empty';
      },
    });
  } });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  const ping = (messageId, text) => hub.handleUpstreamEvent(groupMessage({
    groupId,
    messageId,
    text,
    segments: [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  }));

  ping(61001, '在吗');
  await until(() => mind.wakeStateOf(sessionKey)?.lastTurnAt > 0);
  const st = mind.wakeStateOf(sessionKey);

  check('回完话把这一轮的结束时刻记进 lastTurnAt（诊断里看得到）', () => {
    assert.equal(st.state, 'awake');
    assert.equal(
      mind.stats.lastTurn?.hadReply,
      true,
      `这一轮应该真的回话了，否则后面全是空中楼阁：${JSON.stringify(mind.stats.lastTurn?.diag)}`,
    );
    assert.equal(st.silentTurns, 0, '回过话就不该记沉默轮');
    assert.ok(st.lastTurnAt > 0, JSON.stringify(st));
    assert.ok(
      st.lastTurnAt - st.lastMsgAt >= THINK_MS - 100,
      `回合结束该明显晚于消息到达，两个基准才拉得开：实际 ${st.lastTurnAt - st.lastMsgAt}ms`,
    );
  });

  const base = st.lastTurnAt;
  const early = await mind.tick(base + 100);
  check('回复完 100ms：仍然是激活（换旧基准此刻早就睡回去了）', () => {
    assert.equal(early.dormant.length, 0, JSON.stringify(early.dormant));
    assert.equal(mind.wakeStateOf(sessionKey).state, 'awake');
    assert.equal(mind.stats.retired ?? 0, 0, '不该在这期间把会话归档交还');
  });

  const justUnder = await mind.tick(base + AWAKE_MS - 50);
  check('离 awakeMs 只差 50ms：还醒着（边界内侧不睡）', () => {
    assert.equal(justUnder.dormant.length, 0, JSON.stringify(justUnder.dormant));
    assert.equal(mind.wakeStateOf(sessionKey).state, 'awake');
  });

  const over = await mind.tick(base + AWAKE_MS + 50);
  check('回合结束后超过 awakeMs 仍没动静 → 才回休眠', () => {
    assert.ok(over.dormant.includes(sessionKey), JSON.stringify(over.dormant));
    assert.equal(mind.wakeStateOf(sessionKey).state, 'dormant');
    assert.ok((mind.stats.retired ?? 0) >= 1, '回休眠要把会话交还');
  });

  // 交还是 fire-and-forget（`#retireAfterDormant` 不 await）：先把归档等完再让下一轮 @ 进来，
  // 否则新回合会和归档抢同一个 agentKey，偶发地"叫不醒"（第一版就踩到过）。
  await until(() => !pool.isBusy(mind.agentKeyOf(sessionKey)));
  await sleep(30);

  // 沉默的一轮也是"动静"：模型被叫来了、想过了、选择不开口——那不是会话空转。
  ping(61002, '还有别的吗');
  await until(() => mind.wakeStateOf(sessionKey)?.state === 'awake');
  await until(() => (mind.wakeStateOf(sessionKey)?.silentTurns ?? 0) >= 1 && (mind.wakeStateOf(sessionKey)?.lastTurnAt ?? 0) > base);
  const silent = mind.wakeStateOf(sessionKey);
  check('沉默的一轮同样刷新 lastTurnAt（不开口 ≠ 会话空转）', () => {
    assert.equal(silent.silentTurns, 1, JSON.stringify(silent));
    assert.ok(silent.lastTurnAt > base, `沉默回合也要续期：${silent.lastTurnAt} vs ${base}`);
  });
  const held = await mind.tick(silent.lastTurnAt + AWAKE_MS - 50);
  check('沉默回合之后再等满 awakeMs 之前也不睡', () => {
    assert.equal(held.dormant.length, 0, JSON.stringify(held.dormant));
    assert.equal(mind.wakeStateOf(sessionKey).state, 'awake');
  });
}

// ------------------------------------------------------------------ 场景三点半：会话白名单（m31030）

async function scenarioWhitelistGate() {
  const { hub } = makeHub();
  // 白名单：55555 只准入（跟随全局）、77777 覆盖成 observer、私聊只放 10001；99999/20002 未列出。
  hub.config.agentGroups = { 55555: {}, 77777: { mode: 'observer' } };
  hub.config.agentPrivates = { 10001: {} };
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 6, batchMs: 5000, awakeMs: 300000, activeTickMs: 300000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  // 未列出的群：@ 也不理——不建窗口、不叫模型、诊断写明 unlisted。
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 99999,
      messageId: 40100,
      text: '@hub 白名单外',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 白名单外' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('白名单：未配置的群 @ 也不理（白名单制）', () => {
    assert.equal(created.size, 0, '不该为没配置的群烧一轮模型');
    assert.equal(mind.wakeStateOf('group:99999'), null);
    assert.equal(mind.stats.unlisted, 1);
    assert.equal(mind.lastObserve?.reason, 'unlisted', '为什么不醒要写明 unlisted');
    assert.equal(mind.statsSnapshot.whitelist.groups, 2);
    assert.equal(mind.statsSnapshot.whitelist.privates, 1);
  });

  // 未列出的私聊同理。
  hub.handleUpstreamEvent({
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 40101,
    user_id: 20002,
    raw_message: '在吗',
    sender: { user_id: 20002, nickname: '路人' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('白名单：未配置的私聊一样被闸住', () => {
    assert.equal(created.size, 0);
    assert.equal(mind.stats.unlisted, 2);
  });

  // 名单里覆盖成 observer 的群：@ 也不醒（observer 只看不说），但 reason 是 mode:observer。
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 77777,
      messageId: 40102,
      text: '@hub observer 群',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' observer 群' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('白名单：observer 覆盖优先于 @（只看不说）', () => {
    assert.equal(created.size, 0, 'observer 档 @ 也不叫模型');
    assert.equal(mind.lastObserve?.sessionKey, 'group:77777', '这条观察说的是当前这条消息');
    assert.equal(mind.lastObserve?.reason, 'mode:observer', '被挡的原因是分群覆盖的 mode');
  });

  // 名单内的群（跟随全局 assist）：被 @ → 照常唤醒。
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 55555,
      messageId: 40103,
      text: '@hub 名单内',
      segments: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 名单内' } },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('白名单：名单内的群照常被 @ 唤醒', () => {
    assert.equal(created.size, 1);
    assert.equal(mind.wakeStateOf('group:55555').state, 'awake');
    assert.equal(mind.stats.unlisted, 2, '白名单内的消息不计入 unlisted');
  });

  // 名单内的私聊：照常唤醒。
  hub.handleUpstreamEvent({
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 40104,
    user_id: 10001,
    raw_message: '在吗',
    sender: { user_id: 10001, nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('白名单：名单内的私聊照常唤醒', () => {
    assert.equal(created.size, 2);
    assert.equal(mind.wakeStateOf('private:10001').state, 'awake');
  });
}

// ------------------------------------------------------------------ 场景四：隔离级别

function scenarioIsolation() {
  const store = new MemoryStore({ limit: 100 });
  store.addMany([
    { kind: 'fact', scope: 'group:11111', visibility: 'shareable', text: '他在 11111 群里说自己养了猫' },
    { kind: 'fact', scope: 'group:11111', visibility: 'private', text: '他在 11111 群里说了自己的住址' },
    { kind: 'identity', scope: 'group:11111', visibility: 'shareable', text: '小明的 QQ 是 10001' },
    { kind: 'fact', scope: 'private:10001', visibility: 'private', text: '他私聊里说最近在换工作' },
  ]);

  const strict = resolveIsolation({ level: 'strict' });
  const scoped = resolveIsolation({ level: 'scoped' });
  const balanced = resolveIsolation({ level: 'balanced' });

  return { store, strict, scoped, balanced };
}

async function scenarioIsolationAssemble() {
  const { hub } = makeHub();
  const { store, strict, scoped, balanced } = scenarioIsolation();
  const audit = new IsolationAudit({ limit: 50 });
  const make = (isolation) =>
    new Mind({ hub, timeline: hub.timeline, store, isolation, audit, policy: resolveAgentPolicy({}), log: () => {} });

  const s1 = make(strict).snapshot('group:55555');
  const s2 = make(scoped).snapshot('group:55555');
  const s3 = make(balanced).snapshot('group:55555');

  check('strict：跨会话记忆一律不可见', () => {
    assert.equal(s1.memoryVisible, 0);
    assert.match(s1.text, /【来源】/);
    assert.ok(!s1.text.includes('【会话卡】'), 'v4：会话卡不再进快照');
    assert.ok(!s1.text.includes('养了猫'));
  });

  check('scoped：身份档案可见、他人群里的私事不可见、私聊内容不可见', () => {
    assert.ok(s2.text.includes('小明的 QQ 是 10001'), '身份应可见');
    assert.ok(!s2.text.includes('养了猫'), '别的群的 shareable 事实在 scoped 下不可见');
    assert.ok(!s2.text.includes('换工作'), '私聊内容不可见');
    assert.ok(s2.denied.length >= 3);
  });

  check('balanced：同批人的 shareable 事实可见，private 仍不可见', () => {
    assert.ok(s3.text.includes('养了猫'), 'balanced 放开 shareable');
    assert.ok(!s3.text.includes('住址'), 'private 事实在 balanced 下仍不可见');
    assert.ok(!s3.text.includes('换工作'));
  });

  check('审计账本记下放行与拦截的判定原因', () => {
    assert.ok(audit.stats.total > 0);
    const reasons = [...new Set(audit.list({ limit: 100 }).map((e) => e.reason))];
    assert.ok(reasons.length >= 2, `应有多样化的判定原因，实际 ${reasons.join(',')}`);
    assert.ok(reasons.some((r) => /crossGroup|level:|same-/.test(r)), `原因应可解释，实际 ${reasons.join(',')}`);
  });

  check('描述串包含级别与关键开关', () => {
    const desc = describeIsolation(scoped);
    assert.match(desc, /scoped/);
    assert.match(desc, /身份/);
  });

  check('跨群引用不带来源（prompt 里不出现别的群号）', () => {
    assert.ok(!s3.text.includes('group:11111'), '跨群条目不应暴露来源会话');
  });
}

// ------------------------------------------------------------------ 场景五：agent 池 LRU 与回收

async function scenarioPool() {
  const policy = resolveAgentPolicy({ mode: 'assist', maxActive: 2, idleDisposeMs: 1000 });
  const { host, created } = makeFakeHost({ script: async () => {} });
  const pool = new AgentPool({ policy, host, log: () => {} });

  await pool.wake('group:1', { text: 'a' });
  await pool.wake('group:2', { text: 'b' });
  await pool.wake('group:3', { text: 'c' });

  check('超出并发上限按 LRU 回收', () => {
    assert.equal(pool.size, 2);
    assert.equal(pool.stats.created, 3);
    assert.ok(pool.stats.disposed >= 1);
    assert.equal(created.get('group:1').disposed, true);
  });

  check('空闲回收', () => {
    const disposed = pool.disposeIdle(Date.now() + 5000);
    assert.equal(disposed.length, 2);
    assert.equal(pool.size, 0);
  });

  const bare = new AgentPool({ policy, host: { hasSession: null, create: null, resume: null }, log: () => {} });
  const bareResult = await bare.wake('group:9', { text: 'x' });
  check('宿主缺位时给出可诊断的错误', () => {
    assert.equal(bareResult.ok, false);
    assert.match(bareResult.error, /agent 通道未就绪/);
  });

  // 线上踩过：上一次进程留下的会话只有 session 头，`sessionPersistence.list()` 看不到它，
  // 但 `agents.create()` 会因为 id 已被占而抛 `session "…" already exists`，整轮唤醒就废了。
  const staleHost = {
    async hasSession() {
      return false;
    },
    async create() {
      throw new Error('session "onebot-hub:private%3A1" already exists');
    },
    async resume({ agentKey }) {
      return {
        agent: { async whenIdle() {}, followup() {} },
        id: agentKey,
        dispose() {},
      };
    },
    createUserMessage(input) {
      return { ...input };
    },
  };
  const stalePool = new AgentPool({ policy, host: staleHost, log: () => {} });
  const staleResult = await stalePool.wake('private:1', { text: 'hi' });
  check('create 撞到已存在的会话 id 时回退 resume，而不是整轮失败', () => {
    assert.equal(staleResult.ok, true, `唤醒应成功：${JSON.stringify(staleResult)}`);
    assert.equal(stalePool.stats.resumed, 1);
    assert.equal(stalePool.stats.created, 0);
    assert.equal(stalePool.stats.errors, 0);
  });

  // 线上踩过 #2：宿主已经把这个会话的 agent **发布**出来了（发布 = 它握着该会话的写句柄），
  // 但我们没能把它记进表里；于是 create 抛 `session "…" already exists`，回退 resume 又抛
  // `session "…" is already owned by an active write handle`（`claimWrite` 见有人占着）——
  // 两道路都堵死，用户看到的就是"没回复了"。宿主里活着的那个 agent 直接领养（`ctx.agents.get`）。
  const liveAgent = { async whenIdle() {}, followup() {}, dispose() {} };
  const ownedHost = {
    async hasSession() {
      return true;
    },
    async create() {
      throw new Error('session "onebot-hub:group%3A1" already exists');
    },
    async resume() {
      throw new Error('session "onebot-hub:group%3A1" is already owned by an active write handle');
    },
    getLive() {
      return liveAgent;
    },
    createUserMessage(input) {
      return { ...input };
    },
  };
  const ownedPool = new AgentPool({ policy, host: ownedHost, log: () => {} });
  const ownedResult = await ownedPool.wake('group:1', { text: 'hi' });
  check('写句柄被已发布的 agent 占着时领养活着的 agent，而不是整轮失败', () => {
    assert.equal(ownedResult.ok, true, `唤醒应成功：${JSON.stringify(ownedResult)}`);
    assert.equal(ownedPool.stats.adopted, 1, '该走领养');
    assert.equal(ownedPool.stats.resumed, 0, 'resume 撞了写句柄，不该记成成功');
    assert.equal(ownedPool.stats.errors, 0);
    assert.equal(ownedPool.size, 1);
  });

  // 心跳（meta_event）**永远**不叫模型，`wakeOnNotice` 也放不进来。
  // 坑（实测线上）：`entry.text` 对元事件也有值（`[元事件 heartbeat]`），于是它过了
  // "notice 且没有文本"那道判定；开着 `wakeOnNotice` 时会进批量窗口，窗口到期由 `scanDue`
  // 唤醒——每条心跳白跑一个模型回合（`other:meta_event` 会话 turns 一直涨，用户看得见）。
  check('元事件不入批量窗口：开着 wakeOnNotice 也不叫模型', () => {
    const noticePolicy = resolveAgentPolicy({ wakeOnNotice: true, mode: 'assist' });
    const meta = shouldWake({
      policy: noticePolicy,
      entry: { sessionKey: 'other:meta_event', kind: 'meta_event', text: '[元事件 heartbeat]' },
      event: { post_type: 'meta_event', meta_event_type: 'heartbeat' },
      batch: null,
    });
    assert.equal(meta.wake, false);
    assert.equal(meta.reason, 'kind:meta_event');
    // 反向对照：真通知（开 wakeOnNotice）在**激活态**里批量窗口到期时照旧唤醒，别把通知一起误杀。
    const batch = { count: 1, shouldFlush: () => ({ flush: true, reason: 'batch:timeout' }) };
    const notice = shouldWake({
      policy: noticePolicy,
      entry: { sessionKey: 'group:1', kind: 'notice', text: '[通知 group_recall]' },
      event: { post_type: 'notice', notice_type: 'group_recall' },
      batch,
      wakeState: { state: 'awake' },
    });
    assert.equal(notice.wake, true);
    assert.equal(notice.reason, 'batch:timeout');
    // 但**休眠态**的通知不会因为窗口到期就把模型叫起来（新规格：休眠只记录）。
    const asleep = shouldWake({
      policy: noticePolicy,
      entry: { sessionKey: 'group:1', kind: 'notice', text: '[通知 group_recall]' },
      event: { post_type: 'notice', notice_type: 'group_recall' },
      batch,
      wakeState: { state: 'dormant' },
    });
    assert.equal(asleep.wake, false);
    assert.equal(asleep.reason, 'dormant');
  });
}

// ------------------------------------------------------------------ 场景零：出站参数形态

async function scenarioReplyShape() {
  const { buildSendParams, parseSessionKey, buildSegments, ReplyBuffer, describeReply } = await import('../lib/reply.js');

  check('会话键解析：群与私聊', () => {
    assert.deepEqual(parseSessionKey('group:55555'), { message_type: 'group', group_id: 55555 });
    assert.deepEqual(parseSessionKey('private:10001'), { message_type: 'private', user_id: 10001 });
    assert.deepEqual(parseSessionKey('weird'), { message_type: null });
  });

  check('send_msg 参数按会话摊平，不把 reply 段塞错位置', () => {
    const note = buildSendParams({
      segments: buildSegments({ text: '在', images: ['http://x/y.png'], quote: '40001' }),
      sessionKey: 'group:55555',
    });
    assert.equal(note.action, 'send_msg');
    assert.equal(note.params.group_id, 55555);
    assert.deepEqual(note.params.message.map((s) => s.type), ['reply', 'text', 'image']);
    assert.equal(note.params.message[0].data.id, '40001');

    const priv = buildSendParams({ segments: buildSegments({ text: 'hi' }), sessionKey: 'private:10001' });
    assert.equal(priv.params.user_id, 10001);
    assert.equal(priv.params.group_id, undefined);
  });

  check('回复候选后写覆盖先写，take() 之后清空', () => {
    const buf = new ReplyBuffer();
    assert.equal(buf.active, false);
    buf.capture({ text: '第一版' });
    buf.capture({ text: '第二版' });
    assert.equal(buf.active, true);
    assert.equal(buf.take().text, '第二版');
    assert.equal(buf.active, false);
    assert.equal(buf.capture({ text: '   ' }), null, '空文本应当被忽略');
  });

  check('回复摘要有长度上限', () => {
    assert.equal(describeReply({ text: '短' }), '短');
    assert.ok(describeReply({ text: 'x'.repeat(100) }).length <= 60);
  });
}

// ------------------------------------------- 场景六：发言只走 onebot_reply 工具（§21.8，m30383 定案）
// 默认 `speakAssistantText=false`：模型写在普通回复文本里的内容只是内部草稿，宿主不替它发；
// 只有显式把 `agent.speakAssistantText` 配成 true（逃生门），文本兜底才会当发言发出去。

/** 造一条 assistant 消息（宿主消息体是内容段数组）。 */
function assistantMessage(text) {
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
  };
}

async function scenarioAssistantText() {
  // 默认策略（speakAssistantText=false）：纯文本草稿 → 沉默 + 留痕。
  {
    const { hub, sent } = makeHub();
    const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
    const ref = {};
    const { host } = makeFakeHost({
      script: async () => {
        // 真宿主里这些由 `session/event` 送来；这里直接喂账本，验的是"兜底 + 留痕"。
        ref.mind.noteSessionEvent('group:77777', assistantMessage('在的，怎么了'));
        ref.mind.noteSessionEvent('group:77777', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      },
    });
    const pool = new AgentPool({ policy, host, log: () => {} });
    const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
    ref.mind = mind;
    hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

    // mode:assist + 没被点名 → 只入批量窗口不唤醒，于是可以手动 flush 精确控制时序。
    hub.handleUpstreamEvent(groupMessage({ groupId: 77777, messageId: 50001, text: '在吗' }));
    const out = await mind.flush('group:77777', { reason: 'test:assistant-text' });

    check('默认策略：模型只写普通回复文本时不发言（m30383：发言只走 onebot_reply）', () => {
      assert.equal(out.delivered, null, '没有候选就没有 deliver');
      assert.equal(sent.length, 0);
      assert.equal(mind.stats.lastTurn.spokeFrom, 'none');
      assert.equal(mind.stats.lastTurn.sent, false);
      assert.match(mind.stats.lastTurn.diag.assistantText, /在的/, '草稿要留在账本里，只是不发');
    });
  }

  // 逃生门（agent.speakAssistantText=true）：文本兜底恢复老行为。
  {
    const { hub, sent } = makeHub();
    const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000, speakAssistantText: true });
    const ref = {};
    const { host } = makeFakeHost({
      script: async () => {
        ref.mind.noteSessionEvent('group:77777', assistantMessage('在的，怎么了'));
        ref.mind.noteSessionEvent('group:77777', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      },
    });
    const pool = new AgentPool({ policy, host, log: () => {} });
    const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
    ref.mind = mind;
    hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
    hub.handleUpstreamEvent(groupMessage({ groupId: 77777, messageId: 50001, text: '在吗' }));
    const out = await mind.flush('group:77777', { reason: 'test:assistant-text-optin' });

    check('逃生门 speakAssistantText=true：模型只写普通回复文本时，那句话就是它的发言', () => {
      assert.equal(out.delivered?.status, 'ok');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].action, 'send_msg');
      assert.equal(sent[0].params.group_id, 77777);
      assert.equal(sent[0].params.message[0].data.text, '在的，怎么了');
      assert.equal(mind.stats.lastTurn.spokeFrom, 'assistant-text');
      assert.equal(mind.stats.lastTurn.hadReply, true);
      assert.equal(mind.stats.lastTurn.sent, true);
    });

    check('会话账本留下这一轮的真实产出与结束原因', () => {
      assert.equal(mind.stats.lastTurn.diag.turnEnd, 'completed');
      assert.equal(mind.stats.lastTurn.diag.turnError, null);
      assert.match(mind.stats.lastTurn.diag.assistantText, /在的/);
    });
  }
}

async function scenarioAssistantTextSuppressed() {
  // ① 括号旁白 = 明确不想说话；② 工具候选优先于文本兜底；③ 开关能关掉兜底
  const run = async ({ text, toolReply, speak }) => {
    const { hub, sent } = makeHub();
    const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000, speakAssistantText: speak });
    const ref = {};
    const { host } = makeFakeHost({
      script: async (agent) => {
        if (toolReply) await agent.tools.get('onebot_reply').execute({ text: toolReply });
        ref.mind.noteSessionEvent('group:66666', assistantMessage(text));
      },
    });
    const pool = new AgentPool({ policy, host, log: () => {} });
    const mind = new Mind({
      hub,
      timeline: hub.timeline,
      store: new MemoryStore({}),
      policy,
      pool,
      log: () => {},
      setup: (agentCtx, { reply }) => {
        agentCtx.tools.register({
          name: 'onebot_reply',
          async execute(args = {}) {
            const c = reply.capture({ text: args.text, images: args.images ?? [], quote: args.quote_message_id });
            return c ? `queued:${c.text}` : 'empty';
          },
        });
      },
    });
    ref.mind = mind;
    hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
    hub.handleUpstreamEvent(groupMessage({ groupId: 66666, messageId: 50002, text: '灌水' }));
    await mind.flush('group:66666', { reason: 'test:suppress' });
    return { sent, mind };
  };

  const paren = await run({ text: '（不回复）' });
  check('整句括号旁白视为"不想说话"，不发言但留痕', () => {
    assert.equal(paren.sent.length, 0);
    assert.equal(paren.mind.stats.lastTurn.spokeFrom, 'none');
    assert.equal(paren.mind.stats.lastTurn.diag.assistantText, '（不回复）');
  });

  const both = await run({ text: '文本版', toolReply: '工具版' });
  check('工具候选优先：模型调了 onebot_reply 就用它的版本', () => {
    assert.equal(both.sent.length, 1);
    assert.equal(both.sent[0].params.message[0].data.text, '工具版');
    assert.equal(both.mind.stats.lastTurn.spokeFrom, 'tool');
  });

  const off = await run({ text: '文本版', speak: false });
  check('speakAssistantText=false 时文本兜底关闭，只剩沉默', () => {
    assert.equal(off.sent.length, 0);
    assert.equal(off.mind.stats.lastTurn.spokeFrom, 'none');
    assert.equal(off.mind.stats.lastTurn.diag.assistantText, '文本版', '账本照记，只是不发');
  });
}

/**
 * 修3（真机事故：回复 failed -1935986436 后 agent 仍以为说出口了）：
 * deliver 失败必须让模型知道——下一批的开头带一次性【系统提示】，取走即清。
 */
async function scenarioSendFailureNotice() {
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
  const ref = {};
  const { host, created } = makeFakeHost({
    script: async (agent) => {
      ref.calls = (ref.calls ?? 0) + 1;
      if (ref.calls === 1) await agent.tools.get('onebot_reply').execute({ text: '这句话会失败' });
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, setup: (agentCtx, { reply }) => {
    agentCtx.tools?.register?.({
      name: 'onebot_reply',
      async execute(args = {}) {
        const candidate = reply.capture({ text: args.text, images: args.images ?? [] });
        return candidate ? `queued:${candidate.text}` : 'empty';
      },
    });
  } });
  ref.mind = mind;
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  // 第一轮：上游装成实现端失败（真机 retcode）。直接换 `upstream.request`（而不是
  // 盖 `hub.callUpstream`）：`sent` 账本靠假上游的 request 记账，盖掉它就看不到出站帧了。
  const realRequest = hub.upstream.request;
  hub.upstream.request = async (action, params) => {
    sent.push({ action, params });
    return { status: 'failed', retcode: -1935986436, error: 'word too long', echo: params?.echo ?? null };
  };
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 52001, text: '第一句' }));
  const out1 = await mind.flush('group:55555', { reason: 'test:send-fail-1' });
  check('发送失败：deliver 把失败如实带回，时间线记 decision=failed', () => {
    assert.equal(out1.delivered?.status, 'failed');
    assert.equal(out1.delivered?.retcode, -1935986436);
    assert.equal(sent.length, 1);
    const rec = hub.timeline.bySession('group:55555').filter((e) => e.direction === 'hub-out').at(-1);
    assert.equal(rec?.decision, 'failed', `时间线没记失败：${rec?.decision}`);
    // m30859：失败的话**不算说过的话**——窗口/会话卡都不渲染它（时间线留着排查），
    // 否则模型下一轮会从上下文里看到"我：这句话会失败"，与【系统提示】自相矛盾。
    const snap = mind.snapshot('group:55555');
    assert.ok(!String(snap.window ?? '').includes('这句话会失败'), `窗口不该出现失败的话：${snap.window}`);
    assert.ok(!hub.cards.get('group:55555')?.lines?.some((l) => String(l.text ?? '').includes('这句话会失败')), '会话卡也不收失败的话');
  });
  hub.upstream.request = realRequest;

  // 第二轮：新消息进来，批的开头必须先交代"上一轮没发出去"。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 52002, text: '第二句' }));
  await mind.flush('group:55555', { reason: 'test:send-fail-2' });
  const notice = created.get('group:55555')?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('下一批开头带一次性【系统提示】：失败详情 + 原文摘要（修3）', () => {
    assert.ok(notice.startsWith('【系统提示】'), `失败提示要在批的第一行：${notice.slice(0, 80)}`);
    assert.match(notice, /retcode=-1935986436/);
    assert.match(notice, /这句话会失败/);
    assert.match(notice, /【新消息 1 条】/, '提示之后照常是新消息正文');
  });

  // 第三轮：提示是一次性的，不该每批都念叨。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 52003, text: '第三句' }));
  await mind.flush('group:55555', { reason: 'test:send-fail-3' });
  const again = created.get('group:55555')?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('失败提示只说一次（取走即清）', () => {
    assert.ok(!again.includes('【系统提示】'), `不该再提失败：${again.slice(0, 80)}`);
    assert.match(again, /第三句/);
  });
}

/**
 * 一次 `onebot_reply` 发多条（m32420）：空行断条 + 每张图各成一条，按固定间隔顺序发出，
 * 每条各记一条时间线；第 k 条失败**即停**（剩下不发），并在下一批开头如实告知是哪条没发。
 *
 * 关注点是"账对不对"：出站条数、每条装了什么、间隔有没有真的等、失败停在哪一条、
 * 说的条数（sentCount/totalMessages/failedAt）跟实际发出去的条数是否一致。
 */
async function scenarioMultiMessageReply() {
  let seq = 0;
  const run = async ({ failAt = null, gapMs = 25 } = {}) => {
    const groupId = 777300 + (seq += 1);
    const sessionKey = `group:${groupId}`;
    const stamps = [];
    const { hub, sent } = makeHub({ replyGapMs: gapMs });
    // 出站时间戳：间隔靠它验。`sent` 记 params（下面断言每条装了什么），`stamps` 记时刻。
    const inner = hub.upstream.request.bind(hub.upstream);
    hub.upstream.request = async (action, params) => {
      stamps.push(Date.now());
      if (failAt !== null && stamps.length === failAt) {
        sent.push({ action, params });
        return { status: 'failed', retcode: 1400, error: '风控', echo: params?.echo ?? null };
      }
      return inner(action, params);
    };
    const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
    const ref = {};
    const { host, created } = makeFakeHost({
      script: async (agent) => {
        if (ref.done) return;
        ref.done = true;
        await agent.tools.get('onebot_reply').execute({
          text: '先说一句\n\n再说一句',
          images: ['a.png', 'b.png'],
        });
      },
    });
    const pool = new AgentPool({ policy, host, log: () => {} });
    const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, setup: (agentCtx, { reply }) => {
      agentCtx.tools?.register?.({
        name: 'onebot_reply',
        async execute(args = {}) {
          const candidate = reply.capture({ text: args.text, images: args.images ?? [] });
          return candidate ? `queued:${candidate.text}` : 'empty';
        },
      });
    } });
    hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
    hub.handleUpstreamEvent(groupMessage({ groupId, messageId: 60001, text: '讲两句' }));
    const out = await mind.flush(sessionKey, { reason: 'test:multi-msg' });
    return { hub, sent, stamps, out, mind, pool, created, sessionKey, groupId };
  };
  const hubOut = ({ hub }, sessionKey) => hub.timeline.bySession(sessionKey).filter((e) => e.direction === 'hub-out');

  const ok = await run({ gapMs: 25 });
  check('一次调用发四条：2 段文字 + 2 张图，顺序与内容都对', () => {
    assert.equal(ok.sent.length, 4, `应发 4 条，实发 ${ok.sent.length}`);
    assert.deepEqual(ok.sent.map((s) => s.action), Array(4).fill('send_msg'));
    const bodies = ok.sent.map((s) =>
      s.params.message.map((seg) => seg.data.text ?? `[${seg.type}:${seg.data.file ?? ''}]`).join('|'),
    );
    assert.deepEqual(bodies, ['先说一句', '再说一句', '[image:a.png]', '[image:b.png]'], `每条该只装自己那段：${JSON.stringify(bodies)}`);
  });
  check('多条之间真的隔了配置的时间（不是连着灌）', () => {
    for (let i = 1; i < ok.stamps.length; i += 1) {
      assert.ok(ok.stamps[i] - ok.stamps[i - 1] >= 20, `第 ${i + 1} 条与上一条间隔 ${ok.stamps[i] - ok.stamps[i - 1]}ms 太小（配置 25ms）`);
    }
  });
  check('每条各记一条时间线；说的话数与实际发出去的一致', () => {
    const out = hubOut(ok, ok.sessionKey);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((r) => r.decision), Array(4).fill('sent'));
    assert.deepEqual(out.map((r) => r.refs?.part), [1, 2, 3, 4], '时间线要标出这是第几条');
    assert.ok(out.every((r) => r.refs?.of === 4));
    assert.equal(ok.mind.stats.sent, 4);
    assert.equal(ok.mind.stats.lastTurn.sentCount, 4);
    assert.equal(ok.mind.stats.lastTurn.totalMessages, 4);
    assert.equal(ok.mind.stats.lastTurn.failedAt, null);
  });

  const bad = await run({ failAt: 2 });
  check('第 k 条失败即停：只发到第 k 条，后面的不再试', () => {
    assert.equal(bad.sent.length, 2, `失败后不该继续发，实发 ${bad.sent.length}`);
    assert.equal(bad.mind.stats.sent, 1, '只有成功的那条算发出去');
    assert.equal(bad.mind.stats.lastTurn.sentCount, 1);
    assert.equal(bad.mind.stats.lastTurn.totalMessages, 4, '它本该发 4 条');
    assert.equal(bad.mind.stats.lastTurn.failedAt, 2);
    assert.equal(bad.mind.stats.lastTurn.sent, true, '发出去一条就算这一轮说过话');
    const out = hubOut(bad, bad.sessionKey);
    assert.deepEqual(out.map((r) => r.decision), ['sent', 'failed']);
    assert.equal(out[1].refs?.part, 2);
  });

  bad.hub.handleUpstreamEvent(groupMessage({ groupId: bad.groupId, messageId: 60002, text: '后面又有人说话了' }));
  await bad.mind.flush(bad.sessionKey, { reason: 'test:multi-msg-fail-notice' });
  const notice = bad.created.get(bad.sessionKey)?.followups.at(-1)?.content.map((p) => p.text ?? '').join('') ?? '';
  check('失败的那条在下一批开头如实告知：第几条、共几条、后面几条也没发', () => {
    assert.ok(notice.startsWith('【系统提示】'), `提示要在批的第一行：${notice.slice(0, 90)}`);
    assert.match(notice, /第 2\/4 条没发出去/);
    assert.match(notice, /后面 2 条也因此没发/);
    assert.match(notice, /后面又有人说话了/);
  });
}


/**
 * 插话（m31311）：回合在飞时的新消息不再排队等下一轮，而是以【插话 N 条】直接递进
 * 正在进行的回合。脚本第一段卡住模拟"模型在跑"，插话到达后驱动器在步骤边界认领；
 * 收尾验证：结算只归主 flush、回复后写覆盖、窗口不丢账。
 */
async function scenarioSteerInterject() {
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
  const ref = { inputs: [], phase: 0 };
  let gateResolve = null;
  const gate = new Promise((resolve) => { gateResolve = resolve; });
  const { host } = makeFakeHost({
    script: async (agent) => {
      ref.inputs.push({ kind: agent.lastInput?.kind, message: agent.lastInput?.message });
      ref.phase += 1;
      if (ref.phase === 1) {
        await gate; // 模拟长回合：第一批还没说完
        await agent.tools.get('onebot_reply').execute({ text: '第一批的回复' });
      } else if (agent.lastInput?.kind === 'steer') {
        const body = (agent.lastInput.message?.content ?? []).map((p) => p.text ?? '').join('');
        assert.match(body, /【插话 1 条】/, `插话消息缺头：${body.slice(0, 80)}`);
        assert.match(body, /插话内容/);
        await agent.tools.get('onebot_reply').execute({ text: `插话收到（第 ${ref.phase} 步）` });
      }
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({
    hub,
    timeline: hub.timeline,
    store: new MemoryStore({}),
    policy,
    pool,
    log: () => {},
    setup: (agentCtx, { reply }) => {
      agentCtx.tools.register({
        name: 'onebot_reply',
        async execute(args = {}) {
          const c = reply.capture({ text: args.text, images: args.images ?? [] });
          return c ? `queued:${c.text}` : 'empty';
        },
      });
    },
  });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  const waitFor = async (fn, label) => {
    for (let i = 0; i < 300; i += 1) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`等不到 ${label}`);
  };

  // 第一批：@ 唤醒（observe 自己就会触发 flush），回合卡在 gate 上——模拟模型正在跑。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 53001, text: '第一批消息', segments: [{ type: 'at', data: { qq: SELF_ID } }, { type: 'text', data: { text: '第一批消息' } }] }));
  await waitFor(() => ref.phase >= 1, '第一段脚本开始');

  // 第二批：这条没有 @，由批量窗口到期/手动排水触发 —— 回合还在飞，flush 走 #trySteer 插话，
  // 而不是 `batch:in-flight` 排队等下一轮。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 53002, text: '插话内容' }));
  const flush2 = mind.flush('group:55555', { reason: 'test:steer' });
  await waitFor(() => mind.stats.steered === 1, '插话被受理');

  check('插话：受理时首批候选还没发（后写覆盖，一轮只 deliver 一次）', () => {
    assert.equal(sent.length, 0, `首批候选不该提前出站：${JSON.stringify(sent)}`);
    assert.equal(mind.stats.lastSteer?.count, 1);
    assert.equal(mind.stats.lastSteer?.reason, 'test:steer');
    assert.deepEqual(ref.inputs.map((i) => i.kind), ['turn'], '此刻回合还卡在第一步，插话尚未被认领');
  });

  gateResolve();
  await waitFor(() => sent.length === 1, '这一回合最终出站一次');
  await flush2;
  check('插话：同一回合收尾，回复取最后一次调用（后写覆盖）', () => {
    assert.deepEqual(ref.inputs.map((i) => i.kind), ['turn', 'steer'], '驱动器应该在步骤边界认领插话，而不是等下一轮');
    assert.equal(sent.length, 1, `整轮只该出站一次：${JSON.stringify(sent)}`);
    const text = sent[0].params.message.map((p) => p.data?.text ?? '').join('');
    assert.match(text, /插话收到/, `出站应是插话后的回复：${text}`);
    assert.ok(!text.includes('第一批的回复'), `首批候选该被覆盖：${text}`);
    assert.equal(mind.stats.lastTurn?.spokeFrom, 'tool');
  });
  check('插话：窗口与账本不丢账', () => {
    assert.equal(mind.stats.lastTurn?.ok, true, '插话把回合延长了，这一轮仍由主 flush 正常结算');
    assert.equal(mind.stats.lastTurn?.sent, true);
    assert.equal(mind.stats.steered, 1);
    assert.deepEqual(mind.statsSnapshot.steering, [], '插话结束后不该还有在飞的');
    const snap = mind.snapshot('group:55555');
    assert.ok(String(snap.window ?? '').includes('插话内容'), '插话的那条要进窗口');
    assert.ok(String(snap.window ?? '').includes('第一批消息'), '第一批的也要在');
    const rec = hub.timeline.bySession('group:55555').filter((e) => e.direction === 'hub-out').at(-1);
    assert.equal(rec?.decision, 'sent');
  });
  assert.equal(pool.stats.created, 1, '插话不该另建会话');
}


/**
 * 真机回归：会话级 `onebot_reply` 的候选必须**跨轮存活**。
 *
 * 线上表现（2026-10-06 真宿主）：模型调了工具、回了"在。`/status` 没动静不是装死…"，
 * 群里却只收到 assistant 的收尾旁白「（已回：…）」。根因是回复缓冲每轮重建，而工具只在
 * 会话**首次**建立时注册一次——它握着第一轮那个旧缓冲，写进去没人读，兜底逻辑就顶上来发言了。
 */
async function scenarioReplyBufferSurvivesSecondWake() {
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
  let scripted = null;
  const { host } = makeFakeHost({
    script: async (agent) => {
      if (scripted) await scripted(agent);
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({
    hub,
    timeline: hub.timeline,
    store: new MemoryStore({}),
    policy,
    pool,
    log: () => {},
    setup: (agentCtx, { reply }) => {
      agentCtx.tools.register({
        name: 'onebot_reply',
        async execute(args = {}) {
          const c = reply.capture({ text: args.text, images: args.images ?? [] });
          return c ? `queued:${c.text}` : 'empty';
        },
      });
    },
  });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);

  const talk = async (chatText, toolText) => {
    scripted = async (agent) => {
      await agent.tools.get('onebot_reply').execute({ text: toolText });
      // 模型还写了收尾旁白：它**不该**顶替工具候选发出去
      mind.noteSessionEvent('group:77777', assistantMessage(`（已回：${toolText}）`));
    };
    hub.handleUpstreamEvent(groupMessage({ groupId: 77777, messageId: 51000 + sent.length, text: chatText }));
    return mind.flush('group:77777', { reason: 'test:reply-buffer' });
  };

  await talk('第一句', '工具版一');
  await talk('第二句', '工具版二');

  check('会话级回复候选跨轮存活：第二轮仍然发工具内容，而不是 assistant 旁白', () => {
    assert.equal(pool.stats.created, 1, '同一个会话只该 create 一次');
    assert.equal(pool.stats.resumed, 0, '复用内存里的会话，不该再走 resume（也就不会重跑 setup）');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].params.message[0].data.text, '工具版一');
    assert.equal(sent[1].params.message[0].data.text, '工具版二', '旧缓冲被读不到时，这里会是「（已回：工具版二）」');
    assert.equal(mind.stats.lastTurn.spokeFrom, 'tool');
  });

  // 同一个场景顺带验记忆去重：每轮 flush 都会把观测到的身份重新喂一遍（`buildObservedEntries`），
  // 线上不去重就是"唤醒几轮就堆几条"（真机同一个人的身份条目堆过 3 条）。
  check('记忆去重：连唤醒两轮，同一个人的身份条目只留一条', () => {
    const identity = mind.store.query({ kind: 'identity' });
    assert.equal(identity.length, 1, `期望 1 条，实得 ${identity.length}：${JSON.stringify(identity.map((e) => e.text))}`);
    assert.match(identity[0].text, /小明/);
    assert.equal(mind.store.stats.deduped >= 1, true, '第二轮的重复写入要记在 deduped 上');
  });
}

async function scenarioTurnErrorRecorded() {
  // 真宿主里 `whenIdle()` 会把回合内的错误吞掉：账本必须把 `turn/end` 的原因留下来。
  const { hub, sent } = makeHub();
  const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
  const ref = {};
  const { host } = makeFakeHost({
    script: async () => {
      ref.mind.noteSessionEvent('group:88888', {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { message: 'model quota exceeded', code: 'quota' } } },
      });
    },
  });
  const pool = new AgentPool({ policy, host, log: () => {} });
  const mind = new Mind({ hub, timeline: hub.timeline, store: new MemoryStore({}), policy, pool, log: () => {} });
  ref.mind = mind;
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.handleUpstreamEvent(groupMessage({ groupId: 88888, messageId: 50003, text: '喂' }));
  await mind.flush('group:88888', { reason: 'test:turn-error' });

  check('回合以 error 结束时，原因留在账本里而不是伪装成"沉默"', () => {
    assert.equal(sent.length, 0, '这一轮不该有发言');
    assert.equal(mind.stats.lastTurn.diag.turnEnd, 'error');
    assert.equal(mind.stats.lastTurn.diag.turnError, 'model quota exceeded');
    assert.equal(mind.stats.lastTurn.spokeFrom, 'none');
  });
}

check('会话事件解析：内容段数组取文本、括号旁白判定、非 hub 会话不受影响', () => {
  assert.equal(textOfContent({ content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(textOfContent({ content: 'raw' }), 'raw');
  assert.equal(textOfContent(undefined), '');
  assert.equal(isSilentMarker('（不回复）'), true);
  assert.equal(isSilentMarker('(no reply)'), true);
  assert.equal(isSilentMarker(''), true);
  assert.equal(isSilentMarker('（笑）在忙'), false, '只有整句旁白才算');
  assert.equal(isSilentMarker('好'), false);
  // 真机里发出去过的那种收尾旁白：整句在括号里、以"已回"开头（长也一样抑制）
  assert.equal(isSilentMarker('（已回：说明 `/status` 沉默的原因是超管名单为空，需要配置才生效。）'), true);
  assert.equal(isSilentMarker('(已发送)'), true);
  assert.equal(isSilentMarker('（已回的这条后面还有正文）'), true, '整句被括号包住才算；下面这条不是');
  assert.equal(isSilentMarker('（已回）那你说说看'), false, '括号旁白之外还有正文，就是正常发言');
  assert.equal(SESSION_ID_PREFIX, 'onebot-hub:');
  assert.notEqual(decodeURIComponent(`${SESSION_ID_PREFIX}private%3A945126014`.slice(SESSION_ID_PREFIX.length)), 'private%3A945126014');
});

async function scenarioArchivedSessionGate() {
  // 真机事故 #2：会话被归档后，宿主的 `archived-session-gate` 在 `agent/pre-step` 返回
  // `{ kind:'reject' }`，回合以 `turn/end {kind:'blocked'}` 结束——没有 step/start、没有模型请求，
  // 看起来和"模型不愿说话"一模一样。枢纽的对策：唤醒前 unarchive，且必须早于 followup。
  let seq = 0;
  const run = async ({ archivedKeys = [], unarchiveThrows = false } = {}) => {
    const groupId = 99000 + (seq += 1);
    const sessionKey = `group:${groupId}`;
    const { hub, sent } = makeHub();
    const policy = resolveAgentPolicy({ mode: 'assist', batchSize: 99, batchMs: 600000 });
    const fake = makeFakeHost({
      archivedKeys,
      unarchiveThrows,
      script: async (agent) => {
        await agent.tools.get('onebot_reply').execute({ text: '醒了' });
      },
    });
    const pool = new AgentPool({ policy, host: fake.host, log: () => {} });
    const mind = new Mind({
      hub,
      timeline: hub.timeline,
      store: new MemoryStore({}),
      policy,
      pool,
      log: () => {},
      setup: (agentCtx, { reply }) => {
        agentCtx.tools.register({
          name: 'onebot_reply',
          async execute(args = {}) {
            const c = reply.capture({ text: args.text });
            return c ? `queued:${c.text}` : 'empty';
          },
        });
      },
    });
    hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
    hub.handleUpstreamEvent(groupMessage({ groupId, messageId: 50004, text: '在吗' }));
    await mind.flush(sessionKey, { reason: 'test:archived' });
    return { sent, mind, pool, ...fake, sessionKey };
  };

  const gated = await run({ archivedKeys: ['group:99001'] });
  check('被归档的会话：唤醒前先 unarchive，再 followup，这一轮照常发言', () => {
    assert.deepEqual(gated.calls.slice(0, 2), ['unarchive:group:99001', 'followup']);
    assert.equal(gated.archived.has('group:99001'), false);
    assert.equal(gated.pool.stats.unarchived, 1);
    assert.equal(gated.mind.stats.lastTurn.unarchive.archived, true);
    assert.equal(gated.mind.stats.lastTurn.unarchive.sessionId, 'onebot-hub:group%3A99001');
    assert.equal(gated.sent.length, 1);
  });

  const clean = await run();
  check('没被归档的会话：不写盘（archived=false），也不多算 unarchived', () => {
    assert.equal(clean.mind.stats.lastTurn.unarchive.archived, false);
    assert.equal(clean.pool.stats.unarchived, 0);
    assert.equal(clean.sent.length, 1);
  });

  const failing = await run({ unarchiveThrows: true });
  check('unarchive 抛错不挡唤醒：这一轮照走，错误留在 lastTurn 里', () => {
    assert.equal(failing.mind.stats.lastTurn.ok, true);
    assert.equal(failing.mind.stats.lastTurn.unarchive.ok, false);
    assert.match(failing.mind.stats.lastTurn.unarchive.error, /workspaceRegistry/);
    assert.equal(failing.sent.length, 1);
  });
}

async function scenarioCapability() {
  // §22 需求 2：能力面（agent 侧先落地）。真 Hub + 假上游，验证
  // 分级闸门 → 不支持结论短路 → TTL 缓存 → 上游真答 这条路径，以及探测去重。
  const answers = {
    get_group_info: () => ({ status: 'ok', retcode: 0, data: { group_id: 55555, group_name: '测试群', member_count: 3 } }),
    get_group_member_list: () => ({ status: 'ok', retcode: 0, data: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] }),
    get_msg: () => ({ status: 'ok', retcode: 0, data: { message_id: 1, raw_message: 'hi' } }),
    _get_group_notice: () => ({ status: 'failed', retcode: 100, msg: 'unsupported action' }),
    get_cookies: () => ({ status: 'ok', retcode: 0, data: { cookies: 'uin=o3371846367' } }),
    send_like: () => ({ status: 'ok', retcode: 0, data: null }),
    set_group_kick: () => ({ status: 'ok', retcode: 0, data: null }),
    get_version_info: () => ({ status: 'ok', retcode: 0, data: { app_name: 'LLBot', app_version: '1.2.3', protocol_version: 'v11' } }),
    get_login_info: () => ({ status: 'ok', retcode: 0, data: { user_id: 3371846367, nickname: 'dsh-hub' } }),
    get_status: () => ({ status: 'ok', retcode: 0, data: { online: true, good: true } }),
  };
  const makeCap = ({ config = {}, connected = true, connects = 1 } = {}) => {
    const calls = [];
    const hub = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: SELF_ID, ...config }, { log: () => {} });
    hub.upstream = {
      isConnected: connected,
      status: { connected, connects },
      async request(action, params) {
        calls.push(action);
        const answer = answers[action];
        return answer ? answer() : { status: 'ok', retcode: 0, data: { action, params } };
      },
    };
    return { hub, calls };
  };

  // ---- 只读：走上游真答，再命中 TTL 缓存 ----
  const read = makeCap();
  const first = await read.hub.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  check('能力面·只读：真答取回 data，标 source=upstream', () => {
    assert.equal(first.ok, true);
    assert.equal(first.source, 'upstream');
    assert.equal(first.tier, 'read');
    assert.equal(first.data.group_name, '测试群');
    assert.equal(read.calls.length, 1);
  });

  const second = await read.hub.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  check('能力面·缓存：第二次不再打上游，source=cache 且带年龄', () => {
    assert.equal(second.source, 'cache');
    assert.equal(second.ok, true);
    assert.equal(second.data.group_name, '测试群');
    assert.match(second.note, /来自缓存/);
    assert.equal(read.calls.length, 1, '缓存命中不该再打上游');
  });

  const refreshed = await read.hub.callAction({ action: 'get_group_info', params: { group_id: 55555 }, refresh: true });
  check('能力面·refresh：强制取实时值', () => {
    assert.equal(refreshed.source, 'upstream');
    assert.equal(read.calls.filter((a) => a === 'get_group_info').length, 2);
  });

  await read.hub.callAction({ action: 'get_msg', params: { message_id: 1 } });
  await read.hub.callAction({ action: 'get_msg', params: { message_id: 1 } });
  check('能力面·不缓存类：消息内容每次都问上游', () => {
    assert.equal(read.calls.filter((a) => a === 'get_msg').length, 2);
    assert.equal(read.hub.cache.stats.hits >= 1, true);
    assert.equal(read.hub.capabilities.get('get_group_info').supported, 'supported');
  });

  // ---- 分级闸门 ----
  const gated = makeCap();
  const deniedWrite = await gated.hub.callAction({ action: 'send_like', params: { user_id: 1 } });
  const deniedDanger = await gated.hub.callAction({ action: 'set_group_kick', params: { group_id: 1, user_id: 2 } });
  const deniedSensitive = await gated.hub.callAction({ action: 'get_cookies' });
  check('能力面·闸门：write / danger / 凭证类默认一律拒绝，且不碰上游', () => {
    assert.equal(deniedWrite.ok, false);
    assert.equal(deniedWrite.retcode, 1403);
    assert.equal(deniedWrite.source, 'policy');
    assert.equal(deniedWrite.tier, 'write');
    assert.match(deniedWrite.note, /write 级/);
    assert.equal(deniedDanger.tier, 'danger');
    assert.match(deniedDanger.note, /danger 级/);
    assert.equal(deniedSensitive.sensitive, true);
    assert.match(deniedSensitive.note, /凭证类/);
    assert.equal(gated.calls.length, 0, '被策略拒绝的 action 绝不能发到上游');
  });

  const writeOk = makeCap({ config: { capability: { writeAllow: ['send_like'] } } });
  const allowedWrite = await writeOk.hub.callAction({ action: 'send_like', params: { user_id: 1 } });
  const otherWrite = await writeOk.hub.callAction({ action: 'delete_msg', params: { message_id: 1 } });
  const dangerInWriteList = await writeOk.hub.callAction({ action: 'set_group_kick', params: {} });
  check('能力面·白名单：精确到 action，撑不开 danger', () => {
    assert.equal(allowedWrite.ok, true);
    assert.equal(allowedWrite.tier, 'write');
    assert.equal(otherWrite.ok, false, '白名单里只有 send_like，delete_msg 仍应拒绝');
    assert.equal(dangerInWriteList.ok, false, '把 danger 写进 writeAllow 也不能放行');
    assert.equal(writeOk.calls.length, 1);
  });

  const dangerOk = makeCap({ config: { capability: { dangerAllow: ['set_group_kick'], exposeSensitive: true } } });
  const kicked = await dangerOk.hub.callAction({ action: 'set_group_kick', params: { group_id: 1, user_id: 2 } });
  const cookies = await dangerOk.hub.callAction({ action: 'get_cookies' });
  check('能力面·显式放行：dangerAllow 与 exposeSensitive 才开门', () => {
    assert.equal(kicked.ok, true);
    assert.equal(kicked.tier, 'danger');
    assert.equal(dangerOk.hub.capabilities.get('set_group_kick').supported, 'supported');
    assert.equal(cookies.ok, true);
    assert.equal(cookies.sensitive, true);
    assert.match(cookies.note, /敏感只读/);
  });

  // ---- 不支持结论：下结论、短路、可 refresh 重试 ----
  const unsupported = makeCap();
  const notice1 = await unsupported.hub.callAction({ action: '_get_group_notice', params: { group_id: 1 } });
  const notice2 = await unsupported.hub.callAction({ action: '_get_group_notice', params: { group_id: 1 } });
  check('能力面·不支持：记结论并短路，refresh 才重试真链路', () => {
    assert.equal(notice1.ok, false);
    assert.match(notice1.note, /实现端不支持该 action/);
    assert.equal(unsupported.hub.capabilities.get('_get_group_notice').supported, 'unsupported');
    assert.equal(unsupported.calls.length, 1);
    assert.equal(notice2.source, 'registry');
    assert.match(notice2.note, /已实测记录/);
    assert.equal(unsupported.calls.length, 1, '已知不支持不该再打上游');
  });
  await unsupported.hub.callAction({ action: '_get_group_notice', params: { group_id: 1 }, refresh: true });
  check('能力面·refresh：实现端升级后可以重试', () => {
    assert.equal(unsupported.calls.length, 2);
  });

  // ---- 上游断开 ----
  const offline = makeCap({ connected: false });
  const offlineResult = await offline.hub.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  check('能力面·上游断开：retcode 1201，且不抛异常', () => {
    assert.equal(offlineResult.ok, false);
    assert.equal(offlineResult.retcode, 1201);
    assert.match(offlineResult.note, /链路未连接/);
    assert.equal(offline.hub.capabilities.get('get_group_info').lastRetcode, 1201);
  });

  // ---- 探测：同一条连接只探一次 ----
  const probe = makeCap();
  await probe.hub.probeCapabilities();
  await probe.hub.probeCapabilities();
  check('能力面·探测：实现端身份入册，同一条连接不重复探测', () => {
    assert.equal(probe.hub.capabilities.impl.app_name, 'LLBot');
    assert.equal(probe.hub.capabilities.impl.app_version, '1.2.3');
    assert.equal(probe.hub.capabilities.impl.self_id, 3371846367);
    assert.equal(probe.hub.capabilities.impl.nickname, 'dsh-hub');
    assert.equal(probe.calls.filter((a) => a === 'get_version_info').length, 1);
    assert.equal(probe.hub.capabilities.get('get_login_info').supported, 'supported');
  });

  const reprobe = makeCap({ connects: 7 });
  await reprobe.hub.probeCapabilities();
  reprobe.hub.upstream.status.connects = 8; // 上游断线重连：代数变了
  await reprobe.hub.probeCapabilities({ timeoutMs: 100 });
  check('能力面·重连：connects 变了才重新探测', () => {
    assert.equal(reprobe.calls.filter((a) => a === 'get_version_info').length, 2);
  });

  check('能力面·快照：onebot_caps 能说明可用性、缓存与闸门', () => {
    const snapshot = writeOk.hub.capabilitiesSnapshot();
    assert.deepEqual(snapshot.supported.sort(), ['send_like']);
    assert.deepEqual(snapshot.gates.writeAllow, ['send_like']);
    assert.equal(snapshot.gates.dangerAllow.length, 0);
    assert.equal(snapshot.gates.exposeSensitive, false);
    assert.equal(snapshot.gates.cache, true);
    assert.equal(typeof snapshot.cache.hits, 'number');
    assert.match(snapshot.note, /unknown 表示还没调用过/);
  });
}

// ------------------------------------------------------------------ M13-①：下游只读也走能力面

async function scenarioCapabilityDownstream() {
  // §22.2 的"两个消费者共享一份缓存"：`bot-app` 型下游（NoneBot 这类 bot 应用）的
  // 只读请求先问真实现端，答不了才退回虚拟世界。这条路径必须要有真链路才验得了
  // （hub 要拨号、要收到下游发来的 action），所以起一个**本地伪下游**扮 bot 应用。
  const ws = await import('ws');
  useWs(ws);
  const { WebSocketServer } = ws;
  const waitUntil = async (cond, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  const upstreamAnswers = {
    get_group_info: () => ({ status: 'ok', retcode: 0, data: { group_id: 55555, group_name: '测试群', member_count: 7 } }),
    get_group_member_list: () => ({ status: 'ok', retcode: 0, data: [{ user_id: 1 }] }),
    get_msg: () => ({ status: 'failed', retcode: 1404, msg: '消息不存在' }), // 逼出"回退虚拟世界"
    get_cookies: () => ({ status: 'ok', retcode: 0, data: { cookies: 'uin=o40004000' } }),
  };

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  const frames = []; // 伪下游收到的（hub → 下游）
  const replies = []; // 伪下游发出去的 action 的响应（下游 → hub）
  let sock = null;
  wss.on('connection', (s) => {
    sock = s;
    s.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.status !== undefined || frame.echo !== undefined) replies.push(frame);
      else frames.push(frame);
      if (process.env.M15_DEBUG) console.error('[fake-down] got', JSON.stringify(frame)?.slice(0, 160));
    });
  });

  const makeBot = ({ capability } = {}) => {
    const calls = [];
    const hub = new Hub(
      {
        preset: 'relay',
        upstreamUrl: 'ws://127.0.0.1:3001',
        upstreamSelfId: '40004000',
        capability: { callTimeoutMs: 2000, ...capability },
        downstreamTargets: [{ url: `ws://127.0.0.1:${port}`, selfId: '30001000', nickname: 'fake-bot-app' }],
      },
      { log: (m) => (process.env.M15_DEBUG ? console.error('[hub]', m) : undefined) },
    );
    hub.upstream = {
      isConnected: true,
      status: { connected: true, connects: 1 },
      stop() {},
      async request(action) {
        calls.push(action);
        const answer = upstreamAnswers[action];
        return answer ? answer() : { status: 'failed', retcode: 1404, msg: `实现端未实现 ${action}` };
      },
    };
    hub.connectDownstreams();
    return { hub, calls };
  };

  const ask = async (action, params = {}) => {
    const before = replies.length;
    const echo = `e${before + 1}`;
    sock.send(JSON.stringify({ action, params, echo }));
    const arrived = await waitUntil(() => replies.length > before, 4000);
    if (!arrived) throw new Error(`伪下游等不到 ${action} 的响应`);
    return replies[replies.length - 1];
  };

  const { hub, calls } = makeBot();
  const up = await waitUntil(() => hub.downstreamLinks.some((l) => l.connected && l.kind === 'bot-app'), 5000);
  if (!up) {
    hub.stop();
    wss.close();
    throw new Error('伪下游没连上');
  }

  // ---- 1. 只读先问真实现端，echo 原样回填 ----
  const g1 = await ask('get_group_info', { group_id: 55555 });
  check('下游能力面·只读：真实现端作答，echo 原样回填', () => {
    assert.equal(g1.status, 'ok');
    assert.equal(g1.retcode, 0);
    assert.equal(g1.data.group_name, '测试群');
    assert.equal(g1.echo, 'e1');
    assert.deepEqual(Object.keys(g1).sort(), ['data', 'echo', 'retcode', 'status']);
    assert.equal(calls.filter((a) => a === 'get_group_info').length, 1);
  });

  // ---- 2. 与 agent 共享缓存：下游问过一次，agent 再问就不再打上游 ----
  const g2 = await ask('get_group_info', { group_id: 55555 });
  const byAgent = await hub.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  check('下游能力面·共享缓存：第二次不再打上游，agent 侧直接吃缓存', () => {
    assert.equal(g2.status, 'ok');
    assert.equal(byAgent.source, 'cache');
    assert.equal(calls.filter((a) => a === 'get_group_info').length, 1);
    assert.equal(hub.cache.stats.hits >= 2, true);
  });

  // ---- 3. 不缓存的（get_msg）每次都问，答不了才回退虚拟世界 ----
  const m1 = await ask('get_msg', { message_id: 111 });
  check('下游能力面·不缓存：get_msg 每次都问上游，实现端没有就照实说', () => {
    assert.equal(m1.status, 'failed');
    assert.equal(m1.retcode, 1404);
    assert.match(m1.msg, /实现端原文：消息不存在/); // hub 的失败说明，不是虚拟世界的措辞
    assert.equal(calls.filter((a) => a === 'get_msg').length, 1);
  });

  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, messageId: 111, text: '上一条' }));
  await waitUntil(() => hub.timeline.recent(50, { direction: 'downstream-out' }).length > 0, 3000);
  const m2 = await ask('get_msg', { message_id: 111 });
  check('下游能力面·回退虚拟世界：实现端没有的消息，hub 转发过所以世界答得上', () => {
    assert.equal(m2.status, 'ok');
    assert.equal(m2.data.message_id, 111);
    assert.equal(calls.filter((a) => a === 'get_msg').length, 2);
  });

  // ---- 4. 敏感只读：拒绝，且**绝不回退**虚拟世界 ----
  const cookies = await ask('get_cookies');
  check('下游能力面·敏感只读：默认拒绝且不回退（回退就等于闸门失效）', () => {
    assert.equal(cookies.status, 'failed');
    assert.equal(cookies.retcode, 1403);
    assert.match(cookies.msg, /exposeSensitive/);
    assert.equal(calls.filter((a) => a === 'get_cookies').length, 0);
  });

  // ---- 5. 断线降级：缓存还能顶，没缓存的回 1201 ----
  hub.upstream.isConnected = false;
  const g3 = await ask('get_group_info', { group_id: 55555 });
  const uncached = await ask('get_group_member_list', { group_id: 77777 });
  check('下游能力面·断线降级：缓存作答，没缓存的回 1201（上游断线不是静默失败）', () => {
    assert.equal(g3.status, 'ok');
    assert.equal(g3.data.member_count, 7);
    assert.equal(uncached.status, 'failed');
    assert.equal(uncached.retcode, 1201);
  });

  // ---- 6. 账本：下游问的每个只读请求都进时间线，标明来自下游 ----
  check('下游能力面·账本：cache/call/denied/offline 都留痕', () => {
    const outs = hub.timeline.recent(200, { direction: 'hub-out' });
    assert.ok(outs.some((e) => e.action === 'get_group_info' && e.decision === 'cache' && e.refs?.capabilitySource === 'downstream'));
    assert.ok(outs.some((e) => e.action === 'get_cookies' && e.decision === 'denied'));
    assert.ok(outs.some((e) => e.action === 'get_group_member_list' && e.decision === 'offline'));
  });

  // ---- 7. 开关：downstreamReads=false 退回纯虚拟世界（不问上游） ----
  hub.stop();
  const legacy = makeBot({ capability: { downstreamReads: false } });
  const up2 = await waitUntil(() => legacy.hub.downstreamLinks.some((l) => l.connected && l.kind === 'bot-app'), 5000);
  const legacyReply = up2 ? await ask('get_group_info', { group_id: 55555 }) : null;
  check('下游能力面·开关：downstreamReads=false 时不问上游，仍由虚拟世界作答', () => {
    assert.equal(up2, true);
    assert.equal(legacy.calls.length, 0);
    assert.equal(legacyReply.retcode, 1404); // 这条新链路的虚拟世界还没观测过这个群
  });
  legacy.hub.stop();
  wss.close();
  if (frames.length === 0) check('下游能力面·伪下游确实建立了链路（收到了下游事件）', () => assert.fail('没收到任何下发事件'));
}

// ------------------------------------------------------------------ M13-②：管理动作的闸门与预演

async function scenarioAdminGate() {
  // 闸门只有一处（`hub.callAction`），`onebot_admin` 只是把它的结论提前告诉模型。
  // 这里验的是：预演说"会拦"时**一个字节都没发**、放行后才真发、
  // 且 write 与 danger 是两条独立白名单（通配撑不开 danger，danger 也不必写进 writeAllow）。
  const sent = [];
  const makeAdminHub = (capability = {}) => {
    const hub = new Hub(
      { preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', capability },
      { log: () => {} },
    );
    hub.upstream = {
      isConnected: true,
      status: { connected: true, connects: 1 },
      stop() {},
      async request(action, params) {
        sent.push({ action, params });
        return { status: 'ok', retcode: 0, data: { ok: true } };
      },
    };
    return hub;
  };

  const closed = makeAdminHub();
  const kickPlan = planAdminOp('kick', { group_id: 55555, user_id: 10001, reject_add_request: true });
  check('管理动作·预演：说清会被拦，且一个字节都没发', () => {
    assert.equal(kickPlan.ok, true);
    const preview = closed.previewAction(kickPlan.action);
    assert.equal(preview.allowed, false);
    assert.equal(preview.reason, 'danger');
    assert.match(preview.note, /dangerAllow/);
    assert.equal(sent.length, 0);
  });
  const refused = await closed.callAction({ action: kickPlan.action, params: kickPlan.params, source: 'agent:admin' });
  check('管理动作·真判定：danger 默认拒绝（1403）且未碰上游', () => {
    assert.equal(refused.ok, false);
    assert.equal(refused.retcode, 1403);
    assert.equal(refused.source, 'policy');
    assert.equal(sent.length, 0);
  });

  const open = makeAdminHub({ writeAllow: ['set_group_card'] });
  const card = planAdminOp('set_card', { group_id: 55555, user_id: 10001, card: '小助手' });
  const cardResult = await open.callAction({ action: card.action, params: card.params, source: 'agent:admin' });
  check('管理动作·放行：writeAllow 精确到 action，放行后真发到上游', () => {
    assert.equal(open.previewAction(card.action).allowed, true);
    assert.equal(cardResult.ok, true);
    assert.deepEqual(sent, [
      { action: 'set_group_card', params: { group_id: 55555, user_id: 10001, card: '小助手' } },
    ]);
    const ledger = open.timeline.recent(20, { direction: 'hub-out' });
    assert.ok(ledger.some((e) => e.action === 'set_group_card' && e.decision === 'call' && e.refs?.capabilitySource === 'agent:admin'));
  });

  const mixed = makeAdminHub({ writeAllow: ['*'] });
  check('管理动作·隔离：writeAllow 通配撑不开 danger', () => {
    assert.equal(mixed.previewAction('send_msg').allowed, true);
    assert.equal(mixed.previewAction('set_group_kick').allowed, false);
    assert.equal(mixed.previewAction('set_group_kick').reason, 'danger');
  });

  const dangerOpen = makeAdminHub({ dangerAllow: ['set_group_kick'] });
  await dangerOpen.callAction({ action: 'set_group_kick', params: { group_id: 1, user_id: 2 }, source: 'agent:admin' });
  check('管理动作·隔离：dangerAllow 单独列上就放行（不必写进 writeAllow）', () => {
    assert.equal(sent.length, 2);
    assert.equal(sent[1].action, 'set_group_kick');
  });
}

// ------------------------------------------------------------------ M13-③：能力结论落盘（重启不重踩）

async function scenarioCapabilityPersistence() {
  // 停掉一个 hub 再起一个（= 重启 DSH 的替身）：实测结论与只读缓存应当原样回来。
  // 落盘的价值不是省一次网络往返，而是"这个实现端没有 _get_group_notice"这种结论
  // 是花一次超时换来的，不该因为重启就重新花一次。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-persist-'));
  const calls = [];
  const makeHub = (storageDir = dir) => {
    const hub = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir }, { log: () => {} });
    hub.upstream = {
      isConnected: true,
      status: { connected: true, connects: 1 },
      stop() {},
      async request(action, params) {
        calls.push(action);
        if (action === '_get_group_notice') return { status: 'failed', retcode: 100, msg: 'not supported', data: null };
        return { status: 'ok', retcode: 0, data: { [action]: true, params } };
      },
    };
    return hub;
  };

  const first = makeHub();
  await first.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  await first.callAction({ action: '_get_group_notice', params: { group_id: 55555 } });
  first.flushStorage();
  const file = path.join(dir, 'capabilities', `${safeName(first.upstreamLinkId)}.json`);
  check('能力落盘·写入：实测结论与只读缓存都落成 JSON 文件', () => {
    assert.equal(calls.length, 2);
    assert.equal(fs.existsSync(file), true);
    assert.equal(first.capabilities.get('_get_group_notice').supported, 'unsupported');
    assert.equal(first.cache.size, 1);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.linkId, first.upstreamLinkId);
    assert.equal(raw.registry.actions.length, 2);
    assert.equal(raw.cache.entries.length, 1);
  });

  const callsBefore = calls.length;
  const second = makeHub();
  check('能力落盘·恢复：新进程读回结论与缓存（storage.loaded=true）', () => {
    assert.equal(second.storageMeta.loaded, true);
    assert.equal(second.storageMeta.registryEntries, 2);
    assert.equal(second.storageMeta.cacheEntries, 1);
    assert.deepEqual(second.capabilities.snapshot().unsupported, ['_get_group_notice']);
    assert.equal(second.cache.get('get_group_info', { group_id: 55555 }).value.get_group_info, true);
    assert.equal(second.capabilitiesSnapshot().storage.file, file);
  });

  const notice = await second.callAction({ action: '_get_group_notice', params: { group_id: 55555 } });
  const info = await second.callAction({ action: 'get_group_info', params: { group_id: 55555 } });
  check('能力落盘·收益：重启后 unsupported 直接短路、只读命中缓存，一个请求都没发', () => {
    assert.equal(calls.length, callsBefore, '重启后不该再为这两条打上游');
    assert.equal(notice.source, 'registry');
    assert.equal(notice.ok, false);
    assert.match(notice.note, /refresh=true/);
    assert.equal(info.source, 'cache');
    assert.equal(info.ok, true);
  });

  const off = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', storageDir: '' }, { log: () => {} });
  check('能力落盘·开关：storageDir 为空即整个关闭（不建目录、不写文件）', () => {
    assert.equal(off.storage.enabled, false);
    assert.equal(off.capabilityFile !== '', true);
    assert.equal(off.storage.path(off.capabilityFile), null);
    assert.equal(off.capabilitiesSnapshot().storage.enabled, false);
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 场景：M16 档案层（观测写档案 → 装配 → 落盘恢复）

async function scenarioProfiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-'));
  const { hub } = makeHub({ storageDir: dir });
  const isolation = resolveIsolation({ level: 'balanced' });
  const store = new MemoryStore({});
  const mind = new Mind({ hub, timeline: hub.timeline, store, isolation, policy: resolveAgentPolicy({}), log: () => {} });

  // 1) 观测写档案：一条普通群消息，名字/角色/会话活跃时间由**代码**记下（模型不参与）。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10001, messageId: 11, text: '在吗', nickname: '小明' }));
  const person = hub.profiles.person('10001');
  check('M16 观测写档案：名字与群名片由代码记下，模型不参与', () => {
    assert.equal(person.names.length, 1);
    assert.equal(person.names[0].name, '小明');
    assert.equal(person.names[0].scope, 'group:55555');
    assert.equal(person.groups['group:55555'].role, 'member');
    assert.ok(hub.profiles.sessionOf('group:55555').lastMessageAt > 0, '会话活跃时间应被记下');
  });

  // 1.5) 能力调用的**观测**结果也进档案：群名/人数/群主/公告只能从这条路进来（模型写不了）。
  hub.observeActionResult('get_group_info', { group_id: 55555 }, { group_id: 55555, group_name: '硬件折腾群', member_count: 137 });
  hub.observeActionResult('get_group_notice', { group_id: 55555 }, [{ notice_id: 'n1', publish_time: 100, message: { text: '禁止刷屏' } }]);
  hub.observeActionResult('get_group_member_list', { group_id: 55555 }, [
    { user_id: 10001, nickname: '小明', role: 'member', last_sent_time: 500 },
    { user_id: 10009, nickname: '群主老王', role: 'owner', last_sent_time: 900 },
    { user_id: 10010, nickname: '话痨', card: '话痨本人', role: 'admin', last_sent_time: 800 },
  ]);
  const g55555 = hub.profiles.group('group:55555');
  check('M16 观测写档案·能力面：群名/人数/群主/公告/活跃人物只由代码写', () => {
    assert.equal(g55555.name, '硬件折腾群');
    assert.equal(g55555.memberCount, 137);
    assert.equal(g55555.notice, '禁止刷屏');
    assert.equal(g55555.ownerId, '10009');
    assert.equal(g55555.activeMembers[0].user_id, '10009', '按最后发言时间排');
    assert.equal(hub.profiles.person('10010').groups['group:55555'].card, '话痨本人', '成员表里的名片也该记进人物档案');
  });

  // 2) 模型决策写记忆（短期/长期/人物档案各一条）。
  const writeCtx = (sessionKey) => ({
    store,
    profiles: hub.profiles,
    sessionKey,
    worldKey: sessionKey,
    actorId: '10001',
    isolation,
    now: Date.now(),
    source: 'test',
  });
  const applied = applyMemoryOps(
    {
      short_term: { add: [{ text: '他说过在写机器人' }] },
      persons: { 10001: { facts: [{ text: '在写一个 QQ 机器人' }], impression: '话不多，技术问题问得准' } },
    },
    writeCtx('group:55555'),
  );
  // 「短期/长期」不是模型声明的：**代码按这条记忆是在哪个会话学到的**来分块。
  // 所以"长期"必须来自别的会话——从群 55555 看它是跨群条目，才是长期记忆。
  applyMemoryOps({ long_term: { add: [{ text: '他在别的群提过喜欢猫' }] } }, writeCtx('group:77777'));
  const snap = mind.snapshot('group:55555', { actorId: '10001' });

  check('M16 装配：人物卡、长期/短期分块、序号与写入侧同一份列表', () => {
    assert.equal(applied.applied.short_term.add, 1);
    assert.match(snap.text, /【人物卡】/);
    assert.match(snap.text, /印象：话不多，技术问题问得准/);
    assert.match(snap.text, /【短期记忆/);
    assert.match(snap.text, /0\. 他说过在写机器人/, '序号要从 0 开始，模型才能照着改');
    assert.equal(snap.blocks.shortTerm.length, 1);
    assert.equal(snap.blocks.longTerm.length, 1);
    assert.ok(snap.sections.some((s) => s.name === 'person' && s.chars > 0), '装配段里要有 person 一段');
  });

  check('M16 人物卡里的私事跨群仍被隔离规则挡下（可见性由代码判定）', () => {
    // 同一个人，在私聊里说过一件私事：写进档案后，群视角下不该出现。
    applyMemoryOps(
      { persons: { 10001: { facts: [{ text: '他住在某个具体地址' }] } } },
      { store, profiles: hub.profiles, sessionKey: 'private:10001', worldKey: 'private:10001', actorId: '10001', isolation, now: Date.now(), source: 'test' },
    );
    const inGroup = mind.snapshot('group:55555', { actorId: '10001' });
    assert.ok(!inGroup.text.includes('某个具体地址'), '私聊里的事实不该出现在群里的上下文');
    const inPrivate = mind.snapshot('private:10001', { actorId: '10001' });
    assert.ok(inPrivate.text.includes('某个具体地址'), '但私聊视角下应当记得');
  });

  // 2.5) 话题关联（§24.4）：**"在聊同一件事"是语义判断，代码不做**；代码只接明写的引用关系。
  hub.profiles.upsertTopic('t_bug', { title: '那个 bug', refs: [{ messageId: '11' }], members: ['10001'] }, Date.now());
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 55555,
      userId: 10009,
      messageId: 12,
      nickname: '群主老王',
      text: '还是那个 bug',
      segments: [
        { type: 'reply', data: { id: '11' } },
        { type: 'text', data: { text: '还是那个 bug' } },
      ],
    }),
  );
  check('M16 话题关联：引用了话题里的消息就接进同一条线，不猜关键词', () => {
    const t = hub.profiles.topic('t_bug');
    assert.equal(t.events.length, 1, '新消息的时间线 id 应被接进去');
    assert.ok(t.members.includes('10009'), '说话人补进 members');
    assert.equal(t.title, '那个 bug', '接进来不能把已有内容冲掉');
  });

  check('M16 话题关联：只是"话题像"不算证据（宁可没记住，也不记错）', () => {
    hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10009, messageId: 13, text: '还是那个 bug 啊' }));
    assert.equal(hub.profiles.topic('t_bug').events.length, 1, '没引用就没证据，不接');
  });

  // 3) 落盘恢复：档案是文件，重启后还在（否则"我记得"就只是进程内存的幻觉）。
  hub.flushStorage();
  const rawFile = path.join(dir, 'persons', '10001.json');
  const { hub: hub2 } = makeHub({ storageDir: dir });
  check('M16 落盘：档案写进 persons/10001.json，新实例读得回', () => {
    assert.ok(fs.existsSync(rawFile), `应写盘：${rawFile}`);
    const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    assert.equal(raw.names[0].name, '小明');
    assert.equal(hub2.profiles.person('10001').impression, '话不多，技术问题问得准');
    assert.equal(hub2.profiles.snapshot().enabled, true);
  });

  check('M16 关闭存储时档案仍可用（不因为写不了盘就罢工）', () => {
    const { hub: off } = makeHub({ storageDir: '' });
    off.observeProfiles(groupMessage({ groupId: 55555, userId: 10002, messageId: 12, text: 'hi', nickname: '小红' }));
    assert.equal(off.profiles.person('10002').names[0].name, '小红');
    assert.equal(off.profiles.snapshot().enabled, false);
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 场景：M18 主动回忆

async function scenarioReminders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cues-'));
  const { hub } = makeHub({ storageDir: dir });
  const isolation = resolveIsolation({ level: 'scoped' });
  const store = new MemoryStore({});
  const mind = new Mind({ hub, timeline: hub.timeline, store, isolation, policy: resolveAgentPolicy({}), log: () => {} });
  hub.reminders.clear();

  // 小明在群里露过面（这样"他上次露面是什么时候"是有据可查的），模型随后记下一条还没兑现的承诺。
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10001, messageId: 21, text: '在', nickname: '小明' }));
  const writeCtx = {
    store,
    profiles: hub.profiles,
    sessionKey: 'group:55555',
    worldKey: 'group:55555',
    actorId: '10001',
    isolation,
    now: Date.now(),
    source: 'test',
  };
  applyMemoryOps({ persons: { 10001: { commitments: [{ what: '帮他看一个 bug', due: Date.now() - 3 * 86400000 }] } } }, writeCtx);

  const snap = mind.snapshot('group:55555', { actorId: '10001' });
  check('M18 主动回忆：把"还没兑现的事"当事实交出去，不下命令', () => {
    assert.equal(snap.cues.length, 1);
    assert.match(snap.text, /【还没兑现的事】/);
    assert.match(snap.text, /你答应过「小明」：帮他看一个 bug/);
    assert.match(snap.text, /已经过了 3 天/);
    assert.match(snap.text, /他上次露面是/);
    assert.ok(!/(该提醒|必须提醒|现在就提|别忘了去)/.test(snap.text), '只报事实：措辞里不能有命令');
    assert.ok(snap.sections.some((s) => s.name === 'cues' && s.chars > 0), '装配段里要有 cues 一段');
  });

  const key = snap.cues[0].key;
  const t0 = Date.now();
  hub.reminders.note(snap.cues, t0);
  const again = mind.snapshot('group:55555', { actorId: '10001' });
  check('M18 安全阀：同一条承诺 24 小时内不再进 prompt，24 小时后可以再来', () => {
    assert.equal(again.cues.length, 0, '刚提过就不该原样再提一遍');
    // 注意判据是 cues 段，不是整段文本：人物卡里"答应过还没做的"是**档案事实**（常驻、不冷却），
    // 「还没兑现的事」才是带时间与冷却的提醒段。两者都出现不算重复注入。
    assert.equal(again.sections.find((s) => s.name === 'cues')?.chars ?? 0, 0, '冷却期内 cues 段应为空');
    assert.equal(hub.reminders.canAsk(key, t0 + 60_000), false);
    assert.equal(hub.reminders.canAsk(key, t0 + 24 * 3600 * 1000), true);
    assert.equal(hub.reminders.stats.windowHours, 24);
  });

  check('M18 隔离再生效一次：别的群/私聊里的承诺不会跑到这个群里', () => {
    applyMemoryOps(
      { persons: { 10002: { commitments: [{ what: '帮他带一份午饭' }] } } },
      { ...writeCtx, sessionKey: 'private:10002', worldKey: 'private:10002', actorId: '10002' },
    );
    const inGroup = mind.snapshot('group:55555', { actorId: '10001' });
    assert.ok(!inGroup.text.includes('带一份午饭'), '私聊里的承诺不该在群里出现');
    const inPrivate = mind.snapshot('private:10002', { actorId: '10002' });
    assert.ok(inPrivate.text.includes('带一份午饭'), '私聊视角下应当记得');
  });

  // 唤醒失败不算"提过"：否则一次宿主抖动就能让这条承诺沉默一整天。
  hub.reminders.clear();
  const failing = new Mind({
    hub,
    timeline: hub.timeline,
    store: new MemoryStore({}),
    isolation,
    policy: resolveAgentPolicy({}),
    pool: { wake: async () => ({ ok: false }) },
    log: () => {},
  });
  const entry = hub.timeline.bySession('group:55555').at(-1);
  failing.observe(entry);
  const failedTurn = await failing.flush('group:55555', { actorId: '10001' });
  check('M18 唤醒失败不算提过（不会因为一次抖动就沉默一整天）', () => {
    assert.equal(failedTurn.result?.ok, false, '假宿主的 wake 回 ok:false');
    assert.equal(failing.stats.lastTurn.ok, false);
    assert.equal(hub.reminders.canAsk(key, Date.now()), true);
    assert.equal(hub.reminders.stats.injected, 0);
  });

  // 落盘：冷却账本跟着 storage 走，重启后不会立刻再提一遍。
  hub.reminders.note([{ key }], Date.now());
  hub.flushStorage();
  const { hub: hub2 } = makeHub({ storageDir: dir });
  check('M18 冷却账本落盘：重启后仍然记得"这条刚提过"', () => {
    assert.ok(fs.existsSync(path.join(dir, 'reminders.json')), '应写盘：reminders.json');
    assert.equal(hub2.reminders.canAsk(key, Date.now()), false);
    assert.equal(hub2.reminders.canAsk(key, Date.now() + 24 * 3600 * 1000), true);
  });

  check('M18 关掉安全阀（windowHours=0）就是"每次都提"，不是"永远不提"', () => {
    const { hub: off } = makeHub({ storageDir: '', reminders: { enabled: false } });
    off.reminders.note([{ key }], Date.now());
    assert.equal(off.reminders.canAsk(key, Date.now() + 1000), true);
    off.reminders.note([{ key }], Date.now());
    assert.equal(off.reminders.canAsk(key, Date.now() + 1000), true);
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 场景：M17 聊天记录检索

async function scenarioRecall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recall-'));
  const { hub } = makeHub({ storageDir: dir });
  const isolation = resolveIsolation({ level: 'scoped' });
  const store = new MemoryStore({});
  hub.store = store;
  // index.js 里就是构造完 hub 之后才把 MemoryStore 接给检索层的（"记忆"要算一种来源）。
  hub.recall.store = store;

  const privateMessage = (userId, messageId, text) => ({
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: userId,
    raw_message: text,
    font: 0,
    sender: { user_id: userId, nickname: '小明', role: 'member', card: '' },
    message: [{ type: 'text', data: { text } }],
  });

  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10001, messageId: 101, text: '今天天气不错，出去走走', nickname: '小明' }));
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10002, messageId: 102, text: '我买了个新键盘', nickname: '小红' }));
  hub.handleUpstreamEvent(privateMessage(10001, 103, '我最近在偷偷准备考试'));
  hub.handleUpstreamEvent(groupMessage({ groupId: 77777, userId: 10003, messageId: 104, text: '今天天气真差', nickname: '外人' }));
  hub.handleUpstreamEvent(
    groupMessage({
      groupId: 55555,
      userId: 10002,
      messageId: 105,
      text: '看这个梗图',
      nickname: '小红',
      segments: [
        { type: 'text', data: { text: '看这个梗图' } },
        { type: 'image', data: { file: 'cat.png' } },
      ],
    }),
  );

  const in55555 = { sessionKey: 'group:55555', actorId: '10001', isolation };
  const weather = await hub.recall.search({ query: '天气', ...in55555 });
  const examInGroup = await hub.recall.search({ query: '考试', ...in55555 });
  const examInPrivate = await hub.recall.search({ query: '考试', sessionKey: 'private:10001', actorId: '10001', isolation });
  check('M17 中文两字词命中四字句；私聊里的话翻不出来但报得出被挡了几条', () => {
    assert.equal(weather.items.length, 1, '同群里搜"天气"要搜到"今天天气不错"，别群的记录不算');
    assert.equal(weather.items[0].refs.message_id, 101);
    assert.ok(weather.denied >= 1, '别群的记录被隔离挡下，条数必须报出来');
    assert.ok(['sqlite', 'memory'].includes(weather.mode));
    assert.deepEqual(examInGroup.items, []);
    assert.ok(examInGroup.denied >= 1);
    assert.equal(examInPrivate.items.length, 1, '私聊视角下自己的话当然看得见');
    assert.equal(examInPrivate.items[0].sessionKey, 'private:10001');
  });

  const grouped = await hub.recall.search({ ...in55555, groupBy: 'person' });
  const images = await hub.recall.search({ ...in55555, kinds: 'image' });
  const byPerson = await hub.recall.search({ ...in55555, person: '10002' });
  const windowed = await hub.recall.search({ ...in55555, limit: 2 });
  const openOnly = await hub.recall.search({ ...in55555, openOnly: true, topics: [] });
  check('M17 一个工具多种问法：按人分组/按段类型/按人/时间窗+条数/只看没结的话题', () => {
    assert.deepEqual(grouped.groups.map((g) => g.user_id).sort(), ['10001', '10002']);
    assert.ok(grouped.groups.every((g) => g.count >= 1 && g.lastText));
    assert.equal(images.items.length, 1, 'kinds=image 只看带图片段的消息');
    assert.equal(images.items[0].refs.message_id, 105);
    assert.ok(byPerson.items.length >= 1 && byPerson.items.every((it) => String(it.actor.user_id) === '10002'));
    assert.equal(windowed.items.length, 2, 'limit 生效');
    assert.equal(windowed.total >= 3, true, 'total 仍是命中总数，不是被截断后的条数');
    assert.deepEqual(openOnly.items, [], '没有话题线程时 openOnly 不该假装有');
  });

  const escapeOff = await hub.recall.search({ ...in55555, query: '天气', scope: 'all' });
  const escapeIso = resolveIsolation({ level: 'scoped', recallEscape: true, recallEscapeNeedsApproval: true });
  const escapeNeedsConfirm = await hub.recall.search({ ...in55555, query: '天气', scope: 'all', isolation: escapeIso });
  const escapeConfirmed = await hub.recall.search({ ...in55555, query: '天气', scope: 'all', confirm: true, isolation: escapeIso });
  check('M17 越界检索：默认降级并说明；要审批时没 confirm 就一条不给', () => {
    assert.equal(escapeOff.scope, 'visible');
    assert.match(String(escapeOff.note), /recallEscape=false/, '降级要带一句 note，不能静默改语义');
    assert.equal(escapeNeedsConfirm.needsApproval, true);
    assert.deepEqual(escapeNeedsConfirm.items, []);
    assert.equal(escapeConfirmed.items.length, 2, '确认后连别群的记录也翻得到');
  });

  // 索引只是索引：jsonl 才是真相。删掉 index.sqlite，重开一个实例照样翻得到。
  const idsOf = (r) => r.items.map((it) => it.refs?.message_id ?? it.id).sort();
  const { hub: hub2 } = makeHub({ storageDir: dir });
  hub2.recall.store = store;
  const before = await hub2.recall.search({ query: '天气', ...in55555 });
  const indexFile = path.join(dir, 'recall', 'index.sqlite');
  const hadIndex = fs.existsSync(indexFile);
  // Windows 上文件被打开就删不掉：两个实例的 sqlite 句柄都得先放开。
  hub.recall.close();
  hub2.recall.close();
  if (hadIndex) fs.rmSync(indexFile, { force: true });
  const { hub: hub3 } = makeHub({ storageDir: dir });
  hub3.recall.store = store;
  const after = await hub3.recall.search({ query: '天气', ...in55555 });
  check('M17 索引可重建：L1 落在 jsonl，删掉 index.sqlite 后结果一致', () => {
    const dayDir = path.join(dir, 'recall', safeName(hub.upstreamLinkId));
    assert.ok(fs.existsSync(dayDir), `L1 原始层应落盘：${dayDir}`);
    assert.ok(fs.readdirSync(dayDir).some((f) => f.endsWith('.jsonl')));
    assert.deepEqual(idsOf(after), idsOf(before));
    assert.equal(hub3.recall.stats.rows >= 5, true);
  });

  // 淡忘：默认不返回，但数据没被删掉（includeWeak 取得到，onebot_timeline 也仍看得到原文）。
  store.add(
    { text: '他半年前说过要换工作', kind: 'fact', ts: Date.now() - 200 * 24 * 3600 * 1000, mentions: 1 },
    { sessionKey: 'group:55555' },
  );
  const weakDefault = await hub.recall.search({ query: '换工作', ...in55555, sources: ['timeline', 'memory'] });
  const weakAll = await hub.recall.search({ query: '换工作', ...in55555, sources: ['timeline', 'memory'], includeWeak: true });
  check('M17 遗忘是降权不是删除：默认不出现，includeWeak 还取得到原文', () => {
    assert.deepEqual(weakDefault.items, []);
    assert.match(String(weakDefault.note), /淡忘/);
    assert.equal(weakAll.items.length, 1);
    assert.equal(weakAll.items[0].source, 'memory');
    assert.equal(weakAll.items[0].strength < 0.2, true);
  });

  hub.stop();
  // 收尾前把还活着的 sqlite 句柄都放开，否则 Windows 上的临时目录删不掉。
  hub.recall.close();
  hub3.recall.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * M14 媒体与段语义化：**转发保真**与**文本人话**是两件事，必须同时成立。
 *  - 下游收到的那个 `image` 段必须一个字节都没改（base64:// 原样）；
 *  - 与此同时时间线里的 `text` 是人话（`[图片]` + durable ref），语音还带转写。
 */
async function scenarioMedia() {
  const ws = await import('ws');
  useWs(ws);
  const { WebSocketServer } = ws;
  const waitUntil = async (cond, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  // 1×1 的真 PNG（不是假字节：sniffType 要认得出）
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const IMAGE_FILE = `base64://${PNG}`;
  const AMR = 'IyFBTVIKAAAA'; // "#!AMR" 的 base64：语音字节也得骗得过 sniffType

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  const frames = [];
  let sock = null;
  wss.on('connection', (s) => {
    sock = s;
    s.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)));
      } catch {
        /* 忽略坏帧 */
      }
    });
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-'));
  const savedImages = [];
  const attachments = {
    async saveImage(input) {
      savedImages.push(input);
      return { attachmentId: `sha256:${'a'.repeat(8)}`, mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length };
    },
    async saveFile(input) {
      savedImages.push(input);
      return { attachmentId: `sha256:${'b'.repeat(8)}`, mediaType: input.mediaType, bytes: input.data.length };
    },
  };

  const makeBot = ({ media } = {}) => {
    const calls = [];
    const hub = new Hub(
      {
        preset: 'relay',
        upstreamUrl: 'ws://127.0.0.1:3001',
        upstreamSelfId: '40004000',
        storageDir: dir,
        capability: { callTimeoutMs: 2000 },
        media: media ?? {},
        downstreamTargets: [{ url: `ws://127.0.0.1:${port}`, selfId: '30001000', nickname: 'fake-bot-app' }],
      },
      { log: (m) => (process.env.M15_DEBUG ? console.error('[hub]', m) : undefined) },
    );
    hub.upstream = {
      isConnected: true,
      status: { connected: true, connects: 1 },
      stop() {},
      async request(action) {
        calls.push(action);
        // 语音转写：只有实现端扩展能给——这就是 §22.6 说的"优先实测、拿不到就诚实说听不了"
        if (action === 'fetch_ptt_text') return { status: 'ok', retcode: 0, data: { text: '我到了，别等我吃饭' } };
        return { status: 'failed', retcode: 404, msg: `实现端未实现 ${action}` };
      },
    };
    hub.media.attach(attachments);
    hub.connectDownstreams();
    return { hub, calls };
  };

  const { hub } = makeBot();
  const framesBefore = frames.length;
  const up = await waitUntil(() => hub.downstreamLinks.some((l) => l.connected));
  check('M14 前置：下游已连上（否则转发保真无从验证）', () => assert.equal(up, true));

  const mediaSegments = [
    { type: 'at', data: { qq: '10002' } },
    { type: 'text', data: { text: ' 看这个' } },
    { type: 'image', data: { file: IMAGE_FILE, sub_type: '0' } },
    { type: 'record', data: { file: `base64://${AMR}`, duration: 3 } },
    { type: 'face', data: { id: 14 } },
    { type: 'reply', data: { id: 77 } },
  ];
  // 先让 10002 说一句，这样"@小红"这个称呼有来源（名字跟着群走）
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10002, messageId: 76, text: '在的', nickname: '小红' }));
  hub.handleUpstreamEvent(
    groupMessage({ groupId: 55555, userId: 10001, messageId: 77, text: '我发了个图', nickname: '小明' }),
  );
  hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10001, messageId: 78, segments: mediaSegments }));

  const arrived = await waitUntil(() => frames.length > framesBefore + 2);
  const forwarded = frames.filter((f) => f.message_id === 78).pop();
  check('M14 转发保真：段数组一个字节都没改（base64 原样透传）', () => {
    assert.ok(arrived, '下游没收到这三条');
    assert.ok(forwarded, '下游没收到那条带媒体的消息');
    assert.equal(forwarded.message[2].type, 'image');
    assert.equal(forwarded.message[2].data.file, IMAGE_FILE);
    assert.equal(forwarded.message[3].data.file, `base64://${AMR}`);
  });

  const resolved = await waitUntil(() => (hub.timeline.bySession('group:55555').find((e) => e.refs?.message_id === 78)?.refs?.media ?? []).length >= 2);
  const entry = hub.timeline.bySession('group:55555').find((e) => e.refs?.message_id === 78);
  check('M14 人话渲染：@用称呼、引用带原文、图片给 durable ref、语音带转写', () => {
    assert.ok(resolved, '媒体一直没落地完');
    assert.match(entry.text, /@小红/);
    assert.match(entry.text, /\[图片\]（已存为 hub-media:[0-9a-f]{12}）/);
    assert.match(entry.text, /\[语音 3s\]“我到了，别等我吃饭”/);
    assert.match(entry.text, /\[表情：惊讶\]/);
    assert.match(entry.text, /↩回复「小明：我发了个图」/);
  });

  check('M14 durable ref：字节落在自己的 blob 目录（上游 URL 会过期，这个不会）', () => {
    const refs = hub.media.list({ limit: 10 });
    assert.equal(refs.length >= 2, true);
    const image = refs.find((r) => r.kind === 'image');
    assert.equal(image.mediaType, 'image/png');
    assert.match(image.sha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(image.blob), `blob 不存在：${image.blob}`);
    assert.ok(image.blob.startsWith(path.join(dir, 'media', 'blobs')), image.blob);
    // 索引（谁在什么时候落过什么）也要留痕。
    // 日期必须按 `JsonlLog` 的规则算（**本地日**）：自己拼 `toISOString()` 是 UTC 日，
    // 在东八区的凌晨会差一天，测试就会在半夜凭空变红。这里直接问 JsonlLog 要路径。
    const indexFile = new JsonlLog({ dir: path.join(dir, 'media') }).fileFor(hub.upstreamLinkId);
    assert.ok(fs.existsSync(indexFile), `媒体索引没落盘：${indexFile}`);
  });

  check('M14 宿主 attachments：图片与文件都登记了一份（模型才真看得见）', () => {
    assert.equal(savedImages.length >= 2, true);
    assert.equal(savedImages[0].mediaType, 'image/png');
    assert.ok(Buffer.isBuffer(savedImages[0].data) || savedImages[0].data instanceof Uint8Array);
    assert.equal(hub.media.stats.attached >= 2, true);
    assert.equal(hub.media.stats.transcribed, 1);
  });

  check('M14 上游不认识 get_image 也不影响：字节本来就内联在段里', () => {
    assert.equal(hub.media.stats.blobs >= 2, true);
    assert.equal(hub.media.stats.failed, 0);
  });

  // 关掉 media：文本照旧有占位，只是不再有 durable ref（转发本来就不依赖它）
  const off = makeBot({ media: { enabled: false } });
  off.hub.media.detach();
  off.hub.handleUpstreamEvent(groupMessage({ groupId: 55555, userId: 10001, messageId: 79, segments: mediaSegments }));
  check('M14 media.enabled=false：段照旧转发，文本只有占位、不落盘', () => {
    const e = off.hub.timeline.bySession('group:55555').find((x) => x.refs?.message_id === 79);
    assert.match(e.text, /\[图片\]/);
    assert.doesNotMatch(e.text, /hub-media:/);
    assert.equal(off.hub.media.stats.blobs, 0);
  });

  sock?.close();
  hub.stop();
  off.hub.stop();
  await new Promise((resolve) => wss.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function scenarioTurns() {
  // §16.4 / M6 回合配对：回答"哪条消息触发了下游什么"。这条路径要真链路才验得了
  // （hub 要拨号、下游要真的发 send_*），所以起一个能回话的本地伪下游。
  const ws = await import('ws');
  useWs(ws);
  const { WebSocketServer } = ws;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  let sock = null;
  wss.on('connection', (s) => {
    sock = s;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-turns-'));
  const hub = new Hub(
    {
      preset: 'relay',
      upstreamUrl: 'ws://127.0.0.1:3001',
      upstreamSelfId: '40004000',
      storageDir: dir,
      turns: { windowMs: 250, retain: 20 },
      downstreamTargets: [{ url: `ws://127.0.0.1:${port}`, selfId: '30001000', nickname: 'fake-bot-app' }],
    },
    { log: (m) => (process.env.M15_DEBUG ? console.error('[hub]', m) : undefined) },
  );
  hub.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request() {
      return { status: 'ok', retcode: 0, data: { message_id: 777 } };
    },
  };
  hub.connectDownstreams();

  const waitFor = async (cond, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await sleep(10);
    }
    return false;
  };
  await waitFor(() => sock !== null);

  const groupMessage = (messageId, text, userId = 10001) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: '40004000',
    message_id: messageId,
    group_id: 55555,
    user_id: userId,
    sender: { user_id: userId, nickname: '小明', role: 'member', card: '' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    time: Math.floor(Date.now() / 1000),
  });
  /** 让伪下游"说一句话"= 它自己发一条 send_msg action（这才是 outcome）。 */
  const downstreamSays = (text, echo) =>
    sock.send(
      JSON.stringify({
        action: 'send_msg',
        params: { message_type: 'group', group_id: 55555, message: [{ type: 'text', data: { text } }] },
        echo,
      }),
    );
  const hasOutcome = () => (hub.turns.open?.outcomes?.length ?? 0) > 0;

  check('回合配对：伪下游已连上', () => assert.equal(sock !== null, true));

  // ① 触发 + 下游真的说话了 → 归到那条触发上，延迟有据
  hub.handleUpstreamEvent(groupMessage(301, '/今日小猪'));
  downstreamSays('🐷 来喽', 't1');
  await waitFor(hasOutcome);
  const one = hub.turns.list({ limit: 5, withOutcomes: true });
  check('回合配对：下游的 send_msg 归到触发它的那条消息上', () => {
    const turn = one.turns[0];
    assert.equal(turn.trigger.message_id, 301);
    assert.deepEqual(turn.responders, ['down:30001000']);
    assert.equal(turn.silent, false);
    assert.equal(typeof turn.latencyMs, 'number');
    assert.equal(turn.outcomeCount, 1);
    assert.equal(turn.outcomes[0].action, 'send_msg');
    assert.equal(turn.outcomes[0].linkId, 'down:30001000');
  });

  // ② 新消息提前封口上一条：它的响应不会被错配给新消息
  hub.handleUpstreamEvent(groupMessage(302, '/双猪'));
  downstreamSays('🐷🐷', 't2');
  await waitFor(hasOutcome);
  hub.handleUpstreamEvent(groupMessage(303, '/第三只'));
  const two = hub.turns.list({ limit: 10, withOutcomes: true });
  check('回合配对：新消息把上一条提前封口（响应不错配）', () => {
    const turn = two.turns.find((t) => t.trigger.message_id === 302);
    assert.ok(turn, '302 的回合应该在列表里');
    assert.equal(turn.closeReason, 'superseded');
    assert.equal(turn.outcomeCount, 1);
    assert.equal(turn.outcomes[0].text.includes('🐷🐷'), true);
  });

  // ③ 超窗的下游动作挂不到任何触发 → 单列 unsolicited，绝不硬塞
  await sleep(320);
  hub.turns.list({ limit: 1 }); // 惰性封口 303
  downstreamSays('整点报时', 't3');
  await waitFor(() => hub.turns.list({ limit: 1 }).unsolicited.length > 0);
  const three = hub.turns.list({ limit: 10 });
  check('回合配对：挂不上触发的下游动作进 unsolicited', () => {
    assert.ok(three.unsolicited.length >= 1);
    const last = three.unsolicited[three.unsolicited.length - 1];
    assert.equal(last.text.includes('整点报时'), true);
    assert.equal(last.linkId, 'down:30001000');
    const silent303 = three.turns.find((t) => t.trigger.message_id === 303);
    assert.equal(silent303.silent, true, '303 没人响应');
    assert.equal(silent303.latencyMs, null);
    assert.equal(silent303.closeReason, 'window');
  });

  // ④ hub 自己发言记 hubSpoke，不算"下游响应"；中继镜像（带 refs.fromLink）不算自己发言
  hub.handleUpstreamEvent(groupMessage(304, '@我 你怎么看'));
  hub.timeline.record({
    direction: 'hub-out',
    linkId: hub.upstreamLinkId,
    action: 'send_msg',
    params: {},
    decision: 'sent',
    text: '我觉得行',
    refs: { sessionKey: 'group:55555' },
  });
  hub.timeline.record({
    direction: 'hub-out',
    linkId: hub.upstreamLinkId,
    action: 'send_msg',
    params: {},
    decision: 'relay',
    text: '（中继下游的话）',
    refs: { fromLink: 'down:30001000', message_id: 7788, sessionKey: 'group:55555' },
  });
  const four = hub.turns.list({ limit: 5 });
  check('回合配对：hub 自己发言记 hubSpoke，中继镜像不算', () => {
    const turn = four.turns.find((t) => t.trigger.message_id === 304);
    assert.equal(turn.hubSpoke, true);
    assert.equal(turn.outcomeCount, 0);
    assert.equal(turn.silent, true);
    assert.equal(four.stats.hubSpokeWhileSilent >= 1, true);
  });

  // ⑤ 统计与筛选：onlyResponsive 只剩有响应的那几条
  const five = hub.turns.list({ limit: 20 });
  check('回合统计：responsive/silent/响应者/延迟', () => {
    assert.equal(five.stats.turns >= 4, true);
    assert.equal(five.stats.responsive >= 2, true);
    assert.equal(five.stats.silent >= 2, true);
    assert.equal(typeof five.stats.avgLatencyMs, 'number');
    assert.equal(five.stats.responders[0].linkId, 'down:30001000');
    assert.equal(five.stats.responders[0].count >= 2, true);
  });
  const six = hub.turns.list({ limit: 20, onlyResponsive: true });
  check('回合筛选：onlyResponsive 只剩说得上话的回合', () => {
    assert.equal(six.turns.length >= 2, true);
    assert.equal(six.turns.every((t) => t.outcomeCount > 0), true);
  });
  const bySession = hub.turns.list({ limit: 20, sessionKey: 'group:55555' });
  check('回合筛选：按会话过滤', () => {
    assert.equal(bySession.turns.length >= 4, true);
    assert.equal(bySession.turns.every((t) => t.trigger.sessionKey === 'group:55555'), true);
  });

  // ⑥ 封口的回合落盘，重启后还查得到（真相在 jsonl，内存只是缓存）
  await sleep(320);
  hub.turns.list({ limit: 1 });
  const file = hub.turns.snapshot.file;
  check('回合落盘：封口的 turn 一行一条，触发与响应都在里面', () => {
    assert.equal(hub.turns.persistence, true);
    assert.equal(fs.existsSync(file), true);
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length >= 4, true);
    const t301 = lines.find((l) => l.trigger?.message_id === 301);
    assert.equal(t301.responders[0], 'down:30001000');
    assert.equal(t301.outcomes.length, 1);
    assert.equal(t301.silent, false);
    assert.equal(lines.every((l) => l.trigger && Array.isArray(l.outcomes)), true);
  });
  check('回合快照：snapshot 能看出窗口与保留量', () => {
    const snap = hub.turns.snapshot;
    assert.equal(snap.windowMs, 250);
    assert.equal(snap.closed >= 4, true);
    assert.equal(snap.open, false);
    assert.equal(snap.persistence, true);
  });
  check('回合清空：clear 只清内存', () => {
    const cleared = hub.turns.clear();
    assert.equal(cleared >= 4, true);
    assert.equal(hub.turns.list({ limit: 5 }).turns.length, 0);
    assert.equal(fs.existsSync(file), true, '落盘的 jsonl 不动');
  });

  sock?.close();
  hub.stop();
  await new Promise((resolve) => wss.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function scenarioLearn() {
  // §17 / M7 用法学习：观测 → 知识库 → L3 注入 → 落盘 → 重启恢复。
  // 起点是 M6 的回合配对，所以同样要真链路：下游得真的回一句，那次观测才算证据。
  const ws = await import('ws');
  useWs(ws);
  const { WebSocketServer } = ws;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  let sock = null;
  wss.on('connection', (s) => {
    sock = s;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-learn-'));
  const makeHub = () =>
    new Hub(
      {
        preset: 'relay',
        upstreamUrl: 'ws://127.0.0.1:3001',
        upstreamSelfId: '40004000',
        storageDir: dir,
        turns: { windowMs: 150, retain: 20 },
        learn: { threshold: 3, staleAfter: 2, forgetAfter: 4 },
        downstreamTargets: [{ url: `ws://127.0.0.1:${port}`, selfId: '30001000', nickname: 'fake-bot-app' }],
      },
      { log: (m) => (process.env.M15_DEBUG ? console.error('[hub]', m) : undefined) },
    );
  const hub = makeHub();
  hub.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request() {
      return { status: 'ok', retcode: 0, data: { message_id: 777 } };
    },
  };
  hub.connectDownstreams();

  const waitFor = async (cond, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await sleep(10);
    }
    return false;
  };
  await waitFor(() => sock !== null);

  const groupMessage = (messageId, text, userId = 10001) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: '40004000',
    message_id: messageId,
    group_id: 55555,
    user_id: userId,
    sender: { user_id: userId, nickname: '小明', role: 'member', card: '' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    time: Math.floor(Date.now() / 1000),
  });
  const downstreamSays = (text, echo) =>
    sock.send(
      JSON.stringify({
        action: 'send_msg',
        params: { message_type: 'group', group_id: 55555, message: [{ type: 'text', data: { text } }] },
        echo,
      }),
    );
  const hasOutcome = () => (hub.turns.open?.outcomes?.length ?? 0) > 0;
  /** 一条被响应的消息，等窗口过期封口（封口才喂学习）。 */
  const ask = async (messageId, text, reply, echo) => {
    hub.handleUpstreamEvent(groupMessage(messageId, text));
    downstreamSays(reply, echo);
    await waitFor(hasOutcome);
    await sleep(200);
    hub.turns.list({ limit: 1 }); // 惰性封口 → onClose → 学习
  };

  check('用法学习：开局是空表，不编造', () => {
    assert.equal(hub.learn.size, 0);
    assert.deepEqual(hub.learn.prefixes, []);
    assert.deepEqual(hub.learn.renderForPrompt(), []);
  });

  await ask(401, '/roll 10', '🎲 3', 'e1');
  check('用法学习：一次响应只到 candidate（阈值 3）', () => {
    const rec = hub.learn.get('roll');
    assert.ok(rec, '候选应该进表');
    assert.equal(rec.status, 'candidate');
    assert.equal(rec.confidence, 1);
    assert.equal(rec.kind, 'command');
    assert.equal(rec.prefix, '/');
    assert.equal(rec.source, 'observed');
    assert.equal(rec.scope.linkId, hub.upstreamLinkId);
    assert.deepEqual(hub.learn.prefixes, ['/'], '前缀推断只认被响应过的触发');
  });

  await ask(402, '/roll 10', '🎲 5', 'e2');
  await ask(403, '/roll 10', '🎲 1', 'e3');
  check('用法学习：同一命令响应三次 → active（§17.2④）', () => {
    const rec = hub.learn.get('roll');
    assert.equal(rec.status, 'active');
    assert.equal(rec.confidence, 3);
    assert.equal(rec.evidence.messageIds.length, 3);
    assert.equal(rec.outcome.actions.includes('send_msg'), true);
    assert.equal(Number.isFinite(rec.outcome.typicalLatencyMs), true);
    assert.equal(Number.isFinite(rec.evidence.lastSeen), true);
    assert.equal(hub.learn.snapshot.total, 1);
    assert.equal(hub.learn.snapshot.active, 1);
  });
  check('用法学习：L3 注入拿到命令、前缀、参数形态与证据量', () => {
    const [cap] = hub.learn.renderForPrompt();
    assert.equal(cap.name, 'roll');
    assert.equal(cap.prefix, '/');
    assert.equal(cap.args, '10', '观测到的参数形态进注入，而不是只有命令名');
    assert.equal(cap.confidence, 3);
    assert.equal(cap.status, 'active');
    assert.deepEqual(hub.learn.prefixHints, [{ prefix: '/', count: 3 }]);
  });

  hub.flushStorage();
  const file = path.join(dir, 'capabilities', `${safeName(hub.upstreamLinkId)}.json`);
  check('用法学习：落盘就在 capabilities/<linkId>.json 的 commands 字段里（§17.1/§24.10）', () => {
    assert.equal(fs.existsSync(file), true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.commands.records.length, 1);
    assert.equal(raw.commands.records[0].name, 'roll');
    assert.equal(raw.commands.records[0].status, 'active');
    assert.equal(raw.commands.records[0].evidence.observations, 3);
    assert.deepEqual(raw.commands.prefixCounts, [['/', 3]]);
  });

  // 已知用法这次没人响应：证据不减，只记一次"未复现"（§17.2④）。
  hub.handleUpstreamEvent(groupMessage(405, '/roll 10'));
  await sleep(200);
  hub.turns.list({ limit: 1 });
  check('用法学习：已知用法没人响应 → 记一次未复现，证据不删', () => {
    const rec = hub.learn.get('roll');
    assert.equal(rec.status, 'active');
    assert.equal(rec.missStreak, 1);
    assert.equal(rec.confidence, 3);
  });

  // 从来没被响应过的闲聊：不建条目（"静默"不等于"学会了"）。
  hub.handleUpstreamEvent(groupMessage(406, '闲聊一句'));
  await sleep(200);
  hub.turns.list({ limit: 1 });
  check('用法学习：没人响应的闲聊既不建条目、也不算 miss', () => {
    assert.equal(hub.learn.size, 1);
    assert.equal(hub.learn.get('闲聊一句'), null);
    assert.equal(hub.learn.snapshot.missed, 1, '只有已知用法才记未复现');
  });

  // §M7 验收：预测与真实一致——先说"会不会触发"，再真发一次看它到底触没触发。
  const predictedHit = hub.learn.predict({ text: '/roll 10' });
  const predictedMiss = hub.learn.predict({ text: '今天天气不错' });
  check('试运行探针：预测给结论、给形状、给参数，且什么都没发（§10）', () => {
    assert.equal(predictedHit.wouldTrigger, true);
    assert.equal(predictedHit.exact, true);
    assert.equal(predictedHit.best.name, 'roll');
    assert.equal(predictedHit.best.prefix, '/');
    assert.equal(predictedHit.best.args.text, '10');
    assert.equal(predictedHit.best.confidence, 3);
    assert.equal(predictedHit.sent, false);
    assert.match(predictedHit.note, /很可能触发/);
    assert.equal(predictedMiss.wouldTrigger, false);
    assert.deepEqual(predictedMiss.matches, []);
    assert.match(predictedMiss.note, /看不出会触发/);
  });

  await ask(407, '/roll 10', '🎲 6', 'e7');
  const hitTurn = hub.turns.list({ limit: 1, withOutcomes: true }).turns[0];
  hub.handleUpstreamEvent(groupMessage(408, '今天天气不错'));
  await sleep(200);
  const missTurn = hub.turns.list({ limit: 2, withOutcomes: true }).turns[0];
  check('试运行探针：预测与真实一致（说会触发的真答了，说不会触发的真沉默）', () => {
    assert.equal((hitTurn?.outcomes?.length ?? 0) > 0, predictedHit.wouldTrigger);
    assert.equal((missTurn?.outcomes?.length ?? 0) > 0, predictedMiss.wouldTrigger);
  });

  check('用法学习：静态清单并入后 source 变 both，观测到的用法优先（§17.4）', () => {
    hub.learn.mergeCode([{ name: 'roll', aliases: ['掷骰子'], prefix: '/', notes: 'test 插件的 on_command' }]);
    const rec = hub.learn.get('掷骰子');
    assert.equal(rec.source, 'both');
    assert.deepEqual(rec.args, { text: '10' }, '声明面能补，参数形态以观测为准');
    assert.match(rec.notes, /on_command/);
  });

  // 合并写是防抖的（1.5s）：重启前把待写的落下去。
  hub.flushStorage();
  const hub2 = makeHub();
  check('用法学习：重启后从磁盘恢复，不用重新学一遍', () => {
    assert.equal(hub2.learn.size, 1);
    const rec = hub2.learn.get('roll');
    assert.equal(rec.status, 'active');
    assert.equal(rec.confidence, 4, '预测对照那次真发也算一次观测');
    assert.equal(rec.source, 'both');
    assert.deepEqual(hub2.learn.prefixHints, [{ prefix: '/', count: 4 }]);
    assert.equal(hub2.storageMeta.commands, 1);
  });

  try {
    hub2.stop();
  } catch {
    /* 第二个 hub 没连链路，停不掉也无所谓 */
  }
  sock?.close();
  hub.stop();
  await new Promise((resolve) => wss.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 场景：L2 会话卡落盘（重启之后还记得刚才在聊什么）

async function scenarioCards() {
  // L1 只追加、启动不回放，所以内存环重启即空。会话卡是唯一每轮都注入的记忆层，
  // 这一格空了，它会认得出人、翻得到历史，却不知道刚才在聊什么。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cards-'));
  const makeHub = (storageDir = dir) => {
    const hub = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir }, { log: () => {} });
    hub.upstream = { isConnected: true, status: { connected: true, connects: 1 }, stop() {}, async request() { return { status: 'ok', retcode: 0, data: {} }; } };
    return hub;
  };
  const groupMessage = (messageId, text, userId = 10001, nickname = '小明') => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: '40004000',
    message_id: messageId,
    group_id: 55555,
    user_id: userId,
    sender: { user_id: userId, nickname, role: 'member', card: '' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    time: Math.floor(Date.now() / 1000),
  });

  const first = makeHub();
  first.handleUpstreamEvent(groupMessage(11, '晚上吃什么'));
  first.handleUpstreamEvent(groupMessage(12, '随便', 10002, '小红'));
  first.handleUpstreamEvent(groupMessage(13, '那就火锅'));

  check('会话卡·增量：消息一来就地更新，转发镜像与元事件都不算', () => {
    const snap = first.capabilitiesSnapshot().cards;
    assert.equal(snap.enabled, true);
    assert.equal(snap.cards, 1);
    const card = first.cards.get('group:55555');
    assert.equal(card.messageCount, 3);
    assert.equal(card.lines.length, 3);
    assert.deepEqual(card.participants.map((p) => p.user_id), [10001, 10002]);
    // 镜像（同一条消息转发给下游）不能算第二条。
    first.handleUpstreamEvent(groupMessage(14, '在吗'));
    const before = first.cards.get('group:55555').messageCount;
    assert.equal(before, 4);
    assert.equal(first.cards.stats.pending >= 1, true, '落盘是防抖排队，不是每条都写盘');
  });

  first.flushStorage();
  const file = path.join(dir, 'cards', `${safeName('group:55555')}.json`);
  check('会话卡·写入：落成 JSON 文件，坏文件不废整份目录', () => {
    assert.equal(fs.existsSync(file), true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.sessionKey, 'group:55555');
    assert.equal(raw.messageCount, 4);
    assert.equal(raw.participants.length, 2);
    fs.writeFileSync(path.join(dir, 'cards', 'broken.json'), '{不是 JSON', 'utf8');
  });

  const second = makeHub();
  check('会话卡·恢复：新进程读回落盘的那份，并自报"这是重启前那份"', () => {
    assert.equal(second.cards.stats.loaded, 1);
    assert.equal(second.cards.stats.skipped, 1, '坏文件跳过');
    assert.equal(second.timeline.bySession('group:55555').length, 0, '内存环确实是空的（L1 不回放）');
    const digest = second.cards.digestFor('group:55555');
    assert.equal(digest.resumed, true);
    assert.equal(digest.messageCount, 4);
    // 装配层真的会用它：环里没有这一会话时退回落盘的那张卡。
    const mind = new Mind({ hub: second, store: new MemoryStore({}), isolation: resolveIsolation({}) });
    const snap = mind.snapshot('group:55555');
    assert.match(snap.text, /重启前留下的那一份/);
    assert.match(snap.text, /那就火锅/);
    assert.match(snap.text, /从磁盘读回来/);
  });

  const off = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', storageDir: '' }, { log: () => {} });
  check('会话卡·开关：storageDir 为空时退化成纯内存（不建目录、功能仍可用）', () => {
    assert.equal(off.cards.enabled, false);
    assert.equal(off.capabilitiesSnapshot().cards.dir, null);
    off.handleUpstreamEvent(groupMessage(21, '没落盘也说得出这句话'));
    assert.equal(off.cards.get('group:55555').messageCount, 1);
  });

  try {
    second.stop();
  } catch {
    /* 没连链路 */
  }
  first.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function scenarioMembers() {
  // §23.6 的"@换称呼"最后一步：被 @ 的人常常一句话都没说过（事件里只有他的 QQ）。
  // 这一格验的是——hub 会**按需**问一次实现端，问到之后下一句就叫得出名字，
  // 而且只问缺的、问过就冷却、追问不再打扰上游。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-members-'));
  const asked = [];
  const members = new Map([
    ['10002', { user_id: '10002', nickname: '小刚', card: '刚哥', role: 'member' }],
  ]);
  const hub = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir: dir }, { log: () => {} });
  hub.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request(action, params) {
      asked.push({ action, params });
      if (action === 'get_group_member_info') {
        const data = members.get(String(params.user_id));
        if (!data) return { status: 'failed', retcode: 1400, msg: '查无此人' };
        return { status: 'ok', retcode: 0, data };
      }
      return { status: 'ok', retcode: 0, data: { message_id: 9000 + asked.length } };
    },
  };

  const atMessage = (messageId, qqs, text = '快看') => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: '40004000',
    message_id: messageId,
    group_id: 55555,
    user_id: 10001,
    sender: { user_id: 10001, nickname: '小明', role: 'member', card: '' },
    message: [...qqs.map((qq) => ({ type: 'at', data: { qq: String(qq) } })), { type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    time: Math.floor(Date.now() / 1000),
  });

  // 第一个 @ 是说话的自己（档案里刚记下名字），第二个才是真陌生人。
  hub.handleUpstreamEvent(atMessage(31, ['10001', '10002'], '刚哥看看这个'));
  await hub.members.pump();

  check('成员解析·按需问一次：@ 到没名字的人就去问实现端（只问缺的那个）', () => {
    const calls = asked.filter((a) => a.action === 'get_group_member_info');
    assert.equal(calls.length, 1, '只问了一个人（自己/已知的不问）');
    assert.equal(String(calls[0].params.group_id), '55555');
    assert.equal(String(calls[0].params.user_id), '10002');
    const snap = hub.capabilitiesSnapshot().members;
    assert.equal(snap.enabled, true);
    assert.equal(snap.learned, 1);
    assert.equal(snap.pending, 0);
  });

  check('成员解析·写档案：问回来的群名片进了档案（走的是同一条观测路）', () => {
    const person = hub.profiles.person('10002');
    assert.equal(nameIn(person, 'group:55555'), '刚哥', '群名片优先');
    assert.equal(person.names.some((n) => n.scope === 'group:55555' && n.name === '刚哥'), true);
  });

  // 再 @ 一次：这次档案里有名字了，段语义化应当直接叫名字，且不再打上游。
  const before = asked.length;
  hub.handleUpstreamEvent(atMessage(32, ['10002'], '在吗'));
  await hub.members.pump();
  const entry = hub.timeline.recent(1)[0];

  check('成员解析·下一句就叫得出名字（这一条也不再问上游）', () => {
    assert.equal(asked.length, before, '已经认识的人不再打扰实现端');
    assert.match(entry.text, /@刚哥/, '渲染成人话时用的是档案里的名字');
    assert.doesNotMatch(entry.text, /@用户10002/);
  });

  // 10099 实现端查无此人：失败也要记账，否则坏数据会被无限重试（await 得放在 check 外面——
  // `check` 是同步的，传个 async 函数进去会把它变成"永远通过"）。
  assert.equal(hub.members.note(atMessage(33, ['10099'])), 1);
  await hub.members.pump();

  check('成员解析·冷却：问过（哪怕没问出名字）的人短期内不会反复问', () => {
    assert.equal(hub.members.stats.failed >= 1, true);
    const skippedBefore = hub.members.stats.skipped;
    assert.equal(hub.members.note(atMessage(34, ['10099'])), 0, '冷却期内不再入队');
    assert.equal(hub.members.stats.skipped > skippedBefore, true, '而且算作"跳过"而不是"没看见"');
    // 已经认识的人连问都不问（走的是"只问缺的"那条路，跟冷却无关）。
    assert.equal(hub.members.note(atMessage(35, ['10002'])), 0);
  });

  // 实现端说"没这个接口"就停机（否则每次都要白等一次超时）。
  const hard = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir: '' }, { log: () => {} });
  let hardAsked = 0;
  hard.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request() {
      hardAsked += 1;
      return { status: 'failed', retcode: 1404, msg: '未知的 action' };
    },
  };
  hard.handleUpstreamEvent(atMessage(41, ['10003', '10004', '10005']));
  await hard.members.pump();

  check('成员解析·实现端不支持就停机（不把上游问烦）', () => {
    assert.equal(hardAsked, 1, '只问了一次就停手');
    assert.equal(hard.members.supported, false);
    assert.equal(hard.capabilitiesSnapshot().members.pending, 0);
    assert.equal(hard.members.note(atMessage(42, ['10006'])), 0, '停机后不再入队');
  });

  // 关掉开关：一条请求都不发（用户显式不想要这种行为时得真的做到）。
  const off = new Hub({ preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir: '', members: { enabled: false } }, { log: () => {} });
  let offAsked = 0;
  off.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request() {
      offAsked += 1;
      return { status: 'ok', retcode: 0, data: {} };
    },
  };
  off.handleUpstreamEvent(atMessage(51, ['10007']));
  await off.members.pump();

  check('成员解析·开关：members.enabled 为 false 时一个请求都不发', () => {
    assert.equal(off.members.enabled, false);
    assert.equal(offAsked, 0);
  });

  try {
    hub.stop();
  } catch {
    /* 没连链路 */
  }
  hard.stop();
  off.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function scenarioVision() {
  // M14-V：图片有两种处理手段——① 交给看得见图的会话代理（内容段）；② 自己用视觉模型看一次，
  // 把描述写进 L1 文本（任何模型都读得到）。这一格验的是第②条真的落到了文本与会话卡上，
  // 以及"同一张图只花一次钱"、关掉开关就一个字都不改。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vision-'));
  const hub = new Hub(
    { preset: 'relay', upstreamUrl: 'ws://127.0.0.1:3001', upstreamSelfId: '40004000', storageDir: dir },
    { log: () => {} },
  );
  hub.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request() {
      return { status: 'ok', retcode: 0, data: {} };
    },
  };

  let streams = 0;
  const streamArgs = [];
  const saved = [];
  const pngOf = (marker) =>
    `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]).toString('base64')}`;
  const catPng = pngOf(7);
  const otherPng = pngOf(8);

  hub.media.attach({
    async saveImage(input) {
      saved.push(input);
      return {
        attachmentId: `sha256:${'b'.repeat(64)}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 3,
        height: 3,
      };
    },
    async saveFile(input) {
      return { attachmentId: `file:${'c'.repeat(8)}`, mediaType: input.mediaType, bytes: input.data.length };
    },
  });
  hub.vision.attach({
    llm: {
      async *stream(input) {
        streams += 1;
        streamArgs.push(input);
        yield { type: 'text-delta', text: '一只橘猫趴在窗台上。' };
        yield { type: 'finish', reason: 'stop' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] };
      },
    },
  });

  const imageMessage = (messageId, file) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: '40004000',
    message_id: messageId,
    group_id: 55555,
    user_id: 10001,
    sender: { user_id: 10001, nickname: '小明', role: 'member', card: '' },
    message: [{ type: 'image', data: { file } }],
    raw_message: '[CQ:image,file=x]',
    font: 0,
    time: Math.floor(Date.now() / 1000),
  });

  const waitFor = async (fn, ms = 1500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  hub.handleUpstreamEvent(imageMessage(41, catPng));
  const done = await waitFor(() => /图片：一只橘猫/.test(String(hub.timeline.recent(1)[0]?.text ?? '')));
  const entry = hub.timeline.recent(1)[0];

  check('看图·describe：描述真的写回了这一条的人话（不是只存在 ref 里）', () => {
    assert.equal(done, true, '媒体落地与看图都是异步旁路，等它们跑完');
    assert.match(entry.text, /\[图片：一只橘猫趴在窗台上。\]/);
    assert.equal(entry.media?.[0]?.text, '一只橘猫趴在窗台上。');
    assert.match(String(entry.refs?.media?.[0] ?? ''), /^hub-media:/, 'durable ref 照旧');
    const caps = hub.capabilitiesSnapshot().vision;
    assert.equal(caps.mode, 'describe');
    assert.equal(caps.llm, true);
    assert.equal(caps.described, 1);
    assert.equal(caps.failed, 0);
  });

  check('看图·会话卡同步：卡里那一行也换了，同一轮上下文不会自相矛盾', () => {
    const card = hub.cards.get('group:55555');
    assert.equal(card.lines.at(-1).text.includes('图片：一只橘猫'), true);
  });

  // 同一张图再发一次（消息 id 不同、字节相同）：命中缓存，不再问第二次。
  hub.handleUpstreamEvent(imageMessage(42, catPng));
  await waitFor(() => (hub.capabilitiesSnapshot().vision.cached ?? 0) >= 1);
  const second = hub.timeline.recent(1)[0];

  check('看图·同一张图只花一次钱：字节相同就走缓存', () => {
    assert.equal(streams, 1, '视觉模型只被问过一次');
    assert.equal(hub.capabilitiesSnapshot().vision.cached >= 1, true);
    assert.match(second.text, /图片：一只橘猫/);
  });

  // 会话级识图模型（`/vmodel`，m01993）：新图按该会话的覆盖走，别的会话不受影响。
  hub.models = {
    visionFor: (sessionKey) => (sessionKey === 'group:55555' ? { provider: 'other', model: 'vision-x' } : null),
  };
  hub.handleUpstreamEvent(imageMessage(44, otherPng));
  await waitFor(() => hub.capabilitiesSnapshot().vision.described >= 2);

  check('识图模型·会话级覆盖：/vmodel 选的模型真的传进 llm.stream，且只影响这个会话', () => {
    assert.equal(streamArgs.length >= 2, true, '新图应当再问一次视觉模型（缓存键只按 sha256）');
    assert.equal(streamArgs.at(-1).provider, 'other');
    assert.equal(streamArgs.at(-1).model, 'vision-x');
    assert.equal(hub.vision.provider, '', '覆盖只作用于这次调用，模块默认仍是系统默认');
    assert.equal(hub.vision.model, '');
  });
  check('识图模型·没覆盖的会话照旧走系统默认（不继承别人的选择）', () => {
    assert.equal(hub.models.visionFor('group:66666'), null);
  });
  hub.models = null;

  // segment 手段：内容段交给会话代理（模型得先声明收得了图）。
  hub.vision.mode = 'both';
  const mind = new Mind({ hub, store: new MemoryStore({}), isolation: resolveIsolation({}) });
  const refsWithImage = {
    media: [
      { kind: 'image', attachmentId: 'sha256:one', mediaType: 'image/png', bytes: 9, width: 2, height: 2 },
      { kind: 'record', attachmentId: 'sha256:two', mediaType: 'audio/amr', bytes: 9 },
    ],
  };
  const parts = await mind.segmentPartsFor([refsWithImage]);
  const noImage = await mind.segmentPartsFor([{ media: [{ kind: 'record', attachmentId: 'sha256:two' }] }]);

  check('看图·segment：看得见图就给内容段，没图就不给', () => {
    assert.equal(Array.isArray(parts), true);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'image');
    assert.equal(parts[0].attachment.attachmentId, 'sha256:one');
    assert.equal(noImage, null, '只有语音时不该塞内容段');
  });

  // 模型不收图：这一步必须自己看出来并跳过，否则整轮会被宿主拒掉。
  hub.vision.attach({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: 'x' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text'] };
      },
    },
  });
  hub.vision.mode = 'segment';
  const textOnlyParts = await mind.segmentPartsFor([refsWithImage]);

  check('看图·降级：模型收不了图就不塞内容段（不让整轮白跑）', () => {
    assert.equal(textOnlyParts, null);
  });

  // 关掉开关：新图只留占位，一个字都不改。
  hub.vision.mode = 'off';
  const before = streams;
  hub.handleUpstreamEvent(imageMessage(43, otherPng));
  await new Promise((r) => setTimeout(r, 200));
  const third = hub.timeline.recent(1)[0];

  check('看图·开关：mode=off 时不发请求、不编描述', () => {
    assert.equal(streams, before);
    assert.match(third.text, /\[图片\]/);
    assert.equal(third.text.includes('一只橘猫'), false);
    assert.equal(hub.capabilitiesSnapshot().vision.mode, 'off');
  });

  try {
    hub.stop();
  } catch {
    /* 没连链路 */
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------- 场景：§26 人设 / 聊天命令 / 表情包 / 识番
async function scenarioChatFeatures() {
  // 这一格验的是"后挂模块接进 hub 之后，整条链路真的按设计的语义走"：
  // 命令被同步吞掉由 hub 自己回话（不转发、不唤醒）、非超管与 `!!` 不拦、
  // 人设只改本群、能量先漂移再装配、纯表情自动入库、识番结果并进同一条人话。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chat-'));
  const sent = [];
  const hub = new Hub(
    {
      preset: 'relay',
      upstreamUrl: 'ws://127.0.0.1:3001',
      upstreamSelfId: SELF_ID,
      storageDir: dir,
      memes: { enabled: true, autoCollect: true },
    },
    { log: () => {} },
  );
  hub.upstream = {
    isConnected: true,
    status: { connected: true, connects: 1 },
    stop() {},
    async request(action, params) {
      sent.push({ action, params });
      return { status: 'ok', retcode: 0, data: { message_id: 7000 + sent.length } };
    },
  };

  // 这一格必须有**真下游**：要证明的核心语义是"命令消息照常投下游、枢纽只是额外回一条"，
  // 没有下游链路的话 `delivered` 恒为 0，断言就退化成空话（老代码里正是这么被放过去的）。
  const ws = await import('ws');
  useWs(ws);
  const wss = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const downPort = wss.address().port;
  const received = [];
  const downstreamReady = new Promise((resolve) => {
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        try {
          received.push(JSON.parse(String(raw)));
        } catch {
          /* 非 JSON 帧（比如心跳）不算入站消息 */
        }
      });
      resolve(sock);
    });
  });
  hub.config.downstreamTargets = [{ url: `ws://127.0.0.1:${downPort}`, selfId: '30001000', nickname: 'fake-bot-app' }];
  hub.connectDownstreams();
  await downstreamReady;
  // 服务端的 'connection' 早于拨号端的 'open'：hub 是在 'open' 时才把这条链路登记进 worlds 的，
  // 这里不等一下，紧接着投递的那条事件会被"没有可用下游"吞掉，断言就假红。
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 装配方式与 `lib/index.js` 的 apply() 一致（后挂模块挂在 hub 上，services 是活引用）。
  const persona = new PersonaStore({ storage: hub.storage, log: () => {} });
  persona.load();
  persona.save({ name: '猫娘', role: '说话带喵', knowledges: [], hidden: false });
  const memes = new MemeStore({ storage: hub.storage, log: () => {} });
  const services = { hub, persona, memes, anime: null, imageGen: null };
  const chatCommands = new ChatCommands({
    log: () => {},
    services,
    config: { enabled: true, superUsers: ['10001'] },
  });
  hub.persona = persona;
  hub.memes = memes;
  hub.chatCommands = chatCommands;

  const waitFor = async (fn, ms = 1500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  let seq = 80000;
  const say = (text, userId = 10001, segments = null) =>
    groupMessage({ groupId: 55555, userId, messageId: (seq += 1), text, segments });
  const sentText = () =>
    sent
      .filter((m) => m.action === 'send_msg')
      .flatMap((m) => (Array.isArray(m.params?.message) ? m.params.message : []))
      .filter((s) => s?.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('\n');

  // ---- ② 聊天命令：枢纽自己回一条，但**不吞消息**（下游照样收到同名命令，模型不看）----
  const hookCalls = [];
  hub.hooks.onUpstreamEvent = (entry, info) => hookCalls.push(info);

  const r1 = hub.handleUpstreamEvent(say('/help'));
  await waitFor(() => sent.length > 0 && received.length > 0);
  check('聊天命令：超管的 /help 自己回一条，同时照常投下游（前缀撞车两个都触发）', () => {
    assert.equal(sent.length, 1, '枢纽应当用自己的身份回一条');
    const first = sent.find((m) => m.action === 'send_msg');
    assert.equal(first.params.message[0].type, 'reply', '群聊里回话要引用那句命令');
    assert.equal(first.params.group_id, 55555);
    assert.match(sentText(), /\/status/);
    assert.equal(received.length, 1, `下游必须照样收到这条命令——枢纽没有资格把它摘下来（实收 ${received.length} 帧）`);
    assert.equal(received[0].post_type, 'message', '下游拿到的是事件（hub 扮演实现端），不是 action');
    assert.match(JSON.stringify(received[0].message ?? ''), /\/help/);
    assert.notEqual(r1.dropped, 'chat-command:help', '不许再把命令消息从转发链路上摘掉');
  });
  check('聊天命令：命令消息只对**模型**静音（silent 标记），转发那一份不受影响', () => {
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].silent, 'chat-command', '枢纽已经用同一个账号答过，不该再让模型答一遍');
  });

  const before = sent.length;
  const receivedBefore = received.length;
  hub.handleUpstreamEvent(say('/help', 10002));
  hub.handleUpstreamEvent(say('!!/help'));
  hub.handleUpstreamEvent(say('/definitely-not-a-command'));
  await new Promise((r) => setTimeout(r, 200));
  check('聊天命令：非超管 / `!!` 绕开前缀 / 未知命令都不回话，消息各自照常走', () => {
    assert.equal(sent.length, before, '这三种情况枢纽一条都不该回');
    assert.equal(received.length, receivedBefore + 3, '但三条都要照常投给下游');
    assert.equal(chatCommands.stats.denied, 1, '非超管要留痕（但不回复）');
    assert.equal(chatCommands.stats.bypassed, 1);
    assert.equal(hookCalls.length, 4, '这三条照常喂给模型');
    assert.equal(hookCalls[3].silent, null, '只有枢纽自己处理的那条才静音');
  });

  // ---- ① 人设：改本群不泄漏给共用同一预设的别的群 ----
  hub.handleUpstreamEvent(say('/set_role 猫娘二号 说话带喵喵'));
  await waitFor(() => /喵喵/.test(persona.render('group:55555') ?? ''));
  check('人设：/set_role 只落在一个会话上，别的群看不到', () => {
    assert.match(persona.render('group:55555'), /喵喵/);
    assert.ok(!/喵喵/.test(persona.render('group:66666') ?? ''), '改一个群不该泄漏到别的群');
    assert.equal(persona.boundName('group:55555') !== persona.boundName('group:66666'), true);
  });

  // ---- ⑧④ 表情包：不自动收，由 agent 判断后收录（方案 v2）----
  const stickerPng = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]).toString('base64')}`;
  hub.handleUpstreamEvent(
    say('[CQ:image,file=x]', 10001, [{ type: 'image', data: { file: stickerPng, summary: '猫猫' } }]),
  );
  await new Promise((r) => setTimeout(r, 300));
  check('表情包：纯表情不再自动入库（收集是 agent 的决定）', () => {
    assert.equal(memes.stats.count, 0, '没有 agent 调用 collect 时不该有任何条目');
  });
  // agent 决定收录：直接走 store（= onebot_memes add 的后半段）
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
  const collected = await memes.collect({ bytes, mediaType: 'image/png', brief: '一只猫猫', keywords: '猫' });
  check('表情包：agent 收录后 id 出现在给模型看的清单里', () => {
    assert.equal(memes.stats.count >= 1, true);
    const list = memes.list();
    assert.equal(list.length >= 1, true);
    assert.match(memes.renderForPrompt({ limit: 8 }), new RegExp(list[0].id));
    assert.match(memes.renderForPrompt({ limit: 8 }), /不要编造 id/);
    assert.match(memes.renderForPrompt({ limit: 8 }), /一只猫猫/, '清单里该显示 agent 写的简介');
    assert.equal(collected?.savedBy, 'agent');
  });

  // 图文混排的消息本身不会触发任何收集（收集只来自 agent 调用）。
  const beforeCount = memes.stats.count;
  hub.handleUpstreamEvent(
    say('看这个', 10001, [
      { type: 'image', data: { file: `${stickerPng.slice(0, -4)}AAA=` } },
      { type: 'text', data: { text: '看这个' } },
    ]),
  );
  await new Promise((r) => setTimeout(r, 250));
  check('表情包：图文混排不会自己入库（唯一入口是 agent 的 add）', () => {
    assert.equal(memes.stats.count, beforeCount);
  });

  // ---- ⑥ 识番：接上后端之后，角色名和图片描述并进同一条人话 ----
  hub.anime = {
    enabled: true,
    stats: { backend: 'anime-recognize' },
    async recognize() {
      return { text: '[角色识别: 猫猫(92%)]', source: 'anime-recognize', characters: [{ name: '猫猫', confidence: 0.92 }], nsfw: false, cached: false, error: null };
    },
  };
  hub.media.attach({
    async saveImage(input) {
      return {
        attachmentId: `sha256:${'d'.repeat(64)}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 3,
        height: 3,
      };
    },
  });
  hub.vision.attach({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '一只橘猫。' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] };
      },
    },
  });
  hub.handleUpstreamEvent(
    say('[CQ:image,file=y]', 10001, [{ type: 'image', data: { file: `${stickerPng.slice(0, -4)}QkQ=` } }]),
  );
  // 这一格起了真下游，于是同一条消息会额外多出一行 `downstream-out` 时间线——
  // 拿 `recent(1)` 当"刚才那条"会挑到转发出站的那份（它的 text 是空的），必须按入站方向挑。
  const lastUpstream = () =>
    hub.timeline.bySession('group:55555').filter((e) => e.direction === 'upstream-in').at(-1);
  await waitFor(() => /角色识别/.test(String(lastUpstream()?.text ?? '')), 3000);
  if (process.env.M15_DEBUG) {
    console.error('[dbg] last=', JSON.stringify({ k: lastUpstream()?.kind, d: lastUpstream()?.direction, t: String(lastUpstream()?.text ?? '').slice(0, 120) }));
    console.error('[dbg] media.stats=', JSON.stringify({ cached: hub.media.stats.cached, blobs: hub.media.stats.blobs, failed: hub.media.stats.failed }));
    console.error('[dbg] vision.stats=', JSON.stringify({ described: hub.vision?.stats?.described, failed: hub.vision?.stats?.failed }));
  }
  check('识番：角色名与图片描述并进同一条人话（一次读字节，两条路都能看到）', () => {
    const entry = lastUpstream();
    assert.match(entry.text, /一只橘猫。/);
    assert.match(entry.text, /角色识别: 猫猫/);
    assert.equal(typeof hub.capabilitiesSnapshot().anime, 'object');
  });

  // ---- 门①（m30282）：看图先判"是不是二次元"，判否就不问角色识别 ----
  const recognizeCalls = [];
  hub.anime = {
    enabled: true,
    stats: { backend: 'anime-recognize' },
    async recognize(...args) {
      recognizeCalls.push(args);
      return { text: '[角色识别: 猫猫(92%)]', source: 'anime-recognize', characters: [{ name: '猫猫', confidence: 0.92 }], nsfw: false, cached: false, error: null };
    },
  };
  const describeQueue = [];
  hub.vision.attach({
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: describeQueue.shift() ?? '一只橘猫。' };
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] };
      },
    },
  });

  describeQueue.push('图片\n二次元：否\n一只真实的橘猫照片。');
  hub.handleUpstreamEvent(
    say('[CQ:image,file=y2]', 10001, [{ type: 'image', data: { file: `${stickerPng.slice(0, -4)}QkE=` } }]),
  );
  await waitFor(() => /一只真实的橘猫照片/.test(String(lastUpstream()?.text ?? '')), 3000);
  check('二次元门①：判否 → 不问角色识别（真实照片/截图不跑识别，m30282）', () => {
    assert.equal(recognizeCalls.length, 0, '判"否"就不该问后端');
    assert.doesNotMatch(String(lastUpstream()?.text ?? ''), /角色识别/, '连"未能识别"都不该出现');
  });

  describeQueue.push('图片\n二次元：是\n一个动漫风格的角色立绘。');
  hub.handleUpstreamEvent(
    say('[CQ:image,file=y3]', 10001, [{ type: 'image', data: { file: `${stickerPng.slice(0, -4)}QkI=` } }]),
  );
  await waitFor(() => /角色识别/.test(String(lastUpstream()?.text ?? '')), 3000);
  check('二次元门①：判是 → 照常问角色识别并渲染', () => {
    assert.equal(recognizeCalls.length, 1, '判"是"要问后端');
    assert.match(String(lastUpstream()?.text ?? ''), /动漫风格的角色立绘/);
    assert.match(String(lastUpstream()?.text ?? ''), /角色识别: 猫猫/);
  });
  // ---- 一轮完整回合：被 @ 唤醒 → 调 onebot_reply → 发出去，诊断要如实记 ----
  const pool = {
    async wake(agentKey, { setup }) {
      const ctx = {
        systemPrompt: { context() {} },
        tools: {
          register(def) {
            ctx.__tool = def;
          },
        },
      };
      setup?.(ctx);
      await ctx.__tool?.execute?.({ text: '好呀' });
      return { ok: true };
    },
  };
  const mind = new Mind({
    hub,
    timeline: hub.timeline,
    store: new MemoryStore({}),
    isolation: resolveIsolation({}),
    policy: resolveAgentPolicy({ mode: 'assist' }),
    pool,
    setup: (agentCtx, { reply }) => {
      agentCtx.tools?.register?.({
        name: 'onebot_reply',
        async execute(args = {}) {
          const candidate = reply.capture({ text: args.text });
          return candidate ? `queued:${candidate.text}` : 'empty';
        },
      });
    },
  });
  hub.hooks.onUpstreamEvent = (entry, info) => mind.observe(entry, info);
  hub.handleUpstreamEvent(
    say('@hub 在吗', 10001, [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ' 在吗' } },
    ]),
  );
  // 被 @ 是"立刻唤醒"路径：observe 会自己 fire-and-forget 一次 flush，这里等它跑完。
  const turned = await waitFor(() => mind.stats.lastTurn !== null, 3000);
  check('一轮完整回合：被 @ 唤醒 → 调 onebot_reply → 真的发出去，诊断如实记', () => {
    assert.equal(turned, true, '被 @ 应当触发一轮');
    assert.equal(mind.stats.lastTurn.ok, true);
    assert.equal(mind.stats.lastTurn.hadReply, true);
    assert.equal(mind.stats.lastTurn.spokeFrom, 'tool');
    assert.match(sentText(), /好呀/);
  });

  try {
    hub.stop();
  } catch {
    /* 没连链路 */
  }
  try {
    wss.close();
  } catch {
    /* 已经关了 */
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 主流程

const main = async () => {
  await scenarioReplyShape();
  const first = await scenarioReply();
  await scenarioSilence();
  await scenarioSilenceLookback();
  await scenarioBatchRichText();
  await scenarioDownstreamForward();
  await scenarioMentionIdentity();
  await scenarioWhitelistGate();
  await scenarioBatchTimeout();
  await scenarioActiveTick();
  await scenarioAwakeGraceAfterReply();
  await scenarioIsolationAssemble();
  await scenarioPool();
  await scenarioAssistantText();
  await scenarioAssistantTextSuppressed();
  await scenarioSendFailureNotice();
  await scenarioMultiMessageReply();
  await scenarioSteerInterject();
  await scenarioReplyBufferSurvivesSecondWake();
  await scenarioTurnErrorRecorded();
  await scenarioArchivedSessionGate();
  await scenarioCapability();
  await scenarioCapabilityDownstream();
  await scenarioAdminGate();
  await scenarioCapabilityPersistence();
  await scenarioProfiles();
  await scenarioReminders();
  await scenarioRecall();
  await scenarioMedia();
  await scenarioTurns();
  await scenarioLearn();
  await scenarioCards();
  await scenarioMembers();
  await scenarioVision();
  await scenarioChatFeatures();

  check('记忆写入全量：scope/visibility 只是标记，不丢条目', () => {
    assert.equal(first.store.stats.total >= 1, true);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  ← ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
};

await main();
