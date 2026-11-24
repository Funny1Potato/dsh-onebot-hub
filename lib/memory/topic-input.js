import { replyTargetId, segmentsOf } from '../protocol.js';

export const isTopicScope = (scope) => /^(?:group|private):\d+$/.test(String(scope ?? ''));

/** Take only actual upstream chat, not rendered quotations, bot output, vision notes or commands. */
export function topicInput(entry, scope, selfId) {
  const row = entry?.live ?? entry;
  if (!isTopicScope(scope) || row?.sessionKey !== scope || row.direction !== 'upstream-in') return null;
  if (row.kind !== 'group_message' && row.kind !== 'private_message') return null;
  if (String(row.decision ?? '').startsWith('chat-command:')) return null;
  const actorId = String(row.actor?.user_id ?? '');
  const own = String(row.selfId || row.payload?.self_id || selfId || '');
  if (actorId && own && actorId === own) return null;
  const event = row.payload;
  if (event?.post_type !== 'message') return null;
  const text = segmentsOf(event).filter((seg) => seg?.type === 'text').map((seg) => String(seg.data?.text ?? '')).join('');
  const quoteId = replyTargetId(event);
  return {
    scope,
    id: String(row.id ?? ''),
    text,
    ts: row.ts,
    actorId,
    messageId: String(row.refs?.message_id ?? ''),
    quoteIds: quoteId ? [quoteId] : [],
  };
}

export function topicEvidenceRef(row) {
  return { scope: row.scope, timelineId: row.id, ...(row.messageId ? { messageId: row.messageId } : {}) };
}

/** A writer can nominate IDs, never a source scope or an arbitrary evidence blob. */
export function resolveTopicEvidence(entries, scope, ids, selfId) {
  if (!isTopicScope(scope) || !Array.isArray(ids) || !ids.length) return [];
  const wanted = new Set(ids);
  const seen = new Set();
  const evidence = [];
  for (const entry of entries) {
    const row = topicInput(entry, scope, selfId);
    if (!row?.id || seen.has(row.id) || (!wanted.has(row.id) && !wanted.has(row.messageId))) continue;
    seen.add(row.id);
    evidence.push(row);
  }
  return evidence;
}

/** A legacy card may only borrow exact, typed local timeline IDs; wire IDs can collide. */
export function topicOwnerLookup(hub, scope) {
  let local;
  return (id, kind) => {
    if (kind !== 'timeline') return '';
    local ??= new Set((hub.timeline?.bySession?.(scope, 200) ?? [])
      .map((entry) => topicInput(entry, scope, hub.upstreamAccount)?.id).filter(Boolean));
    return local.has(String(id)) ? scope : '';
  };
}
