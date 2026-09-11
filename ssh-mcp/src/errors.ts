/**
 * Error codes and the tool-response envelope (plan row 1.7, §5.3).
 *
 * The names below are the §5.3 table verbatim; they are the strings asserted by
 * the acceptance criteria, so nothing else may be invented for the same
 * condition. The only addition is `internal_error`, which the Phase 4 audit
 * wrapper needs for an unexpected exception.
 */
import { redact } from './log.js';

export const ERROR_CODES = {
  /** `hosts.json` failed to parse or validate; every tool returns this. */
  config_invalid: 'config_invalid',
  /** Alias is not in the registry. */
  host_not_found: 'host_not_found',
  /** Pinned host key fingerprint did not match (AC9.1). */
  host_key_mismatch: 'host_key_mismatch',
  /**
   * TCP connect or SSH handshake failed before authentication (unreachable
   * host, refused port, protocol error). Not in the §5.3 table — added during
   * team-exec because the SSH layer needs to distinguish "cannot reach" from
   * "rejected credentials" and from an internal bug.
   */
  connection_failed: 'connection_failed',
  /** Public key authentication failed. */
  auth_failed: 'auth_failed',
  /** `deny` mode, or the user declined at the elicitation prompt (AC16). */
  command_denied: 'command_denied',
  /** `approvalFallback: "fail-closed"` and the client cannot elicit (AC17.7). */
  approval_unavailable: 'approval_unavailable',
  /** Two-step approval started. Not an error: returned with `isError: false`. */
  confirmation_required: 'confirmation_required',
  confirmation_token_invalid: 'confirmation_token_invalid',
  confirmation_token_used: 'confirmation_token_used',
  confirmation_token_expired: 'confirmation_token_expired',
  confirmation_token_mismatch: 'confirmation_token_mismatch',
  /** Command would need a terminal (OPT-1). */
  interactive_program_refused: 'interactive_program_refused',
  command_timeout: 'command_timeout',
  /** Command string exceeds the 8192-character classifier limit. */
  command_too_long: 'command_too_long',
  session_not_found: 'session_not_found',
  session_expired: 'session_expired',
  session_terminated: 'session_terminated',
  session_limit_exceeded: 'session_limit_exceeded',
  /** POSIX-family shell detected but the marker handshake failed. */
  shell_incompatible: 'shell_incompatible',
  /** Shell detected as fish, cmd or powershell (AC14.5, AC14.6). */
  unsupported_shell: 'unsupported_shell',
  /** `download` target exists and `overwrite` was not set (AC13.2). */
  local_file_exists: 'local_file_exists',
  sftp_failed: 'sftp_failed',
  /** `sudo` asked for a password; stdin is always closed so it cannot answer. */
  sudo_password_required: 'sudo_password_required',
  /** `setup` ran against an existing alias without `--force` (C17). */
  alias_exists: 'alias_exists',
  /** Not in §5.3: unexpected exception inside the audit wrapper. */
  internal_error: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.values(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODE_LIST as readonly string[]).includes(value);
}

/**
 * Error that carries a tool error code across module boundaries.
 *
 * Lower layers (ssh, safety, setup) throw this; the Phase 4 tool wrapper turns
 * it into {@link toToolError} with `code`/`details` intact. Anything thrown
 * that is not a `CodedError` becomes `internal_error`.
 */
export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodedError';
    this.code = code;
    this.details = details;
  }

  toToolError(options?: ToolPayloadOptions): ToolTextResult {
    return toToolError(this.code, this.message, this.details, options);
  }
}

export function isCodedError(value: unknown): value is CodedError {
  return value instanceof CodedError;
}

/** Shape the MCP SDK expects back from a tool handler. */
export interface ToolTextResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** Extra fields merged into the JSON body. Redacted before serialisation. */
export type ErrorDetails = Record<string, unknown>;

export interface ToolPayloadOptions {
  /**
   * Top-level detail keys exempt from key-name masking.
   *
   * Needed because `redact()` masks anything matching `/token/i`, which would
   * strip the value out of a `confirmation_required` response — and without
   * that value two-step approval cannot work (AC17.2). The intended use is
   * `preserveKeys: ['confirmation_token']` from the approval module, and
   * nothing else: a preserved value is still PEM-masked and length-capped, but
   * it is not replaced.
   */
  preserveKeys?: readonly string[];
}

function buildPayload(
  code: ErrorCode,
  message: string,
  details: ErrorDetails | undefined,
  options: ToolPayloadOptions | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = { error: code, message };
  if (details === undefined) return payload;

  const preserved = new Set(options?.preserveKeys ?? []);
  const maskable: ErrorDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (!preserved.has(key)) maskable[key] = value;
  }

  const safe = redact(maskable);
  if (safe !== null && typeof safe === 'object' && !Array.isArray(safe)) {
    for (const [key, value] of Object.entries(safe as Record<string, unknown>)) {
      // `error` and `message` stay authoritative.
      if (key === 'error' || key === 'message') continue;
      payload[key] = value;
    }
  }

  for (const key of preserved) {
    if (key === 'error' || key === 'message') continue;
    if (Object.prototype.hasOwnProperty.call(details, key)) {
      payload[key] = redact(details[key], { maxStringBytes: PRESERVED_VALUE_MAX_BYTES });
    }
  }

  return payload;
}

/**
 * Length cap for values listed in `preserveKeys`.
 *
 * The default 2 KiB field cap would cut the command echoed back in a
 * `confirmation_required` notice, and the person approving must see the whole
 * command (OPT-0 M7). Commands are already limited to 8192 characters by
 * `command_too_long`, so 32 KiB covers the worst-case UTF-8 expansion.
 * Key-name masking and PEM masking still apply to preserved values.
 */
export const PRESERVED_VALUE_MAX_BYTES = 32 * 1024;

/**
 * Build an error tool result (row 1.7).
 *
 * Body shape follows §5.9: `{ "error": <code>, "message": ..., ...details }`.
 * `details` goes through {@link redact} so no secret can reach a response
 * (AC19).
 */
export function toToolError(
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
  options?: ToolPayloadOptions
): ToolTextResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(buildPayload(code, message, details, options)) },
    ],
    isError: true,
  };
}

/**
 * Same serialisation and redaction as {@link toToolError} but with
 * `isError: false`. `confirmation_required` uses this: §5.3 marks it as a
 * control-flow outcome, not a failure (AC17.2).
 */
export function toToolNotice(
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
  options?: ToolPayloadOptions
): ToolTextResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(buildPayload(code, message, details, options)) },
    ],
    isError: false,
  };
}

/**
 * Successful tool result: an arbitrary JSON body, redacted, `isError: false`.
 * `options.preserveKeys` behaves as in {@link toToolError}.
 */
export function toToolResult(
  body: Record<string, unknown>,
  options?: ToolPayloadOptions
): ToolTextResult {
  const preserved = new Set(options?.preserveKeys ?? []);
  if (preserved.size === 0) {
    return { content: [{ type: 'text', text: JSON.stringify(redact(body)) }], isError: false };
  }

  const maskable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!preserved.has(key)) maskable[key] = value;
  }
  const payload: Record<string, unknown> = { ...(redact(maskable) as Record<string, unknown>) };
  for (const key of preserved) {
    if (Object.prototype.hasOwnProperty.call(body, key)) payload[key] = redact(body[key]);
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}
