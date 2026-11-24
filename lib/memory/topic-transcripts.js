import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { segmentsOf } from '../protocol.js';
import { isTopicScope } from './topic-input.js';
import { topicIdOf } from './topic-state.js';

const DIR = 'topic-transcripts';
const MAX_ROWS = 100;
const MAX_ROW_BYTES = 16 * 1024;
const MAX_BYTES = 64 * 1024;
const MAX_PER_TOPIC = 16;
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const prefix = (scope) => `${hash(scope)}-`;
const nameOf = (scope, topicId) => `${prefix(scope)}${hash(topicId)}.json`;
const failure = (error) => ({ ok: false, error, notes: [error] });
const pageOffset = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const pageLimit = (n) => Number.isSafeInteger(n) ? Math.max(1, Math.min(n, 50)) : 10;

/** Actual chat frames only: no model summaries, unsent replies, or tool events. */
function actorOfFrame(row, scope) {
  if (row?.sessionKey !== scope || !row.id || !Number.isFinite(row.ts) || !row.payload) return null;
  const body = row.payload;
  const group = scope.startsWith('group:');
  const target = scope.split(':')[1];
  if (row.direction === 'upstream-in' && body.post_type === 'message'
      && row.kind === (group ? 'group_message' : 'private_message')
      && String(group ? body.group_id : body.user_id) === target
      && !String(row.decision ?? '').startsWith('chat-command:')) {
    return { user_id: row.actor?.user_id ?? body.user_id ?? null, nickname: row.actor?.nickname ?? null };
  }
  if (row.direction === 'hub-out' && row.decision === 'sent' && row.refs?.message_id != null
      && /^send_(?:(?:group|private)_)?msg$/.test(row.action ?? '')
      && !(group ? body.message_type === 'private' : body.message_type === 'group')
      && String(group ? body.group_id : body.user_id) === target) {
    return { user_id: row.selfId ?? row.actor?.user_id ?? null, nickname: row.actor?.nickname ?? null };
  }
  return null;
}

/** Internal timeline IDs are selectors; protocol IDs are provenance (they can collide). */
export function selectTranscript(rows, scope, { refs, start, end } = {}) {
  if (!isTopicScope(scope)) return failure('原文附件只能在已绑定的群或私聊中保存');
  const range = start !== undefined || end !== undefined;
  const refOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && s === s.trim();
  if (range ? (refs !== undefined || !refOk(start) || !refOk(end))
    : (!Array.isArray(refs) || !refs.length || refs.length > MAX_ROWS || refs.some((r) => !refOk(r)))) {
    return failure('给出 1–100 个真实时间线 ref，或同时给 start 和 end；两种选法不能混用');
  }
  const wanted = range ? null : new Set(refs);
  const seen = new Set();
  const messages = [];
  let inRange = false, ended = false, omitted = 0, textless = 0;
  for (const row of rows) {
    if ((!range && !wanted.has(row?.id)) || seen.has(row?.id)) continue;
    const actor = actorOfFrame(row, scope);
    if (!actor) continue;
    if (range && row.id === start) inRange = true;
    if (range && !inRange) continue;
    seen.add(row.id);
    if (seen.size > MAX_ROWS) return failure('范围超过 100 条聊天消息；没有保存，请缩小范围');
    const segments = segmentsOf(row.payload);
    const parts = segments.filter((s) => s?.type === 'text' && typeof s.data?.text === 'string');
    omitted += segments.length - parts.length;
    const text = parts.map((s) => s.data.text).join('');
    if (text.trim()) {
      const message = { ref: row.id, messageId: row.refs?.message_id ?? null, at: row.ts, actor, text };
      if (size(message) > MAX_ROW_BYTES) return failure('选中的单条原文超过 16 KiB；未截断也未保存');
      messages.push(message);
    } else textless += 1;
    if (range && row.id === end) { ended = true; break; }
  }
  if (range ? !ended : seen.size !== wanted.size) return failure('有 ref 不在本会话、已不在保留期内或范围顺序不对；没有保存');
  if (!messages.length) return failure('选中的消息没有文字；未保存附件');
  if (size(messages) > MAX_BYTES) return failure('原文超过 64 KiB；未截断也未保存，请拆成更小的附件');
  const notes = [];
  if (omitted) notes.push(`未保存 ${omitted} 个非文字消息段（包括媒体、引用和合并转发）`);
  if (textless) notes.push(`略过 ${textless} 条没有文字的消息`);
  if (!range && wanted.size < refs.length) notes.push('重复的消息编号只保存一次');
  return { ok: true, messages, notes };
}

const metadata = ({ id, savedAt, messages, notes }) => ({ id, savedAt, count: messages.length, bytes: size(messages), notes });
const validDoc = (doc, scope, topicId) => doc?.version === 1 && doc.scope === scope && doc.topicId === topicId
  && Array.isArray(doc.attachments) && doc.attachments.length <= MAX_PER_TOPIC
  && doc.attachments.every((a) => typeof a?.id === 'string' && Number.isFinite(a.savedAt) && Array.isArray(a.messages) && Array.isArray(a.notes));

/** Independent, atomically replaced JSON per topic. Detail only returns metadata. */
export class TopicTranscripts {
  constructor({ storage, now = Date.now, log = () => {} } = {}) {
    this.storage = storage;
    this.now = now;
    this.log = log;
  }

