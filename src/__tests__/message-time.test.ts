/**
 * Tests for formatCreateTime — 飞书消息时间戳格式化
 *
 * 将毫秒级时间戳字符串格式化为可读的时间前缀：
 * - 同一天: "[HH:MM]"
 * - 同年跨天: "[MM-DD HH:MM]"
 * - 跨年: "[YYYY-MM-DD HH:MM]"
 * - 使用 UTC+8 时区
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { _testFormatCreateTime as formatCreateTime } from '../feishu/event-handler.js';

// 固定 "当前时间" 为 2026-03-10 15:30:00 UTC+8 = 2026-03-10T07:30:00Z
const NOW_UTC = new Date('2026-03-10T07:30:00Z').getTime();

describe('formatCreateTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function withFakeNow(fn: () => void) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_UTC);
    fn();
  }

  it('returns undefined for missing or invalid input', () => {
    expect(formatCreateTime(undefined)).toBeUndefined();
    expect(formatCreateTime('')).toBeUndefined();
    expect(formatCreateTime('abc')).toBeUndefined();
    expect(formatCreateTime('0')).toBeUndefined();
  });

  it('formats same-day message as [HH:MM]', () => {
    withFakeNow(() => {
      // 2026-03-10 11:05:00 UTC+8 = 2026-03-10T03:05:00Z
      const ts = String(new Date('2026-03-10T03:05:00Z').getTime());
      expect(formatCreateTime(ts)).toBe('[11:05]');
    });
  });

  it('formats same-day message with zero-padded hours', () => {
    withFakeNow(() => {
      // 2026-03-10 08:03:00 UTC+8 = 2026-03-10T00:03:00Z
      const ts = String(new Date('2026-03-10T00:03:00Z').getTime());
      expect(formatCreateTime(ts)).toBe('[08:03]');
    });
  });

  it('formats cross-day same-year message as [MM-DD HH:MM]', () => {
    withFakeNow(() => {
      // 2026-03-09 22:30:00 UTC+8 = 2026-03-09T14:30:00Z
      const ts = String(new Date('2026-03-09T14:30:00Z').getTime());
      expect(formatCreateTime(ts)).toBe('[03-09 22:30]');
    });
  });

  it('formats cross-year message as [YYYY-MM-DD HH:MM]', () => {
    withFakeNow(() => {
      // 2025-12-31 23:59:00 UTC+8 = 2025-12-31T15:59:00Z
      const ts = String(new Date('2025-12-31T15:59:00Z').getTime());
      expect(formatCreateTime(ts)).toBe('[2025-12-31 23:59]');
    });
  });

  it('handles UTC+8 date boundary correctly (UTC is previous day but UTC+8 is same day)', () => {
    withFakeNow(() => {
      // "Now" is 2026-03-10 15:30 UTC+8
      // Message at 2026-03-10 00:30:00 UTC+8 = 2026-03-09T16:30:00Z
      // In UTC this is Mar 9, but in UTC+8 it's Mar 10 (same day as "now")
      const ts = String(new Date('2026-03-09T16:30:00Z').getTime());
      expect(formatCreateTime(ts)).toBe('[00:30]');
    });
  });
});
