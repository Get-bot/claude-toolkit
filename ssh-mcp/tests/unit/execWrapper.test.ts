/**
 * Transport framing for one-shot `exec` (step A12, ADR-018, AC-T4).
 *
 * Everything here is pure, and that is the point: the frame text, the "may we
 * frame this shell" verdict and the pid stripper are the three places where a
 * mistake is invisible over the wire. A frame that quotes badly runs a
 * different command than the one that was approved; a verdict that says yes to
 * `cmd.exe` breaks `exec` on the one shell family that has nothing else; a
 * stripper that mis-splits eats the first line of every answer.
 */
import { describe, expect, it } from 'vitest';

import {
  PID_LINE_MAX_BYTES,
  buildExecFrame,
  createPidLineSplitter,
  framingSupported,
  singleQuote,
} from '../../src/ssh/execWrapper.js';

describe('single quoting', () => {
  it.each([
    ['echo hi', "'echo hi'"],
    ["echo 'hi'", "'echo '\\''hi'\\'''"],
    ['a\nb', "'a\nb'"],
    ['# not a comment', "'# not a comment'"],
    ['$(whoami)', "'$(whoami)'"],
    ['', "''"],
  ])('quotes %j', (input, expected) => {
    expect(singleQuote(input)).toBe(expected);
  });
});

describe('the frame', () => {
  it('prints the pid first and evaluates the command second', () => {
    expect(buildExecFrame('echo hi')).toBe(`printf '%s\\n' "$$"; eval 'echo hi'`);
  });

  it('carries quotes, newlines and here-docs through unchanged', () => {
    const command = "cat <<'EOF'\nit's $HOME\nEOF";
    const frame = buildExecFrame(command);
    // What sits between the outer quotes must be the original command, byte
    // for byte, once POSIX quote removal has run over it.
    const body = frame.slice(frame.indexOf("eval '") + 6, -1);
    expect(body.replace(/'\\''/g, "'")).toBe(command);
  });

  it('never asks for base64 (ADR-018: exec has no capability handshake)', () => {
    expect(buildExecFrame('echo hi')).not.toContain('base64');
  });
});

describe('which shells may be framed', () => {
  it.each(['bash', '-bash', '/bin/bash', 'zsh', 'sh', 'dash', 'ash', 'busybox'])(
    'frames %s',
    (name) => {
      expect(framingSupported({ stdout: `__SM_SH__${name}__\n`, stderr: '' })).toBe(true);
    }
  );

  it('frames a POSIX shell whose name we do not know, because $0 expanded', () => {
    expect(framingSupported({ stdout: '__SM_SH__yash__\n', stderr: '' })).toBe(true);
  });

  it('does not frame cmd.exe, which echoes $0 back untouched', () => {
    expect(framingSupported({ stdout: '__SM_SH__$0__\n', stderr: '' })).toBe(false);
  });

  it('does not frame PowerShell, which expands $0 to nothing', () => {
    expect(framingSupported({ stdout: '__SM_SH__\n', stderr: '' })).toBe(false);
  });

  it('does not frame fish, which rejects $0', () => {
    expect(framingSupported({ stdout: '', stderr: 'fish: $0: Invalid variable name\n' })).toBe(
      false
    );
  });

  it('does not frame a shell that said nothing at all', () => {
    expect(framingSupported({ stdout: '', stderr: '' })).toBe(false);
  });
});

function splitAll(chunks: readonly string[]): { text: string; pid: number | null } {
  const splitter = createPidLineSplitter();
  const kept: Buffer[] = [];
  for (const chunk of chunks) {
    kept.push(splitter.push(Buffer.from(chunk, 'utf8')));
  }
  return { text: Buffer.concat(kept).toString('utf8'), pid: splitter.pid() };
}

describe('stripping the pid line', () => {
  it('takes the whole first line and nothing else', () => {
    expect(splitAll(['4711\nhello\n'])).toEqual({ text: 'hello\n', pid: 4711 });
  });

  it('handles the pid arriving split across chunks', () => {
    expect(splitAll(['4', '7', '11', '\nhel', 'lo\n'])).toEqual({ text: 'hello\n', pid: 4711 });
  });

  it('handles the newline arriving alone', () => {
    expect(splitAll(['4711', '\n', 'hello\n'])).toEqual({ text: 'hello\n', pid: 4711 });
  });

  it('keeps an empty command output empty', () => {
    expect(splitAll(['4711\n'])).toEqual({ text: '', pid: 4711 });
  });

  it('never touches bytes after the first line, however odd they are', () => {
    const splitter = createPidLineSplitter();
    const payload = Buffer.from([0x41, 0x00, 0xff, 0xfe, 0x0a, 0x42]);
    const kept = splitter.push(Buffer.concat([Buffer.from('99\n', 'ascii'), payload]));
    expect(Array.from(kept)).toEqual(Array.from(payload));
    expect(splitter.pid()).toBe(99);
  });

  it('passes a multi-byte character that straddles a chunk boundary through whole', () => {
    const hangul = Buffer.from('한국어\n', 'utf8');
    const splitter = createPidLineSplitter();
    const first = splitter.push(
      Buffer.concat([Buffer.from('12\n', 'ascii'), hangul.subarray(0, 2)])
    );
    const second = splitter.push(hangul.subarray(2));
    expect(Buffer.concat([first, second]).toString('utf8')).toBe('한국어\n');
  });

  it('hands back an unframed first line instead of eating it', () => {
    expect(splitAll(['hello\nworld\n'])).toEqual({ text: 'hello\nworld\n', pid: null });
  });

  it('gives up on a first line too long to be a pid', () => {
    const long = 'x'.repeat(PID_LINE_MAX_BYTES + 1);
    expect(splitAll([long, '\nrest'])).toEqual({ text: `${long}\nrest`, pid: null });
  });

  it('refuses a pid of zero', () => {
    expect(splitAll(['0\nhello\n'])).toEqual({ text: 'hello\n', pid: null });
  });

  it('tolerates a carriage return before the newline', () => {
    expect(splitAll(['4711\r\nhello\n'])).toEqual({ text: 'hello\n', pid: 4711 });
  });
});
