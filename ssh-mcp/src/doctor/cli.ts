/**
 * `ssh-mcp doctor` (plan rows 5b.1b, 5b.2, 5b.3, 5b.5, §5.11).
 *
 * Output goes to **stdout**, unlike every other part of this package. The
 * "stdout is JSON-RPC only" rule (Principle 3) applies to server mode, and
 * `doctor` never connects a transport; a diagnostic table is something the user
 * pipes, redirects and pastes, so stdout is the right stream. `setup` keeps
 * stderr because its prompts and its report are interleaved.
 *
 * Exit code: 1 when at least one check FAILed, 0 otherwise. A WARN is a
 * warning, not a failure (§5.11, AC21.6).
 */
import {
  buildChecks,
  buildSnippets,
  formatSnippets,
  loadPatternRows,
  runChecks,
} from './checks.js';
import type { CheckRow, CheckStatus, DoctorOptions, PatternRow } from './checks.js';
import type { ArgvRuleDef } from '../safety/classify.js';

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Usage: ssh-mcp doctor [--json] [--patterns]',
  '',
  'Options:',
  '  --json      점검 결과와 설정 스니펫을 JSON 한 객체로 출력합니다.',
  '  --patterns  명령 분류 패턴 목록만 출력하고 종료합니다 (항상 0).',
  '  -h, --help  이 도움말을 출력합니다.',
].join('\n');

export interface DoctorFlags {
  json: boolean;
  patterns: boolean;
  help: boolean;
}

export type ParsedFlags = { ok: true; flags: DoctorFlags } | { ok: false; message: string };

export function parseDoctorArgs(argv: readonly string[]): ParsedFlags {
  const flags: DoctorFlags = { json: false, patterns: false, help: false };
  for (const token of argv) {
    switch (token) {
      case '--json':
        flags.json = true;
        break;
      case '--patterns':
        flags.patterns = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        return { ok: false, message: `unknown option: ${token}` };
    }
  }
  return { ok: true, flags };
}

export interface DoctorJson {
  ok: boolean;
  checks: CheckRow[];
  snippets: { claudeDesktop: string; claudeCode: string; windows: string };
}

/** Column widths are derived from the content so the table never wraps early. */
function renderTable(rows: readonly CheckRow[]): string {
  const header: CheckRow = {
    id: 'ID',
    name: '항목',
    status: '상태' as CheckStatus,
    detail: '내용',
  };
  const all = [header, ...rows];
  const width = (pick: (row: CheckRow) => string): number =>
    all.reduce((max, row) => Math.max(max, displayWidth(pick(row))), 0);

  const statusWidth = width((row) => row.status);
  const nameWidth = width((row) => row.name);

  const line = (row: CheckRow): string =>
    `${pad(row.status, statusWidth)}  ${pad(row.name, nameWidth)}  ${row.detail}`;

  const separator = `${'-'.repeat(statusWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(4)}`;
  return [line(header), separator, ...rows.map(line)].join('\n');
}

/**
 * Width in terminal cells. CJK text in the Korean check names occupies two
 * cells, so counting code points would misalign every row.
 */
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

function renderPatterns(rows: readonly PatternRow[]): string {
  const header: PatternRow = { id: 'id', scope: 'scope', grade: 'grade', source: '정규식' };
  const all = [header, ...rows];
  const width = (pick: (row: PatternRow) => string): number =>
    all.reduce((max, row) => Math.max(max, displayWidth(pick(row))), 0);
  const idWidth = width((row) => row.id);
  const scopeWidth = width((row) => row.scope);
  const gradeWidth = width((row) => row.grade);
  const line = (row: PatternRow): string =>
    `${pad(row.id, idWidth)} | ${pad(row.scope, scopeWidth)} | ${pad(row.grade, gradeWidth)} | ${row.source}`;
  const separator = `${'-'.repeat(idWidth)} | ${'-'.repeat(scopeWidth)} | ${'-'.repeat(gradeWidth)} | ${'-'.repeat(7)}`;
  return [line(header), separator, ...rows.map(line)].join('\n');
}

