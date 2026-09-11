/**
 * Two-pass command classifier (plan rows 2.7, 2.7b, OPT-4b).
 *
 * Pass 1 runs the `scope: 'whole'` patterns over the whole normalised string,
 * pass 2 runs the `scope: 'segment'` patterns over every segment (including
 * segments recovered from `$(...)` and `sh -c <literal>`). The grade is the
 * maximum over both passes and over the pattern-independent rules below; the
 * reasons are the union.
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

/** Longest command string the classifier will look at (OPT-6, AC §5.3). */
export const MAX_COMMAND_LENGTH = 8192;

export const REASON_UNPARSEABLE = 'destructive:unparseable';
export const REASON_OPAQUE_SUBSTITUTION = 'destructive:opaque-substitution';
export const REASON_OPAQUE_SHELL_WRAPPER = 'destructive:opaque-shell-wrapper';
export const REASON_OPAQUE_EVAL = 'destructive:opaque-eval';
export const REASON_OPAQUE_SOURCE = 'destructive:opaque-source';
export const REASON_VARIABLE_COMMAND = 'privileged:variable-command';
export const REASON_VARIABLE_SOURCE = 'privileged:variable-source';

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

function isQuotedVariablePath(token: Token): boolean {
  return (
    token.quoted &&
    token.hasVariable &&
    !token.hasSubstitution &&
    QUOTED_VARIABLE_PATH.test(token.value)
  );
}

function firstWordArg(segment: Segment): Token | null {
  for (const token of segment.args) {
    if (token.kind === 'operator') continue;
    return token;
  }
  return null;
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

function applySegmentRules(segment: Segment, verdict: Verdict): void {
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
    applySegmentRules(segment, verdict);
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
