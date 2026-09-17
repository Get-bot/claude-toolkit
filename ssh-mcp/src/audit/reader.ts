/**
 * Reverse reader over `audit.jsonl` and its rotations (plan row C3, ADR-011,
 * AC-H2, AC-H2c).
 *
 * `history` answers newest-first, and the audit file is append-only, so the
 * newest line is the last one. Reading the whole file and reversing it would
 * put up to 10 MiB on the heap for one page (`rotateBytes`, `src/audit.ts`),
 * four times over once the rotations are included. Instead this module opens a
 * descriptor and walks **backwards** in {@link DEFAULT_CHUNK_BYTES} chunks,
 * splitting each chunk on `\n` and carrying the leading fragment over to the
 * next (older) chunk. Heap cost is one chunk plus one line, whatever the file
 * size (AC-H2c).
 *
 * Two things callers rely on and must not be "simplified" away:
 *
 * - **Every line comes with the byte offset it starts at.** That offset is what
 *   a `history` cursor stores (`src/audit/cursor.ts`), so a later page can pick
 *   up exactly where this one stopped.
 * - **Paths come from `auditRotatedFilePath()`.** Rotation naming lives in
 *   `src/config/paths.ts` and is not restated here.
 *
 * Nothing in this module parses JSON. A line is bytes plus an offset; deciding
 * what a line means is the tool's job (AC-H3).
 *
 * This whole module is the cost of keeping audit in JSONL. ADR-011 accepts that
 * cost and bounds it by hiding the reader behind the `history` tool, so a later
 * move to SQLite deletes this file rather than rewriting its callers.
 */
import * as fs from 'node:fs';

import { auditRotatedFilePath } from '../config/paths.js';
import { isEnoent } from '../internal/util.js';

const LF = 0x0a;

/** Bytes read per backwards step (ADR-011). */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Hard ceiling on a single line, for the forward read in {@link readLineAt}.
 *
 * The writer caps lines at 16 KiB but does so best-effort: a record whose
 * metadata alone exceeds the budget is written oversized rather than dropped
 * (`enforceLineCap`, `src/audit.ts`). This bound is therefore generous, and its
 * job is only to stop a corrupted file with no newline in it from being read
 * into memory whole.
 *
 * Named for its domain because `src/ssh/excerpt.ts` has a `MAX_LINE_BYTES` too,
 * at 8 KiB — a different quantity for a different thing (how much of one line
 * of *remote output* an excerpt keeps). Nothing connects the two values, and
 * the shared name invited a reader who had seen one to assume the other's.
 */
export const MAX_AUDIT_LINE_BYTES = 1024 * 1024;

/** One raw line and where it begins in its file. */
export interface AuditFileLine {
  /** Byte offset of the first byte of the line. */
  offset: number;
  /** Line content, newline excluded. */
  text: string;
}

/** A line plus the rotation index it came from. */
export interface WalkedLine extends AuditFileLine {
  /** 0 is the live file, 1..3 are rotations. */
  fileIndex: number;
}

