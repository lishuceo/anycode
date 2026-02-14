import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ClaudeResult, ProgressCallback, StreamEvent } from './types';

/**
 * Claude Code 执行器
 * 通过子进程调用 Claude Code CLI
 */
export class ClaudeExecutor {
  private runningProcesses = new Map<string, ChildProcess>();

  /**
   * 执行 Claude Code 命令
   *
   * @param prompt       用户输入的指令
   * @param workingDir   工作目录
   * @param sessionId    会话 ID (用于续接对话)
   * @param onProgress   进度回调 (流式输出)
   * @returns            执行结果
   */
  async execute(
    prompt: string,
    workingDir: string,
    sessionId?: string,
    onProgress?: ProgressCallback,
  ): Promise<ClaudeResult> {
    const startTime = Date.now();
    const timeoutMs = config.claude.timeoutSeconds * 1000;

    // 构建命令参数
    const args = this.buildArgs(prompt, sessionId);

    logger.info(
      { workingDir, sessionId, argsCount: args.length },
      'Executing Claude Code',
    );

    return new Promise<ClaudeResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd: workingDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 记录运行中的进程，以支持中断
      const procKey = `${workingDir}:${Date.now()}`;
      this.runningProcesses.set(procKey, proc);

      let stdout = '';
      let stderr = '';
      let conversationId: string | undefined;
      let timedOut = false;

      // 超时处理
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logger.warn({ procKey, timeoutMs }, 'Claude Code execution timed out');
      }, timeoutMs);

      // 收集 stdout (stream-json 格式)
      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        // 尝试解析流式 JSON 事件
        if (onProgress) {
          this.parseStreamEvents(text, onProgress, (id) => {
            conversationId = id;
          });
        }
      });

      // 收集 stderr
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // 进程结束
      proc.on('close', (code) => {
        clearTimeout(timer);
        this.runningProcesses.delete(procKey);

        const durationMs = Date.now() - startTime;

        if (code === 0 || timedOut) {
          // 尝试从 stream-json 输出中提取最终文本
          const output = this.extractFinalOutput(stdout) || stdout;

          resolve({
            success: !timedOut && code === 0,
            output: output.trim(),
            conversationId,
            durationMs,
            timedOut,
          });
        } else {
          logger.error({ code, stderr }, 'Claude Code exited with error');
          resolve({
            success: false,
            output: stdout.trim(),
            error: stderr.trim() || `Process exited with code ${code}`,
            durationMs,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.runningProcesses.delete(procKey);
        logger.error({ err }, 'Failed to spawn Claude Code');
        resolve({
          success: false,
          output: '',
          error: `Failed to start Claude Code: ${err.message}`,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 终止所有运行中的进程
   */
  killAll(): void {
    for (const [key, proc] of this.runningProcesses) {
      proc.kill('SIGTERM');
      logger.info({ key }, 'Killed running Claude Code process');
    }
    this.runningProcesses.clear();
  }

  /**
   * 构建 CLI 参数
   */
  private buildArgs(prompt: string, sessionId?: string): string[] {
    const args: string[] = [
      '--print',                        // 非交互模式
      '--output-format', 'stream-json', // 流式 JSON 输出
      '--verbose',                      // 详细输出
    ];

    // 续接会话
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // 用户 prompt
    args.push(prompt);

    return args;
  }

  /**
   * 解析 stream-json 格式的事件
   */
  private parseStreamEvents(
    text: string,
    onProgress: ProgressCallback,
    onSessionId: (id: string) => void,
  ): void {
    const lines = text.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as StreamEvent;
        onProgress(event);

        // 提取 session_id
        if (event.session_id) {
          onSessionId(event.session_id);
        }
      } catch {
        // 非 JSON 行，忽略
      }
    }
  }

  /**
   * 从 stream-json 输出中提取最终的文本结果
   */
  private extractFinalOutput(rawOutput: string): string {
    const lines = rawOutput.split('\n').filter((l) => l.trim());
    const textParts: string[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // 提取 assistant 类型的文本内容
        if (event.type === 'assistant' && event.content) {
          if (typeof event.content === 'string') {
            textParts.push(event.content);
          } else if (Array.isArray(event.content)) {
            for (const block of event.content) {
              if (block.type === 'text' && block.text) {
                textParts.push(block.text);
              }
            }
          }
        }
        // 提取 result 类型
        if (event.type === 'result' && event.result) {
          textParts.push(
            typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          );
        }
      } catch {
        // 非 JSON 行，忽略
      }
    }

    return textParts.join('\n');
  }
}

/** 全局单例 */
export const claudeExecutor = new ClaudeExecutor();
