/**
 * The 15 `ssh-mcp doctor` checks (plan rows 5b.1, 5b.4, 5b.6, §5.11).
 *
 * Each check is an independent `{ id, name, run() }` triple, so the renderer
 * never has to know what a check does and `--json` can serialise the list
 * directly (AC21.8). Six of the 15 kinds are per host: `buildChecks()`
 * instantiates one check per registered alias for those, which is what gives
 * AC21.3, AC21.4 and AC21.11 their per-host rows. With an empty registry each
 * per-host kind still contributes one informational row, so the table always
 * shows all 15 kinds (AC21.1).
 *
 * Two hard rules:
 * - **No remote command is ever run.** Host probing stops at authentication and
 *   closes the connection immediately (AC21.5, row 5b.4).
 * - **An absent `~/.ssh-mcp` is not a failure.** A clean machine must produce
 *   exit code 0, so the layout check creates the directory and only fails when
 *   creation itself fails (AC21.10).
 */
import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'ssh2';

import {
  HOME_DIR_MODE,
  STATE_FILE_MODE,
  auditFilePath,
  auditRotatedFilePath,
  ensureHome,
  homePath,
  keysDirPath,
} from '../config/paths.js';
import { DEFAULT_APPROVAL_FALLBACK } from '../config/schema.js';
import type { HostEntry } from '../config/schema.js';
import { loadState } from '../config/state.js';
import type { State } from '../config/state.js';
import * as store from '../config/store.js';
import { ERROR_CODES } from '../errors.js';
import { PATTERNS } from '../safety/patterns.js';
import { inspectWindowsAcl } from '../setup/winacl.js';
import type { IcaclsRunner } from '../setup/winacl.js';
import { sha256Fingerprint } from '../ssh/fingerprint.js';

/**
 * Lower bound from `engines.node` (AC1.1).
 *
 * Duplicated from `src/index.ts` deliberately: that module calls `main()` at
 * import time, so importing a constant from it would start the CLI.
 */
export const MIN_NODE_MAJOR = 20;

/** Optional ssh2 speed-up; absence is information, never a failure (item 2). */
const NATIVE_BINDINGS_MODULE: string = 'cpu-features';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface CheckOutcome {
  status: CheckStatus;
  detail: string;
}

export interface Check {
  id: string;
  name: string;
  run(): Promise<CheckOutcome>;
}

