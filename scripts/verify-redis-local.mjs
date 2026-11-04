import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

// Opt-in vendor integration test. Creates its OWN empty loopback Redis instance.
// Never accepts an existing Redis URL, database, password or account credential.
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'hstack-redis-check-'));
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const managePath = fileURLToPath(new URL('../dist/manage.js', import.meta.url));
const python = process.env.HSTACK_REDIS_PYTHON;
const clients = [];
let redis;
let exit;
const report = {
  vendor: 'redis/mcp-redis', version: '0.5.1', python: '3.12',
  environment: 'disposable local Redis; no vendor account or model used',
  checks: {},
};

const text = (result) => result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
async function connect(transport) {
  const client = new Client({ name: 'hstack-redis-local-verifier', version: '0' });
  clients.push({ client, transport });
  await client.connect(transport, { timeout: 30_000 });
  return client;
}
async function closeClient(client) {
  const entry = clients.find((item) => item.client === client);
  try { await client.close(); } finally { await entry.transport.close(); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  assert.ok(python && isAbsolute(python), 'Set HSTACK_REDIS_PYTHON to a prepared Redis MCP Python 3.12 interpreter.');
  const version = await execute(python, ['-I', '-c', 'import sys,importlib.metadata; assert sys.version_info[:2] == (3,12); print(importlib.metadata.version("redis-mcp-server"))'], { timeout: 10_000, env: {} });
  assert.equal(version.stdout.trim(), '0.5.1', 'Prepare the pinned vendor runtime first.');
  const dotenvProbe = join(root, 'probe.env');
  await writeFile(dotenvProbe, 'HSTACK_DOTENV_TEST_SENTINEL=synthetic-only\n', { mode: 0o600 });
  const guarded = await execute(python, ['-I', '-c', 'import os,sys,dotenv; dotenv.load_dotenv(sys.argv[1]); assert "HSTACK_DOTENV_TEST_SENTINEL" not in os.environ; print("guarded")', dotenvProbe], {
    env: { PYTHON_DOTENV_DISABLED: '1' }, timeout: 5000,
  });
  assert.equal(guarded.stdout.trim(), 'guarded'); report.checks.dotenvLoadingDisabled = true;

  const port = await freePort();
  const password = randomBytes(32).toString('hex');
  const config = join(root, 'redis.conf');
  await writeFile(config, `bind 127.0.0.1\nport ${port}\nprotected-mode yes\nsave ""\nappendonly no\ndaemonize no\ndatabases 1\nrequirepass ${password}\ndir ${JSON.stringify(root)}\n`, { mode: 0o600 });
  redis = spawn(process.env.HSTACK_REDIS_SERVER ?? 'redis-server', [config], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  exit = new Promise((resolve, reject) => { redis.once('exit', resolve); redis.once('error', reject); });
  void exit.catch(() => {});
  const cli = async (...args) => (await execute(process.env.HSTACK_REDIS_CLI ?? 'redis-cli', ['--raw', '-h', '127.0.0.1', '-p', String(port), '-n', '0', ...args], {
    env: { PATH: process.env.PATH, REDISCLI_AUTH: password }, timeout: 5000,
  })).stdout.trim();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if (await cli('PING') === 'PONG') { ready = true; break; } } catch { /* wait only for this process */ }
    if (redis.exitCode !== null || redis.signalCode) break;
    await delay(25);
  }
  assert.ok(ready, 'Disposable Redis did not become ready.');
  report.redisVersion = (await execute(process.env.HSTACK_REDIS_SERVER ?? 'redis-server', ['--version'], { env: { PATH: process.env.PATH }, timeout: 5000 })).stdout.trim().match(/v=([\d.]+)/)?.[1];
  const key = `hstack:verification:${randomUUID()}`;
  const value = `synthetic-${randomUUID()}`;
  await cli('SET', key, value, 'EX', '120');
  const vendorEnv = { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port), REDIS_DB: '0', REDIS_PWD: password, REDIS_SSL: 'false', PYTHON_DOTENV_DISABLED: '1' };
  const direct = await connect(new StdioClientTransport({ command: python, args: ['-I', '-m', 'src.main'], cwd: root, env: vendorEnv, stderr: 'ignore' }));
  const listing = await direct.listTools();
  report.discoveredTools = listing.tools.length;
  report.schemaSha256 = createHash('sha256').update(JSON.stringify(listing.tools)).digest('hex');
  report.directDiscoveryBytes = Buffer.byteLength(JSON.stringify(listing));
  const directRead = await direct.callTool({ name: 'get', arguments: { key } });
  assert.ok(!directRead.isError); assert.equal(text(directRead), value);
  report.checks.directRead = true;
  const directKey = `${key}:direct-write`;
  const directWrite = await direct.callTool({ name: 'set', arguments: { key: directKey, value: 'direct fixture', expiration: 120 } });
  assert.ok(!directWrite.isError); assert.equal(await cli('GET', directKey), 'direct fixture');
  report.checks.directVendorAllowsWrite = true;
  await closeClient(direct);

  const template = JSON.parse(await readFile(new URL('../integrations/redis/connection.json', import.meta.url), 'utf8'));
  const path = join(root, 'connections.json');
  const connection = { ...template, enabled: true, command: python };
  await writeFile(path, JSON.stringify({ connections: [connection] }), { mode: 0o600 });
  const launch = (mode = 'search') => new StdioClientTransport({ command: process.execPath,
    args: [serverPath], cwd: root,
    env: { ...vendorEnv, HSTACK_CONNECTIONS_FILE: path, HSTACK_TOOL_MODE: mode }, stderr: 'ignore' });
  const gateway = await connect(launch());
  const controls = await gateway.listTools(); assert.equal(controls.tools.length, 2);
  report.gatewayInitialDiscoveryBytes = Buffer.byteLength(JSON.stringify(controls));
  const found = await gateway.callTool({ name: 'hstack_search_tools', arguments: { service: 'redis', query: 'redis__get', limit: 10 } });
  const matched = JSON.parse(text(found)).tools.find((item) => item.name === 'redis__get');
  assert.ok(matched); assert.deepEqual(matched.inputSchema, listing.tools.find((item) => item.name === 'get').inputSchema);
  report.firstSearchBytes = Buffer.byteLength(JSON.stringify(found));
  const call = (name, args = {}) => gateway.callTool({ name: 'hstack_call_tool', arguments: { name: `redis__${name}`, arguments: args } });
  const read = await call('get', { key }); assert.ok(!read.isError); assert.equal(text(read), value);
  assert.deepEqual(read, directRead);
  report.checks.gatewayReadPreserved = true;
  for (const [name, args] of [['type', { key }], ['scan_keys', { pattern: `${key}*`, count: 100, cursor: 0 }], ['dbsize', {}], ['info', { section: 'server' }]]) {
    const result = await call(name, args);
    assert.ok(!result.isError && !text(result).startsWith('Error'), `Read failed: ${name}`);
    report.checks[name] = true;
  }
  const blockedKey = `${key}:blocked-write`;
  const blocked = await call('set', { key: blockedKey, value: 'must not be stored', expiration: 120 });
  assert.equal(blocked.isError, true); assert.equal(blocked._meta.hstack.code, 'FORBIDDEN');
  assert.equal(await cli('EXISTS', blockedKey), '0');
  report.checks.gatewayBlocksUnapprovedWrite = true;
  const badArgs = await call('get', { key: 123 }); assert.equal(badArgs.isError, true);
  report.checks.gatewayValidatesInputs = true;
  const status = JSON.parse((await gateway.readResource({ uri: 'hstack://connections' })).contents[0].text)[0];
  assert.equal(status.state, 'ready'); assert.ok(status.successfulCalls >= 5);
  report.checks.gatewayHealth = true;
  await closeClient(gateway);
  const verified = await execute(process.execPath, [managePath, 'verify', 'redis'], {
    cwd: root, env: { ...vendorEnv, HSTACK_CONNECTIONS_FILE: path }, timeout: 40_000,
  });
  assert.match(verified.stdout, /database read verified/);
  report.checks.operationalVerification = true;
  const wrongEnv = { ...vendorEnv, REDIS_PWD: `wrong-${randomUUID()}`, HSTACK_CONNECTIONS_FILE: path };
  const discoveryOnly = await execute(process.execPath, [managePath, 'check', 'redis'], { cwd: root, env: wrongEnv, timeout: 40_000 });
  assert.match(discoveryOnly.stdout, /No tool was executed/);
  let rejectedBadPassword = false;
  try { await execute(process.execPath, [managePath, 'verify', 'redis'], { cwd: root, env: wrongEnv, timeout: 40_000 }); }
  catch (error) {
    rejectedBadPassword = error.code === 1 && /operational read failed/.test(error.stderr)
      && !error.stderr.includes(wrongEnv.REDIS_PWD);
  }
  assert.ok(rejectedBadPassword, 'Operational verification must reject wrong database credentials without leaking them.');
  report.checks.badDatabaseCredentialRejected = true;

  // Explicit write opt-in applies ONLY to this newly created disposable database.
  await writeFile(path, JSON.stringify({ connections: [{ ...connection, allowWrites: true }] }), { mode: 0o600 });
  const writable = await connect(launch('forward'));
  const writeKey = `${key}:approved-write`;
  const written = await writable.callTool({ name: 'redis__set', arguments: { key: writeKey, value: 'approved fixture', expiration: 120 } });
  assert.ok(!written.isError); assert.equal(await cli('GET', writeKey), 'approved fixture');
  report.checks.explicitDisposableWrite = true;
  await closeClient(writable);

  if (process.env.HSTACK_TEST_HERMES) {
    // A JSON document is valid YAML; this home and all credentials are disposable.
    const home = join(root, 'hermes'); await (await import('node:fs/promises')).mkdir(home, { mode: 0o700 });
    await writeFile(path, JSON.stringify({ connections: [connection] }), { mode: 0o600 });
    await writeFile(join(home, 'config.yaml'), JSON.stringify({ mcp_servers: { hstack: {
      command: process.execPath, args: [serverPath],
      env: { ...vendorEnv, HSTACK_CONNECTIONS_FILE: path, HSTACK_TOOL_MODE: 'search' }, connect_timeout: 60, timeout: 40,
    } } }), { mode: 0o600 });
    const tested = await execute(process.env.HSTACK_TEST_HERMES, ['mcp', 'test', 'hstack'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: home }, timeout: 60_000, maxBuffer: 1_000_000,
    });
    assert.match(tested.stdout, /Tools discovered: 2/);
    report.checks.nativeHermesDiscovery = true;
    if (process.env.HSTACK_TEST_HERMES_PYTHON && process.env.HSTACK_TEST_HERMES_ROOT) {
      const probePath = join(root, 'hermes-probe.json');
      const hermesBlockedKey = `${key}:hermes-blocked`;
      await writeFile(probePath, JSON.stringify({ source: process.env.HSTACK_TEST_HERMES_ROOT, key, value, blockedKey: hermesBlockedKey }), { mode: 0o600 });
      const native = await execute(process.env.HSTACK_TEST_HERMES_PYTHON, ['-I', fileURLToPath(new URL('./verify-hermes-redis.py', import.meta.url)), probePath], {
        cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: home }, timeout: 60_000, maxBuffer: 1_000_000,
      });
      assert.match(native.stdout, /PASS: native Hermes registry/);
      assert.equal(await cli('EXISTS', hermesBlockedKey), '0');
      report.checks.nativeHermesReadAndWriteBlock = true;
      report.hermesMcpSourceSha256 = createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT, 'tools/mcp_tool.py'))).digest('hex');
    }
  }
  report.limitations = [
    'Real official MCP package and real local Redis; no hosted Redis account, TLS or cluster tested.',
    'Comparison uses SDK clients, not model-driven task accuracy, model cost or onboarding time.',
    'Direct clients can add their own permission policies; default vendor behavior is what was compared.',
    'Only the five reviewed reads and set were executed; other advertised operations remain unverified.',
  ];
  if (process.env.HSTACK_REDIS_REPORT) await writeFile(process.env.HSTACK_REDIS_REPORT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`PASS: official Redis MCP ${report.version}; ${report.discoveredTools} tools discovered.`);
  console.log('PASS: direct/gateway reads match; five reviewed reads, blocked write, explicit disposable write and health verified.');
  if (report.checks.nativeHermesDiscovery) console.log('PASS: native Hermes discovery in a disposable configuration. No model used.');
  if (report.checks.nativeHermesReadAndWriteBlock) console.log('PASS: native Hermes registry search/read/write-block through Hstack. No model used.');
  console.log('Only synthetic data in a new local database was used. No account credentials were loaded.');
} catch (error) {
  console.error('FAIL: local Redis vendor verification did not pass. No vendor/account data is printed.');
  // Assertions mention only fixed checks, not private config, credentials or raw upstream errors.
  if (error instanceof assert.AssertionError) console.error(`Failed check: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  for (const { client, transport } of clients) {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
  if (redis && redis.exitCode === null && !redis.signalCode) {
    redis.kill('SIGTERM');
    const stopped = await Promise.race([exit.then(() => true, () => true), delay(3000, false, { ref: false })]);
    if (!stopped) { redis.kill('SIGKILL'); await exit.catch(() => {}); }
  }
  await rm(root, { recursive: true, force: true });
}
