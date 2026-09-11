/**
 * One-shot `exec` against a live SSH endpoint (AC10, AC11, AC12).
 *
 * The endpoint is parameterised: `ENDPOINT=fixture` (default) runs the
 * in-process ssh2 server with a real shell behind it, `ENDPOINT=sshd` runs the
 * same bodies against a real OpenSSH server. Assertions that need to observe
 * the server side are marked `runIf(fixture)`; assertions that need real
 * process cleanup are marked `runIf(sshd)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';

import { isCodedError } from '../../src/errors.js';
import { execOnce, hasTrailingBackground } from '../../src/ssh/exec.js';
import {
  closeAll,
  closeConnection,
  configurePool,
  getConnection,
  hasConnection,
} from '../../src/ssh/pool.js';
import {
  authorizeKey,
  currentEndpointKind,
  hostEntryFor,
  startEndpoint,
  type TestEndpoint,
} from '../fixtures/endpoints.js';
import { generateClientKey, type FixtureKeyPair } from '../fixtures/hostKeys.js';

/** 10 000 lines of 200 bytes: the §5.8 worked example, produced remotely. */
const TWO_MIB_COMMAND =
  'awk \'BEGIN{s=sprintf("%199s",""); gsub(/ /,"x",s); for(i=0;i<10000;i++) print s}\'';

let endpoint: TestEndpoint;
let clientKey: FixtureKeyPair;
let conn: Client;

const budget = { timeoutMs: 20000, maxOutputBytes: 1048576 };

beforeAll(async () => {
  endpoint = await startEndpoint();
  clientKey = generateClientKey();
  authorizeKey(endpoint, clientKey.publicKey);
  conn = await getConnection(hostEntryFor(endpoint), Buffer.from(clientKey.privateKey, 'utf8'));
});

afterAll(async () => {
  closeAll();
  await endpoint.close();
});

// Decided from the environment rather than from the started endpoint: vitest
// evaluates `runIf` while collecting, before `beforeAll` has run.
const onFixture = currentEndpointKind() === 'fixture';
const onSshd = currentEndpointKind() === 'sshd';

describe('stream separation (AC10.1)', () => {
  it('returns stdout, stderr and the exit code separately', async () => {
    const result = await execOnce(conn, "sh -c 'echo O; echo E >&2; exit 3'", budget);
    expect(result.stdout).toBe('O\n');
    expect(result.stderr).toBe('E\n');
    expect(result.exit_code).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.encoding).toBe('utf8');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a zero exit code for a successful command', async () => {
    const result = await execOnce(conn, 'echo hi', budget);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stderr_meta.total_lines).toBe(0);
    expect(result.stderr_meta.total_bytes).toBe(0);
  });

  it('keeps a non-zero exit code from a failing command', async () => {
    const result = await execOnce(conn, 'exit 42', budget);
    expect(result.exit_code).toBe(42);
  });
});

describe('binary output (AC10.2)', () => {
  it('returns base64 when the stream is not valid UTF-8', async () => {
    const result = await execOnce(conn, "printf 'A\\x00\\xff\\xfeB'", budget);
    expect(result.stdout_meta.encoding).toBe('base64');
    expect(result.encoding).toBe('base64');
    const decoded = Buffer.from(result.stdout, 'base64');
    expect(Array.from(decoded)).toEqual([0x41, 0x00, 0xff, 0xfe, 0x42]);
  });

  it('stays utf8 for multi-byte text', async () => {
    const result = await execOnce(conn, "printf '한국어\\n'", budget);
    expect(result.stdout_meta.encoding).toBe('utf8');
    expect(result.stdout).toBe('한국어\n');
  });
});

