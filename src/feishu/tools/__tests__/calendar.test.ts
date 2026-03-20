// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCalendarList = vi.fn();
const mockCalendarPrimary = vi.fn();
const mockEventList = vi.fn();
const mockEventGet = vi.fn();
const mockEventCreate = vi.fn();
const mockEventPatch = vi.fn();
const mockEventDelete = vi.fn();
const mockFreebusyList = vi.fn();
const mockAttendeeCreate = vi.fn();

vi.mock('../../client.js', () => ({
  feishuClient: {
    raw: {
      calendar: {
        calendar: {
          list: (...args: unknown[]) => mockCalendarList(...args),
          primary: (...args: unknown[]) => mockCalendarPrimary(...args),
        },
        calendarEvent: {
          list: (...args: unknown[]) => mockEventList(...args),
          get: (...args: unknown[]) => mockEventGet(...args),
          create: (...args: unknown[]) => mockEventCreate(...args),
          patch: (...args: unknown[]) => mockEventPatch(...args),
          delete: (...args: unknown[]) => mockEventDelete(...args),
        },
        calendarEventAttendee: {
          create: (...args: unknown[]) => mockAttendeeCreate(...args),
        },
        freebusy: {
          list: (...args: unknown[]) => mockFreebusyList(...args),
        },
      },
    },
  },
}));

const mockWithUserAccessToken = vi.fn((token: string) => ({ _userAccessToken: token }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  withUserAccessToken: (token: string) => mockWithUserAccessToken(token),
}));

let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => {
    capturedHandler = handler as typeof capturedHandler;
    return { name: _name, handler };
  },
}));

import { feishuCalendarTool, parseCalendarTime } from '../calendar.js';

const mockGetUserToken = vi.fn().mockResolvedValue('u-calendar-token');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserToken.mockResolvedValue('u-calendar-token');
  feishuCalendarTool(mockGetUserToken);
});

// ============================================================
// parseCalendarTime 单元测试
// ============================================================

describe('parseCalendarTime', () => {
  it('should return second-level timestamps as-is', () => {
    const ts = '1773532800';
    expect(parseCalendarTime(ts)).toBe('1773532800');
  });

  it('should convert millisecond timestamps to seconds', () => {
    expect(parseCalendarTime('1773532800123')).toBe('1773532800');
  });

  it('should reject out-of-range numeric strings', () => {
    expect(() => parseCalendarTime('20260315')).toThrow('无效的时间戳');
    expect(() => parseCalendarTime('999999999')).toThrow('无效的时间戳');
  });

  it('should parse date-only strings with +08:00 default timezone', () => {
    const result = parseCalendarTime('2026-03-20');
    // 2026-03-20T00:00:00+08:00 = 2026-03-19T16:00:00Z
    const expected = String(Math.floor(new Date('2026-03-20T00:00:00+08:00').getTime() / 1000));
    expect(result).toBe(expected);
  });

  it('should parse datetime without timezone as +08:00', () => {
    const result = parseCalendarTime('2026-03-20T10:00:00');
    const expected = String(Math.floor(new Date('2026-03-20T10:00:00+08:00').getTime() / 1000));
    expect(result).toBe(expected);
  });

  it('should parse datetime with explicit timezone', () => {
    const result = parseCalendarTime('2026-03-20T10:00:00+09:00');
    const expected = String(Math.floor(new Date('2026-03-20T10:00:00+09:00').getTime() / 1000));
    expect(result).toBe(expected);
  });

  it('should allow past dates (unlike parseDueDate)', () => {
    expect(() => parseCalendarTime('2020-01-01')).not.toThrow();
  });

  it('should handle whitespace trimming', () => {
    expect(parseCalendarTime('  1773532800  ')).toBe('1773532800');
  });

  it('should throw on invalid date strings', () => {
    expect(() => parseCalendarTime('not-a-date')).toThrow('无效的日期格式');
    expect(() => parseCalendarTime('')).toThrow();
  });
});

// ============================================================
// feishu_calendar tool 单元测试
// ============================================================

