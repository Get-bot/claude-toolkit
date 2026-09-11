/**
 * `upload` (plan row 4.5, AC13).
 *
 * SFTP only, no shell, so there is nothing to classify: the approval gate is
 * about command grades and this tool runs no command. The overwrite asymmetry
 * with `download` is deliberate and documented in both descriptions — the
 * remote side is the working copy, the local side is the one a mistake cannot
 * be undone on.
 */
import { z } from 'zod';

import { toToolResult } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { upload } from '../ssh/sftp.js';
import { connectHost, fallbackOf, requireHost, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import type { AuditDraft } from './wrap.js';

export const UPLOAD_DESCRIPTION =
  '로컬 파일을 원격 경로로 SFTP 전송한다. 원격에 같은 경로가 있으면 덮어쓴다.';

export const uploadShape = {
  host: z.string().describe('list_hosts가 반환한 호스트 alias.'),
  local_path: z.string().describe('전송할 로컬 파일 경로. 일반 파일이어야 한다.'),
  remote_path: z
    .string()
    .describe('원격 대상 경로. 상위 디렉터리를 자동으로 만들지 않으므로 이미 존재해야 한다.'),
};

const uploadArgs = z.object(uploadShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = uploadArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);
  audit.host = host.alias;
  audit.approval_mode = host.approvalMode;
  audit.approval_fallback = fallbackOf(host);
  audit.audit_mode = host.auditMode;

  const conn = await connectHost(host);
  const started = Date.now();
  try {
    const result = await upload(conn, args.local_path, args.remote_path);
    return toToolResult({ host: host.alias, ...result });
  } finally {
    audit.exec_duration_ms = Date.now() - started;
  }
}

export const uploadTool: ToolDefinition = {
  name: 'upload',
  description: UPLOAD_DESCRIPTION,
  inputSchema: uploadShape,
  handler,
};
