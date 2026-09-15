/**
 * Approval gate (plan rows 2.10-2.12, §5.5, AC16-AC18).
 *
 * Two entry points share one decision core:
 *
 *   {@link gateCommand}       classifies a shell command, then asks
 *   {@link gateFileOperation} takes the grade from the caller (an upload is
 *                             privileged, an overwriting download destructive)
 *                             and asks the same question about it
 *
 * For a command the order is fixed and the reasons are load-bearing:
 *
 *   1. length limit        — an 8 KiB+ command is not classifiable (OPT-6)
 *   2. interactive gate    — before classification (OPT-1); "needs a terminal"
 *                            is a different question from "is it dangerous"
 *   3. classification      — §5.4
 *   4. `sudo -S`           — stdin is always closed, so this can only fail;
 *                            say so instead of running it (§5.3 F10)
 *   5. approval            — §5.5 branch table
 *
 * The one thing this module cannot do is verify that a human approved
 * anything. When the client cannot elicit and the host chose
 * `approvalFallback: "token"`, the model is asked to obtain approval in
 * conversation and the response says, in the body, that the server cannot
 * check that it did (M1, M7, PM-4). A host that will not accept that chooses
 * `fail-closed` and gets `approval_unavailable` instead.
 */
import type { ApprovalOutcome } from '../audit.js';
import type { CommandGrade, HostEntry } from '../config/schema.js';
import { resolveApprovalFallback } from '../config/store.js';
import { ERROR_CODES } from '../errors.js';
import type { ErrorCode, ToolTextResult } from '../errors.js';
import { toToolError, toToolNotice } from '../errors.js';
import { logger } from '../log.js';
import { classify, MAX_COMMAND_LENGTH } from './classify.js';
import type { Classification } from './classify.js';
import { checkInteractiveScan } from './interactive.js';
import { normalize } from './normalize.js';
import { maskCommandSecrets } from './secrets.js';
import {
  consumeToken,
  issueToken,
  TOKEN_TTL_MS,
  TOKEN_TTL_SEC,
  tokenHashPrefix,
} from './tokens.js';
import type { ConsumeResult } from './tokens.js';

export type { ApprovalOutcome };

/** Tools that run a command and therefore go through {@link gateCommand}. */
export type GatedToolName = 'exec' | 'run_in_session';
/** Tools that move a file and therefore go through {@link gateFileOperation}. */
export type FileToolName = 'upload' | 'download';

/** Elicitation timeout, equal to the token TTL (§5.5). */
export const ELICITATION_TIMEOUT_MS = TOKEN_TTL_MS;

/** Boolean field the elicitation form asks for (§5.5 pseudocode, AC17.1b). */
export const ELICIT_CONFIRM_FIELD = 'confirm';

/**
 * The checkbox label, which is also where the dialog explains itself.
 *
 * Claude Code (2.1.270, observed 2026-09-14) renders a required boolean as an
 * unchecked checkbox and refuses to submit the form while it is unchecked
 * ("This field is required"). Pressing Accept therefore does nothing until the
 * box is ticked, while Decline works immediately — which reads as "approval is
 * broken" to someone who has not been told about the box. The `confirm: true`
 * requirement itself stays (AC17.1b); the fix is to say, inside the dialog,
 * what the dialog expects.
 *
 * It is said here rather than in the message because 2.1.271 cuts this label at
 * roughly 46 display columns and shows only the first three lines of the
 * message: the previous wording lost its own "Accept)" to the cut, while the
 * paragraph that explained the box sat on line nine and was folded away unread.
 * This one leads with the key it wants pressed, stays under 26 columns so it
 * survives the cut and a narrower pane, and sits beside the box it describes.
 */
export const ELICIT_CONFIRM_TITLE = '스페이스로 체크 후 Accept';

