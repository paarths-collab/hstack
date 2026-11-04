import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../dist/discover-tools.js';

// Opt-in actual vendor/database test. Never accepts an existing connection string.
const require=createRequire(new URL('../integrations/mongodb/package.json',import.meta.url));
const execute=promisify(execFile);
const root=await mkdtemp(join(tmpdir(),'hstack-mongodb-check-'));
const clients=[];
let mongod,driver;
let step='runtime installation';
const report={ vendor:'mongodb-js/mongodb-mcp-server',vendorVersion:'3.2.1',sourceCommit:'7e4d9ed409905f1dc4304b5e7f1a176af22efe58',
  environment:'real disposable authenticated loopback MongoDB; synthetic data only; no hosted account or model',checks:{} };
async function connect(transport){
  const client=new Client({name:'hstack-mongodb-local-verifier',version:'0'});clients.push({client,transport});
  await client.connect(transport,{timeout:30000});return client;
}
async function tools(client){return listAllTools(client,AbortSignal.timeout(30000));}
const text=(r)=>r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
try{
  const { MongoMemoryServer }=require('mongodb-memory-server-core');
  const { MongoClient }=require('mongodb');
  const runtime=fileURLToPath(new URL('../integrations/mongodb/',import.meta.url));
  const pkg=JSON.parse(await readFile(join(runtime,'node_modules/mongodb-mcp-server/package.json'),'utf8'));
  assert.equal(pkg.version,'3.2.1');
  const lock=await readFile(join(runtime,'package-lock.json'));
  report.lockSha256=createHash('sha256').update(lock).digest('hex');
  step='offline setup candidate';
  const manage=fileURLToPath(new URL('../dist/manage.js',import.meta.url));
  const sourcePath=join(root,'source-connections.json');
  const original=JSON.stringify({metadata:{fixture:'must be preserved'},connections:[{id:'mongodb',label:'MongoDB',enabled:false,
    transport:'stdio',command:'/absolute/path/to/configured-vendor-mcp',args:[],env:{},readTools:[],allowWrites:false}]});
  await writeFile(sourcePath,original,{mode:0o600});
  const prepared=await execute(process.execPath,[manage,'prepare','mongodb'],{env:{PATH:process.env.PATH,HOME:root,HSTACK_CONNECTIONS_FILE:sourcePath},cwd:root,timeout:10000});
  const candidatePath=prepared.stdout.match(/^Candidate: (.+)$/m)?.[1];assert.ok(candidatePath);
  const preparedDocument=JSON.parse(await readFile(candidatePath,'utf8'));
  assert.equal(preparedDocument.connections[0].enabled,false);
  assert.deepEqual(preparedDocument.metadata,{fixture:'must be preserved'});
  assert.equal(await readFile(sourcePath,'utf8'),original);
  const cache=fileURLToPath(new URL('../.hstack-tools/mongodb-binaries/',import.meta.url));
  await mkdir(join(root,'db'));
  step='disposable database startup';
  const username='hstack_synthetic',password=randomBytes(24).toString('hex');
  mongod=await MongoMemoryServer.create({binary:{version:'8.2.11',downloadDir:cache,checkMD5:true},
    instance:{ip:'127.0.0.1',port:0,dbPath:join(root,'db')},auth:{enable:true,customRootName:username,customRootPwd:password}});
  const uri=new URL(mongod.getUri());uri.username=username;uri.password=password;uri.searchParams.set('authSource','admin');
  driver=new MongoClient(uri.href);await driver.connect();
  report.databaseVersion=(await driver.db('admin').admin().serverInfo()).version;
  assert.equal(report.databaseVersion,'8.2.11');
  const database='hstack_synthetic',collection='records',marker=randomUUID(),value=randomUUID();
  const records=driver.db(database).collection(collection);
  await records.insertOne({marker,value,kind:'synthetic'});
  const profile=preparedDocument.connections[0];
  assert.deepEqual(profile,JSON.parse(await readFile(new URL('../integrations/mongodb/connection.json',import.meta.url),'utf8')));
  const command=join(runtime,'node_modules/.bin/mongodb-mcp-server');
  const env={PATH:process.env.PATH,HOME:root,HSTACK_MONGODB_COMMAND:command,MDB_MCP_CONNECTION_STRING:uri.href};
  const direct=await connect(new StdioClientTransport({command,args:profile.args,env,cwd:root,stderr:'ignore'}));
  step='direct discovery and reads';
  const listing=await tools(direct);report.readOnlyTools=listing.length;
  report.schemaSha256=createHash('sha256').update(JSON.stringify(listing)).digest('hex');
  assert.ok(!listing.some(t=>t.name==='insert-many'));
  const reads=[['list-databases',{connectionId:'preconfigured'}],['list-collections',{connectionId:'preconfigured',database}],
    ['count',{connectionId:'preconfigured',database,collection}],['find',{connectionId:'preconfigured',database,collection,filter:{marker},limit:1}]];
  const directResults={};
  for(const [name,args] of reads){const result=await direct.callTool({name,arguments:args});assert.ok(!result.isError);directResults[name]=result.structuredContent;}
  assert.equal(directResults.count.count,1);assert.ok(JSON.stringify(directResults.find).includes(value));
  const launch=async(config,mode='search',preparedPath)=>{
    const path=preparedPath??join(root,`connections-${randomUUID()}.json`);
    // Explicit test-only activation models the user's reviewed candidate edit.
    await writeFile(path,JSON.stringify({...preparedDocument,connections:[{...config,enabled:true}]}),{mode:0o600});
    const client=await connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/server.js',import.meta.url))],
      env:{...env,HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:mode},cwd:root,stderr:'ignore'}));
    return{client,path};
  };
  const {client:gateway,path}=await launch(profile,'search',candidatePath);
  step='gateway search and read comparison';
  assert.equal((await tools(gateway)).length,2);
  const found=JSON.parse(text(await gateway.callTool({name:'hstack_search_tools',arguments:{service:'mongodb',query:'count',limit:1}})));
  assert.equal(found.tools[0].name,'mongodb__count');assert.deepEqual(found.tools[0].inputSchema,listing.find(t=>t.name==='count').inputSchema);
  for(const [name,args] of reads){
    const result=await gateway.callTool({name:'hstack_call_tool',arguments:{name:`mongodb__${name}`,arguments:args}});
    assert.ok(!result.isError);
    if(name==='list-databases')assert.deepEqual(result.structuredContent.databases.map(x=>x.name).sort(),directResults[name].databases.map(x=>x.name).sort());
    else assert.deepEqual(result.structuredContent,directResults[name]);
  }
  const retarget=await gateway.callTool({name:'hstack_call_tool',arguments:{name:'mongodb__connect',arguments:{}}});
  assert.equal(retarget._meta.hstack.code,'FORBIDDEN');
  report.checks.fourDirectAndGatewayReads=true;report.checks.schemaAndSearch=true;report.checks.retargetingBlocked=true;
  step='valid operational verification';
  const verified=await execute(process.execPath,[manage,'verify','mongodb'],{env:{...env,HSTACK_CONNECTIONS_FILE:path},cwd:root,timeout:40000});
  assert.match(verified.stdout,/database-list read verified/);
  step='wrong password rejection';
  const badUri=new URL(uri);badUri.password=randomBytes(24).toString('hex');
  const bad=await execute(process.execPath,[manage,'verify','mongodb'],{env:{...env,MDB_MCP_CONNECTION_STRING:badUri.href,HSTACK_CONNECTIONS_FILE:path},cwd:root,timeout:40000})
    .then(()=>assert.fail('Wrong password must not pass operational verification'),error=>error);
  assert.equal(bad.code,1);assert.match(bad.stderr,/MongoDB operational read failed/);assert.ok(!bad.stderr.includes(badUri.password));
  report.checks.operationalReadAndBadPassword=true;
  step='default and exact write permissions';
  const writeArgs=profile.args.filter(arg=>arg!=='--readOnly');
  const {client:writeBlocked}=await launch({...profile,args:writeArgs});
  const writeMarker=randomUUID();
  const insertion={connectionId:'preconfigured',database,collection,documents:[{marker:writeMarker,kind:'synthetic'}]};
  const blocked=await writeBlocked.callTool({name:'hstack_call_tool',arguments:{name:'mongodb__insert-many',arguments:insertion}});
  assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(await records.countDocuments({marker:writeMarker}),0);
  const {client:writeAllowed}=await launch({...profile,args:writeArgs,writeTools:['insert-many']});
  const written=await writeAllowed.callTool({name:'hstack_call_tool',arguments:{name:'mongodb__insert-many',arguments:insertion}});
  assert.ok(!written.isError);assert.equal(written.structuredContent.insertedCount,1);assert.equal(await records.countDocuments({marker:writeMarker}),1);
  const other=await writeAllowed.callTool({name:'hstack_call_tool',arguments:{name:'mongodb__drop-database',arguments:{connectionId:'preconfigured',database}}});
  assert.equal(other._meta.hstack.code,'FORBIDDEN');assert.equal(await records.countDocuments({}),2);
  report.checks.defaultWriteBlockedAndSingleWriteOptIn=true;
  assert.equal(await readFile(sourcePath,'utf8'),original);
  report.checks.preparedCandidateAndSourcePreservation=true;
  if(process.env.HSTACK_TEST_HERMES_ROOT && process.env.HSTACK_TEST_HERMES_PYTHON){
    step='native Hermes registry';
    const home=join(root,'hermes');await mkdir(home);
    const nativePath=join(root,'native-connections.json');
    await writeFile(nativePath,JSON.stringify({connections:[{...profile,enabled:true,args:writeArgs}]}),{mode:0o600});
    await writeFile(join(home,'config.yaml'),JSON.stringify({mcp_servers:{hstack:{command:process.execPath,
      args:[fileURLToPath(new URL('../dist/server.js',import.meta.url))],env:{...env,HSTACK_CONNECTIONS_FILE:nativePath,HSTACK_TOOL_MODE:'search'},
      connect_timeout:60,timeout:40}}}),{mode:0o600});
    const blockedMarker=randomUUID();
    const probe=join(root,'hermes-probe.json');
    await writeFile(probe,JSON.stringify({source:process.env.HSTACK_TEST_HERMES_ROOT,database,collection,marker,value,blockedMarker}),{mode:0o600});
    const native=await execute(process.env.HSTACK_TEST_HERMES_PYTHON,['-I','-B',fileURLToPath(new URL('./verify-hermes-mongodb.py',import.meta.url)),probe],
      {env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:home},cwd:root,timeout:60000});
    assert.match(native.stdout,/PASS: native Hermes registry/);assert.equal(await records.countDocuments({marker:blockedMarker}),0);
    report.checks.nativeHermesRegistry=true;
    report.hermesMcpSourceSha256=createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT,'tools/mcp_tool.py'))).digest('hex');
  }
  if(process.env.HSTACK_MONGODB_REPORT)await writeFile(process.env.HSTACK_MONGODB_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(`PASS: official MongoDB MCP 3.2.1, ${listing.length} read-only tools, real disposable MongoDB ${report.databaseVersion}.`);
  console.log('PASS: four reads, search/schema preservation, credential failure detection and blocked retargeting.');
  console.log('PASS: prepared candidate used after explicit test activation; original configuration preserved.');
  console.log('PASS: insert blocked by default; exact per-tool opt-in writes synthetic data while drop stays blocked.');
  if(report.checks.nativeHermesRegistry)console.log('PASS: native Hermes registry search, read and write-block. No model used.');
  console.log('No existing database, hosted account, normal agent configuration or model was used.');
}catch{
  console.error(`MongoDB local verification failed during ${step}. Check pinned installation and local database prerequisites; raw values and errors hidden.`);process.exitCode=1;
}finally{
  for(const {client,transport} of clients.reverse()){try{await client.close();}catch{}try{await transport.close();}catch{}}
  await driver?.close().catch(()=>{});await mongod?.stop().catch(()=>{});await rm(root,{recursive:true,force:true});
}
