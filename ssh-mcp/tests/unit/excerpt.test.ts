/**
 * §5.8 excerpting (AC12.1-AC12.9).
 *
 * The line counts here come from the generator, never from the module under
 * test: asserting `head + omitted + tail === total` would be a tautology
 * because `omitted_lines` is defined by that subtraction (AC12.3, N10).
 */
import { describe, expect, it } from 'vitest';

import {
  LINE_CUT_PATTERN,
  MARKER_LINE_MAX_BYTES,
  MAX_LINE_BYTES,
  OMISSION_MARKER_PATTERN,
  computeBudgets,
  createExcerptAccumulator,
  excerpt,
  groupDigits,
  omissionMarkerLine,
} from '../../src/ssh/excerpt.js';
import type { ExcerptResult } from '../../src/ssh/excerpt.js';

const CAP = 1048576;

/** `count` lines of exactly `lineBytes` bytes each, newline included. */
function generateLines(count: number, lineBytes: number): { data: Buffer; lines: number } {
  const body = 'x'.repeat(lineBytes - 1);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(`${body}\n`);
  return { data: Buffer.from(parts.join(''), 'utf8'), lines: count };
}

/** Feed a buffer in fixed-size chunks to exercise the streaming path. */
function runChunked(data: Buffer, chunkSize: number, cap: number) {
  const accumulator = createExcerptAccumulator({ cap });
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    accumulator.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  return accumulator.finish();
}

function markerLines(text: string): string[] {
  return text.split('\n').filter((line) => OMISSION_MARKER_PATTERN.test(line));
}

describe('groupDigits', () => {
  it('groups thousands the way the marker line needs', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1000)).toBe('1,000');
    expect(groupDigits(9876543)).toBe('9,876,543');
  });
});

describe('omission marker line', () => {
  it('round-trips through the documented pattern', () => {
    const line = omissionMarkerLine(12345, 9876543);
    const match = OMISSION_MARKER_PATTERN.exec(line);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('12,345');
    expect(match?.[2]).toBe('9,876,543');
  });

  it('stays inside the byte budget the ceiling assumes', () => {
    const line = omissionMarkerLine(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(Buffer.byteLength(line, 'utf8') + 2).toBeLessThanOrEqual(MARKER_LINE_MAX_BYTES);
  });
});

describe('under the cap', () => {
  it('returns an empty stream unchanged', () => {
    const result = excerpt(Buffer.alloc(0), { cap: CAP });
    expect(result.text).toBe('');
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.total_bytes).toBe(0);
    expect(result.meta.total_lines).toBe(0);
    expect(result.meta.omitted_lines).toBe(0);
  });

  it.each([
    ['cap - 1', CAP - 1],
    ['cap', CAP],
  ])('returns %s bytes byte for byte', (_label, size) => {
    const data = Buffer.alloc(size, 0x61);
    const result = runChunked(data, 65536, CAP);
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.total_bytes).toBe(size);
    expect(result.meta.returned_bytes).toBe(size);
    expect(result.meta.omitted_lines).toBe(0);
    expect(result.meta.omitted_bytes).toBe(0);
    expect(markerLines(result.text)).toHaveLength(0);
    expect(Buffer.from(result.text, 'utf8').equals(data)).toBe(true);
  });

  it('truncates at cap + 1', () => {
    const data = Buffer.alloc(CAP + 1, 0x61);
    const result = runChunked(data, 65536, CAP);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.total_bytes).toBe(CAP + 1);
  });

  it('counts a final line without a trailing newline', () => {
    const result = excerpt(Buffer.from('a\nb\nc', 'utf8'), { cap: CAP });
    expect(result.meta.total_lines).toBe(3);
    expect(result.meta.truncated).toBe(false);
  });

  it('counts a trailing newline as ending the last line', () => {
    const result = excerpt(Buffer.from('a\nb\nc\n', 'utf8'), { cap: CAP });
    expect(result.meta.total_lines).toBe(3);
  });
});

