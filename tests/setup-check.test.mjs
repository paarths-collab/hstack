import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSetup } from '../dist/setup-check.js';

const base = { id:'fixture', label:'Fixture', enabled:false, readTools:[], allowWrites:false };

test('offline doctor reports all missing env names without values or credential checks', async () => {
  const config = { ...base, transport:'http', urlEnv:'FIXTURE_URL', headers:{ Authorization:{ env:'FIXTURE_KEY' } } };
  const report = await checkSetup(config, { FIXTURE_KEY:'synthetic-private-credential' });
  assert.deepEqual(report.issues, ['Set FIXTURE_URL in the launch environment.']);
  assert.match(report.notes.join(' '), /Disabled.*readTools is empty.*No service contacted/);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-credential/);
  const valid = await checkSetup(config, { FIXTURE_URL:'https://example.invalid/private?token=synthetic-url-secret', FIXTURE_KEY:'synthetic-key' });
  assert.deepEqual(valid.issues, []);
  assert.doesNotMatch(JSON.stringify(valid), /synthetic-url-secret|synthetic-key|example.invalid/);
  const invalid = await checkSetup(config, { FIXTURE_URL:'https://user:synthetic-password@example.invalid', FIXTURE_KEY:'synthetic-key' });
  assert.match(invalid.issues.join(' '), /invalid/);
  assert.doesNotMatch(JSON.stringify(invalid), /synthetic-password|example.invalid/);
});

test('offline doctor inspects executable presence and permissions without running it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-doctor-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const path = join(root, 'do-not-execute');
  // Execution must never happen, even with a real executable supplied.
  await writeFile(path, '#!/bin/sh\nexit 83\n', { mode:0o700 });
  const config = { ...base, transport:'stdio', commandEnv:'FIXTURE_COMMAND', env:{ KEY:'FIXTURE_KEY' } };
  const env = { FIXTURE_COMMAND:path, FIXTURE_KEY:'synthetic-private-key', PATH:root };
  assert.deepEqual((await checkSetup(config, env)).issues, []);
  assert.deepEqual((await checkSetup({ ...config, commandEnv:undefined, command:'do-not-execute' }, env)).issues, []);
  await chmod(path, 0o600);
  assert.match((await checkSetup(config, env)).issues.join(' '), /not executable/);
  assert.match((await checkSetup(config, { ...env, FIXTURE_COMMAND:root })).issues.join(' '), /not executable/);
  assert.match((await checkSetup(config, {})).issues.join(' '), /FIXTURE_COMMAND.*FIXTURE_KEY/);
  assert.match((await checkSetup({ ...config, commandEnv:undefined, command:'/absolute/path/to/configured-vendor-mcp' }, env)).issues.join(' '), /placeholder/);
});

test('offline doctor explicitly leaves OAuth validation open and warns about unrestricted writes', async () => {
  const report = await checkSetup({ ...base, enabled:true, transport:'http', url:'https://example.invalid/mcp',
    oauth:{ type:'oauth', issuer:'https://example.invalid', clientId:'synthetic-client', clientSecretEnv:'FIXTURE_SECRET' }, allowWrites:true }, {});
  assert.deepEqual(report.issues, ['Set FIXTURE_SECRET in the launch environment.']);
  assert.match(report.notes.join(' '), /Enabled.*OAuth login, scopes and refresh have not been checked.*all discovered operations can be called/);
});

test('offline doctor names missing registration refs without exposing tenant or scope values',async()=>{
  const config={ ...base,transport:'http',urlEnv:'FIXTURE_URL',oauth:{ type:'oauth',clientIdEnv:'FIXTURE_CLIENT',issuerEnv:'FIXTURE_ISSUER',scopeEnv:'FIXTURE_SCOPE',clientSecretEnv:'FIXTURE_SECRET' } };
  const report=await checkSetup(config,{ FIXTURE_URL:'https://private-tenant.example.invalid/mcp',FIXTURE_SCOPE:'private-role:read' });
  assert.deepEqual(report.issues,['Set FIXTURE_SECRET in the launch environment.','Set FIXTURE_ISSUER in the launch environment.','Set FIXTURE_CLIENT in the launch environment.']);
  assert.match(report.notes.join(' '),/pre-registered OAuth client/);
  assert.doesNotMatch(JSON.stringify(report),/private-tenant|private-role|settings are invalid/);
});
