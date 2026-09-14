/**
 * `ssh-mcp install [claude-code|claude-desktop]` — register this server with an
 * MCP host.
 *
 * `doctor` already prints the snippets, and a user can paste them. This command
 * exists because pasting them correctly requires knowing a platform detail that
 * has nothing to do with SSH: on Windows the server command has to be wrapped
 * in `cmd /c`, and the two clients keep their registrations in different places
 * and formats. Automating it removes the most common "why does it say
 * ENOENT" support case.
 *
 * Conventions inherited from the sibling CLIs:
 *
 * - **All output goes to stderr**, like `setup` and unlike `doctor`. This
 *   command reports progress and failures rather than producing data to pipe,
 *   and the habit keeps stdout free of anything but JSON-RPC frames
 *   (Principle 3). The writer is injected so tests can capture it, which is
 *   also why no ESLint `no-console` exception is needed for this directory.
 * - **Exit codes carry the same meanings as `setup`**: 0 success, 1 a step
 *   failed, 2 a usage error.
 * - **No new `ERROR_CODES`.** Those describe tool responses over MCP; a CLI has
 *   an exit code and a message.
 *
 * The registered command shape lives in `config/registration.ts` and is shared
 * with `doctor`'s snippets, so the advice and the automation cannot diverge.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14. Rationale:
 * remove the friction of a user having to know about `cmd /c` wrapping on
 * Windows in order to register this server at all.
 *
 * The one place this command asks a question is the Claude Code scope, and only
 * when `--scope` is absent — see `scope.ts` for why a silent `local` default is
 * a trap. `claude-desktop` never asks, because Desktop has no scopes.
 */
import os from 'node:os';
import path from 'node:path';

import { PACKAGE_NAME } from '../config/registration.js';
import { optionValue } from '../internal/argv.js';
import { errorMessage } from '../internal/util.js';
import { PromptUnavailableError, canPrompt, inquirerAsker } from '../setup/ask.js';
import type { Asker, SelectQuestion } from '../setup/ask.js';
import { PromptAbortedError, processPrompter } from '../setup/prompt.js';
import type { Prompter } from '../setup/prompt.js';
import { defaultSpawner, installClaudeCode } from './claudeCode.js';
import type { Spawner } from './claudeCode.js';
import { installClaudeDesktop } from './desktop.js';
import { detectClaudeCode, detectClaudeDesktop } from './detect.js';
import type { ClientDetector, Detection } from './detect.js';
import { CLAUDE_CODE_SCOPES, resolveScope } from './scope.js';
import type { ClaudeCodeScope } from './scope.js';

/** Success. */
export const EXIT_OK = 0;
/** A step failed: the `claude` CLI, an unreadable config, a refused overwrite. */
export const EXIT_FAILED = 1;
/** Usage error. Same meaning as `setup`'s exit code 2. */
export const EXIT_USAGE = 2;

export const INSTALL_CLIENTS = ['claude-code', 'claude-desktop'] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

/** Default registration name. Matches the name `doctor`'s snippets use. */
export const DEFAULT_SERVER_NAME = 'ssh-mcp';

export const USAGE = [
  'Usage: ssh-mcp install [claude-code|claude-desktop] [options]',
  '',
  '클라이언트를 생략하고 터미널에서 실행하면 목록에서 고를 수 있습니다',
  '(↑↓ 이동, 이름 입력으로 좁히기, Enter 확정). 터미널이 아니면 사용법 오류로 끝냅니다.',
  '',
  'Options:',
  '  --name <name>                 등록할 MCP 서버 이름 (기본 ssh-mcp)',
  '  --scope <local|user|project>  claude-code 전용. local(기본, 현재 디렉터리의 프로젝트에서만) |',
  '                                user(모든 프로젝트) | project(.mcp.json 공유).',
  '                                생략하면 터미널에서 묻습니다.',
  '  --home <path>                 SSH_MCP_HOME 환경변수를 함께 등록합니다 (선택)',
  '  --config <path>               claude-desktop 전용. 설정 파일 경로를 재지정합니다',
  '  --force                       같은 이름이 이미 등록돼 있으면 교체합니다',
  '  --dry-run                     아무것도 바꾸지 않고 수행할 내용만 출력합니다',
  '  -h, --help                    이 도움말을 출력합니다',
  '',
  'Windows에서는 두 클라이언트 모두 `cmd /c npx -y @get-bot/ssh-mcp` 형태로 등록합니다.',
  'npx는 배치 파일(npx.cmd)이라 셸 없이 스폰하는 호스트에서는 ENOENT로 실패하기 때문입니다.',
  '그 밖의 플랫폼에서는 `npx -y @get-bot/ssh-mcp`로 등록합니다.',
  '',
  '모든 출력은 stderr로 나갑니다.',
].join('\n');

