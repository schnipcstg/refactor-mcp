# Upgrade Plan: Restrict refactor-mcp file access to allowlists of folders

## Goal

Add configurable allowlists so an agent using this MCP server can be restricted in which
directories it may **read** from and, independently, which it may **write** to. There are
**two separate settings**:

- One that restricts **reads**.
- One that restricts **writes**.

Each is supplied via its own environment variable, so an agent can set its own scope in the
`mcpServers.<name>.env` block of its agent JSON. The two are independent: e.g. an agent
could read broadly but only write to one folder.

This is **Option A**: enforcement lives inside the refactor-mcp server itself. We are NOT
implementing a Kiro `preToolUse` hook.

## Why this design

Every file read/write in this codebase funnels through three functions in
`src/utils/file-utils.ts`:

- `searchFiles(filePattern?)` — globs the candidate file list (used by both search and refactor).
- `readFileContent(filePath)` — reads a file.
- `writeFileContent(filePath, content)` — the only place anything is written to disk.

Because of this chokepoint, allowlist checks in this one file govern the whole server.
`writeFileContent` is the security-critical mutation path; `readFileContent`/`searchFiles`
are the read paths. We gate reads with the read allowlist and writes with the write allowlist.

## Configuration contract

Two independent env vars, same format:

- `REFACTOR_MCP_ALLOWED_READ_DIRS` — directories the server may read from.
- `REFACTOR_MCP_ALLOWED_WRITE_DIRS` — directories the server may write to.

Format for each: comma-separated list of directory paths (absolute or relative).
Whitespace around each entry is trimmed; empty entries are ignored. Paths are resolved to
absolute form with `path.resolve()` before comparison.

Behavior when a given var is **unset or empty**: default to `[process.cwd()]` for that
operation type (i.e. restrict to the current working directory only). This preserves
today's "relative to CWD" behavior while closing path-traversal escapes. The two vars
default independently.

Example agent JSON usage (for reference only — do not add to the repo):

```json
{
  "mcpServers": {
    "refactor": {
      "command": "npx",
      "args": ["@myuon/refactor-mcp@latest"],
      "env": {
        "REFACTOR_MCP_ALLOWED_READ_DIRS": "src,tests,docs",
        "REFACTOR_MCP_ALLOWED_WRITE_DIRS": "src"
      }
    }
  }
}
```

## Files to change

1. `src/utils/file-utils.ts` — add allowlist helpers and enforce them.
2. `tests/utils/file-utils.test.ts` — add tests for the new behavior.
3. `README.md` — document the two env vars.

No changes are needed in `src/server.ts`, `src/cli.ts`, `src/core/refactor-tool.ts`, or
`src/core/search-tool.ts` — they all call the utils unchanged.

---

## Step 1 — Implement allowlist logic in `src/utils/file-utils.ts`

### 1a. Update imports

The current import lines are:

```ts
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { glob } from 'glob';
```

Add a `path` import:

```ts
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { glob } from 'glob';
import { resolve, relative, isAbsolute } from 'path';
```

### 1b. Add helper functions (place near the top, after imports)

A shared parser plus two thin wrappers, and a generic membership check:

```ts
/**
 * Parse a comma-separated directory list env var into absolute roots.
 * Falls back to [cwd] when unset/empty.
 */
function parseRoots(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [resolve(process.cwd())];
  }
  const roots = envValue
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => resolve(p));
  return roots.length > 0 ? roots : [resolve(process.cwd())];
}

/** Absolute directory roots this server may READ from. */
export function getAllowedReadRoots(): string[] {
  return parseRoots(process.env.REFACTOR_MCP_ALLOWED_READ_DIRS);
}

/** Absolute directory roots this server may WRITE to. */
export function getAllowedWriteRoots(): string[] {
  return parseRoots(process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS);
}

/** True if filePath resolves to a location inside one of the given roots. */
function isWithinRoots(filePath: string, roots: string[]): boolean {
  const abs = resolve(filePath);
  return roots.some(root => {
    const rel = relative(root, abs);
    // rel === '' means the path IS the root; otherwise it must not climb out
    // ('..') and must not be absolute (different drive/root).
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** True if filePath is within the READ allowlist. */
export function isReadAllowed(filePath: string): boolean {
  return isWithinRoots(filePath, getAllowedReadRoots());
}

/** True if filePath is within the WRITE allowlist. */
export function isWriteAllowed(filePath: string): boolean {
  return isWithinRoots(filePath, getAllowedWriteRoots());
}
```

