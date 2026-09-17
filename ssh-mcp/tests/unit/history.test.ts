/**
 * The `history` tool handler (plan row C6, AC-H1, AC-H2, AC-H3, AC-H4).
 *
 * Driven directly rather than through the MCP client: the filtering, the skip
 * tally and the paging cursor are input-to-output properties, and the audit
 * line the call leaves behind is covered where it belongs, in
 * `tests/integration/audit.test.ts`.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUDIT_SCHEMA_VERSION, resetAuditThresholds, setAuditThresholds } from '../../src/audit.js';
import type { AuditRecordInput } from '../../src/audit.js';
import { auditRotatedFilePath, ensureHome } from '../../src/config/paths.js';
import { ERROR_CODES } from '../../src/errors.js';
import { createToolContext, type ToolContext } from '../../src/tools/context.js';
import {
  DEFAULT_HISTORY_LIMIT,
  historyTool,
  MAX_HISTORY_LIMIT,
  MAX_SCANNED_LINES,
} from '../../src/tools/history.js';
import { newAuditDraft } from '../../src/tools/wrap.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

const ctx: ToolContext = createToolContext({
  client: () => null,
  elicit: () => Promise.reject(new Error('history must never elicit')),
});

beforeEach(() => {
  home = createTmpHome('ssh-mcp-history-');
  ensureHome();
});

afterEach(() => {
  resetAuditThresholds();
  assertNoWritesOutside(home);
  home.cleanup();
});

interface HistoryBody {
  entries: Record<string, unknown>[];
  next_cursor: string | null;
  skipped: { invalid_json: number; unknown_schema: number };
}

async function call(args: Record<string, unknown> = {}): Promise<HistoryBody> {
  const result = await historyTool.handler(args, ctx, newAuditDraft());
  expect(result.isError, result.content[0]?.text).toBe(false);
  return JSON.parse(result.content[0]?.text ?? '{}') as HistoryBody;
}

async function callExpectingError(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await expect(historyTool.handler(args, ctx, newAuditDraft())).rejects.toMatchObject({
    code: ERROR_CODES.history_cursor_stale,
  });
  return {};
}

/** Minimal valid record; `overrides` shapes what a test filters on. */
function record(overrides: Partial<AuditRecordInput> & { ts: string }): string {
  return JSON.stringify({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    tool: 'exec',
    host: 'alpha',
    session_id: null,
    command: 'echo hi',
    command_grade: 'safe',
    reasons: [],
    approval_mode: 'auto',
    approval_outcome: 'auto',
    approval_fallback: 'token',
    server_cannot_verify_human_approval: false,
    exit_code: 0,
    error_code: null,
    exec_duration_ms: 1,
    approval_wait_ms: 0,
    stdout_bytes: 3,
    stderr_bytes: 0,
    truncated: false,
    normalized_command: 'echo hi',
    segments: ['echo hi'],
    client: null,
    audit_mode: 'full',
    ...overrides,
  });
}

function writeLines(fileIndex: number, lines: string[]): void {
  fs.writeFileSync(
    auditRotatedFilePath(fileIndex),
    lines.map((line) => `${line}\n`).join(''),
    'utf8'
  );
}

function tsAt(minute: number): string {
  return new Date(Date.UTC(2026, 8, 16, 0, minute, 0)).toISOString();
}

describe('empty and absent files', () => {
  it('answers with an empty page when there is no audit file', async () => {
    const body = await call();
    expect(body).toEqual({
      entries: [],
      next_cursor: null,
      skipped: { invalid_json: 0, unknown_schema: 0 },
    });
  });
});

