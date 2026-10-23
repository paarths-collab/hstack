import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TXN, TXN2, sandbox, skillTar, treeHash, ustar } from './helpers/sandbox.mjs';
import { buildSkillsTar } from '../../../packages/acceptance/ops.js';

const V1 = { 'alpha-skill': { 'SKILL.md': 'alpha v1\n', 'scripts/run.sh': 'echo 1\n' }, 'beta-skill': { 'SKILL.md': 'beta v1\n' } };
const V2 = { 'alpha-skill': { 'SKILL.md': 'alpha v2\n', 'scripts/run.sh': 'echo 1\n' }, 'beta-skill': { 'SKILL.md': 'beta v1\n' } };
const NAMES = 'alpha-skill,beta-skill';
const STATE = ['home/.hermes/.hstack'];

function seeded() {
  const sb = sandbox();
  sb.write('.hermes/.env', 'A=1\n', 0o600);
  sb.write('.hermes/skills/user-skill/SKILL.md', 'mine\n');
  sb.write('.hermes/skills/user-skill/data.txt', 'private notes\n');
  sb.write('.hermes/skills/loose-file.md', 'not a dir\n');
  return sb;
}
const userDirHash = (sb) => treeHash(join(sb.skillsPath, 'user-skill'));

test('installs skills with ownership markers and a manifest; unrelated user skills are never touched', () => {
  const sb = seeded();
  try {
    const before = userDirHash(sb);
    sb.backup();
    const r = sb.syncSkills(skillTar(V1), NAMES);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.kv['skill_alpha-skill'], 'created');
    assert.equal(r.kv['skill_beta-skill'], 'created');
    assert.equal(r.kv.skills_changed, '2');
    assert.equal(readFileSync(join(sb.skillsPath, 'alpha-skill', 'scripts', 'run.sh'), 'utf8'), 'echo 1\n');
    assert.match(readFileSync(join(sb.skillsPath, 'alpha-skill', '.hstack-acceptance'), 'utf8'), /^txn=abcd1234efgh/);
    // the installers' marker name is a different mechanism: never written, never read
    assert.ok(!existsSync(join(sb.skillsPath, 'alpha-skill', '.hstack-managed')));
    const rows = readFileSync(sb.manifestPath, 'utf8').trim().split('\n').map((l) => l.split('\t'));
    assert.deepEqual(rows.map((x) => x[0]).sort(), ['alpha-skill', 'beta-skill']);
    for (const row of rows) { assert.match(row[1], /^[0-9a-f]{64}$/); assert.equal(row[2], TXN); assert.ok(row[3]); }
    assert.equal(userDirHash(sb), before);
    assert.ok(existsSync(join(sb.skillsPath, 'loose-file.md')));
    // sync is a live mutation: the write-ahead marker exists, `applied` does not
    assert.ok(existsSync(join(sb.txnPath(), 'applying')));
    assert.ok(!existsSync(join(sb.txnPath(), 'applied')));
    assert.ok(!existsSync(join(sb.txnPath(), 'skills.incoming')), 'scratch copies are removed');
  } finally { sb.cleanup(); }
});

test('a same-named UNMANAGED dir => exit 5 and nothing changes, even for the other names in the same call', () => {
  const sb = seeded();
  try {
    sb.write('.hermes/skills/beta-skill/SKILL.md', 'the user wrote this beta\n');
    sb.backup();
    const before = sb.hash();
    const r = sb.syncSkills(skillTar(V1), NAMES);
    assert.equal(r.status, 5);
    assert.equal(r.kv.error, 'skill_collision');
    assert.equal(r.kv.detail, 'collision:beta-skill');
    assert.equal(r.kv.collisions, 'beta-skill');
    assert.equal(sb.hash(), before, 'alpha-skill must not have been installed');
    assert.ok(!existsSync(join(sb.skillsPath, 'alpha-skill')));
    assert.ok(!existsSync(sb.manifestPath));
  } finally { sb.cleanup(); }
});

