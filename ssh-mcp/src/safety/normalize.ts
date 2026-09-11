/**
 * Command scanner and normaliser (plan rows 2.2-2.5, OPT-4).
 *
 * The classifier never looks at the raw command string: `r""m -rf`, `'rm' -rf`,
 * `r\m -rf` and `rm  -r  -f` are all the same command and must all be caught.
 * This module turns one command string into
 *
 *   - a dequoted, single-space `normalized` string (what the audit log records),
 *   - a `matchTarget` string in which shell metacharacters that came from
 *     inside quotes or from a backslash escape are replaced by NUL, so that
 *     `echo "a | xargs rm -rf"` cannot match a pipeline pattern, and
 *   - a flat list of {@link Segment}s, split only at top level on
 *     `; && || | & <newline>`, including segments recovered from `$(...)`,
 *     backticks and `sh -c <literal>`.
 *
 * Anything the scanner cannot make sense of (unbalanced quoting, substitution
 * nesting deeper than {@link MAX_SUBSTITUTION_DEPTH}, an unterminated here-doc)
 * raises `unparseable`, which the classifier turns into `destructive`.
 */

/** Nesting limit for `$(`, backtick and `${` (plan row 2.3, Critic C15). */
export const MAX_SUBSTITUTION_DEPTH = 6;

/** Top-level separator that ended a segment. `''` for the last segment. */
export type Terminator = '' | ';' | '&&' | '||' | '|' | '&' | '\n';

export type TokenKind = 'word' | 'operator' | 'heredoc';

export interface Token {
  /** Dequoted text. Expansions are kept verbatim (`$VAR`, `$(cmd)`). */
  value: string;
  /** {@link value} with quoted/escaped shell metacharacters replaced by NUL. */
  defanged: string;
  /** Any part of this token came from inside quotes. */
  quoted: boolean;
  /** Contains an unexpanded `$VAR` or `${VAR}`. */
  hasVariable: boolean;
  /** Contains a `$(...)` or backtick substitution. */
  hasSubstitution: boolean;
  kind: TokenKind;
}

export interface ShellWrapperInfo {
  /** Shell program name, path stripped (`sh`, `bash`, `busybox`). */
  shell: string;
  /** The flag cluster that carried `c`, e.g. `-c` or `-lc`. */
  flag: string;
  /** The `-c` argument is a literal string (no variable, no substitution). */
  argLiteral: boolean;
  /** The `-c` argument, or `null` when the flag had no argument. */
  argValue: string | null;
}

export interface Segment {
  /** 0 = top level; 1 = inside one `$()`, backtick or `sh -c` layer. */
  depth: number;
  terminator: Terminator;
  /** Tokens exactly as scanned. */
  rawTokens: readonly Token[];
  /** Leading env assignments and wrappers removed; `sudo`/`su`/`doas` kept. */
  tokens: readonly Token[];
  /** {@link tokens} with the privilege prefix and its flags also removed. */
  commandTokens: readonly Token[];
  /** `tokens` joined with single spaces. */
  normalized: string;
  /** `commandTokens` joined with single spaces. */
  commandNormalized: string;
  /** Defanged form of {@link normalized}. */
  defangedNormalized: string;
  /** Defanged form of {@link commandNormalized}. */
  defangedCommandNormalized: string;
  /** Strings the `scope: 'segment'` patterns are matched against. */
  matchTargets: readonly string[];
  /** Program name with any path prefix removed, `null` when not a plain word. */
  program: string | null;
  /** First effective command token (after the privilege prefix). */
  firstToken: Token | null;
  /** Arguments after {@link program}. */
  args: readonly Token[];
  /** A leading `sudo`, `su`, `doas` or `runuser` was found. */
  privileged: boolean;
  privilegeProgram: string | null;
  /** `sudo -S` / `sudo --stdin`: would read the password from closed stdin. */
  sudoStdinPassword: boolean;
  shellWrapper: ShellWrapperInfo | null;
  envAssignments: readonly string[];
  wrappers: readonly string[];
}

export interface NormalizeResult {
  /** Dequoted, single-space, single-line rendering of the whole command. */
  normalized: string;
  /** {@link normalized} with quoted metacharacters defanged. */
  matchTarget: string;
  /** Every segment, all depths, in scan order. */
  segments: Segment[];
  unparseable: boolean;
  /** Number of here-doc bodies recognised. */
  hereDocs: number;
  /** The last top-level segment ended with `&` (AC10.4). */
  backgroundJob: boolean;
}

