import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { RemoteConnection } from '../dist/remote-connection.js';
import { loadConnection } from '../dist/connections.js';
import { loadProvider, socialProviders } from '../dist/providers.js';

const tool={name:'read_record',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']},
  outputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}};
const signal=()=>AbortSignal.timeout(2000);

test('reused OAuth cannot be configured without the shared credential guard and binding',()=>{
  assert.throws(()=>new RemoteConnection({endpoint:new URL('https://fixture.invalid/mcp'),label:'Fixture',headers:{},
    authProvider:{redirectUrl:'http://127.0.0.1:8678/callback',clientMetadata:{redirect_uris:[]},clientInformation:()=>undefined,
      tokens:()=>undefined,saveTokens:async()=>{},redirectToAuthorization:async()=>{},saveCodeVerifier:()=>{},codeVerifier:()=>''},
  }),/locked operation, credential binding/);
});
function fixture(t,settings={}){
  const seen={initializations:0,lists:0,calls:0,methods:[],headers:[]};
  const state={tools:[tool],status:200,fail:false,reply:undefined};
  const fetchImpl=async(url,init)=>{
    assert.equal(String(url),'https://fixture.invalid/mcp');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
    assert.ok(init.signal instanceof AbortSignal);
    const request=JSON.parse(init.body);seen.methods.push(request.method);
    if(request.method==='initialize'){
      seen.initializations++;
      return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'0'}}});
    }
    if(request.method==='notifications/initialized')return new Response(null,{status:204});
    if(request.method==='tools/list'){
      seen.lists++;seen.headers.push({method:request.method,authorization:new Headers(init.headers).get('authorization')});
      return Response.json({jsonrpc:'2.0',id:request.id,result:{tools:state.tools}});
    }
    assert.equal(request.method,'tools/call');seen.calls++;
    seen.headers.push({method:request.method,authorization:new Headers(init.headers).get('authorization')});
    if(state.fail)throw new Error('private-network-error');
    if(state.reply)return state.reply(request,init);
    if(state.status!==200)return new Response('private-upstream-error',{status:state.status,headers:{'Retry-After':'7',
      ...(state.status===429?{'RateLimit':'"requests"; r=0','RateLimit-Policy':'"requests"; q=10; w=60'}:{})}});
    return Response.json({jsonrpc:'2.0',id:request.id,result:{content:[],structuredContent:{value:request.params.arguments.id}}});
  };
  const remote=new RemoteConnection({endpoint:new URL('https://fixture.invalid/mcp'),label:'Fixture',headers:{},protocol:'legacy',fetch:fetchImpl,...settings.config},settings.options);
  t.after(()=>remote.close());return{remote,state,seen,fetchImpl};
}

test('persistent HTTP reuses one real SDK handshake and catalogue across multiple tool calls',async t=>{
  const{remote,seen}=fixture(t);assert.deepEqual(await remote.discover(),[tool]);
  for(const id of ['first','second'])assert.deepEqual((await remote.call('read_record',{id},signal())).structuredContent,{value:id});
  assert.deepEqual(seen.methods,['initialize','notifications/initialized','tools/list','tools/call','tools/call']);
  assert.equal(remote.status().state,'ready');assert.equal(remote.status().reconnects,0);
});

test('a completed startup deadline cannot poison later calls on a reused HTTP client',async t=>{
  const{remote,seen}=fixture(t),startup=new AbortController();await remote.discover(startup.signal);
  startup.abort(new DOMException('expired startup','TimeoutError'));
  assert.deepEqual((await remote.call('read_record',{id:'later'},signal())).structuredContent,{value:'later'});
  assert.equal(seen.initializations,1);
});

test('dynamic native credentials attach to the correct call only, including when calls queue concurrently',async t=>{
  let tokens=0;
  const{remote,seen}=fixture(t,{config:{headersForCall:async()=>({Authorization:`Bearer synthetic-${++tokens}`})}});
  await remote.discover();
  await Promise.all(['a','b'].map(id=>remote.call('read_record',{id},signal())));
  assert.deepEqual(seen.headers,[{method:'tools/list',authorization:null},{method:'tools/call',authorization:'Bearer synthetic-1'},
    {method:'tools/call',authorization:'Bearer synthetic-2'}]);
  assert.equal(seen.initializations,1);
});

