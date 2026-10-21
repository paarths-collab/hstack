import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_SPEC, FAKE, TXN, fingerprint, sandbox, skillTar } from './helpers/sandbox.mjs';

const STATUS = (r, id) => r.kv[`check.${id}`];
const SKILLS = skillTar({ 'alpha-skill': { 'SKILL.md': 'alpha\n' } });

function applied({ skills = false } = {}) {
  const sb = sandbox();
  sb.write('.hermes/.env', 'A=1\nUNRELATED_SECRET=keep-me-as-is\n', 0o600);
  sb.write('.hermes/skills/user-skill/SKILL.md', 'mine\n');
  sb.write('.hermes/cron.db', 'job-1\t30 2 * * *\tmy own job\n');
  sb.stageAll();
  if (skills) assert.equal(sb.syncSkills(SKILLS, 'alpha-skill').status, 0);
  const a = sb.apply(TXN, [CRON_SPEC]);
  assert.equal(a.status, 0, a.stdout);
  return sb;
}

test('target-state checks pass on a healthy apply; delivery is deliberately NOT checked here; no values are printed', () => {
  const sb = applied({ skills: true });
  try {
    const r = sb.verify({ skills: 'alpha-skill' });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv.apply_marker, 'applied');
    assert.equal(STATUS(r, 'env-boundary'), 'pass');
    assert.equal(STATUS(r, 'schedule-single'), 'pass');
    assert.equal(STATUS(r, 'managed-skills-intact'), 'pass');
    assert.equal(STATUS(r, 'unrelated-state-unchanged'), 'pass');
    assert.equal(Object.keys(r.kv).filter((k) => /delivery/.test(k)).length, 0);
    for (const v of [FAKE.allowed, FAKE.chat, FAKE.bot, FAKE.github, 'keep-me-as-is']) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
    // verify is read-only
    const before = sb.hash();
    sb.verify({ skills: 'alpha-skill' });
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('env-boundary: wildcard / empty / missing allowlist, wrong or missing destination, malformed values all FAIL', () => {
  const sb = applied();
  try {
    const original = sb.env();
    const attempts = [
      ['wildcard allowlist', (e) => e.replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=*'), 'allowlist_contains_wildcard_or_blank'],
      ['wildcard entry in list', (e) => e.replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=111222333,*'), 'allowlist_contains_wildcard_or_blank'],
      ['empty entry', (e) => e.replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=111222333,,5'), 'allowlist_has_empty_entry'],
      ['no allowlist', (e) => e.replace(/^TELEGRAM_ALLOWED_USERS=.*\n/m, ''), 'allowlist_missing_or_empty'],
      ['duplicated allowlist', (e) => e + 'TELEGRAM_ALLOWED_USERS=7\n', 'allowlist_defined_more_than_once'],
      ['destination changed', (e) => e.replace(/^TELEGRAM_HOME_CHANNEL=.*$/m, 'TELEGRAM_HOME_CHANNEL=-100555'), 'destination_fingerprint_mismatch'],
      ['destination missing', (e) => e.replace(/^TELEGRAM_HOME_CHANNEL=.*\n/m, ''), 'destination_missing'],
      ['destination malformed', (e) => e.replace(/^TELEGRAM_HOME_CHANNEL=.*$/m, 'TELEGRAM_HOME_CHANNEL=@somebody'), 'destination_malformed'],
      ['destination duplicated', (e) => e + 'TELEGRAM_HOME_CHANNEL=-100555\n', 'destination_defined_more_than_once'],
    ];
    for (const [label, edit, detail] of attempts) {
      writeFileSync(sb.envPath, edit(original));
      const r = sb.verify();
      assert.equal(STATUS(r, 'env-boundary'), 'fail', label);
      assert.equal(r.kv['check.env-boundary.detail'], detail, label);
      assert.ok(!r.stdout.includes('-100555') && !r.stdout.includes(FAKE.chat) && !r.stdout.includes(FAKE.allowed), label + ': ids printed');
    }
    writeFileSync(sb.envPath, original);
    assert.equal(STATUS(sb.verify(), 'env-boundary'), 'pass');
    writeFileSync(sb.envPath, original.replace(/^TELEGRAM_HOME_CHANNEL=.*$/m, `TELEGRAM_HOME_CHANNEL="${FAKE.chat}"`));
    assert.equal(STATUS(sb.verify(), 'env-boundary'), 'pass', 'one quote layer is tolerated');
    assert.equal(STATUS(sb.verify({ fp: fingerprint('999') }), 'env-boundary'), 'fail', 'a different expected fingerprint fails');
  } finally { sb.cleanup(); }
});

test('schedule-single: duplicates, a wrong schedule and a missing entry fail; unreadable cron is unknown', () => {
  const sb = applied();
  try {
    assert.equal(STATUS(sb.verify(), 'schedule-single'), 'pass');
    assert.equal(STATUS(sb.verify({ schedule: '1 1 * * *' }), 'schedule-single'), 'fail');
    const cronBefore = readFileSync(sb.cronPath, 'utf8');
    appendFileSync(sb.cronPath, 'job-50\t0 9 * * *\t[hstack:founder-brief] sneaky duplicate\n');
    const dup = sb.verify();
    assert.equal(STATUS(dup, 'schedule-single'), 'fail');
    assert.equal(dup.kv['check.schedule-single.detail'], 'marked_entries=2');
    writeFileSync(sb.cronPath, cronBefore.split('\n').filter((l) => !l.includes('[hstack:')).join('\n'));
    assert.equal(STATUS(sb.verify(), 'schedule-single'), 'fail');
    writeFileSync(sb.cronPath, cronBefore);
    const unk = sb.run(['verify', TXN, '--destination-fp', fingerprint(FAKE.chat), '--allow-var', 'TELEGRAM_ALLOWED_USERS', '--dest-var', 'TELEGRAM_HOME_CHANNEL', '--cron-id', 'founder-brief', '--schedule', '0 9 * * *'], { env: { HSTACK_STUB_FAIL: 'cron-list' } });
    assert.equal(STATUS(unk, 'schedule-single'), 'unknown');
    assert.equal(STATUS(unk, 'unrelated-state-unchanged'), 'unknown');
  } finally { sb.cleanup(); }
});

test('managed-skills-intact: unknown when nothing is managed, pass when intact, fail when a managed skill was edited or is unlisted', () => {
  const none = applied();
  try {
    assert.equal(STATUS(none.verify(), 'managed-skills-intact'), 'unknown');
    assert.equal(STATUS(none.verify({ skills: 'alpha-skill' }), 'managed-skills-intact'), 'fail', 'a required skill that is not managed fails');
  } finally { none.cleanup(); }
  const sb = applied({ skills: true });
  try {
    assert.equal(STATUS(sb.verify(), 'managed-skills-intact'), 'pass');
    writeFileSync(join(sb.skillsPath, 'alpha-skill', 'SKILL.md'), 'edited\n');
    const r = sb.verify();
    assert.equal(STATUS(r, 'managed-skills-intact'), 'fail');
    assert.equal(r.kv['check.managed-skills-intact.detail'], 'modified:alpha-skill');
  } finally { sb.cleanup(); }
});

test('unrelated-state-unchanged: a changed unrelated env line, skill or cron entry is detected', () => {
  for (const [what, mutate] of [
    ['env', (sb) => writeFileSync(sb.envPath, sb.env().replace('keep-me-as-is', 'changed'))],
    ['skills', (sb) => writeFileSync(join(sb.skillsPath, 'user-skill', 'SKILL.md'), 'tampered\n')],
    ['skills', (sb) => sb.write('.hermes/skills/new-user-skill/SKILL.md', 'x\n')],
    ['cron', (sb) => writeFileSync(sb.cronPath, sb.cron().replace('my own job', 'tampered job'))],
    ['cron', (sb) => appendFileSync(sb.cronPath, 'job-60\t2 2 * * *\tadded behind our back\n')],
  ]) {
    const sb = applied();
    try {
      assert.equal(STATUS(sb.verify(), 'unrelated-state-unchanged'), 'pass');
      mutate(sb);
      const r = sb.verify();
      assert.equal(STATUS(r, 'unrelated-state-unchanged'), 'fail', what);
      assert.equal(r.kv['check.unrelated-state-unchanged.detail'], what);
    } finally { sb.cleanup(); }
  }
});

test('verify needs applying/applied and a valid backup', () => {
  const sb = sandbox();
  try {
    sb.stageAll();
    const r = sb.verify();
    assert.equal(r.status, 3);
    assert.equal(r.kv.error, 'not_applied');
    assert.equal(sb.verify({}, 'nnnn0000mmmm').status, 1);
  } finally { sb.cleanup(); }
});
