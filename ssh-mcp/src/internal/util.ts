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

/**
 * Characters that must never reach a terminal, stored or printed.
 *
 * C0 plus DEL. An escape sequence typed into an answer — an arrow key at a text
 * question arrives as ESC `[B` — or stored in a label by an older build will
 * move somebody's cursor when the value is printed back, possibly long
 * afterwards. Three places defend against that with different rules: the
 * wizard and the argument parser **refuse** such a value, and `host list`
 * **replaces** it at the point of printing, because a file written by hand can
 * always hold one.
 *
 * The rules differ on purpose and stay where they are. Only the class is shared,
 * so widening it later (say to U+0085 or the Unicode separators) does not have
 * to be remembered in three files.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_CLASS = /[\u0000-\u001f\u007f]/u;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_CLASS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

/** True when the value holds anything from {@link CONTROL_CHAR_CLASS}. */
export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_CLASS.test(value);
}

/** The value with every such character replaced by `?`. */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHAR_CLASS_GLOBAL, '?');
}
