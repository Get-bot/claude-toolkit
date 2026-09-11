/**
 * Key generation (plan row 5.3, AC7.1, AC7.2a, AC7.4).
 *
 * The POSIX mode assertions are skipped on Windows on purpose: `fs.chmod` does
 * not map onto NTFS ACLs there, which is why `setup/winacl.ts` exists. The
 * ubuntu CI leg is what actually proves AC7.2a (plan Critic C8).
 */
import fs from 'node:fs';

import { utils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keysDirPath, privateKeyPath, publicKeyPath } from '../../src/config/paths.js';
import {
  KEY_COMMENT_PREFIX,
  MAX_GENERATION_ATTEMPTS,
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

describe('malformed draws from ssh2 (1.17.0 defect)', () => {
  /**
   * ssh2 emits a pair whose encoded body is three bytes short roughly once in
   * every 130 calls. `generateKeyPair` must spend that flake internally: a user
   * running `ssh-mcp setup` should never see a failure about a key they never
   * asked about.
   */
  function shortenPublicBody(publicKey: string): string {
    const [algo, encoded, ...rest] = publicKey.trim().split(/\s+/);
    const blob = Buffer.from(encoded ?? '', 'base64');
    const truncated = blob.subarray(0, blob.length - 3).toString('base64');
    return [algo, truncated, ...rest].join(' ');
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries past a malformed pair and returns a sound one', () => {
    const real = utils.generateKeyPairSync.bind(utils);
    let draws = 0;
    vi.spyOn(utils, 'generateKeyPairSync').mockImplementation(((
      ...args: Parameters<typeof utils.generateKeyPairSync>
    ) => {
      const pair = real(...args);
      draws += 1;
      // Corrupt the first two draws the way the defect does.
      return draws <= 2 ? { ...pair, public: shortenPublicBody(pair.public) } : pair;
    }) as typeof utils.generateKeyPairSync);

    const keys = generateKeyPair('flaky');

    expect(draws).toBe(3);
    expect(keys.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // The written key is the sound one, not a corrupted earlier draw.
    expect(describePublicKey(fs.readFileSync(keys.publicKeyPath, 'utf8')).fingerprint).toBe(
      keys.fingerprint
    );
  });

  it('rejects a pair whose halves disagree', () => {
    const real = utils.generateKeyPairSync.bind(utils);
    vi.spyOn(utils, 'generateKeyPairSync').mockImplementation(((
      ...args: Parameters<typeof utils.generateKeyPairSync>
    ) => {
      // A private half from one pair and a public half from another: both parse,
      // but the key would authenticate nowhere.
      const mine = real(...args);
      const stranger = real(...args);
      return { private: mine.private, public: stranger.public };
    }) as typeof utils.generateKeyPairSync);

    expect(() => generateKeyPair('mismatched')).toThrow(/unparseable ed25519 key pairs/);
    expect(fs.existsSync(privateKeyPath('mismatched'))).toBe(false);
    expect(fs.existsSync(publicKeyPath('mismatched'))).toBe(false);
  });

  it('gives up with a clear message after the attempt limit', () => {
    const real = utils.generateKeyPairSync.bind(utils);
    let draws = 0;
    vi.spyOn(utils, 'generateKeyPairSync').mockImplementation(((
      ...args: Parameters<typeof utils.generateKeyPairSync>
    ) => {
      draws += 1;
      const pair = real(...args);
      return { ...pair, public: shortenPublicBody(pair.public) };
    }) as typeof utils.generateKeyPairSync);

    expect(() => generateKeyPair('hopeless')).toThrow(
      `ssh2 produced ${String(MAX_GENERATION_ATTEMPTS)} unparseable ed25519 key pairs in a row`
    );
    expect(draws).toBe(MAX_GENERATION_ATTEMPTS);
    expect(fs.existsSync(privateKeyPath('hopeless'))).toBe(false);
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
