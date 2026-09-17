/**
 * The stdio MCP server and its registered tools (plan rows 4.1, 4.10, 4.12,
 * 4.13; v1.1 rows C8, D8).
 *
 * Three things live here and nowhere else:
 *
 * - **Registration.** Exactly the `TOOL_NAMES` set, asserted at startup
 *   (AC2.2, AC-H6). A build that registers one fewer or one more fails to start
 *   rather than presenting a surface nobody agreed to.
 * - **The audit wrapper.** Every handler is invoked through `runTool`, so one
 *   call is one audit line on every path, including refusals and throws
 *   (AC20.1).
 * - **Client identity.** `initialize` tells us whether the client can elicit,
 *   which decides Branch A vs Branch B for every later approval (§5.5), and
 *   the M6 warning says so out loud when the answer means token fallback.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import { TOOL_NAMES, type ToolName } from './audit.js';
import { recordClient } from './config/state.js';
import { load, resolveApprovalFallback } from './config/store.js';
import { captureProcessStdout, installStdoutGuard, logger, protocolStdoutStream } from './log.js';
import {
  ELICITATION_TIMEOUT_MS,
  interpretElicitResult,
  type ElicitOutcome,
  type ElicitRequest,
} from './safety/approval.js';
import { resetOutputStore } from './output/store.js';
import { stopSweep } from './safety/tokens.js';
import { closeAll } from './ssh/pool.js';
import { resetSessions } from './ssh/session.js';
import {
  REQUIRE_USER_INTERACTION_ENV,
  requiresUserInteractionEnabled,
  TOOL_ANNOTATIONS,
  toolMeta,
} from './tools/annotations.js';
import { closeSessionTool } from './tools/closeSession.js';
import { createToolContext, type ClientInfo, type ToolContext } from './tools/context.js';
import type { ToolDefinition } from './tools/define.js';
import { downloadTool } from './tools/download.js';
import { execTool } from './tools/exec.js';
import { fetchOutputTool } from './tools/fetchOutput.js';
import { historyTool } from './tools/history.js';
import { listHostsTool } from './tools/listHosts.js';
import { openSessionTool } from './tools/openSession.js';
import { runInSessionTool } from './tools/runInSession.js';
import { uploadTool } from './tools/upload.js';
import { runTool } from './tools/wrap.js';
import { readPackageVersion } from './version.js';

/** Asserted by AC2.1 on the packed tarball. */
export const SERVER_NAME = 'ssh-mcp';

/** Head-room between the approval deadline and the transport request timeout. */
export const ELICIT_TRANSPORT_GRACE_MS = 30_000;

export interface CreateServerOptions {
  /**
   * Approval wait budget in milliseconds, for both the elicitation request and
   * the gate's own timer. Tests inject a short value (AC17.1b); production uses
   * the 300 s default that matches the confirmation token TTL.
   */
  approvalTimeoutMs?: number;
}

export interface ServerHandle {
  mcp: McpServer;
  /** Registration order; the set is asserted to equal `TOOL_NAMES`. */
  toolNames: readonly ToolName[];
  /** Client identity after `initialize`, `null` before it. */
  clientInfo(): ClientInfo | null;
}

/**
 * Whether the client can show a form (plan F6).
 *
 * A bare `elicitation: {}` means form support — that is how the SDK reads it,
 * and reading it any other way would silently push Claude Code onto the token
 * path. Only a declaration that offers `url` and not `form` counts as no form.
 */
export function supportsFormElicitation(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined || elicitation === null) return false;
  const modes = elicitation as { url?: unknown; form?: unknown };
  return !(modes.url !== undefined && modes.form === undefined);
}

/** R12: `approvalMode: auto` executes without asking, so say so once at startup. */
function warnAutoApprovalHosts(): void {
  const config = load();
  if (!config.ok) return;
  const aliases = Object.entries(config.file.hosts)
    .filter(([, entry]) => entry.approvalMode === 'auto')
    .map(([alias]) => alias);
  if (aliases.length === 0) return;
  logger.warn('hosts with approvalMode: auto run every command without asking for approval', {
    hosts: aliases,
  });
}

/**
 * F10: the two controls the server can actually enforce are both off.
 *
 * `requiresUserInteraction` is the one hint Claude Code enforces (it prompts
 * per call even under always-allow), and `approvalFallback: "fail-closed"` is
 * the one refusal the server can make on its own. With the opt-out set and a
 * host on `token`, neither is in force: approval rests entirely on the model
 * asking the user. That is a legitimate configuration for a non-interactive
 * run, so it is said out loud once rather than refused.
 */
function warnUserInteractionOptOut(): void {
  if (requiresUserInteractionEnabled()) return;
  const config = load();
  if (!config.ok) return;
  const tokenHosts = Object.entries(config.file.hosts)
    .filter(([, entry]) => resolveApprovalFallback(entry) === 'token')
    .map(([alias]) => alias);
  if (tokenHosts.length === 0) return;
  logger.warn(
    `${REQUIRE_USER_INTERACTION_ENV}=0 with approvalFallback: token hosts: ` +
      'neither the per-call prompt nor a fail-closed refusal is in force',
    {
      hosts: tokenHosts,
      note: 'approval now depends entirely on the model asking the user; use approvalFallback: fail-closed to make the server refuse instead',
    }
  );
}

/**
 * M6: the client cannot elicit, so these hosts fall back to confirmation
 * tokens — an approval the server cannot verify (PM-4, AC17.11).
 */
