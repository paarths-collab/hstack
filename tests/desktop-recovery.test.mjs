import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopSocialAction } from '../dist/desktop-credentials.js';
import { DesktopProviders, desktopStore, recordDesktopFailure } from '../dist/desktop-session.js';
import { DiscoveryError } from '../dist/errors.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'hstack-recovery-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const env={HSTACK_CREDENTIAL_BACKEND:'plaintext',HSTACK_STATE_DIR:dir};
  const act=(action,key,verify=async()=>true)=>desktopSocialAction({provider:'buffer',action,key},env,verify);
  await act('save','synthetic');await act('test');await act('activate');
  return {env,act};
}
const loaded=(definition,call)=>({id:definition.id,label:definition.label,readTools:definition.readTools,allowWrites:false,tools:[],call,close:async()=>{}});

test('revoked key disables future requests and replacement recovers without invalidating unrelated identities',async t=>{
  const {env,act}=await fixture(t);let attempts=0,revoked=true;
  const pool=new DesktopProviders(env,async def=>{attempts++;return loaded(def,async()=>{
    if(revoked)throw new DiscoveryError('sensitive-upstream-message',{code:'AUTH_REQUIRED'});
    return {content:[{type:'text',text:'synthetic success'}]};
  })});t.after(()=>pool.close());
  const [provider]=await pool.refresh();await assert.rejects(provider.call('get_account',{},AbortSignal.timeout(1000)));
  assert.equal((await act('status')).state,'reauth_required');assert.ok(!JSON.stringify(await act('status')).includes('sensitive'));
  assert.deepEqual(await pool.refresh(),[]);assert.deepEqual(await pool.refresh(),[]);assert.equal(attempts,1);
  assert.equal(pool.status()[0].lastFailure.recovery,'reauthenticate');
  revoked=false;await act('save','replacement');await act('test');await act('activate');
  const [renewed]=await pool.refresh();assert.equal((await renewed.call('get_account',{},AbortSignal.timeout(1000))).isError,undefined);
  assert.equal(attempts,2);assert.equal((await act('status')).state,'active');
});

test('late rejection from a replaced revision cannot revoke a revalidated same-value key',async t=>{
  const {env,act}=await fixture(t),store=desktopStore(env,'buffer'),previous=await store.read();
  await act('save','synthetic');await act('test');await act('activate');
  await recordDesktopFailure(env,'buffer','synthetic',new DiscoveryError('private',{code:'AUTH_REQUIRED'}),previous.revision);
  assert.equal((await act('status')).state,'active');
});

test('outage discovery backs off, recovers on a new request and never loops within one request',async t=>{
  const {env}=await fixture(t);let now=1000,attempts=0,down=true;
  const pool=new DesktopProviders(env,async def=>{attempts++;if(down)throw new DiscoveryError('outage',{code:'UNAVAILABLE'});return loaded(def,async()=>({content:[]}))},()=>now);t.after(()=>pool.close());
  assert.deepEqual(await pool.refresh(),[]);await pool.refresh();assert.equal(attempts,1);
  now+=1001;await pool.refresh();assert.equal(attempts,2);
  now+=1001;await pool.refresh();assert.equal(attempts,2);
  now+=1001;down=false;assert.equal((await pool.refresh()).length,1);assert.equal(attempts,3);
});

test('rate limits survive a new manager and explicit validation waits without discarding the key',async t=>{
  const {env,act}=await fixture(t);let attempts=0;
  const pool=new DesktopProviders(env,async def=>loaded(def,async()=>{throw new DiscoveryError('limit',{code:'RATE_LIMITED',retryAfterSeconds:60})}));t.after(()=>pool.close());
  const [provider]=await pool.refresh();await assert.rejects(provider.call('get_account',{},AbortSignal.timeout(1000)));
  const next=new DesktopProviders(env,async()=>{attempts++;throw Error('must not load')});t.after(()=>next.close());
  assert.deepEqual(await next.refresh(),[]);assert.equal(attempts,0);
  assert.equal((await act('status')).state,'rate_limited');
  assert.equal((await act('test',undefined,async()=>{assert.fail('must wait')})).state,'rate_limited');
  assert.equal((await desktopStore(env,'buffer').read()).key,'synthetic');
});

test('temporary validation outages preserve activation rather than forcing unnecessary reauthentication',async t=>{
  const {act}=await fixture(t);
  await act('test',undefined,async()=>{throw new DiscoveryError('private',{code:'TIMEOUT'})});
  assert.equal((await act('status')).state,'degraded');
  assert.equal((await act('activate')).state,'active');
});


test('a successful read clears transient degraded status but never reactivates a revoked key',async t=>{
  const {env,act}=await fixture(t);let now=1000,fail=true;
  const pool=new DesktopProviders(env,async def=>loaded(def,async()=>{
    if(fail)throw new DiscoveryError('outage',{code:'TIMEOUT'});
    return {content:[]};
  }),()=>now);t.after(()=>pool.close());
  const [before]=await pool.refresh();await assert.rejects(before.call('get_account',{},AbortSignal.timeout(1000)));
  assert.equal((await act('status')).state,'degraded');
  now+=1001;fail=false;const [after]=await pool.refresh();await after.call('get_account',{},AbortSignal.timeout(1000));
  assert.equal((await act('status')).state,'active');
  const saved=await desktopStore(env,'buffer').read();
  await recordDesktopFailure(env,'buffer',saved.key,new DiscoveryError('revoked',{code:'AUTH_REQUIRED'}),saved.revision);
  await after.call('get_account',{},AbortSignal.timeout(1000));
  assert.equal((await act('status')).state,'reauth_required');
});
