/**
 * The TCP reachability check (`src/ssh/reach.ts`).
 *
 * It exists so a mistyped hostname costs a second instead of a password, an
 * ACL pass and a generated key pair. Two properties matter: it must never
 * throw — every caller wants to report the failure, not unwind — and the
 * reason it reports must be a sentence rather than `getaddrinfo ENOTFOUND`.
 */
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { REACH_TIMEOUT_MS, describeReachFailure, probeTcp } from '../../src/ssh/reach.js';
import type { Lookup } from '../../src/ssh/reach.js';

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

/** A listening socket on a free port, closed by the hook above. */
async function listening(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('probeTcp', () => {
  it('succeeds against something that is listening', async () => {
    const port = await listening();
    const result = await probeTcp('127.0.0.1', port, 2000);
    expect(result).toEqual({ ok: true, code: '', reason: '' });
  });

  it('reports a closed port in words, without throwing', async () => {
    // Bind then release, so the port is almost certainly free and refusing.
    const port = await listening();
    await new Promise<void>((resolve) => {
      const server = servers.pop();
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    const result = await probeTcp('127.0.0.1', port, 2000);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBe('');
    // Windows can answer ECONNREFUSED or time out; both are reported, neither throws.
    expect(['ECONNREFUSED', 'ETIMEDOUT']).toContain(result.code);
  });

  // The resolver is injected rather than exercised: a real lookup of a
  // `.invalid` name resolves on a network with wildcard DNS or a captive
  // portal, and the test would then fail for reasons of its own.
  it('reports an unresolvable name as a name problem', async () => {
    const notFound: Lookup = (hostname, _options, callback) => {
      const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      (callback as (error: NodeJS.ErrnoException) => void)(err);
    };
    const result = await probeTcp('no-such-host.invalid', 22, 3000, notFound);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ENOTFOUND');
    expect(result.reason).toContain('호스트 이름을 찾을 수 없습니다');
  });

  it('times out rather than hanging', async () => {
    // 203.0.113.0/24 is reserved for documentation and routes nowhere.
    const result = await probeTcp('203.0.113.1', 22, 150);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBe('');
  });
});

describe('describeReachFailure', () => {
  it('translates the codes a user actually hits', () => {
    expect(describeReachFailure('ENOTFOUND', '')).toContain('호스트 이름을 찾을 수 없습니다');
    expect(describeReachFailure('ECONNREFUSED', '')).toContain('포트가 닫혀 있습니다');
    expect(describeReachFailure('ETIMEDOUT', '')).toContain('응답이 없습니다');
    expect(describeReachFailure('EHOSTUNREACH', '')).toContain('네트워크에 도달할 수 없습니다');
  });

  it('keeps the original message for anything it does not know', () => {
    expect(describeReachFailure('EWEIRD', 'something odd')).toContain('something odd');
    expect(describeReachFailure('', '')).toBe('연결할 수 없습니다');
  });

  it('shares the budget doctor uses for a host probe', () => {
    expect(REACH_TIMEOUT_MS).toBe(5000);
  });
});
