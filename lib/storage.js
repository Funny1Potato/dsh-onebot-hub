/**
 * 极小的本地 JSON 落盘底座（§21.9 / §24.10）。
 *
 * 三条原则，都是被"落盘把会话拖垮"这类事故逼出来的：
 *  1. **原子写**：先写 `<file>.tmp` 再 `rename`——半截 JSON 比没有文件更糟，
 *     而且读侧还要为此写一堆兜底。崩溃时最坏情况是丢掉最后一次写，不是读到坏文件。
 *  2. **落盘失败不抛**：磁盘满、权限不对、路径奇怪，都只记一笔日志。
 *     插件是聊天链路上的一环，不能因为写不了文件就停止转发消息。
 *  3. **合并写（防抖）**：能力注册表、缓存这类东西每问一次上游就变一次，
 *     逐次落盘等于把磁盘当内存用。`schedule()` 把同一文件的多次改合并成一次写。
 *
 * `dir` 为空字符串 = **关闭落盘**（所有方法退化成 no-op），部署上"不留痕"与测试都靠它。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 文件名安全化：linkId 里有 `:`、`/`，不能直接当文件名。 */
export function safeName(raw) {
  let out = '';
  for (const ch of String(raw ?? '')) {
    // ASCII 里的非法字符照旧塌成 `_`（这样已有的 linkId 文件路径不变），
    // 但**非 ASCII 必须逐字转义**：中文话题名以前会一起塌成同一个 `_.json`，
    // 结果是"每个中文话题都写进同一个文件、读谁都是最后写的那个"（踩过）。
    if (/^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else if (ch.codePointAt(0) < 128) out += '_';
    else out += `_${ch.codePointAt(0).toString(16)}_`;
  }
  return out.slice(0, 120) || 'default';
}

/** 默认数据目录（与 DSH 的 `~/.dsh` 放一起，方便一起备份/一起删）。 */
export function defaultStorageDir() {
  return path.join(os.homedir(), '.dsh', 'onebot-hub');
}

export class JsonStore {
  #pending = new Map();
  #timer = null;
  #written = 0;
  #errors = 0;
  #lastError = null;
  #lastWriteAt = null;

  /**
   * @param {{dir?:string, log?:Function, debounceMs?:number}} [opts] `dir` 为空 = 关闭。
   */
  constructor({ dir = '', log, debounceMs = 1500 } = {}) {
    this.dir = String(dir ?? '');
    this.log = log ?? (() => {});
    this.debounceMs = Math.max(50, Number(debounceMs) || 1500);
  }

  get enabled() {
    return this.dir !== '';
  }

  /** 数据文件绝对路径（`name` 可带子目录，如 `capabilities/down_30001000.json`）。 */
  path(name) {
    if (!this.enabled) return null;
    return path.join(this.dir, String(name));
  }

  /** 同步读。文件不存在返回 `fallback`；坏 JSON 改名 `.bad` 保留后返回 `fallback`。 */
  read(name, fallback = null) {
    const file = this.path(name);
    if (!file) return fallback;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return fallback;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      this.#errors += 1;
      this.#lastError = `读 ${name} 失败（JSON 坏了）：${err.message}`;
      this.log(`[storage] ${this.#lastError}`);
      try {
        fs.renameSync(file, `${file}.bad`);
      } catch {
        /* 改名失败也无所谓：下次写会覆盖它 */
      }
      return fallback;
    }
  }

  /** 原子写（同步）。失败记一笔日志并返回 false。 */
  write(name, data) {
    const file = this.path(name);
    if (!file) return false;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      this.#written += 1;
      this.#lastWriteAt = Date.now();
      return true;
    } catch (err) {
      this.#errors += 1;
      this.#lastError = `写 ${name} 失败：${err.message}`;
      this.log(`[storage] ${this.#lastError}`);
      return false;
    }
  }

  /**
   * 合并写：`producer` 是**惰性**的（真正落盘时才调用），所以连续改十次也只序列化一次。
   * @param {string} name
   * @param {() => any} producer
   */
  schedule(name, producer) {
    if (!this.enabled) return false;
    this.#pending.set(name, producer);
    if (this.#timer) return true;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.debounceMs);
    if (typeof this.#timer?.unref === 'function') this.#timer.unref();
    return true;
  }

  /** 列出某个子目录下已有的数据文件名（不含目录），关闭时返回 `[]`。 */
  list(dir) {
    if (!this.enabled) return [];
    try {
      return fs.readdirSync(path.join(this.dir, String(dir))).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  /** 立刻把所有待写落盘（进程退出、`onebot_caps({flush:true})` 都走它）。 */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.enabled) return 0;
    let n = 0;
    for (const [name, producer] of this.#pending) {
      let data;
      try {
        data = producer();
      } catch (err) {
        this.#errors += 1;
        this.#lastError = `序列化 ${name} 失败：${err.message}`;
        this.log(`[storage] ${this.#lastError}`);
        continue;
      }
      if (this.write(name, data)) n += 1;
    }
    this.#pending.clear();
    return n;
  }

  /** 停表并落盘（`hub.stop()` 调）。 */
  stop() {
    return this.flush();
  }

  get stats() {
    return {
      dir: this.dir || null,
      enabled: this.enabled,
      pending: this.#pending.size,
      written: this.#written,
      errors: this.#errors,
      lastError: this.#lastError,
      lastWriteAt: this.#lastWriteAt,
    };
  }
}

/**
 * 追加式 JSONL 落盘（L1 原始层 §24.10：真相永远是 jsonl，索引可重建）。
 * 与 `JsonStore` 分开是因为它按天分文件、只追加、不重写。
 */
export class JsonlLog {
  #fs;
  #dir;

  constructor({ dir = '', log, fsModule } = {}) {
    this.#dir = String(dir ?? '');
    this.log = log ?? (() => {});
    this.#fs = fsModule ?? fs;
  }

  get enabled() {
    return this.#dir !== '';
  }

  /** `<dir>/<name>/<yyyymmdd>.jsonl` */
  fileFor(name, at = Date.now()) {
    if (!this.enabled) return null;
    const d = new Date(at);
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.#dir, safeName(name), `${day}.jsonl`);
  }

  append(name, row, at = Date.now()) {
    const file = this.fileFor(name, at);
    if (!file) return false;
    try {
      this.#fs.mkdirSync(path.dirname(file), { recursive: true });
      this.#fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      return true;
    } catch (err) {
      this.log(`[storage] 追加 ${name} 失败：${err.message}`);
      return false;
    }
  }

  /** 读某个会话（或全部）的原始行；坏行跳过，不让一行脏数据废掉整份记录。 */
  read(name, { limit = 0 } = {}) {
    const dir = this.enabled ? path.join(this.#dir, safeName(name)) : null;
    if (!dir) return [];
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const rows = [];
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    return limit > 0 ? rows.slice(-limit) : rows;
  }
}
