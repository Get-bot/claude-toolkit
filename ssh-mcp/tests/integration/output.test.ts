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

let home: TmpHome;
let endpoint: TestEndpoint;
let harness: McpTestClient;

function meta(body: Record<string, unknown>): Record<string, unknown> {
  return body.stdout_meta as Record<string, unknown>;
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
