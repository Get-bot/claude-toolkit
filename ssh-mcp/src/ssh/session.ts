/**
 * Stateful shell sessions (plan row 3.5, OPT-2, AC14, AC15).
 *
 * A session is one pty-less `shell` channel kept open on a pooled connection.
 * Commands are handed to it inside a fixed frame and completion is detected by
 * a per-session random marker, not by a quiet period:
 *
 * ```
 * __SM_CMD=$(printf %s '<base64>' | base64 -d); eval "$__SM_CMD" </dev/null; \
 *   __SM_RC=$?; printf '\n%s%s\n' '<MARKER>' "$__SM_RC"; \
 *   printf '\n%s\n' '<MARKER>' 1>&2; unset __SM_CMD __SM_RC
 * ```
 *
 * Every token in that line is load-bearing:
 *
 * - `eval` runs in the current shell, so `cd`, `export` and
 *   `source venv/bin/activate` persist across calls (AC14), and a syntax error
 *   comes back as status 2 instead of killing the shell the way an inline
 *   `{ ... }` would.
 * - `</dev/null` stops a command that reads stdin (`cat`, a pipeline without
 *   `head`) from swallowing the frame text we send next. Without it the marker
 *   never arrives, and worse, the next command's frame gets eaten as input and
 *   the session silently desynchronises (F4/C3, AC10.3).
 * - base64 transport means newlines, quotes, `#` comments and here-docs in the
 *   user's command cannot break the transport line.
 * - The marker is printed on *both* streams, with a leading and trailing
 *   newline, and matched as `\n<MARKER>(\d{1,3})\n`. Requiring the newlines is
 *   what keeps a command that echoes the marker mid-line from faking
 *   completion (F12/C4).
 *
 * The excerpt accumulators sit downstream of marker extraction, so our frame
 * bytes and handshake round trips never appear in `total_lines` or
 * `omitted_lines` (N3). Marker scanning itself continues on the raw stream
 * regardless of how full the excerpt buffers are.
 */
import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';

import { ERROR_CODES, isCodedError } from '../errors.js';
import { logger } from '../log.js';
import { recordObservedShell } from '../config/state.js';
import { SshOperationError, errorMessage } from './error.js';
import { createExcerptAccumulator, type ExcerptEncoding, type ExcerptMeta } from './excerpt.js';
import { execOnce, hasTrailingBackground } from './exec.js';
import type { PoolHost } from './pool.js';
import { touchConnection } from './pool.js';
import {
  SHELL_PREAMBLE,
  SHELL_PROBE_COMMAND,
  buildCapabilityProbe,
  classifyShellProbe,
  parseCapabilityProbe,
  type Base64Flag,
  type PosixShell,
} from './shellDetect.js';

/** Total marker length in characters (`__SM_` + 33 hex + `__`). */
export const MARKER_LENGTH = 40;
/** Sessions per host (AC15.2). */
export const MAX_SESSIONS_PER_HOST = 5;
/** Idle sessions are closed after this long (AC15.1). */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** A closed id stays known for this long so callers get a precise error. */
export const DEFAULT_TOMBSTONE_MS = 10 * 60 * 1000;
/** How often the reaper looks for idle sessions. */
export const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000;
/** Stage 1 shell identification budget (§5.9). */
export const DEFAULT_SHELL_PROBE_MS = 3000;
/** Stage 2 capability probe budget (§5.9). */
export const DEFAULT_HANDSHAKE_MS = 10000;
/** Budget for the post-timeout liveness ping (OPT-2 step 8). */
export const DEFAULT_PING_MS = 2000;
/** Gap between `pkill -TERM` and `pkill -KILL` (OPT-2 step 8). */
export const DEFAULT_KILL_GRACE_MS = 2000;

interface SessionConfig {
  idleMs: number;
  tombstoneMs: number;
  reaperIntervalMs: number;
  shellProbeMs: number;
  handshakeMs: number;
  pingMs: number;
  killGraceMs: number;
  maxSessionsPerHost: number;
}

