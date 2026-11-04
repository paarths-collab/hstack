import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'connections.json');
  const withEnv = (env, ...args) => spawnSync(process.execPath, ['dist/manage.js', ...args], {
    env: { ...env, HSTACK_CONNECTIONS_FILE: path, HSTACK_STATE_DIR: join(root, 'auth') }, encoding: 'utf8', timeout: 5000,
  });
  return { root, path, run:(...args) => withEnv({}, ...args), withEnv };
}

test('setup initializes disabled templates, lists without connecting and never overwrites local configuration', async (t) => {
  const { path, run } = await fixture(t);
  assert.equal(run('init').status, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const configs = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(configs.connections.length, 30);
  assert.ok(configs.connections.every((config) => !config.enabled && !config.allowWrites));
  assert.equal(run('list').status, 0);
  assert.match(run('list').stdout, /brand24: disabled; OAuth login/);
  const original = '{"connections":[]}'; await writeFile(path, original);
  const result = run('init'); assert.equal(result.status, 1); assert.match(result.stderr, /preserved/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('explicit check discovers disabled local connection without executing tools or leaking env values', async (t) => {
  const { path, run } = await fixture(t);
  await writeFile(path, JSON.stringify({ connections: [{
    id: 'fixture', label: 'Fixture', enabled: false, transport: 'stdio', command: process.execPath,
    args: [resolve('tests/fixtures/echo-server.mjs')], env: {}, readTools: [], allowWrites: false,
  }] }));
  const result = run('check', 'fixture');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 tools discovered. No tool was executed/);
  assert.match(result.stdout,/MCP discovery succeeded.*Account operations remain unverified/);
  assert.match(result.stdout, /get_record/);
  assert.equal(result.stderr, '');
  assert.equal(run('check', 'unknown').status, 1);
  assert.match(run('login', 'fixture').stderr, /external sign-in/);
});

test('local disconnect clears only native OAuth credentials and accurately reports remote revocation limit', async (t) => {
  const { path, run } = await fixture(t);
  await writeFile(path, JSON.stringify({ connections: [{
    id: 'fixture', label: 'Fixture', enabled: false, transport: 'http', url: 'https://example.invalid/mcp',
    oauth: { type: 'oauth' }, readTools: [], allowWrites: false,
  }] }));
  const result = run('disconnect', 'fixture');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local OAuth credentials removed.*Revoke access in the vendor/);
  assert.equal(run('disconnect', 'fixture', 'extra').status, 1);
});

test('doctor is offline, preserves files, fails missing prerequisites and hides values', async (t) => {
  const { path, root, run, withEnv } = await fixture(t);
  const config = JSON.stringify({ connections:[{
    id:'fixture', label:'Fixture', enabled:false, transport:'stdio', commandEnv:'FIXTURE_COMMAND',
    args:['must-not-run'], env:{ KEY:'FIXTURE_KEY' }, readTools:[], allowWrites:false,
  }] });
  await writeFile(path, config);
  const missing = run('doctor', 'fixture');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /setup incomplete.*FIXTURE_COMMAND.*FIXTURE_KEY/s);
  const present = withEnv({ FIXTURE_COMMAND:process.execPath, FIXTURE_KEY:'synthetic-private-key' }, 'doctor', 'fixture');
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /offline prerequisites checked; vendor access unverified/);
  assert.match(present.stdout, /every operation will be blocked/);
  assert.match(present.stdout, /No service contacted/);
  assert.doesNotMatch(present.stdout + present.stderr, /synthetic-private-key|must-not-run/);
  assert.ok(!present.stdout.includes(process.execPath));
  assert.equal(await readFile(path, 'utf8'), config);
  await assert.rejects(stat(join(root, 'auth')), { code:'ENOENT' });
});

test('OAuth management resolves a private endpoint reference without printing it', async (t) => {
  const { path, run, withEnv } = await fixture(t);
  await writeFile(path, JSON.stringify({ connections:[{
    id:'fixture', label:'Fixture', enabled:false, transport:'http', urlEnv:'FIXTURE_URL',
    oauth:{ type:'oauth' }, readTools:[], allowWrites:false,
  }] }));
  assert.match(run('disconnect', 'fixture').stderr, /Set FIXTURE_URL/);
  const result = withEnv({ FIXTURE_URL:'https://example.invalid/mcp?private=synthetic-endpoint-secret' }, 'disconnect', 'fixture');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local OAuth credentials removed/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-endpoint-secret|example.invalid/);
});

test('doctor shows bundled account prerequisites before sign-in, without contacting the vendor',async(t)=>{
  const { path,run }=await fixture(t);
  const profile=JSON.parse(await readFile('integrations/bamboohr/connection.json','utf8'));
  await writeFile(path,JSON.stringify({ connections:[profile] }));
  const result=run('doctor','bamboohr');
  assert.equal(result.status,1);
  assert.match(result.stdout,/BAMBOOHR_MCP_CLIENT_ID/);
  assert.match(result.stdout,/integrations\/bamboohr\/README.md/);
  assert.match(result.stdout,/Vendor prerequisite:.*offline_access/);
  assert.match(result.stdout,/No service contacted/);
});

test('batch plan/prepare preserve configured values, never execute programs and create no auth state',async(t)=>{
  const {path,root,run}=await fixture(t);
  const catalog=run('catalog');assert.equal(catalog.status,0,catalog.stderr);
  assert.match(catalog.stdout,/mongodb: candidate template available/);
  assert.match(catalog.stdout,/bigquery: candidate template available/);
  assert.match(catalog.stdout,/snowflake: candidate template available; disabled native HTTP candidate; lifecycle negotiation unverified; live account not tested/);
  await assert.rejects(stat(path),{code:'ENOENT'});
  const marker=join(root,'must-not-execute');
  const original=JSON.stringify({connections:[{id:'private',label:'Private',enabled:true,transport:'stdio',command:process.execPath,
    args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`],readTools:[],allowWrites:false}],note:'synthetic-private-note'});
  await writeFile(path,original);
  const preview=run('plan','mongodb','redis');assert.equal(preview.status,0,preview.stderr);
  assert.doesNotMatch(preview.stdout,/synthetic-private-note|must-not-execute/);
  const prepared=run('prepare','mongodb','redis');assert.equal(prepared.status,0,prepared.stderr);
  const candidate=prepared.stdout.match(/^Candidate: (.+)$/m)[1];
  const configs=JSON.parse(await readFile(candidate,'utf8')).connections;
  assert.equal(configs.length,3);assert.equal(configs[0].enabled,true);assert.equal(configs[1].enabled,false);
  assert.equal(await readFile(path,'utf8'),original);
  await assert.rejects(stat(marker),{code:'ENOENT'});await assert.rejects(stat(join(root,'auth')),{code:'ENOENT'});
  assert.match(prepared.stdout,/nothing was activated/);
  assert.equal(run('plan').status,1);assert.equal(run('prepare','missing').status,1);
});
