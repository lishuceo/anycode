import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../utils/logger';
import type {
  ClaudeResult,
  ProgressCallback,
  StreamEvent,
  StreamInputMessage,
} from './types';

// ============================================================
// Claude Code 执行器
//
// 两种模式:
//   1. 长连接模式 (推荐): 使用 --input-format stream-json --output-format stream-json
//      保持一个持久进程，通过 stdin/stdout 双向流式 JSON 通信
//   2. 单次模式: 每次请求 spawn 一个 --print 进程
//
// 长连接模式优势:
//   - 复用进程，减少启动开销
//   - 天然保持对话上下文
//   - 支持实时流式输出
// ============================================================

/**
 * 长连接会话 —— 封装一个持久运行的 Claude Code 子进程
 */
export class ClaudeSession {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private sessionId?: string;
  private _isAlive = false;

  /** 当前是否有待完成的任务 */
  private pendingResolve?: (result: ClaudeResult) => void;
  private pendingStartTime?: number;
  private pendingOutput: string[] = [];
  private pendingProgress?: ProgressCallback;
  private pendingTimer?: ReturnType<typeof setTimeout>;

  constructor(
    public readonly workingDir: string,
    public readonly id: string,
  ) {}

  /** 进程是否存活 */
  get isAlive(): boolean {
    return this._isAlive && this.proc !== null && !this.proc.killed;
  }

  /** Claude Code 分配的 session_id */
  get claudeSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * 启动 Claude Code 长连接进程
   */
  start(): void {
    if (this.isAlive) return;

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',   // 在飞书场景下自动接受 (安全由我们的 security 层保障)
    ];

    logger.info({ workingDir: this.workingDir, id: this.id }, 'Starting Claude Code long-lived session');