const config: SessionConfig = {
  idleMs: DEFAULT_IDLE_MS,
  tombstoneMs: DEFAULT_TOMBSTONE_MS,
  reaperIntervalMs: DEFAULT_REAPER_INTERVAL_MS,
  shellProbeMs: DEFAULT_SHELL_PROBE_MS,
  handshakeMs: DEFAULT_HANDSHAKE_MS,
  pingMs: DEFAULT_PING_MS,
  killGraceMs: DEFAULT_KILL_GRACE_MS,
  maxSessionsPerHost: MAX_SESSIONS_PER_HOST,
};

/** Shrink the timings for tests (AC15.1 injects a two second idle limit). */
export function configureSessions(overrides: Partial<SessionConfig>): void {
  Object.assign(config, overrides);
}

/** Current timings, for assertions. */
export function sessionConfig(): Readonly<SessionConfig> {
  return { ...config };
}

// ---------------------------------------------------------------------------
// Marker framing (pure; exercised directly by tests/unit/markerFraming.test.ts)
// ---------------------------------------------------------------------------

/** A fresh 40-character marker. Collisions with command text are impossible. */
export function createMarker(): string {
  const body = randomBytes(17).toString('hex').slice(0, 33);
  return `__SM_${body}__`;
}

/** `\n<marker><rc>\n` — the stdout completion frame (OPT-2 step 5). */
export function completionPattern(marker: string): RegExp {
  return new RegExp(`\\n${marker}(\\d{1,3})\\n`);
}

/** `\n<marker>\n` — the stderr completion frame. */
export function stderrCompletionPattern(marker: string): RegExp {
  return new RegExp(`\\n${marker}\\n`);
}

export interface MarkerScanOutput {
  /** Bytes that belong to the command, marker frame removed. */
  clean: Buffer;
  /** True once the completion frame has been seen. */
  complete: boolean;
  /** Exit status from the frame, when this scanner expects one. */
  exitCode: number | null;
}

export interface MarkerScanner {
  push(chunk: Buffer): MarkerScanOutput;
  /** Release withheld bytes; call when the channel closes. */
  flush(): Buffer;
  /** Bytes that arrived after the completion frame. */
  residual(): Buffer;
  readonly complete: boolean;
  readonly exitCode: number | null;
}

const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const NEWLINE = 0x0a;

/**
 * Streaming marker extractor.
 *
 * Withholds the trailing `marker.length + 16` bytes of every chunk so a marker
 * split across chunk boundaries is still recognised, and releases them as soon
 * as the next chunk (or the completion frame) proves they are ordinary output.
 */
