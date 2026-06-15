/**
 * /compact reply formatting tests
 *
 * formatCompactReply / formatTokenCount turn a CompactResult into the Feishu
 * text reply. Pure functions — imported directly with no mocks (same pattern
 * as document-dedup.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatCompactReply, formatTokenCount } from '../event-handler.js';
import type { CompactResult } from '../../claude/types.js';

describe('formatTokenCount', () => {
  it('keeps small numbers as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(800)).toBe('800');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('renders thousands compactly', () => {
    expect(formatTokenCount(1351)).toBe('1.4k');
    expect(formatTokenCount(40445)).toBe('40.4k');
    expect(formatTokenCount(776142)).toBe('776.1k');
  });
});

describe('formatCompactReply', () => {
  const base: CompactResult = { success: false, durationMs: 0 };

  it('shows token reduction on success', () => {
    const msg = formatCompactReply({ ...base, success: true, preTokens: 40445, postTokens: 1351 });
    expect(msg).toContain('✅');
    expect(msg).toContain('40.4k');
    expect(msg).toContain('1.4k');
    expect(msg).toContain('↓97%'); // 1 - 1351/40445 ≈ 0.967
  });

  it('falls back to a plain success message when tokens are missing', () => {
    const msg = formatCompactReply({ ...base, success: true });
    expect(msg).toBe('✅ 上下文已压缩。');
  });

  it('reports noop gently (not an error)', () => {
    const msg = formatCompactReply({ ...base, noop: true });
    expect(msg).toContain('ℹ️');
    expect(msg).toContain('无需压缩');
    expect(msg).not.toContain('❌');
  });

  it('reports real failure with the error text', () => {
    const msg = formatCompactReply({ ...base, error: 'API overloaded' });
    expect(msg).toContain('❌');
    expect(msg).toContain('API overloaded');
  });

  it('handles failure with no error string', () => {
    const msg = formatCompactReply({ ...base });
    expect(msg).toContain('❌');
    expect(msg).toContain('未知错误');
  });
});
