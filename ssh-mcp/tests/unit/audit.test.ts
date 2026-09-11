import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_OUTCOMES,
  AuditRecordSchema,
  TRUNCATION_ORDER,
  appendAudit,
  enforceLineCap,
  resetAuditState,
  resetAuditThresholds,
  setAuditThresholds,
} from '../../src/audit.js';
import type { AuditRecordInput } from '../../src/audit.js';
import { auditFilePath, auditRotatedFilePath } from '../../src/config/paths.js';
import { setLogLevel } from '../../src/log.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

/** Every field AC20.2 requires on every line. */
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

const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

let home: TmpHome;

function record(overrides: Record<string, unknown> = {}): AuditRecordInput {
  return { tool: 'exec', approval_outcome: 'auto', ...overrides } as AuditRecordInput;
}

function readLines(file = auditFilePath()): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function captureStderr(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

beforeEach(() => {
  home = createTmpHome('ssh-mcp-audit-');
  resetAuditThresholds();
  resetAuditState();
  setLogLevel('debug');
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel(null);
  resetAuditThresholds();
  resetAuditState();
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('appendAudit basics (AC20.1, AC20.2)', () => {
  it('writes exactly one line per call, with every required field present', () => {
    expect(appendAudit(record())).toBe(true);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    for (const field of REQUIRED_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(line, field)).toBe(true);
    }
    expect(Object.keys(line)).toHaveLength(REQUIRED_FIELDS.length);
  });

  it('stamps schemaVersion 1 and an ISO timestamp on every line', () => {
    appendAudit(record());
    appendAudit(record({ tool: 'list_hosts' }));
    const lines = readLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.schemaVersion).toBe(1);
      expect(typeof line.ts).toBe('string');
      expect(new Date(String(line.ts)).toISOString()).toBe(line.ts);
    }
  });

  it('keeps a caller-supplied timestamp', () => {
    appendAudit(record({ ts: '2026-09-11T12:00:00.000Z' }));
    expect(readLines()[0]?.ts).toBe('2026-09-11T12:00:00.000Z');
  });

  it.each(['list_hosts', 'exec', 'upload', 'download', 'open_session', 'run_in_session', 'close_session'])(
    'accepts tool %s',
    (tool) => {
      expect(appendAudit(record({ tool }))).toBe(true);
    },
  );

  it('rejects an unknown tool name without writing anything', () => {
    const captured = captureStderr();
    expect(appendAudit(record({ tool: 'restart_service' }))).toBe(false);
    expect(fs.existsSync(auditFilePath())).toBe(false);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0] ?? '').toContain('"level":"warn"');
  });
});

describe('approval_outcome (AC20.4)', () => {
  it('accepts exactly the eight documented values', () => {
    expect(APPROVAL_OUTCOMES).toEqual([
      'not-required',
      'auto',
      'elicitation-approved',
      'token-approved',
      'pending-confirmation',
      'declined',
      'denied',
      'approval_unavailable',
    ]);
    for (const outcome of APPROVAL_OUTCOMES) {
      expect(appendAudit(record({ approval_outcome: outcome }))).toBe(true);
    }
    const lines = readLines();
    expect(lines).toHaveLength(APPROVAL_OUTCOMES.length);
    expect(lines.map((line) => line.approval_outcome)).toEqual([...APPROVAL_OUTCOMES]);
  });

  it.each(['approved', 'ok', 'elicitation_approved', '', 'not-required '])(
    'rejects %s',
    (outcome) => {
      const captured = captureStderr();
      expect(appendAudit(record({ approval_outcome: outcome }))).toBe(false);
      expect(captured.lines).toHaveLength(1);
    },
  );

  it('forces server_cannot_verify_human_approval for token-approved', () => {
    appendAudit(
      record({ approval_outcome: 'token-approved', server_cannot_verify_human_approval: false }),
    );
    expect(readLines()[0]?.server_cannot_verify_human_approval).toBe(true);
  });

  it('leaves the flag alone for other outcomes', () => {
    appendAudit(record({ approval_outcome: 'elicitation-approved' }));
    expect(readLines()[0]?.server_cannot_verify_human_approval).toBe(false);
  });
});

describe('redaction (AC19.4)', () => {
  it('masks PEM private key material in the command', () => {
    appendAudit(record({ command: `echo "${PEM}" > /tmp/k`, normalized_command: PEM }));
    const raw = fs.readFileSync(auditFilePath(), 'utf8');
    expect(raw).not.toContain('-----BEGIN');
    expect(raw).toContain('[redacted-private-key]');
  });
});

