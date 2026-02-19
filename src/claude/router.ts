import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { claudeExecutor } from './executor.js';
import { setupWorkspace } from '../workspace/manager.js';
import { sessionManager } from '../session/manager.js';

// ============================================================
// Routing Agent
//
// 轻量级 Claude Code 实例（Sonnet 4.6），在主查询启动前
// 决定当前 thread 应该在哪个工作目录下工作。
//
// 使用 Agent SDK 复用同一套基础设施，自主运行 ls/gh 等
// 命令发现本地缓存和 GitHub 账号下的仓库。
// ============================================================

/** 路由决策类型 */
export interface RoutingDecision {
  decision: 'use_existing' | 'clone_remote' | 'use_default' | 'need_clarification';
  workdir?: string;
  repo_url?: string;
  mode?: 'readonly' | 'writable';
  branch?: string;
  question?: string;
}

/** 构建路由 system prompt（注入实际目录路径） */
function buildRoutingSystemPrompt(): string {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;
  const workspacesDir = config.workspace.baseDir;

  return `你是一个工作区路由助手。你的唯一任务是决定用户的请求应该在哪个代码仓库/目录下执行。

## 你能做的事
- 运行 \`ls ${cacheDir}\` 查看本地已缓存的仓库
- 运行 \`ls ${projectsDir}\` 查看项目目录下的仓库
- 运行 \`ls ${workspacesDir}\` 查看已有的工作区
- 运行 \`ls <path>\` 验证本地路径是否存在
- 运行 \`gh repo list --json name,url,updatedAt --limit 50\` 查看 GitHub 账号下的仓库
- 如果信息不足，向用户提问（保持简短）

## 你不能做的事
- 不要开始执行用户的实际任务
- 不要修改任何文件
- 不要 clone 仓库（由系统负责）

## 查找顺序

当用户提到某个仓库或项目名时，按以下顺序查找：

1. **本地缓存** — \`ls ${cacheDir}\`，看有没有匹配的 bare clone
2. **项目目录** — \`ls ${projectsDir}\`，看有没有匹配的目录
3. **已有工作区** — \`ls ${workspacesDir}\`，看有没有之前创建的工作区
4. **GitHub 账号** — \`gh repo list --json name,url --limit 50\`，在用户的 GitHub 仓库中搜索匹配
5. 以上都找不到 → 如果用户给了 URL 则用 URL；否则向用户提问

## 输出格式

决策完成后，输出一个 JSON 代码块（且仅输出此 JSON）：

\`\`\`json
{
  "decision": "use_existing | clone_remote | use_default | need_clarification",
  "workdir": "/absolute/path",
  "repo_url": "https://...",
  "mode": "readonly | writable",
  "branch": "main",
  "question": "你的问题"
}
\`\`\`

字段说明：
- **use_existing**: 本地已有目标目录。必填 workdir（绝对路径）
- **clone_remote**: 本地没有，需要 clone。必填 repo_url 和 mode
- **use_default**: 不涉及特定仓库（通用问题、创建新项目、闲聊等）。无需额外字段
- **need_clarification**: 信息不足。必填 question

## 决策优先级
1. 消息中有明确 URL → clone_remote
2. 消息中有明确本地路径 → use_existing（验证路径存在）
3. 提到仓库名 → 按查找顺序在本地和 GitHub 账号中搜索
4. 不涉及特定仓库（通用问题、新项目、闲聊等）→ use_default
5. 涉及特定仓库但无法确定是哪个 → need_clarification

## 重要规则
- mode 判断：用户明确说要修改代码、提 PR、修 bug 时用 "writable"；只是看看、分析、提问时用 "readonly"
- 不确定 mode 时默认 "writable"（修改比只读更常见）
- branch 字段可选，不确定就不填
- 回复中只输出 JSON 代码块，不要输出其他内容`;
}