/**
 * Characters that create shell structure. When one of these reaches a token
 * through quoting or a backslash escape it is replaced by NUL in the match
 * target: quoted text is data, not a pipeline.
 */
const DEFANGED_CHARS = new Set([';', '|', '&', '<', '>', '\n', '\r']);
const NUL = '\u0000';

/** Wrappers removed before classification (plan row 2.4). */
const WRAPPER_PROGRAMS = new Set([
  'env',
  'nice',
  'ionice',
  'time',
  'nohup',
  'setsid',
  'stdbuf',
  'command',
  'builtin',
  'exec',
]);

/** Kept in place and reported, never stripped from the grade (plan row 2.4). */
const PRIVILEGE_PROGRAMS = new Set(['sudo', 'su', 'doas', 'runuser']);

/** `sh`, `bash`, `zsh`, `ksh`, `dash`, `ash` (plan row 2.5). */
const SHELL_NAME = /^(?:ba|z|k|da|a)?sh$/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMERIC = /^[0-9]+$/;
/** Short sudo flags that consume the next argument (`-u user`, `-g group`). */
const SUDO_VALUE_FLAG = /^-[A-Za-z]*[ugprtCUh]$/;
const SUDO_LONG_VALUE_FLAG = /^--(?:user|group|prompt|role|type|close-from|host|other-user)$/;
const VARIABLE_NAME = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/;

function basename(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? value : value.slice(idx + 1);
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\v' || ch === '\f';
}

/** Collapse whitespace runs so a multi-line quoted token stays on one line. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function joinTokens(tokens: readonly Token[], defanged: boolean): string {
  const parts: string[] = [];
  for (const token of tokens) {
    const text = collapse(defanged ? token.defanged : token.value);
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

// --------------------------------------------------------------------------
// token builder
// --------------------------------------------------------------------------

interface Builder {
  value: string;
  defanged: string;
  quoted: boolean;
  hasVariable: boolean;
  hasSubstitution: boolean;
  started: boolean;
}

function newBuilder(): Builder {
  return {
    value: '',
    defanged: '',
    quoted: false,
    hasVariable: false,
    hasSubstitution: false,
    started: false,
  };
}

function pushChar(builder: Builder, ch: string, literal: boolean): void {
  builder.started = true;
  builder.value += ch;
  builder.defanged += literal && DEFANGED_CHARS.has(ch) ? NUL : ch;
}

function pushRaw(builder: Builder, text: string, literal: boolean): void {
  for (const ch of text) pushChar(builder, ch, literal);
}

function toToken(builder: Builder, kind: TokenKind): Token {
  return {
    value: builder.value,
    defanged: builder.defanged,
    quoted: builder.quoted,
    hasVariable: builder.hasVariable,
    hasSubstitution: builder.hasSubstitution,
    kind,
  };
}

function operatorToken(op: string): Token {
  return {
    value: op,
    defanged: op,
    quoted: false,
    hasVariable: false,
    hasSubstitution: false,
    kind: 'operator',
  };
}

function hereDocToken(body: string): Token {
  let defanged = '';
  for (const ch of body) defanged += DEFANGED_CHARS.has(ch) ? NUL : ch;
  return {
    value: body,
    defanged,
    quoted: true,
    hasVariable: false,
    hasSubstitution: false,
    kind: 'heredoc',
  };
}

// --------------------------------------------------------------------------
// bracket matching
// --------------------------------------------------------------------------

/**
 * Index of the `close` character that balances the `open` sequence starting at
 * `openIndex`, or `-1`. Quote-aware so `$(echo ")")` does not end early.
 */
