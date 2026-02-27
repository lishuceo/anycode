/**
 * Agent Config Loader Tests
 *
 * Tests for:
 * - Zod schema validation
 * - defaults + overrides merge logic
 * - Config file loading and reload
 * - System prompt file reading
 * - AgentRegistry.replaceAll
 * - Tool pattern matching
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ============================================================
// 1. Zod Schema Validation
// ============================================================

describe('AgentConfigFileSchema', () => {
  let AgentConfigFileSchema: typeof import('../agent/config-schema.js').AgentConfigFileSchema;

  beforeEach(async () => {
    const mod = await import('../agent/config-schema.js');
    AgentConfigFileSchema = mod.AgentConfigFileSchema;
  });

  it('validates minimal config (agents only)', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test' }],
    });
    expect(result.success).toBe(true);
  });

  it('validates full config with defaults', () => {
    const result = AgentConfigFileSchema.safeParse({
      defaults: {
        model: 'claude-sonnet-4-6',
        toolPolicy: 'readonly',
        replyMode: 'direct',
        maxBudgetUsd: 5,
        maxTurns: 100,
      },
      agents: [
        { id: 'chat', displayName: 'ChatBot', replyMode: 'direct' },
        { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', maxBudgetUsd: 50 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing agent id', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ displayName: 'NoId' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty agent id', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxBudgetUsd', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', maxBudgetUsd: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero maxTurns', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', maxTurns: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts string toolPolicy', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', toolPolicy: 'readonly' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts detailed toolPolicy with allow/deny', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{
        id: 'test',
        toolPolicy: { profile: 'readonly', allow: ['Bash'], deny: ['Skill'] },
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid replyMode', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', replyMode: 'invalid' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts persona', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', persona: './personas/test.md' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty agents array', () => {
    const result = AgentConfigFileSchema.safeParse({
      agents: [],
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// 2. AgentRegistry.replaceAll
// ============================================================

describe('AgentRegistry.replaceAll', () => {
  it('replaces all agents atomically', async () => {
    const { agentRegistry } = await import('../agent/registry.js');
    // Verify builtins exist
    expect(agentRegistry.get('chat')).toBeDefined();
    expect(agentRegistry.get('dev')).toBeDefined();

    // Replace with custom agents
    agentRegistry.replaceAll([
      {
        id: 'custom',
        displayName: 'Custom',
        model: 'claude-sonnet-4-6',
        toolPolicy: 'all',
        readOnly: false,
        settingSources: ['user', 'project'],
        maxBudgetUsd: 10,
        maxTurns: 200,
        requiresApproval: false,
        replyMode: 'direct',
      },
    ]);

    expect(agentRegistry.get('custom')).toBeDefined();
    expect(agentRegistry.get('custom')!.displayName).toBe('Custom');
    // Old agents should be gone
    expect(agentRegistry.get('chat')).toBeUndefined();
    expect(agentRegistry.get('dev')).toBeUndefined();

    // allIds should only contain new agents
    expect(agentRegistry.allIds()).toEqual(['custom']);

    // Restore builtins for other tests — replaceAll with original defaults
    agentRegistry.replaceAll([
      {
        id: 'chat',
        displayName: 'ChatBot',
        model: 'claude-sonnet-4-6',
        toolPolicy: 'readonly',
        readOnly: true,
        settingSources: ['user', 'project'],
        maxBudgetUsd: 5,
        maxTurns: 100,
        requiresApproval: false,
        replyMode: 'direct',
      },
      {
        id: 'dev',
        displayName: 'DevBot',
        model: 'claude-opus-4-6',
        toolPolicy: 'all',
        readOnly: false,
        settingSources: ['user', 'project'],
        maxBudgetUsd: 50,
        maxTurns: 500,
        requiresApproval: true,
        replyMode: 'thread',
      },
    ]);
  });

  it('handles duplicate IDs (last wins)', async () => {
    const { agentRegistry } = await import('../agent/registry.js');
    agentRegistry.replaceAll([
      { id: 'a', displayName: 'First', model: 'm', toolPolicy: 'all', readOnly: false, settingSources: [], maxBudgetUsd: 1, maxTurns: 1, requiresApproval: false, replyMode: 'direct' },
      { id: 'a', displayName: 'Second', model: 'm', toolPolicy: 'all', readOnly: false, settingSources: [], maxBudgetUsd: 2, maxTurns: 2, requiresApproval: false, replyMode: 'direct' },
    ]);
    expect(agentRegistry.get('a')!.displayName).toBe('Second');
    expect(agentRegistry.get('a')!.maxBudgetUsd).toBe(2);

    // Restore
    agentRegistry.replaceAll([
      { id: 'chat', displayName: 'ChatBot', model: 'claude-sonnet-4-6', toolPolicy: 'readonly', readOnly: true, settingSources: ['user', 'project'], maxBudgetUsd: 5, maxTurns: 100, requiresApproval: false, replyMode: 'direct' },
      { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', readOnly: false, settingSources: ['user', 'project'], maxBudgetUsd: 50, maxTurns: 500, requiresApproval: true, replyMode: 'thread' },
    ]);
  });

  it('new agents immediately accessible via get/getOrThrow', async () => {
    const { agentRegistry } = await import('../agent/registry.js');
    agentRegistry.replaceAll([
      { id: 'pm', displayName: 'PM', model: 'm', toolPolicy: 'readonly', readOnly: true, settingSources: [], maxBudgetUsd: 3, maxTurns: 50, requiresApproval: false, replyMode: 'direct' },
    ]);

    expect(agentRegistry.get('pm')!.displayName).toBe('PM');
    expect(agentRegistry.getOrThrow('pm').maxBudgetUsd).toBe(3);
    expect(() => agentRegistry.getOrThrow('chat')).toThrow('Unknown agent: chat');

    // Restore
    agentRegistry.replaceAll([
      { id: 'chat', displayName: 'ChatBot', model: 'claude-sonnet-4-6', toolPolicy: 'readonly', readOnly: true, settingSources: ['user', 'project'], maxBudgetUsd: 5, maxTurns: 100, requiresApproval: false, replyMode: 'direct' },
      { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', readOnly: false, settingSources: ['user', 'project'], maxBudgetUsd: 50, maxTurns: 500, requiresApproval: true, replyMode: 'thread' },
    ]);
  });
});

// ============================================================
// 3. Config Loader — merge + load/reload
// ============================================================

// Mock dependencies that config-loader imports
vi.mock('../config.js', () => ({
  config: {
    claude: { model: 'claude-opus-4-6', maxBudgetUsd: 50, maxTurns: 500 },
    agent: { configPath: '' },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('config-loader', () => {
  const tmpDir = resolve(process.cwd(), '.test-config-loader');
  const configPath = resolve(tmpDir, 'agents.json');
  const promptsDir = resolve(tmpDir, 'prompts');
  const promptPath = resolve(promptsDir, 'test.md');

  beforeEach(() => {
    mkdirSync(promptsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('loadAgentConfig + reloadAgentConfig', () => {
    it('loads valid config and updates registry', async () => {
      writeFileSync(configPath, JSON.stringify({
        defaults: { model: 'claude-sonnet-4-6', maxTurns: 100 },
        agents: [
          { id: 'test-agent', displayName: 'Test', maxBudgetUsd: 10 },
        ],
      }));

      // Override env and default path
      vi.stubEnv('AGENT_CONFIG_PATH', configPath);
      const { config } = await import('../config.js');
      (config as any).agent.configPath = configPath;

      // Re-import to get fresh module (avoid cached state)
      const loader = await import('../agent/config-loader.js');
      const result = loader.loadAgentConfig();
      expect(result.loaded).toBe(true);

      const { agentRegistry } = await import('../agent/registry.js');
      const agent = agentRegistry.get('test-agent');
      expect(agent).toBeDefined();
      expect(agent!.displayName).toBe('Test');
      expect(agent!.model).toBe('claude-sonnet-4-6'); // from defaults
      expect(agent!.maxBudgetUsd).toBe(10); // from agent
      expect(agent!.maxTurns).toBe(100); // from defaults

      // Restore
      agentRegistry.replaceAll([
        { id: 'chat', displayName: 'ChatBot', model: 'claude-sonnet-4-6', toolPolicy: 'readonly', readOnly: true, settingSources: ['user', 'project'], maxBudgetUsd: 5, maxTurns: 100, requiresApproval: false, replyMode: 'direct' },
        { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', readOnly: false, settingSources: ['user', 'project'], maxBudgetUsd: 50, maxTurns: 500, requiresApproval: true, replyMode: 'thread' },
      ]);
    });
  });

  describe('readPersonaFile', () => {
    it('returns undefined when no persona configured', async () => {
      const loader = await import('../agent/config-loader.js');
      const result = loader.readPersonaFile('dev');
      // dev agent has no persona by default
      expect(result).toBeUndefined();
    });

    it('reads file content when configured', async () => {
      writeFileSync(promptPath, 'Test prompt content');
      writeFileSync(configPath, JSON.stringify({
        agents: [{ id: 'prompt-test', persona: promptPath }],
      }));

      const { config } = await import('../config.js');
      (config as any).agent.configPath = configPath;

      const loader = await import('../agent/config-loader.js');
      loader.loadAgentConfig();

      const content = loader.readPersonaFile('prompt-test');
      expect(content).toBe('Test prompt content');

      // Restore
      const { agentRegistry } = await import('../agent/registry.js');
      agentRegistry.replaceAll([
        { id: 'chat', displayName: 'ChatBot', model: 'claude-sonnet-4-6', toolPolicy: 'readonly', readOnly: true, settingSources: ['user', 'project'], maxBudgetUsd: 5, maxTurns: 100, requiresApproval: false, replyMode: 'direct' },
        { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', readOnly: false, settingSources: ['user', 'project'], maxBudgetUsd: 50, maxTurns: 500, requiresApproval: true, replyMode: 'thread' },
      ]);
    });
  });
});

// ============================================================
// 4. Tool Pattern Matching
// ============================================================

describe('matchToolPattern', () => {
  // We test the executor's matchToolPattern indirectly through its behavior.
  // But since it's a module-private function, let's test the schema-level
  // tool policy resolution instead.

  it('detailed toolPolicy resolves allow/deny lists', async () => {
    const { AgentConfigFileSchema } = await import('../agent/config-schema.js');
    const result = AgentConfigFileSchema.safeParse({
      agents: [{
        id: 'test',
        toolPolicy: {
          profile: 'readonly',
          allow: ['Bash', 'mcp__workspace*'],
          deny: ['Skill'],
        },
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const agent = result.data.agents[0];
      expect(typeof agent.toolPolicy).toBe('object');
      const policy = agent.toolPolicy as { profile: string; allow?: string[]; deny?: string[] };
      expect(policy.profile).toBe('readonly');
      expect(policy.allow).toEqual(['Bash', 'mcp__workspace*']);
      expect(policy.deny).toEqual(['Skill']);
    }
  });

  it('string toolPolicy stays as string', async () => {
    const { AgentConfigFileSchema } = await import('../agent/config-schema.js');
    const result = AgentConfigFileSchema.safeParse({
      agents: [{ id: 'test', toolPolicy: 'all' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].toolPolicy).toBe('all');
    }
  });
});

// ============================================================
// 5. Merge Logic — defaults + overrides
// ============================================================

describe('merge logic (via schema + registry)', () => {
  it('agent fields override defaults', async () => {
    const tmpDir2 = resolve(process.cwd(), '.test-merge');
    const configPath2 = resolve(tmpDir2, 'agents.json');
    mkdirSync(tmpDir2, { recursive: true });

    writeFileSync(configPath2, JSON.stringify({
      defaults: {
        model: 'default-model',
        maxBudgetUsd: 5,
        maxTurns: 100,
        toolPolicy: 'readonly',
        replyMode: 'direct',
      },
      agents: [
        { id: 'override-test', model: 'custom-model', maxBudgetUsd: 20 },
      ],
    }));

    const { config } = await import('../config.js');
    (config as any).agent.configPath = configPath2;

    const loader = await import('../agent/config-loader.js');
    loader.loadAgentConfig();

    const { agentRegistry } = await import('../agent/registry.js');
    const agent = agentRegistry.get('override-test');
    expect(agent).toBeDefined();
    expect(agent!.model).toBe('custom-model');       // overridden
    expect(agent!.maxBudgetUsd).toBe(20);             // overridden
    expect(agent!.maxTurns).toBe(100);                // from defaults
    expect(agent!.toolPolicy).toBe('readonly');       // from defaults
    expect(agent!.readOnly).toBe(true);               // derived from toolPolicy
    expect(agent!.replyMode).toBe('direct');          // from defaults
    expect(agent!.displayName).toBe('override-test'); // defaults to id

    // Cleanup
    rmSync(tmpDir2, { recursive: true, force: true });
    agentRegistry.replaceAll([
      { id: 'chat', displayName: 'ChatBot', model: 'claude-sonnet-4-6', toolPolicy: 'readonly', readOnly: true, settingSources: ['user', 'project'], maxBudgetUsd: 5, maxTurns: 100, requiresApproval: false, replyMode: 'direct' },
      { id: 'dev', displayName: 'DevBot', model: 'claude-opus-4-6', toolPolicy: 'all', readOnly: false, settingSources: ['user', 'project'], maxBudgetUsd: 50, maxTurns: 500, requiresApproval: true, replyMode: 'thread' },
    ]);
  });
});
