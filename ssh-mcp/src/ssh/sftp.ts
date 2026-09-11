/**
 * File transfer (plan row 3.4, AC13).
 *
 * `fastPut`/`fastGet` do parallel chunked reads, which is what makes a 1 MiB
 * transfer quick, and they compare byte for byte because neither side rewrites
 * line endings.
 *
 * Two deliberate refusals:
 *
 * - `download` will not overwrite an existing local file unless asked to
 *   (AC13.2). A silent overwrite is unrecoverable, and the caller always knows
 *   whether it meant to replace the file.
 * - Neither direction creates parent directories. A typo in a path would
 *   otherwise scatter files into freshly created trees on a remote host.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Client, SFTPWrapper } from 'ssh2';

import { ERROR_CODES } from '../errors.js';
import { SshOperationError, errorMessage } from './error.js';

export interface TransferResult {
  /** Size of the transferred file in bytes. */
  bytes: number;
  local_path: string;
  remote_path: string;
  duration_ms: number;
}

export interface DownloadResult extends TransferResult {
  /**
   * Whether a local file was actually replaced.
   *
   * Measured, not echoed back from the `overwrite` flag: a caller that passes
   * `overwrite: true` for a path that did not exist has overwritten nothing,
   * and the audit record should say so (CR-4).
   */
  overwritten: boolean;
}

export interface DownloadOptions {
  /** Replace an existing local file. Without it, `local_file_exists`. */
  overwrite?: boolean;
  /**
   * Reject a remote file larger than this. Defaults to
   * {@link MAX_DOWNLOAD_BYTES}; callers pass the host's own ceiling when it is
   * lower.
   */
  maxBytes?: number;
}

/**
 * Hard ceiling on a single download, 256 MiB.
 *
 * A transfer is streamed to disk, so an unbounded one fills the local disk
 * before anything notices. The remote size is known before any byte is written
 * (SFTP `stat`), which makes refusing cheap and exact.
 */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/**
 * Reject a local path that is a symbolic link (F16).
 *
 * `statSync` and `existsSync` follow links, so a link planted at `local_path`
 * would make the overwrite guard look at the target while `fastGet` wrote
 * through the link to somewhere else entirely. `lstat` is the only call that
 * sees the link itself. A missing path is fine; anything that exists and is a
 * link is refused outright rather than resolved, because ssh-mcp has no reason
 * to write through one.
 */
function assertNotSymlink(localPath: string, remotePath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(localPath);
  } catch {
    return; // Nothing there: the caller's own existence checks apply.
  }
  if (stats.isSymbolicLink()) {
    throw new SshOperationError(
      ERROR_CODES.sftp_failed,
      `local path is a symbolic link, refusing to write through it: ${localPath}`,
      { local_path: localPath, remote_path: remotePath }
    );
  }
}

/** Size of a remote file, or `null` when the server will not say. */
function remoteSize(sftp: SFTPWrapper, remotePath: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err !== null && err !== undefined) {
        resolve(null);
        return;
      }
      resolve(typeof stats.size === 'number' ? stats.size : null);
    });
  });
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        reject(
          new SshOperationError(ERROR_CODES.sftp_failed, `could not start SFTP: ${err.message}`)
        );
        return;
      }
      resolve(sftp);
    });
  });
}

function endSftp(sftp: SFTPWrapper): void {
  try {
    sftp.end();
  } catch {
    // The channel is closing anyway.
  }
}

function statLocalFile(localPath: string): fs.Stats {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(localPath);
  } catch (err) {
    throw new SshOperationError(ERROR_CODES.sftp_failed, `local file not found: ${localPath}`, {
      local_path: localPath,
      reason: errorMessage(err),
    });
  }
  if (!stats.isFile()) {
    throw new SshOperationError(
      ERROR_CODES.sftp_failed,
      `local path is not a regular file: ${localPath}`,
      { local_path: localPath }
    );
  }
  return stats;
}

/** Copy a local file to the remote host. */
export async function upload(
  conn: Client,
  localPath: string,
  remotePath: string
): Promise<TransferResult> {
  const started = Date.now();
  const stats = statLocalFile(localPath);
  const sftp = await openSftp(conn);

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err !== null && err !== undefined) {
          reject(
            new SshOperationError(
              ERROR_CODES.sftp_failed,
              `upload to ${remotePath} failed: ${err.message}`,
              { local_path: localPath, remote_path: remotePath }
            )
          );
          return;
        }
        resolve();
      });
    });
  } finally {
    endSftp(sftp);
  }

  return {
    bytes: stats.size,
    local_path: localPath,
    remote_path: remotePath,
    duration_ms: Date.now() - started,
  };
}

/** Copy a remote file to the local filesystem. */
export async function download(
  conn: Client,
  remotePath: string,
  localPath: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const started = Date.now();
  const overwrite = options.overwrite === true;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;

  // Checked before the existence test: a link is refused whether or not
  // `overwrite` was passed, since following one writes somewhere unintended.
  assertNotSymlink(localPath, remotePath);

  const replaced = fs.existsSync(localPath);
  if (!overwrite && replaced) {
    throw new SshOperationError(
      ERROR_CODES.local_file_exists,
      `local file already exists: ${localPath} (pass overwrite: true to replace it)`,
      { local_path: localPath, remote_path: remotePath }
    );
  }

  const parent = path.dirname(path.resolve(localPath));
  if (!fs.existsSync(parent)) {
    throw new SshOperationError(
      ERROR_CODES.sftp_failed,
      `local directory does not exist: ${parent} (ssh-mcp does not create parent directories)`,
      { local_path: localPath, remote_path: remotePath }
    );
  }

  const sftp = await openSftp(conn);
  try {
    const size = await remoteSize(sftp, remotePath);
    if (size !== null && size > maxBytes) {
      throw new SshOperationError(
        ERROR_CODES.sftp_failed,
        `remote file is ${String(size)} bytes, over the ${String(maxBytes)} byte download limit`,
        { local_path: localPath, remote_path: remotePath, remote_bytes: size, max_bytes: maxBytes }
      );
    }

    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err !== null && err !== undefined) {
          reject(
            new SshOperationError(
              ERROR_CODES.sftp_failed,
              `download of ${remotePath} failed: ${err.message}`,
              { local_path: localPath, remote_path: remotePath }
            )
          );
          return;
        }
        resolve();
      });
    });
  } finally {
    endSftp(sftp);
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(localPath).size;
  } catch {
    // The transfer reported success; a stat failure here is not worth failing.
  }

  return {
    bytes,
    local_path: localPath,
    remote_path: remotePath,
    duration_ms: Date.now() - started,
    overwritten: replaced,
  };
}
