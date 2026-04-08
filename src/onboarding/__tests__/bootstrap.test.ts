import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isOnboardingCompleted,
  markOnboardingCompleted,
  clearOnboardingCompleted,
  getBootstrapPrompt,
} from '../bootstrap.js';

const TEST_DIR = resolve('/tmp/onboard-test-' + process.pid);

describe('isOnboardingCompleted', () => {
  const origCwd = process.cwd;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.cwd = () => TEST_DIR;
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return false when .env does not exist', () => {
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('should return false when ONBOARDING_COMPLETED is not set', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ANTHROPIC_API_KEY=sk-test\n');
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('should return false when ONBOARDING_COMPLETED is commented out', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), '# ONBOARDING_COMPLETED=true\n');
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('should return true when ONBOARDING_COMPLETED=true is set', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ONBOARDING_COMPLETED=true\nOTHER=value\n');
    expect(isOnboardingCompleted()).toBe(true);
  });

  it('should return false when ONBOARDING_COMPLETED=false', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ONBOARDING_COMPLETED=false\n');
    expect(isOnboardingCompleted()).toBe(false);
  });
});

describe('markOnboardingCompleted', () => {
  const origCwd = process.cwd;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.cwd = () => TEST_DIR;
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should append ONBOARDING_COMPLETED=true when not present', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'KEY=value\n');
    markOnboardingCompleted();
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ONBOARDING_COMPLETED=true');
  });

  it('should replace commented-out ONBOARDING_COMPLETED', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), '# ONBOARDING_COMPLETED=\nKEY=value\n');
    markOnboardingCompleted();
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ONBOARDING_COMPLETED=true');
    expect(content).not.toContain('# ONBOARDING_COMPLETED');
  });

  it('should replace existing ONBOARDING_COMPLETED=false', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ONBOARDING_COMPLETED=false\n');
    markOnboardingCompleted();
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ONBOARDING_COMPLETED=true');
    expect(content).not.toContain('false');
  });
});

describe('clearOnboardingCompleted', () => {
  const origCwd = process.cwd;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.cwd = () => TEST_DIR;
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should comment out ONBOARDING_COMPLETED', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ONBOARDING_COMPLETED=true\n');
    clearOnboardingCompleted();
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('# ONBOARDING_COMPLETED=');
    expect(content).not.toMatch(/^ONBOARDING_COMPLETED=true/m);
  });

  it('should be idempotent', () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'KEY=value\n');
    clearOnboardingCompleted(); // should not crash
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toBe('KEY=value\n');
  });
});

describe('getBootstrapPrompt', () => {
  it('should contain key file paths', () => {
    const prompt = getBootstrapPrompt();
    expect(prompt).toContain('.env');
    expect(prompt).toContain('config/agents.example.json');
    expect(prompt).toContain('config/personas/assistant.example.md');
    expect(prompt).toContain('config/knowledge/team.example.md');
  });

  it('should contain configuration phases', () => {
    const prompt = getBootstrapPrompt();
    expect(prompt).toContain('Phase 1');
    expect(prompt).toContain('飞书');
    expect(prompt).toContain('Phase 2');
    expect(prompt).toContain('团队');
    expect(prompt).toContain('Phase 3');
    expect(prompt).toContain('人格');
    expect(prompt).toContain('Phase 5');
    expect(prompt).toContain('可选');
    expect(prompt).toContain('ONBOARDING_COMPLETED=true');
  });

  it('should contain important rules', () => {
    const prompt = getBootstrapPrompt();
    expect(prompt).toContain('Alice/Bob/Carol');
    expect(prompt).toContain('跳过');
  });
});
