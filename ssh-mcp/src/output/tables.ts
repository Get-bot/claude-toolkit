/**
 * Fixed-column parsers for `df` and `ps` (plan row E4, AC-J4).
 *
 * Every other command in the `format: "json"` table gets a flag that makes the
 * tool print JSON itself (`src/output/jsonCommands.ts`). `df` and `ps` have no
 * such flag on any of the three implementations we target, so they are instead
 * normalised to a shape whose columns are fixed and then split here. That makes
 * this file the one place where the executed command and the parser that reads
 * its output are both visible, and the two must be changed together:
 *
 * | command                        | parser              |
 * |--------------------------------|---------------------|
 * | {@link DF_NORMALIZED_COMMAND}  | {@link parseDf}     |
 * | {@link PS_NORMALIZED_COMMAND}  | {@link parsePs}     |
 *
 * **Why `df -P`.** `-P` is the POSIX output mode, and its guarantee is one line
 * per filesystem. Plain `df` wraps a long device name onto its own line —
 * busybox does it explicitly (`coreutils/df.c`: `if (printf("\n%-20s" + 1,
 * device) > 20 && !(opt & OPT_POSIX)) printf("\n%-20s", "")`) — which would
 * turn one filesystem into two half-rows. `-P` also pins the header wording
 * (`Capacity`, `Mounted on`) and the column count at six across GNU coreutils,
 * busybox and BSD, which is what lets {@link parseDf} check the header strictly
 * instead of guessing. The cost is that the block unit differs: GNU and busybox
 * use 1024-byte blocks under `-P`, BSD uses 512 (only `-Pk` makes it 1024), so
 * the unit is read from the header and reported as `block_size_bytes` rather
 * than assumed. A parsed number without its unit would be worse than no number.
 *
 * **Why this `ps -eo` field list.** The list is the intersection of what the
 * three implementations support, and busybox is by far the narrowest. Its
 * `out_spec` table (`procps/ps.c`) offers only `user group comm args pid ppid
 * pgid tty vsz sid stat rss` unconditionally; `etime` and `time` sit behind
 * `ENABLE_FEATURE_PS_TIME`, and `pcpu` is commented out of the table entirely,
 * so no busybox build has it. An unsupported keyword is not a degraded column,
 * it is `bad -o argument 'pcpu'` on stderr and a failed command — so `%CPU` and
 * `ELAPSED`, the two fields a reader misses most here, are deliberately absent.
 * What remains still answers "what is running, who owns it, what state is it in
 * and how much memory does it hold", and a caller that wants CPU can ask for it
 * with `format: "text"` and read the raw table.
 *
 * `args` must be last because a command line contains arbitrary spaces; every
 * other field is one whitespace-free token. `args` is also the only command
 * keyword all three accept (busybox has no `command`, and `comm` drops the
 * arguments) — at the price that its *header* is not the same everywhere:
 * procps and busybox print `COMMAND`, macOS prints `ARGS` (adv_cmds
 * `ps/keyword.c`: `{"args", "ARGS", ...}` next to `{"command", "COMMAND", ...}`).
 * {@link parsePs} accepts either spelling for that one column.
 *
 * **Line width is not one of the constraints**, however tempting the argument
 * is. Every implementation cuts its rows to the terminal width, so a wider
 * column set looks like it must eat into the command text — and busybox's `79`
 * is easy to find while grepping for it. That number belongs to the
 * non-DESKTOP `ps_main`, the build with no `-o` at all. The `-o` path narrows
 * `terminal_width` from `MAX_WIDTH` (2048) only `if (isatty(1))`
 * (`procps/ps.c`), macOS sets `termwidth = UNLIMITED` when stdout is not a tty
 * (`ps/ps.c`, radar 3862041), and procps does the same — while ssh-mcp asks
 * for no pty on either tool path (`src/ssh/exec.ts` passes `{ pty: false }`,
 * `src/ssh/session.ts` suppresses the pty request). So nothing here is ever
 * cut, and a future field list is bounded by keyword availability and by what
 * each row costs the model's context, not by line width.
 *
 * **Why every value is a string.** The implementations disagree about what a
 * "number" is. busybox prints VSZ and RSS through `put_lu`, which scales them
 * to four characters (`9.9m`, `1.5g`), while procps prints kibibytes; GNU `df`
 * prints `-` in the capacity column — and in the size columns — for a
 * filesystem whose usage is unknown. Coercing would therefore produce a field
 * that is sometimes a number and sometimes a string, which is worse for the
 * model reading it than a field that is always a string. Parsing splits rows;
 * it does not interpret them.
 *
 * **Why failure is a value, not an exception.** Every caller turns a failure
 * into `parse_error` in the tool response (AC-J4), so a thrown error would be
 * caught and converted at every call site. The reasons are a closed set
 * ({@link TableParseReason}) and their spellings are part of the tool contract:
 * they reach the model, so renaming one is a breaking change.
 *
 * A single unparsable row fails the whole table. Partial output would be worse
 * than none, because nothing in the response would tell the model which
 * filesystems or processes are missing from a list it is about to reason over.
 *
 * Deliberately dependency-free — no brand type, no whitelist table, no config.
 * It takes a string and returns rows or a reason, which is what makes it
 * testable against a corpus of captured output (`tests/unit/tables.test.ts`).
 */

