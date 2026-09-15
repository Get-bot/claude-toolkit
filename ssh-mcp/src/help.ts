/**
 * `ssh-mcp help`, `--help`, `-h` — the one place that says what the commands are.
 *
 * Until this existed, every one of those three fell through the router into
 * server mode: `ssh-mcp --help` printed nothing, started a stdio MCP server and
 * sat there waiting on stdin. Someone asking a program what it does got silence
 * and a hung terminal, which is the worst possible answer to the most basic
 * question. The sub-commands each had `--help` already; the top level did not.
 *
 * `help <command>` delegates rather than repeating anything. The sub-command
 * usage strings are the source of truth for their own flags, so duplicating a
 * summary here would only create two places to update and one of them would go
 * stale. Delegation is injected (`HelpDeps.delegate`) because the router lives
 * in `index.ts`, which cannot be imported from here — importing it would run
 * the CLI again.
 *
 * This module has no imports and no top-level side effects on purpose: the
 * router imports it statically so that {@link HELP_TOKENS} is read by the code
 * that routes on it, and a static import of a file that is only string
 * literals costs server-mode startup nothing measurable.
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

/**
 * Tokens the router treats as a request for this help.
 *
 * `index.ts` reads this table, so adding a spelling here is the whole change.
 * A copy in the router would be the bug this file exists to fix, waiting to
 * come back: a spelling added here but not there falls through to server mode.
 */
export const HELP_TOKENS = ['help', '--help', '-h'] as const;

/**
 * The router's other non-command tokens. `help version` has nothing to forward
 * to — there is no usage string for a flag — but rejecting it as unknown would
 * be wrong too, since `ssh-mcp version` is a command that works. It gets the
 * overview, where `version` is listed.
 */
export const VERSION_TOKENS = ['version', '--version', '-v'] as const;

/**
 * Topics `help <topic>` will forward to.
 *
 * This mirrors the command branches in `index.ts` and cannot be derived from
 * them: the router is a chain of string compares in a module nothing may
 * import. So a new top-level command is added in both places, and
 * `tests/unit/helpCommand.test.ts` pins this list so the second place is not
 * forgotten silently.
 */
export const HELP_TOPICS = ['install', 'host', 'doctor', 'setup'] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

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
  /**
   * Runs `<topic> <rest...> --help` through the top-level router. Supplied by
   * `index.ts`; tests pass a fake so this module can be exercised without
   * starting anything.
   *
   * `rest` is everything after the topic, forwarded as typed: `help host add`
   * becomes `host add --help`, which is what the person meant, rather than the
   * `host` group usage with the `add` silently dropped. Whatever the topic
   * makes of the extra words is its business — its own parser already knows
   * how to refuse an argument it does not take.
   */
  delegate?: (topic: HelpTopic, rest: readonly string[]) => Promise<number>;
}

/**
 * Print the command overview, or forward to one command's own usage.
 *
 * `argv` is what followed the help token, so `ssh-mcp help doctor` arrives here
 * as `['doctor']`. The overview goes to stdout with exit 0: help that was asked
 * for is not an error. A topic nobody has is a usage error and goes to stderr
 * with exit 2 — the same split `host` already makes. A forwarded topic writes
 * wherever that command writes its own `--help`.
 *
 * A delegate that rejects is not caught here. It would mean the sub-command
 * module itself failed to load or threw before parsing, and `main()` in
 * `index.ts` already turns that into `ssh-mcp failed: …` with exit 1; wrapping
 * it in a help-shaped message would hide which command is broken.
 */
export async function runHelp(argv: readonly string[], deps: HelpDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(`${text}\n`));

  const topic = argv[0];
  if (topic === undefined) {
    out(USAGE);
    return EXIT_OK;
  }

  if (isHelpTopic(topic) && deps.delegate !== undefined) {
    return deps.delegate(topic, argv.slice(1));
  }

  // `help help` and `help version` are not worth special cases: neither has a
  // usage string of its own, and the overview is the honest answer to both.
  const overviewTokens: readonly string[] = [...HELP_TOKENS, ...VERSION_TOKENS];
  if (isHelpTopic(topic) || overviewTokens.includes(topic)) {
    out(USAGE);
    return EXIT_OK;
  }

  err(`ssh-mcp help: unknown command "${topic}": expected ${HELP_TOPICS.join(', ')}`);
  err('');
  err(USAGE);
  return EXIT_USAGE;
}
