/**
 * End-to-end `ssh-mcp setup` against a live SSH endpoint
 * (plan rows 5.1-5.9, AC7, AC8, AC9, AC17.12, AC19.1, AC19.2).
 *
 * The flow is driven programmatically: a scripted stream answers the password,
 * the host-key confirmation and the forced approval-fallback choice, so the
 * assertions cover the real network path - key generation, remote
 * `authorized_keys` install, key-only reconnect and the atomic registry write.
 *
 * `startEndpoint()` decides which tier answers: the in-process ssh2 fixture by
 * default, a real OpenSSH container when `ENDPOINT=sshd`. The protocol-level
 * assertions (AC8.1, AC9.2) read the fixture's event log and therefore only run
 * on the tier that has one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  homePath,
  hostsFilePath,
  keysDirPath,
  privateKeyPath,
  publicKeyPath,
} from '../../src/config/paths.js';
import * as store from '../../src/config/store.js';
import { buildChecks, runChecks } from '../../src/doctor/checks.js';
import { installAuthorizedKey } from '../../src/setup/install.js';
import { createPrompter } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';
import { defaultConnector, parseSetupArgs, parseTarget, runSetup } from '../../src/setup/cli.js';
import { currentWindowsPrincipal } from '../../src/setup/winacl.js';
import type { IcaclsRunner } from '../../src/setup/winacl.js';
import { startEndpoint } from '../fixtures/endpoints.js';
import type { TestEndpoint } from '../fixtures/endpoints.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

/** The sentinel of AC19.1: it must not appear anywhere in captured output. */
const SENTINEL_PASSWORD = 'P@ssw0rd-SENTINEL-9f3a';
const PEM_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';

interface Script {
  prompter: Prompter;
  output(): string;
}

/**
 * A prompter that pretends to be a terminal and replays `answers` in order.
 * Every answer is written up front; `Prompter` keeps the unread remainder, so
 * one stream can serve the whole flow.
 */
function scripted(answers: readonly string[]): Script {
  const input = new PassThrough();
  const fake = input as unknown as { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  fake.setRawMode = (): void => undefined;
  fake.isTTY = true;

  let written = '';
  const prompter = createPrompter({
    input: input as never,
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    isTTY: true,
  });
  input.write(answers.map((answer) => `${answer}\n`).join(''));
  return { prompter, output: () => written };
}

function failingIcacls(): IcaclsRunner {
  return () => ({ status: 1, stdout: '', stderr: 'Access is denied.' });
}

/**
 * An `icacls` runner reporting an already-restricted directory.
 *
 * The sandbox home is a fresh temp directory, so on Windows it still inherits
 * `BUILTIN\Administrators`. Real hardening would succeed here, but these tests
 * are about ordering rather than about the ACL itself, so the reader is fed a
 * clean answer and the assertions stay on which directory was hardened when.
 */
function stubIcacls(): IcaclsRunner {
  return (args) => {
    const target = args[0] ?? '';
    const crlf = String.fromCharCode(13, 10);
    return {
      status: 0,
      stdout:
        `${target} ${currentWindowsPrincipal()}:(OI)(CI)(F)` +
        crlf +
        crlf +
        'Successfully processed 1 files; Failed processing 0 files' +
        crlf,
      stderr: '',
    };
  };
}

/**
 * Where `setup` installs the public key: the REMOTE side.
 *
 * `remoteHomeDir` rather than the older `homeDir`, which now aliases the local
 * sandbox. On the fixture tier the two are the same directory, so the
 * distinction only bites under `ENDPOINT=sshd`, where this would otherwise
 * count lines in a local temp directory the server never touched.
 */
function authorizedKeysPath(endpoint: TestEndpoint): string {
  return path.join(endpoint.remoteHomeDir, '.ssh', 'authorized_keys');
}

/**
 * How many times `line` appears in the remote `authorized_keys` — FIXTURE-ONLY.
 *
 * It reads the file with local `fs`, which is only the remote file on the tier
 * whose server runs in this process. On the sshd tier the same path names a
 * directory inside the container, so callers gate this on `endpoint.fixture`.
 * Idempotence is still proved there, by `installAuthorizedKey` reporting
 * `alreadyPresent` — a fact the remote script computed, not one we read.
 */
function countKeyLine(endpoint: TestEndpoint, line: string): number {
  const file = authorizedKeysPath(endpoint);
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text === line.trim()).length;
}

