/**
 * 定时任务（`lib/tasks.js`）—— 纯逻辑测试，不碰宿主、不碰网络。
 *
 * 这里刻意用一个**假的** hub：`scheduleSvc` 记下每次 create/delete，`mind.reawake` 记下
 * 每次叫醒。真实的两个坑（宿主排期绑 sessionId、总机会话不能回收）都靠这两份记录断言。
 */

import assert from 'node:assert/strict';

const {
  TaskStore,
  parseWhen,
  whenLabel,
  encodeWhen,
  targetAllowed,
  isTaskSession,
  scheduleReminderOf,
  TASK_SESSION_KEY,
  MIN_EVERY_SECONDS,
} =
  await import('../lib/tasks.js');

let passed = 0;
let failed = 0;
const cases = [];
const pending = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    cases.push({ name, ok: false, error: String(err?.message ?? err) });
  }
}

function asyncCheck(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed += 1;
      } catch (err) {
        failed += 1;
        cases.push({ name, ok: false, error: String(err?.message ?? err) });
      }
    })(),
  );
}

/** 假 hub：把外部动作全记下来，断言看记录。 */
function makeHub({ groups = { '833194406': {} }, privates = {}, upstreamType = '' } = {}) {
  const calls = { created: [], deleted: [], pins: [], woke: [], ensured: [] };
  const hub = {
    config: { agentGroups: groups, agentPrivates: privates, upstreamType },
    hostRef: { pinSessionId: (key, id) => calls.pins.push({ key, id }) },
    mind: {
      ensured: calls.ensured,
      async ensureAgent(key) {
        calls.ensured.push(key);
        return key;
      },
      async reawake(target, opts) {
        calls.woke.push({ target, opts });
        return { woke: true, result: {} };
      },
      pool: { async retire() { return {}; } },
    },
    scheduleSvc: {
      async create(sessionId, req) {
        calls.created.push({ sessionId, req });
        return { id: `sch_${calls.created.length}`, scheduledAt: '2026-10-29T00:00:00.000Z' };
      },
      async delete({ sessionId, id }) {
        calls.deleted.push({ sessionId, id });
        return { id, deleted: true };
      },
    },
  };
  const storage = (() => {
    let data = null;
    return {
      read: () => data,
      write: (_name, value) => {
        data = value;
      },
      peek: () => data,
    };
  })();
  return { hub, calls, storage };
}

const now = Date.parse('2026-10-28T12:00:00+08:00');

check('when：四种写法都认，且各自映射到宿主的字段', () => {
  const at = parseWhen('at:2026-11-01T08:00', now);
  assert.equal(at.ok, true);
  assert.equal(at.when.kind, 'at');
  assert.match(at.host.at, /^2026-1[01]/);
  assert.equal(at.label, '2026-11-01 08:00');

  const after = parseWhen('after:3600', now);
  assert.equal(after.ok, true);
  assert.equal(after.host.after_seconds, 3600);
  assert.equal(after.label, '1 小时后');

  const every = parseWhen('every:600', now);
  assert.equal(every.host.every_seconds, 600);
  assert.equal(every.label, '每 10 分钟');

  const daily = parseWhen('every:daily@08:00', now);
  assert.equal(daily.ok, true);
  assert.equal(daily.host.daily.time, '08:00');
  assert.ok(daily.host.daily.time_zone, 'daily 必须带时区（宿主不收无时区的 daily）');
});

check('when：写错就说清错在哪，不猜', () => {
  assert.equal(parseWhen('', now).ok, false);
  assert.equal(parseWhen('tomorrow', now).ok, false);
  assert.match(parseWhen('at:2020-01-01T00:00', now).error, /已经过去/);
  assert.match(parseWhen('every:5', now).error, new RegExp(`最短 ${MIN_EVERY_SECONDS} 秒`));
  assert.match(parseWhen('every:daily@25:00', now).error, /不合法/);
  assert.match(parseWhen('after:0', now).error, /秒数/);
});

check('whenLabel / encodeWhen 双向一致（轮换要靠它把节奏原样搬过去）', () => {
  for (const raw of ['after:600', 'every:900', 'every:daily@07:30']) {
    const parsed = parseWhen(raw, now);
    assert.equal(encodeWhen(parsed.when), raw);
    assert.equal(whenLabel(parsed.when), parsed.label);
  }
});

