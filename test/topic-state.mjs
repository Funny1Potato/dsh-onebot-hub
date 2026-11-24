import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Profiles } from '../lib/profile.js';
import { JsonStore } from '../lib/storage.js';
import { scopedTopicFile } from '../lib/memory/topic-state.js';

const a = 'group:111';
const b = 'private:222';
const ref = (scope, messageId) => ({ scope, messageId });
const row = (scope, id, ts, topicId = undefined, text = `source ${id}`) => ({ scope, id, ts, topicId, text, messageId: `m-${id}`, actorId: '12345' });
const withStore = (fn) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-topic-state-'));
  const stores = [];
  try {
    return fn(() => {
      const store = new JsonStore({ dir });
      stores.push(store);
      return store;
    });
  } finally {
    for (const store of stores) store.stop();
    rmSync(dir, { recursive: true, force: true });
  }
};

function write(profiles, scope, id, text, evidence = []) {
  return profiles.upsertScopedTopic(scope, id, { title: text, conclusion: `decision ${text}`, refs: [ref(scope, 'same-qq-id')], evidence }, 20);
}

test('same stable id and wire message id can be used independently by each scope', () => withStore((store) => {
  const profiles = new Profiles({ storage: store() });
  assert.ok(write(profiles, a, 'release', 'group release'));
  assert.ok(write(profiles, b, 'release', 'private release'));
  assert.ok(write(profiles, b, 'only-private', 'other private title'));
  assert.equal(profiles.upsertScopedTopic(a, 'release', { conclusion: 'unowned' }), null);
  assert.equal(profiles.upsertScopedTopic(a, 'release', { conclusion: 'foreign', refs: [ref(b, 'same-qq-id')] }), null);
  assert.equal(profiles.upsertScopedTopic(a, 'release', { title: 'foreign raw', refs: [ref(a, 'same-qq-id')], evidence: [row(b, 'q', 1)] }), null);
  assert.equal(profiles.topicCard(a, 'only-private'), null);
  assert.equal(profiles.topicCard(a, 'release').conclusion, 'decision group release');
  assert.equal(profiles.topicCard(b, 'release').conclusion, 'decision private release');
  const quote = profiles.attachTopicByReply({ trustedScope: a, messageId: 'same-qq-id', evidence: row(a, 'reply', 21) });
  assert.equal(quote.id, 'release');
  assert.ok(quote.refs.some((r) => r.scope === a && r.messageId === 'm-reply'));
  assert.ok(!profiles.topicCard(b, 'release').refs.some((r) => r.messageId === 'm-reply'));
  assert.equal(profiles.attachTopicByReply({ trustedScope: b, messageId: 'm-reply', evidence: row(b, 'bad', 22) }), null);
  const restarted = new Profiles({ storage: store() });
  assert.deepEqual(restarted.topicCards(a).map((c) => c.title), ['group release']);
  assert.ok(restarted.topicCards(b).every((c) => c.refs.every((r) => r.scope === b)));
}));