/** The 15 check kinds of §5.11, in table order. */
export const CHECK_KINDS = [
  'node-version',
  'ssh2-load',
  'home-layout',
  'file-permissions',
  'hosts-schema',
  'audit-log',
  'host-key-file',
  'host-tcp',
  'host-fingerprint',
  'host-auth',
  'host-approval',
  'client-elicitation',
  'host-shell',
  'patterns',
  'snippets',
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** Kinds that produce one row per registered host. */
export const PER_HOST_KINDS: readonly CheckKind[] = [
  'host-key-file',
  'host-tcp',
  'host-fingerprint',
  'host-auth',
  'host-approval',
  'host-shell',
];

/** Handshake budget for a host probe (§5.11 item 8). */
export const HOST_PROBE_TIMEOUT_MS = 5000;

// --------------------------------------------------------------------------
// Registration snippets (§5.11 item 15, row 5b.5, AC21.7)
// --------------------------------------------------------------------------

export const PACKAGE_NAME = '@get-bot/ssh-mcp';

export interface Snippets {
  /** `claude_desktop_config.json` fragment. */
  claudeDesktop: string;
  /** `claude mcp add ...` command line. */
  claudeCode: string;
  /** Windows `cmd /c` variants of both (AC21.7). */
  windows: string;
}

export function buildSnippets(packageName: string = PACKAGE_NAME): Snippets {
  const desktop = {
    mcpServers: {
      'ssh-mcp': { command: 'npx', args: ['-y', packageName] },
    },
  };
  const windowsDesktop = {
    mcpServers: {
      'ssh-mcp': { command: 'cmd', args: ['/c', 'npx', '-y', packageName] },
    },
  };
  return {
    claudeDesktop: JSON.stringify(desktop, null, 2),
    claudeCode: `claude mcp add ssh-mcp -- npx -y ${packageName}`,
    windows: [
      JSON.stringify(windowsDesktop, null, 2),
      `claude mcp add ssh-mcp -- cmd /c npx -y ${packageName}`,
    ].join('\n'),
  };
}

/**
 * Human-readable snippet block. The `cmd /c` variant is appended on Windows,
 * where spawning `npx` without a shell fails with `ENOENT` (plan row 7.5).
 */
export function formatSnippets(packageName: string = PACKAGE_NAME): string {
  const snippets = buildSnippets(packageName);
  const lines = [
    'Claude Desktop (claude_desktop_config.json):',
    snippets.claudeDesktop,
    '',
    'Claude Code:',
    snippets.claudeCode,
  ];
  if (process.platform === 'win32') {
    lines.push(
      '',
      'Windows(cmd /c 변형 — npx를 셸 없이 실행하면 ENOENT가 납니다):',
      snippets.windows,
    );
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Classification patterns (§5.11 item 14, AC21.9)
// --------------------------------------------------------------------------

export interface PatternRow {
  id: string;
  scope: string;
  grade: string;
  source: string;
}

export interface PatternLoadResult {
  ok: boolean;
  rows: PatternRow[];
  /** Why the list is empty, when it is. */
  reason: string;
}

/**
 * Load the classification pattern table for item 14 and `--patterns`.
 *
 * `source` is the pattern string **before** the command-name path prefix is
 * attached at compile time, which is exactly the string a host pastes into
 * `patternOverrides.<grade>.remove`. Printing the compiled form instead would
 * break that round trip (AC21.9).
 */
export function loadPatternRows(): PatternLoadResult {
  const rows: PatternRow[] = PATTERNS.map((pattern) => ({
    id: pattern.id,
    scope: pattern.scope,
    grade: pattern.grade,
    source: pattern.source,
  }));
  return { ok: true, rows, reason: '' };
}

// --------------------------------------------------------------------------
// Host probing (§5.11 items 8-10, row 5b.4)
// --------------------------------------------------------------------------

export interface HostProbeResult {
  /** The TCP connection and SSH banner exchange got through. */
  tcpOk: boolean;
  /** Fingerprint reported by the server, `null` when never seen. */
  observedFingerprint: string | null;
  fingerprintMatches: boolean | null;
  authOk: boolean;
  /** Raw failure text, used in the FAIL detail. */
  error: string | null;
  /** Set when the private key file could not be read. */
  keyUnavailable: boolean;
}

/** Injectable prober so `doctor` tests do not need a live endpoint. */
export type HostProber = (alias: string, entry: HostEntry) => Promise<HostProbeResult>;

function readPrivateKey(entry: HostEntry): Buffer | null {
  try {
    return fs.readFileSync(entry.privateKeyPath);
  } catch {
    return null;
  }
}

/**
 * Connect, verify the host key, authenticate, hang up.
 *
 * No channel is opened and no command is sent, which is what AC21.5 asserts by
 * counting `exec` events on the fixture.
 */
export const defaultHostProber: HostProber = async (_alias, entry) =>
  new Promise<HostProbeResult>((resolve) => {
    const privateKey = readPrivateKey(entry);
    const client = new Client();
    let observed: string | null = null;
    let matches: boolean | null = null;
    let settled = false;

    const finish = (
      result: Omit<HostProbeResult, 'observedFingerprint' | 'keyUnavailable'>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try {
        client.end();
      } catch {
        // The connection is being discarded anyway.
      }
      resolve({
        ...result,
        observedFingerprint: observed,
        keyUnavailable: privateKey === null,
      });
    };

    const guard = setTimeout(() => {
      finish({
        tcpOk: observed !== null,
        fingerprintMatches: matches,
        authOk: false,
        error: `probe did not finish within ${String(HOST_PROBE_TIMEOUT_MS)} ms`,
      });
    }, HOST_PROBE_TIMEOUT_MS + 2000);
    guard.unref?.();

    client.on('ready', () => {
      finish({ tcpOk: true, fingerprintMatches: matches, authOk: true, error: null });
    });
    client.on('error', (err: Error) => {
      finish({
        tcpOk: observed !== null,
        fingerprintMatches: matches,
        authOk: false,
        error: err.message,
      });
    });

    client.connect({
      host: entry.hostname,
      port: entry.port,
      username: entry.user,
      readyTimeout: HOST_PROBE_TIMEOUT_MS,
      tryKeyboard: false,
      // Without a readable key file there is nothing to authenticate with, but
      // the handshake still reveals TCP reachability and the host key.
      authHandler: privateKey === null ? ['none'] : ['publickey'],
      ...(privateKey === null ? {} : { privateKey }),
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        observed = sha256Fingerprint(key);
        matches = observed === entry.hostKey.sha256;
        verify(matches);
      },
    });
  });

// --------------------------------------------------------------------------
// Check construction
// --------------------------------------------------------------------------

export interface DoctorOptions {
  /** Override the `icacls` runner (Windows permission check). */
  icacls?: IcaclsRunner;
  /** Override host probing. */
  prober?: HostProber;
}

interface CheckContext {
  loaded: store.ConfigLoadResult;
  hosts: [string, HostEntry][];
  state: State;
  options: DoctorOptions;
  probes: Map<string, Promise<HostProbeResult>>;
}

function probe(ctx: CheckContext, alias: string, entry: HostEntry): Promise<HostProbeResult> {
  let existing = ctx.probes.get(alias);
  if (existing === undefined) {
    const prober = ctx.options.prober ?? defaultHostProber;
    existing = prober(alias, entry);
    ctx.probes.set(alias, existing);
  }
  return existing;
}

function check(id: string, name: string, run: () => Promise<CheckOutcome>): Check {
  return { id, name, run };
}

function sync(id: string, name: string, run: () => CheckOutcome): Check {
  return { id, name, run: () => Promise.resolve(run()) };
}

function modeOf(target: string): number | null {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return null;
  }
}

function octal(mode: number): string {
  return `0${mode.toString(8)}`;
}

function nodeVersionCheck(): Check {
  return sync('node-version', `Node.js >= ${String(MIN_NODE_MAJOR)}`, () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (!Number.isInteger(major)) {
      return { status: 'FAIL', detail: `버전을 읽을 수 없습니다 (${process.versions.node})` };
    }
    return major >= MIN_NODE_MAJOR
      ? { status: 'PASS', detail: `v${process.versions.node}` }
      : {
          status: 'FAIL',
          detail: `v${process.versions.node} — ${String(MIN_NODE_MAJOR)} 이상이 필요합니다`,
        };
  });
}

