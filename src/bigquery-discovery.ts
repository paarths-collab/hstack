import type { Tool } from '@modelcontextprotocol/client';
import { withRemoteClient, listAllTools } from './discover-tools.js';
import { createBigQuerySchemaValidator } from './bigquery-schema.js';
import { DiscoveryError } from './errors.js';

export const BIGQUERY_ENDPOINT = 'https://bigquery.googleapis.com/mcp';

export async function rejectUnknownBigQueryResult(response: Response) {
  if (response.ok && /^application\/json$/i.test(response.headers.get('content-type')?.split(';')[0]?.trim() ?? '')) {
    const envelope = await response.clone().json(); const result = envelope?.result;
    if (result && typeof result === 'object' && (('resultType' in result && result.resultType !== 'complete')
      || 'inputRequests' in result || 'requestState' in result)) throw new Error('Unreviewed result kind.');
  }
}

function deadline(options: { signal?: AbortSignal; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new DiscoveryError('Invalid BigQuery operation timeout.');
  const timeout = AbortSignal.timeout(timeoutMs);
  return { timeoutMs, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
}

/** Native SDK path. Google's public endpoint accepts legacy initialization;
 * pin it explicitly instead of synthesizing discovery or translating results. */
export async function discoverBigQueryPublicTools(options: {
  fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<{ tools: Tool[]; protocolVersion: string }> {
  const { timeoutMs, signal } = deadline(options);
  return withRemoteClient(new URL(BIGQUERY_ENDPOINT), {
    label: 'BigQuery public discovery', credentialEnv: 'none', headers: {}, protocol: 'legacy',
    schemaValidator: createBigQuerySchemaValidator(),
    fetch: async (url, init) => {
      if (String(url) !== BIGQUERY_ENDPOINT) throw new Error('Unexpected public endpoint.');
      if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 });
      if (init?.method !== 'POST' || new Headers(init.headers).has('Authorization')) throw new Error('Public discovery only.');
      const request = JSON.parse(String(init.body));
      if (!['initialize','notifications/initialized','tools/list'].includes(request.method)) throw new Error('Public discovery only.');
      const response = await (options.fetch ?? fetch)(url, { ...init, credentials: 'omit', redirect: 'error' });
      if (request.method === 'tools/list') await rejectUnknownBigQueryResult(response);
      return response;
    },
  }, async (client, cancellation) => {
    const tools = await listAllTools(client, cancellation);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate tools.');
    return { tools, protocolVersion: client.getNegotiatedProtocolVersion()! };
  }, timeoutMs, signal);
}

