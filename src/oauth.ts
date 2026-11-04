import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { OAuthTokensSchema, OAuthClientInformationSchema } from "@modelcontextprotocol/core";
import { auth, OAuthError, OAuthErrorCode, IssuerMismatchError } from "@modelcontextprotocol/client";
import type { OAuthClientProvider, OAuthDiscoveryState, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/client";
import { credentialCodec } from './credential-codec.js';
import { AuthStore } from './auth-store.js';
import { DiscoveryError, retryAfterSeconds, exhaustedWindow } from './errors.js';
import type { FailureDetails } from './errors.js';
import { waitWithSignal } from './cancellation.js';

export interface OAuthConfig {
  type: 'oauth'; callbackPort?: number; scope?: string;
  issuer?: string; clientId?: string; clientSecretEnv?: string; clientMetadataUrl?: string;
  dcrAuthMethod?: 'client_secret_post' | 'client_secret_basic';
}
export interface OAuthConnection { id: string; url: string; oauth: OAuthConfig }
interface SavedAuth { version: 1; client?: OAuthClientInformationMixed; tokens?: OAuthTokens }

function assertResolvedRegistration(config: OAuthConnection): void {
  if (['issuerEnv','clientIdEnv','scopeEnv','clientMetadataUrlEnv'].some((name) => Reflect.get(config.oauth,name) !== undefined)) {
    throw new DiscoveryError('Resolve OAuth registration settings through the connection loader or management command before starting an OAuth action.', { code:'AUTH_REQUIRED' });
  }
  const auth=config.oauth;
  if (auth.dcrAuthMethod !== undefined && (!['client_secret_post','client_secret_basic'].includes(auth.dcrAuthMethod)
    || auth.clientId !== undefined || auth.clientSecretEnv !== undefined || auth.clientMetadataUrl !== undefined)) {
    throw new DiscoveryError('Choose dynamic registration authentication, a registered client, or a client metadata document; do not combine identities.', {code:'AUTH_REQUIRED'});
  }
}

export function oauthStore(config: OAuthConnection, env: NodeJS.ProcessEnv): AuthStore {
  assertResolvedRegistration(config);
  // Bind state to endpoint AND registration settings. Changing either cannot reuse credentials.
  const auth = config.oauth;
  const binding = [config.id, new URL(config.url).href,
    auth.callbackPort ?? 8678, auth.issuer ? new URL(auth.issuer).href : null,
    auth.clientId ?? null, auth.clientSecretEnv ?? null, auth.clientMetadataUrl ?? null, auth.scope ?? null];
  // Existing default registrations keep their exact credential-store identity.
  if(auth.dcrAuthMethod)binding.push('dcr-auth-method',auth.dcrAuthMethod);
  return new AuthStore(AuthStore.root(env), binding, credentialCodec(AuthStore.root(env), env));
}

function allowedUrl(value: string | URL, local: boolean) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local
    && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new DiscoveryError('OAuth requires HTTPS endpoints without embedded credentials.', { code: 'AUTH_REQUIRED' });
  }
  return url;
}

export class OAuthRateLimitError extends OAuthError {
  readonly details: FailureDetails;
  constructor(headers: Headers) {
    super(OAuthErrorCode.TooManyRequests, 'OAuth authorization server rate limit reached.');
    this.details = { code: 'RATE_LIMITED', retryAfterSeconds: retryAfterSeconds(headers.get('retry-after')), windowSeconds: exhaustedWindow(headers) };
  }
}

/** Keep issuer validation intact and omit attacker-controlled issuer values. */
export function oauthIssuerFailure(error: IssuerMismatchError): DiscoveryError {
  return error.kind==='metadata'
    ?new DiscoveryError('OAuth issuer metadata is inconsistent with the selected authorization server. Review the service endpoint, configured issuer and vendor metadata before retrying.',{code:'UNAVAILABLE',outcome:'not_sent'})
    :new DiscoveryError('OAuth sign-in response issuer validation failed. Review the intended service and issuer before starting sign-in again.',{code:'AUTH_REQUIRED',outcome:'not_sent'});
}

