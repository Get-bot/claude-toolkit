/**
 * Completion frame detection for session commands (OPT-2 step 5 and 6, F12/C4).
 *
 * The frame arrives as TCP bytes, so it can be split anywhere — including
 * between the marker and the exit status. Every one of those splits is
 * exercised here, because a scanner that only works on whole frames looks
 * perfectly healthy in a fast local test and then hangs against a real host.
 */
import { describe, expect, it } from 'vitest';

import {
  MARKER_LENGTH,
  buildCommandFrame,
  buildPingFrame,
  completionPattern,
  createMarker,
  createMarkerScanner,
  stderrCompletionPattern,
} from '../../src/ssh/session.js';

const MARKER = '__SM_0123456789abcdef0123456789abcdef0__';

function stdoutFrame(output: string, rc: number): Buffer {
  return Buffer.from(`${output}\n${MARKER}${String(rc)}\n`, 'utf8');
}

function feed(scanner: ReturnType<typeof createMarkerScanner>, pieces: Buffer[]): string {
  let clean = Buffer.alloc(0);
  for (const piece of pieces) {
    const result = scanner.push(piece);
    clean = Buffer.concat([clean, result.clean]);
  }
  clean = Buffer.concat([clean, scanner.flush()]);
  return clean.toString('utf8');
}

describe('marker generation', () => {
  it('produces a 40 character marker that is different every time', () => {
    const first = createMarker();
    const second = createMarker();
    expect(first).toHaveLength(MARKER_LENGTH);
    expect(second).toHaveLength(MARKER_LENGTH);
    expect(first).not.toBe(second);
    expect(first.startsWith('__SM_')).toBe(true);
    expect(first.endsWith('__')).toBe(true);
  });

  it('builds patterns that require the surrounding newlines', () => {
    expect(completionPattern(MARKER).source).toContain('\\d{1,3}');
    expect(stderrCompletionPattern(MARKER).test(`\n${MARKER}\n`)).toBe(true);
    expect(stderrCompletionPattern(MARKER).test(`${MARKER}\n`)).toBe(false);
  });
});

describe('two-piece splits at every byte offset', () => {
  const output = 'line one\nline two';
  const frame = stdoutFrame(output, 7);

  it(`covers all ${String(frame.length + 1)} split points`, () => {
    expect(frame.length).toBeGreaterThanOrEqual(44);
    for (let cut = 0; cut <= frame.length; cut += 1) {
      const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
      const clean = feed(scanner, [frame.subarray(0, cut), frame.subarray(cut)]);
      expect(scanner.complete, `split at ${String(cut)}`).toBe(true);
      expect(scanner.exitCode, `split at ${String(cut)}`).toBe(7);
      expect(clean, `split at ${String(cut)}`).toBe(output);
    }
  });
});

describe('three-piece splits', () => {
  const output = 'alpha\nbeta\ngamma';
  const frame = stdoutFrame(output, 255);

  it.each([
    [3, 9],
    [1, 2],
    [0, frame.length],
    [5, 6],
    [frame.length - 3, frame.length - 1],
    [frame.length - 2, frame.length],
    [10, 40],
    [17, 18],
    [20, 44],
    [2, frame.length - 2],
  ])('splits at %i and %i', (first, second) => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    const clean = feed(scanner, [
      frame.subarray(0, first),
      frame.subarray(first, second),
      frame.subarray(second),
    ]);
    expect(scanner.complete).toBe(true);
    expect(scanner.exitCode).toBe(255);
    expect(clean).toBe(output);
  });
});

describe('exit status parsing', () => {
  it.each([0, 1, 2, 127, 130, 255])('reads rc %i', (rc) => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    scanner.push(stdoutFrame('out', rc));
    expect(scanner.complete).toBe(true);
    expect(scanner.exitCode).toBe(rc);
  });
});

describe('false positives', () => {
  it('ignores the marker printed inside a line', () => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    const result = scanner.push(Buffer.from(`prefix${MARKER}suffix\n`, 'utf8'));
    expect(result.complete).toBe(false);
    expect(scanner.complete).toBe(false);
  });

  it('ignores a marker with a leading newline but no status', () => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    scanner.push(Buffer.from(`data\n${MARKER}\nmore data\n`, 'utf8'));
    expect(scanner.complete).toBe(false);
  });

  it('ignores a marker whose status is not newline terminated', () => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    scanner.push(Buffer.from(`data\n${MARKER}12x\ntail\n`, 'utf8'));
    expect(scanner.complete).toBe(false);
  });

  it('still completes on a later genuine frame after a decoy', () => {
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    const clean = feed(scanner, [
      Buffer.from(`echo ${MARKER} here\n`, 'utf8'),
      stdoutFrame('', 3),
    ]);
    expect(scanner.complete).toBe(true);
    expect(scanner.exitCode).toBe(3);
    expect(clean).toBe(`echo ${MARKER} here\n`);
  });
});

