/**
 * `onebot_reply`（会话作用域）：发言的唯一出口。
 *
 * 从 `lib/index.js` 搬出来的（2026-11 拆文件），逻辑逐字未改；本来就是个工厂
 * （`makeReplyTool(reply, hub, log, {deliverNow})`），搬动不需要改结构。
 */

import { TEXT_OUTPUT } from './shared.js';
import { REPLY_TOOL_PARAMS, composeReply, describePlanIssues, describeReply, partsFromSegments, resolvePartsMedia, resolvePartsSpeech, resolveReplyImages } from '../reply.js';
import { defineTool } from './define.js';

export function resolveMemesForSend(hub, ids, log = () => {}) {
  const out = [];
  // plugin 模式下自带库整个下线（`m73315`）：这里不再解析 id，让调用方按"找不到"回执，
  // 而不是默默发一张来自旧库的图。
  if (hub?.config?.memes?.engine === 'plugin') {
    if (Array.isArray(ids) && ids.length) log('memes.engine=plugin：自带库已下线，reply 的 memes 参数不生效');
    return out;
  }
  // 一轮最多发几张（`memes.maxSend`）——模型列十个 id 就会刷十条图，硬上限在代码侧。
  const maxSend = Math.max(1, Number(hub?.config?.memes?.maxSend ?? 3) || 3);
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (out.length >= maxSend) {
      log(`表情包一次最多发 ${maxSend} 张，后面的已忽略`);
      break;
    }
    const id = String(raw ?? '').trim();
    if (!id) continue;
    const item = hub?.memes?.get?.(id);
    if (!item) {
      log(`表情包 id 不存在，已忽略：${id}`);
      continue;
    }
    const file = hub.memes.pathOf(id);
    if (!file) {
      log(`表情包没有本地文件，已忽略：${id}`);
      continue;
    }
    hub.memes.noteUse(id);
    out.push({ id: item.id, file });
  }
  return out;
}

