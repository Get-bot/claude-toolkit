/**
 * `audit.jsonl` written by the tool wrapper (AC20.1-AC20.5, AC20.10, AC20.11).
 *
 * The unit suite covers the record shape, the line cap and rotation; this file
 * covers the claim that only a call path can support: every tool call, on every
 * outcome, leaves exactly one line — and a two-step approval leaves two, in an
 * order that reconstructs what happened.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { APPROVAL_OUTCOMES, resetAuditState, TOOL_NAMES } from '../../src/audit.js';
import { auditFilePath, ensureKeysDir } from '../../src/config/paths.js';
import type { HostEntry } from '../../src/config/schema.js';
import { ERROR_CODES } from '../../src/errors.js';
import { clearTokens } from '../../src/safety/tokens.js';
import { closeAll } from '../../src/ssh/pool.js';
import { resetSessions } from '../../src/ssh/session.js';
import {
  authorizeKeyOverSsh,
  hostEntryFor,
  startEndpoint,
  writeRemoteFile,
} from '../fixtures/endpoints.js';
import type { TestEndpoint } from '../fixtures/endpoints.js';
import { generateClientKey } from '../fixtures/hostKeys.js';
import {
  startMcpTestClient,
  writeRegistry,
  type McpTestClient,
  type McpTestClientOptions,
} from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

/** §5.10 / AC20.2: every one of these must be present on every line. */
const REQUIRED_FIELDS = [
  'schemaVersion',
  'ts',
  'tool',
  'host',
  'session_id',
  'command',
  'command_grade',
  'reasons',
  'approval_mode',
  'approval_fallback',
  'approval_outcome',
  'server_cannot_verify_human_approval',
  'exit_code',
  'error_code',
  'exec_duration_ms',
  'approval_wait_ms',
  'stdout_bytes',
  'stderr_bytes',
  'truncated',
  'normalized_command',
  'segments',
  'client',
  'audit_mode',
] as const;

const DESTRUCTIVE = 'rm -rf /tmp/ssh-mcp-audit-absent && echo DESTRUCTIVE_OK';

let home: TmpHome;
let endpoint: TestEndpoint;
let keyPath: string;
let localDir: string;

function remotePath(name: string): string {
  return `${endpoint.remoteHomeDir.replace(/\\/g, '/')}/${name}`;
}

