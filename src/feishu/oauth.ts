import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { feishuClient } from './client.js';
import { sessionManager } from '../session/manager.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 飞书 OAuth 2.0 用户授权
//
// 流程:
//   1. generateAuthUrl() → 生成授权 URL，用户点击后跳转飞书授权页
//   2. handleCallback()  → OAuth callback 接收 code，换取 user_access_token
//   3. getValidUserToken() → 获取有效的 user_access_token（自动刷新过期 token）
//
// Token 存储: SessionDatabase.user_tokens 表 (keyed by user open_id)
// ============================================================

/** State payload encoded in the OAuth state parameter */
interface OAuthState {
  /** Feishu user open_id */
  userId: string;
  /** Feishu chat_id (for sending confirmation back) */
  chatId: string;
  /** Timestamp for expiry check */
  ts: number;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Sign the state payload with HMAC-SHA256 using app secret.
 * Format: base64url(json).signature
 */
function signState(payload: OAuthState): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.feishu.appSecret)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify and decode the state parameter.
 * Returns the payload if valid, undefined otherwise.
 */
export function verifyState(state: string): OAuthState | undefined {
  const dotIndex = state.indexOf('.');
  if (dotIndex < 0) return undefined;

  const data = state.slice(0, dotIndex);
  const sig = state.slice(dotIndex + 1);

  const expected = createHmac('sha256', config.feishu.appSecret)
    .update(data)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as OAuthState;
    if (Date.now() - payload.ts > STATE_MAX_AGE_MS) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Default redirect URI used when no public callback URL is configured.
 * After authorization, the browser will redirect here but fail to load —
 * the user just needs to copy the `code` param from the URL bar.
 */
const FALLBACK_REDIRECT_URI = 'http://127.0.0.1:3000/feishu/oauth/callback';

/**
 * Generate a Feishu OAuth authorization URL.
 * The user opens this URL to authorize the app to access their data.
 *
 * If no redirect URI is configured, uses a localhost placeholder.
 * The user can then copy the code from the redirected URL and paste it back.
 */
export function generateAuthUrl(userId: string, chatId: string): string {
  const state = signState({ userId, chatId, ts: Date.now() });
  const redirectUri = encodeURIComponent(config.feishu.oauth.redirectUri || FALLBACK_REDIRECT_URI);
  const appId = config.feishu.appId;

  return `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${redirectUri}&state=${state}`;
}

/**
 * Exchange an authorization code for user access token + refresh token.
 * Called from the OAuth callback route.
 */
export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  openId: string;
}> {
  const client = feishuClient.raw;

  const resp = await client.request<{
    code?: number;
    msg?: string;
    data?: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      open_id?: string;
      token_type?: string;
    };
  }>({
    method: 'POST',
    url: '/open-apis/authen/v1/oidc/access_token',
    data: {
      grant_type: 'authorization_code',
      code,
    },
  });

  if (resp.code !== 0 || !resp.data?.access_token) {
    throw new Error(`Token exchange failed (${resp.code}): ${resp.msg}`);
  }

  return {
    accessToken: resp.data.access_token,
    refreshToken: resp.data.refresh_token ?? '',
    expiresIn: resp.data.expires_in ?? 7200,
    openId: resp.data.open_id ?? '',
  };
}

/**
 * Refresh an expired user access token using the refresh token.
 */
export async function refreshUserToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const client = feishuClient.raw;

  const resp = await client.request<{
    code?: number;
    msg?: string;
    data?: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
  }>({
    method: 'POST',
    url: '/open-apis/authen/v1/oidc/refresh_access_token',
    data: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });

  if (resp.code !== 0 || !resp.data?.access_token) {
    throw new Error(`Token refresh failed (${resp.code}): ${resp.msg}`);
  }

  return {
    accessToken: resp.data.access_token,
    refreshToken: resp.data.refresh_token ?? refreshToken,
    expiresIn: resp.data.expires_in ?? 7200,
  };
}

/**
 * Handle the OAuth callback: exchange code, store tokens, notify user.
 */
