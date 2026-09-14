/**
 * The shape of an MCP-host registration for this package.
 *
 * Two callers need the same answer to "what command starts ssh-mcp?":
 * `doctor`, whose snippet check is plan row 5b.5 / §5.11 item 15 / AC21.7, and
 * `install`, which is not in the plan at all (added 2026-09-14). The shape used
 * to live inline in `doctor/checks.ts`; keeping it here stops the printed
 * advice from drifting away from what `install` actually writes.
 *
 * **Why `cmd /c` on Windows.** `npx` there is really `npx.cmd`, a batch file.
 * A host that spawns the server with `spawn(cmd, args, { shell: false })` —
 * Claude Desktop does — cannot resolve a `.cmd` without a shell and dies with
 * `ENOENT`. `cmd.exe` resolves the extension itself, so the wrapper removes the
 * whole class of failure. Claude Code 2.1.270 connects with a bare `npx` as
 * well (measured 2026-09-14, Windows 11), but the automatic path wraps for
 * **both** clients anyway: one shape is cheaper to support than two, and older
 * Claude Code builds whose `claude` is a `.cmd` shim still need the wrapper.
 *
 * This module imports nothing from `src/`, so it sits beside the other
 * dependency-free config primitives and can be used from any layer.
 */

/** The published npm package name; the only thing `npx` needs. */
export const PACKAGE_NAME = '@get-bot/ssh-mcp';

/**
 * One-line pointer to `ssh-mcp install`, printed under the snippets by both
 * `setup` and `doctor`'s table.
 *
 * It lives here rather than in `install/` so neither CLI has to import the
 * install command to mention it. It is deliberately **not** part of
 * `formatSnippets()`: that function's output is pinned by
 * `tests/integration/doctor.test.ts` and by `--json` consumers.
 */
export const INSTALL_HINT =
  '붙여넣기 대신 `npx @get-bot/ssh-mcp install claude-code` 또는 ' +
  '`install claude-desktop`으로 자동 등록할 수 있습니다.';

/** An argv pair a host can spawn directly. */
export interface ServerCommand {
  command: string;
  args: string[];
}

export interface ServerCommandOptions {
  /** Defaults to the running platform. Injected by tests and by `doctor`, which renders both variants. */
  platform?: NodeJS.Platform;
  packageName?: string;
}

/**
 * The command that starts the stdio server on `platform`.
 * See the module comment for why Windows gets the `cmd /c` wrapper.
 */
export function buildServerCommand(options: ServerCommandOptions = {}): ServerCommand {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const platform = options.platform ?? process.platform;
  const npx = ['npx', '-y', packageName];
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', ...npx] }
    : { command: 'npx', args: npx.slice(1) };
}

/** Render a {@link ServerCommand} as one shell-free line, for logs and dry runs. */
export function formatServerCommand(command: ServerCommand): string {
  return [command.command, ...command.args].join(' ');
}

/** One entry under `mcpServers` in `claude_desktop_config.json`. */
export interface DesktopServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DesktopEntryOptions extends ServerCommandOptions {
  /** `SSH_MCP_HOME` for the spawned server. Omitted from the entry when null. */
  home?: string | null;
}

/**
 * Build the `mcpServers.<name>` value Claude Desktop expects.
 * `env` is left out entirely rather than written as `{}` so the file keeps the
 * shape the documented snippet shows.
 */
export function buildDesktopEntry(options: DesktopEntryOptions = {}): DesktopServerEntry {
  const { command, args } = buildServerCommand(options);
  const home = options.home ?? null;
  return home === null ? { command, args } : { command, args, env: { SSH_MCP_HOME: home } };
}