    this.proc = spawn('claude', args, {
      cwd: this.workingDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._isAlive = true;

    // ----- stdout: 逐行解析 stream-json 事件 -----
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // ----- stderr: 日志 -----
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug({ sessionId: this.id, stderr: text }, 'Claude Code stderr');
      }
    });

    // ----- 进程退出 -----
    this.proc.on('close', (code) => {
      logger.info({ sessionId: this.id, code }, 'Claude Code session process exited');
      this._isAlive = false;
      this.proc = null;

      // 如果有 pending 任务，返回错误
      if (this.pendingResolve) {
        this.finishPending(false, undefined, `Process exited unexpectedly with code ${code}`);
      }
    });

    this.proc.on('error', (err) => {
      logger.error({ sessionId: this.id, err }, 'Claude Code process error');
      this._isAlive = false;
      if (this.pendingResolve) {
        this.finishPending(false, undefined, `Process error: ${err.message}`);
      }
    });
  }

  /**
   * 发送用户消息并等待 Claude Code 完成处理
   */
  async sendMessage(prompt: string, onProgress?: ProgressCallback): Promise<ClaudeResult> {
    if (!this.isAlive) {
      this.start();
    }

    if (!this.proc?.stdin?.writable) {
      return {
        success: false,
        output: '',
        error: 'Claude Code process stdin is not writable',
        durationMs: 0,
      };
    }

    // 等待上一个任务完成 (理论上由 queue 保证不会并发)
    if (this.pendingResolve) {
      return {
        success: false,
        output: '',
        error: 'Session is busy with another task',
        durationMs: 0,
      };
    }

    return new Promise<ClaudeResult>((resolve) => {
      this.pendingResolve = resolve;
      this.pendingStartTime = Date.now();
      this.pendingOutput = [];
      this.pendingProgress = onProgress;

      // 超时保护
      const timeoutMs = config.claude.timeoutSeconds * 1000;
      this.pendingTimer = setTimeout(() => {
        logger.warn({ sessionId: this.id, timeoutMs }, 'Task timed out');
        this.finishPending(false, undefined, undefined, true);
      }, timeoutMs);

      // 发送 stream-json 格式的用户消息
      const msg: StreamInputMessage = {
        type: 'user_message',
        content: prompt,
      };

      this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
      logger.debug({ sessionId: this.id, promptLength: prompt.length }, 'Sent message to Claude Code');
    });
  }

  /**
   * 终止进程
   */
  kill(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      logger.info({ sessionId: this.id }, 'Killed Claude Code session');
    }
    this._isAlive = false;

    if (this.pendingResolve) {
      this.finishPending(false, undefined, 'Session killed by user');
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 处理 stdout buffer，逐行解析 JSON 事件
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // 最后一个元素可能是不完整的行，留在 buffer 中
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        this.handleEvent(event);
      } catch {
        // 非 JSON 行，记录但不处理
        logger.trace({ line: trimmed }, 'Non-JSON line from Claude Code');
      }
    }
  }

  /**
   * 处理单个流式事件
   */
  private handleEvent(event: StreamEvent): void {
    // 提取 session_id
    if ('session_id' in event && event.session_id) {
      this.sessionId = event.session_id;
    }

    // 通知进度回调
    this.pendingProgress?.(event);

    switch (event.type) {
      case 'assistant': {
        const text = this.extractTextFromAssistant(event);
        if (text) {
          this.pendingOutput.push(text);
        }
        break;
      }

      case 'result': {
        // result 事件标志着本轮任务完成
        const resultText = this.extractResultText(event);
        if (resultText) {
          this.pendingOutput.push(resultText);
        }
        const isError = 'is_error' in event && event.is_error === true;
        this.finishPending(!isError);
        break;
      }

      case 'system':
      case 'tool_use':
      case 'tool_result':
        // 这些事件主要用于进度展示，文本已通过回调传递
        break;

      default:
        logger.debug({ eventType: (event as Record<string, unknown>).type }, 'Unknown stream event');
    }
  }

  /**
   * 从 assistant 事件中提取文本
   */
  private extractTextFromAssistant(event: StreamEvent): string {
    if (event.type !== 'assistant') return '';
    const { content } = event;

    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
    }
    return '';
  }

  /**
   * 从 result 事件中提取文本
   */
  private extractResultText(event: StreamEvent): string {
    if (event.type !== 'result') return '';
    const { result } = event;
    if (!result) return '';
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  /**
   * 完成当前 pending 任务
   */
  private finishPending(
    success: boolean,
    error?: string,
    errorMsg?: string,
    timedOut?: boolean,
  ): void {
    if (!this.pendingResolve) return;

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    const durationMs = Date.now() - (this.pendingStartTime || Date.now());
    const output = this.pendingOutput.join('\n').trim();
    const resolve = this.pendingResolve;

    // 清理 pending 状态
    this.pendingResolve = undefined;
    this.pendingStartTime = undefined;
    this.pendingOutput = [];
    this.pendingProgress = undefined;

    resolve({
      success: timedOut ? false : success,
      output,
      error: errorMsg || error,
      sessionId: this.sessionId,
      durationMs,
      timedOut,
    });
  }
}

// ============================================================
// 全局执行器 —— 管理所有 ClaudeSession
// ============================================================

export class ClaudeExecutor {
  private sessions = new Map<string, ClaudeSession>();

  /**
   * 获取或创建一个长连接会话
   */
  getOrCreateSession(sessionKey: string, workingDir: string): ClaudeSession {
    let session = this.sessions.get(sessionKey);

    if (session && session.isAlive && session.workingDir === workingDir) {
      return session;
    }

    // 如果工作目录变了或进程挂了，重建
    if (session) {
      session.kill();
      this.sessions.delete(sessionKey);
    }

    session = new ClaudeSession(workingDir, sessionKey);
    session.start();
    this.sessions.set(sessionKey, session);

    return session;
  }

  /**
   * 发送消息 (自动管理会话生命周期)
   */
  async execute(
    sessionKey: string,
    prompt: string,
    workingDir: string,
    onProgress?: ProgressCallback,
  ): Promise<ClaudeResult> {
    const session = this.getOrCreateSession(sessionKey, workingDir);
    return session.sendMessage(prompt, onProgress);
  }

  /**
   * 终止某个会话
   */
  killSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.kill();
      this.sessions.delete(sessionKey);
    }
  }

  /**
   * 终止所有会话
   */
  killAll(): void {
    for (const [key, session] of this.sessions) {
      session.kill();
      logger.info({ key }, 'Killed Claude Code session');
    }
    this.sessions.clear();
  }

  /**
   * 清理不活跃的会话
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (!session.isAlive) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

/** 全局单例 */
export const claudeExecutor = new ClaudeExecutor();
