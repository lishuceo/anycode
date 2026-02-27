import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createWorkspaceMcpServer } from '../workspace/tool.js';
import { createFeishuToolsMcpServer } from '../feishu/tools/index.js';
import { isAutoWorkspacePath, isServiceOwnRepo } from '../workspace/isolation.js';
import type { ClaudeResult, ExecuteOptions, ProgressCallback, TurnInfo, ToolCallInfo, ImageAttachment, MultimodalContentBlock } from './types.js';

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

/** 工具名匹配（支持 glob 前缀：'mcp__*' 匹配所有 MCP 工具） */
function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  }
  return toolName.toLowerCase() === pattern.toLowerCase();
}

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
  /** 覆盖 system prompt（用于 pipeline 各角色独立 prompt 或 persona）。有值 → replace 模式；无 → append 模式 */
  systemPromptOverride?: string;
  /** 覆盖单步空闲超时秒数 (默认使用 CLAUDE_TIMEOUT 配置)。每收到一条 SDK 消息就重置，不限制总时长 */
  timeoutSeconds?: number;
  /** 硬性总超时秒数（从开始计时，不因活动重置）。适用于 routing 等必须快速完成的短任务 */
  hardTimeoutSeconds?: number;
  /** 图片附件（多模态输入） */
  images?: ImageAttachment[];
  /** 额外的 MCP servers（会合并到内部自动创建的 servers） */
  additionalMcpServers?: Record<string, ReturnType<typeof createWorkspaceMcpServer>>;
  /** 工具允许列表（在 readOnly/toolPolicy 基础上额外放行，支持 glob 前缀如 'mcp__*'） */
  toolAllow?: string[];
  /** 工具禁止列表（优先级最高，支持 glob 前缀） */
  toolDeny?: string[];
  /** 知识文件内容（注入到 system prompt 最前层，优先于 persona/workspace prompt） */
  knowledgeContent?: string;
}

