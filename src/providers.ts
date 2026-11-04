import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { Tool, CallToolResult } from "@modelcontextprotocol/server";
import { DiscoveryError } from './discover-tools.js';
import type { ConnectionLifecycle } from './local-connection.js';
import { RemoteConnection } from './remote-connection.js';

export const bufferReads = new Set([
  'get_account', 'list_channels', 'get_channel', 'list_posts', 'get_post',
  'list_ideas', 'list_idea_groups', 'get_aggregated_post_metrics',
  'list_post_templates', 'get_post_template',
]);

export interface ProviderDefinition {
  id: string;
  label: string;
  endpoint: string;
  credentialEnv: string;
  header: string;
  bearer: boolean;
  readTools: ReadonlySet<string>;
  docs: string;
  requirements: string;
}

// Fixed vendor URLs only. Credentials cannot select or override a destination.
export const socialProviders: readonly ProviderDefinition[] = [
  {
    id: 'buffer', label: 'Buffer', endpoint: 'https://mcp.buffer.com/mcp',
    credentialEnv: 'BUFFER_API_KEY', header: 'Authorization', bearer: true,
    readTools: bufferReads, docs: 'https://developers.buffer.com/guides/integrations/mcp.html',
    requirements: 'MCP included on Free; account and request limits apply.',
  },
  {
    id: 'pallyy', label: 'Pallyy', endpoint: 'https://app.pallyy.com/mcp',
    credentialEnv: 'PALLYY_API_KEY', header: 'Authorization', bearer: true,
    readTools: new Set(['get_me', 'list_social_sets', 'get_social_set', 'list_post_sets',
      'get_post_set', 'list_media', 'get_media', 'get_media_upload', 'list_notes',
      'get_note', 'list_pinterest_boards']),
    docs: 'https://pallyy.com/docs/api/mcp',
    requirements: 'MCP on all plans including Free. Key scopes and social-set restrictions apply.',
  },
  {
    id: 'metricool', label: 'Metricool', endpoint: 'https://ai.metricool.com/mcp',
    credentialEnv: 'METRICOOL_API_KEY', header: 'X-Mc-Auth', bearer: false,
    // Exact API-key-route tool names need account discovery and review first.
    // Discovery works, but no operation is automatically approved as a safe read.
    readTools: new Set(), docs: 'https://help.metricool.com/how-to-connect-metricools-mcp-eqp9h',
    requirements: 'Header-token route requires API access (Advanced/Custom). Free MCP uses OAuth, not implemented here.',
  },
  {
    id: 'blotato', label: 'Blotato', endpoint: 'https://mcp.blotato.com/mcp',
    credentialEnv: 'BLOTATO_API_KEY', header: 'blotato-api-key', bearer: false,
    readTools: new Set(['blotato_get_user', 'blotato_list_accounts', 'blotato_list_pinterest_boards',
      'blotato_get_credits', 'blotato_get_post_status', 'blotato_list_posts',
      'blotato_list_top_posts', 'blotato_get_post_analytics', 'blotato_list_comments',
      'blotato_get_comment', 'blotato_list_conversations', 'blotato_get_conversation',
      'blotato_list_messages', 'blotato_get_message', 'blotato_list_automations',
      'blotato_list_automation_runs', 'blotato_list_automation_logs',
      'blotato_get_automation_analytics', 'blotato_get_source_status',
      'blotato_list_visual_templates', 'blotato_get_visual_status',
      'blotato_list_schedules', 'blotato_get_schedule']),
    docs: 'https://help.blotato.com/start-with-an-ai-agent/mcp/setup',
    requirements: 'Paid API/MCP subscription. Generating an API key during trial starts billing.',
  },
  {
    id: 'ayrshare', label: 'Ayrshare', endpoint: 'https://api.ayrshare.com/mcp',
    credentialEnv: 'AYRSHARE_API_KEY', header: 'Authorization', bearer: true,
    readTools: new Set(['get_post', 'get_post_history', 'get_platform_history',
      'get_post_analytics', 'get_post_analytics_by_social_id', 'get_social_network_analytics',
      'get_comments', 'get_messages', 'get_auto_response', 'list_profiles',
      'list_webhooks', 'list_ad_accounts', 'search_ad_targeting', 'list_ads',
      'get_ad_history', 'explain_error']),
    docs: 'https://www.ayrshare.com/docs/additional/mcp-action-connect',
    requirements: 'Eligible API account required. Ads require add-on. X/Twitter BYO headers are not supported in this preview.',
  },
];

export interface LoadedProvider {
  schemaValidator?: Pick<AjvJsonSchemaValidator, 'getValidator'>;
  close?: () => Promise<void>;
  lifecycle?: () => ConnectionLifecycle;
  id: string;
  label: string;
  tools: Tool[];
  readTools: ReadonlySet<string>;
  writeTools?: ReadonlySet<string>;
  allowWrites: boolean;
  permissionSource?: 'connection' | 'environment';
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;
}

export async function loadProvider(
  definition: ProviderDefinition,
  key: string,
  allowWrites = false,
  cancellation?: AbortSignal,
): Promise<LoadedProvider> {
  if (!key.trim()) throw new DiscoveryError(`Set ${definition.credentialEnv} before connecting ${definition.label}.`);
  const connection = {
    label: definition.label, credentialEnv: definition.credentialEnv,
    // Preserve the existing built-in adapters' handshake; modern custom HTTP
    // connections negotiate automatically or use an explicit protocol pin.
    protocol: 'legacy' as const,
    headers: { [definition.header]: definition.bearer ? `Bearer ${key.trim()}` : key.trim() },
  };
  const remote = new RemoteConnection({ ...connection, endpoint: new URL(definition.endpoint) });
  try {
    const tools = await remote.discover(cancellation);
    return {
      id: definition.id, label: definition.label, tools, readTools: definition.readTools, allowWrites,
      lifecycle: () => remote.status(), close: () => remote.close(),
      call: (name, args, signal) => remote.call(name, args, signal),
    };
  } catch (error) { await remote.close(); throw error; }
}

/** Only services with a non-empty credential are contacted. Failures are isolated. */
export async function loadSocialPackage(
  env: NodeJS.ProcessEnv,
  loader = loadProvider,
  cancellation?: AbortSignal,
): Promise<{ providers: LoadedProvider[]; failed: string[] }> {
  const configured = socialProviders.filter((item) => env[item.credentialEnv]?.trim());
  const results = await Promise.allSettled(configured.map((item) => loader(
    item, env[item.credentialEnv]!,
    env[`HSTACK_ALLOW_${item.id.toUpperCase()}_WRITES`] === 'true'
      || (item.id === 'buffer' && env.HSTACK_ALLOW_WRITES === 'true'),
    cancellation,
  )));
  const providers: LoadedProvider[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') providers.push(result.value);
    else failed.push(configured[index]!.id);
  });
  return { providers, failed };
}
