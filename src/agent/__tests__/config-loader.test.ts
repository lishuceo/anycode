import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock logger to suppress output and spy on warnings
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config with minimal values
vi.mock('../../config.js', () => ({
  config: {
    agent: { configPath: '' },
    claude: {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 5,
      maxTurns: 100,
    },
  },
}));

const TEST_DIR = resolve('/tmp/config-loader-test-' + process.pid);
const KNOWLEDGE_DIR = resolve(TEST_DIR, 'knowledge');
const CONFIG_FILE = resolve(TEST_DIR, 'agents.json');

function writeConfig(obj: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(obj));
}

function writeKnowledge(name: string, content: string) {
  writeFileSync(resolve(KNOWLEDGE_DIR, name), content);
}

describe('loadKnowledgeContent', () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function setup(configObj: Record<string, unknown>) {
    writeConfig(configObj);

    // Stub env so loadAgentConfig finds our test config
    vi.stubEnv('AGENT_CONFIG_PATH', CONFIG_FILE);
    // Re-mock config with updated path
    vi.doMock('../../config.js', () => ({
      config: {
        agent: { configPath: CONFIG_FILE },
        claude: {
          model: 'claude-sonnet-4-6',
          maxBudgetUsd: 5,
          maxTurns: 100,
        },
      },
    }));

    const loader = await import('../config-loader.js');
    const result = loader.loadAgentConfig();
    expect(result.loaded).toBe(true);
    return loader;
  }

  it('should load and concatenate knowledge files', async () => {
    writeKnowledge('glossary.md', '# Glossary\nTerm A: definition');
    writeKnowledge('rules.md', '# Rules\nRule 1: always test');

    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'pm', knowledge: ['glossary.md', 'rules.md'] },
      ],
    });

    const content = loader.loadKnowledgeContent('pm');
    expect(content).toContain('# Glossary');
    expect(content).toContain('# Rules');
    // Should be joined with double newline
    expect(content).toContain('Term A: definition\n\n# Rules');
  });

  it('should return undefined for agent with no knowledge config', async () => {
    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'dev' },
      ],
    });

    const content = loader.loadKnowledgeContent('dev');
    expect(content).toBeUndefined();
  });

  it('should return undefined for empty knowledge list', async () => {
    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'pm', knowledge: [] },
      ],
    });

    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBeUndefined();
  });

  it('should skip missing files and warn', async () => {
    writeKnowledge('glossary.md', '# Glossary');
    // 'missing.md' does not exist

    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'pm', knowledge: ['glossary.md', 'missing.md'] },
      ],
    });

    const { logger } = await import('../../utils/logger.js');
    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBe('# Glossary');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'pm', file: 'missing.md' }),
      expect.stringContaining('Failed to read knowledge file'),
    );
  });

  it('should reject path traversal attempts', async () => {
    // Create a file outside knowledgeDir
    writeFileSync(resolve(TEST_DIR, 'secret.md'), 'SECRET');

    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'pm', knowledge: ['../secret.md'] },
      ],
    });

    const { logger } = await import('../../utils/logger.js');
    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'pm', file: '../secret.md' }),
      expect.stringContaining('escapes knowledgeDir'),
    );
  });

  it('should use defaults.knowledge when agent does not override', async () => {
    writeKnowledge('glossary.md', '# Glossary');

    const loader = await setup({
      knowledgeDir: './knowledge/',
      defaults: { knowledge: ['glossary.md'] },
      agents: [
        { id: 'pm' },
      ],
    });

    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBe('# Glossary');
  });

  it('should let agent-level knowledge fully override defaults', async () => {
    writeKnowledge('glossary.md', '# Glossary');
    writeKnowledge('product.md', '# Product');

    const loader = await setup({
      knowledgeDir: './knowledge/',
      defaults: { knowledge: ['glossary.md'] },
      agents: [
        { id: 'pm', knowledge: ['product.md'] },
      ],
    });

    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBe('# Product');
  });

  it('should warn when knowledge is set but knowledgeDir is not configured', async () => {
    const loader = await setup({
      // no knowledgeDir
      agents: [
        { id: 'pm', knowledge: ['glossary.md'] },
      ],
    });

    const { logger } = await import('../../utils/logger.js');
    const content = loader.loadKnowledgeContent('pm');
    expect(content).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'pm' }),
      expect.stringContaining('knowledgeDir is not configured'),
    );
  });
});