/**
 * The second line the checkbox is allowed, per `BooleanSchema.description`.
 *
 * The label has to stay short enough to survive the cut, which leaves no room
 * for the part that actually trips people up: an unchecked Accept looks like a
 * dead key rather than a rejected form. The spec has a field for exactly this,
 * so the sentence goes there instead of being dropped. Whether a given client
 * paints it is the client's business — the MCP schema is deliberately about
 * content, not layout — but an unrendered sentence costs nothing, and a
 * rendered one is the explanation the truncated label cannot carry.
 */
export const ELICIT_CONFIRM_DESCRIPTION = '체크하지 않은 채 Accept를 눌러도 제출되지 않습니다.';

/**
 * M1/M2 shared text. §5.6b puts the same sentence in the `exec` and
 * `run_in_session` descriptions; both read it from here so the two cannot drift
 * apart.
 */
export const INSTRUCTION_TO_MODEL =
  '이 토큰으로 재호출하기 전에, 아래 command 전문을 사용자에게 그대로 보여주고 대화에서 명시적인 승인을 받으십시오. ' +
  '사용자가 승인하지 않았다면 재호출하지 말고 무엇이 막혔는지 설명하십시오. ' +
  '사용자에게 묻지 않고 재호출하는 것은 이 도구의 사용 규칙 위반입니다.';

export const TOOL_DESCRIPTION_APPROVAL_RULE =
  '응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 ' +
  '명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.';

/** Shape of the MCP `elicitation/create` request we ask the caller to send. */
export interface ElicitRequest {
  /**
   * Stated rather than left to the default, though the field is optional in the
   * schema (`mode: z.literal('form').optional()`).
   *
   * Form mode is the only mode this gate can use: the other one hands the
   * person a URL to answer at, and an approval that happens out of band cannot
   * be the thing a tool call waits on here. Saying so is also the line that
   * keeps us honest about the spec's rule that secrets — a sudo password, an
   * API key — must never be collected in a form. Nothing here asks for one, and
   * the field is the reminder of why nothing here ever should.
   */
  mode: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean'; title: string; description?: string }>;
    required: string[];
  };
}

/**
 * What the human did. `accept` means the form came back accepted **and** the
 * `confirm` field was `true`; everything else — `accept` with `confirm: false`,
 * `decline`, `cancel`, no answer within {@link ELICITATION_TIMEOUT_MS} — is a
 * refusal (AC17.1b). {@link interpretElicitResult} does that mapping so a
 * caller cannot get it wrong.
 */
export type ElicitOutcome = 'accept' | 'decline' | 'cancel' | 'timeout';

export function interpretElicitResult(
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown> | undefined
): ElicitOutcome {
  if (action !== 'accept') return action;
  return content?.[ELICIT_CONFIRM_FIELD] === true ? 'accept' : 'decline';
}

export interface GateClient {
  /**
   * `caps.elicitation` exists and is not url-only (plan F6). A bare
   * `elicitation: {}` counts as form support.
   */
  supportsElicitation: boolean;
  elicit?: (request: ElicitRequest) => Promise<ElicitOutcome>;
}

export interface GateInput {
  toolName: GatedToolName;
  host: HostEntry & { alias: string };
  command: string;
  sessionId: string | null;
  confirmationToken?: string;
  client: GateClient;
  /** Override the 300 s elicitation timeout. Tests inject 2 s (AC17.1b). */
  approvalTimeoutMs?: number;
}

export interface FileGateInput {
  toolName: FileToolName;
  host: HostEntry & { alias: string };
  /** upload ⇒ privileged; download over an existing file ⇒ destructive. */
  grade: Exclude<CommandGrade, 'safe'>;
  /** One line naming the operation and both paths. Shown to the human. */
  description: string;
  sessionId: null;
  confirmationToken?: string;
  client: GateClient;
  approvalTimeoutMs?: number;
}

/**
 * The command text as it may be persisted (security finding F11).
 *
 * Credentials typed on a command line must not reach `audit.jsonl`. These are
 * the strings the audit wrapper writes to `command`, `normalized_command` and
 * `segments`; they are masked, unlike {@link Classification.normalized}, which
 * the classifier needs verbatim.
 */
