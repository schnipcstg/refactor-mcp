import { existsSync } from 'fs';
import { searchFiles, readFileContent } from '../utils/file-utils.js';
import { groupConsecutiveLines } from '../utils/line-utils.js';
import { buildRegex, type RegexFlagOptions } from '../utils/regex-utils.js';

export interface SearchOptions extends RegexFlagOptions {
  searchPattern: string;
  contextPattern?: string;
  filePattern?: string;
  /** Stop after collecting this many matches in total (across all files). */
  maxMatches?: number;
}

export interface SearchMatch {
  line: number;
  content: string;
  captureGroups?: string[];
  matchedText?: string;
}

export interface SearchResult {
  filePath: string;
  matches: SearchMatch[];
  lineNumbers: number[];
  groupedLines: string[];
}

/** Aggregate statistics describing a search run, suitable for structured output. */
export interface SearchStats {
  fileCount: number;
  matchCount: number;
  /** True when the run stopped early because `maxMatches` was reached. */
  truncated: boolean;
}

export async function performSearch(
  options: SearchOptions
): Promise<SearchResult[]> {
  const files = await searchFiles(options.filePattern);
  const results: SearchResult[] = [];

  // buildRegex validates the pattern and applies flag/whole-word options. The
  // context pattern intentionally ignores whole-word (it describes surroundings,
  // not the token being matched) but honors case/multiline flags.
  const searchRegex = buildRegex(options.searchPattern, options);
  const contextRegex = options.contextPattern
    ? buildRegex(options.contextPattern, {
        caseInsensitive: options.caseInsensitive,
        multiline: options.multiline,
      })
    : null;

  const maxMatches =
    options.maxMatches !== undefined && options.maxMatches > 0
      ? options.maxMatches
      : Infinity;
  let totalMatches = 0;

  for (const filePath of files) {
    if (totalMatches >= maxMatches) break;
    if (!existsSync(filePath)) continue;

    const content = readFileContent(filePath);
    const lines = content.split('\n');

    const matches = [...content.matchAll(searchRegex)];
    const validMatches: SearchMatch[] = [];

    for (const match of matches) {
      if (totalMatches >= maxMatches) break;
      if (match.index !== undefined) {
        const beforeMatch = content.substring(0, match.index);
        const lineNumber = beforeMatch.split('\n').length;

        // Extract capture groups if any
        const captureGroups = match
          .slice(1)
          .filter(group => group !== undefined);
        // Extract the full matched text
        const matchedText = match[0];

        if (contextRegex) {
          const beforeMatchLines = beforeMatch.split('\n').slice(-5).join('\n');
          const afterMatchIndex = match.index + match[0].length;
          const afterMatch = content.substring(afterMatchIndex);
          const afterMatchLines = afterMatch.split('\n').slice(0, 5).join('\n');
          const contextArea = beforeMatchLines + match[0] + afterMatchLines;

          // test() advances lastIndex on a global regex; reset so each check is
          // independent.
          contextRegex.lastIndex = 0;
          if (contextRegex.test(contextArea)) {
            validMatches.push({
              line: lineNumber,
              content: lines[lineNumber - 1],
              captureGroups:
                captureGroups.length > 0 ? captureGroups : undefined,
              matchedText,
            });
            totalMatches++;
          }
        } else {
          validMatches.push({
            line: lineNumber,
            content: lines[lineNumber - 1],
            captureGroups: captureGroups.length > 0 ? captureGroups : undefined,
            matchedText,
          });
          totalMatches++;
        }
      }
    }

    if (validMatches.length > 0) {
      const uniqueLineNumbers = [...new Set(validMatches.map(m => m.line))];
      const lineNumbers = uniqueLineNumbers.sort((a, b) => a - b);
      const groupedLines = groupConsecutiveLines(lineNumbers);

      results.push({
        filePath,
        matches: validMatches,
        lineNumbers,
        groupedLines,
      });
    }
  }

  return results;
}

/** Compute aggregate stats for a set of search results. */
export function computeSearchStats(
  results: SearchResult[],
  truncated = false
): SearchStats {
  return {
    fileCount: results.length,
    matchCount: results.reduce((sum, r) => sum + r.matches.length, 0),
    truncated,
  };
}

export interface FormatOptions {
  includeCaptureGroups?: boolean;
  includeMatchedText?: boolean;
}

export function formatSearchResults(
  results: SearchResult[],
  options?: FormatOptions
): string {
  if (results.length === 0) {
    return 'No matches found for the given pattern';
  }

  if (options?.includeCaptureGroups || options?.includeMatchedText) {
    return formatDetailedSearchResults(results, options);
  }

  const formattedResults = results.map(
    result => `${result.filePath} (${result.groupedLines.join(', ')})`
  );

  return `Search results:\n${formattedResults.join('\n')}`;
}

function formatDetailedSearchResults(
  results: SearchResult[],
  options: FormatOptions
): string {
  const output: string[] = ['Search results:'];

  for (const result of results) {
    output.push(`\n${result.filePath}:`);

    for (const match of result.matches) {
      if (options.includeMatchedText) {
        output.push(`  Line ${match.line}: ${match.matchedText}`);
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

  return output.join('\n');
}
