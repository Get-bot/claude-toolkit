/**
 * `ssh-mcp connect` / `ssh-mcp exec` (plan F6-F8, AC-C1, C2, C3, C5, C7).
 *
 * AC-C7 asks for exactly this shape: inject `spawn` and assert the argv array.
 * The array is the entire contract of these two commands — everything else they
 * do is a registry lookup — and it is also the one thing an end-to-end test
 * cannot show, because a passing `ssh` connection proves the flags were
 * *acceptable*, not that they were the ones we meant. `IdentitiesOnly=yes` in
 * particular is invisible from the outside until the day a user's agent holds
 * six keys and the server's `MaxAuthTries` runs out before ours is offered.
 *
 * `resolveSshBinary` is tested against injected `PATH`, `PATHEXT` and platform
 * rather than the real machine: the interesting case is a machine *without*
 * OpenSSH, which is precisely the one we cannot arrange here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConfigLoadResult } from '../../src/config/store.js';
import type { HostEntry } from '../../src/config/schema.js';
import {
  EXIT_OK,
  EXIT_FAILED,
  EXIT_USAGE,
  USAGE as CONNECT_USAGE,
  runConnect,
} from '../../src/connect/cli.js';
import type { ConnectDeps } from '../../src/connect/cli.js';
import { USAGE as EXEC_USAGE, runExecCommand } from '../../src/connect/execCli.js';
import {
  buildSshArgs,
  resolveSshBinary,
  spawnSsh,
  sshMissingMessage,
} from '../../src/connect/ssh.js';

const SSH_PATH = '/usr/bin/ssh';

/** The exit code the fake `ssh` reports, chosen so 0 cannot pass by accident. */
const SSH_EXIT = 42;

