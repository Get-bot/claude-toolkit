/**
 * The one table of what `ssh-mcp <command>` can be.
 *
 * `index.ts` routes on it and `help.ts` lists and forwards from it, so a new
 * top-level command is added here and nowhere else. The alternative — a chain
 * of string compares in the router and a hand-kept list of the same names in
 * `help.ts` — needed a comment in each place pointing at the other, and a test
 * to notice when one was forgotten. Here the compiler notices: a name without
 * a loader, or a loader without a name, does not build.
 *
 * Each entry is a thunk around a dynamic import so that starting the server
 * never loads CLI code, which is why the imports used to be written inline in
 * the router. The token tables live here for the same reason the commands do:
 * the router reads them, so each spelling exists in exactly one place. A copy
 * that drifted would send `ssh-mcp --help` into server mode, which is the bug
 * `help` was added to fix.
 *
 * Nothing here runs at import time. `index.ts` and `help.ts` import this module
 * statically, and what they get is string arrays and closures.
 */

/** A sub-command's entry point. The `deps` parameter each one also takes is for tests. */
export type CommandRunner = (argv: string[]) => Promise<number>;

export const COMMANDS = {
  install: async (): Promise<CommandRunner> => (await import('./install/cli.js')).runInstall,
  host: async (): Promise<CommandRunner> => (await import('./host/cli.js')).runHost,
  doctor: async (): Promise<CommandRunner> => (await import('./doctor/cli.js')).runDoctor,
  // `setup` predates the `host` group and keeps working with no warning: an
  // 0.1.0 user upgrades automatically through `npx -y`, so breaking or nagging
  // here would break a working setup for no benefit. See `host/cli.ts`.
  setup: async (): Promise<CommandRunner> => (await import('./setup/cli.js')).runSetup,
} as const;

export type CommandName = keyof typeof COMMANDS;

/** Loaders keyed by command name. Tests substitute fakes for {@link COMMANDS}. */
export type CommandTable = Readonly<Record<CommandName, () => Promise<CommandRunner>>>;

export const COMMAND_NAMES = Object.keys(COMMANDS) as readonly CommandName[];

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/** Spellings that ask for the command overview, or for one command's own usage. */
export const HELP_TOKENS = ['help', '--help', '-h'] as const;

/** Spellings that print the version. */
export const VERSION_TOKENS = ['version', '--version', '-v'] as const;
