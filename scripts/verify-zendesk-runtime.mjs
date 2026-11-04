import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../dist/discover-tools.js';

// Installed community vendor code, synthetic homes and loopback HTTP only.
// The Python bootstrap changes network routing, never OAuth/tool implementations.
const execute=promisify(execFile),root=await mkdtemp(join(tmpdir(),'hstack-zendesk-runtime-'));
const clients=[];let http,step='runtime inspection';
const python=process.env.HSTACK_ZENDESK_PYTHON;
const profile=JSON.parse(await readFile(new URL('../integrations/zendesk/connection.json',import.meta.url),'utf8'));
const report={vendor:'michaelrice/zendesk-mcp',vendorVersion:'0.1.6',community:true,sourceCommit:'3606125940e554eafea04f356402352df681a9d9',
  environment:'real installed vendor process; synthetic OAuth/HTTP fixture; no Zendesk account, external request or model',checks:{}};
const text=result=>result.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n')??'';
const parse=result=>JSON.parse(text(result));
async function connect(transport){const client=new Client({name:'hstack-zendesk-verifier',version:'0'});clients.push({client,transport});await client.connect(transport,{timeout:30_000});return client;}
async function home(name,config){
  const dir=join(root,name);await mkdir(dir,{mode:0o700});
  if(config){const folder=join(dir,'.config/zendesk-mcp');await mkdir(folder,{recursive:true,mode:0o700});await writeFile(join(folder,'config.json'),JSON.stringify(config),{mode:0o600});}
  return dir;
}

