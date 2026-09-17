/**
 * Output excerpting for `exec` and `run_in_session` (plan row 3.3b, §5.8, AC12).
 *
 * A streaming accumulator: it is fed every byte of one stream (stdout or
 * stderr, never both), keeps a head buffer and a tail window, counts *all*
 * bytes and newlines including the ones it throws away, and at the end returns
 * either the whole stream or a head/tail excerpt with one fixed-format
 * omission marker line in between.
 *
 * Three properties the implementation is built around:
 *
 * 1. **Counters cover discarded data.** `total_lines` and `total_bytes` are
 *    accumulated on the way through, so `omitted_lines` is a real measurement
 *    and not a restatement of what was kept (AC12.3).
 * 2. **Reported side sizes are post-cut.** `head_bytes`/`tail_bytes` count the
 *    original stream bytes actually returned, after newline trimming and after
 *    the per-line 8 KiB cut, and they exclude any marker text this module
 *    inserts. That keeps `omitted_bytes = total - head - tail` exact instead of
 *    silently losing the bytes dropped inside a long line (§5.8 step 7).
 * 3. **Memory is bounded.** Both sides are clamped to `HARD_CEILING / 2`, so a
 *    stream of any length costs at most about `cap + 320 KiB` per direction.
 *    The opt-in `retain` option (ADR-010) raises that figure by its own cap and
 *    by nothing else: the bound stays independent of how long the stream is,
 *    which is what ADR-008 actually promised.
 *
 * The buffers are deliberately larger than the reported budgets: a stream that
 * ends up at or below `cap` must be returned byte for byte, which is only
 * possible if the head buffer and the tail window together span `cap`.
 *
 * Non-UTF-8 streams take a byte-slice path: line-based excerpting is
 * meaningless there, so every line-count field is `null`, the text is base64
 * and no omission marker line is inserted (AC10.2, AC12.9).
 *
 * Chunks passed to `push` are retained, not copied: callers must not mutate a
 * buffer after pushing it. Node stream `data` buffers satisfy this.
 */

/** Share of `cap` given to the head side (OPT-9 C). */
export const HEAD_RATIO = 0.4;
/** Lines each side tries to keep even when they are long (§5.8). */
export const MIN_SIDE_LINES = 20;
/** Per-line ceiling; a longer line is cut and annotated (AC12.8). */
export const MAX_LINE_BYTES = 8192;
/**
 * Upper bound on the omission marker line, newlines included. The fixed text
 * is 65 bytes and the two grouped numbers cannot exceed 26 bytes each.
 */
export const MARKER_LINE_MAX_BYTES = 128;

const LF = 0x0a;
const CR = 0x0d;

/** Parses the omission marker line produced by `omissionMarkerLine` (AC12.2). */
export const OMISSION_MARKER_PATTERN =
  /^\[ssh-mcp\] ──── 중간 ([\d,]+)줄 \/ ([\d,]+)바이트 생략 ────$/;

/** Parses the per-line cut notice added to a line over `maxLineBytes`. */
export const LINE_CUT_PATTERN = /…\[줄 잘림: ([\d,]+)바이트 생략\]/;

