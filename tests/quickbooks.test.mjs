import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyResultPolicy } from '../dist/vendor-contracts.js';
import { validateQuickBooksStore, vendorCredentialGuard } from '../dist/vendor-lock.js';
import { parseConnections } from '../dist/connections.js';
import { canonicalInputSchema } from '../integrations/quickbooks/schema-comparison.mjs';
import { verifyService } from '../dist/verify-service.js';
import { prepareConnections } from '../dist/prepare.js';

const policy='quickbooks-31a1dd5';

test('QuickBooks batch preparation replaces the unused placeholder without changing the source configuration',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'hstack-quickbooks-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'connections.json');
  const original=JSON.stringify({connections:[{id:'quickbooks',label:'QuickBooks',enabled:false,transport:'stdio',
    command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false}]});
  await writeFile(path,original,{mode:0o600});const prepared=await prepareConnections(path,['quickbooks']);
  assert.equal(prepared.plan.selections[0].action,'replace-unused-placeholder');
  const candidate=JSON.parse(await readFile(prepared.candidatePath,'utf8')).connections[0];
  assert.equal(candidate.readTools.length,70);assert.equal(candidate.enabled,false);assert.equal(candidate.allowWrites,false);
  assert.equal(await readFile(path,'utf8'),original);
});

test('schema comparison expands local refs but retains type, bounds, required fields and strict objects',()=>{
  const a={type:'object',properties:{a:{type:'string'},b:{$ref:'#/properties/a'}},additionalProperties:true};
  const b={properties:{b:{type:'string'},a:{type:'string'}},type:'object',additionalProperties:{}};
  assert.deepEqual(canonicalInputSchema(a),canonicalInputSchema(b));
  for(const difference of [{...b,required:['a']},{...b,additionalProperties:false},
    {...b,properties:{...b.properties,a:{type:'number'}}},{...b,properties:{...b.properties,a:{type:'string',maxLength:2}}}]){
    assert.notDeepEqual(canonicalInputSchema(a),canonicalInputSchema(difference));
  }
});

test('QuickBooks operational verifier requires a company payload and hides account/error contents',async()=>{
  const provider=(result)=>({id:'quickbooks',label:'QuickBooks fixture',readTools:new Set(['get_company_info']),allowWrites:false,
    tools:[{name:'get_company_info',inputSchema:{type:'object',properties:{params:{type:'object'}},required:['params']}}],
    call:async(name,args)=>{assert.equal(name,'get_company_info');assert.deepEqual(args,{params:{}});return result;}});
  await verifyService(provider({content:[{type:'text',text:'{"Id":"synthetic","CompanyName":"Fixture"}'}]}));
  for(const value of [null,{},[],{Id:'synthetic'},{CompanyName:'Fixture'},{Id:'',CompanyName:'Fixture'}])
    await assert.rejects(verifyService(provider({content:[{type:'text',text:JSON.stringify(value)}]})),/operational company read failed/);
});

test('QuickBooks preserves native JSON, report labels, per-row results, empty lists, counts and warnings',()=>{
  for(const content of [
    [{type:'text',text:JSON.stringify({CompanyName:'Error: examples inside account data are ordinary content'})}],
    [{type:'text',text:'Balance Sheet Report:'},{type:'text',text:'{"Rows":[]}'}],
    [{type:'text',text:'Found 0 customers:'}],
    [{type:'text',text:'Count: 0'}],
    [{type:'text',text:'WARNING: ignored unsupported parameter.'},{type:'text',text:'{"Id":"synthetic"}'}],
  ]){
    const result={content,_meta:{fixture:true}};
    assert.equal(applyResultPolicy(policy,'get_company_info',result),result);
  }
});

test('QuickBooks normalizes explicit native errors and pinned plaintext failures without reflecting private diagnostics',()=>{
  for(const [text,code] of [
    ['Error: Error: QuickBooks requires foreground sign-in. synthetic-private-diagnostic','AUTH_REQUIRED'],
    ['Error: QuickBooks authorization is invalid or expired synthetic-private-diagnostic','AUTH_REQUIRED'],
    ['Error getting customer: synthetic-private-diagnostic','UPSTREAM_ERROR'],
    ['Invalid criteria: synthetic-private-diagnostic','UPSTREAM_ERROR'],
  ])for(const isError of [true,false]){
    const result=applyResultPolicy(policy,'get_company_info',{isError,content:[{type:'text',text}],structuredContent:{private:'synthetic-private-diagnostic'}});
    assert.equal(result.isError,true);assert.equal(result._meta.hstack.code,code);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-private-diagnostic/);
  }
  const download={content:[{type:'text',text:'Error: custom output'}]};
  assert.equal(applyResultPolicy(policy,'get_invoice_pdf',download),download);
});

test('QuickBooks result policy cannot bypass its local native token-store guard through an HTTP profile',()=>{
  assert.throws(()=>parseConnections({connections:[{id:'quickbooks',label:'Fixture',enabled:false,transport:'http',
    url:'https://example.invalid',resultPolicy:policy,readTools:[],allowWrites:false}]}),/local pinned compatibility runtime/);
});

test('QuickBooks credential metadata rejects relative paths, shared modes, symlinks and hardlinks without reading secrets',async(t)=>{
  const home=await mkdtemp(join(tmpdir(),'hstack-quickbooks-mode-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const store=join(home,'.env');await writeFile(store,'unparsed synthetic bytes',{mode:0o600});
  await validateQuickBooksStore(store);
  for(const path of [undefined,'relative.env',join(home,'absent')])await assert.rejects(validateQuickBooksStore(path),/owner-only/);
  await chmod(store,0o644);await assert.rejects(validateQuickBooksStore(store));await chmod(store,0o600);
  await chmod(store,0o400);await assert.rejects(validateQuickBooksStore(store));await chmod(store,0o600);
  await chmod(home,0o755);await assert.rejects(validateQuickBooksStore(store));await chmod(home,0o700);
  const alias=join(home,'alias.env');await symlink(store,alias);await assert.rejects(validateQuickBooksStore(alias));await rm(alias);
  await link(store,alias);await assert.rejects(validateQuickBooksStore(store));await rm(alias);
  const parent=join(home,'linked');await symlink(home,parent);await assert.rejects(validateQuickBooksStore(join(parent,'.env')));
});

test('QuickBooks guards coordinate the same token file and cancelled waiters do not dispatch',async(t)=>{
  const home=await mkdtemp(join(tmpdir(),'hstack-quickbooks-lock-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const store=join(home,'.env');await writeFile(store,'not read',{mode:0o600});
  const a=await vendorCredentialGuard(policy,{QUICKBOOKS_TOKEN_STORE_PATH:store});
  const b=await vendorCredentialGuard(policy,{QUICKBOOKS_TOKEN_STORE_PATH:store});
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const first=a.run(AbortSignal.timeout(5000),async()=>{entered();await new Promise(resolve=>{release=resolve;});});await ready;
  let calls=0;await assert.rejects(b.run(AbortSignal.timeout(30),async()=>{calls++;}),e=>e.details.outcome==='not_sent');
  assert.equal(calls,0);release();await first;
  assert.equal(await b.run(AbortSignal.timeout(5000),async()=>42),42);await a.drain();await b.drain();
});
