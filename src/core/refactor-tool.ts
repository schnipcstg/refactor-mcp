import { existsSync } from 'fs';
import {
  searchFiles,
  readFileContent,
  writeFileContent,
} from '../utils/file-utils.js';
import {
  applyWholeWord,
  buildRegex,
  buildRegexFlags,
  type RegexFlagOptions,
} from '../utils/regex-utils.js';

export interface RefactorOptions extends RegexFlagOptions {
  searchPattern: string;
  replacePattern: string;
  contextPattern?: string;
  filePattern?: string;
  dryRun?: boolean;
  /** Stop after this many replacements in total (across all files). */
  maxMatches?: number;
}

export interface RefactorMatch {
  line: number;
  content: string;
  original: string;
  replaced: string;
  captureGroups?: string[];
}

export interface RefactorResult {
  filePath: string;
  replacements: number;
  matches: RefactorMatch[];
  modified: boolean;
}

/** Aggregate statistics describing a refactor run, suitable for structured output. */
export interface RefactorStats {
  fileCount: number;
  replacementCount: number;
  dryRun: boolean;
  /** True when the run stopped early because `maxMatches` was reached. */
  truncated: boolean;
}

export async function performRefactor(
  options: RefactorOptions
): Promise<RefactorResult[]> {
  const files = await searchFiles(options.filePattern);
  const results: RefactorResult[] = [];

  // Validate up front so a bad pattern fails fast with a clear message. The same
  // source string is reused for the per-match single-replacement regex below to
  // keep preview and write paths consistent.
  const searchRegex = buildRegex(options.searchPattern, options);
  const contextRegex = options.contextPattern
    ? buildRegex(options.contextPattern, {
        caseInsensitive: options.caseInsensitive,
        multiline: options.multiline,
      })
    : null;

  // Non-global regex used to compute the replacement for a single matched span.
  const singleMatchSource = applyWholeWord(options.searchPattern, options);
  const singleMatchFlags = buildRegexFlags(options).replace('g', '');
  const singleMatchRegex = new RegExp(singleMatchSource, singleMatchFlags);

  const maxMatches =
    options.maxMatches !== undefined && options.maxMatches > 0
      ? options.maxMatches
      : Infinity;
  let totalReplacements = 0;

  for (const filePath of files) {
    if (totalReplacements >= maxMatches) break;
    if (!existsSync(filePath)) continue;

    const content = readFileContent(filePath);
    const lines = content.split('\n');
    const matchedLines: RefactorMatch[] = [];

    // Single iteration over all matches builds BOTH the preview rows and the new
    // file content. Rebuilding the string from match spans (rather than calling
    // String.replace twice) guarantees the reported matches and the bytes written
    // to disk are derived from exactly the same set of matches, in order.
    const segments: string[] = [];
    let lastIndex = 0;
    let fileReplacements = 0;

    const matches = [...content.matchAll(searchRegex)];
    for (const match of matches) {
      if (match.index === undefined) continue;
      if (totalReplacements >= maxMatches) break;

      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;

      if (contextRegex) {
        const beforeMatch = content.substring(0, matchStart);
        const afterMatch = content.substring(matchEnd);
        const contextBefore = beforeMatch.split('\n').slice(-5).join('\n');
        const contextAfter = afterMatch.split('\n').slice(0, 5).join('\n');
        const contextArea = contextBefore + match[0] + contextAfter;

        contextRegex.lastIndex = 0;
        if (!contextRegex.test(contextArea)) {
          continue; // match present but not in required context: leave untouched
        }
      }

      const beforeMatch = content.substring(0, matchStart);
      const lineNumber = beforeMatch.split('\n').length;
      const originalLine = lines[lineNumber - 1];
      const captureGroups = match.slice(1).filter(group => group !== undefined);

      // Compute the replacement for just this matched span so capture-group
      // substitutions ($1, $2, ...) are applied correctly.
      const replaced = match[0].replace(
        singleMatchRegex,
        options.replacePattern
      );

      // Append the untouched gap before this match, then the replacement.
      segments.push(content.slice(lastIndex, matchStart));
      segments.push(replaced);
      lastIndex = matchEnd;

      matchedLines.push({
        line: lineNumber,
        content: originalLine,
        original: match[0],
        replaced,
        captureGroups: captureGroups.length > 0 ? captureGroups : undefined,
      });

      fileReplacements++;
      totalReplacements++;
    }

    if (fileReplacements > 0) {
      segments.push(content.slice(lastIndex));
      const newContent = segments.join('');

      if (!options.dryRun) {
        writeFileContent(filePath, newContent);
      }

      results.push({
        filePath,
        replacements: fileReplacements,
        matches: matchedLines,
        modified: true,
      });
    }
  }

  return results;
}

/** Compute aggregate stats for a set of refactor results. */
export function computeRefactorStats(
  results: RefactorResult[],
  dryRun = false,
  truncated = false
): RefactorStats {
  return {
    fileCount: results.length,
    replacementCount: results.reduce((sum, r) => sum + r.replacements, 0),
    dryRun,
    truncated,
  };
}

export interface RefactorFormatOptions {
  includeCaptureGroups?: boolean;
  includeMatchedText?: boolean;
  dryRun?: boolean;
}

export function formatRefactorResults(
  results: RefactorResult[],
  options?: RefactorFormatOptions | boolean
): string {
  // Handle backward compatibility - if boolean is passed, treat as dryRun
  const formatOptions: RefactorFormatOptions =
    typeof options === 'boolean' ? { dryRun: options } : options || {};
  if (results.length === 0) {
    return 'No matches found for the given pattern';
  }

  if (formatOptions.includeCaptureGroups || formatOptions.includeMatchedText) {
    return formatDetailedRefactorResults(results, formatOptions);
  }

  const formattedResults = results.map(
    result =>
      `${result.filePath}: ${result.replacements} replacements${formatOptions.dryRun ? ' (dry run)' : ''}`
  );

  const totalReplacements = results.reduce(
    (sum, result) => sum + result.replacements,
    0
  );

  return `Refactoring completed:\n${formattedResults.join('\n')}\n\nTotal: ${totalReplacements} replacements in ${results.length} files`;
}

function formatDetailedRefactorResults(
  results: RefactorResult[],
  options: RefactorFormatOptions
): string {
  const output: string[] = [
    `Refactoring completed${options.dryRun ? ' (dry run)' : ''}:`,
  ];

  for (const result of results) {
    output.push(`\n${result.filePath}: ${result.replacements} replacements`);

    for (const match of result.matches) {
      if (options.includeMatchedText) {
        output.push(
          `  Line ${match.line}: ${match.original} → ${match.replaced}`
        );
      } else {
        output.push(`  Line ${match.line}: ${match.content}`);
      }

      if (
        options.includeCaptureGroups &&
        match.captureGroups &&
        match.captureGroups.length > 0
      ) {
        output.push(`    └─ Captured: [${match.captureGroups.join(', ')}]`);
      }
    }
  }

  const totalReplacements = results.reduce(
    (sum, result) => sum + result.replacements,
    0
  );
  output.push(
    `\nTotal: ${totalReplacements} replacements in ${results.length} files${options.dryRun ? ' (dry run)' : ''}`
  );

  return output.join('\n');
}
