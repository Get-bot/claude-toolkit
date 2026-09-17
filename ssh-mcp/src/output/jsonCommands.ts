/**
 * The `format: "json"` rewrite table and the rewritability predicate
 * (plan row E3, AC-J2, AC-J2a, AC-J3, AC-J3a, AC-J4).
 *
 * Two things live here and nowhere else:
 *
 * 1. **{@link JSON_COMMAND_TABLE}** — the AC-J2 flag whitelist. The spec says
 *    "표는 `src/output/jsonCommands.ts` 한 곳에만 둔다", so a second copy of any
 *    of these flags (in a doc generator, in a test, in the README) is a bug:
 *    import the table instead.
 * 2. **{@link isRewritable}** — the AC-J3a predicate over {@link normalize}.
 *
 * **The `df`/`ps` normalised forms are the exception, and `tables.ts` owns
 * them.** AC-J2's "one file" is about which program gets which flag; the
 * column list `ps -eo` is given and the `df` form its parser reads are a
 * different decision, and they are the *same* decision as the parser: `parsePs`
 * compares the header strictly, so a field list that drifts from it turns every
 * `ps` call on every host into `parse_error: "header_unrecognized"`. That is
 * not hypothetical — this file and `tables.ts` were written in parallel with
 * different lists, both test suites stayed green because each checked its own
 * constant, and the mismatch survived to the edge of being wired up. So the
 * list has one home, next to the parser that constrains it, and the contract
 * tests in `tests/unit/jsonCommands.test.ts` compare the two modules.
 *
 * `tables.ts` also has the argument for *which* fields. The short version: this
 * server connects to whatever host someone registered, so the list sticks to
 * `-o` keywords that do not depend on how that host's `ps` was built — an
 * unsupported keyword fails the command outright rather than dropping a column.
 *
 * Deliberately *not* here: the branded {@link import('./resolve.js').ResolvedCommand}
 * type (that is `resolve.ts`, which calls {@link planRewrite}) and the
 * fixed-column `df`/`ps` parsers (`tables.ts`). This file decides *what to run*
 * and *what the caller should do with stdout*; it never runs or parses anything.
 *
 * ## The rewrite is string surgery on the raw command, never a rebuild
 *
 * AC-J2a requires `classify()` to return the same grade *and the same reasons*
 * before and after a rewrite. Rebuilding the command from
 * {@link Segment.normalized} would break that in two ways at once: it drops the
 * privilege prefix and the env assignments the classifier grades on
 * (`sudo df -h` → `df -P` is privileged → safe), and it drops quoting, so
 * `docker ps --filter "name=a b"` would come back as four words instead of
 * three. So every rewrite below is a splice into the original string, and the
 * only thing ever removed is the flag tail of `df`/`ps`, which AC-J4 replaces
 * on purpose. Operands that survive are re-attached as raw slices, never as
 * re-quoted token values — rebuilding would single-quote `$MOUNT` and stop it
 * expanding. A quoted or escaped word cannot be sliced (its value is not its
 * raw text), so a command containing one is left unrewritten entirely rather
 * than rewritten with a guess.
 *
 * ## Why `df` keeps its operands and `ps` does not
 *
 * `df -h /var` normalises to `df -P /var`, not `df -P`: `-P` only fixes the
 * output layout, so the path the model asked about survives and the answer
 * stays the answer to the question. Dropping it would silently widen the
 * command to every filesystem — a change AC-J4 never asked for, and one a
 * person skimming the approval window would have to notice to catch (PM-7).
 * Flags are dropped because `-h`/`-B` change the very columns the fixed-column
 * parser reads; operands do not.
 *
 * `ps` cannot have the same treatment. Its selection flags (`-e`, `-p`, `-u`)
 * and its format flag (`-o`) are the same argument grammar, and BSD syntax
 * (`ps aux`) has no leading dash at all, so "drop the flags, keep the
 * operands" has nothing to hold onto — there is no operand, only a selection
 * that `-e` overrides. AC-J4 names `ps -eo …` as the normalisation, so
 * `ps -p 123` widens to every process. That is a real limitation, not an
 * oversight, and it belongs in the README's known limitations (Phase G).
 *
 * ## Why `ip` inserts instead of appending
 *
 * iproute2 parses `ip [OPTIONS] OBJECT {COMMAND}` and stops looking for options
 * at the first non-`-` word, so `ip addr -j` hands `-j` to the address command,
 * which reads it as a device name and fails. Every other program in the table
 * accepts its flag at the end. That single difference is why {@link Rewrite}
 * has an `insert` kind at all.
 */
