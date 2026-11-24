import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../lib/storage.js';
import { TopicTranscripts, selectTranscript, topicPage } from '../lib/memory/topic-transcripts.js';

const local = 'group:111';
const foreign = 'private:222';
const topic = 'plans';
const day = 86400000;
const txt = (text) => ({ type: 'text', data: { text } });
const picture = { type: 'image', data: { file: 'private-image' } };
const frame = (scope, id, text, extra = {}) => {
  const group = scope.startsWith('group:');
  return {
    id, sessionKey: scope, ts: 1700000000000,
    direction: 'upstream-in', kind: group ? 'group_message' : 'private_message',
    actor: { user_id: group ? 10001 : 222, nickname: '小明' }, refs: { message_id: 44 },
    payload: { post_type: 'message', user_id: group ? 10001 : 222, ...(group && { group_id: 111 }),
      message: typeof text === 'string' ? [txt(text)] : text },
    ...extra,
  };
};
const world = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-topic-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = day * 20000;
  const storage = new JsonStore({ dir });
  const open = () => new TopicTranscripts({ storage: new JsonStore({ dir }), now: () => now });
  return { storage, open, advance: (days) => { now += days * day; } };
};
const save = (store, scope, text = '文字') => store.save(scope, topic, [frame(scope, 'a', text)], { refs: ['a'] });

test('explicit refs or range preserve source order, text and provenance only', () => {
  const failed = frame(local, 'bad', '发不出去的话', { direction: 'hub-out', action: 'send_group_msg', decision: 'failed' });
  const sent = { ...failed, id: 'sent', decision: 'sent', selfId: 30001,
    payload: { group_id: 111, message: [txt(' 好的\n')] } };
  const rows = [frame(local, 't_1', [txt('  周六\n'), picture, txt('见  ')]),
    frame(foreign, 't_private', '私聊原文'), frame(local, 't_2', [picture]), failed, sent];
  const selected = selectTranscript(rows, local, { refs: ['sent', 't_1', 't_2', 't_1'] });
  assert.ok(selected.ok);
  assert.deepEqual(selected.messages.map((m) => [m.ref, m.messageId, m.actor.user_id, m.text]), [
    ['t_1', 44, 10001, '  周六\n见  '], ['sent', 44, 30001, ' 好的\n'],
  ]);
  assert.match(selected.notes.join(' '), /非文字.*没有文字.*重复/);
  assert.deepEqual(selectTranscript(rows, local, { start: 't_1', end: 'sent' }).messages, selected.messages);
  for (const options of [{ refs: ['t_1', 't_private'] }, { refs: ['44'] }, { refs: ['bad'] }, { start: 'sent', end: 't_1' }, { start: 't_1', end: 't_private' }]) {
    assert.equal(selectTranscript(rows, local, options).ok, false);
  }
  const wrongFrame = frame(local, 'wrong', '不在这个群');
  wrongFrame.payload.group_id = 777;
  assert.equal(selectTranscript([wrongFrame], local, { refs: ['wrong'] }).ok, false);
});

test('restart, isolated topic IDs, and pagination keep whole messages', (t) => {
  const w = world(t);
  const rows = Array.from({ length: 6 }, (_, i) => frame(local, `t_${i}`, '字'.repeat(3000)));
  const saved = w.open().save(local, topic, rows, { start: 't_0', end: 't_5' });
  assert.ok(saved.ok, JSON.stringify(saved));
  const id = saved.attachment.id;
  assert.ok(save(w.open(), foreign, '私聊原文').ok);
  const reopened = w.open();
  assert.equal(reopened.list(local, topic).length, 1);
  assert.equal(Object.hasOwn(reopened.list(local, topic)[0], 'messages'), false);
  assert.equal(reopened.read(foreign, topic, id).ok, false);
  assert.equal(reopened.read(local, 'elsewhere', id).ok, false);
  const all = [];
  let offset = 0;
  do {
    const out = reopened.read(local, topic, id, { offset, limit: 50 });
    assert.equal(out.items.length, 1, '每页不拆分消息');
    all.push(...out.items);
    offset = out.nextOffset;
  } while (offset !== null);
  assert.deepEqual(all.map((m) => m.text), rows.map((m) => m.payload.message[0].data.text));
  assert.deepEqual(topicPage(['a', 'b', 'c'], 1, 1), { count: 1, total: 3, offset: 1, nextOffset: 2, items: ['b'] });
  assert.equal(reopened.remove(foreign, topic, id).ok, false);
  assert.equal(reopened.remove(local, topic, id).ok, true);
  assert.equal(w.open().list(local, topic).length, 0);
  assert.equal(w.open().list(foreign, topic).length, 1);
});

test('zero retention keeps attachments; positive retention starts at save time', async (t) => {
  const w = world(t);
  const a = save(w.open(), local, '旧附件');
  w.advance(8);
  assert.equal((await w.open().prune(0)).skipped, true);
  assert.equal(w.open().read(local, topic, a.attachment.id).ok, true);
  const b = save(w.open(), local, '新附件');
  assert.equal((await w.open().prune(3)).removed, 1);
  assert.equal(w.open().read(local, topic, a.attachment.id).ok, false);
  assert.equal(w.open().read(local, topic, b.attachment.id).ok, true);
});

test('limits and failed writes do not silently truncate or evict', (t) => {
  const w = world(t);
  const store = w.open();
  for (let i = 0; i < 16; i += 1) assert.ok(save(store, local).ok);
  assert.match(save(store, local).error, /16 个附件/);
  const large = frame(local, 'large', '字'.repeat(10000));
  assert.match(store.save(local, 'new-topic', [large], { refs: ['large'] }).error, /未截断/);
  const many = Array.from({ length: 101 }, (_, i) => frame(local, `r_${i}`, '文字'));
  assert.match(store.save(local, 'new-topic', many, { start: 'r_0', end: 'r_100' }).error, /100 条/);
  assert.equal(w.open().list(local, topic).length, 16);
  assert.equal(w.open().list(local, 'new-topic').length, 0);
  const previous = store.list(local, topic)[0].id;
  const failing = new TopicTranscripts({ storage: w.storage });
  w.storage.write = () => false;
  assert.equal(failing.remove(local, topic, previous).ok, false);
  assert.equal(save(failing, foreign).ok, false);
  assert.equal(w.open().read(local, topic, previous).ok, true);
});

test('scoped export and purge include independent copies and remove invalid leftovers', (t) => {
  const w = world(t);
  const store = w.open();
  save(store, local, '群里原文');
  save(store, local, '群里原文');
  const localFile = w.storage.list('topic-transcripts')[0];
  for (const ext of ['bad', 'tmp']) fs.writeFileSync(w.storage.path(`topic-transcripts/${localFile}.${ext}`), '群里原文');
  save(store, foreign, '私聊原文');
  assert.equal(store.exportScope(local)[0].attachments.length, 2);
  assert.doesNotMatch(JSON.stringify(store.exportScope(local)), /私聊原文/);
  assert.equal(store.purgeScope(local).removed, 2);
  assert.deepEqual(store.exportScope(local), []);
  assert.equal(store.exportScope(foreign)[0].attachments[0].messages[0].text, '私聊原文');
  for (const ext of ['bad', 'tmp']) assert.equal(fs.existsSync(w.storage.path(`topic-transcripts/${localFile}.${ext}`)), false);
});
