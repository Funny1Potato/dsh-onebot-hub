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

/**
 * 只读 action 在读「哪个会话」（`m85249` 审查报告 P1-2）。
 *
 * `onebot_call` 以前只过分级闸（write/danger 白名单），**完全不过读范围闸**——
 * 于是群里一句 `get_group_msg_history` 就能把任意群的聊天记录读出来，
 * 而 `onebot_timeline`/`onebot_raw` 那四个工具守的规矩形同虚设。
 *
 * 这里只做「从参数认出目标会话」这件纯函数的事（认不出返回空串，交给调用方决定怎么办）。
 * 认法的优先级：群 → 人 → （`message_id` 那种要在调用方查索引，这里不碰 IO）。
 *
 * 注意：这不是"越权判定的宽松版"——认出目标后仍要过 `canRead`，两边规则是同一份。
 *
 * @param {Record<string, unknown>} params OneBot action 的参数
 * @returns {string} `group:<id>` / `private:<id>` / `''`（认不出）
 */
export function readTargetOfCall(params = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = p[key];
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  };
  const groupId = pick('group_id', 'groupId', 'group');
  if (groupId) return `group:${groupId}`;
  const userId = pick('user_id', 'userId', 'user');
  if (userId) return `private:${userId}`;
  return '';
}

/**
 * 这个会话是不是「本来就什么都能读」（白名单私聊）。
 *
 * 用在只认不出目标归属的时候：认不出就只剩两种选择——要么一律拒（会把白名单私聊
 * 也一起挡住），要么放行（等于给普通会话留个后门）。按身份分岔才两头都对。
 */
export function hasFullRead({ current, trusted = new Set() } = {}) {
  const cur = String(current ?? '').trim();
  const me = privateIdOf(cur);
  return Boolean(me && trusted.has(me));
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

/**
 * 按 id 查的接口：这条"读的目标"到底是谁（复审 F01）。
 *
 * 规则有三条，顺序是刻意的：
 * 1. **索引说了算**——`message_id`/`id`/纯数字的 `file` 查得到归属时，就以它为准；
 *    调用方另外塞的 `group_id/user_id` 只是"我以为我在查这个"，对不上就按冲突拒掉
 *    （上游会忽略多余参数，放过去等于开了个后门）。
 * 2. 索引里没有的 id 记成"认不出"（`'?'`），由调用方按身份决定放不放。
 * 3. 什么 id 都没有时，就按参数里的目标算（`get_group_msg_history` 这类）。
 *
 * @param {Record<string, unknown>} params
 * @param {(id:string)=>string} lookup 给 id 返回 `group:<n>` / `private:<n>`，查不到返回空串
 * @returns {{target:string, conflict:boolean, ids:string[]}}
 */
export function resolveReadTarget(params = {}, lookup = () => '', { full = false } = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const direct = readTargetOfCall(p);
  const file = String(p.file ?? '').trim();
  /**
   * `file` 也算 id（第三轮 T01）：合并转发的转发 ID、图片文件名都从这里进来，
   * 以前只认"至少五位的纯数字"，`file:"private-forward-id"` 就绕过了归属检查。
   * 路径与 URL 仍然不算（`onebot_media` 的 durable 模式会拿它们当来源）。
   */
  const fileIsId = Boolean(file) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !/[\\/]/.test(file);
  const ids = [
    String(p.message_id ?? '').trim(),
    String(p.id ?? '').trim(),
    fileIsId ? file : '',
  ].filter(Boolean);
  const owners = new Set();
  let unknown = false;
  for (const id of ids) {
    const key = String(lookup(id) ?? '').trim();
    if (key) owners.add(key);
    else unknown = true;
  }
  if (owners.size > 1) return { target: '?', conflict: true, ids };
  const owner = [...owners][0] ?? '';
  if (owner) {
    const clash = Boolean(direct && direct !== owner);
    // 每个资源都要有归属；已知的那个不能替另一个未知 id 背书。
    return { target: clash || (unknown && !full) ? '?' : owner, conflict: clash, ids };
  }
  /**
   * 有 id、却一个都对不上归属：**不许再拿附加的 `group_id/user_id` 兜底**（第三轮 T01）。
   * 上游会忽略多余参数，所以"索引里没有 90002，但我另外塞了本群号"就等于开了一道后门。
   * 只有本来就能读一切的私聊（`full`）才照旧按参数走。
   */
  if (unknown) return { target: full ? direct || '' : '?', conflict: false, ids };
  if (direct) return { target: direct, conflict: false, ids };
  return { target: '', conflict: false, ids };
}

/**
 * 发送/生成这类"往外递东西"的动作，目标是当前会话还是参数给的（复审 F05）。
 *
 * 默认只能往当前会话递；白名单私聊（本来就能读一切）可以代发。参数被忽略时
 * `ignored:true`，由调用方在回执里说一句——悄悄改目标比拒绝更糟。
 *
 * @param {{asked?:string, trusted?:string, canCross?:boolean}} opts
 * @returns {{sessionKey:string, ignored:boolean}}
 */
export function resolveSendTarget({ asked = '', trusted = '', canCross = false } = {}) {
  const me = String(trusted ?? '').trim();
  const want = String(asked ?? '').trim();
  if (!want || want === me) return { sessionKey: me, ignored: false };
  if (canCross) return { sessionKey: want, ignored: false };
  return { sessionKey: me, ignored: true };
}
