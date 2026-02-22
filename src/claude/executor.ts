import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createWorkspaceMcpServer } from '../workspace/tool.js';
import { isAutoWorkspacePath } from '../workspace/isolation.js';
import type { ClaudeResult, ExecuteOptions, ProgressCallback, TurnInfo, ToolCallInfo } from './types.js';

// ============================================================
// Claude Agent SDK 执行器
//
// 使用 @anthropic-ai/claude-agent-sdk 的 query() API
// 每次调用 query() 会 spawn 一个 Claude Code 子进程
// SDK 会自动管理工具执行、权限、流式输出等
// ============================================================

/** 只读模式下禁止调用的写入类工具 */
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit', 'Bash', 'Skill',
]);

/** 执行 Claude query 的完整参数 */
export interface ExecuteInput extends ExecuteOptions {
  sessionKey: string;
  prompt: string;
  workingDir: string;
  resumeSessionId?: string;
  onProgress?: ProgressCallback;
  onWorkspaceChanged?: (newDir: string) => void;
  onStreamUpdate?: (text: string) => Promise<void>;
  onTurn?: (turn: TurnInfo) => Promise<void>;
  historySummaries?: string;
  /** 覆盖 system prompt（用于 pipeline 各角色独立 prompt） */
  systemPromptOverride?: string;
  /** 覆盖单步空闲超时秒数 (默认使用 CLAUDE_TIMEOUT 配置)。每收到一条 SDK 消息就重置，不限制总时长 */
  timeoutSeconds?: number;
}

/** 构建工作区管理系统提示词（注入实际目录路径） */
function buildWorkspaceSystemPrompt(): string {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;
  const workspacesDir = config.workspace.baseDir;

  return `你正在通过飞书消息与用户交互。请保持回复简洁，适合在聊天消息中阅读。

## 目录结构

你需要知道以下几个关键目录：
- **项目目录**: \`${projectsDir}\` — 用户手动 clone 的项目都在这里
- **仓库缓存目录**: \`${cacheDir}\` — setup_workspace 自动缓存的 bare clone
- **可写工作区目录**: \`${workspacesDir}\` — setup_workspace 创建的隔离工作区

## 工作区管理

你当前的工作目录已经由系统预先设定好。**大多数情况下直接在当前目录工作即可**。

你有一个 setup_workspace 工具可用，但仅在以下情况使用：
- 用户**明确要求**切换到另一个仓库
- 用户提供了新的仓库 URL 要求 clone

**不要主动使用 setup_workspace**，除非用户明确要求。当前工作目录通常就是正确的工作区。

模式选择 (mode 参数)：
- mode="readonly": 只读分析代码
- mode="writable": 修改代码、提交变更

**重要：调用 setup_workspace 后，系统将自动重启以加载项目配置（CLAUDE.md 等）。
请在调用后仅输出简短确认（如"工作区已就绪，正在重新加载项目配置..."），不要继续执行后续任务。**

## 自动开发流程

当用户给出明确的代码修改任务（写功能、修 bug、重构等）时，自动按以下流程执行：

1. 理解需求，确认工作目录和代码结构
2. 检查当前分支：\`git branch\`。如果在 main/master/develop 上，先创建特性分支：\`git checkout -b feat/<描述性名称>\`
3. 编写/修改代码
4. 发现项目测试命令（查看 package.json scripts、Makefile 等）并运行测试
   - 如果没有测试命令，跳过测试步骤并在报告中说明
5. 如果测试失败：分析错误 → 修复 → 重新测试
   - 最多重试 2 轮
   - 如果相同测试以相同方式连续失败 2 次，停止重试，向用户说明根因
6. 推送前预检：
   - \`git remote -v\` 确认 origin 存在
   - \`gh auth status\` 确认 GitHub CLI 已认证
   - 如果任一检查失败，跳过推送/PR 步骤，报告已完成的工作和需要手动处理的部分
7. 测试通过后：\`git add\` 相关文件 → \`git commit\` → \`git push -u origin\` → \`gh pr create\`
8. 最后汇报：改了什么、测试结果、PR 链接

规则：
- commit message 格式遵循项目约定（查看 git log --oneline -5 学习风格）
- 不要 git add . 或 git add -A，只添加本次变更的文件
- 不要提交 .env、credentials 等敏感文件
- 如果某步骤失败且无法自动修复，停下来向用户说明情况
- 如果用户只是提问、审查代码或做探索性修改，不需要走这个流程。不确定时问用户："需要我提交这些改动并创建 PR 吗？"`;
}

