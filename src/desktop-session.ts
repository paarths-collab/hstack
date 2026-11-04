import { DiscoveryError } from './errors.js';
import type { FailureDetails } from './errors.js';
import { credentialCodec } from './credential-codec.js';
import { AuthStore } from './auth-store.js';
import { socialProviders, loadProvider } from './providers.js';
import type { LoadedProvider, ProviderDefinition } from './providers.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { compileToolSchema } from './tool-schema.js';

export const validationTools: Readonly<Record<string, string>> = {
  buffer: 'get_account', pallyy: 'get_me', blotato: 'blotato_get_user', ayrshare: 'list_profiles',
};
export function desktopStore(env: NodeJS.ProcessEnv, id: string): AuthStore {
  if (!socialProviders.some(p => p.id === id)) throw new Error('Unsupported provider.');
  return new AuthStore(AuthStore.root(env), { purpose: 'hstack-desktop-credential', provider: id, version: 1 }, credentialCodec(AuthStore.root(env), env));
}
export interface DesktopCredential {
  key: string; revision?: string; validated?: boolean; active?: boolean;
  failure?: FailureDetails; retryAt?: number; checkedAt?: number;
}

export function withDesktopFailure(saved: DesktopCredential, error: DiscoveryError): DesktopCredential {
    const failure: FailureDetails = {code:error.details.code,
      ...(error.details.retryAfterSeconds !== undefined ? {retryAfterSeconds:error.details.retryAfterSeconds}:{}),
      ...(error.details.windowSeconds !== undefined ? {windowSeconds:error.details.windowSeconds}:{}),
      ...(error.details.code==='AUTH_REQUIRED' ? {recovery:'reauthenticate' as const}:{}),
    };
    const seconds = failure.retryAfterSeconds;
    const retryAt = failure.code==='RATE_LIMITED' && seconds !== undefined && seconds > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Date.now()+seconds*1000) : undefined;
    return {...saved,failure,...(retryAt ? {retryAt}:{}),
      ...(failure.code==='AUTH_REQUIRED' ? {active:false,validated:false}:{}),
    };
}

/** Persist only structured, redacted recovery data; never upstream bodies. */
export async function recordDesktopFailure(env: NodeJS.ProcessEnv, id: string, key: string, error: unknown, revision?: string): Promise<void> {
  if (!(error instanceof DiscoveryError)) return;
  const store = desktopStore(env, id);
  await store.locked(AbortSignal.timeout(10_000), async () => {
    const saved = credential(await store.read());
    if (!saved || saved.key !== key || (revision !== undefined && saved.revision !== revision)) return; // A late failure cannot revoke a replacement.
    await store.write(withDesktopFailure(saved, error));
  });
}
async function recordDesktopSuccess(env: NodeJS.ProcessEnv, id: string, key: string, revision?: string): Promise<void> {
  const store = desktopStore(env, id);
  await store.locked(AbortSignal.timeout(10_000), async () => {
    const saved = credential(await store.read());
    // A successful old request cannot reactivate a revoked/replaced key or erase a live cooldown.
    if (!saved?.active || saved.key !== key || saved.revision !== revision || !saved.failure
      || saved.failure.code === 'AUTH_REQUIRED' || (saved.retryAt ?? 0) > Date.now()) return;
    await store.write({...saved, failure: undefined, retryAt: undefined, checkedAt: Date.now()});
  });
}
export function credential(value: unknown): DesktopCredential | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || typeof (value as DesktopCredential).key !== 'string'
    || !(value as DesktopCredential).key.trim()) throw new Error('Invalid saved key.');
  return value as DesktopCredential;
}
/** Discovery is not validation. Execute only one reviewed, schema-valid read. */
export async function validateSocialKey(provider: ProviderDefinition, key: string, loader = loadProvider): Promise<boolean> {
  const name = validationTools[provider.id];
  if (!name) throw new Error('No reviewed account validation tool.');
  const signal = AbortSignal.timeout(30_000);
  const connected = await loader(provider, key, false, signal);
  try {
    const tool = connected.tools.find(t => t.name === name);
    if (!tool || !provider.readTools.has(name)
      || !compileToolSchema(new AjvJsonSchemaValidator(), tool.inputSchema)({}).valid) return false;
    const result = await connected.call(name, {}, signal);
    if (result.isError === true) return false;
    // Buffer's identity contract guards against a nominal success with no account.
    if (provider.id === 'buffer') {
      const values: unknown[] = [result.structuredContent];
      for (const item of result.content) if (item.type === 'text') {
        try { values.push(JSON.parse(item.text)); } catch { /* not account JSON */ }
      }
      return values.some(v => v && typeof v === 'object' && !Array.isArray(v)
        && typeof (v as {id?: unknown}).id === 'string'
        && !!(v as {id: string}).id && Array.isArray((v as {organizations?: unknown}).organizations));
    }
    return result.structuredContent !== undefined || result.content.some(c => c.type === 'text' && c.text.trim().length > 0);
  } finally { await connected.close?.(); }
}

/** Desktop-only runtime: saved, validated, explicitly active credentials only.
 * No environment keys, private connections.json, or write flags are imported.
 */
