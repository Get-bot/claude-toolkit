// PLACEHOLDER — replaced by worker-cli
/**
 * Contract expected by `src/index.ts`:
 *
 *   `runDoctor(argv)` receives the arguments **after** the `doctor`
 *   sub-command, e.g. `ssh-mcp doctor --json` arrives as `['--json']`.
 *   The resolved number becomes the process exit code: 0 when no check failed
 *   (warnings do not fail), non-zero when at least one check failed (AC21).
 */
export async function runDoctor(argv: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED: doctor (owned by worker-cli)');
}
