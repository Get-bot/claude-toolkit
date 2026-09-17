/**
 * Finding the system `ssh` and handing it the terminal (plan F6, OP-5, ADR-014).
 *
 * This package's stated value is that it needs no OpenSSH: every MCP tool goes
 * through pure-JS `ssh2`. `connect` and `exec` are the one deliberate exception
 * (D6, 부록 B-1) — a person asking for an interactive shell wants *their* ssh,
 * with their `known_hosts`, their agent config and their terminal, not a
 * reimplementation of it. The exception is fenced in by four guards, and this
 * file is where two of them live:
 *
 * - **G-1.** Every line that looks for or spawns `ssh` is in `src/connect/`.
 *   `src/server.ts`, `src/tools/` and `src/ssh/` may not import it, and
 *   `eslint.config.js` refuses the import rather than trusting a convention.
 *   That is what keeps "the server does not depend on `ssh`" true.
 * - **G-3.** `node:child_process`, `node:fs` and `node:path` are reached
 *   through the module object, never through a named import. The bundle is one
 *   ESM file whose top-level imports are linked before any statement runs, so a
 *   named import of something a given Node lacks kills `--version`, `doctor`
 *   and server mode alike — that is the `util.styleText` incident of
 *   2026-09-14. `scripts/assert-bundle-imports.mjs` allows exactly `spawnSync`
 *   from `child_process` and has no `fs` key at all, so these three spellings
 *   are load-bearing, not style.
 *
 * Looking `ssh` up before spawning it (rather than spawning and reading ENOENT)
 * is ADR-014: ENOENT can also mean the *working directory* vanished, and AC-C3
 * asks for a judgement, not a guess. The lookup is a pure function of `PATH`,
 * `PATHEXT` and the platform, so it is testable without a machine that happens
 * to lack OpenSSH.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { HostEntry } from '../config/schema.js';

/** What we are looking for on `PATH`, before any Windows extension. */
export const SSH_BINARY_NAME = 'ssh';

/**
 * Extensions tried on Windows when `PATHEXT` is unset or empty.
 *
 * The real value almost always contains more (`.VBS`, `.JS`, …), but only
 * these two can plausibly be an `ssh`, and a shorter list means fewer
 * `statSync` calls per `PATH` entry.
 */
const DEFAULT_PATHEXT = '.COM;.EXE';

/**
 * Extensions we refuse even when `PATHEXT` offers them, because we could not
 * run what we found.
 *
 * Node has thrown `EINVAL` for a `.bat`/`.cmd` target with `shell: false` since
 * 20.12 (the fix for CVE-2024-27980), and `shell: true` is not an option here —
 * it would let a shell re-read the words after `--` and undo AC-C2. So a
 * `ssh.cmd` shim on `PATH` is not something we can delegate to, and *reporting*
 * it as found would be the worse outcome: the user would get an opaque EINVAL
 * instead of the install hint AC-C3 promises. Skipping it means `resolveSshBinary`
 * keeps looking, and says "not on PATH" if a real executable never turns up.
 */
const UNSPAWNABLE_EXTENSIONS = ['.BAT', '.CMD'];

export interface ResolveSshDeps {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a `statSync` + `access(X_OK)` probe. Injected by tests. */
  isExecutableFile?: (candidate: string) => boolean;
}

/**
 * Is this path a file we could actually execute?
 *
 * POSIX needs the execute bit checked: a `PATH` entry containing a *directory*
 * named `ssh`, or a non-executable leftover, must not win over the real one
 * further down. Windows has no execute bit — the extension is the permission —
 * so being a file is the whole test there.
 */
