/**
 * Two-pass command classifier (plan rows 2.7, 2.7b, OPT-4b).
 *
 * Pass 1 runs the `scope: 'whole'` patterns over the whole normalised string,
 * pass 2 runs the `scope: 'segment'` patterns over every segment (including
 * segments recovered from `$(...)` and `sh -c <literal>`). The grade is the
 * maximum over both passes and over the argv rules below; the reasons are the
 * union.
 *
 * **Argv rules** exist because a regex over a flattened string cannot answer
 * questions about position. `rm -- /etc/passwd` defeats any `^rm\s+(?!-)`
 * guard, and `cp /etc/nginx.conf /tmp/x` reads a system file while
 * `cp /tmp/x /etc/nginx.conf` overwrites one — same tokens, opposite verdicts.
 * Those checks walk the token list instead (security finding F4), and unlike
 * patterns they cannot be switched off by a host.
 *
 * Pattern-independent rules (§5.4 "패턴 무관 판정 규칙"):
 *   destructive — `unparseable`; a first token that is `$(...)`/backtick;
 *                 `sh -c` with a non-literal argument; `eval`/`source`/`.`
 *                 whose argument is not a literal path
 *   privileged  — a first token that is a plain variable expansion
 *                 (`$PYTHON -m pytest`, Critic C15); `source "$VENV/bin/…"`
 *                 (Critic N4)
 */
import type { CommandGrade, PatternOverrides } from '../config/schema.js';
import { normalize } from './normalize.js';
import type { NormalizeResult, Segment, Token } from './normalize.js';
import { compilePatterns, patternReasonId } from './patterns.js';
import type { PatternGrade } from './patterns.js';

/** Longest command string the classifier will look at (OPT-6, AC §5.3). */
export const MAX_COMMAND_LENGTH = 8192;

/** Depth limit for re-classifying a nested payload (`su -c`, `docker run`). */
const MAX_NESTED_CLASSIFY_DEPTH = 3;

export const REASON_UNPARSEABLE = 'destructive:unparseable';
export const REASON_OPAQUE_SUBSTITUTION = 'destructive:opaque-substitution';
export const REASON_OPAQUE_SHELL_WRAPPER = 'destructive:opaque-shell-wrapper';
export const REASON_OPAQUE_EVAL = 'destructive:opaque-eval';
export const REASON_OPAQUE_SOURCE = 'destructive:opaque-source';
export const REASON_VARIABLE_COMMAND = 'privileged:variable-command';
export const REASON_VARIABLE_SOURCE = 'privileged:variable-source';
/** argv rule: the program is `rm`, whatever the flags look like (F4). */
export const REASON_RM_COMMAND = 'destructive:rm-command';
/** argv rule: the *destination* of a copy or move is a system path (F4). */
export const REASON_MOVE_TO_SYSTEM = 'destructive:move-to-system';
/** argv rule: `python -c` / `node -e` whose body does something destructive. */
export const REASON_INLINE_INTERPRETER = 'destructive:inline-interpreter';
/** argv rule: `python -c` / `node -e` whose body looks harmless (F8). */
export const REASON_INLINE_CODE = 'privileged:inline-code';
/** argv rule: an interpreter handed a process substitution (F4). */
export const REASON_INTERPRETER_SUBSTITUTION = 'destructive:interpreter-substitution';
/** argv rule: `su -c "<payload>"` whose payload could not be read (F6). */
export const REASON_OPAQUE_PRIVILEGE_PAYLOAD = 'destructive:opaque-privilege-payload';

/**
 * One verdict this module can reach without a pattern.
 *
 * `doctor --patterns` lists {@link import('./patterns.js').PATTERNS}; without
 * this table its output would understate what the classifier does, and an
 * operator reading it could conclude that removing every `rm-*` pattern makes
 * `rm -rf /` safe. These rules have no regex to print and no way to switch off.
 */
