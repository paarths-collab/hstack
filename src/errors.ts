export type FailureCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'TIMEOUT'
  | 'CANCELLED' | 'UPSTREAM_ERROR' | 'UNAVAILABLE';

export interface FailureDetails {
  code: FailureCode;
  retryAfterSeconds?: number;
  windowSeconds?: number;
  outcome?: 'not_sent' | 'unknown';
  recovery?: 'retry_later' | 'restart_hstack' | 'reauthenticate' | 'unlock_credentials' | 'migrate_credentials';
}

export class DiscoveryError extends Error {
  constructor(message: string, readonly details: FailureDetails = { code: 'UPSTREAM_ERROR' }) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** HTTP Retry-After can be either delta-seconds or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  // Date.parse accepts strings that aren't HTTP dates (e.g. "1.5").
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/i.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

/** Only identify an exhausted window when response headers identify it. */
export function exhaustedWindow(headers: Headers): number | undefined {
  const limits = headers.get('ratelimit') ?? '';
  const policies = headers.get('ratelimit-policy') ?? '';
  const exhausted: string[] = [];
  for (const match of limits.matchAll(/"([^"]+)"\s*;([^,]*)/g)) {
    if (/(?:^|;)\s*r\s*=\s*0(?:\s*;|\s*$)/.test(match[2]!)) exhausted.push(match[1]!);
  }
  const windows = new Set<number>();
  for (const match of policies.matchAll(/"([^"]+)"\s*;([^,]*)/g)) {
    if (!exhausted.includes(match[1]!)) continue;
    const window = /(?:^|;)\s*w\s*=\s*(\d+)/.exec(match[2]!);
    if (window && Number(window[1]) > 0 && Number.isSafeInteger(Number(window[1]))) windows.add(Number(window[1]));
  }
  // Don't turn multiple exhausted policies into a misleading single window.
  return windows.size === 1 ? [...windows][0] : undefined;
}
