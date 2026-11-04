import type { CallToolResult } from "@modelcontextprotocol/server";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { withMcpClient } from './discover-tools.js';

const bufferEndpoint = new URL('https://mcp.buffer.com/mcp');

/** One read-only upstream call. There is no arbitrary tool-name input. */
export async function getBufferAccount(
  apiKey: string,
  signal?: AbortSignal,
  endpoint = bufferEndpoint, // Dependency injection for local protocol tests only.
): Promise<CallToolResult> {
  return callBufferTool(apiKey, 'get_account', {}, signal, endpoint);
}

/** Called after the gateway checks the discovered tool and its arguments. */
export async function callBufferTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  endpoint = bufferEndpoint,
): Promise<CallToolResult> {
  return withMcpClient(endpoint, apiKey, async (client, deadline) => {
    const result = await client.callTool(
      { name, arguments: args },
      { signal: deadline },
    );
    return CallToolResultSchema.parse(result);
  }, 30_000, signal);
}
