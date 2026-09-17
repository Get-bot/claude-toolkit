/**
 * `exec` transport framing and timeout cleanup (step A12, ADR-018, AC-T4
 * "타임아웃 후 원격 프로세스 정리").
 *
 * `exec.test.ts` owns the AC10-AC12 behaviour of one-shot execution. This file
 * owns the thing that behaviour now rides on: the command is wrapped so the
 * remote shell reports its pid, and a timeout kills that pid instead of
 * politely asking a channel to go away. Two claims need a live endpoint, and
 * the tiers split them:
 *
 * - *The frame is invisible.* Every stream, counter and code has to come back
 *   exactly as it did before the wrapper existed. The in-process fixture can
 *   prove that, and it alone can prove the other half — that the wrapper really
 *   is what went over the wire, and that a non-POSIX remote gets the bare
 *   command — because only it records the command string sshd received.
 * - *The process is actually gone.* Only a real process table can show that, so
 *   it runs on `ENDPOINT=sshd`, and on a POSIX `fixture` host where the bridged
 *   shell is a real local process tree. Windows is skipped: Git for Windows
 *   ships no `pgrep`, so there is nothing there to ask.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';

import { isCodedError } from '../../src/errors.js';
import { execOnce } from '../../src/ssh/exec.js';
import { buildExecFrame, configureExecFraming } from '../../src/ssh/execWrapper.js';
import { SHELL_PROBE_COMMAND } from '../../src/ssh/shellDetect.js';
import { closeAll, closeConnection, getConnection } from '../../src/ssh/pool.js';
import {
  authorizeKeyOverSsh,
  currentEndpointKind,
  hostEntryFor,
  startEndpoint,
  type TestEndpoint,
} from '../fixtures/endpoints.js';
import { generateClientKey, type FixtureKeyPair } from '../fixtures/hostKeys.js';

let endpoint: TestEndpoint;
let clientKey: FixtureKeyPair;
let conn: Client;

const budget = { timeoutMs: 20000, maxOutputBytes: 1048576 };

/** A sleep nothing else in the suite uses, so `pgrep` can only find ours. */
const MARKER_SLEEP = 'sleep 41';

beforeAll(async () => {
  endpoint = await startEndpoint();
  clientKey = generateClientKey();
  await authorizeKeyOverSsh(endpoint, clientKey.publicKey);
  conn = await getConnection(hostEntryFor(endpoint), Buffer.from(clientKey.privateKey, 'utf8'));
  // The shell probe runs once per connection and would otherwise land in the
  // middle of whichever assertion happened to come first.
  await execOnce(conn, 'echo warm', budget);
});

afterAll(async () => {
  configureExecFraming({ mode: 'auto' });
  closeAll();
  await endpoint.close();
});

const onFixture = currentEndpointKind() === 'fixture';
const onSshd = currentEndpointKind() === 'sshd';
// A real process table on both sides of the connection. The fixture bridges
// `exec` to a local child, so on Linux and macOS its "remote" processes are
// just as visible as a container's.
const canReadProcessTable = onSshd || (onFixture && process.platform !== 'win32');

describe('framing is what goes over the wire', () => {
  it.runIf(onFixture)('wraps the command and strips the pid line back off', async () => {
    const before = endpoint.fixture?.eventsOfType('exec').length ?? 0;
    const result = await execOnce(conn, 'echo hi', budget);

    expect(result.stdout).toBe('hi\n');
    const sent = (endpoint.fixture?.eventsOfType('exec') ?? []).slice(before).map((e) => e.command);
    expect(sent).toEqual([buildExecFrame('echo hi')]);
  });

  it.runIf(onFixture)('sends the bare command when framing is off', async () => {
    configureExecFraming({ mode: 'off' });
    try {
      const before = endpoint.fixture?.eventsOfType('exec').length ?? 0;
      const result = await execOnce(conn, 'echo hi', budget);

      expect(result.stdout).toBe('hi\n');
      const sent = (endpoint.fixture?.eventsOfType('exec') ?? [])
        .slice(before)
        .map((e) => e.command);
      expect(sent).toEqual(['echo hi']);
    } finally {
      configureExecFraming({ mode: 'auto' });
    }
  });

  // The frame is POSIX shell. `exec` is also what `SHELL_ALTERNATIVES` tells a
  // cmd.exe or PowerShell user to fall back to, so framing one would take away
  // the last thing that worked there.
  it.runIf(onFixture)('does not frame a remote whose shell is not POSIX', async () => {
    const alias = 'cmd-remote';
    // cmd.exe leaves `$0` untouched, which is exactly how the probe knows it.
    const cmdEndpoint = await startEndpoint({
      scripted: { [SHELL_PROBE_COMMAND]: { stdout: '__SM_SH__$0__\n' } },
    });
    try {
      await authorizeKeyOverSsh(cmdEndpoint, clientKey.publicKey);
      const cmdConn = await getConnection(
        hostEntryFor(cmdEndpoint, { alias }),
        Buffer.from(clientKey.privateKey, 'utf8')
      );
      const result = await execOnce(cmdConn, 'echo hi', budget);

      expect(result.stdout).toBe('hi\n');
      const sent = (cmdEndpoint.fixture?.eventsOfType('exec') ?? []).map((e) => e.command);
      expect(sent).toEqual([SHELL_PROBE_COMMAND, 'echo hi']);
    } finally {
      closeConnection(alias);
      await cmdEndpoint.close();
    }
  });
});

