/**
 * How `ssh-mcp host add` reports a question it could not ask.
 *
 * Three different reasons land in the same place and must read differently,
 * because the reader's next action differs for each: the terminal cannot draw a
 * list, the prompt library will not load on this Node, or the user pressed
 * Ctrl-C. Collapsing any two of them into one sentence sends somebody looking
 * for the wrong problem — which is exactly what happened when the library's
 * load failure surfaced nested inside "입력 중 오류가 발생했습니다 (…)".
 *
 * Everything here stops before the password, so no test needs a terminal or a
 * network. The tmp home is the usual guard: nothing may touch the real
 * `~/.ssh-mcp`.
 *
 * The second half of the file is about `--from-ssh-config` and the two flags it
 * brought with it (`--alias`, `--port`). What is being pinned there is an
 * **order**, because the whole feature is one argv line assembled in three
 * pieces — ssh_config seed, what the user typed, what the wizard answered — and
 * the parser's last-wins behaviour is what turns that order into a precedence
 * rule (OP-4, ADR-013). Get the order wrong and the failure is silent: a host
 * registered against a different machine than the one the person confirmed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PromptUnavailableError } from '../../src/setup/ask.js';
import type { Asker, SelectQuestion, TextQuestion } from '../../src/setup/ask.js';
import { parseSetupArgs, runSetup } from '../../src/setup/cli.js';
import { PromptAbortedError } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-setupcli-');
});

afterEach(() => {
  assertNoWritesOutside(home);
  home.cleanup();
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

/** An asker whose every question fails the same way. */
function failingAsker(error: () => Error): Asker {
  return {
    select: () => Promise.reject(error()),
    text: () => Promise.reject(error()),
  };
}

describe('host add --help', () => {
  it('goes to stdout, not to the wizard stream', async () => {
    // Every other line this command prints is a prompt or progress and rides
    // stderr with the wizard. Help that was asked for is not an error, and on
    // stderr it vanished from `host add --help | less` — exit 0, empty pipe.
    const wizardStream: string[] = [];
    const out: string[] = [];
    const code = await runSetup(['--help'], {
      prompter: interactivePrompter(wizardStream),
      out: (text: string): void => void out.push(text),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Usage: ssh-mcp host add');
    expect(wizardStream.join('')).not.toContain('Usage:');
  });
});

describe('host add reports an unaskable question for what it is', () => {
  it('gives the library failure on its own, not nested in a generic sentence', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new PromptUnavailableError(new Error('Cannot find package'))),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('대화형 질문을 불러오지 못했습니다');
    // The Node version is the actionable part; it must not be buried inside a
    // parenthesis appended to a sentence about "an error while reading input".
    expect(text).toContain('Node 20.17 이상');
    expect(text).not.toContain('입력 중 오류가 발생했습니다');
  });

  it('still reports Ctrl-C as an abort, which is not a failure to load anything', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new PromptAbortedError('interrupted', 'prompt interrupted (Ctrl-C)')),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('입력이 중단되었습니다');
    expect(text).not.toContain('대화형 질문을 불러오지 못했습니다');
  });

  it('keeps the generic sentence for anything it does not recognise', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new Error('something else entirely')),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('입력 중 오류가 발생했습니다');
    expect(text).toContain('something else entirely');
  });
});