export function createMarkerScanner(
  marker: string,
  options: { expectExitCode?: boolean } = {}
): MarkerScanner {
  const expectExitCode = options.expectExitCode ?? false;
  const needle = Buffer.from(`\n${marker}`, 'utf8');
  const holdBack = needle.length + 16;

  let pending: Buffer = Buffer.alloc(0);
  let after: Buffer = Buffer.alloc(0);
  let complete = false;
  let exitCode: number | null = null;

  function scan(buf: Buffer): MarkerScanOutput {
    let searchFrom = 0;
    while (true) {
      const index = buf.indexOf(needle, searchFrom);
      if (index === -1) break;

      let cursor = index + needle.length;
      let digits = '';
      while (cursor < buf.length && digits.length < 3) {
        const byte = buf[cursor] as number;
        if (byte < DIGIT_ZERO || byte > DIGIT_NINE) break;
        digits += String.fromCharCode(byte);
        cursor += 1;
      }

      if (cursor >= buf.length) {
        // The frame may still be arriving: keep everything from `index`.
        pending = buf.subarray(index);
        return { clean: buf.subarray(0, index), complete: false, exitCode: null };
      }

      const terminated = buf[cursor] === NEWLINE;
      const digitsOk = expectExitCode ? digits.length > 0 : digits.length === 0;
      if (terminated && digitsOk) {
        complete = true;
        exitCode = expectExitCode ? Number.parseInt(digits, 10) : null;
        pending = Buffer.alloc(0);
        after = buf.subarray(cursor + 1);
        return { clean: buf.subarray(0, index), complete: true, exitCode };
      }

      // Not our frame: the marker text appeared in ordinary output.
      searchFrom = index + 1;
    }

    if (buf.length <= holdBack) {
      pending = buf;
      return { clean: Buffer.alloc(0), complete: false, exitCode: null };
    }
    const cut = buf.length - holdBack;
    pending = buf.subarray(cut);
    return { clean: buf.subarray(0, cut), complete: false, exitCode: null };
  }

  return {
    push(chunk: Buffer): MarkerScanOutput {
      if (complete) {
        after = Buffer.concat([after, chunk]);
        return { clean: Buffer.alloc(0), complete: true, exitCode };
      }
      const buf = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      pending = Buffer.alloc(0);
      return scan(buf);
    },
    flush(): Buffer {
      const out = pending;
      pending = Buffer.alloc(0);
      return out;
    },
    residual(): Buffer {
      const out = after;
      after = Buffer.alloc(0);
      return out;
    },
    get complete(): boolean {
      return complete;
    },
    get exitCode(): number | null {
      return exitCode;
    },
  };
}

export type Base64Mode = 'base64' | 'literal';

export interface FrameOptions {
  marker: string;
  /** Decode flag from the handshake; `null` selects literal transport. */
  base64Flag: Base64Flag | null;
  /** False only when `/dev/null` is unreadable on the remote host. */
  stdinGuard: boolean;
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The command frame from OPT-2 step 3. One line, terminated by the caller. */
export function buildCommandFrame(command: string, options: FrameOptions): string {
  const { marker, base64Flag, stdinGuard } = options;
  const redirect = stdinGuard ? ' </dev/null' : '';
  const assign =
    base64Flag === null
      ? `__SM_CMD=${singleQuote(command)}`
      : `__SM_CMD=$(printf %s '${Buffer.from(command, 'utf8').toString('base64')}' | base64 ${base64Flag})`;

  return [
    assign,
    `eval "$__SM_CMD"${redirect}`,
    '__SM_RC=$?',
    `printf '\\n%s%s\\n' '${marker}' "$__SM_RC"`,
    `printf '\\n%s\\n' '${marker}' 1>&2`,
    'unset __SM_CMD __SM_RC',
  ].join('; ');
}

/** Liveness ping used after a timeout (OPT-2 step 8). */
export function buildPingFrame(marker: string): string {
  return [`printf '\\n%s%s\\n' '${marker}' 0`, `printf '\\n%s\\n' '${marker}' 1>&2`].join('; ');
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface StreamSink {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

interface SessionRecord {
  id: string;
  alias: string;
  conn: Client;
  channel: ClientChannel;
  marker: string;
  shell: PosixShell;
  shellVersion: string | null;
  shellFlags: string | null;
  shellPid: number | null;
  base64Flag: Base64Flag | null;
  stdinGuard: boolean;
  lastActivity: number;
  closed: boolean;
  sink: StreamSink | null;
  queue: Promise<void>;
}

type TombstoneReason = 'expired' | 'closed' | 'terminated';

interface Tombstone {
  alias: string;
  reason: TombstoneReason;
  at: number;
}

const sessions = new Map<string, SessionRecord>();
const tombstones = new Map<string, Tombstone>();
let reaper: NodeJS.Timeout | null = null;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function startReaper(): void {
  if (reaper !== null) return;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const record of Array.from(sessions.values())) {
      if (now - record.lastActivity >= config.idleMs) {
        logger.debug('closing idle session', { session_id: record.id, alias: record.alias });
        destroySession(record, 'expired');
      }
    }
    for (const [id, tombstone] of Array.from(tombstones.entries())) {
      if (now - tombstone.at >= config.tombstoneMs) tombstones.delete(id);
    }
    if (sessions.size === 0 && tombstones.size === 0) stopReaper();
  }, config.reaperIntervalMs);
  timer.unref();
  reaper = timer;
}

