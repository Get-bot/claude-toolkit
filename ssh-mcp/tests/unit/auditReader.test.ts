/**
 * Reverse chunk reader over the audit files (plan row C3, AC-H2, AC-H2c).
 *
 * The chunk size is a parameter precisely so these tests can drive the boundary
 * handling with a handful of bytes: a reader that only ever sees whole files in
 * one chunk never exercises the carry-over that the production 64 KiB path
 * depends on.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditFileSize,
  readLineAt,
  readNewestFirst,
  walkAuditLines,
  MAX_AUDIT_LINE_BYTES,
} from '../../src/audit/reader.js';
import { auditRotatedFilePath, ensureHome } from '../../src/config/paths.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-audit-reader-');
  ensureHome();
});

afterEach(() => {
  assertNoWritesOutside(home);
  home.cleanup();
});

function write(fileIndex: number, content: string): number {
  const target = auditRotatedFilePath(fileIndex);
  fs.writeFileSync(target, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

function textsFrom(fileIndex: number, end: number, chunkBytes: number): string[] {
  return [...readNewestFirst(fileIndex, end, chunkBytes)].map((line) => line.text);
}

describe('readNewestFirst', () => {
  it('returns nothing for a file that does not exist', () => {
    expect([...readNewestFirst(0, 100)]).toEqual([]);
  });

  it('returns nothing for an empty file', () => {
    const size = write(0, '');
    expect([...readNewestFirst(0, size)]).toEqual([]);
  });

  it('reads newest first whatever the chunk size', () => {
    const size = write(0, 'one\ntwo\nthree\nfour\n');
    for (const chunkBytes of [1, 2, 3, 5, 7, 19, 64 * 1024]) {
      expect(textsFrom(0, size, chunkBytes), `chunk=${String(chunkBytes)}`).toEqual([
        'four',
        'three',
        'two',
        'one',
      ]);
    }
  });

  it('reports the byte offset each line starts at', () => {
    const size = write(0, 'aa\nbbbb\nc\n');
    expect([...readNewestFirst(0, size, 3)]).toEqual([
      { offset: 8, text: 'c' },
      { offset: 3, text: 'bbbb' },
      { offset: 0, text: 'aa' },
    ]);
  });

  it('keeps a final line that has no trailing newline', () => {
    const size = write(0, 'first\nlast-no-newline');
    expect(textsFrom(0, size, 4)).toEqual(['last-no-newline', 'first']);
  });

  it('skips blank lines rather than reporting them as records', () => {
    const size = write(0, 'a\n\n\nb\n');
    expect(textsFrom(0, size, 2)).toEqual(['b', 'a']);
  });

  it('stops at the exclusive end bound', () => {
    write(0, 'one\ntwo\nthree\n');
    // Byte 8 is the start of "three", so the bound just past "two" is 8.
    expect(textsFrom(0, 8, 3)).toEqual(['two', 'one']);
  });

  it('handles multi-byte characters split across chunks', () => {
    const size = write(0, '한글\n두번째 줄\n');
    expect(textsFrom(0, size, 3)).toEqual(['두번째 줄', '한글']);
  });

  it('stops instead of growing the carry past one line (AC-H2c)', () => {
    // No newline anywhere, longer than the per-line ceiling: the reader must
    // give up rather than accumulate the file in memory.
    const size = write(0, 'x'.repeat(MAX_AUDIT_LINE_BYTES + 4096));
    expect([...readNewestFirst(0, size, 64 * 1024)]).toEqual([]);
  });
});

describe('readLineAt', () => {
  it('reads the line at an offset and reports where it ends', () => {
    write(0, 'alpha\nbeta\ngamma\n');
    expect(readLineAt(0, 6)).toEqual({ text: 'beta', end: 11 });
  });

  it('reads a final line with no newline', () => {
    write(0, 'alpha\nbeta');
    expect(readLineAt(0, 6)).toEqual({ text: 'beta', end: 10 });
  });

  it('returns null past the end of the file', () => {
    const size = write(0, 'alpha\n');
    expect(readLineAt(0, size)).toBeNull();
    expect(readLineAt(0, size + 10)).toBeNull();
  });

  it('returns null for a missing file and for a negative offset', () => {
    expect(readLineAt(2, 0)).toBeNull();
    write(0, 'alpha\n');
    expect(readLineAt(0, -1)).toBeNull();
  });

  it('returns a mid-line slice when the offset is not a line start', () => {
    write(0, 'alpha\nbeta\n');
    // This is what makes the cursor's line hash a real check: a stale offset
    // still reads *something*, and only the hash says it is the wrong thing.
    expect(readLineAt(0, 2)).toEqual({ text: 'pha', end: 6 });
  });
});

describe('auditFileSize', () => {
  it('reports null for a missing file and the byte size otherwise', () => {
    expect(auditFileSize(1)).toBeNull();
    const size = write(1, 'line\n');
    expect(auditFileSize(1)).toBe(size);
  });
});

describe('walkAuditLines', () => {
  it('continues from the live file into the rotations (AC-H2)', () => {
    const liveSize = write(0, 'live-1\nlive-2\n');
    write(1, 'rot1-1\nrot1-2\n');
    write(2, 'rot2-1\n');

    const walked = [...walkAuditLines({ fileIndex: 0, end: liveSize }, 3, 5)];
    expect(walked.map((line) => line.text)).toEqual([
      'live-2',
      'live-1',
      'rot1-2',
      'rot1-1',
      'rot2-1',
    ]);
    expect(walked.map((line) => line.fileIndex)).toEqual([0, 0, 1, 1, 2]);
  });

  it('skips a missing rotation instead of ending the walk', () => {
    const liveSize = write(0, 'live\n');
    write(2, 'rot2\n');
    const walked = [...walkAuditLines({ fileIndex: 0, end: liveSize }, 3, 5)];
    expect(walked.map((line) => line.text)).toEqual(['live', 'rot2']);
  });

  it('honours maxFileIndex', () => {
    const liveSize = write(0, 'live\n');
    write(1, 'rot1\n');
    const walked = [...walkAuditLines({ fileIndex: 0, end: liveSize }, 0, 5)];
    expect(walked.map((line) => line.text)).toEqual(['live']);
  });

  it('starts in a rotation when told to', () => {
    write(0, 'live\n');
    const rotSize = write(1, 'rot1-1\nrot1-2\n');
    write(2, 'rot2\n');
    const walked = [...walkAuditLines({ fileIndex: 1, end: rotSize }, 3, 5)];
    expect(walked.map((line) => line.text)).toEqual(['rot1-2', 'rot1-1', 'rot2']);
  });
});
