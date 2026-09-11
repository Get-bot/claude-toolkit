/**
 * stderr-only structured logger plus the shared redaction pass
 * (plan rows 1.5 and 1.6).
 *
 * Principle 3: in server mode stdout carries JSON-RPC frames and nothing else
 * (AC2.3). Nothing in this module ever writes to stdout.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Keys whose values are replaced wholesale before anything is written. */
export const SENSITIVE_KEY_PATTERN = /pass(word)?|secret|token|private_?key|passphrase/i;

/** Placeholder substituted for a sensitive value. */
export const REDACTED = '[redacted]';
/** Placeholder substituted for a PEM private key block. */
export const REDACTED_PEM = '[redacted-private-key]';
/** Suffix appended to a string that had to be shortened. */
export const TRUNCATION_SUFFIX = '[truncated]';

/** Per-field ceiling for log records and tool responses: 2 KiB (row 1.6). */
export const MAX_LOG_FIELD_BYTES = 2048;

/** Guard against pathological nesting while redacting. */
const MAX_REDACT_DEPTH = 8;

const RESERVED_RECORD_KEYS = new Set(['ts', 'level', 'msg']);

let levelOverride: LogLevel | null = null;

function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_ORDER, value);
}

/**
 * Force a level regardless of `SSH_MCP_LOG_LEVEL`. Pass `null` to go back to
 * reading the environment. Intended for tests and for `doctor`.
 */
export function setLogLevel(level: LogLevel | null): void {
  levelOverride = level;
}

/** Effective level: explicit override, then `SSH_MCP_LOG_LEVEL`, then `info`. */
export function currentLogLevel(): LogLevel {
  if (levelOverride !== null) return levelOverride;
  const raw = process.env.SSH_MCP_LOG_LEVEL?.trim().toLowerCase();
  if (raw !== undefined && raw !== '' && isLogLevel(raw)) return raw;
  return DEFAULT_LOG_LEVEL;
}

/** True when a record at `level` would be written. */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLogLevel()];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Cut `value` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // 0b10xxxxxx marks a UTF-8 continuation byte: walk back to a lead byte.
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Shorten `value` so that the result (suffix included) fits `maxBytes`.
 * Returns `value` untouched when it already fits.
 */
export function truncateField(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  if (maxBytes <= suffixBytes) return truncateUtf8(TRUNCATION_SUFFIX, maxBytes);
  return truncateUtf8(value, maxBytes - suffixBytes) + TRUNCATION_SUFFIX;
}

// A complete PEM private key block, and (second pattern) a block whose END
// marker never arrived because the surrounding text was already cut short.
const PEM_BLOCK_PATTERN =
  /-----BEGIN [^\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\n-]*PRIVATE KEY-----/g;
const PEM_OPEN_PATTERN = /-----BEGIN [^\n-]*PRIVATE KEY-----[\s\S]*/g;

/** Replace any PEM private key material in `value` (AC19.2). */
export function maskPemBlocks(value: string): string {
  if (!value.includes('-----BEGIN ')) return value;
  return value.replace(PEM_BLOCK_PATTERN, REDACTED_PEM).replace(PEM_OPEN_PATTERN, REDACTED_PEM);
}

export interface RedactOptions {
  /**
   * Per-string ceiling in UTF-8 bytes. `null` disables truncation, which the
   * audit writer uses because it enforces its own 16 KiB line budget with a
   * documented field order (§5.10).
   */
  maxStringBytes?: number | null;
}

function redactString(value: string, maxStringBytes: number | null): string {
  const masked = maskPemBlocks(value);
  return maxStringBytes === null ? masked : truncateField(masked, maxStringBytes);
}

