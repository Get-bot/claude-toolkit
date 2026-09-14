/**
 * Driving the server as a real child process over stdio (plan §Phase 7.4, AC2).
 *
 * Both e2e files need the same three things — spawn the server, push JSON-RPC
 * frames at its stdin, and read line-delimited frames back off its stdout —
 * and both previously carried their own copy. They drifted: the copy in
 * `package.test.ts` learned to report the child's exit code and stderr after
 * a CI run spent 30 s timing out on a child that had died in 0.6 s, while the
 * copy in `realHost.test.ts` (a required pre-release gate) kept the version
 * that only says "timed out". One implementation, so the better diagnostics
 * reach both.
 *
 * Framework-agnostic on purpose — Node built-ins only, no vitest import — so
 * it stays usable from either e2e file and from a plain script.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

/** The MCP protocol version both e2e files negotiate with. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** How much stderr to keep for failure messages. */
const STDERR_TAIL_BYTES = 4096;

/**
 * Generous because the npx path installs the tarball and its dependencies into a cold cache
 * first. A healthy run answers in well under 30 s on both CI runners (measured: 8.6 s on Linux,
 * 14.9 s for the Windows `cmd /c` form); the budget only decides how long a broken run takes to
 * fail.
 */
export const RESPONSE_TIMEOUT_MS = 60_000;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: unknown;
}

/** A command line: what to spawn and with which argv. */
export interface Launch {
  cmd: string;
  args: string[];
}

/**
 * How to run a packed tarball through npx, in one place.
 *
 * `--package=<tgz> <bin>` and never a bare `npx -y <tgz>`: given a bare argument, npm
 * (libnpmexec) first looks for an already-installed bin of that name with
 * `path.resolve(<dir>/node_modules/.bin, arg)`. An *absolute* tarball path resolves to itself,
 * the file exists, and npx runs the .tgz as the command instead of installing it — `Exec format
 * error` (exit 126) on Linux, the .tgz file association on Windows. Naming the package
 * explicitly makes npx install the tarball into its cache and run the named bin. Verified on
 * npm 10.8.2 (the CI runner's) and 11.x.
 *
 * On Windows `npx` is a `.cmd` shim, and `spawn(..., { shell: false })` cannot execute a .cmd
 * directly (ENOENT) — the very failure the README's Windows section documents and the
 * `windows-spawn` CI job proves. `cmd /c` lets cmd.exe resolve the shim's PATHEXT association.
 */
export function npxLaunch(tgz: string, binName: string): Launch {
  const npxArgs = ['-y', `--package=${resolve(tgz)}`, binName];
  return process.platform === 'win32'
    ? { cmd: 'cmd', args: ['/c', 'npx', ...npxArgs] }
    : { cmd: 'npx', args: npxArgs };
}

/**
 * The server child, a persistent reader of its stdout, and enough of its fate to explain a
 * missing response. The reader lives here rather than in each wait so that no byte is lost
 * between two waits and a chunk carrying two frames keeps both.
 */
export interface StdioServer {
  child: ChildProcessWithoutNullStreams;
  /** Complete JSON-RPC frames read from stdout and not yet claimed by a waiter. */
  inbox: JsonRpcResponse[];
  /** Non-empty stdout lines that were not JSON — a protocol violation (AC2.3). */
  nonJsonStdoutLines: string[];
  /** Emits `update` whenever a frame arrives or the child's fate is settled. */
  events: EventEmitter;
  /** Set when the child exits, so a wait fails at once instead of running out its timeout. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** Set if the spawn itself failed (e.g. ENOENT). Node emits this asynchronously. */
  spawnError: Error | null;
  /** The last few KiB of stderr, quoted in failure messages. */
  stderrTail: string;
}

export function launchStdioServer(launch: Launch, env?: NodeJS.ProcessEnv): StdioServer {
  const child = spawn(launch.cmd, launch.args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(env ? { env } : {}),
  });
  const server: StdioServer = {
    child,
    inbox: [],
    nonJsonStdoutLines: [],
    events: new EventEmitter(),
    exit: null,
    spawnError: null,
    stderrTail: '',
  };

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        server.inbox.push(JSON.parse(line) as JsonRpcResponse);
      } catch {
        // stdout is the JSON-RPC channel and nothing else (Principle 3), so a non-JSON line is
        // itself a violation. Record it for the AC2.3 assertion and keep reading — failing the
        // reader here would replace a precise assertion with an unhelpful parse error.
        server.nonJsonStdoutLines.push(line);
      }
    }
    server.events.emit('update');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    server.stderrTail = (server.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  child.on('exit', (code, signal) => {
    server.exit = { code, signal };
  });
  // The fate signal waits for `close`, not `exit`: Node fires `exit` before the stdio pipes are
  // drained, so a failure message built on `exit` would usually miss the stderr that explains it.
  child.on('close', () => {
    server.events.emit('update');
  });
  child.on('error', (err) => {
    server.spawnError = err;
    server.events.emit('update');
  });
  return server;
}

/** Why no response came: the child's status, plus whatever it said on stderr. */
export function describeFate(server: StdioServer): string {
  // `spawnError` and `exit` are mutually exclusive — Node emits `error` + `close` for a spawn
  // that never started, and `exit` only for one that did.
  const what = server.spawnError
    ? `spawn failed: ${server.spawnError.message}`
    : server.exit
      ? `server process exited with code=${server.exit.code} signal=${server.exit.signal}`
      : 'server process is still running';
  const tail = server.stderrTail.trim();
  return tail ? `${what}; stderr tail:\n${tail}` : what;
}

export function sendFrame(server: StdioServer, frame: JsonRpcRequest): void {
  server.child.stdin.write(JSON.stringify(frame) + '\n');
}

/** Remove and return the response with this id, if it has already arrived. */
function takeResponse(server: StdioServer, id: number): JsonRpcResponse | undefined {
  const index = server.inbox.findIndex((msg) => msg.id === id);
  return index === -1 ? undefined : server.inbox.splice(index, 1)[0];
}

/**
 * Resolve with the response carrying `id`, or reject as soon as it is knowable that none will
 * come — a child that died (or never started) is the answer "no response, ever", reported with
 * its exit status and stderr instead of a bare timeout.
 */
export function waitForResponse(
  server: StdioServer,
  id: number,
  timeoutMs = RESPONSE_TIMEOUT_MS
): Promise<JsonRpcResponse> {
  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      check();
    }, timeoutMs);

    // One condition, checked on every event and once up front: "has my frame arrived, and if
    // not, is it still possible for it to?". The up-front call covers a response that landed
    // before this wait started and a child that was already gone.
    function check(): void {
      const msg = takeResponse(server, id);
      if (msg) return finish(msg);
      // A frame that arrived just before the pipes closed still counts, which is why the take
      // above runs first.
      if (server.exit || server.spawnError || timedOut) finish();
    }

    function finish(msg?: JsonRpcResponse): void {
      clearTimeout(timer);
      server.events.off('update', check);
      if (msg) resolvePromise(msg);
      else if (timedOut) {
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for JSON-RPC response id=${id}; ${describeFate(server)}`
          )
        );
      } else {
        reject(new Error(`no JSON-RPC response id=${id}: ${describeFate(server)}`));
      }
    }

    server.events.on('update', check);
    check();
  });
}