export class DesktopProviders {
  private closed = false;
  private current: LoadedProvider[] = [];
  private keys = new Map<string, string>();
  private blocked = new Map<string, {key:string; revision?:string; attempts:number; until:number; failure:FailureDetails}>();
  private health = new Map<string, {id:string;state:'unavailable';activeCalls:number;successfulCalls:number;failedCalls:number;lastFailure:FailureDetails}>();
  status() { return [...this.health.values()]; }
  constructor(private env: NodeJS.ProcessEnv, private loader = loadProvider, private now = Date.now) {}
  async refresh(): Promise<LoadedProvider[]> {
    if (this.closed) return [];
    const results = await Promise.all(socialProviders.map(async definition => {
      const store = desktopStore(this.env, definition.id);
      let saved: DesktopCredential | undefined;
      let storageFailed = false;
      try { saved = await store.locked(AbortSignal.timeout(10_000), async () => credential(await store.read())); }
      catch (error) {
        storageFailed = true;
        const failure = error instanceof DiscoveryError ? error.details : {code:'UNAVAILABLE' as const};
        this.health.set(definition.id,{id:definition.id,state:'unavailable',activeCalls:0,successfulCalls:0,failedCalls:0,lastFailure:failure});
      }
      const old = this.current.find(p => p.id === definition.id);
      if (saved?.failure?.code === 'AUTH_REQUIRED') this.health.set(definition.id,{id:definition.id,state:'unavailable',activeCalls:0,successfulCalls:0,failedCalls:0,lastFailure:saved.failure});
      if (saved?.active === true && saved.validated === true && validationTools[definition.id]) {
        const identity = `${saved.revision ?? ''}\0${saved.key}`;
        const cooldown = saved.retryAt && saved.retryAt > this.now() ? saved.retryAt : undefined;
        const blocked = this.blocked.get(definition.id);
        if ((blocked?.key === saved.key && blocked.revision === saved.revision && blocked.until > this.now()) || cooldown) {
          const failure = cooldown ? {code:'RATE_LIMITED' as const,retryAfterSeconds:Math.ceil((cooldown-this.now())/1000)} : blocked!.failure;
          this.health.set(definition.id,{id:definition.id,state:'unavailable',activeCalls:0,successfulCalls:0,failedCalls:0,lastFailure:failure});
          if(old)await old.close?.().catch(()=>{});
          this.keys.delete(definition.id);return;
        }
        if (old && this.keys.get(definition.id) === identity) { return old; }
        if (old) await old.close?.().catch(() => {});
        this.keys.delete(definition.id);
        try {
          const connected = await this.loader(definition, saved.key, false, AbortSignal.timeout(30_000));
          const key = saved.key, revision = saved.revision;
          const original = connected.call;
          connected.call = async (name,args,signal) => {
            try {
              const result = await original(name,args,signal);
              if (result.isError !== true) await recordDesktopSuccess(this.env,definition.id,key,revision).catch(()=>{});
              return result;
            }
            catch (error) {
              if (error instanceof DiscoveryError) {
                const wait = error.details.code==='AUTH_REQUIRED' ? Number.MAX_SAFE_INTEGER : this.now()+Math.max(1000,(error.details.retryAfterSeconds??1)*1000);
                this.blocked.set(definition.id,{key,revision,attempts:1,until:wait,failure:error.details});
                await recordDesktopFailure(this.env,definition.id,key,error,revision).catch(()=>{});
              }
              throw error;
            }
          };
          this.health.delete(definition.id);this.blocked.delete(definition.id);
          this.keys.set(definition.id, identity); return connected;
        } catch (error) {
          const failure = error instanceof DiscoveryError ? error.details : {code:'UNAVAILABLE' as const};
          const attempts = blocked?.key === saved.key && blocked.revision === saved.revision ? blocked.attempts+1 : 1;
          const delay = failure.code==='AUTH_REQUIRED' ? Number.MAX_SAFE_INTEGER : this.now()+Math.max(
            (failure.retryAfterSeconds??0)*1000,Math.min(60_000,1000*2**Math.min(attempts-1,6)));
          this.blocked.set(definition.id,{key:saved.key,revision:saved.revision,attempts,until:delay,failure});
          this.health.set(definition.id,{id:definition.id,state:'unavailable',activeCalls:0,successfulCalls:0,failedCalls:0,lastFailure:failure});
          await recordDesktopFailure(this.env,definition.id,saved.key,error,saved.revision).catch(()=>{});
        }
      } else {
        if (old) await old.close?.().catch(() => {});
        this.keys.delete(definition.id);
        this.blocked.delete(definition.id);
        if (!storageFailed && !saved?.failure) this.health.delete(definition.id);
      }
    }));
    const next = results.filter((p): p is LoadedProvider => p !== undefined);
    if (this.closed) { await Promise.allSettled(next.map(p => p.close?.())); return []; }
    if (next.length !== this.current.length || next.some((p,i) => p !== this.current[i])) this.current = next;
    return this.current;
  }
  async close() { this.closed = true; await Promise.allSettled(this.current.map(p => p.close?.())); this.current = []; this.keys.clear(); }
}