/** Stop the idle reaper. Exported so tests can prove the timer is releasable. */
export function stopReaper(): void {
  if (reaper === null) return;
  clearInterval(reaper);
  reaper = null;
}

function destroySession(record: SessionRecord, reason: TombstoneReason): void {
  if (record.closed) return;
  record.closed = true;
  record.sink = null;
  sessions.delete(record.id);
  tombstones.set(record.id, { alias: record.alias, reason, at: Date.now() });
  try {
    record.channel.end();
  } catch {
    // Channel already gone.
  }
  try {
    record.channel.close();
  } catch {
    // Channel already gone.
  }
}

function lookup(sessionId: string): SessionRecord {
  const record = sessions.get(sessionId);
  if (record !== undefined && !record.closed) return record;

  const tombstone = tombstones.get(sessionId);
  if (tombstone === undefined) {
    throw new SshOperationError(ERROR_CODES.session_not_found, `unknown session: ${sessionId}`, {
      session_id: sessionId,
      reason: 'unknown',
    });
  }
  if (tombstone.reason === 'expired') {
    throw new SshOperationError(
      ERROR_CODES.session_expired,
      `session ${sessionId} was closed after being idle`,
      { session_id: sessionId, host: tombstone.alias, reason: 'expired' }
    );
  }
  if (tombstone.reason === 'terminated') {
    throw new SshOperationError(
      ERROR_CODES.session_terminated,
      `session ${sessionId} is no longer usable`,
      { session_id: sessionId, host: tombstone.alias, reason: 'terminated' }
    );
  }
  throw new SshOperationError(ERROR_CODES.session_not_found, `session ${sessionId} was closed`, {
    session_id: sessionId,
    host: tombstone.alias,
    reason: 'closed',
  });
}

/**
 * Result of {@link lookupSession}.
 *
 * `reason` is optional and only present on `unknown`, so a caller that
 * switches on `state` alone stays exhaustive.
 */
export type SessionLookup =
  | { state: 'active'; host: string; detected_shell: PosixShell }
  | { state: 'expired' }
  | { state: 'unknown'; reason?: 'closed' | 'terminated' };

/** Live sessions, for one alias or in total. */
export function sessionCount(alias?: string): number {
  if (alias === undefined) return sessions.size;
  let count = 0;
  for (const record of sessions.values()) {
    if (record.alias === alias) count += 1;
  }
  return count;
}

/** Session ids currently open. */
export function sessionIds(): string[] {
  return Array.from(sessions.keys());
}

/**
 * Close every session and forget every tombstone, then stop the reaper.
 * Used on shutdown and between tests.
 */
export function resetSessions(): void {
  for (const record of Array.from(sessions.values())) {
    destroySession(record, 'closed');
  }
  sessions.clear();
  tombstones.clear();
  stopReaper();
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

function openShellChannel(conn: Client): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    // `false` as the window argument suppresses the pty request; verified
    // against ssh2 1.17.0 (`lib/client.js`: `if (wndopts !== false) reqPty`).
    conn.shell(false, {}, (err, channel) => {
      if (err) {
        reject(new SshOperationError(ERROR_CODES.connection_failed, errorMessage(err)));
        return;
      }
      resolve(channel);
    });
  });
}

interface ProbeCollector {
  stdout: string;
  stderr: string;
}

/**
 * Run the stage 1 probe and classify the answer.
 *
 * Resolves as soon as the answer is recognisable, and otherwise after
 * `shellProbeMs` so that a shell which says nothing at all is reported as
 * `unknown` rather than hanging the call.
 */
