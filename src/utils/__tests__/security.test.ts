import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    security: {
      allowedUserIds: [] as string[],
    },
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { isUserAllowed, containsDangerousCommand } from '../security.js';
import { config } from '../../config.js';

describe('isUserAllowed', () => {
  beforeEach(() => {
    config.security.allowedUserIds = [];
  });

  it('should allow any user when allowlist is empty', () => {
    expect(isUserAllowed('user_123')).toBe(true);
    expect(isUserAllowed('anyone')).toBe(true);
  });

  it('should allow user in the allowlist', () => {
    config.security.allowedUserIds = ['user_a', 'user_b'];
    expect(isUserAllowed('user_a')).toBe(true);
    expect(isUserAllowed('user_b')).toBe(true);
  });

  it('should deny user not in the allowlist', () => {
    config.security.allowedUserIds = ['user_a', 'user_b'];
    expect(isUserAllowed('user_c')).toBe(false);
    expect(isUserAllowed('')).toBe(false);
  });
});

describe('containsDangerousCommand', () => {
  it('should detect rm -rf /', () => {
    expect(containsDangerousCommand('rm -rf /')).toBe(true);
  });

  it('should detect mkfs commands', () => {
    expect(containsDangerousCommand('mkfs.ext4 /dev/sda1')).toBe(true);
  });

  it('should detect dd if= commands', () => {
    expect(containsDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('should detect write to disk device', () => {
    expect(containsDangerousCommand('> /dev/sda')).toBe(true);
  });

  it('should detect shutdown', () => {
    expect(containsDangerousCommand('shutdown -h now')).toBe(true);
  });

  it('should detect reboot', () => {
    expect(containsDangerousCommand('reboot')).toBe(true);
  });

  it('should detect init 0', () => {
    expect(containsDangerousCommand('init 0')).toBe(true);
  });

  it('should allow safe commands', () => {
    expect(containsDangerousCommand('ls -la')).toBe(false);
    expect(containsDangerousCommand('git status')).toBe(false);
    expect(containsDangerousCommand('npm install')).toBe(false);
    expect(containsDangerousCommand('cat file.txt')).toBe(false);
    expect(containsDangerousCommand('rm file.txt')).toBe(false);
  });

  it('should allow rm -rf on non-root paths', () => {
    expect(containsDangerousCommand('rm -rf ./node_modules')).toBe(false);
    expect(containsDangerousCommand('rm -rf /tmp/test')).toBe(false);
  });
});
