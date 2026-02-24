/** 飞书资源 token 格式校验 (防止路径遍历/注入) */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export function validateToken(value: string, name: string): void {
  if (!TOKEN_RE.test(value)) {
    throw new Error(`无效的 ${name}: 仅允许字母、数字、下划线、横线`);
  }
}

/** 校验 JSON.parse 后的 fields 对象 (bitable 用) */
export function validateFieldsObject(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fields 必须是 JSON 对象 (如 {"字段名": "值"})');
  }
  // 原型污染防护
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`fields 中包含不允许的 key: ${key}`);
    }
  }
  return obj;
}
