import { describe, it, expect } from 'vitest';
import { resolveAgent, shouldRespond, validateBindings } from '../agent/router.js';
import type { AgentBinding, InboundContext } from '../agent/types.js';

describe('resolveAgent', () => {
  const bindings: AgentBinding[] = [
    // 特定群 → dev
    { agentId: 'dev', match: { accountId: 'dev-bot', peer: { kind: 'group', id: 'group_123' } } },
    // 按账号路由
    { agentId: 'chat', match: { accountId: 'chat-bot' } },
    { agentId: 'dev', match: { accountId: 'dev-bot' } },
    // 兜底
    { agentId: 'chat', match: { accountId: '*' } },
  ];

  it('matches specific peer binding first', () => {
    const inbound: InboundContext = {
      accountId: 'dev-bot', chatId: 'group_123', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('dev');
  });

  it('matches accountId binding', () => {
    const inbound: InboundContext = {
      accountId: 'chat-bot', chatId: 'group_456', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('chat');
  });

  it('falls through to wildcard', () => {
    const inbound: InboundContext = {
      accountId: 'unknown-bot', chatId: 'group_789', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('chat');
  });

  it('returns dev as default when no bindings', () => {
    const inbound: InboundContext = {
      accountId: 'any', chatId: 'chat1', userId: 'u1', chatType: 'p2p',
    };
    expect(resolveAgent([], inbound)).toBe('dev');
  });

  it('matches userId binding', () => {
    const userBindings: AgentBinding[] = [
      { agentId: 'dev', match: { userId: 'admin_user' } },
      { agentId: 'chat', match: { accountId: '*' } },
    ];
    expect(resolveAgent(userBindings, {
      accountId: 'chat-bot', chatId: 'c1', userId: 'admin_user', chatType: 'p2p',
    })).toBe('dev');
    expect(resolveAgent(userBindings, {
      accountId: 'chat-bot', chatId: 'c1', userId: 'other_user', chatType: 'p2p',
    })).toBe('chat');
  });
});

describe('shouldRespond', () => {
  const botA = 'bot_open_id_a';
  const botB = 'bot_open_id_b';
  const allBots = new Set([botA, botB]);
  const userMention = { id: { open_id: 'user_123' } };

  it('always responds in p2p chat', () => {
    expect(shouldRespond('p2p', [], botA, allBots)).toBe(true);
  });

  it('responds when @mentioned in group', () => {
    const mentions = [{ id: { open_id: botA } }];
    expect(shouldRespond('group', mentions, botA, allBots)).toBe(true);
    expect(shouldRespond('group', mentions, botB, allBots)).toBe(false);
  });

  it('both respond when both @mentioned', () => {
    const mentions = [{ id: { open_id: botA } }, { id: { open_id: botB } }];
    expect(shouldRespond('group', mentions, botA, allBots)).toBe(true);
    expect(shouldRespond('group', mentions, botB, allBots)).toBe(true);
  });

  it('commander responds when no bot @mentioned', () => {
    expect(shouldRespond('group', [], botA, allBots, botA)).toBe(true);
    expect(shouldRespond('group', [], botB, allBots, botA)).toBe(false);
  });

  it('commander yields to explicit @mention', () => {
    const mentions = [{ id: { open_id: botB } }];
    // botA is commander but botB is @mentioned → only botB responds
    expect(shouldRespond('group', mentions, botA, allBots, botA)).toBe(false);
    expect(shouldRespond('group', mentions, botB, allBots, botA)).toBe(true);
  });

  it('ignores non-bot mentions', () => {
    // Only user mentioned, no bot mentioned → commander responds
    expect(shouldRespond('group', [userMention], botA, allBots, botA)).toBe(true);
    expect(shouldRespond('group', [userMention], botB, allBots, botA)).toBe(false);
  });

  it('does not respond when no @mention and no commander', () => {
    expect(shouldRespond('group', [], botA, allBots)).toBe(false);
    expect(shouldRespond('group', [], botB, allBots)).toBe(false);
  });
});

describe('validateBindings', () => {
  it('warns when wildcard points to dev agent', () => {
    const bindings: AgentBinding[] = [
      { agentId: 'dev', match: { accountId: '*' } },
    ];
    const warnings = validateBindings(bindings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Wildcard');
  });

  it('no warnings for safe config', () => {
    const bindings: AgentBinding[] = [
      { agentId: 'dev', match: { accountId: 'dev-bot' } },
      { agentId: 'chat', match: { accountId: '*' } },
    ];
    expect(validateBindings(bindings)).toEqual([]);
  });

  it('returns empty for no bindings', () => {
    expect(validateBindings([])).toEqual([]);
  });
});
