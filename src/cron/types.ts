/** Cron 调度模式 */
export type CronScheduleKind = 'cron' | 'every' | 'at';

/** Cron Job 调度配置 */
export interface CronSchedule {
  kind: CronScheduleKind;
  /** cron 表达式 (kind=cron) */
  expr?: string;
  /** 时区 (kind=cron) */
  tz?: string;
  /** 固定间隔毫秒 (kind=every) */
  everyMs?: number;
  /** 一次性执行 ISO 时间戳 (kind=at) */
  atTime?: string;
}

/** Cron Job 运行状态 */
export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'timeout';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
}

/** Cron Job 完整记录 */
export interface CronJob {
  id: string;
  name: string;
  chatId: string;
  userId: string;
  prompt: string;
  workingDir?: string;
  repoUrl?: string;

  schedule: CronSchedule;
  enabled: boolean;
  deleteAfterRun: boolean;

  // 执行配置
  timeoutSeconds: number;
  model?: string;
  maxBudgetUsd: number;
  agentId: string;

  // 话题绑定
  threadId?: string;
  threadRootMessageId?: string;
  contextSnapshot?: string;

  // 运行状态
  state: CronJobState;

  // 元数据
  createdAt: string;
  updatedAt: string;
}

/** 创建 Cron Job 的输入 */
export interface CronJobCreate {
  name: string;
  chatId: string;
  userId: string;
  prompt: string;
  workingDir?: string;
  repoUrl?: string;

  schedule: CronSchedule;
  enabled?: boolean;
  deleteAfterRun?: boolean;

  timeoutSeconds?: number;
  model?: string;
  maxBudgetUsd?: number;
  agentId?: string;

  threadId?: string;
  threadRootMessageId?: string;
  contextSnapshot?: string;
}

/** 更新 Cron Job 的补丁 */
export interface CronJobPatch {
  name?: string;
  prompt?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  timeoutSeconds?: number;
  model?: string;
  maxBudgetUsd?: number;
  threadId?: string | null;
  threadRootMessageId?: string | null;
  contextSnapshot?: string | null;
}

/** 执行记录 */
export interface CronRun {
  id: number;
  jobId: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: 'running' | 'ok' | 'error' | 'timeout';
  output?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  createdAt: string;
}

/** 执行记录创建输入 */
export interface CronRunCreate {
  jobId: string;
  startedAtMs: number;
  status: 'running';
}

/** 执行记录结果更新 */
export interface CronRunResult {
  status: 'ok' | 'error' | 'timeout';
  endedAtMs: number;
  output?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
}