/**
 * Key and registry artefacts that must never appear in the package root.
 * Guards the working directory the way `assertNoWritesOutside` guards the real
 * home: the whole setup flow writes through `paths.ts` and nothing else.
 */
const ARTIFACT_PATTERN = /\.pub$|^hosts\.json$|^state\.json$|^audit\.jsonl/;

function cwdArtifacts(): string[] {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => ARTIFACT_PATTERN.test(name))
    .sort();
}

/**
 * Poll until `predicate` holds or the deadline passes.
 *
 * The server side of an aborted handshake is recorded a tick or two after the
 * client has already given up, so asserting on it straight after `runSetup`
 * returns is a race.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function loadEntry(alias: string) {
  const loaded = store.load();
  if (!loaded.ok) throw new Error(`hosts.json did not load: ${loaded.message}`);
  return loaded.file.hosts[alias];
}

describe('setup against a live endpoint', () => {
  let endpoint: TestEndpoint;
  let home: TmpHome;

  beforeAll(async () => {
    endpoint = await startEndpoint({ password: SENTINEL_PASSWORD });
  });

  afterAll(async () => {
    await endpoint?.close();
  });

  let artifactsBefore: string[] = [];

  beforeEach(() => {
    artifactsBefore = cwdArtifacts();
    home = createTmpHome('ssh-mcp-auth-');
  });

  afterEach(() => {
    assertNoWritesOutside(home);
    const leaked = cwdArtifacts().filter((name) => !artifactsBefore.includes(name));
    home.cleanup();
    expect(leaked, `setup wrote key material into ${process.cwd()}`).toEqual([]);
  });

  function target(): string {
    return `${endpoint.user}@${endpoint.host}:${String(endpoint.port)}`;
  }

  it('completes the flow and records the host (AC7, AC8, AC19)', async () => {
    const script = scripted([endpoint.password, 'yes', 'token']);

    const code = await runSetup(['prod', target()], { prompter: script.prompter });

    expect(code).toBe(0);

    // AC7.1: both halves of the key pair exist, private key in OpenSSH format.
    expect(fs.readFileSync(privateKeyPath('prod'), 'utf8').startsWith(PEM_HEADER)).toBe(true);
    const publicKeyLine = fs.readFileSync(publicKeyPath('prod'), 'utf8').trim();

    // AC7.3: exactly one copy of our key on the remote side.
    if (endpoint.fixture !== undefined) expect(countKeyLine(endpoint, publicKeyLine)).toBe(1);

    // AC7.4 and AC7.6: pinned fingerprint and a recorded approval fallback.
    const entry = loadEntry('prod');
    expect(entry).toBeDefined();
    expect(entry?.hostKey.sha256).toBe(endpoint.hostKeyFingerprint);
    expect(entry?.hostKey.sha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(entry?.approvalFallback).toBe('token');
    expect(entry?.approvalMode).toBe('ask-destructive');
    expect(entry?.privateKeyPath).toBe(privateKeyPath('prod'));

    // AC19.1 and AC19.2: neither the password nor key material was printed.
    expect(script.output()).not.toContain(SENTINEL_PASSWORD);
    expect(script.output()).not.toContain(PEM_HEADER);
    // The fingerprint and the registration snippets are printed, though.
    expect(script.output()).toContain(endpoint.hostKeyFingerprint);
    expect(script.output()).toContain('claude mcp add ssh-mcp');
  });

  it('authenticates with the key alone afterwards (AC8, AC8.1)', async () => {
    const script = scripted([endpoint.password, 'yes', 'fail-closed']);
    expect(await runSetup(['keyonly', target()], { prompter: script.prompter })).toBe(0);

    const entry = loadEntry('keyonly');
    expect(entry).toBeDefined();

    const before = endpoint.fixture?.eventsOfType('auth').length ?? 0;
    const client = await defaultConnector({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.user,
      privateKey: fs.readFileSync(privateKeyPath('keyonly')),
      authMethods: ['publickey'],
      readyTimeoutMs: 10_000,
      hostVerifier: (_key, verify) => {
        verify(true);
      },
    });
    client.end();

    // AC8.1: the key-only connection offered publickey and nothing else.
    const methods = (endpoint.fixture?.eventsOfType('auth') ?? [])
      .slice(before)
      .map((event) => event.method);
    if (endpoint.fixture !== undefined) {
      expect(methods.length).toBeGreaterThan(0);
      expect(methods).not.toContain('password');
      expect(new Set(methods)).toEqual(new Set(['publickey']));
    }
  });

  it('honours --approval-fallback without asking (AC17.12b)', async () => {
    const script = scripted([endpoint.password, 'yes']);

    const code = await runSetup(['flagged', target(), '--approval-fallback', 'fail-closed'], {
      prompter: script.prompter,
    });

    expect(code).toBe(0);
    expect(loadEntry('flagged')?.approvalFallback).toBe('fail-closed');
    // The trade-off text belongs to the prompt that was skipped.
    expect(script.output()).not.toContain('선택 [token / fail-closed]');
    // The password prompt still appeared: the flag does not make setup silent.
    expect(script.output()).toContain('비밀번호');
  });

  it('writes nothing when the approval fallback is never chosen (AC17.12a)', async () => {
    const script = scripted([endpoint.password, 'yes', '', '', '']);

    const code = await runSetup(['nochoice', target()], { prompter: script.prompter });

    expect(code).not.toBe(0);
    expect(loadEntry('nochoice')).toBeUndefined();
    expect(fs.existsSync(privateKeyPath('nochoice'))).toBe(false);
    expect(fs.existsSync(publicKeyPath('nochoice'))).toBe(false);
  });

  it('writes nothing when the host key is refused (AC7.5, AC9.2)', async () => {
    const script = scripted([endpoint.password, 'no']);
    const authBefore = endpoint.fixture?.eventsOfType('auth').length ?? 0;
    const execBefore = endpoint.fixture?.eventsOfType('exec').length ?? 0;
    const abortsBefore = endpoint.fixture?.eventsOfType('connection-error').length ?? 0;

    const code = await runSetup(['refused', target()], { prompter: script.prompter });

    expect(code).not.toBe(0);
    expect(fs.existsSync(hostsFilePath())).toBe(false);
    expect(fs.existsSync(privateKeyPath('refused'))).toBe(false);
    expect(script.output()).toContain('호스트 키를 승인하지 않았습니다');

    const fixture = endpoint.fixture;
    if (fixture !== undefined) {
      // AC9.2, both sides of the refusal. The server saw the handshake abort:
      const aborted = await waitFor(
        () => fixture.eventsOfType('connection-error').length > abortsBefore
      );
      expect(aborted).toBe(true);
      // and it saw no command, and no authentication attempt either - the
      // fingerprint is confirmed inside `hostVerifier`, before the password
      // could be offered.
      expect(fixture.eventsOfType('exec').length).toBe(execBefore);
      expect(fixture.eventsOfType('auth').length).toBe(authBefore);
    }
  });

  it('refuses a second setup for the same alias without --force', async () => {
    expect(
      await runSetup(['dup', target()], {
        prompter: scripted([endpoint.password, 'yes', 'fail-closed']).prompter,
      })
    ).toBe(0);
    const first = loadEntry('dup');

    const again = scripted([endpoint.password, 'yes', 'fail-closed']);
    const code = await runSetup(['dup', target()], { prompter: again.prompter });

    expect(code).not.toBe(0);
    expect(again.output()).toContain('alias_exists');
    // The recorded entry is untouched.
    expect(loadEntry('dup')?.createdAt).toBe(first?.createdAt);
  });

  it('keeps the old key and entry when --force is not confirmed (row 5.1b)', async () => {
    expect(
      await runSetup(['kept', target()], {
        prompter: scripted([endpoint.password, 'yes', 'fail-closed']).prompter,
      })
    ).toBe(0);
    const originalKey = fs.readFileSync(privateKeyPath('kept'), 'utf8');
    const originalEntry = loadEntry('kept');

    // Anything other than the exact word `yes` aborts, and the abort must roll
    // the freshly generated key back: re-pinning is never silent.
    const refused = scripted([endpoint.password, 'YES']);
    const code = await runSetup(['kept', target(), '--force'], { prompter: refused.prompter });

    expect(code).not.toBe(0);
    expect(fs.readFileSync(privateKeyPath('kept'), 'utf8')).toBe(originalKey);
    expect(loadEntry('kept')).toEqual(originalEntry);
    expect(refused.output()).toContain('기존 지문');
  });

  it('re-pins under --force and installs the new key exactly once (AC7.3)', async () => {
    expect(
      await runSetup(['rolled', target()], {
        prompter: scripted([endpoint.password, 'yes', 'fail-closed']).prompter,
      })
    ).toBe(0);
    const firstKeyLine = fs.readFileSync(publicKeyPath('rolled'), 'utf8').trim();

    const forced = scripted([endpoint.password, 'yes', 'token']);
    const code = await runSetup(['rolled', target(), '--force'], { prompter: forced.prompter });

    expect(code).toBe(0);
    const secondKeyLine = fs.readFileSync(publicKeyPath('rolled'), 'utf8').trim();
    expect(secondKeyLine).not.toBe(firstKeyLine);
    if (endpoint.fixture !== undefined) expect(countKeyLine(endpoint, secondKeyLine)).toBe(1);
    expect(loadEntry('rolled')?.approvalFallback).toBe('token');
    // Both fingerprints are shown side by side before the confirmation.
    expect(forced.output()).toContain('기존 지문');
    expect(forced.output()).toContain('새 지문');

    // Re-installing the same line is a no-op: `grep -qxF` idempotence (§5.7).
    const client = await defaultConnector({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.user,
      privateKey: fs.readFileSync(privateKeyPath('rolled')),
      authMethods: ['publickey'],
      readyTimeoutMs: 10_000,
      hostVerifier: (_key, verify) => {
        verify(true);
      },
    });
    try {
      // `alreadyPresent` is the remote script's own verdict, so this half of
      // the idempotence claim holds on both tiers; the line count is the
      // fixture-only confirmation of it.
      const result = await installAuthorizedKey(client, secondKeyLine);
      expect(result.alreadyPresent).toBe(true);
      expect(result.added).toBe(false);
      if (endpoint.fixture !== undefined) expect(countKeyLine(endpoint, secondKeyLine)).toBe(1);
    } finally {
      client.end();
    }
  });

  it('reports host_key_mismatch when the pin no longer matches (AC9.1)', async () => {
    expect(
      await runSetup(['pinned', target()], {
        prompter: scripted([endpoint.password, 'yes', 'fail-closed']).prompter,
      })
    ).toBe(0);

    // Tamper with the stored pin: the server is the same, the pin is not.
    const loaded = store.load();
    if (!loaded.ok) throw new Error('hosts.json did not load');
    const entry = loaded.file.hosts.pinned;
    if (entry === undefined) throw new Error('the pinned host disappeared');
    const wrongPin = `SHA256:${'A'.repeat(43)}`;
    store.save({
      ...loaded.file,
      hosts: { pinned: { ...entry, hostKey: { ...entry.hostKey, sha256: wrongPin } } },
    });

    const rows = await runChecks(buildChecks());
    const fingerprint = rows.find((check) => check.id === 'host-fingerprint:pinned');
    expect(fingerprint?.status).toBe('FAIL');
    expect(fingerprint?.detail).toContain('host_key_mismatch');
    expect(fingerprint?.detail).toContain(wrongPin);
    expect(fingerprint?.detail).toContain(endpoint.hostKeyFingerprint);
    // The connection is refused before authentication.
    expect(rows.find((check) => check.id === 'host-auth:pinned')?.status).toBe('FAIL');
  });

  it.skipIf(process.platform !== 'win32')(
    'deletes the key and records nothing when ACL hardening fails (AC7.7)',
    async () => {
      const script = scripted([endpoint.password, 'yes', 'fail-closed']);

      const code = await runSetup(['acl', target()], {
        prompter: script.prompter,
        icacls: failingIcacls(),
      });

      expect(code).not.toBe(0);
      expect(fs.existsSync(privateKeyPath('acl'))).toBe(false);
      expect(fs.existsSync(publicKeyPath('acl'))).toBe(false);
      expect(loadEntry('acl')).toBeUndefined();
      expect(script.output()).toContain('ACL 하드닝에 실패');
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'hardens the key directory before the private key exists (F12)',
    async () => {
      // Every icacls invocation records whether a key was on disk at that
      // moment. Hardening after the write left an unencrypted key under
      // inherited NTFS ACLs across two network round trips and a human prompt.
      const keyPresentAt: boolean[] = [];
      const icacls: IcaclsRunner = (args) => {
        keyPresentAt.push(fs.existsSync(privateKeyPath('ordered')));
        return stubIcacls()(args);
      };

      const script = scripted([endpoint.password, 'yes', 'fail-closed']);
      const code = await runSetup(['ordered', target()], { prompter: script.prompter, icacls });

      expect(code).toBe(0);
      // The run really did harden, and never while a key was lying there.
      expect(keyPresentAt.length).toBeGreaterThan(0);
      expect(keyPresentAt).not.toContain(true);
      // The key exists now, so the assertion above is about ordering rather
      // than about a key that was never written at all.
      expect(fs.existsSync(privateKeyPath('ordered'))).toBe(true);
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'hardens a home the server created before setup ever ran (F12)',
    async () => {
      // The server makes ~/.ssh-mcp for audit.jsonl, which carries command
      // strings. If no setup run ever follows, nothing used to restrict it.
      fs.rmSync(homePath(), { recursive: true, force: true });
      const hardened: string[] = [];
      const icacls: IcaclsRunner = (args) => {
        const [dir, ...flags] = args;
        if (flags.includes('/inheritance:r')) hardened.push(dir ?? '');
        return stubIcacls()(args);
      };

      const script = scripted([endpoint.password, 'yes', 'fail-closed']);
      const code = await runSetup(['fresh', target()], { prompter: script.prompter, icacls });

      expect(code).toBe(0);
      // Both the state directory and the key directory were restricted.
      expect(hardened).toContain(homePath());
      expect(hardened).toContain(keysDirPath());
    }
  );
});

describe('setup without a terminal', () => {
  let home: TmpHome;

  beforeEach(() => {
    home = createTmpHome('ssh-mcp-auth-tty-');
  });

  afterEach(() => {
    assertNoWritesOutside(home);
    home.cleanup();
  });

  /** A prompter over a stream that is not a TTY (a pipe, or CI stdin). */
  function pipedPrompter(): Script {
    const input = new PassThrough();
    let written = '';
    const prompter = createPrompter({
      input: input as never,
      output: {
        write(chunk: string) {
          written += chunk;
          return true;
        },
      },
      isTTY: false,
    });
    input.write(`${SENTINEL_PASSWORD}\nyes\ntoken\n`);
    return { prompter, output: () => written };
  }

  it('exits 2 and writes nothing at all (AC17.12c)', async () => {
    const script = pipedPrompter();

    const code = await runSetup(['prod', 'deploy@127.0.0.1:22'], { prompter: script.prompter });

    expect(code).toBe(2);
    expect(fs.existsSync(hostsFilePath())).toBe(false);
    expect(fs.existsSync(keysDirPath())).toBe(false);
    expect(script.output()).not.toContain(SENTINEL_PASSWORD);
  });

  it('still exits 2 with --approval-fallback: the flag is not a TTY exemption (AC17.12d)', async () => {
    const script = pipedPrompter();

    const code = await runSetup(
      ['prod', 'deploy@127.0.0.1:22', '--approval-fallback', 'fail-closed'],
      { prompter: script.prompter }
    );

    expect(code).toBe(2);
    expect(fs.existsSync(hostsFilePath())).toBe(false);
    expect(fs.existsSync(keysDirPath())).toBe(false);
  });

  it('refuses --force without a terminal (row 5.1b)', async () => {
    const script = pipedPrompter();

    const code = await runSetup(['prod', 'deploy@127.0.0.1:22', '--force'], {
      prompter: script.prompter,
    });

    expect(code).toBe(2);
    expect(fs.existsSync(hostsFilePath())).toBe(false);
  });
});