describe('the canonical 10 000 line excerpt (§5.8 worked example)', () => {
  const generated = generateLines(10000, 200);
  const result = runChunked(generated.data, 64 * 1024, CAP);

  it('knows the line count from the generator, not from subtraction', () => {
    expect(generated.lines).toBe(10000);
    expect(result.meta.total_lines).toBe(10000);
    expect(result.meta.total_bytes).toBe(2000000);
  });

  it('reproduces the documented head and tail sizes', () => {
    expect(result.meta.head_bytes).toBe(419400);
    expect(result.meta.head_lines).toBe(2097);
    expect(result.meta.tail_bytes).toBe(629000);
    expect(result.meta.tail_lines).toBe(3145);
    expect(result.meta.returned_bytes).toBe(1048400);
  });

  it('reports the documented omission counts', () => {
    expect(result.meta.omitted_lines).toBe(4758);
    expect(result.meta.omitted_bytes).toBe(951600);
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.encoding).toBe('utf8');
    expect(result.meta.output_ref).toBeNull();
  });

  it('keeps the head at 40 percent of the cap within one line', () => {
    expect(Math.abs(result.meta.head_bytes - Math.floor(CAP * 0.4))).toBeLessThanOrEqual(200);
  });

  it('starts with the first original line and ends with the last (AC12.1)', () => {
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('x'.repeat(199));
    const nonEmpty = lines.filter((line) => line !== '');
    expect(nonEmpty[nonEmpty.length - 1]).toBe('x'.repeat(199));
  });

  it('contains exactly one marker line and it agrees with the meta (AC12.2)', () => {
    const found = markerLines(result.text);
    expect(found).toHaveLength(1);
    const match = OMISSION_MARKER_PATTERN.exec(found[0] as string);
    expect(match?.[1]).toBe(groupDigits(result.meta.omitted_lines as number));
    expect(match?.[2]).toBe(groupDigits(result.meta.omitted_bytes));
  });

  it('is independent of chunk size', () => {
    const other = runChunked(generated.data, 7919, CAP);
    expect(other.meta).toEqual(result.meta);
    expect(other.text).toBe(result.text);
  });
});

describe('minimum lines per side', () => {
  it('keeps at least 20 lines on each side when the cap is tiny', () => {
    const generated = generateLines(500, 200);
    const result = excerpt(generated.data, { cap: 1024 });
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.head_lines).toBeGreaterThanOrEqual(20);
    expect(result.meta.tail_lines).toBeGreaterThanOrEqual(20);
    expect(result.meta.total_lines).toBe(500);
  });

  it('accepts fewer than 20 lines when the lines are huge (AC12.4)', () => {
    const generated = generateLines(60, 20000);
    const budgets = computeBudgets({ cap: 1024 });
    const result = excerpt(generated.data, { cap: 1024 });
    expect(result.meta.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(budgets.hardCeiling);
    expect(result.meta.total_lines).toBe(60);
  });
});

describe('tail window starting one byte in (CR-3)', () => {
  /**
   * Regression guard for a negative `lastIndexOf` offset.
   *
   * When the tail window happens to start at byte 1, asking for the newline
   * "before byte -1" used to be read by Node as an offset from the END of the
   * buffer, so it returned the LAST newline, moved the window forwards and
   * dropped tail content. The window starts at byte 1 only for a narrow band
   * of caps, where the 20-line floor of 160 KiB just exceeds the tail byte
   * budget, so the cap here is chosen to land exactly on it.
   */
  const CR3_CAP = 273065;

  /**
   * Four tail lines, deliberately. The faulty walk oscillates through the
   * newline positions, and with two lines it happens to land back where it
   * started, so a two-line case passes either way. With four it stops on an
   * empty window, which is what makes this a real regression guard.
   */
  function cr3Input(): Buffer {
    const head = `${'a'.repeat(236160)}\n`; // one long line ending at byte 236160
    const line = `${'x'.repeat(40959)}\n`; // 40 960 bytes
    const last = `${'z'.repeat(40958)}\n`; // 40 959 bytes
    return Buffer.from(head + line.repeat(3) + last, 'utf8');
  }

  it('keeps every tail line instead of walking the window forwards', () => {
    const data = cr3Input();
    expect(data.length).toBe(400000);

    const result = excerpt(data, { cap: CR3_CAP });

    expect(result.meta.truncated).toBe(true);
    expect(result.meta.total_lines).toBe(5);
    // The window holds four complete lines. The bug walked past all of them
    // and returned an empty tail, so this count is the assertion that matters.
    expect(result.meta.tail_lines).toBe(4);
    expect(result.meta.tail_bytes).toBeGreaterThan(0);
    expect(result.text).toContain('x'.repeat(200));
    expect(result.text).toContain('z'.repeat(200));
    // Every tail line is over 8 KiB, so each is cut to the per-line ceiling
    // and annotated; the four newline terminators are kept on top of that.
    expect(result.meta.tail_bytes).toBe(4 * MAX_LINE_BYTES + 4);
  });

  it('still reports counts that add up', () => {
    const result = excerpt(cr3Input(), { cap: CR3_CAP });
    expect(result.meta.omitted_bytes).toBe(
      result.meta.total_bytes - result.meta.head_bytes - result.meta.tail_bytes
    );
    expect(result.meta.omitted_lines).toBe(
      (result.meta.total_lines as number) -
        (result.meta.head_lines as number) -
        (result.meta.tail_lines as number)
    );
  });
});

