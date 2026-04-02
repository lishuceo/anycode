/**
 * Tests for structured chat context — 父群消息与话题消息结构化分隔
 *
 * 当话题消息不足 max 时，buildDirectTaskHistory 会从父群补充。
 * formatHistoryMessages 接收 parentMsgCount 参数后，将输出分为两个结构化区：
 *   ### 群主聊天（当前话题创建前的背景）
 *   ---
 *   ### 当前话题
 */
import { describe, it, expect } from 'vitest';
import { _testFormatHistoryMessages as formatHistoryMessages } from '../feishu/event-handler.js';

type HistoryMsg = {
  messageId: string;
  senderId: string;
  senderType: 'user' | 'app';
  content: string;
  msgType: string;
  createTime?: string;
};

function makeMsg(overrides: Partial<HistoryMsg> & { content: string }): HistoryMsg {
  return {
    messageId: `msg_${Math.random().toString(36).slice(2, 8)}`,
    senderId: 'user_1',
    senderType: 'user',
    msgType: 'text',
    ...overrides,
  };
}

describe('formatHistoryMessages with parentMsgCount (structured sections)', () => {
  it('renders flat list when parentMsgCount is not set', async () => {
    const messages = [
      makeMsg({ content: 'hello', createTime: '1711900000000' }),
      makeMsg({ content: 'world', createTime: '1711900060000' }),
    ];
    const result = await formatHistoryMessages(messages);
    expect(result).toContain('## 飞书聊天近期上下文');
    expect(result).toContain('以下是用户 @bot 之前的聊天记录');
    expect(result).not.toContain('### 群主聊天');
    expect(result).not.toContain('### 当前话题');
  });

  it('renders structured sections when parentMsgCount > 0', async () => {
    const parentMsgs = [
      makeMsg({ content: '投放工程', createTime: '1711900000000' }),
      makeMsg({ content: '被lyz他们拒掉了？', createTime: '1711900060000' }),
    ];
    const threadMsgs = [
      makeMsg({ content: '[文件: 罗文锋.pdf]', createTime: '1711910000000' }),
      makeMsg({ content: 'ai上做过agent', createTime: '1711910060000' }),
    ];
    const messages = [...parentMsgs, ...threadMsgs];

    const result = await formatHistoryMessages(messages, undefined, undefined, { parentMsgCount: 2 });

    expect(result).toContain('## 飞书聊天近期上下文');
    expect(result).toContain('### 群主聊天（当前话题创建前的背景）');
    expect(result).toContain('---');
    expect(result).toContain('### 当前话题');
    // 不应包含默认的平坦描述
    expect(result).not.toContain('以下是用户 @bot 之前的聊天记录');

    // 验证父群消息在"群主聊天"区，话题消息在"当前话题"区
    const parentSectionIdx = result!.indexOf('### 群主聊天');
    const separatorIdx = result!.indexOf('---');
    const threadSectionIdx = result!.indexOf('### 当前话题');
    const parentContentIdx = result!.indexOf('投放工程');
    const threadContentIdx = result!.indexOf('ai上做过agent');

    expect(parentContentIdx).toBeGreaterThan(parentSectionIdx);
    expect(parentContentIdx).toBeLessThan(separatorIdx);
    expect(threadContentIdx).toBeGreaterThan(threadSectionIdx);
  });

  it('omits parent section when all parent messages are truncated by budget', async () => {
    // 用大量话题消息填满 8000 字符预算（每条被截断至 500 字符 ≈ 530 字符/行），
    // 使所有父群消息都被挤出预算
    const parentMsgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg({ content: `parent msg ${i}`, createTime: '1711900000000' }),
    );
    const threadMsgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg({ content: `thread msg ${i} ${'z'.repeat(500)}`, createTime: '1711910000000' }),
    );
    const messages = [...parentMsgs, ...threadMsgs];

    const result = await formatHistoryMessages(messages, undefined, undefined, { parentMsgCount: 5 });

    // 话题消息应保留
    expect(result).toContain('thread msg');
    expect(result).toContain('### 当前话题');
    // 父群区不应出现（全部被截断）
    expect(result).not.toContain('### 群主聊天');
  });

  it('only parent messages (empty thread fork) — no structured sections', async () => {
    // 话题为空时，所有消息来自父群，不传 parentMsgCount（因为没有话题消息可分隔）
    const messages = [
      makeMsg({ content: 'chat msg 1', createTime: '1711900000000' }),
      makeMsg({ content: 'chat msg 2', createTime: '1711900060000' }),
    ];
    const result = await formatHistoryMessages(messages);
    expect(result).toContain('## 飞书聊天近期上下文');
    expect(result).not.toContain('### 群主聊天');
    expect(result).not.toContain('### 当前话题');
  });

  it('thread has enough messages — no parent supplement, no sections', async () => {
    // 话题消息充足，不需要补充父群消息
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ content: `thread msg ${i}`, createTime: String(1711900000000 + i * 60000) }),
    );
    const result = await formatHistoryMessages(messages);
    expect(result).toContain('## 飞书聊天近期上下文');
    expect(result).not.toContain('### 群主聊天');
    expect(result).not.toContain('### 当前话题');
  });

  it('preserves message order within sections', async () => {
    const parentMsgs = [
      makeMsg({ content: 'parent-first', createTime: '1711900000000' }),
      makeMsg({ content: 'parent-second', createTime: '1711900060000' }),
    ];
    const threadMsgs = [
      makeMsg({ content: 'thread-first', createTime: '1711910000000' }),
      makeMsg({ content: 'thread-second', createTime: '1711910060000' }),
    ];
    const messages = [...parentMsgs, ...threadMsgs];
    const result = await formatHistoryMessages(messages, undefined, undefined, { parentMsgCount: 2 });

    const pFirst = result!.indexOf('parent-first');
    const pSecond = result!.indexOf('parent-second');
    const tFirst = result!.indexOf('thread-first');
    const tSecond = result!.indexOf('thread-second');

    expect(pFirst).toBeLessThan(pSecond);
    expect(tFirst).toBeLessThan(tSecond);
    expect(pSecond).toBeLessThan(tFirst);
  });

  it('shows truncation notice in parent section when some parent messages dropped', async () => {
    // 生成足够多的消息让部分父群消息被截断（每条约 220 字符，50 条 ≈ 11000 > 8000 预算）
    const parentMsgs = Array.from({ length: 50 }, (_, i) =>
      makeMsg({ content: `parent ${i} ${'y'.repeat(200)}`, createTime: '1711900000000' }),
    );
    const threadMsgs = [
      makeMsg({ content: 'thread msg here', createTime: '1711910000000' }),
    ];
    const messages = [...parentMsgs, ...threadMsgs];
    const result = await formatHistoryMessages(messages, undefined, undefined, { parentMsgCount: 50 });

    expect(result).toContain('### 当前话题');
    expect(result).toContain('thread msg here');
    // 应有省略提示
    expect(result).toContain('已省略');
  });
});
