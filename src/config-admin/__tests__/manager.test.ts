// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';

// 路径在 hoist 阶段以字符串形式确定（不碰 fs），mock 工厂引用它们。
const H = vi.hoisted(() => {
  const ROOT = '/tmp/cfgadmin-test-' + Math.random().toString(36).slice(2);
  return {
    ROOT,
    CONFIG_DIR: ROOT + '/config',
    PERSONAS_DIR: ROOT + '/config/personas',
    KNOWLEDGE_DIR: ROOT + '/config/knowledge',
    HOME: ROOT + '/home',
    reloadMock: vi.fn(() => ({ loaded: true })),
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../agent/config-loader.js', () => ({
  getConfigPaths: () => ({
    configFile: H.CONFIG_DIR + '/agents.json',
    configDir: H.CONFIG_DIR,
    knowledgeDir: H.KNOWLEDGE_DIR,
  }),
  reloadAgentConfig: H.reloadMock,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => H.HOME };
});

import {
  resolveTarget,
  validateContent,
  readConfig,
  writeConfig,
  listTargets,
  backupFile,
  setMcpServer,
  removeMcpServer,
  getMcpServer,
  listMcpServerNames,
  claudeJsonPath,
} from '../manager.js';

const VALID_AGENTS = JSON.stringify({
  knowledgeDir: './knowledge/',
  defaults: { model: 'claude-opus-4-8' },
  agents: [{ id: 'pm', displayName: '土豆儿', model: 'claude-opus-4-8' }],
}, null, 2);

const BACKUP_DIR = H.ROOT + '/data/config-backups';

beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(H.ROOT);
  H.reloadMock.mockClear();
  H.reloadMock.mockReturnValue({ loaded: true });
  // 重建干净的临时配置树
  rmSync(H.ROOT, { recursive: true, force: true });
  mkdirSync(H.PERSONAS_DIR, { recursive: true });
  mkdirSync(H.KNOWLEDGE_DIR, { recursive: true });
  mkdirSync(H.HOME, { recursive: true });
  writeFileSync(H.CONFIG_DIR + '/agents.json', VALID_AGENTS);
  writeFileSync(H.PERSONAS_DIR + '/pm.md', '# 土豆儿人设\n');
  writeFileSync(H.PERSONAS_DIR + '/assistant.example.md', '# 模板\n');
  writeFileSync(H.KNOWLEDGE_DIR + '/team.md', '# team\n');
  writeFileSync(H.KNOWLEDGE_DIR + '/team.example.md', '# team 模板\n');
  writeFileSync(H.ROOT + '/.env', 'FEISHU_APP_ID=abc\n# 注释\nCLAUDE_MODEL=claude-opus-4-8\n');
  writeFileSync(H.HOME + '/.claude.json', JSON.stringify({
    projects: { '/foo': { history: [] } },
    mcpServers: { existing: { type: 'http', url: 'https://a' } },
  }));
});

afterAll(() => {
  rmSync(H.ROOT, { recursive: true, force: true });
});

