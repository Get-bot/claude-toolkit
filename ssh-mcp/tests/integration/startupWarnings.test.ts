/**
 * The warnings the server prints about its own weak spots
 * (R12, M6, D2, and finding F10).
 *
 * Each of these exists because a configuration can be perfectly valid and
 * still mean "nothing here will stop a destructive command". They are the only
 * signal a user gets, so each is asserted to appear exactly once, to name the
 * hosts it is about, and not to appear when it does not apply.
 *
 * No SSH endpoint is needed: nothing connects, the registry is enough.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureHome, hostsFilePath } from '../../src/config/paths.js';
import { CONFIG_SCHEMA_VERSION } from '../../src/config/schema.js';
import { REQUIRE_USER_INTERACTION_ENV } from '../../src/tools/annotations.js';
import { startMcpTestClient, type McpTestClient } from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;
let harness: McpTestClient | null = null;
let stderrText: string;
const previousEnv = process.env[REQUIRE_USER_INTERACTION_ENV];

function fingerprint(seed: string): string {
  return `SHA256:${crypto.createHash('sha256').update(seed).digest('base64').replace(/=+$/, '')}`;
}

/** A registry entry that is valid but never connected to. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: '127.0.0.1',
    port: 22,
    user: 'deploy',
    privateKeyPath: 'unused',
    hostKey: { algo: 'ssh-ed25519', sha256: fingerprint('seed') },
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

function writeHosts(hosts: Record<string, Record<string, unknown>>): void {
  ensureHome();
  fs.writeFileSync(
    hostsFilePath(),
    JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, hosts }, null, 2),
    'utf8'
  );
}

/** Warn records whose message contains `needle`. */
function warnings(needle: string): Record<string, unknown>[] {
  return stderrText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === 'warn' && String(record.msg ?? '').includes(needle));
}

beforeEach(() => {
  home = createTmpHome('ssh-mcp-warnings-');
  stderrText = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrText += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
});

afterEach(async () => {
  if (harness !== null) await harness.close();
  harness = null;
  if (previousEnv === undefined) delete process.env[REQUIRE_USER_INTERACTION_ENV];
  else process.env[REQUIRE_USER_INTERACTION_ENV] = previousEnv;
  vi.restoreAllMocks();
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('approvalMode: auto (R12)', () => {
  it('warns once and names the host', async () => {
    writeHosts({
      loose: entry({ approvalMode: 'auto' }),
      strict: entry({ approvalMode: 'ask-destructive' }),
    });

    harness = await startMcpTestClient({ elicitation: 'form' });

    const found = warnings('approvalMode: auto');
    expect(found).toHaveLength(1);
    expect(found[0]?.hosts).toEqual(['loose']);
  });

  it('says nothing when no host is on auto', async () => {
    writeHosts({ strict: entry() });
    harness = await startMcpTestClient({ elicitation: 'form' });
    expect(warnings('approvalMode: auto')).toHaveLength(0);
  });
});

describe('token fallback with a client that cannot elicit (M6)', () => {
  it('warns once, naming the client and the hosts', async () => {
    writeHosts({
      tokenhost: entry({ approvalFallback: 'token' }),
      closedhost: entry({ approvalFallback: 'fail-closed' }),
    });

    harness = await startMcpTestClient({ elicitation: 'none' });

    const found = warnings('does not support elicitation');
    expect(found).toHaveLength(1);
    expect(found[0]?.hosts).toEqual(['tokenhost']);
    expect(found[0]?.client).toBe('ssh-mcp-test-client');
  });

  it('says nothing when the client can elicit', async () => {
    writeHosts({ tokenhost: entry({ approvalFallback: 'token' }) });
    harness = await startMcpTestClient({ elicitation: 'form' });
    expect(warnings('does not support elicitation')).toHaveLength(0);
  });
});

describe('a host entry with no approvalFallback field (D2)', () => {
  it('warns that it is being treated as fail-closed', async () => {
    const handEdited = entry();
    delete handEdited.approvalFallback;
    writeHosts({ handedited: handEdited });

    harness = await startMcpTestClient({ elicitation: 'form' });

    const found = warnings('without approvalFallback');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.aliases).toEqual(['handedited']);
    expect(found[0]?.assumed).toBe('fail-closed');
  });
});

describe('the requiresUserInteraction opt-out (F10)', () => {
  it('warns when the opt-out is set and a host falls back to tokens', async () => {
    process.env[REQUIRE_USER_INTERACTION_ENV] = '0';
    writeHosts({ tokenhost: entry({ approvalFallback: 'token' }) });

    harness = await startMcpTestClient({ elicitation: 'form' });

    const found = warnings(REQUIRE_USER_INTERACTION_ENV);
    expect(found).toHaveLength(1);
    expect(found[0]?.hosts).toEqual(['tokenhost']);
  });

  it('says nothing when the opt-out is set but every host is fail-closed', async () => {
    process.env[REQUIRE_USER_INTERACTION_ENV] = '0';
    writeHosts({ closedhost: entry({ approvalFallback: 'fail-closed' }) });

    harness = await startMcpTestClient({ elicitation: 'form' });
    expect(warnings(REQUIRE_USER_INTERACTION_ENV)).toHaveLength(0);
  });

  it('says nothing when the opt-out is not set', async () => {
    writeHosts({ tokenhost: entry({ approvalFallback: 'token' }) });
    harness = await startMcpTestClient({ elicitation: 'form' });
    expect(warnings(REQUIRE_USER_INTERACTION_ENV)).toHaveLength(0);
  });
});
