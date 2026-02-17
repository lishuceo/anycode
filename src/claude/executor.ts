import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ClaudeResult, ProgressCallback } from './types.js';

// ============================================================
// Claude Agent SDK 执行器
//
// 使用 @anthropic-ai/claude-agent-sdk 的 query() API
// 每次调用 query() 会 spawn 一个 Claude Code 子进程
// SDK 会自动管理工具执行、权限、流式输出等
// ============================================================

export class ClaudeExecutor {
  /** 运行中的 query 实例 (用于 abort) */
  private runningQueries = new Map<string, Query>();

  /**
   * 执行 Claude Agent SDK query
   *
   * @param sessionKey  会话标识 (chatId:userId)
   * @param prompt      用户输入的指令
   * @param workingDir  工作目录
   * @param resumeSessionId  可选：恢复之前的会话
   * @param onProgress  进度回调
   */
  async execute(
    sessionKey: string,
    prompt: string,
    workingDir: string,
    resumeSessionId?: string,
    onProgress?: ProgressCallback,
  ): Promise<ClaudeResult> {
    const startTime = Date.now();
    const abortController = new AbortController();

    // 确保工作目录存在，否则 spawn 会报 ENOENT
    if (!existsSync(workingDir)) {
      mkdirSync(workingDir, { recursive: true });
      logger.info({ workingDir }, 'Created working directory');
    }

    logger.info(
      { sessionKey, workingDir, promptLength: prompt.length, resume: !!resumeSessionId },
      'Executing Claude Agent SDK query',
    );

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
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          logger.info({ toolName, inputKeys: Object.keys(input) }, 'canUseTool called — auto allowing');
          return { behavior: 'allow' as const };
        },

        // 预算和限制
        maxTurns: 50,
        maxBudgetUsd: 5,

        // 会话续接
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),

        // 系统提示词：使用 Claude Code 默认 + 飞书场景附加
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: '你正在通过飞书消息与用户交互。请保持回复简洁，适合在聊天消息中阅读。',
        },

        // 加载项目设置 (CLAUDE.md 等)
        settingSources: ['project'],
      },
    });

    // 记录运行中的 query
    this.runningQueries.set(sessionKey, q);

    let output = '';
    let sessionId: string | undefined;
    let resultMessage: SDKMessage | undefined;

    try {
      // 遍历 SDK 流式消息
      for await (const message of q) {
        // 通知进度回调
        onProgress?.(message);

        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              sessionId = message.session_id;
              logger.info(
                { sessionId, model: message.model, tools: message.tools.length },
                'Claude session initialized',
              );
            }
            break;

          case 'assistant':
            // 提取文本输出
            if (message.message?.content) {
              for (const block of message.message.content) {
                if ('text' in block && block.text) {
                  output += block.text;
                }
              }
            }
            break;

          case 'result':
            resultMessage = message;
            break;

          default:
            // tool_progress, stream_event 等其他消息类型
            break;
        }
      }
    } catch (err) {
      this.runningQueries.delete(sessionKey);

      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ sessionKey, err: errorMsg }, 'Claude Agent SDK query error');

      return {
        success: false,
        output,
        error: errorMsg,
        sessionId,
        durationMs,
      };
    }

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
        };
      }
    }

    // 没有明确的 result 消息
    return {
      success: output.length > 0,
      output: output || '(无输出)',
      sessionId,
      durationMs,
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
