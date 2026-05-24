/**
 * 解析飞书 interactive 卡片 JSON,提取可读文本(标题 + 各 element 的文本内容)。
 * 支持已知 element tag(div/markdown/note/column_set/action/img/hr)并对未知结构做递归 content 提取兜底。
 */
export function formatInteractiveCard(contentJson: string): string {
  try {
    const card = JSON.parse(contentJson || '{}') as Record<string, unknown>;
    const parts: string[] = [];

    // header.title 可能是 { content } 或 { text: { content } }
    const header = card.header as Record<string, unknown> | undefined;
    const title = header?.title as Record<string, unknown> | undefined;
    if (title) {
      const titleText =
        (title.content as string) ??
        ((title.text as Record<string, unknown> | undefined)?.content as string) ??
        '';
      if (titleText.trim()) parts.push(titleText.trim());
    }

    // 卡片 elements 可能在顶层 elements 或 v2 形式的 body.elements
    const body = card.body as Record<string, unknown> | undefined;
    const topElements = (card.elements ?? body?.elements) as unknown[] | undefined;
    if (Array.isArray(topElements)) {
      walkCardElements(topElements, parts);
    }

    const joined = parts.filter(s => s && s.trim()).join('\n').trim();
    return joined || '[卡片消息]';
  } catch {
    return '[卡片消息 - 解析失败]';
  }
}

function walkCardElements(elements: unknown[], parts: string[]): void {
  for (const raw of elements) {
    if (!raw || typeof raw !== 'object') continue;
    const el = raw as Record<string, unknown>;
    const tag = el.tag as string | undefined;

    switch (tag) {
      case 'div': {
        const text = el.text as Record<string, unknown> | undefined;
        const t = text?.content as string | undefined;
        if (t) parts.push(t);
        const fields = el.fields as unknown[] | undefined;
        if (Array.isArray(fields)) {
          for (const f of fields) {
            const fc = (f as Record<string, unknown>)?.text as Record<string, unknown> | undefined;
            const ft = fc?.content as string | undefined;
            if (ft) parts.push(ft);
          }
        }
        break;
      }
      case 'markdown':
      case 'plain_text':
      case 'lark_md': {
        const t = el.content as string | undefined;
        if (t) parts.push(t);
        break;
      }
      case 'note': {
        const sub = el.elements as unknown[] | undefined;
        if (Array.isArray(sub)) walkCardElements(sub, parts);
        break;
      }
      case 'column_set': {
        const cols = el.columns as unknown[] | undefined;
        if (Array.isArray(cols)) {
          for (const col of cols) {
            const sub = (col as Record<string, unknown>)?.elements as unknown[] | undefined;
            if (Array.isArray(sub)) walkCardElements(sub, parts);
          }
        }
        break;
      }
      case 'action': {
        const actions = el.actions as unknown[] | undefined;
        if (Array.isArray(actions)) {
          for (const a of actions) {
            const text = (a as Record<string, unknown>)?.text as Record<string, unknown> | undefined;
            const t = text?.content as string | undefined;
            if (t) parts.push(`[按钮: ${t}]`);
          }
        }
        break;
      }
      case 'img':
        parts.push('[图片]');
        break;
      case 'hr':
        break;
      default: {
        // 未知 tag:递归挖出所有 content 字符串(兜底,处理 share-card 等第三方卡片格式)
        extractContentStrings(el, parts);
      }
    }
  }
}

function extractContentStrings(obj: unknown, parts: string[], depth = 0): void {
  if (depth > 6 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractContentStrings(item, parts, depth + 1);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if ((k === 'content' || k === 'text') && typeof v === 'string' && v.trim()) {
      parts.push(v.trim());
    } else if (v && typeof v === 'object') {
      extractContentStrings(v, parts, depth + 1);
    }
  }
}

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
    if (msgType === 'interactive') return formatInteractiveCard(contentJson);
    if (msgType === 'share_chat') return '[群名片]';
    if (msgType === 'share_user') return '[个人名片]';
    if (msgType === 'merge_forward') return '[嵌套的合并转发消息]';
    if (msgType === 'system') return '[系统消息]';

    return `[${msgType}消息]`;
  } catch {
    return `[${msgType}消息 - 解析失败]`;
  }
}
