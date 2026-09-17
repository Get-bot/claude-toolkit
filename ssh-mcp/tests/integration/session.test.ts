/**
 * Stateful sessions against a real shell (AC14, AC15, AC11.4, AC12.7, PM-2).
 *
 * The state assertions (`cd`, `export`) only mean something against a genuine
 * shell process, so the fixture bridges the `shell` channel to bash, dash or
 * zsh. `SHELL_UNDER_TEST` selects one; legs whose shell is not installed are
 * skipped rather than faked.
 *
 * WINDOWS-GAP: Git for Windows has no `pkill`, so the timeout path on Windows
 * only exercises "cleanup unavailable, destroy the session". The surviving
 * session branch is covered on the Linux legs (Critic C19).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';

import { isCodedError } from '../../src/errors.js';
import { closeAll, getConnection } from '../../src/ssh/pool.js';
import {
  MAX_SESSIONS_PER_HOST,
  closeSession,
  configureSessions,
  lookupSession,
  openSession,
  resetSessions,
  runInSession,
  sessionCount,
  stopReaper,
} from '../../src/ssh/session.js';
import {
  authorizeKeyOverSsh,
  currentEndpointKind,
  hostEntryFor,
  shellAvailable,
  shellUnderTest,
  startEndpoint,
  type StartEndpointOptions,
  type TestEndpoint,
} from '../fixtures/endpoints.js';
import { generateClientKey, type FixtureKeyPair } from '../fixtures/hostKeys.js';
import { resolved } from '../fixtures/resolved.js';
import { createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

const onFixture = currentEndpointKind() === 'fixture';
const SHELL = shellUnderTest();
const budget = { timeoutMs: 20000, maxOutputBytes: 1048576 };

/** 10 000 lines of 200 bytes, produced remotely (the §5.8 worked example). */
const TWO_MIB_COMMAND =
  'awk \'BEGIN{s=sprintf("%199s",""); gsub(/ /,"x",s); for(i=0;i<10000;i++) print s}\'';

let home: TmpHome;
let clientKey: FixtureKeyPair;

beforeAll(() => {
  // `openSession` records the detected shell in `state.json`; without a
  // sandbox home that would write into the developer's own `~/.ssh-mcp`.
  home = createTmpHome('ssh-mcp-session-');
  clientKey = generateClientKey();
});

afterAll(() => {
  home.cleanup();
});

interface Connected {
  endpoint: TestEndpoint;
  conn: Client;
  alias: string;
}

let open: Connected[] = [];

/**
 * Start an endpoint, authorise the test key and connect the pool to it.
 *
 * Every describe in this file goes through here, so this is the one place that
 * has to know the sshd tier installs its key over SSH rather than with `fs`
 * (A8, AC-T3a).
 */
async function connect(
  options: StartEndpointOptions = {},
  alias = 'session-host'
): Promise<Connected> {
  const endpoint = await startEndpoint(options);
  await authorizeKeyOverSsh(endpoint, clientKey.publicKey);
  const conn = await getConnection(
    hostEntryFor(endpoint, { alias }),
    Buffer.from(clientKey.privateKey, 'utf8')
  );
  const connected = { endpoint, conn, alias };
  open.push(connected);
  return connected;
}

afterEach(async () => {
  resetSessions();
  closeAll();
  for (const entry of open) await entry.endpoint.close();
  open = [];
  configureSessions({
    idleMs: 30 * 60 * 1000,
    tombstoneMs: 10 * 60 * 1000,
    reaperIntervalMs: 60 * 1000,
    maxSessionsPerHost: MAX_SESSIONS_PER_HOST,
  });
});

