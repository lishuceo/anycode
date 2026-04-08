/**
 * Agent 配置文件 Zod 校验 Schema
 *
 * 配置文件格式：{ defaults?, agents[] }
 * 借鉴 OpenClaw 的 defaults + per-agent overrides 模式
 */
import { z } from 'zod/v4';

// ─── Tool Policy ─────────────────────────────────────────────

/** 简单字符串格式（向后兼容） */
const ToolPolicySimpleSchema = z.enum(['all', 'readonly']);

/** 详细对象格式（按需扩展的 allow/deny 列表） */
const ToolPolicyDetailedSchema = z.object({
  /** 基础策略 */
  profile: z.enum(['all', 'readonly']).default('all'),
  /** 显式允许的工具名（在 profile 基础上额外放行） */
  allow: z.array(z.string()).optional(),
  /** 显式禁止的工具名（优先级高于 allow） */
  deny: z.array(z.string()).optional(),
});

/** toolPolicy 支持两种格式 */
export const ToolPolicySchema = z.union([ToolPolicySimpleSchema, ToolPolicyDetailedSchema]);

// ─── Agent 配置输入（用户填写，除 id 外全部 optional） ─────

export const AgentConfigInputSchema = z.object({
  /** Agent 标识（必填） */
  id: z.string().min(1),
  /** 显示名称 */
  displayName: z.string().optional(),
  /** 模型名称 */
  model: z.string().optional(),
  /** 工具策略 */
  toolPolicy: ToolPolicySchema.optional(),
  /** Settings 源 */
  settingSources: z.array(z.enum(['user', 'project'])).optional(),
  /** 单次 query 最大花费 (USD)，上限 1000 */
  maxBudgetUsd: z.number().positive().max(1000).optional(),
  /** 单次 query 最大轮次，上限 10000 */
  maxTurns: z.number().int().positive().max(10000).optional(),
  /** 是否需要写权限审批 */
  requiresApproval: z.boolean().optional(),
  /** 默认回复模式 */
  replyMode: z.enum(['direct', 'thread']).optional(),
  /** 人格提示词文件路径（每次 query 重新读取）。有 persona → replace 模式；无 → append 模式 */
  persona: z.string().optional(),
  /** 知识文件列表（相对于 knowledgeDir 的文件名）。agent 级完整覆盖 defaults */
  knowledge: z.array(z.string()).optional(),
  /** Bash 命令白名单正则（readOnly + toolAllow 含 Bash 时生效，仅匹配的命令被放行） */
  bashAllowPatterns: z.array(z.string()).optional(),
  /** 即使 readOnly 也允许 Edit/Write 的路径 glob 列表（相对于 cwd，如 "config/personas/*"） */
  editablePathPatterns: z.array(z.string()).optional(),
});

// ─── Defaults（全部 optional） ──────────────────────────────

export const AgentDefaultsSchema = z.object({
  model: z.string().optional(),
  toolPolicy: ToolPolicySchema.optional(),
  settingSources: z.array(z.enum(['user', 'project'])).optional(),
  maxBudgetUsd: z.number().positive().max(1000).optional(),
  maxTurns: z.number().int().positive().max(10000).optional(),
  requiresApproval: z.boolean().optional(),
  replyMode: z.enum(['direct', 'thread']).optional(),
  persona: z.string().optional(),
  knowledge: z.array(z.string()).optional(),
  editablePathPatterns: z.array(z.string()).optional(),
});

// ─── 顶层配置文件 ──────────────────────────────────────────

export const AgentConfigFileSchema = z.object({
  /** 知识文件根目录（相对于配置文件所在目录） */
  knowledgeDir: z.string().optional(),
  defaults: AgentDefaultsSchema.optional(),
  agents: z.array(AgentConfigInputSchema).min(1),
});

// ─── 导出类型 ──────────────────────────────────────────────

export type AgentConfigInput = z.infer<typeof AgentConfigInputSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type AgentConfigFile = z.infer<typeof AgentConfigFileSchema>;
export type ToolPolicyValue = z.infer<typeof ToolPolicySchema>;
export type ToolPolicyDetailed = z.infer<typeof ToolPolicyDetailedSchema>;
