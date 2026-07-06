import { describe, it, expect } from 'vitest';
import {
  parseFableCommand,
  resolveForcedModel,
  FABLE_MODEL,
  FABLE_MODEL_1M,
} from '../model-override.js';

describe('parseFableCommand', () => {
  it('empty args → claude-fable-5, default context', () => {
    const r = parseFableCommand('');
    expect(r.ok).toBe(true);
    expect(r.model).toBe(FABLE_MODEL);
    expect(r.context1m).toBe(false);
    expect(r.clear).toBeUndefined();
  });

  it('"1m" → claude-fable-5[1m], 1M context', () => {
    const r = parseFableCommand('1m');
    expect(r.ok).toBe(true);
    expect(r.model).toBe(FABLE_MODEL_1M);
    expect(r.context1m).toBe(true);
  });

  it('"1m" is case-insensitive', () => {
    for (const arg of ['1M', ' 1m ', '1m']) {
      const r = parseFableCommand(arg);
      expect(r.ok).toBe(true);
      expect(r.model).toBe(FABLE_MODEL_1M);
    }
  });

  it('"off" / "default" / "reset" → clear', () => {
    for (const arg of ['off', 'OFF', 'default', 'reset', ' off ']) {
      const r = parseFableCommand(arg);
      expect(r.ok).toBe(true);
      expect(r.clear).toBe(true);
      expect(r.model).toBeUndefined();
    }
  });

  it('unknown arg → usage error', () => {
    const r = parseFableCommand('2m');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('2m');
    expect(r.error).toContain('/fable');
    expect(r.model).toBeUndefined();
  });

  it('the 1M model string uses the CLI [1m] suffix convention', () => {
    expect(FABLE_MODEL_1M).toBe(`${FABLE_MODEL}[1m]`);
  });
});

describe('resolveForcedModel', () => {
  it('thread override takes precedence over session default', () => {
    expect(resolveForcedModel('claude-fable-5[1m]', 'claude-fable-5')).toBe('claude-fable-5[1m]');
  });

  it('falls back to session default when no thread override', () => {
    expect(resolveForcedModel(undefined, 'claude-fable-5')).toBe('claude-fable-5');
  });

  it('returns undefined when neither is set (caller falls back to agent model)', () => {
    expect(resolveForcedModel(undefined, undefined)).toBeUndefined();
  });

  it('thread override wins even when session is unset', () => {
    expect(resolveForcedModel('claude-fable-5', undefined)).toBe('claude-fable-5');
  });
});