// FIXTURE-ONLY: `shell` (StartEndpointOptions) picks the bridged shell, and the
// sshd tier ignores it — the container's login shell is whatever `chsh` set. The
// leg below also asserts `detected_shell === 'bash'` for the bash run, which the
// real-sshd shell matrix would contradict on its dash and zsh steps.
describe.skipIf(!onFixture || !shellAvailable(SHELL))(`session state on ${SHELL}`, () => {
  it('reports the detected shell when opening (AC14.3)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);
    expect(session.session_id).toMatch(/^sess_[0-9a-f]+$/);
    expect(['bash', 'zsh', 'dash', 'ash']).toContain(session.detected_shell);
    if (SHELL === 'bash') {
      expect(session.detected_shell).toBe('bash');
      expect(session.shell_version).not.toBeNull();
    }
    expect(session.base64_mode).toBe('base64');
    expect(session.stdin_guard).toBe(true);
  });

  it('keeps the working directory across calls (AC14)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const host = hostEntryFor(endpoint, { alias });
    const session = await openSession(host, conn);

    await runInSession(session.session_id, resolved('mkdir -p sub/dir'), budget);
    const first = await runInSession(session.session_id, resolved('cd sub/dir && pwd'), budget);
    expect(first.exit_code).toBe(0);
    const second = await runInSession(session.session_id, resolved('pwd'), budget);
    expect(second.stdout.trim()).toBe(first.stdout.trim());
    expect(second.stdout.trim().endsWith('sub/dir')).toBe(true);
  });

  it('keeps exported variables across calls (AC14.1)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    await runInSession(session.session_id, resolved('export FOO=bar'), budget);
    const result = await runInSession(session.session_id, resolved('echo $FOO'), budget);
    expect(result.stdout).toBe('bar\n');
    expect(result.exit_code).toBe(0);
  });

  it('returns stdout, stderr and the status separately', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    // `(exit 3)` runs in a subshell: a bare `exit` would end the session
    // itself, which is what a shell is supposed to do (covered below).
    const result = await runInSession(
      session.session_id,
      resolved('echo O; echo E >&2; (exit 3)'),
      budget
    );
    expect(result.stdout).toBe('O\n');
    expect(result.stderr).toBe('E\n');
    expect(result.exit_code).toBe(3);
    expect(result.signal).toBeNull();
  });

  it('reports session_terminated when the command exits the shell', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    // `eval` runs in the session shell, so `exit` really does end it. The
    // caller must be told at once rather than waiting out the timeout.
    const started = Date.now();
    await expect(
      runInSession(session.session_id, resolved('exit 3'), { ...budget, timeoutMs: 15000 })
    ).rejects.toMatchObject({ code: 'session_terminated' });
    expect(Date.now() - started).toBeLessThan(10000);

    await expect(
      runInSession(session.session_id, resolved('echo x'), budget)
    ).rejects.toMatchObject({
      code: 'session_terminated',
    });
  });

  it('leaves stderr completely empty for a clean command (N3)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    const result = await runInSession(session.session_id, resolved('echo hi'), budget);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
    expect(result.stderr_meta.total_lines).toBe(0);
    expect(result.stderr_meta.total_bytes).toBe(0);
    expect(result.stdout_meta.total_lines).toBe(1);
    // No frame or handshake bytes leak into the response.
    expect(result.stdout).not.toContain('__SM_');
    expect(result.stderr).not.toContain('__SM_');
  });

  it('survives a command that reads stdin (F4, AC10.3)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    const cat = await runInSession(session.session_id, resolved('cat'), {
      ...budget,
      timeoutMs: 8000,
    });
    expect(cat.exit_code).toBe(0);
    expect(cat.stdout).toBe('');
    // The next frame must not have been swallowed by `cat`.
    const after = await runInSession(session.session_id, resolved('echo still-here'), budget);
    expect(after.stdout).toBe('still-here\n');
  });

  it('handles a quoted, multi-line command through base64 transport', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    const result = await runInSession(
      session.session_id,
      resolved('echo \'a;b\' # comment\necho "second"'),
      budget
    );
    expect(result.stdout).toBe('a;b\nsecond\n');
    expect(result.exit_code).toBe(0);
  });

  /**
   * A syntax error inside `eval` is where bash and dash genuinely differ.
   * bash (status 2) and zsh (status 1) report it and carry on, which is the
   * reason the frame uses `eval` instead of an inline `{ ... }`. dash and
   * busybox ash follow POSIX to the letter: a syntax error in a special
   * builtin ends a non-interactive shell. Both are handled — the caller is
   * told at once and the session state afterwards matches what it was told.
   *
   * The probe has to be a *parse* error in every supported shell, independent
   * of shell options: a stray `fi` with no `if` is one. `if then fi` is not
   * (zsh accepts empty `if` lists and exits 0), and `echo (` is a glob error
   * in zsh rather than a parse error, so `setopt noglob` in a login rc file
   * would turn it into a successful echo.
   */
  it('handles a syntax error without hanging or desynchronising', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    // Settle the outcome first and assert afterwards. An `expect` inside a
    // `try` is swallowed by its `catch`, which then reports the wrong error
    // type instead of the real assertion — that is how the zsh leg hid its
    // actual failure the first time this ran in CI.
    const outcome = await runInSession(session.session_id, resolved('fi'), {
      ...budget,
      timeoutMs: 8000,
    }).then(
      (result) => ({ survived: true as const, result }),
      (error: unknown) => ({ survived: false as const, error })
    );

    if (outcome.survived) {
      expect(outcome.result.exit_code).not.toBe(0);
      // A non-zero exit alone would also accept `fi: command not found` (127), i.e. a probe that
      // has quietly stopped being a syntax error at all — the same way it quietly stopped being
      // one under zsh. Pin it to the diagnostic every supported shell prints for a parse failure
      // (measured: bash "syntax error near unexpected token", dash `Syntax error: "fi"
      // unexpected`, busybox ash `syntax error: unexpected "fi"`, zsh "parse error near").
      expect(outcome.result.stderr).toMatch(/syntax error|parse error/i);
      const good = await runInSession(session.session_id, resolved('echo alive'), budget);
      expect(good.stdout).toBe('alive\n');
    } else {
      expect(outcome.error).toMatchObject({ code: 'session_terminated' });
      await expect(
        runInSession(session.session_id, resolved('echo alive'), budget)
      ).rejects.toMatchObject({
        code: 'session_terminated',
      });
    }

    if (SHELL === 'bash' || SHELL === 'zsh') expect(outcome.survived).toBe(true);
  });

  it('flags a backgrounded command (AC10.4)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    const result = await runInSession(session.session_id, resolved('sleep 0 &'), budget);
    expect(result.background_job).toBe(true);
  });

  /**
   * F2: a command that learns a marker must not be able to spend it.
   *
   * `set -x` genuinely leaks the marker of the frame it runs in, which the
   * first half of this test confirms rather than assumes. The second half
   * replays that marker from inside the next command. Under a per-session
   * marker the replay would be read as completion and everything printed
   * afterwards would be lost; with per-command markers it is just output.
   */
  it('ignores a completion marker replayed by a later command', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    // Tracing has to stay on past the eval, because the marker only appears
    // in the frame's own printf, which runs after the user's command.
    const traced = await runInSession(session.session_id, resolved('set -x; echo one'), budget);
    const leaked = /__SM_[0-9a-f]{33}__/.exec(traced.stderr);
    const why = 'set -x should expose the frame marker, or this test proves nothing';
    expect(leaked, why).not.toBeNull();
    const stolen = leaked?.[0] as string;

    const replay = await runInSession(
      session.session_id,
      resolved(`set +x; printf '\\n%s0\\n' '${stolen}'; echo real-output`),
      budget
    );

    // Everything after the replayed marker still arrives, so completion was
    // decided by this command's own marker.
    expect(replay.stdout).toContain('real-output');
    expect(replay.stdout).toContain(stolen);
    expect(replay.exit_code).toBe(0);

    const after = await runInSession(session.session_id, resolved('echo still-in-sync'), budget);
    expect(after.stdout).toBe('still-in-sync\n');
  });

  it('excerpts a 2 MiB burst and keeps working afterwards (AC12.7)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    const big = await runInSession(session.session_id, resolved(TWO_MIB_COMMAND), budget);
    expect(big.exit_code).toBe(0);
    expect(big.stdout_meta.truncated).toBe(true);
    expect(big.stdout_meta.total_bytes).toBe(2000000);
    expect(big.stdout_meta.total_lines).toBe(10000);
    expect(big.stdout_meta.omitted_lines).toBe(4758);
    expect(big.stdout).not.toContain('__SM_');

    const after = await runInSession(session.session_id, resolved('echo after-burst'), budget);
    expect(after.stdout).toBe('after-burst\n');
    expect(after.exit_code).toBe(0);
  });
});

