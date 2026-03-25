import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isServiceOwnRepo } from '../workspace/isolation.js';
import { claudeExecutor } from './executor.js';

/** 路由决策结果 */
export interface RoutingDecision {
  decision: 'use_existing' | 'clone_remote' | 'use_default' | 'need_clarification';
  /** 本地目录绝对路径（use_existing 时必填） */
  workdir?: string;
  /** 远程仓库 URL（clone_remote 时必填） */
  repo_url?: string;
  /** 工作区模式 */
  mode?: 'readonly' | 'writable';
  /** 分支名（可选） */
  branch?: string;
  /** 用户澄清问题（need_clarification 时必填） */
  question?: string;
  /** clone 失败时的错误信息 */
  cloneError?: string;
  /** 非阻断性警告（如缓存 fetch 失败） */
  warning?: string;
}

/** 扫描项目目录，读取各项目的描述信息（package.json description 或 CLAUDE.md 标题） */
function discoverLocalProjects(projectsDir: string): Array<{ name: string; description: string }> {
  const projects: Array<{ name: string; description: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return projects;
  }
  for (const name of entries) {
    // 跳过隐藏目录和已知的非项目目录
    if (name.startsWith('.')) continue;
    const dirPath = join(projectsDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    // 跳过非 git 仓库目录（如编译产物 target/、build/ 等）
    if (!existsSync(join(dirPath, '.git'))) continue;
    // 尝试从 package.json 读取 description
    let description = '';
    try {
      const pkg = JSON.parse(readFileSync(join(dirPath, 'package.json'), 'utf-8'));
      if (typeof pkg.description === 'string' && pkg.description.trim()) {
        description = pkg.description.trim();
      }
    } catch {
      // no package.json or invalid JSON
    }
    // fallback: 读取 CLAUDE.md 开头（仅前 1KB，只需第一个标题行）
    if (!description) {
      try {
        const buf = Buffer.alloc(1024);
        const fd = openSync(join(dirPath, 'CLAUDE.md'), 'r');
        const bytesRead = readSync(fd, buf, 0, 1024, 0);
        closeSync(fd);
        const content = buf.toString('utf-8', 0, bytesRead);
        const match = content.match(/^#\s+(.+)/m);
        if (match) {
          description = match[1].trim();
        }
      } catch {
        // no CLAUDE.md
      }
    }
    projects.push({ name, description: description || '(no description)' });
  }
  // 限制数量，避免项目过多时撑爆 routing prompt
  return projects.slice(0, 30);
}

/** 扫描缓存目录，提取已缓存的远程仓库信息（目录结构: host/org/repo.git） */
function discoverCachedRepos(cacheDir: string): Array<{ name: string; fullName: string; url: string }> {
  const repos: Array<{ name: string; fullName: string; url: string }> = [];
  let hosts: string[];
  try { hosts = readdirSync(cacheDir); } catch { return repos; }
  for (const host of hosts) {
    if (host.startsWith('.')) continue;
    const hostPath = join(cacheDir, host);
    let orgs: string[];
    try {
      if (!statSync(hostPath).isDirectory()) continue;
      orgs = readdirSync(hostPath);
    } catch { continue; }
    for (const org of orgs) {
      if (org.startsWith('.')) continue;
      const orgPath = join(hostPath, org);
      let entries: string[];
      try {
        if (!statSync(orgPath).isDirectory()) continue;
        entries = readdirSync(orgPath);
      } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.git')) continue;
        const repoName = entry.slice(0, -4);
        repos.push({ name: repoName, fullName: `${org}/${repoName}`, url: `https://${host}/${org}/${repoName}` });
      }
    }
  }
  return repos.slice(0, 50);
}

/** 构建路由 system prompt（注入实际目录路径和项目描述） */
function buildRoutingSystemPrompt(projects: Array<{ name: string; description: string }>): string {
  const projectsDir = config.claude.defaultWorkDir;
  const cacheDir = config.repoCache.dir;

  // 找到本系统自身的项目名（用于默认路由规则）
  // 通过 isServiceOwnRepo 检查 package.json name，比关键词匹配更鲁棒
  const selfProjectName = projects.find(p =>
    isServiceOwnRepo(join(projectsDir, p.name)),
  )?.name;

  // 扫描缓存目录中的 bare clone
  const cachedRepos = discoverCachedRepos(cacheDir);
  // 排除本地已有的项目（本地项目优先级更高）
  const localNames = new Set(projects.map(p => p.name));
  const cachedOnly = cachedRepos.filter(r => !localNames.has(r.name));

  const projectsSection = projects.length > 0
    ? [
        '## 已知本地项目',
        '',
        `以下是 \`${projectsDir}\` 中的项目及其用途：`,
        '',
        ...projects.map(p => `- **${p.name}** (\`${projectsDir}/${p.name}\`): ${p.description}`),
        '',
      ].join('\n')
    : '';

  const cachedSection = cachedOnly.length > 0
    ? [
        '## 已缓存的远程仓库',
        '',
        '以下仓库已有本地缓存，匹配时使用 `clone_remote`（系统会从缓存快速创建工作区，无需重新下载）：',
        '',
        ...cachedOnly.map(r => `- **${r.name}** (${r.fullName}): \`${r.url}\``),
        '',
      ].join('\n')
    : '';

  return `你是一个工作区路由助手。你的唯一任务是决定用户的请求应该在哪个代码仓库/目录下执行。
**你应该尽量快速决策，直接输出 JSON，不要调用任何工具，除非用户提到了一个你不认识的仓库名。**

${projectsSection}${cachedSection}## 快速决策规则（优先级从高到低，匹配即停）

1. **消息中有明确 URL** → \`clone_remote\`，用该 URL
2. **消息中有明确本地路径** → \`use_existing\`（验证路径存在）
3. **消息提到已知本地项目名**（见上方列表）→ 直接 \`use_existing\`，workdir 填对应路径，**不需要调用任何工具**
4. **消息提到已缓存的远程仓库名**（见上方列表）→ 直接 \`clone_remote\`，repo_url 填对应 URL，**不需要调用任何工具**
${selfProjectName ? `5. **消息涉及本系统自身的功能**（如飞书工具、卡片、消息、agent、pipeline、MCP、routing 等）→ 用户在让 agent 改自己，选 \`use_existing\`，workdir = \`${projectsDir}/${selfProjectName}\`
6` : '5'}. **消息不涉及特定仓库**（通用问题、闲聊等）→ \`use_default\`
7. **消息提到不认识的仓库名** → 此时才需要调用工具查找（见下方查找顺序）
8. **以上都无法判断** → \`need_clarification\`

## 查找顺序（仅当快速决策规则 7 触发时使用）

当用户提到一个**不在已知项目列表和缓存列表中的**仓库名时，按以下顺序查找：

1. **本地缓存** — 运行 \`find ${cacheDir} -maxdepth 3 -name "*.git" -type d\`，查找匹配的 bare clone。如果找到，从缓存路径推导 URL（如 \`${cacheDir}/github.com/org/repo.git\` → \`https://github.com/org/repo\`），返回 \`clone_remote\`。**不要凭猜测构造 URL。**
2. **项目目录** — \`ls ${projectsDir}\`，看有没有匹配的目录。**注意：只有包含 \`.git\` 子目录的才是有效仓库**，编译产物目录（如 \`xxx-target\`、\`build\`）不是仓库，不要选它们。如果目录名只是部分匹配（如 \`talktype-target\` 不等于 \`talktype\`），优先继续查找更精确的匹配。
3. **GitHub 搜索** — \`gh search repos <关键词> --json fullName,url --limit 20\`（不要用 \`gh repo list\`）
4. 都找不到 → 用户给了 URL 就用 URL；否则 \`need_clarification\`

**重要：缓存中的 bare clone 不能直接用作工作目录，必须通过 \`clone_remote\` 让系统创建隔离工作区。**

## 输出格式

直接输出一个 JSON 代码块（且仅输出此 JSON，不要有其他文字）：

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
- **use_default**: 不涉及特定仓库。无需额外字段
- **need_clarification**: 信息不足。必填 question

## 规则
- mode：用户要修改代码、提 PR、修 bug → "writable"；只是看看、分析 → "readonly"；不确定 → "writable"
- branch 字段可选，不确定就不填
- 不要开始执行用户的实际任务，不要修改文件，不要 clone 仓库`;
}