function probeShellIdentity(channel: ClientChannel): Promise<ProbeCollector> {
  return new Promise<ProbeCollector>((resolve) => {
    const collected: ProbeCollector = { stdout: '', stderr: '' };
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeListener('data', onStdout);
      channel.stderr.removeListener('data', onStderr);
      resolve(collected);
    };

    const recognisable = (): boolean =>
      /__SM_SH__.*__/.test(collected.stdout) ||
      /__SM_SH__\s*$/m.test(collected.stdout) ||
      /fish:/i.test(collected.stderr);

    function onStdout(chunk: Buffer): void {
      collected.stdout += chunk.toString('utf8');
      if (recognisable()) finish();
    }
    function onStderr(chunk: Buffer): void {
      collected.stderr += chunk.toString('utf8');
      if (recognisable()) finish();
    }

    const timer = setTimeout(finish, config.shellProbeMs);
    timer.unref();

    channel.on('data', onStdout);
    channel.stderr.on('data', onStderr);
    channel.write(`${SHELL_PROBE_COMMAND}\n`);
  });
}

interface FrameWaitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

/**
 * Write one frame and wait for the marker on both streams.
 *
 * `onStdout`/`onStderr` receive the command's own bytes with the frame
 * removed; they are where the excerpt accumulators are plugged in.
 */
function runFrame(
  record: SessionRecord,
  frame: string,
  timeoutMs: number,
  onClean?: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void }
): Promise<FrameWaitResult> {
  return new Promise<FrameWaitResult>((resolve, reject) => {
    const stdoutScanner = createMarkerScanner(record.marker, { expectExitCode: true });
    const stderrScanner = createMarkerScanner(record.marker);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      record.sink = null;
      record.channel.removeListener('close', onChannelClose);
    };

    const maybeFinish = (): void => {
      if (settled) return;
      if (!stdoutScanner.complete || !stderrScanner.complete) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: stdoutScanner.exitCode,
      });
    };

    /**
     * The shell went away mid-command: `exit`, a fatal special-builtin error,
     * or the peer closing the channel. Failing straight away beats waiting out
     * the timeout for a marker that can never arrive.
     */
    function onChannelClose(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new SshOperationError(
          ERROR_CODES.session_terminated,
          `the remote shell for session ${record.id} exited while the command was running`,
          { session_id: record.id, host: record.alias, reason: 'shell-exited' }
        )
      );
    }

    record.sink = {
      onStdout(chunk: Buffer): void {
        const result = stdoutScanner.push(chunk);
        if (result.clean.length > 0) {
          stdoutChunks.push(result.clean);
          onClean?.stdout(result.clean);
        }
        maybeFinish();
      },
      onStderr(chunk: Buffer): void {
        const result = stderrScanner.push(chunk);
        if (result.clean.length > 0) {
          stderrChunks.push(result.clean);
          onClean?.stderr(result.clean);
        }
        maybeFinish();
      },
    };

    record.channel.once('close', onChannelClose);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const partialStdout = Buffer.concat([...stdoutChunks, stdoutScanner.flush()]);
      const partialStderr = Buffer.concat([...stderrChunks, stderrScanner.flush()]);
      reject(
        new SshOperationError(
          ERROR_CODES.command_timeout,
          `no completion marker within ${String(timeoutMs)} ms`,
          {
            timeout_ms: timeoutMs,
            partial_stdout_bytes: partialStdout.length,
            partial_stderr_bytes: partialStderr.length,
          }
        )
      );
    }, timeoutMs);
    timer.unref();

    try {
      record.channel.write(`${frame}\n`);
    } catch (err) {
      settled = true;
      cleanup();
      reject(new SshOperationError(ERROR_CODES.session_terminated, errorMessage(err)));
    }
  });
}

