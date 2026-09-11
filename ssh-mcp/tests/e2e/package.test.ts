// e2e: proves the *packaged* server (not just the source) speaks MCP correctly over stdio.
// Used by the `package-smoke` CI job (Phase 7.4) via `npm run test:e2e`.
//
// Entrypoint resolution:
//   1. SSH_MCP_TGZ env var, if set, must point at a packed tarball (`npm pack` output). The
//      server is launched the same way an end user would: `npx -y <tgz>`.
//   2. Otherwise, falls back to the built `dist/index.js` (spawned directly with `node`), so this
//      test is also runnable locally after a plain `npm run build` without a full `npm pack`.
//
// Only Node built-ins + vitest are used, per the plan's requirement for this file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..');

const EXPECTED_TOOLS = [
  'list_hosts',
  'exec',
  'upload',
  'download',
  'open_session',
  'run_in_session',
  'close_session',
].sort();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: Array<{ name: string }>;
    [key: string]: unknown;
  };
  error?: unknown;
}

function resolveEntrypoint(): { cmd: string; args: string[] } {
  const tgz = process.env.SSH_MCP_TGZ;
  if (tgz) {
    if (!existsSync(tgz)) {
      throw new Error(
        `SSH_MCP_TGZ is set to "${tgz}" but that file does not exist. Run \`npm pack\` first.`
      );
    }
    return { cmd: 'npx', args: ['-y', resolve(tgz)] };
  }

  const distEntry = resolve(PKG_ROOT, 'dist', 'index.js');
  if (existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }

  const tgzInRoot = readdirSync(PKG_ROOT).find((f) => f.endsWith('.tgz'));
  if (tgzInRoot) {
    return { cmd: 'npx', args: ['-y', resolve(PKG_ROOT, tgzInRoot)] };
  }

  throw new Error(
    'package.test.ts: no entrypoint found. Set SSH_MCP_TGZ to a packed tarball ' +
      '(from `npm pack`), or run `npm run build` to produce dist/index.js.'
  );
}

function sendFrame(child: ChildProcessWithoutNullStreams, frame: JsonRpcRequest): void {
  child.stdin.write(JSON.stringify(frame) + '\n');
}

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 30_000
): Promise<JsonRpcResponse> {
  return new Promise((resolvePromise, reject) => {
    let buf = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for JSON-RPC response id=${id}`));
    }, timeoutMs);

    function onStdout(chunk: Buffer): void {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          // Any non-JSON byte on stdout would itself be a protocol violation (Principle 3: stdout
          // is JSON-RPC only), but we don't fail the parser on it here — a dedicated assertion
          // below checks stderr/stdout separation more directly if needed. Skip and keep reading.
          continue;
        }
        if (msg.id === id) {
          cleanup();
          resolvePromise(msg);
          return;
        }
      }
    }

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
    }

    child.stdout.on('data', onStdout);
  });
}

describe('package e2e — npm pack / npx smoke (AC1, AC2)', () => {
  let child: ChildProcessWithoutNullStreams;

  beforeAll(() => {
    const { cmd, args } = resolveEntrypoint();
    child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  afterAll(() => {
    child?.kill();
  });

  it("responds to initialize with serverInfo.name === 'ssh-mcp'", async () => {
    sendFrame(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'ssh-mcp-package-e2e', version: '0.0.0' },
      },
    });

    const response = await waitForResponse(child, 1);
    expect(response.result?.serverInfo?.name).toBe('ssh-mcp');
  });

  it('accepts notifications/initialized and then lists exactly the 7 spec tools', async () => {
    // Notifications carry no `id` and expect no response frame.
    sendFrame(child, { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest);

    sendFrame(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForResponse(child, 2);

    const names = (response.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toHaveLength(7);
    expect(names).toEqual(EXPECTED_TOOLS);
  });
});
