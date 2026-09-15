/**
 * The `ssh-mcp host` command group (`src/host/`).
 *
 * The rule that matters most here is the one that is easiest to break by
 * accident: **`ssh-mcp setup` must keep behaving exactly as it did.** An 0.1.0
 * user upgrades automatically through `npx -y`, so the alias is pinned against
 * the new name character for character rather than merely "working".
 *
 * `host list` gets the same treatment the `list_hosts` tool does: it must never
 * print a private key path or a full fingerprint, and a broken registry must be
 * reported rather than guessed at. Those are assertions, not comments.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { homePath, hostsFilePath, keysDirPath } from '../../src/config/paths.js';
import { runHost } from '../../src/host/cli.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, renderTable, runHostList } from '../../src/host/list.js';
import type { HostRow } from '../../src/host/list.js';
import { runSetup } from '../../src/setup/cli.js';
import type { Prompter } from '../../src/setup/prompt.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-host-');
});

afterEach(() => {
  assertNoWritesOutside(home);
  home.cleanup();
});

interface Capture {
  out: string[];
  err: string[];
  outText(): string;
  errText(): string;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    outText: (): string => out.join('\n'),
    errText: (): string => err.join('\n'),
  };
}

const FINGERPRINT = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';

function writeHosts(hosts: Record<string, unknown>): void {
  fs.mkdirSync(homePath(), { recursive: true });
  fs.writeFileSync(hostsFilePath(), JSON.stringify({ schemaVersion: 1, hosts }, null, 2), 'utf8');
}

function hostEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: 'web01.example.com',
    port: 22,
    user: 'deploy',
    privateKeyPath: '/home/me/.ssh-mcp/keys/web01',
    hostKey: { algo: 'ssh-ed25519', sha256: FINGERPRINT },
    approvalMode: 'ask-destructive',
    approvalFallback: 'fail-closed',
    auditMode: 'full',
    patternOverrides: { destructive: { add: [], remove: [] }, privileged: { add: [], remove: [] } },
    defaultTimeoutSec: 60,
    maxOutputBytes: 1048576,
    createdAt: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('host group routing', () => {
  it('prints the group usage and exits 2 when no sub-command is given', async () => {
    const io = capture();
    const code = await runHost([], { err: (text) => io.err.push(text) });
    expect(code).toBe(EXIT_USAGE);
    expect(io.errText()).toContain('Usage: ssh-mcp host <add|list>');
    expect(io.errText()).toContain('add');
    expect(io.errText()).toContain('list');
  });

  it('names the alias in the group usage, so `setup` users are not stranded', async () => {
    const io = capture();
    await runHost([], { err: (text) => io.err.push(text) });
    expect(io.errText()).toContain('`ssh-mcp setup`은 `ssh-mcp host add`의 별칭');
  });

  it('rejects an unknown sub-command with exit 2', async () => {
    const io = capture();
    const code = await runHost(['remove'], { err: (text) => io.err.push(text) });
    expect(code).toBe(EXIT_USAGE);
    expect(io.errText()).toContain('unknown sub-command "remove"');
  });

  /**
   * Help that was asked for is not an error. `host list --help` already splits
   * it this way, so the group help doing the opposite meant `ssh-mcp host
   * --help > help.txt` produced an empty file.
   */
  it('sends asked-for group help to stdout and exits 0', async () => {
    const io = capture();
    const code = await runHost(['--help'], {
      err: (text) => io.err.push(text),
      out: (text) => io.out.push(text),
    });
    expect(code).toBe(EXIT_OK);
    expect(io.outText()).toContain('Usage: ssh-mcp host');
    expect(io.errText()).toBe('');
  });

  it('keeps the no-sub-command usage error on stderr', async () => {
    const io = capture();
    const code = await runHost([], {
      err: (text) => io.err.push(text),
      out: (text) => io.out.push(text),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(io.errText()).toContain('Usage: ssh-mcp host');
    expect(io.outText()).toBe('');
  });
});

