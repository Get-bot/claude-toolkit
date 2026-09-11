import { describe, expect, it } from 'vitest';

import { classify } from '../../src/safety/classify.js';
import {
  SECRET_PLACEHOLDER,
  containsSecret,
  maskCommandSecrets,
} from '../../src/safety/secrets.js';

describe('credential values are masked (security finding F11)', () => {
  const secrets: [string, string][] = [
    ['mysql -uroot -pHUNTER2 -e "SELECT 1"', 'HUNTER2'],
    ['psql --password=s3cr3t -c "SELECT 1"', 's3cr3t'],
    ['curl -H "Authorization: Bearer eyJhbGciOi" https://api.example', 'eyJhbGciOi'],
    ['curl -H "authorization: token ghp_abc123" https://api.example', 'ghp_abc123'],
    ['deploy --token=ghp_abc123 --env prod', 'ghp_abc123'],
    ['deploy --api-key abcdef123456', 'abcdef123456'],
    ['AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls', 'abc123'],
    ['DB_PASSWORD=hunter2 npm run migrate', 'hunter2'],
    ['API_TOKEN="tok-123" ./deploy.sh', 'tok-123'],
    ['restic -p /run/secrets/repo backup /srv', '/run/secrets/repo'],
  ];

  for (const [command, secret] of secrets) {
    it(`masks the value in: ${command}`, () => {
      const masked = maskCommandSecrets(command);
      expect(masked).not.toContain(secret);
      expect(masked).toContain(SECRET_PLACEHOLDER);
      expect(containsSecret(command)).toBe(true);
    });
  }

  it('keeps the option name so the reader can see what was masked', () => {
    expect(maskCommandSecrets('mysql -pHUNTER2')).toContain('-p');
    expect(maskCommandSecrets('deploy --token=x')).toContain('--token=');
  });
});

describe('ordinary commands are left alone', () => {
  const untouched = [
    'ls -la',
    'git status',
    'grep -rn "password" .',
    'docker ps -a',
    'tar -cpf backup.tar /srv',
    'ps aux | head -20',
    'kubectl get pods -n prod',
    'rm -rf /tmp/build',
    'systemctl status nginx',
    'curl -s https://api.example/health',
  ];

  for (const command of untouched) {
    it(`does not change: ${command}`, () => {
      expect(maskCommandSecrets(command)).toBe(command);
      expect(containsSecret(command)).toBe(false);
    });
  }
});

describe('masking never changes a verdict', () => {
  // The classifier runs on the original bytes; masking happens afterwards, on
  // the way to the audit file and the approval dialog. If the two ever swapped
  // order, a masked `-p` value could hide the rest of the command.
  const rows: [string, 'safe' | 'privileged' | 'destructive'][] = [
    ['mysql -uroot -pHUNTER2 -e "DROP DATABASE prod"', 'destructive'],
    ['MYSQL_PASSWORD=x mysql -e "DROP TABLE t"', 'destructive'],
    ['DB_PASSWORD=x npm run migrate', 'safe'],
    ['curl -H "Authorization: Bearer x" https://api.example/health', 'safe'],
  ];

  for (const [command, grade] of rows) {
    it(`${command} stays ${grade}`, () => {
      expect(classify(command).grade).toBe(grade);
    });
  }
});
