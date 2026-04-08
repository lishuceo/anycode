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
    console.log(`${DIM}[启动 Agent SDK query, round ${round}...]${RESET}`);
    const q = query({
      prompt: userMessage,
      options: {
        cwd: process.cwd(),
        systemPrompt: systemPrompt,
        permissionMode: 'acceptEdits',
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        maxTurns: 50,
        maxBudgetUsd: 5,
        // 传递环境变量给 Claude Code 子进程（ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL 等）
        env: process.env as Record<string, string>,
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

    // 检查是否完成
    if (isOnboardingCompleted()) {
      console.log(`\n${BOLD}${GREEN}配置完成!${RESET}`);
      console.log(`\n运行 ${BOLD}npm run dev${RESET} 启动 Anycode 服务。\n`);
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${YELLOW}出错: ${msg}${RESET}`);

    if (msg.includes('ANTHROPIC_API_KEY') || msg.includes('authentication')) {
      console.error(`请确认 .env 中的 ANTHROPIC_API_KEY 已正确配置。`);
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
