import { describe, expect, it } from 'vitest';

import { classify } from '../../src/safety/classify.js';
import {
  CONDITIONAL_PROGRAMS,
  UNCONDITIONAL_PROGRAMS,
  checkInteractive,
} from '../../src/safety/interactive.js';

describe('list sizes (OPT-1)', () => {
  it('has 22 unconditionally refused programs', () => {
    expect(UNCONDITIONAL_PROGRAMS).toHaveLength(22);
  });

  it('has 12 argument-conditional programs', () => {
    expect(CONDITIONAL_PROGRAMS).toHaveLength(12);
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
