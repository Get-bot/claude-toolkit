/**
 * Byte ceilings for the v1.1 output layer (plan row D4, appendix B-2).
 *
 * Three limits, three purposes, one file — because they are easy to confuse and
 * a reader who finds one needs to see the other two to know which is which:
 *
 * | limit             | measures                                  | over the limit |
 * |-------------------|-------------------------------------------|----------------|
 * | {@link retainCapFor} | the raw stream kept for `fetch_output` | nothing is retained, so `output_ref` stays `null` (AC-O4a) |
 * | {@link parseCapFor}  | the stdout handed to a `format:"json"` parser | `parse_error: "too_large"` (AC-J7a) |
 * | {@link emitCapFor}   | `JSON.stringify(parsed)` on the way out | `parse_error: "parsed_too_large"` (AC-J6b) |
 *
 * **Every one is a multiple of the host's `maxOutputBytes` *and* an absolute
 * ceiling.** The multiple is what makes a host that deliberately asks for small
 * output also get small buffers; the absolute value is what makes the bound
 * true regardless of what a future schema allows `maxOutputBytes` to be. With
 * today's schema maximum of 4 MiB the absolute ceilings are exactly reached and
 * change nothing — which is the point of writing them down now rather than
 * after someone raises the schema limit.
 *
 * Retention is the expensive one: a retained buffer lives for the whole command
 * because nothing can know in advance whether the stream will be truncated, and
 * it exists twice per command (stdout and stderr). At the 16 MiB ceiling that
 * is 32 MiB per command in flight, and a host allows five concurrent sessions,
 * so the worst case is 160 MiB **on top of** the output store's own 64 MiB cap.
 * That is why the per-item cap and the store's total cap are separate numbers.
 *
 * Deliberately dependency-free, so the SSH layer can import it without
 * inverting the `tools/` → `ssh/` direction (`src/AGENTS.md` layering rule).
 * The arguments are plain byte counts rather than a host record for the same
 * reason: `src/ssh/exec.ts` only ever sees `options.maxOutputBytes`.
 */

/** Absolute ceiling on one retained stream (plan row D4). */
export const RETAIN_ABSOLUTE_CAP_BYTES = 16 * 1024 * 1024;
/** Absolute ceiling on parser input (AC-J7a). */
export const PARSE_ABSOLUTE_CAP_BYTES = 4 * 1024 * 1024;
/** Absolute ceiling on a serialised `parsed` field (AC-J6b). */
export const EMIT_ABSOLUTE_CAP_BYTES = 4 * 1024 * 1024;

/** `min(4 × maxOutputBytes, 16 MiB)` — per-stream retention budget (AC-O4a). */
export function retainCapFor(maxOutputBytes: number): number {
  return Math.min(4 * maxOutputBytes, RETAIN_ABSOLUTE_CAP_BYTES);
}

/** `min(4 × maxOutputBytes, 4 MiB)` — largest stdout a parser will read (AC-J7a). */
export function parseCapFor(maxOutputBytes: number): number {
  return Math.min(4 * maxOutputBytes, PARSE_ABSOLUTE_CAP_BYTES);
}

/**
 * `min(2 × maxOutputBytes, 4 MiB)` — largest `parsed` a response will carry.
 *
 * Lower than the parse cap on purpose: parsing a large table is cheap, but
 * putting the result in a tool response spends the model's context. AC-J7's
 * input-size test and this output-size test are different measurements and
 * neither replaces the other (AC-J6b).
 */
export function emitCapFor(maxOutputBytes: number): number {
  return Math.min(2 * maxOutputBytes, EMIT_ABSOLUTE_CAP_BYTES);
}
