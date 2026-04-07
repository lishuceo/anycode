---
name: restore-project
description: "从 CDN 下载指定项目的构建产物，还原为本地可编辑的项目结构，供排查用户问题使用。当用户说\"还原项目\"、\"拉取项目\"、\"下载项目\"、\"restore project\"，或提供了 project_id、game_url、maker/fuping 链接、app_id 等任意项目标识并要求拉取/还原/排查时使用此技能。也应在用户粘贴了 maker.taptap.cn、fuping.agnt.xd.com、*.games.tapapps.cn、*.ipv.taptap-code.org 等链接并希望查看/调试/运行该项目时触发。"
---

# 项目还原 (Restore Project)

从 CDN 下载 TapCode 项目的构建产物，还原为本地可编辑的项目结构。

本 skill 自包含还原脚本，位于 `scripts/project_restorer.py`（纯 Python 标准库，零外部依赖）。

## 支持的输入格式

用户可能提供以下任意一种项目标识：

| 格式 | 示例 |
|------|------|
| game_url | `https://<uuid>.games.tapapps.cn` |
| game_url | `https://<uuid>.ipv.taptap-code.org` |
| share game_url | `https://s-<share_id>.games.tapapps.cn` |
| tapcode URL | `https://tapcode-sce.spark.xd.com/src/<project_id>/` |
| maker 链接 | `https://maker.taptap.cn/app/<uuid>?chatId=...` |
| maker 分享链接 | `https://maker.taptap.cn/shares/<share_id>` |
| fuping 链接 | `https://fuping.agnt.xd.com/app/<uuid>?chatId=...` |
| TapTap 链接 | `https://www.taptap.cn/app/805630` |
| app_id | `805630` |
| 游戏名称 | `豆战异世界` |
| project_id | `p_60r1` |

版本参数可选（如 `1.0.2`、`latest`、`stable`），默认 `latest`。

## 执行步骤

### 1. 解析输入

从用户消息中提取项目标识和可选的版本号。

判断参数类型：
- TapTap 链接 (`taptap.cn/app/<数字>`) → 传 `--game-url`（脚本自动检测并走 API）
- 其他包含 `://` 的 URL → 传 `--game-url`
- 纯数字 → 传 `--app-id`
- 以 `p_` 开头 → 传 `--project`
- 非 URL、非 project_id 的文本 → 传 `--title`

如果用户未提供任何项目标识，询问用户提供链接或 project_id。

### 2. 定位脚本

脚本路径为本 skill 目录下的 `scripts/project_restorer.py`。

获取方式：找到本 SKILL.md 所在目录，拼接 `scripts/project_restorer.py`。
即：`.claude/skills/restore-project/scripts/project_restorer.py`

### 3. 执行还原

```bash
# SCRIPT_PATH = <项目根目录>/.claude/skills/restore-project/scripts/project_restorer.py

# URL 输入 (game_url, portal URL, TapTap 链接)
python <SCRIPT_PATH> --game-url <url> --verbose

# app_id 输入
python <SCRIPT_PATH> --app-id <app_id> --verbose

# 游戏名称输入
python <SCRIPT_PATH> --title <游戏名称> --verbose

# project_id 输入
python <SCRIPT_PATH> --project <project_id> --verbose

# 指定版本
python <SCRIPT_PATH> --game-url <url> --version <version> --verbose
```

如果 `python` 不可用，依次尝试 `python3`，最后使用完整路径（参考 memory 中记录的 Python 路径）。

### 4. 验证还原结果

- 检查命令退出码，非 0 则报告失败原因并停止
- 读取还原目录下的 `.restore_info.json` 和 `.project/project.json`

### 5. 输出摘要

使用以下格式输出结果。

**开发预览页**：还原流程中 lookup API（`get-game-url`）的返回值已包含 `maker_project_id` 字段（即 pod UUID），无需额外请求，直接拼接 `https://<maker_project_id>.games.tapapps.cn/` 即可。如果该字段不存在（如直接通过 game_url 还原、未走 lookup），则省略此行。

```
## 项目还原完成

| 字段 | 值 |
|------|-----|
| 项目 ID | <project_id from project.json> |
| 原始项目 ID | <original_project_id from restore_info> |
| 版本 | <version> |
| Game URL | <game_url> |
| 开发预览页 | https://<maker_project_id>.games.tapapps.cn/ |
| 文件数量 | <total_files> 个 |
| 入口脚本 | <entry> |
| 还原目录 | <绝对路径> |

可使用 `/deploy-test-project <还原目录>` 构建并部署到 CDN 进行测试。
```

## 后续操作提示

还原完成后，根据用户意图提供后续建议：
- 想运行项目 → 提示使用 UrhoXRuntime 本地运行
- 想排查问题 → 阅读入口脚本，分析代码
- 想部署测试 → 提示使用 `/deploy-test-project`