test('invalid and unknown tools fail before credential loading or HTTP dispatch',async t=>{
  let credentials=0;const{remote,seen}=fixture(t,{config:{headersForCall:async()=>{credentials++;return{};}}});await remote.discover();
  await assert.rejects(remote.call('missing',{},signal()),e=>e.details.outcome==='not_sent');
  await assert.rejects(remote.call('read_record',{},signal()),e=>e.details.outcome==='not_sent');
  assert.equal(credentials,0);assert.equal(seen.calls,0);
});

test('cancelled queue entries cannot start, refresh credentials or poison the next call',async t=>{
  let release,started;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  let credentials=0;const{remote,seen,state}=fixture(t,{config:{headersForCall:async()=>{credentials++;return{};}}});await remote.discover();
  state.reply=async(request)=>{if(request.params.arguments.id==='first'){started();await gate;}
    return Response.json({jsonrpc:'2.0',id:request.id,result:{content:[],structuredContent:{value:request.params.arguments.id}}});};
  const first=remote.call('read_record',{id:'first'},signal());await ready;
  const cancelled=new AbortController(),queued=remote.call('read_record',{id:'never'},cancelled.signal);cancelled.abort();
  await assert.rejects(queued,e=>e.details.code==='CANCELLED'&&e.details.outcome==='not_sent');
  const next=remote.call('read_record',{id:'next'},signal());release();await first;
  assert.deepEqual((await next).structuredContent,{value:'next'});assert.equal(credentials,2);assert.equal(seen.calls,2);assert.equal(seen.initializations,1);
});

test('network failure is never replayed; a later explicit request reconnects after bounded backoff',async t=>{
  let now=0;const{remote,seen,state}=fixture(t,{options:{now:()=>now,backoffMs:100}});await remote.discover();state.fail=true;
  await assert.rejects(remote.call('read_record',{id:'failed'},signal()),e=>e.details.outcome==='unknown'&&!e.message.includes('private-network-error'));
  assert.equal(seen.calls,1);assert.equal(remote.status().state,'backoff');
  await assert.rejects(remote.call('read_record',{id:'too-soon'},signal()),e=>e.details.code==='UNAVAILABLE'&&e.details.outcome==='not_sent');
  assert.equal(seen.calls,1);state.fail=false;now=101;
  assert.deepEqual((await remote.call('read_record',{id:'explicit-retry'},signal())).structuredContent,{value:'explicit-retry'});
  assert.equal(seen.calls,2);assert.equal(seen.initializations,2);assert.equal(seen.lists,2);assert.equal(remote.status().reconnects,1);
});

test('reconnect verifies the whole catalogue and requires restart before a changed schema can be called',async t=>{
  const{remote,seen,state}=fixture(t,{options:{backoffMs:0}});await remote.discover();state.fail=true;
  await assert.rejects(remote.call('read_record',{id:'first'},signal()));state.fail=false;
  state.tools=[{...tool,inputSchema:{...tool.inputSchema,required:['id','newPermission']}}];
  await assert.rejects(remote.call('read_record',{id:'must-not-send'},signal()),e=>e.details.code==='UNAVAILABLE'
    &&e.details.outcome==='not_sent'&&e.details.recovery==='restart_hstack');
  assert.equal(seen.calls,1);assert.equal(remote.status().state,'catalogue_changed');
  state.tools=[tool];await assert.rejects(remote.call('read_record',{id:'still-blocked'},signal()));assert.equal(seen.calls,1);
});

test('a transport reconnect does not treat JSON object key reordering as a catalogue change',async t=>{
  const{remote,state}=fixture(t,{options:{backoffMs:0}});await remote.discover();state.fail=true;
  await assert.rejects(remote.call('read_record',{id:'first'},signal()));state.fail=false;
  state.tools=[{outputSchema:tool.outputSchema,inputSchema:tool.inputSchema,name:tool.name}];
  assert.equal((await remote.call('read_record',{id:'same-schema'},signal())).structuredContent.value,'same-schema');
});

