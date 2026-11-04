import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server, createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConnection, parseConnections } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { withRemoteClient, listAllTools } from '../dist/discover-tools.js';

async function modernHttp(t) {
  const seen = { eras: [], calls: 0, headers: [] };
  const tool = { name: 'get_record', inputSchema: { type: 'object', properties: {
    region: { type: 'string', 'x-mcp-header': 'Region' }, id: { type: 'string' },
  }, required: ['region', 'id'], additionalProperties: false }, annotations: { readOnlyHint: true } };
  const result = { content: [{ type: 'text', text: 'modern fixture' }], structuredContent: { source: 'modern' }, _meta: { fixture: true } };
  const handler = createMcpHandler(({ era }) => {
    seen.eras.push(era);
    const server = new Server({ name: 'modern-fixture', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({ tools: [tool, { name: 'write_record', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler('tools/call', (request) => {
      seen.calls++; assert.equal(request.params.name, 'get_record');
      assert.deepEqual(request.params.arguments, { region: 'region-one', id: 'fixture-id' });
      return result;
    });
    return server;
  }, { legacy: 'reject' });
  const handle = toNodeHandler(handler);
  const http = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    seen.headers.push(req.headers['mcp-param-region']);
    void handle(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); await handler.close(); });
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  const config = { id: 'modern', label: 'Modern fixture', enabled: true, transport: 'http', url,
    protocol: '2026-07-28', headers: { Authorization: { env: 'FIXTURE_TOKEN', prefix: 'Bearer ' } }, readTools: ['get_record'], allowWrites: false };
  return { seen, tool, result, url, config };
}

test('modern-only HTTP upstream: discovery, schema header routing on reused calls, preserved results and write guard', async (t) => {
  const f = await modernHttp(t);
  const direct = new Client({ name: 'fixture', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let expected;
  try {
    await direct.connect(new StreamableHTTPClientTransport(new URL(f.url), { requestInit: { headers: { Authorization: 'Bearer fixture-only' } } }));
    expected = await direct.callTool({ name: 'get_record', arguments: { region: 'region-one', id: 'fixture-id' } }, { toolDefinition: f.tool });
  } finally { await direct.close(); }
  const provider = await loadConnection(f.config, { FIXTURE_TOKEN: 'fixture-only' });
  t.after(() => provider.close());
  assert.deepEqual(provider.tools[0].inputSchema, f.tool.inputSchema);
  const gateway = createSocialGateway([provider]), client = new Client({ name: 'fixture', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await gateway.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await gateway.close(); });
  const result = await client.callTool({ name: 'modern__get_record', arguments: { region: 'region-one', id: 'fixture-id' } });
  assert.deepEqual(result, expected);
  assert.deepEqual(result.content, f.result.content);
  assert.deepEqual(await client.callTool({ name: 'modern__get_record', arguments: { region: 'region-one', id: 'fixture-id' } }), expected);
  const blocked = await client.callTool({ name: 'modern__write_record', arguments: {} });
  assert.equal(blocked.isError, true); assert.equal(blocked._meta.hstack.outcome, 'not_sent');
  assert.equal(f.seen.calls, 3); // one direct comparison read, two gateway reads
  assert.ok(f.seen.eras.length >= 2 && f.seen.eras.every((era) => era === 'modern'));
  assert.equal(f.seen.headers.filter(value => value === 'region-one').length, 3, 'Every reused call must mirror its per-tool header');
});

test('HTTP auto negotiation reaches a modern-only server without a legacy initialize', async (t) => {
  const f = await modernHttp(t);
  const { protocol, ...config } = f.config;
  const provider = await loadConnection(config, { FIXTURE_TOKEN: 'fixture-only' });
  try { assert.equal(provider.tools.length, 2); assert.ok(f.seen.eras.every((era) => era === 'modern')); }
  finally { await provider.close(); }
});

test('Hstack real stdio entry serves both protocol generations over an unchanged legacy upstream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-protocol-2026-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'connections.json');
  await writeFile(path, JSON.stringify({ connections: [{ id: 'fixture', label: 'Fixture', enabled: true, transport: 'stdio',
    command: process.execPath, args: [resolve('tests/fixtures/echo-server.mjs')], readTools: ['get_record'], allowWrites: false,
  }] }));
  for (const mode of ['legacy', { pin: '2026-07-28' }]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.js')], env: { HSTACK_CONNECTIONS_FILE: path }, stderr: 'ignore' });
    const client = new Client({ name: 'fixture', version: '0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern');
      assert.equal((await client.listTools()).tools[0].name, 'fixture__get_record');
      assert.equal((await client.callTool({ name: 'fixture__get_record', arguments: {} })).content[0].text, 'synthetic record');
    } finally { await client.close(); await transport.close(); }
  }
});

test('no-tools upstream returns an empty catalogue without SDK debug text on protocol stdout', async (t) => {
  const handler = createMcpHandler(() => new Server({ name: 'no-tools', version: '0' }, { capabilities: {} }), { legacy: 'reject' });
  const http = createServer(toNodeHandler(handler));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); await handler.close(); });
  const logs = [], prior = console.debug; console.debug = (...args) => logs.push(args.join(' '));
  try {
    const tools = await withRemoteClient(new URL(`http://127.0.0.1:${http.address().port}/mcp`), { label: 'Fixture', credentialEnv: 'none', headers: {} }, listAllTools);
    assert.deepEqual(tools, []); assert.deepEqual(logs, []);
  } finally { console.debug = prior; }
});

test('protocol selection rejects unsupported modes rather than silently downgrading', () => {
  assert.throws(() => parseConnections({ connections: [{ id: 'fixture', label: 'Fixture', enabled: false, transport: 'http', url: 'https://example.invalid', protocol: 'latest', readTools: [], allowWrites: false }] }), /protocol selection/);
});
