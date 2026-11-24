/**
 * 会话代理池（§21.6 / §21.8）：每个 `agentKey` 一个 DSH agent，串行、LRU、空闲回收。
 *
 * 这里**不 import 任何宿主模块**：DSH 的 `agents`/`sessionPersistence`/`installModelSelection`
 * 都通过 `host` 注入。好处是纯 node 下可以用假 host 跑完整链路（`test/m15-e2e.mjs`），
 * 而 `lib/index.js` 里注入真宿主即可跑真模型。
 */

/** 宿主的"会话已存在"报错判定（措辞可能变，做个宽匹配）。 */
function isAlreadyExists(err) {
  const msg = String(err?.message ?? err ?? '');
  return /already exists|already been created|duplicate/i.test(msg);
}

export class AgentPool {
  #agents = new Map(); // agentKey -> { agent, lastUsed, busy, turns, seps }
  #tails = new Map(); // agentKey -> Promise（串行链）
  #pending = new Map(); // agentKey -> 排队+在飞的任务数（`isBusy` 的依据，enqueue/finally 自清）
  #ensuring = new Map(); // agentKey -> 尚未交回宿主句柄的 ensure
  #epochs = new Map(); // 清理隔离代数：排在队列里的旧任务不能等清理结束再跑
  #quiescing = new Map(); // agentKey -> 当前正在停止/释放的工作
  #quiesced = new Map(); // 阻止创建/领养；值为 true 时释放后仍等宿主退役
  #retiring = new Map(); // agentKey -> 宿主退役串行链（同一个 id 不能并行旋转）
  #discarded = new Map(); // 不可复用的句柄；释放失败时保留给下一次清理重试

  constructor({ policy, host, log } = {}) {
    this.policy = policy;
    this.host = host;
    this.log = log ?? (() => {});
    this.stats = { created: 0, resumed: 0, wakes: 0, errors: 0, disposed: 0, unarchived: 0, adopted: 0, retired: 0, lastRetire: null, lastErrors: [] };
  }

  get size() {
    return this.#agents.size;
  }

