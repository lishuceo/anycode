#!/usr/bin/env node
/**
 * 测试 prompt caching 优化效果
 *
 * 对比两种模式：
 *   A) 默认模式（CLI explicit breakpoints）
 *   B) automatic caching 模式（禁用 explicit + 顶层 cache_control）
 *
 * 使用方式：
 *   node scripts/test-cache-optimization.mjs          # 默认模式 (baseline)
 *   node scripts/test-cache-optimization.mjs --auto    # automatic caching 模式
 *
 * 测试逻辑：发一个需要多 turn 的任务，对比 cache_creation vs cache_read
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

const useAutoCaching = process.argv.includes('--auto');
const useAutoOnly = process.argv.includes('--auto-only'); // 只加顶层 cache_control，不禁用 explicit
const workDir = process.env.DEFAULT_WORK_DIR || '/root/dev/anywhere-code';

const mode = useAutoOnly ? 'AUTO-ONLY' : useAutoCaching ? 'AUTO+DISABLE' : 'DEFAULT';
console.log(`\n=== Prompt Caching Test ===`);
console.log(`Mode: ${mode}`);
console.log(`Working dir: ${workDir}`);
console.log();

// 设置环境变量
const env = { ...process.env };
delete env.CLAUDECODE;

if (useAutoCaching) {
  env.DISABLE_PROMPT_CACHING = '1';
  env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({
    cache_control: { type: 'ephemeral' },
  });
  console.log('Env overrides:');
  console.log(`  DISABLE_PROMPT_CACHING=1`);
  console.log(`  CLAUDE_CODE_EXTRA_BODY=${env.CLAUDE_CODE_EXTRA_BODY}`);
  console.log();
} else if (useAutoOnly) {
  // 不禁用 explicit，只追加顶层 cache_control
  const existing = env.CLAUDE_CODE_EXTRA_BODY ? JSON.parse(env.CLAUDE_CODE_EXTRA_BODY) : {};
  env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({
    ...existing,
    cache_control: { type: 'ephemeral' },
  });
  console.log('Env overrides:');
  console.log(`  CLAUDE_CODE_EXTRA_BODY=${env.CLAUDE_CODE_EXTRA_BODY}`);
  console.log();
}

// 构造一个需要多 turn 的任务（读多个文件 + 分析）
const prompt = `请依次完成以下步骤（每步都要用工具）：
1. 读取 src/index.ts 文件
2. 读取 src/server.ts 文件
3. 读取 src/config.ts 文件
4. 读取 package.json 文件
5. 列出 src/ 目录下所有 .ts 文件
6. 读取 src/claude/executor.ts 的前 50 行
7. 读取 src/session/manager.ts 的前 50 行
8. 最后用一句话总结这个项目的主要功能

注意：每个步骤都必须单独执行对应的工具调用，不要跳过。`;

console.log(`Prompt length: ${prompt.length} chars`);
console.log(`Starting query...`);
console.log();

const startTime = Date.now();
let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
let turnCount = 0;
let output = '';

try {
  const session = query({
    prompt,
    options: {
      cwd: workDir,
      env,
      permissionMode: 'acceptEdits',
      model: 'claude-opus-4-6',
      maxTurns: 20,
      maxBudgetUsd: 5,
      thinking: { type: 'disabled' },
      canUseTool: async (_toolName, inputObj) => {
        return { behavior: 'allow', updatedInput: inputObj };
      },
    },
  });

  for await (const msg of session) {
    if (msg.type === 'assistant') {
      turnCount++;
      const usage = msg.message?.usage;
      if (usage) {
        totalTokens.input += usage.input_tokens || 0;
        totalTokens.output += usage.output_tokens || 0;
        totalTokens.cacheRead += usage.cache_read_input_tokens || 0;
        totalTokens.cacheCreation += usage.cache_creation_input_tokens || 0;

        const turnTotal = (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.input_tokens || 0);
        const hitPct = turnTotal > 0 ? ((usage.cache_read_input_tokens || 0) / turnTotal * 100).toFixed(1) : '0';
        console.log(`  Turn ${turnCount}: input=${usage.input_tokens || 0}, creation=${usage.cache_creation_input_tokens || 0}, read=${usage.cache_read_input_tokens || 0}, hit=${hitPct}%`);
      }
    }
    if (msg.type === 'result') {
      output = msg.subtype === 'success' ? 'success' : `error: ${msg.error}`;
      // SDK cost info
      if (msg.cost_usd !== undefined) {
        console.log(`\n  SDK reported cost: $${msg.cost_usd.toFixed(4)}`);
      }
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  output = `error: ${err.message}`;
}

const durationMs = Date.now() - startTime;
const totalInput = totalTokens.cacheCreation + totalTokens.cacheRead + totalTokens.input;
const hitRate = totalInput > 0 ? (totalTokens.cacheRead / totalInput * 100).toFixed(1) : '0';

// Opus pricing (approximate)
const creationCost = totalTokens.cacheCreation * 6.25 / 1_000_000;
const readCost = totalTokens.cacheRead * 0.625 / 1_000_000;
const outputCost = totalTokens.output * 60 / 1_000_000;
const totalCost = creationCost + readCost + outputCost;

console.log(`\n=== Results ===`);
console.log(`Mode:             ${mode}`);
console.log(`Status:           ${output}`);
console.log(`Turns:            ${turnCount}`);
console.log(`Duration:         ${(durationMs / 1000).toFixed(1)}s`);
console.log(`Cache creation:   ${totalTokens.cacheCreation.toLocaleString()} tokens`);
console.log(`Cache read:       ${totalTokens.cacheRead.toLocaleString()} tokens`);
console.log(`Regular input:    ${totalTokens.input.toLocaleString()} tokens`);
console.log(`Cache hit rate:   ${hitRate}%`);
console.log(`Output tokens:    ${totalTokens.output.toLocaleString()}`);
const inputCost = totalTokens.input * 15 / 1_000_000;
console.log(`Est. cost:        $${(totalCost + inputCost).toFixed(2)} (input=$${inputCost.toFixed(2)} + creation=$${creationCost.toFixed(2)} + read=$${readCost.toFixed(2)} + output=$${outputCost.toFixed(2)})`);
console.log();

if (!useAutoCaching) {
  console.log(`Next: run with --auto to compare:`);
  console.log(`  node scripts/test-cache-optimization.mjs --auto`);
}
