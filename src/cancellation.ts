import { DiscoveryError } from './errors.js';

/** Waiting in a local queue must be cancellable, not just the eventual I/O. */
export function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener('abort', cancelled);
      reject(new DiscoveryError('MCP operation cancelled or its total time budget expired.', {
        code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED',
      }));
    };
    work.then((value) => {
      signal.removeEventListener('abort', cancelled); resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', cancelled); reject(error);
    });
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
  });
}