describe('`setup` is an alias of `host add`', () => {
  /**
   * Both paths write help to stdout (`out`), so capture it the same way. The
   * prompter is stubbed silent: it is the wizard's stderr, and `--help` must
   * not touch it.
   */
  async function helpOf(run: (out: (text: string) => void) => Promise<number>): Promise<string> {
    const lines: string[] = [];
    const code = await run((text) => lines.push(text));
    expect(code).toBe(EXIT_OK);
    return lines.join('');
  }

  const silentPrompter = { write: (): void => undefined, interactive: false } as never;

  it('produces byte-identical help for both spellings', async () => {
    const viaHost = await helpOf((out) =>
      runHost(['add', '--help'], { out, prompter: silentPrompter })
    );
    const viaSetup = await helpOf((out) => runSetup(['--help'], { out, prompter: silentPrompter }));
    expect(viaHost).toBe(viaSetup);
    expect(viaHost).toContain('Usage: ssh-mcp host add');
    expect(viaHost).toContain('`ssh-mcp setup`은 이 명령의 별칭으로 계속 동작합니다.');
  });

  it('gives both spellings the same non-interactive refusal', async () => {
    const hostLines: string[] = [];
    const hostCode = await runHost(['add'], {
      prompter: { write: (t: string) => hostLines.push(t), interactive: false } as never,
      canAsk: () => false,
    });
    const setupLines: string[] = [];
    const setupCode = await runSetup([], {
      prompter: { write: (t: string) => setupLines.push(t), interactive: false } as never,
      canAsk: () => false,
    });
    expect(hostCode).toBe(setupCode);
    expect(hostLines.join('')).toBe(setupLines.join(''));
  });
});

/** A terminal for the steps that need one; the password must never be reached. */
function interactivePrompter(lines: string[]): Prompter {
  return {
    interactive: true,
    write: (text: string) => lines.push(text),
    writeLine: (text = '') => lines.push(`${text}\n`),
    readLine: () => Promise.reject(new Error('the password must never be asked for')),
    close: () => undefined,
  } as unknown as Prompter;
}

/**
 * The wizard draws a list on stderr and reads keys from stdin, so a terminal
 * that cannot do both gets the usage error rather than a stalled screen. A
 * fully specified `host add` must keep working there: the password and
 * fingerprint prompts ask for stdin alone.
 */
describe('the wizard only runs where a question can be drawn', () => {
  it('gives the usage error instead of a wizard when the list cannot be drawn', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: {
        write: (text: string) => lines.push(text),
        interactive: true,
      } as never,
      canAsk: () => false,
      ask: {
        select: () => Promise.reject(new Error('nothing may be asked here')),
        text: () => Promise.reject(new Error('nothing may be asked here')),
      },
    });
    expect(code).toBe(2);
    expect(lines.join('')).toContain('Usage: ssh-mcp host add');
    // `host add 2>&1 | tee setup.log` is a terminal with a redirected stderr:
    // the wizard cannot draw, and without this line it just vanishes.
    expect(lines.join('')).toContain('이 터미널에는 목록을 그릴 수 없습니다');
    expect(lines.join('')).toContain('인자를 모두 지정하면 질문 없이 실행됩니다.');
  });

  it('does not blame the terminal when the arguments were simply wrong', async () => {
    // One positional is a typo, not a request to be asked, so the "cannot draw"
    // explanation would be a non-sequitur here.
    const lines: string[] = [];
    const code = await runSetup(['web01'], {
      prompter: {
        write: (text: string) => lines.push(text),
        interactive: true,
      } as never,
      canAsk: () => false,
    });
    expect(code).toBe(2);
    expect(lines.join('')).not.toContain('이 터미널에는 목록을 그릴 수 없습니다');
  });

  it('still runs a fully specified host add there', async () => {
    const probed: string[] = [];
    const code = await runSetup(['web01', 'deploy@example.com'], {
      prompter: interactivePrompter([]),
      canAsk: () => false,
      probeTcp: (host, port) => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve({ ok: false, code: 'ETIMEDOUT', reason: '응답이 없습니다' });
      },
    });
    // It got as far as the address check, which is all this needs to show.
    expect(probed).toEqual(['example.com:22']);
    expect(code).toBe(1);
  });
});

/**
 * Reported from Windows: `host add wefjwef test@11-2.213123` took the password,
 * hardened the ACL and generated a key pair before failing with
 * `getaddrinfo ENOTFOUND`. The address is checked first now.
 */