describe('newest first (AC-H1)', () => {
  it('returns the most recent lines first', async () => {
    writeLines(0, [
      record({ ts: tsAt(1), command: 'first' }),
      record({ ts: tsAt(2), command: 'second' }),
      record({ ts: tsAt(3), command: 'third' }),
    ]);

    const body = await call();
    expect(body.entries.map((entry) => entry.command)).toEqual(['third', 'second', 'first']);
    expect(body.next_cursor).toBeNull();
  });

  it('reads across rotations (AC-H2)', async () => {
    writeLines(0, [record({ ts: tsAt(5), command: 'live' })]);
    writeLines(1, [record({ ts: tsAt(4), command: 'rot1' })]);
    writeLines(2, [record({ ts: tsAt(3), command: 'rot2' })]);

    const body = await call();
    expect(body.entries.map((entry) => entry.command)).toEqual(['live', 'rot1', 'rot2']);
  });

  it('stops at the rotations it keeps', async () => {
    setAuditThresholds({ keepFiles: 2 });
    writeLines(0, [record({ ts: tsAt(2), command: 'live' })]);
    writeLines(1, [record({ ts: tsAt(1), command: 'rot1' })]);
    writeLines(2, [record({ ts: tsAt(0), command: 'rot2' })]);

    const body = await call();
    expect(body.entries.map((entry) => entry.command)).toEqual(['live', 'rot1']);
  });
});

describe('filters (AC-H1)', () => {
  beforeEach(() => {
    writeLines(0, [
      record({ ts: tsAt(1), host: 'alpha', tool: 'exec', command_grade: 'safe' }),
      record({
        ts: tsAt(2),
        host: 'beta',
        tool: 'exec',
        command_grade: 'destructive',
        approval_outcome: 'declined',
      }),
      record({ ts: tsAt(3), host: 'alpha', tool: 'upload', command_grade: null }),
      record({ ts: tsAt(4), host: null, tool: 'list_hosts', command_grade: null }),
    ]);
  });

  it('filters by host', async () => {
    const body = await call({ host: 'alpha' });
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((entry) => entry.host === 'alpha')).toBe(true);
  });

  it('filters by tool', async () => {
    const body = await call({ tool: 'list_hosts' });
    expect(body.entries.map((entry) => entry.tool)).toEqual(['list_hosts']);
  });

  it('filters by grade, which excludes calls that had no command', async () => {
    const body = await call({ grade: 'destructive' });
    expect(body.entries.map((entry) => entry.host)).toEqual(['beta']);
  });

  it('filters by approval outcome', async () => {
    const body = await call({ outcome: 'declined' });
    expect(body.entries.map((entry) => entry.host)).toEqual(['beta']);
  });

  it('filters by an inclusive time window', async () => {
    const body = await call({ since: tsAt(2), until: tsAt(3) });
    expect(body.entries.map((entry) => entry.ts)).toEqual([tsAt(3), tsAt(2)]);
  });

  it('combines filters', async () => {
    const body = await call({ host: 'alpha', since: tsAt(2) });
    expect(body.entries.map((entry) => entry.tool)).toEqual(['upload']);
  });

  it('rejects a timestamp that is not ISO 8601', async () => {
    await expect(historyTool.handler({ since: 'yesterday' }, ctx, newAuditDraft())).rejects.toThrow(
      /ISO 8601/
    );
  });
});

describe('unreadable lines (AC-H3)', () => {
  it('counts broken JSON and unknown schema versions without echoing them', async () => {
    const secret = 'CORRUPT-LINE-SENTINEL';
    writeLines(0, [
      record({ ts: tsAt(1) }),
      `{"not json ${secret}`,
      `"${secret}"`,
      JSON.stringify({ schemaVersion: 2, tool: 'exec', note: secret }),
    ]);

    const result = await historyTool.handler({}, ctx, newAuditDraft());
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain(secret);

    const body = JSON.parse(text) as HistoryBody;
    expect(body.entries).toHaveLength(1);
    expect(body.skipped).toEqual({ invalid_json: 2, unknown_schema: 1 });
  });
});