describe('resolveTarget — 白名单与安全', () => {
  it('接受 agents.json（热加载 + agents 校验）', () => {
    const r = resolveTarget('agents.json');
    expect(r).toMatchObject({ label: 'agents.json', effect: 'hot-reload', validate: 'agents' });
    expect(r!.absPath).toBe(H.CONFIG_DIR + '/agents.json');
  });

  it('接受 ./agents.json（去除 ./ 前缀）', () => {
    expect(resolveTarget('./agents.json')?.label).toBe('agents.json');
  });

  it('接受 .env（需重启 + env 校验）', () => {
    const r = resolveTarget('.env');
    expect(r).toMatchObject({ effect: 'restart', validate: 'env' });
    expect(r!.absPath).toBe(H.ROOT + '/.env');
  });

  it('接受 personas/*.md 与 knowledge/*.md（热加载）', () => {
    expect(resolveTarget('personas/pm.md')).toMatchObject({ effect: 'hot-reload', validate: 'none' });
    expect(resolveTarget('knowledge/team.md')).toMatchObject({ effect: 'hot-reload', validate: 'none' });
  });

  it('拒绝路径穿越', () => {
    const reason = {};
    expect(resolveTarget('personas/../../../etc/passwd', reason)).toBeNull();
    expect(reason.msg).toMatch(/越出|只允许/);
  });

  it('拒绝 .example 模板', () => {
    const reason = {};
    expect(resolveTarget('personas/assistant.example.md', reason)).toBeNull();
    expect(reason.msg).toMatch(/example/);
  });

  it('拒绝非 .md 文件', () => {
    const reason = {};
    expect(resolveTarget('personas/pm.txt', reason)).toBeNull();
    expect(reason.msg).toMatch(/\.md/);
  });

  it('拒绝白名单外目标', () => {
    const reason = {};
    expect(resolveTarget('package.json', reason)).toBeNull();
    expect(reason.msg).toMatch(/白名单/);
  });
});

