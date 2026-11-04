import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyService } from '../dist/verify-service.js';

function provider(result, overrides = {}) {
  return { id: 'redis', label: 'Redis fixture', tools: [{ name: 'dbsize', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    readTools: new Set(['dbsize']), allowWrites: false, call: async (name, args) => { assert.equal(name, 'dbsize'); assert.deepEqual(args, {}); return result; }, ...overrides };
}

test('operational Redis verification accepts a real numeric count without printing it', async () => {
  await verifyService(provider({ content: [{ type: 'text', text: '4' }], structuredContent: { result: 4 } }));
});

test('operational verification rejects vendor error text, isError and malformed counts', async () => {
  for (const result of [
    { content: [{ type: 'text', text: 'Error getting database size: fixture-private-error' }] },
    { content: [{ type: 'text', text: '0' }], isError: true },
    { content: [{ type: 'text', text: '"4"' }] },
    { content: [{ type: 'text', text: '-1' }] },
  ]) await assert.rejects(verifyService(provider(result)), (error) => /operational read failed/.test(error.message) && !error.message.includes('fixture-private-error'));
});

test('operational verification never bypasses service read permissions or guesses a probe for another service', async () => {
  let calls = 0;
  const p = provider({ content: [] }, { call: async () => { calls++; return { content: [] }; } });
  await assert.rejects(verifyService({ ...p, readTools: new Set() }), (error) => error.details.code === 'FORBIDDEN');
  await assert.rejects(verifyService({ ...p, id: 'different' }), /No reviewed/);
  assert.equal(calls, 0);
});

function mailchimp(result, overrides = {}) {
  return { id:'mailchimp', label:'Mailchimp fixture', allowWrites:false,
    tools:[{ name:'list_audiences', inputSchema:{ type:'object', properties:{ count:{ type:'integer' }, offset:{ type:'integer' } }, required:['count','offset'], additionalProperties:false } }],
    readTools:new Set(['list_audiences']), call:async (name,args) => {
      assert.equal(name,'list_audiences'); assert.deepEqual(args,{ count:1, offset:0 }); return result;
    }, ...overrides };
}

test('Mailchimp operational verification requires a valid audience read, including a valid empty account', async () => {
  for (const value of [{ total_items:0, audiences:[] }, { total_items:3, audiences:[{ id:'synthetic-list' }] }]) {
    await verifyService(mailchimp({ content:[{ type:'text', text:JSON.stringify(value) }] }));
  }
});

test('Mailchimp verification rejects swallowed upstream failures and never treats metadata or broken ping as account proof', async () => {
  for (const value of [
    { total_items:null, audiences:[] }, { total_items:'0', audiences:[] }, { total_items:-1, audiences:[] },
    { total_items:0, audiences:[{}] }, { total_items:5, audiences:[{},{}] },
    { total_items:0, audiences:[], error:'synthetic-private-error' }, { accounts:[{ name:'default' }] },
    { health_check:null, status_code:0 },
  ]) await assert.rejects(verifyService(mailchimp({ content:[{ type:'text', text:JSON.stringify(value) }] })),
    (error) => /Mailchimp operational read failed/.test(error.message) && !error.message.includes('synthetic-private-error'));
  await assert.rejects(verifyService(mailchimp({ isError:true, content:[{ type:'text', text:'{"total_items":0,"audiences":[]}' }] })), /operational read failed/);
  let called = false;
  await assert.rejects(verifyService(mailchimp({ content:[] }, { readTools:new Set(), call:async () => { called=true; } })), (error) => error.details.code === 'FORBIDDEN');
  assert.equal(called,false);
});

test('MongoDB verification uses the preconfigured handle and validates actual structured database-list data',async()=>{
  const make=(result)=>({id:'mongodb',label:'MongoDB fixture',allowWrites:false,readTools:new Set(['list-databases']),
    tools:[{name:'list-databases',inputSchema:{type:'object',properties:{connectionId:{type:'string'}},required:['connectionId']}}],
    call:async(name,args)=>{assert.equal(name,'list-databases');assert.deepEqual(args,{connectionId:'preconfigured'});return result;}});
  for(const structuredContent of [{databases:[],totalCount:0},{databases:[{name:'synthetic',size:0}],totalCount:1}])
    await verifyService(make({content:[],structuredContent}));
  for(const structuredContent of [{databases:[],totalCount:1},{databases:[{name:'synthetic',size:-1}],totalCount:1},{databases:[],totalCount:null}])
    await assert.rejects(verifyService(make({content:[],structuredContent})),/MongoDB operational read failed/);
  await assert.rejects(verifyService(make({isError:true,content:[{type:'text',text:'synthetic-private-credential-error'}]})),
    error=>/MongoDB operational read failed/.test(error.message)&&!error.message.includes('synthetic-private'));
});

test('Google Analytics operational verification requires an actual account-summary result and hides credential failures',async()=>{
  const make=(result,overrides={})=>({id:'google-analytics',label:'Analytics fixture',allowWrites:false,readTools:new Set(['get_account_summaries']),
    tools:[{name:'get_account_summaries',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
    call:async(name,args)=>{assert.equal(name,'get_account_summaries');assert.deepEqual(args,{});return result;},...overrides});
  for(const value of [[],[{account:'accounts/123',property_summaries:[{property:'properties/456'}]}]])
    await verifyService(make({content:[{type:'text',text:JSON.stringify(value)}]}));
  for(const value of [null,{},[{}],[{account:'invalid'}],[{account:'accounts/123',property_summaries:null}],
    [{account:'accounts/123',property_summaries:[{property:'wrong'}]}],{error:'synthetic-private-adc-path'}])
    await assert.rejects(verifyService(make({content:[{type:'text',text:JSON.stringify(value)}]})),error=>
      /Google Analytics operational read failed/.test(error.message)&&!error.message.includes('synthetic-private'));
  await assert.rejects(verifyService(make({isError:true,content:[{type:'text',text:'[]'}]})),/operational read failed/);
  let called=false;
  await assert.rejects(verifyService(make({content:[]},{readTools:new Set(),call:async()=>{called=true;}})),error=>error.details.code==='FORBIDDEN');
  assert.equal(called,false);
});

test('MySQL schema verification handles actual Toolbox per-row JSON, empty reads and explicit upstream failures',async()=>{
  const make=(result,overrides={})=>({id:'mysql',label:'MySQL fixture',allowWrites:false,readTools:new Set(['list_tables']),
    tools:[{name:'list_tables',inputSchema:{type:'object',properties:{table_names:{type:'string'},output_format:{type:'string'}},required:['table_names','output_format']}}],
    call:async(name,args)=>{assert.equal(name,'list_tables');assert.deepEqual(args,{table_names:'',output_format:'simple'});return result;},...overrides});
  for(const rows of [[],[{schema_name:'synthetic',object_name:'one'}],[{schema_name:'synthetic',object_name:'one'},{schema_name:'synthetic',object_name:'two'}]])
    await verifyService(make({content:rows.map(row=>({type:'text',text:JSON.stringify(row)}))}));
  for(const result of [{isError:true,content:[]},{content:[{type:'text',text:'synthetic-private-auth-error'}]},
    {content:[{type:'text',text:'{}'}]},{content:[{type:'text',text:'{"schema_name":"synthetic","object_name":""}'}]},
    {content:[{type:'image',data:'c3ludGhldGlj',mimeType:'image/png'}]}])
    await assert.rejects(verifyService(make(result)),error=>/MySQL operational schema read failed/.test(error.message)&&!error.message.includes('synthetic-private'));
  let called=false;
  await assert.rejects(verifyService(make({content:[]},{readTools:new Set(),call:async()=>{called=true;}})),error=>error.details.code==='FORBIDDEN');assert.equal(called,false);
});

test('Zendesk operational verification requires group JSON rather than native plaintext success errors',async()=>{
  const make=(result,overrides={})=>({id:'zendesk',label:'Zendesk fixture',allowWrites:false,readTools:new Set(['zendesk_get_groups']),
    tools:[{name:'zendesk_get_groups',inputSchema:{type:'object',properties:{}}}],
    call:async(name,args)=>{assert.equal(name,'zendesk_get_groups');assert.deepEqual(args,{});return result;},...overrides});
  for(const value of [[],[{id:1,name:'Synthetic group'}]])await verifyService(make({content:[{type:'text',text:JSON.stringify(value)}]}));
  for(const text of ['Zendesk not configured. Run: zendesk-mcp setup','synthetic-private-error','{}','[{"id":0,"name":"Synthetic"}]','[{"id":1}]'])
    await assert.rejects(verifyService(make({content:[{type:'text',text}]})),error=>/Zendesk operational group read failed/.test(error.message)&&!error.message.includes('synthetic-private'));
  await assert.rejects(verifyService(make({isError:true,content:[{type:'text',text:'[]'}]})),/operational group read failed/);
  let called=false;await assert.rejects(verifyService(make({content:[]},{readTools:new Set(),call:async()=>{called=true;}})),error=>error.details.code==='FORBIDDEN');assert.equal(called,false);
});
