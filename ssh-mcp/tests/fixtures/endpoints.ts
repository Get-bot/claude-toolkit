/**
 * Endpoint parameterisation for the integration suite (OPT-3, §6.2).
 *
 * The same test body runs against two endpoints, chosen by the `ENDPOINT`
 * environment variable:
 *
 * - `fixture` (default): the in-process ssh2 server from `sshServer.ts`. Runs
 *   everywhere, and is the only tier that can observe protocol-level facts.
 * - `sshd`: a real OpenSSH server, addressed through `SSH_MCP_SSHD_HOST`,
 *   `SSH_MCP_SSHD_PORT`, `SSH_MCP_SSHD_USER` and `SSH_MCP_SSHD_PASSWORD`. Runs
 *   in the `real-sshd` CI job and covers what an in-process server cannot:
 *   real file permissions, the real SFTP implementation, real process cleanup.
 *
 * Tests that only make sense on one tier say so explicitly with
 * `it.runIf(endpoint.kind === 'fixture')`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';

import type { HostEntry } from '../../src/config/schema.js';
import { installAuthorizedKey } from '../../src/setup/install.js';
import { sha256Fingerprint } from '../../src/ssh/fingerprint.js';
import { generateHostKey, type FixtureKeyPair } from './hostKeys.js';
import {
  resolveShellPath,
  startSshFixture,
  type ScriptedResponse,
  type ShellEmulation,
  type SshFixture,
} from './sshServer.js';

export type EndpointKind = 'fixture' | 'sshd';

export const FIXTURE_USER = 'ssh-mcp-test';
export const FIXTURE_PASSWORD = 'fixture-password-v1';

export interface TestEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  /** `SHA256:...` of the server host key, for pinning in `hosts.json`. */
  hostKeyFingerprint: string;
  kind: EndpointKind;
  /**
   * Alias of {@link TestEndpoint.localSandboxDir}, kept for existing callers.
   *
   * It used to hold the *remote* `$HOME` on the sshd tier while every caller
   * used it as a local path for `mkdirSync`/`mkdtempSync`, which could not work
   * against a real server and pointed local writes at a path chosen by the
   * remote host (CR-2). It now always names a local directory, so the worst a
   * stale caller can do is write inside the sandbox. New code should say which
   * side it means.
   */
  homeDir: string;
  /** A local temp directory, on both tiers. Use it for any local fs call. */
  localSandboxDir: string;
  /** Home directory ON THE REMOTE SIDE: the sandbox for `fixture`, `$HOME` for `sshd`. */
  remoteHomeDir: string;
  close(): Promise<void>;
  /**
   * The in-process server, when there is one. Protocol-level assertions
   * (AC8.1, AC9.2, AC11.2) read its event log; it is absent for `sshd`.
   */
  fixture?: SshFixture;
}

export interface StartEndpointOptions {
  /** Shell binary for bridged channels, e.g. `dash`. Fixture only. */
  shell?: string;
  /** Extra arguments for the session shell, e.g. `['-e', '-u']`. Fixture only. */
  shellArgs?: string[];
  /** Reuse a host key, e.g. to restart on a different one for AC9. */
  hostKey?: FixtureKeyPair;
  /** Emulate a non-POSIX shell (AC14.5, AC14.6). Fixture only. */
  shellEmulation?: ShellEmulation;
  /** Canned command replies. Fixture only. */
  scripted?: Record<string, ScriptedResponse>;
  /** Use this directory as the remote home instead of a fresh temp one. */
  homeDir?: string;
  user?: string;
  password?: string;
}

/** Endpoint selected by `ENDPOINT`; defaults to the in-process fixture. */
export function currentEndpointKind(): EndpointKind {
  return process.env.ENDPOINT === 'sshd' ? 'sshd' : 'fixture';
}

/** True when `name` is an installed shell; tests skip legs that are missing. */
export function shellAvailable(name: string): boolean {
  return resolveShellPath(name) !== null;
}

/** Shell requested for this run (`SHELL_UNDER_TEST`), defaulting to bash. */
export function shellUnderTest(): string {
  const requested = process.env.SHELL_UNDER_TEST?.trim();
  return requested === undefined || requested === '' ? 'bash' : requested;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`ENDPOINT=sshd requires ${name}`);
  }
  return value;
}

/**
 * Discover the real server's host key fingerprint and `$HOME` in one
 * password-authenticated connection.
 */
async function probeRealSshd(
  host: string,
  port: number,
  user: string,
  password: string
): Promise<{ fingerprint: string; homeDir: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = '';
    let output = '';

    client.on('ready', () => {
      client.exec('echo $HOME', { pty: false }, (err, stream) => {
        if (err) {
          client.end();
          reject(err);
          return;
        }
        stream.end();
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
        });
        stream.on('close', () => {
          client.end();
          const homeDir = output.trim();
          if (homeDir === '') {
            reject(new Error('remote $HOME came back empty'));
            return;
          }
          resolve({ fingerprint, homeDir });
        });
      });
    });
    client.on('error', reject);

    client.connect({
      host,
      port,
      username: user,
      password,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
        fingerprint = sha256Fingerprint(key);
        verify(true);
      },
    });
  });
}

