/**
 * 会话目录的档位（`m32112` 用户定案）。
 *
 * 单独一个文件只为一件事：**这一份清单要同时被宿主、设置页和测试引用**。
 * 上一版把枚举写在 schema 里、设置页再抄一份，两边一漂移就是"下拉里有、配置里不认"——
 * `test/client-manifest.mjs` 现在会拿这几个名字逐字对齐。
 *
 * 渲染不在这里：排序要用"最近有人说话"、要知道当前是哪个会话，那些只有 `mind` 有。
 */
export const DIRECTORY_MODES = ['off', 'names', 'full'];

/** 认不出的值一律回落 `names`（不静默关掉整段，也不猜 `full`）。 */
export const DEFAULT_DIRECTORY_MODE = 'names';
