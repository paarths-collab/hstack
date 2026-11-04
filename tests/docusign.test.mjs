import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDocusignMetadata } from '../scripts/verify-docusign-metadata.mjs';
import { checkSetup } from '../dist/setup-check.js';
import { prepareConnections } from '../dist/prepare.js';
import { resolveConnection } from '../dist/connections.js';
import { oauthStore } from '../dist/oauth.js';

const profile=JSON.parse(await readFile('integrations/docusign/connection.json','utf8'));
function fixture({mismatch=true,scopes=['signature']}={}){
  const seen=[];
  return{seen,fetch:async(url,init)=>{
    seen.push(url);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    const u=new URL(url),production=u.hostname==='mcp.docusign.com',origin=u.origin,account=`https://account${production?'':'-d'}.docusign.com`;
    if(u.pathname==='/.well-known/oauth-protected-resource/mcp')return new Response(null,{status:403});
    if(u.pathname==='/.well-known/oauth-protected-resource')return Response.json({resource:`${origin}/mcp`,authorization_servers:[origin],scopes_supported:scopes});
    assert.equal(u.pathname,'/.well-known/oauth-authorization-server');
    return Response.json({issuer:production&&mismatch?account:origin,authorization_endpoint:`${account}/oauth/auth`,token_endpoint:`${account}/oauth/token`,
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],scopes_supported:scopes});
  }};
}

test('Docusign probe permits SDK root-metadata fallback and reports the production issuer mismatch without bypassing it',async()=>{
  const f=fixture(),report=await verifyDocusignMetadata(f.fetch);
  assert.equal(report.sdkCompatible,false);assert.equal(f.seen.length,6);
  assert.equal(report.environments[0].sdkCompatible,true);assert.equal(report.environments[1].failure.code,'ISSUER_MISMATCH');
  assert.equal(report.environments[1].failure.observedIssuer,'https://account.docusign.com');
  assert.ok(f.seen.every(url=>url.includes('/.well-known/')),'Probe must never request authorization/token/registration endpoints');
});

test('Docusign probe recognizes corrected production metadata and refuses changed scope claims',async()=>{
  assert.equal((await verifyDocusignMetadata(fixture({mismatch:false}).fetch)).sdkCompatible,true);
  const failed=await verifyDocusignMetadata(fixture({mismatch:false,scopes:['unrelated']}).fetch);
  assert.equal(failed.sdkCompatible,false);assert.ok(failed.environments.every(report=>report.failure.code==='PUBLIC_METADATA_CHECK_FAILED'));
});

test('Docusign demo setup requires explicit registered refs, preserves read-only defaults and cannot reuse demo state for production',async()=>{
  const missing=await checkSetup(profile,{});
  assert.deepEqual(missing.issues,['Set DOCUSIGN_DEMO_CLIENT_SECRET in the launch environment.','Set DOCUSIGN_DEMO_CLIENT_ID in the launch environment.']);
  const env={DOCUSIGN_DEMO_CLIENT_ID:'synthetic-client',DOCUSIGN_DEMO_CLIENT_SECRET:'synthetic-private-secret'};
  const resolved=resolveConnection(profile,env);assert.deepEqual((await checkSetup(profile,env)).issues,[]);
  assert.doesNotMatch(JSON.stringify(await checkSetup(profile,env)),/synthetic-client|synthetic-private-secret/);
  assert.deepEqual(profile.readTools,['getUserInfo','searchDocusignDocs']);assert.equal(profile.enabled,false);assert.equal(profile.allowWrites,false);
  const production={...resolved,url:'https://mcp.docusign.com/mcp',oauth:{...resolved.oauth,issuer:'https://mcp.docusign.com'}};
  assert.notEqual(oauthStore(resolved,{}).path,oauthStore(production,{}).path);
});

test('Docusign preparation replaces only the unused executable placeholder and preserves the source file',async(t)=>{
  const home=await mkdtemp(join(tmpdir(),'hstack-docusign-'));t.after(()=>rm(home,{recursive:true,force:true}));const path=join(home,'connections.json');
  const original=JSON.stringify({connections:[{id:'docusign',label:'Docusign',enabled:false,transport:'stdio',command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false}]});
  await writeFile(path,original,{mode:0o600});const candidate=await prepareConnections(path,['docusign']);
  assert.equal(candidate.plan.selections[0].action,'replace-unused-placeholder');assert.equal(await readFile(path,'utf8'),original);
  assert.deepEqual(JSON.parse(await readFile(candidate.candidatePath,'utf8')).connections,[profile]);
});
