import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ListToolsResultSchema } from '@modelcontextprotocol/core';
import { withRemoteClient, listAllTools } from '../dist/discover-tools.js';
import { discoverBigQueryPublicTools } from '../dist/bigquery-discovery.js';
import { loadConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { createBigQuerySchemaValidator } from '../dist/bigquery-schema.js';

const endpoint = 'https://bigquery.googleapis.com/mcp';

/** Public protocol check only. Never loads environment credentials or calls a tool. */
export async function verifyBigQueryMetadata(fetchImpl = fetch) {
  const deadline = AbortSignal.timeout(30_000);
  const requests = [];
  let discoveryErrorCode;
  const publicFetch = async (url, init) => {
    if (String(url) !== endpoint) throw new Error('Unexpected public endpoint.');
    // The optional subscription and cleanup paths need no network in this probe.
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 });
    if (init?.method !== 'POST' || new Headers(init.headers).has('Authorization')) throw new Error('Non-public request refused.');
    const request = JSON.parse(init.body);
    if (!['tools/list','server/discover','initialize','notifications/initialized'].includes(request.method)) throw new Error('Non-discovery request refused.');
    requests.push(request.method);
    const response = await fetchImpl(url, { ...init, credentials: 'omit', redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    if (request.method === 'server/discover') {
      const envelope = await response.clone().json().catch(() => undefined);
      // Retain only a numeric public protocol code, never a response body/message.
      if (Number.isInteger(envelope?.error?.code)) discoveryErrorCode = envelope.error.code;
    }
    return response;
  };
  const response = await publicFetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'public-tools-list', method: 'tools/list', params: {} }),
  });
  if (!response.ok) throw new Error('Public tool catalogue unavailable.');
  const envelope = await response.json();
  if (envelope.jsonrpc !== '2.0' || envelope.id !== 'public-tools-list' || envelope.error) throw new Error('Invalid public catalogue envelope.');
  const page = ListToolsResultSchema.parse(envelope.result);
  if (page.nextCursor !== undefined) throw new Error('Public catalogue is paginated; this probe requires review.');
  let modernCompatible = false;
  let modernFailure;
  try {
    const tools = await withRemoteClient(new URL(endpoint), {
      label: 'Public BigQuery metadata', credentialEnv: 'none', headers: {},
      protocol: '2026-07-28', fetch: publicFetch,
    }, listAllTools, 30_000, deadline);
    if (!isDeepStrictEqual(tools, page.tools)) throw new Error('SDK catalogue differs from public catalogue.');
    modernCompatible = true;
  } catch (error) {
    modernFailure = { code: error?.details?.code ?? 'UPSTREAM_ERROR' };
  }
  const adapted = await discoverBigQueryPublicTools({ fetch: publicFetch, signal: deadline });
  if (!isDeepStrictEqual(adapted.tools, page.tools)) throw new Error('Adapted catalogue differs from public catalogue.');
  const validator = createBigQuerySchemaValidator(); let compiledSchemas = 0;
  for (const tool of adapted.tools) {
    validator.getValidator(tool.inputSchema); compiledSchemas++;
    if (tool.outputSchema) { validator.getValidator(tool.outputSchema); compiledSchemas++; }
  }
  const profile = JSON.parse(await readFile(new URL('../integrations/bigquery/connection.json', import.meta.url), 'utf8'));
  const provider = await loadConnection(profile, {}, deadline, { bigQueryFetch: publicFetch });
  const gateway = createSocialGateway([provider]), downstream = new Client({ name: 'public-bigquery-check', version: '0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await gateway.connect(remote); await downstream.connect(local);
    const listed = (await downstream.listTools(undefined, { signal: deadline })).tools;
    if (listed.length !== page.tools.length || listed.some((tool, i) => tool.name !== `bigquery__${page.tools[i].name}`
      || !isDeepStrictEqual(tool.inputSchema, page.tools[i].inputSchema)
      || !isDeepStrictEqual(tool.outputSchema, page.tools[i].outputSchema))) throw new Error('Gateway schema mismatch.');
  } finally { try { await downstream.close(); } finally { try { await gateway.close(); } finally { await provider.close(); } } }
  return {
    vendor: 'Google BigQuery remote MCP', endpoint, sdk: '2.4.0', protocol: adapted.protocolVersion,
    evidence: 'Public unauthenticated discovery only; no account, tokens, queries or tool calls.',
    sdkCompatible: true,
    checks: { publicToolsList: true, officialSdkLegacyDiscovery: true, officialSdkModernDiscovery: modernCompatible,
      noAuthenticationOrToolCalls: true },
    nativeSdk: { discoveryOnly: true, resultRewriting: false, compiledSchemas,
      gatewayDiscovery: true, authenticatedOperationsVerified: false },
    tools: page.tools.map((tool) => tool.name),
    publicSchemaSha256: createHash('sha256').update(JSON.stringify(page.tools)).digest('hex'),
    requests,
    ...(modernFailure ? { modernFailure } : {}),
    ...(discoveryErrorCode !== undefined ? { discoveryErrorCode } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await verifyBigQueryMetadata();
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.sdkCompatible) process.exitCode = 1;
  } catch {
    console.error('BigQuery public discovery check failed. No credentials or tool calls were used.');
    process.exitCode = 1;
  }
}
