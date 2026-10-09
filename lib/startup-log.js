/**
 * 启动轨迹（诊断用）。
 *
 * 为什么需要它：插件 apply 一旦抛错，宿主只会在插件列表上挂一个红色标记，**不落盘日志**，
 * 浏览器控制台也在另一个进程里够不着。真机上"设置页一直转圈 + 上下游都没连"就是这么查不下去的。
 * 所以插件自己把装配走到哪一步写进 `<storageDir>/startup.log`：失败时最后一行就是断点，
 * 成功时最后一行是 `apply:done`（顺带证明 apply 真的跑完了）。
 *
 * 三条纪律：
 *  - 任何写盘失败都吞掉：诊断代码绝不能把装配搞挂（`note/fail/reset` 返回 void，不抛）。
 *  - `storageDir` 为空（`persist:false`，测试就是）直接返回 `null`，调用点一律 `?.`。
 *  - 只记装配阶段，不记运行期事件（那些 timeline/raw 各自有落盘）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const STARTUP_LOG_FILE = 'startup.log';

/**
 * @param {string} storageDir 空字符串/未开持久化 → 返回 null（调用方用 `?.` 兜）。
 * @returns {{file:string,note:(stage:string)=>void,fail:(err:unknown)=>void,reset:()=>void}|null}
 */
export function createStartupLog(storageDir) {
  const dir = String(storageDir ?? '').trim();
  if (!dir) return null;
  const file = path.join(dir, STARTUP_LOG_FILE);

  const write = (line) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* 写不进去就算了：诊断不该影响装配 */
    }
  };

  return {
    file,
    note: (stage) => write(stage),
    fail: (err) => write(`FAIL ${err?.stack ?? err?.message ?? err}`),
    /** 一次新装配开始：留一行分隔，方便对着时间线看是不是老记录。 */
    reset: () => write('---- apply 开始 ----'),
  };
}