test('a symlink or plain file squatting on a name is also a collision', () => {
  const sb = seeded();
  try {
    symlinkSync(join(sb.skillsPath, 'user-skill'), join(sb.skillsPath, 'alpha-skill'));
    sb.backup();
    const before = sb.hash();
    assert.equal(sb.syncSkills(skillTar(V1), NAMES).status, 5);
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('rerun with identical content is `unchanged`: no manifest rewrite, no replaced-backup churn, no write-ahead marker', () => {
  const sb = seeded();
  try {
    sb.backup();
    assert.equal(sb.syncSkills(skillTar(V1), NAMES).status, 0);
    assert.equal(sb.apply().status, 0);
    assert.equal(sb.commit().status, 0);
    const manifest = readFileSync(sb.manifestPath, 'utf8');
    const skillsHash = treeHash(sb.skillsPath);
    assert.equal(sb.backup(TXN2).status, 0);
    const r = sb.run(['skills-sync', TXN2, '--names', NAMES], { input: skillTar(V1) });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv['skill_alpha-skill'], 'unchanged');
    assert.equal(r.kv['skill_beta-skill'], 'unchanged');
    assert.equal(r.kv.skills_changed, '0');
    assert.equal(readFileSync(sb.manifestPath, 'utf8'), manifest, 'manifest must be byte-identical');
    assert.equal(treeHash(sb.skillsPath), skillsHash);
    const t2 = sb.txnPath(TXN2);
    assert.deepEqual(readdirSync(t2).filter((f) => /^skills\./.test(f) || f === 'applying'), []);
  } finally { sb.cleanup(); }
});

test('changed content updates the managed skill, parks the old dir in the txn, and restore moves it back exactly', () => {
  const sb = seeded();
  try {
    sb.backup();
    sb.syncSkills(skillTar(V1), NAMES);
    sb.apply();
    sb.commit();
    const v1Hash = treeHash(join(sb.skillsPath, 'alpha-skill'));
    const manifestV1 = readFileSync(sb.manifestPath, 'utf8');
    sb.backup(TXN2);
    const r = sb.run(['skills-sync', TXN2, '--names', NAMES], { input: skillTar(V2) });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.kv['skill_alpha-skill'], 'updated');
    assert.equal(r.kv['skill_beta-skill'], 'unchanged');
    assert.equal(readFileSync(join(sb.skillsPath, 'alpha-skill', 'SKILL.md'), 'utf8'), 'alpha v2\n');
    assert.equal(readFileSync(join(sb.txnPath(TXN2), 'skills.replaced', 'alpha-skill', 'SKILL.md'), 'utf8'), 'alpha v1\n');
    assert.ok(!existsSync(join(sb.txnPath(TXN2), 'skills.replaced', 'beta-skill')));
    sb.apply(TXN2);
    const rr = sb.restore(TXN2);
    assert.equal(rr.status, 0, rr.stdout);
    assert.equal(treeHash(join(sb.skillsPath, 'alpha-skill')), v1Hash, 'previous version restored exactly');
    assert.equal(readFileSync(sb.manifestPath, 'utf8'), manifestV1, 'manifest restored');
    assert.equal(readFileSync(join(sb.skillsPath, 'beta-skill', 'SKILL.md'), 'utf8'), 'beta v1\n');
  } finally { sb.cleanup(); }
});

test('a user-modified managed skill => exit 3 managed_skill_modified and nothing changes', () => {
  const sb = seeded();
  try {
    sb.backup();
    sb.syncSkills(skillTar(V1), NAMES);
    sb.apply();
    sb.commit();
    writeFileSync(join(sb.skillsPath, 'beta-skill', 'SKILL.md'), 'user edited beta\n');
    sb.backup(TXN2);
    const before = sb.hash();
    const r = sb.run(['skills-sync', TXN2, '--names', NAMES], { input: skillTar(V2) });
    assert.equal(r.status, 3);
    assert.equal(r.kv.error, 'managed_skill_modified');
    assert.equal(r.kv.detail, 'beta-skill');
    assert.equal(sb.hash(), before, 'alpha-skill must not have been updated');
    // a missing managed dir counts as modified too
    rmSync(join(sb.skillsPath, 'beta-skill'), { recursive: true });
    assert.equal(sb.run(['skills-sync', TXN2, '--names', NAMES], { input: skillTar(V2) }).status, 3);
  } finally { sb.cleanup(); }
});

test('permission-only and empty-directory edits fail verification and are preserved by rollback and upgrade refusal', () => {
  for (const mutate of [
    (sb) => chmodSync(join(sb.skillsPath, 'alpha-skill', 'scripts', 'run.sh'), 0o700),
    (sb) => chmodSync(join(sb.skillsPath, 'alpha-skill'), 0o750),
    (sb) => mkdirSync(join(sb.skillsPath, 'alpha-skill', 'user-empty-dir')),
  ]) {
    const sb = seeded();
    try {
      sb.stageAll();
      assert.equal(sb.syncSkills(skillTar(V1), NAMES).status, 0);
      assert.equal(sb.apply().status, 0);
      mutate(sb);
      assert.equal(sb.verify({ skills: NAMES }).kv['check.managed-skills-intact'], 'fail');
      const before = sb.hash();
      const restored = sb.restore();
      assert.equal(restored.status, 3, restored.stdout);
      assert.equal(restored.kv.conflict, 'skill:alpha-skill');
      assert.equal(sb.hash(), before, 'rollback preserves every permission/empty-directory edit');
      assert.equal(sb.commit().status, 0);
      assert.equal(sb.backup(TXN2).status, 0);
      const upgradeBefore = sb.hash();
      const upgrade = sb.syncSkills(skillTar(V2), NAMES, TXN2);
      assert.equal(upgrade.status, 3, upgrade.stdout);
      assert.equal(upgrade.kv.error, 'managed_skill_modified');
      assert.equal(sb.hash(), upgradeBefore);
    } finally { sb.cleanup(); }
  }
});

test('an executable bit removed from a shipped script is detected even when its bytes are unchanged', () => {
  const sb = seeded();
  try {
    const src = join(sb.root, 'archive-source');
    mkdirSync(join(src, 'alpha-skill'), { recursive: true });
    writeFileSync(join(src, 'alpha-skill', 'SKILL.md'), 'run the script\n');
    writeFileSync(join(src, 'alpha-skill', 'run.sh'), '#!/bin/sh\necho hello\n');
    chmodSync(join(src, 'alpha-skill', 'run.sh'), 0o755);
    sb.stageAll();
    assert.equal(sb.syncSkills(buildSkillsTar(src, ['alpha-skill']), 'alpha-skill').status, 0);
    assert.equal(sb.apply().status, 0);
    assert.equal(sb.verify({ skills: 'alpha-skill' }).kv['check.managed-skills-intact'], 'pass');
    chmodSync(join(sb.skillsPath, 'alpha-skill', 'run.sh'), 0o600);
    assert.equal(sb.verify({ skills: 'alpha-skill' }).kv['check.managed-skills-intact'], 'fail');
    assert.equal(sb.restore().status, 3);
    assert.ok(existsSync(join(sb.skillsPath, 'alpha-skill', 'run.sh')));
  } finally { sb.cleanup(); }
});

test('legacy content-only manifest hashes are refused without adopting or deleting the old installation', () => {
  const sb = seeded();
  try {
    sb.write('.hermes/skills/alpha-skill/SKILL.md', 'legacy skill\n');
    // Reproduce the old name+content-only digest of a one-file skill.
    const digest = (s) => createHash('sha256').update(s).digest('hex');
    const legacyHash = digest(`${digest('legacy skill\n')}  ./SKILL.md\n`);
    sb.write('.hermes/.hstack/managed-skills.tsv', `alpha-skill\t${legacyHash}\tlegacytxn\t2026-01-01T00:00:00Z\n`);
    assert.equal(sb.backup().status, 0);
    const before = sb.hash();
    const result = sb.syncSkills(skillTar({ 'alpha-skill': { 'SKILL.md': 'new skill\n' } }), 'alpha-skill');
    assert.equal(result.status, 3, result.stdout);
    assert.equal(result.kv.error, 'managed_skill_modified');
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('restore removes only skills this txn created; user skills and the skills dir state are returned exactly', () => {
  const sb = seeded();
  try {
    const pre = sb.hash(STATE);
    const userBefore = userDirHash(sb);
    sb.backup();
    sb.syncSkills(skillTar(V1), NAMES);
    sb.apply();
    const r = sb.restore();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(sb.hash(STATE), pre);
    assert.equal(userDirHash(sb), userBefore);
    assert.ok(!existsSync(sb.manifestPath), 'manifest did not exist before; it must not exist after');
  } finally { sb.cleanup(); }
  // skills dir did not exist at all
  const sb2 = sandbox();
  try {
    sb2.backup();
    sb2.syncSkills(skillTar(V1), NAMES);
    assert.ok(existsSync(sb2.skillsPath));
    assert.equal(sb2.restore().status, 0);
    assert.ok(!existsSync(sb2.skillsPath), 'skills dir created by the txn is removed when empty');
  } finally { sb2.cleanup(); }
});

test('restore refuses (conflict) if a skill we created was edited afterwards, and changes nothing', () => {
  const sb = seeded();
  try {
    sb.backup();
    sb.syncSkills(skillTar(V1), NAMES);
    sb.apply();
    writeFileSync(join(sb.skillsPath, 'alpha-skill', 'SKILL.md'), 'edited after apply\n');
    const before = sb.hash();
    const r = sb.restore();
    assert.equal(r.status, 3);
    assert.equal(r.kv.conflict, 'skill:alpha-skill');
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('skills-sync then apply in the same txn works (apply accepts its own manifest change); sync is once per txn', () => {
  const sb = seeded();
  try {
    sb.stageAll();
    assert.equal(sb.syncSkills(skillTar(V1), NAMES).status, 0);
    const a = sb.apply();
    assert.equal(a.status, 0, a.stdout);
    const again = sb.syncSkills(skillTar(V1), NAMES);
    assert.equal(again.status, 3);
    assert.equal(sb.restore().status, 0);
  } finally { sb.cleanup(); }
  const sb2 = seeded();
  try {
    sb2.backup();
    assert.equal(sb2.syncSkills(skillTar(V1), NAMES).status, 0);
    const second = sb2.syncSkills(skillTar(V1), NAMES);
    assert.equal(second.status, 3);
    assert.equal(second.kv.error, 'skills_already_synced');
  } finally { sb2.cleanup(); }
});

test('hostile archives and names are rejected (exit 2) before anything is installed', () => {
  const sb = seeded();
  try {
    sb.backup();
    const before = sb.hash();
    const good = { name: 'alpha-skill/', dir: true };
    const skill = { name: 'alpha-skill/SKILL.md', content: 'x\n' };
    const cases = {
      'parent traversal': ustar([good, skill, { name: 'alpha-skill/../../evil', content: 'x' }]),
      'dot-dot top level': ustar([good, skill, { name: '../evil', content: 'x' }]),
      'absolute path': ustar([good, skill, { name: '/tmp/evil', content: 'x' }]),
      'symlink member': ustar([good, skill, { name: 'alpha-skill/link', type: '2', linkname: '/etc/passwd' }]),
      'hardlink member': ustar([good, skill, { name: 'alpha-skill/hard', type: '1', linkname: 'alpha-skill/SKILL.md' }]),
      'unexpected top-level': ustar([good, skill, { name: 'other-dir/', dir: true }, { name: 'other-dir/x', content: 'x' }]),
      'missing SKILL.md': ustar([good, { name: 'alpha-skill/readme', content: 'x' }]),
      'odd characters': ustar([good, skill, { name: 'alpha-skill/we ird;name', content: 'x' }]),
      'not a tar': Buffer.from('this is not a tar archive at all'),
      'empty input': Buffer.alloc(0),
    };
    for (const [label, tar] of Object.entries(cases)) {
      const r = sb.syncSkills(tar, 'alpha-skill');
      assert.equal(r.status, 2, `${label}: ${r.stdout}`);
      assert.equal(r.kv.error, 'tar_invalid', label);
      assert.equal(sb.hash(), before, `${label}: sandbox changed`);
    }
    for (const names of ['../x', 'Upper', 'a b', 'a,,b', 'a,a', '', ',a', 'a;b', 'a$(id)', '-lead', 'a\nb']) {
      const r = sb.run(['skills-sync', TXN, '--names', names], { input: skillTar(V1) });
      assert.equal(r.status, 2, JSON.stringify(names));
    }
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});

test('installer-owned dirs (carrying `.hstack-managed`, or no marker) are foreign: collision exit 5, no auto-adoption; the marker is never written', () => {
  const sb = seeded();
  try {
    // an installer-managed skill: its own marker holds a content checksum
    sb.write('.hermes/skills/alpha-skill/SKILL.md', 'alpha v1\n');
    sb.write('.hermes/skills/alpha-skill/.hstack-managed', 'sha256:0000installerchecksum\n');
    sb.backup();
    const before = sb.hash();
    const r = sb.syncSkills(skillTar(V1), NAMES);
    assert.equal(r.status, 5);
    assert.equal(r.kv.collisions, 'alpha-skill');
    assert.equal(sb.hash(), before);
    assert.equal(readFileSync(join(sb.skillsPath, 'alpha-skill', '.hstack-managed'), 'utf8'), 'sha256:0000installerchecksum\n');
    // inspect treats it as unmanaged (not in OUR manifest)
    assert.match(sb.run(['inspect']).kv.skills_unmanaged, /alpha-skill/);
  } finally { sb.cleanup(); }
});

test('tar members named after either marker file are rejected', () => {
  const sb = seeded();
  try {
    sb.backup();
    const before = sb.hash();
    for (const marker of ['.hstack-acceptance', '.hstack-managed']) {
      const tar = ustar([{ name: 'alpha-skill/', dir: true }, { name: 'alpha-skill/SKILL.md', content: 'x\n' }, { name: `alpha-skill/${marker}`, content: 'forged\n' }]);
      const r = sb.syncSkills(tar, 'alpha-skill');
      assert.equal(r.status, 2, marker);
      assert.equal(r.kv.detail, 'reserved_marker_name');
    }
    assert.equal(sb.hash(), before);
  } finally { sb.cleanup(); }
});
