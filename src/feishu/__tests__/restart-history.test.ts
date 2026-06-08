/**
 * Regression: workspace restart 路径必须重建完整 thread 历史。
 *
 * 失忆事件场景：
 * - 话题已有 N 条 turn（含 bot 卡片回复），SDK 端有 active session
 * - 用户新发消息触发 setup_workspace → restart
 * - S2 跨 cwd 启动，SDK 端无任何对话记忆
 * - 若 S2 prompt 不含完整历史，bot 会失忆
 *
 * 这里测试纯装配函数 assembleRestartPromptFromFullHistory：
 * 给定完整历史 fixture 和本轮 prompt，必须输出包含历史关键字的 prompt。
 */
// @ts-nocheck — test file
import { describe, it, expect, vi } from 'vitest';

// 为了能 import event-handler.ts（其依赖链巨大），需要提前 mock 所有 side-effect 模块
vi.mock('../client.js', () => ({
  feishuClient: {
    fetchRecentMessages: vi.fn(),
    getUserName: vi.fn(),
    replyText: vi.fn(),
    replyInThread: vi.fn(),
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    replyCardInThread: vi.fn(),
    sendText: vi.fn(),
  },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: {
    feishu: { encryptKey: '', verifyToken: '' },
    security: { allowedUserIds: [] },
    claude: { defaultWorkDir: '/tmp/work' },
    workspace: { baseDir: '/tmp/workspaces', branchPrefix: 'feat/test' },
    db: { pipelineDbPath: ':memory:' },
    agent: { bindings: [], groupConfigs: {} },
    chat: { historyMaxCount: 10, historyMaxChars: 8000 },
    memory: { enabled: false },
  },
  isMultiBotMode: vi.fn(() => false),
}));
vi.mock('../../claude/executor.js', () => ({
  claudeExecutor: { execute: vi.fn(), killSession: vi.fn() },
}));
vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    get: vi.fn(), getOrCreate: vi.fn(), setWorkingDir: vi.fn(),
    setStatus: vi.fn(), setConversationId: vi.fn(), setThread: vi.fn(),
    getThreadSession: vi.fn(), upsertThreadSession: vi.fn(),
    setThreadConversationId: vi.fn(), setThreadWorkingDir: vi.fn(),
    getRecentSummaries: vi.fn(() => []), saveSummary: vi.fn(), reset: vi.fn(),
  },
}));
vi.mock('../../session/queue.js', () => ({
  taskQueue: { enqueue: vi.fn(), dequeue: vi.fn(), complete: vi.fn(), pendingCount: vi.fn(() => 0), cancelPending: vi.fn(() => 0), isBusy: vi.fn(() => false) },
}));
vi.mock('../message-builder.js', () => ({
  buildProgressCard: vi.fn(), buildCombinedProgressCard: vi.fn(), buildStatusCard: vi.fn(),
}));
vi.mock('../../utils/security.js', () => ({
  isUserAllowed: vi.fn(() => true), containsDangerousCommand: vi.fn(() => false), isOwner: vi.fn(() => false),
}));
vi.mock('../../pipeline/store.js', () => ({
  pipelineStore: { get: vi.fn(), findPendingByChat: vi.fn(), tryStart: vi.fn() },
}));
vi.mock('../../pipeline/runner.js', () => ({
  createPendingPipeline: vi.fn(), startPipeline: vi.fn(),
  abortPipeline: vi.fn(), cancelPipeline: vi.fn(), retryPipeline: vi.fn(),
}));
vi.mock('../../agent/router.js', () => ({
  resolveAgent: vi.fn(() => 'dev'), shouldRespond: vi.fn(() => true),
}));
vi.mock('../../agent/registry.js', () => ({
  agentRegistry: { get: vi.fn(), getOrThrow: vi.fn(), allIds: vi.fn(() => []) },
}));
vi.mock('../multi-account.js', () => ({
  accountManager: { getAllBotOpenIds: vi.fn(() => new Set()), getBotOpenId: vi.fn() },
}));
vi.mock('../bot-registry.js', () => ({
  chatBotRegistry: { getBots: vi.fn(() => []), addBot: vi.fn(), removeBot: vi.fn(), clearChat: vi.fn() },
}));
vi.mock('../approval.js', () => ({
  checkAndRequestApproval: vi.fn(() => true),
  handleApprovalTextCommand: vi.fn(() => false),
  handleApprovalCardAction: vi.fn(),
  setOnApproved: vi.fn(),
}));
vi.mock('../thread-context.js', () => ({ resolveThreadContext: vi.fn() }));
vi.mock('../../agent/config-loader.js', () => ({
  readPersonaFile: vi.fn(), loadKnowledgeContent: vi.fn(),
}));
vi.mock('../../agent/tools/discussion.js', () => ({ createDiscussionMcpServer: vi.fn() }));
vi.mock('../oauth.js', () => ({
  generateAuthUrl: vi.fn(), hasCallbackUrl: vi.fn(), handleManualCode: vi.fn(),
}));
vi.mock('../../memory/injector.js', () => ({ injectMemories: vi.fn(() => '') }));
vi.mock('../../memory/extractor.js', () => ({ extractMemories: vi.fn() }));
vi.mock('../../memory/commands.js', () => ({
  handleMemoryCommand: vi.fn(), handleMemoryCardAction: vi.fn(),
}));
vi.mock('../../workspace/identity.js', () => ({ getRepoIdentity: vi.fn((p: string) => p) }));
vi.mock('../../utils/quick-ack.js', () => ({ generateQuickAck: vi.fn() }));
vi.mock('../../utils/thread-relevance.js', () => ({ checkThreadRelevance: vi.fn() }));
vi.mock('../../workspace/manager.js', () => ({ setupWorkspace: vi.fn() }));

