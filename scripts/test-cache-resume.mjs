#!/usr/bin/env node
/**
 * 测试 resume 场景下的 prompt caching
 *
 * 模拟生产环境：先跑一个多 turn query 积累上下文，然后 resume 再跑一个 query
 * 对比 resume 时的 cache 命中情况
 *
 * 用法：
 *   node scripts/test-cache-resume.mjs             # 默认
 *   node scripts/test-cache-resume.mjs --auto-only  # 加顶层 cache_control
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';

dotenv.config();

const useAutoOnly = process.argv.includes('--auto-only');
const workDir = process.env.DEFAULT_WORK_DIR || '/root/dev/anywhere-code';
const mode = useAutoOnly ? 'AUTO-ONLY' : 'DEFAULT';

console.log(`\n=== Resume Cache Test ===`);
console.log(`Mode: ${mode}`);
console.log();

const env = { ...process.env };
delete env.CLAUDECODE;

if (useAutoOnly) {
  env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ cache_control: { type: 'ephemeral' } });
  console.log(`  CLAUDE_CODE_EXTRA_BODY=${env.CLAUDE_CODE_EXTRA_BODY}`);
  console.log();
}

function trackUsage(msg, label, stats) {
  if (msg.type !== 'assistant') return;
  stats.turns++;
  const u = msg.message?.usage;
  if (!u) return;
  stats.input += u.input_tokens || 0;
  stats.creation += u.cache_creation_input_tokens || 0;
  stats.read += u.cache_read_input_tokens || 0;
  stats.output += u.output_tokens || 0;
}

function printStats(label, stats, durationMs) {
  const total = stats.creation + stats.read + stats.input;
  const hitPct = total > 0 ? (stats.read / total * 100).toFixed(1) : '0';
  const creationCost = stats.creation * 6.25 / 1e6;
  const readCost = stats.read * 0.625 / 1e6;
  const inputCost = stats.input * 15 / 1e6;
  const outputCost = stats.output * 60 / 1e6;
  const totalCost = creationCost + readCost + inputCost + outputCost;

  console.log(`\n--- ${label} ---`);
  console.log(`  Turns:          ${stats.turns}`);
  console.log(`  Duration:       ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Cache creation: ${stats.creation.toLocaleString()}`);
  console.log(`  Cache read:     ${stats.read.toLocaleString()}`);
  console.log(`  Regular input:  ${stats.input.toLocaleString()}`);
  console.log(`  Cache hit rate: ${hitPct}%`);
  console.log(`  Est. cost:      $${totalCost.toFixed(2)}`);
  return totalCost;
}

// ===== Phase 1: 积累上下文 =====
console.log('Phase 1: Building context (reading multiple files)...');
const p1Stats = { turns: 0, input: 0, creation: 0, read: 0, output: 0 };
let sessionId;

const p1Start = Date.now();
try {
  const s1 = query({
    prompt: `请逐个读取以下文件的完整内容：
1. src/index.ts
2. src/server.ts
3. src/feishu/client.ts
4. src/claude/executor.ts (前 100 行)
5. src/session/manager.ts
6. src/session/queue.ts
每个文件都必须用 Read 工具单独读取。`,
    options: {
      cwd: workDir, env,
      permissionMode: 'acceptEdits',
      model: process.env.TEST_MODEL || 'claude-haiku-4-5-20251001',
      maxTurns: 20, maxBudgetUsd: 5,
      thinking: { type: 'disabled' },
      canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
    },
  });

  for await (const msg of s1) {
    trackUsage(msg, 'p1', p1Stats);
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      console.log(`  Session ID: ${sessionId}`);
    }
  }
} catch (err) {
  console.error(`Phase 1 error: ${err.message}`);
}
const p1Cost = printStats('Phase 1 (build context)', p1Stats, Date.now() - p1Start);

if (!sessionId) {
  console.error('No session ID captured, cannot resume');
  process.exit(1);
}

// ===== Phase 2: Resume 并做新任务 =====
console.log('\n\nPhase 2: Resume session with new task...');
const p2Stats = { turns: 0, input: 0, creation: 0, read: 0, output: 0 };

const p2Start = Date.now();
try {
  const s2 = query({
    prompt: `基于你之前读取的代码，回答以下问题：
1. 这个项目的入口文件做了哪些初始化工作？
2. session manager 的清理机制是什么？
3. executor.ts 中 canUseTool 的权限检查逻辑是怎样的？
每个问题请简要回答 2-3 句话。`,
    options: {
      cwd: workDir, env,
      permissionMode: 'acceptEdits',
      model: process.env.TEST_MODEL || 'claude-haiku-4-5-20251001',
      maxTurns: 10, maxBudgetUsd: 5,
      resume: sessionId,
      thinking: { type: 'disabled' },
      canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }),
    },
  });

  for await (const msg of s2) {
    trackUsage(msg, 'p2', p2Stats);
  }
} catch (err) {
  console.error(`Phase 2 error: ${err.message}`);
}
const p2Cost = printStats('Phase 2 (resume)', p2Stats, Date.now() - p2Start);

// ===== Summary =====
console.log(`\n=== TOTAL ===`);
console.log(`  Mode:       ${mode}`);
console.log(`  Total cost: $${(p1Cost + p2Cost).toFixed(2)}`);
console.log(`  Phase 1:    $${p1Cost.toFixed(2)} (${p1Stats.turns} turns)`);
console.log(`  Phase 2:    $${p2Cost.toFixed(2)} (${p2Stats.turns} turns, RESUME)`);

const p2Total = p2Stats.creation + p2Stats.read + p2Stats.input;
const p2HitPct = p2Total > 0 ? (p2Stats.read / p2Total * 100).toFixed(1) : '0';
console.log(`  Resume cache hit: ${p2HitPct}%`);
console.log();
