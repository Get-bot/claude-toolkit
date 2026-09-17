/**
 * `parsed` / `parse_error` in the tool response (plan rows E8, E8b, E9;
 * AC-J1, AC-J6, AC-J6a, AC-J6b, AC-J7, AC-J7a).
 *
 * These drive `commandResultBody()` directly rather than through a live
 * connection, because what is under test is the response assembly: which of the
 * two fields appear, what redaction they get, and which of the several size
 * ceilings applies. The retained buffer is the input, so the tests can be exact
 * about bytes without a server in the loop.
 */
import { describe, expect, it } from 'vitest';

import { MAX_MAX_OUTPUT_BYTES, MIN_MAX_OUTPUT_BYTES } from '../../src/config/schema.js';
import { REDACTED, REDACTED_PEM } from '../../src/log.js';
import { emitCapFor, parseCapFor, retainCapFor } from '../../src/output/limits.js';
import { PS_COLUMNS } from '../../src/output/tables.js';
import { resolveCommand } from '../../src/output/resolve.js';
import { commandResultBody } from '../../src/tools/gated.js';
import type { ExcerptMeta, Retention } from '../../src/ssh/excerpt.js';

const HOST_MAX_OUTPUT_BYTES = 1024 * 1024;

function meta(totalBytes: number): ExcerptMeta {
  return {
    // Deliberately not truncated: `withOutputRef` would otherwise put the
    // buffer in the output store, which is a different feature's side effect.
    truncated: false,
    encoding: 'utf8',
    total_bytes: totalBytes,
    total_lines: 1,
    head_bytes: totalBytes,
    head_lines: 1,
    tail_bytes: 0,
    tail_lines: 0,
    omitted_lines: 0,
    omitted_bytes: 0,
    returned_bytes: totalBytes,
    ceiling_hit: false,
    output_ref: null,
  };
}