test('HTTP auth and rate-limit failures are safe, not replayed and do not discard a healthy client',async t=>{
  for(const[status,code]of[[401,'AUTH_REQUIRED'],[403,'FORBIDDEN'],[429,'RATE_LIMITED']]){
    let now=0;const{remote,state,seen}=fixture(t,{options:{now:()=>now}});await remote.discover();state.status=status;
    await assert.rejects(remote.call('read_record',{id:'failed'},signal()),e=>e.details.code===code&&e.details.outcome==='unknown'
      &&!e.message.includes('private-upstream-error')&&(status!==429||e.details.retryAfterSeconds===7));
    assert.equal(seen.calls,1);state.status=200;now=8000;
    assert.equal((await remote.call('read_record',{id:'new-request'},signal())).structuredContent.value,'new-request');assert.equal(seen.initializations,1);
  }
});

test('a rate-limited request also stops already-queued calls before credentials or dispatch',async t=>{
  let now=0,credentials=0;const{remote,state,seen}=fixture(t,{options:{now:()=>now},config:{headersForCall:async()=>{credentials++;return{};}}});
  await remote.discover();state.status=429;
  const first=remote.call('read_record',{id:'limited'},signal()),queued=remote.call('read_record',{id:'must-not-send'},signal());
  await assert.rejects(first,e=>e.details.code==='RATE_LIMITED'&&e.details.outcome==='unknown');
  await assert.rejects(queued,e=>e.details.code==='RATE_LIMITED'&&e.details.outcome==='not_sent'&&e.details.retryAfterSeconds===7);
  assert.equal(seen.calls,1);assert.equal(credentials,1);state.status=200;now=8000;
  assert.equal((await remote.call('read_record',{id:'after-cooldown'},signal())).structuredContent.value,'after-cooldown');
  assert.equal(seen.initializations,1);assert.equal(seen.calls,2);
});

test('cached cooldown failures preserve the identified window and never extend its reset time',async t=>{
  let now=0;const{remote,state,seen}=fixture(t,{options:{now:()=>now}});await remote.discover();state.status=429;
  await assert.rejects(remote.call('read_record',{id:'limited'},signal()),e=>e.details.windowSeconds===60);
  now=6999;
  await assert.rejects(remote.call('read_record',{id:'cached'},signal()),e=>e.details.code==='RATE_LIMITED'&&e.details.windowSeconds===60
    &&e.details.retryAfterSeconds===1&&e.details.outcome==='not_sent');
  state.status=200;now=7000;
  assert.equal((await remote.call('read_record',{id:'at-reset'},signal())).structuredContent.value,'at-reset');
  assert.equal(seen.calls,2);assert.equal(seen.initializations,1);
});

test('credential failure before dispatch keeps the connection reusable without replay or reconnect',async t=>{
  let denied=true;const{remote,seen}=fixture(t,{config:{headersForCall:async()=>{if(denied)throw new Error('private-credential-error');return{};}}});
  await remote.discover();await assert.rejects(remote.call('read_record',{id:'first'},signal()),e=>e.details.outcome==='not_sent'&&!e.message.includes('private-credential-error'));
  denied=false;assert.equal((await remote.call('read_record',{id:'second'},signal())).structuredContent.value,'second');assert.equal(seen.initializations,1);assert.equal(seen.calls,1);
});

test('close aborts in-flight I/O, drains ownership and blocks subsequent operations',async t=>{
  const{remote,seen,state}=fixture(t);await remote.discover();let started;const ready=new Promise(resolve=>{started=resolve;});
  state.reply=(_request,init)=>{started();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));};
  const pending=remote.call('read_record',{id:'in-flight'},signal());await ready;const close=remote.close();
  await assert.rejects(pending,e=>e.details.code==='UNAVAILABLE'&&e.details.outcome==='unknown');await close;
  await assert.rejects(remote.call('read_record',{id:'after-close'},signal()),e=>e.details.code==='UNAVAILABLE'&&e.details.outcome==='not_sent');
  assert.equal(seen.calls,1);assert.equal(remote.status().state,'closed');
});

