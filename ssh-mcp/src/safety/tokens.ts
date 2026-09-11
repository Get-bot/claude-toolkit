/**
 * Confirmation token store (plan row 2.9, AC17.3-AC17.6).
 *
 * A token is 32 random bytes, base64url, handed out exactly once and bound to
 * the tool, host, session and command it was issued for. Nothing but the SHA-256
 * of the token is kept, so a leaked store cannot be replayed, and the raw token
 * never reaches a log (AC19.3 — only the first 8 hex characters of the hash).
 *
 * A consumed token is remembered as a tombstone for the rest of its TTL so the
 * second call can answer `used` rather than the indistinguishable `invalid`
 * (AC17.3).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** TTL, matched to the elicitation timeout in §5.5 so both paths expire alike. */
export const TOKEN_TTL_MS = 300_000;
export const TOKEN_TTL_SEC = TOKEN_TTL_MS / 1000;
/** Oldest entry is evicted past this size (plan row 2.9). */
export const MAX_TOKENS = 100;
export const SWEEP_INTERVAL_MS = 60_000;
/** 32 random bytes render as 43 base64url characters. */
export const TOKEN_BYTES = 32;

export interface TokenBinding {
  toolName: string;
  hostAlias: string;
  sessionId: string | null;
  command: string;
}

export type ConsumeResult = 'ok' | 'invalid' | 'used' | 'expired' | 'mismatch';

interface TokenEntry {
  tokenHash: Buffer;
  commandHash: Buffer;
  toolName: string;
  hostAlias: string;
  sessionId: string | null;
  expiresAt: number;
}

const active = new Map<string, TokenEntry>();
const consumed = new Map<string, number>();

let sweepTimer: NodeJS.Timeout | null = null;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function key(tokenHash: Buffer): string {
  return tokenHash.toString('hex');
}

/** First 8 hex characters of the token hash — the only form we ever log. */
export function tokenHashPrefix(token: string): string {
  return key(sha256(token)).slice(0, 8);
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sweep(now: number = Date.now()): void {
  for (const [hash, entry] of active) {
    if (entry.expiresAt <= now) active.delete(hash);
  }
  for (const [hash, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(hash);
  }
}

/**
 * Start the periodic sweep. `unref()` so a server or a test process is never
 * held open by it; expiry is also checked on every consume, so the sweep is
 * only there to bound memory.
 */
export function startSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    sweep();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopSweep(): void {
  if (sweepTimer === null) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Drop every token. Tests only. */
export function clearTokens(): void {
  active.clear();
  consumed.clear();
}

export function tokenStoreSize(): number {
  return active.size;
}

/** Issue a token bound to `binding`. Single use, {@link TOKEN_TTL_MS} lifetime. */
export function issueToken(binding: TokenBinding): string {
  startSweep();
  const now = Date.now();
  sweep(now);

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = sha256(token);

  while (active.size >= MAX_TOKENS) {
    // Map iteration order is insertion order, so the first key is the oldest.
    const oldest = active.keys().next();
    if (oldest.done === true) break;
    active.delete(oldest.value);
  }

  active.set(key(tokenHash), {
    tokenHash,
    commandHash: sha256(binding.command),
    toolName: binding.toolName,
    hostAlias: binding.hostAlias,
    sessionId: binding.sessionId,
    expiresAt: now + TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Spend a token.
 *
 * A token is removed on any outcome other than `invalid`/`used`, including
 * `mismatch`: a token presented against the wrong command has been handled by
 * something that did not respect the binding, and re-offering it would let that
 * caller retry until it guessed right. The user re-approves instead.
 */
export function consumeToken(token: string, binding: TokenBinding): ConsumeResult {
  if (token === '') return 'invalid';
  const presented = sha256(token);
  const hash = key(presented);

  const entry = active.get(hash);
  if (entry === undefined) {
    return consumed.has(hash) ? 'used' : 'invalid';
  }
  if (!equal(entry.tokenHash, presented)) return 'invalid';

  const now = Date.now();
  active.delete(hash);
  if (entry.expiresAt <= now) return 'expired';
  consumed.set(hash, entry.expiresAt);

  if (entry.toolName !== binding.toolName) return 'mismatch';
  if (entry.hostAlias !== binding.hostAlias) return 'mismatch';
  if (entry.sessionId !== binding.sessionId) return 'mismatch';
  if (!equal(entry.commandHash, sha256(binding.command))) return 'mismatch';
  return 'ok';
}
