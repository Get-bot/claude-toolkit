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

/**
 * The one line `setup` prints before doing exactly what it always did (AC-A1).
 *
 * It goes to **stderr**, so `ssh-mcp setup ... > out.txt` still produces the
 * same bytes it did in 0.2.x — the notice is for the person, not for whatever
 * is reading the output.
 */
export const SETUP_DEPRECATION_NOTICE =
  'setup은 host add로 이름이 바뀌었습니다. 0.4.0에서 제거됩니다.';

export const COMMANDS = {
  install: async (): Promise<CommandRunner> => (await import('./install/cli.js')).runInstall,
  host: async (): Promise<CommandRunner> => (await import('./host/cli.js')).runHost,
  doctor: async (): Promise<CommandRunner> => (await import('./doctor/cli.js')).runDoctor,
  // The `ssh` delegation of these two is a deliberate exception to "pure JS
  // only, never the system ssh" and it is fenced in (plan 부록 B-1, G-1..G-4).
  // These thunks are the *only* way into `src/connect/` from the binary: no
  // module on the server path may import it, so a machine without `ssh`
  // starts the server and answers every tool call exactly as before.
  connect: async (): Promise<CommandRunner> => (await import('./connect/cli.js')).runConnect,
  exec: async (): Promise<CommandRunner> => (await import('./connect/execCli.js')).runExecCommand,
  // `setup` still runs `host add` unchanged, byte for byte on stdout — but it
  // is now on the way out, so it says so once on stderr first (AC-A1). This
  // reverses the earlier note here ("keeps working with no warning … nagging
  // here would break a working setup for no benefit"), and the reason is that
  // there is now something to nag about: 0.4.0 removes it. A user who upgrades
  // silently through `npx -y` is exactly the one who has to hear it before the
  // command disappears, and one stderr line is the cheapest way to say it.
  setup: async (): Promise<CommandRunner> => {
    const { runSetup } = await import('./setup/cli.js');
    return (argv: string[]): Promise<number> => {
      process.stderr.write(`${SETUP_DEPRECATION_NOTICE}\n`);
      return runSetup(argv);
    };
  },
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

/**
 * Aliases `host add` refuses, because `ssh-mcp connect <alias>` has to be
 * unambiguous (AC-C6, AC-C6a).
 *
 * Derived from {@link COMMAND_NAMES} rather than typed out, so a command added
 * to the table above is reserved the same day it exists. `help` and `version`
 * are not commands in the table — they are router tokens — but both are things
 * a person types after `ssh-mcp`, so they belong here too.
 *
 * The `-h`/`--help` spellings need no entry: `AliasSchema` already refuses an
 * alias that starts with `-` (`src/config/schema.ts`).
 */
export const RESERVED_ALIASES = [...COMMAND_NAMES, 'help', 'version'] as const;

export function isReservedAlias(value: string): boolean {
  return (RESERVED_ALIASES as readonly string[]).includes(value);
}