export async function handleOAuthCallback(code: string, state: string): Promise<string> {
  const payload = verifyState(state);
  if (!payload) {
    return '授权失败：state 无效或已过期，请重新发起授权。';
  }

  const { userId, chatId } = payload;

  try {
    const result = await exchangeCodeForToken(code);

    // Verify the returned open_id matches the expected user
    if (result.openId && result.openId !== userId) {
      logger.warn({ expected: userId, got: result.openId }, 'OAuth open_id mismatch');
      return '授权失败：授权用户与发起用户不一致。';
    }

    // Store tokens
    const tokenExpiry = Math.floor(Date.now() / 1000) + result.expiresIn;
    sessionManager.upsertUserToken(userId, result.accessToken, result.refreshToken, tokenExpiry);

    logger.info({ userId }, 'User OAuth token stored');

    // Notify in chat
    await feishuClient.sendText(chatId, '✅ 授权成功！现在可以查看你的个人任务了。');

    return '授权成功！你可以关闭此页面。';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, userId }, 'OAuth token exchange failed');
    return `授权失败：${msg}`;
  }
}

/**
 * Handle manual code exchange: user pastes the authorization code back in chat.
 * Used when no public callback URL is available.
 */
export async function handleManualCode(code: string, userId: string, chatId: string): Promise<string> {
  try {
    const result = await exchangeCodeForToken(code);

    const effectiveUserId = result.openId || userId;
    const tokenExpiry = Math.floor(Date.now() / 1000) + result.expiresIn;
    sessionManager.upsertUserToken(effectiveUserId, result.accessToken, result.refreshToken, tokenExpiry);

    logger.info({ userId: effectiveUserId }, 'User OAuth token stored via manual code');

    await feishuClient.sendText(chatId, `授权成功！已保存 user token，现在可以查看个人任务了。`);
    return effectiveUserId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, userId }, 'Manual code exchange failed');
    throw new Error(`授权失败：${msg}`);
  }
}

/**
 * Get a valid user access token for the given user.
 * Automatically refreshes expired tokens.
 *
 * Fallback chain:
 *   1. Current user's own token
 *   2. Owner user's token (config.security.ownerUserId) — "一人授权，全员可用"
 *   3. undefined (no token available)
 */
export async function getValidUserToken(userId: string): Promise<string | undefined> {
  // Try current user first
  const token = await _getStoredToken(userId);
  if (token) return token;

  // Fallback to owner's token
  const ownerId = config.security?.ownerUserId;
  if (ownerId && ownerId !== userId) {
    return _getStoredToken(ownerId);
  }

  return undefined;
}

async function _getStoredToken(userId: string): Promise<string | undefined> {
  const stored = sessionManager.getUserToken(userId);
  if (!stored) return undefined;

  const now = Math.floor(Date.now() / 1000);
  // Add 5-minute buffer before expiry
  if (stored.tokenExpiry > now + 300) {
    return stored.accessToken;
  }

  // Token expired or about to expire — try refresh
  if (!stored.refreshToken) {
    logger.warn({ userId }, 'User token expired and no refresh token available');
    sessionManager.deleteUserToken(userId);
    return undefined;
  }

  try {
    const refreshed = await refreshUserToken(stored.refreshToken);
    const newExpiry = Math.floor(Date.now() / 1000) + refreshed.expiresIn;
    sessionManager.upsertUserToken(userId, refreshed.accessToken, refreshed.refreshToken, newExpiry);
    logger.info({ userId }, 'User token refreshed');
    return refreshed.accessToken;
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to refresh user token, removing stored token');
    sessionManager.deleteUserToken(userId);
    return undefined;
  }
}

/**
 * Check if OAuth is available.
 * Always true — supports both callback mode (with redirect URI) and
 * manual code mode (without redirect URI, user pastes code back).
 */
export function isOAuthConfigured(): boolean {
  return true;
}

/**
 * Check if a public callback URL is configured.
 */
export function hasCallbackUrl(): boolean {
  return !!config.feishu.oauth.redirectUri;
}
