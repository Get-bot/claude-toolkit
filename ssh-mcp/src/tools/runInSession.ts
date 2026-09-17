/**
 * `run_in_session` (plan row 4.8, AC18).
 *
 * Same safety path as `exec`, via the same helper: AC18 asks for identical
 * behaviour, which is only credible if there is one implementation. The
 * differences are the tool name in the token binding, the session id the token
 * is also bound to, and the fact that the command runs inside a shell that
 * keeps its working directory and environment.
 */
import { z } from 'zod';

import { MAX_TIMEOUT_SEC, MIN_TIMEOUT_SEC } from '../config/schema.js';
import { CodedError, ERROR_CODES } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { resolveCommand } from '../output/resolve.js';
import type { OutputFormat } from '../output/resolve.js';
import { TOOL_DESCRIPTION_APPROVAL_RULE } from '../safety/approval.js';
import { lookupSession, runInSession } from '../ssh/session.js';
import type { SessionRunResult } from '../ssh/session.js';
import { observedCoverage, requireHost, type ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import {
  approveCommand,
  commandResultBody,
  sudoAskedForPassword,
  sudoPasswordError,
  timeoutMsFor,
} from './gated.js';
import { applyOutputToAudit, type AuditDraft } from './wrap.js';

/** §5.6b, with the M2 sentence coming from the shared constant. */
export const RUN_IN_SESSION_DESCRIPTION = [
  '열린 세션 안에서 명령을 실행한다.',
  '`cd`, `export`, `source venv/bin/activate`의 효과가 다음 호출까지 유지된다.',
  '분류와 승인은 `exec`와 완전히 동일하다.',
  `**${TOOL_DESCRIPTION_APPROVAL_RULE}**`,
  '대화형 프로그램은 지원하지 않는다.',
].join(' ');

export const runInSessionShape = {
  session_id: z.string().describe('open_session이 반환한 세션 id.'),
  command: z
    .string()
    .describe(
      '세션 안에서 실행할 셸 명령 전문. format이 "text"(기본)면 서버는 이 문자열을 한 바이트도 변형하지 않는다. ' +
        'format이 "json"이면 화이트리스트에 있는 단일 명령에 한해 도구의 JSON 출력 플래그가 덧붙고, ' +
        'df·ps는 인자가 고정 형태로 정규화된다 — 특히 ps는 선택 범위가 전체 프로세스로 넓어지므로 ' +
        '특정 프로세스만 보려면 format을 "text"로 둘 것. 어느 경우든 분류·승인·감사·실행 대상은 ' +
        '모두 실제로 실행되는 그 문자열이며, 승인 창에도 그것이 보인다.'
    ),
  format: z
    .enum(['text', 'json'])
    .optional()
    .describe(
      '"json"이면 stdout을 파싱해 parsed 필드로 함께 반환한다(실패 시 parsed는 null이고 parse_error에 사유가 담긴다). ' +
        '파이프·리다이렉트·`;`·`&&`·서브셸이 있으면 재작성하지 않고 원문을 실행한다. ' +
        '기본값 "text"에서는 응답에 parsed·parse_error 필드가 아예 추가되지 않는다.'
    ),
  timeout_sec: z
    .number()
    .int()
    .min(MIN_TIMEOUT_SEC)
    .max(MAX_TIMEOUT_SEC)
    .optional()
    .describe('실행 제한 시간(초). 생략하면 호스트의 defaultTimeoutSec를 쓴다.'),
  confirmation_token: z
    .string()
    .optional()
    .describe(
      'confirmation_required 응답으로 받은 토큰. 사용자에게 명령 전문을 보여주고 대화에서 승인을 받은 뒤에만 붙일 것. 1회용이며 발급 시점의 세션·명령에 묶여 있다.'
    ),
};

/**
 * The host an id belongs to, or the right error for a dead id.
 *
 * The host has to be known before the approval gate, because the approval mode
 * is a property of the host. A dead id is reported specifically: a session the
 * reaper closed is `session_expired`, one that lost its channel is
 * `session_terminated`, and anything else is `session_not_found` (AC15.1).
 */
function requireSessionHost(sessionId: string): string {
  const found = lookupSession(sessionId);
  if (found.state === 'active') return found.host;

  if (found.state === 'expired') {
    throw new CodedError(
      ERROR_CODES.session_expired,
      `세션 ${sessionId}는 유휴 상태로 자동 종료됐습니다. open_session으로 새 세션을 여십시오.`,
      { session_id: sessionId, reason: 'expired' }
    );
  }
  if (found.reason === 'terminated') {
    throw new CodedError(
      ERROR_CODES.session_terminated,
      `세션 ${sessionId}는 더 이상 사용할 수 없습니다. open_session으로 새 세션을 여십시오.`,
      { session_id: sessionId, reason: 'terminated' }
    );
  }
  throw new CodedError(ERROR_CODES.session_not_found, `알 수 없는 세션입니다: ${sessionId}`, {
    session_id: sessionId,
    ...(found.reason === undefined ? {} : { reason: found.reason }),
  });
}

const runInSessionArgs = z.object(runInSessionShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = runInSessionArgs.parse(raw);
  audit.session_id = args.session_id;
  const alias = requireSessionHost(args.session_id);
  audit.host = alias;
  const host = requireHost(ctx.loadConfig(), alias);

  // Same order as `exec` (AC18): resolve once, then gate, then run the very
  // string that was gated (AC-J5).
  const format: OutputFormat = args.format ?? 'text';
  const resolved = resolveCommand(args.command, format);

  const decision = await approveCommand({
    toolName: 'run_in_session',
    host,
    command: resolved.command,
    sessionId: args.session_id,
    confirmationToken: args.confirmation_token,
    ctx,
    audit,
  });
  if (!decision.allowed) return decision.result;

  const started = Date.now();
  let output: SessionRunResult;
  try {
    output = await runInSession(args.session_id, resolved.command, {
      timeoutMs: timeoutMsFor(host, args.timeout_sec),
      maxOutputBytes: host.maxOutputBytes,
    });
  } finally {
    audit.exec_duration_ms = Date.now() - started;
  }

  audit.exit_code = output.exit_code;
  applyOutputToAudit(audit, output.stdout_meta, output.stderr_meta);

  if (sudoAskedForPassword(output.stderr, output.exit_code)) {
    throw sudoPasswordError(host.alias, args.session_id, output.stderr, output.exit_code);
  }

  return commandResultBody({
    host: host.alias,
    sessionId: output.session_id,
    stdout: output.stdout,
    stderr: output.stderr,
    stdout_meta: output.stdout_meta,
    stderr_meta: output.stderr_meta,
    exit_code: output.exit_code,
    signal: output.signal,
    encoding: output.encoding,
    duration_ms: output.duration_ms,
    background_job: output.background_job,
    coverage: observedCoverage(host.alias),
    stdout_retention: output.stdout_retention,
    stderr_retention: output.stderr_retention,
    resolved,
    maxOutputBytes: host.maxOutputBytes,
  });
}

export const runInSessionTool: ToolDefinition = {
  name: 'run_in_session',
  description: RUN_IN_SESSION_DESCRIPTION,
  inputSchema: runInSessionShape,
  handler,
};
