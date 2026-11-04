import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConnection, parseConnections } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { checkSetup } from '../dist/setup-check.js';
import { prepareConnections } from '../dist/prepare.js';
import { createBigQuerySchemaValidator } from '../dist/bigquery-schema.js';

const profile = JSON.parse(await readFile('integrations/bigquery/connection.json', 'utf8'));
// Synthetic API responses shaped by Google's public list_dataset_ids schema.
const read = { name: 'list_dataset_ids', description: 'List BigQuery datasets', inputSchema: {
  type: 'object', properties: { projectId: { type: 'string' }, pageSize: { type: 'integer', format: 'int32' } }, required: ['projectId'],
}, outputSchema: { type: 'object', properties: { datasets: { type: 'array', items: { $ref: '#/$defs/dataset' } } },
  $defs: { dataset: { type: 'object', properties: { id: { type: 'string' } } } },
}, annotations: { readOnlyHint: true } };
const sql = { name: 'execute_sql_readonly', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, query: { type: 'string' } }, required: ['projectId','query'] } };
async function fixture(t, tools = [read, sql]) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-bigquery-connection-')), path = join(root, 'credentials.json');
  const credential = JSON.stringify({ type: 'authorized_user', client_id: 'fixture.apps.googleusercontent.com',
    client_secret: 'synthetic-client-value', refresh_token: 'synthetic-refresh-value' });
  await writeFile(path, credential, { mode: 0o600 }); t.after(() => rm(root, { recursive: true, force: true }));
  const seen = { tokens: 0, discovery: 0, reads: 0, sql: 0 }, methods=[];
  let status = 200, value = { datasets: [{ id: 'synthetic-hidden-dataset' }] }, modern = false, authorization='synthetic-access-value';
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      seen.tokens++; return Response.json({ access_token: 'synthetic-access-value', expires_in: 3600, token_type: 'Bearer' });
    }
    assert.equal(String(url), 'https://bigquery.googleapis.com/mcp');
    const request = JSON.parse(init.body), headers = new Headers(init.headers);
    methods.push(request.method);
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'google-shaped-fixture', version: '0' },
    } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 204 });
    assert.equal(headers.get('mcp-protocol-version'), '2025-11-25');
    if (request.method === 'tools/list') {
      seen.discovery++; assert.equal(headers.has('authorization'), false);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools } });
    }
    assert.equal(request.method, 'tools/call'); assert.equal(headers.get('authorization'), `Bearer ${authorization}`);
    request.params.name === 'execute_sql_readonly' ? seen.sql++ : seen.reads++;
    if (status !== 200) return new Response('private-vendor-error', { status, headers: { 'Retry-After': '18' } });
    const result = value?.isError ? value : { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: modern ? { ...result, resultType: 'complete' } : result });
  };
  return { root, path, credential, seen, methods, fetchImpl, authorize:value=>{authorization=value;},
    status: s => { status = s; }, value: v => { value = v; }, modern: () => { modern = true; } };
}
async function gateway(t, f, config = profile, env = { BIGQUERY_GOOGLE_CREDENTIALS_FILE: f.path }, search = false) {
  const provider = await loadConnection(config, env, undefined, { bigQueryFetch: f.fetchImpl });
  const server = createSocialGateway([provider], search ? { toolMode: 'search' } : {}), client = new Client({ name: 'bigquery-fixture', version: '0' });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  t.after(async () => { await client.close(); await server.close(); await provider.close(); });
  return { provider, client };
}

test('BigQuery gateway uses public discovery, lazy native refresh, correct routing and exact schema/result preservation (synthetic)', async t => {
  const f = await fixture(t); const { client } = await gateway(t, f);
  assert.equal(f.seen.tokens, 0); assert.equal(f.seen.discovery, 1);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed[0].inputSchema, read.inputSchema); assert.deepEqual(listed[0].outputSchema, read.outputSchema);
  for (const modern of [false, true]) {
    if (modern) f.modern();
    const result = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
    assert.equal(result.isError, undefined); assert.deepEqual(result.structuredContent, { datasets: [{ id: 'synthetic-hidden-dataset' }] });
  }
  assert.equal(f.seen.tokens, 1); assert.equal(f.seen.reads, 2); assert.equal(f.seen.sql, 0);
  assert.equal(await readFile(f.path, 'utf8'), f.credential);
});

