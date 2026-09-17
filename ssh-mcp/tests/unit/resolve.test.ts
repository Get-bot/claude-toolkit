/**
 * The `ResolvedCommand` brand and the resolve step (plan rows E1/E1b/E2,
 * ADR-012, AC-J5, AC-J5a).
 *
 * Three kinds of test, because the guarantee has three halves and only one of
 * them is observable at runtime:
 *
 * 1. **Behaviour** — `format: "text"` is the identity, `format: "json"` defers
 *    to the table, and a command AC-J3 refuses still comes back to be run.
 * 2. **Compile** — `brandIsRequired` below never executes. Its `@ts-expect-error`
 *    lines fail `tsc --noEmit` the day any of the three doors goes back to
 *    accepting a plain `string`, which is the whole of AC-J5a.
 * 3. **Lint** — the escape hatch is only an escape hatch while guard G-2 holds,
 *    so the last block runs ESLint over two snippets and asserts it refuses the
 *    one in `src/tools/` and allows the one in `src/ssh/session.ts`.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { internalCommand, resolveCommand } from '../../src/output/resolve.js';
import type { ResolvedCommand } from '../../src/output/resolve.js';
import type { ApproveCommandInput } from '../../src/tools/gated.js';
// Type-only: neither module is loaded at run time, so this file stays a unit test.
import type * as ExecModule from '../../src/ssh/exec.js';
import type * as SessionModule from '../../src/ssh/session.js';

describe('resolveCommand, format: "text"', () => {
  it.each([
    'echo hi',
    'docker ps',
    'docker ps | head -n 5',
    '  spaced   out  ',
    'cat <<EOF\nbody\nEOF',
  ])('returns %j byte for byte', (command) => {
    const resolved = resolveCommand(command, 'text');
    expect(resolved.command).toBe(command);
    expect(resolved.rewritten).toBe(false);
  });

  it('adds no parse plan, so the response carries no parsed field (AC-J1)', () => {
    const resolved = resolveCommand('docker ps', 'text');
    expect(resolved.plan).toBeNull();
    expect(resolved.parseError).toBeNull();
    expect(resolved.format).toBe('text');
  });
});

describe('resolveCommand, format: "json"', () => {
  it('rewrites a table command and asks for a JSON parse (AC-J2)', () => {
    const resolved = resolveCommand('docker ps', 'json');
    expect(resolved.command).toBe('docker ps --format json');
    expect(resolved.rewritten).toBe(true);
    expect(resolved.plan).toEqual({ kind: 'json' });
    expect(resolved.parseError).toBeNull();
  });

  it('routes df to the fixed-column parser instead (AC-J4)', () => {
    const resolved = resolveCommand('df -h', 'json');
    expect(resolved.command).toBe('df -P');
    expect(resolved.plan).toEqual({ kind: 'table', parser: 'df' });
  });

  it('leaves an unlisted command alone and still asks for a JSON parse (AC-J6)', () => {
    const resolved = resolveCommand('cat /etc/os-release.json', 'json');
    expect(resolved.command).toBe('cat /etc/os-release.json');
    expect(resolved.rewritten).toBe(false);
    expect(resolved.plan).toEqual({ kind: 'json' });
  });

  it('runs the original command when AC-J3 refuses to rewrite it', () => {
    const resolved = resolveCommand('docker ps | head -n 5', 'json');
    expect(resolved.command).toBe('docker ps | head -n 5');
    expect(resolved.rewritten).toBe(false);
    expect(resolved.plan).toBeNull();
    expect(resolved.parseError).toBe('not_rewritable');
  });
});

describe('internalCommand', () => {
  it('brands the string unchanged', () => {
    const command = internalCommand('pkill -TERM -P 41');
    expect(command).toBe('pkill -TERM -P 41');
  });
});

// --------------------------------------------------------------------------
// AC-J5a, half one: the compile-time half. Never called.
// --------------------------------------------------------------------------

type ExecOnceCommand = Parameters<typeof ExecModule.execOnce>[1];
type RunInSessionCommand = Parameters<typeof SessionModule.runInSession>[1];
type ApproveCommand = ApproveCommandInput['command'];

function brandIsRequired(): void {
  const raw = 'echo hi';

  // @ts-expect-error AC-J5a: the approval gate refuses an unresolved command.
  const _gate: ApproveCommand = raw;
  // @ts-expect-error AC-J5a: execOnce refuses an unresolved command.
  const _exec: ExecOnceCommand = raw;
  // @ts-expect-error AC-J5a: runInSession refuses an unresolved command at its public signature.
  const _session: RunInSessionCommand = raw;

  // The positive direction: one resolve satisfies all three doors, and a
  // ResolvedCommand is still a string everywhere downstream.
  const resolved: ResolvedCommand = resolveCommand(raw, 'json').command;
  const _gateOk: ApproveCommand = resolved;
  const _execOk: ExecOnceCommand = resolved;
  const _sessionOk: RunInSessionCommand = internalCommand(raw);
  const _stillAString: string = resolved;
}
void brandIsRequired;

// --------------------------------------------------------------------------
// AC-J5a, half two: guard G-2 (plan row E1b, R40).
// --------------------------------------------------------------------------

const LAUNDERING = [
  "import { internalCommand } from '../output/resolve.js';",
  'export const washed = (raw: string) => internalCommand(raw);',
].join('\n');

const LEGITIMATE = [
  "import { internalCommand } from '../output/resolve.js';",
  'export const reap = (pid: number) => internalCommand(`pkill -TERM -P ${pid}`);',
].join('\n');

/**
 * Both guards report through a `no-restricted-*` rule, so this filter names the
 * prefix rather than one rule id: G-2 is expressed as `no-restricted-syntax`
 * (the config says why it cannot be a second `no-restricted-imports` block),
 * and a future swap back must not make these tests pass by seeing nothing.
 */