/** The `df` form {@link parseDf} reads. See the file header for why `-P`. */
export const DF_NORMALIZED_COMMAND = 'df -P';

/**
 * The `-eo` field list {@link parsePs} expects, in column order. See the file
 * header for why these fields and not the obvious ones.
 *
 * **The rewrite table must import this, not repeat it.** A second copy of the
 * list is invisible until it drifts, and the symptom of drift is every `ps`
 * call on every host coming back `header_unrecognized` — the parser and the
 * command it parses are one decision.
 */
export const PS_COLUMNS = 'pid,ppid,user,stat,vsz,rss,args';

/** The `ps` form {@link parsePs} reads: `ps -eo` plus {@link PS_COLUMNS}. */
export const PS_NORMALIZED_COMMAND = `ps -eo ${PS_COLUMNS}`;

/**
 * Why a table could not be parsed. These strings are carried into the tool
 * response as `parse_error`, so they are contract, not diagnostics.
 *
 * - `empty_output` — stdout held no non-blank line, so there was not even a
 *   header. Usually the command itself failed and everything went to stderr.
 * - `header_unrecognized` — the first line is not the header the normalised
 *   command produces. This is the guard that keeps a *differently* shaped table
 *   (plain `df`, a `ps` with another `-o` list) from being split into columns
 *   that do not mean what their names say.
 * - `row_unparsable` — the header matched but a row did not have the expected
 *   number of fields.
 */
export type TableParseReason = 'empty_output' | 'header_unrecognized' | 'row_unparsable';

export interface TableParseFailure {
  ok: false;
  reason: TableParseReason;
  /**
   * 1-based line number in the original stdout, or `null` when the failure is
   * not about one line. Deliberately a position and not an excerpt: the caller
   * may log this, and the offending line is remote output that has not been
   * through any redaction yet.
   */
  line: number | null;
}

export interface TableParseSuccess<T> {
  ok: true;
  value: T;
}

export type TableParseResult<T> = TableParseSuccess<T> | TableParseFailure;

/** One line of `df -P`. Field names follow the response convention (snake_case). */
export interface DfEntry {
  filesystem: string;
  /** Size in {@link DfTable.block_size_bytes}-byte blocks, verbatim. */
  blocks: string;
  used: string;
  available: string;
  /** Percentage with its `%`, or `-` when the implementation could not compute it. */
  capacity: string;
  mounted_on: string;
}

export interface DfTable {
  /**
   * Bytes per block, read from the `<N>-blocks` header word. 1024 on GNU and
   * busybox under `-P`, 512 on BSD unless `-k` is also given.
   */
  block_size_bytes: number;
  filesystems: DfEntry[];
}

/** One line of `ps -eo pid,ppid,user,stat,vsz,rss,args`. */
export interface PsEntry {
  pid: string;
  ppid: string;
  user: string;
  stat: string;
  vsz: string;
  rss: string;
  /** Everything after the `rss` column, trailing padding removed. */
  command: string;
}

export interface PsTable {
  processes: PsEntry[];
}

// The `-P` header, in tokens: `Filesystem <N>-blocks Used Available Capacity
// Mounted on` — seven, because `Mounted on` is two.
//
// `Available` has a second accepted spelling because macOS prints `Avail` when
// it is not in UNIX 03 mode (`file_cmds` `df/df.c`: `avail_str =
// unix2003_compat && !hflag ? "Available" : "Avail"`). Accepting it costs
// nothing and does not weaken the guard: the non-`-P` BSD header has nine
// tokens (`... Capacity iused ifree %iused Mounted on`) and is still rejected
// on the token count. The block word is matched as a pattern because it carries
// the unit (`1024-blocks`, `512-blocks`), which also rejects the non-POSIX
// spellings `1K-blocks` (BSD `getbsize`) and `1K-blocks`/`Size` (GNU, busybox).
const DF_HEADER_TOKENS = 7;
const DF_BLOCK_HEADER_PATTERN = /^(\d+)-blocks$/;
const DF_AVAILABLE_HEADERS = new Set(['Available', 'Avail']);

/**
 * One filesystem, right to left.
 *
 * The four middle columns are whitespace-free by construction, but *both* outer
 * columns can contain spaces — a CIFS source is `//host/team share` and its
 * mount point `/mnt/team share`, and macOS prints the automounter source as
 * `map auto_home`. Splitting on whitespace would therefore be wrong at both
 * ends, so the capacity column anchors the match instead: it is the only column
 * whose content is constrained (`NN%`, or `-` when unknown). The leading group
 * is lazy so the engine settles on the first position where the four middle
 * columns and the anchor all line up, which is the real column boundary.
 *
 * `^\S` matters: a row must start at column 1. A continuation line produced by
 * a non-`-P` `df` begins with padding, and this is what rejects it rather than
 * silently reading a filesystem with an empty name.
 */
