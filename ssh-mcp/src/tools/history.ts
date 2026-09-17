/**
 * `history` — read back the audit log (plan rows C6, C7, C8; AC-H1, AC-H3).
 *
 * The audit file has always been the record of what this server did; until now
 * the only way to read it was to open the file by hand. This tool answers
 * newest-first over the live file and its rotations, filtered, one page at a
 * time (`src/audit/reader.ts`, `src/audit/cursor.ts`).
 *
 * Three decisions worth keeping:
 *
 * - **No approval, no host.** Reading the record is safe-grade and needs no
 *   registry entry, so a broken `hosts.json` does not take the audit trail down
 *   with it. The call itself is still audited, because `runTool()` wraps every
 *   handler — `tool: "history"`, `command: null`, with no code here (AC-H5).
 * - **Unreadable lines are counted, never echoed.** A line that is not JSON, or
 *   that carries a schema version this build does not know, is skipped and
 *   tallied in `skipped`. Returning its text would hand back whatever corrupted
 *   the file in the first place (AC-H3).
 * - **A page can end early.** Filters can make a page scan far more lines than
 *   it returns, so the scan is bounded by {@link MAX_SCANNED_LINES} and hands
 *   back a cursor. Callers must page until `next_cursor` is `null` rather than
 *   until `entries` is empty.
 */
import { z } from 'zod';

import {
  AUDIT_SCHEMA_VERSION,
  APPROVAL_OUTCOMES,
  getAuditThresholds,
  TOOL_NAMES,
} from '../audit.js';
import { COMMAND_GRADES } from '../config/schema.js';
import { CodedError, ERROR_CODES } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { auditFileSize, walkAuditLines, type WalkedLine, type WalkStart } from '../audit/reader.js';
import { decodeCursor, encodeCursor, lineHash, resolveCursor } from '../audit/cursor.js';
import type { ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import type { AuditDraft } from './wrap.js';

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

/**
 * Lines one call may examine before it stops and returns a cursor.
 *
 * A narrow filter over four full rotations would otherwise read 40 MiB
 * synchronously for a page of 50 entries, which is the event-loop stall the
 * plan's pre-mortem warns about. Stopping early costs the caller another call
 * and costs correctness nothing, because the cursor names the exact line the
 * scan stopped at.
 */
export const MAX_SCANNED_LINES = 10_000;

export const HISTORY_DESCRIPTION = [
  '이 서버가 남긴 감사 로그를 최신순으로 조회한다.',
  '호스트·기간·등급·도구·승인 결과로 거를 수 있고, 회전된 파일까지 이어 읽는다.',
  '`next_cursor`를 다음 호출의 `cursor`로 넘겨 페이지를 잇는다 — 페이징 종료 판정은 `entries`가 비었는지가 아니라 `next_cursor === null`로 한다(필터가 좁으면 결과 없는 페이지가 나올 수 있다).',
  '읽을 수 없는 줄은 건너뛰고 개수만 `skipped`에 보고하며 원문은 싣지 않는다.',
  '감사 파일이 회전해 커서를 이어받을 수 없으면 `history_cursor_stale`을 돌려준다 — 그때는 `cursor` 없이 다시 조회한다.',
].join(' ');

const IsoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'ISO 8601 시각이 아닙니다' });

export const historyShape = {
  host: z.string().optional().describe('이 alias로 기록된 줄만 반환한다.'),
  since: IsoTimestamp.optional().describe('이 시각 이후(포함)에 기록된 줄만 반환한다. ISO 8601.'),
  until: IsoTimestamp.optional().describe('이 시각 이전(포함)에 기록된 줄만 반환한다. ISO 8601.'),
  grade: z
    .enum(COMMAND_GRADES)
    .optional()
    .describe('명령 분류 등급으로 거른다. 명령이 없는 호출은 등급도 없으므로 제외된다.'),
  tool: z.enum(TOOL_NAMES).optional().describe('이 도구의 호출만 반환한다.'),
  outcome: z.enum(APPROVAL_OUTCOMES).optional().describe('승인 결과로 거른다.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_LIMIT)
    .optional()
    .describe(
      `반환할 최대 줄 수. 기본 ${String(DEFAULT_HISTORY_LIMIT)}, 최대 ${String(MAX_HISTORY_LIMIT)}.`
    ),
  cursor: z
    .string()
    .optional()
    .describe('직전 응답의 `next_cursor`. 생략하면 가장 최신 줄부터 읽는다.'),
};

const historyArgs = z.object(historyShape);
type HistoryArgs = z.infer<typeof historyArgs>;

/** Counters for lines that were read but could not be returned (AC-H3). */
interface SkipCounts {
  invalid_json: number;
  unknown_schema: number;
}

/**
 * Decode one line into a record, or say which skip bucket it falls in.
 *
 * A JSON value that is not an object counts as broken JSON rather than as an
 * unknown schema: there is no schema version to read, so nothing distinguishes
 * it from a truncated write.
 */
function decodeLine(text: string): Record<string, unknown> | keyof SkipCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'invalid_json';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid_json';
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== AUDIT_SCHEMA_VERSION) return 'unknown_schema';
  return record;
}

