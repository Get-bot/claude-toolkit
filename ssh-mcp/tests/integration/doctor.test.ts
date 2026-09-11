/**
 * `ssh-mcp doctor` (plan §5.11, AC21.1-AC21.11).
 *
 * The interesting assertions are the exit-code rules: a clean machine with no
 * hosts must exit 0 (AC21.10), a WARN must not fail the run (AC21.6), and a
 * broken registry or an unreachable host must (AC21.2, AC21.3).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { homePath, hostsFilePath, keysDirPath, privateKeyPath } from '../../src/config/paths.js';
import { CHECK_KINDS, loadPatternRows } from '../../src/doctor/checks.js';
import type { CheckRow, HostProbeResult } from '../../src/doctor/checks.js';
import { runDoctor } from '../../src/doctor/cli.js';
import { generateKeyPair } from '../../src/setup/keygen.js';
import { currentWindowsPrincipal } from '../../src/setup/winacl.js';
import type { IcaclsRunner } from '../../src/setup/winacl.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;
let captured: string;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-doctor-');
  captured = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  assertNoWritesOutside(home);
  home.cleanup();
});

/** A syntactically valid, unpadded SHA-256 fingerprint. */
function fakeFingerprint(seed: string): string {
  return `SHA256:${crypto.createHash('sha256').update(seed).digest('base64').replace(/=+$/, '')}`;
}

function writeHosts(body: unknown): void {
  fs.mkdirSync(homePath(), { recursive: true });
  fs.writeFileSync(
    hostsFilePath(),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    'utf8',
  );
}

function hostEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: '127.0.0.1',
    port: 1,
    user: 'deploy',
    privateKeyPath: privateKeyPath('prod'),
    hostKey: { algo: 'ssh-ed25519', sha256: fakeFingerprint('prod') },
    approvalMode: 'ask-destructive',
    approvalFallback: 'fail-closed',
    auditMode: 'full',
    patternOverrides: { destructive: { add: [], remove: [] }, privileged: { add: [], remove: [] } },
    defaultTimeoutSec: 60,
    maxOutputBytes: 1048576,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A prober that answers without touching the network. */
function stubProber(result: Partial<HostProbeResult>) {
  return async (): Promise<HostProbeResult> => ({
    tcpOk: true,
    observedFingerprint: fakeFingerprint('prod'),
    fingerprintMatches: true,
    authOk: true,
    error: null,
    keyUnavailable: false,
    ...result,
  });
}

/**
 * An `icacls` runner reporting an already-hardened directory.
 *
 * The sandbox home is a fresh temp directory, so on Windows it still inherits
 * `BUILTIN\Administrators` from the profile. That is a real finding but not the
 * one under test here, so the ACL reader is fed a clean answer instead.
 */
function stubIcacls(extra: readonly string[] = []): IcaclsRunner {
  return (args) => {
    const target = args[0] ?? '';
    const principals = [currentWindowsPrincipal(), ...extra];
    const lines = principals.map((principal, index) =>
      index === 0 ? `${target} ${principal}:(OI)(CI)(F)` : `                     ${principal}:(OI)(CI)(F)`,
    );
    const crlf = String.fromCharCode(13, 10);
    return {
      status: 0,
      stdout:
        lines.join(crlf) +
        crlf +
        crlf +
        'Successfully processed 1 files; Failed processing 0 files' +
        crlf,
      stderr: '',
    };
  };
}

function parseJson(): { ok: boolean; checks: CheckRow[]; snippets: Record<string, string> } {
  return JSON.parse(captured) as {
    ok: boolean;
    checks: CheckRow[];
    snippets: Record<string, string>;
  };
}

function row(checks: readonly CheckRow[], id: string): CheckRow {
  const found = checks.find((entry) => entry.id === id || entry.id.startsWith(`${id}:`));
  if (found === undefined) {
    throw new Error(`no check row for ${id} in ${checks.map((c) => c.id).join(', ')}`);
  }
  return found;
}

describe('a clean machine with no hosts', () => {
  it('creates ~/.ssh-mcp and exits 0 (AC21.10)', async () => {
    fs.rmSync(homePath(), { recursive: true, force: true });
    expect(fs.existsSync(homePath())).toBe(false);

    const code = await runDoctor([]);

    expect(code).toBe(0);
    expect(fs.existsSync(homePath())).toBe(true);
    expect(captured).toContain('~/.ssh-mcp 레이아웃');
  });

  it('shows every one of the 15 check kinds (AC21.1)', async () => {
    const code = await runDoctor(['--json']);
    expect(code).toBe(0);
    const kinds = new Set(parseJson().checks.map((check) => check.id.split(':')[0]));
    for (const kind of CHECK_KINDS) expect(kinds).toContain(kind);
    expect(kinds.size).toBe(CHECK_KINDS.length);
  });

  it('prints the Claude Desktop and Claude Code snippets (AC21.7)', async () => {
    await runDoctor([]);
    expect(captured).toContain('claude_desktop_config.json');
    expect(captured).toContain('claude mcp add ssh-mcp -- npx -y @get-bot/ssh-mcp');
    if (process.platform === 'win32') {
      expect(captured).toContain('cmd /c npx -y @get-bot/ssh-mcp');
    }
  });
});

