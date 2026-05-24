// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';

import {
  extractCardText,
  extractPostText,
  extractTextMessage,
  extractMessageText,
} from '../message-text.js';
import {
  buildPipelineCard,
  buildStreamingCard,
  buildProgressCard,
  buildStatusCard,
  buildCancelledCard,
  buildCombinedProgressCard,
  buildAskUserQuestionCard,
  buildAskUserAnsweredCard,
  buildApprovalCard,
  buildApprovalResultCard,
  buildOverviewCard,
  buildTextContentCard,
} from '../message-builder.js';

describe('extractCardText', () => {
  it('extracts text from buildTextContentCard (代替已删除的 buildResultCard)', () => {
    const card = buildTextContentCard(
      '## 方案要点\n\n核心难点在于同时继承对话历史和工作区状态',
      3,
      true,
    );
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('方案要点');
    expect(text).toContain('核心难点');
    expect(text).toContain('Agent 输出');
  });

  it('extracts text from buildPipelineCard including button labels', () => {
    const card = buildPipelineCard('做个功能', 'plan', 1, 6, 30, 0.12, 'detail line', 'pid-1');
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('做个功能');
    expect(text).toContain('detail line');
    expect(text).toContain('中止');
  });

  it('extracts text from buildStreamingCard', () => {
    const card = buildStreamingCard('指令A', '正在做事', 5);
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('指令A');
    expect(text).toContain('正在做事');
  });

  it('extracts text from buildProgressCard', () => {
    const card = buildProgressCard('指令B', '加载中...');
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('指令B');
    expect(text).toContain('加载中');
  });

  it('returns empty string for invalid JSON', () => {
    expect(extractCardText('not json')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractCardText('')).toBe('');
  });

  it('returns empty string for card with no text-bearing elements', () => {
    const card = { elements: [{ tag: 'hr' }, { tag: 'img', image_key: 'x' }] };
    expect(extractCardText(JSON.stringify(card))).toBe('');
  });

  it('recursively extracts from collapsible_panel.elements', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: 'top title' } },
      elements: [
        {
          tag: 'collapsible_panel',
          header: { title: { tag: 'plain_text', content: 'inner panel title' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'inner content' } }],
        },
      ],
    };
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('top title');
    expect(text).toContain('inner panel title');
    expect(text).toContain('inner content');
  });

  // -- Production card smoke test --
  // 锁住"所有生产 card builder 都能被 extractCardText 解析"的契约。
  // 如果未来新增 card 类型或改了内部 tag 结构,这里会先报警。
  describe('smoke: all production card builders', () => {
    const PROMPT = '帮我设计 Session Fork 方案';
    const RESULT_TEXT = '## 方案要点\n核心难点在于同时继承对话历史和工作区状态';

    const builders: Array<[string, () => Record<string, unknown>, string[]]> = [
      ['buildProgressCard', () => buildProgressCard(PROMPT, '加载中...'), [PROMPT]],
      ['buildOverviewCard(processing)', () => buildOverviewCard(PROMPT, 'processing', 1, 5, 0.01), [PROMPT, '处理中']],
      ['buildOverviewCard(success)', () => buildOverviewCard(PROMPT, 'success', 3, 39, 0.12), [PROMPT, '完成']],
      ['buildOverviewCard(error)', () => buildOverviewCard(PROMPT, 'error', 2, 5), [PROMPT, '失败']],
      ['buildTextContentCard', () => buildTextContentCard(RESULT_TEXT, 3, true), ['核心难点']],
      ['buildStreamingCard', () => buildStreamingCard(PROMPT, '正在做事', 3), [PROMPT, '正在做事']],
      ['buildPipelineCard', () => buildPipelineCard(PROMPT, 'plan', 1, 6, 30, 0.12, '细节', 'pid'), [PROMPT, '细节']],
      ['buildStatusCard', () => buildStatusCard('/root/dev/foo', 'idle', 3), ['/root/dev/foo', 'idle']],
      ['buildCancelledCard', () => buildCancelledCard(PROMPT), [PROMPT]],
      ['buildCombinedProgressCard', () => buildCombinedProgressCard(RESULT_TEXT, [], 2, false), ['核心难点']],
      ['buildAskUserQuestionCard', () => buildAskUserQuestionCard('qid', [
        { question: '选哪个?', options: [{ label: 'A方案', description: '描述A' }, { label: 'B方案', description: '描述B' }] },
      ]), ['选哪个', 'A方案', 'B方案']],
      ['buildAskUserAnsweredCard', () => buildAskUserAnsweredCard([
        { question: '选哪个?', options: [{ label: 'A方案' }, { label: 'B方案' }] },
      ], { '选哪个?': 'A方案' }), ['选哪个', 'A方案']],
      ['buildApprovalCard', () => buildApprovalCard('aid', '张三', '我想试一试', 'group'), ['张三', '我想试一试']],
      ['buildApprovalResultCard(approved)', () => buildApprovalResultCard('张三', true), ['张三']],
      ['buildApprovalResultCard(rejected)', () => buildApprovalResultCard('张三', false), ['张三']],
    ];

    for (const [name, build, mustContain] of builders) {
      it(`${name}: extracted text contains key content`, () => {
        const card = build();
        const text = extractCardText(JSON.stringify(card));
        expect(text.length).toBeGreaterThan(0);
        for (const needle of mustContain) {
          expect(text, `${name} missing "${needle}"; got: ${text.slice(0, 200)}`).toContain(needle);
        }
      });
    }
  });

  it('extracts text from div.fields[].text.content', () => {
    const card = {
      elements: [
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: '**仓库:** anycode' } },
            { is_short: true, text: { tag: 'lark_md', content: '**分支:** main' } },
          ],
        },
      ],
    };
    const text = extractCardText(JSON.stringify(card));
    expect(text).toContain('anycode');
    expect(text).toContain('main');
  });
});

