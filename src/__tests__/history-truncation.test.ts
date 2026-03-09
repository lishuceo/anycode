/**
 * History Message Differentiated Truncation Tests
 *
 * Tests for the formatHistoryMessages logic that applies different truncation
 * limits based on message sender type:
 * - User messages: 500 chars
 * - Self bot messages: 150 chars (resume context has full version)
 * - Other bot messages: 4000 chars (need fuller context)
 *
 * Total budget: 8000 chars (CHAT_HISTORY_MAX_CHARS default)
 */
// @ts-nocheck — test file
import { describe, it, expect } from 'vitest';

// ============================================================
// Replicate production formatHistoryMessages logic for testability
// ============================================================

type SimpleMessage = {
  messageId: string;
  senderId: string;
  senderType: 'user' | 'app';
  content: string;
  msgType: string;
};

const TOTAL_BUDGET = 8000;
const USER_MSG_MAX = 500;
const SELF_BOT_MSG_MAX = 150;
const OTHER_BOT_MSG_MAX = 4000;

function formatHistory(
  messages: SimpleMessage[],
  selfBotOpenIds?: Set<string>,
): string | undefined {
  if (messages.length === 0) return undefined;

  const header = [
    '## 飞书聊天近期上下文',
    '以下是用户 @bot 之前的聊天记录，帮助你理解当前对话的背景：',
    '',
  ].join('\n');

  const lines = messages.map(m => {
    let role: string;
    let maxLen: number;
    if (m.senderType === 'app') {
      const isSelf = selfBotOpenIds && selfBotOpenIds.has(m.senderId);
      role = isSelf ? '[Bot(self)]' : '[Bot]';
      maxLen = isSelf ? SELF_BOT_MSG_MAX : OTHER_BOT_MSG_MAX;
    } else {
      role = '[用户]';
      maxLen = USER_MSG_MAX;
    }
    const text = m.content.length > maxLen
      ? m.content.slice(0, maxLen) + '...'
      : m.content;
    return `${role}: ${text}`;
  });

  let totalLen = header.length;
  let keepFrom = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    totalLen += lines[i].length + 1;
    if (totalLen > TOTAL_BUDGET) {
      keepFrom = i + 1;
      break;
    }
  }

  const kept = keepFrom > 0 ? lines.slice(keepFrom) : lines;
  if (kept.length === 0) return undefined;

  const parts = [header];
  if (keepFrom > 0) {
    parts.push(`_(已省略 ${keepFrom} 条较早消息)_`);
  }
  parts.push(...kept);
  return parts.join('\n');
}

// ============================================================
// Helpers
// ============================================================

function makeUserMsg(id: string, content: string, senderId = 'ou_user1'): SimpleMessage {
  return { messageId: id, senderId, senderType: 'user', content, msgType: 'text' };
}

function makeBotMsg(id: string, content: string, senderId: string): SimpleMessage {
  return { messageId: id, senderId, senderType: 'app', content, msgType: 'text' };
}

const SELF_BOT_ID = 'ou_self_bot';
const OTHER_BOT_ID = 'ou_other_bot';
const selfBotIds = new Set([SELF_BOT_ID]);

// ============================================================
// Tests
// ============================================================

