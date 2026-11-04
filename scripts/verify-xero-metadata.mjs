import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

const resourceUrl='https://api.xero.com/.well-known/oauth-protected-resource/mcp/v1';
const issuerUrl='https://identity.xero.com/.well-known/oauth-authorization-server';

/** Public metadata GETs only. Never loads .env, OAuth state or account credentials. */
export async function verifyXeroMetadata(fetchFn=fetch) {
  const profile=JSON.parse(await readFile(new URL('../integrations/xero/connection.json',import.meta.url),'utf8'));
  const deadline=AbortSignal.timeout(30_000);
  const requests=[];
  const info=await discoverOAuthServerInfo(profile.url,{fetchFn:async(input,init)=>{
    const request=new Request(input,init);
    assert.ok([resourceUrl,issuerUrl].includes(request.url),'Unexpected discovery URL; review upstream metadata before continuing');
    assert.equal(request.method,'GET','Metadata check must never register a client or request tokens');
    assert.equal(request.headers.has('authorization'),false);
    assert.equal(request.headers.has('cookie'),false);
    requests.push(request.url);
    assert.ok(requests.length<=2,'Unexpected discovery retries');
    const response=await fetchFn(request.url,{...init,signal:deadline,redirect:'error',credentials:'omit'});
    assert.equal(response.status,200,'Public metadata request failed');
    return response;
  }});
  assert.deepEqual(requests,[resourceUrl,issuerUrl]);
  const resource=info.resourceMetadata, server=info.authorizationServerMetadata;
  assert.equal(resource?.resource,profile.url);
  assert.deepEqual(resource.authorization_servers,[profile.oauth.issuer]);
  assert.equal(info.authorizationServerUrl,profile.oauth.issuer);
  assert.equal(server?.issuer,profile.oauth.issuer);
  assert.equal(server.authorization_endpoint,'https://login.xero.com/identity/connect/authorize');
  assert.equal(server.token_endpoint,'https://identity.xero.com/connect/token');
  assert.ok(server.code_challenge_methods_supported?.includes('S256'));
  assert.ok(server.grant_types_supported?.includes('refresh_token'));
  assert.equal(server.registration_endpoint,undefined,'Registration behavior changed; review the registered-client profile');
  assert.ok(profile.oauth.scope.split(' ').every(scope=>resource.scopes_supported?.includes(scope)));
  assert.equal(profile.oauth.clientSecretEnv,undefined);
  const sdk=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies['@modelcontextprotocol/client'];
  return {
    vendor:'Xero Developer Remote MCP',endpoint:profile.url,issuer:profile.oauth.issuer,sdk,
    evidence:'public unauthenticated metadata discovery only; no login, tokens, tools or account operations',
    checks:{officialSdkDiscovery:true,registeredPublicPkcePrerequisites:true,requestedScopesAdvertised:true,noAuthenticationOrToolCalls:true},
    metadataSha256:createHash('sha256').update(JSON.stringify({resource,server})).digest('hex'),
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyXeroMetadata(),null,2)); }
  catch { console.error('Xero public metadata verification failed. No account was accessed. Review official metadata and profile requirements.'); process.exitCode=1; }
}
