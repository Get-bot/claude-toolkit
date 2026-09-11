/**
 * In-process ssh2 server used by the integration suite (OPT-3 A, §6.2).
 *
 * It is a real SSH server speaking the real protocol, with `exec` and `shell`
 * channels bridged to a real shell child process. That combination is what
 * lets the same test body run on `windows-latest` and `ubuntu-latest` while
 * still proving things only a server can prove: which authentication methods
 * were attempted (AC8.1), that no command was sent after a fingerprint
 * mismatch (AC9.2), and that a timed-out channel was really closed (AC11.2).
 *
 * The shell bridge spawns the shell with no pty, exactly like production, so
 * the marker protocol is exercised against a genuine bash/dash/zsh rather than
 * a mock that always answers correctly.
 *
 * Child processes inherit an isolated `HOME`/`USERPROFILE` (Critic C7). Without
 * that, a `setup` test would append to the developer's own
 * `~/.ssh/authorized_keys`.
 */
import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  Server,
  utils,
  type AuthContext,
  type Connection,
  type ServerChannel,
  type Session,
} from 'ssh2';

import type { FixtureKeyPair } from './hostKeys.js';

const { STATUS_CODE } = utils.sftp;

export type FixtureEventType =
  | 'auth'
  | 'exec'
  | 'shell'
  | 'pty'
  | 'sftp'
  | 'signal'
  | 'channel-close'
  | 'connection-error';

export interface FixtureEvent {
  type: FixtureEventType;
  at: number;
  /** `auth`: the method the client offered. */
  method?: string;
  username?: string;
  accepted?: boolean;
  /** `exec`: the command line. */
  command?: string;
  /** `signal`: the signal name. */
  name?: string;
  /** `connection-error`: what ssh2 reported on the server side. */
  message?: string;
}

/** Deterministic canned reply for one exact command string. */
export interface ScriptedResponse {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  /** Delay before anything is written. */
  delayMs?: number;
  /** Never finish: used to force a timeout. */
  hang?: boolean;
}

/** Fake shells used to reach the `unsupported_shell` branches (AC14.5, AC14.6). */
export type ShellEmulation = 'fish' | 'cmd' | 'powershell' | 'silent';

export interface SshFixtureOptions {
  hostKey: FixtureKeyPair;
  user: string;
  password: string;
  /** Sandbox home: `authorized_keys` is read from `<homeDir>/.ssh`. */
  homeDir: string;
  /** Shell binary for bridged channels. Defaults to bash. */
  shellPath?: string;
  /**
   * Extra arguments for the `shell` channel, e.g. `['-e', '-u']` to reproduce
   * a login shell whose rc file turned those options on (F5, AC14.4).
   */
  shellArgs?: string[];
  /** Replace the shell bridge with a canned non-POSIX shell. */
  shellEmulation?: ShellEmulation;
  /** Commands answered without spawning anything. */
  scripted?: Record<string, ScriptedResponse>;
}

export interface SshFixture {
  host: string;
  port: number;
  /** Everything the server observed, in order. */
  events: FixtureEvent[];
  eventsOfType(type: FixtureEventType): FixtureEvent[];
  /** Shell binary in use, or `null` when emulating. */
  shellPath: string | null;
  homeDir: string;
  close(): Promise<void>;
}

const WINDOWS_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

/**
 * Absolute path of a POSIX shell, or `null` when it is not installed.
 *
 * On Windows the Git for Windows bash is the one CI has; `where` is consulted
 * first so a developer's own installation wins.
 */
export function resolveShellPath(name = 'bash'): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(finder, [name], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const first = found[0];
    if (first !== undefined && fs.existsSync(first)) return first;
  } catch {
    // Not on PATH; fall through to the well-known locations.
  }
  if (process.platform === 'win32' && name === 'bash') {
    for (const candidate of WINDOWS_BASH_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function childEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    // Stops MSYS from rewriting `/dev/null` and other absolute paths.
    MSYS_NO_PATHCONV: '1',
  };
}

function toBuffer(value: string | Buffer | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function emulatedShellReply(emulation: ShellEmulation, line: string): string | null {
  if (emulation === 'silent') return null;
  if (!line.includes('__SM_SH__')) return null;
  if (emulation === 'fish') return '__SM_SH__fish__\n';
  // cmd.exe does not expand `$0`; PowerShell expands it to nothing.
  if (emulation === 'cmd') return '__SM_SH__$0__\n';
  return '__SM_SH__\n';
}

/** Replace the shell child with a canned non-POSIX shell. */
function attachEmulatedShell(channel: ServerChannel, emulation: ShellEmulation): void {
  let buffered = '';
  channel.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const reply = emulatedShellReply(emulation, line);
      if (reply !== null) channel.write(reply);
      newline = buffered.indexOf('\n');
    }
  });
}

