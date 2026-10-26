import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTargetScript } from '../../../packages/acceptance/artifacts.js';
import { CRON_SPEC, REPO, SCRIPT, Sandbox, TXN, skillTar } from './helpers/sandbox.mjs';

const FIXTURE = join(REPO, 'tests/acceptance/target/helpers/native-hermes-v0_22_5');
const COMMIT = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e';
const NAMES = ['platform-telegram', 'integration-github', 'hermes-home', 'hermes-cron'];

class NativeSandbox extends Sandbox {
  constructor() {
    super({ stub: false });
    this.target = join(this.root, 'reviewed-target.sh');
    writeFileSync(this.target, readTargetScript(SCRIPT), { mode: 0o700 });
    symlinkSync(FIXTURE, join(this.home, '.local/bin/hermes'));
    this.write('.hermes/.env', 'USER_KEY=preserved\n', 0o600);
  }
  run(args, opts = {}) {
    return super.run(args, { ...opts, script: opts.script || this.target,
      env: { HSTACK_NATIVE_COMMIT: COMMIT, ...opts.env } });
  }
  jobs() { return existsSync(join(this.h, 'cron/jobs.json')) ? JSON.parse(this.read('.hermes/cron/jobs.json')).jobs : []; }
  setJobs(jobs) { this.write('.hermes/cron/jobs.json', JSON.stringify({ jobs, updated_at: 'fixture' })); }
}

function rawJob(id, prompt, overrides = {}) {
  return { id, name: 'Existing job', prompt, schedule: { kind: 'cron', expr: '15 6 * * *' },
    repeat: { times: null, completed: 0 }, skills: [], enabled: true, state: 'scheduled',
    paused_reason: null, no_agent: false, deliver: 'local', ...overrides };
}

