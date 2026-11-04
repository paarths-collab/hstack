import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyXeroMetadata } from '../scripts/verify-xero-metadata.mjs';
import { prepareConnections } from '../dist/prepare.js';
import { checkSetup } from '../dist/setup-check.js';

const profile=JSON.parse(await readFile('integrations/xero/connection.json','utf8'));
const resourceUrl='https://api.xero.com/.well-known/oauth-protected-resource/mcp/v1';
const issuerUrl='https://identity.xero.com/.well-known/oauth-authorization-server';
const metadata=()=>({
  [resourceUrl]:{resource:profile.url,authorization_servers:[profile.oauth.issuer],scopes_supported:profile.oauth.scope.split(' ')},
  [issuerUrl]:{issuer:profile.oauth.issuer,authorization_endpoint:'https://login.xero.com/identity/connect/authorize',
    token_endpoint:'https://identity.xero.com/connect/token',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post']},
});

test('Xero metadata checker uses only two public credential-free GETs through the official SDK (fixture)',async()=>{
  const docs=metadata(),requests=[];
  const evidence=await verifyXeroMetadata(async(url,init)=>{
    requests.push(url);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.ok(init.signal instanceof AbortSignal);assert.equal(new Headers(init.headers).has('Authorization'),false);
    return Response.json(docs[url]);
  });
  assert.deepEqual(requests,[resourceUrl,issuerUrl]);
  assert.equal(evidence.checks.noAuthenticationOrToolCalls,true);
  assert.match(evidence.evidence,/no login, tokens, tools or account operations/);
});

test('Xero metadata checker refuses mismatched issuers, missing read/refresh scopes and changed registration',async()=>{
  for(const change of [docs=>{docs[resourceUrl].authorization_servers=['https://unexpected.example.invalid'];},
    docs=>{docs[issuerUrl].issuer='https://unexpected.example.invalid';},
    docs=>{docs[resourceUrl].scopes_supported=['openid'];},
    docs=>{docs[issuerUrl].registration_endpoint='https://identity.xero.com/register';}]) {
    const docs=metadata();change(docs);
    await assert.rejects(verifyXeroMetadata(async(url)=>Response.json(docs[url]??{}, {status:docs[url]?200:404})));
  }
});

test('Xero preparation replaces only the unused local placeholder and doctor requires registration',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-xero-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'connections.json');
  const original=JSON.stringify({connections:[{id:'xero',label:'Xero',enabled:false,transport:'stdio',command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false}]});
  await writeFile(path,original);
  const prepared=await prepareConnections(path,['xero']);
  assert.equal(prepared.plan.selections[0].action,'replace-unused-placeholder');
  assert.deepEqual(JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections,[profile]);
  assert.equal(await readFile(path,'utf8'),original);
  assert.deepEqual((await checkSetup(profile,{})).issues,['Set XERO_MCP_CLIENT_ID in the launch environment.']);
  assert.deepEqual((await checkSetup(profile,{XERO_MCP_CLIENT_ID:'synthetic-public-client'})).issues,[]);
});
