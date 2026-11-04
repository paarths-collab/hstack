import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../dist/discover-tools.js';

// Accept binaries only, never an existing data directory, connection URL or account.
const execute=promisify(execFile),root=await mkdtemp(join(tmpdir(),'hstack-mysql-'));
const clients=[];let databaseProcess;let step='binary inspection';
let vendorDiagnostics='';const privateValues=[root];
const report={vendor:'googleapis/mcp-toolbox',vendorVersion:'1.15.0',sourceCommit:'8e8e569594a4a864def8598fd3f4977a8d65e431',
  environment:'real disposable authenticated loopback MySQL; synthetic data only; no existing database or model',checks:{}};
const text=result=>result.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n')??'';
const json=result=>JSON.parse(text(result));
// Toolbox emits one JSON TextContent per row, rather than one JSON array.
const rows=result=>(result.content??[]).map(item=>{assert.equal(item.type,'text');return JSON.parse(item.text);});
async function connect(transport){const client=new Client({name:'hstack-mysql-verifier',version:'0'});clients.push({client,transport});await client.connect(transport,{timeout:30_000});return client;}
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function stopDatabase(){
  if(!databaseProcess||databaseProcess.exitCode!==null||databaseProcess.signalCode!==null)return;
  const closed=new Promise(r=>databaseProcess.once('exit',r));databaseProcess.kill('SIGTERM');
  const timer=setTimeout(()=>databaseProcess.kill('SIGKILL'),5_000);try{await closed;}finally{clearTimeout(timer);}
}
try{
  const toolbox=process.env.HSTACK_MYSQL_TOOLBOX,mysqld=process.env.HSTACK_TEST_MYSQLD,mysql=process.env.HSTACK_TEST_MYSQL;
  assert.ok([toolbox,mysqld,mysql].every(path=>path&&isAbsolute(path)),'Supply absolute toolbox, mysqld and mysql binary paths.');
  const manifest=JSON.parse(await readFile(new URL('../integrations/mysql/toolbox-release.json',import.meta.url),'utf8'));
  const platform=manifest.binaries[`${process.platform}-${process.arch}`];assert.ok(platform,'No reviewed Toolbox hash for this platform.');
  report.toolboxSha256=createHash('sha256').update(await readFile(toolbox)).digest('hex');
  const built=manifest.compatibilityBuild.platforms[`${process.platform}-${process.arch}`]?.sha256;
  assert.equal(report.toolboxSha256,built,'Use the reviewed Hstack MySQL compatibility build; official binary has unresolved dependency findings.');
  report.build='Hstack MySQL-only compatibility build; native query code unchanged';
  const inspected=await execute(mysqld,['--no-defaults','--version'],{env:{},timeout:10_000});
  assert.match(inspected.stdout,/MySQL Community Server/);report.databaseVersion=inspected.stdout.match(/Ver ([\d.]+)/)?.[1];
  assert.ok(report.databaseVersion);
  const basedir=join(mysqld,'..','..'),datadir=join(root,'data'),socket=join(root,'mysql.sock');
  await mkdir(datadir,{mode:0o700});
  step='disposable database initialization';
  await execute(mysqld,['--no-defaults','--initialize-insecure',`--basedir=${basedir}`,`--datadir=${datadir}`],{env:{HOME:root},cwd:root,timeout:60_000,maxBuffer:1_000_000});
  const port=await freePort(),rootPassword=randomBytes(24).toString('hex'),password=randomBytes(24).toString('hex');
  privateValues.push(rootPassword,password);
  const database='hstack_synthetic',table='records',column=`probe_${randomBytes(8).toString('hex')}`,value=randomBytes(24).toString('hex');
  const init=join(root,'init.sql');
  await writeFile(init,`ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';
CREATE DATABASE ${database};
CREATE TABLE ${database}.${table} (id INT PRIMARY KEY, ${column} VARCHAR(64) NOT NULL);
INSERT INTO ${database}.${table} VALUES (1,'${value}');
CREATE USER 'hstack_reader'@'127.0.0.1' IDENTIFIED BY '${password}';
GRANT SELECT ON ${database}.* TO 'hstack_reader'@'127.0.0.1';
GRANT SELECT ON performance_schema.* TO 'hstack_reader'@'127.0.0.1';
GRANT SELECT ON sys.* TO 'hstack_reader'@'127.0.0.1';
GRANT EXECUTE ON sys.* TO 'hstack_reader'@'127.0.0.1';
GRANT PROCESS ON *.* TO 'hstack_reader'@'127.0.0.1';
CREATE USER 'hstack_writer'@'127.0.0.1' IDENTIFIED BY '${password}';
GRANT SELECT,INSERT ON ${database}.* TO 'hstack_writer'@'127.0.0.1';
`,{mode:0o600});
  databaseProcess=spawn(mysqld,['--no-defaults',`--basedir=${basedir}`,`--datadir=${datadir}`,`--socket=${socket}`,
    `--port=${port}`,'--bind-address=127.0.0.1','--mysqlx=OFF','--skip-log-bin',`--pid-file=${join(root,'mysql.pid')}`,
    `--log-error=${join(root,'mysql.log')}`,`--init-file=${init}`],{env:{HOME:root},cwd:root,stdio:'ignore'});
  databaseProcess.on('error',()=>{});
  const sql=async(statement,user='root',secret=rootPassword)=>execute(mysql,['--no-defaults','--protocol=TCP','--host=127.0.0.1',`--port=${port}`,
    `--user=${user}`,'--batch','--skip-column-names','--execute',statement],{env:{HOME:root,MYSQL_PWD:secret},cwd:root,timeout:10_000,maxBuffer:1_000_000});
  let ready=false;
  for(let i=0;i<100;i++){
    if(databaseProcess.exitCode!==null||databaseProcess.signalCode!==null)throw new Error('Owned database exited');
    try{await sql('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}
  }
  assert.ok(ready,'Owned database did not start');await rm(init);
  assert.equal((await sql(`SELECT ${column} FROM ${database}.${table}`)).stdout.trim(),value);
  const profile=JSON.parse(await readFile(new URL('../integrations/mysql/connection.json',import.meta.url),'utf8'));
  const env={HSTACK_MYSQL_TOOLBOX:toolbox,MYSQL_HOST:'127.0.0.1',MYSQL_PORT:String(port),MYSQL_DATABASE:database,
    MYSQL_USER:'hstack_reader',MYSQL_PASSWORD:password,MYSQL_QUERY_PARAMS:'{"tls":"false"}',HOME:root};
  step='actual vendor schema discovery';
  const directTransport=new StdioClientTransport({command:toolbox,args:profile.args,env,cwd:root,stderr:'pipe'});
  directTransport.stderr?.on('data',chunk=>{vendorDiagnostics=(vendorDiagnostics+chunk.toString()).slice(-2000);});
  const direct=await connect(directTransport);
  const listing=await listAllTools(direct,AbortSignal.timeout(30_000));
  report.discoveredTools=listing.length;assert.equal(listing.length,9);
  assert.deepEqual(listing.map(t=>t.name).sort(),[...profile.readTools,'execute_sql'].sort());
  report.schemaSha256=createHash('sha256').update(JSON.stringify(listing)).digest('hex');
  step='direct synthetic read';
  const result=await direct.callTool({name:'execute_sql',arguments:{sql:`SELECT ${column} FROM ${database}.${table} WHERE id=1`}});
  assert.ok(!result.isError);assert.equal(rows(result)[0][column],value);
  const reads=[['list_tables',{table_names:table,output_format:'detailed'}],['get_query_plan',{sql_statement:`SELECT * FROM ${database}.${table}`}],
    ...profile.readTools.filter(name=>!['list_tables','get_query_plan'].includes(name)).map(name=>[name,{}])];
  const directResults={};
  step='eight direct diagnostic reads';
  for(const[name,args]of reads){
    step=`direct ${name}`;
    const read=await direct.callTool({name,arguments:args});
    assert.ok(!read.isError,`${name}: vendor read failed`);directResults[name]=rows(read);
  }
  report.checks.eightDirectDiagnosticReads=true;
  const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
  async function launch(user='hstack_reader',writeTools=[]){
    const path=join(root,`connections-${clients.length}.json`);
    await writeFile(path,JSON.stringify({connections:[{...profile,enabled:true,writeTools}]}),{mode:0o600});
    const client=await connect(new StdioClientTransport({command:process.execPath,args:[serverPath],
      env:{...env,MYSQL_USER:user,HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:'search'},cwd:root,stderr:'ignore'}));return{client,path};
  }
  step='gateway diagnostic reads';
  const{client:gateway,path}=await launch();assert.equal((await listAllTools(gateway,AbortSignal.timeout(30_000))).length,2);
  for(const[name,args]of reads){
    step=`gateway ${name}`;
    const found=json(await gateway.callTool({name:'hstack_search_tools',arguments:{service:'mysql',query:name,limit:10}}));
    assert.deepEqual(found.tools.find(item=>item.name===`mysql__${name}`)?.inputSchema,listing.find(t=>t.name===name).inputSchema);
    const read=await gateway.callTool({name:'hstack_call_tool',arguments:{name:`mysql__${name}`,arguments:args}});assert.ok(!read.isError,`${name}: gateway read failed`);
    const parsed=rows(read);if(name==='list_tables')assert.deepEqual(parsed,directResults[name]);
  }
  report.checks.eightGatewayReadsAndSchemas=true;
  step='operational verification and bad password';
  const manage=fileURLToPath(new URL('../dist/manage.js',import.meta.url));
  const verified=await execute(process.execPath,[manage,'verify','mysql'],{env:{...env,HSTACK_CONNECTIONS_FILE:path},cwd:root,timeout:40_000});
  assert.match(verified.stdout,/database schema read verified/);assert.ok(!verified.stdout.includes(column));
  const badPassword=randomBytes(24).toString('hex');
  const failed=await execute(process.execPath,[manage,'verify','mysql'],{env:{...env,MYSQL_PASSWORD:badPassword,HSTACK_CONNECTIONS_FILE:path},cwd:root,timeout:40_000})
    .then(()=>assert.fail('Wrong database credentials must fail'),error=>error);
  assert.equal(failed.code,1);assert.ok(!(failed.stdout+failed.stderr).includes(badPassword));
  report.checks.operationalSchemaReadAndBadPassword=true;
  const insertion={sql:`INSERT INTO ${database}.${table} VALUES (2,'synthetic-explicit-insert')`};
  step='database and Hstack permissions';
  const blocked=await gateway.callTool({name:'hstack_call_tool',arguments:{name:'mysql__execute_sql',arguments:insertion}});
  assert.equal(blocked._meta.hstack.code,'FORBIDDEN');assert.equal(blocked._meta.hstack.outcome,'not_sent');
  const dbDenied=await direct.callTool({name:'execute_sql',arguments:insertion});assert.equal(dbDenied.isError,true);
  assert.equal((await sql(`SELECT COUNT(*) FROM ${database}.${table}`)).stdout.trim(),'1');
  const{client:writer}=await launch('hstack_writer',['execute_sql']);
  const written=await writer.callTool({name:'hstack_call_tool',arguments:{name:'mysql__execute_sql',arguments:insertion}});assert.ok(!written.isError);
  assert.equal((await sql(`SELECT COUNT(*) FROM ${database}.${table}`)).stdout.trim(),'2');
  const dropped=await writer.callTool({name:'hstack_call_tool',arguments:{name:'mysql__execute_sql',arguments:{sql:`DROP TABLE ${database}.${table}`}}});
  assert.equal(dropped.isError,true);assert.equal((await sql(`SELECT COUNT(*) FROM ${database}.${table}`)).stdout.trim(),'2');
  report.checks.defaultSqlBlockedReadRoleDeniesWriteAndExactOptIn=true;
  if(process.env.HSTACK_TEST_HERMES_ROOT&&process.env.HSTACK_TEST_HERMES_PYTHON){
    step='native Hermes registry';const home=join(root,'hermes');await mkdir(home);
    await writeFile(join(home,'config.yaml'),JSON.stringify({mcp_servers:{hstack:{command:process.execPath,args:[serverPath],
      env:{...env,HSTACK_CONNECTIONS_FILE:path,HSTACK_TOOL_MODE:'search'},connect_timeout:60,timeout:40}}}),{mode:0o600});
    const probe=join(root,'hermes-probe.json');await writeFile(probe,JSON.stringify({source:process.env.HSTACK_TEST_HERMES_ROOT,table,column,
      blockedSql:`INSERT INTO ${database}.${table} VALUES (3,'synthetic-native-blocked')`}),{mode:0o600});
    const native=await execute(process.env.HSTACK_TEST_HERMES_PYTHON,['-I','-B',fileURLToPath(new URL('./verify-hermes-mysql.py',import.meta.url)),probe],
      {env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:home},cwd:root,timeout:60_000});
    assert.match(native.stdout,/PASS: native Hermes registry/);assert.equal((await sql(`SELECT COUNT(*) FROM ${database}.${table}`)).stdout.trim(),'2');
    report.checks.nativeHermesRegistry=true;report.hermesMcpSourceSha256=createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT,'tools/mcp_tool.py'))).digest('hex');
  }
  if(process.env.HSTACK_MYSQL_REPORT)await writeFile(process.env.HSTACK_MYSQL_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(`PASS: actual MCP Toolbox 1.15.0 against disposable MySQL ${report.databaseVersion}; nine tools discovered.`);
  console.log('PASS: eight direct and gateway diagnostic reads; schemas preserved and synthetic row read directly.');
  console.log('PASS: arbitrary SQL blocked by default; DB read role denies inserts; exact opt-in inserts synthetic data while DB role denies DROP.');
  console.log('PASS: operational schema read and bad-password rejection.');
  if(report.checks.nativeHermesRegistry)console.log('PASS: native Hermes registry schema read and write-block. No model used.');
  console.log('No existing database, hosted account, normal agent configuration or model was used.');
}catch{
  if(process.env.HSTACK_MYSQL_DIAGNOSTICS){for(const value of privateValues)vendorDiagnostics=vendorDiagnostics.replaceAll(value,'[redacted]');console.error(vendorDiagnostics);}
  console.error(`MySQL verification failed during ${step}. Check pinned binaries and local prerequisites; raw values and errors hidden.`);process.exitCode=1;
}finally{
  for(const{client,transport}of clients.reverse()){try{await client.close();}catch{}try{await transport.close();}catch{}}
  await stopDatabase();await rm(root,{recursive:true,force:true});
}
