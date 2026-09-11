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

import { CodedError, ERROR_CODES } from '../errors.js';
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

/** How many times a malformed pair is discarded before giving up. */
export const MAX_GENERATION_ATTEMPTS = 12;

/** Raw output of an ed25519 generator: two OpenSSH-format strings. */
export interface RawKeyPair {
  private: string;
  public: string;
}

/** Injectable generator, so a test can hand back a known-malformed pair. */
export type KeyPairGenerator = (comment: string) => RawKeyPair;

export interface GenerateKeyPairDeps {
  generate?: KeyPairGenerator;
}

/** The real thing: ssh2's ed25519 generator (OPT-7 A). */
export const defaultKeyPairGenerator: KeyPairGenerator = (comment) =>
  utils.generateKeyPairSync('ed25519', { comment });

interface SoundKeyPair {
  privateKey: string;
  publicKeyLine: string;
  fingerprint: string;
  algo: string;
}

/**
 * Return the pair only if both halves parse and agree with each other.
 *
 * ssh2 1.17.0 emits a malformed pair roughly once in every 130 calls (14 in
 * 2000, measured by the ssh lane): the encoded body comes out three bytes short
 * and `parseKey` rejects it. Both halves are affected, so both are parsed back.
 *
 * The public key carried inside the private half is then compared with the
 * public line. Parsing alone would accept two halves that came from different
 * draws: each is well formed, but the key authenticates nowhere, and `setup`
 * would only find out at the key-only reconnect (row 5.6) - after the password
 * had already gone over the wire.
 *
 * Returns `null` for a bad draw; {@link generateKeyPair} retries.
 */
function validatePair(pair: RawKeyPair): SoundKeyPair | null {
  if (!pair.private.startsWith(OPENSSH_PRIVATE_KEY_HEADER)) return null;

  const parsedPrivate = utils.parseKey(pair.private);
  if (parsedPrivate instanceof Error || !parsedPrivate.isPrivateKey()) return null;

  const publicKeyLine = pair.public.trim();
  if (utils.parseKey(publicKeyLine) instanceof Error) return null;

  const parsedPublic = parseAuthorizedKeyLine(publicKeyLine);
  if (parsedPublic === null) return null;

  if (sha256Fingerprint(parsedPrivate.getPublicSSH()) !== parsedPublic.fingerprint) return null;

  return {
    privateKey: pair.private,
    publicKeyLine,
    fingerprint: parsedPublic.fingerprint,
    algo: parsedPublic.algo,
  };
}

/**
 * Generate a key pair for `alias` and write both halves under `keysDirPath()`.
 *
 * An existing pair is overwritten: the caller (`setup --force`) is responsible
 * for having taken a {@link backupKeyPair} first so an aborted run can restore
 * the previous key (row 5.1b).
 *
 * A malformed draw is discarded and retried here rather than handed to the
 * caller, so `setup` does not fail once in every 130 runs over a key the user
 * never saw (see {@link validatePair}). Nothing is written until a sound pair
 * is in hand, so the bounded failure path leaves the key directory untouched.
 */
export function generateKeyPair(alias: string, deps: GenerateKeyPairDeps = {}): GeneratedKeyPair {
  const generate = deps.generate ?? defaultKeyPairGenerator;
  const comment = `${KEY_COMMENT_PREFIX}${alias}`;

  let sound: SoundKeyPair | null = null;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS && sound === null; attempt += 1) {
    sound = validatePair(generate(comment));
  }
  if (sound === null) {
    throw new CodedError(
      ERROR_CODES.internal_error,
      `ssh2 ${String(MAX_GENERATION_ATTEMPTS)}회 연속으로 손상된 ed25519 키 쌍을 반환했습니다 ` +
        '(ssh2 1.17.0의 알려진 결함: 인코딩된 본문이 3바이트 짧게 나옵니다). ' +
        '키 파일과 hosts.json에 아무것도 쓰지 않고 중단합니다.',
      { attempts: MAX_GENERATION_ATTEMPTS, alias }
    );
  }

  ensureKeysDir();

  const privatePath = privateKeyPath(alias);
  const publicPath = publicKeyPath(alias);

  // Remove first: writeFileSync keeps the mode of an existing file, and a
  // world-readable leftover from an earlier run must not survive.
  fs.rmSync(privatePath, { force: true });
  fs.rmSync(publicPath, { force: true });

  fs.writeFileSync(privatePath, sound.privateKey, { encoding: 'utf8', mode: STATE_FILE_MODE });
  applyMode(privatePath, STATE_FILE_MODE);

  fs.writeFileSync(publicPath, `${sound.publicKeyLine}\n`, {
    encoding: 'utf8',
    mode: PUBLIC_KEY_FILE_MODE,
  });
  applyMode(publicPath, PUBLIC_KEY_FILE_MODE);

  return {
    alias,
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
    publicKeyLine: sound.publicKeyLine,
    fingerprint: sound.fingerprint,
    algo: sound.algo,
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