function probeExecutable(candidate: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (windows) return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `PATH` under whichever spelling this environment used. */
function readPath(env: NodeJS.ProcessEnv): string {
  // Windows environment variables are case-insensitive and `process.env`
  // reflects that, but an object handed in by a test does not, so all three
  // spellings are checked here rather than relied on from the platform.
  return env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
}

/**
 * The absolute path of the `ssh` executable, or `null` if `PATH` has none.
 *
 * Deliberately not memoised: `doctor` and the two commands each call it once,
 * and a cached "no ssh" answer would outlive the install that fixed it.
 */
export function resolveSshBinary(deps: ResolveSshDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const windows = platform === 'win32';
  const isExecutable =
    deps.isExecutableFile ?? ((candidate: string): boolean => probeExecutable(candidate, windows));

  // `path.win32`/`path.posix` rather than the ambient `path`, so a test can ask
  // what this function would do on the *other* operating system.
  const pathApi = windows ? path.win32 : path.posix;
  const delimiter = windows ? ';' : ':';

  const pathext = (env['PATHEXT'] ?? env['Pathext'] ?? env['pathext'] ?? '').trim();
  const extensions = windows
    ? (pathext === '' ? DEFAULT_PATHEXT : pathext)
        .split(';')
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 0 && !UNSPAWNABLE_EXTENSIONS.includes(ext.toUpperCase()))
    : [''];

  for (const raw of readPath(env).split(delimiter)) {
    // An empty `PATH` entry means "the current directory" to some shells. We do
    // not honour that: resolving `ssh` out of the directory the user happens to
    // stand in is how a repository checkout gets to impersonate OpenSSH.
    const dir = raw.trim().replace(/^"|"$/gu, '');
    if (dir === '') continue;
    for (const ext of extensions) {
      const candidate = pathApi.join(dir, `${SSH_BINARY_NAME}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * What to tell someone whose machine has no `ssh`, per platform (AC-C3).
 *
 * Every line ends by saying the MCP tools are unaffected, because the natural
 * reading of "ssh not found" from a program called ssh-mcp is "nothing works",
 * and that is wrong: only these two commands need it.
 */
export function sshMissingMessage(platform: NodeJS.Platform = process.platform): string {
  const install =
    platform === 'win32'
      ? '설정 > 시스템 > 선택적 기능에서 "OpenSSH 클라이언트"를 추가하거나 ' +
        '`winget install Microsoft.OpenSSH.Beta`를 실행하세요.'
      : platform === 'darwin'
        ? 'macOS에는 기본 포함돼 있습니다. `xcode-select --install` 또는 `brew install openssh`로 복구하세요.'
        : '`sudo apt install openssh-client`(Debian·Ubuntu) 또는 ' +
          '`sudo dnf install openssh-clients`(Fedora·RHEL)로 설치하세요.';
  return [
    'ssh 실행 파일을 PATH에서 찾지 못했습니다.',
    install,
    'connect·exec만 시스템 ssh를 사용합니다. MCP 서버와 도구는 영향을 받지 않습니다.',
  ].join('\n');
}

/**
 * The fixed part of the argv, identical for `connect` and `exec` (AC-C1).
 *
 * `IdentitiesOnly=yes` is not decoration: without it OpenSSH offers every key
 * an agent holds before the one we registered, and a server with
 * `MaxAuthTries 3` can refuse us before our key is ever tried. `-i` alone does
 * not prevent that.
 */
export function buildSshArgs(entry: HostEntry): string[] {
  return [
    '-i',
    entry.privateKeyPath,
    '-p',
    String(entry.port),
    '-o',
    'IdentitiesOnly=yes',
    `${entry.user}@${entry.hostname}`,
  ];
}

/** Runs `ssh` and resolves with the exit code the process should use. */
export type SshSpawner = (binary: string, args: readonly string[]) => Promise<number>;

/**
 * Spawn `ssh` with our terminal, and report what it reported.
 *
 * `stdio: 'inherit'` is the point of the whole feature — the child gets the
 * real tty, so password prompts, `less`, colours and window resizing behave
 * exactly as they do when the user types `ssh` themselves.
 *
 * `shell: false` is a security property, not a preference. With a shell in the
 * way, the words after `--` would be re-parsed by `cmd.exe` or `/bin/sh` and a
 * command containing `&`, `|` or `%VAR%` would mean something different from
 * what was typed (AC-C2), which is also an injection surface. Passing an argv
 * array lets Node quote each element and lets OpenSSH receive them intact.
 *
 * A child killed by a signal has a `null` exit code; the process reports 1,
 * since "it died" is not success and there is no code to pass through.
 */
export function spawnSsh(binary: string, args: readonly string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = childProcess.spawn(binary, [...args], { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve(code ?? 1);
    });
  });
}