/** Write `~/.ssh/config` inside the sandbox; `HOME` already points there. */
function writeSshConfig(text: string): void {
  const dir = path.join(home.dir, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config'), text, 'utf8');
}

const WEB01_CONFIG = [
  'Host web01',
  '  HostName web01.internal',
  '  Port 2022',
  '  User deploy',
].join('\n');

/** One question the wizard put, reduced to what these tests care about. */
interface Asked {
  kind: 'select' | 'text';
  message: string;
  default?: string;
}

interface Run {
  code: number;
  /** Everything `host add` wrote to its stderr stream, joined. */
  text: string;
  asked: Asked[];
  /** The default offered for the question whose message contains `needle`. */
  defaultFor(needle: string): string | undefined;
}

/**
 * Drive `host add` as far as the password, which is where every one of these
 * cases stops.
 *
 * The observable is the "설정을 시작합니다" line: `runSetup` prints it straight
 * after the final parse, so it carries the resolved alias, user, host and port
 * — exactly the four values the precedence rule decides — and it appears before
 * anything reaches the network.
 *
 * `answers` is consumed in question order; `''` means pressing Enter, which
 * takes whatever default was offered.
 */
async function run(
  argv: readonly string[],
  options: { answers?: readonly string[]; canAsk?: boolean } = {}
): Promise<Run> {
  const lines: string[] = [];
  const asked: Asked[] = [];
  const answers = [...(options.answers ?? [])];

  const next = (fallback: string | undefined): string => {
    if (answers.length === 0) throw new PromptAbortedError('eof', 'the script ran out of answers');
    const raw = answers.shift() ?? '';
    return raw === '' && fallback !== undefined ? fallback : raw;
  };

  const ask: Asker = {
    select<T extends string>(question: SelectQuestion<T>): Promise<T> {
      asked.push({
        kind: 'select',
        message: question.message,
        ...(question.default === undefined ? {} : { default: question.default }),
      });
      const value = next(question.default);
      const match = question.choices.find((choice) => choice.value === value);
      if (match === undefined) throw new Error(`not a choice: ${value}`);
      return Promise.resolve(match.value);
    },
    text(question: TextQuestion): Promise<string> {
      asked.push({
        kind: 'text',
        message: question.message,
        ...(question.default === undefined ? {} : { default: question.default }),
      });
      const value = next(question.default);
      const verdict = question.validate?.(value) ?? true;
      // These tests answer with values the wizard accepts, so a rejection is a
      // defect in the test or in the default that was offered, not a retry.
      if (verdict !== true) throw new Error(`rejected ${JSON.stringify(value)}: ${verdict}`);
      return Promise.resolve(value);
    },
  };

  const code = await runSetup([...argv], {
    prompter: interactivePrompter(lines),
    canAsk: () => options.canAsk ?? true,
    ask,
    probeTcp: () => Promise.resolve({ ok: true, code: '', reason: '' }),
  });

  return {
    code,
    text: lines.join(''),
    asked,
    defaultFor: (needle: string): string | undefined =>
      asked.find((entry) => entry.message.includes(needle))?.default,
  };
}

describe('--alias and --port parse and validate like the positionals (AC-S1a)', () => {
  it('lets --alias stand in for the first positional', () => {
    const parsed = parseSetupArgs(['--alias', 'prod', 'deploy@web01']);
    expect(parsed.ok && !parsed.help && parsed.args).toMatchObject({
      alias: 'prod',
      user: 'deploy',
      hostname: 'web01',
      port: 22,
    });
  });

  it('runs --alias through the same AliasSchema the positional uses', () => {
    for (const bad of ['.leading', 'has space', 'a'.repeat(65), '한글']) {
      const parsed = parseSetupArgs(['--alias', bad, 'deploy@web01']);
      expect(parsed.ok).toBe(false);
      // Named as a bad alias, not resurfaced as "needs both <alias> and …".
      expect(parsed.ok === false && parsed.message).toContain('invalid alias');
    }
  });

  it('refuses a flag name in --alias or --port, like every other value-taking flag', () => {
    // `optionValue` gets there first, so a leading hyphen is reported as a
    // swallowed flag rather than as a bad alias. That is the right order: the
    // user typed two flags and neither was applied.
    for (const argv of [
      ['--alias', '--force'],
      ['--port', '--force'],
    ]) {
      const parsed = parseSetupArgs(argv);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.message).toMatch(/needs a value, but got the option/u);
    }
  });

  it.each(['0', '65536', '99999', 'abc'])('refuses --port %j', (value) => {
    const parsed = parseSetupArgs(['prod', 'deploy@web01', '--port', value]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('--port');
  });

  it('fills the port the target left unsaid, and never overrides one it named', () => {
    const filled = parseSetupArgs(['prod', 'deploy@web01', '--port', '2222']);
    expect(filled.ok && !filled.help && filled.args.port).toBe(2222);

    // The target naming a port is what makes a wizard-confirmed answer final:
    // the wizard always emits `user@host:port` (AC-S5).
    const named = parseSetupArgs(['prod', 'deploy@web01:2200', '--port', '2222']);
    expect(named.ok && !named.help && named.args.port).toBe(2200);
  });

  it('takes the last spelling of a repeated flag, which is what makes the seed lose', () => {
    const parsed = parseSetupArgs(['--alias', 'seeded', '--alias', 'typed', 'deploy@web01']);
    expect(parsed.ok && !parsed.help && parsed.args.alias).toBe('typed');

    const port = parseSetupArgs(['--port', '2022', '--port', '2222', 'prod', 'deploy@web01']);
    expect(port.ok && !port.help && port.args.port).toBe(2222);
  });

  it('keeps flags out of the positional count, and out of `given`', () => {
    // The ssh_config seed is exactly this shape. It must still read as "no
    // positionals" so the wizard opens, and it must not mark any question
    // answered — `given` carries only what the user typed (AC-S5, ADR-013).
    const parsed = parseSetupArgs(['--alias', 'web01', '--port', '2022']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.missingPositionals).toBe(true);
    expect(parsed.ok === false && parsed.given).toEqual({
      approvalMode: false,
      label: false,
      force: false,
    });
    expect(parsed.ok === false && parsed.partial).toEqual({
      fromSshConfig: null,
      alias: 'web01',
      port: 2022,
    });
  });

  it('still calls a lone positional a typo when no --alias supplied the other half', () => {
    const parsed = parseSetupArgs(['prod']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.missingPositionals).toBeUndefined();
  });
});

describe('an alias may not be a command name (AC-C6, F11)', () => {
  it.each(['install', 'host', 'doctor', 'setup', 'connect', 'exec', 'help', 'version'])(
    'refuses %j',
    (reserved) => {
      const parsed = parseSetupArgs([reserved, 'deploy@web01']);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.message).toContain('reserved');
    }
  );

  it('refuses it through --alias as well, not only as a positional', () => {
    const parsed = parseSetupArgs(['--alias', 'doctor', 'deploy@web01']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('reserved');
  });

  it('leaves an alias that merely starts with a command name alone', () => {
    const parsed = parseSetupArgs(['host-01', 'deploy@web01']);
    expect(parsed.ok && !parsed.help && parsed.args.alias).toBe('host-01');
  });
});

describe('--from-ssh-config: no positionals, in a terminal (OP-4 row 1)', () => {
  it('offers every imported value as a default and asks every question anyway', async () => {
    writeSshConfig(WEB01_CONFIG);
    // Enter six times: the point is that six questions are still there to press
    // Enter on. A seed that reached `given` would skip them, and the
    // confirmation step AC-S5 requires would not exist.
    const result = await run(['--from-ssh-config', 'web01'], {
      answers: ['', '', '', '', '', ''],
    });

    expect(result.asked.map((entry) => entry.kind)).toEqual([
      'text',
      'text',
      'text',
      'text',
      'select',
      'text',
    ]);
    expect(result.defaultFor('호스트 주소')).toBe('web01.internal');
    expect(result.defaultFor('사용자명')).toBe('deploy');
    expect(result.defaultFor('SSH 포트')).toBe('2022');
    expect(result.defaultFor('alias')).toBe('web01');
    expect(result.text).toContain('호스트 "web01" 설정을 시작합니다: deploy@web01.internal:2022');
  });

  it('says where the values came from, and that no existing key is reused (AC-S4)', async () => {
    writeSshConfig([WEB01_CONFIG, '  IdentityFile ~/.ssh/id_ed25519'].join('\n'));
    const result = await run(['--from-ssh-config', 'web01'], {
      answers: ['', '', '', '', '', ''],
    });
    expect(result.text).toContain('ssh_config의 "web01" 항목에서 읽은 값을 미리 채웠습니다');
    expect(result.text).toContain('IdentityFile·IdentityAgent는 무시합니다');
    expect(result.text).toContain('전용 키를 새로 만듭니다');
  });

  it('lets a flag the user typed beat the file (AC-S6)', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['--from-ssh-config', 'web01', '--alias', 'mine', '--port', '2222'], {
      answers: ['', '', '', '', '', ''],
    });
    // The seed leads the argv line and the typed flags follow it, so last-wins
    // resolves this before the wizard ever sees a default.
    expect(result.defaultFor('SSH 포트')).toBe('2222');
    expect(result.defaultFor('alias')).toBe('mine');
    expect(result.text).toContain('호스트 "mine" 설정을 시작합니다: deploy@web01.internal:2222');
  });

  it('lets the confirmed answer beat both (AC-S5)', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['--from-ssh-config', 'web01', '--alias', 'mine', '--port', '2222'], {
      // host, user, port, alias, mode, label
      answers: ['other.example.com', 'root', '2200', 'confirmed', '', ''],
    });
    expect(result.text).toContain(
      '호스트 "confirmed" 설정을 시작합니다: root@other.example.com:2200'
    );
    expect(result.text).not.toContain('web01.internal');
  });

  it('asks the address again from scratch when the imported one does not answer', async () => {
    // The address default is spent on the first question: offering a value the
    // reachability probe just rejected makes Enter the obvious move and fails
    // the same way.
    writeSshConfig(WEB01_CONFIG);
    const lines: string[] = [];
    const asked: { message: string; default?: string }[] = [];
    const answers = ['', '', '', 'web02.example.com', '', '', '', ''];
    let reachable = false;

    const ask: Asker = {
      select: <T extends string>(question: SelectQuestion<T>): Promise<T> =>
        Promise.resolve((question.default ?? question.choices[0]?.value) as T),
      text(question: TextQuestion): Promise<string> {
        asked.push({
          message: question.message,
          ...(question.default === undefined ? {} : { default: question.default }),
        });
        const raw = answers.shift() ?? '';
        return Promise.resolve(raw === '' ? (question.default ?? '') : raw);
      },
    };

    await runSetup(['--from-ssh-config', 'web01'], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask,
      probeTcp: () => {
        const ok = reachable;
        reachable = true;
        return Promise.resolve(
          ok
            ? { ok: true, code: '', reason: '' }
            : { ok: false, code: 'ECONNREFUSED', reason: 'refused' }
        );
      },
    });

    const addressQuestions = asked.filter((entry) => entry.message.includes('호스트 주소'));
    expect(addressQuestions).toHaveLength(2);
    expect(addressQuestions[0]?.default).toBe('web01.internal');
    expect(addressQuestions[1]?.default).toBeUndefined();
  });
});

