/**
 * `ssh-mcp install claude-desktop` — registration by editing
 * `claude_desktop_config.json`.
 *
 * Claude Desktop has no CLI, so this is the one path where we write a file the
 * user also owns and that other MCP servers live in. That makes one rule
 * absolute: **never destroy a configuration we do not fully understand.** If
 * the file does not parse, or `mcpServers` is not an object, nothing is
 * written and the path and reason are reported instead. Losing somebody's
 * other server entries is a far worse outcome than refusing to install.
 *
 * The rest follows from the same caution:
 *
 * - Every other key and every other server entry is carried over untouched.
 * - The previous file is copied to `<name>.bak-<YYYYMMDD-HHmmss>` beside it
 *   before anything is replaced.
 * - The replacement is written to a temporary file and `renameSync`d into
 *   place, the same atomic swap `config/store.ts` uses, so a crash mid-write
 *   cannot leave a truncated config behind.
 * - An existing entry under the same name is never overwritten without
 *   `--force`.
 *
 * Re-serialisation with two-space indent is the one cosmetic change we accept
 * (the alternative is a JSON-preserving editor, which is a dependency and a
 * parser of its own); the command says so in its output.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14. Rationale:
 * remove the friction of a user having to know about `cmd /c` wrapping on
 * Windows in order to register this server at all.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildDesktopEntry } from '../config/registration.js';
import { errorMessage, isEnoent, isErrnoCode } from '../internal/util.js';

export const DESKTOP_CONFIG_FILE_NAME = 'claude_desktop_config.json';

export interface DesktopInstallOptions {
  name: string;
  /** `SSH_MCP_HOME` for the server entry, or null. */
  home: string | null;
  /** `--config` override; null means the platform's standard location. */
  configPath: string | null;
  force: boolean;
  dryRun: boolean;
  platform: NodeJS.Platform;
  packageName: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  now: () => Date;
  write: (text: string) => void;
}

/**
 * Where Claude Desktop keeps its config on each platform.
 *
 * `APPDATA` is normally set on Windows; the `AppData/Roaming` fallback covers
 * a stripped environment (a service account, a scrubbed shell) rather than a
 * relocated profile, which is why it is built from the home directory.
 */
export function desktopConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: () => string
): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      appData !== undefined && appData.trim() !== ''
        ? appData
        : path.join(homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Claude', DESKTOP_CONFIG_FILE_NAME);
  }
  if (platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      DESKTOP_CONFIG_FILE_NAME
    );
  }
  return path.join(homedir(), '.config', 'Claude', DESKTOP_CONFIG_FILE_NAME);
}

/** Local time, because the user reads this name in their own file listing. */
export function backupPath(target: string, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${target}.bak-${stamp}`;
}

/** How many `-N` suffixes to try before giving up on a free backup name. */
const MAX_BACKUP_SUFFIX = 1000;

/**
 * Write the backup, never over an existing one.
 *
 * The timestamp only has second resolution, so two runs in the same second
 * would otherwise make the second backup overwrite the first — losing exactly
 * the file the user would want back. `wx` makes the check and the write one
 * operation, so a concurrent run cannot slip between them either.
 */
function writeBackup(target: string, now: Date, body: string): string {
  const base = backupPath(target, now);
  for (let suffix = 0; suffix < MAX_BACKUP_SUFFIX; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${String(suffix)}`;
    try {
      fs.writeFileSync(candidate, body, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err;
    }
  }
  throw new Error(`빈 백업 파일 이름을 찾지 못했습니다: ${base}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(options: DesktopInstallOptions, target: string, reason: string): false {
  options.write(`ssh-mcp install: ${target}`);
  options.write(`  ${reason}`);
  options.write('아무것도 쓰지 않았습니다. 다른 서버 설정을 잃지 않도록 파일을 먼저 고치세요.');
  return false;
}

/** Returns true on success. The caller maps that onto the process exit code. */
export function installClaudeDesktop(options: DesktopInstallOptions): boolean {
  const target =
    options.configPath ?? desktopConfigPath(options.platform, options.env, options.homedir);

  let raw: string | null = null;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) {
      return refuse(options, target, `읽을 수 없습니다: ${errorMessage(err)}`);
    }
  }

  let root: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return refuse(options, target, `JSON 파싱에 실패했습니다: ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) {
      return refuse(options, target, '최상위 값이 JSON 객체가 아닙니다.');
    }
    root = parsed;
  }

  const rawServers = root['mcpServers'];
  let servers: Record<string, unknown> = {};
  if (rawServers !== undefined) {
    if (!isPlainObject(rawServers)) {
      return refuse(options, target, 'mcpServers가 JSON 객체가 아닙니다.');
    }
    servers = rawServers;
  }

  // `hasOwn`, not `!== undefined`: `--name constructor` or `--name toString`
  // would otherwise look like a collision with a prototype member.
  const replacing = Object.hasOwn(servers, options.name);
  if (replacing && !options.force) {
    options.write(`ssh-mcp install: ${target}에 이미 "${options.name}" 항목이 있습니다.`);
    options.write('교체하려면 --force를 붙이세요. 아무것도 쓰지 않았습니다.');
    return false;
  }

  const entry = buildDesktopEntry({
    platform: options.platform,
    packageName: options.packageName,
    home: options.home,
  });

  if (options.dryRun) {
    options.write(`[dry-run] 대상 파일: ${target}`);
    options.write(`[dry-run] ${replacing ? '교체' : '추가'}될 항목 "${options.name}":`);
    options.write(JSON.stringify(entry, null, 2));
    return true;
  }

  // Spreading `root` first keeps every unrelated key, and keeps `mcpServers` in
  // its original position when the key already existed.
  const next = { ...root, mcpServers: { ...servers, [options.name]: entry } };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  // A fixed `.tmp` name would let two concurrent runs write the same scratch
  // file and rename each other's half-written content into place.
  const tmp = `${target}.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let backup: string | null = null;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (raw !== null) {
      backup = writeBackup(target, options.now(), raw);
    }
    fs.writeFileSync(tmp, body, 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  } catch (err) {
    options.write(`ssh-mcp install: ${target}에 쓰지 못했습니다: ${errorMessage(err)}`);
    if (backup !== null) options.write(`이전 내용은 ${backup}에 남아 있습니다.`);
    return false;
  }

  options.write(`Claude Desktop 설정을 ${replacing ? '교체' : '수정'}했습니다: ${target}`);
  if (backup !== null) options.write(`백업: ${backup}`);
  if (options.home !== null) options.write(`SSH_MCP_HOME=${options.home}`);
  options.write(
    '파일 전체를 2칸 들여쓰기로 다시 직렬화했습니다. 다른 서버 항목과 키는 그대로 보존됩니다.'
  );
  options.write(
    'Claude Desktop을 완전히 종료했다가 다시 시작해야 반영됩니다. 도구 목록에 정확히 7개가 보여야 합니다.'
  );
  return true;
}
