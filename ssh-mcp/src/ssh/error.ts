/**
 * Error carrier for the SSH layer.
 *
 * Everything below `src/ssh/` throws a {@link CodedError}, so the Phase 4 tool
 * wrapper can turn a failure into the right §5.3 code and audit record without
 * string-matching on messages from ssh2. `SshOperationError` exists only to
 * make `instanceof` checks inside this layer readable; the wrapper relies on
 * `CodedError` alone.
 */
import { CodedError, type ErrorCode, type ErrorDetails } from '../errors.js';

export class SshOperationError extends CodedError {
  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(code, message, details);
    this.name = 'SshOperationError';
  }
}

/** Message text from an unknown throwable, without leaking an object dump. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return String(value);
}