function findMatching(source: string, openIndex: number, open: string, close: string): number {
  let i = openIndex + open.length;
  let depth = 1;
  let quote: "'" | '"' | null = null;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (source.startsWith(open, i)) {
      depth += 1;
      i += open.length;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function findBacktick(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    i += 1;
  }
  return -1;
}

// --------------------------------------------------------------------------
// ANSI-C quoting: $'\x72\x6d' is `rm`
// --------------------------------------------------------------------------

function decodeAnsiC(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = body.charAt(i + 1);
    i += 2;
    switch (next) {
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'e':
      case 'E':
        out += '\x1b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'v':
        out += '\v';
        break;
      case '\\':
        out += '\\';
        break;
      case "'":
        out += "'";
        break;
      case '"':
        out += '"';
        break;
      case '?':
        out += '?';
        break;
      case 'x':
      case 'u':
      case 'U': {
        const width = next === 'x' ? 2 : next === 'u' ? 4 : 8;
        const hex = new RegExp(`^[0-9a-fA-F]{1,${String(width)}}`).exec(body.slice(i));
        if (hex === null) {
          out += next;
          break;
        }
        out += String.fromCodePoint(Number.parseInt(hex[0], 16));
        i += hex[0].length;
        break;
      }
      case 'c': {
        const target = body.charAt(i);
        if (target === '') break;
        i += 1;
        out += String.fromCharCode(target.toUpperCase().charCodeAt(0) ^ 0x40);
        break;
      }
      default: {
        if (next >= '0' && next <= '7') {
          const rest = /^[0-7]{0,2}/.exec(body.slice(i));
          const digits = next + (rest === null ? '' : rest[0]);
          i += digits.length - 1;
          out += String.fromCharCode(Number.parseInt(digits, 8));
          break;
        }
        if (next === '') break;
        out += `\\${next}`;
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// here-docs
// --------------------------------------------------------------------------

interface HereDocSpec {
  delim: string;
  stripTabs: boolean;
}

interface HereDocBody {
  body: string;
  next: number;
  closed: boolean;
}

function readHereDocBody(source: string, start: number, spec: HereDocSpec): HereDocBody {
  const lines: string[] = [];
  let pos = start;
  for (;;) {
    const eol = source.indexOf('\n', pos);
    const isLast = eol === -1;
    const line = source.slice(pos, isLast ? source.length : eol);
    const probe = spec.stripTabs ? line.replace(/^\t+/, '') : line;
    if (probe === spec.delim) {
      return {
        body: lines.join('\n'),
        next: isLast ? source.length : eol + 1,
        closed: true,
      };
    }
    lines.push(probe);
    if (isLast) return { body: lines.join('\n'), next: source.length, closed: false };
    pos = eol + 1;
  }
}

// --------------------------------------------------------------------------
// prefix stripping and segment assembly
// --------------------------------------------------------------------------

interface StripResult {
  effective: Token[];
  envAssignments: string[];
  wrappers: string[];
}

function skipWrapperOptions(tokens: readonly Token[], from: number, env: string[]): number {
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'word') break;
    if (token.value.startsWith('-') && token.value !== '-') {
      i += 1;
      continue;
    }
    if (NUMERIC.test(token.value)) {
      i += 1;
      continue;
    }
    if (ENV_ASSIGNMENT.test(token.value)) {
      env.push(token.value);
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function stripPrefixes(tokens: readonly Token[]): StripResult {
  const envAssignments: string[] = [];
  const wrappers: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'word') break;
    if (!token.quoted && ENV_ASSIGNMENT.test(token.value)) {
      envAssignments.push(token.value);
      i += 1;
      continue;
    }
    const name = basename(token.value);
    if (WRAPPER_PROGRAMS.has(name)) {
      wrappers.push(name);
      i = skipWrapperOptions(tokens, i + 1, envAssignments);
      continue;
    }
    break;
  }
  return { effective: tokens.slice(i), envAssignments, wrappers };
}

interface PrivilegeResult {
  commandTokens: Token[];
  privileged: boolean;
  privilegeProgram: string | null;
  sudoStdinPassword: boolean;
}

function stripPrivilegePrefix(tokens: readonly Token[]): PrivilegeResult {
  const head = tokens[0];
  if (head === undefined || head.kind !== 'word') {
    return {
      commandTokens: [...tokens],
      privileged: false,
      privilegeProgram: null,
      sudoStdinPassword: false,
    };
  }
  const program = basename(head.value);
  if (!PRIVILEGE_PROGRAMS.has(program)) {
    return {
      commandTokens: [...tokens],
      privileged: false,
      privilegeProgram: null,
      sudoStdinPassword: false,
    };
  }

  let stdinPassword = false;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'word') break;
    const value = token.value;
    if (value === '--') {
      i += 1;
      break;
    }
    if (value.startsWith('-') && value !== '-') {
      if (value === '--stdin') stdinPassword = true;
      if (!value.startsWith('--') && /S/.test(value.slice(1))) stdinPassword = true;
      i += 1;
      if (
        SUDO_LONG_VALUE_FLAG.test(value) ||
        (!value.startsWith('--') && SUDO_VALUE_FLAG.test(value))
      ) {
        i += 1;
      }
      continue;
    }
    if (value === '-') {
      i += 1;
      continue;
    }
    if (!token.quoted && ENV_ASSIGNMENT.test(value)) {
      i += 1;
      continue;
    }
    break;
  }

  return {
    commandTokens: tokens.slice(i),
    privileged: true,
    privilegeProgram: program,
    sudoStdinPassword: stdinPassword,
  };
}

interface ScanContext {
  unparseable: boolean;
  hereDocs: number;
  all: Segment[];
}

function detectShellWrapper(
  commandTokens: readonly Token[],
  depth: number,
  ctx: ScanContext,
): ShellWrapperInfo | null {
  const head = commandTokens[0];
  if (head === undefined || head.kind !== 'word' || head.hasVariable || head.hasSubstitution) {
    return null;
  }
  const name = basename(head.value);
  let argsFrom = 1;
  let shell = name;
  if (name === 'busybox') {
    const second = commandTokens[1];
    if (
      second === undefined ||
      second.kind !== 'word' ||
      !SHELL_NAME.test(basename(second.value))
    ) {
      return null;
    }
    shell = basename(second.value);
    argsFrom = 2;
  } else if (!SHELL_NAME.test(name)) {
    return null;
  }

  for (let i = argsFrom; i < commandTokens.length; i += 1) {
    const token = commandTokens[i];
    if (token === undefined || token.kind !== 'word') break;
    const value = token.value;
    if (!value.startsWith('-')) break;
    if (value.startsWith('--')) continue;
    if (!value.includes('c')) continue;
    const arg = commandTokens[i + 1];
    if (arg === undefined || arg.kind === 'operator') {
      return { shell, flag: value, argLiteral: false, argValue: null };
    }
    const literal = !arg.hasVariable && !arg.hasSubstitution;
    if (literal && depth + 1 <= MAX_SUBSTITUTION_DEPTH) {
      scanLevel(arg.value, depth + 1, ctx);
    } else if (literal) {
      ctx.unparseable = true;
    }
    return { shell, flag: value, argLiteral: literal, argValue: arg.value };
  }
  return null;
}

function buildSegment(
  rawTokens: Token[],
  terminator: Terminator,
  depth: number,
  ctx: ScanContext,
): Segment {
  const stripped = stripPrefixes(rawTokens);
  const privilege = stripPrivilegePrefix(stripped.effective);
  const firstToken = privilege.commandTokens[0] ?? null;
  const program =
    firstToken !== null &&
    firstToken.kind === 'word' &&
    !firstToken.hasVariable &&
    !firstToken.hasSubstitution
      ? basename(firstToken.value)
      : null;

  const normalized = joinTokens(stripped.effective, false);
  const commandNormalized = joinTokens(privilege.commandTokens, false);
  const defangedNormalized = joinTokens(stripped.effective, true);
  const defangedCommandNormalized = joinTokens(privilege.commandTokens, true);
  const matchTargets =
    defangedCommandNormalized !== '' && defangedCommandNormalized !== defangedNormalized
      ? [defangedNormalized, defangedCommandNormalized]
      : [defangedNormalized];

  return {
    depth,
    terminator,
    rawTokens,
    tokens: stripped.effective,
    commandTokens: privilege.commandTokens,
    normalized,
    commandNormalized,
    defangedNormalized,
    defangedCommandNormalized,
    matchTargets,
    program,
    firstToken,
    args: privilege.commandTokens.slice(1),
    privileged: privilege.privileged,
    privilegeProgram: privilege.privilegeProgram,
    sudoStdinPassword: privilege.sudoStdinPassword,
    shellWrapper: detectShellWrapper(privilege.commandTokens, depth, ctx),
    envAssignments: stripped.envAssignments,
    wrappers: stripped.wrappers,
  };
}

// --------------------------------------------------------------------------
// the scanner
// --------------------------------------------------------------------------

function scanLevel(source: string, depth: number, ctx: ScanContext): Segment[] {
  const level: Segment[] = [];
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    ctx.unparseable = true;
    return level;
  }

  let tokens: Token[] = [];
  let builder: Builder | null = null;
  let pending: HereDocSpec[] = [];
  let quote: "'" | '"' | null = null;
  let i = 0;
  const n = source.length;

  const ensure = (): Builder => {
    builder ??= newBuilder();
    return builder;
  };
  const tokenStarted = (): boolean => builder !== null && builder.started;
  const flush = (): void => {
    if (builder === null) return;
    if (builder.started) tokens.push(toToken(builder, 'word'));
    builder = null;
  };
  const pushOperator = (op: string): void => {
    flush();
    tokens.push(operatorToken(op));
  };
  const endSegment = (terminator: Terminator): void => {
    flush();
    if (tokens.length > 0) {
      const segment = buildSegment(tokens, terminator, depth, ctx);
      level.push(segment);
      ctx.all.push(segment);
    }
    tokens = [];
  };
  const consumeHereDocs = (from: number): number => {
    let pos = from;
    for (const spec of pending) {
      const read = readHereDocBody(source, pos, spec);
      ctx.hereDocs += 1;
      if (!read.closed) ctx.unparseable = true;
      tokens.push(hereDocToken(read.body));
      pos = read.next;
    }
    pending = [];
    return pos;
  };

  while (i < n) {
    const ch = source.charAt(i);

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        i += 1;
        continue;
      }
      pushChar(ensure(), ch, true);
      i += 1;
      continue;
    }

    // `$` expansions behave the same inside double quotes and unquoted.
    if (ch === '$') {
      if (quote === null && source.startsWith("$'", i)) {
        const close = source.indexOf("'", i + 2);
        const end = close === -1 ? n : close;
        if (close === -1) ctx.unparseable = true;
        const decoded = decodeAnsiC(source.slice(i + 2, end));
        const target = ensure();
        target.quoted = true;
        pushRaw(target, decoded, true);
        i = end + 1;
        continue;
      }
      if (source.startsWith('$((', i)) {
        const close = source.indexOf('))', i + 3);
        if (close === -1) ctx.unparseable = true;
        const end = close === -1 ? n : close + 2;
        const target = ensure();
        target.hasVariable = true;
        pushRaw(target, source.slice(i, end), false);
        i = end;
        continue;
      }
      if (source.startsWith('$(', i)) {
        const close = findMatching(source, i, '$(', ')');
        if (close === -1) {
          ctx.unparseable = true;
          const target = ensure();
          target.hasSubstitution = true;
          pushRaw(target, source.slice(i), false);
          i = n;
          continue;
        }
        const target = ensure();
        target.hasSubstitution = true;
        pushRaw(target, source.slice(i, close + 1), false);
        if (depth + 1 > MAX_SUBSTITUTION_DEPTH) {
          ctx.unparseable = true;
        } else {
          scanLevel(source.slice(i + 2, close), depth + 1, ctx);
        }
        i = close + 1;
        continue;
      }
      if (source.startsWith('${', i)) {
        const close = findMatching(source, i, '${', '}');
        if (close === -1) {
          ctx.unparseable = true;
          const target = ensure();
          target.hasVariable = true;
          pushRaw(target, source.slice(i), false);
          i = n;
          continue;
        }
        const inner = source.slice(i + 2, close);
        if (inner === 'IFS') {
          // The classic `rm${IFS}-rf` separator bypass: IFS expands to blank.
          flush();
          i = close + 1;
          continue;
        }
        if (depth + 1 > MAX_SUBSTITUTION_DEPTH) ctx.unparseable = true;
        const target = ensure();
        target.hasVariable = true;
        pushRaw(target, source.slice(i, close + 1), false);
        i = close + 1;
        continue;
      }
      const named = VARIABLE_NAME.exec(source.slice(i));
      if (named !== null) {
        if (named[0] === '$IFS') {
          flush();
          i += named[0].length;
          continue;
        }
        const target = ensure();
        target.hasVariable = true;
        pushRaw(target, named[0], false);
        i += named[0].length;
        continue;
      }
      pushChar(ensure(), '$', quote === '"');
      i += 1;
      continue;
    }

    if (ch === '`') {
      const close = findBacktick(source, i + 1);
      const target = ensure();
      target.hasSubstitution = true;
      if (close === -1) {
        ctx.unparseable = true;
        pushRaw(target, source.slice(i), false);
        i = n;
        continue;
      }
      pushRaw(target, source.slice(i, close + 1), false);
      if (depth + 1 > MAX_SUBSTITUTION_DEPTH) {
        ctx.unparseable = true;
      } else {
        scanLevel(source.slice(i + 1, close), depth + 1, ctx);
      }
      i = close + 1;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        const next = source.charAt(i + 1);
        if (next === '') {
          ctx.unparseable = true;
          i += 1;
          continue;
        }
        if (next === '\n') {
          i += 2;
          continue;
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          pushChar(ensure(), next, true);
          i += 2;
          continue;
        }
        const target = ensure();
        pushChar(target, '\\', true);
        pushChar(target, next, true);
        i += 2;
        continue;
      }
      pushChar(ensure(), ch, true);
      i += 1;
      continue;
    }

    // ---- unquoted ----
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      if (next === '') {
        ctx.unparseable = true;
        i += 1;
        continue;
      }
      if (next === '\n') {
        i += 2;
        continue;
      }
      pushChar(ensure(), next, true);
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      ensure().quoted = true;
      i += 1;
      continue;
    }

    if (ch === '#' && !tokenStarted()) {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      continue;
    }

    if (source.startsWith('<<<', i)) {
      pushOperator('<<<');
      i += 3;
      continue;
    }

    if (source.startsWith('<<', i)) {
      const stripTabs = source.charAt(i + 2) === '-';
      let j = i + (stripTabs ? 3 : 2);
      while (j < n && isBlank(source.charAt(j))) j += 1;
      let delim = '';
      while (j < n) {
        const dc = source.charAt(j);
        if (dc === "'" || dc === '"') {
          const close = source.indexOf(dc, j + 1);
          if (close === -1) {
            ctx.unparseable = true;
            delim += source.slice(j + 1);
            j = n;
            break;
          }
          delim += source.slice(j + 1, close);
          j = close + 1;
          continue;
        }
        if (
          isBlank(dc) ||
          dc === '\n' ||
          dc === ';' ||
          dc === '|' ||
          dc === '&' ||
          dc === '>'
        ) {
          break;
        }
        if (dc === '\\') {
          delim += source.charAt(j + 1);
          j += 2;
          continue;
        }
        delim += dc;
        j += 1;
      }
      pushOperator('<<');
      if (delim === '') {
        ctx.unparseable = true;
      } else {
        tokens.push(operatorToken(delim));
        pending.push({ delim, stripTabs });
      }
      i = j;
      continue;
    }

    if (source.startsWith('&&', i)) {
      endSegment('&&');
      i += 2;
      continue;
    }
    if (source.startsWith('||', i)) {
      endSegment('||');
      i += 2;
      continue;
    }
    if (source.startsWith('&>>', i)) {
      pushOperator('&>>');
      i += 3;
      continue;
    }
    if (source.startsWith('&>', i)) {
      pushOperator('&>');
      i += 2;
      continue;
    }
    if (source.startsWith('>>', i)) {
      pushOperator('>>');
      i += 2;
      continue;
    }
    if (source.startsWith('>&', i)) {
      pushOperator('>&');
      i += 2;
      continue;
    }
    if (source.startsWith('>|', i)) {
      pushOperator('>|');
      i += 2;
      continue;
    }
    if (source.startsWith('<&', i)) {
      pushOperator('<&');
      i += 2;
      continue;
    }
    if (source.startsWith('<>', i)) {
      pushOperator('<>');
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      pushOperator(ch);
      i += 1;
      continue;
    }
    if (ch === '|') {
      endSegment('|');
      i += 1;
      continue;
    }
    if (ch === '&') {
      endSegment('&');
      i += 1;
      continue;
    }
    if (source.startsWith(';;', i)) {
      endSegment(';');
      i += 2;
      continue;
    }
    if (ch === ';') {
      endSegment(';');
      i += 1;
      continue;
    }
    if (ch === '\n') {
      flush();
      i = pending.length > 0 ? consumeHereDocs(i + 1) : i + 1;
      endSegment('\n');
      continue;
    }
    if (isBlank(ch)) {
      flush();
      i += 1;
      continue;
    }

    pushChar(ensure(), ch, false);
    i += 1;
  }

  if (quote !== null) ctx.unparseable = true;
  if (pending.length > 0) {
    ctx.hereDocs += pending.length;
    ctx.unparseable = true;
    pending = [];
  }
  endSegment('');
  return level;
}

function joinSegments(segments: readonly Segment[], defanged: boolean): string {
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    const text = defanged ? segment.defangedNormalized : segment.normalized;
    if (text !== '') parts.push(text);
    if (index < segments.length - 1) {
      const terminator = segment.terminator;
      parts.push(terminator === '\n' || terminator === '' ? ';' : terminator);
    }
  });
  return parts.join(' ');
}

/** Scan and normalise one command string. Never throws. */
export function normalize(command: string): NormalizeResult {
  const ctx: ScanContext = { unparseable: false, hereDocs: 0, all: [] };
  const top = scanLevel(command, 0, ctx);
  const last = top[top.length - 1];
  return {
    normalized: joinSegments(top, false),
    matchTarget: joinSegments(top, true),
    segments: ctx.all,
    unparseable: ctx.unparseable,
    hereDocs: ctx.hereDocs,
    backgroundJob: last !== undefined && last.terminator === '&',
  };
}
