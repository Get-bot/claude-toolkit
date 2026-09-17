/**
 * Killing what a timed-out `exec` left running (step A12, ADR-018; AC-T4
 * "타임아웃 후 원격 프로세스 정리").
 *
 * `execOnce` signals the channel and closes it, and against a real OpenSSH
 * server neither does anything: sshd ignores the SSH `signal` request on
 * session channels, and a pty-less exec channel going away does not kill the
 * child. The session path has known this since OPT-2 step 8 and reaps by pid
 * (`session.ts` `reapChildren`); one-shot `exec` had no pid to reap with until
 * the frame in `execWrapper.ts` started printing one.
 *
 * The sequence mirrors the session path deliberately, so there is one cleanup
 * story to reason about and not two:
 *
 * 1. `pkill -TERM -P <pid>` for the children, `kill -TERM <pid>` for the shell
 *    itself. Both are needed: when the remote shell decides it can `exec` into
 *    the user's command there is no child, and the pid *is* the command.
 * 2. Wait {@link DEFAULT_KILL_GRACE_MS} — the same grace the session path uses.
 * 3. The same pair again with `KILL`.
 *
 * `pkill` is not everywhere (`procps` is not installed in a stock
 * `ubuntu:24.04`, and Git for Windows has no `pkill` at all), so a `command not
 * found` status collapses the sequence to `kill` alone and says so once per
 * connection. Killing only the shell still beats killing nothing, and saying so
 * once beats a warning per timeout on a host that will never grow a `pkill`.
 *
 * Nothing here throws: a caller is already on its failure path and needs the
 * outcome as data to attach to the timeout error, not a second exception to
 * juggle.
 *
 * TODO(dedup): `session.ts` `reapChildren` predates this module and still has
 * its own copy of the sequence, minus the `kill <pid>` half. Folding it in here
 * was deliberately left out of A12 because `session.ts` was being edited
 * concurrently; the two constants below are the ones that must not drift in the
 * meantime.
 */
import type { Client } from 'ssh2';

import { logger } from '../log.js';
import { runControlCommand } from './control.js';
import { errorMessage } from './error.js';

/**
 * Gap between TERM and KILL, for both paths that send that pair.
 *
 * Defined here because this is the module named after the operation and it
 * already owns the sibling budget below; `session.ts` imports it. It used to be
 * declared in both files, each carrying a comment telling the reader to keep
 * the two in step — an invariant held by prose, which is the shape the plan's
 * principle 1 rejects and the shape that had already let the `format:"json"`
 * column list drift between two files.
 *
 * Sharing the default does **not** merge the two runtime knobs:
 * {@link configureReaper} and `configureSessions` still set `killGraceMs`
 * independently, which is what lets a test shorten one path without the other.
 */
export const DEFAULT_KILL_GRACE_MS = 2000;
/** Budget for one reaping command. Three fixed tokens do not need longer. */
export const DEFAULT_REAP_STEP_MS = 3000;

interface ReaperConfig {
  killGraceMs: number;
  stepTimeoutMs: number;
}

const config: ReaperConfig = {
  killGraceMs: DEFAULT_KILL_GRACE_MS,
  stepTimeoutMs: DEFAULT_REAP_STEP_MS,
};

/** Shrink the timings for tests, as `configureSessions` does for sessions. */
export function configureReaper(overrides: Partial<ReaperConfig>): void {
  Object.assign(config, overrides);
}

export interface ReapOutcome {
  /** True when the TERM round reached the remote and the sequence ran. */
  reaped: boolean;
  /** True when the remote has no `pkill`, so only `kill` was used. */
  pkillMissing: boolean;
  /** What stopped the sequence, or `null`. Never swallowed; see AC-T4. */
  error: string | null;
}

/** `command not found`, the status every POSIX shell uses for a missing tool. */
const NOT_FOUND = 127;

// Warned-about connections, so a host without `procps` costs one log line per
// connection instead of one per timeout.
const warned = new WeakSet<Client>();

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * `pkill` for the children, `kill` for the shell, and the *pkill* status back.
 *
 * The status has to be `pkill`'s and not the list's, because it is the one that
 * says whether `pkill` exists at all. `kill` is a shell builtin everywhere, so
 * its own failure (the process is already gone) is not interesting.
 */
function killCommand(signal: 'TERM' | 'KILL', pid: number, usePkill: boolean): string {
  const target = String(pid);
  if (!usePkill) return `kill -${signal} ${target}`;
  return `pkill -${signal} -P ${target}; __sm_rc=$?; kill -${signal} ${target}; exit $__sm_rc`;
}

/**
 * Kill the remote process tree rooted at `pid`, and say how it went.
 *
 * `pid` comes from the frame's own first stdout line, on a channel that was
 * still open when the budget expired — so it names a process that was alive,
 * not a number a command chose. Only call this while that is still true: once
 * the channel is closed the remote is free to recycle the number.
 */
export async function reapRemoteProcess(conn: Client, pid: number): Promise<ReapOutcome> {
  let pkillMissing = false;

  try {
    const term = await runControlCommand(
      conn,
      killCommand('TERM', pid, true),
      config.stepTimeoutMs
    );
    if (term.timedOut) {
      return { reaped: false, pkillMissing, error: 'the TERM step did not finish in time' };
    }
    if (term.exitCode === NOT_FOUND) {
      pkillMissing = true;
      if (!warned.has(conn)) {
        warned.add(conn);
        logger.warn('remote has no pkill; a timed-out command can only be killed by pid', {
          remote_pid: pid,
        });
      }
      const fallback = await runControlCommand(
        conn,
        killCommand('TERM', pid, false),
        config.stepTimeoutMs
      );
      if (fallback.timedOut) {
        return { reaped: false, pkillMissing, error: 'the TERM step did not finish in time' };
      }
    }
  } catch (err) {
    return { reaped: false, pkillMissing, error: errorMessage(err) };
  }

  await delay(config.killGraceMs);

  try {
    const kill = await runControlCommand(
      conn,
      killCommand('KILL', pid, !pkillMissing),
      config.stepTimeoutMs
    );
    if (kill.timedOut) {
      return { reaped: false, pkillMissing, error: 'the KILL step did not finish in time' };
    }
  } catch (err) {
    return { reaped: false, pkillMissing, error: errorMessage(err) };
  }

  return { reaped: true, pkillMissing, error: null };
}
