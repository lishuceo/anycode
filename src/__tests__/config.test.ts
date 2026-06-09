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

  describe('parsePositiveInt', () => {
    it('parses valid positive integers', async () => {
      const { parsePositiveInt } = await loadConfig();
      expect(parsePositiveInt('15000', 999)).toBe(15000);
      expect(parsePositiveInt('1', 999)).toBe(1);
    });

    it('falls back when undefined or empty', async () => {
      const { parsePositiveInt } = await loadConfig();
      expect(parsePositiveInt(undefined, 15000)).toBe(15000);
      expect(parsePositiveInt('', 15000)).toBe(15000);
    });

    it('falls back on non-numeric values (guards setTimeout(fn, NaN) firing instantly)', async () => {
      const { parsePositiveInt } = await loadConfig();
      expect(parsePositiveInt('abc', 15000)).toBe(15000);
      expect(parsePositiveInt('none', 15000)).toBe(15000);
    });

    it('falls back on zero and negative values', async () => {
      const { parsePositiveInt } = await loadConfig();
      expect(parsePositiveInt('0', 15000)).toBe(15000);
      expect(parsePositiveInt('-5', 15000)).toBe(15000);
    });
  });

  describe('websearch config', () => {
    it('auto-enables when TAVILY_API_KEY is present', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tvly-abc');
      delete process.env.WEBSEARCH_ENABLED;
      const { config } = await loadConfig();
      expect(config.websearch.enabled).toBe(true);
      expect(config.websearch.apiKey).toBe('tvly-abc');
    });

    it('stays disabled when no key and no explicit enable', async () => {
      vi.stubEnv('TAVILY_API_KEY', '');
      delete process.env.WEBSEARCH_ENABLED;
      const { config } = await loadConfig();
      expect(config.websearch.enabled).toBe(false);
    });

    it('WEBSEARCH_ENABLED=false overrides key presence', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tvly-abc');
      vi.stubEnv('WEBSEARCH_ENABLED', 'false');
      const { config } = await loadConfig();
      expect(config.websearch.enabled).toBe(false);
    });

    it('stays disabled without a key even when WEBSEARCH_ENABLED=true', async () => {
      vi.stubEnv('TAVILY_API_KEY', '');
      vi.stubEnv('WEBSEARCH_ENABLED', 'true');
      const { config } = await loadConfig();
      expect(config.websearch.enabled).toBe(false);
    });

    it('falls back to safe timeout/maxResults on non-numeric env', async () => {
      vi.stubEnv('WEBSEARCH_TIMEOUT_MS', 'abc');
      vi.stubEnv('WEBSEARCH_MAX_RESULTS', 'xyz');
      const { config } = await loadConfig();
      expect(config.websearch.timeoutMs).toBe(15000);
      expect(config.websearch.maxResults).toBe(5);
    });
  });
});
