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

import { displayWidth } from '../../src/doctor/cli.js';
import {
  EXIT_OK,
  EXIT_USAGE,
  HELP_TOKENS,
  HELP_TOPICS,
  USAGE,
  USAGE_DESCRIPTION_COLUMN,
  USAGE_MAX_COLUMNS,
  VERSION_TOKENS,
  isHelpTopic,
  runHelp,
  type HelpDeps,
  type HelpTopic,
} from '../../src/help.js';

/**
 * What the fake delegate returns. Deliberately not `EXIT_OK`: a `runHelp` that
 * awaited the delegate and then returned its own success would otherwise pass
 * every test here by coincidence.
 */
const DELEGATE_EXIT = 7;

interface Delegation {
  topic: HelpTopic;
  rest: readonly string[];
}

interface Capture {
  out: string[];
  err: string[];
  delegated: Delegation[];
  /** Writers only; pass this where the caller has nothing to delegate to. */
  writers: HelpDeps;
  /** Writers plus a delegate that records the call and returns DELEGATE_EXIT. */
  deps: HelpDeps;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const delegated: Delegation[] = [];
  const writers: HelpDeps = {
    out: (text: string): void => void out.push(text),
    err: (text: string): void => void err.push(text),
  };
  const deps: HelpDeps = {
    ...writers,
    delegate: (topic: HelpTopic, rest: readonly string[]): Promise<number> => {
      delegated.push({ topic, rest });
      return Promise.resolve(DELEGATE_EXIT);
    },
  };
  return { out, err, delegated, writers, deps };
}

describe('USAGE names everything a user can actually run', () => {
  // A command missing from the overview is a command nobody finds. The list is
  // asserted rather than eyeballed because it is the only place these strings
  // are collected, so nothing else would notice a new command going unlisted.
  it.each([
    'install',
    'host add',
    'host list',
    'doctor',
    'help',
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

  it('keeps the setup alias documented', () => {
    expect(USAGE).toContain('setup');
    expect(USAGE).toContain('host add');
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

  it.each(HELP_TOPICS)(
    'forwards `help %s` and returns what that command returned',
    async (topic) => {
      const c = capture();
      const code = await runHelp([topic], c.deps);
      expect(code).toBe(DELEGATE_EXIT);
      expect(c.delegated).toEqual([{ topic, rest: [] }]);
      // Nothing printed here: the sub-command owns its own usage string.
      expect(c.out).toEqual([]);
      expect(c.err).toEqual([]);
    }
  );

  it('forwards everything after the topic, so `help host add` reaches `host add`', async () => {
    // The group usage with `add` silently dropped is not what anyone typing
    // this meant. What the topic does with the extra words is its own parser's
    // decision — it already knows how to refuse an argument it does not take.
    const c = capture();
    const code = await runHelp(['host', 'add', '--force'], c.deps);
    expect(code).toBe(DELEGATE_EXIT);
    expect(c.delegated).toEqual([{ topic: 'host', rest: ['add', '--force'] }]);
  });

  it('falls back to the overview when there is nothing to delegate to', async () => {
    const c = capture();
    const code = await runHelp(['doctor'], c.writers);
    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([USAGE]);
  });

  it('answers `help help` with the overview rather than an error', async () => {
    const c = capture();
    const code = await runHelp(['help'], c.deps);
    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([USAGE]);
    expect(c.err).toEqual([]);
  });

  it.each(VERSION_TOKENS)('answers `help %s` with the overview, not "unknown"', async (token) => {
    // `ssh-mcp version` is a command that works, so `help version` cannot be
    // an error; it has no usage of its own, so the overview is what it gets.
    const c = capture();
    const code = await runHelp([token], c.deps);
    expect(code).toBe(EXIT_OK);
    expect(c.out).toEqual([USAGE]);
    expect(c.err).toEqual([]);
    expect(c.delegated).toEqual([]);
  });

  it('treats an unknown command as a usage error on stderr', async () => {
    const c = capture();
    const code = await runHelp(['bogus'], c.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(c.out).toEqual([]);
    expect(c.err[0]).toContain('bogus');
    expect(c.err.join('\n')).toContain(USAGE);
    expect(c.delegated).toEqual([]);
  });

  it('lets a failing delegate fail loudly instead of dressing it up as help', async () => {
    // A rejection here means the sub-command module could not load or threw
    // before parsing. `main()` reports that as `ssh-mcp failed: …`; catching it
    // to print a friendlier usage would hide which command is broken.
    const c = capture();
    const boom = new Error('module failed to load');
    await expect(
      runHelp(['doctor'], { ...c.writers, delegate: () => Promise.reject(boom) })
    ).rejects.toBe(boom);
    expect(c.out).toEqual([]);
    expect(c.err).toEqual([]);
  });
});

describe('token and topic tables', () => {
  it('accepts the three spellings a user would try', () => {
    expect([...HELP_TOKENS]).toEqual(['help', '--help', '-h']);
  });

  it('routes exactly the commands the router can route', () => {
    // `setup` is here because it still works as an alias; leaving it out would
    // make `ssh-mcp help setup` an error for a command that runs fine. Adding
    // a top-level command to index.ts means adding it here too — this is the
    // test that says so out loud.
    expect([...HELP_TOPICS]).toEqual(['install', 'host', 'doctor', 'setup']);
    expect(isHelpTopic('host')).toBe(true);
    expect(isHelpTopic('bogus')).toBe(false);
  });
});