export interface ArgvRuleDef {
  /** Bare id, matching the pattern table's convention (`rm-command`). */
  id: string;
  grade: PatternGrade;
  /** `<grade>:<id>` — the exact string that appears in `reasons`. */
  reason: string;
  /** One line explaining when it fires. */
  description: string;
}

function argvRule(grade: PatternGrade, id: string, description: string): ArgvRuleDef {
  return { id, grade, reason: `${grade}:${id}`, description };
}

/** Every verdict reachable without a pattern, for `doctor --patterns`. */
export const ARGV_RULES: readonly ArgvRuleDef[] = [
  argvRule(
    'destructive',
    'unparseable',
    'the scanner could not read the command: unbalanced quoting, nesting deeper than 6, or an unterminated here-doc'
  ),
  argvRule(
    'destructive',
    'opaque-substitution',
    'the command name is a $(...) or backtick substitution, so what runs is unknown'
  ),
  argvRule(
    'destructive',
    'opaque-shell-wrapper',
    'sh -c / bash -c was given a non-literal argument'
  ),
  argvRule('destructive', 'opaque-eval', 'eval was given an argument'),
  argvRule(
    'destructive',
    'opaque-source',
    'source or . was given something other than a literal path'
  ),
  argvRule(
    'destructive',
    'rm-command',
    'the program is rm, whatever the flags look like (covers rm -- <path>)'
  ),
  argvRule(
    'destructive',
    'move-to-system',
    'the destination of cp, mv, install or ln is a system path or a home dotfile'
  ),
  argvRule(
    'destructive',
    'inline-interpreter',
    'python -c / node -e / perl -e whose code deletes, overwrites or shells out'
  ),
  argvRule(
    'destructive',
    'interpreter-substitution',
    'an interpreter was handed a process substitution, e.g. bash <(curl ...)'
  ),
  argvRule(
    'destructive',
    'opaque-privilege-payload',
    'su -c / doas -c whose payload contains a variable or a substitution'
  ),
  argvRule(
    'privileged',
    'variable-command',
    'the command name is a plain variable expansion, e.g. $PYTHON -m pytest'
  ),
  argvRule(
    'privileged',
    'variable-source',
    'source "$VENV/bin/activate" — a path built from a single variable'
  ),
  argvRule(
    'privileged',
    'inline-code',
    'python -c / node -e whose code matched nothing destructive but is still unparsed'
  ),
];

/** Copy of {@link ARGV_RULES}, for callers that prefer a function. */
export function describeArgvRules(): ArgvRuleDef[] {
  return ARGV_RULES.map((rule) => ({ ...rule }));
}

export interface Classification {
  grade: CommandGrade;
  /** `<grade>:<id>` for every matched pattern plus every rule that fired. */
  reasons: string[];
  /** Normalised text of each segment, all depths, in scan order. */
  segments: string[];
  /** Dequoted, single-space rendering of the whole command (AC20.11). */
  normalized: string;
  /** Which pass produced each pattern match — rule reasons appear in neither. */
  passes: { whole: string[]; segment: string[] };
  unparseable: boolean;
  /** `sudo -S` / `sudo --stdin`: the caller must return `sudo_password_required`. */
  sudoStdinPassword: boolean;
  /** Last top-level segment ended with `&` (AC10.4). */
  backgroundJob: boolean;
}

const GRADE_RANK: Record<CommandGrade, number> = { safe: 0, privileged: 1, destructive: 2 };

function maxGrade(a: CommandGrade, b: CommandGrade): CommandGrade {
  return GRADE_RANK[b] > GRADE_RANK[a] ? b : a;
}

