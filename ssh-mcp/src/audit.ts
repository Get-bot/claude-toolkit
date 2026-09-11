/**
 * `~/.ssh-mcp/audit.jsonl` — one JSON line per tool call
 * (plan row 1.8, §5.10, AC20).
 *
 * Write path, in this order:
 *   validate -> redact -> `metadata-only` nulling -> 16 KiB line cap ->
 *   one `fs.appendFileSync`
 *
 * A failure here never breaks a tool call: it is logged once as `warn` and
 * swallowed (OPT-11 A, AC20.8).
 *
 * Note on atomicity: the line cap limits size and lowers the chance of
 * interleaving, but it is *not* an atomicity guarantee. `O_APPEND` on a POSIX
 * regular file is atomic regardless of size, while Windows `FILE_APPEND_DATA`
 * makes no cross-process promise (§5.10).
 */
import fs from 'node:fs';
import { z } from 'zod';

import {
  STATE_FILE_MODE,
  applyStateFileMode,
  auditFilePath,
  auditRotatedFilePath,
  ensureHome,
} from './config/paths.js';
import {
  APPROVAL_FALLBACKS,
  APPROVAL_MODES,
  AUDIT_MODES,
  COMMAND_GRADES,
} from './config/schema.js';
import { TRUNCATION_SUFFIX, logger, redactRecord, truncateUtf8 } from './log.js';

/** Written on every line so a mixed-version file stays readable (§5.10). */
export const AUDIT_SCHEMA_VERSION = 1;

/** The seven v1 tools (AC2.2). Canonical list; import it rather than retyping. */
export const TOOL_NAMES = [
  'list_hosts',
  'exec',
  'upload',
  'download',
  'open_session',
  'run_in_session',
  'close_session',
] as const;

/** Exactly eight outcomes (AC20.4). */
export const APPROVAL_OUTCOMES = [
  'not-required',
  'auto',
  'elicitation-approved',
  'token-approved',
  'pending-confirmation',
  'declined',
  'denied',
  'approval_unavailable',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

export const AuditClientSchema = z
  .object({ name: z.string().max(256), version: z.string().max(64) })
  .strict();

export const AuditRecordSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION).default(AUDIT_SCHEMA_VERSION),
    /** ISO 8601 UTC with milliseconds. Filled by `appendAudit` when omitted. */
    ts: z.string().min(1).max(64),
    tool: z.enum(TOOL_NAMES),
    host: z.string().max(64).nullable().default(null),
    session_id: z.string().max(128).nullable().default(null),
    command: z.string().nullable().default(null),
    command_grade: z.enum(COMMAND_GRADES).nullable().default(null),
    /** Matched pattern ids; `[]` is meaningful (nothing matched). */
    reasons: z.array(z.string().max(128)).nullable().default(null),
    approval_mode: z.enum(APPROVAL_MODES).nullable().default(null),
    approval_outcome: z.enum(APPROVAL_OUTCOMES),
    approval_fallback: z.enum(APPROVAL_FALLBACKS).nullable().default(null),
    /** Forced to `true` for `token-approved` by {@link appendAudit}. */
    server_cannot_verify_human_approval: z.boolean().default(false),
    exit_code: z.number().int().nullable().default(null),
    /** A §5.3 error code, or `null`. Kept as a string so a new code is never dropped. */
    error_code: z.string().max(64).nullable().default(null),
    exec_duration_ms: z.number().nonnegative().default(0),
    approval_wait_ms: z.number().nonnegative().default(0),
    /** Original byte counts, before excerpting (§5.10). */
    stdout_bytes: z.number().int().nonnegative().default(0),
    stderr_bytes: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
    normalized_command: z.string().nullable().default(null),
    segments: z.array(z.string()).nullable().default(null),
    client: AuditClientSchema.nullable().default(null),
    audit_mode: z.enum(AUDIT_MODES).default('full'),
  })
  .strict();

export type AuditRecord = z.infer<typeof AuditRecordSchema>;
/** Everything except `tool` and `approval_outcome` may be omitted. */
export type AuditRecordInput = Omit<z.input<typeof AuditRecordSchema>, 'ts'> & { ts?: string };

export interface AuditThresholds {
  /** Serialised line budget in bytes (§5.10: 16 KiB). */
  lineMaxBytes: number;
  /** Rotate once the live file reaches this size (§5.10: 10 MiB). */
  rotateBytes: number;
  /** Only stat the file after this many bytes have been appended (§5.10: 1 MiB). */
  statIntervalBytes: number;
  /** Total files kept: the live one plus `keepFiles - 1` rotations. */
  keepFiles: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  lineMaxBytes: 16 * 1024,
  rotateBytes: 10 * 1024 * 1024,
  statIntervalBytes: 1024 * 1024,
  keepFiles: 4,
};

let thresholds: AuditThresholds = { ...DEFAULT_AUDIT_THRESHOLDS };
// Large enough that the first append always stats the file.
let bytesSinceSizeCheck = Number.MAX_SAFE_INTEGER;

/** Order in which oversized fields are shortened (§5.10, AC20.9). */
export const TRUNCATION_ORDER = ['command', 'segments', 'normalized_command', 'reasons'] as const;

type TruncatableField = (typeof TRUNCATION_ORDER)[number];

/**
 * Override thresholds. Tests inject small values to exercise rotation and the
 * line cap without writing megabytes.
 */
export function setAuditThresholds(partial: Partial<AuditThresholds>): void {
  thresholds = { ...thresholds, ...partial };
  if (thresholds.keepFiles < 1) thresholds.keepFiles = 1;
  bytesSinceSizeCheck = Number.MAX_SAFE_INTEGER;
}

export function resetAuditThresholds(): void {
  thresholds = { ...DEFAULT_AUDIT_THRESHOLDS };
  bytesSinceSizeCheck = Number.MAX_SAFE_INTEGER;
}