export interface AuditCommandView {
  command: string | null;
  normalizedCommand: string | null;
  segments: string[] | null;
}

interface GateBase {
  approvalOutcome: ApprovalOutcome;
  classification: Classification | null;
  approvalWaitMs: number;
  errorCode: ErrorCode | null;
  /** Masked command text for the audit record (F11). */
  audit: AuditCommandView;
}

export interface GateAllow extends GateBase {
  kind: 'allow';
  classification: Classification;
  approvalOutcome: 'not-required' | 'auto' | 'elicitation-approved' | 'token-approved';
  errorCode: null;
}

export interface GateDeny extends GateBase {
  kind: 'deny';
  toolResult: ToolTextResult;
  classification: Classification;
  approvalOutcome: 'denied' | 'declined' | 'approval_unavailable';
  errorCode: ErrorCode;
}

export interface GateConfirmationRequired extends GateBase {
  kind: 'confirmation_required';
  toolResult: ToolTextResult;
  /** Raw token. Present here and in the response body only (AC19.3). */
  token: string;
  classification: Classification;
  approvalOutcome: 'pending-confirmation';
  errorCode: ErrorCode;
}

export interface GateRefusedInteractive extends GateBase {
  kind: 'refused_interactive';
  toolResult: ToolTextResult;
  classification: null;
  approvalOutcome: 'denied';
  errorCode: ErrorCode;
}

export interface GateSudoPasswordRequired extends GateBase {
  kind: 'sudo_password_required';
  toolResult: ToolTextResult;
  classification: Classification;
  approvalOutcome: 'denied';
  errorCode: ErrorCode;
}

export interface GateCommandTooLong extends GateBase {
  kind: 'command_too_long';
  toolResult: ToolTextResult;
  classification: null;
  approvalOutcome: 'denied';
  errorCode: ErrorCode;
}

export type GateResult =
  | GateAllow
  | GateDeny
  | GateConfirmationRequired
  | GateRefusedInteractive
  | GateSudoPasswordRequired
  | GateCommandTooLong;

const TOKEN_FAILURE_CODES: Record<Exclude<ConsumeResult, 'ok'>, ErrorCode> = {
  invalid: ERROR_CODES.confirmation_token_invalid,
  used: ERROR_CODES.confirmation_token_used,
  expired: ERROR_CODES.confirmation_token_expired,
  mismatch: ERROR_CODES.confirmation_token_mismatch,
};

const TOKEN_FAILURE_MESSAGES: Record<Exclude<ConsumeResult, 'ok'>, string> = {
  invalid: '확인 토큰이 유효하지 않습니다. 승인 절차를 다시 시작하십시오.',
  used: '확인 토큰은 1회만 사용할 수 있습니다. 승인 절차를 다시 시작하십시오.',
  expired: `확인 토큰이 만료됐습니다 (유효 시간 ${String(TOKEN_TTL_SEC)}초). 승인 절차를 다시 시작하십시오.`,
  mismatch:
    '확인 토큰이 이 호출과 일치하지 않습니다. 토큰은 발급 시점의 도구·호스트·세션·명령 전문에 묶여 있습니다.',
};

// --------------------------------------------------------------------------
// shared decision core
// --------------------------------------------------------------------------

interface ApprovalContext {
  toolName: GatedToolName | FileToolName;
  host: HostEntry & { alias: string };
  sessionId: string | null;
  /** What the confirmation token binds to. Never masked, never altered. */
  bindingText: string;
  /** What the model is shown. For a command, the command itself. */
  displayText: string;
  /** What a human is shown in the approval dialog. Masked (F11). */
  promptText: string;
  classification: Classification;
  audit: AuditCommandView;
  confirmationToken: string | undefined;
  client: GateClient;
  approvalTimeoutMs: number | undefined;
  /** `next_call.arguments` echoed back to the model. */
  nextCallArguments: Record<string, unknown>;
}