describe('host add checks the address before anything expensive', () => {
  it('stops at connection_failed without prompting or writing a key', async () => {
    const lines: string[] = [];
    const probed: string[] = [];
    const code = await runSetup(['web01', 'deploy@11-2.213123'], {
      prompter: interactivePrompter(lines),
      probeTcp: (host, port) => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve({
          ok: false,
          code: 'ENOTFOUND',
          reason: '호스트 이름을 찾을 수 없습니다',
        });
      },
    });
    expect(code).toBe(1);
    expect(probed).toEqual(['11-2.213123:22']);
    const text = lines.join('');
    expect(text).toContain('connection_failed');
    expect(text).toContain('호스트 이름을 찾을 수 없습니다');
    expect(text).toContain('아무것도 기록하지 않았습니다');
    // The password prompt would have rejected; reaching it is the regression.
    expect(text).not.toContain('비밀번호');
    // And no key pair was left behind.
    expect(fs.existsSync(keysDirPath())).toBe(false);
  });

  it('honours the port from the target', async () => {
    const probed: string[] = [];
    await runSetup(['web01', 'deploy@example.com:2222'], {
      prompter: interactivePrompter([]),
      probeTcp: (host, port) => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve({ ok: false, code: 'ETIMEDOUT', reason: '응답이 없습니다' });
      },
    });
    expect(probed).toEqual(['example.com:2222']);
  });
});

describe('host list', () => {
  it('says the registry is empty and still exits 0', async () => {
    const io = capture();
    const code = await runHost(['list'], {
      out: (text) => io.out.push(text),
      err: (text) => io.err.push(text),
    });
    expect(code).toBe(EXIT_OK);
    expect(io.outText()).toContain('등록된 호스트가 없습니다');
    expect(io.outText()).toContain('ssh-mcp host add');
  });

  it('prints a table without the key path or the full fingerprint', () => {
    writeHosts({ web01: hostEntry({ label: '운영 웹' }) });
    const io = capture();
    const code = runHostList([], { out: (text) => io.out.push(text) });
    expect(code).toBe(EXIT_OK);
    const table = io.outText();
    expect(table).toContain('web01');
    expect(table).toContain('deploy@web01.example.com:22');
    expect(table).toContain('ask-destructive');
    expect(table).toContain('fail-closed');
    expect(table).toContain('운영 웹');
    // The two things that must never reach a listing.
    expect(table).not.toContain('/home/me/.ssh-mcp/keys/web01');
    expect(table).not.toContain(FINGERPRINT);
    // A prefix is enough to recognise a host you pinned.
    expect(table).toContain('SHA256:47DEQpj8HBSa+/T');
  });

  it('marks a missing approvalFallback rather than pretending it was chosen', () => {
    const entry = hostEntry();
    delete entry['approvalFallback'];
    writeHosts({ web01: entry });
    const io = capture();
    expect(runHostList([], { out: (text) => io.out.push(text) })).toBe(EXIT_OK);
    expect(io.outText()).toContain('fail-closed(누락)');
  });

  // Documented as a contract: a script can parse the output without first
  // checking whether anything is registered. The prose for an empty registry
  // belongs to the table only, and must never reach stdout beside the JSON.
  it('emits an empty envelope for --json rather than the empty-list prose', () => {
    const io = capture();
    const code = runHostList(['--json'], {
      out: (text) => io.out.push(text),
      err: (text) => io.err.push(text),
    });
    expect(code).toBe(EXIT_OK);

    const payload = JSON.parse(io.outText()) as Record<string, unknown>;
    expect(payload).toEqual({ hosts: [], count: 0 });
    expect(Object.keys(payload).sort()).toEqual(['count', 'hosts']);
    expect(io.outText()).not.toContain('등록된 호스트가 없습니다');
    expect(io.errText()).toBe('');
  });

  it('emits the same field names as the list_hosts tool for --json', () => {
    writeHosts({ web01: hostEntry({ label: '운영 웹' }) });
    const io = capture();
    expect(runHostList(['--json'], { out: (text) => io.out.push(text) })).toBe(EXIT_OK);
    const payload = JSON.parse(io.outText()) as {
      count: number;
      hosts: Record<string, unknown>[];
    };
    expect(payload.count).toBe(1);
    expect(Object.keys(payload.hosts[0] ?? {}).sort()).toEqual([
      'alias',
      'approval_fallback',
      'approval_mode',
      'audit_mode',
      'host_key_fingerprint_prefix',
      'hostname',
      'label',
      'port',
      'user',
    ]);
    expect(JSON.stringify(payload)).not.toContain('privateKeyPath');
    expect(JSON.stringify(payload)).not.toContain(FINGERPRINT);
  });

  // `host add` refuses control characters in a label, but a file written by an
  // older build or by hand can still hold one, and this table goes to a
  // terminal. The last line of defence is at the point of printing.
  it('replaces control characters stored in a label', () => {
    writeHosts({ web01: hostEntry({ label: 'red\x1b[31mred' }) });
    const io = capture();
    expect(runHostList([], { out: (text) => io.out.push(text) })).toBe(EXIT_OK);
    expect(io.outText()).not.toContain('\x1b');
    expect(io.outText()).toContain('red?[31mred');
  });

  it('sends asked-for help to stdout and a usage error to stderr', () => {
    const help = capture();
    expect(
      runHostList(['--help'], {
        out: (text) => help.out.push(text),
        err: (text) => help.err.push(text),
      })
    ).toBe(EXIT_OK);
    expect(help.outText()).toContain('Usage: ssh-mcp host list');
    expect(help.errText()).toBe('');
  });

  it('reports a broken registry as config_invalid and exits 1', () => {
    fs.mkdirSync(homePath(), { recursive: true });
    fs.writeFileSync(hostsFilePath(), '{ "hosts": ', 'utf8');
    const io = capture();
    const code = runHostList([], {
      out: (text) => io.out.push(text),
      err: (text) => io.err.push(text),
    });
    expect(code).toBe(EXIT_FAILED);
    expect(io.errText()).toContain('config_invalid');
    expect(io.outText()).toBe('');
  });

  it('exits 2 for an unknown option and 0 for --help', () => {
    const bad = capture();
    expect(runHostList(['--all'], { err: (text) => bad.err.push(text) })).toBe(EXIT_USAGE);
    expect(bad.errText()).toContain('unknown option: --all');

    const help = capture();
    expect(runHostList(['--help'], { out: (text) => help.out.push(text) })).toBe(EXIT_OK);
    expect(help.outText()).toContain('Usage: ssh-mcp host list');
  });
});

