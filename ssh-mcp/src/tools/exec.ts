/**
 * `exec` (plan row 4.4, AC10-AC12, AC16, AC17).
 *
 * Order matters and is shared with `run_in_session`: classify and approve
 * first, connect second. A command the host would refuse never reaches the
 * network, so a `deny` host sees no channel open at all.
 */
import { z } from 'zod';

import { MAX_TIMEOUT_SEC, MIN_TIMEOUT_SEC } from '../config/schema.js';
import { TOOL_DESCRIPTION_APPROVAL_RULE } from '../safety/approval.js';
import type { ToolTextResult } from '../errors.js';
import { execOnce } from '../ssh/exec.js';
import type { CommandOutput } from '../ssh/exec.js';
import { connectHost, observedCoverage, requireHost, type ToolContext } from './context.js';
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
export const EXEC_DESCRIPTION = [
  '등록된 호스트에서 셸 명령을 한 번 실행하고 stdout, stderr, exit code를 분리해 반환한다.',
  '명령은 서버가 안전/파괴적/관리자로 분류하며 호스트의 승인 모드에 따라 확인을 요구할 수 있다.',
  `**${TOOL_DESCRIPTION_APPROVAL_RULE}**`,
  '대화형 프로그램(vim, top, less 등)은 지원하지 않는다.',
  '작업 디렉터리와 환경변수는 호출 간에 유지되지 않는다 — 유지가 필요하면 `open_session`을 쓴다.',
].join(' ');

export const execShape = {
  host: z.string().describe('list_hosts가 반환한 호스트 alias.'),
  command: z
    .string()
    .describe(
      '원격에서 실행할 셸 명령 전문. 서버는 이 문자열을 한 바이트도 변형하지 않으며, 분류·승인·실행 대상이 모두 이 문자열이다.'
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
      'confirmation_required 응답으로 받은 토큰. 사용자에게 명령 전문을 보여주고 대화에서 승인을 받은 뒤에만 붙일 것. 1회용이며 발급 시점의 도구·호스트·명령에 묶여 있다.'
    ),
};

const execArgs = z.object(execShape);

async function handler(
  raw: Record<string, unknown>,
  ctx: ToolContext,
  audit: AuditDraft
): Promise<ToolTextResult> {
  const args = execArgs.parse(raw);
  const host = requireHost(ctx.loadConfig(), args.host);

  const decision = await approveCommand({
    toolName: 'exec',
    host,
    command: args.command,
    sessionId: null,
    confirmationToken: args.confirmation_token,
    ctx,
    audit,
  });
  if (!decision.allowed) return decision.result;

  const conn = await connectHost(host);
  const started = Date.now();
  let output: CommandOutput;
  try {
    output = await execOnce(conn, args.command, {
      timeoutMs: timeoutMsFor(host, args.timeout_sec),
      maxOutputBytes: host.maxOutputBytes,
    });
  } finally {
    // Recorded even when the command timed out: the wall time is the
    // interesting number precisely on that path.
    audit.exec_duration_ms = Date.now() - started;
  }

  audit.exit_code = output.exit_code;
  applyOutputToAudit(audit, output.stdout_meta, output.stderr_meta);

  if (sudoAskedForPassword(output.stderr, output.exit_code)) {
    throw sudoPasswordError(host.alias, null, output.stderr, output.exit_code);
  }

  return commandResultBody({
    host: host.alias,
    sessionId: null,
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
    stdout_retained: output.stdout_retained,
    stderr_retained: output.stderr_retained,
  });
}

export const execTool: ToolDefinition = {
  name: 'exec',
  description: EXEC_DESCRIPTION,
  inputSchema: execShape,
  handler,
};
