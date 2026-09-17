/**
 * Command output survives the tool boundary intact (finding F17, AC12).
 *
 * The §5.8 excerpter bounds output on the way in, but the response body used
 * to go through the 2 KiB per-string log ceiling on the way out, which threw
 * the excerpt away at the last possible step: a 1 MiB read came back as 2048
 * bytes with no indication that anything had been cut. These tests hold the
 * boundary, for both `exec` and `run_in_session` (AC12.7).
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureKeysDir } from '../../src/config/paths.js';
import { MAX_LOG_FIELD_BYTES } from '../../src/log.js';
import { OMISSION_MARKER_PATTERN } from '../../src/ssh/excerpt.js';
import { closeAll } from '../../src/ssh/pool.js';
import { resetSessions } from '../../src/ssh/session.js';
import { authorizeKey, hostEntryFor, startEndpoint } from '../fixtures/endpoints.js';
import type { TestEndpoint } from '../fixtures/endpoints.js';
import { generateClientKey } from '../fixtures/hostKeys.js';
import { startMcpTestClient, writeRegistry, type McpTestClient } from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

/** 500 lines of 99 characters plus a newline: 50 000 bytes exactly. */
const LINES = 500;
const LINE_BYTES = 100;
const TOTAL_BYTES = LINES * LINE_BYTES;
const BIG_OUTPUT_COMMAND = `awk 'BEGIN{s=sprintf("%${String(LINE_BYTES - 1)}s",""); gsub(/ /,"x",s); for(i=0;i<${String(LINES)};i++) print s}'`;

/** Small enough that 50 000 bytes must be excerpted, large enough to be legal. */
const SMALL_CAP = 4096;

/**
 * 100 lines of 100 bytes: over `SMALL_CAP` so the excerpter cuts it, and under
 * `retainCapFor(SMALL_CAP)` = 16 KiB so the whole stream is also retained. That
 * gap between the two caps is what AC-O1 and AC-O4a sit either side of.
 */
const RETAINED_LINES = 100;
const RETAINED_BYTES = RETAINED_LINES * LINE_BYTES;
const RETAINED_OUTPUT_COMMAND = `awk 'BEGIN{s=sprintf("%${String(LINE_BYTES - 1)}s",""); gsub(/ /,"x",s); for(i=0;i<${String(RETAINED_LINES)};i++) print s}'`;

let home: TmpHome;
let endpoint: TestEndpoint;
let harness: McpTestClient;

function meta(body: Record<string, unknown>): Record<string, unknown> {
  return body.stdout_meta as Record<string, unknown>;
}

/** Page a reference to exhaustion and return the bytes, as a caller would. */
async function fetchAll(ref: string, maxBytes?: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let cursor: number | null = 0;
  let guard = 0;
  while (cursor !== null) {
    const page = await harness.callTool('fetch_output', {
      output_ref: ref,
      cursor,
      ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
    });
    expect(page.isError, page.text).toBe(false);
    expect(page.body.offset).toBe(cursor);
    parts.push(Buffer.from(page.body.chunk as string, page.body.encoding as BufferEncoding));
    cursor = page.body.next_cursor as number | null;
    guard += 1;
    expect(guard).toBeLessThan(500);
  }
  return Buffer.concat(parts);
}

/** Files directly under the sandbox home, for the "memory only" assertion. */
function homeEntries(): string[] {
  return fs.readdirSync(home.dir).sort();
}

beforeAll(async () => {
  home = createTmpHome('ssh-mcp-output-');
  endpoint = await startEndpoint();
  const clientKey = generateClientKey();
  authorizeKey(endpoint, clientKey.publicKey);
  const keyPath = path.join(ensureKeysDir(), 'fixture');
  fs.writeFileSync(keyPath, clientKey.privateKey, { encoding: 'utf8', mode: 0o600 });

  writeRegistry({
    roomy: hostEntryFor(endpoint, { alias: 'roomy', privateKeyPath: keyPath }),
    tight: hostEntryFor(endpoint, {
      alias: 'tight',
      privateKeyPath: keyPath,
      maxOutputBytes: SMALL_CAP,
    }),
  });

  harness = await startMcpTestClient({ elicitation: 'none' });
});

