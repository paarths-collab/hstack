import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo, IssuerMismatchError } from '@modelcontextprotocol/client';

const environments=[
  {name:'demo',origin:'https://mcp-d.docusign.com',account:'https://account-d.docusign.com'},
  {name:'production',origin:'https://mcp.docusign.com',account:'https://account.docusign.com'},
];

/** Public metadata only. Preserve SDK issuer checks; never register or sign in. */
export async function verifyDocusignMetadata(fetchFn=fetch){
  const profile=JSON.parse(await readFile(new URL('../integrations/docusign/connection.json',import.meta.url),'utf8'));
  assert.equal(profile.url,`${environments[0].origin}/mcp`);assert.equal(profile.oauth.issuer,environments[0].origin);
  assert.ok(profile.oauth.clientIdEnv&&profile.oauth.clientSecretEnv);assert.equal(profile.oauth.scope,'signature');
  const deadline=AbortSignal.timeout(30_000);
  const reports=await Promise.all(environments.map(async environment=>{
    const endpoint=`${environment.origin}/mcp`,requests=[],metadata=[];
    const paths=['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource','/.well-known/oauth-authorization-server'];
    try{
      const info=await discoverOAuthServerInfo(endpoint,{fetchFn:async(input,init)=>{
        const request=new Request(input,init);
        assert.equal(request.method,'GET');assert.ok(paths.some(path=>request.url===environment.origin+path));
        assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);
        assert.ok(requests.length<4,'Unexpected metadata retries');
        const response=await fetchFn(request.url,{...init,signal:deadline,redirect:'error',credentials:'omit'});
        requests.push({url:request.url,status:response.status});
        if(response.status===200)metadata.push({url:request.url,body:await response.clone().json()});
        return response;
      }});
      const resource=info.resourceMetadata,server=info.authorizationServerMetadata;
      assert.equal(resource?.resource,endpoint);assert.deepEqual(resource.authorization_servers,[environment.origin]);
      assert.equal(info.authorizationServerUrl,environment.origin);assert.equal(server?.issuer,environment.origin);
      assert.equal(server.authorization_endpoint,`${environment.account}/oauth/auth`);
      assert.equal(server.token_endpoint,`${environment.account}/oauth/token`);
      assert.equal(server.registration_endpoint,undefined,'Review new registration behavior before changing the registered-client profile');
      assert.ok(server.code_challenge_methods_supported?.includes('S256'));assert.ok(server.grant_types_supported?.includes('refresh_token'));
      assert.ok(resource.scopes_supported?.includes('signature')&&server.scopes_supported?.includes('signature'));
      if(server.token_endpoint_auth_methods_supported)assert.ok(server.token_endpoint_auth_methods_supported.some(method=>['client_secret_basic','client_secret_post'].includes(method)));
      return{environment:environment.name,endpoint,sdkCompatible:true,requests,
        checks:{officialSdkOAuthDiscovery:true,signatureScopeAdvertised:true,pkceAndRefreshAdvertised:true},
        metadataSha256:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')};
    }catch(error){
      const mismatch=error instanceof IssuerMismatchError&&error.kind==='metadata';
      return{environment:environment.name,endpoint,sdkCompatible:false,requests,
        failure:{code:mismatch?'ISSUER_MISMATCH':'PUBLIC_METADATA_CHECK_FAILED',
          ...(mismatch?{expectedIssuer:environment.origin,observedIssuer:error.received===environment.account?environment.account:'unexpected_issuer'}:{})},
        metadataSha256:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')};
    }
  }));
  const sdk=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies['@modelcontextprotocol/client'];
  return{vendor:'Docusign native MCP',sdk,
    evidence:'Public unauthenticated OAuth metadata only; no account credentials, registration, sign-in, tokens or tool calls.',
    sdkCompatible:reports.every(report=>report.sdkCompatible),environments:reports};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await verifyDocusignMetadata();console.log(JSON.stringify(report,null,2));if(!report.sdkCompatible)process.exitCode=1;}
  catch{console.error('Docusign public metadata verification failed. No account or documents were accessed.');process.exitCode=1;}
}
