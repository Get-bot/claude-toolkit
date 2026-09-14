/**
 * zod schema for `~/.ssh-mcp/hosts.json` (plan row 1.2, §5.2).
 *
 * Every object is `.strict()`: a typo'd key must never silently weaken the
 * safety configuration. In particular `patternOverrides.allow` is *not* part of
 * the v1 schema, so a leftover allow-list from an earlier draft is rejected
 * loudly instead of being ignored (plan F8 / C10).
 */
import { z } from 'zod';

/** Host alias, also used as the key in the `hosts` map. */
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** OpenSSH-style base64 SHA-256 fingerprint, unpadded (AC7.4). */
export const HOST_KEY_SHA256_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Only version 1 exists; a higher version must be rejected, not guessed at. */
export const CONFIG_SCHEMA_VERSION = 1;

export const APPROVAL_MODES = ['auto', 'ask-destructive', 'ask-all', 'deny'] as const;
export const APPROVAL_FALLBACKS = ['token', 'fail-closed'] as const;
export const AUDIT_MODES = ['full', 'metadata-only'] as const;
/** Shared command-grade vocabulary (safety classifier + audit log). */
export const COMMAND_GRADES = ['safe', 'privileged', 'destructive'] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export type ApprovalFallback = (typeof APPROVAL_FALLBACKS)[number];
export type AuditMode = (typeof AUDIT_MODES)[number];
export type CommandGrade = (typeof COMMAND_GRADES)[number];

/** Fallback applied to a host entry that omits `approvalFallback` (decision D2). */
export const DEFAULT_APPROVAL_FALLBACK: ApprovalFallback = 'fail-closed';
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask-destructive';
export const DEFAULT_AUDIT_MODE: AuditMode = 'full';
export const DEFAULT_PORT = 22;
export const DEFAULT_TIMEOUT_SEC = 60;
export const DEFAULT_MAX_OUTPUT_BYTES = 1048576;

export const MIN_TIMEOUT_SEC = 1;
export const MAX_TIMEOUT_SEC = 3600;
/** 1 KiB floor, 4 MiB ceiling (§5.2). */
export const MIN_MAX_OUTPUT_BYTES = 1024;
export const MAX_MAX_OUTPUT_BYTES = 4194304;
/** ReDoS guard: an override pattern may not exceed this length (§5.2). */
export const MAX_PATTERN_LENGTH = 512;

export const AliasSchema = z.string().regex(ALIAS_PATTERN, 'invalid host alias');

function compilesAsRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * One override pattern. Validated per element so the zod issue path points at
 * the offending index, which `doctor` prints verbatim (AC21.2).
 */
const PatternStringSchema = z
  .string()
  .max(MAX_PATTERN_LENGTH)
  .refine(compilesAsRegExp, { message: 'not a valid regular expression' });

const PatternListSchema = z.array(PatternStringSchema).default([]);

const PatternGroupSchema = z
  .object({
    add: PatternListSchema,
    remove: PatternListSchema,
  })
  .strict();

/** Fresh object per parse: a shared default could be mutated by a caller. */
function emptyPatternGroup(): { add: string[]; remove: string[] } {
  return { add: [], remove: [] };
}

/**
 * Per-host pattern overrides. Only `destructive` and `privileged` exist:
 * built-in patterns can be switched off individually, but arbitrary patterns
 * cannot be declared safe (§5.2).
 */
export const PatternOverridesSchema = z
  .object({
    destructive: PatternGroupSchema.default(emptyPatternGroup),
    privileged: PatternGroupSchema.default(emptyPatternGroup),
  })
  .strict();

export const HostKeySchema = z
  .object({
    algo: z.string().min(1),
    sha256: z.string().regex(HOST_KEY_SHA256_PATTERN, 'expected SHA256:<43 base64 chars>'),
  })
  .strict();

export const HostEntrySchema = z
  .object({
    hostname: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    user: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\s:]+$/, 'user must not contain whitespace or ":"'),
    privateKeyPath: z.string().min(1),
    hostKey: HostKeySchema,
    approvalMode: z.enum(APPROVAL_MODES).default(DEFAULT_APPROVAL_MODE),
    /**
     * Behaviour when the client cannot do elicitation (OPT-0).
     *
     * Deliberately optional with **no zod default**: `setup` always writes it
     * (D1), and a hand-edited entry that omits it is normalised to
     * `fail-closed` with one warning by `store.load()` (D2). Making it required
     * here would turn such a file into `config_invalid` and block every tool,
     * which is exactly what D2 rules out.
     */
    approvalFallback: z.enum(APPROVAL_FALLBACKS).optional(),
    auditMode: z.enum(AUDIT_MODES).default(DEFAULT_AUDIT_MODE),
    patternOverrides: PatternOverridesSchema.default(() => ({
      destructive: emptyPatternGroup(),
      privileged: emptyPatternGroup(),
    })),
    defaultTimeoutSec: z
      .number()
      .int()
      .min(MIN_TIMEOUT_SEC)
      .max(MAX_TIMEOUT_SEC)
      .default(DEFAULT_TIMEOUT_SEC),
    maxOutputBytes: z
      .number()
      .int()
      .min(MIN_MAX_OUTPUT_BYTES)
      .max(MAX_MAX_OUTPUT_BYTES)
      .default(DEFAULT_MAX_OUTPUT_BYTES),
    label: z.string().max(128).optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const HostsFileSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    hosts: z.record(AliasSchema, HostEntrySchema).default({}),
  })
  .strict();

export type HostKey = z.infer<typeof HostKeySchema>;
export type PatternOverrides = z.infer<typeof PatternOverridesSchema>;
export type HostEntry = z.infer<typeof HostEntrySchema>;
export type HostsFile = z.infer<typeof HostsFileSchema>;

/** Input shape: fields with a schema default may be omitted. */
export type HostEntryInput = z.input<typeof HostEntrySchema>;
export type HostsFileInput = z.input<typeof HostsFileSchema>;

/** An empty, valid registry — what `load()` returns when the file is absent. */
export function emptyHostsFile(): HostsFile {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, hosts: {} };
}
