/**
 * Brand generator for tests (plan row E2b, OP-3, `src/output/resolve.ts`).
 *
 * `execOnce`, `runInSession`/`runCommand` and `ApproveCommandInput.command`
 * all require a `ResolvedCommand` now — a branded string only
 * `resolveCommand()` and `internalCommand()` can produce (guard G-2,
 * `eslint.config.js`). These integration tests are not exercising the
 * rewrite path itself; they just need their literal command strings to type
 * as `ResolvedCommand` at those doors. `internalCommand()` is the right tool
 * for that: it is a plain cast for commands the *server itself* built, which
 * is exactly what a fixed test-authored string is from the type's point of
 * view. ESLint's G-2 block exempts `tests/**` from the normal restriction on
 * importing it for this reason.
 *
 * One shared wrapper, rather than every call site importing `internalCommand`
 * for itself, so a reader sees a single seam and a future test reaches for
 * one obvious helper.
 */
import { internalCommand, type ResolvedCommand } from '../../src/output/resolve.js';

/** Brand a test-authored command string as a `ResolvedCommand`. */
export function resolved(cmd: string): ResolvedCommand {
  return internalCommand(cmd);
}
