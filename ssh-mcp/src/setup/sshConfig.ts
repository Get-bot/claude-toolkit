/**
 * Reading one `Host` block out of an OpenSSH `ssh_config` (plan F1, ADR-013).
 *
 * `host add --from-ssh-config <Host>` exists so that a person who already
 * described a server to OpenSSH does not have to describe it again. What it
 * imports is **metadata only** — `HostName`, `Port`, `User` — and nothing else
 * (decision D5). No key is reused, no agent is consulted, no `known_hosts`
 * entry is trusted; the password, the fingerprint confirmation and the
 * generated key pair all happen exactly as they do without this flag.
 *
 * Three rules are load-bearing, and all three are about refusing to guess:
 *
 * - **Exact literal match only** (AC-S1). A block is the target when its
 *   pattern list contains the requested name spelled out. Matching `web01`
 *   against `web*` would install our public key on whichever machine that
 *   pattern happened to resolve to (risk R35).
 * - **No partial import** (AC-S3). When anything in the file could change the
 *   answer and we cannot evaluate it the way OpenSSH would — a wildcard block
 *   that also sets one of our three keywords, a `Match` block, a `ProxyJump` —
 *   the whole import fails with `config_unsupported` and the caller exits 2.
 *   Handing back three of four correct values is worse than handing back none.
 * - **One level of `Include`** (AC-S2). A nested `Include` is skipped with a
 *   line on stderr rather than followed, because the cycle and depth rules that
 *   would make following it safe are more machinery than this feature is worth.
 *
 * Two deliberate departures from OpenSSH's own semantics, both in the
 * conservative direction:
 *
 * - OpenSSH takes the **first** value obtained for a keyword across the whole
 *   file, so a `Host *` block placed above the exact block wins. We do not
 *   implement that ordering; instead any wildcard block that sets `HostName`,
 *   `Port`, `User`, `ProxyJump` or `ProxyCommand` and matches the requested
 *   name makes the import unsupported. A wildcard block that only sets, say,
 *   `ServerAliveInterval` cannot change our three values and is ignored — this
 *   is the one place where being precise about *which* wildcard blocks matter
 *   buys a great deal, because `Host *` with connection-keepalive settings is
 *   in a large share of real configs.
 * - `Match` is not evaluated. A `Match` block that sets one of those same five
 *   keywords makes the import unsupported, whatever its condition, because
 *   deciding whether it applies means reimplementing `ssh -G`.
 *
 * The parser never throws for a malformed file; every failure comes back as a
 * reason code the caller turns into one stderr line and exit code 2. These
 * reasons are **CLI exit reasons, not `ERROR_CODES`** — no tool response
 * carries them, so they deliberately stay out of `../errors.ts`.
 *
 * `fs` is reached through a namespace import and never through a named one
 * (guard G-3, `scripts/assert-bundle-imports.mjs`). That also rules out
 * `fs.globSync`, which is why `Include` globbing is `readdirSync` plus the
 * matcher below: `globSync` arrived in Node 22 and `engines` still allows
 * `^20.17.0`, so a named import of it would link fine and throw at call time on
 * a supported Node.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Environment variable that redirects the config path (plan OP-4). */
export const SSH_CONFIG_ENV = 'SSH_MCP_SSH_CONFIG';

/**
 * Keywords whose presence in a block we cannot ignore.
 *
 * The first three are what we import; the last two are connection rewrites that
 * would send the setup flow somewhere other than where it reports going.
 */
const DECIDING_KEYWORDS = ['hostname', 'port', 'user', 'proxyjump', 'proxycommand'] as const;

/** Keywords read and then thrown away, with a notice (AC-S4). */
const IGNORED_IDENTITY_KEYWORDS = ['identityfile', 'identityagent'] as const;

export type SshConfigFailure =
  /** A construct we refuse to interpret: wildcard block, `Match`, `ProxyJump` (AC-S3). */
  | 'config_unsupported'
  /** No config file at the resolved path. */
  | 'config_missing'
  /** The file parsed, but no block matches the requested name exactly. */
  | 'config_host_not_found'
  /** A value we do import is out of range, e.g. `Port 0`. */
  | 'config_invalid'
  /** The file exists and could not be read. */
  | 'config_read_failed';

