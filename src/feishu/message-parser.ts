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
      // 飞书引用回复时 text 可能被 <p> 等 HTML 标签包裹
      if (t.includes('<')) {
        t = t.replace(/<[^>]+>/g, '').trim();
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
          else if (element.tag === 'a') {
            const linkText = (element.text as string) ?? '';
            const href = (element.href as string) ?? '';
            textParts.push(linkText && href ? `[${linkText}](${href})` : href || linkText);
          }
          else if (element.tag === 'at') {
            const atName = (element.user_name as string) ?? '';
            if (atName) textParts.push(`@${atName}`);
          }
          else if (element.tag === 'img') textParts.push('[图片]');
          else if (element.tag === 'media') textParts.push('[视频]');
          else if (element.tag === 'emotion') {
            const emojiType = (element.emoji_type as string) ?? '';
            textParts.push(emojiType ? `[${emojiType}]` : '[表情]');
          }
          else if (element.tag === 'code_block') {
            const lang = (element.language as string) ?? '';
            const code = (element.text as string) ?? '';
            textParts.push(lang ? `\`\`\`${lang}\n${code}\`\`\`` : `\`\`\`\n${code}\`\`\``);
          }
          else if (element.tag === 'md') textParts.push((element.text as string) ?? '');
          else if (element.tag === 'hr') textParts.push('---');
        }
      }
      return textParts.join(' ').trim();
    }

    if (msgType === 'image') return '[图片]';
    if (msgType === 'file') return `[文件: ${body.file_name ?? ''}]`;
    if (msgType === 'audio') return '[语音消息]';
    if (msgType === 'video') return '[视频]';
    if (msgType === 'media') return '[视频]';
    if (msgType === 'sticker') return '[表情]';
    if (msgType === 'interactive') return '[卡片消息]';
    if (msgType === 'share_chat') return '[群名片]';
    if (msgType === 'share_user') return '[个人名片]';
    if (msgType === 'merge_forward') return '[嵌套的合并转发消息]';
    if (msgType === 'system') return '[系统消息]';

    return `[${msgType}消息]`;
  } catch {
    return `[${msgType}消息 - 解析失败]`;
  }
}
