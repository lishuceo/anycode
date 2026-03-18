import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use vi.hoisted to create mock objects that can be referenced in vi.mock factories
const {
  mockFeishuClient,
  mockIsMemoryEnabled,
  mockGetMemoryStore,
  mockGetHybridSearch,
} = vi.hoisted(() => ({
  mockFeishuClient: {
    replyText: vi.fn(),
    replyTextInThread: vi.fn(),
    sendCard: vi.fn(),
    sendEphemeralCard: vi.fn(),
    replyCardInThread: vi.fn(),
  },
  mockIsMemoryEnabled: vi.fn(() => true),
  mockGetMemoryStore: vi.fn<() => unknown>(() => null),
  mockGetHybridSearch: vi.fn<() => unknown>(() => null),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../feishu/client.js', () => ({
  feishuClient: mockFeishuClient,
}));

vi.mock('../../config.js', () => ({
  config: {
    memory: {
      enabled: true,
      vectorWeight: 0.7,
      maxInjectTokens: 4000,
    },
  },
}));

vi.mock('../init.js', () => ({
  isMemoryEnabled: () => mockIsMemoryEnabled(),
  getMemoryStore: () => mockGetMemoryStore(),
  getHybridSearch: () => mockGetHybridSearch(),
}));

import { MemoryDatabase } from '../database.js';
import type { MemoryRow } from '../database.js';
import { MemoryStore } from '../store.js';
import { NoopEmbeddingProvider } from '../embeddings.js';
import { handleMemoryCommand, handleMemoryCardAction } from '../commands.js';
import {
  buildMemoryListCard,
  buildMemorySearchCard,
  buildMemoryClearConfirmCard,
  buildMemoryResultCard,
} from '../../feishu/message-builder.js';

// ── Helpers ──

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date().toISOString();
  return {
    id: `mem_cmd_${Math.random().toString(36).slice(2, 8)}`,
    agent_id: 'dev',
    user_id: 'user1',
    chat_id: 'chat1',
    workspace_dir: '/projects/test',
    type: 'fact',
    content: 'Test memory content',
    tags: '["test"]',
    metadata: '{}',
    confidence: 0.7,
    confidence_level: 'L0',
    evidence_count: 1,
    valid_at: now,
    invalid_at: null,
    superseded_by: null,
    ttl: null,
    source_chat_id: null,
    source_message_id: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    ...overrides,
  };
}

// ============================================================
// Database: listMemories + countByType + deleteAllForUser
// ============================================================

