import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { LocalConnection } from '../dist/local-connection.js';
import { loadConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';

async function until(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) assert.fail('Fixture condition did not arrive within deadline');
    await delay(10);
  }
}
async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state.json'), events = join(root, 'events.jsonl');
  await writeFile(state, JSON.stringify(settings)); await writeFile(events, '');
  let now = 0;
  const launch = { label: 'Fixture', command: process.execPath, args: [resolve('tests/fixtures/lifecycle-server.mjs'), state, events], env: {} };
  const local = new LocalConnection(launch, { now: () => now });
  t.after(() => local.close());
  const entries = async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const lastPid = async () => (await entries()).filter((entry) => entry.event === 'start').at(-1).pid;
  const kill = async () => { process.kill(await lastPid(), 'SIGKILL'); await until(() => local.status().state === 'backoff'); };
  return { local, launch, root, state, events, entries, lastPid, kill, advance: (ms = 30_001) => { now += ms; } };
}
const signal = () => AbortSignal.timeout(5000);

test('idle child death is detected, status reports backoff, and concurrent new calls share one reconnect', async (t) => {
  const f = await fixture(t);
  await f.local.discover(); await f.kill();
  assert.equal(f.local.status().consecutiveFailures, 1);
  await assert.rejects(f.local.call('get_record', {}, signal()), (error) => error.details.code === 'UNAVAILABLE' && error.details.outcome === 'not_sent' && error.details.retryAfterSeconds === 1);
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 1);
  f.advance();
  const results = await Promise.all([f.local.call('get_record', {}, signal()), f.local.call('get_record', {}, signal())]);
  assert.ok(results.every((result) => result.content[0].text === 'fixture record'));
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 2);
  assert.equal(f.local.status().reconnects, 1);
  assert.equal(f.local.status().consecutiveFailures, 0);
});

test('lost response after mutation is outcome unknown; reconnect never replays that operation', async (t) => {
  const f = await fixture(t);
  await f.local.discover();
  await assert.rejects(f.local.call('write_record', { action: 'crash', value: 'fixture mutation' }, signal()), (error) => error.details.code === 'UNAVAILABLE' && error.details.outcome === 'unknown');
  f.advance();
  await f.local.call('get_record', {}, signal());
  const entries = await f.entries();
  assert.equal(entries.filter((entry) => entry.event === 'mutation').length, 1);
  assert.equal(entries.filter((entry) => entry.event === 'call' && entry.tool === 'write_record').length, 1);
});

test('cancelled queued call is never sent and does not interrupt the active operation', async (t) => {
  const f = await fixture(t);
  await f.local.discover();
  const activeAbort = new AbortController();
  const active = f.local.call('get_record', { action: 'hang' }, activeAbort.signal);
  const activeRejected = assert.rejects(active, (error) => error.details.code === 'CANCELLED' && error.details.outcome === 'unknown');
  await until(async () => (await f.entries()).some((entry) => entry.event === 'call'));
  const queuedAbort = new AbortController();
  const queued = f.local.call('write_record', { value: 'must never be sent' }, queuedAbort.signal);
  queuedAbort.abort();
  await assert.rejects(queued, (error) => error.details.code === 'CANCELLED' && error.details.outcome === 'not_sent');
  assert.equal(f.local.status().state, 'ready');
  assert.equal((await f.entries()).filter((entry) => entry.event === 'call').length, 1);
  activeAbort.abort(); await activeRejected;
  await f.local.close();
  assert.equal((await f.entries()).filter((entry) => entry.event === 'mutation').length, 0);
});

test('timeout after dispatch retires the child, distinguishes unknown outcome, and permits a new request', async (t) => {
  const f = await fixture(t);
  await f.local.discover();
  await assert.rejects(f.local.call('get_record', { action: 'hang' }, AbortSignal.timeout(100)), (error) => error.details.code === 'TIMEOUT' && error.details.outcome === 'unknown');
  await until(() => f.local.status().state === 'backoff'); f.advance();
  await f.local.call('get_record', {}, signal());
  assert.equal(f.local.status().reconnects, 1);
});