describe('long lines', () => {
  it('cuts a line over 8 KiB and annotates it (AC12.8)', () => {
    // The long line has to land inside the head window to be cut rather than
    // omitted, so it comes first and the cap leaves room for it.
    const long = `${'y'.repeat(19999)}\n`;
    const padding = generateLines(500, 200).data.toString('utf8');
    const data = Buffer.from(long + padding, 'utf8');
    const result = excerpt(data, { cap: 65536 });
    expect(result.meta.truncated).toBe(true);
    expect(LINE_CUT_PATTERN.test(result.text)).toBe(true);
    for (const line of result.text.split('\n')) {
      if (OMISSION_MARKER_PATTERN.test(line)) continue;
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES + 64);
    }
  });

  it('keeps a raw slice of a 2 MiB single line and stays under the ceiling', () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 0x7a);
    const budgets = computeBudgets({ cap: CAP });
    const result = excerpt(data, { cap: CAP });
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.total_lines).toBe(1);
    expect(result.meta.head_bytes).toBe(MAX_LINE_BYTES);
    expect(result.meta.tail_bytes).toBe(MAX_LINE_BYTES);
    expect(result.meta.omitted_bytes).toBe(2 * 1024 * 1024 - 2 * MAX_LINE_BYTES);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(budgets.hardCeiling);
    expect(result.text.startsWith('z'.repeat(100))).toBe(true);
  });

  it('never splits a multi-byte character when cutting', () => {
    // Each character is 3 bytes, so an 8192 byte cut lands mid-character.
    const line = `${'가'.repeat(9000)}\n`;
    const data = Buffer.from(line.repeat(30), 'utf8');
    const result = excerpt(data, { cap: 1024 });
    expect(result.text.includes('�')).toBe(false);
  });
});

describe('CRLF input', () => {
  it('leaves no dangling carriage return around the marker line', () => {
    const line = `${'c'.repeat(198)}\r\n`;
    const data = Buffer.from(line.repeat(10000), 'utf8');
    const result = excerpt(data, { cap: CAP });
    expect(result.meta.truncated).toBe(true);
    const found = markerLines(result.text.replace(/\r/g, ''));
    expect(found).toHaveLength(1);
    expect(result.text).not.toContain('\r[ssh-mcp]');
    expect(result.text).not.toContain('\n\r\n[ssh-mcp]');
    // The omission line sits between two complete CRLF lines.
    const index = result.text.indexOf('[ssh-mcp]');
    expect(result.text.slice(index - 2, index)).toBe('\r\n');
  });
});

describe('non-UTF-8 streams', () => {
  it('returns base64 with null line counts when truncated (AC12.9)', () => {
    const data = Buffer.alloc(CAP + 5000);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 256;
    const result = excerpt(data, { cap: CAP });
    expect(result.meta.encoding).toBe('base64');
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.total_lines).toBeNull();
    expect(result.meta.head_lines).toBeNull();
    expect(result.meta.tail_lines).toBeNull();
    expect(result.meta.omitted_lines).toBeNull();
    expect(result.meta.omitted_bytes).toBe(
      result.meta.total_bytes - result.meta.head_bytes - result.meta.tail_bytes
    );
    const decoded = Buffer.from(result.text, 'base64');
    expect(decoded.length).toBe(result.meta.returned_bytes);
    expect(decoded.subarray(0, 16).equals(data.subarray(0, 16))).toBe(true);
  });

  it('returns base64 for a short binary stream without truncating', () => {
    const data = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]);
    const result = excerpt(data, { cap: CAP });
    expect(result.meta.encoding).toBe('base64');
    expect(result.meta.truncated).toBe(false);
    expect(Buffer.from(result.text, 'base64').equals(data)).toBe(true);
  });

  it('treats a truncated multi-byte sequence as binary', () => {
    const result = excerpt(Buffer.from([0xed, 0x95]), { cap: CAP });
    expect(result.meta.encoding).toBe('base64');
  });

  it('keeps valid multi-byte text as utf8 across chunk boundaries', () => {
    const text = Buffer.from('한국어 테스트\n', 'utf8');
    const accumulator = createExcerptAccumulator({ cap: CAP });
    accumulator.push(text.subarray(0, 2));
    accumulator.push(text.subarray(2));
    const result = accumulator.finish();
    expect(result.meta.encoding).toBe('utf8');
    expect(result.text).toBe('한국어 테스트\n');
  });
});