/**
 * Start (or connect to) the endpoint for this run.
 *
 * The returned object is what a test pins in `hosts.json`; nothing else in the
 * suite should need to know which tier it is talking to.
 */
export async function startEndpoint(options: StartEndpointOptions = {}): Promise<TestEndpoint> {
  const kind = currentEndpointKind();

  if (kind === 'sshd') {
    const host = requiredEnv('SSH_MCP_SSHD_HOST');
    const port = Number.parseInt(requiredEnv('SSH_MCP_SSHD_PORT'), 10);
    const user = requiredEnv('SSH_MCP_SSHD_USER');
    const password = requiredEnv('SSH_MCP_SSHD_PASSWORD');
    const probe = await probeRealSshd(host, port, user, password);
    // The remote home is a path on another machine. Local file operations get
    // their own sandbox here so nothing in the suite can be steered into
    // writing at a path the remote host chose (CR-2).
    const localSandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-sshd-local-'));
    return {
      host,
      port,
      user,
      password,
      hostKeyFingerprint: probe.fingerprint,
      kind,
      homeDir: localSandboxDir,
      localSandboxDir,
      remoteHomeDir: probe.homeDir,
      close(): Promise<void> {
        try {
          fs.rmSync(localSandboxDir, { recursive: true, force: true });
        } catch {
          // A leftover temp directory is not worth failing a test over.
        }
        return Promise.resolve();
      },
    };
  }

  const ownsHomeDir = options.homeDir === undefined;
  const homeDir = options.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-remote-'));
  const hostKey = options.hostKey ?? generateHostKey();
  const user = options.user ?? FIXTURE_USER;
  const password = options.password ?? FIXTURE_PASSWORD;

  const shellName = options.shell ?? shellUnderTest();
  const shellPath = options.shellEmulation === undefined ? resolveShellPath(shellName) : null;
  if (options.shellEmulation === undefined && shellPath === null) {
    throw new Error(`shell "${shellName}" is not installed on this machine`);
  }

  const fixture = await startSshFixture({
    hostKey,
    user,
    password,
    homeDir,
    ...(shellPath === null ? {} : { shellPath }),
    ...(options.shellArgs === undefined ? {} : { shellArgs: options.shellArgs }),
    ...(options.shellEmulation === undefined ? {} : { shellEmulation: options.shellEmulation }),
    ...(options.scripted === undefined ? {} : { scripted: options.scripted }),
  });

  return {
    host: fixture.host,
    port: fixture.port,
    user,
    password,
    hostKeyFingerprint: hostKey.fingerprint,
    kind,
    // The in-process server runs on this machine, so both sides are the same
    // directory here. Only the sshd tier has to tell them apart.
    homeDir,
    localSandboxDir: homeDir,
    remoteHomeDir: homeDir,
    fixture,
    async close(): Promise<void> {
      await fixture.close();
      if (ownsHomeDir) {
        try {
          fs.rmSync(homeDir, { recursive: true, force: true });
        } catch {
          // A leftover temp directory is not worth failing a test over.
        }
      }
    },
  };
}

export interface HostEntryOverrides {
  alias?: string;
  approvalMode?: HostEntry['approvalMode'];
  approvalFallback?: HostEntry['approvalFallback'];
  defaultTimeoutSec?: number;
  maxOutputBytes?: number;
  /** Pin a different fingerprint, e.g. to reproduce AC9. */
  hostKeyFingerprint?: string;
  privateKeyPath?: string;
}

/**
 * A registry entry pointing at `endpoint`, ready for the pool.
 *
 * Tests that only need a connection should not have to restate every schema
 * default, and a shared builder keeps the three integration files honest about
 * using the same host shape.
 */
export function hostEntryFor(
  endpoint: TestEndpoint,
  overrides: HostEntryOverrides = {}
): HostEntry & { alias: string } {
  return {
    alias: overrides.alias ?? 'fixture',
    hostname: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    privateKeyPath: overrides.privateKeyPath ?? path.join(endpoint.localSandboxDir, 'unused-key'),
    hostKey: {
      algo: 'ssh-ed25519',
      sha256: overrides.hostKeyFingerprint ?? endpoint.hostKeyFingerprint,
    },
    approvalMode: overrides.approvalMode ?? 'auto',
    ...(overrides.approvalFallback === undefined
      ? {}
      : { approvalFallback: overrides.approvalFallback }),
    auditMode: 'full',
    patternOverrides: {
      destructive: { add: [], remove: [] },
      privileged: { add: [], remove: [] },
    },
    defaultTimeoutSec: overrides.defaultTimeoutSec ?? 60,
    maxOutputBytes: overrides.maxOutputBytes ?? 1048576,
    createdAt: new Date().toISOString(),
  };
}