describe('feishu_calendar tool', () => {
  describe('no user token', () => {
    it('should return auth guidance when no user token', async () => {
      mockGetUserToken.mockResolvedValue(undefined);
      feishuCalendarTool(mockGetUserToken);
      const result = await capturedHandler({ action: 'list_calendars' });
      expect(result.content[0].text).toContain('/auth');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('list_calendars', () => {
    it('should list calendars', async () => {
      mockCalendarList.mockResolvedValue({
        code: 0,
        data: {
          calendar_list: [
            { calendar_id: 'CAL_001', summary: '我的日历', type: 'primary', role: 'owner' },
            { calendar_id: 'CAL_002', summary: '项目日历', type: 'shared', role: 'reader' },
          ],
          has_more: false,
        },
      });
      const result = await capturedHandler({ action: 'list_calendars' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.items[0].calendar_id).toBe('CAL_001');
      expect(parsed.items[0].is_primary).toBe(true);
      expect(parsed.items[1].is_primary).toBe(false);
    });

    it('should handle API errors', async () => {
      mockCalendarList.mockResolvedValue({ code: 99999, msg: 'forbidden' });
      const result = await capturedHandler({ action: 'list_calendars' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('99999');
    });
  });

  describe('list_events', () => {
    it('should list events within time range', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventList.mockResolvedValue({
        code: 0,
        data: {
          items: [
            {
              event_id: 'EVT_001',
              summary: '周一例会',
              start_time: { timestamp: '1773532800', timezone: 'Asia/Shanghai' },
              end_time: { timestamp: '1773536400', timezone: 'Asia/Shanghai' },
              status: 'confirmed',
              location: { name: '会议室A' },
            },
          ],
          has_more: false,
        },
      });
      const result = await capturedHandler({
        action: 'list_events',
        start_time: '1773532800',
        end_time: '1773619200',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.calendar_id).toBe('CAL_PRIMARY');
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].event_id).toBe('EVT_001');
      expect(parsed.items[0].summary).toBe('周一例会');
      expect(parsed.items[0].location).toBe('会议室A');
    });

    it('should use provided calendar_id', async () => {
      mockEventList.mockResolvedValue({
        code: 0,
        data: { items: [], has_more: false },
      });
      await capturedHandler({
        action: 'list_events',
        calendar_id: 'CAL_CUSTOM',
        start_time: '1773532800',
        end_time: '1773619200',
      });
      expect(mockEventList).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { calendar_id: 'CAL_CUSTOM' },
        }),
        expect.anything(),
      );
      expect(mockCalendarPrimary).not.toHaveBeenCalled();
    });

    it('should require start_time', async () => {
      const result = await capturedHandler({
        action: 'list_events',
        end_time: '1773619200',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('start_time');
    });

    it('should require end_time', async () => {
      const result = await capturedHandler({
        action: 'list_events',
        start_time: '1773532800',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('end_time');
    });
  });

  describe('get_event', () => {
    it('should get event details', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventGet.mockResolvedValue({
        code: 0,
        data: {
          event: {
            event_id: 'EVT_001',
            summary: '项目评审',
            description: '评审 Q1 进展',
          },
        },
      });
      const result = await capturedHandler({
        action: 'get_event',
        event_id: 'EVT_001',
      });
      expect(result.content[0].text).toContain('项目评审');
    });

    it('should require event_id', async () => {
      const result = await capturedHandler({ action: 'get_event' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('event_id');
    });
  });

  describe('create_event', () => {
    it('should create event with summary and time', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventCreate.mockResolvedValue({
        code: 0,
        data: {
          event: {
            event_id: 'EVT_NEW',
            summary: '新会议',
            start_time: { timestamp: '1773532800', timezone: 'Asia/Shanghai' },
            end_time: { timestamp: '1773536400', timezone: 'Asia/Shanghai' },
          },
        },
      });
      const result = await capturedHandler({
        action: 'create_event',
        summary: '新会议',
        start_time: '1773532800',
        end_time: '1773536400',
      });
      expect(result.content[0].text).toContain('EVT_NEW');
      expect(result.content[0].text).toContain('新会议');
      expect(result.content[0].text).toContain('日程已创建');
    });

    it('should create event with attendees', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventCreate.mockResolvedValue({
        code: 0,
        data: { event: { event_id: 'EVT_ATT', summary: '带参会人' } },
      });
      mockAttendeeCreate.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'create_event',
        summary: '带参会人',
        start_time: '1773532800',
        end_time: '1773536400',
        attendees: '[{"type": "user", "user_id": "ou_123"}]',
      });
      expect(result.content[0].text).toContain('EVT_ATT');
      expect(mockAttendeeCreate).toHaveBeenCalled();
    });

    it('should create all-day event', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventCreate.mockResolvedValue({
        code: 0,
        data: { event: { event_id: 'EVT_ALLDAY', summary: '全天' } },
      });
      await capturedHandler({
        action: 'create_event',
        summary: '全天',
        start_time: '2026-03-20',
        end_time: '2026-03-21',
        is_all_day: true,
      });
      const callData = mockEventCreate.mock.calls[0][0].data;
      expect(callData.start_time.date).toBe('2026-03-20');
      expect(callData.end_time.date).toBe('2026-03-21');
    });

    it('should require summary', async () => {
      const result = await capturedHandler({
        action: 'create_event',
        start_time: '1773532800',
        end_time: '1773536400',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('summary');
    });

    it('should require start_time', async () => {
      const result = await capturedHandler({
        action: 'create_event',
        summary: '会议',
        end_time: '1773536400',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('start_time');
    });

    it('should require end_time', async () => {
      const result = await capturedHandler({
        action: 'create_event',
        summary: '会议',
        start_time: '1773532800',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('end_time');
    });

    it('should reject invalid attendees JSON', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventCreate.mockResolvedValue({
        code: 0,
        data: { event: { event_id: 'EVT_X', summary: '测试' } },
      });
      const result = await capturedHandler({
        action: 'create_event',
        summary: '测试',
        start_time: '1773532800',
        end_time: '1773536400',
        attendees: 'not-json',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不是有效的 JSON');
    });
  });

  describe('update_event', () => {
    it('should update event', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventPatch.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'update_event',
        event_id: 'EVT_001',
        summary: '新标题',
      });
      expect(result.content[0].text).toBe('日程已更新');
    });

    it('should require event_id', async () => {
      const result = await capturedHandler({
        action: 'update_event',
        summary: '新标题',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('event_id');
    });
  });

  describe('delete_event', () => {
    it('should delete event', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventDelete.mockResolvedValue({ code: 0 });
      const result = await capturedHandler({
        action: 'delete_event',
        event_id: 'EVT_001',
      });
      expect(result.content[0].text).toBe('日程已删除');
    });

    it('should require event_id', async () => {
      const result = await capturedHandler({ action: 'delete_event' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('event_id');
    });

    it('should pass need_notification param', async () => {
      mockCalendarPrimary.mockResolvedValue({
        code: 0,
        data: { calendars: [{ calendar: { calendar_id: 'CAL_PRIMARY' } }] },
      });
      mockEventDelete.mockResolvedValue({ code: 0 });
      await capturedHandler({
        action: 'delete_event',
        event_id: 'EVT_001',
        need_notification: false,
      });
      expect(mockEventDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ need_notification: 'false' }),
        }),
        expect.anything(),
      );
    });
  });

  describe('freebusy', () => {
    it('should query freebusy for single user', async () => {
      mockFreebusyList.mockResolvedValue({
        code: 0,
        data: {
          freebusy_list: [
            { start_time: '1773532800', end_time: '1773536400' },
          ],
        },
      });
      const result = await capturedHandler({
        action: 'freebusy',
        start_time: '1773532800',
        end_time: '1773619200',
        user_ids: '["ou_123"]',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.freebusy_list).toHaveLength(1);
    });

    it('should require start_time', async () => {
      const result = await capturedHandler({
        action: 'freebusy',
        end_time: '1773619200',
        user_ids: '["ou_123"]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('start_time');
    });

    it('should require user_ids', async () => {
      const result = await capturedHandler({
        action: 'freebusy',
        start_time: '1773532800',
        end_time: '1773619200',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('user_ids');
    });

    it('should reject invalid user_ids JSON', async () => {
      const result = await capturedHandler({
        action: 'freebusy',
        start_time: '1773532800',
        end_time: '1773619200',
        user_ids: 'not-json',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不是有效的 JSON');
    });

    it('should reject non-string user_ids elements', async () => {
      const result = await capturedHandler({
        action: 'freebusy',
        start_time: '1773532800',
        end_time: '1773619200',
        user_ids: '[123, 456]',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('字符串');
    });
  });

  describe('token validation', () => {
    it('should reject invalid calendar_id', async () => {
      const result = await capturedHandler({
        action: 'list_events',
        calendar_id: '../bad/path',
        start_time: '1773532800',
        end_time: '1773619200',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 calendar_id');
    });

    it('should reject invalid event_id', async () => {
      const result = await capturedHandler({
        action: 'get_event',
        event_id: '../bad/path',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('无效的 event_id');
    });
  });

  describe('error handling', () => {
    it('should handle thrown exceptions', async () => {
      mockCalendarList.mockRejectedValue(new Error('network error'));
      const result = await capturedHandler({ action: 'list_calendars' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('network error');
    });

    it('should extract Feishu API error from AxiosError', async () => {
      const axiosErr = new Error('Request failed');
      (axiosErr as unknown as Record<string, unknown>).response = {
        data: { code: 233009, msg: 'No calendar permission' },
      };
      mockCalendarList.mockRejectedValue(axiosErr);
      const result = await capturedHandler({ action: 'list_calendars' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('233009');
      expect(result.content[0].text).toContain('No calendar permission');
    });
  });
});