/** 构建路由 prompt（用户消息 + 历史摘要） */
function buildRoutingPrompt(userMessage: string, summaries: string[]): string {
  let prompt = userMessage;
  if (summaries.length > 0) {
    const summaryText = summaries.join('\n');
    prompt = `${userMessage}\n\n---\n[历史会话摘要，帮助你了解上下文]\n${summaryText}`;
  }
  return prompt;
}

/** 从 agent 输出中解析 JSON 决策 */
function parseRoutingDecision(output: string): RoutingDecision | null {
  // 尝试从 ```json ... ``` 代码块中提取
  const codeBlockMatch = output.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : output;

  // 尝试从文本中找到 JSON 对象（非贪婪，避免匹配多个 {} 时取到错误范围）
  const jsonMatch = jsonStr.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const decision = parsed.decision as string;

    if (!['use_existing', 'clone_remote', 'use_default', 'need_clarification'].includes(decision)) {
      return null;
    }

    // 关键字段类型校验：AI 可能返回非字符串值
    if (parsed.workdir !== undefined && typeof parsed.workdir !== 'string') return null;
    if (parsed.repo_url !== undefined && typeof parsed.repo_url !== 'string') return null;
    if (parsed.question !== undefined && typeof parsed.question !== 'string') return null;

    return {
      decision: decision as RoutingDecision['decision'],
      workdir: parsed.workdir as string | undefined,
      repo_url: parsed.repo_url as string | undefined,
      mode: parsed.mode as 'readonly' | 'writable' | undefined,
      branch: parsed.branch as string | undefined,
      question: parsed.question as string | undefined,
    };
  } catch {
    return null;
  }
}

/** 获取用户最近使用的 workdir（从 session_summaries 表），作为降级 fallback */
function getRecentWorkdir(chatId: string, userId: string): string {
  const summaries = sessionManager.getRecentSummaries(chatId, userId, 1);
  if (summaries.length > 0) {
    // summary 格式: "[date] [status] dir: /path/to/dir | ..."
    const dirMatch = summaries[0].match(/dir:\s*(\S+)/);
    if (dirMatch && dirMatch[1]) {
      return dirMatch[1];
    }
  }
  return config.claude.defaultWorkDir;
}

/** 检查路径是否在允许的目录范围内（防止 AI 返回敏感路径） */
function isPathAllowed(targetPath: string): boolean {
  try {
    const realPath = realpathSync(resolve(targetPath));
    const allowedDirs = [
      config.claude.defaultWorkDir,
      config.workspace.baseDir,
      config.repoCache.dir,
    ];
    return allowedDirs.some((base) => {
      const resolvedBase = existsSync(base) ? realpathSync(resolve(base)) : resolve(base);
      return realPath === resolvedBase || realPath.startsWith(resolvedBase + '/');
    });
  } catch {
    return false;
  }
}

/**
 * 执行路由决策
 *
 * 使用 Sonnet 4.6 的 Claude Code 实例，自主探索本地缓存和 GitHub 账号，
 * 决定当前 thread 应该在哪个工作目录下工作。
 */
