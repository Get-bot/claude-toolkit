/**
 * Remote shell detection and the session preamble (plan row 3.4b, §5.9,
 * AC14.3-AC14.6).
 *
 * Stage 1 asks the shell what it is (`echo __SM_SH__$0__`) and classifies the
 * answer. Stage 2 runs a capability probe on POSIX-family shells. Stage 3 does
 * not exist: bash, zsh, sh/dash and busybox ash all take the same command
 * frame, so there is no dialect branch.
 *
 * The preamble is `set +e; set +u` and nothing else. `set` is a POSIX *special
 * builtin*, and an argument error in a special builtin terminates a
 * non-interactive shell — so `set +o pipefail`, which dash and busybox ash
 * reject as an illegal option, would kill the session outright. Neither
 * `2>/dev/null` (only discards the message) nor `|| true` (only absorbs the
 * status) prevents that exit. Nothing is lost by dropping it: the frame reads
 * `$?` straight after `eval`, so a user's own `pipefail` setting is simply
 * respected (N4/N5, AC14.4).
 */

/** Sent once on a fresh channel. Must never contain `pipefail` (AC14.4). */
export const SHELL_PREAMBLE = 'set +e; set +u';

/** Stage 1 probe (§5.9). */
export const SHELL_PROBE_COMMAND = 'echo __SM_SH__$0__';

/** POSIX-family shells that take our command frame unchanged. */
export type PosixShell = 'bash' | 'zsh' | 'dash' | 'ash';
/** Shells we refuse sessions on, plus "we could not tell". */
export type UnsupportedShell = 'fish' | 'cmd' | 'powershell' | 'unknown';
export type DetectedShell = PosixShell | UnsupportedShell;

/**
 * How much of the classifier still applies.
 *
 * - `reduced`: the safety patterns are POSIX-oriented, so Windows-native
 *   destructive commands (`del /s /q`, `Remove-Item -Recurse -Force`) grade as
 *   `safe`. Attached to `cmd` and `powershell` only (R23).
 * - `none`: no reduction — the POSIX patterns apply as written.
 */
export type ClassificationCoverage = 'reduced' | 'none';

export interface SupportedShellVerdict {
  supported: true;
  shell: PosixShell;
}

export interface UnsupportedShellVerdict {
  supported: false;
  shell: UnsupportedShell;
  message: string;
  alternatives: string[];
  classification_coverage: ClassificationCoverage;
}

export type ShellVerdict = SupportedShellVerdict | UnsupportedShellVerdict;

const POSIX_SHELLS: Record<string, PosixShell> = {
  bash: 'bash',
  zsh: 'zsh',
  sh: 'dash',
  dash: 'dash',
  ash: 'ash',
  busybox: 'ash',
};

/** Advice returned with `unsupported_shell` (§5.9). */
export const SHELL_ALTERNATIVES: readonly string[] = [
  'exec 도구로 단발 명령을 실행하세요. exec은 모든 셸에서 동작합니다.',
  "작업 디렉터리 유지가 필요하면 명령을 'cd /path && <명령>' 형태로 합치세요.",
  '원격 사용자의 로그인 셸을 bash로 바꾸면 세션을 쓸 수 있습니다 (chsh -s /bin/bash).',
];

function unsupported(shell: UnsupportedShell): UnsupportedShellVerdict {
  const coverage: ClassificationCoverage =
    shell === 'cmd' || shell === 'powershell' ? 'reduced' : 'none';
  return {
    supported: false,
    shell,
    message:
      `이 호스트의 로그인 셸이 ${shell}로 감지되었습니다. ` +
      '상태 유지 세션은 POSIX 계열 셸(bash, zsh, sh/dash, busybox ash)에서만 지원됩니다.',
    alternatives: [...SHELL_ALTERNATIVES],
    classification_coverage: coverage,
  };
}

/** `-bash` / `/bin/bash.exe` -> `bash` (§5.9: strip login dash, dir, suffix). */
export function shellBasename(token: string): string {
  let name = token.trim();
  if (name.startsWith('-')) name = name.slice(1);
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash !== -1) name = name.slice(slash + 1);
  if (name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4);
  return name.toLowerCase();
}

export interface ShellProbeOutput {
  stdout: string;
  stderr: string;
}

const PROBE_TOKEN_PATTERN = /__SM_SH__(.*?)__/;
/** fish rejects `$0`; its diagnostics are recognisable without the token. */
const FISH_ERROR_PATTERN = /fish:|Variables cannot be bracketed|\$0: Invalid variable name/i;

