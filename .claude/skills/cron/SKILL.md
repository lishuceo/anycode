---
name: cron
description: "列出和管理当前群聊的定时任务。当用户想查看、管理、删除定时任务时使用。"
argument-hint: "[list | trigger <id> | remove <id> | pause <id> | resume <id>]"
---

# 定时任务管理

列出和管理当前群聊的 cron 定时任务。

## 子命令

| 命令 | 说明 |
|------|------|
| `/cron` 或 `/cron list` | 列出当前群聊所有定时任务 |
| `/cron trigger <id>` | 立即触发一次指定任务 |
| `/cron remove <id>` | 删除指定任务 |
| `/cron pause <id>` | 暂停指定任务 |
| `/cron resume <id>` | 恢复指定任务 |

## 执行步骤

### 1. 解析子命令

从 `$ARGUMENTS` 中解析子命令和参数。如果为空或为 `list`，执行列出操作。

### 2. 列出任务 (list)

调用 `mcp__cron-scheduler__manage_cron` 工具，`action: "list"`。

如果没有任务，回复："当前群聊没有定时任务。"

如果有任务，用表格展示：

```
## 定时任务列表

| 状态 | 名称 | 调度 | 下次执行 | ID |
|------|------|------|----------|-----|
| ✅ | 每日汇报 | 每天 09:00 | 2026-03-19 09:00 | abc123... |
| ⏸️ | 周报提醒 | 每周五 18:00 | (已暂停) | def456... |
```

状态图标：✅ 运行中，⏸️ 已暂停。

表格后附操作提示：
```
操作: `/cron trigger <id>` 立即执行 | `/cron pause <id>` 暂停 | `/cron remove <id>` 删除
```

### 3. 立即触发 (trigger)

调用 `mcp__cron-scheduler__manage_cron`，`action: "trigger"`, `id: "<id>"`。

回复：已触发任务「<名称>」。

### 4. 删除任务 (remove)

调用 `mcp__cron-scheduler__manage_cron`，`action: "remove"`, `id: "<id>"`。

回复：已删除任务「<名称>」。

### 5. 暂停/恢复 (pause / resume)

调用 `mcp__cron-scheduler__manage_cron`，`action: "update"`, `id: "<id>"`, `enabled: false`（暂停）或 `enabled: true`（恢复）。

回复：已暂停/恢复任务「<名称>」。

### 6. 注意事项

- ID 支持前缀匹配，用户不需要输入完整 ID
- 如果匹配到多个任务，列出候选让用户选择
- 仅展示操作结果，不要主动建议后续操作