check('target：只认 group:/private:，裸号码不认', () => {
  assert.equal(targetAllowed({ agentGroups: { '833194406': {} } }, 'group:833194406'), true);
  assert.equal(targetAllowed({ agentGroups: { '833194406': {} } }, 'group:999'), false);
  assert.equal(targetAllowed({ agentPrivates: { '945126014': {} } }, 'private:945126014'), true);
  // 官方上游：白名单不生效，任何会话都允许（与 `m34897` 同一条口径）
  assert.equal(targetAllowed({ upstreamType: 'official', agentGroups: {} }, 'group:1'), true);
});

asyncCheck('create：校验在前——空 title / 空 prompt / 坏的 when 都不会碰宿主', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  assert.equal((await store.create({ title: '', prompt: 'x', when: 'after:60' })).ok, false);
  assert.equal((await store.create({ title: 't', prompt: '', when: 'after:60' })).ok, false);
  assert.equal((await store.create({ title: 't', prompt: 'x', when: 'whenever' })).ok, false);
  assert.equal(calls.created.length, 0, '校验没过就不该建排期');
  assert.equal(calls.pins.length, 0, '也不该去建总机会话');
});

asyncCheck('create：成功时排期落在总机会话上，selector 就是 when 的映射', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const r = await store.create({
    title: '交周报',
    prompt: '提醒大家交周报',
    when: 'every:daily@08:00',
    createdBy: 'group:833194406',
  });
  assert.equal(r.ok, true);
  assert.match(r.id, /^tsk_/);
  assert.equal(r.wakes, 'group:833194406', '不写 target 就叫醒创建它的会话');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].sessionId, 'onebot-hub:tasks');
  assert.equal(calls.created[0].req.daily.time, '08:00');
  assert.equal(
    calls.created[0].req.prompt,
    '[定时提醒]',
    '宿主那句只留标记：枢纽靠 schedule_id 认任务，写指令只会让总机会话真去调',
  );
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].prompt, '提醒大家交周报', '存的是正文，不是提醒帧');
});

asyncCheck('create：target 不在名单里就拒（源头拦住，别等到点才发现）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const r = await store.create({ title: 't', prompt: 'x', when: 'after:60', target: 'group:123', createdBy: 'group:833194406' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不在这个插件的会话名单里/);
  assert.equal(calls.created.length, 0);
});

asyncCheck('create：宿主没有 schedule 服务时说人话，不静默当成功', async () => {
  const { hub, storage } = makeHub();
  hub.scheduleSvc = null;
  const store = new TaskStore({ storage, hub });
  const r = await store.create({ title: 't', prompt: 'x', when: 'after:60', createdBy: 'group:833194406' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有 schedule 服务/);
});

asyncCheck('同一次到点被看见两次也只叫醒一次（宿主会发两个事件）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: '复测', prompt: '报到', when: 'after:20', createdBy: 'group:833194406' });
  const saved = store.all().find((x) => x.id === t.id);
  // 真机上 `agent/inbox/spliced` 与 `user/message` 会先后到，枢纽两条都会处理（`m36360`）
  const [a, b] = await Promise.all([
    store.fireBySchedule(saved.scheduleId),
    store.fireBySchedule(saved.scheduleId),
  ]);
  assert.equal(calls.woke.length, 1, '只该叫醒一次');
  assert.equal([a, b].filter((r) => r?.already === true).length, 1, '第二份要如实回"已经投过了"');
});

check('isTaskSession：宿主给的总机 id 带激活后缀与编码，也得认', () => {
  // 真机形态（`m36229`）：只比 `onebot-hub:tasks` 会把它判成外部会话
  assert.equal(isTaskSession(['onebot-hub:task%3Ahub.amvsc078sdd07']), true);
  assert.equal(isTaskSession(['onebot-hub:task:hub.amvsc078sdd07']), true);
  assert.equal(isTaskSession([TASK_SESSION_KEY]), true);
  assert.equal(isTaskSession(['', 'onebot-hub:tasks']), false, '这是个错 id，别放宽到认它');
  assert.equal(isTaskSession(['onebot-hub:tasks'], 'onebot-hub:tasks'), true, '记录里的真身要认');
  assert.equal(isTaskSession(['onebot-hub:task%3Ahub.abc', null], 'onebot-hub:task%3Ahub.abc'), true);
  assert.equal(isTaskSession(['group:833194406']), false);
  assert.equal(isTaskSession(['onebot-hub:group%3A833194406.amv1']), false);
  assert.equal(isTaskSession([]), false);
});

