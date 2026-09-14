/**
 * Classification pattern table (plan row 2.6, §5.4).
 *
 * Two things about the shape of this file matter more than the individual
 * regexes:
 *
 *  1. **`scope`** (OPT-4b). A pattern either looks at one command
 *     (`scope: 'segment'`) or at the whole pipeline (`scope: 'whole'`).
 *     `curl … | sh` is only visible in the second form, because segment
 *     splitting cuts the pipeline apart before any pattern runs.
 *  2. **The command-name prefix is attached at compile time.** Every
 *     `^`-anchored source gets a path-prefix group inserted just after the
 *     anchor so that
 *     `/bin/rm -rf` cannot walk around `^rm`. The un-prefixed source is kept in
 *     {@link PatternDef.source}; that is the exact string `ssh-mcp doctor`
 *     prints and the exact string a host may put in
 *     `patternOverrides.<grade>.remove` (AC21.9).
 *
 * There is deliberately no allow mechanism: a host can switch a built-in
 * pattern off and can add patterns, but nothing can declare a command safe
 * (plan F8, enforced by `HostsFileSchema.strict()`). Since security finding F7
 * a host cannot switch off a {@link CORE_PATTERN_IDS} entry either.
 *
 * Some checks are not regexes at all. Anything that depends on *argv position*
 * — is `rm` the program, is this path the destination — lives in
 * `classify.ts`, because a regex over a flattened string cannot tell a source
 * argument from a destination one. Those rules cannot be switched off.
 */
import type { PatternOverrides } from '../config/schema.js';
import { logger } from '../log.js';

export type PatternScope = 'whole' | 'segment';
export type PatternGrade = 'destructive' | 'privileged';

export interface PatternDef {
  /** Stable id, e.g. `rm-recursive`. Reported as `<grade>:<id>` (AC16.2). */
  id: string;
  scope: PatternScope;
  grade: PatternGrade;
  /** One line a human can read in a denial message. */
  reason: string;
  /** Regex source before the command-name prefix is attached. */
  source: string;
  /** Compiled form, prefix attached. */
  re: RegExp;
}

/** `<grade>:<id>`, the string that appears in `reasons` (AC16.2). */
export function patternReasonId(pattern: Pick<PatternDef, 'grade' | 'id'>): string {
  return `${pattern.grade}:${pattern.id}`;
}

/** Inserted before a command name so `/bin/rm` and `rm` behave alike. */
export const COMMAND_PATH_PREFIX = '(?:\\S*/)?';
/** Start-of-command anchor for `scope: 'whole'` patterns. */
export const WHOLE_START = '(?:^|[;&|]\\s*)';

/**
 * System paths whose modification is treated as destructive regardless of the
 * command used to do it (§5.4 `SYSDIR`).
 */
const SYSDIR =
  '(?:~/|\\$HOME/|\\$\\{HOME\\}/|/(?:etc|var|usr|opt|boot|srv|lib|lib64|bin|sbin|root|home)(?:/|\\s|$))';

/**
 * The subset of {@link SYSDIR} where even an *append* is destructive: one line
 * added to `/etc/passwd` or `/etc/sudoers` is a new root account. Appending to
 * `/var/log/app.log` is ordinary, which is why `/var` is not in this list (F8).
 */
const CRITICAL_DIR = '/(?:etc|usr|bin|sbin|boot|lib|lib64|root)(?:/|\\s|$)';

/** Block devices: writing to one destroys a filesystem. */
const BLOCKDEV = '/dev/(?:sd[a-z]|nvme\\d|hd[a-z]|vd[a-z]|mmcblk\\d|disk\\d|xvd[a-z])';

/** Anything that will execute text handed to it on stdin or as an argument. */
const INTERPRETER = '(?:python3?|perl|ruby|node|php|(?:ba|z|k|da|a)?sh)';

