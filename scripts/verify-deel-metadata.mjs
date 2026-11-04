import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Client, InMemoryTransport, discoverOAuthServerInfo } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { withRemoteClient, listAllTools } from '../dist/discover-tools.js';
import { compileToolSchema } from '../dist/tool-schema.js';
import { createSocialGateway } from '../dist/gateway.js';

export const deelEndpoint='https://api.letsdeel.com/mcp';

/** Officially public protocol discovery only. No .env, OAuth provider or credentials. */
export async function verifyDeelMetadata(fetchImpl=fetch){
  const deadline=AbortSignal.timeout(30_000),requests=[];
  const publicFetch=async(url,init)=>{
    assert.equal(String(url),deelEndpoint);
    if(init?.method==='GET'||init?.method==='DELETE')return new Response(null,{status:405});
    assert.equal(init?.method,'POST');
    const headers=new Headers(init.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
    const request=JSON.parse(init.body);
    assert.ok(['initialize','notifications/initialized','tools/list'].includes(request.method),'Account tools and OAuth actions must never be sent');
    assert.ok(requests.length<102,'Unexpected discovery/pagination loop');requests.push(request.method);
    return fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,deadline]):deadline,credentials:'omit',redirect:'error'});
  };
  let era;
  const tools=await withRemoteClient(new URL(deelEndpoint),{
    label:'Public Deel catalogue',credentialEnv:'none',headers:{},protocol:'legacy',fetch:publicFetch,
  },async(client,signal)=>{era=client.getProtocolEra();return listAllTools(client,signal);},30_000,deadline);
  assert.ok(tools.length>0&&tools.length<=2000,'Review changed catalogue size');
  const validator=new AjvJsonSchemaValidator();let compiledSchemas=0;
  for(const tool of tools){compileToolSchema(validator,tool.inputSchema);compiledSchemas++;
    if(tool.outputSchema){compileToolSchema(validator,tool.outputSchema);compiledSchemas++;}}
  const profile=JSON.parse(await readFile(new URL('../integrations/deel/connection.json',import.meta.url),'utf8'));
  assert.ok(profile.readTools.every(name=>tools.some(tool=>tool.name===name&&tool.annotations?.readOnlyHint===true
    &&isDeepStrictEqual(tool._meta?.securitySchemes,[{type:'noauth'}]))),'Review changed public read/security metadata');
  let upstreamCalls=0;
  const provider={id:'deel',label:'Public Deel schema review',tools,readTools:new Set(profile.readTools),allowWrites:false,
    call:async()=>{upstreamCalls++;throw new Error('No vendor operation can run in metadata verification');}};
  let searchControls,searchSchemaBytes;
  for(const toolMode of ['forward','search']){
    const gateway=createSocialGateway([provider],{toolMode}),client=new Client({name:'hstack-public-deel-check',version:'0'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try{
      await gateway.connect(b);await client.connect(a);const listed=(await client.listTools(undefined,{signal:deadline})).tools;
      if(toolMode==='forward'){
        assert.deepEqual(listed.map(tool=>({...tool,name:tool.name.replace(/^deel__/, '')})),tools,'Gateway must preserve public schemas and metadata');
      }else{searchControls=listed.length;assert.equal(searchControls,2);searchSchemaBytes=Buffer.byteLength(JSON.stringify(listed));
        const result=await client.callTool({name:'hstack_search_tools',arguments:{service:'deel',query:profile.readTools[0],limit:1}});
        const found=JSON.parse(result.content[0].text).tools;assert.equal(found.length,1);assert.equal(found[0].name,`deel__${profile.readTools[0]}`);
        assert.deepEqual(found[0].inputSchema,tools.find(tool=>tool.name===profile.readTools[0]).inputSchema);
      }
    }finally{try{await client.close();}finally{await gateway.close();}}
  }
  assert.equal(upstreamCalls,0);
  return{tools,report:{vendor:'Deel native MCP',endpoint:deelEndpoint,sdk:'2.4.0',
    evidence:'Public anonymous initialize and tools/list plus local gateway metadata/search checks only; no vendor registration, login, tokens, credentials, tools/call or account data.',
    sdkEra:era,toolCount:tools.length,compiledSchemas,requests,
    catalogueSha256:createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    checks:{nativeSdkDiscovery:true,allInputOutputSchemasCompile:true,credentialFree:true,noVendorToolInvocation:true,gatewaySchemasPreserved:true},
    discoveryComparison:{directSdkTools:tools.length,directSdkSchemaBytes:Buffer.byteLength(JSON.stringify(tools)),hstackSearchControls:searchControls,hstackSearchSchemaBytes:searchSchemaBytes,
      limitation:'Serialized SDK catalogue/control counts only; no model, latency, cost, native Hermes or setup-time comparison'},
    accountVerified:false}};
}

/** Official SDK auth discovery only; no registration/token/account requests. */
export async function verifyDeelOAuthMetadata(fetchFn=fetch){
  const profile=JSON.parse(await readFile(new URL('../integrations/deel/connection.json',import.meta.url),'utf8'));
  const origin='https://api.letsdeel.com',allowed=[`${origin}/.well-known/oauth-protected-resource/mcp`,`${origin}/.well-known/oauth-authorization-server`];
  const requests=[],deadline=AbortSignal.timeout(30_000);
  const info=await discoverOAuthServerInfo(deelEndpoint,{fetchFn:async(input,init)=>{
    const request=new Request(input,init);assert.equal(request.method,'GET');assert.ok(allowed.includes(request.url));assert.ok(requests.length<2);
    assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);requests.push(request.url);
    const response=await fetchFn(request.url,{...init,signal:deadline,credentials:'omit',redirect:'error'});assert.equal(response.status,200);return response;
  }});
  const resource=info.resourceMetadata,server=info.authorizationServerMetadata;
  assert.equal(resource?.resource,deelEndpoint);assert.deepEqual(resource.authorization_servers,[origin]);assert.equal(server?.issuer,origin);
  assert.equal(info.authorizationServerUrl,origin);assert.equal(profile.oauth.issuer,origin);
  assert.equal(server.authorization_endpoint,`${origin}/oauth/authorize`);assert.equal(server.token_endpoint,`${origin}/oauth/tokens`);
  assert.equal(server.registration_endpoint,`${origin}/oauth/register`);assert.ok(server.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(server.code_challenge_methods_supported.includes('S256')&&server.grant_types_supported.includes('refresh_token'));
  assert.ok(profile.oauth.scope.split(' ').every(scope=>scope.endsWith(':read')&&resource.scopes_supported.includes(scope)&&server.scopes_supported.includes(scope)));
  return{issuer:origin,requestedScopes:profile.oauth.scope,requests,
    checks:{nativeSdkOAuthDiscovery:true,publicDcrAndPkceAdvertised:true,requestedReadScopesAdvertised:true,refreshAdvertised:true},
    metadataSha256:createHash('sha256').update(JSON.stringify({resource,server})).digest('hex'),
    limitation:'No DCR request, callback, consent, token, refresh, authenticated catalogue or account operation tested'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const publicCatalogue=await verifyDeelMetadata();const oauth=await verifyDeelOAuthMetadata();console.log(JSON.stringify({...publicCatalogue.report,oauth},null,2));}
  catch{console.error('Deel public catalogue verification failed. No credential or account tool was used; review the documented discovery contract.');process.exitCode=1;}
}
