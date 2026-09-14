/**
 * The question-by-question front door to `ssh-mcp setup`.
 *
 * `setup <alias> <user@host[:port]> [flags]` asks a person to know the whole
 * shape of the command before typing any of it. When nothing is given and we
 * are in a terminal, the same information is collected one question at a time
 * instead.
 *
 * **The wizard only fills in argv.** It returns tokens that are appended to the
 * command line and parsed by `parseSetupArgs` like any other input, so every
 * validation rule, every default and the entire flow after parsing stay in one
 * place and behave identically whether the user typed the arguments or answered
 * questions. Nothing here writes a file or opens a connection.
 *
 * What it deliberately does **not** touch is everything security-relevant that
 * follows: the password read, the host-key fingerprint confirmation typed as
 * `yes`, and the approval-fallback choice with no preselected value (decision
 * D3). Those keep their own prompts, wording and rules.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import {
  AliasSchema,
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_PORT,
} from '../config/schema.js';
import type { ApprovalMode } from '../config/schema.js';
import type { TcpProbe } from '../ssh/reach.js';
import { promptMenu } from './menu.js';
import type { MenuIo } from './menu.js';
import { PromptAbortedError } from './prompt.js';
import type { Prompter } from './prompt.js';

/**
 * How many times one question may be answered badly before giving up.
 *
 * A closed stream already ends the wizard through `PromptAbortedError`, so this
 * only catches a caller feeding invalid answers forever. It is deliberately far
 * above what a person would hit.
 */
export const MAX_WIZARD_ATTEMPTS = 10;

/** Hints shown next to each approval mode, so the choice is not a guess. */
const APPROVAL_MODE_HINTS: Readonly<Record<ApprovalMode, string>> = {
  auto: '묻지 않고 모두 실행합니다. 신뢰하는 호스트에만',
  'ask-destructive': '파괴적 명령만 확인을 요구합니다. 기본값',
  'ask-all': '모든 명령에 확인을 요구합니다',
  deny: '모든 명령을 거부합니다. 일시적으로 잠글 때',
};

/** How many addresses may fail to answer before the wizard gives up. */
export const MAX_REACH_ATTEMPTS = 3;

/**
 * Characters that must never survive an answer.
 *
 * A cooked-mode read hands back whatever the terminal sent, so an arrow key
 * pressed at a text question arrives as `\x1b[B`. Measured: it was accepted as
 * a hostname, and the escape then moved the cursor so the screen showed
 * `연결 확인 중: :22` — a name that looked empty. The TCP probe refused it, but
 * a question should not pass an answer on to a network call to be rejected.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** One DNS label: alphanumerics, hyphens allowed inside only. */
const LABEL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
/** A DNS name or an IPv4 literal, which this pattern also covers. */
const DNS_NAME = new RegExp(String.raw`^${LABEL}(?:\.${LABEL})*$`, 'u');
/**
 * A bare IPv6 literal; `formatTarget()` adds the brackets later.
 *
 * Character set and length only — not the group structure. A malformed literal
 * is caught twice over: the reachability probe cannot resolve it, and
 * `HostEntrySchema` validates it before anything is written.
 */
const IPV6_LITERAL = /^[0-9A-Fa-f:.]{2,45}$/u;
/** DNS limit; also what `HostEntrySchema` allows. */
const MAX_HOSTNAME_LENGTH = 253;

/** Conservative: a name we are willing to hand to a resolver and store. */
export function isUsableHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) return false;
  if (value.includes(':')) return IPV6_LITERAL.test(value);
  return DNS_NAME.test(value);
}

export interface WizardIo {
  prompter: Prompter;
  /** The arrow-key menu, or null when this terminal cannot draw one. */
  menu: MenuIo | null;
  /** Aliases already in `hosts.json`, so the wizard can refuse a duplicate. */
  takenAliases: ReadonlySet<string>;
  /** Flags already present on the command line; their questions are skipped. */
  given: { approvalMode: boolean; label: boolean };
  /** TCP reachability check; injected so tests need no network. */
  probeTcp: TcpProbe;
}

