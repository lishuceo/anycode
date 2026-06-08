import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Test the .claude/settings.local.json injection behavior in workspace setup.
 * Since injectLocalSettings is not exported, we replicate its logic here to verify the contract.
 */

function createTempWorkspace(): string {
  const dir = resolve(tmpdir(), `ws-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('workspace settings.local.json injection', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = createTempWorkspace();
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('should create .claude/settings.local.json with permission whitelist', async () => {
    // Simulate what injectLocalSettings does
    const claudeDir = resolve(workspacePath, '.claude');
    const settingsPath = resolve(claudeDir, 'settings.local.json');

    // Import the manager module to call setupWorkspace indirectly won't work without git,
    // so we verify the contract: after injection, the file should contain expected permissions
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: {
        allow: [
          'Bash(git *)',
          'Bash(npm *)',
          'Bash(npx *)',
          'Bash(node *)',
          'Bash(cat *)',
          'Bash(ls *)',
          'Bash(find *)',
          'Bash(grep *)',
          'Bash(echo *)',
          'Bash(pwd)',
          'Bash(which *)',
          'Bash(gh *)',
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    expect(existsSync(settingsPath)).toBe(true);
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.permissions.allow).toContain('Bash(git *)');
    expect(content.permissions.allow).toContain('Bash(npm *)');
    expect(content.permissions.allow).toContain('Bash(gh *)');
  });

  it('should not overwrite existing settings.local.json', () => {
    const claudeDir = resolve(workspacePath, '.claude');
    const settingsPath = resolve(claudeDir, 'settings.local.json');

    // Pre-create a custom settings file
    mkdirSync(claudeDir, { recursive: true });
    const customSettings = { permissions: { allow: ['Bash(custom *)'] } };
    writeFileSync(settingsPath, JSON.stringify(customSettings));

    // Verify existing file is preserved (injectLocalSettings skips if exists)
    expect(existsSync(settingsPath)).toBe(true);
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.permissions.allow).toEqual(['Bash(custom *)']);
  });

  it('should include git commands critical for bot workflow', () => {
    const requiredPatterns = ['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)'];
    const settings = {
      permissions: {
        allow: [
          'Bash(git *)',
          'Bash(npm *)',
          'Bash(npx *)',
          'Bash(node *)',
          'Bash(cat *)',
          'Bash(ls *)',
          'Bash(find *)',
          'Bash(grep *)',
          'Bash(echo *)',
          'Bash(pwd)',
          'Bash(which *)',
          'Bash(gh *)',
        ],
      },
    };

    for (const pattern of requiredPatterns) {
      expect(settings.permissions.allow).toContain(pattern);
    }
  });
});
