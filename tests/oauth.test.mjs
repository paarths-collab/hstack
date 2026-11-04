import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/client";
import { Server, InMemoryTransport } from "@modelcontextprotocol/server";
import { loginOAuth, oauthStore, StoredOAuthProvider, oauthFetch } from '../dist/oauth.js';
import { parseConnections, loadConnection, resolveConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let base;
  let registration;
  let challenge;
  let authorizedScope;
  let validAccess = 'none';
  let validRefresh = 'none';
  let issued = 0;
  let limitedRefresh = false;
  let hungRefresh = false;
  const stats = { refreshes: 0, exchanges: 0, calls: 0, staleRefreshes: 0, registrations: 0, mcpMethods:[], sessions:0 };
  const sessions=new Map();
  let callGate,releaseCalls,callStarted;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); };
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: options.resourceScopes ?? ['records:read'] });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, {
        issuer: options.metadataIssuerMismatch?'https://wrong-issuer.invalid/?key=synthetic-private-issuer':base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        ...(!options.registered ? { registration_endpoint: `${base}/register` } : {}),
        ...(options.cimd?{client_id_metadata_document_supported:!options.rejectCimd}:{}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        ...(!options.omitAuthMethods?{token_endpoint_auth_methods_supported: options.dcrMethod ? [options.dcrMethod] : options.publicClient ? ['client_secret_basic','client_secret_post'] : [options.registered ? options.registeredAuthMethod??'client_secret_post' : 'none']} : {}),
        ...(options.serverScopes ? { scopes_supported: options.serverScopes } : {}), authorization_response_iss_parameter_supported: !options.publicClient,
      });
      if (url.pathname === '/register') {
        stats.registrations++;
        if(options.cimd)return json(res,400,{error:'registration_forbidden_for_cimd_fixture'});
        if (options.registered) return json(res, 404, { error:'registration_not_supported' });
        const parts = []; for await (const part of req) parts.push(part);
        registration = JSON.parse(Buffer.concat(parts).toString());
        if(options.dcrMethod&&registration.token_endpoint_auth_method!==options.dcrMethod)return json(res,400,{error:'invalid_client_metadata'});
        return json(res, 201, { ...registration, client_id: 'fixture-client', ...(options.dcrMethod&&!options.omitDcrSecret?{client_secret:'synthetic-dcr-secret'}:{}),
          ...(options.dcrReturnedMethod?{token_endpoint_auth_method:options.dcrReturnedMethod}:{}) });
      }
      if (url.pathname === '/token') {
        const parts = []; for await (const part of req) parts.push(part);
        const form = new URLSearchParams(Buffer.concat(parts).toString());
        assert.equal(form.get('resource'), `${base}/mcp`);
        if(options.registeredAuthMethod==='client_secret_basic'||options.dcrMethod==='client_secret_basic') {
          assert.equal(req.headers.authorization,`Basic ${Buffer.from(`fixture-client:${options.dcrMethod?'synthetic-dcr-secret':'synthetic-registered-secret'}`).toString('base64')}`);
          assert.equal(form.has('client_secret'),false);
        }else assert.equal(form.get('client_id'), options.cimd?config.oauth.clientMetadataUrl:'fixture-client');
        if (options.publicClient) {
          assert.equal(form.has('client_secret'),false,'A registered PKCE public client must never send a secret');
          assert.equal(req.headers.authorization,undefined);
        } else if (options.registered&&options.registeredAuthMethod!=='client_secret_basic') {
          assert.equal(form.get('client_secret'), 'synthetic-registered-secret');
          assert.equal(req.headers.authorization, undefined, 'SDK must use the advertised post method, not Basic');
        } else if(options.dcrMethod==='client_secret_post') {
          assert.equal(form.get('client_secret'),'synthetic-dcr-secret');assert.equal(req.headers.authorization,undefined);
        }
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), 'fixture-code');
          assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
          assert.equal(form.get('redirect_uri'), registration.redirect_uris[0]);
          stats.exchanges++;
        } else {
          if (options.registered) assert.equal(form.get('scope'),null,'Refresh must not replace the original grant with the PRM default');
          stats.refreshes++;
          if (hungRefresh) return;
          if (limitedRefresh) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '17', 'RateLimit': '"daily";r=0', 'RateLimit-Policy': '"daily";w=86400' }).end(JSON.stringify({ error: 'too_many_requests', error_description: 'fixture-sensitive-never-log' })); return;
          }
          if (form.get('refresh_token') !== validRefresh) { stats.staleRefreshes++; return json(res, 400, { error: 'invalid_grant', error_description: 'fixture-sensitive-never-log' }); }
        }
        issued++;
        validAccess = `fixture-access-${issued}`; validRefresh = `fixture-refresh-${issued}`;
        return json(res, 200, { access_token: validAccess, token_type: 'Bearer', refresh_token: validRefresh, expires_in: 3600,
          ...(options.registered && authorizedScope ? { scope:authorizedScope } : {}) });
      }
      if (url.pathname === '/mcp') {
        if (req.headers.authorization !== `Bearer ${validAccess}` || validAccess === 'none') {
          res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end('fixture-sensitive-never-log'); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=JSON.parse(Buffer.concat(chunks).toString());stats.mcpMethods.push(body.method);
        if(options.stateful&&body.method!=='initialize'){
          const session=sessions.get(req.headers['mcp-session-id']);
          if(!session||session.actor!==stats.exchanges)return json(res,403,{error:'wrong synthetic session identity'});
          await session.transport.handleRequest(req,res,body);return;
        }
        const actor=stats.exchanges;
        const server = new Server({ name: 'fixture-oauth', version: '0' }, { capabilities: { tools: {} } });
        server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'get_record', inputSchema: { type: 'object', properties: {} } }] }));
        server.setRequestHandler('tools/call', async () => { stats.calls++;callStarted?.();if(callGate)await callGate;
          return { content: [{ type: 'text', text: 'fixture record' }],...(options.stateful?{_meta:{actor}}:{}) }; });
        const id=options.stateful?randomUUID():undefined;
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: id?()=>id:undefined, enableJsonResponse: true });
        if(id){sessions.set(id,{actor,server,transport});stats.sessions++;}
        else res.on('close', () => { void server.close(); });
        await server.connect(transport); await transport.handleRequest(req, res,body); return;
      }
      res.writeHead(404).end();
    } catch { json(res, 500, { error: 'fixture assertion failed' }); }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => { releaseCalls?.();for(const session of sessions.values())await session.server.close();
    http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
  const config = { id: 'fixture', label: 'Fixture', enabled: true, transport: 'http', url: `${base}/mcp`, oauth: { type: 'oauth', callbackPort: await freePort() }, readTools: ['get_record'], allowWrites: false };
  const env = { HSTACK_CREDENTIAL_BACKEND: 'plaintext', HSTACK_STATE_DIR: root };
  if(options.encrypted){
    const master=join(root,'synthetic-master-key');await writeFile(master,randomBytes(32),{mode:0o600});
    env.HSTACK_CREDENTIAL_BACKEND='keyfile';env.HSTACK_MASTER_KEY_FILE=master;
  }
  if (options.registered) {
    config.oauth = { ...config.oauth, issuer:base, clientId:'fixture-client', ...(!options.publicClient ? {clientSecretEnv:'FIXTURE_CLIENT_SECRET'} : {}) };
    if (!options.publicClient) env.FIXTURE_CLIENT_SECRET = 'synthetic-registered-secret';
    registration = { redirect_uris:[`http://127.0.0.1:${config.oauth.callbackPort}/callback`] };
  }
  if(options.cimd){
    config.oauth={...config.oauth,issuer:base,clientMetadataUrl:'https://client.fixture.invalid/oauth/client.json'};
    registration={redirect_uris:[`http://127.0.0.1:${config.oauth.callbackPort}/callback`]};
  }
  const authorize = async (url, inspect) => {
    assert.equal(url.origin, base);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), config.url);
    challenge = url.searchParams.get('code_challenge');
    authorizedScope = url.searchParams.get('scope');
    assert.ok(challenge);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    if (!options.publicClient) callback.searchParams.set('iss', base);
    if (inspect) await inspect(callback);
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.body.cancel();
  };
  return { config, env, stats, authorize, expire: () => { validAccess = 'expired'; }, revoke: () => { validAccess = 'expired'; validRefresh = 'revoked'; }, limitRefresh: () => { limitedRefresh = true; }, hangRefresh: () => { hungRefresh = true; },
    blockCalls:()=>{callGate=new Promise(resolve=>{releaseCalls=resolve;});return new Promise(resolve=>{callStarted=resolve;});},
    unblockCalls:()=>{releaseCalls?.();callGate=undefined;},
  };
}