export interface OpenSessionResult {
  session_id: string;
  /** Alias the session belongs to. */
  host: string;
  detected_shell: PosixShell;
  shell_version: string | null;
  /** Value of `$-` on the remote shell, for diagnostics (§5.9). */
  shell_flags: string | null;
  /** False when `/dev/null` was unreadable and the stdin guard was dropped. */
  stdin_guard: boolean;
  base64_mode: Base64Mode;
}

/**
 * Open a session on `conn` (AC14, AC15.2, AC15.3, PM-2).
 *
 * The slot is taken only once the handshake has succeeded: a shell we refuse
 * must not lock one of the five slots, or five bad attempts would make the
 * host permanently unusable (AC15.3).
 */
export async function openSession(host: PoolHost, conn: Client): Promise<OpenSessionResult> {
  if (sessionCount(host.alias) >= config.maxSessionsPerHost) {
    throw new SshOperationError(
      ERROR_CODES.session_limit_exceeded,
      `host "${host.alias}" already has ${String(config.maxSessionsPerHost)} open sessions`,
      { host: host.alias, limit: config.maxSessionsPerHost }
    );
  }

  touchConnection(host.alias);
  const channel = await openShellChannel(conn);

  const discard = (): void => {
    try {
      channel.end();
    } catch {
      // Nothing to do.
    }
    try {
      channel.close();
    } catch {
      // Nothing to do.
    }
  };

  // Neutralise a `set -e` / `set -u` inherited from the user's rc files before
  // anything else runs on this channel (F5/C5, AC14.4).
  channel.write(`${SHELL_PREAMBLE}\n`);

  const probe = await probeShellIdentity(channel);
  const verdict = classifyShellProbe(probe);
  if (!verdict.supported) {
    discard();
    recordObservedShell(host.alias, verdict.shell);
    if (verdict.shell === 'unknown') {
      throw new SshOperationError(
        ERROR_CODES.shell_incompatible,
        'the remote shell did not answer the identification probe',
        {
          host: host.alias,
          detected_shell: verdict.shell,
          probe_stdout: probe.stdout.slice(0, 512),
          probe_stderr: probe.stderr.slice(0, 512),
        }
      );
    }
    throw new SshOperationError(ERROR_CODES.unsupported_shell, verdict.message, {
      host: host.alias,
      detected_shell: verdict.shell,
      alternatives: verdict.alternatives,
      classification_coverage: verdict.classification_coverage,
    });
  }

  const marker = createMarker();
  const record: SessionRecord = {
    id: `sess_${randomBytes(12).toString('hex')}`,
    alias: host.alias,
    conn,
    channel,
    marker,
    shell: verdict.shell,
    shellVersion: null,
    shellFlags: null,
    shellPid: null,
    base64Flag: null,
    stdinGuard: true,
    lastActivity: Date.now(),
    closed: false,
    sink: null,
    queue: Promise.resolve(),
  };

  channel.on('data', (chunk: Buffer) => {
    if (record.sink === null) {
      logger.debug('dropping session output with no active command', {
        session_id: record.id,
        bytes: chunk.length,
      });
      return;
    }
    record.sink.onStdout(chunk);
  });
  channel.stderr.on('data', (chunk: Buffer) => {
    record.sink?.onStderr(chunk);
  });

  let capability;
  try {
    const result = await runFrame(record, buildCapabilityProbe(marker), config.handshakeMs);
    capability = parseCapabilityProbe(result.stdout.toString('utf8'));
  } catch (err) {
    discard();
    recordObservedShell(host.alias, verdict.shell);
    throw new SshOperationError(
      ERROR_CODES.shell_incompatible,
      `the capability handshake failed on ${host.alias}: ${errorMessage(err)}`,
      { host: host.alias, detected_shell: verdict.shell }
    );
  }

  record.shellVersion = capability.version;
  record.shellFlags = capability.flags;
  record.shellPid = capability.pid;
  record.base64Flag = capability.base64Flag;
  record.stdinGuard = capability.devNull;

  if (!capability.devNull) {
    logger.warn('remote /dev/null is not readable; stdin guard disabled', {
      host: host.alias,
      session_id: record.id,
    });
  }
  if (capability.base64Flag === null) {
    logger.warn('remote base64 is unusable; falling back to literal command transport', {
      host: host.alias,
      session_id: record.id,
    });
  }

  channel.on('close', () => {
    if (!record.closed) {
      logger.debug('session channel closed by peer', { session_id: record.id });
      destroySession(record, 'terminated');
    }
  });

  sessions.set(record.id, record);
  startReaper();
  recordObservedShell(host.alias, verdict.shell);

  return {
    session_id: record.id,
    host: record.alias,
    detected_shell: record.shell,
    shell_version: record.shellVersion,
    shell_flags: record.shellFlags,
    stdin_guard: record.stdinGuard,
    base64_mode: record.base64Flag === null ? 'literal' : 'base64',
  };
}

