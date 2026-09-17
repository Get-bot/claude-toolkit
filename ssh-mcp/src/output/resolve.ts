/**
 * The branded command type and the one place a command is rewritten
 * (plan rows E1/E2, ADR-012, AC-J5, AC-J5a).
 *
 * AC-J5 is the top security requirement of the `format: "json"` work: the
 * command that is **classified, approved and audited** must be the command that
 * **runs**. The v1.1 plan's first iteration kept that true by convention — the
 * handler would rewrite the string and then had to remember to pass the
 * rewritten value to `execOnce` as well. Writing that reminder down was the
 * admission that the shape allowed the bug, so the guarantee is a signature
 * now: {@link ResolvedCommand} is a branded string that only
 * {@link resolveCommand} and {@link internalCommand} can produce, and the three
 * doors a command can go through require it —
 *
 * | door | file |
 * |------|------|
 * | `ApproveCommandInput.command` | `src/tools/gated.ts` |
 * | `execOnce` | `src/ssh/exec.ts` |
 * | `runInSession` (public) and `runCommand` (private) | `src/ssh/session.ts` |
 *
 * `GateInput.command` in `src/safety/approval.ts` stays a plain `string` on
 * purpose: `ResolvedCommand` is `string & {…}` and so is assignable to it, which
 * leaves `hasTrailingBackground`, `buildCommandFrame` and `maskCommandSecrets`
 * unchanged. The brand is a gate on the *entry* points, not a type that has to
 * travel.
 *
 * **This file is the brand and the rewrite call, nothing else.** Redaction of a
 * parsed payload belongs in `src/log.ts`, which already owns
 * `SENSITIVE_KEY_PATTERN` and `maskPemBlocks`; putting it here would mix two
 * unrelated concerns and create a second redaction path.
 *
 * `src/ssh/exec.ts` and `src/ssh/session.ts` import {@link ResolvedCommand} with
 * `import type`, so the SSH layer gains no runtime edge to `src/safety/` through
 * {@link import('./jsonCommands.js')} — the same reason `limits.ts` says it is
 * kept dependency-free.
 */
import { planRewrite, type OutputPlan } from './jsonCommands.js';

declare const resolved: unique symbol;

/**
 * A command string that has been through {@link resolveCommand}.
 *
 * Structurally a `string`, so it flows into anything that takes one; nominally
 * distinct, so a raw model-supplied `string` will not compile at the three
 * doors listed in the file header (AC-J5a).
 */
export type ResolvedCommand = string & { readonly [resolved]: true };

/** The `format` input `exec` and `run_in_session` accept (AC-J1). */
export type OutputFormat = 'text' | 'json';

export interface ResolveResult {
  /** What must be classified, approved, audited and run (AC-J5). */
  command: ResolvedCommand;
  /** The format the caller asked for, carried so the response assembler does not re-thread it. */
  format: OutputFormat;
  /** `command` differs from the raw input. */
  rewritten: boolean;
  /**
   * How stdout becomes `parsed`, or `null` when the response carries no
   * `parsed` field at all (`format: "text"`) or nothing can be parsed.
   */
  plan: OutputPlan | null;
  /** The `parse_error` the response must report, or `null`. */
  parseError: 'not_rewritable' | null;
}

/**
 * Resolve a model-supplied command into the string that will actually run.
 *
 * `format: "text"` is the identity: the command is returned byte for byte and
 * no `parsed`/`parse_error` field is added, which is what keeps AC-J1's
 * "identical to 0.2.1" promise true.
 *
 * `format: "json"` defers every decision to `jsonCommands.ts`. Note that a
 * command AC-J3 refuses to rewrite still comes back here as the **original**
 * string: it runs, and the response reports `parse_error: "not_rewritable"`.
 */
export function resolveCommand(raw: string, format: OutputFormat): ResolveResult {
  if (format === 'text') {
    return {
      command: brand(raw),
      format,
      rewritten: false,
      plan: null,
      parseError: null,
    };
  }

  const rewrite = planRewrite(raw);
  return {
    command: brand(rewrite.command),
    format,
    rewritten: rewrite.command !== raw,
    plan: rewrite.plan,
    parseError: rewrite.reason,
  };
}

/**
 * Brand a string the **server itself** built, never anything a model supplied.
 *
 * Do not use this to satisfy the compiler. It is a plain cast, so one line of
 * `internalCommand(args.command)` in a tool handler would launder model input
 * straight past the classifier, the approval gate and the audit line — exactly
 * the hole {@link ResolvedCommand} exists to close. Its legitimate callers are
 * fixed strings the server composes and no person is asked about: today that is
 * the session reaper's `pkill` pair in `src/ssh/session.ts`.
 *
 * The rule is enforced, not merely written down: `eslint.config.js` refuses an
 * import of this name outside `src/ssh/session.ts` and `tests/**` (guard G-2,
 * plan row E1b).
 */
export function internalCommand(raw: string): ResolvedCommand {
  return brand(raw);
}

function brand(raw: string): ResolvedCommand {
  return raw as ResolvedCommand;
}
