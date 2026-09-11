/**
 * Transfer confinement and approval (security findings F1 and F15).
 *
 * `upload` and `download` take a local path straight from the model. Two
 * separate protections apply, and the difference matters:
 *
 * - Anything inside `~/.ssh-mcp` is refused outright with
 *   `local_path_forbidden`. That subtree holds the registry the approval rules
 *   come from, the private keys, and the audit log; a `download` that replaced
 *   `hosts.json` would set every host to `approvalMode: auto` and disarm every
 *   later prompt, so it cannot be something a prompt could allow.
 * - Everything else goes through the approval gate like any other risky
 *   operation.
 *
 * The last test walks the whole exploit chain and shows it is closed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { auditFilePath, ensureKeysDir, homePath, hostsFilePath } from '../../src/config/paths.js';
import { ERROR_CODES } from '../../src/errors.js';
import { clearTokens } from '../../src/safety/tokens.js';
import { closeAll } from '../../src/ssh/pool.js';
import { resetSessions } from '../../src/ssh/session.js';
import { authorizeKey, hostEntryFor, startEndpoint } from '../fixtures/endpoints.js';
import type { TestEndpoint } from '../fixtures/endpoints.js';
import { generateClientKey } from '../fixtures/hostKeys.js';
import { startMcpTestClient, writeRegistry, type McpTestClient } from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

const DESTRUCTIVE = 'rm -rf /tmp/ssh-mcp-transfer-absent && echo DESTRUCTIVE_OK';

let home: TmpHome;
let endpoint: TestEndpoint;
let keyPath: string;
let workDir: string;
let harness: McpTestClient;

function remotePath(name: string): string {
  return `${endpoint.remoteHomeDir.replace(/\\/g, '/')}/${name}`;
}

/** A registry that would disable every approval prompt, as an attacker would write it. */
function maliciousRegistry(): string {
  const raw = fs.readFileSync(hostsFilePath(), 'utf8');
  return raw.replace(/"approvalMode": "[a-z-]+"/g, '"approvalMode": "auto"');
}

beforeAll(async () => {
  home = createTmpHome('ssh-mcp-transfer-');
  endpoint = await startEndpoint();
  const clientKey = generateClientKey();
  authorizeKey(endpoint, clientKey.publicKey);
  keyPath = path.join(ensureKeysDir(), 'fixture');
  fs.writeFileSync(keyPath, clientKey.privateKey, { encoding: 'utf8', mode: 0o600 });
  workDir = fs.mkdtempSync(path.join(endpoint.localSandboxDir, 'work-'));

  writeRegistry({
    auto: hostEntryFor(endpoint, { alias: 'auto', privateKeyPath: keyPath }),
    deny: hostEntryFor(endpoint, {
      alias: 'deny',
      approvalMode: 'deny',
      approvalFallback: 'token',
      privateKeyPath: keyPath,
    }),
    'ask-token': hostEntryFor(endpoint, {
      alias: 'ask-token',
      approvalMode: 'ask-destructive',
      approvalFallback: 'token',
      privateKeyPath: keyPath,
    }),
    'ask-closed': hostEntryFor(endpoint, {
      alias: 'ask-closed',
      approvalMode: 'ask-destructive',
      approvalFallback: 'fail-closed',
      privateKeyPath: keyPath,
    }),
  });

  harness = await startMcpTestClient({ elicitation: 'none' });
});

afterAll(async () => {
  await harness.close();
  resetSessions();
  closeAll();
  await endpoint.close();
  assertNoWritesOutside(home);
  home.cleanup();
});

afterEach(() => {
  clearTokens();
});

