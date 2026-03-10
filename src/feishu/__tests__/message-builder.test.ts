import { describe, it, expect } from 'vitest';
import { buildProgressCard, buildResultCard, buildStreamingCard, buildPipelineCard, buildStatusCard, buildTurnCard, buildToolProgressCard, buildTextContentCard, buildOverviewCard, buildSimpleResultCard } from '../message-builder.js';
import type { TurnInfo, ToolCallInfo, ActivityStatus } from '../../claude/types.js';

describe('buildProgressCard', () => {
  it('should build a card with the given prompt', () => {
    const card = buildProgressCard('list files') as any;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toBe('🤖 Coding Agent');
    const promptEl = card.elements[0];
    expect(promptEl.text.content).toContain('list files');
  });

  it('should use default status text', () => {
    const card = buildProgressCard('test') as any;
    const statusEl = card.elements[2];
    expect(statusEl.text.content).toContain('正在处理...');
  });

  it('should use custom status text', () => {
    const card = buildProgressCard('test', '排队中...') as any;
    const statusEl = card.elements[2];
    expect(statusEl.text.content).toContain('排队中...');
  });

  it('should truncate long prompts to 200 chars', () => {
    const longPrompt = 'a'.repeat(300);
    const card = buildProgressCard(longPrompt) as any;
    const content = card.elements[0].text.content;
    // Truncated to 200 + '...'
    expect(content).toContain('...');
    expect(content.length).toBeLessThan(300 + 50); // prompt + prefix overhead
  });

  it('should escape markdown special chars in prompt', () => {
    const card = buildProgressCard('use *bold* and _italic_') as any;
    const content = card.elements[0].text.content;
    expect(content).toContain('\\*bold\\*');
    expect(content).toContain('\\_italic\\_');
  });
});

describe('buildResultCard', () => {
  it('should build a success card', () => {
    const card = buildResultCard('test', 'done', true, '3.2s') as any;
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('执行完成');
    const note = card.elements[4];
    expect(note.elements[0].content).toContain('✅');
    expect(note.elements[0].content).toContain('3.2s');
  });

  it('should build a failure card', () => {
    const card = buildResultCard('test', 'error', false, '1.0s') as any;
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('执行失败');
    const note = card.elements[4];
    expect(note.elements[0].content).toContain('❌');
  });

  it('should build a timeout card', () => {
    const card = buildResultCard('test', 'timeout', false, '300s', true) as any;
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toContain('执行超时');
    const note = card.elements[4];
    expect(note.elements[0].content).toContain('⏱️');
  });

  it('should show empty output placeholder', () => {
    const card = buildResultCard('test', '', true, '0.1s') as any;
    const outputEl = card.elements[2];
    expect(outputEl.text.content).toContain('_(无输出)_');
  });

  it('should truncate very long output', () => {
    const longOutput = 'x'.repeat(5000);
    const card = buildResultCard('test', longOutput, true, '1s') as any;
    const outputEl = card.elements[2];
    expect(outputEl.text.content).toContain('_(输出过长，已截断)_');
    expect(outputEl.text.content.length).toBeLessThan(5000);
  });
});

describe('buildStreamingCard', () => {
  it('should display prompt, content, and elapsed time', () => {
    const card = buildStreamingCard('do something', 'partial output here', 15) as any;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('执行中');
    expect(card.elements[0].text.content).toContain('do something');
    expect(card.elements[2].text.content).toContain('partial output here');
    const note = card.elements[4];
    expect(note.elements[0].content).toContain('15s');
  });

  it('should show last 2500 chars of long content', () => {
    const longContent = 'A'.repeat(1000) + 'B'.repeat(2500);
    const card = buildStreamingCard('test', longContent, 5) as any;
    const displayed = card.elements[2].text.content;
    expect(displayed).toContain('...');
    expect(displayed).not.toContain('A');
    expect(displayed).toContain('B');
  });

  it('should show placeholder when content is empty', () => {
    const card = buildStreamingCard('test', '', 0) as any;
    expect(card.elements[2].text.content).toContain('正在处理...');
  });
});

