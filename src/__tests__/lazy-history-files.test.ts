/**
 * Tests for lazy loading of parent chat files in history context.
 *
 * When buildDirectTaskHistory supplements thread messages with parent chat messages,
 * files from parent messages should NOT be auto-downloaded. Instead, only metadata
 * (filename, messageId, fileKey) is injected so the agent can fetch on-demand
 * via the feishu_download_message_file MCP tool.
 */
// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockDownloadMessageFile = vi.fn();

vi.mock('../feishu/client.js', () => ({
  feishuClient: {
    downloadMessageFile: (...args: unknown[]) => mockDownloadMessageFile(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _testDownloadHistoryFiles as downloadHistoryFiles } from '../feishu/event-handler.js';

// ============================================================
// Helpers
// ============================================================

function makeMsg(id: string, fileRefs?: Array<{ fileKey: string; fileName: string }>) {
  return { messageId: id, ...(fileRefs ? { fileRefs } : {}) };
}

describe('downloadHistoryFiles with parentMsgCount (lazy loading)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMessageFile.mockResolvedValue(Buffer.from('fake-pdf-content'));
  });

  it('downloads all files when parentMsgCount is 0 (default)', async () => {
    const messages = [
      makeMsg('m1', [{ fileKey: 'fk1', fileName: 'resume1.pdf' }]),
      makeMsg('m2', [{ fileKey: 'fk2', fileName: 'resume2.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages);

    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(2);
    expect(result.fileTexts).toHaveLength(0);
  });

  it('skips parent message files and outputs metadata instead', async () => {
    const messages = [
      // Parent message (index 0, within parentMsgCount=1)
      makeMsg('parent_msg', [{ fileKey: 'fk_parent', fileName: '简历_钱超逸.pdf' }]),
      // Thread message (index 1, beyond parentMsgCount)
      makeMsg('thread_msg', [{ fileKey: 'fk_thread', fileName: '陈卓维简历.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    // Only thread file should be downloaded
    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageFile).toHaveBeenCalledWith('thread_msg', 'fk_thread');

    // Thread file becomes a document
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].fileName).toBe('陈卓维简历.pdf');

    // Parent file becomes metadata text
    expect(result.fileTexts).toHaveLength(1);
    expect(result.fileTexts[0]).toContain('简历_钱超逸.pdf');
    expect(result.fileTexts[0]).toContain('parent_msg');
    expect(result.fileTexts[0]).toContain('fk_parent');
    expect(result.fileTexts[0]).toContain('feishu_download_message_file');
  });

  it('handles multiple parent files — all become metadata (within MAX_HISTORY_FILES limit)', async () => {
    // MAX_HISTORY_FILES is 3, so with 3 parent + 1 thread = 4 refs,
    // slice(-3) keeps [p2, p3, t1]. p1 is dropped by the limit.
    const messages = [
      makeMsg('p1', [{ fileKey: 'fk1', fileName: 'file1.pdf' }]),
      makeMsg('p2', [{ fileKey: 'fk2', fileName: 'file2.pdf' }]),
      makeMsg('p3', [{ fileKey: 'fk3', fileName: 'file3.pdf' }]),
      makeMsg('t1', [{ fileKey: 'fk4', fileName: 'thread_file.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 3);

    // Only thread file downloaded
    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageFile).toHaveBeenCalledWith('t1', 'fk4');

    // 2 parent files as metadata (p1 dropped by MAX_HISTORY_FILES=3 limit), 1 thread file as document
    expect(result.fileTexts).toHaveLength(2);
    expect(result.documents).toHaveLength(1);
  });

  it('keeps all files when within MAX_HISTORY_FILES limit', async () => {
    const messages = [
      makeMsg('p1', [{ fileKey: 'fk1', fileName: 'parent.pdf' }]),
      makeMsg('t1', [{ fileKey: 'fk2', fileName: 'thread.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    // Thread file downloaded, parent file as metadata
    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(1);
    expect(result.fileTexts).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
  });

  it('returns empty when no files in messages', async () => {
    const messages = [
      makeMsg('m1'),
      makeMsg('m2'),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    expect(mockDownloadMessageFile).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    expect(result.fileTexts).toHaveLength(0);
  });

  it('handles parent-only scenario (all files are parent)', async () => {
    const messages = [
      makeMsg('p1', [{ fileKey: 'fk1', fileName: 'resume.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    expect(mockDownloadMessageFile).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    expect(result.fileTexts).toHaveLength(1);
    expect(result.fileTexts[0]).toContain('resume.pdf');
  });

  it('handles thread-only scenario (parentMsgCount=0)', async () => {
    const messages = [
      makeMsg('t1', [{ fileKey: 'fk1', fileName: 'design.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 0);

    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(1);
    expect(result.documents).toHaveLength(1);
    expect(result.fileTexts).toHaveLength(0);
  });

  it('downloads text files from thread messages normally', async () => {
    mockDownloadMessageFile.mockResolvedValue(Buffer.from('console.log("hello")'));

    const messages = [
      makeMsg('p1', [{ fileKey: 'fk1', fileName: 'parent.ts' }]),
      makeMsg('t1', [{ fileKey: 'fk2', fileName: 'code.ts' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    // Only thread text file downloaded
    expect(mockDownloadMessageFile).toHaveBeenCalledTimes(1);
    expect(mockDownloadMessageFile).toHaveBeenCalledWith('t1', 'fk2');

    // Parent text file becomes metadata
    expect(result.fileTexts.some(t => t.includes('parent.ts') && t.includes('feishu_download_message_file'))).toBe(true);
    // Thread text file embedded normally
    expect(result.fileTexts.some(t => t.includes('console.log'))).toBe(true);
  });

  it('metadata includes correct messageId and fileKey for tool invocation', async () => {
    const messages = [
      makeMsg('om_abc123', [{ fileKey: 'file_xyz789', fileName: 'report.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    const meta = result.fileTexts[0];
    expect(meta).toContain('message_id="om_abc123"');
    expect(meta).toContain('file_key="file_xyz789"');
  });

  it('handles download failure for thread files gracefully', async () => {
    mockDownloadMessageFile.mockRejectedValue(new Error('network error'));

    const messages = [
      makeMsg('p1', [{ fileKey: 'fk1', fileName: 'parent.pdf' }]),
      makeMsg('t1', [{ fileKey: 'fk2', fileName: 'thread.pdf' }]),
    ];

    const result = await downloadHistoryFiles(messages, 1);

    // Parent file still gets metadata
    expect(result.fileTexts).toHaveLength(1);
    expect(result.fileTexts[0]).toContain('parent.pdf');
    // Thread file download failed silently
    expect(result.documents).toHaveLength(0);
  });
});