describe('stdin is always closed (AC10.3)', () => {
  it('returns immediately from cat with no arguments', async () => {
    const started = Date.now();
    const result = await execOnce(conn, 'cat', { ...budget, timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns immediately from a pipeline that reads stdin', async () => {
    const result = await execOnce(conn, 'cat | wc -c', { ...budget, timeoutMs: 5000 });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  });
});

describe('background jobs (AC10.4)', () => {
  it('flags a trailing ampersand on the result', async () => {
    const result = await execOnce(conn, 'sleep 0 &', budget);
    expect(result.background_job).toBe(true);
  });

  it('does not flag a plain command or a logical and', async () => {
    const plain = await execOnce(conn, 'echo one', budget);
    expect(plain.background_job).toBe(false);
    expect(hasTrailingBackground('a && b')).toBe(false);
    expect(hasTrailingBackground('a &')).toBe(true);
  });
});

describe('timeout (AC11)', () => {
  it('fails with command_timeout well before the command would finish', async () => {
    const started = Date.now();
    await expect(
      execOnce(conn, 'sleep 30', { ...budget, timeoutMs: 1500 })
    ).rejects.toMatchObject({ code: 'command_timeout' });
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('attaches the partial output to the error', async () => {
    try {
      await execOnce(conn, 'echo early; sleep 30', { ...budget, timeoutMs: 1500 });
      expect.unreachable('the command should have timed out');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) {
        expect(err.code).toBe('command_timeout');
        expect(err.details?.partial_stdout).toBe('early\n');
        expect(err.details?.timeout_ms).toBe(1500);
      }
    }
  });

  it.runIf(onFixture)('closes the channel on the server side (AC11.2)', async () => {
    const before = endpoint.fixture?.eventsOfType('channel-close').length ?? 0;
    await expect(
      execOnce(conn, 'sleep 30', { ...budget, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'command_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = endpoint.fixture?.eventsOfType('channel-close').length ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  // WINDOWS-GAP: proving the remote process really died needs a real sshd;
  // the in-process fixture can only show the channel was closed (Critic C19).
  it.runIf(onSshd)('leaves no process behind (AC11.3)', async () => {
    await expect(
      execOnce(conn, 'sleep 37', { ...budget, timeoutMs: 1500 })
    ).rejects.toMatchObject({ code: 'command_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const check = await execOnce(conn, "pgrep -f 'sleep 37' || true", budget);
    expect(check.stdout.trim()).toBe('');
  });
});

describe('output excerpting through the exec path (AC12)', () => {
  it('reproduces the §5.8 worked example over the wire', async () => {
    const result = await execOnce(conn, TWO_MIB_COMMAND, budget);
    expect(result.exit_code).toBe(0);
    expect(result.stdout_meta.total_bytes).toBe(2000000);
    expect(result.stdout_meta.total_lines).toBe(10000);
    expect(result.stdout_meta.truncated).toBe(true);
    expect(result.stdout_meta.head_bytes).toBe(419400);
    expect(result.stdout_meta.head_lines).toBe(2097);
    expect(result.stdout_meta.tail_bytes).toBe(629000);
    expect(result.stdout_meta.tail_lines).toBe(3145);
    expect(result.stdout_meta.omitted_lines).toBe(4758);
    expect(result.stdout_meta.omitted_bytes).toBe(951600);
    expect(result.stdout_meta.returned_bytes).toBe(1048400);
    expect(result.stdout_meta.output_ref).toBeNull();
  });

  it('excerpts stderr independently of stdout (AC12.6)', async () => {
    const result = await execOnce(conn, `${TWO_MIB_COMMAND} 1>&2; echo short`, budget);
    expect(result.stdout).toBe('short\n');
    expect(result.stdout_meta.truncated).toBe(false);
    expect(result.stdout_meta.omitted_lines).toBe(0);
    expect(result.stderr_meta.truncated).toBe(true);
    expect(result.stderr_meta.total_lines).toBe(10000);
  });

  it('leaves output under the cap untouched (AC12.5)', async () => {
    const result = await execOnce(conn, 'printf "a\\nb\\nc\\n"', budget);
    expect(result.stdout).toBe('a\nb\nc\n');
    expect(result.stdout_meta.truncated).toBe(false);
    expect(result.stdout_meta.total_lines).toBe(3);
    expect(result.stdout_meta.omitted_lines).toBe(0);
    expect(result.stdout).not.toContain('[ssh-mcp]');
  });

  it('honours a smaller per-host cap', async () => {
    const result = await execOnce(conn, TWO_MIB_COMMAND, {
      ...budget,
      maxOutputBytes: 65536,
    });
    expect(result.stdout_meta.truncated).toBe(true);
    expect(result.stdout_meta.returned_bytes).toBeLessThanOrEqual(65536);
    expect(result.stdout_meta.total_lines).toBe(10000);
  });
});

describe('connection pool', () => {
  it('runs several commands over one pooled connection', async () => {
    const first = await execOnce(conn, 'echo one', budget);
    const second = await execOnce(conn, 'echo two', budget);
    expect(first.stdout).toBe('one\n');
    expect(second.stdout).toBe('two\n');
  });

  it('hands the same client back for the same alias', async () => {
    const key = Buffer.from(clientKey.privateKey, 'utf8');
    const again = await getConnection(hostEntryFor(endpoint), key);
    expect(again).toBe(conn);
  });

  it('closes a connection once it has been idle', async () => {
    const alias = 'idle-host';
    const host = hostEntryFor(endpoint, { alias });
    const key = Buffer.from(clientKey.privateKey, 'utf8');
    configurePool({ idleMs: 400 });
    try {
      const idle = await getConnection(host, key);
      expect(hasConnection(alias)).toBe(true);
      expect((await execOnce(idle, 'echo before-idle', budget)).stdout).toBe('before-idle\n');

      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(hasConnection(alias)).toBe(false);

      // A later call reconnects rather than handing back the dead client.
      const fresh = await getConnection(host, key);
      expect(fresh).not.toBe(idle);
      expect((await execOnce(fresh, 'echo after-idle', budget)).stdout).toBe('after-idle\n');
    } finally {
      configurePool({ idleMs: 10 * 60 * 1000 });
      closeConnection(alias);
    }
  });

  it('refuses a host whose key does not match the pin (AC9.1)', async () => {
    const alias = 'wrong-pin';
    const host = hostEntryFor(endpoint, {
      alias,
      hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const execsBefore = endpoint.fixture?.eventsOfType('exec').length ?? 0;

    try {
      await getConnection(host, Buffer.from(clientKey.privateKey, 'utf8'));
      expect.unreachable('a mismatched host key must not connect');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) {
        expect(err.code).toBe('host_key_mismatch');
        expect(err.details?.expected_fingerprint).toBe(host.hostKey.sha256);
        expect(err.details?.actual_fingerprint).toBe(endpoint.hostKeyFingerprint);
      }
    }
    expect(hasConnection(alias)).toBe(false);
    // AC9.2: the handshake failed, so no command could have been sent.
    expect(endpoint.fixture?.eventsOfType('exec').length ?? 0).toBe(execsBefore);
  });

  it.runIf(onFixture)('never requests a pty (AC10 stream separation)', () => {
    expect(endpoint.fixture?.eventsOfType('pty')).toHaveLength(0);
  });
});