/** Read one line, with an optional default for a bare Enter. */
async function ask(
  prompter: Prompter,
  question: string,
  defaultValue: string | null
): Promise<string> {
  const suffix = defaultValue === null ? '' : ` [${defaultValue}]`;
  prompter.write(`${question}${suffix}: `);
  const answer = (await prompter.readLine({ muted: false })).toString('utf8').trim();
  return answer === '' && defaultValue !== null ? defaultValue : answer;
}

/**
 * Ask until `validate` accepts the answer.
 * `validate` returns null for "good" or the sentence to show and re-ask.
 */
async function askUntil(
  io: WizardIo,
  question: string,
  defaultValue: string | null,
  validate: (answer: string) => string | null
): Promise<string> {
  for (let attempt = 0; attempt < MAX_WIZARD_ATTEMPTS; attempt += 1) {
    const answer = await ask(io.prompter, question, defaultValue);
    const problem = validate(answer);
    if (problem === null) return answer;
    io.prompter.writeLine(`  ${problem}`);
  }
  throw new PromptAbortedError(
    'no-answer',
    `no valid answer after ${String(MAX_WIZARD_ATTEMPTS)} attempts: ${question}`
  );
}

/**
 * The alias to offer by default: the first label of the hostname.
 *
 * An address is not a name, so an IP literal gets no suggestion — accepting
 * `192` as an alias would be worse than asking.
 */
