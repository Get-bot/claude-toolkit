/* global process, console, Buffer */
/**
 * Forked by tests/unit/auditConcurrency.test.ts (R24 / AC-H7a).
 *
 * Runs the REAL `appendAudit()` from src/audit.ts -- bundled once by the
 * parent test with esbuild -- inside its own OS process, `count` times, so
 * the parent can observe whether two concurrent writers interleave lines in
 * the shared `audit.jsonl` file. `src/audit.ts` (top-of-file note) points
 * out that Windows `FILE_APPEND_DATA` gives no cross-process atomicity
 * guarantee, unlike POSIX `O_APPEND`. A single process cannot prove or
 * disprove that: the event loop already serializes its own synchronous
 * `fs.appendFileSync` calls, so nothing would ever race.
 *
 * argv: <bundlePath> <homeDir> <childId> <count> [rotateBytes]
 */
import { pathToFileURL } from 'node:url';

const [, , bundlePath, homeDir, childId, countArg, rotateBytesArg] = process.argv;

if (!bundlePath || !homeDir || !childId || !countArg) {
  console.error('usage: auditWriter.mjs <bundlePath> <homeDir> <childId> <count> [rotateBytes]');
  process.exit(2);
}

// `homePath()` in src/config/paths.ts reads `SSH_MCP_HOME` at call time, not
// at import time, so setting it here (before the dynamic import below) is
// enough even though the parent also passes it via `fork`'s `env` option.
process.env.SSH_MCP_HOME = homeDir;

const count = Number(countArg);
const rotateBytes = rotateBytesArg === undefined ? NaN : Number(rotateBytesArg);

const auditBundle = await import(pathToFileURL(bundlePath).href);

if (Number.isFinite(rotateBytes) && rotateBytes > 0) {
  // The default rotate threshold is 10 MiB (src/audit.ts
  // DEFAULT_AUDIT_THRESHOLDS.rotateBytes), and `maybeRotate()` stats the
  // shared file -- so it sees BOTH children's writes combined. Two children
  // x 1000 near-16-KiB lines approaches that on their own; raising the
  // threshold here keeps `rotate()` from renaming the live file out from
  // under this test for a reason unrelated to interleaving.
  auditBundle.setAuditThresholds({ rotateBytes });
}

// A command string sized close to (but comfortably under) the 16 KiB
// per-line cap (DEFAULT_AUDIT_THRESHOLDS.lineMaxBytes) so every
// `fs.appendFileSync` call this process makes is large -- the size at which
// a non-atomic Windows append is most plausible.
//
// `measure()` below has to build the FULL record shape -- every field
// AuditRecordSchema fills in with a default (schemaVersion, ts,
// command_grade, reasons, ... audit_mode), not just the handful we pass to
// `appendAudit` -- because those defaults alone add a few hundred bytes.
// Measuring only our own fields (an earlier version of this file did that)
// undercounts the real line and lets `enforceLineCap` (src/audit.ts) silently
// truncate every record down to exactly the cap, which is a size-limit write
// rather than the "near but under the cap" write this test wants.
const TARGET_LINE_BYTES = 15 * 1024;
const LINE_CAP_BYTES = 16 * 1024;
// Worst case for sizing: the largest seq this run will use, since its extra
// digits (in `session_id` and the last `segments` entry) are the only things
// that vary the byte count between iterations.
const MAX_SEQ = Math.max(0, count - 1);

function commandOfLength(len) {
  return `run-${childId}-`.padEnd(len, 'x');
}

function fullRecordBytes(command, seq) {
  const record = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    tool: 'exec',
    host: 'concurrency-test',
    session_id: `${childId}:${seq}`,
    command,
    command_grade: null,
    reasons: null,
    approval_mode: null,
    approval_outcome: 'auto',
    approval_fallback: null,
    server_cannot_verify_human_approval: false,
    exit_code: 0,
    error_code: null,
    exec_duration_ms: 1,
    approval_wait_ms: 0,
    stdout_bytes: 0,
    stderr_bytes: 0,
    truncated: false,
    normalized_command: command,
    segments: ['run', childId, String(seq)],
    client: null,
    audit_mode: 'full',
  };
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

let commandLength = 4 * 1024;
while (
  commandLength < LINE_CAP_BYTES &&
  fullRecordBytes(commandOfLength(commandLength), MAX_SEQ) < TARGET_LINE_BYTES
) {
  commandLength += 128;
}

for (let seq = 0; seq < count; seq += 1) {
  const command = commandOfLength(commandLength);
  // `session_id` (not `command`/`segments`/`normalized_command`) carries the
  // child id + sequence number because it sits outside TRUNCATION_ORDER
  // (src/audit.ts) -- nothing in appendAudit's line-cap enforcement can ever
  // shorten it, so the parent's per-child sequence check stays reliable even
  // if a record happens to need shrinking.
  const ok = auditBundle.appendAudit({
    tool: 'exec',
    approval_outcome: 'auto',
    host: 'concurrency-test',
    session_id: `${childId}:${seq}`,
    command,
    segments: ['run', childId, String(seq)],
    normalized_command: command,
    exit_code: 0,
    exec_duration_ms: 1,
  });
  if (!ok) {
    console.error(`child ${childId}: appendAudit returned false at seq ${seq}`);
    process.exitCode = 1;
    break;
  }
}