import { normalize } from '../safety/normalize.js';
import { DF_NORMALIZED_COMMAND, PS_COLUMNS } from './tables.js';
import type { NormalizeResult, Segment, Token } from '../safety/normalize.js';

/** The fixed-column parsers AC-J4 requires; implemented in `tables.ts`. */
export type TableParserName = 'df' | 'ps';

/**
 * What the caller does with stdout once the resolved command has run.
 *
 * `json` means `JSON.parse` the whole stdout (AC-J6 turns a failure into
 * `parse_error: "invalid_json"`); `table` means hand stdout to the named
 * fixed-column parser instead, because the program has no JSON mode (AC-J4).
 */
export type OutputPlan = { kind: 'json' } | { kind: 'table'; parser: TableParserName };

/**
 * The result of asking "can this command be made to emit JSON, and how?".
 *
 * `rewritable: false` is AC-J3 exactly: the original command still runs, and
 * the response carries `parsed: null` with `parse_error: "not_rewritable"`.
 * `rewritable: true` always carries a plan — a command that matched no table
 * entry still gets `{ kind: 'json' }`, because "run it and try to parse it" is
 * what `format: "json"` asked for and AC-J6 already defines the failure
 * (`invalid_json`).
 */
export type RewritePlan =
  | { rewritable: false; command: string; plan: null; reason: 'not_rewritable' }
  | { rewritable: true; command: string; plan: OutputPlan; reason: null };

/** How the command text is changed. */
type Rewrite =
  /** Nothing to add — the program already emits JSON (`docker inspect`). */
  | { kind: 'none' }
  /** Flags appended after the existing arguments. */
  | { kind: 'append'; flags: readonly string[] }
  /** Flags spliced in right after the program word (`ip`, see the header). */
  | { kind: 'insert'; flags: readonly string[] }
  /** Program kept verbatim, its arguments replaced by these flags (AC-J4). */
  | {
      kind: 'replace';
      flags: readonly string[];
      /**
       * `keep` re-attaches the non-flag operands verbatim after the new flags
       * (`df -h /var` → `df -P /var`); `drop` discards everything. See the
       * header for why `df` keeps and `ps` drops.
       */
      operands: 'keep' | 'drop';
      /**
       * Flags that consume the following word, so that word is dropped with
       * them instead of being mistaken for an operand (`df -x tmpfs /var`).
       */
      valueFlags: readonly string[];
    };

export interface JsonCommandEntry {
  /** Program name with any path stripped — compared to {@link Segment.program}. */
  readonly program: string;
  /**
   * Argument words that must lead the argument list, e.g. `['container','ls']`.
   * Empty means "any arguments". A global flag before the subcommand
   * (`docker -H … ps`) does not match, and falls back to a plain JSON parse.
   * Leading {@link jsonFlags} are skipped first, so `ip -j addr` still matches.
   */
  readonly subcommand: readonly string[];
  /**
   * Single-token flags that already put this program in JSON mode.
   *
   * Two jobs, both about not producing a command that reads badly to the person
   * approving it (PM-7): they are skipped when matching {@link subcommand}, and
   * finding one anywhere in the arguments means the rewrite is **deliberately
   * skipped** rather than duplicated — `lsblk -J` stays `lsblk -J`, not
   * `lsblk -J -J`. Two-token forms (`-o json`) are not detected; for those the
   * append lands a second time and the program's last-wins parsing settles it.
   */
  readonly jsonFlags: readonly string[];
  readonly rewrite: Rewrite;
  readonly plan: OutputPlan;
  /** A representative invocation. The AC-J2a grade-invariance test runs these. */
  readonly example: string;
}

