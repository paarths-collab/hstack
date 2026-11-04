import { Client, StreamableHTTPClientTransport, UnauthorizedError, OAuthError, OAuthClientFlowError, InsufficientScopeError, SdkHttpError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { OAuthRateLimitError, oauthIssuerFailure } from './oauth.js';
import { IssuerMismatchError } from '@modelcontextprotocol/client';
import { ListToolsResultSchema } from '@modelcontextprotocol/core';
import type { OAuthClientProvider, Tool, ClientOptions } from "@modelcontextprotocol/client";
import { DiscoveryError, retryAfterSeconds, exhaustedWindow } from './errors.js';
export { DiscoveryError } from './errors.js';

// Deliberately safe messages: do not print upstream bodies or credentials.

/** SDK negotiation can wrap our typed HTTP/OAuth failures. Inspect only Error
 * causes, never parse raw messages/bodies; keep unknown failures opaque. */
function knownFailureCause(error: unknown): unknown {
  const seen=new Set<unknown>();let candidate=error;
  for(let depth=0;depth<8&&candidate instanceof Error&&!seen.has(candidate);depth++){
    seen.add(candidate);
    if(candidate instanceof DiscoveryError||candidate instanceof OAuthRateLimitError
      ||candidate instanceof InsufficientScopeError||candidate instanceof UnauthorizedError||candidate instanceof OAuthError
      ||candidate instanceof OAuthClientFlowError||candidate instanceof SdkHttpError
      ||(candidate instanceof SdkError&&candidate.code===SdkErrorCode.RequestTimeout))return candidate;
    candidate=candidate.cause;
  }
  return error;
}

/** Safe classification shared by one-shot and persistent SDK clients. */
export function remoteFailure(error: unknown, label: string): DiscoveryError {
  error = knownFailureCause(error);
  if (error instanceof DiscoveryError) return error;
  if (error instanceof OAuthRateLimitError) return new DiscoveryError(`${label} OAuth server is rate limited; wait before reconnecting.`, error.details);
  if (error instanceof IssuerMismatchError) return oauthIssuerFailure(error);
  if (error instanceof InsufficientScopeError) return new DiscoveryError(`${label} needs additional permissions. Review scopes and explicitly sign in again.`, { code: 'FORBIDDEN' });
  if (error instanceof UnauthorizedError || error instanceof OAuthError || error instanceof OAuthClientFlowError) return new DiscoveryError(`${label} requires sign-in or renewed permissions. Run Hstack login for this connection.`, { code: 'AUTH_REQUIRED', recovery: 'reauthenticate' });
  if (error instanceof SdkHttpError && error.status === 401) return new DiscoveryError('OAuth credential rejected; sign in again.', { code: 'AUTH_REQUIRED', recovery: 'reauthenticate' });
  if (error instanceof SdkHttpError && error.status === 403) return new DiscoveryError('OAuth permissions are insufficient; check scopes and account access.', { code: 'FORBIDDEN' });
  if (error instanceof SdkHttpError) return new DiscoveryError(`MCP request failed (HTTP ${error.status}).`);
  if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) return new DiscoveryError('MCP protocol negotiation failed. Check the upstream protocol and pinned SDK compatibility before changing credentials.');
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return new DiscoveryError('MCP operation timed out.', { code: 'TIMEOUT' });
  return new DiscoveryError('MCP operation failed. Check connectivity and MCP compatibility; raw upstream errors are hidden to protect credentials.');
}

/** Consume error bodies without reflecting account data or credentials. Other
 * statuses reach the SDK so discovery can classify legacy endpoints. */
export async function rejectRemoteHttpError(response: Response, label: string): Promise<void> {
  if (response.status === 401) {
    await response.body?.cancel();
    throw new DiscoveryError(`${label} rejected the credential (401). Reconnect or replace the configured credential.`, { code: 'AUTH_REQUIRED', recovery: 'reauthenticate' });
  }
  if (response.status === 403) {
    await response.body?.cancel();
    throw new DiscoveryError(`${label} denied access (403). Check account permissions and plan requirements.`, { code: 'FORBIDDEN' });
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retry = retryAfterSeconds(response.headers.get('retry-after'));
    const window = exhaustedWindow(response.headers);
    const wait = retry !== undefined ? `Retry after ${retry} seconds.` : 'No usable retry time was supplied.';
    const windowText = window === undefined ? 'The exhausted window is unknown to this prototype.' : `The exhausted window is ${window} seconds.`;
    throw new DiscoveryError(`${label} rate limit reached (429). ${wait} ${windowText}`, {
      code: 'RATE_LIMITED', retryAfterSeconds: retry, windowSeconds: window,
    });
  }
}

