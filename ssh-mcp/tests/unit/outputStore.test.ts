/**
 * The in-memory output store (plan row D3, ADR-010, AC-O2a, AC-O4, AC-O5,
 * AC-O7a).
 *
 * Two of these tests exist because of a specific bug the plan predicted and
 * this design closes: a PEM block straddling a page boundary, and a non-UTF-8
 * stream destroyed by a `utf8` round trip. Both pass trivially if masking is
 * done once over the whole buffer in `latin1`, and both fail loudly otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../src/errors.js';
import { REDACTED_PEM } from '../../src/log.js';
import {
  getOutput,
  maskRetained,
  OUTPUT_REF_BYTES,
  OUTPUT_STORE_MAX_BYTES,
  OUTPUT_TTL_MS,
  outputStoreStats,
  putOutput,
  resetOutputStore,
} from '../../src/output/store.js';

afterEach(() => {
  resetOutputStore();
  vi.useRealTimers();
});

/** A syntactically complete PEM private key block of roughly `bytes` length. */
function pemBlock(bodyBytes: number): string {
  const body = 'A'.repeat(bodyBytes);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
}

/** Read the whole entry back through the paging API, `pageBytes` at a time. */
function drain(ref: string, pageBytes: number): { bytes: Buffer; pages: number } {
  const chunks: Buffer[] = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null) {
    const page = getOutput(ref, cursor, pageBytes);
    chunks.push(page.bytes);
    cursor = page.nextOffset;
    pages += 1;
    expect(pages).toBeLessThan(10_000);
  }
  return { bytes: Buffer.concat(chunks), pages };
}

describe('references (AC-O5)', () => {
  it('mints 128 bits of base64url that never repeat', () => {
    expect(OUTPUT_REF_BYTES).toBe(16);
    const refs = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const ref = putOutput(Buffer.from(`entry-${String(i)}`), 'utf8');
      expect(ref).not.toBeNull();
      expect(ref as string).toMatch(/^[A-Za-z0-9_-]{22}$/);
      refs.add(ref as string);
    }
    expect(refs.size).toBe(50);
  });

  it('declines to store an empty stream', () => {
    expect(putOutput(Buffer.alloc(0), 'utf8')).toBeNull();
    expect(outputStoreStats().entries).toBe(0);
  });
});

describe('paging over one coordinate system (AC-O2, AC-O2a)', () => {
  it('returns the whole stream in order, and the byte counts add up', () => {
    const payload = Buffer.from(
      Array.from({ length: 500 }, (_, i) => `line ${String(i)}\n`).join(''),
      'utf8'
    );
    const ref = putOutput(payload, 'utf8') as string;

    const first = getOutput(ref, 0, 1024);
    expect(first.offset).toBe(0);
    expect(first.totalBytes).toBe(payload.length);
    expect(first.nextOffset).toBe(first.bytes.length);

    const drained = drain(ref, 1024);
    expect(drained.pages).toBeGreaterThan(1);
    expect(drained.bytes.equals(payload)).toBe(true);
    expect(drained.bytes.length).toBe(first.totalBytes);
  });

  it('never splits a UTF-8 sequence across pages', () => {
    // 3-byte characters against a page size that is not a multiple of three:
    // every page boundary would otherwise land inside a character.
    const payload = Buffer.from('한'.repeat(4000), 'utf8');
    const ref = putOutput(payload, 'utf8') as string;

    const chunks: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = getOutput(ref, cursor, 2048);
      chunks.push(page.bytes.toString('utf8'));
      cursor = page.nextOffset;
    }
    const rejoined = chunks.join('');
    expect(rejoined).toBe('한'.repeat(4000));
    expect(Buffer.byteLength(rejoined, 'utf8')).toBe(payload.length);
    expect(rejoined).not.toContain('�');
  });

  it('clamps an offset past the end instead of throwing', () => {
    const ref = putOutput(Buffer.from('short'), 'utf8') as string;
    const page = getOutput(ref, 99, 1024);
    expect(page.offset).toBe(5);
    expect(page.bytes).toHaveLength(0);
    expect(page.nextOffset).toBeNull();
  });

  it('reports the encoding it was stored with', () => {
    const ref = putOutput(Buffer.from([0x00, 0xff, 0xfe]), 'base64') as string;
    expect(getOutput(ref, 0, 1024).encoding).toBe('base64');
  });
});