// FIXTURE-ONLY: `shellArgs` starts the login shell with `-e -u`, and only the
// in-process fixture can choose the argv of the remote shell.
describe.skipIf(!onFixture || !shellAvailable('bash'))('inherited shell options (F5)', () => {
  it('neutralises set -e and set -u from the login shell', async () => {
    const { endpoint, conn, alias } = await connect({ shell: 'bash', shellArgs: ['-e', '-u'] });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    // With `set -e` still on, this first failure would kill the shell.
    const failing = await runInSession(session.session_id, resolved('false'), budget);
    expect(failing.exit_code).toBe(1);

    // With `set -u` still on, reading an unset variable would kill the shell.
    const unset = await runInSession(
      session.session_id,
      resolved('echo "[$UNSET_VARIABLE]"'),
      budget
    );
    expect(unset.stdout).toBe('[]\n');

    const alive = await runInSession(session.session_id, resolved('echo alive'), budget);
    expect(alive.stdout).toBe('alive\n');
  });
});

/**
 * The dash leg fixes the reason the preamble is only `set +e; set +u`.
 *
 * `set` is a POSIX special builtin, and an argument error in one terminates a
 * non-interactive shell — even inside `eval`. The plan illustrates that with
 * `set -o pipefail`, which older dash and busybox ash reject; dash 0.5.12 and
 * later (the build shipped with Git for Windows included) happen to support
 * that option, so the test drives the same fatal path with an option no dash
 * knows. The point being fixed is the mechanism, not one option name.
 *
 * FIXTURE-ONLY: `shell` pins dash for this describe alone, which the sshd tier
 * cannot do per-test — its login shell is set for the whole container by the
 * shell-matrix step that `chsh`-ed it.
 */