test('legacy singleton needs local raw provenance; mixed, unknown, and tainted remain unprojectable', () => withStore((store) => {
  const storage = store();
  const profiles = new Profiles({ storage });
  const ownerOf = (id) => ({ local: a, foreign: b }[id] ?? '');
  profiles.upsertTopic('good', { title: 'Verified local', worldKeys: [a], refs: [{ message_id: 'local' }] });
  profiles.upsertTopic('bare', { title: 'Spoofed home', worldKeys: [a] });
  profiles.upsertTopic('unknown-ref', { title: 'Unknown evidence', worldKeys: [a], refs: ['unowned'] });
  profiles.upsertTopic('unknown-home', { title: 'Unknown home', refs: ['local'] });
  profiles.upsertTopic('nested', { title: 'Known foreign', worldKeys: [a], refs: ['local'], events: [{ text: 'Foreign text', refs: { messageId: 'foreign' } }] });
  profiles.upsertTopic('mixed', { title: 'Mixed secret', conclusion: 'Mixed decision', worldKeys: [a, b], refs: ['local', 'foreign'] });
  profiles.upsertTopic('laundered', { title: 'Old private', worldKeys: [b] });
  profiles.upsertTopic('laundered', { worldKeys: [a], refs: ['local'] });
  storage.flush();
  assert.deepEqual(profiles.topicCards(a), []);
  assert.deepEqual(profiles.topicCards(a, { ownerOf }).map(({ id }) => id), ['good']);
  assert.equal(profiles.topicCard(b, 'good', { ownerOf }), null);
  assert.equal(profiles.topicCard(a, 'mixed', { ownerOf }), null);
  assert.ok(profiles.noteTopicEvidence(a, 'good', row(a, 'linked', 5), { ownerOf }));
  assert.equal(profiles.topicCard(a, 'good', { ownerOf }).title, 'Verified local');
  assert.equal(profiles.topicCard(a, 'good'), null, 'saved overlay never authorizes historical flattened fields');
  assert.deepEqual(profiles.forgetTopicScope(b, ownerOf), { removed: 0, detached: 3 });
  assert.equal(profiles.topic('laundered').title, null, 'purge accounts for prior overwritten world provenance');
  assert.equal(profiles.topic('mixed').title, null);
  assert.equal(profiles.topicCard(a, 'mixed', { ownerOf }), null);
  assert.ok(write(profiles, a, 'mixed', 'new independent local topic'));
  const restarted = new Profiles({ storage: store() });
  assert.equal(restarted.topicCard(a, 'mixed').conclusion, 'decision new independent local topic');
  assert.equal(restarted.topicCard(b, 'mixed', { ownerOf }), null);
  assert.ok(!JSON.stringify(restarted.topicCard(a, 'mixed')).includes('Mixed secret'));
}));

test('explicit correction survives interleaved incremental folds and restart; snippets are evidence only', () => withStore((store) => {
  let profiles = new Profiles({ storage: store() });
  const x = row(a, 'x', 1, 'a-topic', ' raw\nmessage  '.repeat(100));
  const y = row(a, 'y', 2, 'second');
  assert.ok(write(profiles, a, 'a-topic', 'original', [x]));
  assert.ok(write(profiles, a, 'second', 'another', [y]));
  assert.ok(profiles.upsertScopedTopic(a, 'a-topic', { title: 'new title', aliases: ['brief name'], conclusion: 'corrected decision', unresolved: ['who delivers'], status: 'closed', refs: [ref(a, 'm-y')], events: [{ text: 'correction note', refs: ref(b, 'must-not-be-copied') }] }, 21));
  assert.equal(profiles.topicCard(a, 'a-topic').pending, 1);
  assert.equal(profiles.topicCard(a, 'a-topic').stages.filter((s) => s.kind === 'evidence').length, 0);
  const z = row(a, 'z', 2); // same timestamp as y, but later in canonical append order
  assert.deepEqual(profiles.checkpointTopicEvidence(a, [x, row(b, 'x', 1, 'a-topic'), y, z], { recentWindow: 2 }), { ok: true, folded: 1, failed: [] });
  profiles = new Profiles({ storage: store() });
  const card = profiles.topicCard(a, 'a-topic');
  assert.equal(card.conclusion, 'corrected decision');
  assert.equal(card.status, 'closed');
  assert.deepEqual(card.unresolved, ['who delivers']);
  assert.deepEqual(card.aliases, ['original', 'brief name']);
  const correction = card.stages.find((s) => s.previousConclusion);
  assert.equal(correction.previousConclusion, 'decision original');
  assert.equal(correction.conclusion, 'corrected decision');
  assert.deepEqual(correction.notes, ['correction note']);
  assert.ok(!JSON.stringify(card).includes('must-not-be-copied'));
  const excerpt = card.stages.find((s) => s.kind === 'evidence');
  assert.deepEqual(excerpt.ref, { scope: a, timelineId: 'x', messageId: 'm-x' });
  assert.ok(excerpt.excerpt.length <= 240 && !excerpt.excerpt.includes('\n'));
  assert.ok(!Object.hasOwn(excerpt, 'conclusion'));
  assert.equal(profiles.topicCard(a, 'second').checkpoint.folded, 0);
  assert.equal(profiles.topicCard(a, 'second').pending, 1);
  assert.equal(profiles.checkpointTopicEvidence(a, [z, row(a, 'w', 3), row(a, 'v', 4)], { recentWindow: 2 }).folded, 1);
  assert.equal(profiles.topicCard(a, 'second').checkpoint.timelineId, 'y');
  assert.equal(profiles.checkpointTopicEvidence(a, [x, y, z], { recentWindow: 1 }).folded, 0, 'replay is idempotent');
}));

