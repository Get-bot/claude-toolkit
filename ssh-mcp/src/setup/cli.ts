/**
 * `ssh-mcp setup <alias> <user@host[:port]>` (plan rows 5.1-5.9).
 *
 * The whole command exists so that one password is typed once, in a terminal,
 * by a human - and never again. Two rules are load-bearing:
 *
 * - **All output goes to stderr.** `setup` is not the server, but sharing the
 *   habit keeps stdout free of anything but JSON-RPC frames (Principle 3).
 * - **Nothing is half-written.** Every failure after key generation restores
 *   the previous key pair and leaves `hosts.json` untouched (AC7.5, AC7.7).
 *
 * `setup` cannot run non-interactively. The password prompt refuses a non-TTY
 * stdin, and `--approval-fallback` only skips the approval question, it does
 * not lift that requirement (decisions D4 and D5, AC17.12c/d).
 */
import fs from 'node:fs';

import { Client, utils } from 'ssh2';
import type { AuthenticationType, ConnectConfig } from 'ssh2';

import { homePath, privateKeyPath } from '../config/paths.js';
import {
  APPROVAL_FALLBACKS,
  APPROVAL_MODES,
  AliasSchema,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_PORT,
} from '../config/schema.js';
import type { ApprovalFallback, ApprovalMode, HostEntry } from '../config/schema.js';
import * as store from '../config/store.js';
import { ERROR_CODES } from '../errors.js';
import { formatSnippets } from '../doctor/checks.js';
import { sha256Fingerprint } from '../ssh/fingerprint.js';
import { backupKeyPair, generateKeyPair, restoreKeyPair } from './keygen.js';
import type { GeneratedKeyPair, KeyPairBackup } from './keygen.js';
import { installAuthorizedKey } from './install.js';
import {
  NonInteractiveError,
  PromptAbortedError,
  processPrompter,
  promptChoice,
  promptPassword,
  promptYes,
} from './prompt.js';
import type { Prompter } from './prompt.js';
import { hardenWindowsAcl } from './winacl.js';
import type { IcaclsRunner } from './winacl.js';

/** Success. */
export const EXIT_OK = 0;
/** A step failed: bad registry, remote install, verification, ACL hardening. */
export const EXIT_FAILED = 1;
/** Usage error, or an interactive prompt is impossible (AC17.12c). */
export const EXIT_NOT_INTERACTIVE = 2;

/** Command run over the verification connection (row 5.6). */
export const VERIFY_COMMAND = 'echo ssh-mcp-ok';
const VERIFY_MARKER = 'ssh-mcp-ok';

/** Handshake budget for the non-interactive verification reconnect. */
const VERIFY_READY_TIMEOUT_MS = 20_000;

/**
 * The fixed trade-off text for the forced approval-fallback choice.
 * Copied from the plan's decision D3; the wording is part of the decision, so
 * it must not be paraphrased.
 */
export const APPROVAL_FALLBACK_EXPLANATION = [
  '이 호스트에서 확인이 필요한 명령을 어떻게 처리할지 고르세요.',
  'Claude Desktop은 elicitation(서버가 띄우는 확인 창)을 지원하지 않습니다.',
  '',
  '  token       모델이 확인 요청을 받아 사용자에게 물은 뒤 다시 호출합니다.',
  '              서버는 사람이 실제로 승인했는지 확인할 수 없습니다.',
  '              Claude Desktop에서 exec에 "항상 허용"을 설정하면',
  '              사람 개입 없이 실행될 수 있습니다.',
  '',
  '  fail-closed 확인이 필요한 파괴적·관리자 명령을 이 호스트에서 거부합니다.',
  '              서버가 강제할 수 있는 유일한 방식입니다.',
  '              프로덕션 서버에 권장합니다.',
  '',
  'Claude Code에서는 두 경우 모두 확인 창이 뜹니다.',
].join('\n');

export const APPROVAL_FALLBACK_QUESTION = '선택 [token / fail-closed]: ';