export async function routeWorkspace(
  prompt: string,
  chatId: string,
  userId: string,
): Promise<RoutingDecision> {
  const summaries = sessionManager.getRecentSummaries(chatId, userId, 5);

  logger.info(
    { chatId, userId, promptLength: prompt.length, summaryCount: summaries.length },
    'Starting routing agent',
  );

  let result;
  try {
    result = await claudeExecutor.execute({
      sessionKey: `routing:${chatId}:${userId}`,
      prompt: buildRoutingPrompt(prompt, summaries),
      workingDir: config.claude.defaultWorkDir,
      systemPromptOverride: buildRoutingSystemPrompt(),
      disableWorkspaceTool: true,
      model: 'claude-sonnet-4-6',
      settingSources: [],
      maxTurns: 10,
      maxBudgetUsd: 0.5,
      timeoutSeconds: 60, // 路由不需要太长超时
    });
  } catch (err) {
    logger.error({ err, chatId, userId }, 'Routing agent execution failed');
    const fallbackDir = getRecentWorkdir(chatId, userId);
    return { decision: 'use_default', workdir: fallbackDir };
  }

  logger.info(
    { chatId, userId, success: result.success, costUsd: result.costUsd, durationMs: result.durationMs },
    'Routing agent completed',
  );

  if (!result.success || !result.output) {
    logger.warn({ chatId, userId, error: result.error }, 'Routing agent failed, using fallback');
    const fallbackDir = getRecentWorkdir(chatId, userId);
    return { decision: 'use_default', workdir: fallbackDir };
  }

  const decision = parseRoutingDecision(result.output);
  if (!decision) {
    logger.warn({ chatId, userId, output: result.output.slice(0, 500) }, 'Failed to parse routing decision, using fallback');
    const fallbackDir = getRecentWorkdir(chatId, userId);
    return { decision: 'use_default', workdir: fallbackDir };
  }

  logger.info({ chatId, userId, decision }, 'Routing decision');

  // 处理 clone_remote：执行 clone 并返回工作区路径
  if (decision.decision === 'clone_remote') {
    if (!decision.repo_url) {
      logger.warn({ chatId, userId }, 'clone_remote decision missing repo_url, using fallback');
      const fallbackDir = getRecentWorkdir(chatId, userId);
      return { decision: 'use_default', workdir: fallbackDir };
    }

    try {
      const workspace = setupWorkspace({
        repoUrl: decision.repo_url,
        mode: decision.mode ?? 'writable',
        sourceBranch: decision.branch,
      });
      // 验证 clone 结果路径在允许范围内（防止 symlink 等绕过）
      if (!isPathAllowed(workspace.workspacePath)) {
        logger.warn({ chatId, userId, workspacePath: workspace.workspacePath }, 'clone_remote result path outside allowed directories, using fallback');
        const fallbackDir = getRecentWorkdir(chatId, userId);
        return { decision: 'use_default', workdir: fallbackDir };
      }
      return { ...decision, workdir: workspace.workspacePath };
    } catch (err) {
      logger.error({ err, chatId, userId, repoUrl: decision.repo_url }, 'Failed to setup workspace from routing decision');
      const fallbackDir = getRecentWorkdir(chatId, userId);
      return { decision: 'use_default', workdir: fallbackDir };
    }
  }

  // use_default: 填充默认工作目录
  if (decision.decision === 'use_default') {
    return { ...decision, workdir: config.claude.defaultWorkDir };
  }

  // use_existing: 验证 workdir 非空 + 路径存在 + 在允许目录范围内
  if (decision.decision === 'use_existing') {
    if (!decision.workdir) {
      logger.warn({ chatId, userId }, 'use_existing decision missing workdir, using fallback');
      const fallbackDir = getRecentWorkdir(chatId, userId);
      return { decision: 'use_default', workdir: fallbackDir };
    }

    if (!existsSync(decision.workdir)) {
      logger.warn({ chatId, userId, workdir: decision.workdir }, 'use_existing workdir does not exist, using fallback');
      const fallbackDir = getRecentWorkdir(chatId, userId);
      return { decision: 'use_default', workdir: fallbackDir };
    }

    // 路径 allowlist：防止 AI 生成的路径指向敏感目录
    if (!isPathAllowed(decision.workdir)) {
      logger.warn({ chatId, userId, workdir: decision.workdir }, 'use_existing workdir outside allowed directories, using fallback');
      const fallbackDir = getRecentWorkdir(chatId, userId);
      return { decision: 'use_default', workdir: fallbackDir };
    }
  }

  // need_clarification: 验证 question 非空
  if (decision.decision === 'need_clarification' && !decision.question) {
    return {
      ...decision,
      question: '请提供更多信息，我需要知道你想要操作哪个仓库或项目。',
    };
  }

  return decision;
}
