/**
 * The `fetch_output` tool handler (plan row D7, AC-O2, AC-O2a, AC-O4, AC-O7).
 *
 * The store's own behaviour is covered in `outputStore.test.ts`; what is proved
 * here is the tool contract the model sees — the argument bounds, the shape of
 * the body, and the two things the response must not do to a chunk: truncate it
 * or redact it a second time.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/errors.js';
import { MAX_LOG_FIELD_BYTES, REDACTED, REDACTED_PEM } from '../../src/log.js';
import { putOutput, resetOutputStore } from '../../src/output/store.js';
import { createToolContext, type ToolContext } from '../../src/tools/context.js';
import {
  DEFAULT_FETCH_BYTES,
  fetchOutputTool,
  MAX_FETCH_BYTES,
  MIN_FETCH_BYTES,
} from '../../src/tools/fetchOutput.js';
import { newAuditDraft } from '../../src/tools/wrap.js';

const ctx: ToolContext = createToolContext({
  client: () => null,
  elicit: () => Promise.reject(new Error('fetch_output must never elicit')),
});

afterEach(() => {
  resetOutputStore();
});

interface FetchBody {
  chunk: string;
  encoding: 'utf8' | 'base64';
  offset: number;
  next_cursor: number | null;
  total_bytes: number;
}

async function call(args: Record<string, unknown>): Promise<FetchBody> {
  const result = await fetchOutputTool.handler(args, ctx, newAuditDraft());
  expect(result.isError, result.content[0]?.text).toBe(false);
  return JSON.parse(result.content[0]?.text ?? '{}') as FetchBody;
}

/** Page through a reference and return the concatenated bytes. */
async function drain(ref: string, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let cursor: number | null = 0;
  let guard = 0;
  while (cursor !== null) {
    const body: FetchBody = await call({
      output_ref: ref,
      cursor,
      ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
    });
    chunks.push(Buffer.from(body.chunk, body.encoding));
    expect(body.offset).toBe(cursor);
    cursor = body.next_cursor;
    guard += 1;
    expect(guard).toBeLessThan(1000);
  }
  return Buffer.concat(chunks);
}

describe('argument bounds (AC-O2)', () => {
  it('states the documented defaults and limits', () => {
    expect(DEFAULT_FETCH_BYTES).toBe(64 * 1024);
    expect(MAX_FETCH_BYTES).toBe(1024 * 1024);
  });

  it('rejects a page size outside the allowed range', async () => {
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    await expect(
      fetchOutputTool.handler(
        { output_ref: ref, max_bytes: MAX_FETCH_BYTES + 1 },
        ctx,
        newAuditDraft()
      )
    ).rejects.toThrow();
    await expect(
      fetchOutputTool.handler(
        { output_ref: ref, max_bytes: MIN_FETCH_BYTES - 1 },
        ctx,
        newAuditDraft()
      )
    ).rejects.toThrow();
    await expect(
      fetchOutputTool.handler({ output_ref: ref, cursor: -1 }, ctx, newAuditDraft())
    ).rejects.toThrow();
  });

  it('defaults the cursor to the beginning of the stream', async () => {
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    const body = await call({ output_ref: ref });
    expect(body.offset).toBe(0);
    expect(body.chunk).toBe('payload');
    expect(body.next_cursor).toBeNull();
    expect(body.total_bytes).toBe(7);
  });
});

describe('the whole stream, in order (AC-O2, AC-O2a)', () => {
  it('reassembles byte for byte across pages', async () => {
    const payload = Buffer.from(
      Array.from({ length: 4000 }, (_, i) => `row ${String(i)}\n`).join(''),
      'utf8'
    );
    const ref = putOutput(payload, 'utf8') as string;

    const drained = await drain(ref, MIN_FETCH_BYTES);
    expect(drained.equals(payload)).toBe(true);

    const first = await call({ output_ref: ref, max_bytes: MIN_FETCH_BYTES });
    expect(first.total_bytes).toBe(payload.length);
    expect(drained.length).toBe(first.total_bytes);
  });

  it('measures base64 pages in bytes, not in characters (AC-O2a)', async () => {
    // A base64 chunk is about 4/3 the length of what it encodes, so a test
    // that compared string lengths would pass on utf8 and fail here.
    const payload = Buffer.alloc(9000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    const ref = putOutput(payload, 'base64') as string;

    const first = await call({ output_ref: ref, max_bytes: MIN_FETCH_BYTES });
    expect(first.encoding).toBe('base64');
    expect(first.chunk.length).toBeGreaterThan(MIN_FETCH_BYTES);
    expect(Buffer.from(first.chunk, 'base64')).toHaveLength(MIN_FETCH_BYTES);

    const drained = await drain(ref, MIN_FETCH_BYTES);
    expect(drained.equals(payload)).toBe(true);
    expect(drained.length).toBe(first.total_bytes);
  });

  it('total_bytes is the masked length, not the wire length', async () => {
    // The plan calls this out because the two numbers share a name: the meta's
    // `total_bytes` counts wire bytes and this one counts what was stored.
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'A'.repeat(2048),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const payload = Buffer.from(`before\n${pem}\nafter\n`, 'utf8');
    const ref = putOutput(payload, 'utf8') as string;

    const body = await call({ output_ref: ref });
    expect(body.total_bytes).toBeLessThan(payload.length);
    expect(body.chunk).toContain(REDACTED_PEM);
    expect(body.chunk).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
  });
});

describe('the chunk is neither truncated nor redacted again (AC-O7)', () => {
  it('returns far more than the 2 KiB response field ceiling', async () => {
    const payload = Buffer.from('n'.repeat(40 * 1024), 'utf8');
    const ref = putOutput(payload, 'utf8') as string;

    const body = await call({ output_ref: ref });
    expect(Buffer.byteLength(body.chunk, 'utf8')).toBe(payload.length);
    expect(Buffer.byteLength(body.chunk, 'utf8')).toBeGreaterThan(MAX_LOG_FIELD_BYTES);
    expect(body.chunk).not.toContain('[truncated]');
  });

  it('leaves text that merely looks sensitive alone', async () => {
    // `redact()` masks by key name, and the chunk is a value, not a record —
    // running the generic pass over it would mask output the command printed.
    const payload = Buffer.from('password=hunter2\ntoken=abc123\n', 'utf8');
    const ref = putOutput(payload, 'utf8') as string;

    const body = await call({ output_ref: ref });
    expect(body.chunk).toBe('password=hunter2\ntoken=abc123\n');
    expect(body.chunk).not.toContain(REDACTED);
  });
});

describe('lifetime (AC-O4)', () => {
  it('reports an unknown reference as output_expired', async () => {
    await expect(
      fetchOutputTool.handler({ output_ref: 'never-issued' }, ctx, newAuditDraft())
    ).rejects.toMatchObject({ code: ERROR_CODES.output_expired });
  });

  it('reports a reference lost to a restart as output_expired', async () => {
    const ref = putOutput(Buffer.from('payload'), 'utf8') as string;
    resetOutputStore();
    await expect(
      fetchOutputTool.handler({ output_ref: ref }, ctx, newAuditDraft())
    ).rejects.toMatchObject({ code: ERROR_CODES.output_expired });
  });
});
