/**
 * Per-alias connection pool (plan row 3.2, AC9.1, AC9.2).
 *
 * One ssh2 `Client` per host alias, reused by every tool call and by every
 * session on that host, closed after ten idle minutes. Two calls that race for
 * the same alias share one handshake instead of opening two.
 *
 * The host key pin is enforced in `hostVerifier`. `hostHash` is left unset so
 * the callback receives the raw key blob; see `fingerprint.ts` for why. When
 * the pin does not match we call `verify(false)`, which makes ssh2 fail the key
 * exchange — so the client never authenticates and never opens a channel. That
 * is what makes "no command is sent on a fingerprint mismatch" (AC9.2) a
 * property of the protocol rather than of our control flow.
 */
import { Client, type ConnectConfig } from 'ssh2';

import { ERROR_CODES } from '../errors.js';
import { logger } from '../log.js';
import type { HostEntry } from '../config/schema.js';
import { SshOperationError, errorMessage } from './error.js';
import { fingerprintsMatch, sha256Fingerprint } from './fingerprint.js';

/** A registry entry plus the alias it was stored under. */
export type PoolHost = HostEntry & { alias: string };

/** Idle time after which a pooled connection is closed (§5.1). */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** Handshake budget for a new connection. */
export const DEFAULT_READY_TIMEOUT_MS = 15000;

interface PoolEntry {
  alias: string;
  client: Client;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** Fingerprint this connection was actually verified against (F14). */
  pinnedFingerprint: string;
}

interface PendingConnect {
  promise: Promise<Client>;
  pinnedFingerprint: string;
}

interface PoolConfig {
  idleMs: number;
  readyTimeoutMs: number;
}

const config: PoolConfig = {
  idleMs: DEFAULT_IDLE_MS,
  readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
};

const entries = new Map<string, PoolEntry>();
const pending = new Map<string, PendingConnect>();

/** Override timings. Tests inject short values; production uses the defaults. */
export function configurePool(overrides: Partial<PoolConfig>): void {
  if (overrides.idleMs !== undefined) config.idleMs = overrides.idleMs;
  if (overrides.readyTimeoutMs !== undefined) config.readyTimeoutMs = overrides.readyTimeoutMs;
}

function clearIdleTimer(entry: PoolEntry): void {
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function armIdleTimer(entry: PoolEntry): void {
  clearIdleTimer(entry);
  const timer = setTimeout(() => {
    logger.debug('closing idle ssh connection', { alias: entry.alias });
    dropEntry(entry, 'idle');
  }, config.idleMs);
  timer.unref();
  entry.idleTimer = timer;
}

function dropEntry(entry: PoolEntry, reason: string): void {
  if (entry.closed) return;
  entry.closed = true;
  clearIdleTimer(entry);
  if (entries.get(entry.alias) === entry) entries.delete(entry.alias);
  try {
    entry.client.end();
  } catch (err) {
    logger.debug('ssh client end() failed', {
      alias: entry.alias,
      reason,
      error: errorMessage(err),
    });
  }
}

/**
 * Mark an alias as used, restarting its idle countdown. Call it whenever a
 * channel is opened on a pooled connection so that a busy session is not
 * reaped underneath itself.
 */
export function touchConnection(alias: string): void {
  const entry = entries.get(alias);
  if (entry !== undefined && !entry.closed) armIdleTimer(entry);
}

function connect(host: PoolHost, privateKey: Buffer): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let mismatch: { expected: string; actual: string } | null = null;
    let settled = false;

    const finish = (err: SshOperationError | null): void => {
      if (settled) return;
      settled = true;
      if (err === null) {
        resolve(client);
        return;
      }
      try {
        client.end();
      } catch {
        // The connection is already broken; nothing to salvage.
      }
      reject(err);
    };

    client.on('ready', () => {
      finish(null);
    });

    client.on('error', (err: Error & { level?: string }) => {
      if (mismatch !== null) {
        finish(
          new SshOperationError(
            ERROR_CODES.host_key_mismatch,
            `host key for "${host.alias}" does not match the pinned fingerprint`,
            {
              host: host.alias,
              expected_fingerprint: mismatch.expected,
              actual_fingerprint: mismatch.actual,
            }
          )
        );
        return;
      }
      const level = err.level ?? 'unknown';
      if (level === 'client-authentication') {
        finish(
          new SshOperationError(
            ERROR_CODES.auth_failed,
            `public key authentication failed for ${host.user}@${host.hostname}`,
            { host: host.alias, level }
          )
        );
        return;
      }
      finish(
        new SshOperationError(
          ERROR_CODES.connection_failed,
          `could not connect to ${host.hostname}:${String(host.port)}: ${err.message}`,
          { host: host.alias, level, reason: err.message }
        )
      );
    });

    client.on('close', () => {
      finish(
        new SshOperationError(
          ERROR_CODES.connection_failed,
          `connection to ${host.hostname}:${String(host.port)} closed during handshake`,
          { host: host.alias }
        )
      );
    });

    const connectConfig: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.user,
      privateKey,
      readyTimeout: config.readyTimeoutMs,
      // No `hostHash`: the verifier wants the raw blob (see fingerprint.ts).
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
        const actual = sha256Fingerprint(key);
        if (!fingerprintsMatch(actual, host.hostKey.sha256)) {
          mismatch = { expected: host.hostKey.sha256, actual };
          verify(false);
          return;
        }
        verify(true);
      },
    };

    try {
      client.connect(connectConfig);
    } catch (err) {
      finish(
        new SshOperationError(ERROR_CODES.connection_failed, errorMessage(err), {
          host: host.alias,
        })
      );
    }
  });
}