test('BigQuery credential rotation refreshes the identity on the next call without reusing headers or repeating the public handshake',async t=>{
  const f=await fixture(t);let rotating=false;
  const fetchImpl=async(url,init)=>{
    const result=await f.fetchImpl(url,init);
    if(String(url)==='https://oauth2.googleapis.com/token'&&rotating){
      assert.equal(new URLSearchParams(String(init.body)).get('refresh_token'),'synthetic-rotated-refresh');
      return Response.json({access_token:'synthetic-rotated-access',expires_in:3600,token_type:'Bearer'});
    }
    return result;
  };
  const provider=await loadConnection(profile,{BIGQUERY_GOOGLE_CREDENTIALS_FILE:f.path},undefined,{bigQueryFetch:fetchImpl});t.after(()=>provider.close());
  await provider.call('list_dataset_ids',{projectId:'fixture-project'},AbortSignal.timeout(2000));
  rotating=true;f.authorize('synthetic-rotated-access');
  await writeFile(f.path,JSON.stringify({...JSON.parse(f.credential),refresh_token:'synthetic-rotated-refresh'}));
  await provider.call('list_dataset_ids',{projectId:'fixture-project'},AbortSignal.timeout(2000));
  assert.equal(f.seen.tokens,2);assert.equal(f.seen.reads,2);assert.equal(f.methods.filter(method=>method==='initialize').length,1);
});

test('BigQuery forgets a rejected access token for the next explicit request without replaying the failed call',async t=>{
  const f=await fixture(t),{provider}=await gateway(t,f);f.status(401);
  await assert.rejects(provider.call('list_dataset_ids',{projectId:'fixture-project'},AbortSignal.timeout(2000)),e=>e.details.code==='AUTH_REQUIRED'&&e.details.outcome==='unknown');
  assert.equal(f.seen.tokens,1);assert.equal(f.seen.reads,1);
  f.status(200);await provider.call('list_dataset_ids',{projectId:'fixture-project'},AbortSignal.timeout(2000));
  assert.equal(f.seen.tokens,2);assert.equal(f.seen.reads,2);assert.equal(f.methods.filter(method=>method==='initialize').length,1);
});

test('BigQuery refuses newly stateful sessions before loading Google credentials',async t=>{
  const f=await fixture(t);
  const fetchImpl=async(url,init)=>{
    const result=await f.fetchImpl(url,init);
    if(String(url).includes('bigquery.googleapis.com')&&JSON.parse(init.body).method==='initialize'){
      const headers=new Headers(result.headers);headers.set('Mcp-Session-Id','synthetic-server-session');
      return new Response(result.body,{status:result.status,headers});
    }
    return result;
  };
  await assert.rejects(loadConnection(profile,{},undefined,{bigQueryFetch:fetchImpl}),e=>e.details.code==='UNAVAILABLE'
    &&e.details.outcome==='not_sent'&&!e.message.includes('synthetic-server-session'));
  assert.equal(f.seen.tokens,0);assert.equal(f.seen.reads,0);
});

test('BigQuery public discovery cannot prove auth: missing credential files fail calls before token or API dispatch', async t => {
  const f = await fixture(t), { client } = await gateway(t, f, profile, {});
  const result = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
  assert.equal(result._meta.hstack.code, 'AUTH_REQUIRED'); assert.equal(result._meta.hstack.outcome, 'not_sent');
  assert.deepEqual(f.seen, { tokens: 0, discovery: 1, reads: 0, sql: 0 });
});

test('BigQuery SQL reads require explicit permission even when vendor labels them readonly; invalid arguments are not sent', async t => {
  const f = await fixture(t), { client } = await gateway(t, f);
  const sqlCall = await client.callTool({ name: 'bigquery__execute_sql_readonly', arguments: { projectId: 'fixture-project', query: 'synthetic query never executed' } });
  assert.equal(sqlCall._meta.hstack.code, 'FORBIDDEN'); assert.equal(sqlCall._meta.hstack.outcome, 'not_sent');
  assert.equal((await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: {} })).isError, true);
  assert.equal(f.seen.tokens, 0); assert.equal(f.seen.sql, 0); assert.equal(f.seen.reads, 0);
});

test('BigQuery empty dataset results remain successful and malformed structured outputs are rejected', async t => {
  const f = await fixture(t), { client } = await gateway(t, f); f.value({ datasets: [] });
  assert.deepEqual((await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } })).structuredContent, { datasets: [] });
  f.value({ datasets: 'not-an-array' });
  const failed = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
  assert.equal(failed._meta.hstack.code, 'UPSTREAM_ERROR'); assert.equal(failed.isError, true);
});

