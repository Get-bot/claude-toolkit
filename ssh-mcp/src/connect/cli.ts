/**
 * `ssh-mcp connect <alias>` — an interactive shell on a registered host
 * (plan F7, AC-C1, AC-C3, AC-C5).
 *
 * This is the path a **person** types, and it is deliberately not the path the
 * model takes. Nothing here classifies a command, asks for approval, writes an
 * audit line or excerpts output (D6, AC-C4): those exist because a model's
 * command arrives without anyone having read it, which is not the situation
 * when someone is sitting at the terminal. Host-key trust moves with it — the
 * fingerprint pinned in `hosts.json` is not consulted, OpenSSH's `known_hosts`
 * is, so the two can disagree and the README says so.
 *
 * What this module *is*, then, is a lookup: turn an alias into the flags a
 * person would otherwise have to remember, and get out of the way. Everything
 * it shares with `exec` lives in {@link runSshDelegate}.
 *
 * Exit codes follow the surrounding CLIs: 0 when `ssh` said 0, `ssh`'s own code
 * when it said something else, 1 for "this machine cannot do it" (no `ssh`,
 * unreadable registry) and 2 for "you asked for something that does not exist"
 * (unknown alias, bad usage). AC-C3 fixes the last two.
 */
import * as store from '../config/store.js';
import { ERROR_CODES } from '../errors.js';
import { buildSshArgs, resolveSshBinary, spawnSsh, sshMissingMessage } from './ssh.js';
import type { SshSpawner } from './ssh.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Usage: ssh-mcp connect <alias>',
  '',
  '등록된 호스트에 시스템 ssh로 접속합니다. 터미널을 그대로 넘겨주므로',
  '`ssh -i <키> -p <포트> <사용자>@<호스트>`를 직접 친 것과 같습니다.',
  '',
  'Options:',
  '  -h, --help  이 도움말을 출력합니다.',
  '',
  '이 경로는 사람이 직접 쓰는 통로입니다. 명령 분류·승인·감사·출력 발췌를 거치지',
  '않고, 호스트 키 확인도 ssh-mcp에 고정된 지문이 아니라 OpenSSH의 known_hosts를',
  '따릅니다. MCP 도구는 종전대로 순수 JS ssh2를 씁니다.',
].join('\n');

export interface ConnectDeps {
  /** Defaults to stdout. */
  out?: (text: string) => void;
  /** Defaults to stderr; errors and usage go here. */
  err?: (text: string) => void;
  /** Defaults to the real registry. Injected by tests. */
  load?: () => store.ConfigLoadResult;
  /** Defaults to the real `PATH` scan. Injected by tests. */
  resolveSsh?: () => string | null;
  /** Defaults to the real spawn. Injected by tests (AC-C7). */
  spawn?: SshSpawner;
  /** Defaults to `process.platform`; only selects the install hint's wording. */
  platform?: NodeJS.Platform;
}

/** `out`/`err` with the default writers filled in, shared by both commands. */
export function writers(deps: ConnectDeps): {
  out: (text: string) => void;
  err: (text: string) => void;
} {
  return {
    out: deps.out ?? ((text: string): void => void process.stdout.write(`${text}\n`)),
    err: deps.err ?? ((text: string): void => void process.stderr.write(`${text}\n`)),
  };
}

/**
 * Everything `connect` and `exec` do identically: look the alias up, look
 * `ssh` up, hand over the terminal.
 *
 * `trailing` is what follows the destination in the argv — nothing for
 * `connect`, the words after `--` for `exec`. It is appended verbatim, one
 * array element per token, which is the whole of AC-C2: no joining, no
 * quoting, no re-splitting.
 *
 * The order of the two lookups matters. A missing `ssh` is reported only after
 * the alias is known to exist, so someone who typo'd an alias on a machine
 * without OpenSSH is told about the typo — the thing they can fix — rather than
 * being sent to install a package they may not need.
 */
export async function runSshDelegate(
  command: 'connect' | 'exec',
  alias: string,
  trailing: readonly string[],
  deps: ConnectDeps
): Promise<number> {
  const { err } = writers(deps);

  const loaded = (deps.load ?? store.load)();
  if (!loaded.ok) {
    err(`ssh-mcp ${command}: ${loaded.code}: ${loaded.message}`);
    for (const issue of loaded.issues) err(`  - ${issue.path}: ${issue.message}`);
    err('hosts.json을 고친 뒤 다시 실행하세요.');
    return EXIT_FAILED;
  }

  const entry = loaded.file.hosts[alias];
  if (entry === undefined) {
    err(`ssh-mcp ${command}: ${ERROR_CODES.host_not_found}: 등록되지 않은 alias "${alias}"입니다.`);
    err('`ssh-mcp host list`로 등록된 alias를 확인하거나 `ssh-mcp host add`로 추가하세요.');
    return EXIT_USAGE;
  }

  const binary = (deps.resolveSsh ?? resolveSshBinary)();
  if (binary === null) {
    err(sshMissingMessage(deps.platform ?? process.platform));
    return EXIT_FAILED;
  }

  const spawn = deps.spawn ?? spawnSsh;
  return spawn(binary, [...buildSshArgs(entry), ...trailing]);
}

/** Run `connect`. Returns the process exit code. */
export async function runConnect(argv: readonly string[], deps: ConnectDeps = {}): Promise<number> {
  const { out, err } = writers(deps);

  for (const token of argv) {
    if (token === '-h' || token === '--help') {
      // Help that was asked for is not an error, so it goes to stdout — the
      // same split `doctor` and `host list` make (AC-C5).
      out(USAGE);
      return EXIT_OK;
    }
  }

  const alias = argv[0];
  if (alias === undefined) {
    err('ssh-mcp connect: alias가 필요합니다.');
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }
  if (argv.length > 1) {
    // `connect` takes no ssh options of its own. Silently forwarding extra
    // words would make `ssh-mcp connect web1 -X` look supported while the flag
    // landed after the destination, where ssh treats it as a remote command.
    err(`ssh-mcp connect: unexpected extra argument: ${argv[1] ?? ''}`);
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }

  return runSshDelegate('connect', alias, [], deps);
}