function hostEntry(overrides: Partial<HostEntry> = {}): HostEntry {
  return {
    hostname: 'web1.example.com',
    port: 2222,
    user: 'deploy',
    privateKeyPath: '/home/me/.ssh-mcp/keys/web1',
    hostKey: { algo: 'ssh-ed25519', sha256: `SHA256:${'a'.repeat(43)}` },
    approvalMode: 'ask-destructive',
    approvalFallback: 'fail-closed',
    auditMode: 'full',
    patternOverrides: {
      destructive: { add: [], remove: [] },
      privileged: { add: [], remove: [] },
    },
    defaultTimeoutSec: 60,
    maxOutputBytes: 65536,
    createdAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

function loaded(hosts: Record<string, HostEntry>): ConfigLoadResult {
  return {
    ok: true,
    path: '/home/me/.ssh-mcp/hosts.json',
    file: { schemaVersion: 1, hosts },
    normalizedFallbackAliases: [],
    missing: false,
  };
}

interface Capture {
  out: string[];
  err: string[];
  /** Every `[binary, args]` the command tried to spawn. */
  spawned: Array<{ binary: string; args: readonly string[] }>;
  deps: ConnectDeps;
}

function capture(overrides: Partial<ConnectDeps> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: Array<{ binary: string; args: readonly string[] }> = [];
  const deps: ConnectDeps = {
    out: (text: string): void => void out.push(text),
    err: (text: string): void => void err.push(text),
    load: (): ConfigLoadResult => loaded({ web1: hostEntry() }),
    resolveSsh: (): string | null => SSH_PATH,
    spawn: (binary: string, args: readonly string[]): Promise<number> => {
      spawned.push({ binary, args });
      return Promise.resolve(SSH_EXIT);
    },
    platform: 'linux',
    ...overrides,
  };
  return { out, err, spawned, deps };
}

/** The argv every command shares, for the fixture host above (AC-C1). */
const BASE_ARGS = [
  '-i',
  '/home/me/.ssh-mcp/keys/web1',
  '-p',
  '2222',
  '-o',
  'IdentitiesOnly=yes',
  'deploy@web1.example.com',
];

describe('buildSshArgs (AC-C1)', () => {
  it('is exactly the flags ADR-014 fixed, in that order', () => {
    expect(buildSshArgs(hostEntry())).toEqual(BASE_ARGS);
  });

  it('renders the port as a string, never a number', () => {
    // `spawn` rejects a non-string argv element at runtime, and the type system
    // will not catch it here because `String(port)` is the only conversion.
    for (const arg of buildSshArgs(hostEntry())) expect(typeof arg).toBe('string');
  });
});

describe('connect (AC-C1, C3, C5)', () => {
  it('spawns ssh with the host entry flags and passes its exit code through', async () => {
    const c = capture();
    const code = await runConnect(['web1'], c.deps);

    expect(c.spawned).toEqual([{ binary: SSH_PATH, args: BASE_ARGS }]);
    expect(code).toBe(SSH_EXIT);
    expect(c.out).toEqual([]);
  });

  it.each(['-h', '--help'])('prints usage to stdout for %s and exits 0', async (flag) => {
    const c = capture();
    const code = await runConnect([flag], c.deps);

    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([CONNECT_USAGE]);
    expect(c.err).toEqual([]);
    expect(c.spawned).toEqual([]);
  });

  it('refuses an unknown alias with host_not_found and exit 2', async () => {
    const c = capture();
    const code = await runConnect(['nope'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.err.join('\n')).toContain('host_not_found');
    expect(c.err.join('\n')).toContain('nope');
    expect(c.spawned).toEqual([]);
  });

  it('reports a missing ssh on stderr with exit 1, and never spawns', async () => {
    const c = capture({ resolveSsh: (): string | null => null });
    const code = await runConnect(['web1'], c.deps);

    expect(code).toBe(EXIT_FAILED);
    expect(c.spawned).toEqual([]);
    // The message has to say the server is unaffected: "ssh not found" from a
    // program called ssh-mcp reads as "nothing works", and that is wrong.
    expect(c.err.join('\n')).toContain('MCP 서버와 도구는 영향을 받지 않습니다');
  });

  it('reports the unknown alias first when ssh is also missing', async () => {
    // The typo is the thing the user can fix; sending them to install OpenSSH
    // for a host that does not exist wastes the trip.
    const c = capture({ resolveSsh: (): string | null => null });
    const code = await runConnect(['nope'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.err.join('\n')).toContain('host_not_found');
    expect(c.err.join('\n')).not.toContain('PATH에서 찾지 못했습니다');
  });

  it('refuses extra arguments instead of forwarding them past the destination', async () => {
    const c = capture();
    const code = await runConnect(['web1', '-X'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.spawned).toEqual([]);
  });

  it('asks for an alias when given none', async () => {
    const c = capture();
    expect(await runConnect([], c.deps)).toBe(EXIT_USAGE);
    expect(c.err.join('\n')).toContain('Usage: ssh-mcp connect');
  });

  it('reports an unreadable registry as a failure, not a usage error', async () => {
    const c = capture({
      load: (): ConfigLoadResult => ({
        ok: false,
        code: 'config_invalid',
        reason: 'parse_error',
        path: '/home/me/.ssh-mcp/hosts.json',
        message: 'unexpected token',
        issues: [{ path: 'hosts', message: 'broken' }],
      }),
    });
    const code = await runConnect(['web1'], c.deps);

    expect(code).toBe(EXIT_FAILED);
    expect(c.err.join('\n')).toContain('config_invalid');
    expect(c.spawned).toEqual([]);
  });
});

describe('exec (AC-C2, C4, C5)', () => {
  it('appends the words after `--` as separate argv elements, untouched', async () => {
    const c = capture();
    const code = await runExecCommand(['web1', '--', 'systemctl', 'status', 'nginx'], c.deps);

    expect(c.spawned).toEqual([
      { binary: SSH_PATH, args: [...BASE_ARGS, 'systemctl', 'status', 'nginx'] },
    ]);
    expect(code).toBe(SSH_EXIT);
  });

  it.each([
    ['a shell metacharacter', ['echo', 'a & b']],
    ['a leading dash', ['--version']],
    ['an embedded space', ['printf', '%s\\n', 'one two']],
    ['a quote', ['echo', "it's"]],
    ['an empty string', ['echo', '']],
    ['the separator again', ['git', 'log', '--', 'README.md']],
  ])('passes %s through without rewriting it', async (_name, command) => {
    // AC-C2: the tokens are handed to spawn as typed. Anything a shell would
    // have done to them is the remote shell's business, not ours — which is why
    // `spawnSsh` uses `shell: false` locally.
    const c = capture();
    await runExecCommand(['web1', '--', ...command], c.deps);

    expect(c.spawned[0]?.args).toEqual([...BASE_ARGS, ...command]);
  });

  it.each(['-h', '--help'])('prints usage to stdout for %s and exits 0', async (flag) => {
    const c = capture();
    const code = await runExecCommand([flag], c.deps);

    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([EXEC_USAGE]);
    expect(c.spawned).toEqual([]);
  });

  it('treats `--help` after `--` as the remote command, not as ours', async () => {
    const c = capture();
    await runExecCommand(['web1', '--', '--help'], c.deps);

    expect(c.out).toEqual([]);
    expect(c.spawned[0]?.args).toEqual([...BASE_ARGS, '--help']);
  });

  it('requires `--`', async () => {
    const c = capture();
    const code = await runExecCommand(['web1', 'uptime'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.spawned).toEqual([]);
  });

  it('requires something after `--`', async () => {
    const c = capture();
    const code = await runExecCommand(['web1', '--'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.err.join('\n')).toContain('`--` 뒤에');
    expect(c.spawned).toEqual([]);
  });

  it('refuses an unknown alias with host_not_found and exit 2', async () => {
    const c = capture();
    const code = await runExecCommand(['nope', '--', 'uptime'], c.deps);

    expect(code).toBe(EXIT_USAGE);
    expect(c.err.join('\n')).toContain('host_not_found');
    expect(c.spawned).toEqual([]);
  });

  it('reports a missing ssh on stderr with exit 1', async () => {
    const c = capture({ resolveSsh: (): string | null => null });
    const code = await runExecCommand(['web1', '--', 'uptime'], c.deps);

    expect(code).toBe(EXIT_FAILED);
    expect(c.spawned).toEqual([]);
  });
});

describe('resolveSshBinary (AC-C3)', () => {
  it('returns the first PATH entry that holds an executable ssh', () => {
    const seen: string[] = [];
    const found = resolveSshBinary({
      platform: 'linux',
      env: { PATH: '/empty:/usr/local/bin:/usr/bin' },
      isExecutableFile: (candidate): boolean => {
        seen.push(candidate);
        return candidate === '/usr/local/bin/ssh';
      },
    });

    expect(found).toBe('/usr/local/bin/ssh');
    // Stops at the first hit rather than scanning the rest of PATH.
    expect(seen).toEqual(['/empty/ssh', '/usr/local/bin/ssh']);
  });

  it('returns null when no PATH entry has one', () => {
    expect(
      resolveSshBinary({
        platform: 'linux',
        env: { PATH: '/usr/bin:/bin' },
        isExecutableFile: (): boolean => false,
      })
    ).toBeNull();
  });

  it('returns null when PATH is absent entirely', () => {
    // The e2e regression (F15) runs the binary in exactly this environment.
    expect(
      resolveSshBinary({ platform: 'linux', env: {}, isExecutableFile: (): boolean => true })
    ).toBeNull();
  });

  it('skips empty PATH entries instead of resolving ssh out of the cwd', () => {
    // An empty entry means "." to some shells. Honouring it would let any
    // directory a user happens to stand in impersonate OpenSSH.
    const seen: string[] = [];
    resolveSshBinary({
      platform: 'linux',
      env: { PATH: ':/usr/bin:' },
      isExecutableFile: (candidate): boolean => {
        seen.push(candidate);
        return false;
      },
    });

    expect(seen).toEqual(['/usr/bin/ssh']);
  });

  it('tries each PATHEXT extension on Windows, in order', () => {
    const seen: string[] = [];
    const found = resolveSshBinary({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32\\OpenSSH', PATHEXT: '.COM;.EXE;.CMD' },
      isExecutableFile: (candidate): boolean => {
        seen.push(candidate);
        return candidate.endsWith('.EXE');
      },
    });

    expect(found).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.EXE');
    expect(seen).toEqual([
      'C:\\Windows\\System32\\OpenSSH\\ssh.COM',
      'C:\\Windows\\System32\\OpenSSH\\ssh.EXE',
    ]);
  });

  it('skips the .bat/.cmd shims it could not spawn, and keeps looking', () => {
    // Node throws EINVAL for a .cmd target with `shell: false`, and `shell:
    // true` would re-parse the words after `--` and break AC-C2. Reporting a
    // shim as "found" would trade the actionable install hint for an opaque
    // spawn error, so the scan walks past it.
    const seen: string[] = [];
    const found = resolveSshBinary({
      platform: 'win32',
      env: { PATH: 'C:\\shims;C:\\real', PATHEXT: '.CMD;.BAT;.EXE' },
      isExecutableFile: (candidate): boolean => {
        seen.push(candidate);
        return candidate === 'C:\\shims\\ssh.CMD' || candidate === 'C:\\real\\ssh.EXE';
      },
    });

    expect(found).toBe('C:\\real\\ssh.EXE');
    expect(seen).toEqual(['C:\\shims\\ssh.EXE', 'C:\\real\\ssh.EXE']);
  });

  it('falls back to a default extension list when PATHEXT is unset', () => {
    const found = resolveSshBinary({
      platform: 'win32',
      env: { Path: 'C:\\bin' },
      isExecutableFile: (candidate): boolean => candidate === 'C:\\bin\\ssh.EXE',
    });

    expect(found).toBe('C:\\bin\\ssh.EXE');
  });

  it('strips the quotes Windows allows around a PATH entry', () => {
    const found = resolveSshBinary({
      platform: 'win32',
      env: { PATH: '"C:\\Program Files\\OpenSSH"', PATHEXT: '.EXE' },
      isExecutableFile: (candidate): boolean => candidate === 'C:\\Program Files\\OpenSSH\\ssh.EXE',
    });

    expect(found).toBe('C:\\Program Files\\OpenSSH\\ssh.EXE');
  });

  it('uses the host platform when none is injected, without throwing', () => {
    // Whether this machine has ssh is not the point; that the default path
    // reads the real environment and returns a string-or-null is.
    const found = resolveSshBinary();
    expect(found === null || typeof found === 'string').toBe(true);
  });
});

describe('spawnSsh against a real child (AC-C2)', () => {
  /**
   * The one claim the injected-`spawn` tests above cannot make.
   *
   * They prove we *build* the right array; this proves the array survives the
   * trip. On Windows there is no argv — `CreateProcess` takes a single command
   * line — so Node re-quotes each element and the child un-quotes it, and a
   * word containing a space, an `&`, a `%VAR%` or an apostrophe is exactly
   * where that round trip goes wrong. `shell: false` is what makes it work,
   * and it is invisible until someone runs `exec host -- echo 'a & b'`.
   */
  it('hands every argv element through unchanged and returns the exit code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-spawn-'));
    const script = path.join(dir, 'fake-ssh.mjs');
    const record = path.join(dir, 'argv.json');
    fs.writeFileSync(
      script,
      "import fs from 'node:fs';\n" +
        `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n` +
        'process.exit(23);\n'
    );

    try {
      const args = [
        '-i',
        'C:\\keys\\a b\\web1',
        '-p',
        '2222',
        '-o',
        'IdentitiesOnly=yes',
        'deploy@web1.example.com',
        'echo',
        'a & b',
        '%PATH%',
        '$HOME',
        "it's",
        'trailing ',
      ];

      // `process.execPath` stands in for ssh: an absolute path to a real
      // executable, which is exactly what `resolveSshBinary` returns.
      const code = await spawnSsh(process.execPath, [script, ...args]);

      expect(code).toBe(23);
      expect(JSON.parse(fs.readFileSync(record, 'utf8')) as string[]).toEqual(args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects rather than resolving when the binary cannot be executed', async () => {
    // A resolved-but-unrunnable path is not a 0 exit code. `main()` in
    // index.ts turns the rejection into `ssh-mcp failed: …` with exit 1.
    await expect(spawnSsh(path.join(os.tmpdir(), 'definitely-not-here-ssh'), [])).rejects.toThrow();
  });
});

describe('sshMissingMessage (AC-C3)', () => {
  it.each<[NodeJS.Platform, string]>([
    ['win32', 'OpenSSH 클라이언트'],
    ['darwin', 'brew install openssh'],
    ['linux', 'openssh-client'],
  ])('names an installation route for %s', (platform, needle) => {
    expect(sshMissingMessage(platform)).toContain(needle);
  });

  it('always says the MCP server is unaffected', () => {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd'] as NodeJS.Platform[]) {
      expect(sshMissingMessage(platform)).toContain('MCP 서버와 도구는 영향을 받지 않습니다');
    }
  });
});
