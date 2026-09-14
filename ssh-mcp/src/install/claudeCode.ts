/**
 * `ssh-mcp install claude-code` — registration through the `claude` CLI.
 *
 * Claude Code owns its own MCP registry (`~/.claude.json` and the project and
 * user scopes around it), and its format is not a published contract. Editing
 * those files directly would make this package responsible for a shape that can
 * change under it, so the registration is delegated to `claude mcp add` and we
 * only own the argv.
 *
 * Two details are deliberate:
 *
 * - **The spawner is injected.** A unit test must never reach the developer's
 *   real `claude` binary and mutate their real registry, so `Spawner` is a
 *   parameter and only {@link defaultSpawner} touches the process table (same
 *   reasoning as `setup`'s `Connector` and `IcaclsRunner`).
 * - **`ENOENT` is retried through `cmd /c` on Windows.** A `claude` installed
 *   through npm is `claude.cmd`, a batch file, and `spawnSync` without a shell
 *   cannot resolve it — exactly the failure mode the registered server command
 *   works around. A native `claude.exe` (the current installer) needs no retry,
 *   which is why the direct spawn is tried first.
 *
 * Failure never leaves the user stuck: when `claude` cannot be found at all we
 * print the exact line a human can paste into a terminal. That line is also the
 * answer when the `cmd /c` retry is refused — see {@link CMD_METACHARACTERS}
 * for why a retry is sometimes refused rather than escaped.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14. Rationale:
 * remove the friction of a user having to know about `cmd /c` wrapping on
 * Windows in order to register this server at all.
 */
import { spawnSync } from 'node:child_process';

import { buildServerCommand, formatServerCommand } from '../config/registration.js';
import { scopeMeaning } from './scope.js';
import type { ClaudeCodeScope } from './scope.js';

/** The CLI we drive. Not configurable: `claude mcp add` is the only supported path. */
const CLAUDE_BIN = 'claude';

/** The subset of `spawnSync`'s result this command reads. */
export interface SpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type Spawner = (command: string, args: readonly string[]) => SpawnOutcome;

/** The only spawner that starts a real process. */
export function defaultSpawner(command: string, args: readonly string[]): SpawnOutcome {
  const result = spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true });
  const outcome: SpawnOutcome = {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  return result.error === undefined ? outcome : { ...outcome, error: result.error };
}

export interface ClaudeCodeInstallOptions {
  name: string;
  /** Already settled by `resolveScope()`; this module never asks. */
  scope: ClaudeCodeScope;
  /** Absolute working directory, so the success message can say what `local` covers. */
  cwd: string;
  /** `SSH_MCP_HOME` to register alongside the server, or null. */
  home: string | null;
  force: boolean;
  dryRun: boolean;
  platform: NodeJS.Platform;
  packageName: string;
  spawn: Spawner;
  write: (text: string) => void;
}

/**
 * argv for `claude mcp add`.
 *
 * `-s` is always passed, even for the default scope, so the printed dry-run
 * line is the same command a human can paste — an implicit default is not
 * something the reader of a log can verify.
 */
export function buildAddArgs(options: ClaudeCodeInstallOptions): string[] {
  const server = buildServerCommand({
    platform: options.platform,
    packageName: options.packageName,
  });
  const env = options.home === null ? [] : ['-e', `SSH_MCP_HOME=${options.home}`];
  return [
    'mcp',
    'add',
    options.name,
    '-s',
    options.scope,
    ...env,
    '--',
    server.command,
    ...server.args,
  ];
}

/** argv for the `--force` pre-step. Its failure is expected and ignored. */
export function buildRemoveArgs(options: ClaudeCodeInstallOptions): string[] {
  return ['mcp', 'remove', '-s', options.scope, options.name];
}

/**
 * The command line as a human would type it.
 *
 * This string is printed for a person to paste, so an argument that would split
 * on paste has to be quoted: `-e SSH_MCP_HOME=C:\Program Files\ssh-mcp` becomes
 * two arguments otherwise. Double quotes are what both PowerShell and `cmd.exe`
 * understand, which is as far as this needs to go — it is display text, not a
 * command we execute, so a fully shell-correct quoter would be effort spent on
 * a string nothing parses.
 */
