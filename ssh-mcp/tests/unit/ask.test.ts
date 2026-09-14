/**
 * The `@inquirer` adapter (`src/setup/ask.ts`).
 *
 * The adapter is deliberately thin — the library owns rendering, which is the
 * whole reason it is here — so there are exactly three things of ours to prove:
 * questions draw on **stderr** like every other prompt in this package, Ctrl-C
 * arrives as the same `PromptAbortedError` the rest of the code already
 * handles so exit codes do not change with the prompt implementation, and
 * {@link canPrompt} answers "can this terminal show a question?" the same way
 * for every caller.
 *
 * Both prompts are driven through injected pipes. Emitting keys on the real
 * `process.stdin` would leave a listener on a stream the test runner also owns,
 * and a missed answer would hang the whole file rather than fail one test.
 */
import { PassThrough } from 'node:stream';
import util from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canPrompt, createAsker } from '../../src/setup/ask.js';
import type { AskStreams } from '../../src/setup/ask.js';
import { PromptAbortedError } from '../../src/setup/prompt.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Keys a terminal would send. */
const ENTER = '\r';
const CTRL_C = '\u0003';

/** stdout is the JSON-RPC channel in server mode; nothing may draw on it. */
function forbidStdout(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    throw new Error('a prompt must never write to stdout');
  });
}

/** Give the prompt a turn of the loop to render or to react to a key. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('createAsker', () => {
  it('draws the question on the stream it was given', async () => {
    forbidStdout();
    const input = new PassThrough();
    const output = new PassThrough();
    let drawn = '';
    output.on('data', (chunk: Buffer) => {
      drawn += chunk.toString('utf8');
    });

    const pending = createAsker({ input, output }).select({
      message: '어디에 등록할까요?',
      choices: [
        { value: 'local', name: '이 프로젝트만' },
        { value: 'user', name: '모든 프로젝트' },
      ],
      default: 'local',
    });

    await settle();
    expect(drawn).toContain('어디에 등록할까요?');
    // The footer is the library's only prose, and it reads in the same language
    // as everything above it.
    expect(drawn).toContain('이동');
    expect(drawn).toContain('선택');
    expect(drawn).not.toContain('navigate');
    input.write(ENTER);
    expect(await pending).toBe('local');
  });

  it('keeps the help line when this Node has no styleText', async () => {
    // Node 20.0-20.11 has no `util.styleText`. Reading it off the namespace is
    // what keeps that a missing colour instead of a SyntaxError that kills the
    // whole CLI before `MIN_NODE_MAJOR` can say anything — see `paint()`.
    forbidStdout();
    const original = util.styleText;
    const input = new PassThrough();
    const output = new PassThrough();
    let drawn = '';
    output.on('data', (chunk: Buffer) => {
      drawn += chunk.toString('utf8');
    });

    try {
      delete (util as { styleText?: unknown }).styleText;
      const pending = createAsker({ input, output }).select({
        message: '어디에 등록할까요?',
        choices: [{ value: 'local', name: '이 프로젝트만' }],
      });
      await settle();
      expect(drawn).toContain('이동');
      expect(drawn).toContain('선택');
      input.write(ENTER);
      expect(await pending).toBe('local');
    } finally {
      (util as { styleText?: unknown }).styleText = original;
    }
  });

  it('defaults its output to stderr, not stdout', async () => {
    forbidStdout();
    let drawn = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      drawn += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });

    const input = new PassThrough();
    const pending = createAsker({ input }).text({ message: '라벨' });
    await settle();
    expect(drawn).toContain('라벨');
    input.write(`hello${ENTER}`);
    expect(await pending).toBe('hello');
  });

  it('turns Ctrl-C into the abort error the rest of the package handles', async () => {
    forbidStdout();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();

    const pending = createAsker({ input, output }).text({ message: '호스트 주소' });
    await settle();
    input.write(CTRL_C);

    await expect(pending).rejects.toBeInstanceOf(PromptAbortedError);
    await expect(pending).rejects.toMatchObject({ reason: 'interrupted' });
  });
});

/**
 * All three conditions matter, and each one on its own has produced a bad run:
 * a piped stdin hangs forever, a redirected stderr puts the question in a log
 * file, and `TERM=dumb` cannot address the cursor the list redraws with.
 */
describe('canPrompt', () => {
  /** Only `isTTY` is read, so a bare object stands in for either stream. */
  type Either = NonNullable<AskStreams['input']> & NonNullable<AskStreams['output']>;
  const tty = { isTTY: true } as Either;
  const pipe = { isTTY: false } as Either;

  it('is true only for a TTY on both ends with a usable TERM', () => {
    expect(canPrompt({ TERM: 'xterm-256color' }, { input: tty, output: tty })).toBe(true);
    expect(canPrompt({}, { input: tty, output: tty })).toBe(true);
  });

  it('is false when stdin is redirected', () => {
    expect(canPrompt({}, { input: pipe, output: tty })).toBe(false);
  });

  it('is false when stderr is redirected, because that is where it draws', () => {
    expect(canPrompt({}, { input: tty, output: pipe })).toBe(false);
  });

  it('is false for TERM=dumb', () => {
    expect(canPrompt({ TERM: 'dumb' }, { input: tty, output: tty })).toBe(false);
  });

  /**
   * The menu this replaced compared `['dumb', '']` after `trim().toLowerCase()`.
   * An exact match let three spellings of the same terminal through, and
   * `canPrompt` is now the only gate, so the width of the check matters more
   * than it did.
   */
  it.each([['DUMB'], ['dumb '], [' Dumb'], ['']])(
    'is false for TERM=%j, which says the same thing',
    (term) => {
      expect(canPrompt({ TERM: term }, { input: tty, output: tty })).toBe(false);
    }
  );

  it('still allows an unset TERM, which is a plain Windows console', () => {
    // Empty only means "dumb" on a platform that sets the variable at all;
    // refusing an absent one would stop asking on Windows entirely.
    expect(canPrompt({}, { input: tty, output: tty })).toBe(true);
  });
});