function readAudit(): Record<string, unknown>[] {
  const file = auditFilePath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function clearAudit(): void {
  fs.rmSync(auditFilePath(), { force: true });
  resetAuditState();
}

async function withClient<T>(
  options: McpTestClientOptions,
  body: (harness: McpTestClient) => Promise<T>
): Promise<T> {
  const harness = await startMcpTestClient(options);
  try {
    return await body(harness);
  } finally {
    await harness.close();
  }
}

beforeAll(async () => {
  home = createTmpHome('ssh-mcp-audit-');
  endpoint = await startEndpoint();
  const clientKey = generateClientKey();
  // 픽스처에서는 로컬 `fs`로, sshd 티어에서는 실제 SSH 설치 경로로 심습니다
  // (`tests/fixtures/endpoints.ts:338`). 이 파일은 A7/A8 이후에 쓰였는데도
  // 예전 모양인 `authorizeKey`를 그대로 물려받아, sshd 티어에서 훅 전체가
  // throw 하고 이 파일의 테스트가 한 줄도 돌지 않았습니다.
  await authorizeKeyOverSsh(endpoint, clientKey.publicKey);
  keyPath = path.join(ensureKeysDir(), 'fixture');
  fs.writeFileSync(keyPath, clientKey.privateKey, { encoding: 'utf8', mode: 0o600 });
  localDir = fs.mkdtempSync(path.join(endpoint.localSandboxDir, 'local-'));

  const auto = hostEntryFor(endpoint, { alias: 'auto', privateKeyPath: keyPath });
  const askToken = hostEntryFor(endpoint, {
    alias: 'ask-token',
    approvalMode: 'ask-destructive',
    approvalFallback: 'token',
    privateKeyPath: keyPath,
  });
  const askClosed = hostEntryFor(endpoint, {
    alias: 'ask-closed',
    approvalMode: 'ask-destructive',
    approvalFallback: 'fail-closed',
    privateKeyPath: keyPath,
  });
  const denyHost = hostEntryFor(endpoint, {
    alias: 'deny',
    approvalMode: 'deny',
    approvalFallback: 'token',
    privateKeyPath: keyPath,
  });
  // Small enough that a few kilobytes of output is excerpted, which is what
  // gives a stream an `output_ref` to keep out of the audit file (D9, AC-O5).
  const tight = hostEntryFor(endpoint, {
    alias: 'tight',
    privateKeyPath: keyPath,
    maxOutputBytes: 1024,
  });
  const metadataOnly: HostEntry & { alias?: string } = {
    ...hostEntryFor(endpoint, {
      alias: 'meta-only',
      approvalMode: 'ask-destructive',
      approvalFallback: 'token',
      privateKeyPath: keyPath,
    }),
    auditMode: 'metadata-only',
  };

  writeRegistry({
    auto,
    'ask-token': askToken,
    'ask-closed': askClosed,
    deny: denyHost,
    tight,
    'meta-only': metadataOnly,
  });
});

afterAll(async () => {
  resetSessions();
  closeAll();
  await endpoint.close();
  assertNoWritesOutside(home);
  home.cleanup();
});

beforeEach(() => {
  clearAudit();
});

afterEach(() => {
  clearTokens();
});

describe('one line per call (AC20.1, AC20.2)', () => {
  it('writes exactly one line per tool, for every tool', async () => {
    const uploadSource = path.join(localDir, 'upload-src.txt');
    fs.writeFileSync(uploadSource, 'audit-payload\n', 'utf8');
    const remote = remotePath('audit-upload.txt');
    const downloadTarget = path.join(localDir, 'download-dst.txt');
    fs.rmSync(downloadTarget, { force: true });

    await withClient({ elicitation: 'none' }, async (harness) => {
      expect((await harness.callTool('list_hosts')).isError).toBe(false);
      expect(
        (await harness.callTool('exec', { host: 'auto', command: 'echo AUDIT' })).isError
      ).toBe(false);
      expect(
        (
          await harness.callTool('upload', {
            host: 'auto',
            local_path: uploadSource,
            remote_path: remote,
          })
        ).isError
      ).toBe(false);
      expect(
        (
          await harness.callTool('download', {
            host: 'auto',
            remote_path: remote,
            local_path: downloadTarget,
          })
        ).isError
      ).toBe(false);

      const opened = await harness.callTool('open_session', { host: 'auto' });
      expect(opened.isError, opened.text).toBe(false);
      const sessionId = opened.body.session_id as string;
      expect(
        (await harness.callTool('run_in_session', { session_id: sessionId, command: 'echo IN' }))
          .isError
      ).toBe(false);
      expect((await harness.callTool('close_session', { session_id: sessionId })).isError).toBe(
        false
      );
      // The two v1.1 readers are audited like everything else (AC-H5, AC-O6).
      expect((await harness.callTool('history', { limit: 1 })).isError).toBe(false);
      // An unknown reference is the one `fetch_output` call that needs no prior
      // truncated command; a failed call still leaves its line (AC20.3).
      expect((await harness.callTool('fetch_output', { output_ref: 'absent' })).isError).toBe(true);
    });

    const lines = readAudit();
    expect(lines).toHaveLength(TOOL_NAMES.length);
    expect(lines.map((line) => line.tool)).toEqual([
      'list_hosts',
      'exec',
      'upload',
      'download',
      'open_session',
      'run_in_session',
      'close_session',
      'history',
      'fetch_output',
    ]);
    expect(new Set(lines.map((line) => line.tool))).toEqual(new Set(TOOL_NAMES));
  });

  it('records the two readers with no command attached (AC-H5, AC-O6)', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      expect((await harness.callTool('history', { limit: 5 })).isError).toBe(false);
      await harness.callTool('fetch_output', { output_ref: 'no-such-reference' });
    });

    const lines = readAudit();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.tool)).toEqual(['history', 'fetch_output']);
    expect(lines[1]?.error_code).toBe(ERROR_CODES.output_expired);
    for (const line of lines) {
      expect(line.command).toBeNull();
      expect(line.normalized_command).toBeNull();
      expect(line.segments).toBeNull();
      expect(line.command_grade).toBeNull();
      expect(line.host).toBeNull();
      // No approval was asked for and none was skipped.
      expect(line.approval_outcome).toBe('not-required');
      expect(line.server_cannot_verify_human_approval).toBe(false);
    }
  });

  it('carries every required field on every line', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('list_hosts');
      await harness.callTool('exec', { host: 'auto', command: 'echo FIELDS' });
      await harness.callTool('exec', { host: 'nope', command: 'echo FIELDS' });
    });

    const lines = readAudit();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      for (const field of REQUIRED_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(line, field), `missing ${field}`).toBe(true);
      }
      expect(line.schemaVersion).toBe(1);
      expect(typeof line.ts).toBe('string');
      expect(APPROVAL_OUTCOMES).toContain(line.approval_outcome);
    }
  });

  it('records the connected client', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('list_hosts');
    });
    expect(readAudit()[0]?.client).toEqual({ name: 'ssh-mcp-test-client', version: '1.2.3' });
  });
});

