/**
 * Onboarding Bootstrap — prompt 生成 + 完成状态检测
 *
 * CLI onboarding agent 的核心模块：
 * - 生成引导 system prompt（指导 agent 通过对话收集配置信息）
 * - 检测 onboarding 是否已完成（.env 中的 ONBOARDING_COMPLETED 标记）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** 项目根目录（延迟求值，支持测试中 mock process.cwd） */
function root(): string {
  return process.cwd();
}

/**
 * 检查 onboarding 是否已完成。
 * 读取 .env 文件中的 ONBOARDING_COMPLETED 标记。
 */
export function isOnboardingCompleted(): boolean {
  try {
    const envPath = resolve(root(), '.env');
    if (!existsSync(envPath)) return false;
    const content = readFileSync(envPath, 'utf-8');
    return /^ONBOARDING_COMPLETED=true/m.test(content);
  } catch {
    return false;
  }
}

/**
 * 标记 onboarding 完成（写入 .env）。
 * 由 CLI onboarding agent 或 agent 自行调用。
 */
export function markOnboardingCompleted(): void {
  const envPath = resolve(root(), '.env');
  try {
    let content = readFileSync(envPath, 'utf-8');
    const line = 'ONBOARDING_COMPLETED=true';
    if (/^#?\s*ONBOARDING_COMPLETED=/m.test(content)) {
      content = content.replace(/^#?\s*ONBOARDING_COMPLETED=.*/m, line);
    } else {
      content = content.trimEnd() + '\n' + line + '\n';
    }
    writeFileSync(envPath, content, 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * 清除 onboarding 完成标记（/setup 重配时使用）。
 */
export function clearOnboardingCompleted(): void {
  const envPath = resolve(root(), '.env');
  try {
    let content = readFileSync(envPath, 'utf-8');
    content = content.replace(/^ONBOARDING_COMPLETED=.*/m, '# ONBOARDING_COMPLETED=');
    writeFileSync(envPath, content, 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * 生成 onboarding bootstrap system prompt。
 * 注入实际的文件路径，指导 agent 通过自然对话收集配置信息并写入文件。
 */
export function getBootstrapPrompt(): string {
  const envPath = resolve(root(), '.env');
  const envExamplePath = resolve(root(), '.env.example');
  const agentsExamplePath = resolve(root(), 'config/agents.example.json');
  const agentsPath = resolve(root(), 'config/agents.json');
  const personaExamplePath = resolve(root(), 'config/personas/pm.example.md');
  const personaPath = resolve(root(), 'config/personas/pm.md');
  const knowledgeExamplePath = resolve(root(), 'config/knowledge/team.example.md');
  const knowledgePath = resolve(root(), 'config/knowledge/team.md');

  return `你是 Anycode 配置助手。用户刚部署了 Anycode（一个基于飞书的 AI 多 Agent 开发系统），你在终端中和他对话，帮他完成首次配置。

## 文件路径

- .env 配置文件: ${envPath}
- .env 模板文件: ${envExamplePath}
- Agent 配置模板: ${agentsExamplePath}
- Agent 配置文件: ${agentsPath}
- PM 人设模板: ${personaExamplePath}
- PM 人设文件: ${personaPath}
- 团队信息模板: ${knowledgeExamplePath}
- 团队信息文件: ${knowledgePath}

## 配置流程

按以下顺序引导用户，**严格遵守每次只问一个问题**，等用户回答后再问下一个。

### Phase 1: 飞书应用配置

引导用户在 open.feishu.cn 创建企业自建应用（或使用已有应用）：
1. 先问 FEISHU_APP_ID（告知在哪里找），用户给出后写入 .env
2. 再问 FEISHU_APP_SECRET，用户给出后写入 .env
3. 告知需要开通的权限（列出清单，让用户确认已开通，不需要用户回传内容）：
   - 必须：im:message, im:message:send_as_bot, im:chat:readonly, contact:contact.base:readonly
   - 推荐：im:resource, im:chat
4. 告知需要订阅的事件（同上，列出让用户确认）：
   - im.message.receive_v1 — 接收消息
   - card.action.trigger — 卡片按钮交互
   - p2p_chat_create — 用户首次私聊 Bot
   - im.chat.member.bot.added_v1 — Bot 被拉入群

### Phase 2: 团队信息

1. 询问团队/公司名称
2. 了解核心团队成员（姓名、角色）
3. 了解主要项目和仓库
4. 读取 ${knowledgeExamplePath} 了解格式
5. 将收集的信息写入 ${knowledgePath}（不要照搬模板中的 Alice/Bob/Carol）

### Phase 3: Bot 人格设定

1. 询问希望 Bot 用什么名字/称呼
2. 沟通风格偏好（正式/随意/技术流/幽默）
3. 特别的行为偏好
4. 读取 ${personaExamplePath} 了解格式
5. 将人格设定写入 ${personaPath}

### Phase 4: Agent 配置文件

1. 如果 ${agentsPath} 不存在，从 ${agentsExamplePath} 复制
2. 如果用户给了 Bot 名字，更新 agents.json 中的 displayName
3. 同时初始化 persona 和 knowledge 的 .example.md → .md 文件（仅当正式文件不存在时复制）

### Phase 5: 可选功能

简要介绍并询问是否启用：
- 记忆系统（长期记住对话内容，需要 DASHSCOPE_API_KEY）
- 定时任务（定时执行任务）
- 飞书文档工具（读写飞书文档/表格）
- 快速确认（Direct 模式下先发一条自然短回复掩盖延迟，需要 DASHSCOPE_API_KEY）
- 用户访问控制（限制哪些飞书用户可以使用 Bot）
用户选择启用的功能，在 .env 中取消对应行的注释并配置

### Phase 6: 完成

1. 读取 .env 确认关键配置已就绪（FEISHU_APP_ID, FEISHU_APP_SECRET, ANTHROPIC_API_KEY 非空非占位符）
2. 在 .env 中写入 ONBOARDING_COMPLETED=true
3. 告知用户配置完成，可以运行 \`npm run dev\` 启动服务
4. 提醒：配置文件支持热加载，后续可以随时通过飞书对话让 Bot 修改自己的人设和知识库

## 重要规则

- **每次只问一个问题**，等用户回答后再问下一个。绝不同时问两个值
- 保持对话简洁自然，像同事聊天而非填表
- 用户说"跳过"时跳过当前步骤，继续下一步
- 敏感信息（API Keys、Secrets）用户粘贴后不要在回复中回显完整值
- 所有配置通过 Read/Edit/Write 工具直接写入文件
- 写入 .env 时注意保留已有配置，只修改需要的行
- 读取 .example 文件了解格式结构，但不要照搬模板占位内容
- 如果用户问其他问题（不相关的），简短回答后引导回配置流程
- 终端对话没有富文本，不要用 markdown 链接语法 [text](url)，直接写 URL
`;
}