/** 构建路由 prompt（截断过长消息，routing 只需判断目标仓库） */
function buildRoutingPrompt(userMessage: string): string {
  const MAX_ROUTING_PROMPT_LENGTH = 1500;
  if (userMessage.length <= MAX_ROUTING_PROMPT_LENGTH) {
    return userMessage;
  }
  return userMessage.slice(0, MAX_ROUTING_PROMPT_LENGTH) + '\n\n[消息过长，已截断。请根据上述内容判断目标仓库]';
}

/** 解析 Claude 输出中的 JSON 决策 */
function parseRoutingDecision(output: string): RoutingDecision | null {
  // 尝试从 markdown 代码块中提取 JSON
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : output.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    const { decision, workdir, repo_url, mode, branch, question } = parsed;

    if (!['use_existing', 'clone_remote', 'use_default', 'need_clarification'].includes(decision)) {
      logger.warn({ output: output.slice(0, 500) }, 'Invalid routing decision type');
      return null;
    }

    return {
      decision,
      workdir,
      repo_url,
      mode: mode === 'readonly' ? 'readonly' : mode === 'writable' ? 'writable' : undefined,
      branch,
      question,
    };
  } catch {
    logger.warn({ output: output.slice(0, 500) }, 'Failed to parse routing decision JSON');
    return null;
  }
}

