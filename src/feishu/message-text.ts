/**
 * 统一的"飞书消息 body -> 可读文本"解析
 *
 * 之前 client.fetchRecentMessages / message-parser.formatMergeForwardSubMessage /
 * event-handler.parseMessage 三处各自维护一份 msgType 分支,导致 interactive 卡片
 * 在 merge_forward 路径被洗成 "[卡片消息]",bot 看不到自己之前在卡片里写的内容。
 *
 * 本模块统一所有 msgType 的解析,interactive 卡片走结构化提取,保留 bot 的回复内容。
 */

export interface Mention {
  key?: string;
  name?: string;
  id?: string;
  id_type?: string;
}

export interface ExtractedRefs {
  imageRefs: Array<{ imageKey: string }>;
  fileRefs: Array<{ fileKey: string; fileName: string }>;
}

export interface ExtractedMessage extends ExtractedRefs {
  text: string;
}

export interface PostExtractOptions {
  /** post.content 段间 / 元素间的拼接分隔符。默认 ' '(与 client/merge-forward 一致),
   *  event-handler 实时事件解析传 '' 保持向后兼容。 */
  separator?: string;
  /** 判断某个 open_id 是否为 bot,bot @ 提及不输出 @名字。仅 event-handler 路径用到。 */
  isBot?: (openId: string) => boolean;
  /** 是否在 text 中插入 "[图片]" 占位符。event-handler 内联下载图片为多模态块,
   *  不需要文本占位符;设为 false 时只收集 imageRefs。默认 true。 */
  includeImagePlaceholder?: boolean;
}

export interface MessageExtractOptions extends PostExtractOptions {
  /** 是否收集 image_key/file_key 引用。默认 true。 */
  collectRefs?: boolean;
}

/**
 * 提取 interactive 卡片中所有可见文本。
 *
 * 飞书卡片是嵌套结构,本函数递归遍历所有承载文本的字段：
 * - { tag: 'plain_text' | 'lark_md' | 'markdown', content: '...' }
 * - 容器字段 text / title / header / elements / actions / fields / columns
 *
 * 跳过 hr / img 等纯装饰节点。
 */
export function extractCardText(cardJson: string): string {
  if (!cardJson) return '';
  let card: unknown;
  try {
    card = JSON.parse(cardJson);
  } catch {
    return '';
  }
  const parts: string[] = [];
  walkCardNode(card, parts);
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

const KNOWN_TAGS = new Set([
  'plain_text', 'lark_md', 'markdown', 'div', 'note', 'column_set', 'column',
  'action', 'button', 'hr', 'img', 'select_static', 'date_picker', 'overflow',
]);

// 容器字段已由上方显式分支递归过,unknown-tag 兜底时跳过,避免双重提取
const CONTAINER_KEYS = new Set([
  'text', 'title', 'header', 'body', 'elements', 'actions', 'fields', 'columns',
]);

function walkCardNode(node: unknown, parts: string[], depth = 0): void {
  if (depth > 8 || !node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walkCardNode(item, parts, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;

  if (obj.tag === 'hr' || obj.tag === 'img') return;

  // 文本叶子：{ content: '...' },tag 为文本类型或未设置(v1 嵌套 title.text 形式)
  if (
    typeof obj.content === 'string' &&
    (!obj.tag ||
      obj.tag === 'plain_text' ||
      obj.tag === 'lark_md' ||
      obj.tag === 'markdown')
  ) {
    if (obj.content) parts.push(obj.content);
    return;
  }

  // 容器字段：递归(含 v2 卡片的 body.elements)
  if (obj.text) walkCardNode(obj.text, parts, depth + 1);
  if (obj.title) walkCardNode(obj.title, parts, depth + 1);
  if (obj.header) walkCardNode(obj.header, parts, depth + 1);
  if (obj.body) walkCardNode(obj.body, parts, depth + 1);
  if (obj.elements) walkCardNode(obj.elements, parts, depth + 1);
  if (obj.actions) walkCardNode(obj.actions, parts, depth + 1);
  if (obj.fields) walkCardNode(obj.fields, parts, depth + 1);
  if (obj.columns) walkCardNode(obj.columns, parts, depth + 1);

  // 未知 tag 兜底：处理第三方 share-card 等非标准卡片格式
  // - 直接拾取 content/text 字符串字段(上方 container 分支只递归 object,不处理 string)
  // - 递归非 CONTAINER_KEYS 的 object 子字段(CONTAINER_KEYS 已被上方分支处理,避免双重提取)
  if (typeof obj.tag === 'string' && !KNOWN_TAGS.has(obj.tag)) {
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'content' || k === 'text') && typeof v === 'string' && v.trim()) {
        parts.push(v.trim());
      } else if (v && typeof v === 'object' && !CONTAINER_KEYS.has(k)) {
        walkCardNode(v, parts, depth + 1);
      }
    }
  }
}

/**
 * 解析 post 富文本消息为文本字符串。
 * 支持两种 body 结构：
 *   1. 直接: { title, content: [[elements]] }
 *   2. 带语言键: { zh_cn: { title, content: [[elements]] }, en_us: {...} }
 */
