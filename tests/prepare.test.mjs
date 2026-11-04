import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm, chmod, mkdir, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planConnections, prepareConnections } from '../dist/prepare.js';
import { loadConfiguredConnections } from '../dist/connections.js';

const legacy=(id='mongodb',label='MongoDB')=>({id,label,enabled:false,transport:'stdio',command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'hstack-prepare-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return{root,path:join(root,'private config.json')};
}

test('offline batch plan exposes public defaults and changed names, never private values or a candidate file',async(t)=>{
  const {root,path}=await fixture(t);
  const document={metadata:{note:'synthetic-private-note'},connections:[legacy(),{id:'private',label:'Private',enabled:false,transport:'http',url:'https://example.invalid/mcp?key=synthetic-private-value',readTools:[],allowWrites:false}]};
  const original=JSON.stringify(document);await writeFile(path,original);
  const plan=await planConnections(path,['mongodb','redis']);
  assert.deepEqual(plan.selections.map(x=>x.action),['replace-unused-placeholder','add-disabled']);
  assert.ok(plan.selections[0].changedKeys.includes('commandEnv'));
  assert.doesNotMatch(JSON.stringify(plan),/synthetic-private-note|synthetic-private-value/);
  assert.equal(plan.activation,'manual');assert.equal(await readFile(path,'utf8'),original);
  await assert.rejects(stat(join(root,'.hstack-setup')),{code:'ENOENT'});
});

test('prepare creates an owner-only batch candidate, preserves source bytes/metadata and activates nothing',async(t)=>{
  const {root,path}=await fixture(t);
  const document={metadata:{note:'synthetic-private-note'},connections:[legacy()]};
  const original=JSON.stringify(document);await writeFile(path,original);
  const {candidatePath,plan}=await prepareConnections(path,['mongodb','redis']);
  assert.equal((await stat(join(root,'.hstack-setup'))).mode&0o777,0o700);
  assert.equal((await stat(candidatePath)).mode&0o777,0o600);
  const candidate=JSON.parse(await readFile(candidatePath,'utf8'));
  assert.deepEqual(candidate.metadata,document.metadata);
  assert.deepEqual(candidate.connections.map(x=>x.id),['mongodb','redis']);
  assert.ok(candidate.connections.every(x=>!x.enabled&&!x.allowWrites));
  assert.equal(plan.sourceSha256.length,64);
  assert.equal(await readFile(path,'utf8'),original);
  assert.deepEqual(await loadConfiguredConnections(candidatePath,{},async()=>assert.fail('No connection should activate')),{providers:[],failed:[]});
});

test('configured and customized entries are retained rather than silently replaced by defaults',async(t)=>{
  const {path}=await fixture(t);
  for(const change of [{enabled:true},{label:'Custom label'},{args:['custom-arg']},{env:{KEY:'PRIVATE_KEY'}},{readTools:['custom_read']},{writeTools:['custom_write']},{userNote:'synthetic-private-note'}]){
    const entry={...legacy(),...change};
    const original=JSON.stringify({connections:[entry]});await writeFile(path,original);
    const {candidatePath,plan}=await prepareConnections(path,['mongodb']);
    assert.equal(plan.selections[0].action,'preserve-configured');
    assert.deepEqual(plan.selections[0].changedKeys,[]);
    assert.deepEqual(JSON.parse(await readFile(candidatePath,'utf8')).connections[0],entry);
    assert.equal(await readFile(path,'utf8'),original);
    assert.doesNotMatch(JSON.stringify(plan),/synthetic-private-note|custom-arg|PRIVATE_KEY/);
  }
});

test('new configurations and concurrent preparations use distinct snapshots without creating an active source file',async(t)=>{
  const {path}=await fixture(t);
  const results=await Promise.all([prepareConnections(path,['mongodb']),prepareConnections(path,['redis'])]);
  assert.notEqual(results[0].candidatePath,results[1].candidatePath);
  for(const result of results)assert.equal(JSON.parse(await readFile(result.candidatePath,'utf8')).connections.length,1);
  await assert.rejects(stat(path),{code:'ENOENT'});
});

test('unknown and duplicate vendor choices fail without creating setup state',async(t)=>{
  const {root,path}=await fixture(t);
  for(const ids of [[],['mongodb','mongodb'],['../escape'],['missing']])await assert.rejects(prepareConnections(path,ids));
  await assert.rejects(stat(join(root,'.hstack-setup')),{code:'ENOENT'});
  await writeFile(path,'invalid JSON with synthetic-private-value');
  await assert.rejects(planConnections(path,['mongodb']),error=>!error.message.includes('synthetic-private-value'));
});

test('unsafe snapshot directories and symlinks are refused without changing existing files',async(t)=>{
  const {root,path}=await fixture(t);
  const state=join(root,'.hstack-setup');await mkdir(state,{mode:0o755});await chmod(state,0o755);
  await assert.rejects(prepareConnections(path,['mongodb']),/unsafe/);
  assert.equal((await stat(state)).mode&0o777,0o755);
  await rm(state,{recursive:true});
  const target=join(root,'other');await mkdir(target);await writeFile(join(target,'keep'),'synthetic');await symlink(target,state);
  await assert.rejects(prepareConnections(path,['mongodb']),/unsafe/);
  assert.deepEqual(await readdir(target),['keep']);
});
