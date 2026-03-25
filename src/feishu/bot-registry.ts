/**
 * 群聊 Bot 注册表
 *
 * 追踪飞书群聊中已知的 bot，采用双通道发现机制：
 * 1. 事件订阅：im.chat.member.bot.added_v1 / deleted_v1
 * 2. 被动收集：消息 sender_type === 'app' 检测
 *
 * 带文件持久化：bot 名字一旦学习到就持久保存，服务重启后不丢失。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** JSON 序列化格式 */
interface PersistedData {
  /** chatId → { openId → BotInfo } */
  chats: Record<string, Record<string, BotInfo>>;
}

export class ChatBotRegistry {
  // chatId → ChatEntry
  private registry = new Map<string, ChatEntry>();
  private persistPath: string | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) {
      this.loadFromDisk();
    }
  }

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
      if (name && name !== existing.name) {
        existing.name = name;
        this.scheduleSave();
      }
      return;
    }

    entry.bots.set(openId, {
      openId,
      name,
      source,
      discoveredAt: Date.now(),
    });
    if (name) this.scheduleSave();
  }

  /**
   * 移除单个 bot（bot 被移出群时调用）
   */
  removeBot(chatId: string, openId: string): void {
    const entry = this.registry.get(chatId);
    if (!entry) return;
    const had = entry.bots.has(openId);
    entry.bots.delete(openId);
    entry.lastActivity = Date.now();
    if (had) this.scheduleSave();
  }

  /**
   * 清空某个 chat 的全部 bot 记录（本 bot 被移出群时调用）
   */
  clearChat(chatId: string): void {
    const had = this.registry.has(chatId);
    this.registry.delete(chatId);
    if (had) this.scheduleSave();
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
    let changed = false;
    for (const [chatId, entry] of this.registry) {
      if (now - entry.lastActivity > maxIdleMs) {
        this.registry.delete(chatId);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  // ── 持久化 ──

  /**
   * 防抖保存：合并 500ms 内的多次写入
   */
  private scheduleSave(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 500);
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    const data: PersistedData = { chats: {} };
    for (const [chatId, entry] of this.registry) {
      // 只持久化有名字的 bot（无名 bot 重启后会被重新发现）
      const namedBots: Record<string, BotInfo> = {};
      for (const [openId, bot] of entry.bots) {
        if (bot.name) namedBots[openId] = bot;
      }
      if (Object.keys(namedBots).length > 0) {
        data.chats[chatId] = namedBots;
      }
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {
      // 写入失败静默忽略，下次重试
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data: PersistedData = JSON.parse(raw);
      for (const [chatId, bots] of Object.entries(data.chats ?? {})) {
        const entry: ChatEntry = { bots: new Map(), lastActivity: Date.now() };
        for (const [openId, bot] of Object.entries(bots)) {
          entry.bots.set(openId, {
            openId: bot.openId || openId,
            name: bot.name,
            source: bot.source || 'message_sender',
            discoveredAt: bot.discoveredAt || Date.now(),
          });
        }
        this.registry.set(chatId, entry);
      }
    } catch {
      // 文件不存在或损坏，从空状态开始
    }
  }
}

export const chatBotRegistry = new ChatBotRegistry('./data/bot-registry.json');