test('native OAuth: SDK metadata + registration + PKCE callback + stored credentials + real MCP read (local fixture)', async (t) => {
  const f = await fixture(t);
  await loginOAuth(f.config, f.env, (url) => f.authorize(url, async (callback) => {
    const bad = new URL(callback); bad.searchParams.set('state', 'wrong');
    const response = await fetch(bad);
    assert.equal(response.status, 400); await response.body.cancel();
    const duplicate = new URL(callback); duplicate.searchParams.append('code', 'second-code');
    const dup = await fetch(duplicate); assert.equal(dup.status, 400); await dup.body.cancel();
  }));
  assert.equal(f.stats.exchanges, 1);
  const saved = JSON.parse(await readFile(oauthStore(f.config, f.env).path, 'utf8'));
  assert.ok(saved.tokens.issuer);
  assert.equal(saved.client.issuer, saved.tokens.issuer);
  assert.equal('verifier' in saved, false);
  const provider = await loadConnection(f.config, f.env);
  const gateway = createSocialGateway([provider], { toolMode: 'search' });
  const client = new Client({ name: 'fixture', version: '0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await gateway.connect(remote); await client.connect(local);
    assert.equal((await client.listTools()).tools.length, 2);
    const found = await client.callTool({ name: 'hstack_search_tools', arguments: { query: 'get_record' } });
    assert.match(JSON.stringify(found), /fixture__get_record/);
    const result = await client.callTool({ name: 'hstack_call_tool', arguments: { name: 'fixture__get_record', arguments: {} } });
    assert.equal(result.content[0].text, 'fixture record');
  } finally { await client.close(); await gateway.close(); await provider.close(); }
  assert.equal(f.stats.calls, 1);
});

test('native CIMD selects the HTTPS document URL, uses PKCE without DCR or a secret, and refreshes on a reused connection (fixture)',async t=>{
  const f=await fixture(t,{cimd:true,publicClient:true,resourceScopes:['accounts:read','forms:read','forms:write'],
    serverScopes:['accounts:read','forms:read','forms:write','offline_access']});
  await loginOAuth(f.config,f.env,async url=>{
    assert.equal(url.searchParams.get('client_id'),f.config.oauth.clientMetadataUrl);
    assert.deepEqual(url.searchParams.get('scope').split(' ').sort(),['accounts:read','forms:read','forms:write','offline_access']);
    await f.authorize(url);
  });
  assert.equal(f.stats.registrations,0);assert.equal(f.stats.exchanges,1);
  const saved=JSON.parse(await readFile(oauthStore(f.config,f.env).path,'utf8'));
  assert.equal(saved.client.client_id,f.config.oauth.clientMetadataUrl);assert.equal(saved.client.issuer,f.config.oauth.issuer);
  assert.equal(saved.client.client_secret,undefined);
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  f.expire();
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  assert.equal(f.stats.refreshes,1);assert.equal(f.stats.registrations,0);assert.equal(f.stats.calls,2);
});

test('explicit CIMD fails before registration or token exchange when metadata stops advertising it',async t=>{
  const f=await fixture(t,{cimd:true,publicClient:true,rejectCimd:true});
  await assert.rejects(loginOAuth(f.config,f.env,()=>assert.fail('No consent should begin')),/does not advertise Client ID Metadata Document/);
  assert.equal(f.stats.registrations,0);assert.equal(f.stats.exchanges,0);assert.equal(f.stats.calls,0);
});

test('CIMD configuration cannot silently select a second registered-client identity or secret',()=>{
  const config={id:'fixture',label:'Fixture',enabled:false,transport:'http',url:'https://fixture.invalid/mcp',
    readTools:[],allowWrites:false,oauth:{type:'oauth',issuer:'https://fixture.invalid',clientMetadataUrl:'https://client.fixture.invalid/oauth/client.json'}};
  for(const extra of [{clientId:'fixture'},{clientIdEnv:'FIXTURE_CLIENT'},{clientIdEnv:'FIXTURE_CLIENT',clientSecretEnv:'FIXTURE_SECRET'}]) {
    assert.throws(()=>parseConnections({connections:[{...config,oauth:{...config.oauth,...extra}}]}));
  }
});

test('warm native OAuth reuses one SDK handshake and catalogue for two authenticated reads',async t=>{
  const f=await fixture(t);await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  for(let i=0;i<2;i++)assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  assert.deepEqual(f.stats.mcpMethods,['initialize','notifications/initialized','tools/list','tools/call','tools/call']);
  assert.equal(f.stats.refreshes,0);assert.equal(provider.lifecycle().reconnects,0);
});

test('a reused OAuth provider forgets deleted and invalid records instead of retaining in-memory tokens',async t=>{
  const f=await fixture(t);await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const store=oauthStore(f.config,f.env),provider=new StoredOAuthProvider(f.config,store,f.env);
  await provider.load();const before=provider.credentialBinding();assert.ok(provider.tokens());
  await store.locked(AbortSignal.timeout(2000),()=>store.remove());await provider.load();
  assert.equal(provider.tokens(),undefined);assert.notEqual(provider.credentialBinding(),before);assert.throws(()=>provider.clientInformation(),/Sign in first/);
  await loginOAuth(f.config,f.env,url=>f.authorize(url));await provider.load();assert.ok(provider.tokens());
  await store.locked(AbortSignal.timeout(2000),()=>writeFile(store.path,'invalid synthetic auth record'));
  await assert.rejects(provider.load());assert.equal(provider.tokens(),undefined);
});

test('local OAuth disconnect prevents a warm client from making another authorized account call',async t=>{
  const f=await fixture(t,{stateful:true});await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  await provider.call('get_record',{},AbortSignal.timeout(2000));const registrations=f.stats.registrations;
  const store=oauthStore(f.config,f.env);await store.locked(AbortSignal.timeout(2000),()=>store.remove());
  await assert.rejects(provider.call('get_record',{},AbortSignal.timeout(2000)),e=>e.details.code==='AUTH_REQUIRED'&&e.details.outcome==='not_sent');
  assert.equal(f.stats.calls,1);assert.equal(f.stats.registrations,registrations);
});

test('a new OAuth login retires the previous stateful MCP session before calling under the new identity',async t=>{
  const f=await fixture(t,{stateful:true});await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000)))._meta.actor,1);assert.equal(f.stats.sessions,1);
  await loginOAuth(f.config,f.env,url=>f.authorize(url));
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000)))._meta.actor,2);
  assert.equal(f.stats.sessions,2);assert.equal(provider.lifecycle().reconnects,1);
});