test('BigQuery HTTP auth, permission, rate-limit and server errors are safe and never replay the operation', async t => {
  for (const [status, code] of [[401,'AUTH_REQUIRED'],[403,'FORBIDDEN'],[429,'RATE_LIMITED'],[500,'UPSTREAM_ERROR']]) {
    const f = await fixture(t), { client } = await gateway(t, f); f.status(status);
    const failed = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
    assert.equal(failed._meta.hstack.code, code); assert.equal(failed._meta.hstack.outcome, 'unknown');
    assert.doesNotMatch(JSON.stringify(failed), /private-vendor-error|synthetic-access-value/);
    if (status === 429) assert.equal(failed._meta.hstack.retryAfterSeconds, 18);
    assert.equal(f.seen.reads, 1); assert.equal(f.seen.tokens, 1);
  }
});

test('BigQuery native tool errors cannot masquerade as successful empty data or expose raw content', async t => {
  const f = await fixture(t), { client } = await gateway(t, f);
  f.value({ content: [{ type: 'text', text: 'private-vendor-error' }], isError: true });
  const failed = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
  assert.equal(failed.isError, true); assert.equal(failed._meta.hstack.code, 'UPSTREAM_ERROR');
  assert.doesNotMatch(JSON.stringify(failed), /private-vendor-error/);
});

test('BigQuery schema routing changes fail before credential reads and closed providers reject later calls', async t => {
  const changed = structuredClone(read); changed.inputSchema.properties.projectId['x-mcp-header'] = 'project-id';
  const f = await fixture(t, [changed]), { provider, client } = await gateway(t, f);
  const failed = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } });
  assert.equal(failed._meta.hstack.outcome, 'not_sent'); assert.equal(failed._meta.hstack.code, 'UNAVAILABLE'); assert.equal(f.seen.tokens, 0);
  await provider.close();
  await assert.rejects(provider.call('list_dataset_ids', { projectId: 'fixture-project' }, AbortSignal.timeout(1000)), e => e.details?.code === 'UNAVAILABLE');
});

test('BigQuery cancellation after dispatch has unknown outcome and never retries the operation', async t => {
  const f = await fixture(t); let started; const ready = new Promise(resolve => { started = resolve; }); let operations = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('bigquery.googleapis.com') && JSON.parse(init.body).method === 'tools/call') {
      operations++; started();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return f.fetchImpl(url, init);
  };
  const provider = await loadConnection(profile, { BIGQUERY_GOOGLE_CREDENTIALS_FILE: f.path }, undefined, { bigQueryFetch: fetchImpl });
  t.after(() => provider.close());
  const controller = new AbortController(), pending = provider.call('list_dataset_ids', { projectId: 'fixture-project' }, controller.signal);
  await ready; controller.abort();
  await assert.rejects(pending, e => e.details?.code === 'CANCELLED' && e.details.outcome === 'unknown');
  assert.equal(operations, 1); assert.equal(f.seen.tokens, 1);
});

test('BigQuery unknown result kinds and ambiguous legacy-shaped responses fail safely after dispatch', async t => {
  for (const result of [
    { resultType: 'input_required', inputRequests: {}, requestState: {} },
    { resultType: 'future-result', content: [] },
    { content: [], inputRequests: { private: 'private-vendor-error' } },
    { resultType: 'complete', content: [{ type: 'unsupported' }] },
  ]) {
    const f = await fixture(t);
    const fetchImpl = async (url, init) => {
      if (String(url).includes('bigquery.googleapis.com')) {
        const request = JSON.parse(init.body);
        if (request.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: request.id, result });
      }
      return f.fetchImpl(url, init);
    };
    const provider = await loadConnection(profile, { BIGQUERY_GOOGLE_CREDENTIALS_FILE: f.path }, undefined, { bigQueryFetch: fetchImpl });
    t.after(() => provider.close());
    await assert.rejects(provider.call('list_dataset_ids', { projectId: 'fixture-project' }, AbortSignal.timeout(1000)), e => e.details?.code === 'UPSTREAM_ERROR'
      && e.details.outcome === 'unknown' && !e.message.includes('private-vendor-error'));
  }
});

