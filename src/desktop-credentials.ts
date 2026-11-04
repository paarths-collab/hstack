import { randomUUID } from 'node:crypto';
import { AuthStore } from './auth-store.js';
import { desktopStore, credential, withDesktopFailure, validateSocialKey, validationTools } from './desktop-session.js';
import { socialProviders } from './providers.js';
import type { ProviderDefinition } from './providers.js';
import { DiscoveryError } from './errors.js';

function definitionFor(id: unknown): ProviderDefinition {
  const definition = typeof id === 'string' ? socialProviders.find(item => item.id === id) : undefined;
  if (!definition) throw new Error('Unsupported provider.');
  return definition;
}
function storeFor(env: NodeJS.ProcessEnv, provider: ProviderDefinition): AuthStore {
  return desktopStore(env, provider.id);
}
export async function savedSocialKey(id: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const store = storeFor(env, definitionFor(id));
  return store.locked(AbortSignal.timeout(10_000), async () => {
    const value = await store.read();
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || typeof (value as { key?: unknown }).key !== 'string'
      || !(value as { key: string }).key.trim()) throw new Error('Saved credential is invalid.');
    return (value as { key: string }).key;
  });
}
export const savedBufferKey = (env: NodeJS.ProcessEnv) => savedSocialKey('buffer', env);

/** Environment credentials win. Corrupt stores cannot disable unrelated providers. */
export async function resolveSocialEnvironment(env: NodeJS.ProcessEnv): Promise<{ env: NodeJS.ProcessEnv; failed: string[] }> {
  if (process.platform === 'win32') return { env, failed: [] };
  const candidates = socialProviders.filter(item => !env[item.credentialEnv]?.trim());
  const results = await Promise.allSettled(candidates.map(item => savedSocialKey(item.id, env)));
  const resolved = { ...env }, failed: string[] = [];
  results.forEach((result, index) => {
    const item = candidates[index]!;
    if (result.status === 'rejected') failed.push(item.id);
    else if (result.value) resolved[item.credentialEnv] = result.value;
  });
  return { env: resolved, failed };
}
export async function resolveBufferEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.BUFFER_API_KEY?.trim() || process.platform === 'win32') return env;
  const key = await savedBufferKey(env);
  return key ? { ...env, BUFFER_API_KEY: key } : env;
}