describe('argument parsing (row 5.1)', () => {
  it('accepts the documented forms', () => {
    expect(parseTarget('deploy@web01')).toEqual({
      user: 'deploy',
      hostname: 'web01',
      port: 22,
    });
    expect(parseTarget('deploy@web01:2222')).toEqual({
      user: 'deploy',
      hostname: 'web01',
      port: 2222,
    });
    // A bracketed IPv6 literal: unbracketed would be ambiguous with the port.
    expect(parseTarget('root@[::1]:2222')).toEqual({ user: 'root', hostname: '::1', port: 2222 });
    expect(parseTarget('root@[::1]')).toEqual({ user: 'root', hostname: '::1', port: 22 });
  });

  it.each(['web01', '@web01', 'deploy@', 'deploy@web01:0', 'deploy@web01:99999', 'a:b@web01'])(
    'rejects %j',
    (bad) => {
      expect(parseTarget(bad)).toBeNull();
    }
  );

  it('validates the alias against the registry pattern', () => {
    const good = parseSetupArgs(['web-01.prod', 'deploy@web01']);
    expect(good.ok && !good.help && good.args.alias).toBe('web-01.prod');
    for (const bad of ['-leading', 'has space', 'a'.repeat(65), '한글']) {
      const parsed = parseSetupArgs([bad, 'deploy@web01']);
      expect(parsed.ok).toBe(false);
    }
  });

  it('reads every option', () => {
    const parsed = parseSetupArgs([
      'prod',
      'deploy@web01:2200',
      '--approval-fallback',
      'token',
      '--approval-mode',
      'deny',
      '--label',
      '프로덕션 웹',
      '--force',
    ]);
    expect(parsed.ok && !parsed.help && parsed.args).toMatchObject({
      alias: 'prod',
      user: 'deploy',
      hostname: 'web01',
      port: 2200,
      approvalFallback: 'token',
      approvalMode: 'deny',
      label: '프로덕션 웹',
      force: true,
    });
  });

  /**
   * A value-taking flag must not eat the next flag.
   *
   * `host add --label --approval-mode` set the label to "--approval-mode" and
   * then, because that string was still sitting in argv, the wizard counted the
   * approval-mode question as already answered and never asked it. Two flags the
   * user typed, neither of them applied.
   */
  it.each([
    [['--label', '--approval-mode']],
    [['--approval-mode', '--label']],
    [['--approval-fallback', '--force']],
    [['prod', 'deploy@web01', '--label', '--force']],
  ])('refuses a flag name in a value position: %j', (argv) => {
    const parsed = parseSetupArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/needs a value, but got the option/u);
  });

  it('reports which flags were given, from the parse and not from argv', () => {
    // Nothing was applied, so nothing may be reported as given — otherwise the
    // wizard skips a question that has no answer.
    const swallowed = parseSetupArgs(['--label', '--approval-mode']);
    expect(swallowed.ok).toBe(false);
    expect(swallowed.ok === false && swallowed.given).toBeUndefined();

    const real = parseSetupArgs(['--approval-mode', 'deny', '--force']);
    expect(real.ok).toBe(false);
    expect(real.ok === false && real.missingPositionals).toBe(true);
    expect(real.ok === false && real.given).toEqual({
      approvalMode: true,
      label: false,
      force: true,
    });
  });

  it.each([
    [['prod']],
    [['prod', 'deploy@web01', 'extra']],
    [['prod', 'deploy@web01', '--approval-fallback', 'maybe']],
    [['prod', 'deploy@web01', '--approval-mode', 'sometimes']],
    [['prod', 'deploy@web01', '--unknown']],
  ])('rejects %j', (argv) => {
    expect(parseSetupArgs(argv).ok).toBe(false);
  });
});
