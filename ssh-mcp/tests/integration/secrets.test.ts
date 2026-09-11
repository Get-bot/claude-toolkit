/**
 * Nothing secret reaches a log, a response or the audit file (AC19).
 *
 * The whole flow runs for real: `setup` authenticates with a sentinel password
 * and writes a private key, then all seven tools run against the host it
 * registered, including a two-step approval. Afterwards the three sinks that a
 * person or a model can actually read — every tool response, every stderr line,
 * `audit.jsonl` — are searched for the sentinel, for PEM key material and for
 * the raw confirmation token.
 *
 * The token is the one deliberate exception: its whole purpose is to be handed
 * to the model in the `confirmation_required` body, so it is asserted to appear
 * there exactly once and nowhere else (AC19.3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditFilePath, privateKeyPath } from '../../src/config/paths.js';
import { ERROR_CODES } from '../../src/errors.js';
import { createPrompter } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';
import { runSetup } from '../../src/setup/cli.js';
import { clearTokens } from '../../src/safety/tokens.js';
import { closeAll } from '../../src/ssh/pool.js';
import { resetSessions } from '../../src/ssh/session.js';
import { startEndpoint, type TestEndpoint } from '../fixtures/endpoints.js';
import { startMcpTestClient, type McpTestClient } from '../fixtures/mcpClient.js';
import { assertNoWritesOutside, createTmpHome, type TmpHome } from '../fixtures/tmpHome.js';

/** AC19.1. */
const SENTINEL_PASSWORD = 'P@ssw0rd-SENTINEL-9f3a';
/** AC19.2. */
const PEM_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';

const ALIAS = 'secrets';
const DESTRUCTIVE = 'rm -rf /tmp/ssh-mcp-secrets-absent && echo DESTRUCTIVE_OK';

let endpoint: TestEndpoint;
let home: TmpHome;
let stderrText: string;
let harness: McpTestClient | null = null;