/**
 * The `df` flags, split out of the form `parseDf` reads rather than written
 * again here.
 *
 * Derived, not copied: `['-P']` would read more directly, but it is the same
 * decision as {@link DF_NORMALIZED_COMMAND} written a second way, and a second
 * way is exactly how the `ps` list drifted. The rewrite needs the flags without
 * the program because it splices them after whatever prefix the raw command
 * had (`sudo df` → `sudo df -P`), which is the only reason this exists at all.
 *
 * `tables.ts` has the reasoning for `-P` itself, including the part that is
 * easy to get wrong: `-P` fixes the POSIX *layout*, not the unit — GNU and
 * BusyBox report 1024-byte blocks under it, BSD 512 — so `parseDf` reads the
 * unit from the `<N>-blocks` header instead of assuming one.
 */
const DF_FLAGS: readonly string[] = DF_NORMALIZED_COMMAND.split(' ').slice(1);

/**
 * `df` flags that take a separate word, which is dropped with them.
 *
 * Without this list `df -x tmpfs /var` would keep `tmpfs` as an operand and
 * become `df -P tmpfs /var`, which fails with "No such file or directory". The
 * `--flag=value` forms need no entry — they are one token. A flag missing from
 * this list fails visibly (a bad operand, shown in the approval window), never
 * silently, which is why a short list of the ones that exist across GNU,
 * BusyBox and macOS `df` is enough.
 */
const DF_VALUE_FLAGS = [
  '-B',
  '-t',
  '-x',
  '--block-size',
  '--type',
  '--exclude-type',
  '--output',
] as const;

/**
 * The AC-J2 whitelist, in match order.
 *
 * Longer subcommands come first so `docker container ls` is not shadowed by a
 * shorter entry for the same program. There is no bare `docker` entry on
 * purpose: `docker rm` is destructive and must not quietly gain a flag.
 */