describe('PEM masking happens once, over the whole buffer (AC-O7a)', () => {
  it('masks a block that straddles a page boundary', () => {
    // The plan's worked example. In the *raw* stream the key starts at byte
    // 4001 and ends at ~6100, so it crosses the 4096-byte page boundary: page
    // one would be covered by `PEM_OPEN_PATTERN` and page two would come back
    // in clear if masking were applied per page. The trailing filler keeps the
    // masked buffer over one page long, so paging is genuinely exercised.
    const pageBytes = 4096;
    const prefix = 'x'.repeat(4000);
    const suffix = 'z'.repeat(4000);
    const key = pemBlock(2048);
    const payload = Buffer.from(`${prefix}\n${key}\n${suffix}\n`, 'utf8');
    expect(payload.indexOf('-----BEGIN ')).toBeLessThan(pageBytes);
    expect(payload.indexOf('-----END ')).toBeGreaterThan(pageBytes);

    const ref = putOutput(payload, 'utf8') as string;
    const drained = drain(ref, pageBytes);
    const text = drained.bytes.toString('utf8');

    expect(drained.pages).toBeGreaterThan(1);
    expect(text).toContain(REDACTED_PEM);
    expect(text).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(text).not.toContain('-----END OPENSSH PRIVATE KEY-----');
    expect(text).not.toContain('A'.repeat(64));
    // Everything around the key is untouched.
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.endsWith(`${suffix}\n`)).toBe(true);
  });

  it('masks a block in a stream stored as base64', () => {
    const payload = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xfe, 0x80]),
      Buffer.from(`\n${pemBlock(512)}\n`, 'latin1'),
      Buffer.from([0x90, 0x00]),
    ]);
    const ref = putOutput(payload, 'base64') as string;
    const drained = drain(ref, 64 * 1024);
    const asLatin1 = drained.bytes.toString('latin1');

    expect(asLatin1).toContain(REDACTED_PEM);
    expect(asLatin1).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    // The binary bytes around it survived the round trip.
    expect(drained.bytes.subarray(0, 4).equals(Buffer.from([0x00, 0xff, 0xfe, 0x80]))).toBe(true);
  });

  it('leaves a PEM-free non-UTF-8 stream byte-identical', () => {
    // The `utf8` round trip this design rejects turns these 7 bytes into 15.
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42, 0x90]);
    expect(maskRetained(payload).equals(payload)).toBe(true);
    // No PEM marker means no round trip at all: the same Buffer comes back.
    expect(maskRetained(payload)).toBe(payload);

    const ref = putOutput(payload, 'base64') as string;
    const page = getOutput(ref, 0, 1024);
    expect(page.totalBytes).toBe(7);
    expect(page.bytes.equals(payload)).toBe(true);
  });

  it('applies no other redaction (AC-O7)', () => {
    // A sensitive-looking key name and a 4 KiB string both survive: only PEM
    // blocks are masked, and nothing is length-capped.
    const payload = Buffer.from(`password=hunter2 ${'y'.repeat(4096)}`, 'utf8');
    const ref = putOutput(payload, 'utf8') as string;
    const drained = drain(ref, 64 * 1024);
    expect(drained.bytes.toString('utf8')).toBe(payload.toString('utf8'));
  });
});

describe('lifetime (AC-O4)', () => {
  it('expires an entry after the TTL', () => {
    vi.useFakeTimers();
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    expect(getOutput(ref, 0, 1024).totalBytes).toBe(7);

    vi.advanceTimersByTime(OUTPUT_TTL_MS + 1);
    expect(() => getOutput(ref, 0, 1024)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.output_expired })
    );
    expect(outputStoreStats().entries).toBe(0);
  });

  it('keeps an entry that is not yet at the TTL', () => {
    vi.useFakeTimers();
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    vi.advanceTimersByTime(OUTPUT_TTL_MS - 1);
    expect(getOutput(ref, 0, 1024).totalBytes).toBe(7);
  });

  it('drops the oldest entries first when the total cap is reached', () => {
    // Four 20 MiB entries against a 64 MiB cap: the first must be gone by the
    // time the fourth lands, and it must be the first that goes.
    const chunk = Buffer.alloc(20 * 1024 * 1024, 0x61);
    const refs = [
      putOutput(chunk, 'utf8') as string,
      putOutput(chunk, 'utf8') as string,
      putOutput(chunk, 'utf8') as string,
    ];
    expect(outputStoreStats().entries).toBe(3);

    const fourth = putOutput(chunk, 'utf8') as string;
    expect(outputStoreStats().bytes).toBeLessThanOrEqual(OUTPUT_STORE_MAX_BYTES);
    expect(() => getOutput(refs[0] as string, 0, 1024)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.output_expired })
    );
    expect(getOutput(refs[2] as string, 0, 1024).totalBytes).toBe(chunk.length);
    expect(getOutput(fourth, 0, 1024).totalBytes).toBe(chunk.length);
  });

  it('declines a stream larger than the whole store', () => {
    expect(putOutput(Buffer.alloc(OUTPUT_STORE_MAX_BYTES + 1), 'utf8')).toBeNull();
    expect(outputStoreStats().entries).toBe(0);
  });

  it('reports an unknown reference as output_expired', () => {
    expect(() => getOutput('never-issued', 0, 1024)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.output_expired })
    );
  });

  it('forgets everything on reset, as a restart would', () => {
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    resetOutputStore();
    expect(outputStoreStats()).toEqual({ entries: 0, bytes: 0 });
    expect(() => getOutput(ref, 0, 1024)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.output_expired })
    );
  });
});
