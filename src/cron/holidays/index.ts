import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

export interface HolidayDay {
  name: string;
  date: string;
  isOffDay: boolean;
}

interface HolidayYearFile {
  year: number;
  days: HolidayDay[];
}

interface YearIndex {
  offDays: Set<string>;
  workdayOverrides: Set<string>;
  loaded: boolean;
}

const yearCache = new Map<number, YearIndex>();
const missingYearWarned = new Set<number>();

function loadYear(year: number): YearIndex {
  const cached = yearCache.get(year);
  if (cached) return cached;

  const path = join(DATA_DIR, `${year}.json`);
  if (!existsSync(path)) {
    if (!missingYearWarned.has(year)) {
      logger.warn({ year, path }, 'holidays: data file missing — skip checks will fail-open for this year');
      missingYearWarned.add(year);
    }
    const empty: YearIndex = { offDays: new Set(), workdayOverrides: new Set(), loaded: false };
    yearCache.set(year, empty);
    return empty;
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as HolidayYearFile;
    const idx: YearIndex = {
      offDays: new Set(),
      workdayOverrides: new Set(),
      loaded: true,
    };
    for (const day of parsed.days ?? []) {
      if (day.isOffDay) idx.offDays.add(day.date);
      else idx.workdayOverrides.add(day.date);
    }
    yearCache.set(year, idx);
    return idx;
  } catch (err) {
    logger.error({ err, year, path }, 'holidays: failed to load data file');
    const empty: YearIndex = { offDays: new Set(), workdayOverrides: new Set(), loaded: false };
    yearCache.set(year, empty);
    return empty;
  }
}

/** 获取指定时区下 timestamp 对应的本地 YYYY-MM-DD 和 weekday (0=Sun..6=Sat) */
export function getLocalDateParts(nowMs: number, tz: string): { date: string; year: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = get('month');
  const day = get('day');
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get('weekday')] ?? 0;
  return { date: `${year}-${month}-${day}`, year, weekday };
}

/** 当天是否为法定放假日（含调休放假） */
export function isHoliday(nowMs: number, tz: string = 'Asia/Shanghai'): boolean {
  const { date, year } = getLocalDateParts(nowMs, tz);
  return loadYear(year).offDays.has(date);
}

/** 当天是否为工作日（中国式：考虑周末调休补班） */
export function isWorkday(nowMs: number, tz: string = 'Asia/Shanghai'): boolean {
  const { date, year, weekday } = getLocalDateParts(nowMs, tz);
  const idx = loadYear(year);
  if (idx.offDays.has(date)) return false;
  if (idx.workdayOverrides.has(date)) return true;
  return weekday !== 0 && weekday !== 6;
}

/** 当天是否为周末（不考虑调休补班，调休补班按工作日算） */
export function isWeekend(nowMs: number, tz: string = 'Asia/Shanghai'): boolean {
  const { date, year, weekday } = getLocalDateParts(nowMs, tz);
  if (weekday !== 0 && weekday !== 6) return false;
  const idx = loadYear(year);
  return !idx.workdayOverrides.has(date);
}

/** 综合判断 cron job 当前时刻是否应跳过执行 */
export function shouldSkip(
  opts: { skipHolidays?: boolean; skipWeekends?: boolean; tz?: string },
  nowMs: number = Date.now(),
): { skip: boolean; reason?: string } {
  const tz = opts.tz || 'Asia/Shanghai';
  if (opts.skipHolidays && isHoliday(nowMs, tz)) {
    return { skip: true, reason: 'holiday' };
  }
  if (opts.skipWeekends && isWeekend(nowMs, tz)) {
    return { skip: true, reason: 'weekend' };
  }
  return { skip: false };
}

/** Test helper — reset internal caches */
export function _resetCacheForTests(): void {
  yearCache.clear();
  missingYearWarned.clear();
}