describe.skipIf(!onFixture || !shellAvailable('dash'))('dash preamble (AC14.4)', () => {
  it('opens a session on dash and runs commands', async () => {
    const { endpoint, conn, alias } = await connect({ shell: 'dash' });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);
    expect(session.detected_shell).toBe('dash');
    const result = await runInSession(session.session_id, resolved('echo dash-ok'), budget);
    expect(result.stdout).toBe('dash-ok\n');
    expect(result.exit_code).toBe(0);
  });

  it('dies when an unknown set option reaches it, which is why we send none', async () => {
    const { endpoint, conn, alias } = await connect({ shell: 'dash' });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    await expect(
      runInSession(session.session_id, resolved('set -o nosuchoption'), {
        ...budget,
        timeoutMs: 8000,
      })
    ).rejects.toMatchObject({ code: 'session_terminated' });

    await expect(
      runInSession(session.session_id, resolved('echo after'), { ...budget, timeoutMs: 8000 })
    ).rejects.toMatchObject({ code: 'session_terminated' });
  });
});

// FIXTURE-ONLY: `shellEmulation` fakes fish/cmd/powershell/silent logins. A real
// sshd can only offer shells that are installed, and installing a broken one to
// watch us refuse it would be staging the answer.
describe.skipIf(!onFixture)('unsupported shells (AC14.5, AC14.6, AC15.3, PM-2)', () => {
  it.each([
    ['fish', 'fish'],
    ['cmd', 'cmd'],
    ['powershell', 'powershell'],
  ] as const)('refuses a %s login shell', async (emulation, expected) => {
    const { endpoint, conn, alias } = await connect({ shellEmulation: emulation });
    try {
      await openSession(hostEntryFor(endpoint, { alias }), conn);
      expect.unreachable('a non-POSIX shell must not get a session');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) {
        expect(err.code).toBe('unsupported_shell');
        expect(err.details?.detected_shell).toBe(expected);
        expect(String(err.details?.alternatives)).toContain('exec');
      }
    }
    expect(sessionCount(alias)).toBe(0);
  });

  it('reports a silent shell as shell_incompatible (PM-2)', async () => {
    configureSessions({ shellProbeMs: 600 });
    const { endpoint, conn, alias } = await connect({ shellEmulation: 'silent' });
    await expect(openSession(hostEntryFor(endpoint, { alias }), conn)).rejects.toMatchObject({
      code: 'shell_incompatible',
    });
    expect(sessionCount(alias)).toBe(0);
    configureSessions({ shellProbeMs: 3000 });
  });

  it('does not consume a session slot on a refused handshake (AC15.3)', async () => {
    const { endpoint, conn, alias } = await connect({ shellEmulation: 'fish' });
    const host = hostEntryFor(endpoint, { alias });
    for (let attempt = 0; attempt < MAX_SESSIONS_PER_HOST + 2; attempt += 1) {
      await expect(openSession(host, conn)).rejects.toMatchObject({ code: 'unsupported_shell' });
    }
    expect(sessionCount(alias)).toBe(0);
  });
});