describe('--from-ssh-config: both positionals given (OP-4 row 2)', () => {
  it('says the values are unused and runs with what was typed', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['prod', 'root@10.0.0.9', '--from-ssh-config', 'web01']);

    expect(result.asked).toHaveLength(0);
    expect(result.text).toContain('--from-ssh-config에서 읽은 값은 쓰지 않습니다');
    expect(result.text).toContain('호스트 "prod" 설정을 시작합니다: root@10.0.0.9:22');
    expect(result.text).not.toContain('web01.internal');
  });

  it('still refuses an unsupported construct, the half of AC-S3 that always runs', async () => {
    writeSshConfig(['Host web01', '  HostName web01.internal', '  ProxyJump bastion'].join('\n'));
    const result = await run(['prod', 'root@10.0.0.9', '--from-ssh-config', 'web01']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('config_unsupported');
    // No partial import, and nothing was started.
    expect(result.text).not.toContain('설정을 시작합니다');
  });
});

describe('--from-ssh-config: one positional (OP-4 row 3)', () => {
  it('is the usage error it always was, unchanged', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['prod', '--from-ssh-config', 'web01']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('host add needs both <alias> and <user@host[:port]>');
    expect(result.asked).toHaveLength(0);
  });
});

describe('--from-ssh-config: no terminal (OP-4 row 4)', () => {
  it('names the flag instead of the generic "cannot draw a list" message', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['--from-ssh-config', 'web01'], { canAsk: false });
    expect(result.code).toBe(2);
    expect(result.text).toContain('--from-ssh-config는 읽은 값을 확인받는 단계가 필요하므로');
    expect(result.text).toContain('터미널(TTY)에서만 동작합니다');
    expect(result.asked).toHaveLength(0);
  });
});

