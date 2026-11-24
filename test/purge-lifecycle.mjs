import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentPool } from '../lib/agent/pool.js';
import { resolveAgentPolicy } from '../lib/agent/policy.js';
import { Mind } from '../lib/mind.js';
import { SessionData } from '../lib/ops/session-data.js';

const key = 'group:111';
const other = 'group:222';
const deferred = () => Promise.withResolvers();

function fixture({ create, dispose, retire, idle, getLive, startWithResume = false } = {}) {
  const trace = [];
  let seq = 0;
  const policy = resolveAgentPolicy({ silenceWhenDownstreamResponded: false });
  const makeHandle = (kind) => async ({ agentKey, setup }) => {
    const id = ++seq;
    trace.push(`${kind}:start:${id}`);
    await create?.(id);
    const agent = {
      id,
      followup: (message) => trace.push(`followup:${id}:${message.content[0].text}`),
      whenIdle: () => idle?.(id),
    };
    await setup?.({}, agent);
    trace.push(`${kind}:end:${id}`);
    return { agent, dispose: async () => { trace.push(`dispose:${id}`); await dispose?.(id); } };
  };
  const pool = new AgentPool({
    policy,
    host: {
      getLive,
      hasSession: () => startWithResume && seq === 0,
      create: makeHandle('create'),
      resume: makeHandle('resume'),
      retire: async (agentKey) => { trace.push(`retire:${agentKey}`); return retire?.(agentKey); },
    },
  });
  const hub = { recall: { purgeSession: async () => { trace.push('disk'); return { ok: true, rows: 1 }; } } };
  const mind = new Mind({ hub, policy, pool, setup: (_, { agent }) => trace.push(`setup:${agent.id}`) });
  hub.mind = mind;
  const data = new SessionData({ hub });
  const purge = () => data.purge(key, { confirm: key });
  const batch = (text) => {
    mind.noteDownstreamSend({ sessionKey: key, text, action: 'send_msg' });
    return mind.flush(key);
  };
  return { trace, pool, mind, purge, batch };
}

test('purge drains a handle that finishes creating during flush before retiring or deleting data', async () => {
  const start = deferred();
  const gate = deferred();
  const f = fixture({ create: (id) => { if (id === 1) { start.resolve(); return gate.promise; } } });
  const old = f.batch('old batch');
  await start.promise;
  const queuedWake = f.mind.reawake(key, { text: 'queued old wake' });
  const queuedEnsure = f.mind.ensureAgent(key);
  const purge = f.purge();
  await Promise.resolve();
  assert.deepEqual(f.trace, ['create:start:1']);
  assert.equal(f.pool.size, 0);
  gate.resolve();
  assert.equal((await old).reason, 'purged');
  assert.equal((await queuedWake).reason, 'purged');
  assert.equal((await queuedEnsure).ok, false);
  assert.equal((await purge).ok, true);
  assert.deepEqual(f.trace, ['create:start:1', 'create:end:1', 'dispose:1', `retire:${key}`, 'disk']);
  assert.equal(f.pool.size, 0);
  assert.equal((await f.mind.reawake(key, { text: 'new turn' })).woke, true);
  assert.deepEqual(f.trace.slice(-4), ['create:start:2', 'setup:2', 'create:end:2', 'followup:2:new turn']);
});

test('purge drains a late ensureAgent resume and blocks new work until disk finishes', async () => {
  const start = deferred();
  const gate = deferred();
  const f = fixture({ startWithResume: true, create: (id) => { if (id === 1) { start.resolve(); return gate.promise; } } });
  const old = f.mind.ensureAgent(key);
  await start.promise;
  const purge = f.purge();
  assert.equal((await f.mind.ensureAgent(key)).ok, false);
  assert.equal((await f.mind.reawake(key)).reason, 'purging');
  gate.resolve();
  assert.equal((await old).ok, false);
  assert.equal((await purge).ok, true);
  assert.deepEqual(f.trace, ['resume:start:1', 'resume:end:1', 'dispose:1', `retire:${key}`, 'disk']);
  assert.equal(await f.mind.ensureAgent(key), key);
  assert.deepEqual(f.trace.slice(-3), ['create:start:2', 'setup:2', 'create:end:2']);
});

test('a live lookup that returns during purge cannot register or dispatch that agent', async () => {
  const started = deferred();
  const lookup = deferred();
  const f = fixture({ getLive: () => { started.resolve(); return lookup.promise; } });
  const old = f.mind.reawake(key, { text: 'old turn' });
  await started.promise;
  const purge = f.purge();
  lookup.resolve({
    followup: () => f.trace.push('unexpected followup'),
    dispose: () => f.trace.push('dispose:adopted'),
  });
  assert.equal((await old).reason, 'purged');
  assert.equal((await purge).ok, true);
  assert.equal(f.pool.size, 0);
  assert.deepEqual(f.trace, ['dispose:adopted', `retire:${key}`, 'disk']);
});

