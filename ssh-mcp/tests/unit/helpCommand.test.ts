/**
 * `ssh-mcp help` (added 2026-09-15).
 *
 * The bug this command exists for is invisible from inside a unit test: all
 * three help tokens used to fall through the router into server mode, so the
 * process printed nothing and hung. What can be pinned here is the rest — that
 * the overview names every command a user can run and fits the terminal it is
 * read in, that asking for help is not treated as an error, and that
 * `help <command> ...` forwards instead of carrying its own copy of that
 * command's flags. The routing itself is checked against the built binary in
 * `tests/e2e/package.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES, HELP_TOKENS, VERSION_TOKENS } from '../../src/commands.js';
import type { CommandName, CommandRunner, CommandTable } from '../../src/commands.js';
import {
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  USAGE_DESCRIPTION_COLUMN,
  USAGE_MAX_COLUMNS,
  runHelp,
  type HelpDeps,
} from '../../src/help.js';
import { displayWidth } from '../../src/internal/text.js';

/**
 * What every fake command returns. Deliberately not `EXIT_OK`: a `runHelp` that
 * awaited the command and then returned its own success would otherwise pass
 * every test here by coincidence.
 */
const COMMAND_EXIT = 7;

interface Forwarded {
  command: CommandName;
  argv: readonly string[];
}

interface Capture {
  out: string[];
  err: string[];
  forwarded: Forwarded[];
  /** Every command records the argv it was handed and returns COMMAND_EXIT. */
  commands: CommandTable;
  deps: HelpDeps;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const forwarded: Forwarded[] = [];
  const commands = Object.fromEntries(
    COMMAND_NAMES.map((command): [CommandName, () => Promise<CommandRunner>] => [
      command,
      (): Promise<CommandRunner> =>
        Promise.resolve((argv: string[]): Promise<number> => {
          forwarded.push({ command, argv });
          return Promise.resolve(COMMAND_EXIT);
        }),
    ])
  ) as CommandTable;
  const deps: HelpDeps = {
    out: (text: string): void => void out.push(text),
    err: (text: string): void => void err.push(text),
    commands,
  };
  return { out, err, forwarded, commands, deps };
}

describe('USAGE names everything a user can actually run', () => {
  // A command missing from the overview is a command nobody finds. The list is
  // asserted rather than eyeballed because it is the only place these strings
  // are collected, so nothing else would notice a new command going unlisted.
  // `setup` is here because it still works as an alias of `host add`.
  it.each([
    'install',
    'host add',
    'host list',
    'doctor',
    'help',
    'setup',
    'version',
    '--version',
    '--help',
    'npm i -g @get-bot/ssh-mcp',
  ])('mentions %s', (needle) => {
    expect(USAGE).toContain(needle);
  });

  it('says what running with no arguments does', () => {
    // The most confusing thing about this binary: bare `ssh-mcp` is not a
    // no-op or an error, it is the server the client spawns.
    expect(USAGE).toContain('MCP 서버');
  });

  it('fits the terminal it is read in, measured in display columns', () => {
    // `line.length` would be the wrong ruler: most of this text is Korean, and
    // each of those glyphs takes two terminal columns. A line of 64 characters
    // can already be 80 columns wide, and the next word wraps it.
    for (const line of USAGE.split('\n')) {
      const width = displayWidth(line);
      expect(width, `${String(width)} columns: ${line}`).toBeLessThanOrEqual(USAGE_MAX_COLUMNS);
    }
  });

  it('starts every description in the same column', () => {
    // A table whose second column wanders reads as a mistake before it reads
    // as a table. The left column is ASCII, so character index is column here.
    const rows = USAGE.split('\n').filter((line) => line.startsWith('  '));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const left = row.slice(0, USAGE_DESCRIPTION_COLUMN);
      const boundary = `column ${String(USAGE_DESCRIPTION_COLUMN)}: ${row}`;
      expect(left.endsWith(' '), `left column runs into ${boundary}`).toBe(true);
      expect(row[USAGE_DESCRIPTION_COLUMN], `description does not start at ${boundary}`).not.toBe(
        ' '
      );
    }
  });
});

describe('runHelp', () => {
  it('prints the overview to stdout and succeeds', async () => {
    const c = capture();
    const code = await runHelp([], c.deps);
    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([USAGE]);
    expect(c.err).toEqual([]);
  });

  it.each([...HELP_TOKENS, ...VERSION_TOKENS])(
    'answers `help %s` with the overview, not "unknown"',
    async (token) => {
      // Neither has a usage string of its own, and `ssh-mcp version` is a
      // command that works, so `help version` cannot be an error.
      const c = capture();
      const code = await runHelp([token], c.deps);
      expect(code).toBe(EXIT_OK);
      expect(c.out).toEqual([USAGE]);
      expect(c.err).toEqual([]);
      expect(c.forwarded).toEqual([]);
    }
  );

  it.each(COMMAND_NAMES)(
    'forwards `help %s` to that command as `--help` and returns its exit code',
    async (command) => {
      const c = capture();
      const code = await runHelp([command], c.deps);
      expect(code).toBe(COMMAND_EXIT);
      expect(c.forwarded).toEqual([{ command, argv: ['--help'] }]);
      // Nothing printed here: the sub-command owns its own usage string.
      expect(c.out).toEqual([]);
      expect(c.err).toEqual([]);
    }
  );

  it('forwards everything after the command, so `help host add` reaches `host add`', async () => {
    // The group usage with `add` silently dropped is not what anyone typing
    // this meant. What the command does with the extra words is its own
    // parser's decision — it already knows how to refuse an argument it does
    // not take.
    const c = capture();
    const code = await runHelp(['host', 'add', '--force'], c.deps);
    expect(code).toBe(COMMAND_EXIT);
    expect(c.forwarded).toEqual([{ command: 'host', argv: ['add', '--force', '--help'] }]);
  });

  it('treats an unknown command as a usage error on stderr', async () => {
    const c = capture();
    const code = await runHelp(['bogus'], c.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(c.out).toEqual([]);
    expect(c.err[0]).toContain('bogus');
    expect(c.err.join('\n')).toContain(USAGE);
    expect(c.forwarded).toEqual([]);
  });

  it('lets a command that fails to load fail loudly instead of dressing it up as help', async () => {
    // A rejection here means the sub-command module could not load or threw
    // before parsing. `main()` reports that as `ssh-mcp failed: …`; catching it
    // to print a friendlier usage would hide which command is broken.
    const c = capture();
    const boom = new Error('module failed to load');
    const commands: CommandTable = { ...c.commands, doctor: () => Promise.reject(boom) };
    await expect(runHelp(['doctor'], { ...c.deps, commands })).rejects.toBe(boom);
    expect(c.out).toEqual([]);
    expect(c.err).toEqual([]);
  });
});