/** `1234567` becomes `"1,234,567"`. Locale-independent on purpose. */
export function groupDigits(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

/**
 * The one omission marker line (§5.8). Thousands separators are for the
 * reader; machine-readable values live in the meta fields.
 */
export function omissionMarkerLine(lines: number, bytes: number): string {
  return `[ssh-mcp] ──── 중간 ${groupDigits(lines)}줄 / ${groupDigits(bytes)}바이트 생략 ────`;
}

function lineCutNotice(bytes: number): string {
  return `…[줄 잘림: ${groupDigits(bytes)}바이트 생략]`;
}

export type ExcerptEncoding = 'utf8' | 'base64';

export interface ExcerptMeta {
  /** True when the stream exceeded `cap` and the middle was dropped. */
  truncated: boolean;
  encoding: ExcerptEncoding;
  /** Bytes seen on the wire, discarded ones included. */
  total_bytes: number;
  /** Lines seen on the wire; `null` for a non-UTF-8 stream. */
  total_lines: number | null;
  /** Original bytes returned from the front of the stream. */
  head_bytes: number;
  head_lines: number | null;
  /** Original bytes returned from the end of the stream; 0 when not truncated. */
  tail_bytes: number;
  tail_lines: number | null;
  omitted_lines: number | null;
  /** `total_bytes - head_bytes - tail_bytes`, exact. */
  omitted_bytes: number;
  /** `head_bytes + tail_bytes`; marker text is not counted (§5.8). */
  returned_bytes: number;
  /** True when the minimum-line extension stopped at `HARD_CEILING`. */
  ceiling_hit: boolean;
  /**
   * Handle for retrieving the whole stream through `fetch_output`, or `null`.
   *
   * Always `null` as it leaves this module: minting a reference means putting
   * bytes in the output store, and that happens in `commandResultBody()`
   * (`src/tools/gated.ts`) — the one place that knows both `truncated` and the
   * shape of the response being built, and the one place a timed-out command
   * never reaches (ADR-010, AC-O1b).
   */
  output_ref: string | null;
}

/** What the builders produce; {@link ExcerptResult} adds the retained bytes. */
interface BuiltExcerpt {
  text: string;
  meta: ExcerptMeta;
}

export interface ExcerptResult extends BuiltExcerpt {
  /**
   * The whole stream, byte for byte, when `retain` was asked for and the stream
   * stayed within its cap. `null` otherwise — including when retention was not
   * requested at all, which is the default (ADR-010).
   */
  retained: Buffer | null;
}

export interface ExcerptOptions {
  /** Per-stream ceiling: the host's `maxOutputBytes`. */
  cap: number;
  minSideLines?: number;
  maxLineBytes?: number;
  /**
   * Opt in to keeping the whole stream alongside the excerpt (ADR-010).
   *
   * Off by default, so the bound this module promises — about `cap + 320 KiB`
   * per direction — is unchanged for every caller that does not ask. A caller
   * that does ask raises its own bound to `cap + 320 KiB + retain.cap`, still
   * independent of stream length. A stream that exceeds `retain.cap` is given
   * up on the moment it does, and `retained` comes back `null`: partially
   * retained bytes would be indistinguishable from the whole stream at the
   * other end (AC-O4a).
   *
   * The decision lives here rather than in a second buffer bolted onto the same
   * `data` handler because this is the only place that knows whether the stream
   * was UTF-8 and whether it was truncated — and because one buffer cannot
   * disagree with itself about how many bytes it saw.
   */
  retain?: { cap: number };
}

export interface ExcerptAccumulator {
  push(chunk: Buffer): void;
  /** Idempotent: repeated calls return the same result. */
  finish(): ExcerptResult;
  /** Bytes seen so far, discarded ones included. */
  readonly totalBytes: number;
}

/** Budget arithmetic, exported so tests can assert it without re-deriving it. */
export interface ExcerptBudgets {
  cap: number;
  hardCeiling: number;
  sideLimit: number;
  headByteTarget: number;
  tailByteTarget: number;
  headCapacity: number;
  tailWindow: number;
}

export function computeBudgets(options: ExcerptOptions): ExcerptBudgets {
  const cap = Math.max(0, Math.floor(options.cap));
  const minSideLines = options.minSideLines ?? MIN_SIDE_LINES;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;

  const slack = 2 * minSideLines * maxLineBytes;
  const hardCeiling = cap + slack + MARKER_LINE_MAX_BYTES;
  const sideLimit = Math.floor(hardCeiling / 2);

  const headByteTarget = Math.floor(cap * HEAD_RATIO);
  const tailByteTarget = cap - headByteTarget;
  const minSideBudget = minSideLines * maxLineBytes;

  const tailWindow = Math.min(Math.max(tailByteTarget, minSideBudget), sideLimit);
  // `cap - tailWindow` keeps head + tail at or above `cap`, which is what lets
  // an at-or-under-cap stream come back in full.
  const headCapacity = Math.min(
    Math.max(headByteTarget, minSideBudget, cap - tailWindow),
    sideLimit
  );

  return {
    cap,
    hardCeiling,
    sideLimit,
    headByteTarget,
    tailByteTarget,
    headCapacity,
    tailWindow,
  };
}

/**
 * Incremental UTF-8 validation (WHATWG encoding algorithm), used to decide
 * `encoding` over the whole stream including the bytes that were dropped.
 * Allocation-free so that a multi-megabyte stream costs one pass.
 */
class Utf8Validator {
  private valid = true;
  private needed = 0;
  private lower = 0x80;
  private upper = 0xbf;

  update(chunk: Buffer): void {
    if (!this.valid) return;
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i] as number;
      if (this.needed === 0) {
        if (byte <= 0x7f) continue;
        if (byte >= 0xc2 && byte <= 0xdf) {
          this.needed = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) this.lower = 0xa0;
          if (byte === 0xed) this.upper = 0x9f;
          this.needed = 2;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) this.lower = 0x90;
          if (byte === 0xf4) this.upper = 0x8f;
          this.needed = 3;
        } else {
          this.valid = false;
          return;
        }
        continue;
      }
      if (byte < this.lower || byte > this.upper) {
        this.valid = false;
        return;
      }
      this.lower = 0x80;
      this.upper = 0xbf;
      this.needed -= 1;
    }
  }

  /** True when every byte formed a complete, well-formed sequence. */
  done(): boolean {
    return this.valid && this.needed === 0;
  }
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  let index = buf.indexOf(LF);
  while (index !== -1) {
    count += 1;
    index = buf.indexOf(LF, index + 1);
  }
  return count;
}

