import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createWorkspaceMcpServer } from '../workspace/tool.js';
import { createFeishuToolsMcpServer } from '../feishu/tools/index.js';
import { createMemorySearchMcpServer } from '../memory/tools/memory-search.js';
import { getMemoryStore, getHybridSearch, isMemoryEnabled } from '../memory/init.js';
import { createCronMcpServer } from '../cron/tool.js';
import { getCronScheduler } from '../cron/init.js';
import { feishuClientContext } from '../feishu/client.js';
import { isAutoWorkspacePath, isServiceOwnRepo, isInsideSourceRepo } from '../workspace/isolation.js';
import type { ClaudeResult, ExecuteOptions, ProgressCallback, TurnInfo, ToolCallInfo, ImageAttachment, DocumentAttachment, MultimodalContentBlock, ConversationTurn, ToolCallTrace } from './types.js';

// ============================================================
// Claude Agent SDK 执行器
//
// 使用 @anthropic-ai/claude-agent-sdk 的 query() API
// 每次调用 query() 会 spawn 一个 Claude Code 子进程
// SDK 会自动管理工具执行、权限、流式输出等
// ============================================================

// Anthropic API 定价（per million tokens）
// https://docs.anthropic.com/en/docs/about-claude/pricing
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-6':          { input: 5,   output: 25,  cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-5-20250620': { input: 5,   output: 25,  cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-4-6':        { input: 3,   output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5-20241022': { input: 3, output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,   cacheWrite: 1.25,  cacheRead: 0.10 },
};
const DEFAULT_PRICING = MODEL_PRICING['claude-opus-4-6']!;

/**
 * 用顶层 usage 字段计算本次 query 的实际费用。
 *
 * SDK 的 total_cost_usd / modelUsage 在 resume 首次 query 时会混入历史累计值，
 * 而顶层 usage 仅包含本次 query 的 token 用量，因此自行按定价计算更准确。
 *
 * 当 usage 和 modelUsage 一致时（无 subagent、非首次 resume），计算结果 ≈ total_cost_usd。
 * 当出现累计偏差时，本函数返回更合理的单次费用。
 */
function calculateCostFromUsage(
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number },
  modelUsage: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>,
): number {
  // 优先尝试：如果顶层 usage 和 modelUsage 的主模型一致（非累计偏差场景），直接用 SDK 报告的 costUSD
  const models = Object.keys(modelUsage);
  if (models.length === 1) {
    const mu = modelUsage[models[0]!]!;
    if (
      mu.inputTokens === usage.input_tokens &&
      mu.outputTokens === usage.output_tokens &&
      mu.cacheCreationInputTokens === usage.cache_creation_input_tokens &&
      mu.cacheReadInputTokens === usage.cache_read_input_tokens
    ) {
      return mu.costUSD;
    }
  }

  // 存在偏差（resume 首次 query 或 subagent）：用顶层 usage 按定价计算
  // 取 modelUsage 中主模型（cost 最高的那个）的定价
  let pricing = DEFAULT_PRICING;
  let maxCost = 0;
  for (const [model, mu] of Object.entries(modelUsage)) {
    if (mu.costUSD > maxCost) {
      maxCost = mu.costUSD;
      pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
    }
  }

  const M = 1_000_000;
  return (
    (usage.input_tokens * pricing.input) / M +
    (usage.output_tokens * pricing.output) / M +
    (usage.cache_creation_input_tokens * pricing.cacheWrite) / M +
    (usage.cache_read_input_tokens * pricing.cacheRead) / M
  );
}

/** 只读模式下禁止调用的写入类工具 */
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit', 'Bash', 'Skill',
]);

/** 源仓库保护拦截提示 */
const SOURCE_REPO_DENY_MSG = '源仓库保护：目标位于 DEFAULT_WORK_DIR 下的源仓库，禁止直接修改。请使用 setup_workspace 工具创建隔离工作区后再修改。';