/** What one `Host` block yields, before anything is confirmed by a human. */
export interface SshConfigHost {
  /** The requested `Host` name; the default alias (AC-S1). */
  alias: string;
  /** `HostName`, or the `Host` name when the block does not set one. */
  hostname: string;
  /** `Port`, or `null` when absent — the caller applies its own default. */
  port: number | null;
  /** `User`, or `null` when absent. */
  user: string | null;
  /** `IdentityFile`/`IdentityAgent` were present and ignored (AC-S4). */
  identityIgnored: boolean;
}

export type SshConfigResult =
  | { ok: true; host: SshConfigHost; path: string; warnings: string[] }
  | { ok: false; reason: SshConfigFailure; message: string; path: string; warnings: string[] };

/**
 * The file-system and environment edges, injected so tests need no real home.
 *
 * `readDir` exists separately from `readFile` because `Include` globbing scans
 * directories, and a test that wants to prove the glob works on Node 20 has to
 * be able to say what a directory contains.
 */
export interface SshConfigIo {
  readFile?: (file: string) => string;
  readDir?: (dir: string) => string[];
  homeDir?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the resolved path outright; `SSH_CONFIG_ENV` is the user-facing form. */
  path?: string;
}

/** Where the config is read from: the env override, else `~/.ssh/config`. */
export function sshConfigPath(io: SshConfigIo = {}): string {
  if (io.path !== undefined && io.path !== '') return io.path;
  const override = (io.env ?? process.env)[SSH_CONFIG_ENV];
  if (override !== undefined && override !== '') return override;
  const home = (io.homeDir ?? os.homedir)();
  return path.join(home, '.ssh', 'config');
}

/**
 * Compile an OpenSSH pattern (`*` and `?`) to a regular expression.
 *
 * Used for both `Host` patterns and one path segment of an `Include` glob. A
 * segment is matched against a single `readdir` entry, which contains no
 * separator, so `*` cannot cross a directory boundary here even though the
 * expression it compiles to would allow it.
 */
export function patternToRegExp(pattern: string): RegExp {
  let body = '';
  for (const char of pattern) {
    if (char === '*') body += '.*';
    else if (char === '?') body += '.';
    else body += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${body}$`, 'u');
}

/** Does this pattern need matching rules rather than a string compare? */
function isPattern(token: string): boolean {
  return /[*?!]/u.test(token);
}

/** A pattern, negated or not, that OpenSSH would apply to `name`. */
function patternMatches(token: string, name: string): boolean {
  const bare = token.startsWith('!') ? token.slice(1) : token;
  return patternToRegExp(bare).test(name);
}

/**
 * Split a directive's value into tokens, honouring double quotes.
 *
 * `Host "my server" web01` is two patterns, not three, and `IdentityFile "~/a
 * b"` is one path. Nothing downstream re-splits, so the quotes are consumed
 * here and never reappear in an imported value.
 */
export function tokenizeValue(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/u.test(char)) {
      if (started || current !== '') out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current !== '') out.push(current);
  return out;
}

/** Drop the comment tail. `#` inside double quotes is data, not a comment. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

interface Directive {
  /** Lower-cased keyword: ssh_config keywords are case-insensitive. */
  keyword: string;
  /** Everything after the keyword, still unsplit. */
  value: string;
}

/** `key value`, `key=value` and `key = value` are the same directive. */
function parseLine(rawLine: string): Directive | null {
  const line = stripComment(rawLine).trim();
  if (line === '') return null;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/u.exec(line);
  if (match === null) return null;
  const keyword = (match[1] ?? '').toLowerCase();
  const value = (match[2] ?? '').trim();
  if (keyword === '' || value === '') return null;
  return { keyword, value };
}

/**
 * Expand one `Include` token into concrete file paths.
 *
 * `~` is expanded, a relative path is resolved against the directory of the
 * file doing the including — which is `~/.ssh` for the ordinary
 * `~/.ssh/config`, matching OpenSSH, and stays sane when `SSH_MCP_SSH_CONFIG`
 * points somewhere else entirely.
 */
function resolveIncludeToken(token: string, baseDir: string, home: string): string {
  let candidate = token;
  if (candidate === '~') candidate = home;
  else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(home, candidate.slice(2));
  }
  return path.isAbsolute(candidate) ? candidate : path.join(baseDir, candidate);
}

/**
 * Resolve a possibly-globbed absolute path to the files it names.
 *
 * Deliberately not `fs.globSync`: that landed in Node 22 and this package still
 * supports Node 20 (`engines` allows `^20.17.0`), where it is `undefined` and
 * calling it is a `TypeError` at run time — a failure the bundle-import guard
 * cannot see, because it only inspects *named* builtin imports.
 *
 * Results are sorted per segment, so two runs over the same directory produce
 * the same order.
 */
