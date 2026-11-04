import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { DiscoveryError } from './discover-tools.js';

type ToolCaller = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;

import { bufferReads } from './providers.js';
import type { LoadedProvider } from './providers.js';
import type { ConnectionStatus } from './runtime.js';
import { GatewayRuntime } from './runtime.js';
import { compileToolSchema } from './tool-schema.js';

// Kept for the original Buffer experiment and tests.
export const readTools = bufferReads;

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Preserve discovered JSON Schemas directly instead of translating to Zod. */
export function createGateway(tools: Tool[], call: ToolCaller, allowWrites = false): Server {
  return createSocialGateway([{ id: 'buffer', label: 'Buffer', tools, call,
    readTools: bufferReads, allowWrites }]);
}

/** Aggregate independent upstreams under service__tool names. */
export function createSocialGateway(providers: LoadedProvider[], options: {
  toolMode?: 'forward' | 'search'; failed?: string[]; runtime?: GatewayRuntime;
  refresh?: () => Promise<LoadedProvider[]>; readOnly?: boolean;
  unavailableStatus?: () => ConnectionStatus[];
} = {}): Server {
  const server = new Server({ name: 'hstack', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } });
  const runtime = options.runtime ?? new GatewayRuntime(providers, options.failed);
  const validator = new AjvJsonSchemaValidator();
  const ids = new Set<string>();
  const routes = new Map<string, {
    provider: LoadedProvider; tool: Tool;
    validate: ReturnType<AjvJsonSchemaValidator['getValidator']>;
  }>();
  const rebuild = (current: LoadedProvider[]) => {
    routes.clear(); ids.clear();
    for (const provider of current) {
      if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || ids.has(provider.id)) {
        throw new DiscoveryError('Duplicate or invalid provider ID.');
      }
      ids.add(provider.id);
      for (const tool of provider.tools) {
        const name = `${provider.id}__${tool.name}`;
        if (routes.has(name)) throw new DiscoveryError('Upstream returned duplicate tool names.');
        routes.set(name, { provider, tool, validate: compileToolSchema(provider.schemaValidator ?? validator, tool.inputSchema) });
      }
    }
  };
  rebuild(providers);
  // Desktop uses stable search controls; serialize refresh and calls so removal
  // never closes an upstream while an earlier call is still using it.
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const fresh = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!options.refresh) return operation();
    if(pending>=64)return Promise.reject(new DiscoveryError('Desktop request queue is full. Retry later.',{code:'UNAVAILABLE',outcome:'not_sent',recovery:'retry_later'}));
    pending++;
    const next = tail.then(async () => {
      if (signal?.aborted) throw new DiscoveryError('Desktop request cancelled.', { code: 'CANCELLED' });
      const current = await options.refresh!();
      if (current !== providers) {
        rebuild(current); providers = current; runtime.replaceProviders(current);
      }
      return operation();
    });
    tail = next.then(() => {pending--;}, () => {pending--;});
    return next;
  };
  const exposedTools = () => [...routes].map(([name, { tool, provider }]) => ({
      ...tool, name,
      description: !provider.readTools.has(tool.name) && (options.readOnly || (!provider.writeTools?.has(tool.name) && !provider.allowWrites))
        ? `[Writes or unreviewed operations disabled in Hstack] ${tool.description ?? tool.name}`
        : tool.description,
    }));
  const controls: Tool[] = [{
    name: 'hstack_search_tools', description: 'Find tools by task or service. Returns their full input schemas and write restrictions. Search before calling a tool.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1 }, service: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 },
    }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, {
    name: 'hstack_call_tool', description: 'Call a tool found through hstack_search_tools using its exact namespaced name and input schema. Hstack enforces service permissions.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false },
    annotations: { readOnlyHint: options.readOnly === true, destructiveHint: options.readOnly !== true },
  }];
  const controlValidators = controls.map((tool) => compileToolSchema(validator, tool.inputSchema));
  server.setRequestHandler('resources/list', async () => ({ resources: [{
    uri: 'hstack://connections', name: 'Hstack connection health', mimeType: 'application/json',
    description: 'Connection availability, error codes and rate-limit cooldowns. No credentials or account content.',
  }] }));
  server.setRequestHandler('resources/read', async (request) => fresh(async () => {
    if (request.params.uri !== 'hstack://connections') throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown Hstack resource.');
    return { contents: [{ uri: 'hstack://connections', mimeType: 'application/json', text: JSON.stringify([...runtime.snapshot(), ...(options.unavailableStatus?.() ?? []).filter(s => !providers.some(p => p.id === s.id))]) }] };
  }));
  server.setRequestHandler('tools/list', async () => ({ tools: options.toolMode === 'search' ? controls : exposedTools() }));
  server.setRequestHandler('tools/call', async (request, ctx) => fresh(async () => {
    let name = request.params.name;
    let args = request.params.arguments ?? {};
    if (options.toolMode === 'search') {
      const index = controls.findIndex((tool) => tool.name === name);
      if (index < 0) return failure('Use hstack_search_tools and hstack_call_tool in search mode.');
      if (!controlValidators[index]!(args).valid) return failure('Invalid Hstack control arguments.');
      if (name === 'hstack_search_tools') {
        const words = (args.query as string).toLowerCase().match(/[a-z0-9]+/g) ?? [];
        const matches = exposedTools().filter((tool) => !args.service || tool.name.startsWith(`${args.service}__`))
          .map((tool) => ({ tool, score: words.reduce((score, word) => {
            const text = `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase();
            return score + (tool.name.toLowerCase().includes(word) ? 3 : text.includes(word) ? 1 : 0);
          }, 0) }))
          .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .slice(0, (args.limit as number | undefined) ?? 5).map((item) => item.tool);
        return { content: [{ type: 'text', text: JSON.stringify({ tools: matches }) }] };
      }
      name = args.name as string;
      args = args.arguments as Record<string, unknown>;
    }
    const route = routes.get(name);
    if (!route) return failure('Unknown Hstack tool. Refresh the tool list.');
    const { provider, tool } = route;
    if (!provider.readTools.has(tool.name) && (options.readOnly || (!provider.writeTools?.has(tool.name) && !provider.allowWrites))) {
      const instruction = options.readOnly ? 'This Desktop connection is read-only; publishing and unreviewed operations are unavailable.' : provider.permissionSource === 'connection'
        ? `Review this connection in your private connections.json and add the exact tool name to writeTools, then restart Hstack. allowWrites: true permits every operation.`
        : `Explicitly enable HSTACK_ALLOW_${provider.id.toUpperCase()}_WRITES=true before using writes or unreviewed operations.`;
      return { ...failure(`Write tools are disabled for ${provider.label}. ${instruction}`),
        _meta: { hstack: { service: provider.id, code: 'FORBIDDEN', outcome: 'not_sent' } } };
    }
    if (!route.validate(args).valid) return failure('Invalid tool arguments. Check the tool input schema.');
    try {
      return await runtime.call(provider, tool.name, args, ctx.mcpReq.signal);
    } catch (error) {
      const result = failure(error instanceof DiscoveryError
        ? error.message
        : `${provider.label} tool call failed. Check the connection and try again.`);
      result._meta = { hstack: { service: provider.id, ...(error instanceof DiscoveryError ? error.details : { code: 'UPSTREAM_ERROR' }) } };
      return result;
    }
  }, ctx.mcpReq.signal));
  return server;
}
