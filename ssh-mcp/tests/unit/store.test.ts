import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureHome,
  homePath,
  hostsFilePath,
  hostsTmpFilePath,
  stateFilePath,
} from '../../src/config/paths.js';
import { emptyHostsFile } from '../../src/config/schema.js';
import type { HostsFile } from '../../src/config/schema.js';
import { load, resolveApprovalFallback, save } from '../../src/config/store.js';
import { loadState, recordClient, recordObservedShell } from '../../src/config/state.js';
import { setLogLevel } from '../../src/log.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

const FINGERPRINT = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';
let home: TmpHome;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: 'web01.example.com',
    port: 22,
    user: 'deploy',
    privateKeyPath: 'k',
    hostKey: { algo: 'ssh-ed25519', sha256: FINGERPRINT },
    approvalMode: 'ask-destructive',
    approvalFallback: 'fail-closed',
    auditMode: 'full',
    patternOverrides: { destructive: { add: [], remove: [] }, privileged: { add: [], remove: [] } },
    defaultTimeoutSec: 60,
    maxOutputBytes: 1048576,
    createdAt: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

function writeHosts(body: string): void {
  ensureHome();
  fs.writeFileSync(hostsFilePath(), body, 'utf8');
}

function captureStderr(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines };
}

beforeEach(() => {
  home = createTmpHome('ssh-mcp-store-');
  setLogLevel('debug');
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel(null);
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('load (plan row 1.3, Principle 2)', () => {
  it('returns an empty registry when the file is absent', () => {
    const result = load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.missing).toBe(true);
    expect(result.file).toEqual(emptyHostsFile());
  });

  it('reports broken JSON as config_invalid instead of throwing', () => {
    writeHosts('{ not json');
    const result = load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('config_invalid');
    expect(result.reason).toBe('parse_error');
  });

  it('rejects a schemaVersion newer than this build understands', () => {
    writeHosts(JSON.stringify({ schemaVersion: 2, hosts: {} }));
    const result = load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_schema_version');
  });

  it('surfaces zod issue paths for a validation failure (AC21.2)', () => {
    writeHosts(JSON.stringify({ schemaVersion: 1, hosts: { web: entry({ port: 0 }) } }));
    const result = load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_error');
    expect(result.issues.map((issue) => issue.path)).toContain('hosts.web.port');
  });

  it('normalises a missing approvalFallback to fail-closed with one warn (D2, AC17.11)', () => {
    const bare = entry();
    delete bare.approvalFallback;
    writeHosts(JSON.stringify({ schemaVersion: 1, hosts: { a: bare, b: bare } }));
    const captured = captureStderr();
    const result = load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalizedFallbackAliases).toEqual(['a', 'b']);
    expect(result.file.hosts.a?.approvalFallback).toBe('fail-closed');
    expect(result.file.hosts.b?.approvalFallback).toBe('fail-closed');
    // Exactly one warning per load, listing every affected alias.
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0] ?? '').toContain('fail-closed');
  });

  it('keeps an explicit token fallback as-is (AC17.11 second half)', () => {
    writeHosts(
      JSON.stringify({ schemaVersion: 1, hosts: { a: entry({ approvalFallback: 'token' }) } })
    );
    const captured = captureStderr();
    const result = load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.hosts.a?.approvalFallback).toBe('token');
    expect(result.normalizedFallbackAliases).toEqual([]);
    expect(captured.lines).toHaveLength(0);
  });
});

describe('save (plan row 1.4)', () => {
  it('writes atomically, leaves no tmp file, and round-trips', () => {
    save({ schemaVersion: 1, hosts: { web: entry() } } as unknown as HostsFile);
    expect(fs.existsSync(hostsFilePath())).toBe(true);
    expect(fs.existsSync(hostsTmpFilePath())).toBe(false);
    const result = load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.hosts.web?.hostname).toBe('web01.example.com');
  });

  it('replaces an existing registry', () => {
    save({ schemaVersion: 1, hosts: { web: entry() } } as unknown as HostsFile);
    save({
      schemaVersion: 1,
      hosts: { other: entry({ hostname: 'db01' }) },
    } as unknown as HostsFile);
    const result = load();
    if (!result.ok) throw new Error('expected a valid registry');
    expect(Object.keys(result.file.hosts)).toEqual(['other']);
  });

  it('refuses to persist a registry that load() would reject', () => {
    expect(() =>
      save({ schemaVersion: 1, hosts: { 'bad alias': entry() } } as unknown as HostsFile)
    ).toThrow(/refusing to write/);
    expect(fs.existsSync(hostsFilePath())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'creates hosts.json as 0600 inside a 0700 home (AC7.2a)',
    () => {
      save({ schemaVersion: 1, hosts: {} } as unknown as HostsFile);
      expect(fs.statSync(hostsFilePath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(homePath()).mode & 0o777).toBe(0o700);
    }
  );
});

describe('resolveApprovalFallback', () => {
  it('answers fail-closed for an entry that omits the field', () => {
    const bare = entry();
    delete bare.approvalFallback;
    writeHosts(JSON.stringify({ schemaVersion: 1, hosts: { a: bare } }));
    const result = load();
    if (!result.ok) throw new Error('expected a valid registry');
    const host = result.file.hosts.a;
    expect(host).toBeDefined();
    if (host === undefined) return;
    expect(resolveApprovalFallback(host)).toBe('fail-closed');
  });
});

describe('state.json (plan row 1.9)', () => {
  it('returns defaults when the file is absent', () => {
    expect(loadState()).toEqual({ schemaVersion: 1, lastClient: null, observedShells: {} });
  });

  it('records the last client and the shells observed per host', () => {
    recordClient({ name: 'claude-code', version: '2.0.0', elicitation: true });
    recordObservedShell('web01', 'bash');
    recordObservedShell('win01', 'cmd');
    const state = loadState();
    expect(state.lastClient?.name).toBe('claude-code');
    expect(state.lastClient?.elicitation).toBe(true);
    expect(typeof state.lastClient?.seenAt).toBe('string');
    expect(state.observedShells.web01?.shell).toBe('bash');
    expect(state.observedShells.win01?.shell).toBe('cmd');
  });

  it('falls back to defaults on a damaged file rather than failing', () => {
    ensureHome();
    fs.writeFileSync(stateFilePath(), '{{{', 'utf8');
    expect(loadState().lastClient).toBeNull();
  });

  it('warns instead of throwing when state.json cannot be written', () => {
    const blocker = path.join(home.dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const previous = process.env.SSH_MCP_HOME;
    process.env.SSH_MCP_HOME = path.join(blocker, 'nested');
    try {
      const captured = captureStderr();
      expect(() => recordObservedShell('a', 'bash')).not.toThrow();
      expect(captured.lines).toHaveLength(1);
      expect(captured.lines[0] ?? '').toContain('"level":"warn"');
    } finally {
      if (previous === undefined) delete process.env.SSH_MCP_HOME;
      else process.env.SSH_MCP_HOME = previous;
    }
  });

  it.skipIf(process.platform === 'win32')('creates state.json as 0600', () => {
    recordObservedShell('web01', 'bash');
    expect(fs.statSync(stateFilePath()).mode & 0o777).toBe(0o600);
  });
});
