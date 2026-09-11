/**
 * `SHA256:` fingerprints (AC7.4, AC9).
 *
 * The fixed vector below was produced by `ssh-keygen -lf` on the public key in
 * the same constant, so this file checks our arithmetic against OpenSSH rather
 * than against itself. Without it, a fingerprint bug would be invisible: the
 * fixture pins whatever we compute, so both sides of every integration test
 * would agree on the same wrong value.
 */
import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';

import {
  fingerprintFromOpenSsh,
  fingerprintsMatch,
  parseAuthorizedKeyLine,
  publicKeyBlobFromOpenSsh,
  sha256Fingerprint,
} from '../../src/ssh/fingerprint.js';
import { HOST_KEY_SHA256_PATTERN } from '../../src/config/schema.js';

/** `ssh-keygen -lf` on this key prints the fingerprint below. */
const VECTOR_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIoDEDsSEWxN/HjxJf3BLAJKQVkXnrnMR9MZ8ZXRCGZX ssh-mcp:vector';
const VECTOR_FINGERPRINT = 'SHA256:iHFP6J7SRDGC9gZWszILVcVrVXZ7XDXx0ixmaZm0REQ';

describe('sha256Fingerprint', () => {
  it('matches ssh-keygen -lf for a known key', () => {
    expect(fingerprintFromOpenSsh(VECTOR_PUBLIC_KEY)).toBe(VECTOR_FINGERPRINT);
  });

  it('produces the shape the registry schema accepts (AC7.4)', () => {
    expect(HOST_KEY_SHA256_PATTERN.test(VECTOR_FINGERPRINT)).toBe(true);
    expect(VECTOR_FINGERPRINT.slice('SHA256:'.length)).toHaveLength(43);
    expect(VECTOR_FINGERPRINT).not.toContain('=');
  });

  it('agrees with the blob ssh2 reports for a parsed key', () => {
    const parsed = utils.parseKey(VECTOR_PUBLIC_KEY);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(key).toBeDefined();
    if (key === undefined) return;
    expect(sha256Fingerprint(key.getPublicSSH())).toBe(VECTOR_FINGERPRINT);
  });

  it('changes completely when one bit of the key changes', () => {
    const blob = publicKeyBlobFromOpenSsh(VECTOR_PUBLIC_KEY);
    const altered = Buffer.from(blob);
    const last = altered.length - 1;
    altered[last] = (altered[last] as number) ^ 0x01;
    expect(sha256Fingerprint(altered)).not.toBe(VECTOR_FINGERPRINT);
  });

  it('compares two fingerprints as exact strings', () => {
    expect(fingerprintsMatch(VECTOR_FINGERPRINT, VECTOR_FINGERPRINT)).toBe(true);
    expect(fingerprintsMatch(VECTOR_FINGERPRINT, `${VECTOR_FINGERPRINT}x`)).toBe(false);
  });
});

describe('parseAuthorizedKeyLine', () => {
  it('reads algorithm, comment and fingerprint', () => {
    const parsed = parseAuthorizedKeyLine(VECTOR_PUBLIC_KEY);
    expect(parsed?.algo).toBe('ssh-ed25519');
    expect(parsed?.comment).toBe('ssh-mcp:vector');
    expect(parsed?.options).toBeNull();
    expect(parsed?.fingerprint).toBe(VECTOR_FINGERPRINT);
  });

  it('tolerates an option list in front of the key (AC7.3)', () => {
    const parsed = parseAuthorizedKeyLine(`restrict,no-pty ${VECTOR_PUBLIC_KEY}`);
    expect(parsed?.options).toBe('restrict,no-pty');
    expect(parsed?.fingerprint).toBe(VECTOR_FINGERPRINT);
  });

  it('accepts a line with no comment', () => {
    const [algo, blob] = VECTOR_PUBLIC_KEY.split(' ');
    const parsed = parseAuthorizedKeyLine(`${algo as string} ${blob as string}`);
    expect(parsed?.comment).toBeNull();
    expect(parsed?.fingerprint).toBe(VECTOR_FINGERPRINT);
  });

  it.each([
    ['a blank line', '   '],
    ['a comment line', '# ssh-ed25519 AAAA'],
    ['a line with no key type', 'hello world'],
    ['a key type with no blob', 'ssh-ed25519'],
    ['a blob that is not base64', 'ssh-ed25519 !!!not-base64!!!'],
    ['a blob whose type does not match', 'ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIIoDEDsSEWxN'],
  ])('returns null for %s', (_label, line) => {
    expect(parseAuthorizedKeyLine(line)).toBeNull();
  });

  it('throws from publicKeyBlobFromOpenSsh on an unparseable line', () => {
    expect(() => publicKeyBlobFromOpenSsh('not a key')).toThrow(/not a valid OpenSSH public key/);
  });
});
