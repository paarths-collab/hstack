import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { vendorCredentialGuard } from '../dist/vendor-lock.js';
import { loadConnection } from '../dist/connections.js';
import { resolve } from 'node:path';

async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'hstack-vendor-lock-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const dir=join(home,'.config/zendesk-mcp');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
  const path=join(dir,'config.json');await writeFile(path,JSON.stringify({revision:0}),{mode:0o600});return{home,path};
}

test('native vendor guard refuses shared homes/configs and symlinked credential files before reading them',async(t)=>{
  const{home,path}=await fixture(t);assert.ok(await vendorCredentialGuard('zendesk-0.1.6',{HOME:home}));
  await chmod(home,0o755);await assert.rejects(vendorCredentialGuard('zendesk-0.1.6',{HOME:home}),/private owner-only/);await chmod(home,0o700);
  await chmod(path,0o644);await assert.rejects(vendorCredentialGuard('zendesk-0.1.6',{HOME:home}),/private owner-only/);await chmod(path,0o600);
  await rm(path);const target=join(home,'target.json');await writeFile(target,'synthetic-private-content',{mode:0o600});await symlink(target,path);
  await assert.rejects(vendorCredentialGuard('zendesk-0.1.6',{HOME:home}),/private owner-only/);
  assert.equal(await readFile(target,'utf8'),'synthetic-private-content');
});

test('native vendor credential lock cancels a waiting operation without dispatch and releases after failure',async(t)=>{
  const{home}=await fixture(t),guard=await vendorCredentialGuard('zendesk-0.1.6',{HOME:home});
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const holding=guard.run(AbortSignal.timeout(5000),async()=>{entered();await new Promise(resolve=>{release=resolve;});});await ready;
  let calls=0;await assert.rejects(guard.run(AbortSignal.timeout(30),async()=>{calls++;}),error=>error.details.code==='TIMEOUT'&&error.details.outcome==='not_sent');
  assert.equal(calls,0);release();await holding;
  await assert.rejects(guard.run(AbortSignal.timeout(1000),async()=>{throw new Error('synthetic failure');}),/synthetic failure/);
  assert.equal(await guard.run(AbortSignal.timeout(1000),async()=>42),42);
});

test('separate Hstack processes serialize native vendor rotation through the same private home',async(t)=>{
  const{home,path}=await fixture(t);const workers=[];
  t.after(()=>{for(const worker of workers)if(worker.exitCode===null)worker.kill('SIGKILL');});
  const start=()=>{
    const child=spawn(process.execPath,['tests/fixtures/vendor-rotation-worker.mjs'],{env:{FIXTURE_HOME:home},stdio:['pipe','pipe','pipe']});workers.push(child);
    let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve({code,output,errors}));});
    const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker not ready')),5000);child.stdout.on('data',()=>{if(output.includes('ready')){clearTimeout(timer);resolve();}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);if(!output.includes('ready'))reject(new Error(`Worker exited before setup: ${errors}`));});});
    return{child,done,ready};
  };
  const a=start(),b=start();await Promise.all([a.ready,b.ready]);a.child.stdin.write('go\n');b.child.stdin.write('go\n');
  const results=await Promise.all([a.done,b.done]);for(const result of results)assert.equal(result.code,0,result.errors);
  assert.equal(JSON.parse(await readFile(path,'utf8')).revision,2);
  const events=(await readFile(join(home,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event=>event.event),['start','end','start','end']);
});

test('closing a guarded provider cancels queued calls and waits for credential lock cleanup',async(t)=>{
  const{home}=await fixture(t);const provider=await loadConnection({id:'zendesk',label:'Synthetic vendor',enabled:false,transport:'stdio',command:process.execPath,
    args:[resolve('tests/fixtures/vendor-rotation-server.mjs')],env:{HOME:'FIXTURE_HOME',ZENDESK_MCP_READ_ONLY:'FIXTURE_READ_ONLY'},
    resultPolicy:'zendesk-0.1.6',readTools:['zendesk_get_groups'],allowWrites:false},{FIXTURE_HOME:home,FIXTURE_READ_ONLY:'true'});
  t.after(()=>provider.close());
  const first=provider.call('zendesk_get_groups',{},AbortSignal.timeout(5000)).catch(error=>error);
  let entered=false;
  for(let i=0;i<200;i++){try{if((await readFile(join(home,'events.jsonl'),'utf8')).includes('start')){entered=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(entered,true);
  const queued=provider.call('zendesk_get_groups',{},AbortSignal.timeout(5000)).catch(error=>error);
  await provider.close();await Promise.all([first,queued]);
  assert.deepEqual(await readdir(join(home,'.hstack-zendesk-locks')),[]);
});
