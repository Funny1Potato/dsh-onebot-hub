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
  scheduleRemindersOf,
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

check('scheduleRemindersOf：读取宿主的周期批次，忽略变更通知与坏载荷', () => {
  const block = (text) => ({ content: [{ type: 'text', text }] });
  const prefix = '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ';
  const event = { type: 'agent/inbox/spliced', data: { inserted: [
    block('[SCHEDULE CHANGE]\nchange: deleted\nschedule_id_json: "deleted-id"'),
    block(prefix + JSON.stringify([
      { schedule_id: 'daily-1', occurrence_at: '2026-10-28T12:00:00Z', reminder_prompt: 'schedule_id_json: "fake-id"' },
      { schedule_id: 'every-2' }, { schedule_id: 'daily-1' }, { schedule_id: 'invalid id' }, null,
    ])),
    block(prefix + '[{"schedule_id":"broken"}'),
    block('[SCHEDULE REMINDER]\nschedule_id_json: "once-3"'),
  ] } };
  assert.deepEqual(scheduleRemindersOf(event), ['daily-1', 'every-2', 'once-3']);
  assert.deepEqual(scheduleRemindersOf({ type: 'user/message', data: block('schedule_id_json: "not-a-reminder"') }), []);
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

asyncCheck('归属：别人的任务看不到、删不掉、跑不了（m85249 P1-4）', async () => {
  const { hub, calls, storage } = makeHub({
    groups: { '833194406': {}, '617770183': {} },
  });
  const store = new TaskStore({ storage, hub });
  const mine = await store.create({
    title: '我这边的',
    prompt: 'p',
    when: 'after:60',
    target: 'group:833194406',
    createdBy: 'group:833194406',
  });
  assert.equal(mine.ok, true);

  // 另一个群：看不见、删不掉（且不能真的去动宿主排期）、跑不了（不能白花一次模型调用）
  assert.equal(store.list({ owner: 'group:617770183' }).length, 0, '别人的任务不该出现在 list 里');
  const gone = await store.remove(mine.id, { caller: 'group:617770183' });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /不是你排的/);
  assert.equal(calls.deleted.length, 0, '被拒的删除不能真去动宿主');
  const ran = await store.run(mine.id, { caller: 'group:617770183' });
  assert.equal(ran.ok, false);
  assert.match(ran.error, /跑不了/);
  assert.equal(calls.woke.length, 0, '被拒的 run 不该叫醒任何人');

  // 自己：看得到、删得掉
  assert.equal(store.list({ owner: 'group:833194406' }).length, 1);
  assert.equal((await store.remove(mine.id, { caller: 'group:833194406' })).ok, true);
});

asyncCheck('归属：到点要叫醒的那个会话也算主人（老数据 createdBy 会退回 target）', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  await store.create({ title: 't', prompt: 'p', when: 'after:60', target: 'group:833194406', createdBy: 'private:945126014' });
  // 建它的是私聊，叫醒的是群——两边都该管得着
  assert.equal(store.list({ owner: 'group:833194406' }).length, 1);
  assert.equal(store.list({ owner: 'private:945126014' }).length, 1);
  assert.equal(store.list({ owner: 'group:617770183' }).length, 0);
});

asyncCheck('一次性任务响过就退场，不再占名额、轮换也不复活（m85249 P2-7）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 99 });
  const once = await store.create({ title: '一次', prompt: 'p', when: 'after:60', target: 'group:833194406', createdBy: 'group:833194406' });
  const out = await store.fire(once.id, {});
  assert.equal(out.ok, true);
  assert.equal(out.finished, true, '一次性任务响完要标结束');
  assert.equal(store.list().length, 0, '默认 list 不该再列出它');
  assert.equal(store.list({ all: true }).length, 1, 'all:true 还看得见历史');
  const again = await store.fire(once.id, {});
  assert.equal(again.ok, false, '结束了就不该再响');

  // 每轮都有的任务不为所动
  const every = await store.create({ title: '每个', prompt: 'p', when: 'every:600', target: 'group:833194406', createdBy: 'group:833194406' });
  const r2 = await store.fire(every.id, {});
  assert.equal(r2.ok, true);
  assert.equal(r2.finished, undefined, '循环任务不标 finished');
  assert.equal(store.list().length, 1);
});