  #doc(scope, topicId) {
    if (!isTopicScope(scope) || !topicIdOf(topicId)) return null;
    const file = `${DIR}/${nameOf(scope, topicId)}`;
    const doc = this.storage?.read?.(file);
    if (!doc) return { file, doc: { version: 1, scope, topicId, attachments: [] } };
    return validDoc(doc, scope, topicId) ? { file, doc } : null;
  }

  #write(file, doc) {
    if (!doc.attachments.length) return this.storage.remove(file) === true;
    if (this.storage.write(file, doc) === true) return true;
    this.storage.remove(`${file}.tmp`);
    return false;
  }

  list(scope, topicId) {
    return (this.#doc(scope, topicId)?.doc.attachments ?? []).map(metadata);
  }

  save(scope, topicId, rows, selection) {
    if (!this.storage?.enabled) return failure('未启用存储，不能永久保存原文附件');
    const selected = selectTranscript(rows, scope, selection);
    if (!selected.ok) return selected;
    const stored = this.#doc(scope, topicId);
    if (!stored) return failure('话题附件档案不可用，未保存');
    const { file, doc } = stored;
    if (doc.attachments.length >= MAX_PER_TOPIC) return failure('此话题已有 16 个附件；未覆盖旧附件，请先删除不需要的');
    const rec = { id: `tr_${randomUUID()}`, savedAt: this.now(), messages: selected.messages, notes: selected.notes };
    if (!this.#write(file, { ...doc, attachments: [...doc.attachments, rec] })) return failure('原文附件未能写入磁盘，没有保存');
    return { ok: true, attachment: metadata(rec), notes: selected.notes };
  }

  read(scope, topicId, id, { offset, limit } = {}) {
    const found = this.#doc(scope, topicId)?.doc.attachments.find((a) => a.id === id);
    if (!found) return failure('当前话题没有这个原文附件（可能已删除或过期）');
    const start = pageOffset(offset);
    const items = [];
    let bytes = 0;
    for (const row of found.messages.slice(start, start + pageLimit(limit))) {
      const next = size(row);
      if (items.length && bytes + next > MAX_ROW_BYTES) break;
      items.push(row);
      bytes += next;
    }
    const nextOffset = start + items.length < found.messages.length ? start + items.length : null;
    return { ok: true, attachment: metadata(found), offset: start, items, nextOffset, notes: found.notes };
  }

  remove(scope, topicId, id) {
    const stored = this.#doc(scope, topicId);
    if (!stored) return failure('当前话题没有这个原文附件');
    const { file, doc } = stored;
    const keep = doc.attachments.filter((a) => a.id !== id);
    if (keep.length === doc.attachments.length) return failure('当前话题没有这个原文附件');
    return this.#write(file, { ...doc, attachments: keep })
      ? { ok: true, deleted: id, notes: [] } : failure('删除未能写入磁盘，附件未删除');
  }

  #files(scope) {
    const expected = scope ? prefix(scope) : '';
    return (this.storage?.list?.(DIR) ?? []).filter((name) => /^[\da-f]{64}-[\da-f]{64}\.json$/.test(name) && name.startsWith(expected));
  }

  exportScope(scope) {
    if (!isTopicScope(scope)) return [];
    return this.#files(scope).flatMap((name) => {
      const doc = this.storage.read(`${DIR}/${name}`);
      return topicIdOf(doc?.topicId) && name === nameOf(scope, doc.topicId) && validDoc(doc, scope, doc.topicId)
        ? [{ topicId: doc.topicId, attachments: doc.attachments }] : [];
    });
  }

  purgeScope(scope) {
    if (!isTopicScope(scope)) return failure('附件清理需要实际会话键');
    let removed = 0;
    const failed = [];
    const folder = this.storage?.path?.(DIR);
    let names = this.#files(scope);
    if (folder) {
      try {
        names = readdirSync(folder).filter((name) => name.startsWith(prefix(scope))
          && /^[\da-f]{64}-[\da-f]{64}\.json(?:\.(?:tmp|bad))?$/.test(name));
      } catch (err) {
        if (err?.code !== 'ENOENT') return { ok: false, removed, failed: [String(err?.message ?? err)] };
      }
    }
    for (const name of names) {
      const file = `${DIR}/${name}`;
      const doc = name.endsWith('.json') ? this.storage.read(file) : null;
      const count = topicIdOf(doc?.topicId) && name === nameOf(scope, doc.topicId) && validDoc(doc, scope, doc.topicId)
        ? doc.attachments.length : 0;
      // JsonStore may quarantine an unreadable JSON during the read above.
      const removedFile = this.storage.remove(file);
      const removedQuarantine = !name.endsWith('.json') || this.storage.remove(`${file}.bad`);
      if (removedFile && removedQuarantine) removed += count;
      else failed.push(name);
    }
    return { ok: failed.length === 0, removed, failed };
  }

  async prune(days) {
    if (!(Number.isFinite(days) && days > 0)) return { skipped: true, removed: 0, failed: 0 };
    const cutoff = this.now() - days * 86400000;
    let removed = 0, failed = 0;
    for (const [i, name] of this.#files().entries()) {
      if (i && i % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
      const file = `${DIR}/${name}`;
      const doc = this.storage.read(file);
      if (!isTopicScope(doc?.scope) || !topicIdOf(doc.topicId) || name !== nameOf(doc.scope, doc.topicId)
        || !validDoc(doc, doc.scope, doc.topicId)) continue;
      const keep = doc.attachments.filter((a) => a.savedAt >= cutoff);
      if (keep.length === doc.attachments.length) continue;
      if (!this.#write(file, { ...doc, attachments: keep })) { failed += 1; continue; }
      removed += doc.attachments.length - keep.length;
    }
    if (failed) this.log(`原文附件保留期清理有 ${failed} 个档案未写回，下次重试`);
    return { skipped: false, removed, failed };
  }
}

export function topicPage(items, offset, limit) {
  const start = pageOffset(offset);
  const page = items.slice(start, start + pageLimit(limit));
  const nextOffset = start + page.length < items.length ? start + page.length : null;
  return { count: page.length, total: items.length, offset: start, nextOffset, items: page };
}
