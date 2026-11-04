import { DiscoveryError } from './errors.js';
import type { FailureDetails } from './errors.js';
import type { LoadedProvider } from './providers.js';
import type { ConnectionLifecycle } from './local-connection.js';

export interface ConnectionStatus {
  id: string;
  state: 'ready' | 'degraded' | 'rate_limited' | 'unavailable';
  activeCalls: number;
  successfulCalls: number;
  failedCalls: number;
  lastSuccessAt?: string;
  lastFailure?: FailureDetails;
  lifecycle?: ConnectionLifecycle;
}

/** Process-local health and cooldowns; no account payloads or credentials stored. */
export class GatewayRuntime {
  private statuses = new Map<string, ConnectionStatus>();
  private cooldowns = new Map<string, number>();
  private providers = new Map<string, LoadedProvider>();
  constructor(providers: LoadedProvider[], failed: string[] = [], private now = Date.now) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
      this.statuses.set(provider.id, { id: provider.id, state: 'ready', activeCalls: 0, successfulCalls: 0, failedCalls: 0 });
    }
    for (const id of failed) if (!this.statuses.has(id)) this.statuses.set(id, {
      id, state: 'unavailable', activeCalls: 0, successfulCalls: 0, failedCalls: 0,
      lastFailure: { code: 'UNAVAILABLE' },
    });
  }

  /** Retain cooldowns/counters for unchanged Desktop connections. */
  replaceProviders(providers: LoadedProvider[]): void {
    const next = new Map(providers.map(provider => [provider.id, provider]));
    for (const [id, provider] of this.providers) if (next.get(id) !== provider) {
      this.providers.delete(id); this.statuses.delete(id); this.cooldowns.delete(id);
    }
    for (const provider of providers) if (!this.providers.has(provider.id)) {
      this.providers.set(provider.id, provider);
      this.statuses.set(provider.id, { id: provider.id, state: 'ready', activeCalls: 0, successfulCalls: 0, failedCalls: 0 });
    }
  }

  snapshot(): ConnectionStatus[] {
    return [...this.statuses.values()].map((status) => {
      const remaining = this.remaining(status.id);
      const lifecycle = this.providers.get(status.id)?.lifecycle?.();
      const state = lifecycle && ['backoff', 'catalogue_changed', 'closed'].includes(lifecycle.state) ? 'unavailable' as const : status.state;
      return { ...status, state, ...(lifecycle ? { lifecycle } : {}), lastFailure: status.lastFailure ? {
        ...status.lastFailure,
        ...(remaining !== undefined ? { retryAfterSeconds: remaining } : {}),
      } : undefined };
    });
  }

  private remaining(id: string): number | undefined {
    const until = this.cooldowns.get(id);
    if (until === undefined) return undefined;
    const left = Math.ceil((until - this.now()) / 1000);
    if (left > 0) return left;
    this.cooldowns.delete(id);
    const status = this.statuses.get(id)!;
    if (status.state === 'rate_limited') status.state = 'degraded';
    return undefined;
  }

  async call(provider: LoadedProvider, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const status = this.statuses.get(provider.id)!;
    if (signal.aborted) throw new DiscoveryError('MCP operation cancelled.', { code: 'CANCELLED' });
    const left = this.remaining(provider.id);
    if (left !== undefined) throw new DiscoveryError(
      `${provider.label} is cooling down after a rate limit. Retry after ${left} seconds. No new upstream request was sent.`,
      { code: 'RATE_LIMITED', retryAfterSeconds: left, windowSeconds: status.lastFailure?.windowSeconds },
    );
    status.activeCalls++;
    try {
      const result = await provider.call(name, args, signal);
      if (result.isError) {
        status.failedCalls++;
        status.state = 'degraded';
        status.lastFailure = { code: 'UPSTREAM_ERROR' };
      } else {
        status.successfulCalls++;
        status.lastSuccessAt = new Date(this.now()).toISOString();
        // An earlier in-flight call may have just established a cooldown.
        status.state = this.remaining(provider.id) !== undefined ? 'rate_limited' : 'ready';
        if (status.state === 'ready') status.lastFailure = undefined;
      }
      return result;
    } catch (error) {
      status.failedCalls++;
      const details = error instanceof DiscoveryError ? error.details : { code: 'UPSTREAM_ERROR' as const };
      status.lastFailure = details;
      status.state = details.code === 'RATE_LIMITED' ? 'rate_limited' : details.code === 'UNAVAILABLE' ? 'unavailable' : 'degraded';
      if (details.code === 'RATE_LIMITED' && details.retryAfterSeconds !== undefined && details.retryAfterSeconds > 0) {
        const until = this.now() + details.retryAfterSeconds * 1000;
        this.cooldowns.set(provider.id, Math.max(until, this.cooldowns.get(provider.id) ?? 0));
      }
      throw error;
    } finally { status.activeCalls--; }
  }
}
