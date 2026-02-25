/**
 * Agent 注册表 — 角色 → 配置映射
 *
 * 支持两种初始化模式：
 * 1. 无配置文件 → createBuiltinAgents() 硬编码默认值（向后兼容）
 * 2. 有 config/agents.json → config-loader 调用 replaceAll() 热加载
 */
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { AgentId, AgentConfig } from './types.js';

/** 内置 agent 配置（无配置文件时的 fallback） */
function createBuiltinAgents(): Map<AgentId, AgentConfig> {
  const map = new Map<AgentId, AgentConfig>();

  map.set('chat', {
    id: 'chat',
    displayName: 'ChatBot',
    model: 'claude-sonnet-4-6',
    toolPolicy: 'readonly',
    readOnly: true,
    settingSources: ['user', 'project'],
    maxBudgetUsd: 5,
    maxTurns: 100,
    requiresApproval: false,
    replyMode: 'direct',
  });

  map.set('dev', {
    id: 'dev',
    displayName: 'DevBot',
    model: config.claude.model,
    toolPolicy: 'all',
    readOnly: false,
    settingSources: ['user', 'project'],
    maxBudgetUsd: config.claude.maxBudgetUsd,
    maxTurns: config.claude.maxTurns,
    requiresApproval: true,
    replyMode: 'thread',
  });

  return map;
}

class AgentRegistry {
  private agents: Map<AgentId, AgentConfig>;

  constructor() {
    this.agents = createBuiltinAgents();
  }

  /** 获取 agent 配置 */
  get(agentId: AgentId): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  /** 获取 agent 配置，不存在则抛异常 */
  getOrThrow(agentId: AgentId): AgentConfig {
    const cfg = this.agents.get(agentId);
    if (!cfg) throw new Error(`Unknown agent: ${agentId}`);
    return cfg;
  }

  /**
   * 原子替换所有 agent 配置。
   * 由 config-loader 在启动和热重载时调用。
   * JS 单线程，Map 引用赋值是原子的 — 并发的 get() 总是看到完整的旧 Map 或新 Map。
   */
  replaceAll(configs: AgentConfig[]): void {
    const newMap = new Map<AgentId, AgentConfig>();
    for (const cfg of configs) {
      if (newMap.has(cfg.id)) {
        logger.warn({ agentId: cfg.id }, 'Duplicate agent ID in config, later entry wins');
      }
      newMap.set(cfg.id, cfg);
    }
    this.agents = newMap;
  }

  /** 所有已注册的 agent IDs */
  allIds(): AgentId[] {
    return [...this.agents.keys()];
  }

  /** 默认 agent（兜底） */
  get defaultAgentId(): AgentId {
    return 'dev';
  }
}

export const agentRegistry = new AgentRegistry();
