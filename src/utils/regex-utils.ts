/**
 * Options controlling how a user-supplied pattern is compiled into a RegExp.
 */
export interface RegexFlagOptions {
  /** Case-insensitive matching (adds the `i` flag). */
  caseInsensitive?: boolean;
  /** Multiline mode so `^`/`$` match line boundaries (adds the `m` flag). */
  multiline?: boolean;
  /** Wrap the pattern in `\b` word boundaries so only whole words match. */
  wholeWord?: boolean;
}

/**
 * Build the flag string for a RegExp from the given options. `g` is always
 * included because every call site iterates over all matches.
 */
export function buildRegexFlags(options?: RegexFlagOptions): string {
  let flags = 'g';
  if (options?.caseInsensitive) flags += 'i';
  if (options?.multiline) flags += 'm';
  return flags;
}

/**
 * Apply the whole-word wrapper to a pattern when requested. Done as a separate
 * step so callers that build their own RegExp (e.g. per-match replacement) can
 * reuse the exact same source string.
 */
export function applyWholeWord(
  pattern: string,
  options?: RegexFlagOptions
): string {
  return options?.wholeWord ? `\\b(?:${pattern})\\b` : pattern;
}

/**
 * Compile a user-supplied pattern into a RegExp, applying the flag/word-boundary
 * options and converting the opaque `SyntaxError` thrown by `new RegExp` into a
 * clear, user-facing message.
 *
 * @throws {Error} with a readable message when the pattern is not valid regex.
 */
export function buildRegex(
  pattern: string,
  options?: RegexFlagOptions
): RegExp {
  const source = applyWholeWord(pattern, options);
  const flags = buildRegexFlags(options);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression "${pattern}": ${reason}`);
  }
}

/**
 * Validate a pattern without keeping the compiled result. Returns a structured
 * outcome instead of throwing, for callers that want to report nicely.
 */
export function validateRegex(
  pattern: string,
  options?: RegexFlagOptions
): { valid: true } | { valid: false; error: string } {
  try {
    buildRegex(pattern, options);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