describe('MemoryDatabase list/count', () => {
  let db: MemoryDatabase;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-cmd-test-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should list valid memories with pagination', () => {
    for (let i = 0; i < 7; i++) {
      db.insertMemory(makeRow({ id: `mem_list_${i}`, content: `Memory ${i}` }));
    }

    const page1 = db.listMemories('dev', 'user1', { limit: 3, offset: 0 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.total).toBe(7);

    const page2 = db.listMemories('dev', 'user1', { limit: 3, offset: 3 });
    expect(page2.rows).toHaveLength(3);

    const page3 = db.listMemories('dev', 'user1', { limit: 3, offset: 6 });
    expect(page3.rows).toHaveLength(1);
  });

  it('should filter by type', () => {
    db.insertMemory(makeRow({ id: 'mem_f1', type: 'fact' }));
    db.insertMemory(makeRow({ id: 'mem_p1', type: 'preference' }));
    db.insertMemory(makeRow({ id: 'mem_f2', type: 'fact' }));

    const result = db.listMemories('dev', 'user1', { type: 'fact' });
    expect(result.total).toBe(2);
    expect(result.rows.every(r => r.type === 'fact')).toBe(true);
  });

  it('should exclude invalid memories', () => {
    db.insertMemory(makeRow({ id: 'mem_valid', content: 'valid' }));
    db.insertMemory(makeRow({
      id: 'mem_invalid',
      content: 'invalid',
      invalid_at: new Date().toISOString(),
    }));

    const result = db.listMemories('dev', 'user1');
    expect(result.total).toBe(1);
    expect(result.rows[0].id).toBe('mem_valid');
  });

  it('should include global memories (agent_id = *)', () => {
    db.insertMemory(makeRow({ id: 'mem_agent', agent_id: 'dev' }));
    db.insertMemory(makeRow({ id: 'mem_global', agent_id: '*' }));

    const result = db.listMemories('dev', 'user1');
    expect(result.total).toBe(2);
  });

  it('should include user-agnostic memories (user_id = NULL)', () => {
    db.insertMemory(makeRow({ id: 'mem_user', user_id: 'user1' }));
    db.insertMemory(makeRow({ id: 'mem_null', user_id: null }));

    const result = db.listMemories('dev', 'user1');
    expect(result.total).toBe(2);
  });

  it('should not include other users memories', () => {
    db.insertMemory(makeRow({ id: 'mem_mine', user_id: 'user1' }));
    db.insertMemory(makeRow({ id: 'mem_other', user_id: 'user2' }));

    const result = db.listMemories('dev', 'user1');
    expect(result.total).toBe(1);
    expect(result.rows[0].id).toBe('mem_mine');
  });

  it('should order by updated_at DESC', () => {
    const old = new Date(Date.now() - 10000).toISOString();
    const recent = new Date().toISOString();
    db.insertMemory(makeRow({ id: 'mem_old', updated_at: old }));
    db.insertMemory(makeRow({ id: 'mem_new', updated_at: recent }));

    const result = db.listMemories('dev', 'user1');
    expect(result.rows[0].id).toBe('mem_new');
    expect(result.rows[1].id).toBe('mem_old');
  });

  describe('countByType', () => {
    it('should count memories by type', () => {
      db.insertMemory(makeRow({ id: 'c1', type: 'fact' }));
      db.insertMemory(makeRow({ id: 'c2', type: 'fact' }));
      db.insertMemory(makeRow({ id: 'c3', type: 'preference' }));
      db.insertMemory(makeRow({ id: 'c4', type: 'state' }));

      const counts = db.countByType('dev', 'user1');
      expect(counts).toEqual(
        expect.arrayContaining([
          { type: 'fact', count: 2 },
          { type: 'preference', count: 1 },
          { type: 'state', count: 1 },
        ]),
      );
    });

    it('should exclude invalid memories from count', () => {
      db.insertMemory(makeRow({ id: 'cv1', type: 'fact' }));
      db.insertMemory(makeRow({
        id: 'cv2',
        type: 'fact',
        invalid_at: new Date().toISOString(),
      }));

      const counts = db.countByType('dev', 'user1');
      const factCount = counts.find(c => c.type === 'fact');
      expect(factCount?.count).toBe(1);
    });
  });

  describe('deleteAllForUser', () => {
    it('should delete all valid memories and return IDs', () => {
      db.insertMemory(makeRow({ id: 'da1' }));
      db.insertMemory(makeRow({ id: 'da2' }));
      db.insertMemory(makeRow({
        id: 'da3',
        invalid_at: new Date().toISOString(),
      }));

      const ids = db.deleteAllForUser('dev', 'user1');
      expect(ids).toHaveLength(2);
      expect(ids).toContain('da1');
      expect(ids).toContain('da2');
      expect(db.getMemory('da1')).toBeUndefined();
      expect(db.getMemory('da2')).toBeUndefined();
      expect(db.getMemory('da3')).toBeDefined();
    });

    it('should NOT delete shared memories (user_id = NULL)', () => {
      db.insertMemory(makeRow({ id: 'da_own', user_id: 'user1' }));
      db.insertMemory(makeRow({ id: 'da_shared', user_id: null }));

      const ids = db.deleteAllForUser('dev', 'user1');
      expect(ids).toHaveLength(1);
      expect(ids).toContain('da_own');
      // Shared memory should still exist
      expect(db.getMemory('da_shared')).toBeDefined();
    });

    it('should return empty array when no memories exist', () => {
      const ids = db.deleteAllForUser('dev', 'user1');
      expect(ids).toHaveLength(0);
    });
  });
});

// ============================================================
// MemoryStore list/count/deleteAll
// ============================================================

describe('MemoryStore list/count/deleteAll', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-store-cmd-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    store = new MemoryStore(db, new NoopEmbeddingProvider(1536));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should list memories with Memory interface', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'Hello' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'TypeScript' });

    const { memories, total } = store.list('dev', 'user1');
    expect(total).toBe(2);
    expect(memories).toHaveLength(2);
    expect(memories[0]).toHaveProperty('agentId');
    expect(memories[0]).toHaveProperty('content');
  });

  it('should count by type as Record', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'B' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'C' });

    const counts = store.countByType('dev', 'user1');
    expect(counts['fact']).toBe(2);
    expect(counts['preference']).toBe(1);
  });

  it('should delete all and return count', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'B' });

    const count = store.deleteAll('dev', 'user1');
    expect(count).toBe(2);

    const { total } = store.list('dev', 'user1');
    expect(total).toBe(0);
  });
});

// ============================================================
// Card building functions
// ============================================================

