import { readFile } from 'node:fs/promises';
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { DiscoveryError } from './discover-tools.js';
import type { LoadedProvider } from './providers.js';
import { LocalConnection } from './local-connection.js';
import { compileToolSchema } from './tool-schema.js';
import { oauthStore, oauthFetch, StoredOAuthProvider, type OAuthConfig, type OAuthConnection } from './oauth.js';
import { applyResultPolicy, vendorEnvironmentIssues, type ResultPolicy } from './vendor-contracts.js';
import { vendorCredentialGuard } from './vendor-lock.js';
import { BIGQUERY_ENDPOINT } from './bigquery-discovery.js';
import { loadBigQueryConnection } from './bigquery-connection.js';
import { RemoteConnection } from './remote-connection.js';

type SecretRef = { env: string; prefix?: string };
export interface OAuthInput extends OAuthConfig {
  issuerEnv?: string; clientIdEnv?: string; scopeEnv?: string; clientMetadataUrlEnv?: string;
}
export interface Connection {
  id: string; label: string; enabled: boolean; transport: 'http' | 'stdio';
  url?: string; urlEnv?: string; command?: string; commandEnv?: string; args?: string[];
  headers?: Record<string, SecretRef>; env?: Record<string, string>;
  oauth?: OAuthInput;
  googleBigQuery?: { credentialsFileEnv: string };
  protocol?: 'auto' | 'legacy' | '2026-07-28';
  resultPolicy?: ResultPolicy;
  readTools: string[]; writeTools?: string[]; allowWrites: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const envName = (value: unknown): value is string => typeof value === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(value);

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DiscoveryError('Invalid MCP endpoint URL.'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new DiscoveryError('Remote connections require HTTPS without embedded credentials.');
  }
  return url;
}

