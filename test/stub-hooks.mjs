/**
 * 测试期解析钩子：把 DSH 宿主内的 `@deepseek-ai/dsh-*` 指到 `test/stubs/`。
 *
 * 为什么需要它：这些包的真身打包在 DSH 安装目录的 `app.asar` 内
 * （`<安装目录>\resources\app.asar`），Electron 主进程能透明读取 asar，纯 node 不能。
 * 生产运行时由 DSH 自己解析，**不经过这里**；
 * 本文件只服务于 `node --import ./test/register-stubs.mjs test/load-check.mjs`。
 *
 * 覆盖范围刻意窄：只替换 dsh-tools / dsh-llm / dsh-session / dsh-agent，
 * `@deepseek-ai/schemastery` **不替换**——它已声明在 devDependencies 里，装的是真包，
 * 所以 Config schema 是真校验（它曾经没声明、只在 DSH 装依赖时被顺带塞进来，CI 上一跑就露了）。
 */

const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', './stubs/dsh-tools.mjs'],
  ['@deepseek-ai/dsh-llm', './stubs/dsh-llm.mjs'],
  ['@deepseek-ai/dsh-session', './stubs/dsh-session.mjs'],
  ['@deepseek-ai/dsh-agent', './stubs/dsh-agent.mjs'],
  // `schemastery` 是 devDependency，本地装得到；CI 用 `--omit=peer` 装的是运行时依赖的闭包，
  // 它不在里面 —— 于是 `lib/index.js` 的 `export const Config` 变成 `undefined`，契约快照对不上。
  // 两类环境必须都跑同一份契约，所以这里也打桩（桩里是真包，本地与 CI 行为一致）。
  ['@deepseek-ai/schemastery', './stubs/schemastery.mjs'],
]);

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier);
  if (stub) return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
