/**
 * 群聊 Bot 注册表
 *
 * 追踪飞书群聊中已知的 bot，采用双通道发现机制：
 * 1. 事件订阅：im.chat.member.bot.added_v1 / deleted_v1
 * 2. 被动收集：消息 sender_type === 'app' 检测
 *
 * 内存存储，进程重启后通过事件 + 被动收集重新填充。
 */

export interface BotInfo {
  openId: string;
  name?: string;
  /** 数据来源：event_added = bot入群事件, message_sender = 消息sender_type检测 */
  source: 'event_added' | 'message_sender';
  discoveredAt: number;  // Date.now()
}

/** 每个 chat 的元信息（用于 cleanup 过期判断） */
interface ChatEntry {
  bots: Map<string, BotInfo>;
  lastActivity: number;  // 最后一次 addBot/removeBot 的时间戳
}

export class ChatBotRegistry {
  // chatId → ChatEntry
  private registry = new Map<string, ChatEntry>();

  /**
   * 添加 bot（幂等，已存在则仅更新 source 优先级：event_added > message_sender）
   */
  addBot(chatId: string, openId: string, name?: string, source: BotInfo['source'] = 'message_sender'): void {
    let entry = this.registry.get(chatId);
    if (!entry) {
      entry = { bots: new Map(), lastActivity: Date.now() };
      this.registry.set(chatId, entry);
    }
    entry.lastActivity = Date.now();

    const existing = entry.bots.get(openId);
    if (existing) {
      // 幂等：已存在时仅升级 source（event_added 优先于 message_sender）
      if (source === 'event_added' && existing.source !== 'event_added') {
        existing.source = 'event_added';
      }
      // 有 name 时始终更新（被动收集时 name 不可用，后续从 @mention 补充）
      if (name) {
        existing.name = name;
      }
      return;
    }

    entry.bots.set(openId, {
      openId,
      name,
      source,
      discoveredAt: Date.now(),
    });
  }

  /**
   * 移除单个 bot（bot 被移出群时调用）
   */
  removeBot(chatId: string, openId: string): void {
    const entry = this.registry.get(chatId);
    if (!entry) return;
    entry.bots.delete(openId);
    entry.lastActivity = Date.now();
    // 空 map 不清理，等 cleanup 统一处理
  }

  /**
   * 清空某个 chat 的全部 bot 记录（本 bot 被移出群时调用）
   */
  clearChat(chatId: string): void {
    this.registry.delete(chatId);
  }

  /**
   * 获取某个 chat 的已知 bot 列表
   */
  getBots(chatId: string): BotInfo[] {
    const entry = this.registry.get(chatId);
    if (!entry) return [];
    return [...entry.bots.values()];
  }

  /**
   * 清理长期无更新的 chat（默认 >24h），防止内存泄漏
   */
  cleanup(maxIdleMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [chatId, entry] of this.registry) {
      if (now - entry.lastActivity > maxIdleMs) {
        this.registry.delete(chatId);
      }
    }
  }
}

export const chatBotRegistry = new ChatBotRegistry();
