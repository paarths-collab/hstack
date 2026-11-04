import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

export const typeformRegions=[
  {name:'default',endpoint:'https://api.typeform.com/mcp',issuer:'https://api.typeform.com'},
  {name:'eu-datacenter-1',endpoint:'https://api.eu.typeform.com/mcp',issuer:'https://api.typeform.com'},
  {name:'eu-datacenter-2',endpoint:'https://api.typeform.eu/mcp',issuer:'https://api.typeform.eu'},
];

/** Fixed public metadata GETs only. No .env, credentials, registration or tools. */
export async function verifyTypeformMetadata(fetchFn=fetch){
  const deadline=AbortSignal.timeout(30_000);
  const regions=await Promise.all(typeformRegions.map(async region=>{
    const origin=new URL(region.endpoint).origin,requests=[],metadata=[];
    const allowed=new Set([`${origin}/.well-known/oauth-protected-resource/mcp`,`${origin}/.well-known/oauth-protected-resource`,
      `${region.issuer}/.well-known/oauth-authorization-server`]);
    try{
      const info=await discoverOAuthServerInfo(region.endpoint,{fetchFn:async(input,init)=>{
        const request=new Request(input,init);assert.equal(request.method,'GET');assert.ok(allowed.has(request.url));
        assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);
        assert.ok(requests.length<3,'Unexpected metadata retries');
        const response=await fetchFn(request.url,{...init,signal:deadline,redirect:'error',credentials:'omit'});
        requests.push({url:request.url,status:response.status});
        if(response.status===200)metadata.push({url:request.url,body:await response.clone().json()});
        return response;
      }});
      const resource=info.resourceMetadata,server=info.authorizationServerMetadata;
      assert.equal(resource?.resource,region.endpoint);assert.deepEqual(resource.authorization_servers,[region.issuer]);
      assert.equal(info.authorizationServerUrl,region.issuer);assert.equal(server?.issuer,region.issuer);
      assert.equal(server.authorization_endpoint,`${region.issuer.replace('://api.', '://admin.')}/oauth/authorize`);
      assert.equal(server.token_endpoint,`${region.issuer}/oauth/token`);
      assert.equal(server.client_id_metadata_document_supported,true);
      assert.ok(server.code_challenge_methods_supported?.includes('S256'));
      assert.ok(server.grant_types_supported?.includes('refresh_token'));
      assert.ok(resource.scopes_supported?.includes('accounts:read')&&server.scopes_supported?.includes('offline_access'));
      assert.equal(server.registration_endpoint,`${region.issuer}/oauth/register`);
      return{...region,sdkCompatible:true,requests,checks:{officialSdkDiscovery:true,cimdAndPkceAdvertised:true,refreshScopeAdvertised:true},
        registrationEndpointAdvertised:true,registrationAttempted:false,
        metadataSha256:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')};
    }catch{
      return{...region,sdkCompatible:false,requests,failure:{code:'PUBLIC_METADATA_CHECK_FAILED'},
        metadataSha256:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')};
    }
  }));
  const sdk=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies['@modelcontextprotocol/client'];
  return{vendor:'Typeform native MCP',sdk,evidence:'Public unauthenticated OAuth metadata only; no credentials, registration, sign-in, tokens, tool discovery or account operations.',
    sdkCompatible:regions.every(region=>region.sdkCompatible),regions};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await verifyTypeformMetadata();console.log(JSON.stringify(report,null,2));if(!report.sdkCompatible)process.exitCode=1;}
  catch{console.error('Typeform public metadata check failed. No account was accessed.');process.exitCode=1;}
}