/** 构建工作区管理系统提示词（注入实际目录路径） */
function buildWorkspaceSystemPrompt(workingDir?: string): string {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;
  const workspacesDir = config.workspace.baseDir;

  const basePrompt = `你正在通过飞书消息与用户交互。请保持回复简洁，适合在聊天消息中阅读。

## 目录结构

你需要知道以下几个关键目录：
- **项目目录**: \`${projectsDir}\` — 用户手动 clone 的项目都在这里
- **仓库缓存目录**: \`${cacheDir}\` — setup_workspace 自动缓存的 bare clone
- **可写工作区目录**: \`${workspacesDir}\` — setup_workspace 创建的隔离工作区

## 工作区管理

你当前的工作目录已经由系统预先设定好。**大多数情况下直接在当前目录工作即可**。

你有一个 setup_workspace 工具可用，但**仅在用户明确要求切换到另一个仓库或提供新的仓库 URL 时使用**。

**绝对不要用 setup_workspace 来切换当前工作区的模式（如从 readonly 切换到 writable）。** 当前工作区已经配置好了正确的权限，直接在当前目录工作即可。

调用 setup_workspace 时使用 mode="writable"。

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

  const feishuToolsGuide = config.feishu.tools.enabled ? `

## 飞书文档工具

你有以下飞书工具可用 (通过 mcp__feishu-tools__feishu_xxx 调用):

- **feishu_doc**: 读写飞书文档。用户消息中的文档链接 (如 https://xxx.feishu.cn/docx/TOKEN) 中提取 doc_token。
- **feishu_wiki**: 浏览知识库。链接格式: https://xxx.feishu.cn/wiki/TOKEN
- **feishu_drive**: 浏览云空间文件。
- **feishu_bitable**: 读写多维表格。链接格式: https://xxx.feishu.cn/base/TOKEN
- **feishu_chat_members**: 获取当前群聊的成员列表 (open_id + 姓名)。在需要了解群内有谁、@某人、分配任务时使用。

URL Token 提取规则:
- /docx/ABC123 → doc_token: ABC123
- /wiki/ABC123 → node_token: ABC123
- /drive/folder/ABC123 → folder_token: ABC123
- /base/ABC123 → app_token: ABC123` : '';

  const selfRepoGuide = (workingDir && isServiceOwnRepo(workingDir)) ? `

## 服务运行时信息（自改自模式）

你当前正在修改 anywhere-code 服务自身的代码。以下信息可帮助你查询运行日志、诊断问题：

- **PM2 进程名**: \`feishu-claude\`
- **当前 PID**: \`${process.pid}\`
- **服务部署目录**: \`${process.cwd()}\`
- **Node.js**: \`${process.version}\`

### 常用命令
- 查看最近日志: \`pm2 logs feishu-claude --lines 200 --nostream\`
- 仅看错误日志: \`pm2 logs feishu-claude --err --lines 100 --nostream\`
- 进程状态: \`pm2 show feishu-claude\`
- 实时日志（谨慎，会持续输出）: \`pm2 logs feishu-claude --lines 50\`（需 Ctrl+C 中断）

### 注意事项
- **重启服务会中断当前对话**，仅在用户明确要求时执行 \`pm2 restart feishu-claude\`
- 你的工作目录是服务仓库的隔离 clone，修改不会直接影响运行中的实例
- 日志是 JSON 格式（Pino），可用 \`| jq .\` 格式化或 \`| grep "关键词"\` 过滤` : '';

  return basePrompt + feishuToolsGuide + selfRepoGuide;
}

/**
 * 构建多模态 prompt（包含图片和文本的 AsyncIterable<SDKUserMessage>）
 * Agent SDK 的 query() 支持 `prompt: string | AsyncIterable<SDKUserMessage>`
 */
async function* buildMultimodalPrompt(
  text: string,
  images: ImageAttachment[],
): AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage> {
  // 构造 content blocks: 图片在前，文本在后
  const contentBlocks: MultimodalContentBlock[] = images.map(
    (img): MultimodalContentBlock => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    }),
  );

  contentBlocks.push({ type: 'text', text });

  // SDKUserMessage.message 为 MessageParam（来自 @anthropic-ai/sdk，未被 agent SDK 导出）
  // content 的运行时结构与 Anthropic API 规范一致，Zod 校验可通过
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: contentBlocks,
    },
    parent_tool_use_id: null,
    session_id: '',
  } as import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
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
      readOnly, images,
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

    // 硬性总超时：从开始计时，不因活动重置（适用于 routing 等短任务）
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    if (input.hardTimeoutSeconds) {
      const hardTimeoutMs = input.hardTimeoutSeconds * 1000;
      hardTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        logger.warn({ sessionKey, hardTimeoutMs, elapsedMs: Date.now() - startTime },
          'Claude query hard timeout — total execution time exceeded, aborting');
      }, hardTimeoutMs);
    }

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
      { sessionKey, workingDir, promptLength: prompt.length, resume: !!resumeSessionId, imageCount: images?.length ?? 0 },
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
    const mcpServers: Record<string, ReturnType<typeof createWorkspaceMcpServer>> = {};
    if (!disableWorkspaceTool) {
      mcpServers['workspace-manager'] = createWorkspaceMcpServer(onWorkspaceChangedWrapped);
    }
    if (config.feishu.tools.enabled) {
      // sessionKey 格式为 "chatId:userId"，提取 chatId 用于创建文档后自动授权群成员
      const chatId = sessionKey.split(':')[0] || undefined;
      const feishuMcp = createFeishuToolsMcpServer(chatId);
      if (feishuMcp) {
        mcpServers['feishu-tools'] = feishuMcp;
      }
    }

    // 合并调用方传入的额外 MCP servers（如 discussion-tools）
    if (input.additionalMcpServers) {
      Object.assign(mcpServers, input.additionalMcpServers);
    }

    // 构建 systemPrompt.append 内容
    // 注入层次：knowledge → persona/workspace prompt → 历史会话摘要
    // pipeline 模式使用独立的 system prompt，不需要工作区管理指引
    const baseAppend = systemPromptOverride ?? buildWorkspaceSystemPrompt(workingDir);
    const withKnowledge = input.knowledgeContent
      ? input.knowledgeContent + '\n\n' + baseAppend
      : baseAppend;
    const promptAppend = historySummaries
      ? withKnowledge + `\n\n## 历史会话摘要\n以下是该用户之前的会话记录，帮助你了解项目上下文：\n${historySummaries}`
      : withKnowledge;

    // 只读提示放入 user prompt（而非 system prompt），避免 per-user 差异导致 cache miss
    const readOnlyPrefix = readOnly
      ? '[系统提示：当前用户处于只读模式。你可以阅读和分析代码、回答问题，但不能修改文件或执行命令。不要尝试使用 Edit、Write、Bash 等工具。如果用户请求代码修改，告知他们需要管理员权限。]\n\n'
      : '';
    const effectivePrompt = readOnlyPrefix + prompt;

    // 构建 SDK query
    // 有图片时使用 AsyncIterable<SDKUserMessage> 多模态格式
    const promptInput = images?.length
      ? buildMultimodalPrompt(effectivePrompt, images)
      : effectivePrompt;

    const q = query({
      prompt: promptInput,
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
          // per-agent 工具禁止列表（优先级最高）
          if (input.toolDeny?.some(p => matchToolPattern(toolName, p))) {
            logger.info({ toolName }, 'canUseTool denied — agent toolDeny list');
            return { behavior: 'deny' as const, message: `工具 ${toolName} 被 agent 配置禁止。` };
          }
          // per-agent 工具允许列表（不可覆盖 readOnly 对写入工具和 MCP 写工具的限制）
          if (input.toolAllow?.some(p => matchToolPattern(toolName, p))) {
            if (readOnly && WRITE_TOOLS.has(toolName)) {
              logger.warn({ toolName }, 'canUseTool denied — toolAllow cannot override readOnly for write tools');
              return { behavior: 'deny' as const, message: '只读模式下 toolAllow 不能覆盖写入工具限制。' };
            }
            // readOnly 模式下 MCP 工具不能通过 toolAllow 绕过 — 交给后续 MCP readonly 白名单检查
            if (readOnly && toolName.startsWith('mcp__')) {
              logger.info({ toolName }, 'canUseTool — toolAllow matched MCP tool in readOnly mode, deferring to MCP readonly check');
              // fall through: 不 return，让后面的 MCP readonly 逻辑决定
            } else {
              logger.info({ toolName }, 'canUseTool allowed — agent toolAllow list');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
          }
          // 只读模式：拦截写入类工具
          if (readOnly && WRITE_TOOLS.has(toolName)) {
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。需要管理员权限才能修改文件或执行命令。' };
          }
          // 只读模式 MCP 工具权限：deny-by-default，仅放行已知只读 action
          if (readOnly && toolName.startsWith('mcp__')) {
            // 飞书工具：仅放行已知的只读 action 和只读工具（精确匹配 server 名，避免命名碰撞）
            if (toolName.startsWith('mcp__feishu-tools__')) {
              // feishu_chat_members 整体为只读工具（无 action 参数），精确匹配完整工具名
              if (toolName === 'mcp__feishu-tools__feishu_chat_members') {
                logger.info({ toolName, readOnly }, 'canUseTool allowed — read-only feishu_chat_members tool');
                return { behavior: 'allow' as const, updatedInput: inputObj };
              }
              const action = inputObj.action as string;
              const readOnlyActions = new Set([
                'read', 'list_blocks',                              // doc
                'list_spaces', 'list_nodes', 'get_node',            // wiki
                'list', 'info',                                     // drive
                'list_tables', 'list_fields', 'list_records', 'get_record', // bitable
              ]);
              if (readOnlyActions.has(action)) {
                logger.info({ toolName, action, readOnly }, 'canUseTool allowed — read-only feishu action');
                return { behavior: 'allow' as const, updatedInput: inputObj };
              }
            }
            // discussion-tools: Chat Agent 话题升级工具，readonly 下允许（精确匹配 server 名前缀）
            if (toolName.startsWith('mcp__discussion-tools__')) {
              logger.info({ toolName, readOnly }, 'canUseTool allowed — discussion tool in read-only mode');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
            // 所有其他 MCP 工具（含 workspace-manager、未来新增）以及不在 allow-list 的 feishu action：deny
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode (MCP tool)');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。' };
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

        // 系统提示词：
        // - 有 systemPromptOverride → replace 模式（chat persona / pipeline 角色）
        // - 无 systemPromptOverride → append 模式（dev agent 等保持 Claude Code 原味）
        systemPrompt: input.systemPromptOverride != null
          ? promptAppend
          : { type: 'preset', preset: 'claude_code', append: promptAppend },

        // 加载项目设置 (CLAUDE.md 等)；路由 agent 传 [] 避免加载
        settingSources: settingSourcesOverride ?? ['user', 'project'],

        // MCP 服务器：工作区管理工具 + 飞书工具 (空对象等同于无 MCP 服务器)
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
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
      if (hardTimer) clearTimeout(hardTimer);
      this.runningQueries.delete(sessionKey);

      const durationMs = Date.now() - startTime;
      const errorMsg = timedOut
        ? (input.hardTimeoutSeconds && durationMs >= input.hardTimeoutSeconds * 1000
          ? `Query hard timeout after ${input.hardTimeoutSeconds}s total execution time`
          : `Query idle timeout after ${idleTimeoutMs / 1000}s with no activity (total elapsed: ${Math.round(durationMs / 1000)}s)`)
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
    if (hardTimer) clearTimeout(hardTimer);

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
   * 中断某个 chat 下所有运行中的查询
   * 用于 /stop：per-thread 并行后一个 chat 可能有多个 running query
   *
   * 匹配逻辑适配 agent-prefixed key 格式:
   *   agent:{agentId}:{chatId}:{userId}:...
   *   routing:agent:{agentId}:{chatId}:...
   *   以及旧格式 {chatId}:{userId}:... (兼容)
   */
  killSessionsForChat(chatId: string, userId: string): void {
    const oldPrefix = `${chatId}:${userId}`;
    for (const [key, q] of this.runningQueries) {
      // 新格式：key 中包含 {chatId}:{userId}
      const matchesChat = key.includes(`${chatId}:${userId}`);
      // 旧格式兼容
      const matchesOld = key === oldPrefix || key.startsWith(oldPrefix + ':');
      // routing 前缀兼容
      const matchesRouting = key === `routing:${oldPrefix}` || key.startsWith(`routing:${oldPrefix}:`);

      if (matchesChat || matchesOld || matchesRouting) {
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