asyncCheck('fire：只有总机会话能调；普通会话调会被告知用 create', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  const denied = await store.fire(t.id, { caller: 'group:833194406' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /内部动作/);
  assert.equal(calls.woke.length, 0, '被拒时不该叫醒任何人');

  const done = await store.fire(t.id, { caller: TASK_SESSION_KEY });
  assert.equal(done.ok, true);
  assert.equal(calls.woke.length, 1);
  assert.equal(calls.woke[0].target, 'group:833194406');
  assert.match(calls.woke[0].opts.text, /交周报提醒|t/);
  assert.equal(store.list()[0].lastResult, '静默', '目标没说话时记"静默"，不记失败');
});

asyncCheck('fire：60 秒内重复触发返回 already（不报错，免得模型开始"想办法"）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  assert.equal((await store.fire(t.id, { caller: TASK_SESSION_KEY })).ok, true);
  const again = await store.fire(t.id, { caller: TASK_SESSION_KEY });
  assert.equal(again.ok, true, '重复投递是正常情况，不该判失败');
  assert.equal(again.already, true);
  assert.match(again.note, /枢纽投递过/);
  assert.equal(calls.woke.length, 1);
});

asyncCheck('run：手动跑不受去重限制（调试时连着试两次是正常的）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  await store.run(t.id, { caller: 'group:833194406' });
  const second = await store.run(t.id, { caller: 'group:833194406' });
  assert.equal(second.ok, true, 'run 不该被 fire 的去重挡住');
  assert.equal(calls.woke.length, 2);
});

check('scheduleReminderOf：认得出宿主注入的 [SCHEDULE REMINDER]', () => {
  // 真机形态（m36229）：user/message 里正文以 [SCHEDULE REMINDER] 开头，带 schedule_id_json
  const ev = {
    type: 'user/message',
    data: {
      content: [
        {
          type: 'text',
          text: '[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-2b0e4b8e-54c3-4eb0-bbc5-814d22f919f4"',
        },
      ],
    },
  };
  assert.deepEqual(scheduleReminderOf(ev), { scheduleId: 'schedule-2b0e4b8e-54c3-4eb0-bbc5-814d22f919f4' });
  // inbox/spliced 那种嵌套形态也认
  const spliced = {
    type: 'agent/inbox/spliced',
    data: { inserted: [{ content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-x1"' }] }] },
  };
  assert.deepEqual(scheduleReminderOf(spliced), { scheduleId: 'schedule-x1' });
  assert.equal(scheduleReminderOf({ type: 'user/message', data: { content: [{ type: 'text', text: '普通消息' }] } }), null);
  assert.equal(scheduleReminderOf({ type: 'tool/call', data: {} }), null);
  assert.equal(scheduleReminderOf(null), null);
});

asyncCheck('fireBySchedule：按 scheduleId 找回任务并投递（枢纽自己走的路）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: '早安', prompt: '说句早安', when: 'every:600', createdBy: 'group:833194406' });
  const saved = store.all().find((x) => x.id === t.id);
  assert.ok(saved.scheduleId, 'create 之后要记住 scheduleId');
  const r = await store.fireBySchedule(saved.scheduleId);
  assert.equal(r.ok, true);
  assert.equal(calls.woke.length, 1);
  assert.equal(calls.woke[0].target, 'group:833194406');

  const unknown = await store.fireBySchedule('schedule-nope');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有对应/);
});

asyncCheck('fire：目标叫不醒时记失败并如实返回（不假装成功）', async () => {
  const { hub, storage } = makeHub();
  hub.mind.reawake = async () => ({ woke: false, reason: '会话没起来' });
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  const r = await store.fire(t.id, { caller: TASK_SESSION_KEY });
  assert.equal(r.ok, false);
  assert.match(r.error, /没成功/);
  assert.match(store.list()[0].lastResult, /失败/);
});

asyncCheck('fire：目标那一轮还没结束时不干等（真机上挂 140 秒被宿主判 aborted）', async () => {
  const { hub, storage } = makeHub();
  // 模拟"目标会话正在对话中，reawake 排队等它落定"
  hub.mind.reawake = () => new Promise((r) => setTimeout(() => r({ woke: true }), 60_000));
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  const started = Date.now();
  const r = await store.fire(t.id, { caller: TASK_SESSION_KEY });
  const spent = Date.now() - started;
  assert.equal(r.ok, true, '排队中也要算投递成功，不能报失败');
  assert.equal(r.queued, true);
  assert.ok(spent < 20_000, `fire 不该干等，实际等了 ${spent}ms`);
  assert.match(store.list()[0].lastResult, /已投递/);
});

asyncCheck('remove：本地记录与宿主排期一起删；宿主那边没有也算成功', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  const r = await store.remove(t.id);
  assert.equal(r.ok, true);
  assert.equal(r.hostDeleted, true);
  assert.equal(calls.deleted.length, 1);
  assert.equal(store.list().length, 0);

  const t2 = await store.create({ title: 't2', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  hub.scheduleSvc.delete = async ({ id }) => ({ id, deleted: false });
  const r2 = await store.remove(t2.id);
  assert.equal(r2.ok, true, '宿主里已经没有了，本地记录仍要能清掉');
  assert.equal(r2.hostDeleted, false);
  assert.match(r2.note, /本来就没有/);
});

asyncCheck('remove：宿主删除抛错时别删本地记录（否则排期还在响、却找不到它了）', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 't', prompt: 'x', when: 'every:600', createdBy: 'group:833194406' });
  hub.scheduleSvc.delete = async () => {
    throw new Error('宿主忙');
  };
  const r = await store.remove(t.id);
  assert.equal(r.ok, false);
  assert.equal(store.list().length, 1, '记录必须留着，还能再删一次');
});

