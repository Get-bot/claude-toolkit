/**
 * In-memory store for truncated command output (plan row D3, ADR-010,
 * AC-O2a, AC-O3, AC-O4, AC-O5, AC-O7a).
 *
 * When the §5.8 excerpter drops the middle of a stream, those bytes used to be
 * gone. Now the whole stream can be parked here and paged back out through
 * `fetch_output`. Five properties hold this together:
 *
 * 1. **Memory only, never disk.** Nothing in this file opens a file handle, so
 *    the AC-O3 test ("no new file under `SSH_MCP_HOME`") is a property of the
 *    implementation rather than of a cleanup step (AC-O3).
 * 2. **References are unguessable and are never written down.** 128 bits from
 *    `crypto.randomBytes`, returned in the response and nowhere else — in
 *    particular not on the audit line, whose schema is `.strict()` and would
 *    reject the field anyway (AC-O5).
 * 3. **PEM masking happens once, here, over the whole buffer.** See
 *    {@link maskRetained}. This is the single most load-bearing decision in the
 *    file.
 * 4. **One coordinate system.** `total_bytes`, the offset and the next cursor
 *    are all byte counts into the **masked** buffer. Masking changes length, so
 *    two coordinate systems would make "returns the whole thing in order"
 *    unverifiable (AC-O2a). Note this makes `total_bytes` here a *different*
 *    quantity from `stdout_meta.total_bytes`, which counts wire bytes.
 * 5. **Lifetime is swept lazily.** Expiry is checked when the store is touched,
 *    not on a timer: a timer would keep the process alive and would do work in
 *    the common case where nothing is stored at all.
 */
import * as crypto from 'node:crypto';

import { CodedError, ERROR_CODES } from '../errors.js';
import { maskPemBlocks } from '../log.js';
import type { ExcerptEncoding } from '../ssh/excerpt.js';

/** How long a retained stream stays fetchable (AC-O4). */
export const OUTPUT_TTL_MS = 10 * 60 * 1000;

/** Total bytes the store holds across all entries (AC-O4). */
export const OUTPUT_STORE_MAX_BYTES = 64 * 1024 * 1024;

/** Random bytes per reference: 128 bits (AC-O5). */
export const OUTPUT_REF_BYTES = 16;

/** Opening marker of a PEM block; the precheck in {@link maskRetained}. */
const PEM_MARKER = '-----BEGIN ';

interface StoredOutput {
  /** Already masked. Slices are handed out verbatim. */
  bytes: Buffer;
  encoding: ExcerptEncoding;
  createdAt: number;
}

/**
 * Insertion order is the eviction order, which is what `Map` gives for free:
 * "oldest first" needs no timestamps sort (AC-O4).
 */
const entries = new Map<string, StoredOutput>();
let storedBytes = 0;

/**
 * Apply `maskPemBlocks` to the whole buffer, once (AC-O7a).
 *
 * **Why not per page.** `maskPemBlocks` starts with
 * `if (!value.includes('-----BEGIN ')) return value` (`src/log.ts`), so a slice
 * that begins *after* a BEGIN marker contains no marker and is returned
 * verbatim. A 4 KiB private key straddling the default 64 KiB page boundary
 * would have its first half covered by `PEM_OPEN_PATTERN` and its second half
 * returned in clear. A single-chunk test passes; only paging leaks. Masking the
 * whole buffer here means the boundary does not exist, the coordinate system is
 * single, and the cost is one pass per stream instead of one per page.
 *
 * **Why `latin1`.** `maskPemBlocks` takes and returns a string, so a Buffer has
 * to round-trip. `utf8` would replace every ill-formed sequence with U+FFFD and
 * change both the length and the content of a non-UTF-8 stream — measured: the
 * 7 bytes `00 ff fe 80 41 42 90` come back as 15 bytes under `utf8` and as the
 * same 7 bytes under `latin1`. PEM markers and the replacement text are ASCII,
 * so the patterns behave identically in `latin1`. The repository's habit is
 * `utf8`/`base64` and nothing else, which is exactly why this is spelled out.
 *
 * **Why the precheck.** `buf.indexOf` over an ASCII needle costs one scan and
 * keeps the overwhelmingly common no-PEM path at zero round trips, so the
 * transient `3 × cap` allocation only happens for streams that really carry a
 * key. Non-UTF-8 streams get the same treatment: a PEM block is ASCII and shows
 * up in a binary stream just as plainly (AC-O7a).
 */
export function maskRetained(buf: Buffer): Buffer {
  if (buf.indexOf(PEM_MARKER) === -1) return buf;
  return Buffer.from(maskPemBlocks(buf.toString('latin1')), 'latin1');
}

function sweepExpired(now: number): void {
  for (const [ref, entry] of entries) {
    if (now - entry.createdAt < OUTPUT_TTL_MS) continue;
    entries.delete(ref);
    storedBytes -= entry.bytes.length;
  }
}

