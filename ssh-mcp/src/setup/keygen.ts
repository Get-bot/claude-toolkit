/**
 * ed25519 key generation for `ssh-mcp setup` (plan row 5.3, OPT-7 A).
 *
 * `ssh2`'s generator is used rather than `node:crypto` because it returns the
 * OpenSSH string forms directly: the private key is already an
 * `-----BEGIN OPENSSH PRIVATE KEY-----` block (AC7.1) and the public key is a
 * line that can be appended to `authorized_keys` verbatim (§5.7).
 *
 * Keys are generated **without a passphrase** by design: the server has to
 * connect unattended, and the protection boundary is the file mode on POSIX and
 * the ACL on Windows (`setup/winacl.ts`).
 */
import fs from 'node:fs';

import { utils } from 'ssh2';

import { parseAuthorizedKeyLine, sha256Fingerprint } from '../ssh/fingerprint.js';
import {
  PUBLIC_KEY_FILE_MODE,
  STATE_FILE_MODE,
  ensureKeysDir,
  privateKeyPath,
  publicKeyPath,
} from '../config/paths.js';

/** Comment embedded in every generated key, so it is identifiable remotely. */
export const KEY_COMMENT_PREFIX = 'ssh-mcp:';

/** First line of an OpenSSH-format private key (AC7.1). */
export const OPENSSH_PRIVATE_KEY_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';


export interface GeneratedKeyPair {
  alias: string;
  /** Absolute path of the private key, written with mode 0600. */
  privateKeyPath: string;
  /** Absolute path of the public key, written with mode 0644. */
  publicKeyPath: string;
  /** Single `authorized_keys` line, no trailing newline (§5.7). */
  publicKeyLine: string;
  /** Fingerprint of the generated public key. Not the host key fingerprint. */
  fingerprint: string;
  /** Key type as reported by ssh2 (`ed25519`). */
  algo: string;
}

function applyMode(filePath: string, mode: number): void {
  // On Windows chmod does not map onto NTFS ACLs; winacl.ts owns that (AC7.2b).
  if (process.platform === 'win32') return;
  fs.chmodSync(filePath, mode);
}

/**
 * Compute the `authorized_keys` line and fingerprint for a public key string.
 * Exported so a test can check the fingerprint of a key it did not generate.
 */
export function describePublicKey(publicKey: string): {
  publicKeyLine: string;
  fingerprint: string;
  algo: string;
} {
  const publicKeyLine = publicKey.trim();
  const parsed = parseAuthorizedKeyLine(publicKeyLine);
  if (parsed === null) {
    throw new Error('generated public key is not a valid OpenSSH public key line');
  }
  return { publicKeyLine, fingerprint: parsed.fingerprint, algo: parsed.algo };
}

/**
 * Generate a key pair for `alias` and write both halves under `keysDirPath()`.
 *
 * An existing pair is overwritten: the caller (`setup --force`) is responsible
 * for having taken a {@link backupKeyPair} first so an aborted run can restore
 * the previous key (row 5.1b).
 */
export function generateKeyPair(alias: string): GeneratedKeyPair {
  const pair = utils.generateKeyPairSync('ed25519', { comment: `${KEY_COMMENT_PREFIX}${alias}` });
  if (!pair.private.startsWith(OPENSSH_PRIVATE_KEY_HEADER)) {
    throw new Error('ssh2 returned a private key that is not in OpenSSH format');
  }

  const described = describePublicKey(pair.public);
  ensureKeysDir();

  const privatePath = privateKeyPath(alias);
  const publicPath = publicKeyPath(alias);

  // Remove first: writeFileSync keeps the mode of an existing file, and a
  // world-readable leftover from an earlier run must not survive.
  fs.rmSync(privatePath, { force: true });
  fs.rmSync(publicPath, { force: true });

  fs.writeFileSync(privatePath, pair.private, { encoding: 'utf8', mode: STATE_FILE_MODE });
  applyMode(privatePath, STATE_FILE_MODE);

  fs.writeFileSync(publicPath, `${described.publicKeyLine}\n`, {
    encoding: 'utf8',
    mode: PUBLIC_KEY_FILE_MODE,
  });
  applyMode(publicPath, PUBLIC_KEY_FILE_MODE);

  return {
    alias,
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
    publicKeyLine: described.publicKeyLine,
    fingerprint: described.fingerprint,
    algo: described.algo,
  };
}

export interface KeyPairBackup {
  alias: string;
  privateKey: Buffer | null;
  publicKey: Buffer | null;
}

/**
 * Read the current key pair for `alias` into memory so an aborted `--force` run
 * can put it back. Missing files are recorded as `null`.
 */
export function backupKeyPair(alias: string): KeyPairBackup {
  const read = (filePath: string): Buffer | null => {
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  };
  return {
    alias,
    privateKey: read(privateKeyPath(alias)),
    publicKey: read(publicKeyPath(alias)),
  };
}

/** Delete both halves of the key pair for `alias`. Never throws (AC7.7). */
export function removeKeyPair(alias: string): void {
  for (const filePath of [privateKeyPath(alias), publicKeyPath(alias)]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort: the abort reason is the error worth reporting.
    }
  }
}

/**
 * Restore a {@link backupKeyPair} snapshot, deleting files that did not exist
 * when the snapshot was taken. Used on every abort path after keygen so an
 * interrupted run leaves the registry and the key directory as they were.
 */
export function restoreKeyPair(backup: KeyPairBackup): void {
  const restore = (filePath: string, content: Buffer | null, mode: number): void => {
    try {
      if (content === null) {
        fs.rmSync(filePath, { force: true });
        return;
      }
      fs.writeFileSync(filePath, content, { mode });
      applyMode(filePath, mode);
    } catch {
      // Best effort.
    }
  };
  restore(privateKeyPath(backup.alias), backup.privateKey, STATE_FILE_MODE);
  restore(publicKeyPath(backup.alias), backup.publicKey, PUBLIC_KEY_FILE_MODE);
}
