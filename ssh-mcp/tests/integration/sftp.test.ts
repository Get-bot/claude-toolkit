/**
 * File transfer round trips (AC13).
 *
 * Runs against both endpoints: the in-process SFTP subsystem and, under
 * `ENDPOINT=sshd`, the real OpenSSH one. A round trip is only meaningful if it
 * is byte-exact, so every case is checked by SHA-256 rather than by size.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';

import { isCodedError } from '../../src/errors.js';
import { closeAll, getConnection } from '../../src/ssh/pool.js';
import { download, upload } from '../../src/ssh/sftp.js';
import {
  authorizeKeyOverSsh,
  hostEntryFor,
  startEndpoint,
  type TestEndpoint,
} from '../fixtures/endpoints.js';
import { generateClientKey, type FixtureKeyPair } from '../fixtures/hostKeys.js';

let endpoint: TestEndpoint;
let clientKey: FixtureKeyPair;
let conn: Client;
let localDir: string;

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Whether this machine can create symlinks at all. Decided at collection time,
 * because `runIf` is evaluated before `beforeAll`, and Windows refuses without
 * developer mode.
 */
const SYMLINKS_SUPPORTED = ((): boolean => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-symcheck-'));
  try {
    fs.symlinkSync(path.join(probeDir, 'target'), path.join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

/** Remote paths use forward slashes on both endpoints (CR-2: remote side). */
function remotePath(name: string): string {
  return `${endpoint.remoteHomeDir.replace(/\\/g, '/')}/${name}`;
}

beforeAll(async () => {
  endpoint = await startEndpoint();
  clientKey = generateClientKey();
  await authorizeKeyOverSsh(endpoint, clientKey.publicKey);
  conn = await getConnection(hostEntryFor(endpoint), Buffer.from(clientKey.privateKey, 'utf8'));
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-sftp-'));
});

afterAll(async () => {
  closeAll();
  await endpoint.close();
  fs.rmSync(localDir, { recursive: true, force: true });
});

describe('byte-identical round trips (AC13.1)', () => {
  const cases: [string, () => Buffer][] = [
    ['an empty file', () => Buffer.alloc(0)],
    ['a single byte', () => Buffer.from([0x41])],
    ['1 MiB plus one byte', () => randomBytes(1024 * 1024 + 1)],
    [
      'binary with NUL bytes and multi-byte text',
      () => {
        const nulls = Buffer.from([0x00, 0xff, 0x00]);
        return Buffer.concat([nulls, Buffer.from('한국어 ✓\n', 'utf8')]);
      },
    ],
  ];

  it.each(cases)('round-trips %s', async (label, make) => {
    const name = label.replace(/[^a-z0-9]+/gi, '-');
    const source = path.join(localDir, `${name}.src`);
    const roundTripped = path.join(localDir, `${name}.out`);
    const content = make();
    fs.writeFileSync(source, content);

    const uploaded = await upload(conn, source, remotePath(`${name}.bin`));
    expect(uploaded.bytes).toBe(content.length);

    const downloaded = await download(conn, remotePath(`${name}.bin`), roundTripped);
    expect(downloaded.bytes).toBe(content.length);
    expect(sha256(roundTripped)).toBe(sha256(source));
    expect(fs.readFileSync(roundTripped).equals(content)).toBe(true);
  });
});

describe('overwrite protection (AC13.2)', () => {
  const name = 'overwrite-guard';

  beforeAll(async () => {
    const source = path.join(localDir, `${name}.src`);
    fs.writeFileSync(source, 'remote content\n');
    await upload(conn, source, remotePath(`${name}.bin`));
  });

  it('refuses to replace an existing local file by default', async () => {
    const target = path.join(localDir, `${name}.existing`);
    fs.writeFileSync(target, 'local content\n');

    await expect(download(conn, remotePath(`${name}.bin`), target)).rejects.toMatchObject({
      code: 'local_file_exists',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('local content\n');
  });

  it('replaces the file when overwrite is set', async () => {
    const target = path.join(localDir, `${name}.overwritten`);
    fs.writeFileSync(target, 'local content\n');

    const result = await download(conn, remotePath(`${name}.bin`), target, { overwrite: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('remote content\n');
    expect(result.overwritten).toBe(true);
  });

  it('reports overwritten false when nothing was there to replace (CR-4)', async () => {
    const target = path.join(localDir, `${name}.fresh`);
    const result = await download(conn, remotePath(`${name}.bin`), target, { overwrite: true });
    expect(result.overwritten).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('local path safety (F16)', () => {
  const name = 'symlink-guard';

  beforeAll(async () => {
    const source = path.join(localDir, `${name}.src`);
    fs.writeFileSync(source, 'remote content\n');
    await upload(conn, source, remotePath(`${name}.bin`));
  });

  /**
   * `existsSync`/`statSync` follow links, so without an `lstat` check a link
   * planted at `local_path` makes the overwrite guard inspect the target while
   * the transfer writes through the link somewhere else entirely.
   *
   * WINDOWS-GAP: creating a symlink needs developer mode, so these two cases
   * skip on a stock Windows host and are covered by the ubuntu CI legs.
   */
  it.runIf(SYMLINKS_SUPPORTED)('refuses to write through a symlink', async () => {
    const outside = path.join(localDir, 'link-target.txt');
    fs.writeFileSync(outside, 'must not change\n');
    const link = path.join(localDir, `${name}.link`);
    fs.symlinkSync(outside, link);

    await expect(
      download(conn, remotePath(`${name}.bin`), link, { overwrite: true })
    ).rejects.toMatchObject({ code: 'sftp_failed' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('must not change\n');
  });

  it.runIf(SYMLINKS_SUPPORTED)('refuses a dangling symlink even without overwrite', async () => {
    const link = path.join(localDir, `${name}.dangling`);
    fs.symlinkSync(path.join(localDir, 'no-such-target'), link);

    await expect(download(conn, remotePath(`${name}.bin`), link)).rejects.toMatchObject({
      code: 'sftp_failed',
    });
  });

  it('refuses a remote file larger than the cap', async () => {
    const target = path.join(localDir, 'too-big.bin');
    await expect(
      download(conn, remotePath(`${name}.bin`), target, { maxBytes: 4 })
    ).rejects.toMatchObject({ code: 'sftp_failed' });
    // Nothing was written, so the cap is enforced before the transfer starts.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('allows a remote file within the cap', async () => {
    const target = path.join(localDir, 'within-cap.bin');
    const result = await download(conn, remotePath(`${name}.bin`), target, { maxBytes: 4096 });
    expect(result.bytes).toBe('remote content\n'.length);
  });
});

describe('failures', () => {
  it('reports a missing local file on upload', async () => {
    await expect(
      upload(conn, path.join(localDir, 'does-not-exist'), remotePath('never.bin'))
    ).rejects.toMatchObject({ code: 'sftp_failed' });
  });

  it('reports a missing remote file on download', async () => {
    await expect(
      download(conn, remotePath('no-such-remote-file'), path.join(localDir, 'nothing.bin'))
    ).rejects.toMatchObject({ code: 'sftp_failed' });
  });

  it('does not create parent directories', async () => {
    const target = path.join(localDir, 'missing-subdir', 'file.bin');
    const source = path.join(localDir, 'parent-check.src');
    fs.writeFileSync(source, 'x');
    await upload(conn, source, remotePath('parent-check.bin'));

    try {
      await download(conn, remotePath('parent-check.bin'), target);
      expect.unreachable('download into a missing directory should fail');
    } catch (err) {
      expect(isCodedError(err)).toBe(true);
      if (isCodedError(err)) expect(err.code).toBe('sftp_failed');
    }
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });
});
