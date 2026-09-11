/**
 * `download` (plan row 4.6, AC13.2).
 *
 * Refuses to replace an existing local file unless `overwrite` says so. The
 * caller always knows whether it meant to replace the file, and a silent
 * overwrite of local data cannot be undone.
 */
import { z } from 'zod';

import { toToolResult } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { download } from '../ssh/sftp.js';
import { connectHost, fallbackOf, requireHost, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import type { AuditDraft } from './wrap.js';

export const DOWNLOAD_DESCRIPTION =
  '원격 파일을 로컬 경로로 SFTP 전송한다. 로컬에 같은 경로가 있으면 기본적으로 실패하며, ' +
  '덮어쓰려면 `overwrite: true`를 넘긴다.';

export const downloadShape = {
  host: z.string().describe('list_hosts가 반환한 호스트 alias.'),
  remote_path: z.string().describe('가져올 원격 파일 경로.'),
  local_path: z
    .string()
    .describe('저장할 로컬 경로. 상위 디렉터리를 자동으로 만들지 않으므로 이미 존재해야 한다.'),
  overwrite: z
    .boolean()
    .optional()
    .describe('true면 이미 있는 로컬 파일을 덮어쓴다. 생략하면 local_file_exists 오류가 난다.'),
};

const downloadArgs = z.object(downloadShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = downloadArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);
  audit.host = host.alias;
  audit.approval_mode = host.approvalMode;
  audit.approval_fallback = fallbackOf(host);
  audit.audit_mode = host.auditMode;

  const conn = await connectHost(host);
  const started = Date.now();
  try {
    const result = await download(conn, args.remote_path, args.local_path, {
      ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
    });
    return toToolResult({ host: host.alias, ...result, overwritten: args.overwrite === true });
  } finally {
    audit.exec_duration_ms = Date.now() - started;
  }
}

export const downloadTool: ToolDefinition = {
  name: 'download',
  description: DOWNLOAD_DESCRIPTION,
  inputSchema: downloadShape,
  handler,
};
