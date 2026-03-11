/**
 * 解析合并转发子消息的 body.content 为可读文本
 */
export function formatMergeForwardSubMessage(
  contentJson: string,
  msgType: string,
  mentions?: Array<{ key: string; id: string; id_type: string; name: string }>,
): string {
  try {
    const body = JSON.parse(contentJson || '{}');

    if (msgType === 'text') {
      let t = (body.text as string) ?? '';
      // 解析 @mention 占位符
      if (t && Array.isArray(mentions)) {
        for (const m of mentions) {
          if (m.key) t = t.replaceAll(m.key, m.name ? `@${m.name}` : '');
        }
      }
      return t.trim();
    }

    if (msgType === 'post') {
      const postBody = Array.isArray(body.content)
        ? body
        : (body.zh_cn || body.en_us || body.ja_jp || Object.values(body)[0]) as Record<string, unknown> | undefined;
      const title = (postBody?.title as string) ?? '';
      const textParts: string[] = title ? [title] : [];
      for (const paragraph of (postBody?.content as Array<Array<Record<string, unknown>>>) ?? []) {
        for (const element of paragraph ?? []) {
          if (element.tag === 'text') textParts.push((element.text as string) ?? '');
        }
      }
      return textParts.join(' ').trim();
    }

    if (msgType === 'image') return '[图片]';
    if (msgType === 'file') return `[文件: ${body.file_name ?? ''}]`;
    if (msgType === 'audio') return '[语音消息]';
    if (msgType === 'video') return '[视频]';
    if (msgType === 'sticker') return '[表情]';
    if (msgType === 'merge_forward') return '[嵌套的合并转发消息]';

    return `[${msgType}消息]`;
  } catch {
    return `[${msgType}消息 - 解析失败]`;
  }
}