export function parseConnections(value: unknown): Connection[] {
  if (!record(value) || !Array.isArray(value.connections)) throw new DiscoveryError('Expected a connections array.');
  const ids = new Set<string>();
  return value.connections.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.id)
      || ids.has(item.id) || typeof item.label !== 'string' || typeof item.enabled !== 'boolean'
      || !['http', 'stdio'].includes(String(item.transport))
      || !Array.isArray(item.readTools) || !item.readTools.every((x) => typeof x === 'string')
      || (item.writeTools !== undefined && (!Array.isArray(item.writeTools) || !item.writeTools.every((x) => typeof x === 'string')))
      || typeof item.allowWrites !== 'boolean') throw new DiscoveryError('Invalid or duplicate connection configuration.');
    if (item.protocol !== undefined && !['auto', 'legacy', '2026-07-28'].includes(String(item.protocol))) throw new DiscoveryError('Unsupported MCP protocol selection.');
    if (item.googleBigQuery !== undefined && (!record(item.googleBigQuery)
      || Object.keys(item.googleBigQuery).some(key => key !== 'credentialsFileEnv') || !envName(item.googleBigQuery.credentialsFileEnv)
      || item.transport !== 'http' || item.url !== BIGQUERY_ENDPOINT || item.urlEnv !== undefined
      || item.oauth !== undefined || item.headers !== undefined || item.command !== undefined || item.commandEnv !== undefined
      || item.env !== undefined || item.args !== undefined || item.resultPolicy !== undefined
      || (item.protocol !== undefined && item.protocol !== 'legacy'))) throw new DiscoveryError('BigQuery native authentication requires its fixed official endpoint, explicit legacy SDK protocol and credential-file environment reference.');
    if (item.resultPolicy !== undefined && !['mailchimp-1.2.0','zendesk-0.1.6','quickbooks-31a1dd5'].includes(String(item.resultPolicy))) throw new DiscoveryError('Unsupported vendor result policy.');
    if(item.resultPolicy==='zendesk-0.1.6'&&item.transport!=='stdio')throw new DiscoveryError('The reviewed Zendesk policy requires a local native runtime and private credential-home guard.');
    if(item.resultPolicy==='quickbooks-31a1dd5'&&item.transport!=='stdio')throw new DiscoveryError('The reviewed QuickBooks policy requires the local pinned compatibility runtime and native token-store guard.');
    ids.add(item.id);
    if (item.transport === 'http') {
      if ((item.url === undefined) === (item.urlEnv === undefined)
        || (item.url !== undefined && typeof item.url !== 'string')
        || (item.urlEnv !== undefined && !envName(item.urlEnv)) || item.commandEnv !== undefined) {
        throw new DiscoveryError('HTTP connections require exactly one URL or urlEnv reference.');
      }
      const url = typeof item.url === 'string' ? endpoint(item.url) : undefined;
      if (item.headers !== undefined && (!record(item.headers) || !Object.values(item.headers).every((ref) =>
        record(ref) && typeof ref.env === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(ref.env)
        && (ref.prefix === undefined || typeof ref.prefix === 'string')))) {
        throw new DiscoveryError('Headers must reference environment variables, not literal secrets.');
      }
      if (item.oauth !== undefined) {
        const auth = item.oauth;
        if (!record(auth) || auth.type !== 'oauth' || (item.headers !== undefined && Object.keys(item.headers as object).length > 0)
          || Object.keys(auth).some((key) => !['type', 'callbackPort', 'scope', 'issuer', 'clientId', 'clientSecretEnv', 'clientMetadataUrl', 'issuerEnv', 'clientIdEnv', 'scopeEnv', 'clientMetadataUrlEnv','dcrAuthMethod'].includes(key))
          || (auth.dcrAuthMethod !== undefined && (!['client_secret_post','client_secret_basic'].includes(String(auth.dcrAuthMethod))
            || ['clientId','clientIdEnv','clientSecretEnv','clientMetadataUrl','clientMetadataUrlEnv'].some(key=>auth[key]!==undefined)))
          || (auth.callbackPort !== undefined && (!Number.isInteger(auth.callbackPort) || Number(auth.callbackPort) < 1024 || Number(auth.callbackPort) > 65535))
          || (auth.scope !== undefined && typeof auth.scope !== 'string')
          || (auth.clientId !== undefined && (typeof auth.clientId !== 'string' || !auth.clientId.trim()))
          || ((auth.clientMetadataUrl !== undefined || auth.clientMetadataUrlEnv !== undefined)
            && (auth.clientId !== undefined || auth.clientIdEnv !== undefined || auth.clientSecretEnv !== undefined))
          || ((auth.clientId !== undefined || auth.clientIdEnv !== undefined) && auth.issuer === undefined && auth.issuerEnv === undefined)
          || (auth.clientSecretEnv !== undefined && (!envName(auth.clientSecretEnv) || (auth.clientId === undefined && auth.clientIdEnv === undefined)))) {
          throw new DiscoveryError('Invalid OAuth settings. Use environment references for client secrets and an issuer for registered clients.');
        }
        for (const field of ['issuer', 'clientId', 'scope', 'clientMetadataUrl'] as const) {
          const reference = auth[`${field}Env`];
          if (reference !== undefined && (!envName(reference) || auth[field] !== undefined)) {
            throw new DiscoveryError('OAuth settings require either a value or its environment reference, never both.');
          }
        }
        for (const field of ['issuer', 'clientMetadataUrl'] as const) {
          if (auth[field] === undefined) continue;
          if (typeof auth[field] !== 'string') throw new DiscoveryError('OAuth URLs must be strings.');
          let value: URL;
          try { value = new URL(auth[field]); }
          catch { throw new DiscoveryError('Invalid OAuth issuer or client metadata URL.'); }
          if (value.username || value.password || value.hash || value.search
            || (value.protocol !== 'https:' && !(field === 'issuer' && (url?.protocol === 'http:' || item.urlEnv !== undefined) && value.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(value.hostname)))
            || (field === 'clientMetadataUrl' && value.pathname === '/')) throw new DiscoveryError('Invalid OAuth issuer or client metadata URL.');
        }
        if (item.id === 'typeform' && auth.clientMetadataUrl !== undefined && url) {
          const regions: Record<string,string> = {
            'https://api.typeform.com/mcp':'https://api.typeform.com',
            'https://api.eu.typeform.com/mcp':'https://api.typeform.com',
            'https://api.typeform.eu/mcp':'https://api.typeform.eu',
          };
          if (!regions[url.href] || (auth.issuerEnv === undefined && auth.issuer !== regions[url.href]) || String(auth.clientMetadataUrl).length > 255) {
            throw new DiscoveryError('Typeform CIMD requires a documented regional endpoint with its matching issuer and a client metadata URL of at most 255 characters. Review private settings; no region fallback is attempted.');
          }
        }
      }
    } else if ((item.command === undefined) === (item.commandEnv === undefined)
      || (item.command !== undefined && (typeof item.command !== 'string' || !item.command.trim()))
      || (item.commandEnv !== undefined && !envName(item.commandEnv)) || item.urlEnv !== undefined
      || item.oauth !== undefined
      || (item.args !== undefined && (!Array.isArray(item.args) || !item.args.every((x) => typeof x === 'string')))
      || (item.env !== undefined && (!record(item.env) || !Object.values(item.env).every((x) =>
        typeof x === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(x))))) {
      throw new DiscoveryError('Local MCP connections require a command, arguments and environment references.');
    }
    return item as unknown as Connection;
  });
}

/** Resolve private endpoint/executable references once; never reflect their values in diagnostics. */
export function resolveConnection(config: Connection, env: NodeJS.ProcessEnv): Connection {
  const checked = parseConnections({ connections: [config] })[0]!;
  const resolved = { ...checked };
  if (checked.urlEnv !== undefined) {
    resolved.url = secret(env, checked.urlEnv);
    delete resolved.urlEnv;
  }
  if (checked.commandEnv !== undefined) {
    resolved.command = secret(env, checked.commandEnv);
    delete resolved.commandEnv;
  }
  if (checked.oauth) {
    resolved.oauth = { ...checked.oauth };
    for (const field of ['issuer', 'clientId', 'scope', 'clientMetadataUrl'] as const) {
      const name = `${field}Env` as const;
      const reference = checked.oauth[name];
      if (reference === undefined) continue;
      resolved.oauth[field] = secret(env, reference);
      delete resolved.oauth[name];
    }
  }
  // Revalidate the actual URL, including its relationship to an OAuth issuer.
  return parseConnections({ connections: [resolved] })[0]!;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new DiscoveryError(`Set ${name} before connecting this service.`, { code: 'AUTH_REQUIRED' });
  return value;
}

