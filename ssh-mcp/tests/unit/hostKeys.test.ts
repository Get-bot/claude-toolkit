/**
 * The fixture key generator's validation loop.
 *
 * ssh2 1.17.0 returns a malformed ed25519 pair roughly once in every 130 calls
 * (14 in 2000 measured), which is frequent enough to redden a full suite run
 * and rare enough that a loop-until-it-happens test would be useless. So the
 * defect is injected instead: `utils.generateKeyPairSync` is a writable
 * property on the `utils` namespace object, which makes a spy enough and a
 * module mock unnecessary.
 *
 * Three shapes are covered: a short encoded body (the real defect), halves
 * taken from different draws (what parsing alone would let through), and a
 * generator that never recovers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utils } from 'ssh2';

import { generateClientKey, generateHostKey, generateKeyPair } from '../fixtures/hostKeys.js';
import { sha256Fingerprint } from '../../src/ssh/fingerprint.js';

interface RawPair {
  private: string;
  public: string;
}

/** Draw from the real generator until it returns a pair that parses. */
function soundPair(comment = 'ssh-mcp-unit'): RawPair {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const keys = utils.generateKeyPairSync('ed25519', { comment });
    if (utils.parseKey(keys.private) instanceof Error) continue;
    if (utils.parseKey(keys.public.trim()) instanceof Error) continue;
    return { private: keys.private, public: keys.public };
  }
  throw new Error('could not obtain a sound ed25519 pair from ssh2');
}

/**
 * Reproduce the defect: drop four base64 characters from the encoded body, so
 * the text still carries the right header and footer but decodes three bytes
 * short. That is exactly what the observed bad draws look like.
 */
function shortenBody(keyText: string): string {
  const lines = keyText.split('\n');
  const bodyIndex = lines.findIndex((line, index) => index > 0 && line.length >= 64);
  if (bodyIndex === -1) throw new Error('no body line to shorten');
  const body = lines[bodyIndex] as string;
  lines[bodyIndex] = body.slice(0, body.length - 4);
  return lines.join('\n');
}

function malformedPair(): RawPair {
  const sound = soundPair();
  return { private: shortenBody(sound.private), public: sound.public };
}

/**
 * The same three-byte loss on the public half: decode the blob, drop the last
 * three bytes, re-encode. The trailing key string then claims more bytes than
 * remain, which is what `parseKey` rejects.
 */
function shortenPublicBody(publicKey: string): string {
  const [algo, encoded, ...rest] = publicKey.trim().split(/\s+/);
  const blob = Buffer.from(encoded ?? '', 'base64');
  return [algo, blob.subarray(0, blob.length - 3).toString('base64'), ...rest].join(' ');
}

/**
 * A draw whose private half is sound and whose public half is short. The real
 * defect shortens both, but the private check runs first and would mask this
 * branch, so the halves are corrupted one at a time.
 */
function publicMalformedPair(): RawPair {
  const sound = soundPair();
  return { private: sound.private, public: shortenPublicBody(sound.public) };
}

/** Queue a fixed sequence of draws in place of the real generator. */
function stubDraws(draws: RawPair[]): ReturnType<typeof vi.spyOn> {
  let index = 0;
  return vi.spyOn(utils, 'generateKeyPairSync').mockImplementation(() => {
    const draw = draws[Math.min(index, draws.length - 1)];
    index += 1;
    if (draw === undefined) throw new Error('no draw queued');
    return { private: draw.private, public: draw.public };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('injected defect shapes', () => {
  it('is really rejected by ssh2, so the retry cases are not vacuous', () => {
    const bad = malformedPair();
    expect(utils.parseKey(bad.private)).toBeInstanceOf(Error);
  });

  it('rejects a short public half while leaving the private half sound', () => {
    const bad = publicMalformedPair();
    expect(utils.parseKey(bad.public)).toBeInstanceOf(Error);
    // Without this the case would be indistinguishable from the private-half
    // one, because the private check short-circuits first.
    expect(utils.parseKey(bad.private)).not.toBeInstanceOf(Error);
  });
});

describe('generateKeyPair retries', () => {
  it('discards two malformed draws and returns the third', () => {
    const good = soundPair();
    const spy = stubDraws([malformedPair(), malformedPair(), good]);

    const pair = generateKeyPair('ssh-mcp-unit');

    expect(spy).toHaveBeenCalledTimes(3);
    expect(pair.privateKey).toBe(good.private);
    expect(pair.publicKey).toBe(good.public.trim());
    expect(utils.parseKey(pair.privateKey)).not.toBeInstanceOf(Error);
  });

  it('discards a draw whose public half is short', () => {
    const good = soundPair();
    const spy = stubDraws([publicMalformedPair(), good]);

    const pair = generateKeyPair('ssh-mcp-unit');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(pair.privateKey).toBe(good.private);
    expect(pair.publicKey).toBe(good.public.trim());
    expect(utils.parseKey(pair.publicKey)).not.toBeInstanceOf(Error);
  });

  it('discards a pair whose halves come from different draws', () => {
    const first = soundPair();
    const second = soundPair();
    const good = soundPair();
    // Both halves parse; they simply do not belong together.
    const mixed: RawPair = { private: first.private, public: second.public };
    expect(utils.parseKey(mixed.private)).not.toBeInstanceOf(Error);
    expect(utils.parseKey(mixed.public.trim())).not.toBeInstanceOf(Error);

    const spy = stubDraws([mixed, good]);
    const pair = generateKeyPair('ssh-mcp-unit');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(pair.privateKey).toBe(good.private);
  });

  it('accepts a sound pair on the first draw', () => {
    const good = soundPair();
    const spy = stubDraws([good]);

    const pair = generateKeyPair('ssh-mcp-unit');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(pair.algo).toBe('ssh-ed25519');
  });

  it('gives up after twelve unusable draws', () => {
    const spy = stubDraws([malformedPair()]);

    expect(() => generateKeyPair('ssh-mcp-unit')).toThrow(/unusable ed25519 key pairs/);
    expect(spy).toHaveBeenCalledTimes(12);
  });
});

describe('the pair it hands out', () => {
  it('reports the fingerprint of its own public half', () => {
    const pair = generateKeyPair('ssh-mcp-unit');
    const blob = Buffer.from(pair.publicKey.split(/\s+/)[1] as string, 'base64');
    expect(pair.fingerprint).toBe(sha256Fingerprint(blob));
  });

  it('derives the same fingerprint from the private half', () => {
    const pair = generateKeyPair('ssh-mcp-unit');
    const parsed = utils.parseKey(pair.privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(key).toBeDefined();
    if (key === undefined) return;
    expect(sha256Fingerprint(key.getPublicSSH())).toBe(pair.fingerprint);
  });

  it('labels host and client keys distinctly', () => {
    expect(generateHostKey().publicKey).toContain('ssh-mcp-fixture-host');
    expect(generateClientKey().publicKey).toContain('ssh-mcp-fixture-client');
  });

  it('never returns the same key twice', () => {
    expect(generateKeyPair().fingerprint).not.toBe(generateKeyPair().fingerprint);
  });
});