describe('buildPipelineCard', () => {
  it('should show in-progress phase with correct marker', () => {
    const card = buildPipelineCard('task', 'implement', 3, 5, 30) as any;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('自动开发管道');
    const phasesContent = card.elements[2].text.content as string;
    expect(phasesContent).toContain('✅ 1. 方案设计');
    expect(phasesContent).toContain('✅ 2. 方案审查');
    expect(phasesContent).toContain('🔄 3. 代码实现 ← 当前');
    expect(phasesContent).toContain('⬚ 4. 代码审查');
    expect(phasesContent).toContain('⬚ 5. 推送 & PR');
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).toContain('阶段 3/5');
    expect(note.elements[0].content).toContain('30s');
  });

  it('should show all checkmarks when done', () => {
    const card = buildPipelineCard('task', 'done', 6, 5, 120, 0.72) as any;
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('管道完成');
    const phasesContent = card.elements[2].text.content as string;
    expect(phasesContent).toContain('✅ 1.');
    expect(phasesContent).toContain('✅ 5.');
    expect(phasesContent).not.toContain('⬚');
    expect(phasesContent).not.toContain('🔄');
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).toContain('✅ 完成');
    expect(note.elements[0].content).toContain('$0.7200');
  });

  it('should show failure state correctly', () => {
    const card = buildPipelineCard('task', 'failed', 3, 5, 60) as any;
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('管道失败');
    const phasesContent = card.elements[2].text.content as string;
    expect(phasesContent).toContain('✅ 1.');
    expect(phasesContent).toContain('✅ 2.');
    expect(phasesContent).toContain('❌ 3.');
    expect(phasesContent).toContain('⬚ 4.');
  });

  it('should include detail section when provided', () => {
    const card = buildPipelineCard('task', 'implement', 3, 5, 10, undefined, 'some detail') as any;
    // detail should appear between phases and note
    const allTexts = card.elements.map((e: any) => e.text?.content ?? '').join(' ');
    expect(allTexts).toContain('some detail');
  });

  it('should truncate long detail to 2000 chars', () => {
    const longDetail = 'X'.repeat(3000);
    const card = buildPipelineCard('task', 'plan', 1, 5, 5, undefined, longDetail) as any;
    const allTexts = card.elements.map((e: any) => e.text?.content ?? '').join(' ');
    expect(allTexts).toContain('...');
    expect(allTexts.length).toBeLessThan(3000 + 500);
  });

  it('should show thinking activity status in footer', () => {
    const activity: ActivityStatus = { state: 'thinking', toolCallCount: 3 };
    const card = buildPipelineCard('task', 'implement', 3, 5, 30, undefined, undefined, 'pipe1', activity) as any;
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).toContain('🧠 思考中');
    expect(note.elements[0].content).toContain('阶段 3/5');
  });

  it('should show tool_call activity status with count in footer', () => {
    const activity: ActivityStatus = { state: 'tool_call', toolCallCount: 12 };
    const card = buildPipelineCard('task', 'plan', 1, 5, 45, undefined, undefined, 'pipe1', activity) as any;
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).toContain('🔧 工具调用: 12');
    expect(note.elements[0].content).toContain('阶段 1/5');
  });

  it('should not show activity status when done', () => {
    const activity: ActivityStatus = { state: 'tool_call', toolCallCount: 50 };
    const card = buildPipelineCard('task', 'done', 6, 5, 120, 0.72, undefined, 'pipe1', activity) as any;
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).not.toContain('🔧');
    expect(note.elements[0].content).not.toContain('🧠');
    expect(note.elements[0].content).toContain('✅ 完成');
  });

  it('should not show activity status when failed', () => {
    const activity: ActivityStatus = { state: 'thinking', toolCallCount: 5 };
    const card = buildPipelineCard('task', 'failed', 3, 5, 60, undefined, undefined, 'pipe1', activity) as any;
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).not.toContain('🧠');
    expect(note.elements[0].content).toContain('❌ 失败');
  });

  it('should not show activity status when undefined', () => {
    const card = buildPipelineCard('task', 'implement', 3, 5, 30) as any;
    const note = card.elements[card.elements.length - 1];
    expect(note.elements[0].content).not.toContain('🧠');
    expect(note.elements[0].content).not.toContain('🔧');
    expect(note.elements[0].content).toContain('阶段 3/5');
  });
});

