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
import { TOOL_DESCRIPTION_APPROVAL_RULE } from '../safety/approval.js';
import { upload } from '../ssh/sftp.js';
import { connectHost, requireHost, requireLocalPathAllowed, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import { approveFileOperation } from './gated.js';
import { applyHostToAudit, type AuditDraft } from './wrap.js';

export const UPLOAD_DESCRIPTION = [
  '로컬 파일을 원격 경로로 SFTP 전송한다. 원격에 같은 경로가 있으면 덮어쓴다.',
  '전송은 호스트의 승인 모드를 따르며 관리자 등급으로 분류된다.',
  `**${TOOL_DESCRIPTION_APPROVAL_RULE}**`,
  'ssh-mcp 설정 디렉터리(~/.ssh-mcp) 안의 파일은 전송할 수 없다.',
].join(' ');

export const uploadShape = {
  host: z.string().describe('list_hosts가 반환한 호스트 alias.'),
  local_path: z.string().describe('전송할 로컬 파일 경로. 일반 파일이어야 한다.'),
  remote_path: z
    .string()
    .describe('원격 대상 경로. 상위 디렉터리를 자동으로 만들지 않으므로 이미 존재해야 한다.'),
  confirmation_token: z
    .string()
    .optional()
    .describe(
      'confirmation_required 응답으로 받은 토큰. 사용자에게 전송 내용을 보여주고 승인을 받은 뒤에만 붙일 것.'
    ),
};

const uploadArgs = z.object(uploadShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = uploadArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);
  applyHostToAudit(audit, host);

  // Before the gate and before any connection: a path inside `~/.ssh-mcp` is
  // refused outright, never offered for approval (F1, F15).
  const localPath = requireLocalPathAllowed(args.local_path, '업로드');

  // An upload writes on the remote host and can carry a local secret off this
  // one, so it is `privileged` and goes through the same approval as a command
  // (F1). The resolved local path is what the person is shown and what the
  // confirmation token binds to.
  const decision = await approveFileOperation({
    toolName: 'upload',
    host,
    grade: 'privileged',
    description: `upload ${localPath} -> ${host.alias}:${args.remote_path}`,
    confirmationToken: args.confirmation_token,
    ctx,
    audit,
  });
  if (!decision.allowed) return decision.result;

  const conn = await connectHost(host);
  const started = Date.now();
  try {
    const result = await upload(conn, localPath, args.remote_path);
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