describe('stderr scanner', () => {
  it('completes on the bare marker and reports no status', () => {
    const scanner = createMarkerScanner(MARKER);
    const clean = feed(scanner, [Buffer.from(`boom\n${MARKER}\n`, 'utf8')]);
    expect(scanner.complete).toBe(true);
    expect(scanner.exitCode).toBeNull();
    expect(clean).toBe('boom');
  });

  it('does not accept a status-bearing frame', () => {
    const scanner = createMarkerScanner(MARKER);
    scanner.push(stdoutFrame('boom', 1));
    expect(scanner.complete).toBe(false);
  });

  it('keeps bytes that arrive after completion as residual', () => {
    const scanner = createMarkerScanner(MARKER);
    scanner.push(Buffer.from(`x\n${MARKER}\nlater`, 'utf8'));
    expect(scanner.complete).toBe(true);
    expect(scanner.residual().toString('utf8')).toBe('later');
  });
});

describe('byte-at-a-time delivery', () => {
  it('handles one byte per chunk', () => {
    const output = 'slow\nstream';
    const frame = stdoutFrame(output, 42);
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    const pieces: Buffer[] = [];
    for (let i = 0; i < frame.length; i += 1) pieces.push(frame.subarray(i, i + 1));
    const clean = feed(scanner, pieces);
    expect(scanner.complete).toBe(true);
    expect(scanner.exitCode).toBe(42);
    expect(clean).toBe(output);
  });

  it('passes binary output through untouched', () => {
    const binary = Buffer.from([0x00, 0xff, 0x0a, 0xfe, 0x10]);
    const frame = Buffer.concat([binary, Buffer.from(`\n${MARKER}0\n`, 'utf8')]);
    const scanner = createMarkerScanner(MARKER, { expectExitCode: true });
    let clean = Buffer.alloc(0);
    for (let i = 0; i < frame.length; i += 3) {
      clean = Buffer.concat([clean, scanner.push(frame.subarray(i, i + 3)).clean]);
    }
    clean = Buffer.concat([clean, scanner.flush()]);
    expect(scanner.complete).toBe(true);
    expect(clean.equals(binary)).toBe(true);
  });
});

describe('command frame', () => {
  it('base64 transport hides quoting, newlines and comments', () => {
    const command = "echo 'a;b' # comment\nrm -rf /tmp/x";
    const frame = buildCommandFrame(command, {
      marker: MARKER,
      base64Flag: '-d',
      stdinGuard: true,
    });
    expect(frame).not.toContain('\n');
    expect(frame).not.toContain('# comment');
    expect(frame).toContain(Buffer.from(command, 'utf8').toString('base64'));
    expect(frame).toContain('base64 -d');
  });

  it('always redirects stdin from /dev/null unless the guard is off (F4)', () => {
    const options = { marker: MARKER, base64Flag: '-d' as const, stdinGuard: true };
    expect(buildCommandFrame('cat', options)).toContain('eval "$__SM_CMD" </dev/null');
    expect(buildCommandFrame('cat', { ...options, stdinGuard: false })).not.toContain('/dev/null');
  });

  it('captures the status straight after eval', () => {
    const frame = buildCommandFrame('true', {
      marker: MARKER,
      base64Flag: '-d',
      stdinGuard: true,
    });
    const evalIndex = frame.indexOf('eval "$__SM_CMD"');
    const rcIndex = frame.indexOf('__SM_RC=$?');
    expect(evalIndex).toBeGreaterThan(-1);
    expect(rcIndex).toBeGreaterThan(evalIndex);
    expect(frame.slice(evalIndex, rcIndex)).not.toContain(';;');
  });

  it('prints the marker on both streams', () => {
    const frame = buildCommandFrame('true', {
      marker: MARKER,
      base64Flag: '-d',
      stdinGuard: true,
    });
    expect(frame).toContain(`printf '\\n%s%s\\n' '${MARKER}' "$__SM_RC"`);
    expect(frame).toContain(`printf '\\n%s\\n' '${MARKER}' 1>&2`);
  });

  it('escapes single quotes in literal transport', () => {
    const frame = buildCommandFrame("echo 'hi'", {
      marker: MARKER,
      base64Flag: null,
      stdinGuard: true,
    });
    expect(frame.startsWith("__SM_CMD='echo '\\''hi'\\'''")).toBe(true);
    expect(frame).not.toContain('base64');
  });

  it('builds a ping frame that only prints markers', () => {
    const frame = buildPingFrame(MARKER);
    expect(frame).toContain(MARKER);
    expect(frame).not.toContain('eval');
  });
});
