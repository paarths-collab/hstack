import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOAuthServerInfo, IssuerMismatchError } from '@modelcontextprotocol/client';

// Reviewed public resource/issuer origins only. Never follow a new IdP blindly.
export const reviewedOAuthTargets=[
  {id:'brand24',endpoint:'https://mcp.brand24.com/v1/mcp',origins:['https://mcp.brand24.com','https://oauth.brand24.com']},
  {id:'kit',endpoint:'https://app.kit.com/mcp',origins:['https://app.kit.com','https://api.kit.com']},
  {id:'readwise',endpoint:'https://mcp2.readwise.io/mcp',origins:['https://mcp2.readwise.io','https://readwise.io']},
  {id:'evernote',endpoint:'https://mcp.evernote.com/mcp',origins:['https://mcp.evernote.com','https://accounts.evernote.com']},
  {id:'calcom',endpoint:'https://mcp.cal.com/mcp',origins:['https://mcp.cal.com']},
  {id:'trello',endpoint:'https://mcp.trello.com/v1',origins:['https://mcp.trello.com','https://auth.atlassian.com']},
  {id:'helpscout',endpoint:'https://mcp.helpscout.net/mcp',origins:['https://mcp.helpscout.net']},
  {id:'pandadoc',endpoint:'https://mcp.pandadoc.com/v1/mcp',origins:['https://mcp.pandadoc.com']},
];

/** Discovery only: public GETs, no .env, credential stores, registration or tools. */
export async function verifyRemainingOAuthMetadata(fetchFn=fetch){
  const deadline=AbortSignal.timeout(30_000);
  const services=await Promise.all(reviewedOAuthTargets.map(async target=>{
    const requests=[],documents=[];let unreviewedOrigin;
    try{
      const info=await discoverOAuthServerInfo(target.endpoint,{fetchFn:async(input,init)=>{
        const request=new Request(input,init),url=new URL(request.url);
        assert.equal(request.method,'GET');assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);
        assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.hash,'');assert.equal(url.search,'');
        if(!target.origins.includes(url.origin)){unreviewedOrigin=url.origin;throw new Error('Unreviewed authorization origin');}
        assert.ok(url.pathname.includes('/.well-known/'),'Only OAuth discovery paths can be fetched');
        assert.ok(requests.length<8,'Unexpected discovery retry/fallback loop');
        const response=await fetchFn(url.href,{...init,signal:deadline,redirect:'error',credentials:'omit'});
        requests.push({url:url.href,status:response.status});
        if(response.status===200)documents.push({url:url.href,body:await response.clone().json()});
        return response;
      }});
      if(unreviewedOrigin)throw new Error('A fallback must not hide an unreviewed authorization origin');
      const server=info.authorizationServerMetadata;
      assert.ok(server?.issuer&&server.authorization_endpoint&&server.token_endpoint,'Complete authorization metadata required');
      return{id:target.id,endpoint:target.endpoint,officialSdkDiscovery:true,requests,
        issuer:server.issuer,protectedResource:info.resourceMetadata?.resource??null,
        registrationEndpoint:server.registration_endpoint??null,cimdAdvertised:server.client_id_metadata_document_supported===true,
        bootstrap:{dynamicRegistrationAdvertised:!!server.registration_endpoint,
          nativePublicClientMethodAdvertised:server.token_endpoint_auth_methods_supported?.includes('none')??null,
          needsCimdOrRegisteredClient:!server.registration_endpoint,
          registrationMethodReviewRequired:!!server.registration_endpoint&&!!server.token_endpoint_auth_methods_supported&&!server.token_endpoint_auth_methods_supported.includes('none')},
        tokenAuthMethods:server.token_endpoint_auth_methods_supported??null,
        pkceS256Advertised:server.code_challenge_methods_supported?.includes('S256')??false,
        refreshAdvertised:server.grant_types_supported?.includes('refresh_token')??false,
        resourceScopes:info.resourceMetadata?.scopes_supported??null,serverScopes:server.scopes_supported??null,
        metadataSha256:createHash('sha256').update(JSON.stringify(documents)).digest('hex')};
    }catch(error){
      return{id:target.id,endpoint:target.endpoint,officialSdkDiscovery:false,requests,
        failure:{code:unreviewedOrigin?'AUTHORIZATION_ORIGIN_REVIEW_REQUIRED':error instanceof IssuerMismatchError?'ISSUER_MISMATCH':'PUBLIC_METADATA_CHECK_FAILED',
          ...(unreviewedOrigin?{origin:unreviewedOrigin}:{})},
        metadataSha256:createHash('sha256').update(JSON.stringify(documents)).digest('hex')};
    }
  }));
  return{evidence:'Public unauthenticated OAuth metadata only. No client registration, sign-in, tokens, tool discovery, account credentials or service operations.',
    allDiscovered:services.every(service=>service.officialSdkDiscovery),services};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await verifyRemainingOAuthMetadata();console.log(JSON.stringify(report,null,2));if(!report.allDiscovered)process.exitCode=1;}
  catch{console.error('Public OAuth metadata review failed. No account was accessed.');process.exitCode=1;}
}