describe('--json output (AC21.8)', () => {
  it('is one object with ok, checks and all three snippets', async () => {
    const code = await runDoctor(['--json']);
    expect(code).toBe(0);

    const payload = parseJson();
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.checks)).toBe(true);
    for (const check of payload.checks) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'id', 'name', 'status']);
      expect(['PASS', 'WARN', 'FAIL', 'INFO']).toContain(check.status);
    }
    expect(Object.keys(payload.snippets).sort()).toEqual([
      'claudeCode',
      'claudeDesktop',
      'windows',
    ]);
    expect(payload.snippets.windows).toContain('cmd');
  });

  it('reports ok:false and exit 1 when a check fails', async () => {
    writeHosts('{ this is not json');
    const code = await runDoctor(['--json']);
    expect(code).toBe(1);
    expect(parseJson().ok).toBe(false);
  });
});

describe('a broken hosts.json (AC21.2)', () => {
  it('fails with the zod issue path in the detail', async () => {
    writeHosts({ schemaVersion: 1, hosts: { prod: { hostname: '' } } });

    const code = await runDoctor(['--json']);

    expect(code).toBe(1);
    const schema = row(parseJson().checks, 'hosts-schema');
    expect(schema.status).toBe('FAIL');
    expect(schema.detail).toContain('hosts.prod');
    expect(schema.detail).toContain('failed schema validation');
  });

  it('fails on unparseable JSON', async () => {
    writeHosts('{ nope');
    const code = await runDoctor(['--json']);
    expect(code).toBe(1);
    expect(row(parseJson().checks, 'hosts-schema').detail).toContain('not valid JSON');
  });

  it('rejects a schemaVersion from the future', async () => {
    writeHosts({ schemaVersion: 2, hosts: {} });
    const code = await runDoctor(['--json']);
    expect(code).toBe(1);
    expect(row(parseJson().checks, 'hosts-schema').detail).toContain('schemaVersion');
  });
});

