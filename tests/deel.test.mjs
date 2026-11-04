import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { verifyDeelMetadata,verifyDeelOAuthMetadata,deelEndpoint } from '../scripts/verify-deel-metadata.mjs';
import { loadConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { prepareConnections } from '../dist/prepare.js';
import { oauthStore } from '../dist/oauth.js';

const tools=JSON.parse(await readFile('integrations/deel/public-tool-definitions.json','utf8'));
const profile=JSON.parse(await readFile('integrations/deel/connection.json','utf8'));
const origin='https://api.letsdeel.com';
function metadata(url){
  if(url===`${origin}/.well-known/oauth-protected-resource/mcp`)return{resource:deelEndpoint,authorization_servers:[origin],scopes_supported:profile.oauth.scope.split(' ')};
  if(url===`${origin}/.well-known/oauth-authorization-server`)return{issuer:origin,authorization_endpoint:`${origin}/oauth/authorize`,token_endpoint:`${origin}/oauth/tokens`,
    registration_endpoint:`${origin}/oauth/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:profile.oauth.scope.split(' ')};
}
function wire(){
  const state={methods:[],calls:0,protected:false,changed:false,authRequests:[]};
  const fetch=async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal instanceof AbortSignal);
    if(String(url)!==deelEndpoint){state.authRequests.push({url:String(url),method:init.method??'GET'});assert.equal(init.method??'GET','GET','No registration or token request');
      return Response.json(metadata(String(url))??{}, {status:metadata(String(url))?200:404});}
    assert.equal(init.method,'POST');const request=JSON.parse(init.body);state.methods.push(request.method);
    if(request.method==='initialize')return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'deel-public-fixture',version:'0'}}});
    if(request.method==='notifications/initialized')return new Response(null,{status:204});
    if(request.method==='tools/list')return Response.json({jsonrpc:'2.0',id:request.id,result:{tools:state.changed&&new Headers(init.headers).has('authorization')
      ?[...tools,{name:'syntheticProtectedRead',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]:tools}});
    assert.equal(request.method,'tools/call');state.calls++;
    if(state.protected)return new Response(null,{status:401,headers:{'WWW-Authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`}});
    return Response.json({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'synthetic Deel result'}],_meta:{fixture:true}}});
  };return{state,fetch};
}

test('Deel anonymous SDK catalogue compiles all recorded schemas and preserves them through the real forward/search gateway without vendor calls',async()=>{
  const f=wire(),result=await verifyDeelMetadata(f.fetch);
  assert.deepEqual(result.tools,tools);assert.equal(result.report.toolCount,8);assert.equal(result.report.compiledSchemas,8);
  assert.deepEqual(f.state.methods,['initialize','notifications/initialized','tools/list']);assert.equal(f.state.calls,0);
  assert.equal(result.report.checks.gatewaySchemasPreserved,true);assert.equal(result.report.discoveryComparison.hstackSearchControls,2);
});

