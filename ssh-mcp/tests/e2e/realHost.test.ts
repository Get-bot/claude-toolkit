// Optional end-to-end check against a real, already-configured SSH host alias (i.e. one already
// present in the machine's ~/.ssh-mcp/hosts.json via `ssh-mcp setup`). Gated on SSH_MCP_E2E_HOST;
// skips cleanly — including in CI — when that env var is unset. This is intentionally small: it
// is a smoke check that the built server can reach a real box end-to-end, not a substitute for
// the fixture/sshd integration suite.
//
// Per the plan (§8.7 릴리스 체크리스트 #3): running this against a real host and recording the
// result is a required manual step before a release, but it is not part of the automated
// build-test / real-sshd CI jobs (no real host exists in CI).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

const REAL_HOST_ALIAS = process.env.SSH_MCP_E2E_HOST;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: unknown;
}

function sendFrame(child: ChildProcessWithoutNullStreams, frame: JsonRpcRequest): void {
  child.stdin.write(JSON.stringify(frame) + "\n");
}

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 30_000,
): Promise<JsonRpcResponse> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for JSON-RPC response id=${id}`));
    }, timeoutMs);

    function onStdout(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
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
      child.stdout.off("data", onStdout);
    }
    child.stdout.on("data", onStdout);
  });
}

describe.skipIf(!REAL_HOST_ALIAS)("real host e2e (opt-in, SSH_MCP_E2E_HOST)", () => {
  let child: ChildProcessWithoutNullStreams;

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(
        `realHost.test.ts requires a build: ${DIST_ENTRY} does not exist. Run \`npm run build\` first.`,
      );
    }
    child = spawn(process.execPath, [DIST_ENTRY], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  });

  afterAll(() => {
    child?.kill();
  });

  it(`runs exec("echo ok") on host alias "${REAL_HOST_ALIAS}" end to end`, async () => {
    sendFrame(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "ssh-mcp-real-host-e2e", version: "0.0.0" },
      },
    });
    await waitForResponse(child, 1);
    sendFrame(child, { jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcRequest);

    sendFrame(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "exec",
        arguments: { host: REAL_HOST_ALIAS, command: "echo ok" },
      },
    });
    const response = await waitForResponse(child, 2);

    expect(response.result?.isError).not.toBe(true);
    const text = response.result?.content?.map((c) => c.text ?? "").join("") ?? "";
    expect(text).toContain("ok");
  });
});

if (!REAL_HOST_ALIAS) {
  // Vitest requires at least one test in the file to run; describe.skipIf above already reports
  // the suite as skipped, but this makes the "why" visible in default reporter output too.
  describe("real host e2e", () => {
    it.skip("SSH_MCP_E2E_HOST is not set — skipping (this is expected in CI)", () => {});
  });
}