describe('validateContent', () => {
  it('agents.json: 合法内容通过', () => {
    expect(validateContent('agents', VALID_AGENTS).ok).toBe(true);
  });

  it('agents.json: 非法 JSON 被拒', () => {
    const r = validateContent('agents', '{ not json');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/JSON 解析失败/);
  });

  it('agents.json: schema 不合法被拒（agents 为空数组）', () => {
    const r = validateContent('agents', JSON.stringify({ agents: [] }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema 校验失败/);
  });

  it('.env: 合法 KEY=VALUE 通过（含注释与空行）', () => {
    expect(validateContent('env', 'A=1\n\n# c\nexport B=2\n').ok).toBe(true);
  });

  it('.env: 非 KEY=VALUE 行被拒', () => {
    const r = validateContent('env', 'A=1\nthis is not valid\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/第 2 行/);
  });

  it('none: 任意内容通过', () => {
    expect(validateContent('none', '随便什么').ok).toBe(true);
  });
});

describe('writeConfig', () => {
  it('写 personas：新文件不备份，写入成功，不触发 reload', () => {
    const out = writeConfig('personas/new.md', '# 新人设\n');
    expect(out.ok).toBe(true);
    expect(out.result.backup).toBeUndefined();
    expect(readFileSync(H.PERSONAS_DIR + '/new.md', 'utf-8')).toBe('# 新人设\n');
    expect(H.reloadMock).not.toHaveBeenCalled();
  });

  it('写 agents.json：备份旧文件 + 落盘 + 触发 reload', () => {
    const next = VALID_AGENTS.replace('claude-opus-4-8', 'claude-sonnet-4-6');
    const out = writeConfig('agents.json', next);
    expect(out.ok).toBe(true);
    expect(out.result.effect).toBe('hot-reload');
    expect(out.result.reloaded).toBe(true);
    expect(out.result.backup).toBeTruthy();
    expect(existsSync(out.result.backup)).toBe(true);
    expect(readFileSync(H.CONFIG_DIR + '/agents.json', 'utf-8')).toContain('claude-sonnet-4-6');
    expect(H.reloadMock).toHaveBeenCalledTimes(1);
  });

  it('agents.json 校验失败：不备份、不落盘、不 reload', () => {
    const before = readFileSync(H.CONFIG_DIR + '/agents.json', 'utf-8');
    const out = writeConfig('agents.json', '{ bad json');
    expect(out.ok).toBe(false);
    expect(readFileSync(H.CONFIG_DIR + '/agents.json', 'utf-8')).toBe(before);
    expect(existsSync(BACKUP_DIR)).toBe(false);
    expect(H.reloadMock).not.toHaveBeenCalled();
  });

  it('reload 失败时如实回报 reloaded=false + reloadError', () => {
    H.reloadMock.mockReturnValue({ loaded: false, error: '重复的 agent id' });
    const out = writeConfig('agents.json', VALID_AGENTS);
    expect(out.ok).toBe(true);
    expect(out.result.reloaded).toBe(false);
    expect(out.result.reloadError).toMatch(/重复/);
  });

  it('.env：备份 + 落盘，effect=restart', () => {
    const out = writeConfig('.env', 'A=1\nB=2\n');
    expect(out.ok).toBe(true);
    expect(out.result.effect).toBe('restart');
    expect(out.result.backup).toBeTruthy();
    expect(readFileSync(H.ROOT + '/.env', 'utf-8')).toBe('A=1\nB=2\n');
  });

  it('拒绝白名单外写入', () => {
    const out = writeConfig('../../evil.sh', 'rm -rf /');
    expect(out.ok).toBe(false);
  });
});

describe('readConfig', () => {
  it('读取白名单文件', () => {
    expect(readConfig('personas/pm.md')).toContain('土豆儿人设');
  });
  it('非法目标返回 null 并给出原因', () => {
    const reason = {};
    expect(readConfig('/etc/passwd', reason)).toBeNull();
    expect(reason.msg).toBeTruthy();
  });
});

describe('listTargets', () => {
  it('列出 agents.json / 现有人设(排除 example) / 知识 / .env / mcp', () => {
    const labels = listTargets().map((t) => t.label);
    expect(labels).toContain('agents.json');
    expect(labels).toContain('personas/pm.md');
    expect(labels).not.toContain('personas/assistant.example.md');
    expect(labels).toContain('knowledge/team.md');
    expect(labels).not.toContain('knowledge/team.example.md');
    expect(labels).toContain('.env');
    expect(labels).toContain('mcp:existing');
  });
});

describe('MCP server 管理（浅合并保留其它键）', () => {
  it('set_mcp 新增 server，保留已有 server 与顶层其它键', () => {
    const out = setMcpServer('newone', { type: 'http', url: 'https://b' });
    expect(out.ok).toBe(true);
    expect(out.result.effect).toBe('restart');
    const json = JSON.parse(readFileSync(claudeJsonPath(), 'utf-8'));
    expect(json.mcpServers.newone).toEqual({ type: 'http', url: 'https://b' });
    expect(json.mcpServers.existing).toBeTruthy();     // 未丢失其它 server
    expect(json.projects).toBeTruthy();                // 未丢失顶层其它键
  });

  it('set_mcp 更新已有 server', () => {
    setMcpServer('existing', { type: 'http', url: 'https://changed' });
    expect(getMcpServer('existing')).toMatchObject({ url: 'https://changed' });
  });

  it('set_mcp 拒绝非对象 config', () => {
    expect(setMcpServer('x', 'not-an-object').ok).toBe(false);
    expect(setMcpServer('x', ['a']).ok).toBe(false);
    expect(setMcpServer('', { a: 1 }).ok).toBe(false);
  });

  it('remove_mcp 删除 server；删不存在的报错', () => {
    expect(listMcpServerNames()).toContain('existing');
    const out = removeMcpServer('existing');
    expect(out.ok).toBe(true);
    expect(listMcpServerNames()).not.toContain('existing');
    expect(removeMcpServer('nope').ok).toBe(false);
  });

  it('set_mcp 写前备份原 ~/.claude.json', () => {
    const out = setMcpServer('backuptest', { type: 'http', url: 'https://c' });
    expect(out.result.backup).toBeTruthy();
    expect(existsSync(out.result.backup)).toBe(true);
  });
});

describe('backupFile', () => {
  it('文件存在则备份到 data/config-backups/，不存在返回 undefined', () => {
    expect(backupFile(H.ROOT + '/nope.txt')).toBeUndefined();
    const b = backupFile(H.CONFIG_DIR + '/agents.json');
    expect(b).toBeTruthy();
    expect(b.startsWith(BACKUP_DIR)).toBe(true);
    expect(readdirSync(BACKUP_DIR).length).toBeGreaterThan(0);
  });
});
