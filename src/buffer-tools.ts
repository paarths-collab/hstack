import { discoverTools, DiscoveryError } from './discover-tools.js';

// No configurable production URL: never send the Buffer key to an arbitrary host.
const endpoint = new URL('https://mcp.buffer.com/mcp');
const apiKey = process.env.BUFFER_API_KEY ?? '';

try {
  const tools = await discoverTools(endpoint, apiKey);
  console.log(`Discovered ${tools.length} Buffer tools:`);
  for (const tool of tools) console.log(`- ${tool.name}`);
  console.log('Discovery only: no tool was executed.');
} catch (error) {
  console.error(error instanceof DiscoveryError ? error.message : 'Discovery failed.');
  process.exitCode = 1;
}
