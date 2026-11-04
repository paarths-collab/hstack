import { fileURLToPath } from 'node:url';
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/core";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

// Live Buffer read through compact discovery. No credentials/account data printed.
const client = new Client({ name: 'hstack-search-smoke', version: '0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: ['--env-file=.env', 'dist/server.js'],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { HSTACK_TOOL_MODE: 'search', HSTACK_ALLOW_WRITES: 'false', HSTACK_ALLOW_BUFFER_WRITES: 'false' },
});
try {
  await client.connect(transport);
  const listing = await client.listTools();
  if (listing.tools.length !== 2) throw new Error('Unexpected advertised tools');
  const discovery = CallToolResultSchema.parse(await client.callTool({
    name: 'hstack_search_tools', arguments: { query: 'get_account', service: 'buffer', limit: 1 },
  }));
  const text = discovery.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('No tool result');
  const match = ToolSchema.parse(JSON.parse(text.text).tools[0]);
  if (match.name !== 'buffer__get_account') throw new Error('Unexpected selected tool');
  const result = CallToolResultSchema.parse(await client.callTool({
    name: 'hstack_call_tool', arguments: { name: match.name, arguments: {} },
  }));
  if (result.isError || !result.content.some((item) => {
    if (item.type !== 'text') return false;
    try { return Array.isArray(JSON.parse(item.text).organizations); } catch { return false; }
  })) throw new Error('Account read not verified');
  const health = await client.readResource({ uri: 'hstack://connections' });
  const content = health.contents.find((item) => 'text' in item);
  if (!content || !('text' in content)) throw new Error('No health response');
  const status = JSON.parse(content.text).find((item: { id: string }) => item.id === 'buffer');
  if (!status || status.successfulCalls < 1 || status.state !== 'ready') throw new Error('Health did not record success');
  console.log('PASS: two control tools → search Buffer schema → live account read → healthy status.');
  console.log('No account details printed, no writes or paid model calls performed.');
} catch {
  console.error('FAIL: search-mode live verification did not pass.');
  process.exitCode = 1;
} finally { await client.close(); }
