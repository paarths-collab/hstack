import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readdir, readFile, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DiscoveryError } from '../dist/errors.js';
import { loadSocialPackage } from '../dist/providers.js';
import { desktopBufferAction, savedBufferKey, resolveBufferEnvironment, desktopSocialAction, savedSocialKey, resolveSocialEnvironment } from '../dist/desktop-credentials.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-desktop-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { HSTACK_CREDENTIAL_BACKEND: 'plaintext', HSTACK_STATE_DIR: join(dir, 'auth') };
}

test('Desktop Buffer save, test, replace and disconnect use private storage without exposing credentials', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t), secret = 'synthetic-buffer-value';
  assert.equal((await desktopBufferAction({ action: 'status' }, env)).state, 'not_saved');
  const saved = await desktopBufferAction({ action: 'save', key: secret }, env);
  assert.equal(saved.state, 'saved');
  assert.ok(!JSON.stringify(saved).includes(secret));
  assert.equal(await savedBufferKey(env), secret);
  let calls = 0;
  assert.equal((await desktopBufferAction({ action: 'test' }, env, async key => { calls++; assert.equal(key, secret); return true; })).state, 'verified');
  assert.equal(calls, 1);
  assert.equal((await desktopBufferAction({ action: 'test' }, env, async () => false)).state, 'error');
  const [file] = await readdir(env.HSTACK_STATE_DIR);
  assert.equal((await lstat(env.HSTACK_STATE_DIR)).mode & 0o077, 0);
  assert.equal((await lstat(join(env.HSTACK_STATE_DIR, file))).mode & 0o077, 0);
  assert.ok((await readFile(join(env.HSTACK_STATE_DIR, file), 'utf8')).includes(secret));
  await desktopBufferAction({ action: 'save', key: 'synthetic-replacement' }, env);
  assert.equal(await savedBufferKey(env), 'synthetic-replacement');
  await desktopBufferAction({ action: 'disconnect' }, env);
  assert.equal(await savedBufferKey(env), undefined);
  assert.equal((await desktopBufferAction({ action: 'test' }, env, async () => { throw Error('must not call'); })).state, 'not_saved');
});

test('Desktop credential store refuses malformed keys, insecure permissions and symlinks', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t);
  for (const key of ['', 'bad\nvalue', 'x'.repeat(4097)]) await assert.rejects(desktopBufferAction({ action: 'save', key }, env));
  await desktopBufferAction({ action: 'save', key: 'synthetic-key' }, env);
  const [file] = await readdir(env.HSTACK_STATE_DIR);
  await chmod(join(env.HSTACK_STATE_DIR, file), 0o644);
  await assert.rejects(savedBufferKey(env));
  await rm(env.HSTACK_STATE_DIR, { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), 'hstack-desktop-target-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, env.HSTACK_STATE_DIR);
  await assert.rejects(desktopBufferAction({ action: 'save', key: 'synthetic-key' }, env));
});

test('bridge sends no key in output and cannot execute unknown operations', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t), secret = 'synthetic-secret-for-test';
  const run = request => spawnSync(process.execPath, ['dist/desktop-bridge.js'], {
    input: JSON.stringify(request), encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
  });
  const saved = run({ action: 'save', key: secret });
  assert.equal(saved.status, 0); assert.ok(!saved.stdout.includes(secret)); assert.equal(saved.stderr, '');
  const invalid = run({ action: 'arbitrary', key: secret });
  assert.equal(invalid.status, 1); assert.ok(!invalid.stdout.includes(secret)); assert.equal(invalid.stderr, '');
});

test('explicit Buffer environment key takes precedence and saved keys fill only missing values', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t);
  await desktopBufferAction({ action: 'save', key: 'saved-synthetic' }, env);
  assert.equal((await resolveBufferEnvironment(env)).BUFFER_API_KEY, 'saved-synthetic');
  assert.equal((await resolveBufferEnvironment({ ...env, BUFFER_API_KEY: 'env-synthetic' })).BUFFER_API_KEY, 'env-synthetic');
  assert.equal(env.BUFFER_API_KEY, undefined);
});