export const USAGE = [
  'Usage: ssh-mcp setup <alias> <user@host[:port]> [options]',
  '',
  'Options:',
  '  --approval-fallback <token|fail-closed>  승인 폴백을 미리 정해 프롬프트를 건너뜁니다.',
  '  --approval-mode <auto|ask-destructive|ask-all|deny>  기본값: ask-destructive',
  '  --label <text>                           호스트 설명 (선택)',
  '  --force                                  기존 alias를 다시 설정합니다 (지문 재확인 필요).',
  '  -h, --help                               이 도움말을 출력합니다.',
  '',
  'setup은 비밀번호를 직접 입력받으므로 항상 터미널(TTY)에서 실행해야 합니다.',
].join('\n');

export interface SetupArgs {
  alias: string;
  user: string;
  hostname: string;
  port: number;
  approvalFallback: ApprovalFallback | null;
  approvalMode: ApprovalMode | null;
  label: string | null;
  force: boolean;
}

export type ParsedArgs =
  | { ok: true; help: false; args: SetupArgs }
  | { ok: true; help: true }
  | { ok: false; message: string };

function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

function isApprovalFallback(value: string): value is ApprovalFallback {
  return (APPROVAL_FALLBACKS as readonly string[]).includes(value);
}

/**
 * Split `user@host[:port]`. Supports a bracketed IPv6 literal
 * (`user@[::1]:2222`) because an unbracketed one is ambiguous with the port.
 */
export function parseTarget(
  target: string,
): { user: string; hostname: string; port: number } | null {
  const at = target.lastIndexOf('@');
  if (at <= 0 || at === target.length - 1) return null;
  const user = target.slice(0, at);
  const rest = target.slice(at + 1);
  if (/[\s:]/.test(user)) return null;

  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end === -1) return null;
    const hostname = rest.slice(1, end);
    const tail = rest.slice(end + 1);
    if (hostname === '') return null;
    if (tail === '') return { user, hostname, port: DEFAULT_PORT };
    if (!tail.startsWith(':')) return null;
    const port = Number.parseInt(tail.slice(1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { user, hostname, port };
  }

  const colon = rest.lastIndexOf(':');
  if (colon === -1) {
    return rest === '' ? null : { user, hostname: rest, port: DEFAULT_PORT };
  }
  const hostname = rest.slice(0, colon);
  const portText = rest.slice(colon + 1);
  if (hostname === '' || !/^\d+$/.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) return null;
  return { user, hostname, port };
}

/** Parse the arguments that follow the `setup` sub-command (row 5.1). */
export function parseSetupArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let approvalFallback: ApprovalFallback | null = null;
  let approvalMode: ApprovalMode | null = null;
  let label: string | null = null;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    switch (token) {
      case '-h':
      case '--help':
        return { ok: true, help: true };
      case '--force':
        force = true;
        break;
      case '--approval-fallback': {
        const value = argv[i + 1];
        i += 1;
        if (value === undefined || !isApprovalFallback(value)) {
          return {
            ok: false,
            message: `--approval-fallback must be one of: ${APPROVAL_FALLBACKS.join(', ')}`,
          };
        }
        approvalFallback = value;
        break;
      }
      case '--approval-mode': {
        const value = argv[i + 1];
        i += 1;
        if (value === undefined || !isApprovalMode(value)) {
          return {
            ok: false,
            message: `--approval-mode must be one of: ${APPROVAL_MODES.join(', ')}`,
          };
        }
        approvalMode = value;
        break;
      }
      case '--label': {
        const value = argv[i + 1];
        i += 1;
        if (value === undefined || value === '') {
          return { ok: false, message: '--label needs a value' };
        }
        if (value.length > 128) {
          return { ok: false, message: '--label must be at most 128 characters' };
        }
        label = value;
        break;
      }
      default:
        if (token.startsWith('-')) {
          return { ok: false, message: `unknown option: ${token}` };
        }
        positional.push(token);
        break;
    }
  }

  if (positional.length < 2) {
    return { ok: false, message: 'setup needs both <alias> and <user@host[:port]>' };
  }
  if (positional.length > 2) {
    return { ok: false, message: `unexpected extra argument: ${positional[2] ?? ''}` };
  }

  const alias = positional[0] ?? '';
  const aliasCheck = AliasSchema.safeParse(alias);
  if (!aliasCheck.success) {
    return {
      ok: false,
      message:
        `invalid alias "${alias}": must start with a letter or digit and contain only ` +
        'letters, digits, dot, underscore or hyphen (max 64 characters)',
    };
  }

  const target = parseTarget(positional[1] ?? '');
  if (target === null) {
    return { ok: false, message: `invalid target "${positional[1] ?? ''}": expected user@host[:port]` };
  }

  return {
    ok: true,
    help: false,
    args: {
      alias,
      user: target.user,
      hostname: target.hostname,
      port: target.port,
      approvalFallback,
      approvalMode,
      label,
      force,
    },
  };
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: Buffer;
  privateKey?: Buffer;
  hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => void;
  authMethods: AuthenticationType[];
  readyTimeoutMs: number;
}