export interface InstallArgs {
  /** null when no client was named: a terminal is asked, anything else is a usage error. */
  client: InstallClient | null;
  name: string;
  /** null when `--scope` was absent: the scope is settled later, by asking. */
  scope: ClaudeCodeScope | null;
  home: string | null;
  configPath: string | null;
  force: boolean;
  dryRun: boolean;
}

export type ParsedInstallArgs =
  | { ok: true; help: false; args: InstallArgs }
  | { ok: true; help: true }
  | { ok: false; message: string };

function isInstallClient(value: string): value is InstallClient {
  return (INSTALL_CLIENTS as readonly string[]).includes(value);
}

function isScope(value: string): value is ClaudeCodeScope {
  return (CLAUDE_CODE_SCOPES as readonly string[]).includes(value);
}

/**
 * Names accepted for `--name`.
 *
 * The name reaches `cmd.exe` on the Windows `ENOENT` retry path in
 * `claudeCode.ts`, and it is also a key written into
 * `claude_desktop_config.json`. Restricting it to the characters an MCP server
 * name actually needs is the cheap half of closing that hole; the other half is
 * the metacharacter check on the retry itself. The shape matches `AliasSchema`
 * in `config/schema.ts`, which solves the same problem for host aliases.
 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Parse argv.
 *
 * Client-specific flags are rejected for the other client rather than ignored:
 * a `--scope` that silently does nothing would let somebody believe they
 * registered into the user scope when they did not.
 */
export function parseInstallArgs(
  argv: readonly string[],
  cwd: () => string = (): string => process.cwd()
): ParsedInstallArgs {
  const positional: string[] = [];
  let name: string | null = null;
  let scope: ClaudeCodeScope | null = null;
  let home: string | null = null;
  let configPath: string | null = null;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    switch (token) {
      case '-h':
      case '--help':
        return { ok: true, help: true };
      case '--force':
        force = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--name': {
        const read = optionValue(argv, i + 1, '--name');
        i += 1;
        if (!read.ok) return read;
        if (!SERVER_NAME_PATTERN.test(read.value)) {
          return {
            ok: false,
            message:
              `invalid name "${read.value}": must start with a letter or digit and contain ` +
              'only letters, digits, dot, underscore or hyphen (max 64 characters)',
          };
        }
        name = read.value;
        break;
      }
      case '--scope': {
        const read = optionValue(argv, i + 1, '--scope');
        i += 1;
        if (!read.ok) return read;
        if (!isScope(read.value)) {
          return { ok: false, message: `--scope must be one of: ${CLAUDE_CODE_SCOPES.join(', ')}` };
        }
        scope = read.value;
        break;
      }
      case '--home': {
        const read = optionValue(argv, i + 1, '--home');
        i += 1;
        if (!read.ok) return read;
        // Absolute, because the server is spawned with whatever working
        // directory the MCP host chose - a relative SSH_MCP_HOME would resolve
        // somewhere the user never looked.
        home = path.resolve(cwd(), read.value);
        break;
      }
      case '--config': {
        const read = optionValue(argv, i + 1, '--config');
        i += 1;
        if (!read.ok) return read;
        configPath = path.resolve(cwd(), read.value);
        break;
      }
      default:
        if (token.startsWith('-')) {
          return { ok: false, message: `unknown option: ${token}` };
        }
        positional.push(token);
        break;
    }
  }

  if (positional.length > 1) {
    return { ok: false, message: `unexpected extra argument: ${positional[1] ?? ''}` };
  }

  // No client is not an error here: a terminal gets asked which one. The
  // caller turns "absent and cannot ask" into the usage error.
  let client: InstallClient | null = null;
  if (positional.length === 1) {
    const raw = positional[0] ?? '';
    if (!isInstallClient(raw)) {
      return {
        ok: false,
        message: `unknown client "${raw}": expected ${INSTALL_CLIENTS.join(' or ')}`,
      };
    }
    client = raw;
  }

  // A client-specific flag with no client is rejected rather than deferred:
  // the menu would then have to refuse the other option, which is a worse place
  // to discover the mistake than the command line.
  if (scope !== null && client !== 'claude-code') {
    return {
      ok: false,
      message:
        client === null
          ? '--scope를 쓰려면 클라이언트를 함께 지정하세요: install claude-code --scope ...'
          : '--scope는 claude-code 전용입니다',
    };
  }
  if (configPath !== null && client !== 'claude-desktop') {
    return {
      ok: false,
      message:
        client === null
          ? '--config를 쓰려면 클라이언트를 함께 지정하세요: install claude-desktop --config ...'
          : '--config는 claude-desktop 전용입니다',
    };
  }

  return {
    ok: true,
    help: false,
    args: {
      client,
      name: name ?? DEFAULT_SERVER_NAME,
      scope,
      home,
      configPath,
      force,
      dryRun,
    },
  };
}