test('Deel anonymous catalogue verifier stops on 401 without loading a credential or attempting OAuth',async()=>{
  const methods=[];
  await assert.rejects(verifyDeelMetadata(async(_url,init)=>{
    assert.equal(new Headers(init.headers).has('authorization'),false);methods.push(JSON.parse(init.body).method);
    return new Response(null,{status:401,headers:{'WWW-Authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`}});
  }),error=>error.details.code==='AUTH_REQUIRED');
  assert.deepEqual(methods,['initialize']);
});

test('Deel OAuth metadata probe uses only two public GETs and rejects issuer, DCR, PKCE or read-scope drift',async()=>{
  const seen=[];const report=await verifyDeelOAuthMetadata(async(url,init)=>{seen.push(url);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');return Response.json(metadata(url));});
  assert.equal(seen.length,2);assert.equal(report.checks.requestedReadScopesAdvertised,true);
  for(const change of [doc=>{if(doc.issuer)doc.issuer='https://wrong.invalid';},doc=>{if(doc.issuer)doc.code_challenge_methods_supported=['plain'];},
    doc=>{if(doc.issuer)doc.registration_endpoint='https://wrong.invalid/register';},doc=>{doc.scopes_supported=['people:read'];}]){
    await assert.rejects(verifyDeelOAuthMetadata(async url=>{const doc=metadata(url);change(doc);return Response.json(doc);}));
  }
});

test('Deel native OAuth profile discovers public tools before login, validates public inputs and refuses background registration after a challenge (synthetic)',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-deel-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=wire();t.mock.method(globalThis,'fetch',f.fetch);
  const provider=await loadConnection(profile,{HSTACK_STATE_DIR:root});t.after(()=>provider.close());
  const gateway=createSocialGateway([provider],{toolMode:'search'}),client=new Client({name:'fixture',version:'0'});
  const[a,b]=InMemoryTransport.createLinkedPair();await gateway.connect(b);await client.connect(a);t.after(async()=>{await client.close();await gateway.close();});
  const name='deel__eor_employment_cost_calculate';
  const invalid=await client.callTool({name:'hstack_call_tool',arguments:{name,arguments:{}}});
  assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/Invalid tool arguments/);assert.equal(f.state.calls,0);
  const args={data:{salary:12345,country:'United States',currency:'USD'}};
  assert.equal((await client.callTool({name:'hstack_call_tool',arguments:{name,arguments:args}})).content[0].text,'synthetic Deel result');
  f.state.protected=true;const challenged=await client.callTool({name:'hstack_call_tool',arguments:{name,arguments:args}});
  assert.equal(challenged.isError,true);assert.equal(challenged._meta.hstack.code,'AUTH_REQUIRED');
  assert.ok(f.state.authRequests.every(request=>request.method==='GET'),'No background DCR or token exchange');
});

test('Deel anonymous-to-authenticated catalogue change stops before an account tool and requires restart/review (synthetic)',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-deel-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=wire();t.mock.method(globalThis,'fetch',f.fetch);const env={HSTACK_STATE_DIR:root};
  const provider=await loadConnection(profile,env);t.after(()=>provider.close());const store=oauthStore(profile,env);
  await store.locked(AbortSignal.timeout(2000),()=>store.write({version:1,client:{client_id:'synthetic-client',issuer:origin},
    tokens:{access_token:'synthetic-access-token',token_type:'Bearer',issuer:origin}}));f.state.changed=true;
  await assert.rejects(provider.call('eor_employment_cost_calculate',{data:{salary:12345,country:'United States',currency:'USD'}},AbortSignal.timeout(2000)),
    error=>error.details.outcome==='not_sent'&&error.details.recovery==='restart_hstack');
  assert.equal(f.state.calls,0);assert.equal(provider.lifecycle().state,'catalogue_changed');
});

test('Deel setup preserves an existing PAT entry and source, while a new candidate uses native OAuth and public reads only',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-deel-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'connections.json');
  const pat=JSON.parse(await readFile('integrations/deel/pat-connection.json','utf8'));
  const original=JSON.stringify({connections:[pat]});await writeFile(path,original,{mode:0o600});
  const kept=await prepareConnections(path,['deel']);assert.equal(kept.plan.selections[0].action,'preserve-configured');
  assert.deepEqual(JSON.parse(await readFile(kept.candidatePath,'utf8')).connections,[pat]);assert.equal(await readFile(path,'utf8'),original);
  const added=await prepareConnections(join(root,'absent.json'),['deel']);assert.deepEqual(JSON.parse(await readFile(added.candidatePath,'utf8')).connections,[profile]);
  assert.equal(profile.headers,undefined);assert.ok(profile.oauth.scope.split(' ').every(scope=>scope.endsWith(':read')));
  assert.deepEqual(profile.readTools,tools.map(tool=>tool.name));assert.equal(profile.readTools.includes('listOfContracts'),false,'Protected names must not be guessed from prose docs');
});