/** `"$VENV/bin/activate"` and `"${HOME}/.profile"` — a path built from one variable. */
const QUOTED_VARIABLE_PATH =
  /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?:\/[^\s;|&$`()]*)*$/;

/** Destination paths that make a write destructive (F4). */
const SYSTEM_DESTINATION =
  /^(?:\/(?:etc|var|usr|opt|boot|srv|lib|lib64|bin|sbin|root|home|dev|proc|sys)(?:\/|$)|(?:~|\$HOME|\$\{HOME\})\/\.)/;

/** Programs whose last positional argument is a destination. */
const COPY_PROGRAMS = new Set(['cp', 'mv', 'install', 'ln']);

/** Programs that execute a string given with `-c` / `-e`. */
const INLINE_INTERPRETERS = new Set(['python', 'python3', 'perl', 'ruby', 'node', 'php']);

/** Programs that will run whatever bytes they are handed. */
const INTERPRETER_PROGRAMS = new Set([
  ...INLINE_INTERPRETERS,
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'ash',
]);

/**
 * Inline interpreter code that deletes, overwrites or shells out.
 *
 * `python3 -c "print(1)"` is an ordinary command and grading it destructive is
 * the kind of false positive that teaches a user to set `approvalMode: auto`
 * (F8). What makes an inline body destructive is what it calls.
 */
const INTERPRETER_DESTRUCTIVE =
  /\b(?:rmtree|rmSync|unlinkSync|rmdirSync|removedirs|unlink|remove|rmdir|truncate|shutil|subprocess|popen|system|execSync|spawnSync|child_process|fork|kill|chmod|chown|setuid|socket|connect|urlopen|requests\.(?:get|post))\b|\beval\s*\(|\bexec\s*\(|\bopen\s*\([^)]*['"][aw]/i;

function isQuotedVariablePath(token: Token): boolean {
  return (
    token.quoted &&
    token.hasVariable &&
    !token.hasSubstitution &&
    QUOTED_VARIABLE_PATH.test(token.value)
  );
}

function wordArgs(segment: Segment): Token[] {
  return segment.args.filter((token) => token.kind !== 'operator');
}

function firstWordArg(segment: Segment): Token | null {
  return wordArgs(segment)[0] ?? null;
}

interface Verdict {
  grade: CommandGrade;
  reasons: Set<string>;
  whole: string[];
  segment: string[];
}

function raise(verdict: Verdict, grade: CommandGrade, reason: string): void {
  verdict.grade = maxGrade(verdict.grade, grade);
  verdict.reasons.add(reason);
}

/**
 * `eval`, `source` and `.` hand a string to the shell. A literal path is the
 * normal, safe use of `source`; everything else is opaque (§5.4, Critic N4).
 */
function applyEvalRules(segment: Segment, verdict: Verdict): void {
  const program = segment.program;
  if (program !== 'eval' && program !== 'source' && program !== '.') return;

  const arg = firstWordArg(segment);
  const isEval = program === 'eval';
  if (arg === null) {
    raise(verdict, 'destructive', isEval ? REASON_OPAQUE_EVAL : REASON_OPAQUE_SOURCE);
    return;
  }
  if (isQuotedVariablePath(arg)) {
    raise(verdict, 'privileged', REASON_VARIABLE_SOURCE);
    return;
  }
  const literal = !arg.hasVariable && !arg.hasSubstitution;
  if (isEval) {
    // Even a literal `eval` argument is a command string, not a file path.
    raise(verdict, 'destructive', REASON_OPAQUE_EVAL);
    return;
  }
  if (!literal) raise(verdict, 'destructive', REASON_OPAQUE_SOURCE);
}

/**
 * `rm` is graded on argv position, not on a regex (F4).
 *
 * `rm -- /etc/passwd` and `rm --force=x` and any future flag spelling all reach
 * the same syscall. If the program is `rm`, the command deletes something.
 */
function applyRmRule(segment: Segment, verdict: Verdict): void {
  if (segment.program !== 'rm') return;
  raise(verdict, 'destructive', REASON_RM_COMMAND);
}

/**
 * For `cp`, `mv`, `install` and `ln` the *last* positional argument is the
 * destination. Writing into a system path or over a home dotfile is
 * destructive; reading one is not (F4, and the false positive it avoids).
 */
function applyCopyDestinationRule(segment: Segment, verdict: Verdict): void {
  if (segment.program === null || !COPY_PROGRAMS.has(segment.program)) return;
  const positional = wordArgs(segment).filter((token) => !token.value.startsWith('-'));
  const destination = positional[positional.length - 1];
  if (destination === undefined) return;
  if (SYSTEM_DESTINATION.test(destination.value)) {
    raise(verdict, 'destructive', REASON_MOVE_TO_SYSTEM);
  }
}

/** Value of `-c` / `-e` for an inline interpreter, or `null`. */
function inlineCodeArgument(segment: Segment): Token | null {
  const args = wordArgs(segment);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.value === '-c' || token.value === '-e' || token.value === '--eval') {
      return args[i + 1] ?? null;
    }
  }
  return null;
}

function applyInterpreterRules(segment: Segment, verdict: Verdict, depth: number): void {
  const program = segment.program;
  if (program === null || !INTERPRETER_PROGRAMS.has(program)) return;

  // `bash <(curl …)` and `python3 $(curl …)`: the interpreter is handed bytes
  // nobody has seen (F4).
  if (wordArgs(segment).some((token) => token.hasSubstitution)) {
    raise(verdict, 'destructive', REASON_INTERPRETER_SUBSTITUTION);
  }

  if (!INLINE_INTERPRETERS.has(program)) return;
  const code = inlineCodeArgument(segment);
  if (code === null) return;

  if (code.hasVariable || code.hasSubstitution) {
    raise(verdict, 'destructive', REASON_INLINE_INTERPRETER);
    return;
  }
  if (INTERPRETER_DESTRUCTIVE.test(code.value)) {
    raise(verdict, 'destructive', REASON_INLINE_INTERPRETER);
    return;
  }
  // Still privileged: we are running code we did not parse (F8 keeps it below
  // destructive, it does not make it safe).
  raise(verdict, 'privileged', REASON_INLINE_CODE);
  if (depth < MAX_NESTED_CLASSIFY_DEPTH) {
    mergeNested(verdict, code.value, depth + 1);
  }
}

/** Flags of `docker run` / `docker exec` that consume the next argument. */
const DOCKER_VALUE_FLAGS = new Set([
  '-v',
  '--volume',
  '--mount',
  '-e',
  '--env',
  '--env-file',
  '-p',
  '--publish',
  '--name',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '--network',
  '--net',
  '--entrypoint',
  '--label',
  '-l',
  '--add-host',
  '--device',
  '--restart',
  '--memory',
  '-m',
  '--cpus',
  '--hostname',
  '-h',
]);

/**
 * The command a container will run, i.e. everything after the image (for `run`)
 * or the container name (for `exec`). Returns `''` when there is none.
 */
function containerCommand(segment: Segment): { command: string; literal: boolean } | null {
  if (segment.program !== 'docker' && segment.program !== 'podman') return null;
  const args = wordArgs(segment);
  const sub = args[0]?.value;
  if (sub !== 'run' && sub !== 'exec') return null;

  let i = 1;
  while (i < args.length) {
    const token = args[i];
    if (token === undefined) break;
    const value = token.value;
    if (!value.startsWith('-')) break;
    i += 1;
    if (DOCKER_VALUE_FLAGS.has(value)) i += 1;
  }
  // args[i] is the image (run) or the container (exec); the rest is the command.
  const rest = args.slice(i + 1);
  if (rest.length === 0) return null;
  return {
    command: rest.map((token) => token.value).join(' '),
    literal: rest.every((token) => !token.hasVariable && !token.hasSubstitution),
  };
}

function applyContainerRule(segment: Segment, verdict: Verdict, depth: number): void {
  const inner = containerCommand(segment);
  if (inner === null || !inner.literal) return;
  if (depth >= MAX_NESTED_CLASSIFY_DEPTH) return;
  mergeNested(verdict, inner.command, depth + 1);
}

/** `su - root -c "rm -rf /"` — the payload is a command, so classify it (F6). */
function applyPrivilegePayloadRule(segment: Segment, verdict: Verdict, depth: number): void {
  const payload = segment.privilegePayload;
  if (payload === null) return;
  if (payload.hasVariable || payload.hasSubstitution) {
    raise(verdict, 'destructive', REASON_OPAQUE_PRIVILEGE_PAYLOAD);
    return;
  }
  // The scanner already emitted the payload as its own segment, so the pattern
  // passes cover it; this is the belt for the argv rules, which only see
  // segments they were given.
  if (depth < MAX_NESTED_CLASSIFY_DEPTH) {
    mergeNested(verdict, payload.value, depth + 1);
  }
}

/** Classify `command` and fold its grade and reasons into `verdict`. */
function mergeNested(verdict: Verdict, command: string, depth: number): void {
  if (command.trim() === '') return;
  const nested = classifyInternal(command, undefined, undefined, depth);
  verdict.grade = maxGrade(verdict.grade, nested.grade);
  for (const reason of nested.reasons) verdict.reasons.add(reason);
}

function applySegmentRules(segment: Segment, verdict: Verdict, depth: number): void {
  const first = segment.firstToken;
  if (first !== null && first.kind !== 'operator') {
    if (first.hasSubstitution) {
      raise(verdict, 'destructive', REASON_OPAQUE_SUBSTITUTION);
    } else if (first.hasVariable) {
      // C15: `$PYTHON -m pytest` is ordinary; privileged, not destructive.
      raise(verdict, 'privileged', REASON_VARIABLE_COMMAND);
    }
  }

  const wrapper = segment.shellWrapper;
  if (wrapper !== null && !wrapper.argLiteral) {
    raise(verdict, 'destructive', REASON_OPAQUE_SHELL_WRAPPER);
  }

  applyEvalRules(segment, verdict);
  applyRmRule(segment, verdict);
  applyCopyDestinationRule(segment, verdict);
  applyInterpreterRules(segment, verdict, depth);
  applyContainerRule(segment, verdict, depth);
  applyPrivilegePayloadRule(segment, verdict, depth);
}

function classifyInternal(
  command: string,
  overrides: PatternOverrides | undefined,
  scan: NormalizeResult | undefined,
  depth: number
): Classification {
  const result = scan ?? normalize(command);
  const patterns = compilePatterns(overrides);
  const verdict: Verdict = { grade: 'safe', reasons: new Set<string>(), whole: [], segment: [] };

  if (result.unparseable) raise(verdict, 'destructive', REASON_UNPARSEABLE);

  for (const pattern of patterns) {
    if (pattern.scope !== 'whole') continue;
    if (!pattern.re.test(result.matchTarget)) continue;
    const reason = patternReasonId(pattern);
    raise(verdict, pattern.grade, reason);
    if (!verdict.whole.includes(reason)) verdict.whole.push(reason);
  }

  let sudoStdinPassword = false;
  for (const segment of result.segments) {
    if (segment.sudoStdinPassword) sudoStdinPassword = true;
    applySegmentRules(segment, verdict, depth);
    for (const pattern of patterns) {
      if (pattern.scope !== 'segment') continue;
      if (!segment.matchTargets.some((target) => pattern.re.test(target))) continue;
      const reason = patternReasonId(pattern);
      raise(verdict, pattern.grade, reason);
      if (!verdict.segment.includes(reason)) verdict.segment.push(reason);
    }
  }

  return {
    grade: verdict.grade,
    reasons: [...verdict.reasons],
    segments: result.segments.map((segment) => segment.normalized),
    normalized: result.normalized,
    passes: { whole: verdict.whole, segment: verdict.segment },
    unparseable: result.unparseable,
    sudoStdinPassword,
    backgroundJob: result.backgroundJob,
  };
}

/**
 * Classify one command.
 *
 * `scan` lets a caller that already normalised the command (the approval gate
 * runs the interactive check first) avoid scanning it twice.
 */
export function classify(
  command: string,
  overrides?: PatternOverrides,
  scan?: NormalizeResult
): Classification {
  return classifyInternal(command, overrides, scan, 0);
}
