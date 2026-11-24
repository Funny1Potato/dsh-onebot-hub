// Only runtime-owned scope and verified refs/rows reach these helpers.
// Explicit assertions and mechanical excerpts are deliberately different stage types.
import { createHash } from 'node:crypto';

export const TOPIC_RECENT_WINDOW = 40;
export const TOPIC_PENDING_LIMIT = 256;
const MAX_EXPLICIT = 32;
const MAX_EVIDENCE = 24;
const MAX_REFS = 48;
const own = (o, k) => Object.hasOwn(o, k);
const array = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const str = (v, max = 300) => typeof v === 'string' || typeof v === 'number'
  ? String(v).trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
const key = (v) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return s.length <= 256 ? s : '';
};
const stamp = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
const uniq = (xs, cap) => [...new Set(xs.filter(Boolean))].slice(-cap);
const hash = (s) => createHash('sha256').update(s).digest('hex');
export const topicScope = (v) => /^(group|private):[^\s:]+$/.test(key(v)) ? key(v) : '';
export const scopedTopicDir = (scope) => `topic-cards/${hash(scope)}`;
export const scopedTopicFile = (scope, id) => `${scopedTopicDir(scope)}/${hash(id)}.json`;
export const topicIdOf = key;
const homes = (row) => [row?.scope, row?.sessionKey, row?.worldKey, row?.world_key, row?.originScope, row?.ownerScope, row?.group_id == null ? null : `group:${row.group_id}`].filter((x) => x != null && x !== '');
const compatible = (scope, row) => homes(row).every((v) => v === scope);

function refIn(scope, input) {
  if (typeof input !== 'object') {
    const id = key(input);
    return id ? { scope, id } : null;
  }
  if (!input || !compatible(scope, input)) return null;
  const id = key(input.id ?? input.ref);
  const timelineId = key(input.timelineId ?? input.timeline_id ?? input.eventId);
  const messageId = key(input.messageId ?? input.message_id);
  return id || timelineId || messageId ? { scope, ...(id && { id }), ...(timelineId && { timelineId }), ...(messageId && { messageId }) } : null;
}

function refsIn(scope, inputs) {
  const refs = new Map();
  for (const input of inputs) {
    const ref = refIn(scope, input);
    if (ref) refs.set(JSON.stringify(ref), ref);
  }
  return [...refs.values()].slice(-MAX_REFS);
}

export function emptyScopedTopic(scope, id) {
  return { version: 1, id, scope, title: null, aliases: [], conclusion: null, unresolved: [], status: 'open', startedAt: null, lastAt: null,
    members: [], refs: [], explicit: [], pending: [], evidence: [], checkpoint: { at: null, timelineId: null, folded: 0, replayFloorAt: null } };
}

export function isScopedTopicRecord(rec, scope, file) {
  if (rec?.version !== 1 || rec.scope !== scope || !topicIdOf(rec.id) || file !== scopedTopicFile(scope, rec.id)
      || !rec.checkpoint || !Number.isSafeInteger(rec.checkpoint.folded) || rec.checkpoint.folded < 0) return false;
  const strings = (rows, cap) => Array.isArray(rows) && rows.length <= cap && rows.every((row) => typeof row === 'string');
  const refs = (rows) => Array.isArray(rows) && rows.length <= MAX_REFS && rows.every((ref) => ref?.scope === scope && Boolean(refIn(scope, ref)));
  const staged = (rows, cap, kind, check) => Array.isArray(rows) && rows.length <= cap
    && rows.every((row) => row?.scope === scope && row.kind === kind && check(row));
  const raw = (row) => row.ref?.scope === scope && Boolean(row.ref.timelineId) && stamp(row.at) != null && typeof row.excerpt === 'string';
  return strings(rec.aliases, 10) && strings(rec.unresolved, 12) && strings(rec.members, 20) && refs(rec.refs)
    && staged(rec.explicit, MAX_EXPLICIT, 'explicit', (row) => refs(row.refs))
    && staged(rec.evidence, MAX_EVIDENCE, 'evidence', raw) && staged(rec.pending, TOPIC_PENDING_LIMIT, 'evidence', raw);
}

export function scopedSnapshot(rec, { detail = false, includePending = false } = {}) {
  const { id, scope, title, aliases, conclusion, unresolved, status, startedAt, lastAt, members, refs, pending, evidence, explicit, checkpoint } = rec;
  // Pending refs are usable for matching but their text stays in the live window.
  const rows = [...evidence, ...pending];
  const card = { id, scope, title, aliases, conclusion, unresolved, status, startedAt, lastAt, members,
    refs: refsIn(scope, [...refs, ...rows.map((r) => r.ref)]), events: uniq(rows.map((r) => r.ref.timelineId), MAX_REFS) };
  if (detail) {
    card.stages = [...explicit, ...evidence].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    card.checkpoint = checkpoint;
    card.pending = pending.length;
    if (includePending) card.pendingEvidence = pending;
  }
  return structuredClone(card);
}

