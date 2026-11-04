/**
 * 仅测试用的桩：把 `@deepseek-ai/schemastery` 原样转出去（本地装得到真包）。
 *
 * 为什么需要它：CI 用 `npm install --omit=peer` 只装运行时依赖的闭包，devDependencies 不装，
 * `lib/index.js` 里 `await import('@deepseek-ai/schemastery')` 会走进 catch，`export const Config`
 * 就成了 `undefined`——契约快照立刻报"导出 Config 的类型从 function 变成了 undefined"。
 *
 * 契约要的是"真宿主里长什么样"，所以这里借 `stub-hooks.mjs` 的转出口去解析真包
 * **相对于仓库根**；仓库里没有真包时明确报错（宁可红，也不悄悄少测一块）。
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const url = pathToFileURL(join(process.cwd(), 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')).href;
const mod = await import(url);
export default mod.default ?? mod;
export const Schema = mod.Schema;