describe('extractPostText', () => {
  it('parses direct post body', () => {
    const content = JSON.stringify({
      title: '公告',
      content: [[{ tag: 'text', text: '第一段' }]],
    });
    expect(extractPostText(content).text).toBe('公告 第一段');
  });

  it('parses locale-wrapped body', () => {
    const content = JSON.stringify({
      zh_cn: { title: '标题', content: [[{ tag: 'text', text: '中文内容' }]] },
    });
    expect(extractPostText(content).text).toBe('标题 中文内容');
  });

  it('collects image refs from img tags', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'img', image_key: 'img_xxx' }]],
    });
    const result = extractPostText(content);
    expect(result.imageRefs).toEqual([{ imageKey: 'img_xxx' }]);
  });

  it('respects separator option (empty string for event-handler)', () => {
    const content = JSON.stringify({
      title: '标题',
      content: [[{ tag: 'text', text: 'a' }, { tag: 'text', text: 'b' }]],
    });
    expect(extractPostText(content, undefined, { separator: '' }).text).toBe('标题ab');
    expect(extractPostText(content, undefined, { separator: ' ' }).text).toBe('标题 a b');
  });

  it('skips @bot mentions when isBot returns true', () => {
    const content = JSON.stringify({
      content: [[
        { tag: 'text', text: '你好 ' },
        { tag: 'at', user_id: 'ou_bot', user_name: 'DevBot' },
        { tag: 'text', text: ' 帮我' },
      ]],
    });
    const result = extractPostText(content, undefined, {
      separator: '',
      isBot: (id) => id === 'ou_bot',
    });
    expect(result.text).toBe('你好  帮我');
  });

  it('keeps human @mentions when isBot returns false', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'at', user_id: 'ou_human', user_name: '张三' }]],
    });
    const result = extractPostText(content, undefined, { isBot: () => false });
    expect(result.text).toBe('@张三');
  });

  it('returns empty for invalid JSON', () => {
    expect(extractPostText('not json').text).toBe('');
  });
});

