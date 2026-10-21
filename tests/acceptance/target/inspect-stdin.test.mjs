import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASH, FAKE, SCRIPT, TXN, sandbox, skillTar } from './helpers/sandbox.mjs';

// The JS side runs inspect as `bash -s -- inspect` with the script body on stdin (nothing is
// installed on the target for a read-only inspect). That only works if no child process ever
// swallows the rest of the script from the shared stdin, so prove it end to end.
function viaStdin(sb, args, env = {}) {
  const script = readFileSync(SCRIPT);
  const r = spawnSync('env', ['-i', `HOME=${sb.home}`, 'PATH=/usr/bin:/bin', `HSTACK_STUB_LOG=${sb.log}`,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`), BASH, '-s', '--', ...args], { input: script });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test('`bash -s -- inspect` with the script on stdin gives the same answer as running the file, and stays read-only', () => {
  const sb = sandbox();
  try {
    sb.write('.hermes/.env', `A=1\nTELEGRAM_BOT_TOKEN=${FAKE.bot}\n`, 0o600);
    sb.write('.hermes/skills/user-skill/SKILL.md', 'mine\n');
    sb.write('.hermes/cron.db', 'job-1\t0 1 * * *\t[hstack:founder-brief] x\njob-2\t0 2 * * *\tother\n');
    const before = sb.hash();
    const viaFile = sb.run(['inspect']);
    const r = viaStdin(sb, ['inspect']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, viaFile.stdout);
    assert.equal(sb.hash(), before);
    assert.ok(!r.stdout.includes(FAKE.bot));
    assert.deepEqual(sb.stubCalls().filter((a) => !((a.length === 1 && a[0] === '--version') || (a[0] === 'cron' && a[1] === 'list'))), []);
    const missing = viaStdin(sandbox({ stub: false }), ['inspect']);
    assert.match(missing.stdout, /^runtime_version=unknown$/m);
  } finally { sb.cleanup(); }
});

test('inspect reports managed skills with their sha and flags a modified one', () => {
  const sb = sandbox();
  try {
    sb.backup();
    sb.syncSkills(skillTar({ 'alpha-skill': { 'SKILL.md': 'a\n' } }), 'alpha-skill');
    sb.apply();
    sb.commit();
    let r = sb.run(['inspect']);
    assert.match(r.kv.skills_managed, /^alpha-skill:[0-9a-f]{64}$/);
    assert.equal(r.kv.skills_managed_modified, '');
    assert.equal(r.kv.skills_unmanaged, '');
    assert.equal(r.kv.txn_incomplete, '');
    sb.write('.hermes/skills/alpha-skill/SKILL.md', 'edited\n');
    r = sb.run(['inspect']);
    assert.equal(r.kv.skills_managed_modified, 'alpha-skill');
    assert.ok(readFileSync(join(sb.txnPath(), 'done'), 'utf8').length > 0 && TXN);
  } finally { sb.cleanup(); }
});
