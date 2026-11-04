/**
 * 工具定义的包装器（宿主 `@deepseek-ai/dsh-tools` 的 `defineTool`，探测不到就退化成恒等）。
 *
 * 为什么单独一个文件：`lib/index.js` 里原本是模块级的 `let defineTool`，工具定义与它同处
 * 一个作用域。工具拆到 `lib/tools/*.js` 之后，那些文件得拿到**同一个**包装器——如果各自
 * import 宿主包，就会出现「有的探测到、有的没探测到」的错位（而且每个文件一次动态 import）。
 * 所以这里放一个可替换的实现，`index.js` 探测到宿主能力后注入一次。
 */

let impl = (definition) => definition;

/** 宿主暴露了真正的 `defineTool` 时注入；没暴露就保持恒等兜底。 */
export function useDefineTool(fn) {
  if (typeof fn === 'function') impl = fn;
}

/** 工具定义入口（与宿主 `defineTool` 同签名）。 */
export function defineTool(definition) {
  return impl(definition);
}