test('late cancellation has unknown outcome and a new request recovers without reusing its aborted deadline',async t=>{
  const{remote,state,seen}=fixture(t,{options:{backoffMs:0}});await remote.discover();let started;const ready=new Promise(resolve=>{started=resolve;});
  state.reply=(_request,init)=>{started();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));};
  const controller=new AbortController(),pending=remote.call('read_record',{id:'cancel'},controller.signal);await ready;controller.abort();
  await assert.rejects(pending,e=>e.details.code==='CANCELLED'&&e.details.outcome==='unknown');state.reply=undefined;
  assert.equal((await remote.call('read_record',{id:'fresh'},signal())).structuredContent.value,'fresh');assert.equal(seen.calls,2);assert.equal(seen.initializations,2);
});

test('modern persistent HTTP preserves official SDK parameter-header mirroring without repeated discovery',async t=>{
  const modern={name:'read_record',inputSchema:{type:'object',properties:{id:{type:'string','x-mcp-header':'record-id'}},required:['id']}};
  let calls=0,discoveries=0;
  const handler=createMcpHandler(()=>{
    const server=new Server({name:'modern-fixture',version:'0'},{capabilities:{tools:{}}});
    server.setRequestHandler('tools/list',()=>{discoveries++;return{tools:[modern]};});
    server.setRequestHandler('tools/call',()=>{calls++;return{content:[]};});return server;
  },{legacy:'reject'});
  const remote=new RemoteConnection({endpoint:new URL('https://fixture.invalid/mcp'),label:'Modern',headers:{},protocol:'2026-07-28',fetch:async(url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='tools/call')assert.equal(new Headers(init.headers).get('Mcp-Param-record-id'),request.params.arguments.id);
    return handler.fetch(new Request(url,init));
  }});t.after(async()=>{await remote.close();await handler.close();});
  await remote.discover();await remote.call('read_record',{id:'first'},signal());await remote.call('read_record',{id:'second'},signal());
  assert.equal(calls,2);assert.equal(discoveries,1);
});

for(const kind of ['social','configured'])test(`${kind} provider wiring shares HTTP setup across calls and owns shutdown`,async t=>{
  const{fetchImpl,seen}=fixture(t),original=globalThis.fetch;globalThis.fetch=fetchImpl;
  let provider;
  try{
    provider=kind==='social'?await loadProvider({...socialProviders[0],endpoint:'https://fixture.invalid/mcp'},'synthetic-key')
      :await loadConnection({id:'fixture',label:'Fixture',enabled:true,transport:'http',url:'https://fixture.invalid/mcp',protocol:'legacy',
        headers:{Authorization:{env:'FIXTURE_KEY',prefix:'Bearer '}},readTools:['read_record'],allowWrites:false},{FIXTURE_KEY:'synthetic-key'});
    await provider.call('read_record',{id:'first'},signal());await provider.call('read_record',{id:'second'},signal());
    assert.equal(seen.initializations,1);assert.equal(seen.calls,2);assert.equal(provider.lifecycle().state,'ready');
    await provider.close();assert.equal(provider.lifecycle().state,'closed');
    await assert.rejects(provider.call('read_record',{id:'closed'},signal()),e=>e.details.code==='UNAVAILABLE'&&e.details.outcome==='not_sent');
  }finally{try{await provider?.close();}finally{globalThis.fetch=original;}}
});


test('HTTP request bursts are bounded before dispatch and capacity recovers', async t => {
  const {remote,seen}=fixture(t);await remote.discover();
  const results=await Promise.allSettled(Array.from({length:65},(_,id)=>remote.call('read_record',{id:String(id)},AbortSignal.timeout(10_000))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,64);
  const rejected=results.filter(r=>r.status==='rejected');assert.equal(rejected.length,1);
  assert.equal(rejected[0].reason.details.outcome,'not_sent');assert.equal(seen.calls,64);
  await remote.call('read_record',{id:'after-drain'},signal());assert.equal(seen.calls,65);
});