/**
 * Connection for `host`, reusing the pooled one when it is still open.
 *
 * `privateKey` is the decrypted private key bytes; it is never logged and
 * never stored beyond the ssh2 client that needs it.
 */
export async function getConnection(host: PoolHost, privateKey: Buffer): Promise<Client> {
  const pinnedFingerprint = host.hostKey.sha256;

  const existing = entries.get(host.alias);
  if (existing !== undefined && !existing.closed) {
    // A re-pinned host must take effect at once. Reusing a connection opened
    // against the old fingerprint would keep talking to the very server the
    // operator just stopped trusting, for up to the idle timeout (F14).
    if (existing.pinnedFingerprint === pinnedFingerprint) {
      armIdleTimer(existing);
      return existing.client;
    }
    logger.info('host key pin changed; reconnecting', { alias: host.alias });
    dropEntry(existing, 'pin changed');
  }

  const inFlight = pending.get(host.alias);
  if (inFlight !== undefined && inFlight.pinnedFingerprint === pinnedFingerprint) {
    return inFlight.promise;
  }

  const attempt = connect(host, privateKey)
    .then((client) => {
      const entry: PoolEntry = {
        alias: host.alias,
        client,
        idleTimer: null,
        closed: false,
        pinnedFingerprint,
      };
      entries.set(host.alias, entry);
      armIdleTimer(entry);
      client.on('close', () => {
        dropEntry(entry, 'closed by peer');
      });
      client.on('error', (err: Error) => {
        logger.debug('ssh connection error after ready', {
          alias: host.alias,
          error: err.message,
        });
        dropEntry(entry, 'error');
      });
      return client;
    })
    .finally(() => {
      const current = pending.get(host.alias);
      if (current !== undefined && current.promise === attempt) pending.delete(host.alias);
    });

  pending.set(host.alias, { promise: attempt, pinnedFingerprint });
  return attempt;
}

/** True when `alias` currently holds an open connection. */
export function hasConnection(alias: string): boolean {
  const entry = entries.get(alias);
  return entry !== undefined && !entry.closed;
}

/** Close the connection for one alias, if any. */
export function closeConnection(alias: string): void {
  const entry = entries.get(alias);
  if (entry !== undefined) dropEntry(entry, 'explicit close');
}

/** Close every pooled connection. Used on shutdown and between tests. */
export function closeAll(): void {
  for (const entry of Array.from(entries.values())) {
    dropEntry(entry, 'close all');
  }
  entries.clear();
}