// Runs on both tiers (A9, AC-T3): nothing here needs the fixture's own shell,
// only a real one. `shellAvailable` asks about THIS machine's PATH, which is the
// right question for the bridged fixture and the wrong one for a container whose
// login shell the CI step already set, so it only gates the fixture tier.
describe.skipIf(onFixture && !shellAvailable(SHELL))('lifecycle (AC15)', () => {
  it('refuses the sixth session on one host (AC15.2)', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const host = hostEntryFor(endpoint, { alias });

    for (let i = 0; i < MAX_SESSIONS_PER_HOST; i += 1) {
      const session = await openSession(host, conn);
      expect(session.session_id).toBeTruthy();
    }
    expect(sessionCount(alias)).toBe(MAX_SESSIONS_PER_HOST);

    await expect(openSession(host, conn)).rejects.toMatchObject({
      code: 'session_limit_exceeded',
    });
  });

  it('frees a slot when a session is closed', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const host = hostEntryFor(endpoint, { alias });
    const session = await openSession(host, conn);
    expect(sessionCount(alias)).toBe(1);

    closeSession(session.session_id);
    expect(sessionCount(alias)).toBe(0);

    await expect(
      runInSession(session.session_id, resolved('echo x'), budget)
    ).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('expires an idle session and says so (AC15.1)', async () => {
    configureSessions({ idleMs: 1000, reaperIntervalMs: 200, tombstoneMs: 60000 });
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(sessionCount(alias)).toBe(0);

    try {
      await runInSession(session.session_id, resolved('echo x'), budget);
      expect.unreachable('an expired session must not run commands');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) {
        expect(err.code).toBe('session_expired');
        expect(err.details?.reason).toBe('expired');
      }
    }
  });

  it('forgets a tombstone once it ages out', async () => {
    configureSessions({ idleMs: 500, reaperIntervalMs: 150, tombstoneMs: 600 });
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await expect(
      runInSession(session.session_id, resolved('echo x'), budget)
    ).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('reports an unknown session id as not found', async () => {
    await expect(runInSession('sess_deadbeef', resolved('echo x'), budget)).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  /**
   * The tool layer reads this before the approval gate, so it has to answer
   * without side effects and has to distinguish the ways an id can be dead.
   */
  describe('lookupSession', () => {
    it('describes a live session and its host', async () => {
      const { endpoint, conn, alias } = await connect({ shell: SHELL });
      const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

      const found = lookupSession(session.session_id);
      expect(found.state).toBe('active');
      if (found.state === 'active') {
        expect(found.host).toBe(alias);
        expect(found.detected_shell).toBe(session.detected_shell);
      }
      // Reading must not consume the session.
      expect(sessionCount(alias)).toBe(1);
      expect(lookupSession(session.session_id).state).toBe('active');
    });

    it('marks an id closed on request as unknown with a reason', async () => {
      const { endpoint, conn, alias } = await connect({ shell: SHELL });
      const session = await openSession(hostEntryFor(endpoint, { alias }), conn);
      closeSession(session.session_id);

      const found = lookupSession(session.session_id);
      expect(found.state).toBe('unknown');
      if (found.state === 'unknown') expect(found.reason).toBe('closed');
    });

    it('marks an idle-reaped id as expired', async () => {
      configureSessions({ idleMs: 800, reaperIntervalMs: 150, tombstoneMs: 60000 });
      const { endpoint, conn, alias } = await connect({ shell: SHELL });
      const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(lookupSession(session.session_id).state).toBe('expired');
    });

    it('marks a session whose shell exited as terminated', async () => {
      const { endpoint, conn, alias } = await connect({ shell: SHELL });
      const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

      await expect(
        runInSession(session.session_id, resolved('exit 0'), { ...budget, timeoutMs: 15000 })
      ).rejects.toMatchObject({ code: 'session_terminated' });

      const found = lookupSession(session.session_id);
      expect(found.state).toBe('unknown');
      if (found.state === 'unknown') expect(found.reason).toBe('terminated');
    });

    it('reports an id that was never issued as unknown with no reason', () => {
      const found = lookupSession('sess_never_issued');
      expect(found.state).toBe('unknown');
      if (found.state === 'unknown') expect(found.reason).toBeUndefined();
    });
  });

  it('releases the reaper timer', () => {
    stopReaper();
    expect(sessionCount()).toBe(0);
  });
});

// Runs on both tiers (A9, AC-T3). This is where the sshd tier earns its keep:
// the surviving-session branch needs a real `pkill` reaping a real child, which
// is why the image installs `procps`.
describe.skipIf(onFixture && !shellAvailable(SHELL))('command timeout (AC11.4)', () => {
  it('ends with a precise error and never leaves the session half-alive', async () => {
    const { endpoint, conn, alias } = await connect({ shell: SHELL });
    const session = await openSession(hostEntryFor(endpoint, { alias }), conn);

    let code = '';
    try {
      await runInSession(session.session_id, resolved('sleep 30'), { ...budget, timeoutMs: 1500 });
      expect.unreachable('the command should have timed out');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) code = err.code;
    }
    // WINDOWS-GAP: without `pkill` the only safe outcome is to destroy the
    // session; where it exists the session survives and stays usable.
    expect(['command_timeout', 'session_terminated']).toContain(code);

    if (code === 'command_timeout') {
      const after = await runInSession(session.session_id, resolved('echo alive'), budget);
      expect(after.stdout).toBe('alive\n');
    } else {
      await expect(
        runInSession(session.session_id, resolved('echo alive'), budget)
      ).rejects.toMatchObject({
        code: 'session_terminated',
      });
    }
  });
});