describe('renderTable', () => {
  function row(overrides: Partial<HostRow> = {}): HostRow {
    return {
      alias: 'web01',
      target: 'deploy@web01.example.com:22',
      approvalMode: 'ask-destructive',
      approvalFallback: 'fail-closed',
      fingerprint: 'SHA256:47DEQpj8HBSa+/T',
      label: '',
      ...overrides,
    };
  }

  /** The separator line is always the second line: header, separator, rows. */
  function separatorLabelSegment(rows: readonly HostRow[]): string {
    const separator = renderTable(rows).split('\n')[1] ?? '';
    return separator.split('  ').pop() ?? '';
  }

  // Every other column's underline tracks that column's own computed width.
  // Before this fix the label column's was pinned to `'-'.repeat(4)` — the
  // display width of the header "라벨" — so a longer label ran past the end
  // of its underline instead of being covered by it.
  it('draws the label separator as long as the longest label, not a fixed 4', () => {
    const longLabel = 'a'.repeat(20);
    const segment = separatorLabelSegment([row({ label: longLabel })]);
    expect(segment.length).toBe(longLabel.length);
    expect(segment.length).toBeGreaterThan(4);
  });

  // Same fix, CJK spelling: a Hangul label must widen the separator by two
  // display cells per character, the same convention `displayWidth` already
  // applies to every other column.
  it('widens the label separator by two cells per Hangul character', () => {
    const label = '아주긴라벨이름입니다'; // 10 syllables
    const segment = separatorLabelSegment([row({ label })]);
    expect(segment.length).toBe(label.length * 2);
  });
});
