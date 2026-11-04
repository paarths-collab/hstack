import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHash, createPrivateKey } from 'node:crypto';
import { JWT, UserRefreshClient } from 'google-auth-library';
import { DiscoveryError, retryAfterSeconds } from './errors.js';

const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/bigquery';
const unsafe = () => new DiscoveryError('Google credentials require a private owner-only directory and regular file. Symlinks, hard links and unsupported credential types are refused.', { code: 'AUTH_REQUIRED', outcome: 'not_sent' });
type Credentials = { type: 'authorized_user'; clientId: string; clientSecret: string; refreshToken: string; quota?: string }
  | { type: 'service_account'; email: string; key: string; quota?: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw unsafe();
  return value;
}
function parse(value: unknown): Credentials {
  if (!record(value) || (value.universe_domain !== undefined && value.universe_domain !== 'googleapis.com')
    || (value.token_uri !== undefined && value.token_uri !== tokenEndpoint)) throw unsafe();
  const quota = value.quota_project_id === undefined ? undefined : text(value.quota_project_id, 128);
  if (quota !== undefined && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(quota)) throw unsafe();
  if (value.type === 'authorized_user') {
    const keys = ['type','client_id','client_secret','refresh_token','quota_project_id','universe_domain','account'];
    if (Object.keys(value).some(key => !keys.includes(key))) throw unsafe();
    return { type: value.type, clientId: text(value.client_id, 512), clientSecret: text(value.client_secret),
      refreshToken: text(value.refresh_token), quota };
  }
  if (value.type === 'service_account') {
    const keys = ['type','project_id','private_key_id','private_key','client_email','client_id','auth_uri','token_uri',
      'auth_provider_x509_cert_url','client_x509_cert_url','universe_domain','quota_project_id'];
    if (Object.keys(value).some(key => !keys.includes(key))) throw unsafe();
    const email = text(value.client_email, 512);
    if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(email)
      || typeof value.private_key !== 'string' || value.private_key.length > 16384) throw unsafe();
    const key = createPrivateKey(value.private_key);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw unsafe();
    return { type: value.type, email, key: value.private_key, quota };
  }
  // Never hand arbitrary external-account configs to GoogleAuth/fromJSON:
  // executable, URL, impersonation and metadata-server sources need review.
  throw unsafe();
}

async function readCredentials(path: string | undefined) {
  if (!path?.trim() || !isAbsolute(path) || process.platform === 'win32' || !process.getuid) throw unsafe();
  let handle;
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw unsafe();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o077) !== 0
      || before.size <= 0 || before.size > 65536) throw unsafe();
    // Bound reads even if a concurrently modified file grows after stat().
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw unsafe();
    const credentials = parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    return { credentials, fingerprint: createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') };
  } catch { throw unsafe(); }
  finally { await handle?.close(); }
}

/** Explicit Google credential file, with native SDK signing/refresh and no
 * implicit gcloud/metadata lookup, interactive login or credential persistence.
 * Reads are lazy; public MCP discovery never constructs this credential flow. */
