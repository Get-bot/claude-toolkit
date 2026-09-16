/**
 * `ssh-mcp help`, `--help`, `-h` — the one place that says what the commands are.
 *
 * Until this existed, every one of those three fell through the router into
 * server mode: `ssh-mcp --help` printed nothing, started a stdio MCP server and
 * sat there waiting on stdin. Someone asking a program what it does got silence
 * and a hung terminal, which is the worst possible answer to the most basic
 * question. The sub-commands each had `--help` already; the top level did not.
 *
 * `help <command>` forwards rather than repeating anything. The sub-command
 * usage strings are the source of truth for their own flags, so duplicating a
 * summary here would only create two places to update and one of them would go
 * stale. The commands come from the table in `commands.ts`, which is also what
 * the router routes on, so this module cannot know a command the router lacks
 * or miss one it has.
 *
 * `commands.ts` is the only import, and nothing runs at load time: the router
 * imports this module statically at no measurable cost to server-mode startup.
 */
import { COMMANDS, COMMAND_NAMES, HELP_TOKENS, VERSION_TOKENS, isCommandName } from './commands.js';
import type { CommandTable } from './commands.js';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

/**
 * `help help` and `help version` are not worth special cases: neither has a
 * usage string of its own, and the overview is the honest answer to both.
 * Rejecting `help version` as unknown would be wrong, since `ssh-mcp version`
 * is a command that works; it gets the overview, where `version` is listed.
 */
const OVERVIEW_TOKENS: readonly string[] = [...HELP_TOKENS, ...VERSION_TOKENS];

/**
 * Descriptions start at this column. Kept as a number rather than eyeballed
 * so the width test can say which side of a line overflowed.
 */
export const USAGE_DESCRIPTION_COLUMN = 41;

/**
 * Terminal columns the overview must fit in. 80 is the floor a terminal is
 * allowed to be; Korean glyphs take two columns each, so this is measured in
 * display width, not string length.
 */
export const USAGE_MAX_COLUMNS = 80;

export const USAGE = [
  'Usage: ssh-mcp [<command>] [options]',
  '',
  '인자 없이 실행하면 stdio MCP 서버로 동작합니다. 이 형태는 보통 직접 치지 않고',
  'Claude Code 같은 클라이언트가 실행합니다.',
  '',
  'Commands:',
  '  install [claude-code|claude-desktop]   이 서버를 클라이언트에 등록합니다.',
  '  host add [<alias> <user@host[:port]>]  호스트 등록(키 생성·지문 고정).',
  '  host list [--json]                     등록된 호스트를 표로 출력합니다.',
  '  doctor [--json] [--patterns]           설정·키·연결 상태를 진단합니다.',
  '  help [<command> ...]                   이 도움말, 또는 해당 명령의 사용법.',
  '',
  'Options:',
  '  -v, --version, version                 버전을 출력합니다.',
  '  -h, --help                             이 도움말을 출력합니다.',
  '',
  '빠른 시작:',
  '  npm i -g @get-bot/ssh-mcp              전역 설치. 이후 `ssh-mcp`로 실행',
  '  ssh-mcp install                        클라이언트에 등록',
  '  ssh-mcp host add                       호스트 등록',
  '  ssh-mcp doctor                         확인',
  '',
  '설치 없이 쓰려면 `ssh-mcp` 자리에 `npx -y @get-bot/ssh-mcp`를 씁니다.',
  '`ssh-mcp setup`은 `ssh-mcp host add`의 별칭으로 계속 동작합니다.',
].join('\n');

export interface HelpDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** The commands to forward into. Tests substitute fakes for {@link COMMANDS}. */
  commands?: CommandTable;
}

/**
 * Print the command overview, or forward to one command's own usage.
 *
 * `argv` is what followed the help token, so `ssh-mcp help doctor` arrives here
 * as `['doctor']`. The overview goes to stdout with exit 0: help that was asked
 * for is not an error. A command nobody has is a usage error and goes to stderr
 * with exit 2 — the same split `host` already makes. A forwarded command writes
 * wherever it writes its own `--help`.
 *
 * Everything after the command is forwarded as typed: `help host add` becomes
 * `host add --help`, which is what the person meant, rather than the `host`
 * group usage with the `add` silently dropped. Whatever the command makes of
 * the extra words is its business — its own parser already knows how to refuse
 * an argument it does not take.
 *
 * A loader that rejects is not caught here. It would mean the sub-command
 * module itself failed to load or threw before parsing, and `main()` in
 * `index.ts` already turns that into `ssh-mcp failed: …` with exit 1; wrapping
 * it in a help-shaped message would hide which command is broken.
 */
export async function runHelp(argv: readonly string[], deps: HelpDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(`${text}\n`));
  const [command, ...rest] = argv;

  if (command === undefined || OVERVIEW_TOKENS.includes(command)) {
    out(USAGE);
    return EXIT_OK;
  }

  if (isCommandName(command)) {
    const runCommand = await (deps.commands ?? COMMANDS)[command]();
    return runCommand([...rest, '--help']);
  }

  err(`ssh-mcp help: unknown command "${command}": expected ${COMMAND_NAMES.join(', ')}`);
  err('');
  err(USAGE);
  return EXIT_USAGE;
}
