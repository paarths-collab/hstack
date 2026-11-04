import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, chmod, symlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../dist/auth-store.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-auth-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new AuthStore(root, ['fixture', 'https://example.invalid/mcp']) };
}

test('credentials persist atomically with owner-only permissions and no temporary files', async (t) => {
  const { root, store } = await fixture(t);
  await store.locked(AbortSignal.timeout(1000), async () => {
    assert.equal(await store.read(), undefined);
    await store.write({ version: 1, tokens: { access_token: 'fixture-only', issuer: 'https://example.invalid' } });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await store.read()).tokens.issuer, 'https://example.invalid');
    await store.write({ version: 1 });
  });
  assert.deepEqual(await readdir(root), [store.path.split('/').at(-1)]);
  await store.locked(AbortSignal.timeout(1000), () => store.remove());
  assert.deepEqual(await readdir(root), []);
});

test('unsafe directories, symlink files and world-readable credential files are refused', async (t) => {
  const { root, store } = await fixture(t);
  await chmod(root, 0o755);
  await assert.rejects(store.locked(AbortSignal.timeout(1000), async () => {}), /storage is unsafe/);
  await chmod(root, 0o700);
  const target = join(root, 'outside');
  await writeFile(target, '{"private":"fixture"}', { mode: 0o600 });
  await symlink(target, store.path);
  await assert.rejects(store.locked(AbortSignal.timeout(1000), () => store.write({})), /storage is unsafe/);
  await rm(store.path);
  await writeFile(store.path, '{}', { mode: 0o644 });
  await assert.rejects(store.locked(AbortSignal.timeout(1000), () => store.read()), /storage is unsafe/);
  await rm(store.path);
  const link = join(root, 'linked-root');
  await symlink(root, link);
  await assert.rejects(new AuthStore(link, 'fixture').locked(AbortSignal.timeout(1000), async () => {}), /storage is unsafe/);
});

test('independent store instances serialize credential changes and release after errors', async (t) => {
  const { root, store } = await fixture(t);
  const other = new AuthStore(root, ['fixture', 'https://example.invalid/mcp']);
  await Promise.all([store, other].map((entry) => entry.locked(AbortSignal.timeout(1000), async () => {
    const prior = await entry.read() ?? { count: 0 };
    await new Promise((resolve) => setTimeout(resolve, 30));
    await entry.write({ count: prior.count + 1 });
  })));
  assert.equal((await store.read()).count, 2);
  await assert.rejects(store.locked(AbortSignal.timeout(1000), async () => { throw new Error('fixture'); }), /fixture/);
  await other.locked(AbortSignal.timeout(1000), async () => {});
});

test('lock waiting has a bounded deadline and never steals a live lock', async (t) => {
  const { root, store } = await fixture(t);
  const other = new AuthStore(root, ['fixture', 'https://example.invalid/mcp']);
  await store.locked(AbortSignal.timeout(1000), async () => {
    await assert.rejects(other.locked(AbortSignal.timeout(30), async () => assert.fail('must not execute')), (error) => error.details.code === 'TIMEOUT');
  });
  assert.deepEqual(await readdir(root), []);
});

test('credentials cannot be reused after endpoint or registration settings change', async (t) => {
  const { root, store } = await fixture(t);
  assert.notEqual(store.path, new AuthStore(root, ['fixture', 'https://other.invalid/mcp']).path);
  assert.throws(() => new AuthStore('relative-path', 'fixture'));
});
