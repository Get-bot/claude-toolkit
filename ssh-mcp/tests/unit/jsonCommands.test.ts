/**
 * The `format: "json"` table and the rewritability predicate (plan rows E3/E10,
 * AC-J2, AC-J2a, AC-J3, AC-J3a, AC-J4).
 *
 * The redirection block below is the reason this file exists. `>` and `<` do
 * not end a segment — the scanner turns them into operator tokens *inside* the
 * segment — so `docker ps > out.txt` passes the "one segment, empty terminator"
 * half of AC-J3a. Item 3 of the predicate is the only thing that stops it, and
 * a regression there would silently append `--format json` after a filename.
 */
import { describe, expect, it } from 'vitest';

import { isRewritable, JSON_COMMAND_TABLE, planRewrite } from '../../src/output/jsonCommands.js';
import { resolveCommand } from '../../src/output/resolve.js';
// The normalised forms and the column list are owned by `tables.ts`, next to the
// parsers that constrain them; this file imports them rather than restating
// them, which is the drift these tests exist to prevent.
import {
  DF_NORMALIZED_COMMAND,
  PS_COLUMNS,
  PS_NORMALIZED_COMMAND,
} from '../../src/output/tables.js';
import { classify } from '../../src/safety/classify.js';

describe('AC-J3a: the rewritability predicate', () => {
  it.each([
    'docker ps',
    'docker ps -a --no-trunc',
    'df -h /var',
    'sudo systemctl list-units',
    'env FOO=1 lsblk',
    // A quoted separator is data, not structure: one segment, no operator.
    'echo "a; b | c"',
    // An unexpanded variable is fine — it is not a substitution.
    'docker ps --filter name=$NAME',
  ])('accepts %j', (command) => {
    expect(isRewritable(command)).toBe(true);
  });

  it.each([
    // item 2 — a terminator ended the segment
    ['pipe', 'docker ps | head -n 5'],
    ['semicolon', 'docker ps; ls'],
    ['and', 'docker ps && ls'],
    ['or', 'docker ps || ls'],
    ['background', 'docker ps &'],
    ['newline', 'docker ps\nls'],
    // item 3 — redirections do NOT end a segment; only the operator check does
    ['stdout redirect', 'docker ps > out.txt'],
    ['append redirect', 'docker ps >> out.txt'],
    ['fd redirect', 'docker ps 2> err.txt'],
    ['clobber redirect', 'docker ps >| out.txt'],
    ['merge redirect', 'docker ps &> out.txt'],
    ['stdin redirect', 'lsblk < in.txt'],
    // item 1 — nested segments at any depth
    ['substitution', 'docker ps --format $(cat fmt)'],
    ['backticks', 'docker ps --filter `cat f`'],
    ['sh -c', "sh -c 'docker ps'"],
    // item 4
    ['here-doc', 'cat <<EOF\nbody\nEOF'],
    ['here-string', 'cat <<< hello'],
    ['unbalanced quote', 'docker "ps'],
  ])('refuses %s: %j', (_label, command) => {
    expect(isRewritable(command)).toBe(false);
  });

  it('refuses a redirect even though it is one segment with an empty terminator', () => {
    // Stated as its own test because it is the case that survives items 1, 2
    // and 4 and would pass if item 3 were dropped.
    expect(planRewrite('docker ps > out.txt')).toEqual({
      rewritable: false,
      command: 'docker ps > out.txt',
      plan: null,
      reason: 'not_rewritable',
    });
  });
});

describe('AC-J2: the whitelist table', () => {
  it.each([
    ['docker ps', 'docker ps --format json'],
    ['docker ps -a', 'docker ps -a --format json'],
    ['docker images', 'docker images --format json'],
    ['docker container ls', 'docker container ls --format json'],
    ['systemctl list-units', 'systemctl list-units --output=json'],
    ['systemctl list-timers --all', 'systemctl list-timers --all --output=json'],
    ['systemctl list-sockets', 'systemctl list-sockets --output=json'],
    ['journalctl -n 20', 'journalctl -n 20 -o json'],
    ['lsblk', 'lsblk -J'],
  ])('rewrites %j to %j', (raw, expected) => {
    const plan = planRewrite(raw);
    expect(plan).toEqual({
      rewritable: true,
      command: expected,
      plan: { kind: 'json' },
      reason: null,
    });
  });

  it('leaves docker inspect alone — it is already JSON', () => {
    const plan = planRewrite('docker inspect nginx');
    expect(plan.command).toBe('docker inspect nginx');
    expect(plan.plan).toEqual({ kind: 'json' });
  });

  it.each([
    ['ip addr', 'ip -j addr'],
    ['ip link show eth0', 'ip -j link show eth0'],
    ['ip route', 'ip -j route'],
    ['/sbin/ip addr', '/sbin/ip -j addr'],
  ])('inserts the ip flag before the object: %j', (raw, expected) => {
    // iproute2 stops looking for options at the first non-`-` word, so an
    // appended `-j` would be read as a device name and fail.
    expect(planRewrite(raw).command).toBe(expected);
  });

  it('keeps the privilege prefix and env assignments when it splices', () => {
    expect(planRewrite('sudo ip link').command).toBe('sudo ip -j link');
    expect(planRewrite('sudo df -h').command).toBe('sudo df -P');
    expect(planRewrite('env FOO=1 df -h').command).toBe('env FOO=1 df -P');
  });

  it.each([
    ['ls -la', 'ls -la'],
    ['cat /etc/hosts', 'cat /etc/hosts'],
    // A global flag before the subcommand is not the shape the table matches.
    ['docker -H tcp://x ps', 'docker -H tcp://x ps'],
    // A quoted program word cannot be located in the raw string, so no splice.
    ['"ip" addr', '"ip" addr'],
    // A trailing comment would swallow an appended flag.
    ['docker ps # note', 'docker ps # note'],
  ])('leaves %j unrewritten and falls back to a plain JSON parse', (raw, expected) => {
    const plan = planRewrite(raw);
    expect(plan).toEqual({
      rewritable: true,
      command: expected,
      plan: { kind: 'json' },
      reason: null,
    });
  });
});

