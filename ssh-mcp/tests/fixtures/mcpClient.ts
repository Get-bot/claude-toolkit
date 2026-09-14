/**
 * An SDK client wired to our real server over `InMemoryTransport` (§6.2).
 *
 * The tests exercise the tools the way a host does — `tools/list`,
 * `tools/call`, `elicitation/create` — instead of calling handlers directly,
 * because the parts most worth testing (the `_meta` round trip, the capability
 * declaration that decides Branch A vs Branch B, the audit line per call) only
 * exist once a request has been through the protocol.
 *
 * Branches are parameterised by the client's declared capabilities, never by
 * the client's name: Claude Desktop not declaring elicitation and Claude Code
 * declaring it are facts about today, and a test that pinned those names would
 * pass for the wrong reason the day either changes.
 */
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { ensureHome, hostsFilePath } from '../../src/config/paths.js';
import { CONFIG_SCHEMA_VERSION, type HostEntry } from '../../src/config/schema.js';
import { createServer, type CreateServerOptions, type ServerHandle } from '../../src/server.js';

/**
 * How the test client declares elicitation.
 *
 * - `form`: `{ elicitation: { form: {} } }` — explicit form support.
 * - `bare`: `{ elicitation: {} }` — no sub-fields, which the spec and the SDK
 *   read as form support (AC17.1c).
 * - `url-only`: `{ elicitation: { url: {} } }` — no form, so Branch B.
 * - `none`: the capability is not declared at all.
 */
export type ElicitationMode = 'form' | 'bare' | 'url-only' | 'none';

export interface ElicitAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface ElicitRequestSeen {
  message: string;
  requestedSchema: unknown;
}

export interface McpTestClientOptions extends CreateServerOptions {
  elicitation?: ElicitationMode;
  /**
   * Answer for each `elicitation/create`. Returning a never-resolving promise
   * reproduces "the human never answered" (AC17.1b); throwing reproduces a
   * failing call (AC17.13).
   */
  onElicit?: (request: ElicitRequestSeen) => ElicitAnswer | Promise<ElicitAnswer>;
}

export interface ToolCallOutcome {
  isError: boolean;
  /** Parsed `content[0].text`; every tool in this server answers with JSON. */
  body: Record<string, unknown>;
  raw: CallToolResult;
  text: string;
}

export interface McpTestClient {
  client: Client;
  server: ServerHandle;
  /** Every elicitation request the server sent, in order. */
  elicitRequests: ElicitRequestSeen[];
  listTools(): Promise<Tool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallOutcome>;
  close(): Promise<void>;
}

function capabilitiesFor(mode: ElicitationMode): ClientCapabilities {
  switch (mode) {
    case 'form':
      return { elicitation: { form: {} } };
    case 'bare':
      return { elicitation: {} };
    case 'url-only':
      return { elicitation: { url: {} } };
    case 'none':
      return {};
  }
}

/** Start the real server and a client joined to it by an in-memory pair. */
export async function startMcpTestClient(
  options: McpTestClientOptions = {}
): Promise<McpTestClient> {
  const mode = options.elicitation ?? 'none';
  const elicitRequests: ElicitRequestSeen[] = [];

  const serverOptions: CreateServerOptions =
    options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs };
  const server = createServer(serverOptions);

  const client = new Client(
    { name: 'ssh-mcp-test-client', version: '1.2.3' },
    { capabilities: capabilitiesFor(mode) }
  );

  if (mode !== 'none') {
    client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
      const seen: ElicitRequestSeen = {
        message: request.params.message,
        requestedSchema:
          'requestedSchema' in request.params ? request.params.requestedSchema : null,
      };
      elicitRequests.push(seen);
      if (options.onElicit === undefined) return { action: 'decline' };
      const answer = await options.onElicit(seen);
      return answer.content === undefined
        ? { action: answer.action }
        : { action: answer.action, content: answer.content as ElicitResult['content'] };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    elicitRequests,
    async listTools(): Promise<Tool[]> {
      const result = await client.listTools();
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
      const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = raw.content[0];
      const text = first !== undefined && first.type === 'text' ? first.text : '';
      let body: Record<string, unknown> = {};
      if (text !== '') {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
          body = parsed as Record<string, unknown>;
        }
      }
      return { isError: raw.isError === true, body, raw, text };
    },
    async close(): Promise<void> {
      await client.close();
      await server.mcp.close();
    },
  };
}

/**
 * Write `hosts.json` inside the current sandbox home.
 *
 * Tests build entries with `hostEntryFor()` and then register them under the
 * aliases they want; going through the file (rather than through an injected
 * object) is the point, since every tool re-reads the registry per call.
 */
export function writeRegistry(hosts: Record<string, HostEntry & { alias?: string }>): void {
  const entries: Record<string, HostEntry> = {};
  for (const [alias, entry] of Object.entries(hosts)) {
    // `hostEntryFor()` carries the alias inside the entry for the pool, but the
    // schema is strict and the file keys by alias already.
    const { alias: _alias, ...rest } = entry;
    entries[alias] = rest;
  }
  ensureHome();
  fs.writeFileSync(
    hostsFilePath(),
    `${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, hosts: entries }, null, 2)}\n`,
    'utf8'
  );
}