describe('failures and refusals are recorded (AC20.3)', () => {
  it('records a denied command with no exit code', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('exec', { host: 'deny', command: DESTRUCTIVE });
    });

    const lines = readAudit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'exec',
      host: 'deny',
      approval_outcome: 'denied',
      error_code: ERROR_CODES.command_denied,
      exit_code: null,
      command_grade: 'destructive',
    });
  });

  it('records approval_unavailable', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('exec', { host: 'ask-closed', command: DESTRUCTIVE });
    });
    expect(readAudit()[0]).toMatchObject({
      approval_outcome: 'approval_unavailable',
      error_code: ERROR_CODES.approval_unavailable,
      exit_code: null,
    });
  });

  it('records a declined elicitation', async () => {
    await withClient(
      { elicitation: 'form', onElicit: () => ({ action: 'decline' }) },
      async (harness) => {
        await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      }
    );
    const line = readAudit()[0];
    expect(line).toMatchObject({
      approval_outcome: 'declined',
      error_code: ERROR_CODES.command_denied,
    });
    expect(line?.approval_wait_ms).toBeTypeOf('number');
  });

  it('records a run_in_session against an id that was never issued', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      const result = await harness.callTool('run_in_session', {
        session_id: 'sess_deadbeefdeadbeefdeadbeef',
        command: 'echo X',
      });
      expect(result.isError).toBe(true);
      expect(result.body.error).toBe(ERROR_CODES.session_not_found);
    });

    const lines = readAudit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'run_in_session',
      session_id: 'sess_deadbeefdeadbeefdeadbeef',
      host: null,
      error_code: ERROR_CODES.session_not_found,
      approval_outcome: 'not-required',
    });
  });

  it('reports a session that was closed as gone, and records it', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      const opened = await harness.callTool('open_session', { host: 'auto' });
      const sessionId = opened.body.session_id as string;
      expect((await harness.callTool('close_session', { session_id: sessionId })).isError).toBe(
        false
      );

      const result = await harness.callTool('run_in_session', {
        session_id: sessionId,
        command: 'echo X',
      });
      expect(result.isError).toBe(true);
      expect(result.body.error).toBe(ERROR_CODES.session_not_found);
    });

    const lines = readAudit();
    expect(lines).toHaveLength(3);
    expect(lines[2]?.error_code).toBe(ERROR_CODES.session_not_found);
  });

  it('records a timed-out command', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      const result = await harness.callTool('exec', {
        host: 'auto',
        command: 'sleep 5',
        timeout_sec: 1,
      });
      expect(result.isError).toBe(true);
    });

    const lines = readAudit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'exec',
      error_code: ERROR_CODES.command_timeout,
      exit_code: null,
      approval_outcome: 'auto',
    });
    expect(lines[0]?.exec_duration_ms).toBeGreaterThan(0);
  });

  it('records an unknown host', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('exec', { host: 'missing-host', command: 'echo X' });
    });
    expect(readAudit()[0]).toMatchObject({
      tool: 'exec',
      error_code: ERROR_CODES.host_not_found,
      approval_outcome: 'not-required',
    });
  });
});

