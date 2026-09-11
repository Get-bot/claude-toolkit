import { describe, expect, it } from 'vitest';

import { classify } from '../../src/safety/classify.js';
import {
  CONDITIONAL_PROGRAMS,
  UNCONDITIONAL_PROGRAMS,
  checkInteractive,
} from '../../src/safety/interactive.js';

describe('list sizes (OPT-1)', () => {
  it('has 21 unconditionally refused programs', () => {
    expect(UNCONDITIONAL_PROGRAMS).toHaveLength(21);
  });

  it('has 13 argument-conditional programs', () => {
    expect(CONDITIONAL_PROGRAMS).toHaveLength(13);
  });

  it('keeps top off the unconditional list and htop on it', () => {
    // `top -b` prints once and exits, so `top` is argument-conditional.
    // `htop` has no batch mode, so nothing about its arguments can save it.
    expect(UNCONDITIONAL_PROGRAMS).not.toContain('top');
    expect(CONDITIONAL_PROGRAMS).toContain('top');
    expect(UNCONDITIONAL_PROGRAMS).toContain('htop');
  });
});

describe('unconditional refusals', () => {
  for (const program of UNCONDITIONAL_PROGRAMS) {
    it(`refuses ${program}`, () => {
      const verdict = checkInteractive(`${program} somefile`);
      expect(verdict.refused).toBe(true);
      if (verdict.refused) {
        expect(verdict.program).toBe(program);
        expect(verdict.alternatives.length).toBeGreaterThan(0);
      }
    });
  }

  it('refuses a path-qualified interactive program', () => {
    expect(checkInteractive('/usr/bin/vim /etc/hosts').refused).toBe(true);
  });

  it('refuses one inside sudo', () => {
    const verdict = checkInteractive('sudo visudo');
    expect(verdict.refused).toBe(true);
    if (verdict.refused) expect(verdict.program).toBe('visudo');
  });

  it('refuses one inside a pipeline segment', () => {
    expect(checkInteractive('cat /var/log/syslog | less').refused).toBe(true);
  });

  it('refuses one inside sh -c', () => {
    expect(checkInteractive('bash -c "vim /etc/hosts"').refused).toBe(true);
  });

  it('keeps refusing less --version and says what to run instead', () => {
    // OPT-1 deliberately has no argument escape hatch for the unconditional
    // list: an exception here would have to be right for every pager flag.
    const verdict = checkInteractive('less --version');
    expect(verdict.refused).toBe(true);
    if (verdict.refused) expect(verdict.alternatives.join(' ')).toContain('sed -n');
  });
});

describe('argument-conditional refusals', () => {
  const refused: string[] = [
    'top',
    'top -n 1',
    'mysql',
    'mysql -u root mydb',
    'psql',
    'psql -U postgres mydb',
    'redis-cli',
    'python',
    'python3',
    'node',
    'irb',
    'ruby',
    'git commit',
    'git rebase -i main',
    'git add -i',
    'git add -p src/',
    'crontab -e',
    'systemctl edit nginx',
    'ssh',
    'ssh prod',
  ];

  const allowed: string[] = [
    'top -b -n 1',
    'top -b -n1',
    'top -bn1',
    'top --batch-mode -n 1',
    'mysql -e "SELECT 1"',
    'mysql --execute="SELECT 1"',
    'psql -c "SELECT 1"',
    'psql -f setup.sql',
    'redis-cli GET key',
    'python3 -c "print(1)"',
    'python3 script.py',
    'node --version',
    'node server.js',
    'ruby -e "puts 1"',
    'git commit -m "x"',
    'git commit --no-edit --amend',
    'git rebase main',
    'git add src/',
    'crontab -l',
    'systemctl status nginx',
    'ssh prod uptime',
  ];

  for (const command of refused) {
    it(`refuses ${command}`, () => {
      expect(checkInteractive(command).refused).toBe(true);
    });
  }

  for (const command of allowed) {
    it(`allows ${command}`, () => {
      expect(checkInteractive(command).refused).toBe(false);
    });
  }
});

describe('the gate is not a risk judgement (Critic C14)', () => {
  it('lets mysql -e through and leaves the danger to the classifier', () => {
    const command = 'mysql -e "DROP TABLE t"';
    expect(checkInteractive(command).refused).toBe(false);
    expect(classify(command).grade).toBe('destructive');
  });

  it('lets redis-cli FLUSHALL through and leaves the danger to the classifier', () => {
    const command = 'redis-cli FLUSHALL';
    expect(checkInteractive(command).refused).toBe(false);
    expect(classify(command).grade).toBe('destructive');
  });

  it('lets the §6.1 safe-corpus row top -b -n1 pass both gates', () => {
    // The corpus grades it `safe`; after the top ruling the interactive gate
    // must agree, otherwise the row could never actually run.
    expect(checkInteractive('top -b -n1').refused).toBe(false);
    expect(classify('top -b -n1').grade).toBe('safe');
  });

  it('suggests batch mode when it refuses bare top', () => {
    const verdict = checkInteractive('top');
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.alternatives[0]).toBe('top -b -n 1');
      expect(verdict.alternatives).toContain('ps aux --sort=-%cpu | head -20');
      // A suggestion the gate would itself refuse is worse than none.
      expect(
        verdict.alternatives.filter((alternative) => checkInteractive(alternative).refused),
      ).toEqual([]);
    }
  });
});

describe('ordinary commands are untouched', () => {
  for (const command of [
    'ls -la',
    'git status',
    'docker ps',
    'grep -rn "less" .',
    'echo "run vim later"',
    'systemctl list-units --type=service',
    'cat app.log | grep ERROR | head -20',
  ]) {
    it(`allows ${command}`, () => {
      expect(checkInteractive(command).refused).toBe(false);
    });
  }
});