/** Files whose contents are credentials (security finding F5). */
const SECRET_PATH =
  '(?:/etc/(?:shadow|gshadow|sudoers)\\b|id_(?:rsa|dsa|ecdsa|ed25519)\\b|\\.aws/credentials\\b|\\.netrc\\b|\\.npmrc\\b|\\.env(?:\\s|$|\\.)|\\.pem\\b|\\.kube/config\\b)';

interface PatternSpec {
  id: string;
  scope: PatternScope;
  reason: string;
  source: string;
  /** Attach {@link COMMAND_PATH_PREFIX}. Default `true`. */
  prefix?: boolean;
  /** Extra regex flags on top of the default (none). */
  flags?: string;
}

/**
 * Insert the path prefix after the anchor. `whole` sources that start with
 * {@link WHOLE_START} get it after that group so `| /usr/bin/tee /etc/x` still
 * matches.
 */
export function attachCommandPrefix(source: string): string {
  if (source.startsWith(WHOLE_START)) {
    return WHOLE_START + COMMAND_PATH_PREFIX + source.slice(WHOLE_START.length);
  }
  if (source.startsWith('^')) {
    return `^${COMMAND_PATH_PREFIX}${source.slice(1)}`;
  }
  return source;
}

function compile(grade: PatternGrade, spec: PatternSpec): PatternDef {
  const withPrefix = spec.prefix === false ? spec.source : attachCommandPrefix(spec.source);
  return {
    id: spec.id,
    scope: spec.scope,
    grade,
    reason: spec.reason,
    source: spec.source,
    re: new RegExp(withPrefix, spec.flags ?? ''),
  };
}

// --------------------------------------------------------------------------
// destructive
// --------------------------------------------------------------------------

