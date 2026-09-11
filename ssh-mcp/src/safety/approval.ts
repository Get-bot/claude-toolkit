/**
 * Approval gate (plan rows 2.10-2.12, §5.5, AC16-AC18).
 *
 * One function decides, for one tool call, whether the command may run. The
 * order is fixed and the reasons are load-bearing:
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
import type { HostEntry } from '../config/schema.js';
import { resolveApprovalFallback } from '../config/store.js';
import { ERROR_CODES } from '../errors.js';
import type { ErrorCode, ToolTextResult } from '../errors.js';
import { toToolError, toToolNotice } from '../errors.js';
import { logger } from '../log.js';
import { classify, MAX_COMMAND_LENGTH } from './classify.js';
import type { Classification } from './classify.js';
import { checkInteractiveScan } from './interactive.js';
import { normalize } from './normalize.js';
import { consumeToken, issueToken, TOKEN_TTL_MS, TOKEN_TTL_SEC, tokenHashPrefix } from './tokens.js';
import type { ConsumeResult } from './tokens.js';

/** Tools that run a command and therefore go through this gate. */
export type GatedToolName = 'exec' | 'run_in_session';

/** Elicitation timeout, equal to the token TTL (§5.5). */
export const ELICITATION_TIMEOUT_MS = TOKEN_TTL_MS;

/** Boolean field the elicitation form asks for (§5.5 pseudocode, AC17.1b). */
export const ELICIT_CONFIRM_FIELD = 'confirm';

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
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean'; title: string }>;
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
  content?: Record<string, unknown> | undefined,
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

export type ApprovalOutcome =
  | 'not-required'
  | 'auto'
  | 'elicitation-approved'
  | 'token-approved'
  | 'pending-confirmation'
  | 'declined'
  | 'denied'
  | 'approval_unavailable';

interface GateBase {
  approvalOutcome: ApprovalOutcome;
  classification: Classification | null;
  approvalWaitMs: number;
  errorCode: ErrorCode | null;
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

function gradeLabel(classification: Classification): string {
  return classification.grade;
}

/** §5.5: grade, matched pattern ids, host alias and the full command. */
export function buildElicitRequest(
  input: Pick<GateInput, 'toolName' | 'host' | 'command' | 'sessionId'>,
  classification: Classification,
): ElicitRequest {
  const reasons = classification.reasons.length > 0 ? classification.reasons.join(', ') : '(없음)';
  const message = [
    `SSH 명령 실행 승인이 필요합니다.`,
    `호스트: ${input.host.alias} (${input.host.user}@${input.host.hostname}:${String(input.host.port)})`,
    `도구: ${input.toolName}${input.sessionId === null ? '' : ` (session ${input.sessionId})`}`,
    `등급: ${gradeLabel(classification)}`,
    `매칭된 패턴: ${reasons}`,
    `명령 전문:`,
    input.command,
  ].join('\n');

  return {
    message,
    requestedSchema: {
      type: 'object',
      properties: { [ELICIT_CONFIRM_FIELD]: { type: 'boolean', title: '이 명령을 실행합니다' } },
      required: [ELICIT_CONFIRM_FIELD],
    },
  };
}

function allow(
  classification: Classification,
  approvalOutcome: GateAllow['approvalOutcome'],
  approvalWaitMs: number,
): GateAllow {
  return { kind: 'allow', classification, approvalOutcome, approvalWaitMs, errorCode: null };
}

function deny(
  classification: Classification,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown>,
  approvalOutcome: GateDeny['approvalOutcome'],
  approvalWaitMs: number,
): GateDeny {
  return {
    kind: 'deny',
    toolResult: toToolError(code, message, details),
    classification,
    approvalOutcome,
    approvalWaitMs,
    errorCode: code,
  };
}

function classificationDetails(
  input: GateInput,
  classification: Classification,
): Record<string, unknown> {
  return {
    host: input.host.alias,
    tool: input.toolName,
    session_id: input.sessionId,
    grade: classification.grade,
    reasons: classification.reasons,
    command: input.command,
    approval_mode: input.host.approvalMode,
    approval_fallback: resolveApprovalFallback(input.host),
  };
}

function withTimeout(
  promise: Promise<ElicitOutcome>,
  timeoutMs: number,
): Promise<ElicitOutcome> {
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
      },
    );
  });
}

function confirmationRequired(
  input: GateInput,
  classification: Classification,
  approvalWaitMs: number,
): GateConfirmationRequired {
  const token = issueToken({
    toolName: input.toolName,
    hostAlias: input.host.alias,
    sessionId: input.sessionId,
    command: input.command,
  });
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  logger.info('confirmation token issued', {
    host: input.host.alias,
    tool: input.toolName,
    grade: classification.grade,
    // Key name deliberately avoids /token/i so the logger does not mask it;
    // the value is a hash prefix, never the token (AC19.3).
    confirmation_hash8: tokenHashPrefix(token),
  });

  const details: Record<string, unknown> = {
    status: 'confirmation_required',
    instruction_to_model: INSTRUCTION_TO_MODEL,
    ...classificationDetails(input, classification),
    confirmation_token: token,
    expires_at: expiresAt,
    expires_in_sec: TOKEN_TTL_SEC,
    next_call: {
      tool: input.toolName,
      arguments:
        input.sessionId === null
          ? { host: input.host.alias, command: input.command }
          : { session_id: input.sessionId, command: input.command },
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
      { preserveKeys: ['confirmation_token'] },
    ),
    token,
    classification,
    approvalOutcome: 'pending-confirmation',
    approvalWaitMs,
    errorCode: ERROR_CODES.confirmation_required,
  };
}