try{
  assert.ok(python&&isAbsolute(python),'Set HSTACK_ZENDESK_PYTHON to the hash-locked Python 3.12 runtime.');
  const inspected=await execute(python,['-I','-c',`import sys,pathlib,json,hashlib,importlib.util as u,importlib.metadata as m
assert sys.version_info[:2]==(3,12)
blobs={}
for public_name,module in [('server','server'),('lifecycle','auth'),('config','config'),('client','client'),('tool_policy','tool_policy')]:
 data=pathlib.Path(u.find_spec('zendesk_mcp.'+module).origin).read_bytes();blobs[public_name]=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
print(json.dumps({'vendor':m.version('zendesk-mcp'),'mcp':m.version('mcp'),'blobs':blobs}))`],{env:{},cwd:root,timeout:10_000});
  const versions=JSON.parse(inspected.stdout);assert.equal(versions.vendor,'0.1.6');assert.equal(versions.mcp,'2.3.0');
  assert.deepEqual(versions.blobs,{server:'144a9b699620164a57e8edf388ee3d3a35046d26',lifecycle:'0337ff93668d86f57ab52e4bdce732b355e70506',
    config:'8cd46c8cc92be212ee4e88f1e102430fd3130128',client:'3c12a604daae76a6180df4b8423f55314ab8038b',tool_policy:'2300efa15d2042ec394af38ddb0523fe07f10ba8'});
  report.sourceBlobs=versions.blobs;report.pythonMcpVersion=versions.mcp;
  report.lockSha256=createHash('sha256').update(await readFile(new URL('../integrations/zendesk/requirements.lock',import.meta.url))).digest('hex');

  let revision=0,directBarrier=false;const pendingRefreshes=[];
  const stats={refreshes:0,rotations:0,reads:0,rejections:0};const groupName=`synthetic-${randomUUID()}`;
  const json=(res,status,value)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));
  http=createServer(async(req,res)=>{
    try{
    if(req.method==='POST'&&req.url==='/oauth/tokens'){
      stats.refreshes++;const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());
      if(directBarrier)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);pendingRefreshes.push(()=>{clearTimeout(timer);resolve();});if(pendingRefreshes.length===2)for(const ready of pendingRefreshes.splice(0))ready();});
      await new Promise(resolve=>setTimeout(resolve,50));
      if(body.refresh_token!==`synthetic-refresh-${revision}`){stats.rejections++;return json(res,400,{error:'invalid_grant'});}
      assert.equal(body.client_id,'synthetic-client');revision++;stats.rotations++;
      return json(res,200,{access_token:`synthetic-access-${revision}`,refresh_token:`synthetic-refresh-${revision}`,expires_in:3600});
    }
    if(req.method==='GET'&&req.url==='/api/v2/groups.json'){
      if(req.headers.authorization!==`Bearer synthetic-access-${revision}`)return json(res,401,{error:'invalid_token'});
      stats.reads++;return json(res,200,{groups:[{id:1,name:groupName}]});
    }
    json(res,404,{error:'unexpected fixture request'});
    }catch{json(res,500,{error:'synthetic fixture assertion failed'});}
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const port=http.address().port;
  const marker=join(root,'unexpected-network');
  const bootstrap=`import sys,runpy,httpx
original_request=httpx.request
original_post=httpx.post
def route(url):
 url=str(url)
 prefix='https://synthetic-hstack.zendesk.com/'
 if not url.startswith(prefix): raise OSError('Unexpected synthetic vendor URL')
 return 'http://127.0.0.1:${port}/'+url[len(prefix):]
httpx.request=lambda method,url,**kwargs: original_request(method,route(url),**kwargs)
httpx.post=lambda url,**kwargs: original_post(route(url),**kwargs)
def guard(event,args):
 if event=='socket.getaddrinfo' and str(args[0])!='127.0.0.1':
  with open(${JSON.stringify(marker)},'w') as output: output.write('blocked')
  raise OSError('External network denied by Hstack fixture')
 if event=='socket.connect' and (args[1][0]!='127.0.0.1' or args[1][1]!=${port}):
  with open(${JSON.stringify(marker)},'w') as output: output.write('blocked')
  raise OSError('External network denied by Hstack fixture')
sys.addaudithook(guard)
sys.argv=['zendesk_mcp']
runpy.run_module('zendesk_mcp',run_name='__main__')`;
  const args=['-I','-c',bootstrap];
  const env=dir=>({HOME:dir,HSTACK_ZENDESK_HOME:dir,HSTACK_ZENDESK_PYTHON:python,ZENDESK_MCP_READ_ONLY:'true',PYTHON_DOTENV_DISABLED:'1'});
  const direct=dir=>connect(new StdioClientTransport({command:python,args,env:env(dir),cwd:root,stderr:'ignore'}));
  const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
  const gateway=async dir=>{
    const path=join(root,`connections-${clients.length}.json`);await writeFile(path,JSON.stringify({connections:[{...profile,enabled:true,args}]}),{mode:0o600});
    const client=await connect(new StdioClientTransport({command:process.execPath,args:[serverPath],env:{...env(dir),HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:'search'},cwd:root,stderr:'ignore'}));
    return{client,path};
  };
  step='actual discovery and missing native setup';
  const missingHome=await home('missing');step='native discovery connection';const native=await direct(missingHome);
  step='native read/write name checks';
  const tools=await listAllTools(native,AbortSignal.timeout(30_000));report.discoveredReadOnlyTools=tools.length;
  for(const name of profile.readTools)assert.ok(tools.some(tool=>tool.name===name),`Missing reviewed read ${name}`);
  for(const name of ['zendesk_create_ticket','zendesk_post_comment','zendesk_apply_macro'])assert.ok(!tools.some(tool=>tool.name===name));
  assert.ok(tools.some(tool=>tool.name==='zendesk_download_attachment'));
  report.schemaSha256=createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  step='native unconfigured result contract';
  const rawFailure=await native.callTool({name:'zendesk_get_groups',arguments:{}});assert.ok(!rawFailure.isError);assert.match(text(rawFailure),/Zendesk not configured/);
  step='unconfigured gateway connection';
  const{client:missingGateway,path:missingPath}=await gateway(missingHome);
  assert.equal((await listAllTools(missingGateway,AbortSignal.timeout(30_000))).length,2);
  const probes={zendesk_get_ticket:{ticket_id:1},zendesk_get_comments:{ticket_id:1},zendesk_get_view:{view_id:1},zendesk_get_view_tickets:{view_id:1},
    zendesk_get_group_users:{group_id:1},zendesk_get_organization:{organization_id:1},zendesk_get_time_tracking:{ticket_id:1},zendesk_search_users:{query:'synthetic'}};
  for(const name of profile.readTools){
    step=`missing-auth forwarding for ${name}`;
    const found=parse(await missingGateway.callTool({name:'hstack_search_tools',arguments:{service:'zendesk',query:name,limit:10}}));
    assert.deepEqual(found.tools.find(item=>item.name===`zendesk__${name}`)?.inputSchema,tools.find(tool=>tool.name===name).inputSchema);
    const failure=await missingGateway.callTool({name:'hstack_call_tool',arguments:{name:`zendesk__${name}`,arguments:probes[name]??{}}});
    assert.equal(failure.isError,true);assert.equal(failure._meta.hstack.code,'AUTH_REQUIRED');
  }
  const blocked=await missingGateway.callTool({name:'hstack_call_tool',arguments:{name:'zendesk__zendesk_download_attachment',arguments:{}}});
  assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(blocked._meta.hstack.outcome,'not_sent');
  const manage=fileURLToPath(new URL('../dist/manage.js',import.meta.url));
  const rejected=await execute(process.execPath,[manage,'verify','zendesk'],{env:{...env(missingHome),HSTACK_CONNECTIONS_FILE:missingPath},cwd:root,timeout:40_000})
    .then(()=>assert.fail('Missing setup must not pass operational verification'),error=>error);
  assert.equal(rejected.code,1);assert.match(rejected.stderr,/Zendesk operational group read failed/);
  assert.equal(stats.refreshes+stats.reads,0);
  report.checks.fourteenSchemasAndMissingAuthErrors=true;report.checks.nativeWritesAbsentAndDownloadsBlocked=true;
  step='native read-only mode with damaged config';
  const damagedHome=await home('damaged',{});await writeFile(join(damagedHome,'.config/zendesk-mcp/config.json'),'{invalid synthetic config',{mode:0o600});
  const damaged=await direct(damagedHome);const damagedTools=await listAllTools(damaged,AbortSignal.timeout(30_000));
  assert.deepEqual(damagedTools.map(tool=>tool.name).sort(),tools.map(tool=>tool.name).sort());
  report.checks.nativeReadOnlySurvivesInvalidConfig=true;

  const stale=()=>({subdomain:'synthetic-hstack',oauth_token:'synthetic-access-0',refresh_token:'synthetic-refresh-0',expires_at:1,client_id:'synthetic-client',client_secret:'synthetic-secret'});
  step='direct native refresh race comparison';
  directBarrier=true;
  const directHome=await home('direct',stale()),a=await direct(directHome),b=await direct(directHome);
  const directResults=await Promise.all([a.callTool({name:'zendesk_get_groups',arguments:{}}),b.callTool({name:'zendesk_get_groups',arguments:{}})]);
  assert.equal(stats.refreshes,2);assert.equal(stats.rotations,1);assert.equal(stats.rejections,1);
  assert.equal(directResults.filter(result=>text(result).includes('Zendesk authorization failed')).length,1);
  report.comparison={direct:{refreshRequests:stats.refreshes,rotations:stats.rotations,successfulGroupReads:stats.reads,refreshRejections:stats.rejections}};
  report.checks.directNativeConcurrentRefreshFailureReproduced=true;
  directBarrier=false;revision=0;for(const key of Object.keys(stats))stats[key]=0;
  step='shared-home Hstack refresh coordination';
  const safeHome=await home('hstack',stale()),first=await gateway(safeHome),second=await gateway(safeHome);
  const call=client=>client.callTool({name:'hstack_call_tool',arguments:{name:'zendesk__zendesk_get_groups',arguments:{}}});
  const results=await Promise.all([call(first.client),call(second.client)]);
  for(const result of results){assert.ok(!result.isError);assert.equal(parse(result)[0].name,groupName);}
  assert.deepEqual(stats,{refreshes:1,rotations:1,reads:2,rejections:0});
  report.comparison.hstack={refreshRequests:stats.refreshes,rotations:stats.rotations,successfulGroupReads:stats.reads,refreshRejections:stats.rejections};
  const stored=join(safeHome,'.config/zendesk-mcp/config.json');assert.equal((await stat(stored)).mode&0o777,0o600);
  assert.equal(JSON.parse(await readFile(stored,'utf8')).refresh_token,'synthetic-refresh-1');
  const verified=await execute(process.execPath,[manage,'verify','zendesk'],{env:{...env(safeHome),HSTACK_CONNECTIONS_FILE:first.path},cwd:root,timeout:40_000});
  assert.match(verified.stdout,/API group read verified/);assert.ok(!verified.stdout.includes(groupName));
  report.checks.actualVendorRefreshAndGroupReadWithLoopbackFixture=true;report.checks.twoGatewaysShareOneRotation=true;
  if(process.env.HSTACK_TEST_HERMES_ROOT&&process.env.HSTACK_TEST_HERMES_PYTHON){
    step='native Hermes registry with synthetic backend';const hermesHome=join(root,'hermes');await mkdir(hermesHome,{mode:0o700});
    await writeFile(join(hermesHome,'config.yaml'),JSON.stringify({mcp_servers:{hstack:{command:process.execPath,args:[serverPath],
      env:{...env(safeHome),HSTACK_CONNECTIONS_FILE:first.path,HSTACK_TOOL_MODE:'search'},connect_timeout:60,timeout:40}}}),{mode:0o600});
    const probe=join(root,'hermes-probe.json');await writeFile(probe,JSON.stringify({source:process.env.HSTACK_TEST_HERMES_ROOT,groupName}),{mode:0o600});
    const native=await execute(process.env.HSTACK_TEST_HERMES_PYTHON,['-I','-B',fileURLToPath(new URL('./verify-hermes-zendesk.py',import.meta.url)),probe],
      {env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:hermesHome},cwd:root,timeout:60_000});
    assert.match(native.stdout,/PASS: native Hermes registry/);report.checks.nativeHermesWithSyntheticBackend=true;
    report.hermesMcpSourceSha256=createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT,'tools/mcp_tool.py'))).digest('hex');
  }
  await assert.rejects(readFile(marker),{code:'ENOENT'});report.checks.noExternalNetworkAttempted=true;report.checks.liveAccountValidated=false;
  if(process.env.HSTACK_ZENDESK_REPORT)await writeFile(process.env.HSTACK_ZENDESK_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(`PASS: real community Zendesk MCP 0.1.6 / MCP 2.3.0; ${tools.length} read-only tools discovered; 14 schemas checked.`);
  console.log('PASS: native plaintext auth failures become explicit errors; unreviewed attachment download blocked.');
  console.log('PASS: direct concurrent refresh race reproduced; two Hstack processes rotate once and both synthetic group reads succeed.');
  if(report.checks.nativeHermesWithSyntheticBackend)console.log('PASS: native Hermes registry reads the synthetic group and blocks an attachment download.');
  console.log('No live Zendesk account, external request, remote write, model or normal agent configuration was used.');
}catch{
  console.error(`Zendesk runtime verification failed during ${step}. Check pinned installation and private setup; raw values and errors hidden.`);process.exitCode=1;
}finally{
  for(const{client,transport}of clients.reverse()){try{await client.close();}catch{}try{await transport.close();}catch{}}
  if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}await rm(root,{recursive:true,force:true});
}