export interface RunInSessionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SessionRunResult {
  session_id: string;
  stdout: string;
  stderr: string;
  stdout_meta: ExcerptMeta;
  stderr_meta: ExcerptMeta;
  exit_code: number | null;
  /** Always `null` in the session path: the shell reports a status, not a signal. */
  signal: null;
  encoding: ExcerptEncoding;
  duration_ms: number;
  background_job: boolean;
}

/**
 * Kill the children of the session shell after a timeout (OPT-2 step 8).
 * Returns false when `pkill` is missing, which makes the caller fail closed.
 */
async function reapChildren(record: SessionRecord): Promise<boolean> {
  if (record.shellPid === null) return false;
  const pid = String(record.shellPid);
  const budget = { timeoutMs: 5000, maxOutputBytes: 4096 };

  try {
    const term = await execOnce(record.conn, `pkill -TERM -P ${pid}`, budget);
    if (term.exit_code === 127) return false;
  } catch (err) {
    logger.debug('pkill -TERM failed', { session_id: record.id, error: errorMessage(err) });
    return false;
  }

  await delay(config.killGraceMs);
  try {
    await execOnce(record.conn, `pkill -KILL -P ${pid}`, budget);
  } catch (err) {
    logger.debug('pkill -KILL failed', { session_id: record.id, error: errorMessage(err) });
  }
  return true;
}

