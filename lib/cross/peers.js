// 外部会话名册（`m36838`）：枢纽和「别的插件 / 别的工作区拉起的会话」来往过，就记一笔。
//
// 为什么需要它：`onebot_session.list` 以前只能列出 `group:` / `private:`——外面那些
// `session-xxxxxxxx-…` 既列不出来，也递不进去，除非用户把 id 手抄给模型。现在记下"和谁
// 说过话"，`list` 就能把它们报出来；但**只报活着的**：一个已经关掉的会话列出来只会让
// 模型白白试一次。
//
// 只记这几个字段：第一次/最后一次来往的时间、各方向几次。不记内容——名字册不是聊天记录。

const MAX_ROWS = 200;

/** 外部会话 id：既不是枢纽的 `group:` / `private:`，也不是内部会话。 */
export const isExternalScope = (scope) => {
  const s = String(scope ?? '').trim();
  if (!s) return false;
  if (/^(group|private):/.test(s)) return false;
  // 内部会话（`task:hub` 这种）不对外：它没有用户可以对话的实体。
  if (/^(task|internal):/.test(s)) return false;
  return true;
};

export class PeerBook {
  /**
   * @param {object} opts
   * @param {{read?:Function, write?:Function}|null} opts.storage `hub.storage`（JsonStore）
   * @param {(scope:string)=>boolean} opts.isAlive 现在还活着吗（宿主里有 live agent）
   * @param {number} opts.limit `list` 里最多报几条
   */
  constructor({ storage = null, isAlive = () => false, limit = 10, now = Date.now } = {}) {
    this.storage = storage;
    this.isAlive = isAlive;
    this.limit = Math.max(1, Number(limit) || 10);
    this.now = typeof now === 'function' ? now : Date.now;
    this.#rows = new Map();
    this.#loaded = false;
  }

  #rows;

  #loaded;

  load() {
    if (this.#loaded) return this;
    this.#loaded = true;
    let raw = null;
    try {
      raw = this.storage?.read?.('cross-peers', null) ?? null;
    } catch {
      raw = null;
    }
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];
    for (const row of rows) {
      const scope = String(row?.scope ?? '');
      if (!isExternalScope(scope)) continue;
      this.#rows.set(scope, {
        scope,
        firstAt: Number(row.firstAt) || 0,
        lastAt: Number(row.lastAt) || 0,
        inbound: Math.max(0, Number(row.inbound) || 0),
        outbound: Math.max(0, Number(row.outbound) || 0),
      });
    }
    return this;
  }

  #save() {
    // 超过上限就丢最久没来往的那几条：名册是用来"列得出来"，不是档案。
    if (this.#rows.size > MAX_ROWS) {
      const sorted = [...this.#rows.values()].sort((a, b) => a.lastAt - b.lastAt);
      for (const row of sorted.slice(0, this.#rows.size - MAX_ROWS)) this.#rows.delete(row.scope);
    }
    try {
      this.storage?.write?.('cross-peers', { v: 1, rows: [...this.#rows.values()] });
    } catch {
      /* 落盘失败不影响本进程内的 list */
    }
  }

  /** 记一笔来往：`in` = 它来找我们，`out` = 我们递过去。 */
  note(scope, direction = 'out') {
    const key = String(scope ?? '').trim();
    if (!isExternalScope(key)) return null;
    this.load();
    const at = this.now();
    const row = this.#rows.get(key) ?? { scope: key, firstAt: at, lastAt: 0, inbound: 0, outbound: 0 };
    row.lastAt = at;
    if (direction === 'in') row.inbound += 1;
    else row.outbound += 1;
    this.#rows.set(key, row);
    this.#save();
    return row;
  }

  /** 所有记过的外部会话（含已关闭的，按最后来往倒序）。 */
  all() {
    this.load();
    return [...this.#rows.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  /** `list` 要报的那些：**只报活着的**，按最后来往倒序，最多 `limit` 条。 */
  alive() {
    const out = [];
    for (const row of this.all()) {
      if (out.length >= this.limit) break;
      let live = false;
      try {
        live = Boolean(this.isAlive?.(row.scope));
      } catch {
        live = false;
      }
      if (!live) continue;
      out.push({
        to: row.scope,
        label: '外部会话',
        lastAt: row.lastAt,
        inbound: row.inbound,
        outbound: row.outbound,
      });
    }
    return out;
  }
}