describe('16 KiB line cap truncation order (AC20.9)', () => {
  const ORDER_FIXTURE = {
    schemaVersion: 1 as const,
    ts: '2026-09-11T12:00:00.000Z',
    tool: 'exec' as const,
    approval_outcome: 'auto' as const,
    command: 'A'.repeat(2000),
    normalized_command: 'N'.repeat(1000),
    segments: ['S'.repeat(400), 'T'.repeat(400)],
    reasons: ['reason-one', 'reason-two'],
  };

  function fixture(): ReturnType<typeof AuditRecordSchema.parse> {
    return AuditRecordSchema.parse(ORDER_FIXTURE);
  }

  function fullBytes(): number {
    return byteLength(JSON.stringify(fixture()));
  }

  it('documents the order as command -> segments -> normalized_command -> reasons', () => {
    expect(TRUNCATION_ORDER).toEqual(['command', 'segments', 'normalized_command', 'reasons']);
  });

  it('leaves a line under the cap untouched', () => {
    const record = fixture();
    expect(enforceLineCap(record, fullBytes())).toEqual(record);
  });

  it('cuts command first and nothing else', () => {
    const cap = fullBytes() - 500;
    const out = enforceLineCap(fixture(), cap);
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(cap);
    expect(out.command?.endsWith('[truncated]')).toBe(true);
    expect(byteLength(out.command ?? '')).toBeLessThan(2000);
    expect(out.normalized_command).toBe(ORDER_FIXTURE.normalized_command);
    expect(out.segments).toEqual(ORDER_FIXTURE.segments);
    expect(out.reasons).toEqual(ORDER_FIXTURE.reasons);
  });

  it('moves on to segments only after command is exhausted', () => {
    const cap = fullBytes() - 2600;
    const out = enforceLineCap(fixture(), cap);
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(cap);
    expect(out.command === '' || out.command === '[truncated]').toBe(true);
    expect(out.segments).toEqual([]);
    expect(out.normalized_command).toBe(ORDER_FIXTURE.normalized_command);
    expect(out.reasons).toEqual(ORDER_FIXTURE.reasons);
  });

  it('cuts normalized_command third', () => {
    const cap = fullBytes() - 3300;
    const out = enforceLineCap(fixture(), cap);
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(cap);
    expect(out.command === '' || out.command === '[truncated]').toBe(true);
    expect(out.segments).toEqual([]);
    expect(out.normalized_command).not.toBe(ORDER_FIXTURE.normalized_command);
    expect(out.reasons).toEqual(ORDER_FIXTURE.reasons);
  });

  it('drops reasons last', () => {
    const cap = fullBytes() - 3900;
    const out = enforceLineCap(fixture(), cap);
    expect(out.command === '' || out.command === '[truncated]').toBe(true);
    expect(out.segments).toEqual([]);
    expect(out.normalized_command).not.toBe(ORDER_FIXTURE.normalized_command);
    expect(out.reasons).toEqual([]);
  });

  it('applies the cap on the real write path', () => {
    setAuditThresholds({ lineMaxBytes: 900 });
    appendAudit(record({ command: 'x'.repeat(5000), normalized_command: 'y'.repeat(5000) }));
    const raw = fs.readFileSync(auditFilePath(), 'utf8');
    expect(byteLength(raw.trimEnd())).toBeLessThanOrEqual(900);
    const line = readLines()[0] ?? {};
    expect(line.approval_outcome).toBe('auto');
    expect(line.schemaVersion).toBe(1);
  });
});

