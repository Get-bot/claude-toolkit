/**
 * `fetch_output` — page back a stream the excerpter cut (plan rows D7, D8;
 * AC-O2, AC-O2a, AC-O4, AC-O6, AC-O7).
 *
 * `exec` and `run_in_session` answer with a head/tail excerpt when a stream
 * exceeds the host's `maxOutputBytes`, and until now the middle was gone for
 * good. When the whole stream was retained, its metadata carries an
 * `output_ref` and this tool walks it from the start, in order, one page at a
 * time.
 *
 * What is deliberately *not* here:
 *
 * - **No redaction pass.** The buffer was PEM-masked once, whole, when it was
 *   stored (`src/output/store.ts`), which is the only way to mask output that
 *   is about to be sliced. Masking a page again would be harmless but would
 *   suggest the page is where masking belongs, and that is the bug AC-O7a
 *   exists to prevent. No length truncation either: capping a page at 2 KiB
 *   would defeat the tool in the same way it once defeated the excerpt (F17).
 * - **No approval and no host.** Safe-grade, read-only, and the bytes never
 *   leave this process. The call is still audited, by `runTool()` (AC-O6).
 */
import { z } from 'zod';

import { getOutput } from '../output/store.js';
import type { ToolTextResult } from '../errors.js';
import type { ToolContext } from './context.js';
import type { ToolDefinition } from './define.js';
import type { AuditDraft } from './wrap.js';

/** Page size when the caller does not ask for one (AC-O2). */
export const DEFAULT_FETCH_BYTES = 64 * 1024;
/** Largest page a caller may ask for (AC-O2). */
export const MAX_FETCH_BYTES = 1024 * 1024;
/**
 * Smallest page a caller may ask for.
 *
 * A window narrower than one character cannot be aligned to a UTF-8 boundary,
 * and the store would have to choose between an empty page and a split
 * sequence. Neither is worth supporting for a request nobody makes.
 */
export const MIN_FETCH_BYTES = 1024;

export const FETCH_OUTPUT_DESCRIPTION = [
  '`exec`/`run_in_session`가 발췌로 잘라낸 출력의 전문을 처음부터 순서대로 페이지 단위로 읽는다.',
  '`stdout_meta.output_ref` 또는 `stderr_meta.output_ref`가 non-null일 때만 쓸 수 있다.',
  '`total_bytes`는 마스킹 후 보관 길이이며 `stdout_meta.total_bytes`(와이어 바이트)와 다를 수 있다. 페이징 종료 판정은 `next_cursor === null`로 한다.',
  '보관은 서버 메모리에만 10분간 유지되며 디스크에 기록되지 않는다 — 만료·폐기·재시작 후에는 `output_expired`이고, 그때는 명령을 다시 실행해야 한다.',
  '개인키 블록은 보관 시점에 마스킹돼 있고 그 외 리댁션은 적용되지 않는다.',
].join(' ');

export const fetchOutputShape = {
  output_ref: z
    .string()
    .min(1)
    .describe('exec/run_in_session 응답의 `stdout_meta.output_ref` 또는 `stderr_meta.output_ref`.'),
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('직전 응답의 `next_cursor`(바이트 오프셋). 생략하면 0, 즉 출력의 처음부터 읽는다.'),
  max_bytes: z
    .number()
    .int()
    .min(MIN_FETCH_BYTES)
    .max(MAX_FETCH_BYTES)
    .optional()
    .describe(
      `한 번에 반환할 최대 바이트. 기본 ${String(DEFAULT_FETCH_BYTES)}, 최대 ${String(MAX_FETCH_BYTES)}.`
    ),
};

const fetchOutputArgs = z.object(fetchOutputShape);

async function handler(
  raw: Record<string, unknown>,
  _ctx: ToolContext,
  _audit: AuditDraft
): Promise<ToolTextResult> {
  const args = fetchOutputArgs.parse(raw);
  const page = getOutput(args.output_ref, args.cursor ?? 0, args.max_bytes ?? DEFAULT_FETCH_BYTES);

  const body = {
    // `chunk` follows `encoding`: text for a UTF-8 stream, base64 for one the
    // excerpter judged non-UTF-8 — the same rule the `exec` response uses, so
    // the two are decoded the same way (AC10.2).
    chunk: page.bytes.toString(page.encoding),
    encoding: page.encoding,
    offset: page.offset,
    next_cursor: page.nextOffset,
    total_bytes: page.totalBytes,
  };

  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const fetchOutputTool: ToolDefinition = {
  name: 'fetch_output',
  description: FETCH_OUTPUT_DESCRIPTION,
  inputSchema: fetchOutputShape,
  handler,
};
