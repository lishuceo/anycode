/**
 * Agent 注册表 — 角色 → 配置映射
 *
 * 启动时为空，由 config-loader 从 config/agents.json 加载填充。
 * 无配置文件时 config-loader 注册一个最小可用的 dev agent 兜底。
 */
import { logger } from '../utils/logger.js';
import type { AgentId, AgentConfig } from './types.js';

class AgentRegistry {
  private agents = new Map<AgentId, AgentConfig>();

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
