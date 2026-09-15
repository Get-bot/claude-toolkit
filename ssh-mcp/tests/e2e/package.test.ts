// e2e: proves the *packaged* server (not just the source) speaks MCP correctly over stdio.
// Used by the `package-smoke` CI job (Phase 7.4) via `npm run test:e2e`.
//
// Entrypoint resolution:
//   1. SSH_MCP_TGZ env var, if set, must point at a packed tarball (`npm pack` output). The
//      server is launched through npx, the way an end user runs the published package — see
//      `npxLaunch` in tests/fixtures/stdioServer.ts for the exact argv and why it has to be
//      that shape.
//   2. Otherwise, falls back to the built `dist/index.js` (spawned directly with `node`), so this
//      test is also runnable locally after a plain `npm run build` without a full `npm pack`.
//
// The stdio plumbing (spawn, line-delimited JSON-RPC framing, child-fate reporting) lives in
// tests/fixtures/stdioServer.ts, shared with realHost.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_PROTOCOL_VERSION,
  launchStdioServer,
  npxLaunch,
  sendFrame,
  waitForResponse,
  type JsonRpcRequest,
  type Launch,
  type StdioServer,
} from '../fixtures/stdioServer.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..');

/** The package's only `bin` entry (package.json → bin). */
const BIN_NAME = 'ssh-mcp';

const EXPECTED_TOOLS = [
  'list_hosts',
  'exec',
  'upload',
  'download',
  'open_session',
  'run_in_session',
  'close_session',
].sort();

function resolveEntrypoint(): Launch {
  const tgz = process.env.SSH_MCP_TGZ;
  if (tgz) {
    if (!existsSync(tgz)) {
      throw new Error(
        `SSH_MCP_TGZ is set to "${tgz}" but that file does not exist. Run \`npm pack\` first.`
      );
    }
    return npxLaunch(tgz, BIN_NAME);
  }

  const distEntry = resolve(PKG_ROOT, 'dist', 'index.js');
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }

  const tgzInRoot = readdirSync(PKG_ROOT).find((f) => f.endsWith('.tgz'));
  if (tgzInRoot) {
    return npxLaunch(resolve(PKG_ROOT, tgzInRoot), BIN_NAME);
  }

  throw new Error(
    'package.test.ts: no entrypoint found. Set SSH_MCP_TGZ to a packed tarball ' +
      '(from `npm pack`), or run `npm run build` to produce dist/index.js.'
  );
}

describe('package e2e — npm pack / npx smoke (AC1, AC2)', () => {
  let server: StdioServer;
  let home: TmpHome;

  beforeAll(() => {
    // The spawned server writes state.json on `initialize` (last-client record) and would do so
    // into the real ~/.ssh-mcp if left unpointed. createTmpHome() redirects SSH_MCP_HOME (and
    // HOME/USERPROFILE) on process.env *before* the spawn below, and the explicit `env` still
    // pins the child to it even if something upstream changes process.env later in the run.
    home = createTmpHome('ssh-mcp-e2e-package-');
    server = launchStdioServer(resolveEntrypoint(), { ...process.env, SSH_MCP_HOME: home.dir });
  });

  afterAll(() => {
    server?.child.kill();
    // Must run before home.cleanup() (which restores process.env) — see tmpHome.ts.
    assertNoWritesOutside(home);
    home.cleanup();
  });

  it("responds to initialize with serverInfo.name === 'ssh-mcp'", async () => {
    sendFrame(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ssh-mcp-package-e2e', version: '0.0.0' },
      },
    });

    const response = await waitForResponse(server, 1);
    expect(response.result?.serverInfo?.name).toBe('ssh-mcp');
  });

  it('accepts notifications/initialized and then lists exactly the 7 spec tools', async () => {
    // Notifications carry no `id` and expect no response frame.
    sendFrame(server, { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest);

    sendFrame(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForResponse(server, 2);

    const names = (response.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toHaveLength(7);
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  // AC2.3: stdout carries JSON-RPC frames and nothing else. The reader records every non-empty
  // stdout line it could not parse, so by this point the list is the complete evidence — a
  // banner, a deprecation warning or a stray console.log on the wrong stream all land here.
  it('put nothing but JSON-RPC frames on stdout (AC2.3)', () => {
    expect(server.nonJsonStdoutLines).toEqual([]);
  });
});

// The routing in index.ts has no unit test — importing that module runs the CLI — so the only
// place "the help token actually reaches the help code" can be checked is here, against the
// real entrypoint. It is worth checking: all three tokens used to fall through into server mode,
// where the process printed nothing and waited on stdin until it was killed. A regression would
// look exactly like that again, which is why these assert termination as much as output.
describe('package e2e — top-level help reaches the terminal, not the server', () => {
  const launch = (): Launch => resolveEntrypoint();

  it.each(['--help', '-h', 'help'])('`%s` prints the command list and exits 0', (token) => {
    const { cmd, args } = launch();
    const result = spawnSync(cmd, [...args, token], {
      encoding: 'utf8',
      // Closed stdin, so a server-mode regression ends instead of hanging the suite. The timeout
      // is the backstop for a build that ignores EOF.
      input: '',
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp');
    for (const command of ['install', 'host add', 'host list', 'doctor']) {
      expect(result.stdout).toContain(command);
    }
    // Server mode announces itself on stderr; help mode has nothing to say there.
    expect(result.stderr).not.toContain('server ready');
  });

  it('`help doctor` forwards to that command rather than the overview', () => {
    const { cmd, args } = launch();
    const result = spawnSync(cmd, [...args, 'help', 'doctor'], {
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp doctor');
  });

  it('refuses a command it does not have, on stderr', () => {
    const { cmd, args } = launch();
    const result = spawnSync(cmd, [...args, 'help', 'bogus'], {
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('bogus');
  });
});