/** Give one operation an authenticated client, then always close its connection. */
export async function withRemoteClient<T>(
  endpoint: URL,
  connection: { label: string; credentialEnv: string; headers: Record<string, string>; authProvider?: OAuthClientProvider; fetch?: typeof fetch; protocol?: 'auto' | 'legacy' | '2026-07-28'; schemaValidator?: ClientOptions['jsonSchemaValidator'] },
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
  cancellation?: AbortSignal,
): Promise<T> {
  if (Object.values(connection.headers).some((value) => !value.trim())) {
    throw new DiscoveryError(`Set ${connection.credentialEnv} before connecting ${connection.label}.`, { code: 'AUTH_REQUIRED', recovery: 'reauthenticate' });
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const deadline = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  const protocol = connection.protocol ?? 'auto';
  const client = new Client({ name: 'hstack-upstream', version: '0.0.0' }, {
    versionNegotiation: { mode: protocol === '2026-07-28' ? { pin: protocol } : protocol },
    listMaxPages: 100,
    jsonSchemaValidator: connection.schemaValidator,
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: connection.authProvider,
    onInsufficientScope: 'throw',
    requestInit: { headers: connection.headers },
    // A fixed deadline covers network I/O and all discovery pages together.
    fetch: async (url, init) => {
      // Hstack does not relay subscriptions. Avoid a second auth/refresh flow
      // racing tool discovery on the SDK's optional background SSE stream.
      if (connection.authProvider && String(url) === endpoint.href && init?.method === 'GET') return new Response(null, { status: 405 });
      const signal = init?.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
      const response = await (connection.fetch ?? fetch)(url, { ...init, signal, redirect: 'error' });
      // OAuth responses must reach the SDK: it handles challenges, refresh and invalid_grant.
      if (connection.authProvider && (String(url) !== endpoint.href || response.status === 401 || response.status === 403)) return response;
      // GET is the optional notification stream, not the discovery request.
      if (init?.method === 'POST' && !response.ok) {
        await rejectRemoteHttpError(response, connection.label);
        // Other statuses must reach the SDK so its protocol probe can classify
        // legacy endpoints. The catch below hides raw SDK response-body errors.
      }
      return response;
    },
  });

  try {
    // connect negotiates the protocol version using the SDK's initialization flow.
    await client.connect(transport, { signal: deadline });
    return await operation(client, deadline);
  } catch (error) {
    // OAuth refresh can fall through to a login request after an aborted fetch.
    // The caller's expired/cancelled budget remains the authoritative failure.
    if (cancellation?.aborted && cancellation.reason?.name !== 'TimeoutError') throw new DiscoveryError('MCP operation cancelled.', { code: 'CANCELLED' });
    if (deadline.aborted) throw new DiscoveryError('MCP operation timed out. Check connectivity before trying again.', { code: 'TIMEOUT' });
    throw remoteFailure(error, connection.label);
  } finally {
    // Nested finally ensures transport cleanup even if client cleanup fails.
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
}

/** Compatibility helper for the original Buffer learning experiment. */
export async function withMcpClient<T>(
  endpoint: URL,
  apiKey: string,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
  cancellation?: AbortSignal,
): Promise<T> {
  if (!apiKey.trim()) throw new DiscoveryError('Set BUFFER_API_KEY before running this experiment.', { code: 'AUTH_REQUIRED', recovery: 'reauthenticate' });
  return withRemoteClient(endpoint, {
    label: 'Buffer', credentialEnv: 'BUFFER_API_KEY',
    protocol: 'legacy',
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  }, operation, timeoutMs, cancellation);
}

/** Read every page from an already connected MCP client. */
export async function listAllTools(client: Client, deadline: AbortSignal): Promise<Tool[]> {
  // Avoid the SDK's missing-capability console.debug on MCP protocol stdout.
  if (!client.getServerCapabilities()?.tools) return [];
  const cursors = new Set<string>();
  let pages = 0;
  const request = client.request;
  // Observe the public request seam while the SDK aggregates/cache-populates.
  // Its identical-page tolerance must not turn a cursor loop into partial success.
  client.request = new Proxy(request, {
    apply: async (target, receiver, args) => {
      const result = await Reflect.apply(target, receiver, args);
      if (args[0]?.method !== 'tools/list') return result;
      const page = ListToolsResultSchema.parse(result);
      pages++;
      if (page.nextCursor !== undefined) {
        if (cursors.has(page.nextCursor) || pages >= 100) {
        throw new DiscoveryError('Discovery stopped: upstream pagination did not finish normally.');
        }
        cursors.add(page.nextCursor);
      }
      return result;
    },
  });
  try { return (await client.listTools(undefined, { signal: deadline, cacheMode: 'refresh' })).tools; }
  finally { client.request = request; }
}

/** Connect to an upstream MCP and read its tool catalogue. Never calls tools. */
export async function discoverTools(
  endpoint: URL,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<Tool[]> {
  return withMcpClient(endpoint, apiKey, listAllTools, timeoutMs);
}