test('own OAuth refresh keeps a warm MCP session reusable on the next operation',async t=>{
  const f=await fixture(t,{stateful:true});await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  f.expire();await provider.call('get_record',{},AbortSignal.timeout(2000));
  await provider.call('get_record',{},AbortSignal.timeout(2000));
  assert.equal(f.stats.refreshes,1);assert.equal(f.stats.calls,2);assert.equal(f.stats.sessions,1);assert.equal(provider.lifecycle().reconnects,0);
});

test('revoked refresh retires a warm OAuth session without executing an account call or exposing upstream warnings',async t=>{
  const f=await fixture(t,{stateful:true});await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());f.revoke();
  const warnings=[],original=console.warn;console.warn=(...args)=>warnings.push(args.join(' '));
  try{await assert.rejects(provider.call('get_record',{},AbortSignal.timeout(2000)),e=>e.details.code==='AUTH_REQUIRED'&&e.details.outcome==='unknown');}
  finally{console.warn=original;}
  assert.equal(f.stats.calls,0);assert.equal(f.stats.refreshes,1);assert.equal(provider.lifecycle().state,'backoff');
  assert.ok(!warnings.join('\n').includes('fixture-sensitive-never-log'));
});

test('two warm gateway processes reload rotating OAuth credentials under the shared lock before calling',async t=>{
  const f=await fixture(t,{stateful:true});await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const children=[];
  const start=()=>{
    let ready,done;const readyPromise=new Promise(resolve=>{ready=resolve;}),exitPromise=new Promise((resolveExit,reject)=>{done={resolveExit,reject};});
    const source=`import {loadConnection} from ${JSON.stringify(new URL('../dist/connections.js',import.meta.url).href)};
      const provider=await loadConnection(${JSON.stringify({...f.config,protocol:'legacy'})},process.env);
      console.log('READY');await new Promise(resolve=>process.stdin.once('data',resolve));
      try{await provider.call('get_record',{},AbortSignal.timeout(5000));console.log('DONE');}finally{await provider.close();process.stdin.destroy();}`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{HSTACK_CREDENTIAL_BACKEND: 'plaintext', HSTACK_STATE_DIR:f.env.HSTACK_STATE_DIR},stdio:['pipe','pipe','pipe']});children.push(child);
    let output='',errors='';child.stdout.on('data',part=>{output+=part;if(output.includes('READY\n'))ready();});child.stderr.on('data',part=>{errors+=part;});
    child.on('error',error=>done.reject(error));child.on('close',code=>{
      ready();try{assert.equal(code,0,errors);assert.equal(output.trim(),'READY\nDONE');done.resolveExit();}catch(error){done.reject(error);}
    });
    return{ready:readyPromise,done:exitPromise,call:()=>child.stdin.end('CALL\n')};
  };
  t.after(()=>{for(const child of children)child.kill();});
  const first=start(),second=start();await Promise.all([first.ready,second.ready]);f.expire();first.call();second.call();
  await Promise.all([first.done,second.done]);assert.equal(f.stats.refreshes,1);assert.equal(f.stats.staleRefreshes,0);assert.equal(f.stats.calls,2);
  assert.equal(f.stats.sessions,3,'The other process must replace its warm session after observing external token rotation');
});