function ssh2LoadCheck(): Check {
  return check('ssh2-load', 'ssh2 로드', async () => {
    try {
      const mod = (await import('ssh2')) as { Client?: unknown };
      if (typeof mod.Client !== 'function') {
        return { status: 'FAIL', detail: 'ssh2를 불러왔지만 Client를 찾을 수 없습니다' };
      }
    } catch (err) {
      return {
        status: 'FAIL',
        detail: `ssh2를 불러올 수 없습니다 (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    // The native speed-ups are optional: absence is information, not a problem.
    let native = '네이티브 가속(cpu-features) 없음 — 순수 JS로 동작합니다';
    try {
      await import(NATIVE_BINDINGS_MODULE);
      native = '네이티브 가속(cpu-features) 사용 가능';
    } catch {
      // Expected on a machine without build tools (plan PM-3).
    }
    return { status: 'PASS', detail: `순수 JS ssh2 사용 가능 · ${native}` };
  });
}

function homeLayoutCheck(): Check {
  return sync('home-layout', '~/.ssh-mcp 레이아웃', () => {
    const dir = homePath();
    const existedBefore = fs.existsSync(dir);
    try {
      ensureHome();
    } catch (err) {
      return {
        status: 'FAIL',
        detail: `${dir}를 만들 수 없습니다 (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    const keys = keysDirPath();
    const hasKeys = fs.existsSync(keys);
    const created = existedBefore ? '' : ' (새로 만들었습니다)';
    if (!hasKeys) {
      return {
        status: 'WARN',
        detail: `${dir} 사용 가능${created} · keys/ 없음 — setup을 아직 실행하지 않은 상태입니다`,
      };
    }
    return { status: 'PASS', detail: `${dir} 사용 가능${created} · keys/ 있음` };
  });
}

/**
 * Every private key that exists on disk: the ones the registry points at, plus
 * anything in `keys/` that is not a `.pub`. An empty result means `setup` has
 * not run yet, and there is nothing whose permissions could leak.
 */
function existingPrivateKeys(ctx: CheckContext): string[] {
  const found = new Set<string>();
  for (const [, entry] of ctx.hosts) {
    if (fs.existsSync(entry.privateKeyPath)) found.add(entry.privateKeyPath);
  }
  try {
    for (const name of fs.readdirSync(keysDirPath())) {
      if (name.endsWith('.pub')) continue;
      found.add(path.join(keysDirPath(), name));
    }
  } catch {
    // No keys directory yet.
  }
  return [...found];
}

function permissionsCheck(ctx: CheckContext): Check {
  return sync('file-permissions', '디렉터리·키 파일 권한', () => {
    const dir = homePath();
    if (!fs.existsSync(dir)) {
      return { status: 'PASS', detail: '아직 디렉터리가 없습니다 — 점검할 파일이 없습니다' };
    }
    const keyFiles = existingPrivateKeys(ctx);

    if (process.platform === 'win32') {
      if (keyFiles.length === 0) {
        // A brand-new directory still inherits the profile ACL, and `setup`
        // (not `doctor`) is what tightens it. Reporting that as a failure would
        // make a clean Windows machine exit non-zero, which AC21.10 forbids.
        return {
          status: 'PASS',
          detail: '개인키가 없어 ACL을 점검하지 않았습니다 — setup이 실행되면 하드닝됩니다',
        };
      }
      try {
        const acl =
          ctx.options.icacls === undefined
            ? inspectWindowsAcl(dir)
            : inspectWindowsAcl(dir, ctx.options.icacls);
        return acl.foreign.length === 0
          ? { status: 'PASS', detail: `icacls: ${acl.detail}` }
          : { status: 'FAIL', detail: `icacls: ${acl.detail}` };
      } catch (err) {
        return {
          status: 'FAIL',
          detail: `icacls로 ACL을 읽을 수 없습니다 (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }

    const problems: string[] = [];
    const dirMode = modeOf(dir);
    if (dirMode !== null && dirMode !== HOME_DIR_MODE) {
      problems.push(`${dir} 모드가 ${octal(dirMode)} (기대: ${octal(HOME_DIR_MODE)})`);
    }
    for (const keyFile of keyFiles) {
      const keyMode = modeOf(keyFile);
      if (keyMode === null || keyMode === STATE_FILE_MODE) continue;
      problems.push(`${keyFile} 모드가 ${octal(keyMode)} (기대: ${octal(STATE_FILE_MODE)})`);
    }
    if (problems.length > 0) return { status: 'FAIL', detail: problems.join('; ') };
    return {
      status: 'PASS',
      detail: `디렉터리 ${octal(HOME_DIR_MODE)} · 개인키 ${String(keyFiles.length)}개 ${octal(STATE_FILE_MODE)}`,
    };
  });
}

function hostsSchemaCheck(ctx: CheckContext): Check {
  return sync('hosts-schema', 'hosts.json 스키마', () => {
    const loaded = ctx.loaded;
    if (!loaded.ok) {
      const issues = loaded.issues.map((issue) => `${issue.path}: ${issue.message}`);
      const detail =
        issues.length === 0 ? loaded.message : `${loaded.message} — ${issues.join('; ')}`;
      return { status: 'FAIL', detail };
    }
    if (loaded.missing) {
      return { status: 'PASS', detail: 'hosts.json이 아직 없습니다 — 호스트 0개로 간주합니다' };
    }
    const count = Object.keys(loaded.file.hosts).length;
    const normalized = loaded.normalizedFallbackAliases;
    if (normalized.length > 0) {
      return {
        status: 'WARN',
        detail:
          `호스트 ${String(count)}개 · approvalFallback 누락: ${normalized.join(', ')} ` +
          `— ${DEFAULT_APPROVAL_FALLBACK}로 간주합니다`,
      };
    }
    return { status: 'PASS', detail: `유효 · 호스트 ${String(count)}개` };
  });
}

function auditLogCheck(ctx: CheckContext): Check {
  return sync('audit-log', 'audit.jsonl 쓰기 가능', () => {
    const file = auditFilePath();
    // Hosts that log metadata only: their audit lines carry no command text, so
    // the file is thinner than it looks. Reported as information (§5.10, AC20.10).
    const metadataOnly = ctx.hosts
      .filter(([, entry]) => entry.auditMode === 'metadata-only')
      .map(([alias]) => alias);
    const metadataNote =
      metadataOnly.length === 0
        ? ''
        : ` · auditMode=metadata-only: ${metadataOnly.join(', ')} (명령 문자열을 기록하지 않습니다)`;
    let size: number | null = null;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = null;
    }
    let rotated = 0;
    for (let index = 1; index <= 3; index += 1) {
      if (fs.existsSync(auditRotatedFilePath(index))) rotated += 1;
    }
    try {
      if (size === null) {
        fs.accessSync(path.dirname(file), fs.constants.W_OK);
        return {
          status: metadataOnly.length === 0 ? 'PASS' : 'INFO',
          detail: `아직 감사 파일이 없습니다 — 디렉터리에 쓸 수 있습니다${metadataNote}`,
        };
      }
      fs.accessSync(file, fs.constants.W_OK);
    } catch (err) {
      return {
        status: 'FAIL',
        detail: `감사 로그에 쓸 수 없습니다 (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    return {
      status: metadataOnly.length === 0 ? 'PASS' : 'INFO',
      detail: `${String(size)} 바이트 · 회전 파일 ${String(rotated)}개${metadataNote}`,
    };
  });
}

function emptyHostRow(kind: CheckKind, name: string): Check {
  return sync(kind, name, () => ({
    status: 'INFO',
    detail: '등록된 호스트가 없습니다 — ssh-mcp setup으로 추가하세요',
  }));
}

function hostKeyFileChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-key-file', '호스트: 키 파일')];
  return ctx.hosts.map(([alias, entry]) =>
    sync(`host-key-file:${alias}`, `호스트 ${alias}: 키 파일`, () => {
      if (!fs.existsSync(entry.privateKeyPath)) {
        return { status: 'FAIL', detail: `개인키가 없습니다: ${entry.privateKeyPath}` };
      }
      const mode = modeOf(entry.privateKeyPath);
      const modeText =
        process.platform === 'win32' || mode === null ? '' : ` · 모드 ${octal(mode)}`;
      return { status: 'PASS', detail: `${entry.privateKeyPath}${modeText}` };
    }),
  );
}

function hostTcpChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-tcp', '호스트: TCP 연결')];
  return ctx.hosts.map(([alias, entry]) =>
    check(`host-tcp:${alias}`, `호스트 ${alias}: TCP 연결`, async () => {
      const result = await probe(ctx, alias, entry);
      const target = `${entry.hostname}:${String(entry.port)}`;
      return result.tcpOk
        ? { status: 'PASS', detail: `${target} 연결됨` }
        : {
            status: 'FAIL',
            detail:
              `${ERROR_CODES.connection_failed}: ${target} 연결 실패 ` +
              `(${result.error ?? '원인 불명'})`,
          };
    }),
  );
}

function hostFingerprintChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-fingerprint', '호스트: 호스트 키 지문')];
  return ctx.hosts.map(([alias, entry]) =>
    check(`host-fingerprint:${alias}`, `호스트 ${alias}: 호스트 키 지문`, async () => {
      const result = await probe(ctx, alias, entry);
      if (result.observedFingerprint === null) {
        return {
          status: 'FAIL',
          detail: `${ERROR_CODES.connection_failed}: 호스트 키를 받지 못했습니다`,
        };
      }
      if (result.fingerprintMatches === true) {
        return { status: 'PASS', detail: `${entry.hostKey.sha256} 일치` };
      }
      return {
        status: 'FAIL',
        detail:
          `${ERROR_CODES.host_key_mismatch}: ` +
          `기대 ${entry.hostKey.sha256} · 관측 ${result.observedFingerprint}`,
      };
    }),
  );
}

function hostAuthChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-auth', '호스트: 키 전용 인증')];
  return ctx.hosts.map(([alias, entry]) =>
    check(`host-auth:${alias}`, `호스트 ${alias}: 키 전용 인증`, async () => {
      const result = await probe(ctx, alias, entry);
      if (result.authOk) {
        return { status: 'PASS', detail: '공개키 인증 성공 (원격 명령은 실행하지 않았습니다)' };
      }
      if (result.keyUnavailable) {
        return { status: 'FAIL', detail: `개인키를 읽을 수 없습니다: ${entry.privateKeyPath}` };
      }
      if (result.fingerprintMatches === false) {
        return {
          status: 'FAIL',
          detail: `${ERROR_CODES.host_key_mismatch}: 지문 불일치로 인증을 시도하지 않았습니다`,
        };
      }
      if (!result.tcpOk) {
        return {
          status: 'FAIL',
          detail: `${ERROR_CODES.connection_failed}: 연결하지 못해 인증까지 가지 못했습니다`,
        };
      }
      return {
        status: 'FAIL',
        detail: `${ERROR_CODES.auth_failed}: 인증 실패 (${result.error ?? '원인 불명'})`,
      };
    }),
  );
}

function hostApprovalChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-approval', '호스트: 승인 설정')];
  const normalized = new Set(
    ctx.loaded.ok ? ctx.loaded.normalizedFallbackAliases : ([] as string[]),
  );
  return ctx.hosts.map(([alias, entry]) =>
    sync(`host-approval:${alias}`, `호스트 ${alias}: 승인 설정`, () => {
      const fallback = store.resolveApprovalFallback(entry);
      const warnings: string[] = [];
      if (entry.approvalMode === 'auto') {
        warnings.push('approvalMode: auto — 모든 명령이 확인 없이 실행됩니다');
      }
      if (normalized.has(alias)) {
        warnings.push(`approvalFallback 누락 — ${DEFAULT_APPROVAL_FALLBACK}로 간주합니다`);
      } else if (fallback === 'token') {
        warnings.push(
          'approvalFallback: token — elicitation 미지원 클라이언트에서는 서버가 사람의 승인을 보장하지 못합니다',
        );
      }
      const summary = `mode=${entry.approvalMode} · fallback=${fallback}`;
      return warnings.length === 0
        ? { status: 'PASS', detail: summary }
        : { status: 'WARN', detail: `${summary} · ${warnings.join(' · ')}` };
    }),
  );
}

function clientElicitationCheck(ctx: CheckContext): Check {
  return sync('client-elicitation', '마지막 클라이언트 elicitation 지원', () => {
    const last = ctx.state.lastClient;
    const tokenHosts = ctx.hosts
      .filter(([, entry]) => store.resolveApprovalFallback(entry) === 'token')
      .map(([alias]) => alias);
    const missingHosts = ctx.loaded.ok ? ctx.loaded.normalizedFallbackAliases : [];

    if (last === null) {
      const detail =
        'state.json에 클라이언트 기록이 없습니다 (미기록) — 서버를 한 번 기동하면 채워집니다';
      return missingHosts.length === 0
        ? { status: 'INFO', detail }
        : {
            status: 'WARN',
            detail: `${detail} · approvalFallback 누락: ${missingHosts.join(', ')}`,
          };
    }

    const who = `${last.name} ${last.version} (${last.seenAt})`;
    if (last.elicitation) {
      const detail = `${who} — elicitation 지원`;
      return missingHosts.length === 0
        ? { status: 'PASS', detail }
        : {
            status: 'WARN',
            detail: `${detail} · approvalFallback 누락: ${missingHosts.join(', ')}`,
          };
    }

    const warnings: string[] = [];
    if (tokenHosts.length > 0) {
      warnings.push(`토큰 분기를 타는 호스트: ${tokenHosts.join(', ')}`);
    }
    if (missingHosts.length > 0) {
      warnings.push(`approvalFallback 누락: ${missingHosts.join(', ')}`);
    }
    const detail = `${who} — elicitation 미지원`;
    return warnings.length === 0
      ? { status: 'INFO', detail }
      : { status: 'WARN', detail: `${detail} · ${warnings.join(' · ')}` };
  });
}

/** Shells whose classification coverage is reduced (row 5b.6, AC21.11). */
const WINDOWS_SHELLS = new Set(['cmd', 'powershell', 'pwsh']);

function hostShellChecks(ctx: CheckContext): Check[] {
  if (ctx.hosts.length === 0) return [emptyHostRow('host-shell', '호스트: 원격 셸 커버리지')];
  return ctx.hosts.map(([alias]) =>
    sync(`host-shell:${alias}`, `호스트 ${alias}: 원격 셸 커버리지`, () => {
      const observed = ctx.state.observedShells[alias];
      if (observed === undefined) {
        return {
          status: 'INFO',
          detail: '미확인 — open_session을 한 번도 하지 않았습니다',
        };
      }
      if (WINDOWS_SHELLS.has(observed.shell.toLowerCase())) {
        return {
          status: 'WARN',
          detail:
            `마지막 관측 기준: ${observed.shell}, ${observed.seenAt} — 분류 커버리지 축소`,
        };
      }
      return {
        status: 'PASS',
        detail: `마지막 관측 기준: ${observed.shell}, ${observed.seenAt}`,
      };
    }),
  );
}

function patternsCheck(): Check {
  // Item 14 never fails the run (§5.11): it is an informational listing.
  return sync('patterns', '분류 패턴 목록', () => {
    const result = loadPatternRows();
    const byGrade = new Map<string, number>();
    for (const row of result.rows) {
      byGrade.set(row.grade, (byGrade.get(row.grade) ?? 0) + 1);
    }
    const summary = [...byGrade.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([grade, count]) => `${grade} ${String(count)}`)
      .join(' · ');
    return {
      status: 'PASS',
      detail:
        `패턴 ${String(result.rows.length)}개${summary === '' ? '' : ` (${summary})`} ` +
        '— 전체 목록은 --patterns',
    };
  });
}

function snippetsCheck(): Check {
  return sync('snippets', '호스트 설정 스니펫', () => ({
    status: 'PASS',
    detail:
      process.platform === 'win32'
        ? 'Claude Desktop · Claude Code · Windows(cmd /c) 스니펫을 아래에 출력합니다'
        : 'Claude Desktop · Claude Code 스니펫을 아래에 출력합니다',
  }));
}

/**
 * Build the check list for the current environment.
 *
 * The registry and `state.json` are read once here so that every check sees the
 * same snapshot and a per-host probe is shared by items 8, 9 and 10 (one
 * connection per host, not three).
 */
export function buildChecks(options: DoctorOptions = {}): Check[] {
  const loaded = store.load();
  const hosts: [string, HostEntry][] = loaded.ok
    ? Object.entries(loaded.file.hosts).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const ctx: CheckContext = {
    loaded,
    hosts,
    state: loadState(),
    options,
    probes: new Map(),
  };

  return [
    nodeVersionCheck(),
    ssh2LoadCheck(),
    homeLayoutCheck(),
    permissionsCheck(ctx),
    hostsSchemaCheck(ctx),
    auditLogCheck(ctx),
    ...hostKeyFileChecks(ctx),
    ...hostTcpChecks(ctx),
    ...hostFingerprintChecks(ctx),
    ...hostAuthChecks(ctx),
    ...hostApprovalChecks(ctx),
    clientElicitationCheck(ctx),
    ...hostShellChecks(ctx),
    patternsCheck(),
    snippetsCheck(),
  ];
}

export interface CheckRow {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Run every check in order, turning an unexpected throw into a FAIL row. */
export async function runChecks(checks: readonly Check[]): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const item of checks) {
    try {
      const outcome = await item.run();
      rows.push({ id: item.id, name: item.name, status: outcome.status, detail: outcome.detail });
    } catch (err) {
      rows.push({
        id: item.id,
        name: item.name,
        status: 'FAIL',
        detail: `점검 중 예외가 발생했습니다 (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }
  return rows;
}