export function scopedRefMatches(card, messageId) {
  const wanted = key(messageId);
  return Boolean(wanted && card.refs.some((r) => r.scope === card.scope && r.messageId === wanted));
}

export function verifiedEvidence(scope, row) {
  if (!row || !homes(row).length || !compatible(scope, row)) return null;
  const timelineId = key(row.timelineId ?? row.id);
  const at = stamp(row.at ?? row.ts);
  if (!timelineId || at == null || array(row.refs).some((ref) => !compatible(scope, ref))) return null;
  const messageId = key(row.messageId ?? array(row.refs).map((r) => r?.messageId ?? r?.message_id).find((v) => v != null));
  const actorId = key(row.actorId ?? row.actor?.user_id);
  const excerpt = str(typeof row.text === 'string' ? row.text.replace(/\s+/g, ' ') : '', 240);
  return { kind: 'evidence', scope, at, ref: { scope, timelineId, ...(messageId && { messageId }) }, ...(actorId && { actorId }), excerpt };
}

function observe(rec, at, members = []) {
  if (at !== null) {
    rec.startedAt = rec.startedAt == null ? at : Math.min(rec.startedAt, at);
    rec.lastAt = rec.lastAt == null ? at : Math.max(rec.lastAt, at);
  }
  rec.members = uniq([...rec.members, ...members], 20);
}

// Returns false rather than silently dropping pending provenance on overflow.
export function queueEvidence(rec, rows, { allowOverflow = false } = {}) {
  const seen = new Set([...rec.evidence, ...rec.pending].map((r) => r.ref.timelineId));
  const staged = [];
  for (const row of rows) {
    const id = row.ref.timelineId;
    if (seen.has(id) || (rec.checkpoint.replayFloorAt != null && row.at <= rec.checkpoint.replayFloorAt)) continue;
    if (!allowOverflow && rec.pending.length + staged.length >= TOPIC_PENDING_LIMIT) return false;
    seen.add(id);
    staged.push(row);
  }
  rec.pending.push(...staged);
  for (const row of staged) observe(rec, row.at, [row.actorId]);
  return true;
}

export function writeExplicit(rec, patch, evidence, at, { allowUncited = false } = {}) {
  const refs = refsIn(rec.scope, [...array(patch.refs), ...evidence.map((r) => r.ref)]);
  if ((!refs.length && !allowUncited) || array(patch.refs).some((r) => !compatible(rec.scope, r))) return false;
  const stampAt = stamp(at);
  const stage = { kind: 'explicit', scope: rec.scope, at: stampAt, refs };
  for (const field of ['title', 'conclusion']) {
    if (!own(patch, field)) continue;
    const value = str(patch[field]) || null;
    if (rec[field] === value) continue;
    if (field === 'title' && rec.title && rec.title.length <= 64) rec.aliases = uniq([...rec.aliases, rec.title], 10);
    if (field === 'conclusion' && rec.conclusion) stage.previousConclusion = rec.conclusion;
    stage[field] = rec[field] = value;
  }
  if (own(patch, 'unresolved')) {
    const next = uniq(array(patch.unresolved).map((v) => str(v, 200)), 12);
    if (JSON.stringify(next) !== JSON.stringify(rec.unresolved)) stage.unresolved = rec.unresolved = next;
  }
  if (own(patch, 'status') && (patch.status === 'open' || patch.status === 'closed') && rec.status !== patch.status) stage.status = rec.status = patch.status;
  if (own(patch, 'aliases')) {
    stage.aliases = uniq(array(patch.aliases).map((v) => str(v, 64)).filter((v) => v !== rec.title), 10);
    rec.aliases = uniq([...rec.aliases, ...stage.aliases], 10);
  }
  rec.aliases = rec.aliases.filter((v) => v !== rec.title);
  const notes = array(patch.events).map((e) => str(typeof e === 'object' ? e?.text : e)).filter(Boolean).slice(-12);
  if (notes.length) stage.notes = notes;
  if (Object.keys(stage).length > 4) rec.explicit = [...rec.explicit, stage].slice(-MAX_EXPLICIT);
  rec.refs = refsIn(rec.scope, [...rec.refs, ...refs]);
  observe(rec, stampAt, array(patch.members).map(key));
  return true;
}

export function foldEvidence(rec, { cutoff, prefix = new Set(), recent = new Set() }) {
  const folded = [];
  rec.pending = rec.pending.filter((row) => {
    if (recent.has(row.ref.timelineId) || !(prefix.has(row.ref.timelineId) || row.at < cutoff)) return true;
    folded.push(row);
    return false;
  });
  if (!folded.length) return 0;
  const rows = [...rec.evidence, ...folded].sort((a, b) => a.at - b.at);
  const latest = rows.at(-1);
  const n = Math.max(0, rows.length - MAX_EVIDENCE);
  rec.checkpoint = { at: latest.at, timelineId: latest.ref.timelineId, folded: rec.checkpoint.folded + folded.length,
    replayFloorAt: n > 0 ? Math.max(rec.checkpoint.replayFloorAt ?? -Infinity, rows[n - 1].at) : rec.checkpoint.replayFloorAt };
  rec.evidence = rows.slice(n);
  return folded.length;
}

