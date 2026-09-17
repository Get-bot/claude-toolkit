/**
 * `ssh-mcp install` (src/install/).
 *
 * Three things are worth proving here, and none of them can be checked by
 * running the real command:
 *
 * 1. **The registered command shape.** Windows must get `cmd /c npx -y <pkg>`
 *    and everything else the bare `npx` form. The platform is injected rather
 *    than inferred, so both branches are exercised on one machine — a test that
 *    only asserts the host platform's branch would let the other one rot.
 * 2. **`claude` is never actually spawned.** The spawner is a stub; a test that
 *    reached the developer's real `claude` would mutate their real MCP
 *    registry. The stub also records argv, which is the actual contract of the
 *    claude-code path.
 * 3. **The Desktop config is never damaged.** Every refusal path (broken JSON,
 *    non-object `mcpServers`, a name collision without `--force`) must leave
 *    the file byte-for-byte unchanged, because the file holds the user's other
 *    MCP servers. These assertions compare the bytes before and after, not just
 *    the exit code.
 *
 * The last block pins `buildSnippets()`'s three strings. `buildSnippets` was
 * refactored to share `config/registration.ts` with `install`, and the printed
 * snippets are what users paste — a silent change to them is a regression even
 * though nothing in the code would fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDesktopEntry,
  buildServerCommand,
  formatServerCommand,
} from '../../src/config/registration.js';
import { buildSnippets } from '../../src/doctor/checks.js';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runInstall,
  shortenHome,
} from '../../src/install/cli.js';
import type { InstallDeps } from '../../src/install/cli.js';
import type { SpawnOutcome } from '../../src/install/claudeCode.js';
import { desktopConfigPath } from '../../src/install/desktop.js';
import type { Asker, SelectQuestion, TextQuestion } from '../../src/setup/ask.js';
import { PromptAbortedError, createPrompter } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';

const PKG = '@get-bot/ssh-mcp';

interface SpawnCall {
  command: string;
  args: string[];
}

interface Harness {
  lines: string[];
  calls: SpawnCall[];
  text: () => string;
}

interface PromptProbe {
  prompter: Prompter;
  /** Feed keystrokes, exactly as `tests/unit/setupPrompt.test.ts` does. */
  send(text: string): void;
  /** Close the input, which is how a prompt sees end of input. */
  end(): void;
  /** Everything the prompt wrote. Empty means the user was never asked. */
  output(): string;
}

function promptHarness(isTTY: boolean): PromptProbe {
  const input = new PassThrough();
  if (isTTY) (input as unknown as { isTTY?: boolean }).isTTY = true;
  let written = '';
  const prompter = createPrompter({
    input: input as never,
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    isTTY,
  });
  return {
    prompter,
    send: (text: string): void => {
      input.write(text);
    },
    end: (): void => {
      input.end();
    },
    output: (): string => written,
  };
}

/**
 * Collect output and spawned argv instead of performing either.
 *
 * The prompter defaults to a non-TTY one so no test can reach the real stdin,
 * and so a question only appears where a test asks for it.
 *
 * `canAsk` follows `isTTY` unless a test separates them, which is how the
 * stdin-is-a-terminal-but-stderr-is-not case gets exercised without a terminal.
 */
function harness(
  outcomes: SpawnOutcome[] = [],
  prompt: { isTTY?: boolean; canAsk?: boolean; answers?: readonly string[] } = {}
): { deps: InstallDeps; probe: Harness; prompt: PromptProbe; ask: AskProbe } {
  const lines: string[] = [];
  const calls: SpawnCall[] = [];
  let index = 0;
  const promptProbe = promptHarness(prompt.isTTY ?? false);
  const askProbe = askProbeOf(prompt.answers ?? []);
  const deps: InstallDeps = {
    write: (text) => {
      lines.push(text);
    },
    spawn: (command, args) => {
      calls.push({ command, args: [...args] });
      const outcome = outcomes[index] ?? { status: 0, stdout: '', stderr: '' };
      index += 1;
      return outcome;
    },
    prompter: promptProbe.prompter,
    // Answers every question from a script, so no test can reach a terminal and
    // a question only appears where a test provided an answer for it.
    ask: askProbe.asker,
    canAsk: () => prompt.canAsk ?? prompt.isTTY ?? false,
    // The Desktop default path is derived from these. Without them a test that
    // reaches the Desktop branch writes into the developer's real home — which
    // is exactly what happened once before these defaults existed.
    homedir: () => tmpDir,
    env: {},
    packageName: PKG,
  };
  return {
    deps,
    probe: { lines, calls, text: (): string => lines.join('\n') },
    prompt: promptProbe,
    ask: askProbe,
  };
}

/** One question the command asked, reduced to what a test cares about. */
interface Asked {
  message: string;
  choices: string[];
  /** The line shown under each row; where the detection result lands. */
  descriptions: (string | undefined)[];
  default?: string;
}

interface AskProbe {
  asker: Asker;
  /** Every question asked, in order. One run can ask two (client, then scope). */
  asked: Asked[];
}

/**
 * Answer the questions from a script.
 *
 * The answers are shared across questions and consumed in order, because a
 * single run can ask more than one: choosing Claude Code is followed by the
 * scope question.
 */