describe('Memory card builders', () => {
  describe('buildMemoryListCard', () => {
    it('should build a list card with stats and memories', () => {
      const memories = [
        {
          id: 'mem1', agentId: 'dev', userId: 'user1', chatId: null,
          workspaceDir: null, type: 'fact' as const, content: 'Node 20',
          tags: [], metadata: {}, confidence: 0.7, confidenceLevel: 'L0' as const,
          evidenceCount: 3, validAt: '2026-02-28T00:00:00Z',
          invalidAt: null, supersededBy: null,          ttl: null, sourceChatId: null, sourceMessageId: null,
          createdAt: '2026-02-28T00:00:00Z', updatedAt: '2026-02-28T00:00:00Z',
          lastAccessedAt: null,
        },
      ];
      const stats = { fact: 5, preference: 3, state: 1, decision: 2, relation: 0 };

      const card = buildMemoryListCard(memories, 1, 3, stats, 'dev', 'user1');
      expect((card.header as any).title.content).toContain('1/3');

      const elements = card.elements as any[];
      const statsDiv = elements[0];
      expect(statsDiv.text.content).toContain('共 11 条');

      const found = elements.some((e: any) =>
        e.text?.content?.includes('Node 20'),
      );
      expect(found).toBe(true);
    });

    it('should show "暂无记忆记录" when empty', () => {
      const card = buildMemoryListCard([], 1, 1, {}, 'dev', 'user1');
      const elements = card.elements as any[];
      const emptyDiv = elements.find((e: any) =>
        e.text?.content?.includes('暂无记忆记录'),
      );
      expect(emptyDiv).toBeDefined();
    });

    it('should include prev/next buttons based on page', () => {
      const card = buildMemoryListCard([], 2, 3, { fact: 10 }, 'dev', 'user1');
      const elements = card.elements as any[];
      const actionElement = elements.find((e: any) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      const buttons = actionElement.actions as any[];
      const prevBtn = buttons.find((b: any) => b.text.content === '上一页');
      const nextBtn = buttons.find((b: any) => b.text.content === '下一页');
      expect(prevBtn).toBeDefined();
      expect(nextBtn).toBeDefined();
    });

    it('should not show prev button on first page', () => {
      const card = buildMemoryListCard([], 1, 3, { fact: 10 }, 'dev', 'user1');
      const elements = card.elements as any[];
      const actionElement = elements.find((e: any) => e.tag === 'action');
      const buttons = actionElement?.actions as any[] ?? [];
      const prevBtn = buttons.find((b: any) => b.text.content === '上一页');
      expect(prevBtn).toBeUndefined();
    });

    it('should not show next button on last page', () => {
      const card = buildMemoryListCard([], 3, 3, { fact: 10 }, 'dev', 'user1');
      const elements = card.elements as any[];
      const actionElement = elements.find((e: any) => e.tag === 'action');
      const buttons = actionElement?.actions as any[] ?? [];
      const nextBtn = buttons.find((b: any) => b.text.content === '下一页');
      expect(nextBtn).toBeUndefined();
    });
  });

  describe('buildMemorySearchCard', () => {
    it('should display query and results', () => {
      const results = [
        {
          memory: {
            id: 'mem1', agentId: 'dev', userId: 'user1', chatId: null,
            workspaceDir: null, type: 'fact' as const, content: 'TypeScript project',
            tags: [], metadata: {}, confidence: 0.7, confidenceLevel: 'L0' as const,
            evidenceCount: 1, validAt: '2026-02-28T00:00:00Z',
            invalidAt: null, supersededBy: null,            ttl: null, sourceChatId: null, sourceMessageId: null,
            createdAt: '2026-02-28T00:00:00Z', updatedAt: '2026-02-28T00:00:00Z',
            lastAccessedAt: null,
          },
          vectorScore: 0.8, bm25Score: 0.5, typeBoost: 1.0,
          recencyDecay: 0.95, finalScore: 0.76,
        },
      ];

      const card = buildMemorySearchCard(results, 'TypeScript', 'user1');
      expect((card.header as any).title.content).toContain('搜索结果');
      const elements = card.elements as any[];
      expect(elements[0].text.content).toContain('TypeScript');
      expect(elements[0].text.content).toContain('1 条结果');
    });

    it('should show empty message when no results', () => {
      const card = buildMemorySearchCard([], 'nonexistent', 'user1');
      const elements = card.elements as any[];
      const emptyDiv = elements.find((e: any) =>
        e.text?.content?.includes('未找到匹配的记忆'),
      );
      expect(emptyDiv).toBeDefined();
    });
  });

  describe('buildMemoryClearConfirmCard', () => {
    it('should show count and confirm/cancel buttons', () => {
      const card = buildMemoryClearConfirmCard(15, 'dev', 'user1');
      expect((card.header as any).template).toBe('red');
      const elements = card.elements as any[];
      expect(elements[0].text.content).toContain('15');
      const actionElement = elements.find((e: any) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      const buttons = actionElement.actions as any[];
      expect(buttons).toHaveLength(2);
      expect(buttons[0].value.action).toBe('memory_clear_confirm');
      expect(buttons[1].value.action).toBe('memory_cancel');
    });
  });

  describe('buildMemoryResultCard', () => {
    it('should show success with green template', () => {
      const card = buildMemoryResultCard('Done', true);
      expect((card.header as any).template).toBe('green');
    });

    it('should show failure with red template', () => {
      const card = buildMemoryResultCard('Error', false);
      expect((card.header as any).template).toBe('red');
    });
  });
});

// ============================================================
// handleMemoryCommand (slash command handler)
// ============================================================

describe('handleMemoryCommand', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-cmd-handler-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    store = new MemoryStore(db, new NoopEmbeddingProvider(1536));

    vi.clearAllMocks();
    mockIsMemoryEnabled.mockReturnValue(true);
    mockGetMemoryStore.mockReturnValue(store);
    mockGetHybridSearch.mockReturnValue(null);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should reply "记忆系统未启用" when disabled', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await handleMemoryCommand('', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith('msg1', '记忆系统未启用');
  });

  it('should send help text for /memory help', async () => {
    await handleMemoryCommand('help', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('/memory'),
    );
  });

  it('should send ephemeral card for /memory (list)', async () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'Test fact' });

    await handleMemoryCommand('', 'chat1', 'user1', 'msg1', undefined, 'dev');

    expect(mockFeishuClient.sendEphemeralCard).toHaveBeenCalled();
    const card = mockFeishuClient.sendEphemeralCard.mock.calls[0][2];
    expect((card.header as any).title.content).toContain('记忆管理');
  });

  it('should filter by type for /memory list fact', async () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'B' });

    await handleMemoryCommand('list fact', 'chat1', 'user1', 'msg1', undefined, 'dev');

    expect(mockFeishuClient.sendEphemeralCard).toHaveBeenCalled();
  });

  it('should accept Chinese type name for /memory list 偏好', async () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'Like TS' });

    await handleMemoryCommand('list 偏好', 'chat1', 'user1', 'msg1', undefined, 'dev');

    expect(mockFeishuClient.sendEphemeralCard).toHaveBeenCalled();
  });

  it('should reply error for unknown type', async () => {
    await handleMemoryCommand('list badtype', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('未知类型'),
    );
  });

  it('should reply in thread when threadReplyMsgId is provided', async () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    await handleMemoryCommand('', 'chat1', 'user1', 'msg1', 'thread1');

    expect(mockFeishuClient.replyTextInThread).toHaveBeenCalledWith('thread1', '记忆系统未启用');
    expect(mockFeishuClient.replyText).not.toHaveBeenCalled();
  });

  it('should delete memory with /memory delete', async () => {
    const mem = store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'Delete me' });

    await handleMemoryCommand(`delete ${mem.id}`, 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('已删除'),
    );
    expect(store.get(mem.id)).toBeUndefined();
  });

  it('should reply not found for /memory delete nonexistent', async () => {
    await handleMemoryCommand('delete nonexistent_id', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('不存在'),
    );
  });

  it('should reject deleting other users memory', async () => {
    const mem = store.create({ agentId: 'dev', userId: 'other_user', type: 'fact', content: 'Not yours' });

    await handleMemoryCommand(`delete ${mem.id}`, 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('无权'),
    );
    expect(store.get(mem.id)).toBeDefined();
  });

  it('should show usage for /memory delete without id', async () => {
    await handleMemoryCommand('delete', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('用法'),
    );
  });

  it('should send ephemeral clear confirm card for /memory clear', async () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'B' });

    await handleMemoryCommand('clear', 'chat1', 'user1', 'msg1', undefined, 'dev');

    expect(mockFeishuClient.sendEphemeralCard).toHaveBeenCalled();
    const card = mockFeishuClient.sendEphemeralCard.mock.calls[0][2];
    expect((card.header as any).template).toBe('red');
    expect((card.header as any).title.content).toContain('确认');
  });

  it('should reply no memories for /memory clear when empty', async () => {
    await handleMemoryCommand('clear', 'chat1', 'user1', 'msg1', undefined, 'dev');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('暂无'),
    );
  });

  it('should show usage for /memory search without keyword', async () => {
    await handleMemoryCommand('search', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('用法'),
    );
  });

  it('should reply unknown subcommand', async () => {
    await handleMemoryCommand('foo', 'chat1', 'user1', 'msg1');

    expect(mockFeishuClient.replyText).toHaveBeenCalledWith(
      'msg1',
      expect.stringContaining('未知子命令'),
    );
  });
});

