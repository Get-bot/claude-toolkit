/**
 * The safety path shared by `exec` and `run_in_session` (plan rows 4.4 and 4.8).
 *
 * AC18 requires the two tools to behave identically, so they must not have two
 * implementations of "classify, ask, decide". Both call {@link approveCommand}
 * and then hand the result to {@link commandResultBody}; the only differences
 * are the tool name, the session binding and where the command runs.
 */
import { ERROR_CODES, CodedError } from '../errors.js';
import type { ToolTextResult } from '../errors.js';
import { redact } from '../log.js';
import type { CommandGrade } from '../config/schema.js';
import { gateCommand, gateFileOperation } from '../safety/approval.js';
import type { FileToolName, GateClient, GateResult, GatedToolName } from '../safety/approval.js';
import type { ExcerptEncoding, ExcerptMeta } from '../ssh/excerpt.js';
import type { PoolHost } from '../ssh/pool.js';
import type { ClassificationCoverage } from '../ssh/shellDetect.js';
import type { ToolContext } from './context.js';
import { applyGateToAudit, applyHostToAudit, type AuditDraft } from './wrap.js';

/** AC10.4. Same sentence as the README's background-job section. */
export const BACKGROUND_JOB_WARNING =
  '이 명령은 백그라운드로 분리됐다. 이후 출력은 어느 호출에도 귀속되지 않으며 세션 종료 시 정리되지 않을 수 있다.';

/**
 * Messages `sudo` prints when it wanted a password and could not ask (F10).
 *
 * Detection is after the fact on purpose: the command string is never
 * rewritten, so what was classified, approved and executed stays one and the
 * same byte sequence.
 */
export const SUDO_PASSWORD_PATTERN =
  /a (?:password|terminal) is required|sudo: no tty present|no askpass program|\[sudo\] password for /i;

export function sudoAskedForPassword(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return SUDO_PASSWORD_PATTERN.test(stderr);
}

/** The elicitation half of the gate's view of the client (§5.5 Branch A). */
function gateClientFor(ctx: ToolContext): GateClient {
  const client = ctx.client();
  const supportsElicitation = client?.supportsElicitation === true;
  return {
    supportsElicitation,
    ...(supportsElicitation ? { elicit: (request) => ctx.elicit(request) } : {}),
  };
}

export interface ApproveCommandInput {
  toolName: GatedToolName;
  host: PoolHost;
  command: string;
  sessionId: string | null;
  confirmationToken: string | undefined;
  ctx: ToolContext;
  audit: AuditDraft;
}

export type ApproveCommandResult =
  { allowed: true; gate: GateResult } | { allowed: false; result: ToolTextResult };

/**
 * Run the §5.5 gate and record its verdict.
 *
 * Everything the gate refuses — denied, declined, unavailable, interactive,
 * `sudo -S`, too long — and `confirmation_required` come back as a finished
 * tool result that the caller returns unchanged, so the two-step approval body
 * (M1, M7) reaches the model exactly as the gate built it.
 */
export async function approveCommand(input: ApproveCommandInput): Promise<ApproveCommandResult> {
  const { audit, ctx } = input;
  applyHostToAudit(audit, input.host);
  audit.session_id = input.sessionId;

  const approvalTimeoutMs = ctx.approvalTimeoutMs();
  const gate = await gateCommand({
    toolName: input.toolName,
    host: input.host,
    command: input.command,
    sessionId: input.sessionId,
    ...(input.confirmationToken === undefined
      ? {}
      : { confirmationToken: input.confirmationToken }),
    client: gateClientFor(ctx),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  });

  applyGateToAudit(audit, gate);

  if (gate.kind === 'allow') return { allowed: true, gate };
  return { allowed: false, result: gate.toolResult };
}

export interface ApproveFileOperationInput {
  toolName: FileToolName;
  host: PoolHost;
  /** upload ⇒ privileged; download over an existing file ⇒ destructive. */
  grade: Exclude<CommandGrade, 'safe'>;
  /** One line naming the operation and both paths; shown to the person asked. */
  description: string;
  confirmationToken: string | undefined;
  ctx: ToolContext;
  audit: AuditDraft;
}

