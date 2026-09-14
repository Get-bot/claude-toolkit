/**
 * Filesystem layout for ssh-mcp state (plan row 1.1).
 *
 * Every helper is a function rather than a constant on purpose: the home
 * directory is resolved from the environment on each call so that tests (and
 * `SSH_MCP_HOME` overrides) take effect without reloading the module.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Layering note: `winacl.ts` depends on nothing but node builtins, so this
// import creates no cycle. The ACL is a filesystem concern, which is why it
// belongs here rather than only in the setup flow (F12).
import { hardenWindowsAcl } from '../setup/winacl.js';

/** Mode for the state directory: owner-only (POSIX). */
export const HOME_DIR_MODE = 0o700;
/** Mode for every state file we create: owner read/write (POSIX). */
export const STATE_FILE_MODE = 0o600;
/** Mode for generated public keys. */
export const PUBLIC_KEY_FILE_MODE = 0o644;

const HOME_DIR_NAME = '.ssh-mcp';
const HOSTS_FILE_NAME = 'hosts.json';
const STATE_FILE_NAME = 'state.json';
const AUDIT_FILE_NAME = 'audit.jsonl';
const KEYS_DIR_NAME = 'keys';

/**
 * Directories this process has already restricted, so the repeated
 * {@link ensureHome} calls on the audit path do not spawn `icacls` again.
 */
const hardenedDirs = new Set<string>();

/**
 * Restrict a directory we just created, on Windows only (F12).
 *
 * `fs.chmod` does not map onto NTFS ACLs, so a directory created here inherits
 * whatever the user profile grants - typically `BUILTIN\Administrators` as well
 * as the owner. That matters the moment anything sensitive lands inside: an
 * unencrypted private key, or `audit.jsonl`, which carries command strings.
 *
 * Hardening at creation closes the case where the **server** makes
 * `~/.ssh-mcp` first (for the audit file) and no `setup` run ever follows.
 * `setup` additionally hardens before it writes a key, which covers a directory
 * that already existed from an earlier version.
 *
 * Only newly created directories are touched, so this costs one `icacls` pass
 * per directory per machine rather than one per call. A failure throws: a
 * directory we could not restrict is exactly the state not to proceed from.
 * Callers that must not fail over this (the audit writer) already swallow it.
 */
function restrictNewDirectory(dir: string, created: boolean): void {
  if (!created || hardenedDirs.has(dir)) return;
  hardenWindowsAcl(dir);
  hardenedDirs.add(dir);
}

/**
 * Root of the ssh-mcp state directory.
 * `SSH_MCP_HOME` wins; otherwise `<homedir>/.ssh-mcp`.
 */
export function homePath(): string {
  const override = process.env.SSH_MCP_HOME;
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), HOME_DIR_NAME);
}

/** `<home>/hosts.json` — the host registry (§5.2). */
export function hostsFilePath(): string {
  return path.join(homePath(), HOSTS_FILE_NAME);
}

/** Temporary file used for the atomic write in `store.save()`. */
export function hostsTmpFilePath(): string {
  return `${hostsFilePath()}.tmp`;
}

/** `<home>/state.json` — last observed client + shells (row 1.9). */
export function stateFilePath(): string {
  return path.join(homePath(), STATE_FILE_NAME);
}

/** Temporary file used for the atomic write in `state.saveState()`. */
export function stateTmpFilePath(): string {
  return `${stateFilePath()}.tmp`;
}

/** `<home>/audit.jsonl` — append-only audit log (§5.10). */
export function auditFilePath(): string {
  return path.join(homePath(), AUDIT_FILE_NAME);
}

/**
 * Rotated audit file for `index` 1..3 (§5.10). `index` 0 is the live file.
 */
export function auditRotatedFilePath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid audit rotation index: ${String(index)}`);
  }
  return index === 0 ? auditFilePath() : `${auditFilePath()}.${String(index)}`;
}

/** `<home>/keys` — generated private/public key pairs. */
export function keysDirPath(): string {
  return path.join(homePath(), KEYS_DIR_NAME);
}

/** `<home>/keys/<alias>` — private key for a host alias (AC7.1). */
export function privateKeyPath(alias: string): string {
  return path.join(keysDirPath(), alias);
}

/** `<home>/keys/<alias>.pub` — public key for a host alias (AC7.1). */
export function publicKeyPath(alias: string): string {
  return `${privateKeyPath(alias)}.pub`;
}

/**
 * Create the state directory if needed and make sure it is owner-only.
 * Returns the directory path. Throws if the directory cannot be created.
 *
 * On Windows `chmod` does not map onto NTFS ACLs, so hardening there is the
 * job of `setup/winacl.ts` (AC7.2b); this function only guarantees existence.
 */
export function ensureHome(): string {
  const dir = homePath();
  const created = fs.mkdirSync(dir, { recursive: true, mode: HOME_DIR_MODE }) !== undefined;
  if (process.platform !== 'win32') {
    // mkdir's mode is masked by umask, so set it explicitly (AC7.2a).
    fs.chmodSync(dir, HOME_DIR_MODE);
  } else {
    restrictNewDirectory(dir, created);
  }
  return dir;
}

/** Create `<home>/keys` with the same guarantees as {@link ensureHome}. */
export function ensureKeysDir(): string {
  ensureHome();
  const dir = keysDirPath();
  const created = fs.mkdirSync(dir, { recursive: true, mode: HOME_DIR_MODE }) !== undefined;
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, HOME_DIR_MODE);
  } else {
    restrictNewDirectory(dir, created);
  }
  return dir;
}

/**
 * Apply {@link STATE_FILE_MODE} to a file we just created.
 * No-op on Windows (see {@link ensureHome}).
 */
export function applyStateFileMode(filePath: string): void {
  if (process.platform === 'win32') return;
  fs.chmodSync(filePath, STATE_FILE_MODE);
}
