import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { verifyPipedriveMetadata } from '../scripts/verify-pipedrive-metadata.mjs';
import { checkSetup } from '../dist/setup-check.js';
import { resolveConnection } from '../dist/connections.js';

const profile=JSON.parse(await readFile('integrations/pipedrive/connection.json','utf8'));
const resourceUrl='https://mcp.pipedrive.ai/.well-known/oauth-protected-resource/mcp';
const issuerUrl='https://oauth.pipedrive.com/.well-known/oauth-authorization-server';
const metadata=()=>({
  [resourceUrl]:{resource:profile.url,authorization_servers:[profile.oauth.issuer],scopes_supported:profile.oauth.scope.split(' ')},
  [issuerUrl]:{issuer:profile.oauth.issuer,authorization_endpoint:'https://oauth.pipedrive.com/oauth/authorize',
    token_endpoint:'https://oauth.pipedrive.com/oauth/token',registration_endpoint:'https://oauth.pipedrive.com/oauth/register',
    token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post'],code_challenge_methods_supported:['S256'],
    grant_types_supported:['authorization_code','refresh_token'],response_types_supported:['code'],scopes_supported:profile.oauth.scope.split(' ')},
});

test('Pipedrive checker uses only SDK public metadata GETs without registration or credential headers',async()=>{
  const docs=metadata(),seen=[];
  const report=await verifyPipedriveMetadata(async(url,init)=>{
    seen.push(url);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    return Response.json(docs[url]);
  });
  assert.deepEqual(seen,[resourceUrl,issuerUrl]);assert.equal(report.checks.noRegistrationOrAccountOperations,true);
});

test('Pipedrive checker rejects issuer, scope, PKCE and registration-method drift',async()=>{
  for(const change of [docs=>{docs[issuerUrl].issuer='https://unexpected.invalid';},
    docs=>{docs[resourceUrl].scopes_supported=['base'];},docs=>{docs[issuerUrl].code_challenge_methods_supported=['plain'];},
    docs=>{docs[issuerUrl].token_endpoint_auth_methods_supported=['none'];}]){
    const docs=metadata();change(docs);await assert.rejects(verifyPipedriveMetadata(async(url)=>Response.json(docs[url])));
  }
});

test('Pipedrive setup requires both registered-app refs without disclosing their values or silently selecting DCR',async()=>{
  const report=await checkSetup(profile,{});
  assert.deepEqual(report.issues,['Set PIPEDRIVE_MCP_CLIENT_SECRET in the launch environment.','Set PIPEDRIVE_MCP_CLIENT_ID in the launch environment.']);
  assert.throws(()=>resolveConnection(profile,{}),/PIPEDRIVE_MCP_CLIENT_ID/);
  const env={PIPEDRIVE_MCP_CLIENT_ID:'synthetic-client',PIPEDRIVE_MCP_CLIENT_SECRET:'synthetic-private-secret'};
  assert.deepEqual((await checkSetup(profile,env)).issues,[]);
  assert.doesNotMatch(JSON.stringify(await checkSetup(profile,env)),/synthetic-private-secret|synthetic-client/);
  assert.equal(profile.readTools.length,23);assert.equal(profile.readTools.includes('addDeal'),false);
});
