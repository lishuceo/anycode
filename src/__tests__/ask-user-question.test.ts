/**
 * AskUserQuestion Interactive Card Tests
 *
 * Tests for Feishu interactive card rendering and action handling
 * when Claude calls the AskUserQuestion tool.
 */
// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';
import {
  buildAskUserQuestionCard,
  buildAskUserAnsweredCard,
} from '../feishu/message-builder.js';
import type { AskUserQuestionItem } from '../feishu/message-builder.js';

// ============================================================
// 1. Card Building
// ============================================================

describe('buildAskUserQuestionCard', () => {
  const singleQuestion: AskUserQuestionItem[] = [
    {
      question: 'Which approach should we use?',
      header: 'Approach',
      options: [
        { label: 'Option A', description: 'Simple and fast' },
        { label: 'Option B', description: 'More complex but flexible' },
      ],
      multiSelect: false,
    },
  ];

  it('renders card with purple header', () => {
    const card = buildAskUserQuestionCard('q1', singleQuestion);
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '🤔 需要你的输入' },
      template: 'purple',
    });
  });

  it('renders question text with header', () => {
    const card = buildAskUserQuestionCard('q1', singleQuestion);
    const elements = card.elements as any[];
    // First element should be a div with the question text
    expect(elements[0].tag).toBe('div');
    expect(elements[0].text.content).toContain('Approach');
    expect(elements[0].text.content).toContain('Which approach should we use?');
  });

  it('renders option buttons with correct action values', () => {
    const card = buildAskUserQuestionCard('q1', singleQuestion);
    const elements = card.elements as any[];
    // Second element should be the action group with buttons
    const actionGroup = elements[1];
    expect(actionGroup.tag).toBe('action');
    expect(actionGroup.actions).toHaveLength(2);

    // First option should be primary
    expect(actionGroup.actions[0].type).toBe('primary');
    expect(actionGroup.actions[0].text.content).toBe('Option A');
    expect(actionGroup.actions[0].value).toEqual({
      action: 'ask_user_answer',
      questionId: 'q1',
      questionIndex: 0,
      optionIndex: 0,
      optionLabel: 'Option A',
    });

    // Second option should be default
    expect(actionGroup.actions[1].type).toBe('default');
    expect(actionGroup.actions[1].text.content).toBe('Option B');
  });

  it('renders option descriptions when provided', () => {
    const card = buildAskUserQuestionCard('q1', singleQuestion);
    const elements = card.elements as any[];
    // Third element should be the descriptions div
    const descDiv = elements[2];
    expect(descDiv.tag).toBe('div');
    expect(descDiv.text.content).toContain('Option A');
    expect(descDiv.text.content).toContain('Simple and fast');
  });

  it('renders note about custom answer at bottom', () => {
    const card = buildAskUserQuestionCard('q1', singleQuestion);
    const elements = card.elements as any[];
    const lastElement = elements[elements.length - 1];
    expect(lastElement.tag).toBe('note');
    expect(lastElement.elements[0].content).toContain('自定义答案');
  });

  it('renders multiple questions with separators', () => {
    const multiQuestion: AskUserQuestionItem[] = [
      {
        question: 'Question 1?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      {
        question: 'Question 2?',
        options: [{ label: 'C' }, { label: 'D' }],
      },
    ];
    const card = buildAskUserQuestionCard('q2', multiQuestion);
    const elements = card.elements as any[];
    // Should have: div1, action1, hr, div2, action2, note
    const hrElements = elements.filter((e: any) => e.tag === 'hr');
    expect(hrElements.length).toBe(1);
  });

  it('handles questions without header', () => {
    const noHeader: AskUserQuestionItem[] = [
      {
        question: 'Simple question?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ];
    const card = buildAskUserQuestionCard('q3', noHeader);
    const elements = card.elements as any[];
    expect(elements[0].text.content).toContain('Simple question?');
    // Should not contain " — " separator used for header
    expect(elements[0].text.content).not.toContain(' — ');
  });

  it('handles options without descriptions', () => {
    const noDesc: AskUserQuestionItem[] = [
      {
        question: 'Pick one?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ];
    const card = buildAskUserQuestionCard('q4', noDesc);
    const elements = card.elements as any[];
    // Should have: div(question), action(buttons), note — no descriptions div
    expect(elements.length).toBe(3);
  });
});

// ============================================================
// 2. Answered Card
// ============================================================

describe('buildAskUserAnsweredCard', () => {
  it('renders answered card with green header', () => {
    const questions: AskUserQuestionItem[] = [
      { question: 'Which?', header: 'Choice', options: [{ label: 'A' }] },
    ];
    const card = buildAskUserAnsweredCard(questions, { 'Which?': 'A' });
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: '✅ 已回答' },
      template: 'green',
    });
  });

  it('shows selected answer for each question', () => {
    const questions: AskUserQuestionItem[] = [
      { question: 'Color?', header: 'Theme', options: [{ label: 'Blue' }, { label: 'Red' }] },
    ];
    const card = buildAskUserAnsweredCard(questions, { 'Color?': 'Blue' });
    const elements = card.elements as any[];
    expect(elements[0].text.content).toContain('Theme');
    expect(elements[0].text.content).toContain('Color?');
    expect(elements[0].text.content).toContain('Blue');
  });

  it('shows dash for unanswered questions', () => {
    const questions: AskUserQuestionItem[] = [
      { question: 'Missing?', options: [{ label: 'A' }] },
    ];
    const card = buildAskUserAnsweredCard(questions, {});
    const elements = card.elements as any[];
    expect(elements[0].text.content).toContain('—');
  });
});
