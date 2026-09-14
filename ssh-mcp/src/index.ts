/**
 * `ssh-mcp` bin entry point (plan row 0.7).
 *
 * Node version guard, then argv routing:
 *   `setup ...`   -> setup CLI      (exit code from `runSetup`)
 *   `doctor ...`  -> doctor CLI     (exit code from `runDoctor`)
 *   `install ...` -> install CLI    (exit code from `runInstall`)
 *   `--version`   -> version to stdout
 *   anything else -> stdio MCP server
 *
 * Sub-command modules are imported dynamically so that starting the server
 * never loads the CLI code, and vice versa.
 */
import { installStdoutGuard } from './log.js';
import { readPackageVersion } from './version.js';

/** Lower bound from `engines.node` and the spec's tech stack (AC1.1). */
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