export class ClaudeExecutor {
  /** 运行中的 query 实例 (用于 abort) */
  private runningQueries = new Map<string, Query>();

  /**
   * 执行 Claude Agent SDK query
   */
  async execute(input: ExecuteInput): Promise<ClaudeResult> {
    const {
      sessionKey, prompt, workingDir, resumeSessionId,
      onProgress, onWorkspaceChanged, onStreamUpdate, onTurn, historySummaries,
      systemPromptOverride, disableWorkspaceTool, maxTurns, maxBudgetUsd,
      model: modelOverride, settingSources: settingSourcesOverride,
      readOnly,
    } = input;

    const startTime = Date.now();
    const abortController = new AbortController();
    const idleTimeoutMs = (input.timeoutSeconds ?? config.claude.timeoutSeconds) * 1000;
    let timedOut = false;

    // 滑动窗口 idle 超时：每收到一条 SDK 消息就重置计时器
    // 只在某一步长时间无活动时才 abort，不限制总执行时长
    let idleTimer: ReturnType<typeof setTimeout> = undefined!;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        logger.warn({ sessionKey, idleTimeoutMs, elapsedMs: Date.now() - startTime },
          'Claude query idle timeout — no SDK message received, aborting');
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    // 确保工作目录存在，否则 spawn 会报 ENOENT
    // 自动创建的工作区目录（WORKSPACE_BASE_DIR 下）不应在此处兜底创建：
    // 如果目录不存在说明已被清理，应由调用方（event-handler）检测并提示用户
    if (!existsSync(workingDir)) {
      if (isAutoWorkspacePath(workingDir)) {
        throw new Error(`工作区目录不存在（可能已被清理）: ${workingDir}`);
      }
      mkdirSync(workingDir, { recursive: true });
      logger.info({ workingDir }, 'Created working directory');
    }

    logger.info(
      { sessionKey, workingDir, promptLength: prompt.length, resume: !!resumeSessionId },
      'Executing Claude Agent SDK query',
    );

    // 跟踪 workspace 变更，用于 restart 信号
    let workspaceChanged = false;
    let newWorkingDir: string | undefined;

    const onWorkspaceChangedWrapped = onWorkspaceChanged
      ? (newDir: string) => {
          workspaceChanged = true;
          newWorkingDir = newDir;
          onWorkspaceChanged(newDir);
          // workspace 变更后立即 abort 当前 query，不再等它自然结束
          // event-handler 通过 needsRestart 用新 cwd 立即 restart
          abortController.abort();
          logger.info({ sessionKey, newDir }, 'Workspace changed — aborting query for immediate restart');
        }
      : undefined;

    // 每次 query 创建独立的 MCP 服务器实例，通过闭包绑定当前 session 的回调
    // 确保多 chat 并发执行时互不干扰
    // restart 时通过 disableWorkspaceTool 完全移除 setup_workspace，防止无限循环
    const mcpServers = disableWorkspaceTool
      ? undefined
      : { 'workspace-manager': createWorkspaceMcpServer(onWorkspaceChangedWrapped) };

    // 构建 systemPrompt.append 内容
    // pipeline 模式使用独立的 system prompt，不需要工作区管理指引
    const baseAppend = systemPromptOverride ?? buildWorkspaceSystemPrompt();
    const readOnlyNotice = readOnly
      ? `\n\n## 权限限制\n当前用户处于只读模式。你可以阅读和分析代码、回答问题，但不能修改文件或执行命令。不要尝试使用 Edit、Write、Bash 等工具。如果用户请求代码修改，告知他们需要管理员权限。`
      : '';
    const baseAppendWithHistory = historySummaries
      ? baseAppend + `\n\n## 历史会话摘要\n以下是该用户之前的会话记录，帮助你了解项目上下文：\n${historySummaries}`
      : baseAppend;
    const promptAppend = baseAppendWithHistory + readOnlyNotice;

    // 构建 SDK query
    const q = query({
      prompt,
      options: {
        cwd: workingDir,
        abortController,
        stderr: (data: string) => logger.warn({ stderr: data.trim() }, 'Claude Code stderr'),

        // 清除嵌套检测环境变量，允许从 Claude Code 会话内启动子进程
        env: (() => {
          const e = { ...process.env };
          delete e.CLAUDECODE;
          return e;
        })(),

        // 权限：acceptEdits 自动接受文件编辑，canUseTool 自动批准其余工具调用
        // 注意：不使用 bypassPermissions，因为 root 用户下会被拒绝
        permissionMode: 'acceptEdits',

        // 显式启用 Skill 工具 — SDK 默认不启用，必须通过 allowedTools 激活
        // 这样 .claude/skills/ 中的 SKILL.md 才能被加载和使用
        allowedTools: ['Skill'],
        canUseTool: async (toolName: string, inputObj: Record<string, unknown>) => {
          // 只读模式：拦截写入类工具
          if (readOnly && WRITE_TOOLS.has(toolName)) {
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。需要管理员权限才能修改文件或执行命令。' };
          }
          // MCP tool 名带前缀 (mcp__workspace-manager__setup_workspace)，也拦截
          if (readOnly && toolName.startsWith('mcp__')) {
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode (MCP tool)');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。需要管理员权限才能修改文件或执行命令。' };
          }
          logger.info({ toolName, inputKeys: Object.keys(inputObj) }, 'canUseTool called — auto allowing');
          // updatedInput 必须显式传回，否则 SDK 内部 Zod 校验会因 undefined 报错
          return { behavior: 'allow' as const, updatedInput: inputObj };
        },

        // 模型 + thinking + effort
        model: modelOverride ?? config.claude.model,
        thinking: config.claude.thinking === 'adaptive'
          ? { type: 'adaptive' as const }
          : { type: 'disabled' as const },
        effort: config.claude.effort,

        // 预算和限制 — 默认值从 config 读取，调用方可覆盖
        maxTurns: maxTurns ?? config.claude.maxTurns,
        maxBudgetUsd: maxBudgetUsd ?? config.claude.maxBudgetUsd,

        // 会话续接
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),

        // 系统提示词：使用 Claude Code 默认 + 飞书场景附加 + 工作区管理指引
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: promptAppend,
        },

        // 加载项目设置 (CLAUDE.md 等)；路由 agent 传 [] 避免加载
        settingSources: settingSourcesOverride ?? ['user', 'project'],

        // MCP 服务器：工作区管理工具 (restart 时为空对象，不注入 setup_workspace)
        mcpServers,
      },
    });

    // 记录运行中的 query
    this.runningQueries.set(sessionKey, q);

    let output = '';
    let sessionId: string | undefined;
    let resultMessage: SDKMessage | undefined;

    // 流式更新状态
    let lastStreamTime = Date.now();
    let lastStreamLen = 0;
    let lastStreamPromise: Promise<void> | undefined;
    let streamFailed = 0;

    // Turn 回调状态
    let turnIndex = 0;
    let turnFailed = 0;
    let lastTurnPromise: Promise<void> | undefined;

    try {
      // 遍历 SDK 流式消息
      for await (const message of q) {
        // 每收到消息重置 idle 计时器
        resetIdleTimer();

        // 通知进度回调
        onProgress?.(message);

        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              sessionId = message.session_id;
              logger.info(
                {
                  sessionId,
                  model: message.model,
                  tools: message.tools.length,
                  skills: message.skills,
                  slashCommands: message.slash_commands,
                },
                'Claude session initialized',
              );
            }
            break;

          case 'assistant': {
            // 提取文本输出和工具调用
            const turnText: string[] = [];
            const turnTools: ToolCallInfo[] = [];

            if (message.message?.content) {
              for (const block of message.message.content) {
                if ('text' in block && block.text) {
                  output += block.text;
                  turnText.push(block.text);
                }
                if ('type' in block && block.type === 'tool_use' && 'name' in block && 'input' in block) {
                  turnTools.push({ name: block.name as string, input: block.input as Record<string, unknown> });
                }
              }
            }

            // 逐条 turn 回调（新机制，连续失败 3 次后停止）
            if (onTurn && turnFailed < 3 && (turnText.length > 0 || turnTools.length > 0)) {
              turnIndex++;
              // 等待前一个 turn 完成再发，保证顺序
              if (lastTurnPromise) await lastTurnPromise.catch(() => {});
              lastTurnPromise = onTurn({ turnIndex, textContent: turnText.join(''), toolCalls: turnTools })
                .catch(() => { turnFailed++; });
            }

            // 旧流式卡片更新（pipeline 仍在用，节流：3秒 或 500字符，连续失败 3 次后停止）
            if (onStreamUpdate && streamFailed < 3) {
              const now = Date.now();
              const newChars = output.length - lastStreamLen;
              if (now - lastStreamTime >= 3000 || newChars >= 500) {
                lastStreamTime = now;
                lastStreamLen = output.length;
                lastStreamPromise = onStreamUpdate(output).catch(() => { streamFailed++; });
              }
            }
            break;
          }

          case 'result':
            resultMessage = message;
            break;

          default:
            // tool_progress, stream_event 等其他消息类型
            break;
        }
      }
    } catch (err) {
      clearTimeout(idleTimer);
      this.runningQueries.delete(sessionKey);

      const durationMs = Date.now() - startTime;
      const errorMsg = timedOut
        ? `Query idle timeout after ${idleTimeoutMs / 1000}s with no activity (total elapsed: ${Math.round(durationMs / 1000)}s)`
        : (err instanceof Error ? err.message : String(err));
      logger.error({ sessionKey, err: errorMsg, timedOut }, 'Claude Agent SDK query error');

      return {
        success: false,
        output,
        error: errorMsg,
        sessionId,
        durationMs,
        needsRestart: workspaceChanged,
        newWorkingDir,
      };
    }

    clearTimeout(idleTimer);

    // 等待最后一个回调完成，防止与最终卡片更新竞态
    if (lastTurnPromise) await lastTurnPromise.catch(() => {});
    if (lastStreamPromise) await lastStreamPromise.catch(() => {});

    this.runningQueries.delete(sessionKey);
    const durationMs = Date.now() - startTime;

    // 解析结果消息
    if (resultMessage && resultMessage.type === 'result') {
      if (resultMessage.subtype === 'success') {
        // 如果 output 为空但 result 有文本，使用 result
        if (!output && resultMessage.result) {
          output = resultMessage.result;
        }

        return {
          success: true,
          output,
          sessionId: resultMessage.session_id ?? sessionId,
          durationMs: resultMessage.duration_ms ?? durationMs,
          durationApiMs: resultMessage.duration_api_ms,
          costUsd: resultMessage.total_cost_usd,
          numTurns: resultMessage.num_turns,
          needsRestart: workspaceChanged,
          newWorkingDir,
        };
      } else {
        // 错误结果
        const errors = 'errors' in resultMessage ? resultMessage.errors : [];
        return {
          success: false,
          output,
          error: errors.join('\n') || `Query ended with: ${resultMessage.subtype}`,
          sessionId: resultMessage.session_id ?? sessionId,
          durationMs: resultMessage.duration_ms ?? durationMs,
          durationApiMs: resultMessage.duration_api_ms,
          costUsd: resultMessage.total_cost_usd,
          numTurns: resultMessage.num_turns,
          needsRestart: workspaceChanged,
          newWorkingDir,
        };
      }
    }

    // 没有明确的 result 消息
    return {
      success: output.length > 0,
      output: output || '(无输出)',
      sessionId,
      durationMs,
      needsRestart: workspaceChanged,
      newWorkingDir,
    };
  }

  /**
   * 中断某个会话的执行
   */
  killSession(sessionKey: string): void {
    const q = this.runningQueries.get(sessionKey);
    if (q) {
      q.close();
      this.runningQueries.delete(sessionKey);
      logger.info({ sessionKey }, 'Killed Claude Agent SDK query');
    }
  }

  /**
   * 中断某个 chat 下所有运行中的查询（匹配 sessionKey 前缀）
   * 用于 /stop：per-thread 并行后一个 chat 可能有多个 running query
   */
  killSessionsForChat(chatId: string, userId: string): void {
    const prefix = `${chatId}:${userId}`;
    for (const [key, q] of this.runningQueries) {
      if (key === prefix || key.startsWith(prefix + ':') || key === `routing:${prefix}` || key.startsWith(`routing:${prefix}:`)) {
        q.close();
        this.runningQueries.delete(key);
        logger.info({ sessionKey: key }, 'Killed Claude Agent SDK query');
      }
    }
  }

  /**
   * 中断所有运行中的查询
   */
  killAll(): void {
    for (const [key, q] of this.runningQueries) {
      q.close();
      logger.info({ key }, 'Killed Claude Agent SDK query');
    }
    this.runningQueries.clear();
  }

  /**
   * 清理 (no-op for SDK mode, queries auto-cleanup)
   */
  cleanup(): number {
    return 0;
  }
}

/** 全局单例 */
export const claudeExecutor = new ClaudeExecutor();