export function expandIncludeGlob(
  absolutePattern: string,
  readDir: (dir: string) => string[]
): string[] {
  if (!/[*?]/u.test(absolutePattern)) return [absolutePattern];

  const root = path.parse(absolutePattern).root;
  const rest = absolutePattern
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '');

  let current: string[] = [root === '' ? '.' : root];
  for (const segment of rest) {
    if (!/[*?]/u.test(segment)) {
      current = current.map((dir) => path.join(dir, segment));
      continue;
    }
    const matcher = patternToRegExp(segment);
    const next: string[] = [];
    for (const dir of current) {
      let entries: string[];
      try {
        entries = readDir(dir);
      } catch {
        // Not a directory, or unreadable. A glob that matches nothing is not an
        // error in OpenSSH either.
        continue;
      }
      for (const entry of [...entries].sort()) {
        // A leading dot is not matched by a leading `*`, as in a shell.
        if (entry.startsWith('.') && !segment.startsWith('.')) continue;
        if (matcher.test(entry)) next.push(path.join(dir, entry));
      }
    }
    current = next;
  }
  return current;
}

/** One block of the config: a `Host` pattern list, a `Match`, or the preamble. */
interface Block {
  kind: 'host' | 'match' | 'global';
  patterns: string[];
  directives: Directive[];
}

interface FlattenIo {
  readFile: (file: string) => string;
  readDir: (dir: string) => string[];
  home: string;
  warnings: string[];
}

/**
 * Read one file's directives, expanding `Include` in place at depth 0 only.
 *
 * In place, rather than appended at the end, because an `Include` written
 * inside a `Host` block contributes to that block in OpenSSH. Appending would
 * silently move those directives into whatever block came last.
 */
function flatten(file: string, depth: number, io: FlattenIo): Directive[] {
  let text: string;
  try {
    text = io.readFile(file);
  } catch {
    if (depth > 0) io.warnings.push(`ssh_config: Include 대상을 읽지 못해 건너뜁니다: ${file}`);
    return [];
  }
  return flattenText(text, file, depth, io);
}

function flattenText(text: string, file: string, depth: number, io: FlattenIo): Directive[] {
  const out: Directive[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const directive = parseLine(rawLine);
    if (directive === null) continue;
    if (directive.keyword !== 'include') {
      out.push(directive);
      continue;
    }
    if (depth > 0) {
      io.warnings.push(
        `ssh_config: ${file}의 Include는 1단계까지만 따릅니다. 이 안의 Include는 무시했습니다.`
      );
      continue;
    }
    const baseDir = path.dirname(file);
    for (const token of tokenizeValue(directive.value)) {
      const resolved = resolveIncludeToken(token, baseDir, io.home);
      for (const included of expandIncludeGlob(resolved, io.readDir)) {
        out.push(...flatten(included, depth + 1, io));
      }
    }
  }
  return out;
}

/** Group a flat directive list into `Host`/`Match` blocks. */
function toBlocks(directives: readonly Directive[]): Block[] {
  const blocks: Block[] = [{ kind: 'global', patterns: [], directives: [] }];
  for (const directive of directives) {
    if (directive.keyword === 'host') {
      blocks.push({ kind: 'host', patterns: tokenizeValue(directive.value), directives: [] });
      continue;
    }
    if (directive.keyword === 'match') {
      blocks.push({ kind: 'match', patterns: tokenizeValue(directive.value), directives: [] });
      continue;
    }
    blocks[blocks.length - 1]?.directives.push(directive);
  }
  return blocks;
}

/** First value for a keyword inside one block; OpenSSH keeps the first, not the last. */
function firstValue(block: Block, keyword: string): string | null {
  for (const directive of block.directives) {
    if (directive.keyword === keyword) return tokenizeValue(directive.value)[0] ?? null;
  }
  return null;
}

function hasKeyword(block: Block, keywords: readonly string[]): boolean {
  return block.directives.some((directive) => keywords.includes(directive.keyword));
}

/**
 * Find and read the `Host` block for `name`.
 *
 * Never throws. The caller prints `message` and exits 2 on failure, and prints
 * every `warnings` entry either way — a warning is about a part of the file we
 * skipped, which is worth saying even when the import succeeded.
 */