export function getAuditThresholds(): AuditThresholds {
  return { ...thresholds };
}

/** Forget the "bytes since last stat" counter. For tests. */
export function resetAuditState(): void {
  bytesSinceSizeCheck = Number.MAX_SAFE_INTEGER;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function serializedBytes(record: Record<string, unknown>): number {
  return byteLength(JSON.stringify(record));
}

/**
 * Shorten one field by at least `over` bytes. Returns false when the field
 * cannot give up anything more, so the caller moves to the next field.
 */
function shrinkField(
  record: Record<string, unknown>,
  field: TruncatableField,
  over: number
): boolean {
  const value = record[field];

  if (typeof value === 'string') {
    const currentBytes = byteLength(value);
    if (currentBytes === 0) return false;
    const suffixBytes = byteLength(TRUNCATION_SUFFIX);
    const keep = Math.max(0, currentBytes - over - suffixBytes);
    let next = keep === 0 ? TRUNCATION_SUFFIX : truncateUtf8(value, keep) + TRUNCATION_SUFFIX;
    if (byteLength(next) >= currentBytes) {
      // The marker itself would not save anything: drop the content.
      next = '';
    }
    record[field] = next;
    return true;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    let freed = 0;
    let end = value.length;
    // Drop trailing entries until enough bytes are freed (at least one entry).
    while (end > 0 && freed <= over) {
      freed += byteLength(JSON.stringify(value[end - 1])) + 1;
      end -= 1;
    }
    record[field] = value.slice(0, end);
    return true;
  }

  return false;
}

/**
 * Enforce the serialised line budget by shortening
 * `command` -> `segments` -> `normalized_command` -> `reasons` (AC20.9).
 *
 * Best effort over those four fields only: if the remaining metadata alone
 * exceeded the budget the line is written oversized rather than lost.
 */
export function enforceLineCap(record: AuditRecord, lineMaxBytes: number): AuditRecord {
  const mutable: Record<string, unknown> = { ...record };
  if (serializedBytes(mutable) <= lineMaxBytes) return record;

  for (const field of TRUNCATION_ORDER) {
    let guard = 0;
    while (serializedBytes(mutable) > lineMaxBytes && guard < 64) {
      const over = serializedBytes(mutable) - lineMaxBytes;
      if (!shrinkField(mutable, field, over)) break;
      guard += 1;
    }
    if (serializedBytes(mutable) <= lineMaxBytes) break;
  }

  return mutable as unknown as AuditRecord;
}

/** `.3` is deleted, `.2` -> `.3`, `.1` -> `.2`, live file -> `.1` (AC20.7). */
function rotate(): void {
  const maxIndex = thresholds.keepFiles - 1;
  try {
    fs.rmSync(auditRotatedFilePath(maxIndex), { force: true });
  } catch {
    // Nothing to delete, or another process got there first.
  }
  for (let i = maxIndex; i >= 1; i -= 1) {
    try {
      fs.renameSync(auditRotatedFilePath(i - 1), auditRotatedFilePath(i));
    } catch (err) {
      // ENOENT means the file does not exist yet, or another process rotated.
      if (!isEnoent(err)) throw err;
    }
  }
}

function maybeRotate(): void {
  if (bytesSinceSizeCheck < thresholds.statIntervalBytes) return;
  bytesSinceSizeCheck = 0;
  let size: number;
  try {
    size = fs.statSync(auditFilePath()).size;
  } catch (err) {
    if (!isEnoent(err)) throw err;
    return;
  }
  if (size >= thresholds.rotateBytes) rotate();
}

function appendLine(line: string): void {
  ensureHome();
  maybeRotate();
  const path = auditFilePath();
  const existed = fs.existsSync(path);
  fs.appendFileSync(path, line, { mode: STATE_FILE_MODE });
  if (!existed) {
    // appendFileSync's mode is masked by umask, so set 0600 explicitly (AC20.6).
    applyStateFileMode(path);
  }
  bytesSinceSizeCheck += byteLength(line);
}

/**
 * Append one audit line (AC20.1).
 *
 * `ts` and `schemaVersion` are filled in when omitted, and
 * `server_cannot_verify_human_approval` is forced to `true` for
 * `token-approved` so the audit file can never read as if a human approved
 * (§5.10). Returns `true` when a line was written.
 */
export function appendAudit(input: AuditRecordInput): boolean {
  try {
    const candidate: Record<string, unknown> = { ...input };
    if (typeof candidate.ts !== 'string' || candidate.ts === '') {
      candidate.ts = new Date().toISOString();
    }

    const parsed = AuditRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.warn('audit record rejected by schema; nothing written', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map((p) => String(p)).join('.') || '(root)',
          message: issue.message,
        })),
      });
      return false;
    }

    // Redaction runs with the line budget as the per-string ceiling instead of
    // the 2 KiB log ceiling: the ordered cap below decides what gets cut, so
    // the forensic fields are not silently clipped first (§5.10, AC20.9).
    let record = redactRecord(parsed.data as unknown as Record<string, unknown>, {
      maxStringBytes: thresholds.lineMaxBytes,
    }) as unknown as AuditRecord;

    if (record.approval_outcome === 'token-approved') {
      record = { ...record, server_cannot_verify_human_approval: true };
    }

    if (record.audit_mode === 'metadata-only') {
      // Every other field stays exactly as it is (AC20.10).
      record = { ...record, command: null, normalized_command: null, segments: null };
    }

    record = enforceLineCap(record, thresholds.lineMaxBytes);
    appendLine(`${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    // One warn, no throw: the tool call itself still succeeds (AC20.8).
    logger.warn('could not append to audit.jsonl', {
      path: auditFilePath(),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
