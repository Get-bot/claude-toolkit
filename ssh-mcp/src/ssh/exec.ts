/**
 * One-shot command execution (plan row 3.3, AC10, AC11, AC12).
 *
 * Three decisions carry the acceptance criteria:
 *
 * - **No pty.** `{ pty: false }` keeps stdout and stderr on separate SSH
 *   channels, which is what makes AC10's "returns stdout, stderr and exit code
 *   separately" true at the protocol level rather than by parsing.
 * - **stdin closed immediately.** `stream.end()` right after the channel opens
 *   sends EOF, so `cat` with no arguments returns at once instead of waiting
 *   forever, and `sudo` fails fast with its "no tty present" message instead of
 *   blocking on a password prompt (AC10.3, §5.3 `sudo_password_required`).
 * - **Excerpting happens in the accumulator.** Both streams are fed to the
 *   §5.8 module as bytes arrive, so a 2 MiB burst never accumulates in full
 *   (AC12).
 *
 * On timeout we ask for the process group to die (`signal('TERM')`) and then
 * close the channel; OpenSSH sends SIGHUP to the session's process group when
 * the channel goes away, which is the part that actually cleans up. Processes
 * detached with `nohup` or `setsid` survive, and the README says so.
 */
import type { Client } from 'ssh2';

import { ERROR_CODES } from '../errors.js';
import { createExcerptAccumulator, type ExcerptEncoding, type ExcerptMeta } from './excerpt.js';
import { SshOperationError, errorMessage } from './error.js';

export interface ExecOptions {
  /** Wall-clock budget; on expiry the channel is signalled and closed. */
  timeoutMs: number;
  /** Per-stream output ceiling (the host's `maxOutputBytes`). */
  maxOutputBytes: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  stdout_meta: ExcerptMeta;
  stderr_meta: ExcerptMeta;
  /** `null` when the process died from a signal. */
  exit_code: number | null;
  /** Signal name when the process was killed, else `null`. */
  signal: string | null;
  /** `base64` when either stream was not valid UTF-8 (AC10.2). */
  encoding: ExcerptEncoding;
  duration_ms: number;
  /**
   * True when the command ends in a top-level `&`. The command still runs; the
   * caller is expected to warn that later output belongs to no call (AC10.4).
   */
  background_job: boolean;
}

/**
 * True when the command ends with a single `&`, i.e. the last segment was
 * backgrounded. Quote-aware splitting is the classifier's job; here a trailing
 * `&` outside the obvious `&&` is enough to raise the warning flag.
 */
export function hasTrailingBackground(command: string): boolean {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith('&')) return false;
  return !trimmed.endsWith('&&');
}

function combinedEncoding(stdout: ExcerptMeta, stderr: ExcerptMeta): ExcerptEncoding {
  return stdout.encoding === 'base64' || stderr.encoding === 'base64' ? 'base64' : 'utf8';
}

/**
 * Run `command` on an existing connection and collect the whole result.
 *
 * Rejects with {@link SshOperationError}: `command_timeout` when the budget
 * expires (partial output is attached to `details`), otherwise the pool's
 * connection error code when the channel could not be opened.
 */
export function execOnce(
  conn: Client,
  command: string,
  options: ExecOptions
): Promise<CommandOutput> {
  const started = Date.now();
  const stdout = createExcerptAccumulator({ cap: options.maxOutputBytes });
  const stderr = createExcerptAccumulator({ cap: options.maxOutputBytes });
  const background = hasTrailingBackground(command);

  return new Promise<CommandOutput>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    const clear = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const build = (): CommandOutput => {
      const out = stdout.finish();
      const err = stderr.finish();
      return {
        stdout: out.text,
        stderr: err.text,
        stdout_meta: out.meta,
        stderr_meta: err.meta,
        exit_code: exitCode,
        signal: exitSignal,
        encoding: combinedEncoding(out.meta, err.meta),
        duration_ms: Date.now() - started,
        background_job: background,
      };
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      clear();
      resolve(build());
    };

    const fail = (error: SshOperationError): void => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };

    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        fail(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(err), {}));
        return;
      }
      // AC10.3: stdin is closed before the command can read from it.
      stream.end();

      stream.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      stream.on('exit', (code: number | null, signalName?: string) => {
        exitCode = typeof code === 'number' ? code : null;
        exitSignal = typeof signalName === 'string' ? signalName : null;
      });
      stream.on('close', () => {
        succeed();
      });
      stream.on('error', (streamErr: Error) => {
        fail(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(streamErr), {}));
      });

      timer = setTimeout(() => {
        const partial = build();
        try {
          stream.signal('TERM');
        } catch {
          // Best effort: OpenSSH may ignore signal requests entirely.
        }
        try {
          stream.close();
        } catch {
          // Channel already gone.
        }
        fail(
          new SshOperationError(
            ERROR_CODES.command_timeout,
            `command exceeded its ${String(options.timeoutMs)} ms budget and was terminated`,
            {
              timeout_ms: options.timeoutMs,
              duration_ms: partial.duration_ms,
              partial_stdout: partial.stdout,
              partial_stderr: partial.stderr,
              stdout_meta: partial.stdout_meta,
              stderr_meta: partial.stderr_meta,
              background_job: partial.background_job,
            }
          )
        );
      }, options.timeoutMs);
      timer.unref();
    });
  });
}
