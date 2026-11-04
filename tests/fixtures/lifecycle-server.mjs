import { readFile, appendFile } from 'node:fs/promises';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

// All state is supplied by an isolated test directory. Never reads real accounts.
const [statePath, eventsPath] = process.argv.slice(2);
const settings = JSON.parse(await readFile(statePath, 'utf8'));
const record = (event) => appendFile(eventsPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
await record({ event: 'start' });
if (settings.failStart) process.exit(12);
if (settings.stubborn) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const inputSchema = { type: 'object', properties: { action: { type: 'string' }, value: { type: 'string' },
  ...(settings.schemaVersion === 2 ? { version: { type: 'integer' } } : {}),
}, additionalProperties: false };
const tools = [
  { name: 'get_record', description: 'Fixture read', inputSchema, annotations: { readOnlyHint: true } },
  { name: 'write_record', description: 'Fixture mutation', inputSchema, annotations: { readOnlyHint: false } },
];
if (settings.reverseTools) tools.reverse();
if (settings.unsafeAnnotation) tools[0].annotations.readOnlyHint = false;
const server = new Server({ name: 'lifecycle-fixture', version: '0' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler('tools/list', () => settings.hangDiscovery ? new Promise(() => {}) : ({ tools }));
server.setRequestHandler('tools/call', async (request) => {
  const { action = 'read', value } = request.params.arguments ?? {};
  await record({ event: 'call', tool: request.params.name, action, value });
  if (request.params.name === 'write_record') await record({ event: 'mutation', value });
  if (action === 'crash') process.exit(23);
  if (action === 'hang') return new Promise(() => {});
  if (action === 'error') throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'fixture-sensitive-never-log');
  if (action === 'notify') await server.notification({ method: 'notifications/tools/list_changed' });
  return { content: [{ type: 'text', text: 'fixture record' }], _meta: { fixture: true } };
});
await server.connect(new StdioServerTransport());