test('BigQuery search mode discovers the schema and calls the same permitted metadata tool', async t => {
  const f = await fixture(t), { client } = await gateway(t, f, profile, { BIGQUERY_GOOGLE_CREDENTIALS_FILE: f.path }, true);
  assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['hstack_search_tools','hstack_call_tool']);
  const found = await client.callTool({ name: 'hstack_search_tools', arguments: { query: 'datasets', service: 'bigquery' } });
  assert.ok(JSON.parse(found.content[0].text).tools.some(x => x.name === 'bigquery__list_dataset_ids'));
  const result = await client.callTool({ name: 'hstack_call_tool', arguments: { name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project' } } });
  assert.deepEqual(result.structuredContent, { datasets: [{ id: 'synthetic-hidden-dataset' }] }); assert.equal(f.seen.reads, 1);
});

test('BigQuery config cannot redirect native credentials, mix auth modes or silently change the protocol', () => {
  for (const change of [{ url: 'https://example.invalid/mcp' }, { url: undefined, urlEnv: 'PRIVATE_ENDPOINT' },
    { headers: {} }, { oauth: { type: 'oauth' } }, { protocol: '2026-07-28' }, { transport: 'stdio' },
    { googleBigQuery: { credentialsFileEnv: 'bad-ref' } }, { googleBigQuery: { credentialsFileEnv: 'FILE', tokenUrl: 'https://example.invalid' } },
  ]) assert.throws(() => parseConnections({ connections: [{ ...profile, ...change }] }));
  assert.deepEqual(parseConnections({ connections: [profile] }), [profile]);
});

test('BigQuery decimal formats retain exact 64-bit bounds and protobuf duration validation', () => {
  const validator = createBigQuerySchemaValidator();
  for (const [format, type, valid, invalid] of [
    ['uint64','string',['0','18446744073709551615'],['-1','18446744073709551616','1.1','NaN']],
    ['int64','string',['-9223372036854775808','9223372036854775807'],['-9223372036854775809','9223372036854775808','1e3']],
    ['int64','integer',[0,Number.MAX_SAFE_INTEGER],[Number.MAX_SAFE_INTEGER+1,0.5]],
    ['google-duration','string',['0s','-1.123456789s','315576000000s'],['315576000001s','1.1234567890s','1 second']],
  ]) {
    const check = validator.getValidator({ type, format });
    for (const value of valid) assert.equal(check(value).valid, true, `${format}: ${value}`);
    for (const value of invalid) assert.equal(check(value).valid, false, `${format}: ${value}`);
  }
});

test('BigQuery schema validation leaves property names and example data intact and rejects unreviewed format changes', () => {
  const validator = createBigQuerySchemaValidator();
  const schema = { type: 'object', properties: { format: { type: 'string' },
    value: { type: 'string', format: 'int64', default: '0', examples: [{ format: 'not-a-schema' }] },
  } }; const before = structuredClone(schema);
  assert.equal(validator.getValidator(schema)({ format: 'any-value', value: '9223372036854775807' }).valid, true);
  assert.deepEqual(schema, before);
  assert.throws(() => validator.getValidator({ type: 'string', format: 'future-format' }), /format changed/);
});

test('BigQuery gateway enforces uint64 bounds before refreshing credentials or dispatching', async t => {
  const changed = structuredClone(read); changed.inputSchema.properties.startIndex = { type: 'string', format: 'uint64' };
  const f = await fixture(t, [changed]), { client } = await gateway(t, f);
  const rejected = await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project', startIndex: '18446744073709551616' } });
  assert.equal(rejected.isError, true); assert.equal(f.seen.tokens, 0); assert.equal(f.seen.reads, 0);
  assert.equal((await client.callTool({ name: 'bigquery__list_dataset_ids', arguments: { projectId: 'fixture-project', startIndex: '18446744073709551615' } })).isError, undefined);
  assert.equal(f.seen.reads, 1);
});

test('BigQuery offline setup reports a missing private credential reference without reading it; preparation stays disabled', async t => {
  const f = await fixture(t); const report = await checkSetup(profile, {});
  assert.deepEqual(report.issues, ['Set BIGQUERY_GOOGLE_CREDENTIALS_FILE in the launch environment.']);
  const configured = await checkSetup(profile, { BIGQUERY_GOOGLE_CREDENTIALS_FILE: '/private/synthetic-file-not-read' });
  assert.deepEqual(configured.issues, []); assert.doesNotMatch(JSON.stringify(configured), /synthetic-file-not-read/);
  const source = join(f.root, 'connections.json'); const original = '{"connections":[]}'; await writeFile(source, original);
  const prepared = await prepareConnections(source, ['bigquery']);
  assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath, 'utf8')).connections, [profile]);
  assert.equal(await readFile(source, 'utf8'), original);
});
