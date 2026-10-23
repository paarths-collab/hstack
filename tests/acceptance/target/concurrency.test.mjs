import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASH, CRON_SPEC, SCRIPT, STUB, TXN, sandbox } from './helpers/sandbox.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(file) {
  const deadline = Date.now() + 30000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('concurrent operation did not reach its gate');
    await delay(20);
  }
}
function run(sb, args, extra = {}) {
  const child = spawn(BASH, [SCRIPT, ...args], {
    env: { HOME: sb.home, PATH: '/usr/bin:/bin', HSTACK_RELOAD_DELAY: '0', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  return new Promise((resolve) => child.on('close', (status) => {
    clearTimeout(timer);
    resolve({ status, output });
  }));
}

test('an apply queued behind restore cannot recreate a cron after restoration succeeds', async () => {
  const sb = sandbox();
  let restoring, applying;
  try {
    sb.stageAll();
    assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
    // Hold the real restore while it owns the lock and is removing the managed cron.
    const hermes = join(sb.home, '.local', 'bin', 'hermes');
    unlinkSync(hermes);
    writeFileSync(hermes, `#!/bin/bash
if [ "$1 $2" = 'cron remove' ]; then
  : > "$HOME/restore-ready"
  while [ ! -e "$HOME/restore-release" ]; do sleep 0.05; done
fi
exec /bin/bash '${STUB}' "$@"
`);
    chmodSync(hermes, 0o755);
    // A DEBUG probe signals the lock call, letting the test release restore only once apply
    // actually queues there. It changes no transaction state and prevents timing-based flakes.
    const probe = join(sb.root, 'lock-probe.sh');
    writeFileSync(probe, `set -T
trap 'if [ "\${OP:-}" = apply ] && [ "$BASH_COMMAND" = lock_acquire ]; then : > "$HOME/apply-ready"; fi' DEBUG
`);
    restoring = run(sb, ['restore', TXN]);
    await waitFor(join(sb.home, 'restore-ready'));
    applying = run(sb, ['apply', TXN, '--cron', CRON_SPEC], { BASH_ENV: probe });
    await waitFor(join(sb.home, 'apply-ready'));
    writeFileSync(join(sb.home, 'restore-release'), '');
    const restored = await restoring;
    const applied = await applying;
    assert.equal(restored.status, 0, restored.output);
    assert.match(restored.output, /restore_verified=1/);
    assert.equal(applied.status, 3, applied.output);
    assert.match(applied.output, /error=txn_finished/);
    assert.ok(existsSync(join(sb.txnPath(), 'restored')));
    assert.equal(sb.cron().includes('[hstack:founder-brief]'), false, 'restored state remains restored');
  } finally {
    writeFileSync(join(sb.home, 'restore-release'), '');
    await Promise.all([restoring, applying]);
    sb.cleanup();
  }
});