asyncCheck('总机会话的 id 钉死并跨重启复用（宿主的排期绑着它）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  await store.ensureSession();
  assert.equal(calls.pins.length, 1);
  assert.equal(calls.pins[0].key, TASK_SESSION_KEY);
  assert.equal(calls.pins[0].id, 'onebot-hub:tasks');
  assert.equal(calls.ensured.length, 1);

  // 重启：新实例从盘上读回同一个 id，而不是新造一个
  const again = new TaskStore({ storage, hub });
  again.load();
  await again.ensureSession();
  assert.equal(calls.pins.at(-1).id, 'onebot-hub:tasks', '重启后必须沿用同一个 id');
});

asyncCheck('resetEvery：触发够数就换会话，排期整体搬过去，旧的全部删掉', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 2 });
  const a = await store.create({ title: 'a', prompt: 'pa', when: 'every:600', createdBy: 'group:833194406' });
  const b = await store.create({ title: 'b', prompt: 'pb', when: 'every:daily@09:00', createdBy: 'group:833194406' });
  const before = calls.created.length;
  await store.fire(a.id, { caller: TASK_SESSION_KEY });
  assert.equal(store.sessionId, 'onebot-hub:tasks', '还没到阈值，不换');
  await store.fire(b.id, { caller: TASK_SESSION_KEY });
  assert.match(store.sessionId, /^onebot-hub:tasks\.r/, '到阈值换新会话');
  const rebuilt = calls.created.slice(before);
  assert.equal(rebuilt.length, 2, '两条任务都要搬到新会话上');
  assert.ok(rebuilt.every((c) => c.sessionId === store.sessionId));
  assert.equal(calls.deleted.length, 2, '旧排期要删掉，否则同一任务两边各响');
  assert.equal(store.list().every((t) => t.fireCount === 0), true, '计数器归零');
});

asyncCheck('resetEvery：搬迁中途失败就整体回滚，旧会话继续用（宁可上下文涨，不能丢任务）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  const a = await store.create({ title: 'a', prompt: 'pa', when: 'every:600', createdBy: 'group:833194406' });
  const real = hub.scheduleSvc.create;
  hub.scheduleSvc.create = async (sessionId, req) => {
    if (String(sessionId).includes('.r')) throw new Error('宿主拒绝');
    return real(sessionId, req);
  };
  const r = await store.fire(a.id, { caller: TASK_SESSION_KEY });
  assert.equal(r.ok, true, '触发本身是成功的，只是轮换失败');
  assert.equal(store.sessionId, 'onebot-hub:tasks', '要退回旧会话');
  assert.equal(store.list().length, 1, '任务不能丢');
  assert.equal(calls.deleted.length, 0, '一条新排期都没建成，就没有要回滚的');
});

asyncCheck('落盘：重启用 load() 读回任务与计数器（否则每次重启都要重建）', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const t = await store.create({ title: 'a', prompt: 'pa', when: 'every:600', createdBy: 'group:833194406' });
  await store.fire(t.id, { caller: TASK_SESSION_KEY });
  const again = new TaskStore({ storage, hub });
  const info = again.load();
  assert.equal(info.tasks, 1);
  const [restored] = again.list();
  assert.equal(restored.id, t.id);
  assert.equal(restored.prompt, 'pa');
  assert.equal(restored.fireCount, 1);
  assert.equal(restored.lastResult, '静默');
});

await Promise.all(pending);

console.log(JSON.stringify({ passed, failed, cases }, null, 2));
if (failed > 0) process.exitCode = 1;
