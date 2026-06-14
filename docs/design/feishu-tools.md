---
summary: "飞书 MCP 工具集：doc/wiki/drive/bitable/chat/calendar/contact/task + 主聊天/图片发送/消息下载"
related_paths:
  - src/feishu/tools/**
last_updated: "2026-06-14"
---

# 飞书 MCP 工具集

> 本文档待补充。下次修改 `src/feishu/tools/` 时请完善现状描述。

## 模块概览

通过 `createFeishuToolsMcpServer()` 将飞书 API 以 MCP 工具形式注入 Claude Agent SDK。

### 工具清单

| 工具 | 文件 | 功能 |
|------|------|------|
| `feishu_doc` | `doc.ts` | 文档读写（含 Markdown → Block 转换） |
| `feishu_wiki` | `wiki.ts` | 知识库空间/节点操作 |
| `feishu_drive` | `drive.ts` | 云空间文件浏览 |
| `feishu_bitable` | `bitable.ts` | 多维表格 CRUD |
| `feishu_chat` | `chat.ts` | 群聊信息 |
| `feishu_calendar` | `calendar.ts` | 日历操作 |
| `feishu_contact` | `contact.ts` | 通讯录查询 |
| `feishu_task` | `task.ts` | 任务管理 |
| `feishu_send_to_chat` | `main-chat.ts` | 话题内将消息发送到群主聊天（仅 chatId 存在时注册） |
| `feishu_send_image` | `send-image.ts` | 把工作区本地图片发到当前会话/话题（仅 chatId 存在时注册） |
| `feishu_download_message_file` | `message.ts` | 按需下载历史消息中的文件（始终注册） |
| `feishu_download_message_image` | `image.ts` | 按需下载历史消息中的图片（始终注册） |

> 说明：上表前 8 个工具受 `config.feishu.tools.*` 子开关控制；后 4 个不走子开关——`feishu_send_to_chat`/`feishu_send_image` 在 `chatId` 存在时注册，两个下载工具始终注册。

### 关键设计决策

- **Action-based dispatch**：每个工具内含多个 action（read/write/create/...），用 Zod discriminatedUnion 定义
- **图片发送落点**：`feishu_send_image` 上传图片拿 `image_key` 后，依据闭包绑定的 `threadReplyMsgId` 决定回复到话题（`replyImageInThread`）或发送到会话（`sendImage`）；`threadReplyMsgId` 由 executor 透传 `ExecuteInput.threadRootMessageId`。注意 `im.image.create` 直接返回已解包的 `{ image_key }`，与其它 message 接口的 `{ code, msg, data }` 结构不同
- **权限控制**：`permissions.ts` 按 read-only 模式过滤写操作
- **参数校验**：`validation.ts` 统一校验 token 格式
- **Markdown 转换**：`markdown-to-blocks.ts` 将 Markdown 转为飞书 Block 结构
