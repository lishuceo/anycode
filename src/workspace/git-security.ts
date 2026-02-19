// ============================================================
// Git 安全参数（共享常量）
//
// 所有 git 操作统一使用，避免分散定义导致不一致。
//
// 注意 --config 与 -c 的区别：
//   --config key=value  → git clone 专用，将配置持久化到新仓库
//   -c key=value        → git 顶层选项，临时生效，适用于所有子命令
//
// 注意参数位置：
//   --no-recurse-submodules 是子命令选项，必须放在 clone/fetch 之后，
//   不能作为 git 顶层选项（放在子命令之前会报 unknown option）。
//   因此 fetch 等命令的参数分为两部分：顶层参数 + 子命令参数。
// ============================================================

/** clone 安全参数：用 --config 持久化到新仓库，禁用 hooks 和 submodules */
const GIT_CLONE_BASE_ARGS = [
  '--config', 'core.hooksPath=/dev/null',
  '--no-recurse-submodules',
];

/** 通用顶层安全参数：用 -c 临时生效，放在 git 与子命令之间 */
const GIT_CMD_TOP_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
];

/** 通用子命令安全参数：放在 fetch/pull 等子命令之后 */
const GIT_CMD_SUB_ARGS = [
  '--no-recurse-submodules',
];

/** 远程 bare clone 安全参数：禁用 hooks/submodules + 禁用 file 协议（防止 SSRF） */
export const GIT_REMOTE_CLONE_ARGS = [
  ...GIT_CLONE_BASE_ARGS,
  '-c', 'protocol.file.allow=never',
];

/**
 * 远程 fetch 安全参数，分为两部分：
 * - topArgs: 放在 git 与 fetch 之间（-c 配置）
 * - subArgs: 放在 fetch 之后（--no-recurse-submodules）
 */
export const GIT_REMOTE_FETCH_TOP_ARGS = [
  ...GIT_CMD_TOP_ARGS,
  '-c', 'protocol.file.allow=never',
];
export const GIT_REMOTE_FETCH_SUB_ARGS = [
  ...GIT_CMD_SUB_ARGS,
];

/** 本地 clone 安全参数：禁用 hooks/submodules，不禁 file 协议（从 bare cache clone 需要） */
export const GIT_LOCAL_CLONE_ARGS = [
  ...GIT_CLONE_BASE_ARGS,
];
