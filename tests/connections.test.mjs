import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/client";
import { Server, InMemoryTransport } from "@modelcontextprotocol/server";
import { loadConnection, parseConnections, loadConfiguredConnections, resolveConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { oauthStore } from '../dist/oauth.js';
import { quickbooksJsonReads } from '../dist/vendor-contracts.js';

const catalogue = JSON.parse(await readFile('catalog/services.json','utf8'));
const example = JSON.parse(await readFile('connections.example.json','utf8'));
const pipedriveReads=JSON.parse(await readFile('integrations/pipedrive/connection.json','utf8')).readTools;
const typeformReads=JSON.parse(await readFile('integrations/typeform/connection.json','utf8')).readTools;
const hubspotReads=JSON.parse(await readFile('integrations/hubspot/connection.json','utf8')).readTools;
const batchReads=Object.fromEntries(await Promise.all(['kit','evernote','calcom','pandadoc'].map(async id=>[id,JSON.parse(await readFile(`integrations/${id}/connection.json`,'utf8')).readTools])));
const deelReads=JSON.parse(await readFile('integrations/deel/connection.json','utf8')).readTools;

test('all 30 catalogue entries have distinct disabled connection profiles and evidence boundaries', () => {
  const configs = parseConnections(example);
  assert.equal(catalogue.length,30);
  assert.equal(configs.length,30);
  assert.equal(new Set(catalogue.map(x=>x.id)).size,30);
  assert.deepEqual(configs.map(x=>x.id),catalogue.map(x=>x.id));
  for(const entry of catalogue) {
    assert.match(entry.docs,/^https:\/\//);
    assert.match(entry.evidence,/not tested/);
  }
  for(const config of configs) {
    assert.equal(config.enabled,false);
    assert.equal(config.allowWrites,false);
    assert.notEqual(config.command,'mcp-remote','Bundled native HTTP profiles must not reintroduce an unpinned external bridge');
    assert.deepEqual(config.readTools,config.id==='redis' ? ['get','type','scan_keys','dbsize','info']
      : config.id==='mailchimp' ? ['list_accounts','describe_tools','list_audiences','list_campaigns']
      : config.id==='bamboohr' ? ['list_fields','list_list_fields','list_tabular_fields']
      : config.id==='mongodb' ? ['list-databases','list-collections','count','find']
      : config.id==='xero' ? ['get_connected_tenants','list_contacts','list_invoices']
      : config.id==='google-analytics' ? ['get_account_summaries','get_property_details','list_google_ads_links','list_property_annotations',
        'get_custom_dimensions_and_metrics','run_report','run_realtime_report','run_funnel_report','run_conversions_report']
      : config.id==='mysql' ? ['list_tables','get_query_plan','list_active_queries','list_tables_missing_unique_indexes',
        'list_table_fragmentation','list_all_locks','show_query_stats','list_table_stats']
      : config.id==='zendesk' ? ['zendesk_search_tickets','zendesk_get_tickets','zendesk_get_ticket','zendesk_get_comments',
        'zendesk_list_views','zendesk_get_view','zendesk_get_view_tickets','zendesk_list_macros','zendesk_search_users',
        'zendesk_get_groups','zendesk_get_group_users','zendesk_get_organization','zendesk_list_custom_statuses','zendesk_get_time_tracking']
      : config.id==='quickbooks' ? [...quickbooksJsonReads]
      : config.id==='pipedrive' ? pipedriveReads
      : config.id==='typeform' ? typeformReads
      : config.id==='hubspot' ? hubspotReads
      : batchReads[config.id] ? batchReads[config.id]
      : config.id==='deel' ? deelReads
      : config.id==='pagerduty' ? ['list_incidents']
      : config.id==='bigquery' ? ['list_dataset_ids','get_dataset_info','list_table_ids','get_table_info','get_job']
      : config.id==='docusign' ? ['getUserInfo','searchDocusignDocs'] : []);
  }
});

test('bundled integration profiles and setup guides match the shipped disabled examples',async()=>{
  for(const id of ['redis','mailchimp','bamboohr','greenhouse','mongodb','xero','google-analytics','mysql','zendesk','quickbooks','pipedrive','zoho-crm','zoho-desk','zoho-books','docusign','bigquery','snowflake','typeform','hubspot','kit','evernote','calcom','pandadoc','brevo','pagerduty','deel']) {
    const profile=JSON.parse(await readFile(`integrations/${id}/connection.json`,'utf8'));
    assert.deepEqual(example.connections.find((item)=>item.id===id),profile,`${id}: profile drift`);
  }
  for(const entry of catalogue) {
    if(entry.setupGuide) {
      assert.match(entry.setupGuide,/^integrations\/[a-z0-9-]+\/README\.md$/);
      assert.ok((await readFile(entry.setupGuide,'utf8')).length>0);
    }
    if(entry.setupRequirements) assert.ok(Array.isArray(entry.setupRequirements)&&entry.setupRequirements.every((value)=>typeof value==='string'));
  }
});

test('disabled profiles never spawn commands or contact vendors',async(t)=>{
  const folder=await mkdtemp(join(tmpdir(),'hstack-connections-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'connections.json');
  await writeFile(path,JSON.stringify(example));
  assert.deepEqual(await loadConfiguredConnections(path,{},async()=>{throw new Error('Must not execute');}),{providers:[],failed:[]});
});

test('reject malformed configuration, duplicate IDs, literal secrets and insecure remote URLs',()=>{
  const base={id:'fixture',label:'Fixture',enabled:true,transport:'http',url:'https://example.invalid/mcp',readTools:[],allowWrites:false};
  for(const entry of [
    {...base,url:'http://example.invalid/mcp'},
    {...base,url:'https://user:password@example.invalid/mcp'},
    {...base,headers:{Authorization:'literal-secret'}},
    {...base,id:'../escape'},
    {...base,enabled:'true'},
  ]) assert.throws(()=>parseConnections({connections:[entry]}));
  assert.throws(()=>parseConnections({connections:[base,base]}));
});

test('missing referenced credentials fail before network access',async()=>{
  await assert.rejects(loadConnection({id:'fixture',label:'Fixture',enabled:true,transport:'http',url:'https://example.invalid',headers:{Authorization:{env:'MISSING_FIXTURE',prefix:'Bearer '}},readTools:[],allowWrites:false},{}),/Set MISSING_FIXTURE/);
});

test('endpoint and executable references resolve privately without mutating configuration', async () => {
  const base = { id:'fixture', label:'Fixture', enabled:false, readTools:[], allowWrites:false };
  const config = { ...base, transport:'http', urlEnv:'FIXTURE_ENDPOINT', oauth:{ type:'oauth' } };
  const resolved = resolveConnection(config, { FIXTURE_ENDPOINT:'https://example.invalid/mcp?private=synthetic' });
  assert.equal(resolved.url, 'https://example.invalid/mcp?private=synthetic');
  assert.equal(resolved.urlEnv, undefined);
  assert.equal(config.urlEnv, 'FIXTURE_ENDPOINT');
  assert.equal(config.url, undefined);
  const local = { ...base, transport:'stdio', commandEnv:'FIXTURE_COMMAND', args:[] };
  assert.equal(resolveConnection(local, { FIXTURE_COMMAND:process.execPath }).command, process.execPath);
  assert.throws(() => resolveConnection(config, {}), /Set FIXTURE_ENDPOINT/);
  for (const value of ['not a URL containing synthetic-secret', 'http://remote.invalid/mcp', 'https://user:synthetic-secret@example.invalid']) {
    assert.throws(() => resolveConnection(config, { FIXTURE_ENDPOINT:value }), (error) => !error.message.includes(value) && !error.message.includes('synthetic-secret'));
  }
  for (const invalid of [
    { ...config, url:'https://example.invalid' }, { ...config, urlEnv:'invalid-name' },
    { ...config, commandEnv:'OTHER' }, { ...local, command:'node' },
    { ...local, commandEnv:'' }, { ...local, urlEnv:'OTHER' },
  ]) assert.throws(() => parseConnections({ connections:[invalid] }));
  assert.throws(() => resolveConnection({ ...config, oauth:{ type:'oauth', issuer:'http://127.0.0.1:8679' } },
    { FIXTURE_ENDPOINT:'https://example.invalid/mcp' }), /Invalid OAuth/);
});

test('referenced executable runs through the normal stdio gateway path', async () => {
  const provider = await loadConnection({ id:'fixture', label:'Fixture', enabled:false, transport:'stdio',
    commandEnv:'FIXTURE_COMMAND', args:[resolve('tests/fixtures/echo-server.mjs')], readTools:['get_record'], allowWrites:false },
    { FIXTURE_COMMAND:process.execPath });
  try {
    assert.equal(provider.tools[0].name, 'get_record');
    assert.equal((await provider.call('get_record', {}, AbortSignal.timeout(2000))).content[0].text, 'synthetic record');
  } finally { await provider.close(); }
});

test('OAuth registration references are exclusive, required before connecting, private and identity-bound after resolution', async () => {
  const config={ id:'fixture',label:'Fixture',enabled:false,transport:'http',url:'https://example.invalid/mcp',
    oauth:{ type:'oauth',clientIdEnv:'FIXTURE_CLIENT_ID',issuerEnv:'FIXTURE_ISSUER',scopeEnv:'FIXTURE_SCOPE',clientSecretEnv:'FIXTURE_SECRET' },readTools:[],allowWrites:false };
  const env={ FIXTURE_CLIENT_ID:'synthetic-client',FIXTURE_ISSUER:'https://auth.example.invalid',FIXTURE_SCOPE:'records:read offline_access',FIXTURE_SECRET:'synthetic-secret' };
  const original=JSON.stringify(config);
  const resolved=resolveConnection(config,env);
  assert.deepEqual(resolved.oauth,{ type:'oauth',clientId:'synthetic-client',issuer:'https://auth.example.invalid',scope:'records:read offline_access',clientSecretEnv:'FIXTURE_SECRET' });
  assert.equal(JSON.stringify(config),original);
  const storeEnv={ HSTACK_STATE_DIR:join(tmpdir(),'hstack-synthetic-identity') };
  const path=oauthStore(resolved,storeEnv).path;
  for(const name of ['FIXTURE_CLIENT_ID','FIXTURE_ISSUER','FIXTURE_SCOPE']) {
    const changed={ ...env,[name]:name==='FIXTURE_ISSUER' ? 'https://different.example.invalid' : 'synthetic-different' };
    assert.notEqual(oauthStore(resolveConnection(config,changed),storeEnv).path,path);
  }
  for(const field of ['clientId','issuer','scope']) {
    assert.throws(()=>parseConnections({ connections:[{ ...config,oauth:{ ...config.oauth,[field]:'literal' } }] }),/either a value/);
  }
  assert.throws(()=>parseConnections({ connections:[{ ...config,oauth:{ type:'oauth',clientIdEnv:'CLIENT_ONLY' } }] }),/issuer/);
  assert.throws(()=>parseConnections({ connections:[{ ...config,oauth:{ ...config.oauth,scopeEnv:'not-valid' } }] }),/environment reference/);
  await assert.rejects(loadConnection(config,{}),(error)=>/FIXTURE_CLIENT_ID|FIXTURE_ISSUER/.test(error.message));
  assert.throws(()=>resolveConnection(config,{ ...env,FIXTURE_ISSUER:'not a URL containing synthetic-secret' }),
    (error)=>/Invalid OAuth/.test(error.message)&&!error.message.includes('synthetic-secret'));
  const metadata=resolveConnection({ ...config,oauth:{ type:'oauth',clientMetadataUrlEnv:'FIXTURE_METADATA' } },{ FIXTURE_METADATA:'https://example.invalid/client.json' });
  assert.equal(metadata.oauth.clientMetadataUrl,'https://example.invalid/client.json');
});

test('one configured connection failure does not remove successful connections',async(t)=>{
  const folder=await mkdtemp(join(tmpdir(),'hstack-connections-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'connections.json');
  await writeFile(path,JSON.stringify({connections:example.connections.slice(0,2).map(x=>({...x,enabled:true}))}));
  const result=await loadConfiguredConnections(path,{},async(config)=>{
    if(config.id==='brand24')throw new Error('synthetic');
    return {id:config.id};
  });
  assert.deepEqual(result.providers,[{id:'brevo'}]);
  assert.deepEqual(result.failed,['brand24']);
});

for(const profile of example.connections) {
  test(`${profile.id}: configured transport routes through gateway (synthetic upstream, not vendor proof)`,async(t)=>{
    let config={...profile,enabled:true,readTools:['get_record']};
    let fixtureUrl;
    if(config.transport==='stdio') {
      config={...config,resultPolicy:undefined,commandEnv:undefined,command:process.execPath,args:[resolve('tests/fixtures/echo-server.mjs')],env:{}};
    } else {
      const http=createServer(async(req,res)=>{
        assert.equal(req.headers.authorization,'Bearer fixture-only');
        if(req.method!=='POST'){res.writeHead(405).end();return;}
        const server=new Server({name:'fixture',version:'0'},{capabilities:{tools:{}}});
        server.setRequestHandler('tools/list',()=>({tools:[{name:'get_record',inputSchema:{type:'object',properties:{}}}]}));
        server.setRequestHandler('tools/call',()=>({content:[{type:'text',text:'synthetic record'}],_meta:{fixture:true}}));
        const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        res.on('close',()=>{void server.close();});
        await server.connect(transport); await transport.handleRequest(req,res);
      });
      await new Promise(r=>http.listen(0,'127.0.0.1',r));
      t.after(async()=>{http.closeAllConnections();await new Promise(r=>http.close(r));});
      // This per-profile test substitutes transport/auth; native OAuth and
      // Google stateless authentication have separate dedicated fixtures.
      config={...config,oauth:undefined,googleBigQuery:undefined,protocol:undefined,urlEnv:'FIXTURE_URL',url:undefined,headers:{Authorization:{env:'FIXTURE_KEY',prefix:'Bearer '}}};
      fixtureUrl = `http://127.0.0.1:${http.address().port}/mcp`;
    }
    const provider=await loadConnection(config,{FIXTURE_KEY:'fixture-only',FIXTURE_URL:fixtureUrl});
    const gateway=createSocialGateway([provider]);
    const client=new Client({name:'fixture',version:'0'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try {
      await gateway.connect(b);await client.connect(a);
      assert.equal((await client.listTools()).tools[0].name,`${profile.id}__get_record`);
      const result=await client.callTool({name:`${profile.id}__get_record`,arguments:{}});
      assert.equal(result.content[0].text,'synthetic record');
      assert.deepEqual(result._meta,{fixture:true});
    } finally {await client.close();await gateway.close();await provider.close?.();}
  });
}
