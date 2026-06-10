import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from 'fs';
import { resolve } from 'path';
import {
  searchFiles,
  readFileContent,
  writeFileContent,
  getAllowedReadRoots,
  getAllowedWriteRoots,
  isReadAllowed,
  isWriteAllowed,
} from '../../src/utils/file-utils.js';

describe('File Utils', () => {
  const testDir = 'tests/temp-file-utils';

  beforeEach(() => {
    // Clean up and create test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(`${testDir}/nested`, { recursive: true });

    // Create test files
    writeFileSync(`${testDir}/file1.js`, 'console.log("file1");');
    writeFileSync(`${testDir}/file2.ts`, 'interface Test {}');
    writeFileSync(`${testDir}/file3.txt`, 'plain text');
    writeFileSync(`${testDir}/nested/file4.js`, 'nested file');
    writeFileSync(`${testDir}/.hidden.js`, 'hidden file');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('searchFiles', () => {
    const testCases = [
      {
        name: 'should find all files with default pattern',
        pattern: undefined,
        expected: {
          isArray: true,
          lengthGreaterThan: 0,
          excludes: ['node_modules', 'dist', '.git'],
        },
      },
      {
        name: 'should find files with specific glob pattern',
        pattern: `${testDir}/**/*.js`,
        expected: {
          lengthGreaterThanOrEqual: 2,
          allEndWith: '.js',
        },
      },
      {
        name: 'should find files with multiple extensions',
        pattern: `${testDir}/**/*.{js,ts}`,
        expected: {
          lengthGreaterThanOrEqual: 3,
          hasJs: true,
          hasTs: true,
        },
      },
      {
        name: 'should handle directory patterns correctly',
        pattern: testDir,
        expected: {
          lengthGreaterThan: 0,
          allStartWith: testDir,
        },
      },
      {
        name: 'should handle directory with trailing slash',
        pattern: `${testDir}/`,
        expected: {
          lengthGreaterThan: 0,
          allStartWith: testDir,
        },
      },
      {
        name: 'should return empty array for non-existent patterns',
        pattern: 'non-existent/**/*.xyz',
        expected: {
          length: 0,
        },
      },
      {
        name: 'should handle patterns with special characters',
        pattern: `${testDir}/**/*file*.js`,
        expected: {
          lengthGreaterThan: 0,
          allIncludeAndEndWith: ['file', '.js'],
        },
      },
      {
        name: 'should exclude ignored directories',
        pattern: undefined,
        expected: {
          excludes: ['node_modules', 'dist', '.git'],
        },
      },
    ];

    testCases.forEach(({ name, pattern, expected }) => {
      test(name, async () => {
        const files = await searchFiles(pattern);

        if (expected.isArray) {
          expect(files).toBeInstanceOf(Array);
        }

        if (expected.length !== undefined) {
          expect(files).toHaveLength(expected.length);
        }

        if (expected.lengthGreaterThan !== undefined) {
          expect(files.length).toBeGreaterThan(expected.lengthGreaterThan);
        }

        if (expected.lengthGreaterThanOrEqual !== undefined) {
          expect(files.length).toBeGreaterThanOrEqual(
            expected.lengthGreaterThanOrEqual
          );
        }

        if (expected.excludes) {
          expected.excludes.forEach(exclude => {
            expect(files.some(f => f.includes(exclude))).toBe(false);
          });
        }

        if (expected.allEndWith) {
          expect(files.every(f => f.endsWith(expected.allEndWith))).toBe(true);
        }

        if (expected.hasJs) {
          expect(files.some(f => f.endsWith('.js'))).toBe(true);
        }

        if (expected.hasTs) {
          expect(files.some(f => f.endsWith('.ts'))).toBe(true);
        }

        if (expected.allStartWith) {
          expect(files.every(f => f.startsWith(expected.allStartWith))).toBe(
            true
          );
        }

        if (expected.allIncludeAndEndWith) {
          const [include, endWith] = expected.allIncludeAndEndWith;
          expect(
            files.every(f => f.includes(include) && f.endsWith(endWith))
          ).toBe(true);
        }
      });
    });

    test('excludes node_modules/dist/.git even with an absolute pattern', async () => {
      // Build a nested tree containing dirs that must always be ignored.
      mkdirSync(`${testDir}/pkg/src`, { recursive: true });
      mkdirSync(`${testDir}/pkg/node_modules/dep`, { recursive: true });
      mkdirSync(`${testDir}/pkg/dist`, { recursive: true });
      mkdirSync(`${testDir}/pkg/.git`, { recursive: true });
      writeFileSync(`${testDir}/pkg/src/keep.js`, 'keep');
      writeFileSync(`${testDir}/pkg/node_modules/dep/index.js`, 'ignore');
      writeFileSync(`${testDir}/pkg/dist/bundle.js`, 'ignore');
      writeFileSync(`${testDir}/pkg/.git/config`, 'ignore');

      // Use an ABSOLUTE pattern (the case that previously bypassed the
      // relative ignore globs and enumerated node_modules/.git).
      const absPattern = `${resolve(testDir)}/pkg/**`;
      const files = await searchFiles(absPattern);

      expect(files.some(f => f.includes('src/keep.js'))).toBe(true);
      expect(files.some(f => f.includes('/node_modules/'))).toBe(false);
      expect(files.some(f => f.includes('/dist/'))).toBe(false);
      expect(files.some(f => f.includes('/.git/'))).toBe(false);
    });

    test('excludes symlinks that point at directories', async () => {
      mkdirSync(`${testDir}/proj/lib`, { recursive: true });
      writeFileSync(`${testDir}/proj/lib/mod.js`, 'module');
      // lib64 -> lib: a symlink to a directory. glob's nodir does not catch
      // this, so it would otherwise be returned and cause EISDIR on read.
      symlinkSync('lib', `${testDir}/proj/lib64`);

      const files = await searchFiles(`${resolve(testDir)}/proj/**`);

      expect(files.some(f => f.endsWith('lib/mod.js'))).toBe(true);
      expect(files.some(f => f.endsWith('/lib64'))).toBe(false);
    });
  });

  describe('readFileContent', () => {
    const testCases = [
      {
        name: 'should read file content correctly',
        setupFn: null,
        filePath: `${testDir}/file1.js`,
        expected: {
          content: 'console.log("file1");',
        },
      },
      {
        name: 'should handle UTF-8 content correctly',
        setupFn: () => {
          const testContent = 'Hello 世界 🌍';
          writeFileSync(`${testDir}/utf8.txt`, testContent, 'utf-8');
          return testContent;
        },
        filePath: `${testDir}/utf8.txt`,
        expected: {
          contentFromSetup: true,
        },
      },
      {
        name: 'should throw error for non-existent file',
        setupFn: null,
        filePath: 'non-existent-file.txt',
        expected: {
          shouldThrow: /Failed to read file/,
        },
      },
      {
        name: 'should handle empty files',
        setupFn: () => {
          writeFileSync(`${testDir}/empty.txt`, '');
        },
        filePath: `${testDir}/empty.txt`,
        expected: {
          content: '',
        },
      },
      {
        name: 'should handle large files',
        setupFn: () => {
          const largeContent = 'x'.repeat(10000);
          writeFileSync(`${testDir}/large.txt`, largeContent);
          return largeContent;
        },
        filePath: `${testDir}/large.txt`,
        expected: {
          contentFromSetup: true,
          length: 10000,
        },
      },
      {
        name: 'should preserve line endings',
        setupFn: () => {
          const contentWithLineEndings = 'line1\\nline2\\r\\nline3\\n';
          writeFileSync(`${testDir}/lineendings.txt`, contentWithLineEndings);
          return contentWithLineEndings;
        },
        filePath: `${testDir}/lineendings.txt`,
        expected: {
          contentFromSetup: true,
        },
      },
    ];

    testCases.forEach(({ name, setupFn, filePath, expected }) => {
      test(name, () => {
        let setupResult = null;
        if (setupFn) {
          setupResult = setupFn();
        }

        if (expected.shouldThrow) {
          expect(() => {
            readFileContent(filePath);
          }).toThrow(expected.shouldThrow);
        } else {
          const content = readFileContent(filePath);

          if (expected.content !== undefined) {
            expect(content).toBe(expected.content);
          }

          if (expected.contentFromSetup && setupResult) {
            expect(content).toBe(setupResult);
          }

          if (expected.length !== undefined) {
            expect(content.length).toBe(expected.length);
          }
        }
      });
    });
  });

  describe('writeFileContent', () => {
    const testCases = [
      {
        name: 'should write file content correctly',
        filePath: `${testDir}/write-test.txt`,
        content: 'test content',
        expected: {
          contentMatches: true,
        },
      },
      {
        name: 'should overwrite existing files',
        filePath: `${testDir}/overwrite-test.txt`,
        content: 'new content',
        setupFn: () => {
          writeFileContent(`${testDir}/overwrite-test.txt`, 'original');
        },
        expected: {
          contentMatches: true,
        },
      },
      {
        name: 'should handle UTF-8 content correctly',
        filePath: `${testDir}/utf8-write.txt`,
        content: 'Hello 世界 🌍',
        expected: {
          contentMatches: true,
        },
      },
      {
        name: 'should create nested directories if needed',
        filePath: `${testDir}/deep/nested/file.txt`,
        content: 'nested content',
        expected: {
          shouldThrow: /Failed to write file/,
        },
        note: "writeFileContent doesn't create directories",
      },
      {
        name: 'should throw error for invalid paths',
        filePath: '/invalid/path/that/does/not/exist.txt',
        content: 'content',
        expected: {
          // This absolute path is outside the default write allowlist (CWD),
          // so it is refused by the allowlist check before fs is touched.
          shouldThrow: /outside allowed write directories/,
        },
      },
      {
        name: 'should handle empty content',
        filePath: `${testDir}/empty-write.txt`,
        content: '',
        expected: {
          contentMatches: true,
        },
      },
      {
        name: 'should handle large content',
        filePath: `${testDir}/large-write.txt`,
        content: 'x'.repeat(50000),
        expected: {
          contentMatches: true,
          length: 50000,
        },
      },
      {
        name: 'should preserve line endings',
        filePath: `${testDir}/lineendings-write.txt`,
        content: 'line1\\nline2\\r\\nline3\\n',
        expected: {
          contentMatches: true,
        },
      },
    ];

    testCases.forEach(
      ({ name, filePath, content, setupFn, expected, note: _ }) => {
        test(name, () => {
          if (setupFn) {
            setupFn();
          }

          if (expected.shouldThrow) {
            expect(() => {
              writeFileContent(filePath, content);
            }).toThrow(expected.shouldThrow);
          } else {
            writeFileContent(filePath, content);

            if (expected.contentMatches) {
              const readContent = readFileSync(filePath, 'utf-8');
              expect(readContent).toBe(content);

              if (expected.length !== undefined) {
                expect(readContent.length).toBe(expected.length);
              }
            }
          }
        });
      }
    );
  });

  describe('integration', () => {
    const testCases = [
      {
        name: 'should work together for read-modify-write operations',
        setupFn: () => {
          const originalContent = 'const oldValue = 42;';
          writeFileContent(`${testDir}/integration.js`, originalContent);
          return originalContent;
        },
        testFn: () => {
          const content = readFileContent(`${testDir}/integration.js`);
          const modifiedContent = content.replace('oldValue', 'newValue');
          writeFileContent(`${testDir}/integration.js`, modifiedContent);
          return readFileContent(`${testDir}/integration.js`);
        },
        expected: {
          finalContent: 'const newValue = 42;',
        },
      },
      {
        name: 'should handle multiple file operations',
        setupFn: () => {
          const files = ['test1.js', 'test2.js', 'test3.js'];
          const content = 'test content';

          // Write multiple files
          files.forEach(file => {
            writeFileContent(`${testDir}/${file}`, content);
          });

          return { files, content };
        },
        testFn: async setupResult => {
          const { files, content } = setupResult;

          // Read them back
          const readResults = files.map(file => {
            return readFileContent(`${testDir}/${file}`);
          });

          // Verify with searchFiles
          const foundFiles = await searchFiles(`${testDir}/test*.js`);

          return { readResults, foundFiles, content };
        },
        expected: {
          checkMultipleFiles: true,
        },
      },
    ];

    testCases.forEach(({ name, setupFn, testFn, expected }) => {
      test(name, async () => {
        const setupResult = setupFn();
        const testResult = await testFn(setupResult);

        if (expected.finalContent) {
          expect(testResult).toBe(expected.finalContent);
        }

        if (expected.checkMultipleFiles) {
          const { readResults, foundFiles, content } = testResult;

          // Check that all files were read correctly
          readResults.forEach(readContent => {
            expect(readContent).toBe(content);
          });

          // Check that searchFiles found all files
          expect(foundFiles).toHaveLength(3);
        }
      });
    });
  });

  describe('read/write allowlist enforcement', () => {
    const readDir = 'tests/temp-read'; // readable + writable
    const readOnlyDir = 'tests/temp-readonly'; // readable, NOT writable
    const outsideDir = 'tests/temp-outside'; // neither
    let savedRead: string | undefined;
    let savedWrite: string | undefined;

    beforeEach(() => {
      savedRead = process.env.REFACTOR_MCP_ALLOWED_READ_DIRS;
      savedWrite = process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS;

      for (const d of [readDir, readOnlyDir, outsideDir]) {
        if (existsSync(d)) rmSync(d, { recursive: true, force: true });
        mkdirSync(d, { recursive: true });
      }
      writeFileSync(`${readDir}/file.txt`, 'in read+write');
      writeFileSync(`${readOnlyDir}/file.txt`, 'in read-only');
      writeFileSync(`${outsideDir}/secret.txt`, 'do not touch');

      // Reads allowed in readDir + readOnlyDir; writes allowed only in readDir.
      process.env.REFACTOR_MCP_ALLOWED_READ_DIRS = `${readDir},${readOnlyDir}`;
      process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS = readDir;
    });

    afterEach(() => {
      if (savedRead === undefined)
        delete process.env.REFACTOR_MCP_ALLOWED_READ_DIRS;
      else process.env.REFACTOR_MCP_ALLOWED_READ_DIRS = savedRead;
      if (savedWrite === undefined)
        delete process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS;
      else process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS = savedWrite;

      for (const d of [readDir, readOnlyDir, outsideDir]) {
        if (existsSync(d)) rmSync(d, { recursive: true, force: true });
      }
    });

    test('read roots default to cwd when unset', () => {
      delete process.env.REFACTOR_MCP_ALLOWED_READ_DIRS;
      expect(getAllowedReadRoots()).toEqual([resolve(process.cwd())]);
    });

    test('write roots default to cwd when unset', () => {
      delete process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS;
      expect(getAllowedWriteRoots()).toEqual([resolve(process.cwd())]);
    });

    test('parses comma-separated roots and trims whitespace', () => {
      process.env.REFACTOR_MCP_ALLOWED_READ_DIRS = ' src , tests ';
      expect(getAllowedReadRoots()).toEqual([resolve('src'), resolve('tests')]);
    });

    test('read and write allowlists are independent', () => {
      expect(isReadAllowed(`${readOnlyDir}/file.txt`)).toBe(true);
      expect(isWriteAllowed(`${readOnlyDir}/file.txt`)).toBe(false);
    });

    test('blocks ../ traversal escapes for both', () => {
      expect(isReadAllowed(`${readDir}/../temp-outside/secret.txt`)).toBe(
        false
      );
      expect(isWriteAllowed(`${readDir}/../temp-outside/secret.txt`)).toBe(
        false
      );
    });

    test('readFileContent allows read-allowed path', () => {
      expect(readFileContent(`${readOnlyDir}/file.txt`)).toBe('in read-only');
    });

    test('readFileContent throws for path outside read allowlist', () => {
      expect(() => readFileContent(`${outsideDir}/secret.txt`)).toThrow(
        /outside allowed read directories/
      );
    });

    test('writeFileContent succeeds inside write allowlist', () => {
      const target = `${readDir}/ok.txt`;
      writeFileContent(target, 'fine');
      expect(readFileSync(target, 'utf-8')).toBe('fine');
    });

    test('writeFileContent throws for read-only dir (read-allowed but not write-allowed)', () => {
      const target = `${readOnlyDir}/file.txt`;
      expect(() => writeFileContent(target, 'hacked')).toThrow(
        /outside allowed write directories/
      );
      expect(readFileSync(target, 'utf-8')).toBe('in read-only');
    });

    test('writeFileContent throws for path outside all allowlists', () => {
      const target = `${outsideDir}/secret.txt`;
      expect(() => writeFileContent(target, 'hacked')).toThrow(
        /outside allowed write directories/
      );
      expect(readFileSync(target, 'utf-8')).toBe('do not touch');
    });

    test('searchFiles excludes files outside the read allowlist', async () => {
      const results = await searchFiles('tests/temp-*/**/*');
      expect(results.some(f => f.includes('temp-read/file.txt'))).toBe(true);
      expect(results.some(f => f.includes('temp-readonly/file.txt'))).toBe(
        true
      );
      expect(results.some(f => f.includes('secret.txt'))).toBe(false);
    });

    test('setting root to / allows reading anywhere on the filesystem', () => {
      // The outside dir is normally blocked by the read allowlist...
      expect(isReadAllowed(`${outsideDir}/secret.txt`)).toBe(false);

      // ...but a root of '/' permits reads anywhere, including ../ traversal.
      process.env.REFACTOR_MCP_ALLOWED_READ_DIRS = '/';
      expect(isReadAllowed(`${outsideDir}/secret.txt`)).toBe(true);
      expect(isReadAllowed('/etc/hosts')).toBe(true);
      expect(isReadAllowed(`${readDir}/../temp-outside/secret.txt`)).toBe(true);
      expect(readFileContent(`${outsideDir}/secret.txt`)).toBe('do not touch');
    });

    test("setting write dir to '.' resolves to cwd and allows writes under it", () => {
      // '.' resolves to the current working directory.
      process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS = '.';
      expect(getAllowedWriteRoots()).toEqual([resolve(process.cwd())]);

      // The temp dirs live under cwd, so writes there are now allowed.
      expect(isWriteAllowed(`${readDir}/file.txt`)).toBe(true);
      expect(isWriteAllowed(`${readOnlyDir}/file.txt`)).toBe(true);
      expect(isWriteAllowed(`${outsideDir}/secret.txt`)).toBe(true);

      const target = `${readOnlyDir}/dot-write.txt`;
      writeFileContent(target, 'written via .');
      expect(readFileSync(target, 'utf-8')).toBe('written via .');

      // A path outside cwd is still refused.
      expect(isWriteAllowed('/etc/hosts')).toBe(false);
    });
  });
});