export interface InstallDeps {
  /** Injected so tests never reach the real `claude` binary. */
  spawn?: Spawner;
  /** Injected so tests can capture output; defaults to stderr. */
  write?: (text: string) => void;
  /**
   * Used only to ask for the Claude Code scope. Injected so tests can drive
   * both the TTY and the non-TTY branch without a terminal; the
   * `claude-desktop` path never touches it, because Desktop has no scopes.
   */
  prompter?: Prompter;
  /**
   * The interactive questions. Injected so tests answer them without a
   * terminal; only the default implementation touches `@inquirer`.
   */
  ask?: Asker;
  /**
   * Whether this terminal can show a question. Injected so tests describe a
   * terminal; the default is `canPrompt()` over the real streams.
   */
  canAsk?: () => boolean;
  /** Client detection for the menu hints; injected so tests describe a machine. */
  detectCode?: ClientDetector;
  detectDesktop?: ClientDetector;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** Base for resolving relative `--home` and `--config` values. */
  cwd?: () => string;
  now?: () => Date;
  packageName?: string;
}

/** What the client menu can answer. `both` runs Claude Code and then Desktop. */
export type ClientChoice = InstallClient | 'both';

/**
 * The client question, with a line per row saying whether it was detected.
 * Paths are shortened to `~/...` so a deep install directory does not push the
 * row off a narrow window.
 */
export function clientQuestion(
  code: Detection,
  desktop: Detection,
  home = ''
): SelectQuestion<ClientChoice> {
  return {
    message: '어느 클라이언트에 등록할까요?',
    choices: [
      {
        value: 'claude-code',
        name: 'Claude Code',
        description: code.found
          ? `claude 감지됨: ${shortenHome(code.where, home)}`
          : '감지되지 않음: PATH에 claude 없음',
      },
      {
        value: 'claude-desktop',
        name: 'Claude Desktop',
        description: desktop.found
          ? `설정 폴더 감지됨: ${shortenHome(desktop.where, home)}`
          : // `where` carries the reason when there is a more useful one than
            // "missing" — inside WSL the config simply lives on the other side.
            desktop.where === ''
            ? '감지되지 않음'
            : desktop.where,
      },
      { value: 'both', name: '둘 다', description: '위 두 가지를 차례로 등록합니다' },
    ],
    default: 'claude-code',
  };
}

/**
 * Replace a leading home directory with `~`, so a path fits on one row.
 *
 * The prefix has to end on a separator or at the end of the path. A plain
 * `startsWith` turns `/home/mentor/bin/claude` into `~ntor/bin/claude` for a
 * user whose home is `/home/me` — a path that points nowhere, printed as if it
 * were the one we detected.
 */
export function shortenHome(target: string, home: string): string {
  if (home === '' || !target.startsWith(home)) return target;
  const rest = target.slice(home.length);
  if (rest !== '' && rest[0] !== '/' && rest[0] !== '\\') return target;
  return `~${rest}`;
}

/**
 * Run the install flow. Returns the process exit code; never throws for an
 * expected failure.
 */
