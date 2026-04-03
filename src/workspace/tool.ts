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
          '',
          '不要在以下情况使用：',
          '- 用户的问题是通用的，不指向特定仓库',
          '- 当前工作目录已经是正确的仓库',
          '- 不要用此工具切换当前工作区的模式（readonly/writable）',
          '',
          '通常使用 mode="writable" 创建可修改的隔离工作区和 feature 分支。',
          '调用后仅输出简短确认，不要继续执行后续任务（系统会自动重启）。',
        ].join('\n'),
        {
          repo_url: z.string().optional().describe('远程仓库 URL (如 https://github.com/user/repo)'),
          local_path: z.string().optional().describe('本地仓库绝对路径'),
          mode: z.enum(['readonly', 'writable']).describe('访问模式: readonly 只读分析, writable 修改代码'),
          source_branch: z.string().optional().describe('源分支名 (默认使用仓库默认分支)'),
          feature_branch: z.string().optional().describe('自定义 feature 分支名 (默认自动生成, 仅 writable 模式)'),
        },
        async (args) => {
          logger.info({ args: { repo_url: args.repo_url, local_path: args.local_path, mode: args.mode } }, 'setup_workspace tool invoked');
          try {
            const result = setupWorkspace({
              repoUrl: args.repo_url,
              localPath: args.local_path,
              mode: args.mode,
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
