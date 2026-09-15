/**
 * `ssh-mcp help` (added 2026-09-15).
 *
 * The bug this command exists for is invisible from inside a unit test: all
 * three help tokens used to fall through the router into server mode, so the
 * process printed nothing and hung. What can be pinned here is the rest — that
 * the overview actually names every command a user can run, that asking for
 * help is not treated as an error, and that `help <command>` forwards instead
 * of carrying its own copy of that command's flags.
 */
import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_USAGE,
  HELP_TOKENS,
  HELP_TOPICS,
  USAGE,
  isHelpTopic,
  runHelp,
  type HelpDeps,
  type HelpTopic,
} from '../../src/help.js';

interface Capture {
  out: string[];
  err: string[];
  delegated: HelpTopic[];
  /** Writers only; pass this where the caller has nothing to delegate to. */
  writers: HelpDeps;
  /** Writers plus a delegate that records the topic and reports success. */
  deps: HelpDeps;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const delegated: HelpTopic[] = [];
  const writers: HelpDeps = {
    out: (text: string): void => void out.push(text),
    err: (text: string): void => void err.push(text),
  };
  const deps: HelpDeps = {
    ...writers,
    delegate: (topic: HelpTopic): Promise<number> => {
      delegated.push(topic);
      return Promise.resolve(EXIT_OK);
    },
  };
  return { out, err, delegated, writers, deps };
}

describe('USAGE names everything a user can actually run', () => {
  // A command missing from the overview is a command nobody finds. The list is
  // asserted rather than eyeballed because it is the only place these strings
  // are collected, so nothing else would notice a new command going unlisted.
  it.each([
    ['install', 'install'],
    ['host add', 'host add'],
    ['host list', 'host list'],
    ['doctor', 'doctor'],
    ['help', 'help'],
    ['--version', '--version'],
    ['--help', '--help'],
  ])('mentions %s', (_label, needle) => {
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

  it('fits a narrow terminal', () => {
    // 80 columns is the floor a terminal is allowed to be; a wrapped usage
    // table reads as garbage.
    for (const line of USAGE.split('\n')) {
      expect(line.length, `too wide (${String(line.length)}): ${line}`).toBeLessThanOrEqual(80);
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

  it.each(HELP_TOPICS)('forwards `help %s` instead of restating it', async (topic) => {
    const c = capture();
    const code = await runHelp([topic], c.deps);
    expect(code).toBe(EXIT_OK);
    expect(c.delegated).toEqual([topic]);
    // Nothing printed here: the sub-command owns its own usage string.
    expect(c.out).toEqual([]);
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

  it('treats an unknown command as a usage error on stderr', async () => {
    const c = capture();
    const code = await runHelp(['bogus'], c.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(c.out).toEqual([]);
    expect(c.err[0]).toContain('bogus');
    expect(c.err.join('\n')).toContain(USAGE);
    expect(c.delegated).toEqual([]);
  });
});

describe('token and topic tables', () => {
  it('accepts the three spellings a user would try', () => {
    expect([...HELP_TOKENS]).toEqual(['help', '--help', '-h']);
  });

  it('routes exactly the commands the router can route', () => {
    // `setup` is here because it still works as an alias; leaving it out would
    // make `ssh-mcp help setup` an error for a command that runs fine.
    expect([...HELP_TOPICS]).toEqual(['install', 'host', 'doctor', 'setup']);
    expect(isHelpTopic('host')).toBe(true);
    expect(isHelpTopic('bogus')).toBe(false);
  });
});
