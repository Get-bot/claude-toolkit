/**
 * Shape of a tool as this package defines it (plan rows 4.3-4.9).
 *
 * The MCP SDK wants a name, a description, a zod raw shape and a callback;
 * keeping those four together per file means one tool is one file, and
 * `server.ts` only decides registration order and the audit wrapper.
 *
 * Handlers take the raw argument object and parse it with their own
 * `z.object(shape)`. The SDK has already validated the same shape, so this is
 * a restatement rather than a first line of defence — but it is what keeps the
 * registration helper free of generics: `registerTool`'s callback type is a
 * conditional on the shape, and a conditional type over an unresolved type
 * parameter cannot be satisfied by any concrete function.
 */
import type { z } from 'zod';

import type { ToolName } from '../audit.js';
import type { ToolTextResult } from '../errors.js';
import type { ToolContext } from './context.js';
import type { AuditDraft } from './wrap.js';

export interface ToolDefinition {
  name: ToolName;
  /** §5.6b text. This is the only guidance the model gets about the tool. */
  description: string;
  /** Raw zod shape; every field carries `.describe()`. */
  inputSchema: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
    audit: AuditDraft
  ) => Promise<ToolTextResult>;
}
