import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isHoliday,
  isWorkday,
  isWeekend,
  shouldSkip,
  getLocalDateParts,
  _resetCacheForTests,
} from '../index.js';

/** Construct a UTC ms for a given Asia/Shanghai wall-clock date (UTC+8). */
function shanghaiMs(dateStr: string, hour = 12): number {
  // Shanghai is UTC+8 — subtract 8 hours from wall clock to get UTC.
  return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`).getTime() - 8 * 3600 * 1000;
}

describe('holidays', () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  describe('getLocalDateParts', () => {
    it('returns Shanghai-local date and weekday', () => {
      const parts = getLocalDateParts(shanghaiMs('2026-01-01'), 'Asia/Shanghai');
      expect(parts.date).toBe('2026-01-01');
      expect(parts.year).toBe(2026);
      expect(parts.weekday).toBe(4); // Thursday
    });

    it('handles year boundaries via timezone', () => {
      // UTC 2025-12-31 18:00 = Shanghai 2026-01-01 02:00
      const ms = new Date('2025-12-31T18:00:00Z').getTime();
      const parts = getLocalDateParts(ms, 'Asia/Shanghai');
      expect(parts.date).toBe('2026-01-01');
      expect(parts.year).toBe(2026);
    });
  });

  describe('isHoliday', () => {
    it('returns true for 元旦 2026-01-01', () => {
      expect(isHoliday(shanghaiMs('2026-01-01'))).toBe(true);
    });

    it('returns true for 春节 2026-02-17', () => {
      expect(isHoliday(shanghaiMs('2026-02-17'))).toBe(true);
    });

    it('returns false for 调休补班日 2026-02-28 (Saturday)', () => {
      expect(isHoliday(shanghaiMs('2026-02-28'))).toBe(false);
    });

    it('returns false for ordinary weekday', () => {
      expect(isHoliday(shanghaiMs('2026-03-10'))).toBe(false);
    });

    it('returns false for ordinary weekend (Saturday non-补班)', () => {
      expect(isHoliday(shanghaiMs('2026-03-07'))).toBe(false);
    });
  });

  describe('isWorkday', () => {
    it('false on legal holiday', () => {
      expect(isWorkday(shanghaiMs('2026-10-01'))).toBe(false);
    });

    it('true on 调休补班 weekend (2026-02-28 Saturday)', () => {
      expect(isWorkday(shanghaiMs('2026-02-28'))).toBe(true);
    });

    it('false on ordinary weekend', () => {
      expect(isWorkday(shanghaiMs('2026-03-07'))).toBe(false); // Saturday
      expect(isWorkday(shanghaiMs('2026-03-08'))).toBe(false); // Sunday
    });

    it('true on ordinary Monday', () => {
      expect(isWorkday(shanghaiMs('2026-03-09'))).toBe(true);
    });
  });

  describe('isWeekend', () => {
    it('true on ordinary Sunday', () => {
      expect(isWeekend(shanghaiMs('2026-03-08'))).toBe(true);
    });

    it('false on 调休补班 Saturday (treated as workday)', () => {
      expect(isWeekend(shanghaiMs('2026-02-28'))).toBe(false);
    });

    it('false on ordinary weekday', () => {
      expect(isWeekend(shanghaiMs('2026-03-10'))).toBe(false);
    });
  });

  describe('shouldSkip', () => {
    it('skips on holiday when skipHolidays=true', () => {
      const result = shouldSkip({ skipHolidays: true }, shanghaiMs('2026-10-01'));
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('holiday');
    });

    it('does not skip on holiday when skipHolidays=false', () => {
      expect(shouldSkip({ skipHolidays: false }, shanghaiMs('2026-10-01')).skip).toBe(false);
    });

    it('skips on weekend when skipWeekends=true', () => {
      const result = shouldSkip({ skipWeekends: true }, shanghaiMs('2026-03-08'));
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('weekend');
    });

    it('does not skip on 调休补班 Saturday when only skipWeekends=true', () => {
      // 2026-02-28 is a Saturday but a 调休 workday
      expect(shouldSkip({ skipWeekends: true }, shanghaiMs('2026-02-28')).skip).toBe(false);
    });

    it('holiday check takes precedence over weekend reason', () => {
      // 2026-10-01 is a Thursday and a holiday — should report holiday
      const result = shouldSkip({ skipHolidays: true, skipWeekends: true }, shanghaiMs('2026-10-01'));
      expect(result.reason).toBe('holiday');
    });

    it('does not skip when both flags false', () => {
      expect(shouldSkip({}, shanghaiMs('2026-10-01')).skip).toBe(false);
    });
  });

  describe('fail-open behavior for missing year data', () => {
    it('isHoliday returns false for year without data file', () => {
      // 2099 data file does not exist
      expect(isHoliday(shanghaiMs('2099-01-01'))).toBe(false);
    });

    it('shouldSkip returns no-skip for missing year', () => {
      expect(shouldSkip({ skipHolidays: true }, shanghaiMs('2099-01-01')).skip).toBe(false);
    });

    it('isWorkday still respects weekend for missing year', () => {
      // 2099-01-03 is Saturday
      expect(isWorkday(shanghaiMs('2099-01-03'))).toBe(false);
    });
  });
});
