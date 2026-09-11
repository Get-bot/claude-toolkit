import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_LOG_FIELD_BYTES,
  REDACTED,
  REDACTED_PEM,
  TRUNCATION_SUFFIX,
  captureProcessStdout,
  installStdoutGuard,
  isProcessStdoutCaptured,
  isStdoutGuardInstalled,
  logger,
  maskPemBlocks,
  protocolStdoutStream,
  redact,
  setLogLevel,
  truncateField,
  truncateUtf8,
  uninstallStdoutGuard,
} from '../../src/log.js';

const SENTINEL = 'P@ssw0rd-SENTINEL-9f3a';

const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'c2gtZWQyNTUxOQAAACBSENTINELKEYMATERIALAAAAAAAAAAAAAAAAAAAAAAAAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

afterEach(() => {
  setLogLevel(null);
  uninstallStdoutGuard();
  vi.restoreAllMocks();
});

describe('sensitive keys', () => {
  it.each([
    'password',
    'Password',
    'PASSWORD',
    'pass',
    'userPass',
    'passphrase',
    'secret',
    'clientSecret',
    'token',
    'confirmation_token',
    'privateKey',
    'private_key',
    'privatekey',
  ])('masks the value under %s', (key) => {
    const out = asRecord(redact({ [key]: SENTINEL }));
    expect(out[key]).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('masks a sensitive key whose value is an object', () => {
    const out = asRecord(redact({ token: { raw: SENTINEL, nested: { deep: SENTINEL } } }));
    expect(out.token).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('leaves non-sensitive keys alone', () => {
    const out = asRecord(redact({ host: 'web01', port: 22, ok: true, missing: null }));
    expect(out).toEqual({ host: 'web01', port: 22, ok: true, missing: null });
  });

  it('masks sensitive keys nested in arrays and objects', () => {
    const out = asRecord(
      redact({ hosts: [{ alias: 'a', password: SENTINEL }], meta: { apiToken: SENTINEL } })
    );
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(JSON.stringify(out)).toContain('"alias":"a"');
  });

  it('masks sensitive keys in a Map', () => {
    const out = asRecord(redact(new Map([['password', SENTINEL]])));
    expect(out.password).toBe(REDACTED);
  });
});

describe('PEM private key blocks (AC19.2)', () => {
  it('replaces a complete block', () => {
    const masked = maskPemBlocks(`before ${PEM} after`);
    expect(masked).toBe(`before ${REDACTED_PEM} after`);
    expect(masked).not.toContain('-----BEGIN');
  });

  it('replaces a block whose END marker is missing', () => {
    const truncatedPem = PEM.split('\n').slice(0, 2).join('\n');
    const masked = maskPemBlocks(`log line: ${truncatedPem}`);
    expect(masked).not.toContain('-----BEGIN');
    expect(masked).toContain(REDACTED_PEM);
  });

  it.each([
    '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----',
  ])('replaces %s', (block) => {
    expect(maskPemBlocks(block)).not.toContain('-----BEGIN');
  });

  it('replaces two blocks in one string', () => {
    expect(maskPemBlocks(`${PEM}\n${PEM}`)).not.toContain('-----BEGIN');
  });

  it('reaches PEM material inside nested values', () => {
    const out = redact({ steps: [{ stderr: `oops ${PEM}` }] });
    expect(JSON.stringify(out)).not.toContain('-----BEGIN');
  });

  it('leaves a non-key PEM-looking banner untouched', () => {
    const text = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    expect(maskPemBlocks(text)).toBe(text);
  });
});

describe('2 KiB field truncation', () => {
  it('cuts a long string to the ceiling, suffix included', () => {
    const long = 'a'.repeat(MAX_LOG_FIELD_BYTES * 2);
    const out = asRecord(redact({ stdout: long }));
    const value = out.stdout;
    expect(typeof value).toBe('string');
    const text = value as string;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_LOG_FIELD_BYTES);
    expect(text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('leaves a string at exactly the ceiling untouched', () => {
    const exact = 'a'.repeat(MAX_LOG_FIELD_BYTES);
    expect(asRecord(redact({ s: exact })).s).toBe(exact);
  });

  it('truncates strings inside arrays and nested objects', () => {
    const long = 'b'.repeat(5000);
    const out = asRecord(redact({ list: [long], nested: { deep: long } }));
    const list = out.list as string[];
    expect(Buffer.byteLength(list[0] ?? '', 'utf8')).toBeLessThanOrEqual(MAX_LOG_FIELD_BYTES);
    const nested = asRecord(out.nested);
    expect(Buffer.byteLength(nested.deep as string, 'utf8')).toBeLessThanOrEqual(
      MAX_LOG_FIELD_BYTES
    );
  });

  it('honours an explicit ceiling', () => {
    const out = asRecord(redact({ s: 'c'.repeat(100) }, { maxStringBytes: 40 }));
    expect(Buffer.byteLength(out.s as string, 'utf8')).toBeLessThanOrEqual(40);
  });

  it('disables truncation when maxStringBytes is null', () => {
    const long = 'd'.repeat(5000);
    expect(asRecord(redact({ s: long }, { maxStringBytes: null })).s).toBe(long);
  });

  it('never splits a multi-byte character', () => {
    // Three-byte characters: cutting at 10 bytes must land on a boundary.
    const value = '한'.repeat(10);
    const cut = truncateUtf8(value, 10);
    expect(Buffer.byteLength(cut, 'utf8')).toBe(9);
    expect(cut).toBe('한'.repeat(3));
    expect(cut).not.toContain('�');
  });

  it('degrades to a bare suffix when the budget is tiny', () => {
    expect(truncateField('x'.repeat(100), 5).length).toBeLessThanOrEqual(5);
  });
});

describe('structural safety', () => {
  it('survives a circular reference', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const out = asRecord(redact(node));
    expect(out.name).toBe('root');
    expect(out.self).toBe('[circular]');
  });

  it('summarises binary buffers instead of dumping them', () => {
    const out = asRecord(redact({ blob: Buffer.from([0, 1, 2, 3]) }));
    expect(out.blob).toBe('[binary 4 bytes]');
  });

  it('flattens an Error and masks PEM material in its message', () => {
    const out = asRecord(redact({ err: new Error(`bad key ${PEM}`) }));
    const err = asRecord(out.err);
    expect(err.name).toBe('Error');
    expect(String(err.message)).not.toContain('-----BEGIN');
  });

  it('stops at the depth limit rather than recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[depth-exceeded]');
  });

  it('passes primitives through', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('logger output', () => {
  function captureStderr(): { lines: string[] } {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { lines };
  }

  it('writes one redacted JSON line per record to stderr', () => {
    setLogLevel('debug');
    const captured = captureStderr();
    logger.warn('host setup failed', { host: 'web01', password: SENTINEL, key: PEM });
    expect(captured.lines).toHaveLength(1);
    const line = captured.lines[0] ?? '';
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(line).not.toContain(SENTINEL);
    expect(line).not.toContain('-----BEGIN');
    const record = asRecord(JSON.parse(line));
    expect(record.level).toBe('warn');
    expect(record.msg).toBe('host setup failed');
    expect(record.host).toBe('web01');
    expect(typeof record.ts).toBe('string');
  });

  it('drops records below the configured level', () => {
    setLogLevel('warn');
    const captured = captureStderr();
    logger.info('noise');
    logger.debug('more noise');
    logger.error('kept');
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0] ?? '').toContain('"level":"error"');
  });

  it('reads SSH_MCP_LOG_LEVEL and falls back to info', () => {
    const previous = process.env.SSH_MCP_LOG_LEVEL;
    try {
      setLogLevel(null);
      process.env.SSH_MCP_LOG_LEVEL = 'debug';
      const captured = captureStderr();
      logger.debug('visible');
      expect(captured.lines).toHaveLength(1);

      vi.restoreAllMocks();
      process.env.SSH_MCP_LOG_LEVEL = 'not-a-level';
      const fallback = captureStderr();
      logger.debug('hidden');
      logger.info('shown');
      expect(fallback.lines).toHaveLength(1);
      expect(fallback.lines[0] ?? '').toContain('"level":"info"');
    } finally {
      if (previous === undefined) delete process.env.SSH_MCP_LOG_LEVEL;
      else process.env.SSH_MCP_LOG_LEVEL = previous;
    }
  });

  it('masks PEM material in the message itself', () => {
    setLogLevel('info');
    const captured = captureStderr();
    logger.info(`loaded ${PEM}`);
    expect(captured.lines[0] ?? '').not.toContain('-----BEGIN');
  });
});

describe('installStdoutGuard (AC2.3, F19)', () => {
  function spyStreams(): {
    stdout: ReturnType<typeof vi.spyOn>;
    stderr: ReturnType<typeof vi.spyOn>;
  } {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    return { stdout, stderr };
  }

  it('keeps console.log/info/debug/dir off stdout and is reversible', () => {
    const { stdout, stderr } = spyStreams();
    const before = globalThis.console;

    installStdoutGuard();
    expect(isStdoutGuardInstalled()).toBe(true);
    console.log('a');
    console.info('b');
    console.debug('c');
    console.dir({ d: 1 });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.length).toBeGreaterThanOrEqual(4);

    uninstallStdoutGuard();
    expect(isStdoutGuardInstalled()).toBe(false);
    expect(globalThis.console).toBe(before);
  });

  // F19: these all write to stdout in Node and would corrupt the JSON-RPC
  // channel. Rebinding individual methods missed them; replacing the whole
  // Console instance closes the class.
  it.each([
    ['table', (): void => console.table([{ a: 1 }])],
    ['group', (): void => console.group('g')],
    ['groupCollapsed', (): void => console.groupCollapsed('g')],
    ['groupEnd', (): void => console.groupEnd()],
    ['count', (): void => console.count('c')],
    ['countReset', (): void => console.countReset('c')],
    [
      'timeEnd',
      (): void => {
        console.time('t');
        console.timeEnd('t');
      },
    ],
    [
      'timeLog',
      (): void => {
        console.time('t2');
        console.timeLog('t2');
        console.timeEnd('t2');
      },
    ],
  ])('console.%s never reaches stdout while the guard is installed', (_name, call) => {
    const { stdout } = spyStreams();
    installStdoutGuard();
    call();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('writes nothing to stdout for any console method in one pass', () => {
    const { stdout, stderr } = spyStreams();
    installStdoutGuard();
    console.log('l');
    console.info('i');
    console.debug('d');
    console.dir({ x: 1 });
    console.table([{ a: 1 }]);
    console.group('g');
    console.groupCollapsed('gc');
    console.groupEnd();
    console.count('c');
    console.countReset('c');
    console.time('t');
    console.timeLog('t');
    console.timeEnd('t');
    console.warn('w');
    console.error('e');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.length).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    installStdoutGuard();
    installStdoutGuard();
    uninstallStdoutGuard();
    expect(isStdoutGuardInstalled()).toBe(false);
  });

  it('leaves process.stdout.write alone unless capture is opted into', () => {
    installStdoutGuard();
    expect(isProcessStdoutCaptured()).toBe(false);
    const { stdout } = spyStreams();
    // The JSON-RPC transport writes frames this way; it must still reach stdout.
    process.stdout.write('{"jsonrpc":"2.0"}\n');
    expect(stdout).toHaveBeenCalled();
  });
});

describe('captureProcessStdout (opt-in) and protocolStdoutStream', () => {
  it('redirects direct stdout writes but keeps the protocol stream working', async () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    installStdoutGuard();
    // Capture the real writer first, exactly as server.ts must.
    const protocol = protocolStdoutStream();
    captureProcessStdout();
    expect(isProcessStdoutCaptured()).toBe(true);

    // Stray output is diverted...
    process.stdout.write('stray banner\n');
    expect(stdoutWrites).toHaveLength(0);
    expect(stderrWrites.join('')).toContain('stray banner');

    // ...while JSON-RPC frames still reach stdout.
    await new Promise<void>((resolve, reject) => {
      protocol.write('{"jsonrpc":"2.0","id":1}\n', (err) => (err ? reject(err) : resolve()));
    });
    expect(stdoutWrites.join('')).toContain('"jsonrpc":"2.0"');

    uninstallStdoutGuard();
    expect(isProcessStdoutCaptured()).toBe(false);
    expect(realStdoutWrite).toBeTypeOf('function');
  });

  it('is a no-op without the guard installed', () => {
    captureProcessStdout();
    expect(isProcessStdoutCaptured()).toBe(false);
  });
});
