import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { createGateway } from '../dist/gateway.js';
import { getBufferAccount } from '../dist/buffer-account.js';
import { DiscoveryError } from '../dist/discover-tools.js';

const accountTool = { name: 'get_account', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };

async function connect(t, read) {
  const server = createGateway([accountTool], (_name, _args, signal) => read(signal));
  const client = new Client({ name: 'fixture', version: '0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const accountResult = {
  content: [{ type: 'text', text: JSON.stringify({ organizations: [] }) }],
  structuredContent: { organizations: [] },
  _meta: { rateLimit: [{ remaining: 5, resetSeconds: 100 }] },
};

test('gateway exposes one namespaced read-only tool without accessing Buffer during discovery', async (t) => {
  let calls = 0;
  const client = await connect(t, async () => { calls++; return accountResult; });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['buffer__get_account']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(calls, 0);
});

test('gateway preserves result content, structured data and quota metadata', async (t) => {
  const client = await connect(t, async () => accountResult);
  const result = await client.callTool({ name: 'buffer__get_account', arguments: {} });
  assert.deepEqual(result, accountResult);
});

test('gateway preserves upstream tool-level errors', async (t) => {
  const failure = { isError: true, content: [{ type: 'text', text: 'Account unavailable' }] };
  const client = await connect(t, async () => failure);
  assert.deepEqual(await client.callTool({ name: 'buffer__get_account', arguments: {} }), failure);
});

test('gateway rejects unregistered write tools without forwarding', async (t) => {
  let calls = 0;
  const client = await connect(t, async () => { calls++; return accountResult; });
  const result = await client.callTool({ name: 'buffer__create_post', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test('gateway reports safe known errors and hides unexpected exceptions', async (t) => {
  const known = await connect(t, async () => { throw new DiscoveryError('Credential missing'); });
  const unexpected = await connect(t, async () => { throw new Error('fixture-private-value'); });
  const a = await known.callTool({ name: 'buffer__get_account', arguments: {} });
  const b = await unexpected.callTool({ name: 'buffer__get_account', arguments: {} });
  assert.equal(a.isError, true);
  assert.match(a.content[0].text, /Credential missing/);
  assert.equal(b.isError, true);
  assert.ok(!JSON.stringify(b).includes('fixture-private-value'));
});

test('full gateway route invokes upstream get_account over MCP HTTP with empty arguments', async (t) => {
  const calls = [];
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const upstream = new Server({ name: 'fixture-buffer', version: '0' }, { capabilities: { tools: {} } });
    upstream.setRequestHandler('tools/call', (request) => {
      calls.push(request.params);
      return accountResult;
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void upstream.close(); });
    await upstream.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
  const endpoint = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const client = await connect(t, (signal) => getBufferAccount('fixture-only', signal, endpoint));
  const result = await client.callTool({ name: 'buffer__get_account', arguments: {} });
  assert.deepEqual(result, accountResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_account');
  assert.deepEqual(calls[0].arguments, {});
});

test('real stdio entry point fails cleanly without credentials and prints no protocol pollution', async (t) => {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { HSTACK_CONNECTIONS_FILE: new URL('./fixtures/absent-connections.json', import.meta.url).pathname }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /No provider connected.*check\/login/);
});