function askProbeOf(answers: readonly string[]): AskProbe {
  const queue = [...answers];
  const asked: Asked[] = [];
  return {
    asked,
    asker: {
      select<T extends string>(question: SelectQuestion<T>): Promise<T> {
        asked.push({
          message: question.message,
          choices: question.choices.map((choice) => choice.value),
          descriptions: question.choices.map((choice) => choice.description),
          ...(question.default === undefined ? {} : { default: question.default }),
        });
        if (queue.length === 0) {
          // A question nobody scripted an answer for is a test bug, not a hang.
          throw new PromptAbortedError('eof', `unanswered question: ${question.message}`);
        }
        const raw = queue.shift() ?? '';
        const value = raw === '' ? question.default : raw;
        const match = question.choices.find((choice) => choice.value === value);
        if (match === undefined) throw new Error(`not a choice: ${String(value)}`);
        return Promise.resolve(match.value);
      },
      text(question: TextQuestion): Promise<string> {
        throw new Error(`install asks no text questions, but got: ${question.message}`);
      },
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-install-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function configPath(name = 'claude_desktop_config.json'): string {
  return path.join(tmpDir, name);
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function backupFiles(): string[] {
  return fs.readdirSync(tmpDir).filter((entry) => entry.includes('.bak-'));
}

describe('argument parsing', () => {
  it('prints usage to stdout and exits 0 for --help, with no client given', async () => {
    const { deps, probe } = harness();
    const out: string[] = [];
    const code = await runInstall(['--help'], { ...deps, out: (text) => void out.push(text) });
    expect(code).toBe(EXIT_OK);
    // Help that was asked for is not an error: it goes to stdout so that
    // `install --help | less` has something to show. Everything else this
    // command prints stays on the stderr writer, which must not carry it.
    expect(out.join('\n')).toContain('Usage: ssh-mcp install [claude-code|claude-desktop]');
    expect(probe.text()).not.toContain('Usage:');
    expect(probe.calls).toHaveLength(0);
  });

  it('exits 2 when the client is missing and nothing can be asked', async () => {
    const { deps, probe } = harness();
    expect(await runInstall([], deps)).toBe(EXIT_USAGE);
    expect(probe.text()).toContain('등록할 클라이언트를 지정하세요');
    expect(probe.text()).toContain('install claude-code');
    expect(probe.text()).toContain('install claude-desktop');
    expect(probe.text()).toContain('Usage: ssh-mcp install');
    expect(probe.calls).toHaveLength(0);
  });

  it('says why it did not ask when stdin is a terminal but the list cannot be drawn', async () => {
    // A redirected stderr or TERM=dumb: without this line the user sees a
    // usage error in a terminal and assumes the menu is broken.
    const { deps, probe } = harness([], { isTTY: true, canAsk: false });
    expect(await runInstall([], deps)).toBe(EXIT_USAGE);
    expect(probe.text()).toContain('등록할 클라이언트를 지정하세요');
    expect(probe.text()).toContain('이 터미널에는 목록을 그릴 수 없습니다');
    expect(probe.calls).toHaveLength(0);
  });

  it('exits 2 for a client-only flag with no client', async () => {
    const scoped = harness();
    expect(await runInstall(['--scope', 'user'], scoped.deps)).toBe(EXIT_USAGE);
    expect(scoped.probe.text()).toContain('--scope를 쓰려면 클라이언트를 함께 지정하세요');

    const configured = harness();
    expect(await runInstall(['--config', configPath()], configured.deps)).toBe(EXIT_USAGE);
    expect(configured.probe.text()).toContain('--config를 쓰려면 클라이언트를 함께 지정하세요');
  });

  it('exits 2 for an unknown client', async () => {
    const { deps, probe } = harness();
    expect(await runInstall(['claude-desktopp'], deps)).toBe(EXIT_USAGE);
    expect(probe.text()).toContain('unknown client "claude-desktopp"');
  });

  it('exits 2 for --scope on claude-desktop', async () => {
    const { deps, probe } = harness();
    expect(await runInstall(['claude-desktop', '--scope', 'user'], deps)).toBe(EXIT_USAGE);
    expect(probe.text()).toContain('--scope는 claude-code 전용입니다');
  });

  it('exits 2 for --config on claude-code', async () => {
    const { deps, probe } = harness();
    expect(await runInstall(['claude-code', '--config', configPath()], deps)).toBe(EXIT_USAGE);
    expect(probe.text()).toContain('--config는 claude-desktop 전용입니다');
  });

  it('exits 2 for an invalid scope value and for an unknown option', async () => {
    const first = harness();
    expect(await runInstall(['claude-code', '--scope', 'global'], first.deps)).toBe(EXIT_USAGE);
    expect(first.probe.text()).toContain('--scope must be one of: local, user, project');

    const second = harness();
    expect(await runInstall(['claude-code', '--verbose'], second.deps)).toBe(EXIT_USAGE);
    expect(second.probe.text()).toContain('unknown option: --verbose');
  });

  // Reported from the built CLI: `--home --dry-run` registered
  // `SSH_MCP_HOME=--dry-run` and wrote the file for real, because the flag that
  // should have prevented the write was consumed as the value.
  it('never swallows a following flag as an option value', async () => {
    const target = configPath();
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target, '--home', '--dry-run'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_USAGE);
    expect(fs.existsSync(target)).toBe(false);
    expect(probe.text()).toContain('--home needs a value');
    expect(probe.text()).toContain('--dry-run');
  });

  it('exits 2 when any value-taking flag is last on the line', async () => {
    for (const argv of [
      ['claude-code', '--name'],
      ['claude-code', '--scope'],
      ['claude-code', '--home'],
      ['claude-desktop', '--config'],
    ]) {
      const { deps, probe } = harness();
      expect(await runInstall(argv, deps)).toBe(EXIT_USAGE);
      expect(probe.text()).toContain(`${argv[1] ?? ''} needs a value`);
    }
  });

  it('rejects a name outside the allowed character set', async () => {
    for (const bad of ['ssh mcp', 'a&b', 'bad name!', 'x'.repeat(65), 'q"uote']) {
      const { deps, probe } = harness();
      expect(await runInstall(['claude-code', '--name', bad], deps)).toBe(EXIT_USAGE);
      expect(probe.text()).toContain(`invalid name "${bad}"`);
    }

    // A leading `-` never reaches the pattern: the value guard rejects it first,
    // and that is the message the user should see.
    const dashed = harness();
    expect(await runInstall(['claude-code', '--name', '-lead'], dashed.deps)).toBe(EXIT_USAGE);
    expect(dashed.probe.text()).toContain('--name needs a value, but got the option "-lead"');

    const ok = harness();
    expect(
      await runInstall(['claude-code', '--name', 'ssh-mcp.prod_2'], {
        ...ok.deps,
        platform: 'linux',
      })
    ).toBe(EXIT_OK);
  });

  it('resolves relative --home and --config against the working directory', async () => {
    const cwd = (): string => tmpDir;

    const { deps, probe } = harness();
    expect(
      await runInstall(['claude-code', '--home', './relhome'], { ...deps, platform: 'linux', cwd })
    ).toBe(EXIT_OK);
    expect(probe.calls[0]?.args).toContain(`SSH_MCP_HOME=${path.join(tmpDir, 'relhome')}`);

    const desktop = harness();
    expect(
      await runInstall(['claude-desktop', '--config', 'claude_desktop_config.json', '--dry-run'], {
        ...desktop.deps,
        platform: 'linux',
        cwd,
      })
    ).toBe(EXIT_OK);
    expect(desktop.probe.text()).toContain(configPath());
  });
});

describe('registered command shape', () => {
  it('wraps the command in cmd /c on win32 and leaves it bare elsewhere', async () => {
    expect(buildServerCommand({ platform: 'win32', packageName: PKG })).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', PKG],
    });
    expect(buildServerCommand({ platform: 'linux', packageName: PKG })).toEqual({
      command: 'npx',
      args: ['-y', PKG],
    });
    expect(buildServerCommand({ platform: 'darwin', packageName: PKG })).toEqual({
      command: 'npx',
      args: ['-y', PKG],
    });
    expect(formatServerCommand(buildServerCommand({ platform: 'win32', packageName: PKG }))).toBe(
      `cmd /c npx -y ${PKG}`
    );
  });

  it('adds env only when a home is given', async () => {
    expect(buildDesktopEntry({ platform: 'linux', packageName: PKG })).toEqual({
      command: 'npx',
      args: ['-y', PKG],
    });
    expect(buildDesktopEntry({ platform: 'linux', packageName: PKG, home: '/opt/h' })).toEqual({
      command: 'npx',
      args: ['-y', PKG],
      env: { SSH_MCP_HOME: '/opt/h' },
    });
  });
});

describe('shortenHome', () => {
  // Reported: a plain `startsWith` turned `/home/mentor/bin/claude` into
  // `~ntor/bin/claude` for a user whose home is `/home/me` — a path that
  // points nowhere, printed as if it were the one detected. The match has to
  // stop at a separator, not merely be a string prefix.
  it('leaves the path alone when the match stops short of a separator', () => {
    expect(shortenHome('/home/mentor/bin/claude', '/home/me')).toBe('/home/mentor/bin/claude');
  });

  it('still shortens once the home is followed by an actual separator', () => {
    expect(shortenHome('/home/me/bin/claude', '/home/me')).toBe('~/bin/claude');
    // The home directory itself, with nothing after it.
    expect(shortenHome('/home/me', '/home/me')).toBe('~');
  });

  // Same bug, Windows spelling: `C:\Users\bob` is a string-prefix of
  // `C:\Users\bobby\...` without being its parent directory.
  it('applies the same boundary check to a Windows-style separator', () => {
    expect(shortenHome('C:\\Users\\bobby\\bin\\claude.exe', 'C:\\Users\\bob')).toBe(
      'C:\\Users\\bobby\\bin\\claude.exe'
    );
    expect(shortenHome('C:\\Users\\bob\\bin\\claude.exe', 'C:\\Users\\bob')).toBe(
      '~\\bin\\claude.exe'
    );
  });
});

describe('claude-code', () => {
  it('passes scope, env and the server command after --', async () => {
    const { deps, probe } = harness();
    const code = await runInstall(['claude-code', '--scope', 'user', '--home', '/opt/ssh-mcp'], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toEqual({
      command: 'claude',
      args: [
        'mcp',
        'add',
        'ssh-mcp',
        '-s',
        'user',
        '-e',
        `SSH_MCP_HOME=${path.resolve('/opt/ssh-mcp')}`,
        '--',
        'npx',
        '-y',
        PKG,
      ],
    });
  });

  it('registers the cmd /c form on win32 and honours --name', async () => {
    const { deps, probe } = harness();
    const code = await runInstall(['claude-code', '--name', 'remote'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls[0]?.args).toEqual([
      'mcp',
      'add',
      'remote',
      '-s',
      'local',
      '--',
      'cmd',
      '/c',
      'npx',
      '-y',
      PKG,
    ]);
  });

  it('removes before adding when --force is given', async () => {
    const { deps, probe } = harness();
    const code = await runInstall(['claude-code', '--force'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[0]?.args).toEqual(['mcp', 'remove', '-s', 'local', 'ssh-mcp']);
    expect(probe.calls[1]?.args.slice(0, 2)).toEqual(['mcp', 'add']);
  });

  it('ignores a failing remove and still adds', async () => {
    const { deps, probe } = harness([
      { status: 1, stdout: '', stderr: 'No MCP server found with name: ssh-mcp' },
      { status: 0, stdout: 'Added', stderr: '' },
    ]);
    const code = await runInstall(['claude-code', '--force'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(2);
  });

  it('exits 1 with a manual command when claude is not on PATH', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent]);
    const code = await runInstall(['claude-code'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).toContain('Claude Code CLI(`claude`)를 PATH에서 찾을 수 없습니다');
    expect(probe.text()).toContain(`claude mcp add ssh-mcp -s local -- npx -y ${PKG}`);
  });

  it('retries through cmd /c on win32 before giving up', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent, { status: 0, stdout: '', stderr: '' }]);
    const code = await runInstall(['claude-code'], { ...deps, platform: 'win32' });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[1]?.command).toBe('cmd');
    expect(probe.calls[1]?.args.slice(0, 3)).toEqual(['/c', 'claude', 'mcp']);
  });

  // Reported from the built CLI: `--home 'C:\R&D\ssh-mcp'` reached cmd.exe
  // unquoted on the retry path, so `&` started a second command.
  it('refuses the cmd /c retry when an argument carries a cmd.exe metacharacter', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent]);
    const code = await runInstall(['claude-code', '--home', 'C:\\R&D\\ssh-mcp'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.command).toBe('claude');
    expect(probe.text()).toContain('cmd 경유 재시도는 이 문자를 안전하게 전달할 수 없습니다');
    expect(probe.text()).toContain('claude mcp add ssh-mcp -s local');
  });

  it('still retries through cmd /c when only spaces are present', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent, { status: 0, stdout: '', stderr: '' }]);
    const code = await runInstall(['claude-code', '--home', 'C:\\Program Files\\ssh-mcp'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[1]?.command).toBe('cmd');
  });

  it('blames the missing binary, not --force, when the cmd retry also fails', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([
      enoent,
      { status: 1, stdout: '', stderr: "'claude' is not recognized" },
    ]);
    const code = await runInstall(['claude-code'], { ...deps, platform: 'win32' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).toContain('`claude`가 설치되어 PATH에 있는지');
    expect(probe.text()).not.toContain('--force를 붙여 교체하세요');
  });

  // Reported with a fake `claude.cmd`: `remove` went through the cmd fallback
  // and `add` was refused for its `-e SSH_MCP_HOME=...&...`, so the run deleted
  // the registration and put nothing back.
  it('refuses the whole --force sequence before removing anything', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent]);
    const code = await runInstall(['claude-code', '--force', '--home', 'C:\\R&D\\x'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.command).toBe('claude');
    expect(probe.calls.filter((call) => call.command === 'cmd')).toHaveLength(0);
    expect(probe.calls[0]?.args.slice(0, 2)).toEqual(['mcp', 'remove']);
    expect(probe.text()).toContain('cmd 경유 재시도는 이 문자를 안전하게 전달할 수 없습니다');
  });

  it('stays quiet about a failed remove spawn and lets add do the diagnosing', async () => {
    const enoent: SpawnOutcome = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
    };
    const { deps, probe } = harness([enoent, enoent]);
    const code = await runInstall(['claude-code', '--force'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).not.toContain('기존 등록이 없어 remove는 건너뜁니다');
    expect(probe.text()).toContain('PATH에서 찾을 수 없습니다');
  });

  it('quotes an argument with spaces in the printed command', async () => {
    // `--home` is resolved against the real cwd with the host's path rules, so
    // a Windows literal here would come out as `<cwd>/C:\Program Files\...` on
    // Linux and the assertion would miss. Build a path that is absolute on
    // whichever platform runs the test; the space is what this is about.
    const spaced = path.join(os.tmpdir(), 'ssh mcp home');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-code', '--dry-run', '--home', spaced], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.text()).toContain(`"SSH_MCP_HOME=${spaced}"`);
    // Parts that need no quoting stay bare, so the line still reads as a command.
    expect(probe.text()).toContain('claude mcp add ssh-mcp -s local -e ');
  });

  it('reports a signal death as a signal, not as exit code null', async () => {
    const { deps, probe } = harness([{ status: null, stdout: '', stderr: '' }]);
    const code = await runInstall(['claude-code'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).toContain('시그널로 종료됐습니다');
    expect(probe.text()).not.toContain('null');
  });

  it('says it skipped the remove instead of relaying a not-found error', async () => {
    const { deps, probe } = harness([
      { status: 1, stdout: '', stderr: 'No MCP server named ssh-mcp in local scope' },
      { status: 0, stdout: 'Added', stderr: '' },
    ]);
    const code = await runInstall(['claude-code', '--force'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_OK);
    expect(probe.text()).toContain('기존 등록이 없어 remove는 건너뜁니다');
    expect(probe.text()).not.toContain('No MCP server named');
  });

  it('exits 1 when claude exits non-zero, relaying its output', async () => {
    const { deps, probe } = harness([
      { status: 1, stdout: '', stderr: 'already exists in local config' },
    ]);
    const code = await runInstall(['claude-code'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).toContain('already exists in local config');
    expect(probe.text()).toContain('종료 코드 1로 끝났습니다');
    expect(probe.text()).toContain('--force');
  });

  it('never spawns anything for --dry-run', async () => {
    const { deps, probe } = harness();
    const code = await runInstall(['claude-code', '--dry-run', '--force'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(0);
    expect(probe.text()).toContain(`claude mcp add ssh-mcp -s local -- cmd /c npx -y ${PKG}`);
    expect(probe.text()).toContain('claude mcp remove -s local ssh-mcp');
  });
});

describe('client selection', () => {
  const found = { found: true, where: '/usr/local/bin/claude' };
  const missing = { found: false, where: '' };

  it('asks which client when none is named, and says what it detected', async () => {
    // Enter on the default picks Claude Code; the second answer is the scope
    // question that follows it.
    const { deps, probe, ask } = harness([], { isTTY: true, answers: ['', ''] });
    const code = await runInstall([], {
      ...deps,
      platform: 'linux',
      detectCode: () => found,
      detectDesktop: () => missing,
    });
    expect(code).toBe(EXIT_OK);

    const question = ask.asked[0];
    expect(question?.message).toBe('어느 클라이언트에 등록할까요?');
    expect(question?.choices).toEqual(['claude-code', 'claude-desktop', 'both']);
    expect(question?.default).toBe('claude-code');
    expect(question?.descriptions[0]).toContain('claude 감지됨: /usr/local/bin/claude');
    expect(question?.descriptions[1]).toContain('감지되지 않음');

    expect(probe.calls[0]?.args.slice(0, 3)).toEqual(['mcp', 'add', 'ssh-mcp']);
    // The scope question followed, so the registration is local by default.
    expect(probe.calls[0]?.args).toContain('local');
  });

  it('words the Desktop hint honestly when the reason is not "missing"', async () => {
    const { deps, ask } = harness([], { isTTY: true, answers: ['', ''] });
    await runInstall([], {
      ...deps,
      platform: 'linux',
      detectCode: () => found,
      detectDesktop: () => ({
        found: false,
        where: '감지되지 않음(WSL에서는 Windows의 Claude Desktop 설정에 접근하지 않습니다)',
      }),
    });
    expect(ask.asked[0]?.descriptions[1]).toContain(
      'WSL에서는 Windows의 Claude Desktop 설정에 접근하지 않습니다'
    );
  });

  it('runs only the Desktop path when Desktop is chosen', async () => {
    const target = configPath();
    const { deps, probe } = harness([], { isTTY: true, answers: ['claude-desktop'] });
    const code = await runInstall([], {
      ...deps,
      platform: 'linux',
      homedir: () => tmpDir,
      env: {},
      detectCode: () => missing,
      detectDesktop: () => missing,
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(0);
    expect(
      fs.existsSync(path.join(tmpDir, '.config', 'Claude', 'claude_desktop_config.json'))
    ).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('runs both in order and summarises the two results', async () => {
    // "both", then the scope question that the Claude Code half asks.
    const { deps, probe } = harness([], { isTTY: true, answers: ['both', ''] });
    const code = await runInstall([], {
      ...deps,
      platform: 'linux',
      homedir: () => tmpDir,
      env: {},
      detectCode: () => found,
      detectDesktop: () => found,
    });
    expect(code).toBe(EXIT_OK);
    expect(probe.calls[0]?.args.slice(0, 2)).toEqual(['mcp', 'add']);
    expect(
      fs.existsSync(path.join(tmpDir, '.config', 'Claude', 'claude_desktop_config.json'))
    ).toBe(true);
    expect(probe.text()).toContain('Claude Code: 등록 완료 / Claude Desktop: 등록 완료');
  });

  it('does not claim a dry run registered anything', async () => {
    // The summary is the only line a reader sees after a dry run, so calling it
    // "등록 완료" would be a lie about a file that was never written.
    const { deps, probe } = harness([], { isTTY: true, answers: ['both', ''] });
    const desktopConfig = path.join(tmpDir, '.config', 'Claude', 'claude_desktop_config.json');
    fs.rmSync(desktopConfig, { force: true });

    const code = await runInstall(['--dry-run'], {
      ...deps,
      platform: 'linux',
      homedir: () => tmpDir,
      env: {},
      detectCode: () => found,
      detectDesktop: () => found,
    });

    expect(code).toBe(EXIT_OK);
    expect(probe.calls).toHaveLength(0);
    expect(fs.existsSync(desktopConfig)).toBe(false);
    expect(probe.text()).toContain('[dry-run] Claude Code: 등록 예정 / Claude Desktop: 등록 예정');
    expect(probe.text()).not.toContain('등록 완료');
  });

  it('reports failure when one half of "both" fails', async () => {
    const { deps, probe } = harness([{ status: 1, stdout: '', stderr: 'boom' }], {
      isTTY: true,
      answers: ['both', ''],
    });
    const code = await runInstall([], {
      ...deps,
      platform: 'linux',
      homedir: () => tmpDir,
      env: {},
      detectCode: () => found,
      detectDesktop: () => found,
    });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.text()).toContain('Claude Code: 실패 / Claude Desktop: 등록 완료');
  });

  it('registers nothing when the client question is aborted', async () => {
    // No scripted answer: the stub aborts the way Ctrl-C does.
    const { deps, probe } = harness([], { isTTY: true });
    const code = await runInstall([], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.calls).toHaveLength(0);
    expect(probe.text()).toContain('클라이언트를 선택하지 않았습니다');
  });
});

describe('claude-code scope selection', () => {
  /** Every case here runs with `--scope` absent unless it says otherwise. */
  function scopeOf(calls: SpawnCall[]): string | undefined {
    const args = calls[0]?.args ?? [];
    return args[args.indexOf('-s') + 1];
  }

  it('asks once, naming the directory local would bind to', async () => {
    const { deps, probe, ask } = harness([], { isTTY: true, answers: ['user'] });
    const code = await runInstall(['claude-code'], {
      ...deps,
      platform: 'linux',
      cwd: () => tmpDir,
    });
    expect(code).toBe(EXIT_OK);
    expect(ask.asked[0]?.message).toBe('Claude Code 어디에 등록할까요?');
    expect(ask.asked[0]?.choices).toEqual(['local', 'user']);
    expect(ask.asked[0]?.default).toBe('local');
    expect(ask.asked[0]?.descriptions[0]).toContain(tmpDir);
    expect(scopeOf(probe.calls)).toBe('user');
  });

  it('shows a POSIX working directory in the hint and the success line on linux', async () => {
    const posixCwd = '/home/me/work/api';
    const { deps, probe, ask } = harness([], { isTTY: true, answers: [''] });
    expect(
      await runInstall(['claude-code'], { ...deps, platform: 'linux', cwd: () => posixCwd })
    ).toBe(EXIT_OK);
    expect(ask.asked[0]?.descriptions[0]).toContain(posixCwd);
    expect(probe.text()).toContain(`이 등록은 ${posixCwd}에서 연 Claude Code에서만 보입니다.`);
  });

  it('takes the default when the question is answered with Enter', async () => {
    const { deps, probe } = harness([], { isTTY: true, answers: [''] });
    expect(await runInstall(['claude-code'], { ...deps, platform: 'linux' })).toBe(EXIT_OK);
    expect(scopeOf(probe.calls)).toBe('local');
  });

  it('never asks when --scope is given', async () => {
    const { deps, probe, ask } = harness([], { isTTY: true });
    expect(
      await runInstall(['claude-code', '--scope', 'user'], { ...deps, platform: 'linux' })
    ).toBe(EXIT_OK);
    expect(ask.asked).toHaveLength(0);
    expect(scopeOf(probe.calls)).toBe('user');
  });

  it('falls back to local with one explanatory line when stdin is not a terminal', async () => {
    const { deps, probe, ask } = harness([], { isTTY: false });
    expect(
      await runInstall(['claude-code'], { ...deps, platform: 'linux', cwd: () => tmpDir })
    ).toBe(EXIT_OK);
    expect(ask.asked).toHaveLength(0);
    expect(scopeOf(probe.calls)).toBe('local');
    expect(probe.text()).toContain('--scope를 지정하지 않아 Claude Code 기본값 local');
    expect(probe.text()).toContain(tmpDir);
    expect(probe.text()).toContain('--scope user 를 지정하세요');
  });

  it('registers nothing when the scope question is aborted', async () => {
    const { deps, probe } = harness([], { isTTY: true });
    const code = await runInstall(['claude-code'], { ...deps, platform: 'linux' });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.calls).toHaveLength(0);
    expect(probe.text()).toContain('등록할 scope를 선택하지 않았습니다');
  });

  it('reports an unexpected prompt failure without registering anything', async () => {
    const { deps, probe } = harness([], { isTTY: true });
    const code = await runInstall(['claude-code'], {
      ...deps,
      platform: 'linux',
      ask: {
        select: () => Promise.reject(new Error('prompt exploded')),
        text: () => Promise.reject(new Error('prompt exploded')),
      },
    });
    expect(code).toBe(EXIT_FAILED);
    expect(probe.calls).toHaveLength(0);
    expect(probe.text()).toContain('scope 선택이 중단되었습니다');
    expect(probe.text()).toContain('prompt exploded');
  });

  it('asks before a --dry-run too, and prints the chosen scope', async () => {
    const { deps, probe } = harness([], { isTTY: true, answers: ['user'] });
    expect(await runInstall(['claude-code', '--dry-run'], { ...deps, platform: 'linux' })).toBe(
      EXIT_OK
    );
    expect(probe.calls).toHaveLength(0);
    expect(probe.text()).toContain(`claude mcp add ssh-mcp -s user -- npx -y ${PKG}`);
  });

  it('never asks anything for claude-desktop', async () => {
    const { deps, ask } = harness([], { isTTY: true });
    expect(
      await runInstall(['claude-desktop', '--config', configPath()], {
        ...deps,
        platform: 'linux',
      })
    ).toBe(EXIT_OK);
    expect(ask.asked).toHaveLength(0);
  });

  it('says what each scope actually covers on success', async () => {
    const local = harness();
    expect(
      await runInstall(['claude-code', '--scope', 'local'], {
        ...local.deps,
        platform: 'linux',
        cwd: () => tmpDir,
      })
    ).toBe(EXIT_OK);
    expect(local.probe.text()).toContain(`이 등록은 ${tmpDir}에서 연 Claude Code에서만 보입니다.`);
    expect(local.probe.text()).toContain('--scope user 로 다시 등록하세요');

    const user = harness();
    expect(
      await runInstall(['claude-code', '--scope', 'user'], { ...user.deps, platform: 'linux' })
    ).toBe(EXIT_OK);
    expect(user.probe.text()).toContain('모든 프로젝트에서 보입니다.');

    const project = harness();
    expect(
      await runInstall(['claude-code', '--scope', 'project'], {
        ...project.deps,
        platform: 'linux',
      })
    ).toBe(EXIT_OK);
    expect(project.probe.text()).toContain('.mcp.json에 기록되어 이 저장소를 공유하는 사람에게도');
  });
});

describe('claude-desktop', () => {
  it('creates the file and its directory when nothing exists', async () => {
    const target = path.join(tmpDir, 'nested', 'claude_desktop_config.json');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_OK);
    expect(readConfig(target)).toEqual({
      mcpServers: { 'ssh-mcp': { command: 'npx', args: ['-y', PKG] } },
    });
    expect(probe.text()).toContain('Claude Desktop을 완전히 종료했다가 다시 시작');
    expect(fs.readFileSync(target, 'utf8').endsWith('\n')).toBe(true);
  });

  /**
   * This file is not ours. It belongs to Claude Desktop and can hold other
   * servers' credentials, so a user who restricted it must not find it
   * world-readable afterwards. `writeFileSync` creates at 0644 and
   * `renameSync` carries that mode onto the target, which is the regression.
   */
  it.skipIf(process.platform === 'win32')(
    'preserves the mode of the config it replaces, and of the backup',
    async () => {
      const target = configPath();
      fs.writeFileSync(target, JSON.stringify({ mcpServers: {} }), 'utf8');
      fs.chmodSync(target, 0o600);

      const { deps } = harness();
      const code = await runInstall(['claude-desktop', '--config', target], {
        ...deps,
        platform: 'linux',
      });

      expect(code).toBe(EXIT_OK);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      // The backup holds the same bytes, so it needs the same permissions.
      const backup = fs
        .readdirSync(path.dirname(target))
        .find((name) => name.startsWith(`${path.basename(target)}.bak-`));
      expect(backup).toBeDefined();
      expect(fs.statSync(path.join(path.dirname(target), backup ?? '')).mode & 0o777).toBe(0o600);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'leaves the platform default on a file it creates',
    async () => {
      // Nothing to preserve, so nothing is imposed either — `--config` into a
      // fresh path must behave like any other file this process writes.
      const target = path.join(tmpDir, 'fresh', 'claude_desktop_config.json');
      const { deps } = harness();
      expect(
        await runInstall(['claude-desktop', '--config', target], { ...deps, platform: 'linux' })
      ).toBe(EXIT_OK);
      const expected = 0o666 & ~process.umask();
      expect(fs.statSync(target).mode & 0o777).toBe(expected);
    }
  );

  it('merges into an existing file, preserving other servers and other keys', async () => {
    const target = configPath();
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          globalShortcut: 'Alt+Space',
          mcpServers: { other: { command: 'node', args: ['other.js'] } },
        },
        null,
        2
      ),
      'utf8'
    );
    const { deps } = harness();
    const code = await runInstall(['claude-desktop', '--config', target], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(readConfig(target)).toEqual({
      globalShortcut: 'Alt+Space',
      mcpServers: {
        other: { command: 'node', args: ['other.js'] },
        'ssh-mcp': { command: 'cmd', args: ['/c', 'npx', '-y', PKG] },
      },
    });
  });

  it('registers SSH_MCP_HOME under env when --home is given', async () => {
    const target = configPath();
    const { deps } = harness();
    const code = await runInstall(['claude-desktop', '--config', target, '--home', '/srv/h'], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_OK);
    expect(readConfig(target)).toEqual({
      mcpServers: {
        'ssh-mcp': {
          command: 'npx',
          args: ['-y', PKG],
          env: { SSH_MCP_HOME: path.resolve('/srv/h') },
        },
      },
    });
  });

  it('refuses a name collision without --force and leaves the bytes untouched', async () => {
    const target = configPath();
    const original = JSON.stringify(
      { mcpServers: { 'ssh-mcp': { command: 'old', args: [] } } },
      null,
      4
    );
    fs.writeFileSync(target, original, 'utf8');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_FAILED);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(backupFiles()).toHaveLength(0);
    expect(probe.text()).toContain('--force');
  });

  it('replaces the entry with --force and leaves a timestamped backup', async () => {
    const target = configPath();
    const original = JSON.stringify(
      { mcpServers: { 'ssh-mcp': { command: 'old', args: [] }, other: { command: 'keep' } } },
      null,
      2
    );
    fs.writeFileSync(target, original, 'utf8');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target, '--force'], {
      ...deps,
      platform: 'linux',
      now: () => new Date(2026, 8, 14, 1, 2, 3),
    });
    expect(code).toBe(EXIT_OK);
    expect(readConfig(target)).toEqual({
      mcpServers: {
        'ssh-mcp': { command: 'npx', args: ['-y', PKG] },
        other: { command: 'keep' },
      },
    });
    expect(backupFiles()).toEqual(['claude_desktop_config.json.bak-20260914-010203']);
    expect(fs.readFileSync(path.join(tmpDir, backupFiles()[0] ?? ''), 'utf8')).toBe(original);
    expect(probe.text()).toContain('백업: ');
  });

  // Reported: two `--force` runs inside the same second made the second backup
  // overwrite the first, losing the only copy of the original file.
  it('never overwrites an existing backup when the timestamp repeats', async () => {
    const target = configPath();
    const original = JSON.stringify({ mcpServers: { 'ssh-mcp': { command: 'v1' } } }, null, 2);
    fs.writeFileSync(target, original, 'utf8');
    const frozen = (): Date => new Date(2026, 8, 14, 1, 2, 3);

    const first = harness();
    expect(
      await runInstall(['claude-desktop', '--config', target, '--force'], {
        ...first.deps,
        platform: 'linux',
        now: frozen,
      })
    ).toBe(EXIT_OK);

    const second = harness();
    expect(
      await runInstall(['claude-desktop', '--config', target, '--force'], {
        ...second.deps,
        platform: 'linux',
        now: frozen,
      })
    ).toBe(EXIT_OK);

    expect(backupFiles().sort()).toEqual([
      'claude_desktop_config.json.bak-20260914-010203',
      'claude_desktop_config.json.bak-20260914-010203-1',
    ]);
    expect(fs.readFileSync(path.join(tmpDir, backupFiles().sort()[0] ?? ''), 'utf8')).toBe(
      original
    );
  });

  it('treats a prototype member name as absent, not as a collision', async () => {
    const target = configPath();
    fs.writeFileSync(target, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
    const { deps } = harness();
    const code = await runInstall(['claude-desktop', '--config', target, '--name', 'constructor'], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_OK);
    expect(readConfig(target)).toEqual({
      mcpServers: { constructor: { command: 'npx', args: ['-y', PKG] } },
    });
  });

  it('leaves no temporary file behind', async () => {
    const target = configPath();
    const { deps } = harness();
    expect(
      await runInstall(['claude-desktop', '--config', target], { ...deps, platform: 'linux' })
    ).toBe(EXIT_OK);
    expect(fs.readdirSync(tmpDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses broken JSON without writing anything', async () => {
    const target = configPath();
    const original = '{ "mcpServers": { ';
    fs.writeFileSync(target, original, 'utf8');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_FAILED);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(backupFiles()).toHaveLength(0);
    expect(probe.text()).toContain('JSON 파싱에 실패했습니다');
    expect(probe.text()).toContain(target);
  });

  it('refuses a non-object mcpServers without writing anything', async () => {
    const target = configPath();
    const original = JSON.stringify({ mcpServers: ['ssh-mcp'] }, null, 2);
    fs.writeFileSync(target, original, 'utf8');
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target], {
      ...deps,
      platform: 'linux',
    });
    expect(code).toBe(EXIT_FAILED);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(probe.text()).toContain('mcpServers가 JSON 객체가 아닙니다');
  });

  it('writes nothing for --dry-run', async () => {
    const target = configPath();
    const { deps, probe } = harness();
    const code = await runInstall(['claude-desktop', '--config', target, '--dry-run'], {
      ...deps,
      platform: 'win32',
    });
    expect(code).toBe(EXIT_OK);
    expect(fs.existsSync(target)).toBe(false);
    expect(probe.text()).toContain(target);
    expect(probe.text()).toContain('"command": "cmd"');
  });

  // WSL runs as `linux`, so these are the paths and the command shape it gets.
  it('uses POSIX paths and the unwrapped command on linux', async () => {
    const { deps, probe } = harness([], { isTTY: false });
    const code = await runInstall(['claude-desktop'], {
      ...deps,
      platform: 'linux',
      homedir: () => tmpDir,
      env: {},
    });
    expect(code).toBe(EXIT_OK);
    const target = path.join(tmpDir, '.config', 'Claude', 'claude_desktop_config.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(readConfig(target)).toEqual({
      mcpServers: { 'ssh-mcp': { command: 'npx', args: ['-y', PKG] } },
    });
    expect(probe.text()).toContain(path.join(tmpDir, '.config', 'Claude'));
  });

  it('resolves the platform default path when --config is absent', async () => {
    const home = path.join(tmpDir, 'home');
    const homedir = (): string => home;
    expect(desktopConfigPath('win32', { APPDATA: 'C:\\Roaming' }, homedir)).toBe(
      path.join('C:\\Roaming', 'Claude', 'claude_desktop_config.json')
    );
    expect(desktopConfigPath('win32', {}, homedir)).toBe(
      path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    );
    expect(desktopConfigPath('darwin', {}, homedir)).toBe(
      path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    );
    expect(desktopConfigPath('linux', {}, homedir)).toBe(
      path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
    );
  });
});

describe('doctor snippets are unchanged by the shared registration module', () => {
  it('pins all three snippet strings', async () => {
    const snippets = buildSnippets(PKG);
    expect(snippets.claudeDesktop).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "ssh-mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        `        "${PKG}"`,
        '      ]',
        '    }',
        '  }',
        '}',
      ].join('\n')
    );
    expect(snippets.claudeCode).toBe(`claude mcp add ssh-mcp -- npx -y ${PKG}`);
    expect(snippets.windows).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "ssh-mcp": {',
        '      "command": "cmd",',
        '      "args": [',
        '        "/c",',
        '        "npx",',
        '        "-y",',
        `        "${PKG}"`,
        '      ]',
        '    }',
        '  }',
        '}',
        `claude mcp add ssh-mcp -- cmd /c npx -y ${PKG}`,
      ].join('\n')
    );
  });
});