const DESTRUCTIVE_SPECS: readonly PatternSpec[] = [
  {
    id: 'rm-recursive',
    scope: 'segment',
    reason: 'rm with -r or -f deletes whole trees',
    source: '^rm\\s+(?:-\\S*[rRf]\\S*\\s+)',
  },
  {
    id: 'rm-longopt',
    scope: 'segment',
    reason: 'rm --recursive / --force deletes whole trees',
    source: '^rm\\s+.*--(?:recursive|force)\\b',
  },
  {
    id: 'rm-postfix-flags',
    scope: 'segment',
    reason: 'GNU rm accepts flags after the path (rm /etc/nginx -rf)',
    source: '^rm\\s+\\S+.*\\s-\\S*[rRf]',
  },
  {
    id: 'rm-any-target',
    scope: 'segment',
    reason: 'rm deletes files',
    source: '^rm\\s+(?!-)\\S',
  },
  {
    id: 'shred',
    scope: 'segment',
    reason: 'shred/wipe overwrites data irrecoverably',
    source: '^(?:shred|wipe)\\b',
  },
  {
    id: 'mkfs',
    scope: 'segment',
    reason: 'mkfs formats a filesystem',
    source: '^mkfs(?:\\.\\w+)?\\b',
  },
  {
    id: 'dd-device',
    scope: 'segment',
    reason: 'dd writing to a device destroys the disk',
    source: '^dd\\b.*\\bof=/dev/',
  },
  {
    id: 'dd-to-path',
    scope: 'segment',
    reason: 'dd overwriting a system path destroys data',
    source: `^dd\\b.*\\bof=${SYSDIR}`,
  },
  {
    id: 'disk-tool',
    scope: 'segment',
    reason: 'partition editors rewrite the partition table',
    source: '^(?:fdisk|parted|sgdisk|gdisk|cfdisk)\\b',
  },
  {
    id: 'power',
    scope: 'segment',
    reason: 'shutting the host down ends every session on it',
    source:
      '^(?:(?:shutdown|reboot|halt|poweroff)\\b|init\\s+[06]\\b|systemctl\\s+(?:poweroff|reboot|halt|kexec|emergency|rescue|isolate)\\b)',
  },
  {
    id: 'chmod-777',
    scope: 'segment',
    reason: 'chmod 777 removes all access control',
    source: '^chmod\\s+(?:-R\\s+|--recursive\\s+)?0?777\\b',
  },
  {
    id: 'chown-root-recursive',
    scope: 'segment',
    reason: 'recursive chown on a system tree breaks the installation',
    source: `^chown\\s+(?:-R|--recursive)\\b.*\\s(?:${SYSDIR}|/(?:\\s|$))`,
  },
  {
    id: 'fork-bomb',
    scope: 'whole',
    reason: 'fork bomb: exhausts the process table',
    source: ':\\(\\)\\s*\\{.*\\}\\s*;\\s*:',
    prefix: false,
  },
  {
    id: 'pipe-to-shell',
    scope: 'whole',
    reason: 'downloading code straight into an interpreter runs unreviewed code',
    source: `(?:\\S*/)?(?:curl|wget|fetch)\\b[^|]*\\|\\s*(?:sudo\\s+)?\\S*${INTERPRETER}\\b`,
    prefix: false,
  },
  {
    id: 'b64-to-shell',
    scope: 'whole',
    reason: 'base64 decoded into a shell hides what is executed',
    source: `\\|\\s*(?:\\S*/)?base64\\s+-\\S*[dD]\\S*\\s*\\|\\s*\\S*${INTERPRETER}\\b`,
    prefix: false,
  },
  {
    id: 'xargs-destructive',
    scope: 'whole',
    reason: 'xargs fanning out rm/shred/kill over unknown input',
    source: '(?:^|\\|)\\s*(?:\\S*/)?xargs\\b.*?\\s(?:rm|shred|kill)\\b',
    prefix: false,
  },
  {
    id: 'git-force-push',
    scope: 'segment',
    reason: 'force push overwrites remote history',
    // `--force-with-lease` is deliberately excluded: it refuses when the remote
    // moved, which is the whole point of it (F8). It is privileged instead.
    source: '^git\\s+push\\b.*\\s(?:--force(?![-\\w])|-f)\\b',
  },
  {
    id: 'git-reset-hard',
    scope: 'segment',
    reason: 'git reset --hard discards uncommitted work',
    source: '^git\\s+reset\\s+(?:--hard|--merge)\\b',
  },
  {
    id: 'git-clean-force',
    scope: 'segment',
    reason: 'git clean -f deletes untracked files',
    source: '^git\\s+clean\\s+-\\S*f',
  },
  {
    id: 'git-checkout-discard',
    scope: 'segment',
    reason: 'checkout/restore with -- reverts the working tree',
    source: '^git\\s+(?:checkout|restore)\\s+--(?:\\s|$)',
  },
  {
    id: 'redirect-truncate',
    scope: 'whole',
    reason: 'redirection truncates the target file, whatever the command is',
    // `>` only. `>>` appends, and appending to a log file is ordinary (F8);
    // the critical subset is covered by `redirect-append-critical`.
    source: `${WHOLE_START}[^;&|<>]*>(?!>)\\s*${SYSDIR}`,
  },
  {
    id: 'redirect-append-critical',
    scope: 'whole',
    reason: 'appending to a system configuration file can add an account or a rule',
    source: `${WHOLE_START}[^;&|<>]*>>\\s*${CRITICAL_DIR}`,
  },
  {
    id: 'redirect-device',
    scope: 'whole',
    reason: 'redirection into a block device destroys the filesystem',
    source: `${WHOLE_START}[^;&|<>]*>{1,2}\\s*${BLOCKDEV}`,
  },
  {
    id: 'tee-system',
    scope: 'whole',
    reason: 'tee writes over a system file',
    source: `${WHOLE_START}(?:sudo\\s+)?tee\\s+(?:-a\\s+)?${SYSDIR}`,
  },
  {
    id: 'move-from-system',
    scope: 'segment',
    reason: 'moving a system directory away is a deletion in practice',
    source: `^mv\\s+${SYSDIR}`,
  },
  {
    id: 'awk-system',
    scope: 'whole',
    reason: 'awk system() runs an arbitrary shell command',
    source: '\\bawk\\b[^|;]*\\bsystem\\s*\\(',
    prefix: false,
  },
  {
    id: 'user-delete',
    scope: 'segment',
    reason: 'deleting a user or group removes access and home data',
    source: '^(?:userdel|groupdel)\\b',
  },
  {
    id: 'firewall-flush',
    scope: 'segment',
    reason: 'flushing firewall rules can expose or cut off the host',
    source: '^(?:iptables|ip6tables|nft)\\b.*\\s(?:-F|flush)\\b',
  },
  {
    id: 'container-destroy',
    scope: 'segment',
    reason: 'removing containers, images or volumes destroys their data',
    source:
      '^(?:docker|podman)\\s+(?:rm|rmi|volume\\s+rm|system\\s+prune|image\\s+prune|container\\s+rm|network\\s+rm)\\b',
  },
  {
    id: 'compose-down-volumes',
    scope: 'segment',
    reason: 'compose down -v deletes the stack volumes',
    source: '^docker(?:\\s+compose|-compose)\\s+down\\b.*\\s(?:-v|--volumes)\\b',
  },
  {
    id: 'k8s-delete',
    scope: 'segment',
    reason: 'kubectl delete removes cluster resources',
    source: '^kubectl\\s+delete\\b',
  },
  {
    id: 'db-client-destructive',
    scope: 'segment',
    reason: 'SQL client running DROP, TRUNCATE or DELETE FROM',
    source:
      '^(?:mysql|psql|mariadb)\\b.*\\s(?:-e|--execute|-c)\\s.*\\b(?:DROP|TRUNCATE|DELETE\\s+FROM)\\b',
    flags: 'i',
  },
  {
    id: 'mongo-destructive',
    scope: 'segment',
    reason: 'mongo --eval dropping or deleting documents',
    source: '^mongo(?:sh)?\\b.*--eval\\b.*\\b(?:drop\\w*|deleteMany|remove)\\s*\\(',
    flags: 'i',
  },
  {
    id: 'redis-flush',
    scope: 'segment',
    reason: 'FLUSHALL / FLUSHDB empties the keyspace',
    source: '^redis-cli\\b.*\\bFLUSH(?:ALL|DB)\\b',
    flags: 'i',
  },
  {
    id: 'rsync-delete',
    scope: 'segment',
    reason: 'rsync --delete removes files missing from the source',
    source: '^rsync\\b.*\\s--delete(?:-\\w+)?\\b',
  },
  {
    id: 'iac-destroy',
    scope: 'segment',
    reason: 'infrastructure teardown destroys live resources',
    source: '^(?:(?:terraform|tofu)\\s+destroy\\b|pulumi\\s+destroy\\b|helm\\s+uninstall\\b)',
  },
  {
    id: 'cloud-bulk-delete',
    scope: 'segment',
    reason: 'bulk delete against a cloud provider',
    source:
      '^(?:aws\\s+s3\\s+rm\\b.*\\s--recursive\\b|gcloud\\s+\\S+\\s+delete\\b|az\\s+\\S+\\s+delete\\b)',
  },
  {
    id: 'find-delete',
    scope: 'whole',
    // Widened from `-delete`/`-exec rm` (F4): `find … -exec truncate {} +` and
    // `-exec tee` destroy just as thoroughly, and enumerating the safe
    // commands is the wrong side of that bet.
    reason: 'find runs a command over every match, or deletes them',
    source: '\\bfind\\b.*(?:-delete\\b|-(?:exec|ok)(?:dir)?\\s+\\S)',
    prefix: false,
  },
  {
    id: 'crontab-remove',
    scope: 'segment',
    reason: 'crontab -r deletes the whole crontab',
    source: '^crontab\\s+-r\\b',
  },
  {
    id: 'truncate-file',
    scope: 'segment',
    reason: 'truncate -s 0 empties a file',
    source: '^truncate\\s+-s\\s*0\\b',
  },
  {
    id: 'kill-all',
    scope: 'segment',
    reason: 'kill -9 -1 signals every process the user owns',
    source: '^kill\\s+(?:-9|-KILL|-s\\s*(?:9|KILL))\\s+-1\\b',
  },
  {
    id: 'netcat-exec',
    scope: 'segment',
    reason: 'netcat wired to a program is a reverse shell',
    source: '^(?:nc|ncat|netcat)\\b.*\\s-(?:e|c)\\b',
  },
];