export class GoogleBigQueryCredentials {
  private cached?: { fingerprint: string; client: JWT | UserRefreshClient; quota?: string };
  private tail: Promise<void> = Promise.resolve();
  private activeSignal?: AbortSignal;
  private closed = false;
  constructor(private readonly path: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {}

  private create(credentials: Credentials): JWT | UserRefreshClient {
    const transporterOptions = {
      fetchImplementation: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== tokenEndpoint || init?.method?.toUpperCase() !== 'POST' || !this.activeSignal) throw unsafe();
        this.activeSignal.throwIfAborted();
        const response = await this.fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit',
          signal: init.signal ? AbortSignal.any([init.signal, this.activeSignal]) : this.activeSignal });
        if (!response.ok) {
          const retry = retryAfterSeconds(response.headers.get('Retry-After'));
          await response.body?.cancel();
          throw new DiscoveryError(response.status === 429
            ? 'Google token refresh is rate limited; wait before retrying.'
            : 'Google token refresh failed. Review the credential file and account access.', {
            code: response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UNAVAILABLE' : 'AUTH_REQUIRED',
            ...(response.status === 429 && retry !== undefined ? { retryAfterSeconds: retry } : {}), outcome: 'not_sent',
          });
        }
        return response;
      },
    };
    const client = credentials.type === 'authorized_user'
      ? new UserRefreshClient({ clientId: credentials.clientId, clientSecret: credentials.clientSecret,
        refreshToken: credentials.refreshToken, eagerRefreshThresholdMillis: 60_000, transporterOptions })
      : new JWT({ email: credentials.email, key: credentials.key, scopes: [scope],
        eagerRefreshThresholdMillis: 60_000, transporterOptions });
    // Auth SDK defaults permit retries. Hstack never silently repeats refresh
    // requests; preserve the caller's deadline and surface recovery explicitly.
    client.transporter.interceptors.request.add({ resolved: async options => ({ ...options, retry: false,
      retryConfig: { retry: 0, noResponseRetries: 0, shouldRetry: async () => false }, maxRedirects: 0 }) });
    return client;
  }

  async headers(signal: AbortSignal): Promise<Record<string, string>> {
    // Serialize native client refresh/cache access; each wait retains its own
    // cancellation and must finish before a closed/changed identity is used.
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => gate);
    let acquired = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        else previous.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      });
      acquired = true;
      signal.throwIfAborted();
      if (this.closed) throw new DiscoveryError('Google credential provider is closed.', { code: 'UNAVAILABLE', outcome: 'not_sent' });
      const current = await readCredentials(this.path);
      if (this.cached?.fingerprint !== current.fingerprint) {
        this.cached = { fingerprint: current.fingerprint, client: this.create(current.credentials), quota: current.credentials.quota };
      }
      this.activeSignal = signal;
      const { token } = await this.cached.client.getAccessToken();
      signal.throwIfAborted();
      // Detect rotation/removal/permission changes during refresh before any
      // MCP request is dispatched under the previous identity.
      const latest = await readCredentials(this.path);
      if (latest.fingerprint !== current.fingerprint) {
        this.cached = undefined;
        throw new DiscoveryError('Google credentials changed during refresh. Retry explicitly with the reviewed file.', { code: 'AUTH_REQUIRED', outcome: 'not_sent' });
      }
      if (typeof token !== 'string' || !token.trim() || token.length > 16384 || /[\r\n\0]/.test(token)
        || !Number.isFinite(this.cached.client.credentials.expiry_date)
        || this.cached.client.credentials.expiry_date! <= Date.now()) throw unsafe();
      return { Authorization: `Bearer ${token}`,
        ...(this.cached.quota ? { 'x-goog-user-project': this.cached.quota } : {}) };
    } catch (error) {
      if (signal.aborted) throw new DiscoveryError('Google credential refresh cancelled or timed out.', {
        code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', outcome: 'not_sent',
      });
      // Gaxios wraps fetch failures. Only our typed safe error may escape;
      // never copy its config, response body, raw message or credentials.
      const seen = new Set<unknown>(); let cause = error;
      for (let depth = 0; depth < 8 && cause instanceof Error && !seen.has(cause); depth++) {
        if (cause instanceof DiscoveryError) throw cause;
        seen.add(cause); cause = cause.cause;
      }
      throw new DiscoveryError('Google credential refresh failed. Review connectivity and compatibility; raw errors are hidden.', { code: 'UNAVAILABLE', outcome: 'not_sent' });
    } finally { if (acquired) this.activeSignal = undefined; release(); }
  }

  /** Forget a rejected access token for the next explicit operation. Never
   * refresh here or replay the failed account request. Serialize with readers. */
  async invalidateAccessToken(): Promise<void> {
    const work = this.tail.then(() => { this.cached = undefined; });
    this.tail = work;
    await work;
  }

  async close(): Promise<void> { this.closed = true; await this.tail; this.cached = undefined; }
}
