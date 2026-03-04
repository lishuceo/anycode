import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock lark SDK — must use class syntax for `new lark.Client()` to work
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    constructor() {}
    request = vi.fn().mockResolvedValue({ code: 0, bot: { open_id: 'bot_open_id_mock', app_name: 'TestBot' } });
    im = { message: { create: vi.fn(), reply: vi.fn(), patch: vi.fn() }, chatMembers: {} };
    contact = { user: { get: vi.fn() } };
  }
  class MockWSClient {
    constructor() {}
    start = vi.fn().mockResolvedValue(undefined);
  }
  return { Client: MockClient, WSClient: MockWSClient };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  config: {
    feishu: { appId: 'default_app', appSecret: 'default_secret' },
    claude: { defaultWorkDir: '/tmp' },
  },
}));

describe('AccountManager', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should initialize multiple bot accounts', async () => {
    const { AccountManager } = await import('../feishu/multi-account.js');
    const mgr = new AccountManager();

    await mgr.initialize([
      { accountId: 'pm-bot', appId: 'cli_aaa', appSecret: 'sec_a', botName: 'ChatBot' },
      { accountId: 'dev-bot', appId: 'cli_bbb', appSecret: 'sec_b', botName: 'DevBot' },
    ]);

    expect(mgr.allAccounts()).toHaveLength(2);
    expect(mgr.getClient('pm-bot')).toBeDefined();
    expect(mgr.getClient('dev-bot')).toBeDefined();
    expect(mgr.getClient('nonexistent')).toBeUndefined();
  });

  it('should resolve accountId from appId', async () => {
    const { AccountManager } = await import('../feishu/multi-account.js');
    const mgr = new AccountManager();

    await mgr.initialize([
      { accountId: 'pm-bot', appId: 'cli_aaa', appSecret: 'sec_a', botName: 'ChatBot' },
    ]);

    expect(mgr.resolveAccountId('cli_aaa')).toBe('pm-bot');
    expect(mgr.resolveAccountId('unknown')).toBeUndefined();
  });

  it('should collect all bot open IDs', async () => {
    const { AccountManager } = await import('../feishu/multi-account.js');
    const mgr = new AccountManager();

    await mgr.initialize([
      { accountId: 'a', appId: 'cli_a', appSecret: 's', botName: 'A' },
      { accountId: 'b', appId: 'cli_b', appSecret: 's', botName: 'B' },
    ]);

    const openIds = mgr.getAllBotOpenIds();
    // Both bots get the same mock open_id in this test
    expect(openIds.size).toBeGreaterThan(0);
  });

  it('should initialize single bot mode', async () => {
    const { AccountManager } = await import('../feishu/multi-account.js');
    const mgr = new AccountManager();

    mgr.initializeSingleBot('cli_default', 'sec_default');

    expect(mgr.singleBotMode).toBe(true);
    expect(mgr.getClient('default')).toBeDefined();
    expect(mgr.getDefaultClient()).toBeDefined();
    expect(mgr.resolveAccountId('cli_default')).toBe('default');
  });
});

describe('RequestContext', () => {
  it('should create context with getFeishuClient', async () => {
    // Initialize accountManager first
    const { AccountManager: _AccountManager } = await import('../feishu/multi-account.js');
    const { accountManager } = await import('../feishu/multi-account.js');

    // Use single bot mode for simplicity
    (accountManager as InstanceType<typeof _AccountManager>).initializeSingleBot('cli_x', 'sec_x');

    const { createRequestContext } = await import('../feishu/request-context.js');

    const ctx = createRequestContext({
      accountId: 'default',
      agentId: 'dev',
      chatId: 'chat1',
      userId: 'user1',
      messageId: 'msg1',
    });

    expect(ctx.accountId).toBe('default');
    expect(ctx.agentId).toBe('dev');
    expect(ctx.getFeishuClient()).toBeDefined();
  });
});
