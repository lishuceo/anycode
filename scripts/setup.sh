#!/usr/bin/env bash
# ============================================================
# Anycode 开发环境初始化脚本
# 用法: bash scripts/setup.sh
# ============================================================

set -euo pipefail

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✅${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠️${NC}  $*"; }
err()   { echo -e "${RED}❌${NC} $*"; }
header(){ echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }

# 项目根目录 (脚本所在的上一级)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 自动将 .example.md 复制为正式文件（仅当正式文件不存在时）
init_config_files() {
  for src in "$ROOT"/config/personas/*.example.md "$ROOT"/config/knowledge/*.example.md; do
    [[ -f "$src" ]] || continue
    dst="${src/.example.md/.md}"
    if [[ ! -f "$dst" ]]; then
      cp "$src" "$dst"
      ok "已创建 $(basename "$dst") ← 可编辑自定义"
    fi
  done
}

# ============================================================
# Step 1: 环境检测
# ============================================================
header "Step 1/6: 环境检测"

MISSING=0

check_file() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    ok "$label"
    return 0
  else
    err "$label — 缺失"
    return 1
  fi
}

check_file "node_modules/"       "$ROOT/node_modules"       || MISSING=$((MISSING+1))
check_file ".env"                "$ROOT/.env"               || MISSING=$((MISSING+1))
check_file "config/agents.json"  "$ROOT/config/agents.json" || MISSING=$((MISSING+1))
echo -e "${BLUE}ℹ${NC}  data/ — 首次启动时自动创建"

if [[ $MISSING -eq 0 ]]; then
  echo ""
  ok "所有配置已就绪！"
  read -rp "$(echo -e "${YELLOW}要重新配置吗？(y/N): ${NC}")" REDO
  if [[ "${REDO,,}" != "y" ]]; then
    info "退出，未做任何修改。"
    exit 0
  fi
fi

# ============================================================
# Step 2: 系统依赖检查
# ============================================================
header "Step 2/6: 系统依赖检查"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER="$(node -v)"
  ok "Node.js $NODE_VER"
  # 检查版本 >= 18
  MAJOR="${NODE_VER#v}"
  MAJOR="${MAJOR%%.*}"
  if [[ "$MAJOR" -lt 18 ]]; then
    err "需要 Node.js >= 18，当前 $NODE_VER"
    exit 1
  fi
else
  err "未找到 Node.js（需要 >= 18）"
  info "安装: https://nodejs.org/ 或使用 nvm"
  exit 1
fi

# 构建工具 (native 模块编译需要)
BUILD_TOOLS_OK=true
for tool in python3 make gcc; do
  if command -v "$tool" &>/dev/null; then
    ok "$tool"
  else
    warn "$tool 未找到 — native 模块 (better-sqlite3, sqlite-vec) 可能编译失败"
    BUILD_TOOLS_OK=false
  fi
done

if [[ "$BUILD_TOOLS_OK" == false ]]; then
  echo ""
  warn "缺少构建工具（native 模块编译需要）"

  # 检测包管理器并构造安装命令
  INSTALL_CMD=""
  if [[ -f /etc/debian_version ]]; then
    INSTALL_CMD="apt-get install -y python3 make gcc g++"
  elif [[ -f /etc/redhat-release ]]; then
    INSTALL_CMD="yum install -y python3 make gcc gcc-c++"
  elif [[ "$(uname)" == "Darwin" ]]; then
    INSTALL_CMD="xcode-select --install"
  fi

  if [[ -n "$INSTALL_CMD" ]]; then
    # root 用户不需要 sudo
    if [[ "$(id -u)" -eq 0 ]]; then
      SUDO=""
    else
      SUDO="sudo "
    fi
    info "将执行: ${SUDO}$INSTALL_CMD"
    read -rp "$(echo -e "${YELLOW}自动安装？(Y/n): ${NC}")" AUTO_INSTALL
    if [[ "${AUTO_INSTALL,,}" != "n" ]]; then
      ${SUDO}$INSTALL_CMD
      ok "构建工具安装完成"
    else
      warn "跳过构建工具安装 — npm install 阶段 native 模块可能编译失败"
    fi
  else
    warn "无法识别包管理器，请手动安装 python3 make gcc"
    warn "继续执行，但 native 模块可能编译失败"
  fi
fi

# ============================================================
# Step 3: 安装 npm 依赖
# ============================================================
header "Step 3/6: 安装依赖"

if [[ -d "$ROOT/node_modules" ]]; then
  ok "node_modules/ 已存在，跳过 npm install"
else
  info "运行 npm install ..."
  npm install
  ok "依赖安装完成"
fi

# 验证 native 模块
echo ""
if node -e "require('better-sqlite3')" 2>/dev/null; then
  ok "better-sqlite3 编译正常"
else
  err "better-sqlite3 编译失败，请检查构建工具"
  exit 1
fi

if node -e "require('sqlite-vec')" 2>/dev/null; then
  ok "sqlite-vec 编译正常"
else
  warn "sqlite-vec 编译失败 — 记忆系统将降级为 BM25 文本搜索（不影响核心功能）"
fi

# ============================================================
# Step 4: 配置 .env
# ============================================================
header "Step 4/6: 配置 .env"

# 转义 sed 替换字符串中的特殊字符 (|, &, \)
sed_escape() { printf '%s\n' "$1" | sed 's/[&|\\]/\\&/g'; }

configure_env() {
  # 用 .env.example 作为基底
  if [[ ! -f "$ROOT/.env.example" ]]; then
    err ".env.example 不存在，无法生成 .env"
    return 1
  fi

  cp "$ROOT/.env.example" "$ROOT/.env"

  echo -e "${BOLD}必填配置${NC}（回车跳过，稍后手动编辑 .env）\n"

  # FEISHU_APP_ID
  info "飞书 App ID — 在 open.feishu.cn 创建应用后获取"
  read -rp "  FEISHU_APP_ID: " FEISHU_APP_ID
  if [[ -n "$FEISHU_APP_ID" ]]; then
    sed -i "s|^FEISHU_APP_ID=.*|FEISHU_APP_ID=$(sed_escape "$FEISHU_APP_ID")|" "$ROOT/.env"
  fi

  # FEISHU_APP_SECRET
  info "飞书 App Secret — 与 App ID 同一页面获取"
  read -rp "  FEISHU_APP_SECRET: " FEISHU_APP_SECRET
  if [[ -n "$FEISHU_APP_SECRET" ]]; then
    sed -i "s|^FEISHU_APP_SECRET=.*|FEISHU_APP_SECRET=$(sed_escape "$FEISHU_APP_SECRET")|" "$ROOT/.env"
  fi

  # 飞书权限提示
  echo ""
  echo -e "${BOLD}${YELLOW}📋 飞书应用权限配置${NC}"
  echo ""
  echo "  请在飞书开放平台 (open.feishu.cn) 为应用开通以下权限："
  echo ""
  echo -e "  ${BOLD}必须开通：${NC}"
  echo "    • im:message                    — 发送和接收消息"
  echo "    • im:message:send_as_bot        — 以 Bot 身份发消息"
  echo "    • im:chat:readonly              — 读取群信息"
  echo "    • contact:contact.base:readonly — 读取用户基本信息"
  echo ""
  echo -e "  ${BOLD}推荐开通：${NC}"
  echo "    • im:resource                   — 读取图片/文件资源"
  echo "    • im:chat                       — 群管理（Bot 入群等）"
  echo ""
  echo -e "  ${BOLD}事件订阅：${NC}"
  echo "    • im.message.receive_v1         — 接收消息事件"
  echo "    • card.action.trigger           — 卡片按钮交互回调（AskUser 等）"
  echo "    • p2p_chat_create               — 用户首次私聊 Bot"
  echo "    • im.chat.member.bot.added_v1   — Bot 被拉入群"
  echo ""
  echo -e "  路径: 开发者后台 → 权限管理 → 搜索上述权限名 → 开通"
  echo -e "  事件: 开发者后台 → 事件与回调 → 添加事件"
  echo ""
  read -rp "$(echo -e "${YELLOW}确认已配置好权限后回车继续...${NC}")" _DUMMY

  # ANTHROPIC_API_KEY
  info "Anthropic API Key — 在 console.anthropic.com/settings/keys 获取"
  read -rp "  ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
  if [[ -n "$ANTHROPIC_API_KEY" ]]; then
    sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$(sed_escape "$ANTHROPIC_API_KEY")|" "$ROOT/.env"
  fi

  # ANTHROPIC_BASE_URL
  info "Anthropic API Base URL — 使用代理或第三方兼容端点时填写，直连官方 API 回车跳过"
  read -rp "  ANTHROPIC_BASE_URL (回车=官方地址): " ANTHROPIC_BASE_URL
  if [[ -n "$ANTHROPIC_BASE_URL" ]]; then
    sed -i "s|^# ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=$(sed_escape "$ANTHROPIC_BASE_URL")|" "$ROOT/.env"
    sed -i "s|^# *ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=$(sed_escape "$ANTHROPIC_BASE_URL")|" "$ROOT/.env"
  fi

  # 可选功能
  echo ""
  echo -e "${BOLD}可选功能${NC}（输入 y 启用，回车跳过）\n"

  # 记忆系统
  read -rp "$(echo -e "  启用${CYAN}记忆系统${NC}？需要 DashScope API Key (y/N): ")" ENABLE_MEMORY
  if [[ "${ENABLE_MEMORY,,}" == "y" ]]; then
    sed -i "s|^# MEMORY_ENABLED=.*|MEMORY_ENABLED=true|" "$ROOT/.env"
    sed -i "s|^# *MEMORY_ENABLED=.*|MEMORY_ENABLED=true|" "$ROOT/.env"
    info "DashScope API Key — 在 dashscope.console.aliyun.com 获取"
    read -rp "  DASHSCOPE_API_KEY: " DASHSCOPE_API_KEY
    if [[ -n "$DASHSCOPE_API_KEY" ]]; then
      sed -i "s|^# DASHSCOPE_API_KEY=.*|DASHSCOPE_API_KEY=$(sed_escape "$DASHSCOPE_API_KEY")|" "$ROOT/.env"
      sed -i "s|^# *DASHSCOPE_API_KEY=.*|DASHSCOPE_API_KEY=$(sed_escape "$DASHSCOPE_API_KEY")|" "$ROOT/.env"
    fi
  fi

  # 定时任务
  read -rp "$(echo -e "  启用${CYAN}定时任务${NC}？(y/N): ")" ENABLE_CRON
  if [[ "${ENABLE_CRON,,}" == "y" ]]; then
    sed -i "s|^# CRON_ENABLED=.*|CRON_ENABLED=true|" "$ROOT/.env"
    sed -i "s|^# *CRON_ENABLED=.*|CRON_ENABLED=true|" "$ROOT/.env"
  fi

  # 飞书工具
  read -rp "$(echo -e "  启用${CYAN}飞书文档工具${NC}？需要飞书应用有文档权限 (y/N): ")" ENABLE_TOOLS
  if [[ "${ENABLE_TOOLS,,}" == "y" ]]; then
    sed -i "s|^FEISHU_TOOLS_ENABLED=.*|FEISHU_TOOLS_ENABLED=true|" "$ROOT/.env"
  fi

  # 快速确认
  read -rp "$(echo -e "  启用${CYAN}快速确认${NC}？Direct 模式下先发一条自然短回复掩盖延迟，需要 DashScope API Key (y/N): ")" ENABLE_ACK
  if [[ "${ENABLE_ACK,,}" == "y" ]]; then
    sed -i "s|^# QUICK_ACK_ENABLED=.*|QUICK_ACK_ENABLED=true|" "$ROOT/.env"
    sed -i "s|^# *QUICK_ACK_ENABLED=.*|QUICK_ACK_ENABLED=true|" "$ROOT/.env"
    # 如果前面还没配 DASHSCOPE_API_KEY，提示一下
    if [[ "${ENABLE_MEMORY,,}" != "y" ]]; then
      info "快速确认依赖 DASHSCOPE_API_KEY，请确保已在记忆系统步骤中配置"
    fi
  fi

  # 访问控制
  read -rp "$(echo -e "  配置${CYAN}用户访问控制${NC}？限制哪些用户可以使用 Bot (y/N): ")" ENABLE_ACL
  if [[ "${ENABLE_ACL,,}" == "y" ]]; then
    read -rp "  ALLOWED_USER_IDS (逗号分隔，回车=允许所有): " ALLOWED_IDS
    if [[ -n "$ALLOWED_IDS" ]]; then
      sed -i "s|^ALLOWED_USER_IDS=.*|ALLOWED_USER_IDS=$(sed_escape "$ALLOWED_IDS")|" "$ROOT/.env"
    fi
  fi

  # OWNER 提示
  echo ""
  info "管理员 (OWNER_USER_ID) 无需手动配置"
  info "首次向 Bot 发消息的用户将自动成为管理员，并回写到 .env"

  ok ".env 已生成"
}

if [[ -f "$ROOT/.env" ]]; then
  ok ".env 已存在"
  echo ""
  echo "  1) 跳过 — 保留现有配置"
  echo "  2) 重新配置 — 备份后重新生成"
  echo "  3) 补充缺失项 — 只填充空值"
  echo ""
  read -rp "$(echo -e "${YELLOW}选择 (1/2/3) [1]: ${NC}")" ENV_CHOICE
  case "${ENV_CHOICE:-1}" in
    2)
      cp "$ROOT/.env" "$ROOT/.env.bak"
      ok "已备份为 .env.bak"
      configure_env
      ;;
    3)
      info "检查缺失的必填项..."
      source "$ROOT/.env" 2>/dev/null || true
      PATCHED=0
      if [[ -z "${FEISHU_APP_ID:-}" || "$FEISHU_APP_ID" == "cli_xxxxxxxxxx" ]]; then
        info "飞书 App ID — 在 open.feishu.cn 创建应用后获取"
        read -rp "  FEISHU_APP_ID: " NEW_VAL
        if [[ -n "$NEW_VAL" ]]; then
          sed -i "s|^FEISHU_APP_ID=.*|FEISHU_APP_ID=$(sed_escape "$NEW_VAL")|" "$ROOT/.env"
          PATCHED=$((PATCHED+1))
        fi
      fi
      if [[ -z "${FEISHU_APP_SECRET:-}" || "$FEISHU_APP_SECRET" == "xxxxxxxxxxxxxxxxxxxxxxxx" ]]; then
        info "飞书 App Secret"
        read -rp "  FEISHU_APP_SECRET: " NEW_VAL
        if [[ -n "$NEW_VAL" ]]; then
          sed -i "s|^FEISHU_APP_SECRET=.*|FEISHU_APP_SECRET=$(sed_escape "$NEW_VAL")|" "$ROOT/.env"
          PATCHED=$((PATCHED+1))
        fi
      fi
      if [[ -z "${ANTHROPIC_API_KEY:-}" || "$ANTHROPIC_API_KEY" == "sk-ant-xxxxxxxx" ]]; then
        info "Anthropic API Key — 在 console.anthropic.com/settings/keys 获取"
        read -rp "  ANTHROPIC_API_KEY: " NEW_VAL
        if [[ -n "$NEW_VAL" ]]; then
          sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$(sed_escape "$NEW_VAL")|" "$ROOT/.env"
          PATCHED=$((PATCHED+1))
        fi
      fi
      if [[ $PATCHED -gt 0 ]]; then
        ok "补充了 $PATCHED 个配置项"
      else
        ok "所有必填项已配置"
      fi
      ;;
    *)
      ok "跳过 .env 配置"
      ;;
  esac
else
  configure_env
fi

# ============================================================
# Step 5: Agent 配置
# ============================================================
header "Step 5/6: Agent 配置"

if [[ -f "$ROOT/config/agents.json" ]]; then
  ok "config/agents.json 已存在"
  echo ""
  echo "  1) 跳过 — 保留现有配置"
  echo "  2) 重新生成 — 从示例文件复制（备份现有）"
  echo ""
  read -rp "$(echo -e "${YELLOW}选择 (1/2) [1]: ${NC}")" AGENT_CHOICE
  case "${AGENT_CHOICE:-1}" in
    2)
      cp "$ROOT/config/agents.json" "$ROOT/config/agents.json.bak"
      ok "已备份为 agents.json.bak"
      cp "$ROOT/config/agents.example.json" "$ROOT/config/agents.json"
      ok "已从示例文件重新生成 config/agents.json"
      init_config_files
      ;;
    *)
      ok "跳过 Agent 配置"
      ;;
  esac
else
  echo "  1) 使用示例配置（推荐）— PM + Dev 双 agent"
  echo "  2) 跳过 — 使用内置 dev agent（无需配置文件）"
  echo ""
  read -rp "$(echo -e "${YELLOW}选择 (1/2) [1]: ${NC}")" AGENT_CHOICE
  case "${AGENT_CHOICE:-1}" in
    2)
      info "将使用内置 dev agent，后续可运行: cp config/agents.example.json config/agents.json"
      ;;
    *)
      cp "$ROOT/config/agents.example.json" "$ROOT/config/agents.json"
      ok "已创建 config/agents.json（PM + Dev 双 agent）"
      init_config_files
      echo ""
      info "可编辑以下文件自定义 agent 人设和知识库（支持热加载，改完即生效）:"
      info "  config/personas/pm.md    — PM agent 人设"
      info "  config/knowledge/team.md — 团队信息"
      info "也可以直接在飞书群里让 bot 帮你修改这些文件"
      ;;
  esac
fi

# ============================================================
# Step 6: 编译验证
# ============================================================
header "Step 6/6: 编译验证"

info "运行 npm run build ..."
if npm run build 2>&1; then
  ok "编译通过"
else
  err "编译失败，请检查上方错误信息"
  exit 1
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo -e "${BOLD}${GREEN}🎉 Anycode 环境初始化完成！${NC}"
echo ""
echo -e "${BOLD}下一步：${NC}"
echo "  1. npm run dev          # 启动开发服务器"
echo "  2. 在飞书中 @Bot 发消息测试"
echo "  3. 自定义 config/ 下的 persona 和 knowledge 文件"
echo ""
