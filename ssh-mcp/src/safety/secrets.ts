/**
 * Value-level secret masking for command strings (security finding F11).
 *
 * `redact()` in `log.ts` masks by *key name*, which cannot help here: a command
 * is one string, and `mysql -pHUNTER2` has no key. Everything that renders a
 * command for a human or writes it to `audit.jsonl` goes through
 * {@link maskCommandSecrets} first.
 *
 * Two rules govern what this may do:
 *
 *  - It never runs before classification. The classifier must see the real
 *    bytes, and a masked command would change what the patterns match.
 *  - It never runs before the confirmation-token binding hash. The round trip
 *    in AC17.2 compares the caller's original command against the hash taken at
 *    issue time, so both sides must be the unmasked string.
 *
 * Masking is deliberately lossy and one-way. It is not reversible and is not a
 * security boundary on its own — it only keeps a credential the user typed from
 * being copied into a log file or an approval dialog.
 */

/** Replaces a masked value. Fixed width so a reader cannot infer the length. */
export const SECRET_PLACEHOLDER = '[redacted]';

interface MaskRule {
  id: string;
  re: RegExp;
  /** Rebuild the match with group 1 kept and the secret replaced. */
  replace: (match: string, keep: string) => string;
}

const KEEP_PREFIX = (_match: string, keep: string): string => `${keep}${SECRET_PLACEHOLDER}`;

/**
 * Option names whose value is a credential. `pass` covers `--pass`,
 * `--password` and `--passwd`; the list is matched case-insensitively.
 */
const SECRET_OPTION =
  '(?:password|passwd|pass|token|secret|api[-_]?key|apikey|auth[-_]?token|access[-_]?key|private[-_]?key|credential|passphrase)';

/** Environment-assignment names treated as credentials. */
const SECRET_ENV =
  '(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSPHRASE)[A-Z0-9_]*|KEY)';

const RULES: readonly MaskRule[] = [
  {
    // `--password=x`, `--token x`, `-p x`, and the MySQL `-pSECRET` form.
    id: 'long-option',
    re: new RegExp(`(--${SECRET_OPTION}[=\\s]+)(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'),
    replace: KEEP_PREFIX,
  },
  {
    id: 'short-option-attached',
    // `-pHUNTER2` / `-uroot -pHUNTER2`. A bare `-p` with no attached value is
    // left alone: there is nothing to hide and the next token may be a path.
    re: /(\s-p)(?:"[^"]*"|'[^']*'|[^\s-]\S*)/g,
    replace: KEEP_PREFIX,
  },
  {
    id: 'short-option-spaced',
    re: /(\s-(?:p|P|k)\s+)(?:"[^"]*"|'[^']*'|\S+)/g,
    replace: KEEP_PREFIX,
  },
  {
    id: 'bearer',
    re: /(\bBearer\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: KEEP_PREFIX,
  },
  {
    id: 'authorization-header',
    re: /(\bauthorization\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s"']+(?:\s+[^\s"']+)?)/gi,
    replace: KEEP_PREFIX,
  },
  {
    id: 'env-assignment',
    re: new RegExp(`(\\b${SECRET_ENV}=)(?:"[^"]*"|'[^']*'|\\S+)`, 'g'),
    replace: KEEP_PREFIX,
  },
];

/**
 * Replace credential values in `command` with {@link SECRET_PLACEHOLDER}.
 *
 * Call this on anything a human or a log file will see. Never call it on the
 * string handed to {@link import('./classify.js').classify} or to the token
 * store.
 */
export function maskCommandSecrets(command: string): string {
  let out = command;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace);
  }
  return out;
}

/** True when {@link maskCommandSecrets} would change `command`. */
export function containsSecret(command: string): boolean {
  return maskCommandSecrets(command) !== command;
}
