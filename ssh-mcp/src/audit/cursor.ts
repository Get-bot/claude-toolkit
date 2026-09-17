/**
 * `history` paging cursor (plan row C4, ADR-011, AC-H2a, AC-H2b).
 *
 * A cursor is `base64url(JSON.stringify({ f, o, s, h }))`:
 *
 * - `f` — rotation index the next page continues in (0 is the live file).
 * - `o` — byte offset of the **next line to read**, which is the oldest line
 *   this page did not return.
 * - `s` — size of file `f` at the moment the page was cut.
 * - `h` — hash of the line at `o`, as a second, independent check that `o`
 *   still means what it meant.
 *
 * ## Why succession is asymmetric
 *
 * Rotation only happens once the live file reaches 10 MiB (`rotateBytes`,
 * `src/audit.ts`), so between cutting a page and rotating there is always at
 * least one append. A rule of "the rotated file must be exactly `s` bytes"
 * therefore rejects every normal rotation — iteration 1 of the plan had that
 * rule and it was wrong 100% of the time. The live file grows; a rotated file
 * never does. So:
 *
 * - `f === 0`, current size `>= s` — appends only, and every appended byte is
 *   *after* `o`. Reading backwards from `o` is unaffected, so continue in place.
 * - `f === 0`, smaller or gone — a rotation moved the file to `.1`. Continue
 *   there only if `.1` is at least `s` bytes **and** `o < s`.
 * - `f > 0` — rotated files are immutable, so demand `=== s` on the same index.
 *   When a further rotation pushes indices up, that check fails and the cursor
 *   is reported stale on purpose (ADR-011): chasing a file as its index changes
 *   is more ways to be silently wrong than a caller re-querying is expensive.
 *
 * Every accepted path then re-reads the line at `o` and compares its hash to
 * `h`. Any mismatch — including two rotations that happen to line the sizes up
 * — ends as `history_cursor_stale`. Returning a plausible but wrong page is the
 * one outcome an audit reader must never produce.
 */
import * as crypto from 'node:crypto';

import { auditFileSize, readLineAt } from './reader.js';

/** Bytes of sha256 kept in `h`; 8 bytes is 16 hex characters. */
export const LINE_HASH_BYTES = 8;

export interface HistoryCursor {
  /** Rotation index: 0 is the live file. */
  f: number;
  /** Byte offset of the next (older) line to read. */
  o: number;
  /** Size of file `f` when the page was cut. */
  s: number;
  /** {@link lineHash} of the line at `o`. */
  h: string;
}

/**
 * Hash of one raw line.
 *
 * Taken over the line the cursor *points at* — the next one to read — rather
 * than over the last one returned, so the side that writes the cursor and the
 * side that verifies it are talking about the same bytes.
 */
export function lineHash(text: string): string {
  return crypto
    .createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, LINE_HASH_BYTES * 2);
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode a cursor, or `null` when it is not one we produced. */
export function decodeCursor(value: string): HistoryCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { f, o, s, h } = parsed as Record<string, unknown>;
  if (!Number.isInteger(f) || (f as number) < 0) return null;
  if (!Number.isInteger(o) || (o as number) < 0) return null;
  if (!Number.isInteger(s) || (s as number) < 0) return null;
  if (typeof h !== 'string' || h.length !== LINE_HASH_BYTES * 2) return null;
  return { f: f as number, o: o as number, s: s as number, h };
}

export type CursorResolution =
  | { ok: true; fileIndex: number; end: number }
  | { ok: false; reason: 'rotated' | 'line_changed' | 'out_of_range' };

/**
 * Turn a cursor into the place a walk should start, or say why it cannot.
 *
 * `end` is exclusive and sits just past the line at `o`, so that line is the
 * first one the next page returns.
 */
export function resolveCursor(cursor: HistoryCursor, maxFileIndex: number): CursorResolution {
  if (cursor.f > maxFileIndex) return { ok: false, reason: 'out_of_range' };

  let fileIndex: number;
  if (cursor.f === 0) {
    const live = auditFileSize(0);
    if (live !== null && live >= cursor.s) {
      fileIndex = 0;
    } else {
      const rotated = auditFileSize(1);
      if (rotated === null || rotated < cursor.s || cursor.o >= cursor.s) {
        return { ok: false, reason: 'rotated' };
      }
      if (1 > maxFileIndex) return { ok: false, reason: 'out_of_range' };
      fileIndex = 1;
    }
  } else {
    const size = auditFileSize(cursor.f);
    if (size === null || size !== cursor.s) return { ok: false, reason: 'rotated' };
    fileIndex = cursor.f;
  }

  const line = readLineAt(fileIndex, cursor.o);
  if (line === null || lineHash(line.text) !== cursor.h) {
    return { ok: false, reason: 'line_changed' };
  }
  return { ok: true, fileIndex, end: line.end };
}