test('an already running reawake is stopped promptly, but purge waits for handle release', async () => {
  const running = deferred();
  const stopped = deferred();
  const releasing = deferred();
  const f = fixture({
    idle: () => { running.resolve(); return stopped.promise; },
    dispose: () => { stopped.resolve(); return releasing.promise; },
  });
  const old = f.mind.reawake(key, { text: 'already dispatched' });
  await running.promise;
  const purge = f.purge();
  assert.equal((await old).reason, 'purged');
  assert.deepEqual(f.trace.slice(-2), ['followup:1:already dispatched', 'dispose:1']);
  assert.equal(f.pool.size, 0);
  releasing.resolve();
  assert.equal((await purge).ok, true);
  assert.deepEqual(f.trace.slice(-2), [`retire:${key}`, 'disk']);
});

test('timeout and immediate retry share the same still-running retirement barrier', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const start = deferred();
  const gate = deferred();
  const f = fixture({ create: (id) => { if (id === 1) { start.resolve(); return gate.promise; } } });
  const old = f.mind.reawake(key, { text: 'old turn' });
  await start.promise;
  const first = f.purge();
  t.mock.timers.tick(5000);
  const bad = await first;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /旧回合还没有停止/);
  assert.deepEqual(f.trace, ['create:start:1']);
  assert.equal((await f.mind.reawake(key)).reason, 'purging');
  assert.equal((await f.mind.ensureAgent(key)).ok, false);
  assert.equal((await f.mind.reawake(other, { text: 'independent' })).woke, true);
  const retry = f.purge();
  gate.resolve();
  assert.equal((await old).reason, 'purged');
  assert.equal((await retry).ok, true);
  assert.equal(f.trace.filter((x) => x === `retire:${key}`).length, 1);
  assert.deepEqual(f.trace.slice(-4), ['create:end:1', 'dispose:1', `retire:${key}`, 'disk']);
  assert.equal((await f.mind.reawake(key, { text: 'fresh' })).woke, true);
  assert.equal(f.trace.at(-1), 'followup:3:fresh');
});

test('failed disposal stays quarantined and failed host retirement never enters disk purge', async () => {
  let releaseAttempts = 0;
  let retireAttempts = 0;
  const f = fixture({
    dispose: () => { if (++releaseAttempts === 1) throw new Error('release blocked'); },
    retire: () => (++retireAttempts === 1 ? { ok: false, error: 'retire blocked' } : { ok: true }),
  });
  assert.equal(await f.mind.ensureAgent(key), key);
  assert.match((await f.purge()).error, /release blocked/);
  assert.equal(f.pool.size, 0);
  assert.equal((await f.mind.reawake(key, { text: 'should not dispatch' })).woke, false);
  assert.match((await f.purge()).error, /retire blocked/);
  assert.deepEqual(f.trace.slice(-3), ['dispose:1', 'dispose:1', `retire:${key}`]);
  assert.equal((await f.purge()).ok, true);
  assert.deepEqual(f.trace.slice(-2), [`retire:${key}`, 'disk']);
});

test('temporary quiesce awaits release without retiring or permanently blocking the key', async () => {
  const stopped = deferred();
  const releasing = deferred();
  const f = fixture({ dispose: (id) => { if (id === 1) { stopped.resolve(); return releasing.promise; } } });
  assert.equal(await f.mind.ensureAgent(key), key);
  let finished = false;
  const release = f.pool.quiesce(key, 'task-reset', { hold: false }).then(() => { finished = true; });
  await stopped.promise;
  assert.equal(finished, false);
  assert.equal((await f.mind.reawake(key, { text: 'while releasing' })).woke, false);
  releasing.resolve();
  await release;
  assert.deepEqual(f.trace, ['create:start:1', 'setup:1', 'create:end:1', 'dispose:1']);
  assert.equal((await f.mind.reawake(key, { text: 'after rebinding' })).woke, true);
  assert.equal(f.trace.at(-1), 'followup:2:after rebinding');
});

test('a concurrent purge keeps the hold and aborts a pending temporary release for rebinding', async () => {
  const stopped = deferred();
  const releasing = deferred();
  const f = fixture({ dispose: () => { stopped.resolve(); return releasing.promise; } });
  assert.equal(await f.mind.ensureAgent(key), key);
  const release = f.pool.quiesce(key, 'task-reset', { hold: false });
  await stopped.promise;
  const purge = f.purge();
  releasing.resolve();
  await assert.rejects(release, /这个会话正在清理，不能换绑/);
  assert.equal((await purge).ok, true);
  assert.deepEqual(f.trace.slice(-3), ['dispose:1', `retire:${key}`, 'disk']);
});
