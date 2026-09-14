/**
 * Dependency-free primitives shared by the foundation modules (CR-9).
 *
 * This module sits at the bottom of the dependency graph and **must not import
 * anything from `src/`**. That is what lets `log.ts`, `config/store.ts`,
 * `config/state.ts` and `audit.ts` all use it without creating a cycle.
 *
 * Canonical home for `byteLength`, `isEnoent` and `errorMessage`: other lanes
 * that still have private copies (`ssh/error.ts`, `setup/cli.ts`) should import
 * from here instead.
 */

/** UTF-8 byte length of a string. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** True when `err` looks like a Node system error carrying `code`. */
export function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** True for a "no such file or directory" error. */
export function isEnoent(err: unknown): boolean {
  return isErrnoCode(err, 'ENOENT');
}

/**
 * Message of an unknown throwable. Never throws, and never returns
 * `[object Object]` for an `Error`.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
