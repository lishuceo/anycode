#!/usr/bin/env tsx
/**
 * CLI Onboarding Agent — 交互式配置助手
 *
 * 通过 Agent SDK 在终端中启动多轮对话，引导用户完成 Anycode 首次配置：
 * - 飞书应用配置 (App ID/Secret, 权限, 事件)
 * - 团队信息 (写入 config/knowledge/team.md)
 * - Bot 人格设定 (写入 config/personas/pm.md)
 * - 可选功能 (记忆系统、定时任务等)
 *
 * 用法: npm run onboard 或 npx tsx scripts/onboard.ts
 */
import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'node:readline/promises';
import { getBootstrapPrompt, isOnboardingCompleted } from '../src/onboarding/bootstrap.js';

// 颜色
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Spinner — 等待 agent 回复时显示
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
function startSpinner(label = '思考中') {
  let i = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${DIM}${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} ${label}...${RESET}  `);
    i++;
  }, 80);
}
function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    process.stdout.write('\r\x1b[K'); // 清除 spinner 行
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 检查是否已完成
if (isOnboardingCompleted()) {
  console.log(`\n${GREEN}Onboarding 已完成。${RESET}`);
  const answer = await rl.question(`${YELLOW}要重新配置吗？(y/N): ${RESET}`);
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('退出。运行 npm run dev 启动服务。');
    rl.close();
    process.exit(0);
  }
}

console.log(`\n${BOLD}${CYAN}-- Anycode 配置助手 --${RESET}\n`);
console.log(`${DIM}AI 助手将引导你完成飞书配置、团队信息和 Bot 人格设定。${RESET}`);
console.log(`${DIM}输入 "跳过" 跳过当前步骤，输入 "退出" 结束配置。${RESET}\n`);

const systemPrompt = getBootstrapPrompt();
let sessionId: string | undefined;
let userMessage = '开始配置。请先帮我配置飞书应用。';
let round = 0;
const MAX_ROUNDS = 30;

while (round < MAX_ROUNDS) {
  round++;

  try {
    startSpinner(round === 1 ? '正在连接 AI 服务' : '思考中');
    const q = query({
      prompt: userMessage,
      options: {
        cwd: process.cwd(),
        systemPrompt: systemPrompt,
        permissionMode: 'acceptEdits',
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        maxTurns: 50,
        maxBudgetUsd: 5,
        // 只传递必要的环境变量给 Claude Code 子进程
        // 避免 .env 中的其他变量（如 OWNER_USER_ID）干扰 SDK 认证
        env: (() => {
          const e: Record<string, string> = {};
          // 继承系统 PATH 等基础环境
          for (const [k, v] of Object.entries(process.env)) {
            if (v != null) e[k] = v;
          }
          // 确保清除可能干扰 Claude CLI 的嵌套检测变量
          delete e.CLAUDECODE;
          return e;
        })(),
        // 捕获子进程 stderr 输出（调试用）
        stderr: (data: string) => {
          const trimmed = data.trim();
          if (trimmed) console.error(`${DIM}[stderr] ${trimmed}${RESET}`);
        },
        ...(sessionId ? { resume: sessionId } : {}),
        canUseTool: async (_toolName: string, inputObj: Record<string, unknown>) => {
          return { behavior: 'allow' as const, updatedInput: inputObj };
        },
      },
    });

    let hasOutput = false;

    for await (const msg of q) {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            sessionId = msg.session_id;
          }
          break;

        case 'assistant':
          stopSpinner();
          if (msg.message?.content) {
            for (const block of msg.message.content) {
              if ('text' in block && block.text) {
                // 过滤 thinking 标签
                const text = block.text
                  .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
                  .replace(/<thinking>[\s\S]*/g, '');
                if (text.trim()) {
                  process.stdout.write(`\n${CYAN}Bot:${RESET} ${text}\n`);
                  hasOutput = true;
                }
              }
            }
          }
          break;

        case 'result':
          sessionId = msg.session_id ?? sessionId;
          break;
      }
    }

    stopSpinner();

    // 检查是否完成
    if (isOnboardingCompleted()) {
      console.log(`\n${BOLD}${GREEN}配置完成!${RESET}`);
      console.log(`\n${BOLD}启动服务:${RESET}`);
      console.log(`  npm run dev              ${DIM}# 开发模式 (带 auto-reload)${RESET}`);
      console.log(`  pm2 start npm --name anycode -- start  ${DIM}# 生产模式 (后台运行)${RESET}\n`);
      break;
    }

    if (!hasOutput) {
      console.log(`${DIM}(agent 正在处理文件操作...)${RESET}`);
    }

    // 读取用户输入
    const input = await rl.question(`\n${YELLOW}你:${RESET} `);
    if (input.trim().toLowerCase() === '退出' || input.trim().toLowerCase() === 'exit') {
      console.log(`\n${DIM}配置中断。已完成的配置已保存。${RESET}`);
      console.log(`运行 ${BOLD}npm run onboard${RESET} 继续配置。\n`);
      break;
    }
    userMessage = input;

  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${YELLOW}出错: ${msg}${RESET}`);

    // 认证相关错误：给出清晰的修复指引
    if (msg.includes('401') || msg.includes('auth') || msg.includes('authenticate') || msg.includes('API Key') || msg.includes('Unauthorized')) {
      console.error(`\n${BOLD}API 认证失败。请检查:${RESET}`);
      console.error(`  1. .env 中的 ANTHROPIC_API_KEY 是否正确`);
      console.error(`  2. 如果使用代理，ANTHROPIC_BASE_URL 是否正确`);
      console.error(`  3. API Key 是否有效且未过期\n`);
      console.error(`  当前 ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL || '(官方地址)'}`);
      console.error(`  编辑 .env 修正后重新运行: ${BOLD}npm run onboard${RESET}\n`);
      break;
    }

    // 非致命错误，尝试继续
    const retry = await rl.question(`${YELLOW}要继续吗？(Y/n): ${RESET}`);
    if (retry.trim().toLowerCase() === 'n') break;
    userMessage = '继续之前的配置流程。';
  }
}

if (round >= MAX_ROUNDS) {
  console.log(`\n${YELLOW}已达到最大轮次，配置中止。${RESET}`);
  console.log(`运行 ${BOLD}npm run onboard${RESET} 继续。\n`);
}

rl.close();