describe('budgets', () => {
  it('sizes the buffers so an at-cap stream can still be rebuilt', () => {
    for (const cap of [1024, 65536, 1048576, 4194304]) {
      const budgets = computeBudgets({ cap });
      expect(budgets.headCapacity + budgets.tailWindow).toBeGreaterThanOrEqual(cap);
      expect(budgets.headCapacity).toBeLessThanOrEqual(budgets.sideLimit);
      expect(budgets.tailWindow).toBeLessThanOrEqual(budgets.sideLimit);
      expect(budgets.sideLimit * 2).toBeLessThanOrEqual(budgets.hardCeiling);
    }
  });

  it('refuses to accept more data after finishing', () => {
    const accumulator = createExcerptAccumulator({ cap: CAP });
    accumulator.push(Buffer.from('a\n'));
    accumulator.finish();
    expect(() => {
      accumulator.push(Buffer.from('b\n'));
    }).toThrow(/already finished/);
  });

  it('returns the same result on a repeated finish', () => {
    const accumulator = createExcerptAccumulator({ cap: CAP });
    accumulator.push(Buffer.from('a\nb\n'));
    expect(accumulator.finish()).toEqual(accumulator.finish());
  });
});

describe('stdout and stderr are independent', () => {
  it('excerpts only the stream that exceeded the cap (AC12.6)', () => {
    const big = generateLines(10000, 200).data;
    const small = Buffer.from('one line\n', 'utf8');
    const bigResult = excerpt(big, { cap: CAP });
    const smallResult = excerpt(small, { cap: CAP });
    expect(bigResult.meta.truncated).toBe(true);
    expect(smallResult.meta.truncated).toBe(false);
    expect(smallResult.meta.total_lines).toBe(1);
    expect(smallResult.meta.omitted_lines).toBe(0);
  });
});

/** The retained bytes, failing the test rather than the type check if absent. */
function retainedBytes(result: ExcerptResult): Buffer {
  if (result.retention.kind !== 'kept') {
    throw new Error(`expected retained bytes, got ${result.retention.kind}`);
  }
  return result.retention.bytes;
}

describe('opt-in retention (ADR-010, AC-O4a, AC-O7)', () => {
  it('retains nothing unless asked, which is what keeps the old callers honest', () => {
    const result = excerpt(Buffer.from('a\nb\n'), { cap: CAP });
    // `not_requested`, not `dropped`: a consumer that parses the stream must
    // be able to tell "nobody kept it" from "it was too big to keep".
    expect(result.retention).toEqual({ kind: 'not_requested' });
    expect(result.meta.output_ref).toBeNull();
  });

  it('returns the whole stream byte for byte when it fits the retain cap', () => {
    const { data } = generateLines(200, 100);
    const accumulator = createExcerptAccumulator({
      cap: 4096,
      retain: { cap: 64 * 1024 },
    });
    for (let offset = 0; offset < data.length; offset += 999) {
      accumulator.push(data.subarray(offset, Math.min(offset + 999, data.length)));
    }
    const result = accumulator.finish();

    // The excerpt lost the middle; the retained buffer did not.
    expect(result.meta.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThan(data.length);
    expect(result.retention.kind).toBe('kept');
    expect(retainedBytes(result).equals(data)).toBe(true);
  });

  it('gives up entirely rather than retaining a prefix (AC-O4a)', () => {
    const { data } = generateLines(200, 100);
    const accumulator = createExcerptAccumulator({ cap: 4096, retain: { cap: 1024 } });
    accumulator.push(data);
    const result = accumulator.finish();

    expect(result.meta.truncated).toBe(true);
    // Truncated and yet nothing to fetch: the caller reads this as a null
    // `output_ref`, which is exactly what AC-O4a describes. `dropped` and not
    // `not_requested` - retention was asked for, the stream was simply too big.
    expect(result.retention).toEqual({ kind: 'dropped' });
  });

  it('retains an untruncated stream too, because nothing knows in advance', () => {
    const data = Buffer.from('short output\n', 'utf8');
    const accumulator = createExcerptAccumulator({ cap: CAP, retain: { cap: 64 * 1024 } });
    accumulator.push(data);
    const result = accumulator.finish();
    expect(result.meta.truncated).toBe(false);
    expect(retainedBytes(result).equals(data)).toBe(true);
  });

  it('retains a non-UTF-8 stream unchanged (AC-O1a)', () => {
    const data = Buffer.alloc(9000);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 256;
    const accumulator = createExcerptAccumulator({ cap: 1024, retain: { cap: 64 * 1024 } });
    accumulator.push(data);
    const result = accumulator.finish();

    expect(result.meta.encoding).toBe('base64');
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.omitted_lines).toBeNull();
    expect(retainedBytes(result).equals(data)).toBe(true);
  });

  it('returns the same retained buffer on a repeated finish', () => {
    const accumulator = createExcerptAccumulator({ cap: CAP, retain: { cap: 1024 } });
    accumulator.push(Buffer.from('a\nb\n'));
    expect(accumulator.finish()).toEqual(accumulator.finish());
  });
});