describe('two-step approval leaves two lines (§5.10, AC20.4)', () => {
  it('records pending-confirmation and then token-approved', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      const first = await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      const token = first.body.confirmation_token as string;
      const second = await harness.callTool('exec', {
        host: 'ask-token',
        command: DESTRUCTIVE,
        confirmation_token: token,
      });
      expect(second.isError, second.text).toBe(false);
    });

    const lines = readAudit();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      approval_outcome: 'pending-confirmation',
      error_code: ERROR_CODES.confirmation_required,
      exit_code: null,
      server_cannot_verify_human_approval: false,
    });
    expect(lines[1]).toMatchObject({
      approval_outcome: 'token-approved',
      error_code: null,
      exit_code: 0,
      // The honesty field: nobody can prove a human approved this line.
      server_cannot_verify_human_approval: true,
    });
  });

  it('never writes the raw token into the audit file (AC19.3)', async () => {
    let token = '';
    await withClient({ elicitation: 'none' }, async (harness) => {
      const first = await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      token = first.body.confirmation_token as string;
    });
    expect(token).not.toBe('');
    expect(fs.readFileSync(auditFilePath(), 'utf8')).not.toContain(token);
  });
});

describe('credentials on a command line (F11)', () => {
  /** A password typed as a flag: the shape the finding names. */
  const SECRET = 'HUNTER2-SENTINEL-4b1c';
  const SECRET_COMMAND = `mysql -p${SECRET} -e "DROP DATABASE prod"`;

  it('masks the password in the audit file while the token round trip still works', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      const asked = await harness.callTool('exec', {
        host: 'ask-token',
        command: SECRET_COMMAND,
      });
      expect(asked.body.status).toBe('confirmation_required');

      const done = await harness.callTool('exec', {
        host: 'ask-token',
        command: SECRET_COMMAND,
        confirmation_token: asked.body.confirmation_token as string,
      });
      // The binding hashes the real command, so the retry matches even though
      // what gets written down is masked.
      expect(done.body.error).not.toBe('confirmation_token_mismatch');
    });

    const raw = fs.readFileSync(auditFilePath(), 'utf8');
    expect(raw).not.toContain(SECRET);

    const lines = readAudit();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(String(line.command)).toContain('mysql');
      expect(String(line.command)).not.toContain(SECRET);
      expect(String(line.normalized_command)).not.toContain(SECRET);
      expect(JSON.stringify(line.segments)).not.toContain(SECRET);
      // Masking must not cost the grade: this is still a dropped database.
      expect(line.command_grade).toBe('destructive');
    }
    expect(lines[1]?.approval_outcome).toBe('token-approved');
  });

  it('masks the password in the elicitation prompt', async () => {
    const seen: string[] = [];
    await withClient(
      {
        elicitation: 'form',
        onElicit: (request) => {
          seen.push(request.message);
          return { action: 'decline' };
        },
      },
      async (harness) => {
        await harness.callTool('exec', { host: 'ask-token', command: SECRET_COMMAND });
      }
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('mysql');
    expect(seen[0]).not.toContain(SECRET);
  });
});

describe('all eight approval outcomes (AC20.4)', () => {
  it('observes each of the eight at least once', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      // not-required: a tool that never reaches the gate.
      await harness.callTool('list_hosts');
      // auto: a host that does not ask.
      await harness.callTool('exec', { host: 'auto', command: 'echo AUTO' });
      // denied.
      await harness.callTool('exec', { host: 'deny', command: DESTRUCTIVE });
      // approval_unavailable.
      await harness.callTool('exec', { host: 'ask-closed', command: DESTRUCTIVE });
      // pending-confirmation, then token-approved.
      const issued = await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      await harness.callTool('exec', {
        host: 'ask-token',
        command: DESTRUCTIVE,
        confirmation_token: issued.body.confirmation_token as string,
      });
    });

    await withClient(
      { elicitation: 'form', onElicit: () => ({ action: 'accept', content: { confirm: true } }) },
      async (harness) => {
        // elicitation-approved.
        await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      }
    );

    await withClient(
      { elicitation: 'form', onElicit: () => ({ action: 'decline' }) },
      async (harness) => {
        // declined.
        await harness.callTool('exec', { host: 'ask-token', command: DESTRUCTIVE });
      }
    );

    const observed = new Set(readAudit().map((line) => line.approval_outcome));
    for (const outcome of APPROVAL_OUTCOMES) {
      expect(observed, `no audit line with approval_outcome ${outcome}`).toContain(outcome);
    }
  });
});

