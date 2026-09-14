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
  MAX_LABEL_LENGTH,
  MAX_USER_LENGTH,
} from '../config/schema.js';
import type { ApprovalMode } from '../config/schema.js';
import type { GivenFlags } from './cli.js';
import { hasControlChars } from '../internal/util.js';
import type { TcpProbe } from '../ssh/reach.js';
import type { Asker } from './ask.js';
import { PromptAbortedError } from './prompt.js';
import type { Prompter } from './prompt.js';

/** Hints shown next to each approval mode, so the choice is not a guess. */
const APPROVAL_MODE_HINTS: Readonly<Record<ApprovalMode, string>> = {
  auto: '묻지 않고 모두 실행합니다. 신뢰하는 호스트에만',
  'ask-destructive': '파괴적 명령만 확인을 요구합니다. 기본값',
  'ask-all': '모든 명령에 확인을 요구합니다',
  deny: '모든 명령을 거부합니다. 일시적으로 잠글 때',
};

/** How many addresses may fail to answer before the wizard gives up. */
export const MAX_REACH_ATTEMPTS = 3;

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
  /** The interactive questions. Injected so tests answer without a terminal. */
  ask: Asker;
  /** Aliases already in `hosts.json`, so the wizard can refuse a duplicate. */
  takenAliases: ReadonlySet<string>;
  /**
   * Flags already present on the command line.
   *
   * `approvalMode` and `label` skip their question. `force` changes what the
   * alias question accepts: `host add --force` with no positionals opens the
   * wizard, and refusing every existing alias there would demand the very flag
   * the user already typed.
   */
  given: GivenFlags;
  /** TCP reachability check; injected so tests need no network. */
  probeTcp: TcpProbe;
}

/**
 * Ask one text question, re-asking until `validate` accepts.
 *
 * The retry loop belongs to the prompt library, which re-renders the question
 * with the message in place. `validate` keeps this package's wording and
 * returns the sentence to show, so the rules read the same as before.
 */
async function askText(
  io: WizardIo,
  message: string,
  defaultValue: string | null,
  validate: (answer: string) => string | null
): Promise<string> {
  const answer = await io.ask.text({
    message,
    ...(defaultValue === null || defaultValue === '' ? {} : { default: defaultValue }),
    validate: (value: string): true | string => validate(value.trim()) ?? true,
  });
  // Trim here as well as in `validate`: what was checked is what is returned.
  return answer.trim();
}

/**
 * The alias to offer by default: the first label of the hostname.
 *
 * An address is not a name, so an IP literal gets no suggestion — accepting
 * `192` as an alias would be worse than asking.
 *
 * A name already in `hosts.json` is not offered either, unless `--force` makes
 * it acceptable. Pre-filling an answer the next keystroke rejects is the worst
 * shape a default can have: Enter looks like the obvious move and is refused.
 */
export function suggestAlias(
  hostname: string,
  taken: ReadonlySet<string> = new Set(),
  force = false
): string | null {
  if (hostname.includes(':')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const first = hostname.split('.')[0] ?? '';
  if (!AliasSchema.safeParse(first).success) return null;
  if (!force && taken.has(first)) return null;
  return first;
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
    askText(io, '호스트 주소 (예: web01.example.com)', null, (answer) => {
      if (answer === '') return '호스트 주소는 비워 둘 수 없습니다.';
      // Checked before the shape, because an escape sequence would otherwise
      // scramble the screen while the message explaining it is printed.
      if (hasControlChars(answer) || /\s/u.test(answer)) {
        return '호스트 주소에 쓸 수 없는 문자가 있습니다.';
      }
      if (!isUsableHostname(answer)) {
        return '호스트 이름이나 IP 주소 형식이어야 합니다 (예: web01.example.com, 10.0.0.7).';
      }
      return null;
    });

  const askPort = async (): Promise<number> => {
    const text = await askText(io, 'SSH 포트', String(DEFAULT_PORT), (answer) => {
      if (!/^\d+$/u.test(answer)) return '숫자만 입력하세요.';
      const value = Number.parseInt(answer, 10);
      return value >= 1 && value <= 65535 ? null : '1에서 65535 사이여야 합니다.';
    });
    return Number.parseInt(text, 10);
  };

  let hostname = await askHost();

  const user = await askText(io, '사용자명', null, (answer) => {
    if (answer === '') return '사용자명은 비워 둘 수 없습니다.';
    if (hasControlChars(answer)) return '사용자명에 쓸 수 없는 문자가 있습니다.';
    // `HostEntrySchema` enforces this too, but only at `store.save()` — after
    // the password, the key pair and the remote `authorized_keys` install. A
    // failure there leaves our public key on the remote host with no local
    // entry pointing at it, so the ceiling has to be checked here.
    if (answer.length > MAX_USER_LENGTH) {
      return `사용자명은 ${String(MAX_USER_LENGTH)}자를 넘을 수 없습니다.`;
    }
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

  const alias = await askText(
    io,
    'alias (이 호스트를 부를 이름)',
    suggestAlias(hostname, io.takenAliases, io.given.force),
    (answer) => {
      if (!AliasSchema.safeParse(answer).success) {
        return '영숫자로 시작하고 영숫자·점·밑줄·하이픈만 쓸 수 있습니다 (최대 64자).';
      }
      // Re-pinning a host key must be asked for explicitly, so the wizard never
      // quietly turns a collision into a --force run. With --force already on
      // the command line it *was* asked for, and refusing here would demand a
      // flag the user has typed.
      if (!io.given.force && io.takenAliases.has(answer)) {
        return `"${answer}"는 이미 있습니다. 다시 설정하려면 --force로 실행하세요.`;
      }
      return null;
    }
  );

  // Say what --force is about to do, once the alias is known. It is the one
  // answer here that overwrites something the user already has.
  if (io.given.force && io.takenAliases.has(alias)) {
    p.writeLine(`"${alias}"를 다시 설정합니다. 호스트 키 지문을 다시 확인하게 됩니다.`);
  }

  const extra: string[] = [];

  if (!io.given.approvalMode) {
    const mode = await askApprovalMode(io);
    extra.push('--approval-mode', mode);
  }

  if (!io.given.label) {
    // The label is printed back by `host list` and `list_hosts`, so an escape
    // sequence in it would rewrite somebody else's terminal later.
    const label = await askText(io, '라벨 (설명, 생략하려면 Enter)', '', (answer) => {
      if (hasControlChars(answer)) return '라벨에 쓸 수 없는 문자가 있습니다.';
      // `parseSetupArgs` refuses a longer one, and it runs *after* the wizard —
      // so without this the whole finished interview is discarded as a usage
      // error.
      if (answer.length > MAX_LABEL_LENGTH) {
        return `라벨은 ${String(MAX_LABEL_LENGTH)}자를 넘을 수 없습니다.`;
      }
      return null;
    });
    if (label !== '') extra.push('--label', label);
  }

  extra.push(alias, formatTarget(user, hostname, port));
  return extra;
}

/**
 * The approval mode has a defined default (`ask-destructive`), which is what
 * makes a preselected menu appropriate here and not for the approval fallback.
 */
function askApprovalMode(io: WizardIo): Promise<ApprovalMode> {
  return io.ask.select<ApprovalMode>({
    message: '승인 모드를 고르세요.',
    choices: APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: mode,
      description: APPROVAL_MODE_HINTS[mode],
    })),
    default: DEFAULT_APPROVAL_MODE,
  });
}
