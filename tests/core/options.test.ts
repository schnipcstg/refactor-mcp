import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import {
  performSearch,
  computeSearchStats,
} from '../../src/core/search-tool.js';
import {
  performRefactor,
  computeRefactorStats,
} from '../../src/core/refactor-tool.js';

describe('search/refactor quick-win options', () => {
  const testDir = 'tests/temp-options';

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      `${testDir}/case.js`,
      `const Foo = 1;\nconst foo = 2;\nconst FOO = 3;`
    );
    writeFileSync(
      `${testDir}/words.js`,
      `let foo = 1;\nlet foobar = 2;\nlet barfoo = 3;`
    );
    writeFileSync(
      `${testDir}/many.js`,
      `a\na\na\na\na` // 5 single-letter lines
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  describe('case insensitivity', () => {
    test('search matches all cases when caseInsensitive', async () => {
      const results = await performSearch({
        searchPattern: 'foo',
        filePattern: `${testDir}/case.js`,
        caseInsensitive: true,
      });
      expect(results[0].matches).toHaveLength(3);
    });

    test('search is case-sensitive by default', async () => {
      const results = await performSearch({
        searchPattern: 'foo',
        filePattern: `${testDir}/case.js`,
      });
      expect(results[0].matches).toHaveLength(1);
    });
  });

  describe('whole word', () => {
    test('search only matches whole words', async () => {
      const results = await performSearch({
        searchPattern: 'foo',
        filePattern: `${testDir}/words.js`,
        wholeWord: true,
      });
      expect(results[0].matches).toHaveLength(1);
      expect(results[0].matches[0].line).toBe(1);
    });

    test('refactor only replaces whole words', async () => {
      await performRefactor({
        searchPattern: 'foo',
        replacePattern: 'baz',
        filePattern: `${testDir}/words.js`,
        wholeWord: true,
        dryRun: false,
      });
      const content = readFileSync(`${testDir}/words.js`, 'utf-8');
      expect(content).toContain('let baz = 1;');
      expect(content).toContain('let foobar = 2;');
      expect(content).toContain('let barfoo = 3;');
    });
  });

  describe('maxMatches', () => {
    test('search stops after maxMatches', async () => {
      const results = await performSearch({
        searchPattern: 'a',
        filePattern: `${testDir}/many.js`,
        maxMatches: 2,
      });
      const total = results.reduce((s, r) => s + r.matches.length, 0);
      expect(total).toBe(2);
    });

    test('refactor stops after maxMatches and only writes those', async () => {
      const results = await performRefactor({
        searchPattern: 'a',
        replacePattern: 'X',
        filePattern: `${testDir}/many.js`,
        maxMatches: 2,
        dryRun: false,
      });
      const total = results.reduce((s, r) => s + r.replacements, 0);
      expect(total).toBe(2);
      const content = readFileSync(`${testDir}/many.js`, 'utf-8');
      // Exactly two replacements applied, three left as 'a'.
      expect((content.match(/X/g) || []).length).toBe(2);
      expect((content.match(/a/g) || []).length).toBe(3);
    });
  });

  describe('invalid regex', () => {
    test('search throws a readable error', async () => {
      await expect(
        performSearch({
          searchPattern: '[invalid',
          filePattern: `${testDir}/case.js`,
        })
      ).rejects.toThrow(/Invalid regular expression/);
    });

    test('refactor throws a readable error', async () => {
      await expect(
        performRefactor({
          searchPattern: '[invalid',
          replacePattern: 'x',
          filePattern: `${testDir}/case.js`,
          dryRun: true,
        })
      ).rejects.toThrow(/Invalid regular expression/);
    });
  });

  describe('replacement-path consistency', () => {
    test('reported matches equal the replacements actually written', async () => {
      writeFileSync(`${testDir}/dup.js`, `x x x`);
      const results = await performRefactor({
        searchPattern: 'x',
        replacePattern: 'y',
        filePattern: `${testDir}/dup.js`,
        dryRun: false,
      });
      expect(results[0].replacements).toBe(3);
      expect(results[0].matches).toHaveLength(3);
      const content = readFileSync(`${testDir}/dup.js`, 'utf-8');
      expect(content).toBe('y y y');
    });

    test('capture-group replacement is applied per match', async () => {
      writeFileSync(`${testDir}/cap.js`, `const a = 1;\nconst b = 2;`);
      const results = await performRefactor({
        searchPattern: 'const (\\w+) = ',
        replacePattern: 'let $1 = ',
        filePattern: `${testDir}/cap.js`,
        dryRun: false,
      });
      expect(results[0].replacements).toBe(2);
      const content = readFileSync(`${testDir}/cap.js`, 'utf-8');
      expect(content).toBe('let a = 1;\nlet b = 2;');
    });
  });

  describe('stats helpers', () => {
    test('computeSearchStats aggregates files and matches', async () => {
      const results = await performSearch({
        searchPattern: 'a',
        filePattern: `${testDir}/many.js`,
      });
      const stats = computeSearchStats(results, false);
      expect(stats.fileCount).toBe(1);
      expect(stats.matchCount).toBe(5);
      expect(stats.truncated).toBe(false);
    });

    test('computeRefactorStats reports dryRun and totals', async () => {
      const results = await performRefactor({
        searchPattern: 'a',
        replacePattern: 'X',
        filePattern: `${testDir}/many.js`,
        dryRun: true,
      });
      const stats = computeRefactorStats(results, true, false);
      expect(stats.fileCount).toBe(1);
      expect(stats.replacementCount).toBe(5);
      expect(stats.dryRun).toBe(true);
    });
  });
});