async function runCommand(
  record: SessionRecord,
  command: string,
  options: RunInSessionOptions
): Promise<SessionRunResult> {
  const started = Date.now();
  const stdout = createExcerptAccumulator({ cap: options.maxOutputBytes });
  const stderr = createExcerptAccumulator({ cap: options.maxOutputBytes });
  const frame = buildCommandFrame(command, {
    marker: record.marker,
    base64Flag: record.base64Flag,
    stdinGuard: record.stdinGuard,
  });

  touchConnection(record.alias);
  record.lastActivity = Date.now();

  let result: FrameWaitResult;
  try {
    result = await runFrame(record, frame, options.timeoutMs, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
  } catch (err) {
    record.lastActivity = Date.now();
    // The shell exited rather than overran its budget: there is nothing to
    // reap and nothing to ping, so report the death as it happened.
    if (isCodedError(err) && err.code === ERROR_CODES.session_terminated) {
      destroySession(record, 'terminated');
      throw err;
    }
    const reaped = await reapChildren(record);
    if (!reaped) {
      destroySession(record, 'terminated');
      throw new SshOperationError(
        ERROR_CODES.session_terminated,
        `command timed out and the remote children could not be cleaned up; session ${record.id} was destroyed`,
        { session_id: record.id, host: record.alias, timeout_ms: options.timeoutMs }
      );
    }

    try {
      await runFrame(record, buildPingFrame(record.marker), config.pingMs);
    } catch {
      destroySession(record, 'terminated');
      throw new SshOperationError(
        ERROR_CODES.session_terminated,
        `session ${record.id} stopped responding after a command timeout`,
        { session_id: record.id, host: record.alias, timeout_ms: options.timeoutMs }
      );
    }

    const out = stdout.finish();
    const errOut = stderr.finish();
    throw new SshOperationError(
      ERROR_CODES.command_timeout,
      `command exceeded its ${String(options.timeoutMs)} ms budget; the session is still usable`,
      {
        session_id: record.id,
        host: record.alias,
        timeout_ms: options.timeoutMs,
        duration_ms: Date.now() - started,
        partial_stdout: out.text,
        partial_stderr: errOut.text,
        stdout_meta: out.meta,
        stderr_meta: errOut.meta,
      }
    );
  }

  record.lastActivity = Date.now();
  const out = stdout.finish();
  const errOut = stderr.finish();

  return {
    session_id: record.id,
    stdout: out.text,
    stderr: errOut.text,
    stdout_meta: out.meta,
    stderr_meta: errOut.meta,
    exit_code: result.exitCode,
    signal: null,
    encoding:
      out.meta.encoding === 'base64' || errOut.meta.encoding === 'base64' ? 'base64' : 'utf8',
    duration_ms: Date.now() - started,
    background_job: hasTrailingBackground(command),
  };
}

/**
 * Run one command in an existing session (AC14, AC18).
 *
 * Calls on the same session are serialised: the channel carries one command at
 * a time, so a second caller waits rather than interleaving frames.
 */
export async function runInSession(
  sessionId: string,
  command: string,
  options: RunInSessionOptions
): Promise<SessionRunResult> {
  // `async` matters: a caller awaiting this must get a rejected promise for an
  // unknown or expired id, never a synchronous throw.
  const record = lookup(sessionId);

  const run = record.queue.then(async () => {
    // Re-check: the session may have been reaped while we waited our turn.
    lookup(sessionId);
    return runCommand(record, command, options);
  });

  record.queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Close a session by id (AC15). Unknown ids raise the same errors as a run. */
export function closeSession(sessionId: string): { session_id: string; host: string } {
  const record = lookup(sessionId);
  destroySession(record, 'closed');
  return { session_id: record.id, host: record.alias };
}

/**
 * What a session id currently means, without running anything.
 *
 * The tool layer needs three things before the approval gate: whether the id
 * is usable at all, which host it belongs to (the approval mode is per host),
 * and whether a dead id should be reported as `session_expired` or
 * `session_not_found`. Asking for that must not have side effects, which is
 * why this exists alongside {@link closeSession}.
 *
 * Tombstones fold in as follows: an idle-reaped session is `expired`, and a
 * session that was closed on request or lost with its channel is `unknown`,
 * carrying `reason` so the caller can still be specific. An id that was never
 * issued, or whose tombstone has aged out, is `unknown` with no reason.
 */
export function lookupSession(sessionId: string): SessionLookup {
  const record = sessions.get(sessionId);
  if (record !== undefined && !record.closed) {
    return { state: 'active', host: record.alias, detected_shell: record.shell };
  }

  const tombstone = tombstones.get(sessionId);
  if (tombstone === undefined) return { state: 'unknown' };
  if (tombstone.reason === 'expired') return { state: 'expired' };
  return { state: 'unknown', reason: tombstone.reason };
}

/** Read-only view of a live session, for `doctor` and tests. */
export function describeSession(sessionId: string): OpenSessionResult | null {
  const record = sessions.get(sessionId);
  if (record === undefined || record.closed) return null;
  return {
    session_id: record.id,
    host: record.alias,
    detected_shell: record.shell,
    shell_version: record.shellVersion,
    shell_flags: record.shellFlags,
    stdin_guard: record.stdinGuard,
    base64_mode: record.base64Flag === null ? 'literal' : 'base64',
  };
}
