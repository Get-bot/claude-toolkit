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

export interface DownloadOptions {
  /** Replace an existing local file. Without it, `local_file_exists`. */
  overwrite?: boolean;
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
    throw new SshOperationError(
      ERROR_CODES.sftp_failed,
      `local file not found: ${localPath}`,
      { local_path: localPath, reason: errorMessage(err) }
    );
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
): Promise<TransferResult> {
  const started = Date.now();
  const overwrite = options.overwrite === true;

  if (!overwrite && fs.existsSync(localPath)) {
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
  };
}
