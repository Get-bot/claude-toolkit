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
import { logger, redact, redactParsed } from '../log.js';
import { emitCapFor, parseCapFor } from '../output/limits.js';
import type { OutputPlan } from '../output/jsonCommands.js';
import type { ResolveResult } from '../output/resolve.js';
import { parseDf, parsePs } from '../output/tables.js';
import type { TableParseReason } from '../output/tables.js';
import type { ResolvedCommand } from '../output/resolve.js';
import { putOutput } from '../output/store.js';
import type { CommandGrade } from '../config/schema.js';
import { gateCommand, gateFileOperation } from '../safety/approval.js';
import type { FileToolName, GateClient, GateResult, GatedToolName } from '../safety/approval.js';
import type { ExcerptEncoding, ExcerptMeta, Retention } from '../ssh/excerpt.js';
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
  /**
   * The command as it will actually run (AC-J5, AC-J5a). Branded so that a
   * handler cannot classify one string and execute another: only
   * `resolveCommand()` produces this type (`src/output/resolve.ts`).
   */
  command: ResolvedCommand;
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
  /** What became of each whole stream, for {@link withOutputRef} (ADR-010). */
  stdout_retention: Retention;
  stderr_retention: Retention;
  /**
   * What {@link import('../output/resolve.js').resolveCommand} decided for this
   * call. `format: 'text'` adds no `parsed`/`parse_error` field at all (AC-J1).
   */
  resolved: ResolveResult;
  /** The host's `maxOutputBytes`, for {@link parseCapFor} and {@link emitCapFor}. */
  maxOutputBytes: number;
}

/**
 * Every value `parse_error` can take, and what each one tells the model to do
 * next (AC-J3, AC-J4, AC-J6, AC-J6b, AC-J7a).
 *
 * This union is the domain. It is written out here rather than left to
 * accumulate across the files that produce the values, because a reader
 * deciding how to handle a failure needs the alternatives in front of them —
 * and because the `| string` that used to end it would have accepted
 * `header_unrecognised` from a typo and shipped the typo as contract.
 *
 * | value | what happened | the model's next move |
 * |-------|---------------|-----------------------|
 * | `not_rewritable` | the command has a pipe, redirect, `;`, `&&` or a subshell, so it ran unrewritten | re-issue the single command on its own, or just read `stdout` |
 * | `too_large` | stdout was past the parse ceiling | narrow the command, or read the excerpt and page the rest with `fetch_output` |
 * | `invalid_json` | the command ran but printed something that is not JSON | usually a remote too old for the flag — fall back to `format: "text"` |
 * | `parsed_too_large` | it parsed, but the result would not fit in a response | narrow the command; the data exists, the envelope does not fit |
 * | `output_not_retained` | the server did not keep stdout, so there was nothing to parse | **nothing the caller can do** — see below |
 * | `empty_output` | not even a header line — usually the command itself failed | read `exit_code` and `stderr`; `format` is not the problem |
 * | `header_unrecognized` | the table header is not the normalised one | `format: "json"` will fail the same way again; use `format: "text"` |
 * | `row_unparsable` | the header matched but a row did not | often a read cut mid-stream, so the same call can succeed on retry |
 *
 * **`output_not_retained` is not like the other seven.** Every other value
 * describes something about the command or its output, and leaves the caller a
 * move: narrow it, re-issue it, drop to `format: "text"`, or read `stderr`.
 * This one describes a defect in the server: it wired up a parsing path without
 * keeping the bytes to parse. Retrying returns the same thing, and so does
 * every value of `format`, so a caller that treats it like the others will
 * burn calls cycling through options that cannot help. The answer is in the
 * server's log — the same event is written there at `error` level — and the fix
 * is a code change, not a different request.
 *
 * The last three come from `tables.ts`, which owns their spelling; importing
 * {@link TableParseReason} is what keeps this list from drifting away from it.
 */
export type ParseErrorReason =
  | 'not_rewritable'
  | 'too_large'
  | 'invalid_json'
  | 'parsed_too_large'
  | 'output_not_retained'
  | TableParseReason;

type ParseOutcome = { parsed: unknown; error: null } | { parsed: null; error: ParseErrorReason };

/**
 * Fields that carry command output and must survive redaction at full length
 * (finding F17).
 */
const STREAM_FIELDS: readonly string[] = ['stdout', 'stderr'];

/**
 * Register a truncated stream and put its handle on the metadata (ADR-010,
 * AC-O1, AC-O1a, AC-O1b).
 *
 * `meta.truncated` is the predicate, and it has to be: `omitted_lines > 0`
 * misses a non-UTF-8 stream, whose line counts are all `null`, and misses a
 * stream that only lost bytes to the per-line 8 KiB cut. Both of those are
 * truncation the caller would want to fetch (AC-O1a).
 *
 * Doing this here rather than in the excerpter is what makes AC-O1b structural:
 * a timed-out command rejects before it ever reaches this function, so its
 * `output_ref` cannot be anything but `null`.
 */
function withOutputRef(meta: ExcerptMeta, retention: Retention): ExcerptMeta {
  if (!meta.truncated || retention.kind !== 'kept') return meta;
  const ref = putOutput(retention.bytes, meta.encoding);
  return ref === null ? meta : { ...meta, output_ref: ref };
}

