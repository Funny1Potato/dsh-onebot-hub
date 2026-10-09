/**
 * 仅测试用的桩：`@deepseek-ai/dsh-agent`。
 * 真 `installModelSelection` 的契约只能由真 DSH 证明——这里只保证调用路径走得通。
 */
export function installModelSelection(agentCtx, selection) {
  agentCtx.__modelSelection = selection;
}