asyncCheck('暂停：删宿主排期、记录留着，恢复时重新排一次（m85685）', async () => {
  const { hub, calls, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 99 });
  const made = await store.create({ title: '每十分钟', prompt: 'p', when: 'every:600', target: 'group:833194406', createdBy: 'group:833194406' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(store.list()[0].paused, undefined, '新建的不该带 paused');

  const paused = await store.pause(made.id, { caller: 'group:833194406' });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(calls.deleted.length, 1, '宿主的排期要删掉（不然暂停了照样会响）');
  const rec = store.list()[0];
  assert.equal(rec.paused, true);
  assert.equal(rec.scheduleId, '', '暂停后不该还留着一个排期 id');
  assert.equal(rec.prompt, 'p', '暂停不动 prompt——恢复就是为了不用重写它');
  assert.equal(store.list().length, 1, '记录还在，只是不响');

  // 再暂停一次是幂等的
  const twice = await store.pause(made.id, { caller: 'group:833194406' });
  assert.equal(twice.already, true);
  assert.equal(calls.deleted.length, 1);

  const resumed = await store.resume(made.id, { caller: 'group:833194406' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(calls.created.length, 2, '恢复要真的重新向宿主排一次');
  assert.equal(store.list()[0].paused, false);
  assert.ok(store.list()[0].scheduleId, '恢复后要有新的排期 id');
});

asyncCheck('暂停：不是主人就停不了，一次性任务恢复要看时间还成不成立', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 99 });
  const made = await store.create({ title: '私聊排的', prompt: 'p', when: 'every:600', target: 'group:833194406', createdBy: 'private:945126014' });
  const no = await store.pause(made.id, { caller: 'group:617770183' });
  assert.equal(no.ok, false);
  assert.match(String(no.error), /不是你排的/);

  const once = await store.create({ title: '一次', prompt: 'p', when: 'after:120', target: 'group:833194406', createdBy: 'group:833194406' });
  assert.equal((await store.pause(once.id, { caller: 'group:833194406' })).ok, true);
  const back = await store.resume(once.id, { caller: 'group:833194406' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.match(String(back.every), /分钟|小时|秒/, `恢复后要有节拍说明：${back.every}`);
});

asyncCheck('暂停的任务不会被叫醒，轮换也不会把它搬过去（复审 F11）', async () => {
  const { hub, storage, calls } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 99 });
  const made = await store.create({ title: '先别响', prompt: 'p', when: 'every:600', target: 'group:833194406', createdBy: 'group:833194406' });
  await store.pause(made.id, { caller: 'group:833194406' });
  const wokeBefore = calls.woke.length;
  const out = await store.fire(made.id, {});
  assert.equal(out.ok, false, '暂停的任务不该被 fire 叫醒');
  assert.match(String(out.error), /暂停/);
  assert.equal(calls.woke.length, wokeBefore, '一次模型调用都不该花');
  // 轮换只搬"活着且没暂停"的：把 resetEvery 压到 1 也不会重建暂停那条。
  const small = new TaskStore({ storage, hub, resetEvery: 1 });
  small.load();
  await small.fireBySchedule(made.scheduleId ?? '', {});
  assert.equal(small.list({ all: true }).find((t) => t.id === made.id)?.paused, true, '暂停状态得留着');
});

asyncCheck('手动试跑不退场，也不触发轮换（复审 F12）', async () => {
  const { hub, storage, calls } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  const once = await store.create({ title: '一次性', prompt: 'p', when: 'after:600', target: 'group:833194406', createdBy: 'group:833194406' });
  const createdBefore = calls.created.length;
  const out = await store.run(once.id, { caller: 'group:833194406' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.finished, undefined, '试跑不该把一次性任务标成结束');
  assert.equal(store.list().some((t) => t.id === once.id), true, '它还该在列表里');
  assert.equal(calls.created.length, createdBefore, '试跑不该重建任何排期');
  // 到点真响一次才退场。换一个 store 读同一份盘：`#fired` 的 60 秒去重只活在内存里。
  const fresh = new TaskStore({ storage, hub, resetEvery: 1 });
  fresh.load();
  const real = await fresh.fireBySchedule(fresh.list().find((t) => t.id === once.id).scheduleId ?? '', {});
  assert.equal(real.ok, true, JSON.stringify(real));
  assert.equal(real.finished, true, '这次是真响，一次性任务该退场');
  assert.equal(fresh.list().some((t) => t.id === once.id), false, '真响过就该退场');
});

asyncCheck('试跑不占正式那本去重账：试完紧接着到点，还得真响（第三轮 T11）', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub });
  const once = await store.create({ title: '一次性', prompt: 'p', when: 'after:600', target: 'group:833194406', createdBy: 'group:833194406' });
  const trial = await store.run(once.id, { caller: 'group:833194406' });
  assert.equal(trial.ok, true, JSON.stringify(trial));
  // 同一个 store、60 秒之内：正式那次不能被试跑"占位"。
  const key = store.list().find((t) => t.id === once.id)?.scheduleId ?? '';
  const real = await store.fireBySchedule(key, {});
  assert.equal(real.already, undefined, '试跑不许把到点那次当成"已经投过了"');
  assert.equal(real.ok, true, JSON.stringify(real));
});

