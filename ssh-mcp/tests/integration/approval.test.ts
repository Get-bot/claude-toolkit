/**
 * Approval behaviour through the real tools (AC16, AC17.1-AC17.13, AC18).
 *
 * The §5.5 table is executed rather than restated: every combination of
 * approval mode, command grade, client elicitation support and host fallback
 * runs through `exec` and again through `run_in_session`, and the expectation
 * for each cell is computed by {@link expectedOutcome} — the table as code,
 * next to the table as prose.
 *
 * Everything is parameterised by declared capabilities, never by client name.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ensureKeysDir } from '../../src/config/paths.js';
import type { ApprovalFallback, ApprovalMode, HostEntry } from '../../src/config/schema.js';
import { ERROR_CODES } from '../../src/errors.js';
import { clearTokens, tokenStoreSize, TOKEN_TTL_MS } from '../../src/safety/tokens.js';
import { closeAll } from '../../src/ssh/pool.js';
import { resetSessions } from '../../src/ssh/session.js';
import { authorizeKeyOverSsh, hostEntryFor, startEndpoint } from '../fixtures/endpoints.js';
import type { TestEndpoint } from '../fixtures/endpoints.js';
import { generateClientKey } from '../fixtures/hostKeys.js';
import {
  startMcpTestClient,
  writeRegistry,
  type ElicitationMode,
  type McpTestClient,
} from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

type Grade = 'safe' | 'privileged' | 'destructive';
type GatedTool = 'exec' | 'run_in_session';

/** Harmless commands, one per grade, that the classifier grades as intended. */
const COMMANDS: Record<Grade, string> = {
  safe: 'echo SAFE_OK',
  // First token is a variable expansion: `privileged:variable-command` (C15).
  privileged: '$SSH_MCP_TEST_TOOL --version',
  // `rm -rf` on a path that never exists, so running it changes nothing.
  destructive: 'rm -rf /tmp/ssh-mcp-approval-absent && echo DESTRUCTIVE_OK',
};

interface HostSpec {
  alias: string;
  approvalMode: ApprovalMode;
  /** `undefined` writes no field at all, which must behave as fail-closed (D2). */
  approvalFallback: ApprovalFallback | undefined;
}

const HOST_SPECS: HostSpec[] = [
  { alias: 'auto-token', approvalMode: 'auto', approvalFallback: 'token' },
  { alias: 'askdest-token', approvalMode: 'ask-destructive', approvalFallback: 'token' },
  { alias: 'askdest-closed', approvalMode: 'ask-destructive', approvalFallback: 'fail-closed' },
  { alias: 'askall-token', approvalMode: 'ask-all', approvalFallback: 'token' },
  { alias: 'askall-closed', approvalMode: 'ask-all', approvalFallback: 'fail-closed' },
  { alias: 'deny-token', approvalMode: 'deny', approvalFallback: 'token' },
  { alias: 'nofallback', approvalMode: 'ask-destructive', approvalFallback: undefined },
];

/** The §5.5 decision table, as code. */
type Outcome = 'execute' | 'elicit' | 'confirmation_required' | 'denied' | 'approval_unavailable';

export function expectedOutcome(
  mode: ApprovalMode,
  grade: Grade,
  hasForm: boolean,
  fallback: ApprovalFallback
): Outcome {
  if (mode === 'auto') return 'execute';
  if (mode === 'deny') return grade === 'safe' ? 'execute' : 'denied';
  if (mode === 'ask-destructive' && grade === 'safe') return 'execute';
  if (hasForm) return 'elicit';
  // No carve-out for `safe` here (security finding F9): under `ask-all` the
  // operator asked for a human on every call, so letting a safe command take
  // the token path would quietly turn `ask-all` into `ask-destructive`.
  if (fallback === 'fail-closed') return 'approval_unavailable';
  return 'confirmation_required';
}

let home: TmpHome;
let endpoint: TestEndpoint;
let keyPath: string;
const sessions = new Map<string, string>();

function registerHosts(): void {
  const hosts: Record<string, HostEntry & { alias?: string }> = {};
  for (const spec of HOST_SPECS) {
    const entry = hostEntryFor(endpoint, {
      alias: spec.alias,
      approvalMode: spec.approvalMode,
      privateKeyPath: keyPath,
      ...(spec.approvalFallback === undefined ? {} : { approvalFallback: spec.approvalFallback }),
    });
    hosts[spec.alias] = entry;
  }
  writeRegistry(hosts);
}

beforeAll(async () => {
  home = createTmpHome('ssh-mcp-approval-');
  endpoint = await startEndpoint();
  const clientKey = generateClientKey();
  await authorizeKeyOverSsh(endpoint, clientKey.publicKey);
  keyPath = path.join(ensureKeysDir(), 'fixture');
  fs.writeFileSync(keyPath, clientKey.privateKey, { encoding: 'utf8', mode: 0o600 });
  registerHosts();
});