import { assembleRestartPromptFromFullHistory, formatRestartImageHints } from '../event-handler.js';

describe('assembleRestartPromptFromFullHistory (restart history loss regression)', () => {
  const PROMPT_WITH_TIME = '[姜黎]: 把完整方案写到仓库文档里\n\n<msg-time>[01:09]</msg-time>';

  it('回归核心：dedup 已命中场景下,完整历史的关键内容必须出现在 restart prompt 里', () => {
    // 模拟 omt_1976a38de38f1bee 失忆场景:
    // - 话题前 10 条 turn 完整讨论了 "P0 Session Fork" 方案
    // - 本轮用户消息只是 "把方案写到仓库文档里"
    // - S1 dedup 命中（增量历史为空）,S2 必须靠完整 history.text 把前 10 条带回来
    const fullHistory = {
      text: [
        '[姜黎]: 我们来设计 P0 Session Fork 机制',
        '[DevBot]: 好的，初步方案如下：当话题历史超过 N 条时，自动 fork 到新话题',
        '[姜黎]: fork 的边界条件是什么？',
        '[DevBot]: 边界条件包括 token 限额和 turn 数限额',
        // ... 省略其余 turn，关键是 P0 Session Fork 在文本里
      ].join('\n\n'),
      fileTexts: undefined,
      historyImagePaths: undefined,
    };

    const result = assembleRestartPromptFromFullHistory(
      PROMPT_WITH_TIME, fullHistory, [],
    );

    // 核心断言：前 N 轮的关键讨论必须出现在 S2 prompt 中
    expect(result.prompt).toContain('P0 Session Fork');
    expect(result.prompt).toContain('fork 的边界条件');
    // 本轮 prompt 也必须在末尾保留
    expect(result.prompt).toContain('把完整方案写到仓库文档里');
    // 历史前置，本轮在后
    expect(result.prompt.indexOf('P0 Session Fork')).toBeLessThan(
      result.prompt.indexOf('把完整方案写到仓库文档里'),
    );
  });

  it('fileTexts 进一步前置在 history.text 之前', () => {
    const result = assembleRestartPromptFromFullHistory(
      PROMPT_WITH_TIME,
      {
        text: 'HISTORY-TEXT-BLOCK',
        fileTexts: ['FILE-A-CONTENT', 'FILE-B-CONTENT'],
      },
      [],
    );

    const idxFileA = result.prompt.indexOf('FILE-A-CONTENT');
    const idxFileB = result.prompt.indexOf('FILE-B-CONTENT');
    const idxHistory = result.prompt.indexOf('HISTORY-TEXT-BLOCK');
    const idxCurrent = result.prompt.indexOf('把完整方案写到仓库文档里');

    expect(idxFileA).toBeGreaterThanOrEqual(0);
    expect(idxFileA).toBeLessThan(idxFileB);
    expect(idxFileB).toBeLessThan(idxHistory);
    expect(idxHistory).toBeLessThan(idxCurrent);
  });

  it('history 图片合并到 imagePaths，且与已有路径去重，保持顺序', () => {
    const result = assembleRestartPromptFromFullHistory(
      PROMPT_WITH_TIME,
      {
        text: undefined,
        historyImagePaths: ['/img/a.png', '/img/b.png', '/img/c.png'],
      },
      ['/img/b.png', '/img/current.png'],
    );

    // 已有的在前，新加的去重后追加
    expect(result.imagePaths).toEqual([
      '/img/b.png', '/img/current.png', '/img/a.png', '/img/c.png',
    ]);
  });

  it('history 完全为空时,prompt 原样返回 promptWithTime', () => {
    const result = assembleRestartPromptFromFullHistory(
      PROMPT_WITH_TIME, {}, [],
    );

    expect(result.prompt).toBe(PROMPT_WITH_TIME);
    expect(result.imagePaths).toEqual([]);
  });

  it('formatRestartImageHints 能正确把 imagePaths 转成 Read 工具提示', () => {
    const hints = formatRestartImageHints(['/img/a.png', '/img/b.png']);
    expect(hints).toContain('/img/a.png');
    expect(hints).toContain('/img/b.png');
    expect(hints).toContain('Read');
  });
});