// --------------------------------------------------------------------------
// privileged
// --------------------------------------------------------------------------

const PRIVILEGED_SPECS: readonly PatternSpec[] = [
  {
    id: 'sudo',
    scope: 'segment',
    reason: 'runs as another user via sudo',
    // `^sudo\b` does not match `sudoedit` (no word boundary inside a word), so
    // both names are listed explicitly (F4).
    source: '^(?:sudo|sudoedit|pkexec)\\b',
  },
  {
    id: 'su',
    scope: 'segment',
    reason: 'switches user identity',
    source: '^(?:su|doas|runuser)\\b',
  },
  {
    id: 'systemctl-mutate',
    scope: 'segment',
    reason: 'changes service state',
    source:
      '^systemctl\\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|kill|set-property|edit|link|revert|preset|set-default)\\b',
  },
  {
    id: 'service-mutate',
    scope: 'segment',
    reason: 'changes service state',
    source: '^service\\s+\\S+\\s+(?:start|stop|restart|reload)\\b',
  },
  {
    id: 'apt',
    scope: 'segment',
    reason: 'installs or removes system packages',
    source:
      '^(?:apt|apt-get|aptitude)\\s+(?:install|remove|purge|upgrade|dist-upgrade|autoremove)\\b',
  },
  {
    id: 'yum-dnf',
    scope: 'segment',
    reason: 'installs or removes system packages',
    source: '^(?:yum|dnf|microdnf)\\s+(?:install|remove|erase|update|upgrade)\\b',
  },
  {
    id: 'pacman',
    scope: 'segment',
    reason: 'installs or removes system packages',
    source: '^pacman\\s+-\\S*[SRU]',
  },
  {
    id: 'apk',
    scope: 'segment',
    reason: 'installs or removes system packages',
    source: '^apk\\s+(?:add|del|upgrade)\\b',
  },
  {
    id: 'brew',
    scope: 'segment',
    reason: 'installs or removes packages',
    source: '^brew\\s+(?:install|uninstall|upgrade)\\b',
  },
  {
    id: 'npm-global',
    scope: 'segment',
    reason: 'installs a package globally',
    source: '^(?:npm|pnpm|yarn)\\s+\\S*(?:install|add|i)\\b.*\\s(?:-g|--global)\\b',
  },
  {
    id: 'pip-install',
    scope: 'segment',
    reason: 'installs a Python package',
    source: '^(?:pip|pip3)\\s+install\\b',
  },
  {
    id: 'user-mutate',
    scope: 'segment',
    reason: 'changes accounts, passwords or sudo policy',
    source: '^(?:useradd|usermod|groupadd|groupmod|passwd|visudo|chpasswd|chsh)\\b',
  },
  {
    id: 'firewall-config',
    scope: 'segment',
    reason: 'changes firewall rules',
    source: '^(?:ufw|firewall-cmd)\\b',
  },
  {
    id: 'iptables-mutate',
    scope: 'segment',
    reason: 'changes packet filter rules',
    // `iptables -L/-S/-n` only reads, and grading a read privileged is the
    // kind of false positive that pushes a user to `approvalMode: auto` (F8).
    source:
      '^(?:(?:iptables|ip6tables)\\b.*\\s-(?:A|I|D|R|N|X|P|Z|E)\\b|nft\\s+(?:add|delete|insert|create|replace|rename)\\b)',
  },
  {
    id: 'mount',
    scope: 'segment',
    reason: 'mounts or unmounts a filesystem',
    // Bare `mount` and `mount -l` only list what is mounted (F8).
    source: '^(?:mount|umount)\\s+(?!-[lhV]\\b)\\S',
  },
  {
    id: 'kernel-module',
    scope: 'segment',
    reason: 'loads or unloads a kernel module',
    source: '^(?:modprobe|insmod|rmmod)\\b',
  },
  {
    id: 'sysctl-write',
    scope: 'segment',
    reason: 'changes a kernel parameter',
    source: '^sysctl\\s+-w\\b',
  },
  {
    id: 'git-force-lease',
    scope: 'segment',
    reason: 'force push with a lease still rewrites remote history',
    source: '^git\\s+push\\b.*\\s--force-with-lease\\b',
  },
  {
    id: 'remote-copy',
    scope: 'segment',
    reason: 'copies files to or from another host',
    source: '^(?:scp|rsync|sftp)\\b.*\\s[^\\s/]+@[^\\s:]+:',
  },
  {
    id: 'secret-read',
    scope: 'segment',
    reason: 'reads a file that holds credentials',
    source: `^(?:cat|less|more|head|tail|strings|xxd|od|base64|cp|mv|scp|grep|awk|sed|tar|zip)\\b.*${SECRET_PATH}`,
  },
  {
    id: 'crontab-write',
    scope: 'segment',
    reason: 'installs a crontab, which survives reboots',
    source: '^crontab\\s+(?!-l\\b)\\S',
  },
  {
    id: 'at-schedule',
    scope: 'segment',
    reason: 'schedules a command to run later, outside this session',
    source: '^(?:at|batch)\\s+\\S',
  },
  {
    id: 'systemd-run',
    scope: 'segment',
    reason: 'starts a transient unit that outlives this session',
    source: '^systemd-run\\b',
  },
  {
    id: 'file-attributes',
    scope: 'segment',
    reason: 'changes file attributes or ACLs',
    source: '^(?:chattr|setfacl|setcap)\\b',
  },
  {
    id: 'docker-mount-host',
    scope: 'segment',
    reason: 'a bind mount gives the container the host filesystem',
    source: '^(?:docker|podman)\\s+run\\b.*\\s(?:-v|--volume|--mount)\\b',
  },
  {
    id: 'docker-exec',
    scope: 'segment',
    reason: 'runs a command inside a running container',
    source: '^(?:docker|podman)\\s+exec\\b',
  },
];

