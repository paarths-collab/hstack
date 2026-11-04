import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { Server, InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { checkSetup } from '../dist/setup-check.js';
import { prepareConnections } from '../dist/prepare.js';

const profiles=await Promise.all(['zoho-crm','zoho-desk','zoho-books'].map(async(id)=>JSON.parse(await readFile(`integrations/${id}/connection.json`,'utf8'))));
const secret='synthetic-private-url-key';

async function fixture(t){
  const seen={requests:0,reads:0,writes:0};let denied=false;
  const handler=createMcpHandler(()=>{
    const server=new Server({name:'zoho-shaped-local-fixture',version:'0'},{capabilities:{tools:{}}});
    server.setRequestHandler('tools/list',()=>({tools:['read_fixture','write_fixture'].map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:false}}))}));
    server.setRequestHandler('tools/call',(request)=>{
      request.params.name==='read_fixture'?seen.reads++:seen.writes++;
      return{content:[{type:'text',text:'synthetic record'}]};
    });return server;
  });
  const handle=toNodeHandler(handler);
  const http=createServer((req,res)=>{
    seen.requests++;assert.equal(req.headers.authorization,undefined);
    assert.ok(req.url.includes(secret),'Private URL credential must reach the selected upstream unchanged');
    if(denied){res.writeHead(401).end(secret);return;}
    void handle(req,res);
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await handler.close();});
  const url=`http://127.0.0.1:${http.address().port}/mcp?api_key=${secret}`;
  return{seen,url,deny:()=>{denied=true;}};
}

async function gateway(t,provider){
  const server=createSocialGateway([provider]),client=new Client({name:'fixture',version:'0'});
  const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();await provider.close();});return client;
}

for(const profile of profiles)test(`${profile.id}: private-URL native HTTP discovery, explicit read review and write blocking (fixture only)`,async(t)=>{
  const f=await fixture(t),env={[profile.urlEnv]:f.url};
  const initial=await loadConnection(profile,env);const first=await gateway(t,initial);
  const blocked=await first.callTool({name:`${profile.id}__read_fixture`,arguments:{}});
  assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(f.seen.reads,0);
  const reviewed=await loadConnection({...profile,readTools:['read_fixture']},env);const client=await gateway(t,reviewed);
  assert.equal((await client.callTool({name:`${profile.id}__read_fixture`,arguments:{}})).content[0].text,'synthetic record');
  const write=await client.callTool({name:`${profile.id}__write_fixture`,arguments:{}});
  assert.equal(write._meta.hstack.outcome,'not_sent');assert.equal(f.seen.writes,0);
  const health=await client.readResource({uri:'hstack://connections'});assert.doesNotMatch(JSON.stringify(health),new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(await checkSetup(profile,env)),new RegExp(secret));
  f.deny();await assert.rejects(loadConnection(profile,env),error=>error.details.code==='AUTH_REQUIRED'&&!error.message.includes(secret));
});

test('Zoho offline checks require generated URL refs and reject insecure/malformed endpoints without printing key values',async()=>{
  for(const profile of profiles){
    assert.deepEqual((await checkSetup(profile,{})).issues,[`Set ${profile.urlEnv} in the launch environment.`]);
    const report=await checkSetup(profile,{[profile.urlEnv]:`http://not-loopback.invalid/${secret}`});
    assert.equal(report.issues.length,1);assert.doesNotMatch(JSON.stringify(report),new RegExp(secret));
  }
});

test('Zoho batch preparation replaces all three unused commands while preserving configured entries and source bytes',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-zoho-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'connections.json');
  const original=JSON.stringify({connections:profiles.map(profile=>({id:profile.id,label:profile.label,enabled:false,transport:'stdio',
    command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false}))});
  await writeFile(path,original,{mode:0o600});
  const prepared=await prepareConnections(path,profiles.map(profile=>profile.id));
  assert.ok(prepared.plan.selections.every(selection=>selection.action==='replace-unused-placeholder'));
  assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections,profiles);
  assert.equal(await readFile(path,'utf8'),original);
});
