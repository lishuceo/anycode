/**
 * 多 Bot 账号管理
 *
 * 每个飞书 Bot 应用对应一个独立的 SDK Client + WebSocket 连接。
 * 单 bot 兼容模式：不配置 BOT_ACCOUNTS 时自动退化为单实例。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../utils/logger.js';
import { FeishuClient, registerClientResolver } from './client.js';
import type { BotAccountConfig } from '../agent/types.js';

export interface BotAccount {
  accountId: string;
  appId: string;
  appSecret: string;
  botName: string;
  /** 封装后的飞书 client */
  feishuClient: FeishuClient;
  /** Bot 的 open_id（运行时通过 API 获取，用于 @mention 检测） */
  botOpenId?: string;
}

export class AccountManager {
  private accounts = new Map<string, BotAccount>();
  /** appId → accountId 反查（事件回调时用） */
  private appIdIndex = new Map<string, string>();
  /** 单 bot 模式标记 */
  private _singleBotMode = false;

  get singleBotMode(): boolean {
    return this._singleBotMode;
  }

  /**
   * 初始化多 bot 账号
   */
  async initialize(configs: BotAccountConfig[]): Promise<void> {
    for (const cfg of configs) {
      const feishuClient = new FeishuClient(cfg.appId, cfg.appSecret);
      const account: BotAccount = {
        accountId: cfg.accountId,
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        botName: cfg.botName,
        feishuClient,
      };

      this.accounts.set(cfg.accountId, account);
      this.appIdIndex.set(cfg.appId, cfg.accountId);
    }

    // 获取每个 bot 的 open_id
    await Promise.all(
      [...this.accounts.values()].map(async (account) => {
        await account.feishuClient.fetchBotInfo();
        account.botOpenId = account.feishuClient.botOpenId;
        logger.info(
          { accountId: account.accountId, botName: account.botName, botOpenId: account.botOpenId },
          'Bot account initialized',
        );
      }),
    );

    // 注册 client resolver，让 feishuClient Proxy 能路由到 per-account client
    registerClientResolver((accountId: string) => this.getClient(accountId));

    logger.info({ accountCount: this.accounts.size }, 'All bot accounts initialized');
  }

  /**
   * 初始化单 bot 兼容模式（使用现有 FEISHU_APP_ID / FEISHU_APP_SECRET）
   */
  initializeSingleBot(appId: string, appSecret: string, botName?: string): void {
    this._singleBotMode = true;
    const feishuClient = new FeishuClient(appId, appSecret);
    const account: BotAccount = {
      accountId: 'default',
      appId,
      appSecret,
      botName: botName ?? 'default',
      feishuClient,
    };
    this.accounts.set('default', account);
    this.appIdIndex.set(appId, 'default');

    // 注册 client resolver
    registerClientResolver((acctId: string) => this.getClient(acctId));
  }

  /** 获取 bot 账号 */
  getAccount(accountId: string): BotAccount | undefined {
    return this.accounts.get(accountId);
  }

  /** 获取飞书 client */
  getClient(accountId: string): FeishuClient | undefined {
    return this.accounts.get(accountId)?.feishuClient;
  }

  /** 获取默认飞书 client（单 bot 模式 / 兜底） */
  getDefaultClient(): FeishuClient {
    if (this._singleBotMode) {
      return this.accounts.get('default')!.feishuClient;
    }
    // 多 bot 模式下返回第一个
    return this.accounts.values().next().value!.feishuClient;
  }

  /** 根据 appId 反查 accountId（事件回调时用） */
  resolveAccountId(appId: string): string | undefined {
    return this.appIdIndex.get(appId);
  }

  /** 获取某个 bot 的 open_id */
  getBotOpenId(accountId: string): string | undefined {
    return this.accounts.get(accountId)?.botOpenId;
  }

  /** 获取所有已注册 bot 的 open_id 集合 */
  getAllBotOpenIds(): Set<string> {
    const ids = new Set<string>();
    for (const account of this.accounts.values()) {
      if (account.botOpenId) ids.add(account.botOpenId);
    }
    return ids;
  }

  /** 获取所有账号 */
  allAccounts(): BotAccount[] {
    return [...this.accounts.values()];
  }

  /** 获取原始 lark.Client（用于创建 WSClient 等低级操作） */
  getRawClient(accountId: string): lark.Client | undefined {
    return this.accounts.get(accountId)?.feishuClient.raw;
  }
}

export const accountManager = new AccountManager();