const DF_ROW_PATTERN = /^(\S.*?)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\d+%|-)[ \t]+(\S.*)$/;

/** `PID PPID USER STAT VSZ RSS` + the command column, whose header differs by OS. */
const PS_HEADER_FIXED = ['PID', 'PPID', 'USER', 'STAT', 'VSZ', 'RSS'];
const PS_COMMAND_HEADERS = new Set(['COMMAND', 'ARGS']);

/** Six whitespace-free columns, then the command with its spaces intact. */
const PS_ROW_PATTERN =
  /^[ \t]*(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S.*)$/;

interface NumberedLine {
  text: string;
  /** 1-based, counted in the original stdout including the blank lines. */
  line: number;
}

/**
 * Split stdout into non-blank lines, keeping each one's original position.
 *
 * `\r` is stripped because a command run inside a session may come back from a
 * pty with CRLF endings, and a trailing `\r` would otherwise become part of the
 * last column's value. Blank lines are dropped rather than rejected: the
 * trailing newline of any normal output would fail the row parser.
 */
function numberedLines(stdout: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  const raw = stdout.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const text = (raw[i] ?? '').replace(/[\r\t ]+$/, '');
    if (text.length > 0) out.push({ text, line: i + 1 });
  }
  return out;
}

function failure(reason: TableParseReason, line: number | null): TableParseFailure {
  return { ok: false, reason, line };
}

/**
 * Parse the output of {@link DF_NORMALIZED_COMMAND}.
 *
 * The header is checked before any row, and strictly: a header that does not
 * match means the output did not come from `df -P`, and the columns of whatever
 * did produce it do not necessarily mean the same things.
 */
export function parseDf(stdout: string): TableParseResult<DfTable> {
  const lines = numberedLines(stdout);
  const header = lines[0];
  if (header === undefined) return failure('empty_output', null);

  const tokens = header.text.trim().split(/[ \t]+/);
  if (tokens.length !== DF_HEADER_TOKENS) return failure('header_unrecognized', header.line);
  const blockToken = tokens[1] ?? '';
  if (
    tokens[0] !== 'Filesystem' ||
    !DF_BLOCK_HEADER_PATTERN.test(blockToken) ||
    tokens[2] !== 'Used' ||
    !DF_AVAILABLE_HEADERS.has(tokens[3] ?? '') ||
    tokens[4] !== 'Capacity' ||
    tokens[5] !== 'Mounted' ||
    tokens[6] !== 'on'
  ) {
    return failure('header_unrecognized', header.line);
  }

  const filesystems: DfEntry[] = [];
  for (const row of lines.slice(1)) {
    const match = DF_ROW_PATTERN.exec(row.text);
    if (match === null) return failure('row_unparsable', row.line);
    filesystems.push({
      filesystem: match[1] ?? '',
      blocks: match[2] ?? '',
      used: match[3] ?? '',
      available: match[4] ?? '',
      capacity: match[5] ?? '',
      mounted_on: match[6] ?? '',
    });
  }

  return {
    ok: true,
    // Safe without a second capture: the pattern above already established that
    // `blockToken` starts with digits, and `parseInt` stops at the `-`.
    value: { block_size_bytes: Number.parseInt(blockToken, 10), filesystems },
  };
}

/**
 * Parse the output of {@link PS_NORMALIZED_COMMAND}.
 *
 * A row whose command column is empty is treated as unparsable rather than as a
 * process with no command line: the two are indistinguishable here, and every
 * implementation prints something (procps and busybox bracket a kernel thread's
 * name, `[kthreadd]`). Rejecting is what catches output cut off mid-line.
 */
export function parsePs(stdout: string): TableParseResult<PsTable> {
  const lines = numberedLines(stdout);
  const header = lines[0];
  if (header === undefined) return failure('empty_output', null);

  const tokens = header.text.trim().split(/[ \t]+/);
  if (tokens.length !== PS_HEADER_FIXED.length + 1) {
    return failure('header_unrecognized', header.line);
  }
  for (let i = 0; i < PS_HEADER_FIXED.length; i += 1) {
    if (tokens[i] !== PS_HEADER_FIXED[i]) return failure('header_unrecognized', header.line);
  }
  if (!PS_COMMAND_HEADERS.has(tokens[PS_HEADER_FIXED.length] ?? '')) {
    return failure('header_unrecognized', header.line);
  }

  const processes: PsEntry[] = [];
  for (const row of lines.slice(1)) {
    const match = PS_ROW_PATTERN.exec(row.text);
    if (match === null) return failure('row_unparsable', row.line);
    processes.push({
      pid: match[1] ?? '',
      ppid: match[2] ?? '',
      user: match[3] ?? '',
      stat: match[4] ?? '',
      vsz: match[5] ?? '',
      rss: match[6] ?? '',
      command: match[7] ?? '',
    });
  }

  return { ok: true, value: { processes } };
}