export function extractPostText(
  postBodyJson: string,
  mentions?: Mention[],
  opts: PostExtractOptions = {},
): { text: string; imageRefs: Array<{ imageKey: string }> } {
  void mentions; // 当前未使用(post.at 已带 user_name),保留参数以便未来扩展
  const separator = opts.separator ?? ' ';
  const imageRefs: Array<{ imageKey: string }> = [];

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(postBodyJson || '{}');
  } catch {
    return { text: '', imageRefs };
  }

  const postBody = Array.isArray((body as Record<string, unknown>).content)
    ? body
    : ((body.zh_cn || body.en_us || body.ja_jp || Object.values(body)[0]) as
        | Record<string, unknown>
        | undefined);

  const title = (postBody?.title as string) ?? '';
  const textParts: string[] = title ? [title] : [];

  const paragraphs = (postBody?.content as Array<Array<Record<string, unknown>>>) ?? [];
  for (const paragraph of paragraphs) {
    for (const element of paragraph ?? []) {
      if (element.tag === 'text') {
        textParts.push((element.text as string) ?? '');
      } else if (element.tag === 'a') {
        const linkText = (element.text as string) ?? '';
        const href = (element.href as string) ?? '';
        textParts.push(linkText && href ? `[${linkText}](${href})` : href || linkText);
      } else if (element.tag === 'at') {
        const atName = (element.user_name as string) ?? '';
        const atUserId = (element.user_id as string) ?? '';
        const skipBot = atUserId && opts.isBot?.(atUserId);
        if (atName && !skipBot) {
          textParts.push(`@${atName}`);
        }
      } else if (element.tag === 'img') {
        const imgKey = element.image_key as string | undefined;
        if (imgKey) imageRefs.push({ imageKey: imgKey });
        if (opts.includeImagePlaceholder !== false) textParts.push('[图片]');
      } else if (element.tag === 'media') {
        textParts.push('[视频]');
      } else if (element.tag === 'emotion') {
        const emojiType = (element.emoji_type as string) ?? '';
        textParts.push(emojiType ? `[${emojiType}]` : '[表情]');
      } else if (element.tag === 'code_block') {
        const lang = (element.language as string) ?? '';
        const code = (element.text as string) ?? '';
        textParts.push(lang ? `\`\`\`${lang}\n${code}\`\`\`` : `\`\`\`\n${code}\`\`\``);
      } else if (element.tag === 'md') {
        textParts.push((element.text as string) ?? '');
      } else if (element.tag === 'hr') {
        textParts.push('---');
      }
    }
  }

  return { text: textParts.join(separator), imageRefs };
}

/**
 * 解析 text 消息,处理 @mention 占位符 + HTML 标签清洗。
 */
export function extractTextMessage(textBodyJson: string, mentions?: Mention[]): string {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(textBodyJson || '{}');
  } catch {
    return '';
  }
  let text = (body.text as string) ?? '';
  if (text && Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m.key) text = text.replaceAll(m.key, m.name ? `@${m.name}` : '');
    }
  }
  // 飞书引用回复时 text 可能被 <p> 等 HTML 标签包裹
  if (text.includes('<')) {
    text = text.replace(/<[^>]+>/g, '').trim();
  }
  return text.trim();
}

/**
 * 统一入口：解析任意 msgType 的 message body,返回文本 + 引用(image/file)。
 *
 * 对于 interactive 卡片,提取所有可见文本字段,确保 bot 的卡片回复在历史回路中
 * 不会被洗成 "[卡片消息]"。
 *
 * merge_forward 不在这里处理（需要 API call 展开子消息),由调用方单独实现。
 */
export function extractMessageText(
  msgType: string,
  contentJson: string,
  mentions?: Mention[],
  opts: MessageExtractOptions = {},
): ExtractedMessage {
  const collectRefs = opts.collectRefs ?? true;
  const empty: ExtractedRefs = { imageRefs: [], fileRefs: [] };

  if (msgType === 'text') {
    return { text: extractTextMessage(contentJson, mentions), ...empty };
  }

  if (msgType === 'post') {
    const { text, imageRefs } = extractPostText(contentJson, mentions, opts);
    return { text, imageRefs: collectRefs ? imageRefs : [], fileRefs: [] };
  }

  if (msgType === 'image') {
    const imageRefs: Array<{ imageKey: string }> = [];
    if (collectRefs) {
      try {
        const body = JSON.parse(contentJson || '{}');
        const imageKey = body.image_key as string | undefined;
        if (imageKey) imageRefs.push({ imageKey });
      } catch {
        /* ignore */
      }
    }
    return { text: '[图片]', imageRefs, fileRefs: [] };
  }

  if (msgType === 'file') {
    let fileName = '';
    let fileKey: string | undefined;
    try {
      const body = JSON.parse(contentJson || '{}');
      fileName = (body.file_name as string) ?? '';
      fileKey = body.file_key as string | undefined;
    } catch {
      /* ignore */
    }
    const displayName = fileName || '未知文件';
    const fileRefs = collectRefs && fileKey ? [{ fileKey, fileName: displayName }] : [];
    return { text: `[文件: ${displayName}]`, imageRefs: [], fileRefs };
  }

  if (msgType === 'interactive') {
    const cardText = extractCardText(contentJson);
    return { text: cardText || '[卡片消息]', ...empty };
  }

  if (msgType === 'audio') return { text: '[语音消息]', ...empty };
  if (msgType === 'video' || msgType === 'media') return { text: '[视频]', ...empty };
  if (msgType === 'sticker') return { text: '[表情]', ...empty };
  if (msgType === 'share_chat') return { text: '[群名片]', ...empty };
  if (msgType === 'share_user') return { text: '[个人名片]', ...empty };
  if (msgType === 'merge_forward') return { text: '[嵌套的合并转发消息]', ...empty };
  if (msgType === 'system') return { text: '[系统消息]', ...empty };

  return { text: `[${msgType}消息]`, ...empty };
}