describe('metadata-only mode (AC20.10)', () => {
  it('nulls the three command fields and keeps everything else', () => {
    appendAudit(
      record({
        audit_mode: 'metadata-only',
        host: 'web01',
        session_id: 'sess-1',
        command: 'rm -rf /var/log',
        normalized_command: 'rm -rf /var/log',
        segments: ['rm -rf /var/log'],
        command_grade: 'destructive',
        reasons: ['destructive:rm-recursive'],
        approval_mode: 'ask-destructive',
        approval_fallback: 'fail-closed',
        approval_outcome: 'denied',
        exit_code: null,
        error_code: 'command_denied',
        exec_duration_ms: 12,
        approval_wait_ms: 34,
        stdout_bytes: 0,
        stderr_bytes: 0,
        truncated: false,
        client: { name: 'claude-desktop', version: '1.2.3' },
      }),
    );

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line.command).toBeNull();
    expect(line.normalized_command).toBeNull();
    expect(line.segments).toBeNull();

    expect(line.audit_mode).toBe('metadata-only');
    expect(line.host).toBe('web01');
    expect(line.session_id).toBe('sess-1');
    expect(line.command_grade).toBe('destructive');
    expect(line.reasons).toEqual(['destructive:rm-recursive']);
    expect(line.approval_mode).toBe('ask-destructive');
    expect(line.approval_fallback).toBe('fail-closed');
    expect(line.approval_outcome).toBe('denied');
    expect(line.error_code).toBe('command_denied');
    expect(line.exec_duration_ms).toBe(12);
    expect(line.approval_wait_ms).toBe(34);
    expect(line.client).toEqual({ name: 'claude-desktop', version: '1.2.3' });
    expect(fs.readFileSync(auditFilePath(), 'utf8')).not.toContain('/var/log');
  });

  it('keeps the command fields in full mode', () => {
    appendAudit(record({ command: 'ls -al', normalized_command: 'ls -al', segments: ['ls -al'] }));
    const line = readLines()[0] ?? {};
    expect(line.command).toBe('ls -al');
    expect(line.normalized_command).toBe('ls -al');
    expect(line.segments).toEqual(['ls -al']);
    expect(line.audit_mode).toBe('full');
  });
});

describe('rotation (AC20.7)', () => {
  it('rotates at the threshold and keeps four files', () => {
    setAuditThresholds({ rotateBytes: 1200, statIntervalBytes: 1, keepFiles: 4 });
    for (let i = 0; i < 60; i += 1) {
      expect(appendAudit(record({ command: `echo ${String(i)}` }))).toBe(true);
    }

    expect(fs.existsSync(auditRotatedFilePath(1))).toBe(true);
    expect(fs.existsSync(auditRotatedFilePath(2))).toBe(true);
    expect(fs.existsSync(auditRotatedFilePath(3))).toBe(true);
    expect(fs.existsSync(auditRotatedFilePath(4))).toBe(false);

    // The live file keeps receiving valid lines after a rotation.
    const live = readLines();
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((line) => line.schemaVersion === 1)).toBe(true);
    expect(readLines(auditRotatedFilePath(1)).length).toBeGreaterThan(0);
  });

  it('does not rotate below the threshold', () => {
    setAuditThresholds({ rotateBytes: 10 * 1024 * 1024, statIntervalBytes: 1 });
    for (let i = 0; i < 20; i += 1) appendAudit(record({ command: `echo ${String(i)}` }));
    expect(fs.existsSync(auditRotatedFilePath(1))).toBe(false);
    expect(readLines()).toHaveLength(20);
  });

  it('only stats the file once per statInterval', () => {
    setAuditThresholds({ rotateBytes: 500, statIntervalBytes: 1024 * 1024 });
    for (let i = 0; i < 20; i += 1) appendAudit(record({ command: `echo ${String(i)}` }));
    // The first append stats an absent file; the rest stay under the interval,
    // so no rotation happens even though the file passed rotateBytes.
    expect(fs.existsSync(auditRotatedFilePath(1))).toBe(false);
    expect(readLines()).toHaveLength(20);
  });
});

describe('write failure (AC20.8)', () => {
  it('does not throw and logs exactly one warn', () => {
    const blocker = path.join(home.dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const previous = process.env.SSH_MCP_HOME;
    process.env.SSH_MCP_HOME = path.join(blocker, 'nested');
    try {
      const captured = captureStderr();
      let result: boolean | undefined;
      expect(() => {
        result = appendAudit(record({ command: 'echo hi' }));
      }).not.toThrow();
      expect(result).toBe(false);
      expect(captured.lines).toHaveLength(1);
      const warn = JSON.parse(captured.lines[0] ?? '{}') as Record<string, unknown>;
      expect(warn.level).toBe('warn');
      expect(String(warn.msg)).toContain('audit.jsonl');
    } finally {
      if (previous === undefined) delete process.env.SSH_MCP_HOME;
      else process.env.SSH_MCP_HOME = previous;
    }
  });
});

describe('file permissions (AC20.6)', () => {
  it.skipIf(process.platform === 'win32')('creates audit.jsonl as 0600', () => {
    appendAudit(record());
    expect(fs.statSync(auditFilePath()).mode & 0o777).toBe(0o600);
  });
});
