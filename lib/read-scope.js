/**
 * 跨会话读取的「受众闸」（`m28349` 用户定案）。
 *
 * 起因是 `m28262` 的真机日志：私聊会话调 `onebot_timeline({sessionKey:"group:451403506"})`
 * 拿到了另一个群的 110 条原话。查下来不是漏洞，是**设计口径只覆盖了注入侧**——
 * `onebot_recall` 有隔离、`onebot_session` 有闸，而 `timeline` / `raw` / `context` /
 * `capture` / `memory` 全都直接吃参数里的 `sessionKey`，不看"你现在在哪个会话说话"。
 *
 * 为什么按**受众**判、而不是按"哪两个会话"判：同一个 agent，在私聊里说给一个人听，
 * 在群里说给一整个群听。隔离真正要防的不是"读到"，而是"读到的内容被说给不该听的人"。
 * 所以判据是**当前会话的受众**：
 *
 * - 群会话（`group:<gid>`）：群里所有成员都是观众 → **所有群聊可读，任何私聊不可读**（硬边界，无开关）。
 * - 白名单私聊（`isolation.trustedPrivates`，通常就是主人自己）：结果只进他自己眼睛 → 读一切。
 * - 普通私聊：陌生人也能直接私聊 bot → 只能读自己这一条私聊。
 * - 推不出当前会话（非枢纽会话 / 嵌入场景）：一律拒绝（fail-closed），不猜。
 *
 * 写侧与发言侧的同类判定在 `lib/index.js` 调用点（记忆只准写当前会话、`onebot_reply`
 * 不准点别的会话），规则表集中在这里，免得三处各写一份又长歪。
 */

/** 把配置里的私聊白名单归一成「纯数字 QQ 号」的 Set；认 `private:10001` 与裸号两种写法。 */
export function parseTrustedPrivates(raw) {
  const out = new Set();
  let list = raw;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text) return out;
    try {
      const parsed = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : text.split(/[,，\s]+/);
    } catch {
      list = text.split(/[,，\s]+/);
    }
  }
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const id = String(item ?? '')
      .trim()
      .replace(/^private:/, '');
    if (/^\d+$/.test(id)) out.add(id);
  }
  return out;
}

/** `group:1` → `'group'`；`private:1` → `'private'`；其它 → `''`。 */
export function sessionKind(key) {
  const m = String(key ?? '')
    .trim()
    .match(/^(group|private):\d+$/);
  return m ? m[1] : '';
}

/** 取私聊的 QQ 号（`private:10001` → `'10001'`），不是私聊就返回空串。 */
export function privateIdOf(key) {
  const m = String(key ?? '')
    .trim()
    .match(/^private:(\d+)$/);
  return m ? m[1] : '';
}

/**
 * 当前会话能不能读目标会话。
 *
 * @param {object} ctx
 * @param {string} ctx.current  当前会话键（`inferSessionKey()` 的结果，可能为空）
 * @param {string} ctx.target   要读的会话键（空＝就是当前会话）
 * @param {Set<string>} [ctx.trusted] 白名单私聊（`parseTrustedPrivates` 的产物）
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function canRead({ current, target, trusted = new Set() } = {}) {
  const cur = String(current ?? '').trim();
  const want = String(target ?? '').trim() || cur;
  const curKind = sessionKind(cur);
  if (!curKind) {
    return {
      ok: false,
      reason:
        `读不了 ${want || '别的会话'}：认不出你现在在哪个会话（不是枢纽拉起的会话）。` +
        '跨会话读取只在枢纽自己的会话里可用；要看别处的消息，用 onebot_session 递一句过去问。',
    };
  }
  if (!sessionKind(want)) {
    return { ok: false, reason: `会话键 ${want} 不合法（应该是 group:<群号> 或 private:<QQ号>）。` };
  }
  if (cur === want) return { ok: true };
  // 总闸（`m28425` 用户定案）：“若白名单为空则拒绝所有跨会话”。白名单默认吃
  // `chatCommands.superUsers`（超管名单）——没有超管就等于**没人授权过跨会话读取**，
  // 这时群会话也读不到旁边的群：能读哪几个会话，本质上是"谁给了这个 bot 这个权限"。
  if (!trusted.size) {
    return {
      ok: false,
      reason:
        `读不了 ${want}：跨会话读取需要一支白名单（默认取聊天命令的超管名单 chatCommands.superUsers），` +
        '现在一个都没有，所以只能读当前会话。要开就把超管配上，或单独配 isolation.trustedPrivates。',
    };
  }
  if (curKind === 'group') {
    if (sessionKind(want) === 'group') return { ok: true };
    // 硬边界（`m28349`）：群里永远不读私聊。没有开关——"把主人私聊的内容念给一群人听"
    // 没有正当用途，留着开关只会有人打开它。
    return {
      ok: false,
      reason:
        `读不了私聊 ${want}：你现在在一个群会话里，群消息所有成员都看得见，` +
        '所以群会话不读任何私聊（这条没有开关）。要问那边，用 onebot_session 递一句过去。',
    };
  }
  // 当前是私聊。
  const me = privateIdOf(cur);
  if (me && trusted.has(me)) return { ok: true };
  if (sessionKind(want) === 'group') {
    return {
      ok: false,
      reason:
        `读不了 ${want}：这个私聊不在 isolation.trustedPrivates 白名单里，只能读自己这条私聊。` +
        '（白名单由超管在设置页维护；被拒就别反复重试。）',
    };
  }
  return {
    ok: false,
    reason:
      `读不了私聊 ${want}：每个私聊只能读自己那条。只有 isolation.trustedPrivates 白名单里的私聊（一般就是主人自己）才不限。`,
  };
}

/** 给人看的一句话：当前会话能读什么（用在工具描述与拒绝话里，省得模型瞎试）。 */
export function describeReadScope({ current, trusted = new Set() } = {}) {
  const cur = String(current ?? '').trim();
  const kind = sessionKind(cur);
  if (!kind) return '当前会话认不出来，跨会话读取不可用。';
  if (!trusted.size) return '白名单为空（没配超管也没配 isolation.trustedPrivates）：只能读当前会话。';
  if (kind === 'group') return '当前是群会话：所有群聊可读，私聊一律不可读。';
  const me = privateIdOf(cur);
  if (me && trusted.has(me)) return '当前是白名单私聊：所有会话可读。';
  return '当前是普通私聊：只能读自己这条私聊。';
}
