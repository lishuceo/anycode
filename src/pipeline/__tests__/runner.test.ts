import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PipelineStore } from '../store.js';

// Mock all external dependencies
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    db: { sessionDbPath: '/tmp/test-runner.db', pipelineDbPath: '/tmp/test-runner-pipeline.db' },
    claude: { defaultWorkDir: '/tmp' },
  },
}));

vi.mock('../../feishu/client.js', () => ({
  feishuClient: {
    sendCard: vi.fn().mockResolvedValue('card_msg_1'),
    updateCard: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue({ messageId: 'bot_msg_1', threadId: 'thread_1' }),
    replyCardInThread: vi.fn().mockResolvedValue('card_msg_2'),
    replyTextInThread: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
    replyText: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    getOrCreate: vi.fn().mockReturnValue({
      chatId: 'chat1',
      userId: 'user1',
      workingDir: '/tmp/work',
      status: 'idle',
    }),
    get: vi.fn().mockReturnValue(null),
    setThread: vi.fn(),
    setConversationId: vi.fn(),
    setStatus: vi.fn(),
    tryAcquire: vi.fn().mockReturnValue(true),
    getRecentSummaries: vi.fn().mockReturnValue([]),
    saveSummary: vi.fn(),
    setWorkingDir: vi.fn(),
  },
}));

vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: {
    execute: vi.fn(),
    killSession: vi.fn(),
  },
}));

vi.mock('../reviewer.js', () => ({
  parallelReview: vi.fn(),
}));

vi.mock('../../feishu/thread-utils.js', () => ({
  ensureThread: vi.fn().mockResolvedValue('root1'),
}));

// Use a dynamic import pattern to handle the store mock properly
const _tempDir = mkdtempSync(join(tmpdir(), 'runner-test-'));
const _storeDbPath = join(_tempDir, 'test.db');

// Mock store with a factory that creates its own instance
vi.mock('../store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../store.js')>();
  // Create a fresh temp directory for the store inside the factory
  const tempDirInner = mkdtempSync(join(tmpdir(), 'runner-store-'));
  const store = new mod.PipelineStore(join(tempDirInner, 'test.db'));
  return {
    ...mod,
    pipelineStore: store,
    // Store tempDir for cleanup
    __tempDir: tempDirInner,
  };
});

// Import after mocks are set up
const { createPendingPipeline, cancelPipeline } = await import('../runner.js');
const storeModule = await import('../store.js') as typeof import('../store.js') & { __tempDir: string };
const { pipelineStore } = storeModule;
const { feishuClient } = await import('../../feishu/client.js');

describe('Pipeline Runner', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    pipelineStore.close();
    rmSync(storeModule.__tempDir, { recursive: true, force: true });
    rmSync(_tempDir, { recursive: true, force: true });
  });

  describe('createPendingPipeline', () => {
    it('should create a pipeline record in pending_confirm status', async () => {
      const pipelineId = await createPendingPipeline({
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        rootId: 'root1',
        prompt: 'build a feature',
        workingDir: '/tmp/work',
      });

      expect(pipelineId).toMatch(/^pipe_/);

      const record = pipelineStore.get(pipelineId);
      expect(record).toBeDefined();
      expect(record!.status).toBe('pending_confirm');
      expect(record!.prompt).toBe('build a feature');
      expect(record!.workingDir).toBe('/tmp/work');
    });

    it('should send a confirmation card', async () => {
      await createPendingPipeline({
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        rootId: 'root1',
        prompt: 'task',
        workingDir: '/tmp',
      });

      expect(feishuClient.replyCardInThread).toHaveBeenCalled();
    });
  });

  describe('cancelPipeline', () => {
    it('should cancel a pending_confirm pipeline', async () => {
      const pipelineId = await createPendingPipeline({
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        prompt: 'task',
        workingDir: '/tmp',
      });

      const result = cancelPipeline(pipelineId);
      expect(result).toBe(true);

      const record = pipelineStore.get(pipelineId);
      expect(record!.status).toBe('cancelled');
    });

    it('should not cancel a non-pending pipeline', async () => {
      const pipelineId = await createPendingPipeline({
        chatId: 'chat1',
        userId: 'user1',
        messageId: 'msg1',
        prompt: 'task',
        workingDir: '/tmp',
      });

      pipelineStore.tryStart(pipelineId);

      const result = cancelPipeline(pipelineId);
      expect(result).toBe(false);
    });
  });
});