### 1c. Enforce on write (REQUIRED — security-critical)

Replace the existing `writeFileContent` with:

```ts
export function writeFileContent(filePath: string, content: string): void {
  if (!isWriteAllowed(filePath)) {
    throw new Error(
      `Refusing to write outside allowed write directories: ${filePath}`
    );
  }
  try {
    writeFileSync(filePath, content, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write file ${filePath}: ${error}`);
  }
}
```

### 1d. Enforce on read

Replace the existing `readFileContent` with:

```ts
export function readFileContent(filePath: string): string {
  if (!isReadAllowed(filePath)) {
    throw new Error(
      `Refusing to read outside allowed read directories: ${filePath}`
    );
  }
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }
}
```

### 1e. Filter enumerated files in `searchFiles` (uses the READ allowlist)

`searchFiles` is a discovery/read operation, so it is gated by the read allowlist. Both
`glob(...)` calls currently `return` directly. Capture the result and filter via
`isReadAllowed`.

Change the default (no-pattern) branch from:

```ts
  if (!filePattern) {
    return await glob('**/*', {
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
      nodir: true,
    });
  }
```

to:

```ts
  if (!filePattern) {
    const files = await glob('**/*', {
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
      nodir: true,
    });
    return files.filter(isReadAllowed);
  }
```

And change the final return from:

```ts
  return await glob(pattern, {
    ignore: ['node_modules/**', 'dist/**', '.git/**'],
    nodir: true,
  });
```

to:

```ts
  const files = await glob(pattern, {
    ignore: ['node_modules/**', 'dist/**', '.git/**'],
    nodir: true,
  });
  return files.filter(isReadAllowed);
