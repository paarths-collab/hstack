import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSetup } from '../dist/setup-check.js';
import { prepareConnections } from '../dist/prepare.js';
import { RemoteConnection } from '../dist/remote-connection.js';

const profile=JSON.parse(await readFile('integrations/snowflake/connection.json','utf8'));

test('Snowflake doctor reports private registration prerequisites and leaves lifecycle/account validation open',async()=>{
  const missing=await checkSetup(profile,{});
  for(const name of ['SNOWFLAKE_MCP_URL','SNOWFLAKE_MCP_ISSUER','SNOWFLAKE_MCP_CLIENT_ID','SNOWFLAKE_MCP_CLIENT_SECRET','SNOWFLAKE_MCP_SCOPES']) {
    assert.ok(missing.issues.includes(`Set ${name} in the launch environment.`));
  }
  const env={SNOWFLAKE_MCP_URL:'https://private-tenant.example.invalid/api/v2/databases/private-db/schemas/private-schema/mcp-servers/private-server',
    SNOWFLAKE_MCP_ISSUER:'https://private-tenant.example.invalid',SNOWFLAKE_MCP_CLIENT_ID:'synthetic-private-client',
    SNOWFLAKE_MCP_CLIENT_SECRET:'synthetic-private-secret',SNOWFLAKE_MCP_SCOPES:'refresh_token session:role:PRIVATE_ROLE'};
  const report=await checkSetup(profile,env);
  assert.deepEqual(report.issues,[]);
  assert.match(report.notes.join(' '),/unverified native HTTP candidate.*lifecycle\/version negotiation.*default warehouse/);
  assert.match(report.notes.join(' '),/every operation will be blocked/);
  assert.doesNotMatch(JSON.stringify(report),/private-tenant|private-db|private-schema|private-server|synthetic-private|PRIVATE_ROLE/);
});

test('Snowflake preparation replaces the unused command but preserves source and customized account settings',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-snowflake-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'connections.json');
  const old={id:'snowflake',label:'Snowflake',enabled:false,transport:'stdio',command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false};
  const original=JSON.stringify({connections:[old]});await writeFile(path,original,{mode:0o600});
  const prepared=await prepareConnections(path,['snowflake']);
  assert.equal(prepared.plan.selections[0].action,'replace-unused-placeholder');
  assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections,[profile]);
  assert.equal(await readFile(path,'utf8'),original);
  const custom={...profile,enabled:true,readTools:['account_selected_search']};await writeFile(path,JSON.stringify({connections:[custom]}));
  const retained=await prepareConnections(path,['snowflake']);
  assert.equal(retained.plan.selections[0].action,'preserve-configured');
  assert.deepEqual(JSON.parse(await readFile(retained.candidatePath,'utf8')).connections,[custom]);
});

test('a lifecycle-free upstream is rejected before discovery or calls; no synthetic initialization is invented',async t=>{
  const methods=[];
  const remote=new RemoteConnection({endpoint:new URL('https://fixture.invalid/mcp'),label:'Snowflake fixture',headers:{},protocol:profile.protocol,
    fetch:async(_url,init)=>{const request=JSON.parse(init.body);methods.push(request.method);
      return Response.json({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'private upstream diagnostic'}});},
  });t.after(()=>remote.close());
  await assert.rejects(remote.discover(AbortSignal.timeout(2000)),error=>!error.message.includes('private upstream diagnostic'));
  assert.deepEqual(methods,['initialize']);
  assert.notEqual(remote.status().state,'ready');
});

test('native Streamable HTTP consumes split SSE tool responses and preserves the result without a replacement parser',async t=>{
  const tool={name:'account_selected_search',inputSchema:{type:'object'},annotations:{readOnlyHint:true}};
  const result={content:[{type:'text',text:'synthetic snowflake search — result'}],_meta:{fixture:true}};
  let calls=0;
  const remote=new RemoteConnection({endpoint:new URL('https://fixture.invalid/mcp'),label:'Snowflake SSE fixture',headers:{},protocol:'legacy',
    fetch:async(_url,init)=>{
      const request=JSON.parse(init.body);
      if(request.method==='initialize')return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'0'}}});
      if(request.method==='notifications/initialized')return new Response(null,{status:204});
      if(request.method==='tools/list')return Response.json({jsonrpc:'2.0',id:request.id,result:{tools:[tool]}});
      assert.equal(request.method,'tools/call');calls++;
      assert.match(new Headers(init.headers).get('accept'),/application\/json/);
      assert.match(new Headers(init.headers).get('accept'),/text\/event-stream/);
      const bytes=new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:request.id,result})}\n\ndata: [DONE]\n\n`);
      // Deliberately split UTF-8 bytes and SSE fields across chunks.
      return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),
        {headers:{'content-type':'text/event-stream'}});
    },
  });t.after(()=>remote.close());
  assert.deepEqual(await remote.discover(),[tool]);
  assert.deepEqual(await remote.call(tool.name,{},AbortSignal.timeout(2000)),result);
  assert.equal(calls,1);
});
