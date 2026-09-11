/**
 * Approval gate matrix (§5.5 host x mode x grade x elicitation x fallback).
 *
 * The table below is the §5.5 behaviour table turned into assertions; the
 * blocks after it pin the rules that table cannot express: that `fail-closed`
 * never issues a token for a non-safe grade, that a failed elicitation call
 * does not relax a `fail-closed` host (AC17.13), and the documented limit in
 * AC17.8 that a `token` host with no elicitation cannot verify a human at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalFallback, ApprovalMode, HostEntry } from '../../src/config/schema.js';
import { ERROR_CODES, toToolNotice } from '../../src/errors.js';
import { gateCommand, interpretElicitResult } from '../../src/safety/approval.js';
import type { ElicitOutcome, GateInput, GateResult } from '../../src/safety/approval.js';
import { clearTokens, stopSweep, tokenStoreSize } from '../../src/safety/tokens.js';

const SAFE_COMMAND = 'ls -la';
const DESTRUCTIVE_COMMAND = 'rm -rf /var/www/releases/2024';
const PRIVILEGED_COMMAND = 'apt-get install -y curl';

function host(
  alias: string,
  approvalMode: ApprovalMode,
  approvalFallback?: ApprovalFallback
): HostEntry & { alias: string } {
  const base = {
    alias,
    hostname: `${alias}.example`,
    port: 22,
    user: 'deploy',
    privateKeyPath: `/keys/${alias}`,
    hostKey: { algo: 'ssh-ed25519', sha256: `SHA256:${'a'.repeat(43)}` },
    approvalMode,
    auditMode: 'full' as const,
    patternOverrides: {
      destructive: { add: [], remove: [] },
      privileged: { add: [], remove: [] },
    },
    defaultTimeoutSec: 60,
    maxOutputBytes: 1048576,
    createdAt: '2026-09-11T00:00:00.000Z',
  };
  return approvalFallback === undefined ? base : { ...base, approvalFallback };
}

interface ClientOptions {
  elicitation: boolean;
  outcome?: ElicitOutcome;
  throws?: boolean;
  delayMs?: number;
}

interface FakeClient {
  client: GateInput['client'];
  calls: number;
}

function makeClient(options: ClientOptions): FakeClient {
  const state = { calls: 0 };
  if (!options.elicitation) {
    return {
      client: { supportsElicitation: false },
      get calls() {
        return state.calls;
      },
    };
  }
  return {
    client: {
      supportsElicitation: true,
      elicit: async () => {
        state.calls += 1;
        if (options.throws === true) throw new Error('transport closed');
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        return options.outcome ?? 'accept';
      },
    },
    get calls() {
      return state.calls;
    },
  };
}

function parseBody(result: GateResult): Record<string, unknown> {
  const toolResult = 'toolResult' in result ? result.toolResult : undefined;
  expect(toolResult).toBeDefined();
  const text = toolResult?.content[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

async function gate(overrides: Partial<GateInput> & Pick<GateInput, 'host'>): Promise<GateResult> {
  return gateCommand({
    toolName: 'exec',
    command: SAFE_COMMAND,
    sessionId: null,
    client: { supportsElicitation: false },
    ...overrides,
  });
}

afterEach(() => {
  clearTokens();
  vi.useRealTimers();
});

describe('interpretElicitResult', () => {
  it('treats accept + confirm true as approval (AC17.1b)', () => {
    expect(interpretElicitResult('accept', { confirm: true })).toBe('accept');
  });

  it('treats accept + confirm false as a decline (AC17.1b)', () => {
    expect(interpretElicitResult('accept', { confirm: false })).toBe('decline');
    expect(interpretElicitResult('accept', {})).toBe('decline');
    expect(interpretElicitResult('accept')).toBe('decline');
  });

  it('passes decline and cancel through', () => {
    expect(interpretElicitResult('decline')).toBe('decline');
    expect(interpretElicitResult('cancel')).toBe('cancel');
  });
});

// --------------------------------------------------------------------------
// §5.5 behaviour table
// --------------------------------------------------------------------------

interface MatrixRow {
  label: string;
  mode: ApprovalMode;
  fallback: ApprovalFallback | undefined;
  elicitation: boolean;
  outcome?: ElicitOutcome;
  command: string;
  expectKind: GateResult['kind'];
  expectOutcome: GateResult['approvalOutcome'];
}

const MATRIX: MatrixRow[] = [
  // --- auto ---
  {
    label: 'auto runs everything',
    mode: 'auto',
    fallback: 'fail-closed',
    elicitation: false,
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'auto',
  },
  // --- deny ---
  {
    label: 'deny refuses a destructive command',
    mode: 'deny',
    fallback: 'token',
    elicitation: true,
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'denied',
  },
  {
    label: 'deny refuses a privileged command',
    mode: 'deny',
    fallback: 'token',
    elicitation: true,
    command: PRIVILEGED_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'denied',
  },
  {
    label: 'deny still runs a safe command',
    mode: 'deny',
    fallback: 'token',
    elicitation: false,
    command: SAFE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'not-required',
  },
  // --- ask-destructive, elicitation available (Claude Code) ---
  {
    label: 'ask-destructive + safe runs without asking',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: true,
    command: SAFE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'not-required',
  },
  {
    label: 'ask-destructive + destructive + accept',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: true,
    outcome: 'accept',
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'elicitation-approved',
  },
  {
    label: 'ask-destructive + destructive + decline',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: true,
    outcome: 'decline',
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'declined',
  },
  {
    label: 'ask-destructive + destructive + cancel (AC17.1b)',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: true,
    outcome: 'cancel',
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'declined',
  },
  {
    label: 'ask-destructive + destructive + timeout (AC17.1b)',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: true,
    outcome: 'timeout',
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'declined',
  },
  {
    label: 'ask-destructive + privileged + accept',
    mode: 'ask-destructive',
    fallback: 'fail-closed',
    elicitation: true,
    outcome: 'accept',
    command: PRIVILEGED_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'elicitation-approved',
  },
  {
    label: 'ask-all asks even for a safe command',
    mode: 'ask-all',
    fallback: 'token',
    elicitation: true,
    outcome: 'accept',
    command: SAFE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'elicitation-approved',
  },
  // --- no elicitation (Claude Desktop) ---
  {
    label: 'token fallback + destructive issues a token',
    mode: 'ask-destructive',
    fallback: 'token',
    elicitation: false,
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'confirmation_required',
    expectOutcome: 'pending-confirmation',
  },
  {
    label: 'fail-closed + destructive refuses',
    mode: 'ask-destructive',
    fallback: 'fail-closed',
    elicitation: false,
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'approval_unavailable',
  },
  {
    label: 'fail-closed + privileged refuses',
    mode: 'ask-all',
    fallback: 'fail-closed',
    elicitation: false,
    command: PRIVILEGED_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'approval_unavailable',
  },
  {
    label: 'fail-closed + ask-all + safe still takes the token path (AC17.7)',
    mode: 'ask-all',
    fallback: 'fail-closed',
    elicitation: false,
    command: SAFE_COMMAND,
    expectKind: 'confirmation_required',
    expectOutcome: 'pending-confirmation',
  },
  {
    label: 'fail-closed + ask-destructive + safe just runs',
    mode: 'ask-destructive',
    fallback: 'fail-closed',
    elicitation: false,
    command: SAFE_COMMAND,
    expectKind: 'allow',
    expectOutcome: 'not-required',
  },
  // --- missing approvalFallback behaves as fail-closed (D2, AC17.11) ---
  {
    label: 'missing approvalFallback refuses a destructive command',
    mode: 'ask-destructive',
    fallback: undefined,
    elicitation: false,
    command: DESTRUCTIVE_COMMAND,
    expectKind: 'deny',
    expectOutcome: 'approval_unavailable',
  },
  {
    label: 'missing approvalFallback keeps the token path for a safe ask-all command',
    mode: 'ask-all',
    fallback: undefined,
    elicitation: false,
    command: SAFE_COMMAND,
    expectKind: 'confirmation_required',
    expectOutcome: 'pending-confirmation',
  },
];

describe('§5.5 host x mode x grade matrix', () => {
  for (const row of MATRIX) {
    it(row.label, async () => {
      const fake = makeClient(
        row.outcome === undefined
          ? { elicitation: row.elicitation }
          : { elicitation: row.elicitation, outcome: row.outcome }
      );
      const result = await gate({
        host: host('prod-web', row.mode, row.fallback),
        command: row.command,
        client: fake.client,
      });
      expect(result.kind).toBe(row.expectKind);
      expect(result.approvalOutcome).toBe(row.expectOutcome);
      if (row.elicitation && row.expectKind !== 'allow') {
        // AC17.1: exactly one elicitation per gated call, or none when the
        // mode decided before asking.
        expect(fake.calls).toBeLessThanOrEqual(1);
      }
    });
  }

  it('runs the same matrix for run_in_session (AC18.1)', async () => {
    for (const row of MATRIX) {
      const fake = makeClient(
        row.outcome === undefined
          ? { elicitation: row.elicitation }
          : { elicitation: row.elicitation, outcome: row.outcome }
      );
      const result = await gate({
        toolName: 'run_in_session',
        sessionId: 'sess-1',
        host: host('prod-web', row.mode, row.fallback),
        command: row.command,
        client: fake.client,
      });
      expect(result.kind, row.label).toBe(row.expectKind);
      expect(result.approvalOutcome, row.label).toBe(row.expectOutcome);
    }
  });
});

describe('no token is issued where the plan forbids one', () => {
  it('issues none under deny (AC16.1)', async () => {
    const before = tokenStoreSize();
    const result = await gate({
      host: host('prod-web', 'deny', 'token'),
      command: DESTRUCTIVE_COMMAND,
    });
    expect(result.kind).toBe('deny');
    expect(tokenStoreSize()).toBe(before);
  });

  it('issues none under fail-closed (AC17.7)', async () => {
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'fail-closed'),
      command: DESTRUCTIVE_COMMAND,
    });
    expect(result.kind).toBe('deny');
    expect(result.errorCode).toBe(ERROR_CODES.approval_unavailable);
    expect(tokenStoreSize()).toBe(0);
  });

  it('issues none when the human declines', async () => {
    const fake = makeClient({ elicitation: true, outcome: 'decline' });
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      client: fake.client,
    });
    expect(result.kind).toBe('deny');
    expect(tokenStoreSize()).toBe(0);
  });

  it('reports the matched pattern ids in the denial body (AC16.2)', async () => {
    const result = await gate({
      host: host('prod-web', 'deny', 'token'),
      command: DESTRUCTIVE_COMMAND,
    });
    const body = parseBody(result);
    expect(body.error).toBe(ERROR_CODES.command_denied);
    expect(body.reasons).toContain('destructive:rm-recursive');
  });
});

describe('elicitation failure (AC17.13)', () => {
  it('falls back to a token when the host chose token', async () => {
    const fake = makeClient({ elicitation: true, throws: true });
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      client: fake.client,
    });
    expect(result.kind).toBe('confirmation_required');
    expect(fake.calls).toBe(1);
  });

  it('refuses when the host chose fail-closed (P2)', async () => {
    const fake = makeClient({ elicitation: true, throws: true });
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'fail-closed'),
      command: DESTRUCTIVE_COMMAND,
      client: fake.client,
    });
    expect(result.kind).toBe('deny');
    expect(result.approvalOutcome).toBe('approval_unavailable');
    expect(tokenStoreSize()).toBe(0);
  });

  it('still issues a token for a safe ask-all command on a fail-closed host', async () => {
    const fake = makeClient({ elicitation: true, throws: true });
    const result = await gate({
      host: host('prod-web', 'ask-all', 'fail-closed'),
      command: SAFE_COMMAND,
      client: fake.client,
    });
    expect(result.kind).toBe('confirmation_required');
  });
});

describe('injected elicitation timeout (AC17.1b)', () => {
  it('treats no answer within the timeout as a decline', async () => {
    const fake = makeClient({ elicitation: true, outcome: 'accept', delayMs: 5000 });
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      client: fake.client,
      approvalTimeoutMs: 20,
    });
    expect(result.kind).toBe('deny');
    expect(result.approvalOutcome).toBe('declined');
    expect(result.errorCode).toBe(ERROR_CODES.command_denied);
    expect(tokenStoreSize()).toBe(0);
  });
});

describe('confirmation_required response body (M1, M7)', () => {
  async function issue(): Promise<{ result: GateResult; body: Record<string, unknown> }> {
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
    });
    return { result, body: parseBody(result) };
  }

  it('is not an error result', async () => {
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
    });
    expect(result.kind === 'confirmation_required' && result.toolResult.isError).toBe(false);
  });

  it('carries the raw token un-redacted', async () => {
    const { result, body } = await issue();
    expect(result.kind).toBe('confirmation_required');
    if (result.kind !== 'confirmation_required') return;
    expect(body.confirmation_token).toBe(result.token);
    expect(body.confirmation_token).not.toBe('[redacted]');
  });

  it('redacts other token-like keys in the same envelope', () => {
    const notice = toToolNotice(
      ERROR_CODES.confirmation_required,
      'x',
      { confirmation_token: 'KEEP-ME', session_token: 'MASK-ME', password: 'MASK-ME' },
      { preserveKeys: ['confirmation_token'] }
    );
    const body = JSON.parse(notice.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(body.confirmation_token).toBe('KEEP-ME');
    expect(body.session_token).toBe('[redacted]');
    expect(body.password).toBe('[redacted]');
  });

  it('tells the model to obtain explicit human approval first (M1)', async () => {
    const { body } = await issue();
    expect(String(body.instruction_to_model)).toContain('명시적인 승인');
    expect(String(body.instruction_to_model)).toContain('재호출');
  });

  it('gives the model the grade, pattern ids, host and full command (M7)', async () => {
    const { body } = await issue();
    expect(body.status).toBe('confirmation_required');
    expect(body.grade).toBe('destructive');
    expect(body.reasons).toContain('destructive:rm-recursive');
    expect(body.host).toBe('prod-web');
    expect(body.tool).toBe('exec');
    expect(body.command).toBe(DESTRUCTIVE_COMMAND);
    expect(body.approval_mode).toBe('ask-destructive');
    expect(body.approval_fallback).toBe('token');
    expect(body.expires_in_sec).toBe(300);
    expect(typeof body.expires_at).toBe('string');
    expect(body.next_call).toBeDefined();
  });

  it('shows the full command even past the 2 KiB default field cap (M7)', async () => {
    // `redact` truncates ordinary strings at 2 KiB; `command` is in
    // `preserveKeys`, which raises the cap to 32 KiB, and `command_too_long`
    // already rejects anything over 8192 characters.
    const long = `rm -rf /var/www/${'a'.repeat(5000)}`;
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: long,
    });
    expect(result.kind).toBe('confirmation_required');
    const body = parseBody(result);
    expect(body.command).toBe(long);
  });

  it('states that the server cannot verify human approval', async () => {
    const { body } = await issue();
    expect(body.server_cannot_verify_human_approval).toBe(true);
  });

  it('never writes the raw token to stderr (AC19.3)', async () => {
    const captured: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        void write;
        void rest;
        return true;
      });
    try {
      const result = await gate({
        host: host('prod-web', 'ask-destructive', 'token'),
        command: DESTRUCTIVE_COMMAND,
      });
      expect(result.kind).toBe('confirmation_required');
      if (result.kind !== 'confirmation_required') return;
      const stderr = captured.join('');
      expect(stderr).not.toBe('');
      expect(stderr).not.toContain(result.token);
      expect(stderr).toContain('confirmation_hash8');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('confirmation token round trip', () => {
  async function issueToken(): Promise<string> {
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
    });
    expect(result.kind).toBe('confirmation_required');
    return result.kind === 'confirmation_required' ? result.token : '';
  }

  it('runs the command on the second call (AC17.2)', async () => {
    const token = await issueToken();
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    });
    expect(result.kind).toBe('allow');
    expect(result.approvalOutcome).toBe('token-approved');
  });

  it('refuses a reused token (AC17.3)', async () => {
    const token = await issueToken();
    const input = {
      host: host('prod-web', 'ask-destructive', 'token' as const),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    };
    await gate(input);
    const second = await gate(input);
    expect(second.kind).toBe('deny');
    expect(second.errorCode).toBe(ERROR_CODES.confirmation_token_used);
  });

  it('refuses a one-byte command change (AC17.4)', async () => {
    const token = await issueToken();
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: `${DESTRUCTIVE_COMMAND} `,
      confirmationToken: token,
    });
    expect(result.errorCode).toBe(ERROR_CODES.confirmation_token_mismatch);
  });

  it('refuses a token from another host (AC17.6)', async () => {
    const token = await issueToken();
    const result = await gate({
      host: host('staging', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    });
    expect(result.errorCode).toBe(ERROR_CODES.confirmation_token_mismatch);
  });

  it('refuses a token nobody issued', async () => {
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: 'x'.repeat(43),
    });
    expect(result.errorCode).toBe(ERROR_CODES.confirmation_token_invalid);
  });

  it('refuses an expired token (AC17.5)', async () => {
    const token = await issueToken();
    vi.useFakeTimers();
    vi.advanceTimersByTime(300_001);
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    });
    expect(result.errorCode).toBe(ERROR_CODES.confirmation_token_expired);
  });

  it('does not let a token get past a deny host', async () => {
    const token = await issueToken();
    const result = await gate({
      host: host('prod-web', 'deny', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    });
    expect(result.kind).toBe('deny');
    expect(result.errorCode).toBe(ERROR_CODES.command_denied);
  });

  /**
   * AC17.8 — a documented limit, not a feature. With `approvalFallback: token`
   * and a client that cannot elicit, nothing stops the model from spending the
   * token immediately. The server says so in the response body; the README
   * "보안 모델" section says so to the user. `fail-closed` is the only
   * server-side defence.
   */
  it('documents that a token host cannot verify a human (AC17.8)', async () => {
    const token = await issueToken();
    const result = await gate({
      host: host('prod-web', 'ask-destructive', 'token'),
      command: DESTRUCTIVE_COMMAND,
      confirmationToken: token,
    });
    expect(result.kind).toBe('allow');
    expect(result.approvalOutcome).toBe('token-approved');
  });
});

describe('gates that run before approval', () => {
  it('refuses an interactive program before classifying', async () => {
    const result = await gate({
      host: host('prod-web', 'auto', 'token'),
      command: 'vim /etc/hosts',
    });
    expect(result.kind).toBe('refused_interactive');
    expect(result.errorCode).toBe(ERROR_CODES.interactive_program_refused);
    expect(result.classification).toBeNull();
    const body = parseBody(result);
    expect(body.program).toBe('vim');
    expect(Array.isArray(body.alternatives)).toBe(true);
  });

  it('refuses sudo -S before approval', async () => {
    const result = await gate({
      host: host('prod-web', 'auto', 'token'),
      command: 'sudo -S systemctl restart nginx',
    });
    expect(result.kind).toBe('sudo_password_required');
    expect(result.errorCode).toBe(ERROR_CODES.sudo_password_required);
  });

  it('refuses a command over the length limit', async () => {
    const result = await gate({
      host: host('prod-web', 'auto', 'token'),
      command: `echo ${'x'.repeat(8200)}`,
    });
    expect(result.kind).toBe('command_too_long');
    expect(result.errorCode).toBe(ERROR_CODES.command_too_long);
  });
});

stopSweep();
