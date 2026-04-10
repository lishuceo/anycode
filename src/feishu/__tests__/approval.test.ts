// @ts-nocheck — test file
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

const mockSetThreadApproved = vi.fn();
const mockGetThreadSession = vi.fn();

vi.mock('../../session/manager.js', () => ({
  sessionManager: {
    setThreadApproved: (...args: unknown[]) => mockSetThreadApproved(...args),
    getThreadSession: (...args: unknown[]) => mockGetThreadSession(...args),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    security: { ownerUserId: 'owner-1' },
  },
}));

vi.mock('../../utils/security.js', () => ({
  isOwner: vi.fn((id: string) => id === 'owner-1'),
}));

const mockReplyText = vi.fn(() => Promise.resolve());
const mockReplyTextInThread = vi.fn(() => Promise.resolve());
const mockSendCard = vi.fn(() => Promise.resolve('card-msg-1'));
const mockReplyCardInThread = vi.fn(() => Promise.resolve('card-msg-2'));
const mockSendCardToUser = vi.fn(() => Promise.resolve('card-msg-3'));
const mockUpdateCard = vi.fn(() => Promise.resolve());
const mockGetUserName = vi.fn(() => Promise.resolve('Test User'));

vi.mock('../client.js', () => ({
  feishuClient: {
    replyText: (...args: unknown[]) => mockReplyText(...args),
    replyTextInThread: (...args: unknown[]) => mockReplyTextInThread(...args),
    sendCard: (...args: unknown[]) => mockSendCard(...args),
    replyCardInThread: (...args: unknown[]) => mockReplyCardInThread(...args),
    sendCardToUser: (...args: unknown[]) => mockSendCardToUser(...args),
    updateCard: (...args: unknown[]) => mockUpdateCard(...args),
    getUserName: (...args: unknown[]) => mockGetUserName(...args),
  },
  runWithAccountId: (_id: string, fn: () => void) => fn(),
}));

vi.mock('../message-builder.js', () => ({
  buildApprovalCard: vi.fn(() => ({ type: 'approval' })),
  buildApprovalResultCard: vi.fn(() => ({ type: 'approval_result' })),
}));

// Import after mocks
const {
  checkAndRequestApproval,
  resolveApproval,
  checkPreApproved,
  setOnApproved,
} = await import('../approval.js');

// ============================================================
// Tests
// ============================================================

describe('approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveApproval — preApproved fallback (Bug 1 regression)', () => {
    it('should persist approval via preApproved when thread session row does not exist', async () => {
      // Setup: no thread session in DB
      mockGetThreadSession.mockReturnValue(undefined);

      // Step 1: Request approval → creates pending entry
      const blocked = await checkAndRequestApproval(
        'user-2',
        'chat-2',
        'group',
        'test message',
        'msg-2',
        'default',
        'dev',
        undefined,
        undefined,
        'thread-2',
      );
      expect(blocked).toBe(false);

      // Step 2: Import handleApprovalCardAction to approve via card action
      const { handleApprovalCardAction } = await import('../approval.js');

      // Find the approvalId from the sendCard mock — the card was sent with the ID embedded
      // Actually, buildApprovalCard was called with the approvalId as first arg
      const { buildApprovalCard } = await import('../message-builder.js');
      const buildApprovalCardMock = buildApprovalCard as unknown as ReturnType<typeof vi.fn>;
      const approvalId = buildApprovalCardMock.mock.calls[buildApprovalCardMock.mock.calls.length - 1][0] as string;

      // Step 3: Register callback
      const onApproved = vi.fn();
      setOnApproved(onApproved);

      // Step 4: Owner approves via card action
      handleApprovalCardAction('approval_approve', approvalId, 'owner-1');

      // Step 5: Verify preApproved is set (the fix!)
      // After approval, checkPreApproved should return true for this user+chat
      const isPreApproved = checkPreApproved('chat-2', 'user-2');
      expect(isPreApproved).toBe(true);

      // Step 6: Verify setThreadApproved was also called (direct DB update attempt)
      expect(mockSetThreadApproved).toHaveBeenCalledWith('thread-2', true);

      // Step 7: Verify callback was invoked to re-queue the message
      expect(onApproved).toHaveBeenCalledWith(
        'chat-2', 'user-2', 'test message', 'msg-2', 'default', 'dev', undefined, 'thread-2',
      );
    });

    it('should also set preApproved when threadId is empty', async () => {
      // Setup: no ownerUserId bypass, no thread
      mockGetThreadSession.mockReturnValue(undefined);

      const blocked = await checkAndRequestApproval(
        'user-3',
        'chat-3',
        'p2p',
        'hi',
        'msg-3',
        'default',
        'dev',
        undefined,
        undefined,
        undefined, // no threadId
      );
      expect(blocked).toBe(false);

      const { handleApprovalCardAction } = await import('../approval.js');
      const { buildApprovalCard } = await import('../message-builder.js');
      const buildApprovalCardMock = buildApprovalCard as unknown as ReturnType<typeof vi.fn>;
      const approvalId = buildApprovalCardMock.mock.calls[buildApprovalCardMock.mock.calls.length - 1][0] as string;

      const onApproved = vi.fn();
      setOnApproved(onApproved);

      handleApprovalCardAction('approval_approve', approvalId, 'owner-1');

      // preApproved should be set
      const isPreApproved = checkPreApproved('chat-3', 'user-3');
      expect(isPreApproved).toBe(true);

      // setThreadApproved should NOT be called (no threadId)
      expect(mockSetThreadApproved).not.toHaveBeenCalled();
    });
  });

  describe('checkAndRequestApproval', () => {
    it('should bypass approval for owner', async () => {
      const result = await checkAndRequestApproval(
        'owner-1', 'chat-1', 'group', 'text', 'msg-1',
      );
      expect(result).toBe(true);
    });

    it('should bypass when thread is already approved in DB', async () => {
      mockGetThreadSession.mockReturnValue({ approved: true });
      const result = await checkAndRequestApproval(
        'user-1', 'chat-1', 'group', 'text', 'msg-1',
        'default', 'dev', undefined, undefined, 'thread-approved',
      );
      expect(result).toBe(true);
    });

    it('should block non-owner without approved thread', async () => {
      mockGetThreadSession.mockReturnValue(undefined);
      const result = await checkAndRequestApproval(
        'user-1', 'chat-1', 'group', 'text', 'msg-1',
        'default', 'dev', undefined, undefined, 'thread-new',
      );
      expect(result).toBe(false);
    });
  });
});