afterAll(async () => {
  await harness.close();
  resetSessions();
  closeAll();
  await endpoint.close();
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('output below the host cap comes back whole (F17)', () => {
  it('returns all 50 000 bytes from exec, not 2 KiB', async () => {
    const result = await harness.callTool('exec', {
      host: 'roomy',
      command: BIG_OUTPUT_COMMAND,
    });

    expect(result.isError, result.text).toBe(false);
    const stdout = result.body.stdout as string;
    expect(Buffer.byteLength(stdout, 'utf8')).toBe(TOTAL_BYTES);
    expect(stdout.split('\n').filter((line) => line !== '')).toHaveLength(LINES);
    expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(MAX_LOG_FIELD_BYTES);
    expect(meta(result.body).truncated).toBe(false);
    expect(meta(result.body).total_bytes).toBe(TOTAL_BYTES);
    expect(stdout).not.toContain('[truncated]');
  });

  it('returns the same through run_in_session (AC12.7)', async () => {
    const opened = await harness.callTool('open_session', { host: 'roomy' });
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = opened.body.session_id as string;

    try {
      const result = await harness.callTool('run_in_session', {
        session_id: sessionId,
        command: BIG_OUTPUT_COMMAND,
      });

      expect(result.isError, result.text).toBe(false);
      const stdout = result.body.stdout as string;
      expect(Buffer.byteLength(stdout, 'utf8')).toBe(TOTAL_BYTES);
      expect(meta(result.body).truncated).toBe(false);

      // The session still works after a large read.
      const after = await harness.callTool('run_in_session', {
        session_id: sessionId,
        command: 'echo STILL_ALIVE',
      });
      expect(after.body.stdout).toBe('STILL_ALIVE\n');
    } finally {
      await harness.callTool('close_session', { session_id: sessionId });
    }
  });
});

describe('lifting the length cap does not lift the masking (AC19.2)', () => {
  it('still masks a private key that a command prints', async () => {
    const secret = path.join(endpoint.remoteHomeDir, 'leaked-key.pem');
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
      'c2gtZWQyNTUxOQAAACBGFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    fs.writeFileSync(secret, `${pem}\n`, 'utf8');

    const result = await harness.callTool('exec', {
      host: 'roomy',
      command: `cat ${secret.replace(/\\/g, '/')}`,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(result.body.stdout).toContain('[redacted-private-key]');
  });
});

describe('output above the host cap keeps the §5.8 shape (AC12)', () => {
  it('returns head, an omission marker and tail rather than a 2 KiB stub', async () => {
    const result = await harness.callTool('exec', {
      host: 'tight',
      command: BIG_OUTPUT_COMMAND,
    });

    expect(result.isError, result.text).toBe(false);
    const stdout = result.body.stdout as string;
    const lines = stdout.split('\n').filter((line) => line !== '');

    // The first and last source lines are both present: the middle was dropped,
    // not the tail (AC12.1).
    expect(lines[0]).toBe('x'.repeat(LINE_BYTES - 1));
    expect(lines[lines.length - 1]).toBe('x'.repeat(LINE_BYTES - 1));

    const markers = lines.filter((line) => OMISSION_MARKER_PATTERN.test(line));
    expect(markers).toHaveLength(1);

    expect(meta(result.body).truncated).toBe(true);
    expect(meta(result.body).total_bytes).toBe(TOTAL_BYTES);
    expect(meta(result.body).omitted_lines).toBeGreaterThan(0);

    // The excerpt is bounded by the host cap, not by the log field ceiling.
    const returned = Buffer.byteLength(stdout, 'utf8');
    expect(returned).toBeGreaterThan(MAX_LOG_FIELD_BYTES);
    expect(returned).toBeLessThan(TOTAL_BYTES);
  });
});

describe('truncated output can be fetched back whole (AC-O1, AC-O2, AC-O2a)', () => {
  it('mints a reference and pages the whole stream back in order', async () => {
    const result = await harness.callTool('exec', {
      host: 'tight',
      command: RETAINED_OUTPUT_COMMAND,
    });

    expect(result.isError, result.text).toBe(false);
    expect(meta(result.body).truncated).toBe(true);
    const ref = meta(result.body).output_ref;
    expect(typeof ref).toBe('string');

    // Every chunk decoded and concatenated is exactly `total_bytes` (AC-O2a),
    // and it is the command's output byte for byte — including the middle the
    // excerpt dropped.
    const fetched = await fetchAll(ref as string, 1024);
    const first = await harness.callTool('fetch_output', { output_ref: ref, max_bytes: 1024 });
    expect(fetched).toHaveLength(first.body.total_bytes as number);
    expect(fetched).toHaveLength(RETAINED_BYTES);

    const lines = fetched
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(RETAINED_LINES);
    for (const line of lines) expect(line).toBe('x'.repeat(LINE_BYTES - 1));
    // The excerpt in the response really was shorter than what was retained.
    expect(Buffer.byteLength(result.body.stdout as string, 'utf8')).toBeLessThan(RETAINED_BYTES);
  });

  it('leaves output_ref null when nothing was cut (AC-O1)', async () => {
    const result = await harness.callTool('exec', { host: 'roomy', command: 'echo small' });
    expect(result.isError, result.text).toBe(false);
    expect(meta(result.body).truncated).toBe(false);
    expect(meta(result.body).output_ref).toBeNull();
    expect((result.body.stderr_meta as Record<string, unknown>).output_ref).toBeNull();
  });

  it('gives run_in_session the same treatment (AC18)', async () => {
    const opened = await harness.callTool('open_session', { host: 'tight' });
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = opened.body.session_id as string;

    try {
      const result = await harness.callTool('run_in_session', {
        session_id: sessionId,
        command: RETAINED_OUTPUT_COMMAND,
      });
      expect(result.isError, result.text).toBe(false);
      expect(meta(result.body).truncated).toBe(true);
      const fetched = await fetchAll(meta(result.body).output_ref as string);
      expect(fetched).toHaveLength(RETAINED_BYTES);
    } finally {
      await harness.callTool('close_session', { session_id: sessionId });
    }
  });
});

describe('what is not retained (AC-O1b, AC-O4a)', () => {
  it('retains nothing beyond four times the host cap (AC-O4a)', async () => {
    // 50 000 bytes against a 4 KiB cap: truncated, but far past the 16 KiB
    // retention budget, so there is nothing to fetch and the tool says so by
    // leaving the reference null rather than by handing back a partial stream.
    const result = await harness.callTool('exec', { host: 'tight', command: BIG_OUTPUT_COMMAND });
    expect(result.isError, result.text).toBe(false);
    expect(meta(result.body).truncated).toBe(true);
    expect(meta(result.body).output_ref).toBeNull();
  });

  it('retains nothing on the timeout path (AC-O1b)', async () => {
    const result = await harness.callTool('exec', {
      host: 'tight',
      command: `${RETAINED_OUTPUT_COMMAND}; sleep 30`,
      timeout_sec: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.body.error).toBe('command_timeout');
    // The partial output is reported; the reference is not, because the
    // timeout path never reaches `commandResultBody()`.
    expect((result.body.stdout_meta as Record<string, unknown>).output_ref).toBeNull();
    expect((result.body.stderr_meta as Record<string, unknown>).output_ref).toBeNull();
  });
});

describe('retention is memory only (AC-O3)', () => {
  it('writes no new file under SSH_MCP_HOME', async () => {
    const before = homeEntries();
    const result = await harness.callTool('exec', {
      host: 'tight',
      command: RETAINED_OUTPUT_COMMAND,
    });
    expect(typeof meta(result.body).output_ref).toBe('string');
    await fetchAll(meta(result.body).output_ref as string);

    // `audit.jsonl` already exists by now; the point is that nothing *new*
    // appeared, and in particular nothing holding the retained bytes.
    expect(homeEntries()).toEqual(before);
    const audit = fs.readFileSync(path.join(home.dir, 'audit.jsonl'), 'utf8');
    expect(audit).not.toContain(meta(result.body).output_ref as string);
  });
});

describe('fetched pages carry the same masking as the response (AC-O7)', () => {
  it('masks a private key the command printed', async () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      // Long enough that the 4 KiB host cap cuts it, so the stream is both
      // excerpted and retained — which is the only state where a fetched page
      // could leak key material in the first place.
      ...Array.from(
        { length: 100 },
        () => 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz'
      ),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const secret = path.join(endpoint.remoteHomeDir, 'fetchable-key.pem');
    fs.writeFileSync(secret, `${pem}\n`, 'utf8');

    const result = await harness.callTool('exec', {
      host: 'tight',
      command: `cat ${secret.replace(/\\/g, '/')}`,
    });

    expect(result.isError, result.text).toBe(false);
    expect(meta(result.body).truncated).toBe(true);
    const ref = meta(result.body).output_ref;
    expect(typeof ref).toBe('string');

    const fetched = (await fetchAll(ref as string, 1024)).toString('utf8');
    expect(fetched).toContain('[redacted-private-key]');
    expect(fetched).not.toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(fetched).not.toContain('b3BlbnNzaC1rZXktdjEA');
  });
});

describe('closing a session does not discard its output (AC-O8, D10)', () => {
  it('keeps the retained stream fetchable after close_session', async () => {
    const opened = await harness.callTool('open_session', { host: 'tight' });
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = opened.body.session_id as string;

    const result = await harness.callTool('run_in_session', {
      session_id: sessionId,
      command: RETAINED_OUTPUT_COMMAND,
    });
    expect(result.isError, result.text).toBe(false);
    const ref = meta(result.body).output_ref as string;
    expect(typeof ref).toBe('string');

    const closed = await harness.callTool('close_session', { session_id: sessionId });
    expect(closed.isError, closed.text).toBe(false);

    // Lifetime is the store's TTL and nothing else: a session ending is not a
    // reason to throw away output the caller may still be reading.
    const fetched = await fetchAll(ref);
    expect(fetched).toHaveLength(RETAINED_BYTES);
  });
});
