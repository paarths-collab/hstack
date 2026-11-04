import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, chmod, rm, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GoogleBigQueryCredentials } from '../dist/google-credentials.js';

// Deliberately synthetic. No actual ADC file, identity, key or OAuth endpoint.
const user = () => ({ type: 'authorized_user', client_id: 'fixture.apps.googleusercontent.com',
  client_secret: 'synthetic-client-value', refresh_token: 'synthetic-refresh-value', quota_project_id: 'fixture-project' });
const response = (token = 'synthetic-access-value', expires = 3600) => Response.json({ access_token: token, expires_in: expires, token_type: 'Bearer' });
async function fixture(t, value = user()) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-google-credentials-'));
  const path = join(root, 'credentials.json');
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path };
}
const deadline = () => AbortSignal.timeout(2000);

test('Google native authorized-user refresh, caching and quota header use only the fixed token endpoint', async t => {
  const { path } = await fixture(t); const before = await readFile(path, 'utf8'); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async (url, init) => {
    calls++; assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), user().refresh_token);
    assert.equal(form.get('client_id'), user().client_id); assert.equal(form.get('client_secret'), user().client_secret);
    return response();
  });
  t.after(() => auth.close());
  assert.deepEqual(await auth.headers(deadline()), { Authorization: 'Bearer synthetic-access-value', 'x-goog-user-project': 'fixture-project' });
  assert.deepEqual(await auth.headers(deadline()), await auth.headers(deadline()));
  assert.equal(calls, 1); assert.equal(await readFile(path, 'utf8'), before);
  await auth.invalidateAccessToken();
  await auth.headers(deadline());
  assert.equal(calls, 2); assert.equal(await readFile(path, 'utf8'), before);
});

test('Google native service-account signing uses a generated ephemeral key and BigQuery-only scope', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { path } = await fixture(t, { type: 'service_account', client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
  let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async (url, init) => {
    calls++; assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion'); const [header, payload, signature] = assertion.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, 'fixture@fixture-project.iam.gserviceaccount.com');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/bigquery');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
    return response();
  });
  t.after(() => auth.close());
  assert.deepEqual(await auth.headers(deadline()), { Authorization: 'Bearer synthetic-access-value' });
  await auth.headers(deadline()); assert.equal(calls, 1);
});

test('Google credential loading is lazy and missing credentials never start network or metadata lookup', async () => {
  let calls = 0; const auth = new GoogleBigQueryCredentials(undefined, async () => { calls++; return response(); });
  await assert.rejects(auth.headers(deadline()), e => e.details?.code === 'AUTH_REQUIRED' && e.details.outcome === 'not_sent');
  assert.equal(calls, 0); await auth.close();
});

test('Google credential files and containing directories must be private, regular and unlinked', async t => {
  const { root, path } = await fixture(t); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async () => { calls++; return response(); });
  t.after(() => auth.close());
  await chmod(path, 0o644); await assert.rejects(auth.headers(deadline())); await chmod(path, 0o600);
  await chmod(root, 0o755); await assert.rejects(auth.headers(deadline())); await chmod(root, 0o700);
  const other = join(root, 'other'); await link(path, other); await assert.rejects(auth.headers(deadline())); await unlink(other);
  await unlink(path); await writeFile(other, JSON.stringify(user()), { mode: 0o600 });
  await symlink(other, path); await assert.rejects(auth.headers(deadline()));
  assert.equal(calls, 0);
});

test('Google credential configurations reject external executables, foreign endpoints and malformed secrets before network', async t => {
  const { path } = await fixture(t); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async () => { calls++; return response(); }); t.after(() => auth.close());
  for (const value of [
    { type: 'external_account', credential_source: { executable: { command: 'must-never-run' } } },
    { type: 'impersonated_service_account', service_account_impersonation_url: 'https://example.invalid' },
    { ...user(), universe_domain: 'example.invalid' }, { ...user(), token_uri: 'https://example.invalid/token' },
    { ...user(), refresh_token: 'bad\nvalue' }, { ...user(), quota_project_id: 'bad\r\nheader' },
    { ...user(), credential_source: { url: 'http://169.254.169.254' } },
    { type: 'service_account', client_email: 'fixture@example.invalid', private_key: 'invalid' },
  ]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(auth.headers(deadline()), e => e.details?.code === 'AUTH_REQUIRED' && !e.message.includes('example.invalid'));
  }
  assert.equal(calls, 0);
});

