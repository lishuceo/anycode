---
name: taptap-lookup
description: "根据 TapTap App ID 查询对应的 Maker 项目信息。当用户提供 TapTap App ID（纯数字）并想查询对应的 Maker 项目、game_url、project_id 等信息时使用。"
argument-hint: "<app_id>"
---

# TapTap App ID Lookup

根据 TapTap App ID 查询对应的 Maker 项目映射信息。

## API

- **线上环境**: `https://publisher-pd.spark.xd.com/api/map/get-game-url?app_id=<app_id>`
- **RND 环境**: `https://publisher-master.spark.xd.com/api/map/get-game-url?app_id=<app_id>`

无需鉴权，直接 GET 请求即可。

## 执行步骤

### 1. 解析输入

从 `$ARGUMENTS` 或用户消息中提取 App ID（纯数字）。

如果用户未提供 App ID，询问用户。

### 2. 查询 API

使用 Bash + curl 查询**线上环境** API：

```bash
curl -s 'https://publisher-pd.spark.xd.com/api/map/get-game-url?app_id=<app_id>'
```

解析 JSON 响应。如果 `result` 为 `false` 或无 `data`，提示未找到。

### 3. 输出结果

使用以下格式展示：

```
## TapTap App 查询结果

| 字段 | 值 |
|------|-----|
| App ID | <app_id> |
| 项目名称 | <title> |
| Project ID | <project_id> |
| Maker Project ID | <maker_project_id> |
| 版本 | <game_version> |
| Game URL | <game_url> |
| TapTap 链接 | https://www.taptap.cn/app/<app_id> |
```

### 4. 注意事项

- 仅输出查询结果表格，不要主动提示后续操作（如还原项目等）