function bridgeChild(channel: ServerChannel, child: ChildProcessWithoutNullStreams): void {
  child.stdout.on('data', (chunk: Buffer) => {
    channel.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    channel.stderr.write(chunk);
  });

  const closeStdin = (): void => {
    try {
      child.stdin.end();
    } catch {
      // Already gone.
    }
  };
  channel.on('data', (chunk: Buffer) => {
    try {
      child.stdin.write(chunk);
    } catch {
      // The child exited while we were writing; nothing to recover.
    }
  });
  channel.on('end', closeStdin);
  channel.on('eof', closeStdin);
  channel.on('close', () => {
    if (child.exitCode === null) child.kill();
  });

  child.stdin.on('error', () => {
    // EPIPE when the command exits without reading stdin.
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    try {
      if (signal !== null) {
        channel.exit(signal.replace(/^SIG/, ''), false, '');
      } else {
        channel.exit(code ?? 0);
      }
      channel.end();
    } catch {
      // The channel may already be closed by the client.
    }
  });
}

function playScript(channel: ServerChannel, response: ScriptedResponse): void {
  const send = (): void => {
    const out = toBuffer(response.stdout);
    const err = toBuffer(response.stderr);
    if (out.length > 0) channel.write(out);
    if (err.length > 0) channel.stderr.write(err);
    if (response.hang === true) return;
    try {
      channel.exit(response.exitCode ?? 0);
      channel.end();
    } catch {
      // Client closed first.
    }
  };
  if (response.delayMs !== undefined && response.delayMs > 0) {
    const timer = setTimeout(send, response.delayMs);
    timer.unref();
    return;
  }
  send();
}

interface SftpHandle {
  fd: number;
  path: string;
}

/**
 * Minimal SFTP server backed by the real filesystem.
 *
 * `fastGet`/`fastPut` need OPEN, FSTAT (with STAT as a fallback), READ, WRITE
 * and CLOSE; the rest are here so a failing test reports a sensible error
 * instead of an unhandled request.
 */
function attachSftp(session: Session, events: FixtureEvent[]): void {
  session.on('sftp', (accept) => {
    events.push({ type: 'sftp', at: Date.now() });
    const sftp = accept();
    const handles = new Map<number, SftpHandle>();
    let nextHandle = 1;

    const handleBuffer = (id: number): Buffer => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(id, 0);
      return buf;
    };
    const lookup = (handle: Buffer): SftpHandle | undefined => {
      if (handle.length !== 4) return undefined;
      return handles.get(handle.readUInt32BE(0));
    };

    sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
      const mode = utils.sftp.flagsToString(flags);
      if (mode === null) {
        sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
        return;
      }
      fs.open(filename, mode, (err, fd) => {
        if (err !== null) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        const id = nextHandle;
        nextHandle += 1;
        handles.set(id, { fd, path: filename });
        sftp.handle(reqid, handleBuffer(id));
      });
    });

    sftp.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
      const entry = lookup(handle);
      if (entry === undefined) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      const buf = Buffer.alloc(length);
      fs.read(entry.fd, buf, 0, length, offset, (err, bytesRead) => {
        if (err !== null) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        if (bytesRead === 0) {
          sftp.status(reqid, STATUS_CODE.EOF);
          return;
        }
        sftp.data(reqid, buf.subarray(0, bytesRead));
      });
    });

    sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const entry = lookup(handle);
      if (entry === undefined) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      fs.write(entry.fd, data, 0, data.length, offset, (err) => {
        sftp.status(reqid, err === null ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
      });
    });

    const sendAttrs = (reqid: number, stats: fs.Stats): void => {
      sftp.attrs(reqid, {
        mode: stats.mode,
        uid: stats.uid,
        gid: stats.gid,
        size: stats.size,
        atime: Math.floor(stats.atimeMs / 1000),
        mtime: Math.floor(stats.mtimeMs / 1000),
      });
    };

    sftp.on('FSTAT', (reqid: number, handle: Buffer) => {
      const entry = lookup(handle);
      if (entry === undefined) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      fs.fstat(entry.fd, (err, stats) => {
        if (err !== null) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        sendAttrs(reqid, stats);
      });
    });

    const statPath = (reqid: number, target: string): void => {
      fs.stat(target, (err, stats) => {
        if (err !== null) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        sendAttrs(reqid, stats);
      });
    };
    sftp.on('STAT', statPath);
    sftp.on('LSTAT', statPath);

    sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
      const entry = lookup(handle);
      if (entry === undefined) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      handles.delete(handle.readUInt32BE(0));
      fs.close(entry.fd, () => {
        sftp.status(reqid, STATUS_CODE.OK);
      });
    });

    sftp.on('REMOVE', (reqid: number, target: string) => {
      fs.unlink(target, (err) => {
        sftp.status(reqid, err === null ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
      });
    });

    sftp.on('REALPATH', (reqid: number, target: string) => {
      const resolved = path.resolve(target);
      // REALPATH answers need no real attributes (SFTP.md), but the typings
      // require the full record, so a zeroed one is sent.
      sftp.name(reqid, [
        {
          filename: resolved,
          longname: resolved,
          attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
        },
      ]);
    });

    sftp.on('FSETSTAT', (reqid: number) => {
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });
}

