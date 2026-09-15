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
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

/** Tokens the router treats as a request for this help. */
export const HELP_TOKENS = ['help', '--help', '-h'] as const;

/** Topics `help <topic>` will forward to, i.e. what the router can route. */
export const HELP_TOPICS = ['install', 'host', 'doctor', 'setup'] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

export const USAGE = [
  'Usage: ssh-mcp [<command>] [options]',
  '',
  '인자 없이 실행하면 stdio MCP 서버로 동작합니다. 이 형태는 보통 직접 치지 않고',
  'Claude Code 같은 클라이언트가 실행합니다.',
  '',
  'Commands:',
  '  install [claude-code|claude-desktop]   이 서버를 클라이언트에 등록합니다.',
  '  host add [<alias> <user@host[:port]>]  호스트를 등록합니다(키 생성·지문 고정).',
  '  host list [--json]                     등록된 호스트를 표로 출력합니다.',
  '  doctor [--json] [--patterns]           설정·키·연결 상태를 진단합니다.',
  '  help [<command>]                       이 도움말, 또는 해당 명령의 사용법.',
  '',
  'Options:',
  '  -v, --version                          버전을 출력합니다.',
  '  -h, --help                             이 도움말을 출력합니다.',
  '',
  '빠른 시작:',
  '  npx -y @get-bot/ssh-mcp install        클라이언트에 등록',
  '  npx -y @get-bot/ssh-mcp host add       호스트 등록',
  '  npx -y @get-bot/ssh-mcp doctor         확인',
  '',
  '`ssh-mcp setup`은 `ssh-mcp host add`의 별칭으로 계속 동작합니다.',
].join('\n');

export interface HelpDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  /**
   * Runs `<topic> --help` through the top-level router. Supplied by `index.ts`;
   * tests pass a fake so this module can be exercised without starting anything.
   */
  delegate?: (topic: HelpTopic) => Promise<number>;
}

/**
 * Print the command overview, or forward to one command's own usage.
 *
 * `argv` is what followed the help token, so `ssh-mcp help doctor` arrives here
 * as `['doctor']`. Help that was asked for is not an error and goes to stdout
 * (exit 0); a topic nobody has is a usage error and goes to stderr (exit 2) —
 * the same split `host` already makes.
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
    return deps.delegate(topic);
  }

  // `help help` is not worth a special case: nobody has a usage string for it,
  // and the overview is the honest answer.
  if (isHelpTopic(topic) || (HELP_TOKENS as readonly string[]).includes(topic)) {
    out(USAGE);
    return EXIT_OK;
  }

  err(`ssh-mcp help: unknown command "${topic}": expected ${HELP_TOPICS.join(', ')}`);
  err('');
  err(USAGE);
  return EXIT_USAGE;
}
