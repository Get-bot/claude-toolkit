/**
 * Remote `authorized_keys` installation (plan row 5.5, §5.7).
 *
 * One `exec` of one POSIX shell script, with the public key delivered on the
 * channel's **stdin** rather than interpolated into the command. That removes
 * shell quoting from the picture entirely: no comment field, no key blob and no
 * hostile alias can break out of the script.
 *
 * Idempotence comes from `grep -qxF` (fixed string, whole line), which is what
 * AC7.3 asserts by running `setup` twice and counting the line.
 */
import type { Client, ClientChannel } from 'ssh2';

export const MARKER_INSTALLED = 'SSHMCP_INSTALLED';
export const MARKER_ALREADY_PRESENT = 'SSHMCP_ALREADY_PRESENT';

/**
 * §5.7 verbatim. `k=$(cat)` reads the key from stdin and strips the trailing
 * newline; the `tail -c 1 | wc -l` test appends a newline when the existing
 * file does not end with one, so a new key can never be glued onto the last
 * line of an old one.
 */
export const AUTHORIZED_KEYS_SCRIPT = [
  'umask 077',
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
  'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
  'k=$(cat)',
  'if [ -s ~/.ssh/authorized_keys ] && [ "$(tail -c 1 ~/.ssh/authorized_keys | wc -l)" -eq 0 ]; then',
  "  printf '\\n' >> ~/.ssh/authorized_keys",
  'fi',
  'if grep -qxF "$k" ~/.ssh/authorized_keys; then',
  `  echo ${MARKER_ALREADY_PRESENT}`,
  'else',
  `  printf '%s\\n' "$k" >> ~/.ssh/authorized_keys && echo ${MARKER_INSTALLED}`,
  'fi',
  '',
].join('\n');

export interface InstallResult {
  /** The key was appended by this run. */
  added: boolean;
  /** The key was already present, so nothing changed (AC7.3). */
  alreadyPresent: boolean;
}

export class RemoteInstallError extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutText: string;
  readonly stderrText: string;

  constructor(
    message: string,
    detail: {
      exitCode?: number | null;
      signal?: string | null;
      stdoutText?: string;
      stderrText?: string;
    } = {},
  ) {
    super(message);
    this.name = 'RemoteInstallError';
    this.exitCode = detail.exitCode ?? null;
    this.signal = detail.signal ?? null;
    this.stdoutText = detail.stdoutText ?? '';
    this.stderrText = detail.stderrText ?? '';
  }
}

/** Last non-empty line of `text`, trimmed. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

/**
 * Run the §5.7 script over `conn`, feeding `publicKeyLine` on stdin.
 *
 * Resolves with which branch the script took. Rejects with
 * {@link RemoteInstallError} on a non-zero exit, an unrecognised marker, or a
 * channel failure - `setup` treats any of those as "nothing was installed" and
 * rolls back (AC7.5).
 */
export async function installAuthorizedKey(
  conn: Client,
  publicKeyLine: string,
): Promise<InstallResult> {
  const line = publicKeyLine.trim();
  if (line === '') throw new RemoteInstallError('refusing to install an empty public key line');
  if (line.includes('\n')) {
    throw new RemoteInstallError('a public key line must not contain a newline');
  }

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    conn.exec(AUTHORIZED_KEYS_SCRIPT, (err, channel) => {
      if (err) {
        reject(new RemoteInstallError(`could not start the install script: ${err.message}`));
        return;
      }
      resolve(channel);
    });
  });

  return new Promise<InstallResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let signal: string | null = null;
    let settled = false;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(
        new RemoteInstallError(message, {
          exitCode,
          signal,
          stdoutText: stdout,
          stderrText: stderr,
        }),
      );
    };

    stream.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    stream.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    stream.on('exit', (code: number | null, sig?: string | null) => {
      exitCode = typeof code === 'number' ? code : null;
      signal = sig ?? null;
    });
    stream.on('error', (err: Error) => {
      fail(`install script channel failed: ${err.message}`);
    });
    stream.on('close', () => {
      if (settled) return;
      if (exitCode !== 0) {
        fail(
          `install script exited with ${exitCode === null ? `signal ${signal ?? 'unknown'}` : `code ${String(exitCode)}`}`,
        );
        return;
      }
      const marker = lastLine(stdout);
      if (marker === MARKER_INSTALLED) {
        settled = true;
        resolve({ added: true, alreadyPresent: false });
        return;
      }
      if (marker === MARKER_ALREADY_PRESENT) {
        settled = true;
        resolve({ added: false, alreadyPresent: true });
        return;
      }
      fail(`install script produced no recognisable result marker (last line: "${marker}")`);
    });

    // The script blocks on `k=$(cat)` until stdin closes.
    stream.write(`${line}\n`);
    stream.end();
  });
}