describe('getAgentConfigInfo', () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function setup(configObj: Record<string, unknown>) {
    writeFileSync(CONFIG_FILE, JSON.stringify(configObj));
    vi.stubEnv('AGENT_CONFIG_PATH', CONFIG_FILE);
    vi.doMock('../../config.js', () => ({
      config: {
        agent: { configPath: CONFIG_FILE },
        claude: { model: 'claude-sonnet-4-6', maxBudgetUsd: 5, maxTurns: 100 },
      },
    }));
    const loader = await import('../config-loader.js');
    const result = loader.loadAgentConfig();
    expect(result.loaded).toBe(true);
    return loader;
  }

  it('should return config file path and knowledge files', async () => {
    writeFileSync(resolve(KNOWLEDGE_DIR, 'team.md'), '# Team');

    const loader = await setup({
      knowledgeDir: './knowledge/',
      agents: [
        { id: 'dev', knowledge: ['team.md'] },
      ],
    });

    const info = loader.getAgentConfigInfo('dev');
    expect(info).toBeDefined();
    expect(info!.configFile).toBe(CONFIG_FILE);
    expect(info!.knowledgeFiles).toHaveLength(1);
    expect(info!.knowledgeFiles[0]).toContain('team.md');
  });

  it('should include persona file path when configured', async () => {
    mkdirSync(resolve(TEST_DIR, 'personas'), { recursive: true });
    writeFileSync(resolve(TEST_DIR, 'personas', 'pm.md'), '# PM');

    const loader = await setup({
      agents: [
        { id: 'pm', persona: './personas/pm.md' },
      ],
    });

    const info = loader.getAgentConfigInfo('pm');
    expect(info).toBeDefined();
    expect(info!.personaFile).toContain('personas/pm.md');
  });

  it('should return undefined for unknown agent', async () => {
    const loader = await setup({
      agents: [{ id: 'dev' }],
    });

    const info = loader.getAgentConfigInfo('nonexistent');
    expect(info).toBeUndefined();
  });
});

describe('editablePathPatterns', () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function setup(configObj: Record<string, unknown>) {
    writeFileSync(CONFIG_FILE, JSON.stringify(configObj));
    vi.stubEnv('AGENT_CONFIG_PATH', CONFIG_FILE);
    vi.doMock('../../config.js', () => ({
      config: {
        agent: { configPath: CONFIG_FILE },
        claude: { model: 'claude-sonnet-4-6', maxBudgetUsd: 5, maxTurns: 100 },
      },
    }));
    const loader = await import('../config-loader.js');
    const result = loader.loadAgentConfig();
    expect(result.loaded).toBe(true);
    return loader;
  }

  it('should pass agent-level editablePathPatterns through to registry', async () => {
    await setup({
      agents: [
        { id: 'pm', editablePathPatterns: ['config/personas/*', 'config/knowledge/*'] },
      ],
    });

    const { agentRegistry } = await import('../registry.js');
    const cfg = agentRegistry.get('pm');
    expect(cfg).toBeDefined();
    expect(cfg!.editablePathPatterns).toEqual(['config/personas/*', 'config/knowledge/*']);
  });

  it('should inherit editablePathPatterns from defaults', async () => {
    await setup({
      defaults: { editablePathPatterns: ['config/**'] },
      agents: [{ id: 'dev' }],
    });

    const { agentRegistry } = await import('../registry.js');
    const cfg = agentRegistry.get('dev');
    expect(cfg).toBeDefined();
    expect(cfg!.editablePathPatterns).toEqual(['config/**']);
  });

  it('should let agent-level editablePathPatterns override defaults', async () => {
    await setup({
      defaults: { editablePathPatterns: ['config/**'] },
      agents: [
        { id: 'pm', editablePathPatterns: ['config/personas/*'] },
      ],
    });

    const { agentRegistry } = await import('../registry.js');
    const cfg = agentRegistry.get('pm');
    expect(cfg!.editablePathPatterns).toEqual(['config/personas/*']);
  });

  it('should be undefined when not configured', async () => {
    await setup({
      agents: [{ id: 'dev' }],
    });

    const { agentRegistry } = await import('../registry.js');
    const cfg = agentRegistry.get('dev');
    expect(cfg!.editablePathPatterns).toBeUndefined();
  });
});
