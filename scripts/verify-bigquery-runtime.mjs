import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const preload = fileURLToPath(new URL('./bigquery-fixture-network.mjs', import.meta.url));
const readTool = { name: 'list_dataset_ids', description: 'List BigQuery datasets', inputSchema: {
  type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'],
}, outputSchema: { type: 'object', properties: { datasets: { type: 'array', items: {
  type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
} } }, required: ['datasets'] }, annotations: { readOnlyHint: true } };
const sqlTool = { name: 'execute_sql_readonly', inputSchema: { type: 'object', properties: {
  projectId: { type: 'string' }, query: { type: 'string' },
}, required: ['projectId','query'] }, annotations: { readOnlyHint: true } };

/** Real Hstack process + synthetic Google responses. Optional installed Hermes
 * registry comparison uses its own empty home, SDK MockTransport and no model. */
export async function verifyBigQueryRuntime(options = {}) {
  if (!!options.hermesRoot !== !!options.hermesPython) throw new Error('Supply both native Hermes source and Python explicitly.');
  const home = await mkdtemp(join(tmpdir(),'hstack-bigquery-runtime-'));
  const events = join(home, 'events'), fixture = join(home, 'fixture.json'), credentials = join(home, 'credentials.json');
  const connections = join(home, 'connections.json'), datasetId = `synthetic-${randomUUID()}`;
  const profile = JSON.parse(await readFile(new URL('../integrations/bigquery/connection.json', import.meta.url), 'utf8'));
  const credentialBytes = JSON.stringify({ type: 'authorized_user', client_id: 'fixture.apps.googleusercontent.com',
    client_secret: 'synthetic-client-value', refresh_token: 'synthetic-refresh-value' });
  const fixtureBytes = JSON.stringify({ events, datasetId, tools: [readTool, sqlTool] });
  const connectionBytes = JSON.stringify({ connections: [{ ...profile, enabled: true }] });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHON_DOTENV_DISABLED: '1',
    HSTACK_CONNECTIONS_FILE: connections, HSTACK_TOOL_MODE: 'search',
    HSTACK_BIGQUERY_FIXTURE_FILE: fixture, BIGQUERY_GOOGLE_CREDENTIALS_FILE: credentials };
  let client, transport, diagnostics = '';
  const report = { vendor: 'Google BigQuery MCP', sdk: '2.4.0', googleAuthLibrary: '11.3.2',
    evidence: 'Real Hstack stdio process with synthetic Google OAuth/API only. No real account, credentials, query or model.',
    testedRuntime: { node: process.version, platform: process.platform, arch: process.arch }, checks: {} };
  try {
    for (const [path, data] of [[events,''],[fixture,fixtureBytes],[credentials,credentialBytes],[connections,connectionBytes]]) await writeFile(path,data,{ mode:0o600 });
    client = new Client({ name: 'bigquery-native-check', version: '0' }, { versionNegotiation: { mode: 'legacy' } });
    transport = new StdioClientTransport({ command: process.execPath, args: ['--import',preload,resolve(root,'dist/server.js')], env, stderr: 'pipe' });
    transport.stderr?.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-8192); });
    await client.connect(transport, { signal: AbortSignal.timeout(10_000) });
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['hstack_search_tools','hstack_call_tool']);
    const found = await client.callTool({ name: 'hstack_search_tools', arguments: { query:'datasets',service:'bigquery' } });
    assert.ok(JSON.parse(found.content[0].text).tools.some(tool=>tool.name==='bigquery__list_dataset_ids'));
    for (let i=0;i<2;i++) {
      const result = await client.callTool({ name:'hstack_call_tool',arguments:{name:'bigquery__list_dataset_ids',arguments:{projectId:'fixture-project'}} });
      assert.deepEqual(result.structuredContent,{datasets:[{id:datasetId}]});
    }
    const blocked = await client.callTool({ name:'hstack_call_tool',arguments:{name:'bigquery__execute_sql_readonly',arguments:{projectId:'fixture-project',query:'synthetic SQL must never execute'}} });
    assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(blocked._meta.hstack.outcome,'not_sent');
    const health = await client.readResource({ uri:'hstack://connections' });
    assert.ok(!JSON.stringify(health).includes(datasetId));assert.ok(!JSON.stringify(health).includes('synthetic-access-value'));
    report.checks.realStdioSearchReadAndSqlBlock = true;
    report.checks.healthDoesNotExposeAccountContent = true;
    await client.close();await transport.close(); client=transport=undefined;
    if (options.hermesRoot) {
      const hermesHome=join(home,'hermes');await mkdir(hermesHome,{mode:0o700});
      const config={mcp_servers:{hstack:{command:process.execPath,args:['--import',preload,resolve(root,'dist/server.js')],
        env,connect_timeout:15,timeout:15,sampling:{enabled:false}}}};
      await writeFile(join(hermesHome,'config.yaml'),JSON.stringify(config),{mode:0o600});
      const probe=join(home,'probe.json');await writeFile(probe,JSON.stringify({source:options.hermesRoot,datasetId,tools:[readTool,sqlTool]}),{mode:0o600});
      const result=await promisify(execFile)(options.hermesPython,['-I','-B',fileURLToPath(new URL('./verify-hermes-bigquery.py',import.meta.url)),probe],{
        cwd:home,env:{PATH:env.PATH,HOME:home,HERMES_HOME:hermesHome,PYTHON_DOTENV_DISABLED:'1'},timeout:60_000,maxBuffer:262144,
      });
      const line=result.stdout.split('\n').find(line=>line.startsWith('HSTACK_BIGQUERY_NATIVE='));
      if(!line)throw new Error('Native registry evidence is missing.');
      report.nativeHermes=JSON.parse(line.slice('HSTACK_BIGQUERY_NATIVE='.length));
      assert.equal(report.nativeHermes.directHermesLegacyRead,true);assert.equal(report.nativeHermes.gatewayHermesSearchReadAndSqlBlock,true);
      report.hermesMcpSourceSha256=createHash('sha256').update(await readFile(join(options.hermesRoot,'tools/mcp_tool.py'))).digest('hex');
    }
    const rows=(await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).event);
    assert.equal(rows.filter(event=>event==='blocked').length,0);assert.equal(rows.filter(event=>event==='sql').length,0);
    assert.equal(rows.filter(event=>event==='read').length,options.hermesRoot?4:2);
    assert.equal(rows.filter(event=>event==='refresh').length,options.hermesRoot?2:1);
    assert.equal(await readFile(credentials,'utf8'),credentialBytes);assert.equal(await readFile(connections,'utf8'),connectionBytes);
    assert.equal(diagnostics.trim(),'');
    report.checks.oneRefreshForTwoReads = true;report.checks.noNetworkOrSql = true;report.checks.privateSourceFilesUnchanged = true;
    report.counts={refreshes:rows.filter(event=>event==='refresh').length,reads:rows.filter(event=>event==='read').length,sql:0,
      initializations:rows.filter(event=>event==='initialize').length,discovery:rows.filter(event=>event==='discovery').length,
      mcpPosts:rows.filter(event=>['initialize','initialized','discovery','read'].includes(event)).length};
    assert.equal(report.counts.initializations,options.hermesRoot?2:1);
    assert.equal(report.counts.discovery,options.hermesRoot?2:1);
    assert.equal(report.counts.mcpPosts,options.hermesRoot?10:5);
    report.checks.oneSdkClientForDiscoveryAndTwoReads=true;
    if(options.hermesRoot){
      report.requestComparison={readsPerPath:2,directHermesMcpPosts:report.nativeHermes.directMethods.length,
        hstackMcpPostsPerProcess:report.counts.mcpPosts/2,
        limitation:'Synthetic request count only; direct path uses a static synthetic header. No equal auth/setup, latency, model or cost comparison.'};
    }
    return report;
  } finally {
    try { await client?.close(); } finally { try { await transport?.close(); } finally { await rm(home,{recursive:true,force:true}); } }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try { console.log(JSON.stringify(await verifyBigQueryRuntime({hermesRoot:process.env.HSTACK_TEST_HERMES_ROOT,hermesPython:process.env.HSTACK_TEST_HERMES_PYTHON}),null,2)); }
  catch { console.error('BigQuery process/registry fixture verification failed; raw output hidden.');process.exitCode=1; }
}