```

> Note: glob returns paths relative to CWD; `isReadAllowed` calls `resolve()` on them, so
> the comparison is correct regardless of relative vs absolute.

### Interaction note for refactor

`performRefactor` in `src/core/refactor-tool.ts` first calls `searchFiles` (read-gated),
then `readFileContent` (read-gated), then `writeFileContent` (write-gated). This means a
file must be in the **read** allowlist to be discovered/considered, and additionally in the
**write** allowlist to actually be modified. A read-only folder (in read list, not in write
list) will be searchable but refactor attempts to write it will throw. This is the intended
behavior and should be reflected in the README.

---

## Step 2 — Add tests in `tests/utils/file-utils.test.ts`

Follow the existing conventions: Vitest (`describe/test/expect`), `.js` import extension,
and the temp-directory + `beforeEach`/`afterEach` cleanup pattern.

Import the new helpers alongside the existing ones:

```ts
import {
  searchFiles,
  readFileContent,
  writeFileContent,
  getAllowedReadRoots,
  getAllowedWriteRoots,
  isReadAllowed,
  isWriteAllowed,
} from '../../src/utils/file-utils.js';
```

Add `import { resolve } from 'path';` near the top if not already present.

Add a new `describe` block. The helpers read `process.env` and `process.cwd()` at call
time, so save and restore both env vars around each test.

```ts
describe('read/write allowlist enforcement', () => {
  const readDir = 'tests/temp-read';     // readable + writable
  const readOnlyDir = 'tests/temp-readonly'; // readable, NOT writable
  const outsideDir = 'tests/temp-outside';   // neither
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
    if (savedRead === undefined) delete process.env.REFACTOR_MCP_ALLOWED_READ_DIRS;
    else process.env.REFACTOR_MCP_ALLOWED_READ_DIRS = savedRead;
    if (savedWrite === undefined) delete process.env.REFACTOR_MCP_ALLOWED_WRITE_DIRS;
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
    expect(isReadAllowed(`${readDir}/../temp-outside/secret.txt`)).toBe(false);
    expect(isWriteAllowed(`${readDir}/../temp-outside/secret.txt`)).toBe(false);
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
    expect(results.some(f => f.includes('temp-readonly/file.txt'))).toBe(true);
    expect(results.some(f => f.includes('secret.txt'))).toBe(false);
  });
});
```

> IMPORTANT: Confirm the pre-existing tests in `tests/utils/file-utils.test.ts` still pass.
> Existing `searchFiles` tests use a `tests/temp-file-utils` directory under the repo root;
> with the default read allowlist (CWD = repo root) those remain in scope and should pass.
> If any pre-existing test relied on reading/writing outside CWD, adjust it to set the
> appropriate env var and note the change.

---

## Step 3 — Update `README.md`

Add a section documenting both env vars (suggested placement: under "MCP Integration" /
"Manual Configuration").

````markdown
### Restricting file access (read / write allowlists)

By default, `refactor-mcp` can read and modify any file under the current working
directory. You can restrict reads and writes independently with two environment variables:

- `REFACTOR_MCP_ALLOWED_READ_DIRS` — comma-separated directories the server may read from
  (also limits which files search/refactor will discover).
- `REFACTOR_MCP_ALLOWED_WRITE_DIRS` — comma-separated directories the server may write to.

```json
{
  "mcpServers": {
    "refactor-mcp": {
      "command": "npx",
      "args": ["@myuon/refactor-mcp@latest"],
      "env": {
        "REFACTOR_MCP_ALLOWED_READ_DIRS": "src,tests,docs",
        "REFACTOR_MCP_ALLOWED_WRITE_DIRS": "src"
      }
    }
  }
}
```

- Paths may be absolute or relative (resolved against the server's working directory).
- Operations outside the relevant allowlist are refused, including `../` traversal.
- Each variable defaults independently to the current working directory when unset.
- The two are independent: a folder in the read list but not the write list is searchable
  and readable, but refactor attempts to modify it will fail. To refactor a file it must be
  in **both** lists.
````

---

## Step 4 — Verify

Run the repo's quality gate from `~/git/refactor-mcp`:

```bash
npm run check
```

This runs, in order: `type-check` (tsc --noEmit), `lint` (eslint), `format:check`
(prettier), and `test:run` (vitest run). All must pass.

If only iterating on tests, `npm run test:run` runs the suite once; `npm test` is watch mode.
If prettier flags formatting, run `npm run format` to auto-fix, then re-run `npm run check`.

### Acceptance criteria

- `getAllowedReadRoots()` / `getAllowedWriteRoots()` each return `[cwd]` when their env var
  is unset, and the parsed/resolved list when set.
- `readFileContent` throws for a path outside the **read** allowlist.
- `writeFileContent` throws and writes nothing for a path outside the **write** allowlist.
- A folder that is read-allowed but not write-allowed: readable/searchable, but writes throw.
- `searchFiles` omits files outside the read allowlist for both the default and
  explicit-pattern branches.
- `../` traversal out of an allowed root is blocked for both read and write.
- All pre-existing tests still pass; `npm run check` is green.

## Notes / limitations (do not need to fix, just be aware)

- This is application-level enforcement inside the Node process, not an OS sandbox. It is
  robust against bad `file_pattern` inputs and traversal, but a determined process could
  bypass JS-level checks. For hard isolation, combine with OS permissions or a container.
- The `code_refactor` MCP tool still calls `performRefactor` with `dryRun: false`
  hardcoded in `src/server.ts`; this plan does not change that. The write allowlist is the
  intended safety mechanism.
- No new runtime dependencies are required (`path` is built in; `glob` already present).
