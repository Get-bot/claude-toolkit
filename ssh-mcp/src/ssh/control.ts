/**
 * One short, fixed, internal command on its own channel (step A12, ADR-018).
 *
 * The shell probe in `execWrapper.ts` and the timeout reaper in `reaper.ts`
 * both need to run a few bytes of *our own* text on an already open connection
 * and look at the exit status. Routing that through `execOnce` would be wrong
 * twice over: `execOnce` frames what it is given, and these commands are the
 * framing machinery itself, so a probe would have to be probed; and it builds
 * two excerpt accumulators plus their retention buffers for a reply that is
 * never longer than a line.
 *
 * Nothing this module runs comes from a caller, so none of it is classified,
 * approved or audited — it is transport, exactly like the session handshake in
 * `session.ts`, which runs its probes the same way. Keep it that way: the
 * moment a caller's bytes could reach `command` here, this module would be a
 * hole straight through the approval gate.
 */
import type { Client } from 'ssh2';

import { ERROR_CODES } from '../errors.js';
import { SshOperationError, errorMessage } from './error.js';

/** Replies here are a line at most; anything beyond this is dropped. */
const MAX_CAPTURE_BYTES = 4096;

export interface ControlResult {
  stdout: string;
  stderr: string;
  /** `null` when the remote reported a signal instead of a status. */
  exitCode: number | null;
  /** True when the budget expired first; the other fields hold what arrived. */
  timedOut: boolean;
}

/**
 * Run `command` on `conn` and collect its (small) result.
 *
 * Resolves rather than rejects on expiry — the reaper must be able to report
 * "the cleanup command itself hung" as a fact instead of as an exception.
 * Rejects with {@link SshOperationError} only when the channel never opened.
 */
export function runControlCommand(
  conn: Client,
  command: string,
  timeoutMs: number
): Promise<ControlResult> {
  return new Promise<ControlResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    const capture = (sink: Buffer[], chunk: Buffer, taken: number): number => {
      const room = MAX_CAPTURE_BYTES - taken;
      if (room <= 0) return taken;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      sink.push(slice);
      return taken + slice.length;
    };

    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode,
        timedOut,
      });
    };

    conn.exec(command, { pty: false }, (openErr, stream) => {
      if (openErr) {
        if (timer !== null) clearTimeout(timer);
        settled = true;
        reject(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(openErr), {}));
        return;
      }
      // Same reason as `execOnce`: a control command must never sit waiting on
      // input that is not coming.
      stream.end();

      stream.on('data', (chunk: Buffer) => {
        outBytes = capture(out, chunk, outBytes);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        errBytes = capture(err, chunk, errBytes);
      });
      stream.on('exit', (code: number | null) => {
        exitCode = typeof code === 'number' ? code : null;
      });
      stream.on('close', () => {
        finish(false);
      });
      stream.on('error', () => {
        // A broken control channel is reported as "nothing came back", not as
        // a throw: every caller here is already on a failure path.
        finish(false);
      });

      timer = setTimeout(() => {
        try {
          stream.close();
        } catch {
          // Already gone.
        }
        finish(true);
      }, timeoutMs);
      timer.unref();
    });
  });
}