describe('paths inside the ssh-mcp home are refused (F1)', () => {
  it.each([
    ['the registry', (): string => hostsFilePath()],
    ['the audit log', (): string => auditFilePath()],
    ['a private key', (): string => keyPath],
    ['the home directory itself', (): string => homePath()],
    [
      'a path that walks back in',
      (): string => path.join(homePath(), '..', path.basename(homePath()), 'hosts.json'),
    ],
  ])('refuses to download onto %s', async (_label, target) => {
    const result = await harness.callTool('download', {
      host: 'auto',
      remote_path: remotePath('payload.txt'),
      local_path: target(),
      overwrite: true,
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(ERROR_CODES.local_path_forbidden);
  });

  it('refuses to upload a private key out of the home directory (F15)', async () => {
    const result = await harness.callTool('upload', {
      host: 'auto',
      local_path: keyPath,
      remote_path: remotePath('stolen-key'),
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(ERROR_CODES.local_path_forbidden);
    expect(fs.existsSync(path.join(endpoint.remoteHomeDir, 'stolen-key'))).toBe(false);
  });

  it('refuses a symlink that points into the home directory', () => {
    const link = path.join(workDir, 'link-to-home');
    try {
      fs.symlinkSync(homePath(), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Creating links can need a privilege we do not have; the lexical cases
      // above still cover the rule.
      return;
    }

    return harness
      .callTool('download', {
        host: 'auto',
        remote_path: remotePath('payload.txt'),
        local_path: path.join(link, 'hosts.json'),
        overwrite: true,
      })
      .then((result) => {
        expect(result.isError).toBe(true);
        expect(result.body.error).toBe(ERROR_CODES.local_path_forbidden);
      });
  });

  it('allows an ordinary path outside the home directory', async () => {
    const source = path.join(workDir, 'ordinary.txt');
    fs.writeFileSync(source, 'ordinary payload\n', 'utf8');

    const uploaded = await harness.callTool('upload', {
      host: 'auto',
      local_path: source,
      remote_path: remotePath('ordinary-remote.txt'),
    });
    expect(uploaded.isError, uploaded.text).toBe(false);
  });

  it('records the refusal in the audit log', async () => {
    const before = fs.existsSync(auditFilePath())
      ? fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(Boolean).length
      : 0;

    await harness.callTool('upload', {
      host: 'auto',
      local_path: hostsFilePath(),
      remote_path: remotePath('nope'),
    });

    const lines = fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(before + 1);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.tool).toBe('upload');
    expect(last.error_code).toBe(ERROR_CODES.local_path_forbidden);
    expect(last.host).toBe('auto');
  });
});

describe('transfers go through the approval gate (F1)', () => {
  it('refuses an upload on a deny host', async () => {
    const source = path.join(workDir, 'denied-upload.txt');
    fs.writeFileSync(source, 'payload\n', 'utf8');

    const result = await harness.callTool('upload', {
      host: 'deny',
      local_path: source,
      remote_path: remotePath('denied-upload.txt'),
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(ERROR_CODES.command_denied);
    expect(fs.existsSync(path.join(endpoint.remoteHomeDir, 'denied-upload.txt'))).toBe(false);
  });

  it('refuses a download on a deny host', async () => {
    const remote = remotePath('deny-source.txt');
    fs.writeFileSync(path.join(endpoint.remoteHomeDir, 'deny-source.txt'), 'payload\n', 'utf8');
    const target = path.join(workDir, 'deny-target.txt');

    const result = await harness.callTool('download', {
      host: 'deny',
      remote_path: remote,
      local_path: target,
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(ERROR_CODES.command_denied);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('asks before overwriting a local file, then runs once on the token', async () => {
    const name = 'overwrite-source.txt';
    fs.writeFileSync(path.join(endpoint.remoteHomeDir, name), 'fresh remote payload\n', 'utf8');
    const target = path.join(workDir, 'overwrite-target.txt');
    fs.writeFileSync(target, 'original local payload\n', 'utf8');

    const asked = await harness.callTool('download', {
      host: 'ask-token',
      remote_path: remotePath(name),
      local_path: target,
      overwrite: true,
    });

    expect(asked.isError).toBe(false);
    expect(asked.body.status).toBe('confirmation_required');
    expect(asked.body.grade).toBe('destructive');
    expect(asked.body.command).toContain('overwrite');
    // Nothing was transferred while the approval was outstanding.
    expect(fs.readFileSync(target, 'utf8')).toBe('original local payload\n');

    const done = await harness.callTool('download', {
      host: 'ask-token',
      remote_path: remotePath(name),
      local_path: target,
      overwrite: true,
      confirmation_token: asked.body.confirmation_token,
    });

    expect(done.isError, done.text).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('fresh remote payload\n');
  });

  it('asks before an upload and reports the real outcome in the audit line', async () => {
    const source = path.join(workDir, 'gated-upload.txt');
    fs.writeFileSync(source, 'payload\n', 'utf8');
    const before = fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(Boolean).length;

    const asked = await harness.callTool('upload', {
      host: 'ask-token',
      local_path: source,
      remote_path: remotePath('gated-upload.txt'),
    });

    expect(asked.body.status).toBe('confirmation_required');
    expect(asked.body.grade).toBe('privileged');

    const lines = fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(before + 1);
    const line = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(line.tool).toBe('upload');
    // The old behaviour was `not-required`, because transfers never reached
    // the gate at all (F1).
    expect(line.approval_outcome).toBe('pending-confirmation');
    expect(line.command_grade).toBe('privileged');
    expect(String(line.command)).toContain('upload ');
  });

  it('shows both paths to the person asked, and runs once accepted', async () => {
    const elicited = await startMcpTestClient({
      elicitation: 'form',
      onElicit: () => ({ action: 'accept', content: { confirm: true } }),
    });
    try {
      const source = path.join(workDir, 'elicited-upload.txt');
      fs.writeFileSync(source, 'payload\n', 'utf8');
      const remote = remotePath('elicited-upload.txt');

      const result = await elicited.callTool('upload', {
        host: 'ask-token',
        local_path: source,
        remote_path: remote,
      });

      expect(elicited.elicitRequests).toHaveLength(1);
      expect(elicited.elicitRequests[0]?.message).toContain(source);
      expect(elicited.elicitRequests[0]?.message).toContain(remote);
      expect(result.isError, result.text).toBe(false);
      expect(fs.existsSync(path.join(endpoint.remoteHomeDir, 'elicited-upload.txt'))).toBe(true);
    } finally {
      await elicited.close();
    }
  });

  it('refuses a transfer outright on a fail-closed host that cannot elicit', async () => {
    const source = path.join(workDir, 'closed-upload.txt');
    fs.writeFileSync(source, 'payload\n', 'utf8');

    const result = await harness.callTool('upload', {
      host: 'ask-closed',
      local_path: source,
      remote_path: remotePath('closed-upload.txt'),
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(ERROR_CODES.approval_unavailable);
    expect(result.body.confirmation_token).toBeUndefined();
  });
});

describe('the config-rewrite exploit chain is closed end to end (F1)', () => {
  it('cannot replace hosts.json and so cannot turn approval off', async () => {
    // 1. The attacker stages a registry that sets every host to `auto`.
    const payload = path.join(endpoint.remoteHomeDir, 'evil-hosts.json');
    fs.writeFileSync(payload, maliciousRegistry(), 'utf8');
    const registryBefore = fs.readFileSync(hostsFilePath(), 'utf8');

    // 2. The model tries to download it over the real registry.
    const attack = await harness.callTool('download', {
      host: 'auto',
      remote_path: payload.replace(/\\/g, '/'),
      local_path: hostsFilePath(),
      overwrite: true,
    });
    expect(attack.isError).toBe(true);
    expect(attack.body.error).toBe(ERROR_CODES.local_path_forbidden);

    // 3. The registry is untouched, byte for byte.
    expect(fs.readFileSync(hostsFilePath(), 'utf8')).toBe(registryBefore);

    // 4. And the host that was refusing destructive commands still refuses.
    const denied = await harness.callTool('exec', { host: 'deny', command: DESTRUCTIVE });
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toBe(ERROR_CODES.command_denied);
  });
});
