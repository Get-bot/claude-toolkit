/**
 * The one place every tool call passes through (plan row 4.13, §5.10, AC20).
 *
 * Audit is written here and nowhere else. If each tool wrote its own line, the
 * paths that matter most — denied, refused, `confirmation_required`, and an
 * unexpected throw — would be exactly the ones a future edit forgets. Here,
 * "every call is recorded" is a property of the call path rather than of seven
 * separate promises (AC20.1, AC20.3, AC20.4).
 *
 * The handler fills a mutable {@link AuditDraft} as it learns things, instead
 * of returning them, so that a throw halfway through still leaves the host,
 * the command and the approval decision on the record.
 */
import type { ApprovalFallback, ApprovalMode, AuditMode, CommandGrade } from '../config/schema.js';
import { appendAudit, type ApprovalOutcome, type ToolName } from '../audit.js';
import { ERROR_CODES, isCodedError, toToolError } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { logger } from '../log.js';
import type { GateResult } from '../safety/approval.js';
import type { ExcerptMeta } from '../ssh/excerpt.js';
import type { ToolContext } from './context.js';

/** Mutable §5.10 record under construction. */
export interface AuditDraft {
  host: string | null;
  session_id: string | null;
  command: string | null;
  command_grade: CommandGrade | null;
  reasons: string[] | null;
  approval_mode: ApprovalMode | null;
  approval_fallback: ApprovalFallback | null;
  approval_outcome: ApprovalOutcome;
  server_cannot_verify_human_approval: boolean;
  exit_code: number | null;
  error_code: string | null;
  exec_duration_ms: number;
  approval_wait_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: boolean;
  normalized_command: string | null;
  segments: string[] | null;
  audit_mode: AuditMode;
}

/**
 * A call that never reached the approval gate is `not-required`: no approval
 * was asked for and none was skipped. `list_hosts`, the two transfer tools and
 * the session lifecycle tools stay on this value.
 */
export function newAuditDraft(): AuditDraft {
  return {
    host: null,
    session_id: null,
    command: null,
    command_grade: null,
    reasons: null,
    approval_mode: null,
    approval_fallback: null,
    approval_outcome: 'not-required',
    server_cannot_verify_human_approval: false,
    exit_code: null,
    error_code: null,
    exec_duration_ms: 0,
    approval_wait_ms: 0,
    stdout_bytes: 0,
    stderr_bytes: 0,
    truncated: false,
    normalized_command: null,
    segments: null,
    audit_mode: 'full',
  };
}

/** Copy the gate's verdict onto the record (all six `GateResult` kinds). */
export function applyGateToAudit(audit: AuditDraft, gate: GateResult): void {
  audit.approval_outcome = gate.approvalOutcome;
  audit.approval_wait_ms = gate.approvalWaitMs;
  audit.error_code = gate.errorCode;
  audit.server_cannot_verify_human_approval = gate.approvalOutcome === 'token-approved';
  if (gate.classification !== null) {
    audit.command_grade = gate.classification.grade;
    audit.reasons = gate.classification.reasons;
    audit.normalized_command = gate.classification.normalized;
    audit.segments = gate.classification.segments;
  }
}

/** Byte counts and the truncation flag from a finished command (AC20.5). */
export function applyOutputToAudit(
  audit: AuditDraft,
  stdoutMeta: ExcerptMeta,
  stderrMeta: ExcerptMeta
): void {
  audit.stdout_bytes = stdoutMeta.total_bytes;
  audit.stderr_bytes = stderrMeta.total_bytes;
  audit.truncated = stdoutMeta.truncated || stderrMeta.truncated;
}

function isExcerptMeta(value: unknown): value is ExcerptMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { total_bytes?: unknown }).total_bytes === 'number' &&
    typeof (value as { truncated?: unknown }).truncated === 'boolean'
  );
}

/**
 * A timed-out command still produced output, and both the one-shot and the
 * session path attach the excerpt metadata to the error. Reading it here keeps
 * the byte counts on the audit line for the call that failed.
 */
function applyErrorDetailsToAudit(audit: AuditDraft, details: Record<string, unknown>): void {
  const stdoutMeta = details.stdout_meta;
  const stderrMeta = details.stderr_meta;
  if (isExcerptMeta(stdoutMeta) && isExcerptMeta(stderrMeta)) {
    applyOutputToAudit(audit, stdoutMeta, stderrMeta);
  }
  const duration = details.duration_ms;
  if (typeof duration === 'number' && audit.exec_duration_ms === 0) {
    audit.exec_duration_ms = duration;
  }
}

/** What a tool handler does, given its parsed arguments. */
export type ToolBody = (audit: AuditDraft) => Promise<ToolTextResult>;

/**
 * Run one tool call and append exactly one audit line.
 *
 * Nothing escapes to the SDK: a {@link CodedError} becomes its own error code,
 * anything else becomes `internal_error` plus one redacted `error` log.
 */
export async function runTool(
  name: ToolName,
  ctx: ToolContext,
  body: ToolBody
): Promise<ToolTextResult> {
  const audit = newAuditDraft();
  let result: ToolTextResult;

  try {
    result = await body(audit);
  } catch (err) {
    if (isCodedError(err)) {
      audit.error_code = err.code;
      if (err.details !== undefined) applyErrorDetailsToAudit(audit, err.details);
      result = err.toToolError();
    } else {
      // Unexpected: the message is masked and the stack stays in stderr only.
      logger.error('tool handler threw an unexpected error', {
        tool: name,
        host: audit.host,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      audit.error_code = ERROR_CODES.internal_error;
      result = toToolError(
        ERROR_CODES.internal_error,
        '도구 실행 중 내부 오류가 발생했습니다. 자세한 내용은 서버 stderr 로그를 확인하십시오.',
        { tool: name, host: audit.host }
      );
    }
  }

  const client = ctx.client();
  appendAudit({
    tool: name,
    client: client === null ? null : { name: client.name, version: client.version },
    ...audit,
  });

  return result;
}
