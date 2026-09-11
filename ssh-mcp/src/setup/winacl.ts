/**
 * Windows ACL hardening for `~/.ssh-mcp` (plan row 5.7, AC7.2b, AC7.7).
 *
 * `fs.chmod` is effectively a no-op against NTFS, so on Windows the only real
 * protection for an unencrypted private key is an explicit ACL. This module
 * applies one with `icacls` and then **reads it back** - an apply that reports
 * success but leaves a second principal on the directory is still a failure.
 *
 * A failure here aborts `setup` (AC7.7). Iteration 1 only warned, which was a
 * fail-open: the user would have ended up with a working host entry and a key
 * readable by everyone on the machine.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

/** Principals allowed to appear in the ACL besides the current user. */
export const ALLOWED_FOREIGN_PRINCIPALS: readonly string[] = ['NT AUTHORITY\\SYSTEM'];

export interface IcaclsRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable `icacls` runner so tests can exercise the failure path (AC7.7). */
export type IcaclsRunner = (args: readonly string[]) => IcaclsRun;

export class WindowsAclError extends Error {
  readonly stage: 'grant' | 'verify';
  readonly detail: string;

  constructor(stage: WindowsAclError['stage'], message: string, detail = '') {
    super(message);
    this.name = 'WindowsAclError';
    this.stage = stage;
    this.detail = detail;
  }
}

export interface AclHardenResult {
  /** False on non-Windows platforms, where there is nothing to do. */
  applied: boolean;
  /** Principals found in the ACL after hardening (empty when not applied). */
  principals: string[];
  /** One line suitable for a diagnostic table. */
  detail: string;
}

function defaultRunner(args: readonly string[]): IcaclsRun {
  const result = spawnSync('icacls', [...args], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error !== undefined) {
    throw new WindowsAclError('grant', `could not run icacls: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Account name to grant. `USERDOMAIN\USERNAME` when both are set, otherwise
 * whatever the OS reports - `icacls` resolves either form to the same SID.
 */
export function currentWindowsPrincipal(): string {
  const user = process.env.USERNAME?.trim();
  const domain = process.env.USERDOMAIN?.trim();
  if (user !== undefined && user !== '') {
    return domain !== undefined && domain !== '' ? `${domain}\\${user}` : user;
  }
  return os.userInfo().username;
}

/**
 * Parse the principals out of `icacls <dir>` output.
 *
 * Real output looks like:
 *
 *     C:\Users\me\.ssh-mcp HOST\me:(OI)(CI)(F)
 *                          NT AUTHORITY\SYSTEM:(OI)(CI)(F)
 *
 *     Successfully processed 1 files; Failed processing 0 files
 *
 * The first line carries the path before the first principal, continuation
 * lines carry only a principal, and the summary lines carry no colon-paren
 * pair at all.
 */
export function parseIcaclsPrincipals(raw: string, targetPath: string): string[] {
  const principals: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith(targetPath)) line = line.slice(targetPath.length).trim();
    // A principal entry always ends in `:(...)`; summary lines do not.
    const match = /^(.*?):\((?:[^()]*\)\()*[^()]*\)\s*$/.exec(line);
    if (match === null) continue;
    const principal = (match[1] ?? '').trim();
    if (principal !== '') principals.push(principal);
  }
  return principals;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isAllowed(principal: string, expectedUser: string): boolean {
  if (sameName(principal, expectedUser)) return true;
  // `USERDOMAIN\user` vs a bare `user` (or vice versa) is the same account.
  const tail = (value: string): string => value.split('\\').pop() ?? value;
  if (sameName(tail(principal), tail(expectedUser))) return true;
  return ALLOWED_FOREIGN_PRINCIPALS.some((allowed) => sameName(principal, allowed));
}

/**
 * Read the current ACL of `dir` without changing it. Used by `doctor` item 4.
 * Returns `applied: false` on non-Windows platforms.
 */
export function inspectWindowsAcl(
  dir: string,
  runner: IcaclsRunner = defaultRunner
): AclHardenResult & { foreign: string[] } {
  if (process.platform !== 'win32') {
    return {
      applied: false,
      principals: [],
      foreign: [],
      detail: `not applicable on ${process.platform}`,
    };
  }
  const expectedUser = currentWindowsPrincipal();
  const read = runner([dir]);
  if (read.status !== 0) {
    throw new WindowsAclError(
      'verify',
      `icacls could not read the ACL of ${dir}`,
      `${read.stdout}${read.stderr}`.trim()
    );
  }
  const principals = parseIcaclsPrincipals(read.stdout, dir);
  const foreign = principals.filter((principal) => !isAllowed(principal, expectedUser));
  return {
    applied: true,
    principals,
    foreign,
    detail:
      foreign.length === 0
        ? `owner-only (${principals.join(', ')})`
        : `unexpected principals: ${foreign.join(', ')}`,
  };
}

/**
 * Harden `dir` so only the current user (and SYSTEM) can reach it, then verify.
 *
 * No-op returning `applied: false` on POSIX, where `paths.ts` already applied
 * mode 0700. Throws {@link WindowsAclError} when either step fails; `setup`
 * catches that, deletes the key pair and writes nothing (AC7.7).
 */
export function hardenWindowsAcl(
  dir: string,
  runner: IcaclsRunner = defaultRunner
): AclHardenResult {
  if (process.platform !== 'win32') {
    return { applied: false, principals: [], detail: `not needed on ${process.platform}` };
  }

  const expectedUser = currentWindowsPrincipal();
  const grant = runner([dir, '/inheritance:r', '/grant:r', `${expectedUser}:(OI)(CI)F`]);
  if (grant.status !== 0) {
    throw new WindowsAclError(
      'grant',
      `icacls failed to restrict ${dir} to ${expectedUser}`,
      `${grant.stdout}${grant.stderr}`.trim()
    );
  }

  let verified = inspectWindowsAcl(dir, runner);
  const removed: string[] = [];
  if (verified.foreign.length > 0) {
    // `/inheritance:r` drops inherited ACEs, but an explicit one survives it -
    // a directory created under the user profile usually carries an explicit
    // `BUILTIN\Administrators` entry. AC7.2b allows only the owner and SYSTEM,
    // so each remaining principal is removed by name and the ACL is re-read.
    for (const principal of verified.foreign) {
      const removal = runner([dir, '/remove:g', principal]);
      if (removal.status === 0) removed.push(principal);
    }
    verified = inspectWindowsAcl(dir, runner);
  }

  if (verified.foreign.length > 0) {
    throw new WindowsAclError(
      'verify',
      `${dir} is still reachable by ${verified.foreign.join(', ')} after hardening`,
      verified.principals.join(', ')
    );
  }
  if (verified.principals.length === 0) {
    throw new WindowsAclError(
      'verify',
      `icacls reported no ACL entries for ${dir}; cannot confirm it is owner-only`
    );
  }

  return {
    applied: true,
    principals: verified.principals,
    detail:
      removed.length === 0
        ? `restricted to ${verified.principals.join(', ')}`
        : `restricted to ${verified.principals.join(', ')} (removed ${removed.join(', ')})`,
  };
}