test('cancelled OAuth lock waits cannot dispatch or poison the next warm operation',async t=>{
  const f=await fixture(t);await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  let release,locked;const ready=new Promise(resolve=>{locked=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const holder=oauthStore(f.config,f.env).locked(AbortSignal.timeout(5000),async()=>{locked();await hold;});await ready;
  const controller=new AbortController(),pending=provider.call('get_record',{},controller.signal);controller.abort();
  try{await assert.rejects(pending,e=>e.details.code==='CANCELLED'&&e.details.outcome==='not_sent');assert.equal(f.stats.calls,0);}
  finally{release();await holder;}
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
});

test('the shared OAuth credential lock remains held through the account response before disconnect can finish',async t=>{
  const f=await fixture(t);await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  const started=f.blockCalls(),pending=provider.call('get_record',{},AbortSignal.timeout(5000));await started;
  let disconnected=false;const store=oauthStore(f.config,f.env),disconnect=store.locked(AbortSignal.timeout(5000),async()=>{await store.remove();disconnected=true;});
  assert.equal((await stat(store.lockPath)).isDirectory(),true,'The credential lock must remain owned while the account response is pending');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(disconnected,false);
  f.unblockCalls();await pending;await disconnect;assert.equal(disconnected,true);
  await assert.rejects(provider.call('get_record',{},AbortSignal.timeout(2000)),e=>e.details.code==='AUTH_REQUIRED'&&e.details.outcome==='not_sent');
  assert.equal(f.stats.calls,1);
});

test('background startup never launches sign-in and produces actionable AUTH_REQUIRED', async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadConnection(f.config, f.env), (error) => error.details.code === 'AUTH_REQUIRED' && /login/.test(error.message));
  assert.equal(f.stats.exchanges, 0);
  assert.equal(f.stats.registrations, 0, 'Unattended startup must not create a remote OAuth client before asking for login');
});