test('Google credential changes invalidate cached tokens and are never written back', async t => {
  const { path } = await fixture(t); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async (_url, init) => {
    calls++; const form = new URLSearchParams(String(init.body));
    return response(form.get('refresh_token') === user().refresh_token ? 'first-synthetic-value' : 'second-synthetic-value');
  }); t.after(() => auth.close());
  assert.match((await auth.headers(deadline())).Authorization, /first-/);
  const next = JSON.stringify({ ...user(), refresh_token: 'second-synthetic-refresh' }); await writeFile(path, next);
  assert.match((await auth.headers(deadline())).Authorization, /second-/);
  assert.equal(calls, 2); assert.equal(await readFile(path, 'utf8'), next);
});

test('Google SDK refreshes an expiring cached token before the next operation', async t => {
  const { path } = await fixture(t); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async () => { calls++; return response(`synthetic-access-${calls}`, calls === 1 ? 1 : 3600); });
  t.after(() => auth.close());
  assert.match((await auth.headers(deadline())).Authorization, /synthetic-access-1$/);
  assert.match((await auth.headers(deadline())).Authorization, /synthetic-access-2$/);
  assert.match((await auth.headers(deadline())).Authorization, /synthetic-access-2$/);
  assert.equal(calls, 2);
});

test('Google credentials changed during refresh cannot dispatch the old identity', async t => {
  const { path } = await fixture(t);
  const auth = new GoogleBigQueryCredentials(path, async () => {
    await writeFile(path, JSON.stringify({ ...user(), client_id: 'changed.apps.googleusercontent.com' })); return response();
  }); t.after(() => auth.close());
  await assert.rejects(auth.headers(deadline()), e => e.details?.code === 'AUTH_REQUIRED' && /changed during refresh/.test(e.message));
});

test('Google refresh rejects expired or malformed tokens, hides vendor errors and does not retry failures', async t => {
  const { path } = await fixture(t);
  const networkFailure = () => { throw new Error('private-description'); };
  for (const reply of [() => response('', 3600), () => response('bad\nheader'), () => response('expired', -1),
    () => Response.json({ error: 'invalid_grant', error_description: 'private-description' }, { status: 400 }),
    () => new Response('private-description', { status: 500 }),
    networkFailure,
  ]) {
    let calls = 0; const auth = new GoogleBigQueryCredentials(path, async () => { calls++; return reply(); });
    await assert.rejects(auth.headers(deadline()), e => !e.message.includes('private-description') && e.details?.outcome === 'not_sent'
      && (reply !== networkFailure || e.details?.code === 'UNAVAILABLE'));
    assert.equal(calls, 1); await auth.close();
  }
});

test('Google refresh rate limits retain Retry-After without guessing a quota window', async t => {
  const { path } = await fixture(t); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async () => { calls++; return new Response('private', { status: 429, headers: { 'Retry-After': '22' } }); });
  t.after(() => auth.close());
  await assert.rejects(auth.headers(deadline()), e => e.details?.code === 'RATE_LIMITED' && e.details.retryAfterSeconds === 22 && e.details.windowSeconds === undefined);
  assert.equal(calls, 1);
});

test('Google concurrent refresh uses one cached token and cancelled queue entries cannot release another refresh', async t => {
  const { path } = await fixture(t); let started, finish; let calls = 0;
  const ready = new Promise(resolve => { started = resolve; }); const blocked = new Promise(resolve => { finish = resolve; });
  const auth = new GoogleBigQueryCredentials(path, async () => { calls++; started(); await blocked; return response(); }); t.after(() => auth.close());
  const first = auth.headers(deadline()); await ready;
  const cancelled = new AbortController(); const second = auth.headers(cancelled.signal); cancelled.abort();
  await assert.rejects(second, e => e.details?.code === 'CANCELLED');
  const third = auth.headers(deadline()); assert.equal(calls, 1); finish();
  assert.deepEqual(await third, await first); assert.equal(calls, 1);
});

test('Google token network requests honor cancellation and closed providers never reload credentials', async t => {
  const { path } = await fixture(t); let started; const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController(); let calls = 0;
  const auth = new GoogleBigQueryCredentials(path, async (_url, init) => {
    calls++; started(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const pending = auth.headers(controller.signal); await ready; controller.abort();
  await assert.rejects(pending, e => e.details?.code === 'CANCELLED'); await auth.close();
  await assert.rejects(auth.headers(deadline()), e => e.details?.code === 'UNAVAILABLE'); assert.equal(calls, 1);
});