/** 获取 fallback 工作目录 */
function getFallbackWorkdir(): string {
  return config.claude.defaultWorkDir;
}

/**
 * 运行路由 agent，决定用户请求的目标工作区
 *
 * 路由 agent 是一次性的：每次调用都是全新 session，不走 resume 路径。
 * 不受 systemPromptHash 的影响。
 */
export async function routeWorkspace(
  prompt: string,
  chatId: string,
  userId: string,
  /** 话题标识（用于 session key 隔离），优先传 thread_id，fallback root_id */
  threadId?: string,
): Promise<RoutingDecision> {
  logger.info(
    { chatId, userId, promptLength: prompt.length },
    'Starting routing agent',
  );

  const projects = discoverLocalProjects(config.claude.defaultWorkDir);

  let result;
  try {
    result = await claudeExecutor.execute({
      sessionKey: threadId ? `routing:${chatId}:${userId}:${threadId}` : `routing:${chatId}:${userId}`,
      prompt: buildRoutingPrompt(prompt),
      workingDir: config.claude.defaultWorkDir,
      systemPromptOverride: buildRoutingSystemPrompt(projects),
      disableWorkspaceTool: true,
      model: 'claude-sonnet-4-6',
      settingSources: [],
      maxTurns: 10,
      maxBudgetUsd: 1.0,
      timeoutSeconds: 60, // 单步空闲超时
      hardTimeoutSeconds: 120, // 总执行时长硬上限
    });
  } catch (err) {
    logger.error({ err, chatId, userId }, 'Routing agent execution failed');
    return { decision: 'use_default', workdir: getFallbackWorkdir() };
  }

  logger.info(
    { chatId, userId, success: result.success, costUsd: result.costUsd, durationMs: result.durationMs },
    'Routing agent completed',
  );

  if (!result.success || !result.output) {
    logger.warn({ chatId, userId, error: result.error }, 'Routing agent failed, using fallback');
    return { decision: 'use_default', workdir: getFallbackWorkdir() };
  }

  const decision = parseRoutingDecision(result.output);
  if (!decision) {
    logger.warn({ chatId, userId }, 'Could not parse routing decision, using fallback');
    return { decision: 'use_default', workdir: getFallbackWorkdir() };
  }

  logger.info(
    { chatId, userId, decision },
    'Routing decision',
  );

  // 验证 use_existing 的 workdir 存在且是 git 仓库
  if (decision.decision === 'use_existing') {
    if (!decision.workdir) {
      logger.warn({ chatId, userId }, 'use_existing decision missing workdir, using fallback');
      return { decision: 'use_default', workdir: getFallbackWorkdir() };
    }
    try {
      statSync(decision.workdir);
    } catch {
      logger.warn({ chatId, userId, workdir: decision.workdir }, 'use_existing workdir does not exist');
      return {
        decision: 'use_default',
        workdir: getFallbackWorkdir(),
        warning: `⚠️ 路由目标目录 \`${decision.workdir}\` 不存在，已回退到默认目录`,
      };
    }
    // 验证目标目录是 git 仓库（防止匹配到编译产物等非仓库目录）
    if (!existsSync(join(decision.workdir, '.git'))) {
      logger.warn({ chatId, userId, workdir: decision.workdir }, 'use_existing workdir is not a git repository');
      return {
        decision: 'use_default',
        workdir: getFallbackWorkdir(),
        warning: `⚠️ 路由目标目录 \`${decision.workdir}\` 不是 git 仓库，已回退到默认目录`,
      };
    }
  }

  // clone_remote: 验证 repo_url 非空
  if (decision.decision === 'clone_remote' && !decision.repo_url) {
    logger.warn({ chatId, userId }, 'clone_remote decision missing repo_url, using fallback');
    return { decision: 'use_default', workdir: getFallbackWorkdir() };
  }

  // need_clarification: 验证 question 非空
  if (decision.decision === 'need_clarification' && !decision.question) {
    logger.warn({ chatId, userId }, 'need_clarification decision missing question, using fallback');
    return { decision: 'use_default', workdir: getFallbackWorkdir() };
  }

  return decision;
}