function warnTokenFallbackHosts(client: ClientInfo): void {
  if (client.supportsElicitation) return;
  const config = load();
  if (!config.ok) return;
  const tokenHosts = Object.entries(config.file.hosts)
    .filter(([, entry]) => resolveApprovalFallback(entry) === 'token')
    .map(([alias]) => alias);
  if (tokenHosts.length === 0) return;
  logger.warn(
    'connected client does not support elicitation; these hosts fall back to confirmation tokens',
    {
      client: client.name,
      client_version: client.version,
      hosts: tokenHosts,
      normalized_fallback_hosts: config.normalizedFallbackAliases,
      note: 'the server cannot verify that a human approved a token re-call',
    }
  );
}

/** Build the server and register every tool. Does not connect a transport. */
export function createServer(options: CreateServerOptions = {}): ServerHandle {
  const mcp = new McpServer({ name: SERVER_NAME, version: readPackageVersion() });

  let clientInfo: ClientInfo | null = null;

  const elicit = async (request: ElicitRequest): Promise<ElicitOutcome> => {
    const budget = options.approvalTimeoutMs ?? ELICITATION_TIMEOUT_MS;
    const result = await mcp.server.elicitInput(
      { mode: request.mode, message: request.message, requestedSchema: request.requestedSchema },
      // The gate owns the deadline: it turns "no answer" into a refusal. The
      // transport timeout is only a backstop against a request outliving the
      // process, so it must not fire first — the SDK's default is far below the
      // 300 s a person needs, and an expired request would reach the gate as a
      // failed call (fallback) instead of as a refusal.
      { timeout: budget + ELICIT_TRANSPORT_GRACE_MS }
    );
    return interpretElicitResult(result.action, result.content);
  };

  const ctx: ToolContext = createToolContext({
    client: () => clientInfo,
    elicit,
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
  });

  const registered: ToolName[] = [];

  const register = (definition: ToolDefinition): void => {
    const meta = toolMeta(definition.name);
    mcp.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: TOOL_ANNOTATIONS[definition.name],
        ...(meta === undefined ? {} : { _meta: meta }),
      },
      // The result is rebuilt as a literal because `CallToolResult` carries an
      // index signature, which a declared interface cannot satisfy.
      async (args: Record<string, unknown>) => {
        const result = await runTool(definition.name, ctx, (audit) =>
          definition.handler(args, ctx, audit)
        );
        return { content: result.content, isError: result.isError };
      }
    );
    registered.push(definition.name);
  };

  register(listHostsTool);
  register(execTool);
  register(uploadTool);
  register(downloadTool);
  register(openSessionTool);
  register(runInSessionTool);
  register(closeSessionTool);
  register(historyTool);
  register(fetchOutputTool);

  assertRegisteredTools(registered);

  mcp.server.oninitialized = (): void => {
    const version = mcp.server.getClientVersion();
    const capabilities = mcp.server.getClientCapabilities();
    const info: ClientInfo = {
      name: version?.name ?? 'unknown',
      version: version?.version ?? 'unknown',
      supportsElicitation: supportsFormElicitation(capabilities),
    };
    clientInfo = info;

    logger.info('client connected', {
      client: info.name,
      client_version: info.version,
      elicitation: info.supportsElicitation,
    });
    recordClient({
      name: info.name,
      version: info.version,
      elicitation: info.supportsElicitation,
    });
    warnTokenFallbackHosts(info);
  };

  warnAutoApprovalHosts();
  warnUserInteractionOptOut();

  return { mcp, toolNames: registered, clientInfo: () => clientInfo };
}

/**
 * Startup assertion (AC2.2, AC-H6): exactly the {@link TOOL_NAMES} set, each
 * once.
 *
 * Cheap, and it turns "the tool surface changed" into a failure at start rather
 * than into a surprise in someone's client. The expected count is derived from
 * `TOOL_NAMES` rather than written out, so adding a tool to the canonical list
 * and forgetting to register it is the failure, not a number two files apart.
 */
export function assertRegisteredTools(names: readonly string[]): void {
  const expected = [...TOOL_NAMES].sort();
  const actual = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
    throw new Error(
      `ssh-mcp must register exactly ${String(expected.length)} tools ` +
        `(${expected.join(', ')}), but registered ${String(actual.length)}: ${actual.join(', ')}`
    );
  }
}

/** Close pooled connections and sessions and stop timers on shutdown. */
function shutdown(): void {
  try {
    resetSessions();
  } catch (err) {
    logger.debug('session cleanup failed during shutdown', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  closeAll();
  // Retained output is worthless once the transport is gone — nothing can ask
  // for it again — and it is the largest thing this process holds, up to the
  // store's 64 MiB cap (ADR-010).
  resetOutputStore();
  // The token sweep interval is unref'd, so it cannot hold the process open,
  // but leaving it running after the transport closes keeps a timer alive for
  // no reason (CR-12).
  stopSweep();
}

/**
 * Start the stdio server. Resolves when the transport closes.
 *
 * `installStdoutGuard()` runs first so that nothing — ours or a dependency's —
 * can put a stray byte on stdout before the JSON-RPC stream opens (AC2.3).
 */
export async function startServer(): Promise<void> {
  installStdoutGuard();

  const handle = createServer();

  // Belt and braces on top of the console replacement (F19): capture the real
  // writer first, hand that writer to the transport, then redirect everything
  // else that reaches `process.stdout` to stderr. Order matters — the JSON-RPC
  // frames must keep the original stdout while a stray `process.stdout.write`
  // from anywhere else cannot corrupt the stream.
  const protocolStdout = protocolStdoutStream();
  captureProcessStdout();
  const transport = new StdioServerTransport(process.stdin, protocolStdout);

  const closed = new Promise<void>((resolve) => {
    handle.mcp.server.onclose = (): void => {
      resolve();
    };
  });

  await handle.mcp.connect(transport);
  logger.info('ssh-mcp server ready', {
    transport: 'stdio',
    version: readPackageVersion(),
    tools: handle.toolNames.length,
  });

  await closed;
  shutdown();
}