/** 会话作用域的回复工具：排队本批；上一批未发的在新调用进来时立即发出（m06083 定案）。 */
export function makeReplyTool(reply, hub, log, { deliverNow = null } = {}) {
  return defineTool({
    name: 'onebot_reply',
    description:
      '**唯一的发言出口**：把这一轮要说的话发到当前 OneBot 会话。调用后会**直接发出消息**——' +
      '一轮里**允许多次调用**，长报告分多次调用发正是推荐用法：每次新调用都会先把上一次已排队、' +
      '还没发出的内容立即发出去，再排队本次；最后一次排队的内容在回合结束时发出。' +
      '任何需要发出的内容都必须走 onebot_reply——列清单、汇报、回答都一样；' +
      '你写在普通回复文本里的内容只是内部草稿，宿主**不会**替你发出去——不调这个工具就是沉默；' +
      '它可以附图、带引用、发表情包，也可以**一次发多条消息**（见下）。' +
      '纯灌水、只有表情、或下游 bot 已经应答过的话题，就不要调。',
    parameters: REPLY_TOOL_PARAMS,
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      // 修1（真机事故：reply failed -1935986436）：`hub-media:<id>` 先解析成 blob 本地路径，
      // 解析不出来当场报错——"已排队回复"不能变成一句谎话（与直发版共用 resolveReplyImages）。
      // 所有校验都放在 flush 之前：新调用本身有错时，上一批原封不动留给回合末，不会被白 flush。
      const images = resolveReplyImages(hub, args.images);
      // 修2（\`m25247\`）：\`parts\` 里的 \`hub-media:…\` 同样要落成 blob 本地路径，
      // 否则上游只收到一个自己认不得的字符串（retcode 1200）。解析不出来当场抛。
      // 语音合成段（`m29000`）先合成本地文件、换成普通 `record` 段，再做 hub-media 解析
      // （合成出来的路径本来就在壳里，不需要再解一次；顺序反了也没坏处，只是多扫一遍）。
      const speech = await resolvePartsSpeech(hub, args.parts);
      const parts = resolvePartsMedia(hub, speech.parts);
      // 这次真被抽走的包（id -> 段）：万一最后一条也排不上，要原封放回去。
      const consumedPackages = new Map();
      const memes = resolveMemesForSend(hub, args.memes, log);
      const missing = (Array.isArray(args.memes) ? args.memes : []).filter(
        (id) => !memes.some((m) => m.id === String(id ?? '').trim()),
      );
      if (!String(args.text ?? '').trim() && !images.length && !memes.length && !(Array.isArray(args.parts) && args.parts.length)) {
        throw new Error(
          missing.length
            ? `这些表情包 id 不存在：${missing.join('、')}；请改用上下文清单里的 id`
            : 'onebot_reply 需要 text、parts、images 或 memes',
        );
      }
      // m06083 定案：新排队时先把上一条未发的候选**立即发出**——分批长报告全到达、顺序不乱，
      // "改口重发"的旧语义由"草稿+终稿都发"取代（同刻缓冲里最多只有一批）。
      const lines = [];
      const previous = reply.take();
      if (previous) {
        if (typeof deliverNow !== 'function') {
          /**
           * 理论不可达（接线处必传）。原来的"别悄悄吞掉上一批"是假的：
           * `previous.segments` 是**协议形**（`{type:'text', data:{text}}`），
           * 而 `capture` 要的是**工具形**（`{type:'text', text}`）——`normalizeParts`
           * 认不出 `data.text`，整批变成一条空消息。现在真的转回去，转不动就说清楚。
           */
          const requeued = partsFromSegments(previous.segments);
          if (requeued && requeued.length) {
            reply.capture({ parts: requeued, quote: previous.quote });
            log('onebot_reply：没有可用的投递通道，上一批回复留在队列里（回合末发出）');
          } else {
            lines.push('上一条回复没能重新排队（里面有合并转发/包这类转不回草稿的段），本次内容照常排队。');
            log('onebot_reply：没有可用的投递通道，且上一批含不可回退的段，已放弃');
          }
        } else {
          const r = await deliverNow(previous);
          if (r?.status === 'failed') {
            // deliver 的 failedAt 是 1 起数的"第几条没发出去"（lib/mind.js）。
            lines.push(`上一条回复发送失败（第 ${r.failedAt ?? 1}/${r.total} 条没发出去，retcode ${r.retcode ?? '?'}）；本次内容照常排队。`);
          } else if (r) {
            lines.push(`上一条回复已直接发出（${r.sentCount ?? r.total}/${r.total} 条）。`);
          } else {
            lines.push('上一条回复没有发出（只读模式）；本次内容照常排队。');
          }
        }
      }
      const candidate = reply.capture({
        text: args.text,
        parts,
        images,
        memes,
        quote: args.quote_message_id,
        // 语音没合成出来的原因也走 skipped（与"解不出的 @ 段"同一个列表）。
        notes: speech.notes,
        // 「会话间的转达」的包在这里展开（`m25983`）：模型只给 id，段内容在枢纽手里。
        // 取走即消耗——同一个包不能被发两次。
        resolvePackage: (id) => hub.cross?.takePackage?.(id) ?? null,
        // 包是**单次使用**的：拿到就算消耗掉了。若最后一条也没排上（比如正文空、图片坏了），
        // 那个包就白扣了——模型会发现“包不存在或已过期”，而真相是它自己刚刚用掉了。
        // `composeReply` 发现一条也排不上时会把 `consumed` 里的包原封放回去。
        restorePackage: (id, segments) => hub.cross?.restorePackage?.(id, segments) === true,
        // 哪些包真正被取走了——只有它们需要还。
        // 传进去的引用必须和上一步读包时用的是**同一张**表（否则包被取走了、账上却是空的，还不了）。
        consumed: consumedPackages,
      });
      if (!candidate) {
        // 什么都没排上：把"为什么"说清楚（编造的 id、解不出的 @ 段…），别让它以为发出去了。
        // 诊断这一路只**看**不取：真取走会把包用掉，而这里只是想知道"为什么没排上"。
        // 手里那些被抽走的包已经在 `composeReply` 尾部原封放回去了。
        const plan = composeReply({
          text: args.text,
          parts,
          images,
          memes,
          notes: speech.notes,
          resolvePackage: (id) => hub.cross?.packages?.peek?.(id)?.segments ?? null,
        });
        const why = [...describePlanIssues(plan), ...(missing.length ? [`这些表情包 id 不存在：${missing.join('、')}`] : [])];
        throw new Error(why.length ? why.join('；') : 'onebot_reply 排出的内容全是空的，已忽略。');
      }
      // 回执要如实反映"这次排了几条、少发了几条"（§26 的老规矩）：模型必须知道拆成了什么。
      lines.push(`已排队回复（下一次调用或回合结束时发出）：${describeReply(candidate)}`);
      if (candidate.messages.length > 1) {
        const kinds = candidate.messages.map((m, i) => `${i + 1}.${m.kind === 'image' ? '图' : '文字'}`).join(' ');
        lines.push(`拆成 ${candidate.messages.length} 条消息（${kinds}）。`);
      }
      // 「少发了什么」统一进 notes（`m77611`）——这是本仓的参考实现，其它工具照这个形状写。
      const notes = describePlanIssues({
        dropped: candidate.dropped,
        skipped: candidate.skipped,
        maxText: candidate.limits?.maxText,
        maxImages: candidate.limits?.maxImages,
      });
      if (missing.length) notes.push(`这些表情包 id 不存在，没有发送：${missing.join('、')}`);
      return JSON.stringify({ head: lines.join('\n'), queued: true, notes }, null, 2);
    },
  });
}
