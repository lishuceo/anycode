import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    security: {
      allowedUserIds: [] as string[],
      ownerUserId: '',
    },
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'OWNER_USER_ID=\n'),
  writeFileSync: vi.fn(),
}));

import { isUserAllowed, containsDangerousCommand, isOwner, autoDetectOwner } from '../security.js';
import { config } from '../../config.js';

describe('isOwner', () => {
  beforeEach(() => {
    config.security.ownerUserId = '';
  });

  it('should return true when ownerUserId is unset (backward compat)', () => {
    expect(isOwner('anyone')).toBe(true);
  });

  it('should return true for matching userId', () => {
    config.security.ownerUserId = 'ou_owner123';
    expect(isOwner('ou_owner123')).toBe(true);
  });

  it('should return false for non-matching userId', () => {
    config.security.ownerUserId = 'ou_owner123';
    expect(isOwner('ou_other456')).toBe(false);
  });
});

describe('autoDetectOwner', () => {
  beforeEach(() => {
    config.security.ownerUserId = '';
    // Reset the settingOwner guard by re-importing would be complex,
    // so we test what we can: the config.security.ownerUserId state
  });

  it('should return false when owner is already configured', () => {
    config.security.ownerUserId = 'ou_existing';
    expect(autoDetectOwner('ou_new_user')).toBe(false);
    expect(config.security.ownerUserId).toBe('ou_existing');
  });

  it('should reject invalid userId format', () => {
    expect(autoDetectOwner('user\nINJECTED=bad')).toBe(false);
    expect(config.security.ownerUserId).toBe('');
  });

  it('should reject userId with special characters', () => {
    expect(autoDetectOwner('user;rm -rf /')).toBe(false);
    expect(config.security.ownerUserId).toBe('');
  });

  it('should set owner for valid userId and return true, then reject subsequent calls', () => {
    const result = autoDetectOwner('ou_first_user');
    expect(result).toBe(true);
    expect(config.security.ownerUserId).toBe('ou_first_user');

    // Second call returns false — owner already set
    expect(autoDetectOwner('ou_second_user')).toBe(false);
    expect(config.security.ownerUserId).toBe('ou_first_user');
  });
});

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

  it('should detect shutdown commands', () => {
    expect(containsDangerousCommand('shutdown -h now')).toBe(true);
    expect(containsDangerousCommand('shutdown -r 5')).toBe(true);
    expect(containsDangerousCommand('sudo shutdown -h now')).toBe(true);
    expect(containsDangerousCommand('shutdown')).toBe(true);
    expect(containsDangerousCommand('shutdown +5')).toBe(true);
  });

  it('should not false-positive on shutdown in text', () => {
    expect(containsDangerousCommand('graceful shutdown handling')).toBe(false);
    expect(containsDangerousCommand('the shutdown process was clean')).toBe(false);
    expect(containsDangerousCommand('implements shutdown logic for the server')).toBe(false);
  });

  it('should detect reboot as standalone command', () => {
    expect(containsDangerousCommand('reboot')).toBe(true);
    expect(containsDangerousCommand('sudo reboot')).toBe(true);
    expect(containsDangerousCommand('reboot -f')).toBe(true);
    expect(containsDangerousCommand('reboot now')).toBe(true);
  });

  it('should not false-positive on reboot in text', () => {
    expect(containsDangerousCommand('reboot the system after update')).toBe(false);
    expect(containsDangerousCommand('auto-reboot is disabled')).toBe(false);
  });

  it('should detect init 0', () => {
    expect(containsDangerousCommand('init 0')).toBe(true);
  });

  it('should not false-positive on init in text', () => {
    expect(containsDangerousCommand('reinit 0 times')).toBe(false);
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