test('registered confidential PKCE uses advertised Basic authentication and refreshes without DCR (Pipedrive-shaped fixture)',async(t)=>{
  const f=await fixture(t,{registered:true,registeredAuthMethod:'client_secret_basic'});
  await loginOAuth(f.config,f.env,(url)=>f.authorize(url));
  assert.equal(f.stats.registrations,0);assert.equal(f.stats.exchanges,1);
  const saved=JSON.parse(await readFile(oauthStore(f.config,f.env).path,'utf8'));
  assert.equal(saved.client,undefined);assert.doesNotMatch(JSON.stringify(saved),/synthetic-registered-secret/);
  f.expire();const provider=await loadConnection(f.config,f.env);
  try{assert.equal((await provider.call('get_record',{},AbortSignal.timeout(5000))).content[0].text,'fixture record');}
  finally{await provider.close();}
  assert.equal(f.stats.refreshes,1);assert.equal(f.stats.registrations,0);
});

test('registered confidential PKCE uses default Basic and refreshes when metadata omits authentication methods (Docusign-demo-shaped fixture)',async(t)=>{
  const f=await fixture(t,{registered:true,registeredAuthMethod:'client_secret_basic',omitAuthMethods:true});
  f.config.oauth.scope='records:read';
  await loginOAuth(f.config,f.env,url=>f.authorize(url));f.expire();
  const provider=await loadConnection(f.config,f.env);
  try{assert.equal((await provider.call('get_record',{},AbortSignal.timeout(5000))).content[0].text,'fixture record');}
  finally{await provider.close();}
  assert.equal(f.stats.exchanges,1);assert.equal(f.stats.refreshes,1);assert.equal(f.stats.registrations,0);
});

test('metadata issuer mismatch reports an upstream compatibility problem before login/registration/token exchange without reflecting issuer values',async(t)=>{
  const f=await fixture(t,{registered:true,metadataIssuerMismatch:true});
  const verify=error=>error.details.code==='UNAVAILABLE'&&/issuer metadata/i.test(error.message)
    &&!JSON.stringify(error).includes('synthetic-private-issuer');
  await assert.rejects(loginOAuth(f.config,f.env,()=>assert.fail('Untrusted metadata must not reach browser consent')),verify);
  await assert.rejects(loadConnection(f.config,f.env),verify);
  assert.equal(f.stats.registrations,0);assert.equal(f.stats.exchanges,0);assert.equal(f.stats.calls,0);
});

test('native public-client DCR rejection is reported without silently claiming confidential web-client capability',async(t)=>{
  const f=await fixture(t,{dcrMethod:'client_secret_basic'});
  await assert.rejects(loginOAuth(f.config,f.env,()=>assert.fail('Rejected registration must not open authorization')),
    error=>error.details.code==='AUTH_REQUIRED');
  assert.equal(f.stats.registrations,1);assert.equal(f.stats.exchanges,0);
});

for(const method of ['client_secret_post','client_secret_basic'])test(`explicit SDK DCR ${method} persists the issued secret privately and refreshes without changing the method (fixture)`,async t=>{
  const f=await fixture(t,{dcrMethod:method});f.config.oauth.dcrAuthMethod=method;
  await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const saved=JSON.parse(await readFile(oauthStore(f.config,f.env).path,'utf8'));
  assert.equal(saved.client.token_endpoint_auth_method,method);assert.equal(saved.client.client_secret,'synthetic-dcr-secret');
  assert.equal((await stat(oauthStore(f.config,f.env).path)).mode&0o777,0o600);
  f.expire();const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  assert.equal(f.stats.registrations,1);assert.equal(f.stats.refreshes,1);assert.equal(f.stats.exchanges,1);
});

test('an explicit unadvertised DCR method fails before registration, consent or token exchange',async t=>{
  const f=await fixture(t,{dcrMethod:'client_secret_basic'});f.config.oauth.dcrAuthMethod='client_secret_post';
  await assert.rejects(loginOAuth(f.config,f.env,()=>assert.fail('No authorization before method review')),/does not advertise dynamic registration/);
  assert.equal(f.stats.registrations,0);assert.equal(f.stats.exchanges,0);assert.equal(f.stats.calls,0);
});

test('explicit secret-auth DCR rejects a missing secret or method downgrade before consent and rejects corrupt saved registration',async t=>{
  for(const options of [{omitDcrSecret:true},{dcrReturnedMethod:'none'}]){
    const f=await fixture(t,{dcrMethod:'client_secret_post',...options});f.config.oauth.dcrAuthMethod='client_secret_post';
    await assert.rejects(loginOAuth(f.config,f.env,()=>assert.fail('No consent with incomplete registration')),/explicitly requested authentication method/);
    assert.equal(f.stats.registrations,1);assert.equal(f.stats.exchanges,0);
  }
  const f=await fixture(t,{dcrMethod:'client_secret_post'});f.config.oauth.dcrAuthMethod='client_secret_post';
  await loginOAuth(f.config,f.env,url=>f.authorize(url));const store=oauthStore(f.config,f.env);
  const saved=JSON.parse(await readFile(store.path,'utf8'));delete saved.client.client_secret;
  await store.locked(AbortSignal.timeout(2000),()=>store.write(saved));
  await assert.rejects(new StoredOAuthProvider(f.config,store,f.env).load(),/Stored OAuth credentials are invalid/);
});

