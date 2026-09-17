/**
 * `ssh-mcp exec <alias> -- <command...>` — one command on a registered host
 * (plan F8, AC-C2, AC-C4).
 *
 * The same delegation as `connect`, with the words after `--` appended to the
 * argv. **They are appended as separate array elements and are never touched**
 * — not rewritten, not classified, not quoted, not re-split. That is AC-C2, and
 * it is why `spawnSsh` uses `shell: false`: a shell in the middle would re-read
 * `&`, `|`, `%VAR%` or `$(…)` and run something other than what was typed.
 *
 * OpenSSH joins the remaining argv with single spaces and sends the result to
 * the remote shell, so `exec web1 -- echo 'a b'` reaches the server as
 * `echo a b`, exactly as typing that ssh command would. Preserving the *local*
 * argv is what this module owes the user; the remote shell's own parsing is the
 * user's business, the same as it is with ssh.
 *
 * The name is `runExecCommand`, not `runExec`, because `src/ssh/exec.ts`
 * already owns the tool-side `exec` vocabulary and the two must never be
 * confused in an import list: one is the audited, classified, approved path and
 * this one is none of those things.
 */
import { EXIT_OK, EXIT_USAGE, runSshDelegate, writers } from './cli.js';
import type { ConnectDeps } from './cli.js';

export { EXIT_OK, EXIT_FAILED, EXIT_USAGE } from './cli.js';

/** The token that ends our options and starts the remote command. */
const SEPARATOR = '--';

export const USAGE = [
  'Usage: ssh-mcp exec <alias> -- <command...>',
  '',
  '등록된 호스트에서 명령 한 줄을 실행하고 결과를 그대로 터미널에 보여 줍니다.',
  '`--` 뒤의 토큰은 하나도 바꾸지 않고 ssh에 그대로 넘깁니다.',
  '',
  'Options:',
  '  -h, --help  이 도움말을 출력합니다.',
  '',
  '예) ssh-mcp exec web1 -- systemctl status nginx',
  '',
  '이 경로는 사람이 직접 쓰는 통로입니다. 명령 분류·승인·감사·출력 발췌를 거치지',
  '않고, 호스트 키 확인도 ssh-mcp에 고정된 지문이 아니라 OpenSSH의 known_hosts를',
  '따릅니다. 승인과 감사가 필요하면 MCP 도구 exec를 쓰세요.',
].join('\n');

/** Run `exec`. Returns the process exit code. */
export async function runExecCommand(
  argv: readonly string[],
  deps: ConnectDeps = {}
): Promise<number> {
  const { out, err } = writers(deps);

  // Only the tokens *before* `--` are ours to read. `exec web1 -- --help` asks
  // the remote host for its help, not us for ours.
  const separator = argv.indexOf(SEPARATOR);
  const head = separator === -1 ? argv : argv.slice(0, separator);

  for (const token of head) {
    if (token === '-h' || token === '--help') {
      out(USAGE);
      return EXIT_OK;
    }
  }

  const alias = head[0];
  if (alias === undefined) {
    err('ssh-mcp exec: alias가 필요합니다.');
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }
  if (head.length > 1) {
    err(`ssh-mcp exec: unexpected extra argument: ${head[1] ?? ''}`);
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }

  // `--` is required even though the alias alone would be unambiguous: without
  // it there is no way to tell `exec web1 -v` (our flag?) from `exec web1 -- -v`
  // (the remote command's), and guessing is exactly what AC-C2 rules out.
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (command.length === 0) {
    err('ssh-mcp exec: `--` 뒤에 실행할 명령이 필요합니다.');
    err('');
    err(USAGE);
    return EXIT_USAGE;
  }

  return runSshDelegate('exec', alias, command, deps);
}