/**
 * The success body for both command tools, in one shape.
 *
 * Built field by field rather than through `toToolResult` because that applies
 * the 2 KiB per-string log ceiling to every value, which would cut a 1 MiB
 * excerpt down to 2048 bytes and quietly undo §5.8 at the last step (F17,
 * AC12). The two stream fields are redacted with no length limit — the
 * excerpter already bounds them, at `cap + 320 KiB` in the worst case — while
 * PEM masking and the default ceiling still apply to everything else.
 *
 * This is also where a truncated stream gets its `output_ref`
 * ({@link withOutputRef}): the only function that knows both whether the
 * excerpter cut anything and what the response looks like (ADR-010).
 */
export function commandResultBody(input: CommandResultInput): ToolTextResult {
  const body: Record<string, unknown> = {
    host: input.host,
    ...(input.sessionId === null ? {} : { session_id: input.sessionId }),
    stdout: input.stdout,
    stderr: input.stderr,
    stdout_meta: withOutputRef(input.stdout_meta, input.stdout_retention),
    stderr_meta: withOutputRef(input.stderr_meta, input.stderr_retention),
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

  // Attached after the loop, not inside `body`: `parsed` must not meet the
  // default `redact()`, whose 2 KiB string cut and depth-8 ceiling would turn a
  // `docker inspect` result into corrupted data (AC-J6a). `parsedFields` has
  // already run `redactParsed` over it.
  Object.assign(payload, parsedFields(input));

  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

/**
 * The `parsed`/`parse_error` pair, or nothing at all (AC-J1, AC-J6, AC-J6b).
 *
 * `format: "text"` returns `{}` so the response keeps the 0.2.1 field set —
 * absent, not `null`, because a model that sees `parsed: null` will reasonably
 * conclude parsing was attempted and failed.
 */
function parsedFields(input: CommandResultInput): Record<string, unknown> {
  if (input.resolved.format === 'text') return {};

  const outcome = parseStdout(input);
  if (outcome.error !== null) return { parsed: null, parse_error: outcome.error };

  // Redact before measuring: the cap is on what the response actually carries,
  // and masking changes the length in both directions (AC-J6b).
  const redacted = redactParsed(outcome.parsed);
  const serialised = JSON.stringify(redacted) ?? 'null';
  if (Buffer.byteLength(serialised, 'utf8') > emitCapFor(input.maxOutputBytes)) {
    return { parsed: null, parse_error: 'parsed_too_large' };
  }
  return { parsed: redacted, parse_error: null };
}

/**
 * Turn the retained stdout into a value, or name why it could not be (AC-J7).
 *
 * The input is `stdout_retained` — the whole stream **before** masking and
 * before excerpting. Not the excerpt, which is a middle-elided summary that
 * would parse as nothing; and not the store's copy, which is masked and is
 * written later in the response-assembly order. Private keys inside the result
 * are caught by `redactParsed`'s in-string PEM masking, not by parsing less.
 */
function parseStdout(input: CommandResultInput): ParseOutcome {
  const { plan, parseError } = input.resolved;
  // AC-J3: the command ran unrewritten, so there is nothing to parse.
  if (parseError !== null) return { parsed: null, error: parseError };
  if (plan === null) return { parsed: null, error: 'not_rewritable' };

  const retention = input.stdout_retention;
  switch (retention.kind) {
    case 'dropped':
      // The stream outgrew `retainCapFor()`, and `retainCapFor >= parseCapFor`
      // for *every* `maxOutputBytes` — `min(4m, 16 MiB) >= min(4m, 4 MiB)`
      // because 16 MiB > 4 MiB, so it holds for all m, not merely the values
      // the schema allows. This is therefore not a fallback for missing data:
      // such a stream is over the parse cap too, and `too_large` is the same
      // answer the size check below would give.
      return { parsed: null, error: 'too_large' };
    case 'not_requested':
      // Unreachable today — both production paths ask for retention — and
      // deliberately *not* folded into `too_large`, which would be a confident
      // wrong answer about a stream that might be three bytes long. If this
      // ever fires, a caller was wired up without retention, so it is an
      // operator-facing bug as much as a model-facing one.
      logger.error('parse skipped: stdout was not retained', { host: input.host });
      return { parsed: null, error: 'output_not_retained' };
    case 'kept':
      break;
  }

  if (retention.bytes.length > parseCapFor(input.maxOutputBytes)) {
    return { parsed: null, error: 'too_large' };
  }

  return runPlan(plan, retention.bytes.toString('utf8'));
}

function runPlan(plan: OutputPlan, stdout: string): ParseOutcome {
  if (plan.kind === 'json') {
    try {
      return { parsed: JSON.parse(stdout), error: null };
    } catch {
      // AC-J6: the tool printed something other than JSON — an older build
      // without the flag, or a command the table matched too eagerly.
      return { parsed: null, error: 'invalid_json' };
    }
  }

  const result = plan.parser === 'df' ? parseDf(stdout) : parsePs(stdout);
  // The parsers' reasons are contract strings of their own (`tables.ts`), so
  // they are carried through rather than flattened into one code (AC-J4).
  return result.ok ? { parsed: result.value, error: null } : { parsed: null, error: result.reason };
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