test('DCR authentication selection is exclusive and identity-bound while the default registration identity remains unchanged',()=>{
  const config={id:'fixture',label:'Fixture',enabled:false,transport:'http',url:'https://fixture.invalid/mcp',readTools:[],allowWrites:false,oauth:{type:'oauth'}};
  const original=oauthStore(config,{}).path;
  const post={...config,oauth:{...config.oauth,dcrAuthMethod:'client_secret_post'}};
  const basic={...config,oauth:{...config.oauth,dcrAuthMethod:'client_secret_basic'}};
  assert.notEqual(oauthStore(post,{}).path,original);assert.notEqual(oauthStore(post,{}).path,oauthStore(basic,{}).path);
  assert.equal(oauthStore({...config,oauth:{type:'oauth',dcrAuthMethod:undefined}},{}).path,original);
  for(const extra of [{dcrAuthMethod:'private_key_jwt'},{clientId:'fixture',issuer:'https://fixture.invalid'},
    {clientIdEnv:'FIXTURE_CLIENT',issuer:'https://fixture.invalid'},{clientMetadataUrl:'https://client.invalid/oauth/client.json'}]){
    assert.throws(()=>parseConnections({connections:[{...post,oauth:{...post.oauth,...extra}}]}));
  }
  assert.equal(parseConnections({connections:[post]})[0].oauth.dcrAuthMethod,'client_secret_post');
});

test('registered OAuth from private environment refs logs in and refreshes without DCR, using advertised post authentication', async (t) => {
  const f = await fixture(t,{ registered:true, resourceScopes:['mcp'], serverScopes:['mcp','employees','offline_access'] });
  const config = { ...f.config, url:undefined, urlEnv:'FIXTURE_ENDPOINT', oauth:{ ...f.config.oauth,
    clientId:undefined, issuer:undefined, clientIdEnv:'FIXTURE_CLIENT_ID', issuerEnv:'FIXTURE_ISSUER', scopeEnv:'FIXTURE_SCOPE' } };
  const original=JSON.stringify(config);
  const env={ ...f.env, FIXTURE_ENDPOINT:f.config.url, FIXTURE_CLIENT_ID:'fixture-client', FIXTURE_ISSUER:f.config.oauth.issuer,
    FIXTURE_SCOPE:'mcp employees offline_access' };
  const resolved=resolveConnection(config,env);
  await loginOAuth(resolved,env,async(url)=>{
    assert.equal(url.searchParams.get('scope'),'mcp employees offline_access','Explicit requested scopes must survive a narrower PRM default');
    await f.authorize(url);
  });
  assert.equal(f.stats.exchanges,1); assert.equal(f.stats.registrations,0);
  const saved=await readFile(oauthStore(resolved,env).path,'utf8');
  assert.doesNotMatch(saved,/synthetic-registered-secret|FIXTURE_CLIENT_SECRET/);
  f.expire();
  const provider=await loadConnection(config,env);
  try {
    const result=await provider.call('get_record',{},AbortSignal.timeout(5000));
    assert.equal(result.content[0].text,'fixture record');
  } finally { await provider.close(); }
  assert.equal(f.stats.refreshes,1); assert.equal(f.stats.registrations,0); assert.equal(f.stats.calls,1);
  assert.equal(JSON.parse(await readFile(oauthStore(resolved,env).path,'utf8')).tokens.scope,'mcp employees offline_access');
  assert.equal(JSON.stringify(config),original);
});

test('registered PKCE with empty advertised scopes uses secret-post, preserves installation-selected permissions and refreshes without DCR (HubSpot-shaped fixture)',async t=>{
  const f=await fixture(t,{registered:true,resourceScopes:[],serverScopes:[]});
  await loginOAuth(f.config,f.env,async url=>{
    assert.equal(url.searchParams.has('scope'),false,'No invented OAuth scope for installation-selected permissions');
    await f.authorize(url);
  });
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  f.expire();assert.equal((await provider.call('get_record',{},AbortSignal.timeout(2000))).content[0].text,'fixture record');
  assert.equal(f.stats.refreshes,1);assert.equal(f.stats.registrations,0);assert.equal(f.stats.calls,2);
  const saved=JSON.parse(await readFile(oauthStore(f.config,f.env).path,'utf8'));
  assert.equal(saved.tokens.scope,undefined);assert.equal(saved.client,undefined);assert.doesNotMatch(JSON.stringify(saved),/synthetic-registered-secret/);
});

