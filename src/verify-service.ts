import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSocialGateway } from './gateway.js';
import type { LoadedProvider } from './providers.js';
import { DiscoveryError } from './errors.js';

const probes: Record<string, { tool: string; args: Record<string, unknown>; textRows?: boolean; valid: (value: unknown) => boolean; failure: string }> = {
  quickbooks:{
    tool:'get_company_info',args:{params:{}},
    valid:(value)=>!!value&&typeof value==='object'&&'Id'in value&&typeof value.Id==='string'&&!!value.Id
      &&'CompanyName'in value&&typeof value.CompanyName==='string'&&!!value.CompanyName,
    failure:'QuickBooks operational company read failed. Check explicit vendor sign-in, company/realm, environment and accounting read permissions.',
  },
  zendesk:{
    tool:'zendesk_get_groups',args:{},
    valid:(value)=>Array.isArray(value)&&value.every((item:unknown)=>!!item&&typeof item==='object'&&'id'in item
      &&typeof item.id==='number'&&Number.isSafeInteger(item.id)&&item.id>0&&'name'in item&&typeof item.name==='string'),
    failure:'Zendesk operational group read failed. Check vendor setup, OAuth grant, account eligibility and group read access.',
  },
  mysql: {
    tool:'list_tables',args:{table_names:'',output_format:'simple'},textRows:true,
    valid:(value)=>Array.isArray(value)&&value.every((item:unknown)=>!!item&&typeof item==='object'
      &&'schema_name' in item&&typeof item.schema_name==='string'&&!!item.schema_name
      &&'object_name' in item&&typeof item.object_name==='string'&&!!item.object_name),
    failure:'MySQL operational schema read failed. Check database credentials, TLS, selected database and schema read permissions.',
  },
  'google-analytics': {
    tool:'get_account_summaries', args:{},
    valid:(value)=>Array.isArray(value)&&value.every((item:unknown)=>!!item&&typeof item==='object'
      &&'account' in item&&typeof item.account==='string'&&/^accounts\/\d+$/.test(item.account)
      &&(!('property_summaries' in item)||(Array.isArray(item.property_summaries)&&item.property_summaries.every((property:unknown)=>
        !!property&&typeof property==='object'&&'property' in property&&typeof property.property==='string'&&/^properties\/\d+$/.test(property.property))))),
    failure:'Google Analytics operational read failed. Check ADC credentials, read-only scopes, enabled Admin/Data APIs, quota project and Analytics property access.',
  },
  redis: {
    tool: 'dbsize', args: {},
    valid: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    failure: 'Redis operational read failed. Check database credentials, selected DB, TLS and read permissions.',
  },
  mailchimp: {
    // v1.2.0 ping reads health_check, but the API returns health_status. Do not use it as proof.
    tool: 'list_audiences', args: { count: 1, offset: 0 },
    valid: (value) => !!value && typeof value === 'object' && 'total_items' in value
      && typeof value.total_items === 'number' && Number.isSafeInteger(value.total_items) && value.total_items >= 0
      && 'audiences' in value && Array.isArray(value.audiences) && value.audiences.length <= 1
      && value.audiences.length <= value.total_items && !('error' in value),
    failure: 'Mailchimp operational read failed. Check API key, account eligibility and audience read access.',
  },
  mongodb: {
    tool:'list-databases', args:{ connectionId:'preconfigured' },
    valid:(value)=>!!value && typeof value==='object' && 'databases' in value && Array.isArray(value.databases)
      && 'totalCount' in value && Number.isSafeInteger(value.totalCount) && value.totalCount===value.databases.length
      && value.databases.every((item:unknown)=>!!item && typeof item==='object' && 'name' in item && typeof item.name==='string' && !!item.name
        && 'size' in item && typeof item.size==='number' && Number.isFinite(item.size) && item.size>=0),
    failure:'MongoDB operational read failed. Check connection string, credentials, TLS and database-list permissions.',
  },
};

export const hasOperationalVerifier = (id: string): boolean => Object.hasOwn(probes, id);

/** Explicit operational read. Discovery alone cannot prove database auth works. */
export async function verifyService(provider: LoadedProvider): Promise<void> {
  if (!hasOperationalVerifier(provider.id)) throw new DiscoveryError('No reviewed operational verification exists for this service yet. check only verifies MCP discovery.');
  const probe = probes[provider.id]!;
  if (!provider.readTools.has(probe.tool)) throw new DiscoveryError(`Review and allow ${probe.tool} in this connection readTools before verification.`, { code: 'FORBIDDEN', outcome: 'not_sent' });
  const gateway = createSocialGateway([provider]);
  const client = new Client({ name: 'hstack-service-verification', version: '0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await gateway.connect(remote); await client.connect(local);
    const result = CallToolResultSchema.parse(await client.callTool({ name: `${provider.id}__${probe.tool}`, arguments: probe.args }, { timeout: 30_000 }));
    const structured = result.structuredContent;
    const candidates: unknown[] = [structured, structured && typeof structured === 'object' && 'result' in structured ? structured.result : undefined];
    const textRows: unknown[] = [];
    let rowsValid = true;
    for (const content of result.content ?? []) if (content.type === 'text') {
      try { const value:unknown=JSON.parse(content.text);candidates.push(value);textRows.push(value); }
      catch { rowsValid=false; /* vendor errors are not proof */ }
    } else rowsValid=false;
    // Pinned Toolbox returns one JSON TextContent per row, including zero
    // content parts for an empty read. Do not apply that contract to other vendors.
    if(probe.textRows&&rowsValid)candidates.push(textRows);
    if (result.isError || !candidates.some(probe.valid)) {
      throw new DiscoveryError(`${probe.failure} Raw vendor results are hidden.`, { code: 'UPSTREAM_ERROR' });
    }
  } finally { try { await client.close(); } finally { await gateway.close(); } }
}
