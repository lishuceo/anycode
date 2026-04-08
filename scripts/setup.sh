#!/usr/bin/env bash
# ============================================================
# Anycode 开发环境初始化脚本 (精简版)
#
# 只做最小必要配置: 环境检查 + 依赖安装 + API Key + 编译
# 其余配置 (飞书、人格、团队信息等) 由 CLI onboarding agent 完成
#
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

info()  { echo -e "${BLUE}i${NC}  $*"; }
ok()    { echo -e "${GREEN}OK${NC} $*"; }
warn()  { echo -e "${YELLOW}!!${NC}  $*"; }
err()   { echo -e "${RED}ERR${NC} $*"; }
header(){ echo -e "\n${BOLD}${CYAN}-- $* --${NC}\n"; }

# 项目根目录 (脚本所在的上一级)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ============================================================
# Step 1: 系统依赖检查
# ============================================================
header "Step 1/4: 系统依赖检查"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER="$(node -v)"
  ok "Node.js $NODE_VER"
  MAJOR="${NODE_VER#v}"
  MAJOR="${MAJOR%%.*}"
  if [[ "$MAJOR" -lt 18 ]]; then
    err "需要 Node.js >= 18，当前 $NODE_VER"
    exit 1
  fi
else
  err "未找到 Node.js (需要 >= 18)"
  info "安装: https://nodejs.org/ 或使用 nvm"
  exit 1
fi

# 构建工具 (native 模块编译需要)
BUILD_TOOLS_OK=true
for tool in python3 make gcc; do
  if command -v "$tool" &>/dev/null; then
    ok "$tool"
  else
    warn "$tool 未找到 -- native 模块 (better-sqlite3, sqlite-vec) 可能编译失败"
    BUILD_TOOLS_OK=false
  fi
done

if [[ "$BUILD_TOOLS_OK" == false ]]; then
  echo ""
  warn "缺少构建工具 (native 模块编译需要)"

  INSTALL_CMD=""
  if [[ -f /etc/debian_version ]]; then
    INSTALL_CMD="apt-get install -y python3 make gcc g++"
  elif [[ -f /etc/redhat-release ]]; then
    INSTALL_CMD="yum install -y python3 make gcc gcc-c++"
  elif [[ "$(uname)" == "Darwin" ]]; then
    INSTALL_CMD="xcode-select --install"
  fi

  if [[ -n "$INSTALL_CMD" ]]; then
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
      warn "跳过构建工具安装 -- npm install 阶段 native 模块可能编译失败"
    fi
  else
    warn "无法识别包管理器，请手动安装 python3 make gcc"
  fi
fi

# ============================================================
# Step 2: 安装依赖
# ============================================================
header "Step 2/4: 安装依赖"

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
  warn "sqlite-vec 编译失败 -- 记忆系统将降级为 BM25 文本搜索 (不影响核心功能)"
fi

# ============================================================
# Step 3: 最小 .env 配置
# ============================================================
header "Step 3/4: 最小配置"

# 转义 sed 替换字符串中的特殊字符
sed_escape() { printf '%s\n' "$1" | sed 's/[&|\\]/\\&/g'; }

if [[ -f "$ROOT/.env" ]]; then
  ok ".env 已存在"
  # 检查必填项
  source "$ROOT/.env" 2>/dev/null || true
  MISSING_KEYS=0
  if [[ -z "${ANTHROPIC_API_KEY:-}" || "$ANTHROPIC_API_KEY" == "sk-ant-xxxxxxxx" ]]; then
    MISSING_KEYS=1
  fi
  if [[ $MISSING_KEYS -eq 1 ]]; then
    info "检测到 ANTHROPIC_API_KEY 未配置"
    info "Anthropic API Key -- 在 console.anthropic.com/settings/keys 获取"
    read -rp "  ANTHROPIC_API_KEY: " NEW_KEY
    if [[ -n "$NEW_KEY" ]]; then
      sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$(sed_escape "$NEW_KEY")|" "$ROOT/.env"
      ok "已更新 ANTHROPIC_API_KEY"
    fi
  else
    ok "ANTHROPIC_API_KEY 已配置"
  fi
else
  # 从 .env.example 创建
  if [[ ! -f "$ROOT/.env.example" ]]; then
    err ".env.example 不存在，无法生成 .env"
    exit 1
  fi
  cp "$ROOT/.env.example" "$ROOT/.env"

  echo -e "${BOLD}Anycode 需要一个 Anthropic API Key 才能运行。${NC}"
  echo -e "其余配置 (飞书、团队信息、Bot 人格等) 稍后由 AI 助手引导完成。\n"

  # ANTHROPIC_API_KEY (必填)
  info "Anthropic API Key -- 在 console.anthropic.com/settings/keys 获取"
  info "使用第三方代理时填写对应平台的 API Key"
  read -rp "  ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
  while [[ -z "$ANTHROPIC_API_KEY" ]]; do
    warn "API Key 不能为空"
    read -rp "  ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY
  done
  sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$(sed_escape "$ANTHROPIC_API_KEY")|" "$ROOT/.env"

  # ANTHROPIC_BASE_URL (可选)
  info "API Base URL -- 使用代理或第三方兼容端点时填写，直连官方回车跳过"
  read -rp "  ANTHROPIC_BASE_URL (回车=官方地址): " ANTHROPIC_BASE_URL
  if [[ -n "$ANTHROPIC_BASE_URL" ]]; then
    sed -i "s|^# *ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=$(sed_escape "$ANTHROPIC_BASE_URL")|" "$ROOT/.env"
  fi

  ok ".env 已生成 (最小配置)"
fi

# ============================================================
# Step 4: 编译验证
# ============================================================
header "Step 4/4: 编译验证"

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
echo -e "${BOLD}${GREEN}Anycode 基础环境初始化完成!${NC}"
echo ""
echo -e "${BOLD}下一步:${NC}"
echo "  1. npm run onboard    # AI 助手引导完成剩余配置 (飞书、团队、Bot 人格)"
echo "  2. npm run dev        # 启动开发服务器"
echo ""
echo -e "  ${CYAN}也可以跳过 onboard 直接手动配置:${NC}"
echo "  - 编辑 .env 填写飞书 App ID/Secret"
echo "  - cp config/agents.example.json config/agents.json"
echo "  - 编辑 config/personas/ 和 config/knowledge/ 下的文件"
echo ""

# 提示运行 onboard
read -rp "$(echo -e "${YELLOW}现在运行 AI 配置助手？(Y/n): ${NC}")" RUN_ONBOARD
if [[ "${RUN_ONBOARD,,}" != "n" ]]; then
  echo ""
  exec npm run onboard
fi
