import { feishuClient } from '../client.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

/** 从 AxiosError 中提取飞书 API 错误详情 */
function extractErrorDetail(err: unknown): string {
  const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  return axiosData?.msg ?? (err instanceof Error ? err.message : String(err));
}

/** 调用飞书权限 API 为单个用户授权 */
async function addMemberPermission(
  token: string, type: string, openId: string, perm: 'full_access' | 'edit' | 'view',
): Promise<boolean> {
  try {
    const resp = await feishuClient.raw.request<{ code?: number; msg?: string }>({
      method: 'POST',
      url: `/open-apis/drive/v1/permissions/${token}/members`,
      params: { type, need_notification: false },
      data: { member_type: 'openid', member_id: openId, perm },
    });
    if (resp.code !== 0) {
      logger.warn({ code: resp.code, msg: resp.msg, token, openId }, 'Failed to grant permission');
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.warn({ detail: extractErrorDetail(err), token, openId }, 'Error granting permission');
    return false;
  }
}

/**
 * 创建文档/文件夹后，自动将 OWNER_USER_ID 设为管理员 (full_access)。
 * 如果 OWNER_USER_ID 未配置，静默跳过。
 */
export async function grantOwnerPermission(token: string, type: string): Promise<void> {
  const ownerUserId = config.security.ownerUserId;
  if (!ownerUserId) return;

  const ok = await addMemberPermission(token, type, ownerUserId, 'full_access');
  if (ok) {
    logger.debug({ token, type, ownerUserId }, 'Owner permission granted');
  }
}

/**
 * 创建文档/文件夹后，自动将当前群的所有成员设为可编辑 (edit)。
 * 如果 chatId 未提供，静默跳过。
 * 已有 owner 权限的用户不会被降级 (飞书 API 会保留更高权限)。
 */
export async function grantChatMembersPermission(token: string, type: string, chatId?: string): Promise<void> {
  if (!chatId) return;

  const ownerUserId = config.security.ownerUserId;

  try {
    let granted = 0;
    for await (const page of await feishuClient.raw.im.chatMembers.getWithIterator({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    })) {
      const members = page?.items ?? [];
      await Promise.all(
        members
          .filter((m) => m.member_id && m.member_id !== ownerUserId)
          .map(async (m) => {
            const ok = await addMemberPermission(token, type, m.member_id!, 'edit');
            if (ok) granted++;
          }),
      );
    }
    logger.info({ token, type, chatId, granted }, 'Chat members permission granted');
  } catch (err: unknown) {
    logger.warn({ detail: extractErrorDetail(err), token, chatId }, 'Error granting chat members permission');
  }
}
