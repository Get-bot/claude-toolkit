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
import { Client } from 'ssh2';

import type { HostEntry } from '../../src/config/schema.js';
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
