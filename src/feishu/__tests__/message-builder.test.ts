import { describe, it, expect } from 'vitest';
import { buildProgressCard, buildResultCard, buildStreamingCard, buildPipelineCard, buildStatusCard } from '../message-builder.js';

describe('buildProgressCard', () => {
  it('should build a card with the given prompt', () => {
    const card = buildProgressCard('list files') as any;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toBe('🤖 Claude Code');
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
