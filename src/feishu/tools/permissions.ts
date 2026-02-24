import { feishuClient } from '../client.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

/**
 * 创建文档/文件夹后，自动将 OWNER_USER_ID 设为管理员 (full_access)。
 * 如果 OWNER_USER_ID 未配置，静默跳过。
 *
 * @param token  资源 token (document_id / folder_token 等)
 * @param type   资源类型: 'docx' | 'folder' | 'sheet' | 'bitable' 等
 */
export async function grantOwnerPermission(token: string, type: string): Promise<void> {
  const ownerUserId = config.security.ownerUserId;
  if (!ownerUserId) return;

  try {
    const resp = await feishuClient.raw.request<{ code?: number; msg?: string }>({
      method: 'POST',
      url: `/open-apis/drive/v1/permissions/${token}/members`,
      params: { type, need_notification: false },
      data: {
        member_type: 'openid',
        member_id: ownerUserId,
        perm: 'full_access',
      },
    });

    if (resp.code !== 0) {
      logger.warn({ code: resp.code, msg: resp.msg, token, type }, 'Failed to grant owner permission');
    } else {
      logger.debug({ token, type, ownerUserId }, 'Owner permission granted');
    }
  } catch (err: unknown) {
    // 从 AxiosError 中提取飞书 API 错误信息
    const axiosData = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
    const detail = axiosData?.msg ?? (err instanceof Error ? err.message : String(err));
    // 授权失败不应阻断主流程
    logger.warn({ detail, token, type }, 'Error granting owner permission');
  }
}