test('five social services have isolated credentials and preserve environment precedence', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t);
  const services = [['buffer','BUFFER_API_KEY'],['pallyy','PALLYY_API_KEY'],['metricool','METRICOOL_API_KEY'],['blotato','BLOTATO_API_KEY'],['ayrshare','AYRSHARE_API_KEY']];
  for (const [provider] of services) {
    const key = `synthetic-${provider}`;
    assert.equal((await desktopSocialAction({provider, action:'save', key}, env)).state, 'saved');
    assert.equal(await savedSocialKey(provider, env), key);
    const result = await desktopSocialAction({provider, action:'test'}, env, async (definition, supplied) => {
      assert.equal(definition.id, provider); assert.equal(supplied, key); return true;
    });
    assert.equal(result.state, provider === 'metricool' ? 'error' : 'verified');
    assert.ok(!JSON.stringify(result).includes(key));
    if (provider === 'metricool') assert.match(result.message, /Activation remains blocked/);
  }
  const resolved = await resolveSocialEnvironment({ ...env, PALLYY_API_KEY: 'env-pallyy' });
  assert.deepEqual(resolved.failed, []);
  for (const [provider, variable] of services) assert.equal(resolved.env[variable], provider === 'pallyy' ? 'env-pallyy' : `synthetic-${provider}`);
  await desktopSocialAction({provider:'pallyy', action:'disconnect'}, env);
  assert.equal(await savedSocialKey('pallyy', env), undefined);
  assert.equal(await savedSocialKey('buffer', env), 'synthetic-buffer');
  await assert.rejects(desktopSocialAction({provider:'unknown', action:'save', key:'secret'}, env));
});

test('invalid stored service key is isolated and known rate-limit details are actionable', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t);
  await desktopSocialAction({provider:'pallyy', action:'save', key:'synthetic-pallyy'}, env);
  const [pallyyFile] = await readdir(env.HSTACK_STATE_DIR);
  await chmod(join(env.HSTACK_STATE_DIR, pallyyFile), 0o644);
  await desktopSocialAction({provider:'buffer', action:'save', key:'synthetic-buffer'}, env);
  const result = await resolveSocialEnvironment(env);
  assert.deepEqual(result.failed, ['pallyy']);
  assert.equal(result.env.BUFFER_API_KEY, 'synthetic-buffer');
  assert.equal(result.env.PALLYY_API_KEY, undefined);
  const limited = await desktopSocialAction({provider:'buffer', action:'test'}, env, async () => {
    throw new DiscoveryError('sensitive upstream text', {code:'RATE_LIMITED', retryAfterSeconds:45});
  });
  assert.equal(limited.state, 'error'); assert.match(limited.message, /45 seconds/);
  assert.match(limited.message, /window is unknown/); assert.doesNotMatch(limited.message, /sensitive/);
});

test('saved Desktop keys flow into the normal social gateway loader without enabling writes', async t => {
  if (process.platform === 'win32') return t.skip('Owner-only AuthStore requires POSIX');
  const env = await fixture(t);
  for (const provider of ['buffer','pallyy','ayrshare'])
    await desktopSocialAction({provider, action:'save', key:`synthetic-${provider}`}, env);
  const {env: resolved} = await resolveSocialEnvironment(env), calls = [];
  const loaded = await loadSocialPackage(resolved, async (definition, key, allowWrites) => {
    calls.push([definition.id, key, allowWrites]);
    return {id:definition.id,label:definition.label,tools:[],readTools:new Set(),allowWrites,call:async()=>({content:[]})};
  });
  assert.deepEqual(calls, [['buffer','synthetic-buffer',false],['pallyy','synthetic-pallyy',false],['ayrshare','synthetic-ayrshare',false]]);
  assert.deepEqual(loaded.providers.map(provider=>provider.id), ['buffer','pallyy','ayrshare']);
  assert.deepEqual(loaded.failed, []);
});