afterAll(async () => {
  resetSessions();
  closeAll();
  await endpoint.close();
  assertNoWritesOutside(home);
  home.cleanup();
});

afterEach(() => {
  clearTokens();
});

/** Open one session per alias and reuse it; sessions outlive a harness. */
async function sessionFor(harness: McpTestClient, alias: string): Promise<string> {
  const existing = sessions.get(alias);
  if (existing !== undefined) return existing;
  const opened = await harness.callTool('open_session', { host: alias });
  expect(opened.isError, `open_session failed: ${opened.text}`).toBe(false);
  const id = opened.body.session_id;
  if (typeof id !== 'string') throw new Error(`open_session returned no id: ${opened.text}`);
  sessions.set(alias, id);
  return id;
}

async function callGated(
  harness: McpTestClient,
  tool: GatedTool,
  alias: string,
  command: string,
  extra: Record<string, unknown> = {}
): ReturnType<McpTestClient['callTool']> {
  if (tool === 'exec') return harness.callTool('exec', { host: alias, command, ...extra });
  const sessionId = await sessionFor(harness, alias);
  return harness.callTool('run_in_session', { session_id: sessionId, command, ...extra });
}

function bodyError(body: Record<string, unknown>): string | undefined {
  const code = body.error;
  return typeof code === 'string' ? code : undefined;
}

describe.each<[ElicitationMode, boolean]>([
  ['form', true],
  ['none', false],
])('§5.5 matrix with elicitation=%s', (elicitation, hasForm) => {
  let harness: McpTestClient;

  beforeAll(async () => {
    harness = await startMcpTestClient({
      elicitation,
      onElicit: () => ({ action: 'accept', content: { confirm: true } }),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  const cases: [string, ApprovalMode, ApprovalFallback, Grade, GatedTool][] = [];
  for (const spec of HOST_SPECS) {
    for (const grade of ['safe', 'privileged', 'destructive'] as Grade[]) {
      for (const tool of ['exec', 'run_in_session'] as GatedTool[]) {
        cases.push([
          spec.alias,
          spec.approvalMode,
          spec.approvalFallback ?? 'fail-closed',
          grade,
          tool,
        ]);
      }
    }
  }

  it.each(cases)('%s (%s/%s) + %s via %s', async (alias, mode, fallback, grade, tool) => {
    const before = harness.elicitRequests.length;
    const result = await callGated(harness, tool, alias, COMMANDS[grade]);
    const expected = expectedOutcome(mode, grade, hasForm, fallback);
    const asked = harness.elicitRequests.length - before;

    switch (expected) {
      case 'execute':
        expect(result.isError, result.text).toBe(false);
        expect(result.body.exit_code).toBeTypeOf('number');
        expect(asked).toBe(0);
        break;
      case 'elicit':
        // Accepted at the prompt, so the command ran — exactly one prompt.
        expect(asked).toBe(1);
        expect(result.isError, result.text).toBe(false);
        expect(result.body.exit_code).toBeTypeOf('number');
        break;
      case 'confirmation_required':
        expect(result.isError).toBe(false);
        expect(result.body.status).toBe('confirmation_required');
        expect(result.body.confirmation_token).toBeTypeOf('string');
        expect(asked).toBe(0);
        break;
      case 'denied':
        expect(result.isError).toBe(true);
        expect(bodyError(result.body)).toBe(ERROR_CODES.command_denied);
        expect(asked).toBe(0);
        break;
      case 'approval_unavailable':
        expect(result.isError).toBe(true);
        expect(bodyError(result.body)).toBe(ERROR_CODES.approval_unavailable);
        expect(result.body.confirmation_token).toBeUndefined();
        expect(asked).toBe(0);
        break;
    }
  });
});

describe('deny mode (AC16)', () => {
  let harness: McpTestClient;

  beforeAll(async () => {
    harness = await startMcpTestClient({ elicitation: 'form' });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('refuses a destructive command and issues no token (AC16.1)', async () => {
    const sizeBefore = tokenStoreSize();
    const result = await harness.callTool('exec', {
      host: 'deny-token',
      command: COMMANDS.destructive,
    });

    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.command_denied);
    expect(result.body.confirmation_token).toBeUndefined();
    expect(tokenStoreSize()).toBe(sizeBefore);
    expect(harness.elicitRequests).toHaveLength(0);
  });

  it('names the matched pattern id (AC16.2)', async () => {
    const result = await harness.callTool('exec', {
      host: 'deny-token',
      command: COMMANDS.destructive,
    });
    expect(result.body.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/^destructive:/)])
    );
    expect(result.body.grade).toBe('destructive');
  });

  it('still runs a safe command on a deny host', async () => {
    const result = await harness.callTool('exec', { host: 'deny-token', command: COMMANDS.safe });
    expect(result.isError, result.text).toBe(false);
    expect(result.body.stdout).toBe('SAFE_OK\n');
  });
});

describe('elicitation branch (AC17.1, AC17.1b, AC17.1c)', () => {
  it('asks exactly once and sends nothing when declined', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'form',
      onElicit: () => ({ action: 'decline' }),
    });
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
      });
      expect(harness.elicitRequests).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(bodyError(result.body)).toBe(ERROR_CODES.command_denied);
      expect(result.body.elicitation_outcome).toBe('decline');
    } finally {
      await harness.close();
    }
  });

  it('shows the grade, the pattern ids, the host and the whole command', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'form',
      onElicit: () => ({ action: 'decline' }),
    });
    try {
      await harness.callTool('exec', { host: 'askdest-token', command: COMMANDS.destructive });
      const request = harness.elicitRequests[0];
      expect(request?.message).toContain(COMMANDS.destructive);
      expect(request?.message).toContain('askdest-token');
      expect(request?.message).toContain('destructive');
      expect(request?.requestedSchema).toMatchObject({
        type: 'object',
        properties: { confirm: { type: 'boolean' } },
        required: ['confirm'],
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ['cancel', { action: 'cancel' as const }],
    ['accept with confirm:false', { action: 'accept' as const, content: { confirm: false } }],
  ])('treats %s as a refusal', async (_label, answer) => {
    const harness = await startMcpTestClient({ elicitation: 'form', onElicit: () => answer });
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
      });
      expect(result.isError).toBe(true);
      expect(bodyError(result.body)).toBe(ERROR_CODES.command_denied);
    } finally {
      await harness.close();
    }
  });

  it('treats no answer within the budget as a refusal (AC17.1b)', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'form',
      approvalTimeoutMs: 1500,
      onElicit: () => new Promise<never>(() => undefined),
    });
    try {
      const started = Date.now();
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
      });
      expect(result.isError).toBe(true);
      expect(bodyError(result.body)).toBe(ERROR_CODES.command_denied);
      expect(result.body.elicitation_outcome).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await harness.close();
    }
  });

  it('reads a bare elicitation capability as form support (AC17.1c)', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'bare',
      onElicit: () => ({ action: 'accept', content: { confirm: true } }),
    });
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-closed',
        command: COMMANDS.destructive,
      });
      expect(harness.elicitRequests).toHaveLength(1);
      expect(result.isError, result.text).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('reads a url-only capability as no form support (AC17.1c)', async () => {
    const harness = await startMcpTestClient({ elicitation: 'url-only' });
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
      });
      expect(harness.elicitRequests).toHaveLength(0);
      expect(result.body.status).toBe('confirmation_required');
    } finally {
      await harness.close();
    }
  });
});

