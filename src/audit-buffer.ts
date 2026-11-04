import { fileURLToPath } from 'node:url';
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { readTools } from './gateway.js';

// Live reads only. Never print response bodies, account IDs or credentials.
const client = new Client({ name: 'hstack-buffer-audit', version: '0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--env-file=.env', 'dist/server.js'],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { HSTACK_ALLOW_WRITES: 'false' },
});
const records = new Map<string, string>();

function payloads(result: CallToolResult): unknown[] {
  return [result.structuredContent, ...result.content.flatMap((item) => {
    if (item.type !== 'text') return [];
    try { return [JSON.parse(item.text)]; } catch { return []; }
  })].filter((item) => item !== undefined);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function firstId(values: unknown[], depth = 0): string | undefined {
  if (depth > 5) return undefined;
  for (const value of values) {
    if (object(value) && typeof value.id === 'string') return value.id;
    if (Array.isArray(value)) {
      const found = firstId(value, depth + 1);
      if (found) return found;
    } else if (object(value)) {
      const found = firstId(Object.values(value), depth + 1);
      if (found) return found;
    }
  }
}
async function read(name: string, args: Record<string, unknown>): Promise<unknown[]> {
  const result = CallToolResultSchema.parse(await client.callTool({ name: `buffer__${name}`, arguments: args }));
  records.set(name, result.isError ? 'FAIL: upstream rejected read (details hidden)' : 'PASS: live read');
  if (result.isError) process.exitCode = 1;
  return result.isError ? [] : payloads(result);
}

try {
  await client.connect(transport);
  const catalogue = await client.listTools();
  const tools = catalogue.tools.filter((tool) => tool.name.startsWith('buffer__'));
  console.log(`PASS: ${tools.length} upstream schemas loaded and exposed through Hstack.`);
  const account = await read('get_account', {});
  const orgs = account.find((item) => object(item) && Array.isArray(item.organizations));
  const organizations = object(orgs) ? orgs.organizations : undefined;
  const org = Array.isArray(organizations) && organizations.length === 1 ? organizations[0] : undefined;
  const organizationId = object(org) && typeof org.id === 'string' ? org.id : undefined;
  if (organizationId) {
    const args = { organizationId };
    const channels = await read('list_channels', args);
    const posts = await read('list_posts', { ...args, first: 1 });
    await read('list_ideas', { ...args, first: 1 });
    await read('list_idea_groups', args);
    const templates = await read('list_post_templates', { ...args, first: 1 });
    await read('get_aggregated_post_metrics', {
      ...args, startDateTime: new Date(Date.now() - 7 * 86400_000).toISOString(),
      endDateTime: new Date().toISOString(),
    });
    for (const [name, idKey, values] of [
      ['get_channel', 'channelId', channels],
      ['get_post', 'postId', posts],
      ['get_post_template', 'postTemplateId', templates],
    ] as const) {
      const id = firstId(values);
      if (id) await read(name, { [idKey]: id });
      else records.set(name, 'SKIP: no existing record returned by its list tool');
    }
  }
  for (const tool of tools) {
    const name = tool.name.replace(/^buffer__/, '');
    if (readTools.has(name)) {
      if (!records.has(name)) records.set(name, 'SKIP: one unambiguous organization is required');
      continue;
    }
    const result = CallToolResultSchema.parse(await client.callTool({ name: tool.name, arguments: {} }));
    const blocked = result.isError && result.content.some((item) =>
      item.type === 'text' && item.text.includes('Write tools are disabled'));
    records.set(name, blocked ? 'PASS: default write block; execution tested with fixtures only' : 'FAIL: write block missing');
    if (!blocked) process.exitCode = 1;
  }
  for (const [name, status] of records) console.log(`${name}: ${status}`);
  console.log('Skipped reads and fixture-only writes are NOT live operation verification.');
} catch {
  console.error('FAIL: audit stopped. Check credentials, connection and upstream schema compatibility.');
  process.exitCode = 1;
} finally {
  await client.close();
}