asyncCheck('排队中的一次性任务不被轮换重建（第三轮 T11）', async () => {
  const { hub, storage, calls } = makeHub();
  // 叫醒一直不落地：这样 fire 会走"已投递，等那边空下来"的排队分支。
  hub.mind.reawake = () => new Promise(() => {});
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  const once = await store.create({ title: '排队那条', prompt: 'p', when: 'after:600', target: 'group:833194406', createdBy: 'group:833194406' });
  const createdBefore = calls.created.length;
  const out = await store.fire(once.id, {});
  assert.equal(out.queued, true, JSON.stringify(out));
  assert.equal(calls.created.length, createdBefore, '在飞的一次性任务不该被轮换再排一遍');
  assert.equal(store.list().some((t) => t.id === once.id), true, '它还该在列表里');
});

asyncCheck('旧 catalog：已结束的 beta.4 任务退出，过期但仍 active 的任务保留，未来时间按宿主原值搬迁', async () => {
  const { hub, storage, calls } = makeHub();
  const sessionId = 'onebot-hub:tasks';
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_123).toISOString();
  const base = { active: true, sessionId, prompt: 'p', target: 'group:833194406' };
  const local = (id, when, nextAt) => ({ ...base, id, title: id, scheduleId: `sch-${id}`, when, nextAt });
  storage.write('tasks', { sessionId, tasks: [
    local('ticker', { kind: 'every', seconds: 600 }, future),
    { ...local('stale', { kind: 'after', seconds: 60 }, past), lastAt: Date.parse(past) + 1_001, lastResult: '静默', fireCount: 2 },
    local('missing', 'after:60', 'bad-date'),
    local('due', { kind: 'after', seconds: 60 }, past),
    local('future', { kind: 'after', seconds: 60 }, 'bad-date'),
  ] });
  hub.scheduleSvc.catalog = async () => [
    { id: 'sch-stale', status: 'inactive', scheduledAt: past, lastDelivery: { scheduledAt: past, deliveredAt: past, messageId: 'msg-old' } },
    { id: 'sch-due', status: 'active', scheduledAt: past },
    { id: 'sch-future', status: 'active', scheduledAt: future },
  ];
  const archived = [];
  hub.hostRef.retireSessionId = async (id) => archived.push(id);
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  store.load();
  await store.ensureSession();
  assert.deepEqual(store.list().map((t) => t.id), ['ticker', 'due', 'future']);
  const stale = storage.peek().tasks.find((t) => t.id === 'stale');
  assert.equal(stale.active, false);
  assert.equal(stale.finishedAt, Date.parse(past));
  assert.equal(stale.nextAt, '');
  assert.equal(stale.lastResult, '静默');
  assert.equal(store.list().find((t) => t.id === 'future').nextAt, future);

  assert.equal((await store.fireBySchedule('sch-ticker')).ok, true);
  assert.equal(store.sessionId, sessionId, '仍有已到期的真实宿主排期，不得提前退役总机');
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(archived, []);
  assert.equal((await store.fireBySchedule('sch-due')).finished, true);
  assert.match(store.sessionId, /\.r/);
  assert.deepEqual(calls.created.map(({ req }) => ({ title: req.title, at: req.at })), [
    { title: 'ticker', at: undefined }, { title: 'future', at: future },
  ]);
  assert.deepEqual(calls.deleted.map((d) => d.id), ['sch-ticker', 'sch-future']);
  assert.deepEqual(archived, [sessionId]);
  assert.equal(store.list().find((t) => t.id === 'future').nextAt, future);
});

