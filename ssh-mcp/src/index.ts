/**
 * `ssh-mcp` bin entry point (plan row 0.7).
 *
 * Node version guard, then argv routing:
 *   `<command> ...` -> that command's CLI, from the `COMMANDS` table in
 *                      `commands.ts` (`install`, `host`, `doctor`, `setup`;
 *                      the exit code is the command's own)
 *   `--version`     -> version to stdout
 *   `help ...`      -> command overview, or one command's own usage
 *   anything else   -> stdio MCP server
 *
 * Sub-command modules are imported dynamically — through the thunks in
 * `commands.ts` — so that starting the server never loads the CLI code, and
 * vice versa. `commands.ts` and `help.ts` are the two static imports: string
 * tables and closures, nothing that runs at load time.
 */
import { COMMANDS, HELP_TOKENS, VERSION_TOKENS, isCommandName } from './commands.js';
import { runHelp } from './help.js';
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

  // Bare `ssh-mcp` is the server: that is the shape the client spawns.
  if (command !== undefined) {
    if (isCommandName(command)) {
      const runCommand = await COMMANDS[command]();
      return runCommand(argv.slice(1));
    }

    if ((VERSION_TOKENS as readonly string[]).includes(command)) {
      process.stdout.write(`${readPackageVersion()}\n`);
      return 0;
    }

    // Before the fall-through below, because every one of these used to reach
    // it: asking `ssh-mcp --help` started a server and waited on stdin forever.
    if ((HELP_TOKENS as readonly string[]).includes(command)) {
      return runHelp(argv.slice(1));
    }
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
