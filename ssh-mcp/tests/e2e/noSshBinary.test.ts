/**
 * e2e: the server does not need OpenSSH (plan F15, 부록 B-1, guards G-1/G-2).
 *
 * `connect` and `exec` delegate to the system `ssh`. That is a deliberate
 * exception to this package's "pure JS, works on a Windows box with no
 * OpenSSH" promise (D6), and the promise only survives if the exception stays
 * inside those two commands. Four guards keep it there, and three of them are
 * checked statically — ESLint refuses the import (G-1), the thunk in
 * `commands.ts` is the only entry (G-2), `doctor` reports `ssh` as INFO (G-4).
 * A static check can only prove that the code *looks* independent. This file
 * proves it *is*, by running the real bundle with nothing on `PATH` at all:
 *
 *   - `--version` and `doctor` still exit 0, so the CLI did not die at link
 *     time and no check turned "no ssh" into a failure;
 *   - `initialize` + `tools/list` still answer with the full tool set, so the
 *     MCP surface is unchanged.
 *
 * An empty `PATH` is a stronger condition than "no ssh installed" and a much
 * easier one to arrange: any machine can be put in it, including a CI runner
 * that ships OpenSSH. `process.execPath` is absolute, so node itself still
 * starts.
 *
 * **Always `dist/index.js`, never the packed tarball**, unlike
 * `package.test.ts`: `npx` is resolved through `PATH`, so the npx route cannot
 * exist in a test whose premise is that `PATH` is empty. The bundle is the
 * artifact under test either way — that is where the hoisted top-level imports
 * of the whole package end up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../../src/audit.js';
import {
  MCP_PROTOCOL_VERSION,
  RESPONSE_TIMEOUT_MS,
  launchStdioServer,
  sendFrame,
  waitForResponse,
  type JsonRpcRequest,
  type StdioServer,
} from '../fixtures/stdioServer.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = resolve(__dirname, '..', '..', 'dist', 'index.js');

let home: TmpHome;

/**
 * The child's environment: everything this process has, minus `PATH`.
 *
 * `SystemRoot`, `TEMP` and the rest stay — the claim under test is "no `ssh` is
 * reachable", not "no Windows". Both spellings are deleted because a Windows
 * environment block is case-insensitive but a plain object is not, and this one
 * is handed to `spawn` as a plain object.
 */
function envWithoutPath(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_MCP_HOME: home.dir };
  delete env.PATH;
  delete env.Path;
  delete env.path;
  return env;
}

beforeAll(() => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `noSshBinary.test.ts: ${DIST_ENTRY} does not exist. Run \`npm run build\` first — this ` +
        'test inspects the bundle, and it cannot go through npx because npx needs PATH.'
    );
  }
  home = createTmpHome('ssh-mcp-e2e-no-ssh-');
});

afterAll(() => {
  // Must run before home.cleanup() (which restores process.env) — see tmpHome.ts.
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('the CLI runs with an empty PATH (부록 B-1)', () => {
  function runBinary(args: readonly string[]): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [DIST_ENTRY, ...args], {
      encoding: 'utf8',
      // Closed stdin so a routing regression that drops into server mode ends
      // instead of hanging the suite, exactly as package.test.ts does.
      input: '',
      timeout: RESPONSE_TIMEOUT_MS,
      env: envWithoutPath(),
    });
  }

  it('prints a version and exits 0', () => {
    // The failure this catches is not subtle: a top-level named import of a
    // builtin the running Node lacks kills the entry file before any statement
    // runs, and `--version` is the cheapest proof that it did not
    // (scripts/assert-bundle-imports.mjs, G-3).
    const result = runBinary(['--version']);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('runs doctor and exits 0, reporting the missing ssh as information (G-4)', () => {
    const result = runBinary(['doctor', '--json']);

    expect(result.error).toBeUndefined();
    // Exit 1 here would mean some check called "no OpenSSH" a failure, which
    // would also turn the `no-build-tools` CI job red on a healthy machine.
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const row = payload.checks.find((check) => check.id === 'ssh-binary');
    expect(row?.status).toBe('INFO');
    expect(payload.checks.filter((check) => check.status === 'FAIL')).toEqual([]);
    expect(payload.ok).toBe(true);
  });

  it('routes `connect` to a real refusal rather than crashing or hanging', () => {
    // The sandbox registry is empty, and the alias lookup deliberately runs
    // before the `ssh` lookup, so the deterministic answer here is
    // `host_not_found` with exit 2 — which is the point: the command was
    // reached through the thunk, parsed its argv and refused politely on a
    // machine where `ssh` is unreachable. The missing-`ssh` branch itself needs
    // a controlled registry and is pinned in tests/unit/connectCli.test.ts.
    const result = runBinary(['connect', 'nosuchhost']);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('host_not_found');
    // A refusal is not output: nothing belongs on stdout here.
    expect(result.stdout).toBe('');
  });

  it('prints `connect --help` to stdout and exits 0 (AC-C5)', () => {
    const result = runBinary(['connect', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp connect');
  });
});

describe('the MCP surface is unchanged with an empty PATH (G-1, G-2)', () => {
  let server: StdioServer;

  beforeAll(() => {
    server = launchStdioServer({ cmd: process.execPath, args: [DIST_ENTRY] }, envWithoutPath());
  });

  afterAll(() => {
    server?.child.kill();
  });

  it('answers initialize', async () => {
    sendFrame(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ssh-mcp-no-ssh-e2e', version: '0.0.0' },
      },
    });

    const response = await waitForResponse(server, 1);
    expect(response.result?.serverInfo?.name).toBe('ssh-mcp');
  });

  it('lists the full registered tool set', async () => {
    sendFrame(server, { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest);
    sendFrame(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForResponse(server, 2);

    // The count comes from `TOOL_NAMES` in src/audit.ts rather than being
    // typed out here, because that array is the canonical list (src/AGENTS.md)
    // and this test's claim is "the same tools as anywhere else, even with no
    // ssh" — not "this many tools". A release that changes the surface changes
    // both sides at once, and a release that changes only one is the bug.
    const names = (response.result?.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it('put nothing but JSON-RPC frames on stdout (AC2.3)', () => {
    expect(server.nonJsonStdoutLines).toEqual([]);
  });
});