  list() {
    return [...this.#agents.entries()].map(([agentKey, rec]) => ({
      agentKey,
      busy: rec.busy,
      turns: rec.turns,
      idleMs: Date.now() - rec.lastUsed,
    }));
  }

  /** 串行化：同一个 agentKey 的唤醒排队，避免并发写同一个会话。 */
  enqueue(agentKey, work) {
    // 排队/在飞计数：`rec.busy` 只在 wake 的 work 里置位，"排着队还没开跑"的任务它看不见。
    // 归档守卫（`isBusy`）要把排队中的也算忙，否则照样会把马上要开工的 agent 连坐归档（m30055）。
    this.#pending.set(agentKey, (this.#pending.get(agentKey) ?? 0) + 1);
    const prev = this.#tails.get(agentKey) ?? Promise.resolve();
    const next = prev.then(work, work).catch((err) => {
      this.stats.errors += 1;
      // 留一条最近错误：status 里 otherwise 只有计数，排查时没有线索。
      // 只留最后一条也不够用（实测：一个会话把写句柄占了之后，后面的错误全被它覆盖，
      // 看不到**第一条**错误是什么），所以留最近 5 条。
      const message = String(err?.message ?? err);
      this.stats.lastError = { agentKey, at: Date.now(), message };
      this.stats.lastErrors = [...(this.stats.lastErrors ?? []), this.stats.lastError].slice(-5);
      this.log(`代理任务失败 agentKey=${agentKey}: ${message}`);
      return { ok: false, error: message };
    });
    // next 永不 reject（catch 已兜住），浮动 finally 只做计数回收，安全。
    next.finally(() => {
      const left = (this.#pending.get(agentKey) ?? 1) - 1;
      if (left <= 0) this.#pending.delete(agentKey);
      else this.#pending.set(agentKey, left);
    });
    this.#tails.set(agentKey, next.then(() => undefined).catch(() => undefined));
    return next;
  }

  /**
   * 该 agent 是否手头有活（在飞回合或排队中的唤醒）。
   * 归档守卫用（`mind.#expireAwake`）：实测（m30055）agent 长思考 + 连环排查会把回合拖过
   * `awakeMs`，空转超时把会话归档时宿主 `stopActivity` 会把在飞回合连同 subagent 一起掐掉——
   * 活儿没干完不算"空转"。
   */
  isBusy(agentKey) {
    if ((this.#pending.get(agentKey) ?? 0) > 0) return true;
    return Boolean(this.#agents.get(agentKey)?.busy);
  }

  /**
   * 插话（m31311 用户定案）：把一条消息递给**在飞**的回合。宿主侧原语（asar 实测）：
   * `followup()` 排 next-turn（只能等回合结束），`steer()` 排 next-step——在下一个步骤
   * 边界被认领、拼进**同一回合**继续跑；运行时上下文每步重新投影，插话那步模型自动看到
   * 最新窗口/记忆。会话刚好空闲时 steer 等同开新一轮——天然兜底，消息不丢。
   *
   * 只对**在飞**（`rec.busy`，由 `wake()` 置位/清位）的会话生效：不在飞/宿主不支持/递送
   * 失败一律返回 null，调用方回落普通排队，消息留在批量窗口里。 busy 的置位与清位之间
   * 没有异步间隙（wake 的 finally 是同步段），所以"刚好收尾的瞬间插话"这种竞态不存在。
   *
   * @returns {null | () => Promise<void>} 成功时给一个 waiter：等这一轮**彻底**空闲
   *   （插话会延长当前回合，`whenIdle()` 覆盖插话后的延续步骤）。
   */
  steer(agentKey, { text, summary = '插话', source, parts = null } = {}) {
    const rec = this.#agents.get(agentKey);
    if (!rec || !rec.busy) return null;
    const agent = rec.agent;
    if (typeof agent?.steer !== 'function') return null;
    let message;
    try {
      // 与 `wake` 同一条构造路径：插话也是**用户消息**（内容段数组 + 生产者自己的 source），
      // 否则模型收到的是裸字符串而不是一条可读的会话消息。
      message = this.#userMessage({ text, summary, source, parts });
    } catch (err) {
      this.log(`steer 消息构造失败 agentKey=${agentKey}: ${err?.message ?? err}`);
      return null;
    }
    try {
      agent.steer(message);
    } catch (err) {
      this.log(`steer 失败 agentKey=${agentKey}: ${err?.message ?? err}`);
      return null;
    }
    const idle =
      typeof agent?.whenIdle === 'function'
        ? () => agent.whenIdle()
        : () => Promise.resolve();
    return idle;
  }

  /**
   * 构造一条交给宿主的用户消息（`wake` 与 `steer` 共用，保证两条路的消息形状一模一样）。
   */
  #userMessage({ text, summary, source, parts }) {
    const content = [{ type: 'text', text: String(text ?? '') }, ...(Array.isArray(parts) ? parts : [])];
    return typeof this.host.createUserMessage === 'function'
      ? this.host.createUserMessage({
          // createUserMessage 要的是**内容段数组**，不是裸字符串（照 dsh-onebot 的用法：
          // content.push({type:'text', text})）。传字符串会直接抛。
          content,
          // source 必须是**生产者自己的 kind**：v4 会话格式（`lib/types/message-sources.js`
          // 的 `source()`）明文拒绝 `kind: 'plugin'`——那是已退役的 V3 写法，真机报
          // `format v4 message requires a producer-owned source kind`，整轮在写会话日志时就死了
          // （模型根本没跑）。元数据字段随意，`form`/`summary` 只是给我们自己看的归属。
          source: source ?? { kind: 'onebot-hub', form: 'chat', summary },
        })
      : { role: 'user', content };
  }

  ensure(agentKey, setup, { isCurrent = () => true } = {}) {
    const epoch = this.#epochs.get(agentKey);
    const current = () => isCurrent() && this.#epochs.get(agentKey) === epoch
      && !this.#quiesced.has(agentKey);
    if (!current()) return Promise.resolve(null);
    const previous = this.#ensuring.get(agentKey);
    if (previous) return previous.then((agent) => current() ? agent : null);
    const guardedSetup = setup && ((...args) => { if (current()) return setup(...args); });
    const task = Promise.resolve().then(() => this.#ensure(agentKey, guardedSetup, current)).finally(() => {
      if (this.#ensuring.get(agentKey) === task) this.#ensuring.delete(agentKey);
    });
    this.#ensuring.set(agentKey, task);
    return task;
  }

  async #ensure(agentKey, setup, current) {
    if (!current()) return null;
    const existing = this.#agents.get(agentKey);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.agent;
    }
    if (typeof this.host?.create !== 'function' && typeof this.host?.resume !== 'function') {
      throw new Error('agent 通道未就绪：宿主 agents 服务不可用（枢纽仍在转发，只是无法唤醒）');
    }
    // 先看宿主里有没有**活着的** agent：有就领养。
    // 坑（实测线上）：宿主把 agent 发布出来（= 端手里握着这个会话的写句柄）之后，如果那一轮
    // 没走完（或我们没能把它记进表里），再 `create`/`resume` 同一个 session 就会分别撞上
    // `session "…" already exists`（在磁盘上）和 `session "…" is already owned by an active write handle`
    // （`claimWrite` 见有人占着）——**整轮唤醒直接失败，用户看到的就是"没回复了"**。
    // 领养走 `ctx.agents.get(sessionId)`（"Look up a live agent"），拿到的就是那个已经发布、
    // 可以 `followup` 的 agent，不必也不该再 create/resume。
    const adopted = await this.#adoptLive(agentKey, '宿主里已有活着的 agent', current);
    if (adopted || !current()) return adopted;
    const has = this.host.hasSession ? await this.host.hasSession(agentKey) : false;
    if (!current()) return null;
    let handle;
    if (has) {
      try {
        handle = await this.host.resume({ agentKey, setup });
        this.stats.resumed += 1;
      } catch (err) {
        const live = await this.#adoptLive(agentKey, `resume 失败后重试领养（${err?.message ?? err}）`, current);
        if (live || !current()) return live;
        throw err;
      }
    } else {
      try {
        handle = await this.host.create({ agentKey, setup });
        this.stats.created += 1;
      } catch (err) {
        if (!current()) return null;
        // 坑（实测线上）：会话 id 已被占，但 `sessionPersistence.list()` 看不到它——
        // 上一次进程留下的**只有 session 头、没落盘内容**的会话就是这种状态。此时 create
        // 直接抛 `session "…" already exists`，整轮唤醒就废了；回退到 resume。
        if (typeof this.host.resume !== 'function' || !isAlreadyExists(err)) {
          const live = await this.#adoptLive(agentKey, `create 失败后重试领养（${err?.message ?? err}）`, current);
          if (live || !current()) return live;
          throw err;
        }
        this.log(`会话 ${agentKey} 已存在但 list() 看不到，回退 resume`);
        try {
          handle = await this.host.resume({ agentKey, setup });
          this.stats.resumed += 1;
        } catch (err2) {
          const live = await this.#adoptLive(agentKey, `回退 resume 失败后重试领养（${err2?.message ?? err2}）`, current);
          if (live || !current()) return live;
          throw err2;
        }
      }
    }
    // 真宿主 `ctx.agents.create/resume()` 返回的是**句柄**，会话对象在 `handle.agent`
    // （照 dsh-onebot 的用法：`const { agent } = entry.handle`）。返回裸 agent 的假宿主也一并兼容。
    const agent = handle?.agent ?? handle;
    if (!current()) {
      // 宿主调用不能撤销：晚归的句柄交给清理屏障释放，绝不登记为可唤醒的 agent。
      if (handle) this.#discarded.set(agentKey, { agent, handle });
      return null;
    }
    if (!agent || typeof agent.followup !== 'function') {
      const keys = handle && typeof handle === 'object' ? Object.keys(handle).join(',') : String(handle);
      throw new Error(`宿主返回的会话不可用（handle 字段：${keys || '空'}）`);
    }
    this.#agents.set(agentKey, { agent, handle, lastUsed: Date.now(), busy: false, turns: 0 });
    // **保护刚建的这个**：满载且其它 rec 全忙时，唯一的非 busy 候选就是它自己，
    // 老代码会把它 dispose 掉再把 agent 返回给调用方——调用方随后 `get(agentKey)`
    // 拿到 undefined，`rec.busy = true` 抛 TypeError，被兜成"代理任务失败"，
    // 表现为"新会话唤醒静默失败"。
    this.#evictIfNeeded({ protect: agentKey });
    return agent;
  }

  /**
   * 领养宿主里活着的 agent（`ctx.agents.get(id)`）。
   * 领养来的没有句柄：`dispose()` 仍会尽量走 `agent.dispose()`（宿主给的活 agent 一般有），
   * 拿不到就当"只从这张表里摘掉"——反正不该因为我们摘表把别人的 agent 弄死。
   */
  async #adoptLive(agentKey, why, current) {
    if (!current() || typeof this.host?.getLive !== 'function') return null;
    let live = null;
    try {
      live = await this.host.getLive(agentKey);
    } catch (err) {
      this.log(`查活着的 agent 失败 ${agentKey}: ${err?.message ?? err}`);
      return null;
    }
    if (!live || typeof live.followup !== 'function') return null;
    if (!current()) {
      this.#discarded.set(agentKey, { agent: live, handle: null });
      return null;
    }
    this.log(`会话 ${agentKey} ${why}，直接领养`);
    this.stats.adopted += 1;
    const rec = { agent: live, handle: null, adopted: true, lastUsed: Date.now(), busy: false, turns: 0 };
    this.#agents.set(agentKey, rec);
    this.#evictIfNeeded({ protect: agentKey });
    return live;
  }

  /**
   * 唤醒一个会话代理。
   * @param {string} agentKey
   * @param {{text:string, summary?:string, setup?:(agentCtx:any)=>void, parts?:Array<object>}} input
   */
  async wake(agentKey, { text, summary = '新消息', setup, source, parts = null, isCurrent = () => true } = {}) {
    const epoch = this.#epochs.get(agentKey);
    const current = () => isCurrent() && this.#epochs.get(agentKey) === epoch
      && !this.#quiesced.has(agentKey);
    const cancelled = { ok: false, error: '会话已被清理' };
    return this.enqueue(agentKey, async () => {
      if (!current()) return cancelled;
      // 真机事故 #2（`turnEnd:'blocked'`）：会话一旦进了宿主的归档集合，`archived-session-gate`
      // 就会在 `agent/pre-step` 直接返回 `{ kind:'reject' }`，回合以 `turn/end {kind:'blocked'}`
      // 结束——没有 `step/start`、没有模型请求，表现和"模型不愿说话"一模一样（`pool.errors` 还是 0）。
      // hub 的会话是它自己建的，不该受用户/界面归档门控，所以唤醒前先取消归档。
      const unarchive = await this.#unarchive(agentKey);
      if (!current()) return cancelled;
      const agent = await this.ensure(agentKey, setup, { isCurrent: current });
      const rec = this.#agents.get(agentKey);
      if (!current() || !agent || rec?.agent !== agent) return cancelled;
      const message = this.#userMessage({ text, summary, source, parts });
      if (!current() || this.#agents.get(agentKey) !== rec) return cancelled;
      rec.busy = true;
      rec.lastUsed = Date.now();
      this.stats.wakes += 1;
      try {
        agent.followup(message);
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
        if (!current()) return cancelled;
        rec.turns += 1;
        return { ok: true, agentKey, turns: rec.turns, unarchive };
      } finally {
        rec.busy = false;
        rec.lastUsed = Date.now();
      }
    });
  }

  /**
   * 唤醒前把会话从宿主的归档集合里摘出来（幂等；宿主没有 workspaceRegistry 时静默跳过）。
   * 失败**不挡唤醒**：摘不掉顶多这一轮被门控成 blocked，总比整轮抛错好。
   */
  async #unarchive(agentKey) {
    if (typeof this.host?.unarchive !== 'function') return null;
    try {
      const info = await this.host.unarchive(agentKey);
      if (info?.archived) this.stats.unarchived += 1;
      return info ?? null;
    } catch (err) {
      this.log(`取消归档失败 ${agentKey}: ${err?.message ?? err}`);
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** 停止旧 agent 并等晚到的句柄释放；hold=false 用于换绑而不归档，清理则保持锁直到 retire。 */
  quiesce(agentKey, reason, { hold = true } = {}) {
    const rebindBlocked = () => new Error('这个会话正在清理，不能换绑');
    const verifyReleased = () => {
      if (this.#quiesced.get(agentKey) === true) throw rebindBlocked();
    };
    if (!hold && this.#quiesced.get(agentKey) === true) return Promise.reject(rebindBlocked());
    const previous = this.#quiescing.get(agentKey);
    this.#quiesced.set(agentKey, hold || this.#quiesced.get(agentKey) === true);
    if (previous) return hold ? previous : previous.then(verifyReleased);
    this.#epochs.set(agentKey, (this.#epochs.get(agentKey) ?? 0) + 1);
    const live = this.#agents.get(agentKey);
    this.#agents.delete(agentKey);
    if (live) this.#discarded.set(agentKey, live);
    const ensuring = this.#ensuring.get(agentKey);
    const tail = this.#tails.get(agentKey);
    const release = async () => {
      const rec = this.#discarded.get(agentKey);
      if (!rec) return;
      const target = typeof rec.handle?.dispose === 'function' ? rec.handle : rec.agent;
      await target?.dispose?.(reason);
      this.#discarded.delete(agentKey);
      this.stats.disposed += 1;
    };
    let released = false;
    const task = Promise.resolve().then(async () => {
      // 先打断已开始的模型回合，否则 Mind 等它结束可能一直超时。
      await release();
      await ensuring?.catch(() => {}); // ensure 的失败另由调用方处理；成功晚归也不能进池
      await release();
      await tail; // 旧队列也要走完，例如已发给宿主、还未返回的 unarchive。
      released = true;
    }).finally(() => {
      if (this.#quiescing.get(agentKey) !== task) return;
      this.#quiescing.delete(agentKey);
      if (released && this.#quiesced.get(agentKey) === false) this.#quiesced.delete(agentKey);
    });
    this.#quiescing.set(agentKey, task);
    return hold ? task : task.then(verifyReleased);
  }

  dispose(agentKey, reason = 'manual') {
    const rec = this.#agents.get(agentKey);
    if (!rec) return false;
    try {
      // 句柄优先（真宿主的 dispose 在 handle 上），裸 agent 作为兜底。
      const target = typeof rec.handle?.dispose === 'function' ? rec.handle : rec.agent;
      const result = target?.dispose?.(reason);
      if (result && typeof result.then === 'function') void result.catch(() => {});
    } catch (err) {
      this.log(`dispose 失败 ${agentKey}: ${err?.message ?? err}`);
    }
    this.#agents.delete(agentKey);
    this.stats.disposed += 1;
    return true;
  }

  /**
   * **交还一个会话**（激活结束时用，用户定案："每次激活结束后落盘记忆并清除会话记录"）。
   *
   * 做两件事：① 把活着的 agent 处置掉（真宿主的 dispose 在 handle 上）——**必须先处置**，
   * 否则它握着会话写句柄，下一轮 create 会撞 `already owned by an active write handle`；
   * ② 让宿主把那个会话"清掉或换掉"（`host.retire`：能删就删、删不掉就换一个会话 id）。
   * 之后同一个 agentKey 再 `ensure()` 会走 create，拿到一个**空转录**的新会话。
   */
  retire(agentKey, reason = 'dormant') {
    const purging = reason === 'purged:session-data';
    const previous = this.#retiring.get(agentKey);
    const stopped = purging ? this.quiesce(agentKey, reason) : this.dispose(agentKey, reason);
    const retire = async () => {
      const info = await this.#retireHost(agentKey);
      if (purging && info.ok !== false && this.#retiring.get(agentKey) === task) this.#quiesced.delete(agentKey);
      return info;
    };
    // 普通的休眠退役没有竞争时沿用立即调用宿主的时序；清理则必须先等释放及前次退役。
    const task = purging || previous ? Promise.all([previous?.catch(() => {}), stopped]).then(retire) : this.#retireHost(agentKey);
    const clear = () => { if (this.#retiring.get(agentKey) === task) this.#retiring.delete(agentKey); };
    this.#retiring.set(agentKey, task);
    void task.then(clear, clear);
    return task;
  }

  async #retireHost(agentKey) {
    let info = null;
    try {
      info = (await this.host?.retire?.(agentKey)) ?? null;
    } catch (err) {
      info = { ok: false, error: String(err?.message ?? err) };
      this.log(`retire 失败 ${agentKey}: ${info.error}`);
    }
    this.stats.retired = (this.stats.retired ?? 0) + 1;
    this.stats.lastRetire = { agentKey, at: Date.now(), ...(info ?? {}) };
    return this.stats.lastRetire;
  }

  disposeIdle(now = Date.now()) {
    const disposed = [];
    for (const [agentKey, rec] of [...this.#agents.entries()]) {
      if (rec.busy) continue;
      if (now - rec.lastUsed >= this.policy.idleDisposeMs) {
        this.dispose(agentKey, 'idle');
        disposed.push(agentKey);
      }
    }
    return disposed;
  }

  disposeAll() {
    for (const agentKey of [...this.#agents.keys()]) this.dispose(agentKey, 'shutdown');
  }

  #evictIfNeeded({ protect = null } = {}) {
    while (this.#agents.size > this.policy.maxActive) {
      let victim = null;
      for (const [agentKey, rec] of this.#agents) {
        if (rec.busy || agentKey === protect) continue;
        if (!victim || rec.lastUsed < victim.rec.lastUsed) victim = { agentKey, rec };
      }
      if (!victim) return;
      this.dispose(victim.agentKey, 'lru');
    }
  }
}