function quoteForDisplay(arg: string): string {
  if (arg !== '' && !/[\s&|<>^%!"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/gu, '\\"')}"`;
}

function commandLine(argv: readonly string[]): string {
  return [CLAUDE_BIN, ...argv].map(quoteForDisplay).join(' ');
}

/**
 * Characters `cmd.exe` interprets before the program ever sees them.
 *
 * The direct spawn passes argv straight to the child and is safe. The `cmd /c`
 * retry is not: libuv quotes an argument only when it contains whitespace, so a
 * `--home C:\R&D\ssh-mcp` reaches `cmd.exe` unquoted and `&` starts a second
 * command. Whitespace is fine for exactly that reason and is not listed here.
 */
const CMD_METACHARACTERS = /[&|<>^%!"]/u;

interface ClaudeRun {
  outcome: SpawnOutcome;
  /** True when the `cmd /c` retry was refused because argv carries {@link CMD_METACHARACTERS}. */
  fallbackRefused: boolean;
  /** True when the outcome came from the `cmd /c` retry rather than the direct spawn. */
  viaCmd: boolean;
}

/**
 * Run `claude` once, falling back to `cmd /c claude` on Windows when the direct
 * spawn cannot find the binary. (A name that exists on PATH only as a `.cmd`
 * behaves exactly like this: `ENOENT` direct, fine through `cmd`.)
 *
 * The fallback is skipped — not escaped — when any argument carries a character
 * `cmd.exe` would act on. Quoting for `cmd.exe` correctly is a known-hard
 * problem, and the cost of getting it wrong here is arbitrary command execution
 * on the user's machine; refusing and printing the manual command loses nothing
 * but one convenience on an already-degraded path.
 *
 * `guard` extends that check to argv this run does not use. `--force` runs
 * `remove` before `add`, and only `add` carries `-e SSH_MCP_HOME=...`: checking
 * each command on its own would let `remove` go through and `add` be refused,
 * leaving the user with the registration **deleted** and nothing put back. The
 * decision has to be made once, for the whole sequence, before anything runs.
 */
function runClaude(
  options: ClaudeCodeInstallOptions,
  argv: readonly string[],
  guard: readonly string[] = []
): ClaudeRun {
  const direct = options.spawn(CLAUDE_BIN, argv);
  if (direct.error?.code !== 'ENOENT' || options.platform !== 'win32') {
    return { outcome: direct, fallbackRefused: false, viaCmd: false };
  }
  if ([...argv, ...guard].some((arg) => CMD_METACHARACTERS.test(arg))) {
    return { outcome: direct, fallbackRefused: true, viaCmd: false };
  }
  return {
    outcome: options.spawn('cmd', ['/c', CLAUDE_BIN, ...argv]),
    fallbackRefused: false,
    viaCmd: true,
  };
}

/** Relay the child's own words verbatim — to stderr, like everything else here. */
function relay(options: ClaudeCodeInstallOptions, outcome: SpawnOutcome): void {
  for (const stream of [outcome.stdout, outcome.stderr]) {
    const text = stream.replace(/\s+$/u, '');
    if (text !== '') options.write(text);
  }
}

function manualCommand(options: ClaudeCodeInstallOptions, addArgv: readonly string[]): void {
  options.write('직접 아래 명령을 실행해 등록하세요:');
  options.write(`  ${commandLine(addArgv)}`);
}

function reportMissingClaude(options: ClaudeCodeInstallOptions, addArgv: readonly string[]): void {
  options.write('ssh-mcp install: Claude Code CLI(`claude`)를 PATH에서 찾을 수 없습니다.');
  options.write('Claude Code를 설치한 뒤, 또는 직접 아래 명령을 실행해 등록하세요:');
  options.write(`  ${commandLine(addArgv)}`);
}

function reportRefusedFallback(
  options: ClaudeCodeInstallOptions,
  addArgv: readonly string[]
): void {
  options.write('ssh-mcp install: Claude Code CLI(`claude`)를 PATH에서 찾을 수 없습니다.');
  options.write(
    'cmd 경유 재시도는 이 문자를 안전하게 전달할 수 없습니다: & | < > ^ % ! " — ' +
      '인자에 그중 하나가 들어 있어 재시도하지 않았습니다.'
  );
  manualCommand(options, addArgv);
}

/** Returns true on success. The caller maps that onto the process exit code. */
export function installClaudeCode(options: ClaudeCodeInstallOptions): boolean {
  const addArgv = buildAddArgs(options);
  const removeArgv = buildRemoveArgs(options);

  if (options.dryRun) {
    options.write('[dry-run] 아무것도 바꾸지 않았습니다. 실행할 명령:');
    if (options.force) options.write(`  ${commandLine(removeArgv)}`);
    options.write(`  ${commandLine(addArgv)}`);
    return true;
  }

  if (options.force) {
    // `addArgv` is passed as the guard so the whole sequence is decided before
    // `remove` runs: refusing only `add` would delete the registration and put
    // nothing back.
    const removed = runClaude(options, removeArgv, addArgv);
    if (removed.fallbackRefused) {
      reportRefusedFallback(options, addArgv);
      return false;
    }
    // A spawn error is left unreported on purpose: `add` below hits the same
    // failure and diagnoses it in full, so a message here would only precede
    // the real one with noise.
    if (removed.outcome.error === undefined) {
      if (removed.outcome.status === 0) {
        relay(options, removed.outcome);
      } else {
        // "No MCP server named X" is the normal answer when the name was never
        // registered, so a non-zero remove is never fatal — and relaying that
        // error would read like a failure in a run that is about to succeed.
        options.write(`기존 등록이 없어 remove는 건너뜁니다 (${options.name}).`);
      }
    }
  }

  const added = runClaude(options, addArgv);
  if (added.fallbackRefused) {
    reportRefusedFallback(options, addArgv);
    return false;
  }
  if (added.outcome.error?.code === 'ENOENT') {
    reportMissingClaude(options, addArgv);
    return false;
  }
  if (added.outcome.error !== undefined) {
    options.write(`ssh-mcp install: claude 실행에 실패했습니다: ${added.outcome.error.message}`);
    manualCommand(options, addArgv);
    return false;
  }

  relay(options, added.outcome);
  if (added.outcome.status !== 0) {
    // `status` is null when the child died on a signal; printing "exit code
    // null" would send the reader looking for a code that never existed.
    options.write(
      added.outcome.status === null
        ? 'ssh-mcp install: claude mcp add가 시그널로 종료됐습니다.'
        : `ssh-mcp install: claude mcp add가 종료 코드 ${String(added.outcome.status)}로 끝났습니다.`
    );
    if (added.viaCmd) {
      // The direct spawn already said ENOENT, so cmd.exe's non-zero exit most
      // likely means "claude is not installed" rather than anything about the
      // registration. Saying "try --force" here would send the reader the wrong
      // way entirely.
      options.write(
        'ssh-mcp install: cmd 경유 재시도였습니다. `claude`가 설치되어 PATH에 있는지 먼저 확인하세요.'
      );
      manualCommand(options, addArgv);
    } else if (!options.force) {
      options.write('같은 이름이 이미 등록돼 있다면 --force를 붙여 교체하세요.');
    }
    return false;
  }

  const server = buildServerCommand({
    platform: options.platform,
    packageName: options.packageName,
  });
  options.write(
    `Claude Code에 "${options.name}"을(를) ${options.scope} 스코프로 등록했습니다: ` +
      formatServerCommand(server)
  );
  // "Registered" is not the same as "visible where you work", and `local` in
  // particular binds to one directory. Say which.
  options.write(scopeMeaning(options.scope, options.cwd));
  if (options.home !== null) options.write(`SSH_MCP_HOME=${options.home}`);
  options.write('확인: `claude mcp list`, 또는 Claude Code 안에서 `/mcp`.');
  return true;
}
