/**
 * Atomic load/save for `hosts.json` (plan rows 1.3 and 1.4).
 *
 * Principle 2: a broken registry must not stop the server from starting. Load
 * failures are returned as data, never thrown, so the server can come up and
 * answer every tool call with `config_invalid` (§5.3).
 */
import fs from 'node:fs';

import { logger } from '../log.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_APPROVAL_FALLBACK,
  HostsFileSchema,
  emptyHostsFile,
} from './schema.js';
import type { ApprovalFallback, HostEntry, HostsFile } from './schema.js';
import {
  STATE_FILE_MODE,
  applyStateFileMode,
  ensureHome,
  hostsFilePath,
  hostsTmpFilePath,
} from './paths.js';

/** One zod issue, flattened for display by `doctor` (AC21.2). */
export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigInvalidReason =
  | 'read_error'
  | 'parse_error'
  | 'unsupported_schema_version'
  | 'validation_error';

export interface ConfigValid {
  ok: true;
  path: string;
  file: HostsFile;
  /** Aliases whose missing `approvalFallback` was normalised (decision D2). */
  normalizedFallbackAliases: string[];
  /** True when `hosts.json` does not exist yet. */
  missing: boolean;
}

export interface ConfigInvalid {
  ok: false;
  /** Always the §5.3 code, so a tool can pass it straight to `toToolError`. */
  code: 'config_invalid';
  reason: ConfigInvalidReason;
  path: string;
  message: string;
  issues: ConfigIssue[];
}

export type ConfigLoadResult = ConfigValid | ConfigInvalid;

function invalid(
  reason: ConfigInvalidReason,
  message: string,
  issues: ConfigIssue[] = [],
): ConfigInvalid {
  return { ok: false, code: 'config_invalid', reason, path: hostsFilePath(), message, issues };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readRawSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof raw === 'number' ? raw : undefined;
}

/**
 * Read and validate the registry.
 *
 * - file absent -> a valid, empty registry (`{schemaVersion: 1, hosts: {}}`)
 * - unreadable / unparseable / invalid -> {@link ConfigInvalid}, never a throw
 * - `schemaVersion` above 1 -> rejected as unsupported
 * - a host entry without `approvalFallback` -> treated as `fail-closed` with
 *   exactly one `warn` per load listing the affected aliases (decision D2)
 */
export function load(): ConfigLoadResult {
  const path = hostsFilePath();

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return {
        ok: true,
        path,
        file: emptyHostsFile(),
        normalizedFallbackAliases: [],
        missing: true,
      };
    }
    return invalid('read_error', `cannot read ${path}: ${errorMessage(err)}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return invalid('parse_error', `${path} is not valid JSON: ${errorMessage(err)}`);
  }

  const rawVersion = readRawSchemaVersion(parsedJson);
  if (rawVersion !== undefined && rawVersion > CONFIG_SCHEMA_VERSION) {
    return invalid(
      'unsupported_schema_version',
      `${path} has schemaVersion ${String(rawVersion)}, but this build only understands ` +
        `${String(CONFIG_SCHEMA_VERSION)}. Upgrade ssh-mcp instead of editing the file.`,
      [{ path: 'schemaVersion', message: `unsupported version ${String(rawVersion)}` }],
    );
  }

  const result = HostsFileSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? '(root)' : issue.path.map((p) => String(p)).join('.'),
      message: issue.message,
    }));
    return invalid('validation_error', `${path} failed schema validation`, issues);
  }

  const normalizedFallbackAliases: string[] = [];
  const hosts: Record<string, HostEntry> = {};
  for (const [alias, entry] of Object.entries(result.data.hosts)) {
    if (entry.approvalFallback === undefined) {
      normalizedFallbackAliases.push(alias);
      hosts[alias] = { ...entry, approvalFallback: DEFAULT_APPROVAL_FALLBACK };
    } else {
      hosts[alias] = entry;
    }
  }

  if (normalizedFallbackAliases.length > 0) {
    // One warning per load, listing every affected alias (decision D2, M6).
    logger.warn(
      'hosts without approvalFallback are treated as fail-closed; add the field explicitly',
      { path, aliases: normalizedFallbackAliases, assumed: DEFAULT_APPROVAL_FALLBACK },
    );
  }

  return {
    ok: true,
    path,
    file: { ...result.data, hosts },
    normalizedFallbackAliases,
    missing: false,
  };
}

/**
 * Effective approval fallback for a host entry.
 *
 * `load()` already normalises the field, but callers that receive a raw entry
 * (for example from `setup` before the first save) should use this so a missing
 * value can never be read as "no restriction" (AC17.11).
 */
export function resolveApprovalFallback(entry: HostEntry): ApprovalFallback {
  return entry.approvalFallback ?? DEFAULT_APPROVAL_FALLBACK;
}

/** Look up one host in a load result. Returns `undefined` when absent. */
export function getHost(result: ConfigLoadResult, alias: string): HostEntry | undefined {
  if (!result.ok) return undefined;
  return result.file.hosts[alias];
}

/**
 * Write the registry atomically (row 1.4).
 *
 * Validates first (a caller must not be able to persist a file that `load()`
 * would then reject), writes `hosts.json.tmp` with mode 0600, then renames over
 * the target. `fs.renameSync` replaces the destination on both POSIX and
 * Windows, so a reader never sees a partial file.
 *
 * Throws on invalid input or on a filesystem failure: unlike `load()`, a failed
 * save must not be swallowed.
 */
export function save(file: HostsFile): void {
  const result = HostsFileSchema.safeParse(file);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map((p) => String(p)).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`refusing to write invalid hosts.json: ${detail}`);
  }

  ensureHome();
  const target = hostsFilePath();
  const tmp = hostsTmpFilePath();
  const body = `${JSON.stringify(result.data, null, 2)}\n`;

  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: STATE_FILE_MODE });
  try {
    // writeFileSync's mode is masked by umask and is ignored when the tmp file
    // already existed, so set it explicitly before it becomes hosts.json.
    applyStateFileMode(tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort: the rename failure is the error worth reporting.
    }
    throw err;
  }
}