/** Index just past the last LF, or 0 when the buffer holds no LF. */
function endOfLastLine(buf: Buffer): number {
  const index = buf.lastIndexOf(LF);
  return index === -1 ? 0 : index + 1;
}

/**
 * Largest `n <= limit` that does not split a UTF-8 sequence.
 *
 * Decided by looking backwards from the boundary, so it is correct whether or
 * not more bytes follow `limit` in `buf`.
 */
function utf8SafeEnd(buf: Buffer, limit: number): number {
  const end = Math.min(limit, buf.length);
  if (end === 0) return 0;

  let start = end - 1;
  const floor = Math.max(0, end - 4);
  while (start > floor && ((buf[start] as number) & 0xc0) === 0x80) start -= 1;

  const lead = buf[start] as number;
  if ((lead & 0xc0) === 0x80) return end; // no lead byte in range: leave it
  let needed = 1;
  if (lead >= 0xf0) needed = 4;
  else if (lead >= 0xe0) needed = 3;
  else if (lead >= 0xc0) needed = 2;

  return start + needed > end ? start : end;
}

/** Skip leading UTF-8 continuation bytes left behind by a raw byte slice. */
function utf8SafeStart(buf: Buffer): number {
  let start = 0;
  while (start < buf.length && start < 3) {
    const byte = buf[start] as number;
    if ((byte & 0xc0) !== 0x80) break;
    start += 1;
  }
  return start;
}

interface CutResult {
  text: string;
  /** Original bytes retained; inserted notices are not counted. */
  keptBytes: number;
}

/**
 * Cut every line longer than `maxLineBytes` and annotate it (§5.8 step 7).
 * CRLF terminators are preserved so no dangling `\r` is produced.
 */