test('failed checkpoint keeps committed cursor and provenance; retry survives a lost hot snapshot', () => withStore((store) => {
  const storage = store();
  const profiles = new Profiles({ storage });
  assert.ok(write(profiles, a, 'A', 'a', [row(a, 'a1', 1)]));
  assert.ok(write(profiles, a, 'B', 'b', [row(a, 'b1', 2)]));
  const badPath = scopedTopicFile(a, 'A');
  const realWrite = storage.write.bind(storage);
  storage.write = (name, data) => name !== badPath && realWrite(name, data);
  const later = [row(a, 'a2', 3, 'A'), row(a, 'later', 4)];
  assert.deepEqual(profiles.checkpointTopicEvidence(a, later, { recentWindow: 1 }), { ok: false, folded: 1, failed: ['A'] });
  assert.deepEqual(profiles.topicCard(a, 'A').checkpoint, { at: null, timelineId: null, folded: 0, replayFloorAt: null });
  assert.equal(profiles.topicCard(a, 'A').pending, 1);
  assert.equal(profiles.topicCard(a, 'B').checkpoint.folded, 1);
  const beforeRetryRestart = new Profiles({ storage: store() });
  assert.equal(beforeRetryRestart.topicCard(a, 'A').pending, 1, 'the pre-failure pending source is durable');
  storage.write = realWrite;
  assert.deepEqual(profiles.checkpointTopicEvidence(a, [], { recentWindow: 1 }), { ok: true, folded: 2, failed: [] });
  const restarted = new Profiles({ storage: store() });
  assert.equal(restarted.topicCard(a, 'A').checkpoint.timelineId, 'a2');
  assert.equal(restarted.topicCard(a, 'A').checkpoint.folded, 2);
  assert.ok(restarted.topicCard(a, 'A').stages.some((s) => s.ref?.timelineId === 'a2'));
}));

test('a malformed persisted card cannot block or contaminate another scoped card', () => withStore((store) => {
  const storage = store();
  const profiles = new Profiles({ storage });
  assert.ok(write(profiles, a, 'good', 'good'));
  assert.ok(write(profiles, a, 'bad', 'bad'));
  const badPath = scopedTopicFile(a, 'bad');
  const malformed = storage.read(badPath);
  malformed.pending = [null];
  assert.ok(storage.write(badPath, malformed));
  const restarted = new Profiles({ storage: store() });
  assert.equal(restarted.topicCard(a, 'bad'), null);
  assert.deepEqual(restarted.topicCards(a).map((c) => c.id), ['good']);
}));

test('folded history and replay state remain bounded; purge removes all versions and retries by scope', () => withStore((store) => {
  const storage = store();
  const profiles = new Profiles({ storage });
  assert.ok(write(profiles, a, 'same', 'purge A'));
  assert.ok(write(profiles, b, 'same', 'keep B'));
  const rows = Array.from({ length: 300 }, (_, i) => row(a, `r${i}`, i, 'same'));
  assert.deepEqual(profiles.checkpointTopicEvidence(a, rows, { recentWindow: 3 }), { ok: true, folded: 297, failed: [] });
  assert.equal(profiles.topicCard(a, 'same').stages.filter((s) => s.kind === 'evidence').length, 24);
  assert.equal(profiles.topicCard(a, 'same').pending, 3);
  assert.equal(profiles.checkpointTopicEvidence(a, rows, { recentWindow: 3 }).folded, 0);
  const badPath = scopedTopicFile(a, 'same');
  const realWrite = storage.write.bind(storage);
  storage.write = (name, data) => name !== badPath && realWrite(name, data);
  assert.equal(profiles.noteTopicEvidence(a, 'same', row(a, 'failed', 301)), false);
  storage.write = realWrite;
  writeFileSync(storage.path(`${badPath}.bad`), 'orphaned excerpt');
  assert.deepEqual(profiles.forgetTopicScope(a), { removed: 1, detached: 0 });
  assert.deepEqual(profiles.checkpointTopicEvidence(a, []), { ok: true, folded: 0, failed: [] });
  const restarted = new Profiles({ storage: store() });
  assert.equal(restarted.topicCard(a, 'same'), null);
  assert.equal(restarted.topicCard(b, 'same').title, 'keep B');
  assert.throws(() => writeFileSync(storage.path(`${badPath}.bad`), 'gone'), { code: 'ENOENT' });
}));
