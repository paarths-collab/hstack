import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyResultPolicy, vendorEnvironmentIssues } from '../dist/vendor-contracts.js';
import { parseConnections, loadConnection } from '../dist/connections.js';
import { checkSetup } from '../dist/setup-check.js';

const payload = (value) => ({ content:[{ type:'text', text:JSON.stringify(value) }], _meta:{ fixture:true } });

test('Mailchimp result policy preserves valid empty/nonempty list results and metadata', () => {
  for (const [name,field] of [['list_audiences','audiences'],['list_campaigns','campaigns']]) {
    for (const result of [payload({ total_items:0, [field]:[] }), payload({ total_items:2, [field]:[{ id:'synthetic-record' }] }),
      { content:[], structuredContent:{ total_items:0, [field]:[] } }]) {
      assert.equal(applyResultPolicy('mailchimp-1.2.0',name,result),result);
    }
  }
});

test('Mailchimp result policy turns swallowed or malformed list failures into explicit safe errors', () => {
  for (const value of [{ total_items:null, audiences:[] }, { total_items:-1, audiences:[] },
    { total_items:'0', audiences:[] }, { total_items:0, audiences:null }, { total_items:0, audiences:[], error:'synthetic-private-error' }]) {
    const result = applyResultPolicy('mailchimp-1.2.0','list_audiences',payload(value),'mailchimp-test');
    assert.equal(result.isError,true); assert.equal(result._meta.hstack.code,'UPSTREAM_ERROR');
    assert.equal(result._meta.hstack.service,'mailchimp-test');
    assert.match(result.content[0].text,/do not treat this as an empty account/);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-private-error/);
    assert.equal(result.structuredContent,undefined);
  }
  assert.equal(applyResultPolicy('mailchimp-1.2.0','list_campaigns',{ content:[{ type:'text', text:'not JSON' }] }).isError,true);
});

test('vendor policies are explicit; other tool results and upstream errors are preserved', () => {
  const result = payload({ total_items:null, audiences:[] });
  assert.equal(applyResultPolicy(undefined,'list_audiences',result),result);
  assert.equal(applyResultPolicy('mailchimp-1.2.0','get_account_info',result),result);
  const failure = { ...result, isError:true };
  assert.equal(applyResultPolicy('mailchimp-1.2.0','list_audiences',failure),failure);
  assert.throws(() => parseConnections({ connections:[{ id:'fixture',label:'Fixture',enabled:false,transport:'stdio',
    command:'node',readTools:[],allowWrites:false,resultPolicy:'guess' }] }),/Unsupported vendor result policy/);
});

test('pinned Mailchimp retry setting is checked offline and enforced before the child starts', async () => {
  assert.deepEqual(vendorEnvironmentIssues('mailchimp-1.2.0',{ MAILCHIMP_MAX_RETRIES:'0' }),[]);
  const config={ id:'mailchimp',label:'Mailchimp',enabled:false,transport:'stdio',command:process.execPath,
    args:['must-not-run'],env:{ MAILCHIMP_MAX_RETRIES:'FIXTURE_RETRIES' },readTools:[],allowWrites:false,resultPolicy:'mailchimp-1.2.0' };
  const report=await checkSetup(config,{ FIXTURE_RETRIES:'3' });
  assert.match(report.issues.join(' '),/MAILCHIMP_MAX_RETRIES=0/);
  await assert.rejects(loadConnection(config,{ FIXTURE_RETRIES:'3' }), (error)=>error.details.outcome==='not_sent' && /MAILCHIMP_MAX_RETRIES=0/.test(error.message));
});

test('Zendesk policy turns missing/expired native auth and non-JSON read failures into safe errors',()=>{
  for(const message of ['Zendesk not configured. Run: zendesk-mcp setup','Zendesk authorization failed: synthetic-private-token',
    'Zendesk API error: synthetic-private-url','Group #1 not found or not accessible with current credentials.']){
    const result=applyResultPolicy('zendesk-0.1.6','zendesk_get_groups',{content:[{type:'text',text:message}],structuredContent:{result:message}});
    assert.equal(result.isError,true);assert.equal(result._meta.hstack.service,'zendesk');
    assert.equal(result._meta.hstack.code,message.startsWith('Zendesk not configured')||message.startsWith('Zendesk authorization')?'AUTH_REQUIRED':'UPSTREAM_ERROR');
    assert.equal(result.structuredContent,undefined);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
  }
});

test('Zendesk policy preserves valid JSON/user content and never interprets Markdown or other vendors',()=>{
  for(const value of [[],{},[{id:1,name:'Zendesk authorization failed: user-controlled text'}]]){
    const result=payload(value);assert.equal(applyResultPolicy('zendesk-0.1.6','zendesk_get_groups',result),result);
  }
  const markdown={content:[{type:'text',text:'Zendesk API error: user-controlled issue title'}]};
  assert.equal(applyResultPolicy('zendesk-0.1.6','zendesk_ticket_to_gitlab_context',markdown),markdown);
  assert.equal(applyResultPolicy(undefined,'zendesk_get_groups',markdown),markdown);
  const failure={...markdown,isError:true};assert.equal(applyResultPolicy('zendesk-0.1.6','zendesk_get_groups',failure),failure);
  for(const value of ['null','true','"not an object"'])assert.equal(applyResultPolicy('zendesk-0.1.6','zendesk_get_groups',{content:[{type:'text',text:value}]}).isError,true);
  assert.equal(applyResultPolicy('zendesk-0.1.6','zendesk_get_groups',{content:[{type:'text',text:'[]'},{type:'text',text:'Zendesk API error: synthetic-private-error'}]}).isError,true);
});

test('reviewed Zendesk mode requires native read-only protection before process launch',async()=>{
  const config={id:'zendesk',label:'Fixture',enabled:false,transport:'stdio',command:process.execPath,args:['must-not-run'],
    env:{HOME:'FIXTURE_HOME',ZENDESK_MCP_READ_ONLY:'FIXTURE_MODE'},readTools:[],allowWrites:false,resultPolicy:'zendesk-0.1.6'};
  assert.match((await checkSetup(config,{FIXTURE_HOME:'/private/test-home',FIXTURE_MODE:'false'})).issues.join(' '),/READ_ONLY=true/);
  await assert.rejects(loadConnection(config,{FIXTURE_HOME:'/private/test-home',FIXTURE_MODE:'false'}),error=>error.details.outcome==='not_sent');
  assert.throws(()=>parseConnections({connections:[{id:'zendesk',label:'Fixture',enabled:false,transport:'http',url:'https://example.invalid/mcp',
    readTools:[],allowWrites:false,resultPolicy:'zendesk-0.1.6'}]}),/requires a local native runtime/);
});
