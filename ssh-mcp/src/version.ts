/**
 * Package version lookup, shared by the server and the bin entry point.
 *
 * `server.ts` cannot import this from `src/index.ts`: that module runs the CLI
 * on import and dynamically imports the server back, so reading the version
 * from there would start a second copy of the process' own entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returned when the manifest cannot be read; never thrown to a caller. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/** Read `version` from the package manifest next to the running module. */
export function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/index.js and src/*.ts both sit one level below the package root.
  const candidates = [path.join(here, '..', 'package.json'), path.join(here, 'package.json')];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === 'string' && version !== '') return version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return UNKNOWN_VERSION;
}
