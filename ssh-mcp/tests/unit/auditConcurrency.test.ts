/**
 * R24 / AC-H7a -- do two real ssh-mcp processes appending to the same
 * `audit.jsonl` interleave lines?
 *
 * §5.10 (and the top-of-file note in `src/audit.ts`) argues that POSIX
 * `O_APPEND` is atomic regardless of write size, but Windows
 * `FILE_APPEND_DATA` makes no such cross-process promise, and Node's
 * `appendFileSync` can split a large buffer across more than one `write()`.
 * The 16 KiB line cap is documented as a size limit and a probability
 * mitigation only -- never as an atomicity guarantee. This test is the
 * promised experiment (plan `.omc/plans/ssh-mcp-v11-plan.md` §1 Q1, step
 * A3): it must exist *before* AC-H7's outcome can be judged, and per §6.5
 * the outcome -- not this file -- decides whether `audit-<pid>.jsonl`
 * splitting (Phase C, step C9) gets built.
 *
 * A single process proves nothing here: the event loop serializes its own
 * synchronous `appendFileSync` calls, so two real OS processes are required
 * (real-world case: Claude Desktop and Claude Code running against the same
 * `~/.ssh-mcp` at once). Each child below is a genuine Node process running
 * the actual `src/audit.ts` (esbuild-bundled once by this file, not
 * reimplemented), forked via `node:child_process`, each appending 1000
 * near-16-KiB records. Success is: the file ends with exactly 2000 lines,
 * every line is valid JSON matching `AuditRecordSchema`, and every
 * `child:seq` pair (0..999 for each of the two children) is present exactly
 * once. Any deviation is direct evidence of interleaving or corruption.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditRecordSchema } from '../../src/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_ENTRY = path.resolve(__dirname, '../../src/audit.ts');
const WRITER_SCRIPT = path.resolve(__dirname, '../fixtures/auditWriter.mjs');

const CHILD_IDS = ['A', 'B'] as const;
const RECORDS_PER_CHILD = 1000;
const TOTAL_RECORDS = CHILD_IDS.length * RECORDS_PER_CHILD;
// Two children x 1000 lines near the 16 KiB cap approaches the default 10
// MiB rotate threshold (src/audit.ts DEFAULT_AUDIT_THRESHOLDS.rotateBytes).
// `rotate()` would rename the live file mid-test and break the "exactly N
// lines" assertion for a reason that has nothing to do with interleaving,
// so each child is told (via argv) to raise its own threshold far past
// anything this test could ever write.
const ROTATE_BYTES_OVERRIDE = 1024 * 1024 * 1024; // 1 GiB
// Two real forked processes + an esbuild bundle already built in `beforeAll`,
// each doing 1000 synchronous `fs.appendFileSync` calls of ~15 KiB:
// comfortably under a second locally, but process-fork overhead on a loaded CI
// runner earns a longer budget than the suite's default 30s
// (vitest.config.ts).
const PROBE_TIMEOUT_MS = 60_000;

interface ChildResult {
  childId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let bundleDir: string;
let bundlePath: string;
let tmpHomeDir: string;

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-audit-bundle-'));
  bundlePath = path.join(bundleDir, 'audit-bundle.mjs');
  // `external: []` (the default) matters: this bundle is written to an
  // os.tmpdir() scratch directory with no ancestor `node_modules`, so even
  // the dependency tsup normally externalizes for the shipped build (zod)
  // must be inlined here for the forked child to resolve it at all.
  await esbuild.build({
    entryPoints: [AUDIT_ENTRY],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
  });
});

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

beforeEach(() => {
  tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-audit-home-'));
});

afterEach(() => {
  fs.rmSync(tmpHomeDir, { recursive: true, force: true });
});

function runChild(childId: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = fork(
      WRITER_SCRIPT,
      [bundlePath, tmpHomeDir, childId, String(RECORDS_PER_CHILD), String(ROTATE_BYTES_OVERRIDE)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    // `close` (not `exit`): `exit` can fire before the stdio pipes above have
    // finished draining, which would drop the diagnostic tail exactly when a
    // failing child needs it (tests/fixtures/AGENTS.md notes the same
    // ordering trap for `StdioServer.describeFate()`).
    child.on('close', (code, signal) => {
      resolve({ childId, code, signal, stdout, stderr });
    });
  });
}

describe('audit.jsonl concurrent-writer probe (R24, AC-H7a)', () => {
  it(
    'two real ssh-mcp processes appending 1000 records each do not corrupt audit.jsonl',
    async () => {
      const results = await Promise.all(CHILD_IDS.map((id) => runChild(id)));

      for (const result of results) {
        expect(
          result.code,
          `child ${result.childId} exited non-zero (signal=${String(result.signal)})\n` +
            `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ).toBe(0);
      }

      const auditPath = path.join(tmpHomeDir, 'audit.jsonl');
      const raw = fs.readFileSync(auditPath, 'utf8');
      // A well-formed file is `<line>\n` repeated, so splitting on `\n` and
      // dropping the trailing empty element left by the final terminator
      // yields exactly the record count -- unless two writes interleaved and
      // merged, split, or corrupted a line, which is exactly what this test
      // watches for.
      const lines = raw.split('\n').filter((line) => line.length > 0);

      const parseErrors: string[] = [];
      const seenByChild = new Map<string, Set<number>>();
      for (const id of CHILD_IDS) seenByChild.set(id, new Set());

      lines.forEach((line, index) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          parseErrors.push(
            `line ${String(index)}: JSON.parse failed (${message}): ${line.slice(0, 200)}`
          );
          return;
        }

        const parsed = AuditRecordSchema.safeParse(json);
        if (!parsed.success) {
          parseErrors.push(`line ${String(index)}: schema rejected: ${parsed.error.message}`);
          return;
        }

        const sessionId = parsed.data.session_id ?? '';
        const [childId, seqPart] = sessionId.split(':');
        const seq = Number(seqPart);
        const seen = childId === undefined ? undefined : seenByChild.get(childId);
        if (seen === undefined || !Number.isInteger(seq)) {
          parseErrors.push(`line ${String(index)}: unexpected session_id shape: "${sessionId}"`);
          return;
        }
        seen.add(seq);
      });

      expect(parseErrors, `interleaving/corruption evidence:\n${parseErrors.join('\n')}`).toEqual(
        []
      );
      expect(lines.length, 'total line count in audit.jsonl').toBe(TOTAL_RECORDS);

      for (const childId of CHILD_IDS) {
        const seen = seenByChild.get(childId) ?? new Set<number>();
        const missing: number[] = [];
        for (let seq = 0; seq < RECORDS_PER_CHILD; seq += 1) {
          if (!seen.has(seq)) missing.push(seq);
        }
        expect(missing, `child ${childId} missing sequence numbers`).toEqual([]);
        expect(
          seen.size,
          `child ${childId} distinct sequence count (extra/duplicate ids would inflate this)`
        ).toBe(RECORDS_PER_CHILD);
      }
    },
    PROBE_TIMEOUT_MS
  );
});
