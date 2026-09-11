import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TOKENS,
  TOKEN_TTL_MS,
  clearTokens,
  consumeToken,
  issueToken,
  stopSweep,
  tokenHashPrefix,
  tokenStoreSize,
} from '../../src/safety/tokens.js';
import type { TokenBinding } from '../../src/safety/tokens.js';

const BINDING: TokenBinding = {
  toolName: 'exec',
  hostAlias: 'prod-web',
  sessionId: null,
  command: 'rm -rf /var/www/releases/2024',
};

afterEach(() => {
  clearTokens();
  vi.useRealTimers();
});

afterAll(() => {
  stopSweep();
});

describe('issue', () => {
  it('returns 43 base64url characters (32 random bytes)', () => {
    const token = issueToken(BINDING);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => issueToken(BINDING)));
    expect(tokens.size).toBe(50);
  });

  it('exposes only a hash prefix for logging (AC19.3)', () => {
    const token = issueToken(BINDING);
    const prefix = tokenHashPrefix(token);
    expect(prefix).toHaveLength(8);
    expect(token).not.toContain(prefix);
  });
});

describe('consume', () => {
  it('accepts the matching binding once', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, BINDING)).toBe('ok');
  });

  it('refuses a second use (AC17.3)', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, BINDING)).toBe('ok');
    expect(consumeToken(token, BINDING)).toBe('used');
  });

  it('refuses a token it never issued', () => {
    expect(consumeToken('a'.repeat(43), BINDING)).toBe('invalid');
    expect(consumeToken('', BINDING)).toBe('invalid');
  });

  it('refuses a one-byte command change (AC17.4)', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, { ...BINDING, command: `${BINDING.command} ` })).toBe('mismatch');
  });

  it('refuses a different host (AC17.6)', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, { ...BINDING, hostAlias: 'staging' })).toBe('mismatch');
  });

  it('refuses a different tool', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, { ...BINDING, toolName: 'run_in_session' })).toBe('mismatch');
  });

  it('refuses a different session', () => {
    const token = issueToken({ ...BINDING, sessionId: 'sess-1' });
    expect(consumeToken(token, { ...BINDING, sessionId: 'sess-2' })).toBe('mismatch');
  });

  it('spends the token even on a mismatch', () => {
    const token = issueToken(BINDING);
    expect(consumeToken(token, { ...BINDING, hostAlias: 'staging' })).toBe('mismatch');
    expect(consumeToken(token, BINDING)).toBe('used');
  });

  it('refuses after the TTL (AC17.5)', () => {
    vi.useFakeTimers();
    const token = issueToken(BINDING);
    vi.advanceTimersByTime(TOKEN_TTL_MS + 1);
    expect(consumeToken(token, BINDING)).toBe('expired');
  });

  it('still accepts just inside the TTL', () => {
    vi.useFakeTimers();
    const token = issueToken(BINDING);
    vi.advanceTimersByTime(TOKEN_TTL_MS - 1000);
    expect(consumeToken(token, BINDING)).toBe('ok');
  });
});

describe('store bounds', () => {
  it(`evicts the oldest entry past ${String(MAX_TOKENS)} tokens`, () => {
    const first = issueToken(BINDING);
    for (let i = 0; i < MAX_TOKENS; i += 1) {
      issueToken({ ...BINDING, command: `echo ${String(i)}` });
    }
    expect(tokenStoreSize()).toBe(MAX_TOKENS);
    expect(consumeToken(first, BINDING)).toBe('invalid');
  });

  it('drops expired entries on the next issue', () => {
    vi.useFakeTimers();
    issueToken(BINDING);
    expect(tokenStoreSize()).toBe(1);
    vi.advanceTimersByTime(TOKEN_TTL_MS + 1);
    issueToken({ ...BINDING, command: 'echo later' });
    expect(tokenStoreSize()).toBe(1);
  });

  it('issues nothing on its own', () => {
    expect(tokenStoreSize()).toBe(0);
  });
});