/** shell 元字符 + 换行 + 重定向（阻止链式执行和文件重定向） */
const SHELL_META_RE = /[;|&`$\n>]|\$\(/;

/** 写入类 Bash 命令 denylist（使用 m flag 支持多行命令逐行匹配） */
const BASH_WRITE_DENY = /^\s*(git\s+(commit|push|reset|rebase|merge|cherry-pick|am|apply|checkout\s+--|add\s|clean\s|branch\s+-[dD]|stash\s+(drop|clear|pop))|rm\s|rmdir\s|mv\s|cp\s|mkdir\s|touch\s|chmod\s|chown\s|ln\s|sed\s+-i|tee\s|dd\s|truncate\s)/m;

/**
 * 源仓库保护检查（系统安全机制，优先级高于 toolAllow）。
 * 阻止 agent 直接修改 DEFAULT_WORK_DIR 下的源仓库文件。
 * workspace-manager MCP 工具始终放行。
 *
 * @returns deny 结果，或 null 表示放行
 */
function checkSourceRepoProtection(
  toolName: string,
  inputObj: Record<string, unknown>,
  workingDir?: string,
  inplaceEdit?: boolean,
): { behavior: 'deny'; message: string } | null {
  // /edit 原地编辑模式：OWNER 主动 opt-in，跳过源仓库保护
  if (inplaceEdit) return null;

  // workspace-manager MCP 工具始终放行（setup_workspace / update_repo_registry）
  if (toolName.startsWith('mcp__workspace-manager__')) return null;

  // Edit/Write/NotebookEdit: 无条件检查 file_path（不管 cwd 在哪）
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') && inputObj.file_path) {
    const targetPath = String(inputObj.file_path);
    if (isInsideSourceRepo(targetPath)) {
      logger.info({ toolName, filePath: targetPath }, 'canUseTool denied — source repo protection (file_path)');
      return { behavior: 'deny' as const, message: SOURCE_REPO_DENY_MSG };
    }
  }

  // Bash: 当 cwd 在源仓库内时检查命令内容
  if (toolName === 'Bash' && workingDir && isInsideSourceRepo(workingDir)) {
    const cmd = String(inputObj.command || '');
    // 1. 拒绝含 shell 元字符/换行/重定向的命令
    if (SHELL_META_RE.test(cmd)) {
      logger.info({ toolName, cmd: cmd.slice(0, 100) }, 'canUseTool denied — source repo Bash meta-characters');
      return { behavior: 'deny' as const, message: '源仓库保护：不允许包含 shell 管道/链式执行/重定向的命令。请使用 setup_workspace 创建隔离工作区。' };
    }
    // 2. Denylist: 拦截写入类命令（m flag 逐行匹配）
    if (BASH_WRITE_DENY.test(cmd)) {
      logger.info({ toolName, cmd: cmd.slice(0, 100) }, 'canUseTool denied — source repo Bash write command');
      return { behavior: 'deny' as const, message: SOURCE_REPO_DENY_MSG };
    }
  }

  return null;
}

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
  /** 活动状态变更回调（同步，仅存储状态，不触发卡片更新） */
  onActivityChange?: (status: import('./types.js').ActivityStatus) => void;
  historySummaries?: string;
  /** 记忆系统注入的上下文片段（由 event-handler 通过 injector 生成） */
  memoryContext?: string;
  /** 覆盖 system prompt（用于 pipeline 各角色独立 prompt 或 persona）。有值 → replace 模式；无 → append 模式 */
  systemPromptOverride?: string;
  /** 覆盖单步空闲超时秒数 (默认使用 CLAUDE_TIMEOUT 配置)。每收到一条 SDK 消息就重置，不限制总时长 */
  timeoutSeconds?: number;
  /** 硬性总超时秒数（从开始计时，不因活动重置）。适用于 routing 等必须快速完成的短任务 */
  hardTimeoutSeconds?: number;
  /** 图片附件（多模态输入） */
  images?: ImageAttachment[];
  /** 文档附件（PDF 等，多模态输入） */
  documents?: DocumentAttachment[];
  /** 额外的 MCP servers（会合并到内部自动创建的 servers） */
  additionalMcpServers?: Record<string, ReturnType<typeof createWorkspaceMcpServer>>;
  /** 工具允许列表（在 readOnly/toolPolicy 基础上额外放行，支持 glob 前缀如 'mcp__*'） */
  toolAllow?: string[];
  /** 工具禁止列表（优先级最高，支持 glob 前缀） */
  toolDeny?: string[];
  /** Bash 命令白名单正则（readOnly + toolAllow 含 Bash 时生效，仅匹配的命令被放行） */
  bashAllowPatterns?: string[];
  /** 知识文件内容（注入到 system prompt 最前层，优先于 persona/workspace prompt） */
  knowledgeContent?: string;
  /** 上次保存的 system prompt hash（用于自动失效检测，hash 不匹配时跳过 resume） */
  storedSystemPromptHash?: string;
  /** 强制禁用 thinking（仅影响本次调用，不改变全局配置） */
  disableThinking?: boolean;
  /** Bot 身份上下文（注入到 user prompt prefix，帮助 agent 知道自己是谁、群内有哪些其他 bot） */
  botIdentityContext?: string;
  /** Agent ID（用于记忆系统隔离，来自 agentRegistry） */
  agentId?: string;
  /** 当前会话的 threadId（用于 cron MCP 绑定话题） */
  threadId?: string;
  /** 当前话题的根消息 ID（用于 cron MCP 绑定话题） */
  threadRootMessageId?: string;
  /** 前次 query 的对话轨迹（restart 时注入，帮助新 query 了解之前的分析） */
  priorContext?: string;
  /** workspace 切换后的 restart query 标志。控制 system prompt 精简（去掉仓库探索指引） */
  isRestart?: boolean;
  /** 原地编辑模式（/edit 命令触发），跳过源仓库写入保护 */
  inplaceEdit?: boolean;
  /** AskUserQuestion 回调：拦截 AskUserQuestion 工具调用，由上层实现交互式卡片 */
  onAskUser?: (questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>) => Promise<Record<string, string>>;
}

/** 扫描 defaultWorkDir 下的 git 项目名列表（best-effort） */
function listAvailableProjects(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .filter(d => existsSync(join(projectsDir, d.name, '.git')))
      .map(d => d.name)
      .slice(0, 30);
  } catch {
    return [];
  }
}

/** gh CLI 自动发现的用户组织缓存 */
let cachedGitHubOrgs: string[] | null = null;

/** 通过 gh CLI 获取当前用户所属的 GitHub 组织 + 用户名 */
function ghExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb('gh', args, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export async function initGitHubOrgCache(): Promise<void> {
  try {
    const [orgsResult, loginResult] = await Promise.allSettled([
      ghExec(['api', 'user/orgs', '--jq', '.[].login']),
      ghExec(['api', 'user', '--jq', '.login']),
    ]);
    const orgs = orgsResult.status === 'fulfilled'
      ? orgsResult.value.split('\n').filter(Boolean)
      : [];
    const login = loginResult.status === 'fulfilled' ? loginResult.value : '';
    if (login) orgs.push(login);
    if (orgs.length === 0) {
      logger.warn('GitHub org cache: no orgs or login discovered');
      return;
    }
    cachedGitHubOrgs = [...new Set(orgs)].map(o => `github.com/${o}`);
    logger.info({ orgs: cachedGitHubOrgs }, 'GitHub org cache initialized');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch GitHub orgs (gh CLI may not be configured)');
  }
}

/** 测试辅助：重置 GitHub org 缓存 */
export function _resetGitHubOrgCache(orgs?: string[] | null): void {
  cachedGitHubOrgs = orgs ?? null;
}

/** 从缓存目录 + GitHub API 提取已知 org（best-effort） */
export function listKnownOrgs(cacheDir: string): string[] {
  const orgSet = new Set<string>();

  // 1. GitHub API 发现的组织（优先）
  if (cachedGitHubOrgs) {
    for (const org of cachedGitHubOrgs) orgSet.add(org);
  }

  // 2. 从 .repo-cache 目录结构提取
  try {
    const hosts = readdirSync(cacheDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'));
    for (const host of hosts) {
      if (!host.name.includes('.')) continue;
      const orgs = readdirSync(join(cacheDir, host.name), { withFileTypes: true }).filter(d => d.isDirectory());
      for (const org of orgs) orgSet.add(`${host.name}/${org.name}`);
    }
  } catch {
    // cache dir may not exist yet
  }

  return [...orgSet].slice(0, 20);
}

/** 构建工作区管理系统提示词（注入实际目录路径 + 可用项目列表） */
function buildWorkspaceSystemPrompt(workingDir?: string, options?: { isRestart?: boolean }): string {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;
  const workspacesDir = config.workspace.baseDir;
  const isRestart = options?.isRestart ?? false;

  // restart 后不需要仓库探索相关内容，只保留当前工作区上下文
  let explorationSection = '';

  if (!isRestart) {
    const projectList = listAvailableProjects(projectsDir);
    const projectListSection = projectList.length > 0
      ? `\n\n## 可用项目\n\n以下项目在 \`${projectsDir}\` 下可用：\n${projectList.map(p => `- ${p}`).join('\n')}`
      : '';
    const knownOrgs = listKnownOrgs(cacheDir);

    explorationSection = `
## 目录结构

你需要知道以下几个关键目录：
- **项目目录**: \`${projectsDir}\` — 用户手动 clone 的项目都在这里
- **仓库缓存目录**: \`${cacheDir}\` — setup_workspace 自动缓存的 bare clone（禁止直接读取或工作）
- **可写工作区目录**: \`${workspacesDir}\` — setup_workspace 创建的隔离工作区（每个工作区属于特定用户/话题，禁止跨话题使用）${projectListSection}

## 工作区管理

**重要：当用户的请求涉及特定仓库时（无论是阅读代码、修改代码还是查看结构），必须先使用 setup_workspace 切换到该仓库。**
这样才能正确加载项目的 CLAUDE.md（架构说明、命令约定）、.claude/settings.json（工具权限）、.claude/skills/（项目技能），并让代码搜索工具在正确的范围内工作。
不要直接在 \`${projectsDir}\` 下用绝对路径浏览源仓库 — 这样会丢失项目上下文。

仅当用户的问题是通用性的（不涉及特定仓库，如"JavaScript 闭包是什么"）时，才不需要 setup_workspace。

**禁止直接访问以下目录：**
- \`${cacheDir}/\` — bare clone 缓存，仅用于定位仓库 URL
- \`${workspacesDir}/\` — 其他话题创建的隔离工作区，每个工作区属于特定上下文，直接使用会破坏隔离性

### 仓库匹配与 Registry

当你需要判断用户要在哪个仓库工作时，先读取 \`${projectsDir}/.repo-registry.json\`，根据用户消息中的关键词、项目名、技术栈等信息匹配。
- 如果匹配到唯一仓库，直接调用 setup_workspace（使用 registry 中的 repo URL）
- 如果匹配到多个或无法确定，**明确询问用户是哪个仓库，不要猜测**
- 用户澄清后，调用 update_repo_registry 记录新的关键词映射，以便下次自动匹配

**默认从 bare cache 创建隔离工作区。**
当确定目标仓库后，优先使用 setup_workspace({ repo_url: "..." }) 从 bare cache clone。
仅当用户明确说"直接在 XXX 目录改"时，才使用 setup_workspace({ local_path: "..." })。
对于 registry 中标记为 local-only（cachePath 为 null）的仓库，使用 setup_workspace({ local_path: "..." })。
**不要直接 cd 到源仓库中开始编辑 — 源仓库受写保护，会被拦截。**

### 查找仓库的顺序

当 registry 中没有匹配结果时，按以下顺序查找：

1. **检查可用项目列表**（见上方）和本地目录 \`ls ${projectsDir}\`
2. **搜索本地缓存** — \`find ${cacheDir} -maxdepth 3 -name "*.git" -type d\` 查找匹配的 bare clone，从路径推导 URL（如 \`${cacheDir}/github.com/org/repo.git\` → \`https://github.com/org/repo\`）
3. **GitHub 搜索** — 优先在团队组织内搜索：${knownOrgs.length > 0 ? knownOrgs.filter(o => o.startsWith('github.com/')).map(o => `\`gh search repos <关键词> --owner=${o.replace('github.com/', '')} --json fullName,url --limit 10\``).join('，然后 ') + '。' : ''} 如果组织内没找到，再全局搜索 \`gh search repos <关键词> --json fullName,url --limit 10\`
4. 都找不到 → 向用户询问仓库 URL

**不要跳过搜索步骤直接问用户要 URL。** 先尝试自己找到仓库。

**重要：\`${cacheDir}\` 下的是 bare clone（无文件树），仅用于定位仓库 URL。不要在 bare repo 中直接工作（\`git show\`/\`git grep\` 等）。** 找到仓库后，如果项目不在 \`${projectsDir}\` 下，必须调用 setup_workspace 创建完整工作区，这样才能正确加载 CLAUDE.md、使用搜索工具、获得完整的代码上下文。

**绝对不要用 setup_workspace 来切换当前工作区。** 当前工作区已经配置好了正确的权限，直接在当前目录工作即可。

**重要：调用 setup_workspace 后，系统将自动重启以加载项目配置（CLAUDE.md 等）。
请在调用后仅输出简短确认（如"工作区已就绪，正在重新加载项目配置..."），不要继续执行后续任务。**`;
  }

  const basePrompt = `你正在通过飞书消息与用户交互。请保持回复简洁，适合在聊天消息中阅读。
${explorationSection}

## 自动开发流程

当用户给出明确的代码修改任务（写功能、修 bug、重构等）时，自动按以下流程执行：

1. 理解需求，确认工作目录和代码结构
2. 检查当前分支：\`git branch\`。如果在 main/master/develop 上，先创建特性分支：\`git checkout -b feat/<描述性名称>\`
3. 编写/修改代码，采用**原子化 commit** 策略（见下方）
4. 发现项目测试命令（查看 package.json scripts、Makefile 等）并运行测试
   - 如果没有测试命令，跳过测试步骤并在报告中说明
5. 如果测试失败：分析错误 → 修复 → 重新测试
   - 最多重试 2 轮
   - 如果相同测试以相同方式连续失败 2 次，停止重试，向用户说明根因
6. 推送前预检：
   - \`git remote -v\` 确认 origin 存在
   - \`gh auth status\` 确认 GitHub CLI 已认证
   - 如果任一检查失败，跳过推送/PR 步骤，报告已完成的工作和需要手动处理的部分
7. 测试通过后：\`git push -u origin\` → \`gh pr create\`
8. 最后汇报：改了什么、测试结果、PR 链接

### 原子化 Commit 策略

一个 feature/bugfix 应拆分为多个独立的小 commit，每个 commit 只做一件事：

\`\`\`
feat: 核心逻辑实现          ← 功能代码
test: 对应的单元测试         ← 测试代码（每个 feat 必须配套）
docs: 更新文档/注释          ← 如有需要
fix: review 后的修正         ← 如有需要
\`\`\`

操作方式：
- 完成一个逻辑单元后立即 \`git add\` 相关文件 → \`git commit\`，不要攒到最后一次性提交
- 每个 commit 应该是独立可 review、可 revert 的
- commit message 格式遵循项目约定（查看 \`git log --oneline -5\` 学习风格）
- 不要 git add . 或 git add -A，只添加本次变更的文件

规则：
- 不要提交 .env、credentials 等敏感文件
- 如果某步骤失败且无法自动修复，停下来向用户说明情况
- 如果用户只是提问、审查代码或做探索性修改，不需要走这个流程。不确定时问用户："需要我提交这些改动并创建 PR 吗？"

## GitHub CLI (gh) 注意事项

工作区的 git remote 指向本地缓存路径（非 GitHub URL），\`gh\` CLI 无法自动识别仓库。
**始终使用 \`--repo owner/repo\` 参数**，不要 cd 到其他目录：

\`\`\`bash
# 正确 ✓
gh pr view 123 --repo owner/repo
gh search issues --repo owner/repo -- "keyword"

# 错误 ✗ — 不要 cd 到主仓库或其他目录执行 gh
cd /some/other/dir && gh pr view 123
\`\`\``;

  const selfRepoGuide = (workingDir && isServiceOwnRepo(workingDir)) ? `

## 服务运行时信息（自改自模式）

**你就是 anycode 服务本身。** 用户正在通过飞书与你对话，你的回复由当前正在运行的这个服务进程处理并发送。当用户要求你修改"这个项目"、"你自己的代码"或未指定具体仓库时，指的就是这个服务的源码仓库。

### 运行中的服务实例
- **PM2 进程名**: \`anycode\`
- **服务部署目录**: \`${process.cwd()}\`

### 常用命令
- 查看最近日志: \`pm2 logs anycode --lines 200 --nostream\`
- 仅看错误日志: \`pm2 logs anycode --err --lines 100 --nostream\`
- 进程状态: \`pm2 show anycode\`
- 实时日志（谨慎，会持续输出）: \`pm2 logs anycode --lines 50\`（需 Ctrl+C 中断）

### 注意事项
- **严禁执行 \`pm2 restart anycode\`** — 你是这个进程的子进程，restart 会杀掉你自己的父进程，导致对话中断和级联重启。代码部署后 CI/CD 会自动 restart
- 你的工作目录是服务仓库的隔离 clone，修改不会直接影响运行中的实例，需要推送代码并重启才能生效
- 日志是 JSON 格式（Pino），可用 \`| jq .\` 格式化或 \`| grep "关键词"\` 过滤` : '';

  return basePrompt + selfRepoGuide;
}

