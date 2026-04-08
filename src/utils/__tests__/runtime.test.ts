import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectRuntime, _resetRuntimeCache } from '../runtime.js';

describe('detectRuntime', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    _resetRuntimeCache();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    _resetRuntimeCache();
  });

  it('detects pm2 when pm_id is set', () => {
    process.env.pm_id = '0';
    process.env.name = 'myapp';
    const rt = detectRuntime();
    expect(rt.manager).toBe('pm2');
    expect(rt.processName).toBe('myapp');
  });

  it('detects pm2 with null processName when name is not set', () => {
    process.env.pm_id = '0';
    delete process.env.name;
    const rt = detectRuntime();
    expect(rt.manager).toBe('pm2');
    expect(rt.processName).toBeNull();
  });

  it('detects systemd when INVOCATION_ID is set', () => {
    delete process.env.pm_id;
    process.env.INVOCATION_ID = 'abc123';
    const rt = detectRuntime();
    expect(rt.manager).toBe('systemd');
    expect(rt.processName).toBeNull();
  });

  it('pm2 takes priority over systemd', () => {
    process.env.pm_id = '0';
    process.env.name = 'myapp';
    process.env.INVOCATION_ID = 'abc123';
    const rt = detectRuntime();
    expect(rt.manager).toBe('pm2');
  });

  it('returns unknown when no manager detected', () => {
    delete process.env.pm_id;
    delete process.env.INVOCATION_ID;
    const rt = detectRuntime();
    // May be 'docker' if running in Docker, otherwise 'unknown'
    expect(['docker', 'unknown']).toContain(rt.manager);
  });

  it('caches result across calls', () => {
    process.env.pm_id = '0';
    process.env.name = 'first';
    detectRuntime();
    process.env.name = 'second';
    expect(detectRuntime().processName).toBe('first');
  });
});
