/**
 * `ssh-mcp` bin entry point (plan row 0.7).
 *
 * Node version guard, then argv routing:
 *   `host ...`    -> host group     (`add` = the setup CLI, `list`)
 *   `setup ...`   -> setup CLI      (silent alias of `host add`; see `host/cli.ts`)
 *   `doctor ...`  -> doctor CLI     (exit code from `runDoctor`)
 *   `install ...` -> install CLI    (exit code from `runInstall`)
 *   `--version`   -> version to stdout
 *   `help ...`    -> command overview, or one command's own usage
 *   anything else -> stdio MCP server
 *
 * Sub-command modules are imported dynamically so that starting the server
 * never loads the CLI code, and vice versa. `help.ts` is the one static import:
 * it is string literals with no dependencies, and the router has to read
 * `HELP_TOKENS` from it rather than keep a copy — a copy that drifted would
 * send a help spelling into server mode, which is the bug `help` exists to fix.
 */
import { HELP_TOKENS, runHelp } from './help.js';
import { installStdoutGuard } from './log.js';
import { readPackageVersion } from './version.js';

/**
 * The floor for the **server**, which is what AC1.1 fixes at Node 20.
 *
 * `engines.node` is stricter (`^20.17.0 || ^22.13.0 || >=23.5.0`) because the
 * interactive questions in `install` and `host add` load `@inquirer`, which
 * needs 20.17. The two numbers are deliberately different: a Node between 20.0
 * and 20.16 runs the server and every non-interactive command, and is told what
 * it is missing only if it asks for a question. So this guard stays at 20 —
 * raising it here would refuse to start a server that works.
 */
export const MIN_NODE_MAJOR = 20;

function nodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? 0 : major;
}

// The version lookup lives in `./version.js` because `server.ts` needs it too
// and cannot import this module: importing it would run the CLI again.
export { readPackageVersion };

export async function run(argv: string[]): Promise<number> {
  const major = nodeMajor();
  if (major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `ssh-mcp requires Node.js ${String(MIN_NODE_MAJOR)} or newer, but this is ` +
        `${process.versions.node}. Install a supported Node.js and try again.\n`
    );
    return 1;
  }

  const command = argv[0];

  if (command === 'host') {
    const { runHost } = await import('./host/cli.js');
    return runHost(argv.slice(1));
  }

  // `setup` predates the `host` group and keeps working with no warning: an
  // 0.1.0 user upgrades automatically through `npx -y`, so breaking or nagging
  // here would break a working setup for no benefit.
  if (command === 'setup') {
    const { runSetup } = await import('./setup/cli.js');
    return runSetup(argv.slice(1));
  }

  if (command === 'doctor') {
    const { runDoctor } = await import('./doctor/cli.js');
    return runDoctor(argv.slice(1));
  }

  if (command === 'install') {
    const { runInstall } = await import('./install/cli.js');
    return runInstall(argv.slice(1));
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  // Before the fall-through below, because every one of these used to reach it:
  // asking `ssh-mcp --help` started a server and waited on stdin forever.
  // `help <command> ...` re-enters this router as `<command> ... --help` rather
  // than restating a sub-command's flags, so the usage strings stay in one
  // place each and `help host add` lands on `host add`, not on the group.
  if (command !== undefined && (HELP_TOKENS as readonly string[]).includes(command)) {
    return runHelp(argv.slice(1), {
      delegate: (topic, rest) => run([topic, ...rest, '--help']),
    });
  }

  // Server mode: stdout carries JSON-RPC frames only, so redirect every
  // stdout-bound console method to stderr before anything can write (AC2.3).
  installStdoutGuard();
  const { startServer } = await import('./server.js');
  await startServer();
  return 0;
}

async function main(): Promise<void> {
  try {
    const code = await run(process.argv.slice(2));
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    process.stderr.write(`ssh-mcp failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
