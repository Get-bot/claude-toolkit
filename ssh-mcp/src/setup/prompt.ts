/**
 * Interactive prompts for `ssh-mcp setup` (plan rows 5.2 and 5.6b, OPT-6 A).
 *
 * Built on raw stream reads rather than `@inquirer/password` so that the code
 * path handling a password adds no transitive dependency (OPT-6). Three rules
 * shape the implementation:
 *
 * 1. A password is never read from a non-TTY stdin. Piping it would leave it in
 *    shell history or a CI log, so the prompt refuses instead (decision D5).
 * 2. A muted read puts the terminal in raw mode. Without raw mode the terminal
 *    itself echoes keystrokes and no amount of care on our side can hide them.
 * 3. Answers come back as `Buffer`, so the caller can overwrite them with
 *    `fill(0)`. A JavaScript string cannot be wiped.
 *
 * Streams are injectable so tests can script an answer sequence; leftover bytes
 * after a newline are kept in `#pending` and handed to the next read, which is
 * what makes a scripted multi-answer stream work.
 */
import { logger } from '../log.js';

/** Byte values the raw-mode reader reacts to. */
const BYTE_ETX = 0x03; // Ctrl-C
const BYTE_EOT = 0x04; // Ctrl-D
const BYTE_LF = 0x0a;
const BYTE_CR = 0x0d;
const BYTE_BS = 0x08;
const BYTE_DEL = 0x7f;

/** How many times a forced choice is re-asked before `setup` gives up (D3). */
export const DEFAULT_CHOICE_ATTEMPTS = 3;

/** The exact word a confirmation prompt accepts (AC7.4, row 5.1b). */
export const AFFIRMATIVE = 'yes';

export interface PromptInput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error' | 'close', listener: (arg?: unknown) => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setRawMode?(mode: boolean): unknown;
  isTTY?: boolean;
}

export interface PromptOutput {
  write(chunk: string): unknown;
}

export interface PromptIo {
  input: PromptInput;
  output: PromptOutput;
  /** Whether stdin is a terminal. A password read requires this to be true. */
  isTTY: boolean;
}

/** Raised when a prompt is needed but stdin is not a terminal (D5, AC17.12c). */
export class NonInteractiveError extends Error {
  readonly what: string;

  constructor(what: string) {
    super(
      `${what} requires an interactive terminal, but stdin is not a TTY. ` +
        'Run ssh-mcp setup directly in a terminal.'
    );
    this.name = 'NonInteractiveError';
    this.what = what;
  }
}

/** Raised when the user aborts a prompt (Ctrl-C, EOF, or too many retries). */
export class PromptAbortedError extends Error {
  readonly reason: 'interrupted' | 'eof' | 'no-answer' | 'stream-error';

  constructor(reason: PromptAbortedError['reason'], message: string) {
    super(message);
    this.name = 'PromptAbortedError';
    this.reason = reason;
  }
}

interface SplitLine {
  line: Buffer;
  rest: Buffer;
}

/**
 * Split `buf` at the first CR or LF. Returns `null` when no terminator is
 * present yet. A CRLF pair is consumed as one terminator.
 */
function takeLine(buf: Buffer): SplitLine | null {
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte !== BYTE_LF && byte !== BYTE_CR) continue;
    let next = i + 1;
    if (byte === BYTE_CR && buf[next] === BYTE_LF) next += 1;
    return { line: buf.subarray(0, i), rest: buf.subarray(next) };
  }
  return null;
}

/** Drop the last byte of `buf` (raw-mode backspace handling). */
function backspace(buf: Buffer): Buffer {
  return buf.length === 0 ? buf : buf.subarray(0, buf.length - 1);
}

function detach(input: PromptInput, event: string, listener: (...args: never[]) => void): void {
  if (typeof input.off === 'function') {
    input.off(event, listener);
    return;
  }
  if (typeof input.removeListener === 'function') {
    input.removeListener(event, listener);
  }
}

/**
 * One prompt session bound to a pair of streams.
 *
 * A single instance is shared by every prompt in a `setup` run so that bytes
 * typed ahead of a question are not lost between questions.
 */