// ============================================================
// handleMemoryCardAction (card button handler)
// ============================================================

describe('handleMemoryCardAction', () => {
  let db: MemoryDatabase;
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-action-'));
    db = await MemoryDatabase.create(join(tempDir, 'test.db'));
    store = new MemoryStore(db, new NoopEmbeddingProvider(1536));

    vi.clearAllMocks();
    mockIsMemoryEnabled.mockReturnValue(true);
    mockGetMemoryStore.mockReturnValue(store);
    mockGetHybridSearch.mockReturnValue(null);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should delete memory via memory_delete action', () => {
    const mem = store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'Hello' });

    const result = handleMemoryCardAction('memory_delete', { memoryId: mem.id, userId: 'user1' }, 'user1');

    expect((result.header as any)?.template).toBe('green');
    expect(store.get(mem.id)).toBeUndefined();
  });

  it('should reject delete by non-owner via card action (toast, no card change)', () => {
    const mem = store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'Hello' });

    const result = handleMemoryCardAction('memory_delete', { memoryId: mem.id, userId: 'user1' }, 'other_user');

    expect(result).toEqual({ toast: { type: 'error', content: '无权操作此卡片' } });
    expect(store.get(mem.id)).toBeDefined();
  });

  it('should handle non-existent memory in delete', () => {
    const result = handleMemoryCardAction('memory_delete', { memoryId: 'nonexistent', userId: 'user1' }, 'user1');

    expect((result.header as any)?.template).toBe('red');
  });

  it('should show clear confirm card via memory_clear_request', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'B' });

    const result = handleMemoryCardAction(
      'memory_clear_request',
      { agentId: 'dev', userId: 'user1' },
      'user1',
    );

    expect((result.header as any)?.template).toBe('red');
    expect((result.header as any)?.title?.content).toContain('确认');
  });

  it('should clear all memories via memory_clear_confirm', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'B' });

    const result = handleMemoryCardAction(
      'memory_clear_confirm',
      { agentId: 'dev', userId: 'user1' },
      'user1',
    );

    expect((result.header as any)?.template).toBe('green');
    const elements = result.elements as any[];
    expect(elements[0].text.content).toContain('2');

    const { total } = store.list('dev', 'user1');
    expect(total).toBe(0);
  });

  it('should reject clear by non-owner (toast, no card change)', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });

    const result = handleMemoryCardAction(
      'memory_clear_confirm',
      { agentId: 'dev', userId: 'user1' },
      'other_user',
    );

    expect(result).toEqual({ toast: { type: 'error', content: '无权操作此卡片' } });
    const { total } = store.list('dev', 'user1');
    expect(total).toBe(1);
  });

  it('should return page card via memory_page action', () => {
    for (let i = 0; i < 8; i++) {
      store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: `Memory ${i}` });
    }

    const result = handleMemoryCardAction(
      'memory_page',
      { page: 2, agentId: 'dev', userId: 'user1' },
      'user1',
    );

    expect((result.header as any)?.title?.content).toContain('2/2');
  });

  it('should return success card for memory_cancel', () => {
    const result = handleMemoryCardAction('memory_cancel', {}, 'user1');
    expect((result.header as any)?.template).toBe('green');
  });

  it('should reject page action by non-owner (toast, no card change)', () => {
    store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: 'A' });

    const result = handleMemoryCardAction(
      'memory_page',
      { page: 1, agentId: 'dev', userId: 'user1' },
      'other_user',
    );

    expect(result).toEqual({ toast: { type: 'error', content: '无权操作此卡片' } });
  });

  it('should preserve type filter across pagination', () => {
    for (let i = 0; i < 8; i++) {
      store.create({ agentId: 'dev', userId: 'user1', type: 'fact', content: `Fact ${i}` });
    }
    store.create({ agentId: 'dev', userId: 'user1', type: 'preference', content: 'Pref' });

    const result = handleMemoryCardAction(
      'memory_page',
      { page: 1, agentId: 'dev', userId: 'user1', type: 'fact' },
      'user1',
    );

    // Should show fact-filtered page, not all memories
    expect((result.header as any)?.title?.content).toContain('1/2');
  });

  it('should handle disabled memory system', () => {
    mockIsMemoryEnabled.mockReturnValue(false);

    const result = handleMemoryCardAction('memory_delete', { memoryId: 'x' }, 'user1');

    expect((result.header as any)?.template).toBe('red');
  });
});