/** Every built-in pattern, destructive first. */
export const PATTERNS: readonly PatternDef[] = [
  ...DESTRUCTIVE_SPECS.map((spec) => compile('destructive', spec)),
  ...PRIVILEGED_SPECS.map((spec) => compile('privileged', spec)),
];

export const DESTRUCTIVE_PATTERN_COUNT = DESTRUCTIVE_SPECS.length;
export const PRIVILEGED_PATTERN_COUNT = PRIVILEGED_SPECS.length;

/**
 * Patterns a host may not switch off (security finding F7).
 *
 * `patternOverrides.remove` exists so an operator can silence a pattern that is
 * wrong for their fleet. It was not meant to be able to make `rm -rf /` safe,
 * and before this list one line in `hosts.json` could do exactly that. A
 * removal naming one of these is ignored with a warning rather than rejected,
 * because refusing the whole file would take every other host down with it.
 */
export const CORE_PATTERN_IDS: readonly string[] = [
  'rm-recursive',
  'rm-longopt',
  'rm-postfix-flags',
  'rm-any-target',
  'mkfs',
  'dd-device',
  'dd-to-path',
  'fork-bomb',
  'pipe-to-shell',
  'b64-to-shell',
  'redirect-truncate',
  'redirect-append-critical',
  'redirect-device',
  'power',
  'shred',
  'disk-tool',
  'netcat-exec',
];

