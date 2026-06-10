import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { glob } from 'glob';
import { resolve, relative, isAbsolute } from 'path';

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

export async function searchFiles(filePattern?: string): Promise<string[]> {
  if (!filePattern) {
    const files = await glob('**/*', {
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
      nodir: true,
    });
    return files.filter(isReadAllowed);
  }

  let pattern = filePattern;

  if (
    !pattern.includes('*') &&
    !pattern.includes('?') &&
    !pattern.includes('[')
  ) {
    try {
      if (existsSync(pattern) && statSync(pattern).isDirectory()) {
        pattern = pattern.endsWith('/') ? `${pattern}**` : `${pattern}/**`;
      }
    } catch {
      // If stat fails, use the pattern as-is
    }
  }

  const files = await glob(pattern, {
    ignore: ['node_modules/**', 'dist/**', '.git/**'],
    nodir: true,
  });
  return files.filter(isReadAllowed);
}

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
