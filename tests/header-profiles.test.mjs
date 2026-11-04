import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createMcpHandler,Server } from '@modelcontextprotocol/server';
import { loadConnection } from '../dist/connections.js';
import { checkSetup } from '../dist/setup-check.js';

for(const[id,expectedPrefix]of[['brevo','Bearer '],['pagerduty','Token token=']])test(`${id}: native HTTP uses the documented credential prefix and stops missing credentials before network (synthetic server)`,async t=>{
  const profile=JSON.parse(await readFile(`integrations/${id}/connection.json`,'utf8'));
  const ref=profile.headers.Authorization;assert.equal(ref.prefix,expectedPrefix);
  const missing=await checkSetup(profile,{});assert.deepEqual(missing.issues,[`Set ${ref.env} in the launch environment.`]);
  let requests=0,calls=0;
  const handler=createMcpHandler(()=>{
    const server=new Server({name:'header-fixture',version:'0'},{capabilities:{tools:{}}});
    server.setRequestHandler('tools/list',()=>({tools:[{name:'fixture_read',inputSchema:{type:'object'}}]}));
    server.setRequestHandler('tools/call',()=>{calls++;return{content:[{type:'text',text:'synthetic header result'}]};});return server;
  });t.after(()=>handler.close());
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    requests++;assert.equal(String(url),profile.url);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('authorization'),`${expectedPrefix}synthetic-token`);
    return handler.fetch(new Request(url,init));
  });
  await assert.rejects(loadConnection(profile,{}),error=>error.details.code==='AUTH_REQUIRED');assert.equal(requests,0);
  const env={[ref.env]:'synthetic-token'};const doctor=await checkSetup(profile,env);assert.deepEqual(doctor.issues,[]);assert.doesNotMatch(JSON.stringify(doctor),/synthetic-token/);
  const provider=await loadConnection({...profile,readTools:['fixture_read']},env);t.after(()=>provider.close());
  assert.equal((await provider.call('fixture_read',{},AbortSignal.timeout(2000))).content[0].text,'synthetic header result');
  assert.equal(calls,1);assert.ok(requests>1);
});