describe('the frame changes nothing a caller can see', () => {
  it('keeps the streams, the exit code and the signal apart (AC10.1)', async () => {
    const result = await execOnce(conn, "sh -c 'echo O; echo E >&2; exit 3'", budget);
    expect(result.stdout).toBe('O\n');
    expect(result.stderr).toBe('E\n');
    expect(result.exit_code).toBe(3);
    expect(result.signal).toBeNull();
  });

  it('keeps binary stdout byte-exact, pid line and all (AC10.2)', async () => {
    const result = await execOnce(conn, "printf 'A\\x00\\xff\\xfeB'", budget);
    expect(result.encoding).toBe('base64');
    expect(Array.from(Buffer.from(result.stdout, 'base64'))).toEqual([
      0x41, 0x00, 0xff, 0xfe, 0x42,
    ]);
    expect(result.stdout_meta.total_bytes).toBe(5);
  });

  it('counts only the command’s own output (AC12)', async () => {
    const result = await execOnce(conn, 'printf "a\\nb\\nc\\n"', budget);
    expect(result.stdout).toBe('a\nb\nc\n');
    expect(result.stdout_meta.total_lines).toBe(3);
    expect(result.stdout_meta.total_bytes).toBe(6);
    expect(result.stdout_meta.truncated).toBe(false);
  });

  it('still returns at once when the command reads stdin (AC10.3)', async () => {
    const result = await execOnce(conn, 'cat', { ...budget, timeoutMs: 5000 });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('still flags a backgrounded command (AC10.4)', async () => {
    const result = await execOnce(conn, 'sleep 0 &', budget);
    expect(result.background_job).toBe(true);
  });
});

describe('timeout cleanup (AC11, AC-T4)', () => {
  it('reports the timeout and what it did about the remote process', async () => {
    try {
      await execOnce(conn, `${MARKER_SLEEP} && echo never`, { ...budget, timeoutMs: 1000 });
      expect.unreachable('the command should have timed out');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (!isCodedError(err)) return;
      expect(err.code).toBe('command_timeout');
      const cleanup = err.details?.remote_cleanup as Record<string, unknown> | undefined;
      expect(cleanup?.framed).toBe(true);
      expect(typeof cleanup?.remote_pid).toBe('number');
      expect(cleanup?.remote_pid).toBeGreaterThan(0);
      // Fail-closed: the reaper reports what happened instead of swallowing it.
      expect(cleanup?.reaped).toBe(true);
      expect(cleanup?.error).toBeNull();
    }
  });

  it('keeps the partial output the command had already produced', async () => {
    try {
      await execOnce(conn, `echo early; ${MARKER_SLEEP}`, { ...budget, timeoutMs: 1000 });
      expect.unreachable('the command should have timed out');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (!isCodedError(err)) return;
      // The pid line came off this too: `early` is the whole of stdout.
      expect(err.details?.partial_stdout).toBe('early\n');
    }
  });

  // Unframed is the old behaviour in full, cleanup included: nothing is
  // reaped, because nothing said which process to reap. The sleep here is
  // deliberately short and deliberately not the marker one — it survives this
  // call, which is the point, and it has to expire on its own before it could
  // be mistaken for the next test's survivor.
  it.runIf(onFixture)('has nothing to reap when framing is off', async () => {
    configureExecFraming({ mode: 'off' });
    try {
      await execOnce(conn, 'sleep 3', { ...budget, timeoutMs: 500 });
      expect.unreachable('the command should have timed out');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (!isCodedError(err)) return;
      expect(err.code).toBe('command_timeout');
      const cleanup = err.details?.remote_cleanup as Record<string, unknown> | undefined;
      expect(cleanup?.framed).toBe(false);
      expect(cleanup?.remote_pid).toBeNull();
      expect(cleanup?.reaped).toBe(false);
      expect(cleanup?.error).toBeNull();
    } finally {
      configureExecFraming({ mode: 'auto' });
    }
  });

  // The defect this step exists for: measured against the real OpenSSH
  // container, `sleep 37` survived its timeout by more than six seconds
  // because sshd ignores the channel signal and closing a pty-less exec
  // channel does not kill the child.
  it.runIf(canReadProcessTable)('leaves no process behind (AC-T4)', async () => {
    const survivors = async (): Promise<string> => {
      const found = await execOnce(conn, `pgrep -f '[s]leep 41' || true`, budget);
      return found.stdout.trim();
    };

    expect(await survivors()).toBe('');

    await expect(
      execOnce(conn, MARKER_SLEEP, { ...budget, timeoutMs: 1500 })
    ).rejects.toMatchObject({ code: 'command_timeout' });

    // SIGKILL is delivered, not awaited; a moment is enough for the process
    // table to catch up, and the old behaviour failed this by seconds.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await survivors()).toBe('');
  });
});
