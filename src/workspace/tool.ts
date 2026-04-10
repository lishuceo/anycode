import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { setupWorkspace } from './manager.js';
import { logger } from '../utils/logger.js';
import { toCanonicalUrl, updateRegistryEntry, extractRepoMeta } from './registry.js';
import { sanitizeRepoUrl } from './cache.js';

// ============================================================
// Workspace MCP 工具
//
// 通过 createSdkMcpServer 定义 setup_workspace 工具，
// Claude Code 在检测到用户需要修改代码时自动调用。
// 工具执行 git clone + 创建分支，并通过回调更新 session.workingDir。
//
// 每次 query 创建独立的 MCP 服务器实例，将 session 回调
// 通过闭包绑定，避免全局可变状态的并发竞态问题。
// ============================================================

/** session 更新回调类型 */
export type SessionUpdater = (newWorkingDir: string) => void;

/**
 * 创建工作区管理 MCP 服务器
 *
 * 每次 query 调用时创建新实例，通过闭包绑定当前 session 的回调，
 * 确保多 chat 并发执行时互不干扰。
 *
 * @param onWorkspaceChanged  工作区变更后的回调（更新 session.workingDir）
 */
export function createWorkspaceMcpServer(onWorkspaceChanged?: SessionUpdater) {
  return createSdkMcpServer({
    name: 'workspace-manager',
    version: '1.0.0',
    tools: [
      tool(
        'update_repo_registry',
        [
          '更新仓库 registry 中某个仓库的描述或关键词。',
          '',
          '使用场景：',
          '- 用户澄清了某个仓库的用途后，记录关键词以便下次自动匹配',
          '- 例如用户说"推荐系统是 rec-engine"，给 rec-engine 添加关键词"推荐系统"',
          '',
          '注意：repo_url 必须是 registry 中已有的 canonical URL（见 .repo-registry.json 中的键名）。',
        ].join('\n'),
        {
          repo_url: z.string().describe('仓库的 canonical URL（registry 中的 ID）'),
          description: z.string().optional().describe('仓库描述'),
          keywords: z.array(z.string()).optional().describe('追加的关键词列表'),
        },
        async (args) => {
          logger.info({ args }, 'update_repo_registry tool invoked');
          try {
            updateRegistryEntry(args.repo_url, {
              description: args.description,
              keywords: args.keywords,
            }, undefined, true);
            return {
              content: [{
                type: 'text' as const,
                text: `Registry 已更新: ${args.repo_url}`,
              }],
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error({ err: errorMsg }, 'update_repo_registry failed');
            return {
              content: [{
                type: 'text' as const,
                text: `Registry 更新失败: ${errorMsg}`,
              }],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ),
      tool(
        'setup_workspace',
        [
          '为代码任务创建隔离工作区。',
          '',
          '当你判断用户的请求明确指向某个特定仓库或项目，且当前工作目录不是该仓库时，',
          '使用此工具切换到正确的工作区。切换后系统会自动重启以加载项目配置。',
          '',
          '应该使用的场景：',
          '- 用户提到了仓库 URL（如 github.com/org/repo）',
          '- 用户提到了已知的项目名（参考 system prompt 中的可用项目列表）',
          '- 用户描述的代码/功能明显属于另一个仓库',
          '- 用户说"切换到 X"、"去 X 仓库"',
          '- 用户提到某个项目的文件（如 "X 项目的 CLAUDE.md"、"Y 的配置"）',
          '- 用户讨论特定项目的架构、代码或实现细节',
          '- 需要查看实际源码才能准确回答用户问题（不要凭记忆回答代码问题）',
          '',
          '不要在以下情况使用：',
          '- 用户的问题是通用的，不指向特定仓库',
          '- 当前工作目录已经是正确的仓库',
          '',
          '调用后仅输出简短确认，不要继续执行后续任务（系统会自动重启）。',
        ].join('\n'),
        {
          repo_url: z.string().optional().describe('远程仓库 URL (如 https://github.com/user/repo)'),
          local_path: z.string().optional().describe('本地仓库绝对路径'),
          source_branch: z.string().optional().describe('源分支名 (默认使用仓库默认分支)'),
          feature_branch: z.string().optional().describe('自定义 feature 分支名 (默认自动生成)'),
        },
        async (args) => {
          logger.info({ args: { repo_url: args.repo_url, local_path: args.local_path } }, 'setup_workspace tool invoked');
          try {
            const result = setupWorkspace({
              repoUrl: args.repo_url,
              localPath: args.local_path,
              mode: 'writable',
              sourceBranch: args.source_branch,
              featureBranch: args.feature_branch,
            });

            // 通过闭包绑定的回调更新 session 的 workingDir
            if (onWorkspaceChanged) {
              onWorkspaceChanged(result.workspacePath);
              logger.info(
                { workspacePath: result.workspacePath },
                'Session workingDir updated via MCP tool',
              );
            } else {
              logger.warn('No session updater set, workingDir not updated');
            }

            // 增量更新 registry：追加新条目 + 按需从工作区提取 description/techStack
            try {
              const repoUrl = args.repo_url || args.local_path;
              if (repoUrl) {
                const canonical = args.repo_url
                  ? toCanonicalUrl(sanitizeRepoUrl(args.repo_url))
                  : `local://${args.local_path}`;
                // 从新创建的工作区提取 meta（仅当 registry 条目缺少信息时有效）
                const meta = extractRepoMeta(result.workspacePath);
                updateRegistryEntry(canonical, {
                  description: meta.description,
                  techStack: meta.techStack,
                });
              }
            } catch (registryErr) {
              logger.debug({ err: registryErr }, 'Registry update after setup_workspace failed (non-blocking)');
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: [
                    '工作区已就绪',
                    `📂 路径: ${result.workspacePath}`,
                    `🌿 分支: ${result.branch}`,
                    `📦 仓库: ${result.repoName}`,
                    '',
                    '工作目录已自动切换到新工作区，后续操作将在此目录下执行。',
                  ].join('\n'),
                },
              ],
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error({ err: errorMsg }, 'setup_workspace failed');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `工作区创建失败: ${errorMsg}`,
                },
              ],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
      ),
    ],
  });
}
