/**
 * Transport framing for one-shot `exec` (step A12, ADR-018; AC-T4 "타임아웃 후
 * 원격 프로세스 정리").
 *
 * `execOnce` used to hand the command to `conn.exec` verbatim and, on a
 * timeout, ask the channel to die. Measured against a real OpenSSH server that
 * does nothing at all: sshd ignores the SSH `signal` request on session
 * channels, and closing a pty-less exec channel does not kill the child. A
 * `sleep 37` outlived its 1.5 s budget by more than six seconds. To kill it we
 * need its pid, and the only side that knows the pid is the remote shell — so
 * we have to ask for it, which means framing the command:
 *
 * ```
 * printf '%s\n' "$$"; eval '<command>'
 * ```
 *
 * Every piece is load-bearing:
 *
 * - **The pid is the first stdout line.** `execOnce` strips exactly that line
 *   before the excerpt accumulators see anything, so byte counts, line counts
 *   and the UTF-8/base64 verdict are still computed on the command's own
 *   output (AC10.2, AC12). stderr is not touched at all.
 * - **`eval`**, as in ADR-001: the command is parsed exactly once, the way
 *   `sh -c` would parse it, and `eval` returns its status, so `exit_code` is
 *   unchanged. A syntax error comes back as a status instead of killing the
 *   frame before the pid was printed.
 * - **Literal single quoting, not base64.** ADR-001 reaches for base64 because
 *   a session command travels as one *line* on the shell's stdin, where a
 *   newline or a here-doc inside the command would break the line protocol.
 *   `conn.exec` has no line protocol — the command is one opaque SSH string —
 *   so base64 would buy nothing here and cost a hard dependency on a remote
 *   `base64` whose decode flag is `-d` on GNU and `-D` on BSD, which `exec`,
 *   unlike a session, has no capability handshake to learn. `buildCommandFrame`
 *   already falls back to this same literal transport when `base64Flag` is
 *   `null`, for the same reason.
 * - **Framing is transport, not content.** Classification, the approval prompt
 *   and the audit line all see the user's original string; only `execOnce` ever
 *   sees the framed one. That is the same split session framing has, and it is
 *   what keeps "the audited command is the executed command" true.
 *
 * ## Why the remote shell family is probed
 *
 * `printf`, `$$` and `eval` are POSIX shell. Frame a `cmd.exe` or PowerShell
 * login shell with them and `exec` breaks outright — and `exec` is precisely
 * what `SHELL_ALTERNATIVES` tells users of an unsupported shell to fall back
 * to, so breaking it there would take away the last thing that worked.
 *
 * `observedShells` in `state.json` is not enough: it is only ever written by
 * `open_session`, so a host that has only ever run `exec` has no observation at
 * all. Instead the first `execOnce` on a connection runs the same stage 1 probe
 * the session handshake runs (`SHELL_PROBE_COMMAND`) and caches the verdict for
 * the life of that connection — one extra round trip per pooled connection, not
 * per command. A shell that expands `$0` at all is POSIX enough for the frame,
 * which is why an unrecognised *expanded* name still frames (ADR-009: the
 * supported set is POSIX), while `cmd`, PowerShell and fish — none of which
 * expand `$0` — do not, and keep exactly today's unframed behaviour.
 */
import type { Client } from 'ssh2';

import { logger } from '../log.js';
import { runControlCommand } from './control.js';
import { errorMessage } from './error.js';
import { SHELL_PROBE_COMMAND, classifyShellProbe, type ShellProbeOutput } from './shellDetect.js';

/**
 * How framing is chosen.
 *
 * - `auto` (production): probe the connection once, frame POSIX shells only.
 * - `force`/`off`: skip the probe. Tests use these to reach both branches
 *   without standing up a non-POSIX remote, the way `configurePool` and
 *   `configureSessions` let tests reach their own hard-to-reproduce states.
 */
export type ExecFramingMode = 'auto' | 'force' | 'off';

interface ExecFramingConfig {
  mode: ExecFramingMode;
  /** Stage 1 probe budget; the §5.9 value the session handshake uses. */
  probeTimeoutMs: number;
}

const config: ExecFramingConfig = { mode: 'auto', probeTimeoutMs: 3000 };

/** Override framing for a test. Production never calls this. */
export function configureExecFraming(overrides: Partial<ExecFramingConfig>): void {
  Object.assign(config, overrides);
}

/** A pid line longer than this is not a pid; see {@link createPidLineSplitter}. */
export const PID_LINE_MAX_BYTES = 32;

/** POSIX single-quoting: the only escape inside `'...'` is `'\''`. */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The frame from the module header. One `conn.exec` string, nothing more. */
export function buildExecFrame(command: string): string {
  return `printf '%s\\n' "$$"; eval ${singleQuote(command)}`;
}

