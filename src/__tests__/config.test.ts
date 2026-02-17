import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig() {
    const mod = await import('../config.js');
    return mod;
  }

  describe('validateConfig', () => {
    it('should return errors when FEISHU_APP_ID is missing', async () => {
      vi.stubEnv('FEISHU_APP_ID', '');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      const { validateConfig } = await loadConfig();
      const errors = validateConfig();
      expect(errors).toContain('FEISHU_APP_ID is required');
    });

    it('should return errors when FEISHU_APP_SECRET is missing', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', '');
      const { validateConfig } = await loadConfig();
      const errors = validateConfig();
      expect(errors).toContain('FEISHU_APP_SECRET is required');
    });

    it('should return errors for both missing fields', async () => {
      vi.stubEnv('FEISHU_APP_ID', '');
      vi.stubEnv('FEISHU_APP_SECRET', '');
      const { validateConfig } = await loadConfig();
      const errors = validateConfig();
      expect(errors).toHaveLength(2);
    });

    it('should return empty array when all required fields are set', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'myid');
      vi.stubEnv('FEISHU_APP_SECRET', 'mysecret');
      const { validateConfig } = await loadConfig();
      const errors = validateConfig();
      expect(errors).toHaveLength(0);
    });
  });

  describe('environment variable parsing', () => {
    it('should parse comma-separated ALLOWED_USER_IDS', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      vi.stubEnv('ALLOWED_USER_IDS', 'user1, user2, user3');
      const { config } = await loadConfig();
      expect(config.security.allowedUserIds).toEqual(['user1', 'user2', 'user3']);
    });

    it('should handle empty ALLOWED_USER_IDS', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      vi.stubEnv('ALLOWED_USER_IDS', '');
      const { config } = await loadConfig();
      expect(config.security.allowedUserIds).toEqual([]);
    });

    it('should parse PORT as integer', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      vi.stubEnv('PORT', '8080');
      const { config } = await loadConfig();
      expect(config.server.port).toBe(8080);
    });

    it('should parse CLAUDE_TIMEOUT as integer', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      vi.stubEnv('CLAUDE_TIMEOUT', '600');
      const { config } = await loadConfig();
      expect(config.claude.timeoutSeconds).toBe(600);
    });
  });

  describe('defaults', () => {
    it('should default eventMode to websocket', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      delete process.env.FEISHU_EVENT_MODE;
      const { config } = await loadConfig();
      expect(config.feishu.eventMode).toBe('websocket');
    });

    it('should default work dir to /home/ubuntu/projects', async () => {
      vi.stubEnv('FEISHU_APP_ID', 'id');
      vi.stubEnv('FEISHU_APP_SECRET', 'secret');
      vi.stubEnv('DEFAULT_WORK_DIR', '');
      const { config } = await loadConfig();
      expect(config.claude.defaultWorkDir).toBe('/home/ubuntu/projects');
    });
  });
});