export async function desktopSocialAction(
  request: unknown, env: NodeJS.ProcessEnv,
  verify: (provider: ProviderDefinition, key: string) => Promise<boolean> = validateSocialKey,
): Promise<{ state: string; message: string }> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request.');
  const { action, key, provider: id = 'buffer' } = request as Record<string, unknown>;
  const provider = definitionFor(id);
  if (typeof action !== 'string' || !['status', 'save', 'test', 'disconnect', 'activate', 'deactivate', 'migrate'].includes(action)) throw new Error('Invalid action.');
  const store = storeFor(env, provider);
  if (action === 'migrate') {
    const migrated = await store.locked(AbortSignal.timeout(30_000), () => store.migrate());
    return {state: 'saved', message: migrated ? 'Legacy credentials encrypted. Existing activation was preserved; refresh status.' : 'No plaintext credentials needed migration.'};
  }
  if (action === 'save') {
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Enter a valid API key.');
    await store.locked(AbortSignal.timeout(10_000), () => store.replace({ key: key.trim(), revision: randomUUID() }));
    return { state: 'saved', message: 'Key saved and Desktop activation cleared. Validate it, then activate in Hermes.' };
  }
  if (action === 'disconnect') {
    await store.locked(AbortSignal.timeout(10_000), () => store.remove());
    return { state: 'not_saved', message: `Saved key removed; new Desktop MCP calls are disabled. Legacy Hstack connections require a restart. An existing ${provider.credentialEnv} environment variable still takes priority.` };
  }
  const record = await store.locked(AbortSignal.timeout(10_000), async () => credential(await store.read()));
  const saved = record?.key;
  if (!saved) return { state: 'not_saved', message: 'No Desktop key saved. A key configured separately in the environment may still be in use.' };
  if (action === 'status' && record?.failure?.code === 'AUTH_REQUIRED') return {state:'reauth_required',message:'The service rejected this key. Replace it, validate the replacement and activate again.'};
  if ((action === 'status' || action === 'test' || action === 'activate') && record?.retryAt && record.retryAt > Date.now()) return {state:'rate_limited',message:`Rate limited. Retry after ${Math.ceil((record.retryAt-Date.now())/1000)} seconds. The saved key was preserved.`};
  if (action === 'status' && record?.active && record.failure) return {state:'degraded',message: record.failure.code === 'FORBIDDEN' ? 'A service operation was denied. Check its permissions or plan; the saved key was preserved.' : 'The last operation failed. The key was preserved; retry a read when the service recovers.'};
  if (action === 'status') return { state: record?.active ? 'active' : record?.validated ? 'verified' : 'saved', message: record?.active ? 'Activated key saved. Use a tool through Hermes to check the running connection.' : record?.validated ? 'Saved key passed a read check. Activate to make its tools available.' : 'Key saved locally; connection has not been checked.' };
  if (action === 'activate' || action === 'deactivate') {
    return store.locked(AbortSignal.timeout(10_000), async () => {
      const current = credential(await store.read());
      if (!current || (action === 'activate' && (!current.validated || !validationTools[provider.id])))
        return { state: 'error', message: 'Validate this saved key before activation. A reviewed account read is required.' };
      await store.write({ ...current, active: action === 'activate' });
      return { state: action === 'activate' ? 'active' : current.validated === true ? 'verified' : 'saved', message: action === 'activate' ? 'Activated. The Desktop MCP connection loads it on its next call.' : 'Deactivated. New Desktop MCP calls cannot use this key.' };
    });
  }
  if (!validationTools[provider.id]) return { state: 'error', message: 'No reviewed account-validation read is available for this service. Activation remains blocked.' };
  try {
    const valid = await store.locked(AbortSignal.timeout(35_000), async () => {
      const current = credential(await store.read());
      if (!current || current.key !== saved || current.revision !== record?.revision) return false;
      let valid = false;
      try { valid = await verify(provider, saved); }
      catch (error) {
        if(error instanceof DiscoveryError)await store.write(withDesktopFailure(current,error));
        throw error;
      }
      await store.write({ ...current, validated: valid, active: valid && current.active === true, failure: undefined, retryAt: undefined, checkedAt: Date.now() });
      return valid;
    });
    if (!valid) return { state: 'error', message: `${provider.label} could not confirm this key. Check access and try again.` };
  } catch (error) {
    if (error instanceof DiscoveryError) {
      const d = error.details;
      if (d.code === 'RATE_LIMITED') return { state: 'error', message: `Rate limit reached. ${d.retryAfterSeconds === undefined ? 'Retry time was not supplied.' : `Try again after ${d.retryAfterSeconds} seconds.`}${d.windowSeconds === undefined ? ' The exhausted window is unknown.' : ` The reported window is ${d.windowSeconds} seconds.`}` };
      if (d.code === 'AUTH_REQUIRED') return { state: 'error', message: `${provider.label} rejected the credential. Check or replace the key.` };
      if (d.code === 'FORBIDDEN') return { state: 'error', message: `${provider.label} denied access. Check the account plan and permissions.` };
      if (d.code === 'TIMEOUT') return { state: 'error', message: `${provider.label} did not respond in time. Check your network and retry.` };
    }
    return { state: 'error', message: `${provider.label} could not be reached. Check your network and connection settings.` };
  }
  return { state: 'verified', message: `${provider.label} read succeeded with the saved key. Activate to use its tools in Hermes.` };
}
export const desktopBufferAction = (request: unknown, env: NodeJS.ProcessEnv, verify?: (key: string) => Promise<boolean>) =>
  desktopSocialAction(request, env, verify ? (_provider, key) => verify(key) : undefined);