/** Injectable connector so a test can drive the flow without a real network. */
export type Connector = (options: ConnectOptions) => Promise<Client>;

export const defaultConnector: Connector = async (options) =>
  new Promise<Client>((resolve, reject) => {
    const client = new Client();
    const config: ConnectConfig = {
      host: options.host,
      port: options.port,
      username: options.username,
      hostVerifier: options.hostVerifier,
      authHandler: options.authMethods,
      readyTimeout: options.readyTimeoutMs,
      // A generated key never has a passphrase, and `password` is a Buffer we
      // wipe afterwards, so neither needs a prompt fallback.
      tryKeyboard: false,
    };
    if (options.password !== undefined) config.password = options.password.toString('utf8');
    if (options.privateKey !== undefined) config.privateKey = options.privateKey;

    const onReady = (): void => {
      client.removeListener('error', onError);
      resolve(client);
    };
    const onError = (err: Error): void => {
      client.removeListener('ready', onReady);
      client.end();
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
    client.connect(config);
  });

export interface SetupDeps {
  prompter?: Prompter;
  connect?: Connector;
  icacls?: IcaclsRunner;
  now?: () => Date;
}

/** Read the `ssh-<algo>` name out of a raw SSH public key blob. */
export function readKeyAlgo(blob: Buffer): string {
  const parsed = utils.parseKey(blob);
  if (!(parsed instanceof Error)) return parsed.type;
  if (blob.length < 4) return 'unknown';
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || blob.length < 4 + length) return 'unknown';
  return blob.subarray(4, 4 + length).toString('ascii');
}

interface HostKeyObservation {
  fingerprint: string;
  algo: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runRemoteCommand(
  conn: Client,
  command: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
    conn.exec(command, (err, channel) => {
      if (err) reject(err);
      else resolve(channel);
    });
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    stream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    stream.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    stream.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null;
    });
    stream.on('error', reject);
    stream.on('close', () => {
      resolve({ exitCode, stdout, stderr });
    });
    // stdin is never used by the verification command (plan F4).
    stream.end();
  });
}

/**
 * Run the setup flow. Returns the process exit code; never throws for an
 * expected failure.
 */