describe('a registered host', () => {
  beforeEach(() => {
    fs.mkdirSync(keysDirPath(), { recursive: true });
    generateKeyPair('prod');
  });

  it('fails the TCP row for an unreachable port (AC21.3)', async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused fast.
    writeHosts({ schemaVersion: 1, hosts: { prod: hostEntry() } });

    const code = await runDoctor(['--json']);

    expect(code).toBe(1);
    const checks = parseJson().checks;
    expect(row(checks, 'host-tcp').status).toBe('FAIL');
    expect(row(checks, 'host-tcp').detail).toContain('127.0.0.1:1');
    // With no host key seen, the fingerprint and auth rows fail too.
    expect(row(checks, 'host-fingerprint').status).toBe('FAIL');
    expect(row(checks, 'host-auth').status).toBe('FAIL');
  });

  it('reports host_key_mismatch when the pin does not match (AC21.4)', async () => {
    writeHosts({ schemaVersion: 1, hosts: { prod: hostEntry() } });

    const code = await runDoctor(['--json'], {
      prober: stubProber({
        observedFingerprint: fakeFingerprint('someone-else'),
        fingerprintMatches: false,
        authOk: false,
      }),
    });

    expect(code).toBe(1);
    const checks = parseJson().checks;
    const fingerprint = row(checks, 'host-fingerprint');
    expect(fingerprint.status).toBe('FAIL');
    expect(fingerprint.detail).toContain('host_key_mismatch');
    expect(fingerprint.detail).toContain(fakeFingerprint('prod'));
    expect(fingerprint.detail).toContain(fakeFingerprint('someone-else'));
    expect(row(checks, 'host-tcp').status).toBe('PASS');
  });

  it('warns but exits 0 for auto mode and a token fallback (AC21.6)', async () => {
    writeHosts({
      schemaVersion: 1,
      hosts: {
        prod: hostEntry({ approvalMode: 'auto', approvalFallback: 'token' }),
      },
    });

    const code = await runDoctor(['--json'], { prober: stubProber({}), icacls: stubIcacls() });

    expect(code).toBe(0);
    const approval = row(parseJson().checks, 'host-approval');
    expect(approval.status).toBe('WARN');
    expect(approval.detail).toContain('auto');
    expect(approval.detail).toContain('token');
  });

  it('warns when approvalFallback is missing and assumes fail-closed', async () => {
    const entry = hostEntry();
    delete entry.approvalFallback;
    writeHosts({ schemaVersion: 1, hosts: { prod: entry } });

    const code = await runDoctor(['--json'], { prober: stubProber({}), icacls: stubIcacls() });

    expect(code).toBe(0);
    const checks = parseJson().checks;
    expect(row(checks, 'host-approval').status).toBe('WARN');
    expect(row(checks, 'host-approval').detail).toContain('fail-closed');
    expect(row(checks, 'hosts-schema').status).toBe('WARN');
  });

  it('fails the key-file row when the private key is gone (item 7)', async () => {
    writeHosts({ schemaVersion: 1, hosts: { prod: hostEntry() } });
    fs.rmSync(privateKeyPath('prod'));

    const code = await runDoctor(['--json'], { prober: stubProber({ keyUnavailable: true, authOk: false }) });

    expect(code).toBe(1);
    expect(row(parseJson().checks, 'host-key-file').status).toBe('FAIL');
  });

  it('distinguishes an observed Windows shell from an unobserved host (AC21.11)', async () => {
    writeHosts({
      schemaVersion: 1,
      hosts: { prod: hostEntry(), staging: hostEntry({ privateKeyPath: privateKeyPath('prod') }) },
    });
    fs.writeFileSync(
      path.join(homePath(), 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        lastClient: null,
        observedShells: { prod: { shell: 'cmd', seenAt: '2026-09-11T13:05:00.000Z' } },
      }),
      'utf8',
    );

    await runDoctor(['--json'], { prober: stubProber({}), icacls: stubIcacls() });

    const checks = parseJson().checks;
    const prod = checks.find((check) => check.id === 'host-shell:prod');
    const staging = checks.find((check) => check.id === 'host-shell:staging');
    expect(prod?.status).toBe('WARN');
    expect(prod?.detail).toContain('마지막 관측 기준');
    expect(staging?.status).toBe('INFO');
    expect(staging?.detail).toContain('미확인');
  });

  it.skipIf(process.platform !== 'win32')(
    'fails when icacls reports a principal other than the owner (AC7.2b)',
    async () => {
      writeHosts({ schemaVersion: 1, hosts: { prod: hostEntry() } });

      const code = await runDoctor(['--json'], {
        prober: stubProber({}),
        icacls: stubIcacls([`BUILTIN${String.fromCharCode(92)}Users`]),
      });

      expect(code).toBe(1);
      const permissions = row(parseJson().checks, 'file-permissions');
      expect(permissions.status).toBe('FAIL');
      expect(permissions.detail).toContain(`BUILTIN${String.fromCharCode(92)}Users`);
    },
  );

  it('never opens a channel: the probe stops at authentication (AC21.5)', async () => {
    // A bare TCP listener that accepts and immediately closes cannot serve an
    // SSH handshake, so any command execution would have to fail loudly. The
    // assertion that matters is structural: the prober returns before any
    // `exec`, which is why doctor has no command-running code path at all.
    const server = net.createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    writeHosts({ schemaVersion: 1, hosts: { prod: hostEntry({ port }) } });

    try {
      const code = await runDoctor(['--json']);
      expect(code).toBe(1);
      const checks = parseJson().checks;
      expect(row(checks, 'host-auth').status).toBe('FAIL');
      expect(captured).not.toContain('echo ');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe('--patterns (AC21.9)', () => {
  it('lists every pattern with id, scope, grade and regex', async () => {
    const patterns = loadPatternRows();
    const code = await runDoctor(['--patterns']);
    expect(code).toBe(0);
    expect(patterns.rows.length).toBeGreaterThan(0);

    // Match on the id column rather than a line prefix: `sudo` is a prefix of
    // other pattern ids, so `startsWith` would pick the wrong row.
    const cells = captured
      .split('\n')
      .filter((text) => text.includes(' | '))
      .map((text) => text.split(' | ').map((cell) => cell.trim()));
    const body = cells.filter((cols) => cols[0] !== 'id' && !(cols[0] ?? '').startsWith('--'));

    expect(body.length).toBe(patterns.rows.length);
    for (const pattern of patterns.rows) {
      const printed = body.find((cols) => cols[0] === pattern.id);
      expect(printed, `no row for pattern ${pattern.id}`).toBeDefined();
      expect(printed?.[1]).toBe(pattern.scope);
      expect(printed?.[2]).toBe(pattern.grade);
      // The printed regex must be byte-identical so it can be pasted into
      // patternOverrides.<grade>.remove (string-equality removal).
      expect(printed?.[3]).toBe(pattern.source);
    }
    expect(captured).toContain(`패턴 ${String(patterns.rows.length)}개`);
  });
});

describe('argument handling', () => {
  it('prints usage for --help and exits 0', async () => {
    expect(await runDoctor(['--help'])).toBe(0);
    expect(captured).toContain('Usage: ssh-mcp doctor');
  });

  it('rejects an unknown flag with exit 2', async () => {
    expect(await runDoctor(['--wat'])).toBe(2);
  });
});
