// ============================================================
// Git 安全参数（共享常量）
//
// 所有 git 操作统一使用，避免分散定义导致不一致。
// ============================================================

/** 基础安全参数：禁用 hooks 和 submodules（适用于所有 git 操作） */
export const GIT_BASE_SECURITY_ARGS = [
  '--config', 'core.hooksPath=/dev/null',
  '--no-recurse-submodules',
];

/** 远程 clone/fetch 安全参数：额外禁用 file 协议（防止 SSRF） */
export const GIT_REMOTE_SECURITY_ARGS = [
  ...GIT_BASE_SECURITY_ARGS,
  '-c', 'protocol.file.allow=never',
];

/** 本地 clone 安全参数：不禁用 file 协议（从 bare cache 本地 clone 需要 file 协议） */
export const GIT_LOCAL_SECURITY_ARGS = [
  ...GIT_BASE_SECURITY_ARGS,
];
