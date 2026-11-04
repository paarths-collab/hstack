import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

const endpoint='https://mcp.hubspot.com';
const paths=[`${endpoint}/.well-known/oauth-protected-resource`,`${endpoint}/.well-known/oauth-authorization-server`];

/** Two public credential-free GETs only; no registration, tokens or account tools. */
export async function verifyHubspotMetadata(fetchFn=fetch){
  const profile=JSON.parse(await readFile(new URL('../integrations/hubspot/connection.json',import.meta.url),'utf8'));
  assert.equal(profile.url,endpoint);assert.equal(profile.oauth.issuer,endpoint);
  assert.ok(profile.oauth.clientIdEnv&&profile.oauth.clientSecretEnv);
  assert.equal(profile.oauth.scope,undefined,'HubSpot installation determines permissions; no fixed grant is assumed');
  const deadline=AbortSignal.timeout(30_000),requests=[];
  const info=await discoverOAuthServerInfo(endpoint,{fetchFn:async(input,init)=>{
    const request=new Request(input,init);assert.equal(request.method,'GET');assert.ok(paths.includes(request.url));
    assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);
    requests.push(request.url);assert.ok(requests.length<=2,'Unexpected metadata retries');
    const response=await fetchFn(request.url,{...init,signal:deadline,redirect:'error',credentials:'omit'});
    assert.equal(response.status,200);return response;
  }});
  assert.deepEqual(requests,paths);
  const resource=info.resourceMetadata,server=info.authorizationServerMetadata;
  assert.equal(resource?.resource,endpoint);assert.deepEqual(resource.authorization_servers,[endpoint]);
  assert.equal(info.authorizationServerUrl,endpoint);assert.equal(server?.issuer,endpoint);
  assert.equal(server.authorization_endpoint,`${endpoint}/oauth/authorize/user`);
  assert.equal(server.token_endpoint,`${endpoint}/oauth/v3/token`);
  assert.equal(server.registration_endpoint,undefined);
  assert.deepEqual(server.token_endpoint_auth_methods_supported,['client_secret_post']);
  assert.ok(server.code_challenge_methods_supported?.includes('S256'));
  assert.ok(server.grant_types_supported?.includes('authorization_code')&&server.grant_types_supported?.includes('refresh_token'));
  assert.deepEqual(resource.scopes_supported,[]);assert.deepEqual(server.scopes_supported,[]);
  const sdk=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies['@modelcontextprotocol/client'];
  return{vendor:'HubSpot remote CRM MCP',endpoint,issuer:endpoint,sdk,
    evidence:'Public unauthenticated OAuth metadata only; no credentials, registration, sign-in, tokens, tool discovery or account operations.',
    checks:{officialSdkDiscovery:true,registeredSecretPostAndPkceAdvertised:true,refreshAdvertised:true,installationSelectedPermissions:true,noRegistrationOrAccountOperations:true},
    metadataSha256:createHash('sha256').update(JSON.stringify({resource,server})).digest('hex'),requests};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await verifyHubspotMetadata(),null,2));}
  catch{console.error('HubSpot public metadata verification failed. Review native endpoint, issuer and registered-client prerequisites. No account was accessed.');process.exitCode=1;}
}