/**
 * 构建多模态 prompt（包含图片/文档和文本的 AsyncIterable<SDKUserMessage>）
 * Agent SDK 的 query() 支持 `prompt: string | AsyncIterable<SDKUserMessage>`
 */
async function* buildMultimodalPrompt(
  text: string,
  images: ImageAttachment[],
  documents?: DocumentAttachment[],
): AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage> {
  // 构造 content blocks: 文档在前，图片次之，文本在后
  const contentBlocks: MultimodalContentBlock[] = [];

  if (documents?.length) {
    for (const doc of documents) {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: doc.mediaType,
          data: doc.data,
        },
      });
    }
  }

  for (const img of images) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

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

  /** 运行中的 task promise（用于 graceful shutdown 等待结果发送） */
  private runningTasks = new Set<Promise<unknown>>();

  /**
   * 执行 Claude Agent SDK query
   */
  async execute(input: ExecuteInput): Promise<ClaudeResult> {
    const {
      sessionKey, prompt, workingDir, resumeSessionId,
      onProgress, onWorkspaceChanged, onStreamUpdate, onTurn, onActivityChange, historySummaries,
      systemPromptOverride, disableWorkspaceTool, maxTurns, maxBudgetUsd,
      model: modelOverride, settingSources: settingSourcesOverride,
      readOnly, images, documents,
    } = input;

    const startTime = Date.now();
    const abortController = new AbortController();
    const idleTimeoutMs = (input.timeoutSeconds ?? config.claude.timeoutSeconds) * 1000;
    let timedOut = false;
    // 跟踪是否有过工具活动（canUseTool 被调用过）
    // 有工具活动说明 agent 在积极工作，API 处理大上下文思考下一步可能需要更长时间
    let hasToolActivity = false;

    // 滑动窗口 idle 超时：每收到一条 SDK 消息就重置计时器
    // 只在某一步长时间无活动时才 abort，不限制总执行时长
    // 当 agent 有过工具活动时，使用 2 倍超时（API 处理大上下文后思考下一步可能较慢）
    let idleTimer: ReturnType<typeof setTimeout> = undefined!;
    let lastResetSource = 'init';
    const resetIdleTimer = (source?: string) => {
      clearTimeout(idleTimer);
      if (source) lastResetSource = source;
      const effectiveTimeout = hasToolActivity ? idleTimeoutMs * 2 : idleTimeoutMs;
      idleTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        logger.warn({ sessionKey, idleTimeoutMs: effectiveTimeout, hasToolActivity, lastResetSource, elapsedMs: Date.now() - startTime },
          'Claude query idle timeout — no SDK message received, aborting');
      }, effectiveTimeout);
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
      { sessionKey, workingDir, promptLength: prompt.length, resume: !!resumeSessionId, imageCount: images?.length ?? 0, documentCount: documents?.length ?? 0 },
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
          // 不再立即 abort — SDK 在 MCP 工具执行期间 abort 会导致 handleControlRequest
          // 写入已死进程 stdin 时抛出 unhandled "Operation aborted"，使 query 卡住。
          // 系统提示词已告知 agent 调用 setup_workspace 后立即结束，query 会自然结束，
          // event-handler 通过 needsRestart 标记触发 restart。
          logger.info({ sessionKey, newDir }, 'Workspace changed — will restart after query completes');
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
      // sessionKey 格式为 "agent:{agentId}:{chatId}:{userId}" 或旧格式 "chatId:userId"
      const keyParts = sessionKey.split(':');
      const chatId = keyParts.length >= 4 ? keyParts[2] : keyParts[0] || undefined;
      const userId = keyParts.length >= 4 ? keyParts[3] : keyParts[1] || undefined;
      const feishuMcp = createFeishuToolsMcpServer(chatId, userId);
      if (feishuMcp) {
        mcpServers['feishu-tools'] = feishuMcp;
      }
    }

    // Memory search MCP tool (Agent 主动搜索记忆)
    if (isMemoryEnabled()) {
      const memStore = getMemoryStore();
      const memSearch = getHybridSearch();
      if (memStore && memSearch) {
        // userId 从 sessionKey 解析: "chatId:userId" 或 "chatId:userId:threadId" 或 "routing:chatId:userId[:threadId]"
        const memKeyParts = sessionKey.split(':');
        const isRouting = memKeyParts[0] === 'routing';
        const memUserId = isRouting ? memKeyParts[2] : memKeyParts[1];
        mcpServers['memory-tools'] = createMemorySearchMcpServer(memStore, memSearch, {
          agentId: input.agentId ?? 'default',
          userId: memUserId,
          workspaceDir: workingDir,
        });
      }
    }

    // Cron scheduler MCP tool
    if (config.cron.enabled) {
      const cronScheduler = getCronScheduler();
      if (cronScheduler) {
        const cronKeyParts = sessionKey.split(':');
        const cronChatId = cronKeyParts.length >= 4 ? cronKeyParts[2] : cronKeyParts[0] || '';
        const cronUserId = cronKeyParts.length >= 4 ? cronKeyParts[3] : cronKeyParts[1] || '';
        mcpServers['cron-scheduler'] = createCronMcpServer({
          scheduler: cronScheduler,
          chatId: cronChatId,
          userId: cronUserId,
          agentId: input.agentId,
          accountId: feishuClientContext.getStore() || 'default',
          threadId: input.threadId,
          threadRootMessageId: input.threadRootMessageId,
        });
      }
    }

    // 合并调用方传入的额外 MCP servers（如 discussion-tools）
    if (input.additionalMcpServers) {
      Object.assign(mcpServers, input.additionalMcpServers);
    }

    // 构建 systemPrompt.append 内容
    // 注入层次：knowledge → persona/workspace prompt → 历史会话摘要
    // pipeline 模式使用独立的 system prompt，不需要工作区管理指引
    const baseAppend = systemPromptOverride ?? buildWorkspaceSystemPrompt(workingDir, { isRestart: input.isRestart });
    // system prompt 只保留静态内容（knowledge + base prompt），最大化 prompt caching 命中率
    // 动态内容（记忆、历史摘要）移到 user prompt 前缀，避免 per-query 差异导致 cache miss
    const withKnowledge = input.knowledgeContent
      ? input.knowledgeContent + '\n\n' + baseAppend
      : baseAppend;
    // System prompt 结构性哈希：用于诊断日志，追踪 prompt 变化。
    // 不再用于自动失效 session — Agent SDK resume 时会使用新传入的 systemPrompt，
    // 旧 session 自然获得最新工具描述。
    const hashInput = withKnowledge;
    const systemPromptHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    if (resumeSessionId && input.storedSystemPromptHash && input.storedSystemPromptHash !== systemPromptHash) {
      logger.info(
        { sessionKey, storedHash: input.storedSystemPromptHash, currentHash: systemPromptHash },
        'System prompt changed since last session — continuing with updated prompt (no longer invalidates session)',
      );
    }

    const effectiveResumeId = resumeSessionId;

    // system prompt append：仅静态内容
    const promptAppend = withKnowledge;

    // 动态内容拼入 user prompt 前缀（记忆 + 历史摘要 + 只读提示）
    // 这些内容每次 query 可能不同，放在 user prompt 中不影响 system prompt 的缓存前缀
    let userPromptPrefix = '';
    if (input.memoryContext) {
      userPromptPrefix += input.memoryContext + '\n\n';
    }
    if (input.botIdentityContext) {
      userPromptPrefix += input.botIdentityContext + '\n\n';
    }
    if (historySummaries) {
      userPromptPrefix += `## 历史会话摘要\n以下是该用户之前的会话记录，帮助你了解项目上下文：\n${historySummaries}\n\n`;
    }
    if (readOnly) {
      const allowSet = new Set(input.toolAllow ?? []);
      const forbiddenTools = [...WRITE_TOOLS].filter(t => !allowSet.has(t));
      if (forbiddenTools.length > 0) {
        userPromptPrefix += `[系统提示：当前用户处于只读模式。你可以阅读和分析代码、回答问题，但不能修改文件或执行命令。不要尝试使用 ${forbiddenTools.join('、')} 等工具。如果用户请求代码修改，告知他们需要管理员权限。${allowSet.size > 0 ? `你可以使用 ${[...allowSet].join('、')} 工具。` : ''}]\n\n`;
      } else {
        userPromptPrefix += '[系统提示：当前用户处于受限模式，请谨慎使用写入类工具。]\n\n';
      }
    }
    // 前次 query 的对话轨迹（workspace 切换 restart 时注入）
    if (input.priorContext) {
      userPromptPrefix += [
        '<prior-analysis>',
        '以下是你在切换工作区前的完整工作记录（推理、工具调用和结果）。',
        '基于此继续工作，不要重复已完成的分析。',
        '注意：文件路径可能指向旧工作区，当前已切换到新工作区。',
        '',
        input.priorContext,
        '</prior-analysis>',
        '',
      ].join('\n');
    }
    const effectivePrompt = userPromptPrefix + prompt;

    // 构建 SDK query
    // 有图片或文档时使用 AsyncIterable<SDKUserMessage> 多模态格式
    const hasMultimodal = (images?.length ?? 0) > 0 || (documents?.length ?? 0) > 0;
    const promptInput = hasMultimodal
      ? buildMultimodalPrompt(effectivePrompt, images ?? [], documents)
      : effectivePrompt;

    const q = query({
      prompt: promptInput,
      options: {
        cwd: workingDir,
        abortController,
        stderr: (data: string) => logger.warn({ stderr: data.trim() }, 'Claude Code stderr'),

        // 清除嵌套检测环境变量，允许从 Claude Code 会话内启动子进程
        // 注入 ANTHROPIC_BASE_URL 供 SDK 子进程使用自定义 API 端点
        env: (() => {
          const e = { ...process.env };
          delete e.CLAUDECODE;
          if (config.claude.apiBaseUrl) {
            e.ANTHROPIC_BASE_URL = config.claude.apiBaseUrl;
          }
          return e;
        })(),

        // 权限：acceptEdits 自动接受文件编辑，canUseTool 自动批准其余工具调用
        // 注意：不使用 bypassPermissions，因为 root 用户下会被拒绝
        permissionMode: 'acceptEdits',

        // 显式启用 Skill 工具 — SDK 默认不启用，必须通过 allowedTools 激活
        // 这样 .claude/skills/ 中的 SKILL.md 才能被加载和使用
        allowedTools: ['Skill'],
        canUseTool: async (toolName: string, inputObj: Record<string, unknown>) => {
          // canUseTool 在每次工具执行前触发，说明 agent 仍在活跃工作
          // 1. 标记工具活动 → 后续 idle timer 使用 2 倍超时（API 处理大上下文后思考较慢）
          // 2. 重置 idle timer → 防止长时间 MCP 工具执行导致误超时
          hasToolActivity = true;
          resetIdleTimer(`canUseTool:${toolName}`);

          // workspace 变更后 deny 所有后续工具调用，迫使 agent 只输出文本后自然结束
          // 不使用 abort（会导致 SDK handleControlRequest unhandled rejection 卡死）
          if (workspaceChanged) {
            logger.info({ toolName }, 'canUseTool denied — workspace changed, forcing query to end');
            return { behavior: 'deny' as const, message: '工作区已切换，当前 query 即将结束。请直接输出简短确认。' };
          }

          // AskUserQuestion 拦截：通过飞书卡片收集用户回答，注入 answers 后放行
          if (toolName === 'AskUserQuestion' && input.onAskUser) {
            const questions = inputObj.questions as Array<{
              question: string;
              header?: string;
              options: Array<{ label: string; description?: string }>;
              multiSelect?: boolean;
            }> | undefined;
            if (questions?.length) {
              try {
                const answers = await input.onAskUser(questions);
                return { behavior: 'allow' as const, updatedInput: { ...inputObj, answers } };
              } catch (err) {
                logger.warn({ err }, 'AskUserQuestion card interaction failed, allowing tool to proceed without answers');
                return { behavior: 'allow' as const, updatedInput: inputObj };
              }
            }
          }

          // per-agent 工具禁止列表（优先级最高）
          if (input.toolDeny?.some(p => matchToolPattern(toolName, p))) {
            logger.info({ toolName }, 'canUseTool denied — agent toolDeny list');
            return { behavior: 'deny' as const, message: `工具 ${toolName} 被 agent 配置禁止。` };
          }

          // ★ 源仓库保护（系统安全机制，优先级高于 toolAllow）★
          // 必须在 toolAllow 之前检查，因为 toolAllow 匹配后会提前 return allow。
          {
            const sourceRepoDeny = checkSourceRepoProtection(toolName, inputObj, workingDir, input.inplaceEdit);
            if (sourceRepoDeny) return sourceRepoDeny;
          }

          // per-agent 工具允许列表（管理员显式配置，可覆盖 readOnly 限制）
          if (input.toolAllow?.some(p => matchToolPattern(toolName, p))) {
            // readOnly 模式下 MCP 工具不能通过 toolAllow 绕过 — 交给后续 MCP readonly 白名单检查
            if (readOnly && toolName.startsWith('mcp__')) {
              logger.info({ toolName }, 'canUseTool — toolAllow matched MCP tool in readOnly mode, deferring to MCP readonly check');
              // fall through: 不 return，让后面的 MCP readonly 逻辑决定
            } else {
              // readOnly + Bash + bashAllowPatterns：仅放行匹配白名单的命令
              // 防御 shell 注入：先拒绝包含链式执行元字符的命令，再做正则匹配
              if (readOnly && toolName === 'Bash' && input.bashAllowPatterns?.length) {
                const cmd = String(inputObj.command || '');
                if (/[;|&`$]|\$\(/.test(cmd)) {
                  logger.info({ toolName, cmd: cmd.slice(0, 100) }, 'canUseTool denied — Bash command contains shell meta-characters');
                  return { behavior: 'deny' as const, message: '只读模式下不允许包含 shell 管道/链式执行的命令。' };
                }
                const allowed = input.bashAllowPatterns.some(p => new RegExp(p).test(cmd));
                if (!allowed) {
                  logger.info({ toolName, cmd: cmd.slice(0, 100) }, 'canUseTool denied — Bash command not in bashAllowPatterns');
                  return { behavior: 'deny' as const, message: '只读模式下该命令不在允许列表中。' };
                }
                logger.info({ toolName, cmd: cmd.slice(0, 100) }, 'canUseTool allowed — Bash command matches bashAllowPatterns');
              } else if (readOnly && WRITE_TOOLS.has(toolName)) {
                logger.info({ toolName }, 'canUseTool allowed — toolAllow overrides readOnly for write tool');
              } else {
                logger.info({ toolName }, 'canUseTool allowed — agent toolAllow list');
              }
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
          }
          // 只读模式：拦截写入类工具
          if (readOnly && WRITE_TOOLS.has(toolName)) {
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。需要管理员权限才能修改文件或执行命令。' };
          }
          // 只读模式 MCP 工具权限：deny-by-default，但飞书工具和讨论工具整体放行
          if (readOnly && toolName.startsWith('mcp__')) {
            // 飞书工具整体放行：操作的是飞书数据（文档/任务/表格/通讯录），不是代码仓库，
            // 且受飞书自身权限体系保护，无需逐个 action 白名单
            if (toolName.startsWith('mcp__feishu-tools__')) {
              logger.info({ toolName, readOnly }, 'canUseTool allowed — feishu tool (not repo data)');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
            // discussion-tools: Chat Agent 话题升级工具，readonly 下允许
            if (toolName.startsWith('mcp__discussion-tools__')) {
              logger.info({ toolName, readOnly }, 'canUseTool allowed — discussion tool in read-only mode');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
            // memory-tools: 记忆搜索工具，read-only 操作，readonly 下允许
            if (toolName.startsWith('mcp__memory-tools__')) {
              logger.info({ toolName, readOnly }, 'canUseTool allowed — memory search tool in read-only mode');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
            // cron-scheduler: 定时任务管理，操作的是任务数据库而非代码仓库，readonly 下允许
            if (toolName.startsWith('mcp__cron-scheduler__')) {
              logger.info({ toolName, readOnly }, 'canUseTool allowed — cron tool in read-only mode');
              return { behavior: 'allow' as const, updatedInput: inputObj };
            }
            // 所有其他 MCP 工具（含 workspace-manager、未来新增）：deny
            logger.info({ toolName, readOnly }, 'canUseTool denied — read-only mode (MCP tool)');
            return { behavior: 'deny' as const, message: '当前用户处于只读模式，无法使用此工具。' };
          }
          logger.info({
            toolName,
            inputKeys: Object.keys(inputObj),
            ...(toolName === 'Bash' && inputObj.command ? { cmd: String(inputObj.command).slice(0, 200) } : {}),
          }, 'canUseTool called — auto allowing');
          // updatedInput 必须显式传回，否则 SDK 内部 Zod 校验会因 undefined 报错
          return { behavior: 'allow' as const, updatedInput: inputObj };
        },

        // 模型 + thinking + effort
        model: modelOverride ?? config.claude.model,
        thinking: input.disableThinking
          ? { type: 'disabled' as const }
          : config.claude.thinking === 'adaptive'
            ? { type: 'adaptive' as const }
            : { type: 'disabled' as const },
        effort: config.claude.effort,

        // 预算和限制 — 默认值从 config 读取，调用方可覆盖
        maxTurns: maxTurns ?? config.claude.maxTurns,
        maxBudgetUsd: maxBudgetUsd ?? config.claude.maxBudgetUsd,

        // 会话续接
        ...(effectiveResumeId ? { resume: effectiveResumeId } : {}),

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

    // 活动状态追踪
    let activityToolCallCount = 0;
    let currentActivity: 'thinking' | 'tool_call' = 'thinking';

    // 对话轨迹累积（用于 restart 时传递上下文）
    const conversationTrace: ConversationTurn[] = [];
    const traceByteCosts: number[] = []; // 每个 turn 插入时快照的 byte cost
    const pendingToolCalls = new Map<string, ToolCallTrace>();
    let conversationTraceBytes = 0;
    const MAX_TRACE_BYTES = 50 * 1024; // 50KB 上限

    try {
      // 遍历 SDK 流式消息
      for await (const message of q) {
        // 每收到消息重置 idle 计时器
        resetIdleTimer(`msg:${message.type}${'subtype' in message ? ':' + (message as Record<string, unknown>).subtype : ''}`);

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
            const traceToolCalls: ToolCallTrace[] = [];

            if (message.message?.content) {
              for (const block of message.message.content) {
                if ('text' in block && block.text) {
                  // 剥离模型在普通文本中输出的 <thinking> 标签（Sonnet adaptive 模式下偶现）
                  // 同时处理未闭合的 <thinking> 标签（模型可能只输出开标签不闭合）
                  const cleaned = (block.text as string)
                    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
                    .replace(/<thinking>[\s\S]*/g, '');
                  if (cleaned) {
                    output += cleaned;
                    turnText.push(cleaned);
                  }
                }
                if ('type' in block && block.type === 'tool_use' && 'name' in block && 'input' in block) {
                  turnTools.push({ name: block.name as string, input: block.input as Record<string, unknown> });
                  // 记录工具调用到对话轨迹，通过 id 关联后续的 tool_result
                  const trace: ToolCallTrace = {
                    id: (block as Record<string, unknown>).id as string ?? '',
                    name: block.name as string,
                    input: block.input as Record<string, unknown>,
                  };
                  traceToolCalls.push(trace);
                  if (trace.id) pendingToolCalls.set(trace.id, trace);
                }
              }
            }

            // 累积对话轨迹（用于 restart 上下文传递）
            if (conversationTraceBytes < MAX_TRACE_BYTES && (turnText.length > 0 || traceToolCalls.length > 0)) {
              const turnTextStr = turnText.join('');
              const turn: ConversationTurn = { text: turnTextStr, toolCalls: traceToolCalls };
              // 在 tool_result 回填前快照 byte cost，避免 mutate 后计算漂移
              const byteCost = turnTextStr.length + JSON.stringify(traceToolCalls).length;
              conversationTrace.push(turn);
              traceByteCosts.push(byteCost);
              conversationTraceBytes += byteCost;
              // 超过上限时丢弃最早的 turn（使用快照的 byteCost）
              while (conversationTraceBytes > MAX_TRACE_BYTES && conversationTrace.length > 1) {
                conversationTrace.shift();
                conversationTraceBytes -= traceByteCosts.shift()!;
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

            // 活动状态追踪：tool_call 或 thinking
            if (onActivityChange) {
              if (turnTools.length > 0) {
                activityToolCallCount += turnTools.length;
                currentActivity = 'tool_call';
                onActivityChange({ state: 'tool_call', toolCallCount: activityToolCallCount });
              } else if (turnText.length > 0 && currentActivity !== 'thinking') {
                currentActivity = 'thinking';
                onActivityChange({ state: 'thinking', toolCallCount: activityToolCallCount });
              }
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

          case 'user': {
            // 回填工具结果到对应的 toolCall 轨迹
            const content = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
            const blocks = (content?.content as Array<Record<string, unknown>>) ?? [];
            for (const block of blocks) {
              if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const trace = pendingToolCalls.get(block.tool_use_id);
                if (trace) {
                  // 提取文本结果
                  let text = '';
                  const resultContent = block.content;
                  if (typeof resultContent === 'string') {
                    text = resultContent;
                  } else if (Array.isArray(resultContent)) {
                    text = (resultContent as Array<Record<string, unknown>>)
                      .filter(c => c.type === 'text')
                      .map(c => c.text as string)
                      .join('');
                  }
                  // 截断过长的工具结果
                  trace.result = text.length > 2000
                    ? text.slice(0, 1500) + '\n...(truncated)...\n' + text.slice(-500)
                    : text;
                  pendingToolCalls.delete(block.tool_use_id);
                }
              }
            }
            break;
          }

          case 'result':
            resultMessage = message;
            break;

          default:
            // tool_progress, stream_event 等其他消息类型 — 记录以便诊断 idle timeout 间隙
            logger.debug({ sessionKey, messageType: message.type, subtype: (message as Record<string, unknown>).subtype },
              'SDK message (non-primary)');
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
          : `Query idle timeout after ${(hasToolActivity ? idleTimeoutMs * 2 : idleTimeoutMs) / 1000}s with no activity (total elapsed: ${Math.round(durationMs / 1000)}s)`)
        : (err instanceof Error ? err.message : String(err));
      logger.error({ sessionKey, err: errorMsg, timedOut }, 'Claude Agent SDK query error');

      return {
        success: false,
        output,
        error: errorMsg,
        sessionId,
        systemPromptHash,
        durationMs,
        needsRestart: workspaceChanged,
        newWorkingDir,
        conversationTrace,
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
      // SDK 的 total_cost_usd / modelUsage / durationApiMs 在 resume 首次 query 时
      // 会包含整个 session 的历史累计值，导致简单问题显示天价费用。
      // 改用顶层 usage 字段（仅包含本次 query 的 token 用量）自行计算费用。
      const queryCostUsd = (resultMessage.usage && resultMessage.modelUsage)
        ? calculateCostFromUsage(resultMessage.usage as Parameters<typeof calculateCostFromUsage>[0], resultMessage.modelUsage)
        : resultMessage.total_cost_usd;

      logger.info({
        sessionKey,
        subtype: resultMessage.subtype,
        sdkTotalCostUsd: resultMessage.total_cost_usd,
        queryCostUsd,
        numTurns: resultMessage.num_turns,
        durationMs: resultMessage.duration_ms,
        durationApiMs: resultMessage.duration_api_ms,
        usage: resultMessage.usage,
        modelUsage: resultMessage.modelUsage,
      }, 'Claude Agent SDK query result');

      if (resultMessage.subtype === 'success') {
        // 如果 output 为空但 result 有文本，使用 result（同样需要剥离 thinking 标签）
        if (!output && resultMessage.result) {
          output = resultMessage.result
            .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
            .replace(/<thinking>[\s\S]*/g, '');
        }

        return {
          success: true,
          output,
          sessionId: resultMessage.session_id ?? sessionId,
          systemPromptHash,
          durationMs: resultMessage.duration_ms ?? durationMs,
          durationApiMs: resultMessage.duration_api_ms,
          costUsd: queryCostUsd,
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
          systemPromptHash,
          durationMs: resultMessage.duration_ms ?? durationMs,
          durationApiMs: resultMessage.duration_api_ms,
          costUsd: queryCostUsd,
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
      systemPromptHash,
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
   *   以及旧格式 {chatId}:{userId}:... (兼容)
   */
  killSessionsForChat(chatId: string, userId: string): void {
    const oldPrefix = `${chatId}:${userId}`;
    for (const [key, q] of this.runningQueries) {
      // 新格式：key 中包含 {chatId}:{userId}
      const matchesChat = key.includes(`${chatId}:${userId}`);
      // 旧格式兼容
      const matchesOld = key === oldPrefix || key.startsWith(oldPrefix + ':');

      if (matchesChat || matchesOld) {
        q.close();
        this.runningQueries.delete(key);
        logger.info({ sessionKey: key }, 'Killed Claude Agent SDK query');
      }
    }
  }

  /**
   * 注册一个 task promise（用于 graceful shutdown 时等待完成）
   * task 完成后自动从集合中移除
   */
  registerTask(promise: Promise<unknown>): void {
    this.runningTasks.add(promise);
    promise.finally(() => this.runningTasks.delete(promise));
  }

  /**
   * 获取所有运行中查询的 session key（用于 shutdown 时保存被中断的会话）
   */
  getRunningQueryKeys(): string[] {
    return [...this.runningQueries.keys()];
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
   * 等待所有运行中的 task 完成（用于 graceful shutdown）
   * killAll() 关闭 stream 后，execute() 会返回，caller 发送结果卡片后 task 完成
   */
  async waitForRunningTasks(timeoutMs = 8000): Promise<void> {
    if (this.runningTasks.size === 0) return;
    logger.info({ count: this.runningTasks.size }, 'Waiting for running tasks to finish...');
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      Promise.allSettled([...this.runningTasks]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]).finally(() => clearTimeout(timer!));
    logger.info({ remaining: this.runningTasks.size }, 'Running tasks wait completed');
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