function redactValue(
  value: unknown,
  maxStringBytes: number | null,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value, maxStringBytes);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
    default:
      break;
  }

  if (depth >= MAX_REDACT_DEPTH) return '[depth-exceeded]';

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  try {
    if (Buffer.isBuffer(obj)) {
      return `[binary ${String(obj.length)} bytes]`;
    }
    if (obj instanceof Uint8Array) {
      return `[binary ${String(obj.byteLength)} bytes]`;
    }
    if (obj instanceof Error) {
      const out: Record<string, unknown> = {
        name: obj.name,
        message: redactString(obj.message, maxStringBytes),
      };
      if (typeof obj.stack === 'string') {
        out.stack = redactString(obj.stack, maxStringBytes);
      }
      return out;
    }
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => redactValue(item, maxStringBytes, depth + 1, seen));
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of obj.entries()) {
        const name = String(key);
        out[name] = SENSITIVE_KEY_PATTERN.test(name)
          ? REDACTED
          : redactValue(val, maxStringBytes, depth + 1, seen);
      }
      return out;
    }
    if (obj instanceof Set) {
      return Array.from(obj.values()).map((item) =>
        redactValue(item, maxStringBytes, depth + 1, seen),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(val, maxStringBytes, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Mask secrets in `value` (row 1.6, AC19).
 *
 * - values under a key matching {@link SENSITIVE_KEY_PATTERN} become `[redacted]`
 * - PEM private key blocks inside any string are replaced
 * - every string is cut to `maxStringBytes` (2 KiB by default)
 *
 * Applied to every log record and to every tool response body.
 */
export function redact(value: unknown, options?: RedactOptions): unknown {
  const maxStringBytes =
    options?.maxStringBytes === undefined ? MAX_LOG_FIELD_BYTES : options.maxStringBytes;
  return redactValue(value, maxStringBytes, 0, new WeakSet<object>());
}

/**
 * {@link redact} for a plain record, preserving the static type.
 * Redaction never changes the shape of an object, only its string leaves.
 */
export function redactRecord<T extends Record<string, unknown>>(
  record: T,
  options?: RedactOptions,
): T {
  return redact(record, options) as T;
}

export type LogFields = Record<string, unknown>;

/** Write one structured JSON line to stderr. Never throws. */
export function log(level: LogLevel, message: string, fields?: LogFields): void {
  if (!isLevelEnabled(level)) return;
  try {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: truncateField(maskPemBlocks(message), MAX_LOG_FIELD_BYTES),
    };
    if (fields !== undefined) {
      const safeFields = redactRecord(fields);
      for (const [key, value] of Object.entries(safeFields)) {
        if (RESERVED_RECORD_KEYS.has(key)) continue;
        record[key] = value;
      }
    }
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never break a tool call.
  }
}

export const logger = {
  error: (message: string, fields?: LogFields): void => log('error', message, fields),
  warn: (message: string, fields?: LogFields): void => log('warn', message, fields),
  info: (message: string, fields?: LogFields): void => log('info', message, fields),
  debug: (message: string, fields?: LogFields): void => log('debug', message, fields),
};

type ConsoleWriter = (...args: unknown[]) => void;

let originalConsole: {
  log: ConsoleWriter;
  info: ConsoleWriter;
  debug: ConsoleWriter;
  dir: (item?: unknown, options?: unknown) => void;
} | null = null;

/**
 * Redirect every stdout-bound console method to stderr (row 1.5, AC2.3).
 *
 * `console.log`, `console.info`, `console.debug` and `console.dir` all write to
 * stdout, so any one of them would corrupt the JSON-RPC stream. Idempotent;
 * call it before the stdio transport is connected.
 */
export function installStdoutGuard(): void {
  if (originalConsole !== null) return;
  originalConsole = {
    log: console.log.bind(console) as ConsoleWriter,
    info: console.info.bind(console) as ConsoleWriter,
    debug: console.debug.bind(console) as ConsoleWriter,
    dir: console.dir.bind(console) as (item?: unknown, options?: unknown) => void,
  };
  const toStderr = console.error.bind(console) as ConsoleWriter;
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr;
}

/** Undo {@link installStdoutGuard}. For tests. */
export function uninstallStdoutGuard(): void {
  if (originalConsole === null) return;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  console.dir = originalConsole.dir;
  originalConsole = null;
}

/** True while the stdout guard is installed. */
export function isStdoutGuardInstalled(): boolean {
  return originalConsole !== null;
}