async function readAuthBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 1_000_000) throw new DiscoveryError('OAuth server response exceeded the size limit.', { code: 'AUTH_REQUIRED' });
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Applies to discovery/registration/token exchange too, not just MCP requests. */
export function oauthFetch(config: OAuthConnection, signal: AbortSignal): typeof fetch {
  const local = new URL(config.url).protocol === 'http:';
  return async (input, init) => {
    const url = allowedUrl(input instanceof Request ? input.url : String(input), local);
    const response = await fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
    // Tool responses are returned verbatim. Only authorization-server responses
    // are normalized before SDK warnings can reflect an upstream error body.
    if (url.href === new URL(config.url).href) return response;
    if (response.status === 429) { await response.body?.cancel(); throw new OAuthRateLimitError(response.headers); }
    const body = await readAuthBody(response);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { /* error bodies can be non-JSON */ }
    const oauthError = parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : undefined;
    if (!response.ok || oauthError) {
      const known = oauthError && Object.values(OAuthErrorCode).includes(oauthError as OAuthErrorCode) ? oauthError : response.status >= 500 ? 'server_error' : 'invalid_request';
      return new Response(JSON.stringify({ error: known, error_description: 'OAuth authorization server rejected the request.' }), {
        status: response.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!parsed || typeof parsed !== 'object') throw new DiscoveryError('OAuth server returned invalid metadata or token data.', { code: 'AUTH_REQUIRED' });
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(body, { status: response.status, headers });
  };
}

export class StoredOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  readonly clientMetadataUrl?: string;
  private saved: SavedAuth = { version: 1 };
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private readonly nonce = randomBytes(32).toString('base64url');
  saveClientInformation?: (info: OAuthClientInformationMixed) => Promise<void>;

  constructor(readonly config: OAuthConnection, readonly store: AuthStore, readonly env: NodeJS.ProcessEnv,
    private readonly authorize?: (url: URL) => Promise<void>) {
    assertResolvedRegistration(config);
    this.redirectUrl = `http://127.0.0.1:${config.oauth.callbackPort ?? 8678}/callback`;
    this.clientMetadataUrl = config.oauth.clientMetadataUrl;
    this.clientMetadata = {
      client_name: 'Hstack', redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: config.oauth.dcrAuthMethod ?? (config.oauth.clientSecretEnv ? 'client_secret_basic' : 'none'),
      ...(config.oauth.scope ? { scope: config.oauth.scope } : {}),
    };
    if (!config.oauth.clientId) this.saveClientInformation = async (info) => {
      this.assertIssuer(info.issuer);
      this.assertDynamicClient(info);
      this.saved.client = info; await this.store.write(this.saved);
    };
  }

  async load(): Promise<void> {
    // Reused transports must forget removed or invalid credentials. Metadata
    // discovery is also per operation, matching the former one-shot provider.
    this.saved = { version: 1 };
    this.discovery = undefined;
    this.verifier = undefined;
    const value = await this.store.read();
    if (value === undefined) return;
    try {
      const saved = value as SavedAuth;
      if (saved.version !== 1) throw new Error('Version');
      if (saved.client) { OAuthClientInformationSchema.parse(saved.client); this.assertIssuer(saved.client.issuer); this.assertDynamicClient(saved.client); }
      if (saved.tokens) { OAuthTokensSchema.parse(saved.tokens); this.assertIssuer(saved.tokens.issuer); }
      this.saved = saved; // Preserve issuer, registration metadata and vendor fields unchanged.
    } catch { throw new DiscoveryError('Stored OAuth credentials are invalid. Disconnect locally and sign in again.', { code: 'AUTH_REQUIRED' }); }
  }

  /** Memory-only opaque binding. Any external token/client change conservatively
   * retires a stateful MCP session; own refresh is recorded after the locked op. */
  credentialBinding(): string {
    return createHash('sha256').update(JSON.stringify(this.saved)).digest('hex');
  }

  private assertIssuer(issuer: string | undefined) {
    if (!issuer || (this.config.oauth.issuer && new URL(issuer).href !== new URL(this.config.oauth.issuer).href)) {
      throw new DiscoveryError('OAuth issuer changed or is missing. Check the configured service before signing in.', { code: 'AUTH_REQUIRED' });
    }
  }

  private assertDynamicClient(info: OAuthClientInformationMixed) {
    const method=this.config.oauth.dcrAuthMethod;
    if(method && (Reflect.get(info,'token_endpoint_auth_method')!==method || !info.client_secret?.trim())) {
      throw new DiscoveryError('Dynamic registration did not return the explicitly requested authentication method and a client secret. Review vendor registration compatibility before signing in.',{code:'AUTH_REQUIRED'});
    }
  }

  state() { return this.nonce; }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const config = this.config.oauth;
    if (!config.clientId) {
      if(!this.saved.client&&!this.authorize)throw new DiscoveryError(`Sign in first: node --env-file=.env dist/manage.js login ${this.config.id}`,{code:'AUTH_REQUIRED',outcome:'not_sent'});
      return this.saved.client;
    }
    const secret = config.clientSecretEnv ? this.env[config.clientSecretEnv]?.trim() : undefined;
    if (config.clientSecretEnv && !secret) throw new DiscoveryError(`Set ${config.clientSecretEnv} before signing in.`, { code: 'AUTH_REQUIRED' });
    return { client_id: config.clientId, ...(secret ? { client_secret: secret } : {}), issuer: config.issuer };
  }
  tokens() { return this.saved.tokens; }
  async saveTokens(tokens: OAuthTokens) {
    this.assertIssuer(tokens.issuer);
    this.saved.tokens = tokens; await this.store.write(this.saved);
  }
  async redirectToAuthorization(url: URL) {
    if (!this.authorize) throw new DiscoveryError(`Sign in first: node --env-file=.env dist/manage.js login ${this.config.id}`, { code: 'AUTH_REQUIRED' });
    allowedUrl(url, new URL(this.config.url).protocol === 'http:');
    await this.authorize(url);
  }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new DiscoveryError('OAuth sign-in session expired; start login again.', { code: 'AUTH_REQUIRED' });
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.assertIssuer(state.authorizationServerUrl);
    // Keep the configured issuer check in addition to the SDK's issuer validation.
    const metadataIssuer = state.authorizationServerMetadata?.issuer;
    if (!metadataIssuer || new URL(metadataIssuer).href !== new URL(state.authorizationServerUrl).href) {
      throw new DiscoveryError('OAuth discovery returned a mismatched issuer.', { code: 'AUTH_REQUIRED' });
    }
    if (this.config.oauth.clientMetadataUrl && state.authorizationServerMetadata?.client_id_metadata_document_supported !== true) {
      throw new DiscoveryError('The authorization server does not advertise Client ID Metadata Document support. Review the selected service and client setup; no fallback registration was attempted.', { code: 'AUTH_REQUIRED', outcome:'not_sent' });
    }
    const dcrMethod=this.config.oauth.dcrAuthMethod;
    if(dcrMethod && (!state.authorizationServerMetadata?.registration_endpoint
      || !state.authorizationServerMetadata.token_endpoint_auth_methods_supported?.includes(dcrMethod))) {
      throw new DiscoveryError('The authorization server does not advertise dynamic registration with the configured client authentication method. Review vendor metadata before login.',{code:'AUTH_REQUIRED',outcome:'not_sent'});
    }
    this.discovery = state;
  }
  discoveryState() { return this.discovery; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.saved.client;
    if (scope === 'all' || scope === 'tokens') delete this.saved.tokens;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    await this.store.write(this.saved);
  }
}

