/**
 * Terminal text measurement, shared by everything that draws a column-aligned
 * table or usage string: `doctor`, `host list`, and the `help` overview's width
 * test.
 *
 * Dependency-free like the rest of `internal/`, and deliberately not inside a
 * CLI module: `doctor/cli.ts` and `host/list.ts` each carried an identical
 * private copy, and exporting one of them for a test would have made that test
 * load `ssh2`, the config store and the safety patterns to measure a string.
 */

/**
 * Width in terminal cells. CJK text occupies two cells per glyph, so counting
 * code points would misalign every row that mixes Korean with ASCII.
 */
export function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    total += wide ? 2 : 1;
  }
  return total;
}

/** Right-pad with spaces to `target` display cells. Never truncates. */
export function pad(text: string, target: number): string {
  const fill = target - displayWidth(text);
  return fill > 0 ? text + ' '.repeat(fill) : text;
}
