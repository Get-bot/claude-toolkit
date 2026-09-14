/**
 * The `ssh-mcp host` command group.
 *
 * `setup` never said what it set up. `host add` does, and it leaves room for
 * `host list` and whatever else the registry needs later. **`setup` stays as an
 * alias of `host add`, silently**: an 0.1.0 user upgrades automatically through
 * `npx -y`, so a command that starts warning — or worse, failing — would break
 * a setup that was working ten minutes ago. There is nothing to deprecate yet.
 *
 * `add` delegates to `runSetup` unchanged, wizard and all. Renaming the
 * internals (`runSetup`, `src/setup/`, `parseSetupArgs`) would produce a large
 * diff across the security-relevant part of this package and buy nothing a
 * reader of the CLI can see.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import { runSetup } from '../setup/cli.js';
import type { SetupDeps } from '../setup/cli.js';
import { runHostList } from './list.js';
import type { HostListDeps } from './list.js';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export const HOST_SUBCOMMANDS = ['add', 'list'] as const;

export const USAGE = [
  'Usage: ssh-mcp host <add|list> [options]',
  '',
  'Sub-commands:',
  '  add [<alias> <user@host[:port]>]  호스트를 등록합니다. 인자를 생략하면 터미널에서 물어봅니다.',
  '  list [--json]                     등록된 호스트를 표로 출력합니다.',
  '',
  '각 하위 명령의 자세한 사용법은 `ssh-mcp host add --help`처럼 확인하세요.',
  '`ssh-mcp setup`은 `ssh-mcp host add`의 별칭으로 계속 동작합니다.',
].join('\n');

export interface HostDeps extends SetupDeps, HostListDeps {}

/** Route `host <sub-command>`. Returns the process exit code. */
export async function runHost(argv: readonly string[], deps: HostDeps = {}): Promise<number> {
  const err = deps.err ?? ((text: string): void => void process.stderr.write(`${text}\n`));
  const sub = argv[0];

  if (sub === 'add') return runSetup([...argv.slice(1)], deps);
  if (sub === 'list') return runHostList(argv.slice(1), deps);

  if (sub === undefined || sub === '-h' || sub === '--help') {
    err(USAGE);
    return sub === undefined ? EXIT_USAGE : EXIT_OK;
  }

  err(`ssh-mcp host: unknown sub-command "${sub}": expected ${HOST_SUBCOMMANDS.join(' or ')}`);
  err('');
  err(USAGE);
  return EXIT_USAGE;
}
