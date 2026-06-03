import { describe, it, expect } from 'vitest';
import { resolveAgent, shouldRespond, getRespondReason, validateBindings } from '../agent/router.js';
import type { AgentBinding, InboundContext } from '../agent/types.js';

describe('resolveAgent', () => {
  const bindings: AgentBinding[] = [
    // 特定群 → dev
    { agentId: 'dev', match: { accountId: 'dev-bot', peer: { kind: 'group', id: 'group_123' } } },
    // 按账号路由
    { agentId: 'pm', match: { accountId: 'pm-bot' } },
    { agentId: 'dev', match: { accountId: 'dev-bot' } },
    // 兜底
    { agentId: 'pm', match: { accountId: '*' } },
  ];

  it('matches specific peer binding first', () => {
    const inbound: InboundContext = {
      accountId: 'dev-bot', chatId: 'group_123', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('dev');
  });

  it('matches accountId binding', () => {
    const inbound: InboundContext = {
      accountId: 'pm-bot', chatId: 'group_456', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('pm');
  });

  it('falls through to wildcard', () => {
    const inbound: InboundContext = {
      accountId: 'unknown-bot', chatId: 'group_789', userId: 'u1', chatType: 'group',
    };
    expect(resolveAgent(bindings, inbound)).toBe('pm');
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
      { agentId: 'pm', match: { accountId: '*' } },
    ];
    expect(resolveAgent(userBindings, {
      accountId: 'pm-bot', chatId: 'c1', userId: 'admin_user', chatType: 'p2p',
    })).toBe('dev');
    expect(resolveAgent(userBindings, {
      accountId: 'pm-bot', chatId: 'c1', userId: 'other_user', chatType: 'p2p',
    })).toBe('pm');
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
      { agentId: 'pm', match: { accountId: '*' } },
    ];
    expect(validateBindings(bindings)).toEqual([]);
  });

  it('returns empty for no bindings', () => {
    expect(validateBindings([])).toEqual([]);
  });
});

describe('getRespondReason', () => {
  const botA = 'bot_open_id_a';
  const botB = 'bot_open_id_b';
  const allBots = new Set([botA, botB]);
  const userMention = { id: { open_id: 'user_123' } };

  it('returns "p2p" for private chats', () => {
    expect(getRespondReason('p2p', [], botA, allBots)).toBe('p2p');
    expect(getRespondReason('p2p', [], botA, new Set())).toBe('p2p');
  });

  it('returns "mentioned" when bot is @mentioned', () => {
    const mentions = [{ id: { open_id: botA } }];
    expect(getRespondReason('group', mentions, botA, allBots)).toBe('mentioned');
  });

  it('returns undefined when other bot is @mentioned but not this one', () => {
    const mentions = [{ id: { open_id: botB } }];
    expect(getRespondReason('group', mentions, botA, allBots)).toBeUndefined();
  });

  it('returns "commander" when no bot @mentioned and this bot is commander', () => {
    expect(getRespondReason('group', [], botA, allBots, botA)).toBe('commander');
  });

  it('returns undefined when no bot @mentioned and this bot is NOT commander', () => {
    expect(getRespondReason('group', [], botB, allBots, botA)).toBeUndefined();
  });

  it('returns undefined when no @mention and no commander', () => {
    expect(getRespondReason('group', [], botA, allBots)).toBeUndefined();
    expect(getRespondReason('group', [], botB, allBots)).toBeUndefined();
  });

  it('ignores human-only mentions (no commander)', () => {
    expect(getRespondReason('group', [userMention], botA, allBots)).toBeUndefined();
  });

  it('commander responds when only human mentions present', () => {
    expect(getRespondReason('group', [userMention], botA, allBots, botA)).toBe('commander');
  });

  it('explicit @mention overrides commander', () => {
    const mentions = [{ id: { open_id: botB } }];
    expect(getRespondReason('group', mentions, botA, allBots, botA)).toBeUndefined();
    expect(getRespondReason('group', mentions, botB, allBots, botA)).toBe('mentioned');
  });

  it('handles empty allBotOpenIds gracefully', () => {
    const emptyBots = new Set<string>();
    expect(getRespondReason('group', [], botA, emptyBots)).toBeUndefined();
    const mentions = [{ id: { open_id: botA } }];
    expect(getRespondReason('group', mentions, botA, emptyBots)).toBeUndefined();
  });

  it('handles mentions with missing open_id', () => {
    const mentions = [{ id: {} }, { id: { open_id: undefined } }];
    expect(getRespondReason('group', mentions, botA, allBots)).toBeUndefined();
  });

  it('shouldRespond wrapper matches getRespondReason', () => {
    expect(shouldRespond('p2p', [], botA, allBots)).toBe(true);
    expect(shouldRespond('group', [], botA, allBots)).toBe(false);
    expect(shouldRespond('group', [{ id: { open_id: botA } }], botA, allBots)).toBe(true);
    expect(shouldRespond('group', [], botA, allBots, botA)).toBe(true);
  });
});