/**
 * The argv rules, printed after the regex table.
 *
 * They have no `source` column because there is no regex to paste anywhere:
 * unlike a pattern, an argv rule cannot be switched off from `hosts.json`. The
 * `reason` column is what shows up in a denial, so it is the string an operator
 * would search for.
 */
function renderArgvRules(rules: readonly ArgvRuleDef[]): string {
  const header: ArgvRuleDef = {
    id: 'id',
    grade: 'destructive',
    reason: 'reason',
    description: '설명',
  };
  const all = [header, ...rules];
  const width = (pick: (rule: ArgvRuleDef) => string): number =>
    all.reduce((max, rule) => Math.max(max, displayWidth(pick(rule))), 0);
  const idWidth = width((rule) => rule.id);
  const gradeWidth = Math.max(
    width((rule) => rule.grade),
    displayWidth('grade')
  );
  const line = (rule: ArgvRuleDef, gradeText: string): string =>
    `${pad(rule.id, idWidth)} | ${pad(gradeText, gradeWidth)} | ${rule.description}`;
  const separator = `${'-'.repeat(idWidth)} | ${'-'.repeat(gradeWidth)} | ${'-'.repeat(7)}`;
  return [line(header, 'grade'), separator, ...rules.map((rule) => line(rule, rule.grade))].join(
    '\n'
  );
}

function countFailures(rows: readonly CheckRow[]): number {
  return rows.filter((row) => row.status === 'FAIL').length;
}

function summarise(rows: readonly CheckRow[]): string {
  const counts = new Map<CheckStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const order: CheckStatus[] = ['PASS', 'WARN', 'FAIL', 'INFO'];
  return order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${status} ${String(counts.get(status) ?? 0)}`)
    .join(' · ');
}

/**
 * Run the diagnostics. Returns the process exit code.
 *
 * `options` is for tests: it injects the `icacls` runner and the host prober so
 * a check can be exercised without a live endpoint.
 */
export async function runDoctor(argv: string[], options: DoctorOptions = {}): Promise<number> {
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  const parsed = parseDoctorArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`ssh-mcp doctor: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (parsed.flags.help) {
    out(USAGE);
    return EXIT_OK;
  }

  // `--patterns` is a standalone listing: no checks, always exit 0 (AC21.9).
  if (parsed.flags.patterns) {
    const patterns = loadPatternRows();
    if (parsed.flags.json) {
      out(
        JSON.stringify(
          { ok: true, patterns: patterns.rows, argvRules: patterns.argvRules },
          null,
          2
        )
      );
      return EXIT_OK;
    }
    out('정규식 패턴');
    out(renderPatterns(patterns.rows));
    out('');
    out(
      `정규식 패턴 ${String(patterns.rows.length)}개. ` +
        '위 정규식 문자열을 hosts.json의 patternOverrides.<grade>.remove에 그대로 넣으면 해당 패턴이 해제됩니다. ' +
        '단, 핵심 파괴적 패턴은 제거 요청을 무시합니다.'
    );
    out('');
    out('argv 규칙 (정규식이 아니며 해제할 수 없습니다)');
    out(renderArgvRules(patterns.argvRules));
    out('');
    out(
      `argv 규칙 ${String(patterns.argvRules.length)}개. ` +
        '명령을 토큰 단위로 검사하므로 patternOverrides로 끌 수 없습니다.'
    );
    return EXIT_OK;
  }

  const rows = await runChecks(buildChecks(options));
  const failures = countFailures(rows);

  if (parsed.flags.json) {
    const payload: DoctorJson = {
      ok: failures === 0,
      checks: rows,
      snippets: buildSnippets(),
    };
    out(JSON.stringify(payload, null, 2));
    return failures === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
  }

  out(renderTable(rows));
  out('');
  out(summarise(rows));
  out('');
  out(formatSnippets());
  if (failures > 0) {
    out('');
    out(`FAIL ${String(failures)}건 — 위 내용을 고친 뒤 다시 실행하세요.`);
  }
  return failures === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