export function readSshConfigHost(name: string, io: SshConfigIo = {}): SshConfigResult {
  const file = sshConfigPath(io);
  const readFile = io.readFile ?? ((target: string): string => fs.readFileSync(target, 'utf8'));
  const readDir = io.readDir ?? ((dir: string): string[] => fs.readdirSync(dir));
  const home = (io.homeDir ?? os.homedir)();
  const warnings: string[] = [];
  const fail = (reason: SshConfigFailure, message: string): SshConfigResult => ({
    ok: false,
    reason,
    message,
    path: file,
    warnings,
  });

  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail('config_missing', `ssh_config를 찾을 수 없습니다: ${file}`);
    }
    return fail(
      'config_read_failed',
      `ssh_config를 읽지 못했습니다: ${file} (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const directives = flattenText(text, file, 0, { readFile, readDir, home, warnings });
  const blocks = toBlocks(directives);

  const target = blocks.find((block) => block.kind === 'host' && block.patterns.includes(name));
  if (target === undefined) {
    return fail(
      'config_host_not_found',
      `ssh_config에 "${name}" 항목이 없습니다 (${file}). Host 이름과 정확히 같아야 합니다.`
    );
  }

  // AC-S3, first form: the block we matched literally also carries a pattern.
  // Which value OpenSSH would use then depends on rules we are not applying.
  const wildcardInTarget = target.patterns.find((pattern) => isPattern(pattern));
  if (wildcardInTarget !== undefined) {
    return fail(
      'config_unsupported',
      `config_unsupported: "${name}" 블록의 Host 목록에 와일드카드 패턴 "${wildcardInTarget}"이 ` +
        '있어 어떤 값이 적용될지 단정할 수 없습니다. alias와 user@host를 직접 지정하세요.'
    );
  }

  // AC-S3, second form: a rewrite inside the target block.
  const proxy = target.directives.find(
    (directive) => directive.keyword === 'proxyjump' || directive.keyword === 'proxycommand'
  );
  if (proxy !== undefined) {
    return fail(
      'config_unsupported',
      `config_unsupported: "${name}" 블록에 ${proxy.keyword === 'proxyjump' ? 'ProxyJump' : 'ProxyCommand'}가 ` +
        '있습니다. ssh-mcp는 경유 접속을 지원하지 않으므로 가져오지 않습니다.'
    );
  }

  // AC-S3, third form: something outside the block could still decide the
  // answer. A `Match` is never evaluated, and a wildcard `Host` counts only
  // when it sets one of the keywords we would import or rewrite.
  for (const block of blocks) {
    if (block === target) continue;
    if (!hasKeyword(block, DECIDING_KEYWORDS)) continue;
    if (block.kind === 'match') {
      return fail(
        'config_unsupported',
        'config_unsupported: 이 ssh_config에는 접속 대상을 바꾸는 Match 블록이 있습니다. ' +
          '적용 여부를 판정할 수 없으므로 가져오지 않습니다.'
      );
    }
    if (block.kind === 'global') {
      return fail(
        'config_unsupported',
        'config_unsupported: ssh_config의 첫 Host 블록 앞에 HostName·Port·User를 설정하는 줄이 ' +
          '있습니다. 모든 호스트에 적용되는 값이라 어느 쪽이 이길지 단정할 수 없습니다.'
      );
    }
    const matching = block.patterns.find(
      (pattern) => isPattern(pattern) && patternMatches(pattern, name)
    );
    if (matching === undefined) continue;
    return fail(
      'config_unsupported',
      `config_unsupported: "${name}"에도 적용되는 와일드카드 블록 "Host ${matching}"이 ` +
        'HostName·Port·User 중 하나를 설정합니다. 어느 값이 이길지 단정할 수 없으므로 ' +
        '가져오지 않습니다.'
    );
  }

  const portText = firstValue(target, 'port');
  let port: number | null = null;
  if (portText !== null) {
    if (!/^\d+$/u.test(portText)) {
      return fail('config_invalid', `ssh_config의 Port 값이 숫자가 아닙니다: "${portText}"`);
    }
    port = Number.parseInt(portText, 10);
    if (port < 1 || port > 65535) {
      return fail(
        'config_invalid',
        `ssh_config의 Port 값이 1–65535 범위를 벗어납니다: ${portText}`
      );
    }
  }

  return {
    ok: true,
    path: file,
    warnings,
    host: {
      alias: name,
      hostname: firstValue(target, 'hostname') ?? name,
      port,
      user: firstValue(target, 'user'),
      identityIgnored: hasKeyword(target, IGNORED_IDENTITY_KEYWORDS),
    },
  };
}
