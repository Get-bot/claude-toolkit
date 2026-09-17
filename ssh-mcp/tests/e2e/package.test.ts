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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../../src/audit.js';
import {
  MCP_PROTOCOL_VERSION,
  RESPONSE_TIMEOUT_MS,
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

/**
 * The tool surface, taken from the canonical list in `src/audit.ts` instead of
 * retyped here.
 *
 * The retyped copy was wrong within one release: v1.1 added `history` and
 * `fetch_output`, and a hardcoded seven names plus `toHaveLength(7)` turns that
 * into a red package-smoke job that says nothing about packaging. Deriving it
 * sharpens the claim rather than weakening it — "the packed tarball exposes
 * exactly the surface the source declares" is what this leg is for, and a
 * server and a `TOOL_NAMES` that disagree is precisely the bug worth catching.
 * The count stays visible in the test name, which cannot go stale either.
 */
const EXPECTED_TOOLS = [...TOOL_NAMES].sort();

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

// Every spawn in this file gets the same throwaway home. The server writes state.json on
// `initialize` (last-client record) and would do so into the real ~/.ssh-mcp if left unpointed —
// on purpose in the smoke test below, and by regression in the help tests, whose failure mode is
// exactly "dropped into server mode". createTmpHome() redirects SSH_MCP_HOME (and HOME/USERPROFILE)
// on process.env *before* any spawn, and each spawn's explicit `env` still pins the child to it
// even if something upstream changes process.env later in the run.
let home: TmpHome;

beforeAll(() => {
  home = createTmpHome('ssh-mcp-e2e-package-');
});

afterAll(() => {
  // Must run before home.cleanup() (which restores process.env) — see tmpHome.ts.
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('package e2e — npm pack / npx smoke (AC1, AC2)', () => {
  let server: StdioServer;

  beforeAll(() => {
    server = launchStdioServer(resolveEntrypoint(), { ...process.env, SSH_MCP_HOME: home.dir });
  });

  afterAll(() => {
    server?.child.kill();
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

  it(`accepts notifications/initialized and then lists exactly the ${String(EXPECTED_TOOLS.length)} spec tools`, async () => {
    // Notifications carry no `id` and expect no response frame.
    sendFrame(server, { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest);

    sendFrame(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForResponse(server, 2);

    const names = (response.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
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
//
// Under SSH_MCP_TGZ every spawn is an npx round-trip, so the cases are only what a real process
// can prove: each help spelling is routed; a forwarded command's *default* writer is stdout
// (`install` and `host add` used to put their usage on stderr, and the unit tests only see
// injected writers); words after the command are forwarded; a usage error's exit code reaches
// the process. Which commands are routable is settled by the `COMMANDS` table and the compiler,
// and `help <command>` forwarding for every entry is covered in tests/unit/helpCommand.test.ts.
describe('package e2e — top-level help reaches the terminal, not the server', () => {
  function runHelpBinary(extra: string[]): SpawnSyncReturns<string> {
    const { cmd, args } = resolveEntrypoint();
    return spawnSync(cmd, [...args, ...extra], {
      encoding: 'utf8',
      // Closed stdin, so a server-mode regression ends instead of hanging the suite. The timeout
      // is the backstop for a build that ignores EOF, and it is the fixture's measured npx budget
      // rather than a smaller guess — under SSH_MCP_TGZ every one of these goes through npx.
      input: '',
      timeout: RESPONSE_TIMEOUT_MS,
      env: { ...process.env, SSH_MCP_HOME: home.dir },
    });
  }

  it.each(['--help', '-h', 'help'])('`%s` prints the command list and exits 0', (token) => {
    const result = runHelpBinary([token]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp');
    for (const command of ['install', 'host add', 'host list', 'doctor']) {
      expect(result.stdout).toContain(command);
    }
    // Server mode announces itself on stderr; help mode has nothing to say there.
    expect(result.stderr).not.toContain('server ready');
  });

  // `install --help` used to write its usage to stderr, so `ssh-mcp help install > out.txt`
  // produced an empty file with exit 0 while `help doctor` did not — same verb, opposite behavior.
  it('`help install` forwards to that command, on stdout', () => {
    const result = runHelpBinary(['help', 'install']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp install');
    // Not `toBe('')`: under npx the wrapper may add its own stderr noise. What must not be
    // there is the usage itself.
    expect(result.stderr).not.toContain('Usage:');
  });

  // `host add` is the other command whose usage moved to stdout, and the group usage with `add`
  // silently dropped is not what anyone typing this meant.
  it('`help host add` reaches `host add`, not the host group, on stdout', () => {
    const result = runHelpBinary(['help', 'host', 'add']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ssh-mcp host add');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('refuses a command it does not have, on stderr', () => {
    const result = runHelpBinary(['help', 'bogus']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('bogus');
  });
});
