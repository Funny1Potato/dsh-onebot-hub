/**
 * 下游要**数字** `message_id`（`m72180`）。
 *
 * 官方接口的消息 id 是 `ROBOT1.0_xxx` 这种长串，而 NoneBot 的 OneBot v11 适配器把
 * `MessageEvent.message_id` 声明成 `int`——字符串过不去 pydantic 校验，整条事件被适配器
 * 丢掉，表现是"下游一条都收不到，但连接是通的"。协议端（LLOneBot / NapCat）给的是数字，
 * 所以这个坑只在官方通道上出现。
 *
 * 这一层负责双向换号：投下游前把原串换成稳定数字，下游回过来（引用 / 撤回 / 贴表情）
 * 再换回原串。数字原样保留，非数字才分配。
 */
export class MessageIdMap {
  /** 数字 → 原串。 */
  #numToRaw = new Map();
  /** 原串 → 数字（`fresh` 分配的不进这张表）。 */
  #rawToNum = new Map();
  #seq = 0;
  #limit;
  #base;

  constructor({ limit = 5000, base = 600_000_000 } = {}) {
    this.#limit = limit > 0 ? limit : 5000;
    this.#base = base;
  }

  get size() {
    return this.#numToRaw.size;
  }

  /**
   * 上游 id → 下游数字。
   *
   * @param {string|number|null|undefined} raw
   * @param {{fresh?:boolean}} [opts] `fresh` = 每次都分配新号（`virtualizeMessageId` 那档：
   *   连"同一串消息用同一个号"都不透露）。
   */
  toDownstream(raw, { fresh = false } = {}) {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const text = String(raw);
    // 原本就是数字（且在安全整数内）：原样给，别造新号——协议端的 id 到处都是引用。
    if (/^\d+$/.test(text) && text.length <= 15) return Number(text);
    if (!fresh) {
      const hit = this.#rawToNum.get(text);
      if (hit !== undefined) return hit;
    }
    let num = this.#base + (++this.#seq);
    while (this.#numToRaw.has(num)) num += 1;
    this.#numToRaw.set(num, text);
    if (!fresh) this.#rawToNum.set(text, num);
    this.#evict();
    return num;
  }

  /** 下游给回来的数字 → 上游原串；不认识的原样返回（让上游自己报错，别编）。 */
  toUpstream(value) {
    if (value === undefined || value === null || value === '') return value;
    const text = String(value);
    if (!/^\d+$/.test(text)) return value;
    return this.#numToRaw.get(Number(text)) ?? value;
  }

  /** 就地把动作参数里所有"指向一条消息"的 id 换回原串。 */
  unmapParams(params) {
    if (!params || typeof params !== 'object') return params;
    if (params.message_id !== undefined) params.message_id = this.toUpstream(params.message_id);
    for (const key of ['message', 'messages']) {
      const list = params[key];
      if (!Array.isArray(list)) continue;
      for (const seg of list) {
        if (seg?.type === 'reply' && seg.data?.id !== undefined) {
          seg.data = { ...seg.data, id: String(this.toUpstream(seg.data.id)) };
        }
        if (seg?.type === 'node' && Array.isArray(seg.data?.content)) {
          this.unmapParams({ message: seg.data.content });
        }
      }
    }
    return params;
  }

  #evict() {
    while (this.#numToRaw.size > this.#limit) {
      const oldest = this.#numToRaw.keys().next().value;
      const raw = this.#numToRaw.get(oldest);
      this.#numToRaw.delete(oldest);
      if (raw !== undefined && this.#rawToNum.get(raw) === oldest) this.#rawToNum.delete(raw);
    }
  }
}