/** Explicit foreground login only. Never opens a browser during Hermes startup. */
export async function loginOAuth(config: OAuthConnection, env: NodeJS.ProcessEnv,
  showAuthorization: (url: URL) => Promise<void>, signal = AbortSignal.timeout(180_000)): Promise<void> {
  const store = oauthStore(config, env);
  await store.locked(signal, async () => {
    let resolveCode!: (code: { code: string; iss?: string }) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<{ code: string; iss?: string }>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Register rejection handler now; denial can arrive before discovery returns.
    void codePromise.catch(() => {});
    let accepting = false;
    let provider: StoredOAuthProvider;
    const callback = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!accepting || req.method !== 'GET' || url.pathname !== '/callback'
        || req.headers.host !== new URL(provider.redirectUrl).host
        || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== provider.state()) {
        res.writeHead(400).end('Invalid sign-in callback.'); return;
      }
      if (url.searchParams.has('error')) {
        accepting = false;
        rejectCode(new DiscoveryError('Sign-in was denied. Start login again when ready.', { code: 'AUTH_REQUIRED' }));
        res.writeHead(400).end('Sign-in denied.'); return;
      }
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('iss').length > 1) { res.writeHead(400).end('Invalid code or issuer.'); return; }
      accepting = false; resolveCode({ code, ...(url.searchParams.has('iss') ? { iss: url.searchParams.get('iss')! } : {}) });
      res.end('Sign-in response received. Return to your terminal to check completion.');
    });
    callback.requestTimeout = 10_000;
    callback.headersTimeout = 10_000;
    provider = new StoredOAuthProvider(config, store, env, async (url) => {
      accepting = true; await showAuthorization(url);
    });
    try {
      await provider.load();
      await new Promise<void>((resolve, reject) => {
        callback.once('error', reject);
        callback.listen(config.oauth.callbackPort ?? 8678, '127.0.0.1', () => { callback.off('error', reject); resolve(); });
      });
      const fetchFn = oauthFetch(config, signal);
      const result = await auth(provider, { serverUrl: config.url, scope: config.oauth.scope, fetchFn, forceReauthorization: true });
      if (result === 'REDIRECT') {
        const callback = await waitWithSignal(codePromise, signal);
        const exchanged = await auth(provider, { serverUrl: config.url, scope: config.oauth.scope, authorizationCode: callback.code, iss: callback.iss, fetchFn });
        if (exchanged !== 'AUTHORIZED') throw new DiscoveryError('Sign-in did not complete.', { code: 'AUTH_REQUIRED' });
      }
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      if (error instanceof OAuthRateLimitError) throw new DiscoveryError('OAuth server is rate limited; wait for its retry time before signing in again.', error.details);
      if (signal.aborted) throw new DiscoveryError('OAuth sign-in cancelled or timed out.', { code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED' });
      if (error instanceof IssuerMismatchError) throw oauthIssuerFailure(error);
      throw new DiscoveryError('OAuth sign-in failed. Check account eligibility, client registration, callback port and scopes. Raw errors are hidden.', { code: 'AUTH_REQUIRED' });
    } finally {
      callback.closeAllConnections();
      await new Promise<void>((resolve) => callback.close(() => resolve()));
    }
  });
}