function matches(record: Record<string, unknown>, args: HistoryArgs): boolean {
  if (args.host !== undefined && record.host !== args.host) return false;
  if (args.tool !== undefined && record.tool !== args.tool) return false;
  if (args.grade !== undefined && record.command_grade !== args.grade) return false;
  if (args.outcome !== undefined && record.approval_outcome !== args.outcome) return false;

  if (args.since !== undefined || args.until !== undefined) {
    const ts = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN;
    // An unparseable timestamp cannot satisfy a time window; it is still a
    // valid record, so it is filtered out rather than counted as skipped.
    if (Number.isNaN(ts)) return false;
    if (args.since !== undefined && ts < Date.parse(args.since)) return false;
    if (args.until !== undefined && ts > Date.parse(args.until)) return false;
  }
  return true;
}

/** Where to start reading: a resolved cursor, or the end of the live file. */
function startFrom(args: HistoryArgs, maxFileIndex: number): WalkStart {
  if (args.cursor === undefined) {
    return { fileIndex: 0, end: auditFileSize(0) ?? 0 };
  }

  const cursor = decodeCursor(args.cursor);
  if (cursor === null) {
    throw new CodedError(
      ERROR_CODES.history_cursor_stale,
      '커서를 해석할 수 없습니다. cursor 없이 다시 조회하십시오.',
      { reason: 'malformed' }
    );
  }

  const resolved = resolveCursor(cursor, maxFileIndex);
  if (!resolved.ok) {
    throw new CodedError(
      ERROR_CODES.history_cursor_stale,
      '감사 로그가 회전해 이 커서를 이어받을 수 없습니다. cursor 없이 다시 조회하십시오.',
      { reason: resolved.reason }
    );
  }
  return { fileIndex: resolved.fileIndex, end: resolved.end };
}

/** Cursor for the line a page stopped at, measured at the moment it stopped. */
function cursorFor(line: WalkedLine): string {
  return encodeCursor({
    f: line.fileIndex,
    o: line.offset,
    s: auditFileSize(line.fileIndex) ?? 0,
    h: lineHash(line.text),
  });
}

async function handler(
  raw: Record<string, unknown>,
  _ctx: ToolContext,
  _audit: AuditDraft
): Promise<ToolTextResult> {
  const args = historyArgs.parse(raw);
  const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
  const maxFileIndex = Math.max(0, getAuditThresholds().keepFiles - 1);

  const entries: Record<string, unknown>[] = [];
  const skipped: SkipCounts = { invalid_json: 0, unknown_schema: 0 };
  let nextCursor: string | null = null;
  let scanned = 0;

  for (const line of walkAuditLines(startFrom(args, maxFileIndex), maxFileIndex)) {
    if (entries.length >= limit || scanned >= MAX_SCANNED_LINES) {
      // Anchor the next page on this line without reading it, so nothing is
      // counted twice when the caller comes back with the cursor.
      nextCursor = cursorFor(line);
      break;
    }
    scanned += 1;

    const decoded = decodeLine(line.text);
    if (typeof decoded === 'string') {
      skipped[decoded] += 1;
      continue;
    }
    if (matches(decoded, args)) entries.push(decoded);
  }

  // The entries are audit records this server wrote and already redacted on the
  // way in (§5.10); re-running `redact()` here would re-truncate the forensic
  // fields the audit writer deliberately keeps at 16 KiB.
  const body = { entries, next_cursor: nextCursor, skipped };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const historyTool: ToolDefinition = {
  name: 'history',
  description: HISTORY_DESCRIPTION,
  inputSchema: historyShape,
  handler,
};