function cutLongLines(buf: Buffer, maxLineBytes: number): CutResult {
  let text = '';
  let keptBytes = 0;
  let offset = 0;

  while (offset < buf.length) {
    const lfIndex = buf.indexOf(LF, offset);
    const lineEnd = lfIndex === -1 ? buf.length : lfIndex + 1;
    let contentEnd = lfIndex === -1 ? buf.length : lfIndex;
    let terminator = lfIndex === -1 ? '' : '\n';
    if (lfIndex !== -1 && contentEnd > offset && buf[contentEnd - 1] === CR) {
      contentEnd -= 1;
      terminator = '\r\n';
    }

    const content = buf.subarray(offset, contentEnd);
    if (content.length > maxLineBytes) {
      const end = utf8SafeEnd(content, maxLineBytes);
      text += content.subarray(0, end).toString('utf8');
      text += lineCutNotice(content.length - end);
      keptBytes += end;
    } else {
      text += content.toString('utf8');
      keptBytes += content.length;
    }
    text += terminator;
    keptBytes += terminator.length;
    offset = lineEnd;
  }

  return { text, keptBytes };
}

/** Lines fully contained in a head slice: one per LF. */
function countHeadLines(buf: Buffer): number {
  return countNewlines(buf);
}

/**
 * Lines in a tail slice. The tail ends where the stream ends, so a final line
 * without a trailing LF still counts.
 */
function countTailLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const newlines = countNewlines(buf);
  return buf[buf.length - 1] === LF ? newlines : newlines + 1;
}

/**
 * Create an accumulator for one stream.
 *
 * `cap` is the host's `maxOutputBytes`; `minSideLines` and `maxLineBytes` exist
 * so tests can shrink the algorithm without rewriting it.
 */
