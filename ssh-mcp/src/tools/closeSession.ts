/**
 * `close_session` (plan row 4.9, AC15).
 *
 * Idempotent by description: closing a session that has already gone away is
 * not an error, because the caller's intent — "this session should not be
 * open" — is satisfied either way. An id that was never issued is still an
 * error; answering "closed" to a typo would tell the model a session existed.
 */
import { z } from 'zod';

import { ERROR_CODES, isCodedError, toToolResult } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { closeSession, lookupSession } from '../ssh/session.js';
import type { ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import { applyHostToAudit, type AuditDraft } from './wrap.js';

export const CLOSE_SESSION_DESCRIPTION =
  '세션을 닫고 원격 셸을 종료한다. 이미 닫힌 세션에 호출해도 오류가 아니다.';

export const closeSessionShape = {
  session_id: z.string().describe('open_session이 반환한 세션 id.'),
};

/** Codes that mean "the session is already gone", not "the call failed". */
const ALREADY_CLOSED_CODES: readonly string[] = [
  ERROR_CODES.session_expired,
  ERROR_CODES.session_terminated,
];

const closeSessionArgs = z.object(closeSessionShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = closeSessionArgs.parse(raw);
  audit.session_id = args.session_id;

  // Read the host before closing: afterwards the id is a tombstone and the
  // audit line would lose the host it belonged to.
  const found = lookupSession(args.session_id);
  if (found.state === 'active') {
    audit.host = found.host;
    const config = ctx.loadConfig();
    if (config.ok) {
      const entry = config.file.hosts[found.host];
      if (entry !== undefined) applyHostToAudit(audit, { ...entry, alias: found.host });
    }
  }

  try {
    const closed = closeSession(args.session_id);
    audit.host = closed.host;
    return toToolResult({
      session_id: closed.session_id,
      host: closed.host,
      closed: true,
      already_closed: false,
    });
  } catch (err) {
    if (isCodedError(err) && ALREADY_CLOSED_CODES.includes(err.code)) {
      return toToolResult({
        session_id: args.session_id,
        closed: true,
        already_closed: true,
        reason: err.code,
      });
    }
    throw err;
  }
}

export const closeSessionTool: ToolDefinition = {
  name: 'close_session',
  description: CLOSE_SESSION_DESCRIPTION,
  inputSchema: closeSessionShape,
  handler,
};
