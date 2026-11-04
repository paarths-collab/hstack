import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../dist/discover-tools.js';

// Actual installed vendor process with network denied and a nonexistent synthetic
// ADC file. This is not a Google account/API, credentials or report-success test.
const execute=promisify(execFile);
const python=process.env.HSTACK_ANALYTICS_PYTHON;
const root=await mkdtemp(join(tmpdir(),'hstack-analytics-runtime-'));
const clients=[];
let step='runtime inspection';
const report={vendor:'googleanalytics/google-analytics-mcp',vendorVersion:'0.8.0',sourceCommit:'ce84226bf4cedea7f2910f5afb07a6b9138f6553',
  environment:'real vendor process; nonexistent synthetic ADC; network denied; no Google account or model',checks:{}};
const text=result=>result.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n')??'';
async function connect(transport){
  const client=new Client({name:'hstack-analytics-runtime-verifier',version:'0'});clients.push({client,transport});
  await client.connect(transport,{timeout:30_000});return client;
}
try{
  assert.ok(python&&isAbsolute(python),'Set HSTACK_ANALYTICS_PYTHON to the pinned Python 3.12 environment.');
  const inspected=await execute(python,['-I','-c',`import sys,json,hashlib,pathlib,importlib.metadata as m,importlib.util as u
assert sys.version_info[:2]==(3,12)
blobs={}
for name in ['analytics_mcp.server','analytics_mcp.coordinator','analytics_mcp.tools.client','analytics_mcp.tools.admin.info','analytics_mcp.tools.reporting.core']:
 data=pathlib.Path(u.find_spec(name).origin).read_bytes();blobs[name]=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
assert 'Build: 1hstack' in m.distribution('google-adk').read_text('WHEEL')
for req in ['opentelemetry-api==1.45.1','opentelemetry-sdk==1.45.1']: assert req in m.requires('google-adk')
print(json.dumps({'vendor':m.version('analytics-mcp'),'mcp':m.version('mcp'),'adk':m.version('google-adk'),'otel':m.version('opentelemetry-api'),'otelSdk':m.version('opentelemetry-sdk'),'blobs':blobs}))`],{env:{},cwd:root,timeout:10_000});
  const versions=JSON.parse(inspected.stdout);
  assert.equal(versions.vendor,'0.8.0');assert.equal(versions.mcp,'2.3.0');assert.equal(versions.adk,'2.13.0');
  assert.equal(versions.otel,'1.45.1');assert.equal(versions.otelSdk,'1.45.1');
  assert.deepEqual(versions.blobs,{
    'analytics_mcp.server':'5c587f3e91c8d946b4a182bdb795fa092be1b2f2',
    'analytics_mcp.coordinator':'a1e7936af5ea66d434c285ae19740bb56a4415e2',
    'analytics_mcp.tools.client':'6b5cb510c4cb736def3d502da3f7135bed68403e',
    'analytics_mcp.tools.admin.info':'1753723f0b16a7f37b506f411a78d9ddf9b925ae',
    'analytics_mcp.tools.reporting.core':'e016d7e121df7440cca170dd2d7b9d1dc319cf89',
  });
  report.pythonMcpVersion=versions.mcp;report.adkVersion=versions.adk;report.sourceBlobs=versions.blobs;
  report.adkBuild='1hstack: metadata-only OpenTelemetry dependency bounds';report.opentelemetryVersion=versions.otel;
  report.adkWheelSha256=createHash('sha256').update(await readFile(new URL('../.hstack-tools/analytics-wheels/google_adk-2.13.0-1hstack-py3-none-any.whl',import.meta.url))).digest('hex');
  report.lockSha256=createHash('sha256').update(await readFile(new URL('../integrations/google-analytics/requirements.lock',import.meta.url))).digest('hex');
  const marker=join(root,'network-denied');
  const bootstrap=(write=false)=>`import sys,runpy
def deny_network(event,args):
 if event in ('socket.connect','socket.getaddrinfo'):
  with open(${JSON.stringify(marker)},'w') as marker: marker.write('blocked')
  raise OSError('Network denied by Hstack runtime-only verification')
sys.addaudithook(deny_network)
sys.argv=['analytics_mcp.server']+${write?"['--allow-write']":"[]"}
runpy.run_module('analytics_mcp.server',run_name='__main__')`;
  const args=write=>['-I','-c',bootstrap(write)];
  const env={HSTACK_ANALYTICS_PYTHON:python,GOOGLE_APPLICATION_CREDENTIALS:join(root,'nonexistent-synthetic-adc.json'),
    GOOGLE_CLOUD_PROJECT:'synthetic-hstack-project',GOOGLE_CLOUD_QUOTA_PROJECT:'synthetic-hstack-project',
    HOME:root,CLOUDSDK_CONFIG:join(root,'gcloud'),PYTHON_DOTENV_DISABLED:'1'};
  step='real vendor schema discovery';
  const direct=await connect(new StdioClientTransport({command:python,args:args(false),env,cwd:root,stderr:'ignore'}));
  const tools=await listAllTools(direct,AbortSignal.timeout(30_000));
  const profile=JSON.parse(await readFile(new URL('../integrations/google-analytics/connection.json',import.meta.url),'utf8'));
  assert.equal(tools.length,9);assert.deepEqual(tools.map(t=>t.name).sort(),[...profile.readTools].sort());
  for(const tool of tools)assert.equal(tool.annotations?.readOnlyHint,true);
  assert.ok(!tools.some(t=>t.name==='create_property_annotation'));assert.ok(!profile.args.includes('--allow-write'));
  report.discoveredReadTools=tools.length;report.schemaSha256=createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  report.checks.pinnedSourceAndReadSchemas=true;
  await assert.rejects(readFile(marker),{code:'ENOENT'});

  const path=join(root,'connections.json');
  // The bootstrap adds a test-only network guard, leaving vendor implementation unchanged.
  await writeFile(path,JSON.stringify({connections:[{...profile,enabled:true,args:args(true)}]}),{mode:0o600});
  step='Hstack schema preservation and write blocking';
  const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
  const gateway=await connect(new StdioClientTransport({command:process.execPath,args:[serverPath],
    env:{...env,HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:'search'},cwd:root,stderr:'ignore'}));
  assert.equal((await listAllTools(gateway,AbortSignal.timeout(30_000))).length,2);
  for(const tool of tools){
    const found=JSON.parse(text(await gateway.callTool({name:'hstack_search_tools',arguments:{service:'google-analytics',query:tool.name,limit:10}})));
    assert.deepEqual(found.tools.find(item=>item.name===`google-analytics__${tool.name}`)?.inputSchema,tool.inputSchema);
  }
  const blocked=await gateway.callTool({name:'hstack_call_tool',arguments:{name:'google-analytics__create_property_annotation',
    arguments:{property_id:'123',title:'Synthetic blocked annotation',start_date:'2026-01-01'}}});
  assert.equal(blocked.isError,true);assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(blocked._meta.hstack.outcome,'not_sent');
  report.checks.nineGatewaySchemasAndWriteBlock=true;
  step='missing ADC rejection';
  const read=await direct.callTool({name:'get_account_summaries',arguments:{}});assert.equal(read.isError,true);
  const forwarded=await gateway.callTool({name:'hstack_call_tool',arguments:{name:'google-analytics__get_account_summaries',arguments:{}}});
  assert.equal(forwarded.isError,true);
  const manage=fileURLToPath(new URL('../dist/manage.js',import.meta.url));
  const failed=await execute(process.execPath,[manage,'verify','google-analytics'],{env:{...env,HSTACK_CONNECTIONS_FILE:path},cwd:root,timeout:40_000})
    .then(()=>assert.fail('Missing ADC must not pass operational verification'),error=>error);
  assert.equal(failed.code,1);assert.match(failed.stderr,/Google Analytics operational read failed/);
  assert.ok(!(failed.stdout+failed.stderr).includes(env.GOOGLE_APPLICATION_CREDENTIALS));
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  report.checks.missingAdcFailurePreservedAndVerificationRejected=true;
  if(process.env.HSTACK_TEST_HERMES_ROOT&&process.env.HSTACK_TEST_HERMES_PYTHON){
    step='native Hermes registry';const home=join(root,'hermes');await mkdir(home);
    await writeFile(join(home,'config.yaml'),JSON.stringify({mcp_servers:{hstack:{command:process.execPath,args:[serverPath],
      env:{...env,HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:'search'},connect_timeout:60,timeout:40}}}),{mode:0o600});
    const probe=join(root,'hermes-probe.json');await writeFile(probe,JSON.stringify({source:process.env.HSTACK_TEST_HERMES_ROOT}),{mode:0o600});
    const native=await execute(process.env.HSTACK_TEST_HERMES_PYTHON,['-I','-B',fileURLToPath(new URL('./verify-hermes-analytics.py',import.meta.url)),probe],
      {env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:home},cwd:root,timeout:60_000});
    assert.match(native.stdout,/PASS: native Hermes registry/);await assert.rejects(readFile(marker),{code:'ENOENT'});
    report.checks.nativeHermesDiscoveryAndWriteBlock=true;
    report.hermesMcpSourceSha256=createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT,'tools/mcp_tool.py'))).digest('hex');
  }
  report.checks.liveAccountValidated=false;
  if(process.env.HSTACK_ANALYTICS_REPORT)await writeFile(process.env.HSTACK_ANALYTICS_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log('PASS: official Analytics MCP 0.8.0 / Python MCP 2.3.0; source pins and nine actual read schemas checked.');
  console.log('PASS: all nine schemas preserved through Hstack; optional upstream annotation write blocked before dispatch.');
  console.log('PASS: missing ADC remains an error; operational verification rejects it without printing the credential path.');
  if(report.checks.nativeHermesDiscoveryAndWriteBlock)console.log('PASS: native Hermes registry discovery and write-block. No model or successful account read claimed.');
  console.log('No real ADC, account, API request, write or model used.');
}catch{
  console.error(`Analytics runtime verification failed during ${step}. Check the pinned runtime and local setup; raw errors and values hidden.`);process.exitCode=1;
}finally{
  for(const{client,transport}of clients.reverse()){try{await client.close();}catch{}try{await transport.close();}catch{}}
  await rm(root,{recursive:true,force:true});
}