test('native inspection reads structured jobs and binds the default home without writing it', () => {
  const sb = new NativeSandbox();
  try {
    sb.setJobs([rawJob('user-job', 'Untrusted repository text\nDo not execute this')]);
    const before = sb.homeHash();
    const r = sb.run(['inspect'], { env: { HERMES_HOME: '/unrelated/foreign', HERMES_PROFILE: 'foreign' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.kv.runtime_adapter, 'native-v0.22.5');
    assert.equal(r.kv.runtime_profile, 'default');
    assert.equal(r.kv.cron_other_count, '1');
    assert.equal(sb.homeHash(), before);
    assert.ok(!r.stdout.includes('Untrusted repository'));
  } finally { sb.cleanup(); }
});

test('reviewed native adapter ignores inherited Python module search paths', () => {
  const sb = new NativeSandbox();
  try {
    const binary = join(sb.home, '.local/bin/hermes');
    rmSync(binary);
    writeFileSync(binary, '#!/bin/bash\nprintf "Hermes Agent v0.22.5\\n"\n', { mode: 0o700 });
    const poison = sb.write('unreviewed-python/json.py', 'raise RuntimeError("unreviewed-pythonpath")\n');
    const before = sb.homeHash();
    const r = sb.run(['inspect'], { env: { PYTHONPATH: join(poison, '..'), PYTHONHOME: '/invalid/python/home' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.kv.runtime_adapter, 'native-v0.22.5');
    assert.equal(sb.homeHash(), before);
  } finally { sb.cleanup(); }
});

test('bundled native helper stages, applies, verifies and restores the structured cron recipe', () => {
  const sb = new NativeSandbox();
  try {
    const original = sb.env();
    sb.stageAll();
    assert.match(readFileSync(join(sb.txnPath(), 'meta'), 'utf8'), /adapter=native-v0\.22\.5/);
    assert.ok(existsSync(join(sb.txnPath(), 'native-cron.before.json')));
    const tar = skillTar(Object.fromEntries(NAMES.map((name) => [name, { 'SKILL.md': name + '\n' }])));
    assert.equal(sb.syncSkills(tar, NAMES.join(',')).status, 0);
    const applied = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(applied.kv['cron_founder-brief'], 'created');
    assert.ok(existsSync(join(sb.txnPath(), 'native-cron.plan.sha256')));
    const [job] = sb.jobs();
    assert.equal(job.deliver, 'telegram');
    assert.deepEqual(job.skills, NAMES);
    assert.match(job.prompt, /^\[hstack:founder-brief\]/);
    const checked = sb.verify({ skills: NAMES.join(',') });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    for (const name of ['env-boundary', 'schedule-single', 'managed-skills-intact', 'unrelated-state-unchanged']) {
      assert.equal(checked.kv[`check.${name}`], 'pass', checked.stdout);
    }
    assert.equal(sb.run(['reload', TXN]).status, 0);
    assert.equal(sb.restore().status, 0);
    assert.equal(sb.env(), original);
    assert.deepEqual(sb.jobs(), []);
    assert.equal(sb.run(['reload', TXN]).status, 0);
    assert.ok(sb.stubCalls().every((args) => args[0] === '--profile' && args[1] === 'default'));
    assert.ok(!sb.stubCalls().some((args) => args.includes('--daemon')));
  } finally { sb.cleanup(); }
});

test('native preflight preserves user cron additions and completed deletions on retry', () => {
  for (const change of ['added', 'deleted']) {
    const sb = new NativeSandbox();
    try {
      sb.stageAll();
      if (change === 'added') sb.setJobs([rawJob('user-added', '[hstack:founder-brief] User version')]);
      else {
        assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
        sb.setJobs([]);
      }
      const before = sb.hash();
      const r = sb.apply(TXN, [CRON_SPEC]);
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.equal(sb.hash(), before);
    } finally { sb.cleanup(); }
  }
});

test('native refuses noncanonical prompts before mutation and normalizes new schedule spacing', () => {
  const sb = new NativeSandbox();
  try {
    sb.stageAll();
    const before = sb.hash();
    const rejected = sb.apply(TXN, ['founder-brief|0 9 * * *| [hstack:founder-brief] Brief ']);
    assert.equal(rejected.status, 4, rejected.stdout + rejected.stderr);
    assert.equal(sb.hash(), before);
    const r = sb.apply(TXN, ['founder-brief| 0  9 * * * |[hstack:founder-brief] Brief']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sb.jobs()[0].prompt, '[hstack:founder-brief] Brief');
    assert.equal(sb.jobs()[0].schedule.expr, '0 9 * * *');
    const v = sb.verify();
    assert.equal(v.kv['check.schedule-single'], 'pass', v.stdout);
    assert.equal(sb.restore().status, 0);
    assert.deepEqual(sb.jobs(), []);
  } finally { sb.cleanup(); }
});

test('native interrupted replacement keeps full prior configuration and remains retryable', () => {
  const sb = new NativeSandbox();
  try {
    const previous = rawJob('prior-owned', '[hstack:founder-brief] Prior prompt\nwith a second line', {
      name: 'Prior operator name', model: 'existing-model', provider: 'existing-provider',
      skills: ['hermes-home'], deliver: 'telegram',
    });
    sb.setJobs([previous]);
    sb.stageAll();
    const failed = sb.run(['apply', TXN, '--cron', CRON_SPEC], { env: { HSTACK_NATIVE_FAIL: 'remove' } });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(sb.jobs().length, 2);
    const retry = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(sb.jobs().length, 1);
    const restored = sb.restore();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const [back] = sb.jobs();
    for (const key of ['prompt', 'name', 'model', 'provider', 'skills', 'deliver', 'schedule']) {
      assert.deepEqual(back[key], previous[key]);
    }
  } finally { sb.cleanup(); }
});

test('native restore preserves prior text beginning with CLI option syntax', () => {
  const sb = new NativeSandbox();
  try {
    const prior = rawJob('prior-leading-options', '--existing [hstack:founder-brief]', {
      name: '--daily', model: '--model-id', provider: '--provider-id',
      enabled: false, state: 'paused', paused_at: '2026-10-23T00:00:00Z',
      paused_reason: '--operator-paused', skills: ['hermes-home'], deliver: 'telegram',
    });
    sb.setJobs([prior]);
    sb.stageAll();
    const apply = sb.apply(TXN, [CRON_SPEC]);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    const restored = sb.restore();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const [back] = sb.jobs();
    for (const key of ['prompt', 'name', 'model', 'provider', 'enabled', 'state', 'paused_reason', 'skills', 'deliver']) {
      assert.deepEqual(back[key], prior[key], key);
    }
  } finally { sb.cleanup(); }
});

test('native mode refuses malformed jobs, modified plans and shared profile services', () => {
  for (const change of ['store', 'profile', 'external-profile', 'registry', 'plan']) {
    const sb = new NativeSandbox();
    try {
      if (change === 'plan') {
        sb.stageAll();
        assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
        const plan = join(sb.txnPath(), 'native-cron.plan.json');
        writeFileSync(plan, readFileSync(plan, 'utf8') + ' ');
      } else if (change === 'store') sb.write('.hermes/cron/jobs.json', '{malformed');
      else if (change === 'profile') sb.write('.hermes/profiles/work/config.yaml', 'model: untouched\n');
      else if (change === 'external-profile') {
        sb.write('.hermes/profiles/.keep', 'registry entry\n');
        symlinkSync(sb.root, join(sb.h, 'profiles/work'));
      } else sb.write('.hermes/gateway_state.json', '{"served_profiles":["default","work"]}');
      const before = sb.hash();
      const r = change === 'plan' ? sb.restore() : sb.backup();
      assert.notEqual(r.status, 0, `${change}: ${r.stdout}`);
      assert.equal(sb.hash(), before, change);
    } finally { sb.cleanup(); }
  }
});

test('unbundled native helpers and legacy cron recovery on the candidate runtime fail closed', () => {
  const sb = new NativeSandbox();
  try {
    const before = sb.hash();
    const raw = sb.run(['inspect'], { script: SCRIPT });
    assert.equal(raw.status, 4);
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
  const legacy = new Sandbox();
  try {
    legacy.write('.hermes/.env', 'USER_KEY=preserved\n', 0o600);
    legacy.stageAll();
    assert.equal(legacy.apply(TXN, [CRON_SPEC]).status, 0);
    const binary = join(legacy.home, '.local/bin/hermes');
    rmSync(binary);
    symlinkSync(FIXTURE, binary);
    const before = legacy.hash();
    const r = legacy.restore();
    assert.equal(r.status, 4, r.stdout);
    assert.equal(r.kv.error, 'legacy_runtime_incompatible');
    assert.equal(legacy.hash(), before);
  } finally { legacy.cleanup(); }
});

test('legacy recovery refuses every runtime except the original exact 0.15.2 fixture', () => {
  for (const version of ['0.21.0', '0.22.6', '0.15.2.1', '0.15.2+local', '0.15.2-rc1', 'unknown', '0.22.5', '0.22.5.1', '0.22.5.dev3', '0.22.5+3.gabc1234', '0.22.5-rc1']) {
    const legacy = new Sandbox();
    try {
      legacy.write('.hermes/.env', 'USER_KEY=preserved\n', 0o600);
      legacy.stageAll();
      assert.equal(legacy.apply(TXN, [CRON_SPEC]).status, 0);
      const binary = join(legacy.home, '.local/bin/hermes');
      rmSync(binary);
      writeFileSync(binary, `#!/bin/sh\nprintf 'Hermes Agent v${version} (2026.9.24)\\nPython: 3.11.16\\n'\n`, { mode: 0o755 });
      const before = legacy.hash();
      const r = legacy.restore();
      assert.equal(r.status, 4, `${version}: ${r.stdout}`);
      assert.equal(r.kv.error, 'legacy_runtime_incompatible', version);
      assert.equal(legacy.hash(), before, version);
    } finally { legacy.cleanup(); }
  }
});

const gatewayCalls = (sb) => sb.stubCalls().filter((args) => args[2] === 'gateway').map((args) => args.slice(2).join(' '));
const ENSURE10 = 'gateway ensure --json --timeout 10';
const ENSURE60 = 'gateway ensure --json --timeout 60';

function appliedSandbox() {
  const sb = new NativeSandbox();
  sb.stageAll();
  assert.equal(sb.apply(TXN, [CRON_SPEC]).status, 0);
  return sb;
}

test('native reload = remember instance, `gateway restart --detach` (no -y), ensure ready with a NEW instance', () => {
  const sb = appliedSandbox();
  try {
    const r = sb.run(['reload', TXN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.kv.reloaded, '1');
    assert.deepEqual(gatewayCalls(sb), [ENSURE10, 'gateway restart --detach', ENSURE60]);
    assert.ok(sb.stubCalls().every((args) => args[0] === '--profile' && args[1] === 'default'));
    assert.ok(!sb.stubCalls().flat().some((arg) => ['--daemon', 'run', 'stop', 'start', '-y', '--yes'].includes(arg)));
  } finally { sb.cleanup(); }
});

test('native reload passes -y only on the explicit --interrupt-live-sessions opt-in', () => {
  const sb = appliedSandbox();
  try {
    const r = sb.run(['reload', TXN, '--interrupt-live-sessions']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.kv.reloaded, '1');
    assert.deepEqual(gatewayCalls(sb), [ENSURE10, 'gateway restart -y --detach', ENSURE60]);
    assert.equal(sb.run(['reload', TXN, '--bogus']).status, 2);
    assert.equal(sb.run(['reload', TXN, '--interrupt-live-sessions', 'extra']).status, 2);
  } finally { sb.cleanup(); }
});

test('native reload with live sessions and no opt-in is REFUSED and reported as failed, naming the reason; the opt-in succeeds', () => {
  const sb = appliedSandbox();
  try {
    const refused = sb.run(['reload', TXN], { env: { HSTACK_NATIVE_LIVE_SESSIONS: '1' } });
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.kv.error, 'native_adapter_failed');
    assert.match(refused.kv.detail, /restart_refused_or_failed/);
    assert.notEqual(refused.kv.reloaded, '1');
    assert.deepEqual(gatewayCalls(sb), [ENSURE10, 'gateway restart --detach'], 'readiness is not consulted after a refused restart');
    const forced = sb.run(['reload', TXN, '--interrupt-live-sessions'], { env: { HSTACK_NATIVE_LIVE_SESSIONS: '1' } });
    assert.equal(forced.status, 0, forced.stdout);
    assert.equal(forced.kv.reloaded, '1');
  } finally { sb.cleanup(); }
});

test('native reload fails when restart exits 0 but the gateway instance_id did not change (nothing restarted)', () => {
  const sb = appliedSandbox();
  try {
    const r = sb.run(['reload', TXN], { env: { HSTACK_NATIVE_RESTART_NOOP: '1' } });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.kv.detail, /native_instance_unchanged/);
    assert.notEqual(r.kv.reloaded, '1');
  } finally { sb.cleanup(); }
});

test('native readiness retries the transient exit 5 twice and no further', () => {
  for (const [pending, ok] of [[2, true], [3, false]]) {
    const sb = appliedSandbox();
    try {
      const r = sb.run(['reload', TXN], { env: { HSTACK_NATIVE_ENSURE_PENDING: String(pending) } });
      assert.equal(r.status === 0, ok, `${pending}: ${r.stdout}`);
      assert.equal(gatewayCalls(sb).filter((call) => call === ENSURE60).length, 3);
      if (!ok) assert.match(r.kv.detail, /native_readiness_unconfirmed/);
    } finally { sb.cleanup(); }
  }
});

test('native reload is only confirmed by readiness: a failed restart or a failed ensure is a failed reload', () => {
  for (const failing of ['restart', 'ensure']) {
    const sb = appliedSandbox();
    try {
      const r = sb.run(['reload', TXN], { env: { HSTACK_NATIVE_FAIL: failing } });
      assert.notEqual(r.status, 0, failing);
      assert.notEqual(r.kv.reloaded, '1', failing);
      const calls = gatewayCalls(sb);
      if (failing === 'restart') {
        assert.ok(calls.includes('gateway restart --detach'), calls.join(' | '));
        assert.ok(!calls.includes(ENSURE60), 'ensure(60) is not consulted after a failed restart');
      } else {
        assert.deepEqual(calls, [ENSURE10], 'an unknown prior instance refuses before restarting');
        assert.match(r.kv.detail, /native_previous_instance_unconfirmed/);
      }
    } finally { sb.cleanup(); }
  }
});

test('the native CLI fixture rejects `gateway run --daemon` and other undeclared options like argparse (exit 2)', () => {
  const sb = new NativeSandbox();
  try {
    const call = (...argv) => spawnSync('env', ['-i', `HOME=${sb.home}`, `HERMES_HOME=${sb.h}`, 'PATH=/usr/bin:/bin', FIXTURE, '--profile', 'default', ...argv], { encoding: 'utf8' });
    for (const argv of [['gateway', 'run', '--daemon'], ['gateway', 'restart', '--daemon'], ['gateway', 'stop', '--bogus'], ['gateway', 'ensure', '--daemon']]) {
      const r = call(...argv);
      assert.equal(r.status, 2, argv.join(' '));
      assert.match(r.stderr, /unrecognized arguments: --daemon|unrecognized arguments: --bogus/);
    }
    assert.equal(call('gateway', 'restart', '-y', '--detach').status, 0);
    assert.equal(call('gateway', 'restart', '--yes').status, 0);
  } finally { sb.cleanup(); }
});