test('SDK adds advertised offline_access for refresh when no explicit scope is configured',async(t)=>{
  const f=await fixture(t,{ serverScopes:['records:read','offline_access'] });
  await loginOAuth(f.config,f.env,async(url)=>{
    assert.deepEqual(url.searchParams.get('scope').split(' ').sort(),['offline_access','records:read']);
    await f.authorize(url);
  });
  assert.equal(f.stats.exchanges,1);
});

test('registered public PKCE works without a client secret or DCR despite metadata listing confidential methods (Xero-shaped fixture)',async(t)=>{
  const f=await fixture(t,{registered:true,publicClient:true,resourceScopes:['openid','offline_access','records:read','records:write']});
  f.config.oauth.scope='openid offline_access records:read';
  await loginOAuth(f.config,f.env,async(url)=>{
    assert.equal(url.searchParams.get('scope'),'openid offline_access records:read');
    await f.authorize(url);
  });
  assert.equal(f.stats.exchanges,1);assert.equal(f.stats.registrations,0);
  f.expire();
  const provider=await loadConnection(f.config,f.env);
  try { assert.equal((await provider.call('get_record',{},AbortSignal.timeout(5000))).content[0].text,'fixture record'); }
  finally { await provider.close(); }
  assert.equal(f.stats.refreshes,1);assert.equal(f.stats.calls,1);assert.equal(f.stats.registrations,0);
  const saved=JSON.parse(await readFile(oauthStore(f.config,f.env).path,'utf8'));
  assert.equal(saved.tokens.scope,'openid offline_access records:read');
  assert.equal(saved.client,undefined,'Registered public client must not acquire DCR identity');
});

test('unresolved registration references cannot silently become a dynamic-registration request or a different credential key',async(t)=>{
  const f=await fixture(t);
  const config={ ...f.config,oauth:{ ...f.config.oauth,clientIdEnv:'FIXTURE_MISSING_CLIENT',issuerEnv:'FIXTURE_MISSING_ISSUER' } };
  assert.throws(()=>oauthStore(config,f.env),/Resolve OAuth registration/);
  assert.throws(()=>new StoredOAuthProvider(config,oauthStore(f.config,f.env),f.env),/Resolve OAuth registration/);
  await assert.rejects(loginOAuth(config,f.env,async()=>assert.fail('No authorization should begin')),/Resolve OAuth registration/);
  assert.equal(f.stats.registrations,0); assert.equal(f.stats.exchanges,0);
});

