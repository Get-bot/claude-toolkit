/**
 * Best-effort detection of the two clients, for the `install` menu hints.
 *
 * The point is to tell the user which option is likely to work, not to gate
 * anything: detection failure only changes a hint, never the choice. Someone
 * installing Claude Desktop right after running this command must still be able
 * to pick it.
 *
 * **No process is started.** Running `claude --version` to find out whether it
 * exists would spawn an unknown binary from `PATH` just to draw a menu, and it
 * would cost a process launch on every run. Looking for the executable on
 * `PATH` (honouring `PATHEXT` on Windows, where `claude` is `claude.cmd` or
 * `claude.exe`) answers the same question by reading directory entries.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14 with the
 * rest of `install/`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { desktopConfigPath } from './desktop.js';

/** Default extensions when Windows gives us no `PATHEXT`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface Detection {
  found: boolean;
  /** Where it was found, for the hint. Empty when it was not. */
  where: string;
}

export interface DetectOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}

/** Candidate file names for `claude` on this platform. */
function claudeFileNames(options: DetectOptions): string[] {
  if (options.platform !== 'win32') return ['claude'];
  const pathext = options.env['PATHEXT'] ?? DEFAULT_PATHEXT;
  const extensions = pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');
  // The bare name stays in the list: a shell script without an extension is
  // still executable when a user put one there deliberately.
  return ['claude', ...extensions.map((ext) => `claude${ext.toLowerCase()}`)];
}

/** Is the Claude Code CLI on `PATH`? */
export function detectClaudeCode(options: DetectOptions): Detection {
  const rawPath = options.env['PATH'] ?? options.env['Path'] ?? '';
  const separator = options.platform === 'win32' ? ';' : ':';
  const names = claudeFileNames(options);

  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/gu, '');
    if (trimmed === '') continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      try {
        if (fs.statSync(candidate).isFile()) return { found: true, where: candidate };
      } catch {
        // Unreadable or missing entry: just keep looking.
      }
    }
  }
  return { found: false, where: '' };
}

/**
 * Are we a Linux process inside WSL?
 *
 * It changes what "not found" means for Claude Desktop: the app is a Windows
 * one, so its configuration is simply not on this side of the boundary, and
 * saying "not installed" would be wrong. A failed read is not an error — the
 * answer is only used to word a hint.
 */
export function isWsl(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/** Why Claude Desktop was not found, in words the user can act on. */
export const WSL_DESKTOP_HINT =
  '감지되지 않음(WSL에서는 Windows의 Claude Desktop 설정에 접근하지 않습니다)';

/**
 * Is Claude Desktop installed?
 *
 * The **directory** is the signal, not the config file: a fresh install has the
 * folder but no `claude_desktop_config.json` until something writes one, and
 * that is precisely the case this command exists to handle.
 *
 * Inside WSL the answer is always "not here", and the hint says so rather than
 * implying the app is missing. Choosing it anyway stays possible: `--config`
 * can point at a `/mnt/c/...` path.
 */
export function detectClaudeDesktop(options: DetectOptions): Detection {
  const dir = path.dirname(desktopConfigPath(options.platform, options.env, options.homedir));
  try {
    if (fs.statSync(dir).isDirectory()) return { found: true, where: dir };
  } catch {
    // Missing or unreadable: report it as not found.
  }
  return isWsl(options.platform)
    ? { found: false, where: WSL_DESKTOP_HINT }
    : { found: false, where: '' };
}

/** Injection point so tests describe a machine instead of relying on this one. */
export type ClientDetector = (options: DetectOptions) => Detection;
