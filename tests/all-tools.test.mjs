import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGateway, readTools } from '../dist/gateway.js';

// Synthetic schemas/arguments test routing, not vendor API correctness.
const names = [
  'get_account', 'list_channels', 'get_channel', 'list_posts', 'get_post',
  'list_ideas', 'list_idea_groups', 'create_idea', 'create_post', 'edit_post',
  'delete_post', 'get_aggregated_post_metrics', 'list_post_templates',
  'get_post_template', 'create_post_template', 'update_post_template', 'delete_post_template',
];
const fixtureTools = names.map((name) => ({
  name,
  description: `Synthetic ${name} fixture`,
  inputSchema: {
    type: 'object', properties: { fixture: { type: 'string' } },
    required: ['fixture'], additionalProperties: false,
  },
  annotations: { readOnlyHint: readTools.has(name) },
}));

async function connect(t, call, allowWrites) {
  const server = createGateway(fixtureTools, call, allowWrites);
  const client = new Client({ name: 'fixture', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('all 17 schemas and annotations survive discovery with namespacing', async (t) => {
  const client = await connect(t, async () => { throw new Error('Must not call'); }, false);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  for (const [i, tool] of tools.entries()) {
    assert.equal(tool.name, `buffer__${names[i]}`);
    assert.deepEqual(tool.inputSchema, fixtureTools[i].inputSchema);
    assert.deepEqual(tool.annotations, fixtureTools[i].annotations);
  }
});

for (const name of names) {
  test(`${name}: forwards correct name/arguments and preserves result and quota metadata (fixture)`, async (t) => {
    let calls = 0;
    const args = { fixture: 'synthetic-value' };
    const result = {
      content: [{ type: 'text', text: 'synthetic result' }],
      structuredContent: { fixture: true },
      _meta: { rateLimit: [{ remaining: 3, resetSeconds: 5 }] },
    };
    const client = await connect(t, async (upstreamName, upstreamArgs) => {
      calls++;
      assert.equal(upstreamName, name);
      assert.deepEqual(upstreamArgs, args);
      return result;
    }, true); // Writes enabled only against this in-memory fixture.
    assert.deepEqual(await client.callTool({ name: `buffer__${name}`, arguments: args }), result);
    assert.equal(calls, 1);
  });

  test(`${name}: invalid arguments never reach upstream (fixture)`, async (t) => {
    let calls = 0;
    const client = await connect(t, async () => { calls++; return { content: [] }; }, true);
    assert.equal((await client.callTool({ name: `buffer__${name}`, arguments: {} })).isError, true);
    assert.equal(calls, 0);
  });

  test(`${name}: upstream tool-level errors are preserved (fixture)`, async (t) => {
    const failure = { isError: true, content: [{ type: 'text', text: 'Synthetic rejection' }] };
    const client = await connect(t, async () => failure, true);
    assert.deepEqual(await client.callTool({ name: `buffer__${name}`, arguments: { fixture: 'test' } }), failure);
  });

  if (!readTools.has(name)) {
    test(`${name}: writes blocked by default before upstream call (fixture)`, async (t) => {
      let calls = 0;
      const client = await connect(t, async () => { calls++; return { content: [] }; }, false);
      const result = await client.callTool({ name: `buffer__${name}`, arguments: { fixture: 'test' } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Write tools are disabled/);
      assert.equal(calls, 0);
    });
  }
}