function allow(
  ctx: ApprovalContext,
  approvalOutcome: GateAllow['approvalOutcome'],
  approvalWaitMs: number
): GateAllow {
  return {
    kind: 'allow',
    classification: ctx.classification,
    approvalOutcome,
    approvalWaitMs,
    errorCode: null,
    audit: ctx.audit,
  };
}

function deny(
  ctx: ApprovalContext,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown>,
  approvalOutcome: GateDeny['approvalOutcome'],
  approvalWaitMs: number
): GateDeny {
  return {
    kind: 'deny',
    toolResult: toToolError(code, message, { ...contextDetails(ctx), ...extra }),
    classification: ctx.classification,
    approvalOutcome,
    approvalWaitMs,
    errorCode: code,
    audit: ctx.audit,
  };
}

function contextDetails(ctx: ApprovalContext): Record<string, unknown> {
  return {
    host: ctx.host.alias,
    tool: ctx.toolName,
    session_id: ctx.sessionId,
    grade: ctx.classification.grade,
    reasons: ctx.classification.reasons,
    command: ctx.displayText,
    approval_mode: ctx.host.approvalMode,
    approval_fallback: resolveApprovalFallback(ctx.host),
  };
}

/**
 * Columns one message line gets before the pane wraps it.
 *
 * Measured on the client that folds the message (2.1.271 in a narrow pane): its
 * label cut landed at about 46 columns and a 44 column message line rendered
 * whole. Whether a wrapped line counts once or twice toward the three-line fold
 * is not something we can see from here, so the budget sits at the measured
 * floor instead of guessing upward.
 */
const ELICIT_LINE_BUDGET = 46;

/**
 * The `사유` clause, trimmed to what fits beside the grade.
 *
 * Reasons arrive as `<grade>:<id>` and the grade is already three words to the
 * left on the same line, so the prefix goes: it spends twelve columns repeating
 * what was just said. The rest is arithmetic — ids are ASCII at one column
 * each, and the fixed Korean labels are two columns per glyph, so `등급: ` is
 * six and ` · 사유: ` is nine. Whatever still does not fit is counted rather
 * than listed; the unabridged set is on the audit line either way.
 */
function reasonsClause(grade: CommandGrade, reasons: readonly string[]): string {
  if (reasons.length === 0) return '(없음)';
  const ids = reasons.map((reason) =>
    reason.startsWith(`${grade}:`) ? reason.slice(grade.length + 1) : reason
  );
  const budget = ELICIT_LINE_BUDGET - (15 + grade.length);
  const widthOf = (count: number): number => {
    const listed = ids.slice(0, count).join(', ').length;
    const dropped = ids.length - count;
    return dropped === 0 ? listed : listed + 6 + String(dropped).length;
  };

  // At least one id is always shown: a single long id spilling a few columns is
  // worth more to the reader than a bare count.
  let kept = ids.length;
  while (kept > 1 && widthOf(kept) > budget) kept -= 1;

  const dropped = ids.length - kept;
  const listed = ids.slice(0, kept).join(', ');
  return dropped === 0 ? listed : `${listed} 외 ${String(dropped)}개`;
}

/** §5.5: grade, matched pattern ids, host alias and the command text. */
function buildElicitRequestFor(ctx: ApprovalContext): ElicitRequest {
  const reasons = reasonsClause(ctx.classification.grade, ctx.classification.reasons);
  const session = ctx.sessionId === null ? '' : ` (session ${ctx.sessionId})`;
  // Three lines, because three lines is the whole visible budget: Claude Code
  // 2.1.271 shows the first three and folds the rest behind a "… (+N more
  // lines)" notice that does not open. The nine-line version put the command on
  // line seven, so the one thing being approved was never on screen — the
  // dialog asked "run this?" while hiding the "this", and the person could only
  // see which host and which tool. What runs comes first now, then where, then
  // why it had to ask at all.
  const message = [
    ctx.promptText,
    `${ctx.host.alias} (${ctx.host.user}@${ctx.host.hostname}:${String(ctx.host.port)}) · ${ctx.toolName}${session}`,
    `등급: ${ctx.classification.grade} · 사유: ${reasons}`,
  ].join('\n');

  return {
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        [ELICIT_CONFIRM_FIELD]: {
          type: 'boolean',
          title: ELICIT_CONFIRM_TITLE,
          description: ELICIT_CONFIRM_DESCRIPTION,
        },
      },
      required: [ELICIT_CONFIRM_FIELD],
    },
  };
}

