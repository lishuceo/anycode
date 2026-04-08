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
    it('should return empty array (feishu validation moved to agents.json)', async () => {
      const { validateConfig } = await loadConfig();
      const errors = validateConfig();
      expect(errors).toHaveLength(0);
    });
  });

  describe('environment variable parsing', () => {
    it('should parse comma-separated ALLOWED_USER_IDS', async () => {
      vi.stubEnv('ALLOWED_USER_IDS', 'user1, user2, user3');
      const { config } = await loadConfig();
      expect(config.security.allowedUserIds).toEqual(['user1', 'user2', 'user3']);
    });

    it('should handle empty ALLOWED_USER_IDS', async () => {
      vi.stubEnv('ALLOWED_USER_IDS', '');
      const { config } = await loadConfig();
      expect(config.security.allowedUserIds).toEqual([]);
    });

    it('should parse PORT as integer', async () => {
      vi.stubEnv('PORT', '8080');
      const { config } = await loadConfig();
      expect(config.server.port).toBe(8080);
    });

    it('should parse CLAUDE_TIMEOUT as integer', async () => {
      vi.stubEnv('CLAUDE_TIMEOUT', '600');
      const { config } = await loadConfig();
      expect(config.claude.timeoutSeconds).toBe(600);
    });
  });

  describe('defaults', () => {
    it('should default eventMode to websocket', async () => {
      delete process.env.FEISHU_EVENT_MODE;
      const { config } = await loadConfig();
      expect(config.feishu.eventMode).toBe('websocket');
    });

    it('should default work dir to parent of process.cwd()', async () => {
      vi.stubEnv('DEFAULT_WORK_DIR', '');
      const { config } = await loadConfig();
      const { dirname } = await import('node:path');
      expect(config.claude.defaultWorkDir).toBe(dirname(process.cwd()));
    });
  });
});