/**
 * True when the stage 1 probe output means "this shell will take the frame".
 *
 * `classifyShellProbe` answers a different question — "may we open a *session*
 * here" — and says no to any shell outside the four POSIX families. Framing
 * needs less than that: the probe only has to prove that `$0` was expanded,
 * because `cmd` (echoes `__SM_SH__$0__` back), PowerShell (expands it to
 * nothing) and fish (rejects `$0`) are exactly the shells that cannot take the
 * frame. An expanded but unrecognised shell name is a POSIX shell we have no
 * name for, and per ADR-009 the supported set is POSIX, so it is framed.
 */
export function framingSupported(probe: ShellProbeOutput): boolean {
  const verdict = classifyShellProbe(probe);
  if (verdict.supported) return true;
  if (verdict.shell !== 'unknown') return false;
  const match = /__SM_SH__(.*?)__/.exec(probe.stdout);
  const token = match?.[1] ?? '';
  // `$0` left in the text means it was never expanded, whoever printed it.
  return token.trim() !== '' && !token.includes('$');
}

// One verdict per connection: the shell behind a pooled connection does not
// change while that connection lives, and a WeakMap lets a closed client be
// collected without anything here having to be told about it.
const verdicts = new WeakMap<Client, boolean>();
const probesInFlight = new WeakMap<Client, Promise<boolean>>();

async function probeConnection(conn: Client): Promise<boolean> {
  try {
    const result = await runControlCommand(conn, SHELL_PROBE_COMMAND, config.probeTimeoutMs);
    if (result.timedOut) {
      logger.debug('exec shell probe timed out; running unframed');
      return false;
    }
    return framingSupported({ stdout: result.stdout, stderr: result.stderr });
  } catch (err) {
    // A probe that could not even open a channel says nothing about the shell.
    // Fail towards today's behaviour: run the command as it was given.
    logger.debug('exec shell probe failed; running unframed', { error: errorMessage(err) });
    return false;
  }
}

/** Whether this connection's remote shell takes the frame. Probes once. */
export async function execFramingAllowed(conn: Client): Promise<boolean> {
  if (config.mode === 'force') return true;
  if (config.mode === 'off') return false;

  const cached = verdicts.get(conn);
  if (cached !== undefined) return cached;

  // Two commands racing on a fresh connection share one probe rather than
  // opening two channels to ask the same question.
  const running = probesInFlight.get(conn);
  if (running !== undefined) return running;

  const attempt = probeConnection(conn).then((supported) => {
    verdicts.set(conn, supported);
    probesInFlight.delete(conn);
    return supported;
  });
  probesInFlight.set(conn, attempt);
  return attempt;
}

export interface PidLineSplitter {
  /** Feed one raw stdout chunk; returns the bytes the caller should keep. */
  push(chunk: Buffer): Buffer;
  /** The remote shell's pid, or `null` while it is unknown. */
  pid(): number | null;
}

const EMPTY = Buffer.alloc(0);

/**
 * Strip the frame's pid line off the front of stdout.
 *
 * The line can arrive split across chunks, or glued to the command's first
 * bytes, so the split is done on bytes and never on a decoded string — a
 * multi-byte character straddling a chunk boundary would not survive that.
 *
 * If the first line is not a pid the frame did not run as expected (an
 * unframed remote that slipped past the probe, a shell that wrote a banner
 * first). Then everything held back is handed on unchanged and the caller
 * simply has no pid to reap with: losing the reaper is a missed cleanup, but
 * swallowing output would be a wrong answer.
 */
export function createPidLineSplitter(): PidLineSplitter {
  let held: Buffer = EMPTY;
  let pid: number | null = null;
  let scanning = true;

  return {
    push(chunk: Buffer): Buffer {
      if (!scanning) return chunk;
      const merged = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
      const newline = merged.indexOf(0x0a);
      if (newline === -1) {
        if (merged.length > PID_LINE_MAX_BYTES) {
          scanning = false;
          held = EMPTY;
          return merged;
        }
        held = merged;
        return EMPTY;
      }

      held = EMPTY;
      scanning = false;
      // `\r` only shows up if something upstream translated the newline; we
      // never ask for a pty, so this is belt and braces.
      const line = merged.subarray(0, newline).toString('ascii').replace(/\r$/, '');
      if (!/^\d{1,10}$/.test(line)) return merged;
      const parsed = Number.parseInt(line, 10);
      if (parsed > 0) pid = parsed;
      return merged.subarray(newline + 1);
    },
    pid(): number | null {
      return pid;
    },
  };
}
