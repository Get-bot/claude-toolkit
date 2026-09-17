/**
 * Tool annotations (§5.6) and the `requiresUserInteraction` hint (M4).
 *
 * Annotations are hints, not a security boundary: the SDK's own type docs say a
 * client must never trust annotations from an untrusted server. Blocking is
 * done entirely by `src/safety/`. The one exception is
 * `anthropic/requiresUserInteraction`, which Claude Code does enforce by
 * prompting on every call even under always-allow; it is attached to `exec` and
 * `run_in_session` only, because prompting on read-only tools teaches people to
 * click through every prompt and that is what would break the two that matter.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolName } from '../audit.js';

/**
 * §5.6 verbatim. `list_hosts` omits the destructive and idempotent hints:
 * with `readOnlyHint: true` they carry no information.
 */
export const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  list_hosts: { readOnlyHint: true, openWorldHint: false },
  exec: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  upload: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  download: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  open_session: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  run_in_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  close_session: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // The two v1.1 readers. Both answer from this process alone — `history` from
  // the audit file, `fetch_output` from the in-memory output store — so neither
  // opens a world beyond the server, and the destructive and idempotent hints
  // carry no information next to `readOnlyHint: true` (AC-H4, AC-O6).
  history: { readOnlyHint: true, openWorldHint: false },
  fetch_output: { readOnlyHint: true, openWorldHint: false },
};

/** Non-standard Anthropic extension key (M4). */
export const REQUIRES_USER_INTERACTION_KEY = 'anthropic/requiresUserInteraction';

/** The only two tools that carry it (AC17.9). */
export const INTERACTION_META_TOOLS: readonly ToolName[] = ['exec', 'run_in_session'];

/** Opt-out for non-interactive Claude Code users (R17, AC17.10). */
export const REQUIRE_USER_INTERACTION_ENV = 'SSH_MCP_REQUIRE_USER_INTERACTION';

export function requiresUserInteractionEnabled(): boolean {
  return process.env[REQUIRE_USER_INTERACTION_ENV]?.trim() !== '0';
}

/**
 * `_meta` for one tool, or `undefined` when it takes none. Read at registration
 * time, so the environment variable is evaluated once per server start.
 */
export function toolMeta(name: ToolName): Record<string, unknown> | undefined {
  if (!INTERACTION_META_TOOLS.includes(name)) return undefined;
  if (!requiresUserInteractionEnabled()) return undefined;
  return { [REQUIRES_USER_INTERACTION_KEY]: true };
}