test('schema or annotations changed after reconnect blocks all stale catalogue calls until restart', async (t) => {
  for (const settings of [{ schemaVersion: 2 }, { unsafeAnnotation: true }]) {
    const f = await fixture(t);
    await f.local.discover(); await f.kill(); f.advance();
    await writeFile(f.state, JSON.stringify(settings));
    await assert.rejects(f.local.call('get_record', {}, signal()), (error) => error.details.recovery === 'restart_hstack' && error.details.outcome === 'not_sent');
    assert.equal(f.local.status().state, 'catalogue_changed');
    await assert.rejects(f.local.call('get_record', {}, signal()), /catalogue changed/);
    assert.equal((await f.entries()).filter((entry) => entry.event === 'call').length, 0);
    await f.local.close();
  }
});

test('tool ordering alone does not invalidate equivalent catalogue on reconnect', async (t) => {
  const f = await fixture(t);
  await f.local.discover(); await f.kill(); f.advance();
  await writeFile(f.state, JSON.stringify({ reverseTools: true }));
  await f.local.call('get_record', {}, signal());
  assert.equal(f.local.status().state, 'ready');
});

test('upstream tool-list notification invalidates catalogue and stops later calls', async (t) => {
  const f = await fixture(t);
  await f.local.discover();
  await f.local.call('get_record', { action: 'notify' }, signal()).catch(() => {});
  await until(() => f.local.status().state === 'catalogue_changed');
  await assert.rejects(f.local.call('get_record', {}, signal()), (error) => error.details.recovery === 'restart_hstack');
});

test('protocol tool errors stay sanitized without restarting a healthy child', async (t) => {
  const f = await fixture(t);
  await f.local.discover();
  await assert.rejects(f.local.call('get_record', { action: 'error' }, signal()), (error) => error.details.code === 'UPSTREAM_ERROR' && !error.message.includes('fixture-sensitive'));
  assert.equal(f.local.status().state, 'ready');
  await f.local.call('get_record', {}, signal());
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 1);
});

test('repeated failed reconnections back off exponentially without a background spawn loop', async (t) => {
  const f = await fixture(t);
  await f.local.discover(); await f.kill(); f.advance();
  await writeFile(f.state, JSON.stringify({ failStart: true }));
  await assert.rejects(f.local.call('get_record', {}, signal()));
  assert.equal(f.local.status().consecutiveFailures, 2);
  f.advance(400);
  await assert.rejects(f.local.call('get_record', {}, signal()));
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 2);
  f.advance(101);
  await assert.rejects(f.local.call('get_record', {}, signal()));
  assert.equal(f.local.status().consecutiveFailures, 3);
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 3);
});

test('shutdown kills a stubborn owned child, rejects queued operations and never reconnects after close', async (t) => {
  const f = await fixture(t, { stubborn: true });
  await f.local.discover();
  const pid = await f.lastPid();
  const active = f.local.call('get_record', { action: 'hang' }, signal());
  const activeRejected = assert.rejects(active);
  await until(async () => (await f.entries()).some((entry) => entry.event === 'call'));
  const queued = f.local.call('write_record', {}, signal());
  const queuedRejected = assert.rejects(queued);
  await f.local.close(); await Promise.all([activeRejected, queuedRejected]);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal(f.local.status().state, 'closed');
  await assert.rejects(f.local.call('get_record', {}, signal()));
  assert.equal((await f.entries()).filter((entry) => entry.event === 'start').length, 1);
  assert.equal((await f.entries()).filter((entry) => entry.event === 'mutation').length, 0);
});