export function createExcerptAccumulator(options: ExcerptOptions): ExcerptAccumulator {
  const budgets = computeBudgets(options);
  const minSideLines = options.minSideLines ?? MIN_SIDE_LINES;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const { cap, hardCeiling, headByteTarget, tailByteTarget, headCapacity, tailWindow } = budgets;

  const headChunks: Buffer[] = [];
  let headBytes = 0;

  const tailChunks: Buffer[] = [];
  let tailBytes = 0;

  const retainCap = options.retain?.cap;
  let retainChunks: Buffer[] | null = retainCap === undefined ? null : [];
  let retainBytes = 0;

  let totalBytes = 0;
  let newlines = 0;
  let lastByte = -1;
  const utf8 = new Utf8Validator();

  let finished: ExcerptResult | null = null;

  function push(chunk: Buffer): void {
    if (finished !== null) throw new Error('excerpt accumulator already finished');
    if (chunk.length === 0) return;

    totalBytes += chunk.length;
    newlines += countNewlines(chunk);
    lastByte = chunk[chunk.length - 1] as number;
    utf8.update(chunk);

    if (retainChunks !== null && retainCap !== undefined) {
      if (retainBytes + chunk.length > retainCap) {
        // Give up as soon as the cap is passed and let the buffers go: holding
        // a prefix would cost the same memory for output nobody can use.
        retainChunks = null;
        retainBytes = 0;
      } else {
        retainChunks.push(chunk);
        retainBytes += chunk.length;
      }
    }

    if (headBytes < headCapacity) {
      const take = Math.min(chunk.length, headCapacity - headBytes);
      headChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      headBytes += take;
    }

    // Sliding window: keep the newest `tailWindow` bytes, dropping whole
    // chunks from the front while the remainder still covers the window.
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailChunks.length > 1) {
      const first = tailChunks[0] as Buffer;
      if (tailBytes - first.length < tailWindow) break;
      tailChunks.shift();
      tailBytes -= first.length;
    }
    if (tailChunks.length === 1 && tailBytes > tailWindow) {
      const only = tailChunks[0] as Buffer;
      const trimmed = only.subarray(only.length - tailWindow);
      tailChunks[0] = trimmed;
      tailBytes = trimmed.length;
    }
  }

  function buildFull(head: Buffer, tail: Buffer, isUtf8: boolean): BuiltExcerpt | null {
    const overlap = headBytes + tail.length - totalBytes;
    if (overlap < 0) return null; // Cannot rebuild the stream: excerpt instead.
    const full =
      overlap >= tail.length
        ? head.subarray(0, totalBytes)
        : Buffer.concat([head, tail.subarray(overlap)]);

    const totalLines = totalBytes === 0 ? 0 : newlines + (lastByte === LF ? 0 : 1);
    return {
      text: isUtf8 ? full.toString('utf8') : full.toString('base64'),
      meta: {
        truncated: false,
        encoding: isUtf8 ? 'utf8' : 'base64',
        total_bytes: totalBytes,
        total_lines: isUtf8 ? totalLines : null,
        head_bytes: totalBytes,
        head_lines: isUtf8 ? totalLines : null,
        tail_bytes: 0,
        tail_lines: isUtf8 ? 0 : null,
        omitted_lines: isUtf8 ? 0 : null,
        omitted_bytes: 0,
        returned_bytes: totalBytes,
        ceiling_hit: false,
        output_ref: null,
      },
    };
  }

  function buildBinaryExcerpt(head: Buffer, tail: Buffer): BuiltExcerpt {
    const headKeep = head.subarray(0, Math.min(headBytes, headByteTarget));
    const tailKeep = tail.subarray(Math.max(0, tail.length - tailByteTarget));
    const kept = headKeep.length + tailKeep.length;
    return {
      text: Buffer.concat([headKeep, tailKeep]).toString('base64'),
      meta: {
        truncated: true,
        encoding: 'base64',
        total_bytes: totalBytes,
        total_lines: null,
        head_bytes: headKeep.length,
        head_lines: null,
        tail_bytes: tailKeep.length,
        tail_lines: null,
        omitted_lines: null,
        omitted_bytes: totalBytes - kept,
        returned_bytes: kept,
        ceiling_hit: false,
        output_ref: null,
      },
    };
  }

  function buildTextExcerpt(head: Buffer, tail: Buffer): BuiltExcerpt {
    const tailOffset = totalBytes - tail.length; // absolute offset of tail[0]

    // Head side: byte budget first, then back off to the last complete line.
    const headSliceEnd = Math.min(headBytes, headByteTarget);
    const headSlice = head.subarray(0, headSliceEnd);
    const trimmedEnd = endOfLastLine(headSlice);
    // Boundary trimming is skipped when it would empty the side: a stream that
    // is one very long line must still show its beginning (§5.8 step 5). The
    // raw slice is still pulled back to a code point boundary so the text does
    // not end in a replacement character.
    let headEnd = trimmedEnd > 0 ? trimmedEnd : utf8SafeEnd(headSlice, headSliceEnd);
    const headOnLineBoundary = trimmedEnd > 0;

    // Tail side: last `tailByteTarget` bytes, then drop the partial line.
    let tailStart = Math.max(0, tail.length - tailByteTarget);
    const startsAtLineBoundary =
      tailOffset + tailStart === 0 || (tailStart > 0 && tail[tailStart - 1] === LF);
    if (!startsAtLineBoundary) {
      const firstLf = tail.indexOf(LF, tailStart);
      if (firstLf !== -1 && firstLf + 1 < tail.length) {
        tailStart = firstLf + 1;
      } else {
        // Trimming would empty the side: keep the raw slice, realigned so it
        // does not start inside a UTF-8 sequence.
        tailStart += utf8SafeStart(tail.subarray(tailStart));
      }
    }

    let ceilingHit = false;
    const keptBytes = (): number => headEnd + (tail.length - tailStart);

    // Minimum-line guarantee; the hard ceiling wins (§5.8 step 6, AC12.4).
    if (headOnLineBoundary) {
      let headLines = countHeadLines(head.subarray(0, headEnd));
      while (headLines < minSideLines && headEnd < headBytes) {
        const nextLf = head.indexOf(LF, headEnd);
        // No further LF means the head buffer ran out mid-line: extending
        // would append a fragment, which is not a line we can count.
        if (nextLf === -1) break;
        const nextEnd = nextLf + 1;
        if (tailOffset + tailStart <= nextEnd) break; // would meet the tail
        if (keptBytes() + (nextEnd - headEnd) > hardCeiling) {
          ceilingHit = true;
          break;
        }
        headEnd = nextEnd;
        headLines += 1;
      }
    }

    if (tailStart > 0) {
      let tailLines = countTailLines(tail.subarray(tailStart));
      while (tailLines < minSideLines && tailStart > 0) {
        // The previous line starts just after the LF before `tailStart - 1`.
        // `tailStart === 1` must ask about no earlier byte at all: passing the
        // resulting -1 to lastIndexOf would be read as an offset from the END
        // of the buffer and would return the LAST newline, moving the window
        // forwards and silently dropping tail content.
        const previousLf = tailStart >= 2 ? tail.lastIndexOf(LF, tailStart - 2) : -1;
        // No earlier LF means the window starts mid-line, unless the window
        // reaches the start of the stream, where the first line really begins.
        if (previousLf === -1 && tailOffset > 0) break;
        const nextStart = previousLf === -1 ? 0 : previousLf + 1;
        if (nextStart + tailOffset < headEnd) break; // would meet the head
        if (keptBytes() + (tailStart - nextStart) > hardCeiling) {
          ceilingHit = true;
          break;
        }
        tailStart = nextStart;
        if (previousLf === -1) break;
        tailLines += 1;
      }
    }

    const headBuf = head.subarray(0, headEnd);
    const tailBuf = tail.subarray(tailStart);

    const headCut = cutLongLines(headBuf, maxLineBytes);
    const tailCut = cutLongLines(tailBuf, maxLineBytes);

    const headLines = countHeadLines(headBuf);
    const tailLines = countTailLines(tailBuf);
    const totalLines = totalBytes === 0 ? 0 : newlines + (lastByte === LF ? 0 : 1);

    const omittedBytes = totalBytes - headCut.keptBytes - tailCut.keptBytes;
    const omittedLines = totalLines - headLines - tailLines;

    let headText = headCut.text;
    if (headText !== '' && !headText.endsWith('\n')) headText += '\n';
    const text = `${headText}${omissionMarkerLine(omittedLines, omittedBytes)}\n${tailCut.text}`;

    return {
      text,
      meta: {
        truncated: true,
        encoding: 'utf8',
        total_bytes: totalBytes,
        total_lines: totalLines,
        head_bytes: headCut.keptBytes,
        head_lines: headLines,
        tail_bytes: tailCut.keptBytes,
        tail_lines: tailLines,
        omitted_lines: omittedLines,
        omitted_bytes: omittedBytes,
        returned_bytes: headCut.keptBytes + tailCut.keptBytes,
        ceiling_hit: ceilingHit,
        output_ref: null,
      },
    };
  }

  function finish(): ExcerptResult {
    if (finished !== null) return finished;

    const head = Buffer.concat(headChunks);
    const tailAll = Buffer.concat(tailChunks);
    const tail =
      tailAll.length > tailWindow ? tailAll.subarray(tailAll.length - tailWindow) : tailAll;
    const isUtf8 = utf8.done();
    const retained = retainChunks === null ? null : Buffer.concat(retainChunks);

    let built: BuiltExcerpt | null = null;
    if (totalBytes <= cap) built = buildFull(head, tail, isUtf8);
    built ??= isUtf8 ? buildTextExcerpt(head, tail) : buildBinaryExcerpt(head, tail);

    finished = { ...built, retained };
    return finished;
  }

  return {
    push,
    finish,
    get totalBytes(): number {
      return totalBytes;
    },
  };
}

/** Convenience wrapper for a stream already held in memory (tests, `doctor`). */
export function excerpt(data: Buffer, options: ExcerptOptions): ExcerptResult {
  const accumulator = createExcerptAccumulator(options);
  accumulator.push(data);
  return accumulator.finish();
}
