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
 * On timeout we still signal the channel and close it, but that is no longer
 * what cleans up. Measured against a real OpenSSH server (step A12, ADR-018),
 * neither does anything at all: sshd ignores the SSH `signal` request on
 * session channels, and a pty-less exec channel going away does not kill the
 * child — a `sleep 37` outlived its 1.5 s budget by more than six seconds. So
 * the command is framed (`execWrapper.ts`) to report the remote shell's pid on
 * its first stdout line, that line is stripped here before the accumulators see
 * it, and the timeout path reaps by pid (`reaper.ts`) the way the session path
 * has since OPT-2. Processes detached with `nohup` or `setsid` still survive,
 * and the README says so. Non-POSIX remotes are not framed and keep exactly the
 * old behaviour, cleanup included.
 */
import type { Client } from 'ssh2';

import { ERROR_CODES } from '../errors.js';
import { retainCapFor } from '../output/limits.js';
import { createExcerptAccumulator, type ExcerptEncoding, type ExcerptMeta } from './excerpt.js';
import { SshOperationError, errorMessage } from './error.js';
import { buildExecFrame, createPidLineSplitter, execFramingAllowed } from './execWrapper.js';
import { reapRemoteProcess, type ReapOutcome } from './reaper.js';

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
  /**
   * The whole stream before excerpting, or `null` when it outgrew
   * `retainCapFor()` (ADR-010, AC-O7).
   *
   * Carried here and not registered here: turning these bytes into an
   * `output_ref` is `commandResultBody()`'s job, which is also why the timeout
   * path below can hold them and simply not pass them on (AC-O1b).
   */
  stdout_retained: Buffer | null;
  stderr_retained: Buffer | null;
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
export async function execOnce(
  conn: Client,
  command: string,
  options: ExecOptions
): Promise<CommandOutput> {
  // Decided before the clock starts: the probe behind this is per connection,
  // not per command, and charging the first command of a connection for it
  // would make `duration_ms` mean two different things.
  const framed = await execFramingAllowed(conn);
  const launch = framed ? buildExecFrame(command) : command;
  const pidLine = framed ? createPidLineSplitter() : null;
  const started = Date.now();
  // Retention is opted into at the one place each accumulator is created, so
  // there is no second buffer to keep in step with this one (ADR-010).
  const retain = { cap: retainCapFor(options.maxOutputBytes) };
  const stdout = createExcerptAccumulator({ cap: options.maxOutputBytes, retain });
  const stderr = createExcerptAccumulator({ cap: options.maxOutputBytes, retain });
  const background = hasTrailingBackground(command);

  return new Promise<CommandOutput>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    // Reaping runs *before* the channel is closed, so the pid still names a
    // live process. That leaves a window in which the remote dies of our own
    // TERM and the channel closes normally: without this flag that close would
    // resolve the call as a success, and a killed command would be reported as
    // one that finished.
    let timedOut = false;

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
        stdout_retained: out.retained,
        stderr_retained: err.retained,
      };
    };

    const succeed = (): void => {
      if (settled || timedOut) return;
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

    conn.exec(launch, { pty: false }, (err, stream) => {
      if (err) {
        fail(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(err), {}));
        return;
      }
      // AC10.3: stdin is closed before the command can read from it.
      stream.end();

      stream.on('data', (chunk: Buffer) => {
        // Past the deadline the excerpt has already been taken, and an
        // accumulator that has been finished throws when pushed to. Closing a
        // channel is not instant, so bytes do arrive in that window.
        if (timedOut) return;
        // The frame's pid line is transport, not output: it comes off here so
        // that every counter, the base64 verdict and the retained bytes are
        // computed on the command's own stdout (AC10.2, AC12).
        const payload = pidLine === null ? chunk : pidLine.push(chunk);
        if (payload.length > 0) stdout.push(payload);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        if (timedOut) return;
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
        // Once the timeout has taken over, a dying channel is the cleanup
        // working, not a connection failure to report instead of it.
        if (timedOut) return;
        fail(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(streamErr), {}));
      });

      timer = setTimeout(() => {
        timedOut = true;
        const partial = build();
        try {
          stream.signal('TERM');
        } catch {
          // Best effort: OpenSSH ignores signal requests on session channels.
        }

        // Reap first, close second. The pid is only certainly this process's
        // while the channel that owns it is open (ADR-018).
        const pid = pidLine?.pid() ?? null;
        const timeOut = (outcome: ReapOutcome): void => {
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
                // Fail loud, like the session path: a cleanup that did not
                // happen is the caller's problem, not a debug-log footnote.
                remote_cleanup: {
                  framed,
                  remote_pid: pid,
                  reaped: outcome.reaped,
                  pkill_missing: outcome.pkillMissing,
                  error: outcome.error,
                },
              }
            )
          );
        };

        if (pid === null) {
          // Unframed remote, or the frame never got its first line out. There
          // is nothing to reap, so the old behaviour is the whole behaviour.
          timeOut({ reaped: false, pkillMissing: false, error: null });
          return;
        }
        // The rejection branch must exist: without it a throw inside the reaper
        // would leave this promise pending for ever, which is a worse failure
        // than the timeout it was cleaning up after.
        void reapRemoteProcess(conn, pid).then(timeOut, (reapErr: unknown) => {
          timeOut({ reaped: false, pkillMissing: false, error: errorMessage(reapErr) });
        });
      }, options.timeoutMs);
      timer.unref();
    });
  });
}