describe('AC-J4: df normalises its flags but keeps its operands', () => {
  it.each([
    ['df', DF_NORMALIZED_COMMAND],
    ['df -h', 'df -P'],
    // The operand is the question the model asked. Dropping it would answer a
    // different, wider question without saying so.
    ['df -h /var', 'df -P /var'],
    ['df /var /home', 'df -P /var /home'],
    ['df --block-size=1M /var', 'df -P /var'],
    // `-x` and `-t` take a separate word, which goes with the flag rather than
    // being mistaken for a path.
    ['df -x tmpfs /var', 'df -P /var'],
    ['df -t ext4 --total /var', 'df -P /var'],
    ['sudo df -h /var', 'sudo df -P /var'],
    ['env FOO=1 df -h /var', 'env FOO=1 df -P /var'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(planRewrite(raw)).toEqual({
      rewritable: true,
      command: expected,
      plan: { kind: 'table', parser: 'df' },
      reason: null,
    });
  });

  it('re-attaches an unquoted operand as a raw slice, expansions intact', () => {
    // Rebuilding from the token value would single-quote `$MOUNT` and stop it
    // expanding, so the operand is sliced out of the raw string instead.
    expect(planRewrite('df -h $MOUNT').command).toBe('df -P $MOUNT');
    expect(planRewrite('df  -h   /var').command).toBe('df -P /var');
  });

  it.each(['df -h "/mnt/my disk"', "df -h '/mnt/my disk'", 'df -h /mnt/my\\ disk'])(
    'gives up on %j rather than guess where the operand ends',
    (raw) => {
      // A quoted or escaped word's value differs from its raw text, so it
      // cannot be sliced out safely. Refusing costs a table parse (the caller
      // falls back to JSON.parse and gets `invalid_json`), but the alternative
      // — dropping the operand — would answer a wider question than was asked,
      // which is the thing this whole block exists to prevent.
      expect(planRewrite(raw)).toEqual({
        rewritable: true,
        command: raw,
        plan: { kind: 'json' },
        reason: null,
      });
    }
  );
});

describe('AC-J4: ps normalises the whole argument list', () => {
  it.each(['ps', 'ps aux', 'ps -ef', 'ps -p 123', 'ps -u root'])(
    'normalises %j to the fixed column set',
    (raw) => {
      // Documented limitation, not an oversight: `ps` selection and format
      // flags are one grammar, so `-eo` widens `-p 123` to every process. The
      // file header explains it and Phase G puts it in the README.
      expect(planRewrite(raw)).toEqual({
        rewritable: true,
        command: `ps -eo ${PS_COLUMNS}`,
        plan: { kind: 'table', parser: 'ps' },
        reason: null,
      });
    }
  );

  it('keeps the privilege prefix even though it drops the arguments', () => {
    expect(planRewrite('sudo ps aux').command).toBe(`sudo ps -eo ${PS_COLUMNS}`);
  });

  it('keeps args last, which is what lets the parser take the remainder verbatim', () => {
    expect(PS_COLUMNS.split(',').at(-1)).toBe('args');
  });
});

describe('a flag that already asks for JSON is not added twice (PM-7)', () => {
  it.each([
    // The approver reads this string, so `lsblk -J -J` costs trust for nothing.
    ['lsblk -J', 'lsblk -J'],
    ['lsblk --json', 'lsblk --json'],
    // Matched on purpose, then skipped on purpose — not a table miss that
    // happens to come out right.
    ['ip -j addr', 'ip -j addr'],
    ['ip --json route show', 'ip --json route show'],
    ['systemctl list-units --output=json', 'systemctl list-units --output=json'],
  ])('leaves %j alone', (raw, expected) => {
    const plan = planRewrite(raw);
    expect(plan).toEqual({
      rewritable: true,
      command: expected,
      plan: { kind: 'json' },
      reason: null,
    });
  });

  it('still rewrites when the flag is absent', () => {
    expect(planRewrite('lsblk').command).toBe('lsblk -J');
    expect(planRewrite('ip addr').command).toBe('ip -j addr');
  });
});

describe('the rewritten command is what the fixed-column parsers expect', () => {
  // These are the tests that were missing. `jsonCommands.ts` and `tables.ts`
  // were written in separate lanes with different `ps` field lists, and both
  // suites stayed green because each asserted against its own constant. The
  // symptom in production would have been every `format: "json"` ps call on
  // every host returning `parse_error: "header_unrecognized"`.
  //
  // What fixed it is the single definition, not these tests: the list now has
  // one home (`tables.ts`) so two lists cannot exist. What these tests hold is
  // the way back in — a reintroduced local constant, a changed flag, `-e`
  // instead of `-eo` — by pinning the rewrite against the command the parser
  // actually reads rather than against a copy of it.
  it.each(['ps', 'ps aux', 'ps -ef', 'ps -p 123'])(
    'rewrites %j to exactly PS_NORMALIZED_COMMAND',
    (raw) => {
      expect(planRewrite(raw).command).toBe(PS_NORMALIZED_COMMAND);
    }
  );

  it.each(['df', 'df -h', 'df --block-size=1M'])(
    'rewrites %j to exactly DF_NORMALIZED_COMMAND',
    (raw) => {
      expect(planRewrite(raw).command).toBe(DF_NORMALIZED_COMMAND);
    }
  );

  it('carries the df flags through a privilege prefix', () => {
    // The rewrite splices the flags after whatever prefix the raw command had,
    // which is the only reason it needs them without the program attached.
    expect(planRewrite('sudo df -h').command).toBe(`sudo ${DF_NORMALIZED_COMMAND}`);
  });

  it('keeps an operand-restricted df pointed at the same parser', () => {
    expect(planRewrite('df -h /var').command).toBe(`${DF_NORMALIZED_COMMAND} /var`);
  });
});

describe('AC-J2a: rewriting never changes the grade or the reasons (PM-7)', () => {
  it.each(JSON_COMMAND_TABLE.map((entry) => [entry.example] as const))(
    'grades %j the same before and after',
    (example) => {
      const rewritten = planRewrite(example);
      expect(rewritten.rewritable).toBe(true);

      const before = classify(example);
      const after = classify(rewritten.command);
      expect(after.grade).toBe(before.grade);
      expect([...after.reasons].sort()).toEqual([...before.reasons].sort());
    }
  );

  it.each([
    'sudo systemctl list-units',
    'sudo df -h',
    'sudo ip link',
    'sudo docker ps',
    'sudo journalctl -n 5',
  ])('keeps the privileged grade of %j', (command) => {
    const before = classify(command);
    const after = classify(planRewrite(command).command);
    expect(after.grade).toBe(before.grade);
    expect([...after.reasons].sort()).toEqual([...before.reasons].sort());
  });

  // E10 extends the two blocks above rather than replacing them: the same
  // invariant, now checked through the door the tools actually use. A rewrite
  // reaches `approveCommand` and the audit line through `resolveCommand`, so
  // that is the function whose output has to grade identically — checking
  // `planRewrite` alone would miss a regression introduced in the branding
  // step between them.
  it.each(JSON_COMMAND_TABLE.map((entry) => [entry.example] as const))(
    'grades %j the same through resolveCommand',
    (example) => {
      const before = classify(example);
      const after = classify(resolveCommand(example, 'json').command);
      expect(after.grade).toBe(before.grade);
      expect([...after.reasons].sort()).toEqual([...before.reasons].sort());
    }
  );

  it.each(JSON_COMMAND_TABLE.map((entry) => [entry.example] as const))(
    'leaves %j untouched under format "text"',
    (example) => {
      // The invariant is trivially true here, and that is worth pinning: the
      // default path must not rewrite at all, so no table entry can change a
      // grade for a caller who never asked for JSON (AC-J1).
      expect(resolveCommand(example, 'text').command).toBe(example);
    }
  );

  it.each([
    // Commands AC-J3 refuses: the original runs, so the original is what is
    // graded, and the rewrite machinery must not have touched it.
    'docker ps | head -n 5',
    'df -h > out.txt',
    'ps aux; ls',
    'docker ps --format $(cat fmt)',
  ])('grades %j exactly as written, having refused to rewrite it', (command) => {
    const resolved = resolveCommand(command, 'json');
    expect(resolved.command).toBe(command);
    expect(resolved.parseError).toBe('not_rewritable');

    const before = classify(command);
    const after = classify(resolved.command);
    expect(after.grade).toBe(before.grade);
    expect([...after.reasons].sort()).toEqual([...before.reasons].sort());
  });
});