/** Size of one audit file in bytes, or `null` when it does not exist. */
export function auditFileSize(fileIndex: number): number | null {
  try {
    return fs.statSync(auditRotatedFilePath(fileIndex)).size;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Read the one line that starts at `offset`, and say where it ends.
 *
 * The end offset is what {@link readNewestFirst} needs to include that same
 * line in a page, and the text is what the cursor's line hash is taken over
 * (ADR-011). Returns `null` when `offset` is past the end of the file, or when
 * no newline appears within {@link MAX_AUDIT_LINE_BYTES} — both are "this cursor
 * cannot be resumed", which the caller reports as `history_cursor_stale`.
 */
export function readLineAt(
  fileIndex: number,
  offset: number
): { text: string; end: number } | null {
  if (!Number.isInteger(offset) || offset < 0) return null;

  let fd: number;
  try {
    fd = fs.openSync(auditRotatedFilePath(fileIndex), 'r');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return null;

    const chunks: Buffer[] = [];
    let scanned = 0;
    let position = offset;

    while (position < size && scanned < MAX_AUDIT_LINE_BYTES) {
      const want = Math.min(DEFAULT_CHUNK_BYTES, size - position, MAX_AUDIT_LINE_BYTES - scanned);
      const buf = Buffer.alloc(want);
      const read = fs.readSync(fd, buf, 0, want, position);
      if (read === 0) break;
      const slice = buf.subarray(0, read);
      const lf = slice.indexOf(LF);
      if (lf !== -1) {
        chunks.push(slice.subarray(0, lf));
        const end = position + lf + 1;
        return { text: Buffer.concat(chunks).toString('utf8'), end };
      }
      chunks.push(slice);
      scanned += read;
      position += read;
    }

    // End of file with no trailing newline: the last line still counts.
    if (position >= size && scanned > 0) {
      return { text: Buffer.concat(chunks).toString('utf8'), end: size };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Yield the lines of one audit file from `end` backwards, newest first.
 *
 * `end` is an exclusive byte bound and must sit on a line boundary — either the
 * file size, or the end offset {@link readLineAt} reported for the line a
 * cursor points at. Empty lines are skipped: the writer never produces one, so
 * a blank line is padding rather than a record, and counting it as broken JSON
 * would report skips for a file that is merely newline-padded.
 *
 * The descriptor is closed by the `finally` below, which a `for...of` that
 * breaks early also triggers (it calls the generator's `return`).
 */
export function* readNewestFirst(
  fileIndex: number,
  end: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES
): Generator<AuditFileLine> {
  if (end <= 0) return;

  let fd: number;
  try {
    fd = fs.openSync(auditRotatedFilePath(fileIndex), 'r');
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }

  try {
    const size = fs.fstatSync(fd).size;
    let position = Math.min(end, size);
    // Bytes already read that belong to a line whose start is further back.
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const want = Math.min(chunkBytes, position);
      const start = position - want;
      const buf = Buffer.alloc(want);
      const read = fs.readSync(fd, buf, 0, want, start);
      if (read !== want) {
        // A short read here means the file changed under us; stop rather than
        // hand back lines stitched from two different states.
        return;
      }

      const region = carry.length === 0 ? buf : Buffer.concat([buf, carry]);
      let regionEnd = region.length;

      while (regionEnd > 0) {
        let contentEnd = regionEnd;
        if (region[contentEnd - 1] === LF) contentEnd -= 1;
        const lf = contentEnd === 0 ? -1 : region.lastIndexOf(LF, contentEnd - 1);
        if (lf === -1) break; // line starts before this chunk: carry it over
        const lineStart = lf + 1;
        if (contentEnd > lineStart) {
          yield {
            offset: start + lineStart,
            text: region.subarray(lineStart, contentEnd).toString('utf8'),
          };
        }
        regionEnd = lineStart;
      }

      carry = region.subarray(0, regionEnd);
      // A file with no newline in it would otherwise make `carry` grow to the
      // whole file, which is exactly the heap behaviour this reader exists to
      // avoid (AC-H2c). Treat it as corruption and stop.
      if (carry.length > MAX_AUDIT_LINE_BYTES) return;
      position = start;
    }

    // Whatever is left starts at byte 0, so it is a whole line.
    let contentEnd = carry.length;
    if (contentEnd > 0 && carry[contentEnd - 1] === LF) contentEnd -= 1;
    if (contentEnd > 0) {
      yield { offset: 0, text: carry.subarray(0, contentEnd).toString('utf8') };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Where a walk begins: a rotation index and an exclusive byte bound in it. */
export interface WalkStart {
  fileIndex: number;
  end: number;
}

/**
 * Walk `start.fileIndex` from `start.end` backwards, then every older rotation
 * whole, up to and including `maxFileIndex` (AC-H2).
 *
 * Missing rotations are skipped rather than ending the walk: `.2` can exist
 * while `.1` was removed by hand, and refusing to read past the gap would hide
 * history that is still on disk.
 */
export function* walkAuditLines(
  start: WalkStart,
  maxFileIndex: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES
): Generator<WalkedLine> {
  for (const line of readNewestFirst(start.fileIndex, start.end, chunkBytes)) {
    yield { ...line, fileIndex: start.fileIndex };
  }
  for (let index = start.fileIndex + 1; index <= maxFileIndex; index += 1) {
    const size = auditFileSize(index);
    if (size === null || size === 0) continue;
    for (const line of readNewestFirst(index, size, chunkBytes)) {
      yield { ...line, fileIndex: index };
    }
  }
}
