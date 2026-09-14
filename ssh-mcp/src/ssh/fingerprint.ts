/**
 * OpenSSH-style SHA-256 fingerprints (plan row 3.1, AC7.4, AC9).
 *
 * `ssh-keygen -lf` prints `SHA256:` followed by the unpadded base64 of the
 * SHA-256 digest of the public key *blob* — the SSH wire encoding, not the
 * PEM text and not a hex digest. ssh2 hands us exactly that blob in two
 * places, so both sides of the pin comparison use this one function:
 *
 * - `hostVerifier(key, verify)` receives the server host key blob as a Buffer
 *   when `hostHash` is left unset (verified against ssh2 1.17.0:
 *   `lib/client.js:281` only hashes when `hostHash` names a known algorithm,
 *   and `lib/protocol/kex.js:1188` passes the K_S string through).
 * - `utils.parseKey(...).getPublicSSH()` returns the same encoding for a key
 *   read from a file or from an `authorized_keys` line.
 *
 * The `hostHash` option is deliberately unused: it yields a hex string, which
 * would not match the `SHA256:` notation users see in their terminals.
 */
import { createHash } from 'node:crypto';

/** Key type prefixes accepted in an `authorized_keys` line. */
const KEY_TYPE_PREFIXES = ['ssh-', 'ecdsa-sha2-', 'sk-ssh-', 'sk-ecdsa-sha2-'] as const;

/**
 * `SHA256:` + unpadded base64 of the SHA-256 digest of a public key blob.
 * Identical to `ssh-keygen -lf` output for the same key.
 */
export function sha256Fingerprint(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export interface ParsedAuthorizedKey {
  /** Key algorithm, e.g. `ssh-ed25519`. */
  algo: string;
  /** The wire-format public key. */
  blob: Buffer;
  /** Trailing comment, or `null` when the line has none. */
  comment: string | null;
  /** Leading option list (`no-pty,command="..."`), or `null`. */
  options: string | null;
  /** Fingerprint of {@link ParsedAuthorizedKey.blob}. */
  fingerprint: string;
}

function isKeyTypeToken(token: string): boolean {
  return KEY_TYPE_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** Read the first `string` field of a wire-format blob. */
function blobType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || blob.length < 4 + length) return null;
  return blob.subarray(4, 4 + length).toString('utf8');
}

/**
 * Parse one `authorized_keys` line. Returns `null` for a blank line, a comment
 * line, or anything that does not decode into a blob whose embedded type
 * matches its algorithm token.
 *
 * Option lists are tolerated (`restrict ssh-ed25519 AAAA... user@host`) because
 * a user's existing file may well have them, and the idempotence check in
 * `setup` (AC7.3) has to recognise our own key inside such a line.
 */
export function parseAuthorizedKeyLine(line: string): ParsedAuthorizedKey | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const tokens = trimmed.split(/\s+/);
  const typeIndex = tokens.findIndex(isKeyTypeToken);
  if (typeIndex === -1) return null;

  const algo = tokens[typeIndex];
  const encoded = tokens[typeIndex + 1];
  if (algo === undefined || encoded === undefined) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;

  const blob = Buffer.from(encoded, 'base64');
  if (blob.length === 0 || blobType(blob) !== algo) return null;

  const comment = tokens.slice(typeIndex + 2).join(' ');
  const options = typeIndex === 0 ? null : tokens.slice(0, typeIndex).join(' ');

  return {
    algo,
    blob,
    comment: comment === '' ? null : comment,
    options,
    fingerprint: sha256Fingerprint(blob),
  };
}

/**
 * Wire-format public key from an OpenSSH one-line public key.
 * Throws when the line cannot be parsed: a caller that reached this point has
 * already decided the line is supposed to be a key.
 */
export function publicKeyBlobFromOpenSsh(line: string): Buffer {
  const parsed = parseAuthorizedKeyLine(line);
  if (parsed === null) {
    throw new Error('not a valid OpenSSH public key line');
  }
  return parsed.blob;
}

/** Fingerprint of an OpenSSH one-line public key. */
export function fingerprintFromOpenSsh(line: string): string {
  return sha256Fingerprint(publicKeyBlobFromOpenSsh(line));
}

/**
 * True when both fingerprints are the same pin. Compared as plain strings:
 * a fingerprint is public information, so there is nothing to leak by timing.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  return a === b;
}
