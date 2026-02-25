/**
 * Agent 注册表 — 角色 → 配置映射
 */
import { config } from '../config.js';
import type { AgentId, AgentConfig } from './types.js';

/** 内置 agent 配置 */
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

  /** 注册自定义 agent（Phase 3 用） */
  register(agentConfig: AgentConfig): void {
    this.agents.set(agentConfig.id, agentConfig);
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