export async function runSetup(argv: string[], deps: SetupDeps = {}): Promise<number> {
  const prompter = deps.prompter ?? processPrompter();
  const connect = deps.connect ?? defaultConnector;
  const now = deps.now ?? ((): Date => new Date());
  const err = (text: string): void => {
    prompter.write(`${text}\n`);
  };

  const parsed = parseSetupArgs(argv);
  if (parsed.ok && parsed.help) {
    err(USAGE);
    return EXIT_OK;
  }
  if (!parsed.ok) {
    err(`ssh-mcp setup: ${parsed.message}`);
    err('');
    err(USAGE);
    return EXIT_NOT_INTERACTIVE;
  }
  const args = parsed.args;

  // Step 1: the registry must be readable, and an existing alias needs --force.
  const loaded = store.load();
  if (!loaded.ok) {
    err(`ssh-mcp setup: ${loaded.message}`);
    for (const issue of loaded.issues) err(`  - ${issue.path}: ${issue.message}`);
    err('hosts.json을 고친 뒤 다시 실행하세요. setup은 깨진 파일을 덮어쓰지 않습니다.');
    return EXIT_FAILED;
  }
  const existing = loaded.file.hosts[args.alias];
  if (existing !== undefined && !args.force) {
    err(
      `ssh-mcp setup: ${ERROR_CODES.alias_exists}: "${args.alias}"는 이미 등록되어 있습니다 ` +
        `(${existing.user}@${existing.hostname}:${String(existing.port)}).`,
    );
    err('다시 설정하려면 --force를 붙이세요. 호스트 키 지문을 다시 확인하게 됩니다.');
    return EXIT_FAILED;
  }
  if (args.force && !prompter.interactive) {
    err(
      'ssh-mcp setup: --force는 호스트 키 지문을 다시 고정하므로 사람 확인이 필수입니다. ' +
        '터미널에서 실행하세요.',
    );
    return EXIT_NOT_INTERACTIVE;
  }

  // Step 2: the password. This is the reason setup always needs a TTY (D5).
  if (!prompter.interactive) {
    err(
      'ssh-mcp setup: 비밀번호를 입력받아야 하므로 stdin이 터미널이어야 합니다. ' +
        '파이프로 비밀번호를 넘기면 셸 히스토리와 CI 로그에 남기 때문에 지원하지 않습니다.',
    );
    err('키 파일과 hosts.json에 아무것도 쓰지 않고 종료합니다.');
    return EXIT_NOT_INTERACTIVE;
  }

  err(`호스트 "${args.alias}" 설정을 시작합니다: ${args.user}@${args.hostname}:${String(args.port)}`);

  let password: Buffer | null = null;
  try {
    password = await promptPassword(`${args.user}@${args.hostname} 비밀번호: `, prompter);
  } catch (error) {
    if (error instanceof NonInteractiveError) {
      err(`ssh-mcp setup: ${error.message}`);
      return EXIT_NOT_INTERACTIVE;
    }
    err(`ssh-mcp setup: 비밀번호 입력이 중단되었습니다 (${errorMessage(error)}).`);
    return EXIT_FAILED;
  }
  if (password.length === 0) {
    password.fill(0);
    err('ssh-mcp setup: 빈 비밀번호로는 진행할 수 없습니다. 아무것도 기록하지 않고 종료합니다.');
    return EXIT_FAILED;
  }

  // Step 3: generate the key pair. Everything after this point must roll back.
  let backup: KeyPairBackup | null = null;
  let keys: GeneratedKeyPair | null = null;
  let firstConnection: Client | null = null;
  let verifyConnection: Client | null = null;
  let succeeded = false;

  try {
    backup = backupKeyPair(args.alias);
    keys = generateKeyPair(args.alias);
    err(`ed25519 키를 만들었습니다: ${keys.privateKeyPath}`);

    // Step 4: first connection. The fingerprint is confirmed *inside*
    // hostVerifier, so the password is not sent until the user accepts the key.
    // A holder object rather than a plain `let`: the assignment happens inside a
    // callback, and control-flow analysis would otherwise narrow the variable to
    // `null` for the rest of the function.
    const seen: { hostKey: HostKeyObservation | null; refused: boolean; promptError: unknown } = {
      hostKey: null,
      refused: false,
      promptError: null,
    };

    const hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
      const observed: HostKeyObservation = {
        fingerprint: sha256Fingerprint(key),
        algo: readKeyAlgo(key),
      };
      seen.hostKey = observed;
      void (async () => {
        try {
          const accepted = await confirmHostKey(prompter, args, observed, existing);
          if (!accepted) seen.refused = true;
          verify(accepted);
        } catch (error) {
          seen.promptError = error;
          seen.refused = true;
          verify(false);
        }
      })();
    };

    try {
      firstConnection = await connect({
        host: args.hostname,
        port: args.port,
        username: args.user,
        password,
        hostVerifier,
        authMethods: ['password'],
        // A human is answering a question mid-handshake: no deadline.
        readyTimeoutMs: 0,
      });
    } catch (error) {
      if (seen.promptError !== null) {
        err(`ssh-mcp setup: 호스트 키 확인이 중단되었습니다 (${errorMessage(seen.promptError)}).`);
      } else if (seen.refused) {
        err('ssh-mcp setup: 호스트 키를 승인하지 않았습니다. 아무것도 기록하지 않고 종료합니다.');
      } else if (seen.hostKey === null) {
        err(
          `ssh-mcp setup: ${ERROR_CODES.connection_failed}: ` +
            `${args.hostname}:${String(args.port)}에 연결할 수 없습니다 (${errorMessage(error)}).`,
        );
      } else {
        err(`ssh-mcp setup: ${ERROR_CODES.auth_failed}: 비밀번호 인증에 실패했습니다 (${errorMessage(error)}).`);
      }
      return EXIT_FAILED;
    }

    const confirmed = seen.hostKey;
    if (confirmed === null) {
      err('ssh-mcp setup: 호스트 키를 확인할 수 없었습니다. 아무것도 기록하지 않고 종료합니다.');
      return EXIT_FAILED;
    }

    // Step 5: install the public key remotely (§5.7, idempotent).
    const installed = await installAuthorizedKey(firstConnection, keys.publicKeyLine);
    err(
      installed.alreadyPresent
        ? '원격 authorized_keys에 이미 같은 공개키가 있습니다 (변경 없음).'
        : '원격 authorized_keys에 공개키를 추가했습니다.',
    );
    firstConnection.end();
    firstConnection = null;

    // The password has done its job; wipe it before the next network round.
    password.fill(0);
    password = null;

    // Step 6: reconnect with the new key only. No password, no fallback.
    const privateKeyBytes = fs.readFileSync(privateKeyPath(args.alias));
    try {
      verifyConnection = await connect({
        host: args.hostname,
        port: args.port,
        username: args.user,
        privateKey: privateKeyBytes,
        authMethods: ['publickey'],
        readyTimeoutMs: VERIFY_READY_TIMEOUT_MS,
        hostVerifier: (key, verify) => {
          verify(sha256Fingerprint(key) === confirmed.fingerprint);
        },
      });
    } catch (error) {
      err(
        `ssh-mcp setup: 키 전용 재접속 검증에 실패했습니다 (${errorMessage(error)}). ` +
          'hosts.json에 아무것도 기록하지 않고 키 파일을 되돌립니다.',
      );
      return EXIT_FAILED;
    }

    const check = await runRemoteCommand(verifyConnection, VERIFY_COMMAND);
    verifyConnection.end();
    verifyConnection = null;
    if (check.exitCode !== 0 || !check.stdout.includes(VERIFY_MARKER)) {
      err(
        `ssh-mcp setup: 검증 명령이 기대한 결과를 내지 않았습니다 ` +
          `(exit=${check.exitCode === null ? 'null' : String(check.exitCode)}). ` +
          'hosts.json에 아무것도 기록하지 않습니다.',
      );
      return EXIT_FAILED;
    }
    err('키 전용 접속 검증에 성공했습니다.');

    // Step 6b: the forced approval-fallback choice (decision D3).
    let approvalFallback: ApprovalFallback;
    if (args.approvalFallback !== null) {
      approvalFallback = args.approvalFallback;
      err(`승인 폴백: ${approvalFallback} (--approval-fallback으로 지정됨).`);
    } else {
      try {
        prompter.writeLine('');
        prompter.writeLine(APPROVAL_FALLBACK_EXPLANATION);
        const answer = await promptChoice(
          APPROVAL_FALLBACK_QUESTION,
          [...APPROVAL_FALLBACKS],
          prompter,
        );
        approvalFallback = isApprovalFallback(answer) ? answer : 'fail-closed';
      } catch (error) {
        if (error instanceof PromptAbortedError) {
          err('');
          err(
            'ssh-mcp setup: 승인 폴백을 선택하지 않았습니다. 기본값은 없으므로 ' +
              'hosts.json에 아무것도 기록하지 않고 종료합니다.',
          );
        } else {
          err(`ssh-mcp setup: 승인 폴백 선택이 중단되었습니다 (${errorMessage(error)}).`);
        }
        return EXIT_FAILED;
      }
    }

    // Step 7: Windows ACL hardening. A failure here aborts (AC7.7).
    try {
      const acl =
        deps.icacls === undefined
          ? hardenWindowsAcl(homePath())
          : hardenWindowsAcl(homePath(), deps.icacls);
      if (acl.applied) err(`Windows ACL 하드닝 완료: ${acl.detail}`);
    } catch (error) {
      err(
        `ssh-mcp setup: Windows ACL 하드닝에 실패했습니다 (${errorMessage(error)}). ` +
          '암호 없는 개인키를 보호할 수 없으므로 생성한 키를 삭제하고 중단합니다.',
      );
      return EXIT_FAILED;
    }

    // Step 8: persist. This is the first and only write to hosts.json.
    const entry: HostEntry = {
      hostname: args.hostname,
      port: args.port,
      user: args.user,
      privateKeyPath: keys.privateKeyPath,
      hostKey: { algo: confirmed.algo, sha256: confirmed.fingerprint },
      approvalMode: args.approvalMode ?? DEFAULT_APPROVAL_MODE,
      approvalFallback,
      auditMode: 'full',
      patternOverrides: { destructive: { add: [], remove: [] }, privileged: { add: [], remove: [] } },
      defaultTimeoutSec: 60,
      maxOutputBytes: 1048576,
      createdAt: now().toISOString(),
      ...(args.label === null ? {} : { label: args.label }),
    };

    store.save({
      ...loaded.file,
      hosts: { ...loaded.file.hosts, [args.alias]: entry },
    });
    succeeded = true;

    err('');
    err(`hosts.json에 "${args.alias}"를 기록했습니다.`);
    err(`  승인 모드      : ${entry.approvalMode}`);
    err(`  승인 폴백      : ${approvalFallback}`);
    err(`  호스트 키 지문 : ${confirmed.fingerprint} (${confirmed.algo})`);
    if (approvalFallback === 'token') {
      err('');
      err(
        '주의: token을 선택했습니다. elicitation을 지원하지 않는 클라이언트에서는 ' +
          '서버가 사람의 승인을 보장할 수 없습니다. 프로덕션 호스트에는 fail-closed를 권장합니다.',
      );
    }
    err('');
    err(formatSnippets());
    return EXIT_OK;
  } catch (error) {
    err(`ssh-mcp setup: 예기치 않은 오류로 중단합니다 (${errorMessage(error)}).`);
    return EXIT_FAILED;
  } finally {
    if (password !== null) password.fill(0);
    firstConnection?.end();
    verifyConnection?.end();
    if (!succeeded && backup !== null && keys !== null) {
      // Roll back to the pre-run key state: a failed setup must leave neither a
      // new key nor a damaged old one (AC7.5, AC7.7).
      restoreKeyPair(backup);
    }
  }
}