asyncCheck('新 view：手动投递回执不能结束 active 任务，已入队的 ended 任务仍待本地接管', async () => {
  const { hub, storage } = makeHub();
  const sessionId = 'onebot-hub:tasks';
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const make = (id) => ({ id, title: id, prompt: 'p', target: 'group:833194406', active: true,
    when: { kind: 'after', seconds: 60 }, nextAt: 'bad-date', scheduleId: id, sessionId });
  const rows = new Map([
    ['armed', { id: 'armed', status: 'active', scheduledAt: future, lastDelivery: { scheduledAt: past, deliveredAt: past, messageId: 'manual' } }],
    ['inbox', { id: 'inbox', status: 'ended', scheduledAt: past, lastDelivery: { scheduledAt: past, deliveredAt: past, messageId: 'queued', targetSessionId: sessionId } }],
    ['execution', { id: 'execution', status: 'ended', scheduledAt: past, executionActive: true }],
    ['ended', { id: 'ended', status: 'ended', scheduledAt: past }],
  ]);
  storage.write('tasks', { sessionId, tasks: [...rows.keys()].map(make) });
  let inbox = [{ id: 'queued' }];
  const writes = [];
  hub.hostRef.getLive = (id) => id === sessionId ? { inbox: { nextTurn: inbox, nextStep: [] } } : null;
  hub.scheduleSvc = {
    async view({ id }) { return rows.get(id) ?? { id, code: 'schedule_not_found' }; },
    async create(req) {
      writes.push(req);
      return { id: 'new', scheduledAt: future };
    },
    async edit(req) {
      writes.push(req);
      return { id: req.id, deleted: true };
    },
  };
  const store = new TaskStore({ storage, hub });
  store.load();
  await store.ensureSession();
  assert.deepEqual(store.list().map((t) => t.id), ['armed', 'inbox', 'execution']);
  assert.equal(store.list()[0].nextAt, future);
  assert.equal((await store.fireBySchedule('inbox')).finished, true);
  inbox = [];
  rows.get('execution').executionActive = false;
  await store.ensureSession();
  assert.deepEqual(store.list().map((t) => t.id), ['armed']);
  const made = await store.create({ title: 'new', prompt: 'p', when: 'after:60', createdBy: 'group:833194406' });
  assert.equal(made.ok, true);
  assert.equal((await store.remove(made.id)).hostDeleted, true);
  assert.deepEqual(writes, [
    { title: 'new', prompt: '[定时提醒]', timing: { kind: 'after', after_seconds: 60 }, target: { kind: 'session', sessionId } },
    { id: 'new', action: 'delete' },
  ]);
});

asyncCheck('并发恢复和删除：等待宿主 create 的结果，删除最终排期且不留孤儿', async () => {
  const { hub, storage, calls } = makeHub();
  const store = new TaskStore({ storage, hub });
  const made = await store.create({ title: 'resume race', prompt: 'p', when: 'every:600', createdBy: 'group:833194406' });
  assert.equal((await store.pause(made.id)).ok, true);
  const entered = deferred();
  const finishCreate = deferred();
  hub.scheduleSvc.create = async () => {
    entered.resolve();
    return finishCreate.promise;
  };
  const resumed = store.resume(made.id);
  await entered.promise;
  const duplicate = store.resume(made.id);
  const removed = store.remove(made.id);
  const settledEarly = await Promise.race([removed.then(() => true), new Promise((r) => setImmediate(() => r(false)))]);
  finishCreate.resolve({ id: 'sch-resumed', scheduledAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await resumed).ok, true);
  assert.equal((await duplicate).already, true);
  assert.equal((await removed).hostDeleted, true);
  assert.equal(settledEarly, false);
  assert.deepEqual(calls.deleted.map((d) => d.id), ['sch_1', 'sch-resumed']);
  assert.deepEqual(store.all(), []);
});

asyncCheck('旧投递结束不能结束重新恢复后的一次性任务', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  const once = await store.create({ title: 'once', prompt: 'p', when: 'after:60', createdBy: 'group:833194406' });
  const recurring = await store.create({ title: 'tick', prompt: 'p', when: 'every:600', createdBy: 'group:833194406' });
  const wake = deferred();
  hub.mind.reawake = (_target, opts) => opts.summary.endsWith('once') ? wake.promise : { woke: true };
  const old = store.fire(once.id);
  const del = hub.scheduleSvc.delete;
  hub.scheduleSvc.delete = async (req) => {
    assert.equal((await store.fire(recurring.id)).ok, true);
    return del(req);
  };
  assert.equal((await store.pause(once.id)).ok, true);
  assert.equal((await store.resume(once.id)).ok, true);
  const restoredId = store.list().find((t) => t.id === once.id).scheduleId;
  wake.resolve({ woke: true });
  assert.equal((await old).finished, undefined);
  assert.equal(store.list().find((t) => t.id === once.id).scheduleId, restoredId);
});

