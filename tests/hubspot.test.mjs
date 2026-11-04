import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHubspotMetadata } from '../scripts/verify-hubspot-metadata.mjs';
import { checkSetup } from '../dist/setup-check.js';
import { resolveConnection } from '../dist/connections.js';
import { prepareConnections } from '../dist/prepare.js';

const profile=JSON.parse(await readFile('integrations/hubspot/connection.json','utf8'));
const resourceUrl='https://mcp.hubspot.com/.well-known/oauth-protected-resource';
const issuerUrl='https://mcp.hubspot.com/.well-known/oauth-authorization-server';
function fixture(change=()=>{}){
  const docs={
    [resourceUrl]:{resource:profile.url,authorization_servers:[profile.oauth.issuer],scopes_supported:[]},
    [issuerUrl]:{issuer:profile.oauth.issuer,authorization_endpoint:'https://mcp.hubspot.com/oauth/authorize/user',
      token_endpoint:'https://mcp.hubspot.com/oauth/v3/token',scopes_supported:[],response_types_supported:['code'],
      grant_types_supported:['authorization_code','refresh_token','client_credentials'],token_endpoint_auth_methods_supported:['client_secret_post'],
      code_challenge_methods_supported:['S256']},
  };change(docs);const seen=[];
  return{seen,fetch:async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal instanceof AbortSignal);
    seen.push(url);return Response.json(docs[url]??{}, {status:docs[url]?200:404});
  }};
}

test('HubSpot metadata checker uses only two public SDK GETs with native issuer validation and no account or registration requests',async()=>{
  const f=fixture(),report=await verifyHubspotMetadata(f.fetch);
  assert.deepEqual(f.seen,[resourceUrl,issuerUrl]);
  assert.equal(report.checks.registeredSecretPostAndPkceAdvertised,true);
  assert.equal(report.checks.installationSelectedPermissions,true);
  assert.equal(report.checks.noRegistrationOrAccountOperations,true);
});

test('HubSpot checker rejects issuer, PKCE, registration, token auth or scope-contract drift and never follows metadata redirects',async()=>{
  for(const change of [docs=>{docs[issuerUrl].issuer='https://unexpected.invalid';},
    docs=>{docs[resourceUrl].authorization_servers=['https://unexpected.invalid'];},
    docs=>{docs[issuerUrl].code_challenge_methods_supported=['plain'];},
    docs=>{docs[issuerUrl].registration_endpoint='https://mcp.hubspot.com/register';},
    docs=>{docs[issuerUrl].token_endpoint_auth_methods_supported=['none'];},
    docs=>{docs[issuerUrl].scopes_supported=['crm:write'];}]){
    await assert.rejects(verifyHubspotMetadata(fixture(change).fetch));
  }
  const seen=[];
  await assert.rejects(verifyHubspotMetadata(async(url,init)=>{
    seen.push(url);assert.equal(init.redirect,'error');return new Response(null,{status:302,headers:{location:'https://unexpected.invalid'}});
  }));
  assert.deepEqual(seen,[resourceUrl,issuerUrl],'The SDK may try its fixed issuer fallback, but must never request the redirect target');
});

test('HubSpot offline setup requires its dedicated registered credentials, preserves private values and defaults to documented reads only',async()=>{
  assert.deepEqual((await checkSetup(profile,{})).issues,['Set HUBSPOT_MCP_CLIENT_SECRET in the launch environment.','Set HUBSPOT_MCP_CLIENT_ID in the launch environment.']);
  assert.throws(()=>resolveConnection(profile,{}),/HUBSPOT_MCP_CLIENT_ID/);
  const env={HUBSPOT_MCP_CLIENT_ID:'synthetic-private-client',HUBSPOT_MCP_CLIENT_SECRET:'synthetic-private-secret'};
  const report=await checkSetup(profile,env);assert.deepEqual(report.issues,[]);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-private/);
  assert.equal(profile.oauth.scope,undefined);assert.equal(profile.enabled,false);assert.equal(profile.allowWrites,false);
  assert.equal(profile.readTools.length,17);assert.equal(profile.readTools.includes('get_user_details'),true);
  for(const name of ['manage_crm_objects','manage_marketing_email','manage_custom_pipelines','manage_landing_page','query_crm_data','render_asset','submit_feedback']) {
    assert.equal(profile.readTools.includes(name),false,`${name} requires separate review`);
  }
});

test('HubSpot private candidate replaces only the untouched disabled bridge and never migrates active/customized settings',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-hubspot-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'connections.json');
  const old={id:'hubspot',label:'HubSpot',enabled:false,transport:'stdio',command:'mcp-remote',args:['https://mcp.hubspot.com'],env:{},readTools:[],allowWrites:false};
  for(const change of [{},{enabled:true},{args:['https://mcp.hubspot.com/']},{args:[...old.args,'--custom']},
    {readTools:['custom_read']},{env:{CUSTOM:'PRIVATE_REF'}},{userNote:'synthetic-private-note'}]){
    const current={...old,...change},original=JSON.stringify({connections:[current]});await writeFile(path,original,{mode:0o600});
    const prepared=await prepareConnections(path,['hubspot']),preserved=Object.keys(change).length>0;
    assert.equal(prepared.plan.selections[0].action,preserved?'preserve-configured':'replace-unused-placeholder');
    assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections,[preserved?current:profile]);
    assert.equal(await readFile(path,'utf8'),original);assert.doesNotMatch(JSON.stringify(prepared.plan),/synthetic-private-note|PRIVATE_REF|custom_read/);
  }
});
