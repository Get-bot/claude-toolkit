/**
 * The one guard every value-taking option goes through.
 *
 * Both CLIs hand-roll their argument loop, and both got the same defect: a
 * flag whose value is missing swallows the *next flag* as its value. It has
 * misfired twice in review.
 *
 * - `install claude-desktop --home --dry-run` registered `SSH_MCP_HOME=--dry-run`
 *   **and wrote the file for real**, because the flag meant to prevent the
 *   write had been eaten as data.
 * - `host add --label --approval-mode` set the label to `--approval-mode`,
 *   and the wizard then skipped the approval-mode question because that string
 *   was still sitting in argv.
 *
 * Both read as "the command ignored the flag I typed". Refusing a value that
 * starts with `-` costs a real label of `-x` — which nothing in this package
 * accepts anyway — and turns a silent misfire into a usage error naming the
 * flag.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); extracted 2026-09-14 from
 * `install/cli.ts` when `setup` was found to need the same guard.
 */

export type OptionValue = { ok: true; value: string } | { ok: false; message: string };

/**
 * Read the value that follows a value-taking option.
 *
 * `index` is the position of the value itself, not of the flag.
 */
export function optionValue(argv: readonly string[], index: number, flag: string): OptionValue {
  const value = argv[index];
  if (value === undefined || value === '') {
    return { ok: false, message: `${flag} needs a value` };
  }
  if (value.startsWith('-')) {
    return { ok: false, message: `${flag} needs a value, but got the option "${value}"` };
  }
  return { ok: true, value };
}