/**
 * The same approval path for a file transfer (finding F1).
 *
 * `upload` and `download` used to run with no approval at all, which made them
 * the way around every rule `exec` obeys: a `deny` host would refuse
 * `rm -rf /etc` and then hand over the same destruction as a file overwrite.
 * There is no command to classify here, so the grade is stated by the caller
 * and the description is what a person sees and what the token binds to.
 */
export async function approveFileOperation(
  input: ApproveFileOperationInput
): Promise<ApproveCommandResult> {
  const { audit, ctx } = input;
  applyHostToAudit(audit, input.host);
  audit.session_id = null;

  const approvalTimeoutMs = ctx.approvalTimeoutMs();
  const gate = await gateFileOperation({
    toolName: input.toolName,
    host: input.host,
    grade: input.grade,
    description: input.description,
    sessionId: null,
    ...(input.confirmationToken === undefined
      ? {}
      : { confirmationToken: input.confirmationToken }),
    client: gateClientFor(ctx),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  });

  applyGateToAudit(audit, gate);

  if (gate.kind === 'allow') return { allowed: true, gate };
  return { allowed: false, result: gate.toolResult };
}

export interface CommandResultInput {
  host: string;
  sessionId: string | null;
  stdout: string;
  stderr: string;
  stdout_meta: ExcerptMeta;
  stderr_meta: ExcerptMeta;
  exit_code: number | null;
  signal: string | null;
  encoding: ExcerptEncoding;
  duration_ms: number;
  background_job: boolean;
  coverage: ClassificationCoverage | null;
}

/**
 * Fields that carry command output and must survive redaction at full length
 * (finding F17).
 */
const STREAM_FIELDS: readonly string[] = ['stdout', 'stderr'];

/**
 * The success body for both command tools, in one shape.
 *
 * Built field by field rather than through `toToolResult` because that applies
 * the 2 KiB per-string log ceiling to every value, which would cut a 1 MiB
 * excerpt down to 2048 bytes and quietly undo §5.8 at the last step (F17,
 * AC12). The two stream fields are redacted with no length limit — the
 * excerpter already bounds them, at `cap + 320 KiB` in the worst case — while
 * PEM masking and the default ceiling still apply to everything else.
 */
export function commandResultBody(input: CommandResultInput): ToolTextResult {
  const body: Record<string, unknown> = {
    host: input.host,
    ...(input.sessionId === null ? {} : { session_id: input.sessionId }),
    stdout: input.stdout,
    stderr: input.stderr,
    stdout_meta: input.stdout_meta,
    stderr_meta: input.stderr_meta,
    exit_code: input.exit_code,
    signal: input.signal,
    encoding: input.encoding,
    duration_ms: input.duration_ms,
    background_job: input.background_job,
    ...(input.background_job ? { background_warning: BACKGROUND_JOB_WARNING } : {}),
    ...(input.coverage === null ? {} : { classification_coverage: input.coverage }),
  };

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    payload[key] = STREAM_FIELDS.includes(key)
      ? redact(value, { maxStringBytes: null })
      : redact(value);
  }

  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

/** Translate a `sudo` password prompt into the documented error (F10). */
export function sudoPasswordError(
  host: string,
  sessionId: string | null,
  stderr: string,
  exitCode: number | null
): CodedError {
  return new CodedError(
    ERROR_CODES.sudo_password_required,
    'sudo가 비밀번호를 요구했습니다. 이 서버의 해당 명령에 NOPASSWD 설정이 필요합니다. ' +
      'ssh-mcp는 sudo 비밀번호를 입력하지 않습니다 (v1 비목표).',
    { host, session_id: sessionId, exit_code: exitCode, stderr }
  );
}

/** Milliseconds for a call, honouring the host default when unset. */
export function timeoutMsFor(host: PoolHost, timeoutSec: number | undefined): number {
  return (timeoutSec ?? host.defaultTimeoutSec) * 1000;
}