const CORE_ID_SET = new Set(CORE_PATTERN_IDS);

const CORE_SOURCE_SET = new Set(
  PATTERNS.filter((pattern) => CORE_ID_SET.has(pattern.id)).map((pattern) => pattern.source)
);

/**
 * Core pattern ids missing from `patterns`. `doctor` fails when this is
 * non-empty, which catches a build that dropped one as well as a bad override.
 */
export function missingCorePatterns(patterns: readonly PatternDef[] = PATTERNS): string[] {
  const present = new Set(patterns.map((pattern) => pattern.id));
  return CORE_PATTERN_IDS.filter((id) => !present.has(id));
}

function isEmptyGroup(group: { add: string[]; remove: string[] } | undefined): boolean {
  return group === undefined || (group.add.length === 0 && group.remove.length === 0);
}

/**
 * A host-supplied pattern is registered at both scopes.
 *
 * We cannot know whether the author meant "one command" or "the whole
 * pipeline", and a missed match is the expensive mistake. Reasons are deduped
 * by id so the same pattern is never reported twice.
 */
function compileOverrideAdds(grade: PatternGrade, sources: readonly string[]): PatternDef[] {
  const out: PatternDef[] = [];
  sources.forEach((source, index) => {
    const id = `custom-${grade}-${String(index + 1)}`;
    let re: RegExp;
    try {
      re = new RegExp(attachCommandPrefix(source));
    } catch {
      // `HostEntrySchema` already refuses an uncompilable pattern; if one still
      // reaches here the safe move is to drop it rather than crash the tool.
      return;
    }
    const reason = 'host-configured pattern';
    out.push({ id, scope: 'segment', grade, reason, source, re });
    out.push({ id, scope: 'whole', grade, reason, source, re });
  });
  return out;
}

