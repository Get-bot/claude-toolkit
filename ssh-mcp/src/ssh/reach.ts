/**
 * "Can we even open a socket to this host?" — asked before anything expensive.
 *
 * `host add` used to take the password, harden the Windows ACL and generate a
 * key pair before the first connection attempt, so a typo in the hostname cost
 * the user all of that and then failed with `getaddrinfo ENOTFOUND`. A TCP
 * connect answers the same question in milliseconds and costs nothing, so it
 * goes first.
 *
 * **This is not a security step and does not replace one.** It stops at the
 * three-way handshake: no SSH banner, no key exchange, no host-key fingerprint.
 * Everything that decides trust — the fingerprint shown for a typed `yes`, the
 * password sent only after that — happens exactly where it did before. All this
 * adds is "is anything listening", ahead of the work.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import net from 'node:net';

/** Budget for one reachability check. Matches `doctor`'s host probe. */
export const REACH_TIMEOUT_MS = 5000;

export interface ReachResult {
  ok: boolean;
  /** Node's error code when there was one: `ENOTFOUND`, `ECONNREFUSED`, … */
  code: string;
  /** One sentence the user can act on. Empty when {@link ok}. */
  reason: string;
}

/**
 * Name resolution, in the shape `net.connect` expects.
 *
 * Injectable so a test can produce `ENOTFOUND` without a resolver. A test that
 * relied on a real lookup of a `.invalid` name would pass or fail depending on
 * whether the network answers wildcards — a captive portal or a wildcard DNS
 * would resolve it and the test would break for reasons of its own.
 */
export type Lookup = NonNullable<net.TcpNetConnectOpts['lookup']>;

export type TcpProbe = (
  host: string,
  port: number,
  timeoutMs?: number,
  lookup?: Lookup
) => Promise<ReachResult>;

/**
 * Turn a socket error into something worth reading.
 *
 * `getaddrinfo ENOTFOUND web01` tells a developer what happened and tells
 * everybody else nothing, so the code is translated and kept alongside for the
 * cases this list does not cover.
 */
export function describeReachFailure(code: string, message: string): string {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '호스트 이름을 찾을 수 없습니다 (주소 오타나 DNS를 확인하세요)';
    case 'ECONNREFUSED':
      return '포트가 닫혀 있습니다 (sshd가 떠 있는지, 포트 번호가 맞는지 확인하세요)';
    case 'ETIMEDOUT':
      return '응답이 없습니다 (방화벽·네트워크를 확인하세요)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '네트워크에 도달할 수 없습니다';
    case 'ECONNRESET':
      return '연결이 끊겼습니다';
    default:
      return message === '' ? '연결할 수 없습니다' : `연결할 수 없습니다 (${message})`;
  }
}

/**
 * Open a TCP connection and close it again.
 *
 * Resolves either way; a failure is data, never a throw, because every caller
 * wants to report it rather than unwind.
 */
export const probeTcp: TcpProbe = (host, port, timeoutMs = REACH_TIMEOUT_MS, lookup) =>
  new Promise<ReachResult>((resolve) => {
    let settled = false;
    const socket = new net.Socket();

    const finish = (result: ReachResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({ ok: true, code: '', reason: '' });
    });
    socket.once('timeout', () => {
      finish({
        ok: false,
        code: 'ETIMEDOUT',
        reason: describeReachFailure('ETIMEDOUT', ''),
      });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      finish({ ok: false, code, reason: describeReachFailure(code, err.message) });
    });

    socket.connect(lookup === undefined ? { host, port } : { host, port, lookup });
  });