test('configured local child lifecycle appears through gateway health and recovery keeps other services usable', async (t) => {
  const f = await fixture(t);
  const provider = await loadConnection({ id: 'fixture', ...f.launch, enabled: true, transport: 'stdio', readTools: ['get_record'], allowWrites: false }, {});
  t.after(() => provider.close());
  const healthy = { id: 'healthy', label: 'Healthy', tools: [{ name: 'get_record', inputSchema: { type: 'object' } }], readTools: new Set(['get_record']), allowWrites: false,
    call: async () => ({ content: [{ type: 'text', text: 'healthy fixture' }] }) };
  const gateway = createSocialGateway([provider, healthy]), client = new Client({ name: 'fixture', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await gateway.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await gateway.close(); });
  process.kill(await f.lastPid(), 'SIGKILL');
  await until(() => provider.lifecycle().state === 'backoff');
  const health = await client.readResource({ uri: 'hstack://connections' });
  const status = JSON.parse(health.contents[0].text).find((item) => item.id === 'fixture');
  assert.equal(status.state, 'unavailable'); assert.equal(status.lifecycle.state, 'backoff');
  assert.ok(!health.contents[0].text.includes(f.root));
  assert.equal((await client.callTool({ name: 'healthy__get_record', arguments: {} })).content[0].text, 'healthy fixture');
  const blocked = await client.callTool({ name: 'fixture__write_record', arguments: {} }); assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /connections.json.*allowWrites/);
  assert.equal(blocked._meta.hstack.outcome, 'not_sent');
  assert.equal(blocked._meta.hstack.code, 'FORBIDDEN');
  await delay(300);
  assert.equal((await client.callTool({ name: 'fixture__get_record', arguments: {} })).content[0].text, 'fixture record');
});

test('SIGTERM or downstream EOF during startup cancels discovery and cleans up its local MCP child', async (t) => {
  for (const shutdown of ['signal', 'eof']) {
    const f = await fixture(t, { hangDiscovery: true });
    const path = join(f.root, 'connections.json');
    await writeFile(path, JSON.stringify({ connections: [{ id: 'fixture', ...f.launch, enabled: true, transport: 'stdio', readTools: ['get_record'], allowWrites: false }] }));
    const child = spawn(process.execPath, ['dist/server.js'], { env: { HSTACK_CONNECTIONS_FILE: path }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { child.once('close', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
    let stdout = ''; child.stdout.on('data', (part) => { stdout += part; }); child.stderr.resume();
    // A client initialization arrives before upstream discovery finishes.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } })}\n`);
    await until(async () => (await f.entries()).some((entry) => entry.event === 'start'));
    const ownedPid = await f.lastPid();
    if (shutdown === 'signal') child.kill('SIGTERM'); else child.stdin.end();
    const result = await Promise.race([closed, delay(5000, undefined, { ref: false }).then(() => assert.fail('Hstack did not stop after startup cancellation'))]);
    assert.equal(result.code, 0);
    assert.equal(stdout, '');
    await until(() => { try { process.kill(ownedPid, 0); return false; } catch { return true; } });
  }
});

test('real stdio launch preserves initialization buffered during discovery and EOF closes upstream child', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'connections.json');
  await writeFile(path, JSON.stringify({ connections: [{ id: 'fixture', ...f.launch, enabled: true, transport: 'stdio', readTools: ['get_record'], allowWrites: false }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { HSTACK_CONNECTIONS_FILE: path }, stderr: 'ignore' });
  const client = new Client({ name: 'fixture', version: '0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 2);
  assert.equal((await client.callTool({ name: 'fixture__get_record', arguments: {} })).content[0].text, 'fixture record');
  const pid = await f.lastPid();
  await client.close();
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});


test('stdio request bursts are bounded and draining restores capacity', async t => {
  const f=await fixture(t);await f.local.discover();
  const results=await Promise.allSettled(Array.from({length:65},()=>f.local.call('get_record',{},AbortSignal.timeout(10_000))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,64);
  const rejected=results.filter(r=>r.status==='rejected');assert.equal(rejected.length,1);
  assert.equal(rejected[0].reason.details.outcome,'not_sent');
  assert.equal((await f.entries()).filter(e=>e.event==='call').length,64);
  await f.local.call('get_record',{},signal());
  assert.equal((await f.entries()).filter(e=>e.event==='call').length,65);
});