describe('--from-ssh-config: what the file did not give', () => {
  it('reports an absent Host by name and writes nothing', async () => {
    writeSshConfig(WEB01_CONFIG);
    const result = await run(['--from-ssh-config', 'nope']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('"nope" 항목이 없습니다');
    expect(result.asked).toHaveLength(0);
  });

  it('passes a nested-Include warning through to stderr (AC-S2)', async () => {
    const dir = path.join(home.dir, '.ssh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'inner'),
      'Include deeper\nHost web01\n  User deploy\n',
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'deeper'), 'Host web01\n  HostName unreachable\n', 'utf8');
    writeSshConfig('Include inner');

    const result = await run(['--from-ssh-config', 'web01'], {
      answers: ['', '', '', '', '', ''],
    });
    expect(result.text).toContain('1단계까지만 따릅니다');
    // Depth 2 was skipped, so the Host name stands in for the HostName.
    expect(result.text).toContain('deploy@web01:22');
  });

  it('does not seed an alias the parser would reject', async () => {
    // A `Host` entry called `doctor` is a reserved alias, so seeding it would
    // turn the finished interview into a usage error. The hostname's first
    // label is offered instead.
    writeSshConfig(['Host doctor', '  HostName box.example.com', '  User deploy'].join('\n'));
    const result = await run(['--from-ssh-config', 'doctor'], {
      answers: ['', '', '', '', '', ''],
    });
    expect(result.defaultFor('alias')).toBe('box');
    expect(result.text).toContain('호스트 "box" 설정을 시작합니다: deploy@box.example.com:22');
  });
});
