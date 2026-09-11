/**
 * `~/.ssh-mcp/state.json` (plan row 1.9).
 *
 * Observations, not configuration: the server records the last client and the
 * shells it has seen, and `doctor` reads them back (§5.11 items 12 and 13).
 * Because this is a cache, a damaged file is replaced by defaults rather than
 * escalated into `config_invalid`.
 */
import fs from 'node:fs';
import { z } from 'zod';

import { errorMessage } from '../internal/util.js';
import { logger } from '../log.js';
import {
  STATE_FILE_MODE,
  applyStateFileMode,
  ensureHome,
  stateFilePath,
  stateTmpFilePath,
} from './paths.js';

export const STATE_SCHEMA_VERSION = 1;

export const LastClientSchema = z
  .object({
    name: z.string().max(256),
    version: z.string().max(64),
    /** Whether the client declared the elicitation capability (M6). */
    elicitation: z.boolean(),
    seenAt: z.string().min(1),
  })
  .strict();

export const ObservedShellSchema = z
  .object({
    shell: z.string().min(1).max(64),
    seenAt: z.string().min(1),
  })
  .strict();

export const StateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    lastClient: LastClientSchema.nullable().default(null),
    /** Keyed by host alias (AC21.11). */
    observedShells: z.record(z.string(), ObservedShellSchema).default({}),
  })
  .strict();

export type LastClient = z.infer<typeof LastClientSchema>;
export type ObservedShell = z.infer<typeof ObservedShellSchema>;
export type State = z.infer<typeof StateSchema>;

export function emptyState(): State {
  return { schemaVersion: STATE_SCHEMA_VERSION, lastClient: null, observedShells: {} };
}

/**
 * Read `state.json`. Returns defaults when the file is missing, unreadable or
 * invalid; never throws.
 */
export function loadState(): State {
  const path = stateFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const result = StateSchema.safeParse(JSON.parse(raw));
    if (result.success) return result.data;
    logger.debug('state.json failed validation; using defaults', { path });
  } catch {
    logger.debug('state.json is not valid JSON; using defaults', { path });
  }
  return emptyState();
}

/**
 * Write `state.json` atomically with mode 0600. Throws on failure; the
 * `record*` helpers below swallow errors instead.
 */
export function saveState(state: State): void {
  const result = StateSchema.safeParse(state);
  if (!result.success) {
    throw new Error('refusing to write invalid state.json');
  }
  ensureHome();
  const tmp = stateTmpFilePath();
  fs.writeFileSync(tmp, `${JSON.stringify(result.data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: STATE_FILE_MODE,
  });
  try {
    applyStateFileMode(tmp);
    fs.renameSync(tmp, stateFilePath());
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort.
    }
    throw err;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function persist(next: State, what: string): void {
  try {
    saveState(next);
  } catch (err) {
    // State is a cache: failing to persist it must not break a tool call.
    logger.warn(`could not update state.json (${what})`, {
      path: stateFilePath(),
      error: errorMessage(err),
    });
  }
}

/**
 * Record the connected client after `initialize` (M6). Called once per server
 * start; never throws.
 */
export function recordClient(client: {
  name: string;
  version: string;
  elicitation: boolean;
}): void {
  const state = loadState();
  persist(
    {
      ...state,
      lastClient: {
        name: client.name,
        version: client.version,
        elicitation: client.elicitation,
        seenAt: nowIso(),
      },
    },
    'lastClient'
  );
}

/**
 * Record the shell detected for a host during `open_session` (AC21.11).
 * Never throws.
 */
export function recordObservedShell(alias: string, shell: string): void {
  const state = loadState();
  persist(
    {
      ...state,
      observedShells: {
        ...state.observedShells,
        [alias]: { shell, seenAt: nowIso() },
      },
    },
    'observedShells'
  );
}
