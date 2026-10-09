/**
 * 仅测试用的桩：`@deepseek-ai/dsh-llm`。
 * 这里刻意**校验形状**，因为真实现就是这个契约：
 *   createUserMessage({ content: [{type:'text', text}], source: {kind: <生产者自己的 kind>, ...} })
 * 传裸字符串会抛——load-check 要能抓到这类错。
 * `source.kind === 'plugin'` 也照真宿主的 v4 录取规则拒绝（`lib/types/message-sources.js` 的
 * `source()`：`format v4 message requires a producer-owned source kind`，见 README §9 那条真机事故）。
 */
export function createUserMessage({ content, source } = {}) {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('createUserMessage: content 必须是内容段数组');
  }
  for (const part of content) {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
      throw new Error('createUserMessage: content 段缺少 type');
    }
  }
  if (!source || typeof source !== 'object' || typeof source.kind !== 'string') {
    throw new Error('createUserMessage: 缺少 source.kind');
  }
  if (source.kind.length === 0 || source.kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind');
  }
  return { id: `stub-${content.length}`, role: 'user', content, source };
}