/** Decide whether one command may run. Never throws. */
export async function gateCommand(input: GateInput): Promise<GateResult> {
  if (input.command.length > MAX_COMMAND_LENGTH) {
    return {
      kind: 'command_too_long',
      toolResult: toToolError(
        ERROR_CODES.command_too_long,
        `명령 길이가 상한을 넘었습니다 (${String(input.command.length)} > ${String(MAX_COMMAND_LENGTH)}자).`,
        { host: input.host.alias, tool: input.toolName, length: input.command.length },
      ),
      classification: null,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.command_too_long,
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
        },
      ),
      classification: null,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.interactive_program_refused,
    };
  }

  const classification = classify(input.command, input.host.patternOverrides, scan);

  if (classification.sudoStdinPassword) {
    return {
      kind: 'sudo_password_required',
      toolResult: toToolError(
        ERROR_CODES.sudo_password_required,
        'sudo가 stdin에서 비밀번호를 읽으려 합니다. ssh-mcp는 stdin을 항상 닫으므로 이 명령은 반드시 실패합니다. ' +
          '해당 명령에 NOPASSWD 설정이 필요합니다. ssh-mcp는 sudo 비밀번호를 입력하지 않습니다 (v1 비목표).',
        classificationDetails(input, classification),
      ),
      classification,
      approvalOutcome: 'denied',
      approvalWaitMs: 0,
      errorCode: ERROR_CODES.sudo_password_required,
    };
  }

  const mode = input.host.approvalMode;
  const fallback = resolveApprovalFallback(input.host);
  const grade = classification.grade;
  const details = classificationDetails(input, classification);

  if (mode === 'auto') return allow(classification, 'auto', 0);

  if (mode === 'deny') {
    if (grade === 'safe') return allow(classification, 'not-required', 0);
    return deny(
      classification,
      ERROR_CODES.command_denied,
      `이 호스트는 approvalMode: deny이며 ${grade} 등급 명령을 실행하지 않습니다.`,
      details,
      'denied',
      0,
    );
  }

  const needsApproval = mode === 'ask-all' || grade !== 'safe';
  if (!needsApproval) return allow(classification, 'not-required', 0);

  if (input.confirmationToken !== undefined) {
    const outcome = consumeToken(input.confirmationToken, {
      toolName: input.toolName,
      hostAlias: input.host.alias,
      sessionId: input.sessionId,
      command: input.command,
    });
    if (outcome === 'ok') return allow(classification, 'token-approved', 0);
    return deny(
      classification,
      TOKEN_FAILURE_CODES[outcome],
      TOKEN_FAILURE_MESSAGES[outcome],
      details,
      'denied',
      0,
    );
  }

  // ---- Branch A: the client can ask the human directly ----
  if (input.client.supportsElicitation && input.client.elicit !== undefined) {
    const startedAt = Date.now();
    let outcome: ElicitOutcome;
    try {
      outcome = await withTimeout(
        input.client.elicit(buildElicitRequest(input, classification)),
        input.approvalTimeoutMs ?? ELICITATION_TIMEOUT_MS,
      );
    } catch (error) {
      const waited = Date.now() - startedAt;
      logger.warn('elicitation call failed', {
        host: input.host.alias,
        tool: input.toolName,
        fallback,
        grade,
        error: error instanceof Error ? error.message : String(error),
      });
      // P2: a failed call must not relax a fail-closed host (AC17.13).
      if (fallback === 'fail-closed' && grade !== 'safe') {
        return deny(
          classification,
          ERROR_CODES.approval_unavailable,
          '승인 절차를 진행할 수 없습니다 (elicitation 호출 실패). 이 호스트는 approvalFallback: fail-closed이므로 토큰을 발급하지 않습니다.',
          details,
          'approval_unavailable',
          waited,
        );
      }
      return confirmationRequired(input, classification, waited);
    }

    const waited = Date.now() - startedAt;
    if (outcome === 'accept') return allow(classification, 'elicitation-approved', waited);
    return deny(
      classification,
      ERROR_CODES.command_denied,
      outcome === 'timeout'
        ? `승인 대기가 시간 초과됐습니다 (${String(Math.round((input.approvalTimeoutMs ?? ELICITATION_TIMEOUT_MS) / 1000))}초). 거절로 처리합니다.`
        : '사용자가 명령 실행을 승인하지 않았습니다.',
      { ...details, elicitation_outcome: outcome },
      'declined',
      waited,
    );
  }

  // ---- Branch B: no elicitation ----
  if (fallback === 'fail-closed' && grade !== 'safe') {
    return deny(
      classification,
      ERROR_CODES.approval_unavailable,
      '이 클라이언트는 승인 요청(elicitation)을 지원하지 않고, 이 호스트는 approvalFallback: fail-closed입니다. ' +
        '토큰을 발급하지 않으며 명령을 실행하지 않습니다.',
      details,
      'approval_unavailable',
      0,
    );
  }
  return confirmationRequired(input, classification, 0);
}
