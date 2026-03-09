import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock feishuClient.getUserName
const mockGetUserName = vi.fn();
vi.mock('../client.js', () => ({
  feishuClient: {
    getUserName: (...args: unknown[]) => mockGetUserName(...args),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tagSenderIdentity, _testSetUserNameCache, _testClearUserNameCache } from '../event-handler.js';

describe('tagSenderIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testClearUserNameCache();
  });

  it('should prefix message with sender name in thread mode', async () => {
    _testSetUserNameCache('ou_abc', '姜黎');

    const result = await tagSenderIdentity('帮我看看这个', 'ou_abc', 'chat1', true);
    expect(result).toBe('[姜黎]: 帮我看看这个');
  });

  it('should not prefix in non-thread mode', async () => {
    _testSetUserNameCache('ou_abc', '姜黎');

    const result = await tagSenderIdentity('帮我看看这个', 'ou_abc', 'chat1', false);
    expect(result).toBe('帮我看看这个');
  });

  it('should return original prompt when user name is not found', async () => {
    mockGetUserName.mockResolvedValue(undefined);

    const result = await tagSenderIdentity('test message', 'ou_unknown', 'chat1', true);
    expect(result).toBe('test message');
  });

  it('should resolve user name via API when cache miss', async () => {
    mockGetUserName.mockResolvedValue('王禹繁');

    const result = await tagSenderIdentity('!ip a', 'ou_xyz', 'chat1', true);
    expect(result).toBe('[王禹繁]: !ip a');
    expect(mockGetUserName).toHaveBeenCalledWith('ou_xyz', 'chat1');
  });

  it('should use cached name without API call', async () => {
    _testSetUserNameCache('ou_cached', '赵天一');

    const result = await tagSenderIdentity('hello', 'ou_cached', 'chat1', true);
    expect(result).toBe('[赵天一]: hello');
    expect(mockGetUserName).not.toHaveBeenCalled();
  });

  it('should handle API error gracefully', async () => {
    mockGetUserName.mockRejectedValue(new Error('API error'));

    const result = await tagSenderIdentity('test', 'ou_fail', 'chat1', true);
    expect(result).toBe('test');
  });

  it('should preserve multiline prompt content', async () => {
    _testSetUserNameCache('ou_abc', '姜黎');

    const prompt = '第一行\n第二行\n第三行';
    const result = await tagSenderIdentity(prompt, 'ou_abc', 'chat1', true);
    expect(result).toBe('[姜黎]: 第一行\n第二行\n第三行');
  });
});