const overrideCache = new WeakMap<PatternOverrides, readonly PatternDef[]>();

/**
 * Built-ins with this host's `remove` entries dropped and `add` entries
 * appended (plan §5.4).
 *
 * `remove` matches a built-in by its exact {@link PatternDef.source} — the
 * string `doctor` prints, so the round trip in AC21.9 holds — or by its `id`,
 * which is what a user reaches for first. A {@link CORE_PATTERN_IDS} entry is
 * never removed (F7).
 */
export function compilePatterns(overrides?: PatternOverrides): readonly PatternDef[] {
  if (overrides === undefined) return PATTERNS;
  if (isEmptyGroup(overrides.destructive) && isEmptyGroup(overrides.privileged)) return PATTERNS;

  const cached = overrideCache.get(overrides);
  if (cached !== undefined) return cached;

  const requested = [
    ...(overrides.destructive?.remove ?? []),
    ...(overrides.privileged?.remove ?? []),
  ];
  const refused = requested.filter((entry) => CORE_ID_SET.has(entry) || CORE_SOURCE_SET.has(entry));
  if (refused.length > 0) {
    logger.warn('ignoring patternOverrides.remove entries for core patterns', {
      entries: refused,
    });
  }

  const removals = new Map<PatternGrade, Set<string>>([
    ['destructive', new Set(overrides.destructive?.remove ?? [])],
    ['privileged', new Set(overrides.privileged?.remove ?? [])],
  ]);

  const kept = PATTERNS.filter((pattern) => {
    if (CORE_ID_SET.has(pattern.id)) return true;
    const remove = removals.get(pattern.grade);
    if (remove === undefined) return true;
    return !remove.has(pattern.source) && !remove.has(pattern.id);
  });

  const compiled: readonly PatternDef[] = [
    ...kept,
    ...compileOverrideAdds('destructive', overrides.destructive?.add ?? []),
    ...compileOverrideAdds('privileged', overrides.privileged?.add ?? []),
  ];
  overrideCache.set(overrides, compiled);
  return compiled;
}
