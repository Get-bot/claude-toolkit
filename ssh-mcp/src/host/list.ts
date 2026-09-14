/**
 * `ssh-mcp host list` — what is in the registry, for a person.
 *
 * The same information the `list_hosts` tool gives the model, with the same
 * limits: **no private key path and no full fingerprint.** A fingerprint prefix
 * is enough to recognise a host you pinned, and the key path is of no use to
 * anyone reading a table. Keeping the two surfaces identical means a user and
 * the model are never looking at different pictures of the registry.
 *
 * Output goes to **stdout**, like `doctor` and unlike `setup`: a listing is
 * something people pipe, grep and paste. (The "stdout is JSON-RPC only" rule is
 * about server mode, which this is not.)
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import { DEFAULT_APPROVAL_FALLBACK } from '../config/schema.js';
import type { HostEntry } from '../config/schema.js';
import * as store from '../config/store.js';
import { stripControlChars } from '../internal/util.js';
import { fingerprintPrefix } from '../tools/listHosts.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Usage: ssh-mcp host list [--json]',
  '',
  'Options:',
  '  --json      등록 목록을 JSON 한 객체로 출력합니다 (list_hosts 도구와 같은 필드).',
  '  -h, --help  이 도움말을 출력합니다.',
].join('\n');

/**
 * Replace anything that could move a cursor with a visible placeholder.
 *
 * `host add` refuses control characters in a label, but a `hosts.json` written
 * by an older build or by hand can still hold one, and this table is printed to
 * a terminal. A stored escape sequence would rewrite the screen long after it
 * was entered, so the last line of defence is here, at the point of printing.
 *
 * Replacing, not refusing: a table that cannot be shown because one stored
 * label is malformed would hide every other host too.
 */
export function printable(value: string): string {
  return stripControlChars(value);
}

/** One row of the table, already reduced to what may be shown. */
export interface HostRow {
  alias: string;
  target: string;
  approvalMode: string;
  /** `fail-closed(누락)` when the field is absent and `load()` normalised it. */
  approvalFallback: string;
  fingerprint: string;
  label: string;
}

export function toRow(alias: string, entry: HostEntry, normalised: boolean): HostRow {
  return {
    // Every field is printed to a terminal, so every field is sanitised — not
    // just the label, which is merely the easiest one to get a payload into.
    alias: printable(alias),
    target: printable(`${entry.user}@${entry.hostname}:${String(entry.port)}`),
    approvalMode: entry.approvalMode,
    approvalFallback: normalised
      ? `${DEFAULT_APPROVAL_FALLBACK}(누락)`
      : (entry.approvalFallback ?? DEFAULT_APPROVAL_FALLBACK),
    fingerprint: fingerprintPrefix(entry.hostKey.sha256),
    label: printable(entry.label ?? ''),
  };
}

/** Width in terminal cells; CJK labels occupy two, so counting code points misaligns. */
function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    total += wide ? 2 : 1;
  }
  return total;
}

function pad(text: string, target: number): string {
  const fill = target - displayWidth(text);
  return fill > 0 ? text + ' '.repeat(fill) : text;
}

export function renderTable(rows: readonly HostRow[]): string {
  const header: HostRow = {
    alias: 'ALIAS',
    target: '접속',
    approvalMode: '승인 모드',
    approvalFallback: '폴백',
    fingerprint: '호스트 키',
    label: '라벨',
  };
  const all = [header, ...rows];
  const width = (pick: (row: HostRow) => string): number =>
    all.reduce((max, row) => Math.max(max, displayWidth(pick(row))), 0);

  const widths = {
    alias: width((row) => row.alias),
    target: width((row) => row.target),
    mode: width((row) => row.approvalMode),
    fallback: width((row) => row.approvalFallback),
    fingerprint: width((row) => row.fingerprint),
    label: width((row) => row.label),
  };

  const line = (row: HostRow): string =>
    [
      pad(row.alias, widths.alias),
      pad(row.target, widths.target),
      pad(row.approvalMode, widths.mode),
      pad(row.approvalFallback, widths.fallback),
      pad(row.fingerprint, widths.fingerprint),
      row.label,
    ]
      .join('  ')
      .replace(/\s+$/u, '');

  const separator = [
    '-'.repeat(widths.alias),
    '-'.repeat(widths.target),
    '-'.repeat(widths.mode),
    '-'.repeat(widths.fallback),
    '-'.repeat(widths.fingerprint),
    '-'.repeat(widths.label),
  ].join('  ');

  return [line(header), separator, ...rows.map(line)].join('\n');
}

export interface HostListDeps {
  /** Defaults to stdout. */
  out?: (text: string) => void;
  /** Defaults to stderr; errors and usage go here. */
  err?: (text: string) => void;
}

/** Run `host list`. Returns the process exit code; never throws. */
export function runHostList(argv: readonly string[], deps: HostListDeps = {}): number {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(`${text}\n`));

  let json = false;
  for (const token of argv) {
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      // Help that was asked for goes to stdout, like `doctor`; a usage error
      // below goes to stderr. Asked-for output is not an error.
      out(USAGE);
      return EXIT_OK;
    }
    err(`ssh-mcp host list: unknown option: ${token}`);
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }

  const loaded = store.load();
  if (!loaded.ok) {
    err(`ssh-mcp host list: ${loaded.code}: ${loaded.message}`);
    for (const issue of loaded.issues) err(`  - ${issue.path}: ${issue.message}`);
    err('hosts.json을 고친 뒤 다시 실행하세요.');
    return EXIT_FAILED;
  }

  const normalised = new Set(loaded.normalizedFallbackAliases);
  const entries = Object.entries(loaded.file.hosts);

  if (json) {
    // Deliberately the same field names the `list_hosts` tool returns, so one
    // description in the README covers both.
    const hosts = entries.map(([alias, entry]) => ({
      alias,
      hostname: entry.hostname,
      port: entry.port,
      user: entry.user,
      approval_mode: entry.approvalMode,
      approval_fallback: entry.approvalFallback ?? DEFAULT_APPROVAL_FALLBACK,
      audit_mode: entry.auditMode,
      host_key_fingerprint_prefix: fingerprintPrefix(entry.hostKey.sha256),
      ...(entry.label === undefined ? {} : { label: entry.label }),
    }));
    out(JSON.stringify({ hosts, count: hosts.length }, null, 2));
    return EXIT_OK;
  }

  if (entries.length === 0) {
    out('등록된 호스트가 없습니다. `ssh-mcp host add`로 추가하세요.');
    return EXIT_OK;
  }

  out(renderTable(entries.map(([alias, entry]) => toRow(alias, entry, normalised.has(alias)))));
  return EXIT_OK;
}
