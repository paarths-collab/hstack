import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { createSocialGateway } from '../dist/gateway.js';
import { loadProvider, loadSocialPackage, socialProviders } from '../dist/providers.js';

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const result = { content: [{ type: 'text', text: 'synthetic result' }], _meta: { quota: 5 } };

async function clientFor(t, providers) {
  const server = createSocialGateway(providers);
  const client = new Client({ name: 'fixture', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

function fixture(id, call, allowWrites = false) {
  return {
    id, label: id, tools: [{ name: 'get_account', inputSchema: schema },
      { name: 'create_post', inputSchema: schema }],
    readTools: new Set(['get_account']), allowWrites, call,
  };
}

test('one gateway aggregates all five services without same-name collisions', async (t) => {
  const calls = [];
  const client = await clientFor(t, socialProviders.map((definition) => fixture(definition.id, async (name, args) => {
    calls.push({ provider: definition.id, name, args });
    return result;
  })));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  for (const { id } of socialProviders) {
    assert.deepEqual(await client.callTool({ name: `${id}__get_account`, arguments: { text: id } }), result);
  }
  assert.deepEqual(calls.map((call) => call.provider), socialProviders.map((definition) => definition.id));
  assert.deepEqual(calls.map((call) => call.args.text), socialProviders.map((definition) => definition.id));
});

test('failure of one provider call leaves other providers usable', async (t) => {
  const client = await clientFor(t, [
    fixture('buffer', async () => { throw new Error('fixture-secret'); }),
    fixture('pallyy', async () => result),
  ]);
  const failed = await client.callTool({ name: 'buffer__get_account', arguments: { text: 'test' } });
  assert.equal(failed.isError, true);
  assert.ok(!JSON.stringify(failed).includes('fixture-secret'));
  assert.deepEqual(await client.callTool({ name: 'pallyy__get_account', arguments: { text: 'test' } }), result);
});

test('writes enabled for one provider do not enable another provider', async (t) => {
  const called = [];
  const client = await clientFor(t, [
    fixture('buffer', async () => { called.push('buffer'); return result; }, true),
    fixture('pallyy', async () => { called.push('pallyy'); return result; }),
  ]);
  assert.deepEqual(await client.callTool({ name: 'buffer__create_post', arguments: { text: 'test' } }), result);
  assert.equal((await client.callTool({ name: 'pallyy__create_post', arguments: { text: 'test' } })).isError, true);
  assert.deepEqual(called, ['buffer']);
});

test('only explicitly configured services are contacted and discovery failures are isolated', async () => {
  const calls = [];
  const { providers, failed } = await loadSocialPackage({ BUFFER_API_KEY: 'fixture-a', PALLYY_API_KEY: 'fixture-b' }, async (definition, key) => {
    calls.push([definition.id, key]);
    if (definition.id === 'pallyy') throw new Error('fixture failure');
    return fixture(definition.id, async () => result);
  });
  assert.deepEqual(calls, [['buffer', 'fixture-a'], ['pallyy', 'fixture-b']]);
  assert.deepEqual(providers.map((provider) => provider.id), ['buffer']);
  assert.deepEqual(failed, ['pallyy']);
});

test('no configured credentials means no upstream request', async () => {
  const outcome = await loadSocialPackage({}, async () => { throw new Error('Must not run'); });
  assert.deepEqual(outcome, { providers: [], failed: [] });
});

test('legacy global write flag applies only to Buffer', async () => {
  const flags = [];
  await loadSocialPackage({ BUFFER_API_KEY: 'fixture-a', PALLYY_API_KEY: 'fixture-b', HSTACK_ALLOW_WRITES: 'true' }, async (definition, _key, allowWrites) => {
    flags.push([definition.id, allowWrites]);
    return fixture(definition.id, async () => result, allowWrites);
  });
  assert.deepEqual(flags, [['buffer', true], ['pallyy', false]]);
});

test('duplicate provider IDs and tool names are rejected', () => {
  const provider = fixture('buffer', async () => result);
  assert.throws(() => createSocialGateway([provider, provider]), /Duplicate/);
  assert.throws(() => createSocialGateway([{ ...provider, tools: [provider.tools[0], provider.tools[0]] }]), /duplicate/);
});

test('unreviewed tool remains blocked even if upstream calls it read-only', async (t) => {
  let calls = 0;
  const provider = fixture('metricool', async () => { calls++; return result; });
  provider.tools = [{ name: 'new_unreviewed_tool', inputSchema: schema, annotations: { readOnlyHint: true } }];
  provider.readTools = new Set();
  const client = await clientFor(t, [provider]);
  assert.equal((await client.callTool({ name: 'metricool__new_unreviewed_tool', arguments: { text: 'test' } })).isError, true);
  assert.equal(calls, 0);
});

test('per-provider write opt-in is passed only to the named service', async () => {
  const flags = [];
  await loadSocialPackage({ BUFFER_API_KEY: 'fixture-a', PALLYY_API_KEY: 'fixture-b', HSTACK_ALLOW_PALLYY_WRITES: 'true' }, async (definition, _key, allowWrites) => {
    flags.push([definition.id, allowWrites]);
    return fixture(definition.id, async () => result, allowWrites);
  });
  assert.deepEqual(flags, [['buffer', false], ['pallyy', true]]);
});

for (const definition of socialProviders) {
  test(`${definition.id}: actual HTTP discovery and call use only its required credential header (fixture)`, async (t) => {
    let discovery = 0;
    let calls = 0;
    const key = `fixture-${definition.id}-not-real`;
    const http = createServer(async (req, res) => {
      const expected = definition.bearer ? `Bearer ${key}` : key;
      assert.equal(req.headers[definition.header.toLowerCase()], expected);
      if (definition.header.toLowerCase() !== 'authorization') assert.equal(req.headers.authorization, undefined);
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const upstream = new Server({ name: 'fixture', version: '0' }, { capabilities: { tools: {} } });
      upstream.setRequestHandler('tools/list', () => {
        discovery++;
        return { tools: [{ name: 'get_account', inputSchema: schema }] };
      });
      upstream.setRequestHandler('tools/call', (request) => {
        calls++;
        assert.equal(request.params.name, 'get_account');
        assert.deepEqual(request.params.arguments, { text: 'fixture' });
        return result;
      });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void upstream.close(); });
      await upstream.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
    const provider = await loadProvider({ ...definition, endpoint: `http://127.0.0.1:${http.address().port}/mcp`, readTools: new Set(['get_account']) }, key);
    const client = await clientFor(t, [provider]);
    assert.equal((await client.listTools()).tools[0].name, `${definition.id}__get_account`);
    assert.deepEqual(await client.callTool({ name: `${definition.id}__get_account`, arguments: { text: 'fixture' } }), result);
    assert.equal(discovery, 1);
    assert.equal(calls, 1);
  });
}
