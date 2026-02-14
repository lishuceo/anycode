/** 飞书事件回调的通用结构 */
export interface FeishuEventBody {
  /** 事件 schema (2.0) */
  schema?: string;
  /** 验证请求（首次配置回调时飞书发送） */
  challenge?: string;
  token?: string;
  type?: string;
  /** 事件头 */
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  /** 事件体 */
  event?: FeishuMessageEvent;
}

/** im.message.receive_v1 事件 */
export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      union_id?: string;
      user_id?: string;
      open_id: string;
    };
    sender_type: string;
    tenant_key: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string; // JSON string
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id: string;
      };
      name: string;
      tenant_key: string;
    }>;
  };
}

/** 解析后的消息内容 */
export interface ParsedMessage {
  /** 纯文本内容 */
  text: string;
  /** 原始消息 ID */
  messageId: string;
  /** 发送者 open_id */
  userId: string;
  /** 会话 ID */
  chatId: string;
  /** 会话类型 */
  chatType: 'p2p' | 'group';
  /** 是否 @了机器人 (群聊中) */
  mentionedBot: boolean;
}