describe('buildStatusCard', () => {
  it('should display working dir, status, and pending tasks', () => {
    const card = buildStatusCard('/home/user/project', 'idle', 3) as any;
    expect(card.header.template).toBe('indigo');
    const fields = card.elements[0].fields;
    expect(fields[0].text.content).toContain('/home/user/project');
    expect(fields[1].text.content).toContain('idle');
    expect(fields[2].text.content).toContain('3');
  });
});

describe('buildTurnCard', () => {
  it('should build a card with text content and tool calls', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: 'Let me read the file.',
      toolCalls: [{ name: 'Read', input: { file_path: '/src/index.ts' } }],
    };
    const card = buildTurnCard(turn) as any;
    expect(card.header.title.content).toBe('Turn 1');
    expect(card.header.template).toBe('default');
    const body = card.elements[0].text.content as string;
    expect(body).toContain('Let me read the file.');
    expect(body).toContain('📖');
    expect(body).toContain('/src/index.ts');
  });

  it('should show only tool calls when no text', () => {
    const turn: TurnInfo = {
      turnIndex: 3,
      textContent: '',
      toolCalls: [
        { name: 'Bash', input: { command: 'npm test' } },
        { name: 'Edit', input: { file_path: '/src/app.ts' } },
      ],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('💻');
    expect(body).toContain('npm test');
    expect(body).toContain('✏️');
    expect(body).toContain('/src/app.ts');
  });

  it('should show only text when no tool calls', () => {
    const turn: TurnInfo = {
      turnIndex: 2,
      textContent: 'Here is my analysis.',
      toolCalls: [],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('Here is my analysis.');
    expect(body).not.toContain('📖');
  });

  it('should truncate long text content at 3000 chars', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: 'X'.repeat(4000),
      toolCalls: [],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('_(内容过长，已截断)_');
    expect(body.length).toBeLessThan(4000);
  });

  it('should truncate long Bash commands at 80 chars', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'Bash', input: { command: 'a'.repeat(100) } }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('...');
    // 80 chars + "..." + backticks overhead
    expect(body.length).toBeLessThan(100 + 20);
  });

  it('should format Glob, Grep, Write, and setup_workspace tools', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [
        { name: 'Glob', input: { pattern: '**/*.ts' } },
        { name: 'Grep', input: { pattern: 'TODO' } },
        { name: 'Write', input: { file_path: '/tmp/out.txt' } },
        { name: 'setup_workspace', input: { repo_url: 'https://github.com/user/repo' } },
      ],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🔍 **Glob** **/*.ts');
    expect(body).toContain('🔍 **Grep** TODO');
    expect(body).toContain('📝 **Write** /tmp/out.txt');
    expect(body).toContain('📦 **setup_workspace** https://github.com/user/repo');
  });

  it('should use fallback icon for unknown tools', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'CustomTool', input: {} }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🔧 **CustomTool**');
  });

  it('should format WebSearch with query parameter', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'WebSearch', input: { query: 'TypeScript generics tutorial' } }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🌐 **WebSearch** `TypeScript generics tutorial`');
  });

  it('should format WebFetch with url parameter', () => {
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'WebFetch', input: { url: 'https://example.com/docs' } }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🌐 **WebFetch** https://example.com/docs');
  });

  it('should truncate long WebSearch query at 80 chars', () => {
    const longQuery = 'a'.repeat(100);
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'WebSearch', input: { query: longQuery } }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🌐 **WebSearch**');
    expect(body).toContain('...');
    // Should contain exactly 80 'a' chars before '...'
    expect(body).toContain('a'.repeat(80) + '...');
    expect(body).not.toContain('a'.repeat(81));
  });

  it('should truncate long WebFetch url at 80 chars', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(100);
    const turn: TurnInfo = {
      turnIndex: 1,
      textContent: '',
      toolCalls: [{ name: 'WebFetch', input: { url: longUrl } }],
    };
    const card = buildTurnCard(turn) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('🌐 **WebFetch**');
    expect(body).toContain('...');
    expect(body.length).toBeLessThan(longUrl.length + 30);
  });
});

describe('buildOverviewCard', () => {
  it('should show processing state', () => {
    const card = buildOverviewCard('analyze code', 'processing', 3, 25) as any;
    expect(card.header.template).toBe('blue');
    expect(card.elements[0].text.content).toContain('analyze code');
    const note = card.elements[2];
    expect(note.elements[0].content).toContain('处理中');
    expect(note.elements[0].content).toContain('3 轮');
    expect(note.elements[0].content).toContain('25s');
  });

  it('should show success state with cost', () => {
    const card = buildOverviewCard('fix bug', 'success', 5, 60, 0.0312) as any;
    expect(card.header.template).toBe('green');
    const note = card.elements[2];
    expect(note.elements[0].content).toContain('完成');
    expect(note.elements[0].content).toContain('5 轮');
    expect(note.elements[0].content).toContain('$0.0312');
  });

  it('should show error state', () => {
    const card = buildOverviewCard('test', 'error', 2, 10) as any;
    expect(card.header.template).toBe('red');
    const note = card.elements[2];
    expect(note.elements[0].content).toContain('失败');
  });

  it('should show 0 turns initially', () => {
    const card = buildOverviewCard('test', 'processing', 0, 0) as any;
    const note = card.elements[2];
    expect(note.elements[0].content).toContain('0 轮');
    expect(note.elements[0].content).toContain('0s');
  });
});

describe('buildSimpleResultCard', () => {
  it('should show minimal card when no lastTurn', () => {
    const card = buildSimpleResultCard('do something', true, '5s | 💰 $0.02') as any;
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('执行完成');
    // only note (no prompt, no content, no hr)
    expect(card.elements).toHaveLength(1);
    expect(card.elements[0].elements[0].content).toContain('✅');
    expect(card.elements[0].elements[0].content).toContain('5s');
  });

  it('should merge lastTurn content into the card', () => {
    const lastTurn: TurnInfo = {
      turnIndex: 1,
      textContent: 'Here is the answer.',
      toolCalls: [{ name: 'Read', input: { file_path: '/src/app.ts' } }],
    };
    const card = buildSimpleResultCard('question', true, '3s', undefined, lastTurn) as any;
    // content + hr + note = 3 elements
    expect(card.elements).toHaveLength(3);
    const allText = card.elements.map((e: any) => e.text?.content ?? '').join(' ');
    expect(allText).toContain('Here is the answer.');
    expect(allText).toContain('📖');
    expect(allText).toContain('/src/app.ts');
  });

  it('should show error message on failure', () => {
    const card = buildSimpleResultCard('test', false, '10s', 'something broke') as any;
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('执行失败');
    // error + hr + note = 3 elements
    expect(card.elements).toHaveLength(3);
    const allText = card.elements.map((e: any) => e.text?.content ?? '').join(' ');
    expect(allText).toContain('something broke');
  });

  it('should show both lastTurn and error on failure', () => {
    const lastTurn: TurnInfo = { turnIndex: 1, textContent: 'partial work', toolCalls: [] };
    const card = buildSimpleResultCard('test', false, '10s', 'something broke', lastTurn) as any;
    // content + hr + error + hr + note = 5 elements
    expect(card.elements).toHaveLength(5);
    const allText = card.elements.map((e: any) => e.text?.content ?? '').join(' ');
    expect(allText).toContain('partial work');
    expect(allText).toContain('something broke');
  });
});

describe('buildToolProgressCard', () => {
  it('should show tool calls with blue header when in progress', () => {
    const tools: ToolCallInfo[] = [
      { name: 'Read', input: { file_path: '/src/index.ts' } },
      { name: 'Bash', input: { command: 'npm test' } },
    ];
    const card = buildToolProgressCard(tools, 2) as any;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('执行中');
    const body = card.elements[0].text.content as string;
    expect(body).toContain('📖');
    expect(body).toContain('/src/index.ts');
    expect(body).toContain('💻');
    expect(body).toContain('npm test');
    const note = card.elements[2].elements[0].content as string;
    expect(note).toContain('⏳ 执行中');
    expect(note).toContain('2 轮');
  });

  it('should show indigo header when completed', () => {
    const tools: ToolCallInfo[] = [
      { name: 'Grep', input: { pattern: 'TODO' } },
    ];
    const card = buildToolProgressCard(tools, 3, undefined, true) as any;
    expect(card.header.template).toBe('indigo');
    expect(card.header.title.content).toContain('活动记录');
    const note = card.elements[2].elements[0].content as string;
    expect(note).not.toContain('⏳');
    expect(note).toContain('3 轮');
  });

  it('should truncate old entries when exceeding maxDisplayed', () => {
    const tools: ToolCallInfo[] = Array.from({ length: 10 }, (_, i) => ({
      name: 'Read',
      input: { file_path: `/src/file${i}.ts` },
    }));
    const card = buildToolProgressCard(tools, 5, 3) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('前 7 条已省略');
    expect(body).toContain('file7.ts');
    expect(body).toContain('file8.ts');
    expect(body).toContain('file9.ts');
    expect(body).not.toContain('file0.ts');
  });

  it('should show placeholder when no tool calls', () => {
    const card = buildToolProgressCard([], 1) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('_(无工具调用)_');
  });
});

describe('buildTextContentCard', () => {
  it('should show text with wathet header when in progress', () => {
    const card = buildTextContentCard('这是 agent 的输出', 3) as any;
    expect(card.header.template).toBe('wathet');
    expect(card.header.title.content).toContain('生成中');
    const body = card.elements[0].text.content as string;
    expect(body).toBe('这是 agent 的输出');
    const note = card.elements[2].elements[0].content as string;
    expect(note).toContain('⏳ 生成中');
    expect(note).toContain('3 轮');
  });

  it('should show turquoise header when completed', () => {
    const card = buildTextContentCard('最终结果', 5, true) as any;
    expect(card.header.template).toBe('turquoise');
    expect(card.header.title.content).toBe('💬 Agent 输出');
    expect(card.header.title.content).not.toContain('生成中');
    const note = card.elements[2].elements[0].content as string;
    expect(note).not.toContain('⏳');
    expect(note).toContain('5 轮');
  });

  it('should not truncate short text', () => {
    const shortText = '短文本内容';
    const card = buildTextContentCard(shortText, 1) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toBe(shortText);
    expect(body).not.toContain('已省略');
  });

  it('should truncate long text keeping tail and adding prefix', () => {
    const longText = '前'.repeat(5000) + '后'.repeat(5000);
    const card = buildTextContentCard(longText, 2) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('已省略');
    expect(body).toContain('后后后');
    const serialized = JSON.stringify(card);
    expect(Buffer.byteLength(serialized, 'utf-8')).toBeLessThan(30720);
  });

  it('should show placeholder for empty text', () => {
    const card = buildTextContentCard('', 1) as any;
    const body = card.elements[0].text.content as string;
    expect(body).toContain('暂无输出');
  });
});
