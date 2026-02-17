import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { setupWorkspace } from './manager.js';
import { logger } from '../utils/logger.js';

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
        'setup_workspace',
        [
          '为代码修改任务创建隔离工作区。',
          '将远程仓库 URL 或本地仓库路径 clone 到独立目录，并创建 feature 分支。',
          'clone 完成后会自动切换工作目录到新的工作区。',
          '',
          '使用场景:',
          '- 用户提供 GitHub/GitLab 等远程仓库 URL 需要修改代码时',
          '- 用户指定本地仓库路径需要在隔离环境中修改时',
          '- 需要确保修改不影响原始仓库时',
        ].join('\n'),
        {
          repo_url: z.string().optional().describe('远程仓库 URL (如 https://github.com/user/repo)'),
          local_path: z.string().optional().describe('本地仓库绝对路径'),
          source_branch: z.string().optional().describe('源分支名 (默认使用仓库默认分支)'),
          feature_branch: z.string().optional().describe('自定义 feature 分支名 (默认自动生成)'),
        },
        async (args) => {
          try {
            const result = setupWorkspace({
              repoUrl: args.repo_url,
              localPath: args.local_path,
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

            const statusText = result.reused ? '(复用已有工作区)' : '(新建)';

            return {
              content: [
                {
                  type: 'text' as const,
                  text: [
                    `工作区已就绪 ${statusText}`,
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
