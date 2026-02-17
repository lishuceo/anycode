// ============================================================
// Git 安全参数（共享常量）
//
// 所有 git 操作统一使用，避免分散定义导致不一致。
//
// 注意 --config 与 -c 的区别：
//   --config key=value  → git clone 专用，将配置持久化到新仓库
//   -c key=value        → git 顶层选项，临时生效，适用于所有子命令
// ============================================================

/** clone 安全参数：用 --config 持久化到新仓库，禁用 hooks 和 submodules */
const GIT_CLONE_BASE_ARGS = [
  '--config', 'core.hooksPath=/dev/null',
  '--no-recurse-submodules',
];

/** 通用安全参数：用 -c 临时生效，适用于 fetch 等非 clone 子命令 */
const GIT_CMD_BASE_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '--no-recurse-submodules',
];

/** 远程 bare clone 安全参数：禁用 hooks/submodules + 禁用 file 协议（防止 SSRF） */
export const GIT_REMOTE_CLONE_ARGS = [
  ...GIT_CLONE_BASE_ARGS,
  '-c', 'protocol.file.allow=never',
];

/** 远程 fetch 安全参数：禁用 hooks/submodules + 禁用 file 协议 */
export const GIT_REMOTE_FETCH_ARGS = [
  ...GIT_CMD_BASE_ARGS,
  '-c', 'protocol.file.allow=never',
];

/** 本地 clone 安全参数：禁用 hooks/submodules，不禁 file 协议（从 bare cache clone 需要） */
export const GIT_LOCAL_CLONE_ARGS = [
  ...GIT_CLONE_BASE_ARGS,
];