/** Run one command's result through the assembler and read the body back. */
function body(
  command: string,
  format: 'text' | 'json',
  stdout: string,
  options: { retention?: Retention; maxOutputBytes?: number } = {}
): Record<string, unknown> {
  const retention: Retention = options.retention ?? {
    kind: 'kept',
    bytes: Buffer.from(stdout, 'utf8'),
  };
  const result = commandResultBody({
    host: 'web01',
    sessionId: null,
    stdout,
    stderr: '',
    stdout_meta: meta(Buffer.byteLength(stdout, 'utf8')),
    stderr_meta: meta(0),
    exit_code: 0,
    signal: null,
    encoding: 'utf8',
    duration_ms: 12,
    background_job: false,
    coverage: null,
    stdout_retention: retention,
    stderr_retention: { kind: 'not_requested' },
    resolved: resolveCommand(command, format),
    maxOutputBytes: options.maxOutputBytes ?? HOST_MAX_OUTPUT_BYTES,
  });
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('AC-J1: format "text" adds no fields', () => {
  it('omits parsed and parse_error entirely, rather than nulling them', () => {
    const out = body('docker ps', 'text', 'CONTAINER ID   IMAGE\n');
    // Absent, not null: `parsed: null` would tell the model parsing was tried.
    expect('parsed' in out).toBe(false);
    expect('parse_error' in out).toBe(false);
  });

  it('still returns the ordinary fields', () => {
    const out = body('docker ps', 'text', 'hello\n');
    expect(out.stdout).toBe('hello\n');
    expect(out.exit_code).toBe(0);
  });

  it('returns exactly the 0.2.1 key set, no more and no fewer', () => {
    // `'parsed' in out === false` only denies two names. AC-J1 is a claim about
    // the *whole* response, so a third field added to `body` for some later
    // feature would slip past a negative check and change the bytes a 0.2.1
    // client sees. Listing the keys is the only assertion that notices.
    const out = body('docker ps', 'text', 'hello\n');
    expect(Object.keys(out).sort()).toEqual(
      [
        'background_job',
        'duration_ms',
        'encoding',
        'exit_code',
        'host',
        'signal',
        'stderr',
        'stderr_meta',
        'stdout',
        'stdout_meta',
      ].sort()
    );
  });

  it('adds only the conditional fields their own conditions ask for', () => {
    // The optional members of the key set above, so a reader can see that the
    // list is exact rather than merely long: session id when there is one, the
    // background warning when the command backgrounded itself.
    const out = commandResultBody({
      host: 'web01',
      sessionId: 'sess-1',
      stdout: '',
      stderr: '',
      stdout_meta: meta(0),
      stderr_meta: meta(0),
      exit_code: 0,
      signal: null,
      encoding: 'utf8',
      duration_ms: 1,
      background_job: true,
      coverage: null,
      stdout_retention: { kind: 'not_requested' },
      stderr_retention: { kind: 'not_requested' },
      resolved: resolveCommand('sleep 1 &', 'text'),
      maxOutputBytes: HOST_MAX_OUTPUT_BYTES,
    });
    const keys = Object.keys(JSON.parse(out.content[0]?.text ?? '{}') as Record<string, unknown>);
    expect(keys).toContain('session_id');
    expect(keys).toContain('background_warning');
    expect(keys).not.toContain('parsed');
    expect(keys).not.toContain('parse_error');
  });
});

describe('AC-J6: format "json" parses stdout', () => {
  it('returns the parsed value and a null parse_error', () => {
    const out = body('docker ps', 'json', '{"Names":"web","State":"running"}\n');
    expect(out.parsed).toEqual({ Names: 'web', State: 'running' });
    expect(out.parse_error).toBeNull();
  });

  it('reports invalid_json when the tool printed text after all', () => {
    // An older docker without `--format json`, or a table entry that matched
    // more eagerly than the remote supports.
    const out = body('docker ps', 'json', 'CONTAINER ID   IMAGE\n');
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('invalid_json');
  });

  it('reports not_rewritable for a pipeline, having run the original', () => {
    const out = body('docker ps | head -n 2', 'json', 'CONTAINER ID\n');
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('not_rewritable');
  });
});

describe('AC-J4: a table command goes to its fixed-column parser', () => {
  const PS_STDOUT = [
    '  PID  PPID USER     STAT   VSZ   RSS COMMAND',
    '    1     0 root     S     1234   567 /sbin/init splash',
    '   42     1 alice    R     2345   678 node /srv/app.js --port 8080',
    '',
  ].join('\n');

  it('parses ps output into rows rather than JSON', () => {
    const out = body('ps aux', 'json', PS_STDOUT);
    expect(out.parse_error).toBeNull();
    const parsed = out.parsed as { processes: { pid: string; command: string }[] };
    expect(parsed.processes).toHaveLength(2);
    expect(parsed.processes[0]?.pid).toBe('1');
    // The command column keeps its spaces; every other column is one token.
    expect(parsed.processes[1]?.command).toBe('node /srv/app.js --port 8080');
  });

  it('carries the parser own reason when the header is not the normalised one', () => {
    // `ps` output from a command that was never rewritten cannot be split by
    // column names that do not match it — the guard that keeps the parser from
    // inventing fields.
    const out = body('ps aux', 'json', 'USER PID %CPU %MEM COMMAND\nroot 1 0.0 0.1 init\n');
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('header_unrecognized');
  });

  it('parses the columns the rewrite actually asks for', () => {
    // Guards the same two-module contract as tests/unit/jsonCommands.test.ts,
    // one layer up: the header above is built from PS_COLUMNS.
    expect(PS_COLUMNS.split(',')).toEqual(['pid', 'ppid', 'user', 'stat', 'vsz', 'rss', 'args']);
  });
});

describe('AC-J7 / AC-J7a: parser input size', () => {
  it('reports too_large when stdout is over the parse cap', () => {
    const cap = parseCapFor(MIN_MAX_OUTPUT_BYTES);
    const oversized = Buffer.alloc(cap + 1, 0x20);
    const out = body('docker ps', 'json', 'ignored', {
      retention: { kind: 'kept', bytes: oversized },
      maxOutputBytes: MIN_MAX_OUTPUT_BYTES,
    });
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('too_large');
  });

  it('reports too_large when retention was dropped for size', () => {
    // `dropped` means the stream outgrew `retainCapFor`, and the invariant
    // below makes that imply it is over the parse cap as well — so this is the
    // same answer, not a stand-in for missing data.
    const out = body('docker ps', 'json', 'ignored', { retention: { kind: 'dropped' } });
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('too_large');
  });

  it('does not call a stream nobody kept too_large (F1)', () => {
    // The whole reason `Retention` has three states. While it was
    // `Buffer | null` this case was indistinguishable from `dropped`, so a
    // seven-byte stdout would have come back as `too_large` — confident,
    // plausible and wrong. Unreachable today; the point is that it stays wrong
    // out loud if a future caller stops asking for retention.
    const out = body('docker ps', 'json', '{"a":1}', {
      retention: { kind: 'not_requested' },
    });
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('output_not_retained');
  });

  it('keeps retainCapFor at or above parseCapFor for every input, not just legal ones', () => {
    // The `dropped` case's reasoning depends on this and nothing else enforces
    // it: the two caps live in one file but are computed from different
    // constants, and raising the parse cap alone would silently turn a correct
    // answer into a wrong one.
    //
    // The inequality holds for *all* m, not merely the values the schema
    // admits: `min(4m, 16 MiB) >= min(4m, 4 MiB)` because 16 MiB > 4 MiB. So
    // the range below is a sample of a property that does not depend on the
    // range, and the values outside it are checked precisely because a later
    // schema change must not be what makes this true.
    for (let m = MIN_MAX_OUTPUT_BYTES; m <= MAX_MAX_OUTPUT_BYTES; m += 4096) {
      expect(retainCapFor(m)).toBeGreaterThanOrEqual(parseCapFor(m));
    }
    for (const m of [0, 1, MAX_MAX_OUTPUT_BYTES, MAX_MAX_OUTPUT_BYTES * 16, 2 ** 40]) {
      expect(retainCapFor(m)).toBeGreaterThanOrEqual(parseCapFor(m));
    }
  });

  it('parses right up to the cap', () => {
    const payload = JSON.stringify({ ok: true });
    const out = body('docker ps', 'json', payload, { maxOutputBytes: MIN_MAX_OUTPUT_BYTES });
    expect(out.parsed).toEqual({ ok: true });
  });
});

describe('AC-J6b: response size ceiling', () => {
  it('drops parsed with parsed_too_large rather than shipping it', () => {
    // The payload has to sit strictly between the two ceilings, or the input
    // check would fire first and this would be testing AC-J7 by accident:
    // emitCapFor(1 KiB) = 2 KiB and parseCapFor(1 KiB) = 4 KiB.
    const emitCap = emitCapFor(MIN_MAX_OUTPUT_BYTES);
    const parseCap = parseCapFor(MIN_MAX_OUTPUT_BYTES);
    const rows = Array.from({ length: 70 }, (_, i) => ({ id: i, name: 'x'.repeat(20) }));
    const payload = JSON.stringify(rows);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(emitCap);
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(parseCap);

    const out = body('docker ps', 'json', payload, { maxOutputBytes: MIN_MAX_OUTPUT_BYTES });
    expect(out.parsed).toBeNull();
    expect(out.parse_error).toBe('parsed_too_large');
  });

  it('keeps a payload under the ceiling', () => {
    const out = body('docker ps', 'json', JSON.stringify([{ id: 1 }]), {
      maxOutputBytes: MIN_MAX_OUTPUT_BYTES,
    });
    expect(out.parsed).toEqual([{ id: 1 }]);
    expect(out.parse_error).toBeNull();
  });
});

describe('AC-J6a: parsed gets redactParsed, not the default redact', () => {
  it('does not cut a long string at 2 KiB', () => {
    // The default `redact()` cuts every string to 2 KiB and appends a marker,
    // which would turn a real field value into corrupted data.
    const long = 'a'.repeat(5000);
    const out = body('docker inspect x', 'json', JSON.stringify({ Config: { Cmd: long } }), {});
    const parsed = out.parsed as { Config: { Cmd: string } };
    expect(parsed.Config.Cmd).toHaveLength(5000);
    expect(parsed.Config.Cmd).not.toContain('[truncated]');
  });

  it('keeps nesting far deeper than a log record would', () => {
    // `docker inspect` is genuinely deep; the default ceiling of 8 would
    // replace real content with `[depth-exceeded]`.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const out = body('docker inspect x', 'json', JSON.stringify(deep));
    let cursor = out.parsed as Record<string, unknown>;
    for (let i = 0; i < 20; i += 1) cursor = cursor.nested as Record<string, unknown>;
    expect(cursor).toBe('leaf');
  });

  it('still masks sensitive keys and PEM blocks', () => {
    // The parts that make redaction a security control are not relaxed.
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
    const out = body(
      'docker inspect x',
      'json',
      JSON.stringify({ password: 'hunter2', note: pem, token: 'abc' })
    );
    const parsed = out.parsed as Record<string, string>;
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.note).toBe(REDACTED_PEM);
  });
});