test('two separate gateway processes serialize refresh-token rotation without stale refresh reuse', async (t) => {
  const f = await fixture(t);
  await loginOAuth(f.config, f.env, (url) => f.authorize(url));
  f.expire();
  const run = () => new Promise((resolveRun, reject) => {
    const source = `import {loadConnection} from ${JSON.stringify(new URL('../dist/connections.js', import.meta.url).href)}; const p=await loadConnection(${JSON.stringify(f.config)},process.env); await p.close(); console.log(p.tools.length);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { HSTACK_CREDENTIAL_BACKEND: 'plaintext', HSTACK_STATE_DIR: f.env.HSTACK_STATE_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { errors += part; });
    child.on('error', reject); child.on('close', (code) => {
      assert.equal(code, 0, errors); assert.equal(output.trim(), '1'); resolveRun();
    });
  });
  await Promise.all([run(), run()]);
  assert.equal(f.stats.refreshes, 1);
  assert.equal(f.stats.staleRefreshes, 0);
});

test('revoked refresh token requires explicit login without exposing upstream error bodies', async (t) => {
  const f = await fixture(t);
  await loginOAuth(f.config, f.env, (url) => f.authorize(url));
  f.revoke();
  const warnings = [], original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try { await assert.rejects(loadConnection(f.config, f.env), (error) => error.details.code === 'AUTH_REQUIRED' && !/fixture-sensitive|fixture-refresh/.test(error.message)); }
  finally { console.warn = original; }
  assert.ok(warnings.length > 0, 'Exercise the SDK warning path');
  assert.ok(!warnings.join('\n').includes('fixture-sensitive-never-log'));
});

test('OAuth callback issuer missing or mismatched is rejected before exchanging the code', async (t) => {
  for (const issuer of [undefined, 'https://wrong-issuer.example.invalid']) {
    const f = await fixture(t);
    await assert.rejects(loginOAuth(f.config, f.env, (url) => f.authorize(url, async (callback) => {
      if (issuer === undefined) callback.searchParams.delete('iss'); else callback.searchParams.set('iss', issuer);
    })), (error) => error.details.code === 'AUTH_REQUIRED');
    assert.equal(f.stats.exchanges, 0);
  }
});

test('OAuth authorization-server quota retains typed retry/window details instead of becoming a login failure', async (t) => {
  const f = await fixture(t);
  await loginOAuth(f.config, f.env, (url) => f.authorize(url));
  f.expire(); f.limitRefresh();
  await assert.rejects(loadConnection(f.config, f.env), (error) => error.details.code === 'RATE_LIMITED'
    && error.details.retryAfterSeconds === 17 && error.details.windowSeconds === 86400 && !error.message.includes('fixture-sensitive'));
  assert.equal(f.stats.refreshes, 1);
});

test('a deadline during OAuth refresh remains TIMEOUT rather than a misleading sign-in failure', async (t) => {
  const f = await fixture(t);
  await loginOAuth(f.config, f.env, (url) => f.authorize(url));
  f.expire(); f.hangRefresh();
  const controller = new AbortController();
  const warnings = [], prior = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const pending = loadConnection(f.config, f.env, controller.signal).then(() => undefined, (error) => error);
    for (let i = 0; i < 400 && f.stats.refreshes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new DOMException('fixture deadline', 'TimeoutError'));
    const error = await pending;
    assert.equal(f.stats.refreshes, 1);
    assert.equal(error?.details.code, 'TIMEOUT');
    assert.ok(!warnings.join('\n').includes('fixture-sensitive-never-log'));
  } finally { console.warn = prior; controller.abort(); }
});

test('OAuth denial, timeout and occupied callback port clean up listener and credential lock', async (t) => {
  const f = await fixture(t);
  await assert.rejects(loginOAuth(f.config, f.env, async (url) => {
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
    const response = await fetch(callback); assert.equal(response.status, 400); await response.body.cancel();
  }), /denied/);
  await assert.rejects(loginOAuth(f.config, f.env, async () => {}, AbortSignal.timeout(100)), (error) => error.details.code === 'TIMEOUT');
  const occupied = createServer(); await new Promise((r) => occupied.listen(f.config.oauth.callbackPort, '127.0.0.1', r));
  try { await assert.rejects(loginOAuth(f.config, f.env, async () => {}), /sign-in failed/); }
  finally { await new Promise((r) => occupied.close(r)); }
  await loginOAuth(f.config, f.env, (url) => f.authorize(url));
});

test('issuer changes and insecure OAuth endpoints are rejected', async (t) => {
  const f = await fixture(t);
  const store = oauthStore(f.config, f.env);
  assert.equal(store.path, oauthStore({ ...f.config, oauth: { callbackPort: f.config.oauth.callbackPort, type: 'oauth' } }, f.env).path);
  const config = { ...f.config, oauth: { ...f.config.oauth, issuer: 'https://issuer.example.invalid' } };
  const provider = new StoredOAuthProvider(config, store, f.env);
  assert.throws(() => provider.saveDiscoveryState({ authorizationServerUrl: 'https://other.example.invalid', authorizationServerMetadata: { issuer: 'https://other.example.invalid' } }), /issuer/);
  const unbound = new StoredOAuthProvider(f.config, store, f.env);
  assert.throws(() => unbound.saveDiscoveryState({ authorizationServerUrl: 'https://expected.example.invalid', authorizationServerMetadata: { issuer: 'https://wrong.example.invalid' } }), /issuer/);
  await assert.rejects(unbound.saveTokens({ access_token: 'fixture', token_type: 'Bearer' }), /issuer/);
  await assert.rejects(oauthFetch({ ...f.config, url: 'https://example.invalid/mcp' }, AbortSignal.timeout(1000))('http://127.0.0.1:9/token'), /HTTPS/);
  for (const oauth of [{ type: 'oauth', clientId: 'registered-with-no-issuer' }, { type: 'oauth', clientSecretEnv: 'secret-value' }, { type: 'oauth', callbackPort: 80 }, { type: 'oauth', clientMetadataUrl: 'https://example.invalid' }, { type: 'oauth', clientSecret: 'literal' }]) {
    assert.throws(() => parseConnections({ connections: [{ ...f.config, oauth }] }));
  }
  assert.throws(() => parseConnections({ connections: [{ ...f.config, headers: { Authorization: { env: 'FIXTURE_KEY' } } }] }));
  assert.equal(parseConnections({ connections: [f.config] })[0].oauth.type, 'oauth');
});


test('encrypted OAuth supports refresh, revocation, explicit reauthentication and local disconnect', async t => {
  const f=await fixture(t,{stateful:true,encrypted:true});
  await loginOAuth(f.config,f.env,url=>f.authorize(url));
  const provider=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>provider.close());
  const store=oauthStore(f.config,f.env);
  const disk=await readFile(store.path,'utf8');
  assert.equal(JSON.parse(disk).hstackVault,1);assert.ok(!disk.includes('fixture-refresh'));
  f.expire();await provider.call('get_record',{},AbortSignal.timeout(3000));
  assert.equal(f.stats.refreshes,1);
  f.revoke();await assert.rejects(provider.call('get_record',{},AbortSignal.timeout(3000)),e=>e.details.code==='AUTH_REQUIRED');
  await loginOAuth(f.config,f.env,url=>f.authorize(url));
  // A new explicit connection observes the renewed encrypted grant.
  const renewed=await loadConnection({...f.config,protocol:'legacy'},f.env);t.after(()=>renewed.close());
  await renewed.call('get_record',{},AbortSignal.timeout(3000));
  await store.locked(AbortSignal.timeout(1000),()=>store.remove());
  await assert.rejects(renewed.call('get_record',{},AbortSignal.timeout(3000)),e=>e.details.code==='AUTH_REQUIRED');
});