// Legacy inputs can contain arrays/objects of refs inside events. Only positive ownership
// evidence counts here; an unknown id cannot make an unknown/multi-world topic projectable.
export function legacyOwners(item, ownerOf, unknown = null) {
  const seen = new WeakSet();
  const owners = new Set();
  const inspectId = (v, kind = 'unknown') => {
    const id = key(v);
    if (!id || typeof ownerOf !== 'function') return;
    const owner = ownerOf(id, kind);
    if (typeof owner === 'string' && owner) owners.add(owner);
    else unknown?.add(id);
  };
  const todo = [item];
  while (todo.length) {
    const row = todo.pop();
    if (row == null || typeof row === 'boolean') continue;
    if (typeof row !== 'object') { inspectId(row); continue; }
    if (seen.has(row)) continue;
    seen.add(row);
    if (Array.isArray(row)) {
      for (const it of row) todo.push(it);
    } else {
      for (const home of homes(row)) owners.add(String(home));
      for (const field of ['id', 'ref']) inspectId(row[field]);
      for (const field of ['timelineId', 'timeline_id', 'eventId']) inspectId(row[field], 'timeline');
      for (const field of ['messageId', 'message_id']) inspectId(row[field], 'message');
      for (const field of ['refs', 'events', 'evidence']) if (row[field] != null) todo.push(row[field]);
      if (row.ref && typeof row.ref === 'object') todo.push(row.ref);
    }
  }
  return owners;
}

export function projectLegacyTopic(scope, rec, ownerOf) {
  if (rec.legacyMixed || topicIdOf(rec.id) !== rec.id || !topicIdOf(rec.id) || !rec.worldKeys.length
      || !rec.worldKeys.every((v) => v === scope) || typeof ownerOf !== 'function') return null;
  const unknown = new Set();
  const resolved = new Set();
  const resolve = (id, kind) => {
    try {
      const owner = ownerOf(id, kind);
      if (owner === scope) resolved.add(id);
      return owner;
    } catch {
      return '';
    }
  };
  // The old writer accepted worldKeys and nested event refs from model output.
  // Require positive independent proof from top-level runtime refs, and fail
  // closed on conflicting or unresolved IDs elsewhere in the flattened record.
  const refOwners = legacyOwners(rec.refs, resolve, unknown);
  if (!resolved.size || refOwners.size !== 1 || !refOwners.has(scope)) return null;
  for (const event of rec.events) {
    resolved.clear();
    if ([...legacyOwners(event, resolve, unknown)].some((v) => v !== scope) || unknown.size
        || (event?.text && !resolved.size)) return null;
  }
  if (unknown.size) return null;
  const { id, startedAt, lastAt } = rec;
  return { id, scope, title: str(rec.title) || null, aliases: [], conclusion: str(rec.conclusion) || null, unresolved: [], status: rec.status,
    startedAt: stamp(startedAt), lastAt: stamp(lastAt), members: uniq(rec.members.map(key), 20), refs: refsIn(scope, rec.refs),
    events: uniq(rec.events.map((e) => typeof e !== 'object' ? key(e) : ''), MAX_REFS), legacy: true };
}

export function legacyTopicDetail(card, rec) {
  const notes = rec.events.map((e) => str(e?.text)).filter(Boolean).slice(-12);
  return { ...card, stages: notes.length ? [{ kind: 'legacy', scope: card.scope, at: card.lastAt, notes, refs: card.refs }] : [] };
}

export function evidenceWindow(scope, entries, recentWindow) {
  const rows = Array.isArray(entries) ? entries.map((e) => ({ id: topicIdOf(e?.topicId), row: verifiedEvidence(scope, e) })).filter((e) => e.row) : [];
  const keep = Number.isSafeInteger(recentWindow) && recentWindow >= 0 ? recentWindow : TOPIC_RECENT_WINDOW;
  const end = Math.max(0, rows.length - keep);
  const tail = rows.slice(end);
  // A partial window cannot establish that an absent saved row has aged out yet.
  const cutoff = !keep && rows.length ? Infinity : tail.length >= keep && tail.length ? tail.reduce((n, { row }) => Math.min(n, row.at), Infinity) : -Infinity;
  return { rows, cutoff, prefix: new Set(rows.slice(0, end).map(({ row }) => row.ref.timelineId)), recent: new Set(tail.map(({ row }) => row.ref.timelineId)) };
}
