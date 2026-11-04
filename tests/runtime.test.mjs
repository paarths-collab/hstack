import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DiscoveryError, exhaustedWindow, retryAfterSeconds } from '../dist/errors.js';
import { GatewayRuntime } from '../dist/runtime.js';
import { createSocialGateway } from '../dist/gateway.js';

const schema={type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false};
function provider(id,call) {return {id,label:id,readTools:new Set(['get_record']),allowWrites:false,
 tools:[{name:'get_record',description:'Read a record by id',inputSchema:schema},{name:'delete_record',description:'Delete a record',inputSchema:schema}],call};}
async function connect(t,providers,options={}) {
 const server=createSocialGateway(providers,options),client=new Client({name:'fixture',version:'0'});
 const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});return client;
}
const result={content:[{type:'text',text:'synthetic record'}]};

test('Retry-After accepts delta seconds and HTTP dates without accepting arbitrary date-like strings',()=>{
 assert.equal(retryAfterSeconds('120'),120);
 assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT',Date.parse('2026-10-21T07:27:00Z')),60);
 assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT',Date.parse('2026-10-21T07:29:00Z')),0);
 for(const value of [null,'','-5','1.5','tomorrow','999999999999999999999'])assert.equal(retryAfterSeconds(value),undefined);
});

test('window identification uses matching exhausted policies, not remaining reset-time guesses',()=>{
 const headers=new Headers({'RateLimit':'"daily"; r=0; t=120, "monthly"; r=40; t=500',
 'RateLimit-Policy':'"daily"; q=250; w=86400, "monthly"; q=3000; w=2592000'});
 assert.equal(exhaustedWindow(headers),86400);
 assert.equal(exhaustedWindow(new Headers({'Retry-After':'120'})),undefined);
 headers.set('RateLimit','"daily";r=0;t=120,"monthly";r=0;t=500');
 assert.equal(exhaustedWindow(headers),undefined);
});

test('cooldown blocks new calls, counts down, and permits recovery without retrying writes',async()=>{
 let now=0,calls=0;
 const p=provider('fixture',async()=>{if(++calls===1)throw new DiscoveryError('Rate limit',{code:'RATE_LIMITED',retryAfterSeconds:60,windowSeconds:86400});return result;});
 const runtime=new GatewayRuntime([p],[],()=>now),signal=new AbortController().signal;
 await assert.rejects(runtime.call(p,'get_record',{id:'a'},signal),/Rate limit/);
 now=1000;
 await assert.rejects(runtime.call(p,'get_record',{id:'a'},signal),(error)=>error.details.retryAfterSeconds===59);
 assert.equal(calls,1);
 assert.equal(runtime.snapshot()[0].state,'rate_limited');
 now=60001;assert.deepEqual(await runtime.call(p,'get_record',{id:'a'},signal),result);
 assert.equal(calls,2);assert.equal(runtime.snapshot()[0].state,'ready');
});

test('cooldown and structured errors are isolated by service; health resource omits account content',async(t)=>{
 const p=provider('limited',async()=>{throw new DiscoveryError('Rate limit',{code:'RATE_LIMITED',retryAfterSeconds:60});});
 const client=await connect(t,[p,provider('healthy',async()=>result)],{failed:['offline']});
 const limited=await client.callTool({name:'limited__get_record',arguments:{id:'a'}});
 assert.equal(limited._meta.hstack.code,'RATE_LIMITED');
 assert.equal(limited._meta.hstack.retryAfterSeconds,60);
 assert.deepEqual(await client.callTool({name:'healthy__get_record',arguments:{id:'a'}}),result);
 const health=await client.readResource({uri:'hstack://connections'});
 const statuses=JSON.parse(health.contents[0].text);
 assert.equal(statuses.find(x=>x.id==='limited').state,'rate_limited');
 assert.equal(statuses.find(x=>x.id==='offline').state,'unavailable');
 assert.ok(!health.contents[0].text.includes('synthetic record'));
 await assert.rejects(client.readResource({uri:'file:///private/data'}));
});

test('search mode advertises two controls, finds full schemas, and enforces original permissions',async(t)=>{
 let calls=0;
 const client=await connect(t,[provider('one',async(name,args)=>{calls++;assert.equal(name,'get_record');assert.deepEqual(args,{id:'a'});return result;}),provider('two',async()=>result)],{toolMode:'search'});
 assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['hstack_search_tools','hstack_call_tool']);
 const search=await client.callTool({name:'hstack_search_tools',arguments:{query:'record',service:'one',limit:1}});
 const tools=JSON.parse(search.content[0].text).tools;
 assert.equal(tools.length,1);assert.ok(tools[0].name.startsWith('one__'));
 assert.deepEqual(tools[0].inputSchema,schema);
 const call=(name,args)=>client.callTool({name:'hstack_call_tool',arguments:{name,arguments:args}});
 assert.deepEqual(await call('one__get_record',{id:'a'}),result);
 assert.equal((await call('one__get_record',{})).isError,true);
 assert.equal((await call('one__delete_record',{id:'a'})).isError,true);
 assert.equal((await call('missing__get_record',{id:'a'})).isError,true);
 assert.equal((await client.callTool({name:'one__get_record',arguments:{id:'a'}})).isError,true);
 assert.equal(calls,1);
});

test('search control rejects invalid limits and unsupported fields',async(t)=>{
 const client=await connect(t,[provider('one',async()=>result)],{toolMode:'search'});
 for(const args of [{query:'record',limit:999},{query:''},{query:'record',secret:'must not forward'}]){
  assert.equal((await client.callTool({name:'hstack_search_tools',arguments:args})).isError,true);
 }
});
