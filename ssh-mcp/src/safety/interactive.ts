/**
 * Interactive-program gate (plan row 2.8, OPT-1).
 *
 * v1 never allocates a PTY: a PTY merges stdout and stderr (breaking AC10) and
 * fills the stream with ANSI escapes (breaking the session marker protocol).
 * So a command that needs a terminal cannot work, and waiting 60 seconds to
 * discover that is the worst possible answer. We refuse up front and hand back
 * a concrete replacement command.
 *
 * **This gate is not a risk judgement.** It answers "does this need a
 * terminal?" and nothing else. `mysql -e "DROP DATABASE prod"` passes here and
 * is then caught by the classifier (Critic C14). Nothing becomes safe by
 * passing this gate.
 */
import { normalize } from './normalize.js';
import type { NormalizeResult, Segment, Token } from './normalize.js';

/** Refused whatever the arguments are (OPT-1, 22 programs). */
export const UNCONDITIONAL_PROGRAMS: readonly string[] = [
  'vim',
  'vi',
  'nvim',
  'emacs',
  'nano',
  'pico',
  'joe',
  'htop',
  'btop',
  'atop',
  'iotop',
  'less',
  'more',
  'man',
  'watch',
  'tmux',
  'screen',
  'dialog',
  'whiptail',
  'visudo',
  'passwd',
];

const EDITOR_ALTERNATIVES = [
  'download the file, edit it locally, then upload: download {host, remote_path, local_path}',
  "or write it in one shot: cat > <file> <<'EOF' … EOF",
];

const PAGER_ALTERNATIVES = [
  "sed -n '1,200p' <file>",
  'head -n 200 <file>',
  'tail -n 200 <file>',
  'grep -n <pattern> <file>',
];

/** `top -b -n 1` is allowed (batch mode), so it leads every suggestion here. */
const TOP_ALTERNATIVES = ['top -b -n 1', 'ps aux --sort=-%cpu | head -20'];

const PROCESS_VIEWER_ALTERNATIVES = [
  'top -b -n 1',
  'ps aux --sort=-%cpu | head -20',
  'ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu | head -20',
];

/** Concrete replacements, keyed by program (OPT-1 "응답"). */
const ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  vim: EDITOR_ALTERNATIVES,
  vi: EDITOR_ALTERNATIVES,
  nvim: EDITOR_ALTERNATIVES,
  emacs: EDITOR_ALTERNATIVES,
  nano: EDITOR_ALTERNATIVES,
  pico: EDITOR_ALTERNATIVES,
  joe: EDITOR_ALTERNATIVES,
  less: PAGER_ALTERNATIVES,
  more: PAGER_ALTERNATIVES,
  top: TOP_ALTERNATIVES,
  htop: PROCESS_VIEWER_ALTERNATIVES,
  btop: PROCESS_VIEWER_ALTERNATIVES,
  atop: PROCESS_VIEWER_ALTERNATIVES,
  iotop: ['ps aux --sort=-%cpu | head -20', 'cat /proc/diskstats'],
  man: ['<command> --help', '<command> -h', "sed -n '1,200p' $(command -v <command>)"],
  watch: ['call run_in_session repeatedly instead of watching', 'ps aux | head -20'],
  tmux: ['open_session {host} keeps cwd and environment between calls'],
  screen: ['open_session {host} keeps cwd and environment between calls'],
  dialog: ['pass every answer as a command-line flag instead'],
  whiptail: ['pass every answer as a command-line flag instead'],
  visudo: [
    'upload a validated file to /etc/sudoers.d/<name> and check it with visudo -c -f <file>',
  ],
  passwd: ['chpasswd <<< "<user>:<password>" (still classified as privileged)'],
  mysql: ['mysql -e "<SQL>"', 'mysql --execute="<SQL>" <database>'],
  psql: ['psql -c "<SQL>"', 'psql -f <file>'],
  'redis-cli': ['redis-cli <command> <args>', 'redis-cli --scan'],
  python: ['python3 -c "<code>"', 'upload a script, then python3 <script>'],
  python3: ['python3 -c "<code>"', 'upload a script, then python3 <script>'],
  node: ['node -e "<code>"', 'upload a script, then node <script>'],
  irb: ['ruby -e "<code>"'],
  ruby: ['ruby -e "<code>"', 'upload a script, then ruby <script>'],
  git: ['git commit -m "<message>"', 'git add <paths>', 'git rebase --onto <base> <from> <branch>'],
  crontab: ['crontab -l > /tmp/cron && <edit /tmp/cron> && crontab /tmp/cron'],
  systemctl: [
    'upload a drop-in to /etc/systemd/system/<unit>.d/override.conf, then systemctl daemon-reload',
  ],
  ssh: ['register the second host with `ssh-mcp setup` and call exec against it directly'],
};

function hasFlag(args: readonly Token[], flags: readonly string[]): boolean {
  return args.some((token) => {
    if (token.kind === 'operator') return false;
    const value = token.value;
    return flags.some(
      (flag) => value === flag || (flag.startsWith('--') && value.startsWith(`${flag}=`))
    );
  });
}

function words(args: readonly Token[]): Token[] {
  return args.filter((token) => token.kind !== 'operator');
}

function positional(args: readonly Token[]): Token[] {
  return words(args).filter((token) => !token.value.startsWith('-'));
}