async function guardMessages(source: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId?.startsWith('no-restricted') === true)
    .map((message) => message.message);
}

describe('guard G-2: internalCommand imports', () => {
  it('refuses the src/tools/ laundering path (R40)', async () => {
    const messages = await guardMessages(LAUNDERING, 'src/tools/exec.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('internalCommand');
  });

  it('refuses it anywhere else on the server path too', async () => {
    expect(await guardMessages(LAUNDERING, 'src/ssh/exec.ts')).toHaveLength(1);
    expect(await guardMessages(LAUNDERING, 'src/server.ts')).toHaveLength(1);
  });

  it('allows the session reaper, the one production caller', async () => {
    expect(await guardMessages(LEGITIMATE, 'src/ssh/session.ts')).toEqual([]);
  });

  it('catches the aliased and namespace forms too', async () => {
    const aliased = [
      "import { internalCommand as ic } from '../output/resolve.js';",
      'export const washed = (raw: string) => ic(raw);',
    ].join('\n');
    const namespaced = [
      "import * as resolve from '../output/resolve.js';",
      'export const washed = (raw: string) => resolve.internalCommand(raw);',
    ].join('\n');
    expect(await guardMessages(aliased, 'src/tools/exec.ts')).toHaveLength(1);
    expect(await guardMessages(namespaced, 'src/tools/exec.ts')).toHaveLength(1);
  });

  it('catches a renamed re-export, which hands the hatch on under a new name', async () => {
    const relayed = [
      "import { internalCommand } from '../output/resolve.js';",
      'export { internalCommand as mint };',
    ].join('\n');
    // Two findings here, not one: the import and the re-export. Both name the
    // same hatch, and either alone is enough to fail the build.
    expect((await guardMessages(relayed, 'src/tools/exec.ts')).length).toBeGreaterThanOrEqual(1);

    // And the re-export on its own, for the case where the name arrived by
    // some route the import selector never saw.
    const bare = [
      'declare const internalCommand: (raw: string) => string;',
      'export { internalCommand as mint };',
    ].join('\n');
    expect(await guardMessages(bare, 'src/tools/exec.ts')).toHaveLength(1);
  });

  it('leaves resolveCommand importable, or the two tools would not compile', async () => {
    const source = [
      "import { resolveCommand } from '../output/resolve.js';",
      "export const run = (raw: string) => resolveCommand(raw, 'json');",
    ].join('\n');
    expect(await guardMessages(source, 'src/tools/exec.ts')).toEqual([]);
  });

  it('does not switch guard G-1 off where the two scopes overlap', async () => {
    // Flat config replaces a rule's options instead of merging them, so an
    // overlapping second `no-restricted-imports` block would have silently
    // unguarded `src/connect/` for exactly the files that matter most. This is
    // not a hypothetical: the first draft of G-2 did that.
    const source = [
      "import { findSsh } from '../connect/spawn.js';",
      'export const run = () => findSsh();',
    ].join('\n');
    for (const filePath of ['src/tools/exec.ts', 'src/ssh/exec.ts', 'src/server.ts']) {
      expect(await guardMessages(source, filePath)).toHaveLength(1);
    }
  });
});
