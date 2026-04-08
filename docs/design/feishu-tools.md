---
summary: "飞书 MCP 工具集：doc/wiki/drive/bitable/chat/calendar/contact/task"
related_paths:
  - src/feishu/tools/**
last_updated: "2026-04-02"
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

### 关键设计决策

- **Action-based dispatch**：每个工具内含多个 action（read/write/create/...），用 Zod discriminatedUnion 定义
- **权限控制**：`permissions.ts` 按 read-only 模式过滤写操作
- **参数校验**：`validation.ts` 统一校验 token 格式
- **Markdown 转换**：`markdown-to-blocks.ts` 将 Markdown 转为飞书 Block 结构
