import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../dist/discover-tools.js';

// Opt-in test of the real installed community MCP process, NOT a Mailchimp API test.
// No .env or real account is read. The test-only Python bootstrap denies network.
const execute = promisify(execFile);
const python = process.env.HSTACK_MAILCHIMP_PYTHON;
const root = await mkdtemp(join(tmpdir(), 'hstack-mailchimp-runtime-'));
const clients = [];
const report = {
  vendor: 'damientilman/mailchimp-mcp-server', vendorVersion: '1.2.0', community: true,
  sourceCommit: 'fcc130a3c42a426816711a5c0099331f1f3fa788',
  environment: 'real vendor MCP process; synthetic key; network denied; no vendor account or model',
  checks: {},
};
const text = (result) => result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
async function connect(transport) {
  const client = new Client({ name:'hstack-mailchimp-runtime-verifier', version:'0' });
  clients.push({ client, transport });
  await client.connect(transport, { timeout:30_000 });
  return client;
}

try {
  assert.ok(python && isAbsolute(python), 'Set HSTACK_MAILCHIMP_PYTHON to the prepared Python 3.12 interpreter.');
  const inspected = await execute(python, ['-I', '-c', `import sys,json,hashlib,importlib.metadata,importlib.util,pathlib
assert sys.version_info[:2] == (3,12)
source = pathlib.Path(importlib.util.find_spec('mailchimp_mcp_server.server').origin).read_bytes()
print(json.dumps({'vendor':importlib.metadata.version('mailchimp-mcp'),'mcp':importlib.metadata.version('mcp'),'sourceBlob':hashlib.sha1(b'blob '+str(len(source)).encode()+b'\\0'+source).hexdigest()}))`], { env:{}, timeout:10_000 });
  const versions = JSON.parse(inspected.stdout);
  assert.equal(versions.vendor, '1.2.0'); assert.equal(versions.mcp, '1.30.0');
  assert.equal(versions.sourceBlob, '724ff7b64bd4bc3f1c6f7a0e0a76a572955949b6', 'Installed source must match reviewed release.');
  report.pythonMcpVersion = versions.mcp; report.sourceBlob = versions.sourceBlob;
  report.lockSha256 = createHash('sha256').update(await readFile(new URL('../integrations/mailchimp/requirements.lock', import.meta.url))).digest('hex');
  const networkMarker = join(root, 'network-denied');
  const bootstrap = `import sys,runpy
def deny_network(event,args):
    if event in ('socket.connect','socket.getaddrinfo'):
        with open(${JSON.stringify(networkMarker)},'w') as marker: marker.write('blocked')
        raise OSError('Network denied by Hstack runtime-only verification')
sys.addaudithook(deny_network)
runpy.run_module('mailchimp_mcp_server.server',run_name='__main__')`;
  const args = ['-I','-c',bootstrap];
  const env = {
    HSTACK_MAILCHIMP_PYTHON:python, MAILCHIMP_API_KEY:'synthetic-hstack-runtime-us1',
    MAILCHIMP_READ_ONLY:'true', MAILCHIMP_MAX_RETRIES:'0', PYTHON_DOTENV_DISABLED:'1',
  };
  const direct = await connect(new StdioClientTransport({ command:python, args, env, cwd:root, stderr:'ignore' }));
  const tools = await listAllTools(direct, AbortSignal.timeout(30_000));
  report.discoveredTools = tools.length;
  report.schemaSha256 = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  const profile = JSON.parse(await readFile(new URL('../integrations/mailchimp/connection.json', import.meta.url), 'utf8'));
  for (const name of [...profile.readTools,'create_campaign','ping']) assert.ok(tools.some((tool) => tool.name === name), `Missing reviewed tool ${name}`);
  assert.ok(!profile.readTools.includes('ping'), 'Broken upstream ping must not be a default read.');
  const described = JSON.parse(text(await direct.callTool({ name:'describe_tools', arguments:{} })));
  for (const name of profile.readTools) assert.equal(described.tools.find((tool) => tool.name === name)?.risk, 'read');
  report.checks.reviewedReadNames = true;
  const accounts = JSON.parse(text(await direct.callTool({ name:'list_accounts', arguments:{} })));
  assert.deepEqual(accounts.accounts, [{ name:'default', read_only:true, dry_run:false, is_default:true }]);
  await assert.rejects(readFile(networkMarker), { code:'ENOENT' });
  report.checks.metadataOnlyReads = true;

  const path = join(root, 'connections.json');
  // Test-only network guard replaces the module entry arguments, not the vendor implementation.
  await writeFile(path, JSON.stringify({ connections:[{ ...profile, enabled:true, args }] }), { mode:0o600 });
  const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));
  const gateway = await connect(new StdioClientTransport({ command:process.execPath, args:[serverPath],
    env:{ ...env, HSTACK_CONNECTIONS_FILE:path, HSTACK_TOOL_MODE:'search' }, cwd:root, stderr:'ignore' }));
  assert.equal((await listAllTools(gateway, AbortSignal.timeout(30_000))).length, 2);
  const found = JSON.parse(text(await gateway.callTool({ name:'hstack_search_tools', arguments:{ service:'mailchimp', query:'list_accounts', limit:1 } })));
  assert.equal(found.tools[0].name, 'mailchimp__list_accounts');
  assert.deepEqual(found.tools[0].inputSchema, tools.find((tool) => tool.name === 'list_accounts').inputSchema);
  const read = await gateway.callTool({ name:'hstack_call_tool', arguments:{ name:'mailchimp__list_accounts', arguments:{} } });
  assert.deepEqual(JSON.parse(text(read)), accounts);
  for (const name of ['create_campaign','ping']) {
    const blocked = await gateway.callTool({ name:'hstack_call_tool', arguments:{ name:`mailchimp__${name}`, arguments:{} } });
    assert.equal(blocked.isError,true); assert.equal(blocked._meta.hstack.code,'FORBIDDEN');
    assert.equal(blocked._meta.hstack.outcome,'not_sent');
  }
  await assert.rejects(readFile(networkMarker), { code:'ENOENT' });
  report.checks.gatewaySearchReadAndWriteBlock = true;
  // Demonstrate the vendor bug and Hstack's bounded result-contract correction.
  const directFailure = await direct.callTool({ name:'list_audiences', arguments:{ count:1, offset:0 } });
  assert.ok(!directFailure.isError);
  assert.equal(JSON.parse(text(directFailure)).total_items,null);
  const corrected = await gateway.callTool({ name:'hstack_call_tool', arguments:{ name:'mailchimp__list_audiences', arguments:{ count:1, offset:0 } } });
  assert.equal(corrected.isError,true); assert.equal(corrected._meta.hstack.code,'UPSTREAM_ERROR');
  assert.match(text(corrected),/do not treat this as an empty account/);
  report.checks.swallowedApiFailureMadeExplicit = true;
  const manage = fileURLToPath(new URL('../dist/manage.js', import.meta.url));
  const failed = await execute(process.execPath, [manage,'verify','mailchimp'], {
    env:{ ...env, HSTACK_CONNECTIONS_FILE:path }, cwd:root, timeout:40_000,
  }).then(() => assert.fail('Network-denied account verification must fail.'), (error) => error);
  assert.equal(failed.code,1); assert.match(failed.stderr,/Mailchimp operational read failed/);
  assert.doesNotMatch(failed.stdout + failed.stderr,/synthetic-hstack-runtime|audiences|total_items/);
  assert.equal(await readFile(networkMarker,'utf8'),'blocked');
  report.checks.networkDeniedOperationalReadRejected = true;
  report.checks.liveAccountValidated = false;
  if (process.env.HSTACK_MAILCHIMP_REPORT) await writeFile(process.env.HSTACK_MAILCHIMP_REPORT, `${JSON.stringify(report,null,2)}\n`, { mode:0o600 });
  console.log(`PASS: real Mailchimp MCP 1.2.0 runtime; ${tools.length} tools discovered; source and SDK pins checked.`);
  console.log('PASS: local metadata reads, Hstack search, schema preservation and default write/broken-ping blocking.');
  console.log('PASS: vendor-swallowed network failure is explicit through Hstack; operational verification rejects it.');
  console.log('No live account, external request, write or model used.');
} catch {
  console.error('Mailchimp runtime verification failed. Check pinned installation and local setup; raw errors and values hidden.');
  process.exitCode=1;
} finally {
  for (const {client,transport} of clients.reverse()) {
    try { await client.close(); } catch { /* continue cleaning other owned children */ }
    try { await transport.close(); } catch { /* SDK shutdown still attempted */ }
  }
  await rm(root,{recursive:true,force:true});
}
