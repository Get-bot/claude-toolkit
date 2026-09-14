// Optional end-to-end check against a real, already-configured SSH host alias (i.e. one already
// present in the machine's ~/.ssh-mcp/hosts.json via `ssh-mcp setup`). Gated on SSH_MCP_E2E_HOST;
// skips cleanly — including in CI — when that env var is unset. This is intentionally small: it
// is a smoke check that the built server can reach a real box end-to-end, not a substitute for
// the fixture/sshd integration suite.
//
// Per the plan (§8.7 릴리스 체크리스트 #3): running this against a real host and recording the
// result is a required manual step before a release, but it is not part of the automated
// build-test / real-sshd CI jobs (no real host exists in CI).
//
// Unlike package.test.ts, this file deliberately does NOT redirect SSH_MCP_HOME to a sandbox.
// The whole point of this test is to exercise the real host alias a human already registered
// with `ssh-mcp setup` in the real ~/.ssh-mcp/hosts.json — pointing SSH_MCP_HOME elsewhere would
// make that alias invisible and the test would fail for the wrong reason. Because the spawn below
// lives inside `describe.skipIf(!REAL_HOST_ALIAS)`, it never runs (and never touches the real
// home) unless a human has explicitly set SSH_MCP_E2E_HOST — which never happens in CI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_PROTOCOL_VERSION,
  launchStdioServer,
  sendFrame,
  waitForResponse,
  type JsonRpcRequest,
  type StdioServer,
} from '../fixtures/stdioServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = resolve(__dirname, '..', '..', 'dist', 'index.js');

const REAL_HOST_ALIAS = process.env.SSH_MCP_E2E_HOST;

describe.skipIf(!REAL_HOST_ALIAS)('real host e2e (opt-in, SSH_MCP_E2E_HOST)', () => {
  let server: StdioServer;

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(
        `realHost.test.ts requires a build: ${DIST_ENTRY} does not exist. Run \`npm run build\` first.`
      );
    }
    server = launchStdioServer({ cmd: process.execPath, args: [DIST_ENTRY] });
  });

  afterAll(() => {
    server?.child.kill();
  });

  it(`runs exec("echo ok") on host alias "${REAL_HOST_ALIAS}" end to end`, async () => {
    sendFrame(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ssh-mcp-real-host-e2e', version: '0.0.0' },
      },
    });
    await waitForResponse(server, 1);
    sendFrame(server, { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest);

    sendFrame(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'exec',
        arguments: { host: REAL_HOST_ALIAS, command: 'echo ok' },
      },
    });
    const response = await waitForResponse(server, 2);

    expect(response.result?.isError).not.toBe(true);
    const text = response.result?.content?.map((c) => c.text ?? '').join('') ?? '';
    expect(text).toContain('ok');
  });
});

if (!REAL_HOST_ALIAS) {
  // Vitest requires at least one test in the file to run; describe.skipIf above already reports
  // the suite as skipped, but this makes the "why" visible in default reporter output too.
  describe('real host e2e', () => {
    it.skip('SSH_MCP_E2E_HOST is not set — skipping (this is expected in CI)', () => {});
  });
}
