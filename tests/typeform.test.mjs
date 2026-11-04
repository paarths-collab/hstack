import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyTypeformMetadata, typeformRegions } from '../scripts/verify-typeform-metadata.mjs';
import { checkSetup } from '../dist/setup-check.js';
import { resolveConnection } from '../dist/connections.js';
import { oauthStore } from '../dist/oauth.js';
import { prepareConnections } from '../dist/prepare.js';

const profile=JSON.parse(await readFile('integrations/typeform/connection.json','utf8'));
function fixture(change=()=>{}){
  const docs={};
  for(const region of typeformRegions){
    docs[`${new URL(region.endpoint).origin}/.well-known/oauth-protected-resource`]={resource:region.endpoint,
      authorization_servers:[region.issuer],scopes_supported:['accounts:read','forms:read','forms:write']};
    docs[`${region.issuer}/.well-known/oauth-authorization-server`]={issuer:region.issuer,
      authorization_endpoint:`${region.issuer.replace('://api.','://admin.')}/oauth/authorize`,token_endpoint:`${region.issuer}/oauth/token`,
      registration_endpoint:`${region.issuer}/oauth/register`,client_id_metadata_document_supported:true,
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
      code_challenge_methods_supported:['S256'],scopes_supported:['accounts:read','forms:read','forms:write','offline_access']};
  }
  change(docs);const seen=[];
  return{seen,fetch:async(url,init)=>{
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    seen.push(url);return Response.json(docs[url]??{}, {status:docs[url]?200:404});
  }};
}

test('Typeform metadata checker uses only nine public SDK GETs across the three distinct regional routes',async()=>{
  const f=fixture(),report=await verifyTypeformMetadata(f.fetch);
  assert.equal(report.sdkCompatible,true);assert.equal(f.seen.length,9);
  assert.ok(report.regions.every(r=>r.sdkCompatible&&r.registrationAttempted===false));
  assert.equal(report.regions[1].issuer,'https://api.typeform.com');
  assert.equal(report.regions[2].issuer,'https://api.typeform.eu');
  assert.ok(f.seen.every(url=>url.includes('/.well-known/')),'No authorize/register/token/tool requests');
});

test('Typeform metadata checker retains issuer validation and rejects missing CIMD, PKCE or refresh support',async()=>{
  for(const change of [docs=>{docs['https://api.typeform.eu/.well-known/oauth-authorization-server'].issuer='https://api.typeform.com';},
    docs=>{docs['https://api.typeform.com/.well-known/oauth-authorization-server'].client_id_metadata_document_supported=false;},
    docs=>{docs['https://api.typeform.com/.well-known/oauth-authorization-server'].code_challenge_methods_supported=['plain'];},
    docs=>{docs['https://api.typeform.com/.well-known/oauth-authorization-server'].scopes_supported=['accounts:read'];}]){
    const report=await verifyTypeformMetadata(fixture(change).fetch);
    assert.equal(report.sdkCompatible,false);assert.ok(report.regions.some(r=>r.failure?.code==='PUBLIC_METADATA_CHECK_FAILED'));
  }
});

test('Typeform offline setup requires CIMD, enforces endpoint/issuer pairs and isolates regional credentials without values in diagnostics',async()=>{
  const missing=await checkSetup(profile,{});
  assert.deepEqual(missing.issues,['Set TYPEFORM_MCP_URL in the launch environment.','Set TYPEFORM_MCP_ISSUER in the launch environment.',
    'Set TYPEFORM_MCP_CLIENT_METADATA_URL in the launch environment.']);
  const states=[];
  for(const region of typeformRegions){
    const env={TYPEFORM_MCP_URL:region.endpoint,TYPEFORM_MCP_ISSUER:region.issuer,
      TYPEFORM_MCP_CLIENT_METADATA_URL:'https://synthetic-private-host.invalid/oauth/client.json'};
    const report=await checkSetup(profile,env);assert.deepEqual(report.issues,[]);
    assert.match(report.notes.join(' '),/Client ID Metadata Document/);
    assert.doesNotMatch(JSON.stringify(report),/synthetic-private-host/);
    states.push(oauthStore(resolveConnection(profile,env),{}).path);
    const mixed={...profile,url:region.endpoint,urlEnv:undefined,oauth:{...profile.oauth,
      clientMetadataUrl:env.TYPEFORM_MCP_CLIENT_METADATA_URL,clientMetadataUrlEnv:undefined}};
    assert.equal(resolveConnection(mixed,env).oauth.issuer,region.issuer,'A literal endpoint/CIMD may still use a private issuer reference');
    const wrong={...env,TYPEFORM_MCP_ISSUER:region.issuer==='https://api.typeform.com'?'https://api.typeform.eu':'https://api.typeform.com'};
    assert.throws(()=>resolveConnection(profile,wrong),/matching issuer/);
    assert.match((await checkSetup(profile,wrong)).issues.join(' '),/invalid/);
    assert.throws(()=>resolveConnection(profile,{...env,TYPEFORM_MCP_URL:'https://unexpected.invalid/mcp'}),/documented regional endpoint/);
    assert.throws(()=>resolveConnection(profile,{...env,TYPEFORM_MCP_CLIENT_METADATA_URL:`https://example.invalid/${'x'.repeat(256)}`}),/255/);
  }
  assert.equal(new Set(states).size,3,'EU1 and default share an issuer but must not share account state');
  assert.equal(profile.enabled,false);assert.equal(profile.allowWrites,false);assert.equal(profile.readTools.length,28);
  assert.equal(profile.readTools.includes('forms-public_publish_form'),false);
  assert.equal(profile.readTools.includes('forms-public_validate_patch'),false);
  assert.equal(profile.readTools.includes('submit_feedback'),false);
});

test('Typeform preparation replaces only an untouched disabled bridge and preserves any customized or active settings',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-typeform-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'connections.json');
  const old={id:'typeform',label:'Typeform',enabled:false,readTools:[],allowWrites:false,transport:'stdio',
    command:'mcp-remote',args:['https://api.typeform.com/mcp'],env:{}};
  for(const change of [{},{enabled:true},{args:['https://api.eu.typeform.com/mcp']},{args:[...old.args,'--custom']},
    {env:{CUSTOM:'PRIVATE_REF'}},{readTools:['private_read']},{userNote:'synthetic-private-note'}]){
    const current={...old,...change},original=JSON.stringify({connections:[current]});await writeFile(path,original,{mode:0o600});
    const prepared=await prepareConnections(path,['typeform']),unchanged=Object.keys(change).length>0;
    assert.equal(prepared.plan.selections[0].action,unchanged?'preserve-configured':'replace-unused-placeholder');
    assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections,[unchanged?current:profile]);
    assert.equal(await readFile(path,'utf8'),original);assert.doesNotMatch(JSON.stringify(prepared.plan),/synthetic-private-note|private_read|PRIVATE_REF/);
  }
});
