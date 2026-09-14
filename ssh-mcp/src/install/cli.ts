/**
 * `ssh-mcp install <claude-code|claude-desktop>` — register this server with an
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
import { processPrompter } from '../setup/prompt.js';
import type { Prompter } from '../setup/prompt.js';
import { defaultSpawner, installClaudeCode } from './claudeCode.js';
import type { Spawner } from './claudeCode.js';
import { installClaudeDesktop } from './desktop.js';
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
  'Usage: ssh-mcp install <claude-code|claude-desktop> [options]',
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
  client: InstallClient;
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

type OptionValue = { ok: true; value: string } | { ok: false; message: string };

/**
 * Read the value that follows a value-taking option.
 *
 * A token starting with `-` is refused rather than consumed. Without this,
 * `install claude-desktop --config <path> --home --dry-run` registers
 * `SSH_MCP_HOME=--dry-run` **and writes the file for real**, because the very
 * flag meant to prevent the write was swallowed as data. Every value-taking
 * flag goes through here so no one has to remember the guard again.
 */
function optionValue(argv: readonly string[], index: number, flag: string): OptionValue {
  const value = argv[index];
  if (value === undefined || value === '') {
    return { ok: false, message: `${flag} needs a value` };
  }
  if (value.startsWith('-')) {
    return { ok: false, message: `${flag} needs a value, but got the option "${value}"` };
  }
  return { ok: true, value };
}

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

  if (positional.length === 0) {
    return { ok: false, message: `install needs a client: ${INSTALL_CLIENTS.join(' | ')}` };
  }
  if (positional.length > 1) {
    return { ok: false, message: `unexpected extra argument: ${positional[1] ?? ''}` };
  }

  const client = positional[0] ?? '';
  if (!isInstallClient(client)) {
    return {
      ok: false,
      message: `unknown client "${client}": expected ${INSTALL_CLIENTS.join(' or ')}`,
    };
  }

  if (scope !== null && client !== 'claude-code') {
    return { ok: false, message: '--scope는 claude-code 전용입니다' };
  }
  if (configPath !== null && client !== 'claude-desktop') {
    return { ok: false, message: '--config는 claude-desktop 전용입니다' };
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
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** Base for resolving relative `--home` and `--config` values. */
  cwd?: () => string;
  now?: () => Date;
  packageName?: string;
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

  if (args.client === 'claude-desktop') {
    // Desktop has no scopes, so the prompter is never consulted on this path.
    const ok = installClaudeDesktop({
      name: args.name,
      home: args.home,
      configPath: args.configPath,
      force: args.force,
      dryRun: args.dryRun,
      platform,
      packageName,
      env: deps.env ?? process.env,
      homedir: deps.homedir ?? ((): string => os.homedir()),
      now: deps.now ?? ((): Date => new Date()),
      write,
    });
    return ok ? EXIT_OK : EXIT_FAILED;
  }

  const workingDir = cwd();
  // Settled before anything runs, so `--dry-run` prints the scope it would
  // actually use rather than a guess.
  const scope = await resolveScope({
    requested: args.scope,
    prompter: deps.prompter ?? processPrompter(),
    cwd: workingDir,
    write,
  });
  if (scope === null) return EXIT_FAILED;

  const ok = installClaudeCode({
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

  return ok ? EXIT_OK : EXIT_FAILED;
}