describe('extractTextMessage', () => {
  it('extracts plain text', () => {
    expect(extractTextMessage(JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('resolves @mention placeholders', () => {
    const content = JSON.stringify({ text: '@_user_1 你好' });
    const mentions = [{ key: '@_user_1', name: '张三' }];
    expect(extractTextMessage(content, mentions)).toBe('@张三 你好');
  });

  it('strips HTML tags from quoted reply text', () => {
    expect(extractTextMessage(JSON.stringify({ text: '<p>hello</p>' }))).toBe('hello');
  });

  it('returns empty for empty content', () => {
    expect(extractTextMessage('')).toBe('');
  });

  it('returns empty for invalid JSON (caller decides how to handle)', () => {
    expect(extractTextMessage('not json')).toBe('');
  });
});

describe('extractMessageText', () => {
  it('handles text msgType', () => {
    const result = extractMessageText('text', JSON.stringify({ text: 'hi' }));
    expect(result).toEqual({ text: 'hi', imageRefs: [], fileRefs: [] });
  });

  it('handles post msgType with image refs', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'text', text: 'a' }, { tag: 'img', image_key: 'img_1' }]],
    });
    const result = extractMessageText('post', content);
    expect(result.text).toContain('a');
    expect(result.text).toContain('[图片]');
    expect(result.imageRefs).toEqual([{ imageKey: 'img_1' }]);
  });

  it('handles image msgType', () => {
    const result = extractMessageText('image', JSON.stringify({ image_key: 'img_x' }));
    expect(result.text).toBe('[图片]');
    expect(result.imageRefs).toEqual([{ imageKey: 'img_x' }]);
  });

  it('handles file msgType', () => {
    const result = extractMessageText(
      'file',
      JSON.stringify({ file_name: 'report.pdf', file_key: 'file_k' }),
    );
    expect(result.text).toBe('[文件: report.pdf]');
    expect(result.fileRefs).toEqual([{ fileKey: 'file_k', fileName: 'report.pdf' }]);
  });

  it('handles file msgType without file_key (no refs)', () => {
    const result = extractMessageText('file', JSON.stringify({ file_name: 'x.txt' }));
    expect(result.fileRefs).toEqual([]);
  });

  it('handles file msgType without file_name (displays 未知文件 consistently)', () => {
    const result = extractMessageText(
      'file',
      JSON.stringify({ file_key: 'file_x' }),
    );
    expect(result.text).toBe('[文件: 未知文件]');
    expect(result.fileRefs).toEqual([{ fileKey: 'file_x', fileName: '未知文件' }]);
  });

  it('respects collectRefs: false', () => {
    const result = extractMessageText('image', JSON.stringify({ image_key: 'k' }), undefined, {
      collectRefs: false,
    });
    expect(result.imageRefs).toEqual([]);
  });

  // -- 失忆事件的核心回归测试 --
  it('REGRESSION: interactive msgType extracts card text instead of "[卡片消息]" placeholder', () => {
    const card = buildTextContentCard(
      '## 设计要点\n\n这是关键内容,以前会被洗成 [卡片消息]',
      3,
      true,
    );
    const result = extractMessageText('interactive', JSON.stringify(card));
    expect(result.text).not.toBe('[卡片消息]');
    expect(result.text).toContain('设计要点');
    expect(result.text).toContain('关键内容');
  });

  it('falls back to "[卡片消息]" when interactive card is empty/unparseable', () => {
    expect(extractMessageText('interactive', '{}').text).toBe('[卡片消息]');
    expect(extractMessageText('interactive', 'not json').text).toBe('[卡片消息]');
  });

  it('returns placeholders for unparseable media types', () => {
    expect(extractMessageText('audio', '{}').text).toBe('[语音消息]');
    expect(extractMessageText('video', '{}').text).toBe('[视频]');
    expect(extractMessageText('media', '{}').text).toBe('[视频]');
    expect(extractMessageText('sticker', '{}').text).toBe('[表情]');
    expect(extractMessageText('share_chat', '{}').text).toBe('[群名片]');
    expect(extractMessageText('share_user', '{}').text).toBe('[个人名片]');
    expect(extractMessageText('merge_forward', '{}').text).toBe('[嵌套的合并转发消息]');
    expect(extractMessageText('system', '{}').text).toBe('[系统消息]');
  });

  it('returns generic placeholder for unknown msgType', () => {
    expect(extractMessageText('share_calendar_event', '{}').text).toBe(
      '[share_calendar_event消息]',
    );
  });
});