describe('paging (AC-H2a)', () => {
  it('defaults to 50 and caps at 200', async () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
    expect(MAX_HISTORY_LIMIT).toBe(200);
    writeLines(
      0,
      Array.from({ length: 60 }, (_, i) => record({ ts: tsAt(i), command: `cmd-${String(i)}` }))
    );

    const body = await call();
    expect(body.entries).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(body.next_cursor).not.toBeNull();

    await expect(historyTool.handler({ limit: 201 }, ctx, newAuditDraft())).rejects.toThrow();
  });

  it('walks the whole file in pages with no gaps and no repeats', async () => {
    const total = 25;
    writeLines(
      0,
      Array.from({ length: total }, (_, i) => record({ ts: tsAt(i), command: `cmd-${String(i)}` }))
    );

    const seen: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: HistoryBody = await call(cursor === null ? { limit: 7 } : { limit: 7, cursor });
      seen.push(...body.entries.map((entry) => entry.command));
      cursor = body.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe(`cmd-${String(total - 1)}`);
    expect(seen[total - 1]).toBe('cmd-0');
  });

  it('keeps a page unbroken when lines are appended between calls (AC-H2a)', async () => {
    writeLines(
      0,
      Array.from({ length: 6 }, (_, i) => record({ ts: tsAt(i), command: `cmd-${String(i)}` }))
    );

    const first = await call({ limit: 3 });
    expect(first.entries.map((entry) => entry.command)).toEqual(['cmd-5', 'cmd-4', 'cmd-3']);
    expect(first.next_cursor).not.toBeNull();

    fs.appendFileSync(
      auditRotatedFilePath(0),
      `${record({ ts: tsAt(9), command: 'appended' })}\n`,
      'utf8'
    );

    const second = await call({ limit: 3, cursor: first.next_cursor as string });
    expect(second.entries.map((entry) => entry.command)).toEqual(['cmd-2', 'cmd-1', 'cmd-0']);
    expect(second.next_cursor).toBeNull();
  });

  it('pages into a rotation that happened between calls (AC-H2b)', async () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      record({ ts: tsAt(i), command: `cmd-${String(i)}` })
    );
    writeLines(0, lines);

    const first = await call({ limit: 3 });
    expect(first.entries.map((entry) => entry.command)).toEqual(['cmd-5', 'cmd-4', 'cmd-3']);

    // Rotate by hand, exactly as `src/audit.ts` does: live becomes `.1`.
    fs.renameSync(auditRotatedFilePath(0), auditRotatedFilePath(1));
    writeLines(0, [record({ ts: tsAt(10), command: 'after-rotation' })]);

    const second = await call({ limit: 3, cursor: first.next_cursor as string });
    expect(second.entries.map((entry) => entry.command)).toEqual(['cmd-2', 'cmd-1', 'cmd-0']);
  });

  it('reports a cursor it cannot resume as history_cursor_stale (AC-H2b)', async () => {
    writeLines(
      0,
      Array.from({ length: 6 }, (_, i) => record({ ts: tsAt(i), command: `cmd-${String(i)}` }))
    );
    const first = await call({ limit: 3 });

    // Two rotations: the file the cursor was cut against is now `.2`.
    fs.renameSync(auditRotatedFilePath(0), auditRotatedFilePath(2));
    writeLines(1, [record({ ts: tsAt(20), command: 'unrelated' })]);
    writeLines(0, [record({ ts: tsAt(21), command: 'newest' })]);

    await callExpectingError({ cursor: first.next_cursor as string });
  });

  it('reports a malformed cursor as history_cursor_stale', async () => {
    writeLines(0, [record({ ts: tsAt(1) })]);
    await callExpectingError({ cursor: 'this-is-not-a-cursor' });
  });

  it('bounds the scan and hands back a cursor instead of stalling', async () => {
    // Every line is filtered out, so nothing is returned; the cursor is what
    // keeps the call bounded and the walk resumable.
    expect(MAX_SCANNED_LINES).toBeGreaterThan(0);
    writeLines(
      0,
      Array.from({ length: MAX_SCANNED_LINES + 5 }, (_, i) =>
        record({ ts: tsAt(0), host: 'other', command: `cmd-${String(i)}` })
      )
    );

    const body = await call({ host: 'absent' });
    expect(body.entries).toEqual([]);
    expect(body.next_cursor).not.toBeNull();
  });
});