/** Exposed for callers that want to preview the prompt. */
export function buildElicitRequest(
  input: Pick<GateInput, 'toolName' | 'host' | 'command' | 'sessionId'>,
  classification: Classification
): ElicitRequest {
  return buildElicitRequestFor({
    toolName: input.toolName,
    host: input.host,
    sessionId: input.sessionId,
    bindingText: input.command,
    displayText: input.command,
    promptText: maskCommandSecrets(input.command),
    classification,
    audit: auditView(input.command, classification),
    confirmationToken: undefined,
    client: { supportsElicitation: false },
    approvalTimeoutMs: undefined,
    nextCallArguments: {},
  });
}

/** Masked view of a command for the audit record (F11). */
export function auditView(command: string, classification: Classification): AuditCommandView {
  return {
    command: maskCommandSecrets(command),
    normalizedCommand: maskCommandSecrets(classification.normalized),
    segments: classification.segments.map(maskCommandSecrets),
  };
}

function withTimeout(promise: Promise<ElicitOutcome>, timeoutMs: number): Promise<ElicitOutcome> {
  return new Promise<ElicitOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function confirmationRequired(
  ctx: ApprovalContext,
  approvalWaitMs: number
): GateConfirmationRequired {
  const token = issueToken({
    toolName: ctx.toolName,
    hostAlias: ctx.host.alias,
    sessionId: ctx.sessionId,
    command: ctx.bindingText,
  });
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  logger.info('confirmation token issued', {
    host: ctx.host.alias,
    tool: ctx.toolName,
    grade: ctx.classification.grade,
    // Key name deliberately avoids /token/i so the logger does not mask it;
    // the value is a hash prefix, never the token (AC19.3).
    confirmation_hash8: tokenHashPrefix(token),
  });

  const details: Record<string, unknown> = {
    status: 'confirmation_required',
    instruction_to_model: INSTRUCTION_TO_MODEL,
    ...contextDetails(ctx),
    confirmation_token: token,
    expires_at: expiresAt,
    expires_in_sec: TOKEN_TTL_SEC,
    next_call: {
      tool: ctx.toolName,
      arguments: ctx.nextCallArguments,
      note: '위 confirmation_token 값을 confirmation_token 인자로 추가해 호출하십시오.',
    },
    server_cannot_verify_human_approval: true,
  };

  return {
    kind: 'confirmation_required',
    toolResult: toToolNotice(
      ERROR_CODES.confirmation_required,
      '이 명령은 사용자 승인이 필요합니다.',
      details,
      // `command` is preserved so the model can quote the full text to the
      // user (M7); `redact` caps a preserved value at 32 KiB and the command
      // itself is already capped at 8192 characters by `command_too_long`.
      { preserveKeys: ['confirmation_token', 'command'] }
    ),
    token,
    classification: ctx.classification,
    approvalOutcome: 'pending-confirmation',
    approvalWaitMs,
    errorCode: ERROR_CODES.confirmation_required,
    audit: ctx.audit,
  };
}

/**
 * §5.5 branch table, shared by commands and file operations.
 *
 * One deviation from the plan text, deliberate (security finding F9): the
 * `fail-closed` branches no longer carve out `grade === 'safe'`. Under
 * `ask-all` the operator asked for a human on *every* call, and `fail-closed`
 * says a token is not an acceptable substitute for one. Issuing a
 * self-redeemable token for the safe commands silently turned `ask-all` back
 * into `ask-destructive` for the client that needed it most.
 */
async function runApproval(ctx: ApprovalContext): Promise<GateResult> {
  const mode = ctx.host.approvalMode;
  const fallback = resolveApprovalFallback(ctx.host);
  const grade = ctx.classification.grade;

  if (mode === 'auto') return allow(ctx, 'auto', 0);

  if (mode === 'deny') {
    if (grade === 'safe') return allow(ctx, 'not-required', 0);
    return deny(
      ctx,
      ERROR_CODES.command_denied,
      `이 호스트는 approvalMode: deny이며 ${grade} 등급 명령을 실행하지 않습니다.`,
      {},
      'denied',
      0
    );
  }

  const needsApproval = mode === 'ask-all' || grade !== 'safe';
  if (!needsApproval) return allow(ctx, 'not-required', 0);

  if (ctx.confirmationToken !== undefined) {
    const outcome = consumeToken(ctx.confirmationToken, {
      toolName: ctx.toolName,
      hostAlias: ctx.host.alias,
      sessionId: ctx.sessionId,
      command: ctx.bindingText,
    });
    if (outcome === 'ok') return allow(ctx, 'token-approved', 0);
    return deny(
      ctx,
      TOKEN_FAILURE_CODES[outcome],
      TOKEN_FAILURE_MESSAGES[outcome],
      {},
      'denied',
      0
    );
  }

  // ---- Branch A: the client can ask the human directly ----
  if (ctx.client.supportsElicitation && ctx.client.elicit !== undefined) {
    const startedAt = Date.now();
    let outcome: ElicitOutcome;
    try {
      outcome = await withTimeout(
        ctx.client.elicit(buildElicitRequestFor(ctx)),
        ctx.approvalTimeoutMs ?? ELICITATION_TIMEOUT_MS
      );
    } catch (error) {
      const waited = Date.now() - startedAt;
      logger.warn('elicitation call failed', {
        host: ctx.host.alias,
        tool: ctx.toolName,
        fallback,
        grade,
        error: error instanceof Error ? error.message : String(error),
      });
      // P2: a failed call must not relax a fail-closed host (AC17.13).
      if (fallback === 'fail-closed') {
        return deny(
          ctx,
          ERROR_CODES.approval_unavailable,
          '승인 절차를 진행할 수 없습니다 (elicitation 호출 실패). 이 호스트는 approvalFallback: fail-closed이므로 토큰을 발급하지 않습니다.',
          {},
          'approval_unavailable',
          waited
        );
      }
      return confirmationRequired(ctx, waited);
    }

    const waited = Date.now() - startedAt;
    if (outcome === 'accept') return allow(ctx, 'elicitation-approved', waited);
    return deny(
      ctx,
      ERROR_CODES.command_denied,
      outcome === 'timeout'
        ? `승인 대기가 시간 초과됐습니다 (${String(Math.round((ctx.approvalTimeoutMs ?? ELICITATION_TIMEOUT_MS) / 1000))}초). 거절로 처리합니다.`
        : '사용자가 명령 실행을 승인하지 않았습니다.',
      { elicitation_outcome: outcome },
      'declined',
      waited
    );
  }

  // ---- Branch B: no elicitation ----
  if (fallback === 'fail-closed') {
    return deny(
      ctx,
      ERROR_CODES.approval_unavailable,
      '이 클라이언트는 승인 요청(elicitation)을 지원하지 않고, 이 호스트는 approvalFallback: fail-closed입니다. ' +
        '토큰을 발급하지 않으며 명령을 실행하지 않습니다.',
      {},
      'approval_unavailable',
      0
    );
  }
  return confirmationRequired(ctx, 0);
}

// --------------------------------------------------------------------------
// entry points
// --------------------------------------------------------------------------

/** Decide whether one command may run. Never throws. */
export async function gateCommand(input: GateInput): Promise<GateResult> {
  const maskedCommand = maskCommandSecrets(input.command);
  const emptyAudit: AuditCommandView = {
    command: maskedCommand,
    normalizedCommand: null,
    segments: null,
  };

  if (input.command.length > MAX_COMMAND_LENGTH) {
    return {
      kind: 'command_too_long',
      toolResult: toToolError(
        ERROR_CODES.command_too_long,
        `명령 길이가 상한을 넘었습니다 (${String(input.command.length)} > ${String(MAX_COMMAND_LENGTH)}자).`,
        { host: input.host.alias, tool: input.toolName, length: input.command.length }
      ),
      classification: null,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.command_too_long,
      audit: emptyAudit,
    };
  }

  const scan = normalize(input.command);

  const interactive = checkInteractiveScan(scan);
  if (interactive.refused) {
    return {
      kind: 'refused_interactive',
      toolResult: toToolError(
        ERROR_CODES.interactive_program_refused,
        `${interactive.program}는 터미널이 필요한 대화형 프로그램입니다. ssh-mcp는 PTY를 할당하지 않습니다.`,
        {
          host: input.host.alias,
          tool: input.toolName,
          program: interactive.program,
          detail: interactive.reason,
          alternatives: interactive.alternatives,
        }
      ),
      classification: null,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.interactive_program_refused,
      audit: emptyAudit,
    };
  }

  const classification = classify(input.command, input.host.patternOverrides, scan);
  const ctx: ApprovalContext = {
    toolName: input.toolName,
    host: input.host,
    sessionId: input.sessionId,
    bindingText: input.command,
    displayText: input.command,
    promptText: maskedCommand,
    classification,
    audit: auditView(input.command, classification),
    confirmationToken: input.confirmationToken,
    client: input.client,
    approvalTimeoutMs: input.approvalTimeoutMs,
    nextCallArguments:
      input.sessionId === null
        ? { host: input.host.alias, command: input.command }
        : { session_id: input.sessionId, command: input.command },
  };

  if (classification.sudoStdinPassword) {
    return {
      kind: 'sudo_password_required',
      toolResult: toToolError(
        ERROR_CODES.sudo_password_required,
        'sudo가 stdin에서 비밀번호를 읽으려 합니다. ssh-mcp는 stdin을 항상 닫으므로 이 명령은 반드시 실패합니다. ' +
          '해당 명령에 NOPASSWD 설정이 필요합니다. ssh-mcp는 sudo 비밀번호를 입력하지 않습니다 (v1 비목표).',
        contextDetails(ctx)
      ),
      classification,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.sudo_password_required,
      audit: ctx.audit,
    };
  }

  return runApproval(ctx);
}

/**
 * Decide whether one file transfer may run (security finding F1).
 *
 * `upload` and `download` never reach {@link gateCommand} — there is no shell
 * command to classify — and before this they reached no gate at all. The grade
 * is supplied by the caller because only it knows whether the download is about
 * to overwrite something:
 *
 *   upload                     ⇒ `privileged`
 *   download without overwrite ⇒ `privileged`
 *   download with overwrite    ⇒ `destructive`
 *
 * `description` is the text a human approves and the text the confirmation
 * token binds to, so it must name the operation and both paths and must be
 * built the same way on the retry call.
 */
export async function gateFileOperation(input: FileGateInput): Promise<GateResult> {
  const classification: Classification = {
    grade: input.grade,
    reasons: [`${input.grade}:file-transfer`],
    segments: [input.description],
    normalized: input.description,
    passes: { whole: [], segment: [] },
    unparseable: false,
    sudoStdinPassword: false,
    backgroundJob: false,
  };

  const ctx: ApprovalContext = {
    toolName: input.toolName,
    host: input.host,
    sessionId: input.sessionId,
    bindingText: input.description,
    displayText: input.description,
    promptText: maskCommandSecrets(input.description),
    classification,
    audit: auditView(input.description, classification),
    confirmationToken: input.confirmationToken,
    client: input.client,
    approvalTimeoutMs: input.approvalTimeoutMs,
    nextCallArguments: { host: input.host.alias, description: input.description },
  };

  return runApproval(ctx);
}