/**
 * A REPL only starts when there is nothing to run. `node --version` is not a
 * REPL, so an informational flag must not be refused; an explicit `-i` is.
 */
function isRepl(args: readonly Token[]): boolean {
  const list = words(args);
  if (list.length === 0) return true;
  return hasFlag(list, ['-i', '--interactive']);
}

interface ConditionalRule {
  program: string;
  reason: string;
  refuse: (args: readonly Token[]) => boolean;
}

/** Refused only for some argument shapes (OPT-1, 13 programs). */
const CONDITIONAL_RULES: readonly ConditionalRule[] = [
  {
    // `top` redraws the screen forever without `-b`; with it, it prints once
    // and exits, which is an ordinary command. `htop` and friends have no
    // batch mode and stay on the unconditional list.
    program: 'top',
    reason: 'top without -b redraws a terminal forever; batch mode prints once and exits',
    refuse: (args) =>
      !words(args).some(
        (token) =>
          token.value === '--batch-mode' ||
          (!token.value.startsWith('--') && /^-[A-Za-z]*b/.test(token.value))
      ),
  },
  {
    program: 'mysql',
    reason: 'mysql without -e/--execute opens an interactive SQL shell',
    refuse: (args) =>
      !hasFlag(args, ['-e', '--execute']) && !args.some((t) => t.value.startsWith('--execute=')),
  },
  {
    program: 'psql',
    reason: 'psql without -c/-f opens an interactive SQL shell',
    refuse: (args) => !hasFlag(args, ['-c', '--command', '-f', '--file']),
  },
  {
    program: 'redis-cli',
    reason: 'redis-cli without a command opens an interactive prompt',
    refuse: (args) => words(args).length === 0,
  },
  { program: 'python', reason: 'python without a script or -c opens a REPL', refuse: isRepl },
  { program: 'python3', reason: 'python3 without a script or -c opens a REPL', refuse: isRepl },
  { program: 'node', reason: 'node without a script or -e opens a REPL', refuse: isRepl },
  { program: 'irb', reason: 'irb is a REPL', refuse: isRepl },
  { program: 'ruby', reason: 'ruby without a script or -e opens a REPL', refuse: isRepl },
  {
    program: 'git',
    reason: 'this git subcommand opens an editor or an interactive prompt',
    refuse: (args) => {
      const list = positional(args);
      const sub = list[0]?.value;
      if (sub === 'commit') {
        return !hasFlag(args, [
          '-m',
          '--message',
          '-F',
          '--file',
          '-C',
          '--reuse-message',
          '--no-edit',
        ]);
      }
      if (sub === 'rebase') return hasFlag(args, ['-i', '--interactive']);
      if (sub === 'add') return hasFlag(args, ['-i', '--interactive', '-p', '--patch']);
      if (sub === 'mergetool' || sub === 'difftool') return true;
      return false;
    },
  },
  {
    program: 'crontab',
    reason: 'crontab -e opens an editor',
    refuse: (args) => hasFlag(args, ['-e']),
  },
  {
    program: 'systemctl',
    reason: 'systemctl edit opens an editor',
    refuse: (args) => positional(args)[0]?.value === 'edit',
  },
  {
    program: 'ssh',
    reason: 'ssh without a remote command opens an interactive login',
    refuse: (args) => positional(args).length <= 1,
  },
];

const CONDITIONAL_BY_PROGRAM = new Map(CONDITIONAL_RULES.map((rule) => [rule.program, rule]));

export const CONDITIONAL_PROGRAMS: readonly string[] = CONDITIONAL_RULES.map(
  (rule) => rule.program
);

export interface InteractiveRefusal {
  refused: true;
  /** Program that needs a terminal, path stripped. */
  program: string;
  /** Why it was refused, in one line. */
  reason: string;
  /** Concrete commands that do the same job without a terminal. */
  alternatives: string[];
}

export interface InteractiveAllowed {
  refused: false;
}

export type InteractiveCheck = InteractiveRefusal | InteractiveAllowed;

const ALLOWED: InteractiveAllowed = { refused: false };

function refuse(program: string, reason: string): InteractiveRefusal {
  return {
    refused: true,
    program,
    reason,
    alternatives: [...(ALTERNATIVES[program] ?? ['use a non-interactive flag or open_session'])],
  };
}

function checkSegment(segment: Segment): InteractiveCheck {
  const program = segment.program;
  if (program === null || program === '') return ALLOWED;
  if (UNCONDITIONAL_PROGRAMS.includes(program)) {
    return refuse(program, `${program} requires a terminal; ssh-mcp never allocates a PTY`);
  }
  const rule = CONDITIONAL_BY_PROGRAM.get(program);
  if (rule !== undefined && rule.refuse(segment.args)) return refuse(program, rule.reason);
  return ALLOWED;
}

/** Run the gate over an already-scanned command. */
export function checkInteractiveScan(scan: NormalizeResult): InteractiveCheck {
  for (const segment of scan.segments) {
    const verdict = checkSegment(segment);
    if (verdict.refused) return verdict;
  }
  return ALLOWED;
}

/** Run the gate over a raw command string. */
export function checkInteractive(command: string): InteractiveCheck {
  return checkInteractiveScan(normalize(command));
}