export const JSON_COMMAND_TABLE: readonly JsonCommandEntry[] = [
  {
    program: 'docker',
    subcommand: ['container', 'ls'],
    jsonFlags: [],
    rewrite: { kind: 'append', flags: ['--format', 'json'] },
    plan: { kind: 'json' },
    example: 'docker container ls',
  },
  {
    program: 'docker',
    subcommand: ['ps'],
    jsonFlags: [],
    rewrite: { kind: 'append', flags: ['--format', 'json'] },
    plan: { kind: 'json' },
    example: 'docker ps',
  },
  {
    program: 'docker',
    subcommand: ['images'],
    jsonFlags: [],
    rewrite: { kind: 'append', flags: ['--format', 'json'] },
    plan: { kind: 'json' },
    example: 'docker images',
  },
  {
    // Already JSON; listed so that a reader of the table sees why it is not
    // missing, and so AC-J2a covers it.
    program: 'docker',
    subcommand: ['inspect'],
    jsonFlags: [],
    rewrite: { kind: 'none' },
    plan: { kind: 'json' },
    example: 'docker inspect nginx',
  },
  {
    program: 'systemctl',
    subcommand: ['list-units'],
    jsonFlags: ['--output=json'],
    rewrite: { kind: 'append', flags: ['--output=json'] },
    plan: { kind: 'json' },
    example: 'systemctl list-units',
  },
  {
    program: 'systemctl',
    subcommand: ['list-timers'],
    jsonFlags: ['--output=json'],
    rewrite: { kind: 'append', flags: ['--output=json'] },
    plan: { kind: 'json' },
    example: 'systemctl list-timers',
  },
  {
    program: 'systemctl',
    subcommand: ['list-sockets'],
    jsonFlags: ['--output=json'],
    rewrite: { kind: 'append', flags: ['--output=json'] },
    plan: { kind: 'json' },
    example: 'systemctl list-sockets',
  },
  {
    program: 'journalctl',
    subcommand: [],
    jsonFlags: [],
    rewrite: { kind: 'append', flags: ['-o', 'json'] },
    plan: { kind: 'json' },
    example: 'journalctl -n 20',
  },
  {
    program: 'lsblk',
    subcommand: [],
    jsonFlags: ['-J', '--json'],
    rewrite: { kind: 'append', flags: ['-J'] },
    plan: { kind: 'json' },
    example: 'lsblk',
  },
  {
    program: 'ip',
    subcommand: ['addr'],
    jsonFlags: ['-j', '--json'],
    rewrite: { kind: 'insert', flags: ['-j'] },
    plan: { kind: 'json' },
    example: 'ip addr',
  },
  {
    program: 'ip',
    subcommand: ['link'],
    jsonFlags: ['-j', '--json'],
    rewrite: { kind: 'insert', flags: ['-j'] },
    plan: { kind: 'json' },
    example: 'ip link',
  },
  {
    program: 'ip',
    subcommand: ['route'],
    jsonFlags: ['-j', '--json'],
    rewrite: { kind: 'insert', flags: ['-j'] },
    plan: { kind: 'json' },
    example: 'ip route',
  },
  {
    // AC-J4: no JSON mode anywhere, so the command is normalised to the one
    // layout the fixed-column parser was written against and stdout goes to
    // that parser instead of `JSON.parse`.
    program: 'df',
    subcommand: [],
    jsonFlags: [],
    rewrite: { kind: 'replace', flags: DF_FLAGS, operands: 'keep', valueFlags: DF_VALUE_FLAGS },
    plan: { kind: 'table', parser: 'df' },
    example: 'df -h /var',
  },
  {
    // Unlike `df` this drops the selection as well as the formatting; the file
    // header says why, and Phase G lists it as a known limitation.
    program: 'ps',
    subcommand: [],
    jsonFlags: [],
    rewrite: { kind: 'replace', flags: ['-eo', PS_COLUMNS], operands: 'drop', valueFlags: [] },
    plan: { kind: 'table', parser: 'ps' },
    example: 'ps aux',
  },
];

/**
 * The AC-J3a rewritability predicate.
 *
 * Four conditions, and the third is the load-bearing one:
 *
 * 1. `segments.length === 1` — **all depths**, not just `depth === 0`
 *    (`normalize.ts` collects nested segments into the same list). Filtering to
 *    the top level would let `docker ps --format $(x)` through.
 * 2. `terminator === ''` — excludes `;`, `&&`, `||`, `|`, `&` and newline,
 *    since each of those ends a segment.
 * 3. **No operator token.** `>` and `<` do *not* end a segment; the scanner
 *    turns them into operator tokens inside the segment. So `docker ps > out.txt`
 *    satisfies 1 and 2, and this condition is the only thing that stops it.
 * 4. `unparseable === false` and `hereDocs === 0`.
 */
export function isRewritable(command: string): boolean {
  return rewritableSegment(normalize(command)) !== null;
}

/** The single rewritable segment of `scan`, or `null` when AC-J3a refuses. */
function rewritableSegment(scan: NormalizeResult): Segment | null {
  if (scan.unparseable || scan.hereDocs !== 0) return null;
  if (scan.segments.length !== 1) return null;
  const segment = scan.segments[0];
  if (segment === undefined) return null;
  if (segment.terminator !== '') return null;
  // Every operator token the scanner emits is a redirection or a here-doc
  // delimiter, and here-docs are already out, so this is the redirection check.
  if (segment.rawTokens.some((token) => token.kind === 'operator')) return null;
  return segment;
}