function readAuthorizedKeys(homeDir: string): string[] {
  const file = path.join(homeDir, '.ssh', 'authorized_keys');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function publicKeyMatches(homeDir: string, ctx: AuthContext): boolean {
  if (ctx.method !== 'publickey') return false;
  for (const line of readAuthorizedKeys(homeDir)) {
    const parsed = utils.parseKey(line);
    if (parsed instanceof Error) continue;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key === undefined) continue;
    if (!key.getPublicSSH().equals(ctx.key.data)) continue;
    if (ctx.signature === undefined) return true; // validity probe, no signature yet
    return key.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) === true;
  }
  return false;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Start a fixture server on a random loopback port. */
export async function startSshFixture(options: SshFixtureOptions): Promise<SshFixture> {
  const events: FixtureEvent[] = [];
  const emulation = options.shellEmulation;
  const shellPath =
    emulation === undefined ? (options.shellPath ?? resolveShellPath('bash')) : null;

  if (emulation === undefined && shellPath === null) {
    throw new Error('no POSIX shell found for the ssh fixture (install Git for Windows bash)');
  }

  fs.mkdirSync(options.homeDir, { recursive: true });

  const handleConnection = (connection: Connection): void => {
    // A client that rejects the host key aborts the key exchange, and ssh2
    // emits that as 'error' on the server side. Without this listener an
    // EventEmitter turns it into an uncaught exception and fails the whole
    // test file, even though refusing a bad pin is the behaviour under test
    // (AC7.5, AC9, AC21.4).
    connection.on('error', (err: Error) => {
      events.push({ type: 'connection-error', at: Date.now(), message: err.message });
    });

    connection.on('authentication', (ctx: AuthContext) => {
      const usernameOk = constantTimeEquals(ctx.username, options.user);
      let accepted = false;
      if (usernameOk && ctx.method === 'password') {
        accepted = constantTimeEquals(ctx.password, options.password);
      } else if (usernameOk && ctx.method === 'publickey') {
        accepted = publicKeyMatches(options.homeDir, ctx);
      }
      events.push({
        type: 'auth',
        at: Date.now(),
        method: ctx.method,
        username: ctx.username,
        accepted,
      });
      if (accepted) ctx.accept();
      else ctx.reject(['password', 'publickey']);
    });

    connection.on('session', (acceptSession) => {
      const session = acceptSession();

      session.on('pty', (accept) => {
        events.push({ type: 'pty', at: Date.now() });
        if (typeof accept === 'function') accept();
      });

      session.on('signal', (accept, _reject, info) => {
        events.push({ type: 'signal', at: Date.now(), name: info.name });
        if (typeof accept === 'function') accept();
      });

      session.on('exec', (accept, _reject, info) => {
        events.push({ type: 'exec', at: Date.now(), command: info.command });
        const channel = accept();
        channel.on('close', () => {
          events.push({ type: 'channel-close', at: Date.now(), command: info.command });
        });

        const scripted = options.scripted?.[info.command];
        if (scripted !== undefined) {
          playScript(channel, scripted);
          return;
        }
        if (shellPath === null) {
          channel.stderr.write('no shell available\n');
          channel.exit(127);
          channel.end();
          return;
        }
        const child = spawn(shellPath, ['-c', info.command], {
          env: childEnv(options.homeDir),
          cwd: options.homeDir,
        });
        bridgeChild(channel, child);
      });

      session.on('shell', (accept) => {
        events.push({ type: 'shell', at: Date.now() });
        const channel = accept();
        channel.on('close', () => {
          events.push({ type: 'channel-close', at: Date.now() });
        });
        if (emulation !== undefined) {
          attachEmulatedShell(channel, emulation);
          return;
        }
        const child = spawn(shellPath as string, options.shellArgs ?? [], {
          env: childEnv(options.homeDir),
          cwd: options.homeDir,
        });
        bridgeChild(channel, child);
      });

      attachSftp(session, events);
    });
  };

  const server = new Server({ hostKeys: [options.hostKey.privateKey] }, handleConnection);

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('ssh fixture did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    host: '127.0.0.1',
    port,
    events,
    eventsOfType(type: FixtureEventType): FixtureEvent[] {
      return events.filter((event) => event.type === type);
    },
    shellPath,
    homeDir: options.homeDir,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