export class Prompter {
  readonly #io: PromptIo;
  #pending: Buffer = Buffer.alloc(0);
  #rawMode = false;
  #closed = false;

  constructor(io: PromptIo) {
    this.#io = io;
  }

  /** True when a password prompt is allowed (stdin is a terminal). */
  get interactive(): boolean {
    return this.#io.isTTY;
  }

  /** Write user-facing text. Always the output stream, never stdout (row 5.9). */
  write(text: string): void {
    this.#io.output.write(text);
  }

  /** Write `text` followed by a newline. */
  writeLine(text = ''): void {
    this.write(`${text}\n`);
  }

  /**
   * Read one line as raw bytes.
   *
   * `muted: true` suppresses echo and enables raw mode when the stream supports
   * it; the returned buffer is the caller's to wipe.
   */
  async readLine(options: { muted: boolean }): Promise<Buffer> {
    if (this.#closed) {
      throw new PromptAbortedError('eof', 'prompt session is already closed');
    }

    const fromPending = takeLine(this.#pending);
    if (fromPending !== null) {
      this.#pending = Buffer.from(fromPending.rest);
      if (options.muted) this.write('\n');
      return Buffer.from(fromPending.line);
    }

    const input = this.#io.input;
    const setRaw = options.muted ? this.#enableRawMode() : false;

    return new Promise<Buffer>((resolve, reject) => {
      let acc: Buffer = Buffer.concat([this.#pending]);
      this.#pending = Buffer.alloc(0);
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        detach(input, 'data', onData as (...args: never[]) => void);
        detach(input, 'end', onEnd as (...args: never[]) => void);
        detach(input, 'error', onError as (...args: never[]) => void);
        if (setRaw) this.#disableRawMode();
        if (typeof input.pause === 'function') input.pause();
        fn();
      };

      const onData = (chunk: Buffer | string): void => {
        const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        acc = Buffer.concat([acc, incoming]);

        if (options.muted) {
          // Raw mode delivers control bytes to us, so interpret them here.
          const interrupt = acc.indexOf(BYTE_ETX);
          if (interrupt !== -1) {
            finish(() => {
              this.write('\n');
              reject(new PromptAbortedError('interrupted', 'prompt interrupted (Ctrl-C)'));
            });
            return;
          }
          const eof = acc.indexOf(BYTE_EOT);
          if (eof !== -1 && takeLine(acc.subarray(0, eof)) === null) {
            finish(() => {
              this.write('\n');
              reject(new PromptAbortedError('eof', 'prompt closed before an answer arrived'));
            });
            return;
          }
          acc = applyBackspaces(acc);
        }

        const split = takeLine(acc);
        if (split === null) return;
        finish(() => {
          this.#pending = Buffer.from(split.rest);
          if (options.muted) this.write('\n');
          resolve(Buffer.from(split.line));
        });
      };

      const onEnd = (): void => {
        finish(() => {
          // A stream that ends without a newline still yields what it had.
          if (acc.length > 0) {
            resolve(Buffer.from(acc));
            return;
          }
          reject(new PromptAbortedError('eof', 'prompt closed before an answer arrived'));
        });
      };

      const onError = (err?: unknown): void => {
        finish(() => {
          reject(
            new PromptAbortedError(
              'stream-error',
              `prompt input failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        });
      };

      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      if (typeof input.resume === 'function') input.resume();
    });
  }

  /** Restore the terminal and stop consuming input. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disableRawMode();
    if (typeof this.#io.input.pause === 'function') this.#io.input.pause();
    this.#pending = Buffer.alloc(0);
  }

  #enableRawMode(): boolean {
    const input = this.#io.input;
    if (typeof input.setRawMode !== 'function') return false;
    try {
      input.setRawMode(true);
      this.#rawMode = true;
      return true;
    } catch (err) {
      logger.debug('could not enable raw mode for the password prompt', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  #disableRawMode(): void {
    if (!this.#rawMode) return;
    this.#rawMode = false;
    const input = this.#io.input;
    if (typeof input.setRawMode !== 'function') return;
    try {
      input.setRawMode(false);
    } catch {
      // The terminal is being torn down anyway.
    }
  }
}

/** Apply backspace/DEL bytes in place so they never reach the answer. */
function applyBackspaces(buf: Buffer): Buffer {
  if (buf.indexOf(BYTE_DEL) === -1 && buf.indexOf(BYTE_BS) === -1) return buf;
  let out: Buffer = Buffer.alloc(0);
  for (const byte of buf) {
    if (byte === BYTE_DEL || byte === BYTE_BS) {
      out = backspace(out);
      continue;
    }
    out = Buffer.concat([out, Buffer.from([byte])]);
  }
  return out;
}

/**
 * Build a prompter. Defaults to stdin plus **stderr**: `setup` keeps stdout
 * clean so the habit of writing diagnostics to stdout never forms (row 5.9).
 */
export function createPrompter(io?: Partial<PromptIo>): Prompter {
  const input = io?.input ?? (process.stdin as unknown as PromptInput);
  const output = io?.output ?? (process.stderr as unknown as PromptOutput);
  const isTTY = io?.isTTY ?? input.isTTY === true;
  return new Prompter({ input, output, isTTY });
}

let sharedPrompter: Prompter | null = null;

/** Lazily created prompter over the real process streams. */
export function processPrompter(): Prompter {
  sharedPrompter ??= createPrompter();
  return sharedPrompter;
}

/** Drop the cached process prompter. For tests. */
export function resetProcessPrompter(): void {
  sharedPrompter?.close();
  sharedPrompter = null;
}

function decode(buf: Buffer): string {
  return buf.toString('utf8').trim();
}

/**
 * Read a password with echo suppressed (row 5.2).
 *
 * Throws {@link NonInteractiveError} when stdin is not a terminal: this is the
 * single reason `setup` can never run non-interactively, flag or no flag (D5).
 * The returned buffer should be wiped with `fill(0)` once used.
 */
export async function promptPassword(
  question: string,
  prompter: Prompter = processPrompter()
): Promise<Buffer> {
  if (!prompter.interactive) {
    throw new NonInteractiveError('reading a password');
  }
  prompter.write(question);
  const line = await prompter.readLine({ muted: true });
  // Strip a stray CR (Windows terminals) without touching interior bytes.
  if (line.length > 0 && line[line.length - 1] === BYTE_CR) {
    return Buffer.from(line.subarray(0, line.length - 1));
  }
  return line;
}

/**
 * Ask a yes/no question that only the exact word `yes` answers affirmatively
 * (row 5.1b). Anything else - `y`, `YES`, an empty line - is a refusal, because
 * re-pinning a host key must never happen by a slip of the hand.
 */
export async function promptYes(
  question: string,
  prompter: Prompter = processPrompter()
): Promise<boolean> {
  prompter.write(question);
  const answer = decode(await prompter.readLine({ muted: false }));
  return answer === AFFIRMATIVE;
}

/**
 * Ask for one of `options` with **no preselected value** (decision D3).
 *
 * An empty line re-asks; so does an unknown value. After `attempts` tries the
 * call throws {@link PromptAbortedError} and the caller must write nothing
 * (AC17.12a).
 */
export async function promptChoice(
  question: string,
  options: readonly string[],
  prompter: Prompter = processPrompter(),
  attempts: number = DEFAULT_CHOICE_ATTEMPTS
): Promise<string> {
  if (options.length === 0) throw new Error('promptChoice needs at least one option');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    prompter.write(question);
    const answer = decode(await prompter.readLine({ muted: false }));
    if (options.includes(answer)) return answer;
    const remaining = attempts - attempt;
    if (remaining === 0) break;
    if (answer === '') {
      prompter.writeLine(`값을 입력해야 합니다. 남은 기회 ${String(remaining)}회.`);
    } else {
      prompter.writeLine(
        `"${answer}"는 선택할 수 없습니다. ${options.join(' 또는 ')} 중 하나를 입력하세요. ` +
          `남은 기회 ${String(remaining)}회.`
      );
    }
  }
  throw new PromptAbortedError(
    'no-answer',
    `no valid answer after ${String(attempts)} attempts (expected one of: ${options.join(', ')})`
  );
}