/**
 * Decide what to run for `format: "json"` and what to do with its stdout.
 *
 * The returned `command` is always something the caller must classify, approve,
 * audit and run — including on the `rewritable: false` path, where it is the
 * original string (AC-J3, AC-J5).
 */
export function planRewrite(raw: string): RewritePlan {
  const segment = rewritableSegment(normalize(raw));
  if (segment === null) {
    return { rewritable: false, command: raw, plan: null, reason: 'not_rewritable' };
  }

  const entry = matchEntry(segment);
  if (entry === null)
    return { rewritable: true, command: raw, plan: { kind: 'json' }, reason: null };

  const rewritten = applyRewrite(raw, segment, entry);
  // Give up rather than guess. Three facts force this, in order:
  //
  // 1. **There is no way to find the span.** `Token` (`src/safety/normalize.ts`)
  //    carries `value`, `defanged`, `quoted`, `hasVariable`, `hasSubstitution`
  //    and `kind` — no source offsets. A quoted or escaped word's value is not
  //    its raw text, so it cannot be located in the original string at all.
  // 2. **Rebuilding from token values is not the way out.** Re-quoting would
  //    wrap `$MOUNT` in single quotes and stop it expanding, which changes what
  //    the command does rather than how its output is shaped.
  // 3. **So the choice is `parsed` or scope, and scope wins.** Dropping the
  //    operand would make `df -h "/mnt/my disk"` report every filesystem — a
  //    *successful* `parsed` answering a question nobody asked. A quietly wrong
  //    answer is worse than an honestly missing one, and nothing is lost from
  //    the response body: `stdout` still carries the real output of the real
  //    command, and AC-J6 reports `invalid_json` for the missing `parsed`.
  //
  // Follow-up if this ever costs enough: putting a source span on `Token` in
  // `normalize.ts` dissolves the whole problem. That is the classifier's core
  // and was out of scope for Phase E.
  if (rewritten === null) {
    return { rewritable: true, command: raw, plan: { kind: 'json' }, reason: null };
  }
  return { rewritable: true, command: rewritten, plan: entry.plan, reason: null };
}

/**
 * First table entry whose program and leading argument words match.
 *
 * Leading {@link JsonCommandEntry.jsonFlags} are stepped over before the
 * subcommand comparison, so `ip -j addr` reaches the `ip addr` entry and is
 * then skipped on purpose by {@link applyRewrite}, rather than falling off the
 * table and being right by accident.
 */
function matchEntry(segment: Segment): JsonCommandEntry | null {
  const program = segment.program;
  if (program === null) return null;

  for (const entry of JSON_COMMAND_TABLE) {
    if (entry.program !== program) continue;
    let offset = 0;
    while (isAnyPlainWord(segment.args[offset], entry.jsonFlags)) offset += 1;
    if (entry.subcommand.every((word, i) => isPlainWord(segment.args[offset + i], word))) {
      return entry;
    }
  }
  return null;
}

function isPlainWord(token: Token | undefined, expected: string): boolean {
  if (token === undefined || token.kind !== 'word') return false;
  if (token.hasVariable || token.hasSubstitution) return false;
  return token.value === expected;
}

function isAnyPlainWord(token: Token | undefined, expected: readonly string[]): boolean {
  return expected.some((word) => isPlainWord(token, word));
}

