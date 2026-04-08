import { describe, it, expect } from 'vitest';
import { matchesEditablePattern } from '../executor.js';

describe('matchesEditablePattern', () => {
  const cwd = '/root/dev/anywhere-code';

  describe('single-level wildcard (config/personas/*)', () => {
    const patterns = ['config/personas/*'];

    it('should match files directly in the pattern directory', () => {
      expect(matchesEditablePattern('config/personas/pm.md', patterns, cwd)).toBe(true);
      expect(matchesEditablePattern('config/personas/dev.md', patterns, cwd)).toBe(true);
    });

    it('should match absolute paths', () => {
      expect(matchesEditablePattern('/root/dev/anywhere-code/config/personas/pm.md', patterns, cwd)).toBe(true);
    });

    it('should NOT match files in subdirectories', () => {
      expect(matchesEditablePattern('config/personas/sub/file.md', patterns, cwd)).toBe(false);
    });

    it('should NOT match files in parent directory', () => {
      expect(matchesEditablePattern('config/pm.md', patterns, cwd)).toBe(false);
    });

    it('should NOT match unrelated paths', () => {
      expect(matchesEditablePattern('src/config/personas/pm.md', patterns, cwd)).toBe(false);
      expect(matchesEditablePattern('config/knowledge/team.md', patterns, cwd)).toBe(false);
    });
  });

  describe('recursive wildcard (config/**)', () => {
    const patterns = ['config/**'];

    it('should match files at any depth', () => {
      expect(matchesEditablePattern('config/agents.json', patterns, cwd)).toBe(true);
      expect(matchesEditablePattern('config/personas/pm.md', patterns, cwd)).toBe(true);
      expect(matchesEditablePattern('config/knowledge/sub/deep.md', patterns, cwd)).toBe(true);
    });

    it('should NOT match files outside the pattern directory', () => {
      expect(matchesEditablePattern('src/config.ts', patterns, cwd)).toBe(false);
    });
  });

  describe('exact match (config/agents.json)', () => {
    const patterns = ['config/agents.json'];

    it('should match the exact file', () => {
      expect(matchesEditablePattern('config/agents.json', patterns, cwd)).toBe(true);
    });

    it('should match with absolute path', () => {
      expect(matchesEditablePattern('/root/dev/anywhere-code/config/agents.json', patterns, cwd)).toBe(true);
    });

    it('should NOT match other files', () => {
      expect(matchesEditablePattern('config/agents.example.json', patterns, cwd)).toBe(false);
    });
  });

  describe('multiple patterns', () => {
    const patterns = ['config/personas/*', 'config/knowledge/*'];

    it('should match files in any pattern', () => {
      expect(matchesEditablePattern('config/personas/pm.md', patterns, cwd)).toBe(true);
      expect(matchesEditablePattern('config/knowledge/team.md', patterns, cwd)).toBe(true);
    });

    it('should NOT match files outside all patterns', () => {
      expect(matchesEditablePattern('config/agents.json', patterns, cwd)).toBe(false);
      expect(matchesEditablePattern('src/index.ts', patterns, cwd)).toBe(false);
    });
  });

  describe('absolute patterns', () => {
    const patterns = ['/etc/config/*'];

    it('should match absolute pattern directly', () => {
      expect(matchesEditablePattern('/etc/config/file.conf', patterns, cwd)).toBe(true);
    });

    it('should NOT match relative path that would resolve differently', () => {
      expect(matchesEditablePattern('etc/config/file.conf', patterns, cwd)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for empty patterns', () => {
      expect(matchesEditablePattern('config/personas/pm.md', [], cwd)).toBe(false);
    });

    it('should return false for empty file path', () => {
      expect(matchesEditablePattern('', ['config/*'], cwd)).toBe(false);
    });
  });
});
