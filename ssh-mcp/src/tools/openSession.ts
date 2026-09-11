/**
 * `open_session` (plan row 4.7, AC14, AC15.2, AC15.3).
 *
 * The handshake decides whether a session is possible at all: a fish, cmd or
 * PowerShell login shell comes back as `unsupported_shell` from the ssh layer,
 * with the alternatives and the classifier coverage attached, and no slot is
 * consumed.
 */
import { z } from 'zod';

import { toToolResult } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { openSession } from '../ssh/session.js';
import { connectHost, requireHost, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import { applyHostToAudit, type AuditDraft } from './wrap.js';

export const OPEN_SESSION_DESCRIPTION =
  '상태가 유지되는 원격 셸 세션을 열고 `session_id`를 반환한다. ' +
  '이후 `run_in_session` 호출들이 작업 디렉터리, 환경변수, 활성화한 가상환경을 공유한다. ' +
  '호스트당 최대 5개이며 30분간 쓰지 않으면 자동으로 닫힌다. 다 쓰면 `close_session`으로 닫는다.';

export const openSessionShape = {
  host: z.string().describe('list_hosts가 반환한 호스트 alias.'),
};

const openSessionArgs = z.object(openSessionShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = openSessionArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);
  applyHostToAudit(audit, host);

  const conn = await connectHost(host);
  const started = Date.now();
  try {
    const session = await openSession(host, conn);
    audit.session_id = session.session_id;
    // No `classification_coverage` field: a POSIX shell we accepted is exactly
    // what the built-in patterns were written for, so there is no reduction to
    // report. The field appears only when coverage is actually reduced, which
    // is the same shape `exec` and `run_in_session` use (R23, CR-7). The
    // `unsupported_shell` error still carries it, because there the reduction
    // is the reason for the refusal.
    return toToolResult({ ...session });
  } finally {
    audit.exec_duration_ms = Date.now() - started;
  }
}

export const openSessionTool: ToolDefinition = {
  name: 'open_session',
  description: OPEN_SESSION_DESCRIPTION,
  inputSchema: openSessionShape,
  handler,
};
