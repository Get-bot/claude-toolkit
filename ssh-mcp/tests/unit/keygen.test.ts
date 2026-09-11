/**
 * Key generation (plan row 5.3, AC7.1, AC7.2a, AC7.4).
 *
 * The POSIX mode assertions are skipped on Windows on purpose: `fs.chmod` does
 * not map onto NTFS ACLs there, which is why `setup/winacl.ts` exists. The
 * ubuntu CI leg is what actually proves AC7.2a (plan Critic C8).
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keysDirPath, privateKeyPath, publicKeyPath } from '../../src/config/paths.js';
import {
  KEY_COMMENT_PREFIX,
  OPENSSH_PRIVATE_KEY_HEADER,
  backupKeyPair,
  describePublicKey,
  generateKeyPair,
  removeKeyPair,
  restoreKeyPair,
} from '../../src/setup/keygen.js';
import { sha256Fingerprint } from '../../src/ssh/fingerprint.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

const isPosix = process.platform !== 'win32';

/**
 * Key and registry artefacts that must never appear in the package root.
 *
 * `assertNoWritesOutside` guards the real home; this guards the working
 * directory, after a stray `k.pub` was found there during development. Every
 * write in `keygen.ts` goes through `paths.ts`, so a file landing here would
 * mean a relative path slipped in somewhere.
 */
const ARTIFACT_PATTERN = /\.pub$|^hosts\.json$|^state\.json$|^audit\.jsonl/;

function cwdArtifacts(): string[] {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => ARTIFACT_PATTERN.test(name))
    .sort();
}

let home: TmpHome;
let artifactsBefore: string[];

beforeEach(() => {
  artifactsBefore = cwdArtifacts();
  home = createTmpHome('ssh-mcp-keygen-');
});

afterEach(() => {
  assertNoWritesOutside(home);
  const leaked = cwdArtifacts().filter((name) => !artifactsBefore.includes(name));
  home.cleanup();
  expect(leaked, `key material was written into ${process.cwd()}`).toEqual([]);
});

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe('generateKeyPair', () => {
  it('writes an OpenSSH-format ed25519 pair under the keys directory', () => {
    const keys = generateKeyPair('prod');

    expect(keys.privateKeyPath).toBe(privateKeyPath('prod'));
    expect(keys.publicKeyPath).toBe(publicKeyPath('prod'));
    expect(fs.existsSync(keysDirPath())).toBe(true);

    const priv = fs.readFileSync(keys.privateKeyPath, 'utf8');
    // AC7.1: the private key must be the OpenSSH container, not PKCS#8.
    expect(priv.startsWith(OPENSSH_PRIVATE_KEY_HEADER)).toBe(true);
    expect(priv).toContain('-----END OPENSSH PRIVATE KEY-----');

    const pub = fs.readFileSync(keys.publicKeyPath, 'utf8');
    expect(pub.endsWith('\n')).toBe(true);
    expect(pub.trim()).toBe(keys.publicKeyLine);
    expect(keys.publicKeyLine.startsWith('ssh-ed25519 ')).toBe(true);
    expect(keys.publicKeyLine).toContain(`${KEY_COMMENT_PREFIX}prod`);
    expect(keys.publicKeyLine).not.toContain('\n');
    // ssh2 reports the wire algorithm name, which is also what `hostKey.algo`
    // records for a host key.
    expect(keys.algo).toBe('ssh-ed25519');
  });

  it('reports a SHA256 fingerprint with no base64 padding (AC7.4)', () => {
    const keys = generateKeyPair('fp');
    expect(keys.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(keys.fingerprint).not.toContain('=');
    // The fingerprint belongs to the public half of the pair we just wrote.
    const line = fs.readFileSync(keys.publicKeyPath, 'utf8');
    expect(describePublicKey(line).fingerprint).toBe(keys.fingerprint);
  });

  it('produces a different key on every call', () => {
    const first = generateKeyPair('a');
    const second = generateKeyPair('b');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.publicKeyLine).not.toBe(first.publicKeyLine);
  });

  it.skipIf(!isPosix)('applies 0600 to the private key and 0644 to the public key', () => {
    const keys = generateKeyPair('modes');
    expect(mode(keys.privateKeyPath)).toBe(0o600);
    expect(mode(keys.publicKeyPath)).toBe(0o644);
    expect(mode(keysDirPath())).toBe(0o700);
  });

  it.skipIf(!isPosix)('tightens the mode of a world-readable leftover key', () => {
    const keys = generateKeyPair('reused');
    fs.chmodSync(keys.privateKeyPath, 0o666);
    generateKeyPair('reused');
    expect(mode(privateKeyPath('reused'))).toBe(0o600);
  });
});

describe('sha256Fingerprint', () => {
  it('matches the OpenSSH representation for a known blob', () => {
    // sha256("") = 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU= -> padding dropped.
    expect(sha256Fingerprint(Buffer.alloc(0))).toBe(
      'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'
    );
  });
});

describe('backup and rollback', () => {
  it('restores the previous pair after an aborted regeneration', () => {
    const original = generateKeyPair('roll');
    const originalPrivate = fs.readFileSync(original.privateKeyPath, 'utf8');

    const backup = backupKeyPair('roll');
    const replacement = generateKeyPair('roll');
    expect(replacement.fingerprint).not.toBe(original.fingerprint);

    restoreKeyPair(backup);
    expect(fs.readFileSync(privateKeyPath('roll'), 'utf8')).toBe(originalPrivate);
    expect(fs.readFileSync(publicKeyPath('roll'), 'utf8').trim()).toBe(original.publicKeyLine);
  });

  it('deletes both halves when the snapshot had no key (first-run abort)', () => {
    const backup = backupKeyPair('fresh');
    expect(backup.privateKey).toBeNull();
    expect(backup.publicKey).toBeNull();

    generateKeyPair('fresh');
    restoreKeyPair(backup);

    expect(fs.existsSync(privateKeyPath('fresh'))).toBe(false);
    expect(fs.existsSync(publicKeyPath('fresh'))).toBe(false);
  });

  it('removeKeyPair is quiet about a pair that is not there', () => {
    expect(() => {
      removeKeyPair('never-existed');
    }).not.toThrow();
  });
});