describe('formatHistoryMessages differentiated truncation', () => {

  describe('per-message truncation limits', () => {
    it('truncates user messages at 500 chars', () => {
      const msg = makeUserMsg('m1', 'u'.repeat(600));
      const result = formatHistory([msg], selfBotIds);

      expect(result).toContain('u'.repeat(500) + '...');
      expect(result).not.toContain('u'.repeat(501));
    });

    it('truncates self bot messages at 150 chars', () => {
      const msg = makeBotMsg('m1', 's'.repeat(300), SELF_BOT_ID);
      const result = formatHistory([msg], selfBotIds);

      expect(result).toContain('[Bot(self)]');
      expect(result).toContain('s'.repeat(150) + '...');
      expect(result).not.toContain('s'.repeat(151));
    });

    it('truncates other bot messages at 4000 chars', () => {
      const msg = makeBotMsg('m1', 'o'.repeat(5000), OTHER_BOT_ID);
      const result = formatHistory([msg], selfBotIds);

      expect(result).toContain('[Bot]');
      expect(result).toContain('o'.repeat(4000) + '...');
      expect(result).not.toContain('o'.repeat(4001));
    });

    it('preserves short messages without truncation', () => {
      const result = formatHistory([
        makeUserMsg('m1', 'short user msg'),
        makeBotMsg('m2', 'short self reply', SELF_BOT_ID),
        makeBotMsg('m3', 'short other reply', OTHER_BOT_ID),
      ], selfBotIds);

      expect(result).toContain('[用户]: short user msg');
      expect(result).toContain('[Bot(self)]: short self reply');
      expect(result).toContain('[Bot]: short other reply');
    });
  });

  describe('self bot identification', () => {
    it('labels self bot as [Bot(self)] and other bot as [Bot]', () => {
      const result = formatHistory([
        makeBotMsg('m1', 'I am self', SELF_BOT_ID),
        makeBotMsg('m2', 'I am other', OTHER_BOT_ID),
      ], selfBotIds);

      expect(result).toContain('[Bot(self)]: I am self');
      expect(result).toContain('[Bot]: I am other');
    });

    it('supports multiple self bot IDs (multi-bot mode)', () => {
      const multiSelfIds = new Set([SELF_BOT_ID, 'ou_self_bot_2']);
      const result = formatHistory([
        makeBotMsg('m1', 'bot1 reply', SELF_BOT_ID),
        makeBotMsg('m2', 'bot2 reply', 'ou_self_bot_2'),
        makeBotMsg('m3', 'external bot', OTHER_BOT_ID),
      ], multiSelfIds);

      expect(result).toContain('[Bot(self)]: bot1 reply');
      expect(result).toContain('[Bot(self)]: bot2 reply');
      expect(result).toContain('[Bot]: external bot');
    });

    it('treats all bot messages as other bot when selfBotOpenIds is undefined', () => {
      const longContent = 'x'.repeat(300);
      const result = formatHistory([
        makeBotMsg('m1', longContent, SELF_BOT_ID),
      ], undefined);

      // Without selfBotOpenIds, should use OTHER_BOT_MSG_MAX (4000), not SELF_BOT_MSG_MAX (150)
      expect(result).toContain('[Bot]');
      expect(result).toContain(longContent); // 300 < 4000, no truncation
      expect(result).not.toContain('[Bot(self)]');
    });
  });

  describe('total budget guard (8000 chars)', () => {
    it('keeps all messages when within budget', () => {
      const msgs = [
        makeUserMsg('m1', 'hello'),
        makeBotMsg('m2', 'hi there', OTHER_BOT_ID),
        makeUserMsg('m3', 'thanks'),
      ];
      const result = formatHistory(msgs, selfBotIds);

      expect(result).toContain('hello');
      expect(result).toContain('hi there');
      expect(result).toContain('thanks');
      expect(result).not.toContain('已省略');
    });

    it('drops oldest messages when total exceeds 8000 chars', () => {
      // 20 user messages with ~500 chars each (after truncation) → ~10000+ chars, should drop some
      const msgs = Array.from({ length: 20 }, (_, i) =>
        makeUserMsg(`m${i}`, `msg-${i}-${'x'.repeat(490)}`),
      );
      const result = formatHistory(msgs, selfBotIds);

      expect(result).toBeDefined();
      expect(result).toContain('msg-19-'); // most recent kept
      expect(result).toContain('已省略');   // drop indicator
    });

    it('self bot messages use less budget than other bot messages', () => {
      // Self bot with 1000 chars → truncated to 150, leaves room for others
      // Other bot with 1000 chars → kept at 1000, uses more budget
      const selfBotLong = makeBotMsg('m1', 'S'.repeat(1000), SELF_BOT_ID);
      const otherBotLong = makeBotMsg('m2', 'O'.repeat(1000), OTHER_BOT_ID);
      const userMsg = makeUserMsg('m3', 'user question');

      const resultSelf = formatHistory([selfBotLong, userMsg], selfBotIds);
      const resultOther = formatHistory([otherBotLong, userMsg], selfBotIds);

      // Self bot line should be much shorter
      const selfLine = resultSelf!.split('\n').find(l => l.includes('[Bot(self)]'))!;
      const otherLine = resultOther!.split('\n').find(l => l.includes('[Bot]'))!;
      expect(selfLine.length).toBeLessThan(otherLine.length);
      expect(selfLine.length).toBeLessThan(200); // ~150 + role prefix
      expect(otherLine.length).toBeGreaterThan(900); // ~1000 + role prefix
    });
  });

  describe('mixed conversation scenarios', () => {
    it('handles typical group chat: users + self bot + other bot', () => {
      const msgs = [
        makeUserMsg('m1', '帮我看看这个 bug'),
        makeBotMsg('m2', '好的，我来分析一下。这个 bug 的原因是...（长回复）'.repeat(5), SELF_BOT_ID),
        makeUserMsg('m3', '谢谢，另外 @pm-bot 帮我看看需求'),
        makeBotMsg('m4', '根据需求文档，这个功能需要...（PM bot 的详细分析）'.repeat(10), OTHER_BOT_ID),
        makeUserMsg('m5', '好的，那就按这个方案来'),
      ];
      const result = formatHistory(msgs, selfBotIds);

      expect(result).toBeDefined();
      // All messages should be present (within budget)
      expect(result).toContain('帮我看看这个 bug');
      expect(result).toContain('[Bot(self)]');
      expect(result).toContain('[Bot]');
      expect(result).toContain('好的，那就按这个方案来');

      // Self bot should be truncated more aggressively
      const selfLine = result!.split('\n').find(l => l.includes('[Bot(self)]'))!;
      expect(selfLine.length).toBeLessThanOrEqual(150 + '[Bot(self)]: '.length + 3); // +3 for "..."
    });

    it('returns undefined for empty messages', () => {
      expect(formatHistory([], selfBotIds)).toBeUndefined();
    });
  });
});
