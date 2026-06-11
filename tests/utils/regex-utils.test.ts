import { describe, test, expect } from 'vitest';
import {
  buildRegex,
  buildRegexFlags,
  applyWholeWord,
  validateRegex,
} from '../../src/utils/regex-utils.js';

describe('regex-utils', () => {
  describe('buildRegexFlags', () => {
    test('always includes g', () => {
      expect(buildRegexFlags()).toBe('g');
      expect(buildRegexFlags({})).toBe('g');
    });

    test('adds i for caseInsensitive', () => {
      expect(buildRegexFlags({ caseInsensitive: true })).toBe('gi');
    });

    test('adds m for multiline', () => {
      expect(buildRegexFlags({ multiline: true })).toBe('gm');
    });

    test('combines flags', () => {
      expect(buildRegexFlags({ caseInsensitive: true, multiline: true })).toBe(
        'gim'
      );
    });
  });

  describe('applyWholeWord', () => {
    test('returns pattern unchanged when not requested', () => {
      expect(applyWholeWord('foo')).toBe('foo');
      expect(applyWholeWord('foo', { wholeWord: false })).toBe('foo');
    });

    test('wraps pattern in word boundaries when requested', () => {
      expect(applyWholeWord('foo', { wholeWord: true })).toBe('\\b(?:foo)\\b');
    });
  });

  describe('buildRegex', () => {
    test('compiles a valid pattern with default flags', () => {
      const re = buildRegex('foo');
      expect(re.flags).toBe('g');
      expect(re.source).toBe('foo');
    });

    test('applies case-insensitive matching', () => {
      const re = buildRegex('foo', { caseInsensitive: true });
      expect('FOO'.match(re)?.length).toBe(1);
    });

    test('whole word does not match substrings', () => {
      const re = buildRegex('foo', { wholeWord: true });
      expect('foobar foo'.match(re)?.length).toBe(1);
    });

    test('throws a readable error for invalid regex', () => {
      expect(() => buildRegex('[invalid')).toThrow(
        /Invalid regular expression "\[invalid":/
      );
    });
  });

  describe('validateRegex', () => {
    test('reports valid patterns', () => {
      expect(validateRegex('foo')).toEqual({ valid: true });
    });

    test('reports invalid patterns with an error string', () => {
      const result = validateRegex('[invalid');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/Invalid regular expression/);
      }
    });
  });
});
