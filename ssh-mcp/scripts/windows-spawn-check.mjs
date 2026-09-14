// PM-3 / AC4-AC6 evidence, run by the `windows-spawn` CI job.
//
// On Windows `npx` is a .cmd shim. `spawn(..., { shell: false })` never goes through cmd.exe, so
// Node cannot locate or execute a .cmd file directly and fails with ENOENT — exactly the failure
// mode the README's "use cmd /c npx ..." guidance exists to avoid. Wrapping with `cmd /c` fixes
// it because cmd.exe itself resolves the shim's PATHEXT association. This script asserts both
// halves so the README's advice is proven against a real runner on every PR.
//
// Leg [1/2] deliberately omits the `cmd /c` wrapper: showing what happens without it is the
// whole point. Leg [2/2] uses the same argv shape as tests/e2e/package.test.ts — see
// `npxLaunch` in tests/fixtures/stdioServer.ts for why a bare `npx -y <tgz>` must never be used.
import { spawn } from 'node:child_process';

const tgz = process.env.SSH_MCP_TGZ;
if (!tgz) throw new Error('SSH_MCP_TGZ not set');

const NPX_ARGS = ['-y', `--package=${tgz}`, 'ssh-mcp'];
const STDERR_TAIL_BYTES = 4096;
/** Cold npx install of the tarball + dependencies happens inside this budget. */
const RESPONSE_TIMEOUT_MS = 60000;

const REQ_INIT =
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'ci-windows-spawn', version: '0.0.0' },
    },
  }) + '\n';

function expectEnoent(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(cmd, args, { shell: false });
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`expected ${cmd} spawn to fail with ENOENT, but it did not within 5s`));
    }, 5000);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      if (err.code === 'ENOENT') resolvePromise(err.code);
      else reject(new Error(`expected ENOENT from ${cmd}, got ${err.code}: ${err.message}`));
    });
  });
}

function expectInitializeResponse(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let buf = '';
    let stderrTail = '';
    const child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(
          new Error(
            `${cmd} did not answer initialize within ${RESPONSE_TIMEOUT_MS}ms; stderr tail:\n${stderrTail}`
          )
        );
      });
    }, RESPONSE_TIMEOUT_MS);

    child.on('error', (err) => {
      settle(() => reject(new Error(`unexpected spawn error for ${cmd}: ${err.message}`)));
    });

    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    // A child that dies before answering is a failure now, not after the timeout. `close` rather
    // than `exit`: Node fires `exit` before the stdio pipes are drained, so the stderr that
    // explains the failure would usually still be missing.
    child.on('close', (code, signal) => {
      settle(() =>
        reject(
          new Error(
            `${cmd} exited (code=${code} signal=${signal}) before answering initialize; stderr tail:\n${stderrTail}`
          )
        )
      );
    });

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result && msg.result.serverInfo) {
            settle(() => {
              child.kill();
              resolvePromise(msg.result.serverInfo);
            });
            return;
          }
        } catch {
          // stdout noise is not this script's subject; package.test.ts asserts AC2.3.
        }
      }
    });

    child.stdin.write(REQ_INIT);
  });
}

console.log('[1/2] spawn("npx", NPX_ARGS, { shell: false }) — expecting ENOENT');
const code = await expectEnoent('npx', NPX_ARGS);
console.log('  -> failed as expected:', code);

console.log(
  '[2/2] spawn("cmd", ["/c", "npx", ...NPX_ARGS], { shell: false }) — expecting initialize response'
);
const serverInfo = await expectInitializeResponse('cmd', ['/c', 'npx', ...NPX_ARGS]);
console.log('  -> responded:', JSON.stringify(serverInfo));

console.log('windows-spawn check: PASS');
