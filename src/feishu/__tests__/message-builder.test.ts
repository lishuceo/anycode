import { describe, it, expect } from 'vitest';
import { buildProgressCard, buildResultCard, buildStatusCard } from '../message-builder.js';

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