/** Write `publicKey` into the endpoint's `authorized_keys` (setup flow tests). */
export function authorizeKey(endpoint: TestEndpoint, publicKey: string): void {
  if (endpoint.kind === 'sshd') {
    // The remote home belongs to another machine; writing there with `fs`
    // would silently create a lookalike directory on this one. Installing a
    // key on the real-sshd tier has to go over SSH, which is what the setup
    // flow itself does.
    throw new Error(
      'authorizeKey works on the in-process fixture only; ' +
        'install the key over SSH for ENDPOINT=sshd'
    );
  }
  const dir = path.join(endpoint.localSandboxDir, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'authorized_keys');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${separator}${publicKey.trim()}\n`, { encoding: 'utf8' });
}

/**
 * Authorise `publicKey` on whichever tier is running (A7, AC-T3a).
 *
 * On `sshd` the key has to travel the same road the product does: a
 * password-authenticated connection running the §5.7 install script, which is
 * also what makes the tier prove AC-T4's first item — `StrictModes yes` refuses
 * a key whose `~/.ssh` and `authorized_keys` modes are wrong, so a later
 * key-only connection succeeding is the evidence that 0700/0600 were applied.
 * The script is idempotent through `grep -qxF` (`MARKER_ALREADY_PRESENT`), so
 * re-running it against the container's one reused account never doubles a line.
 *
 * On `fixture` it delegates to {@link authorizeKey}: that server's remote home
 * is a directory on this machine, and an emulated shell (`shellEmulation`)
 * cannot run the install script at all.
 *
 * Every caller goes through this one function rather than branching on
 * `endpoint.kind` itself — three copies of the same branch is exactly how test
 * harnesses drift apart.
 */
export async function authorizeKeyOverSsh(
  endpoint: TestEndpoint,
  publicKey: string
): Promise<void> {
  if (endpoint.kind !== 'sshd') {
    authorizeKey(endpoint, publicKey);
    return;
  }
  await withEndpointClient(endpoint, (client) => installAuthorizedKey(client, publicKey));
}

/**
 * Run `fn` over a short-lived password-authenticated connection to `endpoint`.
 *
 * Password rather than key, because the helpers built on this have to work
 * before any key has been installed, and because it is the one credential both
 * tiers are guaranteed to accept. The connection is per-call and closed again:
 * these helpers are test scaffolding, not the path under test, and borrowing
 * the pool would entangle them with the `closeAll()` a suite runs between cases.
 */
async function withEndpointClient<T>(
  endpoint: TestEndpoint,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await new Promise<Client>((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      resolve(conn);
    });
    conn.on('error', reject);
    conn.connect({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.user,
      password: endpoint.password,
      hostVerifier: (_key: Buffer, verify: (valid: boolean) => void): void => {
        verify(true);
      },
    });
  });

  try {
    return await fn(client);
  } finally {
    client.end();
  }
}

/** An SFTP session on `endpoint`, opened and closed around `fn`. */
async function withSftp<T>(
  endpoint: TestEndpoint,
  fn: (sftp: SFTPWrapper) => Promise<T>
): Promise<T> {
  return withEndpointClient(
    endpoint,
    (client) =>
      new Promise<T>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) {
            reject(err);
            return;
          }
          fn(sftp).then(resolve, reject);
        });
      })
  );
}

/** Absolute path of `name` inside the endpoint's remote home. */
function remoteHomePath(endpoint: TestEndpoint, name: string): string {
  return `${endpoint.remoteHomeDir.replace(/\\/g, '/')}/${name}`;
}

/**
 * Write `content` to `name` in the endpoint's remote home, over SFTP.
 *
 * The reason this exists rather than a `fs.writeFileSync` on `remoteHomeDir`:
 * that path is a directory on this machine only on the fixture tier. Under
 * `ENDPOINT=sshd` it names a path inside the container, so a local write lands
 * in a lookalike directory on the runner, the remote file never appears, and
 * the test fails somewhere far away from the mistake — or worse, passes,
 * because an assertion that a remote file is ABSENT is vacuously true when you
 * are looking at the wrong machine.
 */
export async function writeRemoteFile(
  endpoint: TestEndpoint,
  name: string,
  content: string | Buffer
): Promise<void> {
  const target = remoteHomePath(endpoint, name);
  await withSftp(
    endpoint,
    (sftp) =>
      new Promise<void>((resolve, reject) => {
        sftp.writeFile(target, content, (err) => {
          if (err) reject(err);
          else resolve();
        });
      })
  );
}

/**
 * Whether `name` exists in the endpoint's remote home, asked over SFTP.
 *
 * Use this for both directions. Proving a file is absent is the assertion that
 * matters most in the transfer suite — it is what "the upload was refused"
 * means — and it is exactly the assertion a local `existsSync` turns into a
 * false green on the sshd tier.
 */
export async function remoteFileExists(endpoint: TestEndpoint, name: string): Promise<boolean> {
  const target = remoteHomePath(endpoint, name);
  return withSftp(
    endpoint,
    (sftp) =>
      new Promise<boolean>((resolve) => {
        sftp.stat(target, (err) => {
          resolve(err === undefined || err === null);
        });
      })
  );
}