function applyRewrite(raw: string, segment: Segment, entry: JsonCommandEntry): string | null {
  const rewrite = entry.rewrite;

  // Already in JSON mode: adding the flag a second time would run the same
  // command while showing the approver a duplicate they have to reason about.
  if (segment.args.some((token) => isAnyPlainWord(token, entry.jsonFlags))) return raw;
  if (rewrite.kind === 'none') return raw;

  if (rewrite.kind === 'append') {
    // A trailing `# …` comment survives the scanner (it simply skips to the end
    // of the line), so appending would put the flag inside the comment. Nothing
    // in the table needs to run alongside a comment, so refuse instead.
    if (/(?:^|[ \t])#/.test(raw)) return null;
    return `${raw.trimEnd()} ${rewrite.flags.join(' ')}`;
  }

  const index = programIndex(segment);
  if (index === null) return null;
  // `insert` and a `drop` replace only need to find the program; a `keep`
  // replace has to locate every later token too, so it walks to the end.
  const upTo = rewrite.kind === 'replace' && rewrite.operands === 'keep' ? undefined : index;
  const spans = tokenSpans(raw, segment.rawTokens, upTo);
  const programEnd = spans?.[index]?.end;
  if (spans === undefined || programEnd === undefined) return null;

  // Everything *before* the program stays verbatim — `sudo`, `env FOO=1`,
  // `nice` — which is what makes the grade invariant AC-J2a asks for hold.
  const head = `${raw.slice(0, programEnd)} ${rewrite.flags.join(' ')}`;
  if (rewrite.kind === 'insert') return head + raw.slice(programEnd);
  if (rewrite.operands === 'drop') return head;
  return head + operandTail(raw, segment.rawTokens, spans, index, rewrite.valueFlags);
}

/**
 * The non-flag operands after the program, as raw slices joined by one space.
 *
 * Slices, not token values: `df "/mnt/my disk"` must come back with its quotes
 * or the rewrite would turn one operand into two. A flag in `valueFlags` also
 * swallows the word after it, which is the difference between `df -P /var` and
 * the broken `df -P tmpfs /var`.
 */
function operandTail(
  raw: string,
  tokens: readonly Token[],
  spans: readonly Span[],
  programIdx: number,
  valueFlags: readonly string[]
): string {
  let out = '';
  let skipValue = false;

  for (let t = programIdx + 1; t < tokens.length; t += 1) {
    const token = tokens[t];
    const span = spans[t];
    if (token === undefined || span === undefined) continue;
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (token.value.startsWith('-')) {
      skipValue = valueFlags.includes(token.value);
      continue;
    }
    out += ` ${raw.slice(span.start, span.end)}`;
  }
  return out;
}

interface Span {
  start: number;
  end: number;
}

/** Index of the program token within `rawTokens`, or `null`. */
function programIndex(segment: Segment): number | null {
  const first = segment.firstToken;
  if (first === null) return null;
  // Reference identity: `commandTokens` is a slice of `rawTokens`, so the
  // program token is the same object in both lists.
  const index = segment.rawTokens.indexOf(first);
  return index === -1 ? null : index;
}

/**
 * Raw-string spans for `tokens[0..upTo]`, or `undefined` when the raw text does
 * not literally spell them.
 *
 * Matching is by token *value*, so `/sbin/ip` is found and `"ip"` is not: a
 * quoted or escaped word has a value that differs from its raw text, the
 * `startsWith` below fails, and the caller falls back to no rewrite at all.
 * That is the intended failure — a splice at a guessed offset would change a
 * command a human is about to approve. `upTo` exists so an `ip` insert, which
 * only needs the program, does not give up over a quoted word further along.
 *
 * {@link planRewrite} carries the full reasoning for accepting this, including
 * the `Token`-has-no-offsets fact that makes it unavoidable today.
 */
function tokenSpans(raw: string, tokens: readonly Token[], upTo?: number): Span[] | undefined {
  const last = upTo ?? tokens.length - 1;
  const spans: Span[] = [];
  let i = 0;

  for (let t = 0; t <= last; t += 1) {
    while (i < raw.length && isBlank(raw.charAt(i))) i += 1;
    const token = tokens[t];
    if (token === undefined || token.kind !== 'word') return undefined;
    if (!raw.startsWith(token.value, i)) return undefined;
    const start = i;
    i += token.value.length;
    if (i < raw.length && !isBlank(raw.charAt(i))) return undefined;
    spans.push({ start, end: i });
  }
  return spans;
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}