describe('elicitation call failure (AC17.13)', () => {
  it('falls back to a token on a token host', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'form',
      onElicit: () => {
        throw new Error('client blew up');
      },
    });
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
      });
      expect(result.isError).toBe(false);
      expect(result.body.status).toBe('confirmation_required');
    } finally {
      await harness.close();
    }
  });

  it('does not relax a fail-closed host', async () => {
    const harness = await startMcpTestClient({
      elicitation: 'form',
      onElicit: () => {
        throw new Error('client blew up');
      },
    });
    try {
      const sizeBefore = tokenStoreSize();
      const result = await harness.callTool('exec', {
        host: 'askdest-closed',
        command: COMMANDS.destructive,
      });
      expect(result.isError).toBe(true);
      expect(bodyError(result.body)).toBe(ERROR_CODES.approval_unavailable);
      expect(tokenStoreSize()).toBe(sizeBefore);
    } finally {
      await harness.close();
    }
  });
});

describe('token branch (AC17.2-AC17.8, AC18)', () => {
  let harness: McpTestClient;

  beforeAll(async () => {
    harness = await startMcpTestClient({ elicitation: 'none' });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function issue(
    tool: GatedTool,
    alias: string,
    command: string
  ): Promise<{ token: string; body: Record<string, unknown> }> {
    const first = await callGated(harness, tool, alias, command);
    expect(first.body.status, first.text).toBe('confirmation_required');
    const token = first.body.confirmation_token;
    if (typeof token !== 'string') throw new Error(`no token in ${first.text}`);
    return { token, body: first.body };
  }

  it.each<GatedTool>(['exec', 'run_in_session'])(
    '%s: issues a token, runs once on the round trip, then refuses reuse (AC17.2, AC17.3, AC18)',
    async (tool) => {
      const { token, body } = await issue(tool, 'askdest-token', COMMANDS.destructive);

      expect(body.instruction_to_model).toBeTypeOf('string');
      expect(body.server_cannot_verify_human_approval).toBe(true);
      expect(body.command).toBe(COMMANDS.destructive);
      expect(body.expires_in_sec).toBe(TOKEN_TTL_MS / 1000);
      expect(body.next_call).toBeTypeOf('object');

      const second = await callGated(harness, tool, 'askdest-token', COMMANDS.destructive, {
        confirmation_token: token,
      });
      expect(second.isError, second.text).toBe(false);
      expect(second.body.stdout).toContain('DESTRUCTIVE_OK');

      const third = await callGated(harness, tool, 'askdest-token', COMMANDS.destructive, {
        confirmation_token: token,
      });
      expect(third.isError).toBe(true);
      expect(bodyError(third.body)).toBe(ERROR_CODES.confirmation_token_used);
    }
  );

  it('rejects a token presented with a changed command (AC17.4)', async () => {
    const { token } = await issue('exec', 'askdest-token', COMMANDS.destructive);
    const result = await harness.callTool('exec', {
      host: 'askdest-token',
      command: `${COMMANDS.destructive} `,
      confirmation_token: token,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.confirmation_token_mismatch);
  });

  it('rejects an expired token (AC17.5)', async () => {
    const { token } = await issue('exec', 'askdest-token', COMMANDS.destructive);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + TOKEN_TTL_MS + 1000);
    try {
      const result = await harness.callTool('exec', {
        host: 'askdest-token',
        command: COMMANDS.destructive,
        confirmation_token: token,
      });
      expect(result.isError).toBe(true);
      expect(bodyError(result.body)).toBe(ERROR_CODES.confirmation_token_expired);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects a token issued for another host (AC17.6)', async () => {
    const { token } = await issue('exec', 'askdest-token', COMMANDS.destructive);
    const result = await harness.callTool('exec', {
      host: 'askall-token',
      command: COMMANDS.destructive,
      confirmation_token: token,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.confirmation_token_mismatch);
  });

  it('rejects a token issued for the other tool', async () => {
    const { token } = await issue('exec', 'askdest-token', COMMANDS.destructive);
    const sessionId = await sessionFor(harness, 'askdest-token');
    const result = await harness.callTool('run_in_session', {
      session_id: sessionId,
      command: COMMANDS.destructive,
      confirmation_token: token,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.confirmation_token_mismatch);
  });

  it('refuses a fail-closed host without issuing a token (AC17.7)', async () => {
    const sizeBefore = tokenStoreSize();
    const result = await harness.callTool('exec', {
      host: 'askdest-closed',
      command: COMMANDS.destructive,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.approval_unavailable);
    expect(tokenStoreSize()).toBe(sizeBefore);
  });

  it('refuses even a safe command on a fail-closed ask-all host (F9)', async () => {
    // AC17.7's own wording sends this case down the token path. Security review
    // rejected that: `ask-all` means "ask a person every time", and handing the
    // model a token instead reduces it to `ask-destructive` for safe commands.
    // The stricter reading is the one implemented.
    const sizeBefore = tokenStoreSize();
    const result = await harness.callTool('exec', {
      host: 'askall-closed',
      command: COMMANDS.safe,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.approval_unavailable);
    expect(tokenStoreSize()).toBe(sizeBefore);
  });

  it('treats a missing approvalFallback field as fail-closed (AC17.11, D2)', async () => {
    const result = await harness.callTool('exec', {
      host: 'nofallback',
      command: COMMANDS.destructive,
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.approval_unavailable);
  });

  it('DOCUMENTED LIMITATION (AC17.8, PM-4): a model can re-call with the token without asking anyone', async () => {
    // This is not a bug report: with `approvalFallback: "token"` and a client
    // that cannot elicit, the server has no way to tell an approved re-call
    // from an unapproved one. The test pins the behaviour so that the README's
    // "security model" section and the code cannot drift apart. A host that
    // will not accept this chooses `fail-closed` (the test above).
    const { token, body } = await issue('exec', 'askdest-token', COMMANDS.destructive);
    expect(body.server_cannot_verify_human_approval).toBe(true);

    const executed = await harness.callTool('exec', {
      host: 'askdest-token',
      command: COMMANDS.destructive,
      confirmation_token: token,
    });
    expect(executed.isError, executed.text).toBe(false);
    expect(executed.body.stdout).toContain('DESTRUCTIVE_OK');
  });

  it('rejects a token that was never issued', async () => {
    const result = await harness.callTool('exec', {
      host: 'askdest-token',
      command: COMMANDS.destructive,
      confirmation_token: 'not-a-real-token',
    });
    expect(result.isError).toBe(true);
    expect(bodyError(result.body)).toBe(ERROR_CODES.confirmation_token_invalid);
  });
});