/**
 * Classify the stage 1 probe output (§5.9 table).
 *
 * Pure on purpose: the table is table-tested directly, without a server.
 */
export function classifyShellProbe(output: ShellProbeOutput): ShellVerdict {
  const combined = `${output.stdout}\n${output.stderr}`;

  // cmd.exe does not expand `$0`, so the literal comes back untouched.
  if (output.stdout.includes('__SM_SH__$0__')) return unsupported('cmd');

  if (FISH_ERROR_PATTERN.test(combined)) return unsupported('fish');

  const match = PROBE_TOKEN_PATTERN.exec(output.stdout);
  if (match === null) {
    // PowerShell parses `$0__` as an undefined variable, leaving the prefix
    // alone and the closing underscores consumed.
    if (/__SM_SH__\s*$/m.test(output.stdout)) return unsupported('powershell');
    return unsupported('unknown');
  }

  const token = match[1] ?? '';
  // An empty expansion is PowerShell: `$0` is undefined there.
  if (token.trim() === '') return unsupported('powershell');

  const name = shellBasename(token);
  if (name === 'fish') return unsupported('fish');

  const posix = POSIX_SHELLS[name];
  if (posix !== undefined) return { supported: true, shell: posix };

  return unsupported('unknown');
}

/** Base64 decode flag accepted by the remote `base64`. */
export type Base64Flag = '-d' | '-D';

export interface CapabilityProbeResult {
  /** Value of `$-`, recorded for diagnostics (§5.9). */
  flags: string | null;
  /** Shell pid; used to reap children on timeout. */
  pid: number | null;
  /** `$BASH_VERSION` or `$ZSH_VERSION` when the shell sets one. */
  version: string | null;
  /** Whether `/dev/null` is readable, i.e. whether the stdin guard works. */
  devNull: boolean;
  /** Which decode flag worked, or `null` when `base64` is unusable. */
  base64Flag: Base64Flag | null;
}

/**
 * Stage 2 probe, wrapped in one completion frame so a single marker round trip
 * confirms the whole handshake (§5.9).
 *
 * Written with string concatenation rather than a template literal so that
 * `$-`, `$$` and `${BASH_VERSION}` reach the remote shell verbatim.
 */
export function buildCapabilityProbe(marker: string): string {
  return [
    'echo __SM_FLAGS__$-__',
    'echo __SM_PID__$$__',
    'echo __SM_VER__${BASH_VERSION}${ZSH_VERSION}__',
    'if [ -r /dev/null ]; then echo __SM_DEVNULL__ok__; else echo __SM_DEVNULL__no__; fi',
    '__SM_T=$(printf %s aGk= | base64 -d 2>/dev/null)',
    'if [ "$__SM_T" = hi ]; then echo __SM_B64__d__; ' +
      'else __SM_T=$(printf %s aGk= | base64 -D 2>/dev/null); ' +
      'if [ "$__SM_T" = hi ]; then echo __SM_B64__D__; else echo __SM_B64__none__; fi; fi',
    'unset __SM_T',
    "printf '\\n%s%s\\n' '" + marker + "' 0",
    "printf '\\n%s\\n' '" + marker + "' 1>&2",
  ].join('; ');
}

function firstGroup(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  return match[1] ?? null;
}

/** Parse the stage 2 probe output. Missing fields come back as `null`/`false`. */
export function parseCapabilityProbe(stdout: string): CapabilityProbeResult {
  const flags = firstGroup(/__SM_FLAGS__(.*?)__/, stdout);
  const pidText = firstGroup(/__SM_PID__(\d+)__/, stdout);
  const version = firstGroup(/__SM_VER__(.*?)__/, stdout);
  const b64 = firstGroup(/__SM_B64__(d|D|none)__/, stdout);

  return {
    flags: flags === null || flags === '' ? null : flags,
    pid: pidText === null ? null : Number.parseInt(pidText, 10),
    version: version === null || version === '' ? null : version,
    devNull: /__SM_DEVNULL__ok__/.test(stdout),
    base64Flag: b64 === 'd' ? '-d' : b64 === 'D' ? '-D' : null,
  };
}

/** Build the refusal payload for a detected non-POSIX shell (AC14.5, AC14.6). */
export function unsupportedShellVerdict(shell: UnsupportedShell): UnsupportedShellVerdict {
  return unsupported(shell);
}
