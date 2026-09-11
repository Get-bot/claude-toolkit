// PLACEHOLDER — replaced by worker-cli
/**
 * Contract expected by `src/index.ts`:
 *
 *   `runSetup(argv)` receives the arguments **after** the `setup` sub-command,
 *   e.g. `ssh-mcp setup prod deploy@web01 --approval-fallback fail-closed`
 *   arrives as `['prod', 'deploy@web01', '--approval-fallback', 'fail-closed']`.
 *   The resolved number becomes the process exit code (0 on success).
 */
export async function runSetup(argv: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED: setup (owned by worker-cli)');
}