/**
 * Show the fingerprint and require the exact word `yes` (rows 5.4 and 5.1b).
 *
 * With `--force` on an existing alias the old and new fingerprints are printed
 * side by side, and a difference gets an explicit "replaced server or MITM"
 * warning. Re-pinning never happens silently.
 */
async function confirmHostKey(
  prompter: Prompter,
  args: SetupArgs,
  observed: HostKeyObservation,
  existing: HostEntry | undefined,
): Promise<boolean> {
  prompter.writeLine('');
  prompter.writeLine(`${args.hostname}:${String(args.port)}의 호스트 키 지문:`);
  if (existing === undefined) {
    prompter.writeLine(`  새 지문 : ${observed.fingerprint} (${observed.algo})`);
  } else {
    prompter.writeLine(`  기존 지문 : ${existing.hostKey.sha256} (${existing.hostKey.algo})`);
    prompter.writeLine(`  새 지문   : ${observed.fingerprint} (${observed.algo})`);
    if (existing.hostKey.sha256 === observed.fingerprint) {
      prompter.writeLine('  → 지문이 같습니다.');
    } else {
      prompter.writeLine('');
      prompter.writeLine(
        `  ⚠ 지문이 달라졌습니다 (${ERROR_CODES.host_key_mismatch}). 서버가 교체됐거나 ` +
          '중간자 공격일 수 있습니다.',
      );
      prompter.writeLine(
        '  서버를 재설치했다면 정상입니다. 아니라면 지금 중단하고 서버 관리자에게 확인하세요.',
      );
    }
  }
  prompter.writeLine('');
  prompter.writeLine('이 지문을 신뢰하고 고정할까요? 계속하려면 yes를 입력하세요.');
  return promptYes('신뢰 [yes / 그 외 모두 중단]: ', prompter);
}
