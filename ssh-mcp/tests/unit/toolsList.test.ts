/**
 * `tools/list` over a real client-server pair (AC2.2, AC17.9, AC17.10, M2).
 *
 * The response is asserted field by field rather than by snapshot: v1.30.0 adds
 * `execution: { taskSupport: 'forbidden' }` that we never set, so comparing
 * whole tool objects would break on an SDK patch release for no reason (§6.2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '../../src/audit.js';
import {
  REQUIRES_USER_INTERACTION_KEY,
  REQUIRE_USER_INTERACTION_ENV,
  TOOL_ANNOTATIONS,
} from '../../src/tools/annotations.js';
import { TOOL_DESCRIPTION_APPROVAL_RULE } from '../../src/safety/approval.js';
import { assertSevenTools, SERVER_NAME } from '../../src/server.js';
import { CLOSE_SESSION_DESCRIPTION } from '../../src/tools/closeSession.js';
import { DOWNLOAD_DESCRIPTION } from '../../src/tools/download.js';
import { EXEC_DESCRIPTION } from '../../src/tools/exec.js';
import { LIST_HOSTS_DESCRIPTION } from '../../src/tools/listHosts.js';
import { OPEN_SESSION_DESCRIPTION } from '../../src/tools/openSession.js';
import { RUN_IN_SESSION_DESCRIPTION } from '../../src/tools/runInSession.js';
import { UPLOAD_DESCRIPTION } from '../../src/tools/upload.js';
import { startMcpTestClient, type McpTestClient } from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;
let harness: McpTestClient | null = null;
const previousEnv = process.env[REQUIRE_USER_INTERACTION_ENV];

beforeEach(() => {
  home = createTmpHome('ssh-mcp-tools-list-');
});

afterEach(async () => {
  if (harness !== null) await harness.close();
  harness = null;
  if (previousEnv === undefined) delete process.env[REQUIRE_USER_INTERACTION_ENV];
  else process.env[REQUIRE_USER_INTERACTION_ENV] = previousEnv;
  assertNoWritesOutside(home);
  home.cleanup();
});

function properties(schema: unknown): Record<string, { description?: string }> {
  if (typeof schema !== 'object' || schema === null) return {};
  const props = (schema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null) return {};
  return props as Record<string, { description?: string }>;
}

describe('tools/list (AC2.2)', () => {
  it('advertises exactly the seven v1 tools', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(harness.server.toolNames).toHaveLength(7);
  });

  it('reports the server name the acceptance criteria pin', async () => {
    harness = await startMcpTestClient();
    expect(harness.client.getServerVersion()?.name).toBe(SERVER_NAME);
  });

  it('refuses to start when the registered set is not the seven', () => {
    expect(() => {
      assertSevenTools(['exec', 'list_hosts']);
    }).toThrow(/exactly 7 tools/);
    expect(() => {
      assertSevenTools([...TOOL_NAMES, 'exec']);
    }).toThrow(/exactly 7 tools/);
    expect(() => {
      assertSevenTools([...TOOL_NAMES]);
    }).not.toThrow();
  });
});

describe('annotations (§5.6)', () => {
  it('round-trips the annotation table unchanged', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    for (const tool of tools) {
      const name = tool.name as keyof typeof TOOL_ANNOTATIONS;
      expect(tool.annotations).toEqual(TOOL_ANNOTATIONS[name]);
    }
  });

  it('marks only list_hosts read-only', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
    expect(readOnly.map((tool) => tool.name)).toEqual(['list_hosts']);
  });
});

describe('requiresUserInteraction _meta (AC17.9, AC17.10)', () => {
  it('attaches the key to exec and run_in_session only', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    const withMeta = tools
      .filter((tool) => tool._meta?.[REQUIRES_USER_INTERACTION_KEY] === true)
      .map((tool) => tool.name)
      .sort();
    expect(withMeta).toEqual(['exec', 'run_in_session']);

    for (const tool of tools) {
      if (tool.name === 'exec' || tool.name === 'run_in_session') continue;
      expect(tool._meta?.[REQUIRES_USER_INTERACTION_KEY]).toBeUndefined();
    }
  });

  it('drops the key entirely when the opt-out is set (AC17.10)', async () => {
    process.env[REQUIRE_USER_INTERACTION_ENV] = '0';
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    for (const tool of tools) {
      expect(tool._meta?.[REQUIRES_USER_INTERACTION_KEY]).toBeUndefined();
    }
  });
});

describe('descriptions (§5.6b, M2)', () => {
  it('serves the §5.6b text for every tool', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description]));

    expect(byName.get('list_hosts')).toBe(LIST_HOSTS_DESCRIPTION);
    expect(byName.get('exec')).toBe(EXEC_DESCRIPTION);
    expect(byName.get('upload')).toBe(UPLOAD_DESCRIPTION);
    expect(byName.get('download')).toBe(DOWNLOAD_DESCRIPTION);
    expect(byName.get('open_session')).toBe(OPEN_SESSION_DESCRIPTION);
    expect(byName.get('run_in_session')).toBe(RUN_IN_SESSION_DESCRIPTION);
    expect(byName.get('close_session')).toBe(CLOSE_SESSION_DESCRIPTION);
  });

  it('carries the approval rule in both command tools', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    for (const name of ['exec', 'run_in_session']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain(TOOL_DESCRIPTION_APPROVAL_RULE);
    }
  });

  it('keeps the approval rule out of the five tools that cannot run a command', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    for (const tool of tools) {
      if (tool.name === 'exec' || tool.name === 'run_in_session') continue;
      expect(tool.description).not.toContain(TOOL_DESCRIPTION_APPROVAL_RULE);
    }
  });

  it('describes every input field', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();

    for (const tool of tools) {
      for (const [field, schema] of Object.entries(properties(tool.inputSchema))) {
        expect(schema.description, `${tool.name}.${field} has no description`).toBeTruthy();
      }
    }
  });

  it('gives list_hosts an empty argument object', async () => {
    harness = await startMcpTestClient();
    const tools = await harness.listTools();
    const listHosts = tools.find((tool) => tool.name === 'list_hosts');
    expect(Object.keys(properties(listHosts?.inputSchema))).toHaveLength(0);
  });
});
