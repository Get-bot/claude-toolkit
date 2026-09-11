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
import { TOOL_DESCRIPTION_APPROVAL_RULE } from '../safety/approval.js';
import { download } from '../ssh/sftp.js';
import { connectHost, requireHost, requireLocalPathAllowed, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import { approveFileOperation } from './gated.js';
import { applyHostToAudit, type AuditDraft } from './wrap.js';

export const DOWNLOAD_DESCRIPTION = [
  '원격 파일을 로컬 경로로 SFTP 전송한다.',
  '로컬에 같은 경로가 있으면 기본적으로 실패하며, 덮어쓰려면 `overwrite: true`를 넘긴다.',
  '전송은 호스트의 승인 모드를 따르며, `overwrite: true`는 파괴적 등급으로 분류된다.',
  `**${TOOL_DESCRIPTION_APPROVAL_RULE}**`,
  'ssh-mcp 설정 디렉터리(~/.ssh-mcp) 안의 경로에는 내려받을 수 없다.',
].join(' ');

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
  confirmation_token: z
    .string()
    .optional()
    .describe(
      'confirmation_required 응답으로 받은 토큰. 사용자에게 전송 내용을 보여주고 승인을 받은 뒤에만 붙일 것.'
    ),
};

const downloadArgs = z.object(downloadShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = downloadArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);
  applyHostToAudit(audit, host);

  // Before the gate and before any connection: writing into `~/.ssh-mcp` would
  // let a download rewrite the registry this server enforces approvals from, so
  // it is refused outright rather than offered for approval (F1).
  const localPath = requireLocalPathAllowed(args.local_path, '내려받기');

  // Overwriting a local file cannot be undone, so that case is `destructive`;
  // a plain download only creates a new file and is `privileged` (F1).
  const overwrite = args.overwrite === true;
  const decision = await approveFileOperation({
    toolName: 'download',
    host,
    grade: overwrite ? 'destructive' : 'privileged',
    description: `download ${host.alias}:${args.remote_path} -> ${localPath}${
      overwrite ? ' (overwrite)' : ''
    }`,
    confirmationToken: args.confirmation_token,
    ctx,
    audit,
  });
  if (!decision.allowed) return decision.result;

  const conn = await connectHost(host);
  const started = Date.now();
  try {
    const result = await download(conn, args.remote_path, localPath, { overwrite });
    return toToolResult({ host: host.alias, ...result, overwritten: overwrite });
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
