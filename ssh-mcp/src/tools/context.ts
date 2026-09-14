/**
 * What a tool handler is given and the lookups every tool shares
 * (plan rows 4.3-4.9).
 *
 * The registry is read from disk on every call rather than cached. A tool call
 * already writes an audit line, so one small `readFileSync` is not the cost
 * that matters, and it means `hosts.json` edits take effect without a restart —
 * including an edit that tightens `approvalMode`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'ssh2';

import { homePath } from '../config/paths.js';
import type { ApprovalFallback, HostEntry } from '../config/schema.js';
import { getHost, load, resolveApprovalFallback } from '../config/store.js';
import type { ConfigLoadResult, ConfigValid } from '../config/store.js';
import { loadState } from '../config/state.js';
import { CodedError, ERROR_CODES } from '../errors.js';
import type { ElicitOutcome, ElicitRequest } from '../safety/approval.js';
import { getConnection } from '../ssh/pool.js';
import type { PoolHost } from '../ssh/pool.js';
import type { ClassificationCoverage } from '../ssh/shellDetect.js';

/** Connected MCP client, as reported at `initialize` (M6). */
export interface ClientInfo {
  name: string;
  version: string;
  /**
   * The client declared `elicitation` and it is not url-only (plan F6). A bare
   * `elicitation: {}` counts as form support, which is how the SDK reads it.
   */
  supportsElicitation: boolean;
}

export interface ToolContext {
  /** `null` until `initialize` has completed. */
  client(): ClientInfo | null;
  /** Ask the human through the client. Only called when elicitation is supported. */
  elicit(request: ElicitRequest): Promise<ElicitOutcome>;
  /** Approval wait budget override; `undefined` means the 300 s default. */
  approvalTimeoutMs(): number | undefined;
  /** Registry snapshot for this call. */
  loadConfig(): ConfigLoadResult;
}

/** Build a context backed by `store.load()` and a live MCP client. */
export interface ContextSources {
  client: () => ClientInfo | null;
  elicit: (request: ElicitRequest) => Promise<ElicitOutcome>;
  approvalTimeoutMs?: number;
}

export function createToolContext(sources: ContextSources): ToolContext {
  return {
    client: sources.client,
    elicit: sources.elicit,
    approvalTimeoutMs: () => sources.approvalTimeoutMs,
    loadConfig: () => load(),
  };
}

/**
 * The registry, or a `config_invalid` throw carrying the zod issues.
 *
 * Every tool goes through this, so a broken `hosts.json` gives the same answer
 * everywhere instead of a different failure per tool (§5.3).
 */
export function requireConfig(result: ConfigLoadResult): ConfigValid {
  if (result.ok) return result;
  throw new CodedError(ERROR_CODES.config_invalid, result.message, {
    path: result.path,
    reason: result.reason,
    issues: result.issues,
  });
}

/** Look up one alias, or throw `host_not_found` listing the known aliases. */
export function requireHost(result: ConfigLoadResult, alias: string): PoolHost {
  const config = requireConfig(result);
  const entry: HostEntry | undefined = getHost(config, alias);
  if (entry === undefined) {
    throw new CodedError(
      ERROR_CODES.host_not_found,
      `등록되지 않은 호스트입니다: ${alias}. list_hosts로 등록된 alias를 확인하십시오.`,
      { host: alias, known_hosts: Object.keys(config.file.hosts) }
    );
  }
  return { ...entry, alias };
}

/** Effective fallback for a host, with the missing-field rule applied (D2). */
export function fallbackOf(entry: HostEntry): ApprovalFallback {
  return resolveApprovalFallback(entry);
}

/**
 * A pooled connection for `host`.
 *
 * The private key path is not echoed back: it is local configuration the model
 * has no use for, and `list_hosts` deliberately withholds it too.
 */
export async function connectHost(host: PoolHost): Promise<Client> {
  let privateKey: Buffer;
  try {
    privateKey = fs.readFileSync(host.privateKeyPath);
  } catch (err) {
    throw new CodedError(
      ERROR_CODES.auth_failed,
      '이 호스트의 개인키를 읽을 수 없습니다. ssh-mcp doctor로 키 파일 상태를 확인하십시오.',
      { host: host.alias, reason: err instanceof Error ? err.message : String(err) }
    );
  }
  return getConnection(host, privateKey);
}

/**
 * Absolute, symlink-resolved form of a local transfer path.
 *
 * `path.resolve` alone is not enough: it collapses `..` lexically, so
 * `/tmp/link/../hosts.json` can still land somewhere else once `link` is
 * followed. The directory is resolved with `realpathSync` and the basename is
 * re-joined, which also keeps the answer correct for a file that does not
 * exist yet (a `download` target). When the parent does not exist either, the
 * nearest existing ancestor is resolved and the rest appended.
 */
export function realResolve(target: string): string {
  const absolute = path.resolve(target);
  const parts: string[] = [];
  let current = path.dirname(absolute);
  parts.push(path.basename(absolute));

  for (;;) {
    try {
      return path.resolve(fs.realpathSync(current), ...parts.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      parts.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `candidate` is `root` or sits under it. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Check a model-supplied local path before any transfer (finding F1).
 *
 * `~/.ssh-mcp` holds the registry, the private keys, the observed state and the
 * audit log. A `download` that overwrote `hosts.json` could set every host to
 * `approvalMode: auto` and disarm every later prompt, and an `upload` could
 * carry a private key off the machine. That is not a decision to put to a
 * person at an approval prompt — it is the mechanism those prompts depend on,
 * so it is refused outright. Everything outside that subtree stays the user's
 * business and goes to the approval gate instead.
 */
export function requireLocalPathAllowed(localPath: string, operation: string): string {
  const resolved = realResolve(localPath);
  const home = realResolve(homePath());
  if (isInside(home, resolved)) {
    throw new CodedError(
      ERROR_CODES.local_path_forbidden,
      `ssh-mcp의 설정 디렉터리 안의 경로는 ${operation}할 수 없습니다. ` +
        '레지스트리·개인키·상태·감사 로그는 도구로 읽거나 덮어쓸 수 없습니다.',
      { operation, local_path: localPath }
    );
  }
  return resolved;
}

/**
 * Classifier coverage for a host, based on the shell last observed by
 * `open_session` (R23).
 *
 * The built-in patterns assume POSIX syntax, so a host whose login shell turned
 * out to be `cmd` or PowerShell grades Windows-native destructive commands as
 * `safe`. `exec` has no shell probe of its own, so the last observation is the
 * only honest signal available; when there is none the field is omitted rather
 * than guessed.
 */
export function observedCoverage(alias: string): ClassificationCoverage | null {
  const observed = loadState().observedShells[alias]?.shell;
  if (observed === 'cmd' || observed === 'powershell') return 'reduced';
  return null;
}
