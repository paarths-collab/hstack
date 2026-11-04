import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createSocialGateway } from '../dist/gateway.js';
import { parseConnections } from '../dist/connections.js';
import { checkSetup } from '../dist/setup-check.js';

for(const mode of ['forward','search'])test(`${mode}: one allowed write does not enable other tools or services`,async(t)=>{
  const calls=[];
  const make=(id,writes)=>({id,label:id,permissionSource:'connection',allowWrites:false,readTools:new Set(['read']),writeTools:new Set(writes),
    tools:['read','create','delete'].map(name=>({name,inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value']}})),
    call:async(name)=>{calls.push(`${id}:${name}`);return{content:[{type:'text',text:'synthetic result'}]};}});
  const server=createSocialGateway([make('first',['create']),make('second',[])],{toolMode:mode});
  const client=new Client({name:'permission-fixture',version:'0'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  const call=(name,args)=>client.callTool(mode==='search'?{name:'hstack_call_tool',arguments:{name,arguments:args}}:{name,arguments:args});
  assert.equal((await call('first__create',{value:'invalid'})).isError,true);
  assert.deepEqual(calls,[]);
  assert.ok(!(await call('first__create',{value:1})).isError);
  for(const name of ['first__delete','second__create']){
    const result=await call(name,{value:1});assert.equal(result._meta.hstack.code,'FORBIDDEN');assert.equal(result._meta.hstack.outcome,'not_sent');
    assert.match(result.content[0].text,/writeTools/);
  }
  assert.ok(!(await call('first__read',{value:1})).isError);
  assert.deepEqual(calls,['first:create','first:read']);
  if(mode==='forward'){
    const {tools}=await client.listTools();
    assert.doesNotMatch(tools.find(x=>x.name==='first__create').description??'',/disabled/);
    assert.match(tools.find(x=>x.name==='first__delete').description,/disabled/);
  }
});

test('write allowlists reject malformed configuration and doctor accurately distinguishes exact from global permissions',async()=>{
  const config={id:'fixture',label:'Fixture',enabled:false,transport:'http',url:'https://example.invalid/mcp',readTools:['read'],allowWrites:false};
  for(const writeTools of [true,'create',[3]])assert.throws(()=>parseConnections({connections:[{...config,writeTools}]}));
  assert.match((await checkSetup({...config,writeTools:['create']},{})).notes.join(' '),/1 explicit reads and 1 explicit write/);
});
