import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { injectLocalSettings } from '../workspace/manager.js';

function createTempWorkspace(): string {
  const dir = resolve(tmpdir(), `ws-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('injectLocalSettings', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = createTempWorkspace();
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('should create .claude/settings.local.json with permission whitelist', () => {
    injectLocalSettings(workspacePath);

    const settingsPath = resolve(workspacePath, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.permissions.allow).toContain('Bash(git *)');
    expect(content.permissions.allow).toContain('Bash(npm *)');
    expect(content.permissions.allow).toContain('Bash(npx *)');
    expect(content.permissions.allow).toContain('Bash(gh *)');
  });

  it('should create .claude directory if it does not exist', () => {
    const claudeDir = resolve(workspacePath, '.claude');
    expect(existsSync(claudeDir)).toBe(false);

    injectLocalSettings(workspacePath);

    expect(existsSync(claudeDir)).toBe(true);
    expect(existsSync(resolve(claudeDir, 'settings.local.json'))).toBe(true);
  });

  it('should not overwrite existing settings.local.json', () => {
    const claudeDir = resolve(workspacePath, '.claude');
    const settingsPath = resolve(claudeDir, 'settings.local.json');

    mkdirSync(claudeDir, { recursive: true });
    const customSettings = { permissions: { allow: ['Bash(custom *)'] } };
    writeFileSync(settingsPath, JSON.stringify(customSettings));

    injectLocalSettings(workspacePath);

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.permissions.allow).toEqual(['Bash(custom *)']);
  });

  it('should include all critical bot workflow commands', () => {
    injectLocalSettings(workspacePath);

    const settingsPath = resolve(workspacePath, '.claude', 'settings.local.json');
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    const required = ['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(gh *)'];
    for (const pattern of required) {
      expect(content.permissions.allow).toContain(pattern);
    }
  });
});
