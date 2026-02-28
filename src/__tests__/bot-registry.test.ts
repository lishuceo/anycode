import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatBotRegistry } from '../feishu/bot-registry.js';

describe('ChatBotRegistry', () => {
  let registry: ChatBotRegistry;

  beforeEach(() => {
    registry = new ChatBotRegistry();
  });

  describe('addBot', () => {
    it('should add a bot and retrieve it via getBots', () => {
      registry.addBot('chat1', 'ou_bot1', 'GPT助手', 'event_added');
      const bots = registry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0]).toMatchObject({
        openId: 'ou_bot1',
        name: 'GPT助手',
        source: 'event_added',
      });
      expect(bots[0].discoveredAt).toBeGreaterThan(0);
    });

    it('should be idempotent — same openId added twice does not duplicate', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      const bots = registry.getBots('chat1');
      expect(bots).toHaveLength(1);
    });

    it('should upgrade source from message_sender to event_added', () => {
      registry.addBot('chat1', 'ou_bot1', undefined, 'message_sender');
      expect(registry.getBots('chat1')[0].source).toBe('message_sender');

      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      const bots = registry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].source).toBe('event_added');
      expect(bots[0].name).toBe('Bot1');
    });

    it('should NOT downgrade source from event_added to message_sender', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat1', 'ou_bot1', undefined, 'message_sender');
      const bots = registry.getBots('chat1');
      expect(bots[0].source).toBe('event_added');
    });

    it('should update name when existing entry has no name', () => {
      registry.addBot('chat1', 'ou_bot1', undefined, 'message_sender');
      expect(registry.getBots('chat1')[0].name).toBeUndefined();

      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'message_sender');
      expect(registry.getBots('chat1')[0].name).toBe('Bot1');
    });

    it('should add multiple bots to the same chat', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat1', 'ou_bot2', 'Bot2', 'message_sender');
      const bots = registry.getBots('chat1');
      expect(bots).toHaveLength(2);
    });

    it('should isolate bots between different chats', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat2', 'ou_bot2', 'Bot2', 'event_added');
      expect(registry.getBots('chat1')).toHaveLength(1);
      expect(registry.getBots('chat2')).toHaveLength(1);
      expect(registry.getBots('chat1')[0].openId).toBe('ou_bot1');
      expect(registry.getBots('chat2')[0].openId).toBe('ou_bot2');
    });
  });

  describe('removeBot', () => {
    it('should remove a specific bot', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat1', 'ou_bot2', 'Bot2', 'event_added');
      registry.removeBot('chat1', 'ou_bot1');
      const bots = registry.getBots('chat1');
      expect(bots).toHaveLength(1);
      expect(bots[0].openId).toBe('ou_bot2');
    });

    it('should not throw when removing a non-existent bot', () => {
      expect(() => registry.removeBot('chat1', 'ou_nonexistent')).not.toThrow();
    });

    it('should not throw when removing from a non-existent chat', () => {
      expect(() => registry.removeBot('nonexistent_chat', 'ou_bot1')).not.toThrow();
    });
  });

  describe('clearChat', () => {
    it('should clear all bots for a specific chat', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat1', 'ou_bot2', 'Bot2', 'event_added');
      registry.clearChat('chat1');
      expect(registry.getBots('chat1')).toHaveLength(0);
    });

    it('should not affect other chats', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      registry.addBot('chat2', 'ou_bot2', 'Bot2', 'event_added');
      registry.clearChat('chat1');
      expect(registry.getBots('chat1')).toHaveLength(0);
      expect(registry.getBots('chat2')).toHaveLength(1);
    });

    it('should not throw when clearing a non-existent chat', () => {
      expect(() => registry.clearChat('nonexistent_chat')).not.toThrow();
    });
  });

  describe('getBots', () => {
    it('should return empty array for unknown chat', () => {
      expect(registry.getBots('unknown_chat')).toEqual([]);
    });
  });

  describe('cleanup', () => {
    it('should remove chats idle longer than maxIdleMs', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      // Advance time by 1ms, then cleanup with 0ms tolerance
      vi.spyOn(Date, 'now').mockReturnValue(now + 1);
      registry.cleanup(0);
      expect(registry.getBots('chat1')).toHaveLength(0);
      vi.restoreAllMocks();
    });

    it('should keep active chats', () => {
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');
      // Use a large maxIdleMs — chat was just created, should survive
      registry.cleanup(24 * 60 * 60 * 1000);
      expect(registry.getBots('chat1')).toHaveLength(1);
    });

    it('should selectively clean only expired chats', () => {
      // Add to chat1, wait, add to chat2
      registry.addBot('chat1', 'ou_bot1', 'Bot1', 'event_added');

      // Manually manipulate time: cleanup with 0ms tolerance removes everything,
      // but if we add chat2 after, it won't be there
      // Better: use vi.spyOn(Date, 'now') to control time
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      registry.addBot('chat_old', 'ou_bot_old', 'OldBot', 'event_added');

      // Advance time by 25 hours
      vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
      registry.addBot('chat_new', 'ou_bot_new', 'NewBot', 'event_added');

      // Cleanup with 24h tolerance — chat_old should be removed, chat_new kept
      registry.cleanup(24 * 60 * 60 * 1000);
      expect(registry.getBots('chat_old')).toHaveLength(0);
      expect(registry.getBots('chat_new')).toHaveLength(1);

      vi.restoreAllMocks();
    });
  });
});