export function suggestAlias(hostname: string): string | null {
  if (hostname.includes(':')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const first = hostname.split('.')[0] ?? '';
  return AliasSchema.safeParse(first).success ? first : null;
}

/** Join the answers back into the `user@host[:port]` argument. */
export function formatTarget(user: string, hostname: string, port: number): string {
  // An unbracketed IPv6 literal is ambiguous with the port separator, which is
  // exactly what `parseTarget` refuses to guess at.
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `${user}@${host}:${String(port)}`;
}

/**
 * Run the questions and return the argv tokens to append.
 *
 * Throws {@link PromptAbortedError} when the user gives up or the input ends;
 * the caller reports that and writes nothing.
 */
export async function runSetupWizard(io: WizardIo): Promise<string[]> {
  const p = io.prompter;
  p.writeLine('');
  p.writeLine('원격 호스트를 등록합니다. 몇 가지만 물어보겠습니다.');
  p.writeLine('');

  const askHost = (): Promise<string> =>
    askUntil(io, '호스트 주소 (예: web01.example.com)', null, (answer) => {
      if (answer === '') return '호스트 주소는 비워 둘 수 없습니다.';
      // Checked before the shape, because an escape sequence would otherwise
      // scramble the screen while the message explaining it is printed.
      if (CONTROL_CHARS.test(answer) || /\s/u.test(answer)) {
        return '호스트 주소에 쓸 수 없는 문자가 있습니다.';
      }
      if (!isUsableHostname(answer)) {
        return '호스트 이름이나 IP 주소 형식이어야 합니다 (예: web01.example.com, 10.0.0.7).';
      }
      return null;
    });

  const askPort = async (): Promise<number> => {
    const text = await askUntil(io, 'SSH 포트', String(DEFAULT_PORT), (answer) => {
      if (!/^\d+$/u.test(answer)) return '숫자만 입력하세요.';
      const value = Number.parseInt(answer, 10);
      return value >= 1 && value <= 65535 ? null : '1에서 65535 사이여야 합니다.';
    });
    return Number.parseInt(text, 10);
  };

  let hostname = await askHost();

  const user = await askUntil(io, '사용자명', null, (answer) => {
    if (answer === '') return '사용자명은 비워 둘 수 없습니다.';
    if (CONTROL_CHARS.test(answer)) return '사용자명에 쓸 수 없는 문자가 있습니다.';
    // Matches `parseTarget`, which splits on `@` and `:`.
    if (/[\s:]/u.test(answer)) return '사용자명에 공백이나 콜론을 넣을 수 없습니다.';
    return null;
  });

  let port = await askPort();

  // Check the address answers before anything expensive happens. Without this
  // a typo costs the user their password, an ACL pass and a generated key pair
  // before failing. Only the address is re-asked: it is what a failure implies.
  for (let attempt = 1; ; attempt += 1) {
    p.writeLine(`연결 확인 중: ${hostname}:${String(port)} …`);
    const reach = await io.probeTcp(hostname, port);
    if (reach.ok) {
      p.writeLine('연결 확인: OK');
      break;
    }
    p.writeLine(`연결 실패: ${reach.reason}`);
    if (attempt >= MAX_REACH_ATTEMPTS) {
      throw new PromptAbortedError(
        'no-answer',
        `host unreachable after ${String(MAX_REACH_ATTEMPTS)} attempts: ${hostname}:${String(port)}`
      );
    }
    hostname = await askHost();
    port = await askPort();
  }

  const alias = await askUntil(
    io,
    'alias (이 호스트를 부를 이름)',
    suggestAlias(hostname),
    (answer) => {
      if (!AliasSchema.safeParse(answer).success) {
        return '영숫자로 시작하고 영숫자·점·밑줄·하이픈만 쓸 수 있습니다 (최대 64자).';
      }
      // Re-pinning a host key must be asked for explicitly, so the wizard never
      // quietly turns a collision into a --force run.
      if (io.takenAliases.has(answer)) {
        return `"${answer}"는 이미 있습니다. 다시 설정하려면 --force로 실행하세요.`;
      }
      return null;
    }
  );

  const extra: string[] = [];

  if (!io.given.approvalMode) {
    const mode = await askApprovalMode(io);
    extra.push('--approval-mode', mode);
  }

  if (!io.given.label) {
    // The label is printed back by `host list` and `list_hosts`, so an escape
    // sequence in it would rewrite somebody else's terminal later.
    const label = await askUntil(io, '라벨 (설명, 생략하려면 Enter)', '', (answer) =>
      CONTROL_CHARS.test(answer) ? '라벨에 쓸 수 없는 문자가 있습니다.' : null
    );
    if (label !== '') extra.push('--label', label);
  }

  extra.push(alias, formatTarget(user, hostname, port));
  return extra;
}

/**
 * The approval mode has a defined default (`ask-destructive`), which is what
 * makes a preselected menu appropriate here and not for the approval fallback.
 */
async function askApprovalMode(io: WizardIo): Promise<ApprovalMode> {
  const items = APPROVAL_MODES.map((mode) => ({
    value: mode,
    label: mode.padEnd(16),
    hint: APPROVAL_MODE_HINTS[mode],
  }));
  const preselect = APPROVAL_MODES.indexOf(DEFAULT_APPROVAL_MODE);

  if (io.menu !== null) {
    return promptMenu(io.menu, {
      title: '승인 모드를 고르세요.',
      items,
      preselect,
    });
  }

  // No menu: the same question as plain text, same default.
  io.prompter.writeLine('승인 모드:');
  for (const [index, item] of items.entries()) {
    io.prompter.writeLine(`  ${String(index + 1)}) ${item.label} ${item.hint}`);
  }
  const answer = await askUntil(io, '선택', DEFAULT_APPROVAL_MODE, (value) => {
    if ((APPROVAL_MODES as readonly string[]).includes(value)) return null;
    if (/^[1-9]$/u.test(value) && Number.parseInt(value, 10) <= APPROVAL_MODES.length) return null;
    return `${APPROVAL_MODES.join(' / ')} 중 하나, 또는 번호를 입력하세요.`;
  });
  if (/^[1-9]$/u.test(answer)) {
    return APPROVAL_MODES[Number.parseInt(answer, 10) - 1] ?? DEFAULT_APPROVAL_MODE;
  }
  return (APPROVAL_MODES as readonly string[]).includes(answer)
    ? (answer as ApprovalMode)
    : DEFAULT_APPROVAL_MODE;
}
