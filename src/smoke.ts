import { fileURLToPath } from 'node:url';
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

// Opt-in live test: no account data or credential values are printed.
const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'hstack-live-smoke', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--env-file=.env', 'dist/server.js'],
  cwd: root,
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === 'buffer__get_account')) {
    throw new Error('Expected tool missing');
  }
  console.log('PASS: Hstack starts over stdio and exposes buffer__get_account.');
  const result = CallToolResultSchema.parse(await client.callTool({ name: 'buffer__get_account', arguments: {} }));
  if (result.isError) throw new Error('Account read failed');
  const texts = result.content?.filter((item) => item.type === 'text') ?? [];
  const objects = texts.flatMap((item) => {
    try { return [JSON.parse(item.text)]; } catch { return []; }
  });
  const structured = result.structuredContent;
  const account = objects.find((item) => item && Array.isArray(item.organizations))
    ?? (structured && typeof structured === 'object' && 'organizations' in structured && Array.isArray(structured.organizations) ? structured : undefined);
  if (!account) throw new Error('Account response shape not verified');
  console.log('PASS: get_account returned organizations through Hstack → Buffer MCP.');
  console.log('Account details were not printed. No writes were performed.');
} catch {
  console.error('FAIL: live gateway smoke check failed. Check the credential and connection.');
  process.exitCode = 1;
} finally {
  await client.close();
}
