import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

const resourceUrl='https://mcp.pipedrive.ai/.well-known/oauth-protected-resource/mcp';
const issuerUrl='https://oauth.pipedrive.com/.well-known/oauth-authorization-server';

/** Two public credential-free GETs only; never registers, signs in or calls tools. */
export async function verifyPipedriveMetadata(fetchFn=fetch){
  const profile=JSON.parse(await readFile(new URL('../integrations/pipedrive/connection.json',import.meta.url),'utf8'));
  const deadline=AbortSignal.timeout(30_000),requests=[];
  const info=await discoverOAuthServerInfo(profile.url,{fetchFn:async(input,init)=>{
    const request=new Request(input,init);
    assert.ok([resourceUrl,issuerUrl].includes(request.url));assert.equal(request.method,'GET');
    assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);
    requests.push(request.url);assert.ok(requests.length<=2);
    const response=await fetchFn(request.url,{...init,signal:deadline,credentials:'omit',redirect:'error'});
    assert.equal(response.status,200);return response;
  }});
  assert.deepEqual(requests,[resourceUrl,issuerUrl]);
  const resource=info.resourceMetadata,server=info.authorizationServerMetadata;
  assert.equal(resource?.resource,profile.url);assert.deepEqual(resource.authorization_servers,[profile.oauth.issuer]);
  assert.equal(info.authorizationServerUrl,profile.oauth.issuer);assert.equal(server?.issuer,profile.oauth.issuer);
  assert.equal(server.authorization_endpoint,'https://oauth.pipedrive.com/oauth/authorize');
  assert.equal(server.token_endpoint,'https://oauth.pipedrive.com/oauth/token');
  assert.equal(server.registration_endpoint,'https://oauth.pipedrive.com/oauth/register');
  assert.deepEqual(server.token_endpoint_auth_methods_supported,['client_secret_basic','client_secret_post']);
  assert.ok(server.code_challenge_methods_supported?.includes('S256'));
  assert.ok(server.grant_types_supported?.includes('refresh_token'));
  assert.ok(profile.oauth.scope.split(' ').every(scope=>resource.scopes_supported?.includes(scope)&&server.scopes_supported?.includes(scope)));
  assert.ok(profile.oauth.clientIdEnv&&profile.oauth.clientSecretEnv,'The local profile uses explicit registered-client references, not native DCR');
  return{vendor:'Pipedrive native MCP',endpoint:profile.url,issuer:profile.oauth.issuer,sdk:'2.4.0',
    evidence:'Public unauthenticated OAuth metadata only; no registration, sign-in, credentials or tool calls.',
    checks:{officialSdkDiscovery:true,profileScopesAdvertised:true,registeredClientMethodsAdvertised:true,noRegistrationOrAccountOperations:true},
    metadataSha256:createHash('sha256').update(JSON.stringify({resource,server})).digest('hex'),requests};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await verifyPipedriveMetadata(),null,2));}
  catch{console.error('Pipedrive public metadata check failed. Review official endpoint/auth metadata; no account was accessed.');process.exitCode=1;}
}