export async function runInstall(argv: readonly string[], deps: InstallDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string): void => void process.stderr.write(`${text}\n`));
  const platform = deps.platform ?? process.platform;
  const packageName = deps.packageName ?? PACKAGE_NAME;
  const cwd = deps.cwd ?? ((): string => process.cwd());

  const parsed = parseInstallArgs(argv, cwd);
  if (parsed.ok && parsed.help) {
    write(USAGE);
    return EXIT_OK;
  }
  if (!parsed.ok) {
    write(`ssh-mcp install: ${parsed.message}`);
    write('');
    write(USAGE);
    return EXIT_USAGE;
  }

  const args = parsed.args;
  const prompter = deps.prompter ?? processPrompter();
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? ((): string => os.homedir());
  const ask = deps.ask ?? inquirerAsker;
  const canAsk = (deps.canAsk ?? ((): boolean => canPrompt()))();

  let choice: ClientChoice | null = args.client;
  if (choice === null) {
    if (!canAsk) {
      // Guessing which client somebody meant is exactly the kind of help that
      // registers the server in the wrong place, so a script gets a usage error.
      write('ssh-mcp install: 등록할 클라이언트를 지정하세요.');
      // stdin is a terminal but the list cannot be drawn: say which half failed,
      // or the user reads the line above as "but I am in a terminal".
      if (prompter.interactive) {
        write('이 터미널에는 목록을 그릴 수 없습니다(TERM=dumb 또는 stderr가 터미널이 아님).');
      }
      write('  npx @get-bot/ssh-mcp install claude-code');
      write('  npx @get-bot/ssh-mcp install claude-desktop');
      write('터미널에서 인자 없이 실행하면 목록에서 고를 수 있습니다.');
      write('');
      write(USAGE);
      return EXIT_USAGE;
    }
    const detectOptions = { platform, env, homedir };
    const detect = {
      code: (deps.detectCode ?? detectClaudeCode)(detectOptions),
      desktop: (deps.detectDesktop ?? detectClaudeDesktop)(detectOptions),
    };
    try {
      choice = await ask.select(clientQuestion(detect.code, detect.desktop, homedir()));
    } catch (error) {
      if (error instanceof PromptUnavailableError) {
        write(`ssh-mcp install: ${error.message}`);
      } else if (error instanceof PromptAbortedError) {
        write('ssh-mcp install: 클라이언트를 선택하지 않았습니다. 아무것도 등록하지 않았습니다.');
      } else {
        write(`ssh-mcp install: 클라이언트 선택이 중단되었습니다 (${errorMessage(error)}).`);
      }
      return EXIT_FAILED;
    }
  }

  const runDesktop = (): boolean =>
    installClaudeDesktop({
      name: args.name,
      home: args.home,
      configPath: args.configPath,
      force: args.force,
      dryRun: args.dryRun,
      platform,
      packageName,
      env,
      homedir,
      now: deps.now ?? ((): Date => new Date()),
      write,
    });

  if (choice === 'claude-desktop') {
    // Desktop has no scopes, so neither the menu nor the prompter is consulted.
    return runDesktop() ? EXIT_OK : EXIT_FAILED;
  }

  const workingDir = cwd();
  // Settled before anything runs, so `--dry-run` prints the scope it would
  // actually use rather than a guess.
  const scope = await resolveScope({
    requested: args.scope,
    canAsk,
    ask,
    cwd: workingDir,
    write,
  });
  if (scope === null) return EXIT_FAILED;

  const codeOk = installClaudeCode({
    name: args.name,
    scope,
    cwd: workingDir,
    home: args.home,
    force: args.force,
    dryRun: args.dryRun,
    platform,
    packageName,
    spawn: deps.spawn ?? defaultSpawner,
    write,
  });

  if (choice === 'claude-code') return codeOk ? EXIT_OK : EXIT_FAILED;

  // "both": Desktop runs even when Claude Code failed, because the two
  // registrations are independent and a half-finished setup is worse than a
  // reported one. The summary says what actually happened.
  write('');
  const desktopOk = runDesktop();
  write('');
  // A dry run registered nothing, so it must not claim it did. Failure reads
  // the same either way: a refused dry run is still a refusal.
  const succeeded = args.dryRun ? '등록 예정' : '등록 완료';
  const prefix = args.dryRun ? '[dry-run] ' : '';
  write(
    `${prefix}Claude Code: ${codeOk ? succeeded : '실패'} / Claude Desktop: ${desktopOk ? succeeded : '실패'}`
  );
  return codeOk && desktopOk ? EXIT_OK : EXIT_FAILED;
}