/** Drop oldest entries until `incoming` more bytes fit (AC-O4). */
function evictFor(incoming: number): void {
  for (const [ref, entry] of entries) {
    if (storedBytes + incoming <= OUTPUT_STORE_MAX_BYTES) return;
    entries.delete(ref);
    storedBytes -= entry.bytes.length;
  }
}

/**
 * Store one stream and return its reference, or `null` when there is nothing
 * worth storing.
 *
 * `null` for an empty buffer and for one larger than the whole store: both
 * would hand back a reference that cannot answer anything useful, and the
 * caller reads `null` as "leave `output_ref` alone" (AC-O4a).
 */
export function putOutput(bytes: Buffer, encoding: ExcerptEncoding): string | null {
  const masked = maskRetained(bytes);
  if (masked.length === 0 || masked.length > OUTPUT_STORE_MAX_BYTES) return null;

  const now = Date.now();
  sweepExpired(now);
  evictFor(masked.length);

  const ref = crypto.randomBytes(OUTPUT_REF_BYTES).toString('base64url');
  entries.set(ref, { bytes: masked, encoding, createdAt: now });
  storedBytes += masked.length;
  return ref;
}

export interface OutputPage {
  /** Raw bytes of this page; the caller decides how to encode them. */
  bytes: Buffer;
  encoding: ExcerptEncoding;
  /** Byte offset this page starts at, in the masked buffer. */
  offset: number;
  /** Byte offset of the next page, or `null` when this was the last one. */
  nextOffset: number | null;
  /** Length of the whole masked buffer (AC-O2a). */
  totalBytes: number;
}

/**
 * Largest `end` at or below `limit` that does not split a UTF-8 sequence.
 *
 * A `utf8` entry is handed back as text, so a page that stops mid-sequence
 * would decode to a replacement character and the concatenated pages would no
 * longer add up to `total_bytes` (AC-O2a). Since every page starts where the
 * previous one ended, aligning the end is enough to keep every page whole. The
 * twin of `utf8SafeEnd` in `src/ssh/excerpt.ts`, kept local so this module
 * depends on the SSH layer for a type only.
 */
function utf8SafeEnd(buf: Buffer, start: number, limit: number): number {
  const end = Math.min(limit, buf.length);
  if (end >= buf.length || end <= start) return end;

  let lead = end - 1;
  const floor = Math.max(start, end - 4);
  while (lead > floor && ((buf[lead] as number) & 0xc0) === 0x80) lead -= 1;

  const byte = buf[lead] as number;
  if ((byte & 0xc0) === 0x80) return end; // no lead byte in range: leave it
  let needed = 1;
  if (byte >= 0xf0) needed = 4;
  else if (byte >= 0xe0) needed = 3;
  else if (byte >= 0xc0) needed = 2;

  return lead + needed > end ? lead : end;
}

/**
 * One page of a retained stream, from `offset`, at most `maxBytes` long.
 *
 * Throws `output_expired` when the reference is unknown — expired, evicted, or
 * from a previous run of the server (AC-O4). The buffer was masked on the way
 * in, so this only slices (AC-O7a).
 */
export function getOutput(ref: string, offset: number, maxBytes: number): OutputPage {
  sweepExpired(Date.now());

  const entry = entries.get(ref);
  if (entry === undefined) {
    throw new CodedError(
      ERROR_CODES.output_expired,
      '보관된 출력을 찾을 수 없습니다. 10분이 지났거나, 총량 상한으로 폐기됐거나, 서버가 재시작됐습니다. 명령을 다시 실행하십시오.',
      { output_ref: ref }
    );
  }

  const total = entry.bytes.length;
  const start = Math.min(Math.max(0, offset), total);
  const rawEnd = Math.min(start + Math.max(1, maxBytes), total);
  const aligned = entry.encoding === 'utf8' ? utf8SafeEnd(entry.bytes, start, rawEnd) : rawEnd;
  // A window too narrow to hold one whole character would align to nothing and
  // hand the caller a cursor that never advances. The tool's `max_bytes` floor
  // makes that unreachable in production; the guard keeps it unreachable full
  // stop, at the cost of one split sequence in a case nobody should ask for.
  const end = aligned <= start && start < total ? rawEnd : aligned;

  return {
    bytes: entry.bytes.subarray(start, end),
    encoding: entry.encoding,
    offset: start,
    nextOffset: end < total ? end : null,
    totalBytes: total,
  };
}

/** Forget everything. For tests, and for a clean shutdown. */
export function resetOutputStore(): void {
  entries.clear();
  storedBytes = 0;
}

/** Entry count and total bytes held. For tests and diagnostics. */
export function outputStoreStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: storedBytes };
}
