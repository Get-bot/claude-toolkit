/**
 * `list_hosts` (plan row 4.3, AC2.2).
 *
 * Returns what the model needs to call the other six tools and nothing more.
 * The private key path and the full host key fingerprint stay out: the model
 * has no use for either, and a fingerprint prefix is enough for a person to
 * recognise a host they pinned.
 */
import { z } from 'zod';

import { fallbackOf, requireConfig, type ToolContext } from './context.js';
import { toToolResult } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import type { ToolDefinition } from './define.js';
import type { AuditDraft } from './wrap.js';

export const LIST_HOSTS_DESCRIPTION =
  '등록된 SSH 호스트의 alias, 접속 정보, 승인 모드, 승인 폴백을 반환한다. ' +
  '다른 도구에 넘길 `host` 값을 여기서 확인한다. 비밀키 경로와 호스트 키 지문 전문은 반환하지 않는다.';

/** Characters of the base64 fingerprint kept for display. */
export const FINGERPRINT_PREFIX_CHARS = 16;

export function fingerprintPrefix(sha256: string): string {
  const body = sha256.startsWith('SHA256:') ? sha256.slice('SHA256:'.length) : sha256;
  return `SHA256:${body.slice(0, FINGERPRINT_PREFIX_CHARS)}`;
}

/** No arguments: an explicit empty object schema, not an absent one. */
export const listHostsShape = {};

const listHostsArgs = z.object(listHostsShape);

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
  _audit: AuditDraft
): Promise<ToolTextResult> {
  listHostsArgs.parse(args);
  const config = requireConfig(ctx.loadConfig());

  const hosts = Object.entries(config.file.hosts).map(([alias, entry]) => ({
    alias,
    hostname: entry.hostname,
    port: entry.port,
    user: entry.user,
    approval_mode: entry.approvalMode,
    approval_fallback: fallbackOf(entry),
    audit_mode: entry.auditMode,
    host_key_fingerprint_prefix: fingerprintPrefix(entry.hostKey.sha256),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  }));

  return toToolResult({ hosts, count: hosts.length });
}

export const listHostsTool: ToolDefinition = {
  name: 'list_hosts',
  description: LIST_HOSTS_DESCRIPTION,
  inputSchema: listHostsShape,
  handler,
};
