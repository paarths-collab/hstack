import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSocialGateway } from '../dist/gateway.js';
import { DiscoveryError } from '../dist/errors.js';
import { desktopSocialAction } from '../dist/desktop-credentials.js';
import { DesktopProviders, validateSocialKey } from '../dist/desktop-session.js';
import { socialProviders } from '../dist/providers.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-desktop-flow-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const env = { HSTACK_CREDENTIAL_BACKEND: 'plaintext', HSTACK_STATE_DIR: join(root, 'state') };
  return { env, act: (action, key, provider = 'buffer', verify = async () => true) => desktopSocialAction({action,key,provider}, env, verify) };
}
const account = {name:'get_account',inputSchema:{type:'object',properties:{},additionalProperties:false}};

test('Desktop flow requires validation, invalidates changed keys and refuses unsupported activation', async t => {
  const {act} = await fixture(t);
  assert.equal((await act('activate')).state, 'not_saved');
  await act('save','synthetic-one');
  assert.equal((await act('activate')).state,'error');
  await act('test'); await act('activate');
  assert.equal((await act('status')).state,'active');
  await act('save','synthetic-two');
  assert.equal((await act('status')).state,'saved');
  assert.equal((await act('activate')).state,'error');
  await act('test'); await act('activate');
  assert.equal((await act('test',undefined,'buffer', async () => {throw new DiscoveryError('private',{code:'AUTH_REQUIRED'});})).state,'error');
  assert.equal((await act('activate')).state,'error');
  await act('save','synthetic','metricool');
  assert.equal((await act('test',undefined,'metricool')).state,'error');
  assert.equal((await act('activate',undefined,'metricool')).state,'error');
});

test('same MCP session sees activate, key replacement, removal and blocks writes without environment fallback', async t => {
  const {env,act} = await fixture(t); const reads=[], closed=[];
  const pool = new DesktopProviders({...env,BUFFER_API_KEY:'must-not-be-used',HSTACK_ALLOW_WRITES:'true'}, async (def,key,allow) => {
    assert.equal(allow,false);
    return {id:def.id,label:def.label,readTools:def.readTools,allowWrites:false,
      tools:[account,{name:'create_post',inputSchema:{type:'object'}}],
      call:async name => {reads.push([key,name]);return {content:[{type:'text',text:'synthetic-account'}]}}, close:async()=>{closed.push(key)}};
  });
  const server=createSocialGateway([],{toolMode:'search',refresh:()=>pool.refresh()});
  const client=new Client({name:'desktop-flow-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();await pool.close()});
  const call=name=>client.callTool({name:'hstack_call_tool',arguments:{name,arguments:{}}});
  assert.equal((await client.listTools()).tools.length,2);
  assert.equal((await call('buffer__get_account')).isError,true);
  await act('save','synthetic-one');await act('test');await act('activate');
  assert.notEqual((await call('buffer__get_account')).isError,true);
  assert.equal((await call('buffer__create_post')).isError,true);
  await act('save','synthetic-two');
  assert.equal((await call('buffer__get_account')).isError,true);
  await act('test');await act('activate');
  assert.notEqual((await call('buffer__get_account')).isError,true);
  await act('disconnect');assert.equal((await call('buffer__get_account')).isError,true);
  assert.deepEqual(reads,[['synthetic-one','get_account'],['synthetic-two','get_account']]);
  assert.deepEqual(closed,['synthetic-one','synthetic-two']);
});

test('validation executes a reviewed schema-valid read and does not accept discovery or empty Buffer success',async t=>{
  const def=socialProviders.find(p=>p.id==='buffer'); let calls=0, closes=0;
  const loader=result=>async()=>({tools:[account],readTools:def.readTools,call:async()=>{calls++;return result},close:async()=>{closes++}});
  assert.equal(await validateSocialKey(def,'synthetic',loader({content:[]})),false);
  assert.equal(await validateSocialKey(def,'synthetic',loader({isError:true,content:[{type:'text',text:'bad key'}]})),false);
  assert.equal(await validateSocialKey(def,'synthetic',loader({content:[{type:'text',text:JSON.stringify({id:'synthetic',organizations:[]})}]})),true);
  assert.equal(calls,3);assert.equal(closes,3);
  assert.equal(await validateSocialKey(def,'synthetic',async()=>({tools:[{...account,inputSchema:{type:'object',required:['id'],properties:{id:{type:'string'}}}}],close:async()=>{}})),false);
});

test('a corrupt or unavailable provider cannot keep a stale active key or disable a healthy provider',async t=>{
  const {env,act}=await fixture(t);let fail=false, closed=0;
  const pool=new DesktopProviders(env,async(def,key)=>{
    if (def.id==='buffer' && fail) throw Error('synthetic outage');
    return {id:def.id,label:def.label,tools:[],readTools:def.readTools,allowWrites:false,call:async()=>({content:[]}),close:async()=>{closed++}};
  });t.after(()=>pool.close());
  for (const provider of ['buffer','pallyy']) {await act('save','synthetic',provider);await act('test',undefined,provider);await act('activate',undefined,provider)}
  assert.equal((await pool.refresh()).length,2);
  fail=true;await act('save','replacement');await act('test');await act('activate');
  assert.deepEqual((await pool.refresh()).map(p=>p.id),['pallyy']);assert.equal(closed,1);
});

test('all supported social validation paths call their reviewed read, then enable only that saved provider',async t=>{
  const {env,act}=await fixture(t);
  for (const [id,name] of [['pallyy','get_me'],['blotato','blotato_get_user'],['ayrshare','list_profiles']]) {
    const def=socialProviders.find(p=>p.id===id);let called=0;
    const verifier=(definition,key)=>validateSocialKey(definition,key,async supplied=>{
      assert.equal(supplied.id,id);
      return {tools:[{name,inputSchema:{type:'object',properties:{}}}],call:async (tool,args)=>{
        assert.equal(tool,name);assert.deepEqual(args,{});called++;
        return {content:[{type:'text',text:JSON.stringify(id==='ayrshare'?[]:{id:'synthetic'})}]};
      },close:async()=>{}};
    });
    await act('save',`synthetic-${id}`,id);
    assert.equal((await act('test',undefined,id,verifier)).state,'verified');
    assert.equal((await act('activate',undefined,id)).state,'active');
    assert.equal(called,1);
  }
});

test('adding another Desktop provider preserves an existing rate-limit cooldown',async()=>{
  const {GatewayRuntime}=await import('../dist/runtime.js');
  const {DiscoveryError}=await import('../dist/errors.js');let calls=0;
  const a={id:'buffer',label:'Buffer',tools:[],readTools:new Set(),allowWrites:false,call:async()=>{
    calls++;throw new DiscoveryError('Limited',{code:'RATE_LIMITED',retryAfterSeconds:60});
  }};
  const runtime=new GatewayRuntime([a]);
  await assert.rejects(runtime.call(a,'get_account',{},new AbortController().signal));
  runtime.replaceProviders([a,{...a,id:'pallyy'}]);
  await assert.rejects(runtime.call(a,'get_account',{},new AbortController().signal));
  assert.equal(calls,1);assert.equal(runtime.snapshot()[0].state,'rate_limited');
});
