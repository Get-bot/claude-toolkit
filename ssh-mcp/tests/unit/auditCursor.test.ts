/**
 * `history` cursor encoding and rotation succession
 * (plan row C4, ADR-011, AC-H2a, AC-H2b).
 *
 * The succession rules are asymmetric — `>=` while the live file is still live,
 * `===` once it is frozen — and iteration 1 of the plan got them backwards,
 * rejecting every normal rotation. These tests pin both directions and the line
 * hash that backs them up.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  lineHash,
  resolveCursor,
  type HistoryCursor,
} from '../../src/audit/cursor.js';
import { auditRotatedFilePath, ensureHome } from '../../src/config/paths.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

const MAX_INDEX = 3;

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-audit-cursor-');
  ensureHome();
});

afterEach(() => {
  assertNoWritesOutside(home);
  home.cleanup();
});

function write(fileIndex: number, content: string): number {
  fs.writeFileSync(auditRotatedFilePath(fileIndex), content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

function append(fileIndex: number, content: string): void {
  fs.appendFileSync(auditRotatedFilePath(fileIndex), content, 'utf8');
}

/** Cursor pointing at `line`, as a page cut at that position would mint it. */
function cursorAt(fileIndex: number, offset: number, size: number, line: string): HistoryCursor {
  return { f: fileIndex, o: offset, s: size, h: lineHash(line) };
}

describe('encoding', () => {
  it('round-trips a cursor through base64url', () => {
    const cursor: HistoryCursor = { f: 2, o: 4096, s: 10_485_760, h: 'a1b2c3d4e5f60718' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('produces a URL-safe string', () => {
    const encoded = encodeCursor({ f: 0, o: 1, s: 2, h: '0'.repeat(16) });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects anything it did not produce', () => {
    expect(decodeCursor('not-base64url-json')).toBeNull();
    expect(decodeCursor(Buffer.from('[]', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('"text"', 'utf8').toString('base64url'))).toBeNull();
    // Each field is checked: a wrong type or a short hash is not a cursor.
    for (const body of [
      '{"f":-1,"o":0,"s":0,"h":"0000000000000000"}',
      '{"f":0,"o":1.5,"s":0,"h":"0000000000000000"}',
      '{"f":0,"o":0,"s":-1,"h":"0000000000000000"}',
      '{"f":0,"o":0,"s":0,"h":"short"}',
      '{"f":0,"o":0,"s":0}',
    ]) {
      expect(decodeCursor(Buffer.from(body, 'utf8').toString('base64url')), body).toBeNull();
    }
  });

  it('hashes the line to 8 bytes of sha256', () => {
    expect(lineHash('some audit line')).toMatch(/^[0-9a-f]{16}$/);
    expect(lineHash('a')).not.toBe(lineHash('b'));
  });
});

describe('succession while the live file is still live (AC-H2a)', () => {
  it('continues in place when only appends happened', () => {
    const size = write(0, 'one\ntwo\nthree\n');
    const cursor = cursorAt(0, 4, size, 'two');
    append(0, 'four\nfive\n');

    const resolved = resolveCursor(cursor, MAX_INDEX);
    expect(resolved).toEqual({ ok: true, fileIndex: 0, end: 8 });
  });

  it('continues in place when nothing changed at all', () => {
    const size = write(0, 'one\ntwo\n');
    expect(resolveCursor(cursorAt(0, 0, size, 'one'), MAX_INDEX)).toEqual({
      ok: true,
      fileIndex: 0,
      end: 4,
    });
  });
});

describe('succession across a rotation (AC-H2b)', () => {
  it('follows the live file into .1', () => {
    // The page was cut against a file that has since been rotated to `.1`; a
    // fresh, smaller live file took its place.
    const rotatedSize = write(1, 'one\ntwo\nthree\n');
    write(0, 'new\n');

    const cursor = cursorAt(0, 4, rotatedSize, 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: true, fileIndex: 1, end: 8 });
  });

  it('follows the rotation even though .1 has grown relative to the cut', () => {
    // `.1` is at least as large as the file was when the page was cut, which is
    // the whole point of the `>=` rule: rotation only happens after appends.
    const content = 'one\ntwo\nthree\n';
    write(1, content);
    write(0, 'new\n');

    const cursor = cursorAt(0, 4, Buffer.byteLength('one\ntwo\n'), 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: true, fileIndex: 1, end: 8 });
  });

  it('refuses when .1 is smaller than the file was at the cut', () => {
    write(1, 'one\n');
    write(0, 'new\n');
    const cursor = cursorAt(0, 4, 14, 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: false, reason: 'rotated' });
  });

  it('refuses when there is no .1 at all', () => {
    write(0, 'new\n');
    const cursor = cursorAt(0, 4, 14, 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: false, reason: 'rotated' });
  });

  it('refuses when the offset was not inside the rotated file', () => {
    // `o >= s` cannot have come from the file we are about to read.
    write(1, 'one\ntwo\nthree\n');
    write(0, 'new\n');
    const cursor = cursorAt(0, 14, 14, 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: false, reason: 'rotated' });
  });

  it('refuses a second rotation rather than chasing the index (AC-H2b)', () => {
    // The file the cursor was cut against is now `.2`; `.1` is a different
    // file. Its size happens to pass, and the line hash is what catches it.
    write(2, 'one\ntwo\nthree\n');
    write(1, 'aaa\nbbb\nccc\nddd\n');
    write(0, 'new\n');

    const cursor = cursorAt(0, 4, 14, 'two');
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: false, reason: 'line_changed' });
  });
});

describe('cursors already inside a rotation', () => {
  it('continues when the rotated file is byte-identical', () => {
    const size = write(1, 'one\ntwo\nthree\n');
    expect(resolveCursor(cursorAt(1, 4, size, 'two'), MAX_INDEX)).toEqual({
      ok: true,
      fileIndex: 1,
      end: 8,
    });
  });

  it('refuses when the rotated file changed size', () => {
    const size = write(1, 'one\ntwo\nthree\n');
    append(1, 'four\n');
    expect(resolveCursor(cursorAt(1, 4, size, 'two'), MAX_INDEX)).toEqual({
      ok: false,
      reason: 'rotated',
    });
  });

  it('refuses when the rotated file is gone', () => {
    expect(resolveCursor(cursorAt(2, 0, 10, 'one'), MAX_INDEX)).toEqual({
      ok: false,
      reason: 'rotated',
    });
  });

  it('refuses an index past the files we keep', () => {
    expect(resolveCursor(cursorAt(9, 0, 0, 'one'), MAX_INDEX)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
  });
});

describe('the line hash is the final check', () => {
  it('refuses when the line at the offset is not the one the cursor named', () => {
    const size = write(0, 'one\ntwo\nthree\n');
    const cursor: HistoryCursor = { f: 0, o: 4, s: size, h: lineHash('something else') };
    expect(resolveCursor(cursor, MAX_INDEX)).toEqual({ ok: false, reason: 'line_changed' });
  });

  it('refuses when the offset no longer lands on a line start', () => {
    const size = write(0, 'one\ntwo\nthree\n');
    expect(resolveCursor(cursorAt(0, 5, size, 'two'), MAX_INDEX)).toEqual({
      ok: false,
      reason: 'line_changed',
    });
  });
});