/** A prompter that pretends to be a terminal and replays `answers` in order. */
function scripted(answers: readonly string[]): { prompter: Prompter; output: () => string } {
  const input = new PassThrough();
  const fake = input as unknown as { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  fake.setRawMode = (): void => undefined;
  fake.isTTY = true;

  let written = '';
  const prompter = createPrompter({
    input: input as never,
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    isTTY: true,
  });
  input.write(answers.map((answer) => `${answer}\n`).join(''));
  return { prompter, output: () => written };
}

beforeAll(async () => {
  endpoint = await startEndpoint({ password: SENTINEL_PASSWORD });
});

afterAll(async () => {
  await endpoint.close();
});

beforeEach(() => {
  home = createTmpHome('ssh-mcp-secrets-');
  stderrText = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrText += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
});

afterEach(async () => {
  if (harness !== null) await harness.close();
  harness = null;
  resetSessions();
  closeAll();
  clearTokens();
  vi.restoreAllMocks();
  assertNoWritesOutside(home);
  home.cleanup();
});

describe('AC19: no secret reaches a log, a response or the audit file', () => {
  it('keeps the password, the key and the token out of every sink', async () => {
    const target = `${endpoint.user}@${endpoint.host}:${String(endpoint.port)}`;
    const script = scripted([SENTINEL_PASSWORD, 'yes', 'token']);
    expect(await runSetup([ALIAS, target], { prompter: script.prompter })).toBe(0);

    // The private key really exists and really is PEM, so the assertions below
    // are about masking rather than about there being nothing to mask.
    const keyText = fs.readFileSync(privateKeyPath(ALIAS), 'utf8');
    expect(keyText.startsWith(PEM_HEADER)).toBe(true);

    const responses: string[] = [];
    const record = (text: string): void => {
      responses.push(text);
    };

    harness = await startMcpTestClient({ elicitation: 'none' });
    const local = path.join(endpoint.homeDir, 'secrets-local.txt');
    fs.writeFileSync(local, 'secret-free payload\n', 'utf8');
    const remote = `${endpoint.homeDir.replace(/\\/g, '/')}/secrets-remote.txt`;
    const back = path.join(endpoint.homeDir, 'secrets-back.txt');

    record((await harness.callTool('list_hosts')).text);
    record((await harness.callTool('exec', { host: ALIAS, command: 'echo SAFE' })).text);
    record(
      (
        await harness.callTool('upload', {
          host: ALIAS,
          local_path: local,
          remote_path: remote,
        })
      ).text
    );
    record(
      (
        await harness.callTool('download', {
          host: ALIAS,
          remote_path: remote,
          local_path: back,
        })
      ).text
    );

    const opened = await harness.callTool('open_session', { host: ALIAS });
    record(opened.text);
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = opened.body.session_id as string;
    record(
      (await harness.callTool('run_in_session', { session_id: sessionId, command: 'pwd' })).text
    );
    record((await harness.callTool('close_session', { session_id: sessionId })).text);

    // Error paths carry details, which is exactly where a leak would hide.
    record((await harness.callTool('exec', { host: 'no-such-host', command: 'echo X' })).text);
    record(
      (await harness.callTool('download', { host: ALIAS, remote_path: remote, local_path: back }))
        .text
    );

    // Two-step approval: the only place a raw token may appear.
    const issued = await harness.callTool('exec', { host: ALIAS, command: DESTRUCTIVE });
    expect(issued.body.status).toBe('confirmation_required');
    const token = issued.body.confirmation_token;
    expect(token).toBeTypeOf('string');
    const rawToken = token as string;
    record(issued.text);

    const executed = await harness.callTool('exec', {
      host: ALIAS,
      command: DESTRUCTIVE,
      confirmation_token: rawToken,
    });
    expect(executed.isError, executed.text).toBe(false);
    record(executed.text);

    const audit = fs.readFileSync(auditFilePath(), 'utf8');
    const allResponses = responses.join('\n');

    // AC19.1 / AC19.2 across all three sinks.
    for (const [label, haystack] of [
      ['tool responses', allResponses],
      ['stderr', stderrText],
      ['audit.jsonl', audit],
    ] as const) {
      expect(haystack, `${label} contains the sentinel password`).not.toContain(SENTINEL_PASSWORD);
      expect(haystack, `${label} contains PEM key material`).not.toContain(PEM_HEADER);
      expect(haystack, `${label} contains the private key path`).not.toContain(
        keyText.slice(60, 120)
      );
    }
    expect(script.output()).not.toContain(SENTINEL_PASSWORD);

    // AC19.3 / AC19.4: the token exists in exactly one response and nowhere else.
    expect(responses.filter((text) => text.includes(rawToken))).toHaveLength(1);
    expect(stderrText).not.toContain(rawToken);
    expect(audit).not.toContain(rawToken);
    // The log keeps only a hash prefix, which is not the token itself.
    expect(stderrText).toContain('confirmation_hash8');
  });

  it('does not echo key material when the key cannot authenticate', async () => {
    const target = `${endpoint.user}@${endpoint.host}:${String(endpoint.port)}`;
    expect(
      await runSetup([ALIAS, target], {
        prompter: scripted([SENTINEL_PASSWORD, 'yes', 'token']).prompter,
      })
    ).toBe(0);

    // Replace the authorised key so authentication fails with a real PEM on
    // disk: the failure path is where an error message might quote it.
    fs.writeFileSync(path.join(endpoint.homeDir, '.ssh', 'authorized_keys'), '', 'utf8');
    closeAll();

    harness = await startMcpTestClient({ elicitation: 'none' });
    const result = await harness.callTool('exec', { host: ALIAS, command: 'echo X' });

    expect(result.isError).toBe(true);
    expect([ERROR_CODES.auth_failed, ERROR_CODES.connection_failed]).toContain(result.body.error);
    expect(result.text).not.toContain(PEM_HEADER);
    expect(stderrText).not.toContain(PEM_HEADER);
    expect(fs.readFileSync(auditFilePath(), 'utf8')).not.toContain(PEM_HEADER);
  });
});