export async function loadConnection(config: Connection, env: NodeJS.ProcessEnv, cancellation?: AbortSignal,
  dependencies?: { bigQueryFetch?: typeof fetch },
): Promise<LoadedProvider> {
  config = resolveConnection(config, env);
  if (config.googleBigQuery) return loadBigQueryConnection(config, env, cancellation, dependencies?.bigQueryFetch);
  const headers = config.transport === 'http' ? Object.fromEntries(Object.entries(config.headers ?? {}).map(([name, ref]) =>
    [name, `${ref.prefix ?? ''}${secret(env, ref.env)}`])) : {};
  const childEnv = config.transport === 'stdio' ? Object.fromEntries(Object.entries(config.env ?? {}).map(([name, ref]) => [name, secret(env, ref)])) : {};
  const settingIssues = config.transport === 'stdio' ? vendorEnvironmentIssues(config.resultPolicy, childEnv) : [];
  if (settingIssues.length) throw new DiscoveryError(settingIssues[0]!, { code:'UNAVAILABLE', outcome:'not_sent' });
  const vendorGuard=config.transport==='stdio'?await vendorCredentialGuard(config.resultPolicy,childEnv):undefined;
  const shutdown = new AbortController();
  const local = config.transport === 'stdio' ? new LocalConnection({
    label: config.label, command: config.command!, args: config.args ?? [], protocol: config.protocol,
    env: childEnv,
  }) : undefined;
  const oauthConfig=config.oauth?config as OAuthConnection:undefined;
  const store=oauthConfig?oauthStore(oauthConfig,env):undefined;
  const auth=oauthConfig?new StoredOAuthProvider(oauthConfig,store!,env):undefined;
  const persistent = config.transport === 'http' ? new RemoteConnection({
    endpoint:new URL(config.url!),label:config.label,headers,protocol:config.protocol,
    ...(auth?{authProvider:auth,credentialBinding:()=>auth.credentialBinding(),
      withOperation:<T>(signal:AbortSignal,operation:()=>Promise<T>)=>store!.locked(signal,async()=>{await auth.load();return operation();}),
      fetch:(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
        if(!init?.signal)throw new DiscoveryError('OAuth request requires an active deadline.');
        return oauthFetch(oauthConfig!,init.signal)(url,init);
      },
    }:{}),
  }) : undefined;
  try {
    const tools = persistent ? await persistent.discover(cancellation) : await local!.discover(cancellation);
    const validator = new AjvJsonSchemaValidator();
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error('Duplicate tools');
    for (const tool of tools) compileToolSchema(validator, tool.inputSchema);
    return {
      id: config.id, label: config.label, tools, readTools: new Set(config.readTools), writeTools: new Set(config.writeTools ?? []), allowWrites: config.allowWrites,
      permissionSource: 'connection',
      ...(local ? { lifecycle: () => local.status() } : persistent ? { lifecycle: () => persistent.status() } : {}),
      close: async () => { shutdown.abort(); try{await Promise.all([local?.close(),persistent?.close()]);}finally{await vendorGuard?.drain();} },
      call: async (name, args, signal) => {
        if (shutdown.signal.aborted) return Promise.reject(new DiscoveryError('Connection has been closed.', { code: 'UNAVAILABLE', outcome: 'not_sent' }));
        if (local) {
          const deadline=AbortSignal.any([signal,shutdown.signal,AbortSignal.timeout(30_000)]);
          const operation=()=>local.call(name,args,deadline);
          return applyResultPolicy(config.resultPolicy,name,await(vendorGuard?vendorGuard.run(deadline,operation):operation()),config.id);
        }
        const deadline = AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(30_000)]);
        return applyResultPolicy(config.resultPolicy,name,await persistent!.call(name,args,deadline),config.id);
      },
    };
  } catch (error) {
    await local?.close();
    await persistent?.close();
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(`${config.label} catalogue could not be loaded.`);
  }
}

export async function loadConfiguredConnections(
  path: string, env: NodeJS.ProcessEnv,
  loader = loadConnection,
  cancellation?: AbortSignal,
): Promise<{ providers: LoadedProvider[]; failed: string[] }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], failed: [] };
    throw new DiscoveryError('Cannot read connections.json.');
  }
  let configs: Connection[];
  try { configs = parseConnections(JSON.parse(text)); }
  catch { throw new DiscoveryError('Invalid connections.json; check its schema without sharing secrets.'); }
  const enabled = configs.filter((item) => item.enabled);
  const results = await Promise.allSettled(enabled.map((item) => loader(item, env, cancellation)));
  const providers: LoadedProvider[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') providers.push(result.value);
    else failed.push(enabled[index]!.id);
  });
  return { providers, failed };
}