describe('what the file must not contain (AC20.5)', () => {
  it('keeps command output out of the audit line', async () => {
    // The sentinel lives in a file, so it appears in the output and nowhere in
    // the command: a hit in the audit file could only have come from stdout.
    const sentinel = 'AUDIT-OUTPUT-SENTINEL-8f21c';
    // 원격에 있어야 `cat`이 읽습니다. 로컬 `fs`로 `remoteHomeDir`에 쓰면 sshd
    // 티어에서는 러너 쪽 엉뚱한 경로가 되고, 단언은 stdout을 한 번도 보지
    // 못한 채 초록이 됩니다.
    await writeRemoteFile(endpoint, 'audit-sentinel.txt', `${sentinel}\n`);
    const command = `cat ${remotePath('audit-sentinel.txt')}`;

    await withClient({ elicitation: 'none' }, async (harness) => {
      const result = await harness.callTool('exec', { host: 'auto', command });
      expect(result.body.stdout).toContain(sentinel);
    });

    expect(fs.readFileSync(auditFilePath(), 'utf8')).not.toContain(sentinel);
    const line = readAudit()[0];
    expect(line?.command).toBe(command);
    expect(line?.stdout_bytes).toBe(sentinel.length + 1);
    expect(line?.stderr_bytes).toBe(0);
  });

  it('keeps output_ref out of the audit line (D9, AC-O5)', async () => {
    // 60 lines of 35 bytes: over the host's 1 KiB cap so the stream is
    // excerpted, and under `retainCapFor(1024)` = 4 KiB so it is also retained.
    // The response therefore carries a reference, which is the thing that must
    // appear in the response and nowhere else.
    const command = 'awk \'BEGIN{for(i=0;i<60;i++) print "ssh-mcp-output-ref-audit-line-0000"}\'';

    const ref = await withClient({ elicitation: 'none' }, async (harness) => {
      const result = await harness.callTool('exec', { host: 'tight', command });
      expect(result.isError, result.text).toBe(false);
      const meta = result.body.stdout_meta as Record<string, unknown>;
      expect(meta.truncated).toBe(true);
      expect(typeof meta.output_ref).toBe('string');
      return meta.output_ref as string;
    });

    // The audit schema is `.strict()` (`src/audit.ts`), so a record carrying
    // `output_ref` would be rejected outright and no line would be written.
    // Both halves are asserted: the field is absent, and the value never
    // appears anywhere in the file.
    const lines = readAudit();
    expect(lines).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(lines[0] ?? {}, 'output_ref')).toBe(false);
    expect(lines[0]?.truncated).toBe(true);
    expect(fs.readFileSync(auditFilePath(), 'utf8')).not.toContain(ref);
  });
});

describe('classifier forensics (AC20.11)', () => {
  it('records what the classifier actually matched on', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('exec', { host: 'deny', command: "'rm'  -rf /tmp/ssh-mcp-audit-x" });
    });

    const line = readAudit()[0];
    expect(line?.command).toBe("'rm'  -rf /tmp/ssh-mcp-audit-x");
    expect(line?.normalized_command).toBe('rm -rf /tmp/ssh-mcp-audit-x');
    expect(line?.segments).toEqual(['rm -rf /tmp/ssh-mcp-audit-x']);
    expect(line?.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^destructive:/)]));
  });
});

describe('metadata-only hosts (AC20.10)', () => {
  it('nulls the three command fields and keeps everything else', async () => {
    await withClient({ elicitation: 'none' }, async (harness) => {
      await harness.callTool('exec', { host: 'meta-only', command: DESTRUCTIVE });
    });

    const lines = readAudit();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line?.audit_mode).toBe('metadata-only');
    expect(line?.command).toBeNull();
    expect(line?.normalized_command).toBeNull();
    expect(line?.segments).toBeNull();
    // Everything the acceptance criteria ask for is still there.
    expect(line?.host).toBe('meta-only');
    expect(line?.command_grade).toBe('destructive');
    expect(line?.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^destructive:/)]));
    expect(line?.approval_outcome).toBe('pending-confirmation');
    expect(line?.approval_mode).toBe('ask-destructive');
    expect(line?.approval_fallback).toBe('token');
  });
});