asyncCheck('已经排在试跑后面的正式提醒，暂停或删除后不再叫醒目标', async () => {
  for (const action of ['pause', 'remove']) {
    const { hub, storage } = makeHub();
    const store = new TaskStore({ storage, hub });
    const made = await store.create({ title: 'queued', prompt: 'p', when: 'after:60', createdBy: 'group:833194406' });
    const entered = deferred();
    const finishTrial = deferred();
    let wakeCount = 0;
    hub.mind.reawake = async () => {
      wakeCount += 1;
      entered.resolve();
      await finishTrial.promise;
      return { woke: true };
    };
    const trial = store.run(made.id);
    await entered.promise;
    const formal = store.fireBySchedule(store.all()[0].scheduleId);
    const stopped = await store[action](made.id);
    finishTrial.resolve();
    assert.equal(stopped.ok, true);
    assert.equal((await trial).ok, true);
    assert.match((await formal).error, /排期已更改或取消/);
    assert.equal(wakeCount, 1);
  }
});

asyncCheck('轮换：等旧句柄释放才建新总机，暂存的新排期可以接住到点，回滚不删原排期', async () => {
  const { hub, storage, calls } = makeHub();
  const sessionId = 'onebot-hub:tasks';
  const future = new Date(Date.now() + 3_600_123).toISOString();
  const task = (id, when) => ({ id, title: id, when, nextAt: future, active: true, sessionId,
    scheduleId: `old-${id}`, target: 'group:833194406', prompt: 'p' });
  storage.write('tasks', { sessionId, tasks: [
    task('trigger', { kind: 'every', seconds: 600 }),
    task('once', { kind: 'after', seconds: 600 }),
    task('tail', { kind: 'every', seconds: 600 }),
  ] });
  const enteredDispose = deferred();
  const disposed = deferred();
  const alone = deferred();
  const finishTail = deferred();
  let quiesced = 0;
  hub.mind.pool.quiesce = async (_key, _reason, options) => {
    assert.equal(options.hold, false);
    if (++quiesced === 1) {
      enteredDispose.resolve();
      await disposed.promise;
    }
  };
  hub.scheduleSvc.create = async (targetId, req) => {
    if (req.title === 'tail') {
      alone.resolve(targetId);
      await finishTail.promise;
    }
    return { id: `new-${req.title}`, scheduledAt: future };
  };
  const archived = [];
  hub.hostRef.retireSessionId = async (id) => archived.push(id);
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  store.load();
  const rotate = store.fireBySchedule('old-trigger');
  await enteredDispose.promise;
  assert.deepEqual(calls.pins, []);
  disposed.resolve();
  const stagingId = await alone.promise;
  assert.equal(store.acceptsScheduleSession(stagingId, 'new-once'), true);
  assert.equal(store.acceptsScheduleSession('other-session', 'new-once'), false);
  assert.equal(store.acceptsScheduleSession(sessionId, 'old-once'), true);
  // Do not immediately retry after this intentionally interrupted rotation.
  store.resetEvery = 0;
  assert.equal((await store.fireBySchedule('new-once')).finished, true);
  finishTail.resolve();
  assert.equal((await rotate).ok, true);
  assert.equal(store.sessionId, sessionId);
  assert.equal(store.acceptsScheduleSession(stagingId, 'new-once'), false);
  assert.deepEqual(calls.deleted.map(({ id }) => id), ['new-trigger', 'new-once', 'new-tail']);
  assert.deepEqual(archived, []);
});

asyncCheck('宿主的管理写入可等待 fire 回复，轮换不反过来阻塞宿主', async () => {
  const { hub, storage } = makeHub();
  const store = new TaskStore({ storage, hub, resetEvery: 1 });
  const trigger = await store.create({ title: 'fire under delete', prompt: 'p', when: 'every:600', createdBy: 'group:833194406' });
  const victim = await store.create({ title: 'pause me', prompt: 'p', when: 'every:600', createdBy: 'group:833194406' });
  const originalDelete = hub.scheduleSvc.delete;
  hub.scheduleSvc.delete = async (req) => {
    if (req.id === 'sch_2') assert.equal((await store.fire(trigger.id)).ok, true);
    return originalDelete(req);
  };
  const paused = await store.pause(victim.id);
  assert.equal(paused.ok, true);
  // This queued ensure is guaranteed to run after the fire's deferred rotation.
  await store.ensureSession();
  assert.match(store.sessionId, /\.r/);
  assert.equal(store.list().find(({ id }) => id === victim.id).paused, true);
});

await Promise.all(pending);

console.log(JSON.stringify({ passed, failed, cases }, null, 2));
if (failed > 0) process.exitCode = 1;
