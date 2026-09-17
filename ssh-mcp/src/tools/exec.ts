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
import { resolveCommand } from '../output/resolve.js';
import type { OutputFormat } from '../output/resolve.js';
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
      '원격에서 실행할 셸 명령 전문. format이 "text"(기본)면 서버는 이 문자열을 한 바이트도 변형하지 않는다. ' +
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

  // Resolve before the gate, so classification, the approval window, the audit
  // line and the channel below all see the same string (AC-J5).
  const format: OutputFormat = args.format ?? 'text';
  const resolved = resolveCommand(args.command, format);

  const decision = await approveCommand({
    toolName: 'exec',
    host,
    command: resolved.command,
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
    output = await execOnce(conn, resolved.command, {
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
    stdout_retention: output.stdout_retention,
    stderr_retention: output.stderr_retention,
    resolved,
    maxOutputBytes: host.maxOutputBytes,
  });
}

export const execTool: ToolDefinition = {
  name: 'exec',
  description: EXEC_DESCRIPTION,
  inputSchema: execShape,
  handler,
};
