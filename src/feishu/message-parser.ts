import { extractMessageText, type Mention } from './message-text.js';

/**
 * 解析合并转发子消息的 body.content 为可读文本。
 *
 * 委托给统一的 extractMessageText,确保 interactive 卡片不再被洗成 "[卡片消息]" 占位符。
 * 保留原签名与解析失败 fallback 行为,所有 caller 无需改动。
 */
export function formatMergeForwardSubMessage(
  contentJson: string,
  msgType: string,
  mentions?: Array<{ key: string; id: string; id_type: string; name: string }>,
): string {
  // 保留原 "解析失败" fallback：非空但不是合法 JSON 时返回明确错误占位符
  if (contentJson) {
    try {
      JSON.parse(contentJson);
    } catch {
      return `[${msgType}消息 - 解析失败]`;
    }
  }
  return extractMessageText(msgType, contentJson, mentions as Mention[] | undefined, {
    collectRefs: false,
  }).text;
}
